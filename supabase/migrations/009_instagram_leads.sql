-- =============================================================================
-- PRI-256: Instagram Leads Module — Migration 009
-- Adds instagram_leads table for the Pulse IG Lead Board
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE ig_lead_stage AS ENUM (
  'new',          -- New / Needs Contact
  'reached_out',  -- Called / Reached Out
  'quoting',      -- Quoting
  'sampling',     -- Sampling / Waiting on Sample or Artwork
  'follow_up',    -- Follow-up Needed
  'won',          -- Closed Won
  'lost'          -- Closed Lost / Not Qualified
);

CREATE TYPE ig_lead_score AS ENUM (
  'hot',
  'warm',
  'cool'
);

-- ---------------------------------------------------------------------------
-- TABLE
-- ---------------------------------------------------------------------------

CREATE TABLE instagram_leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  ig_handle           text NOT NULL,
  name                text NOT NULL DEFAULT '',
  company             text NOT NULL DEFAULT '',
  phone               text NOT NULL DEFAULT '',
  email               text NOT NULL DEFAULT '',

  -- Lead details (populated from ManyChat / PRI-161 flow or manual entry)
  product_type        text NOT NULL DEFAULT '',   -- e.g. "mylar bags", "labels", "folding cartons"
  quantity            text NOT NULL DEFAULT '',   -- e.g. "500 units" (kept as text — reps may enter ranges)
  specs               text NOT NULL DEFAULT '',   -- size, dimensions, substrate
  urgency             text NOT NULL DEFAULT '',   -- timeline / rush indicator
  artwork_status      text NOT NULL DEFAULT '',   -- "has artwork" | "needs design" | "uploading" | ""
  brief               text NOT NULL DEFAULT '',   -- AI-generated or rep-written lead summary

  -- Scoring
  score               ig_lead_score NOT NULL DEFAULT 'warm',

  -- Pipeline
  stage               ig_lead_stage NOT NULL DEFAULT 'new',
  assigned_rep        text NOT NULL DEFAULT '',   -- 'gary' | 'ernesto' | ''

  -- Rep tracking
  rep_notes           text NOT NULL DEFAULT '',
  next_action         text NOT NULL DEFAULT '',
  next_action_date    date,

  -- External links
  conversation_url    text NOT NULL DEFAULT '',   -- ManyChat conversation link
  hubspot_contact_id  text NOT NULL DEFAULT '',
  hubspot_deal_id     text NOT NULL DEFAULT '',

  -- Source metadata
  source              text NOT NULL DEFAULT 'manual',   -- 'manual' | 'manychat' | 'webhook'
  account             text NOT NULL DEFAULT 'bazaar',   -- 'bazaar' | 'pixelpress'
  original_message    text NOT NULL DEFAULT '',
  messages            jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_contact_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

CREATE INDEX idx_ig_leads_stage      ON instagram_leads(stage);
CREATE INDEX idx_ig_leads_score      ON instagram_leads(score);
CREATE INDEX idx_ig_leads_rep        ON instagram_leads(assigned_rep);
CREATE INDEX idx_ig_leads_created    ON instagram_leads(created_at DESC);
CREATE INDEX idx_ig_leads_hubspot    ON instagram_leads(hubspot_contact_id) WHERE hubspot_contact_id <> '';

-- ---------------------------------------------------------------------------
-- AUTO-UPDATE updated_at
-- ---------------------------------------------------------------------------

-- Reuses the update_updated_at_column() function from migration 001
CREATE TRIGGER instagram_leads_updated_at
  BEFORE UPDATE ON instagram_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE instagram_leads ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read all leads
CREATE POLICY ig_leads_select ON instagram_leads
  FOR SELECT TO authenticated USING (true);

-- Authenticated users can insert leads
CREATE POLICY ig_leads_insert ON instagram_leads
  FOR INSERT TO authenticated WITH CHECK (true);

-- Authenticated users can update leads
CREATE POLICY ig_leads_update ON instagram_leads
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Only admins can delete leads (use 'lost' stage instead of deleting normally)
CREATE POLICY ig_leads_delete ON instagram_leads
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'supervisor')
    )
  );

-- Service role (used by ManyChat webhook / Edge Functions) has full access
-- (handled automatically by Supabase service role bypass)
