"""GCash Cashout — API endpoints.

User submits a cashout request after sending G$ on-chain to GCASH_ADDRESS.
Admin reviews in the dashboard and approves (sends GCash manually) or rejects
(triggers auto-refund). Unreviewed requests auto-refund after 24 hours.
"""
import html
import logging
import re
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, session

from .service import (
    validate_cashout_request, verify_payment_tx,
    create_cashout_request, get_pending_request_for_wallet,
    get_user_requests, get_all_requests, get_request_by_id,
    update_request, send_refund, claim_request_for_refund,
    is_gcash_enabled, get_gcash_address, MIN_CASHOUT_GD, GD_PER_PESO,
    auto_refund_failed_cashout, process_claimed_refund,
)

logger = logging.getLogger(__name__)

gcash_bp = Blueprint("gcash", __name__, url_prefix="/api/gcash")


def _auth_wallet():
    wallet = session.get("wallet")
    if not session.get("verified") or not wallet:
        return None
    return wallet


def _require_admin():
    wallet = _auth_wallet()
    if not wallet:
        return None, (jsonify({"success": False, "error": "Authentication required"}), 401)
    from supabase_client import is_admin
    if not is_admin(wallet):
        return None, (jsonify({"success": False, "error": "Admin access required"}), 403)
    return wallet, None


# ── User endpoints ─────────────────────────────────────────────────────────────

@gcash_bp.route("/config", methods=["GET"])
def get_config():
    """Public config: minimum, rate, whether enabled. No auth needed."""
    addr = get_gcash_address()
    return jsonify({
        "success": True,
        "enabled": is_gcash_enabled(),
        "min_cashout_gd": float(MIN_CASHOUT_GD),
        "gd_per_peso": float(GD_PER_PESO),
        "gcash_address": addr,
    })


@gcash_bp.route("/cashout-request", methods=["POST"])
def submit_cashout():
    """Submit a GCash cashout request after on-chain G$ transfer."""
    wallet = _auth_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Authentication required"}), 401

    if not is_gcash_enabled():
        return jsonify({"success": False, "error": "GCash cashout is not available right now."}), 503

    body = request.get_json(force=True, silent=True) or {}
    amount_gd = body.get("amount_gd")
    gcash_number = body.get("gcash_number", "")
    gcash_name = body.get("gcash_name", "")
    tx_hash = body.get("tx_hash", "")

    # Validate
    err, amt_gd, amt_php = validate_cashout_request(amount_gd, gcash_number, gcash_name)
    if err:
        return jsonify({"success": False, "error": err}), 400

    if not tx_hash or not tx_hash.startswith("0x") or len(tx_hash) != 66:
        return jsonify({"success": False, "error": "Invalid transaction hash."}), 400

    # One pending request per user at a time
    existing = get_pending_request_for_wallet(wallet)
    if existing:
        return jsonify({
            "success": False,
            "error": "You already have a pending cashout request. Please wait for it to be reviewed.",
        }), 409

    # Verify the on-chain tx
    ok, verify_err, received = verify_payment_tx(tx_hash, wallet, amt_gd)
    if not ok:
        if received:
            # The G$ DID reach the cashout address but the request failed
            # verification (e.g. amount mismatch) — never leave the user stuck:
            # record it and refund the exact amount received automatically.
            logger.warning(
                f"⚠️ GCash cashout verify failed after funds arrived ({verify_err}) "
                f"— auto-refunding {received['amount_gd']} G$ to {wallet[:8]}…"
            )
            ar = auto_refund_failed_cashout(
                wallet, gcash_number.strip(), gcash_name.strip(),
                tx_hash, received["amount_gd"], verify_err,
            )
            if ar.get("already_recorded"):
                return jsonify({"success": False, "error": ar["error"]}), 409
            if ar.get("refunded"):
                refund_tx = ar.get("refund_tx_hash", "")
                return jsonify({
                    "success": False,
                    "refunded": True,
                    "refund_tx_hash": refund_tx,
                    "error": (
                        f"⚠️ Your {received['amount_gd']:,.2f} G$ reached the cashout address, but the cashout "
                        f"could not be processed ({verify_err}). The full amount was automatically refunded "
                        f"to your wallet — <a href=\"https://celoscan.io/tx/{refund_tx}\" target=\"_blank\" "
                        f"style=\"color:#38bdf8;\">view refund tx ↗</a>. You can submit a new cashout request."
                    ),
                }), 400
            ref = f" (reference: request #{ar['request_id']})" if ar.get("request_id") else ""
            return jsonify({
                "success": False,
                "refunded": False,
                "error": (
                    f"⚠️ Your {received['amount_gd']:,.2f} G$ reached the cashout address, but the cashout "
                    f"could not be processed ({verify_err}) and the automatic refund could not be sent yet "
                    f"({ar.get('error', 'unknown')}). Your G$ is safe — it will be refunded automatically "
                    f"once the refund wallet is topped up{ref}. Please contact support if you are not "
                    f"refunded within 24 hours."
                ),
            }), 500
        return jsonify({"success": False, "error": verify_err}), 400

    # Save
    result = create_cashout_request(wallet, gcash_number.strip(), gcash_name.strip(), amt_gd, amt_php, tx_hash)
    if not result["success"]:
        return jsonify(result), 500

    req = result["request"]
    logger.info(f"✅ GCash cashout request #{req['id']}: {amt_gd} G$ from {wallet[:8]}…")

    return jsonify({
        "success": True,
        "request_id": req["id"],
        "amount_gd": float(amt_gd),
        "amount_php": float(amt_php),
        "message": "Cashout request submitted! Processing time: 1–24 hours.",
    })


