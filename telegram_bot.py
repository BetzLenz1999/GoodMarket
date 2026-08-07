"""
Telegram Bot Webhook Handler
Handles incoming Telegram bot updates, saves wallet-only Telegram logins,
and keeps Learn & Earn interactions inside the Telegram chat.
"""
import os
import asyncio
import html
import json
import logging
import math
import re
import secrets
import time
import threading
import requests
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit
from flask import Blueprint, current_app, redirect, request, jsonify, session, url_for
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from config import PRODUCTION_DOMAIN
from supabase_client import get_supabase_admin_client, get_supabase_client
from news_feed import news_feed_service

logger = logging.getLogger(__name__)

telegram_bot = Blueprint("telegram_bot", __name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
TELEGRAM_WEBHOOK_SECRET_TOKEN = os.getenv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "")
TELEGRAM_LOGIN_TOKEN_MAX_AGE_SECONDS = int(os.getenv("TELEGRAM_LOGIN_TOKEN_MAX_AGE_SECONDS", "900"))
_WALLET_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
_TELEGRAM_LEARN_EARN_SESSIONS = {}
_TELEGRAM_COMMUNITY_STORIES_SESSIONS = {}
_TELEGRAM_TRUSTPILOT_SESSIONS = {}
_TELEGRAM_LEARN_EARN_LOCK = threading.RLock()
_TELEGRAM_TIMER_UPDATE_SECONDS = int(os.getenv("TELEGRAM_TIMER_UPDATE_SECONDS", "10"))
_TELEGRAM_MIN_LEARN_EARN_CONTRACT_BALANCE_GD = float(
    os.getenv("TELEGRAM_MIN_LEARN_EARN_CONTRACT_BALANCE_GD", "200")
)
_TELEGRAM_MIN_LEARN_EARN_OPERATOR_GAS_CELO = float(
    os.getenv("TELEGRAM_MIN_LEARN_EARN_OPERATOR_GAS_CELO", "0.001")
)
_TELEGRAM_LEARN_EARN_SCHEDULER_STOP = threading.Event()
_TELEGRAM_LEARN_EARN_SCHEDULER_THREAD = None
_TELEGRAM_LEARN_EARN_SCHEDULER_LOCK = threading.Lock()


def _run_async(coro):
    """Run an async Learn & Earn helper from the sync Telegram webhook."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("Event loop is closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _normalize_base_url(url: str) -> str:
    """Normalize to scheme://host[:port] and remove paths/query/fragments."""
    raw_url = (url or "").strip()
    if not raw_url:
        return ""

    parsed = urlsplit(raw_url)

    # If env var is set without scheme, assume HTTPS.
    if not parsed.scheme:
        parsed = urlsplit(f"https://{raw_url}")

    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


APP_URL = _normalize_base_url(os.getenv("TELEGRAM_WEB_APP_URL", "") or PRODUCTION_DOMAIN)


def _normalize_wallet(wallet: str) -> str:
    """Return a normalized lowercase wallet address, or an empty string."""
    candidate = (wallet or "").strip()
    if not _WALLET_RE.match(candidate):
        return ""
    return candidate.lower()


def _mask_wallet(wallet: str) -> str:
    """Mask a wallet for Telegram messages."""
    normalized = _normalize_wallet(wallet)
    if not normalized:
        return ""
    return f"{normalized[:6]}…{normalized[-4:]}"


