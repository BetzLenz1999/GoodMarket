/**
 * GoodMarket — shared PWA install + service-worker module.
 *
 * This revives the install logic that only ever lived inside the now-dead
 * templates/login.html (the /login route is a redirect, so its inline
 * `beforeinstallprompt` + service-worker code could never run). It is a
 * single reusable module so the homepage, the wallet page and any future
 * surface share one implementation.
 *
 * Responsibilities:
 *   - Capture `beforeinstallprompt` (Chromium) so a tap can trigger the real
 *     native install sheet at a moment of our choosing.
 *   - Detect "already installed" (standalone display mode / iOS navigator
 *     flag) so we never nag a user who already has the app.
 *   - Register the service worker at the ROOT scope so it controls "/" (the
 *     manifest's start_url) — required for installability. Without the
 *     explicit scope the worker would only control /static/.
 *   - Drive declarative install banners via data attributes (no inline
 *     handlers needed), in two modes:
 *       data-gm-pwa-mode="once"       → shown once per browser, then never
 *       data-gm-pwa-mode="persistent" → shown until installed or dismissed
 *
 * Markup contract (see templates/homepage.html and templates/wallet.html):
 *   <div id="..." data-gm-pwa-banner
 *        data-gm-pwa-mode="once|persistent"
 *        data-gm-pwa-key="wallet|home">           (seen/dismissed key suffix)
 *     <button data-gm-pwa-dismiss>×</button>
 *     <button data-gm-pwa-install>Install app</button>
 *     <div data-gm-pwa-status role="status" aria-live="polite"></div>
 *   </div>
 *
 * Exposes window.GMPwaInstall for programmatic use / tests.
 */
