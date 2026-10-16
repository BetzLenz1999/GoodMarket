/* GoodMarket shared "Get Started" connect flow.
 *
 * Extracted from templates/homepage.html so the SAME modal + connect logic
 * powers the homepage AND guest-facing feature pages (/swap, /savings).
 *
 * Per-request values come from window.GM_GET_STARTED_BOOT, set inline by
 * templates/_get_started_modal.html (replaces the old private Jinja in the
 * inline block: the WalletConnect sidecar flag + the return target).
 */
(function () {
'use strict';


// Boot config (set by the including template).
const GM_BOOT = window.GM_GET_STARTED_BOOT || {};
const _gmReturnTo = GM_BOOT.returnTo || '';

// Network configuration is shared by the injected-wallet login flow.
// The add/switch requests happen only after the Connect click, because
// browser extensions require a user gesture for those permission prompts.
const CELO_NETWORK = Object.freeze({
    chainId: '0xa4ec', // 42220
    chainName: 'Celo Mainnet',
    nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
    rpcUrls: ['https://forno.celo.org'],
    blockExplorerUrls: ['https://celoscan.io']
});

// G$ is an ERC-20 token on Celo, not a separate EVM network.  EIP-747
// deliberately leaves the final decision to the wallet/user: calling
// wallet_watchAsset can show a confirmation prompt and never adds the
// token silently.  Request it after Celo is selected so wallets that
// validate the active chain can display the correct token.
const GOODDOLLAR_TOKEN = Object.freeze({
    type: 'ERC20',
    options: {
        address: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
        symbol: 'G$',
        decimals: 18,
        image: window.location.origin + '/static/icons/goodmarket-icon.png'
    }
});
function _showWalletModalNow() {
    showWalletOptions();
    hidePrivyRetry();
    window.restoreWalletModalAfterPrivy?.(false);
    document.getElementById('walletModal').classList.add('active');
    // Re-apply any referral code captured from the URL / sessionStorage
    // so the local-wallet create form keeps the referral context.
    try { initReferralFromUrl(); } catch (e) {}
    detectInjectedWallet(0);
    if (window.GM_PRIVY_CONFIG && window.GM_PRIVY_CONFIG.enabled && window.GM_PRIVY_CONFIG.appId) {
        showWalletStatus('walletConnectStatus', '🔐 Tap Open Privy Login to continue.', 'info');
    } else {
        showWalletStatus('walletConnectStatus', '👛 Connect with MiniPay, Trust Wallet, MetaMask, or use WalletConnect QR / URI.', 'info');
    }
}

async function openWalletModal() {
    // The session probe used to gate the paint, so a slow /api/session-status
    // response delayed the sheet. Run it in parallel and only wait ~400ms for
    // it; an already-authenticated session still redirects, just without
    // holding up the login choices.
    const probe = fetch('/api/session-status', { cache: 'no-store' })
        .then((resp) => resp.json().then((data) => ({ resp, data })))
        .catch(() => null);
    const gate = new Promise((resolve) => setTimeout(() => resolve(null), 400));
    const first = await Promise.race([probe, gate]);
    if (first && first.resp && first.resp.ok && first.data && first.data.authenticated && first.data.redirect_to) {
        window.location.assign(first.data.redirect_to);
        return;
    }
    _showWalletModalNow();
    // If the probe resolves authenticated after the sheet painted, redirect then.
    probe.then((result) => {
        if (result && result.resp && result.resp.ok && result.data && result.data.authenticated && result.data.redirect_to) {
            window.location.assign(result.data.redirect_to);
        }
    });
}

function closeWalletModal() {
    document.getElementById('walletModal').classList.remove('active');
}

function hideWalletModalForPrivy() {
    const modal = document.getElementById('walletModal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
}

function restoreWalletModalAfterPrivy(showModal = true) {
    const modal = document.getElementById('walletModal');
    if (!modal) return;
    modal.removeAttribute('aria-hidden');
    if (showModal) modal.classList.add('active');
}

window.hideWalletModalForPrivy = hideWalletModalForPrivy;
window.restoreWalletModalAfterPrivy = restoreWalletModalAfterPrivy;

function showWalletOptions() {
    document.getElementById('walletOptions').style.display = 'flex';
    ['walletConnectOptions', 'googleLoginOptions', 'localWalletOptions'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('visible');
    });
    const panelStatus = document.getElementById('walletConnectPanelStatus');
    if (panelStatus) {
        panelStatus.className = 'status-message';
        panelStatus.textContent = '';
    }
}

// ─── Local self-custodial account (email + PIN) ─────────────────────
// The wallet is generated and encrypted in the browser via
// GMLocalWallet; the server only ever sees the address + encrypted
// keystore, and login is proven with a signature.

let _lwMode = 'create';
let _lwPendingSignup = null; // {address, keystore, mnemonic, message}
let _lwRecoveryWords = '';   // current 12-word phrase, memory only
// The PIN is cleared from the DOM by _lwCompleteLogin, but the passkey offer
// runs AFTER that — so hold it (plus the keystore) here, memory only, and drop
// it the moment the offer is answered or skipped.
let _lwOfferPasskey = null;  // {pin, keystore, address, redirectTo}

// Copy the recovery phrase straight to the clipboard. The words are
// shown once and never stored server-side, so this is the user's only
// chance to keep them — hence the explicit success/failure feedback.
function lwCopyRecoveryWords(btn) {
    const text = _lwRecoveryWords || '';
    const done = (ok) => {
        if (!btn) return;
        const orig = '📋 Copy my 12 recovery words';
        btn.textContent = ok ? '✅ Copied — keep it safe!' : '❌ Copy failed — write the words down';
        setTimeout(function () { btn.textContent = orig; }, 2200);
    };
    if (!text) { done(false); return; }
    const fallback = function () {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            done(ok);
        } catch (_) { done(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }).catch(fallback);
    } else {
        fallback();
    }
}

function showLocalWalletPanel(mode) {
    if (typeof GMLocalWallet === 'undefined' || typeof ethers === 'undefined') {
        showWalletStatus('walletConnectStatus', '⚠️ Wallet tools are still loading — try again in a moment.', 'warning');
        return;
    }
    document.getElementById('walletOptions').style.display = 'none';
    ['walletConnectOptions', 'googleLoginOptions'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('visible');
    });
    document.getElementById('localWalletOptions').classList.add('visible');
    document.getElementById('lwPhraseStep').style.display = 'none';
    document.getElementById('lwUsernameStep').style.display = 'none';
    const pkStep = document.getElementById('lwPasskeyStep');
    if (pkStep) pkStep.style.display = 'none';
    if (mode === 'create' && !_lwPreflightAcked) {
        // Reminder gate: ask once per browser session before creating.
        // Unlock (existing users) never sees it.
        _lwShowPreflightStep();
        return;
    }
    document.getElementById('lwPreflightStep').style.display = 'none';
    document.getElementById('lwCreateStep').style.display = 'block';
    setLocalWalletMode(mode || 'create');
    // Prefill from a same-device keystore for a quick unlock.
    const saved = GMLocalWallet.getLocalKeystore();
    if (saved && saved.email && !document.getElementById('lwEmail').value) {
        document.getElementById('lwEmail').value = saved.email;
    }
    const refEl = document.getElementById('lwReferralCode');
    if (refEl && !refEl.value) {
        try {
            const ref = (sessionStorage.getItem('pending_referral_code') || '').trim();
            if (ref) refEl.value = ref;
        } catch (e) {}
    }
    lwStatus('', 'info');
}

// ─── Pre-create reminder ("isang account per tao") ──────────────────
// A second wallet for a face already verified on GoodDollar cannot
// claim G$, so we ask the user to confirm they don't already have
// MiniPay / GoodWallet before creating. Copy + an acknowledgment only;
// the create logic below is unchanged. Acked once per session so
// returning users aren't nagged every time they open the modal.
let _lwPreflightAcked = false;

function openCreatePreflight() {
    showLocalWalletPanel('create');
}

function _lwShowPreflightStep() {
    document.getElementById('lwPreflightStep').style.display = 'block';
    document.getElementById('lwCreateStep').style.display = 'none';
    const ack = document.getElementById('lwPreflightAck');
    if (ack) ack.checked = false;
    const cont = document.getElementById('lwPreflightContinue');
    if (cont) cont.disabled = true;
}

function onPreflightAckChange(cb) {
    const cont = document.getElementById('lwPreflightContinue');
    if (cont) cont.disabled = !(cb && cb.checked);
}

function ackCreatePreflight() {
    const ack = document.getElementById('lwPreflightAck');
    if (!ack || !ack.checked) return;
    _lwPreflightAcked = true;
    document.getElementById('lwPreflightStep').style.display = 'none';
    document.getElementById('lwCreateStep').style.display = 'block';
    const mode = (typeof _lwMode !== 'undefined') ? _lwMode : 'create';
    setLocalWalletMode(mode === 'unlock' ? 'unlock' : 'create');
    try { document.getElementById('lwEmail').focus(); } catch (_) {}
}

function cancelCreatePreflight() {
    document.getElementById('lwPreflightStep').style.display = 'none';
    document.getElementById('lwCreateStep').style.display = 'block';
    showWalletOptions();
}

// Device-aware nudge: when a wallet is detected, surface it and hoist
// the connect option above the create option. MiniPay gets the loud
// (gold) treatment because it is the most common "already has a G$
// wallet" case.
function _lwApplyDetectionNudge(provider) {
    const banner = document.getElementById('walletDetectBanner');
    const text = document.getElementById('walletDetectText');
    if (!banner || !text) return;
    if (!provider) { banner.classList.remove('show'); return; }
    const name = (typeof getInjectedProviderLabel === 'function')
        ? getInjectedProviderLabel(provider) : 'Wallet';
    const isMini = !!(provider && provider.isMiniPay);
    text.innerHTML = isMini
        ? "<strong>You're in MiniPay.</strong> You likely already have a G$ wallet here — connect it instead of creating a new one."
        : "<strong>" + name + " detected.</strong> If you already use this wallet for G$, connect it instead of creating a new one.";
    banner.classList.add('show');
    const injectedBtn = document.getElementById('injectedWalletBtn');
    if (injectedBtn) {
        if (banner.parentElement && injectedBtn.previousElementSibling !== banner) {
            banner.insertAdjacentElement('afterend', injectedBtn);
        }
        injectedBtn.classList.toggle('primary', isMini);
    }
}

function setLocalWalletMode(mode) {
    _lwMode = mode === 'unlock' ? 'unlock' : 'create';
    const isUnlock = _lwMode === 'unlock';
    document.getElementById('lwPinConfirmWrap').style.display = isUnlock ? 'none' : 'block';
    document.getElementById('lwReferralWrap').style.display = isUnlock ? 'none' : 'block';
    // Legacy accounts have 6-digit PINs; new accounts are 8 — the
    // label reflects which rule applies to the active mode.
    document.getElementById('lwPinLabel').textContent = isUnlock ? 'PIN (6 or 8 digits)' : '8-digit PIN';
    const strengthEl = document.getElementById('lwPinStrength');
    if (strengthEl) strengthEl.style.display = 'none';
    document.getElementById('lwModeNote').textContent = isUnlock
        ? 'Enter the email and PIN for your GoodMarket account. Works on any device — we fetch your encrypted wallet and your PIN unlocks it here in the browser.'
        : 'Make a free GoodMarket account & wallet — secured by your email and an 8-digit PIN. No app install, no fees.';
    document.getElementById('lwSubmitBtn').textContent = isUnlock ? 'Log in to my account' : 'Create my free wallet';
    document.getElementById('lwToggleNote').innerHTML = isUnlock
        ? 'New here? <button class="back-btn" style="display:inline;margin:0;" type="button" onclick="setLocalWalletMode(\'create\')">Create a free account</button>'
        : 'Already have an account? <button class="back-btn" style="display:inline;margin:0;" type="button" onclick="setLocalWalletMode(\'unlock\')">Log in with email + PIN</button>';
}

