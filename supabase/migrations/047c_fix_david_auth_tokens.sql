-- STEP 3 — Fix David auth sign-in after 047b (run once if login says "Database error querying schema").
--
-- Manual auth.users inserts must set token columns to '' not NULL (Supabase GoTrue requirement).
-- See: https://github.com/supabase/auth/issues/1940

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Repair NULL token columns on any SQL-seeded bazaar-admin accounts (not just David).
UPDATE auth.users
SET confirmation_token          = COALESCE(confirmation_token, ''),
    recovery_token              = COALESCE(recovery_token, ''),
    email_change_token_new      = COALESCE(email_change_token_new, ''),
    email_change                = COALESCE(email_change, ''),
    email_change_token_current  = COALESCE(email_change_token_current, ''),
    email_change_confirm_status = COALESCE(email_change_confirm_status, 0),
    email_confirmed_at          = COALESCE(email_confirmed_at, NOW()),
    updated_at                  = NOW()
WHERE email LIKE '%@bazaar-admin.com'
  AND (
    confirmation_token IS NULL
    OR recovery_token IS NULL
    OR email_change_token_new IS NULL
    OR email_change IS NULL
  );

-- Ensure David password = User ID 1111
UPDATE auth.users
SET encrypted_password = crypt('1111', gen_salt('bf')),
    email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
    raw_user_meta_data = jsonb_build_object('display_name', 'David Zargaryan', 'role', 'operator'),
    updated_at         = NOW()
WHERE email = 'david@bazaar-admin.com';

-- Ensure auth.identities row (required for email sign-in)
INSERT INTO auth.identities (
  id, user_id, provider_id, identity_data,
  provider, last_sign_in_at, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  u.id,
  u.id::text,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  NOW(), NOW(), NOW()
FROM auth.users u
WHERE u.email = 'david@bazaar-admin.com'
  AND NOT EXISTS (
    SELECT 1 FROM auth.identities i
    WHERE i.user_id = u.id AND i.provider = 'email'
  );

-- Profile must match auth user id + david_review role
INSERT INTO public.profiles (
  id, display_name, role, pulse_user_id, active, created_at, updated_at
)
SELECT
  u.id, 'David Zargaryan', 'david_review'::public.user_role, '1111', true, NOW(), NOW()
FROM auth.users u
WHERE u.email = 'david@bazaar-admin.com'
ON CONFLICT (id) DO UPDATE
SET display_name  = EXCLUDED.display_name,
    role          = 'david_review'::public.user_role,
    pulse_user_id = '1111',
    active        = true,
    updated_at    = NOW();

SELECT 'david auth repair' AS check,
       u.id,
       u.email,
       u.confirmation_token IS NOT NULL AS has_confirmation_token,
       u.recovery_token IS NOT NULL AS has_recovery_token,
       (SELECT count(*) FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email') AS identity_rows,
       p.role::text,
       p.pulse_user_id
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE u.email = 'david@bazaar-admin.com';
