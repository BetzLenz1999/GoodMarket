/**
 * GMLocalWalletPasskey — optional WebAuthn (passkey) quick-unlock for the
 * in-app GoodMarket wallet.
 *
 * What it does
 * ------------
 * The in-app wallet's private key is encrypted with the user's 8-digit PIN
 * (ethers V3 scrypt keystore). Without this module the user re-types that PIN
 * on every page load and after every 15-minute auto-lock. This module lets an
 * opted-in user instead approve with their device's own user verification
 * (fingerprint, Face ID, or — on devices without biometrics — the device
 * PIN/pattern/passcode, which WebAuthn exposes as the same platform
 * authenticator).
 *
 * How it stays safe
 * -----------------
 * The PIN is NEVER stored, and neither is the decrypted private key. Instead:
 *
 *   1. enroll() creates a WebAuthn credential with the `prf` extension. The
 *      authenticator returns a 32-byte PRF output — a per-credential secret
 *      that never leaves the secure element and is only produced after a
 *      successful user-verification ceremony.
 *   2. A wrap key is derived from that output with HKDF-SHA256.
 *   3. The keystore JSON **and** the PIN are AES-GCM-256 wrapped and stored.
 *
 * The stored blob is opaque random bytes without a successful ceremony, so an
 * attacker who reads localStorage (XSS) still cannot recover the wallet. If
 * the device is lost, the user falls back to the 12 recovery words — a passkey
 * is device-bound by design.
 *
 * Hard fallback everywhere
 * ------------------------
 * isSupported()/isAvailable() gate every UI affordance, and every failure
 * (unsupported, ceremony cancelled, credential gone, wrong address) returns a
 * value the caller can quietly turn into the normal PIN prompt. A passkey can
 * never strand a user or lock them out of their own funds.
 *
 * Exposes window.GMLocalWalletPasskey:
 *   isSupported()        -> Promise<bool>  platform authenticator + HTTPS
 *   isAvailable()        -> Promise<bool>  supported AND a credential is stored
 *   enroll({keystore, pin, address}) -> Promise<{ok, reason?}>
 *   unlock()             -> Promise<{ok, keystore?, pin?, reason?}>
 *   revoke()             -> removes the stored credential locally
 *   hasStoredCredential() -> bool
 *   describeError(err)   -> user-facing string
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'gm_local_passkey_v1';
    var HKDF_INFO = 'gm-local-wallet-passkey-v1';
    var RP_NAME = 'GoodMarket';

    function _storage() {
        try { return window.localStorage; } catch (_) { return null; }
    }

    function _boot() {
        try { return (typeof window !== 'undefined' && window.GM_WALLET_BOOT) || {}; } catch (_) { return {}; }
    }

    function _walletAddress() {
        try {
            if (window.WALLET_ADDRESS) return String(window.WALLET_ADDRESS);
            var b = _boot();
            if (b.wallet) return String(b.wallet);
            return sessionStorage.getItem('wallet') || null;
        } catch (_) { return null; }
    }

    // ── base64 helpers (base64url for credential ids) ──────────────────────

    function _b64encode(buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function _b64decode(str) {
        var bin = atob(String(str));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function _b64urlEncode(buf) {
        return _b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function _b64urlDecode(str) {
        var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        return _b64decode(s);
    }

    function _randomBytes(n) {
        var out = new Uint8Array(n);
        crypto.getRandomValues(out);
        return out;
    }

    // A fixed 32-byte PRF evaluation salt. Anything non-empty and stable works;
    // 32 bytes is the recommended maximum. The salt is not a secret — the PRF
    // output is what matters, and it is per-credential.
    var PRF_SALT_TEXT = 'GoodMarket-LocalWallet-PRF-v1';
    function _prfSalt() {
        var raw = new TextEncoder().encode(PRF_SALT_TEXT);
        var salt = new Uint8Array(32);
        salt.set(raw.slice(0, 32));
        return salt;
    }

    // ── PRF capture (the part browsers disagree on) ────────────────────────

    // create() may or may not return `prf.results.first`. When it does not, a
    // follow-up get() reliably does, so enroll() always falls back to that.
    function _prfFromCreate(cred) {
        try {
            var e = cred.getClientExtensionResults();
            return (e && e.prf && e.prf.results && e.prf.results.first) || null;
        } catch (_) { return null; }
    }

    function _prfFromGet(assertion) {
        try {
            var e = assertion.getClientExtensionResults();
            return (e && e.prf && e.prf.results && e.prf.results.first) || null;
        } catch (_) { return null; }
    }

    function _arrayBuffer(buf) {
        if (buf instanceof ArrayBuffer) return buf;
        // ArrayBufferView (Uint8Array) → its exact byte slice
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }

    async function _deriveWrapKey(prfOutput, hkdfSalt) {
        var base = await crypto.subtle.importKey(
            'raw', _arrayBuffer(prfOutput), 'HKDF', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: _arrayBuffer(hkdfSalt),
                info: new TextEncoder().encode(HKDF_INFO)
            },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function _wrap(prfOutput, hkdfSalt, payloadObj) {
        var key = await _deriveWrapKey(prfOutput, hkdfSalt);
        var iv = _randomBytes(12);
        var plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
        var ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plaintext);
        return { iv: _b64encode(iv), ciphertext: _b64encode(ciphertext) };
    }

    async function _unwrap(prfOutput, hkdfSalt, ivB64, ctB64) {
        var key = await _deriveWrapKey(prfOutput, hkdfSalt);
        var plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: _b64decode(ivB64) },
            key,
            _b64decode(ctB64)
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
    }

    // ── Stored credential ─────────────────────────────────────────────────

    function _readStore() {
        var s = _storage();
        if (!s) return null;
        try {
            var raw = s.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    function _writeStore(obj) {
        var s = _storage();
        if (!s) return false;
        try { s.setItem(STORAGE_KEY, JSON.stringify(obj)); return true; } catch (_) { return false; }
    }

    function hasStoredCredential() {
        var st = _readStore();
        return !!(st && st.credentialId && st.ciphertext && st.iv && st.hkdfSalt);
    }

    function revoke() {
        var s = _storage();
        try { if (s) s.removeItem(STORAGE_KEY); } catch (_) {}
    }

    // ── Support detection ─────────────────────────────────────────────────

    function _isSecureContext() {
        try {
            if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
            // jsdom / older harnesses may not define it; HTTPS or localhost only.
            var origin = (typeof location !== 'undefined' && location.origin) || '';
            if (!origin) return true;
            return /^https:\/\//.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
        } catch (_) { return true; }
    }

    async function isSupported() {
        try {
            if (!_isSecureContext()) return false;
            if (typeof PublicKeyCredential === 'undefined') return false;
            if (!crypto || !crypto.subtle) return false;
            if (typeof navigator === 'undefined' || !navigator.credentials) return false;
            if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
                return false;
            }
            return !!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
        } catch (_) {
            return false;
        }
    }

    // ── Errors ────────────────────────────────────────────────────────────

    function describeError(err) {
        var name = (err && err.name) || '';
        var msg = (err && (err.message || err.reason)) || '';
        if (name === 'NotAllowedError' || /not allowed|cancel|denied|timed out/i.test(msg)) {
            return 'Passkey prompt was cancelled or timed out. Enter your PIN instead.';
        }
        if (name === 'NotSupportedError' || /prf|not supported/i.test(msg)) {
            return 'This device/browser cannot use a passkey for the wallet. Enter your PIN instead.';
        }
        if (name === 'InvalidStateError') {
            return 'This passkey is already registered. Enter your PIN instead.';
        }
        return 'Passkey sign-in did not work (' + (msg || 'unknown error') + '). Enter your PIN instead.';
    }

    // ── Enroll ────────────────────────────────────────────────────────────

    /**
     * Create a passkey credential and store the PIN-wrapped keystore.
     * Requires the wallet to be unlocked already (caller re-prompts for the
     * PIN so we can wrap it).
     */
    async function enroll(opts) {
        opts = opts || {};
        var keystore = opts.keystore;
        var pin = opts.pin;
        var address = opts.address || _walletAddress();
        if (!keystore) return { ok: false, reason: 'no_keystore' };
        if (!pin) return { ok: false, reason: 'no_pin' };
        if (!(await isSupported())) return { ok: false, reason: 'unsupported' };

        try {
            var prfSalt = _prfSalt();
            var userId = _randomBytes(16);
            var cred = await navigator.credentials.create({
                publicKey: {
                    challenge: _randomBytes(32),
                    rp: { name: RP_NAME, id: (typeof location !== 'undefined' && location.hostname) || undefined },
                    user: {
                        id: userId,
                        name: address ? String(address) : 'GoodMarket wallet',
                        displayName: 'GoodMarket wallet'
                    },
                    pubKeyCredParams: [
                        { type: 'public-key', alg: -7 },   // ES256
                        { type: 'public-key', alg: -257 }  // RS256
                    ],
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',
                        residentKey: 'preferred',
                        userVerification: 'required'
                    },
                    timeout: 120000,
                    attestation: 'none',
                    extensions: { prf: { eval: { first: prfSalt } } }
                }
            });
            if (!cred) return { ok: false, reason: 'create_failed' };

            var credentialId = _arrayBuffer(cred.rawId);
            var prfOutput = _prfFromCreate(cred);

            // Most platforms only surface the PRF output on an assertion, so
            // run one get() right away and use whatever comes back.
            if (!prfOutput) {
                var assertion = await navigator.credentials.get({
                    publicKey: {
                        challenge: _randomBytes(32),
                        timeout: 120000,
                        userVerification: 'required',
                        allowCredentials: [{ type: 'public-key', id: credentialId }],
                        extensions: { prf: { eval: { first: prfSalt } } }
                    }
                });
                prfOutput = assertion && _prfFromGet(assertion);
            }
            if (!prfOutput) return { ok: false, reason: 'no_prf' };

            var hkdfSalt = _randomBytes(32);
            var wrapped = await _wrap(prfOutput, hkdfSalt, { keystore: keystore, pin: pin });

            var stored = _writeStore({
                credentialId: _b64urlEncode(credentialId),
                hkdfSalt: _b64encode(hkdfSalt),
                iv: wrapped.iv,
                ciphertext: wrapped.ciphertext,
                address: address ? String(address) : null,
                createdAt: Date.now()
            });
            if (!stored) return { ok: false, reason: 'storage' };
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: 'error', error: err, message: describeError(err) };
        }
    }

    // ── Unlock ────────────────────────────────────────────────────────────

    async function isAvailable() {
        if (!hasStoredCredential()) return false;
        return isSupported();
    }

    async function unlock() {
        var st = _readStore();
        if (!st) return { ok: false, reason: 'no_credential' };
        if (!(await isSupported())) return { ok: false, reason: 'unsupported' };
        try {
            var prfSalt = _prfSalt();
            var assertion = await navigator.credentials.get({
                publicKey: {
                    challenge: _randomBytes(32),
                    timeout: 120000,
                    userVerification: 'required',
                    allowCredentials: [{ type: 'public-key', id: _b64urlDecode(st.credentialId) }],
                    extensions: { prf: { eval: { first: prfSalt } } }
                }
            });
            var prfOutput = assertion && _prfFromGet(assertion);
            if (!prfOutput) return { ok: false, reason: 'no_prf' };

            var payload = await _unwrap(
                prfOutput,
                _b64decode(st.hkdfSalt),
                st.iv,
                st.ciphertext
            );
            if (!payload || !payload.keystore) return { ok: false, reason: 'bad_payload' };

            // Guard against a stale credential that belongs to another account
            // (the same rule the PIN path enforces before decrypting).
            var expected = _walletAddress();
            if (st.address && expected && String(st.address).toLowerCase() !== expected.toLowerCase()) {
                return { ok: false, reason: 'address_mismatch' };
            }
            return { ok: true, keystore: payload.keystore, pin: payload.pin };
        } catch (err) {
            return { ok: false, reason: 'cancelled', error: err, message: describeError(err) };
        }
    }

    window.GMLocalWalletPasskey = {
        isSupported: isSupported,
        isAvailable: isAvailable,
        enroll: enroll,
        unlock: unlock,
        revoke: revoke,
        hasStoredCredential: hasStoredCredential,
        describeError: describeError,
        STORAGE_KEY: STORAGE_KEY
    };
})();
