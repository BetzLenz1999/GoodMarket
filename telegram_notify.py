"""Best-effort + durable Telegram push helpers shared across the platform.

Centralizes direct-to-Telegram-Bot-API messaging so admin actions (such as
broadcasting an announcement) can push notifications to Telegram bot users
without depending on the telegram_bot Flask blueprint (avoids circular imports).

Two delivery modes:

* **Best-effort** (``send_message`` / ``broadcast_message``): fire-and-forget.
  Used by one-off nudges like the UBI reminder. Never raises.
* **Durable** (``queue_broadcast_deliveries`` / ``deliver_broadcast_once``):
  the admin broadcast path. Recipients are queued as rows in
  ``telegram_broadcast_deliveries`` and a background scheduler
  (``broadcast_delivery.py``) drains them idempotently. Survives gunicorn
  worker recycling — the broadcast keeps going even if the worker that
  received the admin request dies before delivery finishes.

Requires the ``TELEGRAM_BOT_TOKEN`` environment variable (the same one the bot
webhook already uses).
"""
import html
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List

import requests

from supabase_client import get_supabase_admin_client, get_supabase_client, safe_supabase_operation

logger = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}" if TELEGRAM_BOT_TOKEN else ""

# Telegram allows ~30 messages/second to distinct chats. A small delay keeps
# large broadcasts within the rate limit.
_BROADCAST_SEND_DELAY_SECONDS = float(os.getenv("TELEGRAM_BROADCAST_SEND_DELAY_SECONDS", "0.05"))

# Max delivery attempts for a transient (rate-limited / network / 5xx) failure
# before we give up and mark the recipient as permanently failed so the
# scheduler doesn't spin on a permanently-broken chat forever.
_MAX_RETRY_ATTEMPTS = int(os.getenv("TELEGRAM_BROADCAST_MAX_RETRY_ATTEMPTS", "5"))

# A delivery row claimed (pending -> sending) by a worker that then dies
# mid-batch (gunicorn recycle) would otherwise be stuck in 'sending' forever —
# reclaim it after this many seconds so another pass can deliver it.
_STALE_CLAIM_SECONDS = int(os.getenv("TELEGRAM_BROADCAST_STALE_CLAIM_SECONDS", "300"))


