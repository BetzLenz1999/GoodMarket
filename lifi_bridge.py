"""LI.FI (Jumper) cross-chain bridge — server-side helper.

Phase 1 scope: bridge **Celo → native ETH (Base)**, from a selectable Celo
source token (native CELO / USDC / USDT / cUSD). Native CELO is the default,
but LI.FI's own step-0 simulation currently reverts `TransferFromFailed` for a
native-CELO source, so the ERC-20 stablecoins are the working fallback (USDC /
USDT route in a single step). See docs/JUMPER_LIFI_CELO_SOURCE_FIX_PLAN.md.

Why a server-side proxy instead of calling LI.FI from the browser:
  * the integrator id / optional API key never ship to the client,
  * we can validate and cache quotes, and
  * the client only ever talks to our own /api/bridge/lifi/* endpoints.

LI.FI verified behaviour this module depends on (checked against the live
API on 2026-10-07):
  * The Celo→Base CELO→ETH route is a **2-step** route (Glacis bridge, then a
    destination-chain swap on Base) — it needs a signature on BOTH chains.
  * `GET /v1/quote` IGNORES `allowSwitchChain`, so the route is filtered out.
    Only `POST /v1/advanced/routes` (options.allowSwitchChain=true) returns it.
  * `/advanced/routes` responses contain NO `transactionRequest` — the tx data
    must be fetched per step from `POST /v1/advanced/stepTransaction`.
  * Native CELO is exposed as an ERC-20 (`0x471EcE...`), NOT the `0xeeee`
    pseudo-address (which is rejected on Celo).

The module is dependency-light on purpose (stdlib only) so it imports and
tests without Flask/requests/web3 present.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

from env_utils import get_env_float, get_env_int

logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────────────────────
LI_FI_BASE_URL = os.getenv("LI_FI_BASE_URL", "https://li.quest/v1").rstrip("/")
LI_FI_INTEGRATOR = os.getenv("LI_FI_INTEGRATOR", "goodmarket")
LI_FI_API_KEY = os.getenv("LI_FI_API_KEY", "")

CELO_CHAIN_ID = get_env_int("CELO_MAINNET_CHAIN_ID", 42220)
BASE_CHAIN_ID = get_env_int("BASE_CHAIN_ID", 8453)

# LI.FI's canonical native-token marker for EVM chains.
NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
# Celo's native CELO is exposed by LI.FI as this ERC-20 (NOT 0xeeee).
CELO_ERC20 = os.getenv("CELO_ERC20_TOKEN", "0x471EcE3750Da237f93B8E339c536989b8978a438")

# ── Source tokens on Celo ───────────────────────────────────────────────────
# A native-CELO source is broken on LI.FI's side (its own step-0 simulation
# reverts TransferFromFailed — verified live 2026-10-07), while the ERC-20
# stablecoins build cleanly. USDC/USDT route Celo→Base in a SINGLE step (one
# signature); cUSD routes in two. See
# docs/JUMPER_LIFI_CELO_SOURCE_FIX_PLAN.md for the live evidence.
CELO_USDC = os.getenv("LIFI_CELO_USDC_TOKEN", "0xcebA9300f2b948710d2653dD7B07f33A8B32118C")
CELO_USDT = os.getenv("LIFI_CELO_USDT_TOKEN", "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e")
CELO_CUSD = os.getenv("LIFI_CELO_CUSD_TOKEN", "0x765DE816845861e75A25fCA122bb6898B8B1282a")

# Ordered so the WORKING single-step sources (USDT/USDC) come first and the
# broken native-CELO source last — the picker renders in this order and the
# default is USDT (a native-CELO default would send every first-time user down
# the failure + fallback path). cUSD stays because it is the Phase-2 pre-swap
# target; CELO stays because it is the entry point for "I only hold CELO".
SOURCE_TOKENS = {
    "USDT": {"address": CELO_USDT, "decimals": 6, "symbol": "USDT", "native": False},
    "USDC": {"address": CELO_USDC, "decimals": 6, "symbol": "USDC", "native": False},
    "cUSD": {"address": CELO_CUSD, "decimals": 18, "symbol": "cUSD", "native": False},
    "CELO": {"address": CELO_ERC20, "decimals": 18, "symbol": "CELO", "native": True},
}
DEFAULT_SOURCE_TOKEN = "USDT"


def resolve_source_token(key: str | None):
    """Return (token_dict, canonical_key) for a source token key, else (None, None).

    Lookup is case-insensitive so a client can send `usdc` or `USDC`.
    """
    wanted = (key or DEFAULT_SOURCE_TOKEN).strip().lower()
    for name, token in SOURCE_TOKENS.items():
        if name.lower() == wanted:
            return token, name
    return None, None


def source_token_list() -> list:
    """Serializable source-token list for the UI (no secrets, no RPC)."""
    return [{"key": name, **token} for name, token in SOURCE_TOKENS.items()]


# Optional integrator fee (fraction, e.g. 0.003 = 0.3%). Default 0 = disabled.
# NOTE: LI.FI rejects any non-zero fee until the integrator is configured at
# https://portal.li.fi/.
LI_FI_FEE = get_env_float("LI_FI_FEE", 0.0)

# Quote cache: LI.FI quotes are cheap but not free, and the UI re-requests on
# every keystroke. Cache briefly so typing does not hammer the API.
_QUOTE_CACHE_TTL = get_env_int("LI_FI_QUOTE_CACHE_TTL", 10)
_quote_cache: dict = {}
_quote_cache_lock = threading.Lock()

_HTTP_TIMEOUT = get_env_int("LI_FI_HTTP_TIMEOUT", 30)

# LI.FI sits behind Cloudflare, which rejects the default `Python-urllib/3.x`
# User-Agent with a 403 "Error 1010: browser_signature_banned" — i.e. EVERY
# request would fail from the server with a bare urllib client. A descriptive
# UA (or any Mozilla-shaped string) passes. Do not remove this header.
_USER_AGENT = os.getenv(
    "LI_FI_USER_AGENT",
    "Mozilla/5.0 (compatible; GoodMarketBridge/1.0; +https://goodmarketph.live)",
)


def bridge_enabled() -> bool:
    """Feature flag. Default OFF so the pane ships dark until switched on."""
    val = (os.getenv("LIFI_BRIDGE_ENABLED", "") or "").strip().lower()
    return val in {"1", "true", "yes", "on"}


def _headers() -> dict:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": _USER_AGENT,
    }
    if LI_FI_API_KEY:
        headers["x-lifi-api-key"] = LI_FI_API_KEY
    return headers


def _post_json(path: str, payload: dict):
    """POST to LI.FI and return (parsed_json, error_message)."""
    url = f"{LI_FI_BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body), None
    except urllib.error.HTTPError as exc:
        # LI.FI returns structured errors (with a useful `message`) on 4xx/5xx.
        try:
            body = exc.read().decode("utf-8")
            parsed = json.loads(body)
            return parsed, parsed.get("message") or f"HTTP {exc.code}"
        except Exception:
            return None, f"LI.FI request failed (HTTP {exc.code})."
    except Exception as exc:  # network / timeout / DNS
        logger.warning("LI.FI POST %s failed: %s", path, exc)
        return None, "Could not reach the bridge service. Please try again."


def _get_json(path: str, params: dict):
    from urllib.parse import urlencode

    url = f"{LI_FI_BASE_URL}{path}?{urlencode(params)}"
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body), None
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8")
            parsed = json.loads(body)
            return parsed, parsed.get("message") or f"HTTP {exc.code}"
        except Exception:
            return None, f"LI.FI request failed (HTTP {exc.code})."
    except Exception as exc:
        logger.warning("LI.FI GET %s failed: %s", path, exc)
        return None, "Could not reach the bridge service. Please try again."


def build_quote_request(from_address: str, to_address: str, amount_wei: str,
                        from_token: str = DEFAULT_SOURCE_TOKEN) -> dict:
    """Build the POST /advanced/routes body for Celo → native ETH (Base).

    `from_token` selects the Celo source asset (CELO / USDC / USDT / cUSD). The
    default is native CELO; an ERC-20 stablecoin source builds a working route
    while a native-CELO source does not (LI.FI-side simulation failure).

    `allowSwitchChain` is what unlocks a destination-signature route; without it
    LI.FI filters every candidate out (verified). `allowDestinationCall` lets
    the destination (Base) step be a swap into native ETH.
    """
    token, _ = resolve_source_token(from_token)
    if token is None:
        token = SOURCE_TOKENS[DEFAULT_SOURCE_TOKEN]
    options = {
        "integrator": LI_FI_INTEGRATOR,
        "allowSwitchChain": True,
        "allowDestinationCall": True,
        "slippage": 0.03,
    }
    if LI_FI_FEE > 0:
        # Only sent when configured; LI.FI breaks the quote if the integrator
        # is not registered for fee collection.
        options["fee"] = LI_FI_FEE
    return {
        "fromChainId": CELO_CHAIN_ID,
        "toChainId": BASE_CHAIN_ID,
        "fromTokenAddress": token["address"],
        "toTokenAddress": NATIVE_TOKEN,
        "fromAmount": str(amount_wei),
        "fromAddress": from_address,
        "toAddress": to_address or from_address,
        "options": options,
    }


def _is_transient_error(err: str | None) -> bool:
    """True when LI.FI did not give a real verdict (rate limit / network).

    A transient failure must never reject a route: we cannot tell whether the
    route is buildable, so we fail OPEN and let the user try (the per-step send
    reports the real error at that point).
    """
    if not err:
        return False
    low = err.lower()
    return any(k in low for k in ("rate limit", "too many requests", "could not reach", "timed out", "timeout"))


def preflight_route(route: dict):
    """Build step 0 so we never hand the UI a route that cannot execute.

    Returns (ok, error). `ok` is True when step 0 produced a transactionRequest,
    OR when LI.FI was transiently unavailable (fail open). It is False only when
    LI.FI gave a definite simulation failure — which is what surfaced to users
    as `TransferFromFailed` only AFTER they had already seen a gas estimate.
    """
    steps = (route or {}).get("steps") or []
    if not steps:
        return False, "This route has no executable step."
    tx, err = get_step_transaction(steps[0])
    if tx:
        return True, None
    if _is_transient_error(err):
        # Unknown, not broken — do not block the user on a rate limit.
        return True, None
    return False, err or "This route could not be prepared right now."


# Structured error codes the frontend keys off (never string-match the copy).
ERROR_NATIVE_CELO_UNAVAILABLE = "native_celo_unavailable"
ERROR_INSUFFICIENT_BALANCE = "insufficient_balance"
ERROR_ROUTE_UNAVAILABLE = "route_unavailable"


def _preflight_error_code(err: str | None, from_token: str | None = None) -> str:
    """Classify a preflight failure so the UI can offer the right fallback."""
    raw = (err or "").strip().lower()
    if "transferfromfailed" in raw or "transfer_from_failed" in raw:
        # The native-CELO source is the one LI.FI cannot simulate. An ERC-20
        # source that also hits TransferFromFailed is usually a missing
        # allowance, so only label it "native" when native was requested.
        if (from_token or DEFAULT_SOURCE_TOKEN).upper() == "CELO":
            return ERROR_NATIVE_CELO_UNAVAILABLE
        return ERROR_INSUFFICIENT_BALANCE
    if "insufficient" in raw and "balance" in raw:
        return ERROR_INSUFFICIENT_BALANCE
    return ERROR_ROUTE_UNAVAILABLE


def _friendly_preflight_error(err: str | None) -> str:
    """Translate LI.FI's internal simulation error into something a user can act on."""
    raw = (err or "").strip()
    low = raw.lower()
    if "transferfromfailed" in low or "transfer_from_failed" in low:
        return ("The bridge route for native CELO is temporarily unavailable on LI.FI's side "
                "(its own simulation of the transfer fails). Please try again later, or bridge a "
                "stablecoin / use Jumper directly meanwhile.")
    if "insufficient" in low and "balance" in low:
        return "You do not have enough CELO for this amount plus gas."
    return raw or "This route could not be prepared right now. Please try again."


