/* GoodMarket i18n runtime.
 *
 * The server translates finished HTML (see i18n.py). This bundle covers what a
 * server-side HTML pass cannot see, using the SAME dictionary (fetched from
 * /api/i18n/catalog so translations.py stays the single source of truth):
 *
 *   • text the app writes into the DOM at runtime ('Insufficient balance: ' + x)
 *   • native alert / confirm / prompt dialogs
 *
 * It is a no-op when the active language is English, so the default path costs
 * nothing.
 *
 * Matching strategy, in order:
 *   1. exact text match
 *   2. prefix match, so 'Failed: '%s'' translates the 'Failed' segment and keeps
 *      the runtime detail appended
 *   3. 'Label: value' — translate the label, keep the value
 * Unknown text is left untouched: a missing translation can never blank the UI.
 */
(function () {
    'use strict';

    var BOOT = window.GM_WALLET_BOOT || window.GM_I18N_BOOT || {};
    var LANGUAGE = (BOOT.language || 'en').toLowerCase();
    var CATALOG_URL = BOOT.i18nCatalogUrl || '/api/i18n/catalog';

    // Original native dialogs, captured before we override anything. Bound
    // defensively: a host page (or a test harness) without these must not stop
    // the whole bundle from loading, which would disable translation entirely.
    function _native(name) {
        try {
            var fn = window[name];
            if (typeof fn === 'function') return fn.bind(window);
        } catch (e) { /* fall through */ }
        return null;
    }
    var nativeAlert = _native('alert');
    var nativeConfirm = _native('confirm');
    var nativePrompt = _native('prompt');

    var dict = null;          // exact-match lookup
    var prefixKeys = null;    // keys sorted longest-first for prefix matching
    var readyResolve;
    var readyPromise = new Promise(function (res) { readyResolve = res; });

    function isEnglish() { return !LANGUAGE || LANGUAGE === 'en'; }

    function _collapse(text) {
        return String(text).replace(/\s+/g, ' ').trim();
    }

    function _buildIndexes(table) {
        dict = {};
        Object.keys(table).forEach(function (k) {
            var key = _collapse(k);
            if (key) dict[key] = table[k];
        });
        prefixKeys = Object.keys(dict).sort(function (a, b) { return b.length - a.length; });
    }

    /* Translate a whole runtime string, keeping any trailing dynamic detail. */
    function translate(text) {
        if (!dict || !text) return text;
        var str = String(text);
        var core = _collapse(str);
        if (!core) return text;

        var lead = str.slice(0, str.length - str.replace(/^\s+/, '').length);
        var trail = str.slice(str.replace(/\s+$/, '').length);

        // 3. 'Label: value' — translate only the label.
        var colon = core.indexOf(': ');
        if (colon > 1 && colon < 60) {
            var label = core.slice(0, colon);
            if (dict[label]) return lead + dict[label] + core.slice(colon) + trail;
        }
        // 1. exact
        if (dict[core]) return lead + dict[core] + trail;
        // 2. prefix — only for a real PHRASE (>= 12 chars), never a single
        //    word. Matching a bare word here would produce mixed-language
        //    output ("Ipadala money to a friend"), which reads worse than
        //    leaving the English untouched.
        for (var i = 0; i < prefixKeys.length; i++) {
            var key = prefixKeys[i];
            if (key.length >= 12 && core.length > key.length && core.indexOf(key) === 0) {
                return lead + dict[key] + core.slice(key.length) + trail;
            }
        }
        return text;
    }

    var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

    function translateElement(root) {
        if (!dict || !root) return;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode())) {
            var parent = node.parentNode;
            if (!parent) continue;
            var tag = (parent.nodeName || '').toLowerCase();
            if (tag === 'script' || tag === 'style') continue;
            if (node.__gmI18n) continue;
            var out = translate(node.nodeValue);
            if (out !== node.nodeValue) {
                node.__gmI18n = true;
                node.nodeValue = out;
            }
        }
        var els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label],[alt]') : [];
        Array.prototype.forEach.call(els, function (el) {
            ATTRS.forEach(function (attr) {
                var v = el.getAttribute(attr);
                if (!v) return;
                if (el.getAttribute('data-gm-i18n-' + attr)) return;
                var out = translate(v);
                if (out !== v) {
                    el.setAttribute('data-gm-i18n-' + attr, '1');
                    el.setAttribute(attr, out);
                }
            });
        });
    }

    /* Translate text added later (innerHTML assignments, status updates). */
    function observe() {
        if (!dict || !window.MutationObserver || !document.body) return;
        var observer = new MutationObserver(function (mutations) {
            observer.disconnect();
            try {
                mutations.forEach(function (m) {
                    if (m.type === 'characterData') {
                        var n = m.target;
                        if (!n.__gmI18n) {
                            var out = translate(n.nodeValue);
                            if (out !== n.nodeValue) { n.__gmI18n = true; n.nodeValue = out; }
                        }
                        return;
                    }
                    Array.prototype.forEach.call(m.addedNodes, function (added) {
                        if (added.nodeType === 1) translateElement(added);
                        else if (added.nodeType === 3 && !added.__gmI18n) {
                            var t = translate(added.nodeValue);
                            if (t !== added.nodeValue) { added.__gmI18n = true; added.nodeValue = t; }
                        }
                    });
                });
            } finally {
                observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function applyNativeDialogs() {
        if (!dict) return;
        if (nativeAlert) window.alert = function (message) { return nativeAlert(translate(message)); };
        if (nativeConfirm) window.confirm = function (message) { return nativeConfirm(translate(message)); };
        if (nativePrompt) window.prompt = function (message, def) { return nativePrompt(translate(message), def); };
    }

    function fetchCatalog() {
        if (isEnglish()) return Promise.resolve();
        return fetch(CATALOG_URL + '?lang=' + encodeURIComponent(LANGUAGE), {
            credentials: 'same-origin'
        })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (data && data.translations) {
                    _buildIndexes(data.translations);
                    applyNativeDialogs();
                }
            })
            .catch(function () { /* stay English on any failure */ });
    }

    function boot() {
        fetchCatalog().then(function () {
            if (dict) {
                translateElement(document.body);
                observe();
            }
            readyResolve();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.GMi18n = {
        language: LANGUAGE,
        ready: readyPromise,
        t: translate,
        apply: function (root) { translateElement(root || document.body); },
        isEnglish: isEnglish,
        /* Persist a pick server-side then reload so server-rendered text
           re-resolves. Used by the one-time picker and the Settings row. */
        setLanguage: function (lang, opts) {
            opts = opts || {};
            return fetch('/api/user/language', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ language: lang })
            }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
                .then(function (res) {
                    if (!res.ok || (res.data && res.data.success === false)) {
                        throw new Error((res.data && res.data.error) || 'Could not save language.');
                    }
                    try { localStorage.setItem('gmLanguage', lang); } catch (e) { }
                    if (opts.reload !== false) window.location.reload();
                    return res.data;
                });
        }
    };
})();
