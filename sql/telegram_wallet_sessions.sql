-- Telegram wallet-only login sessions for GoodMarket Learn & Earn.
-- Run this in Supabase before enabling the Telegram wallet capture flow.

CREATE TABLE IF NOT EXISTS telegram_wallet_sessions (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id TEXT UNIQUE NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    wallet_address VARCHAR(42) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_wallet_sessions_wallet
    ON telegram_wallet_sessions(wallet_address);

CREATE INDEX IF NOT EXISTS idx_telegram_wallet_sessions_last_seen
    ON telegram_wallet_sessions(last_seen_at DESC);

-- UBI reminder dedup: the daily reminder scheduler writes today's UTC date
-- here after sending a reminder. The UBI claim window resets at 12:00 UTC,
-- so one reminder per wallet per UTC day is enough.
ALTER TABLE telegram_wallet_sessions ADD COLUMN IF NOT EXISTS ubi_reminder_sent_date DATE;
CREATE INDEX IF NOT EXISTS idx_telegram_wallet_sessions_ubi_reminder_date
    ON telegram_wallet_sessions(ubi_reminder_sent_date);
