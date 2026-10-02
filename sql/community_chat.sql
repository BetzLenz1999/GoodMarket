-- Safe to run after the original chatroom migration as well.
-- Add the reply columns first because an existing table is not changed by
-- CREATE TABLE IF NOT EXISTS.
ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS reply_to_id BIGINT
    REFERENCES community_chat_messages(id) ON DELETE SET NULL;

ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS reply_to_username TEXT;

ALTER TABLE community_chat_messages
    ADD COLUMN IF NOT EXISTS reply_to_wallet TEXT;

-- Hot query: newest-first per room with an id cursor (polling).
CREATE INDEX IF NOT EXISTS idx_community_chat_room_id
    ON community_chat_messages(room, id DESC);

-- Rate-limit lookup: the poster's most recent message.
CREATE INDEX IF NOT EXISTS idx_community_chat_wallet_id
    ON community_chat_messages(wallet_address, id DESC);

-- Reply notification lookup: messages replying to a specific recipient.
CREATE INDEX IF NOT EXISTS idx_community_chat_reply_recipient
    ON community_chat_messages(reply_to_wallet, id DESC)
    WHERE reply_to_wallet IS NOT NULL;
