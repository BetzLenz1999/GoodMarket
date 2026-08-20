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
    window._lwOpenUnlockModal = function () {
        return new Promise(function (resolve, reject) {
            const pin = prompt('Enter your 6-digit wallet PIN to continue:');
            if (pin === null) { reject(new Error('Unlock cancelled.')); return; }
            if (!/^\d{6}$/.test(pin)) { reject(new Error('PIN must be exactly 6 digits.')); return; }
            const saved = getLocalKeystore();
            if (!saved || !saved.keystore) { reject(new Error('No saved wallet on this device.')); return; }
            unlockWithKeystore(saved.keystore, pin)
                .then(resolve)
                .catch(function (err) {
                    reject(new Error(/password|decrypt|mac/i.test(err && err.message) ? 'Wrong PIN.' : 'Unlock failed.'));
                });
        });
    };

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
