"""GoodMarket translation engine.

Design goal: a translator fills ONE file (`translations.py`) and the whole app
— dashboard, wallet, homepage, swap, savings, lotto, farming, reloadly, every
server-rendered page — switches language. No per-template markup, no per-page
edits, no new code per feature.

How it works
------------
1. Every HTML response flows through `translate_html()` (via a Flask
   `after_request` hook registered by `init_app`). It walks the FINAL rendered
   HTML and swaps text nodes / a small whitelist of attributes using the
   active language's dictionary.
2. `translate_html()` is **byte-perfect lossless when there is nothing to
   translate**: an untranslated tag is emitted from its original raw source
   (`get_starttag_text()`), and when the language is English the string is
   returned untouched. English therefore costs one `==` check and no rebuild.
3. `static/js/i18n.js` covers what a server-side HTML pass cannot: strings
   assembled at runtime in JS (`'Insufficient balance: ' + amt`) and native
   `alert`/`confirm`/`prompt` dialogs, using the same dictionary shape.

Conventions that matter when editing:
- Keys are the EXACT English source string (whitespace-collapsed), so filling
  the dictionary is mechanical. `scripts/extract_translations.py` lists every
  missing string for you.
- Any string containing a template/placeholder (`{{ amount }}`, `{0}`) is
  skipped by the server pass on purpose — never translate partial strings.
- Unknown strings fall through to English. A missing translation can never
  blank the UI or break a page.
"""
from __future__ import annotations

import html as _html
import logging
import re
import threading
from html.parser import HTMLParser

logger = logging.getLogger(__name__)

# ── Supported languages ──────────────────────────────────────────────────
# Ordered: the picker renders in this order. Codes are BCP-47-ish (fil, not tl)
# and match the `Accept-Language` primary subtag so auto-detect works.
SUPPORTED_LANGUAGES = (
    ("en", "English"),
    ("fil", "Filipino"),
    ("es", "Español"),
)
SUPPORTED_CODES = tuple(code for code, _ in SUPPORTED_LANGUAGES)
DEFAULT_LANGUAGE = "en"
LANGUAGE_LABELS = dict(SUPPORTED_LANGUAGES)

# Attributes worth translating. Everything else is left untouched so we can
# never corrupt an href/src/class/id.
TRANSLATABLE_ATTRS = frozenset({"placeholder", "title", "aria-label", "alt"})

# Skip text that clearly is not prose.
_SKIP_RE = re.compile(r"^[\s\d\W_]*$", re.UNICODE)
# Placeholders/interpolations — translating a fragment would corrupt the value.
_PLACEHOLDER_RE = re.compile(r"\{\{|\}\}|\{%|%\}|\{[a-zA-Z0-9_]+\}")
# Never translate these tokens even inside a longer string.
_GLOSSARY = (
    "G$",
    "GoodMarket",
    "GoodDollar",
    "Celo",
    "XDC",
    "GCash",
    "Reloadly",
    "XSwap",
    "GoodSwap",
    "Superfluid",
    "WalletConnect",
    "MetaMask",
    "Telegram",
    "Twitter",
    "USDT",
    "cUSD",
    "CELO",
)

_catalog_lock = threading.Lock()
_catalog_cache: dict[str, dict] = {}


def _load_dictionary(language: str) -> dict:
    """Return the {english: translated} mapping for a language.

    Deliberately tiny: the dictionary lives in - and is edited via - the single
    `translations.py` file. Results are cached per process.
    """
    with _catalog_lock:
        cached = _catalog_cache.get(language)
    if cached is not None:
        return cached

    table: dict = {}
    try:
        import translations

        table = dict(translations.DICTIONARIES.get(language, {}) or {})
    except Exception as exc:  # never let a bad dictionary break a page
        logger.warning(f"[i18n] could not load dictionary for {language!r}: {exc}")
        table = {}

    # A translated string is only usable if it lost no runtime variable.
    clean = {}
    for src, dst in table.items():
        if isinstance(dst, str) and dst.strip() and _same_placeholders(src, dst):
            clean[src] = dst
    with _catalog_lock:
        _catalog_cache[language] = clean
    return clean


def _same_placeholders(source: str, target: str) -> bool:
    """Guard: a translation must not invent or drop a `{token}`/`{{ token }}`."""
    return set(_PLACEHOLDER_RE.findall(source)) == set(_PLACEHOLDER_RE.findall(target))


def clear_catalog_cache() -> None:
    """Drop the per-process dictionary cache (used after editing translations)."""
    with _catalog_lock:
        _catalog_cache.clear()


def _is_translatable_text(value: str) -> bool:
    if not value or len(value.strip()) < 2:
        return False
    if _SKIP_RE.match(value):
        return False
    if _PLACEHOLDER_RE.search(value):
        return False
    return True


def _lookup(table: dict, value: str) -> str | None:
    """Match whitespace-collapsed text against the dictionary."""
    if not table or not _is_translatable_text(value):
        return None
    collapsed = re.sub(r"\s+", " ", value).strip()
    if collapsed in table:
        return table[collapsed]
    # Emoji/bullet prefixes are common in this codebase ("💰 More Ways…").
    stripped = re.sub(r"^[^\w(]+", "", collapsed, flags=re.UNICODE).strip()
    if stripped and stripped != collapsed and stripped in table:
        prefix = collapsed[: len(collapsed) - len(stripped)]
        return prefix + table[stripped]
    return None


