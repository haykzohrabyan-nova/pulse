/**
 * Local JSON bundle for organisation.html when Supabase is not used.
 * Persists to localStorage; use Export / Import on the page to sync a .json file into the repo.
 */
(function (w) {
  'use strict';

  const KEY = 'pulse_organisation_bundle_v1';

  /** Stable facility IDs (aligned with data/pulse-organisation-default.json). */
  const FACILITY_IDS = {
    '16th-street': '00000000-0000-4000-8000-000000000010',
    'boyd-street': '00000000-0000-4000-8000-000000000011'
  };

  /** Facilities + hardware aligned with shared.js MACHINES / MACHINE_CAPACITY and migration 017. */
  const STRUCTURE_SEED = [
    {
      slug: '16th-street',
      name: '16th Street — Main Production',
      description: 'Primary sheetfed, Indigo, finishing, and application.',
      sort_order: 0,
      hardware: [
        { machine_name: 'Prepress', operations: ['File Prep', 'Artwork Fix', 'Preflight', 'Proofing'], daily_capacity_value: null, daily_capacity_unit: null, notes: 'Prepress review, file correction, proofing, and setup before production restarts.', sort_order: 0 },
        { machine_name: 'HP Indigo 6K', operations: ['Printing'], daily_capacity_value: 4200, daily_capacity_unit: 'sheets', notes: '~30m/min × 7hr typical with setup.', sort_order: 1 },
        { machine_name: 'HP Indigo 15K', operations: ['Printing'], daily_capacity_value: 21000, daily_capacity_unit: 'sheets', notes: '~3,000 sheets/hr × 7hr typical.', sort_order: 2 },
        { machine_name: 'Laminator (Nobelus)', operations: ['Laminating'], daily_capacity_value: 7000, daily_capacity_unit: 'sheets', notes: '~1,000 sheets/hr × 7hr.', sort_order: 3 },
        { machine_name: 'Scodix', operations: ['Spot UV', 'Foil Stamping', 'Embossing', 'Texture'], daily_capacity_value: 4550, daily_capacity_unit: 'sheets', notes: '~650 sheets/hr × 7hr.', sort_order: 4 },
        { machine_name: 'Karlville Poucher', operations: ['Pouching'], daily_capacity_value: 22500, daily_capacity_unit: 'units', notes: '~22,500/shift standard.', sort_order: 5 },
        { machine_name: 'Moll Brothers Cutter', operations: ['Cutting'], daily_capacity_value: 17500, daily_capacity_unit: 'sheets', notes: '~2,500 sheets/hr × 7hr.', sort_order: 6 },
        { machine_name: 'Moll Brothers Folder-Gluer', operations: ['Folding', 'Gluing'], daily_capacity_value: 70000, daily_capacity_unit: 'units', notes: '~10,000 boxes/hr × 7hr mid-size.', sort_order: 7 },
        { machine_name: 'Duplo', operations: ['Flatbed Cutting', 'Scoring', 'Creasing'], daily_capacity_value: 84, daily_capacity_unit: 'sheets', notes: '15K sheet size only (750mm x 550mm). Small runs under ~200 sheets.', sort_order: 8 },
        { machine_name: 'GM Die Cutter w/ JetFX', operations: ['Die Cutting', 'UV Finishing', 'Foil Finishing', 'Laminating'], daily_capacity_value: 4200, daily_capacity_unit: 'sheets', notes: 'Multi-function: cuts + UV + foil via JetFX.', sort_order: 9 },
        { machine_name: 'GM Laser Cutter w/ JetFX', operations: ['Laser Cutting', 'UV Finishing', 'Foil Finishing', 'Laminating'], daily_capacity_value: 1400, daily_capacity_unit: 'sheets', notes: '~10m/min. Complex shapes slower.', sort_order: 10 },
        { machine_name: 'Guillotine Cutter', operations: ['Guillotine Cutting'], daily_capacity_value: 35000, daily_capacity_unit: 'sheets', notes: 'Very fast.', sort_order: 11 },
        { machine_name: 'UV Coater', operations: ['UV Coating'], daily_capacity_value: 4000, daily_capacity_unit: 'sheets', notes: 'Inline UV coating.', sort_order: 12 },
        { machine_name: 'Booklet Folder', operations: ['Booklet Folding'], daily_capacity_value: null, daily_capacity_unit: 'none', notes: '', sort_order: 13 },
        { machine_name: 'Application Dept', operations: ['Label Application', 'Hand Gluing', 'Assembly'], daily_capacity_value: 6000, daily_capacity_unit: 'units', notes: '~2,000 units/person/day × 3 people.', sort_order: 14 }
      ]
    },
    {
      slug: 'boyd-street',
      name: 'Boyd Street — Design & Large Format',
      description: 'Large-format print, vinyl, and Boyd sheet workflows.',
      sort_order: 1,
      hardware: [
        { machine_name: 'Canon Colorado', operations: ['Printing'], daily_capacity_value: 2000, daily_capacity_unit: 'sq_ft', notes: 'Large format. CMYK only. GLOSS materials ONLY.', sort_order: 0 },
        { machine_name: 'Roland Printers', operations: ['Printing'], daily_capacity_value: 35, daily_capacity_unit: 'sheets', notes: '~12min/sheet × 3 machines. MATTE materials ONLY.', sort_order: 1 },
        { machine_name: 'Graphtec Vinyl Cutter x4', operations: ['Vinyl Cutting', 'Contour Cutting'], daily_capacity_value: null, daily_capacity_unit: 'none', notes: 'Count: 4.', sort_order: 2 },
        { machine_name: 'Graphtec Flatbed (Large) x2', operations: ['Flatbed Cutting'], daily_capacity_value: 168, daily_capacity_unit: 'sheets', notes: '36"x70" max. 15K overflow / Boyd-printed sheets.', sort_order: 3 },
        { machine_name: 'Graphtec Flatbed (Small)', operations: ['Flatbed Cutting'], daily_capacity_value: 84, daily_capacity_unit: 'sheets', notes: '36"x48" max.', sort_order: 4 },
        { machine_name: 'Laminator (Boyd)', operations: ['Laminating'], daily_capacity_value: 280, daily_capacity_unit: 'sheets', notes: 'Sheet products only. Labels do NOT get laminated at Boyd.', sort_order: 5 }
      ]
    }
  ];

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 11);
  }

  function hardwareSeedId(facilitySlug, machineName) {
    const key = `${facilitySlug}:${machineName}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    const n = Math.abs(h) % 0xffff;
    const hex = n.toString(16).padStart(4, '0');
    return `00000000-0000-4000-8000-${hex}00000001`.slice(0, 36);
  }

  function buildStructureFromSeed(organisationId) {
    const facilities = [];
    const hardwareByFacilityId = {};
    for (const sf of STRUCTURE_SEED) {
      const facId = FACILITY_IDS[sf.slug] || uid();
      facilities.push({
        id: facId,
        organisation_id: organisationId,
        slug: sf.slug,
        name: sf.name,
        address: '',
        description: sf.description,
        manager_id: null,
        sort_order: sf.sort_order
      });
      hardwareByFacilityId[facId] = (sf.hardware || []).map(h => ({
        id: hardwareSeedId(sf.slug, h.machine_name),
        facility_id: facId,
        machine_name: h.machine_name,
        operations: h.operations.slice(),
        daily_capacity_value: h.daily_capacity_value,
        daily_capacity_unit: h.daily_capacity_unit,
        notes: h.notes || '',
        sort_order: h.sort_order,
        active: true
      }));
    }
    return { facilities, hardwareByFacilityId };
  }

  /**
   * Merge default facilities/hardware when missing (e.g. after delete or empty localStorage).
   * Does not remove user-edited rows; only adds missing slugs and machines.
   */
  function ensureStructureSeed(bundle) {
    const b = normalizeBundle(bundle);
    let changed = false;
    const hadNoFacilities = b.facilities.length === 0;
    const orgId = b.organisation.id;

    for (const sf of STRUCTURE_SEED) {
      let fac = b.facilities.find(f => String(f.slug || '').toLowerCase() === sf.slug);
      if (!fac) {
        fac = {
          id: FACILITY_IDS[sf.slug] || uid(),
          organisation_id: orgId,
          slug: sf.slug,
          name: sf.name,
          address: '',
          description: sf.description,
          manager_id: null,
          sort_order: sf.sort_order
        };
        b.facilities.push(fac);
        changed = true;
      } else {
        if (!fac.slug) { fac.slug = sf.slug; changed = true; }
        if (!fac.name) { fac.name = sf.name; changed = true; }
        if (!fac.description && sf.description) { fac.description = sf.description; changed = true; }
      }

      const list = Array.isArray(b.hardwareByFacilityId[fac.id]) ? b.hardwareByFacilityId[fac.id] : [];
      for (const sh of sf.hardware || []) {
        if (!list.some(h => h.machine_name === sh.machine_name)) {
          list.push({
            id: hardwareSeedId(sf.slug, sh.machine_name),
            facility_id: fac.id,
            machine_name: sh.machine_name,
            operations: sh.operations.slice(),
            daily_capacity_value: sh.daily_capacity_value,
            daily_capacity_unit: sh.daily_capacity_unit,
            notes: sh.notes || '',
            sort_order: sh.sort_order,
            active: true
          });
          changed = true;
        }
      }
      b.hardwareByFacilityId[fac.id] = list;
    }

    b.facilities.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (hadNoFacilities && b.facilities.length >= STRUCTURE_SEED.length && !b.organisation.saved) {
      b.organisation.saved = true;
      changed = true;
    }
    return { bundle: b, changed };
  }

  function defaultBundle() {
    const oid = '00000000-0000-4000-8000-000000000001';
    const structure = buildStructureFromSeed(oid);
    return {
      schemaVersion: 1,
      organisation: {
        id: oid,
        name: 'Bazaar Print',
        short_description: 'Master production organisation for Pulse — facilities and hardware below.',
        website_url: '',
        logo_url: '',
        logo_data_url: '',
        saved: true
      },
      people: [],
      facilities: structure.facilities,
      hardwareByFacilityId: structure.hardwareByFacilityId
    };
  }

  function normalizeBundle(o) {
    if (!o || typeof o !== 'object' || !o.organisation || !o.organisation.id) return defaultBundle();
    if (!Array.isArray(o.facilities)) o.facilities = [];
    if (!o.hardwareByFacilityId || typeof o.hardwareByFacilityId !== 'object') o.hardwareByFacilityId = {};
    if (!Array.isArray(o.people)) o.people = [];
    if (!o.schemaVersion) o.schemaVersion = 1;
    o.organisation.logo_url = o.organisation.logo_url || '';
    o.organisation.logo_data_url = o.organisation.logo_data_url || '';
    o.organisation.website_url = o.organisation.website_url || '';
    o.organisation.short_description = o.organisation.short_description || '';
    if (typeof o.organisation.saved !== 'boolean') o.organisation.saved = false;
    return o;
  }

  function loadRaw() {
    try {
      const raw = w.localStorage.getItem(KEY);
      if (!raw) return defaultBundle();
      const seeded = ensureStructureSeed(JSON.parse(raw));
      if (seeded.changed) saveRaw(seeded.bundle);
      return seeded.bundle;
    } catch (e) {
      console.warn('[PulseOrgJsonStore]', e);
      return defaultBundle();
    }
  }

  function saveRaw(bundle) {
    w.localStorage.setItem(KEY, JSON.stringify(normalizeBundle(bundle)));
  }

  function exportDownload(bundle, filename) {
    const blob = new Blob([JSON.stringify(normalizeBundle(bundle), null, 2)], { type: 'application/json' });
    const a = w.document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'pulse-organisation.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  w.PulseOrgJsonStore = {
    KEY: KEY,
    uid: uid,
    defaultBundle: defaultBundle,
    buildStructureFromSeed: buildStructureFromSeed,
    ensureStructureSeed: ensureStructureSeed,
    loadRaw: loadRaw,
    saveRaw: saveRaw,
    exportDownload: exportDownload,
    normalizeBundle: normalizeBundle
  };
})(window);
