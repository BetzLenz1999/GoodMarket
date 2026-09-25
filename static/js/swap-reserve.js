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
 *   swap-reserve.js  — GoodReserve, signer resolution, GoodSwap (Uniswap) + Fuse
 *   swap-reserve.js  — GoodReserve (Mento) buy/sell + tab switching
 *   swap-bridge.js   — Bridge tab: Celo <-> XDC (Celo->XDC and XDC->Celo legs)
 */

// ═══════════════════════════════════════════════════════════════════════
// GoodReserve (Mento) tab: G$ ↔ cUSD direct buy/sell against the protocol
// bonding curve. Uses Mento Broker.swapIn(...) on Celo. No DEX, no pool.
// ═══════════════════════════════════════════════════════════════════════
const RESERVE_BROKER   = "0x88de45906D4F5a57315c133620cfa484cB297541";
const RESERVE_PROVIDER = "0x2fFBB49055d487DdBBb0C052Cd7c2a02A7971e41";
const RESERVE_BROKER_ABI = [
    "function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut)",
    "function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)"
];
let reserveDirection = "buy";   // "buy" = cUSD->G$, "sell" = G$->cUSD
let reserveQuote     = null;    // { amountIn, amountOut, exitBps, ratioBps, exchangeId }
let reserveQuoteTimer = null;
const RESERVE_SLIPPAGE_BPS = 50n; // 0.5% safety margin between quote and tx

// Auto-switch to a specific tab if requested via the URL (e.g.
// ?tab=goodswap, ?tab=bridge, #reserve, etc). Runs once on load.
// MiniPay users get the same set of sub-tabs (Uniswap V3 here uses
// CIP-64 fee abstraction). The default landing top tab is the same
// for everyone (GoodSwap → Uniswap V3); users can switch freely.
//
// Back-compat aliases so old ?tab=dex / ?tab=reserve / ?tab=uniswap
// links keep landing on the right sub-pane after the GoodSwap
// consolidation.
(function autoSelectSwapTab() {
    try {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = (params.get("tab") || "").toLowerCase();
        const fromHash  = (window.location.hash || "").replace("#", "").toLowerCase();
        const want = fromQuery || fromHash;

        // Top-level tab target.
        let target = null;
        // Optional GoodSwap sub-tab (only set when caller specifies).
        let goodswapPane = null;

        if (want === "bridge" || want === "xdc" || want === "bridge-xdc") {
            target = "bridge";
        } else if (want === "goodswap" || want === "swap") {
            target = "goodswap";
        } else if (want === "reserve" || want === "goodreserve") {
            target = "goodswap";
            goodswapPane = "reserve";
        } else if (want === "fuse" || want === "fuse-swap" || want === "fuseswap" || want === "voltage") {
            target = "goodswap";
            goodswapPane = "fuse";
        } else if (want === "dex" || want === "uniswap" || want === "uniswapv3" || want === "uniswap-v3" || want === "uniswap_v3") {
            target = "goodswap";
            goodswapPane = "dex";
        }

        // Explicit GoodSwap sub-tab via ?pane=uniswap|reserve.
        const paneRaw = (params.get("pane") || "").toLowerCase();
        if (paneRaw === "reserve" || paneRaw === "goodreserve") {
            if (!target) target = "goodswap";
            goodswapPane = "reserve";
        } else if (paneRaw === "fuse" || paneRaw === "fuse-swap" || paneRaw === "fuseswap" || paneRaw === "voltage") {
            if (!target) target = "goodswap";
            goodswapPane = "fuse";
        } else if (paneRaw === "uniswap" || paneRaw === "uniswapv3" || paneRaw === "uniswap-v3" || paneRaw === "uniswap_v3" || paneRaw === "dex") {
            if (!target) target = "goodswap";
            goodswapPane = "dex";
        }

        // Bridge sub-tab direction (?dir=xdc_to_celo | celo_to_xdc).
        // Used by the /xdc-wallet "Bridge moved to GoodSwap → Bridge"
        // banner so a returning user lands directly on the XDC →
        // Celo sub-pane.
        const dirRaw = (params.get("dir") || "").toLowerCase();
        let bridgeDir = null;
        if (dirRaw === "xdc_to_celo" || dirRaw === "xdc-to-celo" || dirRaw === "xdctocelo") {
            bridgeDir = "xdc_to_celo";
        } else if (dirRaw === "celo_to_xdc" || dirRaw === "celo-to-xdc" || dirRaw === "celotoxdc") {
            bridgeDir = "celo_to_xdc";
        }

        if (!target && !goodswapPane && !bridgeDir) return;

        // "Focused mode": when the user arrived via an explicit
        // ?tab= / ?pane= / ?dir= URL (e.g. clicked a wallet
        // sidebar shortcut), hide the top-level [GoodSwap |
        // Bridge] switcher so they only see the sub-tabs of the
        // section they asked for. This avoids a confusing
        // double-row-of-tabs when the entry point already
        // committed to a section. Switching between sections
        // happens via the wallet sidebar.
        //
        // Bare /swap (no params) still shows both top tabs so
        // existing bookmarks / power-user navigation stay
        // intact.
        const focusBridge   = (target === "bridge") || !!bridgeDir;
        const focusGoodSwap = !focusBridge && ((target === "goodswap") || !!goodswapPane);

        const apply = () => {
            if (typeof setSwapTab !== "function") return;
            if (target === "bridge" && !document.querySelector(".pane-bridge")) return;
            if (bridgeDir && !document.querySelector(".pane-bridge")) return;
            if (target) setSwapTab(target);
            if (goodswapPane && typeof setGoodSwapSubTab === "function") {
                setGoodSwapSubTab(goodswapPane);
            }
            if (bridgeDir && typeof setBridgeSubTab === "function") setBridgeSubTab(bridgeDir);

            if (focusBridge || focusGoodSwap) {
                const switcher = document.getElementById("swapTabSwitcher");
                if (switcher) switcher.style.display = "none";
                // Hide inactive top panes outright so they cannot be
                // reached by toggling a stale top-tab button.
                ["swapPaneGoodSwap", "swapPaneBridge"].forEach((id) => {
                    const pane = document.getElementById(id);
                    const keep = (focusBridge && id === "swapPaneBridge")
                        || (focusGoodSwap && id === "swapPaneGoodSwap");
                    if (pane && !keep) pane.style.display = "none";
                });
            }
        };
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", apply, { once: true });
        } else {
            apply();
        }
    } catch (_) { /* no-op */ }
})();

