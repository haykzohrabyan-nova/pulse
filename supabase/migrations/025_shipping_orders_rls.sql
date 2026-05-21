-- Shipping role: read/update orders in the fulfillment pipeline (shipping station UI)

CREATE POLICY "orders_select_shipping"
  ON orders FOR SELECT
  USING (
    current_user_role() = 'shipping'
    AND status IN (
      'ready-to-ship',
      'waiting-pickup',
      'delivery-ready',
      'shipped',
      'received',
      'completed',
      'qc-checkout'
    )
  );

CREATE POLICY "orders_update_shipping"
  ON orders FOR UPDATE
  USING (
    current_user_role() = 'shipping'
    AND status IN (
      'ready-to-ship',
      'waiting-pickup',
      'delivery-ready',
      'shipped',
      'received'
    )
  )
  WITH CHECK (
    current_user_role() = 'shipping'
    AND status IN (
      'ready-to-ship',
      'waiting-pickup',
      'delivery-ready',
      'shipped',
      'received',
      'completed'
    )
  );
