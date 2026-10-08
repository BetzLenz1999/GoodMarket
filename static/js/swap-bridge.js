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
 *   swap-bridge.js   — Bridge, signer resolution, GoodSwap (Uniswap) + Fuse
 *   swap-reserve.js  — GoodReserve (Mento) buy/sell + tab switching
 *   swap-bridge.js   — Bridge tab: Celo <-> XDC (Celo->XDC and XDC->Celo legs)
 */

// ──────────────────────────────────────────────────────────────────
// Celo G$ → XDC G$ bridge
// Aligned with https://docs.gooddollar.org/user-guides/bridge-gooddollars
// GoodDollar MessagePassingBridge — same address on every chain.
// For Celo↔XDC the only supported service is LayerZero (`bridge=1`).
// Fee is paid as native CELO via msg.value.
// ──────────────────────────────────────────────────────────────────
const CELO_TO_XDC_BRIDGE_CONTRACT = window.GM_SWAP_BOOT.bridgeContract;
const CELO_TO_XDC_GD_TOKEN        = window.GM_SWAP_BOOT.celoGdTokenContract;
const CELO_TO_XDC_TARGET_CHAIN_ID = Number(window.GM_SWAP_BOOT.xdcChainId);
const CELO_TO_XDC_SOURCE_CHAIN_ID = Number(window.GM_SWAP_BOOT.celoChainId);
const CELO_TO_XDC_BRIDGE_ABI = [
    "function bridgeTo(address target, uint256 targetChainId, uint256 amount, uint8 bridge) payable",
    // Per the deployed contract on Celo, canBridge actually returns
    // `(bool, string)` where the string is the rejection reason
    // (e.g. "minAmount", "txLimit", "dailyLimit"). The earlier
    // `bool`-only ABI was wrong and silently swallowed the reason.
    "function canBridge(address from, uint256 amount) view returns (bool, string)",
    // Owner/guardian kill-switch. When true every outbound bridgeTo
    // reverts BRIDGE_LIMITS('closed'). Read so the tab can pre-disable
    // instead of letting the user reach a guaranteed revert. This is
    // live on-chain state (GoodDollar flips it via pauseBridge), NOT a
    // deploy-time constant — it clears itself the moment they reopen.
    "function isClosed() view returns (bool)",
    // (uint128 dailyLimit, uint128 txLimit, uint128 accountDailyLimit, uint64 minAmount, bool onlyWhitelisted)
    "function bridgeLimits() view returns (uint128, uint128, uint128, uint64, bool)",
    // (uint128 minFee, uint128 maxFee, uint128 feeBPS) — feeBPS is in basis points (1 bps = 0.01%)
    "function bridgeFees() view returns (uint128, uint128, uint128)"
];
const CELO_TO_XDC_ERC20_ABI = [
    "function approve(address spender, uint256 value) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)"
];
const CELO_TO_XDC_BRIDGE_SERVICE_LAYERZERO = 1;
// GoodMarket-side minimum bridge amount. Sits *above* the on-chain
// contract minimum (10 G$) so the bridge tab is only used for
// amounts that are actually worth the LayerZero CELO fee. Edit
// this single constant to change the gate everywhere.
const CELO_TO_XDC_UI_MIN_AMOUNT_GD = 2000;
// Fallback fee mirrors goodserver/estimatefees current LZ_CELO_TO_XDC.
// Padded by the safety multiplier in /api/xdc/bridge/estimate-fee, so
// the displayed default already includes a small margin for LayerZero
// fee fluctuations between estimate and submit.
const CELO_TO_XDC_FALLBACK_FEE_CELO = 0.1156;
// Realistic worst-case gas units for the two on-chain operations the
// bridge tab triggers. Used together with the live `eth_gasPrice` to
// size a *dynamic* gas reserve in the preflight balance check, so
// the user gets a clear app-side alert instead of MetaMask's red
// "Network fee ⚠" warning when Celo gas prices spike. The bridge
// figure mirrors `bridgeTo()` gasUsed observed against the live
// contract on Celo (~470k); the approve figure is the typical
// ERC-20 `approve()` cost on Celo (~50k).
const CELO_TO_XDC_BRIDGE_TO_GAS_LIMIT = 500000n;
const CELO_TO_XDC_APPROVE_GAS_LIMIT   = 60000n;
// Pad applied to a *successful* eth_estimateGas result so the
// preflight tracks what a wallet (MetaMask, WalletConnect) will
// actually reserve as `gasLimit` at submit time. Wallets typically
// pad by ~1.20×, but we keep it tighter so accounts that just
// barely cover the real cost still pass.
const CELO_TO_XDC_ESTIMATE_PAD_BPS    = 1500n; // +15%
// Headroom on top of (gasUnits × gasPrice) so a small gas-price
// tick between preflight and submission doesn't knock the user
// back out of the check.
const CELO_TO_XDC_GAS_RESERVE_BUFFER_BPS = 500n; // +5%
// Static fallback reserve when we can't fetch gasPrice (RPC down).
// Sized for a realistic high-gas Celo environment so users still
// don't slip past the preflight when the dynamic path fails
// (200 gwei × 500k gas ≈ 0.10 CELO, padded for safety).
const CELO_TO_XDC_GAS_RESERVE_FALLBACK_CELO = 0.13;
// Tiny rounding safety so the preflight never approves a tx that
// ends up 1 wei short of MetaMask's gas estimate.
const CELO_TO_XDC_GAS_RESERVE_FLOOR_CELO    = 0.005;

let _celoBridgeFeeSourceState = 'manual';
let _celoBridgeFeeEstimateDebounce = null;
let _celoBridgeAttemptContext = null;
let _celoBridgeRecommendedFeeWei = null;
// Cached on-chain limits/fees from the Celo bridge contract. Loaded
// once when the bridge tab is first viewed; used to pre-validate
// amounts and to display correct net G$ on XDC.
let _celoBridgeLimitsCache = null; // { dailyLimit, txLimit, accountDailyLimit, minAmount } as bigint G$ wei
let _celoBridgeFeesCache  = null;  // { minFee, maxFee, feeBPS } as bigint G$ wei + bps
// Live pause state of the bridge contract on Celo. null = not read yet.
// Deliberately read fresh each visit and NOT persisted, so GoodDollar
// reopening the route restores bridging with no deploy on our side.
let _celoBridgeClosedCache = null;

// Single source of truth for the wording used whenever the bridge
// contract's owner/guardian has paused the route. Mirrors the
// BRIDGE_LIMITS('closed') custom error surfaced by the contract.
const CELO_BRIDGE_PAUSED_REASON =
    'The GoodDollar bridge is temporarily paused by the GoodDollar team. ' +
    'Bridging is unavailable until they re-open it — no funds are at risk. ' +
    'Please try again later.';

function _formatBridgeAmountCelo(value, symbol = 'G$') {
    const num = Number(value || 0);
    if (!isFinite(num) || num <= 0) return `0.000000 ${symbol}`;
    const decimals = num >= 1 ? 6 : 8;
    return `${num.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${symbol}`;
}
function _formatBridgeFeeCelo(value) {
    const num = Number(value || 0);
    if (!isFinite(num) || num <= 0) return '0.000000 CELO';
    return `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} CELO`;
}

function showCeloBridgeAlert(type, msg) {
    const el = document.getElementById('bridgeAlertCeloToXdc');
    if (!el) return;
    el.className = 'alert ' + (type || 'alert-info') + ' show';
    el.innerHTML = msg;
}
function clearCeloBridgeAlert() {
    const el = document.getElementById('bridgeAlertCeloToXdc');
    if (!el) return;
    el.className = 'alert';
    el.innerHTML = '';
}

// Returns a wei-denominated gas reserve for the bridgeTo() call (and
// the optional preceding approve() when allowance < amount), sized
// against the live `eth_gasPrice` so the preflight matches what the
// user's wallet will actually quote at signing time. Falls back to a
// realistic high-gas static reserve if RPC calls fail — we still
// want the preflight to be useful when the public Celo RPC is flaky,
// just less precise.
async function _estimateCeloBridgeGasReserveWei(provider, fromAddr, amountWei, feeWei, needsApprove) {
    const fallbackWei = ethers.parseUnits(String(CELO_TO_XDC_GAS_RESERVE_FALLBACK_CELO), 18);
    const floorWei    = ethers.parseUnits(String(CELO_TO_XDC_GAS_RESERVE_FLOOR_CELO), 18);
    try {
        let gasPriceWei = 0n;
        try {
            const feeData = await provider.getFeeData();
            if (feeData?.maxFeePerGas && feeData.maxFeePerGas > 0n) {
                gasPriceWei = feeData.maxFeePerGas;
            } else if (feeData?.gasPrice && feeData.gasPrice > 0n) {
                gasPriceWei = feeData.gasPrice;
            }
        } catch (_) { /* fall through */ }
        if (gasPriceWei === 0n) {
            // Last-resort: explicit eth_gasPrice (older RPC nodes).
            try {
                const hex = await provider.send('eth_gasPrice', []);
                if (typeof hex === 'string' && hex.startsWith('0x')) {
                    gasPriceWei = BigInt(hex);
                }
            } catch (_) { /* fall through */ }
        }
        if (gasPriceWei === 0n) {
            // No gasPrice available → use a flat static reserve plus
            // a smaller approve overhead when we know an approve is
            // pending. Better than letting the user slip into the
            // signing flow blind.
            return needsApprove
                ? ((fallbackWei * 11500n) / 10000n)
                : fallbackWei;
        }

        // Prefer a real estimate against the live bridge contract so
        // we capture any future increase in the contract's gas
        // footprint. eth_estimateGas reverts if the user's allowance
        // < amount (the bridge burnFrom would fail), in which case we
        // fall back to the worst-case static bridge gas limit — the
        // actual bridge tx happens *after* approve confirms, so the
        // static limit is what MetaMask will end up using anyway.
        let bridgeGasUnits = CELO_TO_XDC_BRIDGE_TO_GAS_LIMIT;
        try {
            const bridgeIface = new ethers.Interface(CELO_TO_XDC_BRIDGE_ABI);
            const callData = bridgeIface.encodeFunctionData('bridgeTo', [
                fromAddr,
                CELO_TO_XDC_TARGET_CHAIN_ID,
                amountWei,
                CELO_TO_XDC_BRIDGE_SERVICE_LAYERZERO,
            ]);
            const estimated = await provider.estimateGas({
                from: fromAddr,
                to: CELO_TO_XDC_BRIDGE_CONTRACT,
                data: callData,
                value: feeWei,
            });
            if (estimated && estimated > 0n) {
                const padded = (estimated * (10000n + CELO_TO_XDC_ESTIMATE_PAD_BPS)) / 10000n;
                // Don't go below the realistic worst case — we've
                // seen 470k on Celo mainnet, so 500k floor catches
                // chain conditions where eth_estimateGas slightly
                // under-counts.
                bridgeGasUnits = padded > CELO_TO_XDC_BRIDGE_TO_GAS_LIMIT ? padded : CELO_TO_XDC_BRIDGE_TO_GAS_LIMIT;
            }
        } catch (_) { /* keep static gas limit */ }

        let totalGasUnits = bridgeGasUnits;
        if (needsApprove) totalGasUnits += CELO_TO_XDC_APPROVE_GAS_LIMIT;

        const rawCostWei = totalGasUnits * gasPriceWei;
        const buffered   = (rawCostWei * (10000n + CELO_TO_XDC_GAS_RESERVE_BUFFER_BPS)) / 10000n;
        return buffered > floorWei ? buffered : floorWei;
    } catch (_) {
        return fallbackWei;
    }
}

