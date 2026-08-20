"""Automatic refund for GCash cashout requests not reviewed within 24 hours.

When an admin does not approve or reject a cashout request within 24 hours,
the user's G$ must be automatically refunded. This background scheduler polls
for expired pending requests and refunds them, using the same CAS claim +
gas preflight pattern as ``reloadly/refund_retry.py``.

Env knobs (all optional):
    GCASH_AUTO_REFUND_ENABLED        – "1"/"true" to enable (default off)
    GCASH_AUTO_REFUND_INTERVAL_SEC   – seconds between runs (default 300)
    GCASH_AUTO_REFUND_MAX_REQUESTS   – cap requests processed per run (default 50)

Follows the same background-thread + stop-event pattern as ``ubi_reminder.py``.
"""
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_REFUND_ENABLED = os.getenv("GCASH_AUTO_REFUND_ENABLED", "").lower() in ("1", "true", "yes", "on")
_REFUND_INTERVAL_SEC = int(os.getenv("GCASH_AUTO_REFUND_INTERVAL_SEC", "300"))
_MAX_REQUESTS = int(os.getenv("GCASH_AUTO_REFUND_MAX_REQUESTS", "50"))
_AUTO_REFUND_HOURS = 24

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _fetch_expired_pending(limit: int):
    """Return gcash_cashout_requests rows with status='pending' older than 24h."""
    from supabase_client import get_supabase_admin_client
    sb = get_supabase_admin_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=_AUTO_REFUND_HOURS)).isoformat()
    result = (
        sb.table("gcash_cashout_requests")
        .select("*")
        .eq("status", "pending")
        .lt("created_at", cutoff)
        .order("created_at")
        .limit(limit)
        .execute()
    )
    return result.data or []


def _process_one(req: dict):
    """CAS-claim and refund a single expired request."""
    from .service import claim_request_for_refund, send_refund, update_request

    request_id = req["id"]
    claimed = claim_request_for_refund(request_id, expected_status="pending")
    if not claimed:
        logger.debug(f"GCash auto-refund: request #{request_id} already claimed")
        return

    logger.info(f"⏰ GCash auto-refund: request #{request_id} expired (24h), refunding {req['amount_gd']} G$ to {req['wallet_address'][:8]}…")

    result = send_refund(req["wallet_address"], req["amount_gd"], request_id)

    if result["success"]:
        update_request(request_id, {
            "status": "refunded",
            "admin_note": "Auto-refunded: not reviewed within 24 hours",
            "refund_tx_hash": result["tx_hash"],
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info(f"✅ GCash auto-refund #{request_id}: {result['tx_hash'][:16]}…")
    else:
        update_request(request_id, {
            "status": "refund_failed",
            "admin_note": f"Auto-refund failed: {result.get('error', 'unknown')}",
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.error(f"❌ GCash auto-refund #{request_id} failed: {result.get('error')}")


def _run_scheduler():
    logger.info(
        f"🔄 GCash auto-refund scheduler started "
        f"(interval={_REFUND_INTERVAL_SEC}s, max={_MAX_REQUESTS}/run)"
    )
    while not _scheduler_stop.is_set():
        try:
            expired = _fetch_expired_pending(_MAX_REQUESTS)
            if expired:
                logger.info(f"⏰ GCash auto-refund: {len(expired)} expired request(s) found")
                for req in expired:
                    try:
                        _process_one(req)
                    except Exception as e:
                        logger.error(f"❌ GCash auto-refund error for #{req.get('id')}: {e}")
        except Exception as e:
            logger.error(f"❌ GCash auto-refund scheduler error: {e}")
        _scheduler_stop.wait(_REFUND_INTERVAL_SEC)
    logger.info("🛑 GCash auto-refund scheduler stopped")


def init_gcash_refund_scheduler(app=None):
    """Start the auto-refund background thread. Returns True if started."""
    global _scheduler_thread

    if not _REFUND_ENABLED:
        logger.info("ℹ️ GCash auto-refund scheduler disabled (GCASH_AUTO_REFUND_ENABLED not set)")
        return False

    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            logger.warning("⚠️ GCash auto-refund scheduler already running")
            return False

        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(target=_run_scheduler, daemon=True, name="gcash-refund-retry")
        _scheduler_thread.start()
        return True


def stop_gcash_refund_scheduler():
    """Signal the scheduler thread to stop."""
    _scheduler_stop.set()