function lwStatus(message, type) {
    const el = document.getElementById('localWalletStatus');
    if (!el) return;
    if (!message) { el.textContent = ''; el.className = 'status-message'; return; }
    showWalletStatus('localWalletStatus', message, type || 'info');
}

// Live weak/strong hint under the PIN field (create mode only — in
// unlock mode a 6-digit legacy PIN is valid and must not show "weak").
function lwPinStrengthHint() {
    const el = document.getElementById('lwPinStrength');
    if (!el) return;
    if (_lwMode !== 'create') { el.style.display = 'none'; return; }
    const pin = document.getElementById('lwPin').value.trim();
    const strength = GMLocalWallet.pinStrength(pin);
    if (strength === 'empty') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (strength === 'typing') {
        el.style.color = '#9ca3af';
        el.textContent = pin.length + '/8 digits';
    } else if (strength === 'weak') {
        el.style.color = '#dc2626';
        el.textContent = '🔴 Weak PIN — avoid repeated or sequential digits (e.g. 44444444, 12345678).';
    } else {
        el.style.color = '#16a34a';
        el.textContent = '🟢 Strong PIN';
    }
}

// sha256 of the normalized email — the login call sends this instead of
// the raw email so PII never transits the login endpoint.
async function _lwEmailHash(email) {
    const normalized = String(email).trim().toLowerCase();
    if (window.crypto && window.crypto.subtle) {
        const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
        return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    throw new Error('Secure context required. Please open GoodMarket over HTTPS.');
}

async function submitLocalWallet() {
    const btn = document.getElementById('lwSubmitBtn');
    try {
        const email = document.getElementById('lwEmail').value;
        const pin = document.getElementById('lwPin').value;
        GMLocalWallet.normalizeEmail(email);

        btn.disabled = true;
        if (_lwMode === 'create') {
            // New wallets: strict 8-digit + weak-PIN blocklist.
            GMLocalWallet.normalizeNewPin(pin);
            const confirmPin = document.getElementById('lwPinConfirm').value;
            if (pin !== confirmPin) throw new Error('PINs do not match.');
            await _lwCreateAccount(email, pin, btn);
        } else {
            // Unlock: lenient — legacy 6-digit PINs must still work.
            GMLocalWallet.normalizePin(pin);
            await _lwUnlockAccount(email, pin, btn);
        }
    } catch (err) {
        lwStatus('❌ ' + (err && err.message ? err.message : 'Something went wrong.'), 'error');
        btn.disabled = false;
    }
}

async function _lwCreateAccount(email, pin, btn) {
    lwStatus('⏳ Generating your wallet & encrypting with your PIN (a few seconds)…', 'info');
    const created = await GMLocalWallet.create({ email: email, pin: pin });
    // Canonical (sorted-keys) keystore: the server fingerprints this
    // exact form for the login signature message.
    const canonicalKeystore = GMLocalWallet.canonicalizeKeystore(created.keystore);

    lwStatus('⏳ Registering your account…', 'info');
    const regResp = await fetch('/api/local-wallet/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: created.email,
            address: created.address,
            keystore: JSON.parse(canonicalKeystore),
            referral_code: (document.getElementById('lwReferralCode').value || '').trim() || null
        })
    });
    const regData = await regResp.json();
    if (!regResp.ok || !regData.success) throw new Error(regData.error || 'Registration failed.');
    if (regData.referral_message) lwStatus('🎁 ' + regData.referral_message, 'success');

    _lwPendingSignup = {
        address: created.address,
        keystore: canonicalKeystore,
        mnemonic: created.mnemonic,
        message: regData.message,
        emailHash: await _lwEmailHash(created.email),
        pin: pin
    };
    _lwRenderPhraseStep(created.mnemonic);
    lwStatus('✅ Wallet created! Save your recovery words to continue.', 'success');
}

function _lwRenderPhraseStep(mnemonic) {
    const words = String(mnemonic || '').trim().split(/\s+/);
    _lwRecoveryWords = words.join(' ');
    const wrap = document.getElementById('lwWords');
    wrap.innerHTML = '';
    words.forEach(function (word, i) {
        const cell = document.createElement('div');
        cell.className = 'lw-word';
        const num = document.createElement('span');
        num.textContent = String(i + 1);
        cell.appendChild(num);
        cell.appendChild(document.createTextNode(word));
        wrap.appendChild(cell);
    });
    document.getElementById('lwPhraseConfirm').checked = false;
    document.getElementById('lwFinishBtn').disabled = true;
    document.getElementById('lwCreateStep').style.display = 'none';
    document.getElementById('lwUsernameStep').style.display = 'none';
    document.getElementById('lwPhraseStep').style.display = 'block';
}

async function finishLocalWalletSignup() {
    const btn = document.getElementById('lwFinishBtn');
    if (!_lwPendingSignup) return;
    btn.disabled = true;
    try {
        lwStatus('⏳ Signing you in…', 'info');
        await GMLocalWallet.unlockWithKeystore(_lwPendingSignup.keystore, _lwPendingSignup.pin);
        const signature = await GMLocalWallet.loginSignature(_lwPendingSignup.message);
        const resp = await fetch('/api/local-wallet/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email_hash: _lwPendingSignup.emailHash,
                address: _lwPendingSignup.address,
                message: _lwPendingSignup.message,
                signature: signature
            })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || 'Login failed.');
        await _lwCompleteLogin(data, _lwPendingSignup.pin);
    } catch (err) {
        lwStatus('❌ ' + (err && err.message ? err.message : 'Login failed.'), 'error');
        btn.disabled = false;
    }
}

async function _lwUnlockAccount(email, pin, btn) {
    let keystore = null;
    let address = null;
    let message = null;
    // Same-device fast path: use the saved keystore, but always fetch
    // the server copy for the login message (keystore fingerprint).
    const saved = GMLocalWallet.getLocalKeystore();
    if (saved && saved.email && saved.email.toLowerCase() === String(email).trim().toLowerCase()) {
        keystore = saved.keystore;
        address = saved.address;
    }
    lwStatus('⏳ Fetching your encrypted wallet…', 'info');
    const ksResp = await fetch('/api/local-wallet/keystore?email=' + encodeURIComponent(String(email).trim().toLowerCase()));
    const ksData = await ksResp.json();
    if (!ksResp.ok || !ksData.success) throw new Error(ksData.error || 'No account found for that email.');
    keystore = typeof ksData.keystore === 'string' ? ksData.keystore : JSON.stringify(ksData.keystore);
    address = ksData.address;
    message = ksData.message;

    lwStatus('⏳ Logging you in with your PIN…', 'info');
    await GMLocalWallet.unlockWithKeystore(keystore, pin);
    GMLocalWallet.saveLocalKeystore(String(email).trim().toLowerCase(), address, keystore);
    const signature = await GMLocalWallet.loginSignature(message);

    const resp = await fetch('/api/local-wallet/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_hash: ksData.email_hash, address: address, message: message, signature: signature })
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.error || 'Login failed.');
    _lwCompleteLogin(data, pin);
}

async function _lwCompleteLogin(data, pin) {
    const pinEl = document.getElementById('lwPin');
    const confirmEl = document.getElementById('lwPinConfirm');
    if (pinEl) pinEl.value = '';
    if (confirmEl) confirmEl.value = '';
    const strengthEl = document.getElementById('lwPinStrength');
    if (strengthEl) strengthEl.style.display = 'none';
    _lwPendingSignup = null;
    _lwRecoveryWords = '';
    try {
        sessionStorage.setItem('wallet', data.wallet || '');
        sessionStorage.setItem('verified', 'true');
        // Keep the email around so the unlock modal can re-fetch the
        // server keystore on devices without a local copy.
        const saved = GMLocalWallet.getLocalKeystore();
        if (saved && saved.email) sessionStorage.setItem('lw_session_email', saved.email);
        if (data.wallet) window.GMLocalWalletEmail = saved && saved.email ? saved.email : null;
    } catch (e) {}
    // Gate on the actual username, not account age: brand-new creators
    // AND older accounts made before this flow get the setup step until
    // they have a username. A failed lookup must not block the login.
    // A guest who connected from /swap or /savings returns there.
    const redirectTo = _gmReturnTo || data.redirect_to || '/wallet';
    let needsUsername = false;
    try {
        const uRes = await fetch('/api/user/username');
        if (uRes.ok) {
            const uData = await uRes.json();
            needsUsername = !!(uData && uData.success && !uData.username);
            if (uData && uData.username) sessionStorage.setItem('username', uData.username);
        }
    } catch (e) {}
    if (needsUsername) {
        // Hold the PIN + keystore (memory only) so the passkey offer after the
        // username step needs no second PIN entry.
        _lwOfferPasskey = {
            pin: pin,
            keystore: _lwKeystoreJson(),
            address: data.wallet || '',
            redirectTo: redirectTo
        };
        _lwShowUsernameStep(redirectTo);
        return;
    }
    // No username step — offer the passkey now, then redirect.
    _lwOfferPasskey = {
        pin: pin,
        keystore: _lwKeystoreJson(),
        address: data.wallet || '',
        redirectTo: redirectTo
    };
    if (_lwCanOfferPasskey()) { _lwShowPasskeyStep(redirectTo); return; }
    _lwClearPasskeyOffer();
    lwStatus('✅ Welcome! Redirecting…', 'success');
    setTimeout(function () { window.location.href = redirectTo; }, 900);
}

// The keystore JSON for the offer. Read from the local store (already saved by
// create()/login) and fall back to the pending signup copy.
function _lwKeystoreJson() {
    const saved = GMLocalWallet.getLocalKeystore();
    if (saved && saved.keystore) return saved.keystore;
    return _lwPendingSignup ? _lwPendingSignup.keystore : null;
}

function _lwClearPasskeyOffer() {
    _lwOfferPasskey = null;
}

// Show the passkey step ONLY when the device can actually create one. Many
// wallet dApp browsers (embedded WebView) have no WebAuthn at all, and a
// device with no screen lock has no platform authenticator — for those the
// step is skipped entirely rather than shown as a dead end.
function _lwCanOfferPasskey() {
    if (!_lwOfferPasskey || !_lwOfferPasskey.pin || !_lwOfferPasskey.keystore) return false;
    try {
        if (!window.GMLocalWalletPasskey) return false;
    } catch (_) { return false; }
    // Already enrolled on this device? Nothing to offer.
    try {
        if (window.GMLocalWalletPasskey.hasStoredCredential()) return false;
    } catch (_) {}
    // Asked before? Ask once, never nag.
    try {
        if (localStorage.getItem('gm_passkey_offer_declined_v1') === '1') return false;
    } catch (_) {}
    return true;
}