def _safe_text(value: str, limit: int = 700) -> str:
    """Convert module HTML to readable plain text without losing paragraphs."""
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")

    # Preserve the document structure before removing HTML. Scraped module
    # content commonly uses p/div/li tags; collapsing all whitespace turns the
    # entire lesson into one dense Telegram paragraph.
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*li(?:\s[^>]*)?>", "\n• ", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*/\s*li\s*>", "", text, flags=re.IGNORECASE)
    text = re.sub(
        r"<\s*/?\s*(?:p|div|section|article|header|footer|blockquote|h[1-6]|ul|ol)(?:\s[^>]*)?>",
        "\n\n",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"<\s*(?:script|style)[^>]*>[\s\S]*?<\s*/\s*(?:script|style)\s*>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text).replace("\xa0", " ")

    lines = []
    previous_was_blank = True
    for raw_line in text.split("\n"):
        line = re.sub(r"[ \t\f\v]+", " ", raw_line).strip()
        if line:
            lines.append(line)
            previous_was_blank = False
        elif not previous_was_blank:
            lines.append("")
            previous_was_blank = True

    text = "\n".join(lines).strip()
    if len(text) > limit:
        shortened = text[:limit].rsplit(None, 1)[0].rstrip(" ,.;:-")
        text = f"{shortened or text[:limit].rstrip()}…"
    return text


def _get_admin_dashboard_questions(quiz_manager):
    """Fetch quiz questions using the latest admin dashboard quiz settings."""
    # Reload on every Telegram quiz start so question count, timer, and max
    # reward reflect the current `quiz_settings` values from the admin dashboard.
    quiz_manager.load_quiz_settings()
    return _run_async(quiz_manager.get_random_questions(quiz_manager.questions_per_quiz))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _login_serializer() -> URLSafeTimedSerializer:
    secret_key = current_app.secret_key or os.getenv("FLASK_SECRET_KEY") or os.getenv("SECRET_KEY")
    if not secret_key:
        secret_key = os.getenv("TELEGRAM_WEBHOOK_SECRET_TOKEN") or TELEGRAM_BOT_TOKEN or "goodmarket-telegram-login"
    return URLSafeTimedSerializer(secret_key=secret_key, salt="telegram-learn-earn-login")


def _create_login_url(telegram_user_id: str, wallet: str) -> str:
    token = _login_serializer().dumps({
        "telegram_user_id": str(telegram_user_id),
        "wallet": _normalize_wallet(wallet),
        "nonce": secrets.token_urlsafe(8),
    })
    return f"{APP_URL}/telegram/learn-earn-login?token={token}"


def _get_saved_wallet(telegram_user_id) -> str:
    """Fetch a Telegram user's saved wallet from Supabase."""
    if not telegram_user_id:
        return ""
    try:
        supabase = get_supabase_admin_client() or get_supabase_client()
        if not supabase:
            return ""
        result = supabase.table("telegram_wallet_sessions")\
            .select("wallet_address")\
            .eq("telegram_user_id", str(telegram_user_id))\
            .limit(1)\
            .execute()
        if result.data:
            return _normalize_wallet(result.data[0].get("wallet_address", ""))
    except Exception as e:
        logger.error(f"❌ Could not fetch Telegram wallet session: {e}")
    return ""


def _save_wallet_session(telegram_user, chat_id, wallet: str) -> bool:
    """Persist a Telegram user → wallet mapping in Supabase."""
    normalized_wallet = _normalize_wallet(wallet)
    if not normalized_wallet:
        return False

    try:
        # Use the service-role client for server-side Telegram wallet capture so
        # Supabase RLS policies for browser/anon clients do not block the bot.
        # Fall back to the anon client for deployments that have not configured
        # SUPABASE_SERVICE_ROLE_KEY yet.
        supabase = get_supabase_admin_client() or get_supabase_client()
        if not supabase:
            logger.error("❌ Supabase unavailable; Telegram wallet session not saved")
            return False

        telegram_user_id = str(telegram_user.get("id", ""))
        now = _now_iso()
        row = {
            "telegram_user_id": telegram_user_id,
            "telegram_chat_id": str(chat_id),
            "username": telegram_user.get("username"),
            "first_name": telegram_user.get("first_name"),
            "last_name": telegram_user.get("last_name"),
            "wallet_address": normalized_wallet,
            "updated_at": now,
            "last_seen_at": now,
        }
        supabase.table("telegram_wallet_sessions")\
            .upsert(row, on_conflict="telegram_user_id")\
            .execute()

        # Best-effort user_data upsert keeps GoodMarket overview/profile counters aware
        # of wallet-only Telegram users without requiring WalletConnect. Do not
        # fail the Telegram wallet login if this optional profile sync fails
        # because the wallet session above is the source of truth for bot login.
        try:
            supabase.table("user_data")\
                .upsert({
                    "wallet_address": normalized_wallet,
                    "last_login": now,
                    "ubi_verified": True,
                    "login_method": "telegram_wallet",
                }, on_conflict="wallet_address")\
                .execute()
        except Exception as profile_error:
            logger.warning(f"⚠️ Telegram wallet saved but user_data sync failed: {profile_error}")

        return True
    except Exception as e:
        logger.error(f"❌ Could not save Telegram wallet session: {e}")
    return False


def _check_wallet_face_verification(wallet: str) -> dict:
    """Return the on-chain GoodDollar face-verification result for a wallet."""
    try:
        from blockchain import is_identity_verified

        result = is_identity_verified(wallet)
        if not isinstance(result, dict):
            return {"verified": False, "error": "Invalid identity service response"}
        return result
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Telegram identity check failed for %s: %s", _mask_wallet(wallet), exc)
        return {"verified": False, "error": str(exc)}


def _ensure_wallet_is_face_verified(chat_id, wallet: str) -> bool:
    """Show identity-check UX and fail closed unless GoodDollar verifies the wallet."""
    send_message(
        chat_id,
        "🔎 <b>Checking your wallet…</b>\n\n"
        f"Wallet: <code>{_mask_wallet(wallet)}</code>\n"
        "Please wait while we check its GoodDollar face-verification status.",
    )
    result = _check_wallet_face_verification(wallet)
    if result.get("verified") is True:
        return True

    if result.get("error"):
        logger.warning(
            "⚠️ Telegram wallet identity check unavailable for %s: %s",
            _mask_wallet(wallet),
            result.get("error"),
        )
        send_message(
            chat_id,
            "⚠️ <b>We could not check your wallet right now.</b>\n\n"
            "Your wallet was not saved. Please try submitting it again in a few minutes.",
        )
        return False

    send_message(
        chat_id,
        "❌ <b>This wallet is not face verified yet.</b>\n\n"
        "Please complete face verification in GoodDollar first, then send the same wallet address again. "
        "Your wallet was not saved and you cannot enter Learn &amp; Earn yet.",
    )
    return False


def _learn_earn_keyboard(telegram_user_id, wallet: str | None = None):
    saved_wallet = _normalize_wallet(wallet or "") or _get_saved_wallet(telegram_user_id)
    keyboard = []
    if saved_wallet:
        keyboard.append([{
            "text": "📚 Start Learn & Earn chat",
            "callback_data": "learn_earn_chat",
        }])
        keyboard.append([{
            "text": "🌟 Community Stories",
            "callback_data": "community_stories",
        }])
        keyboard.append([{
            "text": "⭐ Trustpilot Review",
            "callback_data": "trustpilot_task",
        }])
        keyboard.append([{"text": "📰 News", "callback_data": "news_latest"}])
        keyboard.append([{"text": "💰 Check balance", "callback_data": "check_balance"}])
        keyboard.append([{"text": "👛 Show saved wallet", "callback_data": "show_wallet"}])
    return {"inline_keyboard": keyboard}


def _community_stories_keyboard(can_submit: bool = False):
    """Inline buttons for the Telegram Community Stories flow."""
    keyboard = [[
        {"text": "📊 Status", "callback_data": "community_stories_status"},
        {"text": "🏆 Rewards", "callback_data": "community_stories_rewards"},
    ]]
    if can_submit:
        keyboard.insert(0, [{"text": "📝 Submit X/Twitter URL", "callback_data": "community_stories_submit"}])
    return {"inline_keyboard": keyboard}


def _format_day_suffix(day) -> str:
    """Return an English ordinal day label for compact Telegram schedules."""
    try:
        day = int(day)
    except (TypeError, ValueError):
        return html.escape(str(day))
    if 10 <= day % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{day}{suffix}"


def _format_gd_amount(amount) -> str:
    """Format a GoodDollar amount for Telegram display."""
    try:
        value = float(amount or 0)
    except (TypeError, ValueError):
        return "0 G$"
    if value.is_integer():
        return f"{int(value):,} G$"
    return f"{value:,.2f} G$"


def _community_stories_config_message(config: dict, admin_message: str = "") -> str:
    """Render Community Stories settings sourced from the admin dashboard."""
    required_mentions = config.get("REQUIRED_MENTIONS") or ""
    if isinstance(required_mentions, (list, tuple)):
        required_mentions = " ".join(str(item) for item in required_mentions)
    required_mentions = str(required_mentions).strip() or "Not configured"
    start_day = _format_day_suffix(config.get("WINDOW_START_DAY", 26))
    end_day = _format_day_suffix(config.get("WINDOW_END_DAY", 30))
    instructions = _safe_text(admin_message, limit=1500) if admin_message else ""
    instructions_block = f"\n\n<b>Admin instructions:</b>\n{html.escape(instructions)}" if instructions else ""
    return (
        "🌟 <b>Community Stories</b>\n\n"
        "<b>Admin-dashboard settings are active in Telegram:</b>\n"
        f"• Text post reward: <b>{_format_gd_amount(config.get('LOW_REWARD'))}</b>\n"
        f"• Video post reward: <b>{_format_gd_amount(config.get('HIGH_REWARD'))}</b>\n"
        f"• Participation window: <b>every {start_day} to {end_day} of the month</b>\n"
        f"• Required mentions/hashtags: <code>{html.escape(required_mentions)}</code>"
        f"{instructions_block}"
    )


def _get_community_stories_admin_message() -> str:
    """Fetch the Community Stories message configured in the admin dashboard."""
    try:
        supabase = get_supabase_admin_client() or get_supabase_client()
        if not supabase:
            return ""
        result = supabase.table("maintenance_settings")\
            .select("custom_message")\
            .eq("feature_name", "community_stories_message")\
            .limit(1)\
            .execute()
        if result.data:
            return str(result.data[0].get("custom_message") or "")
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Could not fetch Telegram Community Stories admin message: %s", exc)
    return ""


def _get_community_stories_status(wallet: str) -> dict:
    """Load Community Stories config/status/history for a Telegram wallet."""
    from community_stories.community_stories_service import community_stories_service

    config = community_stories_service.get_config()
    window = community_stories_service.is_participation_window_open()
    cooldown = community_stories_service.check_user_cooldown(wallet)
    pending = community_stories_service.has_pending_submission(wallet)
    history = community_stories_service.get_user_submissions(wallet)
    return {
        "config": config,
        "window": window,
        "cooldown": cooldown,
        "pending": pending,
        "history": history,
        "message": _get_community_stories_admin_message(),
    }


def _community_stories_status_message(wallet: str) -> tuple[str, bool]:
    """Render Telegram status text and whether the wallet can submit now."""
    status = _get_community_stories_status(wallet)
    config = status["config"]
    window = status["window"] or {}
    cooldown = status["cooldown"] or {}
    pending = status["pending"] or {}
    history = status["history"] or {}
    stats = history.get("stats") or {}
    submissions = history.get("submissions") or []

    is_open = bool(window.get("is_open"))
    has_pending = bool(pending.get("has_pending"))
    can_participate = bool(cooldown.get("can_participate"))
    can_submit = is_open and can_participate and not has_pending
    next_window = window.get("next_window") or cooldown.get("next_participation")
    latest_status = submissions[0].get("status") if submissions else "none"
    pending_count = sum(1 for item in submissions if item.get("status") == "pending")
    rewarded_count = int(stats.get("total_submissions") or 0)
    total_earned = stats.get("total_earned") or 0

    lines = [
        _community_stories_config_message(config, status.get("message") or ""),
        "",
        "<b>Your status:</b>",
        f"• Saved wallet: <code>{_mask_wallet(wallet)}</code>",
        f"• Window now: <b>{'OPEN' if is_open else 'CLOSED'}</b>",
        f"• Can submit: <b>{'YES' if can_submit else 'NO'}</b>",
        f"• Pending review: <b>{pending_count}</b>",
        f"• Latest submission status: <code>{html.escape(str(latest_status))}</code>",
        f"• Rewards received: <b>{rewarded_count}</b>",
        f"• Total rewards received: <b>{_format_gd_amount(total_earned)}</b>",
    ]
    if has_pending:
        lines.append("• Note: You already have a pending submission; wait for admin review.")
    if not can_participate:
        reason = cooldown.get("reason") or cooldown.get("error") or "cooldown active"
        lines.append(f"• Cooldown: <code>{html.escape(str(reason))}</code>")
    if next_window:
        lines.append(f"• Next participation: <code>{html.escape(str(next_window))} UTC</code>")
    return "\n".join(lines), can_submit


def _clear_wallet_learn_earn_sessions(wallet: str, *, except_user_id=None):
    """Remove active Telegram Learn & Earn sessions for a wallet.

    This prevents a rewarded wallet from continuing/restarting an older in-memory
    chat quiz session after Supabase cooldown eligibility says the wallet is no
    longer allowed to earn.
    """
    normalized = _normalize_wallet(wallet or "")
    if not normalized:
        return
    except_key = str(except_user_id) if except_user_id is not None else None
    with _TELEGRAM_LEARN_EARN_LOCK:
        stale_keys = [
            session_key
            for session_key, session_data in _TELEGRAM_LEARN_EARN_SESSIONS.items()
            if session_key != except_key and _normalize_wallet(session_data.get("wallet") or "") == normalized
        ]
        for session_key in stale_keys:
            _TELEGRAM_LEARN_EARN_SESSIONS.pop(session_key, None)


def _ensure_wallet_can_start_learn_earn(chat_id, telegram_user_id, wallet: str) -> bool:
    """Fail-closed Telegram gate for Learn & Earn cooldown eligibility."""
    from learn_and_earn.learn_and_earn import quiz_manager

    try:
        eligibility = _run_async(quiz_manager.check_quiz_eligibility(wallet))
    except Exception as exc:  # noqa: BLE001
        logger.error(f"❌ Telegram Learn & Earn eligibility check failed for {_mask_wallet(wallet)}: {exc}")
        send_message(
            chat_id,
            "⛔ <b>Learn &amp; Earn quiz cannot start yet</b>\n\n"
            "We could not verify your Supabase reward/cooldown history right now. "
            "For fund safety, please try again later.",
            _learn_earn_keyboard(telegram_user_id, wallet),
        )
        return False

    # Missing/malformed eligibility data must not bypass the database cooldown.
    if not eligibility.get("eligible", False):
        _clear_wallet_learn_earn_sessions(wallet, except_user_id=telegram_user_id)
        send_message(
            chat_id,
            _format_learn_earn_unavailable_message(eligibility),
            _learn_earn_keyboard(telegram_user_id, wallet),
        )
        return False
    return True


def _format_countdown(seconds_remaining: int) -> str:
    """Return a compact mm:ss countdown label for Telegram messages."""
    seconds_remaining = max(0, int(seconds_remaining))
    minutes, seconds = divmod(seconds_remaining, 60)
    return f"{minutes:02d}:{seconds:02d}"


def _telegram_message_id(response):
    """Extract a Telegram message_id from a sendMessage response."""
    if isinstance(response, dict) and response.get("ok") and isinstance(response.get("result"), dict):
        return response["result"].get("message_id")
    return None


def _format_learn_earn_unavailable_message(eligibility: dict | None) -> str:
    """Return a user-friendly Telegram message for cooldown/no-quiz states."""
    eligibility = eligibility or {}
    reason = str(eligibility.get("reason") or "").lower()
    next_quiz_time = eligibility.get("next_quiz_time")
    if "cooldown" in reason or next_quiz_time:
        next_line = ""
        if next_quiz_time:
            next_line = f"\nYou can participate again after: <code>{html.escape(str(next_quiz_time))} UTC</code>"
        return (
            "⏳ <b>You already participated in Learn &amp; Earn.</b>\n\n"
            "Your rewarded quiz is already logged, so your wallet is on cooldown and is not eligible for another quiz yet."
            f"{next_line}"
        )
    return (
        "⏳ <b>Learn &amp; Earn is not available yet</b>\n\n"
        f"{html.escape(str(eligibility.get('message', 'Please try again later.')))}"
    )


def _send_no_active_or_cooldown_message(chat_id, telegram_user_id):
    """Explain stale Telegram callbacks, preferring cooldown status when present."""
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if saved_wallet:
        try:
            from learn_and_earn.learn_and_earn import quiz_manager
            eligibility = _run_async(quiz_manager.check_quiz_eligibility(saved_wallet))
            if not eligibility.get("eligible", False):
                send_message(
                    chat_id,
                    _format_learn_earn_unavailable_message(eligibility),
                    _learn_earn_keyboard(telegram_user_id, saved_wallet),
                )
                return
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"⚠️ Could not refresh Telegram Learn & Earn cooldown state: {exc}")

    send_message(chat_id, "📚 No active Learn &amp; Earn chat quiz. Type /earn to start.")


