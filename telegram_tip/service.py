"""Core logic for the admin-only Telegram bot ``/tip`` command.

This module is deliberately importable without ``web3`` / ``requests`` /
``supabase`` installed (content tests run in a bare env): the blockchain send and
the Supabase client are imported lazily, and pure helpers (parsing, limit math)
have no external deps at all.

Responsibilities:
  1. parse ``/tip <amount> <token> [@user|0xaddr]``,
  2. gate the caller (env allowlist OR ``user_data.is_admin``),
  3. resolve the recipient to a registered wallet
     (reply-target saved wallet → ``@username`` → raw address → self),
  4. enforce per-tip, rolling daily, and rate limits BEFORE signing,
  5. write the append-only ``telegram_tips`` ledger.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from decimal import Decimal

from .tokens import TOKENS, get_token, is_valid_address, normalize_token, parse_amount

logger = logging.getLogger(__name__)

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_MENTION_RE = re.compile(r"^@([A-Za-z0-9_]{3,24})$")

DAILY_STATUSES = ("sending", "confirmed")


# ── env helpers ──────────────────────────────────────────────────────────────
def _env_decimal(name: str, default: str) -> Decimal:
    raw = (os.getenv(name) or "").strip().strip('"\'`')
    if not raw:
        return Decimal(default)
    try:
        return Decimal(raw)
    except Exception:  # noqa: BLE001
        logger.warning("Invalid decimal env %s=%r; using default %s", name, raw, default)
        return Decimal(default)


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip().strip('"\'`')
    if not raw:
        return default
    try:
        return int(raw)
    except Exception:  # noqa: BLE001
        return default


def admin_allowlist() -> set[str]:
    """Telegram user IDs explicitly allowed to ``/tip`` (comma-separated)."""
    raw = os.getenv("TIP_ADMIN_TELEGRAM_IDS", "") or ""
    return {part.strip() for part in raw.replace(";", ",").split(",") if part.strip()}


def per_tip_cap(token_key: str) -> Decimal:
    meta = get_token(token_key)
    default = {
        "CELO": "100", "USDT": "100", "USDC": "100",
    }.get(token_key, "10000")
    # Env name uses the registry key (GD, CELO, USDT, USDC, XDC, XDC_GD).
    return _env_decimal(f"TIP_MAX_PER_TIP_{token_key}", default)


def daily_cap(token_key: str) -> Decimal:
    default = {
        "CELO": "500", "USDT": "500", "USDC": "500",
    }.get(token_key, "50000")
    return _env_decimal(f"TIP_DAILY_CAP_{token_key}", default)


def rate_limit_seconds() -> int:
    return _env_int("TIP_RATE_LIMIT_SECONDS", 15)


# ── supabase (lazy, admin-first for RLS safety) ──────────────────────────────
def _get_supabase():
    try:
        from supabase_client import get_supabase_admin_client, get_supabase_client

        return get_supabase_admin_client() or get_supabase_client()
    except Exception as exc:  # noqa: BLE001
        logger.error("telegram_tip: supabase unavailable: %s", exc)
        return None


def get_saved_wallet(telegram_user_id) -> str:
    """Registered wallet for a Telegram user (telegram_wallet_sessions)."""
    if not telegram_user_id:
        return ""
    supabase = _get_supabase()
    if not supabase:
        return ""
    try:
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("wallet_address")
            .eq("telegram_user_id", str(telegram_user_id))
            .limit(1)
            .execute()
        )
        if result and result.data:
            wallet = (result.data[0].get("wallet_address") or "").strip()
            return wallet.lower() if wallet else ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: saved-wallet lookup failed: %s", exc)
    return ""


def find_wallet_by_username(username: str) -> str | None:
    """Resolve ``@username`` → wallet (case-insensitive, unique by construction)."""
    match = _MENTION_RE.match((username or "").strip())
    if not match:
        return None
    supabase = _get_supabase()
    if not supabase:
        return None
    try:
        result = (
            supabase.table("user_data")
            .select("wallet_address")
            .ilike("username", match.group(1))
            .limit(1)
            .execute()
        )
        if result and result.data:
            wallet = (result.data[0].get("wallet_address") or "").strip()
            return wallet or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: username lookup failed: %s", exc)
    return None


# ── admin gate ───────────────────────────────────────────────────────────────
def is_tip_admin(telegram_user_id, wallet_for_audit: str | None = None) -> bool:
    """True only for an allowed Telegram ID (env allowlist) or a DB admin.

    When ``TIP_ADMIN_TELEGRAM_IDS`` is set, ONLY those IDs qualify (strict).
    Otherwise the caller's registered wallet must have ``user_data.is_admin``.
    """
    if not telegram_user_id:
        return False
    allow = admin_allowlist()
    if allow:
        return str(telegram_user_id) in allow

    wallet = wallet_for_audit or get_saved_wallet(telegram_user_id)
    if not wallet:
        return False
    try:
        from supabase_client import is_admin as _is_admin

        return bool(_is_admin(wallet))
    except Exception as exc:  # noqa: BLE001
        logger.error("telegram_tip: admin check failed: %s", exc)
        return False


# ── parsing ──────────────────────────────────────────────────────────────────
def parse_tip_command(text: str) -> dict:
    """Parse ``/tip <amount> <token> [recipient]``.

    Returns ``{ok, amount, token_key, recipient}`` where ``recipient`` is either
    an ``@username`` / raw ``0x`` address string or ``None``.
    """
    body = (text or "").strip()
    # Strip a leading /tip (optionally /tip@BotName), keep the rest.
    m = re.match(r"^/tip(?:@\w+)?\s*(.*)$", body, re.IGNORECASE | re.DOTALL)
    if not m:
        return {"ok": False, "error": "usage"}
    rest = m.group(1).strip()
    if not rest:
        return {"ok": False, "error": "usage"}

    parts = rest.split()
    if len(parts) < 2:
        return {"ok": False, "error": "usage"}

    amount = parse_amount(parts[0])
    if amount is None:
        return {"ok": False, "error": "bad_amount"}
    token_key = normalize_token(parts[1])
    if not token_key:
        return {"ok": False, "error": "bad_token"}

    recipient = None
    trailing = parts[2:]
    if trailing:
        candidate = trailing[0]
        if _MENTION_RE.match(candidate) or _ADDRESS_RE.match(candidate):
            recipient = candidate
        else:
            return {"ok": False, "error": "bad_recipient"}

    return {"ok": True, "amount": amount, "token_key": token_key, "recipient": recipient}


# ── recipient resolution ─────────────────────────────────────────────────────
def resolve_recipient(
    explicit: str | None,
    reply_telegram_user_id=None,
    self_wallet: str | None = None,
) -> dict:
    """Resolve a tip recipient to a wallet.

    Order: explicit raw ``0x`` address → explicit ``@username`` →
    the replied-to Telegram user's saved wallet → self (testing).

    Returns ``{ok, wallet, source, telegram_user_id}``.
    """
    if explicit and _ADDRESS_RE.match(explicit):
        return {"ok": True, "wallet": explicit.lower(), "source": "address", "telegram_user_id": None}

    if explicit and _MENTION_RE.match(explicit):
        wallet = find_wallet_by_username(explicit)
        if not wallet:
            return {"ok": False, "error": "recipient_unknown", "source": "username"}
        return {"ok": True, "wallet": wallet.lower(), "source": "username", "telegram_user_id": None}

    if reply_telegram_user_id:
        wallet = get_saved_wallet(reply_telegram_user_id)
        if not wallet:
            return {"ok": False, "error": "recipient_not_registered", "source": "reply"}
        return {"ok": True, "wallet": wallet, "source": "reply", "telegram_user_id": str(reply_telegram_user_id)}

    if self_wallet:
        return {"ok": True, "wallet": self_wallet.lower(), "source": "self", "telegram_user_id": None}

    return {"ok": False, "error": "no_recipient", "source": "none"}


# ── limits ───────────────────────────────────────────────────────────────────
def check_limits(admin_telegram_id, token_key: str, amount: Decimal) -> dict:
    """Per-tip cap + rolling daily cap + per-admin rate limit. Returns ``{ok}``."""
    cap = per_tip_cap(token_key)
    if amount > cap:
        return {"ok": False, "error": "over_per_tip_cap", "cap": cap}

    supabase = _get_supabase()
    if not supabase:
        # Fail CLOSED — without the ledger we cannot prove the daily budget.
        return {"ok": False, "error": "ledger_unavailable"}

    # Rate limit: most recent tip by this admin.
    try:
        recent = (
            supabase.table("telegram_tips")
            .select("created_at")
            .eq("admin_telegram_id", str(admin_telegram_id))
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if recent and recent.data:
            last = recent.data[0].get("created_at")
            if last:
                last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=timezone.utc)
                elapsed = (datetime.now(timezone.utc) - last_dt).total_seconds()
                wait = rate_limit_seconds()
                if elapsed < wait:
                    return {"ok": False, "error": "rate_limited", "retry_after": int(wait - elapsed)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: rate-limit check failed: %s", exc)

    # Rolling daily cap (UTC day).
    try:
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        rows = (
            supabase.table("telegram_tips")
            .select("amount")
            .eq("token", token_key)
            .in_("status", list(DAILY_STATUSES))
            .gte("created_at", start.isoformat())
            .execute()
        )
        spent = sum(Decimal(str(r.get("amount") or 0)) for r in (rows.data or []))
        if spent + amount > daily_cap(token_key):
            return {"ok": False, "error": "over_daily_cap", "spent": spent, "cap": daily_cap(token_key)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: daily-cap check failed: %s", exc)
        return {"ok": False, "error": "ledger_unavailable"}

    return {"ok": True}


# ── ledger ───────────────────────────────────────────────────────────────────
def record_tip(
    admin_telegram_id, admin_wallet, recipient_wallet, recipient_telegram,
    token_key, amount, status="pending", tx_hash=None, error_type=None, error_message=None,
) -> dict | None:
    """Insert a ledger row (append-only audit trail). Never raises."""
    supabase = _get_supabase()
    if not supabase:
        return None
    row = {
        "admin_telegram_id": str(admin_telegram_id),
        "admin_wallet": admin_wallet,
        "recipient_telegram": str(recipient_telegram) if recipient_telegram else None,
        "recipient_wallet": recipient_wallet,
        "token": token_key,
        "amount": str(amount),
        "status": status,
        "tx_hash": tx_hash,
        "error_type": error_type,
        "error_message": (error_message or None) and str(error_message)[:500],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        result = supabase.table("telegram_tips").insert(row).execute()
        if result and result.data:
            return result.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.error("telegram_tip: failed to record tip: %s", exc)
    return None


def update_tip(tip_id, **fields) -> None:
    """Update a ledger row (status/tx_hash/error). Never raises."""
    if tip_id is None:
        return
    supabase = _get_supabase()
    if not supabase:
        return
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        supabase.table("telegram_tips").update(fields).eq("id", tip_id).execute()
    except Exception as exc:  # noqa: BLE001
        logger.error("telegram_tip: failed to update tip %s: %s", tip_id, exc)


def _send_token(token_key, wallet, amount) -> dict:
    """Lazy wrapper around the blockchain service (kept injectable for tests)."""
    from .blockchain import TipBlockchainService

    return TipBlockchainService().send(token_key, wallet, amount)


# ── formatting ───────────────────────────────────────────────────────────────
def _fmt_amount(amount) -> str:
    try:
        d = Decimal(str(amount)).normalize()
        if d == d.to_integral_value():
            return f"{int(d):,}"
        return f"{d:,f}".rstrip("0").rstrip(".")
    except Exception:  # noqa: BLE001
        return str(amount)


def build_confirmation(result: dict) -> str:
    meta = TOKENS.get(result["token_key"], {})
    label = meta.get("label", result["token_key"])
    return (
        f"✅ <b>Tip sent — {_fmt_amount(result['amount'])} {label}</b>\n"
        f"To: <code>{result['recipient_masked']}</code>\n"
        f"Tx: {result['explorer_url']}"
    )


# ── orchestration ────────────────────────────────────────────────────────────
def execute_tip(
    text: str,
    admin_telegram_id,
    admin_wallet: str | None = None,
    reply_telegram_user_id=None,
    self_wallet: str | None = None,
    send_fn=None,
) -> dict:
    """Full flow: gate → parse → resolve → limits → send → ledger.

    Returns ``{ok, message, ...}``. The caller (bot handler) only sends
    ``message``. Never raises.
    """
    if not is_tip_admin(admin_telegram_id, admin_wallet):
        logger.warning("telegram_tip: /tip denied for telegram id %s", admin_telegram_id)
        return {"ok": False, "error": "not_admin", "message": "❌ Only GoodMarket admins can use /tip."}

    parsed = parse_tip_command(text)
    if not parsed.get("ok"):
        return {"ok": False, "error": parsed.get("error"), "message": _usage_message(parsed.get("error"))}

    token_key = parsed["token_key"]
    amount = parsed["amount"]
    meta = TOKENS[token_key]

    resolved = resolve_recipient(parsed.get("recipient"), reply_telegram_user_id, self_wallet)
    if not resolved.get("ok"):
        return {"ok": False, "error": resolved.get("error"), "message": _recipient_message(resolved.get("error"))}

    limits = check_limits(admin_telegram_id, token_key, amount)
    if not limits.get("ok"):
        return {"ok": False, "error": limits.get("error"), "message": _limit_message(limits, meta)}

    recipient_wallet = resolved["wallet"]
    tip_row = record_tip(
        admin_telegram_id, admin_wallet, recipient_wallet,
        resolved.get("telegram_user_id"), token_key, amount, status="pending",
    )
    tip_id = tip_row.get("id") if tip_row else None

    send = send_fn or _send_token
    try:
        result = send(token_key, recipient_wallet, amount)
    except Exception as exc:  # noqa: BLE001
        logger.error("telegram_tip: send raised: %s", exc)
        result = {"success": False, "error": str(exc), "error_type": "send_exception"}

    masked = _mask(recipient_wallet)

    if result.get("success"):
        update_tip(tip_id, status="confirmed", tx_hash=result.get("tx_hash"))
        return {
            "ok": True,
            "error": None,
            "token_key": token_key,
            "amount": amount,
            "recipient_masked": masked,
            "explorer_url": result.get("explorer_url"),
            "tx_hash": result.get("tx_hash"),
            "message": build_confirmation({
                "token_key": token_key, "amount": amount,
                "recipient_masked": masked, "explorer_url": result.get("explorer_url"),
            }),
        }

    error_type = result.get("error_type") or "send_failed"
    if error_type == "submitted_unconfirmed":
        update_tip(tip_id, status="sending", tx_hash=result.get("tx_hash"), error_type=error_type)
        hash_masked = _mask(result.get("tx_hash") or "")
        return {
            "ok": False,
            "error": error_type,
            "tx_hash": result.get("tx_hash"),
            "message": (
                "⏳ <b>Tip broadcast but not yet confirmed.</b>\n"
                f"To: <code>{masked}</code>\n"
                f"Tx: <code>{hash_masked}</code>\n"
                "Do <b>NOT</b> resend — it may still confirm."
            ),
        }

    update_tip(tip_id, status="failed", error_type=error_type, error_message=result.get("error"))
    return {"ok": False, "error": error_type, "message": _send_error_message(error_type, meta)}


# ── message helpers ──────────────────────────────────────────────────────────
def _mask(value: str | None) -> str:
    if not value or len(value) < 10:
        return value or ""
    return value[:6] + "…" + value[-4:]


def _usage_message(error: str | None) -> str:
    if error == "bad_amount":
        base = "❌ Invalid amount. Example: <code>/tip 100 G$</code>"
    elif error == "bad_token":
        tokens = ", ".join(meta["label"] for meta in TOKENS.values())
        base = f"❌ Unsupported token. Supported: <b>{tokens}</b>"
    elif error == "bad_recipient":
        base = "❌ Recipient must be an <code>@username</code> or a <code>0x</code> address."
    else:
        base = "ℹ️ Usage: <code>/tip &lt;amount&gt; &lt;token&gt; [@user]</code>"
    return (
        f"{base}\n\n"
        "Examples:\n"
        "<code>/tip 100 G$</code> (reply to a member to tip them)\n"
        "<code>/tip 1 XDC @username</code>\n"
        "<code>/tip 1 CELO</code>\n"
        "<code>/tip 1 USDT</code>"
    )


def _recipient_message(error: str | None) -> str:
    if error in ("recipient_not_registered", "recipient_unknown"):
        return (
            "❌ Recipient is not registered yet.\n"
            "Ask them to <code>/start</code> and save their wallet first, "
            "or reply directly to their message with the tip."
        )
    if error == "no_recipient":
        return "❌ No recipient. Reply to a member's message, or add <code>@username</code> / a <code>0x</code> address."
    return "❌ Could not resolve a recipient wallet."


def _limit_message(limits: dict, meta: dict) -> str:
    error = limits.get("error")
    label = meta.get("label", "token")
    if error == "over_per_tip_cap":
        return f"❌ Over the per-tip limit. Max is <b>{_fmt_amount(limits.get('cap'))} {label}</b> per tip."
    if error == "over_daily_cap":
        return (
            f"❌ Daily cap reached. Already sent <b>{_fmt_amount(limits.get('spent'))} {label}</b> "
            f"today (cap {_fmt_amount(limits.get('cap'))}). Try again tomorrow (UTC)."
        )
    if error == "rate_limited":
        return f"⏳ Please wait <b>{limits.get('retry_after', rate_limit_seconds())}s</b> before the next /tip."
    if error == "ledger_unavailable":
        return "⚠️ Tip ledger is unavailable right now. Please try again later."
    return "❌ Tip limit check failed."


def _send_error_message(error_type: str, meta: dict) -> str:
    label = meta.get("label", "token")
    if error_type == "insufficient_gas":
        return "❌ The TIP_KEY wallet has insufficient native gas. An admin must top it up."
    if error_type == "insufficient_balance":
        return f"❌ The TIP_KEY wallet has insufficient {label}. An admin must top it up."
    if error_type == "reverted":
        return "❌ The transfer reverted on-chain. Nothing was sent."
    if error_type == "nonce_collision":
        return "⏳ Temporary nonce conflict. Please try again in a few seconds."
    return "❌ Tip failed. Please try again or check the server logs."
