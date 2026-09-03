"""Feature-gated service for Minigames player-paid/relayed vault claims."""
import os
import time
from eth_account import Account
from eth_account.messages import encode_typed_data
from web3 import Web3


VAULT_ABI = [
    {"type": "function", "name": "nonces", "stateMutability": "view",
     "inputs": [{"name": "", "type": "address"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "claimFor", "stateMutability": "nonpayable",
     "inputs": [{"name": "recipient", "type": "address"}, {"name": "amount", "type": "uint256"},
                {"name": "nonce", "type": "uint256"}, {"name": "deadline", "type": "uint256"},
                {"name": "authorization", "type": "bytes"}, {"name": "playerApproval", "type": "bytes"}],
     "outputs": []},
    {"type": "event", "name": "WithdrawalClaimed",
     "inputs": [{"name": "recipient", "type": "address", "indexed": True},
                {"name": "amount", "type": "uint256", "indexed": False},
                {"name": "nonce", "type": "uint256", "indexed": True},
                {"name": "submittedBy", "type": "address", "indexed": True},
                {"name": "relayed", "type": "bool", "indexed": False}]},
]


class UserPaidWithdrawalService:
    def __init__(self, blockchain_service):
        self.blockchain = blockchain_service
        self.address = os.getenv("MINIGAMES_USER_PAID_VAULT", "").strip()
        self.authorizer_key = os.getenv("MINIGAMES_WITHDRAW_AUTHORIZER_KEY", "").strip()
        # GAMES_KEY is deliberately the relayer priority; SERVER_PRIVATE_KEY is
        # retained only for backwards-compatible legacy payouts.
        self.relayer_key = os.getenv("GAMES_KEY", "").strip()

    @property
    def enabled(self):
        return bool(self.address and self.authorizer_key and self.relayer_key)

    def _contract(self):
        return self.blockchain.w3.eth.contract(address=Web3.to_checksum_address(self.address), abi=VAULT_ABI)

    def _domain(self):
        return {"name": "GoodMarket Minigames Withdrawal Vault", "version": "1",
                "chainId": self.blockchain.chain_id, "verifyingContract": Web3.to_checksum_address(self.address)}

    def _typed(self, primary_type, values):
        return {
            "types": {"EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
                primary_type: [{"name": "recipient", "type": "address"}, {"name": "amount", "type": "uint256"},
                               {"name": "nonce", "type": "uint256"}, {"name": "deadline", "type": "uint256"}]},
            "primaryType": primary_type, "domain": self._domain(), "message": values}

    def prepare(self, wallet, amount_g):
        if not self.enabled:
            return {"success": False, "error": "User-paid withdrawals are not configured yet."}
        recipient = Web3.to_checksum_address(wallet)
        amount = int(float(amount_g) * 10**18)
        nonce = int(self._contract().functions.nonces(recipient).call())
        deadline = int(time.time()) + 600
        values = {"recipient": recipient, "amount": amount, "nonce": nonce, "deadline": deadline}
        signature = Account.sign_message(
            encode_typed_data(full_message=self._typed("ClaimAuthorization", values)),
            private_key=self.authorizer_key
        ).signature.hex()
        return {"success": True, "vault": self.address, "amount": str(amount), "nonce": nonce,
                "deadline": deadline, "authorization": signature, "domain": self._domain(),
                "approval_types": self._typed("RelayedClaimApproval", values)["types"]["RelayedClaimApproval"]}

    def relay(self, prepared, player_approval):
        account = Account.from_key(self.relayer_key)
        contract = self._contract()
        recipient = Web3.to_checksum_address(prepared["recipient"])
        tx = contract.functions.claimFor(
            recipient, int(prepared["amount"]), int(prepared["nonce"]), int(prepared["deadline"]),
            prepared["authorization"], player_approval
        ).build_transaction({
            "from": account.address, "nonce": self.blockchain.w3.eth.get_transaction_count(account.address),
            "gasPrice": int(self.blockchain.w3.eth.gas_price * 1.2), "chainId": self.blockchain.chain_id,
        })
        tx["gas"] = int(self.blockchain.w3.eth.estimate_gas(tx) * 1.3)
        signed = self.blockchain.w3.eth.account.sign_transaction(tx, account.key)
        return self.blockchain.w3.eth.send_raw_transaction(signed.raw_transaction).hex()

    def verify_claim(self, tx_hash, prepared):
        receipt = self.blockchain.w3.eth.get_transaction_receipt(tx_hash)
        if not receipt or receipt.status != 1:
            return False
        for event in self._contract().events.WithdrawalClaimed().process_receipt(receipt):
            args = event["args"]
            if (args["recipient"].lower() == prepared["recipient"].lower()
                    and int(args["amount"]) == int(prepared["amount"])
                    and int(args["nonce"]) == int(prepared["nonce"])):
                return True
        return False
