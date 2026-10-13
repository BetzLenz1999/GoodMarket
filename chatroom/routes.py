"""Community Chatroom — HTTP routes.

Blueprint ``chatroom`` at ``/chatroom``. One PUBLIC room where every signed-in
user sees every message, attributed to their username.

The whole feature is HIDDEN by default: the page redirects away and every API
call returns ``{enabled: false}`` until an admin flips ``chatroom_feature`` ON
from the dashboard. The gate is enforced server-side, not just by hiding the UI.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict, deque

from flask import Blueprint, jsonify, redirect, render_template, request, session

from . import service as svc
from . import tips

logger = logging.getLogger(__name__)

chatroom_bp = Blueprint("chatroom", __name__, url_prefix="/chatroom")

# In-process upload throttle (per wallet). Best-effort per gunicorn worker —
# enough to blunt an abusive upload burst without a shared store.
_UPLOAD_LOCK = threading.Lock()
_UPLOAD_HITS: dict[str, deque] = defaultdict(deque)


def _upload_allowed(wallet: str) -> int:
    """Returns 0 when allowed, else the seconds the caller must wait."""
    window = max(1, svc.UPLOAD_RATE_LIMIT_SECONDS)
    key = (wallet or "anon").lower()
    now = time.time()
    with _UPLOAD_LOCK:
        hits = _UPLOAD_HITS[key]
        while hits and hits[0] <= now - window:
            hits.popleft()
        if hits:
            return max(1, int(window - (now - hits[0])))
        hits.append(now)
    return 0


def _session_wallet() -> str | None:
    wallet = session.get("wallet") or session.get("wallet_address")
    if not wallet or not (session.get("verified") or session.get("ubi_verified")):
        return None
    return wallet


def _admin_wallet() -> str | None:
    wallet = session.get("wallet") or session.get("wallet_address")
    if not wallet:
        return None
    from supabase_client import is_admin

    return wallet if is_admin(wallet) else None


def _disabled_response():
    return jsonify({
        "success": False,
        "enabled": False,
        "error": "The chatroom is not available yet.",
    }), 403


# ── Page ──────────────────────────────────────────────────────────────────────

@chatroom_bp.route("/")
def chatroom_home():
    wallet = _session_wallet()
    if not wallet:
        return redirect("/")

    if not svc.is_enabled():
        return redirect("/wallet")

    # NOTE: deliberately NOT face-verification gated — the room is for ALL
    # signed-in users (usernames are shown, never wallets). Abuse is handled by
    # the report/ban moderation tools instead. Re-add a human_verification_redirect
    # here only if the product decision changes.
    return render_template(
        "chatroom.html",
        wallet=wallet,
        login_method=session.get("login_method", ""),
        display_name=svc.display_name(wallet),
        has_username=bool(svc.get_username(wallet)),
        # WalletConnect bridge context so WC-login users can sign a tip here.
        # Same sidecar rule as routes.py `_is_walletconnect_sidecar_enabled`.
        walletconnect_project_id=os.environ.get("WALLETCONNECT_PROJECT_ID", ""),
        walletconnect_sidecar_enabled=bool(os.getenv("WC_SERVICE_URL"))
        or not bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME")),
    )


@chatroom_bp.route("/u/<username>")
def chatroom_member_profile(username: str):
    """Public-by-username profile, reachable from a chat message."""
    wallet = _session_wallet()
    if not wallet:
        return redirect("/")
    if not svc.is_enabled():
        return redirect("/wallet")

    result = svc.get_public_profile(username)
    if not result.get("success"):
        return render_template("chatroom_profile.html", profile=None), 404
    return render_template("chatroom_profile.html", profile=result["profile"])


# ── Public API ────────────────────────────────────────────────────────────────

@chatroom_bp.route("/api/state")
def api_state():
    """Whether the room is open, who the viewer is, and if they can post."""
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401

    gate = svc.can_post(wallet)
    username = svc.get_username(wallet)
    is_admin_viewer = svc.is_admin_wallet(wallet)
    return jsonify({
        "success": True,
        "enabled": True,
        "username": username,
        "display_name": username or svc.short_wallet(wallet),
        "has_username": bool(username),
        # Admin status drives the in-room delete affordance. Server-side truth:
        # the UI only mirrors it, the delete endpoint re-checks anyway.
        "is_admin": is_admin_viewer,
        "can_post": gate["allowed"],
        "reason": gate["reason"],
        "retry_after": gate["retry_after"],
        "rate_limit_seconds": svc.RATE_LIMIT_SECONDS,
        "max_length": svc.MAX_MESSAGE_LENGTH,
        # Tipping: the tokens on offer + this viewer's own wallet address (used
        # only to sign the transfer in their browser — never echoed to the room).
        "can_tip": bool(username) and not svc.is_banned(wallet),
        "tip_tokens": tips.list_tip_tokens(),
        "tip_rate_limit_seconds": tips.TIP_RATE_LIMIT_SECONDS,
        "wallet": wallet,
    })


@chatroom_bp.route("/api/messages")
def api_messages():
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401

    after_id = request.args.get("after_id", type=int)
    limit = request.args.get("limit", type=int) or svc.DEFAULT_PAGE_SIZE
    # `deleted_after` (ISO ts) makes polling return the ids deleted since the
    # last tick so other viewers' screens prune them without a full refresh.
    deleted_after = (request.args.get("deleted_after") or "").strip() or None
    return jsonify(svc.get_messages(
        after_id=after_id, limit=limit, viewer_wallet=wallet,
        deleted_after=deleted_after,
    ))


@chatroom_bp.route("/api/messages", methods=["POST"])
def api_post_message():
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    result = svc.post_message(
        wallet,
        data.get("message", ""),
        data.get("reply_to_id"),
        attachment=data.get("attachment"),
    )
    status = 200 if result.get("success") else 400
    if result.get("code") == "rate_limited":
        status = 429
    if result.get("code") == "banned":
        status = 403
    return jsonify(result), status


@chatroom_bp.route("/api/upload", methods=["POST"])
def api_upload_image():
    """Upload an image attachment to ImgBB and return its public URL.

    The browser then posts a normal message carrying the returned descriptor.
    Images only (ImgBB is image-only). Never trusts the client: MIME + size are
    enforced here, and the URL is re-validated when the message is stored.
    """
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401
    if svc.is_banned(wallet):
        return jsonify({"success": False, "error": "You cannot post in the chatroom.",
                        "code": "banned"}), 403

    wait = _upload_allowed(wallet)
    if wait:
        return jsonify({"success": False, "error": "Please wait before uploading again.",
                        "code": "rate_limited", "retry_after": wait}), 429

    file = request.files.get("file") or request.files.get("image")
    if not file or not (file.filename or "").strip():
        return jsonify({"success": False, "error": "No image provided."}), 400

    mime = (file.mimetype or "").lower()
    if mime not in svc.IMAGE_MIME_TYPES:
        return jsonify({"success": False,
                        "error": "Only PNG, JPEG, GIF or WEBP images are supported."}), 415

    # Read once to enforce our own byte cap (do not trust Content-Length).
    try:
        file.seek(0, os.SEEK_END)
        size = file.tell()
        file.seek(0)
    except Exception:  # noqa: BLE001
        size = 0
    if size <= 0:
        return jsonify({"success": False, "error": "The image is empty."}), 400
    if size > svc.MAX_ATTACHMENT_BYTES:
        return jsonify({"success": False,
                        "error": f"Image is too large (max {svc.MAX_UPLOAD_MB} MB)."}), 413

    expiration = svc.IMAGE_EXPIRATION_DAYS * 86400 if svc.IMAGE_EXPIRATION_DAYS > 0 else None
    try:
        from object_storage_client import upload_to_imgbb
        upload = upload_to_imgbb(file, expiration=expiration)
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom: image upload failed: %s", exc)
        return jsonify({"success": False, "error": "Upload failed. Please try again."}), 502

    if not upload.get("success"):
        return jsonify({"success": False,
                        "error": upload.get("error") or "Upload failed."}), 502

    url = upload.get("url") or ""
    if not svc._attachment_url_allowed(url):
        # A host mismatch means we cannot safely render it — refuse loudly
        # rather than store an unvalidated URL.
        logger.error("chatroom: upload returned a non-allow-listed URL: %s", url)
        return jsonify({"success": False, "error": "Upload host is not allowed."}), 502

    return jsonify({
        "success": True,
        "attachment": {
            "url": url,
            "kind": "image",
            "mime": mime,
            "name": (file.filename or "image")[:120],
            "bytes": size,
        },
    })


@chatroom_bp.route("/api/report", methods=["POST"])
def api_report_message():
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    message_id = data.get("message_id")
    if not message_id:
        return jsonify({"success": False, "error": "message_id is required"}), 400
    result = svc.report_message(int(message_id), wallet, data.get("reason", ""))
    return jsonify(result), (200 if result.get("success") else 400)


# ── Tipping ───────────────────────────────────────────────────────────────────
# A tip is a real on-chain transfer signed by the sender's own wallet; these
# endpoints only resolve the recipient, hand back unsigned calldata, and verify
# the resulting hash. No server key, no custody.

@chatroom_bp.route("/api/tip/prepare", methods=["POST"])
def api_tip_prepare():
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    result = tips.prepare_tip(
        wallet,
        data.get("username") or data.get("to") or "",
        data.get("token") or "GD",
        data.get("amount"),
    )
    status = 200 if result.get("success") else 400
    if result.get("code") == "banned":
        status = 403
    return jsonify(result), status


@chatroom_bp.route("/api/tip/confirm", methods=["POST"])
def api_tip_confirm():
    if not svc.is_enabled():
        return _disabled_response()

    wallet = _session_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    result = tips.record_tip(
        wallet,
        data.get("username") or data.get("to") or "",
        data.get("token") or "GD",
        data.get("amount"),
        data.get("tx_hash") or "",
    )
    status = 200 if result.get("success") else 400
    if result.get("code") == "rate_limited":
        status = 429
    if result.get("code") == "banned":
        status = 403
    return jsonify(result), status


# ── Admin API ─────────────────────────────────────────────────────────────────

@chatroom_bp.route("/api/admin/reports")
def admin_reports():
    if not _admin_wallet():
        return jsonify({"success": False, "error": "Admin access required"}), 403
    status = request.args.get("status", "open")
    return jsonify(svc.get_reports(status=status))


@chatroom_bp.route("/api/admin/reports/<int:report_id>", methods=["POST"])
def admin_resolve_report(report_id: int):
    admin = _admin_wallet()
    if not admin:
        return jsonify({"success": False, "error": "Admin access required"}), 403
    data = request.get_json(silent=True) or {}
    result = svc.resolve_report(report_id, admin, data.get("status", "resolved"))
    return jsonify(result), (200 if result.get("success") else 400)


@chatroom_bp.route("/api/admin/messages/<int:message_id>", methods=["DELETE"])
def admin_delete_message(message_id: int):
    admin = _admin_wallet()
    if not admin:
        return jsonify({"success": False, "error": "Admin access required"}), 403
    result = svc.delete_message(message_id, admin)
    if result.get("success"):
        try:
            from supabase_client import log_admin_action
            log_admin_action(
                admin_wallet=admin,
                action_type="delete_chatroom_message",
                action_details={"message_id": message_id},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("⚠️ log_admin_action failed: %s", exc)
    return jsonify(result), (200 if result.get("success") else 400)


@chatroom_bp.route("/api/admin/bans", methods=["GET"])
def admin_list_bans():
    if not _admin_wallet():
        return jsonify({"success": False, "error": "Admin access required"}), 403
    return jsonify(svc.list_bans())


@chatroom_bp.route("/api/admin/bans", methods=["POST"])
def admin_ban_wallet():
    admin = _admin_wallet()
    if not admin:
        return jsonify({"success": False, "error": "Admin access required"}), 403
    data = request.get_json(silent=True) or {}
    target = (data.get("wallet") or "").strip()
    if not target:
        return jsonify({"success": False, "error": "wallet is required"}), 400
    result = svc.ban_wallet(target, admin, data.get("reason", ""))
    return jsonify(result), (200 if result.get("success") else 400)


@chatroom_bp.route("/api/admin/bans", methods=["DELETE"])
def admin_unban_wallet():
    if not _admin_wallet():
        return jsonify({"success": False, "error": "Admin access required"}), 403
    data = request.get_json(silent=True) or {}
    target = (data.get("wallet") or "").strip()
    if not target:
        return jsonify({"success": False, "error": "wallet is required"}), 400
    result = svc.unban_wallet(target)
    return jsonify(result), (200 if result.get("success") else 400)


def init_chatroom(app):
    """Register the chatroom blueprint on the Flask app."""
    app.register_blueprint(chatroom_bp)
    return True
