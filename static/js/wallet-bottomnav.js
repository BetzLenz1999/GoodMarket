// Extracted from templates/wallet.html inline <script> (load-perf refactor).
// Per-request values come from window.GM_WALLET_BOOT (set inline in wallet.html).

// ── Join GoodMarket Community — one-time invite ──────────────────────
// Shown once per browser and never again. The seen-flag is written the moment
// the banner is revealed (same one-shot pattern as walletReminderBanner), so a
// user who closes it without joining is not re-prompted on every visit.
var GM_JOIN_COMMUNITY_URL = 'https://t.me/GoodMarketCommunity';
var GM_JOIN_COMMUNITY_SEEN_KEY = 'gmJoinCommunityPrompted_v1';

function _gmJoinCommunitySeen() {
    try { return localStorage.getItem(GM_JOIN_COMMUNITY_SEEN_KEY) === '1'; }
    // localStorage blocked (hardened private mode): we cannot remember that the
    // prompt was shown, so report "seen". Showing it on every page load would
    // break the one-time-only promise this banner is built on.
    catch (_) { return true; }
}

function showJoinCommunityBannerOnce() {
    if (_gmJoinCommunitySeen()) return;
    var banner = document.getElementById('joinCommunityBanner');
    if (!banner) return;
    banner.classList.add('show');
    try { localStorage.setItem(GM_JOIN_COMMUNITY_SEEN_KEY, '1'); }
    catch (_) { /* private mode / quota — banner still shown this once */ }
}

// Opens the Telegram group in a new tab and hides the banner for the rest of
// the session. The persisted flag was already written by
// showJoinCommunityBannerOnce, so the next visit keeps it hidden too.
function joinGoodMarketCommunity() {
    var banner = document.getElementById('joinCommunityBanner');
    if (banner) banner.classList.remove('show');
    var opened = null;
    try { opened = window.open(GM_JOIN_COMMUNITY_URL, '_blank', 'noopener'); }
    catch (_) { opened = null; }
    // Popup blocked (common in mobile dApp browsers) — fall back to same-tab.
    if (!opened) window.location.href = GM_JOIN_COMMUNITY_URL;
}

document.addEventListener('DOMContentLoaded', showJoinCommunityBannerOnce);

function openBottomSheet(id) {
            closeBottomSheet();
            const sheet = document.getElementById(id);
            const overlay = document.getElementById('bnSheetOverlay');
            if (!sheet || !overlay) return;
            overlay.classList.add('open');
            sheet.classList.add('open');
            // Hide the floating GoodMarket Agent launcher while a bottom sheet
            // is open — it outranks the sheet (z-index 9999 > 1310) and would
            // cover the sheet's grid buttons on mobile.
            document.body.classList.add('gm-modal-open');
        }
        function closeBottomSheet() {
            document.querySelectorAll('.bn-sheet.open').forEach(function(s){ s.classList.remove('open'); });
            const overlay = document.getElementById('bnSheetOverlay');
            if (overlay) overlay.classList.remove('open');
            document.body.classList.remove('gm-modal-open');
        }
        // Close the sheet, then run the selected action.
        function bnGo(action) {
            closeBottomSheet();
            if (typeof action === 'function') setTimeout(action, 180);
        }
        document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeBottomSheet(); });
