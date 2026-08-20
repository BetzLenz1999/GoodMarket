"""Background referral auto-reconciler.

Event-based triggers (fv-callback, verify-identity, verify-ubi, claim confirm)
disburse referrals instantly when the referee finishes face verification or
claims UBI. This scheduler is the safety net for referrals that still got
stuck — e.g. the referee verified face while the RPC was down, or the server
restarted mid-disbursement. Every interval it:

1. Finds verified referees still sitting in ``pending_face_verification`` and
   disburses them via `verify_and_disburse_referral`.
2. Retries queued ``pending_disbursed`` reward legs via
   `process_pending_disbursements` (e.g. after the REFERRAL_KEY wallet is
   topped up with G$ or CELO gas).

Disbursement is duplicate-protected at both the CAS-claim layer and the
reward-log check layer, so concurrent schedulers in multiple gunicorn workers
never double-pay a completed leg.

Env knobs (all optional):
    REFERRAL_RECONCILER_ENABLED       – "0"/"false" to disable (default on)
    REFERRAL_RECONCILER_INTERVAL_SEC  – poll interval (default 900s)
    REFERRAL_RECONCILER_STUCK_HOURS   – only touch pending_face_verification
                                        rows older than this (default 1h)
"""
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

_ENABLED = os.getenv("REFERRAL_RECONCILER_ENABLED", "1").lower() not in ("0", "false", "no", "off")
_INTERVAL_SEC = int(os.getenv("REFERRAL_RECONCILER_INTERVAL_SEC", "900"))
_STUCK_HOURS = int(os.getenv("REFERRAL_RECONCILER_STUCK_HOURS", "1"))

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _reconcile_once():
    from referral_program.referral_service import referral_service

    stuck = referral_service.reconcile_stuck_referrals(older_than_hours=_STUCK_HOURS)
    if stuck.get("fixed") or stuck.get("still_stuck"):
        logger.info(
            f"🤝 Referral reconciler: fixed={stuck.get('fixed', 0)} "
            f"still_stuck={stuck.get('still_stuck', 0)}"
        )

    pending = referral_service.process_pending_disbursements()
    if pending.get("processed") or pending.get("failed"):
        logger.info(
            f"🤝 Referral reconciler: processed={pending.get('processed', 0)} "
            f"failed={pending.get('failed', 0)}"
        )


def _loop():
    # Small initial delay so app startup isn't slowed by a reconciliation pass.
    time.sleep(min(30, _INTERVAL_SEC))
    while not _scheduler_stop.is_set():
        try:
            _reconcile_once()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"⚠️ Referral reconciler tick failed: {exc}")
        _scheduler_stop.wait(_INTERVAL_SEC)


def is_reconciler_enabled() -> bool:
    return _ENABLED


def init_referral_reconciler(app=None):
    """Start the referral reconciler thread. Idempotent."""
    global _scheduler_thread
    if not _ENABLED:
        logger.info("ℹ️ Referral reconciler disabled (REFERRAL_RECONCILER_ENABLED=0)")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(target=_loop, daemon=True, name="referral-reconciler")
        _scheduler_thread.start()
        logger.info(
            f"✅ Referral reconciler started (every {_INTERVAL_SEC}s, "
            f"stuck>{_STUCK_HOURS}h)"
        )
        return True


def stop_referral_reconciler():
    global _scheduler_thread
    with _scheduler_lock:
        _scheduler_stop.set()
        _scheduler_thread = None
