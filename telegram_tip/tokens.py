"""Token registry for the GoodMarket Telegram bot ``/tip`` command.

Dependency-free (stdlib only) so it imports and tests in a bare environment.
Decimals are per-token and MUST come from here — USDT/USDC are 6 decimals, so a
hardcoded ``10**18`` would over-send by 10**12.

Addresses are env-overridable so a redeploy/re-issue does not need a code change.
The set mirrors ``chatroom/tips.py`` (the app's public tip registry) plus the
Celo stablecoins the wallet and chatroom already support (USDT/USDC 6dp, cUSD 18dp).
"""

from __future__ import annotations

import os
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CELO_CHAIN_ID = 42220
XDC_CHAIN_ID = 50

TOKEN_DECIMALS = 18

# ── Token registry ───────────────────────────────────────────────────────────
# ``native`` tokens (CELO/XDC) are sent as a plain value transfer; ERC-20 tokens
# are sent via ``transfer(to, amount)`` against ``address``.
TOKENS = {
    "GD": {
        "key": "GD",
        "label": "G$",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": False,
        "address": os.getenv("CELO_GD_TOKEN_CONTRACT", "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A"),
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "CELO": {
        "key": "CELO",
        "label": "CELO",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": True,
        "address": "",
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "USDT": {
        "key": "USDT",
        "label": "USDT",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        "decimals": 6,
        "native": False,
        "address": os.getenv("USDT_CONTRACT", "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"),
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "USDC": {
        "key": "USDC",
        "label": "USDC",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        "decimals": 6,
        "native": False,
        "address": os.getenv("USDC_CONTRACT", "0xcebA9300f2b948710d2653dD7B07f33A8B32118C"),
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "CUSD": {
        "key": "CUSD",
        "label": "cUSD",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        # cUSD is an 18-decimal token (unlike USDT/USDC).
        "decimals": TOKEN_DECIMALS,
        "native": False,
        "address": os.getenv("CUSD_TOKEN_ADDRESS", "0x765DE816845861e75A25fCA122bb6898B8B1282a"),
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "XDC": {
        "key": "XDC",
        "label": "XDC",
        "network": "xdc",
        "chain_id": XDC_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": True,
        "address": "",
        "explorer": "https://xdcscan.io/tx/",
        "rpc": os.getenv("XDC_RPC_URL", "https://earpc.xinfin.network"),
    },
    "XDC_GD": {
        "key": "XDC_GD",
        "label": "XDC G$",
        "network": "xdc",
        "chain_id": XDC_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": False,
        "address": os.getenv("XDC_GD_TOKEN_CONTRACT", "0xEC2136843a983885AebF2feB3931F73A8eBEe50c"),
        "explorer": "https://xdcscan.io/tx/",
        "rpc": os.getenv("XDC_RPC_URL", "https://earpc.xinfin.network"),
    },
}

# Common aliases so "g$", "gd", "celo", "xdcg$", "tether" all resolve.
_ALIASES = {
    "GD": "GD", "G$": "GD", "GOODDOLLAR": "GD", "GOODDOLLARS": "GD", "GDOLLAR": "GD",
    "CELO": "CELO",
    "USDT": "USDT", "TETHER": "USDT",
    "USDC": "USDC",
    "CUSD": "CUSD", "C$": "CUSD", "CELODOLLAR": "CUSD", "CELOUSD": "CUSD",
    "XDC": "XDC",
    "XDCGD": "XDC_GD", "XDC_GD": "XDC_GD", "XDCG$": "XDC_GD", "XDCDOLLAR": "XDC_GD",
    "XDCGDOLLAR": "XDC_GD",
}

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def normalize_token(raw) -> str | None:
    """Map user input / aliases onto a registry key, or None when unsupported."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text in TOKENS:
        return text
    return _ALIASES.get(text.upper())


def list_tokens() -> list[dict]:
    """Public token list — labels/networks only, no secrets."""
    return [
        {
            "key": meta["key"],
            "label": meta["label"],
            "network": meta["network"],
            "chain_id": meta["chain_id"],
            "decimals": meta["decimals"],
            "native": meta["native"],
        }
        for meta in TOKENS.values()
    ]


def get_token(key: str) -> dict | None:
    return TOKENS.get(key)


def parse_amount(raw) -> Decimal | None:
    """Positive decimal amount, or None when malformed."""
    if raw is None:
        return None
    try:
        amount = Decimal(str(raw).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    if amount <= 0:
        return None
    return amount


def to_wei(amount: Decimal, decimals: int = TOKEN_DECIMALS) -> int:
    return int((amount * (Decimal(10) ** decimals)).to_integral_value(rounding=ROUND_HALF_UP))


def is_valid_address(address: str) -> bool:
    return bool(address and _ADDRESS_RE.match(str(address).strip()))
