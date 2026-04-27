-- =============================================================================
-- PRI-236: Pulse Supabase Schema — Migration 002
-- Row-Level Security (RLS) policies
-- Principle: deny all anonymous access. Auth roles drive every policy.
-- Generated: 2026-04-27
-- =============================================================================

-- ---------------------------------------------------------------------------
-- HELPER: role-checking function (reads from profiles table)
-- Called by many policies; avoids repeating subqueries.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS user_role AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_user_facility()
RETURNS facility AS $$
  SELECT facility FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Enable RLS on all tables
-- ---------------------------------------------------------------------------

ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_workflow_steps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_files           ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_comments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE machines              ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_issues        ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dies                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_breaks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_points       ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_usage       ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE qc_records            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base        ENABLE ROW LEVEL SECURITY;
ALTER TABLE config                ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- PROFILES
-- Users can read their own profile. Admins read/write all.
-- =============================================================================

-- SELECT
CREATE POLICY "profiles_select_self"
  ON profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profiles_select_admin"
  ON profiles FOR SELECT
  USING (current_user_role() IN ('admin', 'supervisor', 'production_manager'));

-- UPDATE: users update their own profile; admin updates anyone
CREATE POLICY "profiles_update_self"
  ON profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update_admin"
  ON profiles FOR UPDATE
  USING (current_user_role() = 'admin');

-- INSERT: handled by trigger (handle_new_user) — no direct insert from client
-- DELETE: admin only
CREATE POLICY "profiles_delete_admin"
  ON profiles FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- CUSTOMERS
-- All authenticated roles can read. Account managers+ can create.
-- Only admin can delete.
-- =============================================================================

CREATE POLICY "customers_select_authenticated"
  ON customers FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "customers_insert_am_plus"
  ON customers FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager', 'account_manager')
  );

CREATE POLICY "customers_update_am_plus"
  ON customers FOR UPDATE
  USING (
    current_user_role() IN ('admin', 'supervisor', 'production_manager', 'account_manager')
  );

CREATE POLICY "customers_delete_admin"
  ON customers FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- ORDERS
-- - All authenticated users can read orders at their facility (or all for admin/supervisor)
-- - Account managers can see orders where they are the rep
-- - Operators can see orders where their current step is on a machine they operate
-- - Prepress can see orders in prepress/prepress-active/prepress-paused status
-- - david_review can see all
-- =============================================================================

-- SELECT: broad facility-scoped or role-based
CREATE POLICY "orders_select_admin_supervisor"
  ON orders FOR SELECT
  USING (
    current_user_role() IN ('admin', 'supervisor', 'david_review')
  );

CREATE POLICY "orders_select_production_manager"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'production_manager'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  );

CREATE POLICY "orders_select_account_manager"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'account_manager'
    AND (
      account_manager = (SELECT display_name FROM profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY "orders_select_prepress"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'prepress'
    AND status IN ('prepress', 'prepress-active', 'prepress-paused')
  );

CREATE POLICY "orders_select_operator"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'operator'
    AND facility = current_user_facility()
  );

-- INSERT: admin, supervisor, production_manager, account_manager
CREATE POLICY "orders_insert_am_plus"
  ON orders FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager', 'account_manager')
  );

-- UPDATE: admin and supervisor update anything
CREATE POLICY "orders_update_admin_supervisor"
  ON orders FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

-- UPDATE: production_manager updates orders at their facility
CREATE POLICY "orders_update_pm"
  ON orders FOR UPDATE
  USING (
    current_user_role() = 'production_manager'
    AND (facility = current_user_facility() OR current_user_facility() IS NULL)
  );

-- UPDATE: prepress updates prepress-status orders
CREATE POLICY "orders_update_prepress"
  ON orders FOR UPDATE
  USING (
    current_user_role() = 'prepress'
    AND status IN ('prepress', 'prepress-active', 'prepress-paused')
  );

-- UPDATE: account_manager updates their own orders
CREATE POLICY "orders_update_am"
  ON orders FOR UPDATE
  USING (
    current_user_role() = 'account_manager'
    AND (
      account_manager = (SELECT display_name FROM profiles WHERE id = auth.uid())
      OR rep = (SELECT display_name FROM profiles WHERE id = auth.uid())
    )
  );

-- DELETE: admin only (orders are never truly deleted in production)
CREATE POLICY "orders_delete_admin"
  ON orders FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- ORDER WORKFLOW STEPS
-- Any user who can read the parent order can read its steps.
-- Operators update steps on machines they are assigned to.
-- =============================================================================

