-- 054_pickup_verifications.sql
-- Stores server-side 6-digit SMS codes for local-pickup confirmation.
-- Codes are never exposed to the browser — only the Edge Function reads/writes this table.

CREATE TABLE IF NOT EXISTS pickup_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Only the service role (Edge Functions) may read/write codes.
ALTER TABLE pickup_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON pickup_verifications USING (FALSE);

-- Add pickup columns to orders if they don't already exist.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pickup_date      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS picked_up_by     TEXT,
  ADD COLUMN IF NOT EXISTS staff_handed_off TEXT,
  ADD COLUMN IF NOT EXISTS pickup_notes     TEXT;
