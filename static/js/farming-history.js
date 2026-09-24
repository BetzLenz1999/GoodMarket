/* GoodMarket Chicken Farm — transaction history store.
 *
 * Farm actions (start farm / sell eggs / close farm) are signed by the user's
 * own wallet, so the G$ moves on-chain and the backend never sees a record.
 * The only proof that "my G$ actually arrived" is the transaction hash — and
 * the old page showed it nowhere, so a successful sell and a silently dropped
 * one looked identical ("hindi nila alam kung dumating ba ang G$").
 *
 * This module is that durable record: every broadcast transaction is written
 * to localStorage the instant a hash exists, then updated in place when the
 * receipt lands (status + block + confirmed-at). It is deliberately DOM-free
 * and dependency-free so the store can be unit-tested in node and reused by
 * any page that needs the same "on-chain status" view.
 */
(function (global) {
    "use strict";

    var KEY = "gm_farming_tx_history_v1";
    var MAX_ITEMS = 60;

    // The in-memory mirror is the source of truth for the session. It also
    // keeps the page usable in hardened private mode where localStorage
    // throws on every access — history then simply does not survive reload,
    // which is strictly better than a broken page.
    var _cache = null;

    function _readStorage() {
        try {
            var raw = global.localStorage && global.localStorage.getItem(KEY);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }

    function _writeStorage(list) {
        try {
            if (global.localStorage) {
                global.localStorage.setItem(KEY, JSON.stringify(list));
            }
        } catch (_) {}
    }

    function all() {
        if (_cache === null) _cache = _readStorage();
        return _cache.slice();
    }

    function _persist() {
        if (_cache && _cache.length > MAX_ITEMS) {
            _cache = _cache.slice(0, MAX_ITEMS);
        }
        _writeStorage(_cache || []);
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
            wallet: e.wallet || "",
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
        all: all,
        add: add,
        get: get,
        update: update,
        updateByHash: updateByHash,
        markConfirmed: markConfirmed,
        markFailed: markFailed,
        pending: pending,
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
