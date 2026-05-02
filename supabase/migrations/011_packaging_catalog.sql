-- =============================================================================
-- PUL-715: Packaging Catalog — packaging_products table
-- Stores Jars / Tubes / Bags pricing for internal quoting and order line items
-- Applied to: Supabase/Postgres (project: pulse.bazaar-admin.com)
-- Generated: 2026-05-01
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENUM: packaging category
-- ---------------------------------------------------------------------------

CREATE TYPE packaging_category AS ENUM (
  'Bags',
  'Jars',
  'Tubes',
  'Labels',
  'Pouches',
  'Cartons',
  'Other'
);

-- ---------------------------------------------------------------------------
-- TABLE: packaging_products
-- ---------------------------------------------------------------------------

CREATE TABLE packaging_products (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  sku               TEXT         NOT NULL UNIQUE,
  name              TEXT         NOT NULL,
  category          packaging_category NOT NULL,

  -- Product attributes
  material          TEXT,                         -- e.g. Mylar, Glass, Plastic
  finish            TEXT,                         -- e.g. Laser, Matte, Glossy
  production_method TEXT,                         -- e.g. digital, screen

  -- Internal cost (not shown to customer)
  default_cost      NUMERIC(10,4) NOT NULL DEFAULT 0,

  -- Base sale price (at min_qty tier)
  sell_price        NUMERIC(10,4) NOT NULL DEFAULT 0,

  -- All quantity-tiered sale prices stored as JSONB
  -- Keys: qty_25, qty_50, qty_100, qty_250, qty_500, qty_1000, qty_5000
  tier_pricing      JSONB         NOT NULL DEFAULT '{}',

  -- Ordering constraints
  min_qty           INTEGER       NOT NULL DEFAULT 25,
  lead_time_days    INTEGER,

  -- Catalog state
  active            BOOLEAN       NOT NULL DEFAULT TRUE,
  notes             TEXT,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

CREATE INDEX packaging_products_category_idx ON packaging_products(category);
CREATE INDEX packaging_products_active_idx   ON packaging_products(active);
CREATE INDEX packaging_products_sku_idx      ON packaging_products(sku);

-- ---------------------------------------------------------------------------
-- UPDATED_AT TRIGGER (reuse existing trigger function if available)
-- ---------------------------------------------------------------------------

-- Create the function only if it doesn't already exist (migration-safe)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER packaging_products_updated_at
  BEFORE UPDATE ON packaging_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE packaging_products ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read the catalog
CREATE POLICY "packaging_products_read"
  ON packaging_products FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can write (insert / update / delete)
CREATE POLICY "packaging_products_write"
  ON packaging_products FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'supervisor')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'supervisor')
    )
  );

-- ---------------------------------------------------------------------------
-- REALTIME
-- ---------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE packaging_products;

-- ---------------------------------------------------------------------------
-- COMMENTS
-- ---------------------------------------------------------------------------

COMMENT ON TABLE packaging_products IS
  'PUL-715 — Packaging product catalog: Bags, Jars, Tubes. '
  'Sourced from product-catalog-v2.json (68 SKUs). '
  'Cost data is internal-only; sell_price / tier_pricing are shown to reps for quoting.';

COMMENT ON COLUMN packaging_products.default_cost IS
  'Internal cost per unit (not shown to customers or on invoices)';

COMMENT ON COLUMN packaging_products.sell_price IS
  'Base sale price per unit at min_qty (25 units)';

COMMENT ON COLUMN packaging_products.tier_pricing IS
  'JSON object: qty_25..qty_5000 → unit sale price at that quantity break. '
  'Example: {"qty_25": 0.50, "qty_100": 0.425, "qty_1000": 0.35}';
