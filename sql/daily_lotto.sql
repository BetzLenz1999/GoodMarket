-- Daily Lotto (6/100) — GoodMarket
-- Users pick 6 unique numbers from 1..100 ONCE per Philippines game date.
-- A draw runs every 8:00 PM Philippines time; matching drawn numbers wins G$.
-- User-facing page: /lotto  ·  Background draw+grant scheduler: draw_automation.py
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this in the Supabase SQL editor BEFORE enabling the draw scheduler. The
-- scheduler fails closed (it only logs) until these tables exist.

-- One round per Philippines game date. round id = integer date, e.g. 20260913.
CREATE TABLE IF NOT EXISTS daily_lotto_rounds (
    id             BIGINT PRIMARY KEY,             -- e.g. 20260913
    game_date      DATE UNIQUE NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','drawing','completed')),
    winning_numbers INTEGER[],                     -- 6 unique ints, each 1..100
    seed_hash      TEXT,
    drawn_at       TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    grant_status   TEXT NOT NULL DEFAULT 'none'
                   CHECK (grant_status IN ('none','granting','granted','partial','failed')),
    prorated       BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE when prize-pool cap kicked in
    created_at     TIMESTAMPTZ DEFAULT now(),
    updated_at     TIMESTAMPTZ DEFAULT now()
);

-- One entry per wallet per round (game date). The UNIQUE constraint is the
-- atomic "1 pick per day" guard: the pick route upserts with ON CONFLICT and
-- reports already_picked instead of inserting a second row.
CREATE TABLE IF NOT EXISTS daily_lotto_entries (
    id             BIGSERIAL PRIMARY KEY,
    round_id       BIGINT NOT NULL REFERENCES daily_lotto_rounds(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    numbers        INTEGER[] NOT NULL,             -- exactly 6, each 1..100, unique
    created_at     TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_lotto_entry_per_day UNIQUE (round_id, wallet_address)
);

-- Computed winnings per round. Rows are written by the draw routine (the only
-- place that ever writes winners) and by claim verification.
CREATE TABLE IF NOT EXISTS daily_lotto_winnings (
    id              BIGSERIAL PRIMARY KEY,
    round_id        BIGINT NOT NULL REFERENCES daily_lotto_rounds(id) ON DELETE CASCADE,
    wallet_address  TEXT NOT NULL,
    match_count     INT NOT NULL CHECK (match_count BETWEEN 3 AND 6),
    amount_gd       NUMERIC NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claiming','claimed')),
    tx_hash         TEXT,
    claimed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_lotto_win_per_round_player UNIQUE (round_id, wallet_address)
);

-- Prize tiers — the ADMIN-EDITABLE amounts that drive the draw math, the page
-- copy and the on-chain grant. Defaults: 3→10k, 4→20k, 5→30k, 6→50k.
CREATE TABLE IF NOT EXISTS daily_lotto_prize_tiers (
    match_count INT PRIMARY KEY CHECK (match_count BETWEEN 3 AND 6),
    amount_gd   NUMERIC NOT NULL DEFAULT 0,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ DEFAULT now()
);
INSERT INTO daily_lotto_prize_tiers (match_count, amount_gd) VALUES
    (3, 10000), (4, 20000), (5, 30000), (6, 50000)
ON CONFLICT (match_count) DO NOTHING;

-- Feature + admin settings (single key/value bag).
--   daily_prize_pool_cap_gd : 0 = unlimited (default). When >0, the draw
--       prorates each tier's total over its winners (round-robin) so the
--       team's exposure per day never exceeds the cap.
CREATE TABLE IF NOT EXISTS daily_lotto_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO daily_lotto_settings (key, value) VALUES
    ('daily_prize_pool_cap_gd', '0')
ON CONFLICT (key) DO NOTHING;

-- Throttled "vault needs G$ refill" notifications for the proposer/admin.
-- Inserted by the withdraw route / scheduler (max one per throttle window)
-- and listed on the admin dashboard until resolved.
CREATE TABLE IF NOT EXISTS daily_lotto_vault_alerts (
    id         BIGSERIAL PRIMARY KEY,
    round_id   BIGINT,
    winners    INT NOT NULL DEFAULT 0,
    shortfall_gd NUMERIC,
    message    TEXT NOT NULL,
    resolved   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for the hot queries (per-day entry lookup, admin overview, win fetch)
CREATE INDEX IF NOT EXISTS idx_lotto_entries_round  ON daily_lotto_entries(round_id);
CREATE INDEX IF NOT EXISTS idx_lotto_entries_wallet ON daily_lotto_entries(wallet_address);
CREATE INDEX IF NOT EXISTS idx_lotto_winnings_round ON daily_lotto_winnings(round_id);
CREATE INDEX IF NOT EXISTS idx_lotto_winnings_wallet ON daily_lotto_winnings(wallet_address);
CREATE INDEX IF NOT EXISTS idx_lotto_rounds_status  ON daily_lotto_rounds(status, game_date);
CREATE INDEX IF NOT EXISTS idx_lotto_alerts_resolved ON daily_lotto_vault_alerts(resolved, created_at);
