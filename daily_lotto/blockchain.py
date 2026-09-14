"""Daily Lotto (6/100) — blockchain (Celo) interop.

The contract is a pull-vault: the server key (GOODMARKET_LOTTO_KEY) grants
winners after a draw and the winners claim their own prize (paying their own
CELO gas). Mirrors the nonce-safety + balance-safe patterns from
``referral_program/blockchain.py`` and ``minigames/blockchain.py``:
- preflight contract G$ balance before granting (fail WITHOUT a misleading tx)
- preflight signer CELO gas (fixed budget × gas_price)
- pending-nonce read + one retry on nonce collisions
- patient receipt polling so an unconfirmed grant is never double-sent
"""

from __future__ import annotations

import logging
import os
import threading
import time
from decimal import Decimal

logger = logging.getLogger(__name__)

# ── Config (lazy env reads so imports survive missing keys in tests) ─────────

GOODDOLLAR_CONTRACT = os.getenv("GOODDOLLAR_CONTRACT", "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A")
CELO_RPC_URL = os.getenv("CELO_RPC_URL", "https://forno.celo.org")
CHAIN_ID = int(os.getenv("CHAIN_ID", "42220"))
GD_DECIMALS = 18

# The deployed Lotto vault. Must be set after deployment
# (contracts/deploy_lotto_contract.py prints it).
LOTTO_CONTRACT = os.getenv("GOODMARKET_LOTTO_CONTRACT", "").strip()

# Gas budget for the server's grant tx — a batch of ~50 winners fits well under
# this; kept generous so grantWinners never runs out of gas mid-batch.
GRANT_GAS_LIMIT = 250_000

ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function",
    }
]

LOTTO_ABI = [
    {
        "inputs": [
            {"name": "roundId", "type": "uint256"},
            {"name": "numbers", "type": "uint256[6]"},
        ],
        "name": "finalizeRound",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "roundId", "type": "uint256"},
            {"name": "winners", "type": "address[]"},
            {"name": "amountsWei", "type": "uint256[]"},
        ],
        "name": "grantWinners",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"name": "roundId", "type": "uint256"}],
        "name": "claim",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "contractBalance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "owner",
        "outputs": [{"name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "roundId", "type": "uint256"},
            {"indexed": True, "name": "winner", "type": "address"},
            {"indexed": False, "name": "amount", "type": "uint256"},
        ],
        "name": "RewardWithdrawn",
        "type": "event",
    },
]

def _reward_withdrawn_topic() -> str:
    """keccak256("RewardWithdrawn(uint256,address,uint256)") — computed from
    web3 at runtime (web3 is lazy) so no hardcoded hash can rot."""
    from web3 import Web3
    return Web3.keccak(text="RewardWithdrawn(uint256,address,uint256)").hex()


def _w3():
    from web3 import Web3
    return Web3(Web3.HTTPProvider(CELO_RPC_URL))


def _get_key() -> str | None:
    key = os.getenv("GOODMARKET_LOTTO_KEY", "").strip() or os.getenv("SERVER_PRIVATE_KEY", "").strip()
    if not key:
        return None
    return key if key.startswith("0x") else "0x" + key


_grant_lock = threading.Lock()


def _is_nonce_error(low_text: str) -> bool:
    return any(token in low_text for token in (
        "nonce too low", "nonce too high",
        "replacement transaction underpriced", "already known",
    ))


