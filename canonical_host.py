"""Canonical domain redirect (2026-08).

The app is served at ONE canonical domain — goodmarketph.live. Alias hosts
(the *.vercel.app deployment origin, the expired goodmarket.live) must never
serve pages directly: the vercel.app origin carries a phishing risk signal
with wallet security vendors (Blockaid — see MetaMask/eth-phishing-detect
issue #286646), and a split origin confuses WalletConnect session metadata.

Only requests whose Host is on the alias allowlist are redirected — localhost,
dev hosts, and preview hosts are NEVER redirected, so local development and
the agent runtime hosts keep working with the redirect enabled.

Env override: set CANONICAL_HOST to move the canonical domain again without a
code change. Set it to an empty string only if the redirect must be disabled.
"""

import os

CANONICAL_HOST = (os.getenv("CANONICAL_HOST") or "goodmarketph.live").strip().lower()

# Hosts that permanently redirect to the canonical host. Deliberately an
# allowlist — unknown hosts are left alone so dev/preview never breaks.
_ALIAS_SUFFIXES = (".vercel.app",)
_ALIAS_HOSTS = frozenset({"goodmarket.live", "www.goodmarket.live"})

# Server-to-server endpoints whose callers do not follow redirects. Telegram
# treats a 3xx webhook response as a failed delivery, so the webhook keeps
# answering on alias hosts until it is re-registered on the canonical domain
# (/telegram/setup-webhook). /health stays reachable for platform probes.
_EXEMPT_PATHS = frozenset({"/telegram/webhook", "/health"})


def canonical_redirect_target(host: str, path_qs: str = "/") -> str:
    """Return the canonical URL for an alias-host request, or None.

    `path_qs` is the request path INCLUDING the query string (Flask's
    request.full_path with the trailing '?' stripped).
    """
    canonical = CANONICAL_HOST
    if not canonical:
        return None
    host = (host or "").strip().lower().split(":")[0]
    if not host or host == canonical:
        return None
    path_qs = (path_qs or "/").rstrip("?") or "/"
    if path_qs.split("?", 1)[0] in _EXEMPT_PATHS:
        return None
    is_alias = (
        host in _ALIAS_HOSTS
        or host == f"www.{canonical}"
        or any(host.endswith(suffix) for suffix in _ALIAS_SUFFIXES)
    )
    if not is_alias:
        return None
    return f"https://{canonical}{path_qs}"