def delete_message(chat_id, message_id):
    """Best-effort removal of a Telegram message."""
    if not chat_id or not message_id:
        return False
    try:
        resp = requests.post(
            f"{TELEGRAM_API}/deleteMessage",
            json={"chat_id": chat_id, "message_id": message_id},
            timeout=5,
        )
        return bool(resp.ok)
    except Exception as e:
        logger.debug(f"Telegram deleteMessage skipped: {e}")
        return False


def edit_message(chat_id, message_id, text, reply_markup=None):
    """Best-effort edit of a Telegram message."""
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML",
    }
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        resp = requests.post(f"{TELEGRAM_API}/editMessageText", json=payload, timeout=5)
        result = resp.json()
        if not result.get("ok"):
            logger.warning(f"Telegram editMessageText failed: {result}")
        return result
    except Exception as e:
        logger.warning(f"Telegram editMessageText error: {e}")
        return None


def _edit_or_replace_session_message(session_data, chat_id, key, text, reply_markup=None):
    """Edit a tracked message; if Telegram rejects the edit, replace it with a new one."""
    message_id = session_data.get(key) if session_data else None
    if message_id:
        result = edit_message(chat_id, message_id, text, reply_markup)
        if isinstance(result, dict) and result.get("ok"):
            return message_id

    response = send_message(chat_id, text, reply_markup)
    replacement_id = _telegram_message_id(response)
    if replacement_id:
        if message_id and message_id != replacement_id:
            delete_message(chat_id, message_id)
        session_data[key] = replacement_id
    return replacement_id


def _delete_session_message(session_data, chat_id, key):
    message_id = session_data.pop(key, None) if session_data else None
    if message_id:
        delete_message(chat_id, message_id)


def send_message(chat_id, text, reply_markup=None):
    """Send a message to a Telegram chat."""
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    }
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        resp = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)
        return resp.json()
    except Exception as e:
        logger.error(f"Telegram sendMessage error: {e}")
        return None


def _question_keyboard(question_number: int):
    return {
        "inline_keyboard": [
            [
                {"text": "A", "callback_data": f"le_ans:{question_number}:0"},
                {"text": "B", "callback_data": f"le_ans:{question_number}:1"},
                {"text": "C", "callback_data": f"le_ans:{question_number}:2"},
                {"text": "D", "callback_data": f"le_ans:{question_number}:3"},
            ]
        ]
    }


def _module_keyboard(module_index: int, total_modules: int):
    is_last_module = module_index >= total_modules - 1
    return {
        "inline_keyboard": [[{
            "text": "✅ Start quiz" if is_last_module else "➡️ Next module",
            "callback_data": f"le_mod_next:{module_index}",
        }]]
    }


def _start_questions_from_session(chat_id, telegram_user_id):
    session_key = str(telegram_user_id)
    session_data = _TELEGRAM_LEARN_EARN_SESSIONS.get(session_key)
    if not session_data:
        _send_no_active_or_cooldown_message(chat_id, telegram_user_id)
        return

    if not _ensure_wallet_can_start_learn_earn(chat_id, telegram_user_id, session_data.get("wallet")):
        _TELEGRAM_LEARN_EARN_SESSIONS.pop(session_key, None)
        return

    questions = session_data.get("questions") or []
    if not questions:
        _TELEGRAM_LEARN_EARN_SESSIONS.pop(session_key, None)
        send_message(chat_id, "⚠️ No Learn &amp; Earn quiz questions are attached to an active session. Type /earn to start a new quiz.")
        return

    session_data["phase"] = "quiz"
    session_data["current_index"] = 0
    send_message(
        chat_id,
        "📝 <b>Quiz starts now.</b>\n\n"
        f"You have <b>{int(session_data['time_per_question'])}s</b> per question. Tap A, B, C, or D.",
    )
    _send_current_question(chat_id, telegram_user_id)


def _module_message_text(module, module_index, total_modules):
    title = html.escape(str(module.get("title") or f"Module {module_index + 1}"))
    body = _safe_text(module.get("content") or module.get("description") or module.get("url") or "", limit=2200)
    if not body:
        body = "No module body was provided yet, but this module is active in the admin dashboard."

    next_step = (
        "Tap <b>Start quiz</b> after you finish reading."
        if module_index >= total_modules - 1
        else "Tap <b>Next module</b> after you finish reading."
    )
    return (
        f"📘 <b>Module {module_index + 1}/{total_modules}: {title}</b>\n\n"
        f"📖 <b>Module content</b>\n\n"
        f"{html.escape(body)}\n\n"
        f"━━━━━━━━━━━━━━\n"
        f"{next_step}"
    )


def _send_current_module(chat_id, telegram_user_id):
    with _TELEGRAM_LEARN_EARN_LOCK:
        session_data = _TELEGRAM_LEARN_EARN_SESSIONS.get(str(telegram_user_id))
        if not session_data:
            send_message(chat_id, "📚 No active Learn &amp; Earn chat quiz. Type /earn to start.")
            return

        modules = session_data.get("modules") or []
        module_index = session_data.get("current_module_index", 0)
        if module_index >= len(modules):
            _start_questions_from_session(chat_id, telegram_user_id)
            return

        _delete_session_message(session_data, chat_id, "module_message_id")
        module = modules[module_index]
        response = send_message(
            chat_id,
            _module_message_text(module, module_index, len(modules)),
            _module_keyboard(module_index, len(modules)),
        )
        session_data["module_message_id"] = _telegram_message_id(response)



def _question_message_text(question, current_index, total_questions, seconds_remaining):
    options = question.get("options", [])
    option_lines = "\n".join(
        f"{chr(65 + idx)}. {html.escape(str(option))}"
        for idx, option in enumerate(options[:4])
    )
    return (
        f"⏱️ <b>Question {current_index + 1}/{total_questions}</b> — live timer: <b>{_format_countdown(seconds_remaining)}</b>\n\n"
        f"{html.escape(str(question.get('question', '')))}\n\n"
        f"{option_lines}\n\n"
        "Tap A, B, C, or D before the countdown ends."
    )


def _send_current_question(chat_id, telegram_user_id):
    with _TELEGRAM_LEARN_EARN_LOCK:
        session_data = _TELEGRAM_LEARN_EARN_SESSIONS.get(str(telegram_user_id))
        if not session_data:
            send_message(chat_id, "📚 No active Learn &amp; Earn chat quiz. Type /earn to start.")
            return
        if session_data.get("phase") != "quiz":
            send_message(chat_id, "📘 Please finish the module step first, then the quiz will start.")
            return

        _delete_session_message(session_data, chat_id, "question_message_id")
        current_index = session_data["current_index"]
        questions = session_data.get("questions") or []
        if not questions or current_index >= len(questions):
            _TELEGRAM_LEARN_EARN_SESSIONS.pop(str(telegram_user_id), None)
            send_message(chat_id, "📚 This Learn &amp; Earn quiz session is no longer active. Type /earn to start again.")
            return
        question = questions[current_index]
        seconds = int(session_data["time_per_question"])
        session_data["deadline"] = time.time() + seconds
        session_data["question_timer_token"] = secrets.token_urlsafe(8)
        timer_token = session_data["question_timer_token"]
        response = send_message(chat_id, _question_message_text(question, current_index, len(questions), seconds), _question_keyboard(current_index))
        session_data["question_message_id"] = _telegram_message_id(response)


def _tick_question_timer(chat_id, session_key, session_data):
    question_index = session_data.get("current_index", 0)
    timer_token = session_data.get("question_timer_token")
    questions = session_data.get("questions") or []
    question = questions[question_index] if question_index < len(questions) else None
    if not question or not timer_token:
        return

    remaining = math.ceil(session_data.get("deadline", 0) - time.time())
    if remaining > 0:
        _edit_or_replace_session_message(
            session_data,
            chat_id,
            "question_message_id",
            _question_message_text(question, question_index, len(questions), remaining),
            _question_keyboard(question_index),
        )
        return

    session_data["answers"].append(-1)
    session_data["current_index"] += 1
    session_data["question_timer_token"] = None
    _delete_session_message(session_data, chat_id, "question_message_id")
    finished = session_data["current_index"] >= len(questions)

    send_message(chat_id, "⏱️ Time is up. The old question was removed and marked incorrect.")
    if finished:
        _finish_chat_quiz(chat_id, session_key)
    else:
        _send_current_question(chat_id, session_key)


def _process_learn_earn_timers_once():
    with _TELEGRAM_LEARN_EARN_LOCK:
        session_items = [
            (session_key, dict(session_data))
            for session_key, session_data in _TELEGRAM_LEARN_EARN_SESSIONS.items()
        ]

    for session_key, snapshot in session_items:
        chat_id = snapshot.get("chat_id")
        if not chat_id:
            continue
        with _TELEGRAM_LEARN_EARN_LOCK:
            live_session = _TELEGRAM_LEARN_EARN_SESSIONS.get(session_key)
            if not live_session:
                continue
            phase = live_session.get("phase")
            if phase == "quiz":
                _tick_question_timer(chat_id, session_key, live_session)


def _learn_earn_timer_scheduler_loop():
    while not _TELEGRAM_LEARN_EARN_SCHEDULER_STOP.is_set():
        try:
            _process_learn_earn_timers_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Telegram Learn & Earn timer scheduler crashed: %s", exc)
        _TELEGRAM_LEARN_EARN_SCHEDULER_STOP.wait(max(1, _TELEGRAM_TIMER_UPDATE_SECONDS))


def init_telegram_learn_earn_timer_scheduler(app=None):
    """Start the app-level Telegram Learn & Earn timer scheduler."""
    global _TELEGRAM_LEARN_EARN_SCHEDULER_THREAD
    if not TELEGRAM_BOT_TOKEN:
        logger.info("Telegram Learn & Earn timer scheduler disabled: TELEGRAM_BOT_TOKEN not set")
        return False
    with _TELEGRAM_LEARN_EARN_SCHEDULER_LOCK:
        if _TELEGRAM_LEARN_EARN_SCHEDULER_THREAD and _TELEGRAM_LEARN_EARN_SCHEDULER_THREAD.is_alive():
            return True
        _TELEGRAM_LEARN_EARN_SCHEDULER_STOP.clear()
        _TELEGRAM_LEARN_EARN_SCHEDULER_THREAD = threading.Thread(
            target=_learn_earn_timer_scheduler_loop,
            name="telegram-learn-earn-timer-scheduler",
            daemon=True,
        )
        _TELEGRAM_LEARN_EARN_SCHEDULER_THREAD.start()
        logger.info("Telegram Learn & Earn timer scheduler started poll=%ss", _TELEGRAM_TIMER_UPDATE_SECONDS)
        return True

