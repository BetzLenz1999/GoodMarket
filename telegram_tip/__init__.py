"""GoodMarket Telegram bot — admin-only ``/tip`` command.

Disburses real on-chain tokens (G$ / CELO / USDT / USDC on Celo, XDC / XDC G$ on
XDC) from a dedicated ``TIP_KEY`` hot wallet to a registered member's saved
wallet. Every call is admin-gated server-side and bounded by per-tip, rolling
daily, and rate limits before a transaction is ever signed.

See ``docs/TELEGRAM_TIP_PROPOSAL.md`` for the full design.
"""

from .tokens import (
    TOKENS,
    normalize_token,
    list_tokens,
    get_token,
    parse_amount,
    to_wei,
)

__all__ = [
    "TOKENS",
    "normalize_token",
    "list_tokens",
    "get_token",
    "parse_amount",
    "to_wei",
]