CREATE POLICY "order_workflow_steps_select_authenticated"
  ON order_workflow_steps FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_workflow_steps_insert_admin_pm"
  ON order_workflow_steps FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "order_workflow_steps_update_admin_pm"
  ON order_workflow_steps FOR UPDATE
  USING (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

-- Operators can update the step they are assigned to
CREATE POLICY "order_workflow_steps_update_operator"
  ON order_workflow_steps FOR UPDATE
  USING (
    current_user_role() = 'operator'
    AND operator_id = auth.uid()
  );

-- =============================================================================
-- ORDER STATUS HISTORY
-- Immutable audit — all authenticated users can read; no one can delete.
-- =============================================================================

CREATE POLICY "order_status_history_select"
  ON order_status_history FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_status_history_insert"
  ON order_status_history FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- No UPDATE or DELETE policies — history is append-only.

-- =============================================================================
-- ORDER FILES
-- Read: any authenticated. Upload: any authenticated for their own orders.
-- Delete: admin or uploader.
-- =============================================================================

CREATE POLICY "order_files_select"
  ON order_files FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_files_insert"
  ON order_files FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "order_files_delete_admin"
  ON order_files FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "order_files_delete_uploader"
  ON order_files FOR DELETE
  USING (uploaded_by = auth.uid());

-- =============================================================================
-- ORDER COMMENTS
-- All authenticated users can read and post comments.
-- Users can edit their own comments. Admins can delete any.
-- =============================================================================

CREATE POLICY "order_comments_select"
  ON order_comments FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "order_comments_insert"
  ON order_comments FOR INSERT
  WITH CHECK (author_id = auth.uid());

CREATE POLICY "order_comments_update_author"
  ON order_comments FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "order_comments_delete_admin"
  ON order_comments FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "order_comments_delete_author"
  ON order_comments FOR DELETE
  USING (author_id = auth.uid());

-- =============================================================================
-- ACTIVITY LOG
-- Append-only audit. All authenticated can read. No deletes.
-- =============================================================================

CREATE POLICY "activity_log_select"
  ON activity_log FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "activity_log_insert"
  ON activity_log FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- =============================================================================
-- MACHINES
-- All authenticated can read. Admin/supervisor manage machines.
-- =============================================================================

CREATE POLICY "machines_select"
  ON machines FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "machines_insert_admin"
  ON machines FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "machines_update_admin"
  ON machines FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "machines_delete_admin"
  ON machines FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- MACHINE ISSUES
-- All authenticated can read and report issues.
-- Admin/supervisor can resolve/delete.
-- =============================================================================

CREATE POLICY "machine_issues_select"
  ON machine_issues FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "machine_issues_insert"
  ON machine_issues FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "machine_issues_update_admin"
  ON machine_issues FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "machine_issues_delete_admin"
  ON machine_issues FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- WORKFLOW TEMPLATES
-- All authenticated can read. Admin manages.
-- =============================================================================

CREATE POLICY "workflow_templates_select"
  ON workflow_templates FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "workflow_templates_insert_admin"
  ON workflow_templates FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "workflow_templates_update_admin"
  ON workflow_templates FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "workflow_templates_delete_admin"
  ON workflow_templates FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- DIES
-- All authenticated can read. Admin/supervisor manages.
-- =============================================================================

CREATE POLICY "dies_select"
  ON dies FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "dies_insert_admin"
  ON dies FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "dies_update_admin"
  ON dies FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor', 'prepress'));

CREATE POLICY "dies_delete_admin"
  ON dies FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- OPERATOR SESSIONS
-- Operators read/write their own sessions.
-- Supervisors/admins read all sessions.
-- =============================================================================

CREATE POLICY "operator_sessions_select_self"
  ON operator_sessions FOR SELECT
  USING (operator_id = auth.uid());

CREATE POLICY "operator_sessions_select_admin"
  ON operator_sessions FOR SELECT
  USING (current_user_role() IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "operator_sessions_insert_self"
  ON operator_sessions FOR INSERT
  WITH CHECK (operator_id = auth.uid());

CREATE POLICY "operator_sessions_update_self"
  ON operator_sessions FOR UPDATE
  USING (operator_id = auth.uid());

CREATE POLICY "operator_sessions_update_admin"
  ON operator_sessions FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

-- =============================================================================
-- OPERATOR BREAKS
-- Scoped through session ownership.
-- =============================================================================

CREATE POLICY "operator_breaks_select_self"
  ON operator_breaks FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM operator_sessions WHERE operator_id = auth.uid()
    )
  );

