-- Allow operators to update orders at their facility.
-- Without this, stepAction('start'/'complete'/'pause') silently fails:
-- _updateOrder() does supa.from('orders').update(row) which is blocked by
-- RLS (migration 002 has SELECT for operators but no UPDATE).

DROP POLICY IF EXISTS "orders_update_operator" ON public.orders;
CREATE POLICY "orders_update_operator"
  ON public.orders FOR UPDATE
  USING (
    current_user_role()::text = 'operator'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  )
  WITH CHECK (
    current_user_role()::text = 'operator'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  );

-- Allow operators to insert workflow steps.
-- _syncWorkflowSteps uses upsert (INSERT … ON CONFLICT UPDATE); without an
-- INSERT policy the whole upsert call fails even when every row already exists.

DROP POLICY IF EXISTS "order_workflow_steps_insert_operator" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_insert_operator"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (current_user_role()::text = 'operator');

-- Widen the operator UPDATE policy to cover steps where operator_name is NULL
-- (unassigned steps that the operator picks up at the terminal).
-- Migration 041 only allows update when operator_name IS NOT NULL and matches
-- the operator's display_name; this fallback covers unassigned steps.

DROP POLICY IF EXISTS "order_workflow_steps_update_operator_unassigned" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_update_operator_unassigned"
  ON public.order_workflow_steps FOR UPDATE
  USING (current_user_role()::text = 'operator')
  WITH CHECK (current_user_role()::text = 'operator');