def diagnostics() -> dict:
    """Safe config snapshot for troubleshooting. NEVER returns the API key.

    Distinguishes "my env var did not load" from "LI.FI is failing" — the two
    look identical from the UI otherwise.
    """
    key = LI_FI_API_KEY or ""
    return {
        "enabled": bridge_enabled(),
        "api_key_configured": bool(key),
        "api_key_length": len(key),
        "api_key_prefix": (key[:6] + "…") if key else "",
        "base_url": LI_FI_BASE_URL,
        "integrator": LI_FI_INTEGRATOR,
        "fee": LI_FI_FEE,
        "from_chain_id": CELO_CHAIN_ID,
        "to_chain_id": BASE_CHAIN_ID,
        "from_token": CELO_ERC20,
        "to_token": NATIVE_TOKEN,
        "source_tokens": source_token_list(),
    }


def probe_source_token(from_address: str, from_token: str, amount_wei: str = "1000000000000000000") -> str:
    """Human-readable preflight result for ONE source token.

    Used by the diagnostics endpoint so an operator can see, per token, whether
    LI.FI will actually build the route (native CELO currently does not).
    """
    quote, err, code = get_quote_ex(from_address, from_address, amount_wei, force=True, from_token=from_token)
    if quote:
        tools = [s.get("tool_name") or s.get("tool") for s in (quote.get("steps") or [])]
        return f"OK — {len(quote.get('steps') or [])} step(s) via {' + '.join([t for t in tools if t])}"
    return f"no quote [{code}] — {err}"


