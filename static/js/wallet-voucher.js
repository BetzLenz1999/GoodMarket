// Extracted from templates/wallet.html inline <script> (load-perf refactor).
// Per-request values come from window.GM_WALLET_BOOT (set inline in wallet.html).
(function() {
            var voucherCheckInterval = null;
            // Do NOT default to 'walletconnect': an injected (or empty) login
            // would otherwise be treated as a WalletConnect session and trip the
            // WC expiry guard, auto-logging the user out for a "missing" WC
            // session they never had. Keep it empty so non-WC users are unaffected.
            const LOGIN_METHOD = window.GM_WALLET_BOOT.loginMethod;
            const SESSION_WALLET = window.GM_WALLET_BOOT.wallet;

            if (typeof GMWalletConnect !== "undefined") {
                GMWalletConnect.configure({
                    walletAddress: SESSION_WALLET,
                    loginMethod: LOGIN_METHOD,
                    projectId: window.GM_WALLET_BOOT.walletConnectProjectId,
                    sidecarEnabled: false,
                    dappName: "GoodMarket — Voucher",
                    dappDescription: "Claim your daily G$ voucher on Celo",
                    assetVersion: window.GM_WALLET_BOOT.assetVersion,
                });
            }
            function _voucherWcProviderIfPreferred() {
                try {
                    if (typeof GMWalletConnect === "undefined") return null;
                    if (!GMWalletConnect.isPreferred()) return null;
                    return GMWalletConnect.getProvider();
                } catch (_) {
                    return null;
                }
            }

            async function _voucherClaimProvider(promptLogin) {
                // GoodMarket local accounts sign with the PIN-decrypted in-app
                // wallet, never with an injected MetaMask/extension (a
                // different account). Never fall through to injected for them.
                if ((LOGIN_METHOD || '').toLowerCase() === 'local') {
                    if (typeof GMLocalWallet !== 'undefined') return GMLocalWallet.getProvider();
                    return null;
                }
                if (typeof _awaitEthProvider === 'function') {
                    var walletProvider = await _awaitEthProvider(promptLogin ? 10000 : 800);
                    if (walletProvider) return walletProvider;
                }
                if (typeof _walletGetPrivyProviderIfPreferred === 'function') {
                    var privyProvider = await _walletGetPrivyProviderIfPreferred({ promptLogin: !!promptLogin, timeoutMs: promptLogin ? 10000 : 1200 });
                    if (privyProvider) return privyProvider;
                }
                var injected = _vGetEthProvider();
                if (injected) return injected;
                return _voucherWcProviderIfPreferred();
            }

            // Provide the legacy `window._wcOpen(onUri) -> Promise<address>`
            // shim that the existing voucher QR / NFT-buy flows rely on. We
            // forward the WalletConnect QR URI to the caller so it can render
            // the QR inline in its own modal, then resolve with the connected
            // wallet address once the user approves the session.
            if (!window._wcOpen) {
                window._wcOpen = function(onUri) {
                    if (typeof GMWalletConnect === "undefined") {
                        return Promise.reject(new Error("WalletConnect bridge not loaded."));
                    }
                    GMWalletConnect.configure({
                        showQr: function(uri) {
                            try { if (typeof onUri === "function") onUri(uri); } catch (_) {}
                        },
                        hideQr: function() {}
                    });
                    return GMWalletConnect.connect();
                };
            }

            async function checkDailyVoucher() {
                try {
                    var res = await fetch('/api/voucher/daily');
                    if (!res.ok) return;
                    var data = await res.json();
                    var banner = document.getElementById('dailyVoucherBanner');
                    if (data.success && data.voucher) {
                        banner.style.display = 'block';
                    } else {
                        banner.style.display = 'none';
                    }
                } catch (e) {
                    console.warn('Voucher check failed:', e);
                }
            }

            // ── Voucher modal helpers ─────────────────────────────────────────
            // Handles multi-wallet injections: prefer MiniPay in MiniPay dApp browser,
            // then Trust Wallet, then MetaMask (excluding Brave), then first provider.
            function _vGetEthProvider() {
                // WalletConnect / manual-address logins must NEVER use an injected
                // wallet (e.g. a desktop MetaMask extension): its account differs
                // from the logged-in GoodMarket wallet, so the voucher claim fails
                // with "Wrong wallet connected". Block injected discovery so the
                // claim routes through the WalletConnect signer. The robust check
                // also recovers pre-existing WC sessions mislabeled as "injected".
                if (typeof GMWalletConnect !== 'undefined' && typeof GMWalletConnect.prefersWcSigning === 'function'
                        ? GMWalletConnect.prefersWcSigning()
                        : ['walletconnect', 'manual', 'manual_address'].includes((LOGIN_METHOD || '').toLowerCase())) return null;
                if (!window.ethereum) return null;
                if (window.ethereum.providers && window.ethereum.providers.length) {
                    var miniPay = window.ethereum.providers.find(function(p) { return p && p.isMiniPay; });
                    if (miniPay) return miniPay;
                    var trust = window.ethereum.providers.find(function(p) { return p && (p.isTrust || p.isTrustWallet); });
                    if (trust) return trust;
                    var mm = window.ethereum.providers.find(function(p) { return p.isMetaMask && !p.isBraveWallet; });
                    if (mm) return mm;
                    return window.ethereum.providers[0];
                }
                return window.ethereum;
            }

            const VCELO_CHAIN_ID = 42220;
            const VCELO_RPC = 'https://forno.celo.org';
            const VOTP_ADDRESS = '0xB27D247f5C2a61D2Cb6b6E67FEE51d839447e97d';
            const VGD_DECIMALS = 18;
            const VOTP_ABI = [
                'function payments(address) view returns (bool hasPayment, uint256 paymentAmount, address paymentSender)',
                'function withdraw(address paymentId, bytes memory signature) public',
                'function hasPayment(address paymentId) view returns (bool)'
            ];

            let _voucherPaymentPrivKey = null;
            let _voucherPaymentWallet = null;
            let _voucherPaymentAmount = null;
            let _voucherLink = null;

            function voucherShowModal() {
                document.getElementById('voucherResultModal').style.display = 'flex';
            }
            function voucherHideAllStates() {
                ['voucherStateSimple','voucherStateDapp','voucherStateQr'].forEach(id => {
                    document.getElementById(id).style.display = 'none';
                });
            }
            function voucherShowSimple(icon, title, msg) {
                voucherHideAllStates();
                document.getElementById('voucherSimpleIcon').textContent = icon;
                document.getElementById('voucherSimpleTitle').textContent = title;
                document.getElementById('voucherSimpleMsg').textContent = msg;
                document.getElementById('voucherStateSimple').style.display = 'block';
                voucherShowModal();
            }
            function voucherDappSetAlert(type, html) {
                var el = document.getElementById('voucherDappAlert');
                var colors = {
                    error:   'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;',
                    success: 'background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);color:#86efac;',
                    info:    'background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);color:#93c5fd;'
                };
                el.setAttribute('style', (colors[type] || colors.info) + 'border-radius:10px;padding:0.75rem 0.9rem;font-size:0.82rem;font-weight:500;display:block;text-align:left;margin-bottom:0.75rem;');
                el.innerHTML = html;
            }

            function isServerSigningLoginMethod() {
                return false;((LOGIN_METHOD || '').toLowerCase());
            }

            async function voucherInitDapp() {
                try {
                    var ethers = window.ethers;
                    if (!ethers) { throw new Error('no-ethers'); }
                    _voucherPaymentPrivKey = _voucherPaymentPrivKey.startsWith('0x') ? _voucherPaymentPrivKey : '0x' + _voucherPaymentPrivKey;
                    _voucherPaymentWallet = new ethers.Wallet(_voucherPaymentPrivKey);

                    var provider = new ethers.JsonRpcProvider(VCELO_RPC);
                    var otp = new ethers.Contract(VOTP_ADDRESS, VOTP_ABI, provider);
                    var payment = await otp.payments(_voucherPaymentWallet.address);

                    if (!payment.hasPayment) {
                        document.getElementById('voucherDappAmountValue').textContent = 'Already Claimed';
                        document.getElementById('voucherDappClaimBtn').textContent = '⚠️ Payment not found';
                        return;
                    }

                    _voucherPaymentAmount = payment.paymentAmount;
                    var humanAmt = parseFloat(ethers.formatUnits(_voucherPaymentAmount, VGD_DECIMALS)).toFixed(2);
                    document.getElementById('voucherDappAmountValue').textContent = humanAmt + ' G$';

                    var btn = document.getElementById('voucherDappClaimBtn');
                    btn.disabled = false;
                    btn.textContent = 'Claim ' + humanAmt + ' G$';
                } catch(e) {
                    console.error('voucherInitDapp error:', e);
                    document.getElementById('voucherDappAmountValue').textContent = 'Could not load';
                    document.getElementById('voucherDappClaimBtn').textContent = '⚠️ Load failed — try refreshing';
                }
            }

            async function voucherDappClaim() {
                if (!_voucherPaymentWallet || !_voucherPaymentAmount) return;
                var ethers = window.ethers;
                var btn = document.getElementById('voucherDappClaimBtn');
                var spinner = '<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;"></span>';

                try {
                    btn.disabled = true;
                    var receiverAddr = '';
                    var txHash = '';
                    var otpCheck = null;
                    var signer = null;
                    var iface = new ethers.Interface(VOTP_ABI);

                    if (isServerSigningLoginMethod()) {
                        if (!SESSION_WALLET || SESSION_WALLET.length < 42) {
                            throw new Error('No active logged-in wallet found. Please re-login and try again.');
                        }
                        receiverAddr = SESSION_WALLET;
                        var providerRead = new ethers.JsonRpcProvider(VCELO_RPC);
                        otpCheck = new ethers.Contract(VOTP_ADDRESS, VOTP_ABI, providerRead);
                    } else {
                        btn.innerHTML = spinner + ' Preparing wallet...';
                        var ep;
                        // Local (GoodMarket-created) accounts MUST sign with
                        // the PIN-decrypted in-app wallet — never with an
                        // injected extension. Unlock first via the PIN modal.
                        if ((LOGIN_METHOD || '').toLowerCase() === 'local') {
                            if (typeof GMLocalWallet === 'undefined') {
                                throw new Error('Local wallet module did not load. Please refresh the page.');
                            }
                            if (typeof _lwUnlockIfNeeded === 'function') {
                                await _lwUnlockIfNeeded();
                            }
                            ep = GMLocalWallet.getProvider();
                        } else {
                            ep = await _voucherClaimProvider(true);
                        }
                        if (!ep) throw new Error('No Web3 wallet detected. Open this Wallet page in MiniPay, connect with Privy, or sign in again with WalletConnect.');
                        await ep.request({ method: 'eth_requestAccounts' });

                        var chainHex = await ep.request({ method: 'eth_chainId' });
                        if (parseInt(chainHex, 16) !== VCELO_CHAIN_ID) {
                            try {
                                await ep.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + VCELO_CHAIN_ID.toString(16) }] });
                            } catch {
                                await ep.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x' + VCELO_CHAIN_ID.toString(16), chainName: 'Celo Mainnet', nativeCurrency: { name:'CELO', symbol:'CELO', decimals:18 }, rpcUrls:['https://forno.celo.org'], blockExplorerUrls:['https://celoscan.io'] }] });
                            }
                        }

                        var provider = new ethers.BrowserProvider(ep);
                        signer = await provider.getSigner();
                        receiverAddr = await signer.getAddress();
                        if (SESSION_WALLET && receiverAddr && receiverAddr.toLowerCase() !== SESSION_WALLET.toLowerCase()) {
                            throw new Error('Wrong wallet connected. Please use your GoodMarket wallet.');
                        }
                        otpCheck = new ethers.Contract(VOTP_ADDRESS, VOTP_ABI, provider);
                    }

                    btn.innerHTML = spinner + ' Verifying payment...';
                    var stillActive = await otpCheck.hasPayment(_voucherPaymentWallet.address);
                    if (!stillActive) {
                        voucherDappSetAlert('error', '❌ This payment has already been claimed or cancelled.');
                        btn.disabled = true;
                        btn.textContent = 'Already Claimed';
                        return;
                    }

                    btn.innerHTML = spinner + ' Signing...';
                    var messageHash = ethers.keccak256(ethers.solidityPacked(['address'], [receiverAddr]));
                    var signature = await _voucherPaymentWallet.signMessage(ethers.getBytes(messageHash));

                    if (isServerSigningLoginMethod()) {
                        btn.innerHTML = spinner + ' Submitting claim...';
                        voucherDappSetAlert('info', spinner + ' Signing and sending transaction via your secure wallet session...');
                        var callData = iface.encodeFunctionData('withdraw', [_voucherPaymentWallet.address, signature]);
                        var signRes = await fetch('/api/server/sign-tx', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                to: VOTP_ADDRESS,
                                data: callData,
                                value: '0x0',
                                chain_id: VCELO_CHAIN_ID,
                                wait_receipt: true
                            })
                        });
                        var signData = await signRes.json();
                        if (!signRes.ok || !signData.success || !signData.tx_hash) {
                            throw new Error(signData.error || 'Server signing failed');
                        }
                        txHash = signData.tx_hash;
                    } else {
                        btn.innerHTML = spinner + ' Confirm in wallet...';
                        voucherDappSetAlert('info', spinner + ' Confirm the transaction in your wallet.');
                        var otpSigner = new ethers.Contract(VOTP_ADDRESS, VOTP_ABI, signer);
                        var tx = await otpSigner.withdraw(_voucherPaymentWallet.address, signature);

                        btn.innerHTML = spinner + ' Waiting for confirmation...';
                        voucherDappSetAlert('info', spinner + ' Transaction submitted. Waiting for Celo confirmation...');
                        var receipt = await tx.wait();
                        txHash = receipt.hash;
                    }

                    var humanAmt = parseFloat(ethers.formatUnits(_voucherPaymentAmount, VGD_DECIMALS)).toFixed(2);
                    var explorerUrl = 'https://celoscan.io/tx/' + txHash;
                    voucherDappSetAlert('success', '✅ Successfully received <strong>' + humanAmt + ' G$</strong>! <a href="' + explorerUrl + '" target="_blank" style="color:#86efac;text-decoration:underline;">View on CeloScan ↗</a>');
                    btn.disabled = true;
                    btn.textContent = '✅ Claimed!';

                    // Only now that the on-chain withdraw succeeded do we
                    // confirm the claim server-side (which marks the voucher
                    // as claimed) and finally hide the banner.
                    try {
                        await fetch('/api/voucher/confirm', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                tx_hash: txHash,
                                gd_amount: parseFloat(humanAmt),
                            })
                        });
                        document.getElementById('dailyVoucherBanner').style.display = 'none';
                        if (typeof txHistoryLoaded !== 'undefined') txHistoryLoaded = false; // force reload of transaction history
                    } catch (_) { /* non-critical, ignore */ }

                } catch(err) {
                    console.error(err);
                    var friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.reason || err?.shortMessage || err?.message || 'Unknown error');
                    voucherDappSetAlert('error', '❌ Claim failed: ' + friendly);
                    var humanAmt2 = _voucherPaymentAmount ? parseFloat(ethers.formatUnits(_voucherPaymentAmount, VGD_DECIMALS)).toFixed(2) : '?';
                    btn.disabled = false;
                    btn.textContent = 'Retry — Claim ' + humanAmt2 + ' G$';
                }
            }

            // ── WalletConnect QR flow (client-side) ──────────────────────────
            let _wcSessionId = null;
            let _wcReceiverAddr = null;
            let _wcPollTimer = null;

            function wcSetSubState(id) {
                ['wcLoading','wcQrBox','wcConnected'].forEach(s => {
                    document.getElementById(s).style.display = s === id ? 'block' : 'none';
                });
            }
            function wcSetAlert(type, html) {
                var el = document.getElementById('wcAlert');
                var styles = {
                    error:   'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;',
                    success: 'background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);color:#86efac;',
                    info:    'background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);color:#93c5fd;'
                };
                el.setAttribute('style', (styles[type] || styles.info) + 'display:block;border-radius:10px;padding:0.75rem 0.9rem;font-size:0.82rem;font-weight:500;text-align:left;margin-bottom:0.75rem;');
                el.innerHTML = html;
            }

            async function voucherStartWalletConnect(privKey) {
                voucherHideAllStates();
                document.getElementById('voucherStateQr').style.display = 'block';
                wcSetSubState('wcLoading');
                document.getElementById('wcAlert').style.display = 'none';
                _wcSessionId = null;
                _wcReceiverAddr = null;
                if (_wcPollTimer) { clearInterval(_wcPollTimer); _wcPollTimer = null; }
                voucherShowModal();

                if (!window._wcOpen) {
                    wcSetAlert('error', '❌ WalletConnect not available. Please refresh and try again.');
                    document.getElementById('wcAlert').style.display = 'block';
                    return;
                }

                try {
                    // Use browser-side WalletConnect SDK directly — works on all deployment platforms
                    await window._wcOpen(function(uri) {
                        // Show QR code as soon as URI is ready
                        var canvas = document.getElementById('voucherQrCanvas');
                        canvas.innerHTML = '';
                        if (window.QRCode) {
                            new QRCode(canvas, { text: uri, width: 200, height: 200, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
                        } else {
                            canvas.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=ffffff&color=000000&data=' + encodeURIComponent(uri) + '" width="200" height="200" style="display:block;border-radius:6px;" />';
                        }
                        wcSetSubState('wcQrBox');
                    }).then(async function(address) {
                        _wcReceiverAddr = address;
                        await wcLoadPaymentDetails(privKey);
                    });
                } catch(e) {
                    console.error('WC start error:', e);
                    var msg = (e && e.message) ? e.message : String(e);
                    var lower = msg.toLowerCase();
                    if (lower.includes('cancel') || lower.includes('reject') || lower.includes('declined')) {
                        wcSetAlert('error', '❌ Wallet connection was rejected. Please try again.');
                    } else {
                        wcSetAlert('error', '❌ Could not connect wallet. Please try again.');
                    }
                    wcSetSubState('wcLoading');
                    document.getElementById('wcAlert').style.display = 'block';
                }
            }

            async function wcLoadPaymentDetails(privKey) {
                try {
                    var ethers = window.ethers;
                    if (!ethers) {
                        // ethers might still be loading — wait a moment
                        await new Promise(r => setTimeout(r, 2000));
                        ethers = window.ethers;
                    }
                    var privKeyFull = privKey.startsWith('0x') ? privKey : '0x' + privKey;
                    _voucherPaymentWallet = new ethers.Wallet(privKeyFull);
                    _voucherPaymentPrivKey = privKeyFull;

                    var provider = new ethers.JsonRpcProvider(VCELO_RPC);
                    var otp = new ethers.Contract(VOTP_ADDRESS, VOTP_ABI, provider);
                    var payment = await otp.payments(_voucherPaymentWallet.address);

                    if (!payment.hasPayment) {
                        wcSetAlert('error', '❌ This payment has already been claimed or cancelled.');
                        wcSetSubState('wcQrBox');
                        document.getElementById('wcAlert').style.display = 'block';
                        return;
                    }

                    _voucherPaymentAmount = payment.paymentAmount;
                    var humanAmt = parseFloat(ethers.formatUnits(_voucherPaymentAmount, VGD_DECIMALS)).toFixed(2);
                    document.getElementById('wcAmountValue').textContent = humanAmt + ' G$';
                    wcSetSubState('wcConnected');
                } catch(e) {
                    console.error('wcLoadPaymentDetails error:', e);
                    wcSetAlert('error', '❌ Could not load payment amount. Please refresh and try again.');
                    wcSetSubState('wcQrBox');
                    document.getElementById('wcAlert').style.display = 'block';
                }
            }

            async function wcExecuteClaim() {
                if (!_wcReceiverAddr || !_voucherPaymentWallet) return;
                var ethers = window.ethers;
                var btn = document.getElementById('wcClaimBtn');
                var spinner = '<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;"></span>';

                try {
                    btn.disabled = true;
                    btn.innerHTML = spinner + ' Preparing...';

                    // Sign receiver address with the payment private key (client-side)
                    var messageHash = ethers.keccak256(ethers.solidityPacked(['address'], [_wcReceiverAddr]));
                    var signature = await _voucherPaymentWallet.signMessage(ethers.getBytes(messageHash));

                    // Encode withdraw() call data
                    var iface = new ethers.Interface(VOTP_ABI);
                    var callData = iface.encodeFunctionData('withdraw', [_voucherPaymentWallet.address, signature]);

                    btn.innerHTML = spinner + ' Confirm in your wallet...';
                    wcSetAlert('info', spinner + ' A transaction request has been sent to your mobile wallet. Please approve it there.');

                    // Route the eth_sendTransaction through the shared
                    // WalletConnect bridge — it knows whether the active
                    // session is a Node sidecar session or an in-browser
                    // SignClient session and handles both.
                    if (typeof GMWalletConnect === "undefined" || !GMWalletConnect.isConnected()) {
                        throw new Error("WalletConnect session not active. Please re-scan the QR.");
                    }
                    var txHash;
                    try {
                        txHash = await GMWalletConnect.bridgeRequest('eth_sendTransaction', [{
                            from: _wcReceiverAddr,
                            to: VOTP_ADDRESS,
                            data: callData,
                            value: '0x0',
                            gas: '0x' + (300000).toString(16)
                        }]);
                    } catch (txErr) {
                        var friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(txErr) : ((txErr && txErr.message) ? txErr.message : String(txErr));
                        wcSetAlert('error', '❌ Transaction failed: ' + friendly);
                        btn.disabled = false;
                        btn.textContent = 'Retry — Claim G$';
                        return;
                    }
                    btn.innerHTML = spinner + ' Waiting for confirmation...';
                    wcSetAlert('info', spinner + ' Transaction submitted. Waiting for Celo confirmation...');

                    // Poll receipt via server
                    var confirmed = false;
                    for (var i = 0; i < 40; i++) {
                        await new Promise(r => setTimeout(r, 3000));
                        var rcptRes = await fetch('/api/tx-receipt/' + txHash);
                        var rcpt = await rcptRes.json();
                        if (rcpt.found) {
                            confirmed = true;
                            break;
                        }
                    }

                    var humanAmt = parseFloat(ethers.formatUnits(_voucherPaymentAmount, VGD_DECIMALS)).toFixed(2);
                    var explorerUrl = 'https://celoscan.io/tx/' + txHash;
                    wcSetAlert('success', '✅ Successfully received <strong>' + humanAmt + ' G$</strong>! <a href="' + explorerUrl + '" target="_blank" style="color:#86efac;text-decoration:underline;">View on CeloScan ↗</a>');
                    btn.disabled = true;
                    btn.textContent = '✅ Claimed!';

                    // Confirm the claim server-side (marks the voucher as
                    // claimed) and finally hide the banner.
                    try {
                        await fetch('/api/voucher/confirm', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                tx_hash: txHash,
                                gd_amount: parseFloat(humanAmt),
                            })
                        });
                        document.getElementById('dailyVoucherBanner').style.display = 'none';
                    } catch (_) { /* non-critical, ignore */ }

                } catch(err) {
                    console.error('WC claim error:', err);
                    var friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.message || 'Unknown error');
                    wcSetAlert('error', '❌ Error: ' + friendly);
                    btn.disabled = false;
                    btn.textContent = 'Retry — Claim G$';
                }
            }

            async function claimDailyVoucher() {
                var btn = document.getElementById('claimVoucherBtn');

                // GoodMarket users only: the voucher is reserved for accounts
                // created in the GoodMarket app (local in-app wallet). Fail fast
                // for MetaMask / MiniPay / WalletConnect / Privy logins — the
                // server enforces the same gate, this just saves a round-trip.
                if ((LOGIN_METHOD || '').toLowerCase() !== 'local') {
                    voucherShowSimple('🚫', 'Not Eligible', "You're not eligible to claim this voucher. Only GoodMarket users can claim this voucher.");
                    return;
                }

                // Human-verified users only: if the wallet page already knows
                // this wallet is not face-verified, fail fast — the server
                // enforces the same gate on /api/voucher/claim and /confirm.
                if (window._walletNeedsFV) {
                    voucherShowSimple('🚫', 'Not Eligible', "You're not eligible to claim this voucher. Only human-verified users can claim this voucher. Please complete face verification first.");
                    return;
                }

                if (btn) { btn.disabled = true; btn.textContent = '⏳ Claiming...'; }

                try {
                    var res = await fetch('/api/voucher/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                    var data = await res.json();

                    if (data.success) {
                        // The banner stays visible until the on-chain claim
                        // actually succeeds (confirm POST marks the voucher).
                        // A failed attempt must not consume the voucher.
                        _voucherLink = data.voucher_link;

                        // Try to extract private key from URL hash
                        var privKey = null;
                        try {
                            var parsed = new URL(data.voucher_link);
                            privKey = parsed.hash ? parsed.hash.slice(1) : null;
                        } catch(e) {
                            // fallback: try splitting on #
                            var hashIdx = data.voucher_link.indexOf('#');
                            if (hashIdx !== -1) privKey = data.voucher_link.slice(hashIdx + 1);
                        }

                        var voucherProvider = privKey && privKey.length >= 60 ? await _voucherClaimProvider(false) : null;
                        if (privKey && privKey.length >= 60 && (isServerSigningLoginMethod() || voucherProvider || ((LOGIN_METHOD || '').toLowerCase() === 'privy'))) {
                            // DApp / Privy / MiniPay browser detected — inline claim flow
                            _voucherPaymentPrivKey = privKey;
                            _voucherPaymentWallet = null;
                            _voucherPaymentAmount = null;
                            voucherHideAllStates();
                            document.getElementById('voucherStateDapp').style.display = 'block';
                            voucherShowModal();
                            voucherInitDapp();
                        } else if (privKey && privKey.length >= 60) {
                            // Regular browser — WalletConnect QR flow
                            _voucherPaymentPrivKey = privKey;
                            _voucherPaymentWallet = null;
                            _voucherPaymentAmount = null;
                            await voucherStartWalletConnect(privKey);
                        } else {
                            // No private key extractable — fallback: just show the link
                            voucherShowSimple('🎉', 'Voucher Claimed!', 'Your voucher link: ' + data.voucher_link);
                        }

                    } else if (data.not_eligible) {
                        voucherShowSimple('🚫', 'Not Eligible', data.error || "You're not eligible to claim this voucher. Only GoodMarket users can claim this voucher.");
                    } else if (data.already_claimed) {
                        voucherShowSimple('😔', 'Already Claimed!', 'Someone else already claimed this voucher. Come back next time for a new one!');
                        document.getElementById('dailyVoucherBanner').style.display = 'none';
                    } else {
                        voucherShowSimple('⚠️', 'Not Available', data.error || 'Voucher is not available right now. Please try again later.');
                    }

                } catch (e) {
                    console.error('Claim error:', e);
                    voucherShowSimple('⚠️', 'Error', 'Something went wrong. Please try again.');
                } finally {
                    if (btn) { btn.disabled = false; btn.innerHTML = '🎟️ Claim GoodMarket Voucher'; }
                }
            }

            window.claimDailyVoucher = claimDailyVoucher;
            window.voucherDappClaim = voucherDappClaim;
            window.wcExecuteClaim = wcExecuteClaim;

            checkDailyVoucher();
            voucherCheckInterval = setInterval(checkDailyVoucher, 60000);
        })();
