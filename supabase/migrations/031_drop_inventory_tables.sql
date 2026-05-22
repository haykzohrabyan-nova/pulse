-- =============================================================================
-- Drop inventory stock tracking tables (app uses IndexedDB only; tables unused).
--
-- Apply: npx supabase db push --linked --yes
-- =============================================================================

BEGIN;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_usage', 'inventory']
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I', t);
    EXCEPTION
      WHEN undefined_object THEN NULL;
      WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $do$;

DROP TABLE IF EXISTS public.inventory_usage CASCADE;
DROP TABLE IF EXISTS public.inventory CASCADE;

COMMIT;
