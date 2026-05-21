-- Remove CRM / Instagram / post-sale tables (not used by core Pulse ops).
-- Keeps design_tasks, proofs, shipping_tasks from migration 010.

-- post_sale_tasks
DROP POLICY IF EXISTS "post_sale_tasks_write_auth" ON post_sale_tasks;
DROP POLICY IF EXISTS "post_sale_tasks_read_auth" ON post_sale_tasks;
DROP TRIGGER IF EXISTS post_sale_tasks_updated_at ON post_sale_tasks;
DROP TABLE IF EXISTS post_sale_tasks CASCADE;

-- leads / deals (circular FK)
DROP POLICY IF EXISTS "leads_write_auth" ON leads;
DROP POLICY IF EXISTS "leads_read_auth" ON leads;
DROP POLICY IF EXISTS "deals_write_auth" ON deals;
DROP POLICY IF EXISTS "deals_read_auth" ON deals;
DROP TRIGGER IF EXISTS leads_updated_at ON leads;
DROP TRIGGER IF EXISTS deals_updated_at ON deals;
ALTER TABLE IF EXISTS leads DROP CONSTRAINT IF EXISTS leads_deal_id_fk;
DROP TABLE IF EXISTS leads CASCADE;
DROP TABLE IF EXISTS deals CASCADE;

-- instagram_leads (009)
DROP POLICY IF EXISTS ig_leads_delete ON instagram_leads;
DROP POLICY IF EXISTS ig_leads_update ON instagram_leads;
DROP POLICY IF EXISTS ig_leads_insert ON instagram_leads;
DROP POLICY IF EXISTS ig_leads_select ON instagram_leads;
DROP TRIGGER IF EXISTS instagram_leads_updated_at ON instagram_leads;
DROP TABLE IF EXISTS instagram_leads CASCADE;

-- Enums (only used by dropped tables)
DROP TYPE IF EXISTS post_sale_status CASCADE;
DROP TYPE IF EXISTS lead_status CASCADE;
DROP TYPE IF EXISTS lead_source CASCADE;
DROP TYPE IF EXISTS deal_status CASCADE;
DROP TYPE IF EXISTS ig_lead_stage CASCADE;
DROP TYPE IF EXISTS ig_lead_score CASCADE;
