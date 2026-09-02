-- Track withdrawal completion state so failed/pending minigame withdrawals are
-- never shown as successfully withdrawn in user history.
ALTER TABLE public.minigame_withdrawals_log
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'completed';

CREATE INDEX IF NOT EXISTS idx_minigame_withdrawals_log_status
  ON public.minigame_withdrawals_log(status);

-- Voucher metadata for user-paid Play & Earn withdrawals. A prepared voucher
-- reserves one database withdrawal until it expires or is confirmed on-chain.
ALTER TABLE public.minigame_withdrawals_log
  ADD COLUMN IF NOT EXISTS authorization_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by TEXT;

CREATE INDEX IF NOT EXISTS idx_minigame_withdrawals_log_wallet_status
  ON public.minigame_withdrawals_log(wallet_address, status);
