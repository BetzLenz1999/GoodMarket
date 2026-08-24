-- Daily Telegram appreciation reward log.
-- Run this in Supabase before enabling TELEGRAM_DAILY_REWARD_ENABLED.
--
-- One row per wallet per UTC day: the scheduler (telegram_daily_reward.py)
-- seeds a 'pending' row for every telegram_wallet_sessions wallet each morning
-- (10:00 AM Philippine time = 02:00 UTC), CAS-claims it (pending -> sending),
-- sends the G$ transfer from DAILYTASK_KEY, and marks it 'sent' once the tx
-- confirms on-chain. The UNIQUE(wallet_address, payout_date) constraint is the
-- hard guarantee against double-paying a wallet — seeding is idempotent
-- (ON CONFLICT DO NOTHING) and only the worker that wins the CAS flip sends.

CREATE TABLE IF NOT EXISTS telegram_daily_reward_log (
    id BIGSERIAL PRIMARY KEY,
    wallet_address VARCHAR(42) NOT NULL,
    payout_date DATE NOT NULL,
    telegram_chat_id TEXT,
    amount_gd NUMERIC(20, 2) NOT NULL DEFAULT 10,
    tx_hash VARCHAR(70),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (wallet_address, payout_date)
);

CREATE INDEX IF NOT EXISTS idx_telegram_daily_reward_log_status
    ON telegram_daily_reward_log(status);

CREATE INDEX IF NOT EXISTS idx_telegram_daily_reward_log_payout_date
    ON telegram_daily_reward_log(payout_date);

CREATE INDEX IF NOT EXISTS idx_telegram_daily_reward_log_wallet
    ON telegram_daily_reward_log(wallet_address);