function setSwapTab(name) {
    const goodswapPane = document.querySelector(".pane-goodswap");
    const bridgePane   = document.querySelector(".pane-bridge");
    const goodswapBtn  = document.getElementById("tabBtnGoodSwap");
    const bridgeBtn    = document.getElementById("tabBtnBridge");
    if (!goodswapPane) return;

    const isBridge   = name === "bridge";
    // Back-compat: 'dex' / 'reserve' aliases route to GoodSwap top
    // tab and leave the sub-tab choice up to the caller (or
    // setGoodSwapSubTab() invoked by autoSelectSwapTab).
    const isGoodSwap = !isBridge;

    goodswapPane.classList.toggle("hidden-tab", !isGoodSwap);
    if (bridgePane) bridgePane.classList.toggle("hidden-tab", !isBridge);

    if (goodswapBtn) {
        goodswapBtn.classList.toggle("active", isGoodSwap);
        goodswapBtn.setAttribute("aria-selected", String(isGoodSwap));
    }
    if (bridgeBtn) {
        bridgeBtn.classList.toggle("active", isBridge);
        bridgeBtn.setAttribute("aria-selected", String(isBridge));
    }

    // Honour 'dex' / 'reserve' shorthand by also flipping the
    // GoodSwap sub-tab so e.g. setSwapTab('reserve') from a button
    // elsewhere in the page still does the obvious thing.
    if (name === "dex" || name === "reserve" || name === "fuse") {
        if (typeof setGoodSwapSubTab === "function") {
            setGoodSwapSubTab(name);
        }
    }

    if (isBridge) {
        // Defined in swap-bridge.js, which loads after this bundle — guard so a
        // missing/failed bundle degrades to no balance refresh instead of
        // aborting the tab switch.
        if (typeof updateCeloBridgeBalanceDisplay === "function") updateCeloBridgeBalanceDisplay();
        // Only now (Bridge tab actually opened) warm the XDC leg.
        if (typeof window._prewarmXdcBridgeTab === "function") window._prewarmXdcBridgeTab();
    }
    if (isBridge && typeof updateBridgeFromBalanceXdcToCelo === "function") updateBridgeFromBalanceXdcToCelo();
}

// Toggle the active sub-pane inside the GoodSwap tab. Each
// sub-pane keeps its existing design rhythm while owning its network.
function setGoodSwapSubTab(name) {
    if (name === "fuse") name = "dex";
    const isReserve = name === "reserve";
    const isFuse    = false;
    const dexPane   = document.getElementById("swapPaneDex");
    const resPane   = document.getElementById("swapPaneReserve");
    const fusePane  = document.getElementById("swapPaneFuse");
    const dexBtn    = document.getElementById("goodswapSubBtnDex");
    const resBtn    = document.getElementById("goodswapSubBtnReserve");
    const fuseBtn   = document.getElementById("goodswapSubBtnFuse");
    // GoodReserve sub-tab is gated by reserve_swap_visible on the
    // server side; if it isn't rendered, silently fall back to dex.
    if (isReserve && !resPane) {
        if (dexPane) dexPane.classList.remove("hidden-tab");
        if (fusePane) fusePane.classList.add("hidden-tab");
        if (dexBtn) {
            dexBtn.classList.add("active");
            dexBtn.setAttribute("aria-selected", "true");
        }
        if (fuseBtn) {
            fuseBtn.classList.remove("active");
            fuseBtn.setAttribute("aria-selected", "false");
        }
        return;
    }
    if (dexPane) dexPane.classList.toggle("hidden-tab",  isReserve || isFuse);
    if (resPane) resPane.classList.toggle("hidden-tab", !isReserve);
    if (fusePane) fusePane.classList.toggle("hidden-tab", !isFuse);
    if (dexBtn) {
        dexBtn.classList.toggle("active", !isReserve && !isFuse);
        dexBtn.setAttribute("aria-selected", String(!isReserve && !isFuse));
    }
    if (resBtn) {
        resBtn.classList.toggle("active", isReserve);
        resBtn.setAttribute("aria-selected", String(isReserve));
    }
    if (fuseBtn) {
        fuseBtn.classList.toggle("active", isFuse);
        fuseBtn.setAttribute("aria-selected", String(isFuse));
    }
    if (isReserve) {
        updateReserveBalanceDisplay();
        // One probe per pane visit (re-checks + repaints on the 2-min poll).
        if (typeof _checkReservePaused === "function" && window.ethers) {
            _ensureReservePauseProbe();
        }
    }
}

