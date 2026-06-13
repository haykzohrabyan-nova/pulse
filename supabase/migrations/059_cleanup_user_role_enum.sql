-- =============================================================================
-- 059: Remove deprecated zzz_old_* user_role enum values
--
-- Strategy:
--   1. Remap profile rows still on zzz_old_* labels (targets exist in old enum)
--   2. Drop every RLS policy on public + storage (unblocks profiles.role type change)
--   3. Drop/replace functions that reference user_role
--   4. Swap enum via user_role_new + column cast (maps ops_manager → manager, etc.)
--   5. Recreate functions + all policies using (current_user_role())::text
--
-- Run in Supabase SQL Editor as one script.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Remap zzz_old_* rows where the target already exists in the current enum
-- ---------------------------------------------------------------------------
UPDATE public.profiles SET role = 'production_manager' WHERE role::text = 'zzz_old_production_manager';
UPDATE public.profiles SET role = 'david_review'      WHERE role::text = 'zzz_old_david_review';
UPDATE public.profiles SET role = 'prepress'          WHERE role::text = 'zzz_old_designer';
UPDATE public.profiles SET role = 'admin'             WHERE role::text IN ('zzz_old_walkin_front_desk', 'zzz_old_sdr');

-- zzz_old_ops_manager → manager is handled in the column cast below (manager may not exist yet)

-- ---------------------------------------------------------------------------
-- 2. Drop ALL RLS policies (public + storage) — required before ALTER COLUMN
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schemaname, c.relname AS tablename, pol.polname AS policyname
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'storage')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Drop auth trigger + functions that reference user_role
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.upsert_pulse_personnel(TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID);
DROP FUNCTION IF EXISTS public.ensure_pulse_profile();
DROP FUNCTION IF EXISTS public.current_user_role();
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 4. Replace enum with clean 12-value set
-- ---------------------------------------------------------------------------
CREATE TYPE public.user_role_new AS ENUM (
  'admin',
  'supervisor',
  'manager',
  'account_manager',
  'job_manager',
  'production_manager',
  'prepress',
  'operator',
  'qc',
  'qc_inspector',
  'shipping',
  'david_review'
);

ALTER TABLE public.profiles ALTER COLUMN role DROP DEFAULT;

ALTER TABLE public.profiles
  ALTER COLUMN role TYPE public.user_role_new
  USING (
    CASE role::text
      WHEN 'zzz_old_production_manager' THEN 'production_manager'
      WHEN 'zzz_old_david_review'       THEN 'david_review'
      WHEN 'zzz_old_ops_manager'        THEN 'manager'
      WHEN 'zzz_old_designer'           THEN 'prepress'
      WHEN 'zzz_old_walkin_front_desk'  THEN 'admin'
      WHEN 'zzz_old_sdr'                THEN 'admin'
      WHEN 'ops_manager'                THEN 'manager'
      WHEN 'sdr'                        THEN 'admin'
      WHEN 'designer'                   THEN 'prepress'
      WHEN 'walkin_front_desk'          THEN 'admin'
      ELSE role::text
    END
  )::public.user_role_new;

DROP TYPE public.user_role;
ALTER TYPE public.user_role_new RENAME TO user_role;
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'operator'::public.user_role;