function _lwShowPasskeyStep(redirectTo) {
    const redirect = redirectTo || _lwOfferPasskey && _lwOfferPasskey.redirectTo || '/wallet';
    ['lwCreateStep', 'lwPhraseStep', 'lwUsernameStep'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const step = document.getElementById('lwPasskeyStep');
    if (step) step.style.display = 'block';
    const btn = document.getElementById('lwPasskeyEnableBtn');
    if (btn) btn.disabled = false;
    const st = document.getElementById('lwPasskeyStatus');
    if (st) { st.className = 'status-message'; st.textContent = ''; }
    // Probe support asynchronously; if the platform authenticator turns out to
    // be unavailable, quietly continue to the redirect instead of stranding.
    (async function () {
        let ok = false;
        try { ok = await window.GMLocalWalletPasskey.isSupported(); } catch (_) {}
        if (!ok) {
            lwStatus('✅ Welcome! Redirecting…', 'success');
            _lwClearPasskeyOffer();
            setTimeout(function () { window.location.href = redirect; }, 900);
        }
    })();
}

// The tap here IS the required WebAuthn user activation — this is why the
// offer is a button in the flow rather than an automatic background call.
async function submitLocalWalletPasskey() {
    const btn = document.getElementById('lwPasskeyEnableBtn');
    const st = document.getElementById('lwPasskeyStatus');
    const offer = _lwOfferPasskey;
    const redirect = (offer && offer.redirectTo) || '/wallet';
    const say = function (msg, kind) {
        if (!st) return;
        st.className = 'status-message' + (kind ? ' ' + kind : '');
        st.textContent = msg;
    };
    if (!offer || !offer.pin || !offer.keystore) {
        say('Session expired — you can enable this later in Settings.', 'warning');
        setTimeout(function () { window.location.href = redirect; }, 1200);
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Setting up…'; }
    try {
        const res = await window.GMLocalWalletPasskey.enroll({
            keystore: offer.keystore,
            pin: offer.pin,
            address: offer.address
        });
        if (!res || !res.ok) throw new Error((res && res.message) || 'Could not set up a passkey on this device.');
        say('✅ Done! You can unlock with your device from now on.', 'success');
        _lwClearPasskeyOffer();
        setTimeout(function () { window.location.href = redirect; }, 900);
    } catch (err) {
        // A failure must never block entry — show the reason and move on.
        say((err && err.message) || 'Could not enable it. Your PIN still works.', 'warning');
        if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    }
}

// Declining is remembered so we never ask again on this device.
function skipLocalWalletPasskey() {
    try { localStorage.setItem('gm_passkey_offer_declined_v1', '1'); } catch (_) {}
    const redirect = (_lwOfferPasskey && _lwOfferPasskey.redirectTo) || '/wallet';
    _lwClearPasskeyOffer();
    window.location.href = redirect;
}

let _lwUsernameRedirect = '/wallet';

function _lwShowUsernameStep(redirectTo) {
    _lwUsernameRedirect = redirectTo || '/wallet';
    document.getElementById('lwCreateStep').style.display = 'none';
    document.getElementById('lwPhraseStep').style.display = 'none';
    document.getElementById('lwUsernameStep').style.display = 'block';
    const btn = document.getElementById('lwUsernameBtn');
    if (btn) btn.disabled = false;
    lwStatus('👤 One last step — set your username to receive money easily.', 'success');
    setTimeout(function () {
        const input = document.getElementById('lwUsername');
        if (input) input.focus();
    }, 50);
}

function skipLocalWalletUsername() {
    // Skip username → still offer the passkey, then redirect.
    if (_lwCanOfferPasskey()) { _lwShowPasskeyStep(_lwUsernameRedirect); return; }
    window.location.href = _lwUsernameRedirect;
}

async function submitLocalWalletUsername() {
    const btn = document.getElementById('lwUsernameBtn');
    const input = document.getElementById('lwUsername');
    const username = ((input && input.value) || '').trim();
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
        lwStatus('❌ Username must be 3–24 characters: letters, numbers, and underscore (_) only.', 'error');
        return;
    }
    btn.disabled = true;
    lwStatus('⏳ Saving your username…', 'info');
    try {
        const resp = await fetch('/api/user/username', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || 'Could not save username.');
        const savedUsername = data.username || username.toLowerCase();
        try { sessionStorage.setItem('username', savedUsername); } catch (e) {}
        lwStatus('✅ Username set! Welcome, @' + savedUsername + '…', 'success');
        // Offer the passkey before leaving the flow, then redirect.
        if (_lwCanOfferPasskey()) { _lwShowPasskeyStep(_lwUsernameRedirect); return; }
        setTimeout(function () { window.location.href = _lwUsernameRedirect; }, 900);
    } catch (err) {
        lwStatus('❌ ' + (err && err.message ? err.message : 'Could not save username.'), 'error');
        btn.disabled = false;
    }
}

function showPrivyRetry() {
    const retry = document.getElementById('privyRetryButton');
    const primary = document.getElementById('privyPrimaryButton');
    if (!window.GM_PRIVY_CONFIG || !window.GM_PRIVY_CONFIG.enabled) return;
    // Do not show two visually identical Privy CTAs at the same time.
    // Some in-app browsers (MiniPay/Trust/MetaMask) keep the GoodMarket
    // modal visible while Privy's sheet is opening, so the retry CTA used
    // to appear underneath the primary button and look duplicated.
    if (primary) primary.style.display = 'none';
    if (retry) retry.style.display = 'flex';
}

function hidePrivyRetry() {
    const retry = document.getElementById('privyRetryButton');
    const primary = document.getElementById('privyPrimaryButton');
    if (retry) retry.style.display = 'none';
    if (primary) primary.style.display = 'flex';
}


function isPrivyUiVisible() {
    const selectors = [
        '[data-privy-dialog]',
        '[data-testid*=privy i]',
        '[aria-label*=privy i]',
        'iframe[src*=privy]',
        'div[id*=privy]:not(#privyLoginMount)',
        'div[class*=privy]'
    ];
    try {
        return selectors.some(selector => Array.from(document.querySelectorAll(selector)).some(el => {
            if (!el || el.id === 'privyLoginMount') return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }));
    } catch (_) {
        return false;
    }
}

function watchPrivyOpen() {
    clearTimeout(window.GMPrivyOpenWatchTimer);
    window.GMPrivyOpenWatchTimer = setTimeout(function () {
        // OAuth/social-wallet flows can legitimately move browser focus or
        // take several seconds before Privy's portal is visible. Do not put
        // the GoodMarket modal back on top while that handoff may still be
        // happening; only show the retry CTA when the page is still active
        // and no Privy UI/authenticated callback was observed.
        if (window.GMPrivyAuthenticated || isPrivyUiVisible() || document.hidden || !document.hasFocus()) return;
        window.restoreWalletModalAfterPrivy?.(true);
        window.showPrivyRetry?.();
        showWalletStatus('walletConnectStatus', '⚠️ Privy did not appear. Tap Open Privy Login again, and allow popups/third-party cookies if your browser asks.', 'warning');
    }, 12000);
}

window.watchPrivyOpen = watchPrivyOpen;

window.showPrivyRetry = showPrivyRetry;
window.schedulePrivyRetry = function () {
    clearTimeout(window.GMPrivyRetryTimer);
    window.GMPrivyRetryTimer = setTimeout(function () {
        if (document.getElementById('walletModal')?.classList.contains('active')) showPrivyRetry();
    }, 2500);
};

function beginPrivyLogin(fromUserTap) {
    if (!window.GM_PRIVY_CONFIG || !window.GM_PRIVY_CONFIG.enabled) {
        showWalletStatus('walletConnectStatus', 'Privy login is temporarily hidden. Please use MiniPay, Trust Wallet, MetaMask, or WalletConnect.', 'info');
        return;
    }
    hidePrivyRetry();
    window.GMPrivyAutoOpenRequested = true;
    if (typeof window.GMPrivyLogin === 'function') {
        window.GMPrivyLogin(!!fromUserTap);
        return;
    }
    if (!window.GM_PRIVY_CONFIG || !window.GM_PRIVY_CONFIG.appId) {
        showWalletStatus('walletConnectStatus', '❌ Privy is not configured. Set PRIVY_APP_ID in the server environment.', 'error');
        return;
    }
    showWalletStatus('walletConnectStatus', '⏳ Loading Privy… tap Open Privy Login again in a moment.', 'info');
    showPrivyRetry();
}


function showWalletConnectOptions() {
    document.getElementById('walletOptions').style.display = 'none';
    const f = document.getElementById('walletConnectOptions');
    if (f) f.classList.add('visible');
    // Reset the QR area so returning here (Back, or a retry) always
    // starts from the progress state instead of a stale QR.
    const qrWrap = document.getElementById('wcQrWrap');
    if (qrWrap) qrWrap.style.display = 'none';
    const loader = document.getElementById('wcLoading');
    if (loader) loader.hidden = true;
    detectInjectedWallet();
}

// Tapping "Connect GoodWallet" should start the WalletConnect session
// straight away — the intermediate "Show WalletConnect QR / URI" button
// was a redundant second tap. This opens the panel AND starts, while
// showWalletConnectOptions() stays the plain reset used by the Back
// button (it must never auto-start, or Back would launch a new session).
function openGoodWalletConnect() {
    showWalletConnectOptions();
    connectWalletConnect();
}

function showWalletStatus(targetId, message, type = 'info') {
    const el = document.getElementById(targetId);
    if (el) {
        el.className = 'status-message ' + type;
        el.textContent = message;
    }
    if (targetId === 'walletConnectStatus') {
        const panel = document.getElementById('walletConnectPanelStatus');
        const wcOptions = document.getElementById('walletConnectOptions');
        if (panel && wcOptions && wcOptions.classList.contains('visible')) {
            // Keep the `wc-status-banner` hook — assigning className
            // wholesale would drop it and the banner styling with it.
            panel.className = 'status-message wc-status-banner ' + type;
            panel.textContent = message;
        }
    }
}

// EIP-6963 provider discovery — Trust Wallet (mobile dApp browser +
// extension), Rabby, Coinbase Wallet, and current MetaMask builds all
// announce themselves via `eip6963:announceProvider`. Recent Trust
// Wallet mobile builds no longer guarantee a `window.ethereum`
// injection, so if we only look at `window.ethereum` we miss them.
window.__announced6963Providers = window.__announced6963Providers || [];
(function _initEip6963Discovery() {
    try {
        window.addEventListener('eip6963:announceProvider', (event) => {
            const detail = event && event.detail;
            if (!detail || !detail.provider) return;
            const uuid = detail.info && detail.info.uuid;
            const already = window.__announced6963Providers.find(d =>
                (d.info && d.info.uuid && uuid && d.info.uuid === uuid) ||
                d.provider === detail.provider
            );
            if (!already) window.__announced6963Providers.push(detail);
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        // Late-injecting wallets (Trust Wallet / MetaMask Mobile dApp
        // browser) may announce after DOMContentLoaded finishes. Retry
        // a few times over ~1.2s so discovery completes before the user
        // taps "Injected Wallet" on the login sheet.
        let _eipRetries = 0;
        const _eipTimer = setInterval(() => {
            try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
            if (++_eipRetries >= 6) clearInterval(_eipTimer);
        }, 200);
        window.addEventListener('ethereum#initialized', () => {
            try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        }, { once: true });
    } catch (_) { /* older browsers / strict CSPs */ }
})();

function _eip6963Details() {
    return Array.isArray(window.__announced6963Providers)
        ? window.__announced6963Providers.slice()
        : [];
}

function _coerceToRequestProvider(candidate) {
    if (!candidate) return null;
    if (typeof candidate.request === 'function') return candidate;

    // Trust Wallet mobile variants sometimes expose the EIP-1193
    // provider under nested objects instead of directly on
    // window.trustwallet.
    if (candidate.ethereum && typeof candidate.ethereum.request === 'function') return candidate.ethereum;
    if (candidate.provider && typeof candidate.provider.request === 'function') return candidate.provider;

    // Backward compatibility: build an EIP-1193-like request wrapper
    // around legacy send/sendAsync providers when possible.
    const sendAsync = typeof candidate.sendAsync === 'function'
        ? candidate.sendAsync.bind(candidate)
        : (typeof candidate.send === 'function' ? candidate.send.bind(candidate) : null);
    if (!sendAsync) return null;

    candidate.request = ({ method, params }) => new Promise((resolve, reject) => {
        const payload = {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params: Array.isArray(params) ? params : []
        };
        sendAsync(payload, (err, res) => {
            if (err) return reject(err);
            if (res && res.error) return reject(res.error);
            resolve(res && Object.prototype.hasOwnProperty.call(res, 'result') ? res.result : res);
        });
    });
    return candidate;
}

function getAllInjectedProviders() {
    const out = [];
    const push = (p) => {
        const provider = _coerceToRequestProvider(p);
        if (provider && !out.includes(provider)) out.push(provider);
    };
    const pushTrustWalletInjection = () => {
        const trustRoot = window.trustwallet || window.trustWallet || null;
        if (!trustRoot) return;
        // Some Trust Wallet builds expose both root + nested ethereum
        // objects. Keep only one canonical object to avoid duplicate
        // candidates that can confuse provider picking.
        const canonical = (trustRoot.ethereum && typeof trustRoot.ethereum.request === 'function')
            ? trustRoot.ethereum
            : trustRoot;
        push(canonical);
    };
    const eth = window.ethereum;
    if (eth) {
        if (Array.isArray(eth.providers) && eth.providers.length) {
            eth.providers.forEach(push);
        }
        push(eth);
    }
    // Trust Wallet's branded injection (mobile dApp browser + desktop
    // extension). Hyphen / casing varies across versions.
    pushTrustWalletInjection();
    for (const detail of _eip6963Details()) push(detail.provider);
    return out;
}

// Exposes a console diagnostic for the "wallet not detected" reports we
// get from Trust Wallet users. Open the homepage inside the dApp
// browser, then in the DevTools / remote console call
// `window._gmDebugDumpWallets()` to see what the page actually sees.
window._gmDebugDumpWallets = function _gmDebugDumpWallets() {
    const providers = getAllInjectedProviders();
    const info6963 = _eip6963Details().map(d => ({
        rdns: d.info && d.info.rdns,
        name: d.info && d.info.name,
        uuid: d.info && d.info.uuid
    }));
    const snapshot = {
        userAgent: navigator.userAgent,
        hasWindowEthereum: !!window.ethereum,
        ethereumIsTrust: !!(window.ethereum && window.ethereum.isTrust),
        ethereumIsTrustWallet: !!(window.ethereum && window.ethereum.isTrustWallet),
        ethereumIsMetaMask: !!(window.ethereum && window.ethereum.isMetaMask),
        ethereumIsMiniPay: !!(window.ethereum && window.ethereum.isMiniPay),
        hasWindowTrustwallet: !!window.trustwallet,
        hasWindowTrustWallet: !!window.trustWallet,
        nestedProvidersLength: (window.ethereum && Array.isArray(window.ethereum.providers))
            ? window.ethereum.providers.length : 0,
        eip6963Count: info6963.length,
        eip6963: info6963,
        collectedProviderCount: providers.length,
        collectedProviderFlags: providers.map(p => ({
            isTrust: !!p.isTrust,
            isTrustWallet: !!p.isTrustWallet,
            isMetaMask: !!p.isMetaMask,
            isMiniPay: !!p.isMiniPay,
            isBraveWallet: !!p.isBraveWallet,
            isCoinbaseWallet: !!p.isCoinbaseWallet
        }))
    };
    try { console.log('[GoodMarket wallet debug]', JSON.stringify(snapshot, null, 2)); } catch (_) {}
    return snapshot;
};

// EIP-5749 helper: prefer MetaMask provider when multiple injected providers are present.
function getEip5749Provider() {
    const providers = getAllInjectedProviders();
    if (!providers.length) return null;
    if (providers.length > 1) {
        const metaMaskProvider = providers.find(p => p && p.isMetaMask && !p.isBraveWallet);
        if (metaMaskProvider) return metaMaskProvider;
    }
    return providers[0] || null;
}

function isMobileDappContext() {
    const ua = (navigator.userAgent || '').toLowerCase();
    return /android|iphone|ipad|ipod|minipay|trust|metamask/.test(ua);
}

// Decide whether the Injected Wallet picker card should be shown.
// Plain mobile Safari/Chrome users without a wallet have nothing
// to inject — surfacing the option just confuses them. Show only
// when (a) a provider is actually present, or (b) the UA hints a
// known wallet's in-app dApp browser.
function shouldShowInjectedOption() {
    try {
        if (typeof window !== 'undefined') {
            if (window.ethereum) return true;
            if (window.trustwallet || window.trustWallet) return true;
        }
    } catch (_) {}
    try {
        if (getAllInjectedProviders().length > 0) return true;
    } catch (_) {}
    const ua = (navigator.userAgent || '').toLowerCase();
    // Strict UA match for known dApp wallet browsers (not generic
    // mobile UAs). MetaMask Mobile injects "MetaMaskMobile";
    // MiniPay injects "MiniPay"; Trust Wallet injects "Trust"
    // or "TrustWallet" (sometimes only in custom builds).
    if (/minipay|trustwallet|trust\/|metamask/.test(ua)) return true;
    return false;
}

function _eip6963InfoForProvider(provider) {
    if (!provider) return null;
    const detail = _eip6963Details().find(d => d && d.provider === provider);
    return (detail && detail.info) || null;
}

function _looksLikeTrustWalletInfo(info) {
    if (!info) return false;
    const rdns = String(info.rdns || '').toLowerCase();
    const name = String(info.name || '').toLowerCase();
    return rdns.includes('trustwallet') || name.includes('trust');
}

function _isTrustWalletProvider(provider) {
    if (!provider) return false;
    if (provider.isTrust) return true;
    return _looksLikeTrustWalletInfo(_eip6963InfoForProvider(provider));
}

function _isCoinbaseWalletProvider(provider) {
    return !!(provider && provider.isCoinbaseWallet);
}

function _isBraveWalletProvider(provider) {
    return !!(provider && provider.isBraveWallet);
}

function _isOkxWalletProvider(provider) {
    return !!(provider && provider.isOkxWallet);
}

function getInjectedProviderLabel(provider) {
    if (!provider) return null;
    if (provider.isMiniPay) return 'MiniPay';
    if (_isTrustWalletProvider(provider)) return 'Trust Wallet';
    if (_isCoinbaseWalletProvider(provider)) return 'Coinbase Wallet';
    if (_isBraveWalletProvider(provider)) return 'Brave Wallet';
    if (_isOkxWalletProvider(provider)) return 'OKX Wallet';
    if (provider.isMetaMask && !provider.isBraveWallet) return 'MetaMask';
    return 'Injected Wallet';
}

function getInjectedProviderIcon(provider) {
    if (!provider) return '👛';
    if (provider.isMiniPay) return '📱';
    if (_isTrustWalletProvider(provider)) return '🛡️';
    if (_isCoinbaseWalletProvider(provider)) return '🟦';
    if (_isBraveWalletProvider(provider)) return '🦁';
    if (_isOkxWalletProvider(provider)) return '⭕';
    if (provider.isMetaMask && !provider.isBraveWallet) return '🦊';
    return '👛';
}

function _trustProviderFromEip6963() {
    const detail = _eip6963Details().find(d => _looksLikeTrustWalletInfo(d.info));
    return _coerceToRequestProvider((detail && detail.provider) || null);
}

function getPreferredInjectedProvider() {
    const providers = getAllInjectedProviders();
    if (!providers.length) return null;

    const ua = (navigator.userAgent || '').toLowerCase();
    const uaIsTrust = ua.includes('trust') || ua.includes('trustwallet');

    // Mobile dapp browsers: MiniPay > Trust Wallet > MetaMask > generic.
    const miniPayProvider = providers.find(p => p && p.isMiniPay);
    if (miniPayProvider) return miniPayProvider;
    const trustProvider = providers.find(p => p && p.isTrust);
    if (trustProvider) return trustProvider;
    const coinbaseProvider = providers.find(p => _isCoinbaseWalletProvider(p));
    if (coinbaseProvider) return coinbaseProvider;
    const braveProvider = providers.find(p => _isBraveWalletProvider(p));
    if (braveProvider) return braveProvider;
    const okxProvider = providers.find(p => _isOkxWalletProvider(p));
    if (okxProvider) return okxProvider;
    // Inside Trust Wallet's dApp browser the injected provider may not
    // self-identify via isTrust; fall back to EIP-6963's rdns match.
    if (uaIsTrust) {
        const trust6963 = _trustProviderFromEip6963();
        if (trust6963) return trust6963;
    }
    const metaMaskProvider = providers.find(p => p && p.isMetaMask && !p.isBraveWallet);
    if (metaMaskProvider) return metaMaskProvider;

    // Multi-provider desktop fallback helper (EIP-5749).
    return isMobileDappContext() ? (providers[0] || null) : getEip5749Provider();
}

// Async variant of getPreferredInjectedProvider that waits briefly for
// late-arriving EIP-6963 announcements. Trust Wallet mobile (recent
// builds) and some MetaMask Mobile builds inject / announce their
// provider asynchronously — a first, synchronous pick can return null
// even though the wallet is actually present. Callers that gate user
// actions (connect button) should await this instead.
function isTrustWalletMobileContext() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const uaTrust = ua.includes('trust') || ua.includes('trustwallet');
    const touchMobile = /android|iphone|ipad|ipod/i.test(ua);
    const hasTrustInjection = !!(
        window.trustwallet ||
        window.trustWallet ||
        (window.ethereum && (window.ethereum.isTrust || window.ethereum.isTrustWallet))
    );
    return (uaTrust || hasTrustInjection) && touchMobile;
}

function isLikelyMobileWalletContext() {
    const ua = (navigator.userAgent || '').toLowerCase();
    return /android|iphone|ipad|ipod|minipay|metamask|trust|trustwallet/.test(ua);
}

async function awaitPreferredInjectedProvider(timeoutMs) {
    // Trust Wallet mobile can inject late; give all mobile dApp contexts
    // a bigger budget so Trust builds with generic UA strings still pass.
    const budget = typeof timeoutMs === 'number'
        ? timeoutMs
        : (isTrustWalletMobileContext() ? 3200 : (isLikelyMobileWalletContext() ? 2200 : 300));
    const stepMs = 120;
    const start = Date.now();
    let first = getPreferredInjectedProvider();
    if (first) return first;
    while (Date.now() - start < budget) {
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        await new Promise(r => setTimeout(r, stepMs));
        const p = getPreferredInjectedProvider();
        if (p) return p;
    }
    return null;
}

// Warm-up re-discovery only for Trust Wallet mobile context.
if (isTrustWalletMobileContext()) {
    window.addEventListener('pageshow', () => {
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        detectInjectedWallet();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        detectInjectedWallet();
    });
}

// Maximum retry depth for detectInjectedWallet's auto-retry loop.
// Trust Wallet mobile gets a longer budget because its injection
// timing is the most variable. Each retry waits (350 + depth*250)ms,
// so depth=12 ≈ 8.6s total; depth=6 ≈ 2.5s. Desktop extensions inject
// synchronously, so the desktop depth is short — a user without an
// extension should see the settled "Not detected" copy fast instead of
// seconds of flicker.
function _walletDetectionMaxDepth() {
    return isTrustWalletMobileContext() ? 12 : (isLikelyMobileWalletContext() ? 9 : 2);
}

// Pending retry timer for detectInjectedWallet. Stored at module
// scope so new detection cycles (e.g. modal re-open,
// visibilitychange re-trigger) can cancel the in-flight retry chain
// before starting their own — otherwise concurrent chains interleave
// and flicker the description text at different depths.
let _detectWalletTimerId = null;
function detectInjectedWallet(_retryDepth) {
    // Cancel any pending retry from a previous chain so we never run
    // two chains concurrently against the same DOM nodes.
    if (_detectWalletTimerId !== null) {
        clearTimeout(_detectWalletTimerId);
        _detectWalletTimerId = null;
    }

    // Re-dispatch EIP-6963 requestProvider on every call — wallets that
    // inject late (Trust Wallet mobile in some builds) will announce
    // themselves only after we ask, and there's no harm in asking twice.
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

    const provider = getPreferredInjectedProvider();
    const title = document.getElementById('injectedWalletTitle');
    const desc = document.getElementById('injectedWalletDesc');
    const btn = document.getElementById('injectedWalletBtn');
    const icon = document.getElementById('injectedWalletIcon');
    if (!title || !desc || !btn) return;
    // Hide the Injected Wallet picker entirely on plain mobile
    // Safari/Chrome (no provider, no dApp-browser UA). Reveal
    // it as soon as a provider is found or the UA hints a
    // wallet's in-app browser.
    if (!shouldShowInjectedOption() && !provider) {
        btn.style.display = 'none';
        return;
    }
    btn.style.display = 'flex';
    const depth = Number(_retryDepth || 0);
    const maxDepth = _walletDetectionMaxDepth();
    if (!provider) {
        title.textContent = 'Injected Wallet';
        if (icon) icon.textContent = '👛';
        if (isMobileDappContext()) {
            desc.textContent = depth >= 2
                ? 'Still looking for your wallet… use WalletConnect below if it stays stuck.'
                : 'Detecting wallet… open in MiniPay/MetaMask/Trust Wallet dapp browser, or use WalletConnect.';
        } else {
            desc.textContent = 'Not detected — install MetaMask extension or use WalletConnect QR.';
        }
        btn.style.opacity = '0.78';
        if (typeof _lwApplyDetectionNudge === 'function') _lwApplyDetectionNudge(null);
        if (depth < maxDepth) {
            _detectWalletTimerId = setTimeout(() => {
                _detectWalletTimerId = null;
                detectInjectedWallet(depth + 1);
            }, 350 + depth * 250);
        }
        return;
    }
    const name = getInjectedProviderLabel(provider);
    title.textContent = name;
    if (icon) icon.textContent = getInjectedProviderIcon(provider);
    desc.textContent = `${name} detected — connect wallet, then approve signature to login`;
    btn.style.opacity = '1';
    if (typeof _lwApplyDetectionNudge === 'function') _lwApplyDetectionNudge(provider);
}

// Aggressive EIP-6963 re-dispatch loop for mobile dApp contexts.
// Most wallets that implement EIP-6963 listen for the synchronous
// `eip6963:requestProvider` event and respond with an `:announceProvider`
// event. Late-initialising wallets miss the first dispatch, so we
// dispatch frequently for the first few seconds after page load.
(function _startEip6963DispatchLoop() {
    if (typeof window === 'undefined') return;
    const dispatch = () => {
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
    };
    // Burst every 200ms for the first 3 seconds, then every 600ms for
    // another 5 seconds. Stops early once a provider is discovered so
    // we don't spam announcers on the session forever.
    let elapsed = 0;
    const burstEvery = 200;
    const burstDuration = 3000;
    const coolEvery = 600;
    const totalDuration = 8000;
    const tick = () => {
        if (getPreferredInjectedProvider()) return;
        dispatch();
        elapsed += (elapsed < burstDuration) ? burstEvery : coolEvery;
        if (elapsed < totalDuration) {
            setTimeout(tick, elapsed < burstDuration ? burstEvery : coolEvery);
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tick, { once: true });
    } else {
        tick();
    }
    // Also re-tick on full page load for wallets that inject on
    // `load` rather than `DOMContentLoaded`, but only if the first
    // chain has already exhausted its budget. Otherwise we would
    // start a second tick() chain that shares the same `elapsed`
    // counter with the still-running first chain and would
    // double-advance it, halving the intended dispatch window.
    // Also skip re-ticking if a provider has already been
    // discovered — there is nothing left to announce for.
    window.addEventListener('load', () => {
        if (elapsed < totalDuration) return;
        if (getPreferredInjectedProvider()) return;
        setTimeout(tick, 200);
    }, { once: true });
})();

// Listen for the legacy "ethereum#initialized" signal some wallets
// dispatch when their EIP-1193 provider finishes hydrating. Also
// listen for the generic `ethereum` object being assigned via a
// late polyfill.
(function _hookLateEthereumInitializers() {
    if (typeof window === 'undefined') return;
    const retrigger = () => {
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        detectInjectedWallet();
    };
    window.addEventListener('ethereum#initialized', retrigger, { once: false });
    // Some Trust Wallet builds fire a custom `TrustWallet#initialized`.
    window.addEventListener('TrustWallet#initialized', retrigger, { once: false });
    // Also retrigger on visibility flips back into the tab — users
    // sometimes background the tab, open Trust, and come back.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') retrigger();
    });
})();