@gcash_bp.route("/my-requests", methods=["GET"])
def my_requests():
    """Get the current user's cashout request history."""
    wallet = _auth_wallet()
    if not wallet:
        return jsonify({"success": False, "error": "Authentication required"}), 401

    requests = get_user_requests(wallet)
    return jsonify({"success": True, "requests": requests})


# ── Admin endpoints ────────────────────────────────────────────────────────────

@gcash_bp.route("/admin/requests", methods=["GET"])
def admin_list_requests():
    """List all cashout requests, optionally filtered by status."""
    _, err = _require_admin()
    if err:
        return err

    status = request.args.get("status", "").strip() or None
    limit = min(int(request.args.get("limit", 50)), 200)
    offset = int(request.args.get("offset", 0))

    requests = get_all_requests(status=status, limit=limit, offset=offset)
    return jsonify({"success": True, "requests": requests})


@gcash_bp.route("/admin/requests/<int:request_id>/approve", methods=["POST"])
def admin_approve(request_id):
    """Approve a cashout request: requires the GCash reference # and a receipt
    screenshot (uploaded to ImgBB) proving the payment was actually sent."""
    admin_wallet, err = _require_admin()
    if err:
        return err

    req = get_request_by_id(request_id)
    if not req:
        return jsonify({"success": False, "error": "Request not found."}), 404
    if req["status"] != "pending":
        return jsonify({"success": False, "error": f"Request is already {req['status']}."}), 409

    # Multipart form (FormData) — JSON fallback keeps API callers working.
    if request.content_type and "multipart/form-data" in request.content_type:
        reference_number = (request.form.get("reference_number") or "").strip()
        note = (request.form.get("note") or "").strip()
        receipt_file = request.files.get("receipt_image")
    else:
        body = request.get_json(force=True, silent=True) or {}
        reference_number = (body.get("reference_number") or "").strip()
        note = (body.get("note") or "").strip()
        receipt_file = None

    if not reference_number:
        return jsonify({"success": False, "error": "GCash reference number is required."}), 400
    if len(reference_number) > 50 or not re.match(r"^[A-Za-z0-9\- ]+$", reference_number):
        return jsonify({"success": False, "error": "Invalid reference number format."}), 400

    receipt_url = None
    if receipt_file and receipt_file.filename:
        from object_storage_client import upload_to_imgbb
        upload = upload_to_imgbb(receipt_file)
        if not upload.get("success"):
            return jsonify({
                "success": False,
                "error": "Receipt upload failed: " + upload.get("error", "unknown error"),
            }), 500
        receipt_url = upload.get("url")
    else:
        return jsonify({"success": False, "error": "Receipt screenshot is required as proof of payment."}), 400

    updated = update_request(request_id, {
        "status": "approved",
        "admin_note": note or "✅ Successful — GCash payment sent.",
        "reference_number": reference_number,
        "receipt_image_url": receipt_url,
        "reviewed_by": admin_wallet.lower(),
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    })

    if not updated:
        return jsonify({"success": False, "error": "Failed to update request."}), 500

    # Tell the user (if they linked the Telegram bot) their cashout was paid.
    try:
        from telegram_notify import notify_user_by_wallet_async
        php_amount = req["amount_gd"] / 100  # 100 G$ = ₱1.00 (app-wide rate)
        notify_user_by_wallet_async(
            req["wallet_address"],
            "✅ <b>GCash Cashout Approved!</b>\n\n"
            f"Your cashout of <b>{req['amount_gd']:,.2f} G$</b> (≈ ₱{php_amount:,.2f}) was approved and sent to your GCash account.\n"
            f"📎 Ref #: <code>{reference_number}</code>\n\n"
            "Thank you for using GoodMarket! 💛"
        )
    except Exception as e:  # noqa: BLE001 - notify is best-effort
        logger.warning(f"⚠️ GCash approve notify failed for #{request_id}: {e}")

    logger.info(f"✅ GCash cashout #{request_id} approved by {admin_wallet[:8]}… ref={reference_number}")
    return jsonify({
        "success": True,
        "message": f"Request #{request_id} approved. Ref #: {reference_number}",
        "reference_number": reference_number,
        "receipt_image_url": receipt_url,
    })


