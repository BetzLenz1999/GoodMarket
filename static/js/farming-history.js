/* GoodMarket Chicken Farm — transaction history store.
 *
 * Farm actions (start farm / sell eggs / close farm) are signed by the user's
 * own wallet, so the G$ moves on-chain and the backend never sees a record.
 * The only proof that "my G$ actually arrived" is the transaction hash — and
 * the old page showed it nowhere, so a successful sell and a silently dropped
 * one looked identical ("hindi nila alam kung dumating ba ang G$").
 *
 * Two properties matter and are enforced here:
 *
 *   1. PER-WALLET. The store is keyed per wallet address, so two accounts on
 *      one browser never share or clobber each other's rows. setWallet() must
 *      be called before use; a legacy global key is migrated on first contact.
 *
 *   2. DURABLE. The farm CONTRACT is the permanent record — clearing browser
 *      storage cannot erase a farm event. mergeOnchain() folds the wallet's
 *      on-chain events (fetched by the page from /farming/api/history) into the
 *      local list, so old transactions are restored on a new device too.
 *
 * The module is DOM-free and dependency-free so it can be unit-tested in node.
 */
(function (global) {
    "use strict";

    var KEY = "gm_farming_tx_history_v1";
    // Older entries are only pruned once a wallet exceeds this many rows — the
    // previous cap of 60 silently discarded old confirmed transactions, which
    // is exactly the "old transaction disappeared" complaint. Retention keeps
    // every pending/failed row and drops the OLDEST confirmed ones first.
    var MAX_ITEMS = 200;

    // Active wallet. Empty means "unknown" — then the store behaves exactly
    // like the legacy single-key store (no namespacing, no filtering).
    var _wallet = "";

    // The in-memory mirror is the source of truth for the session. It also
    // keeps the page usable in hardened private mode where localStorage
    // throws on every access — history then simply does not survive reload,
    // which is strictly better than a broken page.
    var _cache = null;

    function _norm(wallet) {
        return String(wallet == null ? "" : wallet).trim().toLowerCase();
    }

    function _storageKey(wallet) {
        var w = _norm(wallet === undefined ? _wallet : wallet);
        return w ? KEY + "::" + w : KEY;
    }

    function currentWallet() {
        return _wallet;
    }

    // Point the store at a wallet. Any rows parked under the legacy global key
    // that belong to this wallet (or have no owner recorded) are adopted so
    // existing users do not lose their history on the upgrade.
    function setWallet(wallet) {
        var next = _norm(wallet);
        if (next === _wallet && _cache !== null) return;
        _wallet = next;
        _cache = null;
        if (next) _migrateLegacy(next);
    }

    function _migrateLegacy(wallet) {
        try {
            if (!global.localStorage) return;
            var raw = global.localStorage.getItem(KEY);
            if (!raw) return;
            var legacy = JSON.parse(raw);
            if (!Array.isArray(legacy) || !legacy.length) return;
            var own = legacy.filter(function (e) {
                var w = _norm(e && e.wallet);
                return !w || w === wallet;
            });
            var foreign = legacy.length - own.length;
            var migrated = _readStorage(wallet);
            var seen = {};
            migrated.forEach(function (e) { if (e && e.id) seen[e.id] = true; });
            own.forEach(function (e) { if (e && e.id && !seen[e.id]) { migrated.push(e); seen[e.id] = true; } });
            _writeStorage(wallet, migrated);
            // Drop the adopted rows from the global key, keeping anything that
            // belongs to a different wallet so its owner can migrate too.
            if (foreign > 0) {
                global.localStorage.setItem(KEY, JSON.stringify(legacy.filter(function (e) {
                    var w = _norm(e && e.wallet);
                    return w && w !== wallet;
                })));
            } else {
                global.localStorage.removeItem(KEY);
            }
        } catch (_) {}
    }

    function _readStorage(wallet) {
        try {
            var raw = global.localStorage && global.localStorage.getItem(_storageKey(wallet));
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }

    function _writeStorage(wallet, list) {
        try {
            if (global.localStorage) {
                global.localStorage.setItem(_storageKey(wallet), JSON.stringify(list));
            }
        } catch (_) {}
    }

    function all() {
        if (_cache === null) _cache = _readStorage(_wallet);
        // When a wallet is active, never surface a row that belongs to another
        // one — a shared browser must not leak between accounts.
        if (!_wallet) return _cache.slice();
        return _cache.filter(function (e) {
            var w = _norm(e && e.wallet);
            return !w || w === _wallet;
        });
    }

    // Retention that never drops a row the user may still care about: pending
    // and failed entries are always kept; only the oldest confirmed rows are
    // pruned once the list grows past MAX_ITEMS.
    function _prune(list) {
        if (list.length <= MAX_ITEMS) return list;
        var overflow = list.length - MAX_ITEMS;
        var keep = [];
        for (var i = list.length - 1; i >= 0; i--) {
            var e = list[i];
            var terminal = e && (e.status === "pending" || e.status === "failed");
            if (!terminal && overflow > 0) {
                overflow--;   // list is newest-first, so this drops the oldest confirmed
                continue;
            }
            keep.push(e);
        }
        return keep.reverse();
    }

    function _persist() {
        _cache = _prune(_cache || []);
        _writeStorage(_wallet, _cache || []);
    }

    // Real Celo transaction hashes only — lazily-created entries (a broadcast
    // that has not returned a hash yet) must not render a bogus explorer link.
    function isOnchainHash(value) {
        return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim());
    }

    function celoscanUrl(hash) {
        return isOnchainHash(hash) ? "https://celoscan.io/tx/" + hash.trim() : "";
    }

    function shortHash(hash, size) {
        if (!isOnchainHash(hash)) return "";
        var n = typeof size === "number" ? size : 10;
        return hash.slice(0, n) + "…" + hash.slice(-6);
    }

    // human G$ from a display value (number | numeric string). Never assume
    // wei here — callers pass wei through formatWei first. Commas are stripped
    // so this is idempotent: formatGd(formatWei(x)) must not collapse to 0.
    function formatGd(value) {
        var n = Number(String(value == null ? "" : value).replace(/,/g, ""));
        if (!isFinite(n)) return "0";
        return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    }

    // wei (decimal string | BigInt) -> display G$ string. Kept here so every
    // surface formats amounts identically.
    function formatWei(wei) {
        try {
            var v = typeof wei === "bigint" ? wei : BigInt(String(wei || "0"));
            var neg = v < 0n;
            if (neg) v = -v;
            var whole = v / 1000000000000000000n;
            var frac = v % 1000000000000000000n;
            var fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
            var out = whole.toString();
            if (fracStr) out += "." + fracStr.slice(0, 4);
            return (neg ? "-" : "") + formatGd(out);
        } catch (_) {
            return "0";
        }
    }

    function formatTime(ts) {
        var d = new Date(Number(ts) || Date.now());
        if (isNaN(d.getTime())) return "";
        return d.toLocaleString();
    }

    var ACTION_LABELS = {
        startFarm: "Start farm",
        approve: "Approve G$",
        sellEggs: "Sell eggs",
        closeFarm: "Close farm",
    };

    function _newId() {
        return "farm-" + Date.now().toString(36) + "-" +
            Math.random().toString(36).slice(2, 8);
    }

    // Append a freshly-broadcast (or about-to-be-broadcast) action.
    function add(entry) {
        var e = Object.assign({}, entry || {});
        var item = {
            id: e.id || _newId(),
            hash: isOnchainHash(e.hash) ? e.hash.trim() : (e.hash || ""),
            action: e.action || "unknown",
            actionLabel: e.actionLabel || ACTION_LABELS[e.action] || "Farm action",
            amountGd: e.amountGd != null ? String(e.amountGd) : "",
            amountLabel: e.amountLabel || "",
            wallet: e.wallet || _wallet || "",
            status: e.status || "pending",
            note: e.note || "",
            createdAt: Number(e.createdAt) || Date.now(),
            confirmedAt: e.confirmedAt || null,
            blockNumber: e.blockNumber != null ? e.blockNumber : null,
            error: "",
        };
        all();
        _cache.unshift(item);
        _persist();
        return item;
    }

    function get(id) {
        return all().find(function (e) { return e.id === id; }) || null;
    }

    function update(id, patch) {
        all();
        var idx = _cache.findIndex(function (e) { return e.id === id; });
        if (idx === -1) return null;
        Object.assign(_cache[idx], patch || {});
        _persist();
        return _cache[idx];
    }

    // Receipt polling knows the hash, not the local id — update by hash so a
    // reconciliation pass on a fresh page load can settle old entries.
    function updateByHash(hash, patch) {
        if (!isOnchainHash(hash)) return null;
        var wanted = hash.toLowerCase();
        all();
        var idx = _cache.findIndex(function (e) {
            return typeof e.hash === "string" && e.hash.toLowerCase() === wanted;
        });
        if (idx === -1) return null;
        Object.assign(_cache[idx], patch || {});
        _persist();
        return _cache[idx];
    }

    function markConfirmed(id, extra) {
        return update(id, Object.assign({
            status: "confirmed",
            confirmedAt: Date.now(),
            error: "",
        }, extra || {}));
    }

    function markFailed(id, error) {
        return update(id, {
            status: "failed",
            error: String(error || "Transaction failed"),
        });
    }

    // Entries that still need a receipt check: broadcast but never settled.
    // A failed entry with a hash is excluded — it is already terminal.
    function pending() {
        return all().filter(function (e) {
            return e.status === "pending" && isOnchainHash(e.hash);
        });
    }

    // Fold the wallet's on-chain farm events (from /farming/api/history) into
    // the local list. A farm event only exists for a transaction that MINED
    // SUCCESSFULLY, so these rows are authoritative: they are matched by hash
    // and marked confirmed, or inserted when the local copy is gone (cleared
    // storage / another device) — which is what restores old transactions.
    // Returns {added, updated}.
    function mergeOnchain(rows) {
        all();
        var added = 0, updated = 0;
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
            if (!row || !isOnchainHash(row.hash)) return;
            var hash = row.hash.trim();
            var wanted = hash.toLowerCase();
            var idx = _cache.findIndex(function (e) {
                return typeof e.hash === "string" && e.hash.toLowerCase() === wanted;
            });
            var patch = {
                hash: hash,
                action: row.action || "unknown",
                actionLabel: row.actionLabel || ACTION_LABELS[row.action] || "Farm action",
                amountLabel: row.amountLabel || "",
                note: row.note || "",
                status: "confirmed",
                error: "",
                source: "onchain",
                blockNumber: row.blockNumber != null ? row.blockNumber : null,
                wallet: row.wallet || _wallet || "",
            };
            // The backend batches real block timestamps; keep them so an old
            // transaction shows when it actually happened, not when it was
            // re-merged from the chain.
            if (row.timeLabel) patch.timeLabel = row.timeLabel;
            // These events carry no "received" G$ figure for the wallet (the
            // approve/start legs pay IN), so only fill it for actions that
            // actually pay the user — otherwise a start-farm row would read as
            // "G$ received" when nothing was received.
            var paysUser = row.action === "sellEggs" || row.action === "closeFarm";
            if (paysUser && row.amountGdWei != null && row.amountGdWei !== "") {
                patch.receivedWei = String(row.amountGdWei);
            }
            if (idx === -1) {
                _cache.unshift(Object.assign({
                    id: row.id || _newId(),
                    createdAt: Number(row.createdAt) || Date.now(),
                    confirmedAt: row.confirmedAt || Date.now(),
                    receivedWei: null,
                    amountGd: "",
                }, patch));
                added += 1;
            } else {
                if (!_cache[idx].confirmedAt) patch.confirmedAt = Date.now();
                Object.assign(_cache[idx], patch);
                updated += 1;
            }
        });
        if (added || updated) _persist();
        return { added: added, updated: updated };
    }

    function clear() {
        _cache = [];
        _persist();
    }

    // Test seams: reset the in-memory mirror so a harness can re-read storage.
    function _resetCache() {
        _cache = null;
    }

    global.GMFarmHistory = {
        KEY: KEY,
        MAX_ITEMS: MAX_ITEMS,
        ACTION_LABELS: ACTION_LABELS,
        setWallet: setWallet,
        currentWallet: currentWallet,
        storageKey: _storageKey,
        all: all,
        add: add,
        get: get,
        update: update,
        updateByHash: updateByHash,
        markConfirmed: markConfirmed,
        markFailed: markFailed,
        pending: pending,
        mergeOnchain: mergeOnchain,
        clear: clear,
        isOnchainHash: isOnchainHash,
        celoscanUrl: celoscanUrl,
        shortHash: shortHash,
        formatGd: formatGd,
        formatWei: formatWei,
        formatTime: formatTime,
        _resetCache: _resetCache,
    };
})(typeof window !== "undefined" ? window : globalThis);