function _ensureReservePauseProbe() {
    if (reservePauseCheckDone) {
        _renderReservePauseState();
    } else {
        _checkReservePaused();
    }
    _armReservePausePoll();
}
// Expose so other panes/components could re-probe on demand (e.g. after
// a successful governance revisit); the reserve pane's own visit hook
// calls this already.
window._checkReservePaused = _checkReservePaused;


// Toggle the active sub-pane inside the Bridge tab. Each direction
// owns its own DOM (Celo → XDC was already on /swap; XDC → Celo
// was ported from /xdc-wallet) so the JS state for one direction
// never leaks into the other. We deliberately do NOT auto-switch
// the wallet's chain here — chain switching only happens at the
// moment the user clicks the Bridge button, matching today's
// behavior on both /swap and /xdc-wallet.
function setBridgeSubTab(name) {
    const activeName  = name === "xdc_to_celo" ? "xdc_to_celo" : "celo_to_xdc";
    const isXdcToCelo = activeName === "xdc_to_celo";
    const celoPane    = document.getElementById("bridgeSubPaneCeloToXdc");
    const xdcPane     = document.getElementById("bridgeSubPaneXdcToCelo");
    const celoBtn     = document.getElementById("bridgeSubBtnCeloToXdc");
    const xdcBtn      = document.getElementById("bridgeSubBtnXdcToCelo");
    if (celoPane) celoPane.classList.toggle("hidden-tab",  activeName !== "celo_to_xdc");
    if (xdcPane)  xdcPane.classList.toggle("hidden-tab",   activeName !== "xdc_to_celo");
    if (celoBtn) {
        celoBtn.classList.toggle("active", activeName === "celo_to_xdc");
        celoBtn.setAttribute("aria-selected", String(activeName === "celo_to_xdc"));
    }
    if (xdcBtn) {
        xdcBtn.classList.toggle("active", isXdcToCelo);
        xdcBtn.setAttribute("aria-selected", String(isXdcToCelo));
    }
    if (isXdcToCelo) {
        // Pre-warm balances + fee estimate + wallet provider ONLY now that
        // this direction was opened — page load stays cheap for the majority
        // of /swap visitors who never open the Bridge tab.
        if (typeof window._prewarmXdcBridgeTab === "function") {
            window._prewarmXdcBridgeTab();
        } else {
            if (typeof loadXdcGdBalance === "function") loadXdcGdBalance();
            if (typeof loadXdcNativeBalance === "function") loadXdcNativeBalance();
        }
    } else {
        if (typeof updateCeloBridgeBalanceDisplay === "function") updateCeloBridgeBalanceDisplay();
    }
}