async function _celoBridgeDebugLog(event, details = {}) {
    try {
        const payload = {
            event: event,
            attempt_id: _celoBridgeAttemptContext?.attempt_id || null,
            details: Object.assign({ direction: 'celo_to_xdc' }, details || {})
        };
        await fetch('/api/xdc/bridge/debug-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (_) { /* best-effort */ }
}

async function _loadCeloBridgeLimitsAndFees() {
    // Fetches the on-chain limits + fees once and caches them. The
    // values here are baked into the deployed bridge contract — the
    // GoodDollar docs at the top-level page don't reproduce them, so
    // we read them straight from the source of truth on Celo mainnet.
    if (_celoBridgeLimitsCache && _celoBridgeFeesCache) {
        _applyCeloBridgePausedState();
        return { limits: _celoBridgeLimitsCache, fees: _celoBridgeFeesCache };
    }
    try {
        const provider = new ethers.JsonRpcProvider(CELO_RPC);
        const bridge = new ethers.Contract(CELO_TO_XDC_BRIDGE_CONTRACT, CELO_TO_XDC_BRIDGE_ABI, provider);
        const [limits, fees, closed] = await Promise.all([
            bridge.bridgeLimits(),
            bridge.bridgeFees(),
            // Soft-fail: a flaky RPC must not hard-block a working
            // bridge. canBridge() at click time is still the gate.
            bridge.isClosed().catch(() => false)
        ]);
        _celoBridgeLimitsCache = {
            dailyLimit:        BigInt(limits[0]),
            txLimit:           BigInt(limits[1]),
            accountDailyLimit: BigInt(limits[2]),
            minAmount:         BigInt(limits[3]),
            onlyWhitelisted:   Boolean(limits[4])
        };
        _celoBridgeFeesCache = {
            minFee: BigInt(fees[0]),
            maxFee: BigInt(fees[1]),
            feeBPS: BigInt(fees[2])
        };
        _celoBridgeClosedCache = Boolean(closed);
        _applyCeloBridgePausedState();
        return { limits: _celoBridgeLimitsCache, fees: _celoBridgeFeesCache };
    } catch (err) {
        console.warn('[bridge celo→xdc] failed to load on-chain limits/fees', err);
        return { limits: null, fees: null };
    }
}

// Reflects the bridge contract's live pause state on the Celo → XDC
// controls. Called on every limits refresh so the tab self-heals when
// GoodDollar re-opens the route (no redeploy needed on our side).
// Tracks the last applied value so a refresh triggered mid-flow (e.g.
// the post-bridge balance reload) can't clobber the in-flight spinner
// label the click handler owns.
let _celoBridgePausedApplied = null;

function _applyCeloBridgePausedState() {
    const paused = _celoBridgeClosedCache === true;
    const btn = document.getElementById('btnBridgeCeloToXdc');
    const estimateBtn = document.getElementById('btnBridgeEstimateFeeCeloToXdc');
    const amountInput = document.getElementById('bridgeAmountCeloToXdc');
    const alertEl = document.getElementById('bridgeAlertCeloToXdc');

    const alertShowsPause = Boolean(alertEl && alertEl.textContent.includes('temporarily paused'));
    if (_celoBridgePausedApplied === paused && (paused === alertShowsPause)) return;
    _celoBridgePausedApplied = paused;

    if (btn) {
        btn.disabled = paused;
        btn.innerHTML = paused ? 'Bridge temporarily paused' : 'Bridge to XDC';
        btn.title = paused ? CELO_BRIDGE_PAUSED_REASON : '';
    }
    if (estimateBtn) estimateBtn.disabled = paused;
    if (amountInput) amountInput.disabled = paused;

    if (paused && alertEl) {
        showCeloBridgeAlert('alert-error', '⏸️ ' + CELO_BRIDGE_PAUSED_REASON);
    } else if (!paused && alertEl && alertShowsPause) {
        // Route reopened — clear the pause banner we own so a stale
        // "paused" message never outlives the actual state.
        clearCeloBridgeAlert();
    }
}

function _computeCeloBridgeProtocolFeeGdWei(amountWei) {
    // Mirrors what the bridge does on-chain when computing the
    // G$-denominated protocol fee that is deducted from the bridged
    // amount — i.e. fee = clamp(amount * feeBPS / 10000, minFee, maxFee).
    // The user receives `amount - fee` G$ on the destination chain.
    if (!_celoBridgeFeesCache) return null;
    const { minFee, maxFee, feeBPS } = _celoBridgeFeesCache;
    try {
        let fee = (amountWei * feeBPS) / 10000n;
        if (fee < minFee) fee = minFee;
        if (maxFee > 0n && fee > maxFee) fee = maxFee;
        if (fee < 0n) fee = 0n;
        return fee;
    } catch (_) {
        return null;
    }
}

function updateCeloBridgeBalanceDisplay() {
    const fromEl = document.getElementById('bridgeFromBalance');
    const feeEl  = document.getElementById('bridgeFeeBalance');
    if (fromEl) {
        const gd = (typeof gdBalanceNum === 'number') ? gdBalanceNum : 0;
        fromEl.textContent = gd.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' G$';
    }
    if (feeEl) {
        const celo = (typeof celoBalanceNum === 'number') ? celoBalanceNum : 0;
        feeEl.textContent = celo.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' CELO';
    }
    // Best-effort load — won't block the UI.
    _loadCeloBridgeLimitsAndFees().then(() => {
        _renderCeloBridgeLimitsHint();
        updateCeloBridgeSummary();
    }).catch(() => { /* no-op */ });
    updateCeloBridgeSummary();
}

function _renderCeloBridgeLimitsHint() {
    const el = document.getElementById('bridgeLimitsHintCeloToXdc');
    if (!el) return;
    if (!_celoBridgeLimitsCache || !_celoBridgeFeesCache) {
        el.textContent = '';
        return;
    }
    const onChainMinG = Number(ethers.formatUnits(_celoBridgeLimitsCache.minAmount, 18));
    // GoodMarket gates the tab at a higher minimum than the bridge
    // contract's 10 G$ floor — display whichever is stricter.
    const minG = Math.max(onChainMinG, CELO_TO_XDC_UI_MIN_AMOUNT_GD);
    const txG  = Number(ethers.formatUnits(_celoBridgeLimitsCache.txLimit,   18));
    const minFeeG = Number(ethers.formatUnits(_celoBridgeFeesCache.minFee, 18));
    const maxFeeG = Number(ethers.formatUnits(_celoBridgeFeesCache.maxFee, 18));
    const bps = Number(_celoBridgeFeesCache.feeBPS);
    const feePct = (bps / 100).toFixed(2);
    el.innerHTML =
        `Min bridgeable: <strong>${minG.toLocaleString(undefined,{maximumFractionDigits:2})} G$</strong> · ` +
        `Max per tx: <strong>${txG.toLocaleString(undefined,{maximumFractionDigits:2})} G$</strong> · ` +
        `Protocol fee: <strong>${feePct}%</strong> ` +
        `(min ${minFeeG.toLocaleString(undefined,{maximumFractionDigits:2})} G$, ` +
        `max ${maxFeeG.toLocaleString(undefined,{maximumFractionDigits:2})} G$)`;
}

function setBridgeMaxCeloToXdc() {
    const gd = (typeof gdBalanceNum === 'number') ? gdBalanceNum : 0;
    const input = document.getElementById('bridgeAmountCeloToXdc');
    if (!input) return;
    // Cap at the on-chain per-tx limit when known (≈ 4,577 G$ today),
    // not at a generic doc-level 300M cap. Falls back to 300M only if
    // the on-chain values aren't loaded yet.
    let cap = gd;
    if (_celoBridgeLimitsCache && _celoBridgeLimitsCache.txLimit > 0n) {
        const txG = Number(ethers.formatUnits(_celoBridgeLimitsCache.txLimit, 18));
        cap = Math.min(cap, txG);
    } else {
        cap = Math.min(cap, 300_000_000);
    }
    input.value = cap > 0 ? cap.toFixed(6) : '';
    updateCeloBridgeSummary();
    scheduleCeloBridgeFeeEstimate();
}

function markCeloBridgeFeeManual() {
    _celoBridgeRecommendedFeeWei = null;
    _celoBridgeFeeSourceState = 'manual';
    const sourceEl = document.getElementById('bridgeFeeSourceCeloToXdc');
    if (sourceEl) sourceEl.textContent = 'manual';
    const feeInput = document.getElementById('bridgeFeeCeloToXdc');
    if (feeInput && feeInput.dataset) delete feeInput.dataset.autofilledWei;
}

function updateCeloBridgeSummary() {
    const amountStr = (document.getElementById('bridgeAmountCeloToXdc')?.value || '').trim();
    const feeStr    = (document.getElementById('bridgeFeeCeloToXdc')?.value || '').trim();
    const gross = parseFloat(amountStr) || 0;
    const fee   = parseFloat(feeStr) || 0;

    // Compute the on-chain G$ protocol fee (deducted from the amount
    // before relaying to XDC). This is *separate* from the LayerZero
    // CELO fee, which is paid as msg.value and refunded on excess.
    let protoFeeG = 0;
    let net = gross;
    try {
        if (gross > 0 && _celoBridgeFeesCache) {
            const amtWei  = ethers.parseUnits(gross.toFixed(18).replace(/0+$/,'').replace(/\.$/,'.0'), 18);
            const feeWei  = _computeCeloBridgeProtocolFeeGdWei(amtWei);
            if (feeWei !== null) {
                protoFeeG = Number(ethers.formatUnits(feeWei, 18));
                net = Math.max(0, gross - protoFeeG);
            }
        }
    } catch (_) { /* keep net = gross as conservative fallback */ }

    const grossEl    = document.getElementById('bridgeGrossReceiveCeloToXdc');
    const feeEl      = document.getElementById('bridgeFeeDeductionDisplayCeloToXdc');
    const netEl      = document.getElementById('bridgeNetReceiveCeloToXdc');
    const protoFeeEl = document.getElementById('bridgeProtocolFeeDisplayCeloToXdc');
    if (grossEl) grossEl.textContent = _formatBridgeAmountCelo(gross);
    if (feeEl)   feeEl.textContent   = `${_formatBridgeFeeCelo(fee)} (actual fee may be lower; excess refunded)`;
    if (netEl)   netEl.textContent   = _formatBridgeAmountCelo(net);
    if (protoFeeEl) {
        if (protoFeeG > 0) {
            protoFeeEl.textContent = `Protocol fee: ${_formatBridgeAmountCelo(protoFeeG)} (deducted from bridged amount)`;
            protoFeeEl.style.display = '';
        } else if (_celoBridgeFeesCache) {
            const minFeeG = Number(ethers.formatUnits(_celoBridgeFeesCache.minFee, 18));
            protoFeeEl.textContent = `Protocol fee: ${_formatBridgeAmountCelo(minFeeG)} minimum (deducted from bridged amount)`;
            protoFeeEl.style.display = '';
        } else {
            protoFeeEl.textContent = '';
            protoFeeEl.style.display = 'none';
        }
    }
}

function scheduleCeloBridgeFeeEstimate() {
    if (_celoBridgeFeeEstimateDebounce) {
        clearTimeout(_celoBridgeFeeEstimateDebounce);
        _celoBridgeFeeEstimateDebounce = null;
    }
    _celoBridgeFeeEstimateDebounce = setTimeout(() => {
        _celoBridgeFeeEstimateDebounce = null;
        estimateBridgeFeeCeloToXdc(false).catch(() => { /* silent */ });
    }, 650);
}

async function estimateBridgeFeeCeloToXdc(showSuccessAlert = true) {
    const btn = document.getElementById('btnBridgeEstimateFeeCeloToXdc');
    const feeInput = document.getElementById('bridgeFeeCeloToXdc');
    const sourceEl = document.getElementById('bridgeFeeSourceCeloToXdc');
    const amountStr = (document.getElementById('bridgeAmountCeloToXdc')?.value || '').trim();
    const amount = parseFloat(amountStr) > 0 ? amountStr : '1';
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-inline"></span> Estimating...';
        }
        const url = `/api/xdc/bridge/estimate-fee`
            + `?sourceChainId=${CELO_TO_XDC_SOURCE_CHAIN_ID}`
            + `&targetChainId=${CELO_TO_XDC_TARGET_CHAIN_ID}`
            + `&amount=${encodeURIComponent(amount)}`;
        const res = await fetch(url, { method: 'GET' });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not estimate bridge fee right now.');
        }
        const recommendedFeeCelo = Number(data.bridge_fee_xdc); // endpoint name is generic for native fee
        if (!isFinite(recommendedFeeCelo) || recommendedFeeCelo <= 0) {
            throw new Error('Estimator returned invalid fee.');
        }
        const recommendedWei = data.bridge_fee_wei ? BigInt(data.bridge_fee_wei) : null;
        if (feeInput) {
            feeInput.value = recommendedFeeCelo.toFixed(6);
            if (recommendedWei && feeInput.dataset) {
                feeInput.dataset.autofilledWei = recommendedWei.toString();
            }
        }
        _celoBridgeRecommendedFeeWei = recommendedWei;
        _celoBridgeFeeSourceState = data.fee_source || 'goodserver_estimatefees';
        if (sourceEl) sourceEl.textContent = _celoBridgeFeeSourceState;
        updateCeloBridgeSummary();
        if (showSuccessAlert) {
            showCeloBridgeAlert(
                'alert-info',
                `ℹ️ Recommended LayerZero fee: <strong>${recommendedFeeCelo.toFixed(6)} CELO</strong> (source: ${_celoBridgeFeeSourceState}).`
            );
        }
    } catch (err) {
        if (showSuccessAlert) {
            const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.shortMessage || err?.message || String(err));
            showCeloBridgeAlert('alert-error', '❌ ' + friendly);
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Estimate Fee';
        }
    }
}

// Throws an Error whose `.message` is already a finished, user-facing
// sentence — bypasses GMTxError.format()'s wallet-error pattern
// matching, which would otherwise rewrite a perfectly-itemized
// preflight message into a generic "Insufficient CELO for gas fees"
// string.
function _throwCeloBridgePreflight(message) {
    const e = new Error(message);
    e._gmFriendly = true;
    throw e;
}