def _finish_chat_quiz(chat_id, telegram_user_id):
    from learn_and_earn.blockchain import learn_blockchain_service
    from learn_and_earn.learn_and_earn import quiz_manager

    session_key = str(telegram_user_id)
    session_data = _TELEGRAM_LEARN_EARN_SESSIONS.pop(session_key, None)
    if not session_data:
        send_message(chat_id, "📚 No active Learn &amp; Earn chat quiz. Type /earn to start.")
        return

    quiz_result = quiz_manager.validate_and_score_quiz(
        session_data["quiz_session_id"],
        session_data["answers"],
    )
    if not quiz_result.get("valid"):
        send_message(chat_id, f"⚠️ {html.escape(quiz_result.get('message', 'Quiz could not be scored.'))}")
        return

    wallet = session_data["wallet"]
    reward_amount = float(quiz_result.get("reward_amount") or 0)
    tx_hash = None

    if not _ensure_wallet_can_start_learn_earn(chat_id, telegram_user_id, wallet):
        return

    if reward_amount > 0:
        try:
            disbursement = _run_async(learn_blockchain_service.send_g_reward(
                wallet,
                reward_amount,
                {
                    "action": "telegram_chat_quiz",
                    "quiz_session_id": session_data["quiz_session_id"],
                    "score": quiz_result.get("score"),
                    "total": quiz_result.get("total_questions"),
                    "telegram_user_id": telegram_user_id,
                },
            ))
        except Exception as disburse_error:  # noqa: BLE001
            logger.error(f"❌ Telegram chat quiz disbursement crashed: {disburse_error}")
            disbursement = {"success": False, "error": "Reward transfer failed. Please try again later."}

        if not disbursement or not disbursement.get("success"):
            error_code = (disbursement or {}).get("error_code")
            if error_code == "insufficient_gas":
                error = (
                    "The reward contract still has G$, but the bot's operator wallet does not have enough CELO "
                    "to pay the network gas fee. Your reward cannot be sent until the operator gas wallet is refilled."
                )
                retry_guidance = (
                    "You do not need to add gas to your own wallet. Your quiz attempt was not recorded and no cooldown started; "
                    "please try again after the bot operator gas wallet is refilled."
                )
            else:
                error = str((disbursement or {}).get("error") or "Reward transfer failed. Please try again later.")
                retry_guidance = (
                    "Your quiz attempt was not recorded yet, so the cooldown will not start until the reward is successfully received."
                )
            send_message(
                chat_id,
                "⚠️ <b>Learn &amp; Earn reward was not sent</b>\n\n"
                f"Score: <b>{quiz_result.get('score')}/{quiz_result.get('total_questions')}</b>\n"
                f"Reward calculated: <b>{reward_amount} G$</b>\n\n"
                f"{html.escape(error)}\n\n"
                f"{retry_guidance}",
            )
            return

        tx_hash = disbursement.get("tx_hash")
        if not tx_hash:
            logger.error("❌ Telegram chat quiz disbursement succeeded without a transaction hash")
            send_message(
                chat_id,
                "⚠️ <b>Learn &amp; Earn reward status is incomplete</b>\n\n"
                f"Score: <b>{quiz_result.get('score')}/{quiz_result.get('total_questions')}</b>\n"
                f"Reward calculated: <b>{reward_amount} G$</b>\n\n"
                "The reward service did not return a transaction hash, so your quiz attempt was not recorded yet. "
                "Please contact support before trying again.",
            )
            return

    quiz_log = None
    if reward_amount > 0 and tx_hash:
        try:
            quiz_log = _run_async(quiz_manager.save_quiz_attempt(
                wallet,
                quiz_result.get("questions", session_data["questions"]),
                session_data["answers"],
                reward_amount,
                {"verified": False, "source": "telegram_chat", "reward_tx_hash": tx_hash},
            ))
            if quiz_log:
                quiz_manager.update_quiz_log_with_transaction(quiz_log.get("quiz_id"), tx_hash)
        except Exception as save_error:
            logger.error(f"❌ Telegram chat quiz save failed after reward: {save_error}")
            send_message(
                chat_id,
                "⚠️ Reward sent, but we could not record your Learn &amp; Earn cooldown log. "
                "Please contact support with your transaction hash: "
                f"<code>{html.escape(str(tx_hash or 'n/a'))}</code>",
            )
            return
    else:
        logger.info(
            "ℹ️ Telegram chat quiz earned no positive reward; skipping learnearn_log "
            "so no cooldown starts for wallet %s",
            wallet[:8],
        )

    tx_line = f"Transaction hash: <code>{html.escape(str(tx_hash))}</code>\n" if tx_hash else ""
    cooldown_line = (
        "You are now on cooldown. You already received your rewards, so this wallet cannot start another Learn &amp; Earn quiz until the cooldown ends."
        if quiz_log
        else "No Learn &amp; Earn cooldown was started because no positive on-chain reward was recorded."
    )
    if quiz_log:
        try:
            cooldown_status = _run_async(quiz_manager.check_quiz_eligibility(wallet))
            next_quiz_time = cooldown_status.get("next_quiz_time")
            if next_quiz_time:
                cooldown_line += f"\nYou can participate again after: <code>{html.escape(str(next_quiz_time))} UTC</code>"
        except Exception as cooldown_error:  # noqa: BLE001
            logger.warning(f"⚠️ Could not fetch Telegram Learn & Earn cooldown after reward: {cooldown_error}")
    send_message(
        chat_id,
        "✅ <b>Learn &amp; Earn chat quiz complete!</b>\n\n"
        f"Score: <b>{quiz_result.get('score')}/{quiz_result.get('total_questions')}</b>\n"
        f"Reward received: <b>{reward_amount} G$</b>\n"
        f"{tx_line}\n"
        f"{cooldown_line}",
    )


def handle_learn_earn_answer(chat_id, telegram_user_id, callback_data: str):
    parts = callback_data.split(":")
    if len(parts) != 3:
        return

    try:
        question_index = int(parts[1])
        answer_index = int(parts[2])
    except ValueError:
        return

    with _TELEGRAM_LEARN_EARN_LOCK:
        session_data = _TELEGRAM_LEARN_EARN_SESSIONS.get(str(telegram_user_id))
        if not session_data or session_data.get("phase") != "quiz" or not session_data.get("questions"):
            needs_status_message = True
        else:
            needs_status_message = False

        if not needs_status_message and question_index != session_data["current_index"]:
            send_message(chat_id, "ℹ️ That answer is for an old question. Please answer the latest question.")
            return

        if needs_status_message:
            # Reply after leaving the session decision path with the latest cooldown
            # state so stale module/question buttons explain that the rewarded
            # wallet is already cooling down instead of only saying "no active quiz".
            finished = False
        else:
            selected_answer = -1 if time.time() > session_data.get("deadline", 0) else answer_index
            session_data["answers"].append(selected_answer)
            session_data["current_index"] += 1
            session_data["question_timer_token"] = None
            _delete_session_message(session_data, chat_id, "question_message_id")
            finished = session_data["current_index"] >= len(session_data["questions"])

    if needs_status_message:
        _send_no_active_or_cooldown_message(chat_id, telegram_user_id)
        return

    if finished:
        _finish_chat_quiz(chat_id, telegram_user_id)
    else:
        _send_current_question(chat_id, telegram_user_id)


def handle_learn_earn_module_next(chat_id, telegram_user_id, callback_data: str):
    parts = callback_data.split(":")
    if len(parts) != 2:
        return

    session_data = _TELEGRAM_LEARN_EARN_SESSIONS.get(str(telegram_user_id))
    if not session_data:
        _send_no_active_or_cooldown_message(chat_id, telegram_user_id)
        return
    if session_data.get("phase") != "module":
        send_message(chat_id, "📝 The quiz has already started. Please answer the current question.")
        return

    try:
        module_index = int(parts[1])
    except ValueError:
        return

    if module_index != session_data.get("current_module_index", 0):
        send_message(chat_id, "ℹ️ That module button is old. Please use the latest module message.")
        return

    _delete_session_message(session_data, chat_id, "module_message_id")
    session_data["current_module_index"] = module_index + 1
    if session_data["current_module_index"] >= len(session_data.get("modules") or []):
        _start_questions_from_session(chat_id, telegram_user_id)
    else:
        _send_current_module(chat_id, telegram_user_id)


def handle_start(chat_id, telegram_user):
    """Handle /start command — ask for wallet or open Learn & Earn."""
    first_name = telegram_user.get("first_name", "there")
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)

    if saved_wallet:
        text = (
            f"👋 Welcome back, <b>{first_name}</b>!\n\n"
            "Welcome to <b>GoodMarket on Telegram</b> — our backup chat hub from the GoodMarket web app. "
            "You can use it for <b>Learn &amp; Earn</b>, <b>Community Stories</b>, and more GoodMarket features coming soon like savings, claims, and games.\n\n"
            f"Your saved wallet is <code>{_mask_wallet(saved_wallet)}</code>.\n\n"
            "Choose an option below to continue without reopening the Mini App."
        )
        send_message(chat_id, text, _learn_earn_keyboard(telegram_user_id, saved_wallet))
        return

    text = (
        f"👋 Welcome to <b>GoodMarket on Telegram</b>, <b>{first_name}</b>!\n\n"
        "We launched this bot from the GoodMarket web app as a backup chat hub for "
        "<b>Learn &amp; Earn</b>, <b>Community Stories</b>, and upcoming features like savings, claims, games, and more.\n\n"
        "To get started, send your Celo wallet address here in Telegram.\n"
        "Example: <code>0x1234...abcd</code>\n\n"
        "After your verified wallet is saved, the buttons will let you continue directly in chat."
    )
    send_message(chat_id, text)


