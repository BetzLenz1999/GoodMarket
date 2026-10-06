"""Automatic refund retry for Reloadly orders parked as ``pending_refund``.

When a Reloadly fulfillment fails and the refund also fails *because the
REFUND_KEY wallet has no CELO gas* (or no G$ balance), the order is parked with
status ``pending_refund`` (see ``reloadly/routes.py``). Instead of failing the
order and asking the user to contact support, this background scheduler retries
the refund periodically. Once an admin refills the refund wallet, the next retry
succeeds and the order moves to ``refunded`` — fully automatic, no user action.

It also recovers two other stuck states:
  * ``refunding`` — a CAS claim stranded by a worker that died mid-refund
    (re-claimed after ``RELOADLY_REFUND_STALE_CLAIM_SEC``).
  * ``refund_failed`` — a hard failure that is now retryable after
    ``RELOADLY_REFUND_RETRY_FAILED_AFTER_SEC`` (0 disables), e.g. a transient
    on-chain revert or an RPC outage.

Env knobs (all optional):
    RELOADLY_REFUND_RETRY_ENABLED            – "0"/"false" to disable (default ON)
    RELOADLY_REFUND_RETRY_INTERVAL_SEC       – seconds between runs (default 600)
    RELOADLY_REFUND_RETRY_MAX_ORDERS         – cap orders processed per run (default 100)
    RELOADLY_REFUND_RETRY_MAX_AGE_DAYS       – skip orders older than N days (default 14)
    RELOADLY_REFUND_STALE_CLAIM_SEC          – reclaim 'refunding' rows older than this (default 300)
    RELOADLY_REFUND_RETRY_FAILED_AFTER_SEC   – retry 'refund_failed' rows after this (default 900, 0=off)

Follows the same background-thread + stop-event pattern as ``ubi_reminder.py``.
"""
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from env_utils import get_env_int

logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


# Default ON: refunds parked for a gas/balance top-up must resume automatically
# once the admin refills the wallet — requiring an env var for that defeats the
# purpose. Set RELOADLY_REFUND_RETRY_ENABLED=0 to opt out.
_RETRY_ENABLED = _env_flag("RELOADLY_REFUND_RETRY_ENABLED", True)
_RETRY_INTERVAL_SEC = get_env_int("RELOADLY_REFUND_RETRY_INTERVAL_SEC", 600)
_MAX_ORDERS = get_env_int("RELOADLY_REFUND_RETRY_MAX_ORDERS", 100)
_MAX_AGE_DAYS = get_env_int("RELOADLY_REFUND_RETRY_MAX_AGE_DAYS", 14)
_STALE_CLAIM_SEC = get_env_int("RELOADLY_REFUND_STALE_CLAIM_SEC", 300)
# 0 disables retrying refund_failed rows (leaves them admin-retry-only).
_FAILED_RETRY_AFTER_SEC = get_env_int("RELOADLY_REFUND_RETRY_FAILED_AFTER_SEC", 900)

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()
# Set by a manual "process now" request so the scheduler wakes immediately
# instead of waiting out the full interval.
_wake_event = threading.Event()