async function bridgeCeloToXdc() {
    clearCeloBridgeAlert();
    const btn = document.getElementById('btnBridgeCeloToXdc');
    const amountStr = (document.getElementById('bridgeAmountCeloToXdc')?.value || '').trim();
    const feeStr    = (document.getElementById('bridgeFeeCeloToXdc')?.value || '').trim();
    const sourceToken = 'Celo G$';
    const targetToken = 'XDC G$';

    if (!amountStr || parseFloat(amountStr) <= 0) {
        return showCeloBridgeAlert('alert-error', '❌ Enter a valid bridge amount.');
    }
    // GoodMarket-side minimum gate. Sits above the bridge contract's
    // own 10 G$ minAmount so the tab is reserved for amounts that
    // are actually worth the LayerZero CELO fee. Reject *before*
    // hitting the wallet so the user sees a clean app-side alert.
    const _enteredAmountGd = parseFloat(amountStr);
    if (isFinite(_enteredAmountGd) && _enteredAmountGd < CELO_TO_XDC_UI_MIN_AMOUNT_GD) {
        return showCeloBridgeAlert(
            'alert-error',
            `❌ You don't have enough G$ to bridge. ` +
            `Minimum is ${CELO_TO_XDC_UI_MIN_AMOUNT_GD.toLocaleString()} G$ per transaction — ` +
            `you entered ${_enteredAmountGd.toLocaleString(undefined,{maximumFractionDigits:2})} G$.`
        );
    }
    if (!feeStr || parseFloat(feeStr) <= 0) {
        return showCeloBridgeAlert('alert-error', '❌ Enter a valid bridge fee in CELO.');
    }

    // On-chain limits live on the bridge contract and supersede the
    // generic doc-level 300M cap. Pre-validate against them first so we
    // can give the user a clear message instead of a wallet-side
    // simulation revert ("Review alert" in MetaMask).
    try {
        await _loadCeloBridgeLimitsAndFees();
    } catch (_) { /* best-effort; flow continues */ }

    if (_celoBridgeLimitsCache) {
        try {
            const enteredWei = ethers.parseUnits(amountStr, 18);
            if (_celoBridgeLimitsCache.minAmount > 0n && enteredWei < _celoBridgeLimitsCache.minAmount) {
                const minG = Number(ethers.formatUnits(_celoBridgeLimitsCache.minAmount, 18));
                return showCeloBridgeAlert(
                    'alert-error',
                    `❌ Minimum bridge amount is ${minG.toLocaleString(undefined,{maximumFractionDigits:2})} G$ per the on-chain bridge contract.`
                );
            }
            if (_celoBridgeLimitsCache.txLimit > 0n && enteredWei > _celoBridgeLimitsCache.txLimit) {
                const txG = Number(ethers.formatUnits(_celoBridgeLimitsCache.txLimit, 18));
                return showCeloBridgeAlert(
                    'alert-error',
                    `❌ Amount exceeds the on-chain per-tx bridge limit of ${txG.toLocaleString(undefined,{maximumFractionDigits:2})} G$.`
                );
            }
        } catch (_) { /* fall through to canBridge() */ }
    } else if (parseFloat(amountStr) > 300_000_000) {
        // Couldn't load on-chain limits — fall back to the generic
        // doc cap so we still reject obviously-too-large requests.
        return showCeloBridgeAlert(
            'alert-error',
            '❌ Amount exceeds the bridge cap of 300M G$ per request (per GoodDollar bridge docs).'
        );
    }

    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span> Preparing...';

    _celoBridgeAttemptContext = {
        attempt_id: (window.crypto?.randomUUID ? window.crypto.randomUUID() : `attempt-${Date.now()}`),
        source_token: sourceToken,
        target_token: targetToken,
        attempted_amount: _formatBridgeAmountCelo(parseFloat(amountStr) || 0),
        tx_hash: null,
        entered_fee_celo: parseFloat(feeStr),
        effective_fee_celo: parseFloat(feeStr)
    };

    try {
        const amountWei = ethers.parseUnits(amountStr, 18);
        const feeInputEl = document.getElementById('bridgeFeeCeloToXdc');
        let feeWei = ethers.parseUnits(feeStr, 18);
        const autofilledFeeWei = feeInputEl?.dataset?.autofilledWei ? BigInt(feeInputEl.dataset.autofilledWei) : null;
        if (autofilledFeeWei && feeWei <= autofilledFeeWei) {
            // Protect against browser <input type="number"> precision truncation.
            const diffWei = autofilledFeeWei - feeWei;
            if (diffWei <= 1000000000000n) { // <= 0.000001 CELO
                feeWei = autofilledFeeWei;
            }
        }

        await _celoBridgeDebugLog('bridge_start', {
            amount_input: amountStr,
            amount_wei: amountWei.toString(),
            entered_fee_celo: parseFloat(feeStr),
            entered_fee_wei: feeWei.toString(),
            bridge_contract: CELO_TO_XDC_BRIDGE_CONTRACT,
            source_chain_id: CELO_TO_XDC_SOURCE_CHAIN_ID,
            target_chain_id: CELO_TO_XDC_TARGET_CHAIN_ID,
            fee_source_state: _celoBridgeFeeSourceState
        });

        const readProvider = new ethers.JsonRpcProvider(CELO_RPC);
        const gd = new ethers.Contract(CELO_TO_XDC_GD_TOKEN, CELO_TO_XDC_ERC20_ABI, readProvider);
        const sourceBridge = new ethers.Contract(CELO_TO_XDC_BRIDGE_CONTRACT, CELO_TO_XDC_BRIDGE_ABI, readProvider);

        btn.innerHTML = '<span class="spinner-inline"></span> Connecting wallet...';
        const signer = await getConnectedSwapSigner();
        const signerAddr = await signer.getAddress();
        if (signerAddr.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
            _throwCeloBridgePreflight('Wrong wallet connected. Please switch to your GoodMarket wallet.');
        }

        // PARALLELIZED: Fetch all read data simultaneously for faster pre-flight
        btn.innerHTML = '<span class="spinner-inline"></span> Checking balances...';
        const [currentAllowance, gdBalWei, onchainBalWei, canBridgeResult] = await Promise.all([
            gd.allowance(signerAddr, CELO_TO_XDC_BRIDGE_CONTRACT),
            gd.balanceOf(signerAddr),
            readProvider.getBalance(signerAddr),
            sourceBridge.canBridge(WALLET_ADDRESS, amountWei).catch(err => {
                // Soft-fail canBridge - allow user to proceed
                console.warn('canBridge check failed, proceeding anyway:', err);
                return true;
            })
        ]);

        // Validate canBridge result
        const isAllowed = Array.isArray(canBridgeResult) ? Boolean(canBridgeResult[0]) : Boolean(canBridgeResult);
        const reasonRaw = Array.isArray(canBridgeResult) ? String(canBridgeResult[1] || '') : '';
        if (!isAllowed) {
            let friendly = 'Bridge preflight failed (canBridge=false). Lower the amount or retry later.';
            const reason = reasonRaw.toLowerCase();
            if (reason === 'closed') {
                // Owner/guardian pause: not an amount problem, not
                // something the user can work around. Say so plainly
                // instead of "lower the amount".
                _celoBridgeClosedCache = true;
                _applyCeloBridgePausedState();
                friendly = CELO_BRIDGE_PAUSED_REASON;
            } else if (reason === 'minamount' && _celoBridgeLimitsCache) {
                const minG = Number(ethers.formatUnits(_celoBridgeLimitsCache.minAmount, 18));
                friendly = `Minimum bridge amount is ${minG.toLocaleString(undefined,{maximumFractionDigits:2})} G$.`;
            } else if (reason === 'txlimit' && _celoBridgeLimitsCache) {
                const txG = Number(ethers.formatUnits(_celoBridgeLimitsCache.txLimit, 18));
                friendly = `Amount exceeds the on-chain per-tx limit of ${txG.toLocaleString(undefined,{maximumFractionDigits:2})} G$.`;
            } else if (reason.includes('dailylimit')) {
                friendly = 'Bridge daily limit reached. Please try again later.';
            } else if (reason.includes('whitelist')) {
                friendly = 'This wallet is not whitelisted on the bridge yet.';
            } else if (reasonRaw) {
                friendly = `Bridge preflight failed: ${reasonRaw}.`;
            }
            throw new Error(friendly);
        }

        const needsApproveTx = currentAllowance < amountWei;

        // Gas reserve estimation (runs after we know needsApproveTx)
        btn.innerHTML = '<span class="spinner-inline"></span> Estimating fees...';
        const gasReserveWei = await _estimateCeloBridgeGasReserveWei(
            readProvider, signerAddr, amountWei, feeWei, needsApproveTx
        );
        const minimumRequiredWei = feeWei + gasReserveWei;

        // Check CELO balance
        if (onchainBalWei < minimumRequiredWei) {
            const needCelo  = parseFloat(ethers.formatUnits(minimumRequiredWei, 18));
            const hasCelo   = parseFloat(ethers.formatUnits(onchainBalWei, 18));
            const feeCelo   = parseFloat(ethers.formatUnits(feeWei, 18));
            const gasCelo   = parseFloat(ethers.formatUnits(gasReserveWei, 18));
            const shortCelo = Math.max(0, needCelo - hasCelo);
            const gasNote   = needsApproveTx ? 'approve + bridge gas' : 'bridge gas';
            _throwCeloBridgePreflight(
                `Not enough CELO for the bridge. ` +
                `Need ≈ ${needCelo.toFixed(6)} CELO ` +
                `(LayerZero fee ${feeCelo.toFixed(6)} + ${gasNote} ≈ ${gasCelo.toFixed(6)}), ` +
                `but wallet has ${hasCelo.toFixed(6)} CELO. ` +
                `Add about ${shortCelo.toFixed(4)} more CELO and retry.`
            );
        }

        // Verify G$ balance on Celo before signing the approve.
        if (gdBalWei < amountWei) {
            const haveGd = ethers.formatUnits(gdBalWei, 18);
            _throwCeloBridgePreflight(`Not enough G$ on Celo. You have ${parseFloat(haveGd).toFixed(2)} G$ but tried to bridge ${parseFloat(amountStr).toFixed(2)} G$.`);
        }

        // Step 1 — approve (only if current allowance is below the requested amount).
        if (needsApproveTx) {
            btn.innerHTML = '<span class="spinner-inline"></span> Approving G$...';
            if (window.GMTxPreview && GMTxPreview.confirm) {
                try {
                    await GMTxPreview.confirm({
                        action: 'approve',
                        token: 'G$ (Celo)',
                        amount: ethers.formatUnits(amountWei, 18),
                        to: CELO_TO_XDC_BRIDGE_CONTRACT,
                        toLabel: 'Celo ↔ XDC Bridge',
                        network: 'Celo',
                        note: 'Lets the bridge contract pull exactly this amount for this transfer to XDC.'
                    });
                } catch (previewErr) {
                    if (GMTxPreview.isCancelled && GMTxPreview.isCancelled(previewErr)) {
                        btn.disabled = false;
                        btn.innerHTML = 'Bridge to XDC';
                        return;
                    }
                    throw previewErr;
                }
            }
            // Exact-amount approval (not unlimited) — bridge only needs the
            // amount being bridged right now; a leftover allowance would let
            // the bridge contract pull more later.
            const gdSigner = new ethers.Contract(CELO_TO_XDC_GD_TOKEN, CELO_TO_XDC_ERC20_ABI, signer);
            const approveTx = await gdSigner.approve(CELO_TO_XDC_BRIDGE_CONTRACT, amountWei);
            showCeloBridgeAlert(
                'alert-info',
                `<span class="spinner-inline"></span> Approve submitted… <a class="info-link" href="https://celoscan.io/tx/${approveTx.hash}" target="_blank" rel="noopener">View ↗</a>`
            );
            await approveTx.wait();
        }

        // Step 2 — bridgeTo with msg.value = LayerZero fee.
        btn.innerHTML = '<span class="spinner-inline"></span> Bridging to XDC...';
        if (window.GMTxPreview && GMTxPreview.confirm) {
            try {
                await GMTxPreview.confirm({
                    action: 'bridge',
                    token: 'G$ (Celo)',
                    amount: ethers.formatUnits(amountWei, 18),
                    to: CELO_TO_XDC_BRIDGE_CONTRACT,
                    toLabel: 'Celo ↔ XDC Bridge',
                    network: 'Celo',
                    note: `LayerZero fee: ${ethers.formatUnits(feeWei, 18)} CELO. Funds mint on XDC at the same address.`
                });
            } catch (previewErr) {
                if (GMTxPreview.isCancelled && GMTxPreview.isCancelled(previewErr)) {
                    btn.disabled = false;
                    btn.innerHTML = 'Bridge to XDC';
                    return;
                }
                throw previewErr;
            }
        }

        const bridgeSigner = new ethers.Contract(CELO_TO_XDC_BRIDGE_CONTRACT, CELO_TO_XDC_BRIDGE_ABI, signer);
        const bridgeTx = await bridgeSigner.bridgeTo(
            WALLET_ADDRESS,
            CELO_TO_XDC_TARGET_CHAIN_ID,
            amountWei,
            CELO_TO_XDC_BRIDGE_SERVICE_LAYERZERO,
            { value: feeWei }
        );
        _celoBridgeAttemptContext.tx_hash = bridgeTx.hash;
        _celoBridgeAttemptContext.effective_fee_celo = Number(ethers.formatUnits(feeWei, 18));
        await _celoBridgeDebugLog('bridge_submitted', {
            tx_hash: bridgeTx.hash,
            effective_fee_wei: feeWei.toString(),
            effective_fee_celo: _celoBridgeAttemptContext.effective_fee_celo
        });

        showCeloBridgeAlert(
            'alert-success',
            `✅ Bridge submitted to XDC!<br>
            <div style="margin:0.45rem 0 0.35rem; padding:0.45rem 0.55rem; border-radius:8px; border:1px solid #e9e2d6; background:#fbfaf8; color:#3a3226; font-size:0.79rem; line-height:1.5;">
                <strong>From:</strong> ${sourceToken} (Celo Mainnet)<br>
                <strong>To:</strong> ${targetToken} (XDC Network)<br>
                <strong>Gross:</strong> ${_formatBridgeAmountCelo(parseFloat(amountStr) || 0)}<br>
                <strong>Fee:</strong> ${_formatBridgeFeeCelo(Number(ethers.formatUnits(feeWei, 18)))}
            </div>
            <a class="info-link" href="https://celoscan.io/tx/${bridgeTx.hash}" target="_blank" rel="noopener">View on CeloScan ↗</a><br>
            <a class="info-link" href="https://layerzeroscan.com/tx/${bridgeTx.hash}" target="_blank" rel="noopener">Track on LayerZeroScan ↗</a><br>
            <span style="color:#6b5d48;font-size:0.8rem;">Final mint on XDC may take a few minutes.</span>`
        );

        displayBalances();
        updateCeloBridgeBalanceDisplay();
        try { loadBalances(true); } catch (_) {}
    } catch (err) {
        console.error('[bridge celo→xdc] failed', err);
        const friendly = (window.GMTxError && GMTxError.format)
            ? GMTxError.format(err)
            : (err?.shortMessage || err?.message || 'Bridge failed.');
        await _celoBridgeDebugLog('bridge_failed', {
            error: friendly,
            tx_hash: _celoBridgeAttemptContext?.tx_hash || null,
            attempted_amount: amountStr,
            entered_fee_celo: feeStr
        });
        showCeloBridgeAlert('alert-error', '❌ ' + friendly);
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Bridge to XDC';
    }
}

// ────────────────────────────────────────────────────────────────────
// XDC → Celo Bridge sub-pane.
//
// Ported from /xdc-wallet's bridge card (PR #353 lineage) so the user
// can bridge in either direction without leaving /swap. Identifiers
// in this block are deliberately suffixed with "XdcToCelo" so they
// never collide with the Celo → XDC globals above; helpers shared
// across both directions (`_getEthProvider`, `WALLET_ADDRESS`,
// `ERC20_ABI`, `GMTxPreview`) are reused as-is.
// ────────────────────────────────────────────────────────────────────
const XDC_CELO_BRIDGE                  = window.GM_SWAP_BOOT.bridgeContract;
const XDC_GD_TOKEN                     = window.GM_SWAP_BOOT.xdcGdTokenContract;
const XDC_TO_CELO_TARGET_CHAIN_ID      = Number(window.GM_SWAP_BOOT.celoChainId);
const XDC_CHAIN_ID                     = Number(window.GM_SWAP_BOOT.xdcChainId);
const XDC_CHAIN_ID_HEX                 = "0x32"; // 50 in hex
const XDC_TO_CELO_BRIDGE_ABI = [
    "function bridgeTo(address target, uint256 targetChainId, uint256 amount, uint8 bridge) payable",
    "function canBridge(address from, uint256 amount) view returns (bool)"
];
const XDC_TO_CELO_BRIDGE_SERVICE_LAYERZERO = 1;
const BRIDGE_FALLBACK_FEE_XDC_TO_CELO      = 1.6176;

// GoodMarket-side minimum, mirrors Celo → XDC.
const XDC_TO_CELO_UI_MIN_AMOUNT_GD = 2000;

// Realistic gas units for XDC's two on-chain operations. Mirrors
// PR #353 in /xdc-wallet so error UX is identical across pages.
const XDC_TO_CELO_BRIDGE_TO_GAS_LIMIT       = 500000n;
const XDC_TO_CELO_APPROVE_GAS_LIMIT         = 60000n;
const XDC_TO_CELO_ESTIMATE_PAD_BPS          = 1500n; // +15%
const XDC_TO_CELO_GAS_RESERVE_BUFFER_BPS    = 500n;  // +5%
const XDC_TO_CELO_GAS_RESERVE_FALLBACK_XDC  = 0.01;
const XDC_TO_CELO_GAS_RESERVE_FLOOR_XDC     = 0.001;

let bridgeFeeEstimateDebounceXdcToCelo = null;
let bridgeFeeSourceStateXdcToCelo      = 'manual';
let bridgeAttemptContextXdcToCelo      = null;
let bridgeRecommendedFeeWeiXdcToCelo   = null;
let xdcGdBalanceVal                    = 0;
let xdcNativeBalanceVal                = 0;

function _providerLabelXdcToCelo(provider) {
    if (!provider) return 'wallet';
    if (provider.isMiniPay) return 'MiniPay';
    if (provider.isTrust) return 'Trust Wallet';
    if (provider.isMetaMask) return 'MetaMask';
    return 'wallet';
}

function _fmtBridgeAmountXdcToCelo(value, symbol = 'G$') {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return `0.000000 ${symbol}`;
    return `${n.toFixed(6)} ${symbol}`;
}

