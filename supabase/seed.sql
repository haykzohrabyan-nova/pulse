-- =============================================================================
-- PRI-236: Pulse Supabase — Seed Data
-- Reference/lookup data only. No PII, no real orders.
-- Run after migrations 001 + 002.
-- Generated: 2026-04-27
-- =============================================================================

-- ---------------------------------------------------------------------------
-- MACHINES (24 machines across 2 facilities)
-- ---------------------------------------------------------------------------

INSERT INTO machines (name, facility, operations, products, notes) VALUES
-- 16th Street machines
('HP Indigo 6K',       '16th-street', ARRAY['Digital Print','CMYK','CMYK+White'], ARRAY['Labels','Pouches','Sheet Labels'], 'Primary label press. Handles roll and sheet label substrate.'),
('HP Indigo 15K',      '16th-street', ARRAY['Digital Print','CMYK','CMYK+W+V'], ARRAY['Folding Cartons','Boxes','Cardstock'], 'Primary carton press. High-volume sheet-fed.'),
('Laminator (Nobelus)','16th-street', ARRAY['Lamination','Gloss','Matte','Soft Touch','Holo'], ARRAY['Cartons','Labels'], 'Used AFTER 15K line. No lamination on 6K labels.'),
('Scodix',             '16th-street', ARRAY['Spot UV','Foil Stamping','Embossing','Texture'], ARRAY['Cartons','Boxes'], 'One-pass digital enhancement. No Scodix plates needed.'),
('Karlville Poucher',  '16th-street', ARRAY['Pouching','Sealing'], ARRAY['Stand-up Pouches','Flat Pouches','Barrier Bags'], 'Converts printed roll material into pouches.'),
('Moll Cutter',        '16th-street', ARRAY['Cutting','Die Cutting'], ARRAY['Cartons','Boxes'], 'Moll Brothers Cutter — separate from Folder-Gluer.'),
('Moll Folder-Gluer',  '16th-street', ARRAY['Folding','Gluing'], ARRAY['Cartons','Boxes'], 'Moll Brothers Folder-Gluer — used after cutting.'),
('Duplo',              '16th-street', ARRAY['Cutting','Scoring','Creasing'], ARRAY['Cards','Flat Sheets'], 'Flatbed finishing. Used for card/flat products.'),
('GM Die Cutter',      '16th-street', ARRAY['Die Cutting','UV Coating','Foil','Lamination'], ARRAY['Labels','Pouches'], 'Multi-function via JetFX. Used when physical die exists.'),
('GM Laser Cutter',    '16th-street', ARRAY['Laser Cutting','UV Coating','Foil','Lamination'], ARRAY['Labels','Pouches'], 'Multi-function via JetFX. Any shape — no die needed.'),
('Guillotine Cutter',  '16th-street', ARRAY['Cutting'], ARRAY['All Sheet Products'], 'Manual straight cuts. Used for booklets and trim.'),
('UV Coater',          '16th-street', ARRAY['UV Coating'], ARRAY['Cartons','Covers'], 'Full-flood UV coating station.'),
('Booklet Folder',     '16th-street', ARRAY['Folding','Booklet Assembly'], ARRAY['Booklets'], 'Used in booklet workflow after lamination.'),
-- Boyd Street machines
('Canon Colorado',     'boyd-street', ARRAY['Wide Format Print','CMYK'], ARRAY['Vinyl Signage','Banners'], 'GLOSS materials ONLY. CMYK, no white ink.'),
('Roland (CMYK+White)','boyd-street', ARRAY['Wide Format Print','CMYK','White','Gloss UV'], ARRAY['Vinyl','Specialty'], 'MATTE materials ONLY. Handles white and orange/red inks.'),
('Roland (CMYK)',      'boyd-street', ARRAY['Wide Format Print','CMYK'], ARRAY['Vinyl'], 'MATTE materials ONLY. Standard CMYK large format.'),
('Graphtec Vinyl x4',  'boyd-street', ARRAY['Vinyl Cutting','Contour Cut'], ARRAY['Vinyl Labels','Roll Stickers'], '4 units. Used for vinyl/roll material after printing.'),
('Graphtec Flatbed (Large) x2','boyd-street', ARRAY['Flatbed Cutting','Contour Cut'], ARRAY['Sheet Vinyl','Large Format'], '2 units. Sheet products after lamination.'),
('Graphtec Flatbed (Small)','boyd-street', ARRAY['Flatbed Cutting','Contour Cut'], ARRAY['Sheet Products'], '1 unit. Smaller sheet finishing.'),
('Laminator (Boyd)',   'boyd-street', ARRAY['Lamination','Gloss','Matte'], ARRAY['Sheet Products'], 'Sheet products ONLY. Labels do NOT get laminated here.');

-- ---------------------------------------------------------------------------
-- WORKFLOW TEMPLATES (18 standard production paths)
-- ---------------------------------------------------------------------------

