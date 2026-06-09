-- STEP 2 of 2 — Run AFTER 047a_user_role_david_review.sql (separate SQL Editor Run).
--
-- Creates david@bazaar-admin.com + profiles row (david_review, User ID 1111).
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Preflight ─────────────────────────────────────────────────────────────
SELECT 'auth.users david@bazaar-admin.com' AS check,
       u.id, u.email, u.created_at
FROM auth.users u
WHERE u.email = 'david@bazaar-admin.com';

SELECT 'profiles David' AS check,
       p.id, p.display_name, p.role::text, p.pulse_user_id, p.active
FROM public.profiles p
WHERE lower(p.display_name) LIKE '%david%';

-- ── Require enum from step 1 ───────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'david_review'
  ) THEN
    RAISE EXCEPTION 'Missing enum value david_review. Run 047a_user_role_david_review.sql first, then run this file again.';
  END IF;
END $$;

-- ── Create / repair auth user + profile ───────────────────────────────────
DO $$
DECLARE
  v_uid      UUID;
  v_email    TEXT := 'david@bazaar-admin.com';
  v_password TEXT := '1111';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;

  IF v_uid IS NULL THEN
    v_uid := gen_random_uuid();

    -- operator in metadata: handle_new_user() trigger accepts it; we set david_review on profiles below.
    INSERT INTO auth.users (
      instance_id, id, aud, role, email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin,
      created_at, updated_at,
      confirmation_token, recovery_token,
      email_change_token_new, email_change,
      phone, phone_confirmed_at, phone_change, phone_change_token,
      email_change_token_current, email_change_confirm_status,
      banned_until, reauthentication_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_uid,
      'authenticated', 'authenticated',
      v_email, crypt(v_password, gen_salt('bf')),
      NOW(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"display_name":"David Zargaryan","role":"operator"}'::jsonb,
      FALSE, NOW(), NOW(),
      '', '', '', '',
      NULL, NULL, '', '',
      '', 0,
      NULL, ''
    );

    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data,
      provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_uid, v_uid::text,
      jsonb_build_object(
        'sub', v_uid::text,
        'email', v_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email', NOW(), NOW(), NOW()
    )
    ON CONFLICT (provider, provider_id) DO NOTHING;
  END IF;

  INSERT INTO public.profiles (
    id, display_name, role, pulse_user_id, active, created_at, updated_at
  ) VALUES (
    v_uid, 'David Zargaryan', 'david_review'::public.user_role, '1111', true, NOW(), NOW()
  )
  ON CONFLICT (id) DO UPDATE
  SET display_name  = EXCLUDED.display_name,
      role          = 'david_review'::public.user_role,
      pulse_user_id = COALESCE(NULLIF(EXCLUDED.pulse_user_id, ''), profiles.pulse_user_id),
      active        = true,
      updated_at    = NOW();
END $$;

-- ── Post-check ──────────────────────────────────────────────────────────────
SELECT 'after migration' AS check,
       u.email,
       p.display_name,
       p.role::text,
       p.pulse_user_id,
       p.active
FROM auth.users u
JOIN public.profiles p ON p.id = u.id
WHERE u.email = 'david@bazaar-admin.com';
