"""Shared human (face) verification gate for feature pages.

Every login_method (local, injected, walletconnect, privy, minipay) must be
face-verified on the GoodDollar Identity contract before entering
earning/spending features (dashboard, learn & earn, play & earn, swap,
savings, reloadly). Verification state comes from the on-chain
``Identity.isWhitelisted`` check in ``blockchain.is_identity_verified``,
which is cached for 5 minutes — a user who just finished face verification
gets in on the next page load without re-login.
"""
import logging

from flask import redirect

logger = logging.getLogger(__name__)

# The wallet page is the one place an unverified user CAN go — it hosts the
# face-verification entry point (Claim G$ → GoodDollar FV flow).
# `fv_required=1` tells it to explain why the user was bounced back.
FV_REQUIRED_URL = "/wallet?fv_required=1"


def human_verification_redirect(wallet):
    """Return a redirect response when `wallet` is NOT face-verified
    on-chain, otherwise None. Callers must authenticate the session first
    (this only checks FV, not login). Fails closed: an FV check error blocks
    access, matching the safety intent of the gate."""
    try:
        from blockchain import is_identity_verified
        if is_identity_verified(wallet).get("verified"):
            return None
        logger.info(f"🪪 FV gate: blocked unverified wallet {str(wallet)[:10]}…")
    except Exception as e:
        # is_identity_verified already swallows RPC errors into
        # {"verified": False}; an exception here is unexpected — fail closed.
        logger.warning(f"⚠️ FV gate check failed for {str(wallet)[:10]}…: {e}")
    return redirect(FV_REQUIRED_URL)
