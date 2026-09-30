-- Community Chatroom — user-to-user tipping.
-- Users can tip each other the tokens the app supports (G$ on Celo, CELO,
-- G$ on XDC, XDC) directly from the public room, addressed by @username.
--
-- The tip is a REAL on-chain transfer signed by the sender's own wallet; the
-- backend only VERIFIES it (from / to / amount / token) before recording the
-- row and posting the public "Congrats …" message. There is no server key and
-- no custody at any point.
--
-- Run this in the Supabase SQL editor before enabling tipping.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tips ─────────────────────────────────────────────────────────────────────
-- wallet columns are the OWNER keys and are NEVER sent to the browser.
-- tx_hash is UNIQUE: a replayed confirm can never create a second tip.
CREATE TABLE IF NOT EXISTS community_chat_tips (
    id                BIGSERIAL PRIMARY KEY,
    room              TEXT NOT NULL DEFAULT 'general',
    sender_wallet     TEXT NOT NULL,
    sender_username   TEXT,
    recipient_wallet  TEXT NOT NULL,
    recipient_username TEXT,
    token             TEXT NOT NULL
                      CHECK (token IN ('GD', 'CELO', 'XDC_GD', 'XDC')),
    amount            TEXT NOT NULL,
    network           TEXT NOT NULL DEFAULT 'celo',
    tx_hash           TEXT NOT NULL UNIQUE,
    message_id        BIGINT REFERENCES community_chat_messages(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent tips per room (the activity strip / admin view).
CREATE INDEX IF NOT EXISTS idx_community_chat_tips_room_id
    ON community_chat_tips(room, id DESC);
-- Rate-limit lookup: the sender's most recent tip.
CREATE INDEX IF NOT EXISTS idx_community_chat_tips_sender
    ON community_chat_tips(sender_wallet, id DESC);

-- ── Message enrichment ───────────────────────────────────────────────────────
-- A tip posts a normal room message; these columns let the UI render it as a
-- gold "tip" card instead of a plain bubble. They are informational only —
-- the tip itself lives in community_chat_tips.
ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS tip_token TEXT;
ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS tip_amount TEXT;
ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS tip_tx_hash TEXT;
