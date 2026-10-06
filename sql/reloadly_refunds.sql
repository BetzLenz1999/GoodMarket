-- Reloadly refund retry — schema hardening + documentation
--
-- The refund flow parks failed refunds as 'pending_refund' (auto-retried once
-- the REFUND_KEY wallet has CELO gas + G$) and uses these columns to record the
-- outcome. This migration makes them explicit for installs that ran an earlier
-- version of the base schema, and documents the status set.
--
-- Status values used by the refund lifecycle:
--   pending_refund  – refund parked; waiting for gas/balance or a retry
--   refunding       – CAS claim: a refund tx is in flight (or a worker died)
--   refunded        – refund confirmed on-chain
--   refund_failed   – hard failure; retried by the scheduler after a delay

ALTER TABLE reloadly_orders ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;
ALTER TABLE reloadly_orders ADD COLUMN IF NOT EXISTS refund_error   TEXT;
ALTER TABLE reloadly_orders ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- updated_at drives the stale-claim reclaim and the refund_failed retry gate.
-- The base schema already creates the column + trigger; this is a no-op guard.
ALTER TABLE reloadly_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_reloadly_orders_refund_status
    ON reloadly_orders(status)
    WHERE status IN ('pending_refund', 'refunding', 'refund_failed');
