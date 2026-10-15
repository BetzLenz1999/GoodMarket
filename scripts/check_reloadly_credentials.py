#!/usr/bin/env python3
"""Probe Reloadly credentials against BOTH environments and report the verdict.

Use this to tell three failure modes apart without deploying anything:

  * the credential works in sandbox only  -> your env should be `sandbox`
  * the credential works in production only -> your env should be `production`
  * the credential works in NEITHER       -> it is wrong, revoked, or expired
                                             (regenerate it in the dashboard)

It mints a fresh token for each audience (never reuses a cached one), so an
"expired access token" cannot produce a false verdict here — if the credential
itself is still valid, this will succeed.

Usage
-----
    # with the values exported in your shell / Vercel env:
    python3 scripts/check_reloadly_credentials.py

    # or pass them explicitly (avoid shell history with the secret):
    RELOADLY_CLIENT_ID=xxx RELOADLY_CLIENT_SECRET=yyy \
        python3 scripts/check_reloadly_credentials.py

The secret is never printed — only the last 4 characters of the client id.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

AUTH_URL = "https://auth.reloadly.com/oauth/token"

AUDIENCES = {
    "sandbox": "https://topups-sandbox.reloadly.com",
    "production": "https://topups.reloadly.com",
}


def _clean(value: str | None) -> str:
    """Mirror env_utils.get_env_str: strip quotes/whitespace, empty -> None."""
    if value is None:
        return ""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'", "`"}:
        value = value[1:-1].strip()
    return value


def probe(client_id: str, client_secret: str, audience: str) -> tuple[bool, str]:
    """Return (ok, detail). Never raises."""
    payload = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
        "audience": audience,
    }
    req = urllib.request.Request(
        AUTH_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode())
        if body.get("access_token"):
            return True, "token issued"
        return False, f"no access_token in response: {body}"
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed = json.loads(raw)
            code = parsed.get("errorCode") or parsed.get("error") or ""
            msg = parsed.get("message") or ""
            return False, f"HTTP {e.code} {code} — {msg}".strip()
        except Exception:
            return False, f"HTTP {e.code} — {raw[:200]}"
    except Exception as e:  # network/timeout
        return False, f"{type(e).__name__}: {e}"


def main() -> int:
    raw_id = os.getenv("RELOADLY_CLIENT_ID")
    raw_secret = os.getenv("RELOADLY_CLIENT_SECRET")
    raw_env = os.getenv("RELOADLY_ENVIRONMENT")

    client_id = _clean(raw_id)
    client_secret = _clean(raw_secret)
    configured_env = _clean(raw_env) or "(unset/empty -> defaults to sandbox)"

    print("=" * 68)
    print("Reloadly credential probe")
    print("=" * 68)
    print(f"client_id suffix      : ...{client_id[-4:] if client_id else '(none)'}")
    print(f"client_secret set     : {bool(client_secret)}")
    print(f"RELOADLY_ENVIRONMENT  : {configured_env}")

    # Flag the exact misconfiguration that silently flips to production.
    if raw_env is not None and _clean(raw_env) == "":
        print("  !! RELOADLY_ENVIRONMENT is SET BUT EMPTY — the old code treats")
        print("     this as PRODUCTION, not sandbox. This alone can cause the 401.")

    if not client_id or not client_secret:
        print("\n❌ Credentials missing. Set RELOADLY_CLIENT_ID and")
        print("   RELOADLY_CLIENT_SECRET, then re-run.")
        return 2

    results = {}
    print("\nProbing both environments with a FRESH token each time...\n")
    for name, audience in AUDIENCES.items():
        ok, detail = probe(client_id, client_secret, audience)
        results[name] = ok
        mark = "✅ WORKS" if ok else "❌ FAILS"
        print(f"  {name:11} ({audience})")
        print(f"      {mark}: {detail}\n")

    print("=" * 68)
    print("VERDICT")
    print("=" * 68)
    if results["sandbox"] and results["production"]:
        print("✅ The credential is valid in BOTH environments.")
        print("   It is NOT expired. If the app still fails, the problem is the")
        print("   environment value or another config issue — check the app logs.")
        return 0
    if results["sandbox"]:
        print("✅ The credential is a SANDBOX credential and is still VALID.")
        print("   → Set RELOADLY_ENVIRONMENT=sandbox (exactly, no quotes/spaces).")
        print("   Your 401 came from the app hitting PRODUCTION with this pair.")
        return 0
    if results["production"]:
        print("✅ The credential is a LIVE/PRODUCTION credential and is VALID.")
        print("   → Set RELOADLY_ENVIRONMENT=production (exactly, no quotes).")
        print("   Your 401 came from the app hitting SANDBOX with this pair.")
        return 0

    print("❌ The credential does NOT work in either environment.")
    print("   This is a genuine credential problem — the client_id/secret is")
    print("   wrong, revoked, or the account was deactivated/expired.")
    print("   → Go to Reloadly dashboard → Developers → API Settings, confirm the")
    print("     Sandbox/Live toggle matches the mode you need, and regenerate the")
    print("     secret. Then update RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
