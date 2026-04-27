-- =============================================================================
-- PRI-236: Pulse Supabase Schema — Migration 001
-- Initial schema: enums, tables, indexes
-- Applied to: Supabase/Postgres (project: pulse.bazaar-admin.com)
-- Generated: 2026-04-27
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM (
  'admin',
  'supervisor',
  'production_manager',
  'account_manager',
  'operator',
  'prepress',
  'david_review'
);

CREATE TYPE facility AS ENUM (
  '16th-street',
  'boyd-street'
);

CREATE TYPE order_status AS ENUM (
  'new',
  'pending-review',
  'pending-confirmation',
  'waiting-approval',
  'prepress',
  'prepress-active',
  'prepress-paused',
  'in-production',
  'qc-checkout',
  'ready-to-ship',
  'shipped',
  'received',
  'on-hold',
  'completed',
  'cancelled'
);

CREATE TYPE step_status AS ENUM (
  'pending',
  'in-progress',
  'completed',
  'skipped'
);

CREATE TYPE die_status AS ENUM (
  'existing',
  'new-ordered',
  'none'
);

CREATE TYPE die_condition AS ENUM (
  'active',
  'damaged',
  'retired'
);

CREATE TYPE po_status AS ENUM (
  'draft',
  'sent',
  'confirmed',
  'shipped',
  'received',
  'cancelled'
);

CREATE TYPE invoice_status AS ENUM (
  'draft',
  'sent',
  'paid',
  'overdue',
  'cancelled'
);

CREATE TYPE file_category AS ENUM (
  'artwork',
  'proof',
  'prepress',
  'qc',
  'shipping',
  'other'
);

CREATE TYPE alert_severity AS ENUM (
  'warning',
  'critical'
);

CREATE TYPE reprint_reason AS ENUM (
  'shortage',
  'quality',
  'damage',
  'customer_request',
  'other'
);

-- ---------------------------------------------------------------------------
-- PROFILES (extends auth.users)
-- One row per authenticated user. Created on first sign-in via trigger.
-- ---------------------------------------------------------------------------

CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'operator',
  facility      facility,
  phone         TEXT,
  shift_start   TEXT,               -- e.g. "6:00 AM"
  machines      TEXT[],             -- machine names they operate
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create profile on new auth.users insert
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'operator')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ---------------------------------------------------------------------------
-- CUSTOMERS
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  company       TEXT,
  notes         TEXT,
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX customers_name_idx ON customers(name);

CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- ORDERS (Job Tickets — central entity)
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              TEXT UNIQUE NOT NULL,   -- e.g. "17901", "17901_1"
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name         TEXT NOT NULL,          -- denormalized for display
  product_type          TEXT NOT NULL,
  material              TEXT NOT NULL,
  print_type            TEXT,                   -- "Roll" | "Sheet"
  facility              facility NOT NULL,
  quantity              INTEGER,
  sheet_count           INTEGER,
  pieces_per_sheet      INTEGER,
  color_mode            TEXT,
  sides                 TEXT,
  status                order_status NOT NULL DEFAULT 'new',
  workflow_template     TEXT,
  current_step          INTEGER NOT NULL DEFAULT 0,
  due_date              DATE,
  lamination            TEXT,
  finishing             TEXT,
  has_uv                BOOLEAN NOT NULL DEFAULT FALSE,
  foil_type             TEXT,
  die_status            die_status NOT NULL DEFAULT 'none',
  is_rush               BOOLEAN NOT NULL DEFAULT FALSE,
  rush_approved_by      TEXT,
  account_manager       TEXT,
  rep                   TEXT,
  -- Reprint tracking
  is_reprint            BOOLEAN NOT NULL DEFAULT FALSE,
  reprint_of_order_id   TEXT,
  reprint_reason        reprint_reason,
  reprint_requested_by  TEXT,
  reprint_notes         TEXT,
  -- Hold tracking
  hold_reason           TEXT,
  hold_previous_status  order_status,
  hold_requested_by     TEXT,
  -- Shortage
  material_shortage         BOOLEAN NOT NULL DEFAULT FALSE,
  material_shortage_details TEXT,
  -- Metadata
  created_by            UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_status_idx        ON orders(status);
CREATE INDEX orders_facility_idx      ON orders(facility);
CREATE INDEX orders_customer_id_idx   ON orders(customer_id);
CREATE INDEX orders_due_date_idx      ON orders(due_date);
CREATE INDEX orders_created_at_idx    ON orders(created_at DESC);
CREATE INDEX orders_order_id_idx      ON orders(order_id);
CREATE INDEX orders_is_reprint_idx    ON orders(is_reprint);

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- ORDER WORKFLOW STEPS
-- Tracks each production step for an order
-- ---------------------------------------------------------------------------

CREATE TABLE order_workflow_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL,
  machine       TEXT NOT NULL,
  operation     TEXT,
  status        step_status NOT NULL DEFAULT 'pending',
  operator_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  operator_name TEXT,              -- denormalized
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, step_index)
);

