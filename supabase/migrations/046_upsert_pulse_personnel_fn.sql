-- Admin → Personnel should be the single source of truth for login.
-- When an admin saves a personnel record with a User ID, this function:
--   1. Creates the Supabase auth account if it doesn't exist yet
--      (email = first-name@bazaar-admin.com, password = User ID)
--   2. Updates the password if the User ID changes
--   3. Ensures auth.identities exists (required for email sign-in)
--   4. Upserts the profiles row (role, pulse_user_id, facility, active)
--
-- Callable via supabase.rpc('upsert_pulse_personnel', {...}) from admin only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.upsert_pulse_personnel(
  p_display_name  TEXT,
  p_role          TEXT,
  p_user_id       TEXT,
  p_facility      TEXT    DEFAULT NULL,
  p_active        BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_email    TEXT;
  v_uid      UUID;
  v_password TEXT;
  v_role     user_role;
  v_facility facility;
BEGIN
  -- ── Permission check ──────────────────────────────────────────────────────
  IF (SELECT role FROM profiles WHERE id = auth.uid()) NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'Permission denied: only admins and supervisors can manage personnel';
  END IF;

  -- ── Normalise inputs ──────────────────────────────────────────────────────
  -- Email: first word of display name, lowercase, @bazaar-admin.com
  v_email := lower(split_part(trim(p_display_name), ' ', 1)) || '@bazaar-admin.com';

  -- Password: the User ID the admin set; fall back to shared default
  v_password := COALESCE(NULLIF(trim(p_user_id), ''), 'Pulse2026!');

  -- Role: normalise hyphens → underscores for the DB enum
  v_role := replace(lower(coalesce(p_role, 'operator')), '-', '_')::user_role;

  -- Facility: only store valid enum values
  v_facility := CASE
    WHEN p_facility IN ('16th-street', 'boyd-street') THEN p_facility::facility
    ELSE NULL
  END;

  -- ── Auth user: create or update ───────────────────────────────────────────
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;

  IF v_uid IS NULL THEN
    -- Create brand-new Supabase auth account
    v_uid := gen_random_uuid();

    INSERT INTO auth.users (
      id, instance_id,
      aud, role,
      email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin
    ) VALUES (
      v_uid, '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      v_email, crypt(v_password, gen_salt('bf')),
      NOW(), NOW(), NOW(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('display_name', p_display_name, 'role', v_role::text),
      FALSE
    );

  ELSE
    -- Update password and metadata for existing user
    UPDATE auth.users
    SET encrypted_password  = crypt(v_password, gen_salt('bf')),
        raw_user_meta_data  = jsonb_build_object('display_name', p_display_name, 'role', v_role::text),
        updated_at          = NOW()
    WHERE id = v_uid;
  END IF;

  -- ── auth.identities: needed for email sign-in to work ────────────────────
  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data,
    provider, last_sign_in_at, created_at, updated_at
  )
  VALUES (
    gen_random_uuid(), v_uid, v_uid::text,
    jsonb_build_object(
      'sub',            v_uid::text,
      'email',          v_email,
      'email_verified', true,
      'phone_verified', false
    ),
    'email', NOW(), NOW(), NOW()
  )
  ON CONFLICT (provider, provider_id) DO NOTHING;

  -- ── profiles row: role + pulse_user_id ───────────────────────────────────
  INSERT INTO public.profiles (
    id, display_name, role, pulse_user_id, facility, active,
    created_at, updated_at
  )
  VALUES (
    v_uid, p_display_name, v_role,
    NULLIF(trim(p_user_id), ''),
    v_facility, p_active,
    NOW(), NOW()
  )
  ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      role         = EXCLUDED.role,
      pulse_user_id = COALESCE(EXCLUDED.pulse_user_id, profiles.pulse_user_id),
      facility     = COALESCE(EXCLUDED.facility, profiles.facility),
      active       = EXCLUDED.active,
      updated_at   = NOW();

  RETURN jsonb_build_object(
    'id',           v_uid::text,
    'email',        v_email,
    'display_name', p_display_name,
    'role',         v_role::text,
    'created',      NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND created_at < NOW() - INTERVAL '5 seconds')
  );
END;
$$;

-- Allow any authenticated Supabase user to call it
-- (the function itself checks for admin/supervisor role)
GRANT EXECUTE ON FUNCTION public.upsert_pulse_personnel TO authenticated;
