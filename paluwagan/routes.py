"""Community Rotating Savings (Paluwagan) — HTTP routes.

Blueprint ``paluwagan`` at ``/paluwagan``.

This feature is fully ON-CHAIN: the smart contract is the authoritative record
for group configuration, membership, contributions, payouts, deadlines,
misses/defaults and settlement. There is NO off-chain database and no
server-side financial state — the routes here are a thin, READ-ONLY bridge that
lets the browser read contract state and emitted events through a Celo RPC.

Every state-changing action (create / join / activate / contribute / claim /
mark-missed / advance / early-settle) is signed by the user's own wallet in the
browser via the standard signer routing (local GMLocalWallet / WalletConnect /
injected / Privy). This module never signs and never moves funds.

The feature is separate from the existing G$ Savings feature: a different
contract, different token custody and different accounting. The savings
contract is never referenced here.
"""
from __future__ import annotations

import logging
import os
import re

from flask import Blueprint, jsonify, render_template, request, session

from . import blockchain as chain

logger = logging.getLogger(__name__)

paluwagan_bp = Blueprint("paluwagan", __name__, url_prefix="/paluwagan")

# v1 is G$ only. The registry is intentionally one entry; v2 can extend it.
SUPPORTED_TOKENS = chain.SUPPORTED_TOKENS
GD_TOKEN_ADDRESS = chain.GD_TOKEN_ADDRESS
CHAIN_ID = chain.CHAIN_ID

# Commitment period must be a positive multiple of 5 weeks so every round has a
# recipient and the rotation is balanced. 50 weeks ≈ 12 months; 100 ≈ 24 months.
ALLOWED_WEEKS = (50, 100)
MEMBERS = chain.MEMBERS

# Group slugs are the shareable link (/paluwagan/teambetz). The contract is the
# authority (it rejects anything else); this mirrors it so a bad URL is a clean
# 404 rather than a pointless RPC round trip.
NAME_RE = re.compile(r"^[A-Za-z0-9-]{3,32}$")


def _session_wallet():
    wallet = session.get("wallet") or session.get("wallet_address")
    verified = session.get("verified") or session.get("ubi_verified")
    if not wallet or not verified:
        return None
    return wallet


def _feature_enabled():
    """Kill-switch for the paluwagan surface. Defaults ON; set
    PALUWAGAN_ENABLED=0 to hide the page and reject reads."""
    return os.getenv("PALUWAGAN_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")


# ── Page ─────────────────────────────────────────────────────────────────────

def _render_paluwagan(join_name=""):
    """Render the paluwagan page. `join_name` is a /paluwagan/<name> deep link."""
    wallet = session.get("wallet") or session.get("wallet_address")
    verified = session.get("verified") or session.get("ubi_verified")
    is_guest = not (wallet and verified)
    if is_guest:
        wallet = ""

    # NOTE: like /savings, the paluwagan page is intentionally NOT behind the
    # human (face) verification gate — saving is not an earning/spending
    # surface. Guests (no session) get the shared "Get Started" connect modal.

    wc_pid = os.environ.get("WALLETCONNECT_PROJECT_ID", "")
    has_explicit_sidecar = bool(os.getenv("WC_SERVICE_URL"))
    is_serverless_runtime = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"))
    wc_sidecar = has_explicit_sidecar or not is_serverless_runtime

    return render_template(
        "paluwagan.html",
        wallet=wallet,
        is_guest=is_guest,
        join_name=join_name,
        paluwagan_contract=chain.PALUWAGAN_CONTRACT_ADDRESS,
        paluwagan_deployment_block=chain.PALUWAGAN_DEPLOYMENT_BLOCK,
        paluwagan_configured=chain.is_configured(),
        gd_contract=GD_TOKEN_ADDRESS,
        chain_id=CHAIN_ID,
        members=MEMBERS,
        allowed_weeks=list(ALLOWED_WEEKS),
        removal_supported=chain.supports_member_removal(),
        removal_grace_period=chain.REMOVAL_GRACE_PERIOD,
        supported_tokens=[
            {"address": addr, "symbol": meta["symbol"], "decimals": meta["decimals"]}
            for addr, meta in SUPPORTED_TOKENS.items()
        ],
        walletconnect_project_id=wc_pid,
        walletconnect_sidecar_enabled=wc_sidecar,
        privy_app_id=os.environ.get("PRIVY_APP_ID", ""),
        privy_client_id=os.environ.get("PRIVY_CLIENT_ID", ""),
        # Guests have no login method — never default this to "walletconnect"
        # (that would start wc-bridge's expiry guard and bounce the guest).
        login_method=session.get("login_method", ""),
    )


@paluwagan_bp.route("/")
def paluwagan_home():
    return _render_paluwagan()