-- ---------------------------------------------------------------------------
-- 5. Recreate helper functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS public.user_role AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    COALESCE(
      CASE replace(lower(COALESCE(NEW.raw_user_meta_data->>'role', 'operator')), '-', '_')
        WHEN 'ops_manager'       THEN 'manager'
        WHEN 'zzz_old_ops_manager' THEN 'manager'
        WHEN 'sdr'               THEN 'admin'
        WHEN 'designer'          THEN 'prepress'
        WHEN 'walkin_front_desk' THEN 'admin'
        ELSE replace(lower(COALESCE(NEW.raw_user_meta_data->>'role', 'operator')), '-', '_')
      END,
      'operator'
    )::public.user_role
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

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
  v_role_text text;
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

  v_role_text := replace(lower(COALESCE(u.raw_user_meta_data->>'role', 'operator')), '-', '_');
  v_role_text := CASE v_role_text
    WHEN 'ops_manager'       THEN 'manager'
    WHEN 'zzz_old_ops_manager' THEN 'manager'
    WHEN 'sdr'               THEN 'admin'
    WHEN 'designer'          THEN 'prepress'
    WHEN 'walkin_front_desk' THEN 'admin'
    ELSE v_role_text
  END;

  INSERT INTO public.profiles (id, display_name, role)
  VALUES (
    uid,
    COALESCE(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
    COALESCE(v_role_text, 'operator')::public.user_role
  )
  RETURNING * INTO row;

  RETURN row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_pulse_profile() TO authenticated;

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
  v_role_text     TEXT;
  v_role          user_role;
  v_facility      facility;
  v_created       BOOLEAN;
BEGIN
  IF (SELECT role::text FROM public.profiles WHERE id = auth.uid()) NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'Permission denied: only admins and supervisors can manage personnel';
  END IF;

  v_email := lower(split_part(trim(p_display_name), ' ', 1)) || '@bazaarprinting.com';
  v_password := COALESCE(NULLIF(trim(p_user_id), ''), 'Pulse2026!');
  v_role_text := replace(lower(coalesce(p_role, 'operator')), '-', '_');
  v_role_text := CASE v_role_text
    WHEN 'ops_manager'       THEN 'manager'
    WHEN 'zzz_old_ops_manager' THEN 'manager'
    WHEN 'sdr'               THEN 'admin'
    WHEN 'designer'          THEN 'prepress'
    WHEN 'walkin_front_desk' THEN 'admin'
    ELSE v_role_text
  END;
  v_role := v_role_text::user_role;
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
  SET display_name  = EXCLUDED.display_name,
      role          = EXCLUDED.role,
      pulse_user_id = COALESCE(EXCLUDED.pulse_user_id, profiles.pulse_user_id),
      facility      = COALESCE(EXCLUDED.facility, profiles.facility),
      active        = EXCLUDED.active,
      updated_at    = NOW();

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

-- ---------------------------------------------------------------------------
-- 6. Recreate RLS policies — all role checks use (current_user_role())::text
--    Sources: 002, 005, 008, 012, 014, 017, 025, 029, 034, 035, 037, 038,
--             040, 041, 042, 043, 044, 050, 052, 053, 054, 058, 010 (proofs)
-- ---------------------------------------------------------------------------

-- ── PROFILES (002, 037, 042) ───────────────────────────────────────────────
CREATE POLICY "profiles_select_self"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profiles_select_admin"
  ON public.profiles FOR SELECT
  USING (
    (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'david_review'
    )
  );

CREATE POLICY "profiles_select_anon_names"
  ON public.profiles FOR SELECT
  TO anon
  USING (active = true OR active IS NULL);

CREATE POLICY "profiles_update_self"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update_admin"
  ON public.profiles FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'david_review'));

CREATE POLICY "profiles_delete_admin"
  ON public.profiles FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── CUSTOMERS (002) ──────────────────────────────────────────────────────────
CREATE POLICY "customers_select_authenticated"
  ON public.customers FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "customers_insert_am_plus"
  ON public.customers FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'account_manager')
  );

CREATE POLICY "customers_update_am_plus"
  ON public.customers FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'account_manager')
  );

CREATE POLICY "customers_delete_admin"
  ON public.customers FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── ORDERS (002, 008, 025, 034, 035, 038, 043, 044, 050, 053) ───────────────
CREATE POLICY "orders_select_admin_supervisor"
  ON public.orders FOR SELECT
  USING ((current_user_role())::text IN ('admin', 'supervisor', 'david_review'));

CREATE POLICY "orders_select_production_manager"
  ON public.orders FOR SELECT
  USING (
    (current_user_role())::text = 'production_manager'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  );

CREATE POLICY "orders_select_production_manager_all_facilities"
  ON public.orders FOR SELECT
  USING ((current_user_role())::text = 'production_manager');

CREATE POLICY "orders_select_account_manager"
  ON public.orders FOR SELECT
  USING ((current_user_role())::text = 'account_manager');

CREATE POLICY "orders_select_prepress"
  ON public.orders FOR SELECT
  USING (
    (current_user_role())::text = 'prepress'
    AND status IN ('prepress', 'prepress-active', 'prepress-paused')
  );

CREATE POLICY "orders_select_operator"
  ON public.orders FOR SELECT
  USING (
    (current_user_role())::text = 'operator'
    AND facility = current_user_facility()
  );

