/**
 * GMLocalWallet — self-custodial browser wallet for GoodMarket users.
 *
 * A real Celo wallet (private key + BIP-39 mnemonic) is generated in the
 * browser with ethers.js. The raw key and the user's PIN NEVER leave the
 * device: only the address and the scrypt-encrypted keystore (ethers V3
 * JSON) are sent to the server so the account survives phone loss — the
 * user re-downloads the keystore on a new device and unlocks with the PIN.
 *
 * Exposes window.GMLocalWallet with:
 *   create({email, pin})              -> {address, keystore, mnemonic}
 *   decrypt(keystore, pin)            -> wallet (throws on wrong PIN)
 *   unlockWithKeystore(keystore, pin) -> activates the session wallet
 *   loginSignature(message)           -> personal_sign with active wallet
 *   getActiveAddress()                -> checksummed address or null
 *   exportMnemonic(pin)               -> 12 words after PIN re-auth
 *   lock()                            -> zero out decrypted key material
 *   getProvider()                     -> EIP-1193-style provider for the
 *                                        signer chain (signs locally, reads
 *                                        go straight to the Celo RPC)
 *
 * localStorage keeps the keystore for fast same-device unlocks. It is NOT
 * the source of truth — the server copy is.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'gm_local_keystore_v1';

    // Canonical keystore form: parsed + re-serialized with sorted keys. The
    // server fingerprints this exact form for the login signature message, so
    // localStorage must keep the canonical string rather than whatever byte
    // layout ethers produced at creation time.
    function _canonicalizeKeystore(ks) {
        var obj = typeof ks === 'string' ? JSON.parse(ks) : ks;
        return JSON.stringify(_sortKeys(obj));
    }

    function _sortKeys(value) {
        if (Array.isArray(value)) return value.map(_sortKeys);
        if (value && typeof value === 'object') {
            var out = {};
            Object.keys(value).sort().forEach(function (k) { out[k] = _sortKeys(value[k]); });
            return out;
        }
        return value;
    }

    var CELO_RPC_URLS = [
        'https://forno.celo.org',
        'https://rpc.ankr.com/celo',
        'https://celo-mainnet.public.blastapi.io'
    ];
    var CELO_CHAIN_ID = 42220;

    var _activeWallet = null;   // ethers.Wallet while unlocked (memory only)
    var _unlockTimer = null;
    var AUTO_LOCK_MS = 15 * 60 * 1000; // decrypted key lives 15 min max

    function _assertEthers() {
        if (typeof ethers === 'undefined') {
            throw new Error('ethers.js is not loaded on this page.');
        }
    }

    function _normalizePin(pin) {
        pin = String(pin == null ? '' : pin).trim();
        if (!/^\d{6}$/.test(pin)) {
            throw new Error('PIN must be exactly 6 digits.');
        }
        return pin;
    }

    function _normalizeEmail(email) {
        email = String(email == null ? '' : email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new Error('Please enter a valid email address.');
        }
        return email;
    }

    function _scheduleAutoLock() {
        clearTimeout(_unlockTimer);
        _unlockTimer = setTimeout(lock, AUTO_LOCK_MS);
    }

    function _setActive(wallet) {
        _activeWallet = wallet;
        _scheduleAutoLock();
        return wallet;
    }

    // ── Keystore persistence (same-device convenience) ──────────────────

    function saveLocalKeystore(email, address, keystoreJson) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                email: email,
                address: address,
                keystore: _canonicalizeKeystore(keystoreJson),
                savedAt: Date.now()
            }));
        } catch (_) { /* storage full / private mode — server copy still works */ }
    }

    function getLocalKeystore() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function clearLocalKeystore() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }

    // ── Core wallet operations ──────────────────────────────────────────

    async function create(opts) {
        _assertEthers();
        var email = _normalizeEmail(opts && opts.email);
        var pin = _normalizePin(opts && opts.pin);

        var wallet = ethers.Wallet.createRandom();
        // ethers V3 keystore uses scrypt — deliberately slow (~1-2s) so a
        // stolen keystore is impractical to brute-force with a 6-digit PIN.
        var keystore = await wallet.encrypt(pin);
        var mnemonic = wallet.mnemonic && wallet.mnemonic.phrase;
        if (!mnemonic) throw new Error('Wallet generation failed (no mnemonic).');

        saveLocalKeystore(email, wallet.address, keystore);
        return { email: email, address: wallet.address, keystore: keystore, mnemonic: mnemonic };
    }

    async function decrypt(keystoreJson, pin) {
        _assertEthers();
        pin = _normalizePin(pin);
        try {
            return await ethers.Wallet.fromEncryptedJson(keystoreJson, pin);
        } catch (e) {
            throw new Error('Incorrect PIN or corrupted wallet backup.');
        }
    }

    async function unlockWithKeystore(keystoreJson, pin) {
        var wallet = await decrypt(keystoreJson, pin);
        return _setActive(wallet);
    }

    function getActiveAddress() {
        return _activeWallet ? _activeWallet.address : null;
    }

    async function exportMnemonic(pin) {
        // Re-auth with the PIN against the stored keystore before revealing the
        // recovery phrase — being merely unlocked is not enough for the words.
        var saved = getLocalKeystore();
        if (saved && saved.keystore) {
            await decrypt(saved.keystore, pin); // throws on wrong PIN
        } else {
            _normalizePin(pin);
            _requireUnlocked();
        }
        return _requireUnlocked().mnemonic && _requireUnlocked().mnemonic.phrase;
    }

    function lock() {
        clearTimeout(_unlockTimer);
        _unlockTimer = null;
        // Drop every reference to the decrypted key material.
        _activeWallet = null;
    }

    function _lockedError() {
        var err = new Error('Wallet is locked. Please re-enter your PIN to continue.');
        err.code = 'GM_WALLET_LOCKED';
        return err;
    }

    function _requireUnlocked() {
        if (!_activeWallet) throw _lockedError();
        return _activeWallet;
    }

    // ── Celo JSON-RPC (read-only calls go straight to the RPC) ─────────

    var _rpcIdx = 0;
    async function _celoJsonRpc(method, params) {
        var lastErr = null;
        for (var i = 0; i < CELO_RPC_URLS.length; i++) {
            var url = CELO_RPC_URLS[(_rpcIdx + i) % CELO_RPC_URLS.length];
            try {
                var resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || [] })
                });
                var data = await resp.json();
                if (data.error) {
                    var err = new Error(data.error.message || 'RPC error');
                    err.code = data.error.code;
                    err.data = data.error.data; // keep revert bytes for tx-error.js decoding
                    throw err;
                }
                _rpcIdx = (_rpcIdx + i) % CELO_RPC_URLS.length;
                return data.result;
            } catch (e) {
                lastErr = e;
                // A revert WITH data is deterministic — retrying another RPC
                // will not change it, so surface it immediately.
                if (e && e.data) throw e;
            }
        }
        throw lastErr || new Error('All Celo RPC endpoints failed.');
    }

    // ── EIP-1193-style provider for the signer chain ────────────────────

    async function _handleRequest(args) {
        var method = args.method;
        var params = args.params || [];

        switch (method) {
            case 'eth_chainId':
                return '0x' + CELO_CHAIN_ID.toString(16);
            case 'net_version':
                return String(CELO_CHAIN_ID);
            // Claim code may request a chain switch defensively; this wallet is
            // hard-pinned to Celo so the switch is always a no-op success.
            case 'wallet_switchEthereumChain':
                if (params[0] && params[0].chainId &&
                    params[0].chainId.toLowerCase() !== '0x' + CELO_CHAIN_ID.toString(16)) {
                    throw new Error('This wallet only supports Celo Mainnet.');
                }
                return null;
            case 'wallet_addEthereumChain':
                return null;
            case 'eth_accounts':
            case 'eth_requestAccounts': {
                return [_requireUnlocked().address];
            }
            case 'personal_sign': {
                var wallet0 = _requireUnlocked();
                // WalletConnect order is [message, address]; MetaMask matches.
                var msg = params[0];
                if (typeof msg === 'string' && msg.startsWith('0x')) {
                    try { msg = ethers.toUtf8String(msg); } catch (_) { /* keep hex */ }
                }
                return wallet0.signMessage(msg);
            }
            case 'eth_sendTransaction': {
                var wallet1 = _requireUnlocked();
                var tx = Object.assign({}, params[0]);
                var provider = new ethers.JsonRpcProvider(CELO_RPC_URLS[0], CELO_CHAIN_ID);
                var signer = wallet1.connect(provider);
                var sent = await signer.sendTransaction(tx);
                return sent.hash;
            }
            case 'eth_signTypedData':
            case 'eth_signTypedData_v3':
            case 'eth_signTypedData_v4': {
                var wallet2 = _requireUnlocked();
                var typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
                var domain = typed.domain || {};
                var types = Object.assign({}, typed.types || {});
                delete types.EIP712Domain;
                return wallet2.signTypedData(domain, types, typed.message);
            }
            default:
                // Everything else (eth_call, eth_estimateGas, eth_getBalance,
                // eth_getTransactionReceipt, ...) is read-only — straight to Celo.
                return _celoJsonRpc(method, params);
        }
    }

    function getProvider() {
        // wallet.html's claim flow checks for .getAddress() on the returned
        // signer — provide it so local wallets work with the same code path
        // that MetaMask / WalletConnect / Privy users already take.
        return {
            isGMLocalWallet: true,
            request: _handleRequest,
            getAddress: async function () { return _requireUnlocked().address; },
            on: function () {},
            removeListener: function () {}
        };
    }

    // ── Inline unlock prompt (for pages without a modal markup) ──────────
    // wallet.html has its own richer modal; savings/reloadly/swap call
    // _lwOpenUnlockModal which renders a minimal inline prompt.
    // ── Shared unlock modal ─────────────────────────────────────────────
    // Injects a styled modal into the page (no page-specific HTML needed).
    // Returns a Promise that resolves when unlocked, rejects on cancel/error.
    let _lwModalInjected = false;

    function _lwInjectModal() {
        if (_lwModalInjected) return;
        _lwModalInjected = true;

        const overlay = document.createElement('div');
        overlay.id = 'lwUnlockModalOverlay';
        overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;align-items:center;justify-content:center;padding:1rem;';
        overlay.innerHTML = `
            <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:1.5rem;max-width:320px;width:100%;text-align:center;">
                <div style="font-size:1.5rem;margin-bottom:0.5rem">🔒</div>
                <h3 style="margin:0 0 0.5rem;color:#fff;font-size:1.1rem">Unlock Your Wallet</h3>
                <p style="color:#aaa;font-size:0.8rem;margin-bottom:1rem">Enter your 6-digit PIN to continue</p>
                <input type="password" id="lwModalPin" inputmode="numeric" maxlength="6" placeholder="••••••"
                    style="width:100%;padding:0.8rem;text-align:center;font-size:1.3rem;letter-spacing:0.4rem;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.3);color:#fff;outline:none;margin-bottom:0.8rem;">
                <div id="lwModalError" style="display:none;color:#f87171;font-size:0.75rem;margin-bottom:0.8rem"></div>
                <button id="lwModalSubmit" style="width:100%;padding:0.75rem;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;font-weight:600;border:none;border-radius:10px;cursor:pointer;margin-bottom:0.5rem">Unlock</button>
                <button id="lwModalCancel" style="width:100%;padding:0.6rem;background:transparent;color:#888;border:1px solid rgba(255,255,255,0.2);border-radius:10px;cursor:pointer;font-size:0.85rem">Cancel</button>
            </div>
        `;
        document.body.appendChild(overlay);

        const pinInput = overlay.querySelector('#lwModalPin');
        const errorEl = overlay.querySelector('#lwModalError');
        const submitBtn = overlay.querySelector('#lwModalSubmit');
        const cancelBtn = overlay.querySelector('#lwModalCancel');

        let resolveFn, rejectFn;

        function close() {
            overlay.style.display = 'none';
            pinInput.value = '';
            errorEl.style.display = 'none';
        }

        function showError(msg) {
            errorEl.textContent = msg;
            errorEl.style.display = 'block';
        }

        submitBtn.onclick = async function () {
            const pin = pinInput.value.trim();
            if (!/^\d{6}$/.test(pin)) { showError('PIN must be exactly 6 digits.'); return; }
            submitBtn.disabled = true;
            submitBtn.textContent = 'Unlocking…';
            try {
                const saved = getLocalKeystore();
                if (!saved || !saved.keystore) throw new Error('No saved wallet on this device.');
                await unlockWithKeystore(saved.keystore, pin);
                close();
                if (resolveFn) resolveFn();
            } catch (err) {
                showError(/password|decrypt|mac/i.test(err && err.message) ? 'Wrong PIN.' : 'Unlock failed.');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Unlock';
            }
        };

        cancelBtn.onclick = function () {
            close();
            if (rejectFn) rejectFn(new Error('Unlock cancelled.'));
        };

        pinInput.onkeydown = function (e) {
            if (e.key === 'Enter') submitBtn.click();
        };

        window._lwModalShow = function () {
            return new Promise(function (resolve, reject) {
                resolveFn = resolve;
                rejectFn = reject;
                overlay.style.display = 'flex';
                setTimeout(() => pinInput.focus(), 100);
            });
        };
    }

    window._lwOpenUnlockModal = function () {
        _lwInjectModal();

        // Show the specific cause of failure instead of a blanket
        // "Unlock failed." — a correct PIN can still fail when the cached
        // keystore belongs to a different wallet (different email) or when
        // this device has no local copy (server copy must be fetched).
        function describeUnlockError(err, saved) {
            var msg = (err && err.message) || '';
            if (/no saved wallet/i.test(msg)) {
                return 'No wallet found on this device. Log in again with your email to fetch the server copy, then retry unlock.';
            }
            if (saved && saved.address && window.WALLET_ADDRESS &&
                saved.address.toLowerCase() !== window.WALLET_ADDRESS.toLowerCase()) {
                return 'Cached wallet on this device belongs to a different address. Please log in with the account\'s email to reload the correct wallet.';
            }
            if (/incorrect pin|corrupted wallet backup/i.test(msg)) {
                return 'Wrong PIN.';
            }
            return 'Unlock failed. ' + msg;
        }

        // Attempt server-fetch if the local keystore is unusable, so users on
        // a new browser/device can still unlock without a manual re-login.
        async function tryServerKeystore(savedEmail, address) {
            var email = (savedEmail || '').trim();
            if (!email) return null;
            try {
                var res = await fetch('/api/local-wallet/keystore?email=' + encodeURIComponent(email));
                var data = await res.json();
                if (data && data.success && data.keystore && (!address || String(data.address).toLowerCase() === address.toLowerCase())) {
                    return data;
                }
            } catch (_) {}
            return null;
        }

        async function handleUnlock(pin, saved) {
            // If no local copy, try the server copy first (wrong-device
            // unlock) — often fixes "No saved wallet on this device."
            if (!saved || !saved.keystore) {
                var serverData = await tryServerKeystore(_getSessionEmail(), null);
                if (serverData && serverData.keystore) {
                    try {
                        await unlockWithKeystore(serverData.keystore, pin);
                        return { ok: true, recoveredFrom: 'server' };
                    } catch (e) {
                        return { ok: false, err: e };
                    }
                }
                return { ok: false, err: new Error('No saved wallet on this device.') };
            }
            try {
                await unlockWithKeystore(saved.keystore, pin);
                return { ok: true, recoveredFrom: 'local' };
            } catch (e) {
                return { ok: false, err: e };
            }
        }

        // Rebuild the modal with full error context.
        return new Promise(function (resolve, reject) {
            _lwInjectModal();
            var overlay = document.getElementById('lwUnlockModalOverlay');
            if (!overlay) { reject(new Error('Unlock modal unavailable.')); return; }

            var pinInput = overlay.querySelector('#lwModalPin');
            var errorEl = overlay.querySelector('#lwModalError');
            var submitBtn = overlay.querySelector('#lwModalSubmit');

            var resolveFn = resolve;
            var rejectFn = reject;

            function close() {
                overlay.style.display = 'none';
                pinInput.value = '';
                if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
            }
            function showError(msg) {
                if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
            }

            submitBtn.onclick = async function () {
                var pin = pinInput.value.trim();
                if (!/^\d{6}$/.test(pin)) { showError('PIN must be exactly 6 digits.'); return; }
                submitBtn.disabled = true;
                submitBtn.textContent = 'Unlocking…';
                try {
                    var saved = getLocalKeystore();
                    var result = await handleUnlock(pin, saved);

                    if (result.ok) {
                        close();
                        resolveFn();
                        return;
                    }

                    // If the cached wallet is for a different address, clear it
                    // so the next login can re-cache the correct keystore.
                    if (saved && saved.address && window.WALLET_ADDRESS &&
                        saved.address.toLowerCase() !== window.WALLET_ADDRESS.toLowerCase()) {
                        try { clearLocalKeystore(); } catch (_) {}
                        showError(describeUnlockError(new Error('address mismatch'), saved));
                    } else {
                        showError(describeUnlockError(result.err, saved));
                    }
                } catch (err) {
                    showError(describeUnlockError(err, saved));
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Unlock';
                }
            };

            overlay.querySelector('#lwModalCancel').onclick = function () {
                close();
                rejectFn(new Error('Unlock cancelled.'));
            };
            overlay.querySelector('#lwModalPin').onkeydown = function (e) {
                if (e.key === 'Enter') submitBtn.click();
            };

            overlay.style.display = 'flex';
            setTimeout(function () { pinInput.focus(); }, 100);
        });
    };

    // ── Session email helper ────────────────────────────────────────────
    // The login page stores the email used at last login; the unlock modal
    // uses it to fetch the server-side keystore when no local copy exists.
    function _getSessionEmail() {
        try {
            return (window.GMLocalWalletEmail || sessionStorage.getItem('lw_session_email') || '').trim().toLowerCase() || null;
        } catch (_) {
            return null;
        }
    }

    // ── Login helper (signature proof for the backend) ──────────────────

    async function loginSignature(message) {
        return _requireUnlocked().signMessage(message);
    }

    window.GMLocalWallet = {
        create: create,
        decrypt: decrypt,
        unlockWithKeystore: unlockWithKeystore,
        loginSignature: loginSignature,
        getActiveAddress: getActiveAddress,
        exportMnemonic: exportMnemonic,
        lock: lock,
        getProvider: getProvider,
        saveLocalKeystore: saveLocalKeystore,
        getLocalKeystore: getLocalKeystore,
        clearLocalKeystore: clearLocalKeystore,
        canonicalizeKeystore: _canonicalizeKeystore,
        isUnlocked: function () { return !!_activeWallet; },
        normalizeEmail: _normalizeEmail,
        normalizePin: _normalizePin
    };
})();
