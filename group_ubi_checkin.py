"""Group UBI check-in reward — daily custom messages.

Anti-spam / anti-farming design (user's revision):
  1. A scheduler (``init_checkin_scheduler``) DMs every linked bot member
     EVERY DAY at 11:30 AM Philippine time (03:30 UTC — the Philippines has
     no DST) a randomly-picked custom message from a pool of 100
     (``_CHECKIN_MESSAGES``), plus an inline "📋 Copy message" button.
  2. The bot only READS group messages — it recongnizes the phrase there.
     Replies go EXCLUSIVELY to the member's private chat (PM). The bot never
     posts in the group, and non-linked users get ZERO response.
  3. The member copies the day's message and posts it anywhere (e.g.
     t.me/GoodDollarX). The first phrase match creates a reward row; the
     receiver's wallet gets the G$ transfer from DAILYTASK_KEY and a success
     PM arrives within a minute or two.
  4. ``UNIQUE (wallet_address, payout_date)`` in ``group_ubi_checkin_log``
     guarantees once-per-day; 24h setback is enforced by date, so a member
     can only complete one check-in per UTC day. The same-day re-post gets a
     "You already completed today's check-in" PM.
  5. Disbursement reuses ``telegram_daily_reward.send_daily_reward_gd``
     (fixed 250k gas, CELO+G$ preflights) plus ``check_reward_tx_status`` so
     a prior broadcast is verified on-chain BEFORE any re-send.

Env knobs (all optional unless noted):
    GROUP_UBI_CHECKIN_ENABLED             – "1"/"true" to enable (default off)
    GROUP_UBI_CHECKIN_AMOUNT_GD           – G$ per check-in (default 50)
    GROUP_UBI_CHECKIN_UTC_HOUR            – fire hour, 0-23 (default 3 = 11:30 AM PHT)
    GROUP_UBI_CHECKIN_UTC_MINUTE          – fire minute (default 30)
    GROUP_UBI_CHECKIN_POLL_SECONDS        – scheduler wake interval (default 300)
    GROUP_UBI_CHECKIN_MAX_RETRY_ATTEMPTS  – attempts before 'failed' (default 5)
    GROUP_UBI_CHECKIN_STALE_CLAIM_SECONDS – reclaim stuck 'sending' (default 600)
    GROUP_UBI_CHECKIN_MESSAGE             – success-message override; supports
                                            {name}, {amount}, {explorer_url}
    DAILYTASK_KEY                         – sender wallet (G$ balance + CELO gas)
    TELEGRAM_BOT_TOKEN                    – shared with the bot

Requires ``sql/group_ubi_checkin.sql`` to be applied in Supabase first.
"""
import html
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from env_utils import get_env_float, get_env_int

logger = logging.getLogger(__name__)

_ENABLED = os.getenv("GROUP_UBI_CHECKIN_ENABLED", "").lower() in ("1", "true", "yes", "on")
_AMOUNT_GD = get_env_float("GROUP_UBI_CHECKIN_AMOUNT_GD", 50.0)
_UTC_HOUR = get_env_int("GROUP_UBI_CHECKIN_UTC_HOUR", 3)
_UTC_MINUTE = get_env_int("GROUP_UBI_CHECKIN_UTC_MINUTE", 30)
_POLL_SECONDS = get_env_int("GROUP_UBI_CHECKIN_POLL_SECONDS", 300)
_MAX_RETRY_ATTEMPTS = get_env_int("GROUP_UBI_CHECKIN_MAX_RETRY_ATTEMPTS", 5)
_STALE_CLAIM_SECONDS = get_env_int("GROUP_UBI_CHECKIN_STALE_CLAIM_SECONDS", 600)

