-- Production Manager queue must list job tickets at every facility.
-- Existing policy scoped by profile.facility hid orders when slugs did not match.

CREATE POLICY "orders_select_production_manager_all_facilities"
  ON public.orders FOR SELECT
  USING (current_user_role()::text = 'production_manager');
