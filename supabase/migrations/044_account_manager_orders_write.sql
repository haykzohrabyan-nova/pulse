-- Account managers must be able to edit the tickets they create.
--
-- Problem: the only AM update policy (orders_update_am, migration 002) matches
-- solely when orders.account_manager / orders.rep EXACTLY equals the AM's
-- profiles.display_name. When the job-ticket "Account Manager" field doesn't
-- match the display_name byte-for-byte (different label, trailing space, etc.)
-- the UPDATE returns 0 rows and the app reports
-- "You do not have permission to update this order".
--
-- Additionally, account managers had NO insert/update/delete policy on
-- order_workflow_steps, so saving a ticket (which syncs workflow steps) was
-- blocked even when the order update itself would have succeeded.
--
-- Fix: allow account managers to fully manage orders they CREATED
-- (created_by = auth.uid()) as well as orders assigned to them by name, and
-- to manage the workflow steps that belong to those orders.

-- ── ORDERS ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "orders_update_am_owned" ON public.orders;
CREATE POLICY "orders_update_am_owned"
  ON public.orders FOR UPDATE
  USING (
    current_user_role()::text = 'account_manager'
    AND (
      created_by = auth.uid()
      OR account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    current_user_role()::text = 'account_manager'
    AND (
      created_by = auth.uid()
      OR account_manager = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM public.profiles WHERE id = auth.uid())
    )
  );

-- ── ORDER WORKFLOW STEPS ─────────────────────────────────────────────────────
-- Account managers can manage steps for any order they are allowed to update.

DROP POLICY IF EXISTS "order_workflow_steps_am_insert" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_am_insert"
  ON public.order_workflow_steps FOR INSERT
  WITH CHECK (
    current_user_role()::text = 'account_manager'
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

DROP POLICY IF EXISTS "order_workflow_steps_am_update" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_am_update"
  ON public.order_workflow_steps FOR UPDATE
  USING (
    current_user_role()::text = 'account_manager'
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

DROP POLICY IF EXISTS "order_workflow_steps_am_delete" ON public.order_workflow_steps;
CREATE POLICY "order_workflow_steps_am_delete"
  ON public.order_workflow_steps FOR DELETE
  USING (
    current_user_role()::text = 'account_manager'
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
