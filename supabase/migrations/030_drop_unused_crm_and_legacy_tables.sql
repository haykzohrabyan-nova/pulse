-- =============================================================================
-- Drop CRM, Instagram, and legacy task/catalog tables not used by slim Pulse.
--
-- KEEPS (production Pulse): orders, order_workflow_steps, order_comments,
-- order_files, activity_log, config, machines, product_workflows,
-- workflow_override_log, organisations*, dies, knowledge_base, operator_*,
-- invoices, profiles, production_tasks (prepress), proofs* (prepress joins),
-- design_tasks (job-ticket optional).
--
-- NOT dropped here (remove in a follow-up if you retire prepress proof queue):
--   proofs, proof_versions, proof_approval_events, design_tasks
--
-- Apply: npx supabase db push --linked --yes
-- Destructive — back up first if any team still uses CRM / PO / packaging in SQL.
-- =============================================================================

BEGIN;

-- Remove from Realtime publication (ignore if not subscribed)
DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'post_sale_tasks',
    'shipping_tasks',
    'packaging_products',
    'purchase_order_items',
    'purchase_orders',
    'qc_tasks',
    'qc_records',
    'deals',
    'leads',
    'instagram_leads',
    'workflow_templates'
  ]
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I', t);
    EXCEPTION
      WHEN undefined_object THEN NULL;
      WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $do$;

-- Break circular FK between leads ↔ deals
ALTER TABLE IF EXISTS public.leads
  DROP CONSTRAINT IF EXISTS leads_deal_id_fk;

-- Child / dependent tables first
DROP TABLE IF EXISTS public.post_sale_tasks CASCADE;
DROP TABLE IF EXISTS public.shipping_tasks CASCADE;
DROP TABLE IF EXISTS public.purchase_order_items CASCADE;
DROP TABLE IF EXISTS public.purchase_orders CASCADE;
DROP TABLE IF EXISTS public.qc_tasks CASCADE;
DROP TABLE IF EXISTS public.qc_records CASCADE;
DROP TABLE IF EXISTS public.packaging_products CASCADE;

-- CRM pipeline
DROP TABLE IF EXISTS public.deals CASCADE;
DROP TABLE IF EXISTS public.leads CASCADE;
DROP TABLE IF EXISTS public.instagram_leads CASCADE;

-- Superseded by product_workflows (022)
DROP TABLE IF EXISTS public.workflow_templates CASCADE;

-- Orphan enums (safe after tables gone)
DROP TYPE IF EXISTS public.post_sale_status CASCADE;
DROP TYPE IF EXISTS public.shipping_task_status CASCADE;
DROP TYPE IF EXISTS public.qc_task_status CASCADE;
DROP TYPE IF EXISTS public.packaging_category CASCADE;
DROP TYPE IF EXISTS public.deal_status CASCADE;
DROP TYPE IF EXISTS public.lead_status CASCADE;
DROP TYPE IF EXISTS public.lead_source CASCADE;
DROP TYPE IF EXISTS public.ig_lead_stage CASCADE;
DROP TYPE IF EXISTS public.ig_lead_score CASCADE;

COMMIT;
