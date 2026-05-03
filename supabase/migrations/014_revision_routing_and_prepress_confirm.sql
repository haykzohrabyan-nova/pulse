-- ============================================================
-- Migration 014 — PUL-680 W3-W4 Gap Fixes
-- 1. revision_count on proofs (KPI tracking per CEO spec)
-- 2. Auto-routing trigger: proof revision_requested → design_task revision
-- 3. prepress_confirmed_at / prepress_confirmed_by on production_tasks
-- 4. RLS update for prepress role on production_tasks
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1. REVISION COUNT on proofs
-- Tracks how many revision cycles a job has gone through.
-- KPI source: "Revision count tracked per Job."
-- ---------------------------------------------------------------------------
ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. PREPRESS RECEIPT CONFIRMATION columns on production_tasks
-- Prepress must confirm file received + ready for press through Pulse.
-- ---------------------------------------------------------------------------
ALTER TABLE production_tasks
  ADD COLUMN IF NOT EXISTS prepress_confirmed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prepress_confirmed_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prepress_issue_notes   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS prepress_issue_at      TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. AUTO-ROUTING TRIGGER
-- When proofs.status changes to 'revision_requested':
--   a) Increment proofs.revision_count
--   b) Set design_tasks.status = 'revision' for the linked task
--      (uses proofs.design_task_id if present, falls back to order_id lookup)
-- This fires for both customer-portal revisions (token-based) AND JM-logged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION route_revision_to_designer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only fire when transitioning INTO revision_requested
  IF NEW.status = 'revision_requested' AND (OLD.status IS DISTINCT FROM 'revision_requested') THEN

    -- Increment revision_count on the proof record
    UPDATE proofs
       SET revision_count = revision_count + 1
     WHERE id = NEW.id;

    -- Update the linked design task to 'revision' status
    -- Prefer design_task_id direct FK; fall back to order_id lookup
    IF NEW.design_task_id IS NOT NULL THEN
      UPDATE design_tasks
         SET status = 'revision', updated_at = NOW()
       WHERE id = NEW.design_task_id
         AND status NOT IN ('done', 'revision');  -- don't re-trigger if already there
    ELSE
      UPDATE design_tasks
         SET status = 'revision', updated_at = NOW()
       WHERE order_id = NEW.order_id
         AND status NOT IN ('done', 'revision');
    END IF;

  END IF;
  RETURN NEW;
END;
$$;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS trg_route_revision_to_designer ON proofs;

CREATE TRIGGER trg_route_revision_to_designer
  AFTER UPDATE OF status ON proofs
  FOR EACH ROW
  EXECUTE FUNCTION route_revision_to_designer();

-- ---------------------------------------------------------------------------
-- 4. RLS: allow prepress role to update production_tasks
--    (confirm receipt, report issues on their own scheduled tasks)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "production_tasks_update_prepress" ON production_tasks;

CREATE POLICY "production_tasks_update_prepress"
  ON production_tasks FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
-- Note: The existing "production_tasks_update_operators" policy covers
-- auth.role() = 'authenticated' — this is belt-and-suspenders for prepress.
-- In a stricter setup, add a profile role check here.

-- ---------------------------------------------------------------------------
-- 5. REALTIME
-- ---------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE production_tasks;
-- Note: production_tasks was already added in 012; this is a no-op if duplicate.
