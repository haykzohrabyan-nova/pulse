-- 055_grant_service_role_pickup.sql
-- Edge Functions authenticate as service_role. Schema USAGE exists (028) but table
-- grants were never granted to service_role, causing send-pickup-code to fail with
-- "Order not found" (Postgres 42501 permission denied).

GRANT SELECT ON TABLE public.orders TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pickup_verifications TO service_role;
