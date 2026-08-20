"""GCash Cashout — business logic.

Handles request creation, validation, on-chain verification, refund sending
(via GCASH_KEY), and status transitions. Follows the same patterns as
``reloadly/service.py`` for refund gas preflight + error classification.
"""
import logging
import os
import re
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

GD_TOKEN_CONTRACT = os.getenv("GD_TOKEN_CONTRACT", "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A")
CELO_RPC_URL = os.getenv("CELO_RPC_URL", "https://forno.celo.org")
CHAIN_ID = 42220
GD_DECIMALS = 18

MIN_CASHOUT_GD = Decimal("5000")          # 5,000 G$ minimum
GD_PER_PESO = Decimal("100")              # 100 G$ = ₱1.00
AUTO_REFUND_HOURS = 24                    # auto-refund if not reviewed within 24h

_REFUND_GAS_FALLBACK = 80_000
_REFUND_GAS_CAP = 150_000
_REFUND_GAS_MARGIN = 1.2

GCASH_NUMBER_RE = re.compile(r"^09\d{9}$")  # 11 digits starting with 09
GCASH_NAME_RE = re.compile(r"^[A-Za-z\s.\-']{2,100}$")

ERC20_ABI = [
    {
        "constant": False,
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"},
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function",
    },
]

# ── Lazy web3 import (content tests must run without deps) ──────────────────

_w3 = None


def _get_w3():
    global _w3
    if _w3 is None:
        from web3 import Web3
        _w3 = Web3(Web3.HTTPProvider(CELO_RPC_URL))
    return _w3


def _get_supabase():
    from supabase_client import get_supabase_admin_client
    return get_supabase_admin_client()


def get_gcash_address():
    addr = os.getenv("GCASH_ADDRESS", "").strip()
    if not addr:
        return None
    if not addr.startswith("0x"):
        addr = "0x" + addr
    return addr


def get_gcash_key():
    key = os.getenv("GCASH_KEY", "").strip()
    if not key:
        return None
    if not key.startswith("0x"):
        key = "0x" + key
    return key


def is_gcash_enabled():
    return bool(get_gcash_address() and get_gcash_key())


# ── Validation ────────────────────────────────────────────────────────────────

def validate_cashout_request(amount_gd, gcash_number, gcash_name):
    """Returns (error_message_or_None, amount_gd_decimal, amount_php_decimal)."""
    if not amount_gd:
        return "Amount is required.", None, None
    try:
        amt = Decimal(str(amount_gd).replace(",", "").strip())
    except Exception:
        return "Invalid amount format.", None, None
    if amt < MIN_CASHOUT_GD:
        return f"Minimum cashout is {MIN_CASHOUT_GD:,.0f} G$ (₱{MIN_CASHOUT_GD / GD_PER_PESO:.2f}).", None, None
    php = (amt / GD_PER_PESO).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    number = (gcash_number or "").strip()
    if not GCASH_NUMBER_RE.match(number):
        return "GCash number must be exactly 11 digits starting with 09 (e.g. 09651234567).", None, None

    name = (gcash_name or "").strip()
    if not GCASH_NAME_RE.match(name):
        return "Full name must be 2–100 characters (letters, spaces, dots, hyphens only).", None, None

    return None, amt, php


# ── On-chain verification ─────────────────────────────────────────────────────

def verify_payment_tx(tx_hash: str, expected_from: str, expected_amount_gd: Decimal):
    """Verify the user's G$ transfer to GCASH_ADDRESS on-chain.

    Returns (True, None) on success, (False, error_msg) on failure.
    """
    gcash_addr = get_gcash_address()
    if not gcash_addr:
        return False, "GCash address not configured."

    w3 = _get_w3()
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except Exception:
        return False, "Transaction not found on-chain. Please wait for confirmation."

    if not receipt or receipt.status != 1:
        return False, "Transaction failed on-chain."

    # Verify the tx was to the G$ token contract
    if receipt.to.lower() != GD_TOKEN_CONTRACT.lower():
        return False, "Transaction was not a G$ transfer."

    # Decode the transfer from the logs
    from web3 import Web3
    token = w3.eth.contract(address=Web3.to_checksum_address(GD_TOKEN_CONTRACT), abi=ERC20_ABI)
    try:
        logs = token.events.Transfer().process_receipt(receipt)
    except Exception:
        return False, "Could not decode transfer event from transaction."

    if not logs:
        return False, "No G$ transfer found in transaction."

    transfer = logs[0]
    args = transfer["args"]

    # Verify sender
    if args["_from"].lower() != expected_from.lower():
        return False, "Transaction sender does not match your wallet."

    # Verify recipient
    if args["_to"].lower() != gcash_addr.lower():
        return False, "G$ was not sent to the GCash cashout address."

    # Verify amount
    expected_wei = int((expected_amount_gd * (Decimal(10) ** GD_DECIMALS)).to_integral_value(rounding=ROUND_HALF_UP))
    if args["_value"] != expected_wei:
        actual = Decimal(args["_value"]) / (Decimal(10) ** GD_DECIMALS)
        return False, f"Amount mismatch: expected {expected_amount_gd} G$ but sent {actual} G$."

    return True, None


# ── Database operations ───────────────────────────────────────────────────────

