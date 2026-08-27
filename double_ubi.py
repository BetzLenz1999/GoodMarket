"""Double UBI bonus — send users an extra G$ equal to their claimed UBI amount.

Whenever a GoodMarket user confirms a Celo UBI claim through /wallet, they are
entitled to a **bonus equal to the amount they just claimed** (e.g. claim
120 G$ -> receive a *further* +120 G$, funded by the ``DOUBLEUBI_KEY`` wallet).
This mirrors the referral auto-disbursement: the trigger lives in
``routes.py`` ``/api/claims/v2/confirm`` on ``network=celo + status=confirmed``,
and this module does the durable, double-pay-safe payout.

Why a durable log table is required:
  * The claim confirm endpoint is called (at least) twice per claim — once
    with ``submitted`` and again with ``confirmed`` — and the reconciler may
    re-verify an already-confirmed row, so the trigger must be idempotent.
  * A worker can die mid-send (gunicorn recycle). The row keeps its bonus
    ``tx_hash`` and any later pass checks that tx on-chain BEFORE re-sending,
    so a slow RPC can never cause a double bonus.

Safety properties (lessons carried over from Reloadly / GCash refunds and the
daily reward that this mirrors):
  * Fixed gas budget — NOT estimate-based (Reloadly PR #169 lesson).
  * CELO gas + G$ balance preflights on ``DOUBLEUBI_KEY`` return
    ``insufficient_gas`` / ``insufficient_balance``; rows stay ``pending`` and
    retry automatically once the admin tops up the wallet — never ``failed``.
  * ``UNIQUE(claim_tx_hash)`` + CAS claim (pending -> sending) means concurrent
    triggers / multi-worker gunicorn can never double-pay a claim.

Env knobs (all optional unless noted):
    DOUBLE_UBI_ENABLED|DOUBLEUBI_ENABLED — "1"/"true" to enable (default off)
    DOUBLEUBI_KEY                          – REQUIRED: private key of the sender
                                              wallet (needs G$ balance AND CELO gas)
    DOUBLE_UBI_RETRY_INTERVAL_SEC         – scheduler wake interval (default 300)
    DOUBLE_UBI_MAX_PER_PASS               – cap rows drained per pass (default 200)
    DOUBLE_UBI_MAX_RETRY_ATTEMPTS         – attempts before 'failed' (default 5)
    DOUBLE_UBI_STALE_RECLAIM_SECS         – reclaim stuck 'sending' rows (default 600)
    DOUBLE_UBI_GAS_LIMIT                  – fixed gas budget (default 250000)
"""
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from env_utils import get_env_int

logger = logging.getLogger(__name__)

# Accepted env spellings for the feature switch.
_ENABLED_VAL = os.getenv("DOUBLE_UBI_ENABLED", "") or os.getenv("DOUBLEUB_ENABLED", "")
_ENABLED = (_ENABLED_VAL or "0").strip().lower() in ("1", "true", "yes", "on")

_POLL_SECONDS = get_env_int("DOUBLE_UBI_RETRY_INTERVAL_SEC", 300)
_MAX_PER_PASS = get_env_int("DOUBLE_UBI_MAX_PER_PASS", 200)
_MAX_RETRY_ATTEMPTS = get_env_int("DOUBLE_UBI_MAX_RETRY_ATTEMPTS", 5)
_STALE_RECLAIM_SECS = get_env_int("DOUBLE_UBI_STALE_RECLAIM_SECS", 600)

# ERC-20 transfer gas budget for a bonus payout. Fixed on purpose — see the
# module docstring (Reloadly PR #169 lesson).
BONUS_GAS_LIMIT = get_env_int("DOUBLE_UBI_GAS_LIMIT", 250000)

GD_TOKEN = os.getenv(
    "GOODDOLLAR_CONTRACT_ADDRESS",
    "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
)
CELO_RPC_URL = os.getenv("CELO_RPC_URL", "https://forno.celo.org")
CHAIN_ID = get_env_int("CHAIN_ID", 42220)

