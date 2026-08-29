// Extracted from templates/wallet.html inline <script> (load-perf refactor).
// Per-request values come from window.GM_WALLET_BOOT (set inline in wallet.html).
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
