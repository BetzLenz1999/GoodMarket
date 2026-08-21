"""GCash Cashout — business logic.

Handles request creation, validation, on-chain verification, refund sending
(via GCASH_KEY), and status transitions. Follows the same patterns as
``reloadly/service.py`` for refund gas preflight + error classification.
"""
import logging
import os
import re
import time
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

# Fixed gas budget for the refund transfer — mirrors reloadly/service.py
# REFUND_GAS_LIMIT. The estimate-based preflight (fallback 80k, cap 150k) was
# reverted in reloadly after it broke refunds in production (refund txs
# reverting), so GCash must not repeat it: with the old numbers the refund
# tx ran out of gas and the admin's reject "succeeded" while the refund died.
_REFUND_GAS_LIMIT = 250_000

# A freshly-broadcast tx isn't mined/indexed yet when the user submits — poll
# briefly before declaring it "not found" (the frontend already waits for the
# receipt, this is the safety net for RPC indexing lag).
_RECEIPT_LOOKUP_ATTEMPTS = int(os.getenv("GCASH_RECEIPT_LOOKUP_ATTEMPTS", "8"))
_RECEIPT_LOOKUP_INTERVAL_SEC = float(os.getenv("GCASH_RECEIPT_LOOKUP_INTERVAL_SEC", "2.5"))

GCASH_NUMBER_RE = re.compile(r"^09\d{9}$")  # 11 digits starting with 09
GCASH_NAME_RE = re.compile(r"^[A-Za-z\s.\-']{2,100}$")

# keccak256("Transfer(address,address,uint256)") — decoded manually from receipt
# logs (same pattern as reloadly / learn_and_earn) so verification never depends
# on a contract-event ABI being present.
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

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

def _normalize_hex(value) -> str:
    h = value.hex() if hasattr(value, "hex") else str(value)
    return h if h.startswith("0x") else "0x" + h


def decode_gd_transfers(receipt) -> list:
    """Manually decode Transfer(address,address,uint256) logs emitted by the G$
    token in a transaction receipt.

    ABI-free (topic-based) on purpose: ERC20_ABI carries no Transfer *event*, so
    web3's contract-event decoding used to raise on every legitimate cashout and
    fail verification even though the G$ had arrived.
    """
    transfers = []
    for log in receipt.get("logs") or []:
        try:
            if (log.get("address") or "").lower() != GD_TOKEN_CONTRACT.lower():
                continue
            topics = log.get("topics") or []
            if len(topics) < 3:
                continue
            if _normalize_hex(topics[0]).lower() != TRANSFER_TOPIC:
                continue
            data = log.get("data")
            transfers.append({
                "from": "0x" + _normalize_hex(topics[1])[-40:],
                "to": "0x" + _normalize_hex(topics[2])[-40:],
                "value": int(_normalize_hex(data), 16) if data else 0,
            })
        except Exception as e:
            logger.warning(f"⚠️ GCash verify: skipping undecodable log: {e}")
    return transfers


def verify_payment_tx(tx_hash: str, expected_from: str, expected_amount_gd: Decimal):
    """Verify the user's G$ transfer to GCASH_ADDRESS on-chain.

    Returns (ok, error, transfer):
      - (True, None, transfer)            — verified; transfer is the received G$
      - (False, error, transfer)          — G$ DID reach the cashout address but
                                            something mismatched (caller should
                                            auto-refund `transfer["amount_gd"]`)
      - (False, error, None)              — no G$ reached the cashout address
    """
    gcash_addr = get_gcash_address()
    if not gcash_addr:
        return False, "GCash address not configured.", None

    w3 = _get_w3()
    receipt = None
    for _ in range(_RECEIPT_LOOKUP_ATTEMPTS):
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            break
        except Exception:
            time.sleep(_RECEIPT_LOOKUP_INTERVAL_SEC)
    if receipt is None:
        return False, "Transaction is still confirming on-chain. Please try again in a minute — do not send a new transfer.", None

    if not receipt or receipt.get("status") != 1:
        return False, "Transaction failed on-chain.", None

    transfers = decode_gd_transfers(receipt)
    if not transfers:
        return False, "Transaction was not a G$ transfer.", None

    received_wei = sum(
        t["value"] for t in transfers
        if t["from"].lower() == expected_from.lower()
        and t["to"].lower() == gcash_addr.lower()
    )
    if not received_wei:
        return False, "No G$ transfer from your wallet to the GCash cashout address found in this transaction.", None

    received_gd = Decimal(received_wei) / (Decimal(10) ** GD_DECIMALS)
    transfer = {
        "from": expected_from,
        "to": gcash_addr,
        "value_wei": received_wei,
        "amount_gd": received_gd,
    }

    expected_wei = int((expected_amount_gd * (Decimal(10) ** GD_DECIMALS)).to_integral_value(rounding=ROUND_HALF_UP))
    if received_wei != expected_wei:
        return False, f"Amount mismatch: expected {expected_amount_gd} G$ but sent {received_gd} G$.", transfer

    return True, None, transfer


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


