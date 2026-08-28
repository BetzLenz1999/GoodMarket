-- Durable, cross-worker pending text-submission sessions for the Telegram bot.
--
-- The bot runs under gunicorn gthread with up to 4 workers (plus Vercel
-- autoscale), so in-memory session dicts are per-process: a user who taps
-- "Submit X/Twitter URL" (handled by worker A) and then pastes the URL
-- (handled by worker B) used to lose the pending state and fall through to
-- the generic wallet handler ("That does not look like a valid wallet
-- address..."). This table persists the pending state so any worker can pick
-- it up. Run this in Supabase before enabling the durable sessions.
--
-- The in-memory dicts remain as a fallback when the table is missing, so the
-- bot keeps working even if this migration has not been applied.

CREATE TABLE IF NOT EXISTS telegram_feature_sessions (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    chat_id TEXT,
    wallet TEXT,
    state TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_telegram_feature_sessions_user_feature UNIQUE (telegram_user_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_telegram_feature_sessions_feature
    ON telegram_feature_sessions(feature);
