# Referral rewards contract — Remix deployment

This contract replaces direct G$ transfers from `REFERRAL_KEY`. It holds the G$ balance and permits the backend's **operator** account to call `disburse`; the private key never holds the reward funds. It also records every `rewardId` on-chain so retries cannot pay the same referral leg twice.

## Deploy on Celo mainnet

Before switching an existing production program, run `sql/referral_rewards_log_referral_id.sql` in Supabase. Contract payouts deliberately require each reward log to be tied to one exact `referrals.id`; ambiguous legacy referrer rows remain queued rather than risking a wrong or duplicate payout.

1. Open [Remix](https://remix.ethereum.org), create `ReferralRewards.sol`, and paste `contracts/ReferralRewards.sol`.
2. Compile with Solidity **0.8.20** (or a later compatible 0.8.x compiler), with optimization enabled.
3. In **Deploy & Run**, connect the wallet that will own/administer the contract and select **Celo Mainnet** (chain ID `42220`).
4. Deploy with:
   - `token_`: the deployed G$ ERC-20 address (the current backend default is `GOODDOLLAR_TOKEN_CONTRACT`, normally `0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A`).
   - `initialOperator_`: the address derived from the private key that will be configured as `REFERRAL_CONTRACT_OPERATOR_KEY`.
5. Send enough G$ directly to the deployed contract address. The operator also needs a small CELO balance for transaction gas.
6. Set the environment variables below and restart the backend. Do **not** set or retain `REFERRAL_KEY` for referral payouts.

```env
REFERRAL_REWARDS_CONTRACT=0xYourDeployedContract
REFERRAL_CONTRACT_OPERATOR_KEY=0xYourBackendOperatorPrivateKey
# Optional explicit safety check; must match the key's address when set.
REFERRAL_CONTRACT_OPERATOR_ADDRESS=0xYourBackendOperatorAddress
GOODDOLLAR_TOKEN_CONTRACT=0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A
CELO_RPC_URL=https://forno.celo.org
CHAIN_ID=42220
```

## Operational safety

- Fund **the contract** with G$, not the operator wallet. Fund the operator with CELO only.
- Keep the owner wallet offline/multisig where possible. Only the owner can add/revoke operators or recover tokens.
- If an operator key is exposed, call `setOperator(compromisedOperator, false)` immediately, create a new operator key, then authorize it with `setOperator(newOperator, true)`.
- The backend uses a deterministic reward ID based on the referral row, reward type, recipient, and chain. Calling `disburse` again with the same ID reverts, which is the final on-chain duplicate-payment guard.
- Test deployment and one low-value payout on Celo Alfajores or a controlled wallet before funding production.
