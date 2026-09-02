"""Celo on-chain referral reward disbursements via ReferralRewards contract.

The contract, rather than a hot wallet, owns G$.  The backend operator key has
CELO only and can call the contract's one-time ``disburse`` function.
"""
import hashlib
import logging
import os
import threading
import time

from env_utils import get_env_int
from eth_account import Account
from web3 import Web3

logger = logging.getLogger(__name__)
_disburse_lock = threading.Lock()

ERC20_ABI = [
    {"constant": True, "inputs": [{"name": "account", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}], "type": "function"},
]
REFERRAL_REWARDS_ABI = [
    {"inputs": [{"name": "rewardId", "type": "bytes32"}, {"name": "recipient", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "disburse", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "availableBalance", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "", "type": "address"}], "name": "operators", "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "", "type": "bytes32"}], "name": "rewardPaid", "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
]


class ReferralBlockchain:
    """Pays referral rewards from the configured ReferralRewards contract."""

    def __init__(self):
        self.celo_rpc_url = os.getenv("CELO_RPC_URL", "https://forno.celo.org")
        self.chain_id = get_env_int("CHAIN_ID", 42220)
        self.gooddollar_token = os.getenv("GOODDOLLAR_TOKEN_CONTRACT", "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A")
        self.referral_contract = os.getenv("REFERRAL_REWARDS_CONTRACT")
        self.operator_key = os.getenv("REFERRAL_CONTRACT_OPERATOR_KEY")
        self.operator_address = os.getenv("REFERRAL_CONTRACT_OPERATOR_ADDRESS")
        self.w3 = Web3(Web3.HTTPProvider(self.celo_rpc_url))
        if not self.referral_contract:
            logger.error("REFERRAL_REWARDS_CONTRACT environment variable not set")
        if not self.operator_key:
            logger.error("REFERRAL_CONTRACT_OPERATOR_KEY environment variable not set")

    @staticmethod
    def _key(value):
        return value if value and value.startswith("0x") else "0x" + (value or "")

    @staticmethod
    def _mask(address):
        return address[:6] + "..." + address[-4:] if address and len(address) >= 10 else address

    def _account(self):
        if not self.operator_key:
            raise ValueError("REFERRAL_CONTRACT_OPERATOR_KEY not configured")
        account = Account.from_key(self._key(self.operator_key))
        if self.operator_address and account.address.lower() != self.operator_address.lower():
            raise ValueError("REFERRAL_CONTRACT_OPERATOR_ADDRESS does not match REFERRAL_CONTRACT_OPERATOR_KEY")
        return account

    def _contract(self):
        if not self.referral_contract:
            raise ValueError("REFERRAL_REWARDS_CONTRACT not configured")
        return self.w3.eth.contract(address=Web3.to_checksum_address(self.referral_contract), abi=REFERRAL_REWARDS_ABI)

    def reward_id(self, referral_id, reward_type: str, wallet_address: str) -> bytes:
        """Stable, domain-separated id: one contract payout per referral leg."""
        if referral_id is None:
            raise ValueError("A referral_id is required for contract disbursement")
        payload = f"goodmarket-referral-v1:{self.chain_id}:{referral_id}:{reward_type}:{wallet_address.lower()}"
        return hashlib.sha3_256(payload.encode("utf-8")).digest()

    def get_referral_wallet_balance(self):
        """Return contract G$ balance and backend operator CELO gas balance."""
        try:
            contract = self._contract()
            account = self._account()
            balance_wei = contract.functions.availableBalance().call()
            result = {
                "success": True,
                "balance": balance_wei / 10**18,
                "balance_wei": balance_wei,
                "wallet": Web3.to_checksum_address(self.referral_contract),
                "operator": account.address,
            }
            celo_wei = self.w3.eth.get_balance(account.address)
            result.update(celo_balance=celo_wei / 10**18, celo_balance_wei=celo_wei)
            return result
        except Exception as exc:
            logger.error("Failed to get referral contract balance: %s", exc)
            return {"success": False, "error": str(exc), "balance": 0}

    @staticmethod
    def _is_nonce_error(err_text):
        return any(token in err_text for token in (
            "nonce too low", "nonce too high", "replacement transaction underpriced", "already known"
        ))

    def _refresh_nonce(self, address):
        return self.w3.eth.get_transaction_count(address, "pending")

    def check_referral_tx_status(self, tx_hash: str) -> str:
        try:
            receipt = self.w3.eth.get_transaction_receipt(tx_hash)
            if receipt is None:
                return "pending"
            return "confirmed" if receipt.get("status") == 1 else "reverted"
        except Exception:
            return "pending"

    def _wait_for_receipt_patient(self, tx_hash, timeout_sec=120, poll_sec=2.5):
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            try:
                receipt = self.w3.eth.get_transaction_receipt(tx_hash)
                if receipt is not None:
                    return receipt
            except Exception:
                pass
            time.sleep(poll_sec)
        return None

    def disburse_referral_reward(self, wallet_address: str, amount: float, reward_type: str, referral_id=None) -> dict:
        with _disburse_lock:
            return self._disburse_referral_reward_locked(wallet_address, amount, reward_type, referral_id)

    def _disburse_referral_reward_locked(self, wallet_address, amount, reward_type, referral_id):
        # Legacy reward rows must be backfilled with referral_id before being
        # paid by the contract. Guessing from a reused referral code could turn
        # a retry into a payment for the wrong invite.
        if referral_id is None:
            return {"success": False, "pending": True, "error": "missing_referral_id"}
        try:
            account = self._account()
            contract = self._contract()
            recipient = Web3.to_checksum_address(wallet_address)
            amount_wei = int(amount * 10**18)
            reward_id = self.reward_id(referral_id, reward_type, recipient)
            if contract.functions.rewardPaid(reward_id).call():
                logger.warning("Referral reward already paid on-chain: id=%s", reward_id.hex())
                return {"success": True, "already_disbursed": True, "amount": amount, "recipient": recipient, "reward_type": reward_type}
            if not contract.functions.operators(account.address).call():
                return {"success": False, "pending": False, "error": "operator_not_authorized"}
            balance_wei = contract.functions.availableBalance().call()
            if balance_wei < amount_wei:
                return {"success": False, "pending": True, "error": "insufficient_balance", "balance_available": balance_wei / 10**18, "balance_required": amount}

            gas_price = int(self.w3.eth.gas_price * 1.2)
            try:
                gas_limit = int(contract.functions.disburse(reward_id, recipient, amount_wei).estimate_gas({"from": account.address}) * 1.3)
            except Exception as exc:
                logger.warning("Referral contract gas estimate failed; using 250000: %s", exc)
                gas_limit = 250000
            if self.w3.eth.get_balance(account.address) < gas_limit * gas_price:
                return {"success": False, "pending": True, "error": "insufficient_gas"}

            nonce = self._refresh_nonce(account.address)
            # A separate gunicorn worker may send with this operator between our
            # pending-nonce read and broadcast. Refresh once instead of marking
            # the referral failed; the contract reward id still prevents a double pay.
            for attempt in range(2):
                try:
                    tx = contract.functions.disburse(reward_id, recipient, amount_wei).build_transaction({"chainId": self.chain_id, "from": account.address, "nonce": nonce, "gas": gas_limit, "gasPrice": gas_price})
                    signed = self.w3.eth.account.sign_transaction(tx, self._key(self.operator_key))
                    tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction).hex()
                    tx_hash = tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash
                    break
                except Exception as exc:
                    err_text = str(exc).lower()
                    if self._is_nonce_error(err_text) and attempt == 0:
                        logger.warning("Refreshing nonce and retrying once after nonce collision: %s", exc)
                        nonce = self._refresh_nonce(account.address)
                        continue
                    if self._is_nonce_error(err_text):
                        return {
                            "success": False,
                            "pending": True,
                            "error": "nonce_collision",
                        }
                    raise
            receipt = self._wait_for_receipt_patient(tx_hash)
            if receipt is None:
                return {"success": False, "pending": True, "error": "submitted_unconfirmed", "tx_hash": tx_hash, "amount": amount, "recipient": recipient}
            if receipt.status == 1:
                return {"success": True, "pending": False, "tx_hash": tx_hash, "amount": amount, "recipient": recipient, "reward_type": reward_type}
            return {"success": False, "pending": False, "error": "Transaction failed on-chain", "tx_hash": tx_hash}
        except Exception as exc:
            message = str(exc)
            err_text = message.lower()
            logger.error("Referral contract disbursement error for %s: %s", reward_type, message)
            if 'insufficient funds' in err_text or 'gas required exceeds' in err_text:
                return {
                    "success": False,
                    "pending": True,
                    "error": "insufficient_gas",
                }
            if self._is_nonce_error(err_text):
                return {"success": False, "pending": True, "error": "nonce_collision"}
            return {"success": False, "pending": False, "error": message}

    def disburse_referral_reward_sync(self, wallet_address, amount, reward_type, referral_id=None):
        return self.disburse_referral_reward(wallet_address, amount, reward_type, referral_id)


referral_blockchain_service = ReferralBlockchain()
