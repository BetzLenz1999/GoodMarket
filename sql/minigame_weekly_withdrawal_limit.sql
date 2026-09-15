-- Weekly withdrawal allowance for Play & Earn.
--
-- Each wallet may withdraw at most 500 G$ per calendar week (Monday 00:00 to
-- Sunday 23:59 PHT). Every completed withdrawal inserts one row keyed by
-- (wallet_address, week_key); the week's total is the sum of `amount`.
--
-- The unique constraint is what makes the cap safe under concurrency: two
-- withdrawal requests racing in different gunicorn workers can both read the
-- same "remaining" value, but only one can insert a given week row first.
-- The loser's insert fails, is retried, and then sees the winner's amount.
--
-- `amount` allows 0 because the row is seeded (with the week's existing payout
-- total, often 0) the first time a wallet is polled or withdraws in a week.

CREATE TABLE IF NOT EXISTS public.minigame_weekly_withdrawals (
  id BIGSERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL,
  week_key VARCHAR(10) NOT NULL,
  amount NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  tx_hash VARCHAR(80),
  session_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_minigame_weekly_withdrawal UNIQUE (wallet_address, week_key)
);

CREATE INDEX IF NOT EXISTS idx_minigame_weekly_withdrawals_wallet
  ON public.minigame_weekly_withdrawals(wallet_address, week_key);