CREATE POLICY "orders_select_qc"
  ON public.orders FOR SELECT
  USING (
    (current_user_role())::text = 'qc'
    AND status IN ('qc-checkout')
  );

CREATE POLICY "orders_select_shipping"
  ON public.orders FOR SELECT
  USING (
    (current_user_role())::text = 'shipping'
    AND status IN (
      'ready-to-ship', 'waiting-pickup', 'delivery-ready',
      'shipped', 'received', 'completed', 'qc-checkout'
    )
  );

CREATE POLICY "orders_select_david_review_ops"
  ON public.orders FOR SELECT
  USING (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "orders_insert_am_plus"
  ON public.orders FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'account_manager')
  );

CREATE POLICY "orders_insert_admin_supervisor_fallback"
  ON public.orders FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "orders_insert_david_review_ops"
  ON public.orders FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "orders_update_admin_supervisor"
  ON public.orders FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "orders_update_admin_supervisor_fallback"
  ON public.orders FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'))
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "orders_update_pm"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'production_manager'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  );

CREATE POLICY "orders_update_prepress"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'prepress'
    AND status IN ('prepress', 'prepress-active', 'prepress-paused')
  );

CREATE POLICY "orders_update_am"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'account_manager'
    AND (
      account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY "orders_update_am_owned"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'account_manager'
    AND (
      created_by = auth.uid()
      OR account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    (current_user_role())::text = 'account_manager'
    AND (
      created_by = auth.uid()
      OR account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY "orders_update_qc"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'qc'
    AND status = 'qc-checkout'
  );

CREATE POLICY "orders_update_shipping"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'shipping'
    AND status IN ('ready-to-ship', 'waiting-pickup', 'delivery-ready', 'shipped', 'received')
  )
  WITH CHECK (
    (current_user_role())::text = 'shipping'
    AND status IN ('ready-to-ship', 'waiting-pickup', 'delivery-ready', 'shipped', 'received', 'completed')
  );

CREATE POLICY "orders_update_david_review_ops"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  )
  WITH CHECK (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "orders_update_operator"
  ON public.orders FOR UPDATE
  USING (
    (current_user_role())::text = 'operator'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  )
  WITH CHECK (
    (current_user_role())::text = 'operator'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  );

CREATE POLICY "orders_delete_admin"
  ON public.orders FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── ORDER WORKFLOW STEPS (002, 034, 038, 040, 041, 044, 050, 053) ──────────
CREATE POLICY "order_workflow_steps_select_authenticated"
  ON public.order_workflow_steps FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_workflow_steps_select_david_review_ops"
  ON public.order_workflow_steps FOR SELECT
  USING (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "order_workflow_steps_insert_admin_pm"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "order_workflow_steps_insert_admin_supervisor_fallback"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "order_workflow_steps_insert_david_review_ops"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "order_workflow_steps_insert_operator"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK ((current_user_role())::text = 'operator');

CREATE POLICY "order_workflow_steps_am_insert"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (
    (current_user_role())::text = 'account_manager'
    AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_workflow_steps.order_id
        AND (
          o.created_by = auth.uid()
          OR o.account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
          OR o.rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
        )
    )
  );

CREATE POLICY "order_workflow_steps_update_admin_pm"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "order_workflow_steps_update_admin_supervisor_fallback"
  ON public.order_workflow_steps FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'))
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "order_workflow_steps_update_david_review_ops"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  )
  WITH CHECK (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "order_workflow_steps_update_operator"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    (current_user_role())::text = 'operator'
    AND operator_id = auth.uid()
  );

CREATE POLICY "order_workflow_steps_update_operator_by_name"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    (current_user_role())::text = 'operator'
    AND operator_name IS NOT NULL
    AND lower(trim(operator_name)) = lower(trim((
      SELECT COALESCE(p.display_name, '')
      FROM public.profiles p
      WHERE p.id = auth.uid()
    )))
  )
  WITH CHECK (
    (current_user_role())::text = 'operator'
    AND operator_name IS NOT NULL
    AND lower(trim(operator_name)) = lower(trim((
      SELECT COALESCE(p.display_name, '')
      FROM public.profiles p
      WHERE p.id = auth.uid()
    )))
  );

