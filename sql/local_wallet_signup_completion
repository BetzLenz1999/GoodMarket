-- Distinguish *finished* local-wallet signups from abandoned ones.
--
-- Bug: users who never actually created a local (email + PIN) wallet showed up
-- in `local_wallet_accounts`, so the admin "Local Wallet Verification" counts
-- were inflated and looked like they contained ordinary (WalletConnect /
-- injected / Privy) users.
--
-- Root cause: `/api/local-wallet/register` writes the row as soon as the
-- browser has generated the keypair — i.e. BEFORE the user saves their recovery
-- words and completes the first login. Every abandoned signup (very common: the
-- 12-word step is where users bail) therefore left a permanent row, and nothing
-- in the table could tell those rows apart from real accounts.
--
-- These columns record the real completion signal:
--   - `signup_completed` – true only once the user has actually logged in
--   - `first_login_at`   – when that first successful login happened
--
-- A row with `signup_completed = false` is an abandoned signup artifact, not a
-- local-wallet user. The admin summary counts completed accounts only, and the
-- dashboard can purge the abandoned rows.
--
-- Backfill: `last_login_at` was already stamped by every successful
-- `/api/local-wallet/login`, so any existing row that has it is a real account.
--
-- Idempotent: safe to run more than once.

alter table public.local_wallet_accounts
    add column if not exists signup_completed boolean not null default false,
    add column if not exists first_login_at timestamptz;

-- Every row that ever logged in is a completed signup.
update public.local_wallet_accounts
set signup_completed = true
where last_login_at is not null
  and signup_completed = false;

-- Preserve the earliest known login time for the backfilled rows.
update public.local_wallet_accounts
set first_login_at = last_login_at
where first_login_at is null
  and last_login_at is not null;

create index if not exists local_wallet_accounts_signup_completed_idx
    on public.local_wallet_accounts (signup_completed);
