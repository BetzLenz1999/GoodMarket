from env_utils import get_env_float, get_env_int
import os
import logging
from web3 import Web3
from eth_account import Account
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class MinigamesBlockchainService:
    """Minigames Blockchain Service for G$ Rewards via direct transfers from the GAMES wallet.

    Rewards are plain G$ ERC-20 transfers signed by GAMES_KEY — no GamesRewards
    contract. The G$ pool lives in the GAMES wallet itself.
    """

    # Fixed gas budget for a direct G$ transfer (G$ is ERC-777-like and needs
    # hook headroom) — same fixed-budget approach as the other disbursement
    # modules (estimate-based preflights broke refunds in production).
    GD_TRANSFER_GAS_LIMIT = 250_000

    def __init__(self):
        # Network configuration
        self.celo_rpc_url = os.getenv('CELO_RPC_URL', 'https://forno.celo.org')
        self.chain_id = get_env_int('CHAIN_ID', 42220)
        self.gooddollar_contract = os.getenv('GOODDOLLAR_CONTRACT', '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A')
        

        # MERCHANT_ADDRESS for deposits (users send G$ here)
        merchant_address = os.getenv('MERCHANT_ADDRESS')
        if merchant_address:
            try:
                self.merchant_address = Web3.to_checksum_address(merchant_address)
                logger.info(f"✅ MERCHANT_ADDRESS configured: {self.merchant_address}")
            except Exception as e:
                logger.error(f"❌ Error loading MERCHANT_ADDRESS: {e}")
                self.merchant_address = None
        else:
            self.merchant_address = None
            logger.warning("⚠️ MERCHANT_ADDRESS not configured")

        # Server wallet for signing transactions (authorized disburser)
        server_private_key = os.getenv('GAMES_KEY')
        if server_private_key:
            try:
                if not server_private_key.startswith('0x'):
                    server_private_key = '0x' + server_private_key
                self.server_account = Account.from_key(server_private_key)
                self.server_address = self.server_account.address
                logger.info(f"✅ GAMES wallet configured: {self.server_address}")
            except Exception as e:
                logger.error(f"❌ Error loading GAMES_KEY: {e}")
                self.server_account = None
                self.server_address = None
        else:
            self.server_account = None
            self.server_address = None
            logger.warning("⚠️ GAMES_KEY not configured")

        # Initialize Web3
        self.w3 = Web3(Web3.HTTPProvider(self.celo_rpc_url))

        if self.w3.is_connected():
            logger.info("✅ Connected to Celo network for Minigames")
        else:
            logger.error("❌ Failed to connect to Celo network")

        # GoodDollar token contract
        self.gooddollar_token = Web3.to_checksum_address(self.gooddollar_contract)
        
        # ERC20 ABI for transfers
        self.erc20_abi = [
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
        
        self.token_contract = self.w3.eth.contract(
            address=self.gooddollar_token,
            abi=self.erc20_abi
        )
        
        # Transfer event signature
        self.TRANSFER_EVENT_SIGNATURE = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

        logger.info(f"🎮 Minigames Blockchain Service initialized (Direct GAMES Wallet Transfer Mode)")
        logger.info(f"   MERCHANT address (deposits): {self.merchant_address}")
        logger.info(f"   GAMES wallet address (rewards sender): {self.server_address}")
        logger.info(f"   GoodDollar token: {self.gooddollar_token}")


    def mask_wallet_address(self, wallet_address: str) -> str:
        """Mask wallet address for logging"""
        if not wallet_address or len(wallet_address) < 10:
            return wallet_address
        return wallet_address[:6] + "..." + wallet_address[-4:]

    async def verify_deposit_to_merchant(self, wallet_address: str, amount: float, tx_hash: str) -> dict:
        """Verify that user deposited G$ to MERCHANT_ADDRESS"""
        try:
            logger.info(f"🔍 Verifying deposit: {amount} G$ from {self.mask_wallet_address(wallet_address)}")

            if not self.w3.is_connected():
                return {"success": False, "error": "Blockchain connection failed"}

            if not self.merchant_address:
                logger.error("❌ MERCHANT_ADDRESS not configured.")
                return {"success": False, "error": "MERCHANT_ADDRESS not configured"}

            # Get transaction receipt
            receipt = self.w3.eth.get_transaction_receipt(tx_hash)

            if not receipt or receipt.status != 1:
                return {"success": False, "error": "Transaction not found or failed"}

            # Check transfer logs for the specific token contract
            for log in receipt.logs:
                if log['address'].lower() == self.gooddollar_token.lower():
                    # Check if it's a Transfer event
                    if len(log['topics']) >= 3:
                        # Topics: [event_signature, from_address, to_address]
                        to_address = '0x' + log['topics'][2].hex()[-40:]

                        if to_address.lower() == self.merchant_address.lower():
                            # Verify amount
                            amount_wei = int(log['data'].hex(), 16)
                            amount_g = amount_wei / (10 ** 18)

                            if abs(amount_g - amount) < 0.01:  # Allow small variance
                                logger.info(f"✅ Deposit verified: {amount} G$ to MERCHANT_ADDRESS")
                                return {"success": True, "verified": True, "amount": amount_g, "tx_hash": tx_hash}

            return {"success": False, "error": "Transfer to MERCHANT_ADDRESS not found in transaction"}

        except Exception as e:
            logger.error(f"❌ Error verifying deposit: {e}")
            return {"success": False, "error": str(e)}

    async def check_pending_deposits(self, wallet_address: str, expected_amount: float = None) -> dict:
        """
        Automatically check for pending deposits to MERCHANT_ADDRESS from a wallet
        Similar to P2P trading's automatic deposit verification
        """
        try:
            logger.info(f"🔍 AUTO-VERIFY: Checking deposits from {self.mask_wallet_address(wallet_address)} to MERCHANT_ADDRESS")

            if not self.w3.is_connected():
                return {'success': False, 'error': 'Blockchain connection failed', 'deposits_found': []}

            if not self.merchant_address:
                logger.error("❌ MERCHANT_ADDRESS not configured.")
                return {'success': False, 'error': 'MERCHANT_ADDRESS not configured', 'deposits_found': []}

            # Calculate block range (last 24 hours)
            latest_block = self.w3.eth.block_number
            # Assuming Celo block time is around 5 seconds, 720 blocks per hour
            blocks_per_hour = 720
            # Look back for 24 hours
            hours_to_check = 24
            from_block = max(0, latest_block - (hours_to_check * blocks_per_hour))


            logger.info(f"📊 Scanning blocks {from_block} to {latest_block} (last {hours_to_check} hours)")

            # Convert addresses to topic format for logs
            # Topic[0] is the event signature
            # Topic[1] is the indexed parameter 'from' (sender)
            # Topic[2] is the indexed parameter 'to' (recipient)
            from_topic = '0x' + '0' * 24 + wallet_address.lower().replace('0x', '')
            to_topic = '0x' + '0' * 24 + self.merchant_address.lower().replace('0x', '')

            # Query Transfer events: FROM user TO MERCHANT_ADDRESS
            filter_params = {
                'fromBlock': hex(from_block),
                'toBlock': 'latest',
                'address': self.gooddollar_token,
                'topics': [
                    self.TRANSFER_EVENT_SIGNATURE,
                    from_topic,  # FROM: user wallet
                    to_topic     # TO: MERCHANT_ADDRESS
                ]
            }

            logs = self.w3.eth.get_logs(filter_params)
            logger.info(f"📋 Found {len(logs)} G$ transfers from {self.mask_wallet_address(wallet_address)} to MERCHANT_ADDRESS")

            deposits = []
            for log in logs:
                try:
                    # Parse amount from the event data
                    amount_wei = int(log['data'].hex(), 16)
                    amount_g = amount_wei / (10 ** 18)

                    # Get block timestamp for context
                    block = self.w3.eth.get_block(log['blockNumber'])
                    timestamp = datetime.fromtimestamp(block['timestamp'])

                    tx_hash = log['transactionHash'].hex()

                    deposit_info = {
                        'tx_hash': tx_hash,
                        'amount': amount_g,
                        'block_number': log['blockNumber'],
                        'timestamp': timestamp.isoformat(),
                        'from': wallet_address,
                        'to': self.merchant_address
                    }

                    # If an expected amount is specified, check if the deposit matches
                    if expected_amount is not None:
                        if abs(amount_g - expected_amount) < 0.01:  # Allow small rounding difference
                            deposits.append(deposit_info)
                            logger.info(f"✅ Matching deposit: {amount_g} G$ (TX: {tx_hash[:16]}...)")
                    else:
                        # If no specific amount is expected, add all found deposits
                        deposits.append(deposit_info)
                        logger.info(f"📦 Deposit found: {amount_g} G$ (TX: {tx_hash[:16]}...)")

                except Exception as parse_error:
                    logger.error(f"❌ Error parsing log entry: {parse_error}")
                    # Continue to the next log entry even if one fails
                    continue

            if len(deposits) > 0:
                logger.info(f"✅ Successfully found {len(deposits)} deposit(s) from {self.mask_wallet_address(wallet_address)}.")
                # Return the list of deposits, count, and the most recent one
                return {
                    'success': True,
                    'deposits_found': deposits,
                    'total_deposits': len(deposits),
                    'latest_deposit': deposits[0] if deposits else None
                }
            else:
                logger.info(f"⏳ No matching deposits found from {self.mask_wallet_address(wallet_address)} to MERCHANT_ADDRESS in the last {hours_to_check} hours.")
                return {
                    'success': True,
                    'deposits_found': [],
                    'total_deposits': 0,
                    'latest_deposit': None
                }

        except Exception as e:
            logger.error(f"❌ An unexpected error occurred while checking pending deposits: {e}")
            # Return error and an empty list of deposits
            return {'success': False, 'error': str(e), 'deposits_found': []}


    def _send_gd_transfer(self, wallet_address: str, amount: float) -> dict:
        """Direct G$ ERC-20 transfer from the GAMES wallet (GAMES_KEY) — no rewards contract.

        The G$ pool lives in the GAMES wallet itself. Returns a base result dict;
        callers add their own context fields.
        """
        recipient_checksum = Web3.to_checksum_address(wallet_address)
        amount_wei = int(amount * (10 ** 18))

        # G$ balance preflight on the GAMES wallet itself — a wallet with CELO
        # but no G$ would otherwise send a transfer that reverts on-chain.
        try:
            wallet_balance = self.token_contract.functions.balanceOf(self.server_address).call()
        except Exception as balance_error:
            logger.error(f"❌ Could not read GAMES wallet G$ balance: {balance_error}")
            return {
                "success": False,
                "error": "Could not verify the rewards wallet balance. Please try again later. Your balance is safe.",
                "error_type": "balance_check_failed",
                "balance_safe": True
            }

        if wallet_balance < amount_wei:
            available_g = wallet_balance / (10 ** 18)
            logger.error(
                f"❌ GAMES wallet has insufficient G$: needed={amount}, available={available_g}"
            )
            return {
                "success": False,
                "error": "The rewards wallet has insufficient G$ right now. Please try again later. Your balance is safe.",
                "error_type": "insufficient_balance",
                "balance_safe": True,
                "wallet_balance": available_g,
                "required_amount": amount
            }

        nonce = self.w3.eth.get_transaction_count(self.server_address)
        gas_price = int(self.w3.eth.gas_price * 1.2)  # Add 20% buffer

        # Fixed gas budget (GD_TRANSFER_GAS_LIMIT) — do NOT switch to
        # estimate-based preflights (they broke disbursements in production).
        required_gas_wei = self.GD_TRANSFER_GAS_LIMIT * gas_price
        server_gas_balance = self.w3.eth.get_balance(self.server_address)
        if server_gas_balance < required_gas_wei:
            logger.error(
                f"❌ GAMES wallet has insufficient CELO for gas: "
                f"needed={required_gas_wei}, available={server_gas_balance}"
            )
            return {
                "success": False,
                "error": "The rewards wallet needs a gas refill. Please try again later. Your balance is safe.",
                "error_type": "insufficient_gas",
                "balance_safe": True
            }

        transaction = self.token_contract.functions.transfer(
            recipient_checksum,
            amount_wei
        ).build_transaction({
            'from': self.server_address,
            'nonce': nonce,
            'gas': self.GD_TRANSFER_GAS_LIMIT,
            'gasPrice': gas_price,
            'chainId': self.chain_id
        })

        signed_txn = self.w3.eth.account.sign_transaction(
            transaction,
            private_key=self.server_account.key
        )

        logger.info("📡 Sending direct G$ transfer from GAMES wallet...")
        tx_hash = self.w3.eth.send_raw_transaction(signed_txn.raw_transaction)
        tx_hash_hex = tx_hash.hex()
        if not tx_hash_hex.startswith('0x'):
            tx_hash_hex = '0x' + tx_hash_hex
        logger.info(f"🔗 Transaction sent: {tx_hash_hex}")

        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

        if receipt.status == 1:
            logger.info(f"⛽ Gas used: {receipt.gasUsed} | 🧾 Block: {receipt.blockNumber}")
            return {
                "success": True,
                "tx_hash": tx_hash_hex,
                "explorer_url": f"https://explorer.celo.org/mainnet/tx/{tx_hash_hex}",
                "sender": self.server_address
            }

        logger.error(f"❌ G$ transfer reverted on-chain: {tx_hash_hex}")
        return {
            "success": False,
            "error": "Transaction failed on blockchain. Your balance is safe.",
            "error_type": "onchain_reverted",
            "balance_safe": True,
            "tx_hash": tx_hash_hex
        }

    async def disburse_from_games_key(self, wallet_address: str, amount: float, session_id: str) -> dict:
        """Disburse winnings via a direct G$ transfer from the GAMES wallet (GAMES_KEY)"""
        try:
            logger.info(f"💸 Disbursing winnings from GAMES wallet: {amount} G$ to {self.mask_wallet_address(wallet_address)}")

            if not self.server_account:
                logger.error("❌ GAMES_KEY not configured")
                return {"success": False, "error": "Server wallet not configured"}

            if not self.w3.is_connected():
                return {"success": False, "error": "Blockchain connection failed"}

            result = self._send_gd_transfer(wallet_address, amount)
            if not result["success"]:
                return result

            logger.info(f"✅ Withdrawal successful: {amount} G$ - TX: {result['tx_hash']}")
            result.update({
                "amount": amount,
                "recipient": wallet_address,
                "message": f"Successfully withdrew {amount} G$!"
            })
            return result

        except Exception as e:
            import traceback
            logger.error(f"❌ Withdrawal error: {e}")
            logger.error(f"🔍 Traceback: {traceback.format_exc()}")

            # Check for insufficient funds error
            error_msg = str(e).lower()
            if "insufficient funds" in error_msg:
                logger.error(f"❌ GAMES wallet needs CELO for gas fees!")
                return {
                    "success": False,
                    "error": "Withdrawal system temporarily unavailable. Please try again later or contact support.",
                    "error_type": "insufficient_gas",
                    "balance_safe": True
                }

            return {
                "success": False,
                "error": "Withdrawal failed. Please try again later. Your balance is safe.",
                "error_type": "withdrawal_exception",
                "balance_safe": True
            }

    async def disburse_game_reward(self, wallet_address: str, amount: float, game_type: str, session_id: str) -> dict:
        """
        Disburse game reward to player via a direct G$ transfer from the GAMES wallet (GAMES_KEY)

        Args:
            wallet_address: Recipient wallet address
            amount: Amount in G$ to disburse
            game_type: Type of game (for logging)
            session_id: Game session ID

        Returns:
            Dict with success status, transaction hash, and details
        """
        try:
            logger.info(f"🎮 Minigame reward disbursement from GAMES wallet: {amount} G$ to {self.mask_wallet_address(wallet_address)}")

            if not self.server_account:
                logger.error("❌ GAMES_KEY not configured for minigames rewards")
                return {"success": False, "error": "Server wallet not configured"}

            if not self.w3.is_connected():
                logger.error("❌ Not connected to Celo network")
                return {"success": False, "error": "Blockchain connection failed"}

            result = self._send_gd_transfer(wallet_address, amount)
            if not result["success"]:
                return result

            logger.info(f"✅ Minigame reward successfully disbursed: {amount} G$ - TX: {result['tx_hash']}")
            logger.info(f"🔗 Explorer: {result['explorer_url']}")

            result.update({
                "amount": amount,
                "game_type": game_type,
                "session_id": session_id,
                "recipient": wallet_address,
                "message": f"Successfully disbursed {amount} G$ minigame reward!",
                "timestamp": datetime.now().isoformat(),
                "blockchain_confirmed": True
            })
            return result

        except Exception as e:
            # Log any exceptions during the disbursement process
            import traceback
            logger.error(f"❌ Minigame reward disbursement error: {e}")
            logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            return {"success": False, "error": str(e)}

# Global instance for the service
minigames_blockchain = MinigamesBlockchainService()