CREATE POLICY "order_workflow_steps_update_operator_unassigned"
  ON public.order_workflow_steps FOR UPDATE
  USING ((current_user_role())::text = 'operator')
  WITH CHECK ((current_user_role())::text = 'operator');

CREATE POLICY "order_workflow_steps_am_update"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    (current_user_role())::text = 'account_manager'
    AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_workflow_steps.order_id
        AND (
          o.created_by = auth.uid()
          OR o.account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
          OR o.rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
        )
    )
  );

CREATE POLICY "order_workflow_steps_delete_admin_pm"
  ON public.order_workflow_steps FOR DELETE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "order_workflow_steps_delete_admin_supervisor_fallback"
  ON public.order_workflow_steps FOR DELETE
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "order_workflow_steps_delete_david_review_ops"
  ON public.order_workflow_steps FOR DELETE
  USING (
    (current_user_role())::text IN ('david_review', 'job_manager', 'manager')
  );

CREATE POLICY "order_workflow_steps_am_delete"
  ON public.order_workflow_steps FOR DELETE
  USING (
    (current_user_role())::text = 'account_manager'
    AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_workflow_steps.order_id
        AND (
          o.created_by = auth.uid()
          OR o.account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
          OR o.rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
        )
    )
  );

-- ── ORDER STATUS HISTORY (002) ───────────────────────────────────────────────
CREATE POLICY "order_status_history_select"
  ON public.order_status_history FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_status_history_insert"
  ON public.order_status_history FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── ORDER FILES (002, 005) ───────────────────────────────────────────────────
CREATE POLICY "order_files_read_active"
  ON public.order_files FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND deleted_at IS NULL
    AND upload_status = 'complete'
  );

CREATE POLICY "order_files_admin_read_all"
  ON public.order_files FOR SELECT
  USING ((current_user_role())::text = 'admin');

CREATE POLICY "order_files_insert"
  ON public.order_files FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "order_files_delete_admin"
  ON public.order_files FOR DELETE
  USING ((current_user_role())::text = 'admin');

CREATE POLICY "order_files_delete_uploader"
  ON public.order_files FOR DELETE
  USING (uploaded_by = auth.uid());

-- ── ORDER COMMENTS (002) ───────────────────────────────────────────────────────
CREATE POLICY "order_comments_select"
  ON public.order_comments FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_comments_insert"
  ON public.order_comments FOR INSERT
  WITH CHECK (author_id = auth.uid());

CREATE POLICY "order_comments_update_author"
  ON public.order_comments FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "order_comments_delete_admin"
  ON public.order_comments FOR DELETE
  USING ((current_user_role())::text = 'admin');

CREATE POLICY "order_comments_delete_author"
  ON public.order_comments FOR DELETE
  USING (author_id = auth.uid());

-- ── ACTIVITY LOG (002) ───────────────────────────────────────────────────────
CREATE POLICY "activity_log_select"
  ON public.activity_log FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "activity_log_insert"
  ON public.activity_log FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── MACHINES (022) ───────────────────────────────────────────────────────────
CREATE POLICY "machines_select"
  ON public.machines FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "machines_insert_admin"
  ON public.machines FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "machines_update_admin"
  ON public.machines FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "machines_delete_admin"
  ON public.machines FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── MACHINE ISSUES (002, 036) ────────────────────────────────────────────────
CREATE POLICY "machine_issues_select"
  ON public.machine_issues FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "machine_issues_insert"
  ON public.machine_issues FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "machine_issues_update_admin"
  ON public.machine_issues FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "machine_issues_update_authenticated"
  ON public.machine_issues FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "machine_issues_delete_admin"
  ON public.machine_issues FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── DIES (002) ───────────────────────────────────────────────────────────────
CREATE POLICY "dies_select"
  ON public.dies FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "dies_insert_admin"
  ON public.dies FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "dies_update_admin"
  ON public.dies FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor', 'prepress'));

CREATE POLICY "dies_delete_admin"
  ON public.dies FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── OPERATOR SESSIONS (002, 052) ─────────────────────────────────────────────
