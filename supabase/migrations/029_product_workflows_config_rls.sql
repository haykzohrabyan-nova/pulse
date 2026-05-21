-- Allow roles that use Admin → Product Workflow Configuration to read/write workflows + catalog config.

DROP POLICY IF EXISTS "product_workflows_insert_admin" ON product_workflows;
CREATE POLICY "product_workflows_insert_admin"
  ON product_workflows FOR INSERT
  WITH CHECK (current_user_role()::text IN ('admin', 'supervisor', 'production_manager', 'david_review'));

DROP POLICY IF EXISTS "product_workflows_update_admin" ON product_workflows;
CREATE POLICY "product_workflows_update_admin"
  ON product_workflows FOR UPDATE
  USING (current_user_role()::text IN ('admin', 'supervisor', 'production_manager', 'david_review'));

DROP POLICY IF EXISTS "product_workflows_delete_admin" ON product_workflows;
CREATE POLICY "product_workflows_delete_admin"
  ON product_workflows FOR DELETE
  USING (current_user_role()::text IN ('admin', 'supervisor', 'david_review'));

DROP POLICY IF EXISTS "config_insert_admin" ON config;
CREATE POLICY "config_insert_admin"
  ON config FOR INSERT
  WITH CHECK (current_user_role()::text IN ('admin', 'supervisor', 'production_manager', 'david_review'));

DROP POLICY IF EXISTS "config_update_admin" ON config;
CREATE POLICY "config_update_admin"
  ON config FOR UPDATE
  USING (current_user_role()::text IN ('admin', 'supervisor', 'production_manager', 'david_review'));

-- Belt-and-suspenders grants (hosted DB)
GRANT SELECT, INSERT, UPDATE, DELETE ON product_workflows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON config TO authenticated;
