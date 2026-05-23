-- Allow roles that can insert/update workflow steps to delete them when syncing
-- (e.g. production manager removes a step). Without DELETE, delete+reinsert fails
-- with duplicate key on (order_id, step_index).

DROP POLICY IF EXISTS "order_workflow_steps_delete_admin_pm" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_delete_admin_pm"
  ON public.order_workflow_steps FOR DELETE
  USING (
    current_user_role()::text IN ('admin', 'supervisor', 'production_manager')
  );

DROP POLICY IF EXISTS "order_workflow_steps_delete_admin_supervisor_fallback" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_delete_admin_supervisor_fallback"
  ON public.order_workflow_steps FOR DELETE
  USING (current_user_role()::text IN ('admin', 'supervisor'));

DROP POLICY IF EXISTS "order_workflow_steps_delete_david_review_ops" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_delete_david_review_ops"
  ON public.order_workflow_steps FOR DELETE
  USING (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );
