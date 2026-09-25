/* GoodMarket Swap — page logic extracted from templates/swap.html.
 *
 * Extracted from the inline <script> on /swap so the ~290 KB of JS is served
 * as a versioned /static/ asset (1-year immutable cache) instead of being
 * re-downloaded and re-parsed with the no-cache HTML on every visit.
 *
 * Per-request values come from window.GM_SWAP_BOOT, set inline by the
 * template right before these bundles load.
 *
 * Split (in load order):
 *   swap-core.js     — plumbing, signer resolution, GoodSwap (Uniswap) + Fuse
 *   swap-reserve.js  — GoodReserve (Mento) buy/sell + tab switching
 *   swap-bridge.js   — Bridge tab: Celo <-> XDC (Celo->XDC and XDC->Celo legs)
 */

// ─── Constants ────────────────────────────────────────────────────────────
const WALLET_ADDRESS = window.GM_SWAP_BOOT.wallet;
const CELO_CHAIN_ID  = 42220;
const LOGIN_METHOD = window.GM_SWAP_BOOT.loginMethod;
const IS_PRIVY_LOGIN = (LOGIN_METHOD || '').toLowerCase() === 'privy';
// Server-side signing is only used for Turnkey-based logins (Google/email).
// Pure self-custody mode: never use server-side signing.
window.useServerSigning = ['turnkey_google', 'turnkey_email'].includes((LOGIN_METHOD || '').toLowerCase());
const WC_PROJECT_ID = window.GM_SWAP_BOOT.walletConnectProjectId;
// Robust WalletConnect detection: LOGIN_METHOD is primary, but sessions
// created before login_method was persisted report "injected" for
// WalletConnect users too. prefersWcSigning() recovers those via a saved
// WC session for this wallet so they never sign with injected MetaMask.
const PREFER_WC_SIGNING = (typeof GMWalletConnect !== 'undefined' && typeof GMWalletConnect.prefersWcSigning === 'function')
    ? GMWalletConnect.prefersWcSigning()
    : ['walletconnect', 'manual', 'manual_address'].includes((LOGIN_METHOD || '').toLowerCase());
const CELO_RPC       = "https://forno.celo.org";
let _wcSessionId = null;
let _wcAddress = null;
let _wcMode = null; // "sidecar" | "browser"
let _wcSignClient = null;
let _wcBrowserSession = null;
let _wcSdkLoading = null;

function _wcExtendIfExpiring(client, topic, session) {
    if (!client || !topic || !session || !session.expiry) return;
    var secsLeft = session.expiry - Math.floor(Date.now() / 1000);
    if (secsLeft <= 0 || secsLeft > 2 * 24 * 3600) return;
    console.log('[WC] Session expires in', Math.round(secsLeft / 3600), 'h — requesting extension...');
    client.extend({ topic: topic }).then(function() {
        console.log('[WC] Session extended successfully');
        try { localStorage.setItem('wc_session_timestamp', Date.now().toString()); } catch(_) {}
        try {
            var active = client.getActiveSessions ? client.getActiveSessions() : {};
            var updated = active[topic];
            if (!updated && client.session && client.session.getAll) {
                updated = client.session.getAll().find(function(x) { return x.topic === topic; });
            }
            if (updated) localStorage.setItem('wc_session_data', JSON.stringify(updated));
        } catch(_) {}
    }).catch(function(e) { console.warn('[WC] Extend failed:', e && e.message); });
}

// Trust Wallet mobile-specific provider discovery:
// keep strict scope so non-Trust flows preserve existing behavior.
window.__swapEip6963Providers = window.__swapEip6963Providers || [];
(function _initSwapEip6963() {
    try {
        window.addEventListener('eip6963:announceProvider', (event) => {
            const detail = event && event.detail;
            if (!detail || !detail.provider) return;
            const uuid = detail.info && detail.info.uuid;
            const already = window.__swapEip6963Providers.find(d =>
                (d.info && d.info.uuid && uuid && d.info.uuid === uuid) ||
                d.provider === detail.provider
            );
            if (!already) window.__swapEip6963Providers.push(detail);
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (_) {}
})();
function _swapEip6963Providers() {
    return Array.isArray(window.__swapEip6963Providers)
        ? window.__swapEip6963Providers.slice()
        : [];
}
function _isTrustWalletMobileContext() {
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
function _isLikelyMobileWalletContext() {
    const ua = (navigator.userAgent || '').toLowerCase();
    return /android|iphone|ipad|ipod|minipay|metamask|trust|trustwallet/.test(ua);
}
function _coerceSwapProvider(candidate) {
    if (!candidate) return null;
    if (typeof candidate.request === 'function') return candidate;
    if (candidate.ethereum && typeof candidate.ethereum.request === 'function') return candidate.ethereum;
    if (candidate.provider && typeof candidate.provider.request === 'function') return candidate.provider;

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
function _collectSwapProviders() {
    const out = [];
    const push = (p) => {
        const provider = _coerceSwapProvider(p);
        if (provider && !out.includes(provider)) out.push(provider);
    };
    if (window.ethereum) {
        if (Array.isArray(window.ethereum.providers)) window.ethereum.providers.forEach(push);
        push(window.ethereum);
    }
    if (window.trustwallet) push(window.trustwallet);
    if (window.trustwallet && window.trustwallet.ethereum) push(window.trustwallet.ethereum);
    if (window.trustWallet) push(window.trustWallet);
    if (window.trustWallet && window.trustWallet.ethereum) push(window.trustWallet.ethereum);
    for (const d of _swapEip6963Providers()) push(d.provider);
    return out;
}
// Handles EIP-5749 multi-wallet: prefer Trust Wallet in Trust mobile;
// otherwise preserve MetaMask-first behavior.
function _getEthProvider() {
    // WalletConnect / manual-address logins must NEVER use an injected wallet
    // (e.g. a desktop MetaMask extension): its account differs from the
    // logged-in GoodMarket wallet, so signing fails with "Wrong wallet
    // connected". Block injected discovery so all flows route through the
    // WalletConnect signer. LOGIN_METHOD is Jinja-rendered and reliable.
    if (PREFER_WC_SIGNING) return null;
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
    const providers = _collectSwapProviders();
    if (!providers.length) return null;
    if (_isTrustWalletMobileContext()) {
        const trust = providers.find(p => p && (p.isTrust || p.isTrustWallet));
        if (trust) return trust;
        const trust6963 = _swapEip6963Providers().find(d => {
            const info = d.info || {};
            const rdns = String(info.rdns || '').toLowerCase();
            const name = String(info.name || '').toLowerCase();
            return rdns.includes('trustwallet') || name.includes('trust');
        });
        if (trust6963 && trust6963.provider) return trust6963.provider;
        return providers[0];
    }
    if (window.ethereum && window.ethereum.providers && window.ethereum.providers.length) {
        const miniPay = window.ethereum.providers.find(p => p && p.isMiniPay);
        if (miniPay) return miniPay;
        const trust = window.ethereum.providers.find(p => p && (p.isTrust || p.isTrustWallet));
        if (trust) return trust;
        const mm = window.ethereum.providers.find(p => p.isMetaMask && !p.isBraveWallet);
        if (mm) return mm;
        return window.ethereum.providers[0];
    }
    return window.ethereum || providers[0];
}
async function _awaitEthProvider(timeoutMs) {
    const budget = typeof timeoutMs === 'number'
        ? timeoutMs
        : (_isTrustWalletMobileContext() ? 4200 : (_isLikelyMobileWalletContext() ? 2200 : 800));
    const start = Date.now();
    let p = _getEthProvider();
    if (p) return p;
    while (Date.now() - start < budget) {
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        await _delay(120);
        p = _getEthProvider();
        if (p) return p;
    }
    if (typeof GMWalletConnect !== "undefined" && GMWalletConnect.isPreferred()) {
        try {
            const wcProvider = await GMWalletConnect.getProvider();
            if (wcProvider) return wcProvider;
        } catch (_) {}
    }
    return null;
}
if (_isTrustWalletMobileContext()) {
    window.addEventListener('pageshow', () => { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {} });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
    });
}

// ── MiniPay CIP-64 fee-abstracted tx helpers ──
function _isMiniPay() {
    // The in-app wallet pays gas in CELO — CIP-64 feeCurrency params
    // would break its plain eth_sendTransaction path.
    if ((LOGIN_METHOD || '').toLowerCase() === 'local') return false;
    const ep = _getEthProvider();
    if (ep && ep.isMiniPay) return true;
    if (window.ethereum && window.ethereum.isMiniPay) return true;
    if (window.ethereum && window.ethereum.providers
        && window.ethereum.providers.some(p => p && p.isMiniPay)) return true;
    if (typeof navigator !== 'undefined' && /minipay/i.test(navigator.userAgent || '')) return true;
    return false;
}

// Check if MiniPay user has enough combined stablecoin balance for gas.
// MiniPay can pay gas from cUSD / USDT / USDC, so do not block users
// just because the token being swapped (for example cUSD) is low when
// another supported stablecoin (for example USDT) has the gas budget.
async function checkMiniPayStablecoinBalance() {
    if (!window.MPGasTopUp || !window.MPGasTopUp.isMiniPay()) return true;
    if (!window.MPGasTopUp.getBalances) return true; // Safety fallback

    try {
        const balances = await window.MPGasTopUp.getBalances(WALLET_ADDRESS);
        if (!balances) return true;

        if (typeof window.MPGasTopUp.hasStablecoinGasBalance === 'function') {
            return window.MPGasTopUp.hasStablecoinGasBalance(balances);
        }

        // Fallback kept in sync with static/js/minipay-gas-topup.js.
        // USDT/USDC have 6 decimals, so 0.015 is 15,000 units (not 15,000,000).
        const STABLECOIN_GAS_MIN_USD = 0.015;
        const cusdUsd = Number(balances.cusd || 0n) / 1e18;
        const usdtUsd = Number(balances.usdt || 0n) / 1e6;
        const usdcUsd = Number(balances.usdc || 0n) / 1e6;

        return (cusdUsd + usdtUsd + usdcUsd) >= STABLECOIN_GAS_MIN_USD;
    } catch (e) {
        console.warn('[swap] checkMiniPayStablecoinBalance error:', e);
        return true; // Safety fallback - allow swap to proceed
    }
}

// CIP-64 fee currency addresses on Celo. MiniPay typically auto-selects the
// gas token based on the user's balance, so `null` (let MiniPay decide) is
// attempted first. Explicit values are kept as fallbacks for older MiniPay
// builds that still honour the `feeCurrency` field.
const MINIPAY_FEE_CURRENCY = {
    CUSD:         '0x765DE816845861e75A25fCA122bb6898B8B1282a', // cUSD
    USDT_ADAPTER: '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72', // USDT (CELO/USDT adapter)
    USDC_ADAPTER: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B', // USDC (CELO/USDC adapter)
};

async function _miniPayWaitForReceipt(ep, txHash, maxAttempts = 60) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const receipt = await ep.request({
                method: 'eth_getTransactionReceipt',
                params: [txHash],
            });
            if (receipt) {
                if (receipt.status === '0x0') {
                    throw new Error('Transaction reverted on-chain.');
                }
                return receipt;
            }
        } catch (e) {
            if (e && e.message && /reverted/i.test(e.message)) throw e;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return null;
}

// Estimate gas WITHOUT a feeCurrency param. MiniPay's gas estimator is
// sometimes fussy about feeCurrency on `eth_estimateGas`, but the raw
// EVM gas usage doesn't depend on which token pays the fee, so we
// estimate cleanly and then attach feeCurrency only on `eth_sendTransaction`.
async function _miniPayEstimateGas(ep, from, toAddr, data, value, opName) {
    const baseParams = { from, to: toAddr, data, value };
    try {
        const est = await ep.request({ method: 'eth_estimateGas', params: [baseParams] });
        const estimated = typeof est === 'string' ? BigInt(est) : BigInt(Number(est));
        // 80% headroom — MiniPay multi-hop swaps can spike, especially via Uniswap V3.
        const withHeadroom = '0x' + (estimated * 180n / 100n).toString(16);
        console.log('[MiniPay] gas estimated:', { op: opName, raw: est, withHeadroom });
        return { gasHex: withHeadroom, error: null };
    } catch (gasErr) {
        // Fallback budgets sized for realistic MiniPay flows:
        //  - approve / simple transfers: ~80k actual, give 200k
        //  - swap / multi-hop: ~250k–600k, give 1.2M
        const isSwap = /swap|exactInput|exactOutput/i.test(opName || '');
        const fallback = isSwap ? '0x124F80' : '0x30D40'; // 1.2M : 200k
        console.warn('[MiniPay] eth_estimateGas failed, using fallback:', {
            op: opName, fallback, error: gasErr?.message, code: gasErr?.code,
        });
        return { gasHex: fallback, error: gasErr };
    }
}

// Execute an eth_sendTransaction with MiniPay's CIP-64 fee abstraction.
// Strategy (current MiniPay behavior, late-2025/2026):
//   1) Send WITHOUT feeCurrency first — MiniPay auto-picks the gas token
//      from the user's balance. This is the recommended path per the
//      MiniPay docs and avoids "blocked" prompts when the user doesn't
//      hold a specific stablecoin.
//   2) If MiniPay returns a fee-related error (not user-rejected,
//      not on-chain revert), fall back to explicit CIP-64 adapters
//      so older MiniPay builds and edge cases still work.
async function _miniPayFeeCurrencyAttempts(ep, from) {
    const defaults = [
        null,
        MINIPAY_FEE_CURRENCY.USDT_ADAPTER,
        MINIPAY_FEE_CURRENCY.USDC_ADAPTER,
        MINIPAY_FEE_CURRENCY.CUSD,
    ];

    if (!window.MPGasTopUp || !window.MPGasTopUp.getBalances || !from) {
        return defaults;
    }

    try {
        const balances = await window.MPGasTopUp.getBalances(from, ep);
        const ranked = [
            { fc: MINIPAY_FEE_CURRENCY.USDT_ADAPTER, amount: Number(balances?.usdt || 0n) / 1e6 },
            { fc: MINIPAY_FEE_CURRENCY.USDC_ADAPTER, amount: Number(balances?.usdc || 0n) / 1e6 },
            { fc: MINIPAY_FEE_CURRENCY.CUSD, amount: Number(balances?.cusd || 0n) / 1e18 },
        ].sort((a, b) => b.amount - a.amount).map(x => x.fc);

        // Keep MiniPay auto-selection first, but make explicit fallbacks follow
        // the user's actual stablecoin balances. This fixes cases where the
        // wallet is spending nearly all cUSD but has USDT/USDC available for gas.
        return [null, ...ranked];
    } catch (e) {
        console.warn('[MiniPay] fee currency balance ranking failed; using defaults:', e);
        return defaults;
    }
}

async function _miniPaySendWithFeeRetry(ep, baseParams, opName) {
    const errorLog = [];
    const attempts = await _miniPayFeeCurrencyAttempts(ep, baseParams && baseParams.from);

    for (const fc of attempts) {
        const txParams = { ...baseParams };
        if (fc) txParams.feeCurrency = fc;
        else delete txParams.feeCurrency;

        try {
            console.log('[MiniPay] sending tx attempt:', {
                op: opName, feeCurrency: fc || 'auto', gas: txParams.gas,
            });
            const txHash = await ep.request({
                method: 'eth_sendTransaction',
                params: [txParams],
            });
            console.log('[MiniPay] tx sent:', { op: opName, txHash, feeCurrency: fc || 'auto' });
            await _miniPayWaitForReceipt(ep, txHash);
            return { txHash, errorLog };
        } catch (err) {
            const code = err && err.code;
            const rawMsg = (err && (err.message || (err.data && err.data.message))) || '';
            const msg = rawMsg.toLowerCase();
            const detail = {
                feeCurrency: fc || 'auto',
                code,
                message: rawMsg.substring(0, 200),
                dataMsg: err?.data?.message || null,
            };
            errorLog.push(detail);
            console.error('[MiniPay] tx FAILED:', { op: opName, ...detail });

            // User cancelled — never retry.
            if (code === 4001 || /reject|denied by user|user denied|cancel/i.test(msg)) {
                const richErr = new Error(rawMsg || 'Transaction cancelled in wallet.');
                richErr.code = 4001;
                richErr._miniPayCancel = true;
                throw richErr;
            }

            // On-chain contract reverts won't be fixed by changing the fee token.
            // Do NOT treat generic "insufficient funds/balance" as a revert here:
            // MiniPay may surface fee-currency balance failures with that wording
            // (for example auto/cUSD fails while the user has USDT), so those must
            // continue to the explicit USDT/USDC/cUSD retry attempts.
            const isContractRevert = /revert|execution reverted|allowance|stf|transferhelper/i.test(msg);
            const isGasLimitFailure = /out of gas/i.test(msg) && !/fee|currency|fund|balance/i.test(msg);
            if (isContractRevert || isGasLimitFailure) {
                const richErr = new Error(rawMsg || 'Transaction reverted.');
                richErr._miniPayRevert = true;
                richErr._miniPayDiag = { fn: opName, errorLog };
                throw richErr;
            }
        }
    }

    return { txHash: null, errorLog };
}

function _buildMiniPayDiagError(opName, toAddr, errorLog, gasEstimateError) {
    const diagParts = errorLog.map((e, i) =>
        `Attempt ${i + 1} (fc=${e.feeCurrency}): code=${e.code}, msg=${e.message}`
    );
    const diagMsg = `MiniPay ${opName} failed after ${errorLog.length} attempt(s).\n` +
        diagParts.join('\n') +
        (gasEstimateError ? `\nGas estimate also failed: ${gasEstimateError.message || gasEstimateError}` : '');
    const richErr = new Error(diagMsg);
    richErr._miniPayDiag = {
        fn: opName,
        to: toAddr,
        errorLog,
        gasEstimateError: gasEstimateError?.message,
    };
    return richErr;
}

async function _miniPayResolveFrom(ep) {
    const accounts = await ep.request({ method: 'eth_requestAccounts' });
    const from = (accounts && accounts[0]) || WALLET_ADDRESS;
    if (from && WALLET_ADDRESS && from.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
        throw new Error(
            'Wrong MiniPay account. Please switch to ' +
            WALLET_ADDRESS.slice(0, 6) + '…' + WALLET_ADDRESS.slice(-4) + ' and try again.'
        );
    }
    return from;
}

async function _miniPayTx(toAddr, abiFragment, args, valueHex) {
    const ep = _getEthProvider();
    if (!ep) throw new Error('No injected wallet provider available.');

    const from = await _miniPayResolveFrom(ep);
    const iface = new ethers.Interface([abiFragment]);
    const fnName = abiFragment.match(/function (\w+)/)[1];
    const data = iface.encodeFunctionData(fnName, args);
    const value = valueHex || '0x0';

    console.log('[MiniPay] _miniPayTx called:', {
        fn: fnName, to: toAddr, from,
        dataLen: data.length, value,
        isMiniPay: !!(ep && ep.isMiniPay),
        ua: navigator.userAgent,
    });

    const { gasHex, error: gasEstimateError } =
        await _miniPayEstimateGas(ep, from, toAddr, data, value, fnName);

    const baseParams = { from, to: toAddr, data, value, gas: gasHex };
    const { txHash, errorLog } =
        await _miniPaySendWithFeeRetry(ep, baseParams, fnName);

    if (txHash) return txHash;

    console.error('[MiniPay] all attempts exhausted for', fnName);
    throw _buildMiniPayDiagError(fnName + '()', toAddr, errorLog, gasEstimateError);
}

async function _miniPayRawTx(toAddr, data, valueHex, opName) {
    const ep = _getEthProvider();
    if (!ep) throw new Error('No injected wallet provider available.');

    const from = await _miniPayResolveFrom(ep);
    const value = valueHex || '0x0';
    const op = opName || 'rawTx';

    console.log('[MiniPay] _miniPayRawTx called:', {
        op, to: toAddr, from, dataLen: data.length, value,
    });

    const { gasHex, error: gasEstimateError } =
        await _miniPayEstimateGas(ep, from, toAddr, data, value, op);

    const baseParams = { from, to: toAddr, data, value, gas: gasHex };
    const { txHash, errorLog } =
        await _miniPaySendWithFeeRetry(ep, baseParams, op);

    if (txHash) return txHash;

    console.error('[MiniPay] all attempts exhausted for', op);
    throw _buildMiniPayDiagError(op, toAddr, errorLog, gasEstimateError);
}

function _normalizeChainIdHex(chainId) {
    if (chainId === null || chainId === undefined) return "";
    if (typeof chainId === "string") {
        const trimmed = chainId.trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) return trimmed.toLowerCase();
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber)) return `0x${asNumber.toString(16)}`;
        return trimmed.toLowerCase();
    }
    if (typeof chainId === "number" && Number.isFinite(chainId)) {
        return `0x${chainId.toString(16)}`;
    }
    if (typeof chainId === "bigint") {
        return `0x${chainId.toString(16)}`;
    }
    return String(chainId).toLowerCase();
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function _wcLoadSdk() {
    if (_wcSdkLoading) return _wcSdkLoading;
    _wcSdkLoading = new Promise((resolve, reject) => {
        const localSrc = window.GM_SWAP_BOOT.wcBundleUrl;
        const cdnSrc = 'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.17.0/dist/index.umd.js';
        function loadScript(src, ok, fail) {
            const s = document.createElement('script');
            s.src = src; s.onload = ok; s.onerror = fail;
            document.head.appendChild(s);
        }
        loadScript(localSrc, () => {
            const sc = (window['@walletconnect/sign-client'] || {}).SignClient;
            if (sc) resolve(sc);
            else loadScript(cdnSrc, () => {
                const sc2 = (window['@walletconnect/sign-client'] || {}).SignClient;
                sc2 ? resolve(sc2) : reject(new Error('WalletConnect SDK unavailable'));
            }, () => reject(new Error('WalletConnect SDK unavailable')));
        }, () => {
            loadScript(cdnSrc, () => {
                const sc2 = (window['@walletconnect/sign-client'] || {}).SignClient;
                sc2 ? resolve(sc2) : reject(new Error('WalletConnect SDK unavailable'));
            }, () => reject(new Error('WalletConnect SDK unavailable')));
        });
    });
    return _wcSdkLoading;
}

