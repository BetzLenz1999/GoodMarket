"""Daily Telegram appreciation reward scheduler.

Every day at 10:00 AM Philippine time (02:00 UTC — the Philippines has no
daylight-saving time, so the UTC slot is stable), every Telegram bot user who
linked a wallet receives a small G$ appreciation token (default 10 G$) from the
``DAILYTASK_KEY`` wallet, followed by a Telegram thank-you message.

Disbursement is a direct G$ ERC-20 transfer signed by ``DAILYTASK_KEY`` — the
same proven pattern as ``telegram_task/blockchain.py`` (no reward contract
involved). Delivery is durable: one ``telegram_daily_reward_log`` row per
wallet per UTC day (UNIQUE constraint) is the source of truth, claimed via CAS
(pending -> sending) so multiple gunicorn workers / restarts can never
double-pay. Requires ``sql/telegram_daily_reward.sql`` to be applied first.

Safety properties (lessons carried over from the Reloadly / GCash refund work):
  * Fixed 250k gas budget — NOT estimate-based (the estimate-based preflight
    from Reloadly PR #169 broke refunds in production and was reverted).
  * CELO gas + G$ balance preflights return ``insufficient_gas`` /
    ``insufficient_balance``; those rows stay ``pending`` and retry
    automatically once the admin tops up the DAILYTASK_KEY wallet.
  * A broadcast-but-unconfirmed tx keeps its ``tx_hash`` on the row; the next
    pass checks the on-chain receipt BEFORE any re-send, so a slow RPC can
    never cause a double payment.
  * Rows stuck in ``sending`` (worker killed mid-send) are reclaimed after
    ``TELEGRAM_DAILY_REWARD_STALE_CLAIM_SECONDS``.

Env knobs (all optional unless noted):
    TELEGRAM_DAILY_REWARD_ENABLED            – "1"/"true" to enable (default off)
    TELEGRAM_DAILY_REWARD_AMOUNT_GD          – G$ per wallet per day (default 10)
    TELEGRAM_DAILY_REWARD_UTC_HOUR           – fire hour, 0-23 (default 2 = 10 AM PHT)
    TELEGRAM_DAILY_REWARD_UTC_MINUTE         – fire minute (default 0)
    TELEGRAM_DAILY_REWARD_POLL_SECONDS       – scheduler wake interval (default 300)
    TELEGRAM_DAILY_REWARD_MAX_USERS          – cap rows processed per pass (default 500)
    TELEGRAM_DAILY_REWARD_SEND_DELAY_SEC     – pause between transfers (default 1.0)
    TELEGRAM_DAILY_REWARD_MAX_RETRY_ATTEMPTS – attempts before 'failed' (default 5)
    TELEGRAM_DAILY_REWARD_STALE_CLAIM_SECONDS – reclaim stuck 'sending' rows (default 600)
    TELEGRAM_DAILY_REWARD_MESSAGE            – optional message override; supports
                                               {amount} and {explorer_url} placeholders
    DAILYTASK_KEY                            – REQUIRED: private key of the sender wallet
                                               (needs G$ balance AND CELO gas)
    TELEGRAM_BOT_TOKEN                       – REQUIRED (shared with the bot)
"""
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from env_utils import get_env_float, get_env_int

logger = logging.getLogger(__name__)

_ENABLED = os.getenv("TELEGRAM_DAILY_REWARD_ENABLED", "").lower() in ("1", "true", "yes", "on")
_AMOUNT_GD = get_env_float("TELEGRAM_DAILY_REWARD_AMOUNT_GD", 10.0)
_UTC_HOUR = get_env_int("TELEGRAM_DAILY_REWARD_UTC_HOUR", 2)
_UTC_MINUTE = get_env_int("TELEGRAM_DAILY_REWARD_UTC_MINUTE", 0)
_POLL_SECONDS = get_env_int("TELEGRAM_DAILY_REWARD_POLL_SECONDS", 300)
_MAX_USERS = get_env_int("TELEGRAM_DAILY_REWARD_MAX_USERS", 500)
_SEND_DELAY_SEC = get_env_float("TELEGRAM_DAILY_REWARD_SEND_DELAY_SEC", 1.0)
_MAX_RETRY_ATTEMPTS = get_env_int("TELEGRAM_DAILY_REWARD_MAX_RETRY_ATTEMPTS", 5)
_STALE_CLAIM_SECONDS = get_env_int("TELEGRAM_DAILY_REWARD_STALE_CLAIM_SECONDS", 600)
_RECEIPT_TIMEOUT_SEC = get_env_int("TELEGRAM_DAILY_REWARD_RECEIPT_TIMEOUT_SEC", 60)

# ERC-20 transfer gas budget for a reward payout. Fixed on purpose — see the
# module docstring (Reloadly PR #169 lesson).
REWARD_GAS_LIMIT = 250000

GD_TOKEN_CONTRACT = os.getenv(
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

_DEFAULT_MESSAGE = (
    "🎁 <b>You received an appreciation token from GoodMarket!</b>\n\n"
    "<b>{amount} G$</b> has been sent to your wallet as our daily thank-you "
    "for being part of the GoodMarket community. 💛\n\n"
    "Thank you for staying active with us — come back tomorrow for another reward!\n\n"
    "🔗 View transaction: {explorer_url}"
)

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()
_last_run_date = None  # in-memory dedup; the log table is the durable dedup
_schema_missing = False  # latched when the log-table migration clearly isn't applied


def _today_utc() -> str:
    """Return today's UTC date as YYYY-MM-DD (matches Postgres DATE cast)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_supabase():
    from supabase_client import get_supabase_admin_client, get_supabase_client
    return get_supabase_admin_client() or get_supabase_client()


def _format_amount(amount: float) -> str:
    """10.0 -> '10', 12.5 -> '12.5' (no trailing zeros in the user message)."""
    return ("%f" % float(amount)).rstrip("0").rstrip(".")


def build_reward_message(amount_gd: float, tx_hash: str) -> str:
    """Build the Telegram thank-you message for a confirmed payout.

    The wording is English by default; ``TELEGRAM_DAILY_REWARD_MESSAGE``
    overrides the whole template. Placeholders are substituted with plain
    ``str.replace`` so a custom message containing stray braces can't raise.
    """
    template = os.getenv("TELEGRAM_DAILY_REWARD_MESSAGE") or _DEFAULT_MESSAGE
    explorer_url = f"https://celoscan.io/tx/{tx_hash}" if tx_hash else ""
    return (
        template
        .replace("{amount}", _format_amount(amount_gd))
        .replace("{explorer_url}", explorer_url)
    )


def _send_telegram_message(chat_id: str, text: str) -> bool:
    """Lazy wrapper so this module imports without requests/telegram_notify."""
    from telegram_notify import send_message
    return send_message(chat_id, text)


# ── On-chain disbursement (DAILYTASK_KEY direct G$ transfer) ─────────────

def _is_insufficient_gas_error(err: Exception) -> bool:
    """True when an error indicates the sender wallet lacks CELO to pay gas."""
    msg = str(err).lower()
    return (
        "insufficient funds" in msg
        or "insufficient gas" in msg
        or "gas required exceeds allowance" in msg
        or "intrinsic gas too low" in msg
        or "max fee per gas less" in msg
    )


def _wait_for_receipt_patient(w3, tx_hash, timeout_sec: int = None, poll_sec: float = 2.0):
    """Poll for a tx receipt without raising on timeout (returns None instead).

    A timeout here does NOT mean the transfer failed — the tx was already
    broadcast and may still confirm, so callers must treat None as
    'submitted_unconfirmed' and never blindly re-send.
    """
    deadline = time.time() + (timeout_sec or _RECEIPT_TIMEOUT_SEC)
    while time.time() < deadline:
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt is not None:
                return receipt
        except Exception:
            # RPC hiccup or tx not yet visible — keep polling.
            pass
        time.sleep(poll_sec)
    return None


def check_reward_tx_status(tx_hash: str) -> str:
    """Return ``confirmed`` / ``reverted`` / ``pending`` for a broadcast reward tx.

    Used before any re-send of a row that already has a ``tx_hash`` — a payout
    whose tx was broadcast but unconfirmed when the worker stopped is never
    re-sent blindly (that would double-pay the user).
    """
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
        logger.warning("⚠️ Daily reward: check_reward_tx_status(%s) failed: %s", tx_hash, e)
        return "pending"


def send_daily_reward_gd(to_wallet: str, amount_gd: float) -> dict:
    """Send ``amount_gd`` G$ from the DAILYTASK_KEY wallet to ``to_wallet``.

    Returns a dict with ``success`` and either ``tx_hash`` or ``error`` +
    ``error_type`` (``insufficient_gas`` / ``insufficient_balance`` /
    ``submitted_unconfirmed`` / ``reverted`` / ...). Never raises.
    """
    try:
        from web3 import Web3
        from eth_account import Account

        dailytask_key = os.getenv("DAILYTASK_KEY")
        if not dailytask_key:
            return {"success": False, "error": "DAILYTASK_KEY not configured", "error_type": "no_key"}
        if not dailytask_key.startswith("0x"):
            dailytask_key = "0x" + dailytask_key

        w3 = Web3(Web3.HTTPProvider(CELO_RPC_URL))
        if not w3.is_connected():
            return {"success": False, "error": "Cannot connect to Celo network", "error_type": "rpc_unreachable"}

        try:
            sender = Account.from_key(dailytask_key)
        except Exception as key_error:  # noqa: BLE001
            return {"success": False, "error": f"DAILYTASK_KEY invalid: {key_error}", "error_type": "invalid_key"}

        token = w3.eth.contract(
            address=Web3.to_checksum_address(GD_TOKEN_CONTRACT),
            abi=_ERC20_ABI,
        )
        recipient = Web3.to_checksum_address(to_wallet)
        amount_wei = int(round(float(amount_gd) * (10 ** 18)))
        gas_price = int(w3.eth.gas_price * 1.2)

        # Pre-flight 1: CELO gas. Fixed-budget check (Reloadly PR #169 lesson).
        try:
            celo_balance = w3.eth.get_balance(sender.address)
            required_gas_wei = REWARD_GAS_LIMIT * gas_price
            if celo_balance < required_gas_wei:
                logger.error(
                    "❌ Daily reward: DAILYTASK_KEY wallet has insufficient CELO for gas: "
                    "%s CELO < %s CELO. Please top up %s.",
                    celo_balance / 10 ** 18, required_gas_wei / 10 ** 18, sender.address,
                )
                return {
                    "success": False,
                    "error": "DAILYTASK_KEY wallet needs CELO for gas",
                    "error_type": "insufficient_gas",
                }
        except Exception as gas_err:  # noqa: BLE001
            logger.error("❌ Daily reward: CELO balance check failed: %s", gas_err)
            return {"success": False, "error": "Failed to check DAILYTASK_KEY wallet gas", "error_type": "gas_check_failed"}

        # Pre-flight 2: G$ balance (a transfer with no balance reverts on-chain).
        try:
            gd_balance = token.functions.balanceOf(sender.address).call()
            if gd_balance < amount_wei:
                logger.error(
                    "❌ Daily reward: DAILYTASK_KEY wallet has insufficient G$: "
                    "%s G$ < %s G$. Please top up %s.",
                    gd_balance / 10 ** 18, amount_wei / 10 ** 18, sender.address,
                )
                return {
                    "success": False,
                    "error": "DAILYTASK_KEY wallet has insufficient G$",
                    "error_type": "insufficient_balance",
                }
        except Exception as bal_err:  # noqa: BLE001
            logger.error("❌ Daily reward: G$ balance check failed: %s", bal_err)
            return {"success": False, "error": "Failed to read DAILYTASK_KEY wallet G$ balance", "error_type": "balance_check_failed"}

        try:
            tx = token.functions.transfer(recipient, amount_wei).build_transaction({
                "chainId": CHAIN_ID,
                "gas": REWARD_GAS_LIMIT,
                "gasPrice": gas_price,
                "nonce": w3.eth.get_transaction_count(sender.address),
                "from": sender.address,
            })
        except Exception as build_err:  # noqa: BLE001
            logger.error("❌ Daily reward: failed to build transfer tx: %s", build_err)
            return {"success": False, "error": f"Failed to build transaction: {build_err}", "error_type": "build_failed"}

        try:
            signed_tx = w3.eth.account.sign_transaction(tx, dailytask_key)
            tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
            tx_hash_hex = tx_hash.hex()
            if not tx_hash_hex.startswith("0x"):
                tx_hash_hex = "0x" + tx_hash_hex
            logger.info("📤 Daily reward transfer sent: %s G$ to %s… | tx=%s",
                        _format_amount(amount_gd), to_wallet[:10], tx_hash_hex)
        except Exception as send_err:  # noqa: BLE001
            logger.error("❌ Daily reward: failed to send transfer tx: %s", send_err)
            error_type = "insufficient_gas" if _is_insufficient_gas_error(send_err) else "send_failed"
            return {"success": False, "error": f"Failed to send transaction: {send_err}", "error_type": error_type}

        receipt = _wait_for_receipt_patient(w3, tx_hash)
        if receipt is None:
            # Broadcast but unconfirmed — the tx may still land. The caller
            # keeps tx_hash on the row and checks on-chain before any re-send.
            logger.warning("⚠️ Daily reward: receipt timeout for tx %s — keeping tx_hash for verification", tx_hash_hex)
            return {
                "success": False,
                "error": "Transaction receipt timeout",
                "error_type": "submitted_unconfirmed",
                "tx_hash": tx_hash_hex,
            }

        if receipt.status == 1:
            logger.info("✅ Daily reward disbursed: %s G$ to %s… | tx=%s",
                        _format_amount(amount_gd), to_wallet[:10], tx_hash_hex)
            return {
                "success": True,
                "tx_hash": tx_hash_hex,
                "amount": amount_wei / 10 ** 18,
                "recipient": to_wallet,
                "explorer_url": f"https://celoscan.io/tx/{tx_hash_hex}",
            }

        logger.error("❌ Daily reward transfer reverted on-chain | tx=%s", tx_hash_hex)
        return {
            "success": False,
            "error": "Transfer reverted on-chain",
            "error_type": "reverted",
            "tx_hash": tx_hash_hex,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("❌ Daily reward disbursement error: %s", e)
        return {"success": False, "error": str(e), "error_type": "unexpected"}


# ── Durable log-table helpers ─────────────────────────────────────────────

def _fetch_eligible_sessions():
    """Return telegram_wallet_sessions rows with a wallet + chat id.

    De-duplicated by wallet (most recently seen session wins) so a wallet
    linked to two Telegram accounts is paid once, not twice.
    """
    supabase = _get_supabase()
    if not supabase:
        logger.warning("⚠️ Daily reward: database unavailable")
        return []
    try:
        result = (
            supabase.table("telegram_wallet_sessions")
            .select("telegram_chat_id, wallet_address")
            .not_.is_("telegram_chat_id", "null")
            .neq("telegram_chat_id", "")
            .not_.is_("wallet_address", "null")
            .neq("wallet_address", "")
            .order("last_seen_at", desc=True)
            .limit(5000)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Daily reward: could not fetch sessions: %s", exc)
        return []
    seen = set()
    rows = []
    for row in (result.data or []):
        wallet = (row.get("wallet_address") or "").strip().lower()
        chat_id = str(row.get("telegram_chat_id") or "")
        if not wallet or not chat_id or wallet in seen:
            continue
        seen.add(wallet)
        rows.append({"wallet_address": wallet, "telegram_chat_id": chat_id})
    return rows


def _seed_pending_rows(today: str) -> int:
    """Insert one 'pending' log row per eligible wallet for ``today``.

    Idempotent: ON CONFLICT (wallet_address, payout_date) DO NOTHING means a
    re-run (restart, second worker) only fills in wallets not yet logged.
    Returns the number of newly seeded rows.
    """
    global _schema_missing
    if _schema_missing:
        return 0
    sessions = _fetch_eligible_sessions()
    if not sessions:
        return 0
    supabase = _get_supabase()
    if not supabase:
        return 0
    payload = [
        {
            "wallet_address": s["wallet_address"],
            "payout_date": today,
            "telegram_chat_id": s["telegram_chat_id"],
            "amount_gd": _AMOUNT_GD,
            "status": "pending",
        }
        for s in sessions
    ]
    seeded = 0
    try:
        # Chunk the upsert so a huge user base doesn't hit payload limits.
        for i in range(0, len(payload), 500):
            chunk = payload[i:i + 500]
            result = (
                supabase.table("telegram_daily_reward_log")
                .upsert(chunk, on_conflict="wallet_address,payout_date", ignore_duplicates=True)
                .execute()
            )
            seeded += len(result.data or [])
    except Exception as exc:  # noqa: BLE001
        if "telegram_daily_reward_log" in str(exc) or "does not exist" in str(exc):
            _schema_missing = True
            logger.error(
                "❌ Daily reward: log table missing — run sql/telegram_daily_reward.sql "
                "in Supabase, then restart. Scheduler idle until then. (error: %s)", exc,
            )
        else:
            logger.exception("Daily reward: could not seed pending rows: %s", exc)
        return 0
    return seeded


def _reclaim_stale_sending() -> int:
    """Flip 'sending' rows idle for too long back to 'pending'.

    A worker killed mid-send (gunicorn recycle) would otherwise strand the row
    in 'sending' forever. Any tx_hash already on the row is PRESERVED — the
    next claim checks that tx on-chain before deciding whether to re-send.
    """
    supabase = _get_supabase()
    if not supabase:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=_STALE_CLAIM_SECONDS)).isoformat()
    try:
        result = (
            supabase.table("telegram_daily_reward_log")
            .update({"status": "pending", "updated_at": _now_iso()})
            .eq("status", "sending")
            .lt("updated_at", cutoff)
            .execute()
        )
        reclaimed = len(result.data or [])
        if reclaimed:
            logger.warning("⚠️ Daily reward: reclaimed %d stale 'sending' row(s)", reclaimed)
        return reclaimed
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Daily reward: could not reclaim stale rows: %s", exc)
        return 0


def _fetch_pending_rows(today: str, limit: int):
    supabase = _get_supabase()
    if not supabase:
        return []
    try:
        result = (
            supabase.table("telegram_daily_reward_log")
            .select("*")
            .eq("payout_date", today)
            .eq("status", "pending")
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception as exc:  # noqa: BLE001
        logger.exception("Daily reward: could not fetch pending rows: %s", exc)
        return []


def _has_pending_rows(today: str) -> bool:
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("telegram_daily_reward_log")
            .select("id")
            .eq("payout_date", today)
            .eq("status", "pending")
            .limit(1)
            .execute()
        )
        return bool(result.data)
    except Exception:  # noqa: BLE001
        return False


def _claim_row(row: dict) -> bool:
    """CAS-claim a pending row (pending -> sending). Only the winner proceeds."""
    supabase = _get_supabase()
    if not supabase:
        return False
    try:
        result = (
            supabase.table("telegram_daily_reward_log")
            .update({
                "status": "sending",
                "attempts": int(row.get("attempts") or 0) + 1,
                "updated_at": _now_iso(),
            })
            .eq("id", row["id"])
            .eq("status", "pending")
            .execute()
        )
        return bool(result.data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Daily reward: claim failed for row %s: %s", row.get("id"), exc)
        return False


def _update_row(row_id, fields: dict) -> None:
    supabase = _get_supabase()
    if not supabase:
        return
    fields["updated_at"] = _now_iso()
    try:
        supabase.table("telegram_daily_reward_log").update(fields).eq("id", row_id).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Daily reward: could not update row %s: %s", row_id, exc)


# ── Per-row processing ────────────────────────────────────────────────────

def _process_row(row: dict) -> str:
    """Process one log row end-to-end. Returns a status label for the summary."""
    row_id = row["id"]
    wallet = (row.get("wallet_address") or "").strip().lower()
    chat_id = str(row.get("telegram_chat_id") or "")
    amount = float(row.get("amount_gd") or _AMOUNT_GD)
    attempts = int(row.get("attempts") or 0)

    if not _claim_row(row):
        return "skipped"  # another worker won the CAS flip

    # If a tx was already broadcast for this row (receipt timeout / stale
    # reclaim), verify it on-chain BEFORE considering any re-send.
    prior_tx = row.get("tx_hash")
    if prior_tx:
        status = check_reward_tx_status(prior_tx)
        if status == "confirmed":
            _update_row(row_id, {"status": "sent", "sent_at": _now_iso(), "last_error": None})
            _notify_user(chat_id, amount, prior_tx)
            return "sent"
        if status == "pending":
            # Still unconfirmed — wait for the next pass; never re-send.
            _update_row(row_id, {"status": "pending", "last_error": "prior tx still unconfirmed"})
            return "retry"
        # Reverted on-chain: no funds moved, safe to try again with a fresh tx.
        _update_row(row_id, {"tx_hash": None, "last_error": f"prior tx reverted: {prior_tx}"})

    result = send_daily_reward_gd(wallet, amount)

    if result.get("success"):
        tx_hash = result.get("tx_hash")
        _update_row(row_id, {"status": "sent", "tx_hash": tx_hash, "sent_at": _now_iso(), "last_error": None})
        _notify_user(chat_id, amount, tx_hash)
        return "sent"

    error_type = result.get("error_type") or "error"
    error_msg = str(result.get("error") or "unknown error")[:500]

    if error_type in ("insufficient_gas", "insufficient_balance"):
        # Funding problem on the DAILYTASK_KEY wallet — stay pending and retry
        # automatically once the admin tops up (never escalate to 'failed').
        _update_row(row_id, {"status": "pending", "last_error": error_msg})
        return "retry"

    if error_type == "submitted_unconfirmed":
        # Tx broadcast but unconfirmed — keep the hash; the next pass verifies
        # it on-chain before doing anything else (double-pay protection).
        _update_row(row_id, {"status": "pending", "tx_hash": result.get("tx_hash"), "last_error": error_msg})
        return "retry"

    if attempts + 1 >= _MAX_RETRY_ATTEMPTS:
        _update_row(row_id, {"status": "failed", "last_error": error_msg})
        return "failed"

    _update_row(row_id, {"status": "pending", "last_error": error_msg})
    return "retry"


def _notify_user(chat_id: str, amount_gd: float, tx_hash: str) -> None:
    """Send the thank-you message. A Telegram failure never changes the payout
    outcome — the G$ already moved, so the row stays 'sent'."""
    if not chat_id:
        return
    try:
        sent = _send_telegram_message(chat_id, build_reward_message(amount_gd, tx_hash))
        if not sent:
            logger.warning("⚠️ Daily reward: Telegram message failed for chat %s (payout already sent)", chat_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Daily reward: Telegram message error for chat %s: %s", chat_id, exc)


def run_daily_reward_once() -> dict:
    """Run one payout pass immediately (seed + drain pending rows)."""
    global _last_run_date
    today = _today_utc()
    summary = {"date": today, "seeded": 0, "processed": 0, "sent": 0, "retry": 0, "failed": 0, "skipped": 0}
    logger.info("🎁 Daily reward pass started for %s", today)
    summary["seeded"] = _seed_pending_rows(today)
    _reclaim_stale_sending()

    processed = 0
    processed_ids = set()
    while processed < _MAX_USERS:
        batch = _fetch_pending_rows(today, limit=min(100, _MAX_USERS - processed))
        # 'retry' rows are released back to pending within this same pass, so
        # skip ids we've already handled — the next scheduler pass picks them
        # up. A batch with no fresh ids means only retries remain: stop.
        fresh = [r for r in batch if r["id"] not in processed_ids]
        if not fresh:
            break
        for row in fresh:
            processed_ids.add(row["id"])
            status = _process_row(row)
            summary["processed"] += 1
            summary[status] = summary.get(status, 0) + 1
            processed += 1
            if processed >= _MAX_USERS:
                break
            if _SEND_DELAY_SEC > 0:
                time.sleep(_SEND_DELAY_SEC)

    _last_run_date = today
    logger.info("🎁 Daily reward pass finished — %s", summary)
    return summary


# ── Scheduler ─────────────────────────────────────────────────────────────

def _scheduler_loop():
    """Wake periodically; fire the payout pass at/after the daily UTC slot.

    After the first pass of the day, later passes only run while 'pending'
    rows remain (e.g. gas-stalled payouts retrying after a top-up).
    """
    global _last_run_date
    while not _scheduler_stop.is_set():
        try:
            now = datetime.now(timezone.utc)
            today = _today_utc()
            target = now.replace(hour=_UTC_HOUR, minute=_UTC_MINUTE, second=0, microsecond=0)
            due = now >= target and (_last_run_date != today or _has_pending_rows(today))
            if due:
                run_daily_reward_once()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Daily reward scheduler crashed: %s", exc)
        _scheduler_stop.wait(_POLL_SECONDS)


def init_daily_reward_scheduler(app=None):
    """Start the background daily reward thread. Returns True if started."""
    global _scheduler_thread
    if not _ENABLED:
        logger.info("Daily reward scheduler disabled (TELEGRAM_DAILY_REWARD_ENABLED not set)")
        return False
    if not os.getenv("TELEGRAM_BOT_TOKEN"):
        logger.info("Daily reward scheduler disabled: TELEGRAM_BOT_TOKEN not set")
        return False
    if not os.getenv("DAILYTASK_KEY"):
        logger.error("❌ Daily reward scheduler disabled: DAILYTASK_KEY not set")
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            name="telegram-daily-reward-scheduler",
            daemon=True,
        )
        _scheduler_thread.start()
        logger.info(
            "🎁 Daily reward scheduler started — %s G$ daily at %02d:%02d UTC (10 AM PHT default)",
            _format_amount(_AMOUNT_GD), _UTC_HOUR, _UTC_MINUTE,
        )
        return True


def shutdown_daily_reward_scheduler():
    """Signal the scheduler thread to stop (best-effort, for tests)."""
    _scheduler_stop.set()