class _HTMLTranslator(HTMLParser):
    def __init__(self, table: dict):
        super().__init__(convert_charrefs=False)
        self._table = table
        self._out: list[str] = []
        self._skip_depth = 0

    # -- tags ---------------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip_depth += 1
        rebuilt = None
        if self._table:
            pieces, changed = [], False
            for key, value in attrs:
                if value and key in TRANSLATABLE_ATTRS and value in self._table:
                    value = self._table[value]
                    changed = True
                rendered = f'="{_html.escape(value, quote=True)}"' if value is not None else ""
                pieces.append(f" {key}{rendered}")
            if changed:
                rebuilt = f"<{tag}{''.join(pieces)}>"
        # Untranslated tags are emitted verbatim -> byte-perfect no-op.
        self._out.append(rebuilt if rebuilt is not None else self.get_starttag_text())

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip_depth:
            self._skip_depth -= 1
        self._out.append(f"</{tag}>")

    # -- text ---------------------------------------------------------------
    def handle_data(self, data):
        if self._skip_depth or not data.strip():
            self._out.append(data)
            return
        translated = _lookup(self._table, data)
        if translated is None:
            self._out.append(data)
            return
        lead = data[: len(data) - len(data.lstrip())]
        trail = data[len(data.rstrip()):]
        self._out.append(f"{lead}{translated}{trail}")

    # -- passthrough --------------------------------------------------------
    def handle_comment(self, data):
        self._out.append(f"<!--{data}-->")

    def handle_decl(self, decl):
        self._out.append(f"<!{decl}>")

    def handle_pi(self, data):
        self._out.append(f"<?{data}>")

    def handle_entityref(self, name):
        self._out.append(f"&{name};")

    def handle_charref(self, name):
        self._out.append(f"&#{name};")

    def result(self) -> str:
        return "".join(self._out)


def translate_html(markup: str, language: str) -> str:
    """Translate a rendered HTML document.

    English (or an empty dictionary) returns the input UNCHANGED - same object,
    no walk - so the default path has effectively zero cost.
    """
    if not markup or language in (None, "", DEFAULT_LANGUAGE):
        return markup
    table = _load_dictionary(language)
    if not table:
        return markup
    parser = _HTMLTranslator(table)
    try:
        parser.feed(markup)
        parser.close()
    except Exception as exc:  # a parser bug must never take a page down
        logger.warning(f"[i18n] HTML pass failed for {language!r}: {exc}")
        return markup
    return parser.result()


# ── Language resolution ──────────────────────────────────────────────────
def normalize_language(value) -> str | None:
    """Coerce anything locale-ish ('fil-PH', 'tl', 'EN') to a supported code."""
    if not value or not isinstance(value, str):
        return None
    primary = value.replace("_", "-").split("-")[0].strip().lower()
    aliases = {"tl": "fil", "ph": "fil", "es-419": "es", "spa": "es", "eng": "en"}
    primary = aliases.get(primary, primary)
    return primary if primary in SUPPORTED_CODES else None


def language_from_accept_header(header: str | None) -> str | None:
    """Best supported language from an Accept-Language header (pre-select only)."""
    if not header:
        return None
    for chunk in header.split(","):
        code = normalize_language(chunk.split(";")[0])
        if code:
            return code
    return None


def resolve_language(session=None, user_row=None, accept_header=None) -> str:
    """Order of truth: session pick -> stored profile -> browser hint -> English."""
    try:
        if session is not None:
            picked = normalize_language(session.get("language"))
            if picked:
                return picked
    except Exception:
        pass
    if isinstance(user_row, dict):
        stored = normalize_language(user_row.get("language"))
        if stored:
            return stored
    hinted = language_from_accept_header(accept_header)
    if hinted:
        return hinted
    return DEFAULT_LANGUAGE


# ── Flask integration ────────────────────────────────────────────────────
def _template_processor():
    try:
        from flask import session

        return {
            "SUPPORTED_LANGUAGES": SUPPORTED_LANGUAGES,
            "GM_LANGUAGE": normalize_language(session.get("language")) or DEFAULT_LANGUAGE,
        }
    except Exception:
        return {"SUPPORTED_LANGUAGES": SUPPORTED_LANGUAGES, "GM_LANGUAGE": DEFAULT_LANGUAGE}


def init_app(app):
    """Register the HTML translation pass on a Flask app.

    Runs as an `after_request` hook, i.e. LAST in the response chain (Flask
    calls these in reverse registration order and `after_this_request` first),
    so it sees the final bytes before compression.
    """
    if getattr(app, "_gm_i18n_installed", False):
        return app
    app._gm_i18n_installed = True

    try:
        app.context_processor(_template_processor)
    except Exception as exc:
        logger.warning(f"[i18n] context processor not installed: {exc}")

    @app.after_request
    def _gm_translate_response(response):
        try:
            from flask import request, session

            # Admin surfaces stay English (operators are the only readers) and
            # skipping them also saves the parse on the largest template.
            if (request.path or "").startswith("/admin"):
                return response
            if response.direct_passthrough:
                return response
            if response.mimetype != "text/html":
                return response
            if response.headers.get("Content-Encoding"):
                return response

            language = normalize_language(session.get("language"))
            if not language or language == DEFAULT_LANGUAGE:
                return response

            data = response.get_data(as_text=True)
            translated = translate_html(data, language)
            if translated != data:
                response.set_data(translated)
                response.headers.pop("Content-Length", None)
        except Exception as exc:
            logger.debug(f"[i18n] after_request skipped: {exc}")
        return response

    logger.info("[i18n] translation pass installed")
    return app