function syncReferralInputs(sourceEl) {
    const value = (sourceEl && sourceEl.value ? sourceEl.value : '').trim().toUpperCase();
    const ids = ['lwReferralCode'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el && el !== sourceEl && el.value !== value) el.value = value;
    });
    if (value) {
        try { sessionStorage.setItem('pending_referral_code', value); } catch (e) {}
    }
}

let referralBannerShown = false;

function initReferralFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        // Accept a few common param aliases so shortened/rewritten
        // referral links still auto-fill the referral boxes.
        let rawRef = '';
        ['ref', 'referral', 'referral_code', 'referralCode', 'r', 'code'].forEach(function (key) {
            if (!rawRef) {
                const v = (params.get(key) || '').trim();
                if (v) rawRef = v;
            }
        });
        // Support path-based referral links like "/r/CODE" or "/ref/CODE".
        if (!rawRef) {
            const pathMatch = (window.location.pathname || '').match(/\/(?:r|ref|referral)\/([A-Za-z0-9]+)\/?$/);
            if (pathMatch && pathMatch[1]) rawRef = pathMatch[1];
        }
        // Fragment fallback for links where the query string got stripped.
        if (!rawRef && window.location.hash) {
            const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
            rawRef = (hashParams.get('ref') || hashParams.get('referral') || '').trim();
        }
        const stored = (sessionStorage.getItem('pending_referral_code') || '').trim();
        const candidate = (rawRef || stored).toUpperCase();
        // Defense-in-depth: referral codes are 8 alphanumeric chars; reject anything else
        // so we never store or echo attacker-controlled values into the DOM / sessionStorage.
        const ref = /^[A-Z0-9]{4,16}$/.test(candidate) ? candidate : '';
        if (!ref) return;

        if (rawRef) {
            try { sessionStorage.setItem('pending_referral_code', ref); } catch (e) {}
        }

        // Only the local-wallet create form collects referral codes.
        const lwEl = document.getElementById('lwReferralCode');
        if (lwEl && !lwEl.value.trim()) lwEl.value = ref;

        // Show the referral banner only once per page load — after it
        // auto-dismisses we don't want subsequent openWalletModal() calls
        // to re-create and flash it to the user again.
        if (!referralBannerShown && !document.getElementById('referralBanner')) {
            referralBannerShown = true;
            const banner = document.createElement('div');
            banner.id = 'referralBanner';
            banner.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:9998;max-width:92%;padding:0.7rem 1rem;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,0.18);font-size:0.86rem;text-align:center;line-height:1.5;';
            // Use textContent to prevent any HTML injection via the URL-derived ref value.
            banner.textContent = '🎁 Referral applied — Code ' + ref + ' will be used when you create a free GoodMarket account (email + PIN).';
            document.body.appendChild(banner);
            setTimeout(function () { banner.style.transition = 'opacity 0.6s'; banner.style.opacity = '0'; setTimeout(function () { banner.remove(); }, 700); }, 8000);
        }
    } catch (err) {
        console.warn('initReferralFromUrl failed:', err);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReferralFromUrl);
} else {
    initReferralFromUrl();
}
// Defensive re-run after full load in case the referral inputs were
// still mounting when the first pass ran.
window.addEventListener('load', initReferralFromUrl);
function makeLoginMessage(address) {
    return `Login to GoodMarket\nWallet: ${address}\nTime: ${new Date().toISOString()}`;
}

