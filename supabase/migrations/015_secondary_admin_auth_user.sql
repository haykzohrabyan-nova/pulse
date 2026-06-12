-- Force Postgres to check extensions schema for crypto tools natively
SELECT set_config('search_path', 'public,extensions,auth', false);

INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin,
  created_at, updated_at,
  confirmation_token, recovery_token,
  email_change_token_new, email_change,
  phone, phone_confirmed_at, phone_change, phone_change_token,
  email_change_token_current, email_change_confirm_status,
  banned_until, reauthentication_token
)
VALUES (
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'admin@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Admin","role":"admin"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
);