CREATE POLICY "operator_sessions_select_authenticated"
  ON public.operator_sessions FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "operator_sessions_select_admin"
  ON public.operator_sessions FOR SELECT
  USING ((current_user_role())::text IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "operator_sessions_insert_authenticated"
  ON public.operator_sessions FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "operator_sessions_update_authenticated"
  ON public.operator_sessions FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "operator_sessions_update_admin"
  ON public.operator_sessions FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

-- ── OPERATOR BREAKS (002) ────────────────────────────────────────────────────
CREATE POLICY "operator_breaks_select_self"
  ON public.operator_breaks FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM public.operator_sessions WHERE operator_id = auth.uid()
    )
  );

CREATE POLICY "operator_breaks_select_admin"
  ON public.operator_breaks FOR SELECT
  USING ((current_user_role())::text IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "operator_breaks_insert_self"
  ON public.operator_breaks FOR INSERT
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.operator_sessions WHERE operator_id = auth.uid()
    )
  );

CREATE POLICY "operator_breaks_update_self"
  ON public.operator_breaks FOR UPDATE
  USING (
    session_id IN (
      SELECT id FROM public.operator_sessions WHERE operator_id = auth.uid()
    )
  );

-- ── OPERATOR POINTS (002) ────────────────────────────────────────────────────
CREATE POLICY "operator_points_select_self"
  ON public.operator_points FOR SELECT
  USING (operator_id = auth.uid());

CREATE POLICY "operator_points_select_admin"
  ON public.operator_points FOR SELECT
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "operator_points_insert_admin"
  ON public.operator_points FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

-- ── MATERIALS (002) ──────────────────────────────────────────────────────────
CREATE POLICY "materials_select"
  ON public.materials FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "materials_insert_admin"
  ON public.materials FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "materials_update_admin"
  ON public.materials FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "materials_delete_admin"
  ON public.materials FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── INVOICES (002) ───────────────────────────────────────────────────────────
CREATE POLICY "invoices_select_admin"
  ON public.invoices FOR SELECT
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "invoices_select_am"
  ON public.invoices FOR SELECT
  USING (
    (current_user_role())::text = 'account_manager'
    AND customer_id IN (SELECT id FROM public.customers)
  );

CREATE POLICY "invoices_insert"
  ON public.invoices FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'account_manager')
  );

CREATE POLICY "invoices_update"
  ON public.invoices FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'account_manager')
  );

CREATE POLICY "invoices_delete_admin"
  ON public.invoices FOR DELETE
  USING ((current_user_role())::text = 'admin');

CREATE POLICY "invoice_line_items_select_admin"
  ON public.invoice_line_items FOR SELECT
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "invoice_line_items_select_am"
  ON public.invoice_line_items FOR SELECT
  USING (
    (current_user_role())::text = 'account_manager'
    AND invoice_id IN (SELECT id FROM public.invoices)
  );

CREATE POLICY "invoice_line_items_insert"
  ON public.invoice_line_items FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'account_manager')
  );

CREATE POLICY "invoice_line_items_delete_admin"
  ON public.invoice_line_items FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── KNOWLEDGE BASE (002) ─────────────────────────────────────────────────────
CREATE POLICY "knowledge_base_select"
  ON public.knowledge_base FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "knowledge_base_insert_admin"
  ON public.knowledge_base FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "knowledge_base_update_admin"
  ON public.knowledge_base FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'supervisor'));

CREATE POLICY "knowledge_base_delete_admin"
  ON public.knowledge_base FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── CONFIG (002, 029, 037, 042) ──────────────────────────────────────────────
CREATE POLICY "config_select"
  ON public.config FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "config_select_anon_bootstrap"
  ON public.config FOR SELECT
  TO anon
  USING (
    key IN (
      'personnel', 'pulseNoteTypes', 'pulseRushConfig',
      'pulseLeadTimes', 'pulseProductionLines', 'pulseReprintReasons'
    )
  );

CREATE POLICY "config_insert_admin"
  ON public.config FOR INSERT
  WITH CHECK ((current_user_role())::text IN ('admin', 'david_review'));

CREATE POLICY "config_update_admin"
  ON public.config FOR UPDATE
  USING ((current_user_role())::text IN ('admin', 'david_review'));

CREATE POLICY "config_delete_admin"
  ON public.config FOR DELETE
  USING ((current_user_role())::text = 'admin');

-- ── PRODUCTION TASKS (012, 014) ──────────────────────────────────────────────
CREATE POLICY "production_tasks_select_auth"
  ON public.production_tasks FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "production_tasks_insert_managers"
  ON public.production_tasks FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'job_manager', 'manager', 'production_manager')
  );

