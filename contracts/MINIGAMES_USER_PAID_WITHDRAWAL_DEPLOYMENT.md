# Minigames user-paid withdrawals — Remix deployment and integration

## Why a new contract is required

Yes. The deployed `GamesRewards` contract is server-disbursement only: the
backend's `SERVER_PRIVATE_KEY` signs `disburseReward`, so that signer always
pays Celo gas. A contract cannot make a wallet pay gas for a transaction it did
not submit. To make the player the normal gas payer *and* retain a safe
gas-sponsored fallback, deploy `MinigamesUserPaidWithdrawalVault.sol`.

The new vault keeps the current product rule that the Minigames balance is
off-chain. The backend first authorizes the exact withdrawal amount. The player
then selects one of two paths:

1. **Default — player-paid:** the player sends `claim` from their wallet. Their
   wallet signs the transaction and pays its CELO gas.
2. **Fallback — GAMES_KEY-paid:** only after a low-gas preflight, the player
   signs an EIP-712 `RelayedClaimApproval` (a signature, not a transaction).
   The backend sends `claimFor` through the configured relayer wallet, which
   pays CELO gas. Both the backend authorization *and* the player's signature
   are mandatory.

## Deploy with Remix

1. Open Remix, create `MinigamesUserPaidWithdrawalVault.sol`, and paste the
   contract source from this repository.
2. Compile with Solidity **0.8.21** (or a compatible 0.8.x compiler).
3. In **Deploy & Run**, use the Celo network and the admin wallet that will own
   the vault. Verify that Remix is on chain ID **42220**.
4. Supply these constructor values:
   - `goodDollar_`: the Celo G$ ERC-20 token address.
   - `authorizer_`: a dedicated backend authorization wallet address. Do not
     use a browser wallet; its private key signs short-lived EIP-712 payout
     authorizations on the server.
   - `initialRelayer_`: the public address corresponding to `GAMES_KEY` (or a
     separate dedicated relayer key). This wallet needs CELO only for fallback
     payouts.
5. Send enough G$ to the **new vault address**. The legacy GamesRewards balance
   is not migrated automatically.
6. Record the vault address, transaction hash, authorizer address, and relayer
   address. Confirm `goodDollar()`, `authorizer()`, and
   `relayers(relayerAddress)` in Remix.

## Required backend/frontend rollout — do not flip traffic yet

Deployment alone does not change the live app. The existing endpoint continues
to use `GamesRewards.disburseReward`. Before enabling this new contract, add an
explicitly tested rollout that:

1. Atomically reserves the Supabase `available_balance` before issuing an
   authorization; do **not** issue two authorizations for the same balance.
2. Signs the following EIP-712 domain exactly:

   ```text
   name: "GoodMarket Minigames Withdrawal Vault"
   version: "1"
   chainId: 42220
   verifyingContract: <new vault address>
   ```

   The backend authorizer signs `ClaimAuthorization(address recipient,uint256
   amount,uint256 nonce,uint256 deadline)`. The UI reads `nonces(recipient)`
   from the vault and uses a short expiry (for example, 10 minutes).
3. First estimates `claim`. If the player's CELO balance covers the estimate,
   call `claim` through their **actual GoodMarket wallet provider**. Never
   silently use an injected extension for a local-wallet login.
4. If the CELO preflight is insufficient, obtain the player's EIP-712 signature
   for `RelayedClaimApproval` with the same values, then submit it and the
   backend authorization to a protected backend relay endpoint. The endpoint
   sends `claimFor` from `GAMES_KEY` and pays the fallback gas.
5. Mark the database withdrawal complete only after an on-chain receipt with a
   successful `WithdrawalClaimed` event matching the wallet, amount, nonce, and
   selected path. On timeout or failure, release the reservation safely rather
   than issuing another authorization blindly.

## Operational and security notes

- Keep the `authorizer_` key and `GAMES_KEY` separate. Compromise of one should
  not give an attacker both signing roles.
- The owner can remove a relayer with `setRelayer(relayer, false)` immediately.
- Authorizations are recipient-specific, amount-specific, expiry-bound, and
  nonce-protected. They cannot be replayed after a successful claim or reused
  on a different chain/vault.
- This contract is deliberately not upgradeable. Review/audit the source and
  test on Celo Alfajores or a local fork before funding it in production.
- Do not expose `authorizer_` or relayer private keys in Remix, browser JS,
  source control, or client-visible configuration.