def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string (for Supabase TIMESTAMPTZ)."""
    return datetime.now(timezone.utc).isoformat()

# Telegram error codes (from the "parameters"/"error_code" fields of the JSON
# response). A blocked/kicked bot is 403 with subcode "chat_not_found" or
# "bot was blocked by the user" — never retryable. 429 is rate-limiting with a
# ``retry_after`` hint. 5xx and network errors are transient.
_BLOCKED_MARKERS = (
    "bot was blocked",
    "chat not found",
    "chat_not_found",
    "user is deactivated",
    "chat deactivated",
    "PEER_ID_INVALID",
)


def classify_send_error(resp=None, exc: Optional[Exception] = None) -> str:
    """Classify a failed sendMessage into 'blocked', 'rate_limited', 'retryable', or 'error'.

    'blocked' is permanent (user kicked/blocked the bot) — never retry.
    'rate_limited' / 'retryable' are transient — a later run may succeed.
    'error' is an unexpected failure.
    """
    if resp is None and exc is not None:
        return "retryable"
    if resp is None:
        return "error"
    status = getattr(resp, "status_code", 0)
    body = ""
    try:
        body = resp.text or ""
    except Exception:  # noqa: BLE001
        body = ""
    low = body.lower()

    if status == 429:
        return "rate_limited"
    if status == 403 or any(m in low for m in _BLOCKED_MARKERS):
        return "blocked"
    if 500 <= status < 600:
        return "retryable"
    # 200 with an error object (Telegram returns ok:false on some failures).
    if '"ok":false' in low or '"ok": false' in low:
        if any(m in low for m in _BLOCKED_MARKERS):
            return "blocked"
        if '"error_code":429' in low:
            return "rate_limited"
        return "error"
    return "retryable" if status >= 400 else "error"


def send_message(chat_id: str, text: str, parse_mode: str = "HTML") -> bool:
    """Send a single message to a Telegram chat. Returns True on success."""
    if not chat_id or not TELEGRAM_API:
        return False
    payload = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    try:
        resp = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)
        if resp.ok:
            return True
        logger.warning(f"⚠️ Telegram notify failed ({resp.status_code}) for chat {chat_id}: {resp.text[:200]}")
    except Exception as e:
        logger.warning(f"⚠️ Telegram notify error for chat {chat_id}: {e}")
    return False


def get_chat_id_by_wallet(wallet_address: str) -> Optional[str]:
    """Reverse-lookup the most recently seen Telegram chat id for a wallet."""
    if not wallet_address:
        return None
    wallet = wallet_address.lower().strip()
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return None
    try:
        result = safe_supabase_operation(
            lambda: supabase.table('telegram_wallet_sessions')
                .select('telegram_chat_id')
                .eq('wallet_address', wallet)
                .order('last_seen_at', desc=True)
                .limit(1)
                .execute(),
            fallback_result=None,
            operation_name="lookup telegram chat_id by wallet"
        )
        if result and result.data:
            return result.data[0].get('telegram_chat_id')
    except Exception as e:
        logger.warning(f"⚠️ Could not resolve Telegram chat_id for wallet {wallet[:10]}...: {e}")
    return None


def notify_user_by_wallet(wallet_address: str, text: str, parse_mode: str = "HTML") -> bool:
    """DM the Telegram bot user linked to ``wallet_address`` (if any).

    Used to tell a user their submission was approved/rejected (daily task
    reward, GCash cashout, etc.). Never raises — a notification failure must
    not break the admin action that triggered it, and users who never linked
    Telegram simply get nothing.
    """
    try:
        chat_id = get_chat_id_by_wallet(wallet_address)
        if not chat_id:
            return False
        return send_message(str(chat_id), text, parse_mode=parse_mode)
    except Exception as e:  # noqa: BLE001 - best-effort notify
        logger.warning(f"⚠️ Per-user Telegram notify failed for wallet {str(wallet_address)[:10]}...: {e}")
        return False


def notify_user_by_wallet_async(wallet_address: str, text: str, parse_mode: str = "HTML") -> None:
    """Fire-and-forget variant of notify_user_by_wallet (daemon thread)."""
    import threading
    threading.Thread(
        target=notify_user_by_wallet,
        args=(wallet_address, text),
        kwargs={"parse_mode": parse_mode},
        daemon=True,
    ).start()


def _fetch_all_chat_ids(strict: bool = False) -> List[str]:
    """Return de-duplicated Telegram chat_ids of every linked bot user.

    Reads from ``telegram_wallet_sessions`` (the same table the webhook writes
    when a Telegram user links a wallet). Uses the service-role client so RLS
    on the anon key can never silently hide users.

    With ``strict=True`` a failed query raises instead of returning [] — the
    durable queue path relies on this so an unreadable table can't masquerade
    as "no Telegram users" and silently drop the whole broadcast.
    """
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        if strict:
            raise RuntimeError("database unavailable")
        return []
    result = safe_supabase_operation(
        lambda: supabase.table('telegram_wallet_sessions')
            .select('telegram_chat_id')
            .not_.is_('telegram_chat_id', 'null')
            .neq('telegram_chat_id', '')
            .execute(),
        fallback_result=None,
        operation_name="fetch telegram chat ids for broadcast"
    )
    if result is None and strict:
        raise RuntimeError("could not fetch telegram chat ids (see log above)")
    chat_ids: List[str] = []
    seen = set()
    for row in (result.data if result and result.data else []):
        cid = row.get('telegram_chat_id')
        if cid and cid not in seen:
            seen.add(cid)
            chat_ids.append(str(cid))
    return chat_ids


def queue_broadcast_deliveries(broadcast_id, title: str, message: str) -> Dict[str, Any]:
    """Queue one ``telegram_broadcast_deliveries`` row per Telegram user.

    Idempotent: re-running for the same broadcast only adds chat_ids that were
    not queued before (via ON CONFLICT do-nothing). Stamps the broadcast's
    aggregate ``tg_status='pending'`` and ``tg_total`` so the delivery scheduler
    picks it up. Returns a summary dict.

    The admin endpoint calls this and then wakes the delivery scheduler; the
    actual sends happen in the background, decoupled from the request lifetime
    so gunicorn worker recycling can never kill a half-finished broadcast.

    Raises ``RuntimeError`` when the queue cannot be persisted (database down,
    migration not applied, RLS denying writes, missing bot token) so the caller
    can fall back to the legacy best-effort send — a silent no-op here would
    mean zero Telegram users ever receive the broadcast.
    """
    summary = {"broadcast_id": broadcast_id, "total": 0, "queued": 0}
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        raise RuntimeError("database unavailable")
    if not TELEGRAM_API:
        raise RuntimeError("TELEGRAM_BOT_TOKEN not configured")

    chat_ids = _fetch_all_chat_ids(strict=True)
    summary["total"] = len(chat_ids)

    if not chat_ids:
        # No Telegram users yet — mark the broadcast as fully "sent" (nothing
        # to deliver) so the admin sees a finished status instead of pending.
        now = _now_iso()
        safe_supabase_operation(
            lambda: supabase.table('admin_broadcast_messages')
                .update({
                    'tg_status': 'sent',
                    'tg_total': 0,
                    'tg_sent': 0,
                    'tg_failed': 0,
                    'tg_queued_at': now,
                    'tg_delivered_at': now,
                })
                .eq('id', broadcast_id)
                .execute(),
            fallback_result=None,
            operation_name="mark broadcast sent (no telegram users)",
        )
        logger.info("📢 Telegram broadcast %s: no Telegram users to notify", broadcast_id)
        return summary

    # Insert one row per recipient. ON CONFLICT (broadcast_id, telegram_chat_id)
    # DO NOTHING makes this safe to re-run (e.g. if the admin re-queues). Use
    # the PostgREST upsert with on_conflict so it maps to INSERT ... ON CONFLICT.
    rows = [{"broadcast_id": broadcast_id, "telegram_chat_id": cid} for cid in chat_ids]
    insert_result = safe_supabase_operation(
        lambda: supabase.table('telegram_broadcast_deliveries')
            .upsert(rows, on_conflict='broadcast_id,telegram_chat_id')
            .execute(),
        fallback_result=None,
        operation_name="queue telegram broadcast deliveries",
    )
    if insert_result is None:
        # Typically: sql/telegram_broadcast_deliveries.sql not applied yet, or
        # RLS denying the write. Raising lets the caller fall back to the
        # legacy direct send instead of reporting success with zero sends.
        raise RuntimeError(
            "could not queue telegram broadcast deliveries — is the "
            "telegram_broadcast_deliveries migration applied?"
        )
    inserted = len(insert_result.data) if getattr(insert_result, "data", None) else 0
    summary["queued"] = inserted

    # Stamp the broadcast aggregate as pending + total so the scheduler picks it.
    now = _now_iso()
    stamp_result = safe_supabase_operation(
        lambda: supabase.table('admin_broadcast_messages')
            .update({
                'tg_status': 'pending',
                'tg_total': len(chat_ids),
                'tg_queued_at': now,
            })
            .eq('id', broadcast_id)
            .execute(),
        fallback_result=None,
        operation_name="mark broadcast pending delivery",
    )
    if stamp_result is None:
        # Without the tg_status stamp the scheduler never sees this broadcast —
        # the queued rows would sit forever. Fail loudly so the caller falls
        # back to the legacy direct send.
        raise RuntimeError(
            "could not stamp broadcast tg_status — is the tg_* migration applied?"
        )

    logger.info(
        "📢 Telegram broadcast %s queued %d recipient(s) (inserted %d new)",
        broadcast_id, len(chat_ids), inserted,
    )
    return summary


def _claim_pending_deliveries(broadcast_id, limit: int) -> List[Dict[str, Any]]:
    """Atomically claim up to ``limit`` pending deliveries for a broadcast.

    Flips status pending -> sending via a CAS update (.eq("status","pending"))
    so two concurrent workers/scheduler runs can never send to the same chat.
    Returns the claimed rows.
    """
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return []

    # Select-then-update is racy across workers, but PostgREST has no native
    # RETURNING-on-conditional-update. The status CAS is the correctness guard:
    # even if two runs SELECT the same rows, only the winner flips each row to
    # 'sending'. We re-read only the rows we won.
    pending = safe_supabase_operation(
        lambda: supabase.table('telegram_broadcast_deliveries')
            .select('id, telegram_chat_id, broadcast_id, attempts')
            .eq('broadcast_id', broadcast_id)
            .eq('status', 'pending')
            .order('id', desc=False)
            .limit(limit)
            .execute(),
        fallback_result=None,
        operation_name="select pending broadcast deliveries",
    )
    rows = pending.data if pending and pending.data else []
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    won = safe_supabase_operation(
        lambda: supabase.table('telegram_broadcast_deliveries')
            .update({'status': 'sending', 'updated_at': _now_iso()})
            .in_('id', ids)
            .eq('status', 'pending')
            .execute(),
        fallback_result=None,
        operation_name="claim broadcast deliveries (CAS)",
    )
    won_ids = set()
    if won and getattr(won, "data", None):
        won_ids = {r["id"] for r in won.data}
    # Only the rows we actually flipped to 'sending' are ours to send now.
    return [r for r in rows if r["id"] in won_ids] if won_ids else []


def _reclaim_stale_sending(broadcast_id, stale_after_seconds: int = _STALE_CLAIM_SECONDS) -> int:
    """Flip 'sending' rows idle longer than ``stale_after_seconds`` back to 'pending'.

    A worker that claims rows (pending -> sending) and is then killed mid-batch
    (gunicorn max_requests recycle / graceful timeout — the very failure this
    durable path exists for) would otherwise leave those rows stuck in
    'sending' forever: nothing re-claims them and the broadcast stays
    'partially_sent' until the 48h age bound expires. Returns rows reclaimed.
    """
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_after_seconds)).isoformat()
    res = safe_supabase_operation(
        lambda: supabase.table('telegram_broadcast_deliveries')
            .update({'status': 'pending', 'updated_at': _now_iso()})
            .eq('broadcast_id', broadcast_id)
            .eq('status', 'sending')
            .lt('updated_at', cutoff)
            .execute(),
        fallback_result=None,
        operation_name="reclaim stale sending deliveries",
    )
    reclaimed = len(res.data) if res and getattr(res, "data", None) else 0
    if reclaimed:
        logger.warning(
            "♻️ Telegram broadcast %s: reclaimed %d stale 'sending' row(s) (worker died mid-batch)",
            broadcast_id, reclaimed,
        )
    return reclaimed


def _broadcast_text(title: str, message: str) -> str:
    return f"📢 <b>{html.escape(title)}</b>\n\n{html.escape(message)}"


def _fetch_broadcast_payload(broadcast_id) -> Optional[Dict[str, str]]:
    """Read the title/message for a broadcast (kept out of claim loop for clarity)."""
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return None
    res = safe_supabase_operation(
        lambda: supabase.table('admin_broadcast_messages')
            .select('title, message')
            .eq('id', broadcast_id)
            .limit(1)
            .execute(),
        fallback_result=None,
        operation_name="fetch broadcast payload",
    )
    if res and res.data:
        return {"title": res.data[0].get("title", ""), "message": res.data[0].get("message", "")}
    return None


def deliver_broadcast_once(broadcast_id, batch_limit: int = 50) -> Dict[str, Any]:
    """Drain up to ``batch_limit`` pending deliveries for one broadcast.

    Sends each via the Telegram Bot API, classifies the outcome, and writes the
    final per-recipient status. Recomputes the broadcast's aggregate stats
    (tg_sent/tg_failed/tg_status/tg_delivered_at) afterwards so the admin
    dashboard reflects progress. Idempotent and safe across workers.
    """
    summary = {"broadcast_id": broadcast_id, "processed": 0, "sent": 0, "failed": 0, "blocked": 0}
    if not TELEGRAM_API:
        logger.warning("⚠️ Telegram broadcast delivery skipped: TELEGRAM_BOT_TOKEN not configured")
        return summary
    payload = _fetch_broadcast_payload(broadcast_id)
    if not payload:
        logger.warning("⚠️ Telegram broadcast %s: payload not found", broadcast_id)
        return summary
    text = _broadcast_text(payload["title"], payload["message"])

    # Recover rows orphaned by a worker that died mid-batch before claiming anew.
    _reclaim_stale_sending(broadcast_id)

    rows = _claim_pending_deliveries(broadcast_id, batch_limit)
    summary["processed"] = len(rows)
    if not rows:
        # Nothing to deliver right now — still refresh aggregates so a fully
        # delivered broadcast flips to 'sent'.
        _refresh_broadcast_aggregates(broadcast_id)
        return summary

    supabase = get_supabase_admin_client() or get_supabase_client()
    now = _now_iso()
    for row in rows:
        cid = str(row.get("telegram_chat_id") or "")
        row_id = row.get("id")
        next_attempt = (row.get("attempts") or 0) + 1
        outcome = _send_one(cid, text)
        status = outcome["status"]
        # Escalate transient failures to permanent after the retry cap so the
        # scheduler doesn't spin forever on a chronically-broken chat. A
        # blocked chat is already permanent; 'sent' is terminal-success.
        if status == "retryable" and next_attempt >= _MAX_RETRY_ATTEMPTS:
            status = "failed"
        if status == "sent":
            summary["sent"] += 1
        elif status == "blocked":
            summary["blocked"] += 1
            summary["failed"] += 1
        elif status == "failed":
            summary["failed"] += 1
        else:
            # Still retryable — leave as 'pending' so the next run retries it.
            summary["failed"] += 1

        if supabase and row_id is not None:
            update_cols = {
                "status": "pending" if status == "retryable" else status,
                "attempts": next_attempt,
                "last_error": outcome.get("error"),
                "updated_at": now,
            }
            if status == "sent":
                update_cols["delivered_at"] = now
            safe_supabase_operation(
                lambda: supabase.table('telegram_broadcast_deliveries')
                    .update(update_cols)
                    .eq('id', row_id)
                    .execute(),
                fallback_result=None,
                operation_name="update broadcast delivery row",
            )
        if _BROADCAST_SEND_DELAY_SECONDS > 0:
            time.sleep(_BROADCAST_SEND_DELAY_SECONDS)

    _refresh_broadcast_aggregates(broadcast_id)
    logger.info(
        "📢 Telegram broadcast %s: processed %d (sent=%d failed=%d blocked=%d)",
        broadcast_id, summary["processed"], summary["sent"], summary["failed"], summary["blocked"],
    )
    return summary


def _send_one(chat_id: str, text: str) -> Dict[str, Any]:
    """Send one message, returning {status, error} where status is sent/blocked/retryable/error."""
    if not chat_id or not TELEGRAM_API:
        return {"status": "blocked", "error": "no chat_id or token"}
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    try:
        resp = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)
        if resp.ok:
            return {"status": "sent", "error": None}
        kind = classify_send_error(resp=resp)
        return {"status": "blocked" if kind == "blocked" else "retryable", "error": f"{resp.status_code}: {resp.text[:160]}"}
    except Exception as e:  # noqa: BLE001
        kind = classify_send_error(exc=e)
        return {"status": "blocked" if kind == "blocked" else "retryable", "error": str(e)[:160]}


def _refresh_broadcast_aggregates(broadcast_id) -> None:
    """Recompute tg_sent/tg_failed/tg_status/tg_delivered_at for a broadcast.

    Called after each delivery pass. Flips tg_status to 'sent' once there are
    no rows left in pending/sending, or 'partially_sent' if some are still
    outstanding (transient failures stay 'retryable' and get retried next run).
    """
    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        return
    try:
        res = supabase.table('telegram_broadcast_deliveries')\
            .select('status')\
            .eq('broadcast_id', broadcast_id)\
            .execute()
        statuses = [r.get("status") for r in (res.data if res and res.data else [])]
        sent = sum(1 for s in statuses if s == "sent")
        failed = sum(1 for s in statuses if s in ("failed", "blocked"))
        pending = sum(1 for s in statuses if s in ("pending", "sending", "retryable"))
        total = len(statuses)
        if pending == 0:
            tg_status = "sent" if failed == 0 else "failed"
        else:
            tg_status = "partially_sent" if sent > 0 else "pending"
        now = _now_iso()
        update_cols = {
            "tg_total": total,
            "tg_sent": sent,
            "tg_failed": failed,
            "tg_status": tg_status,
        }
        if pending == 0:
            update_cols["tg_delivered_at"] = now
        supabase.table('admin_broadcast_messages')\
            .update(update_cols)\
            .eq('id', broadcast_id)\
            .execute()
    except Exception as e:  # noqa: BLE001
        logger.warning("⚠️ Could not refresh broadcast %s aggregates: %s", broadcast_id, e)


def broadcast_message(title: str, message: str) -> Dict[str, Any]:
    """Back-compat best-effort broadcast. New code should queue via the durable path.

    Kept so older callers (and tests) that hit ``broadcast_message`` directly
    still work. It does NOT track per-recipient durability — for the admin
    broadcast feature, the durable queue + scheduler is used instead.
    """
    summary = {"total": 0, "sent": 0, "failed": 0}
    if not TELEGRAM_API:
        logger.warning("⚠️ Telegram broadcast skipped: TELEGRAM_BOT_TOKEN not configured")
        return summary
    chat_ids = _fetch_all_chat_ids()
    summary["total"] = len(chat_ids)
    if not chat_ids:
        logger.info("📢 Telegram broadcast: no Telegram users to notify")
        return summary
    text = _broadcast_text(title, message)
    for cid in chat_ids:
        if send_message(cid, text):
            summary["sent"] += 1
        else:
            summary["failed"] += 1
        if _BROADCAST_SEND_DELAY_SECONDS > 0:
            time.sleep(_BROADCAST_SEND_DELAY_SECONDS)
    logger.info("📢 Telegram broadcast delivered: sent=%s failed=%s total=%s",
                summary["sent"], summary["failed"], summary["total"])
    return summary


def broadcast_message_async(broadcast_id=None, title: str = "", message: str = "") -> str:
    """Queue a durable broadcast delivery and wake the scheduler.

    Called from the admin endpoint with the freshly-inserted broadcast_id.
    The actual sends happen in the background scheduler (``broadcast_delivery``),
    decoupled from the request lifetime so a gunicorn worker recycle mid-broadcast
    can no longer swallow the delivery.

    Falls back to the legacy best-effort fire-and-forget send whenever the
    durable path cannot deliver: no broadcast_id, the delivery scheduler is
    disabled (TELEGRAM_BROADCAST_DELIVERY_ENABLED unset), or queueing failed
    (migration not applied / RLS denying writes). Queueing into a void while
    the scheduler is off would silently deliver to nobody.

    Returns which path was taken — "durable_queued" or "legacy_best_effort" —
    so the admin endpoint can surface it instead of claiming blind success.
    """
    if broadcast_id is not None:
        if _delivery_scheduler_enabled():
            try:
                queue_broadcast_deliveries(broadcast_id, title, message)
                _wake_delivery_scheduler()
                return "durable_queued"
            except Exception as e:  # noqa: BLE001
                logger.warning("⚠️ Durable broadcast queue failed, falling back to best-effort: %s", e)
        else:
            logger.info(
                "📢 Telegram broadcast delivery scheduler disabled "
                "(TELEGRAM_BROADCAST_DELIVERY_ENABLED not set) — using best-effort direct send"
            )
    # Legacy fire-and-forget fallback.
    import threading
    threading.Thread(
        target=broadcast_message,
        args=(title, message),
        daemon=True,
        name="telegram-broadcast",
    ).start()
    return "legacy_best_effort"


def _delivery_scheduler_enabled() -> bool:
    """True when the durable delivery scheduler is configured to run.

    Imported lazily so telegram_notify has no hard dep on the scheduler module
    (avoids a cycle); a missing module is treated as disabled.
    """
    try:
        from broadcast_delivery import is_delivery_enabled
        return bool(is_delivery_enabled())
    except Exception:  # noqa: BLE001
        return False


def _wake_delivery_scheduler() -> None:
    """Best-effort wake of the delivery scheduler so a fresh broadcast is sent
    almost immediately instead of waiting for the next poll. Imported lazily so
    telegram_notify has no hard dep on the scheduler module (avoids a cycle)."""
    try:
        from broadcast_delivery import wake_broadcast_delivery
        wake_broadcast_delivery()
    except Exception:  # noqa: BLE001
        pass


def count_broadcast_recipients() -> int:
    """How many Telegram chat_ids a broadcast would target right now.

    Returns -1 when the recipient list cannot be read (DB down / RLS denying),
    so callers can tell "zero users" apart from "couldn't check".
    """
    try:
        return len(_fetch_all_chat_ids(strict=True))
    except Exception as e:  # noqa: BLE001
        logger.warning("⚠️ Could not count Telegram broadcast recipients: %s", e)
        return -1


def get_broadcast_diagnostics() -> Dict[str, Any]:
    """Never-raises health check of every link in the Telegram broadcast chain.

    Built so "the bot isn't receiving broadcasts" stops being a guessing game:
    each check maps to one concrete failure (missing token, unreadable sessions
    table, missing migration, scheduler off) and produces a human hint.
    """
    diag: Dict[str, Any] = {
        "bot_token_configured": bool(TELEGRAM_API),
        "service_role_key_configured": bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY")),
        "delivery_scheduler_enabled": _delivery_scheduler_enabled(),
    }
    hints: List[str] = []

    if not diag["bot_token_configured"]:
        hints.append("Set TELEGRAM_BOT_TOKEN — without it no Telegram message can be sent.")

    supabase = get_supabase_admin_client() or get_supabase_client()
    diag["database_available"] = bool(supabase)
    if not supabase:
        hints.append("Database unavailable — check SUPABASE_URL / SUPABASE_KEY.")
    else:
        # 1) Can we read the recipient list, and how many are there?
        try:
            diag["telegram_recipients"] = len(_fetch_all_chat_ids(strict=True))
            if diag["telegram_recipients"] == 0:
                hints.append(
                    "0 Telegram recipients — telegram_wallet_sessions has no usable chat_ids. "
                    "Users must /start the bot AND send their wallet address before they can "
                    "receive broadcasts."
                )
        except Exception as e:  # noqa: BLE001
            diag["telegram_recipients"] = None
            diag["telegram_recipients_error"] = str(e)[:200]
            hints.append(
                "Could not read telegram_wallet_sessions — if SUPABASE_SERVICE_ROLE_KEY is "
                "unset, RLS may be blocking the read. Set the service-role key."
            )
        # 2) Is the durable delivery migration applied?
        try:
            supabase.table('telegram_broadcast_deliveries').select('id').limit(1).execute()
            diag["deliveries_table_ready"] = True
        except Exception as e:  # noqa: BLE001
            diag["deliveries_table_ready"] = False
            diag["deliveries_table_error"] = str(e)[:200]
            hints.append("Run sql/telegram_broadcast_deliveries.sql in the Supabase SQL editor.")
        try:
            supabase.table('admin_broadcast_messages').select('tg_status').limit(1).execute()
            diag["broadcast_tg_columns_ready"] = True
        except Exception as e:  # noqa: BLE001
            diag["broadcast_tg_columns_ready"] = False
            diag["broadcast_tg_columns_error"] = str(e)[:200]
            if diag.get("deliveries_table_ready"):
                hints.append("Run sql/telegram_broadcast_deliveries.sql (tg_* columns missing).")

    if not diag["delivery_scheduler_enabled"]:
        hints.append(
            "TELEGRAM_BROADCAST_DELIVERY_ENABLED is not set — broadcasts use the legacy "
            "in-request thread, which the server can kill mid-send. Enable it (and run the "
            "SQL migration) for durable delivery."
        )
    elif supabase and not diag.get("deliveries_table_ready", True):
        hints.append("Scheduler is enabled but the delivery table is missing — nothing will be drained.")

    diag["hints"] = hints
    diag["ready"] = (
        diag["bot_token_configured"]
        and diag["database_available"]
        and bool(diag.get("telegram_recipients"))
    )
    return diag
