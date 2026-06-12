-- Migrate personnel login-email domain: @bazaar-admin.com → @bazaarprinting.com
--
-- Login emails are auto-derived from the first name (first@<domain>). This
-- migration:
--   1. Renames every existing auth.users / auth.identities email to the new
--      domain (passwords/User IDs are unchanged, so logins keep working).
--   2. Recreates upsert_pulse_personnel() so newly-added personnel get the new
--      domain too.
-- Idempotent: safe to re-run.

-- ── 1. Rename existing login accounts ─────────────────────────────────────────
UPDATE auth.users
SET email = replace(email, '@bazaar-admin.com', '@bazaarprinting.com'),
    updated_at = now()
WHERE email LIKE '%@bazaar-admin.com';

-- Keep the identity record's email in sync (provider_id stays the user UUID).
UPDATE auth.identities
SET identity_data = jsonb_set(
      identity_data,
      '{email}',
      to_jsonb(replace(identity_data->>'email', '@bazaar-admin.com', '@bazaarprinting.com'))
    ),
    updated_at = now()
WHERE identity_data->>'email' LIKE '%@bazaar-admin.com';

-- ── 2. New personnel use the new domain ───────────────────────────────────────
DROP FUNCTION IF EXISTS public.upsert_pulse_personnel(TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID);

CREATE OR REPLACE FUNCTION public.upsert_pulse_personnel(
  p_display_name  TEXT,
  p_role          TEXT,
  p_user_id       TEXT,
  p_facility      TEXT    DEFAULT NULL,
  p_active        BOOLEAN DEFAULT true,
  p_profile_id    UUID    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_email         TEXT;
  v_uid           UUID;
  v_existing_uid  UUID;
  v_password      TEXT;
  v_role          user_role;
  v_facility      facility;
  v_created         BOOLEAN;
BEGIN
  IF (SELECT role FROM profiles WHERE id = auth.uid()) NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'Permission denied: only admins and supervisors can manage personnel';
  END IF;

  v_email := lower(split_part(trim(p_display_name), ' ', 1)) || '@bazaarprinting.com';
  v_password := COALESCE(NULLIF(trim(p_user_id), ''), 'Pulse2026!');
  v_role := replace(lower(coalesce(p_role, 'operator')), '-', '_')::user_role;
  v_facility := CASE
    WHEN p_facility IN ('16th-street', 'boyd-street') THEN p_facility::facility
    ELSE NULL
  END;

  SELECT id INTO v_existing_uid FROM auth.users WHERE email = v_email;

  IF p_profile_id IS NULL THEN
    IF v_existing_uid IS NOT NULL THEN
      RAISE EXCEPTION 'EMAIL_ALREADY_EXISTS: Login email % is already registered. Use a different first name in the display name.', v_email;
    END IF;

    v_uid := gen_random_uuid();
    v_created := true;

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
    IF v_existing_uid IS NOT NULL AND v_existing_uid <> p_profile_id THEN
      RAISE EXCEPTION 'EMAIL_ALREADY_EXISTS: Login email % is already used by another account.', v_email;
    END IF;

    v_uid := p_profile_id;
    v_created := false;

    IF v_existing_uid IS NULL THEN
      UPDATE auth.users
      SET email = v_email,
          encrypted_password = crypt(v_password, gen_salt('bf')),
          raw_user_meta_data = jsonb_build_object('display_name', p_display_name, 'role', v_role::text),
          updated_at = NOW()
      WHERE id = v_uid;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Personnel auth account not found for profile %', p_profile_id;
      END IF;
    ELSE
      UPDATE auth.users
      SET encrypted_password = crypt(v_password, gen_salt('bf')),
          raw_user_meta_data = jsonb_build_object('display_name', p_display_name, 'role', v_role::text),
          updated_at = NOW()
      WHERE id = v_uid;
    END IF;
  END IF;

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
    'created',      v_created
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_pulse_personnel(TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID) TO authenticated;

-- ── Post-check ────────────────────────────────────────────────────────────────
SELECT 'migrated emails' AS check, email
FROM auth.users
WHERE email LIKE '%@bazaarprinting.com'
ORDER BY email;