def handle_help(chat_id, telegram_user=None):
    """Handle /help command."""
    telegram_user_id = (telegram_user or {}).get("id")
    text = (
        "🤖 <b>GoodMarket Bot Commands</b>\n\n"
        "/start — Save your wallet or open Learn &amp; Earn\n"
        "/earn — Start Learn &amp; Earn in this chat\n"
        "/stories — Community Stories instructions, status, and submission\n"
        "/trustpilot — Submit a Trustpilot review to earn G$\n"
        "/news — Latest GoodMarket news\n"
        "/wallet — Show your saved wallet\n"
        "/balance — Check your Celo wallet balances\n"
        "/change_wallet — Replace your saved wallet\n"
        "/market — Open GoodMarket\n"
    )
    send_message(chat_id, text, _learn_earn_keyboard(telegram_user_id))


def handle_earn(chat_id, telegram_user):
    """Handle /earn command — start the chat-first Learn & Earn flow when wallet is saved."""
    from learn_and_earn.blockchain import learn_blockchain_service
    from learn_and_earn.learn_and_earn import quiz_manager

    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(
            chat_id,
            "📚 <b>Learn &amp; Earn</b>\n\nPlease send your wallet address first so we can save your Learn &amp; Earn login.",
        )
        return

    try:
        if not _ensure_wallet_can_start_learn_earn(chat_id, telegram_user_id, saved_wallet):
            _TELEGRAM_LEARN_EARN_SESSIONS.pop(str(telegram_user_id), None)
            return

        existing_session = _TELEGRAM_LEARN_EARN_SESSIONS.get(str(telegram_user_id))
        if existing_session:
            send_message(
                chat_id,
                "📝 <b>You already have an active Learn &amp; Earn chat quiz.</b> Please finish the current quiz before starting another one.",
            )
            return

        if not learn_blockchain_service.has_reward_contract:
            send_message(
                chat_id,
                "⛔ <b>Learn &amp; Earn quiz cannot start yet</b>\n\n"
                "The Learn &amp; Earn reward contract address is not configured, so Telegram rewards cannot be disbursed right now.",
                _learn_earn_keyboard(telegram_user_id, saved_wallet),
            )
            return

        if not learn_blockchain_service.has_operator_wallet:
            send_message(
                chat_id,
                "⛔ <b>Learn &amp; Earn quiz cannot start yet</b>\n\n"
                "The Learn &amp; Earn gas operator wallet is not configured, so Telegram rewards cannot be disbursed right now.",
                _learn_earn_keyboard(telegram_user_id, saved_wallet),
            )
            return

        operator_gas_balance = _run_async(learn_blockchain_service.get_operator_gas_balance())
        if 0 <= operator_gas_balance < _TELEGRAM_MIN_LEARN_EARN_OPERATOR_GAS_CELO:
            send_message(
                chat_id,
                "⛔ <b>Learn &amp; Earn quiz cannot start yet</b>\n\n"
                "The reward contract has G$, but the bot's operator wallet does not have enough CELO to pay the network gas fee.\n\n"
                "You do not need to add gas to your own wallet. Please try again after the bot operator gas wallet is refilled.",
                _learn_earn_keyboard(telegram_user_id, saved_wallet),
            )
            return

        contract_balance = _run_async(learn_blockchain_service.get_contract_balance())
        if contract_balance < _TELEGRAM_MIN_LEARN_EARN_CONTRACT_BALANCE_GD:
            send_message(
                chat_id,
                "⛔ <b>Learn &amp; Earn quiz cannot start yet</b>\n\n"
                "The reward contract needs at least "
                f"<b>{_TELEGRAM_MIN_LEARN_EARN_CONTRACT_BALANCE_GD:.0f} G$</b> before a Telegram quiz can start.\n"
                f"Current contract balance: <b>{contract_balance:.2f} G$</b>.\n\n"
                "Please try again after the rewards pool is refilled.",
                _learn_earn_keyboard(telegram_user_id, saved_wallet),
            )
            return

        modules = quiz_manager.get_module_links()
        questions = _get_admin_dashboard_questions(quiz_manager)
        if not questions:
            send_message(chat_id, "⚠️ No Learn &amp; Earn quiz questions are available right now. Please try again later.")
            return

        quiz_session = quiz_manager.create_quiz_session(saved_wallet, questions)
        _TELEGRAM_LEARN_EARN_SESSIONS[str(telegram_user_id)] = {
            "chat_id": chat_id,
            "wallet": saved_wallet,
            "quiz_session_id": quiz_session["session_id"],
            "modules": modules,
            "questions": questions,
            "phase": "module" if modules else "quiz",
            "current_module_index": 0,
            "answers": [],
            "current_index": 0,
            "time_per_question": quiz_manager.time_per_question,
            "deadline": 0,
        }
    except Exception as e:
        logger.error(f"❌ Telegram Learn & Earn chat start failed: {e}")
        send_message(chat_id, "⚠️ Learn &amp; Earn chat quiz could not start. Please try again later.")
        return

    text = (
        "📚 <b>Learn &amp; Earn chat quiz started</b>\n\n"
        f"Saved wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
        f"Source: active modules from <code>learn_earn_module_links</code> and admin-dashboard questions from <code>quiz_questions</code>.\n"
        f"Timer: <b>{quiz_manager.time_per_question}s per question</b>.\n\n"
        + (
            f"You have <b>{len(modules)}</b> module(s) to read first. The quiz starts after the module step."
            if modules
            else "No active module is available right now, so the quiz starts immediately."
        )
    )
    send_message(chat_id, text)
    if modules:
        _send_current_module(chat_id, telegram_user_id)
    else:
        _start_questions_from_session(chat_id, telegram_user_id)


def _article_web_url(article: dict) -> str:
    """Return the public web URL for a news article."""
    share_url = str(article.get("share_url") or "").strip()
    if share_url.startswith("http://") or share_url.startswith("https://"):
        return share_url
    if share_url.startswith("/"):
        return f"{APP_URL}{share_url}" if APP_URL else share_url
    article_id = article.get("id")
    path = f"/news/article/{article_id}" if article_id else "/news"
    return f"{APP_URL}{path}" if APP_URL else path


def _truncate_for_telegram(value: str, limit: int = 180) -> str:
    """Trim text to a Telegram-friendly preview without cutting mid-word when possible."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    trimmed = text[:limit].rstrip()
    last_space = trimmed.rfind(" ")
    if last_space > limit // 2:
        trimmed = trimmed[:last_space]
    return f"{trimmed}..."


def _format_news_item_for_telegram(article: dict, index: int) -> str:
    """Format one news article as a compact Telegram HTML preview."""
    title = html.escape(str(article.get("title") or "Untitled news"))
    category = html.escape(str(article.get("category_display") or "📰 News"))
    time_ago = html.escape(str(article.get("time_ago") or "recently"))
    excerpt = html.escape(_truncate_for_telegram(article.get("excerpt") or article.get("content") or "", 180))

    lines = [
        f"<b>{index}. {title}</b>",
        f"{category} · {time_ago}",
    ]
    if excerpt:
        lines.append(excerpt)
    return "\n".join(lines)


def _news_keyboard(articles: list[dict], mode: str = "latest") -> dict:
    """Build inline buttons for Telegram news browsing."""
    article_buttons = []
    for idx, article in enumerate(articles[:5], start=1):
        article_buttons.append({"text": f"{idx}️⃣ Read", "url": _article_web_url(article)})

    keyboard = []
    for i in range(0, len(article_buttons), 2):
        keyboard.append(article_buttons[i:i + 2])

    nav_row = []
    if mode != "featured":
        nav_row.append({"text": "⭐ Featured", "callback_data": "news_featured"})
    if mode != "latest":
        nav_row.append({"text": "📰 Latest", "callback_data": "news_latest"})
    nav_row.append({"text": "📂 Categories", "callback_data": "news_categories"})
    keyboard.append(nav_row)
    keyboard.append([{"text": "🔄 Refresh", "callback_data": f"news_{mode}"}])
    return {"inline_keyboard": keyboard}


def _news_categories_keyboard() -> dict:
    """Build category picker from the shared news feed service categories."""
    keyboard = []
    for key, label in news_feed_service.categories.items():
        keyboard.append([{"text": str(label), "callback_data": f"news_cat:{key}"}])
    keyboard.append([{"text": "📰 Latest", "callback_data": "news_latest"}])
    return {"inline_keyboard": keyboard}


def handle_news(chat_id, text: str = "/news"):
    """Handle /news commands and send a compact Telegram news feed."""
    command = (text or "/news").strip().lower()
    mode = "featured" if "featured" in command else "latest"
    if "categor" in command:
        send_message(chat_id, "📂 <b>GoodMarket News Categories</b>\n\nChoose a category to browse.", _news_categories_keyboard())
        return
    _send_news_feed(chat_id, mode=mode)


def handle_news_callback(chat_id, callback_data: str):
    """Handle Telegram inline callbacks for news browsing."""
    if callback_data == "news_categories":
        send_message(chat_id, "📂 <b>GoodMarket News Categories</b>\n\nChoose a category to browse.", _news_categories_keyboard())
        return
    if callback_data == "news_featured":
        _send_news_feed(chat_id, mode="featured")
        return
    if callback_data == "news_latest":
        _send_news_feed(chat_id, mode="latest")
        return
    if callback_data.startswith("news_cat:"):
        category = callback_data.split(":", 1)[1]
        _send_news_feed(chat_id, mode="category", category=category)
        return


def _send_news_feed(chat_id, mode: str = "latest", category: str | None = None):
    """Fetch shared news feed data and send a Telegram-friendly digest."""
    try:
        featured_only = mode == "featured"
        articles = news_feed_service.get_news_feed(limit=5, category=category, featured_only=featured_only)
    except Exception as exc:
        logger.error("Telegram news feed failed: %s", exc)
        fallback_url = f"{APP_URL}/news" if APP_URL else "/news"
        send_message(
            chat_id,
            "⚠️ <b>News feed is temporarily unavailable.</b>\n\n"
            f"You can still open the web news feed here: {html.escape(fallback_url)}",
        )
        return

    if category:
        heading = f"📂 <b>{html.escape(str(news_feed_service.categories.get(category, category)))}</b>"
    elif mode == "featured":
        heading = "⭐ <b>Featured GoodMarket News</b>"
    else:
        heading = "📰 <b>Latest GoodMarket News</b>"

    if not articles:
        send_message(chat_id, f"{heading}\n\nNo published articles found yet.", _news_keyboard([], mode="latest"))
        return

    body = "\n\n".join(_format_news_item_for_telegram(article, index) for index, article in enumerate(articles, start=1))
    send_message(chat_id, f"{heading}\n\n{body}", _news_keyboard(articles, mode=mode if mode in {"latest", "featured"} else "latest"))


def handle_market(chat_id):
    """Handle /market command — open Marketplace page."""
    text = "🛒 <b>GoodMarket</b>\n\nOpen the marketplace from Telegram."
    reply_markup = {
        "inline_keyboard": [
            [{"text": "🛒 Open GoodMarket", "url": APP_URL}]
        ]
    }
    send_message(chat_id, text, reply_markup)


def handle_community_stories(chat_id, telegram_user):
    """Handle /stories and Community Stories callbacks using admin dashboard config."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(
            chat_id,
            "🌟 <b>Community Stories</b>\n\n"
            "Please send your wallet address first with /start so Telegram can check your admin-configured eligibility.",
        )
        return

    try:
        text, can_submit = _community_stories_status_message(saved_wallet)
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Telegram Community Stories status failed: %s", exc)
        send_message(chat_id, "⚠️ Community Stories settings/status could not be loaded. Please try again later.")
        return
    send_message(chat_id, text, _community_stories_keyboard(can_submit))


