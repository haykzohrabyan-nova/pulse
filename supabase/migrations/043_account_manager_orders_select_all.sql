-- Account managers need to see ALL orders in the queue so they can
-- track production across all reps. UI-level locking (applyEditLock)
-- prevents them from editing orders that aren't assigned to them.
--
-- The old policy only showed orders where account_manager = their own name,
-- which made the queue empty for new reps with no orders yet.

DROP POLICY IF EXISTS "orders_select_account_manager" ON orders;

CREATE POLICY "orders_select_account_manager"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'account_manager'
  );
