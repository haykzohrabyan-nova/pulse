-- =============================================================================
-- PUL-679: Pulse V3 Foundation — Migration 012 (FIXED FOR LOCAL/REMOTE ENGINE)
-- Adds missing RBAC role enum values + production_tasks + qc_tasks tables
-- Target: Supabase/Postgres (project: pulse.bazaar-admin.com)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. RBAC — extend user_role enum with V3 roles
-- Force-breaking out of the migration transaction pool to allow instant usage
-- ---------------------------------------------------------------------------
COMMIT;

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'sdr';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'job_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ops_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'designer';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'walkin_front_desk';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'shipping';

-- Re-open transaction cleanly to execute structural tables safely
BEGIN;

-- ---------------------------------------------------------------------------
-- 2. PRODUCTION TASKS
-- ---------------------------------------------------------------------------
CREATE TYPE production_task_status AS ENUM (
  'scheduled',   
  'in_progress', 
  'complete',    
  'failed',      
  'cancelled'
);

CREATE TABLE production_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  machine_id          UUID REFERENCES machines(id) ON DELETE SET NULL,
  assigned_operator   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_by         UUID REFERENCES profiles(id) ON DELETE SET NULL, 
  status              production_task_status NOT NULL DEFAULT 'scheduled',
  run_notes           TEXT NOT NULL DEFAULT '',
  quantity_produced   INTEGER,
  waste_count         INTEGER,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX production_tasks_order_idx    ON production_tasks(order_id);
CREATE INDEX production_tasks_status_idx   ON production_tasks(status);
CREATE INDEX production_tasks_operator_idx ON production_tasks(assigned_operator);

-- Reuses the local automatic update trigger 
CREATE TRIGGER production_tasks_updated_at
  BEFORE UPDATE ON production_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 3. QC TASKS
-- ---------------------------------------------------------------------------
CREATE TYPE qc_task_status AS ENUM (
  'pending',       
  'in_inspection', 
  'passed',        
  'failed'         
);

CREATE TABLE qc_tasks (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  production_task_id      UUID REFERENCES production_tasks(id) ON DELETE SET NULL,
  assigned_qc             UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_by             UUID REFERENCES profiles(id) ON DELETE SET NULL, 
  status                  qc_task_status NOT NULL DEFAULT 'pending',
  final_count             INTEGER,
  proof_match_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  defect_notes            TEXT NOT NULL DEFAULT '',
  defect_type             TEXT NOT NULL DEFAULT '', 
  passed_at               TIMESTAMPTZ,
  failed_at               TIMESTAMPTZ,
  reprint_task_id         UUID REFERENCES production_tasks(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX qc_tasks_order_idx          ON qc_tasks(order_id);
CREATE INDEX qc_tasks_production_idx     ON qc_tasks(production_task_id);
CREATE INDEX qc_tasks_status_idx         ON qc_tasks(status);
CREATE INDEX qc_tasks_assigned_qc_idx    ON qc_tasks(assigned_qc);

CREATE TRIGGER qc_tasks_updated_at
  BEFORE UPDATE ON qc_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 4. RLS — Fixed with String Literal Castings (::text)
-- ---------------------------------------------------------------------------
ALTER TABLE production_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE qc_tasks         ENABLE ROW LEVEL SECURITY;

-- production_tasks policies
CREATE POLICY "production_tasks_select_auth"
  ON production_tasks FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "production_tasks_insert_managers"
  ON production_tasks FOR INSERT
  WITH CHECK (
    current_user_role()::text IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager')
  );

CREATE POLICY "production_tasks_update_operators"
  ON production_tasks FOR UPDATE
  USING (
    current_user_role()::text IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager')
    OR assigned_operator = auth.uid()
  );

-- qc_tasks policies
CREATE POLICY "qc_tasks_select_auth"
  ON qc_tasks FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "qc_tasks_insert_managers"
  ON qc_tasks FOR INSERT
  WITH CHECK (
    current_user_role()::text IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager')
  );

CREATE POLICY "qc_tasks_update_qc"
  ON qc_tasks FOR UPDATE
  USING (
    current_user_role()::text IN ('admin', 'supervisor', 'job_manager', 'ops_manager', 'production_manager', 'qc')
    OR assigned_qc = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 5. REALTIME — publish new tables
-- ---------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE production_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE qc_tasks;