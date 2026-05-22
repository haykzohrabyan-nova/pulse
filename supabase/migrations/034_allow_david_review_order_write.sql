-- Allow david_review to write orders and workflow steps.
-- Existing RLS grants david_review broad SELECT but not all write paths.

DROP POLICY IF EXISTS "orders_insert_david_review" ON public.orders;
CREATE POLICY "orders_insert_david_review"
  ON public.orders FOR INSERT
  WITH CHECK (current_user_role() = 'david_review');

DROP POLICY IF EXISTS "orders_update_david_review" ON public.orders;
CREATE POLICY "orders_update_david_review"
  ON public.orders FOR UPDATE
  USING (current_user_role() = 'david_review');

DROP POLICY IF EXISTS "order_workflow_steps_insert_david_review" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_insert_david_review"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (current_user_role() = 'david_review');

DROP POLICY IF EXISTS "order_workflow_steps_update_david_review" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_update_david_review"
  ON public.order_workflow_steps FOR UPDATE
  USING (current_user_role() = 'david_review');