// Protocol-level pause state for the GoodReserve provider. Fetched
// once per visiting the pane (cheap eth_call via the public RPC, also cached
// back-end side for 30s and front-end side for 2 min); when paused,
// the entire reserve sub-tab converts to a clear route-paused state — no
// direction buttons, no amount inputs, no approve/sign path (approving
// or signing would simply revert "Pausable: paused" on-chain).
let reservePaused = false;
let reservePauseCheckDone = false;
let reservePauseCheckTimer = null;
const RESERVE_PAUSE_BANNER_HTML = "⚠️ <strong>GoodReserve is paused by GoodDollar</strong> — buying or selling G$ directly from the reserve cannot execute right now. Please use <strong>Uniswap V3</strong> (G$ ↔ cUSD) instead, or check back later.";
function _reservePauseProbeRpc(raw) {
    try {
        return (parseInt(raw, 16) > 0);
    } catch (_) { return null; }
}
async function _checkReservePaused() {
    try {
        const resp = await fetch("/api/reserve/paused", { method: "GET", headers: { "Accept": "application/json" } });
        const body = await resp.json().catch(() => null);
        if (resp.ok && body && typeof body.paused === "boolean") {
            reservePaused = body.paused;
        } else if (body && typeof body.paused === "boolean") {
            reservePaused = body.paused;
        } else {
            // Unknown — fall back to a direct public-RPC read so the tab
            // never permanently sticks on paused because of a proxy caching
            // quirk. Showing a "route paused" state when the chain says
            // routed paused is the correct user-facing behavior.
            const rpp = new ethers.JsonRpcProvider(CELO_RPC);
            const raw = await rpp.call({ to: RESERVE_PROVIDER, data: "0x5c975abb" });
            reservePaused = _reservePauseProbeRpc(raw) || false;
        }
    } catch (_) {
        // Failure to determine pause state must never let the tab show
        // enterable buttons while the chain is paused — fail-closed to
        // the paused banner (the /api/reserve/paused endpoint fails
        // closed for the same reason).
        reservePaused = true;
    } finally {
        reservePauseCheckDone = true;
    }
    _renderReservePauseState();
}
function _renderReservePauseState() {
    const dirWrap = document.querySelector(".reserve-direction");
    const tokenBoxes = document.querySelectorAll("#swapPaneReserve .token-box");
    const quoteBox = document.getElementById("reserveQuoteBox");
    const exitPill = document.getElementById("reserveExitPill");
    const stepIdx  = document.getElementById("reserveStepIndicators");
    const maxBtns   = document.querySelectorAll("#swapPaneReserve .max-btn");
    const amountIn  = document.getElementById("reserveAmountIn");
    const amountOut = document.getElementById("reserveAmountOut");
    const btn = document.getElementById("reserveBtn");
    const alert = document.getElementById("reserveAlert");
    const banner = document.getElementById("reservePausedBanner");
    // Clear any in-flight quote state when the pause verdict lands (a quote
    // fetched pre-verdict/while-unpaused must not linger into a paused UI.
    if (reservePaused && reserveQuote) {
        reserveQuote = null;
        if (quoteBox) quoteBox.classList.add("hidden");
    }
    if (dirWrap) dirWrap.style.display = reservePaused ? "none" : "";
    tokenBoxes.forEach((tb => { tb.style.display = reservePaused ? "none" : ""; }));
    maxBtns.forEach((mb => { mb.style.display = reservePaused ? "none" : ""; }));
    if (exitPill) exitPill.style.display = "none";
    if (stepIdx) stepIdx.style.display = reservePaused ? "none" : "";
    if (amountIn) amountIn.value = "";
    if (amountOut) amountOut.value = "";
    if (btn) {
        if (reservePaused) {
            btn.disabled = true;
            btn.textContent = "Reserve paused";
        } else if (reserveQuote) {
            setReserveBtnState("ready");
        } else {
            setReserveBtnState("enter");
        }
    }
    if (alert) alert.className = "alert";
    if (banner) {
        banner.style.display = reservePaused ? "block" : "none";
    }
    if (reservePaused) {
        showReserveAlert("alert-error", RESERVE_PAUSE_BANNER_HTML);
    } else {
        clearReserveAlert();
    }
}
function _armReservePausePoll() {
    if (reservePauseCheckTimer) clearInterval(reservePauseCheckTimer);
    // The pause verdict can change via governance; re-check every 2 min
    // only while the user stays on the pane. When it flips, the render
    // application updates the tab automatically (including the quote box hide).
    reservePauseCheckTimer = setInterval(() => {
        if (document.visibilityState === "hidden") return;
        if (reservePaused && reserveQuote) reserveQuote = null;
        _checkReservePaused();
    }, 120000);
}

function setReserveDirection(dir) {
    reserveDirection = dir === "sell" ? "sell" : "buy";
    const buyBtn  = document.getElementById("reserveDirBuy");
    const sellBtn = document.getElementById("reserveDirSell");
    if (buyBtn)  buyBtn.classList.toggle("active",  reserveDirection === "buy");
    if (sellBtn) sellBtn.classList.toggle("active", reserveDirection === "sell");
    // Swap From / To labels
    const fromIcon = document.getElementById("reserveFromIcon");
    const fromSym  = document.getElementById("reserveFromSymbol");
    const toIcon   = document.getElementById("reserveToIcon");
    const toSym    = document.getElementById("reserveToSymbol");
    if (reserveDirection === "buy") {
        fromIcon.className = "token-icon cusd";
        fromIcon.textContent = "$";
        fromSym.textContent = "cUSD";
        toIcon.className = "token-icon gd";
        toIcon.textContent = "G$";
        toSym.textContent = "G$";
    } else {
        fromIcon.className = "token-icon gd";
        fromIcon.textContent = "G$";
        fromSym.textContent = "G$";
        toIcon.className = "token-icon cusd";
        toIcon.textContent = "$";
        toSym.textContent = "cUSD";
    }
    // Reset amounts and re-quote
    const inEl  = document.getElementById("reserveAmountIn");
    const outEl = document.getElementById("reserveAmountOut");
    if (inEl)  inEl.value  = "";
    if (outEl) outEl.value = "";
    const qb = document.getElementById("reserveQuoteBox");
    if (qb) qb.classList.add("hidden");
    setReserveBtnState("enter");
    updateReserveBalanceDisplay();
}

function updateReserveBalanceDisplay() {
    const fromEl = document.getElementById("reserveFromBalance");
    const toEl   = document.getElementById("reserveToBalance");
    if (!fromEl || !toEl) return;
    const gd = (typeof gdBalanceNum === "number") ? gdBalanceNum : 0;
    const cusd = (typeof cusdBalanceNum === "number") ? cusdBalanceNum : 0;
    if (reserveDirection === "buy") {
        fromEl.textContent = cusd.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " cUSD";
        toEl.textContent   = gd.toLocaleString(undefined,   { maximumFractionDigits: 2 }) + " G$";
    } else {
        fromEl.textContent = gd.toLocaleString(undefined,   { maximumFractionDigits: 2 }) + " G$";
        toEl.textContent   = cusd.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " cUSD";
    }
}

