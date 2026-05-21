-- 1. Ensure 'qc' is dynamically added to user_role outside transaction blocks if missing
COMMIT;

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'qc';

-- 2. Force Postgres to recognize the new type globally before running policies
SELECT set_config('search_path', 'public,extensions', false);

-- 3. Re-open a transaction block cleanly for the rest of the file
BEGIN;

-- SELECT
DROP POLICY IF EXISTS "qc_records_select_qc" ON qc_records;
CREATE POLICY "qc_records_select_qc"
  ON qc_records FOR SELECT
  USING (current_user_role()::text = 'qc');

-- INSERT
DROP POLICY IF EXISTS "qc_records_insert_qc" ON qc_records;
CREATE POLICY "qc_records_insert_qc"
  ON qc_records FOR INSERT
  WITH CHECK (current_user_role()::text = 'qc');