def create_cashout_request(wallet, gcash_number, gcash_name, amount_gd, amount_php, tx_hash):
    sb = _get_supabase()
    row = {
        "wallet_address": wallet.lower(),
        "gcash_number": gcash_number,
        "gcash_name": gcash_name,
        "amount_gd": str(amount_gd),
        "amount_php": str(amount_php),
        "tx_hash": tx_hash,
        "status": "pending",
    }
    result = sb.table("gcash_cashout_requests").insert(row).execute()
    if result.data:
        return {"success": True, "request": result.data[0]}
    return {"success": False, "error": "Failed to save request."}


def get_pending_request_for_wallet(wallet):
    sb = _get_supabase()
    result = (
        sb.table("gcash_cashout_requests")
        .select("id")
        .eq("wallet_address", wallet.lower())
        .eq("status", "pending")
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def get_user_requests(wallet, limit=20):
    sb = _get_supabase()
    result = (
        sb.table("gcash_cashout_requests")
        .select("*")
        .eq("wallet_address", wallet.lower())
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []


def get_all_requests(status=None, limit=50, offset=0):
    sb = _get_supabase()
    q = sb.table("gcash_cashout_requests").select("*").order("created_at", desc=True)
    if status:
        q = q.eq("status", status)
    result = q.range(offset, offset + limit - 1).execute()
    return result.data or []


def get_request_by_id(request_id):
    sb = _get_supabase()
    result = (
        sb.table("gcash_cashout_requests")
        .select("*")
        .eq("id", request_id)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def update_request(request_id, updates):
    sb = _get_supabase()
    result = (
        sb.table("gcash_cashout_requests")
        .update(updates)
        .eq("id", request_id)
        .execute()
    )
    return result.data[0] if result.data else None


# ── Refund ─────────────────────────────────────────────────────────────────────

def _is_insufficient_gas_error(err):
    msg = str(err).lower()
    return "insufficient funds" in msg or "insufficient balance" in msg or "gas required exceeds" in msg


def send_refund(to_wallet: str, amount_gd, request_id: int) -> dict:
    """Send G$ refund from GCASH_KEY wallet back to the user.

    Returns {"success": True, "tx_hash": ...} or {"success": False, "error": ...,
    "error_type": "insufficient_gas"|...}.
    """
    gcash_key = get_gcash_key()
    if not gcash_key:
        return {"success": False, "error": "GCASH_KEY not configured", "error_type": "no_key"}

    w3 = _get_w3()
    from web3 import Web3
    from eth_account import Account

    if not w3.is_connected():
        return {"success": False, "error": "Cannot connect to Celo network", "error_type": "rpc_unreachable"}

    refund_account = Account.from_key(gcash_key)
    token = w3.eth.contract(
        address=Web3.to_checksum_address(GD_TOKEN_CONTRACT),
        abi=ERC20_ABI,
    )
    recipient = Web3.to_checksum_address(to_wallet)

    amount_dec = Decimal(str(amount_gd).replace(",", "").strip())
    amount_wei = int((amount_dec * (Decimal(10) ** GD_DECIMALS)).to_integral_value(rounding=ROUND_HALF_UP))

    # Gas preflight — same pattern as reloadly refund
    gas_limit = _REFUND_GAS_FALLBACK
    gas_price = None
    try:
        gas_price = w3.eth.gas_price
        try:
            estimated = token.functions.transfer(recipient, amount_wei).estimate_gas(
                {"from": refund_account.address}
            )
            gas_limit = min(int(estimated * _REFUND_GAS_MARGIN), _REFUND_GAS_CAP)
        except Exception as est_err:
            if _is_insufficient_gas_error(est_err):
                raise
            gas_limit = _REFUND_GAS_FALLBACK

        required_wei = gas_limit * gas_price
        signer_celo = w3.eth.get_balance(refund_account.address)
        if signer_celo < required_wei:
            logger.error(
                f"❌ GCash refund wallet has insufficient CELO: request={request_id} "
                f"needed={required_wei} available={signer_celo}"
            )
            return {
                "success": False,
                "error": "GCash refund wallet needs a gas refill.",
                "error_type": "insufficient_gas",
            }
    except Exception as preflight_err:
        if _is_insufficient_gas_error(preflight_err):
            return {
                "success": False,
                "error": "GCash refund wallet needs a gas refill.",
                "error_type": "insufficient_gas",
            }

    nonce = w3.eth.get_transaction_count(refund_account.address)
    if gas_price is None:
        gas_price = w3.eth.gas_price

    tx = token.functions.transfer(recipient, amount_wei).build_transaction({
        "chainId": CHAIN_ID,
        "gas": gas_limit,
        "gasPrice": gas_price,
        "nonce": nonce,
        "from": refund_account.address,
    })

    signed = w3.eth.account.sign_transaction(tx, private_key=refund_account.key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)

    if receipt.status == 1:
        return {"success": True, "tx_hash": tx_hash.hex()}
    return {"success": False, "error": "Refund transaction reverted on-chain.", "error_type": "tx_reverted"}


def claim_request_for_refund(request_id: int, expected_status: str = "pending"):
    """CAS claim: atomically flip status to prevent double-refund.

    Returns the request dict if we won the claim, None otherwise.
    """
    sb = _get_supabase()
    result = (
        sb.table("gcash_cashout_requests")
        .update({"status": "refunding"})
        .eq("id", request_id)
        .eq("status", expected_status)
        .execute()
    )
    return result.data[0] if result.data else None