INSERT INTO workflow_templates (name, label, facility, product_types, steps) VALUES
('15k-box-die',        'Box / Folding Carton (15K + Die)', '16th-street',
  ARRAY['Folding Cartons','Boxes'],
  '[{"machine":"HP Indigo 15K","operation":"Print"},{"machine":"Laminator (Nobelus)","operation":"Laminate"},{"machine":"Scodix","operation":"Spot UV / Foil","optional":true},{"machine":"Moll Cutter","operation":"Die Cut"},{"machine":"Moll Folder-Gluer","operation":"Fold & Glue"}]'::jsonb),

('15k-card-flat',      'Card / Flat Sheet (15K)', '16th-street',
  ARRAY['Cards','Flat Sheets'],
  '[{"machine":"HP Indigo 15K","operation":"Print"},{"machine":"Laminator (Nobelus)","operation":"Laminate"},{"machine":"Duplo","operation":"Cut & Score"}]'::jsonb),

('15k-booklet',        'Booklet (15K)', '16th-street',
  ARRAY['Booklets'],
  '[{"machine":"HP Indigo 15K","operation":"Print"},{"machine":"Laminator (Nobelus)","operation":"Laminate"},{"machine":"Booklet Folder","operation":"Fold"},{"machine":"Guillotine Cutter","operation":"Trim"}]'::jsonb),

('15k-box-uv-foil',    'Box w/ UV + Foil (15K + Scodix)', '16th-street',
  ARRAY['Folding Cartons','Boxes'],
  '[{"machine":"HP Indigo 15K","operation":"Print"},{"machine":"Laminator (Nobelus)","operation":"Laminate"},{"machine":"Scodix","operation":"UV + Foil Stamp"},{"machine":"Moll Cutter","operation":"Die Cut"},{"machine":"Moll Folder-Gluer","operation":"Fold & Glue"}]'::jsonb),