def get_quote_ex(from_address: str, to_address: str, amount_wei: str, force: bool = False,
                 from_token: str = DEFAULT_SOURCE_TOKEN):
    """Return (quote, error, error_code).

    `error_code` is one of the ERROR_* constants (or None) so the frontend can
    offer a fallback without string-matching the user-facing copy.
    """
    token, canonical = resolve_source_token(from_token)
    if token is None:
        return None, "Unsupported source token.", ERROR_ROUTE_UNAVAILABLE
    cache_key = (
        f"{from_address.lower()}:{(to_address or from_address).lower()}:"
        f"{amount_wei}:{canonical}"
    )
    now = time.time()
    if not force:
        with _quote_cache_lock:
            hit = _quote_cache.get(cache_key)
            if hit and hit["expires"] > now:
                return hit["quote"], None, None

    body = build_quote_request(from_address, to_address, amount_wei, from_token=canonical)
    data, err = _post_json("/advanced/routes", body)
    if err and not (data and data.get("routes")):
        return None, err, ERROR_ROUTE_UNAVAILABLE
    if not data:
        return None, err or "No route available.", ERROR_ROUTE_UNAVAILABLE

    routes = data.get("routes") or []
    if not routes:
        # Surface LI.FI's own reason verbatim — the CELO route is liquidity
        # limited and "price impact too high" is actionable ("try a smaller
        # amount"), unlike a generic failure.
        reason = _first_route_reason(data) or "No bridge route is available for this amount right now."
        return None, reason, ERROR_ROUTE_UNAVAILABLE

    # Pre-build the first step before showing anything. /advanced/routes can
    # return a route whose calldata fails LI.FI's own simulation (native-CELO
    # source is a known case); without this the user only finds out after
    # tapping Bridge, having already seen a gas estimate. Try each candidate so
    # one broken route does not hide a working alternative.
    chosen = None
    reason = None
    for candidate in routes:
        ok, pre_err = preflight_route(candidate)
        if ok:
            chosen = candidate
            break
        reason = pre_err
    if chosen is None:
        return None, _friendly_preflight_error(reason), _preflight_error_code(reason, canonical)

    normalized = normalize_route(chosen)
    normalized["from_token_key"] = canonical
    with _quote_cache_lock:
        _quote_cache[cache_key] = {"quote": normalized, "expires": now + _QUOTE_CACHE_TTL}
    return normalized, None, None