async function _wcGetClient() {
    if (_wcSignClient) return _wcSignClient;
    // Reuse a SignClient that another page on the same origin (e.g.
    // homepage login, savings) already initialised — WalletConnect v2
    // persists pairing metadata in shared `localStorage` keys so we
    // can restore a live session from it instead of opening a brand
    // new pairing (which is what Trust Wallet sees as a "Parse error"
    // on /swap when it already holds the homepage session).
    if (window._wcSignClient) {
        _wcSignClient = window._wcSignClient;
    } else {
        if (!WC_PROJECT_ID) throw new Error('WALLETCONNECT_PROJECT_ID is not configured');
        const SignClient = await _wcLoadSdk();
        _wcSignClient = await SignClient.init({
            projectId: WC_PROJECT_ID,
            metadata: {
                name: 'GoodMarket',
                description: 'Swap G$ tokens with GoodMarket on Celo',
                url: window.location.origin,
                icons: [window.location.origin + '/static/icons/icon-192x192.png?v=' + window.GM_SWAP_BOOT.assetVersion]
            }
        });
        try { window._wcSignClient = _wcSignClient; } catch (_) {}
    }
    
    // Check localStorage FIRST (fast path) - available immediately
    var storedTopic = localStorage.getItem('wc_session_topic');
    var storedAddress = localStorage.getItem('wc_session_address');
    var storedSessionData = localStorage.getItem('wc_session_data');
    var storedTimestamp = parseInt(localStorage.getItem('wc_session_timestamp') || '0', 10);
    
    var MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    var sessionAge = storedTimestamp ? (Date.now() - storedTimestamp) : Infinity;
    var sessionTooOld = sessionAge > MAX_SESSION_AGE_MS;
    
    if (storedTopic && storedAddress && !sessionTooOld && storedSessionData) {
        try {
            var parsedSession = JSON.parse(storedSessionData);
            var parsedExpiry = parsedSession && parsedSession.expiry;
            var nowSec = Math.floor(Date.now() / 1000);
            if (parsedSession && parsedSession.topic && (!parsedExpiry || parsedExpiry > nowSec)) {
                // Check if SDK already has this session
                var sdkSessions = {};
                try {
                    var activeSessions = _wcSignClient.getActiveSessions();
                    if (activeSessions && typeof activeSessions === 'object') {
                        Object.keys(activeSessions).forEach(function(k) { sdkSessions[k] = activeSessions[k]; });
                    }
                } catch (_) {}
                if (Object.keys(sdkSessions).length === 0) {
                    try {
                        var allSessions = _wcSignClient.session.getAll();
                        if (allSessions && allSessions.length) {
                            allSessions.forEach(function(s) { if (s && s.topic) sdkSessions[s.topic] = s; });
                        }
                    } catch (_) {}
                }
                
                // If SDK has the session, use it
                if (sdkSessions[storedTopic]) {
                    _wcBrowserSession = sdkSessions[storedTopic];
                    _wcMode = "browser";
                    window._wcSession = _wcBrowserSession;
                    _wcAddress = storedAddress;
                    console.log('[swap] WC session restored from SDK storage:', storedTopic);
                    _wcExtendIfExpiring(_wcSignClient, storedTopic, _wcBrowserSession);
                    return _wcSignClient;
                }
                
                // Try to restore from localStorage
                if (parsedSession.topic === storedTopic) {
                    // Subscribe to relay first
                    try {
                        if (_wcSignClient.core && _wcSignClient.core.relayer && typeof _wcSignClient.core.relayer.subscribe === 'function') {
                            _wcSignClient.core.relayer.subscribe(storedTopic).catch(function(_){});
                        }
                    } catch (_) {}
                    
                    // Inject session
                    try {
                        if (_wcSignClient.session && typeof _wcSignClient.session.set === 'function') {
                            _wcSignClient.session.set(parsedSession.topic, parsedSession);
                        }
                    } catch (_) {}
                    
                    _wcBrowserSession = parsedSession;
                    _wcMode = "browser";
                    window._wcSession = _wcBrowserSession;
                    _wcAddress = storedAddress;
                    console.log('[swap] WC session restored from localStorage:', storedTopic);
                    _wcExtendIfExpiring(_wcSignClient, storedTopic, _wcBrowserSession);
                    return _wcSignClient;
                }
            }
        } catch (parseErr) { console.warn('[swap] localStorage parse error:', parseErr); }
    }
    
    // Clean up stale localStorage
    if (storedTopic && (sessionTooOld || !storedSessionData)) {
        try {
            localStorage.removeItem('wc_session_topic');
            localStorage.removeItem('wc_session_address');
            localStorage.removeItem('wc_session_data');
            localStorage.removeItem('wc_session_timestamp');
            localStorage.removeItem('wc_session_chains');
        } catch (_) {}
    }
    
    // Restore an existing session from SDK storage as fallback
    try {
        if (!_wcBrowserSession && _wcSignClient.session && _wcSignClient.session.getAll) {
            const sessions = _wcSignClient.session.getAll();
            if (sessions && sessions.length) {
                const restored = sessions[sessions.length - 1];
                _wcBrowserSession = restored;
                _wcMode = "browser";
                if (window._wcSession === undefined || window._wcSession === null) {
                    try { window._wcSession = restored; } catch (_) {}
                }
                const ns = restored.namespaces || {};
                Object.keys(ns).some(function (key) {
                    const accts = (ns[key] && ns[key].accounts) || [];
                    if (accts.length) {
                        _wcAddress = String(accts[0]).split(':').pop();
                        return true;
                    }
                    return false;
                });
                console.log('[swap] WC session restored from SDK storage');
            }
        }
    } catch (_) { /* no-op */ }
    return _wcSignClient;
}

// Derive the correct eip155 chain string for a WalletConnect
// client.request() call. Priority: (1) chainId in tx params,
// (2) first chain approved in the session namespaces, (3) Celo.
function _wcEip155Chain(session, method, params) {
    try {
        if (method === 'eth_sendTransaction' && Array.isArray(params) && params[0] && params[0].chainId) {
            var txChain = parseInt(String(params[0].chainId), 16);
            if (!isNaN(txChain) && txChain > 0) return 'eip155:' + txChain;
        }
        var ns = session && (session.namespaces || {});
        var chains = (ns.eip155 && ns.eip155.chains) || [];
        if (!chains.length && ns.eip155 && ns.eip155.accounts && ns.eip155.accounts.length) {
            var parts = String(ns.eip155.accounts[0]).split(':');
            if (parts.length >= 2) return parts[0] + ':' + parts[1];
        }
        if (chains.length) return chains[0];
    } catch (_) {}
    return 'eip155:42220';
}

// Warm up the WalletConnect SignClient on page load so any
// existing eip155:42220 session left behind by homepage login /
// savings is restored before the user clicks Bridge / Swap. This
// is the same pattern savings.html already uses (line ~1846 there)
// and is what stops /swap from generating a brand-new pairing
// every visit (which Trust Wallet rejects with "Parse error" when
// it already holds the homepage session).
if (PREFER_WC_SIGNING) {
    setTimeout(function () {
        _wcGetClient().catch(function () { /* no-op */ });
    }, 1500);
}

