-- Fix: david_review (and job_manager / ops_manager) users could WRITE orders
-- (migrations 034/038) but had NO SELECT policy on the live database, so the
-- Job Ticket "Orders" queue came back empty for them.
--
-- Root cause: the 'david_review' enum value is created in 047a, which runs
-- AFTER 002_rls_policies.sql. On the live DB, the original 002 orders SELECT
-- policy therefore never included 'david_review'. 038 added write access but
-- assumed read "was already allowed" — it was not.
--
-- Using ::text comparison so this is safe even if job_manager / ops_manager are
-- not present as enum labels (the comparison simply won't match those).
-- Idempotent: safe to re-run.

DROP POLICY IF EXISTS "orders_select_david_review_ops" ON public.orders;
CREATE POLICY "orders_select_david_review_ops"
  ON public.orders FOR SELECT
  USING (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );

-- Needed so opening a ticket (orders + order_workflow_steps(*)) returns its steps.
DROP POLICY IF EXISTS "order_workflow_steps_select_david_review_ops" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_select_david_review_ops"
  ON public.order_workflow_steps FOR SELECT
  USING (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );

-- Post-check: confirm David resolves to david_review and can now read orders.
SELECT 'david role' AS check, p.display_name, p.role::text
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE u.email = 'david@bazaar-admin.com';
