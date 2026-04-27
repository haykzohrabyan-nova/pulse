-- =============================================================================
-- PRI-238: Add dedicated QC role
-- Confirmed by Hayk: Pulse needs a dedicated QC Inspector role for production launch.
-- Managers (supervisor, production_manager, david_review) retain their existing
-- qc-checkout page access; this migration adds the `qc` enum value and the
-- minimal RLS policies needed for a dedicated QC login.
-- Generated: 2026-04-27
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend user_role enum
-- Note: Postgres requires ADD VALUE outside a transaction for enum changes.
-- Run this statement separately if your migration runner uses transactions.
-- ---------------------------------------------------------------------------

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'qc';

-- ---------------------------------------------------------------------------
-- 2. QC RECORDS — give qc role read + insert access
-- Previously: admin, supervisor, production_manager, prepress, david_review
-- Now adds: qc (they are the dedicated inspector)
-- ---------------------------------------------------------------------------

-- SELECT
CREATE POLICY "qc_records_select_qc"
  ON qc_records FOR SELECT
  USING (current_user_role() = 'qc');

-- INSERT: qc role can submit inspection results
CREATE POLICY "qc_records_insert_qc"
  ON qc_records FOR INSERT
  WITH CHECK (current_user_role() = 'qc');

-- ---------------------------------------------------------------------------
-- 3. ORDERS — qc role reads orders in qc-checkout status and can update them
-- (to move from qc-checkout → ready-to-ship or flag qc-failed)
-- ---------------------------------------------------------------------------

-- SELECT: qc sees only orders currently at the QC stage
CREATE POLICY "orders_select_qc"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'qc'
    AND status IN ('qc-checkout', 'qc-failed')
  );

-- UPDATE: qc can update orders that are in qc-checkout status
-- (allows setting status to ready-to-ship, qc-failed, or adding notes)
CREATE POLICY "orders_update_qc"
  ON orders FOR UPDATE
  USING (
    current_user_role() = 'qc'
    AND status IN ('qc-checkout', 'qc-failed')
  );

-- ---------------------------------------------------------------------------
-- 4. ORDER WORKFLOW STEPS — qc can read steps for orders they can access
-- (already covered by the authenticated policy in 002, but explicit for clarity)
-- ---------------------------------------------------------------------------
-- No additional policy needed — order_workflow_steps_select_authenticated
-- already grants SELECT to any authenticated user.

-- ---------------------------------------------------------------------------
-- 5. ORDER STATUS HISTORY — qc can insert status change records
-- (already covered by order_status_history_insert in 002)
-- ---------------------------------------------------------------------------
-- No additional policy needed.

-- ---------------------------------------------------------------------------
-- 6. PROFILES — qc can read their own profile (already covered by
-- profiles_select_self in 002)
-- ---------------------------------------------------------------------------
-- No additional policy needed.