// Detect mobile-browser context for WalletConnect deep-link wake-ups.
function _isWcMobileBrowserContext() {
    try {
        const ua = (navigator.userAgent || '').toLowerCase();
        return /android|iphone|ipad|ipod|mobile/i.test(ua);
    } catch (_) { return false; }
}

// After firing a wallet-scoped WalletConnect request the wallet app
// does not always come to the foreground on its own — MetaMask
// Mobile in particular is happy to silently queue the prompt while
// the user keeps staring at the dApp browser. We mirror what
// @walletconnect/modal does and synthetically click an `<a>` whose
// href is the wallet's `session.peer.metadata.redirect.native`
// (custom scheme) or `redirect.universal` (https universal link)
// to bring the wallet app to the foreground so the user actually
// sees the sign / tx prompt that's now sitting in their wallet.
function _wcWakeWalletApp(session) {
    try {
        if (!session || !_isWcMobileBrowserContext()) return;
        const meta = session.peer && session.peer.metadata;
        const redirect = meta && meta.redirect;
        if (!redirect) return;
        const href = redirect.native || redirect.universal;
        if (!href) return;
        const link = document.createElement('a');
        link.href = href;
        link.style.display = 'none';
        link.target = '_self';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { try { link.remove(); } catch (_) {} }, 100);
    } catch (_) { /* no-op */ }
}

async function _celoJsonRpc(method, params) {
    // Try several public Celo RPC endpoints so a revert surfaced by one
    // provider (without the `data` blob ethers v6 needs to decode the
    // revert reason) can be re-tried on another that DOES include it.
    // Without this, eth_call/eth_estimateGas reverts surface to the user
    // as the opaque "missing revert data in call exception" from ethers.
    const urls = [CELO_RPC].concat(['https://forno.celo.org', 'https://rpc.ankr.com/celo', 'https://celo-rpc.publicnode.com']);
    let lastErr;
    for (let i = 0; i < urls.length; i++) {
        try {
            const resp = await fetch(urls[i], {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || [] })
            });
            const data = await resp.json();
            if (data.error) {
                const e = new Error(data.error.message || 'RPC error');
                e.code = (typeof data.error.code === 'number') ? data.error.code : -32603;
                if (data.error.data !== undefined && data.error.data !== null) e.data = data.error.data;
                lastErr = e;
                // Revert bytes present → deterministic; no point retrying.
                if (data.error.data != null) throw e;
                continue; // try next RPC (may carry the data blob)
            }
            return data.result;
        } catch (e) {
            // If we already shaped a revert error with .data, throw it.
            if (e && e.data != null) throw e;
            lastErr = e;
        }
    }
    throw lastErr || new Error('All RPC endpoints failed');
}

// EIP-1193-shaped error so ethers.js BrowserProvider can coalesce the
// failure into a useful exception (with .code / .message preserved)
// rather than wrapping it as a generic "could not coalesce error".
function _wcRpcError(message, code, data) {
    const err = new Error(message);
    err.code = code || 4001;
    if (data !== undefined) err.data = data;
    return err;
}

// When the wallet / RPC reports a swap revert as the opaque
// "missing revert data" (ethers v6 fires this whenever an
// eth_call / eth_estimateGas reverted without a recoverable
// `data` blob), re-run the EXACT same calldata as a read-only
// eth_call against several public Celo RPC endpoints. At least
// one of them will typically return the revert `data` blob, which
// we decode into a human reason. Also checks ERC-20 allowance +
// balance so the most common real causes surface a clear hint
// even when no revert bytes are recoverable.
//
// `simParams`: { to, data, from, value } of the failing tx.
// `ctx`: { tokenAddr, spender, amountIn, tokenSymbol } optional,
//        used for the allowance/balance diagnostic.
async function _enrichSwapError(err, simParams, ctx) {
    if (!err) return err;
    const joined = String(err.message || err.shortMessage || err.reason || "");
    // Gas-related failures first — if the real cause is gas, the
    // "Transaction reverted… check amount and approval" / "Token approval
    // is too low" messages below would mislead the user into fixing the
    // wrong thing. Surface a gas-specific message before anything else.
    if (window.GMTxError && GMTxError.isGasRelated && GMTxError.isGasRelated(err)) {
        err._gmFriendly = true;
        if (GMTxError.isInsufficientFunds && GMTxError.isInsufficientFunds(err)) {
            err.message = "Insufficient CELO for gas fees. " +
                "Please top up your wallet with a little CELO and try again.";
        } else {
            err.message = "Transaction needs more gas. " +
                "Please top up CELO for gas fees and try again.";
        }
        return err;
    }
    const looksRevert = /revert|missing revert data|call exception|missing revert/i.test(joined);
    // If ethers already decoded a concrete reason, trust it.
    if (looksRevert && err.reason && /reverted/i.test(err.reason) && err.data) {
        return err;
    }
    if (looksRevert && window.GMTxError && GMTxError.revertReasonFromError) {
        const existing = GMTxError.revertReasonFromError(err);
        if (existing && existing.indexOf("selector") === -1) return err;
    }
    // Try to recover the real revert reason via simulation.
    if (looksRevert && simParams && window.GMTxError && GMTxError.simulateCallCelo) {
        try {
            const reason = await GMTxError.simulateCallCelo(simParams);
            if (reason) {
                err._gmFriendly = true;
                err.message = "Transaction reverted on-chain: " + reason +
                    ". Please check the amount and token approval, then try again.";
                return err;
            }
        } catch (_) { /* fall through to diagnostic */ }
    }
    // Diagnostic: allowance / balance shortfall is the most common
    // real cause behind an opaque "missing revert data" on swaps.
    if (ctx && ctx.tokenAddr && ctx.spender && ctx.amountIn) {
        try {
            const rp = new ethers.JsonRpcProvider(CELO_RPC);
            const tk = new ethers.Contract(ctx.tokenAddr, [
                "function allowance(address,address) view returns (uint256)",
                "function balanceOf(address) view returns (uint256)"
            ], rp);
            const [allow, bal] = await Promise.all([
                tk.allowance(simParams.from || WALLET_ADDRESS, ctx.spender),
                tk.balanceOf(simParams.from || WALLET_ADDRESS)
            ]);
            if (allow < ctx.amountIn) {
                err._gmFriendly = true;
                err.message = "Token approval is too low for this swap. " +
                    "Please re-approve " + (ctx.tokenSymbol || "the token") + " and try again.";
                return err;
            }
            if (bal < ctx.amountIn) {
                err._gmFriendly = true;
                const balH = parseFloat(ethers.formatUnits(bal, 18)).toFixed(4);
                const needH = parseFloat(ethers.formatUnits(ctx.amountIn, 18)).toFixed(4);
                err.message = "Insufficient " + (ctx.tokenSymbol || "token") +
                    " balance: have " + balH + ", need " + needH + ". Swap a smaller amount.";
                return err;
            }
        } catch (_) { /* ignore diagnostic failure */ }
    }
    return err;
}

async function _wcSidecarConnect() {
    let uriData;
    try {
        const uriResp = await fetch('/api/wc-uri');
        if (!uriResp.ok) throw new Error('sidecar HTTP ' + uriResp.status);
        uriData = await uriResp.json();
    } catch (err) {
        // /api/wc-uri unreachable / not deployed — let the caller try
        // the in-browser SignClient fallback instead.
        const e = new Error('sidecar-unavailable');
        e._sidecarUnavailable = true;
        throw e;
    }
    if (!uriData || !uriData.success || !uriData.id || !uriData.uri) {
        const e = new Error('sidecar-unavailable');
        e._sidecarUnavailable = true;
        throw e;
    }
    _wcSessionId = uriData.id;
    _wcMode = "sidecar";
    showAlert('info',
        '📲 Scan WalletConnect QR in your wallet app:<br>' +
        `<div style="margin-top:8px"><img alt="WalletConnect QR" style="max-width:180px;border-radius:8px;background:#fff;padding:8px" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(uriData.uri)}"></div>`
    );
    for (let i = 0; i < 60; i++) {
        await _delay(2000);
        const stResp = await fetch('/api/wc-session/' + encodeURIComponent(_wcSessionId));
        const stData = await stResp.json();
        if (!stResp.ok || !stData.success) continue;
        if (stData.status === 'approved' && stData.address) {
            _wcAddress = stData.address;
            if (_wcAddress.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
                throw _wcRpcError('Wrong WalletConnect wallet connected. Please connect your GoodMarket wallet.', 4001);
            }
            return _wcAddress;
        }
        if (stData.status === 'rejected') {
            throw _wcRpcError('WalletConnect request was rejected.', 4001);
        }
    }
    throw _wcRpcError('WalletConnect approval timed out.', -32603);
}

async function _wcBrowserConnect() {
    const client = await _wcGetClient();
    // _wcGetClient now restores any pre-existing eip155:42220 session
    // from localStorage. If the homepage / savings already paired
    // the wallet, just reuse that session — opening a *second*
    // pairing while the first one is still alive is exactly what
    // makes Trust Wallet bail out with "parse error" on /swap.
    if (_wcBrowserSession && _wcAddress) {
        _wcMode = "browser";
        if (_wcAddress.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
            throw _wcRpcError('Wrong WalletConnect wallet connected. Please connect your GoodMarket wallet.', 4001);
        }
        return _wcAddress;
    }
    const result = await client.connect({
        requiredNamespaces: {},
        optionalNamespaces: {
            eip155: {
                methods: ['eth_accounts', 'eth_sendTransaction', 'eth_getTransactionReceipt', 'eth_chainId', 'personal_sign'],
                chains: ['eip155:42220'],
                events: ['chainChanged', 'accountsChanged']
            }
        }
    });
    _wcMode = "browser";
    if (result.uri) {
        showAlert('info',
            '📲 Scan WalletConnect QR in your wallet app:<br>' +
            `<div style="margin-top:8px"><img alt="WalletConnect QR" style="max-width:180px;border-radius:8px;background:#fff;padding:8px" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(result.uri)}"></div>`
        );
    }
    _wcBrowserSession = await result.approval();
    try { window._wcSession = _wcBrowserSession; } catch (_) {}
    const ns = _wcBrowserSession.namespaces || {};
    Object.keys(ns).some((key) => {
        const accts = ns[key]?.accounts || [];
        if (accts.length) {
            _wcAddress = accts[0].split(':').pop();
            return true;
        }
        return false;
    });
    if (!_wcAddress) throw _wcRpcError('No accounts returned from wallet', -32603);
    if (_wcAddress.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
        throw _wcRpcError('Wrong WalletConnect wallet connected. Please connect your GoodMarket wallet.', 4001);
    }
    return _wcAddress;
}

async function _wcConnectSwap() {
    if (_wcAddress) return _wcAddress;
    // Prefer an already-active in-browser SignClient session (left
    // behind by homepage login or savings). Falling straight back to
    // the sidecar would otherwise generate a brand-new pairing that
    // collides with the user's existing one and triggers "parse
    // error" on Trust Wallet / a no-op on MetaMask.
    try {
        await _wcGetClient();
        if (_wcBrowserSession && _wcAddress) {
            if (_wcAddress.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
                throw _wcRpcError('Wrong WalletConnect wallet connected. Please connect your GoodMarket wallet.', 4001);
            }
            _wcMode = "browser";
            return _wcAddress;
        }
    } catch (err) {
        if (err && err.code === 4001) throw err;
        // SDK init / session-restore failures are non-fatal; fall
        // through to the sidecar / fresh-pairing fallback.
        console.warn('WalletConnect session restore failed; falling back:', err);
    }
    try {
        return await _wcSidecarConnect();
    } catch (err) {
        // Only fall through to the in-browser SignClient when the
        // sidecar wasn't reachable in the first place. Real user
        // outcomes (rejection, timeout) must propagate so we don't
        // surprise them with a *second* QR after they already
        // dismissed the first one.
        if (!err || !err._sidecarUnavailable) throw err;
        console.warn('WalletConnect sidecar unavailable; using browser fallback.');
    }
    return await _wcBrowserConnect();
}

async function _wcBridgeRequest(methodOrObj, rawParams) {
    // Normalise both calling conventions:
    //   EIP-1193 (ethers BrowserProvider): request({ method, params })
    //   Two-arg legacy:                    request(method, params)
    let method, params;
    if (methodOrObj && typeof methodOrObj === 'object' && typeof methodOrObj.method === 'string') {
        method = methodOrObj.method;
        params = methodOrObj.params;
    } else {
        method = methodOrObj;
        params = rawParams;
    }
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        if (!_wcAddress) await _wcConnectSwap();
        return [_wcAddress];
    }
    if (method === 'eth_chainId') return '0xa4ec';
    if (method === 'net_version') return '42220';
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
    if (method === 'eth_sendTransaction') {
        if (!_wcAddress) await _wcConnectSwap();
        const txParams = (params && params[0]) ? params[0] : {};
        if (_wcMode === "sidecar") {
            const txResp = await fetch('/api/wc-tx/' + encodeURIComponent(_wcSessionId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(txParams)
            });
            const txData = await txResp.json();
            if (!txResp.ok || !txData.success || txData.error || !txData.txHash) {
                const rawErr = (txData && txData.error) ? String(txData.error) : 'WalletConnect transaction failed';
                const isReject = /user rejected|user denied|user disapproved|rejected|cancelled|canceled/i.test(rawErr);
                throw _wcRpcError(rawErr, isReject ? 4001 : -32603);
            }
            return txData.txHash;
        }
        if (!_wcBrowserSession) throw _wcRpcError('WalletConnect browser session is not active.', -32603);
        const client = await _wcGetClient();
        let txHash;
        try {
            const reqPromise = client.request({
                topic: _wcBrowserSession.topic,
                chainId: _wcEip155Chain(_wcBrowserSession, 'eth_sendTransaction', [txParams]),
                request: { method: 'eth_sendTransaction', params: [txParams] }
            });
            // Bring MetaMask Mobile / Trust Wallet to the foreground
            // so the user actually sees the tx prompt instead of
            // staring at the dApp tab while the request quietly
            // sits in the wallet's relay queue.
            _wcWakeWalletApp(_wcBrowserSession);
            txHash = await reqPromise;
        } catch (wcErr) {
            // WalletConnect SignClient throws a JsonRpcError-shaped
            // object; preserve its code/message so the wallet's
            // "user rejected" surfaces as a friendly cancellation
            // instead of an opaque "could not coalesce error".
            const code = (wcErr && typeof wcErr.code === 'number') ? wcErr.code : -32603;
            const msg = (wcErr && wcErr.message) ? String(wcErr.message) : 'WalletConnect transaction failed';
            throw _wcRpcError(msg, code);
        }
        if (!txHash) throw _wcRpcError('WalletConnect transaction failed', -32603);
        return txHash;
    }
    return _celoJsonRpc(method, params || []);
}