function setReserveMax() {
    const inEl = document.getElementById("reserveAmountIn");
    if (!inEl) return;
    const bal = (reserveDirection === "buy")
        ? (typeof cusdBalanceNum === "number" ? cusdBalanceNum : 0)
        : (typeof gdBalanceNum === "number" ? gdBalanceNum : 0);
    if (!bal || bal <= 0) return;
    inEl.value = String(bal);
    onReserveAmountChange();
}

function setReserveBtnState(state, customText) {
    const btn = document.getElementById("reserveBtn");
    if (!btn) return;
    btn.disabled = (state !== "ready");
    const dirLabel = reserveDirection === "buy" ? "Buy G$" : "Sell G$";
    const map = {
        enter:   "Enter an amount",
        quoting: "Fetching quote…",
        ready:   dirLabel,
        loading: customText || "Processing…",
        done:    "Done!"
    };
    btn.textContent = map[state] || dirLabel;
}

function showReserveAlert(cls, html) {
    const alert = document.getElementById("reserveAlert");
    if (!alert) return;
    alert.className = "alert " + cls + " show";
    alert.innerHTML = html;
}
function clearReserveAlert() {
    const alert = document.getElementById("reserveAlert");
    if (!alert) return;
    alert.className = "alert";
    alert.innerHTML = "";
}

function onReserveAmountChange() {
    const inEl = document.getElementById("reserveAmountIn");
    const outEl = document.getElementById("reserveAmountOut");
    const qb = document.getElementById("reserveQuoteBox");
    if (!inEl || !outEl) return;
    const raw = (inEl.value || "").trim();
    if (!raw || parseFloat(raw) <= 0) {
        outEl.value = "";
        if (qb) qb.classList.add("hidden");
        reserveQuote = null;
        setReserveBtnState("enter");
        return;
    }
    setReserveBtnState("quoting");
    if (reserveQuoteTimer) clearTimeout(reserveQuoteTimer);
    reserveQuoteTimer = setTimeout(() => fetchReserveQuote(raw), 350);
}

function _reserveQuoteFromResponse(data) {
    if (!data || !data.success) {
        const err = new Error(data && data.error ? data.error : "Quote failed");
        // Keep the sell-pool gate distinguishable from a normal RPC
        // failure: users should not retry an L0-limited swap/approval.

        err.liquidity_error = !!(data && data.liquidity_error);
        err._gmRoutePaused   = !!(data && data.route_paused);
        if (err.liquidity_error || err._gmRoutePaused) err._gmFriendly = true;
        throw err;
    }
    const amountIn  = BigInt(data.amount_in_wei);
    const amountOut = BigInt(data.amount_out_wei);
    if (amountIn <= 0n || amountOut <= 0n || !data.exchange_id) {
        throw new Error("GoodReserve returned an invalid quote. Please try again.");
    }
    return {
        amountIn, amountOut,
        exitBps:  Number(data.exit_contribution_bps || 0),
        ratioBps: Number(data.reserve_ratio_bps || 0),
        exchangeId: data.exchange_id,
        broker:   data.broker,
        provider: data.provider,
        gd:       data.gd,
        cusd:     data.cusd
    };
}

async function _requestReserveQuote(amount, forceFresh = false) {
    const resp = await fetch("/api/reserve/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            direction: reserveDirection,
            amount: String(amount),
            // A quote made before wallet approval can be old by the time
            // swapIn is signed. Bypass the short server cache for the
            // final pre-swap check so amountOutMin is current.
            force: !!forceFresh
        })
    });
    if (!resp.ok && resp.status !== 400 && resp.status !== 503) {
        throw new Error(`Server error (HTTP ${resp.status})`);
    }
    let data;
    try { data = await resp.json(); }
    catch (_je) { throw new Error("Server returned an invalid response — please try again."); }
    return _reserveQuoteFromResponse(data);
}

async function _refreshReserveQuoteForSwap() {
    if (!reserveQuote) throw new Error("Please enter an amount first.");
    const quotedDirection = reserveDirection;
    const exactAmount = ethers.formatUnits(reserveQuote.amountIn, 18);
    const fresh = await _requestReserveQuote(exactAmount, true);
    // Do not let a direction flip or a changed input while a request is
    // in flight sign a quote for the wrong side of the reserve.
    if (quotedDirection !== reserveDirection) {
        throw new Error("Swap details changed. Please review the new quote and try again.");
    }
    reserveQuote = fresh;
    renderReserveQuote();
    return fresh;
}

