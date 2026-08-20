"""GCash Cashout — API endpoints.

User submits a cashout request after sending G$ on-chain to GCASH_ADDRESS.
Admin reviews in the dashboard and approves (sends GCash manually) or rejects
(triggers auto-refund). Unreviewed requests auto-refund after 24 hours.
"""
import logging
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, session

from .service import (
    validate_cashout_request, verify_payment_tx,
    create_cashout_request, get_pending_request_for_wallet,
    get_user_requests, get_all_requests, get_request_by_id,
    update_request, send_refund, claim_request_for_refund,
    is_gcash_enabled, get_gcash_address, MIN_CASHOUT_GD, GD_PER_PESO,
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
    ok, verify_err = verify_payment_tx(tx_hash, wallet, amt_gd)
    if not ok:
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
    """Approve a cashout request (admin has sent GCash payment manually)."""
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

    updated = update_request(request_id, {
        "status": "approved",
        "admin_note": note or None,
        "reviewed_by": admin_wallet.lower(),
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    })

    if not updated:
        return jsonify({"success": False, "error": "Failed to update request."}), 500

    logger.info(f"✅ GCash cashout #{request_id} approved by {admin_wallet[:8]}…")
    return jsonify({"success": True, "message": f"Request #{request_id} approved."})


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
        logger.info(f"❌ GCash cashout #{request_id} rejected + refunded: {refund_result['tx_hash'][:16]}…")
        return jsonify({
            "success": True,
            "message": f"Request #{request_id} rejected. G$ refunded: {refund_result['tx_hash'][:16]}…",
        })
    else:
        # Refund failed — park as refund_failed
        update_request(request_id, {
            "status": "refund_failed",
            "admin_note": f"Rejected but refund failed: {refund_result.get('error', 'unknown')}",
            "reviewed_by": admin_wallet.lower(),
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.error(f"❌ GCash cashout #{request_id} rejected but refund failed: {refund_result.get('error')}")
        return jsonify({
            "success": False,
            "error": f"Request rejected but refund failed: {refund_result.get('error', 'unknown')}",
            "refund_error_type": refund_result.get("error_type"),
        }), 500
