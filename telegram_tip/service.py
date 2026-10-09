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
# Telegram usernames are 5-32 chars (letters/digits/underscore). Allow 3-32 so
# both the GoodMarket app username and any Telegram @handle are accepted — the
# old 3-24 cap silently rejected legitimate long handles, which then failed
# mention parsing entirely.
_MENTION_RE = re.compile(r"^@([A-Za-z0-9_]{3,32})$")

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
        "CELO": "100", "USDT": "100", "USDC": "100", "CUSD": "100",
    }.get(token_key, "10000")
    # Env name uses the registry key (GD, CELO, USDT, USDC, CUSD, XDC, XDC_GD).
    return _env_decimal(f"TIP_MAX_PER_TIP_{token_key}", default)


def daily_cap(token_key: str) -> Decimal:
    default = {
        "CELO": "500", "USDT": "500", "USDC": "500", "CUSD": "500",
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


def lookup_saved_wallet(telegram_user_id) -> dict:
    """Diagnostic lookup of a Telegram user's saved wallet.

    Returns ``{found, wallet, error, rows}`` so callers can tell APART
    "no row for this user" from "the DB read failed" — the plain
    ``get_saved_wallet`` collapses both into an empty string, which made a
    failed read indistinguishable from a genuinely unregistered user and
    produced misleading "recipient not registered" replies.
    """
    if not telegram_user_id:
        return {"found": False, "wallet": "", "error": "no_user_id", "rows": 0}
    supabase = _get_supabase()
    if not supabase:
        return {"found": False, "wallet": "", "error": "no_supabase", "rows": 0}
    try:
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("wallet_address")
            .eq("telegram_user_id", str(telegram_user_id))
            .limit(1)
            .execute()
        )
        rows = list(result.data or []) if result else []
        if rows:
            wallet = (rows[0].get("wallet_address") or "").strip()
            if wallet:
                return {"found": True, "wallet": wallet.lower(), "error": None, "rows": len(rows)}
        return {"found": False, "wallet": "", "error": None, "rows": len(rows)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: saved-wallet lookup failed: %s", exc)
        return {"found": False, "wallet": "", "error": f"db_error: {exc}", "rows": 0}


def get_saved_wallet(telegram_user_id) -> str:
    """Registered wallet for a Telegram user (telegram_wallet_sessions)."""
    return lookup_saved_wallet(telegram_user_id).get("wallet", "")


def username_for_wallet(wallet: str | None) -> str | None:
    """@username (without the @) for a wallet, from user_data. None if unset."""
    if not wallet:
        return None
    supabase = _get_supabase()
    if not supabase:
        return None
    try:
        result = (
            supabase.table("user_data")
            .select("username")
            .ilike("wallet_address", wallet)
            .limit(1)
            .execute()
        )
        if result and result.data:
            name = (result.data[0].get("username") or "").strip()
            return name or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: username lookup failed: %s", exc)
    return None


def username_for_telegram(telegram_user_id) -> str | None:
    """@username (without the @) saved for a Telegram user, if any."""
    if not telegram_user_id:
        return None
    supabase = _get_supabase()
    if not supabase:
        return None
    try:
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("username, wallet_address")
            .eq("telegram_user_id", str(telegram_user_id))
            .limit(1)
            .execute()
        )
        if result and result.data:
            row = result.data[0]
            name = (row.get("username") or "").strip()
            if name:
                return name
            return username_for_wallet(row.get("wallet_address"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: telegram username lookup failed: %s", exc)
    return None


def find_wallet_by_username(username: str) -> str | None:
    """Resolve ``@username`` → wallet.

    Two username sources exist and must both be honoured:
      1. ``user_data.username`` — the GoodMarket username (case-insensitive,
         unique by construction).
      2. ``telegram_wallet_sessions.username`` — the Telegram @handle the bot
         captured at wallet-save time. A user who only ever registered through
         the bot is absent from ``user_data.username`` but IS registered, so
         without this fallback a tip addressed to their Telegram @handle used to
         fail with "recipient is not registered yet" even though their wallet
         was saved. `user_data` is preferred (canonical app username); the bot
         table is the fallback.

    Each source is guarded independently so one failing table cannot block the
    other. Returns the wallet (lowercased) or None.
    """
    match = _MENTION_RE.match((username or "").strip())
    if not match:
        return None
    supabase = _get_supabase()
    if not supabase:
        return None
    handle = match.group(1)

    # Preferred: the GoodMarket app username.
    try:
        result = (
            supabase.table("user_data")
            .select("wallet_address")
            .ilike("username", handle)
            .limit(1)
            .execute()
        )
        if result and result.data:
            wallet = (result.data[0].get("wallet_address") or "").strip()
            if wallet:
                return wallet.lower()
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: user_data username lookup failed: %s", exc)

    # Fallback: the Telegram @handle captured by the bot. Ignore NULL/blank
    # usernames (many rows have none) — the ilike below already excludes them,
    # but we re-check defensively.
    try:
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("wallet_address,username")
            .ilike("username", handle)
            .limit(1)
            .execute()
        )
        if result and result.data:
            row = result.data[0]
            if (row.get("username") or "").strip():
                wallet = (row.get("wallet_address") or "").strip()
                if wallet:
                    return wallet.lower()
    except Exception as exc:  # noqa: BLE001
        logger.warning("telegram_tip: telegram username lookup failed: %s", exc)
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


# ── trigger configuration ────────────────────────────────────────────────────
# The trigger is configurable so the command can dodge group-management bots
# (e.g. GroupHelp) that delete unrecognised "/" commands even for admins:
#   - TIP_COMMAND_ALIASES   : trigger words (default "tip,gift")
#   - TIP_COMMAND_PREFIXES  : allowed leading chars (default "/!" — Telegram
#                             only treats "/" as a real command, so "!tip" is
#                             ignored by most group bots)
#   - TIP_REPLY_TRIGGER     : "1" enables the NO-KEYWORD form — an admin replying
#                             to a member with just "<amount> <token>" (e.g.
#                             "100 XDC") is treated as a tip.
def command_aliases() -> list[str]:
    raw = os.getenv("TIP_COMMAND_ALIASES", "tip,gift")
    aliases = [a.strip().lower() for a in raw.replace(";", ",").split(",") if a.strip()]
    return aliases or ["tip"]


def command_prefixes() -> str:
    raw = os.getenv("TIP_COMMAND_PREFIXES", "/!")
    chars = "".join(ch for ch in raw if not ch.isspace())
    return chars or "/"


def reply_trigger_enabled() -> bool:
    return (os.getenv("TIP_REPLY_TRIGGER", "0") or "").strip().lower() in ("1", "true", "yes", "on")


def _tip_command_re():
    alts = "|".join(re.escape(a) for a in command_aliases())
    prefixes = re.escape(command_prefixes())
    return re.compile(rf"^[{prefixes}](?:{alts})(?:@\w+)?\s*(.*)$", re.IGNORECASE | re.DOTALL)


def is_tip_command(text: str) -> bool:
    """True when ``text`` starts with a configured tip trigger (any prefix/alias)."""
    return bool(_tip_command_re().match((text or "").strip()))


# ── parsing ──────────────────────────────────────────────────────────────────
def parse_tip_command(text: str) -> dict:
    """Parse ``<trigger> <amount> <token> [recipient]``.

    The trigger is any of the configured aliases with any configured prefix
    (e.g. ``/tip``, ``!tip``, ``.gift``, ``/tip@BotName``).

    Returns ``{ok, amount, token_key, recipient}`` where ``recipient`` is either
    an ``@username`` / raw ``0x`` address string or ``None``.
    """
    body = (text or "").strip()
    m = _tip_command_re().match(body)
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


def parse_reply_tip(text: str) -> dict:
    """No-keyword form: exactly ``<amount> <token>`` (e.g. ``100 XDC``).

    Only meaningful when the message is a reply to a member; the recipient comes
    from the reply target, not the text. Returns ``{ok, amount, token_key}``.
    """
    parts = (text or "").strip().split()
    if len(parts) != 2:
        return {"ok": False}
    amount = parse_amount(parts[0])
    if amount is None:
        return {"ok": False}
    token_key = normalize_token(parts[1])
    if not token_key:
        return {"ok": False}
    return {"ok": True, "amount": amount, "token_key": token_key}


# ── recipient resolution ─────────────────────────────────────────────────────
def resolve_recipient(
    explicit: str | None,
    reply_telegram_user_id=None,
    self_wallet: str | None = None,
    reply_username: str | None = None,
) -> dict:
    """Resolve a tip recipient to a wallet.

    Order: explicit raw ``0x`` address → explicit ``@username`` →
    the replied-to Telegram user's saved wallet → reply-message @handle
    (last-resort) → self (testing).

    ``reply_username`` is the Telegram @handle of the replied-to member, used
    ONLY as a last resort when the reply target has no saved wallet but their
    @handle IS registered in another table.

    Returns ``{ok, wallet, source, telegram_user_id, error?}``. When the wallet
    store is unreachable the error is ``recipient_lookup_unavailable`` so the
    caller can tell "DB is down" from "user genuinely not registered".
    """
    if explicit and _ADDRESS_RE.match(explicit):
        return {"ok": True, "wallet": explicit.lower(), "source": "address", "telegram_user_id": None}

    if explicit and _MENTION_RE.match(explicit):
        wallet = find_wallet_by_username(explicit)
        if not wallet:
            logger.info("telegram_tip: @%s did not resolve to a wallet", explicit.lstrip("@"))
            return {"ok": False, "error": "recipient_unknown", "source": "username"}
        return {"ok": True, "wallet": wallet.lower(), "source": "username", "telegram_user_id": None}

    if reply_telegram_user_id:
        info = lookup_saved_wallet(reply_telegram_user_id)
        if info.get("found"):
            return {"ok": True, "wallet": info["wallet"], "source": "reply", "telegram_user_id": str(reply_telegram_user_id)}
        # A failed DB read is an infra problem, not "not registered".
        if info.get("error") and info["error"] not in ("no_user_id",):
            logger.warning(
                "telegram_tip: reply recipient %s lookup error: %s",
                reply_telegram_user_id, info.get("error"),
            )
            return {"ok": False, "error": "recipient_lookup_unavailable", "source": "reply"}
        # Last resort: the replied-to member's @handle (surfaced via message
        # entities -> reply_username) may be registered in another table.
        if reply_username:
            wallet = find_wallet_by_username(reply_username)
            if wallet:
                return {"ok": True, "wallet": wallet, "source": "reply_username", "telegram_user_id": str(reply_telegram_user_id)}
        logger.info("telegram_tip: reply target %s has no saved wallet", reply_telegram_user_id)
        return {"ok": False, "error": "recipient_not_registered", "source": "reply"}

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


def public_announce_enabled() -> bool:
    return (os.getenv("TIP_PUBLIC_ANNOUNCE", "1") or "").strip().lower() in ("1", "true", "yes", "on")


def build_announcement(recipient_name, sender_name, token_key, amount, explorer_url) -> str | None:
    """Public "🎉 Congrats …" card for the group — @usernames only, never a wallet.

    Returns None when we cannot name the recipient (never leak an address).
    """
    if not recipient_name:
        return None
    meta = TOKENS.get(token_key, {})
    label = meta.get("label", token_key)
    who = f" from @{_safe_name(sender_name)}" if sender_name else ""
    return (
        f"🎉 <b>Congrats @{_safe_name(recipient_name)}!</b> "
        f"You received <b>{_fmt_amount(amount)} {label}</b>{who} 🎁\n"
        f"Tx: {explorer_url}"
    )


def _safe_name(name: str | None) -> str:
    """Strip a leading @ and anything that is not a username char, for safety."""
    return re.sub(r"[^A-Za-z0-9_]", "", (name or "").lstrip("@"))


# ── orchestration ────────────────────────────────────────────────────────────
def execute_tip(
    text: str,
    admin_telegram_id,
    admin_wallet: str | None = None,
    reply_telegram_user_id=None,
    self_wallet: str | None = None,
    send_fn=None,
    reply_username: str | None = None,
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

    return _execute_parsed(parsed, admin_telegram_id, admin_wallet, reply_telegram_user_id, self_wallet, send_fn, reply_username)


def execute_tip_parsed(
    parsed: dict,
    admin_telegram_id,
    admin_wallet: str | None = None,
    reply_telegram_user_id=None,
    self_wallet: str | None = None,
    send_fn=None,
    reply_username: str | None = None,
) -> dict:
    """Like ``execute_tip`` but takes a PRE-parsed ``{amount, token_key, recipient}``.

    Used by the no-keyword reply form, where the recipient is implied by the
    message being replied to rather than the text.
    """
    if not is_tip_admin(admin_telegram_id, admin_wallet):
        logger.warning("telegram_tip: tip denied for telegram id %s", admin_telegram_id)
        return {"ok": False, "error": "not_admin", "message": "❌ Only GoodMarket admins can send tips."}
    if not parsed or not parsed.get("ok"):
        return {"ok": False, "error": "usage", "message": _usage_message("usage")}
    return _execute_parsed(parsed, admin_telegram_id, admin_wallet, reply_telegram_user_id, self_wallet, send_fn, reply_username)


def _execute_parsed(
    parsed: dict,
    admin_telegram_id,
    admin_wallet: str | None,
    reply_telegram_user_id,
    self_wallet: str | None,
    send_fn,
    reply_username: str | None = None,
) -> dict:
    """Shared body: resolve recipient → limits → send → ledger."""
    token_key = parsed["token_key"]
    amount = parsed["amount"]
    meta = TOKENS[token_key]

    resolved = resolve_recipient(parsed.get("recipient"), reply_telegram_user_id, self_wallet, reply_username)
    if not resolved.get("ok"):
        # Log the full resolution inputs on failure — the user-facing message is
        # intentionally vague, so this is the only way to tell an @handle miss
        # (recipient_unknown) from an unregistered reply target
        # (recipient_not_registered) from a DB outage (lookup_unavailable).
        logger.warning(
            "telegram_tip: recipient unresolved error=%s source=%s admin_id=%s "
            "explicit=%r reply_user_id=%r reply_username=%r",
            resolved.get("error"), resolved.get("source"), admin_telegram_id,
            parsed.get("recipient"), reply_telegram_user_id, reply_username,
        )
        return {"ok": False, "error": resolved.get("error"), "message": _recipient_message(resolved.get("error"), resolved.get("source"))}

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
        recipient_name = (
            resolved.get("username")
            or username_for_telegram(resolved.get("telegram_user_id"))
            or username_for_wallet(recipient_wallet)
        )
        sender_name = username_for_telegram(admin_telegram_id) or username_for_wallet(admin_wallet)
        announcement = None
        if public_announce_enabled():
            announcement = build_announcement(
                recipient_name, sender_name, token_key, amount, result.get("explorer_url")
            )
        return {
            "ok": True,
            "error": None,
            "token_key": token_key,
            "amount": amount,
            "recipient_masked": masked,
            "recipient_name": recipient_name,
            "explorer_url": result.get("explorer_url"),
            "tx_hash": result.get("tx_hash"),
            "announcement": announcement,
            "message": build_confirmation({
                "token_key": token_key, "amount": amount,
                "recipient_masked": masked, "explorer_url": result.get("explorer_url"),
            }),
        }

    error_type = result.get("error_type") or "send_failed"
    # A short correlation ref (the ledger row id) lets the admin find the exact
    # row/log line for this tip without guessing.
    ref = f"TIP-{tip_id}" if tip_id else ""
    logger.error(
        "telegram_tip: send failed ref=%s error_type=%s admin_id=%s recipient=%s token=%s error=%r",
        ref, error_type, admin_telegram_id, masked, token_key, result.get("error"),
    )
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
                + (f"\nRef: <code>{ref}</code>" if ref else "")
            ),
        }

    update_tip(tip_id, status="failed", error_type=error_type, error_message=result.get("error"))
    return {"ok": False, "error": error_type, "message": _send_error_message(error_type, meta, ref)}


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


