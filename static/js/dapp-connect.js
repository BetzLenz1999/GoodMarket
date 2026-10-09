/**
 * GoodMarket — Connect a dApp (WalletConnect WALLET role, Phase 1)
 * ---------------------------------------------------------------------------
 * This is the *other side* of wc-bridge.js. wc-bridge.js makes our app act as
 * a dApp (it opens sessions OUT to the user's wallet). This module makes our
 * app act as a WALLET: the user copies a WalletConnect link from an external
 * dApp, pastes it here, approves a session, and then signs for that dApp from
 * inside GoodMarket.
 *
 * Phase 1 is deliberately scoped to LOCAL-login users (GMLocalWallet), because
 * that is the only login method where the app holds the private key and can
 * sign on-device with a PIN — no external wallet app to wake, no relay round
 * trip. Any other login method gets a clear "use your in-app wallet" message.
 *
 * SECURITY INVARIANTS (do not weaken):
 *   - NEVER auto-sign. Every session_request opens an approval sheet showing
 *     the chain and the full request. Only eth_accounts / eth_chainId are
 *     answered silently (they expose nothing and dApps need them).
 *   - Allowlist. Only Celo/XDC/Base/Ethereum and a small method set; eth_sign (blind
 *     signing) and anything unknown are auto-rejected.
 *   - Show the dApp's real origin (peer.metadata.url) and warn on mismatch.
 *   - Signing always goes through GMLocalWallet.getProvider() for local
 *     logins; never fall back to an injected provider (a different account).
 *
 * Exposes window.GMDappConnect with:
 *   init()                       -> wire events once (idempotent)
 *   isEligible()                 -> true when the login method can sign here
 *   open() / close()             -> the connect modal
 *   connectFromLink(uri)         -> pair() from a pasted wc: URI
 *   approveProposal() / rejectProposal()
 *   approveRequest() / rejectRequest()
 *   revoke(topic)
 *   sessions()                   -> active sessions (metadata only)
 *   refreshStatusStrip()         -> show/hide the wallet-page status strip
 */
