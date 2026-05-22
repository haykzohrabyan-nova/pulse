-- Ensure admin/supervisor can always write orders and workflow steps.
-- Uses text comparisons only; no dependency on optional enum values.

DROP POLICY IF EXISTS "orders_insert_admin_supervisor_fallback" ON public.orders;
CREATE POLICY "orders_insert_admin_supervisor_fallback"
  ON public.orders FOR INSERT
  WITH CHECK (current_user_role()::text IN ('admin', 'supervisor'));

DROP POLICY IF EXISTS "orders_update_admin_supervisor_fallback" ON public.orders;
CREATE POLICY "orders_update_admin_supervisor_fallback"
  ON public.orders FOR UPDATE
  USING (current_user_role()::text IN ('admin', 'supervisor'))
  WITH CHECK (current_user_role()::text IN ('admin', 'supervisor'));

DROP POLICY IF EXISTS "order_workflow_steps_insert_admin_supervisor_fallback" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_insert_admin_supervisor_fallback"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (current_user_role()::text IN ('admin', 'supervisor'));

DROP POLICY IF EXISTS "order_workflow_steps_update_admin_supervisor_fallback" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_update_admin_supervisor_fallback"
  ON public.order_workflow_steps FOR UPDATE
  USING (current_user_role()::text IN ('admin', 'supervisor'))
  WITH CHECK (current_user_role()::text IN ('admin', 'supervisor'));