# ── 100 custom check-in messages ───────────────────────────────────────────
# Crypto/UBI/GoodMarket themed. The scheduler picks one per member per day
# (random), so two members in a class share fewer duplicates. Keep ALL of
# these English.
_CHECKIN_MESSAGES = [
    "I claim my UBI today with GoodMarket.",
    "UBI is part of my daily lives now.",
    "GoodDollar is the best, and GoodMarket is my strategy to earn more G$.",
    "Another day, another UBI reward with GoodDollar.",
    "I feel happy earning UBI every single day with GoodDollar.",
    "G$ rewards keep my GoodMarket journey fun.",
    "UBI claim complete — thanks GoodDollar and GoodMarket.",
    "My UBI check-in is done for today with GoodDollar.",
    "GoodMarket makes my daily UBI claim feel rewarding.",
    "I rely on GoodDollar to keep my UBI streak alive.",
    "I love getting UBI with GoodMarket every day.",
    "I take my UBI every day with GoodDollar.",
    "GoodDollar fuels my daily UBI income.",
    "UBI helps me everyday thanks to GoodDollar.",
    "I check my UBI status every morning.",
    "Claiming UBI never gets old with GoodDollar.",
    "UBI helps my family daily thanks to GoodDollar.",
    "Every day I receive UBI, thanks to GoodDollar.",
    "I appreciate daily UBI income from GoodDollar.",
    "GoodDollar is my daily UBI engine.",
    "My UBI arrived again thanks to GoodDollar.",
    "GoodMarket is my favorite UBI place.",
    "UBI rewards motivate me daily thanks to GoodDollar.",
    "I'm grateful for my daily UBI with GoodDollar.",
    "UBI check-in complete — thanks GoodDollar.",
    "GoodDollar keeps my UBI flowing every day.",
    "I earned my daily UBI with GoodDollar today.",
    "UBI is my favorite daily reward with GoodDollar.",
    "My gratitude goes to GoodDollar for today's UBI.",
    "Today I received my UBI as always with GoodDollar.",
    "I'm thankful for UBI with GoodDollar.",
    "UBI income solves my daily needs thanks to GoodDollar.",
    "Every check-in brings UBI thanks to GoodDollar.",
    "I enjoy claiming UBI with GoodDollar every day.",
    "My UBI claim is complete — thanks GoodDollar.",
    "UBI check-in done with GoodDollar today.",
    "I rely on my UBI with GoodDollar daily.",
    "Today's UBI helps me a lot, thanks to GoodDollar.",
    "I feel supported by my UBI, courtesy of GoodDollar.",
    "UBI check-in complete with GoodDollar for today.",
    "GoodDollar helps my daily UBI goal.",
    "I take my daily UBI from GoodDollar every day.",
    "UBI is my saving grace thanks to GoodDollar.",
    "I claim UBI daily with GoodMarket every day.",
    "UBI check-in goes well today thanks to GoodDollar.",
    "Today UBI arrived, thanks to GoodDollar.",
    "I earned my UBI today with GoodDollar.",
    "My daily goal is UBI, thanks to GoodDollar.",
    "UBI speaks my daily needs, thanks to GoodDollar.",
    "UBI with GoodDollar is easy to get.",
    "My UBI arrived today, thanks to GoodDollar.",
    "I check in for UBI with GoodDollar.",
    "UBI makes my day complete, thanks to GoodDollar.",
    "GoodDollar gives me daily support.",
    "UBI check-in success with GoodDollar.",
    "UBI keeps me rewarded every day with GoodDollar.",
    "I'm getting my UBI with GoodDollar today.",
    "I love my daily UBI with GoodDollar.",
    "GoodDollar rewards my UBI every day.",
    "UBI is my income with GoodDollar.",
    "GoodDollar completes my daily UBI check-in.",
    "UBI delivers my daily reward with GoodDollar.",
    "My daily UBI with GoodDollar is a real gift.",
    "UBI is game-changer with GoodDollar.",
    "I take my UBI with GoodDollar every day.",
    "GoodDollar delivers my UBI daily.",
    "UBI rewards support my daily needs with GoodDollar.",
    "I'm on track with my UBI, thanks to GoodDollar.",
    "Today's UBI is from GoodDollar as usual.",
    "UBI is my daily money with GoodDollar.",
    "UBI is my daily income habit with GoodDollar.",
    "Thank you GoodDollar for today's UBI.",
    "I'm receiving UBI with GoodDollar every day.",
    "Today's UBI is a gift from GoodDollar.",
    "UBI check-in complete thanks to GoodDollar.",
    "GoodDollar delivers my daily UBI habit.",
    "I earned my daily UBI with GoodDollar.",
    "My UBI routine with GoodDollar pays off.",
    "UBI makes my day thanks to GoodDollar.",
    "GoodDollar helps with my daily UBI claim.",
    "GoodDollar is my daily cash habit.",
    "My UBI claim with GoodDollar is complete today.",
    "UBI is my daily reward thanks to GoodDollar.",
    "I enjoy the daily UBI with GoodDollar a lot.",
    "UBI keeps me going with GoodDollar every day.",
    "I'm able to check in for UBI with GoodDollar.",
    "UBI gives my daily income with GoodDollar.",
    "I receive daily UBI from GoodDollar always.",
    "GoodDollar answers my daily UBI needs.",
    "UBI is my daily source of income with GoodDollar.",
    "I check in daily for UBI with GoodDollar.",
    "UBI is my daily task with GoodDollar.",
    "GoodDollar makes every UBI count.",
    "I enjoy UBI with GoodDollar the most on.",
    "UBI is my daily thanks to GoodDollar every day.",
    "UBI is my daily fun with GoodDollar.",
    "I take UBI with GoodDollar every single day.",
    "GoodDollar has my UBI every day.",
    "I like my daily UBI with GoodDollar.",
    "UBI keeps me happy every day thanks to GoodDollar.",
]

