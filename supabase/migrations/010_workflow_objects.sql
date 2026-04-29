-- =============================================================================
-- PRI-262: Pulse MVP — Migration 010
-- Phase 1: Workflow Object Definitions
-- Phase 4: Proof/File Flow (proofs, proof_versions, proof_approval_events)
-- Tables: leads, deals, design_tasks, proofs, proof_versions,
--         proof_approval_events, shipping_tasks, post_sale_tasks
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE lead_status AS ENUM (
  'new',          -- just came in, needs contact
  'qualifying',   -- being evaluated
  'qualified',    -- passed qualification
  'routed',       -- handed to AM / rep
  'nurture',      -- long-term warm
  'lost'          -- not a fit / unresponsive
);

CREATE TYPE lead_source AS ENUM (
  'walk_in',
  'phone',
  'email',
  'instagram',
  'website',
  'referral',
  'repeat',
  'other'
);

CREATE TYPE deal_status AS ENUM (
  'draft',
  'sent',
  'follow_up',
  'won',
  'lost',
  'nurture'
);

CREATE TYPE design_task_status AS ENUM (
  'queued',
  'in_progress',
  'jm_review',    -- Job Manager reviewing before sending proof
  'revision',     -- customer requested revisions
  'done'
);

CREATE TYPE proof_status AS ENUM (
  'awaiting_upload',   -- designer hasn't uploaded yet
  'draft',             -- uploaded, not yet sent to customer
  'sent',              -- customer link delivered
  'revision_requested',-- customer asked for changes
  'approved',          -- customer approved
  'locked'             -- approved + locked for production; no more uploads
);

CREATE TYPE shipping_task_status AS ENUM (
  'pending',
  'packing',
  'labeled',
  'picked_up',        -- carrier picked up
  'delivered',
  'pickup_ready',     -- customer pickup
  'picked_up_by_customer'
);

CREATE TYPE post_sale_status AS ENUM (
  'pending',
  'thank_you_sent',
  'review_requested',
  'reorder_scheduled',
  'done'
);

-- ---------------------------------------------------------------------------
-- LEADS
-- Unified lead table. ig_leads (migration 009) remains for IG-specific detail.
-- A lead here is the canonical "first contact" object across all channels.
-- ---------------------------------------------------------------------------

CREATE TABLE leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name              TEXT NOT NULL,
  company           TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',

  -- Source
  source            lead_source NOT NULL DEFAULT 'other',
  source_detail     TEXT NOT NULL DEFAULT '',  -- e.g. "IG @handle", "Walk-in 4/29"

  -- Product interest
  product_type      TEXT NOT NULL DEFAULT '',
  quantity          TEXT NOT NULL DEFAULT '',
  specs             TEXT NOT NULL DEFAULT '',
  budget            TEXT NOT NULL DEFAULT '',
  urgency           TEXT NOT NULL DEFAULT '',
  artwork_status    TEXT NOT NULL DEFAULT '',  -- "has artwork" | "needs design" | ""

  -- Pipeline
  status            lead_status NOT NULL DEFAULT 'new',
  assigned_rep      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  score             TEXT NOT NULL DEFAULT 'warm' CHECK (score IN ('hot', 'warm', 'cool')),

  -- Rep tracking
  rep_notes         TEXT NOT NULL DEFAULT '',
  next_action       TEXT NOT NULL DEFAULT '',
  next_action_date  DATE,

  -- Qualification
  qualification_notes TEXT NOT NULL DEFAULT '',
  disqualify_reason   TEXT NOT NULL DEFAULT '',

  -- Linked objects
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,  -- set when converted
  deal_id           UUID,  -- FK added below after deals table

  -- External
  ig_lead_id        UUID,  -- references instagram_leads(id) if from IG

  -- Meta
  created_by        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX leads_status_idx ON leads(status);
CREATE INDEX leads_assigned_rep_idx ON leads(assigned_rep);
CREATE INDEX leads_created_at_idx ON leads(created_at DESC);

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- DEALS
-- One deal per sales conversation / quote. Created from a Lead or directly.
-- Replaces/complements the IndexedDB quotes table.
-- ---------------------------------------------------------------------------

