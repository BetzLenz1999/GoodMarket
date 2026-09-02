-- Track withdrawal completion state so failed/pending minigame withdrawals are
-- never shown as successfully withdrawn in user history.
ALTER TABLE public.minigame_withdrawals_log
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'completed';

CREATE INDEX IF NOT EXISTS idx_minigame_withdrawals_log_status
  ON public.minigame_withdrawals_log(status);
