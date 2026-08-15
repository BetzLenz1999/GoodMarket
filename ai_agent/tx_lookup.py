"""Read-only transaction hash lookup for the GoodMarket AI agent.

The agent already prepares value-moving actions (send/stream/swap/etc.) but
historically could not actually answer "where is my Learn & Earn tx hash?".
Every reward/purchase in GoodMarket persists a tx hash against the user's
wallet, so this module turns those scattered tables into one friendly reply —
without any signing or fund movement (read-only SELECT only).

Tables & hash columns (all keyed by ``wallet_address``):

    learnearn_log              transaction_hash      (also create via mask)
    learn_earn_streams         create_tx_hash / stop_tx_hash
    reloadly_orders            tx_hash / refund_tx_hash / reloadly_transaction_id
    referral_rewards_log       tx_hash
    twitter_task_log           transaction_hash
    trustpilot_task_log        tx_hash

Learn & Earn quiz logs store the wallet either masked (``0xabcd…1234``) or as
the full lowercase address depending on the version that wrote the row, so we
match both forms — mirroring ``learn_and_earn.QuizManager._latest_attempt_query``.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# NOTE: supabase_client is imported lazily inside _query_one so this module can
# be imported (and unit-tested for keyword/format logic) in environments that
# don't have supabase installed.

CELOSCAN_TX_URL = "https://celoscan.io/tx/"
CELO_EXPLORER_TX_URL = "https://explorer.celo.org/mainnet/tx/"

# Feature label -> lookup config. ``tx_columns`` lists (column, kind) pairs so
# the reply can distinguish a reward tx from a refund / payment / external id.
_FEATURE_LOOKUPS: dict[str, dict[str, Any]] = {
    "learn_earn": {
        "label": "Learn & Earn",
        "queries": [
            {
                "table": "learnearn_log",
                "wallet_match": "masked_or_lower",
                "columns": "transaction_hash, amount_g$, score, total_questions, status, timestamp",
                "tx_columns": [("transaction_hash", "reward")],
                "order_col": "timestamp",
            },
            {
                "table": "learn_earn_streams",
                "wallet_match": "lower",
                "columns": "create_tx_hash, stop_tx_hash, amount_gd, status, created_at",
                "tx_columns": [("create_tx_hash", "stream created"), ("stop_tx_hash", "stream stopped")],
                "order_col": "created_at",
            },
        ],
    },
    "reloadly": {
        "label": "Reloadly (load / gift card / utility)",
        "queries": [
            {
                "table": "reloadly_orders",
                "wallet_match": "lower",
                "columns": "tx_hash, refund_tx_hash, reloadly_transaction_id, gd_amount, order_type, status, created_at",
                "tx_columns": [("tx_hash", "your payment"), ("refund_tx_hash", "refund"), ("reloadly_transaction_id", "Reloadly order id")],
                "order_col": "created_at",
            },
        ],
    },
    "referral": {
        "label": "Referral rewards",
        "queries": [
            {
                "table": "referral_rewards_log",
                "wallet_match": "lower",
                "columns": "tx_hash, reward_amount, reward_type, status, created_at",
                "tx_columns": [("tx_hash", "referral reward")],
                "order_col": "created_at",
            },
        ],
    },
    "twitter": {
        "label": "Twitter task rewards",
        "queries": [
            {
                "table": "twitter_task_log",
                "wallet_match": "lower",
                "columns": "transaction_hash, reward_amount, status, created_at",
                "tx_columns": [("transaction_hash", "Twitter reward")],
                "order_col": "created_at",
            },
        ],
    },
    "trustpilot": {
        "label": "Trustpilot task rewards",
        "queries": [
            {
                "table": "trustpilot_task_log",
                "wallet_match": "lower",
                "columns": "tx_hash, reward_amount, status, approved_at, created_at",
                "tx_columns": [("tx_hash", "Trustpilot reward")],
                "order_col": "created_at",
            },
        ],
    },
}

# Keyword -> feature key. Order matters: longer/more-specific phrases first so
# "learn and earn" wins over a bare "earn".
_FEATURE_KEYWORDS: list[tuple[str, str]] = [
    ("learn and earn", "learn_earn"),
    ("learn & earn", "learn_earn"),
    ("learn earn", "learn_earn"),
    ("learnandearn", "learn_earn"),
    ("quiz", "learn_earn"),
    ("stream", "learn_earn"),
    ("reloadly", "reloadly"),
    ("load", "reloadly"),
    ("topup", "reloadly"),
    ("top up", "reloadly"),
    ("gift card", "reloadly"),
    ("giftcard", "reloadly"),
    ("utility", "reloadly"),
    ("referral", "referral"),
    ("refer", "referral"),
    ("invite", "referral"),
    ("twitter", "twitter"),
    ("tweet", "twitter"),
    ("trustpilot", "trustpilot"),
    ("review", "trustpilot"),
]

# Phrases that signal a transaction-hash question (case-insensitive substring).
_TX_QUERY_PHRASES = (
    "transaction hash",
    "tx hash",
    "txhash",
    "tx id",
    "txid",
    "hash ng",
    "where is my tx",
    "where my tx",
    "my tx",
    "transaction id",
    "transaction",
    "tx ",
    "hash",
)


def is_tx_lookup_request(message: str) -> bool:
    """True when a chat message looks like a transaction-hash lookup question."""
    lower = (message or "").lower()
    if not lower.strip():
        return False
    return any(phrase in lower for phrase in _TX_QUERY_PHRASES)


def detect_feature(message: str) -> str | None:
    """Return the feature key implied by the message, or None (search all)."""
    lower = (message or "").lower()
    for phrase, feature in _FEATURE_KEYWORDS:
        if phrase in lower:
            return feature
    return None


def _mask_wallet(wallet: str) -> str:
    if not wallet.startswith("0x") or len(wallet) < 10:
        return wallet
    return wallet[:6] + "..." + wallet[-4:]


def _build_wallet_filter(query, wallet_match: str, wallet: str):
    """Apply the wallet-address WHERE clause in the form that table stores it."""
    wallet_lower = (wallet or "").lower()
    if wallet_match == "masked_or_lower":
        masked = _mask_wallet(wallet_lower)
        # or_ needs the raw PostgREST filter string.
        return query.or_(f"wallet_address.ilike.{masked},wallet_address.ilike.{wallet_lower}")
    # default: lower
    return query.eq("wallet_address", wallet_lower)


def _query_one(config: dict, wallet: str, limit: int) -> list[dict]:
    from supabase_client import get_supabase_admin_client, get_supabase_client, safe_supabase_operation

    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return []
    order_col = config.get("order_col") or "created_at"

    def _run():
        q = supabase.table(config["table"]).select(config["columns"])
        q = _build_wallet_filter(q, config.get("wallet_match", "lower"), wallet)
        return q.order(order_col, desc=True).limit(limit).execute()

    result = safe_supabase_operation(_run, operation_name=f"AI tx lookup {config['table']}")
    if not result or not getattr(result, "data", None):
        return []
    return result.data


def _short_hash(value: str | None) -> str:
    if not value:
        return ""
    v = str(value)
    if len(v) <= 14:
        return v
    return f"{v[:8]}…{v[-6:]}"


def _is_onchain_hash(value: str | None) -> bool:
    """True only for real Celo tx hashes (0x + 64 hex). Filters out ids like Reloadly's numeric transaction id or 'queued:...' stream placeholders."""
    if not value:
        return False
    v = str(value).lower()
    return v.startswith("0x") and len(v) == 66 and all(c in "0123456789abcdef" for c in v[2:])


