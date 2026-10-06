-- Public Community Chatroom — GoodMarket
-- One shared, PUBLIC room where every signed-in user sees every message.
-- Messages are attributed to the poster's USERNAME (never the wallet address).
-- The UI is the same chat widget as the GoodMarket Agent (tabs inside the
-- floating panel) plus a standalone /chatroom page.
--
-- HIDDEN BY DEFAULT: the feature-visibility row below is seeded with
-- is_maintenance = TRUE, so /chatroom and every /chatroom/api/* call return
-- "not available" until an admin flips it ON from the dashboard
-- (Feature Visibility → Chatroom).
--
-- Run this in the Supabase SQL editor BEFORE enabling the feature.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Messages ─────────────────────────────────────────────────────────────────
-- wallet_address is the OWNER (kept private — never sent to the browser).
-- username is a snapshot taken at post time so rendering never needs a join.
CREATE TABLE IF NOT EXISTS community_chat_messages (
    id             BIGSERIAL PRIMARY KEY,
    room           TEXT NOT NULL DEFAULT 'general',
    wallet_address TEXT NOT NULL,
    username       TEXT,
    message        TEXT NOT NULL,
    -- Reply metadata is server-generated after validating a visible message.
    -- Wallet keys remain private and are used only to mark reply notifications.
    reply_to_id       BIGINT REFERENCES community_chat_messages(id) ON DELETE SET NULL,
    reply_to_username TEXT,
    reply_to_wallet   TEXT,
    is_deleted     BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_by     TEXT,
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot query: newest-first per room with an id cursor (polling).
CREATE INDEX IF NOT EXISTS idx_community_chat_room_id
    ON community_chat_messages(room, id DESC);
-- Rate-limit lookup: the poster's most recent message.
CREATE INDEX IF NOT EXISTS idx_community_chat_wallet_id
    ON community_chat_messages(wallet_address, id DESC);
CREATE INDEX IF NOT EXISTS idx_community_chat_reply_recipient
    ON community_chat_messages(reply_to_wallet, id DESC)
    WHERE reply_to_wallet IS NOT NULL;
-- Deletion cursor: the polling UI asks for rows deleted at/after a timestamp
-- so an admin delete prunes from every other viewer within a poll tick.
CREATE INDEX IF NOT EXISTS idx_community_chat_deleted_at
    ON community_chat_messages(deleted_at)
    WHERE is_deleted;

-- Safe to run after the original chatroom migration as well.
ALTER TABLE community_chat_messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT
    REFERENCES community_chat_messages(id) ON DELETE SET NULL;
ALTER TABLE community_chat_messages ADD COLUMN IF NOT EXISTS reply_to_username TEXT;
ALTER TABLE community_chat_messages ADD COLUMN IF NOT EXISTS reply_to_wallet TEXT;

-- ── Reports (user-flagged messages) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_chat_reports (
    id             BIGSERIAL PRIMARY KEY,
    message_id     BIGINT NOT NULL REFERENCES community_chat_messages(id) ON DELETE CASCADE,
    reporter_wallet TEXT NOT NULL,
    reason         TEXT,
    status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'resolved', 'dismissed')),
    reviewed_by    TEXT,
    reviewed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One report per user per message (a second tap is idempotent).
    CONSTRAINT uq_community_chat_report UNIQUE (message_id, reporter_wallet)
);

CREATE INDEX IF NOT EXISTS idx_community_chat_reports_status
    ON community_chat_reports(status, created_at DESC);

-- ── Bans (blocked from posting) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_chat_bans (
    wallet_address TEXT PRIMARY KEY,
    reason         TEXT,
    banned_by      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Hide flag (feature visibility) ───────────────────────────────────────────
-- maintenance_settings semantics: is_maintenance = TRUE  →  HIDDEN.
-- The NOT EXISTS guard keeps this idempotent even though the table may not
-- carry a UNIQUE constraint on feature_name.
--
-- chatroom_feature: the PUBLIC ROOM is hidden until an admin turns it on.
-- goodmarket_agent_feature: the GoodMarket Agent widget is the one we hide by
--   default, so the community room is what users land on. Flip it ON from
--   Admin → Feature Visibility → GoodMarket Agent when the agent is ready.
INSERT INTO maintenance_settings (feature_name, is_maintenance, maintenance_message)
SELECT 'chatroom_feature', TRUE, ''
WHERE NOT EXISTS (
    SELECT 1 FROM maintenance_settings WHERE feature_name = 'chatroom_feature'
);

INSERT INTO maintenance_settings (feature_name, is_maintenance, maintenance_message)
SELECT 'goodmarket_agent_feature', TRUE, ''
WHERE NOT EXISTS (
    SELECT 1 FROM maintenance_settings WHERE feature_name = 'goodmarket_agent_feature'
);