def get_quote(from_address: str, to_address: str, amount_wei: str, force: bool = False,
              from_token: str = DEFAULT_SOURCE_TOKEN):
    """Back-compat wrapper around get_quote_ex — returns (quote, error)."""
    quote, err, _code = get_quote_ex(from_address, to_address, amount_wei, force=force, from_token=from_token)
    return quote, err


def _first_route_reason(data: dict) -> str:
    """Extract a human-usable reason from an /advanced/routes empty response."""
    try:
        filtered = (data.get("unavailableRoutes") or {}).get("filteredOut") or []
        if filtered:
            return str(filtered[0].get("reason") or "").strip() or ""
    except Exception:
        pass
    return ""


def normalize_route(route: dict) -> dict:
    """Reduce a LI.FI route to the fields the frontend needs.

    Never returns `transactionRequest` here — those are fetched per step via
    `get_step_transaction`, because /advanced/routes omits them entirely.
    """
    steps = []
    for idx, step in enumerate(route.get("steps") or []):
        est = step.get("estimate") or {}
        action = step.get("action") or {}
        from_token = action.get("fromToken") or {}
        to_token = action.get("toToken") or {}
        steps.append({
            "index": idx,
            "tool": step.get("tool"),
            "tool_name": (step.get("toolDetails") or {}).get("name") or step.get("tool"),
            "from_chain_id": action.get("fromChainId"),
            "to_chain_id": action.get("toChainId"),
            "from_token": from_token.get("symbol"),
            "from_token_address": from_token.get("address"),
            "from_token_decimals": from_token.get("decimals"),
            "to_token": to_token.get("symbol"),
            "from_amount": est.get("fromAmount"),
            "to_amount": est.get("toAmount"),
            "to_amount_min": est.get("toAmountMin"),
            "execution_duration": est.get("executionDuration"),
            "approval_address": est.get("approvalAddress"),
            "gas_costs": [
                {
                    "amount": g.get("amount"),
                    "token": (g.get("token") or {}).get("symbol"),
                    "amount_usd": g.get("amountUSD"),
                }
                for g in (est.get("gasCosts") or [])
            ],
            # The client must post this exact step back to /step-tx to obtain
            # the transactionRequest (/advanced/routes omits transaction data).
            "raw": step,
        })

    return {
        "id": route.get("id"),
        "tool": route.get("tool"),
        "from_chain_id": route.get("fromChainId"),
        "to_chain_id": route.get("toChainId"),
        "from_amount": route.get("fromAmount"),
        "from_amount_usd": route.get("fromAmountUSD"),
        "to_amount": route.get("toAmount"),
        "to_amount_min": route.get("toAmountMin"),
        "to_amount_usd": route.get("toAmountUSD"),
        "gas_cost_usd": route.get("gasCostUSD"),
        "execution_duration": (route.get("estimate") or {}).get("executionDuration"),
        "contains_switch_chain": bool(route.get("containsSwitchChain")),
        "step_count": len(steps),
        "steps": steps,
    }