def _extract_tx_rows(config: dict, row: dict) -> list[dict]:
    """Flatten a DB row into one entry per non-empty tx column."""
    out = []
    for col, kind in config["tx_columns"]:
        val = row.get(col)
        if val:
            out.append({
                "tx": str(val),
                "kind": kind,
                "onchain": _is_onchain_hash(val),
                "row": row,
            })
    return out


def lookup_transactions(wallet: str, feature: str | None = None, limit: int = 5) -> dict:
    """Look up recent transaction hashes for a wallet across features.

    Args:
        wallet: the connected user's wallet address.
        feature: one of the ``_FEATURE_LOOKUPS`` keys, or None to search all.
        limit: max rows per table.

    Returns ``{"success": bool, "feature": str|None, "items": [...], "reply": str}``.
    """
    if not wallet:
        return {
            "success": False,
            "feature": feature,
            "items": [],
            "reply": "Please connect and verify your GoodMarket wallet so I can look up your transactions.",
        }

    features = [feature] if feature and feature in _FEATURE_LOOKUPS else list(_FEATURE_LOOKUPS.keys())
    items: list[dict] = []

    for fkey in features:
        fconf = _FEATURE_LOOKUPS[fkey]
        for qconf in fconf["queries"]:
            try:
                rows = _query_one(qconf, wallet, limit)
            except Exception as exc:  # noqa: BLE001
                logger.warning("AI tx lookup %s.%s failed: %s", fkey, qconf["table"], exc)
                continue
            for row in rows:
                for entry in _extract_tx_rows(qconf, row):
                    entry["feature"] = fconf["label"]
                    entry["feature_key"] = fkey
                    items.append(entry)

    # Most recent first across all features. Prefer rows with a parseable date.
    def _sort_key(it: dict) -> tuple:
        row = it.get("row") or {}
        ts = row.get("created_at") or row.get("timestamp") or row.get("approved_at") or ""
        return (str(ts),)
    items.sort(key=_sort_key, reverse=True)
    items = items[:limit]

    return {
        "success": True,
        "feature": feature,
        "items": items,
        "reply": _format_reply(items, feature),
    }


def _format_reply(items: list[dict], feature: str | None) -> str:
    if not items:
        scope = "transactions" if not feature else f"{_FEATURE_LOOKUPS.get(feature, {}).get('label', feature)} transactions"
        return f"No {scope} found for your wallet yet. If you recently completed an action, the transaction hash may appear shortly once it is confirmed on-chain."

    lines = ["Here are your most recent transactions:"]
    for it in items:
        tx = it["tx"]
        row = it.get("row") or {}
        amount = row.get("amount_g$") or row.get("amount_gd") or row.get("reward_amount") or row.get("gd_amount")
        status = row.get("status")
        short = _short_hash(tx)
        parts = [f"• [{it['feature']}] {it['kind']}"]
        if amount not in (None, "", 0, "0"):
            parts.append(f"{amount} G$")
        parts.append(f"tx `{short}`")
        if status:
            parts.append(f"({status})")
        lines.append(" ".join(parts))
        if it.get("onchain"):
            lines.append(f"  View on Celoscan: {CELOSCAN_TX_URL}{tx}")
    lines.append("")
    lines.append("Tip: ask about a specific feature (e.g. 'my Learn & Earn tx hash') to narrow the results.")
    return "\n".join(lines)