async function fetchReserveQuote(amount) {
    try {
        const data = await _requestReserveQuote(amount);
        // Backend re-simulates the swapIn call a quote time and refuses a
        // quote the Mento L0 cap can't honor (the "L0Out Exceeded"
        // bug — users were approving/signing then seeing a revert, with the
        // balance never changing). Surface that as a warning instead of
        // ever offering to approve/sign.
        reserveQuote = data;
        renderReserveQuote();
        setReserveBtnState("ready");
        clearReserveAlert();
    } catch (err) {
        console.error("[reserve] quote error", err);
        reserveQuote = null;
        const qb = document.getElementById("reserveQuoteBox");
        if (qb) qb.classList.add("hidden");
        setReserveBtnState("enter");
        // Route-level pause (whole provider paused by governance). No
        // approve/sign path exists when paused — every buy/sell hasto
        // revert "Pausable: paused" on-chain, so surface the honest
        // paused banner instead of an opaque HTTP/quote error.
        if (err && err._gmRoutePaused) {
            reservePaused = true;
            reservePauseCheckDone = true;
            _renderReservePauseState();
            return;
        }
        if (err && err.liquidity_error) {
            showReserveAlert("alert-warning", `⚠️ ${err.message || "The GoodReserve G$ sell pool currently cannot honor this amount. Please try a smaller amount or use Uniswap V3."}`);
            return;
        }
        showReserveAlert("alert-error", `❌ Could not fetch reserve quote: ${(err.message || err).toString().substring(0,140)}`);
    }
}

function renderReserveQuote() {
    if (!reserveQuote) return;
    const outEl = document.getElementById("reserveAmountOut");
    const qb    = document.getElementById("reserveQuoteBox");
    if (!outEl || !qb) return;
    const fromSym = reserveDirection === "buy" ? "cUSD" : "G$";
    const toSym   = reserveDirection === "buy" ? "G$"   : "cUSD";
    const inH  = parseFloat(ethers.formatUnits(reserveQuote.amountIn, 18));
    const outH = parseFloat(ethers.formatUnits(reserveQuote.amountOut, 18));
    outEl.value = outH.toLocaleString(undefined, { maximumFractionDigits: reserveDirection === "buy" ? 2 : 4 });

    const rate = inH > 0 ? (outH / inH) : 0;
    const rateStr = `1 ${fromSym} ≈ ${rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toSym}`;
    document.getElementById("reserveQuoteRate").textContent = rateStr;

    const minOut = (reserveQuote.amountOut * (10000n - RESERVE_SLIPPAGE_BPS)) / 10000n;
    const minOutH = parseFloat(ethers.formatUnits(minOut, 18));
    document.getElementById("reserveQuoteMinOut").textContent =
        `${minOutH.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toSym}`;

    const exitRow = document.getElementById("reserveExitRow");
    const exitPill = document.getElementById("reserveExitPill");
    const exitTxt  = document.getElementById("reserveExitText");
    if (reserveDirection === "sell" && reserveQuote.exitBps > 0) {
        const exitPct = (reserveQuote.exitBps / 100).toFixed(2);
        exitRow.style.display = "";
        document.getElementById("reserveQuoteExit").textContent = `${exitPct}%`;
        exitPill.style.display = "inline-flex";
        exitTxt.textContent = `Exit contribution: ${exitPct}% (deducted on sells, returns to reserve)`;
    } else {
        exitRow.style.display = "none";
        exitPill.style.display = "none";
    }

    const ratioPct = (reserveQuote.ratioBps / 100).toFixed(2);
    document.getElementById("reserveQuoteRatio").textContent = `${ratioPct}%`;
    qb.classList.remove("hidden");
}