def handle_community_stories_rewards(chat_id, telegram_user):
    """Show Community Stories reward totals for a Telegram wallet."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "🌟 Please save your wallet with /start first.")
        return

    try:
        status = _get_community_stories_status(saved_wallet)
        stats = ((status.get("history") or {}).get("stats") or {})
        submissions = (status.get("history") or {}).get("submissions") or []
        pending_count = sum(1 for item in submissions if item.get("status") == "pending")
        latest_status = submissions[0].get("status") if submissions else "none"
        text = (
            "🏆 <b>Your Community Stories Rewards</b>\n\n"
            f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
            f"Rewards received: <b>{int(stats.get('total_submissions') or 0)}</b>\n"
            f"Total rewards received: <b>{_format_gd_amount(stats.get('total_earned') or 0)}</b>\n"
            f"Last reward amount: <b>{_format_gd_amount(stats.get('last_reward_amount') or 0)}</b>\n"
            f"Last reward date: <code>{html.escape(str(stats.get('last_reward_date') or 'none'))}</code>\n"
            f"Pending review: <b>{pending_count}</b>\n"
            f"Latest submission status: <code>{html.escape(str(latest_status))}</code>"
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Telegram Community Stories rewards failed: %s", exc)
        text = "⚠️ Community Stories reward history could not be loaded. Please try again later."
    send_message(chat_id, text, _community_stories_keyboard(False))


def handle_community_stories_submit_prompt(chat_id, telegram_user):
    """Prompt a Telegram user to send a Community Stories X/Twitter URL."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "🌟 Please save your wallet with /start first.")
        return

    try:
        text, can_submit = _community_stories_status_message(saved_wallet)
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Telegram Community Stories submit status failed: %s", exc)
        send_message(chat_id, "⚠️ Community Stories status could not be loaded. Please try again later.")
        return

    if not can_submit:
        send_message(chat_id, text, _community_stories_keyboard(False))
        return

    _TELEGRAM_COMMUNITY_STORIES_SESSIONS[str(telegram_user_id)] = {
        "chat_id": chat_id,
        "wallet": saved_wallet,
        "awaiting": "tweet_url",
        "created_at": time.time(),
    }
    send_message(
        chat_id,
        "📝 <b>Submit Community Story</b>\n\n"
        "Send your public X/Twitter post URL now.\n"
        "The bot will validate it using the current Community Stories settings from the admin dashboard.",
    )


def handle_community_stories_text(chat_id, telegram_user, text) -> bool:
    """Submit pending Community Stories text input. Returns True if handled."""
    telegram_user_id = str(telegram_user.get("id"))
    session_data = _TELEGRAM_COMMUNITY_STORIES_SESSIONS.get(telegram_user_id)
    if not session_data or session_data.get("awaiting") != "tweet_url":
        return False

    from community_stories.community_stories_service import community_stories_service

    wallet = _normalize_wallet(session_data.get("wallet") or "")
    if not wallet:
        _TELEGRAM_COMMUNITY_STORIES_SESSIONS.pop(telegram_user_id, None)
        send_message(chat_id, "⚠️ Your Community Stories session expired. Please use /stories again.")
        return True

    tweet_url = (text or "").strip()
    result = community_stories_service.submit_tweet(wallet, tweet_url)
    if result.get("success"):
        _TELEGRAM_COMMUNITY_STORIES_SESSIONS.pop(telegram_user_id, None)
        send_message(
            chat_id,
            "✅ <b>Community Story submitted!</b>\n\n"
            f"Submission ID: <code>{html.escape(str(result.get('submission_id')))}</code>\n"
            "Status: <b>pending admin review</b>\n\n"
            "Your reward and cooldown will follow the Community Stories settings configured in the admin dashboard.",
            _community_stories_keyboard(False),
        )
        return True

    error = result.get("error") or "Submission failed."
    next_time = result.get("next_window") or result.get("next_participation")
    extra = f"\nNext participation: <code>{html.escape(str(next_time))} UTC</code>" if next_time else ""
    send_message(
        chat_id,
        "⚠️ <b>Community Story was not submitted</b>\n\n"
        f"{html.escape(str(error))}{extra}\n\n"
        "Use /stories to review the latest admin-dashboard settings.",
        _community_stories_keyboard(False),
    )
    return True


def _trustpilot_keyboard(status: str = None):
    """Inline buttons for the Telegram Trustpilot Review flow."""
    keyboard = [[
        {"text": "📊 Status", "callback_data": "trustpilot_status"},
        {"text": "🏆 Rewards", "callback_data": "trustpilot_rewards"},
    ]]
    # Show "Submit Review URL" button only if not completed
    # (allow for pending, declined, and first-time users)
    if status != "completed":
        keyboard.insert(0, [{"text": "⭐ Submit Review URL", "callback_data": "trustpilot_submit"}])
    return {"inline_keyboard": keyboard}


