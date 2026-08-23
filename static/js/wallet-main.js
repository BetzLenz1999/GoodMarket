// Extracted from templates/wallet.html inline <script> (load-perf refactor).
// Per-request values come from window.GM_WALLET_BOOT (set inline in wallet.html).
const WALLET = window.GM_WALLET_BOOT.wallet;
    var LOGIN_METHOD = window.GM_WALLET_BOOT.loginMethod;
    const IS_PRIVY_LOGIN = (LOGIN_METHOD || '').toLowerCase() === 'privy';
    const SERVER_PRIVY_WALLET_CLIENT_TYPE = window.GM_WALLET_BOOT.privyWalletClientType;

    // Configure the shared WalletConnect bridge so users that logged in via
    // WalletConnect (no `window.ethereum`) can still claim / send / sign with
    // approval prompts coming back through their original WC session.
    // IMPORTANT: sidecarEnabled=false to prevent new QR from appearing during signing.
    // Signing should use existing session, not create new one.
    if (typeof GMWalletConnect !== "undefined") {
        GMWalletConnect.configure({
            walletAddress: window.GM_WALLET_BOOT.wallet,
            loginMethod: window.GM_WALLET_BOOT.loginMethod,
            projectId: window.GM_WALLET_BOOT.walletConnectProjectId,
            sidecarEnabled: false, // Disabled to prevent QR during signing - use existing WC session
            dappName: "GoodMarket — Wallet",
            dappDescription: "Claim and send GoodDollar on Celo",
            assetVersion: window.GM_WALLET_BOOT.assetVersion,
        });
    }

    const GD_TOKEN_ADDRESS = window.GM_WALLET_BOOT.gdTokenAddress;
    const GOODMARKET_RAFFLE_ADDRESS = window.GM_WALLET_BOOT.raffleContractAddress;
    const GOODMARKET_RAFFLE_ABI = [
        "function currentRoundId() view returns (uint256)",
        "function ENTRY_FEE() view returns (uint256)",
        "function MAX_PARTICIPANTS() view returns (uint16)",
        "function PRIZE_PER_WINNER() view returns (uint256)",
        "function getRound(uint256 roundId) view returns (uint8 status,uint256 participantCount,uint256 winnerCount,bytes32 randomnessSeed,uint256 openedAt,uint256 completedAt)",
        "function hasJoined(uint256 roundId,address user) view returns (bool)",
        "function claimableReward(uint256 roundId,address user) view returns (uint256)",
        "function rewardClaimed(uint256 roundId,address user) view returns (bool)",
        "function joinRaffle() returns (bool)",
        "function withdrawReward(uint256 roundId) returns (bool)"
    ];
    const GD_RAFFLE_TOKEN_ABI = [
        "function allowance(address owner,address spender) view returns (uint256)",
        "function approve(address spender,uint256 amount) returns (bool)"
    ];
    let gdRaffleState = { roundId: null, previousRoundId: null, entryFee: null, status: null, participantCount: 0 };

    function setRaffleAlert(type, message) {
        const box = document.getElementById('raffleAlert');
        if (!box) return;
        box.className = 'raffle-alert show ' + (type || 'info');
        box.innerHTML = message || '';
    }

    function setRaffleButtons(joinDisabled, withdrawDisabled, joinText, withdrawText) {
        const joinBtn = document.getElementById('joinRaffleBtn');
        const withdrawBtn = document.getElementById('withdrawRaffleBtn');
        if (joinBtn) {
            joinBtn.disabled = !!joinDisabled;
            if (joinText) joinBtn.textContent = joinText;
        }
        if (withdrawBtn) {
            withdrawBtn.disabled = !!withdrawDisabled;
            if (withdrawText) withdrawBtn.textContent = withdrawText;
        }
    }

    function toggleRaffleHowItWorks() {
        const panel = document.getElementById('raffleHowItWorksPanel');
        const btn = document.getElementById('raffleHowItWorksBtn');
        if (!panel) return;
        const isOpen = panel.classList.toggle('show');
        if (btn) btn.textContent = isOpen ? 'Hide details' : 'How it works';
    }

    async function getRaffleProvider() {
        for (let i = 0; i < 30 && !window.ethers; i++) {
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (!window.ethers) throw new Error('Wallet library is still loading. Please try again in a moment.');
        return new ethers.JsonRpcProvider('https://forno.celo.org');
    }

    async function getRaffleSignerProvider() {
        // Local self-custodial accounts sign with the in-app browser wallet —
        // never with an injected MetaMask/extension (a different account).
        if ((LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined') {
            if (!GMLocalWallet.isUnlocked() && typeof _lwUnlockIfNeeded === 'function') {
                await _lwUnlockIfNeeded();
            }
            const localProvider = GMLocalWallet.getProvider();
            const browserProvider = new ethers.BrowserProvider(localProvider);
            const signer = await browserProvider.getSigner();
            const signerAddress = await signer.getAddress();
            if (signerAddress.toLowerCase() !== WALLET.toLowerCase()) {
                throw new Error('Wrong wallet unlocked. Please use your GoodMarket wallet.');
            }
            return { provider: browserProvider, signer };
        }
        const ep = await _vAwaitEthProvider();
        if (!ep) throw new Error('No Web3 wallet detected. Open this page in MiniPay, Privy, or WalletConnect.');
        const chainHex = await ep.request({ method: 'eth_chainId' });
        if (parseInt(chainHex, 16) !== 42220) {
            try {
                await ep.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4ec' }] });
            } catch (switchErr) {
                await ep.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: '0xa4ec',
                        chainName: 'Celo Mainnet',
                        nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
                        rpcUrls: ['https://forno.celo.org'],
                        blockExplorerUrls: ['https://celoscan.io']
                    }]
                });
            }
        }
        const browserProvider = new ethers.BrowserProvider(ep);
        const signer = await browserProvider.getSigner();
        const signerAddress = await signer.getAddress();
        if (signerAddress.toLowerCase() !== WALLET.toLowerCase()) {
            throw new Error('Wrong wallet connected. Please use your GoodMarket wallet.');
        }
        return { provider: browserProvider, signer };
    }

    function raffleStatusText(status) {
        if (status === 0) return 'Open';
        if (status === 1) return 'Drawing';
        if (status === 2) return 'Completed';
        return 'Unknown';
    }

    function openGdRafflePanel() {
        const modal = document.getElementById('raffleModal');
        if (!modal) return;
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        refreshGdRaffle();
    }

    function closeGdRafflePanel(event) {
        if (event && event.target && event.currentTarget && event.target !== event.currentTarget) return;
        const modal = document.getElementById('raffleModal');
        if (!modal) return;
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    async function refreshGdRaffle() {
        const pill = document.getElementById('raffleStatusPill');
        if (!GOODMARKET_RAFFLE_ADDRESS) {
            if (pill) pill.textContent = 'Coming soon';
            setRaffleButtons(true, true, 'Raffle not deployed yet', 'Withdraw Reward');
            setRaffleAlert('info', 'G$ Raffle UI is ready. Set <code>GOODMARKET_RAFFLE_CONTRACT_ADDRESS</code> after deploying the contract to enable live participation.');
            return;
        }
        try {
            const provider = await getRaffleProvider();
            const raffle = new ethers.Contract(GOODMARKET_RAFFLE_ADDRESS, GOODMARKET_RAFFLE_ABI, provider);
            const roundId = await raffle.currentRoundId();
            const round = await raffle.getRound(roundId);
            const entryFee = await raffle.ENTRY_FEE();
            const hasJoined = await raffle.hasJoined(roundId, WALLET);
            const previousRoundId = roundId > 1n ? roundId - 1n : 0n;
            let previousReward = 0n;
            let previousClaimed = false;
            let claimRoundId = 0n;
            const scanLimit = previousRoundId > 20n ? previousRoundId - 20n : 0n;
            for (let scanRoundId = previousRoundId; scanRoundId > scanLimit; scanRoundId--) {
                const reward = await raffle.claimableReward(scanRoundId, WALLET);
                const claimed = await raffle.rewardClaimed(scanRoundId, WALLET);
                if (reward > 0n && !claimed) {
                    previousReward = reward;
                    previousClaimed = claimed;
                    claimRoundId = scanRoundId;
                    break;
                }
            }

            gdRaffleState = {
                roundId,
                previousRoundId,
                claimRoundId,
                entryFee,
                status: Number(round.status),
                participantCount: Number(round.participantCount),
                previousReward,
                previousClaimed
            };

            document.getElementById('raffleRound').textContent = '#' + roundId.toString();
            document.getElementById('raffleParticipants').textContent = Number(round.participantCount).toLocaleString() + ' / 400';
            if (pill) pill.textContent = raffleStatusText(Number(round.status));

            const isOpen = Number(round.status) === 0;
            const isFull = Number(round.participantCount) >= 400;
            const canWithdraw = previousReward > 0n && !previousClaimed;
            setRaffleButtons(
                !isOpen || isFull || hasJoined,
                !canWithdraw,
                hasJoined ? 'Already Joined' : (isFull ? 'Round Full' : 'Join G$ Raffle - 250 G$'),
                canWithdraw ? 'Withdraw ' + ethers.formatEther(previousReward) + ' G$' : 'Withdraw Reward'
            );
            if (canWithdraw) {
                setRaffleAlert('success', '🎉 Congratulations! You have an unclaimed raffle reward from round #' + claimRoundId.toString() + '.');
            } else if (hasJoined) {
                setRaffleAlert('info', '✅ You already joined round #' + roundId.toString() + '. Please wait until the round reaches 400 participants.');
            } else if (isOpen && !isFull) {
                setRaffleAlert('info', 'Round is open. Approve 250 G$ and sign Join Raffle to participate.');
            } else {
                setRaffleAlert('info', 'Current round is not accepting entries while the automated raffle keeper finalizes winners.');
            }
        } catch (err) {
            console.error('[G$ Raffle] refresh error', err);
            setRaffleButtons(true, true, 'Join G$ Raffle - 250 G$', 'Withdraw Reward');
            setRaffleAlert('error', 'Could not load raffle contract status: ' + (err && err.message ? err.message : err));
        }
    }

    async function joinGdRaffle() {
        const btn = document.getElementById('joinRaffleBtn');
        try {
            if (!GOODMARKET_RAFFLE_ADDRESS) throw new Error('Raffle contract is not deployed/configured yet.');
            if (btn) { btn.disabled = true; btn.textContent = 'Preparing...'; }
            const { provider, signer } = await getRaffleSignerProvider();
            const raffle = new ethers.Contract(GOODMARKET_RAFFLE_ADDRESS, GOODMARKET_RAFFLE_ABI, signer);
            const token = new ethers.Contract(GD_TOKEN_ADDRESS, GD_RAFFLE_TOKEN_ABI, signer);
            const entryFee = gdRaffleState.entryFee || await raffle.ENTRY_FEE();
            const allowance = await token.allowance(WALLET, GOODMARKET_RAFFLE_ADDRESS);
            if (allowance < entryFee) {
                setRaffleAlert('info', 'Step 1/2 — approve 250 G$ in your wallet.');
                if (btn) btn.textContent = 'Approve 250 G$...';
                const approveTx = await token.approve(GOODMARKET_RAFFLE_ADDRESS, entryFee);
                await approveTx.wait();
            }
            setRaffleAlert('info', 'Step 2/2 — confirm raffle participation in your wallet.');
            if (btn) btn.textContent = 'Joining...';
            const tx = await raffle.joinRaffle();
            await tx.wait();
            setRaffleAlert('success', '✅ Joined the G$ Raffle successfully.');
            await refreshGdRaffle();
        } catch (err) {
            console.error('[G$ Raffle] join error', err);
            setRaffleAlert('error', '❌ ' + (window.GMTxError ? GMTxError.toFriendlyMessage(err) : (err && err.message ? err.message : err)));
            await refreshGdRaffle();
        }
    }

    async function withdrawGdRaffleReward() {
        const btn = document.getElementById('withdrawRaffleBtn');
        try {
            if (!GOODMARKET_RAFFLE_ADDRESS) throw new Error('Raffle contract is not deployed/configured yet.');
            const roundId = gdRaffleState.claimRoundId;
            if (!roundId || roundId === 0n) throw new Error('No completed round reward found for this wallet.');
            if (btn) { btn.disabled = true; btn.textContent = 'Withdrawing...'; }
            const { signer } = await getRaffleSignerProvider();
            const raffle = new ethers.Contract(GOODMARKET_RAFFLE_ADDRESS, GOODMARKET_RAFFLE_ABI, signer);
            setRaffleAlert('info', 'Confirm reward withdrawal in your wallet.');
            const tx = await raffle.withdrawReward(roundId);
            await tx.wait();
            setRaffleAlert('success', '✅ Raffle reward withdrawn successfully.');
            await refreshGdRaffle();
        } catch (err) {
            console.error('[G$ Raffle] withdraw error', err);
            setRaffleAlert('error', '❌ ' + (window.GMTxError ? GMTxError.toFriendlyMessage(err) : (err && err.message ? err.message : err)));
            await refreshGdRaffle();
        }
    }


    // Robust WalletConnect detection (hoisted so the early provider/signer
    // helpers below can use it). LOGIN_METHOD is primary, but sessions created
    // before login_method was persisted report "injected" for WalletConnect
    // users too; prefersWcSigning() recovers those via a saved WC session for
    // this wallet so they never sign with an injected MetaMask on a different
    // account ("Wrong wallet connected").
    function _gmPreferWc() {
        if (typeof GMWalletConnect !== 'undefined' && typeof GMWalletConnect.prefersWcSigning === 'function') {
            return GMWalletConnect.prefersWcSigning();
        }
        return ['walletconnect', 'manual', 'manual_address'].includes((LOGIN_METHOD || '').toLowerCase());
    }

    // Returns an EIP-1193-shaped provider for WC users when no injected
    // provider is available. `null` if the user can't / shouldn't use
    // WalletConnect (e.g. server-side signing, or a regular browser without
    // a WC login).
    async function _walletGetWcProviderIfPreferred() {
        try {
            if (typeof GMWalletConnect === "undefined") return null;
            if (!GMWalletConnect.isPreferred()) return null;
            return GMWalletConnect.getProvider();
        } catch (_) {
            return null;
        }
    }

    async function _walletGetPrivyProviderIfPreferred(options = {}) {
        if (!IS_PRIVY_LOGIN) return null;
        const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 4000;
        const start = Date.now();
        const wait = (ms) => new Promise(r => setTimeout(r, ms));

        while (Date.now() - start < timeoutMs) {
            try {
                const wallets = Array.isArray(window.GMPrivyWallets) ? window.GMPrivyWallets : [];
                const wallet = wallets.find(w => (w.address || '').toLowerCase() === WALLET.toLowerCase())
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

    // ── WalletConnect SDK helpers for claim signing ───────────
    // Celo RPC URLs for read-only operations
    const _wcCeloRpcUrls = [
        "https://forno.celo.org",
        "https://1rpc.io/celo",
        "https://celo.publicnode.com"
    ];

    // Wallet-scoped methods that need to be forwarded to the WC peer
    const _WC_WALLET_SCOPED_METHODS = new Set([
        'eth_sendTransaction',
        'eth_sign',
        'personal_sign',
        'eth_signTypedData',
        'eth_signTypedData_v3',
        'eth_signTypedData_v4',
        'wallet_addEthereumChain',
        'wallet_switchEthereumChain',
    ]);

    // RPC call with fallback - tries each URL until one succeeds
    async function _wcRpcCallWithFallback(urls, method, params) {
        const lastError = new Error('All RPC endpoints failed');
        for (const url of urls) {
            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: Date.now(),
                        method: method,
                        params: params || []
                    })
                });
                const data = await resp.json();
                if (data && data.error) {
                    throw new Error(data.error.message || 'Celo RPC error');
                }
                return data ? data.result : null;
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError;
    }

    function _wcCeloJsonRpc(method, params) {
        return _wcRpcCallWithFallback(_wcCeloRpcUrls, method, params);
    }

    // Derive the correct eip155 chain string for WalletConnect client.request()
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
        } catch (_) {}
    }

    // Ethers.js compatible provider shim for WalletConnect
    // Mirrors the pattern used in savings.html for WC users
    class WCClaimShim {
        constructor(wcClient, wcSession, account) {
            this._sc = wcClient;
            this._session = wcSession;
            this._account = account;
            console.log('[WCClaimShim] Initialized with:', {
                hasClient: !!wcClient,
                hasSession: !!wcSession,
                sessionTopic: wcSession?.topic,
                account: account
            });
        }
        // Ethers.js BrowserProvider compatibility
        async getAddress() {
            return this._account;
        }
        async request({ method, params }) {
            console.log('[WCClaimShim] request:', method, params);
            
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
                return [this._account];
            }
            if (method === 'eth_chainId') {
                console.log('[WCClaimShim] eth_chainId returning: 0xa4ec');
                return '0xa4ec';
            }
            if (method === 'net_version') return '42220';
            
            if (_WC_WALLET_SCOPED_METHODS.has(method)) {
                var wcChain = _wcEip155Chain(this._session, method, params || []);
                console.log('[WCClaimShim] WC scoped method:', method, '-> chain:', wcChain);
                
                try {
                    _wcWakeWalletApp(this._session);
                    var reqPromise = this._sc.request({
                        topic: this._session.topic,
                        chainId: wcChain,
                        request: { method, params: params || [] }
                    });
                    var result = await reqPromise;
                    console.log('[WCClaimShim] WC request success:', method, '->', result ? result.slice(0, 20) + '...' : 'null');
                    return result;
                } catch (wcErr) {
                    var code = (wcErr && typeof wcErr.code === 'number') ? wcErr.code : -32603;
                    // WalletConnect v2 often wraps the real wallet error inside
                    // wcErr.data.message (e.g. "Invalid RPC URL: …" from the
                    // wallet's broadcaster is nested under an "Internal JSON-RPC
                    // error" envelope). Prefer the nested message so that
                    // _isCeloRpcUnreachableError can detect the real cause.
                    var outerMsg = (wcErr && wcErr.message) ? String(wcErr.message) : '';
                    var dataMsg = (wcErr && wcErr.data && wcErr.data.message) ? String(wcErr.data.message) : '';
                    var msg = dataMsg || outerMsg || 'WalletConnect request failed';
                    console.error('[WCClaimShim] WC request error:', method, '->', msg, 'code:', code, wcErr);
                    var err = new Error(msg);
                    err.code = code;
                    if (wcErr && wcErr.data !== undefined) err.data = wcErr.data;
                    throw err;
                }
            }
            
            // Read-only RPC via Celo RPC
            console.log('[WCClaimShim] RPC call (readonly):', method);
            return _wcCeloJsonRpc(method, params || []);
        }
    }

    // Get signer for claim transactions - prioritizes WC session like savings/swap
    async function getClaimSigner() {
        if (window.useServerSigning) {
            throw new Error('This account uses server-side signing. Please continue with automatic server signing.');
        }
        
        // Only use the WalletConnect session when the user actually logged in via
        // WalletConnect. If they logged in with an injected wallet (Trust Wallet,
        // MetaMask, MiniPay) we must NOT route through a stale WC session stored in
        // localStorage — doing so silently sends the transaction to the WC relay and
        // no popup ever appears in the wallet app.
        // _gmPreferWc() is true for WalletConnect/manual logins AND for
        // pre-existing WC sessions that were mislabeled "injected" before
        // login_method was persisted — so those users still route through the
        // WC session instead of an injected MetaMask on a different account.
        const loginedViaWc = _gmPreferWc();
        
        const wcTopic = localStorage.getItem('wc_session_topic');
        const wcTimestamp = parseInt(localStorage.getItem('wc_session_timestamp') || '0', 10);
        const wcAge = Date.now() - wcTimestamp;
        const wcSessionValid = wcTopic && wcAge < 7 * 24 * 60 * 60 * 1000;
        
        console.log('[getClaimSigner] Checking WC session:', {
            loginMethod: LOGIN_METHOD,
            loginedViaWc,
            hasLocalStorage: !!wcTopic,
            wcAgeMinutes: Math.round(wcAge / 60000),
            wcSessionValid,
            hasWcSignClient: !!window._wcSignClient,
            hasWcSession: !!window._wcSession
        });
        
        if (loginedViaWc && wcSessionValid) {
            try {
                await window._wcGetClient();
            } catch (wcErr) {
                console.warn('[getClaimSigner] WC client init failed:', wcErr);
            }
            
            if (window._wcSignClient && window._wcSession) {
                console.log('[getClaimSigner] Using WCClaimShim for Celo claim');
                const shim = new WCClaimShim(window._wcSignClient, window._wcSession, WALLET);
                return shim;
            } else {
                console.warn('[getClaimSigner] WC client or session not available after init');
            }
        } else if (!loginedViaWc) {
            console.log('[getClaimSigner] Login method is', LOGIN_METHOD, '— skipping WC, using injected provider');
        } else {
            console.log('[getClaimSigner] WC session invalid or expired, falling back to injected');
        }
        
        // Local self-custodial accounts (login_method === 'local') sign with
        // the browser-generated wallet decrypted via PIN.
        if ((LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined') {
            console.log('[getClaimSigner] Using local wallet provider');
            return GMLocalWallet.getProvider();
        }

        if (IS_PRIVY_LOGIN) {
            const privyProvider = await _walletGetPrivyProviderIfPreferred({ promptLogin: true, timeoutMs: 10000 });
            if (privyProvider) {
                console.log('[getClaimSigner] Using Privy embedded wallet provider');
                return privyProvider;
            }
        }

        // Fall back to injected provider
        const ep = await _vAwaitEthProvider();
        if (ep) {
            const accounts = await ep.request({ method: 'eth_requestAccounts' });
            const active = (accounts && accounts[0] || '').toLowerCase();
            if (active && active !== WALLET.toLowerCase()) {
                const walletName = ep.isMetaMask ? 'MetaMask' : ep.isTrust ? 'Trust Wallet' : 'your wallet';
                throw new Error(
                    'Wrong account selected in ' + walletName + '. Please switch to ' +
                    WALLET.slice(0,6) + '…' + WALLET.slice(-4) +
                    ' and try again.'
                );
            }
            console.log('[getClaimSigner] Using injected provider:', ep.isMetaMask ? 'MetaMask' : ep.isTrust ? 'Trust Wallet' : 'Other');
            return ep;
        }
        
        // Try WC without localStorage check
        const wcProvider = await _walletGetWcProviderIfPreferred();
        if (wcProvider) {
            console.log('[getClaimSigner] Using WC provider from bridge');
            return wcProvider;
        }
        
        throw new Error('No wallet connected. Install MetaMask or reconnect via WalletConnect.');
    }

    // ── Token state ──────────────────────────────────────────
    let gdBal = 0, celoBal = 0, cusdBal = 0, usdtBal = 0, usdcBal = 0;
    let xdcBal = 0, xdcGdBal = 0;
    let fuseBal = 0, fuseGdBal = 0;
    let gdUsdPrice = 0;
    let celoUsdValue = 0, cusdUsdValue = 0, usdtUsdValue = 0, usdcUsdValue = 0;
    let selectedToken = 'GD';

    // ── Helpers ──────────────────────────────────────────────
    // Trust Wallet mobile dApp browser (recent builds) exposes its EIP-1193
    // provider only via `window.trustwallet` and/or EIP-6963 announcements —
    // `window.ethereum` can be unset or shimmed to an unrelated provider. We
    // collect all known injections (legacy `window.ethereum`, EIP-5749
    // `window.ethereum.providers`, `window.trustwallet`, EIP-6963 announced
    // providers) so claim / send / FV signing can find the real wallet.
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
            // Initial request at script load. Some wallets only announce after
            // the first request, so this seeds __announced6963Providers ASAP.
            window.dispatchEvent(new Event('eip6963:requestProvider'));
            // Trust Wallet / MetaMask Mobile may inject their provider after
            // DOMContentLoaded finishes. Re-request discovery a few times over
            // ~1s so a late-arriving wallet can still be captured before the
            // user clicks Claim / Send / Sign.
            let _eipRetries = 0;
            const _eipTimer = setInterval(() => {
                try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
                if (++_eipRetries >= 6) clearInterval(_eipTimer);
            }, 200);
            // EIP-1193 `ethereum#initialized` fires when a wallet finishes
            // late injection; re-run EIP-6963 discovery so the picker sees it.
            window.addEventListener('ethereum#initialized', () => {
                try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
            }, { once: true });
        } catch (_) { /* no-op: older browsers / strict CSPs */ }
    })();

    function _eip6963Providers() {
        return Array.isArray(window.__announced6963Providers)
            ? window.__announced6963Providers.slice()
            : [];
    }

    function _isTrustWalletUA() {
        const ua = (navigator.userAgent || '').toLowerCase();
        return ua.includes('trust') || ua.includes('trustwallet');
    }
    function _isTrustWalletMobileContext() {
        const ua = (navigator.userAgent || '').toLowerCase();
        const touchMobile = /android|iphone|ipad|ipod/i.test(ua);
        const hasTrustInjection = !!(
            window.trustwallet ||
            window.trustWallet ||
            (window.ethereum && (window.ethereum.isTrust || window.ethereum.isTrustWallet))
        );
        return (_isTrustWalletUA() || hasTrustInjection) && touchMobile;
    }

    function _pickTrustWallet(candidates) {
        return candidates.find(p => p && (p.isTrust || p.isTrustWallet)) || null;
    }

    function _coerceToRequestProvider(candidate) {
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

    function _collectInjectedProviders() {
        const out = [];
        const push = (p) => {
            const provider = _coerceToRequestProvider(p);
            if (provider && !out.includes(provider)) out.push(provider);
        };
        if (window.ethereum) {
            if (Array.isArray(window.ethereum.providers)) {
                window.ethereum.providers.forEach(push);
            }
            push(window.ethereum);
        }
        if (window.trustwallet) push(window.trustwallet);
        if (window.trustwallet && window.trustwallet.ethereum) push(window.trustwallet.ethereum);
        if (window.trustWallet) push(window.trustWallet);
        if (window.trustWallet && window.trustWallet.ethereum) push(window.trustWallet.ethereum);
        for (const detail of _eip6963Providers()) push(detail.provider);
        return out;
    }

    function _pickProviderFromCandidates(candidates) {
        if (!candidates || !candidates.length) return null;

        // Inside Trust Wallet's in-app dApp browser the authentic provider may
        // only be exposed via `window.trustwallet` or EIP-6963 — pick it first
        // when the UA hints at Trust. Trust Wallet's mobile dApp browser UA is
        // often generic Chrome/Safari, so this branch is a hint, not a gate.
        if (_isTrustWalletUA()) {
            const trust = _pickTrustWallet(candidates);
            if (trust) return trust;
            const trust6963 = _eip6963Providers().find(d => {
                const info = d.info || {};
                const rdns = String(info.rdns || '').toLowerCase();
                const name = String(info.name || '').toLowerCase();
                return rdns.includes('trustwallet') || name.includes('trust');
            });
            if (trust6963 && trust6963.provider) return trust6963.provider;
        }

        // Branded Trust Wallet injection (`window.trustwallet`) wins even when
        // the UA doesn't self-identify — many Trust Wallet mobile builds ship
        // a plain WebView UA but expose the provider via `window.trustwallet`.
        const trustByFlag = candidates.find(p => p && (p.isTrust || p.isTrustWallet));
        if (trustByFlag) return trustByFlag;
        const trustBy6963 = _eip6963Providers().find(d => {
            const info = d.info || {};
            const rdns = String(info.rdns || '').toLowerCase();
            const name = String(info.name || '').toLowerCase();
            return rdns.includes('trustwallet') || name.includes('trust');
        });
        if (trustBy6963 && trustBy6963.provider) return trustBy6963.provider;

        // MiniPay can co-exist with other injections in Opera/Android webviews.
        // Prefer it explicitly so Claim/Send uses the in-app dApp wallet.
        const miniPay = candidates.find(p => p && p.isMiniPay);
        if (miniPay) return miniPay;

        // Preserve existing MetaMask preference for multi-provider setups
        // (e.g. MetaMask + Brave or MetaMask + Coinbase both injecting).
        if (window.ethereum && Array.isArray(window.ethereum.providers) && window.ethereum.providers.length) {
            const mm = window.ethereum.providers.find(p => p.isMetaMask && !p.isBraveWallet);
            if (mm) return mm;
            return window.ethereum.providers[0];
        }

        // Fall back to vanilla `window.ethereum` when present, otherwise return
        // the first non-ethereum injection we found (Trust / EIP-6963 only).
        if (window.ethereum) return window.ethereum;
        return candidates[0];
    }

    function _getEthProvider() {
        // Privy email/social embedded-wallet logins must use Privy's provider,
        // not window.ethereum (which may be absent or point to an unrelated extension).
        if (IS_PRIVY_LOGIN) return null;

        // Local self-custodial logins sign with the in-app browser wallet —
        // an injected provider (e.g. a desktop MetaMask) is a different
        // account and must never be offered.
        if ((LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined') return null;

        // WalletConnect / manual-address logins must NEVER use an injected wallet
        // (e.g. a desktop MetaMask extension): its account differs from the logged-in
        // GoodMarket wallet, so UBI claim / send / FV signing fail with "Wrong wallet
        // connected" / "Invalid URL". Block injected discovery so all flows route
        // through the WalletConnect signer. _gmPreferWc() also recovers
        // pre-existing WC sessions mislabeled as "injected".
        if (_gmPreferWc()) return null;

        // Re-dispatch EIP-6963 discovery on every call — Trust Wallet mobile
        // and some MetaMask Mobile builds announce only after the dApp asks,
        // and idempotent re-dispatch costs nothing for wallets that don't.
        try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

        const candidates = _collectInjectedProviders();
        if (!candidates.length) return null;
        return _pickProviderFromCandidates(candidates);
    }

    // Async variant that tolerates late provider injection. Trust Wallet's
    // in-app dApp browser (recent builds) and some MetaMask Mobile builds
    // inject / announce their EIP-1193 provider asynchronously — sometimes
    // after DOMContentLoaded and sometimes only after the dApp dispatches
    // `eip6963:requestProvider`. Callers that gate user actions (Claim G$,
    // Send, FV signing) should use this instead of the sync `_getEthProvider`
    // so a first click doesn't spuriously fail with "No wallet detected".
    // Privy "connect a wallet" logins inside a dApp browser (MetaMask,
    // Trust Wallet, MiniPay): when the Privy SDK can't produce a provider
    // (session not hydrated, external wallet not re-connected), sign with
    // the in-app injected wallet as long as it is on the same account, so
    // the signing prompt still appears instead of failing silently.
    async function _privyInjectedFallback(timeoutMs) {
        const budget = typeof timeoutMs === 'number' ? timeoutMs : 4000;
        const start = Date.now();
        while (Date.now() - start < budget) {
            try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
            const ep = _pickProviderFromCandidates(_collectInjectedProviders());
            if (ep) {
                try {
                    let accounts = await ep.request({ method: 'eth_accounts' });
                    if (!accounts || !accounts.length) {
                        accounts = await ep.request({ method: 'eth_requestAccounts' });
                    }
                    const active = (accounts && accounts[0] || '').toLowerCase();
                    if (active === WALLET.toLowerCase()) return ep;
                    return null; // injected wallet is on a different account
                } catch (err) {
                    if (err && (err.code === 4001 || /reject|denied/i.test(String(err.message || '')))) return null;
                }
            }
            await new Promise(r => setTimeout(r, 150));
        }
        return null;
    }

    async function _awaitEthProvider(timeoutMs) {
        if (IS_PRIVY_LOGIN) {
            // _getEthProvider() is gated off for Privy logins — resolve the
            // Privy wallet provider first (works for embedded AND external
            // wallets connected through Privy), then fall back to a matching
            // injected wallet, then to a prompted Privy login.
            const privyProvider = await _walletGetPrivyProviderIfPreferred({ promptLogin: false, timeoutMs: 4000 });
            if (privyProvider) return privyProvider;
            const injected = await _privyInjectedFallback(4000);
            if (injected) return injected;
            return await _walletGetPrivyProviderIfPreferred({ promptLogin: true, timeoutMs: 10000 });
        }

        // Keep the longer wait strictly for Trust Wallet mobile.
        const trustBudget = _isTrustWalletMobileContext() ? 4200 : 800;
        const budget = typeof timeoutMs === 'number' ? timeoutMs : trustBudget;
        const stepMs = 120;
        const start = Date.now();

        let first = _getEthProvider();
        if (first) return first;
        while (Date.now() - start < budget) {
            try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
            await new Promise(r => setTimeout(r, stepMs));
            const p = _getEthProvider();
            if (p) return p;
        }
        // WalletConnect fallback: if no injected provider was found, try the
        // existing WC session so users who logged in via WalletConnect can
        // still sign transactions.
        if (!first) {
            const wcPreferred = typeof GMWalletConnect !== 'undefined' && GMWalletConnect.isPreferred();
            if (wcPreferred) {
                const wcProvider = await _walletGetWcProviderIfPreferred();
                if (wcProvider) return wcProvider;
            }
        }
        return null;
    }

    // Re-prime discovery only for Trust Wallet mobile transitions.
    if (_isTrustWalletMobileContext()) {
        window.addEventListener('pageshow', () => {
            try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
        });
    }

    // Compatibility helper used in other GoodMarket templates. Keeping the
    // `_v*` aliases here makes wallet provider selection behavior consistent.
    function _vGetEthProvider() {
        return _getEthProvider();
    }

    async function _vAwaitEthProvider(timeoutMs) {
        return _awaitEthProvider(timeoutMs);
    }

    // Diagnostic: open the claim page inside the failing wallet's dApp browser,
    // then in the console call `window._gmDebugDumpWallets()` to see exactly
    // what the page sees. Useful when reports like "Trust Wallet doesn't work"
    // come in — the dump shows which injection channels are actually present.
    window._gmDebugDumpWallets = function _gmDebugDumpWallets() {
        const candidates = _collectInjectedProviders();
        const info6963 = _eip6963Providers().map(d => ({
            rdns: d.info && d.info.rdns,
            name: d.info && d.info.name,
            uuid: d.info && d.info.uuid
        }));
        const snapshot = {
            page: 'wallet.html',
            userAgent: navigator.userAgent,
            loginMethod: (typeof LOGIN_METHOD === 'string') ? LOGIN_METHOD : null,
            usesServerSigning: !!window.useServerSigning,
            hasWindowEthereum: !!window.ethereum,
            ethereumIsTrust: !!(window.ethereum && window.ethereum.isTrust),
            ethereumIsTrustWallet: !!(window.ethereum && window.ethereum.isTrustWallet),
            ethereumIsMetaMask: !!(window.ethereum && window.ethereum.isMetaMask),
            ethereumIsMiniPay: !!(window.ethereum && window.ethereum.isMiniPay),
            hasWindowTrustwallet: !!window.trustwallet,
            hasWindowTrustWallet: !!window.trustWallet,
            hasWindowTrustwalletEthereum: !!(window.trustwallet && window.trustwallet.ethereum),
            hasWindowTrustWalletEthereum: !!(window.trustWallet && window.trustWallet.ethereum),
            nestedProvidersLength: (window.ethereum && Array.isArray(window.ethereum.providers))
                ? window.ethereum.providers.length : 0,
            eip6963Count: info6963.length,
            eip6963: info6963,
            collectedProviderCount: candidates.length,
            collectedProviderFlags: candidates.map(p => ({
                isTrust: !!p.isTrust,
                isTrustWallet: !!p.isTrustWallet,
                isMetaMask: !!p.isMetaMask,
                isMiniPay: !!p.isMiniPay,
                isBraveWallet: !!p.isBraveWallet,
                isCoinbaseWallet: !!p.isCoinbaseWallet,
                isWalletConnect: !!p.isWalletConnect
            }))
        };
        try { console.log('[GoodMarket wallet debug]', JSON.stringify(snapshot, null, 2)); } catch (_) {}
        return snapshot;
    };

    function isMobile() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }
    function fmt(n, decimals=4) {
        if (n === undefined || n === null) return '—';
        return Number(n).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
    }

    function _normalizeChainIdHex(chainId) {
        if (chainId === null || chainId === undefined) return '';
        if (typeof chainId === 'number' && Number.isFinite(chainId)) {
            return '0x' + chainId.toString(16);
        }
        if (typeof chainId === 'bigint') {
            return '0x' + chainId.toString(16);
        }
        const raw = String(chainId).trim().toLowerCase();
        if (!raw) return '';
        if (raw.startsWith('0x')) return raw;
        if (/^\d+$/.test(raw)) return '0x' + Number(raw).toString(16);
        return raw;
    }

    // ── WalletConnect SDK initialization for claim signing ─────
    // Initialize the WC SignClient SDK and restore session from localStorage
    window._wcGetClient = function() {
        if (window._wcSignClient) return Promise.resolve(window._wcSignClient);
        
        // Pick the SignClient constructor from whichever namespace the SDK UMD bundle used.
        // The @walletconnect/sign-client CDN bundle sets window["@walletconnect/sign-client"],
        // NOT window.WalletConnectSDK — so we check the correct key first.
        function _pickSignClient() {
            var ns1 = window["@walletconnect/sign-client"];
            if (ns1 && ns1.SignClient) return ns1.SignClient;
            var ns2 = window.WalletConnectSDK;
            if (ns2 && ns2.SignClient) return ns2.SignClient;
            return null;
        }

        // Load the WC SDK
        return new Promise(function(resolve, reject) {
            if (_pickSignClient()) {
                resolve();
            } else {
                var script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.17.0/dist/index.umd.js';
                script.onload = function() { resolve(); };
                script.onerror = function() { reject(new Error('Failed to load WalletConnect SDK')); };
                document.head.appendChild(script);
            }
        }).then(function() {
            var SignClient = _pickSignClient();
            if (!SignClient) throw new Error('WalletConnect SDK failed to load — SignClient not found');
            return SignClient.init({
                projectId: window.GM_WALLET_BOOT.walletConnectProjectId,
                metadata: {
                    name: 'GoodMarket — Wallet',
                    description: 'Claim and send GoodDollar on Celo',
                    url: window.location.origin,
                    icons: [window.location.origin + '/static/icons/icon-192x192.png']
                }
            });
        }).then(function(client) {
            window._wcSignClient = client;
            
            // Restore session from localStorage (same pattern as savings.html)
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
                            var activeSessions = client.getActiveSessions();
                            if (activeSessions && typeof activeSessions === 'object') {
                                Object.keys(activeSessions).forEach(function(k) { sdkSessions[k] = activeSessions[k]; });
                            }
                        } catch (_) {}
                        if (Object.keys(sdkSessions).length === 0) {
                            try {
                                var allSessions = client.session.getAll();
                                if (allSessions && allSessions.length) {
                                    allSessions.forEach(function(s) { if (s && s.topic) sdkSessions[s.topic] = s; });
                                }
                            } catch (_) {}
                        }
                        
                        // If SDK has the session, use it
                        if (sdkSessions[storedTopic]) {
                            window._wcSession = sdkSessions[storedTopic];
                            return client;
                        }
                        
                        // Try to restore from localStorage
                        if (parsedSession.topic === storedTopic) {
                            // Subscribe to relay first
                            try {
                                if (client.core && client.core.relayer && typeof client.core.relayer.subscribe === 'function') {
                                    client.core.relayer.subscribe(storedTopic).catch(function(_){});
                                }
                            } catch (_) {}
                            
                            // Inject session
                            try {
                                if (client.session && typeof client.session.set === 'function') {
                                    client.session.set(parsedSession.topic, parsedSession);
                                }
                            } catch (_) {}
                            
                            window._wcSession = parsedSession;
                            return client;
                        }
                    }
                } catch (parseErr) { console.warn('[wallet] localStorage parse error:', parseErr); }
            }
            
            return client;
        });
    };

    // ── MiniPay CIP-64 fee-abstracted tx helpers ──
    function _isMiniPayProvider(provider) {
        return !!(
            provider &&
            (provider.isMiniPay || provider.isMiniPayWallet || provider.isOperaMiniPay)
        );
    }

    function _isMiniPay() {
        const ep = _getEthProvider();
        if (_isMiniPayProvider(ep)) return true;
        if (_isMiniPayProvider(window.ethereum)) return true;
        if (window.ethereum && window.ethereum.providers
            && window.ethereum.providers.some(p => _isMiniPayProvider(p))) return true;
        if (typeof navigator !== 'undefined' && /minipay|OPR.*Mini|Opera.*Mini/i.test(navigator.userAgent || '')) return true;
        return false;
    }

    function _isRpcMethodNotWhitelistedError(err) {
        const raw = String(
            (err && (
                err.shortMessage ||
                err.message ||
                (err.data && err.data.message) ||
                (err.error && err.error.message)
            )) || ''
        ).toLowerCase();
        const code = err && (err.code || (err.error && err.error.code));
        return code === -32601 || /rpc method.*not whitelisted|method.*not whitelisted|not whitelisted/.test(raw);
    }

    const MINIPAY_FEE_CURRENCY = {
        CUSD:         '0x765DE816845861e75A25fCA122bb6898B8B1282a',
        // USDT / USDC need Celo fee-currency adapter addresses in MiniPay.
        USDT_ADAPTER: '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72',
        USDC_ADAPTER: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
    };

    function _miniPayFeeCurrenciesByBalance(options) {
        const opts = options || {};
        const balances = [
            { key: 'cusd', value: Number(opts.cusdBalance ?? cusdBal ?? 0), feeCurrency: opts.cusd || MINIPAY_FEE_CURRENCY.CUSD },
            { key: 'usdt', value: Number(opts.usdtBalance ?? usdtBal ?? 0), feeCurrency: opts.usdt_adapter || MINIPAY_FEE_CURRENCY.USDT_ADAPTER },
            { key: 'usdc', value: Number(opts.usdcBalance ?? usdcBal ?? 0), feeCurrency: opts.usdc_adapter || MINIPAY_FEE_CURRENCY.USDC_ADAPTER },
        ];
        const seen = new Set();
        const ordered = [];

        // MiniPay accepts multiple stablecoin fee currencies. Prefer the token
        // the user actually holds so a USDT-only user does not get blocked by
        // an initial cUSD fee-currency attempt.
        balances
            .filter(item => item.value > 0 && item.feeCurrency)
            .sort((a, b) => b.value - a.value)
            .forEach(item => {
                if (!seen.has(item.feeCurrency)) {
                    seen.add(item.feeCurrency);
                    ordered.push(item.feeCurrency);
                }
            });

        balances.forEach(item => {
            if (item.feeCurrency && !seen.has(item.feeCurrency)) {
                seen.add(item.feeCurrency);
                ordered.push(item.feeCurrency);
            }
        });

        if (opts.includePlain !== false) ordered.push(null);
        return ordered;
    }

    async function _miniPayStableFeeCurrenciesForSend(provider, wallet, options) {
        const opts = options || {};
        if (window.GMMinipayFeeCurrencies && window.GMMinipayFeeCurrencies.orderByBalances) {
            try {
                const ordered = await window.GMMinipayFeeCurrencies.orderByBalances(provider, wallet, {
                    ...opts,
                    // Injected MiniPay requires stablecoin fee currencies for
                    // CIP-64. Do not append the plain/native fallback here:
                    // that fallback asks MiniPay to pay gas with native CELO
                    // and surfaces "insufficient CELO for gas" even when the
                    // user has USDT/cUSD/USDC available.
                    includePlain: false,
                });
                if (ordered && ordered.length) return ordered;
            } catch (err) {
                console.warn('[MiniPay] unable to read stablecoin fee balances; using local fee-currency order:', err);
            }
        }
        return _miniPayFeeCurrenciesByBalance({ ...opts, includePlain: false });
    }

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

    function updateTotalBalanceInGd() {
        const totalBalanceEl = document.getElementById('totalBalanceUSD');
        if (!totalBalanceEl) return;

        // Calculate total balance in USD across supported networks. CELO/cUSD/USDT/USDC
        // USD values come from the backend market-price enrichment; only G$ uses GD_USD_PRICE.
        const marketUsdTotal = (celoUsdValue || 0) + (cusdUsdValue || 0) + (usdtUsdValue || 0) + (usdcUsdValue || 0);
        const gdOnCeloUsd = (gdBal || 0) * (gdUsdPrice || 0);
        const gdOnXdcUsd = (xdcGdBal || 0) * (gdUsdPrice || 0);
        const totalUsd = marketUsdTotal + gdOnCeloUsd + gdOnXdcUsd;

        totalBalanceEl.textContent = '$' + fmt(totalUsd, 2);
    }

    async function handleVirtualCardAction() {
        const virtualCardArticleUrl = 'https://goodmarket.live/news/article/26';
        const hiddenMessage = "This virtual card will be available in Year 2027. No KYC needed. You get an instant card that you can use for online purchases.";
        try {
            const res = await fetch('/api/feature-visibility', { cache: 'no-store' });
            const data = await res.json();
            if (data && data.virtualcard_visible === false) {
                const wantsToReadMore = window.confirm(hiddenMessage + "\n\nTap OK to open the full article.");
                if (wantsToReadMore) {
                    window.open(virtualCardArticleUrl, '_blank', 'noopener,noreferrer');
                }
                return;
            }
        } catch (_) {
            // If the visibility check fails, keep existing behavior and allow navigation.
        }
        navigateWithFeedback('/reloadly/#virtualcard', 'Opening Virtual Card…');
    }

    async function handleMobileTopupAction() {
        const hiddenMessage = "Mobile Top-Up is currently unavailable. Please check back soon.";
        try {
            const res = await fetch('/api/feature-visibility', { cache: 'no-store' });
            const data = await res.json();
            if (data && data.topup_visible === false) {
                window.alert(hiddenMessage);
                return;
            }
        } catch (_) {
            // If the visibility check fails, keep existing behavior and allow navigation.
        }
        navigateWithFeedback('/reloadly/#topup', 'Opening Mobile Top-Up…');
    }

    // ── Modal ────────────────────────────────────────────────
    function openModal(id) {
        // The bottom nav (z-index 1200) stays tappable above any open modal
        // (z-index 200), so a second modal can be triggered while one is open.
        // All modal overlays share z-index 200, so stacking falls back to DOM
        // order — e.g. opening sendModal while gcashModal is open leaves the
        // send sheet invisible behind it ("dead button"). Close any other open
        // modal first. lwUnlockModal is exempt: it is the PIN prompt stacked
        // deliberately on top of the triggering modal (z-index 100000), and
        // closing it here would strand the awaiting sign flow.
        document.querySelectorAll('.modal-overlay.open').forEach(el => {
            if (el.id !== id && el.id !== 'lwUnlockModal') el.classList.remove('open');
        });
        document.getElementById(id).classList.add('open');
        document.body.style.overflow = 'hidden';
        // Hide the floating GoodMarket Agent launcher while a modal is open —
        // it outranks the modal overlay (z-index 9999 > 200) and covers the
        // GCash submit button on mobile.
        document.body.classList.add('gm-modal-open');
        if (id === 'settingsModal') {
            // Refresh FV status each time Settings opens so the user sees fresh data.
            loadFvStatus(true);
        }
        if (id === 'gcashModal') {
            _gcashLoadBalance();
            _gcashLoadHistory();
        }
    }
    function closeModal(id) {
        document.getElementById(id).classList.remove('open');
        document.body.style.overflow = '';
        if (!document.querySelector('.modal-overlay.open')) {
            document.body.classList.remove('gm-modal-open');
        }
    }
    document.querySelectorAll('.modal-overlay').forEach(el => {
        el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); });
    });

    // ── Face Verification status + expiry tracking ───────────
    // Reads live from the GoodDollar Identity contract via /api/fv-status.
    // Powers both the Settings modal card and the wallet-page warning banner.
    let _fvStatusState = null;

    function fmtDateLocal(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '—';
            return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } catch { return '—'; }
    }

    function fmtRemaining(seconds) {
        if (!seconds || seconds <= 0) return '0 days';
        const days = Math.floor(seconds / 86400);
        if (days >= 2) return days + ' days';
        const hours = Math.floor(seconds / 3600);
        if (hours >= 2) return hours + ' hours';
        const minutes = Math.max(1, Math.floor(seconds / 60));
        return minutes + ' minutes';
    }

    function handleFvReverifyClick() {
        closeModal('settingsModal');
        if (typeof window._triggerReVerify === 'function') {
            window._triggerReVerify();
        }
        // Scroll to the Claim area so the re-verify button is visible.
        const claimEl = document.getElementById('ubiEntitlementBox') || document.querySelector('.action-item');
        if (claimEl && claimEl.scrollIntoView) {
            claimEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function renderFvStatus(d) {
        _fvStatusState = d || {};
        const pill    = document.getElementById('fvStatusPill');
        const dot     = document.getElementById('fvStatusDot');
        const label   = document.getElementById('fvStatusLabel');
        const lastEl  = document.getElementById('fvStatusLastVerified');
        const expEl   = document.getElementById('fvStatusExpiresAt');
        const remEl   = document.getElementById('fvStatusRemaining');
        const cta     = document.getElementById('fvStatusCta');
        const ctaLbl  = document.getElementById('fvStatusCtaLabel');
        const banner  = document.getElementById('fvExpiryBanner');
        const bIcon   = document.getElementById('fvExpiryBannerIcon');
        const bText   = document.getElementById('fvExpiryBannerText');
        if (!pill || !dot || !label) return;

        // Defaults
        let state = 'unverified';  // unverified | verified | warning | expired | renewal | error
        let color = '#888';
        let bg = 'rgba(67,56,43,0.06)';
        let pillText = 'Unverified';
        let ctaText  = 'Verify Now';
        let showCta  = true;

        // Only trust the countdown when the contract actually exposed an auth period.
        // Some GoodDollar Identity deployments don't implement authenticationPeriod(),
        // in which case we just show the whitelist status without a countdown.
        const expiryKnown = !!(d && d.expiry_available);

        if (!d || d.success === false) {
            state = 'error';
            color = '#94a3b8';
            pillText = 'Unavailable';
            showCta = false;
        } else if (d.expired) {
            state = 'expired';
            color = '#ef4444';
            bg = 'rgba(239,68,68,0.12)';
            pillText = 'Expired';
            ctaText = 'Re-verify Now';
        } else if (d.verified && expiryKnown && d.days_remaining <= 14) {
            state = 'warning';
            color = '#f59e0b';
            bg = 'rgba(245,158,11,0.12)';
            pillText = 'Expires soon';
            ctaText = 'Re-verify Now';
        } else if (d.verified) {
            state = 'verified';
            color = '#10b981';
            bg = 'rgba(16,185,129,0.12)';
            pillText = 'Verified';
            showCta = false;
        } else if (d.ever_verified) {
            // Has a lastAuthenticated date but isWhitelisted=false AND the auth period
            // is not yet past. Most common cause: the wallet was unlinked from the user's
            // GoodDollar identity (e.g. via connect-another-wallet) — the date persists
            // but the whitelist entry is removed.
            state = 'renewal';
            color = '#f97316';
            bg = 'rgba(249,115,22,0.12)';
            pillText = 'Verification needs renewal';
            ctaText = 'Re-verify Now';
        }

        dot.style.background = color;
        label.textContent = pillText;
        pill.style.color = color;
        pill.style.background = bg;

        lastEl.textContent = d && d.date_authenticated_iso ? fmtDateLocal(d.date_authenticated_iso) : '—';
        expEl.textContent  = d && d.expires_at_iso         ? fmtDateLocal(d.expires_at_iso)         : '—';
        if (state === 'expired') {
            remEl.textContent = 'Expired';
            remEl.style.color = '#ef4444';
        } else if (state === 'renewal') {
            remEl.textContent = 'Verification needs renewal';
            remEl.style.color = '#f97316';
        } else if (d && d.seconds_remaining) {
            remEl.textContent = fmtRemaining(d.seconds_remaining);
            remEl.style.color = state === 'warning' ? '#d97706' : 'var(--text)';
        } else {
            remEl.textContent = '—';
            remEl.style.color = 'var(--text)';
        }

        if (showCta) {
            cta.style.display = '';
            ctaLbl.textContent = ctaText;
        } else {
            cta.style.display = 'none';
        }

        // Top-of-page banner: only show in 'warning', 'expired', or 'renewal' states.
        if (banner && bText && bIcon) {
            if (state === 'expired') {
                banner.style.display = '';
                banner.style.background = 'rgba(239,68,68,0.10)';
                banner.style.border = '1px solid rgba(239,68,68,0.35)';
                banner.style.color = '#b91c1c';
                bIcon.textContent = '⚠️';
                bText.innerHTML = '<strong>Face Verification expired</strong>' +
                    (d && d.expires_at_iso ? ' on ' + fmtDateLocal(d.expires_at_iso) : '') +
                    '. Re-verify to resume daily G$ claims.';
            } else if (state === 'renewal') {
                banner.style.display = '';
                banner.style.background = 'rgba(249,115,22,0.10)';
                banner.style.border = '1px solid rgba(249,115,22,0.35)';
                banner.style.color = '#c2410c';
                bIcon.textContent = '🔗';
                bText.innerHTML = '<strong>Wallet verification needs renewal.</strong> ' +
                    'This can happen during normal re-verification and does not necessarily mean you did anything wrong. ' +
                    'Your face identity may still be valid, but this wallet is not currently verified for claims. ' +
                    'Re-verify to continue using this wallet for daily G$ claims.';
            } else if (state === 'warning') {
                banner.style.display = '';
                banner.style.background = 'rgba(245,158,11,0.10)';
                banner.style.border = '1px solid rgba(245,158,11,0.35)';
                banner.style.color = '#fcd34d';
                bIcon.textContent = '⏳';
                bText.innerHTML = '<strong>Face Verification expires in ' + fmtRemaining(d.seconds_remaining) + '</strong>' +
                    (d.expires_at_iso ? ' (' + fmtDateLocal(d.expires_at_iso) + ')' : '') +
                    '. Re-verify soon to avoid a gap in your G$ claims.';
            } else {
                banner.style.display = 'none';
            }
        }
    }

    function loadFvStatus(force) {
        const url = '/api/fv-status' + (force ? '?force=1' : '');
        fetch(url, { credentials: 'same-origin' })
            .then(r => r.json())
            .then(renderFvStatus)
            .catch(() => renderFvStatus({ success: false }));
    }

    // Kick off once on page load so the banner can appear without opening Settings.
    loadFvStatus(false);

    // ── Copy address ─────────────────────────────────────────
    function copyAddress() {
        navigator.clipboard.writeText(WALLET).then(() => {
            const btn = document.querySelector('.copy-btn');
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = '⧉'; }, 1800);
        }).catch(() => {});
    }
    function copyAddressFromModal() {
        navigator.clipboard.writeText(WALLET).then(() => {
            showAlert('receiveAlert', 'alert-success', '✅ Address copied to clipboard!');
        }).catch(() => {
            showAlert('receiveAlert', 'alert-info', WALLET);
        });
    }

    // ── Tab switching ────────────────────────────────────────
    function switchTab(tab) {
        document.getElementById('cryptoPanel').style.display = tab === 'crypto' ? '' : 'none';
        document.getElementById('activityPanel').style.display = tab === 'activity' ? '' : 'none';
        document.getElementById('tabCrypto').classList.toggle('active', tab === 'crypto');
        document.getElementById('tabActivity').classList.toggle('active', tab === 'activity');
        if (tab === 'activity') loadHistory();
    }

    // ── Load Balances ────────────────────────────────────────
    // Cache the last successful /api/wallet/balances response in localStorage
    // so the next page load can render numbers instantly while the fresh fetch
    // is still in flight (stale-while-revalidate). The server still has its
    // own 2-minute cache; this is purely a perceived-latency optimization.
    const WALLET_BALANCE_CACHE_KEY = 'walletBalances:' + WALLET.toLowerCase();
    const WALLET_BALANCE_CACHE_TTL_MS = 10 * 60 * 1000;

    function _applyBalancesData(data) {
        if (data.gd && data.gd.success) {
            gdBal = data.gd.balance || 0;
            gdUsdPrice = Number(data.gd.gd_usd_price) || 0;
            document.getElementById('gdBal').textContent = fmt(gdBal, 4) + ' G$';
            document.getElementById('gdBalUSD').textContent = data.gd.usd_formatted || 'GoodDollar';
        } else {
            document.getElementById('gdBal').textContent = '0 G$';
            document.getElementById('gdBalUSD').textContent = 'GoodDollar';
            gdUsdPrice = 0;
        }

        if (data.celo && data.celo.success) {
            celoBal = data.celo.balance || 0;
            celoUsdValue = Number(data.celo.usd_value) || 0;
            document.getElementById('celoBal').textContent = fmt(celoBal, 4) + ' CELO';
        } else {
            document.getElementById('celoBal').textContent = '0 CELO';
            celoUsdValue = 0;
        }

        if (data.cusd && data.cusd.success) {
            cusdBal = data.cusd.balance || 0;
            cusdUsdValue = Number(data.cusd.usd_value) || 0;
            document.getElementById('cusdBal').textContent = fmt(cusdBal, 4) + ' cUSD';
            document.getElementById('cusdBalUSD').textContent = '$' + fmt(cusdUsdValue, 2);
        } else {
            document.getElementById('cusdBal').textContent = '0 cUSD';
            cusdUsdValue = 0;
        }

        if (data.usdt && data.usdt.success) {
            usdtBal = data.usdt.balance || 0;
            usdtUsdValue = Number(data.usdt.usd_value) || 0;
            document.getElementById('usdtBal').textContent = fmt(usdtBal, 4) + ' USDT';
            document.getElementById('usdtBalUSD').textContent = '$' + fmt(usdtUsdValue, 2);
        } else {
            document.getElementById('usdtBal').textContent = '0 USDT';
            usdtUsdValue = 0;
        }

        // USDC is not displayed as a main wallet tile yet, but MiniPay can use
        // it as a CIP-64 gas fee currency. Keep it in memory so send/claim
        // attempts prioritize the stablecoin balances the user actually has.
        usdcBal = (data.usdc && data.usdc.success) ? (data.usdc.balance || 0) : 0;
        usdcUsdValue = (data.usdc && data.usdc.success) ? (Number(data.usdc.usd_value) || 0) : 0;

        updateTotalBalanceInGd();
    }

    function _renderBalancesFromCache() {
        try {
            const raw = localStorage.getItem(WALLET_BALANCE_CACHE_KEY);
            if (!raw) return false;
            const cached = JSON.parse(raw);
            if (!cached || !cached.expires_at || cached.expires_at < Date.now()) {
                try { localStorage.removeItem(WALLET_BALANCE_CACHE_KEY); } catch (_) {}
                return false;
            }
            if (cached.data) {
                _applyBalancesData(cached.data);
                return true;
            }
        } catch (_) { /* corrupted cache or localStorage unavailable */ }
        return false;
    }

    function _saveBalancesToCache(data) {
        try {
            localStorage.setItem(WALLET_BALANCE_CACHE_KEY, JSON.stringify({
                expires_at: Date.now() + WALLET_BALANCE_CACHE_TTL_MS,
                data: data,
            }));
        } catch (_) { /* quota exceeded or localStorage disabled */ }
    }

    async function loadBalances(force = false) {
        // Stale-while-revalidate: render last-known balances immediately so the
        // user sees numbers without waiting for the network round-trip. After a
        // known balance-changing tx, skip browser cache and ask the backend to
        // bypass its short-lived on-chain cache too.
        if (force) {
            try { localStorage.removeItem(WALLET_BALANCE_CACHE_KEY); } catch (_) {}
        } else {
            _renderBalancesFromCache();
        }

        try {
            const res = await fetch('/api/wallet/balances' + (force ? '?force=1' : ''));
            if (!res.ok) return;
            const data = await res.json();
            if (!data.success) return;
            _applyBalancesData(data);
            _saveBalancesToCache(data);
        } catch (e) {
            document.getElementById('gdBal').textContent = 'Error';
        }

        // Also fetch non-Celo balances in parallel (non-blocking)
        loadXdcBalances();
    }

    async function loadXdcBalances() {
        try {
            const [xdcRes, gdRes] = await Promise.all([
                fetch('/api/xdc/balances'),
                fetch('/api/xdc/gd-info'),
            ]);
            const xdcData = await xdcRes.json();
            const gdData  = await gdRes.json();

            if (xdcData.success && xdcData.xdc && xdcData.xdc.success) {
                xdcBal = xdcData.xdc.balance || 0;
                document.getElementById('xdcBal').textContent = fmt(xdcBal, 4) + ' XDC';
                document.getElementById('xdcBalSub').textContent = 'For gas fees';
            } else {
                document.getElementById('xdcBal').textContent = '0 XDC';
            }

            if (gdData.success && gdData.gd_balance && gdData.gd_balance.success) {
                xdcGdBal = gdData.gd_balance.balance || 0;
                document.getElementById('xdcGdBal').textContent = fmt(xdcGdBal, 4) + ' G$';
                document.getElementById('xdcGdBalSub').textContent = 'GoodDollar on XDC';
            } else {
                document.getElementById('xdcGdBal').textContent = '0 G$';
                document.getElementById('xdcGdBalSub').textContent = 'GoodDollar on XDC';
            }
            updateTotalBalanceInGd();
        } catch (e) {
            document.getElementById('xdcBal').textContent = '—';
            document.getElementById('xdcGdBal').textContent = '—';
        }
    }

    // ── Load History ─────────────────────────────────────────
    async function loadHistory(force = false) {
        const list = document.getElementById('txList');
        list.innerHTML = '<li class="empty-state"><span class="spinner"></span> Loading transactions...</li>';
        // The backend scans 14 days of Celo + XDC logs — normally ~10-30 s.
        // If it ever stalls (RPC outage / slow cold scan), don't spin forever.
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90000);
        try {
            const url = '/api/wallet/transaction-history?limit=100' + (force ? '&force=1' : '');
            const res  = await fetch(url, { signal: ctrl.signal });
            const data = await res.json();
            if (!data.success || !data.transactions || !data.transactions.length) {
                list.innerHTML = '<li class="empty-state">No Celo or XDC transactions found in the last 14 days.</li>';
                return;
            }
            list.innerHTML = '';

            // Config per transaction type
            const TYPE_CFG = {
                claim:            { icon: '🪙', amtClass: 'claim',            badge: 'CLAIM'    },
                swap:             { icon: '🔄', amtClass: 'swap',             badge: 'SWAP'     },
                savings_deposit:  { icon: '🏦', amtClass: 'savings_deposit',  badge: 'SAVINGS'  },
                savings_withdraw: { icon: '🏦', amtClass: 'savings_withdraw', badge: 'WITHDRAW' },
                transfer_sent:    { icon: '↑',  amtClass: 'sent',             badge: null       },
                transfer_received:{ icon: '↓',  amtClass: 'received',         badge: null       },
            };

            data.transactions.forEach(tx => {
                const type = tx.tx_type || 'transfer_received';
                const cfg  = TYPE_CFG[type] || TYPE_CFG.transfer_received;

                // Sign: show + for inflows, − for outflows
                const isInflow = (type === 'claim' || type === 'savings_withdraw' ||
                                  type === 'transfer_received' ||
                                  (type === 'swap' && tx.direction === 'received'));
                const sign = isInflow ? '+' : '−';
                const amtClass = type === 'swap'
                    ? (isInflow ? 'received' : 'sent')
                    : cfg.amtClass;

                // Counterpart address display
                const isSent = (tx.direction === 'sent');
                const counterpart = isSent ? tx.to : tx.from;
                const shortAddr = counterpart
                    ? counterpart.slice(0, 8) + '…' + counterpart.slice(-6)
                    : '—';

                const typeBadge = cfg.badge
                    ? `<span class="tx-badge ${type}">${cfg.badge}</span>`
                    : '';
                const network = String(tx.network || 'celo').toLowerCase();
                const networkBadge = network === 'xdc'
                    ? `<span class="tx-badge xdc-net">XDC</span>`
                    : `<span class="tx-badge celo-net">CELO</span>`;

                // XDC API returns a Unix timestamp string; convert it to readable
                let timeDisplay = tx.timestamp || '';
                if (network === 'xdc' && /^\d+$/.test(String(timeDisplay))) {
                    const d = new Date(parseInt(timeDisplay) * 1000);
                    const diff = Math.floor((Date.now() - d) / 1000);
                    if (diff < 60) timeDisplay = diff + 's ago';
                    else if (diff < 3600) timeDisplay = Math.floor(diff/60) + 'm ago';
                    else if (diff < 86400) timeDisplay = Math.floor(diff/3600) + 'h ago';
                    else timeDisplay = Math.floor(diff/86400) + 'd ago';
                } else if (!timeDisplay && tx.block) {
                    timeDisplay = 'Block #' + tx.block;
                }

                const li = document.createElement('li');
                li.className = 'tx-item';
                li.innerHTML = `
                    <div class="tx-icon-circle ${type}">${cfg.icon}</div>
                    <div class="tx-meta">
                        <div class="tx-dir">${tx.label}${typeBadge}${networkBadge}</div>
                        <div class="tx-addr">${isSent ? 'To: ' : 'From: '}${shortAddr}</div>
                        <div class="tx-time">${timeDisplay}</div>
                    </div>
                    <div class="tx-right">
                        <div class="tx-amount ${amtClass}">${sign}${tx.amount_formatted}</div>
                        ${tx.tx_hash ? `<a class="tx-hash-link" href="${tx.explorer_url}" target="_blank" rel="noopener">View ↗</a>` : ''}
                    </div>
                `;
                list.appendChild(li);
            });
        } catch (e) {
            if (e && e.name === 'AbortError') {
                list.innerHTML = '<li class="empty-state">Taking longer than usual — pull the tab again to retry.</li>';
            } else {
                list.innerHTML = '<li class="empty-state">Failed to load transactions.</li>';
            }
        } finally {
            clearTimeout(timer);
        }
    }

    // ── Send ─────────────────────────────────────────────────
    function getSelectedTokenMeta(token = selectedToken) {
        const map = {
            GD:      { label: 'G$',      network: 'celo', chainId: 42220, explorer: 'https://explorer.celo.org/mainnet/tx/' },
            CUSD:    { label: 'cUSD',    network: 'celo', chainId: 42220, explorer: 'https://explorer.celo.org/mainnet/tx/' },
            USDT:    { label: 'USDT',    network: 'celo', chainId: 42220, explorer: 'https://explorer.celo.org/mainnet/tx/' },
            CELO:    { label: 'CELO',    network: 'celo', chainId: 42220, explorer: 'https://explorer.celo.org/mainnet/tx/' },
            XDC_GD:  { label: 'XDC G$',  network: 'xdc',  chainId: 50,    explorer: 'https://xdcscan.io/tx/' },
            XDC:     { label: 'XDC',     network: 'xdc',  chainId: 50,    explorer: 'https://xdcscan.io/tx/' },
        };
        return map[token] || map.GD;
    }

    function selectToken(token, btn) {
        selectedToken = token;
        document.querySelectorAll('.token-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const meta = getSelectedTokenMeta(token);
        const networkNote = document.getElementById('networkSendNote');
        document.getElementById('sendTokenLabel').textContent = meta.label;
        document.getElementById('sendBtn').textContent = `Send ${meta.label}`;
        if (meta.network === 'xdc') {
            networkNote.style.display = '';
            networkNote.innerHTML = '🔷 Sending on XDC Network — use a <strong>0x</strong> or <strong>xdc</strong> address';
            document.getElementById('sendTo').placeholder = '0x... or xdc...';
        } else if (meta.network === 'fuse') {
            networkNote.style.display = '';
            networkNote.innerHTML = '🟡 Sending on Fuse Network — use a <strong>0x</strong> address';
            document.getElementById('sendTo').placeholder = '0x...';
        } else {
            networkNote.style.display = 'none';
            document.getElementById('sendTo').placeholder = '0x...';
        }
    }

    function setMaxSend() {
        const vals = {
            GD: gdBal, CUSD: cusdBal, USDT: usdtBal,
            CELO: Math.max(0, celoBal - 0.001),
            XDC: Math.max(0, xdcBal - 0.01),
            XDC_GD: xdcGdBal,
            FUSE: Math.max(0, fuseBal - 0.001),
            FUSE_GD: fuseGdBal,
        };
        const v = vals[selectedToken] || 0;
        document.getElementById('sendAmount').value = v > 0 ? v.toFixed(6) : '';
    }

    function showAlert(id, cls, html) {
        const el = document.getElementById(id);
        el.className = `alert ${cls} show`;
        el.innerHTML = html;
    }
    let _navFeedbackLock = false;
    function showNavFeedback(message = 'Processing, please wait…') {
        const overlay = document.getElementById('navFeedbackOverlay');
        const text = document.getElementById('navFeedbackText');
        if (text) text.textContent = message;
        if (overlay) overlay.classList.add('show');
        _navFeedbackLock = true;
        setTimeout(() => {
            _navFeedbackLock = false;
        }, 10000);
    }

    function navigateWithFeedback(url, message = 'Opening page…') {
        if (_navFeedbackLock) return false;
        showNavFeedback(message);
        window.location.href = url;
        return false;
    }

    function handleDashboardFromWallet(event) {
        if (window._walletNeedsFV) {
            if (event) event.preventDefault();
            const msg = document.getElementById('walletDashboardFVMsg');
            if (msg) {
                msg.style.display = 'block';
                msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            return false;
        }
        return navigateWithFeedback('/dashboard', 'Opening More Ways to Earn…');
    }
    function clearAlert(id) {
        const el = document.getElementById(id);
        el.className = 'alert';
        el.innerHTML = '';
    }

    async function doSend() {
        clearAlert('sendAlert');
        // Local wallets: prompt for PIN if the wallet has auto-locked.
        if ((LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined' && !GMLocalWallet.isUnlocked()) {
            await _lwUnlockIfNeeded().catch(function (e) {
                if (e.message !== 'Unlock cancelled.') clearAlert('sendAlert');
                return Promise.reject(e);
            });
        }
        const toAddrRaw = document.getElementById('sendTo').value.trim();
        const amount = document.getElementById('sendAmount').value.trim().replace(/,/g, '');
        const btn = document.getElementById('sendBtn');
        const meta = getSelectedTokenMeta();
        const isXdcToken = meta.network === 'xdc';
        const isFuseToken = meta.network === 'fuse';
        const isLocalLogin = (LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined';
        // The in-app wallet signs Celo transactions only — stop before an
        // injected MetaMask (a different account) gets prompted for XDC/FUSE.
        if (isLocalLogin && (isXdcToken || isFuseToken)) {
            showAlert('sendAlert', 'alert-error', '❌ Your in-app GoodMarket wallet can sign Celo transactions only. Sending ' + (meta.label || 'this token') + ' on ' + (isXdcToken ? 'XDC' : 'Fuse') + ' needs MetaMask or WalletConnect — log in with that wallet to use it.');
            return;
        }

        // Accept both 0x... and xdc... addresses; convert xdc prefix to 0x for validation
        let toAddr = toAddrRaw;
        if (toAddrRaw.toLowerCase().startsWith('xdc') && toAddrRaw.length === 43) {
            toAddr = '0x' + toAddrRaw.slice(3);
        }

        if (!toAddr || !toAddr.startsWith('0x') || toAddr.length !== 42) {
            const hint = isXdcToken ? '(0x... or xdc...)' : '(0x...)';
            showAlert('sendAlert', 'alert-error', `❌ Enter a valid address ${hint}`);
            return;
        }
        if (!amount || parseFloat(amount) <= 0) {
            showAlert('sendAlert', 'alert-error', '❌ Enter a valid amount');
            return;
        }
        if (toAddr.toLowerCase() === WALLET.toLowerCase()) {
            showAlert('sendAlert', 'alert-error', '❌ Cannot send to your own address');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Sending…';

        try {
            const prepEndpoint = isXdcToken
                ? '/api/xdc/prepare-send'
                : (isFuseToken ? '/api/fuse/prepare-send' : '/api/wallet/prepare-send');
            const prepRes = await fetch(prepEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: selectedToken, to: toAddr, amount })
            });
            const txData = await prepRes.json();
            if (!txData.success) {
                showAlert('sendAlert', 'alert-error', '❌ ' + (txData.error || 'Failed to prepare transaction'));
                return;
            }

            let txHash = null;
            if (!window.useServerSigning) {
                // Local self-custodial accounts sign with the in-app browser
                // wallet (unlocked via PIN above) — never with an injected
                // MetaMask/extension, which is a different account entirely.
                let provider = null;
                if (isLocalLogin) {
                    provider = GMLocalWallet.getProvider();
                } else {
                    provider = await _vAwaitEthProvider();
                    if (!provider) {
                        provider = await _walletGetWcProviderIfPreferred();
                    }
                }
                if (!provider) {
                    throw new Error('No wallet detected. Please connect your GoodMarket wallet via MetaMask, Trust Wallet, MiniPay, or use WalletConnect to sign transactions.');
                }

                const accounts = await provider.request({ method: 'eth_requestAccounts' });
                if (!accounts || !accounts.length) throw new Error('No wallet account available.');
                const from = accounts[0];
                if (from.toLowerCase() !== WALLET.toLowerCase()) {
                    throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
                }

                const targetChainId = Number(txData.chain_id || meta.chainId);
                const isCeloTx = targetChainId === 42220;
                // The in-app wallet pays gas in CELO — CIP-64 feeCurrency params
                // would break its plain eth_sendTransaction path.
                const miniPay = !isLocalLogin && (_isMiniPayProvider(provider) || _isMiniPay()) && isCeloTx;

                // MiniPay is always on Celo — skip wallet_switchEthereumChain
                // which MiniPay may not support.
                if (!miniPay) {
                    const targetChainHex = '0x' + targetChainId.toString(16);
                    const currentChain = await provider.request({ method: 'eth_chainId' });
                    if (_normalizeChainIdHex(currentChain) !== targetChainHex.toLowerCase()) {
                        try {
                            await provider.request({
                                method: 'wallet_switchEthereumChain',
                                params: [{ chainId: targetChainHex }]
                            });
                        } catch (switchErr) {
                            if (isCeloTx) {
                                await provider.request({
                                    method: 'wallet_addEthereumChain',
                                    params: [{
                                        chainId: '0xa4ec',
                                        chainName: 'Celo Mainnet',
                                        nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
                                        rpcUrls: ['https://forno.celo.org'],
                                        blockExplorerUrls: ['https://celoscan.io']
                                    }]
                                });
                            } else if (isFuseToken) {
                                await provider.request({
                                    method: 'wallet_addEthereumChain',
                                    params: [{
                                        chainId: '0x7a',
                                        chainName: 'Fuse Mainnet',
                                        nativeCurrency: { name: 'FUSE', symbol: 'FUSE', decimals: 18 },
                                        rpcUrls: ['https://rpc.fuse.io'],
                                        blockExplorerUrls: ['https://explorer.fuse.io']
                                    }]
                                });
                            } else {
                                throw new Error('Please switch your wallet network before sending.');
                            }
                        }
                    }
                }

                const txParams = {
                    from,
                    to: txData.to,
                    data: txData.data || '0x',
                    value: txData.value || '0x0'
                };
                if (txData.gas) txParams.gas = txData.gas;
                if (txData.gasPrice) txParams.gasPrice = txData.gasPrice;

                // MiniPay CIP-64: add feeCurrency and estimate gas if needed.
                if (miniPay) {
                    if (!txParams.gas) {
                        try {
                            const est = await provider.request({
                                method: 'eth_estimateGas',
                                params: [{ from, to: txParams.to, data: txParams.data, value: txParams.value }],
                            });
                            const estimated = typeof est === 'string' ? BigInt(est) : BigInt(Number(est));
                            txParams.gas = '0x' + (estimated * 140n / 100n).toString(16);
                        } catch (_) {
                            txParams.gas = '0x7A120';
                        }
                    }

                    // MiniPay sends must use stablecoin fee currencies (CIP-64).
                    // Read live cUSD/USDT/USDC balances from the injected provider
                    // so USDT-only users are prioritized correctly, and avoid the
                    // native CELO fallback that causes "insufficient CELO for gas"
                    // errors inside MiniPay.
                    const backendFeeHints = (txData && txData.minipay_fee_currencies) || {};
                    const feeCurrencies = await _miniPayStableFeeCurrenciesForSend(provider, from, backendFeeHints);
                    let lastErr;
                    for (const fc of feeCurrencies) {
                        const params = { ...txParams };
                        params.feeCurrency = fc;
                        try {
                            txHash = await provider.request({
                                method: 'eth_sendTransaction',
                                params: [params],
                            });
                            await _miniPayWaitForReceipt(provider, txHash);
                            break;
                        } catch (err) {
                            lastErr = err;
                            const code = err && err.code;
                            const msg = ((err && (err.message || err.data && err.data.message)) || '').toLowerCase();
                            if (code === 4001 || /reject|denied by user|user denied/i.test(msg)) throw err;
                            // Keep trying the next feeCurrency candidate on execution/balance reverts.
                            if (/revert/i.test(msg) && !/insufficient|funds|balance|fee/i.test(msg)) throw err;
                            console.warn('[MiniPay] send tx attempt failed with feeCurrency=' + fc + ':', msg || err);
                        }
                    }
                    if (!txHash) {
                        const msg = ((lastErr && (lastErr.message || lastErr.data && lastErr.data.message)) || '').toLowerCase();
                        if (/permission denied/.test(msg)) {
                            throw new Error('MiniPay denied the transaction. Please ensure you have enough cUSD/USDT/USDC for gas and try again.');
                        }
                        if (/insufficient.*celo|celo.*gas|insufficient.*gas/.test(msg)) {
                            throw new Error('MiniPay needs stablecoin gas fees. Please keep at least ~0.015 cUSD, USDT, or USDC and try again.');
                        }
                        throw lastErr || new Error('MiniPay transaction failed. Please ensure you have enough cUSD/USDT/USDC for gas and try again.');
                    }
                } else {
                    txHash = await provider.request({
                        method: 'eth_sendTransaction',
                        params: [txParams]
                    });
                }
            } else {
                throw new Error('Server signing is disabled. Please use your injected wallet / WalletConnect.');
            }

            const explorerUrl = `${meta.explorer}${txHash}`;
            showAlert('sendAlert', 'alert-success',
                `✅ Transaction sent! <a style="color:var(--blue);" href="${explorerUrl}" target="_blank" rel="noopener">View ↗</a>`);
            window.dispatchEvent(new CustomEvent('goodmarket:ai-tx-success', {
                detail: {
                    txHash,
                    explorerUrl,
                    message: `✅ Send successful. Tx hash: ${txHash.slice(0, 10)}…${txHash.slice(-6)}`
                }
            }));
            document.getElementById('sendTo').value = '';
            document.getElementById('sendAmount').value = '';
            setTimeout(() => {
                if (isXdcToken) loadXdcBalances();
                else loadBalances(true);
            }, 3000);

        } catch (err) {
            const msg = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err.message || 'Transaction failed');
            showAlert('sendAlert', 'alert-error', '❌ ' + msg);
            window.dispatchEvent(new CustomEvent('goodmarket:ai-tx-failed', {
                detail: {
                    error: msg,
                    message: `❌ Send failed: ${msg}`
                }
            }));
        } finally {
            btn.disabled = false;
            btn.textContent = `Send ${getSelectedTokenMeta().label}`;
        }
    }

    // ── GCash Cashout ────────────────────────────────────────────────────
    // User sends G$ to GCASH_ADDRESS on-chain, then submits a request.
    // Admin reviews in dashboard; auto-refund after 24h if unreviewed.

    let _gcashConfig = null;

    async function _gcashFetchConfig() {
        if (_gcashConfig) return _gcashConfig;
        try {
            const res = await fetch('/api/gcash/config');
            const data = await res.json();
            if (data.success) _gcashConfig = data;
        } catch (_) {}
        return _gcashConfig;
    }

    async function _gcashLoadBalance() {
        const el = document.getElementById('gcashBalance');
        try {
            const res = await fetch('/api/gooddollar-balance');
            const data = await res.json();
            if (data.success && data.balance != null) {
                el.textContent = Math.floor(data.balance).toLocaleString();
            }
        } catch (_) { el.textContent = '—'; }
    }

    // Same poll-until-mined pattern as minipay-gas-topup.js _waitForReceipt.
    async function _gcashWaitForReceipt(provider, txHash, attempts) {
        for (let i = 0; i < attempts; i++) {
            try {
                const r = await provider.request({
                    method: 'eth_getTransactionReceipt',
                    params: [txHash]
                });
                if (r) return r;
            } catch (_) { /* retry */ }
            await new Promise(res => setTimeout(res, 2500));
        }
        return null;
    }

    function _gcashUpdatePhp() {
        const raw = document.getElementById('gcashAmount').value.trim().replace(/,/g, '');
        const preview = document.getElementById('gcashPhpPreview');
        const amt = parseFloat(raw);
        if (!raw || isNaN(amt) || amt <= 0) { preview.textContent = ''; return; }
        const php = (amt / 100).toFixed(2);
        preview.textContent = '≈ ₱' + Number(php).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }

    async function _gcashLoadHistory() {
        const section = document.getElementById('gcashHistorySection');
        const list = document.getElementById('gcashHistoryList');
        try {
            const res = await fetch('/api/gcash/my-requests');
            const data = await res.json();
            if (!data.success || !data.requests || !data.requests.length) {
                section.style.display = 'none';
                return;
            }
            section.style.display = 'block';
            list.innerHTML = data.requests.map(function(r) {
                const statusColors = {
                    pending: '#f59e0b', refunding: '#f59e0b',
                    approved: '#10b981', rejected: '#ef4444',
                    refunded: '#06b6d4', refund_failed: '#ef4444'
                };
                const color = statusColors[r.status] || '#888';
                const date = new Date(r.created_at).toLocaleDateString('en-PH', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
                const gd = Number(r.amount_gd).toLocaleString();
                const php = Number(r.amount_php).toLocaleString(undefined, {minimumFractionDigits:2});
                let statusHtml = '<span style="color:' + color + ';font-weight:600;font-size:0.72rem;text-transform:uppercase">' + r.status + '</span>';
                let detailHtml = '';
                if (r.status === 'approved') {
                    statusHtml = '<span style="color:#10b981;font-weight:600;font-size:0.72rem;">✅ SUCCESSFUL</span>';
                    detailHtml = '<div style="font-size:0.72rem;color:#10b981;margin-top:0.15rem;">GCash sent!'
                        + (r.reference_number ? ' Ref #: <strong>' + r.reference_number + '</strong>' : '')
                        + (r.receipt_image_url ? ' · <a href="' + r.receipt_image_url + '" target="_blank" rel="noopener" style="color:#38bdf8;">View receipt ↗</a>' : '')
                        + '</div>';
                } else if (r.status === 'rejected' || r.status === 'refunded') {
                    detailHtml = '<div style="font-size:0.72rem;color:var(--text-dim);margin-top:0.15rem;">G$ refunded to your wallet'
                        + (r.refund_tx_hash ? ' · <a href="https://celoscan.io/tx/' + r.refund_tx_hash + '" target="_blank" rel="noopener" style="color:#38bdf8;">Refund tx ↗</a>' : '')
                        + '</div>';
                } else if (r.status === 'refund_failed' || r.status === 'refunding') {
                    detailHtml = '<div style="font-size:0.72rem;color:#f59e0b;margin-top:0.15rem;">'
                        + (r.status === 'refunding' ? 'Refund in progress…' : 'Refund is being retried automatically')
                        + (r.refund_tx_hash ? ' · <a href="https://celoscan.io/tx/' + r.refund_tx_hash + '" target="_blank" rel="noopener" style="color:#38bdf8;">Refund tx ↗</a>' : '')
                        + '</div>';
                }
                return '<div style="padding:0.5rem 0.6rem;border-bottom:1px solid rgba(67,56,43,0.08);font-size:0.8rem;">'
                    + '<div style="display:flex;justify-content:space-between;align-items:center;">'
                    + '<div><div style="font-weight:600">' + gd + ' G$ → ₱' + php + '</div>'
                    + '<div style="color:var(--text-dim);font-size:0.72rem">' + date + ' · ' + r.gcash_number + '</div></div>'
                    + statusHtml
                    + '</div>'
                    + detailHtml
                    + '</div>';
            }).join('');
        } catch (_) { section.style.display = 'none'; }
    }

    async function submitGcashCashout() {
        clearAlert('gcashAlert');
        const btn = document.getElementById('gcashSubmitBtn');

        // Local wallets: prompt for PIN if locked. A cancelled unlock aborts
        // quietly — the modal already surfaces its own errors — but anything
        // else (e.g. the helper failing to run) must be shown, not swallowed,
        // or the button looks dead.
        const isLocalLogin = (LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined';
        if (isLocalLogin && !GMLocalWallet.isUnlocked()) {
            try {
                await _lwUnlockIfNeeded();
            } catch (e) {
                if (e && e.message && e.message !== 'Unlock cancelled.') {
                    showAlert('gcashAlert', 'alert-error', '❌ ' + e.message);
                }
                return;
            }
        }

        // Read + validate form
        const amountRaw = document.getElementById('gcashAmount').value.trim().replace(/,/g, '');
        const gcashNumber = document.getElementById('gcashNumber').value.trim();
        const gcashName = document.getElementById('gcashName').value.trim();
        const amount = parseFloat(amountRaw);

        if (!amountRaw || isNaN(amount) || amount < 5000) {
            showAlert('gcashAlert', 'alert-error', '⚠️ Minimum cashout is 5,000 G$ (₱50.00).');
            return;
        }
        if (!/^09\d{9}$/.test(gcashNumber)) {
            showAlert('gcashAlert', 'alert-error', '⚠️ GCash number must be exactly 11 digits starting with 09 (e.g. 09651234567).');
            return;
        }
        if (!gcashName || gcashName.length < 2) {
            showAlert('gcashAlert', 'alert-error', '⚠️ Enter the full name registered on your GCash account.');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Preparing…';

        try {
            // Fetch config to get GCASH_ADDRESS
            const config = await _gcashFetchConfig();
            if (!config || !config.enabled || !config.gcash_address) {
                showAlert('gcashAlert', 'alert-error', '❌ GCash cashout is not available right now. Please try again later.');
                return;
            }

            // Prepare the G$ transfer via existing prepare-send endpoint
            const prepRes = await fetch('/api/wallet/prepare-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: 'GD', to: config.gcash_address, amount: amountRaw })
            });
            const txData = await prepRes.json();
            if (!txData.success) {
                showAlert('gcashAlert', 'alert-error', '❌ ' + (txData.error || 'Failed to prepare transaction'));
                return;
            }

            // Sign and send the G$ transfer
            let provider = null;
            if (isLocalLogin) {
                provider = GMLocalWallet.getProvider();
            } else {
                provider = await _vAwaitEthProvider();
                if (!provider) provider = await _walletGetWcProviderIfPreferred();
            }
            if (!provider) throw new Error('No wallet detected. Please connect your wallet.');

            const accounts = await provider.request({ method: 'eth_requestAccounts' });
            if (!accounts || !accounts.length) throw new Error('No wallet account available.');
            const from = accounts[0];
            if (from.toLowerCase() !== WALLET.toLowerCase()) {
                throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
            }

            btn.innerHTML = '<span class="spinner"></span> Confirm in wallet…';
            showAlert('gcashAlert', 'alert-info', '<span class="spinner"></span> Sending ' + amount.toLocaleString() + ' G$ to GCash cashout address…');

            const txParams = {
                from: from,
                to: txData.to,
                data: txData.data || '0x',
                value: txData.value || '0x0'
            };
            if (txData.gas) txParams.gas = txData.gas;
            if (txData.gasPrice) txParams.gasPrice = txData.gasPrice;

            const txHash = await provider.request({
                method: 'eth_sendTransaction',
                params: [txParams]
            });

            // The backend verifies the transfer on-chain — a freshly-broadcast
            // tx isn't mined yet, so wait for the receipt here first or the
            // request fails with "transaction not found" even though the G$
            // was already sent.
            btn.innerHTML = '<span class="spinner"></span> Confirming on-chain…';
            showAlert('gcashAlert', 'alert-info', '<span class="spinner"></span> Transaction sent! Waiting for on-chain confirmation…');

            const receipt = await _gcashWaitForReceipt(provider, txHash, 36); // ~90s
            if (!receipt) {
                showAlert('gcashAlert', 'alert-error',
                    '⏳ Your G$ was sent (<a href="https://celoscan.io/tx/' + txHash + '" target="_blank" style="color:#007DFE">view tx</a>) '
                    + 'but confirmation is taking too long. <strong>Do not submit again yet</strong> — '
                    + 'wait a few minutes, then contact support with your tx hash so we can complete your cashout request.');
                return;
            }
            if (receipt.status === '0x0' || receipt.status === 0) {
                showAlert('gcashAlert', 'alert-error', '❌ The transfer failed on-chain. No cashout was recorded. Please try again.');
                return;
            }

            btn.innerHTML = '<span class="spinner"></span> Submitting request…';
            showAlert('gcashAlert', 'alert-info', '<span class="spinner"></span> Transaction confirmed! Submitting cashout request…');

            // Submit to backend
            const submitRes = await fetch('/api/gcash/cashout-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount_gd: amountRaw,
                    gcash_number: gcashNumber,
                    gcash_name: gcashName,
                    tx_hash: txHash
                })
            });
            const submitData = await submitRes.json();

            if (!submitData.success) {
                showAlert('gcashAlert', 'alert-error', '❌ ' + (submitData.error || 'Failed to submit request'));
                return;
            }

            showAlert('gcashAlert', 'alert-success',
                '✅ Cashout request #' + submitData.request_id + ' submitted!<br>'
                + '<strong>' + amount.toLocaleString() + ' G$ → ₱' + Number(submitData.amount_php).toLocaleString(undefined,{minimumFractionDigits:2}) + '</strong><br>'
                + '<small>Processing time: 1–24 hours. You will be notified once reviewed.</small>'
            );

            // Clear form + refresh history
            document.getElementById('gcashAmount').value = '';
            document.getElementById('gcashNumber').value = '';
            document.getElementById('gcashName').value = '';
            document.getElementById('gcashPhpPreview').textContent = '';
            _gcashLoadHistory();
            setTimeout(() => loadBalances(true), 3000);

            window.dispatchEvent(new CustomEvent('goodmarket:ai-tx-success', {
                detail: {
                    txHash,
                    explorerUrl: 'https://celoscan.io/tx/' + txHash,
                    message: '✅ GCash cashout request submitted. ' + amount.toLocaleString() + ' G$ sent.'
                }
            }));

        } catch (err) {
            const msg = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err.message || 'Transaction failed');
            showAlert('gcashAlert', 'alert-error', '❌ ' + msg);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Submit Cashout Request';
        }
    }

    window.GoodMarketAI = window.GoodMarketAI || {};
    window.GoodMarketAI.handleConfirmedAction = async function(action) {
        if (!action) return false;
        const payload = action.payload || {};

        if (action.action_type === 'mobile_load') {
            return false;
        }

        if (action.action_type === 'stream_gd') {
            const recipient = payload.recipient || '';
            const amount = payload.flow_rate_per_day || payload.amount || '';
            if (typeof openModal === 'function') openModal('streamModal');
            setTimeout(async function() {
                const receiverInput = document.getElementById('streamReceiver');
                const amountInput = document.getElementById('streamAmount');
                const periodSelect = document.getElementById('streamPeriod');
                const result = document.getElementById('streamResult');
                if (receiverInput) {
                    receiverInput.value = recipient;
                    receiverInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                // The AI flow rate is always per DAY — the modal defaults to
                // "/ month", which would silently create a 30x smaller stream.
                if (periodSelect) {
                    periodSelect.value = 'day';
                    periodSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (amountInput) {
                    amountInput.value = amount;
                    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (result) {
                    result.innerHTML = '<div style="color:#16a34a;">✅ GoodMarket Agent prepared this G$ stream. Review the wallet prompt before signing.</div>';
                    result.style.display = 'block';
                }
                if (typeof calculateStreamBuffer === 'function') await calculateStreamBuffer();
                if (typeof handleStartStream === 'function') await handleStartStream();
            }, 150);
            return true;
        }

        if (action.action_type === 'gcash_cashout') {
            // Prefill the GCash modal and run the exact same submitGcashCashout
            // path as the manual modal: PIN unlock (local wallet) -> sign G$
            // transfer -> wait for receipt -> POST /api/gcash/cashout-request,
            // so the cashout still lands in the GCash history.
            if (typeof openModal === 'function') openModal('gcashModal');
            setTimeout(async function() {
                const amountInput = document.getElementById('gcashAmount');
                const numberInput = document.getElementById('gcashNumber');
                const nameInput = document.getElementById('gcashName');
                if (amountInput) {
                    amountInput.value = payload.amount || '';
                    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (numberInput) numberInput.value = payload.gcash_number || '';
                if (nameInput) nameInput.value = payload.gcash_name || '';
                if (typeof submitGcashCashout === 'function') await submitGcashCashout();
            }, 150);
            return true;
        }

        if (action.action_type !== 'send_gd') return false;
        const recipient = payload.recipient || '';
        const amount = payload.amount || '';
        const tokenLabel = String(payload.token || 'G$').trim().toLowerCase();
        const tokenKey = { cusd: 'CUSD', usdt: 'USDT', celo: 'CELO' }[tokenLabel] || 'GD';
        const tokenChip = Array.from(document.querySelectorAll('#tokenSelector .token-chip'))
            .find(chip => chip.textContent.trim().toLowerCase() === (tokenKey === 'GD' ? 'g$' : tokenKey.toLowerCase()));
        if (tokenChip) selectToken(tokenKey, tokenChip);
        setTimeout(async function() {
            const toInput = document.getElementById('sendTo');
            const amountInput = document.getElementById('sendAmount');
            const alert = document.getElementById('sendAlert');
            if (toInput) {
                toInput.value = recipient;
                toInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (amountInput) {
                amountInput.value = amount;
                amountInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (alert) {
                alert.className = 'alert alert-success show';
                alert.innerHTML = '✅ GoodMarket Agent prepared this send. Review the wallet prompt before signing.';
            }
            if (typeof doSend === 'function') await doSend();
        }, 150);
        return true;
    };

    async function openAiActionFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const actionId = params.get('ai_action');
        if (!actionId) return;
        try {
            const res = await fetch('/api/ai-agent/actions/' + encodeURIComponent(actionId));
            const data = await res.json();
            if (data.success && data.action && window.GoodMarketAI.handleConfirmedAction) {
                await window.GoodMarketAI.handleConfirmedAction(data.action);
                params.delete('ai_action');
                const nextUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
                window.history.replaceState({}, '', nextUrl);
            }
        } catch (err) {
            console.warn('[GoodMarketAI] failed to open confirmed action:', err);
        }
    }

    document.addEventListener('DOMContentLoaded', openAiActionFromUrl);

            // ── UBI Claim ─────────────────────────────────────────────
    (function() {
        const UBI_CONTRACT  = '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1';
        const XDC_UBI_CONTRACT = '0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf';
        const FUSE_UBI_CONTRACT = '0xd253A5203817225e9768C05E5996d642fb96bA86';
        const XDC_CHAIN_ID_HEX = '0x32';
        const FUSE_CHAIN_ID_HEX = '0x7a';
        const CELO_CHAIN_ID_HEX = '0xa4ec';
        const CLAIM_DATA    = '0x4e71d92d';
        const SESSION_WALLET = WALLET.toLowerCase();
        let claimed = false;
        let needsVerification = false;
        let claimAvailability = null;
        let recommendedClaimNetwork = 'celo';
        window._walletNeedsFV = false;
        let _countdownInterval = null;

        const btn    = document.getElementById('ubiClaimBtn');
        const label  = document.getElementById('ubiClaimLabel');
        const icon   = document.getElementById('ubiClaimIcon');
        const status = document.getElementById('ubiClaimStatus');

        // ─────────────────────────────────────────────────────────────
        // Plasma Ember "is-hot" toggle.
        // The claim button's state is mutated from ~30 different sites
        // (label.textContent / btn.disabled flips). Instead of editing
        // every site, we *derive* the hot state from observable button
        // state via a MutationObserver. This keeps the change scoped,
        // safe to revert (delete this block + the .is-hot CSS = gone),
        // and impossible to leave out-of-sync.
        // ─────────────────────────────────────────────────────────────
        (function setupUbiClaimHotState() {
            if (!btn || !label) return;

            // Match labels that mean "ready to claim now":
            //   "Claim G$"
            //   "Claim 99 G$ on Celo"
            // Reject in-progress / done / verify-needed labels.
            const HOT_LABEL_RE  = /^\s*claim\s/i;
            const COLD_LABEL_RE = /(verify|checking|preparing|confirming|claimed|already|loading|wait)/i;

            let _evalScheduled = false;
            function _doEvaluate() {
                _evalScheduled = false;
                const txt = (label.textContent || '').trim();
                const isClaimable =
                    !btn.disabled &&
                    HOT_LABEL_RE.test(txt) &&
                    !COLD_LABEL_RE.test(txt);
                if (isClaimable) {
                    if (!btn.classList.contains('is-hot')) btn.classList.add('is-hot');
                } else if (btn.classList.contains('is-hot')) {
                    btn.classList.remove('is-hot');
                }
            }
            function evaluate() {
                // Coalesce bursty mutations (label + disabled often flip
                // together) into a single rAF-scheduled evaluation.
                if (_evalScheduled) return;
                _evalScheduled = true;
                requestAnimationFrame(_doEvaluate);
            }

            const labelObs = new MutationObserver(evaluate);
            labelObs.observe(label, { childList: true, characterData: true, subtree: true });

            const btnObs = new MutationObserver(evaluate);
            btnObs.observe(btn, { attributes: true, attributeFilter: ['disabled', 'class'] });

            // Initial pass + a couple of deferred passes for late-rendered
            // entitlement data (claimable label is set after fetch resolves).
            evaluate();
            setTimeout(evaluate, 300);
            setTimeout(evaluate, 1500);
        })();

        function setStatus(msg, color) {
            status.innerHTML = msg;
            status.style.color = color || 'var(--text-dim)';
        }

        function appendStatusLine(msg, color) {
            const safeMsg = (msg || '').toString();
            const current = status.innerHTML || '';
            status.innerHTML = current ? `${current}<br>${safeMsg}` : safeMsg;
            if (color) status.style.color = color;
        }

        async function claimXdcServerSide() {
            throw new Error('Server signing is disabled. Please use your injected wallet / WalletConnect.');
        }

        // Public XDC RPCs. Wallets that respect the rpcUrls list pick the
        // first reachable one; passing several insulates us from a single
        // endpoint returning a Cloudflare/maintenance HTML page (which the
        // wallet then surfaces as "Unexpected token '<'").
        const XDC_RPC_URLS = [
            'https://earpc.xinfin.network',
            'https://rpc.ankr.com/xdc',
            'https://erpc.xdcrpc.com',
            'https://rpc.xdcrpc.com',
            'https://rpc.xdc.org'
        ];

        // Public Celo RPCs. Same rationale as XDC — when forno.celo.org
        // returns an HTML page (Cloudflare challenge / maintenance / rate
        // limit), the wallet's RPC client throws "Unexpected token '<'".
        const CELO_RPC_URLS = [
            'https://forno.celo.org',
            'https://rpc.ankr.com/celo',
            'https://1rpc.io/celo'
        ];

        const FUSE_RPC_URLS = [
            'https://rpc.fuse.io',
            'https://fuse-mainnet.chainstacklabs.com',
            'https://fuse-pokt.nodies.app'
        ];

        // Detects a JSON-parse / HTML-response error bubbling up from the
        // wallet's internal RPC client (typical when a public RPC returns
        // an HTML challenge or is rate-limited).
        function _isRpcHtmlError(err) {
            if (err && err.__rpcHtml) return true;
            const msg = ((err && (err.shortMessage || err.message)) || '').toLowerCase();
            if (!msg) return false;
            return (
                msg.includes("unexpected token '<")
                || msg.includes('unexpected token <')
                || msg.includes('<!doctype')
                || msg.includes('<html')
                || msg.includes('is not valid json')
                || msg.includes('json.parse')
                || msg.includes('unexpected end of json')
                || msg.includes('failed to fetch')
                || msg.includes('network error')
                || msg.includes('load failed')
            );
        }
        // Backward-compatible alias.
        const _isXdcRpcHtmlError = _isRpcHtmlError;

        // Detects when the *wallet's own* configured RPC for a network is
        // failing (e.g. MetaMask still has XDC pointed at the dead
        // erpc.xinfin.network and surfaces "RPC endpoint returned too many
        // errors … Consider using a different RPC endpoint"). These are not
        // contract reverts — the cure is to point the wallet at a healthy RPC.
        function _isWalletRpcUnreachableError(err) {
            if (!err) return false;
            const msg = ((err.shortMessage || err.message) || '').toLowerCase();
            if (!msg) return false;
            return (
                msg.includes('too many errors')
                || msg.includes('different rpc endpoint')
                || msg.includes('rpc endpoint returned')
                || msg.includes('could not be reached')
                || msg.includes('internal json-rpc error')
                || msg.includes('bad gateway')
                || msg.includes('502')
                || msg.includes('503')
                || msg.includes('504')
                || msg.includes('gateway timeout')
            );
        }

        // Ask the wallet to (re)register XDC with our healthy multi-RPC list.
        // Modern MetaMask supports updating an existing network's RPC
        // endpoints via wallet_addEthereumChain, so this lets a user whose
        // wallet still has the dead RPC adopt a working one.
        async function _promptAddHealthyXdcRpc(provider) {
            return provider.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: XDC_CHAIN_ID_HEX,
                    chainName: 'XDC Network',
                    rpcUrls: XDC_RPC_URLS.slice(),
                    nativeCurrency: { name: 'XDC', symbol: 'XDC', decimals: 18 },
                    blockExplorerUrls: ['https://xdcscan.com']
                }]
            });
        }

        // Lenient JSON fetch: tries res.json() and only flags the error as
        // an HTML/upstream issue when the body is genuinely unparseable
        // (e.g. Flask 404 HTML, Cloudflare challenge). Valid JSON responses
        // — regardless of how the upstream sets the content-type header —
        // pass through untouched.
        async function _safeFetchJson(input, init) {
            const res = await fetch(input, init);
            try {
                return await res.json();
            } catch (parseErr) {
                const err = new Error('Server returned a non-JSON response (network/upstream error).');
                err.__rpcHtml = true;
                err.status = res.status;
                err.cause = parseErr;
                throw err;
            }
        }

        function _isUserRejectedError(err) {
            if (!err) return false;
            if (err.code === 4001) return true;
            const msg = ((err.shortMessage || err.message) || '').toLowerCase();
            return msg.includes('user rejected') || msg.includes('user denied') || msg.includes('cancelled');
        }

        // Detects Celo RPC errors that WalletConnect users commonly hit.
        // Similar to _isWalletRpcUnreachableError but includes "invalid rpc url" pattern.
        function _isCeloRpcUnreachableError(err) {
            if (!err) return false;
            const msg = ((err.shortMessage || err.message) || '').toLowerCase();
            if (!msg) return false;
            return (
                msg.includes('invalid rpc url')
                || msg.includes('invalid rpc')
                || msg.includes('invalid endpoint')
                || msg.includes('too many errors')
                || msg.includes('different rpc endpoint')
                || msg.includes('rpc endpoint returned')
                || msg.includes('could not be reached')
                || msg.includes('internal json-rpc error')
                || msg.includes('bad gateway')
                || msg.includes('502')
                || msg.includes('503')
                || msg.includes('504')
                || msg.includes('gateway timeout')
            );
        }

        // Ask the wallet to (re)register Celo with our healthy multi-RPC list.
        async function _promptAddHealthyCeloRpc(provider) {
            return provider.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: CELO_CHAIN_ID_HEX,
                    chainName: 'Celo Mainnet',
                    rpcUrls: CELO_RPC_URLS.slice(),
                    nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
                    blockExplorerUrls: ['https://celoscan.io']
                }]
            });
        }

        async function claimXdcInjected(provider, from) {
            const currentChain = await provider.request({ method: 'eth_chainId' });
            const normalizedCurrentChain = _normalizeChainIdHex(currentChain);
            if (normalizedCurrentChain !== XDC_CHAIN_ID_HEX) {
                try {
                    await provider.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: XDC_CHAIN_ID_HEX }]
                    });
                } catch (switchErr) {
                    if (switchErr && switchErr.code === 4001) {
                        throw new Error('XDC network switch was cancelled.');
                    }
                    if (switchErr && switchErr.code !== 4902) {
                        throw new Error(switchErr.message || 'Could not switch to XDC network.');
                    }
                    try {
                        await provider.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: XDC_CHAIN_ID_HEX,
                                chainName: 'XDC Network',
                                rpcUrls: XDC_RPC_URLS.slice(),
                                nativeCurrency: { name: 'XDC', symbol: 'XDC', decimals: 18 },
                                blockExplorerUrls: ['https://xdcscan.com']
                            }]
                        });
                    } catch (addErr) {
                        if (addErr && addErr.code === 4001) {
                            throw new Error('Adding XDC network was cancelled.');
                        }
                        throw new Error((addErr && addErr.message) || 'Could not add XDC network.');
                    }
                }
            }

            // Some wallets (notably MetaMask Mobile, Trust Wallet) reject
            // eth_sendTransaction when a non-standard `chainId` field is
            // present in the tx params. The chain switch above already
            // pinned the wallet to XDC, so we omit it from params.
            const sendXdcTx = () => provider.request({
                method: 'eth_sendTransaction',
                params: [{ from, to: XDC_UBI_CONTRACT, data: CLAIM_DATA, value: '0x0' }]
            });

            try {
                return await sendXdcTx();
            } catch (sendErr) {
                if (_isUserRejectedError(sendErr)) throw sendErr;
                // The wallet's own XDC RPC is unreachable (e.g. still pinned to
                // the dead erpc.xinfin.network). Ask it to adopt our healthy
                // RPC list, then retry the send once.
                if (_isWalletRpcUnreachableError(sendErr)) {
                    try {
                        await _promptAddHealthyXdcRpc(provider);
                        await new Promise(r => setTimeout(r, 1200));
                        return await sendXdcTx();
                    } catch (rpcFixErr) {
                        if (_isUserRejectedError(rpcFixErr)) throw rpcFixErr;
                        throw sendErr;
                    }
                }
                if (!_isXdcRpcHtmlError(sendErr)) throw sendErr;
                // Transient public-RPC HTML/parse error — wait a moment and
                // try once more before giving up.
                await new Promise(r => setTimeout(r, 3500));
                return await sendXdcTx();
            }
        }



        async function claimFuseInjected(provider, from) {
            const currentChain = await provider.request({ method: 'eth_chainId' });
            const normalizedCurrentChain = _normalizeChainIdHex(currentChain);
            if (normalizedCurrentChain !== FUSE_CHAIN_ID_HEX) {
                try {
                    await provider.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: FUSE_CHAIN_ID_HEX }]
                    });
                } catch (switchErr) {
                    if (switchErr && switchErr.code === 4001) {
                        throw new Error('Fuse network switch was cancelled.');
                    }
                    if (switchErr && switchErr.code !== 4902) {
                        throw new Error(switchErr.message || 'Could not switch to Fuse network.');
                    }
                    try {
                        await provider.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: FUSE_CHAIN_ID_HEX,
                                chainName: 'Fuse Mainnet',
                                rpcUrls: FUSE_RPC_URLS.slice(),
                                nativeCurrency: { name: 'FUSE', symbol: 'FUSE', decimals: 18 },
                                blockExplorerUrls: ['https://explorer.fuse.io']
                            }]
                        });
                    } catch (addErr) {
                        if (addErr && addErr.code === 4001) {
                            throw new Error('Adding Fuse network was cancelled.');
                        }
                        throw new Error((addErr && addErr.message) || 'Could not add Fuse network.');
                    }
                }
            }

            const sendFuseTx = () => provider.request({
                method: 'eth_sendTransaction',
                params: [{ from, to: FUSE_UBI_CONTRACT, data: CLAIM_DATA, value: '0x0' }]
            });

            try {
                return await sendFuseTx();
            } catch (sendErr) {
                if (_isUserRejectedError(sendErr)) throw sendErr;
                if (!_isRpcHtmlError(sendErr)) throw sendErr;
                await new Promise(r => setTimeout(r, 3500));
                return await sendFuseTx();
            }
        }

        // Mirror of claimXdcInjected for the Celo claim. Same shape: chain
        // check → switch → add (with multi-RPC fallback for the wallet's
        // own JSON-RPC) → send tx → one-shot retry on transient HTML/parser
        // errors. Used by the unified flow's standard (non-MiniPay) path.
        async function claimCeloInjected(provider, from) {
            // For WCClaimShim (WalletConnect users), chain switch is handled internally
            // and returns null. For injected providers, do the normal chain switch.
            const isWcShim = provider instanceof WCClaimShim;
            console.log('[claimCeloInjected] Starting claim:', {
                isWcShim,
                from,
                providerType: isWcShim ? 'WCClaimShim' : (provider.isMetaMask ? 'MetaMask' : provider.isTrust ? 'Trust' : 'Other')
            });
            
            if (!isWcShim) {
                const currentChain = await provider.request({ method: 'eth_chainId' });
                const normalizedCurrentChain = _normalizeChainIdHex(currentChain);
                console.log('[claimCeloInjected] Current chain:', normalizedCurrentChain, 'Required:', CELO_CHAIN_ID_HEX);
                if (normalizedCurrentChain !== CELO_CHAIN_ID_HEX) {
                    try {
                        await provider.request({
                            method: 'wallet_switchEthereumChain',
                            params: [{ chainId: CELO_CHAIN_ID_HEX }]
                        });
                    } catch (switchErr) {
                        if (switchErr && switchErr.code === 4001) {
                            throw new Error('Celo network switch was cancelled.');
                        }
                        if (switchErr && switchErr.code !== 4902) {
                            throw new Error(switchErr.message || 'Could not switch to Celo network.');
                        }
                        try {
                            await provider.request({
                                method: 'wallet_addEthereumChain',
                                params: [{
                                    chainId: CELO_CHAIN_ID_HEX,
                                    chainName: 'Celo Mainnet',
                                    rpcUrls: CELO_RPC_URLS.slice(),
                                    nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
                                    blockExplorerUrls: ['https://celoscan.io']
                                }]
                            });
                        } catch (addErr) {
                            if (addErr && addErr.code === 4001) {
                                throw new Error('Adding Celo network was cancelled.');
                            }
                            throw new Error((addErr && addErr.message) || 'Could not add Celo network.');
                        }
                    }
                }
            } else {
                console.log('[claimCeloInjected] Using WCClaimShim - skipping chain switch (WC session handles Celo)');
            }

            // Same defensive shape as XDC: omit non-standard `chainId`
            // from tx params (some wallets reject it). The chain switch
            // above already pinned the wallet to Celo.
            const sendCeloTx = () => provider.request({
                method: 'eth_sendTransaction',
                params: [{ from, to: UBI_CONTRACT, data: CLAIM_DATA, value: '0x0' }]
            });

            try {
                console.log('[claimCeloInjected] Sending Celo claim transaction...');
                const txHash = await sendCeloTx();
                console.log('[claimCeloInjected] Transaction sent successfully:', txHash);
                return txHash;
            } catch (sendErr) {
                console.error('[claimCeloInjected] Transaction error:', sendErr);
                
                if (_isUserRejectedError(sendErr)) throw sendErr;
                
                // Handle Celo RPC errors — prompt wallet to adopt a healthy RPC
                // and retry once. Works for both injected AND WalletConnect providers.
                if (_isCeloRpcUnreachableError(sendErr)) {
                    try {
                        await _promptAddHealthyCeloRpc(provider);
                        await new Promise(r => setTimeout(r, 1200));
                        return await sendCeloTx();
                    } catch (rpcFixErr) {
                        if (_isUserRejectedError(rpcFixErr)) throw rpcFixErr;
                        // If the wallet rejected the chain update, surface a clear message
                        if (isWcShim) {
                            throw new Error(
                                'Your wallet has an invalid Celo RPC URL ' +
                                '(e.g. a session-based URL from twnodes.com or txnodes.com that has expired). ' +
                                'Open your wallet app → Settings → Networks → Celo and set the RPC URL to ' +
                                'https://forno.celo.org or https://rpc.ankr.com/celo, then try again.'
                            );
                        }
                        throw sendErr;
                    }
                }
                
                // WalletConnect-specific error messages for non-RPC errors
                if (isWcShim) {
                    const errMsg = String((sendErr && (sendErr.message || sendErr.shortMessage)) || '').toLowerCase();
                    if (errMsg.includes('chain') || errMsg.includes('network') || errMsg.includes('unsupported')) {
                        throw new Error('WalletConnect: Your wallet may not be connected to Celo network. Please switch to Celo in your wallet and try again. ' + (sendErr.message || ''));
                    }
                    if (errMsg.includes('session') || errMsg.includes('expired') || errMsg.includes('disconnected')) {
                        throw new Error('WalletConnect session issue. Please reconnect your wallet and try again. ' + (sendErr.message || ''));
                    }
                }
                
                if (!_isRpcHtmlError(sendErr)) throw sendErr;
                // Transient public-RPC HTML/parse error — wait a moment and
                // try once more before giving up.
                await new Promise(r => setTimeout(r, 3500));
                return await sendCeloTx();
            }
        }

        function getNextResetMs() {
            const now = new Date();
            const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0, 0));
            if (now >= next) next.setUTCDate(next.getUTCDate() + 1);
            return next.getTime() - now.getTime();
        }

        function formatCountdown(ms) {
            if (ms <= 0) return '00:00:00';
            const totalSec = Math.floor(ms / 1000);
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
        }

        function startCountdown() {
            const box = document.getElementById('ubiCountdownBox');
            const display = document.getElementById('ubiCountdownDisplay');
            const heroTimer = document.getElementById('heroClaimTimer');
            box.style.display = 'block';
            if (_countdownInterval) clearInterval(_countdownInterval);
            function tick() {
                const remaining = getNextResetMs();
                const formatted = formatCountdown(remaining);
                display.textContent = formatted;
                // Also update the claim hero timer if the hero is in the already-claimed state
                if (heroTimer) {
                    const hero = document.getElementById('ubiClaimHero');
                    if (hero && hero.classList.contains('is-claimed')) {
                        heroTimer.textContent = 'Next claim in ' + formatted;
                    }
                }
                if (remaining <= 0) {
                    clearInterval(_countdownInterval);
                    setStatus('🎉 Claim window is now open! Refresh to claim.', 'var(--green)');
                }
            }
            tick();
            _countdownInterval = setInterval(tick, 1000);
        }

        function _hideReVerifyHint() {
            const rv = document.getElementById('ubiReVerifyHint');
            if (rv) rv.style.display = 'none';
        }



        function getClaimWalletCapabilities() {
            const login = window.GM_WALLET_BOOT.loginMethod.toLowerCase();
            const provider = _getEthProvider && _getEthProvider();
            const isMiniPay = _isMiniPay();
            // The in-app wallet signs Celo transactions only — never recommend
            // the XDC route to local logins, even if an extension is installed.
            const isLocal = login === 'local';
            const isWalletConnect = ['walletconnect', 'manual', 'manual_address'].includes(login) || !!(provider && provider.isWalletConnect);
            const isMetaMask = !!(provider && provider.isMetaMask) || !!(window.ethereum && window.ethereum.isMetaMask);
            const isTrustWallet = _isTrustWalletMobileContext && _isTrustWalletMobileContext();
            const hasInjected = !!provider || !!window.ethereum;
            const supportsXdc = !isLocal && !isMiniPay && !isTrustWallet && (isMetaMask || isWalletConnect || hasInjected);
            return { isMiniPay, isWalletConnect, isMetaMask, isTrustWallet, hasInjected, supportsFuse: false, supportsXdc };
        }

        function claimNetworkStatusHtml(network, info, caps) {
            const meta = {
                celo: { icon: '🟢', name: 'Celo', hint: 'Works for MiniPay, MetaMask, WalletConnect and most injected wallets.' },
                xdc:  { icon: '💠', name: 'XDC',  hint: 'Advanced route; best with wallets that reliably support XDC network prompts.' },
            }[network];
            const isAvailable = !(info && info.is_available === false);
            const canClaim = isAvailable && !!(info && info.can_claim);
            const supported = isAvailable && (network === 'celo' || (network === 'xdc' && caps.supportsXdc));
            const amount = info && (info.claimable_formatted || info.entitlement_formatted || (info.claimable ? Number(info.claimable).toFixed(2) : '0.00'));
            let statusText = 'Claimed';
            let statusClass = 'claimed';
            let hint = meta.hint;
            if (!isAvailable) {
                statusText = 'Not Available';
                statusClass = 'warning';
                hint = info.error || `${meta.name} claiming is temporarily not available.`;
            } else if (canClaim && supported) {
                statusText = `${amount} G$`;
                statusClass = 'available';
                hint = 'Available to claim now on this wallet.';
            } else if (canClaim && !supported) {
                statusText = 'Use compatible wallet';
                statusClass = 'warning';
                hint = caps.isMiniPay
                    ? 'MiniPay is Celo-only, so this network is hidden from the primary claim button.'
                    : 'Use MetaMask or a compatible WalletConnect wallet for this network.';
            } else if (info && (info.reason === 'not_verified' || info.reason === 're_verification_needed')) {
                statusText = (amount && Number(amount) > 0) ? `${amount} G$` : 'Claimable after Face ID';
                statusClass = 'warning';
                hint = info.reason === 're_verification_needed'
                    ? 'Face Verification expired. Re-verify first, then claim on this network.'
                    : 'Face Verification required first, then you can claim on this network.';
            } else if (info && info.success === false) {
                statusText = 'Unavailable';
                statusClass = 'warning';
                hint = info.error || 'Could not check this network right now.';
            }
            const recommended = network === recommendedClaimNetwork && canClaim && supported;
            return `
                <div class="claim-network-card ${recommended ? 'is-recommended' : ''} ${supported ? '' : 'is-disabled'}">
                    <div class="claim-network-main">
                        <div class="claim-network-icon">${meta.icon}</div>
                        <div>
                            <div class="claim-network-name">${meta.name}</div>
                            <div class="claim-network-hint">${hint}</div>
                        </div>
                    </div>
                    <div class="claim-network-status ${statusClass}">${statusText}</div>
                </div>`;
        }

        function renderClaimNetworks() {
            const list = document.getElementById('claimNetworkList');
            const note = document.getElementById('claimWalletNote');
            if (!list || !claimAvailability) return;
            const caps = getClaimWalletCapabilities();
            const claims = claimAvailability.claims || {};
            list.innerHTML = ['celo', 'xdc'].map(n => claimNetworkStatusHtml(n, claims[n] || {}, caps)).join('');
            if (note) {
                if (caps.isMiniPay) {
                    note.textContent = 'MiniPay is Celo-only. XDC claims require MetaMask or a compatible WalletConnect wallet.';
                } else if (caps.isTrustWallet) {
                    note.textContent = 'Trust Wallet network prompts can be unreliable for XDC. Use MetaMask or compatible WalletConnect for XDC.';
                } else {
                    note.textContent = 'GoodMarket recommends the first unclaimed network your wallet can safely claim.';
                }
            }
        }

        function pickRecommendedClaimNetwork() {
            const caps = getClaimWalletCapabilities();
            const claims = (claimAvailability && claimAvailability.claims) || {};
            if (claims.celo && claims.celo.can_claim) return 'celo';
            if (!caps.isMiniPay && caps.supportsXdc && claims.xdc && claims.xdc.can_claim) return 'xdc';
            return caps.isMiniPay ? 'celo' : null;
        }

        // Update the claim button box with total claimable G$ from all networks
        function updateClaimButtonBox(data) {
            const claims = data.claims || {};
            const caps = getClaimWalletCapabilities();

            const hero = document.getElementById('ubiClaimHero');
            const heroEyebrow = document.getElementById('heroClaimEyebrow');
            const heroAmount = document.getElementById('heroClaimAmount');
            const heroSub = document.getElementById('heroClaimSub');
            const heroTimer = document.getElementById('heroClaimTimer');
            const heroCta = document.getElementById('heroClaimCta');

            if (!hero) return;

            // Calculate total claimable G$ from all available networks
            let totalClaimable = 0;
            let claimableNetworks = [];

            if (claims.celo && claims.celo.can_claim && claims.celo.is_available !== false) {
                const celoAmt = parseFloat(claims.celo.claimable) || parseFloat(claims.celo.entitlement) || 0;
                totalClaimable += celoAmt;
                claimableNetworks.push('Celo');
            }

            if (claims.xdc && claims.xdc.can_claim && claims.xdc.is_available !== false) {
                if (!caps.isMiniPay && caps.supportsXdc) {
                    const xdcAmt = parseFloat(claims.xdc.claimable) || parseFloat(claims.xdc.entitlement) || 0;
                    totalClaimable += xdcAmt;
                    claimableNetworks.push('XDC');
                }
            }

            // Check for face verification needed
            const needsVerification = claims.celo && (
                claims.celo.reason === 'not_verified' ||
                claims.celo.reason === 're_verification_needed' ||
                claims.celo.is_verified === false
            );

            // Check if any network has claimable balance
            const hasClaimable = totalClaimable > 0 && !needsVerification;

            // Update hero state
            hero.classList.remove('is-disabled', 'is-claimed');
            heroTimer.textContent = '';

            if (needsVerification) {
                heroEyebrow.textContent = 'Face verification';
                heroAmount.innerHTML = '🪪';
                heroSub.textContent = 'Tap to start face verification';
                heroCta.textContent = 'Verify Face ID';
                hero.classList.add('is-disabled');
            } else if (hasClaimable) {
                const formattedAmount = totalClaimable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
                const networkLabel = claimableNetworks.length > 1
                    ? claimableNetworks.join(' + ')
                    : claimableNetworks[0] || 'Celo';
                heroEyebrow.textContent = 'Claimable UBI';
                heroAmount.innerHTML = `${formattedAmount} <span class="unit">G$</span>`;
                heroSub.textContent = `available to claim${claimableNetworks.length ? ` on ${networkLabel}` : ''}`;
                heroCta.textContent = 'Claim UBI G$';
            } else {
                heroEyebrow.textContent = 'Claimable UBI';
                heroAmount.innerHTML = `0.00 <span class="unit">G$</span>`;
                heroSub.textContent = 'Already claimed — come back soon';
                heroCta.textContent = 'View claim details';
                hero.classList.add('is-claimed');

                // Show countdown if available
                const countdown = document.getElementById('ubiCountdownDisplay');
                if (countdown && countdown.textContent && countdown.textContent !== '--:--:--') {
                    heroTimer.textContent = 'Next claim in ' + countdown.textContent;
                }
            }
        }

        function applyClaimAvailabilityData(data) {
            claimAvailability = data;
            const claims = data.claims || {};
            recommendedClaimNetwork = pickRecommendedClaimNetwork();
            applyEntitlementData(claims.celo || data);
            renderClaimNetworks();
            updateClaimButtonBox(data);

            if (needsVerification) return;
            const caps = getClaimWalletCapabilities();
            if (recommendedClaimNetwork === 'fuse') {
                const amt = claims.fuse && claims.fuse.claimable_formatted ? claims.fuse.claimable_formatted : 'G$';
                label.textContent = `Claim ${amt} G$ on Fuse`;
                icon.textContent = '🔥';
                btn.disabled = false;
                setStatus('Fuse claim is available. GoodMarket will switch your wallet to Fuse when you tap claim.', 'var(--green)');
            } else if (recommendedClaimNetwork === 'xdc') {
                const amt = claims.xdc && claims.xdc.claimable_formatted ? claims.xdc.claimable_formatted : 'G$';
                label.textContent = `Claim ${amt} G$ on XDC`;
                icon.textContent = '💠';
                btn.disabled = false;
                setStatus('XDC claim is available for this wallet. Approve the XDC network prompt to continue.', 'var(--green)');
            } else if (!recommendedClaimNetwork) {
                const hasUnsupported = ['xdc'].some(n => claims[n] && claims[n].can_claim);
                const celoNeedsFaceVerification =
                    claims.celo && (claims.celo.reason === 'not_verified' || claims.celo.reason === 're_verification_needed' || claims.celo.is_verified === false);
                if (celoNeedsFaceVerification) {
                    label.textContent = claims.celo.reason === 're_verification_needed'
                        ? 'Re-verify Face ID to Claim'
                        : 'Verify Face ID to Claim';
                    icon.textContent = '🪪';
                    btn.disabled = false;
                    setStatus(
                        claims.celo.reason === 're_verification_needed'
                            ? 'Face Verification expired. Re-verify on Celo Identity first.'
                            : 'Face Verification on Celo Identity is required before claiming on any network.',
                        '#7c3aed'
                    );
                } else
                if (hasUnsupported) {
                    label.textContent = 'Use MetaMask / WalletConnect';
                    icon.textContent = '⚠️';
                    btn.disabled = true;
                    setStatus('You still have a claim on another network, but this wallet cannot safely prompt it.', '#d97706');
                } else if (!claims.celo || !claims.celo.can_claim) {
                    label.textContent = 'Already Claimed Today';
                    icon.textContent = '✅';
                    btn.disabled = true;
                }
            }
            renderClaimNetworks();
        }

        function applyEntitlementData(d) {
            const needsVerify = d.success && (d.reason === 'not_verified' || d.reason === 're_verification_needed');
            const isReverify  = d.reason === 're_verification_needed';
            if (needsVerify) {
                _hideReVerifyHint();
                needsVerification = true;
                window._walletNeedsFV = true;
                btn.style.background = 'linear-gradient(135deg,#7c3aed,#6d28d9)';
                icon.textContent = '🪪';
                label.textContent = isReverify ? 'Re-verify Face ID to Claim' : 'Verify Face ID to Claim';
                btn.disabled = false;
                setStatus(
                    isReverify
                        ? 'Your Face Verification has expired. Re-verify to continue claiming G$.'
                        : 'Your wallet needs face verification before claiming G$',
                    '#7c3aed'
                );
                window._celoCanClaim = false;
            } else if (d.success && d.can_claim) {
                _hideReVerifyHint();
                needsVerification = false;
                window._walletNeedsFV = false;
                const claimAmount = d.claimable_formatted || d.entitlement_formatted || (d.claimable ? Number(d.claimable).toFixed(2) : '0.00');
                label.textContent = 'Claim ' + claimAmount + ' G$ on Celo';
                icon.textContent = '🪙';
                btn.style.background = '';
                btn.disabled = false;
                setStatus('Ready to claim!', 'var(--green)');
                window._celoCanClaim = true;
            } else if (d.success && !d.can_claim) {
                _hideReVerifyHint();
                needsVerification = false;
                window._walletNeedsFV = false;
                label.textContent = 'Already Claimed Today';
                icon.textContent = '✅';
                btn.disabled = true;
                setStatus('Come back tomorrow for your next claim.');
                startCountdown();
                window._celoCanClaim = false;
            } else {
                needsVerification = false;
                window._walletNeedsFV = false;
                label.textContent = 'Claim G$';
                icon.textContent = '🪙';
                btn.disabled = false;
                setStatus(d.error ? 'Could not fetch amount' : '');
                window._celoCanClaim = false;
            }
        }

        // Expose re-verify trigger so the "Re-verify" button can call it from global scope
        window._triggerReVerify = function() {
            needsVerification = true;
            window._walletNeedsFV = true;
            btn.disabled = false;
            icon.textContent = '🪪';
            label.textContent = 'Re-verify Face ID to Claim';
            btn.style.background = 'linear-gradient(135deg,#7c3aed,#6d28d9)';
            setStatus('Tap the button above to start face re-verification.', '#7c3aed');
            const rv = document.getElementById('ubiReVerifyHint');
            if (rv) rv.style.display = 'none';
        };

        function fetchEntitlement() {
            setStatus('Checking entitlement…', 'var(--text-dim)');
            // Always force-bypass the backend cache on the first check.
            // Stale cache (up to 3 min) caused "Already Claimed Today" to appear for
            // wallets whose face-verification status had just changed.
            fetch('/api/claim/availability?force=1', { cache: 'no-store' })
                .then(r => r.json())
                .then(d => {
                    // Guard: if the session wallet changed (user switched wallets),
                    // the returned wallet won't match this page's WALLET variable.
                    // Reload so the page re-renders with the correct session wallet.
                    if (d.wallet && d.wallet !== WALLET.toLowerCase()) {
                        window.location.reload();
                        return;
                    }
                    if (d.claims) {
                        applyClaimAvailabilityData(d);
                    } else {
                        applyEntitlementData(d);
                    }
                })
                .catch(() => { label.textContent = 'Claim G$'; icon.textContent = '🪙'; btn.disabled = false; });
        }

        // Load UBI pool balance
        fetch('/api/ubi-pool-balance').then(r => r.json()).then(d => {
            const el = document.getElementById('ubiPoolBalance');
            if (el) el.textContent = d.balance_formatted || '—';
        }).catch(() => { const el = document.getElementById('ubiPoolBalance'); if (el) el.textContent = '—'; });


        function openSavingsPopupAfterClaim() {
            const modal = document.getElementById('savingsPopupModal');
            const frame = document.getElementById('savingsPopupFrame');
            if (!modal || !frame) return;
            if (!frame.src) frame.src = '/savings?from=wallet_claim';
            if (typeof closeModal === 'function') closeModal('claimModal');
            modal.classList.add('open');
            modal.setAttribute('aria-hidden', 'false');
        }

        window.closeSavingsPopup = function() {
            const modal = document.getElementById('savingsPopupModal');
            if (!modal) return;
            modal.classList.remove('open');
            modal.setAttribute('aria-hidden', 'true');
        };

        function pollReceipt(txHash, attempts) {
            if (attempts <= 0) {
                btn.disabled = false; label.textContent = 'Claim G$'; icon.textContent = '🪙';
                setStatus('Timed out. Check explorer for: ' + txHash.slice(0,12) + '…', '#d97706');
                return;
            }
            setTimeout(function() {
                fetch('/api/tx-receipt/' + txHash).then(r => r.json()).then(d => {
                    if (!d.found) {
                        setStatus('Waiting for confirmation… (' + (21 - attempts) + '/20)', 'var(--text-dim)');
                        pollReceipt(txHash, attempts - 1);
                    } else if (d.status === 'success') {
                        claimed = true;
                        label.textContent = 'Claimed!';
                        icon.textContent = '✅';
                        btn.disabled = true;
                        setStatus('Success! G$ sent to your wallet.', 'var(--green)');
                        logGoodMarketClaim(txHash, 'celo', 'confirmed');
                        startCountdown();
                        setTimeout(() => { loadBalances(true); fetchEntitlement(); }, 4000);
                        try { window.showClaimCelebration && window.showClaimCelebration({ networks: ['celo'] }); } catch (_) {}
                        setTimeout(openSavingsPopupAfterClaim, 900);
                    } else {
                        btn.disabled = false; label.textContent = 'Claim G$'; icon.textContent = '🪙';
                        setStatus('Transaction failed. You may have already claimed today.', 'var(--red)');
                    }
                }).catch(() => pollReceipt(txHash, attempts - 1));
            }, 3000);
        }

        async function logGoodMarketClaim(txHash, network, status) {
            try {
                if (!txHash) return;
                // Re-use the same claim_attempt_id across submitted → confirmed
                // updates for a single tx so the events trail and facts row
                // line up via that key.
                window.__claimAttemptIds = window.__claimAttemptIds || {};
                let attemptId = window.__claimAttemptIds[txHash];
                if (!attemptId) {
                    // The server stores claim_attempt_id as Postgres uuid, so
                    // the fallback for in-app wallet browsers that don't
                    // expose crypto.randomUUID must still produce a valid
                    // RFC4122 v4 UUID — otherwise the insert blows up on
                    // type cast. Build one from crypto.getRandomValues when
                    // available, else from Math.random as last resort.
                    if (window.crypto && crypto.randomUUID) {
                        attemptId = crypto.randomUUID();
                    } else {
                        const buf = new Uint8Array(16);
                        if (window.crypto && crypto.getRandomValues) {
                            crypto.getRandomValues(buf);
                        } else {
                            for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
                        }
                        // Per RFC4122 §4.4: set version (4) and variant (10).
                        buf[6] = (buf[6] & 0x0f) | 0x40;
                        buf[8] = (buf[8] & 0x3f) | 0x80;
                        const hex = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
                        attemptId = (
                            hex.slice(0, 8) + '-' +
                            hex.slice(8, 12) + '-' +
                            hex.slice(12, 16) + '-' +
                            hex.slice(16, 20) + '-' +
                            hex.slice(20, 32)
                        );
                    }
                    window.__claimAttemptIds[txHash] = attemptId;
                }

                const resp = await fetch('/api/claims/v2/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tx_hash: txHash,
                        network: network || 'celo',
                        status: status || 'confirmed',
                        correlation_id: window.__claimFaucetCorrelationId || null,
                        claim_attempt_id: attemptId
                    })
                });
                if (!resp.ok) {
                    let body = '';
                    try { body = await resp.text(); } catch (_) {}
                    console.warn('[claim-log] /api/claims/v2/confirm returned', resp.status, body);
                    return;
                }
                if (window.__claimDebug) {
                    try {
                        const data = await resp.json();
                        console.log('[claim-log] recorded', data);
                    } catch (_) {}
                }
            } catch (e) {
                console.warn('[claim-log] failed to record claim metric:', e);
            }
        }

        function _showTrustWalletFvBlocker() {
            // Trust Wallet's mobile in-app dApp browser has a long-standing bug
            // where personal_sign approvals from the wallet UI never make it
            // back to the page's JS Promise. Even with hex-encoded payloads and
            // the Celo chain switch shipped in earlier PRs, the user still
            // ends up stuck on "Preparing verification…" after they tap
            // "Approve" in Trust. WalletConnect bypasses the broken in-app
            // bridge entirely (Trust handles the signing in its main app
            // instead of the dApp browser tab), so the only reliable fix is to
            // route Trust Wallet users through the WalletConnect login.
            btn.disabled = false;
            icon.textContent = '🪪';
            label.textContent = 'Verify Face ID to Claim';
            const wrap = document.getElementById('ubiClaimStatus') || document.body;
            const existing = document.getElementById('fvTrustWalletBlocker');
            if (existing) existing.remove();
            const card = document.createElement('div');
            card.id = 'fvTrustWalletBlocker';
            card.style.cssText = 'margin-top:0.8rem;padding:0.95rem 1.1rem;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.45);border-radius:12px;color:#92400e;font-size:0.86rem;line-height:1.5;text-align:left;';
            card.innerHTML =
                '<div style="font-weight:700;color:#b45309;margin-bottom:0.35rem;">⚠️ Trust Wallet detected</div>' +
                '<div style="margin-bottom:0.65rem;">Trust Wallet\'s in-app browser does not reliably deliver Face ID signatures back to this page. To verify reliably, please log out and reconnect with <strong>WalletConnect</strong> — Trust will then handle the signature inside its main app instead of the dApp browser tab.</div>' +
                '<div style="display:flex;flex-direction:column;gap:0.45rem;">' +
                  '<a href="/logout" style="display:block;text-align:center;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;text-decoration:none;font-weight:600;padding:0.55rem 1rem;border-radius:10px;font-size:0.9rem;">🔐 Log out & reconnect via WalletConnect</a>' +
                  '<button type="button" id="fvTrustForceTryBtn" style="background:transparent;border:1px solid rgba(217,119,6,0.45);color:#92400e;font-size:0.8rem;font-weight:500;padding:0.45rem 0.9rem;border-radius:10px;cursor:pointer;">Try in-app sign anyway (may hang)</button>' +
                '</div>';
            // Set the status text BEFORE appending the card. setStatus()
            // writes to status.innerHTML which would otherwise wipe the card
            // we just appended (status === wrap, both point at #ubiClaimStatus).
            setStatus('Trust Wallet in-app signing is unreliable — please switch to WalletConnect.', '#d97706');
            wrap.appendChild(card);
            const forceBtn = card.querySelector('#fvTrustForceTryBtn');
            if (forceBtn) {
                forceBtn.addEventListener('click', () => {
                    card.remove();
                    _startFvSigningFlow(true);
                });
            }
        }

        // MiniPay's in-app mini-app WebView consistently fails the FaceTec
        // face scan on goodid.gooddollar.org (the audit-trail image / WebRTC
        // stack the SDK expects isn't available in Opera's restricted
        // WebView), even though the personal_sign → FV link generation
        // itself works. The FV link is signature-embedded (fvsig) and the
        // resulting on-chain whitelist is keyed on wallet address, not on
        // browser session, so the user can sign inside MiniPay, copy the
        // generated link to their phone's native Chrome/Safari, complete
        // the face scan there, and then return to MiniPay to claim —
        // without re-signing or re-connecting. This helper renders that
        // handoff UI instead of redirecting inside MiniPay's WebView.
        let _miniPayFvForceTry = false;
        function _showMiniPayFvHandoff(link) {
            btn.disabled = false;
            icon.textContent = '🪪';
            label.textContent = 'Verify Face ID to Claim';
            const wrap = document.getElementById('ubiClaimStatus') || document.body;
            const existing = document.getElementById('fvMiniPayHandoff');
            if (existing) existing.remove();
            const card = document.createElement('div');
            card.id = 'fvMiniPayHandoff';
            card.style.cssText = 'margin-top:0.8rem;padding:0.95rem 1.1rem;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.45);border-radius:12px;color:#92400e;font-size:0.86rem;line-height:1.5;text-align:left;';
            // Truncate link for display so the card stays tidy on mobile.
            const shortLink = link.length > 64 ? link.slice(0, 48) + '…' + link.slice(-12) : link;
            // Note: we intentionally do NOT render an "Open in Chrome"
            // button here. MiniPay's mini-app shell (Opera) intercepts
            // in-page navigations — including anchors with target="_blank"
            // and window.open() calls — and keeps the user inside its own
            // WebView, which is exactly the environment where the FaceTec
            // scan fails. The only reliable way to escape the mini-app is
            // for the user to manually paste the link into their phone's
            // native browser, so the UI funnels everyone through Copy.
            card.innerHTML =
                '<div style="font-weight:700;color:#b45309;margin-bottom:0.35rem;">⚠️ MiniPay detected</div>' +
                '<div style="margin-bottom:0.65rem;">Face Verification often fails inside MiniPay\'s in-app browser (the face scan sometimes errors out on Opera\'s restricted WebView), so for the most reliable experience we recommend finishing it outside MiniPay. Tap <strong>Copy</strong> below, then <strong>open Chrome (or your preferred browser) outside MiniPay and paste the link there</strong> to complete verification. Your signature is already embedded in the link — you will <em>not</em> need to sign or reconnect. After verifying, return to MiniPay and reopen GoodMarket to claim your G$.</div>' +
                '<div style="display:flex;flex-direction:column;gap:0.45rem;">' +
                  '<div style="display:flex;gap:0.4rem;align-items:center;background:rgba(217,119,6,0.07);border:1px solid rgba(217,119,6,0.28);border-radius:10px;padding:0.45rem 0.6rem;font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.72rem;color:#92400e;overflow:hidden;">' +
                    '<span id="fvMiniPayLinkPreview" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + shortLink + '</span>' +
                    '<button type="button" id="fvMiniPayCopyBtn" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);border:1px solid rgba(124,58,237,0.7);color:#fff;font-size:0.78rem;font-weight:700;padding:0.4rem 0.8rem;border-radius:8px;cursor:pointer;white-space:nowrap;">📋 Copy link</button>' +
                  '</div>' +
                  '<div style="font-size:0.78rem;color:#92400e;line-height:1.45;background:rgba(217,119,6,0.06);border-radius:8px;padding:0.5rem 0.7rem;">' +
                    '<div style="font-weight:700;color:#b45309;margin-bottom:0.25rem;">Next steps</div>' +
                    '<ol style="margin:0;padding-left:1.1rem;">' +
                      '<li>Tap <strong>Copy link</strong> above.</li>' +
                      '<li>Leave MiniPay and open <strong>Chrome</strong> (or Safari / any browser outside MiniPay).</li>' +
                      '<li>Paste the link into the address bar and complete Face Verification there.</li>' +
                      '<li>Return to MiniPay, reopen GoodMarket, and claim your G$.</li>' +
                    '</ol>' +
                  '</div>' +
                  '<button type="button" id="fvMiniPayForceTryBtn" style="background:transparent;border:1px solid rgba(217,119,6,0.45);color:#92400e;font-size:0.78rem;font-weight:500;padding:0.4rem 0.9rem;border-radius:10px;cursor:pointer;">Try inside MiniPay anyway</button>' +
                '</div>' +
                '<div id="fvMiniPayFeedback" style="margin-top:0.55rem;font-size:0.8rem;color:#92400e;min-height:1em;" aria-live="polite"></div>';
            // Write the outer status BEFORE appending the card — setStatus()
            // replaces status.innerHTML, so any later call while the card is
            // a child of #ubiClaimStatus would destroy it. Per-copy feedback
            // goes into #fvMiniPayFeedback (inside the card) instead.
            setStatus('Copy the link below and open it in Chrome (outside MiniPay) to finish Face Verification.', '#d97706');
            wrap.appendChild(card);

            const copyBtn = card.querySelector('#fvMiniPayCopyBtn');
            const preview = card.querySelector('#fvMiniPayLinkPreview');
            const forceBtn = card.querySelector('#fvMiniPayForceTryBtn');
            const feedback = card.querySelector('#fvMiniPayFeedback');
            function _setMiniPayFeedback(text, color) {
                if (!feedback) return;
                feedback.textContent = text || '';
                feedback.style.color = color || '#92400e';
            }

            function _fallbackCopy(text) {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.setAttribute('readonly', '');
                    ta.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
                    document.body.appendChild(ta);
                    ta.select();
                    ta.setSelectionRange(0, text.length);
                    const ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    return ok;
                } catch (_) { return false; }
            }
            if (copyBtn) {
                copyBtn.addEventListener('click', async () => {
                    let ok = false;
                    try {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(link);
                            ok = true;
                        }
                    } catch (_) { /* fall through to execCommand */ }
                    if (!ok) ok = _fallbackCopy(link);
                    if (ok) {
                        copyBtn.textContent = '✅ Copied';
                        // Feedback goes inside the card (setStatus would
                        // wipe the card's innerHTML — see note above).
                        _setMiniPayFeedback('Link copied — now leave MiniPay, open Chrome (or your preferred browser), and paste the link there to finish Face Verification.', '#15803d');
                        setTimeout(() => { copyBtn.textContent = '📋 Copy link'; }, 2500);
                    } else {
                        // Last-resort: expose the raw link inline so the user
                        // can long-press-select it manually.
                        if (preview) {
                            preview.style.whiteSpace = 'normal';
                            preview.style.wordBreak = 'break-all';
                            preview.textContent = link;
                        }
                        _setMiniPayFeedback('Could not copy automatically — long-press the link above to copy it manually.', '#d97706');
                    }
                });
            }
            if (forceBtn) {
                forceBtn.addEventListener('click', () => {
                    card.remove();
                    _miniPayFvForceTry = true;
                    window.location.href = link;
                });
            }
        }

        function startFV() {
            if (!window._fvGenerateLink) {
                setStatus('Wallet library loading — please wait a moment and try again.', '#d97706');
                return;
            }

            // Trust Wallet's mobile dApp browser silently drops personal_sign
            // responses — gate it behind an explicit user choice and steer
            // them to WalletConnect by default.
            if (typeof _isTrustWalletMobileContext === 'function'
                && _isTrustWalletMobileContext()
                && !PREFER_WC_SIGNING) {
                _showTrustWalletFvBlocker();
                return;
            }

            _startFvSigningFlow(false);
        }

        function _startFvSigningFlow(forcedFromTrust) {
            btn.disabled = true;
            icon.textContent = '⏳';
            label.textContent = 'Preparing verification…';
            setStatus(
                forcedFromTrust
                    ? 'Trying Trust Wallet in-app signing… if it hangs, log out and reconnect with WalletConnect.'
                    : 'Approve the Celo network switch (if prompted) and the signature request in your wallet.',
                forcedFromTrust ? '#d97706' : '#7c3aed'
            );

            // Some mobile dApp browsers (notably Trust Wallet builds) can
            // leave personal_sign promises pending after the user already taps
            // "Approve" — the wallet signs internally but never delivers the
            // signature back to the page. Surface a hint so users aren't
            // stuck on a generic "please approve" status forever.
            //
            // Trust Wallet is the most common culprit for this, so when we
            // can detect Trust Wallet mobile we surface a much more specific
            // notice sooner (12s vs 25s) that explicitly tells the user the
            // dApp browser is unreliable for Face Verification and recommends
            // reconnecting through WalletConnect instead.
            // Non-Trust wallets keep the original generic 25s hint so users
            // on e.g. desktop MetaMask aren't nagged early.
            const _isTrustCtx = typeof _isTrustWalletMobileContext === 'function'
                && _isTrustWalletMobileContext();
            let _fvSettled = false;
            const _fvHintTimer = setTimeout(() => {
                if (_fvSettled) return;
                const wrap = document.getElementById('ubiClaimStatus');
                if (_isTrustCtx) {
                    setStatus('Trust Wallet is not recommended for Face Verification — please follow the guidance below.', '#d97706');
                    if (!wrap || document.getElementById('fvTrustStuckNotice')) return;
                    const notice = document.createElement('div');
                    notice.id = 'fvTrustStuckNotice';
                    notice.style.cssText = 'margin-top:0.8rem;padding:0.95rem 1.1rem;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.45);border-radius:12px;color:#92400e;font-size:0.86rem;line-height:1.5;text-align:left;';
                    notice.innerHTML =
                        '<div style="font-weight:700;color:#fbbf24;margin-bottom:0.45rem;">⚠️ Trust Wallet is not recommended for Face Verification</div>' +
                        '<div style="margin-bottom:0.6rem;">Trust Wallet\'s in-app browser can sign you in and let you claim daily G$, but its Face Verification flow is unreliable — the wallet often signs the request but never delivers the signature back to this page, leaving you stuck on <em>"Preparing verification…"</em>.</div>' +
                        '<div style="margin-bottom:0.6rem;"><strong>Never share or enter your wallet recovery phrase or raw signing credentials on GoodMarket.</strong></div>' +
                        '<div style="margin-bottom:0.75rem;">Log out and reconnect here via <strong>WalletConnect</strong>. That routes the signature through Trust Wallet\'s main app (instead of the in-app browser), which also works reliably.</div>' +
                        '<a href="/logout" style="display:block;text-align:center;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;text-decoration:none;font-weight:600;padding:0.55rem 1rem;border-radius:10px;font-size:0.9rem;">🔐 Log out & reconnect via WalletConnect</a>';
                    wrap.appendChild(notice);
                    return;
                }
                setStatus('Still waiting on your wallet… If you already approved and nothing happened, your wallet may not be delivering the signature back to this page.', '#d97706');
                if (!wrap || document.getElementById('fvHangEscapeHatch')) return;
                const esc = document.createElement('div');
                esc.id = 'fvHangEscapeHatch';
                esc.style.cssText = 'margin-top:0.7rem;padding:0.75rem 1rem;background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.4);border-radius:10px;text-align:center;';
                esc.innerHTML =
                    '<div style="font-size:0.82rem;color:#6d28d9;margin-bottom:0.45rem;">Stuck? Reconnect via WalletConnect for a more reliable signing flow.</div>' +
                    '<a href="/logout" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;text-decoration:none;font-weight:600;padding:0.5rem 1rem;border-radius:8px;font-size:0.85rem;">🔐 Log out & switch to WalletConnect</a>';
                wrap.appendChild(esc);
            }, _isTrustCtx ? 12000 : 25000);

            window._fvGenerateLink(WALLET)
                .then(link => {
                    _fvSettled = true;
                    clearTimeout(_fvHintTimer);
                    // MiniPay's in-app WebView consistently fails the FaceTec
                    // scan — redirect the user to their phone's native
                    // browser instead (the fvsig-embedded link does not
                    // require any further signing, so no re-connect is
                    // needed). Escape hatch via "Try inside MiniPay anyway"
                    // sets _miniPayFvForceTry and re-enters this path.
                    if (!_miniPayFvForceTry && typeof _isMiniPay === 'function' && _isMiniPay()) {
                        _showMiniPayFvHandoff(link);
                        return;
                    }
                    window.location.href = link;
                })
                .catch(err => {
                    _fvSettled = true;
                    clearTimeout(_fvHintTimer);
                    btn.disabled = false;
                    icon.textContent = '🪪';
                    label.textContent = 'Verify Face ID to Claim';
                    const code = err && err.code;
                    if (code === 4001 || code === 5000) setStatus('Signature cancelled.', 'var(--red)');
                    else setStatus('Error: ' + ((err && err.message) || 'Could not start verification'), 'var(--red)');
                });
        }

        async function ensureGasAndClaim() {
            throw new Error('Server signing is disabled. Please use your injected wallet / WalletConnect.');
        }

        function setClaimGasUiState(stage) {
            const stateMap = {
                checking_balance: {
                    label: 'Checking wallet gas…',
                    icon: '🔎',
                    status: 'Checking wallet gas…',
                    color: 'var(--text-dim)'
                },
                requesting_faucet: {
                    label: 'Requesting faucet top-up…',
                    icon: '🚰',
                    status: 'Requesting faucet top-up…',
                    color: '#60a5fa'
                },
                waiting_credit: {
                    label: 'Waiting for gas to arrive…',
                    icon: '⏳',
                    status: 'Waiting for gas to arrive…',
                    color: '#34d399'
                },
                gas_ready: {
                    label: 'Gas ready',
                    icon: '✅',
                    status: 'Gas ready',
                    color: '#22c55e'
                },
                approve_wallet: {
                    label: 'Approve in wallet',
                    icon: '🪙',
                    status: 'Approve claim in wallet…',
                    color: 'var(--text-dim)'
                }
            };
            const state = stateMap[stage];
            if (!state) return;
            label.textContent = state.label;
            icon.textContent = state.icon;
            setStatus(state.status, state.color);
        }

        // CELO gas threshold — must stay in sync with backend _get_gas_status().
        // Required = max(estimated_gas * gas_price * FAUCET_BUFFER, CELO_GAS_MIN_FLOOR_WEI).
        // Floor set to 0.15 CELO so wallets that report a low eth_gasPrice
        // (Trust Wallet over forno, WalletConnect bridges, etc.) don't false-pass
        // when the actual claim transaction costs ~0.07–0.13 CELO during
        // congestion. Raised from 0.1 to 0.15 to fix WalletConnect users issue
        // where wallet apps set wrong gas parameters causing tx cost ~0.127 CELO.
        // Stays in sync with the backend FAUCET_MIN_CELO default in routes.py.
        // The dynamic component still overrides it during gas spikes (e.g. 200+ gwei)
        // so high-congestion claims trigger faucet requests even at higher balances.
        const CELO_GAS_MIN_FLOOR_WEI = 150000000000000000n; // 0.15 CELO floor (raised from 0.1)
        const CELO_GAS_BUFFER_NUMERATOR = 135n;   // 1.35x buffer (matches FAUCET_BUFFER_MULTIPLIER)
        const CELO_GAS_BUFFER_DENOMINATOR = 100n;
        const CELO_FALLBACK_CLAIM_GAS = 220000n;
        const CELO_FALLBACK_GAS_PRICE_WEI = 50000000000n; // 50 gwei

        async function getProviderGasSnapshot(provider) {
            // Dynamic readiness check: balance must cover the actual cost of
            // the next claim() at the current network gas price (with a buffer),
            // never below the FAUCET_MIN_CELO floor.
            //
            // We try eth_estimateGas first, but fall back to a hardcoded gas
            // amount on revert (e.g., user already claimed today, or any
            // non-gas precondition) so we don't false-fail readiness for
            // reasons unrelated to gas. Same approach the backend uses.
            //
            // The injected wallet routes RPC through whatever Celo RPC it has
            // configured (typically forno.celo.org). When rate-limited /
            // behind Cloudflare it can return HTML, which surfaces as
            // "Unexpected token '<'". Retry once on transient parser errors.
            const isWcShim = provider instanceof WCClaimShim;
            console.log('[getProviderGasSnapshot] Provider type:', isWcShim ? 'WCClaimShim' : typeof provider);
            
            const snapshot = async () => {
                const balanceHex = await provider.request({
                    method: 'eth_getBalance',
                    params: [WALLET, 'latest']
                });
                const balance = BigInt(balanceHex);

                // Current network gas price (dynamic — Celo can spike during peak).
                let gasPrice = CELO_FALLBACK_GAS_PRICE_WEI;
                try {
                    const gasPriceHex = await provider.request({
                        method: 'eth_gasPrice',
                        params: []
                    });
                    const parsed = BigInt(gasPriceHex);
                    if (parsed > 0n) gasPrice = parsed;
                } catch (_) {
                    // Keep fallback gas price.
                }

                // Estimate gas for the actual claim() call. Fall back if the
                // RPC reverts (already-claimed, etc.) so we don't false-fail.
                let gasEstimate = CELO_FALLBACK_CLAIM_GAS;
                try {
                    const estHex = await provider.request({
                        method: 'eth_estimateGas',
                        params: [{
                            from: WALLET,
                            to: UBI_CONTRACT,
                            data: CLAIM_DATA,
                            value: '0x0'
                        }]
                    });
                    const parsedEst = BigInt(estHex);
                    if (parsedEst > 0n) gasEstimate = parsedEst;
                } catch (_) {
                    // Keep fallback gas estimate.
                }

                const dynamicRequired =
                    (gasEstimate * gasPrice * CELO_GAS_BUFFER_NUMERATOR) /
                    CELO_GAS_BUFFER_DENOMINATOR;
                const required = dynamicRequired > CELO_GAS_MIN_FLOOR_WEI
                    ? dynamicRequired
                    : CELO_GAS_MIN_FLOOR_WEI;

                return {
                    balance,
                    required,
                    gasReady: balance >= required,
                };
            };
            try {
                return await snapshot();
            } catch (e1) {
                if (!_isRpcHtmlError(e1)) throw e1;
                await new Promise(r => setTimeout(r, 2500));
                return await snapshot();
            }
        }

        async function pollForGasArrival(maxDurationMs = 180000) {
            const correlationId = window.__claimFaucetCorrelationId || `claim-${Date.now().toString(36)}`;
            const startedAt = Date.now();
            const backoffSchedule = [3000, 5000, 7000, 9000, 11000, 13000, 15000, 18000, 22000, 26000];
            let attempt = 0;

            while ((Date.now() - startedAt) < maxDurationMs) {
                const delay = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt += 1;

                let statusData;
                try {
                    statusData = await _safeFetchJson('/api/faucet/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                        body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId })
                    });
                } catch (fetchErr) {
                    if (_isRpcHtmlError(fetchErr)) {
                        // Transient upstream HTML page — try again next tick.
                        setClaimGasUiState('waiting_credit');
                        continue;
                    }
                    throw fetchErr;
                }
                if (statusData.success && statusData.gas_ready) {
                    return { gasReady: true, statusData };
                }
                if (statusData.success && statusData.status === 'recent_refill' && !statusData.gas_ready) {
                    const cooldown = Number(statusData.recent_refill_cooldown_seconds || 0);
                    return {
                        gasReady: false,
                        stopPolling: true,
                        error: `Gas top-up blocked by cooldown (${cooldown}s remaining). Please wait, then retry.`
                    };
                }
                setClaimGasUiState('waiting_credit');
            }
            return {
                gasReady: false,
                stopPolling: true,
                error: 'Gas did not arrive after extended checks (~3 minutes). Please contact support with your wallet address and faucet debug details.'
            };
        }

        async function ensureGasReadyBeforeClaim(options = {}) {
            const forceOnchain = !!options.forceOnchain;
            const correlationId = `claim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            window.__claimFaucetCorrelationId = correlationId;
            setClaimGasUiState('checking_balance');

            const statusData = await _safeFetchJson('/api/faucet/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId })
            });
            if (!statusData.success) {
                throw new Error(statusData.error || 'Unable to check wallet gas.');
            }
            if (statusData.gas_ready) {
                setClaimGasUiState('gas_ready');
                return { gasReady: true, toppedUp: false, source: 'wallet_balance' };
            }

            const requestFaucetGas = async (forceFlag) => {
                const gasData = await _safeFetchJson('/api/faucet/gas', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                    body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId, force_onchain: !!forceFlag })
                });
                return {
                    gasData,
                    terminal: gasData.terminal_status || gasData.status
                };
            };

            setClaimGasUiState('requesting_faucet');
            let { gasData, terminal } = await requestFaucetGas(forceOnchain);

            if (window.GMGasCoverageBanner && gasData && gasData.show_gas_coverage_message) {
                try { window.GMGasCoverageBanner.maybeShow(gasData, { wallet: WALLET }); } catch (_) {}
            }

            // 48h GoodDollar cooldown: explain the 3-day coverage rule and
            // surface the remaining lockout. Same banner copy as the success
            // path so users understand WHY the request was refused.
            if (terminal === 'gooddollar_cooldown') {
                const remainingHours = Math.max(
                    1,
                    Math.round(Number(gasData.gooddollar_cooldown_remaining_seconds || 0) / 3600)
                );
                const errorMsg = (gasData.reason || gasData.error ||
                    `GoodDollar already provided gas to this wallet. Please wait ~${remainingHours}h before requesting more gas.`);
                if (window.GMGasCoverageBanner) {
                    try {
                        window.GMGasCoverageBanner.maybeShow(
                            { ...gasData, show_gas_coverage_message: true },
                            { wallet: WALLET }
                        );
                    } catch (_) {}
                }
                throw new Error(errorMsg);
            }

            // Cooldown blocked: show error with countdown timer and let user retry manually
            if (terminal === 'recent_refill' && !gasData.gas_ready) {
                const cooldownSeconds = Number(gasData.recent_refill_cooldown_seconds || 0);
                const errorMsg = `Gas refill cooldown active. Please wait ${cooldownSeconds}s before retrying. If this keeps happening, contact support.`;
                
                // Show countdown in UI if error panel exists
                if (window.appendStatusLine) {
                    appendStatusLine(`Cooldown: ${cooldownSeconds}s remaining`);
                    // Start countdown timer
                    let remaining = cooldownSeconds;
                    const countdownInterval = setInterval(() => {
                        remaining--;
                        if (remaining > 0) {
                            appendStatusLine(`Cooldown: ${remaining}s remaining`, true);
                        } else {
                            clearInterval(countdownInterval);
                            appendStatusLine('Cooldown expired. You can retry now.', true);
                        }
                    }, 1000);
                }
                
                throw new Error(errorMsg);
            }

            if (
                (terminal === 'onchain_failed' || terminal === 'not_configured' || terminal === 'api_failed') &&
                !gasData.gas_ready
            ) {
                throw new Error(
                    `${gasData.error || gasData.reason || 'Gas top-up failed.'} Please retry shortly or contact support with your wallet and faucet debug values.`
                );
            }

            const postFaucet = await pollForGasArrival(180000);
            if (postFaucet && postFaucet.gasReady) {
                setClaimGasUiState('gas_ready');
                return { gasReady: true, toppedUp: true, source: gasData.topup_source || 'faucet' };
            }
            throw new Error((postFaucet && postFaucet.error) || 'Gas top-up did not arrive in time. Please retry in a few minutes.');
        }

        // ---------------------------------------------------------------
        // XDC gas top-up helpers — XDC equivalents of the working Celo
        // helpers above. The unified claim flow now calls these before
        // claimXdcInjected() so users no longer have to detour through the
        // standalone xdc_wallet.html page just to top up XDC gas.
        //
        // We deliberately reuse the SAME UI state machine (setClaimGasUiState),
        // status panel (appendStatusLine), and HTML-error sniffers
        // (_isXdcRpcHtmlError) to keep UX consistent with the Celo path.
        //
        // Note: there is no /api/xdc/faucet/status endpoint, so we re-poll
        // /api/xdc/faucet/gas with force_onchain:false instead — the backend
        // short-circuits when gas is already credited so this is cheap.
        // ---------------------------------------------------------------
        async function pollForXdcGasArrival(maxDurationMs = 150000) {
            const correlationId = window.__claimXdcFaucetCorrelationId || `xdcclaim-${Date.now().toString(36)}`;
            const startedAt = Date.now();
            const backoffSchedule = [3000, 5000, 7000, 9000, 11000, 13000, 15000];
            let attempt = 0;

            while ((Date.now() - startedAt) < maxDurationMs) {
                const delay = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt += 1;

                let statusData;
                try {
                    statusData = await _safeFetchJson('/api/xdc/faucet/gas', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                        body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId, force_onchain: false })
                    });
                } catch (fetchErr) {
                    if (_isXdcRpcHtmlError(fetchErr)) {
                        setClaimGasUiState('waiting_credit');
                        continue;
                    }
                    throw fetchErr;
                }
                if (statusData.success && statusData.gas_ready) {
                    return { gasReady: true, statusData };
                }
                if (statusData.success && statusData.status === 'recent_refill' && !statusData.gas_ready) {
                    const cooldown = Number(statusData.recent_refill_cooldown_seconds || 0);
                    return {
                        gasReady: false,
                        stopPolling: true,
                        error: `XDC gas refill cooldown active (${cooldown}s remaining). Please wait and retry.`
                    };
                }
                setClaimGasUiState('waiting_credit');
            }
            return {
                gasReady: false,
                stopPolling: true,
                error: 'XDC gas did not arrive after extended checks. Please retry in a minute.'
            };
        }

        async function ensureXdcGasReadyBeforeClaim(options = {}) {
            const forceOnchain = !!options.forceOnchain;
            const correlationId = `xdcclaim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            window.__claimXdcFaucetCorrelationId = correlationId;
            setClaimGasUiState('checking_balance');

            // /api/xdc/faucet/gas is a single endpoint that performs both
            // check + top-up (it short-circuits when gas is already ready),
            // so we don't need a separate /status pre-flight like Celo.
            const requestXdcFaucetGas = async (forceFlag) => {
                const gasData = await _safeFetchJson('/api/xdc/faucet/gas', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                    body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId, force_onchain: !!forceFlag })
                });
                return {
                    gasData,
                    terminal: gasData.terminal_status || gasData.status
                };
            };

            setClaimGasUiState('requesting_faucet');
            let { gasData, terminal } = await requestXdcFaucetGas(forceOnchain);

            // Gas already credited (either before our call or after API top-up
            // inside the same request). Mirror of Celo behavior.
            if (gasData.gas_ready) {
                setClaimGasUiState('gas_ready');
                // Wait for wallet RPC to sync with on-chain balance
                await new Promise(r => setTimeout(r, 3000));
                return {
                    gasReady: true,
                    toppedUp: !!gasData.topped_up,
                    source: gasData.topup_source || 'wallet_balance'
                };
            }

            // Cooldown blocked: show error with countdown timer and let user retry manually
            if (terminal === 'recent_refill' && !gasData.gas_ready) {
                const cooldownSeconds = Number(gasData.recent_refill_cooldown_seconds || 0);
                const errorMsg = `XDC gas refill cooldown active. Please wait ${cooldownSeconds}s before retrying.`;
                
                // Show countdown in UI if error panel exists
                if (window.appendStatusLine) {
                    appendStatusLine(`Cooldown: ${cooldownSeconds}s remaining`);
                    // Start countdown timer
                    let remaining = cooldownSeconds;
                    const countdownInterval = setInterval(() => {
                        remaining--;
                        if (remaining > 0) {
                            appendStatusLine(`Cooldown: ${remaining}s remaining`, true);
                        } else {
                            clearInterval(countdownInterval);
                            appendStatusLine('Cooldown expired. You can retry now.', true);
                        }
                    }, 1000);
                }
                
                throw new Error(errorMsg);
            }

            if (
                (terminal === 'onchain_failed' || terminal === 'not_configured' || terminal === 'api_failed') &&
                !gasData.gas_ready
            ) {
                throw new Error(
                    `${gasData.error || gasData.reason || 'XDC gas top-up failed.'} Please retry shortly.`
                );
            }

            // Backend acknowledged the top-up but the wallet's balance has not
            // yet caught up on-chain (api_accepted_pending or topped_up:true
            // without gas_ready). Poll the gas endpoint until it confirms.
            const postFaucet = await pollForXdcGasArrival(150000);
            if (postFaucet && postFaucet.gasReady) {
                setClaimGasUiState('gas_ready');
                // Wait for wallet RPC to sync with on-chain balance before proceeding
                await new Promise(r => setTimeout(r, 3000));
                return { gasReady: true, toppedUp: true, source: gasData.topup_source || 'faucet' };
            }
            throw new Error((postFaucet && postFaucet.error) || 'XDC gas top-up did not arrive in time. Please retry shortly.');
        }

        async function pollForFuseGasArrival(maxDurationMs = 150000) {
            const correlationId = window.__claimFuseFaucetCorrelationId || `fuseclaim-${Date.now().toString(36)}`;
            const startedAt = Date.now();
            const backoffSchedule = [3000, 5000, 7000, 9000, 11000, 13000, 15000];
            let attempt = 0;

            while ((Date.now() - startedAt) < maxDurationMs) {
                const delay = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt += 1;

                let statusData;
                try {
                    statusData = await _safeFetchJson('/api/fuse/faucet/gas', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                        body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId, force_onchain: false })
                    });
                } catch (fetchErr) {
                    if (_isXdcRpcHtmlError(fetchErr)) {
                        setClaimGasUiState('waiting_credit');
                        continue;
                    }
                    throw fetchErr;
                }
                if (statusData.success && statusData.gas_ready) {
                    return { gasReady: true, statusData };
                }
                if (statusData.success && statusData.status === 'recent_refill' && !statusData.gas_ready) {
                    const cooldown = Number(statusData.recent_refill_cooldown_seconds || 0);
                    return {
                        gasReady: false,
                        stopPolling: true,
                        error: `Fuse gas refill cooldown active (${cooldown}s remaining). Please wait and retry.`
                    };
                }
                setClaimGasUiState('waiting_credit');
            }
            return {
                gasReady: false,
                stopPolling: true,
                error: 'Fuse gas did not arrive after extended checks. Please retry in a minute.'
            };
        }

        async function ensureFuseGasReadyBeforeClaim(options = {}) {
            const forceOnchain = !!options.forceOnchain;
            const correlationId = `fuseclaim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            window.__claimFuseFaucetCorrelationId = correlationId;
            setClaimGasUiState('checking_balance');

            const requestFuseFaucetGas = async (forceFlag) => {
                const gasData = await _safeFetchJson('/api/fuse/faucet/gas', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId },
                    body: JSON.stringify({ wallet: WALLET, correlation_id: correlationId, force_onchain: !!forceFlag })
                });
                return {
                    gasData,
                    terminal: gasData.terminal_status || gasData.status
                };
            };

            setClaimGasUiState('requesting_faucet');
            let { gasData, terminal } = await requestFuseFaucetGas(forceOnchain);

            if (gasData.gas_ready) {
                setClaimGasUiState('gas_ready');
                return {
                    gasReady: true,
                    toppedUp: !!gasData.topped_up,
                    source: gasData.topup_source || 'wallet_balance'
                };
            }

            if (terminal === 'recent_refill' && !gasData.gas_ready) {
                const cooldownSeconds = Number(gasData.recent_refill_cooldown_seconds || 0);
                const errorMsg = `Fuse gas refill cooldown active. Please wait ${cooldownSeconds}s before retrying.`;

                if (window.appendStatusLine) {
                    appendStatusLine(`Cooldown: ${cooldownSeconds}s remaining`);
                    let remaining = cooldownSeconds;
                    const countdownInterval = setInterval(() => {
                        remaining--;
                        if (remaining > 0) {
                            appendStatusLine(`Cooldown: ${remaining}s remaining`, true);
                        } else {
                            clearInterval(countdownInterval);
                            appendStatusLine('Cooldown expired. You can retry now.', true);
                        }
                    }, 1000);
                }

                throw new Error(errorMsg);
            }

            if (terminal === 'faucet_not_eligible' && !gasData.gas_ready) {
                throw new Error(
                    gasData.error || 'GoodDollar Fuse faucet is not serving this wallet right now. Please try again later.'
                );
            }

            if (
                (terminal === 'onchain_failed' || terminal === 'not_configured' || terminal === 'api_failed') &&
                !gasData.gas_ready
            ) {
                throw new Error(
                    `${gasData.error || gasData.reason || 'Fuse gas top-up failed.'} Please retry shortly.`
                );
            }

            const postFaucet = await pollForFuseGasArrival(150000);
            if (postFaucet && postFaucet.gasReady) {
                setClaimGasUiState('gas_ready');
                return { gasReady: true, toppedUp: true, source: gasData.topup_source || 'faucet' };
            }
            throw new Error((postFaucet && postFaucet.error) || 'Fuse gas top-up did not arrive in time. Please retry shortly.');
        }

        async function ensureInjectedWalletClaim() {
            const isInsufficientFundsError = (err) => {
                const raw = String(
                    (err && (err.shortMessage || err.message || err?.data?.message || err?.error?.message)) || ''
                ).toLowerCase();
                return raw.includes('insufficient funds') || raw.includes('code -32000') || raw.includes('overshot');
            };

            const sendClaimTransaction = async (provider, from) => {
                setClaimGasUiState('approve_wallet');

                // MiniPay CIP-64: try feeCurrency options for gas abstraction.
                if (_isMiniPayProvider(provider)) {
                    let gasHex;
                    try {
                        const est = await provider.request({
                            method: 'eth_estimateGas',
                            params: [{ from, to: UBI_CONTRACT, data: CLAIM_DATA, value: '0x0' }],
                        });
                        const estimated = typeof est === 'string' ? BigInt(est) : BigInt(Number(est));
                        gasHex = '0x' + (estimated * 140n / 100n).toString(16);
                    } catch (_) {
                        gasHex = '0x7A120';
                    }

                    // Use the shared MiniPay fee-currency helper here too, not only
                    // the generic send flow. It reads live cUSD/USDT/USDC balances
                    // from the active provider and orders explicit feeCurrency
                    // fallbacks by what the wallet actually has while keeping the
                    // native CELO fallback disabled for MiniPay claims.
                    const feeCurrencies = await _miniPayStableFeeCurrenciesForSend(provider, from);
                    let lastErr;
                    for (const fc of feeCurrencies) {
                        const txParams = { from, to: UBI_CONTRACT, data: CLAIM_DATA, value: '0x0', gas: gasHex };
                        txParams.feeCurrency = fc;
                        try {
                            const txHash = await provider.request({
                                method: 'eth_sendTransaction',
                                params: [txParams],
                            });
                            return txHash;
                        } catch (err) {
                            lastErr = err;
                            const code = err && err.code;
                            const msg = ((err && (err.message || err.data && err.data.message)) || '').toLowerCase();
                            if (code === 4001 || /reject|denied by user|user denied/i.test(msg)) throw err;
                            if (/revert/i.test(msg)) throw err;
                            console.warn('[MiniPay] claim tx attempt failed with feeCurrency=' + fc + ':', msg || err);
                        }
                    }
                    if (_isRpcMethodNotWhitelistedError(lastErr)) {
                        console.warn('[MiniPay] feeCurrency claim rejected as non-whitelisted; retrying plain Celo tx');
                        return provider.request({
                            method: 'eth_sendTransaction',
                            params: [{ from, to: UBI_CONTRACT, data: CLAIM_DATA, value: '0x0', gas: gasHex }],
                        });
                    }
                    throw lastErr || new Error('MiniPay claim transaction failed.');
                }

                return provider.request({
                    method: 'eth_sendTransaction',
                    params: [{ from, to: UBI_CONTRACT, data: CLAIM_DATA, value: '0x0' }]
                });
            };

            // Local self-custodial accounts: use the in-app wallet (already
            // PIN-unlocked by doUbiClaim) for the gas preflight too, so no
            // injected MetaMask on a different account is ever probed.
            const isLocalClaimLogin = (LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined';
            let provider = isLocalClaimLogin ? GMLocalWallet.getProvider() : await _vAwaitEthProvider();
            let usingWcBridge = false;
            if (!provider) {
                provider = await _walletGetWcProviderIfPreferred();
                usingWcBridge = !!provider;
            } else if (!isLocalClaimLogin && typeof GMWalletConnect !== 'undefined' && GMWalletConnect.isPreferred()) {
                // User logged in via WalletConnect but an injected wallet (e.g. MetaMask
                // browser extension) was also detected. MetaMask is on a different network
                // (Ethereum, not Celo) and may be locked — its eth_getBalance call will
                // either return 0 or hang forever, leaving the UI stuck at "Checking
                // wallet gas…". Override: use the WC bridge so the gas check goes through
                // the backend faucet API instead of the injected wallet's broken RPC.
                const wcProvider = await _walletGetWcProviderIfPreferred();
                if (wcProvider) {
                    console.log('[claim] WC login + injected wallet found — overriding with WC bridge for gas check');
                    provider = wcProvider;
                    usingWcBridge = true;
                }
            }
            if (!provider) {
                setStatus('⚠️ No wallet detected. Please open this page in MetaMask, Trust Wallet, MiniPay, or reconnect using WalletConnect to sign transactions.', '#d97706');
                return;
            }

            btn.disabled = true;
            setClaimGasUiState('checking_balance');

            try {
                // MiniPay's CELO/cUSD pre-flight is handled before this
                // function by MPGasTopUp.ensureToppedUp(). The WalletConnect
                // bridge does — its users were previously getting a misleading
                // "Gas ready" UI even when their CELO balance was below the
                // claim threshold (e.g. 0.06 CELO when 0.1 CELO was required),
                // because we were short-circuiting the preflight here. Now WC
                // runs the same server-side faucet preflight as injected
                // wallets — /api/faucet/status + /api/faucet/gas use the
                // backend's own Celo RPC, so they work regardless of which
                // provider the user signed in with.
                const isMiniPayClaim = _isMiniPayProvider(provider);
                const isMiniPayContext = isMiniPayClaim || _isMiniPay();
                // Set to true whenever the backend faucet API is consulted for this
                // attempt. The final wallet-side gas snapshot is skipped in that case
                // because the frontend floor (0.15 CELO) is higher than the backend
                // floor (0.1 CELO) — that mismatch causes a false "not ready" reading
                // that triggers a needless 15-second propagation retry loop and leaves
                // the UI stuck at "Checking wallet gas…" for WalletConnect users.
                let gasCheckedByBackend = false;

                if (isMiniPayContext) {
                    // MiniPay and Privy Connect Wallet inside MiniPay both pay Celo
                    // gas from stablecoins (cUSD/USDT/USDC). Run the shared stablecoin
                    // pre-flight for any MiniPay context, including Privy providers that
                    // do not expose provider.isMiniPay. Wallets with >= 0.015 total
                    // stablecoin skip the faucet; wallets below that request GoodMarket
                    // cUSD before claim approval, then still offer the CELO -> cUSD
                    // auto-swap prompt when the wallet has spendable CELO.
                    if (window.MPGasTopUp && window.MPGasTopUp.ensureToppedUp) {
                        const r = await window.MPGasTopUp.ensureToppedUp(WALLET, {
                            provider: provider,
                            forceMiniPayContext: true,
                        });
                        if (!r || !r.proceed) {
                            if (r && r.cooldown) {
                                const human = r.cooldownSeconds ? Math.ceil(r.cooldownSeconds / 3600) + ' hours' : 'some time';
                                throw new Error('⏳ The GoodMarket cUSD faucet is on cooldown. Please wait ~' + human + ' or add cUSD / USDT / USDC manually.');
                            }
                            if (r && r.cancelled) throw new Error('❌ Gas top-up was cancelled. Please try again.');
                            throw new Error('❌ MiniPay stablecoin gas top-up did not complete. ' + (r && r.error ? r.error : 'Please try again.'));
                        }
                    }
                    setClaimGasUiState('gas_ready');
                } else if (usingWcBridge) {
                    // WalletConnect bridge: skip the wallet-side balance
                    // snapshot (the bridge uses the dApp's RPC anyway, not
                    // the user's wallet RPC) and rely on the server faucet
                    // flow to check + top up gas. Mirrors what the injected
                    // path falls back to when its local snapshot is short.
                    setStatus('Checking wallet gas…', 'var(--text-dim)');
                    await ensureGasReadyBeforeClaim();
                    gasCheckedByBackend = true;
                } else {
                    // Secondary MiniPay check: even if _isMiniPay() returned false earlier
                    // (due to late provider injection), re-check now that we have a provider.
                    const lateDetectedMiniPay = provider && provider.isMiniPay;
                    if (lateDetectedMiniPay) {
                        console.warn('[claim] Late MiniPay detection - proceeding directly');
                        if (window.MPGasTopUp && window.MPGasTopUp.setMiniPayDetected) {
                            window.MPGasTopUp.setMiniPayDetected();
                        }
                        setClaimGasUiState('gas_ready');
                    } else {
                        let gasSnap = null;
                        try {
                            gasSnap = await getProviderGasSnapshot(provider);
                        } catch (providerGasErr) {
                            // An injected wallet's RPC is only an optimization for the
                            // pre-flight. Trust Wallet and other mobile dApp browsers can
                            // return HTTP 401/403 (or reject eth_getBalance entirely)
                            // even though the authenticated GoodMarket backend RPC is
                            // healthy. Do not abort before the faucet gets a chance to
                            // run: the backend status + gas endpoints perform the same
                            // balance check and route GoodDollar first, followed by the
                            // TOPWALLET_KEY on-chain fallback.
                            console.warn('[claim] injected wallet gas probe failed; using backend faucet preflight:', providerGasErr);
                        }
                        if (!gasSnap || !gasSnap.gasReady) {
                            setStatus('Checking wallet gas…', 'var(--text-dim)');
                            await ensureGasReadyBeforeClaim();
                            gasCheckedByBackend = true;
                        } else {
                            setClaimGasUiState('gas_ready');
                        }
                    }
                }

                setStatus('Gas ready. Connecting to wallet…', 'var(--text-dim)');

                // Use getClaimSigner which prioritizes WC session like savings/swap
                // This ensures WC users use their existing session instead of injected provider
                console.log('[ensureInjectedWalletClaim] Getting signer for claim...');
                const signer = await getClaimSigner();
                console.log('[ensureInjectedWalletClaim] Got signer:', {
                    type: signer instanceof WCClaimShim ? 'WCClaimShim' : 'Injected',
                    hasRequest: typeof signer.request === 'function',
                    hasGetAddress: typeof signer.getAddress === 'function',
                    signerKeys: Object.keys(signer)
                });
                
                // Get the 'from' address from the signer
                let from;
                if (typeof signer.getAddress === 'function') {
                    from = await signer.getAddress();
                } else if (typeof signer.request === 'function') {
                    const accounts = await signer.request({ method: 'eth_accounts' });
                    from = (accounts && accounts[0]) || '';
                } else {
                    from = signer._account || signer.from || '';
                }
                
                console.log('[ensureInjectedWalletClaim] From address:', from);
                
                if (!from || from.toLowerCase() !== WALLET.toLowerCase()) {
                    throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
                }

                // Update provider reference to use the signer for the claim transaction
                // This ensures WC users use the WCClaimShim for signing
                provider = signer;
                
                // Log the provider type for debugging
                console.log('[ensureInjectedWalletClaim] Final provider type:', provider instanceof WCClaimShim ? 'WCClaimShim' : 'Injected');

                // Preflight one more time right before sending tx because gas price can spike.
                // MiniPay already ran its CELO/cUSD helper and pays tx gas with stablecoins.
                // Skip when the backend faucet was already consulted (gasCheckedByBackend): the
                // frontend floor (0.15 CELO) is higher than the backend floor (0.1 CELO), so
                // re-reading from the provider would falsely report "not ready" for wallets with
                // 0.10–0.15 CELO and trigger a needless 15-second retry loop — the visible
                // "stuck at Checking wallet gas…" symptom for WalletConnect desktop users.
                // This covers BOTH the usingWcBridge path (no MetaMask) AND the injected-
                // MetaMask-as-initial-provider path (MetaMask on wrong network → 0 CELO read
                // → backend faucet called → signer reassigned to WCClaimShim).
                if (!isMiniPayClaim && !gasCheckedByBackend) {
                    let finalGasSnap = await getProviderGasSnapshot(provider);
                    if (!finalGasSnap.gasReady) {
                        setStatus('Gas changed while preparing tx. Retrying faucet top-up…', 'var(--text-dim)');
                        await ensureGasReadyBeforeClaim();

                        // The backend faucet uses its own reliable RPC and has already
                        // confirmed gas arrived on-chain. However, the *injected wallet's*
                        // RPC (e.g. MetaMask/Trust Wallet's connection to forno.celo.org)
                        // can lag behind by several seconds due to eventual consistency
                        // across RPC nodes — it may still report a stale low balance even
                        // though the top-up tx is already confirmed. Retry the wallet-side
                        // snapshot a few times with progressive delays to let its RPC catch
                        // up before failing the claim.
                        const RPC_PROPAGATION_DELAYS_MS = [1500, 2500, 4000, 6000];
                        let propagated = false;
                        finalGasSnap = await getProviderGasSnapshot(provider);
                        if (finalGasSnap.gasReady) {
                            propagated = true;
                        } else {
                            for (const delay of RPC_PROPAGATION_DELAYS_MS) {
                                setStatus('Gas top-up confirmed on-chain. Waiting for wallet RPC to sync…', 'var(--text-dim)');
                                await new Promise(r => setTimeout(r, delay));
                                finalGasSnap = await getProviderGasSnapshot(provider);
                                if (finalGasSnap.gasReady) {
                                    propagated = true;
                                    break;
                                }
                            }
                        }

                        if (!propagated) {
                            // Wallet RPC still shows stale balance. Trust the backend's
                            // gas_ready signal as a tiebreaker — if the backend (using a
                            // reliable RPC) confirms gas is ready, allow the claim to
                            // proceed. The wallet will fetch a fresh balance when it
                            // actually broadcasts the tx, and any *genuine*
                            // insufficient-funds error at send time is already handled
                            // by the catch block below (line ~3711) which re-runs the
                            // faucet fallback once and retries the send.
                            let backendConfirmsGas = false;
                            try {
                                const correlationId =
                                    window.__claimFaucetCorrelationId ||
                                    `claim-${Date.now().toString(36)}`;
                                const backendStatus = await _safeFetchJson('/api/faucet/status', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'X-Correlation-ID': correlationId,
                                    },
                                    body: JSON.stringify({
                                        wallet: WALLET,
                                        correlation_id: correlationId,
                                    }),
                                });
                                backendConfirmsGas = !!(
                                    backendStatus &&
                                    backendStatus.success &&
                                    backendStatus.gas_ready
                                );
                            } catch (statusErr) {
                                console.warn('[claim] backend gas_ready re-check failed:', statusErr);
                            }

                            if (backendConfirmsGas) {
                                setStatus('Gas confirmed by faucet. Proceeding with claim…', 'var(--text-dim)');
                                setClaimGasUiState('gas_ready');
                            } else {
                                throw new Error('Wallet still lacks CELO gas after top-up retry. Please retry in a minute.');
                            }
                        }
                    }
                }

                // Standard (non-MiniPay) Celo claim now uses claimCeloInjected,
                // which mirrors claimXdcInjected exactly (chain switch with
                // multi-RPC, no chainId in tx params, one-shot retry on
                // transient HTML/parser errors). MiniPay still uses the
                // CIP-64 feeCurrency loop in sendClaimTransaction.
                const sendCeloClaim = async () => {
                    if (isMiniPayClaim) {
                        try {
                            return await sendClaimTransaction(provider, from);
                        } catch (e1) {
                            if (_isUserRejectedError(e1)) throw e1;
                            if (!_isRpcHtmlError(e1)) throw e1;
                            await new Promise(r => setTimeout(r, 3500));
                            return await sendClaimTransaction(provider, from);
                        }
                    }
                    setClaimGasUiState('approve_wallet');
                    return await claimCeloInjected(provider, from);
                };

                let txHash;
                try {
                    txHash = await sendCeloClaim();
                } catch (sendErr) {
                    if (!isInsufficientFundsError(sendErr)) throw sendErr;
                    if (isMiniPayContext) {
                        // GoodDapp-style: direct claim failed with insufficient gas.
                        // Show new UX messages and run the faucet + swap flow.
                        console.warn('[claim] MiniPay direct claim failed (insufficient gas). Running faucet + swap flow...');

                        // Step 1: Show message about insufficient gas and starting CELO faucet
                        setStatus('⚠️ Insufficient stablecoin for gas. We\'re topping up your CELO from GoodDollar...', '#d97706');

                        if (window.MPGasTopUp && window.MPGasTopUp.ensureToppedUp) {
                            try {
                                // Step 2: Run the full ensureToppedUp flow which includes:
                                // - CELO faucet from GoodDollar
                                // - cUSD faucet from GoodMarket
                                // - CELO → cUSD swap
                                const r = await window.MPGasTopUp.ensureToppedUp(WALLET, { provider: provider, forceMiniPayContext: true });

                                if (!r || !r.proceed) {
                                    // Handle faucet failure scenarios
                                    if (r && r.cooldown) {
                                        const human = r.cooldownSeconds ? Math.ceil(r.cooldownSeconds / 3600) + ' hours' : 'some time';
                                        throw new Error('⏳ The GoodDollar CELO faucet is on cooldown. Please wait ~' + human + ' or add stablecoin to your wallet manually.');
                                    } else if (r && r.insufficientGas) {
                                        throw new Error('❌ Your MiniPay wallet has no stablecoin and no CELO to swap. Please add funds to your wallet.');
                                    } else if (r && r.cancelled) {
                                        throw new Error('❌ Gas top-up was cancelled. Please try again.');
                                    } else {
                                        throw new Error('❌ Gas top-up did not complete. ' + (r && r.error ? r.error : 'Please try again.'));
                                    }
                                }

                                // Step 3: CELO faucet received (handled by ensureToppedUp)
                                // Step 4: cUSD faucet received (handled by ensureToppedUp)
                                // Step 5: Swap confirmed (handled by ensureToppedUp)
                                setStatus('✅ Gas topped up and swap confirmed! Retrying your claim...', 'var(--green)');
                                txHash = await sendCeloClaim();
                            } catch (faucetErr) {
                                if (_isUserRejectedError && _isUserRejectedError(faucetErr)) throw faucetErr;
                                // Check for specific error types
                                const errMsg = (faucetErr && faucetErr.message) || '';
                                if (errMsg.includes('cooldown')) {
                                    throw faucetErr; // Already formatted above
                                } else if (errMsg.includes('no stablecoin') || errMsg.includes('no CELO')) {
                                    throw new Error('❌ Your MiniPay wallet needs either stablecoin (cUSD/USDT/USDC) or CELO to swap. Please add funds to your wallet.');
                                } else {
                                    throw new Error('❌ Claim failed: ' + errMsg || 'Insufficient gas. Please add cUSD or CELO to your wallet.');
                                }
                            }
                        } else {
                            throw sendErr;
                        }
                    } else {
                        setStatus('Gas became insufficient at send time. Re-running faucet fallback once…', '#d97706');
                        await ensureGasReadyBeforeClaim();
                        txHash = await sendCeloClaim();
                    }
                }
                label.textContent = 'Confirming…';
                setStatus('✅ Celo claim submitted. Waiting for confirmation…', 'var(--text-dim)');
                // Log submission attribution immediately. If the user closes the
                // page before pollReceipt sees the receipt, we still keep the
                // 'submitted' row in goodmarket_claim_facts and the async
                // verifier (or a follow-up confirm call) can upgrade it.
                logGoodMarketClaim(txHash, 'celo', 'submitted');
                pollReceipt(txHash, 20);

                appendStatusLine('ℹ️ Other network claims will appear here after Celo confirms — no automatic XDC prompt.', 'var(--text-dim)');
            } catch (err) {
                console.error('[claim] Celo claim error:', err);
                
                // Log WC session status for debugging
                const wcTopic = localStorage.getItem('wc_session_topic');
                console.log('[claim] WC Session Debug:', {
                    localStorageTopic: wcTopic,
                    hasWcSignClient: !!window._wcSignClient,
                    hasWcSession: !!window._wcSession,
                    providerType: provider instanceof WCClaimShim ? 'WCClaimShim' : typeof provider
                });
                
                const raw = (err && (err.shortMessage || err.message)) || 'Claim failed';
                const userRejected = _isUserRejectedError(err) || (raw || '').toLowerCase().includes('user rejected');
                const wrongWallet = (raw || '').toLowerCase().includes('wrong wallet');
                let msg;
                if (userRejected) {
                    msg = 'Transaction cancelled.';
                } else if (_isRpcHtmlError(err)) {
                    msg = 'Celo network is temporarily busy (RPC returned a non-JSON response). Please retry your claim in 30–60 seconds.';
                } else if (/invalid rpc url|twnodes|txnodes/i.test(raw)) {
                    // Wallet has a bad/expired Celo RPC URL (common with twnodes.com session URLs).
                    msg = 'Your wallet has an expired or invalid Celo RPC URL. ' +
                          'Open your wallet → Settings → Networks → Celo and set the RPC to ' +
                          'https://forno.celo.org or https://rpc.ankr.com/celo, then retry.';
                } else if (window.GMTxError && GMTxError.format) {
                    msg = GMTxError.format(err);
                } else {
                    msg = raw;
                }

                // Add hint for WalletConnect users
                if (provider instanceof WCClaimShim && !userRejected) {
                    appendStatusLine('💡 WalletConnect: If this keeps failing, try reconnecting your wallet.', 'var(--text-dim)');
                }

                // Show the CELO failure reason without auto-prompting another network;
                // the network cards above expose any remaining XDC claim manually.
                appendStatusLine('❌ Celo claim failed: ' + msg, 'var(--red)');

                btn.disabled = false;
                label.textContent = 'Claim G$';
                icon.textContent = '🪙';
                appendStatusLine('ℹ️ Check the network cards above for any remaining XDC claim.', 'var(--text-dim)');
            }
        }

        // Show the CELO-balance advisory banner once per browser session.
        // Auto-dismisses after 10s. Purely informational — does not trigger
        // any balance check or gate the claim flow.
        let _celoWarningTimer = null;
        function showCeloBalanceWarningOnce() {
            try {
                if (sessionStorage.getItem('celoBalanceWarningShown') === '1') return;
                const el = document.getElementById('celoBalanceWarning');
                if (!el) return;
                el.style.display = 'block';
                sessionStorage.setItem('celoBalanceWarningShown', '1');
                if (_celoWarningTimer) clearTimeout(_celoWarningTimer);
                _celoWarningTimer = setTimeout(() => {
                    el.style.display = 'none';
                    _celoWarningTimer = null;
                }, 10000);
            } catch (_e) { /* sessionStorage may be unavailable; fail silent */ }
        }


        async function getClaimProviderAndFrom() {
            // For WalletConnect users, use the existing WC session directly to avoid
            // injected provider conflicts. This matches the behavior in savings/swap/reloadly
            // where the WC session is prioritized.
            const wcPreferred = typeof GMWalletConnect !== 'undefined' && GMWalletConnect.isPreferred();
            if (wcPreferred) {
                const wcProvider = await _walletGetWcProviderIfPreferred();
                if (wcProvider) {
                    const accounts = await wcProvider.request({ method: 'eth_requestAccounts' });
                    if (accounts && accounts.length > 0) {
                        return { provider: wcProvider, from: accounts[0] };
                    }
                }
            }

            // Fall back to injected provider (MetaMask, Trust Wallet, MiniPay)
            let provider = await _vAwaitEthProvider();
            if (!provider) throw new Error('No wallet detected. Please open this page in MetaMask, Trust Wallet, MiniPay, or reconnect using WalletConnect to sign transactions.');
            const accounts = await provider.request({ method: 'eth_requestAccounts' });
            if (!accounts || !accounts.length) throw new Error('No wallet account available.');
            const from = accounts[0];
            if (from.toLowerCase() !== WALLET.toLowerCase()) {
                throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
            }
            return { provider, from };
        }

        async function executeNetworkClaim(network) {
            const caps = getClaimWalletCapabilities();
            const claims = (claimAvailability && claimAvailability.claims) || {};
            if (network === 'fuse' && claims.fuse && claims.fuse.is_available === false) {
                setStatus(claims.fuse.error || 'Fuse claim is temporarily not available.', '#d97706');
                return;
            }
            if (network === 'fuse' && !caps.supportsFuse) {
                setStatus('Fuse claiming needs MetaMask or a compatible WalletConnect wallet.', '#d97706');
                return;
            }
            if (network === 'xdc' && !caps.supportsXdc) {
                setStatus('XDC claiming needs MetaMask or a compatible WalletConnect wallet.', '#d97706');
                return;
            }

            btn.disabled = true;
            icon.textContent = network === 'fuse' ? '🔥' : '💠';
            label.textContent = network === 'fuse' ? 'Claiming on Fuse…' : 'Claiming on XDC…';
            setStatus(`Connecting wallet for ${network.toUpperCase()} claim…`, 'var(--text-dim)');
            if (network === 'xdc') {
                setStatus('Switching wallet to XDC network…', 'var(--text-dim)');
            }

            try {
                const { provider, from } = await getClaimProviderAndFrom();
                if (network === 'xdc') {
                    setStatus('Checking XDC gas…', 'var(--text-dim)');
                    await ensureXdcGasReadyBeforeClaim();
                } else if (network === 'fuse') {
                    setStatus('Checking Fuse gas…', 'var(--text-dim)');
                    await ensureFuseGasReadyBeforeClaim();
                }

                const txHash = network === 'fuse'
                    ? await claimFuseInjected(provider, from)
                    : await claimXdcInjected(provider, from);
                logGoodMarketClaim(txHash, network, 'submitted');
                const explorer = network === 'fuse' ? 'https://explorer.fuse.io/tx/' : 'https://xdcscan.com/tx/';
                setStatus(
                    `✅ ${network.toUpperCase()} claim submitted: <a href="${explorer}${txHash}" target="_blank" rel="noopener" style="color:#15803d;">${txHash.slice(0, 10)}...${txHash.slice(-6)}</a>`,
                    'var(--green)'
                );
                try { window.showClaimCelebration && window.showClaimCelebration({ networks: [network] }); } catch (_) {}
                setTimeout(() => {
                    if (network === 'xdc' && typeof loadXdcBalances === 'function') loadXdcBalances();
                    fetchEntitlement();
                }, 4000);
            } catch (err) {
                const raw = (err && (err.shortMessage || err.message)) || `${network.toUpperCase()} claim failed`;
                let msg;
                if (_isUserRejectedError(err)) {
                    msg = `${network.toUpperCase()} transaction cancelled.`;
                } else if (network === 'xdc' && _isWalletRpcUnreachableError(err)) {
                    msg = "Your wallet's XDC RPC endpoint is offline. Open your wallet's XDC Network settings and set the RPC URL to <strong>https://earpc.xinfin.network</strong> (or remove &amp; re-add XDC Network), then retry.";
                } else if (_isRpcHtmlError(err)) {
                    msg = `${network.toUpperCase()} network is temporarily busy. Please retry in 30–60 seconds.`;
                } else if (window.GMTxError && GMTxError.format) {
                    msg = GMTxError.format(err);
                } else {
                    msg = raw;
                }
                setStatus('❌ ' + msg, 'var(--red)');
                btn.disabled = false;
                label.textContent = network === 'fuse' ? 'Retry Fuse Claim' : 'Retry XDC Claim';
            }
        }

        // ── Local-wallet unlock helpers ──────────────────────────────────
        // The browser wallet auto-locks after 15 min. Any tx action (claim,
        // send, etc.) calls _lwUnlockIfNeeded() first, which opens a PIN
        // prompt and resumes after unlock.
        function _lwIsNeeded() {
            return (LOGIN_METHOD || '').toLowerCase() === 'local'
                && typeof GMLocalWallet !== 'undefined'
                && !GMLocalWallet.isUnlocked();
        }

        function _lwUnlockIfNeeded() {
            if (!_lwIsNeeded()) return Promise.resolve();
            return new Promise(function (resolve, reject) {
                window._lwUnlockResolve = resolve;
                window._lwUnlockReject = reject;
                const modal = document.getElementById('lwUnlockModal');
                const pinInput = document.getElementById('lwUnlockPin');
                const errEl = document.getElementById('lwUnlockError');
                if (errEl) errEl.style.display = 'none';
                if (pinInput) pinInput.value = '';
                if (modal) modal.classList.add('open');
                setTimeout(function () { if (pinInput) pinInput.focus(); }, 100);
            });
        }

        window._lwUnlockSubmit = async function () {
            const pinInput = document.getElementById('lwUnlockPin');
            const errEl = document.getElementById('lwUnlockError');
            const unlockBtn = document.getElementById('lwUnlockBtn');
            const pin = pinInput ? pinInput.value.trim() : '';
            if (!/^\d{6}$/.test(pin)) {
                if (errEl) { errEl.textContent = 'PIN must be exactly 6 digits.'; errEl.style.display = 'block'; }
                return;
            }
            if (unlockBtn) { unlockBtn.disabled = true; unlockBtn.textContent = 'Signing…'; }
            try {
                const saved = GMLocalWallet.getLocalKeystore();
                if (!saved || !saved.keystore) throw new Error('No saved wallet found on this device. Please log in again.');
                if ((saved.address || '').toLowerCase() !== WALLET.toLowerCase()) {
                    throw new Error('Saved wallet does not match this account. Please log in again.');
                }
                await GMLocalWallet.unlockWithKeystore(saved.keystore, pin);
                if (window._lwUnlockResolve) { window._lwUnlockResolve(); window._lwUnlockResolve = null; window._lwUnlockReject = null; }
                document.getElementById('lwUnlockModal').classList.remove('open');
            } catch (err) {
                if (errEl) {
                    errEl.textContent = (err && err.message && /password|decrypt|mac/i.test(err.message))
                        ? 'Wrong PIN. Try again.' : (err.message || 'Unlock failed.');
                    errEl.style.display = 'block';
                }
            } finally {
                if (unlockBtn) { unlockBtn.disabled = false; unlockBtn.textContent = 'Sign & Continue'; }
                if (pinInput) pinInput.value = '';
            }
        };

        window._lwUnlockCancel = function () {
            document.getElementById('lwUnlockModal').classList.remove('open');
            if (window._lwUnlockReject) { window._lwUnlockReject(new Error('Unlock cancelled.')); window._lwUnlockResolve = null; window._lwUnlockReject = null; }
        };

        // doSend / submitGcashCashout / the raffle signer live OUTSIDE this
        // IIFE — without these globals their locked-wallet unlock prompt
        // silently no-ops and the triggering button appears dead for local
        // logins.
        window._lwIsNeeded = _lwIsNeeded;
        window._lwUnlockIfNeeded = _lwUnlockIfNeeded;

        window.doUbiClaim = async function() {
            if (btn.disabled) return;
            recommendedClaimNetwork = pickRecommendedClaimNetwork() || recommendedClaimNetwork;
            if (claimed && recommendedClaimNetwork === 'celo') return;
            if (needsVerification) { startFV(); return; }
            if (recommendedClaimNetwork === 'fuse' || recommendedClaimNetwork === 'xdc') {
                await executeNetworkClaim(recommendedClaimNetwork);
                return;
            }

            showCeloBalanceWarningOnce();

            // GoodDapp-style: Always attempt direct claim first without any threshold check.
            // Let the claim fail naturally if insufficient gas, then handle the fallback.
            // MiniPay CIP-64 fee abstraction will handle stablecoin gas payment.
            console.log('[v0] doUbiClaim: Attempting direct claim (GoodDapp-style, no threshold check)');

            // Local wallets: prompt for PIN if the wallet has auto-locked.
            try {
                await _lwUnlockIfNeeded();
            } catch (unlockErr) {
                if (unlockErr.message !== 'Unlock cancelled.') setStatus(unlockErr.message, 'var(--red)');
                return;
            }

            if (!window.useServerSigning) {
                // GoodDapp-style: No pre-flight balance check.
                // Always proceed to claim. If it fails due to insufficient gas,
                // the catch block will handle the faucet fallback.
                ensureInjectedWalletClaim();
                return;
            }

            ensureGasAndClaim();
        };

        // Handle FV callback query params
        (function() {
            const p = new URLSearchParams(window.location.search);
            if (p.get('fv_pending') === '1') {
                openModal('claimModal');
                setStatus('✅ Face verification submitted! Re-checking your eligibility…', '#d97706');
                history.replaceState(null, '', window.location.pathname);
            } else if (p.get('fv_failed') === '1') {
                openModal('claimModal');
                const r = p.get('reason') || '';
                setStatus('Face verification not completed' + (r ? ' (' + r + ')' : '') + '. Please try again.', 'var(--red)');
                history.replaceState(null, '', window.location.pathname);
            }
        })();

        // Init
        if (btn) { btn.disabled = true; label.textContent = 'Checking entitlement…'; icon.textContent = '⏳'; }
        fetchEntitlement();
    })();

    // ── FV Link Generator (mirrors ClaimSDK.generateFVLink from @gooddollar/web3sdk-v2) ─────
    // Robust WalletConnect detection: LOGIN_METHOD is primary, but sessions
    // created before login_method was persisted report "injected" for
    // WalletConnect users too. prefersWcSigning() recovers those via a saved
    // WC session for this wallet so they never sign with injected MetaMask.
    const PREFER_WC_SIGNING = (typeof GMWalletConnect !== 'undefined' && typeof GMWalletConnect.prefersWcSigning === 'function')
        ? GMWalletConnect.prefersWcSigning()
        : ['walletconnect', 'manual', 'manual_address'].includes((LOGIN_METHOD || '').toLowerCase());
    window._fvGenerateLink = null;
    (function() {
        if (typeof LZString === 'undefined') return;

        // Exact constant from GoodDollar SDK source (FV_IDENTIFIER_MSG2)
        const FV_IDENTIFIER_MSG2 =
            'Sign this message to request verifying your account <account> and to create your own secret unique identifier for your anonymized record.\n' +
            'You can use this identifier in the future to delete this anonymized record.\n' +
            'WARNING: do not sign this message unless you trust the website/application requesting this signature.';

        function buildFVLink(address, fvSig) {
            // The FV link's `account` URL param must use the SAME casing that
            // was substituted into the signed FV_IDENTIFIER_MSG2 message. The
            // GoodID server reconstructs the signed message using whatever
            // it sees in this param, then ecrecovers the signer and compares
            // against `account` — if the casing differs, the recovered signer
            // is a random address and verification can fail. signWithWallet /
            // signWithWalletConnect / signServerSide all sign with `address`
            // verbatim, so we keep the same casing here. (The callbackUrl's
            // `wallet` param below is unrelated to FV signing — it's just the
            // GoodMarket-side redirect param for /wallet?fv_pending=1, which
            // we keep lowercased so the redirect URL is canonical.)
            const callbackUrl = window.location.origin +
                '/wallet?fv_pending=1&wallet=' + encodeURIComponent(address.toLowerCase()) + '&src=goodmarket';
            const params = {
                account:   address,
                fvsig:     fvSig,
                firstname: 'GoodMarket',
                chain:     42220,
                rdu:       callbackUrl
            };
            const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(params));
            return 'https://goodid.gooddollar.org?lz=' + compressed;
        }

        async function signServerSide(address) {
            // Use address as-is (checksummed) in the message — GoodID verifies against checksummed form.
            // Matches ethers.js signer.getAddress() behaviour in the SDK's getFvSig().
            const msg = FV_IDENTIFIER_MSG2.replace('<account>', address);
            const endpoint = (LOGIN_METHOD === 'walletconnect') ? '/api/walletconnect-disabled/sign-msg' : '/api/walletconnect-disabled/sign-msg';
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            });
            const data = await res.json();
            if (!data.signature) throw new Error(data.error || 'Signing failed');
            // Ensure 0x prefix — GoodID requires it to ecrecover the signer
            const sig = data.signature;
            return sig.startsWith('0x') ? sig : '0x' + sig;
        }

        async function _ensureCeloChainForSigning(provider) {
            // FV signing is Celo-bound (the link encodes chain=42220 and the
            // claim follow-up runs on Celo). Some injected wallets — notably
            // Trust Wallet's mobile dApp browser — default to Ethereum mainnet,
            // which causes personal_sign prompts to silently hang or be issued
            // under the wrong chain context. Force-switch to Celo first.
            try {
                if (typeof _isMiniPay === 'function' && _isMiniPay()) return; // MiniPay is Celo-only
            } catch (_) { /* no-op */ }
            const CELO_CHAIN_HEX = '0xa4ec';
            let current;
            try {
                current = await provider.request({ method: 'eth_chainId' });
            } catch (_) {
                current = null;
            }
            if (_normalizeChainIdHex(current) === CELO_CHAIN_HEX) return;
            try {
                await provider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: CELO_CHAIN_HEX }]
                });
            } catch (switchErr) {
                if (switchErr && (switchErr.code === 4001 || switchErr.code === 5000)) {
                    throw switchErr; // user cancelled — let outer catch report it
                }
                // 4902 / -32603 — chain not added in the wallet yet; try to add it.
                try {
                    await provider.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: CELO_CHAIN_HEX,
                            chainName: 'Celo Mainnet',
                            nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
                            rpcUrls: ['https://forno.celo.org'],
                            blockExplorerUrls: ['https://celoscan.io']
                        }]
                    });
                } catch (addErr) {
                    throw new Error('Could not switch your wallet to Celo. Please switch manually and try again.');
                }
            }
        }

        async function signWithWallet(address) {
            const provider = await _vAwaitEthProvider();
            if (!provider) {
                throw new Error('No wallet detected. Please open this page in MiniPay, MetaMask, Trust Wallet, or reconnect using WalletConnect to sign transactions.');
            }

            const accounts = await provider.request({ method: 'eth_requestAccounts' });
            if (!accounts || !accounts.length) {
                throw new Error('No wallet account available for signing.');
            }

            const connected = accounts[0];
            if (connected.toLowerCase() !== address.toLowerCase()) {
                throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet and try again.');
            }

            // Make sure the wallet is on Celo before issuing personal_sign.
            await _ensureCeloChainForSigning(provider);

            // Use EIP-191 hex-encoded message for personal_sign — Trust Wallet's
            // mobile dApp browser hangs on plain-text payloads with newlines, and
            // hex is the format the spec/MetaMask docs recommend. We try multiple
            // method/parameter orderings to cover injected wallets that diverge
            // from the standard (mirrors the WalletConnect signing path).
            const msg    = FV_IDENTIFIER_MSG2.replace('<account>', address);
            const msgHex = _toUtf8Hex(msg);
            const attempts = [
                { method: 'personal_sign', params: [msgHex, connected], label: 'personal_sign(hex,address)' },
                { method: 'personal_sign', params: [connected, msgHex], label: 'personal_sign(address,hex)' },
                { method: 'personal_sign', params: [msg,    connected], label: 'personal_sign(text,address)' },
                { method: 'eth_sign',      params: [connected, msgHex], label: 'eth_sign(address,hex)' }
            ];

            let lastErr = null;
            for (const attempt of attempts) {
                try {
                    const sig = await provider.request({
                        method: attempt.method,
                        params: attempt.params
                    });
                    if (!sig) throw new Error('Wallet did not return a signature.');
                    console.log('✅ FV signed via injected wallet using', attempt.label);
                    return sig.startsWith('0x') ? sig : '0x' + sig;
                } catch (err) {
                    if (_isUserRejectedSigning(err)) {
                        throw err;
                    }
                    lastErr = err;
                }
            }

            const raw = String((lastErr && (lastErr.shortMessage || lastErr.message)) || '').trim();
            throw new Error(raw || 'Wallet signing failed. Please reconnect your wallet and try again.');
        }

        function _toUtf8Hex(msg) {
            return '0x' + Array.from(new TextEncoder().encode(msg))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }

        function _isUserRejectedSigning(err) {
            const code = err && err.code;
            if (code === 4001 || code === 5000) return true;
            const msg = String((err && (err.shortMessage || err.message)) || '').toLowerCase();
            // Match only unambiguous user-cancellation phrases — a bare
            // "rejected" substring also matches things like "RPC request
            // rejected" or "session request rejected due to timeout", which
            // would abort the signing retry loop prematurely.
            return msg.includes('user rejected') || msg.includes('user denied')
                || msg.includes('cancelled') || msg.includes('canceled');
        }

        function _getWalletConnectProvider() {
            if (!window.ethereum) return null;
            const providers = (window.ethereum.providers && window.ethereum.providers.length)
                ? window.ethereum.providers
                : [window.ethereum];
            return providers.find(p =>
                p && (
                    p.isWalletConnect
                )
            ) || null;
        }

        async function signWithWalletConnect(address) {
            // Prefer an injected WC connector if a wallet exposed one, then any
            // other injected provider. As a last resort fall back to the
            // shared GMWalletConnect bridge (sidecar / browser SignClient) so
            // QR-scan WalletConnect logins can still produce a signature.
            let provider = _getWalletConnectProvider();
            if (!provider) provider = await _vAwaitEthProvider();
            if (!provider) {
                provider = await _walletGetWcProviderIfPreferred();
            }
            if (!provider) {
                throw new Error('WalletConnect signer unavailable. Reconnect your wallet and try again.');
            }

            const accounts = await provider.request({ method: 'eth_requestAccounts' });
            if (!accounts || !accounts.length) {
                throw new Error('No WalletConnect account available for signing.');
            }
            const connected = accounts[0];
            if (connected.toLowerCase() !== address.toLowerCase()) {
                throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet and try again.');
            }

            // If we fell back to a plain injected provider (no WC session), the
            // wallet may still be on the wrong chain — make sure it's on Celo
            // before signing. Real WC v2 sessions are already chain-bound so we
            // skip the switch for them.
            if (!provider.isWalletConnect) {
                await _ensureCeloChainForSigning(provider);
            }

            const msg = FV_IDENTIFIER_MSG2.replace('<account>', address);
            const msgHex = _toUtf8Hex(msg);
            const attempts = [
                { method: 'personal_sign', params: [msgHex, connected], label: 'personal_sign(hex,address)' },
                { method: 'personal_sign', params: [connected, msgHex], label: 'personal_sign(address,hex)' },
                { method: 'personal_sign', params: [msg, connected], label: 'personal_sign(text,address)' },
                { method: 'personal_sign', params: [connected, msg], label: 'personal_sign(address,text)' },
                { method: 'eth_sign', params: [connected, msgHex], label: 'eth_sign(address,hex)' },
                { method: 'eth_sign', params: [msgHex, connected], label: 'eth_sign(hex,address)' }
            ];

            let lastErr = null;
            for (const attempt of attempts) {
                try {
                    const sig = await provider.request({
                        method: attempt.method,
                        params: attempt.params
                    });
                    if (!sig) throw new Error('Wallet did not return a signature.');
                    console.log('✅ FV signed via WalletConnect using', attempt.label);
                    return sig.startsWith('0x') ? sig : '0x' + sig;
                } catch (err) {
                    if (_isUserRejectedSigning(err)) {
                        throw new Error('Signature cancelled in wallet.');
                    }
                    lastErr = err;
                }
            }

            const raw = String((lastErr && (lastErr.shortMessage || lastErr.message)) || '').trim();
            throw new Error(raw || 'WalletConnect signing failed. Please reconnect your wallet and try again.');
        }

        window._fvGenerateLink = async function(address) {
            // Local self-custodial wallets: unlock via PIN modal first, then sign
            // with the browser wallet (not an injected provider).
            if ((LOGIN_METHOD || '').toLowerCase() === 'local'
                && typeof GMLocalWallet !== 'undefined') {
                if (!GMLocalWallet.isUnlocked()) {
                    if (typeof window._lwOpenUnlockModal === 'function') {
                        await window._lwOpenUnlockModal();
                    } else {
                        throw new Error('Please unlock your wallet to continue.');
                    }
                }
                const provider = GMLocalWallet.getProvider();
                const msg = FV_IDENTIFIER_MSG2.replace('<account>', address);
                const sig = await provider.request({
                    method: 'personal_sign',
                    params: [ethers.hexlify(ethers.toUtf8Bytes(msg)), address]
                });
                return buildFVLink(address, sig);
            }
            const sig = window.useServerSigning
                ? await signServerSide(address)
                : (PREFER_WC_SIGNING
                    ? await signWithWalletConnect(address)
                    : await signWithWallet(address));
            return buildFVLink(address, sig);
        };

        console.log('✅ FV SDK helper ready');
    })();

    // ── Portfolio cardholder name ─────────────────────────────
    // Populates the "Cardholder" field on the portfolio card from the user's
    // saved username (set on the dashboard). Falls back to a shortened wallet
    // address so the field is never empty.
    async function loadPortfolioCardholder() {
        const el = document.getElementById('pcCardholder');
        if (!el) return;
        try {
            const res = await fetch('/api/user/username');
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.success && data.username) {
                el.textContent = String(data.username).toUpperCase();
            }
        } catch (err) {
            // keep the wallet-shortform fallback rendered from Jinja
        }
    }

    // ── In-app dApp browser entry point ─────────────────────
    // Works only inside the Capacitor shell (mobile/): the native
    // DappBrowserPlugin launches a second WebView with the GoodMarket
    // EIP-1193 bridge injected (see static/js/dapp-browser-bridge.js).
    // A regular browser has no native WebView layer to inject into, so we
    // show a friendly notice instead of a dead button.
    function _dappBrowserPlugin() {
        try {
            return (window.Capacitor &&
                    window.Capacitor.Plugins &&
                    window.Capacitor.Plugins.DappBrowser) || null;
        } catch (_) { return null; }
    }

    function openDappBrowser(url) {
        // The bridge signs with the GoodMarket in-app wallet only.
        if ((LOGIN_METHOD || '').toLowerCase() !== 'local') {
            window.alert('🌐 The DApp Browser uses your GoodMarket in-app wallet. ' +
                'Please log in with your email + PIN account to use it.');
            return;
        }
        const plugin = _dappBrowserPlugin();
        if (!plugin) {
            window.alert('🌐 DApp Browser is available in the GoodMarket app.\n\n' +
                'It opens dApps (like claim.superfluid.org) in a secure in-app browser ' +
                'connected to your GoodMarket wallet. Install the GoodMarket app to use it.');
            return;
        }
        const opts = {};
        if (url) opts.url = url;
        plugin.open(opts);
    }
    window.openDappBrowser = openDappBrowser;

    // ── Init ──────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        const reminderBanner = document.getElementById('walletReminderBanner');
        if (reminderBanner) {
            const bannerSeenKey = 'walletUnifiedClaimNoticeSeen_v1';
            const bannerWasSeen = localStorage.getItem(bannerSeenKey) === '1';
            if (!bannerWasSeen) {
                reminderBanner.classList.remove('hidden');
                localStorage.setItem(bannerSeenKey, '1');
                setTimeout(() => {
                    reminderBanner.classList.add('hiding');
                    setTimeout(() => reminderBanner.classList.add('hidden'), 350);
                }, 60000);
            }
        }
        loadBalances();
        loadPortfolioCardholder();
        // Keep GoodSwap and Bridge visible in all wallet environments.
        // GoodReserve is no longer a top-level action — it lives as a
        // sub-tab inside GoodSwap (see /swap → GoodSwap → GoodReserve).
        (function ensureGoodSwapAndBridgeVisible() {
            try {
                const ids = ['actionGoodSwap', 'actionBridge'];
                ids.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.style.display = '';
                });
            } catch (_) { /* no-op */ }
        })();

        // WalletConnect session expiry guard is handled globally by wc-bridge.js
        // (auto-starts when GMWalletConnect.configure() is called with loginMethod: "walletconnect")
    });
