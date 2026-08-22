/**
 * GMDappBridge — EIP-1193 provider payload injected INTO dApp pages.
 *
 * This is the "shop window" half of the GoodMarket in-app dApp browser:
 * the native shell (Capacitor WebView, see mobile/) injects this script
 * into every dApp page it loads (e.g. claim.superfluid.org). The page then
 * sees a normal `window.ethereum` exactly as if MetaMask were installed —
 * but every wallet-scoped call is ferried to the GoodMarket host context,
 * where GMLocalWallet signs locally after the PIN modal.
 *
 * Transport priority:
 *   1. window.__gmBridgeNative.request(id, json)
 *      — Android @JavascriptInterface installed by DappBrowserActivity.
 *   2. Capacitor plugin: Capacitor.Plugins.GmWalletBridge.requestEthereum()
 *      — for a fully-packaged Capacitor plugin (future iOS path).
 *   3. postMessage to window.parent
 *      — same-origin iframe embedding fallback (see dapp-browser-host.js).
 *
 * Results come back through evaluateJavascript:
 *   window.__gmBridgeResolve(id, ok, payloadJson)
 * Events (accountsChanged/chainChanged) arrive via:
 *   window.__gmBridgeEvent(name, payloadJson)
 *
 * The provider always reports Celo chainId through the HOST (GMLocalWallet
 * is hard-pinned to 42220) — this script is a dumb ferry, no chain logic.
 */
(function () {
    'use strict';

    if (window.__gmDappBridgeInjected) return;
    window.__gmDappBridgeInjected = true;

    var _nextId = 1;
    var _pending = {};       // id -> {resolve, reject}
    var _listeners = {};     // eventName -> [fn, ...]

    function _transport() {
        if (window.__gmBridgeNative &&
            typeof window.__gmBridgeNative.request === 'function') {
            return 'native-interface';
        }
        if (window.Capacitor && window.Capacitor.Plugins &&
            window.Capacitor.Plugins.GmWalletBridge) {
            return 'capacitor';
        }
        if (window.parent !== window) return 'postmessage';
        return null;
    }

    function _send(method, params) {
        return new Promise(function (resolve, reject) {
            var transport = _transport();
            if (!transport) {
                reject(new Error(
                    'GoodMarket dApp bridge: no host transport on this page.'));
                return;
            }
            var id = _nextId++;
            _pending[id] = { resolve: resolve, reject: reject };
            var payload = {
                gmDappBridge: true,
                id: id,
                method: method,
                params: params || []
            };
            if (transport === 'native-interface') {
                window.__gmBridgeNative.request(id, JSON.stringify(payload));
            } else if (transport === 'capacitor') {
                window.Capacitor.Plugins.GmWalletBridge
                    .requestEthereum(payload)
                    .then(function (res) {
                        if (_pending[id]) {
                            delete _pending[id];
                            resolve(res && res.result !== undefined ? res.result : null);
                        }
                    })
                    .catch(function (err) {
                        if (_pending[id]) {
                            delete _pending[id];
                            reject(err);
                        }
                    });
            } else {
                // Same-origin iframe only — the host validates origin before
                // answering, and rejects anything else.
                window.parent.postMessage(payload, window.location.origin);
            }
        });
    }

    // ── Resolution entry points (called by the native layer / host) ────────

    window.__gmBridgeResolve = function (id, ok, payloadJson) {
        var slot = _pending[id];
        if (!slot) return;
        delete _pending[id];
        var payload;
        try {
            payload = payloadJson ? JSON.parse(payloadJson) : {};
        } catch (e) {
            payload = { error: { message: 'Malformed bridge reply' } };
        }
        if (ok) {
            slot.resolve(payload.result !== undefined ? payload.result : null);
            return;
        }
        var info = payload.error || {};
        var err = new Error(info.message || 'Bridge request failed');
        if (info.code !== undefined) err.code = info.code;
        if (info.data !== undefined) err.data = info.data; // revert bytes pass through
        slot.reject(err);
    };

    window.__gmBridgeEvent = function (name, payloadJson) {
        var payload;
        try { payload = payloadJson ? JSON.parse(payloadJson) : null; }
        catch (e) { payload = null; }
        (_listeners[name] || []).slice().forEach(function (fn) {
            try { fn(payload); } catch (e) { /* listener errors stay local */ }
        });
    };

    // Iframe fallback: host answers with a postMessage of the same shape.
    if (window.parent !== window) {
        window.addEventListener('message', function (event) {
            var data = event.data;
            if (!data || !data.gmDappBridge) return;
            if (data.event) {
                window.__gmBridgeEvent(data.event, JSON.stringify(data.payload));
            } else if (data.id !== undefined) {
                window.__gmBridgeResolve(data.id, !!data.ok, JSON.stringify({
                    result: data.result,
                    error: data.error
                }));
            }
        });
    }

    // ── EIP-1193 provider surface ─────────────────────────────────────────

    var provider = {
        isGoodMarket: true,
        // Many dApp SDKs refuse to connect unless isMetaMask is truthy; we
        // are deliberately the injected signer on these pages, so mimic it.
        isMetaMask: true,
        request: function (args) {
            if (!args || typeof args.method !== 'string') {
                return Promise.reject(new Error('Invalid EIP-1193 request.'));
            }
            return _send(args.method, args.params);
        },
        on: function (name, fn) {
            if (typeof fn !== 'function') return provider;
            (_listeners[name] = _listeners[name] || []).push(fn);
            return provider;
        },
        removeListener: function (name, fn) {
            var list = _listeners[name] || [];
            var idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
            return provider;
        }
    };

    // ── EIP-6963 multi-provider discovery ─────────────────────────────────

    var _info = Object.freeze({
        uuid: 'goodmarket-dapp-bridge-v1',
        name: 'GoodMarket Wallet',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ' +
              'viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" ' +
              'fill="%23f97316"/><text x="16" y="21" font-size="14" ' +
              'text-anchor="middle" fill="white">G$</text></svg>',
        rdns: 'com.goodmarket.wallet'
    });

    function _announce() {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: _info, provider: provider })
        }));
    }
    window.addEventListener('eip6963:requestProvider', _announce);

    // Deliberately overwrite — on dApp pages inside our own browser we ARE
    // the signer; a stale extension value would sign with the wrong account.
    window.ethereum = provider;
    _announce();
})();
