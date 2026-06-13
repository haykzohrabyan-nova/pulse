-- =============================================================================
-- Pulse: wipe all job tickets (orders) and order-related audit / billing rows
-- =============================================================================
-- Destructive and irreversible. Intended for a clean start (0 orders).
-- Removes: activity_log, invoices (+ line items via FK), orders and all rows
--          that reference orders with ON DELETE CASCADE (workflow steps, QC
--          records, production_tasks, qc_tasks, proofs chain, design_tasks,
--          shipping_tasks, post_sale_tasks, order_files, order_comments,
--          pickup_verifications, workflow_override_log, order_status_history, etc.).
-- Preserves: profiles, auth users, customers, machines, materials, leads,
--            deals (converted_to_order_id is set NULL), inventory header rows.
-- Apply via Supabase SQL editor or your migration runner.
-- =============================================================================

BEGIN;

DELETE FROM public.activity_log;

DELETE FROM public.invoices;

DELETE FROM public.orders;

COMMIT;