async function startReserveSwap() {
    if (!reserveQuote) {
        showReserveAlert("alert-error", "Please enter an amount first.");
        return;
    }
    clearReserveAlert();

    // Local wallets: prompt for PIN if the wallet has auto-locked.
    try { await _lwUnlockIfNeeded(); } catch (e) { showReserveAlert("alert-error", "Please unlock your wallet to continue."); return; }

    // MiniPay users need stablecoin (cUSD/USDT/USDC) for gas, not CELO.
    // Instead of auto-faucet (which wastes faucet funds), guide users to
    // claim G$ on GoodMarket first to receive cUSD for gas.
    if (window.MPGasTopUp && window.MPGasTopUp.isMiniPay() && (LOGIN_METHOD || '').toLowerCase() !== 'local') {
        // Check if user has stablecoin for gas
        const hasStablecoin = await checkMiniPayStablecoinBalance();
        if (!hasStablecoin) {
            showReserveAlert('alert-error',
                '❌ Swap requires stablecoin for gas<br><br>'
                + 'MiniPay uses stablecoins (cUSD/USDT/USDC) for transaction fees, not CELO.<br><br>'
                + 'Please claim your G$ on GoodMarket first to receive gas support, or keep at least ~0.015 cUSD/USDT/USDC for fees.<br><br>'
                + '<button onclick="window.location.href=\'/wallet\'" '
                + 'style="background:linear-gradient(135deg,#7c3aed,#5b21b6);border:none;border-radius:12px;'
                + 'color:#fff;font-size:0.9rem;font-weight:700;padding:0.7rem 1.2rem;cursor:pointer;">'
                + '💰 Claim G$ on GoodMarket</button>'
            );
            setReserveBtnState("enter");
            return;
        }
    }

    const stepIndicators = document.getElementById("reserveStepIndicators");
    const step1 = document.getElementById("reserveStep1");
    const step2 = document.getElementById("reserveStep2");
    const fromAddr = reserveDirection === "buy" ? reserveQuote.cusd : reserveQuote.gd;
    const toAddr   = reserveDirection === "buy" ? reserveQuote.gd   : reserveQuote.cusd;
    const fromSym  = reserveDirection === "buy" ? "cUSD" : "G$";

    try {
        let amountIn = reserveQuote.amountIn;
        // Recompute minOut with safety margin from quoted amount
        let minOut = (reserveQuote.amountOut * (10000n - RESERVE_SLIPPAGE_BPS)) / 10000n;

        // MiniPay needs raw EIP-1193 sends so we can attach/fallback CIP-64
        // feeCurrency hints. ethers.js BrowserProvider does not retry with
        // USDT/USDC adapters, which made users with only USDT fail here.
        if (_isMiniPay()) {
            const readProvider = new ethers.JsonRpcProvider(CELO_RPC);
            const tokenRead = new ethers.Contract(fromAddr, ERC20_ABI, readProvider);

            stepIndicators.className = "step-indicators show";
            step1.className = "step active";
            step2.className = "step";
            setReserveBtnState("loading", "Checking allowance…");
            showReserveAlert("alert-info", `<span class="spinner-inline"></span> Step 1/2 — Approving ${fromSym} for GoodReserve in MiniPay…`);

            const allowance = await tokenRead.allowance(WALLET_ADDRESS, RESERVE_BROKER);
            if (allowance < amountIn) {
                try {
                    await GMTxPreview.confirm({
                        action: 'approve',
                        token: fromSym,
                        amount: ethers.formatUnits(amountIn, 18),
                        to: RESERVE_BROKER,
                        toLabel: 'GoodReserve / Mento Broker',
                        network: 'Celo',
                        note: 'Exact-amount approval for the GoodReserve swap; MiniPay will pay gas from an available stablecoin.',
                    });
                } catch (err) {
                    if (GMTxPreview.isCancelled(err)) {
                        setReserveBtnState("ready");
                        stepIndicators.className = "step-indicators";
                        showReserveAlert("alert-info", "Swap cancelled.");
                        return;
                    }
                    throw err;
                }
                await _miniPayTx(
                    fromAddr,
                    "function approve(address spender, uint256 amount) returns (bool)",
                    [RESERVE_BROKER, amountIn]
                );
            }
            step1.className = "step done";

            // Approval can take long enough for the curve quote to
            // move. Re-fetch and re-simulate the exact amount before
            // sending swapIn, rather than submitting an old minOut.
            setReserveBtnState("loading", "Refreshing quote…");
            const freshQuote = await _refreshReserveQuoteForSwap();
            amountIn = freshQuote.amountIn;
            minOut = (freshQuote.amountOut * (10000n - RESERVE_SLIPPAGE_BPS)) / 10000n;

            step2.className = "step active";
            setReserveBtnState("loading", reserveDirection === "buy" ? "Buying G$…" : "Selling G$…");
            showReserveAlert("alert-info", `<span class="spinner-inline"></span> Step 2/2 — Confirm GoodReserve swap in MiniPay…`);

            const brokerIface = new ethers.Interface(RESERVE_BROKER_ABI);
            const swapData = brokerIface.encodeFunctionData("swapIn", [
                RESERVE_PROVIDER,
                reserveQuote.exchangeId,
                fromAddr,
                toAddr,
                amountIn,
                minOut
            ]);
            const txHash = await _miniPayRawTx(RESERVE_BROKER, swapData, '0x0', 'reserve.swapIn');
            step2.className = "step done";
            setReserveBtnState("done");
            showReserveAlert("alert-success",
                `✅ ${reserveDirection === "buy" ? "Bought" : "Sold"} successfully! ` +
                `<a href="https://celoscan.io/tx/${txHash}" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:underline;">View on CeloScan ↗</a>`);

            // Fire-and-forget forced refresh: don't hold the success toast up
            // on forno round-trips, and ask ?force=1 so the backend's
            // short-lived balance cache is bypassed (stale pre-swap number).
            displayBalances();
            updateReserveBalanceDisplay();
            try { loadBalances(true); } catch (_) {}
            document.getElementById("reserveAmountIn").value = "";
            document.getElementById("reserveAmountOut").value = "";
            document.getElementById("reserveQuoteBox").classList.add("hidden");
            reserveQuote = null;
            setTimeout(() => {
                setReserveBtnState("enter");
                stepIndicators.className = "step-indicators";
            }, 4000);
            return;
        }

        const signer = await getConnectedSwapSigner();

        // ── Step 1: ensure allowance for the broker ─────────────────────
        stepIndicators.className = "step-indicators show";
        step1.className = "step active";
        step2.className = "step";
        setReserveBtnState("loading", "Checking allowance…");
        showReserveAlert("alert-info", `<span class="spinner-inline"></span> Step 1/2 — Approving ${fromSym} for GoodReserve…`);

        const tokenContract = new ethers.Contract(fromAddr, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(WALLET_ADDRESS, RESERVE_BROKER);
        if (allowance < amountIn) {
            setReserveBtnState("loading", "Approving token…");
            try {
                // cUSD and G$ on Celo are both 18-decimal; this path
                // never touches a non-18-decimal token, so we hardcode
                // instead of looking up a non-existent `fromDecimals`.
                await GMTxPreview.confirm({
                    action: 'approve',
                    token: fromSym,
                    amount: ethers.formatUnits(amountIn, 18),
                    to: RESERVE_BROKER,
                    toLabel: 'GoodReserve / Mento Broker',
                    network: 'Celo',
                    note: 'Exact-amount approval for the GoodReserve swap; nothing carries over after this transaction.',
                });
            } catch (err) {
                if (GMTxPreview.isCancelled(err)) {
                    setReserveBtnState("ready");
                    stepIndicators.className = "step-indicators";
                    showReserveAlert("alert-info", "Swap cancelled.");
                    return;
                }
                throw err;
            }
            // Exact-amount approval (not unlimited) for safety
            const approveTx = await tokenContract.approve(RESERVE_BROKER, amountIn);
            await approveTx.wait();
        }
        step1.className = "step done";

        // The approval confirmation may take several blocks. Refresh
        // the reserve quote after it confirms so a price movement does
        // not turn a valid G$/cUSD swap into an avoidable revert.
        setReserveBtnState("loading", "Refreshing quote…");
        const freshQuote = await _refreshReserveQuoteForSwap();
        amountIn = freshQuote.amountIn;
        minOut = (freshQuote.amountOut * (10000n - RESERVE_SLIPPAGE_BPS)) / 10000n;

        // ── Step 2: swapIn on the Mento broker ─────────────────────────
        step2.className = "step active";
        setReserveBtnState("loading", reserveDirection === "buy" ? "Buying G$…" : "Selling G$…");
        showReserveAlert("alert-info", `<span class="spinner-inline"></span> Step 2/2 — Confirm in your wallet…`);

        const broker = new ethers.Contract(RESERVE_BROKER, RESERVE_BROKER_ABI, signer);
        const swapTx = await broker.swapIn(
            RESERVE_PROVIDER,
            reserveQuote.exchangeId,
            fromAddr,
            toAddr,
            amountIn,
            minOut
        );
        showReserveAlert("alert-info", `<span class="spinner-inline"></span> Submitting transaction…`);
        const receipt = await swapTx.wait();
        step2.className = "step done";
        setReserveBtnState("done");
        const txLink = `https://celoscan.io/tx/${receipt.hash || swapTx.hash}`;
        showReserveAlert("alert-success",
            `✅ ${reserveDirection === "buy" ? "Bought" : "Sold"} successfully! ` +
            `<a href="${txLink}" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:underline;">View on CeloScan ↗</a>`);

        // Refresh balances + UI — fire-and-forget forced refresh so the
        // success toast didn't wait on forno, and ?force=1 bypasses the
        // backend's short-lived balance cache (stale pre-swap number).
        displayBalances();
        updateReserveBalanceDisplay();
        try { loadBalances(true); } catch (_) {}
        document.getElementById("reserveAmountIn").value = "";
        document.getElementById("reserveAmountOut").value = "";
        document.getElementById("reserveQuoteBox").classList.add("hidden");
        reserveQuote = null;
        setTimeout(() => {
            setReserveBtnState("enter");
            stepIndicators.className = "step-indicators";
        }, 4000);
    } catch (err) {
        console.error("[reserve] swap error", err);
        stepIndicators.className = "step-indicators";
        // The wallet/RPC may surface a GoodReserve sell/buy revert as the
        // opaque "missing revert data" (ethers v6 has no revert `data`
        // blob to decode). Re-simulate the exact swapIn calldata against
        // several public Celo RPCs to recover the real reason, and fall
        // back to an allowance/balance diagnostic when none carry data.
        try {
            const brokerIface2 = new ethers.Interface(RESERVE_BROKER_ABI);
            const simData = brokerIface2.encodeFunctionData("swapIn", [
                RESERVE_PROVIDER,
                reserveQuote ? reserveQuote.exchangeId : ethers.ZeroHash,
                fromAddr,
                toAddr,
                reserveQuote ? reserveQuote.amountIn : 0n,
                0n
            ]);
            await _enrichSwapError(err, {
                to: RESERVE_BROKER, data: simData, from: WALLET_ADDRESS, value: '0x0'
            }, {
                tokenAddr: fromAddr, spender: RESERVE_BROKER,
                amountIn: reserveQuote ? reserveQuote.amountIn : 0n,
                tokenSymbol: fromSym
            });
        } catch (_) { /* keep original error */ }
        const friendly = (window.GMTxError && GMTxError.format) ? GMTxError.format(err) : (err?.shortMessage || err?.message || "Unknown error");
        showReserveAlert("alert-error", `❌ ${reserveDirection === "buy" ? "Buy" : "Sell"} failed: ${friendly}`);
        setReserveBtnState(reserveQuote ? "ready" : "enter");
    }
}

