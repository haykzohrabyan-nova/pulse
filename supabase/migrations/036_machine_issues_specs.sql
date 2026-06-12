-- Extend machine_issues for Report Issue page (severity, downtime, fix metadata).
-- machine_id FK may be absent after machines table rebuild (022); machine_name is the display key.

ALTER TABLE machine_issues
  ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '{}';

ALTER TABLE machine_issues
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS machine_issues_updated_at ON machine_issues;
CREATE TRIGGER machine_issues_updated_at
  BEFORE UPDATE ON machine_issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Any authenticated user can update (resolve/edit) issues they can see.
DROP POLICY IF EXISTS "machine_issues_update_authenticated" ON machine_issues;
CREATE POLICY "machine_issues_update_authenticated"
  ON machine_issues FOR UPDATE
  USING (auth.uid() IS NOT NULL);
