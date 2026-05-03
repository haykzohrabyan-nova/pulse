-- =============================================================================
-- PUL-679: Pulse V3 Foundation — Migration 012
-- Adds missing RBAC role enum values + production_tasks + qc_tasks tables
-- Target: Supabase/Postgres (project: pulse.bazaar-admin.com)
-- Generated: 2026-05-03
-- =============================================================================
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- If your migration runner wraps in BEGIN/COMMIT, run the ALTER TYPE
-- statements separately first (they auto-commit), then run the rest.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. RBAC — extend user_role enum with V3 roles
-- Roles already in enum: admin, supervisor, production_manager, account_manager,
--   operator, prepress, david_review, qc (added in 003)
-- Roles in auth.js ROLE_CONFIG but not in Supabase enum (closing the gap):
--   sdr, job_manager, ops_manager, designer
-- Net-new V3 roles:
--   walkin_front_desk, shipping
-- ---------------------------------------------------------------------------

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'sdr';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'job_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ops_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'designer';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'walkin_front_desk';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'shipping';

-- ---------------------------------------------------------------------------
-- 2. PRODUCTION TASKS
-- One task per press run. Linked to an order (job phase).
-- Created by Job Manager when an order moves into production.
-- Shipping cannot proceed without production + QC completion.
-- ---------------------------------------------------------------------------

CREATE TYPE production_task_status AS ENUM (
  'scheduled',   -- assigned to machine + operator, not yet started
  'in_progress', -- press running
  'complete',    -- run finished, QC task should be spawned
  'failed',      -- press issue; requires rework or reprint
  'cancelled'
);

CREATE TABLE production_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  machine_id          UUID REFERENCES machines(id) ON DELETE SET NULL,
  assigned_operator   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_by         UUID REFERENCES profiles(id) ON DELETE SET NULL, -- Job Manager

  -- Status
  status              production_task_status NOT NULL DEFAULT 'scheduled',

  -- Production notes (required on complete — app layer enforces)
  run_notes           TEXT NOT NULL DEFAULT '',
  quantity_produced   INTEGER,
  waste_count         INTEGER,

  -- Timing
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,

  -- Meta
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX production_tasks_order_idx    ON production_tasks(order_id);
CREATE INDEX production_tasks_status_idx   ON production_tasks(status);
CREATE INDEX production_tasks_operator_idx ON production_tasks(assigned_operator);

CREATE TRIGGER production_tasks_updated_at
  BEFORE UPDATE ON production_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. QC TASKS
-- First-class V3 QC workflow object. One per production run (auto-spawned).
-- Gate 7 enforcement: cannot advance to shipping without QC pass.
-- ---------------------------------------------------------------------------

CREATE TYPE qc_task_status AS ENUM (
  'pending',       -- production task complete, QC not yet started
  'in_inspection', -- QC inspector actively reviewing
  'passed',        -- QC pass logged; shipping task may be created
  'failed'         -- QC fail; triggers reprint or rework
);

CREATE TABLE qc_tasks (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  production_task_id      UUID REFERENCES production_tasks(id) ON DELETE SET NULL,
  assigned_qc             UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_by             UUID REFERENCES profiles(id) ON DELETE SET NULL, -- Job Manager / supervisor

  -- Status
  status                  qc_task_status NOT NULL DEFAULT 'pending',

  -- Inspection results (required on pass/fail — app layer enforces)
  final_count             INTEGER,
  proof_match_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  defect_notes            TEXT NOT NULL DEFAULT '',
  defect_type             TEXT NOT NULL DEFAULT '', -- color / registration / substrate / other

  -- Outcome timestamps
  passed_at               TIMESTAMPTZ,
  failed_at               TIMESTAMPTZ,

  -- Reprint link (set when QC fail triggers a new production task)
  reprint_task_id         UUID REFERENCES production_tasks(id) ON DELETE SET NULL,

  -- Meta
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX qc_tasks_order_idx          ON qc_tasks(order_id);
CREATE INDEX qc_tasks_production_idx     ON qc_tasks(production_task_id);
CREATE INDEX qc_tasks_status_idx         ON qc_tasks(status);
CREATE INDEX qc_tasks_assigned_qc_idx    ON qc_tasks(assigned_qc);

CREATE TRIGGER qc_tasks_updated_at
  BEFORE UPDATE ON qc_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS — enable and set policies on new tables
-- Pattern: all authenticated staff can read; role-appropriate write access
-- ---------------------------------------------------------------------------

ALTER TABLE production_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE qc_tasks         ENABLE ROW LEVEL SECURITY;

-- production_tasks: readable by all authenticated staff
CREATE POLICY "production_tasks_select_auth"
  ON production_tasks FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- production_tasks: insertable by job_manager, supervisor, production_manager, admin, ops_manager
CREATE POLICY "production_tasks_insert_managers"
  ON production_tasks FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager')
  );

-- production_tasks: updatable by assigned operator (own row) + managers
CREATE POLICY "production_tasks_update_operators"
  ON production_tasks FOR UPDATE
  USING (
    current_user_role() IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager')
    OR assigned_operator = auth.uid()
  );

-- qc_tasks: readable by all authenticated staff
CREATE POLICY "qc_tasks_select_auth"
  ON qc_tasks FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- qc_tasks: insertable by job_manager, supervisor, production_manager, admin, ops_manager
CREATE POLICY "qc_tasks_insert_managers"
  ON qc_tasks FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager')
  );

-- qc_tasks: updatable by assigned QC inspector (own row) + managers
CREATE POLICY "qc_tasks_update_qc"
  ON qc_tasks FOR UPDATE
  USING (
    current_user_role() IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager', 'qc')
    OR assigned_qc = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 5. REALTIME — publish new tables
-- ---------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE production_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE qc_tasks;
