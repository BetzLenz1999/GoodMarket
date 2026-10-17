/* GoodMarket Community Rotating Savings (Paluwagan) — page logic.
 *
 * Fully on-chain: the contract is the authoritative record. This bundle only
 * READS contract state / events through a public Celo RPC and asks the user's
 * own wallet to SIGN the state-changing calls. It never signs on the server and
 * never moves funds on its own.
 *
 * Signing rules follow the rest of the app:
 *   - local logins sign with the PIN-decrypted in-app wallet (GMLocalWallet);
 *     an injected MetaMask is a DIFFERENT account and must never be used.
 *   - WalletConnect logins sign through the WC bridge.
 *   - everyone else uses the injected provider, bound to the account that
 *     matches the session wallet.
 * Reads go through a public RPC so they never pop a wallet prompt.
 *
 * This feature is deliberately separate from G$ Savings: different contract,
 * different token custody, different accounting. Nothing here touches savings.
 */
(function () {
    "use strict";

    // GM_PALUWAGAN_BOOT is emitted as an INLINE object in the page body. Read
    // it through _syncBoot() rather than snapshotting it here: if the boot
    // script is ever placed AFTER this bundle (it was — the create-group flow
    // failed with "Please log in to sign this transaction." because WALLET and
    // LOGIN_METHOD were captured as ""), every signing path would resolve the
    // wrong signer forever. Same landmine that bit dapp-connect.js.
    var boot = window.GM_PALUWAGAN_BOOT || {};
    var WALLET = String(boot.wallet || "");
    var LOGIN_METHOD = String(boot.loginMethod || "").toLowerCase();
    var CONTRACT = String(boot.contract || "");
    var DEPLOYMENT_BLOCK = Number(boot.deploymentBlock || 0);
    var CONFIGURED = boot.configured !== false && !!CONTRACT;
    var GD_CONTRACT = String(boot.gdContract || "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A");
    var CHAIN_ID = Number(boot.chainId || 42220);
    var CHAIN_HEX = "0x" + CHAIN_ID.toString(16);
    var MEMBERS = Number(boot.members || 5);
    var ALLOWED_WEEKS = Array.isArray(boot.allowedWeeks) && boot.allowedWeeks.length ? boot.allowedWeeks : [50, 100];
    var GRACE_PERIOD = Number(boot.gracePeriod || 2 * 24 * 3600);
    var ROUND_DURATION = Number(boot.roundDuration || 7 * 24 * 3600);
    var CELO_RPC_FALLBACKS = ["https://forno.celo.org", "https://1rpc.io/celo", "https://celo.publicnode.com"];

    // Re-read the live boot object. Safe to call repeatedly; only overwrites a
    // value when the boot config actually carries one.
    function _syncBoot() {
        var b = window.GM_PALUWAGAN_BOOT;
        if (!b) return;
        boot = b;
        if (b.wallet != null) WALLET = String(b.wallet || "");
        if (b.loginMethod != null) LOGIN_METHOD = String(b.loginMethod || "").toLowerCase();
        if (b.contract != null) CONTRACT = String(b.contract || "");
        if (b.deploymentBlock != null) DEPLOYMENT_BLOCK = Number(b.deploymentBlock || 0);
        if (b.configured != null) CONFIGURED = b.configured !== false && !!CONTRACT;
        if (b.gdContract != null) GD_CONTRACT = String(b.gdContract || GD_CONTRACT);
        if (b.chainId != null) {
            CHAIN_ID = Number(b.chainId || 42220);
            CHAIN_HEX = "0x" + CHAIN_ID.toString(16);
        }
        if (b.members != null) MEMBERS = Number(b.members || 5);
        if (Array.isArray(b.allowedWeeks) && b.allowedWeeks.length) ALLOWED_WEEKS = b.allowedWeeks;
        if (b.gracePeriod != null) GRACE_PERIOD = Number(b.gracePeriod || GRACE_PERIOD);
        if (b.roundDuration != null) ROUND_DURATION = Number(b.roundDuration || ROUND_DURATION);
    }

    var DECIMALS = 18;
    var EXPLORER = "https://celoscan.io";

    var readProvider = null;
    var currentGroupId = null;
    var currentGroup = null;
    var busy = false;

    // ── ABIs (human-readable, mirrors paluwagan/blockchain.py) ──────────────
    var PALUWAGAN_ABI = [
        "function createGroup(string name, address token, uint256 contributionAmount, uint256 weeks, uint8[5] payoutOrder) returns (uint256)",
        "function joinGroup(uint256 groupId)",
        "function activateGroup(uint256 groupId)",
        "function contribute(uint256 groupId)",
        "function coverFor(uint256 groupId, uint256 round, address member)",
        "function markMissed(uint256 groupId, address member)",
        "function advanceRound(uint256 groupId)",
        "function claimPayout(uint256 groupId, uint256 round) returns (bool)",
        "function proposeEarlySettle(uint256 groupId)",
        "function approveEarlySettle(uint256 groupId)",
        "function getGroup(uint256 groupId) view returns (string name, address token, uint256 contributionAmount, uint256 weeks, uint8 status, uint256 currentRound, uint256 roundStartAt, uint256 memberCount, uint256 roundDeadline, uint256 graceDeadline)",
        "function getGroupName(uint256 groupId) view returns (string)",
        "function getGroupIdByName(string name) view returns (uint256)",
        "function getMembers(uint256 groupId) view returns (address[5])",
        "function getPayoutOrder(uint256 groupId) view returns (uint8[5])",
        "function recipientOf(uint256 groupId, uint256 round) view returns (address)",
        "function isPoolComplete(uint256 groupId, uint256 round) view returns (bool)",
        "function isMemberOf(uint256 groupId, address account) view returns (bool)",
        "function paid(uint256 groupId, uint256 round, address member) view returns (bool)",
        "function roundCollected(uint256 groupId, uint256 round) view returns (uint256)",
        "function payouts(uint256 groupId, uint256 round) view returns (address recipient, uint256 amount, bool claimed)",
        "function missedRounds(uint256 groupId, address member) view returns (uint256)",
        "function consecutiveMisses(uint256 groupId, address member) view returns (uint256)",
        "function isDefaulted(uint256 groupId, address member) view returns (bool)",
        "function nextGroupId() view returns (uint256)",
        "event MemberJoined(uint256 indexed groupId, address indexed member, uint256 slot)",
        "event ContributionMade(uint256 indexed groupId, uint256 indexed round, address indexed member, uint256 amount)",
        "event ContributionCovered(uint256 indexed groupId, uint256 indexed round, address indexed member, address payer, uint256 amount)",
        "event PayoutClaimed(uint256 indexed groupId, uint256 indexed round, address indexed recipient, uint256 amount)"
    ];
    var ERC20_ABI = [
        "function balanceOf(address owner) view returns (uint256)",
        "function allowance(address owner, address spender) view returns (uint256)",
        "function approve(address spender, uint256 amount) returns (bool)"
    ];

    // ── helpers ─────────────────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }
    function _toLower(a) { return String(a || "").toLowerCase(); }
    function shortAddr(a) {
        var s = String(a || "");
        return s.length > 10 ? s.slice(0, 6) + "..." + s.slice(-4) : s;
    }
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function fmtGd(wei) {
        try {
            var n = Number(ethers.formatUnits(wei, DECIMALS));
            return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " G$";
        } catch (_) { return "0 G$"; }
    }
    function fmtGdNum(wei) {
        try { return Number(ethers.formatUnits(wei, DECIMALS)); } catch (_) { return 0; }
    }
    function txUrl(h) { return EXPLORER + "/tx/" + h; }
    function addrUrl(a) { return EXPLORER + "/address/" + a; }
    function alertBox(el, type, msg) {
        if (!el) return;
        el.className = "alert alert-" + type + " show";
        el.textContent = msg;
    }
    function hideAlert(el) { if (el) el.className = "alert"; }
    function statusLabel(s) {
        return { forming: "Forming", active: "Active", completed: "Completed", settled: "Settled", none: "-" }[s] || s;
    }
    function statusBadgeClass(s) {
        return { forming: "b-forming", active: "b-active", completed: "b-done", settled: "b-done", none: "b-done" }[s] || "b-done";
    }

    // ── read provider (public RPC, no wallet prompt) ────────────────────────
    function getReadProvider() {
        if (readProvider) return readProvider;
        if (typeof ethers === "undefined") return null;
        var urls = CELO_RPC_FALLBACKS.filter(Boolean);
        if (!urls.length) return null;
        if (typeof ethers.FallbackProvider === "function" && urls.length > 1) {
            try {
                var entries = urls.map(function (u, i) {
                    return { provider: new ethers.JsonRpcProvider(u), priority: i + 1, weight: 1, stallTimeout: 2000 };
                });
                // 2nd arg is the NETWORK (not the quorum) — a bare number pins
                // the provider to mainnet and every Celo read fails.
                readProvider = new ethers.FallbackProvider(entries, { chainId: CHAIN_ID, name: "celo" }, { quorum: 1 });
                return readProvider;
            } catch (_) { readProvider = null; }
        }
        try { readProvider = new ethers.JsonRpcProvider(urls[0]); } catch (_) { readProvider = null; }
        return readProvider;
    }

    function getReadContract() {
        var rp = getReadProvider();
        if (!rp || !CONTRACT) return null;
        return new ethers.Contract(CONTRACT, PALUWAGAN_ABI, rp);
    }

    // ── signer resolution (mirrors farming.js / swap.html) ──────────────────
    var isLocal = function () { return LOGIN_METHOD === "local"; };
    var prefersWc = function () {
        return typeof GMWalletConnect !== "undefined" &&
            typeof GMWalletConnect.prefersWcSigning === "function" &&
            GMWalletConnect.prefersWcSigning();
    };

    window.__paluwaganEip6963 = window.__paluwaganEip6963 || [];
    (function _initEip6963() {
        try {
            window.addEventListener("eip6963:announceProvider", function (event) {
                var detail = event && event.detail;
                if (!detail || !detail.provider) return;
                var uuid = detail.info && detail.info.uuid;
                var already = window.__paluwaganEip6963.find(function (d) {
                    return (uuid && d.info && d.info.uuid === uuid) || d.provider === detail.provider;
                });
                if (!already) window.__paluwaganEip6963.push(detail);
            });
            window.dispatchEvent(new Event("eip6963:requestProvider"));
        } catch (_) {}
    })();

    function _coerceProvider(c) {
        if (!c) return null;
        if (typeof c.request === "function") return c;
        if (c.ethereum && typeof c.ethereum.request === "function") return c.ethereum;
        if (c.provider && typeof c.provider.request === "function") return c.provider;
        return null;
    }
    function _collectProviders() {
        var out = [];
        var push = function (p) { var pr = _coerceProvider(p); if (pr && out.indexOf(pr) === -1) out.push(pr); };
        if (window.ethereum) {
            if (Array.isArray(window.ethereum.providers)) window.ethereum.providers.forEach(push);
            push(window.ethereum);
        }
        if (window.trustwallet) push(window.trustwallet);
        (window.__paluwaganEip6963 || []).forEach(function (d) { push(d.provider); });
        return out;
    }
    function _isUserRejection(err) {
        var code = err && err.code;
        if (code === 4001 || code === 5000) return true;
        var msg = String((err && (err.shortMessage || err.message)) || "").toLowerCase();
        return msg.indexOf("user rejected") !== -1 || msg.indexOf("user denied") !== -1 ||
            msg.indexOf("cancelled") !== -1 || msg.indexOf("canceled") !== -1;
    }
    function _localProvider() {
        if (typeof GMLocalWallet === "undefined") return Promise.reject(new Error("In-app wallet not available on this page."));
        if (!GMLocalWallet.isUnlocked()) {
            if (typeof window._lwOpenUnlockModal !== "function") {
                return Promise.reject(new Error("Please unlock your wallet and try again."));
            }
            return Promise.resolve(window._lwOpenUnlockModal()).then(function () {
                if (!GMLocalWallet.isUnlocked()) throw new Error("Your wallet is still locked. Please enter your PIN to sign.");
                return GMLocalWallet.getProvider();
            });
        }
        return Promise.resolve(GMLocalWallet.getProvider());
    }
    function _awaitProviders(timeoutMs) {
        if (prefersWc() || isLocal()) return Promise.resolve([]);
        var budget = typeof timeoutMs === "number" ? timeoutMs : 1200;
        var start = Date.now();
        var providers = _collectProviders();
        if (providers.length) return Promise.resolve(providers);
        return new Promise(function (resolve) {
            (function poll() {
                try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (_) {}
                providers = _collectProviders();
                if (providers.length) return resolve(providers);
                if (Date.now() - start >= budget) return resolve([]);
                setTimeout(poll, 120);
            })();
        });
    }
    function _bindSigner(provider) {
        var bp = new ethers.BrowserProvider(provider);
        return bp.getSigner().then(function (signer) {
            if (_toLower(signer.address) !== _toLower(WALLET)) {
                throw new Error("Wrong wallet connected. Please use your GoodMarket wallet.");
            }
            return { signer: signer, provider: provider };
        });
    }
    function resolveSigner() {
        _syncBoot();
        if (!WALLET) return Promise.reject(new Error("Please log in to sign this transaction."));
        if (isLocal()) return _localProvider().then(_bindSigner);
        return _awaitProviders().then(function (providers) {
            if (!providers.length) {
                if (prefersWc() && typeof GMWalletConnect !== "undefined") {
                    return GMWalletConnect.getProvider().then(_bindSigner);
                }
                throw new Error("No wallet detected. Open this page in MetaMask, Trust Wallet or another Celo wallet.");
            }
            var wanted = _toLower(WALLET);
            return (function tryProvider(i, lastErr) {
                if (i >= providers.length) throw lastErr || new Error("Could not connect to your wallet.");
                var provider = providers[i];
                return Promise.resolve()
                    .then(function () { return provider.request({ method: "eth_requestAccounts" }); })
                    .catch(function () { return provider.request({ method: "eth_accounts" }); })
                    .then(function (accounts) {
                        var list = (accounts || []).map(_toLower);
                        if (list.indexOf(wanted) === -1) throw new Error("account_mismatch");
                        return _bindSigner(provider);
                    })
                    .catch(function (e) {
                        if (e && e.message === "account_mismatch") {
                            return tryProvider(i + 1, new Error("Wrong wallet connected. Please switch to your GoodMarket wallet."));
                        }
                        return tryProvider(i + 1, e);
                    });
            })(0, null);
        });
    }

    // ── signing helpers ─────────────────────────────────────────────────────
    function _signTimeout(promise, ms) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var t = setTimeout(function () {
                if (done) return;
                done = true;
                reject(new Error("Your wallet did not respond. Please try again."));
            }, ms || 180000);
            promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
        });
    }
    function _friendlyError(err) {
        if (_isUserRejection(err)) return "You cancelled the transaction.";
        if (typeof GMTxError !== "undefined" && GMTxError.format) {
            try {
                var msg = GMTxError.format(err, { nativeSymbol: "CELO" });
                if (msg) return msg;
            } catch (_) {}
        }
        return (err && (err.shortMessage || err.message)) || "Transaction failed. Please try again.";
    }
    async function _ensureCeloChain(provider) {
        try {
            var cur = await provider.request({ method: "eth_chainId" });
            if (String(cur).toLowerCase() === CHAIN_HEX) return;
            await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
        } catch (e) {
            var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
            if (code === 4902 || code === -32603) {
                await provider.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: CHAIN_HEX, chainName: "Celo Mainnet",
                        nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
                        rpcUrls: CELO_RPC_FALLBACKS, blockExplorerUrls: [EXPLORER]
                    }]
                });
            } else { throw e; }
        }
    }
    async function _waitReceipt(provider, hash, tries) {
        var n = tries || 40;
        for (var i = 0; i < n; i++) {
            try {
                var r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
                if (r) {
                    if (r.status === "0x0") throw new Error("Transaction reverted on-chain.");
                    return r;
                }
            } catch (e) {
                if (String(e && e.message || "").indexOf("reverted") !== -1) throw e;
            }
            await new Promise(function (res) { setTimeout(res, 2500); });
        }
        return null;
    }
    // Send via the wallet's own EIP-1193 provider with explicit gas, so a slow
    // wallet RPC can never leave the fee field unavailable (repo-wide lesson).
    async function _sendContractCall(signerObj, methodName, args) {
        var provider = signerObj.provider;
        var signer = signerObj.signer;
        var contract = new ethers.Contract(CONTRACT, PALUWAGAN_ABI, signer);
        var from = await signer.getAddress();
        var data = contract.interface.encodeFunctionData(methodName, args);
        var txParams = { from: from, to: CONTRACT, data: data, value: "0x0" };
        try {
            var est = await provider.request({ method: "eth_estimateGas", params: [txParams] });
            txParams.gas = "0x" + (BigInt(est) * 140n / 100n).toString(16);
        } catch (_) {}
        try {
            var gp = await provider.request({ method: "eth_gasPrice" });
            txParams.gasPrice = gp;
        } catch (_) {}
        return provider.request({ method: "eth_sendTransaction", params: [txParams] });
    }

    // ── navigation ──────────────────────────────────────────────────────────
    function showSection(id) {
        ["secOverview", "secCreate", "secJoin", "secGroup", "secContribute"].forEach(function (s) {
            var el = $(s); if (el) el.classList.remove("active");
        });
        var el = $(id); if (el) el.classList.add("active");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
    window.showOverview = function () { currentGroupId = null; showSection("secOverview"); loadGroups(); };
    window.showCreate = function () { buildCreateForm(); showSection("secCreate"); };
    window.showJoin = function () { showSection("secJoin"); };

    // ── overview ────────────────────────────────────────────────────────────
    function groupCard(g) {
        var you = _toLower(WALLET);
        var isRecipient = _toLower(g.current_round_recipient) === you;
        var paid = g.current_round_paid && g.current_round_paid[you];
        var line = "";
        if (g.status === "forming") line = g.member_count + "/" + MEMBERS + " joined - waiting for members";
        else if (g.status === "active") {
            line = "Week " + g.current_round + " of " + g.weeks + " - " + (paid ? "Paid this week" : "Payment due");
            if (isRecipient) line += " - you receive this week";
        } else if (g.status === "completed") line = "All " + g.weeks + " weeks complete";
        else if (g.status === "settled") line = "Settled early";
        return '<div class="slot" role="button" tabindex="0" onclick="openGroup(' + g.id + ')">' +
            '<span class="idx">' + esc(g.token_symbol) + '</span>' +
            '<div style="flex:1;min-width:0;">' +
            '<div class="row"><span class="val">' + (g.name ? esc(g.name) + ' &middot; #' + g.id : 'Group #' + g.id) + '</span>' +
            '<span class="badge ' + statusBadgeClass(g.status) + '">' + esc(statusLabel(g.status)) + '</span></div>' +
            '<div class="note" style="margin-top:.15rem;">' + esc(g.contribution_amount_h) + ' ' + esc(g.token_symbol) +
            '/week - ' + g.weeks + ' wks - ' + esc(line) + '</div>' +
            '</div></div>';
    }
    async function loadGroups() {
        var box = $("groupList");
        if (!box) return;
        if (!CONFIGURED) { box.innerHTML = '<div class="empty-state">Not configured on this deployment.</div>'; return; }
        if (!WALLET) { box.innerHTML = '<div class="empty-state">Log in to see your groups.</div>'; return; }
        box.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading your groups&hellip;</div>';
        try {
            var res = await fetch("/paluwagan/api/groups");
            var data = await res.json();
            var groups = (data && data.groups) || [];
            if (!groups.length) {
                box.innerHTML = '<div class="empty-state">No groups yet. Create one or join with a group id.</div>';
                return;
            }
            box.innerHTML = groups.map(groupCard).join("");
        } catch (e) {
            box.innerHTML = '<div class="empty-state">Could not load groups. <a href="#" onclick="loadGroups();return false;">Retry</a></div>';
        }
    }
    window.loadGroups = loadGroups;

    // ── create ──────────────────────────────────────────────────────────────
    function buildCreateForm() {
        var tk = $("createToken");
        if (tk && !tk.options.length) {
            tk.innerHTML = '<option value="' + GD_CONTRACT + '">G$</option>';
        }
        var wk = $("createWeeks");
        if (wk && !wk.options.length) {
            wk.innerHTML = ALLOWED_WEEKS.map(function (w) {
                return '<option value="' + w + '">' + w + ' weeks (about ' + Math.round(w / 4.345) + ' months)</option>';
            }).join("");
        }
        var ob = $("orderBuilder");
        if (ob && !ob.children.length) {
            var html = "";
            for (var r = 1; r <= MEMBERS; r++) {
                html += '<div class="order-row"><span class="idx">' + r + '</span><select class="orderSel" data-round="' + r + '">';
                for (var s = 1; s <= MEMBERS; s++) {
                    var sel = (s === r) ? " selected" : "";
                    html += '<option value="' + (s - 1) + '"' + sel + '>Slot ' + s + (s === 1 ? " (you)" : "") + '</option>';
                }
                html += '</select></div>';
            }
            ob.innerHTML = html;
            ob.querySelectorAll(".orderSel").forEach(function (el) {
                el.addEventListener("change", updateSummary);
            });
        }
        var amt = $("createAmount");
        if (amt && !amt._bound) { amt._bound = true; amt.addEventListener("input", updateSummary); }
        if (wk && !wk._bound) { wk._bound = true; wk.addEventListener("change", updateSummary); }
        updateSummary();
    }
    function _createOrder() {
        var out = [];
        document.querySelectorAll(".orderSel").forEach(function (el) { out.push(Number(el.value)); });
        return out;
    }
    function updateSummary() {
        var amt = Number(($("createAmount") || {}).value || 0);
        var weeks = Number(($("createWeeks") || {}).value || 0);
        var pool = amt * MEMBERS;
        var obligation = amt * weeks;
        var received = Math.floor(weeks / MEMBERS) * pool;
        if ($("sumPool")) $("sumPool").textContent = pool ? pool.toLocaleString() + " G$" : "-";
        if ($("sumObligation")) $("sumObligation").textContent = obligation ? obligation.toLocaleString() + " G$ over " + weeks + " wks" : "-";
        if ($("sumReceived")) $("sumReceived").textContent = received ? received.toLocaleString() + " G$ (" + Math.floor(weeks / MEMBERS) + " payouts)" : "-";
        var order = _createOrder();
        var unique = new Set(order);
        var nameOk = /^[A-Za-z0-9-]{3,32}$/.test((($("createName") || {}).value || "").trim());
        var ok = amt > 0 && weeks > 0 && unique.size === MEMBERS && nameOk;
        var btn = $("createBtn");
        if (btn) {
            btn.disabled = !ok || busy;
            if (!nameOk) btn.textContent = "Create Group (add a group name)";
            else btn.textContent = ok ? "Create Group" : "Create Group (finish payout order)";
        }
    }
    window.updateSummary = updateSummary;

    // Group names are the shareable link (/paluwagan/teambetz). The contract is
    // the authority; this mirrors its rule so the user gets instant feedback.
    var NAME_RE = /^[A-Za-z0-9-]{3,32}$/;

    function _nameFromInput(raw) {
        // Accept a pasted full link as well as a bare name.
        var v = String(raw || "").trim();
        try {
            if (/^https?:\/\//i.test(v)) {
                var u = new URL(v);
                var parts = u.pathname.split("/").filter(Boolean);
                v = parts.length >= 2 && parts[0] === "paluwagan" ? parts[1] : (parts[parts.length - 1] || "");
            } else if (v.indexOf("/paluwagan/") !== -1) {
                v = v.split("/paluwagan/")[1].split(/[?#/]/)[0];
            }
        } catch (_) {}
        return v.replace(/[?#].*$/, "").replace(/\/+$/, "").trim();
    }

    window.onNameInput = function () {
        var raw = ($("createName") || {}).value || "";
        var v = raw.trim();
        var el = $("createNameLink");
        var note = $("createNameNote");
        var ok = NAME_RE.test(v);
        if (el) el.textContent = v ? ("/paluwagan/" + v.toLowerCase()) : "/paluwagan/…";
        if (note) note.style.color = (v && !ok) ? "var(--err)" : "";
        updateSummary();
    };

    window.createGroup = async function () {
        if (busy) return;
        var alertEl = $("pageAlert");
        var name = (($("createName") || {}).value || "").trim();
        var amt = Number(($("createAmount") || {}).value || 0);
        var weeks = Number(($("createWeeks") || {}).value || 0);
        var token = ($("createToken") || {}).value || GD_CONTRACT;
        var order = _createOrder();
        if (!NAME_RE.test(name)) { alertBox(alertEl, "error", "Group name must be 3–32 characters: letters, numbers and – only."); return; }
        if (!(amt > 0)) { alertBox(alertEl, "error", "Enter a weekly contribution amount greater than zero."); return; }
        if (ALLOWED_WEEKS.indexOf(weeks) === -1) { alertBox(alertEl, "error", "Choose a commitment period of " + ALLOWED_WEEKS.join(" or ") + " weeks."); return; }
        if (new Set(order).size !== MEMBERS) { alertBox(alertEl, "error", "Each payout round must use a different slot."); return; }
        busy = true; updateSummary();
        try {
            var s = await resolveSigner();
            var amountWei = ethers.parseUnits(String(amt), DECIMALS);
            var hash = await _signTimeout(_sendContractCall(s, "createGroup", [name, token, amountWei, weeks, order]), 180000);
            alertBox(alertEl, "info", "Creating group... " + hash);
            await _waitReceipt(s.provider, hash);
            alertBox(alertEl, "success", "Group \"" + name + "\" created. Share /paluwagan/" + name.toLowerCase() + " so 4 others can join.");
            setTimeout(function () { window.showOverview(); }, 1200);
        } catch (e) {
            alertBox(alertEl, "error", _friendlyError(e));
        } finally {
            busy = false; updateSummary();
        }
    };

    // ── join ────────────────────────────────────────────────────────────────

    // Resolves whatever the user typed (name, or a pasted invite link) to a
    // group id via the on-chain name registry. Returns 0 when unknown.
    async function _resolveJoinTarget() {
        var rawName = ($("joinName") || {}).value || "";
        var name = _nameFromInput(rawName);
        var gid = Number(($("joinId") || {}).value || 0);
        if (!name) return gid;
        var res = await fetch("/paluwagan/api/resolve/" + encodeURIComponent(name));
        if (res.status === 404) return -1;
        var data = await res.json();
        var g = data && data.group;
        if (!g) return -1;
        if ($("joinId")) $("joinId").value = g.id;
        return Number(g.id);
    }

    window.previewJoin = async function () {
        var alertEl = $("pageAlert");
        hideAlert(alertEl);
        var box = $("joinPreview");
        if (box) box.style.display = "block";
        var body = $("joinPreviewBody");
        if (body) body.innerHTML = '<span class="spinner"></span> Loading group&hellip;';
        var gid;
        try {
            gid = await _resolveJoinTarget();
        } catch (_) {
            if (body) body.innerHTML = '<div class="empty-state">Could not look up that group.</div>';
            return;
        }
        if (gid === -1) {
            if (body) body.innerHTML = '<div class="empty-state">No group found with that name.</div>';
            return;
        }
        if (!(gid > 0)) {
            if (body) body.innerHTML = '<div class="empty-state">Enter a group name or id.</div>';
            return;
        }
        try {
            var res = await fetch("/paluwagan/api/group/" + gid);
            var data = await res.json();
            var g = data && data.group;
            if (!g) { if (body) body.innerHTML = '<div class="empty-state">Group not found.</div>'; return; }
            currentGroupId = gid;
            var rows =
                '<div class="split"><div class="kv"><div class="k">Group</div><div class="v">' + esc(g.name || ("#" + g.id)) + '</div></div>' +
                '<div class="kv"><div class="k">Token</div><div class="v">' + esc(g.token_symbol) + '</div></div>' +
                '<div class="kv"><div class="k">Weekly</div><div class="v">' + esc(g.contribution_amount_h) + ' ' + esc(g.token_symbol) + '</div></div>' +
                '<div class="kv"><div class="k">Period</div><div class="v">' + g.weeks + ' weeks</div></div>' +
                '<div class="kv"><div class="k">Members</div><div class="v">' + g.member_count + '/' + MEMBERS + '</div></div></div>' +
                '<p class="note">Contribute ' + esc(g.contribution_amount_h) + ' ' + esc(g.token_symbol) + ' every week for ' + g.weeks + ' weeks. ' +
                'One payout of ' + esc(g.pool_amount_h) + ' ' + esc(g.token_symbol) + ' on your turn. Deadlines every 7 days with a 2-day grace period. ' +
                'No early exit after the group starts. Payouts are released only when the full weekly pool is collected.</p>';
            if (body) body.innerHTML = rows;
            var jb = $("joinBtn");
            if (jb) {
                var full = g.member_count >= MEMBERS || g.status !== "forming";
                var mine = _toLower(WALLET) && (g.members || []).map(_toLower).indexOf(_toLower(WALLET)) !== -1;
                jb.disabled = full || mine || !WALLET;
                if (!WALLET) jb.textContent = "Log in to join";
                else if (mine) jb.textContent = "You are already in this group";
                else if (full) jb.textContent = "Group is full";
                else jb.textContent = "Join Group";
            }
        } catch (e) {
            if (body) body.innerHTML = '<div class="empty-state">Could not load the group.</div>';
        }
    };

    window.joinGroup = async function () {
        if (busy) return;
        var alertEl = $("pageAlert");
        var gid;
        try {
            gid = await _resolveJoinTarget();
        } catch (_) { gid = 0; }
        if (!(gid > 0)) { alertBox(alertEl, "error", "Enter a valid group name or id."); return; }
        busy = true;
        try {
            var s = await resolveSigner();
            var hash = await _signTimeout(_sendContractCall(s, "joinGroup", [gid]), 180000);
            alertBox(alertEl, "info", "Joining group... " + hash);
            await _waitReceipt(s.provider, hash);
            alertBox(alertEl, "success", "You joined group #" + gid + ".");
            setTimeout(function () { openGroup(gid); }, 1000);
        } catch (e) {
            alertBox(alertEl, "error", _friendlyError(e));
        } finally { busy = false; }
    };

    // ── group detail ────────────────────────────────────────────────────────
    window.openGroup = async function (gid) {
        currentGroupId = gid;
        showSection("secGroup");
        await refreshGroup();
    };
    window.refreshGroup = async function (opts) {
        if (!currentGroupId) return;
        var silent = !!(opts && opts.silent);
        var alertEl = $("pageAlert");
        try {
            var res = await fetch("/paluwagan/api/group/" + currentGroupId);
            var data = await res.json();
            currentGroup = data && data.group;
            if (!currentGroup) {
                if (!silent) alertBox(alertEl, "error", "Could not load group #" + currentGroupId + ".");
                return;
            }
            renderGroup(currentGroup);
            // A background poll must not flash spinners over history the user
            // may be reading — the member list / progress bar is what changes
            // when other wallets join or pay.
            if (!silent) {
                loadContributions(currentGroupId);
                loadPayouts(currentGroupId);
            }
        } catch (e) {
            if (!silent) alertBox(alertEl, "error", "Could not load group. Please retry.");
        }
    };

    // Keep the open group live: the member list and contribution progress change
    // when OTHER wallets join or pay, and without a poll the page only ever
    // showed the state from the moment it was opened. Paused while the tab is
    // hidden or a tx is in flight, and only runs while the group view is open.
    var GROUP_POLL_MS = 15000;
    async function _pollGroupOnce() {
        if (document.hidden || busy || !currentGroupId) return;
        var groupSection = $("secGroup");
        if (!groupSection || !groupSection.classList.contains("active")) return;
        await window.refreshGroup({ silent: true });
    }
    setInterval(_pollGroupOnce, GROUP_POLL_MS);
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden && currentGroupId) _pollGroupOnce();
    });

    window.openGroupById = function (id) { return window.openGroup(id); };

    function renderGroup(g) {
        var you = _toLower(WALLET);
        if ($("gTitle")) $("gTitle").textContent = g.name ? (g.name + " · #" + g.id) : ("Group #" + g.id);
        if ($("gMeta")) $("gMeta").textContent = g.token_symbol + " - " + g.contribution_amount_h + "/wk - " + g.weeks + " weeks";
        var st = $("gStatus");
        if (st) { st.className = "badge " + statusBadgeClass(g.status); st.textContent = statusLabel(g.status); }

        // Lobby
        var lobby = $("lobbyList");
        if (lobby) {
            var html = "";
            for (var i = 0; i < MEMBERS; i++) {
                var m = (g.members || [])[i];
                if (m) {
                    var isYou = _toLower(m) === you;
                    var isDef = g.member_defaults && g.member_defaults[_toLower(m)];
                    html += '<div class="slot"><span class="idx">' + (i + 1) + '</span>' +
                        '<span class="mono">' + esc(shortAddr(m)) + '</span>' +
                        (isYou ? '<span class="badge b-you" style="margin-left:auto;">You</span>'
                               : '<span class="badge ' + (isDef ? 'b-def' : 'b-active') + '" style="margin-left:auto;">' + (isDef ? 'Defaulted' : 'Joined') + '</span>') +
                        '</div>';
                } else {
                    html += '<div class="slot empty"><span class="idx">' + (i + 1) + '</span><span class="note">Waiting for member...</span></div>';
                }
            }
            lobby.innerHTML = html;
        }
        var ab = $("activateBtn");
        if (ab) ab.disabled = !(g.status === "forming" && g.member_count >= MEMBERS && _isMember(g));

        // Members tab
        if ($("tab-members")) {
            var rows = (g.members || []).map(function (m, i) {
                var paid = g.current_round_paid && g.current_round_paid[_toLower(m)];
                return '<tr><td class="strong mono">' + esc(shortAddr(m)) + (i === g.payout_order[0] ? "" : "") + '</td>' +
                    '<td>' + esc(g.token_symbol) + '</td>' +
                    '<td>' + (paid ? '<span class="badge b-active">Paid</span>' : '<span class="badge b-forming">Due</span>') + '</td></tr>';
            }).join("");
            $("tab-members").innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Member</th><th>Token</th><th>This week</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        }

        // Schedule tab
        if ($("tab-schedule")) {
            var srows = "";
            var maxR = Math.min(g.weeks, 12);
            for (var r = 1; r <= maxR; r++) {
                var slot = g.payout_order[(r - 1) % MEMBERS];
                var recipient = (g.members || [])[slot] || "-";
                var isCur = r === g.current_round;
                srows += '<tr' + (isCur ? ' style="background:rgba(45,212,191,.06);"' : '') + '>' +
                    '<td class="strong">' + r + '</td><td class="mono">' + esc(shortAddr(recipient)) + '</td>' +
                    '<td>' + (r < g.current_round ? 'Settled' : (isCur ? 'In progress' : 'Upcoming')) + '</td></tr>';
            }
            if (g.weeks > maxR) srows += '<tr><td colspan="3" class="note">Showing first ' + maxR + ' of ' + g.weeks + ' rounds.</td></tr>';
            $("tab-schedule").innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Week</th><th>Recipient</th><th>Status</th></tr></thead><tbody>' + srows + '</tbody></table></div>';
        }

        // This week
        var cr = g.current_round || 0;
        if ($("curRound")) $("curRound").textContent = cr ? ("Week " + cr + " of " + g.weeks) : "Not started";
        if ($("curRecipient")) $("curRecipient").textContent = g.current_round_recipient ? shortAddr(g.current_round_recipient) : "-";
        if ($("curCollected")) $("curCollected").textContent = cr ? (g.current_round_collected_h + " / " + g.pool_amount_h + " " + g.token_symbol) : "-";
        if ($("curBar")) {
            var pct = cr && g.pool_amount ? Math.min(100, (Number(g.current_round_collected || 0) / Number(g.pool_amount)) * 100) : 0;
            $("curBar").style.width = pct + "%";
        }

        // Buttons
        var cb = $("contributeBtn");
        if (cb) {
            var paid = g.current_round_paid && g.current_round_paid[you];
            cb.disabled = !(g.status === "active" && _isMember(g) && !paid);
            cb.textContent = paid ? "Contributed this week" : "Make Contribution";
        }
        var clb = $("claimBtn");
        if (clb) {
            var isRecipient = _toLower(g.current_round_recipient) === you;
            clb.disabled = !(g.status === "active" && isRecipient && g.current_round_pool_complete);
            clb.textContent = isRecipient ? "Claim Payout" : "Claim (recipient only)";
        }

        // Missed card
        var mc = $("missedCard");
        if (mc) {
            if (g.is_member && (g.my_missed_rounds > 0 || g.my_defaulted)) {
                mc.style.display = "block";
                var txt = '<div class="alert alert-' + (g.my_defaulted ? "error" : "warn") + ' show">';
                if (g.my_defaulted) txt += "You are marked defaulted on-chain (" + g.my_consecutive_misses + " consecutive misses).";
                else txt += "You have " + g.my_missed_rounds + " missed round(s). Pay outstanding to restore good standing.";
                txt += "</div>";
                $("missedBody").innerHTML = txt;
            } else {
                mc.style.display = "none";
            }
        }
    }
    function _isMember(g) { return g && g.is_member; }

    window.switchGroupTab = function (name) {
        ["members", "schedule", "contrib", "payouts"].forEach(function (t) {
            var el = $("tab-" + t); if (el) el.style.display = (t === name ? "block" : "none");
        });
        document.querySelectorAll(".tab").forEach(function (b) {
            b.classList.toggle("on", b.getAttribute("data-tab") === name);
        });
    };

    async function loadContributions(gid) {
        var box = $("tab-contrib");
        if (!box) return;
        box.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading contributions&hellip;</div>';
        try {
            var res = await fetch("/paluwagan/api/group/" + gid + "/contributions");
            var data = await res.json();
            var rows = (data && data.contributions) || [];
            if (!rows.length) { box.innerHTML = '<div class="empty-state">No contributions yet.</div>'; return; }
            box.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Week</th><th>Member</th><th>Amount</th><th>Tx</th></tr></thead><tbody>' +
                rows.map(function (r) {
                    var amt = fmtGd(r.amount);
                    var who = r.type === "covered" ? shortAddr(r.member) + " (by " + shortAddr(r.payer) + ")" : shortAddr(r.member);
                    return '<tr><td>' + r.round + '</td><td class="mono">' + esc(who) + '</td><td class="strong">' + esc(amt) + '</td>' +
                        '<td><a class="hash" href="' + txUrl(r.tx_hash) + '" target="_blank" rel="noopener noreferrer">' + esc(shortAddr(r.tx_hash)) + '</a></td></tr>';
                }).join("") + '</tbody></table></div>';
        } catch (e) {
            box.innerHTML = '<div class="empty-state">Could not load contributions.</div>';
        }
    }
    async function loadPayouts(gid) {
        var box = $("tab-payouts");
        if (!box) return;
        box.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading payouts&hellip;</div>';
        try {
            var res = await fetch("/paluwagan/api/group/" + gid + "/payouts");
            var data = await res.json();
            var rows = (data && data.payouts) || [];
            if (!rows.length) { box.innerHTML = '<div class="empty-state">No payouts claimed yet.</div>'; return; }
            box.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Week</th><th>Recipient</th><th>Amount</th><th>Tx</th></tr></thead><tbody>' +
                rows.map(function (r) {
                    return '<tr><td>' + r.round + '</td><td class="mono">' + esc(shortAddr(r.recipient)) + '</td><td class="strong">' + esc(fmtGd(r.amount)) + '</td>' +
                        '<td><a class="hash" href="' + txUrl(r.tx_hash) + '" target="_blank" rel="noopener noreferrer">' + esc(shortAddr(r.tx_hash)) + '</a></td></tr>';
                }).join("") + '</tbody></table></div>';
        } catch (e) {
            box.innerHTML = '<div class="empty-state">Could not load payouts.</div>';
        }
    }

    window.activateGroup = async function () {
        if (busy || !currentGroupId) return;
        var alertEl = $("pageAlert");
        busy = true;
        try {
            var s = await resolveSigner();
            var hash = await _signTimeout(_sendContractCall(s, "activateGroup", [currentGroupId]), 180000);
            alertBox(alertEl, "info", "Activating group... " + hash);
            await _waitReceipt(s.provider, hash);
            alertBox(alertEl, "success", "Group activated. Week 1 has started.");
            setTimeout(refreshGroup, 1000);
        } catch (e) { alertBox(alertEl, "error", _friendlyError(e)); }
        finally { busy = false; }
    };

    window.copyInvite = function () {
        var slug = (currentGroup && currentGroup.name) ? String(currentGroup.name).toLowerCase() : "";
        var url = slug
            ? window.location.origin + "/paluwagan/" + slug
            : window.location.origin + "/paluwagan?join=" + currentGroupId;
        try {
            navigator.clipboard.writeText(url);
            alertBox($("pageAlert"), "success", "Invite link copied.");
        } catch (_) {
            alertBox($("pageAlert"), "info", "Invite link: " + url);
        }
    };

    // ── contribute ──────────────────────────────────────────────────────────
    window.openContribute = async function () {
        if (!currentGroup) return;
        showSection("secContribute");
        hideAlert($("contributeAlert"));
        if ($("cAmount")) $("cAmount").textContent = currentGroup.contribution_amount_h + " " + currentGroup.token_symbol;
        if ($("cToGroup")) $("cToGroup").textContent = currentGroup.contribution_amount_h + " " + currentGroup.token_symbol;
        if ($("payBtn")) $("payBtn").textContent = "Step 2 - Contribute " + currentGroup.contribution_amount_h + " " + currentGroup.token_symbol;
        try {
            var res = await fetch("/paluwagan/api/balances");
            var d = await res.json();
            if ($("cBalance")) $("cBalance").textContent = fmtGd(d.token_balance || 0);
            if ($("cCelo")) $("cCelo").textContent = (Number(d.celo_balance || 0) / 1e18).toFixed(4) + " CELO";
            // Allowance check -> decide whether Step 1 is needed.
            var rp = getReadProvider();
            if (rp && CONTRACT) {
                var erc20 = new ethers.Contract(GD_CONTRACT, ERC20_ABI, rp);
                var allow = await erc20.allowance(WALLET, CONTRACT);
                var need = ethers.parseUnits(String(currentGroup.contribution_amount_h), DECIMALS);
                var ab = $("approveBtn");
                if (ab) {
                    var enough = BigInt(allow) >= BigInt(need);
                    ab.style.display = enough ? "none" : "block";
                }
            }
        } catch (_) {}
        if ($("cGas")) $("cGas").textContent = "shown in wallet";
    };

    window.doApprove = async function () {
        if (busy || !currentGroup) return;
        var alertEl = $("contributeAlert");
        busy = true;
        try {
            var s = await resolveSigner();
            var amountWei = ethers.parseUnits(String(currentGroup.contribution_amount_h), DECIMALS);
            var erc20 = new ethers.Contract(GD_CONTRACT, ERC20_ABI, s.signer);
            var from = await s.signer.getAddress();
            var data = erc20.interface.encodeFunctionData("approve", [CONTRACT, amountWei]);
            var tx = { from: from, to: GD_CONTRACT, data: data, value: "0x0" };
            var hash = await _signTimeout(s.provider.request({ method: "eth_sendTransaction", params: [tx] }), 180000);
            alertBox(alertEl, "info", "Approving... " + hash);
            await _waitReceipt(s.provider, hash);
            alertBox(alertEl, "success", "Approved. You can now contribute.");
            var ab = $("approveBtn"); if (ab) ab.style.display = "none";
        } catch (e) { alertBox(alertEl, "error", _friendlyError(e)); }
        finally { busy = false; }
    };

    window.doContribute = async function () {
        if (busy || !currentGroupId) return;
        var alertEl = $("contributeAlert");
        busy = true;
        if ($("payBtn")) $("payBtn").disabled = true;
        try {
            var s = await resolveSigner();
            var hash = await _signTimeout(_sendContractCall(s, "contribute", [currentGroupId]), 180000);
            alertBox(alertEl, "info", "Submitting contribution... " + hash);
            var receipt = await _waitReceipt(s.provider, hash);
            if (receipt) alertBox(alertEl, "success", "Contribution confirmed for this week.");
            else alertBox(alertEl, "warn", "Submitted but not yet confirmed. Check CeloScan: " + txUrl(hash));
            setTimeout(refreshGroup, 1200);
        } catch (e) { alertBox(alertEl, "error", _friendlyError(e)); }
        finally { busy = false; if ($("payBtn")) $("payBtn").disabled = false; }
    };

    window.claimPayout = async function () {
        if (busy || !currentGroupId || !currentGroup) return;
        var alertEl = $("pageAlert");
        busy = true;
        try {
            var s = await resolveSigner();
            var round = currentGroup.current_round;
            var hash = await _signTimeout(_sendContractCall(s, "claimPayout", [currentGroupId, round]), 180000);
            alertBox(alertEl, "info", "Claiming payout... " + hash);
            await _waitReceipt(s.provider, hash);
            alertBox(alertEl, "success", "Payout claimed. " + currentGroup.pool_amount_h + " " + currentGroup.token_symbol + " sent to your wallet.");
            setTimeout(refreshGroup, 1200);
        } catch (e) { alertBox(alertEl, "error", _friendlyError(e)); }
        finally { busy = false; }
    };

    // ── boot ────────────────────────────────────────────────────────────────
    function _boot() {
        _syncBoot();
        if (!CONFIGURED) {
            var box = $("groupList");
            if (box) box.innerHTML = '<div class="empty-state">The Paluwagan contract is not configured on this deployment yet.</div>';
            return;
        }
        // WalletConnect configuration (mirrors savings.html).
        if (typeof GMWalletConnect !== "undefined" && typeof GMWalletConnect.configure === "function") {
            try {
                GMWalletConnect.configure({
                    walletAddress: WALLET,
                    loginMethod: LOGIN_METHOD,
                    projectId: boot.walletconnectProjectId || ""
                });
            } catch (_) {}
        }
        // Deep link: /paluwagan/<name> (path) or /paluwagan?join=<id|name>.
        try {
            var deepName = boot.joinName || "";
            var params = new URLSearchParams(window.location.search);
            var join = params.get("join") || "";
            if (!deepName && join) {
                // `join` is either a numeric id or a name.
                if (/^\d+$/.test(join)) {
                    if ($("joinId")) $("joinId").value = join;
                } else {
                    deepName = join;
                }
            }
            if (deepName && $("joinName")) {
                $("joinName").value = deepName;
                showSection("secJoin");
                window.previewJoin();
                return;
            }
            if (join && $("joinId")) {
                $("joinId").value = join;
                showSection("secJoin");
                window.previewJoin();
                return;
            }
        } catch (_) {}
        loadGroups();
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _boot);
    } else { _boot(); }
})();
