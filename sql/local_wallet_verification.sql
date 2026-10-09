-- Human (face) verification status for local (in-app) wallet accounts.
--
-- Local wallet accounts are created in the browser (email + PIN, self-custodial)
-- and stored in `local_wallet_accounts`. That table had NO verification state,
-- so admins could not answer "how many local-wallet users are face-verified?"
-- without checking each wallet against the on-chain Identity contract.
--
-- The authoritative source stays the on-chain `Identity.isWhitelisted` read
-- (`blockchain.is_identity_verified`). These columns are a *cache* of that read
-- so the count/tracing is a single cheap query instead of N RPC calls:
--   - `verification_status`   – 'verified' | 'unverified' (human-readable label)
--   - `is_human_verified`     – boolean mirror of the status (cheap to count/filter)
--   - `human_verified_at`     – when it was FIRST confirmed verified
--   - `last_verified_check`   – when the on-chain read last ran (staleness signal)
--
-- Written two ways (see routes.py + local_wallet_verification.py):
--   1. write-time stamp when a user confirms FV (instant, best-effort)
--   2. a background reconciler that backfills existing rows and refreshes the
--      status so a de-verified wallet flips back to 'unverified'.
--
-- Safe to run on an existing deployment: ADD COLUMN IF NOT EXISTS keeps the
-- current rows, and every existing email-account starts as 'unverified' until
-- the reconciler confirms it on-chain.

alter table public.local_wallet_accounts
    add column if not exists verification_status text not null default 'unverified',
    add column if not exists is_human_verified boolean not null default false,
    add column if not exists human_verified_at timestamptz,
    add column if not exists last_verified_check timestamptz;

-- Guard against a bad writer storing an unexpected label.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'local_wallet_accounts_verification_status_check'
    ) then
        alter table public.local_wallet_accounts
            add constraint local_wallet_accounts_verification_status_check
            check (verification_status in ('verified', 'unverified'));
    end if;
end $$;

create index if not exists local_wallet_accounts_is_human_verified_idx
    on public.local_wallet_accounts (is_human_verified);

create index if not exists local_wallet_accounts_verification_status_idx
    on public.local_wallet_accounts (verification_status);
