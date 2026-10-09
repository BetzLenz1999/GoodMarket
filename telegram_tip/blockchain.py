"""On-chain disbursement for the Telegram bot ``/tip`` command.

A direct transfer signed by the dedicated ``TIP_KEY`` hot wallet — the same
proven pattern as ``telegram_task/blockchain.py`` (``DAILYTASK_KEY``), extended
to (a) arbitrary ERC-20 tokens with per-token decimals and (b) NATIVE token
transfers (CELO / XDC), where the amount is sent as the transaction ``value``.

Safety properties carried over from the rest of the repo:
- preflight BOTH the sender's native gas balance AND the token balance before
  building a tx, with explicit ``insufficient_gas`` / ``insufficient_balance``
  error types so ops know exactly which wallet to top up;
- read the nonce with the ``"pending"`` tag and retry on nonce/mempool collisions
  (never hard-fail — the referral/gcash lesson);
- tolerate a receipt timeout by returning the tx hash instead of raising, so a
  broadcast-but-unconfirmed tip is never resent (double-pay hazard).
"""

from __future__ import annotations

import logging
import os
import time

from eth_account import Account
from web3 import Web3

from .tokens import TOKENS, to_wei

logger = logging.getLogger(__name__)

# Fallback RPCs used ONLY for receipt confirmation. A broadcast tx is a fact;
# the only thing that can fail afterwards is the RPC we happen to be reading
# from (forno in particular returns transient "no backend healthy" and can lag
# on receipts). Polling several nodes for the receipt prevents a confirmed tip
# from being reported as "not yet confirmed" just because one node is slow.
_DEFAULT_CELO_FALLBACKS = "https://forno.celo.org,https://rpc.ankr.com/celo,https://celo.drpc.org"
_DEFAULT_XDC_FALLBACKS = "https://earpc.xinfin.network,https://rpc.xinfin.network"
# How long to keep polling for a receipt before reporting submitted_unconfirmed.
_RECEIPT_TIMEOUT_SEC = float(os.getenv("TIP_RECEIPT_TIMEOUT_SEC", "120") or "120")
_RECEIPT_POLL_SEC = float(os.getenv("TIP_RECEIPT_POLL_SEC", "2.5") or "2.5")

# Minimal ERC-20 surface — enough for balanceOf + transfer (G$ is ERC-777 on
# Celo but exposes the ERC-20 surface, which is all a direct payout needs).
_ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function",
    },
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
]

# Minimum native balance kept for gas on the sender wallet (per chain).
_MIN_GAS_WEI = int(0.005 * (10 ** 18))
_DEFAULT_GAS_LIMIT = 250_000


def _is_nonce_error(message: str) -> bool:
    text = (message or "").lower()
    return any(
        marker in text
        for marker in (
            "nonce too low",
            "nonce too high",
            "replacement transaction underpriced",
            "already known",
            "transaction already imported",
        )
    )