CREATE POLICY "operator_breaks_select_admin"
  ON operator_breaks FOR SELECT
  USING (current_user_role() IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "operator_breaks_insert_self"
  ON operator_breaks FOR INSERT
  WITH CHECK (
    session_id IN (
      SELECT id FROM operator_sessions WHERE operator_id = auth.uid()
    )
  );

CREATE POLICY "operator_breaks_update_self"
  ON operator_breaks FOR UPDATE
  USING (
    session_id IN (
      SELECT id FROM operator_sessions WHERE operator_id = auth.uid()
    )
  );

-- =============================================================================
-- OPERATOR POINTS
-- Operators see their own. Admin/supervisor see all. Admin awards.
-- =============================================================================

CREATE POLICY "operator_points_select_self"
  ON operator_points FOR SELECT
  USING (operator_id = auth.uid());

CREATE POLICY "operator_points_select_admin"
  ON operator_points FOR SELECT
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "operator_points_insert_admin"
  ON operator_points FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

-- =============================================================================
-- MATERIALS + INVENTORY
-- All authenticated can read. Admin/supervisor manages.
-- =============================================================================

CREATE POLICY "materials_select"
  ON materials FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "materials_insert_admin"
  ON materials FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "materials_update_admin"
  ON materials FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "materials_delete_admin"
  ON materials FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "inventory_select"
  ON inventory FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "inventory_insert_admin"
  ON inventory FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "inventory_update_admin"
  ON inventory FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor', 'production_manager'));

CREATE POLICY "inventory_delete_admin"
  ON inventory FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "inventory_usage_select"
  ON inventory_usage FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "inventory_usage_insert"
  ON inventory_usage FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager', 'operator')
  );

-- =============================================================================
-- PURCHASE ORDERS
-- Admin/supervisor/production_manager read and write.
-- =============================================================================

CREATE POLICY "purchase_orders_select"
  ON purchase_orders FOR SELECT
  USING (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "purchase_orders_insert"
  ON purchase_orders FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "purchase_orders_update"
  ON purchase_orders FOR UPDATE
  USING (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "purchase_orders_delete_admin"
  ON purchase_orders FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "purchase_order_items_select"
  ON purchase_order_items FOR SELECT
  USING (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "purchase_order_items_insert"
  ON purchase_order_items FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager')
  );

CREATE POLICY "purchase_order_items_delete_admin"
  ON purchase_order_items FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- QC RECORDS
-- Prepress/QC/admin/supervisor read. Admin + supervisor write.
-- =============================================================================

CREATE POLICY "qc_records_select"
  ON qc_records FOR SELECT
  USING (
    current_user_role() IN ('admin', 'supervisor', 'production_manager', 'prepress', 'david_review')
  );

CREATE POLICY "qc_records_insert"
  ON qc_records FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'production_manager', 'prepress')
  );

CREATE POLICY "qc_records_update_admin"
  ON qc_records FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

-- =============================================================================
-- INVOICES
-- Account managers see invoices for their customers.
-- Admin/supervisor see all.
-- =============================================================================

CREATE POLICY "invoices_select_admin"
  ON invoices FOR SELECT
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "invoices_select_am"
  ON invoices FOR SELECT
  USING (
    current_user_role() = 'account_manager'
    AND customer_id IN (
      SELECT id FROM customers
    )
  );

CREATE POLICY "invoices_insert"
  ON invoices FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'account_manager')
  );

CREATE POLICY "invoices_update"
  ON invoices FOR UPDATE
  USING (
    current_user_role() IN ('admin', 'supervisor', 'account_manager')
  );

CREATE POLICY "invoices_delete_admin"
  ON invoices FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "invoice_line_items_select_admin"
  ON invoice_line_items FOR SELECT
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "invoice_line_items_select_am"
  ON invoice_line_items FOR SELECT
  USING (
    current_user_role() = 'account_manager'
    AND invoice_id IN (SELECT id FROM invoices)
  );

CREATE POLICY "invoice_line_items_insert"
  ON invoice_line_items FOR INSERT
  WITH CHECK (
    current_user_role() IN ('admin', 'supervisor', 'account_manager')
  );

CREATE POLICY "invoice_line_items_delete_admin"
  ON invoice_line_items FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- KNOWLEDGE BASE
-- All authenticated read. Admin/supervisor write.
-- =============================================================================

CREATE POLICY "knowledge_base_select"
  ON knowledge_base FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "knowledge_base_insert_admin"
  ON knowledge_base FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "knowledge_base_update_admin"
  ON knowledge_base FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "knowledge_base_delete_admin"
  ON knowledge_base FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- CONFIG
-- All authenticated read. Admin only writes.
-- =============================================================================

CREATE POLICY "config_select"
  ON config FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "config_insert_admin"
  ON config FOR INSERT
  WITH CHECK (current_user_role() = 'admin');

CREATE POLICY "config_update_admin"
  ON config FOR UPDATE
  USING (current_user_role() = 'admin');

CREATE POLICY "config_delete_admin"
  ON config FOR DELETE
  USING (current_user_role() = 'admin');

-- =============================================================================
-- REALTIME SUBSCRIPTIONS
-- Enable realtime for high-frequency tables. Others use polling or REST.
-- =============================================================================

-- Allow realtime for orders, order_workflow_steps, order_comments, activity_log
-- Run in Supabase Dashboard > Database > Replication, or via SQL:
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE order_workflow_steps;
ALTER PUBLICATION supabase_realtime ADD TABLE order_comments;
ALTER PUBLICATION supabase_realtime ADD TABLE activity_log;
ALTER PUBLICATION supabase_realtime ADD TABLE operator_sessions;
