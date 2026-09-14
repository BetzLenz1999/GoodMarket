"""Daily Lotto — draw + grant + vault automation.

Background thread (same pattern as ``ubi_reminder.py`` / ``reloadly/refund_retry.py``):
- When the PH clock reaches 20:00 (DAILY_LOTTO_DRAW_HOUR_PHT) it runs today's
  draw (CAS: pending -> drawing) and persists winning numbers + winner rows.
- It then grants the winners on-chain through GoodMarketLotto.grantWinners,
  and keeps retrying only the rows that were NOT granted — never double-pays.
- It re-arms a "vault ready" state for winners once the vault balance is
  topped up (automated by the next tick).

Env knobs (all optional):
    DAILY_LOTTO_AUTOMATION_ENABLED   – "1"/"true" (default ON)
    DAILY_LOTTO_CHECK_INTERVAL_SEC   – scheduler tick (default 30)
    DAILY_LOTTO_DRAW_HOUR_PHT        – 20 (8PM)
    DAILY_LOTTO_STUCK_MINUTES        – how long a 'drawing' round may hang
                                       before the scheduler recovers it (default 15)
"""
from __future__ import annotations

import logging
import os
import threading

from . import service as svc

logger = logging.getLogger(__name__)

_ENABLED = os.getenv("DAILY_LOTTO_AUTOMATION_ENABLED", "1").lower() in ("1", "true", "yes", "on")
_INTERVAL_SEC = int(os.getenv("DAILY_LOTTO_CHECK_INTERVAL_SEC", "30"))
_STUCK_MINUTES = int(os.getenv("DAILY_LOTTO_STUCK_MINUTES", "15"))

_stop = threading.Event()
_thread = None
_lock = threading.Lock()


def _did_grant_finish(round_row) -> bool:
    """True when the round's winners have all been granted on-chain."""
    return (round_row or {}).get("grant_status") in ("granted", "none")


def _process_draw_for_round(round_row) -> None:
    """Draw (if due), then grant the winners on-chain. Handles partial grants."""
    round_id = int(round_row["id"])
    status = round_row.get("status")

    # 1. Draw when still pending (or roll it back to pending if a CAS race
    #    left it 'drawing' for too long without winners — a worker died).
    if status == "pending":
        svc.run_draw_for_round(round_id)
        round_row = svc.get_round(round_id)
    elif status == "drawing":
        age_min = 0
        try:
            from datetime import datetime, timezone
            created = datetime.fromisoformat(str(round_row.get("updated_at") or round_row.get("created_at")))
            age_min = (datetime.now(timezone.utc) - created).total_seconds() / 60
        except Exception:  # noqa: BLE001
            pass
        if age_min >= _STUCK_MINUTES:
            logger.warning("🎰 Round %s stuck in 'drawing'; recovering + redrawing winners", round_id)
            svc.run_draw_for_round(round_id)
            round_row = svc.get_round(round_id)

    if round_row.get("status") != "completed":
        return
    if not round_row.get("winning_numbers"):
        return

    # 2. Grant winners on-chain unless already granted.
    if round_row.get("grant_status") == "granted":
        return

    sb = svc._get_supabase_admin()
    wins = sb.table("daily_lotto_winnings") \
        .select("wallet_address, amount_gd, status") \
        .eq("round_id", round_id) \
        .execute()
    winner_rows = [w for w in (wins.data or []) if w.get("status") != "claimed"]
    if not winner_rows:
        # No winners (or all already claimed) — nothing to grant.
        sb.table("daily_lotto_rounds").update({"grant_status": "granted"}).eq("id", round_id).execute()
        return

    from .blockchain import lotto_blockchain, _get_key
    if not _get_key():
        logger.warning("⏳ DAILY LOTTO: GOODMARKET_LOTTO_KEY not configured; skipping grant for #%s", round_id)
        sb.table("daily_lotto_rounds").update({"grant_status": "failed"}).eq("id", round_id).execute()
        return
    if not lotto_blockchain.contract_address:
        logger.warning("⏳ DAILY LOTTO: GOODMARKET_LOTTO_CONTRACT not configured; skipping grant for #%s", round_id)
        sb.table("daily_lotto_rounds").update({"grant_status": "failed"}).eq("id", round_id).execute()
        return

    # The contract requires each round to be FINALIZED before winners can be
    # granted (grantWinners reverts "round_not_finalized" otherwise), and
    # claim() needs claimable to be set — so finalize the round on-chain FIRST.
    # Without this step a draw completes in the DB but winners can NEVER pull a
    # prize: no grant, no claim, nothing on Celoscan.
    finalize = lotto_blockchain.finalize_round(
        round_id, [int(n) for n in round_row.get("winning_numbers", [])]
    )
    if not finalize.get("success"):
        err_type = finalize.get("error_type")
        if err_type in ("insufficient_gas", "nonce_collision", "submitted_unconfirmed", "rpc_unreachable", "finalize_exception"):
            logger.warning("🎟️ Lotto round #%s finalize transient (%s) — will retry", round_id, err_type)
            sb.table("daily_lotto_rounds").update({"grant_status": "partial"}).eq("id", round_id).execute()
        else:
            logger.error("🎟️ Lotto round #%s finalize failed: %s", round_id, finalize.get("error"))
            sb.table("daily_lotto_rounds").update({"grant_status": "partial"}).eq("id", round_id).execute()
        return

    winners = [w["wallet_address"] for w in winner_rows]
    amounts = [w["amount_gd"] for w in winner_rows]

    result = lotto_blockchain.grant_winners(round_id, winners, amounts)
    if result.get("success"):
        sb.table("daily_lotto_rounds").update({"grant_status": "granted"}).eq("id", round_id).execute()
        logger.info("🎟️ Lotto round #%s granted %d winner(s) on-chain (%s)", round_id, len(winners), result.get("tx_hash"))
    elif result.get("error_type") == "insufficient_vault_balance":
        # Vault short — park the round as partial (retry on a later tick once
        # the admin tops up) + alert the proposer/admin (throttled).
        sb.table("daily_lotto_rounds").update({"grant_status": "partial"}).eq("id", round_id).execute()
        logger.warning("🎟️ Lotto round #%s vault short (%s) — winners stay pending", round_id, result.get("shortfall_gd"))
        svc.raise_vault_alert(round_id, len(winners), result.get("shortfall_gd"))
    elif result.get("error_type") in ("insufficient_gas", "nonce_collision", "submitted_unconfirmed", "rpc_unreachable"):
        # Transient — leave as 'pending'/'partial' so the next tick retries.
        logger.warning("🎟️ Lotto round #%s grant transient (%s) — will retry", round_id, result.get("error_type"))
        sb.table("daily_lotto_rounds").update({"grant_status": "partial"}).eq("id", round_id).execute()
    else:
        logger.error("🎟️ Lotto round #%s grant failed: %s", round_id, result.get("error"))
        sb.table("daily_lotto_rounds").update({"grant_status": "partial"}).eq("id", round_id).execute()


