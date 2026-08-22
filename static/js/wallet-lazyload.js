// Extracted from templates/wallet.html inline <script> (load-perf refactor).
// Per-request values come from window.GM_WALLET_BOOT (set inline in wallet.html).
(function() {
            var ethersLoaded = false;
            var qrLoaded = false;
            function loadEthers(cb) {
                if (window.ethers) { if(cb) cb(); return; }
                var s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js';
                // SRI: refuse to execute the script if its hash doesn't match.
                // Protects users if the CDN is ever compromised or MITMed.
                s.integrity = 'sha384-6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM';
                s.crossOrigin = 'anonymous';
                s.referrerPolicy = 'no-referrer';
                s.onload = function() { if(cb) cb(); };
                document.body.appendChild(s);
            }
            function loadQRCode(cb) {
                if (window.QRCode) { if(cb) cb(); return; }
                var s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
                s.integrity = 'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU';
                s.crossOrigin = 'anonymous';
                s.referrerPolicy = 'no-referrer';
                s.onload = function() { if(cb) cb(); };
                document.body.appendChild(s);
            }
            // Preload both when page is idle so the modal is fast when needed
            if (window.requestIdleCallback) {
                requestIdleCallback(function() { loadEthers(); loadQRCode(); });
            } else {
                setTimeout(function() { loadEthers(); loadQRCode(); }, 3000);
            }
        })();