def handle_trustpilot_task(chat_id, telegram_user):
    """Show Trustpilot Review task with full instructions."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "⭐ Please save your wallet with /start first.")
        return

    try:
        from trustpilot_task.trustpilot_task import trustpilot_task_service
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            stats = loop.run_until_complete(trustpilot_task_service.get_task_stats(saved_wallet))
        finally:
            loop.close()

        if stats.get("success"):
            has_completed = stats.get("has_completed", False)
            total_earned = stats.get("total_earned", 0)
            submissions = stats.get("submissions", [])
            
            if has_completed:
                # Task already completed - show simple message
                text = (
                    "✅ <b>Task Completed!</b>\n\n"
                    "You have already completed this task.\n"
                    "Your review has been approved and reward disbursed.\n\n"
                    f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
                    f"Total earned: <b>{_format_gd_amount(total_earned)}</b>"
                )
                keyboard = _trustpilot_keyboard("completed")
            elif submissions:
                latest = submissions[0]
                status = latest.get("status", "unknown")
                if status == "pending":
                    text = (
                        "⏳ <b>Submission Under Review</b>\n\n"
                        "Your Trustpilot review is pending admin approval.\n"
                        "You will receive your reward once approved.\n\n"
                        f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
                        f"Total earned: <b>{_format_gd_amount(total_earned)}</b>"
                    )
                elif status == "declined":
                    # Show instructions again for declined users
                    text = (
                        "❌ <b>Submission Declined</b>\n\n"
                        "Your previous submission was declined.\n"
                        "You may submit a new review URL.\n\n"
                        "━━━━━━━━━━━━━━━━━━━━\n"
                        "📋 <b>Instructions</b>\n"
                        "━━━━━━━━━━━━━━━━━━━━\n\n"
                        "1️⃣ Go to <a href='https://www.trustpilot.com/review/gooddollar.org'>Trustpilot GoodDollar page</a> and write a genuine review based on your personal experience\n\n"
                        "2️⃣ Copy your review URL from the browser address bar\n\n"
                        "3️⃣ Paste it here to submit\n\n"
                        "━━━━━━━━━━━━━━━━━━━━\n"
                        "⚠️ <b>IMPORTANT NOTICE</b>\n"
                        "━━━━━━━━━━━━━━━━━━━━\n\n"
                        "• Your review MUST be based on your REAL personal experience with GoodDollar\n"
                        "• Fake or dishonest reviews will be rejected\n"
                        "• Reviews must follow Trustpilot's community guidelines\n"
                        "• You can only complete this task ONCE\n"
                        "• After approval, you cannot submit another review\n\n"
                        "━━━━━━━━━━━━━━━━━━━━\n"
                        f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
                        f"Total earned: <b>{_format_gd_amount(total_earned)}</b>"
                    )
                    keyboard = _trustpilot_keyboard()
                else:
                    text = (
                        f"ℹ️ <b>Status: {status.upper()}</b>\n\n"
                        f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
                        f"Total earned: <b>{_format_gd_amount(total_earned)}</b>"
                    )
                    keyboard = _trustpilot_keyboard()
            else:
                # First time user - show full instructions
                text = (
                    "⭐ <b>Trustpilot Review Task</b>\n\n"
                    "━━━━━━━━━━━━━━━━━━━━\n"
                    "📋 <b>Instructions</b>\n"
                    "━━━━━━━━━━━━━━━━━━━━\n\n"
                    "1️⃣ Go to <a href='https://www.trustpilot.com/review/gooddollar.org'>Trustpilot GoodDollar page</a> and write a genuine review based on your personal experience\n\n"
                    "2️⃣ Copy your review URL from the browser address bar\n\n"
                    "3️⃣ Paste it here to submit\n\n"
                    "━━━━━━━━━━━━━━━━━━━━\n"
                    "⚠️ <b>IMPORTANT NOTICE</b>\n"
                    "━━━━━━━━━━━━━━━━━━━━\n\n"
                    "• Your review MUST be based on your REAL personal experience with GoodDollar\n"
                    "• Fake or dishonest reviews will be rejected\n"
                    "• Reviews must follow Trustpilot's community guidelines\n"
                    "• You can only complete this task ONCE\n"
                    "• After approval, you cannot submit another review\n\n"
                    "━━━━━━━━━━━━━━━━━━━━\n"
                    f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
                    f"Total earned: <b>{_format_gd_amount(total_earned)}</b>"
                )
                keyboard = _trustpilot_keyboard()
        else:
            text = "⚠️ Could not load Trustpilot task status. Please try again later."
            keyboard = _learn_earn_keyboard(telegram_user_id, saved_wallet)
    except Exception as exc:
        logger.error("❌ Telegram Trustpilot task failed: %s", exc)
        text = "⚠️ Trustpilot task could not be loaded. Please try again later."
        keyboard = _learn_earn_keyboard(telegram_user_id, saved_wallet)
    
    send_message(chat_id, text, keyboard)


def handle_trustpilot_submit_prompt(chat_id, telegram_user):
    """Prompt a Telegram user to send a Trustpilot review URL."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "⭐ Please save your wallet with /start first.")
        return

    try:
        from trustpilot_task.trustpilot_task import trustpilot_task_service
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            stats = loop.run_until_complete(trustpilot_task_service.get_task_stats(saved_wallet))
        finally:
            loop.close()

        if stats.get("has_completed"):
            # User already completed the task - show clear message
            text = (
                "✅ <b>Task Already Completed!</b>\n\n"
                "You have already submitted and received your reward for this task.\n"
                "This task can only be completed once per wallet.\n\n"
                "💡 <b>What you can do:</b>\n"
                "• Tap 📊 Status to view your submission details\n"
                "• Tap 🏆 Rewards to view your reward history\n\n"
                "Thank you for your review! 🙏"
            )
            send_message(chat_id, text, _trustpilot_keyboard("completed"))
            return
        
        if stats.get("submissions"):
            latest = stats["submissions"][0]
            status = latest.get("status", "unknown")
            
            if status == "pending":
                # User has pending submission - show clear message with details
                review_url = latest.get("review_url", "N/A")
                submitted_at = latest.get("created_at", "")
                if submitted_at:
                    from datetime import datetime
                    try:
                        dt = datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
                        submitted_at = dt.strftime("%Y-%m-%d %H:%M UTC")
                    except:
                        pass
                
                text = (
                    "⏳ <b>Submission Under Review</b>\n\n"
                    "You have a pending Trustpilot review submission awaiting admin approval.\n\n"
                    f"📎 Your URL: <code>{review_url}</code>\n"
                    f"📅 Submitted: {submitted_at}\n\n"
                    "Your reward will be disbursed automatically once approved.\n"
                    "Please be patient - approval usually takes 24-48 hours.\n\n"
                    "💡 <b>What you can do:</b>\n"
                    "• Tap 📊 Status to view your submission details\n"
                    "• Tap 🏆 Rewards to view your reward history\n\n"
                    "⚠️ Do NOT submit another review while this is pending."
                )
                send_message(chat_id, text, _trustpilot_keyboard("pending"))
                return
            
            elif status == "declined":
                # User had submission declined - allow re-submission
                reason = latest.get("decline_reason", "No reason provided")
                text = (
                    "❌ <b>Previous Submission Declined</b>\n\n"
                    f"📝 Reason: {reason}\n\n"
                    "You may submit a new review URL. Please make sure:\n"
                    "• Your review is based on REAL personal experience\n"
                    "• It follows Trustpilot's community guidelines\n"
                    "• The URL format is correct (from your Trustpilot profile page)\n\n"
                    "Tap ⭐ Submit Review URL to try again."
                )
                send_message(chat_id, text, _trustpilot_keyboard("declined"))
                return

        # Start new submission session
        _TELEGRAM_TRUSTPILOT_SESSIONS[str(telegram_user_id)] = {
            "chat_id": chat_id,
            "wallet": saved_wallet,
            "awaiting": "review_url",
            "created_at": time.time(),
        }
        send_message(
            chat_id,
            "⭐ <b>Submit Trustpilot Review</b>\n\n"
            "IMPORTANT: Your review must be based on your REAL personal experience with GoodDollar.\n\n"
            "Fake reviews will be rejected.\n\n"
            "Send your Trustpilot review URL (e.g., https://www.trustpilot.com/review/gooddollar.org)",
            _trustpilot_keyboard(),
        )
    except Exception as exc:
        logger.error("❌ Telegram Trustpilot submit prompt failed: %s", exc)
        send_message(chat_id, "⚠️ Could not start Trustpilot submission. Please try again later.")


def handle_trustpilot_text(chat_id, telegram_user, text) -> bool:
    """Submit pending Trustpilot review URL. Returns True if handled."""
    telegram_user_id = str(telegram_user.get("id"))
    session_data = _TELEGRAM_TRUSTPILOT_SESSIONS.get(telegram_user_id)
    if not session_data or session_data.get("awaiting") != "review_url":
        return False

    wallet = _normalize_wallet(session_data.get("wallet") or "")
    if not wallet:
        _TELEGRAM_TRUSTPILOT_SESSIONS.pop(telegram_user_id, None)
        send_message(chat_id, "⚠️ Your Trustpilot session expired. Please try again with /trustpilot.")
        return True

    review_url = (text or "").strip()
    
    # Validate URL format - must be trustpilot.com/reviews/xxx
    if not review_url or not re.search(r'trustpilot\.com/reviews/[a-zA-Z0-9]+', review_url.lower()):
        send_message(
            chat_id,
            "⚠️ <b>Invalid URL format</b>\n\n"
            "Please send a valid Trustpilot review URL.\n\n"
            "Example:\n"
            "<code>https://www.trustpilot.com/reviews/682187e9b3ac2f2c0586dbaf</code>\n\n"
            "Make sure to copy the full URL from your browser after writing your review.",
            _trustpilot_keyboard(),
        )
        return True

    try:
        from trustpilot_task.trustpilot_task import trustpilot_task_service
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(trustpilot_task_service.submit_review(wallet, review_url))
        finally:
            loop.close()

        _TELEGRAM_TRUSTPILOT_SESSIONS.pop(telegram_user_id, None)

        if result.get("success"):
            send_message(
                chat_id,
                "✅ <b>Review Submitted!</b>\n\n"
                "Your Trustpilot review URL has been submitted for admin review.\n"
                "You will receive your reward once approved.\n\n"
                "⏳ Please wait for admin approval.",
                _trustpilot_keyboard("pending"),
            )
        else:
            error = result.get("error", "Submission failed.")
            if result.get("task_completed"):
                send_message(chat_id, "✅ You have already completed this task!", _trustpilot_keyboard("completed"))
            else:
                send_message(
                    chat_id,
                    f"⚠️ <b>Submission Failed</b>\n\n{html.escape(str(error))}\n\n"
                    "Use /trustpilot to try again.",
                    _trustpilot_keyboard(),
                )
    except Exception as exc:
        logger.error("❌ Telegram Trustpilot text submission failed: %s", exc)
        _TELEGRAM_TRUSTPILOT_SESSIONS.pop(telegram_user_id, None)
        send_message(chat_id, "⚠️ Submission failed. Please try again with /trustpilot.")

    return True


def handle_trustpilot_rewards(chat_id, telegram_user):
    """Show Trustpilot task reward history for a Telegram wallet."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "⭐ Please save your wallet with /start first.")
        return

    try:
        from trustpilot_task.trustpilot_task import trustpilot_task_service
        history = trustpilot_task_service.get_transaction_history(saved_wallet, limit=10)
        
        if history.get("success"):
            summary = history.get("summary", {})
            total_earned = summary.get("total_earned", 0)
            transactions = history.get("transactions", [])
            
            text = (
                "🏆 <b>Your Trustpilot Review Rewards</b>\n\n"
                f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>\n"
                f"Total earned: <b>{_format_gd_amount(total_earned)}</b>\n"
                f"Submissions: <b>{summary.get('transaction_count', 0)}</b>\n"
            )
            
            if transactions:
                text += "\n<b>Recent Activity:</b>\n"
                for tx in transactions[:5]:
                    status_emoji = "✅" if tx.get("status") == "approved" else ("⏳" if tx.get("status") == "pending" else "❌")
                    text += f"{status_emoji} {tx.get('status', 'unknown').upper()} - {_format_gd_amount(tx.get('reward_amount', 0))}\n"
        else:
            text = "⚠️ Could not load reward history. Please try again later."
    except Exception as exc:
        logger.error("❌ Telegram Trustpilot rewards failed: %s", exc)
        text = "⚠️ Reward history could not be loaded. Please try again later."
    
    send_message(chat_id, text, _trustpilot_keyboard())


def handle_wallet(chat_id, telegram_user):
    """Handle /wallet command — show or request saved wallet."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "💰 No wallet saved yet. Please send your wallet address now.")
        return

    text = (
        "💰 <b>Saved GoodMarket Wallet</b>\n\n"
        f"<code>{saved_wallet}</code>\n\n"
        "Send /change_wallet if you want to replace it."
    )
    send_message(chat_id, text, _learn_earn_keyboard(telegram_user_id, saved_wallet))



def _format_telegram_balance_line(label: str, result: dict) -> str:
    """Format a single token balance line for Telegram."""
    if not result or not result.get("success"):
        return f"• {html.escape(label)}: <code>unavailable</code>"

    formatted = str(result.get("balance_formatted") or f"{float(result.get('balance') or 0):,.6f} {label}")
    return f"• {html.escape(label)}: <b>{html.escape(formatted)}</b>"


