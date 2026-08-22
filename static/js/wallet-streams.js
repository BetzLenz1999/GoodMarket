// Extracted from templates/wallet.html inline <script> (load-perf refactor).
// Per-request values come from window.GM_WALLET_BOOT (set inline in wallet.html).
// ============================
    // Superfluid P2P Streaming Functions
    // ============================

    // Stream state
    let currentStreamInfo = null;
    let streamConstants = null;
    let streamHistory = [];  // Local storage stream history

    // LocalStorage keys
    const STREAM_HISTORY_KEY = 'goodmarket_stream_history';
    const MAX_HISTORY_ITEMS = 50;

    // Load stream history from localStorage
    function loadStreamHistory() {
        try {
            const stored = localStorage.getItem(STREAM_HISTORY_KEY);
            if (stored) {
                streamHistory = JSON.parse(stored);
            }
        } catch (err) {
            streamHistory = [];
        }
        renderStreamHistory();
    }

    // Save stream history to localStorage
    function saveStreamHistory() {
        try {
            localStorage.setItem(STREAM_HISTORY_KEY, JSON.stringify(streamHistory));
        } catch (err) {
            console.error('Failed to save stream history:', err);
        }
    }

    // Add to stream history
    function addToStreamHistory(entry) {
        streamHistory.unshift({
            ...entry,
            timestamp: Date.now(),
            startTime: entry.status === 'active' ? Date.now() : entry.startTime
        });
        // Keep only last MAX_HISTORY_ITEMS
        if (streamHistory.length > MAX_HISTORY_ITEMS) {
            streamHistory = streamHistory.slice(0, MAX_HISTORY_ITEMS);
        }
        saveStreamHistory();
        renderStreamHistory();
    }

    // Calculate streamed amount based on time and rate
    function calculateStreamedAmount(rate, startTime, isActive) {
        if (!rate || rate <= 0) return 0;
        const now = Date.now();
        const elapsed = (now - startTime) / 1000; // seconds
        const streamedPerSecond = rate / 86400; // G$/day to G$/sec
        return streamedPerSecond * elapsed;
    }

    // Render stream history list with real-time streamed amount
    function renderStreamHistory() {
        const listEl = document.getElementById('streamHistoryList');
        const emptyEl = document.getElementById('streamHistoryEmpty');
        
        if (!listEl) return;
        
        if (streamHistory.length === 0) {
            if (emptyEl) emptyEl.style.display = 'block';
            listEl.innerHTML = '<div id="streamHistoryEmpty" style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:1rem;">No stream history yet</div>';
            return;
        }
        
        if (emptyEl) emptyEl.style.display = 'none';
        
        const html = streamHistory.map((item, idx) => {
            const shortReceiver = item.receiver ? item.receiver.slice(0, 6) + '...' + item.receiver.slice(-4) : '—';
            const date = new Date(item.timestamp).toLocaleDateString();
            
            // Determine actual status based on on-chain data or local record
            let isActuallyActive = item.status === 'active';
            
            // For active streams, show real-time streamed amount
            let streamedAmount = '';
            let statusColor = '#dc2626'; // stopped color default
            let statusText = 'STOPPED';
            
            if (isActuallyActive && item.rate > 0) {
                const streamed = calculateStreamedAmount(item.rate, item.startTime || item.timestamp, true);
                streamedAmount = `<div style="font-size:0.75rem;color:#16a34a;margin-top:0.2rem;">⏱️ Streamed: ${streamed.toFixed(4)} G$</div>`;
                statusColor = '#16a34a';
                statusText = 'ACTIVE';
            } else if (item.totalStreamed) {
                streamedAmount = `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem;">⏱️ Total: ${item.totalStreamed.toFixed(4)} G$</div>`;
                statusColor = '#dc2626';
                statusText = 'STOPPED';
            }
            
            const actionBtns = isActuallyActive ? `
                <button onclick="loadFromHistory(${idx})" style="padding:0.25rem 0.5rem;border-radius:6px;border:1px solid rgba(8,145,178,0.35);background:rgba(8,145,178,0.08);color:#0e7490;font-size:0.7rem;cursor:pointer;margin-right:0.25rem;">Load</button>
                <button onclick="handleStopFromHistory('${item.receiver}')" style="padding:0.25rem 0.5rem;border-radius:6px;border:1px solid rgba(220,38,38,0.3);background:rgba(220,38,38,0.06);color:#dc2626;font-size:0.7rem;cursor:pointer;">Stop</button>
            ` : '';
            
            return `
                <div style="background:rgba(67,56,43,0.03);border:1px solid ${isActuallyActive ? 'rgba(22,163,74,0.25)' : 'rgba(67,56,43,0.09)'};border-radius:8px;padding:0.6rem;margin-bottom:0.5rem;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
                        <span style="font-size:0.75rem;color:${statusColor};font-weight:600;text-transform:uppercase;">● ${statusText}</span>
                        <span style="font-size:0.7rem;color:var(--text-muted);">${date}</span>
                    </div>
                    <div style="font-size:0.8rem;color:var(--text);margin-bottom:0.3rem;">
                        📤 To: <span style="font-family:monospace;">${shortReceiver}</span>
                    </div>
                    <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:0.3rem;">
                        💰 Rate: ${formatStreamHistoryRate(item)}
                    </div>
                    ${streamedAmount}
                    ${actionBtns}
                </div>
            `;
        }).join('');
        
        listEl.innerHTML = html;
        
        // Update every second for active streams
        if (streamHistory.some(h => h.status === 'active')) {
            setTimeout(renderStreamHistory, 1000);
        }
    }

    // Load stream data from history
    function loadFromHistory(idx) {
        if (streamHistory[idx]) {
            const item = streamHistory[idx];
            document.getElementById('streamReceiver').value = item.receiver || '';
            document.getElementById('streamAmount').value = item.rate || '';
            const periodEl = document.getElementById('streamPeriod');
            if (periodEl) periodEl.value = item.period || 'day';
            handleStreamPeriodChange();
            validateStreamReceiver();
            calculateStreamBuffer();
        }
    }

    // Stop stream from history
    async function handleStopFromHistory(receiver) {
        if (!receiver) return;
        document.getElementById('streamReceiver').value = receiver;
        validateStreamReceiver();
        await handleStopStream();
    }

    // Load stream constants on modal open
    async function loadStreamConstants() {
        if (streamConstants) return streamConstants;
        try {
            const res = await fetch('/api/p2p/stream/constants');
            const data = await res.json();
            if (data.success) {
                streamConstants = data.data;
            }
        } catch (err) {
            console.error('Failed to load stream constants:', err);
        }
        return streamConstants;
    }

    // Validate receiver address
    function validateStreamReceiver() {
        const input = document.getElementById('streamReceiver');
        const error = document.getElementById('streamReceiverError');
        const value = input.value.trim();
        
        if (!value) {
            input.style.borderColor = 'var(--card-border)';
            if (error) error.style.display = 'none';
            return false;
        }
        
        const isValid = /^0x[a-fA-F0-9]{40}$/.test(value);
        
        if (!isValid) {
            input.style.borderColor = 'rgba(255,82,82,0.5)';
            if (error) {
                error.textContent = 'Invalid address format';
                error.style.display = 'block';
            }
            return false;
        }
        
        input.style.borderColor = 'rgba(0,230,118,0.5)';
        if (error) error.style.display = 'none';
        return true;
    }

    // Convert the selected stream cadence into the monthly rate expected by the API.
    const STREAM_PERIODS = {
        second: { label: 'second', monthlyMultiplier: 30 * 24 * 60 * 60 },
        minute: { label: 'minute', monthlyMultiplier: 30 * 24 * 60 },
        day: { label: 'day', monthlyMultiplier: 30 },
        week: { label: 'week', monthlyMultiplier: 30 / 7 },
        month: { label: 'month', monthlyMultiplier: 1 }
    };

    function getSelectedStreamPeriod() {
        const period = document.getElementById('streamPeriod')?.value || 'month';
        return STREAM_PERIODS[period] ? period : 'month';
    }

    function getStreamAmountDetails() {
        const amount = parseFloat(document.getElementById('streamAmount').value) || 0;
        const period = getSelectedStreamPeriod();
        const config = STREAM_PERIODS[period];
        return {
            amount,
            period,
            periodLabel: config.label,
            monthlyAmount: amount * config.monthlyMultiplier,
            dailyAmount: (amount * config.monthlyMultiplier) / 30
        };
    }

    function handleStreamPeriodChange() {
        const period = getSelectedStreamPeriod();
        const label = document.getElementById('streamAmountLabel');
        if (label) label.textContent = 'Flow Rate';
        calculateStreamBuffer();
    }

    function formatStreamHistoryRate(item) {
        const period = item.period || 'day';
        const periodLabel = STREAM_PERIODS[period]?.label || period;
        return `${item.rate || '—'} G$/${periodLabel}`;
    }

    function setStreamActionRiskState(hasRisk) {
        const ack = document.getElementById('streamRiskAck');
        const allow = !hasRisk || !!ack?.checked;
        ['btnStartStream', 'btnUpdateStream'].forEach((id) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.disabled = !allow;
            btn.style.opacity = allow ? '1' : '0.55';
            btn.style.cursor = allow ? 'pointer' : 'not-allowed';
        });
    }

    // Calculate buffer when amount or cadence changes.
    async function calculateStreamBuffer() {
        const { amount, periodLabel, monthlyAmount } = getStreamAmountDetails();
        const bufferInfo = document.getElementById('streamBufferInfo');
        const balanceWarning = document.getElementById('streamBalanceWarning');
        
        if (amount <= 0) {
            if (bufferInfo) bufferInfo.style.display = 'none';
            if (balanceWarning) balanceWarning.style.display = 'none';
            setStreamActionRiskState(false);
            return;
        }
        
        try {
            const res = await fetch(`/api/p2p/buffer/calculate?flow_rate_per_month=${monthlyAmount}`);
            const data = await res.json();
            
            if (data.success) {
                const flowPerSec = (data.flow_rate / 1e18).toFixed(8);
                const monthlyEl = document.getElementById('streamMonthlyDisplay');
                const flowEl = document.getElementById('streamFlowRateDisplay');
                const bufferEl = document.getElementById('streamBufferDisplay');
                const totalEl = document.getElementById('streamTotalDisplay');
                const userBalanceEl = document.getElementById('streamUserBalance');
                const remainingEl = document.getElementById('streamRemainingBalance');
                
                if (monthlyEl) monthlyEl.textContent = `${amount.toFixed(2)} G$/${periodLabel} · ${monthlyAmount.toFixed(2)} G$/month`;
                if (flowEl) flowEl.textContent = `${flowPerSec} G$/sec`;
                if (bufferEl) bufferEl.textContent = `${data.required_buffer.toFixed(2)} G$`;
                if (totalEl) totalEl.textContent = `${data.total_required.toFixed(2)} G$`;
                if (bufferInfo) bufferInfo.style.display = 'block';
                
                // Get user balance and calculate remaining
                const userBalance = typeof gdBal !== 'undefined' ? gdBal : 0;
                if (userBalanceEl) userBalanceEl.textContent = `${userBalance.toFixed(2)} G$`;
                
                const remaining = userBalance - data.required_buffer;
                if (remainingEl) {
                    remainingEl.textContent = `${remaining.toFixed(2)} G$`;
                    remainingEl.style.color = remaining >= 0 ? '#16a34a' : '#dc2626';
                }
                
                // Check balance and show warning
                if (userBalance < data.required_buffer) {
                    if (balanceWarning) {
                        balanceWarning.style.display = 'block';
                        const warningText = document.getElementById('streamBalanceWarningText');
                        if (warningText) {
                            const shortfall = (data.required_buffer - userBalance).toFixed(2);
                            warningText.textContent = `Your balance after the upfront buffer will be negative by ${shortfall} G$. If you do not cancel this stream before your balance reaches zero, you may lose the required buffer.`;
                        }
                    }
                } else {
                    if (balanceWarning) {
                        balanceWarning.style.display = 'none';
                        const ack = document.getElementById('streamRiskAck');
                        if (ack) ack.checked = false;
                    }
                }
                setStreamActionRiskState(userBalance < data.required_buffer);
            }
        } catch (err) {
            console.error('Failed to calculate buffer:', err);
        }
    }

    // Load incoming stream info
    async function loadIncomingStreamInfo() {
        try {
            const res = await fetch(`/api/p2p/stream/summary?wallet=${WALLET}`);
            const data = await res.json();
            
            const badge = document.getElementById('incomingStreamBadge');
            const rate = document.getElementById('incomingStreamRate');
            const from = document.getElementById('incomingStreamFrom');
            
            if (data.success && data.net_flow_rate > 0) {
                // Convert to daily rate
                const dailyRate = (data.net_flow_rate / 1e18 * 86400).toFixed(4);
                if (badge) {
                    badge.textContent = 'Active';
                    badge.style.background = 'rgba(22,163,74,0.12)';
                    badge.style.color = '#15803d';
                }
                if (rate) rate.textContent = `${dailyRate} G$/day`;
                if (from) from.textContent = 'Someone';
            } else {
                if (badge) {
                    badge.textContent = 'No incoming stream';
                    badge.style.background = 'rgba(67,56,43,0.07)';
                    badge.style.color = 'var(--text-dim)';
                }
                if (rate) rate.textContent = '— G$/day';
                if (from) from.textContent = '—';
            }
        } catch (err) {
            console.error('Failed to load incoming stream info:', err);
        }
    }

    // Get provider for signing (Injected or WalletConnect)
    async function _getSigningProvider() {
        // Local self-custodial logins unlock the PIN-decrypted in-app wallet and
        // sign with it — never fall through to an injected provider (a
        // different account).
        if ((LOGIN_METHOD || '').toLowerCase() === 'local' && typeof GMLocalWallet !== 'undefined') {
            if (!GMLocalWallet.isUnlocked()) {
                if (typeof _lwUnlockIfNeeded === 'function') {
                    await _lwUnlockIfNeeded();
                } else if (typeof window._lwOpenUnlockModal === 'function') {
                    await window._lwOpenUnlockModal();
                } else {
                    throw new Error('Please unlock your wallet. Reload the page and log in again.');
                }
            }
            return GMLocalWallet.getProvider();
        }
        return _awaitEthProvider();
    }

    // Sign transaction with wallet
    async function signTransaction(txData) {
        const provider = await _getSigningProvider();
        if (!provider) {
            throw new Error('No wallet connected. Please connect your wallet.');
        }
        
        // The in-app local wallet always reports Celo (0xa4ec) — asking it to
        // switch chains is both pointless and unsupported.
        const isLocalProvider = !!provider.isGMLocalWallet;

        try {
            // First check current chain
            const chainId = await provider.request({ method: 'eth_chainId' });
            const currentChainId = parseInt(chainId, 16);

            if (currentChainId !== 42220 && !isLocalProvider) {
                // Try to switch to Celo
                try {
                    await provider.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: '0xa4ec' }] // 0xa4ec = 42220 in hex
                    });
                } catch (switchErr) {
                    console.error('Chain switch error:', switchErr);
                    throw new Error('Please switch to Celo network (chainId: 42220)');
                }
            }
            
            const accounts = await provider.request({ method: 'eth_requestAccounts' });
            if (!accounts || accounts.length === 0) {
                throw new Error('No accounts found. Please unlock your wallet.');
            }
            
            const connectedAccount = accounts[0].toLowerCase();
            const expectedAccount = WALLET.toLowerCase();
            
            if (connectedAccount !== expectedAccount) {
                throw new Error(`Wrong wallet. Expected ${expectedAccount.slice(0, 10)}..., got ${connectedAccount.slice(0, 10)}...`);
            }
            
            // Build transaction params with gas
            const txParams = {
                from: connectedAccount,
                to: txData.to,
                data: txData.data,
                value: txData.value || '0x0',
                chainId: '0xa4ec' // Celo chainId in hex (42220)
            };
            
            // Add gas estimate if possible
            try {
                const gasEstimate = await provider.request({
                    method: 'eth_estimateGas',
                    params: [txParams]
                });
                txParams.gas = gasEstimate;
            } catch (gasErr) {
                // Use default gas if estimate fails
                txParams.gas = '0x1dcd6' // ~200000 gas
            }
            
            const txHash = await provider.request({
                method: 'eth_sendTransaction',
                params: [txParams]
            });
            
            return txHash;
        } catch (err) {
            if (err.code === 4001 || err.message?.includes('rejected') || err.code === 'ACTION_REJECTED') {
                throw new Error('Transaction rejected by user.');
            }
            // Re-throw with more context
            throw err;
        }
    }

    // Handle start stream
    async function handleStartStream() {
        const receiver = document.getElementById('streamReceiver').value.trim();
        const { amount, period, periodLabel, monthlyAmount, dailyAmount } = getStreamAmountDetails();
        
        // Validate inputs
        if (!receiver || !/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
            const result = document.getElementById('streamResult');
            result.innerHTML = '<div style="color:#dc2626;">❌ Please enter a valid wallet address</div>';
            result.style.display = 'block';
            return;
        }
        
        if (!amount || amount <= 0) {
            const result = document.getElementById('streamResult');
            result.innerHTML = '<div style="color:#dc2626;">❌ Please enter a valid stream amount</div>';
            result.style.display = 'block';
            return;
        }
        if (document.getElementById('streamBalanceWarning')?.style.display !== 'none' && !document.getElementById('streamRiskAck')?.checked) {
            const result = document.getElementById('streamResult');
            result.innerHTML = '<div style="color:#dc2626;">❌ Please confirm the stream risk warning first.</div>';
            result.style.display = 'block';
            return;
        }
        
        const loading = document.getElementById('streamLoading');
        const result = document.getElementById('streamResult');
        
        try {
            loading.style.display = 'block';
            result.style.display = 'none';
            
            const prepareRes = await fetch('/api/p2p/stream/create/prepare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    receiver: receiver,
                    flow_rate_per_month: monthlyAmount
                })
            });
            
            const prepareData = await prepareRes.json();
            
            if (!prepareData.success) {
                throw new Error(prepareData.error || 'Failed to prepare transaction');
            }
            
            // Pass the full txData object to signTransaction
            const txData = {
                to: prepareData.data.to,
                data: prepareData.data.data,
                value: prepareData.data.value || '0x0'
            };
            const txHash = await signTransaction(txData);
            
            // Add to local history
            addToStreamHistory({
                receiver: receiver,
                rate: amount,
                period: period,
                dailyRate: dailyAmount,
                status: 'active',
                txHash: txHash
            });
            
            // Record to Supabase
            try {
                await fetch('/api/streaming/record', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        wallet_address: WALLET,
                        type: 'outgoing',
                        counterparty: receiver,
                        flow_rate_per_day: dailyAmount,
                        flow_rate_per_month: monthlyAmount,
                        flow_rate_period: period,
                        flow_rate_amount: amount,
                        tx_hash: txHash
                    })
                });
            } catch (supabaseErr) {
                console.error('Failed to record to Supabase:', supabaseErr);
            }
            
            result.innerHTML = `
                <div style="color:#16a34a;margin-bottom:0.5rem;">✅ Stream created!</div>
                <div style="color:var(--text-dim);font-size:0.75rem;">TX: ${txHash.slice(0, 10)}...</div>
            `;
            window.dispatchEvent(new CustomEvent('goodmarket:ai-tx-success', {
                detail: {
                    txHash: txHash,
                    explorerUrl: `https://celoscan.io/tx/${txHash}`,
                    message: `✅ G$ stream created successfully. Tx hash: ${txHash.slice(0, 10)}…${txHash.slice(-6)}`
                }
            }));
            result.style.display = 'block';
            
            setTimeout(() => {
                loadIncomingStreamInfo();
            }, 3000);
            
        } catch (err) {
            const errorMsg = err.message || 'Transaction failed';
            result.innerHTML = `<div style="color:#dc2626;">❌ ${errorMsg}</div>`;
            result.style.display = 'block';
            window.dispatchEvent(new CustomEvent('goodmarket:ai-tx-failed', {
                detail: {
                    error: errorMsg,
                    message: `❌ Stream failed: ${errorMsg}`
                }
            }));
        } finally {
            loading.style.display = 'none';
        }
    }

    // Handle update stream
    async function handleUpdateStream() {
        const receiver = document.getElementById('streamReceiver').value.trim();
        const { amount, period, monthlyAmount, dailyAmount } = getStreamAmountDetails();
        
        // Validate inputs
        if (!receiver || !/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
            const result = document.getElementById('streamResult');
            result.innerHTML = '<div style="color:#dc2626;">❌ Please enter a valid wallet address</div>';
            result.style.display = 'block';
            return;
        }
        
        if (amount < 0) {
            const result = document.getElementById('streamResult');
            result.innerHTML = '<div style="color:#dc2626;">❌ Please enter a valid amount</div>';
            result.style.display = 'block';
            return;
        }
        if (document.getElementById('streamBalanceWarning')?.style.display !== 'none' && !document.getElementById('streamRiskAck')?.checked) {
            const result = document.getElementById('streamResult');
            result.innerHTML = '<div style="color:#dc2626;">❌ Please confirm the stream risk warning first.</div>';
            result.style.display = 'block';
            return;
        }
        
        const loading = document.getElementById('streamLoading');
        const result = document.getElementById('streamResult');
        
        try {
            loading.style.display = 'block';
            result.style.display = 'none';
            
            const prepareRes = await fetch('/api/p2p/stream/update/prepare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    receiver: receiver,
                    new_flow_rate_per_month: monthlyAmount
                })
            });
            
            const prepareData = await prepareRes.json();
            
            if (!prepareData.success) {
                throw new Error(prepareData.error || 'Failed to prepare transaction');
            }
            
            // Pass the full txData object to signTransaction
            const txData = {
                to: prepareData.data.to,
                data: prepareData.data.data,
                value: prepareData.data.value || '0x0'
            };
            const txHash = await signTransaction(txData);
            
            // Update history
            addToStreamHistory({
                receiver: receiver,
                rate: amount,
                period: period,
                dailyRate: dailyAmount,
                status: 'active',
                txHash: txHash
            });
            
            result.innerHTML = `
                <div style="color:#16a34a;margin-bottom:0.5rem;">✅ Stream updated!</div>
                <div style="color:var(--text-dim);font-size:0.75rem;">TX: ${txHash.slice(0, 10)}...</div>
            `;
            result.style.display = 'block';
            
            setTimeout(() => {
                loadIncomingStreamInfo();
            }, 3000);
            
        } catch (err) {
            const errorMsg = err.message || 'Transaction failed';
            result.innerHTML = `<div style="color:#dc2626;">❌ ${errorMsg}</div>`;
            result.style.display = 'block';
        } finally {
            loading.style.display = 'none';
        }
    }

    // Handle stop stream
    async function handleStopStream() {
        const receiver = document.getElementById('streamReceiver').value.trim();
        
        if (!receiver) {
            return;
        }
        
        const loading = document.getElementById('streamLoading');
        const result = document.getElementById('streamResult');
        
        try {
            loading.style.display = 'block';
            result.style.display = 'none';
            
            const prepareRes = await fetch('/api/p2p/stream/delete/prepare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    receiver: receiver
                })
            });
            
            const prepareData = await prepareRes.json();
            
            if (!prepareData.success) {
                throw new Error(prepareData.error || 'Failed to prepare transaction');
            }
            
            // Pass the full txData object to signTransaction
            const txData = {
                to: prepareData.data.to,
                data: prepareData.data.data,
                value: prepareData.data.value || '0x0'
            };
            const txHash = await signTransaction(txData);
            
            // Update the active stream in history to stopped with total streamed
            const activeIndex = streamHistory.findIndex(h => h.receiver === receiver && h.status === 'active');
            if (activeIndex !== -1) {
                const activeStream = streamHistory[activeIndex];
                const totalStreamed = calculateStreamedAmount(
                    activeStream.rate, 
                    activeStream.startTime || activeStream.timestamp, 
                    true
                );
                // Remove the active entry and add stopped entry
                streamHistory.splice(activeIndex, 1);
                addToStreamHistory({
                    receiver: receiver,
                    rate: activeStream.rate,
                    status: 'stopped',
                    txHash: txHash,
                    totalStreamed: totalStreamed,
                    startTime: activeStream.startTime || activeStream.timestamp,
                    stoppedTime: Date.now()
                });
                
                // Update Supabase record
                try {
                    await fetch('/api/streaming/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            tx_hash: txHash,
                            status: 'stopped',
                            total_streamed: totalStreamed
                        })
                    });
                } catch (supabaseErr) {
                    console.error('Failed to update Supabase:', supabaseErr);
                }
            } else {
                addToStreamHistory({
                    receiver: receiver,
                    rate: 0,
                    status: 'stopped',
                    txHash: txHash
                });
            }
            
            result.innerHTML = `
                <div style="color:#16a34a;margin-bottom:0.5rem;">✅ Stream stopped!</div>
                <div style="color:var(--text-dim);font-size:0.75rem;">Buffer returned. TX: ${txHash.slice(0, 10)}...</div>
            `;
            result.style.display = 'block';
            
            setTimeout(() => {
                loadIncomingStreamInfo();
            }, 3000);
            
        } catch (err) {
            const errorMsg = err.message || 'Transaction failed';
            result.innerHTML = `<div style="color:#dc2626;">❌ ${errorMsg}</div>`;
            result.style.display = 'block';
        } finally {
            loading.style.display = 'none';
        }
    }

    // Override openModal to load stream info when stream modal opens
    const _originalOpenModal = window.openModal;
    function _forceEditable(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.removeAttribute('readonly');
        el.removeAttribute('disabled');
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'text';
    }
    window.openModal = function(modalId) {
        if (modalId === 'sendModal') {
            setTimeout(function() {
                _forceEditable('sendTo');
                _forceEditable('sendAmount');
            }, 100);
        }
        if (modalId === 'streamModal') {
            loadStreamConstants();
            loadIncomingStreamInfo();
            loadStreamHistory();
            
            // Ensure inputs are always editable
            setTimeout(function() {
                const receiverInput = document.getElementById('streamReceiver');
                const amountInput = document.getElementById('streamAmount');
                
                if (receiverInput) {
                    receiverInput.removeAttribute('readonly');
                    receiverInput.removeAttribute('disabled');
                    receiverInput.style.pointerEvents = 'auto';
                    receiverInput.style.cursor = 'text';
                }
                
                if (amountInput) {
                    amountInput.removeAttribute('readonly');
                    amountInput.removeAttribute('disabled');
                    amountInput.style.pointerEvents = 'auto';
                    amountInput.style.cursor = 'text';
                }
            }, 100);
        }
        return _originalOpenModal(modalId);
    };