CREATE TABLE deals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  deal_number           TEXT UNIQUE,   -- auto-assigned: DL-20260429-001

  -- Customer
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name         TEXT NOT NULL DEFAULT '',   -- denormalized
  customer_email        TEXT NOT NULL DEFAULT '',
  customer_phone        TEXT NOT NULL DEFAULT '',
  company               TEXT NOT NULL DEFAULT '',

  -- Product
  product_type          TEXT NOT NULL DEFAULT '',
  quantity              INTEGER,
  specs                 TEXT NOT NULL DEFAULT '',
  artwork_status        TEXT NOT NULL DEFAULT '',

  -- Pricing
  quoted_price          NUMERIC(10,2),
  currency              TEXT NOT NULL DEFAULT 'USD',
  price_notes           TEXT NOT NULL DEFAULT '',

  -- Pipeline
  status                deal_status NOT NULL DEFAULT 'draft',
  assigned_rep          UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Follow-up enforcement (spec: must be set at creation, Pulse blocks save without it)
  follow_up_date        DATE NOT NULL,
  last_contact_at       TIMESTAMPTZ,
  stale_alerted_at      TIMESTAMPTZ,   -- when 48h+ stale alert was fired

  -- Conversion
  converted_to_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  converted_at          TIMESTAMPTZ,

  -- Notes
  internal_notes        TEXT NOT NULL DEFAULT '',
  customer_notes        TEXT NOT NULL DEFAULT '',

  -- Source
  lead_id               UUID REFERENCES leads(id) ON DELETE SET NULL,

  -- Meta
  created_by            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deals_status_idx ON deals(status);
CREATE INDEX deals_assigned_rep_idx ON deals(assigned_rep);
CREATE INDEX deals_follow_up_date_idx ON deals(follow_up_date);
CREATE INDEX deals_created_at_idx ON deals(created_at DESC);

CREATE TRIGGER deals_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add FK back on leads for deal_id now that deals table exists
ALTER TABLE leads ADD CONSTRAINT leads_deal_id_fk
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- DESIGN TASKS
-- One per design assignment. Linked to an order (Job).
-- Created by Job Manager when an order needs design work.
-- ---------------------------------------------------------------------------

CREATE TABLE design_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  assigned_designer UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_by       UUID REFERENCES profiles(id) ON DELETE SET NULL,  -- Job Manager

  -- Status
  status            design_task_status NOT NULL DEFAULT 'queued',

  -- Brief
  title             TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  special_notes     TEXT NOT NULL DEFAULT '',
  reference_files   TEXT[] NOT NULL DEFAULT '{}',   -- R2 keys for reference files

  -- Timing
  due_date          DATE,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,

  -- Output
  output_file_ids   UUID[] NOT NULL DEFAULT '{}',   -- order_files.id of outputs

  -- Meta
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX design_tasks_order_idx ON design_tasks(order_id);
CREATE INDEX design_tasks_designer_idx ON design_tasks(assigned_designer);
CREATE INDEX design_tasks_status_idx ON design_tasks(status);

CREATE TRIGGER design_tasks_updated_at
  BEFORE UPDATE ON design_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- PROOFS
-- One proof thread per order. Tracks all versions and final approval.
-- Phase 4 priority build.
-- ---------------------------------------------------------------------------

CREATE TABLE proofs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  job_manager_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  design_task_id          UUID REFERENCES design_tasks(id) ON DELETE SET NULL,

  -- Status
  status                  proof_status NOT NULL DEFAULT 'awaiting_upload',

  -- Current version summary (denormalized for quick reads)
  current_version_number  INTEGER NOT NULL DEFAULT 0,
  current_version_id      UUID,   -- FK added below

  -- Approval outcome
  approved_version_number INTEGER,
  approved_version_id     UUID,   -- FK added below
  approved_at             TIMESTAMPTZ,
  approved_by_staff_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,  -- if JM-logged
  approval_method         TEXT CHECK (approval_method IN ('click_approve', 'email_reply', 'jm_logged')),
  approval_note           TEXT NOT NULL DEFAULT '',  -- required for jm_logged

  -- Lock
  locked_at               TIMESTAMPTZ,
  locked_by               UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Meta
  created_by              UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX proofs_order_idx ON proofs(order_id);
CREATE INDEX proofs_status_idx ON proofs(status);

CREATE TRIGGER proofs_updated_at
  BEFORE UPDATE ON proofs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- PROOF VERSIONS
-- One row per uploaded proof file. Version numbers auto-increment per proof.
-- All versions retained forever — never deleted.
-- ---------------------------------------------------------------------------