def handle_balance(chat_id, telegram_user):
    """Handle /balance command and balance button for the saved Celo wallet."""
    telegram_user_id = telegram_user.get("id")
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not saved_wallet:
        send_message(chat_id, "💰 No wallet saved yet. Please send your wallet address first with /start.")
        return

    try:
        from blockchain import (
            get_celo_balance,
            get_cusd_balance,
            get_gooddollar_balance,
            get_usdc_balance,
            get_usdt_balance,
        )

        balances = {
            "G$": get_gooddollar_balance(saved_wallet, include_price=False),
            "CELO": get_celo_balance(saved_wallet),
            "cUSD": get_cusd_balance(saved_wallet),
            "USDT": get_usdt_balance(saved_wallet),
            "USDC": get_usdc_balance(saved_wallet),
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Telegram balance check failed for %s: %s", _mask_wallet(saved_wallet), exc)
        send_message(
            chat_id,
            "⚠️ <b>Balance check failed.</b>\n\nPlease try again in a few minutes.",
            _learn_earn_keyboard(telegram_user_id, saved_wallet),
        )
        return

    lines = [
        "💰 <b>Your Celo Wallet Balances</b>",
        "",
        f"Wallet: <code>{_mask_wallet(saved_wallet)}</code>",
        "Network: <b>Celo</b>",
        "",
    ]
    lines.extend(_format_telegram_balance_line(label, result) for label, result in balances.items())
    lines.extend([
        "",
        "Balances are read-only and cached briefly to keep the bot fast.",
    ])
    send_message(chat_id, "\n".join(lines), _learn_earn_keyboard(telegram_user_id, saved_wallet))

def handle_change_wallet(chat_id):
    """Prompt user to send a replacement wallet address."""
    send_message(
        chat_id,
        "🔁 <b>Change Wallet</b>\n\nSend the new wallet address you want to use for GoodMarket Learn &amp; Earn.",
    )


def handle_wallet_text(chat_id, telegram_user, text):
    """Treat non-command Telegram messages as wallet submissions."""
    wallet = _normalize_wallet(text)
    if not wallet:
        send_message(
            chat_id,
            "❌ That does not look like a valid wallet address. Please send a 42-character address that starts with <code>0x</code>.",
        )
        return

    if not _ensure_wallet_is_face_verified(chat_id, wallet):
        return

    if not _save_wallet_session(telegram_user, chat_id, wallet):
        logger.warning(
            "Telegram wallet DB save failed; sending signed temporary Learn & Earn login "
            f"for user {telegram_user.get('id')}"
        )
        text_msg = (
            "⚠️ <b>I could not permanently save your wallet yet.</b>\n\n"
            f"Wallet: <code>{_mask_wallet(wallet)}</code>\n\n"
            "You can still continue with this signed Telegram login button. "
            "If the bot asks for your wallet again later, the database save still needs to be fixed."
        )
        send_message(chat_id, text_msg, _learn_earn_keyboard(telegram_user.get("id"), wallet))
        return

    text_msg = (
        "✅ <b>Face verification confirmed — pasok ka na!</b>\n\n"
        f"Wallet: <code>{_mask_wallet(wallet)}</code>\n\n"
        "Your verified wallet is saved. You can now start Learn &amp; Earn directly in this Telegram chat without opening a Mini App or connecting a wallet. "
        "Your rewards, quiz history, and Community Stories submissions will use this wallet in GoodMarket Overview."
    )
    send_message(chat_id, text_msg, _learn_earn_keyboard(telegram_user.get("id"), wallet))


@telegram_bot.route("/telegram/learn-earn-login", methods=["GET"])
def telegram_learn_earn_login():
    """Convert a signed Telegram login token into a normal GoodMarket session."""
    token = request.args.get("token", "")
    if not token:
        return redirect(url_for("routes.index"))

    try:
        payload = _login_serializer().loads(token, max_age=TELEGRAM_LOGIN_TOKEN_MAX_AGE_SECONDS)
    except SignatureExpired:
        return "This Telegram login link has expired. Please go back to the bot and tap Learn & Earn again.", 410
    except BadSignature:
        return "Invalid Telegram login link.", 400

    wallet = _normalize_wallet(payload.get("wallet", ""))
    telegram_user_id = str(payload.get("telegram_user_id", ""))
    saved_wallet = _get_saved_wallet(telegram_user_id)
    if not wallet:
        return "Invalid Telegram login link.", 400
    if saved_wallet and saved_wallet != wallet:
        return "Telegram wallet session does not match this login link. Please save your wallet in the bot again.", 403
    if not saved_wallet:
        logger.warning(
            "Telegram Learn & Earn login proceeding from signed token without a saved DB row "
            f"for user {telegram_user_id}"
        )

    session["wallet_address"] = wallet
    session["wallet"] = wallet
    session["verified"] = True
    session["ubi_verified"] = False
    session["login_method"] = "telegram_wallet"
    session["telegram_user_id"] = telegram_user_id
    session.permanent = True
    session.modified = True

    return redirect("/learn-earn/")


@telegram_bot.route("/telegram/webhook", methods=["POST"])
def webhook():
    """Receive and handle Telegram updates."""
    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not set")
        return jsonify({"ok": False}), 500

    if TELEGRAM_WEBHOOK_SECRET_TOKEN:
        provided_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if provided_secret != TELEGRAM_WEBHOOK_SECRET_TOKEN:
            logger.warning("Rejected Telegram webhook: invalid secret token header")
            return jsonify({"ok": False, "error": "forbidden"}), 403

    update = request.get_json(silent=True)
    if not update:
        return jsonify({"ok": False}), 400

    try:
        message = update.get("message") or update.get("edited_message")
        callback = update.get("callback_query")

        if message:
            chat_id = message["chat"]["id"]
            telegram_user = message.get("from", {})
            text = message.get("text", "").strip()

            if text.startswith("/start"):
                handle_start(chat_id, telegram_user)
            elif text.startswith("/help"):
                handle_help(chat_id, telegram_user)
            elif text.startswith("/earn"):
                handle_earn(chat_id, telegram_user)
            elif text.startswith("/stories"):
                handle_community_stories(chat_id, telegram_user)
            elif text.startswith("/market"):
                handle_market(chat_id)
            elif text.startswith("/news"):
                handle_news(chat_id, text)
            elif text.startswith("/wallet"):
                handle_wallet(chat_id, telegram_user)
            elif text.startswith("/balance"):
                handle_balance(chat_id, telegram_user)
            elif text.startswith("/change_wallet"):
                handle_change_wallet(chat_id)
            elif text.startswith("/trustpilot"):
                handle_trustpilot_task(chat_id, telegram_user)
            elif handle_trustpilot_text(chat_id, telegram_user, text):
                pass
            elif handle_community_stories_text(chat_id, telegram_user, text):
                pass
            else:
                handle_wallet_text(chat_id, telegram_user, text)

        if callback:
            callback_user = callback.get("from", {})
            # Get chat_id from message, with fallback to inline_message_id (for inline bot queries)
            callback_message = callback.get("message") or {}
            callback_chat_id = callback_message.get("chat", {}).get("id")
            callback_message_id = callback_message.get("message_id")
            callback_data = callback.get("data", "")
            callback_id = callback.get("id")
            
            # Log callback for debugging
            logger.info(f"Received callback: data={callback_data}, chat_id={callback_chat_id}, message_id={callback_message_id}, callback_id={callback_id}")
            
            # Only process if we have a chat_id (for private/group chats)
            if callback_chat_id:
                try:
                    requests.post(
                        f"{TELEGRAM_API}/answerCallbackQuery",
                        json={"callback_query_id": callback_id},
                        timeout=5,
                    )
                except Exception as e:
                    logger.error(f"Failed to answer callback query: {e}")
                
                if callback_data == "learn_earn_chat":
                    handle_earn(callback_chat_id, callback_user)
                elif callback_data == "community_stories":
                    handle_community_stories(callback_chat_id, callback_user)
                elif callback_data == "community_stories_status":
                    handle_community_stories(callback_chat_id, callback_user)
                elif callback_data == "community_stories_rewards":
                    handle_community_stories_rewards(callback_chat_id, callback_user)
                elif callback_data == "community_stories_submit":
                    handle_community_stories_submit_prompt(callback_chat_id, callback_user)
                elif callback_data == "trustpilot_task":
                    handle_trustpilot_task(callback_chat_id, callback_user)
                elif callback_data == "trustpilot_submit":
                    handle_trustpilot_submit_prompt(callback_chat_id, callback_user)
                elif callback_data == "trustpilot_status":
                    handle_trustpilot_task(callback_chat_id, callback_user)
                elif callback_data == "trustpilot_rewards":
                    handle_trustpilot_rewards(callback_chat_id, callback_user)
                elif callback_data.startswith("news_"):
                    handle_news_callback(callback_chat_id, callback_data)
                elif callback_data == "show_wallet":
                    handle_wallet(callback_chat_id, callback_user)
                elif callback_data == "check_balance":
                    handle_balance(callback_chat_id, callback_user)
                elif callback_data.startswith("le_mod_next:"):
                    handle_learn_earn_module_next(callback_chat_id, callback_user.get("id"), callback_data)
                elif callback_data.startswith("le_ans:"):
                    handle_learn_earn_answer(callback_chat_id, callback_user.get("id"), callback_data)
            else:
                # For inline bots without chat_id - use answerCallbackQuery with error text
                logger.warning(f"Callback received without chat_id: {callback_data}")
                try:
                    requests.post(
                        f"{TELEGRAM_API}/answerCallbackQuery",
                        json={
                            "callback_query_id": callback_id,
                            "text": "⚠️ This action is not available in inline mode. Please use the bot directly.",
                            "show_alert": True
                        },
                        timeout=5,
                    )
                except Exception as e:
                    logger.error(f"Failed to answer inline callback: {e}")

    except Exception as e:
        logger.error(f"Telegram webhook error: {e}")

    return jsonify({"ok": True})


@telegram_bot.route("/telegram/setup-webhook", methods=["GET"])
def setup_webhook():
    """Register webhook URL with Telegram. Call this once after deploying."""
    if not TELEGRAM_BOT_TOKEN:
        return jsonify({"error": "TELEGRAM_BOT_TOKEN not set"}), 500

    webhook_url = f"{APP_URL}/telegram/webhook"
    resp = requests.post(
        f"{TELEGRAM_API}/setWebhook",
        json={
            "url": webhook_url,
            "allowed_updates": ["message", "callback_query"],
            "drop_pending_updates": True,
            **(
                {"secret_token": TELEGRAM_WEBHOOK_SECRET_TOKEN}
                if TELEGRAM_WEBHOOK_SECRET_TOKEN
                else {}
            ),
        },
        timeout=15,
    )
    result = resp.json()
    logger.info(f"Webhook setup result: {result}")
    return jsonify(result)


@telegram_bot.route("/telegram/webhook-info", methods=["GET"])
def webhook_info():
    """Check current webhook status."""
    if not TELEGRAM_BOT_TOKEN:
        return jsonify({"error": "TELEGRAM_BOT_TOKEN not set"}), 500
    resp = requests.get(f"{TELEGRAM_API}/getWebhookInfo", timeout=10)
    return jsonify(resp.json())