CREATE INDEX order_workflow_steps_order_id_idx ON order_workflow_steps(order_id);
CREATE INDEX order_workflow_steps_status_idx   ON order_workflow_steps(status);

CREATE TRIGGER order_workflow_steps_updated_at
  BEFORE UPDATE ON order_workflow_steps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- ORDER STATUS HISTORY
-- Full audit trail of every status change
-- ---------------------------------------------------------------------------

CREATE TABLE order_status_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status   order_status,
  to_status     order_status NOT NULL,
  changed_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  changed_by_name TEXT,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_status_history_order_id_idx ON order_status_history(order_id);
CREATE INDEX order_status_history_created_at_idx ON order_status_history(created_at DESC);

-- ---------------------------------------------------------------------------
-- ORDER FILES (R2 metadata)
-- Stores file metadata; actual bytes live in Cloudflare R2 private bucket
-- ---------------------------------------------------------------------------

CREATE TABLE order_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category      file_category NOT NULL DEFAULT 'artwork',
  filename      TEXT NOT NULL,
  r2_key        TEXT NOT NULL UNIQUE,   -- bucket key for presigned URL generation
  content_type  TEXT,
  size_bytes    BIGINT,
  uploaded_by   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_files_order_id_idx  ON order_files(order_id);
CREATE INDEX order_files_category_idx  ON order_files(category);

-- ---------------------------------------------------------------------------
-- ORDER COMMENTS
-- Threaded per-order discussion
-- ---------------------------------------------------------------------------

CREATE TABLE order_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_comments_order_id_idx ON order_comments(order_id);
CREATE INDEX order_comments_created_at_idx ON order_comments(created_at DESC);

CREATE TRIGGER order_comments_updated_at
  BEFORE UPDATE ON order_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- ACTIVITY LOG
-- Full immutable audit trail for orders
-- ---------------------------------------------------------------------------

CREATE TABLE activity_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  details       JSONB,
  actor_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  actor_name    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX activity_log_order_id_idx   ON activity_log(order_id);
CREATE INDEX activity_log_actor_id_idx   ON activity_log(actor_id);
CREATE INDEX activity_log_created_at_idx ON activity_log(created_at DESC);
CREATE INDEX activity_log_action_idx     ON activity_log(action);

-- ---------------------------------------------------------------------------
-- MACHINES
-- ---------------------------------------------------------------------------

CREATE TABLE machines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  facility      facility NOT NULL,
  operations    TEXT[],
  products      TEXT[],
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX machines_facility_idx ON machines(facility);

CREATE TRIGGER machines_updated_at
  BEFORE UPDATE ON machines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- MACHINE ISSUES (Downtime log)
-- ---------------------------------------------------------------------------

CREATE TABLE machine_issues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id    UUID REFERENCES machines(id) ON DELETE SET NULL,
  machine_name  TEXT NOT NULL,
  description   TEXT NOT NULL,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  reported_by   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reported_by_name TEXT,
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX machine_issues_machine_id_idx ON machine_issues(machine_id);
CREATE INDEX machine_issues_resolved_at_idx ON machine_issues(resolved_at);

-- ---------------------------------------------------------------------------
-- WORKFLOW TEMPLATES
-- Predefined production paths (e.g., "15k-box-die")
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT UNIQUE NOT NULL,
  label         TEXT NOT NULL,
  facility      facility,
  product_types TEXT[],
  steps         JSONB NOT NULL DEFAULT '[]',   -- [{machine, operation, optional}]
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER workflow_templates_updated_at
  BEFORE UPDATE ON workflow_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- DIES (Die Registry)
-- ---------------------------------------------------------------------------

CREATE TABLE dies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  die_number    TEXT UNIQUE NOT NULL,
  barcode       TEXT UNIQUE NOT NULL,
  customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  machine       TEXT NOT NULL,
  description   TEXT,
  condition     die_condition NOT NULL DEFAULT 'active',
  usage_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX dies_customer_id_idx ON dies(customer_id);
CREATE INDEX dies_machine_idx     ON dies(machine);
CREATE INDEX dies_condition_idx   ON dies(condition);

CREATE TRIGGER dies_updated_at
  BEFORE UPDATE ON dies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- OPERATOR SESSIONS (Time tracking / CA labor law compliance)
-- ---------------------------------------------------------------------------

CREATE TABLE operator_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  operator_name   TEXT NOT NULL,
  session_date    DATE NOT NULL,
  clock_in        TIMESTAMPTZ NOT NULL,
  clock_out       TIMESTAMPTZ,
  total_work_minutes INTEGER,
  violation_flag  BOOLEAN NOT NULL DEFAULT FALSE,
  points_earned   INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX operator_sessions_operator_id_idx ON operator_sessions(operator_id);
CREATE INDEX operator_sessions_date_idx        ON operator_sessions(session_date DESC);

CREATE TRIGGER operator_sessions_updated_at
  BEFORE UPDATE ON operator_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- OPERATOR BREAKS (Per session, California meal/rest break tracking)
