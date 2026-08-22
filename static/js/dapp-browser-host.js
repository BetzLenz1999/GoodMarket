/**
 * GMDappHost — host-side hub for the GoodMarket in-app dApp browser.
 *
 * Loaded on the wallet page (the page the native shell's main WebView is
 * pointed at). Receives EIP-1193 requests ferried in by
 * dapp-browser-bridge.js — either via the native relay (the shell calls
 * window.GMDappHost.nativeHandle(id, method, paramsJson)) or from a
 * same-origin iframe (postMessage) — and executes them through
 * GMLocalWallet.getProvider(), so:
 *
 *   - read-only calls flow straight to the Celo RPC,
 *   - wallet-scoped calls unlock the PIN modal (_lwOpenUnlockModal) and
 *     sign locally in the browser — the key never leaves this context,
 *   - the chain is hard-pinned to Celo 42220 by GMLocalWallet itself.
 *
 * Results are handed back through window.__gmHostReply(id, ok, json), a
 * hook the native shell installs; iframe callers get a postMessage reply.
 */
(function () {
    'use strict';

    // Methods that need the unlocked wallet (PIN prompt if locked).
    var _SIGNING_METHODS = [
        'eth_requestAccounts',
        'eth_sendTransaction',
        'personal_sign',
        'eth_sign',
        'eth_signTypedData',
        'eth_signTypedData_v3',
        'eth_signTypedData_v4'
    ];

    function _walletReady() {
        return !!(window.GMLocalWallet &&
                  typeof GMLocalWallet.getProvider === 'function');
    }

    function _activeAddress() {
        try {
            return _walletReady() && GMLocalWallet.getActiveAddress
                ? GMLocalWallet.getActiveAddress() : null;
        } catch (e) {
            return null;
        }
    }

    function _needsUnlock(method) {
        return _SIGNING_METHODS.indexOf(method) !== -1 && !_activeAddress();
    }

    async function _handleRequest(method, params) {
        if (!_walletReady()) {
            throw new Error(
                'Log in to your GoodMarket in-app wallet first.');
        }
        // Passive account probe: MetaMask semantics return [] when locked —
        // do NOT pop the PIN modal for a page merely checking connection.
        if (method === 'eth_accounts') {
            var addr = _activeAddress();
            return addr ? [addr] : [];
        }
        if (_needsUnlock(method)) {
            if (typeof window._lwOpenUnlockModal !== 'function') {
                throw new Error('Wallet is locked — unlock it in the app first.');
            }
            await window._lwOpenUnlockModal();
        }
        return GMLocalWallet.getProvider()
            .request({ method: method, params: params || [] });
    }

    // Native-shell PIN unlock: the host WebView sits BEHIND the dApp
    // browser screen, so its DOM modal would be invisible. The shell marks
    // itself with window.__gmNativeUnlock and handles the PIN dialog
    // natively, then funnels the PIN back through nativeUnlockAndRetry.
    // Key material still never leaves this JS context.
    async function _nativeUnlock(pin) {
        if (!_walletReady()) {
            throw new Error('No GoodMarket wallet on this device.');
        }
        var saved = GMLocalWallet.getLocalKeystore
            ? GMLocalWallet.getLocalKeystore() : null;
        if (!saved || !saved.keystore) {
            // TODO(production): fall back to the server keystore fetch, the
            // same way _lwOpenUnlockModal does, for fresh devices.
            throw new Error('No wallet found on this device. Log in with your email first.');
        }
        await GMLocalWallet.unlockWithKeystore(saved.keystore, pin);
        pushEvent('accountsChanged', [GMLocalWallet.getActiveAddress()]);
    }

    function _envelope(err) {
        return {
            message: (err && err.message) || 'Request failed',
            code: err && err.code,
            data: err && err.data
        };
    }

    // ── Native-shell entry point ──────────────────────────────────────────
    // The Android/iOS shell runs:
    //   evaluateJavascript("GMDappHost.nativeHandle(<id>, '<method>', '<paramsJson>')")
    // and receives the outcome through its installed __gmHostReply hook.
    function nativeHandle(id, method, paramsJson) {
        var params;
        try { params = paramsJson ? JSON.parse(paramsJson) : []; }
        catch (e) { params = []; }
        // Native shell present but wallet locked: the DOM modal would be
        // invisible behind the dApp screen, so hand the prompt to the shell.
        if (window.__gmNativeUnlock && _needsUnlock(method)) {
            _replyNative(id, false, {
                error: { code: 'GM_NEEDS_UNLOCK', message: 'PIN required' }
            });
            return;
        }
        _handleRequest(method, params).then(function (result) {
            _replyNative(id, true, { result: result === undefined ? null : result });
        }).catch(function (err) {
            _replyNative(id, false, { error: _envelope(err) });
        });
    }

    // Shell retries the pending request after collecting the PIN natively.
    function nativeUnlockAndRetry(id, method, paramsJson, pin) {
        _nativeUnlock(pin)
            .then(function () { nativeHandle(id, method, paramsJson); })
            .catch(function (err) {
                _replyNative(id, false, { error: _envelope(err) });
            });
    }

    function _replyNative(id, ok, payload) {
        if (typeof window.__gmHostReply === 'function') {
            window.__gmHostReply(id, ok, JSON.stringify(payload));
        }
    }

    // Event relay (accountsChanged / chainChanged): the native shell maps
    // this onto __gmBridgeEvent() inside the dApp WebView.
    function pushEvent(name, payload) {
        if (typeof window.__gmHostEvent === 'function') {
            try { window.__gmHostEvent(name, JSON.stringify(payload)); }
            catch (e) { /* shell not listening — drop */ }
        }
    }

    // ── Same-origin iframe entry point ────────────────────────────────────
    window.addEventListener('message', function (event) {
        // frame-src is 'self' and the bridge's postMessage transport only
        // targets window.location.origin — refuse anything cross-origin.
        if (event.origin !== window.location.origin) return;
        var data = event.data;
        if (!data || !data.gmDappBridge || data.id === undefined ||
            typeof data.method !== 'string' || !event.source) return;
        var id = data.id;
        _handleRequest(data.method, data.params).then(function (result) {
            event.source.postMessage({
                gmDappBridge: true, id: id, ok: true,
                result: result === undefined ? null : result
            }, event.origin);
        }).catch(function (err) {
            event.source.postMessage({
                gmDappBridge: true, id: id, ok: false,
                error: _envelope(err)
            }, event.origin);
        });
    });

    window.GMDappHost = {
        nativeHandle: nativeHandle,
        nativeUnlockAndRetry: nativeUnlockAndRetry,
        pushEvent: pushEvent,
        handleRequest: _handleRequest
    };
})();