function utf8ToHex(message) {
    if (typeof message !== 'string') return '0x';
    return '0x' + Array.from(new TextEncoder().encode(message))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function postVerifyIdentity(walletAddress, signature, message, referralCode = '', loginMethod = 'injected', options = {}) {
    const resp = await fetch('/verify-identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            wallet_address: walletAddress,
            signature,
            message,
            referral_code: options.referralEligible ? (referralCode || '') : '',
            referral_eligible: !!options.referralEligible,
            privy_wallet_client_type: options.privyWalletClientType || '',
            // Persist HOW the user logged in so every feature page picks the
            // matching signer: WalletConnect logins must never fall back to an
            // injected desktop wallet (e.g. MetaMask) whose account differs
            // from the GoodMarket wallet, which surfaces as "Wrong wallet
            // connected" on Claim / Swap / Reloadly / Send.
            login_method: loginMethod
        })
    });
    const data = await resp.json();
    if (!(resp.ok && data.success)) {
        throw new Error(data.error || data.message || 'Identity verification failed');
    }
    return _gmApplyReturnTo(data);
}

async function ensureCeloChain(provider) {
    const isCeloChain = (chainId) => String(chainId || '').toLowerCase() === CELO_NETWORK.chainId;
    const switchToCelo = () => provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CELO_NETWORK.chainId }]
    });
    try {
        const current = await provider.request({ method: 'eth_chainId' });
        if (isCeloChain(current)) return true;
    } catch (_) { /* some wallets don't support eth_chainId pre-connect */ }
    try {
        await switchToCelo();
    } catch (switchErr) {
        if (switchErr && (switchErr.code === 4902 || /unrecognized|not added/i.test(switchErr.message || ''))) {
            try {
                await provider.request({
                    method: 'wallet_addEthereumChain',
                    params: [CELO_NETWORK]
                });
                // Adding a network does not necessarily select it.
                // Explicitly switch after MetaMask/another extension
                // accepts the Celo configuration.
                await switchToCelo();
            } catch (addErr) {
                console.warn('Failed to add Celo network to wallet:', addErr);
                return false;
            }
        } else {
            console.warn('Failed to switch wallet to Celo:', switchErr);
            return false;
        }
    }
    // Do not sign until the extension confirms it actually selected
    // Celo. Some providers acknowledge an add/switch without changing
    // the active chain immediately.
    try {
        return isCeloChain(await provider.request({ method: 'eth_chainId' }));
    } catch (verifyErr) {
        console.warn('Could not verify Celo network after switch:', verifyErr);
        return false;
    }
}