async function _swapGetPrivyProviderIfPreferred(options = {}) {
    if (!IS_PRIVY_LOGIN) return null;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 4000;
    const start = Date.now();
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    while (Date.now() - start < timeoutMs) {
        try {
            const wallets = Array.isArray(window.GMPrivyWallets) ? window.GMPrivyWallets : [];
            const sessionWallet = (WALLET_ADDRESS || '').toLowerCase();
            const wallet = wallets.find(w => (w.address || '').toLowerCase() === sessionWallet)
                || wallets.find(w => w.walletClientType === 'privy')
                || wallets[0];
            if (wallet && typeof wallet.getEthereumProvider === 'function') {
                const provider = await wallet.getEthereumProvider();
                if (provider && typeof provider.request === 'function') {
                    provider.__gmPrivyProvider = true;
                    return provider;
                }
            }
            if (window.GMPrivyReady && !window.GMPrivyAuthenticated && typeof window.GMPrivyLogin === 'function' && options.promptLogin) {
                await window.GMPrivyLogin();
            }
        } catch (err) {
            if (err && (err.code === 4001 || /reject|cancel/i.test(String(err.message || '')))) throw err;
            console.warn('[privy] provider lookup failed:', err);
        }
        await wait(150);
    }
    return null;
}

// Local self-custodial accounts (login_method === 'local') sign with
// the browser-generated wallet decrypted via PIN — same provider
// interface as Privy/injected, but reads route straight to Celo RPC.
// Never falls through to an injected provider: while locked it opens
// the PIN prompt (or throws if no modal is available), because an
// injected MetaMask would be a different account entirely.
async function _swapGetLocalWalletProvider() {
    if ((LOGIN_METHOD || '').toLowerCase() !== 'local') return null;
    if (typeof GMLocalWallet === 'undefined') return null;
    if (!GMLocalWallet.isUnlocked()) {
        if (typeof window._lwOpenUnlockModal === 'function') {
            await window._lwOpenUnlockModal();
        } else {
            throw new Error('Please unlock your wallet. Reload the page and log in again.');
        }
    }
    return GMLocalWallet.getProvider();
}

async function getConnectedSwapSigner() {
    if (window.useServerSigning) {
        throw new Error('This account uses server-side signing. Please use automatic server signing mode.');
    }
    const localProvider = await _swapGetLocalWalletProvider();
    if (localProvider) {
        // Celo-only swaps — the in-app wallet may still be on XDC
        // after a bridge, so switch back before wrapping (no-op).
        await localProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0xa4ec' }]
        });
        // Wrap like every other branch: callers use signer.provider and
        // new ethers.Contract(..., signer), which need a real ethers
        // Signer — the raw EIP-1193 bridge alone is not a valid runner.
        const provider = new ethers.BrowserProvider(localProvider);
        const signer = await provider.getSigner();
        const addr = await signer.getAddress();
        if ((addr || '').toLowerCase() !== (WALLET_ADDRESS || '').toLowerCase()) {
            throw new Error('Please unlock your GoodMarket wallet (the one tied to this account) to continue.');
        }
        return signer;
    }
    if (IS_PRIVY_LOGIN) {
        const privyProvider = await _swapGetPrivyProviderIfPreferred({ promptLogin: true, timeoutMs: 10000 });
        if (privyProvider) {
            const currentChain = await privyProvider.request({ method: "eth_chainId" }).catch(() => null);
            if (_normalizeChainIdHex(currentChain) !== "0xa4ec") {
                try {
                    await privyProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4ec" }] });
                } catch (_) {
                    await privyProvider.request({ method: "wallet_addEthereumChain", params: [{
                        chainId: "0xa4ec",
                        chainName: "Celo Mainnet",
                        nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
                        rpcUrls: ["https://forno.celo.org"],
                        blockExplorerUrls: ["https://celoscan.io"]
                    }] });
                }
            }
            const provider = new ethers.BrowserProvider(privyProvider);
            const signer = await provider.getSigner();
            const addr = await signer.getAddress();
            if ((addr || '').toLowerCase() !== (WALLET_ADDRESS || '').toLowerCase()) {
                throw new Error('Wrong Privy wallet connected. Please use your GoodMarket wallet.');
            }
            return signer;
        }
    }
    // If user logged in via WalletConnect, use WC as signer regardless of browser extensions
    if (PREFER_WC_SIGNING) {
        const wcBridgeProvider = { request: _wcBridgeRequest };
        const wcProvider = new ethers.BrowserProvider(wcBridgeProvider);
        const wcSigner = await wcProvider.getSigner();
        const wcAddr = await wcSigner.getAddress();
        if (wcAddr.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
            throw new Error("Wrong WalletConnect wallet connected. Please switch to your GoodMarket wallet.");
        }
        return wcSigner;
    }
    const ethProvider = await _awaitEthProvider();
    if (!ethProvider) {
        throw new Error("No wallet detected. Please connect your GoodMarket wallet.");
    }

    const accounts = await ethProvider.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("No wallet account available.");
    const account = accounts[0];
    if (account.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
        throw new Error("Wrong wallet connected. Please switch to your GoodMarket wallet.");
    }

    const celoChainHex = "0xa4ec";
    const currentChain = await ethProvider.request({ method: "eth_chainId" });
    if (_normalizeChainIdHex(currentChain) !== celoChainHex) {
        try {
            await ethProvider.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: celoChainHex }]
            });
        } catch (switchErr) {
            await ethProvider.request({
                method: "wallet_addEthereumChain",
                params: [{
                    chainId: celoChainHex,
                    chainName: "Celo Mainnet",
                    nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
                    rpcUrls: ["https://forno.celo.org"],
                    blockExplorerUrls: ["https://celoscan.io"]
                }]
            });
        }
    }

    const browserProvider = new ethers.BrowserProvider(ethProvider);
    const signer = await browserProvider.getSigner();
    return signer;
}

// Token addresses on Celo mainnet
const TOKENS = {
    GD: {
        symbol: "G$",
        name: "GoodDollar",
        address: "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
        decimals: 18,        // actual on-chain ERC20 decimals
        displayDecimals: 2,  // how many places to show in UI
        iconClass: "gd",
        iconText: "G$",
        color: "#7c3aed"
    },
    CELO: {
        symbol: "CELO",
        name: "Celo",
        address: "0x471EcE3750Da237f93B8E339c536989b8978a438",
        decimals: 18,
        displayDecimals: 4,
        iconClass: "celo",
        iconText: "CE",
        color: "#35a869"
    },
    CUSD: {
        symbol: "cUSD",
        name: "Celo Dollar",
        address: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
        decimals: 18,
        displayDecimals: 4,
        iconClass: "cusd",
        iconText: "$",
        color: "#f59e0b"
    },
    USDT: {
        symbol: "USDT",
        name: "Tether USD",
        address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
        decimals: 6,
        displayDecimals: 4,
        iconClass: "usdt",
        iconText: "₮",
        color: "#26a17b"
    }
};

// Uniswap V3 on Celo (official, verified deployments).
// Use the current V3 UniversalRouter and Permit2 flow instead of
// legacy SwapRouter02. QuoterV2 remains the read-only quote source.
const UNISWAP_ROUTER   = "0x643770E279d5D0733F21d6DC03A8efbABf3255B4";
const UNISWAP_PERMIT2  = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNISWAP_QUOTER   = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8";
const FEE_TIERS        = [10000, 3000, 500]; // G$/CELO pool is 1% (10000), try it first

// Voltage Finance on Fuse Mainnet (Uniswap V2-compatible router).
const FUSE_CHAIN_ID       = Number(window.GM_SWAP_BOOT.fuseChainId);
const FUSE_CHAIN_HEX      = "0x" + FUSE_CHAIN_ID.toString(16);
const FUSE_RPC            = window.GM_SWAP_BOOT.fuseRpc;
const FUSE_GD_TOKEN       = window.GM_SWAP_BOOT.fuseGdToken;
let fuseGdDecimals        = Number(window.GM_SWAP_BOOT.fuseGdDecimals);
const WFUSE_TOKEN         = window.GM_SWAP_BOOT.fuseWfuse;
const VOLTAGE_ROUTER      = window.GM_SWAP_BOOT.voltageRouter;

// Minimal ABIs
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)"
];

const QUOTER_ABI = [
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
    "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"
];

const UNIVERSAL_ROUTER_ABI = [
    "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"
];

const PERMIT2_ABI = [
    "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
    "function approve(address token, address spender, uint160 amount, uint48 expiration)"
];

const VOLTAGE_ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)"
];

// Encode a Uniswap V3 multi-hop path: [addr0, addr1, addr2, ...] with [fee01, fee12, ...]
function encodePath(tokenAddresses, fees) {
    let encoded = tokenAddresses[0].toLowerCase().replace('0x', '');
    for (let i = 0; i < fees.length; i++) {
        encoded += fees[i].toString(16).padStart(6, '0');
        encoded += tokenAddresses[i + 1].toLowerCase().replace('0x', '');
    }
    return '0x' + encoded;
}

const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n;
const PERMIT2_MAX_EXPIRATION = (1n << 48n) - 1n;
const UNIVERSAL_ROUTER_V3_SWAP_EXACT_IN = "0x00";
const UNIVERSAL_ROUTER_DEADLINE_SECONDS = 20 * 60;

function buildUniversalRouterV3Swap(quote, recipient, amountIn, amountOutMin) {
    const from = TOKENS[quote.fromToken];
    const to = TOKENS[quote.toToken];
    const path = quote.isMulti && quote.path
        ? quote.path
        : encodePath([from.address, to.address], [quote.fee]);
    const input = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256", "bytes", "bool"],
        [recipient, amountIn, amountOutMin, path, true]
    );
    return {
        commands: UNIVERSAL_ROUTER_V3_SWAP_EXACT_IN,
        inputs: [input],
        deadline: BigInt(Math.floor(Date.now() / 1000) + UNIVERSAL_ROUTER_DEADLINE_SECONDS)
    };
}

function encodeUniversalRouterV3SwapData(quote, recipient, amountIn, amountOutMin) {
    const { commands, inputs, deadline } = buildUniversalRouterV3Swap(quote, recipient, amountIn, amountOutMin);
    return new ethers.Interface(UNIVERSAL_ROUTER_ABI).encodeFunctionData("execute", [commands, inputs, deadline]);
}

function permit2StillValid(allowance, amountIn) {
    const now = Math.floor(Date.now() / 1000);
    return allowance && allowance.amount >= amountIn && Number(allowance.expiration) > now + UNIVERSAL_ROUTER_DEADLINE_SECONDS;
}

async function postServerSignedTx(to, data, label) {
    const res = await fetch('/api/server/sign-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, data, value: '0x0', chain_id: CELO_CHAIN_ID, wait_receipt: true })
    });
    const result = await res.json();
    if (!result.success) {
        const errMsg = result.error || `${label} failed`;
        const txLink = result.tx_hash
            ? ` <a href="https://celoscan.io/tx/${result.tx_hash}" target="_blank" rel="noopener" style="color:#f87171;text-decoration:underline;">View on CeloScan ↗</a>`
            : '';
        throw new Error(`${label} reverted: ${errMsg}${txLink}`);
    }
    return result;
}

async function ensureServerPermit2Allowance(token, amountIn) {
    const provider = new ethers.JsonRpcProvider(CELO_RPC);
    const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
    const permit2 = new ethers.Contract(UNISWAP_PERMIT2, PERMIT2_ABI, provider);
    const [erc20Allowance, permit2Allowance] = await Promise.all([
        erc20.allowance(WALLET_ADDRESS, UNISWAP_PERMIT2),
        permit2.allowance(WALLET_ADDRESS, token.address, UNISWAP_ROUTER)
    ]);
    if (erc20Allowance < amountIn) {
        const approveData = new ethers.Interface(ERC20_ABI).encodeFunctionData("approve", [UNISWAP_PERMIT2, ethers.MaxUint256]);
        await postServerSignedTx(token.address, approveData, 'ERC-20 Permit2 approval');
    }
    if (!permit2StillValid(permit2Allowance, amountIn)) {
        const permit2Data = new ethers.Interface(PERMIT2_ABI).encodeFunctionData("approve", [token.address, UNISWAP_ROUTER, PERMIT2_MAX_AMOUNT, PERMIT2_MAX_EXPIRATION]);
        await postServerSignedTx(UNISWAP_PERMIT2, permit2Data, 'Permit2 router approval');
    }
}

async function ensureMiniPayPermit2Allowance(token, amountIn, provider) {
    const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
    const permit2 = new ethers.Contract(UNISWAP_PERMIT2, PERMIT2_ABI, provider);
    const [erc20Allowance, permit2Allowance] = await Promise.all([
        erc20.allowance(WALLET_ADDRESS, UNISWAP_PERMIT2),
        permit2.allowance(WALLET_ADDRESS, token.address, UNISWAP_ROUTER)
    ]);
    if (erc20Allowance < amountIn) {
        await _miniPayTx(token.address,
            "function approve(address spender, uint256 amount) returns (bool)",
            [UNISWAP_PERMIT2, ethers.MaxUint256]);
    }
    if (!permit2StillValid(permit2Allowance, amountIn)) {
        await _miniPayTx(UNISWAP_PERMIT2,
            "function approve(address token, address spender, uint160 amount, uint48 expiration)",
            [token.address, UNISWAP_ROUTER, PERMIT2_MAX_AMOUNT, PERMIT2_MAX_EXPIRATION]);
    }
}