class LottoBlockchainService:
    """Reads/writes the GoodMarketLotto vault on Celo."""

    def __init__(self, contract=LOTTO_CONTRACT):
        self.contract = contract.strip().lower()
        self._w3 = None  # lazy

    # ── lazy web3 ────────────────────────────────────────────────────────
    @property
    def w3(self):
        if self._w3 is None:
            self._w3 = _w3()
        return self._w3

    # ── addresses / helpers ──────────────────────────────────────────────
    @property
    def contract_address(self) -> str | None:
        return self.contract or None

    def _token_contract(self):
        from web3 import Web3
        return self.w3.eth.contract(
            address=Web3.to_checksum_address(GOODDOLLAR_CONTRACT),
            abi=ERC20_ABI,
        )

    def _lotto_contract(self):
        if not self.contract:
            raise ValueError("GOODMARKET_LOTTO_CONTRACT is not configured")
        from web3 import Web3
        return self.w3.eth.contract(
            address=Web3.to_checksum_address(self.contract),
            abi=LOTTO_ABI,
        )

    # ── read-only helpers (used by UI + admin) ───────────────────────────
    def get_contract_balance(self) -> Decimal | None:
        """G$ balance held by the vault; None when unreadable."""
        try:
            if not self.contract:
                return None
            wei = self._lotto_contract().functions.contractBalance().call()
            return Decimal(wei) / (Decimal(10) ** GD_DECIMALS)
        except Exception as exc:  # noqa: BLE001
            logger.warning("⚠️ Failed to read lotto contract balance: %s", exc)
            return None

    def get_owner(self) -> str | None:
        try:
            return self._lotto_contract().functions.owner().call()
        except Exception:  # noqa: BLE001
            return None

    def finalize_round(self, round_id: int, numbers: list) -> dict:
        """Record the winning numbers on-chain BEFORE granting (owner-only).

        ``GoodMarketLotto.grantWinners`` reverts with ``round_not_finalized``
        unless a round has been finalized first, so the draw scheduler (and the
        manual admin grant) MUST call this before ``grant_winners`` — otherwise
        no winner can ever claim and nothing is ever written to Celo (the
        "not saved to Celoscan" bug).

        Idempotent: the contract only ever moves ``latestRoundId`` forward, so
        re-finalizing an already-finalized round reverts with ``stale_round`` —
        treated as success here. Returns the same balance-safe shape as
        ``grant_winners``."""
        if not numbers or len(numbers) != 6:
            return {"success": False, "error": "Winning numbers must be exactly 6.", "error_type": "invalid_numbers"}
        key = _get_key()
        if not key:
            return {"success": False, "error": "GOODMARKET_LOTTO_KEY is not configured", "error_type": "no_key"}
        if not self.contract:
            return {"success": False, "error": "GOODMARKET_LOTTO_CONTRACT is not configured", "error_type": "no_contract"}

        with _grant_lock:
            try:
                from web3 import Web3
                from eth_account import Account

                w3 = self.w3
                if not w3.is_connected():
                    return {"success": False, "error": "Cannot connect to Celo network", "error_type": "rpc_unreachable"}

                account = Account.from_key(key)
                lotto = self._lotto_contract()

                # Already finalized (or a later round finalized) → nothing to do.
                try:
                    if lotto.functions.latestRoundId().call() >= round_id:
                        logger.info("🎰 Round #%s already finalized on-chain — skip finalizeRound", round_id)
                        return {"success": True, "already_finalized": True}
                except Exception as exc:  # noqa: BLE001
                    logger.warning("⚠️ Could not read latestRoundId for #%s: %s", round_id, exc)

                gas_price = int(w3.eth.gas_price * 1.2)
                gas_limit = 90_000
                if w3.eth.get_balance(account.address) < gas_limit * gas_price:
                    return {
                        "success": False,
                        "error": "Grant signer (GOODMARKET_LOTTO_KEY) needs a CELO gas refill.",
                        "error_type": "insufficient_gas",
                        "balance_safe": True,
                    }

                nonce = w3.eth.get_transaction_count(account.address, "pending")
                tx_hash = None
                for attempt in range(2):
                    try:
                        tx = lotto.functions.finalizeRound(round_id, [int(n) for n in numbers]) \
                            .build_transaction({
                                "chainId": CHAIN_ID,
                                "gas": gas_limit,
                                "gasPrice": gas_price,
                                "nonce": nonce,
                                "from": account.address,
                            })
                        signed = w3.eth.account.sign_transaction(tx, private_key=key)
                        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
                        if not tx_hash.startswith("0x"):
                            tx_hash = "0x" + tx_hash
                        break
                    except Exception as exc:  # noqa: BLE001
                        low = str(exc).lower()
                        if _is_nonce_error(low) and attempt == 0:
                            nonce = w3.eth.get_transaction_count(account.address, "pending")
                            continue
                        if _is_nonce_error(low):
                            return {
                                "success": False,
                                "pending": True,
                                "error": "nonce_collision",
                                "error_type": "nonce_collision",
                            }
                        if "stale_round" in low:
                            return {"success": True, "already_finalized": True}
                        raise

                receipt = _wait_for_receipt_patient(w3, tx_hash, timeout=90)
                if receipt is None:
                    return {
                        "success": False,
                        "pending": True,
                        "error": "Finalize broadcast but not yet confirmed.",
                        "error_type": "submitted_unconfirmed",
                        "tx_hash": tx_hash,
                    }
                if receipt.get("status") != 1:
                    return {
                        "success": False,
                        "pending": False,
                        "error": "Finalize transaction reverted on-chain.",
                        "error_type": "tx_reverted",
                        "tx_hash": tx_hash,
                    }
                return {"success": True, "tx_hash": tx_hash}
            except Exception as exc:  # noqa: BLE001
                err_text = str(exc) + " " + repr(exc)
                low = err_text.lower()
                logger.error("❌ lotto finalize_round error: %s", err_text)
                if "insufficient funds" in low or "gas required exceeds" in low:
                    return {"success": False, "error": "Grant signer needs CELO gas.", "error_type": "insufficient_gas", "balance_safe": True}
                if _is_nonce_error(low):
                    return {"success": False, "pending": True, "error": "nonce_collision", "error_type": "nonce_collision"}
                return {"success": False, "error": str(exc), "error_type": "finalize_exception", "balance_safe": True}

    def preflight_claim(self, round_id: int, wallet: str) -> dict:
        """Read-only eth_call of claim() for a winner. Distinguishes:
        - {"claimable": True}  — vault has G$; user can sign now
        - {"claimable": False, "reason": "empty_vault"|"no_reward"|...} — the
          call reverted; the revert reason string is decoded from the node or
          inferred from the contract's require strings.
        This lets the UI avoid asking a winner to sign/PAY GAS when the vault
        is known empty (or when the round wasn't granted yet)."""
        try:
            wallet = wallet.lower()
            lotto = self._lotto_contract()
            from web3 import Web3
            from web3.exceptions import ContractLogicError

            # The winner's own claim. eth_call with from=winner simulates exactly
            # what the signed tx would do.
            try:
                lotto.functions.claim(round_id).call({"from": Web3.to_checksum_address(wallet)})
                return {"claimable": True}
            except ContractLogicError as cle:
                reason = str(cle)
                low = reason.lower()
                if "no_reward" in low:
                    return {"claimable": False, "reason": "no_reward"}
                if "already_claimed" in low:
                    return {"claimable": False, "reason": "already_claimed"}
                if "gd_transfer_failed" in low or "empty_vault" in low or "insufficient" in low:
                    return {"claimable": False, "reason": "empty_vault"}
                # Generic revert (likely the G$ transfer reverted because the
                # vault has no tokens) → treat as empty vault.
                return {"claimable": False, "reason": "empty_vault"}
            except Exception as exc:  # noqa: BLE001
                # Nodes differ: some return "execution reverted" without a
                # reason string. Treat any claim() revert as empty-vault rather
                # than asking the user to spend gas into a dead end.
                logger.info("⚠️ preflight claim() reverted for %s round %s: %s", wallet[:8], round_id, exc)
                return {"claimable": False, "reason": "empty_vault"}
        except Exception as exc:  # noqa: BLE001
            logger.warning("⚠️ preflight_claim failed for %s: %s", wallet[:8], exc)
            return {"claimable": False, "reason": "unknown", "error": str(exc)}

    # ── server-side granting (draw scheduler + admin retry) ──────────────
    def grant_winners(self, round_id: int, winners: list, amounts_gd: list) -> dict:
        """Batch-grant a round's winners. ``winners`` = list of addresses,
        ``amounts_gd`` = list of Decimal/float G$ amounts.

        Never double-grants on retry: grantWinners overwrites claimable, so a
        re-send of the same batch is idempotent on-chain. Returns
        {"success": True, "tx_hash": ...} or a balance-safe error dict.
        """
        if not winners:
            return {"success": True, "tx_hash": None, "granted": 0}
        key = _get_key()
        if not key:
            return {"success": False, "error": "GOODMARKET_LOTTO_KEY is not configured", "error_type": "no_key"}
        if not self.contract:
            return {"success": False, "error": "GOODMARKET_LOTTO_CONTRACT is not configured", "error_type": "no_contract"}

        with _grant_lock:
            return self._grant_winners_locked(round_id, winners, amounts_gd, key)

    def _grant_winners_locked(self, round_id, winners, amounts_gd, key) -> dict:
        try:
            from web3 import Web3
            from eth_account import Account

            w3 = self.w3
            if not w3.is_connected():
                return {"success": False, "error": "Cannot connect to Celo network", "error_type": "rpc_unreachable"}

            account = Account.from_key(key)
            lotto = self._lotto_contract()
            token = self._token_contract()

            checksum_winners = [Web3.to_checksum_address(w) for w in winners]
            amounts_wei = [
                int((Decimal(str(a)) * (Decimal(10) ** GD_DECIMALS)).to_integral_value())
                for a in amounts_gd
            ]

            # Preflight the vault G$ balance: failing without a tx is cheaper
            # than a reverted batch (which the app would have to reconcile).
            try:
                vault_balance = lotto.functions.contractBalance().call()
            except Exception:
                vault_balance = token.functions.balanceOf(lotto.address).call()
            required = sum(amounts_wei)
            if vault_balance < required:
                shortfall = (required - vault_balance) / (10 ** GD_DECIMALS)
                return {
                    "success": False,
                    "error": "Vault has insufficient G$ to grant winners.",
                    "error_type": "insufficient_vault_balance",
                    "shortfall_gd": shortfall,
                    "balance_safe": True,
                }

            # Gas preflight: the batch must not run out of CELO.
            gas_price = int(w3.eth.gas_price * 1.2)
            required_gas_wei = GRANT_GAS_LIMIT * gas_price
            if w3.eth.get_balance(account.address) < required_gas_wei:
                return {
                    "success": False,
                    "error": "Grant signer (GOODMARKET_LOTTO_KEY) needs a CELO gas refill.",
                    "error_type": "insufficient_gas",
                    "balance_safe": True,
                }

            nonce = w3.eth.get_transaction_count(account.address, "pending")
            tx_hash = None
            # Another worker/scheduler may broadcast between our pending-nonce
            # read and broadcast → refresh the nonce once and retry (referral
            # "nonce too low" lesson). grantWinners overwrites claimable, so a
            # collision can never double-pay.
            for attempt in range(2):
                try:
                    tx = lotto.functions.grantWinners(round_id, checksum_winners, amounts_wei) \
                        .build_transaction({
                            "chainId": CHAIN_ID,
                            "gas": GRANT_GAS_LIMIT,
                            "gasPrice": gas_price,
                            "nonce": nonce,
                            "from": account.address,
                        })
                    signed = w3.eth.account.sign_transaction(tx, private_key=key)
                    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
                    if not tx_hash.startswith("0x"):
                        tx_hash = "0x" + tx_hash
                    break
                except Exception as exc:  # noqa: BLE001
                    low = str(exc).lower()
                    if _is_nonce_error(low) and attempt == 0:
                        nonce = w3.eth.get_transaction_count(account.address, "pending")
                        continue
                    if _is_nonce_error(low):
                        return {
                            "success": False,
                            "pending": True,
                            "error": "nonce_collision",
                            "error_type": "nonce_collision",
                        }
                    raise

            receipt = _wait_for_receipt_patient(w3, tx_hash, timeout=90)
            if receipt is None:
                return {
                    "success": False,
                    "pending": True,
                    "error": "Grant broadcast but not yet confirmed.",
                    "error_type": "submitted_unconfirmed",
                    "tx_hash": tx_hash,
                }
            if receipt.get("status") != 1:
                return {
                    "success": False,
                    "pending": False,
                    "error": "Grant transaction reverted on-chain.",
                    "error_type": "tx_reverted",
                    "tx_hash": tx_hash,
                }

            return {"success": True, "tx_hash": tx_hash, "granted": len(checksum_winners)}
        except Exception as exc:  # noqa: BLE001
            err_text = str(exc) + " " + repr(exc)
            low = err_text.lower()
            logger.error("❌ lotto grant_winner error: %s", err_text)
            if "insufficient funds" in low or "gas required exceeds" in low:
                return {"success": False, "error": "Grant signer needs CELO gas.", "error_type": "insufficient_gas", "balance_safe": True}
            if _is_nonce_error(low):
                return {"success": False, "pending": True, "error": "nonce_collision", "error_type": "nonce_collision"}
            return {"success": False, "error": str(exc), "error_type": "grant_exception", "balance_safe": True}

    # ── admin fund-vault quick action ────────────────────────────────────
    def transfer_to_vault(self, amount_gd, admin_wallet: str) -> dict:
        """Send G$ from the server funding wallet (LOTTO_FUNDING_KEY, falling
        back to GOODMARKET_LOTTO_KEY then SERVER_PRIVATE_KEY) to the Lotto
        vault. Pure ERC20 transfer to the contract address. Balance-safe:
        preflights the funding wallet's G$ balance + CELO gas before signing."""
        try:
            from web3 import Web3
            from eth_account import Account

            if not self.contract:
                return {"success": False, "error": "GOODMARKET_LOTTO_CONTRACT not configured", "error_type": "no_contract"}

            key_candidates = [
                os.getenv("LOTTO_FUNDING_KEY", "").strip(),
                os.getenv("GOODMARKET_LOTTO_KEY", "").strip(),
                os.getenv("SERVER_PRIVATE_KEY", "").strip(),
            ]
            key = next((k for k in key_candidates if k), None)
            if not key:
                return {"success": False, "error": "No funding wallet key configured (LOTTO_FUNDING_KEY)", "error_type": "no_key"}
            key = key if key.startswith("0x") else "0x" + key

            w3 = self.w3
            if not w3.is_connected():
                return {"success": False, "error": "Cannot connect to Celo network", "error_type": "rpc_unreachable"}

            account = Account.from_key(key)
            token = self._token_contract()
            destination = Web3.to_checksum_address(self.contract)
            amount_wei = int((Decimal(str(amount_gd)) * (Decimal(10) ** GD_DECIMALS)).to_integral_value())

            # Preflight funding-wallet G$ balance (the transfer would revert
            # on-chain with a shortfall — fail without a misleading tx).
            try:
                bal = token.functions.balanceOf(account.address).call()
                if bal < amount_wei:
                    shortfall = (amount_wei - bal) / (10 ** GD_DECIMALS)
                    return {
                        "success": False,
                        "error": f"Funding wallet has insufficient G$ (short by {shortfall:.2f} G$).",
                        "error_type": "insufficient_balance",
                    }
            except Exception as exc:  # noqa: BLE001
                logger.warning("⚠️ Could not preflight funding-wallet G$ balance: %s", exc)

            gas_price = int(w3.eth.gas_price * 1.2)
            gas_limit = 90_000  # plain ERC20 transfer budget
            if w3.eth.get_balance(account.address) < gas_limit * gas_price:
                return {"success": False, "error": "Funding wallet needs CELO gas.", "error_type": "insufficient_gas"}

            nonce = w3.eth.get_transaction_count(account.address, "pending")
            tx = token.functions.transfer(destination, amount_wei).build_transaction({
                "chainId": CHAIN_ID,
                "gas": gas_limit,
                "gasPrice": gas_price,
                "nonce": nonce,
                "from": account.address,
            })
            signed = w3.eth.account.sign_transaction(tx, private_key=key)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
            if not tx_hash.startswith("0x"):
                tx_hash = "0x" + tx_hash

            receipt = _wait_for_receipt_patient(w3, tx_hash, timeout=90)
            if receipt is None:
                return {
                    "success": False,
                    "pending": True,
                    "error": "Transfer broadcast but not yet confirmed.",
                    "error_type": "submitted_unconfirmed",
                    "tx_hash": tx_hash,
                }
            if receipt.get("status") != 1:
                return {"success": False, "error": "Transfer reverted on-chain.", "error_type": "tx_reverted", "tx_hash": tx_hash}

            return {"success": True, "tx_hash": tx_hash, "amount_gd": str(amount_gd)}
        except Exception as exc:  # noqa: BLE001
            logger.error("❌ lotto transfer_to_vault error: %s", exc)
            return {"success": False, "error": str(exc), "error_type": "fund_exception"}

    # ── claim verification (user pulls their prize) ──────────────────────
    def verify_claim_tx(self, tx_hash: str, wallet: str, round_id: int) -> dict:
        """Verify a winner's claim tx on-chain: decodes RewardWithdrawn by
        topic and checks (winner, roundId, amount>0). Manual topic decode —
        never depends on an event ABI being present (same pattern as
        gcash/service.py decode_gd_transfers)."""
        try:
            from web3 import Web3
            w3 = self.w3
            tx_hash = tx_hash.strip().lower()
            if not tx_hash.startswith("0x"):
                tx_hash = "0x" + tx_hash

            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt is None:
                return {"success": False, "error": "Transaction not found on-chain yet. Try again in a few seconds."}
            if receipt.get("status") != 1:
                return {"success": False, "error": "Claim transaction reverted on-chain."}

            wallet = wallet.lower()
            # Target topic: RewardWithdrawn(roundId indexed, winner indexed, amount).
            topics_filter = {
                "0x" + _reward_withdrawn_topic().replace("0x", ""),
            }
            winner_topic = "0x" + "0" * 24 + wallet.replace("0x", "").lower()
            for log in receipt.get("logs", []):
                topics = log.get("topics") or []
                if len(topics) != 3:
                    continue
                if topics[0].hex() not in topics_filter:
                    continue
                if topics[2].hex().lower() != winner_topic:
                    continue
                # Topic[1] is roundId (indexed uint256).
                event_round = int(topics[1].hex(), 16)
                if event_round != round_id:
                    continue
                amount_hex = log.get("data") or "0x0"
                # web3 returns data as a hex string; tolerate bytes just in case.
                if isinstance(amount_hex, bytes):
                    amount_hex = "0x" + amount_hex.hex()
                amount_wei = int(amount_hex, 16)
                if amount_wei <= 0:
                    continue
                amount_gd = Decimal(amount_wei) / (Decimal(10) ** GD_DECIMALS)
                return {
                    "success": True,
                    "round_id": event_round,
                    "amount_gd": amount_gd,
                    "tx_hash": tx_hash,
                }
            return {"success": False, "error": "No matching reward-withdraw event found for this wallet in the transaction."}
        except Exception as exc:  # noqa: BLE001
            logger.error("❌ lotto verify_claim_tx error: %s", exc)
            return {"success": False, "error": str(exc)}


def _wait_for_receipt_patient(w3, tx_hash, timeout=90, poll=3.0):
    """Poll for a tx receipt tolerating RPC hiccups; None on timeout (never
    raises) so an unconfirmed broadcast can be parked + re-checked later."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt is not None:
                return receipt
        except Exception:  # noqa: BLE001
            pass
        time.sleep(poll)
    return None


lotto_blockchain = LottoBlockchainService()