# ── English PM message templates ───────────────────────────────────────────

_DUPLICATE_MESSAGE = (
    "ℹ️ You already completed today's UBI check-in and received <b>{amount} "
    "G$</b>. Come back tomorrow for the next message! 😉"
)

_PROCESSING_MESSAGE = (
    "⏳ Your earlier check-in is still being processed — please give it a "
    "moment."
)

_QUEUED_MESSAGE = (
    "⏳ The reward wallet needs a top-up right now, so your check-in is "
    "queued. Post the message again after the admin refills it, and the "
    "reward will land."
)

_UNCONFIRMED_MESSAGE = (
    "⏳ Your reward transaction was broadcast but is still confirming "
    "on-chain. It will complete shortly — no need to re-post."
)

_RETRY_MESSAGE = (
    "⚠️ The check-in hit a snag ({error}). Post the message again to retry."
)

_FAILED_MESSAGE = (
    "⚠️ Today's check-in could not be completed ({error}). Please contact "
    "support."
)

_DB_ERROR_MESSAGE = (
    "⚠️ I couldn't record your check-in right now (database error). Please "
    "try again in a moment."
)

_DEFAULT_SUCCESS_MESSAGE = (
    "🎉 <b>UBI check-in reward sent!</b>\n\n"
    "<b>{amount} G$</b> has been sent to your linked wallet. 💛\n\n"
    "Thanks for staying active — see you tomorrow for the next check-in "
    "message!\n\n"
    "🔗 View transaction: {explorer_url}"
)

_DAILY_MESSAGE_HEADER = (
    "💬 <b>Your UBI check-in message for today:</b> Tap the button below, "
    "copy it, then paste it in the group (e.g. t.me/GoodDollarX) to complete "
    "today's check-in!"
)

_COPY_BUTTON_LABEL = "📋 Copy message"


def _fill(template: str, **values) -> str:
    """Substitute {name}/{amount}/{error}/{explorer_url} via str.replace."""
    text = template
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return text


def _format_amount(amount: float) -> str:
    return ("%f" % float(amount)).rstrip("0").rstrip(".")


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalized_match(text: str) -> bool:
    """True when the message equals/detects one of the pool messages after
    normalizing whitespace + case. A pool hit is the phrase trigger."""
    normalized = " ".join((text or "").lower().split())
    minimized = set()
    for msg in _CHECKIN_MESSAGES:
        mini = " ".join(msg.lower().split())
        if mini not in minimized:
            minimized.add(mini)
            if mini in normalized:
                return True
    return False


def _display_name(user: dict) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    username = (user.get("username") or "").strip()
    raw = (first + " " + last).strip() or username or "friend"
    return html.escape(raw)


# ── Lazy helpers (keep module import dep-free for tests) ───────────────────

def _get_supabase():
    from supabase_client import get_supabase_admin_client, get_supabase_client
    return get_supabase_admin_client() or get_supabase_client()