def _recipient_message(error: str | None, source: str | None = None) -> str:
    if error == "recipient_unknown":
        # The admin typed an explicit @handle that resolved to no wallet.
        return (
            "❌ No registered wallet found for that <code>@username</code>.\n"
            "Check the spelling, or tip their <code>0x</code> wallet address instead.\n"
            "<i>A member becomes tippable by @username after they open this bot, "
            "tap /start, and save their wallet.</i>"
        )
    if error == "recipient_not_registered":
        # The admin replied to a member whose wallet is not linked to the bot.
        return (
            "❌ That member hasn't linked a wallet to the bot yet, so there is no "
            "address to send to.\n"
            "Ask them to open this bot, tap /start, and save their GoodMarket wallet — "
            "or tip their <code>0x</code> wallet address directly (e.g. "
            "<code>/tip 10 G$ 0x…</code>)."
        )
    if error == "recipient_lookup_unavailable":
        return (
            "⚠️ Could not read registered wallets right now (a temporary server/database issue).\n"
            "Please try again in a moment."
        )
    if error == "no_recipient":
        return (
            "❌ No recipient.\n"
            "Reply to a member's message, or add <code>@username</code> / a <code>0x</code> address "
            "(e.g. <code>/tip 10 G$ @username</code>)."
        )
    return "❌ Could not resolve a recipient wallet. Please try again or check the server logs."


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