_ERC20_ABI = [
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

# keccak256("Transfer(address,address,uint256)") — decoded manually from claim
# receipt logs (same pattern as gcash/reloadly) so we never depend on a
# contract ABI carrying the event.
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()
_schema_missing = False  # latched when the log-table migration isn't applied


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_supabase():
    from supabase_client import get_supabase_admin_client, get_supabase_client
    return get_supabase_admin_client() or get_supabase_client()


def _format_amount(amount: float) -> str:
    """12.0 -> '12', 12.5 -> '12.5', 120.12 -> '120.12' (no noisy trailing zeros)."""
    return ("%f" % float(amount)).rstrip("0").rstrip(".")


def is_double_ubi_enabled() -> bool:
    """True when the feature is on AND the sender wallet key is configured."""
    # Read live (not the import-time _ENABLED cache) so tests and late env
    # config can flip the feature without re-importing the module.
    flag = os.getenv("DOUBLE_UBI_ENABLED", "") or os.getenv("DOUBLEUB_ENABLED", "")
    if (flag or "0").strip().lower() not in ("1", "true", "yes", "on"):
        return False
    return bool(os.getenv("DOUBLEUBI_KEY"))


def get_double_ubi_key() -> str:
    key = os.getenv("DOUBLEUBI_KEY", "").strip()
    if key and not key.startswith("0x"):
        key = "0x" + key
    return key


# ── On-chain disbursement (DOUBLEUBI_KEY direct G$ transfer) ─────────────

def _is_insufficient_gas_error(err: Exception) -> bool:
    msg = str(err).lower()
    return (
        "insufficient funds" in msg
        or "insufficient gas" in msg
        or "gas required exceeds allowance" in msg
        or "intrinsic gas too low" in msg
        or "max fee per gas less" in msg
    )


def normalize_log_topic(value) -> str:
    """Hex-normalize an event topic (web3 may hand back bytes or a hex str)."""
    h = value if isinstance(value, str) else value.hex()
    if not h.startswith("0x"):
        h = "0x" + h
    return h.lower()


def _new_w3():
    """Lazy web3 handle (module imports must stay dependency-free)."""
    from web3 import Web3
    return Web3(Web3.HTTPProvider(CELO_RPC_URL))


def _decode_received_gd_amount(receipt, to_recipient: str) -> int:
    """Return the G$ (wei) received by ``to_recipient`` in ``receipt``.

    Sums every G$ Transfer event whose ``to`` is the wallet — the UBI claim sends
    exactly the entitlement to the claimant from the UBIScheme proxy, so this is
    the authoritative claimed amount. ABI-free, topic-based (like gcash/reloadly).
    """
    total = 0
    if not receipt:
        return 0
    try:
        to_l = (to_recipient or "").lower()
        for log in receipt.get("logs") or []:
            try:
                if (log.get("address") or "").lower() != GD_TOKEN.lower():
                    continue
                topics = log.get("topics") or []
                if len(topics) < 3:
                    continue
                if normalize_log_topic(topics[0]) != TRANSFER_TOPIC:
                    continue
                t_to = ("0x" + normalize_log_topic(topics[2])[-40:]).lower()
                data = log.get("data")
                value = int(data, 16) if data else 0
                if t_to == to_l:
                    total += value
            except Exception:
                continue
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ DOUBLE bonus: receipt decode failed: %s", exc)
    return total


def compute_claimed_amount_from_tx(claim_tx_hash: str, wallet: str) -> dict:
    """Determine how much G$ the wallet received from a claim tx on Celo.

    Reads the on-chain receipt and decodes the G$ Transfer to the wallet.
    Returns ``{"success": True, "amount_gd": float}`` (0 when the receipt isn't
    found yet, the tx isn't a G$ transfer to the wallet, or the wallet doesn't
    match the tx ``to``) or ``{"success": False, "error": ...}`` on RPC failure.
    """
    try:
        w3 = _new_w3()
        if not w3.is_connected():
            return {"success": False, "error": "Cannot connect to Celo network"}
        try:
            receipt = w3.eth.get_transaction_receipt(claim_tx_hash)
        except Exception as exc:  # noqa: BLE001
            logger.info("⚠️ DOUBLE bonus: no receipt yet for %s: %s", claim_tx_hash, exc)
            return {"success": True, "amount_gd": 0.0, "pending": True}
        if receipt is None:
            return {"success": True, "amount_gd": 0.0, "pending": True}
        if receipt.get("status") != 1:
            return {"success": True, "amount_gd": 0.0, "reverted": True}
        wei = _decode_received_gd_amount(receipt, wallet)
        return {"success": True, "amount_gd": wei / (10 ** 18), "pending": False}
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ DOUBLE bonus: could not inspect claim tx %s: %s", claim_tx_hash, exc)
        return {"success": False, "error": str(exc)}


def _init_sender_context():
    """Build the sender context, running CELO-gas + G$-balance preflights.

    Returns ``(ctx, None)`` or ``(None, error_dict)``. Never raises.
    """
    try:
        from web3 import Web3
        from eth_account import Account

        double_key = get_double_ubi_key()
        if not double_key:
            return None, {"success": False, "error": "DOUBLEUBI_KEY not configured", "error_type": "no_key"}

        w3 = Web3(Web3.HTTPProvider(CELO_RPC_URL))
        if not w3.is_connected():
            return None, {"success": False, "error": "Cannot connect to Celo network", "error_type": "rpc_unreachable"}

        try:
            sender = Account.from_key(double_key)
        except Exception as key_error:  # noqa: BLE001
            return None, {"success": False, "error": f"DOUBLEUBI_KEY invalid: {key_error}", "error_type": "invalid_key"}

        token = w3.eth.contract(
            address=Web3.to_checksum_address(GD_TOKEN),
            abi=_ERC20_ABI,
        )
        gas_price = int(w3.eth.gas_price * 1.2)

        # CELO gas preflight — fixed-budget check (Reloadly PR #169 lesson).
        try:
            celo_balance = w3.eth.get_balance(sender.address)
            required_gas_wei = BONUS_GAS_LIMIT * gas_price
            if celo_balance < required_gas_wei:
                logger.error(
                    "❌ DOUBLE bonus: DOUBLEUBI_KEY wallet has insufficient CELO for gas: "
                    "%s CELO < %s CELO. Please top up %s.",
                    celo_balance / 10 ** 18, required_gas_wei / 10 ** 18, sender.address,
                )
                return None, {
                    "success": False,
                    "error": "DOUBLEUBI_KEY wallet needs CELO for gas",
                    "error_type": "insufficient_gas",
                }
        except Exception as gas_err:  # noqa: BLE001
            logger.error("❌ DOUBLE bonus: CELO balance check failed: %s", gas_err)
            return None, {"success": False, "error": "Failed to check DOUBLEUBI_KEY wallet gas", "error_type": "gas_check_failed"}

        try:
            gd_balance_wei = token.functions.balanceOf(sender.address).call()
        except Exception as bal_err:  # noqa: BLE001
            logger.error("❌ DOUBLE bonus: G$ balance check failed: %s", bal_err)
            return None, {"success": False, "error": "Failed to read DOUBLEUBI_KEY wallet G$ balance", "error_type": "balance_check_failed"}

        next_nonce = w3.eth.get_transaction_count(sender.address, "pending")
        return {
            "w3": w3,
            "token": token,
            "sender": sender,
            "key": double_key,
            "gas_price": gas_price,
            "next_nonce": next_nonce,
            "gd_budget_wei": gd_balance_wei,
        }, None
    except Exception as e:  # noqa: BLE001
        logger.exception("❌ DOUBLE bonus: could not init sender context: %s", e)
        return None, {"success": False, "error": str(e), "error_type": "unexpected"}


def _send_bonus(ctx, wallet: str, bonus_g: float) -> dict:
    """Broadcast a bonus G$ transfer from DOUBLEUBI_KEY to ``wallet``.

    Returns dict with ``success`` + ``tx_hash`` on broadcast, or ``error`` +
    ``error_type``. Never raises.
    """
    try:
        from web3 import Web3
        amount_wei = int(round(float(bonus_g) * (10 ** 18)))

        if ctx["gd_budget_wei"] < amount_wei:
            logger.error(
                "❌ DOUBLE bonus: DOUBLEUBI_KEY wallet G$ budget exhausted: %s G$ left < %s G$ needed. "
                "Please top up %s.",
                ctx["gd_budget_wei"] / 10 ** 18, amount_wei / 10 ** 18, ctx["sender"].address,
            )
            return {
                "success": False,
                "error": "DOUBLEUBI_KEY wallet has insufficient G$",
                "error_type": "insufficient_balance",
            }

        recipient = Web3.to_checksum_address(wallet)
        nonce = ctx["next_nonce"]
        ctx["next_nonce"] += 1

        try:
            tx = ctx["token"].functions.transfer(recipient, amount_wei).build_transaction({
                "chainId": CHAIN_ID,
                "gas": BONUS_GAS_LIMIT,
                "gasPrice": ctx["gas_price"],
                "nonce": nonce,
                "from": ctx["sender"].address,
            })
        except Exception as build_err:  # noqa: BLE001
            return {"success": False, "error": f"Failed to build transaction: {build_err}", "error_type": "build_failed"}

        try:
            signed_tx = ctx["w3"].eth.account.sign_transaction(tx, ctx["key"])
            tx_hash = ctx["w3"].eth.send_raw_transaction(signed_tx.raw_transaction)
            tx_hash_hex = tx_hash.hex()
            if not tx_hash_hex.startswith("0x"):
                tx_hash_hex = "0x" + tx_hash_hex
            ctx["gd_budget_wei"] -= amount_wei
            logger.info("📤 DOUBLE bonus broadcast: %s G$ to %s… | tx=%s",
                        _format_amount(bonus_g), wallet[:10], tx_hash_hex)
            return {
                "success": True,
                "tx_hash": tx_hash_hex,
                "amount": amount_wei / 10 ** 18,
                "recipient": wallet,
                "explorer_url": f"https://celoscan.io/tx/{tx_hash_hex}",
            }
        except Exception as send_err:  # noqa: BLE001
            logger.error("❌ DOUBLE bonus: failed to send transfer tx: %s", send_err)
            error_type = "insufficient_gas" if _is_insufficient_gas_error(send_err) else "send_failed"
            return {"success": False, "error": f"Failed to send transaction: {send_err}", "error_type": error_type}
    except Exception as e:  # noqa: BLE001
        logger.exception("DOUBLE bonus disbursement error: %s", e)
        return {"success": False, "error": str(e), "error_type": "unexpected"}


def _wait_for_receipt(w3, tx_hash, timeout_sec: float = 45.0, poll_sec: float = 2.0):
    """Wait for a bonus tx receipt, returning None on timeout (never raises)."""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt is not None:
                return receipt
        except Exception:
            pass
        time.sleep(poll_sec)
    return None


def _check_bonus_tx_status(tx_hash: str) -> str:
    """Return ``confirmed`` / ``reverted`` / ``pending`` for a broadcast bonus tx."""
    try:
        from web3 import Web3
        w3 = Web3(Web3.HTTPProvider(CELO_RPC_URL))
        if not w3.is_connected():
            return "pending"
        receipt = w3.eth.get_transaction_receipt(tx_hash)
        if receipt is None:
            return "pending"
        return "confirmed" if receipt.status == 1 else "reverted"
    except Exception as e:  # noqa: BLE001
        logger.warning("⚠️ DOUBLE bonus: _check_bonus_tx_status(%s) failed: %s", tx_hash, e)
        return "pending"


# ── Durable log-table helpers ─────────────────────────────────────────────

def _reclaim_stale_sending():
    """Flip 'sending' rows idle for too long back to 'pending'.

    A worker killed mid-send strands the row in 'sending' forever; the tx_hash
    (if any) is PRESERVED so the next pass checks it on-chain before deciding.
    """
    supabase = _get_supabase()
    if not supabase:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=_STALE_RECLAIM_SECS)).isoformat()
    try:
        result = (
            supabase.table("double_ubi_rewards")
            .update({"status": "pending", "updated_at": _now_iso()})
            .eq("status", "sending")
            .lt("updated_at", cutoff)
            .execute()
        )
        reclaimed = len(result.data or [])
        if reclaimed:
            logger.warning("⚠️ DOUBLE bonus: reclaimed %d stale 'sending' row(s)", reclaimed)
        return reclaimed
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ DOUBLE bonus: could not reclaim stale rows: %s", exc)
        return 0