def _run_once() -> None:
    meta = svc.current_round_metadata()
    today_round = svc.get_round(meta["round_id"])
    if today_round is None:
        # Round row not created by the app yet (user hadn't visited today).
        # Create it so the draw has a target.
        svc.ensure_round_exists(meta["round_id"], meta["game_date"])
        return

    # Draw due?
    if meta["drawn"] and today_round.get("status") == "pending":
        _process_draw_for_round(today_round)
        today_round = svc.get_round(meta["round_id"])

    # Process any completed round needing a grant (today's or an older
    # partial one).
    if today_round.get("status") == "completed":
        _process_draw_for_round(today_round)

    # Recover an old partial round too (grant retry), but only the most recent.
    try:
        sb = svc._get_supabase_admin()
        partials = sb.table("daily_lotto_rounds") \
            .select("id, status, grant_status, winning_numbers, updated_at, created_at") \
            .or_("grant_status.eq.partial,grant_status.eq.failed") \
            .order("id", desc=True) \
            .limit(5) \
            .execute()
        for row in (partials.data or []):
            if row.get("grant_status") in ("granted",):
                continue
            _process_draw_for_round(row)
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Lotto partial-round recovery failed: %s", exc)


def _run_scheduler():
    logger.info(
        "🎰 Daily Lotto draw scheduler started (interval=%ss, draw_hour=%s PHT)",
        _INTERVAL_SEC, svc.DRAW_HOUR_PHT,
    )
    while not _stop.is_set():
        try:
            _run_once()
        except Exception as exc:  # noqa: BLE001
            logger.error("❌ Daily Lotto scheduler tick failed: %s", exc)
        _stop.wait(_INTERVAL_SEC)
    logger.info("🛑 Daily Lotto draw scheduler stopped")


def init_daily_lotto_draw_scheduler(app=None):
    """Start the background thread. Returns True when started."""
    global _thread

    if not _ENABLED:
        logger.info("ℹ️ Daily Lotto draw scheduler disabled (DAILY_LOTTO_AUTOMATION_ENABLED not set)")
        return False

    with _lock:
        if _thread and _thread.is_alive():
            logger.warning("⚠️ Daily Lotto draw scheduler already running")
            return False
        _stop.clear()
        _thread = threading.Thread(target=_run_scheduler, daemon=True, name="daily-lotto-draw")
        _thread.start()
        return True


def stop_daily_lotto_draw_scheduler():
    """Signal the scheduler thread to stop."""
    _stop.set()
