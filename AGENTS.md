# GoodMarket / GoodDollar — Development Progress

Repository-specific notes for OpenHands agents.

## Stack
- Flask backend (Python): `routes.py`, `main.py`, `blockchain.py`, `supabase_client.py`.
- Frontend: Jinja templates in `templates/`, vanilla JS in `static/js/`.
- ethers.js **v6.13.4** loaded from cdnjs (swap.html, claim.html, send-link.html). p2p.html/savings.html use 6.7.0. xdc_wallet.html uses 6.13.2.
- Celo mainnet (chainId 42220 / 0xa4ec). Public RPC: `https://forno.celo.org`.

## Wallet provider model
- `static/js/wc-bridge.js`: WalletConnect EIP-1193 bridge. Routes **wallet-scoped** methods (eth_sendTransaction, personal_sign, signTypedData*) to the WC session; routes **read-only** calls (eth_call, eth_estimateGas, eth_getBalance) directly to Celo RPC via `_celoJsonRpc` / `_celoJsonRpcWithFallback`.
- `templates/swap.html` has its OWN inline `_celoJsonRpc` + `_wcBridgeRequest` (a second copy of the bridge logic for the swap page). **Changes to RPC error handling must be mirrored in both wc-bridge.js and swap.html.**
- Signer resolution: `getConnectedSwapSigner()` in swap.html picks Privy / WalletConnect / injected (Trust/MetaMask) in that order based on `IS_PRIVY_LOGIN` / `PREFER_WC_SIGNING`.

## "missing revert data" — root cause & fix (2026-08)
ethers.js v6 throws `"missing revert data in call exception"` whenever an `eth_call` / `eth_estimateGas` reverts and the returned JSON-RPC error object has **no `data` field** (the revert bytes). Public Celo RPC nodes and mobile wallet providers (Trust, MiniPay) are inconsistent — some return `error.data`, some don't. The bridge used to forward reverts as `new Error(data.error.message)`, **dropping `error.data` and `error.code`**, which forced ethers into the opaque "missing revert data" path.

Fix layers (all in this repo):
1. `static/js/tx-error.js` — `_decodeRevertData()` decodes `Error(string)` (0x08c379a0), `Panic(uint256)` (0x4e487b71), custom selectors. Exposes `GMTxError.{decodeRevertData, revertReasonFromError, simulateCallCelo}`. `_isReverted()` now matches `missing revert data`. **ABI offset gotcha**: string length word is at hex offset 72 (after selector[8] + offset word[64]), string bytes start at 136 — NOT 136/200.
2. `static/js/wc-bridge.js` — `_rpcErrorFromJsonRpcError` preserves `error.code` + `error.data`; `_celoJsonRpcWithFallback` retries the next RPC URL only when `data` is absent (a revert-with-data is deterministic, no point retrying).
3. `templates/swap.html` — inline `_celoJsonRpc` mirrors the above; `_enrichSwapError(err, simParams, ctx)` re-runs the exact failing calldata as a read-only `eth_call` against several Celo RPCs to recover the revert reason, plus an ERC-20 allowance/balance diagnostic. Wired into `startReserveSwap` (GoodReserve sell/buy) and `startSwap` (Uniswap wallet-signer path).
4. `static/js/minipay-gas-topup.js` — balance reads (`_ethCall`, `_getCeloBalance`) now fall back to public Celo RPCs when the wallet provider fails (fixes "gas request not working when low balance"); CELO→cUSD swap decodes revert bytes via `_decodeRevertData` + `_friendlyGasSwapError`.

## Testing
- `tests/test_revert_data_handling.py` — content/behavior tests locking in the fix. Run with `python -m pytest tests/test_revert_data_handling.py`.
- `tests/test_ubi_reminder_content.py` — content tests for the Telegram UBI reminder (message builders + per-wallet processing). Run with `python -m unittest tests.test_ubi_reminder_content`.
- Many tests need `flask` / `requests` (not installed in the base env). Content tests (`test_*_content.py`) run without deps.
- JS syntax: `node --check static/js/<file>.js`. For template inline JS, strip Jinja `{{ }}`/`{% %}` first (see tests for the regex approach).

## Conventions
- No build step for frontend JS — edit files directly, bump `?v={{ ASSET_VERSION }}` is handled by template caching.
- Comments explain *why*, not *what*. Existing style uses section banners (── / ═══).
