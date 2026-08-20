-- Local (browser-generated, self-custodial) wallet accounts for GoodMarket.
-- The raw private key and PIN never leave the user's device; only the
-- scrypt-encrypted ethers V3 keystore is stored so the account survives
-- phone loss (download keystore on new device -> unlock with PIN).
--
-- PII-free: the full email is NEVER stored. Lookups use email_hash
-- (sha256 of the lowercased email); email_masked keeps only "j***@gmail.com"
-- for admin display. Matching the codebase convention of masking wallets
-- ("0xabcd...1234"), user emails are masked everywhere they might be read.

create table if not exists public.local_wallet_accounts (
    id uuid primary key default gen_random_uuid(),
    email_hash text not null,              -- sha256 hex of the lowercased email (lookup key)
    email_masked text not null,            -- j***@gmail.com — display only, never a lookup key
    address text not null,                 -- EIP-55 checksummed wallet address
    keystore_json jsonb not null,          -- ethers V3 keystore (useless without the PIN)
    referral_code text,                    -- optional code entered at signup
    created_at timestamptz not null default now(),
    last_login_at timestamptz,
    unique(email_hash),
    unique(address)
);

create index if not exists local_wallet_accounts_email_hash_idx
    on public.local_wallet_accounts (email_hash);

-- Backend-only table: the service role handles all reads/writes.
alter table public.local_wallet_accounts enable row level security;
