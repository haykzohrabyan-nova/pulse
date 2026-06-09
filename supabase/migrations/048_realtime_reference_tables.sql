-- Enable Supabase Realtime for shared reference tables (config, dies, org, etc.)
-- so all clients refresh when admin or another user changes catalog data.
-- Idempotent: skips missing tables and tables already in supabase_realtime.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'config',
    'dies',
    'knowledge_base',
    'profiles',
    'organisation_facilities',
    'organisation_hardware',
    'machines',
    'product_workflows',
    'machine_issues',
    'qc_tasks'  -- omitted on DBs where 030 dropped this table
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c ON c.oid = pr.prrelid
      WHERE p.pubname = 'supabase_realtime' AND c.relname = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;
