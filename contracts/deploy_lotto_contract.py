"""
GoodMarketLotto Contract Deployment Script for Celo Mainnet.

Deploys the daily 3-digit lottery prize vault. The deployer wallet (LOTTO_KEY)
becomes the contract owner — the SAME key the draw scheduler uses to grant
winners (recommended: reuse GOODMARKET_LOTTO_KEY). Winners pull their own
prizes via claim() and pay their own CELO gas.

NOTE: this is a NEW contract (3-digit game). Deploy it, then point
GOODMARKET_LOTTO_CONTRACT at the new address and fund the new vault with G$. The
old 6/100 vault cannot be reused — its finalizeRound() takes uint256[6] with a
1..100 range, so 3-digit draws (including leading zeros) cannot be recorded.

REQUIRED ENV VARS:
    GOODMARKET_LOTTO_KEY          — Deployer + owner + grant signer (pays gas)

OPTIONAL ENV VARS:
    GOODDOLLAR_CONTRACT_ADDRESS   — G$ token address (default Celo mainnet G$)
    CELO_RPC_URL                  — default https://forno.celo.org
    CHAIN_ID                      — default 42220

AFTER DEPLOYMENT:
    Set env vars:
        GOODMARKET_LOTTO_CONTRACT=<deployed_address>
        GOODMARKET_LOTTO_KEY=<the same key used above>
    then fund the contract address with G$ (the vault).

Usage:
    uv run python contracts/deploy_lotto_contract.py
"""

import os
import json
import logging
from web3 import Web3
from eth_account import Account
from solcx import compile_standard, install_solc

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

CELO_RPC_URL = os.getenv('CELO_RPC_URL', 'https://forno.celo.org')
CHAIN_ID = int(os.getenv('CHAIN_ID', 42220))
GOODDOLLAR_CONTRACT = os.getenv(
    'GOODDOLLAR_CONTRACT_ADDRESS',
    '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
)

SOURCE = open(os.path.join(os.path.dirname(__file__), 'GoodMarketLotto.sol')).read()


def compile_contract():
    logger.info("Installing Solidity compiler v0.8.21...")
    install_solc('0.8.21')
    logger.info("Compiling GoodMarketLotto contract...")

    compiled = compile_standard({
        "language": "Solidity",
        "sources": {
            "GoodMarketLotto.sol": {"content": SOURCE}
        },
        "settings": {
            "optimizer": {"enabled": True, "runs": 200},
            "outputSelection": {
                "*": {
                    "*": ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"]
                }
            }
        }
    }, solc_version='0.8.21')

    contract_data = compiled["contracts"]["GoodMarketLotto.sol"]["GoodMarketLotto"]
    return {
        "abi": contract_data["abi"],
        "bytecode": contract_data["evm"]["bytecode"]["object"]
    }


def deploy_contract():
    lotto_key = os.getenv('GOODMARKET_LOTTO_KEY')

    if not lotto_key:
        logger.error("GOODMARKET_LOTTO_KEY not set!")
        return None

    w3 = Web3(Web3.HTTPProvider(CELO_RPC_URL))
    if not w3.is_connected():
        logger.error("Failed to connect to Celo network")
        return None

    logger.info(f"Connected to Celo Mainnet (Chain ID: {CHAIN_ID})")

    key = lotto_key if lotto_key.startswith('0x') else '0x' + lotto_key
    account = Account.from_key(key)
    logger.info(f"Deploying from GOODMARKET_LOTTO_KEY address: {account.address}")
    logger.info(f"  G$ token: {GOODDOLLAR_CONTRACT}")

    celo_balance = w3.eth.get_balance(account.address)
    celo_human = w3.from_wei(celo_balance, 'ether')
    logger.info(f"CELO balance: {celo_human} CELO")

    if celo_balance < w3.to_wei(0.05, 'ether'):
        logger.error(f"Insufficient CELO for gas (need ~0.05, have {celo_human}). Top up the GOODMARKET_LOTTO_KEY address.")
        return None

    compiled = compile_contract()

    contract = w3.eth.contract(abi=compiled["abi"], bytecode=compiled["bytecode"])

    nonce = w3.eth.get_transaction_count(account.address)
    gas_price = int(w3.eth.gas_price * 1.2)

    ctor_call = contract.constructor(Web3.to_checksum_address(GOODDOLLAR_CONTRACT))
    try:
        gas_estimate = ctor_call.estimate_gas({'from': account.address})
    except Exception as e:
        logger.warning(f"estimate_gas failed ({e}); falling back to 2_500_000")
        gas_estimate = 2_500_000
    gas_limit = int(gas_estimate * 1.15)
    logger.info(f"Gas estimate: {gas_estimate} (using limit: {gas_limit})")
    logger.info(f"Gas price:    {gas_price} wei (~{gas_price / 1e9:.2f} gwei)")
    logger.info(f"Max tx cost:  {gas_limit * gas_price} wei (~{gas_limit * gas_price / 1e18:.4f} CELO)")

    constructor_txn = ctor_call.build_transaction({
        'chainId':  CHAIN_ID,
        'gas':      gas_limit,
        'gasPrice': gas_price,
        'nonce':    nonce,
    })

    signed_txn = w3.eth.account.sign_transaction(constructor_txn, key)
    tx_hash = w3.eth.send_raw_transaction(signed_txn.raw_transaction)
    tx_hash_hex = tx_hash.hex()
    if not tx_hash_hex.startswith('0x'):
        tx_hash_hex = '0x' + tx_hash_hex

    logger.info(f"Tx hash: {tx_hash_hex}")
    logger.info(f"Explorer: https://celoscan.io/tx/{tx_hash_hex}")
    logger.info("Waiting for confirmation...")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)

    if receipt.status == 1:
        contract_address = receipt.contractAddress
        logger.info(f"Contract deployed: {contract_address}")
        logger.info(f"   CeloScan: https://celoscan.io/address/{contract_address}")
        logger.info(f"   Gas used: {receipt.gasUsed}")

        deployment_info = {
            "contract_name": "GoodMarketLotto",
            "version": "1",
            "contract_address": contract_address,
            "tx_hash": tx_hash_hex,
            "deployer": account.address,
            "owner": account.address,
            "gooddollar_token": GOODDOLLAR_CONTRACT,
            "chain_id": CHAIN_ID,
            "network": "Celo Mainnet",
            "block_number": receipt.blockNumber,
            "gas_used": receipt.gasUsed,
            "compiler_version": "v0.8.21+commit.d9974bed",
            "optimization": True,
            "optimization_runs": 200,
            "notes": (
                "GoodMarket Daily Lotto 3-digit prize vault. Owner (GOODMARKET_LOTTO_KEY) "
                "finalizes rounds (three digits, 0-9 in order) and grants winners; winners "
                "pull prizes with claim() and pay their own CELO gas. Fund the contract "
                "with G$ (the vault). Straight (exact order) vs Rumble (any order) payouts "
                "are decided off-chain by the draw + prize tiers."
            ),
            "abi": compiled["abi"]
        }

        out = os.path.join(os.path.dirname(__file__), 'lotto_deployment_info.json')
        with open(out, 'w') as f:
            json.dump(deployment_info, f, indent=2)

        logger.info(f"Deployment info saved to: {out}")
        logger.info(f"✅ Next steps: set GOODMARKET_LOTTO_CONTRACT={contract_address} "
                    f"and fund the contract address with G$.")
    else:
        logger.error("❌ Deployment transaction failed on-chain.")

    return contract_address


if __name__ == "__main__":
    deploy_contract()
