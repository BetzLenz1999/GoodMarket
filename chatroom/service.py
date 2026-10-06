"""Community Chatroom — business logic.

A single PUBLIC room where every signed-in user sees every message. Messages
are attributed to the poster's USERNAME; the wallet address is the ownership
key only and is never returned to the browser.

Design notes (mirroring the rest of this codebase):
- Reads go through the service-role client first so RLS cannot silently hide
  rows (the lotto/gcash lesson).
- The feature is HIDDEN by default: ``is_enabled()`` reads the
  ``chatroom_feature`` row from ``maintenance_settings`` and fails CLOSED, so a
  database hiccup can never leak the room before an admin turns it on.
- Every public function returns a plain dict and never raises — the routes
  translate the dict into a JSON response.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

ROOM = "general"
MAX_MESSAGE_LENGTH = int(os.getenv("CHATROOM_MAX_MESSAGE_LENGTH", "500"))
MIN_MESSAGE_LENGTH = 1
RATE_LIMIT_SECONDS = int(os.getenv("CHATROOM_RATE_LIMIT_SECONDS", "3"))
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
FEATURE_NAME = "chatroom_feature"

# Strip control characters (including zero-width/line-separator tricks) so a
# message can never smuggle invisible content into the rendered log.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029]")
_WHITESPACE = re.compile(r"\s+")
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,24}$")


def _get_supabase():
    """Service-role client first (RLS-safe reads), falling back to anon."""
    try:
        from supabase_client import get_supabase_admin_client, get_supabase_client

        return get_supabase_admin_client() or get_supabase_client()
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: supabase client unavailable: %s", exc)
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:  # noqa: BLE001
        return None


# ── Identity ─────────────────────────────────────────────────────────────────

def short_wallet(wallet: str | None) -> str:
    """Public fallback label when a user has no username yet."""
    wallet = (wallet or "").strip()
    if len(wallet) >= 10:
        return f"{wallet[:6]}…{wallet[-4:]}"
    return wallet or "anonymous"


def get_username(wallet: str | None) -> str | None:
    if not wallet:
        return None
    supabase = _get_supabase()
    if not supabase:
        return None
    try:
        result = (
            supabase.table("user_data")
            .select("username")
            .ilike("wallet_address", wallet)
            .limit(1)
            .execute()
        )
        if result and result.data:
            username = (result.data[0].get("username") or "").strip()
            return username or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: username lookup failed: %s", exc)
    return None


def display_name(wallet: str | None) -> str:
    """Username when set, otherwise a shortened wallet address."""
    return get_username(wallet) or short_wallet(wallet)


def is_admin_wallet(wallet: str | None) -> bool:
    """Whether this wallet is an admin (``user_data.is_admin``).

    Admin status is decided SERVER-SIDE. The chatroom only ever exposes the
    resulting boolean to the browser — the wallet address itself stays private.
    """
    if not wallet:
        return False
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("user_data")
            .select("is_admin")
            .ilike("wallet_address", wallet)
            .limit(1)
            .execute()
        )
        if result and result.data:
            return bool(result.data[0].get("is_admin", False))
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: admin lookup failed: %s", exc)
    return False


def _admin_wallets(wallets: list[str]) -> set[str]:
    """Resolve a batch of wallets to the subset that are admins.

    One query (not N+1) with an ``or_`` of ``ilike`` clauses — addresses are
    hex-only so an ilike match can never widen unexpectedly, and it keeps the
    lookup case-insensitive (the repo-wide checksummed/lowercase lesson).
    """
    cleaned = sorted({(w or "").strip().lower() for w in wallets if w})
    if not cleaned:
        return set()
    supabase = _get_supabase()
    if not supabase:
        return set()
    clauses = ",".join(f"wallet_address.ilike.{w}" for w in cleaned)
    try:
        result = (
            supabase.table("user_data")
            .select("wallet_address, is_admin")
            .or_(clauses)
            .execute()
        )
        return {
            (r.get("wallet_address") or "").strip().lower()
            for r in (result.data or [])
            if r.get("is_admin")
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: admin batch lookup failed: %s", exc)
        return set()


def get_public_profile(username: str | None) -> dict:
    """Return the deliberately small public profile exposed by the chatroom.

    Chat messages must not become a way to discover a member's wallet address
    or private earnings/activity.  A profile therefore contains only the
    member's public username, their join date, and public-room message count.
    """
    name = (username or "").strip().lstrip("@")
    if not _USERNAME_RE.fullmatch(name):
        return {"success": False, "error": "Member not found", "code": "not_found"}

    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "code": "db"}
    try:
        member_result = (
            supabase.table("user_data")
            .select("wallet_address, username, created_at")
            .ilike("username", name)
            .limit(1)
            .execute()
        )
        if not member_result or not member_result.data:
            return {"success": False, "error": "Member not found", "code": "not_found"}

        member = member_result.data[0]
        wallet = (member.get("wallet_address") or "").strip()
        # Count only messages that are currently visible in the public room.
        # Never return this query's wallet key to the caller.
        messages_result = (
            supabase.table("community_chat_messages")
            .select("id", count="exact")
            .eq("room", ROOM)
            .eq("is_deleted", False)
            .ilike("wallet_address", wallet)
            .execute()
        )
        message_count = getattr(messages_result, "count", None) if messages_result else None
        if message_count is None:
            message_count = len(messages_result.data or []) if messages_result else 0
        return {
            "success": True,
            "profile": {
                "username": (member.get("username") or name).strip(),
                "joined_at": member.get("created_at"),
                "message_count": message_count,
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: public profile lookup failed: %s", exc)
        return {"success": False, "error": "Unable to load this member", "code": "db"}


# ── Feature flag ─────────────────────────────────────────────────────────────

def is_enabled() -> bool:
    """True only when the admin has turned the chatroom ON.

    Fails CLOSED: a missing row, a DB error or an unreadable value all mean
    "not enabled", so the room stays hidden until explicitly switched on.
    """
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("maintenance_settings")
            .select("is_maintenance")
            .eq("feature_name", FEATURE_NAME)
            .limit(1)
            .execute()
        )
        if not result or not result.data:
            return False
        return not bool(result.data[0].get("is_maintenance", True))
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: feature flag read failed: %s", exc)
        return False


# ── Moderation state ─────────────────────────────────────────────────────────

def is_banned(wallet: str | None) -> bool:
    if not wallet:
        return False
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("community_chat_bans")
            .select("wallet_address")
            .ilike("wallet_address", wallet)
            .limit(1)
            .execute()
        )
        return bool(result and result.data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: ban lookup failed: %s", exc)
        return False


def _seconds_until_allowed(wallet: str) -> int:
    """Remaining cooldown for this wallet (0 when allowed to post now)."""
    supabase = _get_supabase()
    if not supabase:
        return 0
    try:
        result = (
            supabase.table("community_chat_messages")
            .select("created_at")
            .ilike("wallet_address", wallet)
            .order("id", desc=True)
            .limit(1)
            .execute()
        )
        if not result or not result.data:
            return 0
        last = _parse_dt(result.data[0].get("created_at"))
        if not last:
            return 0
        elapsed = (_now() - last).total_seconds()
        if elapsed >= RATE_LIMIT_SECONDS:
            return 0
        return max(1, int(RATE_LIMIT_SECONDS - elapsed))
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom: rate-limit lookup failed: %s", exc)
        return 0


def can_post(wallet: str | None) -> dict:
    """Pre-flight for the UI so the send button reflects the real rules."""
    if not wallet:
        return {"allowed": False, "reason": "not_authenticated", "retry_after": 0}
    if not is_enabled():
        return {"allowed": False, "reason": "disabled", "retry_after": 0}
    if is_banned(wallet):
        return {"allowed": False, "reason": "banned", "retry_after": 0}
    wait = _seconds_until_allowed(wallet)
    if wait > 0:
        return {"allowed": False, "reason": "rate_limited", "retry_after": wait}
    return {"allowed": True, "reason": "ok", "retry_after": 0}


# ── Messages ─────────────────────────────────────────────────────────────────

def sanitize_message(raw: str | None) -> str:
    """Collapse whitespace and strip control characters. Length is validated
    by the caller so the two rules stay independently testable."""
    text = _CONTROL_CHARS.sub("", str(raw or ""))
    text = _WHITESPACE.sub(" ", text).strip()
    return text


def _public_row(row: dict, viewer_wallet: str | None,
                admin_wallets: set[str] | None = None) -> dict:
    """Shape a DB row for the browser — wallet address is dropped, ownership
    is reduced to a boolean ``is_me`` flag.

    Tip messages carry the token/amount/tx hash so the UI can render them as a
    gold card with a block-explorer link. The addresses behind them are still
    never included.

    ``is_admin`` is a boolean computed from the server-side admin set — the UI
    uses it for the ADMIN badge. It is never the wallet address.
    """
    owner = (row.get("wallet_address") or "").lower()
    message_type = row.get("message_type") or "text"
    public = {
        "id": row.get("id"),
        "username": row.get("username") or short_wallet(owner),
        "message": row.get("message"),
        "created_at": row.get("created_at"),
        "is_me": bool(viewer_wallet) and owner == viewer_wallet.lower(),
        "is_admin": bool(admin_wallets) and owner in admin_wallets,
        "message_type": message_type,
    }
    # Reply ownership is evaluated server-side so the recipient can be notified
    # without exposing either wallet address to the browser.
    if row.get("reply_to_id"):
        public["reply_to"] = {
            "id": row.get("reply_to_id"),
            "username": row.get("reply_to_username") or "member",
        }
        public["is_reply_to_me"] = bool(viewer_wallet) and (
            (row.get("reply_to_wallet") or "").lower() == viewer_wallet.lower()
        )

    if message_type == "tip":
        tx_hash = row.get("tip_tx_hash") or ""
        public["tip"] = {
            "token": row.get("tip_token"),
            "amount": row.get("tip_amount"),
            "tx_hash": tx_hash,
        }
    return public


def get_deleted_ids(since: str | None = None, limit: int = 200) -> dict:
    """Messages deleted at/after ``since`` (ISO timestamp), for the polling
    cursor. The UI removes any rendered row whose id is in this list, so a
    deletion made by an admin disappears for every other viewer within a poll
    tick — the ``after_id`` cursor alone never re-reads old rows."""
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "deleted_ids": []}
    try:
        query = (
            supabase.table("community_chat_messages")
            .select("id, deleted_at")
            .eq("room", ROOM)
            .eq("is_deleted", True)
        )
        if since:
            query = query.gte("deleted_at", since)
        # Ascending so the cursor advances monotonically — a burst larger than
        # `limit` is fully drained over successive polls instead of being cut
        # off. Re-fetching the boundary row is harmless (the UI dedupes by id).
        result = query.order("deleted_at").limit(int(limit)).execute()
        rows = list(result.data or [])
        deleted_ids = sorted({int(r["id"]) for r in rows if r.get("id") is not None})
        cursor = None
        for r in rows:
            if r.get("deleted_at"):
                if cursor is None or str(r["deleted_at"]) > cursor:
                    cursor = str(r["deleted_at"])
        return {"success": True, "deleted_ids": deleted_ids, "deleted_cursor": cursor}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: get_deleted_ids failed: %s", exc)
        return {"success": False, "error": "Failed to load deletions", "deleted_ids": []}


def get_messages(after_id: int | None = None, limit: int = DEFAULT_PAGE_SIZE,
                 viewer_wallet: str | None = None,
                 deleted_after: str | None = None) -> dict:
    """Messages in chronological order. With ``after_id`` only newer messages
    are returned (polling cursor). ``deleted_after`` additionally returns the
    ids deleted since that timestamp so the UI can prune them live."""
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "messages": []}
    try:
        size = max(1, min(int(limit or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
        query = (
            supabase.table("community_chat_messages")
            .select(
                "id, username, wallet_address, message, created_at, message_type, "
                "tip_token, tip_amount, tip_tx_hash, reply_to_id, reply_to_username, reply_to_wallet"
            )
            .eq("room", ROOM)
            .eq("is_deleted", False)
        )
        if after_id:
            query = query.gt("id", int(after_id)).order("id")
        else:
            query = query.order("id", desc=True)
        result = query.limit(size).execute()
        rows = list(result.data or [])
        if not after_id:
            rows.reverse()  # newest-first fetch → chronological for the UI
        # Resolve admin badges in ONE batched query (never N+1).
        admin_wallets = _admin_wallets([r.get("wallet_address") for r in rows])
        messages = [_public_row(r, viewer_wallet, admin_wallets) for r in rows]
        latest_id = max([m["id"] for m in messages], default=after_id or 0)
        payload = {
            "success": True,
            "messages": messages,
            "latest_id": latest_id,
            "has_more": len(rows) >= size,
            # Server clock, so the UI can seed its deletion cursor without
            # trusting the device clock (which may be skewed).
            "server_time": _now().isoformat(),
        }
        if deleted_after:
            deleted = get_deleted_ids(since=deleted_after)
            if deleted.get("success"):
                payload["deleted_ids"] = deleted["deleted_ids"]
                payload["deleted_cursor"] = deleted.get("deleted_cursor")
        return payload
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: get_messages failed: %s", exc)
        return {"success": False, "error": "Failed to load messages", "messages": []}


def post_message(wallet: str, raw_message: str, reply_to_id: int | None = None) -> dict:
    text = sanitize_message(raw_message)
    if len(text) < MIN_MESSAGE_LENGTH:
        return {"success": False, "error": "Message cannot be empty", "code": "empty"}
    if len(text) > MAX_MESSAGE_LENGTH:
        return {
            "success": False,
            "error": f"Message is too long (max {MAX_MESSAGE_LENGTH} characters)",
            "code": "too_long",
        }

    gate = can_post(wallet)
    if not gate["allowed"]:
        return {"success": False, "error": gate["reason"], "code": gate["reason"],
                "retry_after": gate["retry_after"]}

    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "code": "db"}

    username = get_username(wallet)
    reply = {}
    if reply_to_id is not None:
        try:
            target_id = int(reply_to_id)
        except (TypeError, ValueError):
            return {"success": False, "error": "Invalid reply target", "code": "reply_target"}
        try:
            target_result = (
                supabase.table("community_chat_messages")
                .select("id, username, wallet_address")
                .eq("id", target_id)
                .eq("room", ROOM)
                .eq("is_deleted", False)
                .limit(1)
                .execute()
            )
            if not target_result or not target_result.data:
                return {
                    "success": False, "error": "That message is no longer available to reply to",
                    "code": "reply_target",
                }
            target = target_result.data[0]
            reply = {
                "reply_to_id": target["id"],
                "reply_to_username": target.get("username") or short_wallet(target.get("wallet_address")),
                "reply_to_wallet": target.get("wallet_address"),
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("chatroom: reply target lookup failed: %s", exc)
            return {"success": False, "error": "Could not validate reply target", "code": "reply_target"}
    try:
        result = (
            supabase.table("community_chat_messages")
            .insert({
                "room": ROOM,
                "wallet_address": wallet,
                "username": username,
                "message": text,
                **reply,
            })
            .execute()
        )
        if not result or not result.data:
            return {"success": False, "error": "Failed to post message", "code": "insert"}
        return {"success": True, "message": _public_row(result.data[0], wallet)}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: post_message failed: %s", exc)
        return {"success": False, "error": "Failed to post message", "code": "insert"}


# ── Admin: moderation ────────────────────────────────────────────────────────

def delete_message(message_id: int, admin_wallet: str) -> dict:
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable"}
    try:
        result = (
            supabase.table("community_chat_messages")
            .update({
                "is_deleted": True,
                "deleted_by": admin_wallet,
                "deleted_at": _now().isoformat(),
            })
            .eq("id", int(message_id))
            .execute()
        )
        if not result:
            return {"success": False, "error": "Failed to delete message"}
        return {"success": True, "message_id": int(message_id)}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: delete_message failed: %s", exc)
        return {"success": False, "error": "Failed to delete message"}


def report_message(message_id: int, reporter_wallet: str, reason: str = "") -> dict:
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable"}
    try:
        result = (
            supabase.table("community_chat_reports")
            .insert({
                "message_id": int(message_id),
                "reporter_wallet": reporter_wallet,
                "reason": sanitize_message(reason)[:300],
            })
            .execute()
        )
        return {"success": bool(result and result.data), "message_id": int(message_id)}
    except Exception as exc:  # noqa: BLE001
        # A duplicate report hits the UNIQUE constraint — treat as success
        # (the report already exists, the user's intent is satisfied).
        logger.info("chatroom: report_message handled: %s", exc)
        return {"success": True, "message_id": int(message_id), "duplicate": True}


def ban_wallet(target_wallet: str, admin_wallet: str, reason: str = "") -> dict:
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable"}
    try:
        supabase.table("community_chat_bans").upsert({
            "wallet_address": target_wallet,
            "reason": sanitize_message(reason)[:300],
            "banned_by": admin_wallet,
        }).execute()
        return {"success": True, "wallet": target_wallet}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: ban_wallet failed: %s", exc)
        return {"success": False, "error": "Failed to ban wallet"}


def unban_wallet(target_wallet: str) -> dict:
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable"}
    try:
        supabase.table("community_chat_bans").delete().ilike(
            "wallet_address", target_wallet
        ).execute()
        return {"success": True, "wallet": target_wallet}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: unban_wallet failed: %s", exc)
        return {"success": False, "error": "Failed to unban wallet"}


def list_bans(limit: int = 100) -> dict:
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "bans": []}
    try:
        result = (
            supabase.table("community_chat_bans")
            .select("wallet_address, reason, banned_by, created_at")
            .order("created_at", desc=True)
            .limit(int(limit))
            .execute()
        )
        return {"success": True, "bans": list(result.data or [])}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: list_bans failed: %s", exc)
        return {"success": False, "error": "Failed to load bans", "bans": []}


def get_reports(status: str = "open", limit: int = 100) -> dict:
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "reports": []}
    try:
        result = (
            supabase.table("community_chat_reports")
            .select("id, message_id, reporter_wallet, reason, status, created_at")
            .eq("status", status)
            .order("created_at", desc=True)
            .limit(int(limit))
            .execute()
        )
        return {"success": True, "reports": list(result.data or [])}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: get_reports failed: %s", exc)
        return {"success": False, "error": "Failed to load reports", "reports": []}


def resolve_report(report_id: int, admin_wallet: str, status: str = "resolved") -> dict:
    if status not in ("resolved", "dismissed"):
        return {"success": False, "error": "Invalid status"}
    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable"}
    try:
        supabase.table("community_chat_reports").update({
            "status": status,
            "reviewed_by": admin_wallet,
            "reviewed_at": _now().isoformat(),
        }).eq("id", int(report_id)).execute()
        return {"success": True, "report_id": int(report_id)}
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: resolve_report failed: %s", exc)
        return {"success": False, "error": "Failed to update report"}