async function ensureWalletPermit2Allowance(token, amountIn, signer, stepIndicators) {
    const provider = signer.provider;
    const tokenContract = new ethers.Contract(token.address, ERC20_ABI, signer);
    const tokenRead = new ethers.Contract(token.address, ERC20_ABI, provider);
    const permit2Read = new ethers.Contract(UNISWAP_PERMIT2, PERMIT2_ABI, provider);
    const [erc20Allowance, permit2Allowance] = await Promise.all([
        tokenRead.allowance(WALLET_ADDRESS, UNISWAP_PERMIT2),
        permit2Read.allowance(WALLET_ADDRESS, token.address, UNISWAP_ROUTER)
    ]);
    if (erc20Allowance < amountIn) {
        try {
            await GMTxPreview.confirm({
                action: 'approve',
                token: token.symbol,
                amount: ethers.formatUnits(amountIn, token.decimals),
                to: UNISWAP_PERMIT2,
                toLabel: 'Uniswap Permit2 (Celo)',
                network: 'Celo',
                note: 'Lets Permit2 manage this token for the UniversalRouter swap.',
            });
        } catch (err) {
            if (GMTxPreview.isCancelled(err)) {
                setSwapBtnState("ready");
                stepIndicators.className = "step-indicators";
                showAlert("alert-info", "Swap cancelled.");
                const cancel = new Error("Swap cancelled.");
                cancel._gmCancelled = true;
                throw cancel;
            }
            throw err;
        }
        const approveTx = await tokenContract.approve(UNISWAP_PERMIT2, ethers.MaxUint256);
        await approveTx.wait();
    }
    if (!permit2StillValid(permit2Allowance, amountIn)) {
        const permit2 = new ethers.Contract(UNISWAP_PERMIT2, PERMIT2_ABI, signer);
        try {
            await GMTxPreview.confirm({
                action: 'approve',
                token: token.symbol,
                amount: ethers.formatUnits(amountIn, token.decimals),
                to: UNISWAP_ROUTER,
                toLabel: 'Uniswap UniversalRouter (Celo)',
                network: 'Celo',
                note: 'Authorizes the verified UniversalRouter to pull this token via Permit2 for swaps.',
            });
        } catch (err) {
            if (GMTxPreview.isCancelled(err)) {
                setSwapBtnState("ready");
                stepIndicators.className = "step-indicators";
                showAlert("alert-info", "Swap cancelled.");
                const cancel = new Error("Swap cancelled.");
                cancel._gmCancelled = true;
                throw cancel;
            }
            throw err;
        }
        const permitTx = await permit2.approve(token.address, UNISWAP_ROUTER, PERMIT2_MAX_AMOUNT, PERMIT2_MAX_EXPIRATION);
        await permitTx.wait();
    }
}

// ─── State ────────────────────────────────────────────────────────────────
let fromToken       = "GD";
let toToken         = "CELO";
let slippage        = 1.0;   // default 1% — 0.5% causes "Too little received" on multi-hop routes
let currentQuote    = null;
let quoteTimer      = null;
let _swapInFlight   = false; // blocks duplicate Uniswap V3 submits while async preflight starts
// Monotonically increasing id for fetchQuote calls so a slow / stale
// response from an earlier attempt can't overwrite the UI state set
// by a newer attempt (causes "no liquidity pool" alert to linger
// even after a successful re-quote, especially on mobile where users
// type slowly enough to trigger multiple debounces).
let _quoteRequestId = 0;
let gdBalanceNum    = 0;    // human-readable float  e.g. 7513.72
let celoBalanceNum  = 0;    // human-readable float  e.g. 0.0290
let cusdBalanceNum  = 0;    // human-readable float  e.g. 1.23
let usdtBalanceNum  = 0;    // human-readable float  e.g. 1.23
let fuseGdBalanceNum = 0;   // Fuse-network G$ balance
let fuseBalanceNum   = 0;   // native FUSE balance
let fuseSwapQuote    = null;
let fuseSwapQuoteTimer = null;
let fuseSwapSlippage = 0.5;
let _fuseSwapQuoteRequestId = 0;
let tokenPickerTarget = null; // "from" or "to"

// ─── Init ─────────────────────────────────────────────────────────────────
window.addEventListener("load", async () => {
    await loadBalances();
    await loadFuseSwapBalances();
    updateUI();
    // Backup click handler for swapBtn to ensure it's always attached
    const swapBtn = document.getElementById("swapBtn");
    if (swapBtn) {
        swapBtn.addEventListener("click", function(e) {
            console.log('[swap] swapBtn click event fired');
            // Only trigger if not already handled by onclick
            if (typeof startSwap === "function" && !swapBtn.disabled) {
                e.preventDefault();
                startSwap();
            }
        });
    }
});

// ─── UI Helpers ───────────────────────────────────────────────────────────
// Route tip configurations: key = "FROM_TO"
const ROUTE_TIPS = {
    "GD_CELO": {
        body: `The direct <strong>G$ → CELO</strong> pool has limited liquidity on Uniswap — you'll often get a poor rate. For better value, swap in two steps:`,
        steps: ["G$", "cUSD", "CELO"],
        note: "Do G$ → cUSD first, then cUSD → CELO in a second swap. You get a much better rate this way."
    },
    "GD_USDT": {
        body: `For better rates, avoid going directly from <strong>G$ → USDT</strong>. Swap in steps instead:`,
        steps: ["G$", "cUSD", "USDT"],
        note: "Swap G$ → cUSD first, then cUSD → USDT. Stablecoin pools have deeper liquidity."
    },
    "CELO_GD": {
        body: `The <strong>CELO → G$</strong> direct pool has limited liquidity. Better route:`,
        steps: ["CELO", "cUSD", "G$"],
        note: "Swap CELO → cUSD first, then cUSD → G$ for a better rate."
    },
    "USDT_GD": {
        body: `For better rates swapping <strong>USDT → G$</strong>, use an intermediate step:`,
        steps: ["USDT", "CELO", "G$"],
        note: "Swap USDT → CELO first, then CELO → G$. Or try USDT → cUSD → G$."
    },
    "CELO_USDT": {
        body: `<strong>CELO → USDT</strong> tip: If you see a poor rate, you can also try routing through cUSD:`,
        steps: ["CELO", "cUSD", "USDT"],
        note: "CELO → cUSD → USDT often gives a slightly better rate than the direct pool."
    },
    "USDT_CELO": {
        body: `<strong>USDT → CELO</strong> tip: Routing through cUSD may improve your rate:`,
        steps: ["USDT", "cUSD", "CELO"],
        note: "USDT → cUSD → CELO may give a better rate than the direct pool."
    }
};

function updateRouteTip() {
    const tipEl  = document.getElementById("routeTip");
    const bodyEl = document.getElementById("routeTipBody");
    const key    = `${fromToken}_${toToken}`;
    const tip    = ROUTE_TIPS[key];

    if (!tip) {
        tipEl.classList.remove("show");
        return;
    }

    const stepsHtml = tip.steps.map((s, i) =>
        `<span class="route-step-badge">${s}</span>` +
        (i < tip.steps.length - 1 ? `<span class="route-step-arrow">→</span>` : "")
    ).join("");

    bodyEl.innerHTML = `
        <div>${tip.body}</div>
        <div class="route-tip-steps">${stepsHtml}</div>
        <div class="route-tip-note">${tip.note}</div>
    `;
    tipEl.classList.add("show");
}

function updateUI() {
    const from = TOKENS[fromToken];
    const to   = TOKENS[toToken];

    document.getElementById("fromTokenIcon").className   = `token-icon ${from.iconClass}`;
    document.getElementById("fromTokenIcon").textContent = from.iconText;
    document.getElementById("fromTokenSymbol").textContent = from.symbol;
    document.getElementById("fromTokenSelector").style.borderColor = `${from.color}55`;

    document.getElementById("toTokenIcon").className   = `token-icon ${to.iconClass}`;
    document.getElementById("toTokenIcon").textContent = to.iconText;
    document.getElementById("toTokenSymbol").textContent = to.symbol;
    document.getElementById("toTokenSelector").style.borderColor = `${to.color}55`;

    displayBalances();
    updateRouteTip();
}

function floorToFixed(num, dp) {
    // Always truncate (floor) instead of round so displayed balance never exceeds actual balance
    const factor = Math.pow(10, dp);
    return (Math.floor(num * factor) / factor).toFixed(dp);
}

function getBalanceFor(tokenKey) {
    if (tokenKey === "GD")   return gdBalanceNum;
    if (tokenKey === "CELO") return celoBalanceNum;
    if (tokenKey === "CUSD") return cusdBalanceNum;
    if (tokenKey === "USDT") return usdtBalanceNum;
    return 0;
}

function displayBalances() {
    const fromNum = getBalanceFor(fromToken);
    const toNum   = getBalanceFor(toToken);
    const fromDp  = TOKENS[fromToken].displayDecimals;
    const toDp    = TOKENS[toToken].displayDecimals;

    document.getElementById("fromBalance").textContent = `${floorToFixed(fromNum, fromDp)} ${TOKENS[fromToken].symbol}`;
    document.getElementById("toBalance").textContent   = `${floorToFixed(toNum, toDp)} ${TOKENS[toToken].symbol}`;

    // Keep the bridge tab balance/summary fresh whenever balances refresh.
    if (typeof updateCeloBridgeBalanceDisplay === "function") {
        try { updateCeloBridgeBalanceDisplay(); } catch (_) { /* no-op */ }
    }
}