def _send_error_message(error_type: str, meta: dict, ref: str = "") -> str:
    label = meta.get("label", "token")
    suffix = f"\nRef: <code>{ref}</code>" if ref else ""
    if error_type == "insufficient_gas":
        return "❌ The TIP_KEY wallet has insufficient native gas. An admin must top it up." + suffix
    if error_type == "insufficient_balance":
        return f"❌ The TIP_KEY wallet has insufficient {label}. An admin must top it up." + suffix
    if error_type == "reverted":
        return "❌ The transfer reverted on-chain. Nothing was sent." + suffix
    if error_type == "nonce_collision":
        return "⏳ Temporary nonce conflict. Please try again in a few seconds." + suffix
    if error_type in ("no_key", "invalid_key"):
        return "❌ The tip wallet is not configured correctly. An admin must set <code>TIP_KEY</code>." + suffix
    if error_type == "rpc_down":
        return "⚠️ Could not reach the blockchain RPC right now. Please try again in a moment." + suffix
    if error_type == "gas_check_failed":
        return "⚠️ Could not read the tip wallet's gas balance (RPC hiccup). Please try again." + suffix
    if error_type == "balance_check_failed":
        return f"⚠️ Could not read the tip wallet's {label} balance (RPC hiccup). Please try again." + suffix
    if error_type in ("bad_recipient",):
        return "❌ Recipient address is invalid." + suffix
    if error_type in ("send_failed", "send_exception"):
        return "⚠️ The transfer could not be broadcast (RPC/network issue). Please try again in a moment." + suffix
    return "❌ Tip failed. Please try again or check the server logs." + suffix
