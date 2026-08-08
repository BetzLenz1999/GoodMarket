"""Best-effort Telegram push helpers shared across the platform.

Centralizes direct-to-Telegram-Bot-API messaging so admin actions (such as
broadcasting an announcement) can push notifications to Telegram bot users
without depending on the telegram_bot Flask blueprint (avoids circular imports).

All operations are best-effort: they never raise, so a notification failure can
never break the admin action that triggered them.

Requires the ``TELEGRAM_BOT_TOKEN`` environment variable (the same one the bot
webhook already uses).
"""
import html
import logging
import os
import time
from typing import Optional, Dict, Any

import requests

from supabase_client import get_supabase_admin_client, get_supabase_client, safe_supabase_operation

logger = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}" if TELEGRAM_BOT_TOKEN else ""

# Telegram allows ~30 messages/second to distinct chats. A small delay keeps
# large broadcasts within the rate limit.
_BROADCAST_SEND_DELAY_SECONDS = float(os.getenv("TELEGRAM_BROADCAST_SEND_DELAY_SECONDS", "0.05"))


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


def broadcast_message(title: str, message: str) -> Dict[str, Any]:
    """Push a broadcast message to every Telegram bot user.

    Runs synchronously (call from a background thread for large audiences).
    Returns a summary dict: {total, sent, failed}.
    """
    summary = {"total": 0, "sent": 0, "failed": 0}
    if not TELEGRAM_API:
        logger.warning("⚠️ Telegram broadcast skipped: TELEGRAM_BOT_TOKEN not configured")
        return summary

    supabase = get_supabase_admin_client() or get_supabase_client()
    if not supabase:
        logger.warning("⚠️ Telegram broadcast skipped: database unavailable")
        return summary

    try:
        result = safe_supabase_operation(
            lambda: supabase.table('telegram_wallet_sessions')
                .select('telegram_chat_id')
                .not_.is_('telegram_chat_id', 'null')
                .neq('telegram_chat_id', '')
                .execute(),
            fallback_result=None,
            operation_name="fetch telegram chat ids for broadcast"
        )
    except Exception as e:
        logger.warning(f"⚠️ Telegram broadcast: could not fetch chat ids: {e}")
        return summary

    chat_ids = []
    seen = set()
    for row in (result.data if result and result.data else []):
        cid = row.get('telegram_chat_id')
        if cid and cid not in seen:
            seen.add(cid)
            chat_ids.append(cid)

    summary["total"] = len(chat_ids)
    if not chat_ids:
        logger.info("📢 Telegram broadcast: no Telegram users to notify")
        return summary

    text = f"📢 <b>{html.escape(title)}</b>\n\n{html.escape(message)}"
    for cid in chat_ids:
        if send_message(cid, text):
            summary["sent"] += 1
        else:
            summary["failed"] += 1
        if _BROADCAST_SEND_DELAY_SECONDS > 0:
            time.sleep(_BROADCAST_SEND_DELAY_SECONDS)

    logger.info(f"📢 Telegram broadcast delivered: sent={summary['sent']} failed={summary['failed']} total={summary['total']}")
    return summary


def broadcast_message_async(title: str, message: str) -> None:
    """Fire-and-forget wrapper that runs broadcast_message in a daemon thread."""
    import threading
    threading.Thread(
        target=broadcast_message,
        args=(title, message),
        daemon=True,
        name="telegram-broadcast"
    ).start()
