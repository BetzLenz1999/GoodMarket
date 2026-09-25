#!/usr/bin/env python3
"""List every user-facing string that is still missing from translations.py.

This is the helper that makes "translate the app by editing ONE file" practical:
run it, and it prints ready-to-paste dictionary lines for both languages.

    python scripts/extract_translations.py            # report + counts
    python scripts/extract_translations.py --emit fil # paste-ready Python block
    python scripts/extract_translations.py --emit es --min-len 4

It reads:
  • every templates/*.html  — visible text between tags, plus the translatable
    attributes (placeholder / title / aria-label / alt)
  • every static/js/*.js    — string literals that look like human sentences
    (these are covered at runtime by static/js/i18n.js)

Strings that clearly are not prose, contain a template/variable placeholder, or
are dominated by punctuation/brand tokens are skipped, exactly as the runtime
skips them — so the report only shows things actually worth translating.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from i18n import TRANSLATABLE_ATTRS, _is_translatable_text  # noqa: E402

TAG_TEXT_RE = re.compile(r">([^<>{}]{2,200})<")
ATTR_RE = re.compile(
    r"""\b(?:%s)\s*=\s*(?:"([^"{}]{2,200})"|'([^'{}]{2,200})')"""
    % "|".join(sorted(TRANSLATABLE_ATTRS))
)
# Double-quoted JS string literals long enough to be a sentence.
JS_STR_RE = re.compile(r'"([^"\\\n]{8,200})"')
_JS_NOISE_RE = re.compile(
    r"[{}<>]|=>|https?:|//|\bpx\b|rgba?\(|#[0-9a-fA-F]{3,8}|^\s*[a-z_]+\s*:|\\[ntr]"
)


def _iter_files(rel_dir: str, exts: tuple[str, ...]):
    base = os.path.join(ROOT, rel_dir)
    for dirpath, _dirnames, filenames in os.walk(base):
        for name in filenames:
            if name.endswith(exts):
                yield os.path.join(dirpath, name)


def _collect_from_html(path: str, found: set[str]) -> None:
    with open(path, encoding="utf-8", errors="ignore") as f:
        src = f.read()
    # Never translate inside scripts/styles: JS is handled at runtime.
    src = re.sub(r"<script\b.*?</script>", " ", src, flags=re.S | re.I)
    src = re.sub(r"<style\b.*?</style>", " ", src, flags=re.S | re.I)
    src = re.sub(r"<!--.*?-->", " ", src, flags=re.S)
    for raw in TAG_TEXT_RE.findall(src):
        text = re.sub(r"\s+", " ", raw).strip()
        if _is_translatable_text(text) and re.search(r"[A-Za-z]{2}", text):
            found.add(text)
    for groups in ATTR_RE.findall(src):
        text = re.sub(r"\s+", " ", next(g for g in groups if g)).strip()
        if _is_translatable_text(text) and re.search(r"[A-Za-z]{2}", text):
            found.add(text)


def _collect_from_js(path: str, found: set[str]) -> None:
    with open(path, encoding="utf-8", errors="ignore") as f:
        src = f.read()
    for text in JS_STR_RE.findall(src):
        if _JS_NOISE_RE.search(text):
            continue
        text = re.sub(r"\s+", " ", text).strip()
        if _is_translatable_text(text) and re.search(r"[A-Za-z]{3}\s+[A-Za-z]", text):
            found.add(text)


def collect(min_len: int = 3) -> tuple[set[str], set[str]]:
    html_strings: set[str] = set()
    js_strings: set[str] = set()
    for path in _iter_files("templates", (".html",)):
        _collect_from_html(path, html_strings)
    for path in _iter_files("static/js", (".js",)):
        _collect_from_js(path, js_strings)
    html_strings = {s for s in html_strings if len(s) >= min_len}
    js_strings = {s for s in js_strings if len(s) >= min_len}
    return html_strings, js_strings


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--emit", choices=["fil", "es"], help="print a paste-ready block for a language")
    ap.add_argument("--min-len", type=int, default=3, help="ignore strings shorter than this")
    ap.add_argument("--missing", action="store_true",
                    help="print the missing strings as a plain list")
    args = ap.parse_args()

    html_strings, js_strings = collect(args.min_len)

    try:
        import translations

        have = set((translations.DICTIONARIES.get(args.emit) or {})) if args.emit else set()
        have |= set(translations.DICTIONARIES.get("fil") or {})
        have |= set(translations.DICTIONARIES.get("es") or {})
    except Exception as exc:
        print(f"! could not import translations.py: {exc}", file=sys.stderr)
        have = set()

    all_strings = html_strings | js_strings
    missing = sorted(all_strings - have)

    print(f"templates (server-rendered): {len(html_strings)}")
    print(f"static/js  (runtime)       : {len(js_strings)}")
    print(f"already in translations.py : {len(all_strings & have)}")
    print(f"STILL MISSING              : {len(missing)}")

    if args.missing:
        for s in missing:
            print(s)
        return 0

    if args.emit:
        print(f'\n# ── Paste into {args.emit.upper()} in translations.py ──')
        for s in missing:
            print(f'    "{_escape(s)}": "",')
        return 0

    if missing:
        print("\nFirst 40 missing strings (use --emit fil to get a paste-ready block):")
        for s in missing[:40]:
            print(f"  • {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