async function requestGoodDollarToken(provider) {
    // `wallet_watchAsset` ALWAYS opens a wallet confirmation on desktop
    // MetaMask. Doing it on every login put an "Add token?" dialog between the
    // network switch and the login signature — the user thinks they are already
    // signing in. Ask once per browser session instead; a user who declines can
    // still add G$ from the wallet page.
    const WATCH_FLAG = 'gmWatchAssetAsked_v1';
    try {
        if (sessionStorage.getItem(WATCH_FLAG) === '1') return false;
    } catch (_) { /* storage blocked — fall through and ask once */ }
    try {
        // There is no EIP-1193 method to query a wallet's watched-token
        // list, so a session flag is the only way to avoid re-prompting.
        const added = await provider.request({
            method: 'wallet_watchAsset',
            params: GOODDOLLAR_TOKEN
        });
        if (added) console.info('GoodDollar (G$) token added to wallet.');
        return !!added;
    } catch (err) {
        // wallet_watchAsset is optional. A wallet that does not support
        // it, or a user who declines its confirmation, must still be
        // able to log in and use Celo.
        console.info('GoodDollar token setup was skipped or is unsupported:', err && err.message);
        return false;
    } finally {
        try { sessionStorage.setItem(WATCH_FLAG, '1'); } catch (_) {}
    }
}

// A hung wallet request (asleep extension service worker, stuck mobile dApp
// browser) must not leave the connect flow spinning forever.
function withInjectedSignTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error(message || 'Your wallet did not respond. Please try again.'));
        }, ms || 120000);
        Promise.resolve(promise).then(
            (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
            (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
        );
    });
}

async function connectInjectedWallet() {
    showWalletStatus('walletConnectStatus', '⏳ Detecting wallet…', 'info');
    const provider = await awaitPreferredInjectedProvider();
    if (!provider) {
        if (isTrustWalletMobileContext()) {
            showWalletStatus('walletConnectStatus', '⚠️ Trust Wallet injection not detected yet. Starting WalletConnect automatically…', 'warning');
            await connectWalletConnect();
            return;
        }
        showWalletStatus('walletConnectStatus', 'No injected wallet found. Use WalletConnect QR to connect.', 'error');
        return;
    }
    showWalletStatus('walletConnectStatus', '⏳ Connecting wallet… approve account access in your wallet.', 'info');
    try {
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        if (!accounts || !accounts.length) throw new Error('No wallet account found.');
        const wallet = accounts[0];
        let onCelo = false;
        if (provider && provider.isMiniPay) {
            // MiniPay is Celo-only. Skip any chain-switch prompts.
            onCelo = true;
            try {
                const chainId = await provider.request({ method: 'eth_chainId' });
                if (String(chainId || '').toLowerCase() !== CELO_NETWORK.chainId) {
                    console.warn('MiniPay reported non-Celo chainId:', chainId);
                }
            } catch (_) {
                // Continue login flow; MiniPay should still be Celo-only.
            }
        } else {
            showWalletStatus('walletConnectStatus', '🔀 Switching your wallet to the Celo network…', 'info');
            onCelo = await ensureCeloChain(provider);
            if (!onCelo) {
                showWalletStatus('walletConnectStatus', '⚠️ Could not switch to Celo automatically — please switch manually in your wallet and try again.', 'warning');
                return;
            }
        }
        showWalletStatus('walletConnectStatus', '🪙 Optional: confirm in your wallet to add GoodDollar (G$) on Celo…', 'info');
        await requestGoodDollarToken(provider);
        const message = makeLoginMessage(wallet);
        const messageHex = utf8ToHex(message);
        showWalletStatus('walletConnectStatus', '✍️ Signature request sent. Approve the login message in your wallet.', 'info');
        const signature = await withInjectedSignTimeout(
            provider.request({ method: 'personal_sign', params: [messageHex, wallet] }),
            120000,
            'Your wallet did not respond to the signature request. Open MetaMask, make sure it is unlocked, then try again.'
        );
        const verifyData = await postVerifyIdentity(wallet, signature, message, '', 'injected');
        // Drop any WalletConnect session left over from an earlier sign-in
        // so feature pages don't misclassify this injected login as
        // WalletConnect (which would force a QR prompt instead of MetaMask).
        // Per-wallet: a session belonging to a DIFFERENT wallet is untouched.
        try {
            if (typeof GMWalletConnect !== 'undefined') {
                if (typeof GMWalletConnect.clearStoredSessionFor === 'function') {
                    GMWalletConnect.clearStoredSessionFor(wallet);
                } else if (typeof GMWalletConnect.clearStoredSession === 'function') {
                    GMWalletConnect.clearStoredSession();
                }
            }
        } catch (_) {}
        const okMsg = (verifyData && verifyData.referral_warning)
            ? ('✅ Signature verified. ⚠️ ' + verifyData.referral_warning + ' Redirecting...')
            : '✅ Signature verified. Redirecting...';
        showWalletStatus('walletConnectStatus', okMsg, verifyData && verifyData.referral_warning ? 'warning' : 'success');
        _gmAfterLoginRedirect(verifyData && verifyData.referral_warning ? 2400 : 900);
    } catch (err) {
        const rawMsg = (err && err.message) ? err.message : 'Failed to connect injected wallet';
        const code = err && (err.code
            || (err.cause && err.cause.code)
            || (err.data && err.data.originalError && err.data.originalError.code));
        const rejected = code === 4001 || /reject|denied|cancel|user refused/i.test(rawMsg);
        showWalletStatus('walletConnectStatus', (rejected ? '❌ Signature or connection was rejected. ' : '❌ ') + rawMsg, rejected ? 'warning' : 'error');
    }
}

window._wcSignClient = null;
window._wcSession = null;
window._wcSdkLoading = null;

// Periodically extend the WalletConnect session before it expires (every 6 hours)
setInterval(function() {
    try {
        var topic = localStorage.getItem('wc_session_topic');
        var sessionData = localStorage.getItem('wc_session_data');
        if (!topic || !sessionData || !window._wcSignClient) return;
        var session = JSON.parse(sessionData);
        if (!session || !session.expiry) return;
        var secsLeft = session.expiry - Math.floor(Date.now() / 1000);
        if (secsLeft <= 0 || secsLeft > 2 * 24 * 3600) return;
        console.log('[WC] Periodic renewal: session expires in', Math.round(secsLeft / 3600), 'h');
        window._wcSignClient.extend({ topic: topic }).then(function() {
            console.log('[WC] Session renewed by periodic check');
            try { localStorage.setItem('wc_session_timestamp', Date.now().toString()); } catch(_) {}
            try {
                var active = window._wcSignClient.getActiveSessions ? window._wcSignClient.getActiveSessions() : {};
                var updated = active[topic];
                if (!updated && window._wcSignClient.session && window._wcSignClient.session.getAll) {
                    updated = window._wcSignClient.session.getAll().find(function(x) { return x.topic === topic; });
                }
                if (updated) localStorage.setItem('wc_session_data', JSON.stringify(updated));
            } catch(_) {}
        }).catch(function(e) { console.warn('[WC] Periodic renew failed:', e && e.message); });
    } catch(_) {}
}, 6 * 60 * 60 * 1000);

function _wcLoadSdk() {
    if (window._wcSdkLoading) return window._wcSdkLoading;
    window._wcSdkLoading = new Promise(function(resolve, reject) {
        var localSrc = GM_BOOT.wcBundleUrl || '';
        var cdnSrc = 'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.17.0/dist/index.umd.js';
        function loadScript(src, ok, fail) {
            var s = document.createElement('script');
            s.src = src; s.onload = ok; s.onerror = fail;
            document.head.appendChild(s);
        }
        loadScript(localSrc, function() {
            var SC = (window['@walletconnect/sign-client'] || {}).SignClient;
            if (SC) resolve(SC);
            else loadScript(cdnSrc, function() {
                var SC2 = (window['@walletconnect/sign-client'] || {}).SignClient;
                SC2 ? resolve(SC2) : reject(new Error('WalletConnect SDK unavailable'));
            }, function() { reject(new Error('WalletConnect SDK unavailable')); });
        }, function() {
            loadScript(cdnSrc, function() {
                var SC2 = (window['@walletconnect/sign-client'] || {}).SignClient;
                SC2 ? resolve(SC2) : reject(new Error('WalletConnect SDK unavailable'));
            }, function() { reject(new Error('WalletConnect SDK unavailable')); });
        });
    });
    return window._wcSdkLoading;
}

const _wcSidecarEnabled = !!(window.GM_GET_STARTED_BOOT || {}).wcSidecarEnabled;

// Wake the user's wallet app to the foreground after a WalletConnect
// request has been initiated. WalletConnect v2 expects the dApp to
// do this manually (the @walletconnect/modal SDK does the same trick
// internally) — without it, MetaMask Mobile / Trust Wallet silently
// queue the sign request and the user is left thinking nothing
// happened. We synthesize an `<a>`-click on the wallet's
// `session.peer.metadata.redirect.native` (custom scheme) or
// `redirect.universal` (https universal link) so the OS opens the
// wallet app without trying to navigate the dApp tab away.
function _wcIsMobileBrowser() {
    try {
        var ua = (navigator.userAgent || '').toLowerCase();
        return /android|iphone|ipad|ipod|mobile/i.test(ua);
    } catch (_) { return false; }
}
function _wcWakeWalletApp(session) {
    try {
        if (!session || !_wcIsMobileBrowser()) return;
        var meta = session.peer && session.peer.metadata;
        var redirect = meta && meta.redirect;
        if (!redirect) return;
        var href = redirect.native || redirect.universal;
        if (!href) return;
        var link = document.createElement('a');
        link.href = href;
        link.style.display = 'none';
        link.target = '_self';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { try { link.remove(); } catch (_) {} }, 100);
    } catch (_) { /* no-op */ }
}

function _wcGetClient() {
    if (window._wcSignClient) return Promise.resolve(window._wcSignClient);
    const projectId = GM_BOOT.projectId || '';
    if (!projectId) return Promise.reject(new Error('WALLETCONNECT_PROJECT_ID is not configured'));
    return _wcLoadSdk().then(function(SignClient) {
        return SignClient.init({
            projectId: projectId,
            metadata: {
                name: 'GoodMarket',
                description: 'Learn & Earn G$ with GoodMarket on Celo',
                url: window.location.origin,
                icons: [window.location.origin + '/static/icons/icon-192x192.png?v=' + (GM_BOOT.assetVersion || '') + '']
            }
        }).then(function(client) {
            window._wcSignClient = client;
            return client;
        });
    });
}

// The "Processing barcode and URI code…" state replaces the QR area
// while the session URI is generated, so the user sees progress from the
// first tap instead of an empty box. Hidden again the moment the QR is
// available (or on any failure).
function _wcSetLoading(active) {
    const loader = document.getElementById('wcLoading');
    if (loader) loader.hidden = !active;
}