def get_request_by_tx_hash(tx_hash):
    sb = _get_supabase()
    result = (
        sb.table("gcash_cashout_requests")
        .select("*")
        .eq("tx_hash", tx_hash)
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
    return (
        "insufficient funds" in msg
        or "insufficient balance" in msg
        or "insufficient gas" in msg
        or "gas required exceeds" in msg
        or "intrinsic gas too low" in msg
        or "max fee per gas less" in msg
    )


def send_refund(to_wallet: str, amount_gd, request_id: int) -> dict:
    """Send G$ refund from GCASH_KEY wallet back to the user.

    Never raises. Callers CAS-claim the request (status -> 'refunding') before
    calling this, so an exception here would strand the row in 'refunding'
    forever — the reject looks done but the refund never happens. Returns
    {"success": True, "tx_hash": ...} or {"success": False, "error": ...,
    "error_type": "insufficient_gas"|"insufficient_balance"|...}.
    """
    try:
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

        # Preflight G$ balance (reloadly lesson): without this, a refund wallet
        # with no G$ sends a transfer that reverts on-chain and the request
        # hard-fails as refund_failed even after the admin refills CELO gas.
        try:
            gd_balance_wei = token.functions.balanceOf(refund_account.address).call()
            if gd_balance_wei < amount_wei:
                shortfall_gd = (amount_wei - gd_balance_wei) / (Decimal(10) ** GD_DECIMALS)
                logger.error(
                    f"❌ GCash refund wallet has insufficient G$: request={request_id} "
                    f"needed={amount_wei} available={gd_balance_wei}"
                )
                return {
                    "success": False,
                    "error": f"GCash refund wallet needs a G$ top-up (short by {shortfall_gd:.2f} G$).",
                    "error_type": "insufficient_balance",
                }
        except Exception as bal_err:
            # The read is best-effort; the preflight/send path below is authoritative.
            logger.warning(f"⚠️ Could not preflight GCash refund wallet G$ balance: {bal_err}")

        # Gas preflight: fixed budget. The estimate-based preflight (fallback
        # 80k, cap 150k) was reverted in reloadly after it broke refunds in
        # production — the refund tx ran out of gas and the admin's reject
        # "succeeded" while the refund died.
        gas_price = None
        try:
            gas_price = w3.eth.gas_price
            required_wei = _REFUND_GAS_LIMIT * gas_price
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
            # Non-gas preflight error — fall through; the send attempt below
            # produces the authoritative error.

        nonce = w3.eth.get_transaction_count(refund_account.address)
        if gas_price is None:
            gas_price = w3.eth.gas_price

        tx = token.functions.transfer(recipient, amount_wei).build_transaction({
            "chainId": CHAIN_ID,
            "gas": _REFUND_GAS_LIMIT,
            "gasPrice": gas_price,
            "nonce": nonce,
            "from": refund_account.address,
        })

        signed = w3.eth.account.sign_transaction(tx, private_key=refund_account.key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith("0x"):
            tx_hash_hex = "0x" + tx_hash_hex

        # Patient receipt polling (same lesson as the reloadly refund): raising
        # on a 60s timeout here would hard-fail the refund even though the tx
        # was already broadcast and could still confirm — a later re-send would
        # DOUBLE-refund.
        receipt = _wait_for_receipt_patient(w3, tx_hash, timeout=60)
        if receipt is None:
            return {
                "success": False,
                "error": "Refund tx broadcast but not confirmed within 60s — will be re-checked before any retry.",
                "error_type": "submitted_unconfirmed",
                "tx_hash": tx_hash_hex,
            }
        if receipt.get("status") == 1:
            return {"success": True, "tx_hash": tx_hash_hex}
        return {"success": False, "error": "Refund transaction reverted on-chain.", "error_type": "tx_reverted"}
    except Exception as e:
        logger.error(f"❌ GCash send_refund error for request {request_id}: {e}")
        if _is_insufficient_gas_error(e):
            return {
                "success": False,
                "error": "GCash refund wallet needs a gas refill.",
                "error_type": "insufficient_gas",
            }
        return {"success": False, "error": str(e)}


def _wait_for_receipt_patient(w3, tx_hash, timeout=60):
    """Poll for a tx receipt, tolerating RPC hiccups. Returns None on timeout
    (instead of raising) so callers can park the refund instead of failing it."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt is not None:
                return receipt
        except Exception:
            pass
        time.sleep(2)
    return None


def check_refund_tx_status(tx_hash) -> str:
    """On-chain status of a previously-broadcast refund tx:
    "confirmed" | "reverted" | "pending" (not found / RPC error)."""
    w3 = _get_w3()
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except Exception:
        return "pending"
    if receipt is None:
        return "pending"
    return "confirmed" if receipt.get("status") == 1 else "reverted"


def process_claimed_refund(request: dict, success_note: str) -> dict:
    """Send (or finalize) the refund for a request already CAS-claimed (status
    'refunding'). Checks any previously-broadcast refund tx BEFORE re-sending so
    a receipt-timeout retry can never double-refund."""
    request_id = request["id"]
    prior_tx = request.get("refund_tx_hash")
    if prior_tx:
        status = check_refund_tx_status(prior_tx)
        if status == "confirmed":
            update_request(request_id, {
                "status": "refunded",
                "admin_note": success_note,
                "refund_tx_hash": prior_tx,
                "reviewed_at": datetime.now(timezone.utc).isoformat(),
            })
            return {"success": True, "tx_hash": prior_tx, "already_confirmed": True}
        if status == "pending":
            update_request(request_id, {
                "status": "refund_failed",
                "admin_note": "Refund tx already broadcast and still confirming on-chain — will be re-checked on the next retry.",
                "reviewed_at": datetime.now(timezone.utc).isoformat(),
            })
            return {"success": False, "error": "Prior refund tx still confirming on-chain.", "error_type": "submitted_unconfirmed"}
        # reverted → fall through and re-send

    result = send_refund(request["wallet_address"], request["amount_gd"], request_id)
    if result["success"]:
        update_request(request_id, {
            "status": "refunded",
            "admin_note": success_note,
            "refund_tx_hash": result["tx_hash"],
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        })
    else:
        updates = {
            "status": "refund_failed",
            "admin_note": f"Refund failed: {result.get('error', 'unknown')}",
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        }
        if result.get("tx_hash"):
            updates["refund_tx_hash"] = result["tx_hash"]
        update_request(request_id, updates)
    return result


def auto_refund_failed_cashout(wallet, gcash_number, gcash_name, tx_hash, received_amount_gd, reason) -> dict:
    """The user's G$ DID reach GCASH_ADDRESS but the cashout request failed
    verification — record it and immediately refund the exact amount received so
    the user is never left stuck without funds or a record.

    Returns a dict with keys: refunded, recorded, request_id, refund_tx_hash,
    already_recorded, error, error_type (whichever apply).
    """
    existing = get_request_by_tx_hash(tx_hash)
    if existing:
        return {
            "refunded": existing["status"] in ("refunded", "rejected"),
            "already_recorded": True,
            "request": existing,
            "error": f"This transfer was already submitted (request #{existing['id']}, status: {existing['status']}).",
        }

    received = Decimal(str(received_amount_gd))
    php = (received / GD_PER_PESO).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    created = create_cashout_request(wallet, gcash_number, gcash_name, received, php, tx_hash)
    if not created["success"]:
        # Row couldn't be recorded (e.g. the old amount_gd>=5000 CHECK is still
        # in place and the received amount is below it) — refund anyway so the
        # funds are never stuck.
        logger.error(f"⚠️ GCash auto-refund: could not record request for tx {tx_hash[:16]}… — refunding without a row")
        result = send_refund(wallet, received, 0)
        out = {"refunded": result["success"], "recorded": False, "error": result.get("error"), "error_type": result.get("error_type")}
        if result.get("tx_hash"):
            out["refund_tx_hash"] = result["tx_hash"]
        return out

    req = created["request"]
    if not claim_request_for_refund(req["id"], expected_status="pending"):
        return {"refunded": False, "recorded": True, "request_id": req["id"], "error": "Request is already being processed."}

    note = f"Auto-refund: cashout verification failed ({reason}). Refunded the {received:,.2f} G$ received."
    result = process_claimed_refund(req, note)
    out = dict(result)
    out["recorded"] = True
    out["request_id"] = req["id"]
    out["refunded"] = bool(result.get("success"))
    if result.get("tx_hash"):
        out["refund_tx_hash"] = result["tx_hash"]
    return out


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
