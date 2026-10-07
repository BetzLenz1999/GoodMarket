"""LI.FI (Jumper) cross-chain bridge — server-side helper.

Phase 1 scope: bridge **native CELO (Celo) → native ETH (Base)**.

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


def build_quote_request(from_address: str, to_address: str, amount_wei: str) -> dict:
    """Build the POST /advanced/routes body for native CELO → native ETH (Base).

    `allowSwitchChain` is what unlocks the 2-step route; without it LI.FI
    filters every candidate out (verified). `allowDestinationCall` lets the
    second (Base) step be a swap into native ETH.
    """
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
        "fromTokenAddress": CELO_ERC20,
        "toTokenAddress": NATIVE_TOKEN,
        "fromAmount": str(amount_wei),
        "fromAddress": from_address,
        "toAddress": to_address or from_address,
        "options": options,
    }


def get_quote(from_address: str, to_address: str, amount_wei: str, force: bool = False):
    """Return (quote, error). `quote` is a normalized dict the frontend renders."""
    cache_key = f"{from_address.lower()}:{(to_address or from_address).lower()}:{amount_wei}"
    now = time.time()
    if not force:
        with _quote_cache_lock:
            hit = _quote_cache.get(cache_key)
            if hit and hit["expires"] > now:
                return hit["quote"], None

    body = build_quote_request(from_address, to_address, amount_wei)
    data, err = _post_json("/advanced/routes", body)
    if err and not (data and data.get("routes")):
        return None, err
    if not data:
        return None, err or "No route available."

    routes = data.get("routes") or []
    if not routes:
        # Surface LI.FI's own reason verbatim — the CELO route is liquidity
        # limited and "price impact too high" is actionable ("try a smaller
        # amount"), unlike a generic failure.
        reason = _first_route_reason(data) or "No bridge route is available for this amount right now."
        return None, reason

    route = routes[0]
    normalized = normalize_route(route)
    with _quote_cache_lock:
        _quote_cache[cache_key] = {"quote": normalized, "expires": now + _QUOTE_CACHE_TTL}
    return normalized, None


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