function drawWalletConnectQr(uri) {
    const qrWrap = document.getElementById('wcQrWrap');
    const qrEl = document.getElementById('wcQrCode');
    const copyBtnContainer = document.getElementById('wcCopyBtnContainer');
    if (!qrWrap || !qrEl || !copyBtnContainer) return;
    _wcSetLoading(false);
    qrWrap.style.display = 'block';
    qrEl.innerHTML = '';
    copyBtnContainer.innerHTML = '';

    // Replace raw-URI text dump with a clean "Copy URI" button so
    // the modal looks polished. The URI is still kept on a data
    // attribute for the click handler to read.
    let copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    // Gradient indigo styling to match updated design
    copyBtn.style.cssText =
        'padding:0.65rem 1.2rem;border-radius:10px;border:1.5px solid rgba(99,102,241,0.5);' +
        'background:linear-gradient(135deg,rgba(99,102,241,0.2),rgba(99,102,241,0.1));color:#4f46e5;font-weight:600;font-size:0.85rem;' +
        'cursor:pointer;display:inline-flex;align-items:center;gap:0.5rem;' +
        'transition:all 0.2s;white-space:nowrap;';
    copyBtn.textContent = '📋 Copy link';
    copyBtn.addEventListener('mouseover', function() {
        this.style.background = 'linear-gradient(135deg,rgba(99,102,241,0.3),rgba(99,102,241,0.15))';
        this.style.borderColor = 'rgba(99,102,241,0.7)';
        this.style.transform = 'translateY(-2px)';
        this.style.boxShadow = '0 4px 12px rgba(99,102,241,0.3)';
    });
    copyBtn.addEventListener('mouseout', function() {
        this.style.background = 'linear-gradient(135deg,rgba(99,102,241,0.2),rgba(99,102,241,0.1))';
        this.style.borderColor = 'rgba(99,102,241,0.5)';
        this.style.transform = 'translateY(0)';
        this.style.boxShadow = 'none';
    });
    copyBtn.addEventListener('click', function() {
        const u = copyBtn.getAttribute('data-wc-uri') || '';
        if (!u) return;
        const showCopied = function() {
            const original = '📋 Copy link';
            copyBtn.textContent = '✓ Copied!';
            copyBtn.style.background = 'linear-gradient(135deg,rgba(16,185,129,0.25),rgba(16,185,129,0.1))';
            copyBtn.style.borderColor = 'rgba(16,185,129,0.6)';
            copyBtn.style.color = '#10b981';
            setTimeout(function() { 
                copyBtn.textContent = original;
                copyBtn.style.background = 'linear-gradient(135deg,rgba(99,102,241,0.2),rgba(99,102,241,0.1))';
                copyBtn.style.borderColor = 'rgba(99,102,241,0.5)';
                copyBtn.style.color = '#4f46e5';
            }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(u).then(showCopied, function() {
                // Fallback for older / non-secure contexts.
                try {
                    const ta = document.createElement('textarea');
                    ta.value = u; ta.setAttribute('readonly', '');
                    ta.style.position = 'absolute'; ta.style.left = '-9999px';
                    document.body.appendChild(ta); ta.select();
                    document.execCommand('copy'); document.body.removeChild(ta);
                    showCopied();
                } catch (_) {}
            });
        } else {
            try {
                const ta = document.createElement('textarea');
                ta.value = u; ta.setAttribute('readonly', '');
                ta.style.position = 'absolute'; ta.style.left = '-9999px';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
                showCopied();
            } catch (_) {}
        }
    });
    copyBtn.setAttribute('data-wc-uri', uri || '');
    copyBtnContainer.appendChild(copyBtn);

    // Smaller QR (180px) keeps the entire compact-mode modal in
    // a single phone viewport without internal scrolling. Still
    // well above the WalletConnect 150px minimum scan size.
    const qrPx = 180;
    try {
        if (window.QRCode) {
            new window.QRCode(qrEl, {
                text: uri,
                width: qrPx,
                height: qrPx,
                correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : undefined
            });
            return;
        }
    } catch (qrErr) {
        console.warn('Local QR render failed; falling back to image endpoint.', qrErr);
    }

    const qrImg = document.createElement('img');
    qrImg.alt = 'WalletConnect QR';
    qrImg.width = qrPx;
    qrImg.height = qrPx;
    qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + qrPx + 'x' + qrPx + '&data=' + encodeURIComponent(uri);
    qrEl.appendChild(qrImg);
    
    // The deep links below are the primary path on mobile (a phone
    // cannot scan its own screen), so the "Choose another method"
    // escape stays visible under them. The old handler toggled
    // #wcQrContainer against #wcInstructions — but #wcInstructions
    // lives INSIDE #wcQrContainer, so the toggle was dead, and it also
    // overwrote the button's label on the first click.
    const backBtn = document.getElementById('wcBackBtn');
    if (backBtn) backBtn.style.display = 'block';
}

let _wcConnecting = false;

async function connectWalletConnect() {
    // Guard against a double-tap opening two concurrent sessions.
    if (_wcConnecting) return;
    _wcConnecting = true;
    const qrWrap = document.getElementById('wcQrWrap');
    if (qrWrap) qrWrap.style.display = 'none';
    _wcSetLoading(true);
    showWalletStatus('walletConnectStatus', '⏳ Processing barcode and URI code…', 'info');
    if (_wcSidecarEnabled) {
        try {
            const sidecarCtrl = new AbortController();
        const sidecarTimeout = setTimeout(() => sidecarCtrl.abort(), 7000);
        let uriResp = null;
        try {
            uriResp = await fetch('/api/wc-uri', { signal: sidecarCtrl.signal });
        } finally {
            clearTimeout(sidecarTimeout);
        }
        if (!uriResp.ok) {
            throw new Error('WalletConnect sidecar unavailable');
        }
        const uriData = await uriResp.json();
        if (!(uriData.success && uriData.uri && uriData.id)) {
            throw new Error(uriData.error || 'WalletConnect sidecar unavailable');
        }
        drawWalletConnectQr(uriData.uri);
        _renderWalletConnectDeepLinks(uriData.uri);
        showWalletStatus('walletConnectStatus', '📲 Awaiting wallet approval. Tap the button below to open your wallet, or scan the QR from another device.', 'info');
        const started = Date.now();
        while (Date.now() - started < 120000) {
            await new Promise(r => setTimeout(r, 2200));
            const stResp = await fetch('/api/wc-session/' + encodeURIComponent(uriData.id));
            const stData = await stResp.json();
            if (stData.status === 'approved' && stData.address) {
                const message = makeLoginMessage(stData.address);
                showWalletStatus('walletConnectStatus', '✍️ Signature request sent. Approve login signature in your wallet.', 'info');
                const signResp = await fetch('/api/wc-sign/' + encodeURIComponent(uriData.id), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message, address: stData.address })
                });
                const signData = await signResp.json();
                if (!signResp.ok || !signData.signature) {
                    throw new Error(signData.error || 'WalletConnect signature failed');
                }
                const wcVerifyData = await postVerifyIdentity(stData.address, signData.signature, message, '', 'walletconnect');
                const wcOkMsg = (wcVerifyData && wcVerifyData.referral_warning)
                    ? ('✅ Wallet connected via WalletConnect. ⚠️ ' + wcVerifyData.referral_warning + ' Redirecting...')
                    : '✅ Wallet connected via WalletConnect. Redirecting...';
                showWalletStatus('walletConnectStatus', wcOkMsg, wcVerifyData && wcVerifyData.referral_warning ? 'warning' : 'success');
                _wcSetLoading(false);
                _wcConnecting = false;
                _gmAfterLoginRedirect(wcVerifyData && wcVerifyData.referral_warning ? 2400 : 900);
                return;
            }
            if (stData.status === 'rejected') throw new Error('WalletConnect request rejected by wallet.');
        }
            throw new Error('WalletConnect session timed out. Please try again.');
        } catch (serverErr) {
            console.warn('Sidecar WalletConnect unavailable, using browser fallback:', serverErr);
            _logWalletConnectFrontend('sidecar_unavailable', {
                stage: 'sidecar',
                message: (serverErr && serverErr.message) ? serverErr.message : String(serverErr || '')
            });
            showWalletStatus('walletConnectStatus', '⚠️ WalletConnect relay unavailable. Trying in-browser WalletConnect fallback…', 'warning');
        }
    } else {
        showWalletStatus('walletConnectStatus', 'ℹ️ Serverless mode detected. Using in-browser WalletConnect directly…', 'info');
    }

    // In-browser SignClient fallback. Before this fix this path
    // could silently hang forever if the relay WebSocket
    // (wss://relay.walletconnect.com) was unreachable, or if
    // SignClient.connect() took too long to return a URI: the
    // yellow "relay unavailable / trying fallback" message would
    // just sit on screen with no progress, no QR, and no error.
    // Now each stage is timeboxed with a stage-specific error so
    // users on Vercel (where the Node sidecar is always
    // unavailable) know what actually failed instead of staring
    // at a stuck warning.
    function _wcWithTimeout(promise, ms, stage) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const err = new Error('WC_FALLBACK_TIMEOUT:' + stage);
                err._wcStage = stage;
                reject(err);
            }, ms);
            promise.then(
                v => { clearTimeout(timer); resolve(v); },
                e => { clearTimeout(timer); reject(e); }
            );
        });
    }
    try {
        showWalletStatus('walletConnectStatus', '⏳ Processing barcode and URI code…', 'info');
        const client = await _wcWithTimeout(_wcGetClient(), 20000, 'sdk_init');
        showWalletStatus('walletConnectStatus', '⏳ Processing barcode and URI code…', 'info');
        // Request both Celo (42220) and XDC (50) in optionalNamespaces so
        // the session supports cross-chain signing on the XDC wallet page.
        // Without eip155:50 here, client.request({ chainId:"eip155:50" })
        // is rejected by the WC SDK ("chain not approved") and the wallet
        // app falls back to Celo — showing "Celo" in the signature prompt
        // even when the user is on the XDC claim page.
        const result = await _wcWithTimeout(client.connect({
            requiredNamespaces: {},
            optionalNamespaces: {
                eip155: {
                    methods: ['eth_accounts', 'eth_sendTransaction', 'eth_getTransactionReceipt', 'eth_chainId', 'personal_sign'],
                    chains: ['eip155:42220', 'eip155:50'],
                    events: ['chainChanged', 'accountsChanged']
                }
            }
        }), 15000, 'connect');
        if (result.uri) {
            drawWalletConnectQr(result.uri);
            // Add a one-tap deep link to the mobile wallet for users
            // on the same phone as the wallet (common on our
            // Vercel deployment where Trust Wallet / MetaMask
            // Mobile users open goodmarket.live inside the wallet
            // app's own browser — scanning their own QR is
            // awkward).
            _renderWalletConnectDeepLinks(result.uri);
            showWalletStatus('walletConnectStatus', '📲 Awaiting wallet approval. Tap the button below to open your wallet, or scan the QR from another device.', 'info');
        }
        const session = await result.approval();
        window._wcSession = session;
        
        // Extract address from session FIRST, then store in localStorage
        const ns = session.namespaces || {};
        let address = null;
        Object.keys(ns).some((key) => {
            const accts = ns[key]?.accounts || [];
            if (accts.length) {
                address = accts[0].split(':').pop();
                return true;
            }
            return false;
        });
        if (!address) throw new Error('No accounts returned from wallet');
        
        // CRITICAL: Store FULL session in localStorage so wc-bridge.js
        // on other pages can restore the session
        try {
            localStorage.setItem('wc_session_topic', session.topic);
            localStorage.setItem('wc_session_address', address);
            localStorage.setItem('wc_session_timestamp', Date.now().toString());
            // Store the full session object for restoration
            localStorage.setItem('wc_session_data', JSON.stringify(session));
            
            // Also store the approved chains separately for easy access
            // by pages that need to know which chains are supported
            const approvedChains = [];
            const ns = session.namespaces || {};
            Object.keys(ns).forEach(key => {
                const chainData = ns[key];
                if (chainData && chainData.chains) {
                    approvedChains.push(...chainData.chains);
                }
            });
            if (approvedChains.length > 0) {
                localStorage.setItem('wc_session_chains', JSON.stringify(approvedChains));
            }
            
            console.log('[homepage] Stored WC session:', session.topic, address);
            console.log('[homepage] Full session stored in localStorage');
            console.log('[homepage] Approved chains:', approvedChains);
        } catch (e) {
            console.warn('[homepage] Could not store WC session:', e);
        }
        
        const message = makeLoginMessage(address);
        showWalletStatus('walletConnectStatus', '✍️ Signature request sent. Approve login signature in your wallet.', 'info');
        const messageHex = '0x' + Array.from(new TextEncoder().encode(message)).map(b => b.toString(16).padStart(2, '0')).join('');
        const sigReqPromise = client.request({
            topic: session.topic,
            chainId: 'eip155:42220',
            request: { method: 'personal_sign', params: [messageHex, address] }
        });
        // Wake the wallet app to the foreground so the user
        // actually sees the `personal_sign` prompt instead of
        // waiting on a browser tab while MetaMask Mobile / Trust
        // silently queues the signature request behind the WC
        // session approval that just completed.
        _wcWakeWalletApp(session);
        const signature = await sigReqPromise;
        const wcFbVerifyData = await postVerifyIdentity(address, signature, message, '', 'walletconnect');
        
        // Show success immediately — the session is already in localStorage.
        // The 2.5 s wait below is only to let IndexedDB flush; any IDB
        // "database connection is closing" errors that fire during this
        // window are a known WalletConnect SDK side-effect on desktop and
        // do NOT mean the login failed, so we swallow them here.
        const wcFbOkMsg = (wcFbVerifyData && wcFbVerifyData.referral_warning)
            ? ('✅ Wallet connected via WalletConnect. ⚠️ ' + wcFbVerifyData.referral_warning + ' Redirecting...')
            : '✅ Wallet connected via WalletConnect. Redirecting...';
        showWalletStatus('walletConnectStatus', wcFbOkMsg, wcFbVerifyData && wcFbVerifyData.referral_warning ? 'warning' : 'success');
        try {
            await new Promise(resolve => setTimeout(resolve, 2500));
        } catch (_idbErr) { /* ignore IDB flush errors */ }
        _wcSetLoading(false);
        _wcConnecting = false;
        _gmAfterLoginRedirect(0);
    } catch (err) {
        const emsg = (err && err.message) ? err.message : 'WalletConnect failed';
        _wcSetLoading(false);
        _wcConnecting = false;

        // IDB "database connection is closing" errors are a known WalletConnect
        // SDK side-effect on desktop that fire AFTER the session is already
        // approved and stored in localStorage. If we already have a session,
        // treat it as success and redirect rather than showing a false error.
        const isIdbError = /IDBDatabase|transaction.*clos|database.*clos/i.test(emsg);
        if (isIdbError && window._wcSession) {
            console.warn('[WC] IDB error after successful session — redirecting anyway:', emsg);
            showWalletStatus('walletConnectStatus', '✅ Wallet connected. Redirecting…', 'success');
            _gmAfterLoginRedirect(900);
            return;
        }

        const rejected = /reject|denied|cancel/i.test(emsg);
        _logWalletConnectFrontend('walletconnect_error', {
            stage: (err && err._wcStage) ? err._wcStage : 'unknown',
            message: emsg
        });
        let friendly;
        if (err && err._wcStage === 'sdk_init') {
            friendly = '❌ WalletConnect relay did not respond within 20s. Your network may be blocking relay.walletconnect.com (WebSocket / wss:// traffic). Try a different network (mobile data vs. Wi-Fi).';
        } else if (err && err._wcStage === 'connect') {
            friendly = '❌ WalletConnect session could not be generated within 15s. Please try again.';
        } else if (rejected) {
            friendly = '❌ Request rejected by wallet. ' + emsg;
        } else {
            friendly = '❌ ' + emsg + '.';
        }
        showWalletStatus('walletConnectStatus', friendly, rejected ? 'warning' : 'error');
    }
}

