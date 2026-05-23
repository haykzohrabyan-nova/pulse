-- Operators are assigned by name (operator_name) from Production Manager.
-- Existing policy only allowed UPDATE when operator_id = auth.uid(), which is
-- often unset. Allow update when the signed-in profile display_name matches.

DROP POLICY IF EXISTS "order_workflow_steps_update_operator_by_name" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_update_operator_by_name"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    current_user_role()::text = 'operator'
    AND operator_name IS NOT NULL
    AND lower(trim(operator_name)) = lower(trim((
      SELECT COALESCE(p.display_name, '')
      FROM public.profiles p
      WHERE p.id = auth.uid()
    )))
  )
  WITH CHECK (
    current_user_role()::text = 'operator'
    AND operator_name IS NOT NULL
    AND lower(trim(operator_name)) = lower(trim((
      SELECT COALESCE(p.display_name, '')
      FROM public.profiles p
      WHERE p.id = auth.uid()
    )))
  );
