-- Product workflow configuration (admin Product Workflows tab)

CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  facility      TEXT NOT NULL CHECK (facility IN ('16th', 'boyd')),
  category      TEXT NOT NULL CHECK (category IN ('press', 'lamination', 'cutting', 'finishing', 'pouching', 'folding')),
  capabilities  TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER machines_updated_at
  BEFORE UPDATE ON machines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS product_workflows (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_catalog_id TEXT UNIQUE NOT NULL,
  product_name       TEXT NOT NULL,
  primary_facility   TEXT NOT NULL CHECK (primary_facility IN ('16th', 'boyd')),
  steps              JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER product_workflows_updated_at
  BEFORE UPDATE ON product_workflows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX product_workflows_catalog_id_idx ON product_workflows(product_catalog_id);

ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "machines_select"
  ON machines FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "machines_insert_admin"
  ON machines FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "machines_update_admin"
  ON machines FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "machines_delete_admin"
  ON machines FOR DELETE
  USING (current_user_role() = 'admin');

CREATE POLICY "product_workflows_select"
  ON product_workflows FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "product_workflows_insert_admin"
  ON product_workflows FOR INSERT
  WITH CHECK (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "product_workflows_update_admin"
  ON product_workflows FOR UPDATE
  USING (current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "product_workflows_delete_admin"
  ON product_workflows FOR DELETE
  USING (current_user_role() = 'admin');

-- Seed machines (spec section 2)
INSERT INTO machines (id, name, display_name, facility, category, capabilities) VALUES
  ('press-6k', 'HP Indigo 6K', 'HP Indigo 6K', '16th', 'press', ARRAY['labels', 'pouches', 'sheet-labels']),
  ('press-15k', 'HP Indigo 15K', 'HP Indigo 15K', '16th', 'press', ARRAY['folding-cartons', 'cardstock', 'sheet']),
  ('nobelus', 'Nobelus Laminator', 'Laminator (Nobelus)', '16th', 'lamination', ARRAY['gloss', 'matte', 'soft-touch', 'holo']),
  ('scodix', 'Scodix', 'Scodix', '16th', 'finishing', ARRAY['spot-uv', 'foil', 'embossing']),
  ('karlville', 'Karlville Poucher', 'Karlville Poucher', '16th', 'pouching', ARRAY['pouches']),
  ('gm-die-cutter', 'GM Die Cutter w/ JetFX', 'GM Die Cutter w/ JetFX', '16th', 'cutting', ARRAY['die-cut', 'uv', 'foil', 'lamination']),
  ('gm-laser-cutter', 'GM Laser Cutter w/ JetFX', 'GM Laser Cutter w/ JetFX', '16th', 'cutting', ARRAY['laser-cut', 'uv', 'foil', 'lamination', 'perforation']),
  ('moll-cutter', 'Moll Brothers Cutter', 'Moll Brothers Cutter', '16th', 'cutting', ARRAY['box-cutting']),
  ('moll-folder', 'Moll Brothers Folder-Gluer', 'Moll Brothers Folder-Gluer', '16th', 'folding', ARRAY['fold-glue']),
  ('duplo', 'Duplo', 'Duplo', '16th', 'cutting', ARRAY['flatbed-cut', 'score', 'crease']),
  ('guillotine', 'Guillotine Cutter', 'Guillotine Cutter', '16th', 'cutting', ARRAY['trim']),
  ('uv-coater', 'UV Coater', 'UV Coater', '16th', 'finishing', ARRAY['uv-coat']),
  ('booklet-folder', 'Booklet Folder', 'Booklet Folder', '16th', 'folding', ARRAY['booklet-fold']),
  ('canon-colorado', 'Canon Colorado', 'Canon Colorado', 'boyd', 'press', ARRAY['gloss', 'cmyk']),
  ('roland', 'Roland Printer', 'Roland Printers', 'boyd', 'press', ARRAY['matte', 'cmyk', 'white']),
  ('graphtec-vinyl', 'Graphtec Vinyl Cutter', 'Graphtec Vinyl Cutter x4', 'boyd', 'cutting', ARRAY['vinyl', 'contour']),
  ('graphtec-flatbed', 'Graphtec Flatbed', 'Graphtec Flatbed (Large) x2', 'boyd', 'cutting', ARRAY['sheet', 'flatbed']),
  ('boyd-laminator', 'Boyd Laminator', 'Laminator (Boyd)', 'boyd', 'lamination', ARRAY['sheets-only'])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  facility = EXCLUDED.facility,
  category = EXCLUDED.category,
  capabilities = EXCLUDED.capabilities;
