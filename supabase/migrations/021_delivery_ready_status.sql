-- Shipping station: delivery-ready column + waiting-pickup enum (if missing)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'order_status' AND e.enumlabel = 'waiting-pickup'
  ) THEN
    ALTER TYPE order_status ADD VALUE 'waiting-pickup';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'order_status' AND e.enumlabel = 'delivery-ready'
  ) THEN
    ALTER TYPE order_status ADD VALUE 'delivery-ready';
  END IF;
END $$;

-- Backfill: orders that already have carrier tracking or ship method on packing slip
UPDATE orders
SET
  status = 'delivery-ready',
  specs = COALESCE(specs, '{}'::jsonb) || jsonb_build_object(
    'deliveryReadyAt',
    COALESCE(specs->>'deliveryReadyAt', specs->>'waitingPickupAt', NOW()::text)
  )
WHERE status = 'waiting-pickup'
  AND (
    COALESCE(specs->>'trackingNumber', '') <> ''
    OR COALESCE(specs->'packingSlip'->>'method', '') IN (
      'traditional-carrier', 'freight', 'local-pickup', 'courier'
    )
  );
