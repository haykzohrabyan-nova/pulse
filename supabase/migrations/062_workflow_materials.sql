-- 062_workflow_materials.sql
-- Add workflow-common materials to catalogMaterials and Pouches product list.
-- Idempotent: skips items/categories that already exist.

DO $$
DECLARE
  mats jsonb;
  prods jsonb;
  i int;
  items jsonb;
  item text;
  merged jsonb;
  pouch_materials text[] := ARRAY[
    'Clear BOPP', 'White BOPP', 'Clear Cosmetic Web', 'White Cosmetic Web', 'Silver Cosmetic Web',
    'Clear PET', 'Kraft Paper', 'Foil Silver', 'Foil Gold'
  ];
BEGIN
  SELECT value INTO mats FROM public.config WHERE key = 'catalogMaterials';
  IF mats IS NULL THEN
    RETURN;
  END IF;

  -- Ensure BOPP category includes Clear/White BOPP
  FOR i IN 0 .. jsonb_array_length(mats) - 1 LOOP
    IF mats->i->>'category' = 'BOPP' THEN
      items := COALESCE(mats->i->'items', '[]'::jsonb);
      FOREACH item IN ARRAY ARRAY['Clear BOPP', 'White BOPP'] LOOP
        IF NOT items @> to_jsonb(ARRAY[item]) THEN
          items := items || to_jsonb(item);
        END IF;
      END LOOP;
      mats := jsonb_set(mats, ARRAY[i::text, 'items'], items);
    END IF;
  END LOOP;

  -- Add PET category if missing
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(mats) e WHERE e->>'category' = 'PET'
  ) THEN
    mats := mats || jsonb_build_array(jsonb_build_object('category', 'PET', 'items', '["Clear PET"]'::jsonb));
  ELSE
    FOR i IN 0 .. jsonb_array_length(mats) - 1 LOOP
      IF mats->i->>'category' = 'PET' THEN
        items := COALESCE(mats->i->'items', '[]'::jsonb);
        IF NOT items @> '["Clear PET"]'::jsonb THEN
          items := items || '"Clear PET"'::jsonb;
          mats := jsonb_set(mats, ARRAY[i::text, 'items'], items);
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Add Specialty category if missing
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(mats) e WHERE e->>'category' = 'Specialty'
  ) THEN
    mats := mats || jsonb_build_array(jsonb_build_object(
      'category', 'Specialty',
      'items', '["Kraft Paper","Foil Silver","Foil Gold"]'::jsonb
    ));
  ELSE
    FOR i IN 0 .. jsonb_array_length(mats) - 1 LOOP
      IF mats->i->>'category' = 'Specialty' THEN
        items := COALESCE(mats->i->'items', '[]'::jsonb);
        FOREACH item IN ARRAY ARRAY['Kraft Paper', 'Foil Silver', 'Foil Gold'] LOOP
          IF NOT items @> to_jsonb(ARRAY[item]) THEN
            items := items || to_jsonb(item);
          END IF;
        END LOOP;
        mats := jsonb_set(mats, ARRAY[i::text, 'items'], items);
      END IF;
    END LOOP;
  END IF;

  UPDATE public.config SET value = mats WHERE key = 'catalogMaterials';

  -- Merge materials into Pouches product entry
  SELECT value INTO prods FROM public.config WHERE key = 'productCatalog';
  IF prods IS NULL THEN
    RETURN;
  END IF;

  FOR i IN 0 .. jsonb_array_length(prods) - 1 LOOP
    IF prods->i->>'name' = 'Pouches' THEN
      merged := COALESCE(prods->i->'materials', '[]'::jsonb);
      FOREACH item IN ARRAY pouch_materials LOOP
        IF NOT merged @> to_jsonb(ARRAY[item]) THEN
          merged := merged || to_jsonb(item);
        END IF;
      END LOOP;
      prods := jsonb_set(prods, ARRAY[i::text, 'materials'], merged);
      EXIT;
    END IF;
  END LOOP;

  UPDATE public.config SET value = prods WHERE key = 'productCatalog';
END $$;