CREATE TABLE proof_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  proof_id            UUID NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  file_id             UUID REFERENCES order_files(id) ON DELETE SET NULL,  -- R2 file
  uploaded_by         UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Version number — enforced unique per proof, auto-set by app logic
  version_number      INTEGER NOT NULL,
  UNIQUE(proof_id, version_number),

  -- Designer notes for this version
  notes               TEXT NOT NULL DEFAULT '',

  -- Customer delivery
  approval_token      TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT,  -- token for customer link
  link_sent_at        TIMESTAMPTZ,
  link_sent_method    TEXT CHECK (link_sent_method IN ('email', 'sms', 'text_link', null)),
  link_sent_to        TEXT NOT NULL DEFAULT '',

  -- Customer interaction
  viewed_at           TIMESTAMPTZ,
  view_count          INTEGER NOT NULL DEFAULT 0,

  -- Decision
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','viewed','approved','revision_requested','superseded','locked')),
  decision_at         TIMESTAMPTZ,
  decision_by_name    TEXT NOT NULL DEFAULT '',  -- customer name or "JM: <name>"
  decision_notes      TEXT NOT NULL DEFAULT '',

  -- Meta
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX proof_versions_proof_idx ON proof_versions(proof_id);
CREATE INDEX proof_versions_token_idx ON proof_versions(approval_token);
CREATE INDEX proof_versions_status_idx ON proof_versions(status);

CREATE TRIGGER proof_versions_updated_at
  BEFORE UPDATE ON proof_versions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add FKs back on proofs for current/approved version
ALTER TABLE proofs ADD CONSTRAINT proofs_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES proof_versions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE proofs ADD CONSTRAINT proofs_approved_version_fk
  FOREIGN KEY (approved_version_id) REFERENCES proof_versions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- PROOF APPROVAL EVENTS
-- Immutable audit trail: every action on every proof version.
-- ---------------------------------------------------------------------------

CREATE TABLE proof_approval_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  proof_id            UUID NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  proof_version_id    UUID REFERENCES proof_versions(id) ON DELETE SET NULL,

  -- Event
  event_type          TEXT NOT NULL CHECK (event_type IN (
                        'version_uploaded',
                        'link_sent',
                        'customer_viewed',
                        'customer_approved',
                        'customer_revision_requested',
                        'jm_approved',          -- Job Manager logged offline approval
                        'jm_revision_noted',
                        'proof_locked',
                        'proof_unlocked'
                      )),

  -- Actor
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('staff', 'customer', 'system')),
  actor_staff_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,  -- if staff
  actor_name          TEXT NOT NULL DEFAULT '',  -- customer name or system label

  -- Context
  ip_address          TEXT NOT NULL DEFAULT '',
  user_agent          TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX proof_events_proof_idx ON proof_approval_events(proof_id);
CREATE INDEX proof_events_version_idx ON proof_approval_events(proof_version_id);
CREATE INDEX proof_events_created_at_idx ON proof_approval_events(created_at DESC);

-- ---------------------------------------------------------------------------
-- SHIPPING TASKS
-- One per order. Tracks pack-out, label, carrier, tracking, pickup confirmation.
-- Shipping cannot close without tracking # or pickup confirmation (spec gate).
-- ---------------------------------------------------------------------------