function _fmtBridgeFeeXdcXdcToCelo(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(6)} XDC`;
}

async function _bridgeDebugLogXdcToCelo(event, details = {}) {
    try {
        await fetch('/api/xdc/bridge/debug-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event,
                attempt_id: bridgeAttemptContextXdcToCelo?.attempt_id || null,
                details
            })
        });
    } catch (_) {}
}

function _increaseGasLimitHexXdcToCelo(gasHexOrDec, percent = 20) {
    try {
        const base = BigInt(gasHexOrDec);
        const boosted = base + (base * BigInt(percent) / 100n);
        return ethers.toBeHex(boosted);
    } catch {
        return null;
    }
}

function _normalizeAddrXdcToCelo(addr) {
    if (!addr) return addr;
    try { return ethers.getAddress(addr); } catch (_) { return addr; }
}

// ── XDC Wallet Pre-warming for faster bridge signing ──────────────────
// Cache the XDC-connected provider so we don't re-request accounts
// and re-switch chains on every transaction.
var _xdcWarmedProvider = null;
var _xdcWarmedAddress = null;

async function _warmUpXdcWalletProvider() {
    // The in-app wallet signs Celo & XDC — never pop an injected
    // MetaMask (a different account) for local logins. Warm the
    // PIN-unlocked local provider on XDC instead.
    const isLocal = (LOGIN_METHOD || '').toLowerCase() === 'local';
    // If already warmed and cached, return the cached provider
    if (_xdcWarmedProvider && _xdcWarmedAddress) {
        return { provider: _xdcWarmedProvider, address: _xdcWarmedAddress };
    }

    let ep;
    if (isLocal) {
        // Page-load warming must not pop the PIN modal — only warm an
        // already-unlocked wallet; the bridge action re-resolves (and
        // prompts) at click time.
        if (typeof GMLocalWallet === 'undefined' || !GMLocalWallet.isUnlocked()) return null;
        ep = await _swapGetLocalWalletProvider();
    } else {
        ep = await _awaitEthProvider(3000);
    }
    if (!ep) return null;
    
    // Switch to XDC network first
    const switched = await ensureXDCNetwork(ep);
    if (!switched) return null;
    
    // Request accounts once and cache
    const accounts = await ep.request({ method: 'eth_requestAccounts' });
    const from = accounts && accounts[0];
    if (!from) return null;
    
    // Validate it's the right wallet
    if (WALLET_ADDRESS && _normalizeAddrXdcToCelo(from).toLowerCase() !== _normalizeAddrXdcToCelo(WALLET_ADDRESS).toLowerCase()) {
        return null;
    }
    
    // Cache for subsequent calls
    _xdcWarmedProvider = ep;
    _xdcWarmedAddress = from;
    return { provider: ep, address: from };
}

function _clearXdcWarmedProvider() {
    _xdcWarmedProvider = null;
    _xdcWarmedAddress = null;
}

// Auto-switch (or add) the user's wallet to XDC mainnet right
// before signing. Uses cached provider if available.
// Some wallets accept wallet_addEthereumChain but DON'T auto-switch,
// and injected wallets ignore the chainId inside eth_sendTransaction
// — without the re-switch + verification an XDC-bound tx went out on
// Celo and failed with the misleading "insufficient CELO for gas".
async function ensureXDCNetwork(ep) {
    try {
        const chainId = await ep.request({ method: 'eth_chainId' });
        if (parseInt(chainId, 16) === XDC_CHAIN_ID) return true;
        try {
            await ep.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: XDC_CHAIN_ID_HEX }]
            });
        } catch (switchErr) {
            if (switchErr && (switchErr.code === 4902 || switchErr.code === -32603)) {
                await ep.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: XDC_CHAIN_ID_HEX,
                        chainName: 'XDC Network',
                        rpcUrls: ['https://earpc.xinfin.network', 'https://rpc.ankr.com/xdc', 'https://erpc.xdcrpc.com'],
                        nativeCurrency: { name: 'XDC', symbol: 'XDC', decimals: 18 },
                        blockExplorerUrls: ['https://xdcscan.com']
                    }]
                });
                await ep.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: XDC_CHAIN_ID_HEX }]
                });
            } else {
                throw switchErr;
            }
        }
        // Verify where the wallet actually landed; a silent no-switch
        // must fail here, not at eth_sendTransaction.
        for (let i = 0; i < 5; i++) {
            const cur = await ep.request({ method: 'eth_chainId' }).catch(() => null);
            if (parseInt(cur, 16) === XDC_CHAIN_ID) return true;
            await new Promise(r => setTimeout(r, 400));
        }
        return false;
    } catch (_) {
        return false;
    }
}

// Destination-side pause/fee preflight for XDC → Celo.
//
// The bridge enforces its limits on the *minting* (destination) side:
// MessagePassingBridge._bridgeFrom -> _enforceLimits -> canBridge on
// CELO. `_bridgeTo` on XDC is only gated by XDC's OWN isClosed flag.
// So when GoodDollar pauses on Celo but not XDC, the source check
// passes, XDC burns the user's G$, the LayerZero message is relayed,
// and Celo rejects it with BRIDGE_LIMITS('closed') — leaving the G$
// burnt and the transfer stuck in LayerZero's stored-message queue
// until GoodDollar reopens and a retry succeeds. Checking the Celo
// destination BEFORE burning is what prevents that.
//
// Returns { blocked: bool, reason: string }. Fails OPEN (blocked=false)
// when Celo can't be read, so an RPC hiccup never wedges the tab.
const CELO_DEST_BRIDGE_ABI = [
    "function canBridge(address from, uint256 amount) view returns (bool, string)",
    "function isClosed() view returns (bool)"
];
const CELO_DEST_READ_RPCS = [CELO_RPC].concat(
    ['https://forno.celo.org', 'https://rpc.ankr.com/celo', 'https://celo-rpc.publicnode.com']
);

async function _checkCeloDestinationBridge(toAddr, amountWei) {
    for (const url of CELO_DEST_READ_RPCS) {
        try {
            const p = new ethers.JsonRpcProvider(url);
            const dest = new ethers.Contract(CELO_TO_XDC_BRIDGE_CONTRACT, CELO_DEST_BRIDGE_ABI, p);
            const [closed, can] = await Promise.all([
                dest.isClosed(),
                dest.canBridge(toAddr, amountWei)
            ]);
            if (closed) return { blocked: true, reason: 'closed' };
            const allowed = Array.isArray(can) ? Boolean(can[0]) : Boolean(can);
            const reason = Array.isArray(can) ? String(can[1] || '') : '';
            if (!allowed) return { blocked: true, reason: reason || 'rejected' };
            return { blocked: false, reason: '' };
        } catch (_) { /* try the next Celo RPC */ }
    }
    return { blocked: false, reason: '' }; // unreadable → fail open
}

async function _xdcReadProvider() {
    const ep = (typeof _getEthProvider === "function") ? _getEthProvider() : null;
    if (ep) {
        try {
            const cur = await ep.request({ method: 'eth_chainId' });
            if (parseInt(cur, 16) === XDC_CHAIN_ID) {
                return new ethers.BrowserProvider(ep);
            }
        } catch (_) { /* fall through to public RPC */ }
    }
    return new ethers.JsonRpcProvider('https://earpc.xinfin.network');
}

async function _estimateXdcBridgeGasReserveWei(provider, fromAddr, amountWei, feeWei, needsApprove) {
    const fallbackWei = ethers.parseUnits(String(XDC_TO_CELO_GAS_RESERVE_FALLBACK_XDC), 18);
    const floorWei    = ethers.parseUnits(String(XDC_TO_CELO_GAS_RESERVE_FLOOR_XDC), 18);
    try {
        let gasPriceWei = 0n;
        try {
            const feeData = await provider.getFeeData();
            if (feeData?.maxFeePerGas && feeData.maxFeePerGas > 0n) {
                gasPriceWei = feeData.maxFeePerGas;
            } else if (feeData?.gasPrice && feeData.gasPrice > 0n) {
                gasPriceWei = feeData.gasPrice;
            }
        } catch (_) { /* fall through */ }
        if (gasPriceWei === 0n) {
            try {
                const hex = await provider.send('eth_gasPrice', []);
                if (typeof hex === 'string' && hex.startsWith('0x')) {
                    gasPriceWei = BigInt(hex);
                }
            } catch (_) { /* fall through */ }
        }
        if (gasPriceWei === 0n) {
            return needsApprove
                ? ((fallbackWei * 11500n) / 10000n)
                : fallbackWei;
        }
        let bridgeGasUnits = XDC_TO_CELO_BRIDGE_TO_GAS_LIMIT;
        try {
            const bridgeIface = new ethers.Interface(XDC_TO_CELO_BRIDGE_ABI);
            const callData = bridgeIface.encodeFunctionData('bridgeTo', [
                fromAddr,
                XDC_TO_CELO_TARGET_CHAIN_ID,
                amountWei,
                XDC_TO_CELO_BRIDGE_SERVICE_LAYERZERO
            ]);
            const estimated = await provider.estimateGas({
                from: fromAddr,
                to: XDC_CELO_BRIDGE,
                data: callData,
                value: feeWei
            });
            if (estimated && estimated > 0n) {
                const padded = (estimated * (10000n + XDC_TO_CELO_ESTIMATE_PAD_BPS)) / 10000n;
                bridgeGasUnits = padded > XDC_TO_CELO_BRIDGE_TO_GAS_LIMIT ? padded : XDC_TO_CELO_BRIDGE_TO_GAS_LIMIT;
            }
        } catch (_) { /* keep static gas limit */ }
        let totalGasUnits = bridgeGasUnits;
        if (needsApprove) totalGasUnits += XDC_TO_CELO_APPROVE_GAS_LIMIT;
        const rawCostWei = totalGasUnits * gasPriceWei;
        const buffered   = (rawCostWei * (10000n + XDC_TO_CELO_GAS_RESERVE_BUFFER_BPS)) / 10000n;
        return buffered > floorWei ? buffered : floorWei;
    } catch (_) {
        return fallbackWei;
    }
}

async function loadXdcGdBalance() {
    try {
        const res = await fetch('/api/xdc/gd-info');
        if (!res.ok) { updateBridgeFromBalanceXdcToCelo(); return; }
        const data = await res.json();
        const gdBal = data?.gd_balance;
        xdcGdBalanceVal = (gdBal && gdBal.success) ? (gdBal.balance || 0) : 0;
    } catch (_) { /* keep prior value */ }
    updateBridgeFromBalanceXdcToCelo();
}

async function loadXdcNativeBalance() {
    try {
        const res = await fetch('/api/xdc/balances');
        if (!res.ok) { updateBridgeFromBalanceXdcToCelo(); return; }
        const data = await res.json();
        const xdc = data?.xdc;
        xdcNativeBalanceVal = (xdc && xdc.success) ? (xdc.balance || 0) : 0;
    } catch (_) { /* keep prior value */ }
    updateBridgeFromBalanceXdcToCelo();
}

function updateBridgeFromBalanceXdcToCelo() {
    const gdEl = document.getElementById('bridgeFromBalanceXdcToCelo');
    const xdcEl = document.getElementById('bridgeFeeBalanceXdcToCelo');
    if (gdEl)  gdEl.textContent  = `${xdcGdBalanceVal.toFixed(2)} G$`;
    if (xdcEl) xdcEl.textContent = `${xdcNativeBalanceVal.toFixed(4)} XDC`;
}

function showBridgeAlertXdcToCelo(type, msg) {
    const el = document.getElementById('bridgeAlertXdcToCelo');
    if (!el) return;
    el.className = `alert ${type} show`;
    el.innerHTML = msg;
}

function clearBridgeAlertXdcToCelo() {
    const el = document.getElementById('bridgeAlertXdcToCelo');
    if (!el) return;
    el.className = 'alert';
    el.innerHTML = '';
}

function markBridgeFeeManualXdcToCelo() {
    bridgeRecommendedFeeWeiXdcToCelo = null;
    const feeInput = document.getElementById('bridgeFeeXdcToCelo');
    if (feeInput) feeInput.dataset.autofilledWei = '';
}

function updateBridgeSummaryXdcToCelo() {
    const amountStr = (document.getElementById('bridgeAmountXdcToCelo')?.value || '').trim();
    const feeStr = (document.getElementById('bridgeFeeXdcToCelo')?.value || '').trim();
    const gross = parseFloat(amountStr || '0') || 0;
    const feeXdc = parseFloat(feeStr || '0');
    const net = gross;
    const grossEl = document.getElementById('bridgeGrossReceiveXdcToCelo');
    const feeEl = document.getElementById('bridgeFeeDeductionDisplayXdcToCelo');
    const netEl = document.getElementById('bridgeNetReceiveXdcToCelo');
    if (grossEl) grossEl.textContent = _fmtBridgeAmountXdcToCelo(gross);
    if (feeEl) feeEl.textContent = Number.isFinite(feeXdc) && feeXdc > 0
        ? `${_fmtBridgeFeeXdcXdcToCelo(feeXdc)} (actual fee may be lower; excess can be refunded)`
        : '—';
    if (netEl) netEl.textContent = _fmtBridgeAmountXdcToCelo(net);
}

function setBridgeMaxXdcToCelo() {
    const amountInput = document.getElementById('bridgeAmountXdcToCelo');
    if (!amountInput) return;
    amountInput.value = xdcGdBalanceVal > 0 ? xdcGdBalanceVal.toFixed(6) : '0';
    updateBridgeSummaryXdcToCelo();
    scheduleBridgeFeeEstimateXdcToCelo();
}

function scheduleBridgeFeeEstimateXdcToCelo() {
    if (bridgeFeeEstimateDebounceXdcToCelo) clearTimeout(bridgeFeeEstimateDebounceXdcToCelo);
    bridgeFeeEstimateDebounceXdcToCelo = setTimeout(() => {
        estimateBridgeFeeXdcToCelo(false);
    }, 450);
}

async function estimateBridgeFeeXdcToCelo(showSuccessAlert = true) {
    const amountStr = (document.getElementById('bridgeAmountXdcToCelo')?.value || '').trim() || '1';
    const btn = document.getElementById('btnBridgeEstimateFeeXdcToCelo');
    const feeInput = document.getElementById('bridgeFeeXdcToCelo');
    const feeSourceEl = document.getElementById('bridgeFeeSourceXdcToCelo');
    if (!btn || !feeInput || !feeSourceEl) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span> Estimating...';
    try {
        const res = await fetch(`/api/xdc/bridge/estimate-fee?amount=${encodeURIComponent(amountStr)}`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Fee estimation failed');
        const recommendedFeeXdc = parseFloat(
            data.recommended_bridge_fee_xdc ?? data.bridge_fee_xdc ?? '0'
        );
        const baseEstimatedFeeXdc = parseFloat(
            data.estimated_bridge_fee_xdc ?? data.bridge_fee_xdc ?? '0'
        );
        const feeXdc = Number.isFinite(recommendedFeeXdc) && recommendedFeeXdc > 0
            ? recommendedFeeXdc
            : baseEstimatedFeeXdc;
        const recommendedWei = data.recommended_bridge_fee_wei || data.bridge_fee_wei || null;
        if (recommendedWei) {
            bridgeRecommendedFeeWeiXdcToCelo = recommendedWei;
            feeInput.dataset.autofilledWei = recommendedWei;
            feeInput.value = ethers.formatUnits(BigInt(recommendedWei), 18);
        } else if (Number.isFinite(feeXdc) && feeXdc > 0) {
            feeInput.value = feeXdc.toString();
            bridgeRecommendedFeeWeiXdcToCelo = null;
            feeInput.dataset.autofilledWei = '';
        }
        updateBridgeSummaryXdcToCelo();
        feeSourceEl.textContent = data.source === 'goodserver_estimatefees'
            ? 'goodserver estimatefees (+ safety buffer)'
            : 'fallback default (manual check recommended)';
        bridgeFeeSourceStateXdcToCelo = data.source || 'manual';
        if (showSuccessAlert) {
            showBridgeAlertXdcToCelo('alert-success', `✅ Estimated bridge fee: ${feeInput.value} XDC`);
        }
    } catch (err) {
        updateBridgeSummaryXdcToCelo();
        feeSourceEl.textContent = 'manual';
        bridgeFeeSourceStateXdcToCelo = 'manual';
        if (showSuccessAlert) {
            showBridgeAlertXdcToCelo('alert-error', '❌ Could not estimate fee automatically. You may still enter fee manually.');
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Estimate Fee';
    }
}

async function _sendXdcBridgeTx({ to, data, valueHex = '0x0', fallbackGasLimit = null }) {
    if (window.useServerSigning) {
        const res = await fetch('/api/server/sign-tx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, data, value: valueHex, chain_id: XDC_CHAIN_ID, wait_receipt: true })
        });
        const d = await res.json();
        if (!d.success) {
            const reason = d.error || 'Server-side transaction failed';
            const hashHint = d.tx_hash ? ` Hash: ${d.tx_hash}.` : '';
            throw new Error(`${reason}.${hashHint}`.trim());
        }
        return d.tx_hash;
    }
    // Use pre-warmed provider for faster signing - skips network switch and account request
    let ep, from;
    const warmed = await _warmUpXdcWalletProvider();
    if (warmed) {
        ep = warmed.provider;
        from = warmed.address;
    } else if ((LOGIN_METHOD || '').toLowerCase() === 'local') {
        // In-app wallet: XDC is supported — sign with the PIN-unlocked
        // local provider (never an injected extension).
        ep = await _swapGetLocalWalletProvider();
        if (!ep) throw new Error('No Web3 wallet found.');
        const switched = await ensureXDCNetwork(ep);
        if (!switched) throw new Error('Could not switch to XDC network.');
        const accounts = await ep.request({ method: 'eth_requestAccounts' });
        from = accounts[0];
        if (!from) throw new Error('No wallet account found.');
        if (WALLET_ADDRESS && _normalizeAddrXdcToCelo(from).toLowerCase() !== _normalizeAddrXdcToCelo(WALLET_ADDRESS).toLowerCase()) {
            throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
        }
    } else {
        // Fallback to legacy flow if pre-warming failed
        ep = await _awaitEthProvider();
        if (!ep) throw new Error('No Web3 wallet found.');
        const switched = await ensureXDCNetwork(ep);
        if (!switched) throw new Error('Could not switch to XDC network.');
        const accounts = await ep.request({ method: 'eth_requestAccounts' });
        from = accounts[0];
        if (!from) throw new Error('No wallet account found.');
        if (WALLET_ADDRESS && _normalizeAddrXdcToCelo(from).toLowerCase() !== _normalizeAddrXdcToCelo(WALLET_ADDRESS).toLowerCase()) {
            throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
        }
    }
    const txParams = { from, to, data, value: valueHex, chainId: XDC_CHAIN_ID_HEX };
    try {
        const gasEstimate = await ep.request({ method: 'eth_estimateGas', params: [txParams] });
        const boostedGas = _increaseGasLimitHexXdcToCelo(gasEstimate, 20);
        if (boostedGas) txParams.gas = boostedGas;
    } catch (estimateErr) {
        const msg = (estimateErr?.message || '').toLowerCase();
        if (msg.includes('insufficient funds')) {
            throw new Error('Insufficient XDC for transaction value + network gas. Please top up XDC and retry.');
        }
        if (fallbackGasLimit) {
            const fallbackHex = ethers.toBeHex(BigInt(fallbackGasLimit));
            txParams.gas = fallbackHex;
            if (bridgeAttemptContextXdcToCelo) {
                await _bridgeDebugLogXdcToCelo('wallet_estimate_gas_fallback', {
                    wallet_provider: _providerLabelXdcToCelo(ep),
                    to,
                    value_hex: valueHex,
                    data_prefix: String(data || '').slice(0, 18),
                    fallback_gas_limit: fallbackGasLimit,
                    estimate_error: estimateErr?.message || String(estimateErr || '')
                });
            }
        } else {
            throw new Error(
                'Could not estimate network fee from wallet for this transaction. ' +
                'Please retry, or increase XDC slightly if your wallet still rejects it.'
            );
        }
    }
    const txHash = await ep.request({ method: 'eth_sendTransaction', params: [txParams] });
    await _waitForXdcBridgeTxReceipt(ep, txHash);
    return txHash;
}

async function _waitForXdcBridgeTxReceipt(ep, txHash, { timeoutMs = 180000, pollMs = 2500 } = {}) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
        const receipt = await ep.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
        if (receipt) {
            const statusHex = String(receipt.status || '').toLowerCase();
            const successStatuses = new Set(['0x1', '1']);
            if (!successStatuses.has(statusHex)) {
                let cleanReason = 'Transaction reverted on XDC.';
                let technicalDetails = '';
                let errorCategory = null;
                let bridgeContext = null;
                try {
                    const reasonRes = await fetch(`/api/xdc/tx-revert-reason/${encodeURIComponent(txHash)}`);
                    const reasonData = await reasonRes.json();
                    if (reasonRes.ok && reasonData) {
                        if (reasonData.reason) cleanReason = reasonData.reason;
                        if (reasonData.error_category) errorCategory = reasonData.error_category;
                        if (reasonData.bridge_context) bridgeContext = reasonData.bridge_context;
                        if (reasonData.technical_details) {
                            technicalDetails = reasonData.technical_details;
                        } else if (reasonData.error_selector) {
                            technicalDetails = `Bridge custom error (${reasonData.error_selector})`;
                        }
                    }
                } catch (_) {}
                const selectorFromTechnical = (technicalDetails || "").match(/0x[a-f0-9]{8}/i)?.[0]?.toLowerCase() || null;
                const selectorValue = selectorFromTechnical || null;
                const selectorMessageMap = {
                    '0x10ecdf44': 'Bridge fee is likely below current route requirement. Refresh fee and retry with a slightly higher XDC fee.',
                    '0x92a27eac': 'Bridge fee is lower than current LayerZero requirement. Increase fee and retry.',
                    '0x2e9394cc': 'Bridge fee was missing/too low for this route attempt. Increase bridge fee and retry.',
                    '0xc5426f8d': 'The bridge rejected this transfer under its current policy — the route may be paused, or the amount may exceed a limit. Check the bridge limits on the page, or retry later.',
                    '0x068a5053': 'Selected target chain appears unsupported by the route right now.',
                    '0x2c863d26': 'Token transferFrom failed. Check G$ allowance and balance.',
                    '0x76420e1d': 'Token transfer failed. Check token and bridge route state.'
                };
                const mappedReason = selectorValue ? selectorMessageMap[selectorValue] : null;
                const friendlyReason = mappedReason || cleanReason;
                throw new Error(friendlyReason);
            }
            return receipt;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(
        `Transaction was sent but not mined yet after ${Math.floor(timeoutMs / 1000)}s. ` +
        `Please check XDCScan: ${txHash}`
    );
}

async function bridgeXdcToCelo() {
    clearBridgeAlertXdcToCelo();
    const btn = document.getElementById('btnBridgeXdcToCelo');
    const amountStr = (document.getElementById('bridgeAmountXdcToCelo').value || '').trim();
    const feeStr = (document.getElementById('bridgeFeeXdcToCelo').value || '').trim();
    const sourceToken = 'XDC G$';
    const targetToken = 'Celo G$';

    if (!amountStr || parseFloat(amountStr) <= 0) {
        return showBridgeAlertXdcToCelo('alert-error', '❌ Enter a valid bridge amount.');
    }
    const _enteredAmountGd = parseFloat(amountStr);
    if (Number.isFinite(_enteredAmountGd) && _enteredAmountGd < XDC_TO_CELO_UI_MIN_AMOUNT_GD) {
        return showBridgeAlertXdcToCelo(
            'alert-error',
            `❌ You don't have enough G$ to bridge. ` +
            `Minimum is ${XDC_TO_CELO_UI_MIN_AMOUNT_GD.toLocaleString()} G$ per transaction — ` +
            `you entered ${_enteredAmountGd.toLocaleString(undefined, { maximumFractionDigits: 2 })} G$.`
        );
    }
    if (!feeStr || parseFloat(feeStr) <= 0) {
        return showBridgeAlertXdcToCelo('alert-error', '❌ Enter a valid bridge fee in XDC.');
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span> Preparing...';
    try {
        const amountWei = ethers.parseUnits(amountStr, 18);
        const feeInputEl = document.getElementById('bridgeFeeXdcToCelo');
        let feeWei = ethers.parseUnits(feeStr, 18);
        const autofilledFeeWei = feeInputEl?.dataset?.autofilledWei
            ? BigInt(feeInputEl.dataset.autofilledWei)
            : null;
        if (autofilledFeeWei && feeWei <= autofilledFeeWei) {
            const diffWei = autofilledFeeWei - feeWei;
            if (diffWei <= 1000000000000n) feeWei = autofilledFeeWei;
        }
        const feeXdc = parseFloat(feeStr);
        const grossReceive = parseFloat(amountStr) || 0;
        const netReceive = grossReceive;
        const toAddr = _normalizeAddrXdcToCelo(WALLET_ADDRESS);
        let preflightWarning = '';
        bridgeAttemptContextXdcToCelo = {
            attempt_id: (window.crypto?.randomUUID ? window.crypto.randomUUID() : `attempt-${Date.now()}`),
            source_token: sourceToken,
            target_token: targetToken,
            attempted_amount: _fmtBridgeAmountXdcToCelo(grossReceive),
            tx_hash: null,
            entered_fee_xdc: feeXdc,
            entered_fee_wei: feeWei.toString(),
            effective_fee_xdc: feeXdc,
            effective_fee_wei: feeWei.toString(),
            preflight_attempts: []
        };
        await _bridgeDebugLogXdcToCelo('bridge_start', {
            amount_input: amountStr,
            amount_wei: amountWei.toString(),
            entered_fee_xdc: feeXdc,
            entered_fee_wei: feeWei.toString(),
            bridge_contract: XDC_CELO_BRIDGE,
            source_chain_id: XDC_CHAIN_ID,
            target_chain_id: XDC_TO_CELO_TARGET_CHAIN_ID,
            fee_source_state: bridgeFeeSourceStateXdcToCelo
        });
        if (bridgeFeeSourceStateXdcToCelo === 'fallback_default' && feeXdc <= BRIDGE_FALLBACK_FEE_XDC_TO_CELO) {
            preflightWarning =
                `⚠️ Using fallback fee (${BRIDGE_FALLBACK_FEE_XDC_TO_CELO.toFixed(6)} XDC). ` +
                'If wallet shows a network fee warning, raise the bridge fee slightly and retry.';
        }

        const erc20Iface  = new ethers.Interface(ERC20_ABI);
        const bridgeIface = new ethers.Interface(XDC_TO_CELO_BRIDGE_ABI);
        const readProvider = await _xdcReadProvider();
        const gd = new ethers.Contract(XDC_GD_TOKEN, ERC20_ABI, readProvider);
        const sourceBridge = new ethers.Contract(XDC_CELO_BRIDGE, XDC_TO_CELO_BRIDGE_ABI, readProvider);

        btn.innerHTML = '<span class="spinner-inline"></span> Checking bridge limits...';
        try {
            const sourceCanBridge = await sourceBridge.canBridge(toAddr, amountWei);
            if (!sourceCanBridge) {
                throw new Error('Source-chain bridge preflight failed (canBridge=false). Lower amount or retry later.');
            }
        } catch (limitErr) {
            const limitMessage = limitErr?.message || String(limitErr || '');
            if (limitMessage.toLowerCase().includes('returned false')) throw limitErr;
            throw new Error('Could not verify bridge limits on source bridge. Please retry in a moment.');
        }

        // Destination (Celo) gate — see _checkCeloDestinationBridge.
        // Must run BEFORE any approve/burn so a paused Celo route can
        // never burn the user's XDC G$.
        const destCheck = await _checkCeloDestinationBridge(toAddr, amountWei);
        if (destCheck.blocked) {
            const destReason = String(destCheck.reason || '').toLowerCase();
            let destMsg = 'The Celo destination bridge is not accepting this transfer right now. Please try again later.';
            if (destReason === 'closed') {
                destMsg = CELO_BRIDGE_PAUSED_REASON;
            } else if (destReason === 'minamount') {
                destMsg = `Amount is below the bridge minimum on the Celo side (${XDC_TO_CELO_UI_MIN_AMOUNT_GD.toLocaleString()} G$).`;
            } else if (destReason === 'txlimit') {
                destMsg = 'Amount exceeds the on-chain per-transaction limit on the Celo side.';
            } else if (destReason.includes('daily')) {
                destMsg = 'The Celo bridge daily limit has been reached. Please try again later.';
            } else if (destReason.includes('whitelist')) {
                destMsg = 'This wallet is not whitelisted on the bridge yet.';
            }
            throw new Error(destMsg);
        }

        let ep = null;
        let from = null;
        if (window.useServerSigning) {
            // Server signing: use the server-signed wallet address directly
            // _sendXdcBridgeTx() will route signing to /api/server/sign-tx
            from = _normalizeAddrXdcToCelo(WALLET_ADDRESS);
        } else {
            // Use pre-warmed provider for faster signing - skips network switch and account request
            const warmed = await _warmUpXdcWalletProvider();
            if (warmed) {
                ep = warmed.provider;
                from = _normalizeAddrXdcToCelo(warmed.address);
            } else if ((LOGIN_METHOD || '').toLowerCase() === 'local') {
                // In-app wallet: page-load warming may have returned
                // null (locked). Resolve + prompt PIN unlock here.
                ep = await _swapGetLocalWalletProvider();
                if (!ep) throw new Error('No Web3 wallet found.');
                const switched = await ensureXDCNetwork(ep);
                if (!switched) throw new Error('Could not switch to XDC network.');
                const accounts = await ep.request({ method: 'eth_requestAccounts' });
                from = accounts[0] ? _normalizeAddrXdcToCelo(accounts[0]) : null;
                if (!from) throw new Error('No wallet account found.');
                if (WALLET_ADDRESS && from.toLowerCase() !== _normalizeAddrXdcToCelo(WALLET_ADDRESS).toLowerCase()) {
                    throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
                }
            } else {
                // Fallback to legacy flow if pre-warming failed
                ep = await _awaitEthProvider();
                if (!ep) throw new Error('No Web3 wallet found.');
                const switched = await ensureXDCNetwork(ep);
                if (!switched) throw new Error('Could not switch to XDC network.');
                const accounts = await ep.request({ method: 'eth_requestAccounts' });
                from = accounts[0] ? _normalizeAddrXdcToCelo(accounts[0]) : null;
                if (!from) throw new Error('No wallet account found.');
                if (WALLET_ADDRESS && from.toLowerCase() !== _normalizeAddrXdcToCelo(WALLET_ADDRESS).toLowerCase()) {
                    throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
                }
            }
            const preflightAllowance = await gd.allowance(from, XDC_CELO_BRIDGE);
            const needsApproveTx = preflightAllowance < amountWei;

            const gdBalWei = await gd.balanceOf(from);
            if (gdBalWei < amountWei) {
                const haveGd = parseFloat(ethers.formatUnits(gdBalWei, 18));
                throw new Error(
                    `Not enough G$ on XDC. ` +
                    `You have ${haveGd.toFixed(2)} G$ but tried to bridge ${parseFloat(amountStr).toFixed(2)} G$.`
                );
            }

            const dynamicGasReserveWei = await _estimateXdcBridgeGasReserveWei(
                readProvider, from, amountWei, feeWei, needsApproveTx
            );
            const onchainBalWei = await readProvider.getBalance(from);
            const liveMinimumRequiredWei = feeWei + dynamicGasReserveWei;
            if (onchainBalWei < liveMinimumRequiredWei) {
                const needXdc  = parseFloat(ethers.formatUnits(liveMinimumRequiredWei, 18));
                const hasXdc   = parseFloat(ethers.formatUnits(onchainBalWei, 18));
                const feeXdcF  = parseFloat(ethers.formatUnits(feeWei, 18));
                const gasXdcF  = parseFloat(ethers.formatUnits(dynamicGasReserveWei, 18));
                const shortXdc = Math.max(0, needXdc - hasXdc);
                const gasNote  = needsApproveTx ? 'approve + bridge gas' : 'bridge gas';
                throw new Error(
                    `Not enough XDC for the bridge. ` +
                    `Need ≈ ${needXdc.toFixed(6)} XDC ` +
                    `(LayerZero fee ${feeXdcF.toFixed(6)} + ${gasNote} ≈ ${gasXdcF.toFixed(6)}), ` +
                    `but wallet has ${hasXdc.toFixed(6)} XDC. ` +
                    `Add about ${shortXdc.toFixed(4)} more XDC and retry.`
                );
            }

            const preflightData = bridgeIface.encodeFunctionData('bridgeTo', [
                toAddr, XDC_TO_CELO_TARGET_CHAIN_ID, amountWei, XDC_TO_CELO_BRIDGE_SERVICE_LAYERZERO
            ]);
            const preflightMultipliers = [1.00, 1.30]; // Reduced from 3 to 2 iterations for faster signing
            let effectiveFeeWei = feeWei;
            let preflightPassed = false;
            let lastPreflightMsg = '';
            // Helper: wrap any Promise with a timeout
            const _withTimeout = (promise, ms) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timeout')), ms);
                promise.then((v) => { clearTimeout(timer); resolve(v); },
                             (e) => { clearTimeout(timer); reject(e); });
            });
            
            for (const multiplier of preflightMultipliers) {
                const candidateFeeWei = multiplier === 1
                    ? feeWei
                    : (feeWei * BigInt(Math.round(multiplier * 100)) / 100n);
                try {
                    // 8 second timeout per preflight attempt to prevent hanging
                    await _withTimeout(
                        ep.request({
                            method: 'eth_estimateGas',
                            params: [{
                                from,
                                to: XDC_CELO_BRIDGE,
                                data: preflightData,
                                value: ethers.toBeHex(candidateFeeWei),
                                chainId: XDC_CHAIN_ID_HEX
                            }]
                        }),
                        8000
                    );
                    bridgeAttemptContextXdcToCelo.preflight_attempts.push({
                        multiplier, ok: true, candidate_fee_wei: candidateFeeWei.toString()
                    });
                    effectiveFeeWei = candidateFeeWei;
                    preflightPassed = true;
                    break;
                } catch (attemptErr) {
                    const attemptMsg = (attemptErr?.message || String(attemptErr || ''));
                    // Treat timeout as a soft failure - try next multiplier
                    const attemptMsgLower = attemptMsg.toLowerCase();
                    if (attemptMsgLower === 'timeout' || attemptMsgLower.includes('timeout')) {
                        bridgeAttemptContextXdcToCelo.preflight_attempts.push({
                            multiplier, ok: false,
                            candidate_fee_wei: candidateFeeWei.toString(),
                            selector: null,
                            error: 'Timeout - trying next fee level'
                        });
                        lastPreflightMsg = 'Timeout - trying next fee level';
                        continue; // Try next multiplier instead of failing
                    }
                    const selectorMatch = attemptMsgLower.match(/0x[a-f0-9]{8}/);
                    bridgeAttemptContextXdcToCelo.preflight_attempts.push({
                        multiplier, ok: false,
                        candidate_fee_wei: candidateFeeWei.toString(),
                        selector: selectorMatch ? selectorMatch[0] : null,
                        error: attemptMsg.slice(0, 280)
                    });
                    await _bridgeDebugLogXdcToCelo('preflight_attempt', {
                        multiplier,
                        candidate_fee_wei: candidateFeeWei.toString(),
                        selector: selectorMatch ? selectorMatch[0] : null,
                        error: attemptMsg.slice(0, 280),
                        wallet_provider: _providerLabelXdcToCelo(ep)
                    });
                    lastPreflightMsg = attemptMsg;
                }
            }
            if (!preflightPassed) {
                const msgLower = lastPreflightMsg.toLowerCase();
                if (
                    msgLower.includes('0x10ecdf44') ||
                    msgLower.includes('0x92a27eac') ||
                    msgLower.includes('0x2e9394cc')
                ) {
                    throw new Error(
                        'Bridge pre-check reports route fee is above the current entered fee (even after auto-retry). ' +
                        'Please refresh estimate and retry with a higher bridge fee.'
                    );
                }
                const lowFeeHints = ['revert', 'fee', 'insufficient', 'underpriced', 'lz'];
                if (lowFeeHints.some((hint) => msgLower.includes(hint))) {
                    preflightWarning = '⚠️ Wallet pre-check could not confirm current LayerZero fee after auto-retries.';
                } else {
                    preflightWarning = '⚠️ Wallet pre-check could not be completed after auto-retries.';
                }
            }
            bridgeAttemptContextXdcToCelo.effective_fee_wei = effectiveFeeWei.toString();
            bridgeAttemptContextXdcToCelo.effective_fee_xdc = Number(ethers.formatUnits(effectiveFeeWei, 18));
            await _bridgeDebugLogXdcToCelo('preflight_summary', {
                attempts: bridgeAttemptContextXdcToCelo.preflight_attempts,
                effective_fee_wei: bridgeAttemptContextXdcToCelo.effective_fee_wei,
                effective_fee_xdc: bridgeAttemptContextXdcToCelo.effective_fee_xdc,
                passed: preflightPassed
            });
            feeWei = effectiveFeeWei;
        }

        btn.innerHTML = '<span class="spinner-inline"></span> Checking allowance...';
        const allowance = await gd.allowance(toAddr, XDC_CELO_BRIDGE);
        if (allowance < amountWei) {
            btn.innerHTML = '<span class="spinner-inline"></span> Approving G$...';
            try {
                await GMTxPreview.confirm({
                    action: 'approve',
                    token: 'G$ (XDC)',
                    amount: ethers.formatUnits(amountWei, 18),
                    to: XDC_CELO_BRIDGE,
                    toLabel: 'XDC ↔ Celo Bridge',
                    network: 'XDC',
                    note: 'Lets the bridge contract pull exactly this amount for this transfer to Celo.'
                });
            } catch (err) {
                if (GMTxPreview.isCancelled(err)) {
                    btn.disabled = false;
                    btn.innerHTML = 'Bridge to Celo';
                    return;
                }
                throw err;
            }
            const approveData = erc20Iface.encodeFunctionData('approve', [XDC_CELO_BRIDGE, amountWei]);
            const approveTx = await _sendXdcBridgeTx({
                to: XDC_GD_TOKEN, data: approveData, fallbackGasLimit: 120000
            });
            showBridgeAlertXdcToCelo(
                'alert-success',
                `✅ Approve submitted.<br><a class="tx-link" href="https://xdcscan.com/tx/${approveTx}" target="_blank" rel="noopener">View approve tx ↗ ${approveTx.substring(0,10)}...${approveTx.slice(-8)}</a>`
            );
        }

        btn.innerHTML = '<span class="spinner-inline"></span> Bridging to Celo...';
        const bridgeData = bridgeIface.encodeFunctionData('bridgeTo', [
            toAddr, XDC_TO_CELO_TARGET_CHAIN_ID, amountWei, XDC_TO_CELO_BRIDGE_SERVICE_LAYERZERO
        ]);
        const bridgeTx = await _sendXdcBridgeTx({
            to: XDC_CELO_BRIDGE, data: bridgeData,
            valueHex: ethers.toBeHex(feeWei),
            fallbackGasLimit: 350000
        });
        bridgeAttemptContextXdcToCelo.tx_hash = bridgeTx;
        await _bridgeDebugLogXdcToCelo('bridge_submitted', {
            tx_hash: bridgeTx,
            effective_fee_wei: feeWei.toString(),
            effective_fee_xdc: Number(ethers.formatUnits(feeWei, 18))
        });

        showBridgeAlertXdcToCelo(
            'alert-success',
            `${preflightWarning ? `${preflightWarning}<br>` : ''}✅ Bridge submitted to Celo!<br>
            <div style="margin:0.45rem 0 0.35rem; padding:0.45rem 0.55rem; border-radius:8px; border:1px solid #e9e2d6; background:#fbfaf8; color:#3a3226; font-size:0.79rem; line-height:1.5;">
                <strong>From:</strong> ${sourceToken} (XDC Network)<br>
                <strong>To:</strong> ${targetToken} (Celo Mainnet)<br>
                <strong>Gross:</strong> ${_fmtBridgeAmountXdcToCelo(grossReceive)}<br>
                <strong>Fee:</strong> ${_fmtBridgeFeeXdcXdcToCelo(Number(ethers.formatUnits(feeWei, 18)))}<br>
                <strong>Net Est. Receive:</strong> ${_fmtBridgeAmountXdcToCelo(netReceive)}
            </div>
            <a class="tx-link" href="https://xdcscan.com/tx/${bridgeTx}" target="_blank" rel="noopener">View on XDCScan ↗ ${bridgeTx.substring(0,10)}...${bridgeTx.slice(-8)}</a><br>
            <span style="color:#6b5d48;font-size:0.8rem;">Final mint on Celo may take a few minutes.</span>`
        );
        setTimeout(() => { loadXdcGdBalance(); loadXdcNativeBalance(); }, 4000);
    } catch (err) {
        let msg = err.message || 'Bridge failed';
        if (err.code === 4001) msg = 'Bridge transaction rejected by user.';
        if (!bridgeAttemptContextXdcToCelo) {
            bridgeAttemptContextXdcToCelo = {
                attempt_id: (window.crypto?.randomUUID ? window.crypto.randomUUID() : `attempt-${Date.now()}`),
                source_token: sourceToken,
                target_token: targetToken,
                attempted_amount: _fmtBridgeAmountXdcToCelo(parseFloat(amountStr || '0')),
                tx_hash: null
            };
        }
        await _bridgeDebugLogXdcToCelo('bridge_failed', {
            error: msg,
            tx_hash: bridgeAttemptContextXdcToCelo.tx_hash || null,
            attempted_amount: amountStr,
            entered_fee_xdc: feeStr,
            effective_fee_wei: bridgeAttemptContextXdcToCelo.effective_fee_wei || null,
            preflight_attempts: bridgeAttemptContextXdcToCelo.preflight_attempts || []
        });
        showBridgeAlertXdcToCelo('alert-error', '❌ ' + msg);
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Bridge to Celo';
    }
}

