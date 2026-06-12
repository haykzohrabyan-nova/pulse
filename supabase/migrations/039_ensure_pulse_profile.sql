-- =============================================================================
-- Fix: authenticated users with no profiles row cannot pass RLS (current_user_role() is NULL).
-- Backfill from auth.users, then expose ensure_pulse_profile() for client self-heal on login/save.
-- =============================================================================

INSERT INTO public.profiles (id, display_name, role)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
  COALESCE((u.raw_user_meta_data->>'role')::public.user_role, 'operator'::public.user_role)
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_pulse_profile()
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  u auth.users%ROWTYPE;
  row public.profiles%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO row FROM public.profiles WHERE id = uid;
  IF FOUND THEN
    RETURN row;
  END IF;

  SELECT * INTO u FROM auth.users WHERE id = uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auth user not found for current session';
  END IF;

  INSERT INTO public.profiles (id, display_name, role)
  VALUES (
    uid,
    COALESCE(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
    COALESCE((u.raw_user_meta_data->>'role')::public.user_role, 'operator'::public.user_role)
  )
  RETURNING * INTO row;

  RETURN row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_pulse_profile() TO authenticated;