('6k-labels-die',      'Roll Labels with Die (6K + GM Die)', '16th-street',
  ARRAY['Labels','Roll Labels'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Die Cutter","operation":"Die Cut + Finish"}]'::jsonb),

('6k-labels-laser',    'Roll Labels without Die (6K + GM Laser)', '16th-street',
  ARRAY['Labels','Roll Labels'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Laser Cutter","operation":"Laser Cut + Finish"}]'::jsonb),

('6k-sheet-labels-die','Sheet Labels with Die (6K + GM Die)', '16th-street',
  ARRAY['Sheet Labels'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Die Cutter","operation":"Die Cut"}]'::jsonb),

('6k-sheet-labels-laser','Sheet Labels without Die (6K + GM Laser)', '16th-street',
  ARRAY['Sheet Labels'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Laser Cutter","operation":"Laser Cut"}]'::jsonb),

('6k-pouches',         'Stand-up Pouches (6K + GM + Karlville)', '16th-street',
  ARRAY['Pouches','Stand-up Pouches','Barrier Bags'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Die Cutter","operation":"Laminate + Finish"},{"machine":"Karlville Poucher","operation":"Pouch & Seal"}]'::jsonb),

('boyd-vinyl-gloss',   'Vinyl Signage — Gloss (Canon Colorado)', 'boyd-street',
  ARRAY['Vinyl Signage','Banners'],
  '[{"machine":"Canon Colorado","operation":"Print (CMYK Gloss)"},{"machine":"Graphtec Vinyl x4","operation":"Contour Cut"}]'::jsonb),

('boyd-vinyl-matte',   'Vinyl Signage — Matte (Roland)', 'boyd-street',
  ARRAY['Vinyl Signage','Stickers'],
  '[{"machine":"Roland (CMYK+White)","operation":"Print (CMYK+White Matte)"},{"machine":"Graphtec Vinyl x4","operation":"Contour Cut"}]'::jsonb),

('boyd-sheet-gloss',   'Sheet Product — Gloss (Canon + Flatbed)', 'boyd-street',
  ARRAY['Window Decals','Sheet Vinyl'],
  '[{"machine":"Canon Colorado","operation":"Print (CMYK Gloss)"},{"machine":"Laminator (Boyd)","operation":"Laminate"},{"machine":"Graphtec Flatbed (Large) x2","operation":"Flatbed Cut"}]'::jsonb),

('boyd-sheet-matte',   'Sheet Product — Matte (Roland + Flatbed)', 'boyd-street',
  ARRAY['Sheet Vinyl','Specialty'],
  '[{"machine":"Roland (CMYK+White)","operation":"Print (Matte)"},{"machine":"Laminator (Boyd)","operation":"Laminate"},{"machine":"Graphtec Flatbed (Large) x2","operation":"Flatbed Cut"}]'::jsonb),

('boyd-wide-banner',   'Wide Format Banner (Canon Colorado)', 'boyd-street',
  ARRAY['Banners','Wallpaper'],
  '[{"machine":"Canon Colorado","operation":"Print Wide Format"}]'::jsonb),

('15k-labels-duplo',   'Sheet Labels on 15K + Duplo', '16th-street',
  ARRAY['Sheet Labels'],
  '[{"machine":"HP Indigo 15K","operation":"Print"},{"machine":"Duplo","operation":"Cut & Score"}]'::jsonb),

('6k-labels-uv-die',   'Roll Labels UV + Die (6K + GM Die w/ UV)', '16th-street',
  ARRAY['Labels'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Die Cutter","operation":"Die Cut + UV Coat"}]'::jsonb),

('6k-labels-foil-laser','Roll Labels Foil + Laser (6K + GM Laser w/ Foil)', '16th-street',
  ARRAY['Labels'],
  '[{"machine":"HP Indigo 6K","operation":"Print"},{"machine":"GM Laser Cutter","operation":"Laser Cut + Foil"}]'::jsonb),

('application-hand',   'Label Application (Hand Work)', NULL,
  ARRAY['Applied Labels'],
  '[{"machine":"Application Station","operation":"Hand Apply Labels"}]'::jsonb);

-- ---------------------------------------------------------------------------
-- MATERIALS (reference catalog — no quantities, just types)
-- ---------------------------------------------------------------------------

INSERT INTO materials (name, facility, unit) VALUES
-- 16th Street
('Clear BOPP',          '16th-street', 'rolls'),
('White BOPP',          '16th-street', 'rolls'),
('Silver BOPP',         '16th-street', 'rolls'),
('Holo BOPP',           '16th-street', 'rolls'),
('Clear Cosmetic Web',  '16th-street', 'rolls'),
('White Cosmetic Web',  '16th-street', 'rolls'),
('Silver Cosmetic Web', '16th-street', 'rolls'),
('Gloss Label Sheet',   '16th-street', 'sheets'),
('Matte Label Sheet',   '16th-street', 'sheets'),
('Semi-Gloss Label Sheet','16th-street','sheets'),
('14pt C1S',            '16th-street', 'sheets'),
('14pt C2S',            '16th-street', 'sheets'),
('16pt C1S',            '16th-street', 'sheets'),
('16pt C2S',            '16th-street', 'sheets'),
('18pt C1S',            '16th-street', 'sheets'),
('18pt C2S',            '16th-street', 'sheets'),
('18pt Silver',         '16th-street', 'sheets'),
('24pt C1S',            '16th-street', 'sheets'),
('24pt C2S',            '16th-street', 'sheets'),
('80lb Cover',          '16th-street', 'sheets'),
('100lb Cover',         '16th-street', 'sheets'),
('110lb Cover',         '16th-street', 'sheets'),
('80lb Text',           '16th-street', 'sheets'),
('100lb Text',          '16th-street', 'sheets'),
-- Boyd Street
('Vinyl Matte',         'boyd-street', 'sq-ft'),
('Vinyl Gloss',         'boyd-street', 'sq-ft'),
('Holographic Vinyl',   'boyd-street', 'sq-ft'),
('Window Decal',        'boyd-street', 'sq-ft'),
('Wallpaper Material',  'boyd-street', 'sq-ft'),
('Banner Material',     'boyd-street', 'sq-ft'),
('18pt Sheet (Boyd)',   'boyd-street', 'sheets'),
('20pt Sheet (Boyd)',   'boyd-street', 'sheets'),
('24pt Sheet (Boyd)',   'boyd-street', 'sheets');

-- ---------------------------------------------------------------------------
-- CONFIG (default app settings)
-- ---------------------------------------------------------------------------

INSERT INTO config (key, value) VALUES
('lead_times', '{
  "labels_diecut_stickers": {"min": 3, "max": 5, "unit": "business_days", "max_qty": 1000000},
  "folding_cartons_boxes": {"min": 5, "max": 7, "unit": "business_days", "max_qty": 50000},
  "pouches": {"min": 7, "max": 7, "unit": "business_days", "max_qty": 100000},
  "vinyl_signage": {"min": 3, "max": 5, "unit": "business_days"}
}'::jsonb),

('application_fees', '{
  "jars_tubes": 0.10,
  "bags_small": 0.15,
  "exit_bags": 0.25,
  "bags_large": 0.50
}'::jsonb),

('facilities', '{
  "16th-street": {"name": "16th Street — Main Production", "shift_start": "06:00", "shift_end": "18:00"},
  "boyd-street": {"name": "Boyd Street — Design Hub", "shift_start": "08:00", "shift_end": "17:00"}
}'::jsonb),

('notification_settings', '{
  "rush_order_alert": true,
  "qc_failure_alert": true,
  "machine_issue_alert": true,
  "meal_break_violation_alert": true
}'::jsonb);