def get_step_transaction(step: dict):
    """Fetch the transactionRequest for one /advanced/routes step.

    Returns (transaction_request, error). A step whose simulation fails (e.g.
    the source wallet cannot cover the transfer) returns a structured error.
    """
    if not isinstance(step, dict) or not step:
        return None, "Invalid step."
    data, err = _post_json("/advanced/stepTransaction", step)
    if err and not (data and data.get("transactionRequest")):
        return None, err
    if not data:
        return None, err or "Could not build the transaction."
    tx = data.get("transactionRequest")
    if not tx:
        return None, data.get("message") or "Could not build the transaction."
    return tx, None


def get_status(tx_hash: str, from_chain: int | None = None, to_chain: int | None = None):
    """Poll bridge status for a source tx hash. Returns (status_dict, error)."""
    params = {"txHash": tx_hash}
    if from_chain is not None:
        params["fromChain"] = from_chain
    if to_chain is not None:
        params["toChain"] = to_chain
    data, err = _get_json("/status", params)
    if err and not data:
        return None, err
    if not data:
        return None, err or "Status unavailable."
    # Normalize to a small, stable shape for the frontend.
    return {
        "status": data.get("status"),
        "substatus": data.get("substatus"),
        "substatus_message": data.get("substatusMessage"),
        "sending": data.get("sending"),
        "receiving": data.get("receiving"),
        "tool": data.get("tool"),
        "lifi_explorer_link": data.get("lifiExplorerLink"),
    }, None


def clear_quote_cache() -> None:
    with _quote_cache_lock:
        _quote_cache.clear()