// Bridge pre-warm. Deliberately NOT run at page load: doing so fired three
// XDC API/RPC reads (gd-info, balances, fee estimate) plus a wallet warm-up
// for EVERY /swap visitor, including the majority who never open the Bridge
// tab. setSwapTab()/setBridgeSubTab() call this the first time the tab (or
// the XDC -> Celo direction) is opened.
let _xdcBridgePrewarmed = false;
function _prewarmXdcBridgeTab() {
    if (_xdcBridgePrewarmed) return;
    _xdcBridgePrewarmed = true;
    try { loadXdcGdBalance(); } catch (_) {}
    try { loadXdcNativeBalance(); } catch (_) {}
    try { estimateBridgeFeeXdcToCelo(false); } catch (_) {}
    // Pre-warm XDC wallet provider for faster bridge signing
    try {
        if (typeof _warmUpXdcWalletProvider === "function") {
            _warmUpXdcWalletProvider().catch(function() {});
        }
    } catch (_) {}
}
window._prewarmXdcBridgeTab = _prewarmXdcBridgeTab;

// ══════════════════════════════════════════════════════════════════════
// LI.FI (Jumper) bridge — native CELO (Celo) → native ETH (Base).
//
// This route is TWO steps on TWO chains (bridge, then a destination swap),
// so the user signs twice. The UI exists to make that obvious, not hidden:
// a persistent step bar, per-step button labels, and an explicit
// destination-gas preflight (without ETH on Base the second signature can
// never be paid for — better to stop before the Celo leg is sent).
//
// Reads (quote, status) go through our own /api/bridge/lifi/* proxy so the
// integrator id never ships to the browser. Signing uses the SAME
// getConnectedSwapSigner() resolver as every other swap flow (local PIN
// wallet / WalletConnect / Privy / injected, bound to the session wallet).
// ══════════════════════════════════════════════════════════════════════
const LIFI_BASE_CHAIN_ID = Number(window.GM_SWAP_BOOT.lifiBaseChainId || 8453);
const LIFI_BASE_CHAIN_HEX = '0x' + LIFI_BASE_CHAIN_ID.toString(16);
const LIFI_CELO_CHAIN_HEX = '0xa4ec';
const LIFI_NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
// Base RPCs used for read-only destination-gas checks (never the wallet
// provider — a mobile wallet node can lag and would block a valid bridge).
// Multiple endpoints so one lagging node cannot falsely report "no ETH".
const LIFI_BASE_READ_RPCS = [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
];
const LIFI_BASE_READ_RPC = LIFI_BASE_READ_RPCS[0];
const LIFI_MIN_DEST_ETH_GAS = 0.0001; // ETH; below this the 2nd step can't pay gas