CREATE POLICY "production_tasks_update_operators"
  ON public.production_tasks FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'job_manager', 'manager', 'production_manager')
    OR assigned_operator = auth.uid()
  );

CREATE POLICY "production_tasks_update_prepress"
  ON public.production_tasks FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- ── PRODUCT WORKFLOWS (022, 029) ───────────────────────────────────────────────
CREATE POLICY "product_workflows_select"
  ON public.product_workflows FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "product_workflows_insert_admin"
  ON public.product_workflows FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review')
  );

CREATE POLICY "product_workflows_update_admin"
  ON public.product_workflows FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review')
  );

CREATE POLICY "product_workflows_delete_admin"
  ON public.product_workflows FOR DELETE
  USING ((current_user_role())::text IN ('admin', 'supervisor', 'david_review'));

-- ── ORGANISATIONS (017) ─────────────────────────────────────────────────────
CREATE POLICY "organisations_select_auth"
  ON public.organisations FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "organisations_insert_managers"
  ON public.organisations FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisations_update_managers"
  ON public.organisations FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  )
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisations_delete_managers"
  ON public.organisations FOR DELETE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisation_facilities_select_auth"
  ON public.organisation_facilities FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "organisation_facilities_insert_managers"
  ON public.organisation_facilities FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisation_facilities_update_managers"
  ON public.organisation_facilities FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  )
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisation_facilities_delete_managers"
  ON public.organisation_facilities FOR DELETE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisation_hardware_select_auth"
  ON public.organisation_hardware FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "organisation_hardware_insert_managers"
  ON public.organisation_hardware FOR INSERT
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisation_hardware_update_managers"
  ON public.organisation_hardware FOR UPDATE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  )
  WITH CHECK (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

CREATE POLICY "organisation_hardware_delete_managers"
  ON public.organisation_hardware FOR DELETE
  USING (
    (current_user_role())::text IN ('admin', 'supervisor', 'production_manager', 'david_review', 'manager')
  );

-- ── WORKFLOW OVERRIDE LOG (023) ──────────────────────────────────────────────
CREATE POLICY "workflow_override_log_select"
  ON public.workflow_override_log FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "workflow_override_log_insert"
  ON public.workflow_override_log FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── PICKUP VERIFICATIONS (054) ─────────────────────────────────────────────────
CREATE POLICY "service_role_only"
  ON public.pickup_verifications
  USING (FALSE);

-- ── PREPRESS PROOFS / DESIGN (010) — auth only, no user_role ─────────────────
CREATE POLICY "design_tasks_read_auth"
  ON public.design_tasks FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "design_tasks_write_auth"
  ON public.design_tasks FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "proofs_read_auth"
  ON public.proofs FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "proofs_write_auth"
  ON public.proofs FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "proof_versions_read_auth"
  ON public.proof_versions FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "proof_versions_write_auth"
  ON public.proof_versions FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "proof_events_read_auth"
  ON public.proof_approval_events FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "proof_events_write_auth"
  ON public.proof_approval_events FOR ALL
  USING (auth.role() = 'authenticated');

-- ── STORAGE: org-assets + sku-artwork (017, 058) ─────────────────────────────
CREATE POLICY "org_assets_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'org-assets');

CREATE POLICY "org_assets_insert_managers"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'org-assets'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'manager'
    )
  );

CREATE POLICY "org_assets_update_managers"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'org-assets'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'manager'
    )
  );

CREATE POLICY "org_assets_delete_managers"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'org-assets'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'manager'
    )
  );

CREATE POLICY "sku_artwork_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sku-artwork');

CREATE POLICY "sku_artwork_insert_staff"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'sku-artwork'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'account_manager',
      'david_review', 'manager', 'prepress'
    )
  );

CREATE POLICY "sku_artwork_update_staff"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'sku-artwork'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'account_manager',
      'david_review', 'manager', 'prepress'
    )
  );

CREATE POLICY "sku_artwork_delete_staff"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'sku-artwork'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'production_manager', 'account_manager',
      'david_review', 'manager', 'prepress'
    )
  );

COMMIT;

-- Post-check: confirm clean enum (run separately if desired)
SELECT enumlabel AS user_role_value
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'user_role'
ORDER BY e.enumsortorder;