-- ---------------------------------------------------------------------------

CREATE TABLE operator_breaks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES operator_sessions(id) ON DELETE CASCADE,
  break_type    TEXT NOT NULL CHECK (break_type IN ('rest1','meal1','rest2','meal2')),
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX operator_breaks_session_id_idx ON operator_breaks(session_id);

-- ---------------------------------------------------------------------------
-- OPERATOR POINTS (Gamification / reward coins)
-- ---------------------------------------------------------------------------

CREATE TABLE operator_points (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  operator_name TEXT NOT NULL,
  earned_date   DATE NOT NULL,
  points        INTEGER NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX operator_points_operator_id_idx ON operator_points(operator_id);
CREATE INDEX operator_points_earned_date_idx  ON operator_points(earned_date DESC);

-- ---------------------------------------------------------------------------
-- MATERIALS (Reference catalog)
-- ---------------------------------------------------------------------------

CREATE TABLE materials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  facility      facility NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'sheets',  -- sheets, rolls, sq-ft, etc.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX materials_name_facility_idx ON materials(name, facility);

-- ---------------------------------------------------------------------------
-- INVENTORY (Stock levels per material per facility)
-- ---------------------------------------------------------------------------

CREATE TABLE inventory (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id         UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  facility            facility NOT NULL,
  quantity_on_hand    NUMERIC NOT NULL DEFAULT 0,
  reorder_point       NUMERIC NOT NULL DEFAULT 0,
  last_restocked_at   TIMESTAMPTZ,
  last_po             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(material_id, facility)
);

CREATE TRIGGER inventory_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- INVENTORY USAGE (History per order)
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id    UUID NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  quantity_used   NUMERIC NOT NULL,
  used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_by         UUID REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX inventory_usage_inventory_id_idx ON inventory_usage(inventory_id);
CREATE INDEX inventory_usage_order_id_idx     ON inventory_usage(order_id);

-- ---------------------------------------------------------------------------
-- PURCHASE ORDERS (Vendor restock)
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number       TEXT UNIQUE NOT NULL,
  vendor          TEXT NOT NULL,
  status          po_status NOT NULL DEFAULT 'draft',
  expected_date   DATE,
  actual_date     DATE,
  received_by     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  received_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX purchase_orders_status_idx ON purchase_orders(status);
CREATE INDEX purchase_orders_vendor_idx ON purchase_orders(vendor);

CREATE TRIGGER purchase_orders_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- PURCHASE ORDER ITEMS
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_id     UUID REFERENCES materials(id) ON DELETE SET NULL,
  material_name   TEXT NOT NULL,
  quantity        NUMERIC NOT NULL,
  unit            TEXT NOT NULL,
  unit_cost       NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX purchase_order_items_po_id_idx ON purchase_order_items(po_id);

-- ---------------------------------------------------------------------------
-- QC RECORDS
-- One per order when it passes through qc-checkout
-- ---------------------------------------------------------------------------

CREATE TABLE qc_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  inspector_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  inspector_name  TEXT NOT NULL,
  passed          BOOLEAN NOT NULL,
  quantity_checked INTEGER,
  defects_found   TEXT,
  notes           TEXT,
  inspected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX qc_records_order_id_idx ON qc_records(order_id);

-- ---------------------------------------------------------------------------
-- INVOICES
-- ---------------------------------------------------------------------------

CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  TEXT UNIQUE NOT NULL,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  status          invoice_status NOT NULL DEFAULT 'draft',
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax             NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  due_date        DATE,
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX invoices_order_id_idx     ON invoices(order_id);
CREATE INDEX invoices_customer_id_idx  ON invoices(customer_id);
CREATE INDEX invoices_status_idx       ON invoices(status);

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- INVOICE LINE ITEMS
-- ---------------------------------------------------------------------------

CREATE TABLE invoice_line_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 1,
  unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX invoice_line_items_invoice_id_idx ON invoice_line_items(invoice_id);

-- ---------------------------------------------------------------------------
-- KNOWLEDGE BASE (Machine-specific operator alerts)
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge_base (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine       TEXT,                -- null = all machines
  machines      TEXT[],              -- alternative: multiple machines
  material      TEXT,                -- null = all materials
  operation     TEXT,                -- null = all operations
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  fix           TEXT,
  severity      alert_severity NOT NULL DEFAULT 'warning',
  operators     TEXT[],              -- empty = applies to all
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX knowledge_base_machine_idx   ON knowledge_base(machine);
CREATE INDEX knowledge_base_severity_idx  ON knowledge_base(severity);
CREATE INDEX knowledge_base_active_idx    ON knowledge_base(active);

CREATE TRIGGER knowledge_base_updated_at
  BEFORE UPDATE ON knowledge_base
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- CONFIG (App-level key/value settings)
-- ---------------------------------------------------------------------------

CREATE TABLE config (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL DEFAULT '{}',
  updated_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