(function () {
    'use strict';

    var SW_URL = '/static/service-worker.js';
    var SW_SCOPE = '/';
    var INSTALLED_KEY = 'gmPwaInstalled_v1';
    var UPDATE_POLL_MS = 60000;

    var _deferredPrompt = null;
    var _installedFlag = _readFlag(INSTALLED_KEY);
    var _swRegistered = false;

    // ── storage helpers (fail closed on blocked storage) ────────────────
    function _readFlag(key) {
        try { return localStorage.getItem(key) === '1'; }
        // localStorage blocked (hardened private mode): we cannot remember,
        // so report "already installed" and never nag on every load.
        catch (_) { return true; }
    }

    function _writeFlag(key) {
        try { localStorage.setItem(key, '1'); } catch (_) { /* private mode */ }
    }

    function _readSeen(key) {
        try { return localStorage.getItem(key) === '1'; }
        catch (_) { return true; }
    }

    function _writeSeen(key) {
        try { localStorage.setItem(key, '1'); } catch (_) { /* private mode */ }
    }

    // ── install-state detection ─────────────────────────────────────────
    function isStandalone() {
        try {
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
                return true;
            }
            if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) {
                return true;
            }
        } catch (_) { /* matchMedia unavailable */ }
        // iOS Safari exposes navigator.standalone instead of display-mode.
        return window.navigator && window.navigator.standalone === true;
    }

    function isIos() {
        var ua = (window.navigator && window.navigator.userAgent) || '';
        var iosDevice = /iPad|iPhone|iPod/.test(ua);
        // iPadOS 13+ reports a desktop UA; detect it via touch points.
        var iPadOs = /Macintosh/.test(ua) && (window.navigator.maxTouchPoints || 0) > 1;
        return iosDevice || iPadOs;
    }

    function isInstalled() {
        return _installedFlag || isStandalone();
    }

    function canPrompt() {
        return !!_deferredPrompt;
    }

    function shouldOfferInstall() {
        return !isInstalled();
    }

    function _markInstalled() {
        _installedFlag = true;
        _writeFlag(INSTALLED_KEY);
    }

    // ── native prompt ───────────────────────────────────────────────────
    function promptInstall() {
        var deferred = _deferredPrompt;
        if (!deferred) {
            return Promise.resolve({
                outcome: 'unavailable',
                ios: isIos(),
                standalone: isStandalone(),
            });
        }
        // The deferred event can only be used once.
        _deferredPrompt = null;
        return Promise.resolve()
            .then(function () { return deferred.prompt(); })
            .then(function () { return deferred.userChoice; })
            .then(function (choice) {
                var outcome = (choice && choice.outcome) || 'dismissed';
                if (outcome === 'accepted') {
                    _markInstalled();
                    hideAllBanners();
                }
                _emit('gm-pwa-install-choice', { outcome: outcome });
                return { outcome: outcome };
            })
            .catch(function () {
                return { outcome: 'error' };
            });
    }

    /**
     * Wire an "Install app" button: uses the native sheet when available and
     * falls back to explicit manual instructions (iOS Share menu / browser
     * menu) so the tap is never a dead end.
     */
    function handleInstallClick(opts) {
        opts = opts || {};
        var statusEl = opts.statusId ? document.getElementById(opts.statusId) : null;
        var setStatus = function (msg) {
            if (statusEl) statusEl.textContent = msg;
        };

        if (isStandalone()) {
            setStatus('GoodMarket is already installed on this device.');
            return Promise.resolve({ outcome: 'already-installed' });
        }

        return promptInstall().then(function (res) {
            if (res.outcome === 'accepted') {
                setStatus('Installing GoodMarket…');
                return res;
            }
            if (res.outcome === 'dismissed') {
                setStatus('Install cancelled — you can try again anytime.');
                return res;
            }
            // No native prompt available (Firefox/Safari, or before the
            // engagement threshold) — guide the user to the manual path.
            setStatus(manualInstallHint());
            return res;
        });
    }

    function manualInstallHint() {
        if (isIos()) {
            return 'To install: tap the Share button (⬆️), then choose “Add to Home Screen”.';
        }
        return 'To install: open your browser menu (⋮) and choose “Install app” or “Add to Home screen”.';
    }

    // ── service worker (root scope so it controls start_url "/") ────────
    function registerServiceWorker(opts) {
        opts = opts || {};
        if (!('serviceWorker' in navigator)) return Promise.resolve(null);
        if (_swRegistered) return Promise.resolve(navigator.serviceWorker.controller || null);
        _swRegistered = true;

        var register = function () {
            return navigator.serviceWorker
                .register(SW_URL, { scope: SW_SCOPE })
                .then(function (reg) {
                    // Mirror the previous login/dashboard behaviour: poll for
                    // updates so a new deployment reaches installed users.
                    try {
                        setInterval(function () {
                            try { reg.update(); } catch (_) {}
                        }, UPDATE_POLL_MS);
                    } catch (_) {}
                    return reg;
                });
        };

        // A stale root-scoped worker registered from the OLD "/service-worker.js"
        // path can linger. The server shim unregisters itself, but we also
        // clean up any other root-scoped registration here so the new worker
        // (same scope, different script URL) takes over cleanly.
        return _unregisterLegacyRootWorkers()
            .then(register)
            .catch(function (err) {
                console.warn('PWA: service worker registration failed', err);
                return null;
            });
    }

    function _unregisterLegacyRootWorkers() {
        if (!navigator.serviceWorker.getRegistrations) return Promise.resolve();
        return navigator.serviceWorker.getRegistrations()
            .then(function (regs) {
                var jobs = [];
                (regs || []).forEach(function (reg) {
                    try {
                        var scopePath = new URL(reg.scope).pathname;
                        // Only touch the old root-scoped script; never the
                        // /static/service-worker.js we are about to register.
                        if (scopePath === '/' && reg.active &&
                            reg.active.scriptURL &&
                            reg.active.scriptURL.indexOf('/service-worker.js') !== -1 &&
                            reg.active.scriptURL.indexOf('/static/') === -1) {
                            jobs.push(reg.unregister());
                        }
                    } catch (_) {}
                });
                return Promise.all(jobs);
            })
            .catch(function () { /* best effort */ });
    }

    function _listenForUpdates() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.addEventListener('message', function (event) {
            var data = event && event.data;
            if (data && data.type === 'SW_UPDATED') {
                _showUpdateToast();
                _emit('gm-pwa-updated', { version: data.version });
            }
        });
    }

    /**
     * A new deployment is live. Show a small "refresh" toast (revives the
     * update banner the old login page had) so installed users actually get
     * the new build instead of a stale cache.
     */
    function _showUpdateToast() {
        try {
            if (document.getElementById('gmPwaUpdateToast')) return;
            var toast = document.createElement('div');
            toast.id = 'gmPwaUpdateToast';
            toast.className = 'gm-pwa-update-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');

            var text = document.createElement('span');
            text.textContent = 'A new version of GoodMarket is available.';
            toast.appendChild(text);

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Refresh';
            btn.addEventListener('click', function () { window.location.reload(); });
            toast.appendChild(btn);

            var close = document.createElement('button');
            close.type = 'button';
            close.className = 'gm-pwa-update-close';
            close.setAttribute('aria-label', 'Dismiss');
            close.textContent = '×';
            close.addEventListener('click', function () { toast.remove(); });
            toast.appendChild(close);

            document.body.appendChild(toast);
        } catch (_) { /* non-fatal */ }
    }

    // ── banner management ───────────────────────────────────────────────
    function _banners() {
        var out = [];
        var nodes = document.querySelectorAll('[data-gm-pwa-banner]');
        for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
        return out;
    }

    function hideBanner(elOrId) {
        var el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
        if (el) el.classList.remove('show');
    }

    function hideAllBanners() {
        _banners().forEach(function (el) { el.classList.remove('show'); });
    }

    function _seenKey(el) {
        return 'gmPwaPrompted_' + (el.getAttribute('data-gm-pwa-key') || 'default') + '_v1';
    }

    function _dismissKey(el) {
        return 'gmPwaDismissed_' + (el.getAttribute('data-gm-pwa-key') || 'default') + '_v1';
    }

    function _initBanner(el) {
        if (!shouldOfferInstall()) { hideBanner(el); return; }
        var mode = el.getAttribute('data-gm-pwa-mode') || 'persistent';
        if (mode === 'once') {
            var seen = _seenKey(el);
            if (_readSeen(seen)) return;
            el.classList.add('show');
            // Write the flag at REVEAL, not at click — the same one-shot rule
            // as the join-community banner, so closing it never re-prompts.
            _writeSeen(seen);
            return;
        }
        // persistent: shown until installed or explicitly dismissed
        if (_readSeen(_dismissKey(el))) return;
        el.classList.add('show');
    }

    function initBanners() {
        _banners().forEach(_initBanner);
    }

    function dismissBanner(el) {
        if (!el) return;
        el.classList.remove('show');
        var mode = el.getAttribute('data-gm-pwa-mode') || 'persistent';
        // Persistent banners remember the dismissal; "once" banners already
        // wrote their seen-flag at reveal, so nothing more is needed.
        if (mode !== 'once') _writeSeen(_dismissKey(el));
    }

    // ── events ──────────────────────────────────────────────────────────
    function _emit(name, detail) {
        try {
            document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
        } catch (_) { /* older engines */ }
    }

    function _wireGlobalListeners() {
        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            _deferredPrompt = e;
            _emit('gm-pwa-installable', {});
            // Re-evaluate banners so a button that was previously in "manual"
            // mode now offers the real native sheet.
            initBanners();
        });

        window.addEventListener('appinstalled', function () {
            _markInstalled();
            hideAllBanners();
            _emit('gm-pwa-installed', {});
        });

        // Declarative click handling (no inline handlers → CSP-friendly).
        document.addEventListener('click', function (event) {
            var target = event.target;
            if (!target || !target.closest) return;

            var dismissBtn = target.closest('[data-gm-pwa-dismiss]');
            if (dismissBtn) {
                event.preventDefault();
                dismissBanner(dismissBtn.closest('[data-gm-pwa-banner]'));
                return;
            }

            var installBtn = target.closest('[data-gm-pwa-install]');
            if (installBtn) {
                event.preventDefault();
                var banner = installBtn.closest('[data-gm-pwa-banner]');
                var statusEl = banner ? banner.querySelector('[data-gm-pwa-status]') : null;
                handleInstallClick({ statusId: statusEl ? statusEl.id : null });
            }
        });
    }

    // ── boot ────────────────────────────────────────────────────────────
    function init() {
        _wireGlobalListeners();
        _listenForUpdates();
        registerServiceWorker();
        initBanners();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.GMPwaInstall = {
        init: init,
        isStandalone: isStandalone,
        isIos: isIos,
        isInstalled: isInstalled,
        canPrompt: canPrompt,
        shouldOfferInstall: shouldOfferInstall,
        promptInstall: promptInstall,
        handleInstallClick: handleInstallClick,
        manualInstallHint: manualInstallHint,
        registerServiceWorker: registerServiceWorker,
        initBanners: initBanners,
        hideBanner: hideBanner,
        hideAllBanners: hideAllBanners,
        dismissBanner: dismissBanner,
        // Test seams (no-op in production unless called explicitly).
        _setDeferredPrompt: function (p) { _deferredPrompt = p; },
        _resetInstalled: function () { _installedFlag = false; },
    };
})();
