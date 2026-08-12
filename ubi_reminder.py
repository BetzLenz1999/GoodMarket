"""Daily Telegram UBI reminder scheduler.

The GoodDollar UBI claiming window resets every day at 12:00 UTC. This module
runs a background thread that fires shortly after the reset (default 12:30 UTC)
and, for every Telegram user who linked a wallet, checks the on-chain UBI
entitlement via ``blockchain.get_ubi_entitlement`` — a read-only ``eth_call`` to
``UBI_PROXY.checkEntitlement(wallet)``. Users who can claim get a "claim now"
reminder; users who are not yet verified (or whose face verification lapsed) get
a "verify first" reminder. A per-wallet ``ubi_reminder_sent_date`` column on
``telegram_wallet_sessions`` guarantees at most one reminder per wallet per UTC
day, so restarts / multi-worker races never spam a user.

Env knobs (all optional):
    TELEGRAM_UBI_REMINDER_ENABLED       – "1"/"true" to enable (default off)
    TELEGRAM_UBI_REMINDER_UTC_HOUR      – hour to fire, 0-23 (default 12)
    TELEGRAM_UBI_REMINDER_UTC_MINUTE    – minute to fire (default 30)
    TELEGRAM_UBI_REMINDER_MAX_USERS      – cap rows processed per run (default 500)
    TELEGRAM_UBI_REMINDER_RPC_DELAY_SEC – small sleep between entitlement checks (default 0.1)
"""
import logging
import os
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_REMINDER_ENABLED = os.getenv("TELEGRAM_UBI_REMINDER_ENABLED", "").lower() in ("1", "true", "yes", "on")
_REMINDER_UTC_HOUR = int(os.getenv("TELEGRAM_UBI_REMINDER_UTC_HOUR", "12"))
_REMINDER_UTC_MINUTE = int(os.getenv("TELEGRAM_UBI_REMINDER_UTC_MINUTE", "30"))
_MAX_USERS = int(os.getenv("TELEGRAM_UBI_REMINDER_MAX_USERS", "500"))
_RPC_DELAY_SEC = float(os.getenv("TELEGRAM_UBI_REMINDER_RPC_DELAY_SEC", "0.1"))

# Poll how often the thread wakes to decide whether it's time to run. A short
# interval keeps the thread responsive to a restart that skips past the target
# time, while the dedup column prevents double sends within a day.
_POLL_INTERVAL_SECONDS = int(os.getenv("TELEGRAM_UBI_REMINDER_POLL_SECONDS", "300"))

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()
_last_run_date = None  # cache the UTC date we last ran for, in-memory dedup


def _today_utc() -> str:
    """Return today's UTC date as YYYY-MM-DD (matches Postgres DATE cast)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _get_sessions_to_remind():
    """Return telegram_wallet_sessions rows that have not been reminded today.

    Selects only rows with a non-empty chat id and a wallet, and excludes any
    row whose ``ubi_reminder_sent_date`` already equals today's UTC date so a
    restart or a concurrent worker never re-sends within the same cycle.
    """
    from supabase_client import get_supabase_admin_client, get_supabase_client
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        logger.warning("⚠️ UBI reminder: database unavailable")
        return []
    try:
        today = _today_utc()
        # Eligible = not yet reminded today. The dedup column is NULL for all
        # rows that have never been reminded, so we must include NULLs — a bare
        # `.neq(col, today)` drops NULL rows in PostgREST (NULL != x → NULL,
        # not true), which would silently skip every existing user. Combine
        # `IS NULL` with `!= today` via an OR filter instead.
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("telegram_chat_id, wallet_address")
            .not_.is_("telegram_chat_id", "null")
            .neq("telegram_chat_id", "")
            .or_(f"ubi_reminder_sent_date.is.null,ubi_reminder_sent_date.neq.{today}")
            .order("last_seen_at", desc=True)
            .limit(_MAX_USERS)
            .execute()
        )
        return result.data or []
    except Exception as exc:  # noqa: BLE001
        logger.exception("UBI reminder: could not fetch sessions: %s", exc)
        return []


def _mark_reminded(wallet_address: str, today: str) -> None:
    """Stamp the dedup column so this wallet isn't reminded again today."""
    from supabase_client import get_supabase_admin_client, get_supabase_client
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return
    try:
        supabase.table("telegram_wallet_sessions") \
            .update({"ubi_reminder_sent_date": today}) \
            .eq("wallet_address", wallet_address.lower()) \
            .execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ UBI reminder: could not stamp dedup for %s: %s", wallet_address[:10], exc)


