-- =============================================================================
-- PRI-238: D3 — Pulse team auth users seed
-- Seeds all current Pulse team members into auth.users with temporary passwords.
-- The handle_new_user trigger (from 001) auto-creates the matching profiles row.
-- Follow-up UPDATE statements fill in facility + machines per operator profile.
--
-- IMPORTANT: Run this AFTER migrations 001–007.
--
-- TEMP PASSWORD for all accounts: Pulse2026!
-- Hayk MUST distribute passwords and have each user change theirs on first login.
-- Supabase Dashboard → Authentication → Users → click user → "Send password reset"
--
-- QC ROLE NOTE:
-- A placeholder account qc@bazaar-admin.com is created with display_name
-- "QC Inspector". Hayk must confirm the actual person, then update via:
--   UPDATE profiles SET display_name = '<real name>'
--   FROM auth.users WHERE auth.users.email = 'qc@bazaar-admin.com'
--     AND profiles.id = auth.users.id;
-- Or rename the auth user email in the Supabase Dashboard.
--
-- PART 1 ALSO FIXES a bug in migration 003:
-- 'qc-failed' is not in the order_status enum — that policy would fail to apply.
-- We drop and recreate both QC orders policies using only valid enum values.
-- =============================================================================

-- Enable pgcrypto for password hashing (idempotent)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- PART 1: Fix broken QC orders policies from migration 003
-- (DROP is safe — if 003 failed to apply the policy, DROP IF EXISTS is a no-op)
-- =============================================================================

DROP POLICY IF EXISTS "orders_select_qc" ON orders;
DROP POLICY IF EXISTS "orders_update_qc"  ON orders;

-- QC role sees orders currently at the QC inspection stage
CREATE POLICY "orders_select_qc"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'qc'
    AND status IN ('qc-checkout')
  );

-- QC role can advance orders from qc-checkout → ready-to-ship or on-hold
CREATE POLICY "orders_update_qc"
  ON orders FOR UPDATE
  USING (
    current_user_role() = 'qc'
    AND status = 'qc-checkout'
  );

-- =============================================================================
-- PART 2: Seed team auth users
-- All accounts use temp password: Pulse2026!
-- ON CONFLICT (email) DO NOTHING makes this idempotent.
-- =============================================================================

INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password,
  email_confirmed_at, confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin,
  created_at, updated_at,
  confirmation_token, recovery_token,
  email_change_token_new, email_change,
  phone, phone_confirmed_at, phone_change, phone_change_token,
  email_change_token_current, email_change_confirm_status,
  banned_until, reauthentication_token
)
VALUES

-- ── ADMIN ──────────────────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'hayk@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Hayk Zohrabyan","role":"admin"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── DAVID REVIEW ───────────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'david@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"David Zargaryan","role":"david_review"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── SUPERVISORS ────────────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'mauricio@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Mauricio","role":"supervisor"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'tigran@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Tigran Zohrabyan","role":"supervisor"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── PRODUCTION MANAGER ─────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'mike@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Mike","role":"production_manager"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── PREPRESS ───────────────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'hrach@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Hrach","role":"prepress"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── ACCOUNT MANAGERS ───────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'gary@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Gary Gharibyan","role":"account_manager"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'ernesto@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Ernesto Flores","role":"account_manager"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'bob@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Bob Werner","role":"account_manager"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'tiko@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Tiko","role":"account_manager"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── OPERATORS ──────────────────────────────────────────────────────────────
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'arsen@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Arsen","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'tuoyo@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Tuoyo","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'abel@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Abel","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'juan@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Juan","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'vahe@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Vahe","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'avgustin@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Avgustin","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'jaime@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Jaime","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'lisandro@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Lisandro","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'adrian@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Adrian","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'harry@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Harry","role":"operator"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
),

-- ── QC INSPECTOR (placeholder — Hayk must confirm actual person) ────────────
-- !! ACTION REQUIRED: Update display_name once Hayk confirms who fills the QC role.
-- !! See comment at top of this file for update instructions.
(
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated',
  'qc@bazaar-admin.com',
  crypt('Pulse2026!', gen_salt('bf')),
  NOW(), NOW(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"QC Inspector","role":"qc"}',
  FALSE, NOW(), NOW(),
  '', '', '', '', NULL, NULL, '', '', '', 0, NULL, ''
)

