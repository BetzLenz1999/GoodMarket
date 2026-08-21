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
# refund_failed rows (e.g. refund wallet out of gas) are retried too, but not
# every tick — wait this long between attempts on the same row.
_REFUND_FAILED_RETRY_AFTER_SEC = int(os.getenv("GCASH_REFUND_FAILED_RETRY_AFTER_SEC", "3600"))

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _fetch_refundable(limit: int):
    """Return requests that need a refund: status='pending' older than 24h, or
    status='refund_failed'/'refunding' whose last attempt is old enough to
    retry (the refund wallet may have been topped up since). 'refunding' rows
    are stranded CAS claims (a worker died mid-refund before send_refund
    learned to never raise) — the retry cutoff is far longer than the in-flight
    refund's worst case (~60s receipt poll), so re-claiming them is safe."""
    from supabase_client import get_supabase_admin_client
    sb = get_supabase_admin_client()
    now = datetime.now(timezone.utc)
    pending_cutoff = (now - timedelta(hours=_AUTO_REFUND_HOURS)).isoformat()
    retry_cutoff = (now - timedelta(seconds=_REFUND_FAILED_RETRY_AFTER_SEC)).isoformat()
    result = (
        sb.table("gcash_cashout_requests")
        .select("*")
        .or_(
            f"and(status.eq.pending,created_at.lt.{pending_cutoff}),"
            f"and(status.eq.refund_failed,updated_at.lt.{retry_cutoff}),"
            f"and(status.eq.refunding,updated_at.lt.{retry_cutoff})"
        )
        .order("created_at")
        .limit(limit)
        .execute()
    )
    return result.data or []


def _process_one(req: dict):
    """CAS-claim and refund a single refundable request."""
    from .service import claim_request_for_refund, process_claimed_refund

    request_id = req["id"]
    claimed = claim_request_for_refund(request_id, expected_status=req["status"])
    if not claimed:
        logger.debug(f"GCash auto-refund: request #{request_id} already claimed")
        return

    if req["status"] == "refund_failed":
        note = "Refund succeeded on automatic retry."
        logger.info(f"🔁 GCash auto-refund: retrying failed refund #{request_id} ({req['amount_gd']} G$ to {req['wallet_address'][:8]}…)")
    elif req["status"] == "refunding":
        note = "Refund recovered from a stalled attempt."
        logger.info(f"🔁 GCash auto-refund: re-claiming stalled refund #{request_id} ({req['amount_gd']} G$ to {req['wallet_address'][:8]}…)")
    else:
        note = "Auto-refunded: not reviewed within 24 hours"
        logger.info(f"⏰ GCash auto-refund: request #{request_id} expired (24h), refunding {req['amount_gd']} G$ to {req['wallet_address'][:8]}…")

    result = process_claimed_refund(req, note)

    if result["success"]:
        logger.info(f"✅ GCash auto-refund #{request_id}: {result['tx_hash'][:16]}…")
    else:
        logger.error(f"❌ GCash auto-refund #{request_id} failed: {result.get('error')}")


def _run_scheduler():
    logger.info(
        f"🔄 GCash auto-refund scheduler started "
        f"(interval={_REFUND_INTERVAL_SEC}s, max={_MAX_REQUESTS}/run)"
    )
    while not _scheduler_stop.is_set():
        try:
            refundable = _fetch_refundable(_MAX_REQUESTS)
            if refundable:
                logger.info(f"⏰ GCash auto-refund: {len(refundable)} refundable request(s) found")
                for req in refundable:
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
