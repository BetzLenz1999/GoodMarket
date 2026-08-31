-- Optional story date for admin-featured Community Stories tweets.
-- Existing rows fall back to created_at in the app, but this column lets admins
-- choose the exact dated public URL: /community-stories/YYYY-MM-DD.
ALTER TABLE IF EXISTS public.community_tweet_showcases
  ADD COLUMN IF NOT EXISTS showcase_date date DEFAULT CURRENT_DATE;

UPDATE public.community_tweet_showcases
SET showcase_date = COALESCE(showcase_date, created_at::date, CURRENT_DATE)
WHERE showcase_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_community_tweet_showcases_showcase_date
  ON public.community_tweet_showcases (showcase_date DESC);
