"""Durable Telegram broadcast delivery scheduler.

When an admin broadcasts a message, ``telegram_notify.queue_broadcast_deliveries``
writes one ``telegram_broadcast_deliveries`` row per Telegram user and stamps the
broadcast's ``tg_status='pending'``. This background scheduler drains those rows
in batches — sending each via the Telegram Bot API and recording the outcome —
until the broadcast is fully delivered (``tg_status='sent'``).

Why this exists: the old broadcast path pushed from a fire-and-forget daemon
thread spawned inside the admin HTTP request. Under gunicorn (``max_requests``
recycling + graceful timeouts) that thread was killed mid-broadcast, so many
users never received the message and the admin had no signal that delivery
failed. Moving delivery into a persistent scheduler (the same pattern as
``ubi_reminder.py`` and ``reloadly/refund_retry.py``) makes it survive worker
recycling: the per-recipient rows are the source of truth, so whichever worker
is alive picks up the remaining deliveries.

Env knobs (all optional):
    TELEGRAM_BROADCAST_DELIVERY_ENABLED – "1"/"true" to enable (default off)
    TELEGRAM_BROADCAST_DELIVERY_INTERVAL_SEC – poll interval (default 30)
    TELEGRAM_BROADCAST_DELIVERY_BATCH – rows per broadcast per pass (default 50)
    TELEGRAM_BROADCAST_DELIVERY_MAX_AGE_HOURS – skip broadcasts older than N hours
                                               so an ancient stuck one can't starve
                                               fresh broadcasts (default 48)
"""
import logging
import os
import threading

logger = logging.getLogger(__name__)

_DELIVERY_ENABLED = os.getenv("TELEGRAM_BROADCAST_DELIVERY_ENABLED", "").lower() in ("1", "true", "yes", "on")
_POLL_INTERVAL_SEC = int(os.getenv("TELEGRAM_BROADCAST_DELIVERY_INTERVAL_SEC", "30"))
_BATCH = int(os.getenv("TELEGRAM_BROADCAST_DELIVERY_BATCH", "50"))
_MAX_AGE_HOURS = int(os.getenv("TELEGRAM_BROADCAST_DELIVERY_MAX_AGE_HOURS", "48"))

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()
_wakeup = threading.Event()  # set by broadcast_message_async for near-immediate delivery


def wake_broadcast_delivery() -> None:
    """Signal the scheduler to wake now (a fresh broadcast was just queued)."""
    _wakeup.set()


def _fetch_due_broadcasts():
    """Return broadcast ids whose Telegram delivery is not yet complete.

    A broadcast is due when ``tg_status`` is 'pending' (nothing sent yet) or
    'partially_sent' (some sent, some still pending). We bound by created_at so
    a single ancient stuck broadcast can't starve fresh ones forever.
    """
    from datetime import datetime, timedelta, timezone
    from supabase_client import get_supabase_admin_client, get_supabase_client
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        logger.warning("⚠️ Broadcast delivery: database unavailable")
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=_MAX_AGE_HOURS)).isoformat()
    try:
        result = (
            supabase.table("admin_broadcast_messages")
            .select("id")
            .in_("tg_status", ["pending", "partially_sent"])
            .gte("created_at", cutoff)
            .order("created_at", desc=False)
            .limit(50)
            .execute()
        )
        return [r["id"] for r in (result.data or []) if r.get("id") is not None]
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Broadcast delivery: could not fetch due broadcasts: %s", exc)
        return []


def run_broadcast_delivery_once() -> dict:
    """One pass: deliver one batch for each due broadcast. Returns a summary."""
    from telegram_notify import deliver_broadcast_once
    summary = {"broadcasts": 0, "processed": 0, "sent": 0, "failed": 0}
    due = _fetch_due_broadcasts()
    if not due:
        return summary
    summary["broadcasts"] = len(due)
    for bid in due:
        try:
            res = deliver_broadcast_once(bid, batch_limit=_BATCH)
            summary["processed"] += res.get("processed", 0)
            summary["sent"] += res.get("sent", 0)
            summary["failed"] += res.get("failed", 0)
        except Exception as exc:  # noqa: BLE001
            logger.exception("❌ Broadcast delivery pass crashed for broadcast %s: %s", bid, exc)
    return summary


def _scheduler_loop():
    """Wake on the configured interval (or a wakeup event) and run one pass."""
    logger.info("📢 Broadcast delivery scheduler started — interval %ss, batch %d", _POLL_INTERVAL_SEC, _BATCH)
    while not _scheduler_stop.is_set():
        try:
            run_broadcast_delivery_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Broadcast delivery scheduler crashed: %s", exc)
        # Wait the poll interval, but return early if a fresh broadcast wakes us.
        _wakeup.clear()
        _wakeup.wait(_POLL_INTERVAL_SEC)


def init_broadcast_delivery_scheduler(app=None):
    """Start the background delivery thread. Returns True if started."""
    global _scheduler_thread
    if not _DELIVERY_ENABLED:
        logger.info("Broadcast delivery scheduler disabled (TELEGRAM_BROADCAST_DELIVERY_ENABLED not set)")
        return False
    if not os.getenv("TELEGRAM_BOT_TOKEN"):
        logger.info("Broadcast delivery scheduler disabled: TELEGRAM_BOT_TOKEN not set")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            name="telegram-broadcast-delivery-scheduler",
            daemon=True,
        )
        _scheduler_thread.start()
        logger.info("✅ Broadcast delivery scheduler started")
        return True


def shutdown_broadcast_delivery_scheduler():
    """Signal the scheduler thread to stop (best-effort, for tests)."""
    _scheduler_stop.set()
    _wakeup.set()