def _send_telegram_message(chat_id, text: str, reply_markup=None) -> bool:
    """Lazy wrapper so this module imports without telegram_notify blocking.
    Interpolates reply_markup when the helper supports it."""
    try:
        from telegram_notify import send_message
        if reply_markup is not None:
            try:
                return send_message(chat_id, text, reply_markup=reply_markup)
            except TypeError:
                # telegram_notify.send_message doesn't accept reply_markup — fall back
                return send_message(chat_id, text)
        return send_message(chat_id, text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Group check-in: Telegram reply failed for chat %s: %s", chat_id, exc)
        return False


def _send_reward(wallet: str, amount: float) -> dict:
    from telegram_daily_reward import send_daily_reward_gd
    return send_daily_reward_gd(wallet, amount)


def _check_tx_status(tx_hash: str) -> str:
    from telegram_daily_reward import check_reward_tx_status
    return check_reward_tx_status(tx_hash)


def _lookup_saved_wallet_and_chat_id(telegram_user_id):
    """Return (wallet_address, telegram_chat_id) for the sender. The chat ID
    is the user's DM with the bot so replies are PM-only."""
    if not telegram_user_id:
        return None, None
    try:
        supabase = _get_supabase()
        if not supabase:
            return None, None
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("wallet_address, telegram_chat_id")
            .eq("telegram_user_id", str(telegram_user_id))
            .limit(1)
            .execute()
        )
        data = getattr(result, "data", None) or []
        if data:
            row = data[0]
            return (row.get("wallet_address") or "").strip().lower(), row.get("telegram_chat_id")
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Group check-in: wallet lookup failed for user %s: %s", telegram_user_id, exc)
    return None, None


# ── Log-table helpers ──────────────────────────────────────────────────────

def _fetch_todays_row(wallet: str, today: str):
    supabase = _get_supabase()
    if not supabase:
        return None
    try:
        result = (
            supabase.table("group_ubi_checkin_log")
            .select("*")
            .eq("wallet_address", (wallet or "").strip().lower())
            .eq("payout_date", today)
            .limit(1)
            .execute()
        )
        data = getattr(result, "data", None) or []
        return data[0] if data else None
    except Exception:  # noqa: BLE001
        return None


def _create_pending_row(wallet: str, telegram_user_id, chat_id, message_text: str, today: str):
    supabase = _get_supabase()
    if not supabase:
        return None
    payload = {
        "wallet_address": (wallet or "").strip().lower(),
        "payout_date": today,
        "telegram_user_id": str(telegram_user_id or ""),
        "telegram_chat_id": str(chat_id or ""),
        "message_text": (message_text or "")[:500],
        "amount_gd": _AMOUNT_GD,
        "status": "pending",
    }
    try:
        result = supabase.table("group_ubi_checkin_log").insert(payload).execute()
        data = getattr(result, "data", None) or []
        return data[0] if data else None
    except Exception:  # noqa: BLE001
        return None


def _claim_row(row: dict) -> bool:
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("group_ubi_checkin_log")
            .update({
                "status": "sending",
                "attempts": int(row.get("attempts") or 0) + 1,
                "updated_at": _now_iso(),
            })
            .eq("id", row["id"])
            .eq("status", "pending")
            .execute()
        )
        return bool(getattr(result, "data", None))
    except Exception:  # noqa: BLE001
        return False


def _reclaim_if_stale(row: dict) -> bool:
    updated = row.get("updated_at") or ""
    try:
        updated_ts = datetime.fromisoformat(updated.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return False
    if updated_ts.tzinfo is None:
        updated_ts = updated_ts.replace(tzinfo=timezone.utc)
    if (datetime.now(timezone.utc) - updated_ts).total_seconds() < _STALE_CLAIM_SECONDS:
        return False
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("group_ubi_checkin_log")
            .update({"status": "pending", "updated_at": _now_iso()})
            .eq("id", row["id"])
            .eq("status", "sending")
            .execute()
        )
        return bool(getattr(result, "data", None))
    except Exception:  # noqa: BLE001
        return False


def _update_row(row_id, fields: dict) -> None:
    supabase = _get_supabase()
    if not supabase:
        return
    fields["updated_at"] = _now_iso()
    try:
        supabase.table("group_ubi_checkin_log").update(fields).eq("id", row_id).execute()
    except Exception:  # noqa: BLE001
        return


# ── Daily DM scheduler ────────────────────────────────────────────────────

_pick_msg_lock = threading.Lock()


def _pick_message_for_user(wallet: str, utc_date_iso: str) -> str:
    """Deterministic per-user-per-day hash on the message pool — same wallet
    same day same message, different wallets rarely collide."""
    import random
    random.seed(f"{wallet}|{utc_date_iso}")
    return random.choice(_CHECKIN_MESSAGES)


def build_daily_message(message_text: str) -> str:
    """Header + the day's message (sent to DM with a copy button)."""
    return _DAILY_MESSAGE_HEADER + "\n\n" + (message_text or "")