function setSlippage(val, btn) {
    slippage = val;
    document.querySelectorAll(".slippage-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (currentQuote) showQuote(currentQuote);
}

function flipTokens() {
    [fromToken, toToken] = [toToken, fromToken];
    document.getElementById("amountIn").value = "";
    document.getElementById("amountOut").value = "";
    currentQuote = null;
    document.getElementById("quoteBox").classList.add("hidden");
    updateUI();
    setSwapBtnState("enter");
    clearAlert();
}

// ─── Token Picker ─────────────────────────────────────────────────────────
function openTokenPicker(target) {
    tokenPickerTarget = target;
    const currentKey = target === "from" ? fromToken : toToken;
    const otherKey   = target === "from" ? toToken   : fromToken;

    document.getElementById("tokenPickerTitle").textContent =
        target === "from" ? "Select token to pay" : "Select token to receive";

    const list = document.getElementById("tokenPickerList");
    list.innerHTML = "";

    for (const [key, token] of Object.entries(TOKENS)) {
        const isSelected = key === currentKey;
        const isDisabled = key === otherKey;
        const div = document.createElement("div");
        div.className = `token-picker-item${isSelected ? " selected" : ""}${isDisabled ? " disabled" : ""}`;
        div.innerHTML = `
            <div class="token-picker-icon token-icon ${token.iconClass}">${token.iconText}</div>
            <div class="token-picker-info">
                <div class="token-picker-symbol">${token.symbol}</div>
                <div class="token-picker-name">${token.name}</div>
            </div>
        `;
        if (!isDisabled) {
            div.onclick = () => selectToken(key);
        }
        list.appendChild(div);
    }

    document.getElementById("tokenPickerOverlay").classList.add("open");
}

function selectToken(key) {
    if (tokenPickerTarget === "from") {
        fromToken = key;
    } else {
        toToken = key;
    }
    closeTokenPicker();
    document.getElementById("amountIn").value = "";
    document.getElementById("amountOut").value = "";
    currentQuote = null;
    document.getElementById("quoteBox").classList.add("hidden");
    updateUI();
    setSwapBtnState("enter");
    clearAlert();
}

function closeTokenPicker() {
    document.getElementById("tokenPickerOverlay").classList.remove("open");
    tokenPickerTarget = null;
}

function closeTokenPickerOnOverlay(event) {
    if (event.target === document.getElementById("tokenPickerOverlay")) {
        closeTokenPicker();
    }
}

function setMax() {
    let maxHuman = getBalanceFor(fromToken);
    if (fromToken === "CELO") maxHuman = Math.max(0, maxHuman - 0.01); // reserve gas
    const dp = TOKENS[fromToken].displayDecimals;
    // Use floor (truncate) instead of round so MAX never exceeds the actual balance
    const factor = Math.pow(10, dp);
    const maxTruncated = Math.floor(maxHuman * factor) / factor;
    document.getElementById("amountIn").value = maxTruncated > 0 ? maxTruncated.toFixed(dp) : "";
    onAmountChange();
}

function setSwapBtnState(state, label) {
    const btn = document.getElementById("swapBtn");
    if (!btn) return; // Guard: button not found, skip
    switch (state) {
        case "enter":
            btn.disabled = true;
            btn.innerHTML = "Enter an amount";
            break;
        case "ready":
            btn.disabled = false;
            btn.innerHTML = `Swap ${TOKENS[fromToken].symbol} → ${TOKENS[toToken].symbol}`;
            break;
        case "loading":
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner-inline"></span> ${label || "Processing..."}`;
            break;
        case "no-wallet":
            btn.disabled = true;
            btn.innerHTML = "⚠️ No wallet detected";
            break;
        case "no-pool":
            btn.disabled = true;
            btn.innerHTML = "No liquidity pool found";
            break;
    }
}

function showAlert(type, html) {
    const el = document.getElementById("swapAlert");
    if (!el) return;
    el.className = `alert ${type} show`;
    el.innerHTML = html;
}

function clearAlert() {
    const el = document.getElementById("swapAlert");
    if (!el) return;
    el.className = "alert";
    el.innerHTML = "";
}

// ─── Load Balances ────────────────────────────────────────────────────────
// Always read balances on-chain for `WALLET_ADDRESS` — i.e. the address
// tied to the GoodMarket session. This matches what every signing path
// already enforces (`getConnectedSwapSigner()` rejects unless
// `signerAddr === WALLET_ADDRESS`), so the displayed balance and the
// pre-flight checks always agree even if the user has a different
// account selected in their MetaMask UI.
//
// Server-signing mode still asks the backend for balances, since the
// signing wallet there is the backend wallet, not WALLET_ADDRESS.
async function loadBalances(forceRefresh = false) {
    // ``forceRefresh`` bypasses the backend's short-lived on-chain balance
    // cache (?force=1) — needed after a balance-changing tx so the
    // refreshed number appears immediately instead of a stale cached
    // pre-swap balance ("hindi nag-reflect agad" symptom).
    try {
        if (window.useServerSigning) {
            const res = await fetch('/api/wallet/balances' + (forceRefresh ? '?force=1' : ''));
            if (res.ok) {
                const data = await res.json();
                if (data.success) {
                    if (data.gd   && data.gd.success)   gdBalanceNum   = parseFloat(data.gd.balance)   || 0;
                    if (data.celo && data.celo.success) celoBalanceNum = parseFloat(data.celo.balance) || 0;
                    if (data.cusd && data.cusd.success) cusdBalanceNum = parseFloat(data.cusd.balance) || 0;
                    if (data.usdt && data.usdt.success) usdtBalanceNum = parseFloat(data.usdt.balance) || 0;
                }
            }
            displayBalances();
            return;
        }

        const provider = new ethers.JsonRpcProvider(CELO_RPC);

        // Canonical address = the GoodMarket-session wallet. Falls back
        // to whatever the injected provider says, then to the backend
        // /api/wallet/balances if no address is available at all.
        let userAddr = (typeof WALLET_ADDRESS === "string" && WALLET_ADDRESS) ? WALLET_ADDRESS : null;
        if (!userAddr) {
            const _ep = _getEthProvider();
            if (_ep) {
                const accounts = await _ep.request({ method: "eth_accounts" });
                if (accounts && accounts.length > 0) userAddr = accounts[0];
            }
        }
        if (!userAddr) {
            const res = await fetch('/api/wallet/balances');
            if (res.ok) {
                const data = await res.json();
                if (data.success) {
                    if (data.gd   && data.gd.success)   gdBalanceNum   = parseFloat(data.gd.balance)   || 0;
                    if (data.celo && data.celo.success) celoBalanceNum = parseFloat(data.celo.balance) || 0;
                    if (data.cusd && data.cusd.success) cusdBalanceNum = parseFloat(data.cusd.balance) || 0;
                    if (data.usdt && data.usdt.success) usdtBalanceNum = parseFloat(data.usdt.balance) || 0;
                }
            }
            displayBalances();
            return;
        }

        const gdContract = new ethers.Contract(TOKENS.GD.address, [
            "function balanceOf(address) view returns (uint256)"
        ], provider);
        const cusdContract = new ethers.Contract(TOKENS.CUSD.address, [
            "function balanceOf(address) view returns (uint256)"
        ], provider);
        const usdtContract = new ethers.Contract(TOKENS.USDT.address, [
            "function balanceOf(address) view returns (uint256)"
        ], provider);
        const [gdRaw, celoNative, cusdRaw, usdtRaw] = await Promise.all([
            gdContract.balanceOf(userAddr),
            provider.getBalance(userAddr),
            cusdContract.balanceOf(userAddr),
            usdtContract.balanceOf(userAddr)
        ]);
        gdBalanceNum   = parseFloat(ethers.formatUnits(gdRaw,      TOKENS.GD.decimals));
        celoBalanceNum = parseFloat(ethers.formatUnits(celoNative,  TOKENS.CELO.decimals));
        cusdBalanceNum = parseFloat(ethers.formatUnits(cusdRaw,     TOKENS.CUSD.decimals));
        usdtBalanceNum = parseFloat(ethers.formatUnits(usdtRaw,     TOKENS.USDT.decimals));
        displayBalances();
    } catch (e) {
        // Even a forced refresh must never break the page - the old cached
        // numbers are better than a spinner block. Fire a retry so the
        // just-swapped balance eventually lands without a manual refresh.
        console.error("loadBalances error:", e);
        if (forceRefresh) {
            setTimeout(() => loadBalances(), 4000);
        }
    }
}

// ─── Amount Change → fetch quote ───────────────────────────────────────────
function onAmountChange() {
    clearTimeout(quoteTimer);
    currentQuote = null;
    document.getElementById("quoteBox").classList.add("hidden");
    document.getElementById("amountOut").value = "";
    clearAlert();

    const raw = document.getElementById("amountIn").value.trim();
    if (!raw || parseFloat(raw) <= 0) {
        setSwapBtnState("enter");
        return;
    }

    setSwapBtnState("loading", "Getting quote...");
    quoteTimer = setTimeout(fetchQuote, 600);
}

// ─── Fetch Quote from Quoter V2 (single-hop + multi-hop) ─────────────────
async function fetchQuote() {
    const raw = document.getElementById("amountIn").value.trim();
    if (!raw || parseFloat(raw) <= 0) { setSwapBtnState("enter"); return; }

    const myReqId = ++_quoteRequestId;
    const from    = TOKENS[fromToken];
    const to      = TOKENS[toToken];
    const amountIn = ethers.parseUnits(raw, from.decimals);

    try {
        const provider = new ethers.JsonRpcProvider(CELO_RPC);
        const quoter   = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, provider);

        let bestQuote    = null;
        let bestFee      = null;
        let bestPath     = null;
        let bestIsMulti  = false;
        let bestMidToken = null;

        // ── Build all quote attempts (single-hop + multi-hop) ──────────────
        const attempts = [];

        // Single-hop: try every fee tier
        for (const fee of FEE_TIERS) {
            attempts.push(
                quoter.quoteExactInputSingle.staticCall({
                    tokenIn:           from.address,
                    tokenOut:          to.address,
                    amountIn:          amountIn,
                    fee:               fee,
                    sqrtPriceLimitX96: 0n
                }).then(([amountOut]) => ({ amountOut, fee, path: null, isMulti: false, midToken: null }))
                  .catch(() => null)
            );
        }

        // Multi-hop: route through cUSD and USDT as intermediates
        const INTERMEDIATES = ['CUSD', 'USDT'];
        const HOP_FEES = [10000, 3000, 500];
        for (const midKey of INTERMEDIATES) {
            if (midKey === fromToken || midKey === toToken) continue;
            const mid = TOKENS[midKey];
            for (const fee1 of HOP_FEES) {
                for (const fee2 of HOP_FEES) {
                    const path = encodePath(
                        [from.address, mid.address, to.address],
                        [fee1, fee2]
                    );
                    attempts.push(
                        quoter.quoteExactInput.staticCall(path, amountIn)
                            .then(([amountOut]) => ({ amountOut, fee: fee1, path, isMulti: true, midToken: midKey }))
                            .catch(() => null)
                    );
                }
            }
        }

        // Run all attempts in parallel for speed
        const results = await Promise.all(attempts);

        // Bail if a newer fetchQuote() has superseded this one — its
        // result will paint the UI; ours would only stomp on it.
        if (myReqId !== _quoteRequestId) return;

        for (const r of results) {
            if (!r) continue;
            if (bestQuote === null || r.amountOut > bestQuote) {
                bestQuote    = r.amountOut;
                bestFee      = r.fee;
                bestPath     = r.path;
                bestIsMulti  = r.isMulti;
                bestMidToken = r.midToken;
            }
        }

        // Parallel quote bursts can occasionally have every single
        // attempt fail (forno rate-limits, transient 5xx, mobile
        // network hiccups). Retry the single-hop fee tiers
        // sequentially before giving up — much more reliable on
        // mobile / WalletConnect setups.
        if (bestQuote === null) {
            for (const fee of FEE_TIERS) {
                try {
                    const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
                        tokenIn:           from.address,
                        tokenOut:          to.address,
                        amountIn:          amountIn,
                        fee:               fee,
                        sqrtPriceLimitX96: 0n
                    });
                    if (amountOut && amountOut > 0n) {
                        bestQuote   = amountOut;
                        bestFee     = fee;
                        bestPath    = null;
                        bestIsMulti = false;
                        bestMidToken = null;
                        break;
                    }
                } catch (_) { /* keep trying remaining fee tiers */ }
            }
            if (myReqId !== _quoteRequestId) return;
        }

        if (bestQuote === null) {
            setSwapBtnState("no-pool");
            showAlert("alert-error", "❌ Couldn't fetch a quote on Uniswap V3 (Celo) right now. Please check your connection and try again.");
            return;
        }

        currentQuote = {
            amountIn,
            amountOut: bestQuote,
            fee:       bestFee,
            path:      bestPath,
            isMulti:   bestIsMulti,
            midToken:  bestMidToken,
            fromToken,
            toToken
        };

        showQuote(currentQuote);

        // Wipe any stale error alert left by an earlier failed
        // fetchQuote (e.g. user typed slowly, the first attempt
        // raced and showed "couldn't fetch a quote" before the
        // newer attempt succeeded). Without this, the bad alert
        // lingers next to a perfectly valid quote.
        clearAlert();

        // Users who logged in via WalletConnect (or manual address)
        // don't have an injected `window.ethereum`, but we can still
        // sign their swap through the shared WalletConnect bridge
        // (`_wcBridgeRequest` / `getConnectedSwapSigner`). Don't lock
        // the button for them — they'll get a QR / approval prompt
        // when they actually click "Swap".
        // Privy does not inject a global `window.ethereum` provider.
        // Its signer is resolved lazily in getConnectedSwapSigner() via
        // _swapGetPrivyProviderIfPreferred(), so treating `_getEthProvider()`
        // as the only wallet signal leaves the Uniswap V3 button stuck on
        // "No wallet detected" for Privy logins even though GoodReserve
        // can sign successfully through the same helper.
        // Local in-app wallets sign via GMLocalWallet (PIN prompt on
        // click), so they are "ready" even with no injected provider.
        const _isLocalLogin = (LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined';
        if (_getEthProvider() || PREFER_WC_SIGNING || IS_PRIVY_LOGIN || _isLocalLogin) {
            setSwapBtnState("ready");
        } else {
            setSwapBtnState("no-wallet");
        }

    } catch (e) {
        if (myReqId !== _quoteRequestId) return;
        console.error("fetchQuote error:", e);
        showAlert("alert-error", "❌ Could not fetch quote. Check your connection and try again.");
        setSwapBtnState("enter");
    }
}

// For multi-hop routes the price can shift more during approval+execution;
// enforce a 2 % floor so we don't get "Too little received" reverts.
function effectiveSlippage(quote) {
    return (quote && quote.isMulti) ? Math.max(slippage, 2.0) : slippage;
}

function showQuote(quote) {
    const from     = TOKENS[quote.fromToken];
    const to       = TOKENS[quote.toToken];
    const inHuman  = parseFloat(ethers.formatUnits(quote.amountIn,  from.decimals));
    const outHuman = parseFloat(ethers.formatUnits(quote.amountOut, to.decimals));

    const effSlip  = effectiveSlippage(quote);
    const minOut      = quote.amountOut * BigInt(Math.floor((1 - effSlip / 100) * 10000)) / 10000n;
    const minOutHuman = parseFloat(ethers.formatUnits(minOut, to.decimals));

    document.getElementById("amountOut").value = outHuman.toFixed(to.displayDecimals);
    document.getElementById("quoteRate").textContent =
        `1 ${from.symbol} ≈ ${(outHuman / inHuman).toFixed(to.displayDecimals)} ${to.symbol}`;
    document.getElementById("quoteMinOut").textContent =
        `${minOutHuman.toFixed(to.displayDecimals)} ${to.symbol}`;
    document.getElementById("quotePriceImpact").textContent = "< 1%";
    if (quote.isMulti && quote.midToken) {
        const midSym = TOKENS[quote.midToken].symbol;
        document.getElementById("quotePoolFee").textContent =
            `Multi-hop via ${midSym} (best route)` + (effSlip > slippage ? ` · ${effSlip}% slip applied` : '');
    } else {
        document.getElementById("quotePoolFee").textContent = `${quote.fee / 10000}%`;
    }
    document.getElementById("quoteBox").classList.remove("hidden");
}

// ─── Execute Swap ──────────────────────────────────────────────────────────
// Local wallets: prompt for PIN if the wallet has auto-locked.
async function _lwUnlockIfNeeded() {
    const needed = (LOGIN_METHOD || '').toLowerCase() === 'local'
        && typeof GMLocalWallet !== 'undefined'
        && !GMLocalWallet.isUnlocked();
    if (!needed) return;
    if (typeof window._lwOpenUnlockModal === 'function') {
        await window._lwOpenUnlockModal();
    } else {
        throw new Error('Please unlock your wallet. Reload the page and log in again.');
    }
}