// Render one-tap deep links to open the WalletConnect session in
// the user's mobile wallet app. On Vercel the user often opens
// goodmarket.live inside the wallet's own in-app browser and has
// no way to scan a QR from the same phone, so surfacing a
// deep-link button for common wallets (Trust Wallet, MetaMask,
// plus a generic wc:// link) turns the fallback from "useless"
// into "tap-to-approve".
function _renderWalletConnectDeepLinks(uri) {
    if (!uri) return;
    const qrWrap = document.getElementById('wcQrWrap');
    if (!qrWrap) return;
    const existing = document.getElementById('wcDeepLinks');
    if (existing) existing.remove();
    // NOTE: WalletConnect v2 URIs are already prefixed with the
    // `wc:` scheme (format: `wc:topicId@2?relay-protocol=irn&symKey=…`),
    // so the generic "open in installed wallet" link must NOT
    // re-prefix the URI — doing so produces a malformed
    // `wc:wc:…` href that mobile wallets ignore. We `encodeURI`
    // here only to defend against any exotic characters in the
    // URI when writing it into an innerHTML-parsed href; the
    // reserved WC-URI chars (`:`, `@`, `?`, `&`, `=`) are
    // preserved by encodeURI.
    const safeHref = encodeURI(uri);
    const enc = encodeURIComponent(uri);
    const box = document.createElement('div');
    box.id = 'wcDeepLinks';
    // One compact row instead of three stacked full-width buttons —
    // they are alternatives, not sequential steps, and the stacked
    // version pushed the status message below the phone fold.
    box.style.cssText = 'margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;';
    const btnStyle = 'flex:1 1 0;min-width:104px;text-align:center;padding:8px 6px;border-radius:9px;text-decoration:none;font-weight:600;font-size:0.76rem;color:#fff;white-space:nowrap;';
    box.innerHTML =
        '<a href="' + safeHref + '" style="' + btnStyle + 'background:#6366f1;">🔗 Installed</a>' +
        '<a href="https://link.trustwallet.com/wc?uri=' + enc + '" target="_blank" rel="noopener noreferrer" style="' + btnStyle + 'background:#3375bb;">🛡 Trust</a>' +
        '<a href="https://metamask.app.link/wc?uri=' + enc + '" target="_blank" rel="noopener noreferrer" style="' + btnStyle + 'background:#f6851b;">🦊 MetaMask</a>' +
        '<div style="flex:1 1 100%;text-align:center;font-size:0.72rem;color:#9ca3af;margin-top:2px;">On desktop? Scan the QR above instead.</div>';
    qrWrap.appendChild(box);
}

async function _logWalletConnectFrontend(event, details = {}) {
    try {
        await fetch('/api/walletconnect/frontend-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event,
                ...details,
                user_agent: navigator.userAgent || '',
                href: window.location.href || '',
                relay_host: 'relay.walletconnect.com'
            })
        });
    } catch (_) {}
}


// Close modal when clicking outside
document.getElementById('walletModal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeWalletModal();
    }
});

// ── return-to support ─────────────────────────────────────────────────
// A guest who connected from /swap or /savings must land back where they
// were, not on /wallet. postVerifyIdentity's response redirect_to is
// rewritten here when a return target is configured.
function _gmApplyReturnTo(data) {
    if (data && typeof data === 'object' && _gmReturnTo) data.redirect_to = _gmReturnTo;
    return data;
}

// Success redirect target: the page the guest started on (e.g. /swap) or the
// wallet hub. Used by the injected / WalletConnect flows whose success path
// does not read `redirect_to` from postVerifyIdentity's response.
function _gmAfterLoginRedirect(delay) {
    const target = _gmReturnTo || '/wallet';
    setTimeout(function () { window.location.href = target; }, delay || 900);
}

// ── window exposure (onclick targets + cross-page API) ────────────────
window.openWalletModal         = openWalletModal;
// Public entry point for guest-facing pages (/swap, /savings): opens the same
// "Get Started" connect flow used on the homepage.
window.openGoodMarketGetStarted= openWalletModal;
window.beginPrivyLogin         = beginPrivyLogin;
window.closeWalletModal        = closeWalletModal;
window.showWalletOptions       = showWalletOptions;
window.showLocalWalletPanel    = showLocalWalletPanel;
window.setLocalWalletMode      = setLocalWalletMode;
window.openCreatePreflight     = openCreatePreflight;
window.onPreflightAckChange    = onPreflightAckChange;
window.ackCreatePreflight      = ackCreatePreflight;
window.cancelCreatePreflight   = cancelCreatePreflight;
// The local-wallet form buttons are wired with inline onclick/oninput in
// templates/_get_started_modal.html, so they MUST resolve as globals. This
// bundle is wrapped in an IIFE — without these the Create / Log in /
// Continue / Set username buttons throw "submitLocalWallet is not defined"
// and appear dead (the whole email + PIN flow silently does nothing).
window.submitLocalWallet         = submitLocalWallet;
window.finishLocalWalletSignup   = finishLocalWalletSignup;
window.submitLocalWalletUsername = submitLocalWalletUsername;
window.skipLocalWalletUsername   = skipLocalWalletUsername;
window.submitLocalWalletPasskey  = submitLocalWalletPasskey;
window.skipLocalWalletPasskey    = skipLocalWalletPasskey;
window.lwCopyRecoveryWords       = lwCopyRecoveryWords;
window.lwPinStrengthHint         = lwPinStrengthHint;
window.syncReferralInputs        = syncReferralInputs;
window.showWalletConnectOptions= showWalletConnectOptions;
window.openGoodWalletConnect   = openGoodWalletConnect;
window.connectInjectedWallet   = connectInjectedWallet;
window.connectWalletConnect    = connectWalletConnect;
window.showWalletStatus        = showWalletStatus;
window.makeLoginMessage        = makeLoginMessage;
window.utf8ToHex               = utf8ToHex;
window.postVerifyIdentity      = postVerifyIdentity;
window.hideWalletModalForPrivy = hideWalletModalForPrivy;
window.restoreWalletModalAfterPrivy = restoreWalletModalAfterPrivy;
window.watchPrivyOpen          = watchPrivyOpen;
window.showPrivyRetry          = showPrivyRetry;
window.schedulePrivyRetry      = function () {
    window.GMPrivyRetryTimer = setTimeout(function () {
        if (typeof window.showPrivyRetry === 'function') window.showPrivyRetry();
    }, 1200);
};
// Generic entry point used by guest feature pages.
window.openGoodMarketGetStarted = openWalletModal;

})();