CREATE TABLE shipping_tasks (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  order_id                  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  assigned_to               UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Status
  status                    shipping_task_status NOT NULL DEFAULT 'pending',

  -- Fulfillment type
  fulfillment_type          TEXT NOT NULL DEFAULT 'ship'
                              CHECK (fulfillment_type IN ('ship', 'pickup')),

  -- Shipping details (required before task can close when fulfillment_type='ship')
  carrier                   TEXT NOT NULL DEFAULT '',    -- 'UPS' | 'FedEx' | 'USPS' | 'Other'
  tracking_number           TEXT NOT NULL DEFAULT '',
  label_file_id             UUID REFERENCES order_files(id) ON DELETE SET NULL,
  shipped_at                TIMESTAMPTZ,
  estimated_delivery        DATE,

  -- Pickup details (required before task can close when fulfillment_type='pickup')
  pickup_confirmed_at       TIMESTAMPTZ,
  pickup_confirmed_by       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  pickup_confirmed_name     TEXT NOT NULL DEFAULT '',   -- customer name who picked up

  -- Pack-out
  packed_at                 TIMESTAMPTZ,
  packed_by                 UUID REFERENCES profiles(id) ON DELETE SET NULL,
  package_count             INTEGER,
  package_notes             TEXT NOT NULL DEFAULT '',

  -- Customer notification
  tracking_sent_at          TIMESTAMPTZ,
  tracking_sent_method      TEXT NOT NULL DEFAULT '',

  -- Meta
  created_by                UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shipping_tasks_order_idx ON shipping_tasks(order_id);
CREATE INDEX shipping_tasks_status_idx ON shipping_tasks(status);

CREATE TRIGGER shipping_tasks_updated_at
  BEFORE UPDATE ON shipping_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- POST-SALE TASKS
-- Auto-created when shipping task closes. Manages thank-you, reviews, reorders.
-- ---------------------------------------------------------------------------

CREATE TABLE post_sale_tasks (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  order_id                  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id               UUID REFERENCES customers(id) ON DELETE SET NULL,
  assigned_rep              UUID REFERENCES profiles(id) ON DELETE SET NULL,
  shipping_task_id          UUID REFERENCES shipping_tasks(id) ON DELETE SET NULL,

  -- Status
  status                    post_sale_status NOT NULL DEFAULT 'pending',

  -- Thank-you
  thank_you_sent_at         TIMESTAMPTZ,
  thank_you_method          TEXT NOT NULL DEFAULT '',   -- 'email' | 'sms' | 'call'

  -- Review request
  review_requested_at       TIMESTAMPTZ,
  review_platform           TEXT NOT NULL DEFAULT '',   -- 'google' | 'yelp' | ''
  review_received           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Reorder reminder
  reorder_reminder_date     DATE,
  reorder_triggered_at      TIMESTAMPTZ,
  reorder_notes             TEXT NOT NULL DEFAULT '',

  -- Meta
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX post_sale_tasks_order_idx ON post_sale_tasks(order_id);
CREATE INDEX post_sale_tasks_status_idx ON post_sale_tasks(status);
CREATE INDEX post_sale_tasks_reorder_date_idx ON post_sale_tasks(reorder_reminder_date);

CREATE TRIGGER post_sale_tasks_updated_at
  BEFORE UPDATE ON post_sale_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: Enable RLS on all new tables
-- Policy: all authenticated users can read; creators/admins/supervisors can write
-- ---------------------------------------------------------------------------

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_sale_tasks ENABLE ROW LEVEL SECURITY;

-- Leads
CREATE POLICY "leads_read_auth" ON leads FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "leads_write_auth" ON leads FOR ALL USING (auth.role() = 'authenticated');

-- Deals
CREATE POLICY "deals_read_auth" ON deals FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "deals_write_auth" ON deals FOR ALL USING (auth.role() = 'authenticated');

-- Design tasks
CREATE POLICY "design_tasks_read_auth" ON design_tasks FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "design_tasks_write_auth" ON design_tasks FOR ALL USING (auth.role() = 'authenticated');

-- Proofs (authenticated staff write)
CREATE POLICY "proofs_read_auth" ON proofs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "proofs_write_auth" ON proofs FOR ALL USING (auth.role() = 'authenticated');

-- Proof versions: authenticated staff + anonymous token-based customer access handled at app layer
CREATE POLICY "proof_versions_read_auth" ON proof_versions FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "proof_versions_write_auth" ON proof_versions FOR ALL USING (auth.role() = 'authenticated');

-- Proof events: append-only at app layer; authenticated read
CREATE POLICY "proof_events_read_auth" ON proof_approval_events FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "proof_events_write_auth" ON proof_approval_events FOR ALL USING (auth.role() = 'authenticated');

-- Shipping tasks
CREATE POLICY "shipping_tasks_read_auth" ON shipping_tasks FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "shipping_tasks_write_auth" ON shipping_tasks FOR ALL USING (auth.role() = 'authenticated');

-- Post-sale tasks
CREATE POLICY "post_sale_tasks_read_auth" ON post_sale_tasks FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "post_sale_tasks_write_auth" ON post_sale_tasks FOR ALL USING (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- REALTIME: publish new tables
-- ---------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE deals;
ALTER PUBLICATION supabase_realtime ADD TABLE proofs;
ALTER PUBLICATION supabase_realtime ADD TABLE proof_versions;
ALTER PUBLICATION supabase_realtime ADD TABLE shipping_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE post_sale_tasks;
