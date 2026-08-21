"""Automatic refund retry for Reloadly orders parked as ``pending_refund``.

When a Reloadly fulfillment fails and the refund also fails *because the
REFUND_KEY wallet has no CELO gas*, the order is parked with status
``pending_refund`` (see ``reloadly/routes.py``). Instead of failing the order
and asking the user to contact support, this background scheduler retries the
refund periodically. Once an admin refills the refund wallet with CELO, the
next retry succeeds and the order moves to ``refunded`` — fully automatic,
no user action required.

Env knobs (all optional):
    RELOADLY_REFUND_RETRY_ENABLED       – "1"/"true" to enable (default off)
    RELOADLY_REFUND_RETRY_INTERVAL_SEC  – seconds between runs (default 600)
    RELOADLY_REFUND_RETRY_MAX_ORDERS    – cap orders processed per run (default 100)
    RELOADLY_REFUND_RETRY_MAX_AGE_DAYS  – skip orders older than N days (default 14)

Follows the same background-thread + stop-event pattern as ``ubi_reminder.py``.
"""
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_RETRY_ENABLED = os.getenv("RELOADLY_REFUND_RETRY_ENABLED", "").lower() in ("1", "true", "yes", "on")
_RETRY_INTERVAL_SEC = int(os.getenv("RELOADLY_REFUND_RETRY_INTERVAL_SEC", "600"))
_MAX_ORDERS = int(os.getenv("RELOADLY_REFUND_RETRY_MAX_ORDERS", "100"))
_MAX_AGE_DAYS = int(os.getenv("RELOADLY_REFUND_RETRY_MAX_AGE_DAYS", "14"))

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _fetch_pending_refund_orders(limit: int, max_age_days: int):
    """Return ``reloadly_orders`` rows with status == 'pending_refund'.

    Ordered oldest-first so the longest-waiting users get refunded first.
    """
    from supabase_client import get_supabase_admin_client, get_supabase_client
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        logger.warning("⚠️ Refund retry: database unavailable")
        return []

    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
    try:
        result = (
            supabase.table("reloadly_orders")
            .select("*")
            .eq("status", "pending_refund")
            .gte("created_at", cutoff)
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception as e:
        logger.error(f"❌ Refund retry fetch error: {e}")
        return []


def run_refund_retry_once() -> dict:
    """One pass: retry refunds for all ``pending_refund`` orders. Idempotent.

    Concurrency-safe: each order is atomically claimed (``pending_refund`` ->
    ``refunding``) via ``claim_order_for_refund`` before ``refund_gd`` runs, so
    two workers (or the scheduler + a manual endpoint) can never double-refund
    the same order. The order is released to its final status afterwards.
    """
    from .service import refund_gd, update_order_record, claim_order_for_refund

    summary = {"scanned": 0, "refunded": 0, "still_pending": 0, "failed": 0, "skipped": 0}
    orders = _fetch_pending_refund_orders(_MAX_ORDERS, _MAX_AGE_DAYS)
    summary["scanned"] = len(orders)
    if not orders:
        logger.info("🔁 Refund retry: no pending_refund orders.")
        return summary

    logger.info(f"🔁 Refund retry: processing {len(orders)} pending_refund order(s).")
    for order in orders:
        order_id = order.get("id")
        wallet = order.get("wallet_address")
        gd_amount = order.get("gd_amount")
        if not order_id or not wallet or gd_amount is None:
            logger.warning(f"⚠️ Refund retry: skipping incomplete order row {order_id}")
            continue

        try:
            amount = float(gd_amount)
        except (TypeError, ValueError):
            logger.warning(f"⚠️ Refund retry: invalid gd_amount for order {order_id}: {gd_amount}")
            continue

        # Atomic claim: flip pending_refund -> refunding. Only the winner sends a
        # refund, so a concurrent worker / manual endpoint can't double-refund.
        claim = claim_order_for_refund(order_id)
        if not claim.get("claimed"):
            summary["skipped"] += 1
            logger.info(f"🔒 Refund retry: order {order_id} already claimed by another worker — skipping.")
            continue

        refund_result = refund_gd(wallet, amount, order_id)
        if refund_result.get("success"):
            update_order_record(order_id, {
                "status": "refunded",
                "refund_tx_hash": refund_result.get("tx_hash"),
                "refund_error": None,
            })
            summary["refunded"] += 1
            logger.info(f"✅ Refund retry succeeded for order {order_id}: tx {refund_result.get('tx_hash')}")
        elif refund_result.get("error_type") in ("insufficient_gas", "insufficient_balance"):
            # Still underfunded — release back to pending_refund for the next run.
            update_order_record(order_id, {"status": "pending_refund"})
            summary["still_pending"] += 1
            logger.info(f"⏳ Refund retry: order {order_id} still waiting on a gas/balance top-up.")
        else:
            # A different failure (e.g. on-chain revert) — escalate so it isn't
            # retried silently forever. Mark refund_failed.
            summary["failed"] += 1
            update_order_record(order_id, {
                "status": "refund_failed",
                "refund_error": refund_result.get("error"),
            })
            logger.error(f"❌ Refund retry hard-failed for order {order_id}: {refund_result.get('error')}")

    logger.info("🔁 Refund retry run finished — %s", summary)
    return summary


def _scheduler_loop():
    """Wake on the configured interval and run one retry pass."""
    while not _scheduler_stop.is_set():
        try:
            run_refund_retry_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Refund retry scheduler crashed: %s", exc)
        _scheduler_stop.wait(_RETRY_INTERVAL_SEC)


def init_refund_retry_scheduler(app=None):
    """Start the background refund-retry thread. Returns True if started."""
    global _scheduler_thread
    if not _RETRY_ENABLED:
        logger.info("Reloadly refund retry scheduler disabled (RELOADLY_REFUND_RETRY_ENABLED not set)")
        return False
    if not os.getenv("REFUND_KEY"):
        logger.info("Reloadly refund retry scheduler disabled: REFUND_KEY not set")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            name="reloadly-refund-retry-scheduler",
            daemon=True,
        )
        _scheduler_thread.start()
        logger.info("Reloadly refund retry scheduler started — interval %ss", _RETRY_INTERVAL_SEC)
        return True


def shutdown_refund_retry_scheduler():
    """Signal the scheduler thread to stop (best-effort, for tests)."""
    _scheduler_stop.set()