ON CONFLICT (email) DO NOTHING;

-- =============================================================================
-- PART 3: Update profiles with facility and machines
-- The trigger only sets display_name + role. These UPDATE statements fill in
-- the remaining profile fields from the OPERATOR_PROFILES baseline.
-- =============================================================================

-- Arsen — Boyd Street, all wide-format machines
UPDATE profiles p
SET
  facility = 'boyd-street',
  machines = ARRAY[
    'Canon Colorado',
    'Roland (CMYK+White)',
    'Roland (CMYK)',
    'Graphtec Vinyl x4',
    'Graphtec Flatbed (Large) x2',
    'Graphtec Flatbed (Small)',
    'Laminator (Boyd)'
  ]
FROM auth.users u
WHERE u.email = 'arsen@bazaar-admin.com' AND p.id = u.id;

-- Tuoyo — 16th Street, HP Indigo 15K (afternoon shift)
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['HP Indigo 15K']
FROM auth.users u
WHERE u.email = 'tuoyo@bazaar-admin.com' AND p.id = u.id;

-- Abel — 16th Street, Scodix + 15K backup
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['Scodix', 'HP Indigo 15K']
FROM auth.users u
WHERE u.email = 'abel@bazaar-admin.com' AND p.id = u.id;

-- Juan — 16th Street, HP Indigo 6K
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['HP Indigo 6K']
FROM auth.users u
WHERE u.email = 'juan@bazaar-admin.com' AND p.id = u.id;

-- Vahe — 16th Street, GM Die + Laser Cutter
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['GM Die Cutter', 'GM Laser Cutter']
FROM auth.users u
WHERE u.email = 'vahe@bazaar-admin.com' AND p.id = u.id;

-- Avgustin — 16th Street, Moll Folder-Gluer
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['Moll Folder-Gluer']
FROM auth.users u
WHERE u.email = 'avgustin@bazaar-admin.com' AND p.id = u.id;

-- Jaime — 16th Street, Moll Cutter
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['Moll Cutter']
FROM auth.users u
WHERE u.email = 'jaime@bazaar-admin.com' AND p.id = u.id;

-- Lisandro — 16th Street, Laminator + Duplo + Guillotine
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['Laminator (Nobelus)', 'Duplo', 'Guillotine Cutter']
FROM auth.users u
WHERE u.email = 'lisandro@bazaar-admin.com' AND p.id = u.id;

-- Adrian — 16th Street, Karlville Poucher + Laminator backup
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['Karlville Poucher', 'Laminator (Nobelus)']
FROM auth.users u
WHERE u.email = 'adrian@bazaar-admin.com' AND p.id = u.id;

-- Harry — 16th Street, Karlville Poucher + 6K backup
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY['Karlville Poucher', 'HP Indigo 6K']
FROM auth.users u
WHERE u.email = 'harry@bazaar-admin.com' AND p.id = u.id;

-- Mauricio — 16th Street supervisor, can run all 16th St machines
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY[
  'HP Indigo 15K', 'HP Indigo 6K', 'GM Die Cutter', 'GM Laser Cutter',
  'Moll Cutter', 'Moll Folder-Gluer', 'Laminator (Nobelus)', 'Scodix', 'Guillotine Cutter'
]
FROM auth.users u
WHERE u.email = 'mauricio@bazaar-admin.com' AND p.id = u.id;

-- Hrach — 16th Street, no machines (prepress: file prep / proofing)
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY[]::TEXT[]
FROM auth.users u
WHERE u.email = 'hrach@bazaar-admin.com' AND p.id = u.id;

-- Mike — 16th Street, production manager
UPDATE profiles p
SET facility = '16th-street', machines = ARRAY[]::TEXT[]
FROM auth.users u
WHERE u.email = 'mike@bazaar-admin.com' AND p.id = u.id;