def _build_claim_message(entitlement_g: float) -> str:
    amount = f"{entitlement_g:.2f}"
    return (
        "💰 <b>Your daily UBI is ready to claim!</b>\n\n"
        f"You can claim <b>{amount} G$</b> right now from the GoodDollar UBI.\n"
        "The claiming window resets every day at 12:00 UTC — claim it before then "
        "so you don't miss today's distribution.\n\n"
        "Open GoodWallet or GoodDapp and tap <b>Claim</b>."
    )


def _build_verify_message(reason: str) -> str:
    if reason == "re_verification_needed":
        body = (
            "Your face verification has expired, so you can't claim today's UBI yet. "
            "Please re-verify in GoodDollar (GoodWallet / GoodDapp), then you'll be able "
            "to claim your daily G$ again."
        )
    else:
        body = (
            "You haven't completed face verification yet, so you can't claim UBI. "
            "Verify your uniqueness once in GoodDollar (GoodWallet / GoodDapp) to start "
            "receiving your daily G$."
        )
    return "🔎 <b>Claim your daily UBI</b>\n\n" + body


def _process_one(row: dict, today: str) -> str:
    """Check entitlement for one wallet and send the right reminder.

    Returns a short status label for logging: 'claim', 'verify',
    'skipped', or 'error'.
    """
    chat_id = str(row.get("telegram_chat_id") or "")
    wallet = (row.get("wallet_address") or "").strip().lower()
    if not chat_id or not wallet:
        return "skipped"
    try:
        from blockchain import get_ubi_entitlement
        result = get_ubi_entitlement(wallet)
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ UBI reminder: entitlement check failed for %s: %s", wallet[:10], exc)
        return "error"

    if not result.get("success"):
        return "error"

    from telegram_notify import send_message
    if result.get("can_claim"):
        amount = float(result.get("entitlement") or 0)
        if amount <= 0:
            return "skipped"
        sent = send_message(chat_id, _build_claim_message(amount))
        if not sent:
            return "error"
        _mark_reminded(wallet, today)
        return "claim"

    # Not claimable — only nudge users we can actually help (unverified or
    # re-verification needed). Already-claimed / zero-entitlement users stay quiet.
    reason = result.get("reason")
    if reason in ("not_verified", "re_verification_needed"):
        sent = send_message(chat_id, _build_verify_message(reason))
        if not sent:
            return "error"
        _mark_reminded(wallet, today)
        return "verify"

    return "skipped"


def run_reminder_once() -> dict:
    """Run one reminder pass immediately. Returns a summary dict."""
    global _last_run_date
    today = _today_utc()
    sessions = _get_sessions_to_remind()
    summary = {"date": today, "processed": 0, "claim": 0, "verify": 0, "skipped": 0, "error": 0}
    logger.info("🔔 UBI reminder run started for %s — %d candidate(s)", today, len(sessions))
    for row in sessions:
        status = _process_one(row, today)
        summary["processed"] += 1
        summary[status] = summary.get(status, 0) + 1
        if _RPC_DELAY_SEC > 0:
            time.sleep(_RPC_DELAY_SEC)
    _last_run_date = today
    logger.info("🔔 UBI reminder run finished — %s", summary)
    return summary


def _scheduler_loop():
    """Wake periodically and fire the reminder pass at the scheduled UTC time."""
    global _last_run_date
    while not _scheduler_stop.is_set():
        try:
            now = datetime.now(timezone.utc)
            today = _today_utc()
            # Fire when the current UTC time is at/after the target slot AND we
            # haven't already run for today (in-memory + column dedup).
            target_time = now.replace(hour=_REMINDER_UTC_HOUR, minute=_REMINDER_UTC_MINUTE,
                                      second=0, microsecond=0)
            due = now >= target_time and _last_run_date != today
            if due:
                run_reminder_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("UBI reminder scheduler crashed: %s", exc)
        _scheduler_stop.wait(_POLL_INTERVAL_SECONDS)


def init_ubi_reminder_scheduler(app=None):
    """Start the background UBI reminder thread. Returns True if started."""
    global _scheduler_thread
    if not _REMINDER_ENABLED:
        logger.info("UBI reminder scheduler disabled (TELEGRAM_UBI_REMINDER_ENABLED not set)")
        return False
    if not os.getenv("TELEGRAM_BOT_TOKEN"):
        logger.info("UBI reminder scheduler disabled: TELEGRAM_BOT_TOKEN not set")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            name="telegram-ubi-reminder-scheduler",
            daemon=True,
        )
        _scheduler_thread.start()
        logger.info("UBI reminder scheduler started — fires daily at %02d:%02d UTC",
                    _REMINDER_UTC_HOUR, _REMINDER_UTC_MINUTE)
        return True


def shutdown_ubi_reminder_scheduler():
    """Signal the scheduler thread to stop (best-effort, for tests)."""
    _scheduler_stop.set()
