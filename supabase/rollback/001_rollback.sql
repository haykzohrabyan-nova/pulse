-- =============================================================================
-- PRI-236: Pulse Supabase Schema — ROLLBACK for migrations 001 + 002
-- Run this to fully undo the Pulse schema.
-- WARNING: This destroys all data. Only run on staging or in emergency.
-- =============================================================================

-- Disable realtime first
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS orders;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS order_workflow_steps;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS order_comments;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS activity_log;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS operator_sessions;

-- Drop RLS helper functions
DROP FUNCTION IF EXISTS current_user_role();
DROP FUNCTION IF EXISTS current_user_facility();

-- Drop auth trigger + function
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS handle_new_user();
DROP FUNCTION IF EXISTS update_updated_at();

-- ---------------------------------------------------------------------------
-- Drop tables in dependency order (children before parents)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS config                   CASCADE;
DROP TABLE IF EXISTS knowledge_base           CASCADE;
DROP TABLE IF EXISTS invoice_line_items       CASCADE;
DROP TABLE IF EXISTS invoices                 CASCADE;
DROP TABLE IF EXISTS qc_records               CASCADE;
DROP TABLE IF EXISTS purchase_order_items     CASCADE;
DROP TABLE IF EXISTS purchase_orders          CASCADE;
DROP TABLE IF EXISTS inventory_usage          CASCADE;
DROP TABLE IF EXISTS inventory                CASCADE;
DROP TABLE IF EXISTS materials                CASCADE;
DROP TABLE IF EXISTS operator_points          CASCADE;
DROP TABLE IF EXISTS operator_breaks          CASCADE;
DROP TABLE IF EXISTS operator_sessions        CASCADE;
DROP TABLE IF EXISTS dies                     CASCADE;
DROP TABLE IF EXISTS workflow_templates       CASCADE;
DROP TABLE IF EXISTS machine_issues           CASCADE;
DROP TABLE IF EXISTS machines                 CASCADE;
DROP TABLE IF EXISTS activity_log             CASCADE;
DROP TABLE IF EXISTS order_comments           CASCADE;
DROP TABLE IF EXISTS order_files              CASCADE;
DROP TABLE IF EXISTS order_status_history     CASCADE;
DROP TABLE IF EXISTS order_workflow_steps     CASCADE;
DROP TABLE IF EXISTS orders                   CASCADE;
DROP TABLE IF EXISTS customers                CASCADE;
DROP TABLE IF EXISTS profiles                 CASCADE;

-- ---------------------------------------------------------------------------
-- Drop enums
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS user_role       CASCADE;
DROP TYPE IF EXISTS facility        CASCADE;
DROP TYPE IF EXISTS order_status    CASCADE;
DROP TYPE IF EXISTS step_status     CASCADE;
DROP TYPE IF EXISTS die_status      CASCADE;
DROP TYPE IF EXISTS die_condition   CASCADE;
DROP TYPE IF EXISTS po_status       CASCADE;
DROP TYPE IF EXISTS invoice_status  CASCADE;
DROP TYPE IF EXISTS file_category   CASCADE;
DROP TYPE IF EXISTS alert_severity  CASCADE;
DROP TYPE IF EXISTS reprint_reason  CASCADE;

-- Done. Schema fully removed.
