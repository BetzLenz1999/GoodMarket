# GoodMarket Minigames Withdrawals — Remix deployment

Deploy `GoodMarketMinigamesWithdrawals.sol` on **Celo Mainnet** in Remix. The
contract is self-contained, so no import remappings are required.

## Constructor values

1. `token`: the production G$ token address (`GOODDOLLAR_CONTRACT`).
2. `signer`: the public address derived from `SERVER_PRIVATE_KEY`.

After deployment, set `GAMES_REWARDS_CONTRACT` to the new contract address and
restart the application. The same `SERVER_PRIVATE_KEY` signs short-lived
withdrawal vouchers and is also the narrowly-scoped relay fallback.

Fund the deployed contract with G$ before enabling withdrawals. The contract
does **not** custody CELO; players normally pay CELO for their own `claim`
transaction. The server only needs CELO when it relays a claim for a player
whose wallet cannot cover gas.

## Required database migration

Run `sql/minigame_withdrawal_status.sql` in Supabase before release. It adds
the prepared-voucher metadata used to prevent duplicate payout authorizations.

## Operational checks

1. Confirm `authorizationSigner()` equals the server public address.
2. Transfer G$ into the contract and confirm `getContractBalance()`.
3. Leave `paused()` as `false`.
4. Use a funded player wallet: the browser wallet should show and sign the
   `claim` transaction, so the player pays CELO gas.
5. Use a player wallet with too little CELO: the UI invokes the server relay.
   If the relay wallet also lacks CELO, the user receives **“Please top up CELO
   to pay the transaction.”** and their Play & Earn balance remains unchanged.

The voucher binds the recipient, G$ amount, unique withdrawal ID, expiry,
chain ID, and contract address. It can be submitted by the player or relayed,
but can only be used once.
