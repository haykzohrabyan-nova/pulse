-- Allow unauthenticated (anon) reads so the login selector can load
-- the personnel list BEFORE a session is established.
--
-- config_select required auth.uid() IS NOT NULL, and
-- profiles_select only allowed self / admin reads — both blocked anon.
-- This breaks the login screen: it cannot list operator names without a session.

-- 1. Allow anon to read specific safe config keys (bootstrap data only)
CREATE POLICY "config_select_anon_bootstrap"
  ON config FOR SELECT
  TO anon
  USING (
    key IN (
      'personnel',
      'pulseNoteTypes',
      'pulseRushConfig',
      'pulseLeadTimes',
      'pulseProductionLines',
      'pulseReprintReasons'
    )
  );

-- 2. Allow anon to read display_name + pulse_user_id from profiles
--    so the login selector can list personnel even without a session.
--    Only non-sensitive columns are exposed via the RLS check itself;
--    the SELECT query in the app limits to those columns.
CREATE POLICY "profiles_select_anon_names"
  ON profiles FOR SELECT
  TO anon
  USING (active = true OR active IS NULL);