(function (global) {
    "use strict";

    if (global.GMDappConnect) return;

    // GM_WALLET_BOOT is emitted as an INLINE object late in the document body,
    // while this file is loaded early in <head>. Capture it LAZILY at call time
    // — snapshotting it here would freeze every value to its default ("") and
    // make isEligible() false for everyone, including real in-app wallets.
    function _boot() { return global.GM_WALLET_BOOT || {}; }
    function _loginMethod() { return String(_boot().loginMethod || "").toLowerCase(); }
    function _walletAddr() { return _boot().wallet || ""; }
    function _projectId() { return _boot().walletConnectProjectId || ""; }
    function _assetVersion() { return _boot().assetVersion || ""; }

    // Chains and methods we will ever accept. Everything else is rejected at
    // proposal time and at request time.
    var ALLOWED_METHODS = [
        "personal_sign",
        "eth_signTypedData",
        "eth_signTypedData_v3",
        "eth_signTypedData_v4",
        "eth_sendTransaction",
        "eth_accounts",
        "eth_chainId",
        "wallet_switchEthereumChain"
    ];
    // Methods answered WITHOUT a user prompt (they reveal nothing).
    var SILENT_METHODS = ["eth_accounts", "eth_chainId"];
    // Read-only JSON-RPC forwarded straight to the chain's public RPC by the
    // in-app wallet. No signature, no key material, no user prompt — but a
    // dApp cannot render a balance or estimate gas without them.
    var READ_METHODS = [
        "eth_call", "eth_estimateGas", "eth_getBalance", "eth_getCode",
        "eth_getStorageAt", "eth_getTransactionCount", "eth_getBlockByNumber",
        "eth_getBlockByHash", "eth_getTransactionByHash",
        "eth_getTransactionReceipt", "eth_getLogs", "eth_blockNumber",
        "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
        "eth_syncing", "net_version", "web3_clientVersion"
    ];
    // Wallet-scoped methods we answer ourselves instead of forwarding.
    var WALLET_METHODS = ["wallet_switchEthereumChain", "wallet_addEthereumChain"];

    // Read-only WALLET methods a modern dApp (e.g. Reown AppKit) lists in its
    // proposal. We tolerate them so a proposal is never blocked by their mere
    // presence, and at request time we answer a harmless empty result — they
    // never touch the key and never move funds.
    var BENIGN_WALLET_READS = [
        "wallet_getPermissions", "wallet_getCapabilities",
        "wallet_getCallsStatus", "wallet_getAssets"
    ];

    var ALLOWED_CHAINS = {
        "eip155:42220": { label: "Celo", hex: "0xa4ec" },
        "eip155:50": { label: "XDC Network", hex: "0x32" },
        "eip155:8453": { label: "Base", hex: "0x2105" },
        "eip155:1": { label: "Ethereum", hex: "0x1" }
    };

    var MAX_SESSIONS = 10;

    var WC_CDN_URL = "https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.17.0/dist/index.umd.js";

    var _state = {
        client: null,
        sdkLoading: null,
        pendingProposal: null,
        pendingRequest: null,
        // True while the user is pasting a link via "Connect another dApp"
        // even though a session already exists — keeps the paste form open.
        connectFormForced: false,
        inited: false
    };

    var _log = function () {};

    // ── small helpers ────────────────────────────────────────────────────

    function _el(id) { return global.document ? global.document.getElementById(id) : null; }

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function _shortAddr(a) {
        var s = String(a || "");
        return s.length > 12 ? (s.slice(0, 6) + "…" + s.slice(-4)) : s;
    }

    function isEligible() {
        return _loginMethod() === "local" &&
            typeof global.GMLocalWallet !== "undefined" &&
            typeof global.GMLocalWallet.getProvider === "function";
    }

    // ── relay health ─────────────────────────────────────────────────────
    // A session we paired into stays in local storage, but its relay
    // subscription/websocket is only open while the client is running. Without
    // an open socket an outbound `disconnect()` cannot be delivered, so the
    // dApp never learns we left. These helpers open (or verify) the socket.
    function _ensureRelayer(client, timeoutMs) {
        var relayer = client && client.core && client.core.relayer;
        if (!relayer || typeof relayer.transportOpen !== "function") return Promise.resolve(null);
        var open;
        try { open = relayer.transportOpen(); } catch (e) { return Promise.reject(e); }
        if (!open || typeof open.then !== "function") return Promise.resolve(relayer);
        var cap = new Promise(function (resolve) { setTimeout(function () { resolve("timeout"); }, timeoutMs || 10000); });
        return Promise.race([open, cap]).then(function () { return relayer; }, function (e) {
            _log("[dapp-connect] transportOpen:", e && e.message);
            return relayer; // never reject the caller — best effort
        });
    }

    function _relayerOpen() {
        var relayer = _state.client && _state.client.core && _state.client.core.relayer;
        if (!relayer) return false;
        // Only treat it as OPEN when a build exposes a definite positive
        // signal. We deliberately avoid guessing from absence so a healthy
        // session never shows a false "offline" warning.
        return !!(relayer.connected ||
            (relayer.provider && relayer.provider.connection && relayer.provider.connection.socket));
    }

    function _relayerExplicitlyClosed() {
        var relayer = _state.client && _state.client.core && _state.client.core.relayer;
        return !!(relayer && relayer.transportExplicitlyClosed === true);
    }

    function _disconnectReason(msg) {
        return { code: 6000, message: msg || "User revoked the session." };
    }

    // Disconnect a session and REPORT whether the notice reached the dApp.
    // We must not silently succeed: if the relay is unreachable, the local
    // session is dropped but the dApp still shows "connected" — the exact
    // confusion users hit. Returns {delivered:boolean, lastError?:string}.
    function _disconnectSession(topic, reasonMsg, retries) {
        return _getClient().then(function (client) {
            return _ensureRelayer(client, 8000).then(function () { return client; });
        }).then(function (client) {
            var attempt = function (n) {
                return client.disconnect({ topic: topic, reason: _disconnectReason(reasonMsg) })
                    .then(function () { return true; })
                    .catch(function (e) {
                        if (n > 0) {
                            return new Promise(function (r) { setTimeout(r, 1200); })
                                .then(function () { return _ensureRelayer(client, 8000).then(function () { return attempt(n - 1); }); });
                        }
                        _log("[dapp-connect] disconnect publish:", e && e.message);
                        return false;
                    });
            };
            return attempt(retries == null ? 1 : retries);
        }).then(function (delivered) {
            return { delivered: delivered };
        }).catch(function (e) {
            return { delivered: false, lastError: e && e.message };
        });
    }

    // ── SignClient (wallet role) ─────────────────────────────────────────

    function _appendScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error("Failed to load " + src)); };
            document.head.appendChild(s);
        });
    }

    function _loadSdk() {
        if (_state.sdkLoading) return _state.sdkLoading;
        var _av = _assetVersion();
        var localSrc = "/static/js/wc-bundle.js" + (_av ? ("?v=" + encodeURIComponent(_av)) : "");
        function pick() {
            var ns = global["@walletconnect/sign-client"];
            return (ns && ns.SignClient) || null;
        }
        _state.sdkLoading = Promise.resolve()
            .then(function () {
                if (pick()) return pick();
                return _appendScript(localSrc).then(pick, function () { return null; });
            })
            .then(function (sc) {
                if (sc) return sc;
                return _appendScript(WC_CDN_URL).then(function () {
                    var sc2 = pick();
                    if (!sc2) throw new Error("WalletConnect SDK unavailable");
                    return sc2;
                });
            });
        return _state.sdkLoading;
    }

    function _getClient() {
        if (_state.client) return Promise.resolve(_state.client);
        if (!_projectId()) {
            return Promise.reject(new Error("WalletConnect is not configured (missing project id)."));
        }
        return _loadSdk().then(function (SignClient) {
            return SignClient.init({
                projectId: _projectId(),
                // Separate storage namespace so our wallet-role sessions never
                // collide with the dApp-role login session managed by
                // wc-bridge.js (different encryption keys, same origin).
                customStoragePrefix: "gmdapp",
                metadata: {
                    name: "GoodMarket",
                    description: "GoodMarket in-app wallet",
                    url: (global.location ? global.location.origin : ""),
                    icons: [(global.location ? global.location.origin : "") + "/static/icons/icon-192x192.png"]
                }
            });
        }).then(function (client) {
            _state.client = client;
            _wireClientEvents(client);
            // Ensure the relay websocket is up so an outbound disconnect is
            // DELIVERED. `disconnect()` publishes `wc_sessionDelete` to the
            // dApp over the relay; if we only ever RECEIVED (paired once), the
            // socket may not be open yet, the publish throws, and SignClient
            // locally deletes the session anyway — so the dApp keeps showing
            // "connected" while we show "no dApps". A 10s cap keeps a dead
            // relay from blocking the UI; revoke() re-tries at click time.
            _ensureRelayer(client);
            return client;
        });
    }

    function _wireClientEvents(client) {
        client.on("session_proposal", function (proposal) {
            _state.pendingProposal = proposal;
            _renderProposal(proposal);
            _renderSessions();
            _openModal("dappConnectModal");
            // Bring the review (proposal + Approve/Decline) into view — it now
            // sits right under the title with the paste form hidden.
            _scrollSheetTop();
        });
        client.on("session_request", function (event) {
            _handleSessionRequest(event);
        });
        client.on("session_delete", function (event) {
            // The dApp disconnected us (or the session was otherwise removed).
            // Drop any approval sheet that belonged to it so we don't leave a
            // dead "Sign request" prompt open.
            _clearRequestForTopic(event && event.topic);
            refreshStatusStrip();
            if (_el("dappSessionList")) _renderSessions();
            _toast("🔌 A dApp disconnected from your wallet.");
        });
        client.on("session_expire", function (event) {
            _clearRequestForTopic(event && event.topic);
            refreshStatusStrip();
            if (_el("dappSessionList")) _renderSessions();
        });
    }

    function init() {
        if (_state.inited) return;
        // Only local logins can sign here, so never pay for the SignClient
        // (SDK load + relay connection) for WalletConnect/injected sessions.
        if (!isEligible()) return;
        _state.inited = true;
        _wireLogout();
        try {
            _getClient().then(function () {
                _dropForeignSessions();
                refreshStatusStrip();
                // Re-render the modal so an already-connected session hides the
                // connect form the moment the client finishes booting.
                if (_el("dappSessionList")) _renderSessions();
            }).catch(function (e) { _log("[dapp-connect] init:", e && e.message); });
        } catch (e) {
            _log("[dapp-connect] init failed:", e && e.message);
        }
    }

    // ── connect modal ────────────────────────────────────────────────────

    // Reuse wallet-main.js's openModal (it also closes other overlays and
    // locks body scroll). A sign request SHOULD take over the screen — the
    // user must deal with it. #lwUnlockModal is exempted inside openModal,
    // so the PIN prompt still stacks above the approval sheet.
    function _openModal(id) {
        if (typeof global.openModal === "function") {
            global.openModal(id);
            return;
        }
        var el = _el(id);
        if (el) el.classList.add("open");
    }

    function _closeModal(id) {
        if (typeof global.closeModal === "function") {
            global.closeModal(id);
            return;
        }
        var el = _el(id);
        if (el) el.classList.remove("open");
    }

    function open() {
        if (!isEligible()) {
            _setDisp("dappConnectForm", false);
            _setDisp("dappConnectAgainBtn", false);
            _setDisp("dappSessionsWrap", false);
            _setDisp("dappProposalActions", false);
            _setConnectStatus(
                "🔒 Connect a dApp signs with your in-app GoodMarket wallet (email + PIN). " +
                "Log in with your GoodMarket wallet to use it — a MetaMask, WalletConnect or " +
                "Privy login signs in its own wallet, not here." , "error");
            _openModal("dappConnectModal");
            return;
        }
        _setConnectStatus("", "");
        // Lazily boot the wallet-role client on first open. A session_request
        // can arrive at any time after that, so the client stays alive.
        init();
        _renderSessions();
        _openModal("dappConnectModal");
    }

    function close() {
        _closeModal("dappConnectModal");
    }

    function _setConnectStatus(msg, kind) {
        var el = _el("dappConnectStatus");
        if (!el) return;
        el.textContent = msg || "";
        el.style.display = msg ? "block" : "none";
        el.className = "dapp-status" + (kind ? (" is-" + kind) : "");
    }

    function connectFromLink(rawUri) {
        var uri = String(rawUri || "").trim();
        if (!uri) {
            _setConnectStatus("Paste the WalletConnect link from the dApp first.", "error");
            return Promise.resolve();
        }
        // Accept a full wc: URI pasted from a dApp, or a URL that contains it.
        var m = uri.match(/wc:[^\s"']+/);
        if (m) uri = m[0];
        if (uri.indexOf("wc:") !== 0) {
            _setConnectStatus("That doesn't look like a WalletConnect link (it should start with wc:).", "error");
            return Promise.resolve();
        }
        if (!isEligible()) {
            _setConnectStatus("Connect a dApp signs with your in-app GoodMarket wallet (email + PIN). Log in with your GoodMarket wallet to use it.", "error");
            return Promise.resolve();
        }

        var btn = _el("dappConnectBtn");
        if (btn) { btn.disabled = true; btn.textContent = "⏳ Connecting…"; }
        _setConnectStatus("⏳ Connecting to the dApp…", "info");

        return _getClient().then(function (client) {
            return client.pair({ uri: uri });
        }).then(function () {
            _setConnectStatus("📲 Waiting for the dApp to send its connection request… Approve or Decline will appear here.", "info");
        }).catch(function (e) {
            _setConnectStatus("❌ Could not connect: " + (e && e.message ? e.message : e), "error");
        }).then(function () {
            if (btn) { btn.disabled = false; btn.textContent = "🔗 Connect this dApp"; }
        });
    }

    // ── proposal review ──────────────────────────────────────────────────

    // Reown AppKit (and most modern dApps) put everything under
    // `optionalNamespaces` with `requiredNamespaces: {}`. Reading only the
    // required map made every such proposal look empty -> Approve disabled.
    // Union both. Only the `eip155` namespace is ever considered; other
    // namespaces (bip122/tron/…) are simply ignored, not treated as invalid.
    function _nsUnion(proposal, field) {
        try {
            var out = [];
            ["optionalNamespaces", "requiredNamespaces"].forEach(function (which) {
                var ns = (proposal.params && proposal.params[which]) || {};
                var eip = ns.eip155 || {};
                (eip[field] || []).forEach(function (v) {
                    if (out.indexOf(v) < 0) out.push(v);
                });
            });
            return out;
        } catch (_) { return []; }
    }

    function _proposalChains(proposal) {
        return _nsUnion(proposal, "chains");
    }

    function _proposalMethods(proposal) {
        return _nsUnion(proposal, "methods");
    }

    // Chains/methods the dApp declared as REQUIRED. If any of these is one we
    // cannot do, the proposal must be blocked (the dApp made it mandatory).
    function _requiredChains(proposal) {
        try {
            var ns = (proposal.params && proposal.params.requiredNamespaces) || {};
            return ((ns.eip155 || {}).chains) || [];
        } catch (_) { return []; }
    }

    function _requiredMethods(proposal) {
        try {
            var ns = (proposal.params && proposal.params.requiredNamespaces) || {};
            return ((ns.eip155 || {}).methods) || [];
        } catch (_) { return []; }
    }

    function _methodSupported(m) {
        return ALLOWED_METHODS.indexOf(m) >= 0 ||
            READ_METHODS.indexOf(m) >= 0 ||
            WALLET_METHODS.indexOf(m) >= 0 ||
            BENIGN_WALLET_READS.indexOf(m) >= 0;
    }

    // The chains we can actually grant: what the dApp asked for (required OR
    // optional) intersected with our allowlist. Everything else is simply not
    // granted — that is what "optional" means in the WalletConnect spec.
    function _grantedChains(proposal) {
        return _proposalChains(proposal).filter(function (c) { return !!ALLOWED_CHAINS[c]; });
    }

    // Signing methods we will grant: only those the dApp actually asked for,
    // intersected with our signing allowlist. Never hand a dApp a signing
    // permission it did not request.
    function _grantedSigningMethods(proposal) {
        return _proposalMethods(proposal).filter(function (m) {
            return ALLOWED_METHODS.indexOf(m) >= 0;
        });
    }

    function _proposalSupported(proposal) {
        var grantedChains = _grantedChains(proposal);
        // A REQUIRED chain/method we cannot do still blocks — the dApp made it
        // mandatory, so a partial grant would be a broken session.
        var requiredOk = _requiredChains(proposal).every(function (c) { return !!ALLOWED_CHAINS[c]; }) &&
            _requiredMethods(proposal).every(_methodSupported);
        // Intersection must be non-empty: there has to be at least one chain we
        // can serve, otherwise there is nothing to approve.
        return requiredOk && grantedChains.length > 0;
    }

    function _proposalMeta(proposal) {
        try {
            var md = proposal.params.proposer.metadata || {};
            return { name: md.name || "Unknown dApp", url: md.url || "", icons: md.icons || [] };
        } catch (_) {
            return { name: "Unknown dApp", url: "", icons: [] };
        }
    }

    function _renderProposal(proposal) {
        var box = _el("dappProposalBox");
        if (!box) return;
        var meta = _proposalMeta(proposal);
        var allChains = _proposalChains(proposal);
        var granted = _grantedChains(proposal);
        var grantedNames = granted.map(function (c) {
            return (ALLOWED_CHAINS[c] && ALLOWED_CHAINS[c].label) || c;
        });
        var withheldNames = allChains.filter(function (c) { return !ALLOWED_CHAINS[c]; }).map(function (c) {
            return (ALLOWED_CHAINS[c] && ALLOWED_CHAINS[c].label) || c;
        });
        // Methods we will grant = the read/utility set we always grant plus the
        // signing methods the dApp asked for. This is what the session carries.
        var grantedMethods = _grantedSigningMethods(proposal);
        var ok = _proposalSupported(proposal);
        var overCap = sessions().length >= MAX_SESSIONS;
        if (overCap) ok = false;
        var iconUrl = (meta.icons && meta.icons[0]) || "";
        var safeIcon = /^https:\/\//i.test(iconUrl);

        box.innerHTML =
            '<div class="dapp-peer">' +
                (safeIcon ? '<img class="dapp-peer-icon" src="' + _esc(iconUrl) + '" alt="" onerror="this.style.display=\'none\'">' : '<div class="dapp-peer-icon dapp-peer-icon--ph">🔗</div>') +
                '<div>' +
                    '<div class="dapp-peer-name">' + _esc(meta.name) + '</div>' +
                    '<div class="dapp-peer-url">' + _esc(meta.url || "unknown origin") + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="dapp-req-row"><span>Chains</span><b>' + _esc(grantedNames.join(", ") || "—") + '</b></div>' +
            '<div class="dapp-req-row"><span>Methods</span><b>' + _esc(grantedMethods.join(", ") || "—") + '</b></div>' +
            (withheldNames.length
                ? '<div class="dapp-warn">ℹ️ This dApp also lists ' + _esc(withheldNames.join(", ")) + ', which GoodMarket does not support. Those will not be granted.</div>'
                : '') +
            (overCap
                ? '<div class="dapp-warn bad">🚫 You already have ' + sessions().length + ' connected dApps. Revoke one before connecting another.</div>'
                : (ok
                    ? '<div class="dapp-warn ok">✅ You will grant the chains and actions shown above.</div>'
                    : '<div class="dapp-warn bad">🚫 This dApp requires a chain or action GoodMarket does not support. Approving is disabled.</div>')) +
            '<div class="dapp-warn">⚠️ Only connect with dApps you trust. Approving gives this dApp permission to ask you to sign — you still approve every action individually.</div>';

        var approve = _el("dappApproveBtn");
        var reject = _el("dappRejectBtn");
        if (approve) {
            approve.disabled = !ok;
            approve.style.opacity = ok ? "" : "0.5";
            approve.style.cursor = ok ? "" : "not-allowed";
        }
        if (reject) reject.disabled = false;
        _setConnectStatus("", "");
    }

    function approveProposal() {
        var proposal = _state.pendingProposal;
        if (!proposal) return;
        if (!_proposalSupported(proposal)) {
            _setConnectStatus("This dApp requires a chain or action GoodMarket does not support.", "error");
            return;
        }
        _getClient().then(function (client) {
            return client.approve({
                id: proposal.id,
                namespaces: _buildNamespaces(proposal)
            });
        }).then(function () {
            _state.pendingProposal = null;
            _markUsed();
            if (_el("dappProposalBox")) _el("dappProposalBox").innerHTML = "";
            _setConnectStatus("✅ dApp connected.", "ok");
            _renderSessions();
            refreshStatusStrip();
        }).catch(function (e) {
            _setConnectStatus("❌ Could not approve: " + (e && e.message ? e.message : e), "error");
        });
    }

    // Build the approved namespaces, keeping only chains we support. The
    // SignClient needs at least one account per namespace in the form
    // eip155:<chainId>:<address>.
    function _buildNamespaces(proposal) {
        // Always advertise the basics a dApp cannot work without: account and
        // chain reads (silent), the read-only RPCs and the chain switch.
        var methods = SILENT_METHODS.concat(READ_METHODS, WALLET_METHODS, BENIGN_WALLET_READS);
        // Plus only the SIGNING methods the dApp actually asked for — never
        // hand a dApp a signing permission it did not request.
        _grantedSigningMethods(proposal).forEach(function (m) {
            if (methods.indexOf(m) < 0) methods.push(m);
        });

        var chains = _grantedChains(proposal);
        var accounts = [];
        chains.forEach(function (c) {
            accounts.push(c + ":" + _walletAddr());
        });
        return {
            eip155: {
                chains: chains,
                methods: methods,
                events: ["chainChanged", "accountsChanged"],
                accounts: accounts
            }
        };
    }

    function rejectProposal() {
        var proposal = _state.pendingProposal;
        if (!proposal) return;
        _getClient().then(function (client) {
            return client.reject({ id: proposal.id, reason: { code: 4001, message: "User rejected." } });
        }).catch(function () {}).then(function () {
            _state.pendingProposal = null;
            _el("dappProposalBox").innerHTML = "";
            _renderSessions();
            _setConnectStatus("Connection request declined.", "info");
        });
    }

    // ── session_request handling ─────────────────────────────────────────

    function _chainIdFromEvent(event) {
        // event.params.chainId is "eip155:<id>"
        return String((event.params && event.params.chainId) || "");
    }

    // Close the approval sheet if it belongs to a session that just went away.
    function _clearRequestForTopic(topic) {
        var pending = _state.pendingRequest;
        if (!pending) return;
        var evTopic = pending.event && pending.event.topic;
        if (topic && evTopic && topic !== evTopic) return;
        _state.pendingRequest = null;
        var box = _el("dappRequestBody");
        if (box) box.innerHTML = "";
        var modal = _el("dappRequestModal");
        if (modal && modal.classList.contains("open") && typeof global.closeModal === "function") {
            global.closeModal("dappRequestModal");
        }
    }

    function _handleSessionRequest(event) {
        var method = event.params && event.params.request && event.params.request.method;
        var chainId = _chainIdFromEvent(event);

        // A request for a session we no longer hold (the dApp disconnected us
        // but re-sent, or the relay delivered a stale request). Reject it
        // instead of opening an approval sheet for a dead session.
        if (event.topic && _state.client && _state.client.session.keys &&
            _state.client.session.keys.indexOf(event.topic) < 0) {
            _respond(event, null, { code: 4100, message: "Session no longer exists." });
            return;
        }

        // Chain not allowed? Reject immediately — never sign.
        if (!ALLOWED_CHAINS[chainId]) {
            _respond(event, null, { code: 4200, message: "Unsupported chain: " + chainId });
            return;
        }

        if (SILENT_METHODS.indexOf(method) >= 0) {
            _answerSilently(event, method);
            return;
        }

        if (READ_METHODS.indexOf(method) >= 0) {
            _forwardRead(event, chainId, method);
            return;
        }

        if (WALLET_METHODS.indexOf(method) >= 0) {
            _answerWalletMethod(event, method);
            return;
        }

        // Benign read-only wallet methods a dApp may call after connecting.
        // They never touch the key and never move funds, so we answer them
        // without an approval prompt (a dApp that gets an error here often
        // reports the wallet as broken).
        if (BENIGN_WALLET_READS.indexOf(method) >= 0) {
            _answerBenignWalletRead(event, method);
            return;
        }

        if (ALLOWED_METHODS.indexOf(method) < 0) {
            _respond(event, null, { code: 4200, message: "Unsupported method: " + method });
            _toast("🚫 The dApp asked for an unsupported action (“" + method + "”) — declined automatically.");
            return;
        }

        _state.pendingRequest = { event: event, chainId: chainId, method: method };
        _renderRequest(event, chainId, method);
        _openModal("dappRequestModal");
    }

    function _answerSilently(event, method) {
        var result;
        if (method === "eth_accounts") {
            result = [_walletAddr()];
        } else {
            result = ALLOWED_CHAINS[_chainIdFromEvent(event)].hex;
        }
        _respond(event, result, null);
    }

    // Read-only: hand it to the in-app wallet, which routes eth_call /
    // eth_getBalance / … to the chain's public RPC (see local-wallet.js
    // _chainJsonRpc). The active-chain pointer is moved to the dApp's chain
    // first so a read never lands on the wrong network. Nothing is signed.
    function _forwardRead(event, chainId, method) {
        var provider = global.GMLocalWallet && global.GMLocalWallet.getProvider
            ? global.GMLocalWallet.getProvider() : null;
        if (!provider) {
            _respond(event, null, { code: 4900, message: "Wallet unavailable." });
            return;
        }
        var hex = ALLOWED_CHAINS[chainId].hex;
        Promise.resolve()
            .then(function () {
                return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
            })
            .then(function () { return provider.request({ method: method, params: (event.params.request.params) || [] }); })
            .then(function (result) { _respond(event, result, null); })
            .catch(function (e) {
                _respond(event, null, { code: -32603, message: (e && e.message) || "Read failed." });
            });
    }

    // Read-only WALLET namespace methods. We return the facts a dApp needs and
    // nothing more; the wallet address is already known to the session.
    function _answerBenignWalletRead(event, method) {
        var result = null;
        if (method === "wallet_getPermissions") {
            result = [{ parentCapability: "eth_accounts" }];
        } else if (method === "wallet_getCapabilities") {
            result = {};
        } else if (method === "wallet_getCallsStatus") {
            result = { status: 100 };  // EIP-5792: 100 = "not found / no such batch"
        } else if (method === "wallet_getAssets") {
            result = [];
        }
        _respond(event, result, null);
    }

    // wallet_switchEthereumChain / wallet_addEthereumChain. The in-app wallet
    // only knows Celo / XDC / Base (and, for signing, Ethereum), so a supported
    // chain moves its pointer and anything else is refused.
    function _answerWalletMethod(event, method) {
        var params = (event.params.request.params) || [];
        var wanted = params[0] && params[0].chainId;
        var key = _chainKeyForId(wanted);
        // EIP-3326/3085: 4902 means "we don't know this chain". The in-app
        // wallet only holds Celo / XDC / Base, so everything else is refused.
        if (!key || !ALLOWED_CHAINS[key]) {
            _respond(event, null, { code: 4902, message: "Unrecognized chain ID " + wanted + "." });
            return;
        }
        var provider = global.GMLocalWallet && global.GMLocalWallet.getProvider
            ? global.GMLocalWallet.getProvider() : null;
        if (!provider) {
            _respond(event, null, { code: 4900, message: "Wallet unavailable." });
            return;
        }
        Promise.resolve()
            .then(function () { return provider.request({ method: method, params: params }); })
            .then(function (result) { _respond(event, result === undefined ? null : result, null); })
            .catch(function (e) {
                _respond(event, null, { code: -32603, message: (e && e.message) || "Chain switch failed." });
            });
    }

    function _chainKeyForId(chainId) {
        var s = String(chainId == null ? "" : chainId).toLowerCase();
        if (!s) return null;
        if (s.indexOf("0x") === 0) {
            var n = parseInt(s, 16);
            return "eip155:" + n;
        }
        return "eip155:" + parseInt(s, 10);
    }

    function _sessionFor(event) {
        if (!_state.client) return null;
        try {
            var sessions = _state.client.session.getAll();
            var topic = event.topic;
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].topic === topic) return sessions[i];
            }
        } catch (_) {}
        return null;
    }

    function _peerMetaFor(event) {
        var s = _sessionFor(event);
        var md = s && s.peer && s.peer.metadata;
        return { name: (md && md.name) || "dApp", url: (md && md.url) || "" };
    }

    function _renderRequest(event, chainId, method) {
        var box = _el("dappRequestBody");
        if (!box) return;
        var meta = _peerMetaFor(event);
        var params = (event.params.request.params) || [];
        var rows = "";

        function row(label, value) {
            return '<div class="dapp-req-row"><span>' + _esc(label) + '</span><b>' + _esc(value) + '</b></div>';
        }

        rows += row("dApp", meta.name);
        if (meta.url) rows += row("Origin", meta.url);
        rows += row("Chain", (ALLOWED_CHAINS[chainId] && ALLOWED_CHAINS[chainId].label) || chainId);
        rows += row("Action", _friendlyMethod(method));

        var mismatch = "";
        if (method === "eth_sendTransaction" && params[0]) {
            var tx = params[0];
            if (tx.to) rows += row("To", tx.to);
            if (tx.value) rows += row("Value", _formatNative(tx.value, chainId));
            if (tx.data && tx.data !== "0x") rows += row("Data", _shortData(tx.data));
            // The in-app wallet always signs with its own key, so a `from` that
            // points elsewhere is either a dApp bug or an attempt to confuse
            // the user about whose funds move.
            if (tx.from && _walletAddr() && String(tx.from).toLowerCase() !== _walletAddr().toLowerCase()) {
                mismatch = '<div class="dapp-warn bad">🚫 This request is for a DIFFERENT address (' +
                    _esc(_shortAddr(tx.from)) + '). Your in-app wallet signs only for ' +
                    _esc(_shortAddr(_walletAddr())) + '. Decline it.</div>';
            }
        } else if (method === "personal_sign") {
            rows += row("Message", _decodePersonalSign(params));
        } else if (method.indexOf("eth_signTypedData") === 0) {
            var typed = params[1];
            try {
                var parsed = typeof typed === "string" ? JSON.parse(typed) : typed;
                rows += row("Typed data", (parsed && parsed.primaryType) || "EIP-712");
            } catch (_) {
                rows += row("Typed data", "EIP-712");
            }
        }

        box.innerHTML =
            '<div class="dapp-warn">🔎 Review carefully. GoodMarket will sign this on your in-app wallet only after you approve.</div>' +
            mismatch + rows +
            '<div class="dapp-warn">⚠️ If you did not expect this request, tap Decline.</div>';
    }

    // Show wei as a human-readable native amount when the value is plausible.
    function _formatNative(value, chainId) {
        var raw = String(value == null ? "" : value).trim();
        var wei;
        try { wei = BigInt(raw); } catch (_) { return raw + " wei"; }
        var whole = wei / 1000000000000000000n;
        var frac = (wei % 1000000000000000000n).toString().padStart(18, "0").replace(/0+$/, "");
        var symbol = chainId === "eip155:50" ? "XDC" : "CELO";
        var shown = frac ? (whole + "." + frac) : whole.toString();
        return shown + " " + symbol + " (" + raw + " wei)";
    }

    function _friendlyMethod(method) {
        var map = {
            personal_sign: "Sign a message",
            eth_signTypedData: "Sign typed data",
            eth_signTypedData_v3: "Sign typed data (v3)",
            eth_signTypedData_v4: "Sign typed data (v4)",
            eth_sendTransaction: "Send a transaction"
        };
        return map[method] || method;
    }

    function _shortData(data) {
        var s = String(data || "");
        return s.length > 74 ? (s.slice(0, 40) + "…" + s.slice(-14)) : s;
    }

    function _decodePersonalSign(params) {
        // Message is params[0]; it may be hex-encoded.
        var msg = params[0];
        if (typeof msg === "string" && msg.indexOf("0x") === 0) {
            try {
                var hex = msg.slice(2);
                var bytes = [];
                for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
                var text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
                if (/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(text)) {
                    return text.length > 200 ? text.slice(0, 200) + "…" : text;
                }
            } catch (_) {}
        }
        return String(msg);
    }

    function _respond(event, result, error) {
        _getClient().then(function (client) {
            return client.respond({
                topic: event.topic,
                response: {
                    id: event.id,
                    jsonrpc: "2.0",
                    result: error ? undefined : result,
                    error: error || undefined
                }
            });
        }).catch(function (e) {
            _log("[dapp-connect] respond failed:", e && e.message);
        });
    }

    // ── request approval (local signing) ─────────────────────────────────

    function approveRequest() {
        var pending = _state.pendingRequest;
        if (!pending) return;
        var event = pending.event;
        var method = pending.method;
        var params = (event.params.request.params) || [];

        if (!isEligible()) {
            _respond(event, null, { code: 4001, message: "Signing is not available for this login method." });
            _closeRequestSheet();
            return;
        }

        var btn = _el("dappApproveReqBtn");
        if (btn) { btn.disabled = true; btn.textContent = "Signing…"; }

        // Make sure the in-app wallet is unlocked (PIN) before signing.
        var unlock = (global.GMLocalWallet.isUnlocked && global.GMLocalWallet.isUnlocked())
            ? Promise.resolve()
            : (typeof global._lwUnlockIfNeeded === "function" ? global._lwUnlockIfNeeded() : Promise.resolve());

        unlock.then(function () {
            var provider = global.GMLocalWallet.getProvider();
            return provider.request({ method: method, params: params });
        }).then(function (result) {
            _respond(event, result, null);
            _toast("✅ Signed for " + _peerMetaFor(event).name + ".");
        }).catch(function (e) {
            var code = (e && (e.code === 4001 || /reject|cancel|denied/i.test(e.message || ""))) ? 4001 : -32603;
            _respond(event, null, { code: code, message: (e && e.message) || "Request failed." });
            if (code !== 4001) {
                _toast("❌ Could not sign: " + ((e && e.message) || e));
            }
        }).then(function () {
            if (btn) { btn.disabled = false; btn.textContent = "Approve & Sign"; }
            _closeRequestSheet();
        });
    }

    function rejectRequest() {
        var pending = _state.pendingRequest;
        if (!pending) return;
        _respond(pending.event, null, { code: 4001, message: "User rejected." });
        _closeRequestSheet();
    }

    function _closeRequestSheet() {
        _state.pendingRequest = null;
        _closeModal("dappRequestModal");
        var body = _el("dappRequestBody");
        if (body) body.innerHTML = "";
    }

    // ── sessions list + revoke ───────────────────────────────────────────

    function sessions() {
        if (!_state.client) return [];
        try {
            return _state.client.session.getAll() || [];
        } catch (_) { return []; }
    }

    // ── view state ───────────────────────────────────────────────────────
    // The modal shows exactly ONE of three views so nothing important ever
    // falls below the fold on mobile:
    //   • REVIEW  — a dApp is asking to connect (proposal + Approve/Decline,
    //               right under the title; the paste form is hidden).
    //   • CONNECT — nothing connected yet: paste a WalletConnect link.
    //   • SESSIONS— at least one dApp connected: the list + "Connect another".
    // Previously all of these were stacked at once, so the Approve/Decline
    // buttons sat below the paste form + session list and users had to scroll
    // (and the Connect button appeared to "still be there" during review).
    function _setDisp(id, show) {
        var el = _el(id);
        if (el) el.style.display = show ? "" : "none";
    }

    function _applyView() {
        var reviewing = !!_state.pendingProposal;
        var hasSessions = sessions().length > 0;
        // Show the paste form when nothing is connected, OR when the user
        // explicitly asked for it via "Connect another dApp".
        var showForm = !reviewing && (!hasSessions || _state.connectFormForced);
        _setDisp("dappConnectForm", showForm);
        _setDisp("dappSessionsWrap", !reviewing);
        _setDisp("dappConnectAgainBtn", !reviewing && hasSessions && !_state.connectFormForced);
        _setDisp("dappProposalActions", reviewing);
    }

    function startNewConnection() {
        // Re-open the paste-a-link form (used by "Connect another dApp").
        var input = _el("dappUriInput");
        if (input) input.value = "";
        _setConnectStatus("", "");
        _state.pendingProposal = null;
        _state.connectFormForced = true;
        _applyView();
        _scrollSheetTop();
        if (input && input.focus) { try { input.focus(); } catch (_) {} }
    }

    function _scrollSheetTop() {
        var modal = _el("dappConnectModal");
        if (!modal || typeof modal.querySelector !== "function") return;
        var sheet = modal.querySelector(".modal-sheet");
        if (!sheet) return;
        if (typeof sheet.scrollTo === "function") { try { sheet.scrollTo({ top: 0, behavior: "smooth" }); } catch (_) { sheet.scrollTop = 0; } }
        else { sheet.scrollTop = 0; }
    }

    function _renderSessions() {
        var list = _el("dappSessionList");
        var all = sessions();
        // Keep the whole-modal view state in sync (hides the paste form while a
        // proposal is being reviewed, hides the list + shows the escape hatch
        // once something is connected).
        _applyView();
        if (!list) return;
        if (!all.length) {
            list.innerHTML = '<div class="dapp-empty">No dApps connected yet.</div>';
            return;
        }
        list.innerHTML = all.map(function (s) {
            var md = (s.peer && s.peer.metadata) || {};
            var topic = _esc(s.topic);
            return '<div class="dapp-session">' +
                '<div class="dapp-session-meta">' +
                    '<div class="dapp-session-name">🔗 ' + _esc(md.name || "dApp") + '</div>' +
                    '<div class="dapp-session-url">' + _esc(md.url || "") + '</div>' +
                '</div>' +
                '<button type="button" class="dapp-revoke-btn" onclick="GMDappConnect.revoke(\'' + topic + '\')">Revoke</button>' +
            '</div>';
        }).join("");
    }

    function revoke(topic) {
        var md = null;
        try {
            var s = _state.client && _state.client.session.get(topic);
            md = (s && s.peer && s.peer.metadata) || null;
        } catch (_) {}
        var name = (md && md.name) || "the dApp";
        _setConnectStatus("⏳ Disconnecting " + name + "…", "info");
        return _disconnectSession(topic, "User revoked the session.", 1).then(function (res) {
            _renderSessions();
            refreshStatusStrip();
            if (res && res.delivered) {
                _setConnectStatus("✅ Disconnected " + name + ". It will no longer see your wallet.", "ok");
            } else {
                // The local session is gone, but the notice may not have
                // reached the dApp — the exact "still connected there"
                // confusion. Tell the user honestly and how to clear it.
                _setConnectStatus(
                    "⚠️ Removed " + name + " from GoodMarket, but the notice could not reach it " +
                    "(relay offline). The dApp may still show your wallet as connected. Reopen the dApp " +
                    "and use its own \u201cDisconnect\u201d, or try Revoke again when you are back online.",
                    "warn");
            }
            return res;
        });
    }

    function revokeAll() {
        var all = sessions();
        all.forEach(function (s) { revoke(s.topic); });
    }

    // A session's account is bound to the wallet that approved it. SignClient
    // persists sessions in localStorage, so after a logout + login as a
    // DIFFERENT wallet the old sessions would still be live and a dApp could
    // ask the new account to sign for them. Drop anything that does not match
    // the current session wallet.
    function _dropForeignSessions() {
        if (!_walletAddr()) return;
        sessions().forEach(function (s) {
            var accts = (s.namespaces && s.namespaces.eip155 && s.namespaces.eip155.accounts) || [];
            var mine = accts.some(function (a) {
                return String(a).toLowerCase().indexOf(_walletAddr().toLowerCase()) >= 0;
            });
            if (!mine) {
                _log("[dapp-connect] dropping session bound to another wallet:", s.topic);
                revoke(s.topic);
            }
        });
    }

    // Logout is a plain <a href="/logout"> full-page navigation, so the SDK's
    // persisted sessions would outlive the session. Disconnect them first, then
    // let the navigation continue (capped, so a dead relay can't block logout).
    function _disconnectAllThen(done) {
        var all = sessions();
        if (!all.length) { done(); return; }
        var pending = all.map(function (s) {
            return _getClient()
                .then(function (client) {
                    // Open the socket first so the delete notice is actually
                    // delivered to each dApp before we drop the session.
                    return _ensureRelayer(client, 1500).then(function () { return client; });
                })
                .then(function (client) {
                    return client.disconnect({
                        topic: s.topic,
                        reason: _disconnectReason("User logged out.")
                    });
                })
                .catch(function () {});
        });
        var finished = false;
        var go = function () { if (!finished) { finished = true; done(); } };
        Promise.all(pending).then(go, go);
        setTimeout(go, 1500);
    }

    function _wireLogout() {
        if (!global.document || !global.document.addEventListener) return;
        global.document.addEventListener("click", function (ev) {
            var node = ev.target;
            while (node && node.tagName !== "A") node = node.parentNode;
            if (!node || !node.getAttribute) return;
            var href = node.getAttribute("href") || "";
            if (href.indexOf("/logout") !== 0) return;
            if (!sessions().length) return;
            ev.preventDefault();
            _disconnectAllThen(function () { global.location.href = href; });
        }, true);
    }

    // ── wallet-page status strip ─────────────────────────────────────────

    function refreshStatusStrip() {
        var strip = _el("dappConnectStrip");
        if (!strip) return;
        var all = sessions();
        if (!all.length) {
            strip.classList.remove("show");
            return;
        }
        var first = all[0];
        var md = (first.peer && first.peer.metadata) || {};
        var name = md.name || "dApp";
        var who = all.length === 1 ? name : (name + " +" + (all.length - 1) + " more");
        var label = _el("dappStripLabel");
        if (label) {
            // Only warn on the SDK's own definite "closed" flag — guessing
            // from a missing `connected` property would false-warn on healthy
            // sessions. The reliable signal is the revoke() result itself.
            label.textContent = "🔗 " + all.length + " dApp" + (all.length > 1 ? "s" : "") + " connected — " + who +
                (_relayerExplicitlyClosed() ? " · ⚠️ relay offline (revoke may not reach the dApp)" : "");
        }
        strip.classList.add("show");
    }

    function _toast(msg) {
        try {
            if (typeof global.showToast === "function") { global.showToast(msg); return; }
        } catch (_) {}
        var el = _el("dappToast");
        if (!el) return;
        el.textContent = msg;
        el.classList.add("show");
        setTimeout(function () { el.classList.remove("show"); }, 4000);
    }

    global.GMDappConnect = {
        init: init,
        isEligible: isEligible,
        open: open,
        close: close,
        connectFromLink: connectFromLink,
        approveProposal: approveProposal,
        startNewConnection: startNewConnection,
        rejectProposal: rejectProposal,
        approveRequest: approveRequest,
        rejectRequest: rejectRequest,
        revoke: revoke,
        revokeAll: revokeAll,
        sessions: sessions,
        refreshStatusStrip: refreshStatusStrip,
        _dropForeignSessions: _dropForeignSessions,
        _ensureRelayer: _ensureRelayer,
        _relayerOpen: _relayerOpen,
        _disconnectSession: _disconnectSession
    };

    // Auto-boot on load ONLY if the user has connected a dApp before (we
    // stamp a flag on a successful connect). Otherwise the SignClient — SDK
    // download + relay websocket — would load on every wallet visit for a
    // feature most users never open; instead it boots lazily on first open().
    var USED_KEY = "gm_dapp_connect_used_v1";
    function _hasUsedBefore() {
        try { return localStorage.getItem(USED_KEY) === "1"; } catch (_) { return false; }
    }
    function _markUsed() {
        try { localStorage.setItem(USED_KEY, "1"); } catch (_) {}
    }

    if (global.document) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () { if (_hasUsedBefore()) init(); });
        } else if (_hasUsedBefore()) {
            init();
        }
    }
})(typeof window !== "undefined" ? window : this);