// ── Selectable Celo source tokens ─────────────────────────────────────────
// Native CELO is the default but LI.FI's own step-0 simulation currently
// reverts for a native-CELO source (TransferFromFailed, verified live), while
// the ERC-20 stablecoins build — USDC/USDT in a SINGLE step. The server is the
// source of truth; the hardcoded list is only a fallback when the boot object
// predates this feature.
const LIFI_SOURCE_TOKENS = (window.GM_SWAP_BOOT.lifiSourceTokens || []).length
    ? window.GM_SWAP_BOOT.lifiSourceTokens
    : [
        { key: 'CELO', symbol: 'CELO', address: window.GM_SWAP_BOOT.lifiCeloErc20 || '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18, native: true },
        { key: 'USDC', symbol: 'USDC', address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, native: false },
        { key: 'USDT', symbol: 'USDT', address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, native: false },
        { key: 'cUSD', symbol: 'cUSD', address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18, native: false },
    ];
const LIFI_SOURCE_ICONS = { CELO: 'celo', USDC: 'usdc', USDT: 'usdt', cUSD: 'cusd' };
const LIFI_SOURCE_GLYPHS = { CELO: 'CE', USDC: '$', USDT: '₮', cUSD: '$' };
const LIFI_DEFAULT_SOURCE_KEY = 'CELO';
// Stablecoins that can bridge in a single step (used to pick a fallback).
const LIFI_FALLBACK_PREFERENCE = ['USDC', 'USDT', 'cUSD'];
// Uniswap fee tiers tried when pre-swapping CELO → cUSD (Phase 2).
const LIFI_PRESWAP_FEE_TIERS = [100, 500, 3000, 10000];
const LIFI_PRESWAP_TARGET_KEY = 'cUSD';
// Map a LI.FI source key to the swap-core TOKENS key (uppercase, and cUSD is
// 'CUSD' there) — buildUniversalRouterV3Swap indexes TOKENS by this.
const LIFI_SWAP_TOKEN_KEY = { CELO: 'CELO', USDC: 'USDC', USDT: 'USDT', cUSD: 'CUSD' };

let _lifiQuote = null;
let _lifiQuoteError = null;
let _lifiQuoteErrorCode = null;
let _lifiQuoteTimer = null;
let _lifiBridgeInFlight = false;
let _lifiPrewarmed = false;
let _lifiSourceKey = LIFI_DEFAULT_SOURCE_KEY;
let _lifiFallbackKey = null;
let _lifiSourceBalanceRaw = 0n;

function showLifiAlert(type, msg) {
    const el = document.getElementById('lifiBridgeAlert');
    if (!el) return;
    el.className = 'alert ' + (type || 'alert-info') + ' show';
    el.innerHTML = msg;
}
function clearLifiAlert() {
    const el = document.getElementById('lifiBridgeAlert');
    if (!el) return;
    el.className = 'alert';
    el.innerHTML = '';
}

function _lifiSetStep(step, label) {
    // step: 1 = on Celo, 2 = on Base, 'done' = finished
    const dot1 = document.getElementById('lifiStepDot1');
    const dot2 = document.getElementById('lifiStepDot2');
    const line = document.getElementById('lifiStepLine');
    const lbl  = document.getElementById('lifiStepLabel');
    if (!dot1 || !dot2) return;
    dot1.classList.toggle('active', step === 1);
    dot1.classList.toggle('done',   step === 2 || step === 'done');
    dot2.classList.toggle('active', step === 2);
    dot2.classList.toggle('done',   step === 'done');
    if (line) line.classList.toggle('done', step === 2 || step === 'done');
    if (lbl) lbl.textContent = label || (step === 1 ? 'Step 1 of 2 — confirm on Celo'
        : step === 2 ? 'Step 2 of 2 — confirm on Base' : 'Done');
}

function _lifiFmtEth(weiStr) {
    try { return parseFloat(ethers.formatUnits(BigInt(weiStr), 18)).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ETH'; }
    catch (_) { return '—'; }
}

function _lifiFmtCelo(amountStr) {
    const n = parseFloat(amountStr);
    if (!isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + _lifiSourceToken().symbol;
}

// ── Source-token state ────────────────────────────────────────────────────
function _lifiSourceToken(key) {
    const wanted = (key || _lifiSourceKey || LIFI_DEFAULT_SOURCE_KEY);
    return LIFI_SOURCE_TOKENS.find(t => t.key === wanted)
        || LIFI_SOURCE_TOKENS.find(t => t.key === LIFI_DEFAULT_SOURCE_KEY)
        || { key: LIFI_DEFAULT_SOURCE_KEY, symbol: 'CELO', address: '', decimals: 18, native: true };
}

function _lifiRenderSourceToken() {
    const token = _lifiSourceToken();
    const sym = document.getElementById('lifiFromTokenSymbol');
    const icon = document.getElementById('lifiFromTokenIcon');
    if (sym) sym.textContent = token.symbol;
    if (icon) {
        icon.className = 'token-icon ' + (LIFI_SOURCE_ICONS[token.key] || 'celo');
        icon.textContent = LIFI_SOURCE_GLYPHS[token.key] || token.symbol.slice(0, 2);
    }
    const input = document.getElementById('lifiAmountCelo');
    if (input) input.placeholder = token.native ? '10' : '5';
}

async function _lifiLoadSourceBalance() {
    const el = document.getElementById('lifiFromBalanceCelo');
    const token = _lifiSourceToken();
    if (!el || !WALLET_ADDRESS) return;
    try {
        const provider = new ethers.JsonRpcProvider(CELO_RPC);
        let raw;
        if (token.native) {
            raw = await provider.getBalance(WALLET_ADDRESS);
        } else {
            const erc20 = new ethers.Contract(token.address, CELO_TO_XDC_ERC20_ABI, provider);
            raw = await erc20.balanceOf(WALLET_ADDRESS);
        }
        _lifiSourceBalanceRaw = BigInt(raw);
        const human = parseFloat(ethers.formatUnits(raw, token.decimals));
        el.textContent = human.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' ' + token.symbol;
    } catch (_) {
        _lifiSourceBalanceRaw = 0n;
        el.textContent = '—';
    }
}

// Back-compat alias — the pre-warm path and any older caller use this name.
function loadLifiCeloBalance() { return _lifiLoadSourceBalance(); }

function setLifiMaxCelo() {
    const input = document.getElementById('lifiAmountCelo');
    if (!input) return;
    const token = _lifiSourceToken();
    const bal = parseFloat(ethers.formatUnits(_lifiSourceBalanceRaw, token.decimals)) || 0;
    // Leave a gas reserve so the source tx can still be paid. Native CELO is
    // the gas token, so it needs a real reserve; an ERC-20 source does not
    // (gas is still CELO, but the ERC-20 amount is independent of it).
    const usable = token.native ? Math.max(0, bal - 0.2) : bal;
    input.value = usable > 0 ? String(Math.floor(usable * 10000) / 10000) : '';
    updateLifiBridgeSummary();
    scheduleLifiQuote();
}

// ── Source-token picker ───────────────────────────────────────────────────
function openLifiSourcePicker() {
    const list = document.getElementById('lifiSourcePickerList');
    if (!list) return;
    list.innerHTML = '';
    for (const token of LIFI_SOURCE_TOKENS) {
        const isSelected = token.key === _lifiSourceKey;
        const div = document.createElement('div');
        div.className = `token-picker-item${isSelected ? ' selected' : ''}`;
        div.innerHTML = `
            <div class="token-picker-icon token-icon ${LIFI_SOURCE_ICONS[token.key] || 'celo'}">${LIFI_SOURCE_GLYPHS[token.key] || token.symbol.slice(0, 2)}</div>
            <div class="token-picker-info">
                <div class="token-picker-symbol">${token.symbol}</div>
                <div class="token-picker-name">${token.native ? 'Native CELO on Celo' : 'On Celo'}</div>
            </div>
        `;
        div.onclick = () => selectLifiSourceToken(token.key);
        list.appendChild(div);
    }
    const overlay = document.getElementById('lifiSourcePickerOverlay');
    if (overlay) overlay.classList.add('open');
}

function closeLifiSourcePicker() {
    const overlay = document.getElementById('lifiSourcePickerOverlay');
    if (overlay) overlay.classList.remove('open');
}

function closeLifiSourcePickerOnOverlay(event) {
    if (event && event.target && event.target.id === 'lifiSourcePickerOverlay') closeLifiSourcePicker();
}

function selectLifiSourceToken(key) {
    const token = _lifiSourceToken(key);
    _lifiSourceKey = token.key;
    closeLifiSourcePicker();
    _lifiRenderSourceToken();
    // A new source invalidates the previous quote + any fallback offer.
    _lifiQuote = null;
    _lifiQuoteError = null;
    _lifiQuoteErrorCode = null;
    _lifiFallbackKey = null;
    _hideLifiFallbackUi();
    const input = document.getElementById('lifiAmountCelo');
    if (input) input.value = '';
    const summary = document.getElementById('lifiRouteSummary');
    if (summary) summary.textContent = 'Enter an amount to see the route.';
    _lifiLoadSourceBalance().then(() => scheduleLifiQuote());
}

// Choose a working stablecoin source (balance-aware) after a native-CELO
// failure. Prefers a token the wallet actually holds.
async function _lifiPickFallbackToken() {
    const candidates = LIFI_FALLBACK_PREFERENCE.filter(k => k !== _lifiSourceKey);
    const held = [];
    for (const key of candidates) {
        const token = _lifiSourceToken(key);
        try {
            const provider = new ethers.JsonRpcProvider(CELO_RPC);
            const erc20 = new ethers.Contract(token.address, CELO_TO_XDC_ERC20_ABI, provider);
            const raw = await erc20.balanceOf(WALLET_ADDRESS);
            if (BigInt(raw) > 0n) held.push(key);
        } catch (_) { /* unreadable — skip */ }
    }
    if (held.length) return held[0];
    return candidates[0] || null;
}

function _hideLifiFallbackUi() {
    const btn = document.getElementById('btnLifiFallback');
    if (btn) btn.style.display = 'none';
    const jf = document.getElementById('lifiJumperFallback');
    if (jf) jf.style.display = 'none';
}

function _showLifiJumperFallback() {
    const jf = document.getElementById('lifiJumperFallback');
    if (jf) jf.style.display = '';
}

async function lifiUseFallbackToken() {
    const key = _lifiFallbackKey || await _lifiPickFallbackToken();
    if (!key) { _showLifiJumperFallback(); return; }
    selectLifiSourceToken(key);
}

function updateLifiBridgeSummary() {
    const amountEl = document.getElementById('lifiAmountCelo');
    const sendEl = document.getElementById('lifiSendDisplay');
    if (sendEl && amountEl) sendEl.textContent = _lifiFmtCelo(amountEl.value);
    if (!_lifiQuote) return;
    const recv = document.getElementById('lifiReceiveDisplay');
    const recvMin = document.getElementById('lifiReceiveMinDisplay');
    const gas = document.getElementById('lifiGasDisplay');
    const summary = document.getElementById('lifiRouteSummary');
    if (recv) recv.textContent = _lifiFmtEth(_lifiQuote.to_amount);
    if (recvMin) recvMin.textContent = _lifiFmtEth(_lifiQuote.to_amount_min);
    // A 1-step (stablecoin) route has no destination signature, so the step
    // bar would be misleading — hide it.
    _lifiUpdateStepBarForRoute(_lifiQuote);
    if (summary) {
        const tools = (_lifiQuote.steps || []).map(s => s.tool_name).filter(Boolean).join(' + ');
        summary.textContent = `${_lifiQuote.step_count} step${_lifiQuote.step_count === 1 ? '' : 's'} via ${tools || 'LI.FI'}` +
            (_lifiQuote.execution_duration ? ` · ~${Math.ceil(_lifiQuote.execution_duration / 60)} min` : '');
    }
    if (gas) {
        // Label each cost with the chain it is paid on. The destination step's
        // gas is on Base and (for a self-submitted route) must be paid in ETH —
        // showing "0.19 CELO + 0.000005 ETH" as one line made users think it was
        // all CELO. Be explicit about which chain each amount belongs to.
        const parts = [];
        for (const [i, s] of (_lifiQuote.steps || []).entries()) {
            for (const g of (s.gas_costs || [])) {
                const amt = g.amount ? parseFloat(ethers.formatUnits(BigInt(g.amount), 18)).toFixed(6) : '?';
                const chain = (s.to_chain_id === LIFI_BASE_CHAIN_ID) ? 'Base' : 'Celo';
                parts.push(`${amt} ${g.token || ''} (${chain})`);
            }
        }
        gas.innerHTML = parts.length ? `Est. gas: ${parts.join(' + ')}` : '';
    }
}

function scheduleLifiQuote() {
    if (_lifiQuoteTimer) clearTimeout(_lifiQuoteTimer);
    _lifiQuoteTimer = setTimeout(() => { fetchLifiQuote(); }, 450);
}

// The step bar is a 2-step affordance. A single-step route (USDC/USDT) has no
// destination signature, so showing "Step 2 of 2" would be wrong.
function _lifiUpdateStepBarForRoute(quote) {
    const bar = document.getElementById('lifiStepBar');
    if (!bar) return;
    const steps = (quote && quote.step_count) || 0;
    if (steps <= 1) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = '';
}

async function fetchLifiQuote() {
    const amountEl = document.getElementById('lifiAmountCelo');
    const summary = document.getElementById('lifiRouteSummary');
    if (!amountEl) return;
    const amount = parseFloat(amountEl.value);
    if (!isFinite(amount) || amount <= 0) {
        _lifiQuote = null;
        _hideLifiFallbackUi();
        if (summary) summary.textContent = 'Enter an amount to see the route.';
        return;
    }
    if (summary) summary.textContent = 'Finding the best route…';
    _lifiQuoteError = null;
    _lifiQuoteErrorCode = null;
    const token = _lifiSourceToken();
    let amountWei;
    try { amountWei = ethers.parseUnits(amountEl.value, token.decimals).toString(); }
    catch (_) { if (summary) summary.textContent = 'Enter a valid amount.'; return; }

    try {
        const resp = await fetch('/api/bridge/lifi/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount_wei: amountWei, to_address: WALLET_ADDRESS, from_token: token.key })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            _lifiQuote = null;
            // Surface LI.FI's own reason verbatim — it is actionable, whether
            // that is "price impact too high — try a smaller amount", a
            // rate limit, or a route that cannot build. Keep it so the Bridge
            // button reports the REAL cause instead of a generic guess.
            _lifiQuoteError = data.error || 'No route available for this amount.';
            _lifiQuoteErrorCode = data.error_code || null;
            if (summary) summary.textContent = _lifiQuoteError;
            await _lifiOfferFallbackOnFailure();
            return;
        }
        _lifiQuote = data.quote;
        _hideLifiFallbackUi();
        updateLifiBridgeSummary();
    } catch (err) {
        _lifiQuote = null;
        _lifiQuoteError = 'Could not fetch a route. Please retry.';
        _lifiQuoteErrorCode = null;
        if (summary) summary.textContent = _lifiQuoteError;
    }
}

// When the current source cannot build a route (native CELO today), surface a
// one-tap switch to a working stablecoin, plus a Jumper link as a last resort.
async function _lifiOfferFallbackOnFailure() {
    const btn = document.getElementById('btnLifiFallback');
    const isNativeCelo = _lifiSourceToken().key === 'CELO';
    const canFallback = isNativeCelo && (LIFI_FALLBACK_PREFERENCE.length > 0);
    if (!canFallback) { _hideLifiFallbackUi(); return; }
    const key = await _lifiPickFallbackToken();
    if (key) {
        _lifiFallbackKey = key;
        if (btn) {
            const token = _lifiSourceToken(key);
            btn.textContent = `Bridge ${token.symbol} instead`;
            btn.style.display = '';
        }
    } else if (btn) {
        btn.style.display = 'none';
    }
    _showLifiJumperFallback();
}

async function _lifiSwitchChain(provider, chainHex) {
    // Same pattern as ensureXDCNetwork(): switch, add-then-switch on 4902, and
    // VERIFY where the wallet landed. An injected wallet that silently does
    // not switch would send the destination tx on the wrong chain, so a failed
    // switch must throw here rather than surface as a confusing send error.
    const want = parseInt(chainHex, 16);
    try {
        const cur = await provider.request({ method: 'eth_chainId' }).catch(() => null);
        if (cur && parseInt(cur, 16) === want) return true;
    } catch (_) { /* fall through to the switch attempt */ }
    try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
    } catch (err) {
        if (err && (err.code === 4902 || err.code === -32603)) {
            const chainMeta = chainHex === LIFI_BASE_CHAIN_HEX
                ? { chainId: LIFI_BASE_CHAIN_HEX, chainName: 'Base',
                    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                    rpcUrls: [LIFI_BASE_READ_RPC], blockExplorerUrls: ['https://basescan.org'] }
                : { chainId: LIFI_CELO_CHAIN_HEX, chainName: 'Celo Mainnet',
                    nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
                    rpcUrls: ['https://forno.celo.org'], blockExplorerUrls: ['https://celoscan.io'] };
            await provider.request({ method: 'wallet_addEthereumChain', params: [chainMeta] });
            await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
        } else {
            throw err;
        }
    }
    for (let i = 0; i < 5; i++) {
        const cur = await provider.request({ method: 'eth_chainId' }).catch(() => null);
        if (cur && parseInt(cur, 16) === want) return true;
        await _delay(400);
    }
    return false;
}

async function _lifiEnsureAllowance(signer, step) {
    // Native CELO is exposed as an ERC-20 by LI.FI; the source step pulls it
    // via transferFrom, so an exact-amount approval to the LI.FI diamond is
    // required first. Non-ERC20 source tokens (or a missing approval address)
    // skip this.
    const token = step.from_token_address;
    const spender = step.approval_address;
    if (!token || !spender || token.toLowerCase() === LIFI_NATIVE_ETH.toLowerCase()) return;
    const amount = BigInt(step.from_amount || '0');
    if (amount <= 0n) return;
    const erc20 = new ethers.Contract(token, CELO_TO_XDC_ERC20_ABI, signer);
    let allowance = 0n;
    try { allowance = await erc20.allowance(WALLET_ADDRESS, spender); } catch (_) { allowance = 0n; }
    if (allowance >= amount) return;
    const approveTx = await erc20.approve(spender, amount);
    await approveTx.wait();
}

async function _lifiSendStepTx(signer, step) {
    // /advanced/routes omits transaction data — fetch it per step.
    const resp = await fetch('/api/bridge/lifi/step-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: step.raw })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success || !data.transaction_request) {
        throw new Error(data.error || 'Could not build the transaction.');
    }
    const txReq = data.transaction_request;
    const tx = { to: txReq.to, data: txReq.data, value: txReq.value ? BigInt(txReq.value) : 0n };
    if (txReq.gasLimit) tx.gasLimit = BigInt(txReq.gasLimit);
    if (txReq.gasPrice) tx.gasPrice = BigInt(txReq.gasPrice);
    const sent = await signer.sendTransaction(tx);
    return sent.hash;
}

// ── Resume support ────────────────────────────────────────────────────────
// The Celo leg (step 1) broadcasts and then the tab can close before the Base
// leg (step 2) is signed. The bridged funds would sit on Base with no in-app
// way to finish, so the pending leg is persisted and offered as "Finish on
// Base". The LI.FI route is deterministic for (from,to,amount), so re-fetching
// the quote yields the same step 2 — no raw step needs to be stored.
const LIFI_PENDING_KEY = 'gm_lifi_pending_bridge_v1';

function _lifiSavePending(hash1, amountWei) {
    try {
        localStorage.setItem(LIFI_PENDING_KEY, JSON.stringify({
            wallet: WALLET_ADDRESS, hash1: hash1, amountWei: String(amountWei), at: Date.now()
        }));
    } catch (_) {}
}

function _lifiClearPending() {
    // Runs at the END of a successful bridge — a DOM hiccup here must never
    // bubble into the caller's catch and report a completed bridge as failed.
    try { localStorage.removeItem(LIFI_PENDING_KEY); } catch (_) {}
    try {
        const b = document.getElementById('btnLifiResume');
        if (b && b.style) b.style.display = 'none';
    } catch (_) {}
}

function _lifiGetPending() {
    try {
        const p = JSON.parse(localStorage.getItem(LIFI_PENDING_KEY) || 'null');
        if (!p || !p.hash1 || !p.wallet) return null;
        if (String(p.wallet).toLowerCase() !== String(WALLET_ADDRESS).toLowerCase()) return null;
        if (Date.now() - (p.at || 0) > 7 * 24 * 60 * 60 * 1000) { _lifiClearPending(); return null; }
        return p;
    } catch (_) { return null; }
}

// Shared step-2 executor: switch to Base, fetch step 2's tx, sign it.
async function _lifiExecuteStep2(signer, provider, step2) {
    _lifiSetStep(2, 'Step 2 of 2 — confirm on Base');
    const btn = document.getElementById('btnLifiBridge');
    if (provider) { try { await _lifiSwitchChain(provider, LIFI_BASE_CHAIN_HEX); } catch (_) {} }
    if (btn) btn.innerHTML = '<span class="spinner-inline"></span> Confirm on Base (2 of 2)…';
    showLifiAlert('alert-info', 'Step 2 of 2 — this is the <strong>last</strong> confirmation. Approve it on <strong>Base</strong> to receive your ETH.');
    const hash2 = await _lifiSendStepTx(signer, step2);
    showLifiAlert('alert-success',
        `✅ Bridged! Your ETH is on Base.<br>` +
        `<a class="info-link" href="https://basescan.org/tx/${hash2}" target="_blank" rel="noopener">View on BaseScan ↗</a>`);
    _lifiSetStep('done', 'Done');
    _lifiClearPending();
    try { loadLifiCeloBalance(); } catch (_) {}
}

function _lifiShowResumeIfPending() {
    const b = document.getElementById('btnLifiResume');
    if (b && b.style) b.style.display = _lifiGetPending() ? '' : 'none';
}

async function resumeLifiBridge() {
    const pending = _lifiGetPending();
    if (!pending) { _lifiClearPending(); return showLifiAlert('alert-error', '❌ Nothing to finish — start a new bridge.'); }
    const btn = document.getElementById('btnLifiResume');
    if (btn) btn.disabled = true;
    try {
        showLifiAlert('alert-info', 'Checking whether your CELO has arrived on Base…');
        // The amount input is empty after a reload — restore it from the
        // pending record, otherwise the quote request has nothing to price and
        // the resume would fail on a blank field. Never CLEAR the pending
        // marker here: a transient rebuild failure must stay retryable.
        const amountEl = document.getElementById('lifiAmountCelo');
        if (amountEl && !parseFloat(amountEl.value) && pending.amountWei) {
            try { amountEl.value = ethers.formatEther(pending.amountWei); } catch (_) {}
        }
        await fetchLifiQuote();
        // Only the destination step is left — the Celo leg already broadcast.
        const step2 = _lifiQuote && _lifiQuote.steps && _lifiQuote.steps[1];
        if (!step2) {
            return showLifiAlert('alert-error', '❌ Could not rebuild the destination step right now. Your funds are safe on Base — retry in a moment, or contact support.');
        }
        const signer = await getConnectedSwapSigner();
        const signerAddr = await signer.getAddress();
        if (signerAddr.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
            throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
        }
        const provider = (signer.provider && typeof signer.provider.request === 'function') ? signer.provider : null;
        await _lifiExecuteStep2(signer, provider, step2);
    } catch (err) {
        const friendly = (window.GMTxError && GMTxError.format)
            ? GMTxError.format(err, { nativeSymbol: 'CELO' })
            : (err && (err.shortMessage || err.message) || 'Could not finish the bridge.');
        showLifiAlert('alert-error', '❌ ' + friendly);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _lifiPollStatus(txHash, onUpdate) {
    // Poll until DONE/FAILED. A bridge is not "done" when the source tx
    // confirms — LI.FI knows when the destination leg has actually landed.
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch('/api/bridge/lifi/status?tx_hash=' + encodeURIComponent(txHash));
            const data = await resp.json().catch(() => ({}));
            if (data.success && data.status) {
                const s = data.status.status;
                if (onUpdate) onUpdate(data.status);
                if (s === 'DONE' || s === 'FAILED') return data.status;
            }
        } catch (_) { /* transient */ }
        await _delay(6000);
    }
    return null;
}

// ── Phase 2 — in-app CELO → source stablecoin pre-swap ────────────────────
// Native CELO cannot bridge directly (LI.FI-side), and a user may only hold
// CELO. Rather than sending them to Jumper, swap CELO → cUSD on Celo (the
// deepest CELO/stable pool, verified via the Uniswap V3 quoter) with the SAME
// audited UniversalRouter + Permit2 path the GoodSwap tab uses, then continue.
async function _lifiMaybePreSwapToSource(sourceToken, neededHuman) {
    const btn = document.getElementById('btnLifiBridge');
    if (btn) btn.innerHTML = '<span class="spinner-inline"></span> Swapping CELO → ' + sourceToken.symbol + '…';
    showLifiAlert('alert-info',
        `You have no <strong>${sourceToken.symbol}</strong> on Celo. This bridge needs it as the source token, ` +
        `so a small <strong>CELO → ${sourceToken.symbol}</strong> swap will run first (2 confirmations), then the bridge.`);

    let signer;
    try {
        signer = await getConnectedSwapSigner();
        const signerAddr = await signer.getAddress();
        if (signerAddr.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
            throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
        }
    } catch (err) {
        showLifiAlert('alert-error', '❌ ' + ((err && (err.shortMessage || err.message)) || 'Could not connect your wallet.'));
        return false;
    }

    const celoToken = { key: 'CELO', symbol: 'CELO', address: window.GM_SWAP_BOOT.lifiCeloErc20 || '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18, displayDecimals: 4, isMulti: false };
    // Swap a bit more than needed to cover slippage on the source amount.
    let amountIn;
    try { amountIn = ethers.parseUnits(String(neededHuman), 18); } catch (_) { amountIn = 0n; }
    if (amountIn <= 0n) { showLifiAlert('alert-error', '❌ Enter a valid amount first.'); return false; }

    const provider = signer.provider;
    try {
        // Reserve gas — native CELO is the gas token here.
        const GAS_BUFFER = ethers.parseUnits('0.01', 18);
        const bal = await provider.getBalance(WALLET_ADDRESS);
        if (bal <= GAS_BUFFER) {
            showLifiAlert('alert-error', '❌ You need a little more CELO for the swap gas. Top up CELO and retry.');
            return false;
        }
        const maxSafe = bal - GAS_BUFFER;
        if (amountIn > maxSafe) amountIn = maxSafe;

        const readProvider = new ethers.JsonRpcProvider(CELO_RPC);
        const quoter = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, readProvider);

        // CELO→cUSD is the deepest CELO/stable pool; CELO→USDC/USDT have no
        // direct V3 liquidity, so if the chosen stablecoin has no pool we swap
        // to cUSD and bridge THAT (cUSD → ETH(Base) routes in two steps).
        // Only targets the swap-core TOKENS registry knows are usable.
        const swapTokens = (typeof TOKENS !== 'undefined') ? TOKENS : {};
        const tryTargets = [sourceToken.key];
        if (sourceToken.key !== LIFI_PRESWAP_TARGET_KEY) tryTargets.push(LIFI_PRESWAP_TARGET_KEY);
        const usableTargets = tryTargets.filter(k => swapTokens[LIFI_SWAP_TOKEN_KEY[k] || k]);

        let best = null;
        let targetToken = null;
        for (const key of usableTargets) {
            const t = _lifiSourceToken(key);
            let candidate = null;
            for (const fee of LIFI_PRESWAP_FEE_TIERS) {
                try {
                    const [out] = await quoter.quoteExactInputSingle.staticCall({
                        tokenIn: celoToken.address, tokenOut: t.address,
                        amountIn, fee, sqrtPriceLimitX96: 0n,
                    });
                    if (out > 0n && (!candidate || out > candidate.amountOut)) candidate = { amountOut: out, fee };
                } catch (_) { /* no pool at this fee tier */ }
            }
            if (candidate) { best = candidate; targetToken = t; break; }
        }
        if (!best || !targetToken) {
            showLifiAlert('alert-error', `❌ Could not find a CELO → stablecoin pool to swap through right now. Please try again later, or use Jumper directly.`);
            _showLifiJumperFallback();
            return false;
        }
        if (targetToken.key !== sourceToken.key) {
            // Switch the pane to the token we can actually obtain.
            _lifiSourceKey = targetToken.key;
            _lifiRenderSourceToken();
            showLifiAlert('alert-info',
                `No direct CELO → ${sourceToken.symbol} market, so the swap will go CELO → ${targetToken.symbol} and bridge that instead.`);
        }
        targetToken.displayDecimals = 4;
        targetToken.isMulti = false;

        showLifiAlert('alert-info', `<span class="spinner-inline"></span> Step 1/2 — approving CELO for the swap…`);
        const quote = { fromToken: 'CELO', toToken: LIFI_SWAP_TOKEN_KEY[targetToken.key] || targetToken.key, fee: best.fee, isMulti: false, amountIn, amountOut: best.amountOut };
        await ensureWalletPermit2Allowance(celoToken, amountIn, signer, document.getElementById('stepIndicators'));

        const amountOutMin = best.amountOut * 97n / 100n; // 3% slippage
        showLifiAlert('alert-info', `<span class="spinner-inline"></span> Step 2/2 — confirm the CELO → ${targetToken.symbol} swap in your wallet…`);
        const router = new ethers.Contract(UNISWAP_ROUTER, UNIVERSAL_ROUTER_ABI, signer);
        const { commands, inputs, deadline } = buildUniversalRouterV3Swap(quote, WALLET_ADDRESS, amountIn, amountOutMin);
        const swapTx = await router.execute(commands, inputs, deadline);
        await swapTx.wait();
        showLifiAlert('alert-info',
            `✅ Swap done — now bridging ${targetToken.symbol} to Base…<br>` +
            `<a class="info-link" href="https://celoscan.io/tx/${swapTx.hash}" target="_blank" rel="noopener">View the swap on CeloScan ↗</a>`);
        // Refresh the source balance + re-quote so the bridge uses the new funds.
        await _lifiLoadSourceBalance();
        const input = document.getElementById('lifiAmountCelo');
        if (input) {
            try {
                const received = parseFloat(ethers.formatUnits(best.amountOut, targetToken.decimals));
                // Use the smaller of (requested, actually received) so the bridge
                // never asks for more than the wallet holds.
                input.value = String(Math.min(neededHuman, received * 0.99));
            } catch (_) {}
        }
        _lifiQuote = null;
        await fetchLifiQuote();
        if (!_lifiQuote) {
            showLifiAlert('alert-error', '❌ The CELO → ' + targetToken.symbol + ' swap succeeded, but no bridge route is available for that amount right now. Please retry.');
            return false;
        }
        return true;
    } catch (err) {
        const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err && (err.shortMessage || err.message) || 'Swap failed.');
        showLifiAlert('alert-error', '❌ Pre-swap failed: ' + friendly);
        return false;
    }
}

async function executeLifiBridge() {
    if (_lifiBridgeInFlight) return;
    clearLifiAlert();
    const btn = document.getElementById('btnLifiBridge');
    const amountEl = document.getElementById('lifiAmountCelo');
    const amount = parseFloat(amountEl && amountEl.value);
    const sourceToken = _lifiSourceToken();

    if (!isFinite(amount) || amount <= 0) {
        return showLifiAlert('alert-error', `❌ Enter a valid ${sourceToken.symbol} amount.`);
    }
    if (!_lifiQuote) {
        await fetchLifiQuote();
    }
    if (!_lifiQuote || !_lifiQuote.steps || !_lifiQuote.steps.length) {
        const reason = _lifiQuoteError || 'No route available for this amount. Try a smaller amount.';
        // Offer the one-tap fallback (already computed by fetchLifiQuote) so the
        // user is never stuck when the native-CELO source cannot build.
        await _lifiOfferFallbackOnFailure();
        return showLifiAlert('alert-error', '❌ ' + reason);
    }

    _lifiBridgeInFlight = true;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-inline"></span> Preparing…'; }

    // Destination-gas preflight — only a route that ends with a swap on Base
    // (a 2-step route) needs ETH there. A 1-step stablecoin route has no
    // destination signature, so the check is skipped entirely. Hoisted out of
    // the try so the catch can restore the right step label.
    const twoStep = (_lifiQuote.steps.length > 1);
    try {
        if (twoStep) {
            // Try each Base RPC; only a confirmed low balance (a successful
            // read from ANY node) blocks. An unreadable endpoint is skipped so
            // a single lagging node cannot falsely stop a valid bridge.
            let destGasShort = false;
            let destBalEth = 0;
            for (const rpc of LIFI_BASE_READ_RPCS) {
                try {
                    const baseProvider = new ethers.JsonRpcProvider(rpc, LIFI_BASE_CHAIN_ID);
                    const destBal = await baseProvider.getBalance(WALLET_ADDRESS);
                    destBalEth = parseFloat(ethers.formatEther(destBal));
                    if (destBalEth < LIFI_MIN_DEST_ETH_GAS) destGasShort = true;
                    break; // a successful read is authoritative
                } catch (_) { /* try the next endpoint */ }
            }
            if (destGasShort) {
                throw new Error(`This route finishes with a swap on Base, so it needs a little ETH on Base for that step's gas — ` +
                    `it cannot be paid in CELO. Your Base wallet has ${destBalEth.toFixed(6)} ETH. ` +
                    `Add a small amount of ETH (a few cents) on Base, then retry.`);
            }
        }

        // Phase 2 — if the user chose a stablecoin but holds none, offer an
        // in-app CELO → stablecoin pre-swap first (reusing the Uniswap V3 path
        // already on this page). Only for a non-native source.
        if (!sourceToken.native && _lifiSourceBalanceRaw < 1n) {
            const swapped = await _lifiMaybePreSwapToSource(sourceToken, amount);
            if (!swapped) {
                return; // helper already surfaced the guidance
            }
        }

        const signer = await getConnectedSwapSigner();
        const signerAddr = await signer.getAddress();
        if (signerAddr.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
            throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet.');
        }
        // Step 1 signs on Celo. For the local in-app wallet this switch is a
        // no-op (its provider routes by the tx chain); for injected/WC it
        // prompts. The provider is the wallet's, so both work.
        const provider = (signer.provider && typeof signer.provider.request === 'function')
            ? signer.provider : null;
        if (provider) { try { await _lifiSwitchChain(provider, LIFI_CELO_CHAIN_HEX); } catch (_) {} }

        const stepLabel = twoStep ? 'Step 1 of 2 — confirm on Celo' : 'Confirm on Celo';
        _lifiSetStep(1, stepLabel);
        if (btn) btn.innerHTML = '<span class="spinner-inline"></span> ' + (twoStep ? 'Confirm on Celo (1 of 2)…' : 'Confirm on Celo…');
        showLifiAlert('alert-info', twoStep
            ? 'Step 1 of 2 — confirm the bridge transaction in your wallet (on Celo).'
            : 'Confirm the bridge transaction in your wallet (on Celo).');

        const step1 = _lifiQuote.steps[0];
        await _lifiEnsureAllowance(signer, step1);
        const hash1 = await _lifiSendStepTx(signer, step1);

        // Persist the pending Base leg NOW — if the tab closes before step 2
        // signs, the user gets a "Finish on Base" button instead of stranded
        // funds. The route's from_amount is the wei the quote was built from.
        // (A 1-step route is complete on broadcast, so nothing to resume.)
        if (twoStep) _lifiSavePending(hash1, _lifiQuote.from_amount || '');

        if (!twoStep) {
            // Single-step: the source tx IS the bridge. Poll for delivery so we
            // report a real arrival rather than just a broadcast.
            _lifiSetStep('done', 'Done');
            if (btn) btn.innerHTML = '<span class="spinner-inline"></span> Waiting for delivery…';
            showLifiAlert('alert-info',
                `✅ Bridge sent from Celo.<br>` +
                `<a class="info-link" href="https://celoscan.io/tx/${hash1}" target="_blank" rel="noopener">View on CeloScan ↗</a>`);
            const delivered1 = await _lifiPollStatus(hash1, (st) => {
                if (btn && st && st.substatus_message) {
                    btn.innerHTML = '<span class="spinner-inline"></span> ' + st.substatus_message;
                }
            });
            if (delivered1 && delivered1.status === 'FAILED') {
                throw new Error('The bridge failed. Your funds were not delivered to Base. Please retry.');
            }
            // A 1-step bridge's only tx is the SOURCE tx on Celo, so link
            // CeloScan — a BaseScan link would never resolve this hash.
            showLifiAlert('alert-success',
                `✅ Bridged! Your ETH is on Base.<br>` +
                `<a class="info-link" href="https://celoscan.io/tx/${hash1}" target="_blank" rel="noopener">View the bridge tx ↗</a>`);
            return;
        }

        showLifiAlert('alert-info',
            `✅ Step 1 confirmed on Celo. Now switch your wallet to <strong>Base</strong> to finish.<br>` +
            `<a class="info-link" href="https://celoscan.io/tx/${hash1}" target="_blank" rel="noopener">View on CeloScan ↗</a>`);

        if (btn) btn.innerHTML = '<span class="spinner-inline"></span> Waiting for the bridge…';

        // Wait for the bridge to deliver before the destination swap can
        // execute — LI.FI's status tells us when the funds have arrived.
        const delivered = await _lifiPollStatus(hash1, (st) => {
            if (btn && st && st.substatus_message) {
                btn.innerHTML = '<span class="spinner-inline"></span> ' + st.substatus_message;
            }
        });
        if (delivered && delivered.status === 'FAILED') {
            _lifiClearPending();
            throw new Error(`The bridge failed on the way to Base. Your ${sourceToken.symbol} was not swapped. Please retry.`);
        }

        await _lifiExecuteStep2(signer, provider, _lifiQuote.steps[1]);

        try { loadLifiCeloBalance(); } catch (_) {}
    } catch (err) {
        const friendly = (window.GMTxError && GMTxError.format)
            ? GMTxError.format(err, { nativeSymbol: 'CELO' })
            : (err && (err.shortMessage || err.message) || 'Bridge failed.');
        showLifiAlert('alert-error', '❌ ' + friendly);
        _lifiSetStep(1, twoStep ? 'Step 1 of 2 — confirm on Celo' : 'Confirm on Celo');
    } finally {
        _lifiBridgeInFlight = false;
        if (btn) { btn.disabled = false; btn.innerHTML = 'Bridge to Base'; }
    }
}

function _prewarmLifiBridgeTab() {
    if (_lifiPrewarmed) return;
    _lifiPrewarmed = true;
    try { _lifiRenderSourceToken(); } catch (_) {}
    try { _lifiLoadSourceBalance(); } catch (_) {}
    // Offer to finish a previously-interrupted bridge (see LIFI_PENDING_KEY).
    try { _lifiShowResumeIfPending(); } catch (_) {}
}
window._prewarmLifiBridgeTab = _prewarmLifiBridgeTab;
