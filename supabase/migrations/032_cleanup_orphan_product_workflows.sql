-- Remove product_workflows rows whose catalog id no longer exists in config.productCatalog.
-- (Happens after catalogue reset / re-import with new product ids.)

DELETE FROM public.product_workflows pw
WHERE NOT EXISTS (
  SELECT 1
  FROM public.config c,
       jsonb_array_elements(c.value) AS p
  WHERE c.key = 'productCatalog'
    AND p->>'id' = pw.product_catalog_id
);