async function startSwap() {
    console.log('[swap] startSwap called, currentQuote:', currentQuote ? 'present' : 'null');
    if (_swapInFlight) {
        showAlert("alert-info", `<span class="spinner-inline"></span> Swap is already being prepared. Please wait…`);
        return;
    }
    if (!currentQuote) { showAlert("alert-error", "Please enter an amount first."); return; }

    // Local wallets: prompt for PIN if the wallet has auto-locked.
    try { await _lwUnlockIfNeeded(); } catch (e) { showAlert("alert-error", "Please unlock your wallet to continue."); return; }

    _swapInFlight = true;
    setSwapBtnState("loading", "Preparing swap…");
    try {
    clearAlert();
    const from  = TOKENS[fromToken];
    const to    = TOKENS[toToken];
    console.log('[swap] swap params:', from.symbol, '->', to.symbol, 'amountIn:', currentQuote.amountIn);

    // MiniPay-only pre-flight: if the user holds CELO but has zero
    // stablecoin balance, MiniPay's CIP-64 fee abstraction has
    // MiniPay users need stablecoin (cUSD/USDT/USDC) for gas, not CELO.
    // Instead of auto-faucet (which wastes faucet funds), guide users to
    // claim G$ on GoodMarket first to receive cUSD for gas.
    if (window.MPGasTopUp && window.MPGasTopUp.isMiniPay() && (LOGIN_METHOD || '').toLowerCase() !== 'local') {
        // Check if user has stablecoin for gas
        const hasStablecoin = await checkMiniPayStablecoinBalance();
        if (!hasStablecoin) {
            showSwapAlert('alert-error',
                '❌ Swap requires stablecoin for gas<br><br>'
                + 'MiniPay uses stablecoins (cUSD/USDT/USDC) for transaction fees, not CELO.<br><br>'
                + 'Please claim your G$ on GoodMarket first to receive gas support, or keep at least ~0.015 cUSD/USDT/USDC for fees.<br><br>'
                + '<button onclick="window.location.href=\'/wallet\'" '
                + 'style="background:linear-gradient(135deg,#7c3aed,#5b21b6);border:none;border-radius:12px;'
                + 'color:#fff;font-size:0.9rem;font-weight:700;padding:0.7rem 1.2rem;cursor:pointer;">'
                + '💰 Claim G$ on GoodMarket</button>'
            );
            setSwapBtnState("enter");
            return;
        }
    }
    const stepIndicators = document.getElementById("stepIndicators");
    const step1 = document.getElementById("step1");
    const step2 = document.getElementById("step2");

    // ── Server-signing mode: server-side approve + swap ──
    if (window.useServerSigning) {
        try {
            // On Celo, CELO is both the native gas token AND an ERC-20 sharing
            // the same balance. Gas is deducted from the native balance BEFORE
            // the ERC-20 transferFrom check runs, so if amountIn is too close to
            // the total balance the pool's safeTransferFrom will see insufficient
            // funds and revert with STF. Reserve 0.01 CELO (1e16 wei) for gas.
            const GAS_BUFFER_CELO = 10_000_000_000_000_000n; // 0.01 CELO in wei (covers 300k gas @ 33 gwei)
            let amountIn = currentQuote.amountIn;
            if (fromToken === "CELO") {
                // Parse balance string precisely to avoid floating-point errors
                const celoBalStr = String(celoBalanceNum);
                const dotIdx = celoBalStr.indexOf('.');
                const intPart = dotIdx === -1 ? celoBalStr : celoBalStr.slice(0, dotIdx);
                const rawFrac = dotIdx === -1 ? '' : celoBalStr.slice(dotIdx + 1);
                const fracPart = rawFrac.padEnd(18, '0').slice(0, 18);
                const celoWei = BigInt(intPart) * 1_000_000_000_000_000_000n + BigInt(fracPart);
                const maxSafe = celoWei > GAS_BUFFER_CELO ? celoWei - GAS_BUFFER_CELO : 0n;
                console.log(`[swap-celo-guard] celoBalanceNum=${celoBalanceNum} celoWei=${celoWei} maxSafe=${maxSafe} amountIn=${amountIn}`);
                if (amountIn > maxSafe) {
                    if (maxSafe <= 0n) {
                        showAlert("alert-error", "❌ Insufficient CELO — need at least 0.01 CELO for gas fees.");
                        setSwapBtnState("ready");
                        return;
                    }
                    amountIn = maxSafe;
                    showAlert("alert-info", `ℹ️ Swap amount reduced slightly to reserve 0.01 CELO for gas fees.`);
                }
            }
            const effSlip     = effectiveSlippage(currentQuote);
            const slippageBps = BigInt(Math.floor(effSlip * 100));

            // Step 1: Approve (use 2× amountIn so we don't need to re-approve
            // for small balance fluctuations)
            stepIndicators.className = "step-indicators show";
            step1.className = "step active";
            step2.className = "step";
            setSwapBtnState("loading", "Approving token...");
            const modeLabel = 'secure server-side';
            showAlert("alert-info", `<span class="spinner-inline"></span> Step 1/2 — Approving ${from.symbol} for Uniswap (${modeLabel})…`);

            await ensureServerPermit2Allowance(from, amountIn);
            step1.className = "step done";

            // ── Re-fetch quote after approval to get a fresh amountOutMin ──
            // The approval tx takes ~3 s on Celo. Price can move during that
            // window; using the original quote's output as amountOutMin will
            // cause "Too little received" reverts if it moved even slightly.
            let freshAmountOut = currentQuote.amountOut;
            try {
                const freshProvider = new ethers.JsonRpcProvider(CELO_RPC);
                const freshQuoter = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, freshProvider);
                if (currentQuote.isMulti && currentQuote.path) {
                    const [newOut] = await freshQuoter.quoteExactInput.staticCall(currentQuote.path, amountIn);
                    freshAmountOut = newOut;
                } else {
                    const [newOut] = await freshQuoter.quoteExactInputSingle.staticCall({
                        tokenIn: from.address,
                        tokenOut: to.address,
                        amountIn: amountIn,
                        fee: currentQuote.fee,
                        sqrtPriceLimitX96: 0n
                    });
                    freshAmountOut = newOut;
                }
                console.log(`[swap] re-quote: oldOut=${currentQuote.amountOut} freshOut=${freshAmountOut}`);
            } catch (reQuoteErr) {
                console.warn('[swap] re-quote failed, using original quote output:', reQuoteErr.message);
            }
            const amountOutMin = freshAmountOut * (10000n - slippageBps) / 10000n;

            // ── Verify on-chain allowance + balance before swap ────────────
            const diagProvider = new ethers.JsonRpcProvider(CELO_RPC);
            const diagToken = new ethers.Contract(from.address, [
                "function balanceOf(address) view returns (uint256)"
            ], diagProvider);
            const diagPermit2 = new ethers.Contract(UNISWAP_PERMIT2, PERMIT2_ABI, diagProvider);
            const [permit2Allowance, onChainBalance] = await Promise.all([
                diagPermit2.allowance(WALLET_ADDRESS, from.address, UNISWAP_ROUTER),
                diagToken.balanceOf(WALLET_ADDRESS)
            ]);
            console.log(`[swap] wallet=${WALLET_ADDRESS} balance=${onChainBalance} permit2Allowance=${permit2Allowance.amount} amountIn=${amountIn} amountOutMin=${amountOutMin}`);
            if (permit2Allowance.amount < amountIn) {
                throw new Error(`Permit2 allowance too low: ${permit2Allowance.amount} < ${amountIn}. Approval may not have been confirmed yet.`);
            }
            if (onChainBalance < amountIn) {
                const balHuman  = parseFloat(ethers.formatUnits(onChainBalance, from.decimals)).toFixed(from.displayDecimals);
                const needHuman = parseFloat(ethers.formatUnits(amountIn,       from.decimals)).toFixed(from.displayDecimals);
                throw new Error(`Insufficient ${from.symbol} balance: have ${balHuman}, need ${needHuman}. Please swap a smaller amount.`);
            }
            // ──────────────────────────────────────────────────────────────

            // Step 2: Swap
            step2.className = "step active";
            setSwapBtnState("loading", "Executing swap...");
            showAlert("alert-info", `<span class="spinner-inline"></span> Step 2/2 — Executing swap (${modeLabel})…`);

            const swapData = encodeUniversalRouterV3SwapData(currentQuote, WALLET_ADDRESS, amountIn, amountOutMin);
            const swapRes = await fetch('/api/server/sign-tx', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: UNISWAP_ROUTER, data: swapData, value: '0x0', chain_id: CELO_CHAIN_ID, wait_receipt: true })
            });
            const swapResult = await swapRes.json();
            if (!swapResult.success) {
                const errMsg = swapResult.error || 'Swap failed';
                const txLink = swapResult.tx_hash
                    ? ` <a href="https://celoscan.io/tx/${swapResult.tx_hash}" target="_blank" rel="noopener" style="color:#f87171;text-decoration:underline;">View on CeloScan ↗</a>`
                    : '';
                stepIndicators.className = "step-indicators";
                showAlert("alert-error", `❌ Swap reverted on-chain: ${errMsg.substring(0,150)}${txLink}`);
                if (currentQuote) setSwapBtnState("ready");
                else setSwapBtnState("enter");
                return;
            }
            step2.className = "step done";

            const outHuman = parseFloat(ethers.formatUnits(currentQuote.amountOut, to.decimals));
            const inHuman  = parseFloat(ethers.formatUnits(amountIn, from.decimals));
            showAlert("alert-success",
                `✅ Swap submitted! ${inHuman.toFixed(from.displayDecimals)} ${from.symbol} → ≈${outHuman.toFixed(to.displayDecimals)} ${to.symbol}. ` +
                `<a href="https://celoscan.io/tx/${swapResult.tx_hash}" target="_blank" rel="noopener" style="color:#86efac;text-decoration:underline;">View on CeloScan ↗</a>`
            );
            document.getElementById("amountIn").value  = "";
            document.getElementById("amountOut").value = "";
            currentQuote = null;
            document.getElementById("quoteBox").classList.add("hidden");
            setSwapBtnState("enter");
            stepIndicators.className = "step-indicators";
            displayBalances();
            try { loadBalances(true); } catch (_) {}
        } catch (err) {
            stepIndicators.className = "step-indicators";
            if (err._miniPayDiag) {
                const d = err._miniPayDiag;
                showAlert("alert-error",
                    `❌ MiniPay swap failed<br>` +
                    `<small style="opacity:.75">Step: ${d.fn} → ${d.to.slice(0,10)}…</small><br>` +
                    `<small style="opacity:.75">${d.errorLog.map(e => `code=${e.code} msg=${e.message.substring(0, 80)}`).join('<br>')}</small>`);
            } else {
                const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.shortMessage || err?.message || "Unknown error");
                showAlert("alert-error", `❌ Swap failed: ${friendly}`);
            }
            if (currentQuote) setSwapBtnState("ready");
            else setSwapBtnState("enter");
        }
        return;
    }

    // ── MiniPay CIP-64 mode: bypass ethers.js, use raw eth_sendTransaction ──
    if (_isMiniPay()) {
        try {
            const effSlip     = effectiveSlippage(currentQuote);
            const slippageBps = BigInt(Math.floor(effSlip * 100));
            let amountIn = currentQuote.amountIn;

            // Step 1: Approve
            stepIndicators.className = "step-indicators show";
            step1.className = "step active";
            step2.className = "step";
            setSwapBtnState("loading", "Approving token...");
            showAlert("alert-info", `<span class="spinner-inline"></span> Step 1/2 — Approve ${from.symbol} in MiniPay…`);

            // UniversalRouter pulls swap input through Permit2. MiniPay
            // therefore needs ERC-20 → Permit2 approval plus Permit2 →
            // UniversalRouter allowance before execute(...).
            const rpcProvider = new ethers.JsonRpcProvider(CELO_RPC);
            await ensureMiniPayPermit2Allowance(from, amountIn, rpcProvider);
            step1.className = "step done";

            // Re-quote for fresh price
            let freshAmountOut = currentQuote.amountOut;
            try {
                const freshQuoter = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, rpcProvider);
                if (currentQuote.isMulti && currentQuote.path) {
                    const [newOut] = await freshQuoter.quoteExactInput.staticCall(currentQuote.path, amountIn);
                    freshAmountOut = newOut;
                } else {
                    const [newOut] = await freshQuoter.quoteExactInputSingle.staticCall({
                        tokenIn: from.address,
                        tokenOut: to.address,
                        amountIn: amountIn,
                        fee: currentQuote.fee,
                        sqrtPriceLimitX96: 0n
                    });
                    freshAmountOut = newOut;
                }
            } catch (reQuoteErr) {
                console.warn('[swap] MiniPay re-quote failed, using original:', reQuoteErr.message);
            }
            const amountOutMin = freshAmountOut * (10000n - slippageBps) / 10000n;

            // Step 2: Swap via raw tx
            step2.className = "step active";
            setSwapBtnState("loading", "Executing swap...");
            showAlert("alert-info", `<span class="spinner-inline"></span> Step 2/2 — Confirm swap in MiniPay…`);

            const swapData = encodeUniversalRouterV3SwapData(currentQuote, WALLET_ADDRESS, amountIn, amountOutMin);

            const txHash = await _miniPayRawTx(UNISWAP_ROUTER, swapData, '0x0', 'uniswap.exactInput');
            step2.className = "step done";

            const outHuman = parseFloat(ethers.formatUnits(currentQuote.amountOut, to.decimals));
            const inHuman  = parseFloat(ethers.formatUnits(amountIn, from.decimals));
            showAlert("alert-success",
                `✅ Swap complete! ${inHuman.toFixed(from.displayDecimals)} ${from.symbol} → ≈${outHuman.toFixed(to.displayDecimals)} ${to.symbol}. ` +
                `<a href="https://celoscan.io/tx/${txHash}" target="_blank" rel="noopener" style="color:#86efac;text-decoration:underline;">View on CeloScan ↗</a>`
            );
            document.getElementById("amountIn").value  = "";
            document.getElementById("amountOut").value = "";
            currentQuote = null;
            document.getElementById("quoteBox").classList.add("hidden");
            setSwapBtnState("enter");
            stepIndicators.className = "step-indicators";
            displayBalances();
            try { loadBalances(true); } catch (_) {}
        } catch (err) {
            stepIndicators.className = "step-indicators";
            if (err._miniPayDiag) {
                const d = err._miniPayDiag;
                showAlert("alert-error",
                    `❌ MiniPay swap failed<br>` +
                    `<small style="opacity:.75">Step: ${d.fn} → ${d.to.slice(0,10)}…</small><br>` +
                    `<small style="opacity:.75">${d.errorLog.map(e => `code=${e.code} msg=${e.message.substring(0, 80)}`).join('<br>')}</small>`);
            } else {
                const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.shortMessage || err?.message || "Unknown error");
                showAlert("alert-error", `❌ Swap failed: ${friendly}`);
            }
            if (currentQuote) setSwapBtnState("ready");
            else setSwapBtnState("enter");
        }
        return;
    }

    try {
        const signer = await getConnectedSwapSigner();
        const effSlip = effectiveSlippage(currentQuote);
        const slippageBps = BigInt(Math.floor(effSlip * 100));
        let amountIn = currentQuote.amountIn;

        if (fromToken === "CELO") {
            const GAS_BUFFER_CELO = ethers.parseUnits("0.01", 18);
            const provider = signer.provider;
            const celoWei = await provider.getBalance(WALLET_ADDRESS);
            const maxSafe = celoWei > GAS_BUFFER_CELO ? celoWei - GAS_BUFFER_CELO : 0n;
            if (amountIn > maxSafe) {
                if (maxSafe <= 0n) {
                    showAlert("alert-error", "❌ Insufficient CELO — need at least 0.01 CELO for gas fees.");
                    setSwapBtnState("ready");
                    return;
                }
                amountIn = maxSafe;
                showAlert("alert-info", "ℹ️ Swap amount reduced slightly to reserve 0.01 CELO for gas fees.");
            }
        }

        stepIndicators.className = "step-indicators show";
        step1.className = "step active";
        step2.className = "step";
        setSwapBtnState("loading", "Approving token...");
        showAlert("alert-info", `<span class="spinner-inline"></span> Step 1/2 — Approving ${from.symbol} in your wallet…`);

        await ensureWalletPermit2Allowance(from, amountIn, signer, stepIndicators);
        step1.className = "step done";

        let freshAmountOut = currentQuote.amountOut;
        try {
            const freshProvider = new ethers.JsonRpcProvider(CELO_RPC);
            const freshQuoter = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, freshProvider);
            if (currentQuote.isMulti && currentQuote.path) {
                const [newOut] = await freshQuoter.quoteExactInput.staticCall(currentQuote.path, amountIn);
                freshAmountOut = newOut;
            } else {
                const [newOut] = await freshQuoter.quoteExactInputSingle.staticCall({
                    tokenIn: from.address,
                    tokenOut: to.address,
                    amountIn: amountIn,
                    fee: currentQuote.fee,
                    sqrtPriceLimitX96: 0n
                });
                freshAmountOut = newOut;
            }
        } catch (reQuoteErr) {
            console.warn("[swap] wallet mode re-quote failed, using original quote:", reQuoteErr.message);
        }
        const amountOutMin = freshAmountOut * (10000n - slippageBps) / 10000n;

        step2.className = "step active";
        setSwapBtnState("loading", "Executing swap...");
        showAlert("alert-info", `<span class="spinner-inline"></span> Step 2/2 — Confirm swap in your wallet…`);

        const router = new ethers.Contract(UNISWAP_ROUTER, UNIVERSAL_ROUTER_ABI, signer);
        const { commands, inputs, deadline } = buildUniversalRouterV3Swap(currentQuote, WALLET_ADDRESS, amountIn, amountOutMin);
        const swapTx = await router.execute(commands, inputs, deadline);
        await swapTx.wait();
        step2.className = "step done";

        const outHuman = parseFloat(ethers.formatUnits(currentQuote.amountOut, to.decimals));
        const inHuman  = parseFloat(ethers.formatUnits(amountIn, from.decimals));
        showAlert("alert-success",
            `✅ Swap submitted! ${inHuman.toFixed(from.displayDecimals)} ${from.symbol} → ≈${outHuman.toFixed(to.displayDecimals)} ${to.symbol}. ` +
            `<a href="https://celoscan.io/tx/${swapTx.hash}" target="_blank" rel="noopener" style="color:#86efac;text-decoration:underline;">View on CeloScan ↗</a>`
        );
        document.getElementById("amountIn").value  = "";
        document.getElementById("amountOut").value = "";
        currentQuote = null;
        document.getElementById("quoteBox").classList.add("hidden");
        setSwapBtnState("enter");
        stepIndicators.className = "step-indicators";
        displayBalances();
        try { loadBalances(true); } catch (_) {}
    } catch (err) {
        stepIndicators.className = "step-indicators";
        if (err && err._gmCancelled) {
            showAlert("alert-info", "Swap cancelled.");
        } else {
            // Uniswap Universal Router reverts frequently surface from the
            // wallet/RPC as the opaque "missing revert data" (ethers v6
            // has no revert `data` blob to decode). Re-simulate the exact
            // execute(...) calldata against several public Celo RPCs to
            // recover the real reason, plus an ERC20→Permit2 allowance /
            // balance diagnostic for the most common real causes.
            try {
                const simData = encodeUniversalRouterV3SwapData(
                    currentQuote, WALLET_ADDRESS, amountIn, amountOutMin);
                await _enrichSwapError(err, {
                    to: UNISWAP_ROUTER, data: simData, from: WALLET_ADDRESS, value: '0x0'
                }, {
                    tokenAddr: from.address, spender: UNISWAP_PERMIT2,
                    amountIn: amountIn, tokenSymbol: from.symbol
                });
            } catch (_) { /* keep original error */ }
            const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.shortMessage || err?.message || "Unknown error");
            showAlert("alert-error", `❌ Swap failed: ${friendly}`);
        }
        if (currentQuote) setSwapBtnState("ready");
        else setSwapBtnState("enter");
    }
    } finally {
        _swapInFlight = false;
    }
}

