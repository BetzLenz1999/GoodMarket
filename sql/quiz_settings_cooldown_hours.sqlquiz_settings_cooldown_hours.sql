-- Learn & Earn quiz cooldown is now configurable (default 24h / 1 day; previously hardcoded120h / 5 days).
-- Run in Supabase SQL Editor before deploying the code that reads/writes cooldown_hours.

ALTER TABLE public.quiz_settings
  ADD COLUMN IF NOT EXISTS cooldown_hours INTEGER NOT NULL DEFAULT 24;

-- Best-effort backfill: any existing settings row without an explicit value gets the new default.
UPDATE public.quiz_settings
SET cooldown_hours = 24
WHERE cooldown_hours IS NULL;
