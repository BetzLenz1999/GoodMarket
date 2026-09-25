
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