@paluwagan_bp.route("/<name>")
def paluwagan_by_name(name):
    """Shareable group link: /paluwagan/teambetz.

    The page opens the join flow with the group pre-filled. The name is passed
    through as-is; the frontend resolves it on-chain (getGroupIdByName), so the
    contract — not the URL — decides whether the group exists.
    """
    if not NAME_RE.match(name or ""):
        return _render_paluwagan()
    return _render_paluwagan(join_name=name)


# ── Read-only API ────────────────────────────────────────────────────────────

def _require_configured():
    if not _feature_enabled():
        return jsonify({"error": "feature_disabled"}), 403
    if not chain.is_configured():
        return jsonify({"error": "not_configured"}), 503
    return None


@paluwagan_bp.route("/api/config")
def api_config():
    """Public, non-sensitive page configuration."""
    if not _feature_enabled():
        return jsonify({"error": "feature_disabled"}), 403
    return jsonify({
        "contract": chain.PALUWAGAN_CONTRACT_ADDRESS,
        "deployment_block": chain.PALUWAGAN_DEPLOYMENT_BLOCK,
        "chain_id": CHAIN_ID,
        "configured": chain.is_configured(),
        "members": MEMBERS,
        "allowed_weeks": list(ALLOWED_WEEKS),
        "grace_period": chain.GRACE_PERIOD,
        "round_duration": chain.ROUND_DURATION,
        "removal_supported": chain.supports_member_removal(),
        "removal_grace_period": chain.REMOVAL_GRACE_PERIOD,
        "tokens": [
            {"address": addr, "symbol": meta["symbol"], "decimals": meta["decimals"]}
            for addr, meta in SUPPORTED_TOKENS.items()
        ],
    })


@paluwagan_bp.route("/api/groups")
def api_my_groups():
    """The session wallet's groups (read from MemberJoined events)."""
    guard = _require_configured()
    if guard:
        return guard
    wallet = _session_wallet()
    if not wallet:
        return jsonify({"error": "Unauthorized"}), 401
    try:
        groups = chain.get_my_groups(wallet)
    except Exception as e:
        logger.warning("paluwagan: get_my_groups failed: %s", e)
        return jsonify({"error": "chain_read_failed", "groups": []}), 200
    return jsonify({"groups": groups, "wallet": wallet})


@paluwagan_bp.route("/api/group/<int:group_id>")
def api_group(group_id):
    """Live state of a single group, plus the caller's standing in it."""
    guard = _require_configured()
    if guard:
        return guard
    wallet = _session_wallet()
    try:
        group = chain.get_group_overview(group_id, wallet)
    except Exception as e:
        logger.warning("paluwagan: group %s read failed: %s", group_id, e)
        return jsonify({"error": "chain_read_failed"}), 200
    return jsonify({"group": group})


@paluwagan_bp.route("/api/resolve/<name>")
def api_resolve_name(name):
    """Resolve a group name to its id + live overview (deep-link helper).

    Public: a shareable link must be previewable before the visitor has joined,
    and the contract is the only source of truth for what exists.
    """
    guard = _require_configured()
    if guard:
        return guard
    if not NAME_RE.match(name or ""):
        return jsonify({"error": "bad_name"}), 400
    wallet = _session_wallet()
    try:
        group = chain.get_group_by_name(name, wallet)
    except Exception as e:
        logger.warning("paluwagan: resolve %s failed: %s", name, e)
        return jsonify({"error": "chain_read_failed"}), 200
    if not group:
        return jsonify({"error": "not_found", "name": name}), 404
    return jsonify({"group": group, "name": name})


@paluwagan_bp.route("/api/group/<int:group_id>/contributions")
def api_group_contributions(group_id):
    """Contribution history for a group (from ContributionMade/Covered events)."""
    guard = _require_configured()
    if guard:
        return guard
    if not _session_wallet():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        rows = chain.get_contributions(group_id)
    except Exception as e:
        logger.warning("paluwagan: contributions read failed: %s", e)
        return jsonify({"error": "chain_read_failed", "contributions": []}), 200
    return jsonify({"contributions": rows})


@paluwagan_bp.route("/api/group/<int:group_id>/payouts")
def api_group_payouts(group_id):
    """Payout history for a group (from PayoutClaimed events)."""
    guard = _require_configured()
    if guard:
        return guard
    if not _session_wallet():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        rows = chain.get_payout_history(group_id)
    except Exception as e:
        logger.warning("paluwagan: payouts read failed: %s", e)
        return jsonify({"error": "chain_read_failed", "payouts": []}), 200
    return jsonify({"payouts": rows})


@paluwagan_bp.route("/api/balances")
def api_balances():
    """The session wallet's group-token balance and CELO gas balance."""
    guard = _require_configured()
    if guard:
        return guard
    wallet = _session_wallet()
    if not wallet:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({
        "wallet": wallet,
        "token": GD_TOKEN_ADDRESS,
        "token_symbol": "G$",
        "decimals": 18,
        "token_balance": str(chain.get_token_balance(wallet)),
        "celo_balance": str(chain.get_native_balance(wallet)),
    })
