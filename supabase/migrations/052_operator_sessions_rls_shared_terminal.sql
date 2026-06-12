-- Fix operator_sessions RLS for shared terminal use.
-- Original policies required operator_id = auth.uid() on INSERT/UPDATE/SELECT,
-- but the terminal is a shared device: multiple operators clock in under a
-- single authenticated session (e.g. the "operator" or "admin" Supabase login).
-- The operator_id column is still populated when available for audit purposes.

-- INSERT: any authenticated user may create a session
DROP POLICY IF EXISTS "operator_sessions_insert_self" ON public.operator_sessions;
CREATE POLICY "operator_sessions_insert_authenticated"
  ON public.operator_sessions FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- SELECT: authenticated users see all sessions (terminal needs to list today's)
DROP POLICY IF EXISTS "operator_sessions_select_self" ON public.operator_sessions;
CREATE POLICY "operator_sessions_select_authenticated"
  ON public.operator_sessions FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- UPDATE: authenticated users may update any session (clock-out, breaks, notes)
DROP POLICY IF EXISTS "operator_sessions_update_self" ON public.operator_sessions;
CREATE POLICY "operator_sessions_update_authenticated"
  ON public.operator_sessions FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- Keep the admin/supervisor policy as-is (already less restrictive than above,
-- but harmless to leave since the new policies cover everything they need).