class TipBlockchainService:
    """Send a single token from ``TIP_KEY`` to a recipient wallet."""

    def __init__(self, key_env: str = "TIP_KEY"):
        self.key_env = key_env

    # ── helpers ──────────────────────────────────────────────────────────────
    def _get_key(self) -> str:
        key = (os.getenv(self.key_env) or "").strip()
        if key and not key.startswith("0x"):
            key = "0x" + key
        return key

    def _rpc_for(self, meta: dict) -> str:
        # Per-chain RPC, env-overridable via CELO_RPC_URL / XDC_RPC_URL.
        if meta["network"] == "xdc":
            return os.getenv("XDC_RPC_URL", meta["rpc"])
        return os.getenv("CELO_RPC_URL", meta["rpc"])

    def _rpc_urls_for(self, meta: dict) -> list:
        """Primary RPC first, then the per-chain fallbacks (deduped)."""
        if meta["network"] == "xdc":
            primary = os.getenv("XDC_RPC_URL", meta["rpc"])
            fallbacks = os.getenv("XDC_RPC_FALLBACKS", _DEFAULT_XDC_FALLBACKS)
        else:
            primary = os.getenv("CELO_RPC_URL", meta["rpc"])
            fallbacks = os.getenv("CELO_RPC_FALLBACKS", _DEFAULT_CELO_FALLBACKS)
        urls = [primary]
        for u in (fallbacks or "").split(","):
            u = u.strip()
            if u and u not in urls:
                urls.append(u)
        return urls

    def _wait_for_receipt_patient(self, meta: dict, tx_hash) -> object | None:
        """Poll for a receipt across the primary RPC then the fallbacks.

        A broadcast tx must never be reported as unconfirmed just because the
        single node we read from is flaky — forno both rate-limits and lags.
        Returns the receipt, or None if not seen within ``_RECEIPT_TIMEOUT_SEC``.
        """
        deadline = time.time() + _RECEIPT_TIMEOUT_SEC
        urls = self._rpc_urls_for(meta)
        while time.time() < deadline:
            for url in urls:
                try:
                    w3 = Web3(Web3.HTTPProvider(url))
                    receipt = w3.eth.get_transaction_receipt(tx_hash)
                    if receipt is not None:
                        return receipt
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(_RECEIPT_POLL_SEC)
        return None

    def mask_wallet(self, wallet: str | None) -> str:
        if not wallet or len(wallet) < 10:
            return wallet or ""
        return wallet[:6] + "..." + wallet[-4:]

    def _native_balance(self, w3: Web3, address: str) -> int:
        return int(w3.eth.get_balance(address))

    # ── preflight ────────────────────────────────────────────────────────────
    def preflight(self, token_key: str, amount_wei: int) -> dict:
        """Check sender gas + token balance. Returns a status dict, never raises."""
        meta = TOKENS.get(token_key)
        if not meta:
            return {"ok": False, "error": "Unsupported token", "error_type": "unsupported_token"}

        key = self._get_key()
        if not key:
            return {"ok": False, "error": f"{self.key_env} not configured", "error_type": "no_key"}

        try:
            account = Account.from_key(key)
        except Exception as exc:  # noqa: BLE001
            logger.error("❌ %s is invalid: %s", self.key_env, exc)
            return {"ok": False, "error": f"{self.key_env} invalid", "error_type": "invalid_key"}

        w3 = Web3(Web3.HTTPProvider(self._rpc_for(meta)))
        if not w3.is_connected():
            return {"ok": False, "error": "Blockchain connection failed", "error_type": "rpc_down"}

        # Gas check (native) — applies to every tip on this chain.
        try:
            celo_balance = self._native_balance(w3, account.address)
            if celo_balance < _MIN_GAS_WEI:
                native_label = "XDC" if meta["network"] == "xdc" else "CELO"
                logger.error(
                    "❌ %s wallet has insufficient %s for gas: %s. Top up %s.",
                    self.key_env, native_label, celo_balance / 10**18, account.address,
                )
                return {
                    "ok": False,
                    "error": f"{self.key_env} wallet needs {native_label} for gas",
                    "error_type": "insufficient_gas",
                    "address": account.address,
                }
        except Exception as exc:  # noqa: BLE001
            logger.error("❌ Failed to check %s gas balance: %s", self.key_env, exc)
            return {"ok": False, "error": "Failed to check gas balance", "error_type": "gas_check_failed"}

        # Token balance check (skip for native — gas check already covers it).
        if not meta["native"]:
            try:
                contract = w3.eth.contract(
                    address=Web3.to_checksum_address(meta["address"]), abi=_ERC20_ABI
                )
                balance = contract.functions.balanceOf(account.address).call()
                if balance < amount_wei:
                    logger.error(
                        "❌ %s wallet has insufficient %s: %s < %s. Top up %s.",
                        self.key_env, meta["label"],
                        balance / (10 ** meta["decimals"]),
                        amount_wei / (10 ** meta["decimals"]),
                        account.address,
                    )
                    return {
                        "ok": False,
                        "error": f"{self.key_env} wallet has insufficient {meta['label']}",
                        "error_type": "insufficient_balance",
                        "address": account.address,
                    }
            except Exception as exc:  # noqa: BLE001
                logger.error("❌ Failed to read %s token balance: %s", self.key_env, exc)
                return {"ok": False, "error": "Failed to read token balance", "error_type": "balance_check_failed"}

        return {"ok": True, "address": account.address, "network": meta["network"], "chain_id": meta["chain_id"]}

    # ── send ─────────────────────────────────────────────────────────────────
    def send(self, token_key: str, to_wallet: str, amount) -> dict:
        """Send ``amount`` of ``token_key`` from ``TIP_KEY`` to ``to_wallet``.

        Returns ``{success, tx_hash, amount, recipient, explorer_url}`` on
        success, or ``{success: False, error, error_type}`` on failure. A
        broadcast-but-unconfirmed transfer returns ``success: False`` with a
        ``tx_hash`` and ``error_type: "submitted_unconfirmed"``.
        """
        meta = TOKENS.get(token_key)
        if not meta:
            return {"success": False, "error": "Unsupported token", "error_type": "unsupported_token"}

        try:
            recipient = Web3.to_checksum_address(to_wallet)
        except Exception:
            return {"success": False, "error": "Invalid recipient address", "error_type": "bad_recipient"}

        amount_wei = to_wei(amount, meta["decimals"])

        pre = self.preflight(token_key, amount_wei)
        if not pre.get("ok"):
            return {"success": False, **{k: pre[k] for k in ("error", "error_type") if k in pre}}

        key = self._get_key()
        account = Account.from_key(key)
        w3 = Web3(Web3.HTTPProvider(self._rpc_for(meta)))
        chain_id = meta["chain_id"]

        last_error = ""
        for attempt in range(4):
            try:
                nonce = w3.eth.get_transaction_count(account.address, "pending")
                gas_price = int(w3.eth.gas_price * 1.2)

                if meta["native"]:
                    tx = {
                        "chainId": chain_id,
                        "to": recipient,
                        "value": amount_wei,
                        "gas": 21_000,
                        "gasPrice": gas_price,
                        "nonce": nonce,
                        "from": account.address,
                    }
                else:
                    contract = w3.eth.contract(
                        address=Web3.to_checksum_address(meta["address"]), abi=_ERC20_ABI
                    )
                    try:
                        estimated = contract.functions.transfer(
                            recipient, amount_wei
                        ).estimate_gas({"from": account.address})
                        gas_limit = int(estimated * 1.3)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("⚠️ Gas estimation failed, using %s: %s", _DEFAULT_GAS_LIMIT, exc)
                        gas_limit = _DEFAULT_GAS_LIMIT
                    tx = contract.functions.transfer(recipient, amount_wei).build_transaction({
                        "chainId": chain_id,
                        "gas": gas_limit,
                        "gasPrice": gas_price,
                        "nonce": nonce,
                        "from": account.address,
                    })

                signed = w3.eth.account.sign_transaction(tx, key)
                tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
                tx_hash_hex = tx_hash.hex()
                if not tx_hash_hex.startswith("0x"):
                    tx_hash_hex = "0x" + tx_hash_hex
            except Exception as send_error:  # noqa: BLE001
                last_error = str(send_error)
                if _is_nonce_error(last_error) and attempt < 3:
                    logger.warning("⚠️ Nonce collision, retrying (%s): %s", attempt + 1, last_error)
                    continue
                logger.error("❌ Tip transfer failed: %s", send_error)
                return {"success": False, "error": f"Failed to send transaction: {send_error}", "error_type": "send_failed"}
            break
        else:
            # All attempts hit nonce collisions — retryable, NOT hard failure.
            return {"success": False, "error": "nonce_collision", "error_type": "nonce_collision"}

        # Patient receipt wait — never raise on timeout (a broadcast tx may still
        # confirm; resending would double-pay). Polls across RPC fallbacks so a
        # slow/rate-limited primary node cannot report a confirmed tip as pending.
        receipt = self._wait_for_receipt_patient(meta, tx_hash)
        if receipt is None:
            logger.warning("⏳ Tip receipt not confirmed within timeout: %s", tx_hash_hex)
            return {
                "success": False,
                "error": "submitted_unconfirmed",
                "error_type": "submitted_unconfirmed",
                "tx_hash": tx_hash_hex,
                "error_message": "broadcast but not confirmed",
            }

        if getattr(receipt, "status", 0) == 1:
            logger.info(
                "✅ Tip sent: %s %s to %s | tx=%s",
                amount, meta["label"], self.mask_wallet(recipient), tx_hash_hex,
            )
            return {
                "success": True,
                "tx_hash": tx_hash_hex,
                "amount": str(amount),
                "recipient": recipient,
                "token": meta["key"],
                "label": meta["label"],
                "explorer_url": f"{meta['explorer']}{tx_hash_hex}",
            }

        return {"success": False, "error": "Transaction reverted on-chain", "error_type": "reverted", "tx_hash": tx_hash_hex}


def tip_key_address(key_env: str = "TIP_KEY") -> str | None:
    """Public address of the TIP_KEY wallet (never the key). None if unset/invalid."""
    key = (os.getenv(key_env) or "").strip()
    if not key:
        return None
    if not key.startswith("0x"):
        key = "0x" + key
    try:
        return Account.from_key(key).address
    except Exception:  # noqa: BLE001
        return None
