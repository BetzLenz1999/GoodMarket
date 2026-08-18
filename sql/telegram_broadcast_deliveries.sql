-- Durable Telegram broadcast delivery tracking.
--
-- The admin "broadcast message" feature saves a row in admin_broadcast_messages
-- and used to push to Telegram bot users via a fire-and-forget daemon thread.
-- That thread was killed by gunicorn worker recycling (max_requests / graceful
-- timeout) mid-broadcast, so many users never received the message and the admin
-- had no way to know. This durable delivery layer fixes that:
--
--   * admin_broadcast_messages gets aggregate delivery columns (tg_status,
--     tg_total, tg_sent, tg_failed, tg_queued_at, tg_delivered_at)
--   * a per-recipient row in telegram_broadcast_deliveries records each chat_id
--     and its delivery status, so a background scheduler can (re)deliver the
--     remaining ones idempotently until the broadcast is fully delivered.
--
-- Run this in the Supabase SQL editor.

-- ─── Aggregate delivery columns on the broadcast itself ────────────────────
-- tg_status: 'pending' (queued, not yet fully delivered) | 'partially_sent'
--            (some sent, some still pending) | 'sent' (all deliverable users
--            got it) | 'failed' (delivery errored and gave up). NULL for
--            broadcasts created before this migration (treated lazily).
ALTER TABLE admin_broadcast_messages ADD COLUMN IF NOT EXISTS tg_status TEXT;
ALTER TABLE admin_broadcast_messages ADD COLUMN IF NOT EXISTS tg_total INT DEFAULT 0;
ALTER TABLE admin_broadcast_messages ADD COLUMN IF NOT EXISTS tg_sent INT DEFAULT 0;
ALTER TABLE admin_broadcast_messages ADD COLUMN IF NOT EXISTS tg_failed INT DEFAULT 0;
ALTER TABLE admin_broadcast_messages ADD COLUMN IF NOT EXISTS tg_queued_at TIMESTAMPTZ;
ALTER TABLE admin_broadcast_messages ADD COLUMN IF NOT EXISTS tg_delivered_at TIMESTAMPTZ;

-- ─── Per-recipient delivery rows ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_broadcast_deliveries (
    id BIGSERIAL PRIMARY KEY,
    broadcast_id INT NOT NULL REFERENCES admin_broadcast_messages(id) ON DELETE CASCADE,
    telegram_chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed | blocked
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (broadcast_id, telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_deliveries_status
    ON telegram_broadcast_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_tg_deliveries_broadcast
    ON telegram_broadcast_deliveries(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_tg_deliveries_pending
    ON telegram_broadcast_deliveries(broadcast_id) WHERE status = 'pending';

-- Enable RLS — server-side service-role client bypasses it, but be explicit so
-- the anon key (used by the web notifications read path) cannot tamper with
-- delivery rows.
ALTER TABLE telegram_broadcast_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Server-only access to telegram_broadcast_deliveries"
    ON telegram_broadcast_deliveries FOR ALL
    USING (false) WITH CHECK (false);
