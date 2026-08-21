-- GCash Cashout Requests
-- Users send G$ to GCASH_ADDRESS on-chain, then the admin manually sends
-- the PHP equivalent via GCash. If not reviewed within 24 hours the G$ is
-- automatically refunded. Rejected requests also trigger an automatic refund.

CREATE TABLE IF NOT EXISTS gcash_cashout_requests (
    id              BIGSERIAL PRIMARY KEY,
    wallet_address  TEXT NOT NULL,
    gcash_number    TEXT NOT NULL,
    gcash_name      TEXT NOT NULL,
    amount_gd       NUMERIC NOT NULL CHECK (amount_gd > 0),  -- >0 (not >=5000): auto-refund rows record the actual received amount, which can be below the minimum
    amount_php      NUMERIC NOT NULL,           -- amount_gd / 100
    tx_hash         TEXT NOT NULL UNIQUE,       -- user's G$ → GCASH_ADDRESS tx
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                        'pending',        -- waiting admin review
                        'refunding',      -- CAS claim: refund tx in progress
                        'approved',       -- admin approved, GCash sent
                        'rejected',       -- admin rejected, G$ auto-refunded
                        'refunded',       -- auto-refund (24h timeout)
                        'refund_failed'   -- refund tx failed (manual intervention)
                    )),
    admin_note      TEXT,                        -- admin's reason/note
    reference_number TEXT,                       -- GCash reference # (set on approve)
    receipt_image_url TEXT,                      -- ImgBB receipt screenshot (set on approve)
    refund_tx_hash  TEXT,                        -- refund tx (if rejected/refunded)
    reviewed_by     TEXT,                        -- admin wallet address
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Safety for installs that ran an earlier version of this migration:
ALTER TABLE gcash_cashout_requests ADD COLUMN IF NOT EXISTS reference_number TEXT;
ALTER TABLE gcash_cashout_requests ADD COLUMN IF NOT EXISTS receipt_image_url TEXT;

-- 2026-08: allow auto-refund rows to record the actual received amount, which
-- can be below the 5,000 G$ minimum when the user's transfer didn't match the
-- form amount. The 5,000 minimum is still enforced by the app for new cashouts.
ALTER TABLE gcash_cashout_requests DROP CONSTRAINT IF EXISTS gcash_cashout_requests_amount_gd_check;
ALTER TABLE gcash_cashout_requests ADD CONSTRAINT gcash_cashout_requests_amount_gd_check CHECK (amount_gd > 0);

-- Indexes for fast admin + user queries
CREATE INDEX IF NOT EXISTS idx_gcash_status  ON gcash_cashout_requests(status);
CREATE INDEX IF NOT EXISTS idx_gcash_wallet  ON gcash_cashout_requests(wallet_address);
CREATE INDEX IF NOT EXISTS idx_gcash_created ON gcash_cashout_requests(created_at);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_gcash_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gcash_updated_at ON gcash_cashout_requests;
CREATE TRIGGER trg_gcash_updated_at
    BEFORE UPDATE ON gcash_cashout_requests
    FOR EACH ROW EXECUTE FUNCTION update_gcash_updated_at();
