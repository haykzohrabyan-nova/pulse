-- =============================================================================
-- Personnel User ID + admin access for profiles (login ↔ Admin Personnel sync)
-- pulse_user_id is the numeric PIN shown on the login screen (Name + User ID).
-- Run in Supabase SQL Editor after prior migrations.
-- =============================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pulse_user_id TEXT;

CREATE INDEX IF NOT EXISTS profiles_pulse_user_id_idx
  ON profiles (pulse_user_id)
  WHERE pulse_user_id IS NOT NULL AND pulse_user_id <> '';

-- Backfill baseline operator User IDs (matches OPERATOR_PROFILES in shared.js)
UPDATE profiles p SET pulse_user_id = v.uid
FROM (VALUES
  ('Arsen',     '1001'),
  ('Tuoyo',     '1002'),
  ('Mauricio',  '1003'),
  ('Abel',      '1004'),
  ('Juan',      '1005'),
  ('Vahe',      '1006'),
  ('Hrach',     '1007'),
  ('Avgustin',  '1008'),
  ('Jaime',     '1009'),
  ('Lisandro',  '1010'),
  ('Adrian',    '1011'),
  ('Harry',     '1012'),
  ('Mike',      '1013')
) AS v(display_name, uid)
WHERE p.display_name = v.display_name
  AND (p.pulse_user_id IS NULL OR p.pulse_user_id = '');

-- Admin + David Review can list all profiles (Personnel tab + login dropdown)
DROP POLICY IF EXISTS "profiles_select_admin" ON profiles;
CREATE POLICY "profiles_select_admin"
  ON profiles FOR SELECT
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review'
    )
  );

-- Admin + David Review can edit personnel fields (User ID, role, facility, etc.)
DROP POLICY IF EXISTS "profiles_update_admin" ON profiles;
CREATE POLICY "profiles_update_admin"
  ON profiles FOR UPDATE
  USING (current_user_role() IN ('admin', 'david_review'));

-- David Review can read/write config (legacy personnel JSON during transition)
DROP POLICY IF EXISTS "config_update_admin" ON config;
CREATE POLICY "config_update_admin"
  ON config FOR UPDATE
  USING (current_user_role() IN ('admin', 'david_review'));

DROP POLICY IF EXISTS "config_insert_admin" ON config;
CREATE POLICY "config_insert_admin"
  ON config FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'david_review'));