@gcash_bp.route("/admin/requests/<int:request_id>/reject", methods=["POST"])
def admin_reject(request_id):
    """Reject a cashout request and automatically refund the G$."""
    admin_wallet, err = _require_admin()
    if err:
        return err

    req = get_request_by_id(request_id)
    if not req:
        return jsonify({"success": False, "error": "Request not found."}), 404
    if req["status"] != "pending":
        return jsonify({"success": False, "error": f"Request is already {req['status']}."}), 409

    body = request.get_json(force=True, silent=True) or {}
    note = body.get("note", "").strip()

    # CAS claim to prevent double-refund
    claimed = claim_request_for_refund(request_id, expected_status="pending")
    if not claimed:
        return jsonify({"success": False, "error": "Request was already claimed by another process."}), 409

    # Send refund
    refund_result = send_refund(req["wallet_address"], req["amount_gd"], request_id)

    if refund_result["success"]:
        update_request(request_id, {
            "status": "rejected",
            "admin_note": note or "Rejected by admin",
            "refund_tx_hash": refund_result["tx_hash"],
            "reviewed_by": admin_wallet.lower(),
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        })
        # Tell the user their cashout was rejected and the G$ came back.
        try:
            from telegram_notify import notify_user_by_wallet_async
            reason_line = f"\n📝 Reason: {html.escape(note)}" if note else ""
            notify_user_by_wallet_async(
                req["wallet_address"],
                "❌ <b>GCash Cashout Rejected</b>\n\n"
                f"Your cashout of <b>{req['amount_gd']:,.2f} G$</b> was rejected.{reason_line}\n"
                f"💰 Your G$ was refunded to your wallet.\n"
                f"🔗 Refund tx: https://celoscan.io/tx/{refund_result['tx_hash']}"
            )
        except Exception as e:  # noqa: BLE001 - notify is best-effort
            logger.warning(f"⚠️ GCash reject notify failed for #{request_id}: {e}")
        logger.info(f"❌ GCash cashout #{request_id} rejected + refunded: {refund_result['tx_hash'][:16]}…")
        return jsonify({
            "success": True,
            "message": f"Request #{request_id} rejected. G$ refunded: {refund_result['tx_hash'][:16]}…",
            "tx_hash": refund_result["tx_hash"],
        })
    else:
        # Refund failed — park as refund_failed (kept any broadcast tx hash so a
        # retry checks it on-chain before re-sending: no double-refund)
        updates = {
            "status": "refund_failed",
            "admin_note": f"Rejected but refund failed: {refund_result.get('error', 'unknown')}",
            "reviewed_by": admin_wallet.lower(),
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        }
        if refund_result.get("tx_hash"):
            updates["refund_tx_hash"] = refund_result["tx_hash"]
        update_request(request_id, updates)
        logger.error(f"❌ GCash cashout #{request_id} rejected but refund failed: {refund_result.get('error')}")
        return jsonify({
            "success": False,
            "error": f"Request rejected but refund failed: {refund_result.get('error', 'unknown')}",
            "refund_error_type": refund_result.get("error_type"),
        }), 500


@gcash_bp.route("/admin/requests/<int:request_id>/retry-refund", methods=["POST"])
def admin_retry_refund(request_id):
    """Retry the refund for a refund_failed request (e.g. after the refund
    wallet was topped up with CELO gas)."""
    admin_wallet, err = _require_admin()
    if err:
        return err

    req = get_request_by_id(request_id)
    if not req:
        return jsonify({"success": False, "error": "Request not found."}), 404
    if req["status"] != "refund_failed":
        return jsonify({"success": False, "error": f"Request is {req['status']} — only refund_failed requests can be retried."}), 409

    if not claim_request_for_refund(request_id, expected_status="refund_failed"):
        return jsonify({"success": False, "error": "Refund was already claimed by another process."}), 409

    result = process_claimed_refund(req, f"Refund retried by admin {admin_wallet[:10]}…")

    if result["success"]:
        logger.info(f"✅ GCash cashout #{request_id} refund retried by {admin_wallet[:8]}…: {result['tx_hash'][:16]}…")
        return jsonify({
            "success": True,
            "message": f"Request #{request_id} refunded: {result['tx_hash'][:16]}…",
            "tx_hash": result["tx_hash"],
        })
    logger.error(f"❌ GCash cashout #{request_id} refund retry failed: {result.get('error')}")
    return jsonify({
        "success": False,
        "error": f"Refund retry failed: {result.get('error', 'unknown')}",
        "refund_error_type": result.get("error_type"),
    }), 500

