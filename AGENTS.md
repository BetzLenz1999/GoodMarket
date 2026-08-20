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

## Local self-custodial wallet (GMLocalWallet) signing (2026-08)
Local-wallet users (`login_method === 'local'`, session wallet created in-browser via `static/js/local-wallet.js`) must sign with the **PIN-decrypted in-app wallet** — never with an injected MetaMask/extension, which is a *different account*. When the wallet auto-locks, prompt the built-in PIN modal (`window._lwOpenUnlockModal()`), then use `GMLocalWallet.getProvider()` (an EIP-1193 provider; wrap in `new ethers.BrowserProvider(...)` + `getSigner()` when callers need a real ethers Signer, e.g. swap.html's `getConnectedSwapSigner()`).

Key invariants when touching signing flows:
- **Celo only** — the in-app wallet signs Celo transactions ONLY. XDC/FUSE paths (swap bridge, wallet.html token sends, raffle) are blocked up-front with a friendly error for local logins; never call `wallet_switchEthereumChain` for the local provider (it always reports 0xa4ec).
- **No injected fall-through** — every `_getEthProvider()`-style resolver must return null / be bypassed for local logins so a desktop MetaMask can't hijack the account ("Wrong wallet connected").
- **No CIP-64** — MiniPay `isMiniPay()` checks return false for local logins (in-app wallet pays CELO gas); the `MPGasTopUp.isMiniPay()` preflight gates in swap.html are skipped too.
- Pages wired: `savings.html` (reference implementation), `swap.html` (real ethers signer + Celo-only guards + no-wallet button gate), `reloadly.html` (send + signing-flow gating), `claim.html` (claim branch; also fixed `injectedProvider` block-scope bug), `static/js/p2p/p2p-wallet.js` (`getProvider()` unlock prompt, `_getInjected()`/`isMiniPay()` guards), `wallet.html` (doSend, raffle signer, claim capabilities/preflight), `send-link.html` (send/cancel/balance), `learn_and_earn.html` (loads ethers+local-wallet.js; L&E deposit `swSendViaWallet` + NFT buy `executeBuyNFT`).
- Tests: `tests/test_local_wallet_signing_content.py` (content, no deps).

## "missing revert data" — root cause & fix (2026-08)
ethers.js v6 throws `"missing revert data in call exception"` whenever an `eth_call` / `eth_estimateGas` reverts and the returned JSON-RPC error object has **no `data` field** (the revert bytes). Public Celo RPC nodes and mobile wallet providers (Trust, MiniPay) are inconsistent — some return `error.data`, some don't. The bridge used to forward reverts as `new Error(data.error.message)`, **dropping `error.data` and `error.code`**, which forced ethers into the opaque "missing revert data" path.

Fix layers (all in this repo):
1. `static/js/tx-error.js` — `_decodeRevertData()` decodes `Error(string)` (0x08c379a0), `Panic(uint256)` (0x4e487b71), custom selectors. Exposes `GMTxError.{decodeRevertData, revertReasonFromError, simulateCallCelo}`. `_isReverted()` now matches `missing revert data`. **ABI offset gotcha**: string length word is at hex offset 72 (after selector[8] + offset word[64]), string bytes start at 136 — NOT 136/200.
2. `static/js/wc-bridge.js` — `_rpcErrorFromJsonRpcError` preserves `error.code` + `error.data`; `_celoJsonRpcWithFallback` retries the next RPC URL only when `data` is absent (a revert-with-data is deterministic, no point retrying).
3. `templates/swap.html` — inline `_celoJsonRpc` mirrors the above; `_enrichSwapError(err, simParams, ctx)` re-runs the exact failing calldata as a read-only `eth_call` against several Celo RPCs to recover the revert reason, plus an ERC-20 allowance/balance diagnostic. Wired into `startReserveSwap` (GoodReserve sell/buy) and `startSwap` (Uniswap wallet-signer path).
4. `static/js/minipay-gas-topup.js` — balance reads (`_ethCall`, `_getCeloBalance`) now fall back to public Celo RPCs when the wallet provider fails (fixes "gas request not working when low balance"); CELO→cUSD swap decodes revert bytes via `_decodeRevertData` + `_friendlyGasSwapError`.

## Reloadly refund gas-park (2026-08)
When a Reloadly fulfillment fails, the backend refunds G$ via the `REFUND_KEY` wallet. If that wallet has **no CELO gas**, the refund used to hard-fail with a scary "contact support" message. Now:
- `reloadly/service.py` `refund_gd()` does a preflight CELO balance check + matches `insufficient funds`/gas errors, returning `error_type: "insufficient_gas"`.
  - **Gas estimate fix (2026-08):** the preflight now `estimate_gas`s the real transfer (~51k units) and checks `signer_celo >= gas_limit*gas_price` against that — **not** a bloated fixed `REFUND_GAS_LIMIT=250000` as before. The old fixed budget demanded CELO for 250k gas while the true tx costs ~51k, so a modest gas refill (enough for the real tx but below the 250k preflight threshold) kept orders stuck in `pending_refund` forever — "may gas na pero hindi nag-refund." Fallback `_REFUND_GAS_FALLBACK=80_000`, cap `_REFUND_GAS_CAP=150_000`, margin 1.2×. Same `gas_limit` is reused for the actual `build_transaction`.
- `reloadly/routes.py` `_process_refund_failure()` (used by both `api_confirm_order` and `api_detect_payment`) parks the order as **`pending_refund`** with a friendly "automatic refund within a few hours once the refund wallet is refilled with gas by the admin" message, instead of `refund_failed`.
- `reloadly/refund_retry.py` — env-gated (`RELOADLY_REFUND_RETRY_ENABLED`) background thread (same pattern as `ubi_reminder.py`) that retries `refund_gd` for `pending_refund` orders every `RELOADLY_REFUND_RETRY_INTERVAL_SEC` (default 600s). Succeeds **automatically** once gas is refilled; gas-stalled orders stay `pending_refund`, non-gas failures escalate to `refund_failed`.
  - **Concurrency-safe** via `claim_order_for_refund()` (CAS): atomically flips `pending_refund` -> `refunding` (PostgREST `update(...).eq("id",X).eq("status","pending_refund")`); only the winner sends a refund. Prevents double-refund across gunicorn workers / scheduler-vs-manual endpoint. Gas-stall releases back to `pending_refund`; success -> `refunded`; other failure -> `refund_failed`.
- Wired in `main.py` right after the Reloadly Store init block.
- Frontend `templates/reloadly.html` handles `pending_refund` status (info toast, blue pill, friendly copy).
- Tests: `tests/test_reloadly_refund_gas_content.py` (content, no deps).

## AI chat agent — transaction-hash lookup
`ai_agent/` is the chat-box agent (`/api/ai-agent/chat`). It classifies a message into a safe action preview (send/stream/swap/etc.) and never signs.
- **NEW: `lookup_transaction` action** — read-only tx-hash lookup. When a user asks "where is my tx hash" / "my Learn & Earn tx" / "reloadly txid" etc., the agent queries the user's own rows across feature tables and replies with the hash + amount + status + Celoscan link. No signing, no fund movement.
- `ai_agent/tx_lookup.py` — `lookup_transactions(wallet, feature)` queries (per feature): `learnearn_log` (+ `learn_earn_streams`), `reloadly_orders`, `referral_rewards_log`, `twitter_task_log`, `trustpilot_task_log`. supabase is imported **lazily** inside `_query_one` so the module imports/tests without supabase installed.
- Wallet-form gotcha: Learn & Earn quiz logs store the wallet **masked** (`0xabcd…1234`) OR full lowercase (depends on writer version) — `_build_wallet_filter` matches both via `or_`. Other tables store lowercase.
- `_is_onchain_hash()` filters to real Celo tx hashes (0x + 64 hex) so Reloadly's numeric `reloadly_transaction_id` and `queued:...` stream placeholders don't get a bogus explorer link.
- Keyword detection is **rules-based** (`is_tx_lookup_request` + `detect_feature`) so it works even without `OPENAI_API_KEY`; the OpenAI classifier is also taught the action via `lookup_feature`.
- Tests: `tests/test_ai_agent_tx_lookup_content.py` (functional via importlib + text-based wiring, no deps).

## Telegram broadcast — durable delivery (2026-08)
Admin broadcasts (`/api/admin/broadcast-message`) push to Telegram bot users. The web dashboard inbox reads the broadcast row directly so it always works, but the Telegram push used to drop silently.

- **Root cause:** the push ran as a fire-and-forget daemon thread spawned inside the admin HTTP request (`telegram_notify.broadcast_message_async`). Under gunicorn (`max_requests=500` recycling + `graceful_timeout`), that thread was killed mid-broadcast, so many users never received the message and the admin endpoint returned `success:true` regardless — no signal that delivery failed.
- **Fix — durable per-recipient queue + scheduler** (same pattern as `ubi_reminder.py` / `reloadly/refund_retry.py`):
  1. `sql/telegram_broadcast_deliveries.sql` — adds `telegram_broadcast_deliveries` (one row per recipient: `status` pending|sending|sent|failed|blocked, `attempts`, `last_error`, `delivered_at`) + aggregate columns on `admin_broadcast_messages` (`tg_status`, `tg_total`, `tg_sent`, `tg_failed`, `tg_queued_at`, `tg_delivered_at`). Run this migration in Supabase before enabling the scheduler.
  2. `telegram_notify.py` — `queue_broadcast_deliveries(broadcast_id, ...)` upserts one row per chat_id (`ON CONFLICT broadcast_id,telegram_chat_id` = idempotent re-queue); `deliver_broadcast_once(broadcast_id)` drains a batch with a **CAS claim** (`update(...).eq('status','pending')` → only rows we won the flip are sent) so two workers/scheduler runs can't double-send. `classify_send_error` splits Telegram failures into `blocked` (403/chat-not-found — permanent, never retry), `rate_limited` (429), `retryable` (5xx/network); transient failures stay `pending` and retry until `_MAX_RETRY_ATTEMPTS` (default 5) then escalate to `failed`. `send_message` signature unchanged so `ubi_reminder` is unaffected.
     - **Silent-failure guards (2026-08 follow-up):** `broadcast_message_async` only takes the durable path when `broadcast_delivery.is_delivery_enabled()` — with the scheduler off, queueing rows would deliver to nobody, so it uses the legacy best-effort direct send instead. `queue_broadcast_deliveries` **raises** on hard failures (DB down, token missing, upsert/stamp failed = migration not applied) instead of returning a success-looking summary, so the caller falls back to legacy. `_fetch_all_chat_ids(strict=True)` raises on query failure so an unreadable table can't masquerade as "no Telegram users".
     - **Stale-claim reclaim:** a worker killed mid-batch (the very gunicorn recycle this fix targets) leaves rows in `sending`; `deliver_broadcast_once` first runs `_reclaim_stale_sending` (flips `sending` rows with `updated_at` older than `_STALE_CLAIM_SECONDS`, default 300, back to `pending`) so they're redelivered instead of sticking the broadcast at `partially_sent` forever. The CAS claim now stamps `updated_at` so staleness is measurable.
  3. `broadcast_delivery.py` — env-gated scheduler (`TELEGRAM_BROADCAST_DELIVERY_ENABLED`, default off). Polls every `TELEGRAM_BROADCAST_DELIVERY_INTERVAL_SEC` (default 30) for broadcasts with `tg_status IN (pending, partially_sent)` and drains a batch each; a `wake_broadcast_delivery()` event triggers near-immediate delivery when a fresh broadcast is queued. If the tg_* schema is missing, `_fetch_due_broadcasts` logs migration instructions once and latches `_schema_missing` instead of erroring every interval.
  4. `routes.py` `send_broadcast_message` passes the freshly-inserted `broadcast_id` to `broadcast_message_async`; `get_broadcast_messages` returns the `tg_*` columns via `select('*')`.
  5. `main.py` starts the scheduler right after the UBI reminder block.
  6. `templates/admin_dashboard.html` — new "Telegram Delivery" column (`formatTelegramDelivery`) shows `✅ Delivered (sent/total)` / `⏳ Sending…` / `⏳ Queued` / `⚠️ Finished · N failed`; auto-refreshes the table every 15s while any broadcast is still delivering.
- **To enable:** run the SQL migration, then set `TELEGRAM_BROADCAST_DELIVERY_ENABLED=1` (and `TELEGRAM_BOT_TOKEN`). Without either, the admin broadcast degrades to the legacy best-effort direct send — Telegram users still get the message, just without durability/per-recipient tracking.
- **Diagnostics (2026-08 follow-up):** `GET /api/admin/telegram-diagnostics` (admin-only) runs `telegram_notify.get_broadcast_diagnostics()` — never-raises health check of every link (bot token, DB, service-role key, recipient count from `telegram_wallet_sessions`, deliveries-table + tg_* column probes, scheduler enabled) with human `hints`. The admin dashboard "🩺 Check Telegram Delivery Health" button renders it. `send_broadcast_message` response now includes `telegram_recipients` + `telegram_delivery_mode` (`durable_queued`|`legacy_best_effort`) + `telegram_warning` when 0 recipients — the #1 silent failure is "no Telegram bot users" (users must /start the bot AND save a wallet; only then do they appear in `telegram_wallet_sessions`). `count_broadcast_recipients()` returns -1 for "couldn't read" vs 0 for "no users".
- Tests: `tests/test_broadcast_delivery_content.py` (error classification, idempotent queue, CAS claim, aggregate status, retry cap, scheduler wiring, routes wiring, dashboard rendering — no deps, stubs `requests`/`supabase`). Run with `python -m unittest tests.test_broadcast_delivery_content`.

## GCash Cashout (2026-08)
Users cash out G$ → PHP via GCash. 100 G$ = ₱1.00, minimum 5,000 G$ (₱50), Philippines-only.
- **Flow:** `templates/wallet.html` `gcashModal` → user fills amount/number/name → signs G$ transfer to `GCASH_ADDRESS` (uses the standard signer routing — local/injected/WC) → `POST /api/gcash/cashout-request` verifies the tx **on-chain** (Transfer event: from=user, to=GCASH_ADDRESS, exact amount) then stores a `pending` row. One pending request per user.
- **Backend:** `gcash/` package (routes.py + service.py + refund_retry.py), blueprint `url_prefix=/api/gcash`. Admin endpoints: `GET /admin/requests`, `POST /admin/requests/<id>/approve` (manual GCash send), `POST .../reject` (auto-refund via `GCASH_KEY`).
- **Auto-refund:** `gcash/refund_retry.py` — env-gated (`GCASH_AUTO_REFUND_ENABLED`, interval `GCASH_AUTO_REFUND_INTERVAL_SEC` default 300s). Requests still `pending` after 24h are CAS-claimed (`pending`→`refunding`) and refunded. Same gas-preflight pattern as reloadly refund (estimate_gas, fallback 80k, cap 150k).
- **Env vars:** `GCASH_ADDRESS` (receives user G$), `GCASH_KEY` (signs refunds — needs CELO gas), `GCASH_AUTO_REFUND_ENABLED`.
- **DB:** `sql/gcash_cashout.sql` — `gcash_cashout_requests` (statuses: pending/refunding/approved/rejected/refunded/refund_failed; `tx_hash` UNIQUE prevents reuse). Run in Supabase before enabling.
- **Admin UI:** `templates/admin_dashboard.html` "GCash Cashout" section — filter by status, approve/reject buttons, elapsed-time badge for pending.
- **Approve = proof required:** approving opens `gcashApproveModal` — admin must enter the GCash **reference #** and upload a **receipt screenshot** (uploaded to ImgBB via `object_storage_client.upload_to_imgbb`, same helper as developer profiles/p2p). `admin_approve` takes multipart FormData (`reference_number`, `receipt_image`, optional `note`; JSON fallback), stores `reference_number` + `receipt_image_url` on the row, default note "✅ Successful — GCash payment sent."
- **User history:** inside the cashout modal (`/api/gcash/my-requests`) — approved rows show "✅ SUCCESSFUL · GCash sent! Ref #: … · View receipt ↗"; rejected/refunded rows link the refund tx on Celoscan.
- Tests: `tests/test_gcash_cashout_content.py`.

## Local wallet unlock fix (2026-08)
The unlock modal (`_lwOpenUnlockModal` in `static/js/local-wallet.js`) used to show a blanket "Unlock failed." for every error — a correct PIN could still fail when the cached keystore belonged to a different wallet (address mismatch) or when the device had no local copy (server keystore only). Fixed:
- **Specific error messages:** `describeUnlockError()` maps the decrypt error ("Incorrect PIN or corrupted wallet backup.") to "Wrong PIN.", surfaces "No wallet found on this device…" and "Cached wallet belongs to a different address…" instead of the misleading blanket text.
- **Server-keystore fallback:** when no local keystore exists, the modal calls `/api/local-wallet/keystore?email=…` (public endpoint — the keystore is encrypted and useless without the PIN) and tries to unlock with that copy before failing. The login page (`templates/homepage.html` `_lwCompleteLogin`) persists the email in `sessionStorage['lw_session_email']` + `window.GMLocalWalletEmail` so `_getSessionEmail()` can find it.
- **Stale-keystore cleanup:** on address mismatch, `clearLocalKeystore()` removes the wrong cached copy so the next login re-caches the correct one.
- **GCash nav:** the "GCash Cashout" button moved from the Wallet bottom-sheet to the bottom navigation bar, directly after "News" (`templates/wallet.html`).
- Tests: `tests/test_local_wallet_unlock_fix_content.py` (9 tests, no deps).

## Testing
- `tests/test_revert_data_handling.py` — content/behavior tests locking in the fix. Run with `python -m pytest tests/test_revert_data_handling.py`.
- `tests/test_local_wallet_signing_content.py` — content tests locking in GMLocalWallet (local self-custodial) signing routing across swap/reloadly/claim/p2p/wallet/send-link/learn_and_earn. No deps; run with `python -m pytest tests/test_local_wallet_signing_content.py`.
- `tests/test_gcash_cashout_content.py` — content tests for the GCash cashout feature (SQL, gcash/ package, wallet.html modal, admin dashboard, main.py wiring). No deps; run with `python -m pytest tests/test_gcash_cashout_content.py`.
- `tests/test_ubi_reminder_content.py` — content tests for the Telegram UBI reminder (message builders + per-wallet processing). Run with `python -m unittest tests.test_ubi_reminder_content`.
- `tests/test_ai_agent_tx_lookup_content.py` — functional (loads `ai_agent/tx_lookup.py` via importlib, no deps) + text-based wiring tests for the agent tx-hash lookup. Run with `python -m pytest tests/test_ai_agent_tx_lookup_content.py`.
- `tests/test_broadcast_delivery_content.py` — durable Telegram broadcast delivery (error classification, queue, CAS claim, aggregates, retry cap, scheduler, routes, dashboard). Run with `python -m unittest tests.test_broadcast_delivery_content`.
- Many tests need `flask` / `requests` (not installed in the base env). Content tests (`test_*_content.py`) run without deps.
- JS syntax: `node --check static/js/<file>.js`. For template inline JS, strip Jinja `{{ }}`/`{% %}` first (see tests for the regex approach).

## Conventions
- No build step for frontend JS — edit files directly, bump `?v={{ ASSET_VERSION }}` is handled by template caching.
- Comments explain *why*, not *what*. Existing style uses section banners (── / ═══).
