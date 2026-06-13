-- 061_catalog_product_material_names.sql
-- Align product + material names with Admin catalogue canonical list.
--   Folding Cartons / Boxes → Folding Cartons / Box
--   Boyd cardstock: 16pt → 16pt (Boyd), etc.
-- Idempotent text replacements on config JSON + order rows.

-- ── Orders ───────────────────────────────────────────────────────────────────
UPDATE public.orders
SET product_type = 'Folding Cartons / Box'
WHERE product_type = 'Folding Cartons / Boxes';

UPDATE public.orders
SET material = '16pt (Boyd)'
WHERE material = '16pt';

UPDATE public.orders
SET material = '18pt (Boyd)'
WHERE material = '18pt';

UPDATE public.orders
SET material = '20pt (Boyd)'
WHERE material = '20pt';

UPDATE public.orders
SET material = '24pt (Boyd)'
WHERE material = '24pt';

-- ── Product workflow templates ─────────────────────────────────────────────────
UPDATE public.product_workflows
SET product_name = 'Folding Cartons / Box'
WHERE product_name = 'Folding Cartons / Boxes';

-- ── Config catalogue (productCatalog, catalogMaterials) ──────────────────────
UPDATE public.config
SET value = replace(value::text, 'Folding Cartons / Boxes', 'Folding Cartons / Box')::jsonb
WHERE key IN ('productCatalog', 'catalogMaterials', 'pulseLeadTimes')
  AND value::text LIKE '%Folding Cartons / Boxes%';

UPDATE public.config
SET value = replace(value::text, '"16pt"', '"16pt (Boyd)"')::jsonb
WHERE key = 'catalogMaterials'
  AND value::text LIKE '%"16pt"%'
  AND value::text NOT LIKE '%16pt C1S%'
  AND value::text NOT LIKE '%16pt (Boyd)%';

UPDATE public.config
SET value = replace(value::text, '"18pt"', '"18pt (Boyd)"')::jsonb
WHERE key = 'catalogMaterials'
  AND value::text LIKE '%"18pt"%'
  AND value::text NOT LIKE '%18pt C1S%'
  AND value::text NOT LIKE '%18pt (Boyd)%';

UPDATE public.config
SET value = replace(value::text, '"20pt"', '"20pt (Boyd)"')::jsonb
WHERE key = 'catalogMaterials'
  AND value::text LIKE '%"20pt"%'
  AND value::text NOT LIKE '%20pt (Boyd)%';

UPDATE public.config
SET value = replace(value::text, '"24pt"', '"24pt (Boyd)"')::jsonb
WHERE key = 'catalogMaterials'
  AND value::text LIKE '%"24pt"%'
  AND value::text NOT LIKE '%24pt C1S%'
  AND value::text NOT LIKE '%24pt (Boyd)%';

-- Product catalogue material lists (Sheet Products Boyd + Other)
UPDATE public.config
SET value = replace(value::text, '"18pt (Boyd)","20pt (Boyd)","24pt (Boyd)"', '"16pt (Boyd)","18pt (Boyd)","20pt (Boyd)","24pt (Boyd)"')::jsonb
WHERE key = 'productCatalog'
  AND value::text LIKE '%Sheet Products (Boyd)%'
  AND value::text LIKE '%18pt (Boyd)%'
  AND value::text NOT LIKE '%16pt (Boyd)%';