def _fetch_pending_rows(limit: int):
    supabase = _get_supabase()
    if not supabase:
        return []
    try:
        result = (
            supabase.table("double_ubi_rewards")
            .select("*")
            .eq("status", "pending")
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception as exc:  # noqa: BLE001
        logger.exception("⚠️ DOUBLE bonus: could not fetch pending rows: %s", exc)
        return []


def _has_pending_rows() -> bool:
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("double_ubi_rewards")
            .select("id")
            .eq("status", "pending")
            .limit(1)
            .execute()
        )
        return bool(result.data)
    except Exception:  # noqa: BLE001
        return False


def _claim_row(row_id) -> bool:
    """CAS-claim a pending row (pending -> sending). Only the winner proceeds."""
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("double_ubi_rewards")
            .update({"status": "sending", "updated_at": _now_iso()})
            .eq("id", row_id)
            .eq("status", "pending")
            .execute()
        )
        return bool(result.data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ DOUBLE bonus: claim failed for row %s: %s", row_id, exc)
        return False


def _update_row(row_id, fields: dict) -> None:
    supabase = _get_supabase()
    if not supabase:
        return
    fields["updated_at"] = _now_iso()
    try:
        supabase.table("double_ubi_rewards").update(fields).eq("id", row_id).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ DOUBLE bonus: could not update row %s: %s", row_id, exc)


# ── Pass / row processing ────────────────────────────────────────────────

def _new_summary() -> dict:
    return {
        "processed": 0, "sent": 0, "broadcasted": 0,
        "retry": 0, "failed": 0, "skipped": 0, "resend": 0,
    }


def _settle_row(row: dict, summary: dict) -> str:
    """Claim + process a single pending row. Returns a status string.

    Handles prior-tx verification (resend only if the prior tx reverted) and
    funding shortfalls (stay pending, never failed). Counter updates are left
    to the caller (``run_pass_once``) so a return here never double-counts.
    """
    row_id = row["id"]
    wallet = (row.get("wallet_address") or "").strip().lower()
    bonus = float(row.get("bonus_amount_gd") or 0)
    attempts = int(row.get("attempts") or 0)
    prior_bonus_tx = row.get("bonus_tx_hash")

    if not wallet or bonus <= 0:
        # Safety: never broadcast to an empty/suspicious row.
        _update_row(row_id, {"status": "failed", "last_error": "invalid row (no wallet or amount)"})
        return "failed"

    if not _claim_row(row_id):
        return "skipped"  # another worker won the CAS flip

    if prior_bonus_tx:
        prior_status = _check_bonus_tx_status(prior_bonus_tx)
        if prior_status == "confirmed":
            _update_row(row_id, {"status": "sent", "bonus_tx_hash": prior_bonus_tx, "sent_at": _now_iso(), "last_error": None})
            return "sent"
        if prior_status == "pending":
            _update_row(row_id, {"status": "pending", "last_error": "prior tx still unconfirmed"})
            return "retry"
        # Reverted — funds never moved, clear the hash and send fresh.
        _update_row(row_id, {"status": "pending", "bonus_tx_hash": None, "last_error": f"prior tx reverted: {prior_bonus_tx}"})

    ctx, ctx_err = _init_sender_context()
    if ctx_err:
        error_type = ctx_err.get("error_type") or "error"
        error_msg = str(ctx_err.get("error") or "unknown error")[:500]
        _update_row(row_id, {"status": "pending", "last_error": error_msg, "attempts": attempts + 1})
        if error_type in ("insufficient_gas", "insufficient_balance", "no_key", "invalid_key", "no_table"):
            return "retry"
        return "retry"

    result = _send_bonus(ctx, wallet, bonus)
    if result.get("success"):
        tx_hash = result["tx_hash"]
        receipt = _wait_for_receipt(ctx["w3"], tx_hash)
        if receipt is not None and receipt.get("status") == 1:
            _update_row(row_id, {"status": "sent", "bonus_tx_hash": tx_hash, "sent_at": _now_iso(), "last_error": None})
            return "sent"
        # Broadcast only — NOT confirmed yet. Keep pending with the hash so the
        # next pass verifies on-chain before ever considering a re-send.
        _update_row(row_id, {
            "status": "pending", "bonus_tx_hash": tx_hash,
            "last_error": "broadcast, awaiting confirmation",
            "attempts": attempts + 1,
        })
        return "broadcasted"

    error_type = result.get("error_type") or "error"
    error_msg = str(result.get("error") or "unknown error")[:500]

    if error_type in ("insufficient_gas", "insufficient_balance"):
        _update_row(row_id, {"status": "pending", "last_error": error_msg, "attempts": attempts + 1})
        return "retry"

    if attempts + 1 >= _MAX_RETRY_ATTEMPTS:
        _update_row(row_id, {"status": "failed", "last_error": error_msg, "attempts": attempts + 1})
        return "failed"

    _update_row(row_id, {"status": "pending", "last_error": error_msg, "attempts": attempts + 1})
    return "retry"


def run_pass_once() -> dict:
    """Drain pending bonus rows (one synchronous batch). Returns a summary."""
    summary = _new_summary()
    if not is_double_ubi_enabled():
        summary["disabled"] = True
        return summary
    _reclaim_stale_sending()
    rows = _fetch_pending_rows(_MAX_PER_PASS)
    summary["processed"] = len(rows)
    for row in rows:
        status = _settle_row(row, summary)
        summary[status] = summary.get(status, 0) + 1
    return summary


# ── Public API for the trigger ───────────────────────────────────────────

def queue_and_fire_async(wallet: str, claim_tx_hash: str, claimed_amount_g, bonus: float = 0.0) -> dict:
    """Record the bonus intent (non-blocking) and start the payout in a thread.

    Used by the /api/claims/v2/confirm trigger. Writes the pending row
    (idempotent on claim_tx_hash) and fires a daemon worker so the claim
    response stays fast; the scheduler + the immediate worker share the durable
    log to guarantee delivery exactly once.
    """
    if not is_double_ubi_enabled():
        return {"success": False, "error_type": "disabled", "error": "Double UBI not enabled"}
    if not claim_tx_hash:
        return {"success": False, "error_type": "no_claim", "error": "missing claim tx hash"}

    claimed = max(float(claimed_amount_g or 0), 0.0)
    if claimed <= 0:
        return {"success": False, "error_type": "no_amount", "error": "no claimed amount"}

    bonus = float(bonus or claimed)
    try:
        supabase = _get_supabase()
        if supabase is None:
            logger.warning("⚠️ DOUBLE bonus: no DB — cannot queue %s", claim_tx_hash)
            return {"success": False, "error_type": "no_db", "error": "Storage unavailable"}

        row = {
            "wallet_address": (wallet or "").strip().lower(),
            "claim_tx_hash": claim_tx_hash.strip().lower(),
            "claimed_amount_gd": claimed,
            "bonus_amount_gd": bonus,
            "status": "pending",
        }
        # Idempotent insert: only add a row when no row exists yet for this
        # claim_tx_hash. A reference UPDATE (upsert) would reset a processed
        # "sent" row back to "pending" and let the scheduler double-pay.
        try:
            existing = supabase.table("double_ubi_rewards") \
                .select("id", "status") \
                .eq("claim_tx_hash", row["claim_tx_hash"]) \
                .execute()
            _existing_rows = getattr(existing, "data", None) or []
            if _existing_rows:
                logger.info("🌓 DOUBLE bonus: claim %s already logged (status=%s) — skipping queue",
                            row["claim_tx_hash"], _existing_rows[0].get("status"))
                return {
                    "success": True,
                    "bonus_amount_gd": bonus,
                    "already_exists": True,
                    "status": _existing_rows[0].get("status"),
                }
            supabase.table("double_ubi_rewards").insert(row).execute()
        except Exception as upsert_exc:  # noqa: BLE001
            if "double_ubi_rewards" in str(upsert_exc) or "does not exist" in str(upsert_exc):
                global _schema_missing
                _schema_missing = True
                logger.error(
                    "❌ DOUBLE bonus: log table missing — run sql/double_ubi_reward.sql "
                    "in Supabase, then restart. (error: %s)", upsert_exc,
                )
                return {"success": False, "error_type": "no_table", "error": "Run sql/double_ubi_reward.sql first."}
            logger.exception("⚠️ DOUBLE bonus: insert failed: %s", upsert_exc)
            return {"success": False, "error_type": "db_error", "error": str(upsert_exc)}

        threading.Thread(
            target=run_pass_once,
            name="double-ubi-bonus",
            daemon=True,
        ).start()
        return {"success": True, "status": "queued", "bonus_amount_gd": bonus, "claimed_amount_gd": claimed}
    except Exception as exc:  # noqa: BLE001
        logger.exception("⚠️ DOUBLE bonus: queue failed: %s", exc)
        return {"success": False, "error_type": "unexpected", "error": str(exc)}


def record_and_settle_sync(wallet: str, claim_tx_hash: str, claimed_g: float, bonus: float = 0.0) -> dict:
    """Record the pending row and settle it synchronously (tests / cron)."""
    claimed = max(float(claimed_g or 0), 0.0)
    bonus = float(bonus or claimed)
    if claimed <= 0:
        return {"success": False, "error_type": "no_amount", "error": "no claimed amount"}
    supabase = _get_supabase()
    if supabase is None:
        return {"success": False, "error_type": "no_db", "error": "Storage unavailable"}
    try:
        row = {
            "wallet_address": (wallet or "").strip().lower(),
            "claim_tx_hash": (claim_tx_hash or "").strip().lower(),
            "claimed_amount_gd": claimed,
            "bonus_amount_gd": bonus,
            "status": "pending",
        }
        result = (
            supabase.table("double_ubi_rewards")
            .upsert(row, on_conflict="claim_tx_hash")
            .execute()
        )
        data = (result.data or [{}])[0]
        summary = _new_summary()
        status = _settle_row(data, summary)
        return {"success": True, "status": status}
    except Exception as exc:  # noqa: BLE001
        logger.exception("⚠️ DOUBLE bonus: record+settle failed: %s", exc)
        if "double_ubi_rewards" in str(exc) or "does not exist" in str(exc):
            return {"success": False, "error_type": "no_table", "error": "Run sql/double_ubi_reward.sql first."}
        return {"success": False, "error_type": "db_error", "error": str(exc)}


# ── Scheduler ─────────────────────────────────────────────────────────────

def _scheduler_loop():
    """Wake periodically and drain any pending bonus rows."""
    while not _scheduler_stop.is_set():
        try:
            run_pass_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("⚠️ DOUBLE bonus scheduler crashed: %s", exc)
        _scheduler_stop.wait(_POLL_SECONDS)


def init_double_ubi_bonus_scheduler(app=None):
    """Start the background double-UBI retry thread. Returns True if started."""
    global _scheduler_thread
    if not is_double_ubi_enabled():
        logger.info("ℹ️ DOUBLE bonus scheduler disabled (set DOUBLE_UBI_ENABLED=1 + DOUBLEUBI_KEY)")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            name="double-ubi-bonus-scheduler",
            daemon=True,
        )
        _scheduler_thread.start()
        logger.info("✅ DOUBLE bonus scheduler started (retry every %s s).", _POLL_SECONDS)
        return True


def shutdown_double_ubi_bonus_scheduler():
    """Signal the scheduler thread to stop (best-effort, for tests)."""
    _scheduler_stop.set()