def _fetch_eligible_sessions():
    """telegram_wallet_sessions rows with a wallet AND a chat id, deduped by
    wallet (most recently seen session wins — one DM per wallet)."""
    supabase = _get_supabase()
    if not supabase:
        return []
    try:
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("telegram_chat_id, wallet_address")
            .not_.is_("telegram_chat_id", "null")
            .neq("telegram_chat_id", "")
            .not_.is_("wallet_address", "null")
            .neq("wallet_address", "")
            .order("last_seen_at", desc=True)
            .limit(5000)
            .execute()
        )
    except Exception:  # noqa: BLE001
        return []
    seen = set()
    rows = []
    for row in (getattr(result, "data", None) or []):
        wallet = (row.get("wallet_address") or "").strip().lower()
        chat_id = str(row.get("telegram_chat_id") or "")
        if not wallet or not chat_id or wallet in seen:
            continue
        seen.add(wallet)
        rows.append({"wallet_address": wallet, "telegram_chat_id": chat_id})
    return rows


def run_checkin_delivery_once() -> dict:
    """Send the day's check-in message DM to every linked member. Returns a
    summary for tests/logging."""
    today = _today_utc()
    summary = {"date": today, "delivered": 0, "failed": 0, "total": 0}
    rows = _fetch_eligible_sessions()
    summary["total"] = len(rows)
    for row in rows:
        wallet = row["wallet_address"]
        chat_id = row["telegram_chat_id"]
        text = _pick_message_for_user(wallet, today)
        body = _DAILY_MESSAGE_HEADER + "\n\n" + text
        # Inline copy button into the DM; ``copy_text`` needs Bot API >= 6.7,
        # older clients still see the text. The button is PM-only (the bot
        # never posts into the group).
        markup = {"inline_keyboard": [[{"text": _COPY_BUTTON_LABEL, "copy_text": {"text": text}}]]}
        if _send_telegram_message(chat_id, body, reply_markup=markup):
            summary["delivered"] += 1
        else:
            summary["failed"] += 1
    logger.info("💬 Check-in delivery finished — %s", summary)
    return summary


_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()
_last_run_date = None


def _scheduler_loop():
    """Wake periodically; fire the DM pass at/after the daily UTC slot.
    After the first pass of the day, later passes are skipped."""
    global _last_run_date
    while not _scheduler_stop.is_set():
        try:
            now = datetime.now(timezone.utc)
            today = _today_utc()
            target = now.replace(hour=_UTC_HOUR, minute=_UTC_MINUTE, second=0, microsecond=0)
            due = now >= target and (_last_run_date != today)
            if due:
                summary = run_checkin_delivery_once()
                _last_run_date = today
        except Exception:  # noqa: BLE001
            logger.exception("💬 Check-in delivery scheduler crashed")
        _scheduler_stop.wait(_POLL_SECONDS)


def init_checkin_scheduler(app=None) -> bool:
    """Start the daily DM scheduler thread. Returns True if started."""
    global _scheduler_thread
    if not _ENABLED:
        logger.info("Group check-in scheduler disabled (GROUP_UBI_CHECKIN_ENABLED not set)")
        return False
    if not os.getenv("TELEGRAM_BOT_TOKEN"):
        logger.info("Group check-in scheduler disabled: TELEGRAM_BOT_TOKEN not set")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            name="group-ubi-checkin-scheduler",
            daemon=True,
        )
        _scheduler_thread.start()
        logger.info(
            "💬 Check-in DM scheduler started — daily at %02d:%02d UTC (11:30 AM PHT default)", _UTC_HOUR, _UTC_MINUTE
        )
        return True