def _fetch_refundable_orders(limit: int, max_age_days: int):
    """Return ``reloadly_orders`` rows that need a refund attempt.

    Covers three stuck states:
      * ``pending_refund`` — parked after a gas/balance shortfall (any age
        inside the window; the retry is cheap and idempotent).
      * ``refunding`` — a CAS claim stranded by a dead worker, older than
        ``_STALE_CLAIM_SEC`` (worst-case in-flight refund is ~60s, so this is
        far longer than a live attempt).
      * ``refund_failed`` — hard failures retried after
        ``_FAILED_RETRY_AFTER_SEC`` (disabled when 0).

    Ordered oldest-first so the longest-waiting users are refunded first.
    """
    from supabase_client import get_supabase_admin_client, get_supabase_client
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        logger.warning("⚠️ Refund retry: database unavailable")
        return []

    now = datetime.now(timezone.utc)
    age_cutoff = (now - timedelta(days=max_age_days)).isoformat()
    stale_cutoff = (now - timedelta(seconds=_STALE_CLAIM_SEC)).isoformat()

    clauses = [f"and(status.eq.pending_refund,created_at.gte.{age_cutoff})"]
    clauses.append(
        f"and(status.eq.refunding,updated_at.lt.{stale_cutoff},created_at.gte.{age_cutoff})"
    )
    if _FAILED_RETRY_AFTER_SEC > 0:
        failed_cutoff = (now - timedelta(seconds=_FAILED_RETRY_AFTER_SEC)).isoformat()
        clauses.append(
            f"and(status.eq.refund_failed,updated_at.lt.{failed_cutoff},created_at.gte.{age_cutoff})"
        )

    try:
        result = (
            supabase.table("reloadly_orders")
            .select("*")
            .or_(",".join(clauses))
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception as e:
        logger.error(f"❌ Refund retry fetch error: {e}")
        return []


def _process_one_order(order: dict, summary: dict) -> None:
    """Claim and retry the refund for a single stuck order (mutates summary)."""
    from .service import (
        refund_gd, update_order_record, claim_order_for_refund, check_refund_tx_status,
    )

    order_id = order.get("id")
    wallet = order.get("wallet_address")
    gd_amount = order.get("gd_amount")
    current_status = order.get("status") or "pending_refund"
    if not order_id or not wallet or gd_amount is None:
        logger.warning(f"⚠️ Refund retry: skipping incomplete order row {order_id}")
        return

    try:
        amount = float(gd_amount)
    except (TypeError, ValueError):
        logger.warning(f"⚠️ Refund retry: invalid gd_amount for order {order_id}: {gd_amount}")
        return

    # Atomic claim: flip <current_status> -> refunding. Only the winner sends a
    # refund, so a concurrent worker / manual endpoint can't double-refund.
    # expected_status must match the row we fetched (pending_refund / refunding /
    # refund_failed) so we never steal a row another worker just moved on.
    claim = claim_order_for_refund(order_id, expected_status=current_status)
    if not claim.get("claimed"):
        summary["skipped"] += 1
        logger.info(f"🔒 Refund retry: order {order_id} already claimed by another worker — skipping.")
        return

    # Double-refund guard: if a previous attempt already BROADCAST a refund
    # tx (parked as submitted_unconfirmed), check that tx's on-chain
    # receipt instead of blindly re-sending. Confirmed → mark refunded;
    # reverted → escalate; still pending → leave parked for the next run.
    prior_tx = order.get("refund_tx_hash")
    if prior_tx:
        tx_status = check_refund_tx_status(prior_tx)
        if tx_status == "confirmed":
            update_order_record(order_id, {
                "status": "refunded",
                "refund_error": None,
            })
            summary["refunded"] += 1
            logger.info(f"✅ Refund retry: prior tx {prior_tx} confirmed for order {order_id}.")
            return
        if tx_status == "reverted":
            update_order_record(order_id, {
                "status": "refund_failed",
                "refund_error": "Refund transaction reverted on-chain",
            })
            summary["failed"] += 1
            logger.error(f"❌ Refund retry: prior tx {prior_tx} reverted for order {order_id}.")
            return
        # Still pending (or RPC unreachable) — do NOT re-send yet.
        update_order_record(order_id, {"status": "pending_refund"})
        summary["still_pending"] += 1
        logger.info(f"⏳ Refund retry: order {order_id} prior tx {prior_tx} still confirming.")
        return

    refund_result = refund_gd(wallet, amount, order_id)
    if refund_result.get("success"):
        update_order_record(order_id, {
            "status": "refunded",
            "refund_tx_hash": refund_result.get("tx_hash"),
            "refund_error": None,
        })
        summary["refunded"] += 1
        logger.info(f"✅ Refund retry succeeded for order {order_id}: tx {refund_result.get('tx_hash')}")
    elif refund_result.get("error_type") == "submitted_unconfirmed":
        # The (re-)broadcast refund tx hasn't confirmed yet — keep its hash
        # and wait for the next run to check the on-chain receipt.
        update_order_record(order_id, {
            "status": "pending_refund",
            "refund_tx_hash": refund_result.get("tx_hash"),
            "refund_error": refund_result.get("error"),
        })
        summary["still_pending"] += 1
        logger.info(f"⏳ Refund retry: order {order_id} tx {refund_result.get('tx_hash')} still confirming.")
    elif refund_result.get("error_type") in ("insufficient_gas", "insufficient_balance"):
        # Still underfunded — release back to pending_refund for the next run.
        update_order_record(order_id, {"status": "pending_refund"})
        summary["still_pending"] += 1
        logger.info(f"⏳ Refund retry: order {order_id} still waiting on a gas/balance top-up.")
    else:
        # A different failure (e.g. on-chain revert) — escalate so it isn't
        # retried silently forever. Mark refund_failed (the scheduler may pick
        # it up again later if RELOADLY_REFUND_RETRY_FAILED_AFTER_SEC is set).
        summary["failed"] += 1
        update_order_record(order_id, {
            "status": "refund_failed",
            "refund_error": refund_result.get("error"),
        })
        logger.error(f"❌ Refund retry hard-failed for order {order_id}: {refund_result.get('error')}")


def run_refund_retry_once() -> dict:
    """One pass: retry refunds for all stuck orders. Idempotent.

    Concurrency-safe: each order is atomically claimed (``<status>`` ->
    ``refunding``) via ``claim_order_for_refund`` before ``refund_gd`` runs, so
    two workers (or the scheduler + a manual endpoint) can never double-refund
    the same order.
    """
    summary = {"scanned": 0, "refunded": 0, "still_pending": 0, "failed": 0, "skipped": 0}
    orders = _fetch_refundable_orders(_MAX_ORDERS, _MAX_AGE_DAYS)
    summary["scanned"] = len(orders)
    if not orders:
        logger.info("🔁 Refund retry: no stuck orders.")
        return summary

    logger.info(f"🔁 Refund retry: processing {len(orders)} stuck order(s).")
    for order in orders:
        try:
            _process_one_order(order, summary)
        except Exception as exc:  # noqa: BLE001 - one bad row must not stop the batch
            logger.exception(f"Refund retry: order {order.get('id')} raised: {exc}")
            summary["failed"] += 1

    logger.info("🔁 Refund retry run finished — %s", summary)
    return summary


def retry_order_refund(order_id: str) -> dict:
    """Admin-triggered retry of a SINGLE order's refund, whatever its state.

    Unlike ``run_refund_retry_once`` this ignores the retry-after / age gates, so
    an admin can push a refund through immediately after topping up the wallet.
    Only refund-relevant statuses are accepted; anything already ``refunded`` (or
    not in a refund state) is refused.
    """
    from .service import get_order_record

    res = get_order_record(order_id)
    if not res.get("success"):
        return {"success": False, "error": "Order not found", "order_id": order_id}

    order = res["order"]
    status = (order.get("status") or "").lower()
    allowed = {"pending_refund", "refunding", "refund_failed"}
    if status == "refunded":
        return {"success": True, "already_refunded": True, "order_id": order_id,
                "message": "Order was already refunded."}
    if status not in allowed:
        return {"success": False, "error": f"Order status '{status}' is not refundable.",
                "order_id": order_id, "status": status}

    summary = {"scanned": 1, "refunded": 0, "still_pending": 0, "failed": 0, "skipped": 0}
    _process_one_order(order, summary)
    if summary["refunded"] > 0:
        return {"success": True, "summary": summary, "order_id": order_id,
                "message": "Refund sent."}
    if summary["still_pending"] > 0:
        return {"success": False, "summary": summary, "order_id": order_id,
                "error": "Refund still pending — top up the REFUND_KEY wallet with CELO gas and/or G$, then retry."}
    if summary["skipped"] > 0:
        return {"success": False, "summary": summary, "order_id": order_id,
                "error": "Order was claimed by another worker — refresh and try again."}
    return {"success": False, "summary": summary, "order_id": order_id,
            "error": "Refund failed. Check the order's last error and the refund wallet."}


def _scheduler_loop():
    """Wake on the configured interval (or a manual nudge) and run one pass."""
    while not _scheduler_stop.is_set():
        try:
            run_refund_retry_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Refund retry scheduler crashed: %s", exc)
        _wake_event.wait(_RETRY_INTERVAL_SEC)
        _wake_event.clear()


def wake_refund_retry() -> None:
    """Nudge the scheduler to run a pass immediately (best-effort)."""
    _wake_event.set()


def is_refund_retry_enabled() -> bool:
    return _RETRY_ENABLED


def init_refund_retry_scheduler(app=None):
    """Start the background refund-retry thread. Returns True if started."""
    global _scheduler_thread
    if not _RETRY_ENABLED:
        logger.info("Reloadly refund retry scheduler disabled (RELOADLY_REFUND_RETRY_ENABLED=0)")
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
    _wake_event.set()