// ═══════════════════════════════════════════════��═══════════════════════
// Fuse Swap tab: Fuse G$ -> native FUSE through Voltage Finance.
// ═══════════════════════════════════════════════════════════════════════
function showFuseSwapAlert(type, html) {
    const el = document.getElementById("fuseSwapAlert");
    if (!el) return;
    el.className = `alert ${type} show`;
    el.innerHTML = html;
}

function clearFuseSwapAlert() {
    const el = document.getElementById("fuseSwapAlert");
    if (!el) return;
    el.className = "alert";
    el.innerHTML = "";
}

function setFuseSwapBtnState(state, label) {
    const btn = document.getElementById("fuseSwapBtn");
    if (!btn) return;
    if (state === "enter") {
        btn.disabled = true;
        btn.innerHTML = "Enter an amount";
    } else if (state === "ready") {
        btn.disabled = false;
        btn.innerHTML = "Swap Fuse G$ → FUSE";
    } else if (state === "loading") {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-inline"></span> ${label || "Processing..."}`;
    } else if (state === "no-pool") {
        btn.disabled = true;
        btn.innerHTML = "No Voltage liquidity found";
    }
}

function updateFuseSwapBalanceDisplay() {
    const gdEl = document.getElementById("fuseSwapGdBalance");
    const fuseEl = document.getElementById("fuseSwapFuseBalance");
    if (gdEl) gdEl.textContent = `${floorToFixed(fuseGdBalanceNum || 0, 2)} G$`;
    if (fuseEl) fuseEl.textContent = `${floorToFixed(fuseBalanceNum || 0, 4)} FUSE`;
}

async function loadFuseSwapBalances() {
    try {
        const res = await fetch('/api/fuse/balances');
        const data = await res.json();
        if (data.success && data.gd_balance && data.gd_balance.success) {
            fuseGdBalanceNum = parseFloat(data.gd_balance.balance) || 0;
            if (data.gd_balance.decimals !== undefined) {
                fuseGdDecimals = parseInt(data.gd_balance.decimals, 10) || fuseGdDecimals;
            }
        }
        if (data.success && data.fuse && data.fuse.success) {
            fuseBalanceNum = parseFloat(data.fuse.balance) || 0;
        }
    } catch (err) {
        console.warn('[fuse-swap] balance load failed:', err);
    }
    updateFuseSwapBalanceDisplay();
}

function setFuseSwapMax() {
    const input = document.getElementById("fuseSwapAmountIn");
    if (!input) return;
    const factor = Math.pow(10, 2);
    const maxTruncated = Math.floor((fuseGdBalanceNum || 0) * factor) / factor;
    input.value = maxTruncated > 0 ? maxTruncated.toFixed(2) : "";
    onFuseSwapAmountChange();
}

function setFuseSwapSlippage(value, btn) {
    fuseSwapSlippage = value;
    document.querySelectorAll('#swapPaneFuse .slippage-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    onFuseSwapAmountChange();
}

function onFuseSwapAmountChange() {
    clearTimeout(fuseSwapQuoteTimer);
    fuseSwapQuote = null;
    const quoteBox = document.getElementById("fuseSwapQuoteBox");
    const amountOut = document.getElementById("fuseSwapAmountOut");
    if (quoteBox) quoteBox.classList.add("hidden");
    if (amountOut) amountOut.value = "";
    clearFuseSwapAlert();

    const raw = (document.getElementById("fuseSwapAmountIn")?.value || "").trim();
    if (!raw || parseFloat(raw) <= 0) {
        setFuseSwapBtnState("enter");
        return;
    }
    setFuseSwapBtnState("loading", "Getting Voltage quote...");
    fuseSwapQuoteTimer = setTimeout(fetchFuseSwapQuote, 600);
}

async function fetchFuseSwapQuote() {
    const raw = (document.getElementById("fuseSwapAmountIn")?.value || "").trim();
    if (!raw || parseFloat(raw) <= 0) { setFuseSwapBtnState("enter"); return; }
    const myReqId = ++_fuseSwapQuoteRequestId;
    try {
        const amountIn = ethers.parseUnits(raw, fuseGdDecimals);
        const provider = new ethers.JsonRpcProvider(FUSE_RPC);
        const router = new ethers.Contract(VOLTAGE_ROUTER, VOLTAGE_ROUTER_ABI, provider);
        const path = [FUSE_GD_TOKEN, WFUSE_TOKEN];
        const amounts = await router.getAmountsOut(amountIn, path);
        if (myReqId !== _fuseSwapQuoteRequestId) return;
        const amountOut = amounts[amounts.length - 1];
        if (!amountOut || amountOut <= 0n) throw new Error('No output from Voltage router.');
        const slippageBps = BigInt(Math.round(fuseSwapSlippage * 100));
        const minOut = amountOut * (10000n - slippageBps) / 10000n;
        fuseSwapQuote = { amountIn, amountOut, minOut, path };

        const inHuman = parseFloat(ethers.formatUnits(amountIn, fuseGdDecimals));
        const outHuman = parseFloat(ethers.formatUnits(amountOut, 18));
        document.getElementById("fuseSwapAmountOut").value = outHuman.toFixed(6);
        document.getElementById("fuseSwapRate").textContent = `1 G$ ≈ ${(outHuman / inHuman).toFixed(8)} FUSE`;
        document.getElementById("fuseSwapMinOut").textContent = `${parseFloat(ethers.formatUnits(minOut, 18)).toFixed(6)} FUSE`;
        document.getElementById("fuseSwapQuoteBox").classList.remove("hidden");
        if (inHuman > fuseGdBalanceNum) {
            setFuseSwapBtnState("enter");
            showFuseSwapAlert("alert-error", `❌ You only have ${floorToFixed(fuseGdBalanceNum, 2)} Fuse G$.`);
            return;
        }
        if ((fuseBalanceNum || 0) <= 0) {
            showFuseSwapAlert("alert-info", "ℹ️ You need a small FUSE balance to pay gas for the approve/swap transactions.");
        }
        setFuseSwapBtnState("ready");
    } catch (err) {
        console.error('[fuse-swap] quote failed:', err);
        fuseSwapQuote = null;
        setFuseSwapBtnState("no-pool");
        showFuseSwapAlert("alert-error", "❌ Could not quote G$ → FUSE on Voltage. Liquidity may be unavailable or the Fuse RPC may be busy.");
    }
}

async function ensureFuseNetwork(ep) {
    const current = await ep.request({ method: 'eth_chainId' });
    if (_normalizeChainIdHex(current) === FUSE_CHAIN_HEX) return;
    try {
        await ep.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: FUSE_CHAIN_HEX }] });
    } catch (switchErr) {
        await ep.request({
            method: 'wallet_addEthereumChain',
            params: [{
                chainId: FUSE_CHAIN_HEX,
                chainName: 'Fuse Mainnet',
                nativeCurrency: { name: 'FUSE', symbol: 'FUSE', decimals: 18 },
                rpcUrls: [FUSE_RPC],
                blockExplorerUrls: ['https://explorer.fuse.io']
            }]
        });
    }
}

async function getConnectedFuseSigner() {
    // The in-app wallet signs Celo & XDC only — stop before an
    // injected MetaMask on a different account gets prompted instead.
    if ((LOGIN_METHOD || '').toLowerCase() === 'local') {
        throw new Error('The in-app GoodMarket wallet supports Celo & XDC only. The Fuse G$ swap needs MetaMask or another Fuse-compatible wallet — log in with that wallet to use it.');
    }
    const ethProvider = IS_PRIVY_LOGIN
        ? (await _swapGetPrivyProviderIfPreferred({ promptLogin: true, timeoutMs: 10000 }))
        : await _awaitEthProvider();
    if (!ethProvider) {
        throw new Error('No wallet detected for Fuse swap. Open GoodMarket in Privy, MetaMask, or another Fuse-compatible wallet.');
    }
    const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) throw new Error('No wallet account available.');
    if (accounts[0].toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
        throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
    }
    await ensureFuseNetwork(ethProvider);
    const browserProvider = new ethers.BrowserProvider(ethProvider);
    const signer = await browserProvider.getSigner();
    const signerAddr = await signer.getAddress();
    if (signerAddr.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
        throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
    }
    return signer;
}

async function startFuseSwap() {
    if (!fuseSwapQuote) return;
    const btn = document.getElementById("fuseSwapBtn");
    const stepIndicators = document.getElementById("fuseSwapStepIndicators");
    const step1 = document.getElementById("fuseSwapStep1");
    const step2 = document.getElementById("fuseSwapStep2");
    try {
        stepIndicators.className = "step-indicators show";
        step1.className = "step active";
        step2.className = "step";
        setFuseSwapBtnState("loading", "Connecting wallet...");
        clearFuseSwapAlert();

        const signer = await getConnectedFuseSigner();
        const token = new ethers.Contract(FUSE_GD_TOKEN, ERC20_ABI, signer);
        const allowance = await token.allowance(WALLET_ADDRESS, VOLTAGE_ROUTER);
        if (allowance < fuseSwapQuote.amountIn) {
            showFuseSwapAlert("alert-info", `<span class="spinner-inline"></span> Step 1/2 — approve Fuse G$ for Voltage…`);
            if (window.GMTxPreview && GMTxPreview.confirm) {
                try {
                    await GMTxPreview.confirm({
                        action: 'approve',
                        token: 'Fuse G$',
                        amount: ethers.formatUnits(fuseSwapQuote.amountIn, fuseGdDecimals),
                        to: VOLTAGE_ROUTER,
                        toLabel: 'Voltage Router (Fuse)',
                        network: 'Fuse',
                        note: 'Lets Voltage pull exactly your Fuse G$ input for this swap.'
                    });
                } catch (err) {
                    if (GMTxPreview.isCancelled(err)) {
                        setFuseSwapBtnState("ready");
                        stepIndicators.className = "step-indicators";
                        showFuseSwapAlert("alert-info", "Swap cancelled.");
                        return;
                    }
                    throw err;
                }
            }
            const approveTx = await token.approve(VOLTAGE_ROUTER, fuseSwapQuote.amountIn);
            await approveTx.wait();
        }
        step1.className = "step done";

        let freshQuote = fuseSwapQuote;
        try {
            const readProvider = new ethers.JsonRpcProvider(FUSE_RPC);
            const readRouter = new ethers.Contract(VOLTAGE_ROUTER, VOLTAGE_ROUTER_ABI, readProvider);
            const amounts = await readRouter.getAmountsOut(fuseSwapQuote.amountIn, fuseSwapQuote.path);
            const amountOut = amounts[amounts.length - 1];
            const slippageBps = BigInt(Math.round(fuseSwapSlippage * 100));
            freshQuote = {
                ...fuseSwapQuote,
                amountOut,
                minOut: amountOut * (10000n - slippageBps) / 10000n
            };
        } catch (reQuoteErr) {
            console.warn('[fuse-swap] re-quote failed, using original quote:', reQuoteErr);
        }

        step2.className = "step active";
        setFuseSwapBtnState("loading", "Executing swap...");
        showFuseSwapAlert("alert-info", `<span class="spinner-inline"></span> Step 2/2 — confirm Voltage swap in your wallet…`);

        const deadline = Math.floor(Date.now() / 1000) + (20 * 60);
        const router = new ethers.Contract(VOLTAGE_ROUTER, VOLTAGE_ROUTER_ABI, signer);
        const swapTx = await router.swapExactTokensForETH(
            freshQuote.amountIn,
            freshQuote.minOut,
            freshQuote.path,
            WALLET_ADDRESS,
            deadline
        );
        await swapTx.wait();
        step2.className = "step done";

        const inHuman = parseFloat(ethers.formatUnits(freshQuote.amountIn, fuseGdDecimals));
        const outHuman = parseFloat(ethers.formatUnits(freshQuote.amountOut, 18));
        showFuseSwapAlert("alert-success",
            `✅ Swap submitted! ${inHuman.toFixed(2)} Fuse G$ → ≈${outHuman.toFixed(6)} FUSE. ` +
            `<a href="https://explorer.fuse.io/tx/${swapTx.hash}" target="_blank" rel="noopener" style="color:#86efac;text-decoration:underline;">View on Fuse Explorer ↗</a>`
        );
        document.getElementById("fuseSwapAmountIn").value = "";
        document.getElementById("fuseSwapAmountOut").value = "";
        document.getElementById("fuseSwapQuoteBox").classList.add("hidden");
        fuseSwapQuote = null;
        setFuseSwapBtnState("enter");
        stepIndicators.className = "step-indicators";
        await loadFuseSwapBalances();
    } catch (err) {
        console.error('[fuse-swap] swap failed:', err);
        if (stepIndicators) stepIndicators.className = "step-indicators";
        const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.shortMessage || err?.message || "Unknown error");
        showFuseSwapAlert("alert-error", `❌ Fuse swap failed: ${friendly}`);
        if (fuseSwapQuote) setFuseSwapBtnState("ready");
        else setFuseSwapBtnState("enter");
    }
}