def _finish_processing(row: dict, target_chat_id, display_name: str) -> str:
    """Run the payout and post the final PM reply. Replies go to the sender's
    DM chat id when available; falls back to the group chat id (which the
    library keeps on-file for future linking)."""
    row_id = row["id"]
    wallet = (row.get("wallet_address") or "").strip().lower()
    amount = float(row.get("amount_gd") or _AMOUNT_GD)
    attempts = int(row.get("attempts") or 0)

    # PM destination priority: the sender's stored DM chat id from the row's
    # telegram_chat_id column; fall back to whatever chat id the handler got
    # (which the handler already resolved to the DM when available).
    pm_chat_id = target_chat_id
    stored_chat_id = row.get("telegram_chat_id")
    if stored_chat_id:
        pm_chat_id = str(stored_chat_id)

    def _pm_send(template):
        return _send_telegram_message(pm_chat_id, template)

    # Verify prior broadcast before re-send.
    prior_tx = row.get("tx_hash")
    if prior_tx:
        status = _check_tx_status(prior_tx)
        if status == "confirmed":
            _update_row(row_id, {"status": "sent", "sent_at": _now_iso(), "last_error": None})
            _pm_send(build_success_message(display_name, amount, prior_tx))
            return "sent"
        if status == "pending":
            _update_row(row_id, {"status": "pending", "last_error": "prior tx still unconfirmed"})
            _pm_send(_fill(_UNCONFIRMED_MESSAGE, name=display_name))
            return "retry"
        _update_row(row_id, {"tx_hash": None, "last_error": f"prior tx reverted: {prior_tx}"})

    result = _send_reward(wallet, amount)

    if result.get("success"):
        tx_hash = result.get("tx_hash")
        _update_row(row_id, {"status": "sent", "tx_hash": tx_hash, "sent_at": _now_iso(), "last_error": None})
        _pm_send(build_success_message(display_name, amount, tx_hash))
        return "sent"

    error_type = result.get("error_type") or "error"
    error_msg = str(result.get("error") or "unknown error")[:500]

    if error_type in ("insufficient_gas", "insufficient_balance"):
        _update_row(row_id, {"status": "pending", "last_error": error_msg})
        _pm_send(_fill(_QUEUED_MESSAGE, name=display_name))
        return "retry"

    if error_type == "submitted_unconfirmed":
        _update_row(row_id, {"status": "pending", "tx_hash": result.get("tx_hash"), "last_error": error_msg})
        _pm_send(_fill(_UNCONFIRMED_MESSAGE, name=display_name))
        return "retry"

    if attempts + 1 >= _MAX_RETRY_ATTEMPTS:
        _update_row(row_id, {"status": "failed", "last_error": error_msg})
        _pm_send(_fill(_FAILED_MESSAGE, name=display_name, error=error_msg))
        return "failed"

    _update_row(row_id, {"status": "pending", "last_error": error_msg})
    _pm_send(_fill(_RETRY_MESSAGE, name=display_name, error=error_msg))
    return "retry"


def build_success_message(name: str, amount_gd: float, tx_hash: str) -> str:
    """English success PM; GROUP_UBI_CHECKIN_MESSAGE overrides the template."""
    template = os.getenv("GROUP_UBI_CHECKIN_MESSAGE") or _DEFAULT_SUCCESS_MESSAGE
    explorer_url = f"https://celoscan.io/tx/{tx_hash}" if tx_hash else ""
    return _fill(template, name=name, amount=_format_amount(amount_gd), explorer_url=explorer_url)


# ── Webhook handler ────────────────────────────────────────────────────────

def handle_group_checkin(chat_id, telegram_user: dict, text: str) -> bool:
    """Recognize the pool message in a group post and reward the linked
    wallet. Returns True to consume the message (silences the wallet fallback)."""
    if not _ENABLED:
        return False
    if not normalized_match(text):
        return False

    user_id = telegram_user.get("id")
    wallet, stored_chat_id = _lookup_saved_wallet_and_chat_id(user_id)
    if not wallet:
        # Non-linked members get zero response — the bot stays quiet.
        return True

    today = _today_utc()
    reply_chat_id = str(stored_chat_id) if stored_chat_id else str(chat_id)
    name = _display_name(telegram_user)

    row = _fetch_todays_row(wallet, today)
    if row is None:
        row = _create_pending_row(wallet, user_id, stored_chat_id, text, today)
        if row is None:
            row = _fetch_todays_row(wallet, today)
            if row is None:
                _send_telegram_message(reply_chat_id, _fill(_DB_ERROR_MESSAGE, name=name))
                return True

    status = (row.get("status") or "pending").strip().lower()

    if status == "sent":
        _send_telegram_message(reply_chat_id, _fill(_DUPLICATE_MESSAGE, name=name, amount=row.get("amount_gd") or _AMOUNT_GD))
        return True

    if status == "sending":
        if not _reclaim_if_stale(row):
            _send_telegram_message(reply_chat_id, _PROCESSING_MESSAGE)
            return True
        row["status"] = "pending"

    if status == "failed":
        _send_telegram_message(reply_chat_id, _fill(_FAILED_MESSAGE, name=name, error=row.get("last_error") or "unknown error"))
        return True

    if not _claim_row(row):
        _send_telegram_message(reply_chat_id, _PROCESSING_MESSAGE)
        return True

    threading.Thread(
        target=_finish_processing,
        args=(row, reply_chat_id, name),
        name=f"group-ubi-checkin-{row.get('id')}",
        daemon=True,
    ).start()
    return True
