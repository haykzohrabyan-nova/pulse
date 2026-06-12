-- =============================================================================
-- Organisation (single-tenant): profile, facilities, hardware + RLS
--
-- FOLLOW-UP (separate migration / product work):
--   - Change orders.facility from Postgres ENUM `facility` to TEXT or UUID FK
--     referencing organisation_facilities.id so new locations work on job tickets.
--   - Update current_user_facility() / profiles.facility and RLS in 002 as needed.
--   - Optionally hydrate shared.js FACILITIES / MACHINES from these tables at runtime.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organisations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL DEFAULT 'Bazaar Print',
  short_description TEXT NOT NULL DEFAULT '',
  logo_url          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.organisation_facilities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   UUID NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, slug)
);

CREATE INDEX IF NOT EXISTS organisation_facilities_org_idx
  ON public.organisation_facilities(organisation_id);

CREATE TABLE IF NOT EXISTS public.organisation_hardware (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id             UUID NOT NULL REFERENCES public.organisation_facilities(id) ON DELETE CASCADE,
  machine_name            TEXT NOT NULL,
  operations              TEXT[] NOT NULL DEFAULT '{}',
  daily_capacity_value    NUMERIC,
  daily_capacity_unit     TEXT CHECK (
    daily_capacity_unit IS NULL
    OR daily_capacity_unit IN ('sheets', 'sq_ft', 'units', 'none')
  ),
  notes                   TEXT NOT NULL DEFAULT '',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS organisation_hardware_facility_idx
  ON public.organisation_hardware(facility_id);

DROP TRIGGER IF EXISTS organisations_updated_at ON public.organisations;
CREATE TRIGGER organisations_updated_at
  BEFORE UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS organisation_facilities_updated_at ON public.organisation_facilities;
CREATE TRIGGER organisation_facilities_updated_at
  BEFORE UPDATE ON public.organisation_facilities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS organisation_hardware_updated_at ON public.organisation_hardware;
CREATE TRIGGER organisation_hardware_updated_at
  BEFORE UPDATE ON public.organisation_hardware
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_hardware ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organisations_select_auth" ON public.organisations;
DROP POLICY IF EXISTS "organisations_insert_managers" ON public.organisations;
DROP POLICY IF EXISTS "organisations_update_managers" ON public.organisations;
DROP POLICY IF EXISTS "organisations_delete_managers" ON public.organisations;
DROP POLICY IF EXISTS "organisation_facilities_select_auth" ON public.organisation_facilities;
DROP POLICY IF EXISTS "organisation_facilities_insert_managers" ON public.organisation_facilities;
DROP POLICY IF EXISTS "organisation_facilities_update_managers" ON public.organisation_facilities;
DROP POLICY IF EXISTS "organisation_facilities_delete_managers" ON public.organisation_facilities;
DROP POLICY IF EXISTS "organisation_hardware_select_auth" ON public.organisation_hardware;
DROP POLICY IF EXISTS "organisation_hardware_insert_managers" ON public.organisation_hardware;
DROP POLICY IF EXISTS "organisation_hardware_update_managers" ON public.organisation_hardware;
DROP POLICY IF EXISTS "organisation_hardware_delete_managers" ON public.organisation_hardware;

-- Read: any signed-in user (future: job ticket facility dropdown from DB)
CREATE POLICY "organisations_select_auth"
  ON public.organisations FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "organisation_facilities_select_auth"
  ON public.organisation_facilities FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "organisation_hardware_select_auth"
  ON public.organisation_hardware FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Write: admin, supervisor, production managers, david review, ops
CREATE POLICY "organisations_insert_managers"
  ON public.organisations FOR INSERT
  WITH CHECK (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisations_update_managers"
  ON public.organisations FOR UPDATE
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  )
  WITH CHECK (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisations_delete_managers"
  ON public.organisations FOR DELETE
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisation_facilities_insert_managers"
  ON public.organisation_facilities FOR INSERT
  WITH CHECK (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisation_facilities_update_managers"
  ON public.organisation_facilities FOR UPDATE
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  )
  WITH CHECK (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisation_facilities_delete_managers"
  ON public.organisation_facilities FOR DELETE
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisation_hardware_insert_managers"
  ON public.organisation_hardware FOR INSERT
  WITH CHECK (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisation_hardware_update_managers"
  ON public.organisation_hardware FOR UPDATE
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  )
  WITH CHECK (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "organisation_hardware_delete_managers"
  ON public.organisation_hardware FOR DELETE
  USING (
    current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket for organisation logos (public read; authenticated upload)
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'org-assets',
  'org-assets',
  TRUE,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "org_assets_select_public" ON storage.objects;
DROP POLICY IF EXISTS "org_assets_insert_managers" ON storage.objects;
DROP POLICY IF EXISTS "org_assets_update_managers" ON storage.objects;
DROP POLICY IF EXISTS "org_assets_delete_managers" ON storage.objects;

CREATE POLICY "org_assets_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'org-assets');

CREATE POLICY "org_assets_insert_managers"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'org-assets'
    AND current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "org_assets_update_managers"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'org-assets'
    AND current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

CREATE POLICY "org_assets_delete_managers"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'org-assets'
    AND current_user_role() IN (
      'admin', 'supervisor', 'production_manager', 'david_review', 'ops_manager'
    )
  );

-- ---------------------------------------------------------------------------
-- Seed (only when tables are empty)
-- ---------------------------------------------------------------------------

INSERT INTO public.organisations (name, short_description)
SELECT 'Bazaar Print', 'Master production organisation for Pulse — facilities and hardware below.'
WHERE NOT EXISTS (SELECT 1 FROM public.organisations LIMIT 1);

INSERT INTO public.organisation_facilities (organisation_id, slug, name, description, sort_order)
SELECT o.id, v.slug, v.name, v.description, v.sort_order
FROM public.organisations o
CROSS JOIN (VALUES
  ('16th-street', '16th Street — Main Production', 'Primary sheetfed, Indigo, finishing, and application.', 0),
  ('boyd-street', 'Boyd Street — Design & Large Format', 'Large-format print, vinyl, and Boyd sheet workflows.', 1)
) AS v(slug, name, description, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.organisation_facilities f WHERE f.organisation_id = o.id AND f.slug = v.slug
);

-- Hardware rows aligned with shared.js MACHINES + MACHINE_CAPACITY (defaults)
INSERT INTO public.organisation_hardware (
  facility_id, machine_name, operations, daily_capacity_value, daily_capacity_unit, notes, sort_order
)
SELECT f.id, v.machine_name, v.operations::text[], v.cap_val, v.cap_unit, v.notes, v.sort_order
FROM public.organisation_facilities f
CROSS JOIN (VALUES
  ('16th-street', 'Prepress', ARRAY['File Prep','Artwork Fix','Preflight','Proofing']::text[], NULL::numeric, NULL::text, 'Prepress review, file correction, proofing, and setup before production restarts.', 0),
  ('16th-street', 'HP Indigo 6K', ARRAY['Printing']::text[], 4200, 'sheets', '~30m/min × 7hr typical with setup.', 1),
  ('16th-street', 'HP Indigo 15K', ARRAY['Printing']::text[], 21000, 'sheets', '~3,000 sheets/hr × 7hr typical.', 2),
  ('16th-street', 'Laminator (Nobelus)', ARRAY['Laminating']::text[], 7000, 'sheets', '~1,000 sheets/hr × 7hr.', 3),
  ('16th-street', 'Scodix', ARRAY['Spot UV','Foil Stamping','Embossing','Texture']::text[], 4550, 'sheets', '~650 sheets/hr × 7hr.', 4),
  ('16th-street', 'Karlville Poucher', ARRAY['Pouching']::text[], 22500, 'units', '~22,500/shift standard.', 5),
  ('16th-street', 'Moll Brothers Cutter', ARRAY['Cutting']::text[], 17500, 'sheets', '~2,500 sheets/hr × 7hr.', 6),
  ('16th-street', 'Moll Brothers Folder-Gluer', ARRAY['Folding','Gluing']::text[], 70000, 'units', '~10,000 boxes/hr × 7hr mid-size.', 7),
  ('16th-street', 'Duplo', ARRAY['Flatbed Cutting','Scoring','Creasing']::text[], 84, 'sheets', '15K sheet size only (750mm x 550mm). Small runs under ~200 sheets.', 8),
  ('16th-street', 'GM Die Cutter w/ JetFX', ARRAY['Die Cutting','UV Finishing','Foil Finishing','Laminating']::text[], 4200, 'sheets', 'Multi-function: cuts + UV + foil via JetFX.', 9),
  ('16th-street', 'GM Laser Cutter w/ JetFX', ARRAY['Laser Cutting','UV Finishing','Foil Finishing','Laminating']::text[], 1400, 'sheets', '~10m/min. Complex shapes slower.', 10),
  ('16th-street', 'Guillotine Cutter', ARRAY['Guillotine Cutting']::text[], 35000, 'sheets', 'Very fast.', 11),
  ('16th-street', 'UV Coater', ARRAY['UV Coating']::text[], 4000, 'sheets', 'Inline UV coating.', 12),
  ('16th-street', 'Booklet Folder', ARRAY['Booklet Folding']::text[], NULL::numeric, 'none', '', 13),
  ('16th-street', 'Application Dept', ARRAY['Label Application','Hand Gluing','Assembly']::text[], 6000, 'units', '~2,000 units/person/day × 3 people.', 14),
  ('boyd-street', 'Canon Colorado', ARRAY['Printing']::text[], 2000, 'sq_ft', 'Large format. CMYK only. GLOSS materials ONLY.', 0),
  ('boyd-street', 'Roland Printers', ARRAY['Printing']::text[], 35, 'sheets', '~12min/sheet × 3 machines. MATTE materials ONLY.', 1),
  ('boyd-street', 'Graphtec Vinyl Cutter x4', ARRAY['Vinyl Cutting','Contour Cutting']::text[], NULL::numeric, 'none', 'Count: 4.', 2),
  ('boyd-street', 'Graphtec Flatbed (Large) x2', ARRAY['Flatbed Cutting']::text[], 168, 'sheets', '36"x70" max. 15K overflow / Boyd-printed sheets.', 3),
  ('boyd-street', 'Graphtec Flatbed (Small)', ARRAY['Flatbed Cutting']::text[], 84, 'sheets', '36"x48" max.', 4),
  ('boyd-street', 'Laminator (Boyd)', ARRAY['Laminating']::text[], 280, 'sheets', 'Sheet products only. Labels do NOT get laminated at Boyd.', 5)
) AS v(fac_slug, machine_name, operations, cap_val, cap_unit, notes, sort_order)
WHERE f.slug = v.fac_slug
  AND NOT EXISTS (
    SELECT 1 FROM public.organisation_hardware h
    WHERE h.facility_id = f.id AND h.machine_name = v.machine_name
  );
