-- Telegram bot /tip — admin-only manual token tips (G$ / CELO / USDT / USDC /
-- cUSD on Celo, XDC / XDC G$ on XDC) disbursed from the TIP_KEY hot wallet.
--
-- Run this in Supabase BEFORE enabling /tip. The bot reads/writes this table
-- through the service-role client (RLS-safe), so a missing migration surfaces as
-- honest "ledger unavailable" refusals rather than silent over-spending.
--
-- tx_hash is UNIQUE so a retried confirm can never pay twice.

CREATE TABLE IF NOT EXISTS telegram_tips (
    id                 BIGSERIAL PRIMARY KEY,
    admin_telegram_id  TEXT NOT NULL,
    admin_wallet       TEXT,
    recipient_telegram TEXT,
    recipient_wallet   TEXT NOT NULL,
    token              TEXT NOT NULL,          -- GD | CELO | USDT | USDC | CUSD | XDC | XDC_GD
    amount             NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
    tx_hash            TEXT UNIQUE,            -- idempotency guard
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sending', 'confirmed', 'failed')),
    error_type         TEXT,
    error_message      TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily-cap reads filter on created_at within the UTC day; the admin rate-limit
-- reads the latest row for one admin.
CREATE INDEX IF NOT EXISTS idx_telegram_tips_created_at
    ON telegram_tips (created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_tips_admin_created
    ON telegram_tips (admin_telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_tips_token_status_created
    ON telegram_tips (token, status, created_at);

-- The public tip announcement + recipient DM are NOT stored here; this table is
-- the private, append-only audit ledger for admins.
