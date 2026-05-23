-- David Review, job_manager, and ops_manager can create/update orders (read was already allowed).
-- UI session role for these users is not always 'admin', but they manage tickets like supervisors.

DROP POLICY IF EXISTS "orders_insert_david_review_ops" ON public.orders;
CREATE POLICY "orders_insert_david_review_ops"
  ON public.orders FOR INSERT
  WITH CHECK (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );

DROP POLICY IF EXISTS "orders_update_david_review_ops" ON public.orders;
CREATE POLICY "orders_update_david_review_ops"
  ON public.orders FOR UPDATE
  USING (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  )
  WITH CHECK (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );

DROP POLICY IF EXISTS "order_workflow_steps_insert_david_review_ops" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_insert_david_review_ops"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );

DROP POLICY IF EXISTS "order_workflow_steps_update_david_review_ops" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_update_david_review_ops"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  )
  WITH CHECK (
    current_user_role()::text IN ('david_review', 'job_manager', 'ops_manager')
  );
