from env_utils import get_env_float, get_env_int
import os
import logging
import threading
import time
from web3 import Web3
from eth_account import Account

logger = logging.getLogger(__name__)

# All disbursements share ONE REFERRAL_KEY signer, and the same wallet is also
# used by the event-based auto-trigger threads, the every-15-min reconciler, the
# admin retry endpoint and the process-pending endpoint. A nonce fetch + build +
# broadcast NOT serialized lets two threads read the same nonce 39 from the RPC
# and broadcast two txs with nonce 39 — one wins, the other gets "nonce too
# low". This lock serializes the fetch→sign→broadcast window per process so a
# second transaction always builds on the previous one's nonce. Cross-process
# (gunicorn workers) races are covered by the "pending"-tag nonce read plus the
# retry-once-on-nonce-collision logic below.
_disburse_lock = threading.Lock()

ERC20_ABI = [
    {
        "constant": False,
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"}
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function"
    }
]


class ReferralBlockchain:
    """Handles G$ disbursement for the referral program using REFERRAL_KEY."""

    def __init__(self):
        self.celo_rpc_url = os.getenv('CELO_RPC_URL', 'https://forno.celo.org')
        self.chain_id = get_env_int('CHAIN_ID', 42220)
        self.gooddollar_token = os.getenv(
            'GOODDOLLAR_TOKEN_CONTRACT',
            '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A'
        )
        self.referral_key = os.getenv('REFERRAL_KEY')
        self.w3 = Web3(Web3.HTTPProvider(self.celo_rpc_url))

        if self.w3.is_connected():
            logger.info("Referral blockchain service connected to Celo network")
        else:
            logger.error("Referral blockchain service failed to connect to Celo network")

        if not self.referral_key:
            logger.error("REFERRAL_KEY environment variable not set")

    def _mask(self, addr):
        if not addr or len(addr) < 10:
            return addr
        return addr[:6] + "..." + addr[-4:]

    def get_referral_wallet_balance(self):
        """Return the G$ balance of the REFERRAL_KEY wallet, plus its CELO gas
        balance so the admin dashboard can warn before a disbursement is
        attempted with no gas."""
        if not self.referral_key:
            return {"success": False, "error": "REFERRAL_KEY not configured", "balance": 0}
        try:
            key = self.referral_key if self.referral_key.startswith('0x') else '0x' + self.referral_key
            account = Account.from_key(key)
            contract = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.gooddollar_token),
                abi=ERC20_ABI
            )
            balance_wei = contract.functions.balanceOf(account.address).call()
            balance_g = balance_wei / (10 ** 18)
            result = {
                "success": True,
                "balance": balance_g,
                "balance_wei": balance_wei,
                "wallet": account.address
            }
            try:
                celo_wei = self.w3.eth.get_balance(account.address)
                result["celo_balance"] = celo_wei / (10 ** 18)
                result["celo_balance_wei"] = celo_wei
            except Exception as celo_err:
                logger.warning(f"Could not read REFERRAL_KEY CELO balance: {celo_err}")
                result["celo_balance"] = None
                result["celo_balance_wei"] = None
            return result
        except Exception as e:
            logger.error(f"Failed to get referral wallet balance: {e}")
            return {"success": False, "error": str(e), "balance": 0}

    def disburse_referral_reward(self, wallet_address: str, amount: float, reward_type: str) -> dict:
        """
        Transfer G$ from REFERRAL_KEY wallet to recipient.

        Returns {"success": True, "tx_hash": "..."} on success.
        Returns {"success": False, "pending": True, "error": "insufficient_balance" | "insufficient_gas"
                 | "submitted_unconfirmed" | "nonce_collision"} when the call should be queued and retried
                 automatically (never hard-failed).
        """
        # The whole nonce fetch → build → broadcast sequence runs under a
        # process-wide lock so two concurrent threads (auto-triggers, reconciler,
        # admin retry) can never build two txs with the same nonce.
        with _disburse_lock:
            return self._disburse_referral_reward_locked(wallet_address, amount, reward_type)

    def _refresh_nonce(self, address, oklabel=""):
        """Return the signer's next usable nonce, counting PENDING txs too so a
        just-broadcast (but not yet confirmed) transfer from another thread or
        gunicorn worker is not re-used."""
        return self.w3.eth.get_transaction_count(address, "pending")

    @staticmethod
    def _is_nonce_error(err_text):
        return (
            'nonce too low' in err_text
            or 'nonce too high' in err_text
            or 'replacement transaction underpriced' in err_text
            or 'already known' in err_text
            or 'transaction nonce is too low' in err_text
            or 'nonce' in err_text and ('too low' in err_text or 'too high' in err_text or 'low' in err_text)
        )

    def _broadcast_referral_tx(self, contract, referral_account, key, amount_wei,
                               wallet_address, gas_limit, gas_price, nonce):
        """Build + sign + broadcast one G$ transfer. Raises on failure."""
        txn = contract.functions.transfer(
            Web3.to_checksum_address(wallet_address),
            amount_wei
        ).build_transaction({
            'chainId': self.chain_id,
            'gas': gas_limit,
            'gasPrice': gas_price,
            'nonce': nonce,
            'from': referral_account.address
        })
        signed_txn = self.w3.eth.account.sign_transaction(txn, key)
        tx_hash = self.w3.eth.send_raw_transaction(signed_txn.raw_transaction)
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith('0x'):
            tx_hash_hex = '0x' + tx_hash_hex
        return tx_hash_hex

    def _wait_for_receipt_patient(self, tx_hash, timeout_sec=60, poll_sec=2.0):
        """Poll for a tx receipt without raising on timeout.

        Unlike ``w3.eth.wait_for_transaction_receipt`` this tolerates individual
        RPC hiccups and returns ``None`` instead of raising ``TimeExhausted``
        when the receipt is not found within ``timeout_sec``.
        """
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            try:
                receipt = self.w3.eth.get_transaction_receipt(tx_hash)
                if receipt is not None:
                    return receipt
            except Exception:
                # RPC hiccup or tx not yet visible — keep polling.
                pass
            time.sleep(poll_sec)
        return None

    def check_referral_tx_status(self, tx_hash: str) -> str:
        """On-chain status of a previously-broadcast referral tx:
        ``confirmed`` | ``reverted`` | ``pending`` (not found / RPC error)."""
        try:
            receipt = self.w3.eth.get_transaction_receipt(tx_hash)
        except Exception:
            return "pending"
        if receipt is None:
            return "pending"
        return "confirmed" if receipt.get("status") == 1 else "reverted"

    def _disburse_referral_reward_locked(self, wallet_address: str, amount: float, reward_type: str) -> dict:
        try:
            if not self.referral_key:
                logger.error("REFERRAL_KEY not configured")
                return {"success": False, "pending": True, "error": "REFERRAL_KEY not configured"}

            key = self.referral_key if self.referral_key.startswith('0x') else '0x' + self.referral_key
            try:
                referral_account = Account.from_key(key)
            except Exception as key_err:
                logger.error(f"Invalid REFERRAL_KEY: {key_err}")
                return {"success": False, "pending": False, "error": "Invalid REFERRAL_KEY"}

            contract = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.gooddollar_token),
                abi=ERC20_ABI
            )

            amount_wei = int(amount * (10 ** 18))

            balance_wei = contract.functions.balanceOf(referral_account.address).call()
            balance_g = balance_wei / (10 ** 18)
            logger.info(
                f"Referral wallet balance: {balance_g:.2f} G$ | "
                f"Required: {amount:.2f} G$ ({reward_type} for {self._mask(wallet_address)})"
            )

            if balance_wei < amount_wei:
                logger.warning(
                    f"Insufficient REFERRAL_KEY balance: {balance_g:.2f} G$ < {amount:.2f} G$. "
                    f"Marking as pending_disbursed."
                )
                return {
                    "success": False,
                    "pending": True,
                    "error": "insufficient_balance",
                    "balance_available": balance_g,
                    "balance_required": amount
                }

            logger.info(f"[BLOCKCHAIN] Balance OK: {balance_g:.2f} G$ available, need {amount:.2f} G$")

            gas_price = int(self.w3.eth.gas_price * 1.2)

            # Estimate gas dynamically instead of hardcoding a fixed limit.
            # G$ ERC-777 hooks add overhead vs plain ERC-20, so apply a 1.3x
            # safety buffer on top of the estimate, and fall back to a
            # conservative ceiling only if estimation fails.
            try:
                estimated_gas = contract.functions.transfer(
                    Web3.to_checksum_address(wallet_address),
                    amount_wei
                ).estimate_gas({'from': referral_account.address})
                gas_limit = int(estimated_gas * 1.3)
                logger.info(
                    f"Referral reward gas estimate: {estimated_gas} "
                    f"(using limit: {gas_limit})"
                )
            except Exception as estimate_error:
                logger.warning(
                    f"Gas estimation failed, falling back to 250000: {estimate_error}"
                )
                gas_limit = 250000

            # CELO gas preflight: without this, a REFERRAL_KEY wallet holding
            # G$ but no CELO fails on-chain with "insufficient funds for gas"
            # and the referral lands in 'failed'. Queue it as pending instead so
            # it pays out automatically once the wallet is refilled with gas.
            celo_wei = self.w3.eth.get_balance(referral_account.address)
            gas_cost_wei = gas_limit * gas_price
            if celo_wei < gas_cost_wei:
                logger.warning(
                    f"Insufficient CELO gas on referral wallet: "
                    f"{celo_wei / 1e18:.6f} CELO < {gas_cost_wei / 1e18:.6f} CELO needed. "
                    f"Marking as pending_disbursed."
                )
                return {
                    "success": False,
                    "pending": True,
                    "error": "insufficient_gas",
                    "celo_available": celo_wei / 1e18,
                    "celo_required": gas_cost_wei / 1e18,
                }

            # Read the signer's next nonce INCLUDING pending txs. forno is
            # load-balanced, so the plain "latest"-block variant of this call can
            # lag behind the node that already mined a concurrent transfer —
            # that stale read is exactly what produced "nonce too low: next nonce
            # 40, tx nonce 39". "pending" sees txs in the mempool too.
            nonce = self._refresh_nonce(referral_account.address)
            logger.info(f"[BLOCKCHAIN] nonce={nonce}")

            # If the signer has other unconfirmed txs with a LOWER nonce than
            # ours, forno refuses to accept ours ("nonce too low / not in order") —
            # wait briefly for the earlier tx to confirm rather than failing.
            for _ in range(4):
                try:
                    tx_hash_hex = self._broadcast_referral_tx(
                        contract, referral_account, key, amount_wei,
                        wallet_address, gas_limit, gas_price, nonce
                    )
                    break
                except Exception as e:
                    err_text = str(e).lower()
                    if self._is_nonce_error(err_text):
                        # A concurrent thread/worker may have just taken this
                        # nonce (or forno's confirmed nonce hasn't caught up).
                        # Refetch with the "pending" tag and retry once — this
                        # recovers the exact "next nonce 40, tx nonce 39" case.
                        logger.warning(
                            f"[BLOCKCHAIN] nonce collision on {reward_type}: {e}. "
                            f"Refreshing nonce and retrying once."
                        )
                        try:
                            new_nonce = self._refresh_nonce(referral_account.address)
                        except Exception:
                            new_nonce = None
                        if new_nonce is not None and new_nonce != nonce:
                            nonce = new_nonce
                            logger.warning(
                                f"[BLOCKCHAIN] re-poised at nonce={nonce} after collision"
                            )
                            time.sleep(1.5)  # let the winner's tx reach the mempool
                            continue
                        # Same nonce again means forno just hasn't caught up with
                        # a concurrently-broadcast tx yet — queue as pending and
                        # let the reconciler retry a bit later.
                        return {
                            "success": False,
                            "pending": True,
                            "error": "nonce_collision",
                            "detail": str(e),
                        }
                    raise
            else:
                return {
                    "success": False,
                    "pending": True,
                    "error": "nonce_collision",
                    "detail": "Could not find a usable nonce after 4 attempts",
                }

            logger.info(f"[BLOCKCHAIN] TX SENT: {tx_hash_hex}")
            logger.info(f"[BLOCKCHAIN] Waiting for receipt...")

            receipt = self._wait_for_receipt_patient(tx_hash_hex, timeout_sec=120, poll_sec=2.5)
            if receipt is None:
                # The tx was broadcast but has not confirmed yet (forno lag or a
                # busy mempool). Do NOT hard-fail — the caller can retry and this
                # hash will be re-checked on-chain before any re-broadcast, so a
                # retry can never double-pay.
                logger.warning(
                    f"[BLOCKCHAIN] {tx_hash_hex} broadcast but receipt not found in time "
                    f"for {reward_type} -> {self._mask(wallet_address)}. Reporting submitted_unconfirmed."
                )
                return {
                    "success": False,
                    "pending": True,
                    "error": "submitted_unconfirmed",
                    "tx_hash": tx_hash_hex,
                    "amount": amount,
                    "recipient": wallet_address,
                }
            logger.info(f"[BLOCKCHAIN] Receipt: status={receipt.status}")

            if receipt.status == 1:
                logger.info(
                    f"Referral {reward_type} reward of {amount} G$ sent to "
                    f"{self._mask(wallet_address)} | TX: {tx_hash_hex}"
                )
                return {
                    "success": True,
                    "pending": False,
                    "tx_hash": tx_hash_hex,
                    "amount": amount,
                    "recipient": wallet_address,
                    "reward_type": reward_type
                }
            else:
                logger.error(f"Referral reward TX failed on-chain: {tx_hash_hex}")
                return {"success": False, "pending": False, "error": "Transaction failed on-chain", "tx_hash": tx_hash_hex}

        except Exception as e:
            logger.error(f"Referral reward disbursement error for {reward_type}: {e}")
            import traceback
            logger.error(traceback.format_exc())
            # A gas failure should never strand the referral in 'failed' — it
            # resolves itself once the REFERRAL_KEY wallet is refilled with
            # CELO, so report it as pending and let the queue retry it.
            err_text = str(e).lower()
            if 'insufficient funds' in err_text or 'gas required exceeds' in err_text:
                return {"success": False, "pending": True, "error": "insufficient_gas"}
            if self._is_nonce_error(err_text):
                # e.g. a cross-process collision that slipped past the in-loop
                # retry — transient, auto-retry via the reconciler.
                return {"success": False, "pending": True, "error": "nonce_collision", "detail": str(e)}
            return {"success": False, "pending": False, "error": str(e)}

    def disburse_referral_reward_sync(self, wallet_address: str, amount: float, reward_type: str) -> dict:
        """Synchronous wrapper (runs in current thread)."""
        return self.disburse_referral_reward(wallet_address, amount, reward_type)


referral_blockchain_service = ReferralBlockchain()
