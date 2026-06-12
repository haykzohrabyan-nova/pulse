// ============================================================
// shared.js — Bazaar Printing Production Management System
// IndexedDB wrapper, constants, BroadcastChannel sync
// ============================================================

const DB_NAME = 'BazaarPrintDB';
const DB_VERSION = 7;
const PULSE_UI_VERSION = 'v21';

/** Root-absolute paths — HTML lives in /pages/, JS in /js/ */
const PULSE_JS_ROOT = '/js/';
const PULSE_PAGES_ROOT = '/pages/';
const PULSE_ASSETS_ROOT = '/assets/';

function pulseJs(file) {
  const name = String(file || '').replace(/^\//, '');
  return name.startsWith('/js/') ? name : PULSE_JS_ROOT + name;
}

function pulsePage(slug) {
  const base = String(slug || '').replace(/\.html$/i, '').replace(/^\//, '').replace(/^pages\//, '');
  return PULSE_PAGES_ROOT + base + '.html';
}

if (typeof window !== 'undefined') {
  window.PULSE_JS_ROOT = PULSE_JS_ROOT;
  window.PULSE_PAGES_ROOT = PULSE_PAGES_ROOT;
  window.PULSE_ASSETS_ROOT = PULSE_ASSETS_ROOT;
  window.pulseJs = pulseJs;
  window.pulsePage = pulsePage;
}

if (typeof document !== 'undefined' && !document.querySelector('script[data-pulse-notifications]')) {
  const s = document.createElement('script');
  s.src = pulseJs('notification-config.js');
  s.dataset.pulseNotifications = 'true';
  document.head.appendChild(s);
}

// pulse-config.js (committed) then pulse-config.local.js (optional overrides)
if (typeof document !== 'undefined' && !document.querySelector('script[data-pulse-config], script[src*="pulse-config.js"]')) {
  ['pulse-config.js', 'pulse-config.local.js'].forEach((src) => {
    const s = document.createElement('script');
    s.src = pulseJs(src);
    s.dataset.pulseConfig = 'true';
    document.head.appendChild(s);
  });
}

// ── Constants ──────────────────────────────────────────────

const FACILITIES = {
  '16th-street': { name: '16th Street — Main Production', machines: [
    'Prepress',
    'HP Indigo 6K', 'HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix',
    'Karlville Poucher', 'Moll Brothers Cutter', 'Moll Brothers Folder-Gluer',
    'Duplo', 'GM Die Cutter w/ JetFX', 'GM Laser Cutter w/ JetFX',
    'Guillotine Cutter', 'UV Coater', 'Booklet Folder', 'Application Dept'
  ]},
  'boyd-street': { name: 'Boyd Street — Design & Large Format', machines: [
    'Canon Colorado', 'Roland Printers',
    'Graphtec Vinyl Cutter x4', 'Graphtec Flatbed (Large) x2', 'Graphtec Flatbed (Small)',
    'Laminator (Boyd)'
  ]}
};

const MACHINES = {
  'Prepress': { operations: ['File Prep', 'Artwork Fix', 'Preflight', 'Proofing'], facility: '16th-street', notes: 'Prepress review, file correction, proofing, and setup before production restarts.' },
  'HP Indigo 6K': { operations: ['Printing'], facility: '16th-street', products: ['Roll Labels', 'Sheet Labels', 'Pouches'] },
  'HP Indigo 15K': { operations: ['Printing'], facility: '16th-street', products: ['Folding Cartons', 'Boxes', 'Cardstock'] },
  'Laminator (Nobelus)': { operations: ['Laminating'], facility: '16th-street', options: ['Gloss', 'Matte', 'Soft Touch', 'Holo'] },
  'Scodix': { operations: ['Spot UV', 'Foil Stamping', 'Embossing', 'Texture'], facility: '16th-street' },
  'Karlville Poucher': { operations: ['Pouching'], facility: '16th-street', products: ['Stand-up Pouches', 'Flat Pouches', 'Barrier Bags'] },
  'Moll Brothers Cutter': { operations: ['Cutting'], facility: '16th-street' },
  'Moll Brothers Folder-Gluer': { operations: ['Folding', 'Gluing'], facility: '16th-street' },
  'Duplo': { operations: ['Flatbed Cutting', 'Scoring', 'Creasing'], facility: '16th-street', notes: '15K sheet size only (750mm x 550mm). Use for small runs under ~200 sheets when no die available.' },
  'GM Die Cutter w/ JetFX': { operations: ['Die Cutting', 'UV Finishing', 'Foil Finishing', 'Laminating'], facility: '16th-street', notes: 'Multi-function: cuts + UV + foil via JetFX. Use when physical die exists. Also laminates pouch material.' },
  'GM Laser Cutter w/ JetFX': { operations: ['Laser Cutting', 'UV Finishing', 'Foil Finishing', 'Laminating'], facility: '16th-street', notes: 'Multi-function: cuts + UV + foil via JetFX. Use when no physical die. Also laminates pouch material.' },
  'Guillotine Cutter': { operations: ['Guillotine Cutting'], facility: '16th-street' },
  'UV Coater': { operations: ['UV Coating'], facility: '16th-street' },
  'Booklet Folder': { operations: ['Booklet Folding'], facility: '16th-street' },
  'Canon Colorado': { operations: ['Printing'], facility: 'boyd-street', products: ['54" Vinyl', '36x54 Sheets', 'Signage'], notes: 'CMYK only. GLOSS materials ONLY.' },
  'Roland Printers': { operations: ['Printing'], facility: 'boyd-street', products: ['54" Vinyl', '36x54 Sheets', 'Signage'], notes: 'CMYK + Orange + Red + White + Gloss (UV). MATTE materials ONLY.' },
  'Graphtec Vinyl Cutter x4': { operations: ['Vinyl Cutting', 'Contour Cutting'], facility: 'boyd-street', count: 4 },
  'Graphtec Flatbed (Large) x2': { operations: ['Flatbed Cutting'], facility: 'boyd-street', count: 2, notes: 'For 15K overflow cutting — handles 36"x70" sheets. Use for small runs under ~200 sheets when no die. Also Boyd-printed sheets (36x56).' },
  'Graphtec Flatbed (Small)': { operations: ['Flatbed Cutting'], facility: 'boyd-street', count: 1, notes: '36"x48" max sheet size. For Boyd-printed sheet products.' },
  'Laminator (Boyd)': { operations: ['Laminating'], facility: 'boyd-street', notes: 'Sheet products only. Labels do NOT get laminated at Boyd.' },
  'Application Dept': { operations: ['Label Application', 'Hand Gluing', 'Assembly'], facility: '16th-street', notes: 'Application team — labels onto jars/tubes/bags, hand gluing boxes, manual assembly. Capacity tracked per shift.' }
};

// HP Indigo 15K typical production flow (from Trello):
// Waiting Approval → HOLD → Press 15K → Lamination Nobelus → Scodix → Cutter Moll Bros → Fold & Glue Moll Bros → Duplo → Guillotine → UV Coater → Booklet Folder → QC → Ready to Ship → Shipped/Pickup → Received
const WORKFLOW_TEMPLATES = {
  // 16th Street — HP Indigo 15K Line — Folding Cartons (3 cutting paths)
  '15k-box-die': { name: 'Box - Die Cut (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Moll Brothers Cutter', 'Moll Brothers Folder-Gluer'], notes: 'Standard box flow with existing or new die. Requires die scan before cutting.' },
  '15k-box-duplo': { name: 'Box - Duplo Flatbed (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Duplo', 'Moll Brothers Folder-Gluer'], notes: 'Small runs under ~200 sheets. No die needed. 15K sheet size only (750mm x 550mm).' },
  '15k-box-boyd': { name: 'Box - Boyd Graphtec Cut (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Graphtec Flatbed (Large) x2', 'Moll Brothers Folder-Gluer'], notes: 'Small runs sent to Boyd for flatbed cutting on Graphtec. Max 36"x70" sheets.' },
  // 15K — Flat sheets (no folding — goes to guillotine)
  '15k-flat-die': { name: 'Flat Sheet - Die Cut (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Moll Brothers Cutter'] },
  '15k-flat-guillotine': { name: 'Flat Sheet - Guillotine (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Guillotine Cutter'] },
  // 15K — Hand gluing (rare, ~1%)
  '15k-box-handglue': { name: 'Box - Hand Glue (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Moll Brothers Cutter', 'Application Dept'], notes: 'Rare — hand gluing at Application dept instead of machine fold/glue.' },
  // Legacy aliases
  '15k-box': { name: 'Box / Folding Carton (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Moll Brothers Cutter', 'Moll Brothers Folder-Gluer'] },
  '15k-card': { name: 'Card / Flat Sheet (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Duplo'] },
  '15k-booklet': { name: 'Booklet (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Booklet Folder', 'Guillotine Cutter'] },
  '15k-uv-foil': { name: 'Box w/ UV + Foil (15K)', steps: ['HP Indigo 15K', 'Laminator (Nobelus)', 'Scodix', 'Moll Brothers Cutter', 'Moll Brothers Folder-Gluer'] },
  // 16th Street — HP Indigo 6K Line
  '6k-labels-die': { name: 'Labels w/ Die (6K)', steps: ['HP Indigo 6K', 'GM Die Cutter w/ JetFX'] },
  '6k-labels-laser': { name: 'Labels - Laser Cut (6K)', steps: ['HP Indigo 6K', 'GM Laser Cutter w/ JetFX'] },
  '6k-sheet-die': { name: 'Label Sheets - Die Cut (6K)', steps: ['HP Indigo 6K', 'Moll Brothers Cutter'] },
  '6k-sheet-guillotine': { name: 'Label Sheets - Guillotine (6K)', steps: ['HP Indigo 6K', 'Guillotine Cutter'] },
  '6k-sheet-duplo': { name: 'Label Sheets - Duplo (6K)', steps: ['HP Indigo 6K', 'Duplo'] },
  '6k-sheet-boyd': { name: 'Label Sheets - Boyd Flatbed (6K)', steps: ['HP Indigo 6K', 'Graphtec Flatbed (Large) x2'] },
  '6k-pouches-die': { name: 'Pouches w/ Die (6K)', steps: ['HP Indigo 6K', 'GM Die Cutter w/ JetFX', 'Karlville Poucher'] },
  '6k-pouches-laser': { name: 'Pouches - Laser (6K)', steps: ['HP Indigo 6K', 'GM Laser Cutter w/ JetFX', 'Karlville Poucher'] },
  // 16th Street — No print (plain cut)
  'plain-cut': { name: 'Plain Boxes/Labels (no print)', steps: ['Moll Brothers Cutter'] },
  // Boyd Street — Vinyl Labels
  'boyd-vinyl-gloss': { name: 'Vinyl Labels - Gloss (Boyd)', steps: ['Canon Colorado', 'Graphtec Vinyl Cutter x4'] },
  'boyd-vinyl-matte': { name: 'Vinyl Labels - Matte (Boyd)', steps: ['Roland Printers', 'Graphtec Vinyl Cutter x4'] },
  // Boyd Street — Sheet Products
  'boyd-sheet': { name: 'Sheet Cards (Boyd)', steps: ['Canon Colorado', 'Laminator (Boyd)', 'Graphtec Flatbed (Large) x2'] },
  'boyd-sheet-matte': { name: 'Sheet Cards Matte (Boyd)', steps: ['Roland Printers', 'Laminator (Boyd)', 'Graphtec Flatbed (Large) x2'] },
};

// ── Product workflow config (admin Product Workflows tab) ───

/** DB machine slug → display name key in MACHINES */
/** Workflow machine slug → category (matches migration 022). */
const MACHINE_SLUG_CATEGORY = {
  'press-6k': 'press',
  'press-15k': 'press',
  'nobelus': 'lamination',
  'scodix': 'finishing',
  'karlville': 'pouching',
  'gm-die-cutter': 'cutting',
  'gm-laser-cutter': 'cutting',
  'moll-cutter': 'cutting',
  'moll-folder': 'folding',
  'duplo': 'cutting',
  'guillotine': 'cutting',
  'uv-coater': 'finishing',
  'booklet-folder': 'folding',
  'canon-colorado': 'press',
  'roland': 'press',
  'graphtec-vinyl': 'cutting',
  'graphtec-flatbed': 'cutting',
  'boyd-laminator': 'lamination',
};

const MACHINE_SLUG_TO_DISPLAY = {
  'press-6k': 'HP Indigo 6K',
  'press-15k': 'HP Indigo 15K',
  'nobelus': 'Laminator (Nobelus)',
  'scodix': 'Scodix',
  'karlville': 'Karlville Poucher',
  'gm-die-cutter': 'GM Die Cutter w/ JetFX',
  'gm-laser-cutter': 'GM Laser Cutter w/ JetFX',
  'moll-cutter': 'Moll Brothers Cutter',
  'moll-folder': 'Moll Brothers Folder-Gluer',
  'duplo': 'Duplo',
  'guillotine': 'Guillotine Cutter',
  'uv-coater': 'UV Coater',
  'booklet-folder': 'Booklet Folder',
  'canon-colorado': 'Canon Colorado',
  'roland': 'Roland Printers',
  'graphtec-vinyl': 'Graphtec Vinyl Cutter x4',
  'graphtec-flatbed': 'Graphtec Flatbed (Large) x2',
  'boyd-laminator': 'Laminator (Boyd)',
};

function _defaultOperationForMachineDisplay(displayName) {
  const ops = (displayName && MACHINES[displayName]?.operations) || [];
  return ops[0] || 'Processing';
}

function _defaultOperationForMachineSlug(machineId) {
  return _defaultOperationForMachineDisplay(machineSlugToDisplayName(machineId));
}

function normalizeWorkflowAlternativeEntry(alt) {
  if (!alt) return null;
  if (typeof alt === 'string') {
    return { machineId: alt, operation: _defaultOperationForMachineSlug(alt) };
  }
  const machineId = alt.machineId || alt.id;
  if (!machineId) return null;
  return {
    machineId,
    operation: alt.operation || _defaultOperationForMachineSlug(machineId),
  };
}

function normalizeWorkflowAlternatives(alternatives) {
  return (alternatives || []).map(normalizeWorkflowAlternativeEntry).filter(Boolean);
}

function _workflowStep(machineId, sortOrder, opts = {}) {
  const operation = opts.operation ?? _defaultOperationForMachineSlug(machineId);
  const alternatives = normalizeWorkflowAlternatives(opts.alternatives);
  const stepType = opts.stepType || 'default';
  const defaultMachineId = opts.defaultMachineId ?? null;
  const defaultOperation = opts.defaultOperation
    ?? (defaultMachineId ? _defaultOperationForMachineSlug(defaultMachineId) : null);
  return {
    machineId,
    operation,
    stepType,
    sortOrder,
    defaultMachineId,
    defaultOperation,
    alternatives,
    conditionField: opts.conditionField ?? null,
    conditionOp: opts.conditionOp ?? null,
    conditionValue: opts.conditionValue ?? null,
    notes: opts.notes ?? null,
  };
}

function _cloneWorkflowDefault(def) {
  return {
    primaryFacility: def.primaryFacility,
    unmapped: !!def.unmapped,
    steps: (def.steps || []).map(s => ({
      ...s,
      operation: s.operation || _defaultOperationForMachineSlug(s.machineId),
      defaultOperation: s.defaultOperation
        || (s.defaultMachineId ? _defaultOperationForMachineSlug(s.defaultMachineId) : null),
      alternatives: normalizeWorkflowAlternatives(s.alternatives),
    })),
  };
}

const PRODUCT_WORKFLOW_DEFAULTS = {
  'labels-roll': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-6k', 1),
      _workflowStep('gm-die-cutter', 2, {
        stepType: 'conditional',
        defaultMachineId: 'gm-laser-cutter',
        conditionField: 'cutMethod',
        conditionOp: 'equals',
        conditionValue: 'die',
        alternatives: ['gm-laser-cutter'],
      }),
    ],
  },
  'labels-sheet': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-6k', 1, { alternatives: ['press-15k'] }),
      _workflowStep('guillotine', 2, { alternatives: ['duplo', 'graphtec-flatbed'] }),
    ],
  },
  'pouches': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-6k', 1),
      _workflowStep('gm-die-cutter', 2, {
        stepType: 'conditional',
        defaultMachineId: 'gm-laser-cutter',
        conditionField: 'cutMethod',
        conditionOp: 'equals',
        conditionValue: 'die',
        alternatives: ['gm-laser-cutter'],
      }),
      _workflowStep('karlville', 3),
    ],
  },
  'boxes': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-15k', 1),
      _workflowStep('nobelus', 2, {
        stepType: 'conditional',
        conditionField: 'lamination',
        conditionOp: 'not_equals',
        conditionValue: 'none',
      }),
      _workflowStep('scodix', 3, {
        stepType: 'conditional',
        conditionField: 'hasScodixFinishing',
        conditionOp: 'equals',
        conditionValue: 'true',
      }),
      _workflowStep('moll-cutter', 4, { alternatives: ['duplo', 'graphtec-flatbed'] }),
      _workflowStep('moll-folder', 5),
    ],
  },
  'business-cards': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-15k', 1, { alternatives: ['canon-colorado', 'roland'] }),
      _workflowStep('nobelus', 2, {
        stepType: 'conditional',
        conditionField: 'lamination',
        conditionOp: 'not_equals',
        conditionValue: 'none',
        alternatives: ['boyd-laminator'],
      }),
      _workflowStep('duplo', 3, { alternatives: ['guillotine', 'graphtec-flatbed'] }),
    ],
  },
  'flyers': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-15k', 1),
      _workflowStep('nobelus', 2, {
        stepType: 'conditional',
        conditionField: 'lamination',
        conditionOp: 'not_equals',
        conditionValue: 'none',
      }),
      _workflowStep('guillotine', 3, { alternatives: ['duplo', 'graphtec-flatbed'] }),
    ],
  },
  'booklets': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-15k', 1),
      _workflowStep('nobelus', 2, {
        stepType: 'conditional',
        conditionField: 'lamination',
        conditionOp: 'not_equals',
        conditionValue: 'none',
      }),
      _workflowStep('booklet-folder', 3),
      _workflowStep('guillotine', 4),
    ],
  },
  'diecut-stickers': {
    primaryFacility: '16th',
    steps: [
      _workflowStep('press-6k', 1),
      _workflowStep('gm-laser-cutter', 2, { alternatives: ['gm-die-cutter'] }),
    ],
  },
  'vinyl-labels': {
    primaryFacility: 'boyd',
    steps: [
      _workflowStep('canon-colorado', 1, {
        stepType: 'conditional',
        conditionField: 'materialFinish',
        conditionOp: 'equals',
        conditionValue: 'gloss',
        alternatives: ['roland'],
      }),
      _workflowStep('roland', 2, {
        stepType: 'conditional',
        conditionField: 'materialFinish',
        conditionOp: 'equals',
        conditionValue: 'matte',
        alternatives: ['canon-colorado'],
      }),
      _workflowStep('graphtec-vinyl', 3),
    ],
  },
  'vinyl-signage': {
    primaryFacility: 'boyd',
    steps: [
      _workflowStep('canon-colorado', 1, {
        stepType: 'conditional',
        conditionField: 'materialFinish',
        conditionOp: 'equals',
        conditionValue: 'gloss',
        alternatives: ['roland'],
      }),
      _workflowStep('roland', 2, {
        stepType: 'conditional',
        conditionField: 'materialFinish',
        conditionOp: 'equals',
        conditionValue: 'matte',
        alternatives: ['canon-colorado'],
      }),
      _workflowStep('graphtec-vinyl', 3),
    ],
  },
  'banners': {
    primaryFacility: 'boyd',
    steps: [
      _workflowStep('canon-colorado', 1, { alternatives: ['roland'] }),
    ],
  },
  'window-decals': {
    primaryFacility: 'boyd',
    steps: [
      _workflowStep('roland', 1, { alternatives: ['canon-colorado'] }),
      _workflowStep('graphtec-vinyl', 2),
    ],
  },
  'wallpaper': {
    primaryFacility: 'boyd',
    steps: [
      _workflowStep('canon-colorado', 1, { alternatives: ['roland'] }),
    ],
  },
  'boyd-sheets': {
    primaryFacility: 'boyd',
    steps: [
      _workflowStep('canon-colorado', 1, {
        stepType: 'conditional',
        conditionField: 'materialFinish',
        conditionOp: 'equals',
        conditionValue: 'gloss',
        alternatives: ['roland'],
      }),
      _workflowStep('boyd-laminator', 2, {
        stepType: 'conditional',
        conditionField: 'lamination',
        conditionOp: 'not_equals',
        conditionValue: 'none',
      }),
      _workflowStep('graphtec-flatbed', 3, { alternatives: ['duplo'] }),
    ],
  },
  placeholder: {
    primaryFacility: '16th',
    unmapped: true,
    steps: [
      _workflowStep('press-15k', 1),
      _workflowStep('guillotine', 2),
    ],
  },
};

const CATALOG_NAME_TO_DEFAULT_KEY = {
  'labels (roll)': 'labels-roll',
  'labels (sheet)': 'labels-sheet',
  'pouches': 'pouches',
  'folding cartons / boxes': 'boxes',
  'business cards': 'business-cards',
  'flyers / postcards': 'flyers',
  'booklets': 'booklets',
  'diecut stickers': 'diecut-stickers',
  'vinyl labels / 54\'\' rolls': 'vinyl-labels',
  'vinyl signage': 'vinyl-signage',
  'banners / large format': 'banners',
  'window decals': 'window-decals',
  'wallpaper': 'wallpaper',
  'sheet products (boyd)': 'boyd-sheets',
};

const CATALOG_PARTIAL_DEFAULT_KEYS = [
  [/labels.*roll/i, 'labels-roll'],
  [/labels.*sheet/i, 'labels-sheet'],
  [/pouch/i, 'pouches'],
  [/folding carton|\/ boxes/i, 'boxes'],
  [/business card/i, 'business-cards'],
  [/flyer|postcard/i, 'flyers'],
  [/booklet/i, 'booklets'],
  [/diecut|die.?cut.*sticker/i, 'diecut-stickers'],
  [/vinyl label|54.*roll/i, 'vinyl-labels'],
  [/vinyl signage/i, 'vinyl-signage'],
  [/banner|large format/i, 'banners'],
  [/window decal/i, 'window-decals'],
  [/wallpaper/i, 'wallpaper'],
  [/sheet products.*boyd/i, 'boyd-sheets'],
];

function getDefaultProductWorkflowForCatalogName(productName) {
  const norm = (productName || '').trim().toLowerCase();
  const key = CATALOG_NAME_TO_DEFAULT_KEY[norm];
  if (key && PRODUCT_WORKFLOW_DEFAULTS[key]) return _cloneWorkflowDefault(PRODUCT_WORKFLOW_DEFAULTS[key]);
  for (const [pattern, k] of CATALOG_PARTIAL_DEFAULT_KEYS) {
    if (pattern.test(productName || '') && PRODUCT_WORKFLOW_DEFAULTS[k]) {
      return _cloneWorkflowDefault(PRODUCT_WORKFLOW_DEFAULTS[k]);
    }
  }
  return _cloneWorkflowDefault(PRODUCT_WORKFLOW_DEFAULTS.placeholder);
}

function _evalWorkflowCondition(step, jobOptions) {
  if (step.stepType !== 'conditional') return true;
  const field = step.conditionField;
  if (!field || !step.conditionOp) return false;
  const raw = jobOptions?.[field];
  const val = raw == null ? '' : String(raw);
  const expected = step.conditionValue == null ? '' : String(step.conditionValue);
  switch (step.conditionOp) {
    case 'equals':
      return val === expected || val.toLowerCase() === expected.toLowerCase();
    case 'not_equals':
      return val !== expected && val.toLowerCase() !== expected.toLowerCase();
    case 'in': {
      const parts = expected.split(',').map(s => s.trim().toLowerCase());
      return parts.includes(val.toLowerCase());
    }
    default:
      return true;
  }
}

/** Resolve configured steps for a job (phase 2 — job ticket wiring). */
function resolveProductWorkflowSteps(steps, jobOptions = {}, opts = {}) {
  if (!Array.isArray(steps)) return [];
  const includeOptional = opts.includeOptional || [];
  const optionalIds = new Set(
    Array.isArray(includeOptional) ? includeOptional : []
  );
  const sorted = [...steps].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  return sorted.map(step => {
    if (step.stepType === 'optional') {
      return optionalIds.has(step.machineId) ? step : null;
    }
    if (step.stepType !== 'conditional') return step;
    if (_evalWorkflowCondition(step, jobOptions)) return step;
    if (step.defaultMachineId) {
      return {
        ...step,
        machineId: step.defaultMachineId,
        operation: step.defaultOperation || _defaultOperationForMachineSlug(step.defaultMachineId),
      };
    }
    return null;
  }).filter(Boolean);
}

function machineSlugToDisplayName(machineId) {
  if (!machineId) return '';
  return MACHINE_SLUG_TO_DISPLAY[machineId] || machineId;
}

function displayNameToMachineSlug(displayName) {
  if (!displayName) return null;
  const entry = Object.entries(MACHINE_SLUG_TO_DISPLAY).find(([, name]) => name === displayName);
  return entry ? entry[0] : null;
}

function normalizeWorkflowCutMethod(cutMethod) {
  const v = String(cutMethod || '').toLowerCase();
  if (['gm-die', 'die-cut', 'die'].includes(v)) return 'die';
  if (['gm-laser', 'laser', 'kiss-cut', 'karlville'].includes(v)) return 'laser';
  return v || 'laser';
}

/** Map job-ticket form values to product-workflow condition fields. */
function buildProductWorkflowJobOptions(input = {}) {
  const lamRaw = input.lamination;
  const hasLam = input.hasLamination !== false && lamRaw && String(lamRaw).toLowerCase() !== 'none';
  const lamination = hasLam ? String(lamRaw).toLowerCase().replace(/\s+/g, '-') : 'none';
  const material = String(input.material || '').toLowerCase();
  let materialFinish = input.materialFinish || null;
  if (!materialFinish) {
    if (/matte/i.test(material)) materialFinish = 'matte';
    else if (/gloss|cast|calendar/i.test(material)) materialFinish = 'gloss';
  }
  const hasScodix = !!(input.hasUV || input.hasFoil || input.hasEmboss);
  return {
    cutMethod: normalizeWorkflowCutMethod(input.cutMethod),
    lamination,
    materialFinish,
    hasScodixFinishing: hasScodix ? 'true' : 'false',
    spotUV: input.hasUV ? 'true' : 'false',
    foil: input.hasFoil ? 'true' : 'false',
    emboss: input.hasEmboss ? 'true' : 'false',
  };
}

/** Build order.workflowSteps[] from resolved admin workflow steps. */
function workflowStepsFromResolvedConfig(resolvedSteps, generateStepId) {
  const genId = typeof generateStepId === 'function' ? generateStepId : () => `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return (resolvedSteps || []).map((step, i) => {
    const machineId = step.machineId || displayNameToMachineSlug(step.machine);
    const machine = machineSlugToDisplayName(machineId) || step.machine || machineId;
    const altEntries = normalizeWorkflowAlternatives(step.alternatives);
    const altSlugs = altEntries.map(a => a.machineId);
    return {
      id: genId(),
      machineId,
      machine,
      operation: step.operation || (MACHINES[machine]?.operations?.[0]) || 'Processing',
      status: 'pending',
      assignedTo: null,
      startedAt: null,
      completedAt: null,
      unitsLost: 0,
      notes: step.notes || '',
      stepIndex: i,
      alternatives: [...altSlugs],
      alternativeMachines: altSlugs.map(machineSlugToDisplayName).filter(Boolean),
    };
  });
}

/** Display names the PM may swap to (primary + configured alternatives). */
function getAllowedMachineDisplaysForWorkflowStep(step) {
  if (!step) return [];
  const primary = step.machine || machineSlugToDisplayName(step.machineId);
  const fromAlts = (step.alternativeMachines && step.alternativeMachines.length)
    ? step.alternativeMachines
    : (step.alternatives || []).map(machineSlugToDisplayName);
  const allowed = [primary, ...fromAlts].filter(Boolean);
  return [...new Set(allowed)];
}

function isProductWorkflowDefaultUnmapped(productName) {
  return !!getDefaultProductWorkflowForCatalogName(productName).unmapped;
}

if (typeof window !== 'undefined') {
  window.MACHINE_SLUG_TO_DISPLAY = MACHINE_SLUG_TO_DISPLAY;
  window.MACHINE_SLUG_CATEGORY = MACHINE_SLUG_CATEGORY;
  window.PRODUCT_WORKFLOW_DEFAULTS = PRODUCT_WORKFLOW_DEFAULTS;
  window.getDefaultProductWorkflowForCatalogName = getDefaultProductWorkflowForCatalogName;
  window.resolveProductWorkflowSteps = resolveProductWorkflowSteps;
  window.machineSlugToDisplayName = machineSlugToDisplayName;
  window.displayNameToMachineSlug = displayNameToMachineSlug;
  window.buildProductWorkflowJobOptions = buildProductWorkflowJobOptions;
  window.workflowStepsFromResolvedConfig = workflowStepsFromResolvedConfig;
  window.getAllowedMachineDisplaysForWorkflowStep = getAllowedMachineDisplaysForWorkflowStep;
  window.isProductWorkflowDefaultUnmapped = isProductWorkflowDefaultUnmapped;
  window.getOperationsForMachineSlug = function (machineId) {
    const name = machineSlugToDisplayName(machineId);
    return (name && MACHINES[name]?.operations) ? [...MACHINES[name].operations] : ['Processing'];
  };
  window.normalizeWorkflowAlternatives = normalizeWorkflowAlternatives;
  window.normalizeWorkflowAlternativeEntry = normalizeWorkflowAlternativeEntry;
  window.defaultOperationForMachineSlug = _defaultOperationForMachineSlug;
}

// ── Production Lines ───────────────────────────────────────
// Classify which production line an order belongs to based on its workflow
const PRODUCTION_LINES = {
  '6k': {
    name: 'HP Indigo 6K Line',
    color: '#2563eb',    // blue
    bgColor: 'rgba(37,99,235,0.08)',
    borderColor: 'rgba(37,99,235,0.3)',
    // Typical process stages in order
    stages: ['Prepress', 'Press 6K', 'GM Die/Laser Cut', 'Lamination', 'Pouching', 'Application', 'QC', 'Ready to Ship', 'Shipped']
  },
  '15k': {
    name: 'HP Indigo 15K Line',
    color: '#7c3aed',    // purple
    bgColor: 'rgba(124,58,237,0.08)',
    borderColor: 'rgba(124,58,237,0.3)',
    stages: ['Prepress', 'Press 15K', 'Lamination', 'Scodix', 'Die Cut (Moll)', 'Flatbed Cut (Duplo)', 'Flatbed Cut (Boyd)', 'Guillotine', 'Fold & Glue', 'Hand Glue', 'UV Coat', 'Application', 'QC', 'Ready to Ship', 'Shipped']
  },
  'boyd': {
    name: 'Boyd Street',
    color: '#d97706',    // amber/orange
    bgColor: 'rgba(217,119,6,0.08)',
    borderColor: 'rgba(217,119,6,0.3)',
    stages: ['Prepress', 'Printing', 'Lamination', 'Cutting', 'Application', 'QC', 'Ready to Ship', 'Shipped']
  }
};

function _pulseFacilityIsBoydLine(slug) {
  if (!slug) return false;
  if (slug === 'boyd-street') return true;
  const list = typeof getPulseFacilityList === 'function' ? getPulseFacilityList() : [];
  const row = list.find(f => f.slug === slug);
  if (row && /boyd/i.test(`${row.slug} ${row.name}`)) return true;
  return /boyd/i.test(String(slug));
}

/** Prepress assignee for UI (order field, else single Admin prepress person, else generic). */
function getPulsePrepressWorkerLabel(order) {
  const by = (order && (order.prepressStartedBy || order.prepressLastUpdatedBy)) || '';
  if (String(by).trim()) return String(by).trim();
  const names = _pulseAdminCache?.prepressPersonnel;
  if (Array.isArray(names) && names.length === 1) return names[0];
  return 'Prepress';
}

function _isPrepressPersonnelRole(role) {
  const r = String(role || '').toLowerCase();
  return r.includes('prepress');
}

// Determine production line from order data
function getProductionLine(order) {
  const steps = order.workflowSteps || [];
  const machines = steps.map(s => s.machine);
  // Check workflow steps first
  if (machines.some(m => m && m.includes('6K'))) return '6k';
  if (machines.some(m => m && m.includes('15K'))) return '15k';
  if (_pulseFacilityIsBoydLine(order.facility)) return 'boyd';
  // Fallback: check workflow template
  if (order.workflowTemplate) {
    if (order.workflowTemplate.startsWith('6k')) return '6k';
    if (order.workflowTemplate.startsWith('15k')) return '15k';
    if (order.workflowTemplate.startsWith('boyd')) return 'boyd';
  }
  // Last resort: facility
  if (order.facility === '16th-street') {
    // Default to 15k for sheet products, 6k for roll
    if (order.printType === 'Roll') return '6k';
    return '15k';
  }
  return 'boyd';
}

// Map a workflow step to a stage name for the kanban
function getStageForStep(step, productionLine) {
  const machine = step.machine || '';
  const op = step.operation || '';
  if (machine.includes('Prepress') || op.includes('File Prep') || op.includes('Artwork Fix') || op.includes('Preflight') || op.includes('Proofing')) return 'Prepress';
  // Press
  if (machine.includes('6K') && op.includes('Print')) return 'Press 6K';
  if (machine.includes('15K') && op.includes('Print')) return 'Press 15K';
  // 6K post-press
  if (machine.includes('GM Die') || machine.includes('GM Laser')) return 'GM Die/Laser Cut';
  // Lamination
  if (machine.includes('Laminator') || machine.includes('Nobelus')) return 'Lamination';
  // Scodix
  if (machine.includes('Scodix')) return 'Scodix';
  // Pouching
  if (machine.includes('Karlville')) return 'Pouching';
  // 15K cutting — 3 distinct paths
  if (machine.includes('Moll') && (op.includes('Cut') || op.includes('cut'))) return 'Die Cut (Moll)';
  if (machine.includes('Duplo')) return 'Flatbed Cut (Duplo)';
  if (machine.includes('Graphtec Flatbed') && productionLine === '15k') return 'Flatbed Cut (Boyd)';
  // Guillotine (flat sheets)
  if (machine.includes('Guillotine')) return 'Guillotine';
  // Fold & Glue (machine)
  if (machine.includes('Moll') && (op.includes('Fold') || op.includes('Glu'))) return 'Fold & Glue';
  // Hand Glue (application dept for gluing)
  if (machine.includes('Application') && (op.includes('Glu') || op.includes('glu'))) return 'Hand Glue';
  // Application (labels, assembly)
  if (machine.includes('Application')) return 'Application';
  // UV Coat
  if (machine.includes('UV Coater')) return 'UV Coat';
  // Booklet
  if (machine.includes('Booklet')) return 'Booklet Fold';
  // Boyd printing
  if (machine.includes('Canon') || machine.includes('Roland')) return 'Printing';
  // Boyd cutting
  if (machine.includes('Graphtec Vinyl')) return 'Cutting';
  if (machine.includes('Graphtec Flatbed')) return 'Cutting';
  // Boyd lamination
  if (machine.includes('Laminator (Boyd)')) return 'Lamination';
  return op || machine;
}

// ── Cutting Path Logic ─────────────────────────────────────
// Determines which cutting method to use for 15K jobs
// Returns: 'moll-die' | 'duplo-flatbed' | 'boyd-flatbed' | 'guillotine'
function recommendCuttingPath(order) {
  const sheetCount = order.sheetCount || Math.ceil((order.quantity || 0) / (order.piecesPerSheet || 1));
  const productType = order.productType || '';
  const hasDie = order.dieStatus === 'existing' || order.dieStatus === 'new-ordered';

  // Flat sheets → guillotine (no folding needed)
  if (productType.includes('Flat') || productType.includes('Card') || productType.includes('Postcard') || productType.includes('Flyer')) {
    if (sheetCount <= 200 && !hasDie) return 'duplo-flatbed';
    return 'guillotine';
  }

  // Folding cartons / boxes
  if (hasDie) return 'moll-die';
  if (sheetCount <= 200) {
    // Small run — flatbed. Duplo for 15K size sheets, Boyd Graphtec for larger
    return 'duplo-flatbed'; // default to Duplo; can override to Boyd
  }
  // Large run without die — need to order a die
  return 'moll-die';
}

// ── Machine Capacity ───────────────────────────────────────
// Daily capacity in sheets (will be configurable from admin later)
// Machine capacity now calculated from MACHINE_SPEEDS above
// These are kept as fallback for simple estimates
const MACHINE_CAPACITY = {
  'HP Indigo 6K': { dailySheets: 4200, notes: '~30m/min × 7hr = ~12,600m. At ~1m/frame = ~12,600 frames. Typical with setup: ~4,200.' },
  'HP Indigo 15K': { dailySheets: 21000, notes: '~3,000 sheets/hr × 7hr = ~21,000 sheets/day typical.' },
  'Scodix': { dailySheets: 4550, notes: '~650 sheets/hr × 7hr = ~4,550 sheets/day.' },
  'Laminator (Nobelus)': { dailySheets: 7000, notes: '~1,000 sheets/hr × 7hr.' },
  'Moll Brothers Cutter': { dailySheets: 17500, notes: '~2,500 sheets/hr × 7hr.' },
  'Moll Brothers Folder-Gluer': { dailySheets: 70000, notes: '~10,000 boxes/hr × 7hr mid-size.' },
  'Duplo': { dailySheets: 84, notes: '~5 min/sheet × 7hr = ~84 sheets/day. Flatbed only.' },
  'Guillotine Cutter': { dailySheets: 35000, notes: 'Very fast.' },
  'Karlville Poucher': { dailyPouches: 22500, notes: '~22,500/shift standard.' },
  'GM Die Cutter w/ JetFX': { dailySheets: 4200, notes: '~50m/min cutting. UV/foil ~10m/min additional passes.' },
  'GM Laser Cutter w/ JetFX': { dailySheets: 1400, notes: '~10m/min. Complex shapes slower.' },
  'Canon Colorado': { dailySqFt: 2000, notes: 'Large format.' },
  'Roland Printers': { dailySheets: 35, notes: '~12min/sheet × 3 machines = ~35 sheets/day total.' },
  'Graphtec Flatbed (Large) x2': { dailySheets: 168, notes: '~5min/sheet × 2 machines = ~168/day.' },
  'Graphtec Flatbed (Small)': { dailySheets: 84, notes: '~5min/sheet × 1 machine.' },
  'Laminator (Boyd)': { dailySheets: 280, notes: '~3min/sheet × 2 machines = ~280/day.' },
  'Application Dept': { dailyUnits: 6000, notes: '~2,000 units/person/day × 3 people.' },
  'UV Coater': { dailySheets: 4000, notes: 'Inline UV coating.' },
};

// ── Pouch Materials (ONLY these are pouch materials) ───────
const POUCH_MATERIALS = ['Clear Cosmetic Web', 'White Cosmetic Web', 'Silver Cosmetic Web'];

const APPLICATION_FEE_RATES = {
  jar:        0.10,
  tube:       0.10,
  bag_7g:     0.15,
  bag_exit:   0.25,
  bag_lb:     0.50,
};

const PACKAGING_CONTAINERS = [
  { id: 'jar',      label: 'Jar',              rate: 0.10 },
  { id: 'tube',     label: 'Tube',             rate: 0.10 },
  { id: 'bag_7g',   label: '7g–1lb Bag',       rate: 0.15 },
  { id: 'bag_exit', label: 'Exit Bag',          rate: 0.25 },
  { id: 'bag_lb',   label: 'Large Bag (1lb+)',  rate: 0.50 },
];

function isPouchMaterial(material) {
  if (!material) return false;
  return POUCH_MATERIALS.some(pm => material === pm || material.includes('Cosmetic Web'));
}

// ── Recommended Overs Calculation ──────────────────────────
// Auto-calculate how many extra frames/sheets to print
// Shows on operator terminal when scanning — NOT editable on job ticket
function calculateRecommendedOvers(order) {
  const facility = order.facility || '';
  const productType = order.productType || '';
  const printType = order.printType || 'Sheet';
  const material = order.material || '';
  const sheetCount = order.sheetCount || Math.ceil((order.quantity || 0) / (order.piecesPerSheet || 1));
  const hasUV = order.hasUV || false;
  const hasFoil = order.foilType && order.foilType !== 'None';
  const frameCount = sheetCount; // frames = sheets for calculation

  // ── POUCHES (Cosmo Web materials only) ──
  const isPouch = productType === 'Pouches' || isPouchMaterial(material);
  if (isPouch && facility === '16th-street') {
    let pouchExtra = 0;
    let pouchBreakdown = '';

    if (frameCount < 50) {
      pouchExtra = frameCount; // double
      pouchBreakdown = `${frameCount} frames (100% — double for small run)`;
    } else if (frameCount < 100) {
      pouchExtra = frameCount; // double for under 100
      pouchBreakdown = `${frameCount} frames (100% — double for small run)`;
    } else if (frameCount <= 150) {
      pouchExtra = Math.min(50, Math.ceil(frameCount * 0.5));
      pouchBreakdown = `${pouchExtra} frames (50%, max 50)`;
    } else if (frameCount <= 250) {
      pouchExtra = Math.min(50, Math.ceil(frameCount * 0.25));
      pouchBreakdown = `${pouchExtra} frames (25%, max 50)`;
    } else if (frameCount <= 400) {
      pouchExtra = Math.min(50, Math.max(40, Math.ceil(frameCount * 0.15)));
      pouchBreakdown = `${pouchExtra} frames (15%, min 40, max 50)`;
    } else if (frameCount <= 1000) {
      pouchExtra = Math.min(50, Math.ceil(frameCount * 0.10));
      pouchBreakdown = `${pouchExtra} frames (10%, max 50)`;
    } else {
      pouchExtra = Math.min(80, Math.ceil(frameCount * 0.05));
      pouchBreakdown = `${pouchExtra} frames (5%, max 80)`;
    }

    // UV/Foil extras (same rules as labels: +10 for one, +10 more for both)
    let finishExtra = 0;
    let finishBreakdown = '';
    if (hasUV || hasFoil) {
      finishExtra += 10;
      finishBreakdown += ` + 10 (${hasUV && hasFoil ? 'UV/Foil' : hasUV ? 'UV' : 'Foil'})`;
    }
    if (hasUV && hasFoil) {
      finishExtra += 10;
      finishBreakdown += ' + 10 (both UV & Foil)';
    }

    const total = pouchExtra + finishExtra;
    return {
      extraFrames: total,
      makeReady: 0,
      total,
      unit: 'frames',
      breakdown: pouchBreakdown + finishBreakdown
    };
  }

  // ── LABELS / STICKERS (6K, 16th Street) ──
  const is6KLabel = facility === '16th-street' && (
    productType.includes('Label') || productType.includes('Sticker')
  ) && printType === 'Roll';

  if (is6KLabel) {
    let extraFrames = 5;
    const makeReady = 5;
    let breakdown = '5 extra + 5 make-ready';

    // UV or Foil: +10 extra frames (make-ready stays same)
    if (hasUV || hasFoil) {
      extraFrames += 10;
      breakdown += ` + 10 (${hasUV && hasFoil ? 'UV/Foil' : hasUV ? 'UV' : 'Foil'})`;
    }
    // UV AND Foil: another +10 on top
    if (hasUV && hasFoil) {
      extraFrames += 10;
      breakdown += ' + 10 (both UV & Foil)';
    }

    const total = extraFrames + makeReady;
    return {
      extraFrames,
      makeReady,
      total,
      unit: 'frames',
      breakdown
    };
  }

  // ── SHEETS (15K) — base overs by sheet count ──
  let baseExtra = 0;
  if (sheetCount < 100) baseExtra = 10;
  else if (sheetCount <= 250) baseExtra = 15;
  else if (sheetCount <= 1000) baseExtra = 20;
  else if (sheetCount <= 2500) baseExtra = 25;
  else if (sheetCount <= 5000) baseExtra = 30;
  else baseExtra = 40;

  let finishingExtra = 0;
  let breakdown = `Base: ${baseExtra} sheets`;
  if (hasUV && hasFoil) {
    finishingExtra = 10; // +5 per stage × 2 stages
    breakdown += ` + 5 (UV) + 5 (Foil)`;
  } else if (hasUV) {
    finishingExtra = 5;
    breakdown += ` + 5 (UV)`;
  } else if (hasFoil) {
    finishingExtra = 5;
    breakdown += ` + 5 (Foil)`;
  }

  const total = baseExtra + finishingExtra;
  return {
    extraSheets: total,
    makeReady: 0,
    total,
    unit: 'sheets',
    breakdown
  };
}

// ── Standard Lead Times (Business Days) ────────────────────
// These are operational defaults. Override at runtime via setPulseLeadTimes().
let _pulseLeadTimesOverride = null;
function setPulseLeadTimes(lt) { _pulseLeadTimesOverride = lt; }
function getPulseLeadTimes() { return _pulseLeadTimesOverride || LEAD_TIMES; }

// ── Rush Config Override ─────────────────────────────────────
let _pulseRushConfigOverride = null;
function setPulseRushConfig(cfg) { _pulseRushConfigOverride = cfg; }
function getPulseRushConfig() { return _pulseRushConfigOverride; }
function _rushApproverLabel() {
  const approvers = _pulseRushConfigOverride?.approvers;
  if (!Array.isArray(approvers) || approvers.length === 0) return 'Supervisor';
  return approvers.map(a => a.name).filter(Boolean).join(' or ');
}

const LEAD_TIMES = {
  'Labels (Roll)':        { days: [3, 5], maxQtyStandard: 1000000, label: '3–5 business days (under 1M pcs)' },
  'Labels (Sheet)':       { days: [3, 5], maxQtyStandard: 1000000, label: '3–5 business days (under 1M pcs)' },
  'Diecut Stickers':      { days: [3, 5], maxQtyStandard: 1000000, label: '3–5 business days (under 1M pcs)' },
  'Folding Cartons / Boxes': { days: [5, 7], maxQtyStandard: 50000, label: '5–7 business days (under 50K pcs)' },
  'Business Cards':       { days: [5, 7], maxQtyStandard: 50000, label: '5–7 business days' },
  'Flyers / Postcards':   { days: [5, 7], maxQtyStandard: 50000, label: '5–7 business days' },
  'Booklets':             { days: [5, 7], maxQtyStandard: 50000, label: '5–7 business days' },
  'Pouches':              { days: [7, 7], maxQtyStandard: 100000, label: '7 business days (under 100K pcs)' },
  'Vinyl Signage':        { days: [3, 5], maxQtyStandard: null, label: '3–5 business days' },
  'Banners / Large Format': { days: [3, 5], maxQtyStandard: null, label: '3–5 business days' },
  'Window Decals':        { days: [3, 5], maxQtyStandard: null, label: '3–5 business days' },
  'Wallpaper':            { days: [3, 5], maxQtyStandard: null, label: '3–5 business days' },
  'Sheet Products (Boyd)': { days: [3, 5], maxQtyStandard: null, label: '3–5 business days' },
};

// Add N business days to a date (skipping weekends)
function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}

// Calculate the minimum allowed due date for a product type
function getMinDueDate(productType, quantity) {
  const lt = getPulseLeadTimes()[productType];
  if (!lt) return addBusinessDays(new Date(), 3); // default 3 business days
  // Use the minimum lead time (first value)
  let minDays = lt.days[0];
  // If quantity exceeds standard max, add extra days
  if (lt.maxQtyStandard && quantity > lt.maxQtyStandard) {
    const multiplier = Math.ceil(quantity / lt.maxQtyStandard);
    minDays = Math.max(minDays, lt.days[1] * multiplier);
  }
  return addBusinessDays(new Date(), minDays);
}

// Check if a due date requires rush approval
function checkDueDateRush(productType, quantity, dueDate) {
  if (!dueDate) return { isRush: false };
  const dueDateObj = new Date(dueDate);
  const today = new Date();
  today.setHours(0,0,0,0);
  dueDateObj.setHours(0,0,0,0);

  // No past dates allowed
  if (dueDateObj < today) {
    return { isRush: true, isPast: true, message: 'Due date cannot be in the past.' };
  }

  const businessDaysBetween = countBusinessDays(today, dueDateObj);
  const approverLabel = _rushApproverLabel();

  // Global threshold check — any order due within N business days is rush
  const rushCfg = _pulseRushConfigOverride;
  const thresholdDays = rushCfg?.thresholdDays ?? 0;
  if (thresholdDays > 0 && businessDaysBetween < thresholdDays) {
    return {
      isRush: true,
      isPast: false,
      message: `Rush order: due in ${businessDaysBetween} business day(s), under the ${thresholdDays}-day rush threshold. Requires approval from ${approverLabel}.`,
      standardLeadTime: `${thresholdDays} business days (rush threshold)`
    };
  }

  // Product-specific lead time check
  const minDate = getMinDueDate(productType, quantity);
  minDate.setHours(0,0,0,0);
  const lt = getPulseLeadTimes()[productType];

  if (dueDateObj < minDate) {
    return {
      isRush: true,
      isPast: false,
      message: `Rush order: ${businessDaysBetween} business day(s). Standard lead time is ${lt ? (lt.label || `${lt.days?.[0] ?? lt.minDays ?? '3'}–${lt.days?.[1] ?? lt.maxDays ?? '5'} days`) : '3–5 business days'}. Requires approval from ${approverLabel}.`,
      minDate: minDate.toISOString().split('T')[0],
      standardLeadTime: lt?.label || '3-5 business days'
    };
  }

  return { isRush: false };
}

// Count business days between two dates
function countBusinessDays(startDate, endDate) {
  let count = 0;
  const current = new Date(startDate);
  while (current < endDate) {
    current.setDate(current.getDate() + 1);
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// ── Machine Speeds (Real Production Data) ──────────────────
// Web / 6K line speeds (meters per minute)
const MACHINE_SPEEDS = {
  'HP Indigo 6K': {
    unit: 'm/min',
    speeds: {
      'standard': { speed: 30, label: 'Standard print (no white)' },
      'white-layer': { speed: 15, label: 'With white layer' },
    },
    frameLength: 39, // inches per frame
    notes: 'Up to ~30 m/min best case. With white drops to ~15-16 m/min.'
  },
  'HP Indigo 15K': {
    unit: 'sheets/hr',
    speeds: {
      'standard': { speed: 4000, label: 'Best case' },
      'typical': { speed: 3000, label: 'Typical production' },
      'duplex-white': { speed: 1500, label: 'Duplex/white/double-hit' },
    },
    notes: 'Up to ~4,000 sheets/hr best case. Typical ~3,000. Duplex/white ~1,500-2,000.'
  },
  'GM Die Cutter w/ JetFX': {
    unit: 'm/min',
    speeds: {
      'cutting': { speed: 50, label: 'Die cutting' },
      'uv': { speed: 10, label: 'UV finishing' },
      'foil': { speed: 10, label: 'Foil finishing' },
    },
    notes: 'Cutting ~50-60 m/min. UV ~10 m/min. Foil ~10 m/min.'
  },
  'GM Laser Cutter w/ JetFX': {
    unit: 'm/min',
    speeds: {
      'standard': { speed: 10, label: 'Standard shapes' },
      'complex': { speed: 3, label: 'Complex shapes' },
      'uv': { speed: 10, label: 'UV finishing' },
      'foil': { speed: 10, label: 'Foil finishing' },
    },
    notes: 'Up to ~10 m/min. Complex shapes 3-4 m/min. UV/Foil ~10 m/min.'
  },
  'Laminator (Nobelus)': {
    unit: 'sheets/hr',
    speeds: { 'standard': { speed: 1000, label: 'Standard' } },
    notes: '~1,000 sheets/hr'
  },
  'Scodix': {
    unit: 'sheets/hr',
    speeds: { 'standard': { speed: 650, label: 'UV/Foil embellishment' } },
    notes: '~600-700 sheets/hr'
  },
  'Moll Brothers Cutter': {
    unit: 'sheets/hr',
    speeds: { 'standard': { speed: 2500, label: 'Rotary die cutting' } },
    notes: '~2,000-3,000 sheets/hr (setup dependent)'
  },
  'Moll Brothers Folder-Gluer': {
    unit: 'boxes/hr',
    speeds: {
      'mid-size': { speed: 10000, label: 'Mid-size boxes' },
      'master': { speed: 4000, label: 'Master/large boxes' },
    },
    notes: 'Mid-size ~10,000/hr. Master ~3,000-5,000/hr.'
  },
  'Karlville Poucher': {
    unit: 'pouches/shift',
    speeds: {
      'standard': { speed: 22500, label: 'Standard (8hr shift)' },
      'complex': { speed: 16500, label: 'With UV/complexity (8hr shift)' },
    },
    notes: 'Standard ~20-25K/shift. Complex ~15-18K/shift.'
  },
  'Roland Printers': {
    unit: 'min/sheet',
    speeds: { 'standard': { speed: 12, label: '~12 min per sheet' } },
    count: 3,
    notes: '3 machines. Each ~12 min/sheet for boxes/cardstock. Small jobs only.'
  },
  'Laminator (Boyd)': {
    unit: 'min/sheet',
    speeds: { 'standard': { speed: 3, label: '~3 min per sheet' } },
    count: 2,
    notes: '2 laminators. ~3 min/sheet each.'
  },
  'Graphtec Flatbed (Large) x2': {
    unit: 'min/sheet',
    speeds: { 'standard': { speed: 5, label: '~5 min per sheet' } },
    count: 2,
    notes: '2 large flatbeds + 1 small. ~5 min/sheet each.'
  },
  'Graphtec Flatbed (Small)': {
    unit: 'min/sheet',
    speeds: { 'standard': { speed: 5, label: '~5 min per sheet' } },
    count: 1,
    notes: '~5 min/sheet.'
  },
  'Duplo': {
    unit: 'min/sheet',
    speeds: { 'standard': { speed: 5, label: '~5 min per sheet' } },
    notes: 'Flatbed cutting. Similar speed to Graphtec.'
  },
  'Guillotine Cutter': {
    unit: 'sheets/hr',
    speeds: { 'standard': { speed: 5000, label: 'Fast — straight cuts' } },
    notes: 'Very fast for straight cuts.'
  },
};

// Calculate production time for a specific order on a specific machine
function calculateMachineTime(machineName, order) {
  const machineInfo = MACHINE_SPEEDS[machineName];
  if (!machineInfo) return null;

  const sheetCount = order.sheetCount || Math.ceil((order.quantity || 0) / (order.piecesPerSheet || 1));
  const hasWhite = order.hasWhiteLayer || (order.colors && order.colors.includes('White'));
  const hasUV = order.hasUV || false;
  const hasFoil = order.foilType && order.foilType !== 'None';
  const result = { machine: machineName, passes: [] };

  if (machineName === 'HP Indigo 6K') {
    const speed = hasWhite ? 15 : 30; // m/min
    const frameLengthMeters = (39 * 0.0254); // 39 inches to meters = ~0.99m
    const totalMeters = sheetCount * frameLengthMeters;
    const minutes = totalMeters / speed;
    result.passes.push({ operation: hasWhite ? 'Print + White' : 'Print', minutes: Math.ceil(minutes), speed: `${speed} m/min` });
    result.totalMinutes = Math.ceil(minutes);
  }
  else if (machineName === 'HP Indigo 15K') {
    const speed = hasWhite ? 1750 : 3000; // sheets/hr
    const hours = sheetCount / speed;
    const minutes = hours * 60;
    result.passes.push({ operation: hasWhite ? 'Print (duplex/white)' : 'Print', minutes: Math.ceil(minutes), speed: `${speed} sheets/hr` });
    result.totalMinutes = Math.ceil(minutes);
  }
  else if (machineName.includes('GM Die') || machineName.includes('GM Laser')) {
    const isLaser = machineName.includes('Laser');
    const cutSpeed = isLaser ? 10 : 50; // m/min
    const frameLengthMeters = (39 * 0.0254);
    const totalMeters = sheetCount * frameLengthMeters;
    let totalMin = Math.ceil(totalMeters / cutSpeed);
    result.passes.push({ operation: isLaser ? 'Laser Cut' : 'Die Cut', minutes: totalMin, speed: `${cutSpeed} m/min` });
    if (hasUV) {
      const uvMin = Math.ceil(totalMeters / 10);
      result.passes.push({ operation: 'UV (JetFX)', minutes: uvMin, speed: '10 m/min' });
      totalMin += uvMin;
    }
    if (hasFoil) {
      const foilMin = Math.ceil(totalMeters / 10);
      result.passes.push({ operation: 'Foil (JetFX)', minutes: foilMin, speed: '10 m/min' });
      totalMin += foilMin;
    }
    result.totalMinutes = totalMin;
  }
  else if (machineName === 'Laminator (Nobelus)') {
    const minutes = Math.ceil((sheetCount / 1000) * 60);
    result.passes.push({ operation: 'Laminating', minutes, speed: '~1,000 sheets/hr' });
    result.totalMinutes = minutes;
  }
  else if (machineName === 'Scodix') {
    const minutes = Math.ceil((sheetCount / 650) * 60);
    result.passes.push({ operation: 'Embellishment', minutes, speed: '~650 sheets/hr' });
    if (hasUV && hasFoil) {
      // Two-pass process
      result.passes = [
        { operation: 'UV Pass', minutes: Math.ceil(minutes), speed: '~650 sheets/hr' },
        { operation: 'Foil Pass', minutes: Math.ceil(minutes), speed: '~650 sheets/hr' }
      ];
      result.totalMinutes = minutes * 2;
    } else {
      result.totalMinutes = minutes;
    }
  }
  else if (machineName.includes('Moll') && machineName.includes('Cutter')) {
    const minutes = Math.ceil((sheetCount / 2500) * 60);
    result.passes.push({ operation: 'Die Cutting', minutes, speed: '~2,500 sheets/hr' });
    result.totalMinutes = minutes;
  }
  else if (machineName.includes('Moll') && machineName.includes('Folder')) {
    const speed = (order.quantity || 0) > 10000 ? 10000 : 4000; // mid-size vs master
    const minutes = Math.ceil(((order.quantity || sheetCount) / speed) * 60);
    result.passes.push({ operation: 'Fold & Glue', minutes, speed: `~${speed.toLocaleString()}/hr` });
    result.totalMinutes = minutes;
  }
  else if (machineName === 'Karlville Poucher') {
    const perShift = hasUV ? 16500 : 22500;
    const shifts = Math.ceil((order.quantity || 0) / perShift);
    result.passes.push({ operation: 'Pouching', minutes: shifts * DEFAULT_PRODUCTIVE_HOURS_PER_DAY * 60, speed: `~${perShift.toLocaleString()}/shift` });
    result.totalMinutes = shifts * DEFAULT_PRODUCTIVE_HOURS_PER_DAY * 60;
  }
  else if (machineName === 'Roland Printers') {
    const minPerSheet = 12;
    const machines = 3;
    const minutes = Math.ceil((sheetCount * minPerSheet) / machines);
    result.passes.push({ operation: 'Print', minutes, speed: `${minPerSheet} min/sheet × ${machines} machines` });
    result.totalMinutes = minutes;
  }
  else if (machineName.includes('Laminator (Boyd)')) {
    const minPerSheet = 3;
    const machines = 2;
    const minutes = Math.ceil((sheetCount * minPerSheet) / machines);
    result.passes.push({ operation: 'Laminating', minutes, speed: `${minPerSheet} min/sheet × ${machines}` });
    result.totalMinutes = minutes;
  }
  else if (machineName.includes('Graphtec Flatbed')) {
    const minPerSheet = 5;
    const machines = machineName.includes('Large') ? 2 : 1;
    const minutes = Math.ceil((sheetCount * minPerSheet) / machines);
    result.passes.push({ operation: 'Flatbed Cut', minutes, speed: `${minPerSheet} min/sheet × ${machines}` });
    result.totalMinutes = minutes;
  }
  else {
    return null;
  }

  // Convert to work hours/days
  const workHoursPerDay = getMachineDailyWorkHours(machineName) || DEFAULT_PRODUCTIVE_HOURS_PER_DAY;
  result.totalHours = +(result.totalMinutes / 60).toFixed(1);
  result.totalDays = +(result.totalMinutes / 60 / workHoursPerDay).toFixed(1);
  result.shiftsNeeded = Math.ceil(result.totalMinutes / 60 / workHoursPerDay);

  return result;
}

// Calculate total estimated production time through ALL remaining workflow steps
function calculateFullProductionTime(order) {
  const steps = order.workflowSteps || [];
  const currentIdx = order.currentStep || 0;
  let totalMinutes = 0;
  const stepTimes = [];

  for (let i = currentIdx; i < steps.length; i++) {
    const step = steps[i];
    if (step.status === 'completed') continue;
    const time = calculateMachineTime(step.machine, order);
    if (time) {
      totalMinutes += time.totalMinutes;
      stepTimes.push({ machine: step.machine, ...time });
    } else {
      // Estimate 2 hours for unknown machines
      totalMinutes += 120;
      stepTimes.push({ machine: step.machine, totalMinutes: 120, totalHours: 2, totalDays: 0.3, passes: [{ operation: 'Processing', minutes: 120 }] });
    }
  }

  const workHoursPerDay = DEFAULT_PRODUCTIVE_HOURS_PER_DAY;
  return {
    totalMinutes,
    totalHours: +(totalMinutes / 60).toFixed(1),
    totalDays: +(totalMinutes / 60 / workHoursPerDay).toFixed(1),
    shiftsNeeded: Math.ceil(totalMinutes / 60 / workHoursPerDay),
    steps: stepTimes
  };
}

// ── Machine Queue & Capacity Check ─────────────────────────
// Check if a new order can fit in the production schedule by its due date
// Returns: { fits, details[] per machine, suggestedAction, totalDaysNeeded, availableWorkDays }
async function checkProductionCapacity(newOrder, workflowSteps) {
  const allOrders = await getAllOrders();
  const dueDate = new Date(newOrder.dueDate);
  const today = new Date();
  today.setHours(0,0,0,0);
  dueDate.setHours(23,59,59,999);

  // Count available business days until due date
  const availableWorkDays = countBusinessDays(today, dueDate);

  const machineDetails = [];
  let totalProductionMinutes = 0;
  let bottleneckMachine = null;
  let bottleneckDays = 0;

  for (const step of workflowSteps) {
    const machine = step.machine || step;
    // Calculate time for THIS order on this machine
    const orderTime = calculateMachineTime(machine, newOrder);
    const orderMinutes = orderTime?.totalMinutes || 120; // default 2hr if unknown

    // Calculate existing queue load on this machine
    const queuedOrders = allOrders.filter(o => {
      if (['completed','shipped','received','waiting-pickup','delivery-ready','cancelled'].includes(o.status)) return false;
      const steps = o.workflowSteps || [];
      const currentIdx = o.currentStep || 0;
      // Check if any pending/active step uses this machine
      for (let i = currentIdx; i < steps.length; i++) {
        if (steps[i].machine === machine && steps[i].status !== 'completed') return true;
      }
      return false;
    });

    let queueMinutes = 0;
    for (const qo of queuedOrders) {
      const qt = calculateMachineTime(machine, qo);
      queueMinutes += qt?.totalMinutes || 60;
    }

    const totalMinutesOnMachine = queueMinutes + orderMinutes;
    const totalHoursOnMachine = totalMinutesOnMachine / 60;
    const queueHours = queueMinutes / 60;
    const machineHoursPerDay = getMachineDailyWorkHours(machine);
    const queueDays = +(queueHours / machineHoursPerDay).toFixed(1);
    const totalDaysExact = +(totalHoursOnMachine / machineHoursPerDay).toFixed(1);
    const daysNeeded = Math.ceil(totalHoursOnMachine / machineHoursPerDay);
    const daysForJustThisOrder = Math.ceil(orderMinutes / 60 / machineHoursPerDay);
    const overtimeHoursNeededRaw = Math.max(0, totalHoursOnMachine - (availableWorkDays * machineHoursPerDay));
    const overtimePerDayNeeded = !availableWorkDays || overtimeHoursNeededRaw <= 0
      ? 0
      : +(overtimeHoursNeededRaw / availableWorkDays).toFixed(1);

    totalProductionMinutes += orderMinutes;

    const machineFits = daysNeeded <= availableWorkDays;

    if (daysNeeded > bottleneckDays) {
      bottleneckDays = daysNeeded;
      bottleneckMachine = machine;
    }

    machineDetails.push({
      machine,
      queuedJobs: queuedOrders.length,
      queueMinutes: Math.round(queueMinutes),
      queueHours: +queueHours.toFixed(1),
      queueDays,
      orderMinutes: Math.round(orderMinutes),
      orderHours: +(orderMinutes / 60).toFixed(1),
      machineHoursPerDay,
      totalMinutes: Math.round(totalMinutesOnMachine),
      totalHours: +(totalHoursOnMachine).toFixed(1),
      totalDaysExact,
      daysNeeded,
      daysForThisOrder: daysForJustThisOrder,
      fits: machineFits,
      backlogClearHours: +queueHours.toFixed(1),
      backlogClearDays: queueDays,
      overtimeHoursNeeded: machineFits ? 0 : Math.ceil(overtimeHoursNeededRaw),
      overtimeHoursNeededExact: +overtimeHoursNeededRaw.toFixed(1),
      overtimePerDayNeeded,
      daysLate: machineFits ? 0 : Math.max(0, +(totalDaysExact - availableWorkDays).toFixed(1)),
    });
  }

  const fits = machineDetails.every(m => m.fits);
  let suggestedAction = '';
  if (!fits) {
    const overloaded = machineDetails.filter(m => !m.fits);
    const primaryOverload = [...overloaded].sort((a, b) => b.overtimeHoursNeededExact - a.overtimeHoursNeededExact)[0];
    const maxOvertime = Math.max(...overloaded.map(m => m.overtimeHoursNeededExact));
    const extraShiftsNeeded = Math.ceil(maxOvertime / DEFAULT_PRODUCTIVE_HOURS_PER_DAY);
    const extensionDays = Math.max(1, bottleneckDays - availableWorkDays);
    const overtimePerDay = primaryOverload?.overtimePerDayNeeded
      ? ` (~${primaryOverload.overtimePerDayNeeded} overtime hrs/day over the next ${availableWorkDays} work day${availableWorkDays === 1 ? '' : 's'})`
      : '';
    suggestedAction = `⚠️ ${overloaded.length} machine${overloaded.length > 1 ? 's' : ''} overloaded. Bottleneck: ${bottleneckMachine} (${bottleneckDays} days needed, ${availableWorkDays} available). Suggest ${extraShiftsNeeded} overtime shift${extraShiftsNeeded > 1 ? 's' : ''} (~${maxOvertime.toFixed(1)}hrs extra) on ${primaryOverload?.machine || bottleneckMachine}${overtimePerDay}, or extend the due date by ~${extensionDays} work day${extensionDays === 1 ? '' : 's'}.`;
  }

  return {
    fits,
    availableWorkDays,
    totalProductionMinutes: Math.round(totalProductionMinutes),
    totalProductionHours: +(totalProductionMinutes / 60).toFixed(1),
    totalProductionDays: Math.ceil(totalProductionMinutes / 60 / DEFAULT_PRODUCTIVE_HOURS_PER_DAY),
    bottleneckMachine,
    bottleneckDays,
    machineDetails,
    suggestedAction,
  };
}

// Calculate estimated days for a machine to process an order
function estimateMachineDays(machineName, order) {
  const machineTime = calculateMachineTime(machineName, order);
  if (machineTime?.totalHours) {
    return Math.ceil(machineTime.totalHours / (getMachineDailyWorkHours(machineName) || DEFAULT_PRODUCTIVE_HOURS_PER_DAY));
  }
  const cap = MACHINE_CAPACITY[machineName];
  if (!cap) return null;
  if (cap.dailySheets) {
    const sheets = order.sheetCount || Math.ceil((order.quantity || 0) / (order.piecesPerSheet || 1));
    return Math.ceil(sheets / cap.dailySheets);
  }
  if (cap.dailyLinearFeet) {
    const feet = order.linearFeet || order.quantity || 0;
    return Math.ceil(feet / cap.dailyLinearFeet);
  }
  if (cap.dailyPouches) {
    return Math.ceil((order.quantity || 0) / cap.dailyPouches);
  }
  if (cap.dailyUnits) {
    return Math.ceil((order.quantity || 0) / cap.dailyUnits);
  }
  if (cap.dailySqFt) {
    const sqft = order.sqFt || order.quantity || 0;
    return Math.ceil(sqft / cap.dailySqFt);
  }
  return null;
}

// Calculate total estimated production days for an order through all remaining steps
function estimateTotalProductionDays(order) {
  const steps = order.workflowSteps || [];
  const currentIdx = order.currentStep || 0;
  let totalDays = 0;
  for (let i = currentIdx; i < steps.length; i++) {
    const step = steps[i];
    if (step.status === 'completed') continue;
    const days = estimateMachineDays(step.machine, order);
    totalDays += days || 1; // minimum 1 day per step
  }
  return totalDays;
}

// ── Operator Roles & Machine Assignments ───────────────────
// IndexedDB dev fallback only. Supabase: profiles.machines + getAllPersonnel().
const OPERATOR_PROFILES = {
  'Arsen':     { userId: 1001, facility: 'boyd-street', machines: ['Canon Colorado','Roland Printers','Graphtec Vinyl Cutter x4','Graphtec Flatbed (Large) x2','Graphtec Flatbed (Small)','Laminator (Boyd)'], role: 'operator', shift: '6:00 AM', notes: 'Boyd — all machines' },
  'Tuoyo':     { userId: 1002, facility: '16th-street', machines: ['HP Indigo 15K'], role: 'operator', shift: '2:30 PM', notes: '15K press operator, afternoon shift' },
  'Mauricio':  { userId: 1003, facility: '16th-street', machines: ['HP Indigo 15K','HP Indigo 6K','GM Die Cutter w/ JetFX','GM Laser Cutter w/ JetFX','Moll Brothers Cutter','Moll Brothers Folder-Gluer','Laminator (Nobelus)','Scodix','Guillotine Cutter'], role: 'supervisor', shift: '5:00 AM', notes: 'Supervisor — can run all 16th St machines. Opens shop.' },
  'Abel':      { userId: 1004, facility: '16th-street', machines: ['Scodix','HP Indigo 15K'], role: 'operator', shift: '6:00 AM', notes: 'Primary Scodix, backup 15K. Sometimes runs both.' },
  'Juan':      { userId: 1005, facility: '16th-street', machines: ['HP Indigo 6K'], role: 'operator', shift: '6:00 AM', notes: '6K press operator' },
  'Vahe':      { userId: 1006, facility: '16th-street', machines: ['GM Die Cutter w/ JetFX','GM Laser Cutter w/ JetFX'], role: 'operator', shift: '6:00 AM', notes: 'GM die cutter + laser cutter + JetFX UV/Foil' },
  'Hrach':     { userId: 1007, facility: '16th-street', machines: [], role: 'prepress', shift: '8:00 AM', notes: 'Prepress — file prep, proofing, plate setup' },
  'Avgustin':  { userId: 1008, facility: '16th-street', machines: ['Moll Brothers Folder-Gluer'], role: 'operator', shift: '6:00 AM', notes: 'Folder & Gluer operator' },
  'Jaime':     { userId: 1009, facility: '16th-street', machines: ['Moll Brothers Cutter'], role: 'operator', shift: '7:00 AM', notes: 'Moll Brothers die cutter' },
  'Lisandro':  { userId: 1010, facility: '16th-street', machines: ['Laminator (Nobelus)','Duplo','Guillotine Cutter'], role: 'operator', shift: '6:00 AM', notes: 'Laminator + Duplo + Guillotine' },
  'Adrian':    { userId: 1011, facility: '16th-street', machines: ['Karlville Poucher','Laminator (Nobelus)'], role: 'operator', shift: '6:00 AM', notes: 'Primary Karlville poucher, backup laminator' },
  'Harry':     { userId: 1012, facility: '16th-street', machines: ['Karlville Poucher','HP Indigo 6K'], role: 'operator', shift: '6:00 AM', notes: 'Primary Karlville, knows 6K (not expert)' },
  'Mike':      { userId: 1013, facility: '16th-street', machines: [], role: 'production-manager', shift: '7:00 AM', notes: 'Production manager (new)' },
  'Tigran Zohrabyan': { facility: 'all', machines: [], role: 'supervisor', shift: '—', notes: 'Supervisor' },
};

const DEFAULT_PRODUCTIVE_HOURS_PER_DAY = 7;
const OPERATOR_DAILY_HOURS_OVERRIDES = {
  'Tuoyo': 5,
};

function parseShiftStart(shift) {
  if (!shift || shift === '—') return { hour: 6, minute: 0 };
  const match = String(shift).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return { hour: 6, minute: 0 };
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return { hour, minute };
}

let _pulsePersonnelCache = [];

/** Refresh in-memory personnel cache from Supabase profiles (scheduling + machine assignments). */
async function loadPulsePersonnelCache() {
  if (typeof pulseUsesSupabaseStorage === 'function' && !pulseUsesSupabaseStorage()) {
    _pulsePersonnelCache = [];
    return _pulsePersonnelCache;
  }
  if (typeof getAllPersonnel !== 'function') {
    _pulsePersonnelCache = [];
    return _pulsePersonnelCache;
  }
  try {
    _pulsePersonnelCache = await getAllPersonnel();
  } catch (_) {
    _pulsePersonnelCache = [];
  }
  return _pulsePersonnelCache;
}

function _personnelRowsForScheduling() {
  if (typeof pulseUsesSupabaseStorage === 'function' && pulseUsesSupabaseStorage()) {
    return _pulsePersonnelCache || [];
  }
  return Object.entries(OPERATOR_PROFILES).map(([name, profile]) => ({ name, ...profile }));
}

function getMachineAssignedOperators(machineName) {
  return _personnelRowsForScheduling()
    .filter(p => {
      const role = String(p.role || '').replace(/_/g, '-');
      return role === 'operator' && Array.isArray(p.machines) && p.machines.includes(machineName);
    })
    .map(p => ({
      name: p.name,
      hoursPerDay: OPERATOR_DAILY_HOURS_OVERRIDES[p.name] || DEFAULT_PRODUCTIVE_HOURS_PER_DAY,
      shift: p.shift || p.shift_start || '',
      profile: p,
    }));
}

function getMachineDailyWorkHours(machineName) {
  if (machineName === 'Prepress') return DEFAULT_PRODUCTIVE_HOURS_PER_DAY;
  const operators = getMachineAssignedOperators(machineName);
  if (!operators.length) return DEFAULT_PRODUCTIVE_HOURS_PER_DAY;
  return operators.reduce((sum, op) => sum + op.hoursPerDay, 0);
}

function getMachineShiftStart(machineName) {
  const operators = getMachineAssignedOperators(machineName);
  if (!operators.length) return { hour: 6, minute: 0 };
  return operators
    .map(op => parseShiftStart(op.shift))
    .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))[0];
}

function moveToNextBusinessShift(date, machineName) {
  const next = new Date(date);
  const { hour, minute } = getMachineShiftStart(machineName);
  next.setSeconds(0, 0);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  next.setHours(hour, minute, 0, 0);
  return next;
}

function addWorkingHours(machineName, hoursToAdd, fromDate = new Date()) {
  const dailyHours = Math.max(0.5, getMachineDailyWorkHours(machineName));
  const { hour, minute } = getMachineShiftStart(machineName);
  let cursor = new Date(fromDate);
  let remaining = Math.max(0, hoursToAdd);

  while (cursor.getDay() === 0 || cursor.getDay() === 6) {
    cursor = moveToNextBusinessShift(cursor, machineName);
  }

  while (remaining > 0) {
    const dayStart = new Date(cursor);
    dayStart.setHours(hour, minute, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + dailyHours * 60 * 60 * 1000);

    if (cursor < dayStart) cursor = new Date(dayStart);
    if (cursor >= dayEnd) {
      cursor = moveToNextBusinessShift(new Date(dayStart.getTime() + 24 * 60 * 60 * 1000), machineName);
      continue;
    }

    const availableToday = (dayEnd.getTime() - cursor.getTime()) / (60 * 60 * 1000);
    const consume = Math.min(remaining, availableToday);
    cursor = new Date(cursor.getTime() + consume * 60 * 60 * 1000);
    remaining -= consume;

    if (remaining > 0) {
      cursor = moveToNextBusinessShift(new Date(dayStart.getTime() + 24 * 60 * 60 * 1000), machineName);
    }
  }

  return cursor;
}

async function estimateOrderSchedule(order, workflowSteps) {
  const allOrders = await getAllOrders();
  const activeStatuses = ['prepress', 'prepress-active', 'prepress-paused', 'pending-review', 'in-production', 'on-hold', 'qc-checkout', 'qc-failed', 'ready-to-ship', 'pending-confirmation'];
  const now = new Date();
  let cursor = new Date(now);
  const machinePlans = [];

  for (const step of workflowSteps || []) {
    const machine = step.machine || step;
    const orderTime = calculateMachineTime(machine, order);
    const orderHours = orderTime?.totalHours || ((orderTime?.totalMinutes || 120) / 60);

    const queuedOrders = allOrders.filter(o => {
      if (order?.id && o.id === order.id) return false;
      if (!activeStatuses.includes(o.status)) return false;
      const steps = o.workflowSteps || [];
      const currentIdx = o.currentStep || 0;
      for (let i = currentIdx; i < steps.length; i++) {
        if (steps[i].machine === machine && steps[i].status !== 'completed') return true;
      }
      return false;
    });

    let queueHours = 0;
    for (const queued of queuedOrders) {
      const queuedTime = calculateMachineTime(machine, queued);
      queueHours += queuedTime?.totalHours || ((queuedTime?.totalMinutes || 60) / 60);
    }

    const availableAt = addWorkingHours(machine, queueHours, now);
    const startAt = new Date(Math.max(cursor.getTime(), availableAt.getTime()));
    const finishAt = addWorkingHours(machine, orderHours, startAt);

    machinePlans.push({
      machine,
      orderHours: +orderHours.toFixed(1),
      queueHours: +queueHours.toFixed(1),
      availableAt: availableAt.toISOString(),
      startAt: startAt.toISOString(),
      finishAt: finishAt.toISOString(),
      dailyHours: getMachineDailyWorkHours(machine),
    });

    cursor = finishAt;
  }

  return {
    generatedAt: now.toISOString(),
    totalOrderHours: +machinePlans.reduce((sum, plan) => sum + plan.orderHours, 0).toFixed(1),
    finalFinishAt: machinePlans.length ? machinePlans[machinePlans.length - 1].finishAt : now.toISOString(),
    machinePlans,
  };
}

// ── Break & Meal Rules (California Labor Law) ──────────────
// Rest Break 1: ~2-3 hrs after clock-in (10 min paid)
// Meal Break 1: MUST start before end of 5th hour (30 min unpaid)
// Rest Break 2: ~2-3 hrs after meal return (10 min paid)
// Meal Break 2: Required if working 10+ hours, must start before 10th hour (30 min unpaid)
const BREAK_RULES = {
  rest1:  { duration: 10, paid: true,  triggerAfterMin: 120, label: '1st Rest Break (10 min)' },
  meal1:  { duration: 30, paid: false, deadlineHour: 5, label: '1st Meal Break (30 min)' },
  rest2:  { duration: 10, paid: true,  triggerAfterMealMin: 150, label: '2nd Rest Break (10 min)' },
  meal2:  { duration: 30, paid: false, deadlineHour: 10, label: '2nd Meal Break (30 min)', onlyIf10hrs: true },
  warnings: {
    mealApproaching: 45,
    mealUrgent: 15,
    breakWindow: 10,
  }
};

// Calculate full break schedule from clock-in time
function calculateBreakSchedule(clockInTime, breaksTaken) {
  const ci = new Date(clockInTime);
  const ciMin = ci.getHours() * 60 + ci.getMinutes();
  const breaks = breaksTaken || {};

  // Rest 1: ~2-3 hours after clock-in
  const rest1Suggested = ciMin + 150; // 2.5 hours

  // Meal 1: must START before 5th hour from clock-in
  const meal1Deadline = ciMin + 300; // 5 hours
  const meal1Suggested = ciMin + 240; // suggest at 4 hours

  // Rest 2: ~2-3 hours after meal return
  let rest2Suggested = null;
  if (breaks.meal1?.end) {
    const mealEndMin = new Date(breaks.meal1.end).getHours() * 60 + new Date(breaks.meal1.end).getMinutes();
    rest2Suggested = mealEndMin + 150; // 2.5 hours after meal return
  } else {
    rest2Suggested = meal1Suggested + 30 + 150; // estimate
  }

  // Meal 2: only if shift will be 10+ hours, must start before 10th hour
  const meal2Deadline = ciMin + 600; // 10 hours
  const meal2Suggested = ciMin + 540; // 9 hours

  return {
    clockIn: ci.toISOString(),
    clockInMinutes: ciMin,
    rest1:  { suggestedMinute: rest1Suggested, deadlineMinute: null, duration: 10 },
    meal1:  { suggestedMinute: meal1Suggested, deadlineMinute: meal1Deadline, duration: 30 },
    rest2:  { suggestedMinute: rest2Suggested, deadlineMinute: null, duration: 10 },
    meal2:  { suggestedMinute: meal2Suggested, deadlineMinute: meal2Deadline, duration: 30 },
  };
}

// Determine which breaks are available/due/taken right now
function getAvailableBreaks(clockInTime, breaksTaken) {
  const ci = new Date(clockInTime);
  const now = new Date();
  const minutesWorked = (now - ci) / 60000;
  const breaks = breaksTaken || {};

  const result = [];

  // Rest Break 1: available ~2hrs in, not taken yet
  if (!breaks.rest1?.start && minutesWorked >= 90) {
    result.push({ key: 'rest1', label: '☕ 1st Rest Break (10 min)', duration: 10, status: 'available' });
  } else if (breaks.rest1?.start && !breaks.rest1?.end) {
    result.push({ key: 'rest1', label: '☕ 1st Rest Break — IN PROGRESS', duration: 10, status: 'active' });
  } else if (breaks.rest1?.end) {
    result.push({ key: 'rest1', label: '☕ 1st Rest Break', duration: 10, status: 'taken' });
  } else {
    result.push({ key: 'rest1', label: '☕ 1st Rest Break (10 min)', duration: 10, status: 'not-yet', unlockAt: 90 - minutesWorked });
  }

  // Meal Break 1: available after rest1 or ~3.5hrs in, mandatory before 5th hour
  const meal1Available = minutesWorked >= 180 || breaks.rest1?.end;
  if (!breaks.meal1?.start && meal1Available) {
    const urgency = minutesWorked >= 270 ? 'urgent' : 'available';
    result.push({ key: 'meal1', label: '🍽️ Meal Break (30 min)', duration: 30, status: urgency, deadline: 300 - minutesWorked });
  } else if (breaks.meal1?.start && !breaks.meal1?.end) {
    result.push({ key: 'meal1', label: '🍽️ Meal Break — IN PROGRESS', duration: 30, status: 'active' });
  } else if (breaks.meal1?.end) {
    result.push({ key: 'meal1', label: '🍽️ Meal Break', duration: 30, status: 'taken' });
  } else {
    result.push({ key: 'meal1', label: '🍽️ Meal Break (30 min)', duration: 30, status: 'not-yet' });
  }

  // Rest Break 2: available ~2-3hrs after meal return
  if (breaks.meal1?.end) {
    const mealReturnMin = (now - new Date(breaks.meal1.end)) / 60000;
    if (!breaks.rest2?.start && mealReturnMin >= 90) {
      result.push({ key: 'rest2', label: '☕ 2nd Rest Break (10 min)', duration: 10, status: 'available' });
    } else if (breaks.rest2?.start && !breaks.rest2?.end) {
      result.push({ key: 'rest2', label: '☕ 2nd Rest Break — IN PROGRESS', duration: 10, status: 'active' });
    } else if (breaks.rest2?.end) {
      result.push({ key: 'rest2', label: '☕ 2nd Rest Break', duration: 10, status: 'taken' });
    } else {
      result.push({ key: 'rest2', label: '☕ 2nd Rest Break (10 min)', duration: 10, status: 'not-yet', unlockAt: 90 - mealReturnMin });
    }
  }

  // Meal Break 2: only if 10+ hours shift, available after ~8hrs
  if (minutesWorked >= 480 || (breaks.rest2?.end && minutesWorked >= 420)) {
    if (!breaks.meal2?.start) {
      const urgency2 = minutesWorked >= 570 ? 'urgent' : 'available';
      result.push({ key: 'meal2', label: '🍽️ 2nd Meal Break (30 min)', duration: 30, status: urgency2, deadline: 600 - minutesWorked });
    } else if (breaks.meal2?.start && !breaks.meal2?.end) {
      result.push({ key: 'meal2', label: '🍽️ 2nd Meal Break — IN PROGRESS', duration: 30, status: 'active' });
    } else if (breaks.meal2?.end) {
      result.push({ key: 'meal2', label: '🍽️ 2nd Meal Break', duration: 30, status: 'taken' });
    }
  }

  return result;
}

// Get break status color: green/yellow/red
function getBreakStatus(clockInTime, currentTime, breaksTaken) {
  if (!clockInTime) return { color: 'gray', message: 'Not clocked in' };
  const ci = new Date(clockInTime);
  const now = new Date(currentTime || Date.now());
  const minutesSinceClockIn = (now - ci) / 60000;
  const mealDeadline = 5 * 60; // 5 hours in minutes
  const meal1Taken = breaksTaken?.meal1?.start;
  const meal2Taken = breaksTaken?.meal2?.start;
  const mealDeadline2 = 10 * 60; // 10 hours

  // Check meal 2 violation (10+ hours)
  if (!meal2Taken && minutesSinceClockIn >= mealDeadline2) {
    return { color: 'red', message: '🔴 2ND MEAL VIOLATION — break overdue!' };
  }
  // Check meal 1 violation
  if (!meal1Taken && minutesSinceClockIn >= mealDeadline) {
    return { color: 'red', message: '🔴 MEAL VIOLATION — meal break overdue!' };
  }
  if (!meal1Taken && minutesSinceClockIn >= mealDeadline - 15) {
    return { color: 'red', message: `⚠️ Meal required within ${Math.ceil(mealDeadline - minutesSinceClockIn)} min` };
  }
  if (!meal1Taken && minutesSinceClockIn >= mealDeadline - 45) {
    return { color: 'yellow', message: `⏰ Meal break due in ${Math.ceil(mealDeadline - minutesSinceClockIn)} min` };
  }
  // Check meal 2 approaching (if 10+ hour shift)
  if (!meal2Taken && minutesSinceClockIn >= mealDeadline2 - 45) {
    return { color: 'yellow', message: `⏰ 2nd meal break due in ${Math.ceil(mealDeadline2 - minutesSinceClockIn)} min` };
  }
  return { color: 'green', message: '✅ On schedule' };
}

// ── Points / Coins System ──────────────────────────────────
// Operators earn coins for meeting daily machine targets
// 25 coins/month converts to reward (TBD)
const POINTS_RULES = {
  dailyTargetMet: 1,      // +1 coin for meeting daily target
  dailyTargetExceeded: 2,  // +2 coins for exceeding by 10%+
  behindTarget: -1,        // -1 coin for falling behind
  monthlyConversion: 25,   // 25 coins = reward
};

const ORDER_STATUSES = [
  'waiting-approval', 'new', 'pending-confirmation', 'pending-review', 'prepress', 'prepress-active', 'prepress-paused', 'pending-account-manager', 'on-hold',
  'in-production', 'reprint', 'qc-checkout', 'qc-failed', 'ready-to-ship',
  'shipped', 'waiting-pickup', 'delivery-ready', 'received', 'completed'
];

const MATERIALS = [
  { category: 'BOPP', items: ['Clear BOPP', 'White BOPP', 'Silver BOPP', 'Holo BOPP'] },
  { category: 'Cosmetic Web', items: ['Clear Cosmetic Web', 'White Cosmetic Web', 'Silver Cosmetic Web'] },
  { category: 'Label Sheets', items: ['Gloss Label Sheet', 'Matte Label Sheet', 'Semi Gloss'] },
  { category: 'Cardstock', items: [
    '14pt C1S', '14pt C2S', '16pt C1S', '16pt C2S',
    '18pt C1S', '18pt C2S', '18pt Silver',
    '24pt C1S', '24pt C2S'
  ]},
  { category: 'Cardstock (Boyd)', items: ['16pt', '18pt', '20pt', '24pt'] },
  { category: 'Cover/Text Stock', items: ['80lb Cover', '100lb Cover', '110lb Cover', '80lb Text', '100lb Text'] },
  { category: 'Cover Stock', items: ['80lb Cover', '100lb Cover', '110lb Cover'] },
  { category: 'Vinyl (Boyd)', items: ['White Vinyl', 'White Vinyl - Aggressive Glue', 'Holographic Vinyl'] },
  { category: 'Banner Material (Boyd)', items: ['Banner Material'] },
  { category: 'Window Decal Material (Boyd)', items: ['Window Decal'] },
  { category: 'Wallpaper Material (Boyd)', items: ['Self-Adhesive (Peel-and-Stick)', 'Traditional / Unpasted'] },
  { category: 'Specialty (Boyd)', items: ['Window Decal', 'Wallpaper Material', 'Banner Material'] },
  { category: 'Sheet (Boyd)', items: ['18pt (Boyd)', '20pt (Boyd)', '24pt (Boyd)'] },
  { category: 'Other', items: ['Vinyl'] }
];

const OPERATIONS = [
  'File Prep', 'Artwork Fix', 'Preflight', 'Proofing',
  'Printing', 'Laminating', 'Spot UV', 'Foil Stamping', 'Embossing', 'Texture',
  'Pouching', 'Cutting', 'Scoring', 'Creasing', 'Folding', 'Gluing',
  'Die Cutting', 'Laser Cutting', 'JetFX Finishing', 'Guillotine Cutting',
  'UV Coating', 'Booklet Folding', 'Sealing',
  'Large Format Printing', 'Vinyl Cutting', 'Contour Cutting'
];

// Product types → which material categories are valid
const PRODUCT_TYPES = {
  'Labels (Roll)': {
    materials: ['BOPP', 'Label Sheets'],
    defaultPrintType: 'Roll',
    facilities: ['16th-street'],
    notes: 'Roll labels printed on 6K at 16th Street. NOT Cosmetic Web.'
  },
  'Labels (Sheet)': {
    materials: ['Label Sheets'],
    defaultPrintType: 'Sheet',
    facilities: ['16th-street'],
    notes: 'Sheet labels — Label Sheets only'
  },
  'Vinyl Labels / 54\'\' Rolls': {
    materials: ['Vinyl (Boyd)'],
    defaultPrintType: 'Roll',
    facilities: ['boyd-street'],
    notes: 'Boyd vinyl label roll workflow'
  },
  'Pouches': {
    materials: ['Cosmetic Web'],
    defaultPrintType: 'Roll',
    facilities: ['16th-street'],
    notes: 'Pouches — ONLY Cosmetic Web materials (Clear/White/Silver). 6K → GM → Karlville Poucher'
  },
  'Folding Cartons / Boxes': {
    materials: ['Cardstock'],
    defaultPrintType: 'Sheet',
    facilities: ['16th-street', 'boyd-street'],
    notes: 'Boxes — 15K at 16th Street or Boyd box workflow depending facility'
  },
  'Business Cards': {
    materials: ['Cardstock', 'Cover Stock'],
    defaultPrintType: 'Sheet',
    defaultPiecesPerSheet: 16,
    facilities: ['16th-street'],
    notes: 'Cards — 15K → Lamination → Duplo or Guillotine. No text stock.'
  },
  'Flyers / Postcards': {
    materials: ['Cover/Text Stock', 'Cardstock'],
    defaultPrintType: 'Sheet',
    defaultPiecesPerSheet: 4,
    facilities: ['16th-street'],
    notes: 'Flat sheets — 15K → Lamination → Cutting'
  },
  'Booklets': {
    materials: ['Cover/Text Stock'],
    defaultPrintType: 'Sheet',
    defaultPiecesPerSheet: 4,
    facilities: ['16th-street'],
    notes: 'Booklets — 15K → Lamination → Booklet Folder → Guillotine'
  },
  'Diecut Stickers': {
    materials: ['BOPP', 'Label Sheets'],
    defaultPrintType: 'Sheet',
    facilities: ['16th-street', 'boyd-street'],
    notes: 'Diecut stickers — can be sheet or roll'
  },
  'Vinyl Signage': {
    materials: ['Vinyl (Boyd)'],
    defaultPrintType: 'Roll',
    facilities: ['boyd-street'],
    notes: 'Vinyl — Canon Colorado (gloss) or Roland (matte) → Graphtec vinyl cutters'
  },
  'Banners / Large Format': {
    materials: ['Specialty (Boyd)'],
    defaultPrintType: 'Roll',
    facilities: ['boyd-street'],
    notes: 'Large format — Canon Colorado or Roland'
  },
  'Window Decals': {
    materials: ['Specialty (Boyd)'],
    defaultPrintType: 'Roll',
    facilities: ['boyd-street'],
    notes: 'Window decals — print + contour cut'
  },
  'Wallpaper': {
    materials: ['Specialty (Boyd)'],
    defaultPrintType: 'Roll',
    facilities: ['boyd-street'],
    notes: 'Wallpaper material'
  },
  'Sheet Products (Boyd)': {
    materials: ['Sheet (Boyd)'],
    defaultPrintType: 'Sheet',
    facilities: ['boyd-street'],
    notes: '18pt/20pt/24pt sheets at Boyd → Lamination → Graphtec Flatbed'
  },
  'Other': {
    materials: ['BOPP', 'Cosmetic Web', 'Label Sheets', 'Cardstock', 'Cover/Text Stock', 'Vinyl (Boyd)', 'Specialty (Boyd)', 'Sheet (Boyd)', 'Other'],
    defaultPrintType: 'Sheet',
    facilities: ['16th-street', 'boyd-street'],
    notes: ''
  }
};

// ── Packaging Catalog Seed Data (PUL-715) ─────────────────────
// Source: product-catalog-v2.json — 68 SKUs built 2026-04-27
// Used by seedPackagingCatalogIfEmpty() to populate IndexedDB on first load
const PACKAGING_CATALOG_SEED = [
  {
    "sku": "210000000006",
    "name": "1 Gram Bag",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.03,
    "sell_price": 0.1,
    "markup_pct": 233.3,
    "tier_pricing": {
      "qty_25": 0.1,
      "qty_50": 0.092,
      "qty_100": 0.085,
      "qty_250": 0.08,
      "qty_500": 0.075,
      "qty_1000": 0.07,
      "qty_5000": 0.062
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000153",
    "name": "1 Gram Bag With Window",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.12,
    "markup_pct": 140.0,
    "tier_pricing": {
      "qty_25": 0.12,
      "qty_50": 0.1104,
      "qty_100": 0.102,
      "qty_250": 0.096,
      "qty_500": 0.09,
      "qty_1000": 0.084,
      "qty_5000": 0.0744
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000007",
    "name": "1 Ounce Bag Regular",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.08,
    "sell_price": 0.3,
    "markup_pct": 275.0,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000008",
    "name": "1 Ounce Bag With Window",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.11,
    "sell_price": 0.3,
    "markup_pct": 172.7,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000012",
    "name": "1 Ounce Laser Bag",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.1,
    "sell_price": 0.3,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000013",
    "name": "1/2 Gram Bag",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.02,
    "sell_price": 0.1,
    "markup_pct": 400.0,
    "tier_pricing": {
      "qty_25": 0.1,
      "qty_50": 0.092,
      "qty_100": 0.085,
      "qty_250": 0.08,
      "qty_500": 0.075,
      "qty_1000": 0.07,
      "qty_5000": 0.062
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000014",
    "name": "1/2 Ounce Bag",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.08,
    "sell_price": 0.2,
    "markup_pct": 150.0,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000015",
    "name": "1/2 Ounce Bag With Window",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.08,
    "sell_price": 0.25,
    "markup_pct": 212.5,
    "tier_pricing": {
      "qty_25": 0.25,
      "qty_50": 0.23,
      "qty_100": 0.2125,
      "qty_250": 0.2,
      "qty_500": 0.1875,
      "qty_1000": 0.175,
      "qty_5000": 0.155
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000026",
    "name": "12x9 Exit Bag",
    "category": "Bags",
    "material": "Plastic/Mylar",
    "production_method": "digital",
    "default_cost": 0.21,
    "sell_price": 0.8,
    "markup_pct": 281.0,
    "tier_pricing": {
      "qty_25": 0.8,
      "qty_50": 0.736,
      "qty_100": 0.68,
      "qty_250": 0.64,
      "qty_500": 0.6,
      "qty_1000": 0.56,
      "qty_5000": 0.496
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000046",
    "name": "4x5 1/8 Bags Square Corners",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.04,
    "sell_price": 0.15,
    "markup_pct": 275.0,
    "tier_pricing": {
      "qty_25": 0.15,
      "qty_50": 0.138,
      "qty_100": 0.1275,
      "qty_250": 0.12,
      "qty_500": 0.1125,
      "qty_1000": 0.105,
      "qty_5000": 0.093
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000044",
    "name": "4x5 Bags Childproof",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.15,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.15,
      "qty_50": 0.138,
      "qty_100": 0.1275,
      "qty_250": 0.12,
      "qty_500": 0.1125,
      "qty_1000": 0.105,
      "qty_5000": 0.093
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000045",
    "name": "4x5 Bags Round Corners",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.15,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.15,
      "qty_50": 0.138,
      "qty_100": 0.1275,
      "qty_250": 0.12,
      "qty_500": 0.1125,
      "qty_1000": 0.105,
      "qty_5000": 0.093
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000047",
    "name": "4x5 Laser Bag",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.2,
    "markup_pct": 300.0,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000048",
    "name": "4x5 Matte Bag",
    "category": "Bags",
    "material": "Matte Mylar",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.15,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.15,
      "qty_50": 0.138,
      "qty_100": 0.1275,
      "qty_250": 0.12,
      "qty_500": 0.1125,
      "qty_1000": 0.105,
      "qty_5000": 0.093
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000049",
    "name": "4x7 Laser Bags",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.06,
    "sell_price": 0.2,
    "markup_pct": 233.3,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000050",
    "name": "5 inch Laser Round Bag",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.08,
    "sell_price": 0.2,
    "markup_pct": 150.0,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000054",
    "name": "5x8 Laser Bags",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.07,
    "sell_price": 0.2,
    "markup_pct": 185.7,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000058",
    "name": "7 Gram Bags Glossy Childproof 4x6",
    "category": "Bags",
    "material": "Glossy Mylar",
    "production_method": "digital",
    "default_cost": 0.07,
    "sell_price": 0.2,
    "markup_pct": 185.7,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000059",
    "name": "7 Gram Laser Bags",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.2,
    "markup_pct": 300.0,
    "tier_pricing": {
      "qty_25": 0.2,
      "qty_50": 0.184,
      "qty_100": 0.17,
      "qty_250": 0.16,
      "qty_500": 0.15,
      "qty_1000": 0.14,
      "qty_5000": 0.124
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000060",
    "name": "7 Gram or 1/4 Bags",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.04,
    "sell_price": 0.15,
    "markup_pct": 275.0,
    "tier_pricing": {
      "qty_25": 0.15,
      "qty_50": 0.138,
      "qty_100": 0.1275,
      "qty_250": 0.12,
      "qty_500": 0.1125,
      "qty_1000": 0.105,
      "qty_5000": 0.093
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000062",
    "name": "8x6 Exit Bag",
    "category": "Bags",
    "material": "Plastic/Mylar",
    "production_method": "digital",
    "default_cost": 0.09,
    "sell_price": 0.5,
    "markup_pct": 455.6,
    "tier_pricing": {
      "qty_25": 0.5,
      "qty_50": 0.46,
      "qty_100": 0.425,
      "qty_250": 0.4,
      "qty_500": 0.375,
      "qty_1000": 0.35,
      "qty_5000": 0.31
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000118",
    "name": "Pound Bags",
    "category": "Bags",
    "material": "Mylar",
    "production_method": "digital",
    "default_cost": 0.45,
    "sell_price": 1.0,
    "markup_pct": 122.2,
    "tier_pricing": {
      "qty_25": 1.0,
      "qty_50": 0.92,
      "qty_100": 0.85,
      "qty_250": 0.8,
      "qty_500": 0.75,
      "qty_1000": 0.7,
      "qty_5000": 0.62
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000119",
    "name": "Pound Bags Laser",
    "category": "Bags",
    "material": "Laser/Metallic Mylar",
    "production_method": "digital",
    "default_cost": 0.53,
    "sell_price": 2.0,
    "markup_pct": 277.4,
    "tier_pricing": {
      "qty_25": 2.0,
      "qty_50": 1.84,
      "qty_100": 1.7,
      "qty_250": 1.6,
      "qty_500": 1.5,
      "qty_1000": 1.4,
      "qty_5000": 1.24
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000011",
    "name": "1 Ounce Glass Jars",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.15,
    "sell_price": 0.5,
    "markup_pct": 233.3,
    "tier_pricing": {
      "qty_25": 0.5,
      "qty_50": 0.46,
      "qty_100": 0.425,
      "qty_250": 0.4,
      "qty_500": 0.375,
      "qty_1000": 0.35,
      "qty_5000": 0.31
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000016",
    "name": "10 Ounce Glass Jar - Clear",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.5,
    "sell_price": 1.0,
    "markup_pct": 100.0,
    "tier_pricing": {
      "qty_25": 1.0,
      "qty_50": 0.92,
      "qty_100": 0.85,
      "qty_250": 0.8,
      "qty_500": 0.75,
      "qty_1000": 0.7,
      "qty_5000": 0.62
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000155",
    "name": "10 Ounce Plastic Jar",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.31,
    "sell_price": 0.7,
    "markup_pct": 125.8,
    "tier_pricing": {
      "qty_25": 0.7,
      "qty_50": 0.644,
      "qty_100": 0.595,
      "qty_250": 0.56,
      "qty_500": 0.525,
      "qty_1000": 0.49,
      "qty_5000": 0.434
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000140",
    "name": "100ml UV Jar",
    "category": "Jars",
    "material": "UV Glass",
    "production_method": "digital",
    "default_cost": 1.2,
    "sell_price": 3.2,
    "markup_pct": 166.7,
    "tier_pricing": {
      "qty_25": 3.2,
      "qty_50": 2.944,
      "qty_100": 2.72,
      "qty_250": 2.56,
      "qty_500": 2.4,
      "qty_1000": 2.24,
      "qty_5000": 1.984
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000141",
    "name": "150ml UV Jar",
    "category": "Jars",
    "material": "UV Glass",
    "production_method": "digital",
    "default_cost": 1.4,
    "sell_price": 3.2,
    "markup_pct": 128.6,
    "tier_pricing": {
      "qty_25": 3.2,
      "qty_50": 2.944,
      "qty_100": 2.72,
      "qty_250": 2.56,
      "qty_500": 2.4,
      "qty_1000": 2.24,
      "qty_5000": 1.984
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000027",
    "name": "18 Ounce Glass Jar Clear",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.83,
    "sell_price": 2.0,
    "markup_pct": 141.0,
    "tier_pricing": {
      "qty_25": 2.0,
      "qty_50": 1.84,
      "qty_100": 1.7,
      "qty_250": 1.6,
      "qty_500": 1.5,
      "qty_1000": 1.4,
      "qty_5000": 1.24
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000148",
    "name": "18 Ounce Plastic Jar",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.41,
    "sell_price": 1.2,
    "markup_pct": 192.7,
    "tier_pricing": {
      "qty_25": 1.2,
      "qty_50": 1.104,
      "qty_100": 1.02,
      "qty_250": 0.96,
      "qty_500": 0.9,
      "qty_1000": 0.84,
      "qty_5000": 0.744
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000030",
    "name": "2 Ounce Black Glass Jar",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.37,
    "sell_price": 0.65,
    "markup_pct": 75.7,
    "tier_pricing": {
      "qty_25": 0.65,
      "qty_50": 0.598,
      "qty_100": 0.5525,
      "qty_250": 0.52,
      "qty_500": 0.4875,
      "qty_1000": 0.455,
      "qty_5000": 0.403
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000029",
    "name": "2 Ounce Clear Glass Jar",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.21,
    "sell_price": 0.45,
    "markup_pct": 114.3,
    "tier_pricing": {
      "qty_25": 0.45,
      "qty_50": 0.414,
      "qty_100": 0.3825,
      "qty_250": 0.36,
      "qty_500": 0.3375,
      "qty_1000": 0.315,
      "qty_5000": 0.279
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000031",
    "name": "2 Ounce Jar Tall Glass",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.18,
    "sell_price": 0.5,
    "markup_pct": 177.8,
    "tier_pricing": {
      "qty_25": 0.5,
      "qty_50": 0.46,
      "qty_100": 0.425,
      "qty_250": 0.4,
      "qty_500": 0.375,
      "qty_1000": 0.35,
      "qty_5000": 0.31
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000156",
    "name": "2 Ounce Jar Tall Glass Colored Round",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.3,
    "sell_price": 1.0,
    "markup_pct": 233.3,
    "tier_pricing": {
      "qty_25": 1.0,
      "qty_50": 0.92,
      "qty_100": 0.85,
      "qty_250": 0.8,
      "qty_500": 0.75,
      "qty_1000": 0.7,
      "qty_5000": 0.62
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000032",
    "name": "2 Ounce Jar Tall Plastic",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.16,
    "sell_price": 0.45,
    "markup_pct": 181.3,
    "tier_pricing": {
      "qty_25": 0.45,
      "qty_50": 0.414,
      "qty_100": 0.3825,
      "qty_250": 0.36,
      "qty_500": 0.3375,
      "qty_1000": 0.315,
      "qty_5000": 0.279
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000037",
    "name": "3 Ounce Clear Glass Jar",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.22,
    "sell_price": 0.55,
    "markup_pct": 150.0,
    "tier_pricing": {
      "qty_25": 0.55,
      "qty_50": 0.506,
      "qty_100": 0.4675,
      "qty_250": 0.44,
      "qty_500": 0.4125,
      "qty_1000": 0.385,
      "qty_5000": 0.341
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000036",
    "name": "3 Ounce Glass Jar - Black See-Through",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.43,
    "sell_price": 0.75,
    "markup_pct": 74.4,
    "tier_pricing": {
      "qty_25": 0.75,
      "qty_50": 0.69,
      "qty_100": 0.6375,
      "qty_250": 0.6,
      "qty_500": 0.5625,
      "qty_1000": 0.525,
      "qty_5000": 0.465
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000038",
    "name": "3 Ounce Jar Chubby Gorilla Clear",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.44,
    "sell_price": 0.83,
    "markup_pct": 88.6,
    "tier_pricing": {
      "qty_25": 0.83,
      "qty_50": 0.7636,
      "qty_100": 0.7055,
      "qty_250": 0.664,
      "qty_500": 0.6225,
      "qty_1000": 0.581,
      "qty_5000": 0.5146
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000157",
    "name": "3 Ounce Matte Black Glass Jar",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.34,
    "sell_price": 0.7,
    "markup_pct": 105.9,
    "tier_pricing": {
      "qty_25": 0.7,
      "qty_50": 0.644,
      "qty_100": 0.595,
      "qty_250": 0.56,
      "qty_500": 0.525,
      "qty_1000": 0.49,
      "qty_5000": 0.434
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000039",
    "name": "3 Ounce Plastic Jar",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.1,
    "sell_price": 0.5,
    "markup_pct": 400.0,
    "tier_pricing": {
      "qty_25": 0.5,
      "qty_50": 0.46,
      "qty_100": 0.425,
      "qty_250": 0.4,
      "qty_500": 0.375,
      "qty_1000": 0.35,
      "qty_5000": 0.31
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000040",
    "name": "4 Ounce Black Glass Jar",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.34,
    "sell_price": 0.7,
    "markup_pct": 105.9,
    "tier_pricing": {
      "qty_25": 0.7,
      "qty_50": 0.644,
      "qty_100": 0.595,
      "qty_250": 0.56,
      "qty_500": 0.525,
      "qty_1000": 0.49,
      "qty_5000": 0.434
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000041",
    "name": "4 Ounce Glass Jar Clear",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.26,
    "sell_price": 0.6,
    "markup_pct": 130.8,
    "tier_pricing": {
      "qty_25": 0.6,
      "qty_50": 0.552,
      "qty_100": 0.51,
      "qty_250": 0.48,
      "qty_500": 0.45,
      "qty_1000": 0.42,
      "qty_5000": 0.372
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000042",
    "name": "4 Ounce Plastic Jar Clear",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.1,
    "sell_price": 0.3,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000051",
    "name": "5 Ounce Jar Chubby Gorilla Clear Plastic",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.41,
    "sell_price": 0.83,
    "markup_pct": 102.4,
    "tier_pricing": {
      "qty_25": 0.83,
      "qty_50": 0.7636,
      "qty_100": 0.7055,
      "qty_250": 0.664,
      "qty_500": 0.6225,
      "qty_1000": 0.581,
      "qty_5000": 0.5146
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000154",
    "name": "5 Ounce Plastic Jar with Cap",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.32,
    "sell_price": 0.65,
    "markup_pct": 103.1,
    "tier_pricing": {
      "qty_25": 0.65,
      "qty_50": 0.598,
      "qty_100": 0.5525,
      "qty_250": 0.52,
      "qty_500": 0.4875,
      "qty_1000": 0.455,
      "qty_5000": 0.403
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000052",
    "name": "5ml Jar Black Glass Square/Round",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.3,
    "sell_price": 0.55,
    "markup_pct": 83.3,
    "tier_pricing": {
      "qty_25": 0.55,
      "qty_50": 0.506,
      "qty_100": 0.4675,
      "qty_250": 0.44,
      "qty_500": 0.4125,
      "qty_1000": 0.385,
      "qty_5000": 0.341
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000053",
    "name": "5ml Jar Clear Glass Square/Round",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.16,
    "sell_price": 0.45,
    "markup_pct": 181.3,
    "tier_pricing": {
      "qty_25": 0.45,
      "qty_50": 0.414,
      "qty_100": 0.3825,
      "qty_250": 0.36,
      "qty_500": 0.3375,
      "qty_1000": 0.315,
      "qty_5000": 0.279
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000055",
    "name": "6 Ounce Jar Clear Glass Round",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.37,
    "sell_price": 0.8,
    "markup_pct": 116.2,
    "tier_pricing": {
      "qty_25": 0.8,
      "qty_50": 0.736,
      "qty_100": 0.68,
      "qty_250": 0.64,
      "qty_500": 0.6,
      "qty_1000": 0.56,
      "qty_5000": 0.496
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000056",
    "name": "60MM Chubby Gorilla Jar Clear Plastic",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.33,
    "sell_price": 0.66,
    "markup_pct": 100.0,
    "tier_pricing": {
      "qty_25": 0.66,
      "qty_50": 0.6072,
      "qty_100": 0.561,
      "qty_250": 0.528,
      "qty_500": 0.495,
      "qty_1000": 0.462,
      "qty_5000": 0.4092
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000067",
    "name": "9ml Black or Frosty Glass Jar",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.26,
    "sell_price": 0.6,
    "markup_pct": 130.8,
    "tier_pricing": {
      "qty_25": 0.6,
      "qty_50": 0.552,
      "qty_100": 0.51,
      "qty_250": 0.48,
      "qty_500": 0.45,
      "qty_1000": 0.42,
      "qty_5000": 0.372
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000068",
    "name": "9ml Jar Clear Glass Round/Square",
    "category": "Jars",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.21,
    "sell_price": 0.45,
    "markup_pct": 114.3,
    "tier_pricing": {
      "qty_25": 0.45,
      "qty_50": 0.414,
      "qty_100": 0.3825,
      "qty_250": 0.36,
      "qty_500": 0.3375,
      "qty_1000": 0.315,
      "qty_5000": 0.279
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000136",
    "name": "Push Pop Jars 16 pcs",
    "category": "Jars",
    "material": "Acrylic/Specialty",
    "production_method": "digital",
    "default_cost": 14.0,
    "sell_price": 32.0,
    "markup_pct": 128.6,
    "tier_pricing": {
      "qty_25": 32.0,
      "qty_50": 29.44,
      "qty_100": 27.2,
      "qty_250": 25.6,
      "qty_500": 24.0,
      "qty_1000": 22.4,
      "qty_5000": 19.84
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000149",
    "name": "3D Jars 3-5 inch",
    "category": "Jars",
    "material": "Acrylic/Specialty",
    "production_method": "digital",
    "default_cost": 2.0,
    "sell_price": 6.0,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 6.0,
      "qty_50": 5.52,
      "qty_100": 5.1,
      "qty_250": 4.8,
      "qty_500": 4.5,
      "qty_1000": 4.2,
      "qty_5000": 3.72
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000133",
    "name": "3D Jars Small up to 3 inch height",
    "category": "Jars",
    "material": "Acrylic/Specialty",
    "production_method": "digital",
    "default_cost": 0.65,
    "sell_price": 4.0,
    "markup_pct": 515.4,
    "tier_pricing": {
      "qty_25": 4.0,
      "qty_50": 3.68,
      "qty_100": 3.4,
      "qty_250": 3.2,
      "qty_500": 3.0,
      "qty_1000": 2.8,
      "qty_5000": 2.48
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000150",
    "name": "18.5 Ounce Jar Chubby Gorilla Clear with Black Cap",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 1.28,
    "sell_price": 2.5,
    "markup_pct": 95.3,
    "tier_pricing": {
      "qty_25": 2.5,
      "qty_50": 2.3,
      "qty_100": 2.125,
      "qty_250": 2.0,
      "qty_500": 1.875,
      "qty_1000": 1.75,
      "qty_5000": 1.55
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000151",
    "name": "10 Ounce Chubby Gorilla Clear with White Cap",
    "category": "Jars",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 1.17,
    "sell_price": 2.5,
    "markup_pct": 113.7,
    "tier_pricing": {
      "qty_25": 2.5,
      "qty_50": 2.3,
      "qty_100": 2.125,
      "qty_250": 2.0,
      "qty_500": 1.875,
      "qty_1000": 1.75,
      "qty_5000": 1.55
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000017",
    "name": "100MM Chubby Gorilla Black Tube",
    "category": "Tubes",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.22,
    "sell_price": 0.72,
    "markup_pct": 227.3,
    "tier_pricing": {
      "qty_25": 0.72,
      "qty_50": 0.6624,
      "qty_100": 0.612,
      "qty_250": 0.576,
      "qty_500": 0.54,
      "qty_1000": 0.504,
      "qty_5000": 0.4464
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000018",
    "name": "100MM Chubby Gorilla Clear Tube Black Cap",
    "category": "Tubes",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.22,
    "sell_price": 0.72,
    "markup_pct": 227.3,
    "tier_pricing": {
      "qty_25": 0.72,
      "qty_50": 0.6624,
      "qty_100": 0.612,
      "qty_250": 0.576,
      "qty_500": 0.54,
      "qty_1000": 0.504,
      "qty_5000": 0.4464
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000020",
    "name": "113MM Chubby Gorilla Tube",
    "category": "Tubes",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.22,
    "sell_price": 0.72,
    "markup_pct": 227.3,
    "tier_pricing": {
      "qty_25": 0.72,
      "qty_50": 0.6624,
      "qty_100": 0.612,
      "qty_250": 0.576,
      "qty_500": 0.54,
      "qty_1000": 0.504,
      "qty_5000": 0.4464
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000021",
    "name": "115MM Chubby Gorilla Spiral Tube",
    "category": "Tubes",
    "material": "Plastic (HDPE)",
    "production_method": "digital",
    "default_cost": 0.39,
    "sell_price": 0.72,
    "markup_pct": 84.6,
    "tier_pricing": {
      "qty_25": 0.72,
      "qty_50": 0.6624,
      "qty_100": 0.612,
      "qty_250": 0.576,
      "qty_500": 0.54,
      "qty_1000": 0.504,
      "qty_5000": 0.4464
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000022",
    "name": "116 Pre Roll Plastic Tube",
    "category": "Tubes",
    "material": "Plastic (PP)",
    "production_method": "digital",
    "default_cost": 0.04,
    "sell_price": 0.1,
    "markup_pct": 150.0,
    "tier_pricing": {
      "qty_25": 0.1,
      "qty_50": 0.092,
      "qty_100": 0.085,
      "qty_250": 0.08,
      "qty_500": 0.075,
      "qty_1000": 0.07,
      "qty_5000": 0.062
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000024",
    "name": "120MM Chubby Gorilla Clear Glass Tube Black Cap",
    "category": "Tubes",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.25,
    "sell_price": 0.72,
    "markup_pct": 188.0,
    "tier_pricing": {
      "qty_25": 0.72,
      "qty_50": 0.6624,
      "qty_100": 0.612,
      "qty_250": 0.576,
      "qty_500": 0.54,
      "qty_1000": 0.504,
      "qty_5000": 0.4464
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000033",
    "name": "20x120MM Clear Glass Tube Cork Cap",
    "category": "Tubes",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.1,
    "sell_price": 0.3,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000034",
    "name": "22x115MM Clear Glass Tube",
    "category": "Tubes",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.11,
    "sell_price": 0.3,
    "markup_pct": 172.7,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000035",
    "name": "27x115MM Clear Glass Tube",
    "category": "Tubes",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.11,
    "sell_price": 0.3,
    "markup_pct": 172.7,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000063",
    "name": "95MM Chubby Gorilla Clear Glass Tube Any Cap",
    "category": "Tubes",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.34,
    "sell_price": 0.72,
    "markup_pct": 111.8,
    "tier_pricing": {
      "qty_25": 0.72,
      "qty_50": 0.6624,
      "qty_100": 0.612,
      "qty_250": 0.576,
      "qty_500": 0.54,
      "qty_1000": 0.504,
      "qty_5000": 0.4464
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000065",
    "name": "98MM Clear Glass Tube",
    "category": "Tubes",
    "material": "Glass",
    "production_method": "digital",
    "default_cost": 0.1,
    "sell_price": 0.3,
    "markup_pct": 200.0,
    "tier_pricing": {
      "qty_25": 0.3,
      "qty_50": 0.276,
      "qty_100": 0.255,
      "qty_250": 0.24,
      "qty_500": 0.225,
      "qty_1000": 0.21,
      "qty_5000": 0.186
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  },
  {
    "sku": "210000000066",
    "name": "98MM Plastic Pop-Top Tube",
    "category": "Tubes",
    "material": "Plastic (PP)",
    "production_method": "digital",
    "default_cost": 0.05,
    "sell_price": 0.1,
    "markup_pct": 100.0,
    "tier_pricing": {
      "qty_25": 0.1,
      "qty_50": 0.092,
      "qty_100": 0.085,
      "qty_250": 0.08,
      "qty_500": 0.075,
      "qty_1000": 0.07,
      "qty_5000": 0.062
    },
    "lead_time_days": null,
    "min_qty": 25,
    "source_link": null,
    "notes": null
  }
];

// ── End Packaging Catalog Seed Data ────────────────────────

// Get filtered materials for a product type
function getMaterialsForProduct(productType, facility = '') {
  const pt = PRODUCT_TYPES[productType];
  if (!pt) return MATERIALS; // show all if unknown
  let allowedCategories = pt.materials;
  if (facility === 'boyd-street' && productType === 'Folding Cartons / Boxes') {
    allowedCategories = ['Cardstock (Boyd)'];
  } else if (facility === 'boyd-street' && productType === 'Diecut Stickers') {
    allowedCategories = ['Vinyl (Boyd)'];
  } else if (facility === 'boyd-street' && productType === 'Banners / Large Format') {
    allowedCategories = ['Banner Material (Boyd)'];
  } else if (facility === 'boyd-street' && productType === 'Window Decals') {
    allowedCategories = ['Window Decal Material (Boyd)'];
  } else if (facility === 'boyd-street' && productType === 'Wallpaper') {
    allowedCategories = ['Wallpaper Material (Boyd)'];
  }
  return MATERIALS.filter(g => allowedCategories.includes(g.category));
}

// Render material options filtered by product type
function renderFilteredMaterialOptions(productType, facility = '') {
  const filtered = getMaterialsForProduct(productType, facility);
  return filtered.map(g => `<optgroup label="${g.category}">${g.items.map(i => `<option value="${i}">${i}</option>`).join('')}</optgroup>`).join('');
}

const LAMINATION_OPTIONS = ['None', 'Gloss', 'Matte', 'Soft Touch', 'Holo', 'Coating'];
const FINISHING_OPTIONS = ['None', 'Spot UV', 'Foil', 'Spot UV + Foil', 'Scodix UV', 'Scodix Foil', 'Scodix UV + Foil'];

const STATUS_LABELS = {
  'waiting-approval': 'Waiting Approval',
  'new': 'New',
  'pending-confirmation': 'Pending Confirmation',
  'pending-review': 'Pending Review',
  'prepress': 'Prepress, Not Started',
  'prepress-active': 'Prepress, Started',
  'prepress-paused': 'Prepress, Paused',
  'step-paused': 'Paused',
  'pending-account-manager': 'Needs Account Manager Fix',
  'in-production': 'In Production',
  'on-hold': 'On Hold',
  'qc-checkout': 'QC Checkout',
  'ready-to-ship': 'Ready to Ship',
  'shipped': 'Shipped',
  'waiting-pickup': 'Waiting Pickup',
  'delivery-ready': 'Delivery Ready',
  'received': 'Received',
  'completed': 'Completed',
  'qc-failed': 'QC Failed',
  'reprint': 'Reprint',
  // PUL-713/714: Order form statuses
  'order-pending':   'Order Draft',
  'order-priced':    'Pricing Locked',
  'order-confirmed': 'Order Confirmed',
};

const STATUS_COLORS = {
  'waiting-approval': '#64748b',
  'new': '#0284c7',
  'pending-confirmation': '#ea580c',
  'pending-review': '#b45309',
  'prepress': '#2563eb',
  'prepress-active': '#059669',
  'prepress-paused': '#c2410c',
  'step-paused': '#9a3412',
  'pending-account-manager': '#dc2626',
  'in-production': '#16a34a',
  'on-hold': '#db2777',
  'qc-checkout': '#7c3aed',
  'ready-to-ship': '#0d9488',
  'shipped': '#475569',
  'waiting-pickup': '#ca8a04',
  'delivery-ready': '#0891b2',
  'received': '#047857',
  'completed': '#6d28d9',
  'qc-failed': '#dc2626',
  'reprint': '#d97706',
  // PUL-713/714: Order form statuses
  'order-pending':   '#64748b',
  'order-priced':    '#1d4ed8',
  'order-confirmed': '#15803d',
};

// ── BroadcastChannel ───────────────────────────────────────

const channel = new BroadcastChannel('bazaar-print-sync');
const _dbUpdateCallbacks = [];

channel.onmessage = (event) => {
  if (event.data && event.data.type === 'db-update') {
    _dbUpdateCallbacks.forEach(cb => cb(event.data));
  }
};

function broadcastUpdate(store, id) {
  channel.postMessage({ type: 'db-update', store, id, timestamp: Date.now() });
}

function onDBUpdate(callback) {
  _dbUpdateCallbacks.push(callback);
}

// Bridge Supabase realtime → onDBUpdate callbacks (PRI-240)
// supabase-client.js fires pulse:* events when Supabase pushes postgres_changes;
// mirror into _dbUpdateCallbacks so pages refresh without polling.
const _PULSE_ADMIN_REFRESH_TABLES = new Set([
  'config',
  'dies',
  'knowledge_base',
  'profiles',
  'organisation_facilities',
  'organisation_hardware',
  'machines',
  'product_workflows',
]);

window.addEventListener('pulse:order-change', (event) => {
  const detail = event.detail || {};
  const table = detail.table || 'orders';
  const id = detail.new?.id || detail.old?.id || null;
  const store = table === 'orders' ? 'orders' : table;
  _dbUpdateCallbacks.forEach(cb => cb({ type: 'db-update', store, id, table }));
});
window.addEventListener('pulse:activity-change', (event) => {
  const id = (event.detail && (event.detail.new?.id || event.detail.old?.id)) || null;
  _dbUpdateCallbacks.forEach(cb => cb({ type: 'db-update', store: 'activity_log', id }));
});
window.addEventListener('pulse:task-change', (event) => {
  const detail = event.detail || {};
  const table = detail.table || 'production_tasks';
  const id = detail.new?.id || detail.old?.id || null;
  _dbUpdateCallbacks.forEach(cb => cb({ type: 'db-update', store: table, id, table }));
});
window.addEventListener('pulse:reference-data-changed', (event) => {
  const detail = event.detail || {};
  const table = detail.table || detail.scope || 'reference';
  const payload = detail.payload || {};
  const id = payload.new?.id || payload.old?.id || null;
  const store = detail.scope || table;
  _dbUpdateCallbacks.forEach(cb => cb({ type: 'db-update', store, id, table }));
  if (_PULSE_ADMIN_REFRESH_TABLES.has(table) && typeof refreshPulseAdminData === 'function') {
    refreshPulseAdminData().catch((e) => console.warn('[Pulse] reference-data refresh', e));
  }
});

function isValidAccessCode(code) {
  return /^\d{4,}$/.test(String(code || '').trim());
}

function isPrepressStatus(status) {
  return ['prepress', 'prepress-active', 'prepress-paused', 'pending-account-manager'].includes(status);
}

function isActivelyWorkedStatus(status) {
  return ['prepress-active', 'in-production'].includes(status);
}

async function buildHoldPatch(order) {
  const reason = prompt('Why is this job being put on hold?');
  if (!reason || !reason.trim()) return null;

  const initiator = (typeof getCurrentName === 'function' ? getCurrentName() : null) || 'Supervisor';
  const initiatorRole = (typeof getCurrentRole === 'function' ? getCurrentRole() : null) || 'unknown';
  const initiatorCode = prompt(`Enter ${initiator}'s code to confirm this hold.`);
  if (!isValidAccessCode(initiatorCode)) {
    alert('A valid 4+ digit code is required to put this job on hold.');
    return null;
  }

  const approvals = [{ name: initiator, role: initiatorRole, kind: 'initiator', at: new Date().toISOString() }];

  if (isActivelyWorkedStatus(order.status)) {
    const ownerName = order.status === 'prepress-active'
      ? (order.prepressStartedBy || 'Prepress')
      : (order.currentOperator || order.workflowSteps?.[order.currentStep || 0]?.assignedTo || 'Current Operator');
    const ownerCode = prompt(`This job is actively being worked. Enter ${ownerName}'s code to approve the hold.`);
    if (!isValidAccessCode(ownerCode)) {
      alert('Current owner/operator approval is required for active jobs.');
      return null;
    }
    approvals.push({ name: ownerName, role: order.status === 'prepress-active' ? 'prepress' : 'operator', kind: 'current-owner', at: new Date().toISOString() });

    if (initiator === 'Tigran Zohrabyan' && order.accountManager) {
      const amCode = prompt(`Enter ${order.accountManager}'s code to confirm this hold.`);
      if (!isValidAccessCode(amCode)) {
        alert('Account manager approval is required when Tigran places an active job on hold.');
        return null;
      }
      approvals.push({ name: order.accountManager, role: 'account-manager', kind: 'account-manager', at: new Date().toISOString() });
    }
  }

  return {
    status: 'on-hold',
    holdReason: reason.trim(),
    holdPreviousStatus: order.status || 'in-production',
    holdRequestedBy: initiator,
    holdRequestedAt: new Date().toISOString(),
    holdApprovals: approvals,
  };
}

// ── IndexedDB ──────────────────────────────────────────────

let _dbInstance = null;

/** True when Supabase overrides are active — IndexedDB must not be opened or written. */
function pulseUsesSupabaseStorage() {
  if (typeof window === 'undefined') return false;
  if (window.PULSE_STORAGE_BACKEND === 'indexeddb') return false;
  if (typeof window.usePulseSupabaseStorage === 'function' && window.usePulseSupabaseStorage()) return true;
  if (window.PULSE_STORAGE_BACKEND === 'supabase') return true;
  const url = window.PULSE_SUPABASE_URL || '';
  const key = window.PULSE_SUPABASE_ANON_KEY || '';
  if (/YOUR-PROJECT-REF/i.test(url) || /YOUR-ANON-KEY/i.test(key)) return false;
  return !!(url && key);
}

/** Route internal shared.js storage calls to window.* Supabase overrides when active. */
function _pulseDelegateStorage(name, localFn, args) {
  if (pulseUsesSupabaseStorage() && typeof window !== 'undefined') {
    const ext = window[name];
    if (typeof ext === 'function' && ext.__pulseSupabaseOverride) {
      return ext.apply(window, args);
    }
    console.warn('[Pulse] Supabase override missing for', name);
    return Promise.reject(new Error(`Supabase override missing: ${name}`));
  }
  return localFn.apply(null, args);
}

if (typeof window !== 'undefined') {
  window.pulseUsesSupabaseStorage = pulseUsesSupabaseStorage;
  window.loadPulsePersonnelCache = loadPulsePersonnelCache;
}

function openDB() {
  if (pulseUsesSupabaseStorage()) {
    return Promise.reject(new Error('IndexedDB disabled — Pulse uses Supabase storage'));
  }
  if (_dbInstance) return Promise.resolve(_dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('orders')) {
        const os = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        os.createIndex('orderId', 'orderId', { unique: true });
        os.createIndex('status', 'status', { unique: false });
        os.createIndex('facility', 'facility', { unique: false });
        os.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('personnel')) {
        const ps = db.createObjectStore('personnel', { keyPath: 'id', autoIncrement: true });
        ps.createIndex('role', 'role', { unique: false });
        ps.createIndex('facility', 'facility', { unique: false });
      }
      if (!db.objectStoreNames.contains('devices')) {
        const ds = db.createObjectStore('devices', { keyPath: 'id', autoIncrement: true });
        ds.createIndex('facility', 'facility', { unique: false });
      }
      if (!db.objectStoreNames.contains('activity_log')) {
        const al = db.createObjectStore('activity_log', { keyPath: 'id', autoIncrement: true });
        al.createIndex('orderId', 'orderId', { unique: false });
        al.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('knowledge_base')) {
        const kb = db.createObjectStore('knowledge_base', { keyPath: 'id', autoIncrement: true });
        kb.createIndex('machine', 'machine', { unique: false });
        kb.createIndex('material', 'material', { unique: false });
        kb.createIndex('operation', 'operation', { unique: false });
      }
      if (!db.objectStoreNames.contains('reprints')) {
        const rp = db.createObjectStore('reprints', { keyPath: 'id', autoIncrement: true });
        rp.createIndex('parentOrderId', 'parentOrderId', { unique: false });
      }
      // Die Registry — v3
      if (!db.objectStoreNames.contains('dies')) {
        const ds = db.createObjectStore('dies', { keyPath: 'id', autoIncrement: true });
        ds.createIndex('dieNumber', 'dieNumber', { unique: true });
        ds.createIndex('barcode', 'barcode', { unique: true });
        ds.createIndex('customer', 'customer', { unique: false });
        ds.createIndex('machine', 'machine', { unique: false });
      }
      // Operator Sessions (clock-in/out, breaks) — v3
      if (!db.objectStoreNames.contains('operator_sessions')) {
        const os = db.createObjectStore('operator_sessions', { keyPath: 'id', autoIncrement: true });
        os.createIndex('operatorName', 'operatorName', { unique: false });
        os.createIndex('date', 'date', { unique: false });
      }
      // Operator Points/Coins — v3
      if (!db.objectStoreNames.contains('operator_points')) {
        const op = db.createObjectStore('operator_points', { keyPath: 'id', autoIncrement: true });
        op.createIndex('operatorName', 'operatorName', { unique: false });
        op.createIndex('date', 'date', { unique: false });
      }
      if (db.objectStoreNames.contains('inventory')) {
        db.deleteObjectStore('inventory');
      }
      // Purchase Orders — v3
      if (!db.objectStoreNames.contains('purchase_orders')) {
        const po = db.createObjectStore('purchase_orders', { keyPath: 'id', autoIncrement: true });
        po.createIndex('poNumber', 'poNumber', { unique: true });
        po.createIndex('vendor', 'vendor', { unique: false });
        po.createIndex('status', 'status', { unique: false });
      }
      // Invoices — v6
      if (!db.objectStoreNames.contains('invoices')) {
        const inv = db.createObjectStore('invoices', { keyPath: 'id', autoIncrement: true });
        inv.createIndex('invoiceNumber', 'invoiceNumber', { unique: true });
        inv.createIndex('orderId', 'orderId', { unique: false });
        inv.createIndex('status', 'status', { unique: false });
        inv.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = (event) => {
      _dbInstance = event.target.result;
      resolve(_dbInstance);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// Generic CRUD helpers — blocked entirely when Supabase is the storage backend.
function _add(storeName, data) {
  if (pulseUsesSupabaseStorage()) {
    return Promise.reject(new Error(`IndexedDB write blocked (${storeName})`));
  }
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.add(data);
    req.onsuccess = () => { broadcastUpdate(storeName, req.result); resolve(req.result); };
    req.onerror = () => reject(req.error);
  }));
}

const _AUTO_INC_STORES = new Set([
  'orders', 'personnel', 'devices', 'activity_log', 'knowledge_base', 'reprints',
  'dies', 'operator_sessions', 'operator_points', 'purchase_orders', 'invoices',
]);

/** IndexedDB auto-increment keys are numbers; onclick handlers often pass string ids. */
function _normalizeStoreKey(storeName, id) {
  if (!_AUTO_INC_STORES.has(storeName) || id == null || id === '') return id;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return id;
}

function _get(storeName, id) {
  if (pulseUsesSupabaseStorage()) {
    return Promise.reject(new Error(`IndexedDB read blocked (${storeName})`));
  }
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(_normalizeStoreKey(storeName, id));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _getAll(storeName) {
  if (pulseUsesSupabaseStorage()) {
    return Promise.reject(new Error(`IndexedDB read blocked (${storeName})`));
  }
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _update(storeName, id, changes) {
  if (pulseUsesSupabaseStorage()) {
    return Promise.reject(new Error(`IndexedDB write blocked (${storeName})`));
  }
  const key = _normalizeStoreKey(storeName, id);
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) { reject(new Error('Not found')); return; }
      const updated = { ...existing, ...changes, updatedAt: new Date().toISOString() };
      const putReq = store.put(updated);
      putReq.onsuccess = () => { broadcastUpdate(storeName, id); resolve(updated); };
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  }));
}

function _delete(storeName, id) {
  if (pulseUsesSupabaseStorage()) {
    return Promise.reject(new Error(`IndexedDB delete blocked (${storeName})`));
  }
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(_normalizeStoreKey(storeName, id));
    req.onsuccess = () => { broadcastUpdate(storeName, id); resolve(); };
    req.onerror = () => reject(req.error);
  }));
}

// ── Order CRUD ─────────────────────────────────────────────

function getOrderIdBase(orderId) {
  return String(orderId || '').split('_')[0] || '';
}

function getNormalizedOrderFamily(orderId) {
  const raw = String(orderId || '').trim();
  if (!raw) return { base: '', sub: null, suffix: '' };
  const parts = raw.split('_');
  const base = parts[0] || '';
  const sub = parts[1] || null;
  const suffix = parts.slice(2).join('_') || '';
  return { base, sub, suffix };
}

async function generateOrderId() {
  const orders = await getAllOrders();
  const baseIds = orders
    .map(o => parseInt(getOrderIdBase(o.orderId), 10))
    .filter(Number.isFinite);
  if (baseIds.length === 0) return '17900';
  return String(Math.max(...baseIds) + 1);
}

function addOrder(order) {
  if (pulseUsesSupabaseStorage() && typeof window.addOrder === 'function' && window.addOrder !== addOrder) {
    return window.addOrder(order);
  }
  order.createdAt = order.createdAt || new Date().toISOString();
  order.updatedAt = new Date().toISOString();
  order.workflowSteps = order.workflowSteps || [];
  order.currentStep = order.currentStep ?? 0;
  order.status = order.status || 'new';
  order.notesLog = [];
  order.conversationHistory = [];
  return _add('orders', order);
}

function getOrder(id) {
  return _pulseDelegateStorage('getOrder', (i) => _get('orders', i), [id]);
}
function getAllOrders() {
  return _pulseDelegateStorage('getAllOrders', () => _getAll('orders'), []);
}
function updateOrder(id, changes) {
  if (pulseUsesSupabaseStorage() && typeof window.updateOrder === 'function' && window.updateOrder !== updateOrder) {
    return window.updateOrder(id, changes);
  }
  const c = { ...(changes || {}), notesLog: [], conversationHistory: [] };
  // Never lose graphics: if this update would leave the order with no artwork
  // but the stored order has some, keep the stored graphics.
  return _get('orders', id).then(existing => {
    if (existing) {
      const merged = { ...existing, ...c };
      if (typeof pulseOrderHasGraphics === 'function'
          && pulseOrderHasGraphics(existing) && !pulseOrderHasGraphics(merged)) {
        pulsePreserveGraphics(c, existing);
      }
    }
    return _update('orders', id, c);
  });
}

// ── Sub-ticket helpers ────────────────────────────────────
async function getSubTickets(parentOrderId) {
  const all = await getAllOrders();
  return all.filter(o => o.parentOrderId === parentOrderId);
}

async function getSubTicketProgress(parentOrderId) {
  const subs = await getSubTickets(parentOrderId);
  if (subs.length === 0) return null;
  const done = subs.filter(o => ['completed','shipped','received','ready-to-ship'].includes(o.status)).length;
  return { total: subs.length, done };
}

async function generateSubTicketId(parentOrderId) {
  const all = await getAllOrders();
  const allIds = new Set(all.map(o => String(o.orderId)));
  const parentBase = getOrderIdBase(parentOrderId);
  let maxNum = 0;
  all.forEach(o => {
    const { base, sub } = getNormalizedOrderFamily(o.orderId);
    if (base === parentBase && sub && /^\d+$/.test(sub)) {
      maxNum = Math.max(maxNum, parseInt(sub, 10));
    }
  });
  let nextNum = maxNum > 0 ? maxNum + 1 : 1;
  while (allIds.has(`${parentBase}_${nextNum}`)) nextNum++;
  return `${parentBase}_${nextNum}`;
}

function getOrderByOrderId(orderId) {
  return _pulseDelegateStorage('getOrderByOrderId', (oid) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const idx = tx.objectStore('orders').index('orderId');
    const req = idx.get(oid);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })), [orderId]);
}

// ── Rush + Notification helpers ───────────────────────────

const PULSE_NOTIFICATION_CONFIG_KEY = 'notification_settings';

function normalizePhoneNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function isRushApproved(order) {
  return !!(order?.isRush && order?.rushApprovedBy);
}

function isDueToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return dateStr === local;
}

function isProductionStarted(status) {
  return ['in-production','qc-checkout','ready-to-ship','completed','shipped','received'].includes(status);
}

function isRushDueTodayAndNotInProduction(order) {
  return !!(isRushApproved(order) && isDueToday(order?.dueDate) && !isProductionStarted(order?.status));
}

function compareOrdersByRushDue(a, b) {
  const rushDelta = Number(isRushApproved(b)) - Number(isRushApproved(a));
  if (rushDelta !== 0) return rushDelta;
  const dueA = a?.dueDate ? new Date(`${a.dueDate}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
  const dueB = b?.dueDate ? new Date(`${b.dueDate}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
  if (dueA !== dueB) return dueA - dueB;
  return new Date(b?.updatedAt || b?.createdAt || 0) - new Date(a?.updatedAt || a?.createdAt || 0);
}

function renderRushFlag(order) {
  return isRushApproved(order)
    ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:#fee2e2;color:#b91c1c;font-size:10px;font-weight:800;letter-spacing:0.04em;">🚨 RUSH</span>`
    : '';
}

async function getNotificationSettings() {
  const record = await getConfig(PULSE_NOTIFICATION_CONFIG_KEY).catch(() => null);
  return {
    enabled: false,
    proxyBase: 'http://127.0.0.1:8879',
    testMode: false,
    testNumber: '',
    recipients: {},
    rushWatchers: [],
    events: {
      prepressReturned: true,
      rushDueTodayNotInProduction: true,
    },
    cooldownMinutes: {
      prepressReturned: 60,
      rushDueTodayNotInProduction: 180,
    },
    ...(window.PULSE_NOTIFICATION_DEFAULTS || {}),
    ...(record?.value || {}),
  };
}

async function setNotificationSettings(value) {
  return setConfig(PULSE_NOTIFICATION_CONFIG_KEY, {
    enabled: !!value?.enabled,
    proxyBase: value?.proxyBase || 'http://127.0.0.1:8879',
    testMode: !!value?.testMode,
    testNumber: value?.testNumber || '',
    recipients: value?.recipients || {},
    rushWatchers: Array.isArray(value?.rushWatchers) ? value.rushWatchers : [],
    events: value?.events || {},
    cooldownMinutes: value?.cooldownMinutes || {},
    updatedAt: new Date().toISOString(),
  });
}

function getNotificationMemory() {
  if (typeof window !== 'undefined' && window.usePulseSupabaseStorage?.()) {
    return window.getNotificationMemory();
  }
  try {
    return JSON.parse(localStorage.getItem('pulse_notification_memory') || '{}');
  } catch (e) {
    return {};
  }
}

function rememberNotification(key) {
  if (typeof window !== 'undefined' && window.usePulseSupabaseStorage?.()) {
    return window.rememberNotification(key);
  }
  try {
    const memory = JSON.parse(localStorage.getItem('pulse_notification_memory') || '{}');
    memory[key] = Date.now();
    localStorage.setItem('pulse_notification_memory', JSON.stringify(memory));
  } catch (e) {}
}

async function hasRecentNotification(key, cooldownMinutes = 60) {
  const memory = await Promise.resolve(getNotificationMemory());
  const previous = memory[key];
  return !!(previous && (Date.now() - previous) < (cooldownMinutes * 60 * 1000));
}

function resolveNotificationRecipients(eventKey, order, settings) {
  if (settings.testMode && settings.testNumber) {
    return [{ name: 'Hayk Test', phone: normalizePhoneNumber(settings.testNumber) }];
  }

  if (eventKey === 'prepressReturned') {
    const phone = normalizePhoneNumber(settings.recipients?.[order?.accountManager]);
    return phone ? [{ name: order.accountManager, phone }] : [];
  }

  if (eventKey === 'rushDueTodayNotInProduction') {
    return (settings.rushWatchers || [])
      .map(name => ({ name, phone: normalizePhoneNumber(settings.recipients?.[name]) }))
      .filter(r => r.phone);
  }

  return [];
}

async function sendSmsViaPulseProxy({ to, message, proxyBase }) {
  const res = await fetch(`${proxyBase || 'http://127.0.0.1:8879'}/proxy/twilio/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `SMS send failed (${res.status})`);
  return data;
}

async function triggerOrderSmsAlert(eventKey, order, messageBuilder) {
  const settings = await getNotificationSettings();
  if (!settings.enabled) return { ok: false, skipped: 'disabled' };
  if (!settings.events?.[eventKey]) return { ok: false, skipped: 'event-disabled' };
  const recipients = resolveNotificationRecipients(eventKey, order, settings);
  if (!recipients.length) return { ok: false, skipped: 'no-recipient' };

  const dedupeKey = `${eventKey}:${order?.orderId || order?.id}:${recipients.map(r => r.phone).join(',')}`;
  const cooldown = settings.cooldownMinutes?.[eventKey] ?? 60;
  if (await hasRecentNotification(dedupeKey, cooldown)) return { ok: false, skipped: 'cooldown' };

  const message = typeof messageBuilder === 'function' ? messageBuilder(order, settings) : String(messageBuilder || '').trim();
  if (!message) return { ok: false, skipped: 'empty-message' };

  for (const recipient of recipients) {
    await sendSmsViaPulseProxy({ to: recipient.phone, message, proxyBase: settings.proxyBase });
  }
  await Promise.resolve(rememberNotification(dedupeKey));
  return { ok: true, count: recipients.length };
}

// ── Personnel CRUD ─────────────────────────────────────────

function addPersonnel(person) {
  return _pulseDelegateStorage('addPersonnel', (p) => {
    p.createdAt = new Date().toISOString();
    p.active = p.active !== false;
    return _add('personnel', p);
  }, [person]);
}
function getAllPersonnel() {
  return _pulseDelegateStorage('getAllPersonnel', () => _getAll('personnel'), []);
}
function updatePersonnel(id, changes) {
  return _pulseDelegateStorage('updatePersonnel', (i, c) => _update('personnel', i, c), [id, changes]);
}
function deletePersonnel(id) {
  return _pulseDelegateStorage('deletePersonnel', (i) => _delete('personnel', i), [id]);
}

/** Prefer the richest personnel row when the same display name exists twice. */
function _personnelRowScore(p) {
  let s = 0;
  if (p && p.active !== false) s += 8;
  if (String(p?.userId || '').trim()) s += 4;
  if (String(p?.facility || '').trim()) s += 2;
  if (String(p?.role || '').trim()) s += 1;
  return s;
}

/** One login option per name (in-memory). */
function dedupePeopleByName(list) {
  const byName = new Map();
  for (const p of list || []) {
    const name = String(p?.name || '').trim();
    if (!name) continue;
    const row = {
      id: p.id,
      name,
      role: p.role || 'operator',
      userId: p.userId != null ? String(p.userId) : '',
    };
    const prev = byName.get(name);
    if (!prev || _personnelRowScore(row) > _personnelRowScore(prev)) byName.set(name, row);
  }
  return [...byName.values()];
}

/** Remove duplicate Personnel DB rows that share the same name (keeps best row). */
async function dedupePersonnelByName() {
  if (typeof getAllPersonnel !== 'function' || typeof deletePersonnel !== 'function') return 0;
  const all = await getAllPersonnel();
  const keepByName = new Map();
  for (const p of all) {
    const name = String(p?.name || '').trim();
    if (!name) continue;
    const prev = keepByName.get(name);
    if (!prev || _personnelRowScore(p) > _personnelRowScore(prev)) keepByName.set(name, p);
  }
  let removed = 0;
  for (const p of all) {
    const name = String(p?.name || '').trim();
    if (!name) continue;
    const keep = keepByName.get(name);
    if (keep && p.id != null && p.id !== keep.id) {
      await deletePersonnel(p.id);
      removed++;
    }
  }
  return removed;
}

const PERSONNEL_AUTH_SEED_EXTRAS = [
  { name: 'Admin', role: 'admin', notes: 'System admin' },
  { name: 'Hayk Zohrabyan', role: 'admin', notes: 'Admin' },
  { name: 'David Zargaryan', role: 'david-review', notes: 'David review access' },
  { name: 'QC Inspector', role: 'qc', notes: 'Dedicated QC login' },
  { name: 'Shipping', role: 'shipping', notes: 'Shipping' },
];

async function seedPersonnelFromProfiles() {
  const existing = await getAllPersonnel();
  if (existing.length > 0) return; // idempotent — only seed if empty
  for (const [name, profile] of Object.entries(OPERATOR_PROFILES)) {
    await addPersonnel({
      name,
      role: profile.role || 'operator',
      notes: profile.notes || '',
      facility: profile.facility || '',
      phone: profile.phone || '',
      active: true,
      userId: profile.userId != null ? String(profile.userId) : '',
    });
  }
  for (const extra of PERSONNEL_AUTH_SEED_EXTRAS) {
    if (OPERATOR_PROFILES[extra.name]) continue;
    await addPersonnel({
      name: extra.name,
      role: extra.role,
      notes: extra.notes || '',
      facility: '16th-street',
      phone: '',
      active: true,
      userId: '',
    });
  }
}
async function getPersonnelByName(name) {
  const people = await getAllPersonnel();
  return people.find(p => p.name === name) || null;
}
async function getOperatorProfile(name) {
  const dbPerson = await getPersonnelByName(name);
  if (!dbPerson) return null;
  return {
    ...dbPerson,
    name: dbPerson.name || name,
    machines: Array.isArray(dbPerson.machines) ? dbPerson.machines : [],
    facility: dbPerson.facility || '',
    role: dbPerson.role || 'operator',
  };
}

// ── Device CRUD ────────────────────────────────────────────

function addDevice(device) {
  device.createdAt = new Date().toISOString();
  device.status = device.status || 'active';
  return _add('devices', device);
}
function getAllDevices() { return _getAll('devices'); }
function updateDevice(id, changes) { return _update('devices', id, changes); }
function deleteDevice(id) { return _delete('devices', id); }

// ── Activity Log (disabled — order/Audit history removed) ──

function addActivity(_log) {
  return Promise.resolve(null);
}

function getActivityLog(_orderId) {
  return Promise.resolve([]);
}

function getAllActivity() {
  return Promise.resolve([]);
}

/**
 * Erase all Pulse-owned data in this browser: every IndexedDB store in BazaarPrintDB,
 * localStorage keys starting with pulse_ plus admin-next state, Supabase-js auth tokens (sb-*-auth-token),
 * and session keys pulse_session / op_operator. Sets pulse_seed_demo=0.
 * Does not modify your Supabase/Postgres rows — apply supabase/migrations/016_clear_orders_and_audit.sql for that.
 */
function wipeAllPulseBrowserData() {
  try {
    localStorage.setItem('pulse_seed_demo', '0');
  } catch (e) {}

  const lsDrop = [];
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (
      k.startsWith('pulse_') ||
      k === 'bazaar_admin_next_state_v4' ||
      (k.startsWith('sb-') && k.includes('auth-token'))
    ) {
      lsDrop.push(k);
    }
  }
  lsDrop.forEach(k => {
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  });

  ['pulse_session', 'op_operator'].forEach(k => {
    try {
      sessionStorage.removeItem(k);
    } catch (e) {}
  });

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onsuccess = () => {
      const db = req.result;
      const names = Array.from(db.objectStoreNames);
      if (names.length === 0) {
        db.close();
        resolve(true);
        return;
      }
      const tx = db.transaction(names, 'readwrite');
      names.forEach(n => tx.objectStore(n).clear());
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
    };
  });
}

/** @deprecated Use wipeAllPulseBrowserData — kept for backwards compatibility */
function clearLocalPulseOrdersAndHistory() {
  return wipeAllPulseBrowserData();
}

// ── Config (for admin variable overrides) ──────────────────

function getConfig(key) {
  return _pulseDelegateStorage('getConfig', (k) => _get('config', k), [key]);
}

function setConfig(key, value) {
  return _pulseDelegateStorage('setConfig', (k, v) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    const req = tx.objectStore('config').put({ key: k, value: v, updatedAt: new Date().toISOString() });
    req.onsuccess = () => { broadcastUpdate('config', k); resolve(); };
    req.onerror = () => reject(req.error);
  })), [key, value]);
}

// ── Full backup / restore (Admin → Export / Import tab) ───────────────────

const PULSE_BACKUP_SCHEMA_VERSION = 4;

/** Admin tabs in JSON `admin` block (migration export). */
const PULSE_MIGRATION_ADMIN_TABS = [
  'personnel', 'machines', 'dies', 'organisation', 'products', 'product-workflows', 'roles',
];
const PULSE_ADMIN_BACKUP_TABS = [...PULSE_MIGRATION_ADMIN_TABS];
const PULSE_ADMIN_BACKUP_EXCLUDED_TABS = [
  'purchase-orders', 'knowledge', 'qa-rules', 'settings',
];

/** Production IndexedDB stores in backup (no purchase_orders). */
const PULSE_BACKUP_STORES = [
  'orders', 'personnel', 'devices', 'activity_log', 'knowledge_base', 'reprints',
  'dies', 'invoices', 'operator_sessions', 'operator_points',
];

/** Config keys not part of migration JSON (Settings tab — still in app via getConfig). */
const PULSE_BACKUP_EXCLUDED_CONFIG_KEYS = new Set([
  'appDeptCapacity', 'defaultFacility', 'defaultQCInspector',
]);

/** Never backup/restore (sessions, auth). */
const PULSE_BACKUP_SKIP_LS_KEYS = new Set([
  'pulse_session',
  'pulse_portal_active_session',
  'pulse_portal_otp_codes',
  'pulse_qa_rules',
]);

/** Legacy quote/payment localStorage keys — skip on backup (module removed). */
function pulseBackupLocalStorageExcluded(key) {
  if (!key || !key.startsWith('pulse_')) return true;
  if (PULSE_BACKUP_SKIP_LS_KEYS.has(key)) return true;
  if (key.startsWith('pulse_payment_')) return true;
  if (key.startsWith('pulse_quote')) return true;
  if (key === 'pulse_quotes') return true;
  return false;
}

function getAllConfigEntries() {
  return _pulseDelegateStorage('getAllConfigEntries', () => _getAll('config'), []);
}

function collectPulseLocalStorageBackup() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (pulseBackupLocalStorageExcluded(k)) continue;
      out[k] = localStorage.getItem(k);
    }
  } catch (e) {
    console.warn('[PulseBackup] localStorage read:', e);
  }
  return out;
}

function loadPulseOrganisationBundleForBackup() {
  try {
    if (typeof window !== 'undefined' && window.PulseOrgJsonStore?.loadRaw) {
      return window.PulseOrgJsonStore.loadRaw();
    }
  } catch (_) {}
  try {
    const raw = localStorage.getItem('pulse_organisation_bundle_v1');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function isPulseBackupPayload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.indexedDB && typeof raw.indexedDB === 'object') return true;
  if (raw.admin && typeof raw.admin === 'object') return true;
  if (raw.schemaVersion >= 2) return true;
  if (Array.isArray(raw.orders) && !raw.indexedDB) return true;
  return false;
}

function normalizePulseBackupPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid backup file — expected a JSON object.');
  }
  if (raw.indexedDB && typeof raw.indexedDB === 'object') {
    return {
      schemaVersion: raw.schemaVersion || PULSE_BACKUP_SCHEMA_VERSION,
      exportedAt: raw.exportedAt || null,
      indexedDB: raw.indexedDB,
      config: Array.isArray(raw.config) ? raw.config : [],
      organisation: raw.organisation || null,
      localStorage: raw.localStorage && typeof raw.localStorage === 'object' ? raw.localStorage : {},
      catalog: raw.catalog || null,
      productWorkflows: raw.productWorkflows || null,
      admin: raw.admin || null,
    };
  }
  if (raw.admin && typeof raw.admin === 'object') {
    return {
      schemaVersion: raw.schemaVersion || PULSE_BACKUP_SCHEMA_VERSION,
      exportedAt: raw.exportedAt || null,
      indexedDB: raw.indexedDB && typeof raw.indexedDB === 'object' ? raw.indexedDB : {},
      config: Array.isArray(raw.config) ? raw.config : [],
      organisation: raw.admin.organisation ?? raw.organisation ?? null,
      localStorage: raw.localStorage && typeof raw.localStorage === 'object' ? raw.localStorage : {},
      catalog: raw.admin.products ?? raw.catalog ?? null,
      productWorkflows: raw.admin.productWorkflows ?? raw.productWorkflows ?? null,
      admin: raw.admin,
    };
  }
  return {
    schemaVersion: 1,
    exportedAt: raw.exportedAt || null,
    indexedDB: {
      orders: raw.orders || [],
      personnel: raw.personnel || [],
      dies: raw.dies || [],
      knowledge_base: raw.knowledge_base || raw.knowledge || [],
      reprints: raw.reprints || [],
      activity_log: raw.activity_log || raw.activity || [],
      devices: raw.devices || [],
      invoices: raw.invoices || [],
      operator_sessions: raw.operator_sessions || [],
      operator_points: raw.operator_points || [],
    },
    config: [],
    organisation: raw.organisation || null,
    localStorage: raw.localStorage || {},
    catalog: raw.catalog || null,
    productWorkflows: raw.productWorkflows || null,
  };
}

function _configValueFromEntries(config, key) {
  const row = config.find(c => c.key === key);
  return _configStoredValue(row);
}

async function _loadProductWorkflowsForBackup() {
  try {
    if (typeof getAllProductWorkflows === 'function') {
      return await getAllProductWorkflows();
    }
  } catch (e) {
    console.warn('[PulseBackup] getAllProductWorkflows:', e);
  }
  try {
    if (typeof getAllProductWorkflowsIndexedDB === 'function') {
      return await getAllProductWorkflowsIndexedDB();
    }
  } catch (_) {}
  return [];
}

async function _loadMachinesRegistryForBackup() {
  try {
    if (typeof getAllMachines === 'function') {
      return await getAllMachines();
    }
  } catch (e) {
    console.warn('[PulseBackup] getAllMachines:', e);
  }
  return [];
}

async function buildPulseAdminMigrationSection(indexedDB, config, catalog, productWorkflows, organisation) {
  const machineCapacity = _configValueFromEntries(config, 'machineCapacity') || {};
  const machinesRegistry = await _loadMachinesRegistryForBackup();
  let roles = _configValueFromEntries(config, 'customRoles');
  if (!Array.isArray(roles)) roles = [];

  return {
    personnel: Array.isArray(indexedDB.personnel) ? indexedDB.personnel : [],
    machines: {
      capacityOverrides: machineCapacity,
      registry: machinesRegistry,
    },
    dies: Array.isArray(indexedDB.dies) ? indexedDB.dies : [],
    organisation: organisation || null,
    products: catalog || {
      colorModes: [],
      materials: [],
      finishing: [],
      products: [],
    },
    productWorkflows: Array.isArray(productWorkflows) ? productWorkflows : [],
    roles,
  };
}

async function getPulseBackupSummary() {
  const indexedDB = {};
  for (const store of PULSE_BACKUP_STORES) {
    try {
      indexedDB[store] = (await _getAll(store)).length;
    } catch (_) {
      indexedDB[store] = 0;
    }
  }
  let configCount = 0;
  let catalogProducts = 0;
  let productWorkflows = 0;
  let machinesRegistry = 0;
  let roles = 0;
  try {
    const cfg = await getAllConfigEntries();
    configCount = cfg.filter(c => !PULSE_BACKUP_EXCLUDED_CONFIG_KEYS.has(c.key)).length;
    const prods = _configValueFromEntries(cfg, PULSE_CATALOG_KEYS.products);
    catalogProducts = Array.isArray(prods) ? prods.length : 0;
    productWorkflows = (await _loadProductWorkflowsForBackup()).length;
    machinesRegistry = (await _loadMachinesRegistryForBackup()).length;
    const r = _configValueFromEntries(cfg, 'customRoles');
    roles = Array.isArray(r) ? r.length : 0;
  } catch (_) {}
  const ls = collectPulseLocalStorageBackup();
  const org = loadPulseOrganisationBundleForBackup();
  return {
    indexedDB,
    configCount,
    localStorageKeys: Object.keys(ls).length,
    organisation: !!org,
    facilities: org?.facilities?.length || 0,
    personnel: indexedDB.personnel || 0,
    dies: indexedDB.dies || 0,
    catalogProducts,
    productWorkflows,
    machinesRegistry,
    roles,
  };
}

async function buildPulseFullBackup() {
  const indexedDB = {};
  for (const store of PULSE_BACKUP_STORES) {
    indexedDB[store] = await _getAll(store);
  }
  const configAll = await getAllConfigEntries();
  const config = configAll.filter(c => !PULSE_BACKUP_EXCLUDED_CONFIG_KEYS.has(c.key));
  const catalog = {
    colorModes: _configValueFromEntries(configAll, PULSE_CATALOG_KEYS.colorModes) || [],
    materials: _configValueFromEntries(configAll, PULSE_CATALOG_KEYS.materials) || [],
    finishing: _configValueFromEntries(configAll, PULSE_CATALOG_KEYS.finishing) || [],
    products: _configValueFromEntries(configAll, PULSE_CATALOG_KEYS.products) || [],
  };
  const productWorkflows = await _loadProductWorkflowsForBackup();
  const organisation = loadPulseOrganisationBundleForBackup();
  const admin = await buildPulseAdminMigrationSection(
    indexedDB, configAll, catalog, productWorkflows, organisation
  );
  const localStorage = collectPulseLocalStorageBackup();
  const summary = {
    orders: indexedDB.orders?.length || 0,
    personnel: admin.personnel?.length || 0,
    dies: admin.dies?.length || 0,
    reprints: indexedDB.reprints?.length || 0,
    activity: indexedDB.activity_log?.length || 0,
    devices: indexedDB.devices?.length || 0,
    invoices: indexedDB.invoices?.length || 0,
    catalogProducts: catalog.products?.length || 0,
    productWorkflows: productWorkflows.length,
    machinesRegistry: admin.machines?.registry?.length || 0,
    roles: admin.roles?.length || 0,
    organisationFacilities: organisation?.facilities?.length || 0,
    configEntries: config.length,
    localStorageKeys: Object.keys(localStorage).length,
  };
  return {
    schemaVersion: PULSE_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source: 'pulse-admin',
    migrationAdminTabs: [...PULSE_MIGRATION_ADMIN_TABS],
    adminIncludedTabs: [...PULSE_ADMIN_BACKUP_TABS],
    adminExcludedTabs: [...PULSE_ADMIN_BACKUP_EXCLUDED_TABS],
    admin,
    indexedDB,
    config,
    catalog,
    productWorkflows,
    organisation,
    localStorage,
    summary,
  };
}

function downloadPulseBackupFile(payload, filename) {
  const name = filename || `pulse-full-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function _bulkImportStore(storeName, rows, mode) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (mode === 'replace') {
      store.clear();
    }
    rows.forEach(row => {
      if (row != null && typeof row === 'object') store.put(row);
    });
    tx.oncomplete = () => resolve(rows.length);
    tx.onerror = () => reject(tx.error || new Error(`Import failed: ${storeName}`));
  });
}

async function importPulseFullBackup(rawPayload, options = {}) {
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const data = normalizePulseBackupPayload(rawPayload);
  const idb = data.indexedDB || {};

  if (mode === 'replace') {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const names = [...PULSE_BACKUP_STORES];
      if (db.objectStoreNames.contains('config')) names.push('config');
      const existing = names.filter(s => db.objectStoreNames.contains(s));
      if (!existing.length) { db.close(); resolve(); return; }
      const tx = db.transaction(existing, 'readwrite');
      existing.forEach(n => tx.objectStore(n).clear());
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error || new Error('Clear stores failed'));
    });
  }

  const adminBlock = data.admin && typeof data.admin === 'object' ? data.admin : null;
  if (adminBlock) {
    if (Array.isArray(adminBlock.personnel) && adminBlock.personnel.length) {
      idb.personnel = mode === 'merge' && idb.personnel?.length
        ? idb.personnel.concat(adminBlock.personnel)
        : adminBlock.personnel;
    }
    if (Array.isArray(adminBlock.dies) && adminBlock.dies.length) {
      idb.dies = mode === 'merge' && idb.dies?.length
        ? idb.dies.concat(adminBlock.dies)
        : adminBlock.dies;
    }
  }

  const counts = {};
  for (const store of PULSE_BACKUP_STORES) {
    const rows = idb[store];
    if (!Array.isArray(rows) || !rows.length) continue;
    counts[store] = await _bulkImportStore(store, rows, mode);
  }

  const configRows = Array.isArray(data.config) ? data.config : [];
  for (const entry of configRows) {
    if (!entry?.key || PULSE_BACKUP_EXCLUDED_CONFIG_KEYS.has(entry.key)) continue;
    const val = entry.value !== undefined ? entry.value : _configStoredValue(entry);
    await setConfig(entry.key, val);
  }

  const catalogToImport = adminBlock?.products ?? data.catalog;
  if (catalogToImport && typeof catalogToImport === 'object') {
    if (catalogToImport.colorModes?.length) await setConfig(PULSE_CATALOG_KEYS.colorModes, catalogToImport.colorModes);
    if (catalogToImport.materials?.length) await setConfig(PULSE_CATALOG_KEYS.materials, catalogToImport.materials);
    if (catalogToImport.finishing?.length) await setConfig(PULSE_CATALOG_KEYS.finishing, catalogToImport.finishing);
    if (catalogToImport.products?.length) await setConfig(PULSE_CATALOG_KEYS.products, catalogToImport.products);
  }

  const workflowsToImport = adminBlock?.productWorkflows?.length
    ? adminBlock.productWorkflows
    : (data.productWorkflows || []);
  if (Array.isArray(workflowsToImport) && workflowsToImport.length) {
    if (typeof upsertProductWorkflow === 'function') {
      for (const wf of workflowsToImport) {
        await upsertProductWorkflow(wf);
      }
      counts.product_workflows = workflowsToImport.length;
    } else {
      await setConfig(PULSE_PRODUCT_WORKFLOWS_CONFIG_KEY, workflowsToImport);
      counts.product_workflows = workflowsToImport.length;
    }
  }

  if (adminBlock?.machines?.capacityOverrides && typeof adminBlock.machines.capacityOverrides === 'object') {
    await setConfig('machineCapacity', adminBlock.machines.capacityOverrides);
    counts.machineCapacity = Object.keys(adminBlock.machines.capacityOverrides).length;
  }

  if (Array.isArray(adminBlock?.roles) && adminBlock.roles.length) {
    await setConfig('customRoles', adminBlock.roles);
    counts.customRoles = adminBlock.roles.length;
  }

  const orgBundle = adminBlock?.organisation ?? data.organisation;
  if (orgBundle && typeof orgBundle === 'object') {
    const useSupa = typeof window.usePulseSupabaseStorage === 'function' && window.usePulseSupabaseStorage();
    if (!useSupa) {
      const norm = typeof window !== 'undefined' && window.PulseOrgJsonStore?.normalizeBundle
        ? window.PulseOrgJsonStore.normalizeBundle(orgBundle)
        : orgBundle;
      localStorage.setItem('pulse_organisation_bundle_v1', JSON.stringify(norm));
    }
    if (typeof syncPulseMachineryFromOrganisation === 'function') {
      syncPulseMachineryFromOrganisation();
    }
  }

  if (data.localStorage && typeof data.localStorage === 'object') {
    for (const [k, v] of Object.entries(data.localStorage)) {
      if (pulseBackupLocalStorageExcluded(k)) continue;
      try {
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      } catch (e) {
        console.warn('[PulseBackup] skip ls key', k, e);
      }
    }
  }

  if (typeof _pulseAdminInitPromise !== 'undefined') _pulseAdminInitPromise = null;
  if (typeof _pulseAdminCache !== 'undefined') _pulseAdminCache = null;

  return { mode, counts, configImported: configRows.length };
}

// ── Admin catalog + organisation machinery (shared by job ticket, admin, PM) ─

const PULSE_CATALOG_KEYS = {
  colorModes: 'catalogColorModes',
  materials: 'catalogMaterials',
  finishing: 'catalogFinishing',
  products: 'productCatalog',
  containers: 'catalogAppContainers',
};

function pulseCatalogUID() {
  return Math.random().toString(36).slice(2, 10);
}

function buildPulseDefaultColorModes() {
  return [
    { id: pulseCatalogUID(), name: 'CMYK', description: 'Standard 4-color process' },
    { id: pulseCatalogUID(), name: 'CMYK + White', description: 'CMYK with white underbase' },
  ];
}

function buildPulseDefaultMaterials() {
  return (typeof MATERIALS !== 'undefined' ? MATERIALS : []).map(g => ({
    id: pulseCatalogUID(), category: g.category, items: [...(g.items || [])],
  }));
}

/** Versions for a catalog finishing entry (migrates legacy comma-separated description). */
function getCatalogFinishingVersions(entry) {
  if (!entry) return [];
  if (typeof entry === 'string') return [];
  if (Array.isArray(entry.versions) && entry.versions.length) {
    return entry.versions.map(v => String(v).trim()).filter(Boolean);
  }
  if (entry.description) {
    return String(entry.description).split(/[,;]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function buildPulseDefaultFinishing() {
  return [
    { id: pulseCatalogUID(), name: 'Lamination', versions: ['Gloss', 'Matte', 'Soft Touch', 'Holo', 'Coating'] },
    { id: pulseCatalogUID(), name: 'Spot UV', versions: [] },
    { id: pulseCatalogUID(), name: 'Foil', versions: ['Gold', 'Silver', 'Rose Gold', 'Holographic', 'Custom'] },
    { id: pulseCatalogUID(), name: 'Scodix', versions: [] },
    { id: pulseCatalogUID(), name: 'Embossing', versions: [] },
    { id: pulseCatalogUID(), name: 'Perforation', versions: [] },
  ];
}

function buildPulseDefaultProductCatalog() {
  const u = pulseCatalogUID;
  return [
    { id: u(), name: 'Labels (Roll)', facilities: ['16th-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['Clear BOPP','White BOPP','Silver BOPP','Holo BOPP','Gloss Label Sheet','Matte Label Sheet','Semi Gloss'], finishing: ['Lamination','Spot UV','Foil','Scodix'], sides: ['1-sided'], rollDirection: true, notes: 'Roll labels — HP Indigo 6K → GM Die/Laser Cutter. NOT Cosmetic Web.' },
    { id: u(), name: 'Labels (Sheet)', facilities: ['16th-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['Gloss Label Sheet','Matte Label Sheet','Semi Gloss'], finishing: ['Lamination','Spot UV','Foil'], sides: ['1-sided'], rollDirection: false, notes: 'Sheet labels — HP Indigo 6K → Duplo or Guillotine.' },
    { id: u(), name: 'Pouches', facilities: ['16th-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['Clear Cosmetic Web','White Cosmetic Web','Silver Cosmetic Web'], finishing: ['Lamination'], sides: ['1-sided'], rollDirection: true, notes: 'Pouches — ONLY Cosmetic Web. HP Indigo 6K → GM Die/Laser → Karlville Poucher.' },
    { id: u(), name: 'Folding Cartons / Boxes', facilities: ['16th-street','boyd-street'], colorModes: ['CMYK'], materials: ['14pt C1S','14pt C2S','16pt C1S','16pt C2S','18pt C1S','18pt C2S','18pt Silver','24pt C1S','24pt C2S'], finishing: ['Lamination','Spot UV','Foil','Scodix','Embossing'], sides: ['2-sided'], rollDirection: false, notes: 'Boxes — HP Indigo 15K → Lamination → GM Die/Laser Cutter → Moll Brothers Folder-Gluer.' },
    { id: u(), name: 'Business Cards', facilities: ['16th-street'], colorModes: ['CMYK'], materials: ['14pt C1S','14pt C2S','16pt C1S','16pt C2S','18pt C1S','18pt C2S','80lb Cover','100lb Cover','110lb Cover'], finishing: ['Lamination','Spot UV','Foil','Scodix'], sides: ['1-sided','2-sided'], rollDirection: false, notes: 'Business Cards — HP Indigo 15K → Lamination → Duplo or Guillotine.' },
    { id: u(), name: 'Flyers / Postcards', facilities: ['16th-street'], colorModes: ['CMYK'], materials: ['80lb Cover','100lb Cover','110lb Cover','80lb Text','100lb Text','14pt C1S','16pt C1S'], finishing: ['Lamination','Spot UV'], sides: ['1-sided','2-sided'], rollDirection: false, notes: 'Flat sheets — HP Indigo 15K → Lamination → Guillotine.' },
    { id: u(), name: 'Booklets', facilities: ['16th-street'], colorModes: ['CMYK'], materials: ['80lb Cover','100lb Cover','80lb Text','100lb Text'], finishing: ['Lamination'], sides: ['2-sided'], rollDirection: false, notes: 'Booklets — HP Indigo 15K → Lamination → Booklet Folder → Guillotine.' },
    { id: u(), name: 'Diecut Stickers', facilities: ['16th-street','boyd-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['Clear BOPP','White BOPP','Silver BOPP','Holo BOPP','Gloss Label Sheet','Matte Label Sheet'], finishing: ['Lamination','Spot UV'], sides: ['1-sided'], rollDirection: false, notes: 'Diecut stickers — sheet or roll.' },
    { id: u(), name: 'Vinyl Labels / 54\'\' Rolls', facilities: ['boyd-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['White Vinyl','White Vinyl - Aggressive Glue','Holographic Vinyl'], finishing: ['Lamination'], sides: ['1-sided'], rollDirection: true, notes: 'Boyd vinyl label roll workflow.' },
    { id: u(), name: 'Vinyl Signage', facilities: ['boyd-street'], colorModes: ['CMYK'], materials: ['White Vinyl','White Vinyl - Aggressive Glue','Holographic Vinyl'], finishing: ['Lamination'], sides: ['1-sided'], rollDirection: false, notes: 'Boyd vinyl signage.' },
    { id: u(), name: 'Banners / Large Format', facilities: ['boyd-street'], colorModes: ['CMYK'], materials: ['Banner Material'], finishing: [], sides: ['1-sided'], rollDirection: false, notes: 'Large format banners.' },
    { id: u(), name: 'Window Decals', facilities: ['boyd-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['Window Decal'], finishing: [], sides: ['1-sided'], rollDirection: false, notes: 'Window decals.' },
    { id: u(), name: 'Wallpaper', facilities: ['boyd-street'], colorModes: ['CMYK'], materials: ['Self-Adhesive (Peel-and-Stick)','Traditional / Unpasted'], finishing: [], sides: ['1-sided'], rollDirection: false, notes: 'Wallpaper.' },
    { id: u(), name: 'Sheet Products (Boyd)', facilities: ['boyd-street'], colorModes: ['CMYK'], materials: ['18pt (Boyd)','20pt (Boyd)','24pt (Boyd)'], finishing: ['Lamination','Spot UV'], sides: ['1-sided','2-sided'], rollDirection: false, notes: 'Boyd sheet products.' },
    { id: u(), name: 'Other', facilities: ['16th-street','boyd-street'], colorModes: ['CMYK', 'CMYK + White'], materials: ['Clear BOPP','White BOPP','Silver BOPP','Holo BOPP','Clear Cosmetic Web','White Cosmetic Web','Silver Cosmetic Web','Gloss Label Sheet','Matte Label Sheet','Semi Gloss','14pt C1S','14pt C2S','16pt C1S','16pt C2S','18pt C1S','18pt C2S','24pt C1S','80lb Cover','100lb Cover','110lb Cover','80lb Text','100lb Text','White Vinyl','Banner Material','Window Decal','Vinyl'], finishing: ['Lamination','Spot UV','Foil','Scodix','Embossing','Perforation'], sides: ['1-sided','2-sided'], rollDirection: false, notes: '' },
  ];
}

function _catalogSectionEmpty(arr, isValidItem) {
  if (!Array.isArray(arr) || arr.length === 0) return true;
  if (typeof isValidItem === 'function') return !arr.some(isValidItem);
  return false;
}

/**
 * Restore Admin → Product Catalogue when missing or wiped (empty [] in IndexedDB).
 * Same keys as admin.html. Pass { force: true } to overwrite all sections with built-in defaults.
 */
async function repairPulseAdminCatalog(opts = {}) {
  const force = !!opts.force;
  const repaired = { colorModes: false, materials: false, finishing: false, products: false };

  try {
    if (!pulseUsesSupabaseStorage()) await openDB();
  } catch (_) {}

  let colorModes = _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.colorModes));
  let materials = _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.materials));
  let finishing = _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.finishing));
  let products = _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.products));

  if (force || _catalogSectionEmpty(colorModes, cm => String(cm?.name || '').trim())) {
    colorModes = buildPulseDefaultColorModes();
    await setConfig(PULSE_CATALOG_KEYS.colorModes, colorModes);
    repaired.colorModes = true;
  }
  if (force || _catalogSectionEmpty(materials, m => String(m?.category || '').trim() && Array.isArray(m.items) && m.items.length)) {
    materials = buildPulseDefaultMaterials();
    await setConfig(PULSE_CATALOG_KEYS.materials, materials);
    repaired.materials = true;
  }
  if (force || _catalogSectionEmpty(finishing, f => String(f?.name || '').trim())) {
    finishing = buildPulseDefaultFinishing();
    await setConfig(PULSE_CATALOG_KEYS.finishing, finishing);
    repaired.finishing = true;
  }
  if (force || _catalogSectionEmpty(products, p => String(p?.name || '').trim())) {
    products = buildPulseDefaultProductCatalog();
    await setConfig(PULSE_CATALOG_KEYS.products, products);
    repaired.products = true;
  }

  if (products.length && typeof seedProductWorkflowsFromDefaults === 'function') {
    try { await seedProductWorkflowsFromDefaults(products); } catch (_) {}
  }

  return { colorModes, materials, finishing, products, repaired };
}

/** True when any catalogue section is missing or empty. */
function pulseCatalogNeedsRecovery(catalog) {
  const c = catalog || {};
  return (
    _catalogSectionEmpty(c.colorModes, cm => String(cm?.name || '').trim()) ||
    _catalogSectionEmpty(c.materials, m => String(m?.category || '').trim()) ||
    _catalogSectionEmpty(c.finishing, f => String(f?.name || '').trim()) ||
    _catalogSectionEmpty(c.products, p => String(p?.name || '').trim())
  );
}

/** Force full catalogue restore (Admin → Products defaults). */
async function recoverPulseAdminCatalog() {
  return repairPulseAdminCatalog({ force: true });
}

/** @deprecated alias — use repairPulseAdminCatalog */
async function ensurePulseAdminCatalog() {
  return repairPulseAdminCatalog();
}

function _useSupabaseOrganisation() {
  if (typeof window === 'undefined') return false;
  if (window.PULSE_ORG_STORAGE === 'local-json') return false;
  if (window.PULSE_ORG_STORAGE === 'supabase') return true;
  if (window.PULSE_STORAGE_BACKEND !== 'supabase') return false;
  const url = window.PULSE_SUPABASE_URL || '';
  const key = window.PULSE_SUPABASE_ANON_KEY || '';
  if (/YOUR-PROJECT-REF/i.test(url) || /YOUR-ANON-KEY/i.test(key)) return false;
  return !!(url && key);
}

let _pulseOrgBundleCache = null;
let _pulseOrgBundlePromise = null;

/** Load organisation facilities + hardware from Supabase (preferred) or local JSON fallback. */
async function loadOrganisationBundleForApp(opts = {}) {
  if (opts.force) _pulseOrgBundleCache = null;
  if (_pulseOrgBundleCache && !opts.force) return _pulseOrgBundleCache;
  if (_pulseOrgBundlePromise && !opts.force) return _pulseOrgBundlePromise;

  _pulseOrgBundlePromise = (async () => {
    if (_useSupabaseOrganisation() && typeof window.fetchOrganisationBundleFromSupabase === 'function') {
      try {
        const bundle = await window.fetchOrganisationBundleFromSupabase();
        if (bundle?.facilities?.length) {
          _pulseOrgBundleCache = bundle;
          return bundle;
        }
      } catch (e) {
        console.warn('[Pulse] loadOrganisationBundleForApp Supabase:', e);
      }
    }
    if (typeof window !== 'undefined' && window.PulseOrgJsonStore) {
      try {
        const bundle = PulseOrgJsonStore.loadRaw();
        _pulseOrgBundleCache = bundle;
        return bundle;
      } catch (_) {}
    }
    return null;
  })();

  try {
    return await _pulseOrgBundlePromise;
  } finally {
    _pulseOrgBundlePromise = null;
  }
}

/** Facilities from Organisation tab (Supabase preferred; local JSON fallback). Optional CONST fallback for legacy only. */
async function getPulseOrganisationFacilities(opts = {}) {
  if (_useSupabaseOrganisation() && typeof getSupabaseClient === 'function') {
    try {
      const client = getSupabaseClient();
      if (client) {
        const { data } = await client
          .from('organisation_facilities')
          .select('slug, name, sort_order')
          .order('sort_order', { ascending: true });
        if (data?.length) {
          return data.filter(f => f.slug && f.name).map(f => ({ slug: f.slug, name: f.name }));
        }
      }
    } catch (_) {}
  }
  if (typeof window !== 'undefined' && window.PulseOrgJsonStore) {
    try {
      const bundle = _pulseOrgBundleCache || PulseOrgJsonStore.loadRaw();
      if (bundle?.facilities?.length) {
        return bundle.facilities
          .filter(f => f.slug && f.name)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map(f => ({ slug: f.slug, name: f.name }));
      }
    } catch (_) {}
  }
  if (!opts.noConstFallback && typeof FACILITIES !== 'undefined') {
    return Object.entries(FACILITIES).map(([slug, info]) => ({ slug, name: info.name }));
  }
  return [];
}

/** In-memory facility labels (Organisation is source of truth for display names). */
let _pulseFacilityBySlug = new Map();

async function refreshPulseFacilityCache() {
  const list = await getPulseOrganisationFacilities({ noConstFallback: false });
  _pulseFacilityBySlug = new Map(list.map(f => [f.slug, f.name]));
  return list;
}

function pulseNotifyReferenceDataChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('pulse:reference-data-changed', { detail }));
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'pulse:reference-data-changed', ...detail }, '*');
    } catch (_) {}
  }
}

const PULSE_ORDER_RENAME_FIELDS = {
  productType: 'product_type',
  material: 'material',
  colorMode: 'color_mode',
  colors: 'color_mode',
  lamination: 'lamination',
  foilType: 'foil_type',
  finishingNotes: 'finishing',
};

function _renameStringInArray(arr, oldVal, newVal) {
  if (!oldVal || !newVal || oldVal === newVal || !Array.isArray(arr)) return arr;
  let changed = false;
  const out = arr.map(v => {
    if (v === oldVal) { changed = true; return newVal; }
    return v;
  });
  return changed ? out : arr;
}

function _renameInCatalogProducts(products, field, oldVal, newVal) {
  if (!oldVal || !newVal || oldVal === newVal || !Array.isArray(products)) return { products, changed: 0 };
  let changed = 0;
  const next = products.map(p => {
    const arr = _renameStringInArray(p[field], oldVal, newVal);
    if (arr !== p[field]) { changed++; return { ...p, [field]: arr }; }
    return p;
  });
  return { products: next, changed };
}

async function _supabaseBulkRenameColumn(table, column, oldVal, newVal) {
  if (!oldVal || !newVal || oldVal === newVal) return 0;
  if (typeof getSupabaseClient !== 'function') return 0;
  const supa = getSupabaseClient();
  if (!supa) return 0;
  const { data, error } = await supa.from(table).update({ [column]: newVal }).eq(column, oldVal).select('id');
  if (error) throw error;
  return (data || []).length;
}

async function _cascadeOrdersFieldRename(orderField, oldVal, newVal) {
  if (!oldVal || !newVal || oldVal === newVal) return 0;
  const col = PULSE_ORDER_RENAME_FIELDS[orderField];
  if (!col) return 0;
  if (typeof window !== 'undefined' && window.PULSE_STORAGE_BACKEND === 'supabase') {
    return _supabaseBulkRenameColumn('orders', col, oldVal, newVal);
  }
  if (typeof getAllOrders !== 'function' || typeof updateOrder !== 'function') return 0;
  const orders = await getAllOrders();
  let n = 0;
  for (const o of orders) {
    const cur = o[orderField] ?? (orderField === 'colorMode' ? o.colors : undefined);
    if (cur !== oldVal) continue;
    const patch = { [orderField]: newVal };
    if (orderField === 'colorMode') patch.colors = newVal;
    await updateOrder(o.id || o._supaId || o.orderId, patch);
    n++;
  }
  return n;
}

async function pulseCascadeFacilitySlugRename(oldSlug, newSlug) {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return {};
  const report = { personnel: 0, orders: 0, settings: 0 };

  if (typeof getConfig === 'function' && typeof setConfig === 'function') {
    const personnel = _configStoredValue(await getConfig('personnel')) || [];
    if (Array.isArray(personnel) && personnel.some(p => p.facility === oldSlug)) {
      const next = personnel.map(p => p.facility === oldSlug ? { ...p, facility: newSlug } : p);
      await setConfig('personnel', next);
      report.personnel = next.filter(p => p.facility === newSlug).length;
    }
    const defFac = _configStoredValue(await getConfig('defaultFacility'));
    if (defFac === oldSlug) {
      await setConfig('defaultFacility', newSlug);
      report.settings = 1;
    }
  }

  if (typeof window !== 'undefined' && window.PULSE_STORAGE_BACKEND === 'supabase') {
    report.orders = await _supabaseBulkRenameColumn('orders', 'facility', oldSlug, newSlug);
  } else if (typeof getAllOrders === 'function' && typeof updateOrder === 'function') {
    const orders = await getAllOrders();
    for (const o of orders) {
      if (o.facility !== oldSlug) continue;
      await updateOrder(o.id || o._supaId || o.orderId, { facility: newSlug });
      report.orders++;
    }
  }

  await refreshPulseFacilityCache();
  if (typeof refreshPulseAdminData === 'function') await refreshPulseAdminData();
  pulseNotifyReferenceDataChanged({ scope: 'facility-slug', oldSlug, newSlug, report });
  return report;
}

async function pulseCascadeFacilityDisplayRefresh() {
  await refreshPulseFacilityCache();
  if (typeof refreshPulseAdminData === 'function') await refreshPulseAdminData();
  pulseNotifyReferenceDataChanged({ scope: 'facility-name' });
}

async function pulseCascadeProductWorkflowName(catalogId, oldName, newName) {
  if (!newName || (oldName === newName && !catalogId)) return 0;
  let n = 0;
  if (typeof window !== 'undefined' && window.PULSE_STORAGE_BACKEND === 'supabase' && typeof getSupabaseClient === 'function') {
    const supa = getSupabaseClient();
    if (supa && catalogId) {
      const { data, error } = await supa.from('product_workflows')
        .update({ product_name: newName })
        .eq('product_catalog_id', catalogId)
        .select('id');
      if (error) throw error;
      n += (data || []).length;
    }
    if (supa && oldName && oldName !== newName) {
      const { data, error } = await supa.from('product_workflows')
        .update({ product_name: newName })
        .eq('product_name', oldName)
        .select('id');
      if (error) throw error;
      n += (data || []).length;
    }
    return n;
  }
  if (typeof getAllProductWorkflows !== 'function' || typeof upsertProductWorkflow !== 'function') return 0;
  const all = await getAllProductWorkflows();
  for (const wf of all) {
    const matchId = catalogId && wf.productCatalogId === catalogId;
    const matchName = oldName && wf.productName === oldName;
    if (!matchId && !matchName) continue;
    await upsertProductWorkflow({ ...wf, productName: newName, productCatalogId: catalogId || wf.productCatalogId });
    n++;
  }
  return n;
}

async function pulseCascadeProductRename(catalogId, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return { orders: 0, workflows: 0 };
  const orders = await _cascadeOrdersFieldRename('productType', oldName, newName);
  const workflows = await pulseCascadeProductWorkflowName(catalogId, oldName, newName);
  pulseNotifyReferenceDataChanged({ scope: 'product', catalogId, oldName, newName, orders, workflows });
  return { orders, workflows };
}

async function pulseCascadeCatalogItemRename(kind, oldName, newName, opts = {}) {
  if (!oldName || !newName || oldName === newName) return { orders: 0, catalogProducts: 0 };
  const report = { orders: 0, catalogProducts: 0 };
  const productField = kind === 'colorMode' ? 'colorModes' : kind === 'finishing' ? 'finishing' : null;

  if (productField && typeof getConfig === 'function' && typeof setConfig === 'function') {
    const products = _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.products)) || [];
    const { products: next, changed } = _renameInCatalogProducts(products, productField, oldName, newName);
    if (changed) {
      await setConfig(PULSE_CATALOG_KEYS.products, next);
      report.catalogProducts = changed;
    }
  }

  const orderField = kind === 'colorMode' ? 'colorMode'
    : kind === 'material' ? 'material'
    : kind === 'finishing' ? 'finishingNotes'
    : null;
  if (orderField) report.orders = await _cascadeOrdersFieldRename(orderField, oldName, newName);

  if (kind === 'product' && opts.catalogId) {
    report.workflows = await pulseCascadeProductWorkflowName(opts.catalogId, oldName, newName);
  }

  pulseNotifyReferenceDataChanged({ scope: 'catalog', kind, oldName, newName, report });
  return report;
}

/** Rename machine display name in Admin capacity overrides (Organisation hardware rename). */
async function pulseCascadeMachineDisplayRename(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return 0;
  if (typeof getConfig !== 'function' || typeof setConfig !== 'function') return 0;
  const cap = _configStoredValue(await getConfig('machineCapacity')) || {};
  if (!cap[oldName]) return 0;
  const next = { ...cap };
  next[newName] = next[oldName];
  delete next[oldName];
  await setConfig('machineCapacity', next);
  if (typeof loadPulseMachineCapacityOverrides === 'function') await loadPulseMachineCapacityOverrides();
  pulseNotifyReferenceDataChanged({ scope: 'machine', oldName, newName });
  return 1;
}

function _detectSingleItemRename(oldItems, newItems) {
  const oldArr = oldItems || [];
  const newArr = newItems || [];
  const removed = oldArr.filter(i => !newArr.includes(i));
  const added = newArr.filter(i => !oldArr.includes(i));
  if (removed.length === 1 && added.length === 1) return { oldName: removed[0], newName: added[0] };
  return null;
}

let _pulseOrgMachines = null;
let _pulseOrgCapacityByMachine = {};
let _pulseMachineCapOverrides = {};

function _orgHardwareToCapacity(h) {
  const v = h.daily_capacity_value;
  if (v == null || v === '') return { notes: h.notes || '' };
  const unit = String(h.daily_capacity_unit || '').toLowerCase();
  const name = String(h.machine_name || '').toLowerCase();
  const ops = (h.operations || []).join(' ').toLowerCase();
  const isPouch = name.includes('poucher') || name.includes('karlville') || ops.includes('pouch');
  if (unit === 'sheets') return { dailySheets: v, notes: h.notes || '' };
  if (unit === 'units') return isPouch
    ? { dailyPouches: v, notes: h.notes || '' }
    : { dailyUnits: v, notes: h.notes || '' };
  if (unit === 'sq_ft') return { dailySqFt: v, notes: h.notes || '' };
  if (unit === 'none' || !unit) return { notes: h.notes || '' };
  return { dailySheets: v, notes: h.notes || '' };
}

/** Sync machine display names, operations, and capacity from Organisation → hardware. */
function syncPulseMachineryFromOrganisation(bundle) {
  const out = [];
  _pulseOrgCapacityByMachine = {};
  let b = bundle || _pulseOrgBundleCache;
  if (!b && typeof window !== 'undefined' && window.PulseOrgJsonStore) {
    try { b = PulseOrgJsonStore.loadRaw(); } catch (_) {}
  }
  if (!b) {
    _pulseOrgMachines = out;
    return out;
  }
  try {
    const bundle = b;
    const facById = new Map((bundle.facilities || []).map(f => [f.id, f]));
    const hwMap = bundle.hardwareByFacilityId || {};
    for (const [facId, rows] of Object.entries(hwMap)) {
      const fac = facById.get(facId);
      const facSlug = fac?.slug || '';
      const isBoyd = facSlug === 'boyd-street';
      for (const h of rows || []) {
        if (h.active === false || !h.machine_name) continue;
        const displayName = h.machine_name;
        const slug = typeof displayNameToMachineSlug === 'function'
          ? displayNameToMachineSlug(displayName)
          : null;
        if (slug && typeof MACHINE_SLUG_TO_DISPLAY !== 'undefined') {
          MACHINE_SLUG_TO_DISPLAY[slug] = displayName;
        }
        if (typeof MACHINES !== 'undefined') {
          MACHINES[displayName] = {
            ...(MACHINES[displayName] || {}),
            facility: isBoyd ? 'boyd-street' : (facSlug || '16th-street'),
            operations: Array.isArray(h.operations) && h.operations.length
              ? h.operations.slice()
              : (MACHINES[displayName]?.operations || ['Processing']),
          };
        }
        _pulseOrgCapacityByMachine[displayName] = _orgHardwareToCapacity(h);
        out.push({
          id: slug || displayName,
          name: displayName,
          displayName,
          facility: isBoyd ? 'boyd' : '16th',
          category: slug && typeof MACHINE_SLUG_CATEGORY !== 'undefined'
            ? (MACHINE_SLUG_CATEGORY[slug] || 'cutting')
            : 'cutting',
          capabilities: [],
        });
      }
    }
  } catch (e) {
    console.warn('[Pulse] syncPulseMachineryFromOrganisation:', e);
  }
  _pulseOrgMachines = out;
  return out;
}

async function loadPulseMachineCapacityOverrides() {
  try {
    const capConfig = await getConfig('machineCapacity');
    const val = _configStoredValue(capConfig);
    _pulseMachineCapOverrides = (val && typeof val === 'object' && !Array.isArray(val)) ? val : {};
  } catch (_) {
    _pulseMachineCapOverrides = {};
  }
}

/** Admin Machines tab overrides + Organisation hardware + built-in MACHINE_CAPACITY. */
function getEffectiveMachineCapacity(machineName) {
  const base = (typeof MACHINE_CAPACITY !== 'undefined' && MACHINE_CAPACITY[machineName]) || {};
  const org = _pulseOrgCapacityByMachine[machineName] || {};
  const overRaw = _pulseMachineCapOverrides[machineName] || {};
  const merged = { ...base, ...org };
  if (overRaw && typeof overRaw === 'object') {
    for (const [k, v] of Object.entries(overRaw)) {
      if (v == null || v === '') continue;
      merged[k] = v;
    }
  }
  return merged;
}

// ── Production-page Admin bootstrap (read-only; no runtime CONST lists) ──

let _pulseAdminCache = null;
let _pulseAdminInitPromise = null;
const _pulseAdminConfigRefreshHandlers = [];

async function _loadPulseSettingsFromConfig() {
  const [appDept, defFac, defQc] = await Promise.all([
    getConfig('appDeptCapacity'),
    getConfig('defaultFacility'),
    getConfig('defaultQCInspector'),
  ]);
  const appVal = _configStoredValue(appDept) || {};
  let appDeptCapacity = appVal.dailyUnits != null ? appVal.dailyUnits : null;
  if (appDeptCapacity == null && appVal.people && appVal.unitsPerPerson) {
    appDeptCapacity = appVal.people * appVal.unitsPerPerson;
  }
  return {
    appDeptCapacity,
    appDeptCapacityRaw: appVal,
    defaultFacility: _configStoredValue(defFac) || '',
    defaultQCInspector: String(_configStoredValue(defQc) || '').trim(),
  };
}

/**
 * Load Admin config for production flow pages. Does not auto-seed catalogue (use Admin → Products).
 * @param {{ force?: boolean, seedCatalog?: boolean }} opts
 */
async function initPulseAdminData(opts = {}) {
  if (_pulseAdminInitPromise && !opts.force) return _pulseAdminInitPromise;
  _pulseAdminInitPromise = (async () => {
    if (!pulseUsesSupabaseStorage()) {
      try { await openDB(); } catch (_) {}
    }

    let catalog;
    if (opts.seedCatalog) {
      catalog = await repairPulseAdminCatalog();
    } else {
      catalog = {
        colorModes: _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.colorModes)) || [],
        materials: _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.materials)) || [],
        finishing: _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.finishing)) || [],
        products: _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.products)) || [],
        containers: _configStoredValue(await getConfig(PULSE_CATALOG_KEYS.containers)) || [],
        repaired: {},
      };
    }

    const orgBundle = await loadOrganisationBundleForApp();
    syncPulseMachineryFromOrganisation(orgBundle);
    await loadPulseMachineCapacityOverrides();
    await loadPulsePersonnelCache();
    const facilities = await refreshPulseFacilityCache();
    const settings = await _loadPulseSettingsFromConfig();
    let prepressPersonnel = [];
    try {
      const people = await getAllPersonnel();
      prepressPersonnel = (people || [])
        .filter(p => p && p.active !== false && _isPrepressPersonnelRole(p.role))
        .map(p => p.name)
        .filter(Boolean);
    } catch (_) {}

    _pulseAdminCache = {
      catalog,
      facilities,
      machines: typeof getPulseOrgMachines === 'function' ? getPulseOrgMachines() : [],
      settings,
      prepressPersonnel,
      loadedAt: Date.now(),
    };
    return _pulseAdminCache;
  })();
  try {
    return await _pulseAdminInitPromise;
  } catch (e) {
    _pulseAdminInitPromise = null;
    throw e;
  }
}

function getPulseAdminCache() {
  return _pulseAdminCache;
}

function getPulseFacilityList() {
  return _pulseAdminCache?.facilities ? [..._pulseAdminCache.facilities] : [];
}

function getPulseFacilityLabel(slug) {
  if (!slug) return '—';
  if (_pulseFacilityBySlug.has(slug)) return _pulseFacilityBySlug.get(slug);
  const found = getPulseFacilityList().find(f => f.slug === slug);
  if (found?.name) return found.name;
  if (typeof FACILITIES !== 'undefined' && FACILITIES[slug]?.name) return FACILITIES[slug].name;
  return String(slug);
}

/** Map Admin Personnel facility dropdown label → DB slug (16th-street | boyd-street). */
function pulseResolveFacilitySlug(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // Multi / both
  if (raw === 'both' || raw === 'Both Facilities' || raw === 'All Facilities') return 'both';
  // Already a valid slug
  if (raw === '16th-street' || raw === 'boyd-street') return raw;
  // Comma-separated multi → 'both' if multiple slugs
  if (raw.includes(',')) {
    const slugs = raw.split(',').map(s => pulseResolveFacilitySlug(s.trim())).filter(Boolean);
    if (slugs.length > 1) return 'both';
    return slugs[0] || null;
  }
  const fromList = getPulseFacilityList().find(f => f.name === raw || f.slug === raw);
  if (fromList?.slug) return fromList.slug;
  if (typeof FACILITIES !== 'undefined') {
    for (const [slug, info] of Object.entries(FACILITIES)) {
      if (info.name === raw) return slug;
    }
  }
  if (/16th|main production/i.test(raw)) return '16th-street';
  if (/boyd|large format|design/i.test(raw)) return 'boyd-street';
  return null;
}

function getPulseCatalogProducts() {
  return _pulseAdminCache?.catalog?.products ? [..._pulseAdminCache.catalog.products] : [];
}

function getPulseCatalogMaterials() {
  return _pulseAdminCache?.catalog?.materials ? [..._pulseAdminCache.catalog.materials] : [];
}

function getPulseCatalogColorModes() {
  return _pulseAdminCache?.catalog?.colorModes ? [..._pulseAdminCache.catalog.colorModes] : [];
}

function getPulseCatalogFinishing() {
  return _pulseAdminCache?.catalog?.finishing ? [..._pulseAdminCache.catalog.finishing] : [];
}

const PACKAGING_CONTAINERS_DEFAULT = [
  { id: 'none',         label: 'None',        rate: 0 },
  { id: 'bag',          label: 'Bag',          rate: 0.02 },
  { id: 'shrink-wrap',  label: 'Shrink Wrap',  rate: 0.015 },
  { id: 'box',          label: 'Box',          rate: 0.05 },
  { id: 'jar',          label: 'Jar',          rate: 0.10 },
  { id: 'tube',         label: 'Tube',         rate: 0.08 },
  { id: 'exit-bag',     label: 'Exit Bag',     rate: 0.03 },
  { id: 'tray',         label: 'Tray',         rate: 0.04 },
];

function getPulseCatalogContainers() {
  const cached = _pulseAdminCache?.catalog?.containers;
  if (Array.isArray(cached) && cached.length > 0) return [...cached];
  return [...PACKAGING_CONTAINERS_DEFAULT];
}

function getPulseSettings() {
  return _pulseAdminCache?.settings ? { ..._pulseAdminCache.settings } : {
    appDeptCapacity: null,
    appDeptCapacityRaw: {},
    defaultFacility: '',
    defaultQCInspector: '',
  };
}

/** Display names from Organisation hardware (Admin source); no Object.keys(MACHINES) fallback. */
function getPulseMachineNames() {
  const names = new Set();
  for (const m of (_pulseAdminCache?.machines || [])) {
    const n = m.displayName || m.name;
    if (n) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Machine list for Report Issue — Organisation + Admin Machine Capacity overrides (same merge as admin Machines tab). */
async function getPulseReportIssueMachines() {
  if (typeof loadOrganisationBundleForApp === 'function') {
    await loadOrganisationBundleForApp();
  }
  if (typeof loadPulseMachineCapacityOverrides === 'function') {
    await loadPulseMachineCapacityOverrides();
  }
  if (typeof syncPulseMachineryFromOrganisation === 'function') {
    syncPulseMachineryFromOrganisation(_pulseOrgBundleCache);
  }
  const orgMachines = typeof getPulseOrgMachines === 'function' ? getPulseOrgMachines() : [];
  const capKeys = Object.keys(_pulseMachineCapOverrides || {});
  const byName = new Map();
  for (const m of orgMachines) {
    const name = m.displayName || m.name;
    if (name) byName.set(name, name);
  }
  capKeys.forEach(name => { if (name && !byName.has(name)) byName.set(name, name); });
  let names = [...byName.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (!names.length && typeof MACHINE_SLUG_TO_DISPLAY !== 'undefined') {
    names = Object.values(MACHINE_SLUG_TO_DISPLAY).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  return names;
}

const PULSE_PROBLEM_SOURCE_LABELS = {
  'operator-noticed': 'Operator noticed during run',
  'preventive-check': 'Preventive / scheduled check',
  'alarm-error': 'Alarm or error code on screen',
  'quality-defect': 'Quality defect traced to machine',
  'after-maintenance': 'After maintenance / restart',
  other: 'Other',
  legacy: 'Unknown (legacy)',
};

const PULSE_PROBLEM_CATEGORY_LABELS = {
  mechanical: 'Mechanical',
  software: 'Software / driver',
  consumables: 'Consumables / materials',
  electrical: 'Electrical',
  other: 'Other',
};

const PULSE_FIX_SOURCE_LABELS = {
  'in-house': 'Found and fixed in-house',
  'oem-support': 'Manufacturer / OEM support',
  'third-party': 'Third-party service technician',
  'internal-maintenance': 'Internal maintenance team',
  'past-issue': 'Documented fix from past issue',
  'trial-error': 'Trial and error / testing',
  other: 'Other',
};

function pulseIssueLabel(map, key, otherText) {
  if (!key) return '—';
  if (key === 'other' && otherText) return otherText;
  return map[key] || key;
}

function getPulseMachineOperations(displayName) {
  if (!displayName) return ['Processing'];
  const ops = typeof MACHINES !== 'undefined' && MACHINES[displayName]?.operations;
  if (Array.isArray(ops) && ops.length) return ops.slice();
  return ['Processing'];
}

function renderPulseAdminEmptyState(message, adminHint) {
  const hint = adminHint || 'Open Admin to configure these values.';
  const msg = message || 'No data configured yet.';
  return `<div class="pulse-admin-empty" style="padding:12px 14px;border:1px dashed var(--border,#cbd5e1);border-radius:8px;background:#f8fafc;font-size:13px;color:var(--text-muted,#64748b);">
    <strong style="display:block;color:var(--text,#334155);margin-bottom:4px;">${pulseEscapeHtml(msg)}</strong>
    ${pulseEscapeHtml(hint)}
  </div>`;
}

function registerPulseAdminConfigRefresh(handler) {
  if (typeof handler === 'function') _pulseAdminConfigRefreshHandlers.push(handler);
}

/** Wait until auth.js has finished (session or login modal). */
function waitForPulseAuthReady(maxMs = 20000) {
  if (typeof getSession === 'function' && getSession()) {
    return Promise.resolve(getSession());
  }
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('pulse:auth-ready', onReady);
      resolve(typeof getSession === 'function' ? getSession() : null);
    };
    const onReady = () => finish();
    window.addEventListener('pulse:auth-ready', onReady);
    setTimeout(finish, maxMs);
  });
}

/** Wait for Supabase JWT after login (no-op when using IndexedDB). */
async function waitForPulseSupabaseSession(maxMs = 15000) {
  if (window.PULSE_STORAGE_BACKEND !== 'supabase' || typeof window.supabaseGetSession !== 'function') {
    return null;
  }
  const step = 200;
  for (let t = 0; t < maxMs; t += step) {
    try {
      const s = await window.supabaseGetSession();
      if (s) return s;
    } catch (_) {}
    if (!document.getElementById('loginOverlay') && !document.getElementById('authLoader')) {
      return typeof getSession === 'function' ? getSession() : null;
    }
    await new Promise(r => setTimeout(r, step));
  }
  return null;
}

// ── Job ticket edit lock (status + supervisor unlock) ─────────

// Account manager may edit until prepress starts review; after that supervisor unlock is required.
const JT_EDITABLE_STATUSES = ['new', 'on-hold', 'pending-account-manager', 'prepress'];

const JT_LOCKED_STATUSES = [
  'prepress-active', 'prepress-paused', 'pending-review', 'pending-confirmation',
  'in-production', 'qc-checkout', 'qc-failed', 'ready-to-ship', 'waiting-pickup',
  'completed', 'shipped', 'received', 'delivery-ready',
];

const JT_SUPERVISOR_UNLOCK_ROLES = new Set([
  'admin', 'supervisor', 'david-review', 'production-manager', 'job_manager', 'ops_manager',
]);

function isJobTicketStatusLocked(status, _options) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return false;
  if (JT_EDITABLE_STATUSES.includes(s)) return false;
  if (JT_LOCKED_STATUSES.includes(s)) return true;
  return true;
}

function _jtUnlockStorageKey(orderId) {
  return `pulse_jt_unlock_${String(orderId || '').trim()}`;
}

function setJobTicketEditUnlock(orderId) {
  if (!orderId) return;
  try {
    sessionStorage.setItem(_jtUnlockStorageKey(orderId), String(Date.now()));
  } catch (_) {}
}

function clearJobTicketEditUnlock(orderId) {
  if (!orderId) return;
  try {
    sessionStorage.removeItem(_jtUnlockStorageKey(orderId));
  } catch (_) {}
}

function clearAllJobTicketEditUnlocks() {
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('pulse_jt_unlock_')) keys.push(k);
    }
    keys.forEach(k => sessionStorage.removeItem(k));
  } catch (_) {}
}

function hasJobTicketEditUnlock(orderId) {
  if (!orderId) return false;
  try {
    return !!sessionStorage.getItem(_jtUnlockStorageKey(orderId));
  } catch (_) {
    return false;
  }
}

function _normalizePersonnelRole(role) {
  return String(role || '').trim().toLowerCase().replace(/_/g, '-');
}

/** Validate supervisor/manager Personnel User ID for job-ticket unlock. */
async function verifyPulseSupervisorEditCode(code) {
  const entered = String(code || '').trim();
  if (!entered) return { ok: false, message: 'Enter a supervisor confirmation ID.' };

  let people = [];
  try {
    if (typeof getAllPersonnel === 'function') {
      people = await getAllPersonnel();
    }
  } catch (_) {}

  const match = (people || []).find(p => {
    if (p && p.active === false) return false;
    const uid = String(p.userId || '').trim();
    if (!uid || uid !== entered) return false;
    return JT_SUPERVISOR_UNLOCK_ROLES.has(_normalizePersonnelRole(p.role));
  });

  if (match) {
    return { ok: true, person: match };
  }

  if (typeof pulseUsesSupabaseStorage === 'function' && pulseUsesSupabaseStorage()) {
    return { ok: false, message: 'Invalid supervisor ID. Use a Personnel User ID for a supervisor or manager.' };
  }

  if (typeof OPERATOR_PROFILES !== 'undefined') {
    for (const [name, profile] of Object.entries(OPERATOR_PROFILES)) {
      const uid = String(profile.userId || '').trim();
      if (!uid || uid !== entered) continue;
      if (JT_SUPERVISOR_UNLOCK_ROLES.has(_normalizePersonnelRole(profile.role))) {
        return { ok: true, person: { name, ...profile } };
      }
    }
  }

  return { ok: false, message: 'Invalid supervisor ID. Use a Personnel User ID for a supervisor or manager.' };
}

async function refreshPulseAdminData() {
  _pulseAdminInitPromise = null;
  const cache = await initPulseAdminData({ force: true });
  for (const fn of _pulseAdminConfigRefreshHandlers) {
    try { await fn(cache); } catch (e) { console.warn('[Pulse] admin config refresh', e); }
  }
  return cache;
}

if (typeof window !== 'undefined') {
  window.PULSE_CATALOG_KEYS = PULSE_CATALOG_KEYS;
  window.PULSE_BACKUP_SCHEMA_VERSION = PULSE_BACKUP_SCHEMA_VERSION;
  window.PULSE_MIGRATION_ADMIN_TABS = PULSE_MIGRATION_ADMIN_TABS;
  window.PULSE_ADMIN_BACKUP_TABS = PULSE_ADMIN_BACKUP_TABS;
  window.PULSE_ADMIN_BACKUP_EXCLUDED_TABS = PULSE_ADMIN_BACKUP_EXCLUDED_TABS;
  window.getAllConfigEntries = getAllConfigEntries;
  window.getPulseBackupSummary = getPulseBackupSummary;
  window.buildPulseFullBackup = buildPulseFullBackup;
  window.downloadPulseBackupFile = downloadPulseBackupFile;
  window.importPulseFullBackup = importPulseFullBackup;
  window.isPulseBackupPayload = isPulseBackupPayload;
  window.normalizePulseBackupPayload = normalizePulseBackupPayload;
  window.buildPulseDefaultProductCatalog = buildPulseDefaultProductCatalog;
  window.repairPulseAdminCatalog = repairPulseAdminCatalog;
  window.recoverPulseAdminCatalog = recoverPulseAdminCatalog;
  window.pulseCatalogNeedsRecovery = pulseCatalogNeedsRecovery;
  window.ensurePulseAdminCatalog = ensurePulseAdminCatalog;
  window.getPulseOrganisationFacilities = getPulseOrganisationFacilities;
  window.refreshPulseFacilityCache = refreshPulseFacilityCache;
  window.pulseNotifyReferenceDataChanged = pulseNotifyReferenceDataChanged;
  window.pulseCascadeFacilityDisplayRefresh = pulseCascadeFacilityDisplayRefresh;
  window.pulseCascadeFacilitySlugRename = pulseCascadeFacilitySlugRename;
  window.pulseCascadeProductRename = pulseCascadeProductRename;
  window.pulseCascadeCatalogItemRename = pulseCascadeCatalogItemRename;
  window.pulseCascadeMachineDisplayRename = pulseCascadeMachineDisplayRename;
  window.pulseRenameInCatalogProducts = _renameInCatalogProducts;
  window.pulseDetectSingleItemRename = _detectSingleItemRename;
  window.loadOrganisationBundleForApp = loadOrganisationBundleForApp;
  window.syncPulseMachineryFromOrganisation = syncPulseMachineryFromOrganisation;
  window.loadPulseMachineCapacityOverrides = loadPulseMachineCapacityOverrides;
  window.getEffectiveMachineCapacity = getEffectiveMachineCapacity;
  window.getCatalogFinishingVersions = getCatalogFinishingVersions;
  window.initPulseAdminData = initPulseAdminData;
  window.getPulseAdminCache = getPulseAdminCache;
  window.getPulseFacilityList = getPulseFacilityList;
  window.getPulseFacilityLabel = getPulseFacilityLabel;
  window.pulseResolveFacilitySlug = pulseResolveFacilitySlug;
  window.getPulseCatalogProducts = getPulseCatalogProducts;
  window.getPulseCatalogMaterials = getPulseCatalogMaterials;
  window.getPulseCatalogColorModes = getPulseCatalogColorModes;
  window.getPulseCatalogFinishing = getPulseCatalogFinishing;
  window.getPulseSettings = getPulseSettings;
  window.getPulsePrepressWorkerLabel = getPulsePrepressWorkerLabel;
  window.getPulseMachineNames = getPulseMachineNames;
  window.getPulseReportIssueMachines = getPulseReportIssueMachines;
  window.PULSE_PROBLEM_SOURCE_LABELS = PULSE_PROBLEM_SOURCE_LABELS;
  window.PULSE_PROBLEM_CATEGORY_LABELS = PULSE_PROBLEM_CATEGORY_LABELS;
  window.PULSE_FIX_SOURCE_LABELS = PULSE_FIX_SOURCE_LABELS;
  window.pulseIssueLabel = pulseIssueLabel;
  window.getPulseMachineOperations = getPulseMachineOperations;
  window.renderPulseAdminEmptyState = renderPulseAdminEmptyState;
  window.registerPulseAdminConfigRefresh = registerPulseAdminConfigRefresh;
  window.refreshPulseAdminData = refreshPulseAdminData;
  window.waitForPulseAuthReady = waitForPulseAuthReady;
  window.waitForPulseSupabaseSession = waitForPulseSupabaseSession;
  window.JT_EDITABLE_STATUSES = JT_EDITABLE_STATUSES;
  window.JT_LOCKED_STATUSES = JT_LOCKED_STATUSES;
  window.isJobTicketStatusLocked = isJobTicketStatusLocked;
  window.setJobTicketEditUnlock = setJobTicketEditUnlock;
  window.clearJobTicketEditUnlock = clearJobTicketEditUnlock;
  window.clearAllJobTicketEditUnlocks = clearAllJobTicketEditUnlocks;
  window.hasJobTicketEditUnlock = hasJobTicketEditUnlock;
  window.verifyPulseSupervisorEditCode = verifyPulseSupervisorEditCode;
  window.getPulseOrgMachines = function () {
    if (!_pulseOrgMachines) syncPulseMachineryFromOrganisation();
    return _pulseOrgMachines || [];
  };
}

// Re-fire admin refresh when IndexedDB config changes (Admin saves)
if (typeof onDBUpdate === 'function') {
  onDBUpdate((data) => {
    if (data?.store === 'config' && typeof refreshPulseAdminData === 'function') {
      refreshPulseAdminData().catch(() => {});
    }
  });
}

// ── Product workflows (IndexedDB / local config fallback) ─
// Used when PULSE_STORAGE_BACKEND is not Supabase. supabase-client.js overrides these when active.

const PULSE_PRODUCT_WORKFLOWS_CONFIG_KEY = 'productWorkflows';

function _configStoredValue(record) {
  if (record == null) return null;
  if (Array.isArray(record)) return record;
  return record.value ?? record;
}

async function _readLocalProductWorkflows() {
  const rec = await getConfig(PULSE_PRODUCT_WORKFLOWS_CONFIG_KEY);
  const v = _configStoredValue(rec);
  return Array.isArray(v) ? v : [];
}

async function _writeLocalProductWorkflows(rows) {
  await setConfig(PULSE_PRODUCT_WORKFLOWS_CONFIG_KEY, rows);
}

function _normalizeLocalProductWorkflow(wf) {
  const now = new Date().toISOString();
  const steps = (wf.steps || []).map((s, i) => ({
    ...s,
    sortOrder: s.sortOrder ?? i + 1,
    operation: s.operation || _defaultOperationForMachineSlug(s.machineId),
    defaultOperation: s.defaultOperation
      || (s.defaultMachineId ? _defaultOperationForMachineSlug(s.defaultMachineId) : null),
    alternatives: normalizeWorkflowAlternatives(s.alternatives),
  }));
  return {
    id: wf.id || `pw_${wf.productCatalogId}`,
    productCatalogId: wf.productCatalogId,
    productName: wf.productName,
    primaryFacility: wf.primaryFacility || '16th',
    steps,
    createdAt: wf.createdAt || now,
    updatedAt: now,
  };
}

async function getAllProductWorkflowsIndexedDB() {
  return _readLocalProductWorkflows();
}

async function getProductWorkflowByCatalogIdIndexedDB(catalogId) {
  const all = await _readLocalProductWorkflows();
  return all.find(w => w.productCatalogId === catalogId) || null;
}

async function upsertProductWorkflowIndexedDB(wf) {
  const all = await _readLocalProductWorkflows();
  const saved = _normalizeLocalProductWorkflow(wf);
  const idx = all.findIndex(w => w.productCatalogId === saved.productCatalogId);
  if (idx >= 0) {
    saved.id = all[idx].id;
    saved.createdAt = all[idx].createdAt || saved.createdAt;
    all[idx] = saved;
  } else {
    all.push(saved);
  }
  await _writeLocalProductWorkflows(all);
  return saved;
}

async function deleteProductWorkflowIndexedDB(id) {
  const all = await _readLocalProductWorkflows();
  await _writeLocalProductWorkflows(all.filter(w => w.id !== id));
}

async function seedProductWorkflowsFromDefaultsIndexedDB(catProducts) {
  if (!Array.isArray(catProducts) || !catProducts.length) return { seeded: 0 };
  const existing = await _readLocalProductWorkflows();
  const byCatalog = new Set(existing.map(w => w.productCatalogId));
  const getDefault = typeof getDefaultProductWorkflowForCatalogName === 'function'
    ? getDefaultProductWorkflowForCatalogName
    : () => ({ primaryFacility: '16th', steps: [] });
  let seeded = 0;
  for (const prod of catProducts) {
    if (!prod?.id || byCatalog.has(prod.id)) continue;
    const def = getDefault(prod.name);
    await upsertProductWorkflowIndexedDB({
      productCatalogId: prod.id,
      productName: prod.name,
      primaryFacility: def.primaryFacility || '16th',
      steps: def.steps || [],
    });
    seeded++;
  }
  return { seeded };
}

async function resetAllProductWorkflowsFromDefaultsIndexedDB(catProducts) {
  if (!Array.isArray(catProducts) || !catProducts.length) return { updated: 0 };
  const getDefault = typeof getDefaultProductWorkflowForCatalogName === 'function'
    ? getDefaultProductWorkflowForCatalogName
    : () => ({ primaryFacility: '16th', steps: [] });
  const rows = [];
  for (const prod of catProducts) {
    if (!prod?.id || !prod.name) continue;
    const def = getDefault(prod.name);
    rows.push(_normalizeLocalProductWorkflow({
      productCatalogId: prod.id,
      productName: prod.name,
      primaryFacility: def.primaryFacility || '16th',
      steps: def.steps || [],
    }));
  }
  await _writeLocalProductWorkflows(rows);
  return { updated: rows.length };
}

async function getAllMachinesIndexedDB() {
  if (typeof syncPulseMachineryFromOrganisation === 'function') {
    syncPulseMachineryFromOrganisation();
  }
  const byId = new Map();
  const orgList = typeof getPulseOrgMachines === 'function' ? getPulseOrgMachines() : [];
  for (const m of orgList) {
    if (m?.id) byId.set(m.id, m);
  }
  if (typeof MACHINE_SLUG_TO_DISPLAY !== 'undefined') {
    for (const [id, displayName] of Object.entries(MACHINE_SLUG_TO_DISPLAY)) {
      if (byId.has(id)) {
        const cur = byId.get(id);
        if (!cur.category) byId.set(id, { ...cur, category: MACHINE_SLUG_CATEGORY?.[id] || cur.category });
        continue;
      }
      byId.set(id, {
        id,
        name: displayName,
        displayName,
        facility: ['canon-colorado', 'roland', 'graphtec-vinyl', 'graphtec-flatbed', 'boyd-laminator'].includes(id) ? 'boyd' : '16th',
        category: MACHINE_SLUG_CATEGORY?.[id] || (id.includes('press') ? 'press' : id.includes('laminat') ? 'lamination' : 'cutting'),
        capabilities: [],
      });
    }
  }
  return Array.from(byId.values());
}

if (typeof window !== 'undefined') {
  if (typeof window.getAllProductWorkflows !== 'function') {
    window.getAllProductWorkflows = getAllProductWorkflowsIndexedDB;
    window.getProductWorkflowByCatalogId = getProductWorkflowByCatalogIdIndexedDB;
    window.upsertProductWorkflow = upsertProductWorkflowIndexedDB;
    window.deleteProductWorkflow = deleteProductWorkflowIndexedDB;
    window.seedProductWorkflowsFromDefaults = seedProductWorkflowsFromDefaultsIndexedDB;
    window.resetAllProductWorkflowsFromDefaults = resetAllProductWorkflowsFromDefaultsIndexedDB;
  }
  if (typeof window.getAllMachines !== 'function') {
    window.getAllMachines = getAllMachinesIndexedDB;
  }
}

// ── Knowledge Base (Operator Alerts) ──────────────────────

function addKnowledgeEntry(entry) {
  return _pulseDelegateStorage('addKnowledgeEntry', (e) => _add('knowledge_base', { ...e, active: true, createdAt: new Date().toISOString() }), [entry]);
}

function getAllKnowledge() {
  return _pulseDelegateStorage('getAllKnowledge', () => _getAll('knowledge_base'), []);
}

function updateKnowledge(id, changes) {
  return _pulseDelegateStorage('updateKnowledge', (i, c) => _update('knowledge_base', i, c), [id, changes]);
}

// Match knowledge base entries to a specific step (machine + material + operation + order)
async function getAlertsForStep(machine, material, operation, operatorName = '', order = {}) {
  const all = await getAllKnowledge();
  return all.filter(entry => {
    if (!entry.active) return false;
    const operatorList = (Array.isArray(entry.operators)
      ? entry.operators
      : String(entry.operator || '')
          .split(',')
          .map(x => x.trim())
          .filter(Boolean)
    ).map(x => x.toLowerCase());
    const matchMachine = !entry.machine || entry.machine === machine || (Array.isArray(entry.machines) && entry.machines.includes(machine));
    const matchMaterial = !entry.material || String(material || '').toLowerCase().includes(String(entry.material).toLowerCase());

    // Improved operation matching: exact match OR keyword found in machine's operation list
    // OR alert is relevant based on order-level finish attributes (foil, UV)
    const machineOpsLower = (MACHINES[machine]?.operations || []).map(o => o.toLowerCase());
    const entryOpLower = (entry.operation || '').toLowerCase();
    const entryOpKeyword = entryOpLower.split(' ')[0]; // first word for keyword matching
    const orderHasFoil = !!(order.hasFoil || (order.foilType && order.foilType !== 'None'));
    const orderHasUV = !!order.hasUV;
    const alertMentionsFoil = entryOpLower.includes('foil') ||
      (entry.title || '').toLowerCase().includes('foil') ||
      (entry.description || '').toLowerCase().includes('foil');
    const alertMentionsUV = entryOpLower.includes('uv') ||
      (entry.title || '').toLowerCase().includes('uv') ||
      (entry.description || '').toLowerCase().includes('uv');
    const matchOperation = !entry.operation ||
      entry.operation === operation ||
      (entryOpKeyword && machineOpsLower.some(mo => mo.includes(entryOpKeyword))) ||
      (alertMentionsFoil && orderHasFoil) ||
      (alertMentionsUV && orderHasUV);

    const matchOperator = operatorList.length === 0 || operatorList.includes(String(operatorName || '').trim().toLowerCase());
    return matchMachine && matchMaterial && matchOperation && matchOperator;
  });
}

// Seed default knowledge base entries
async function seedKnowledge() {
  const existing = await getAllKnowledge();
  if (existing.length > 0) return;
  const defaults = [
    { machine: 'GM Die Cutter w/ JetFX', material: 'White BOPP', operation: 'Foil Stamping', title: 'JetFX Foil Process', description: 'When using JetFX for foil jobs: lay down foil on White BOPP first, then print on top leaving foil areas empty.', fix: 'Print foil layer first on BOPP, then overprint with ink leaving foil areas clear.', severity: 'warning', createdBy: 'System' },
    { machine: 'HP Indigo 6K', material: '', operation: 'Printing', title: 'Corona Treatment — Foil Jobs', description: 'When printing on foil material, you MUST turn off corona treatment on BOTH the GM and the HP Indigo 6K.', fix: 'Disable corona treatment on GM and 6K before running foil jobs. Re-enable after.', severity: 'critical', createdBy: 'System' },
    { machine: 'GM Die Cutter w/ JetFX', material: '', operation: 'Printing', title: 'Corona Treatment — GM', description: 'Corona treatment must be OFF when processing foil materials through the GM.', fix: 'Check corona setting before every foil run.', severity: 'critical', createdBy: 'System' },
    { machine: 'Graphtec Vinyl Cutter x4', material: '', operation: 'Vinyl Cutting', title: 'Perforation at Boyd — Manual Setup', description: 'Perforation on Graphtec requires manual knife position adjustment and special condition setup. NOT automatic like at 16th St.', fix: 'Check job ticket for perforation notes. Set knife condition manually before cutting.', severity: 'warning', createdBy: 'System' },
  ];
  for (const entry of defaults) {
    await addKnowledgeEntry(entry);
  }
}

// ── Reprints ──────────────────────────────────────────────

function addReprint(reprint) {
  return _add('reprints', { ...reprint, createdAt: new Date().toISOString() });
}

async function createReprintOrderFromSource(sourceOrder, meta = {}) {
  if (!sourceOrder) throw new Error('Source order is required');

  const quantity = parseInt(meta.quantity ?? meta.shortfall ?? sourceOrder.quantity) || 0;
  if (!quantity) throw new Error('Reprint quantity is required');

  const allOrders = await getAllOrders();
  const sourceFamily = getNormalizedOrderFamily(sourceOrder.orderId);
  const orderStem = sourceFamily.sub ? `${sourceFamily.base}_${sourceFamily.sub}` : `${sourceFamily.base}_1`;
  const isShortage = String(meta.reasonLabel || meta.reason || '').toLowerCase() === 'shortage';
  let orderId;
  if (isShortage) {
    orderId = `${orderStem}_RS`;
    if (allOrders.some(o => String(o.orderId) === orderId)) {
      let shortageNum = 2;
      while (allOrders.some(o => String(o.orderId) === `${orderStem}_RS${shortageNum}`)) shortageNum++;
      orderId = `${orderStem}_RS${shortageNum}`;
    }
  } else {
    let reprintNum = 1;
    while (allOrders.some(o => String(o.orderId) === `${orderStem}_R${reprintNum}`)) reprintNum++;
    orderId = `${orderStem}_R${reprintNum}`;
  }
  const workflowSteps = (sourceOrder.workflowSteps || []).map((step, idx) => ({
    ...step,
    id: generateStepId(),
    status: 'pending',
    assignedTo: null,
    startedAt: null,
    completedAt: null,
    startTime: null,
    endTime: null,
    pausedAt: null,
    pausedDuration: 0,
    unitsLost: 0,
    lossCount: 0,
    qtyCompleted: null,
    completedBy: null,
    stepIndex: idx,
    redirectedFrom: null,
    redirectNotes: null,
    isSplit: false,
    splitQuantity: null,
    splitFromStepId: null,
  }));

  const piecesPerSheet = parseInt(sourceOrder.piecesPerSheet) || 1;
  const sheetCount = sourceOrder.printType === 'Roll'
    ? (parseInt(sourceOrder.sheetCount) || 0)
    : Math.max(1, Math.ceil(quantity / Math.max(1, piecesPerSheet)));

  const reasonLabel = meta.reasonLabel || meta.reason || 'reprint';
  const noteBits = [
    sourceOrder.specialNotes || '',
    `REPRINT OF #${sourceOrder.orderId} — ${reasonLabel}${meta.notes ? ` — ${meta.notes}` : ''}`
  ].filter(Boolean);

  const newOrder = {
    ...sourceOrder,
    orderId,
    parentOrderId: null,
    quantity,
    sheetCount,
    workflowSteps,
    currentStep: 0,
    status: 'prepress',
    isReprint: true,
    reprintOfOrderId: sourceOrder.orderId,
    reprintReason: reasonLabel,
    reprintNotes: meta.notes || '',
    reprintRequestedBy: meta.requestedBy || meta.createdBy || 'Manager',
    reprintCreatedAt: new Date().toISOString(),
    holdReason: '',
    holdPreviousStatus: null,
    materialShortage: false,
    materialShortageDetails: null,
    needsConfirmation: false,
    confirmationReason: '',
    prepressStartedAt: null,
    prepressStartedBy: null,
    prepressPausedAt: null,
    prepressPausedBy: null,
    prepressResumedAt: null,
    prepressResumedBy: null,
    prepressCompletedAt: null,
    prepressCompletedBy: null,
    qcRecord: null,
    qcPassedAt: null,
    qcFailedAt: null,
    qcInspector: null,
    qcFailReasons: null,
    specialNotes: noteBits.join(' | '),
  };

  delete newOrder.id;
  await addOrder(newOrder);
  return newOrder;
}

function getReprintsForOrder(parentOrderId) {
  return _pulseDelegateStorage('getReprintsForOrder', (pid) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('reprints', 'readonly');
    const idx = tx.objectStore('reprints').index('parentOrderId');
    const req = idx.getAll(pid);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })), [parentOrderId]);
}

function getAllReprints() { return _getAll('reprints'); }
function updateReprint(id, changes) { return _update('reprints', id, changes); }

// ── Operator Sessions ─────────────────────────────────────

function clockIn(operatorName) {
  const now = new Date();
  return _add('operator_sessions', {
    operatorName,
    date: now.toISOString().split('T')[0],
    clockIn: now.toISOString(),
    clockOut: null,
    breaks: {
      rest1: { start: null, end: null },
      meal1: { start: null, end: null },
      rest2: { start: null, end: null },
      meal2: { start: null, end: null },
    },
    violationFlag: false,
    totalWorkMinutes: 0,
    notes: '',
    points: 0,
  });
}

function clockOut(sessionId) {
  return _get('operator_sessions', sessionId).then(session => {
    if (!session) return null;
    const now = new Date();
    const workMin = (now - new Date(session.clockIn)) / 60000;
    // Check for meal violation
    const meal1Taken = session.breaks?.meal1?.start;
    const meal2Taken = session.breaks?.meal2?.start;
    const violation = (!meal1Taken && workMin > 300) || (!meal2Taken && workMin > 600);
    return _update('operator_sessions', sessionId, {
      clockOut: now.toISOString(),
      totalWorkMinutes: Math.round(workMin),
      violationFlag: violation || session.violationFlag,
    });
  });
}

function startBreak(sessionId, breakType) {
  return _get('operator_sessions', sessionId).then(session => {
    if (!session) return null;
    const breaks = { ...session.breaks };
    breaks[breakType] = { ...breaks[breakType], start: new Date().toISOString() };
    return _update('operator_sessions', sessionId, { breaks });
  });
}

function endBreak(sessionId, breakType) {
  return _get('operator_sessions', sessionId).then(session => {
    if (!session) return null;
    const breaks = { ...session.breaks };
    breaks[breakType] = { ...breaks[breakType], end: new Date().toISOString() };
    return _update('operator_sessions', sessionId, { breaks });
  });
}

function getTodaySessions() {
  const today = new Date().toISOString().split('T')[0];
  return _getAll('operator_sessions').then(all => all.filter(s => s.date === today));
}

function getOperatorSession(operatorName) {
  const today = new Date().toISOString().split('T')[0];
  return _getAll('operator_sessions').then(all =>
    all.find(s => s.operatorName === operatorName && s.date === today && !s.clockOut)
  );
}

function getOperatorSessionById(sessionId) {
  return _get('operator_sessions', sessionId);
}

function updateOperatorSession(sessionId, changes) {
  return _update('operator_sessions', sessionId, changes);
}

function getAllOperatorPoints() {
  return _getAll('operator_points');
}

// ── Operator Points ───────────────────────────────────────

function addOperatorPoints(operatorName, points, reason) {
  return _add('operator_points', {
    operatorName,
    date: new Date().toISOString().split('T')[0],
    points,
    reason,
    timestamp: new Date().toISOString(),
  });
}

async function getOperatorMonthlyPoints(operatorName) {
  const all = await _getAll('operator_points');
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  return all
    .filter(p => p.operatorName === operatorName && p.date >= monthStart)
    .reduce((sum, p) => sum + (p.points || 0), 0);
}

// ── Die Registry ──────────────────────────────────────────

function addDie(die) {
  return _add('dies', {
    ...die,
    createdAt: new Date().toISOString(),
    status: die.status || 'active', // active, damaged, retired
    usageCount: 0,
    lastUsed: null,
  });
}

function getAllDies() {
  return _pulseDelegateStorage('getAllDies', () => _getAll('dies'), []);
}
function updateDie(id, changes) {
  return _pulseDelegateStorage('updateDie', (i, c) => _update('dies', i, c), [id, changes]);
}

function getDieByNumber(dieNumber) {
  return _pulseDelegateStorage('getDieByNumber', (n) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('dies', 'readonly');
    const idx = tx.objectStore('dies').index('dieNumber');
    const req = idx.get(n);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })), [dieNumber]);
}

function getDieByBarcode(barcode) {
  return _pulseDelegateStorage('getDieByBarcode', (code) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('dies', 'readonly');
    const idx = tx.objectStore('dies').index('barcode');
    const req = idx.get(code);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })), [barcode]);
}

// Record die usage (called when operator scans die before cutting)
async function recordDieUsage(dieId) {
  return _update('dies', dieId, {
    usageCount: ((await _get('dies', dieId))?.usageCount || 0) + 1,
    lastUsed: new Date().toISOString()
  });
}

// Generate barcode string for a die
function generateDieBarcode(dieNumber) {
  return `DIE-${dieNumber}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

// ── Purchase Orders ───────────────────────────────────────

async function generatePONumber() {
  const all = await _getAll('purchase_orders');
  const maxNum = all.reduce((max, po) => {
    const num = parseInt((po.poNumber || '').replace('PO-', '')) || 0;
    return Math.max(max, num);
  }, 1000);
  return `PO-${maxNum + 1}`;
}

function addPurchaseOrder(po) {
  return _add('purchase_orders', {
    ...po,
    createdAt: new Date().toISOString(),
    status: po.status || 'draft', // draft, sent, confirmed, shipped, received, cancelled
    items: po.items || [],
    expectedDelivery: po.expectedDelivery || null,
    actualDelivery: null,
    receivedBy: null,
    receivedAt: null,
  });
}

function getAllPurchaseOrders() { return _getAll('purchase_orders'); }
function updatePurchaseOrder(id, changes) { return _update('purchase_orders', id, changes); }

// Record PO receipt (operator scans PO barcode when material arrives)
async function receivePO(poId, receivedBy) {
  const po = await _get('purchase_orders', poId);
  if (!po) return null;
  return _update('purchase_orders', poId, {
    status: 'received',
    actualDelivery: new Date().toISOString(),
    receivedBy,
    receivedAt: new Date().toISOString(),
  });
}

// ── Invoice CRUD ────────────────────────────────────────────

function addInvoice(inv) {
  return _add('invoices', {
    ...inv,
    createdAt: inv.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: inv.status || 'draft',
    lineItems: inv.lineItems || [],
    discount: inv.discount || 0,
  });
}

function getInvoice(id) { return _get('invoices', id); }
function getAllInvoices() { return _getAll('invoices'); }
function updateInvoice(id, changes) { return _update('invoices', id, changes); }
function deleteInvoice(id) { return _delete('invoices', id); }

// ── Packaging Catalog CRUD (PUL-715) ────────────────────────
// Table: packaging_products  — Bags / Jars / Tubes catalog with tiered pricing

function addPackagingProduct(product) {
  product.active = product.active !== false;
  product.createdAt = new Date().toISOString();
  return _add('packaging_products', product);
}
function getAllPackagingProducts() { return _getAll('packaging_products'); }
function getPackagingProduct(id) { return _get('packaging_products', id); }
function updatePackagingProduct(id, changes) { return _update('packaging_products', id, changes); }
function deletePackagingProduct(id) { return _delete('packaging_products', id); }

/**
 * Returns active packaging products filtered by category (case-insensitive).
 * Category values: 'Bags', 'Jars', 'Tubes', '' = all categories
 */
async function getActivePackagingProducts(category = '') {
  const all = await getAllPackagingProducts();
  return all.filter(p => p.active !== false && (!category || p.category === category));
}

/**
 * Look up the tiered sale price for a SKU at a given quantity.
 * Tier breaks: 25, 50, 100, 250, 500, 1000, 5000
 * Returns sell_price (base) if no tier matches.
 */
function getPackagingTierPrice(product, qty) {
  const tiers = product.tier_pricing || {};
  const breaks = [
    [5000, tiers.qty_5000],
    [1000, tiers.qty_1000],
    [500,  tiers.qty_500],
    [250,  tiers.qty_250],
    [100,  tiers.qty_100],
    [50,   tiers.qty_50],
    [25,   tiers.qty_25],
  ];
  // Walk from highest qty down — first break where qty >= threshold wins
  for (const [threshold, price] of breaks) {
    if (qty >= threshold && price != null) return price;
  }
  return product.sell_price || 0;
}

/**
 * Seed the packaging catalog from the embedded JSON if the store is empty.
 * Idempotent — skips if packaging_products already has rows.
 * Data sourced from product-catalog-v2.json (68 SKUs, generated 2026-04-27).
 */
async function seedPackagingCatalogIfEmpty() {
  const existing = await getAllPackagingProducts();
  if (existing.length > 0) return;
  for (const p of PACKAGING_CATALOG_SEED) {
    await addPackagingProduct({ ...p });
  }
}

// ── End Packaging Catalog CRUD ───────────────────────────────

async function getInvoiceByOrderId(orderId) {
  const all = await getAllInvoices();
  return all.find(inv => inv.orderId === String(orderId)) || null;
}

async function generateInvoiceNumber(orderId) {
  return 'INV-' + String(orderId || '').split('_')[0];
}

// ── Helpers ────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Creation instant for queue filters — uses createdAt / created_at only (never due date). */
function getPulseOrderCreatedDate(o) {
  const raw = o?.createdAt ?? o?.created_at;
  if (raw == null || raw === '') return null;
  const d = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse YYYY-MM-DD from <input type="date"> as local midnight (avoids UTC off-by-one). */
function parsePulseLocalDateYmd(ymd) {
  if (!ymd || typeof ymd !== 'string') return null;
  const parts = ymd.split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * Sidebar "created" date filter for Prepress / Production queues.
 * dateFilter: 'all' | 'today' | 'yesterday' | 'last-week' | 'last-month' | 'custom'
 * Last week = previous ISO week Mon 00:00 — Sun 23:59:59. Last month = full previous calendar month.
 */
function pulseOrderMatchesCreatedDateFilter(o, dateFilter, customDateYmd) {
  if (!dateFilter || dateFilter === 'all') return true;
  const created = getPulseOrderCreatedDate(o);
  if (!created) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dowMon0 = (today.getDay() + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setDate(thisMonday.getDate() - dowMon0);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastSundayEnd = new Date(lastMonday);
  lastSundayEnd.setDate(lastSundayEnd.getDate() + 6);
  lastSundayEnd.setHours(23, 59, 59, 999);

  const monthStartCurr = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthStartPrev = new Date(today.getFullYear(), today.getMonth() - 1, 1);

  if (dateFilter === 'today') return created >= today && created < tomorrow;
  if (dateFilter === 'yesterday') return created >= yesterday && created < today;
  if (dateFilter === 'last-week') return created >= lastMonday && created <= lastSundayEnd;
  if (dateFilter === 'last-month') return created >= monthStartPrev && created < monthStartCurr;
  if (dateFilter === 'custom' && customDateYmd) {
    const cStart = parsePulseLocalDateYmd(customDateYmd);
    if (!cStart) return false;
    const cEnd = new Date(cStart);
    cEnd.setHours(23, 59, 59, 999);
    return created >= cStart && created <= cEnd;
  }
  return true;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function isThisWeek(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  return d >= weekStart;
}

function isThisMonth(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date();
}

function generateStepId() {
  return 'step_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// ── Shared CSS Variables ───────────────────────────────────

const THEME_CSS = `
  :root {
    --bg: #f4f6f9;
    --card: #ffffff;
    --card-hover: #f0f2f5;
    --border: #d8dee6;
    --text: #1a2233;
    --text-muted: #5f6b7a;
    --accent: #2563eb;
    --green: #16a34a;
    --red: #dc2626;
    --yellow: #d97706;
    --purple: #7c3aed;
    --radius: 8px;
    --shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); color: var(--text); cursor: pointer;
    font-size: 14px; font-weight: 500; transition: all 0.2s;
  }
  .btn:hover { background: var(--card-hover); border-color: var(--text-muted); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-success { background: var(--green); border-color: var(--green); color: #fff; }
  .btn-success:hover { background: #15803d; }
  .btn-danger { background: var(--red); border-color: var(--red); color: #fff; }
  .btn-danger:hover { background: #b91c1c; }
  .btn-warning { background: var(--yellow); border-color: var(--yellow); color: #fff; }
  .btn-warning:hover { background: #b45309; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  /* Inputs */
  input, select, textarea {
    background: #fff; border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text); padding: 8px 12px; font-size: 14px; width: 100%;
    font-family: inherit; transition: border-color 0.2s;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
  }
  select { cursor: pointer; }
  textarea { resize: vertical; min-height: 60px; }
  label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Cards */
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow);
  }

  /* Badges */
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 12px;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .badge-waiting-approval { background: #f1f5f9; color: #64748b; }
  .badge-new { background: #e0f2fe; color: #0369a1; }
  .badge-pending-confirmation { background: #fff7ed; color: #c2410c; }
  .badge-pending-review { background: #fef3c7; color: #b45309; }
  .badge-prepress { background: #dbeafe; color: #1d4ed8; }
  .badge-prepress-active { background: #d1fae5; color: #047857; }
  .badge-prepress-paused { background: #ffedd5; color: #c2410c; }
  .badge-step-paused { background: #fed7aa; color: #9a3412; }
  .badge-pending-account-manager { background: #fee2e2; color: #b91c1c; }
  .badge-in-production { background: #dcfce7; color: #15803d; }
  .badge-on-hold { background: #fce7f3; color: #be185d; }
  .badge-qc-checkout { background: #ede9fe; color: #6d28d9; }
  .badge-ready-to-ship { background: #ccfbf1; color: #0f766e; }
  .badge-shipped { background: #e2e8f0; color: #475569; }
  .badge-waiting-pickup { background: #fef9c3; color: #a16207; }
  .badge-delivery-ready { background: #cffafe; color: #0e7490; }
  .badge-received { background: #d1fae5; color: #065f46; }
  .badge-completed { background: #f3e8ff; color: #7c3aed; }
  .badge-qc-failed { background: #fee2e2; color: #dc2626; }
  .badge-reprint { background: #ffedd5; color: #ea580c; }
  .badge-order-pending { background: #f1f5f9; color: #475569; }
  .badge-order-priced { background: #dbeafe; color: #1e40af; }
  .badge-order-confirmed { background: #dcfce7; color: #166534; }

  /* Navigation */
  .top-nav {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 10px 24px; background: #fff; border-bottom: 2px solid #e5e7eb;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .top-nav h1 { font-size: 18px; font-weight: 700; color: var(--text); }
  .top-nav-leading {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
    flex-wrap: wrap;
    min-width: 0;
  }
  .top-nav-brand { flex-shrink: 0; display: flex; align-items: center; }
  .top-nav-pricing-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 700;
    text-decoration: none;
    white-space: nowrap;
    line-height: 1.2;
    border: 1px solid #86efac;
    background: linear-gradient(180deg, #ecfdf5 0%, #d1fae5 100%);
    color: #047857;
    box-shadow: 0 1px 2px rgba(15,23,42,0.06);
    letter-spacing: 0.01em;
  }
  .top-nav-pricing-btn:hover {
    background: linear-gradient(180deg, #d1fae5 0%, #a7f3d0 100%);
    border-color: #4ade80;
    color: #065f46;
  }
  .top-nav-pricing-btn.active {
    background: linear-gradient(180deg, #bbf7d0 0%, #86efac 100%);
    border-color: #22c55e;
    color: #14532d;
    box-shadow: 0 0 0 2px rgba(34,197,94,0.25);
  }
  .top-nav-logo-link {
    display: inline-flex; align-items: center; gap: 10px;
    text-decoration: none; color: inherit;
  }
  .top-nav-logo-link:hover { opacity: 0.92; }
  .top-nav-logo-img {
    height: 48px; width: auto; display: block;
  }
  .top-nav-version {
    display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px;
    background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8;
    font-size: 11px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap;
  }
  .top-nav .nav-links {
    display: flex; flex-wrap: wrap; gap: 8px 14px;
    align-items: center; flex: 1 1 auto; min-width: 0;
    max-width: 100%;
    justify-content: flex-end;
    overflow: visible;
  }
  .top-nav .nav-links a {
    font-size: 13px; color: var(--text-muted);
    padding: 6px 10px; border-radius: 6px;
    white-space: nowrap; line-height: 1.2;
    border: 1px solid transparent;
  }
  .top-nav .nav-links a:hover, .top-nav .nav-links a.active {
    color: var(--accent); background: #e0edff; text-decoration: none;
    border-color: #bfdbfe;
  }
  .nav-admin-submenu {
    position: relative;
    display: inline-flex;
    align-items: stretch;
  }
  .nav-admin-submenu .nav-dropdown-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    font-family: inherit;
    color: var(--text-muted);
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    white-space: nowrap;
    line-height: 1.2;
  }
  .nav-admin-submenu .nav-dropdown-toggle:hover,
  .nav-admin-submenu:focus-within .nav-dropdown-toggle {
    color: var(--accent);
    background: #e0edff;
    border-color: #bfdbfe;
  }
  .nav-admin-submenu .nav-dropdown-toggle.active {
    color: var(--accent);
    background: #e0edff;
    text-decoration: none;
    border-color: #bfdbfe;
  }
  .nav-admin-submenu .nav-dropdown-panel {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 200px;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15,23,42,0.12);
    z-index: 2000;
  }
  .nav-admin-submenu:hover .nav-dropdown-panel,
  .nav-admin-submenu:focus-within .nav-dropdown-panel {
    display: flex;
  }
  .nav-admin-submenu .nav-dropdown-panel .nav-link {
    display: flex;
    width: 100%;
    box-sizing: border-box;
    justify-content: flex-start;
  }
  .top-nav-user-slot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 auto;
  }
  .top-nav-user-slot:empty { display: none; }
  .top-nav-signout-btn {
    display: none;
    align-items: center;
    gap: 5px;
    margin-left: 8px;
    padding: 5px 12px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    color: #64748b;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }
  .top-nav-signout-btn:hover {
    background: #fee2e2;
    border-color: #fca5a5;
    color: #dc2626;
  }
  .top-nav .user-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 29px;
    padding: 0 10px;
    border: 1px solid #e2e8f0;
    border-radius: 999px;
    background: #fff;
    color: var(--text);
    font-size: 13px;
    line-height: 1;
    box-shadow: 0 1px 4px rgba(15,23,42,0.06);
    white-space: nowrap;
  }
  .top-nav .user-badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .top-nav .user-badge-name { font-weight: 600; }
  .top-nav .user-badge-role {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .top-nav .user-badge-logout { display: none; }
  @media (max-width: 1100px) {
    .top-nav .nav-links { width: 100%; justify-content: flex-start; }
  }

  /* Modal */
  .modal-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.3); z-index: 1000; align-items: center; justify-content: center;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: #fff; border: 1px solid var(--border); border-radius: var(--radius);
    padding: 24px; min-width: 400px; max-width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.15);
  }
  .modal h2 { margin-bottom: 16px; }
  .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }

  /* Animations */
  @keyframes flash-red {
    0%, 100% { background: rgba(248,81,73,0.15); }
    50% { background: rgba(248,81,73,0.4); }
  }
  .flash-red { animation: flash-red 1s infinite; }

  /* Table */
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .data-table th { background: #f8f9fb; padding: 8px 12px; text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px; border-bottom: 2px solid var(--border); position: sticky; top: 0; z-index: 1; }
  .data-table td { padding: 8px 12px; border-bottom: 1px solid #eef0f3; vertical-align: middle; }
  .data-table tr:hover td { background: #f8fafc; }
  .stat-item { text-align:center; padding:8px 14px; background:#fff; border:1px solid var(--border); border-radius:var(--radius); }
  .stat-value { font-size:22px; font-weight:700; }
  .stat-label { font-size:11px; color:var(--text-muted); margin-top:2px; }
  .qp-filter-btn { padding:4px 12px; border-radius:12px; border:1px solid #d1d5db; background:#fff; font-size:12px; cursor:pointer; }
  .qp-filter-btn.active { background:#2563eb; color:#fff; border-color:#2563eb; }
  .rt-container { max-width:1200px; margin:0 auto; padding:24px; }
  .rt-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }

  /* ── P4-C: Breadcrumb navigation ── */
  #breadcrumb:empty,
  #op-breadcrumb:empty { display: none; }
  .breadcrumb {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 20px; background: var(--bg); border-bottom: 1px solid var(--border);
    font-size: 12px; color: var(--text-muted);
  }
  .bc-link { color: var(--accent); text-decoration: none; }
  .bc-link:hover { text-decoration: underline; }
  .bc-sep { color: var(--border); margin: 0 2px; }
  .bc-current { color: var(--text); font-weight: 600; }

  /* ── P4-D: Global page toast ── */
  #page-toast-container {
    position: fixed; bottom: 24px; right: 24px; z-index: 9998;
    display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  }
  .page-toast {
    padding: 10px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15); max-width: 340px;
    animation: page-toast-in 0.3s ease; pointer-events: auto; cursor: pointer;
    border-left-width: 4px; border-left-style: solid;
  }
  @keyframes page-toast-in {
    from { transform: translateX(60px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* ── P1-A: Next-step required banner ── */
  .next-step-banner {
    display: flex; align-items: center; gap: 10px;
    background: #eff6ff; border: 2px solid #2563eb; border-radius: 10px;
    padding: 12px 16px; font-size: 14px; font-weight: 700; color: #1d4ed8;
    animation: ns-pulse 2s ease infinite;
  }
  @keyframes ns-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0.3); }
    50% { box-shadow: 0 0 0 6px rgba(37,99,235,0); }
  }
  .next-step-machine { font-size: 16px; font-weight: 900; }

  /* ── P2-D: Note type badge ── */
  .note-type-badge { display:inline-block; padding:1px 7px; border-radius:8px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px; }
  .note-type-badge.INFO { background:#e0edff; color:#1d4ed8; }
  .note-type-badge.CRITICAL { background:#fde8e8; color:#b91c1c; }
  .note-type-badge.INSTRUCTIONS { background:#fef3cd; color:#92600a; }

  /* ── SKU versions & artwork (production manager, operator, etc.) ── */
  .pulse-sku-section {
    margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border);
    width: 100%; box-sizing: border-box;
  }
  .pulse-sku-section-title {
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-muted); margin: 0 0 12px;
  }
  .pulse-sku-section-title span { font-weight: 500; text-transform: none; letter-spacing: 0; }
  .pulse-sku-columns {
    display: grid;
    gap: 12px;
    align-items: stretch;
    width: 100%;
    grid-template-columns: repeat(var(--pulse-sku-cols, 1), minmax(0, 1fr));
  }
  .pulse-sku-columns .pulse-sku-block {
    margin-bottom: 0;
    min-width: 0;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
  @media (max-width: 900px) {
    .pulse-sku-columns { grid-template-columns: 1fr !important; }
  }
  .pulse-sku-block {
    display: flex; flex-direction: column; align-items: stretch;
    border: 1px solid var(--border); border-radius: 10px; padding: 12px;
    margin-bottom: 10px; background: #f8fafc;
  }
  .pulse-sku-block:last-child { margin-bottom: 0; }
  .pulse-sku-name {
    font-size: 12px; font-weight: 700; color: var(--text);
    line-height: 1.35; margin-bottom: 8px; text-align: center;
    word-break: break-word;
  }
  .pulse-sku-qty {
    font-size: 26px; font-weight: 800; color: var(--accent); line-height: 1;
    text-align: center; margin: 4px 0 2px;
  }
  .pulse-sku-qty-unit {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
    color: var(--text-muted); text-align: center; margin-bottom: 10px;
    padding-bottom: 10px; border-bottom: 1px solid #e2e8f0;
  }
  .pulse-sku-hdr {
    display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
    margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0;
  }
  .pulse-sku-hdr strong { font-size: 13px; color: var(--text); }
  .pulse-sku-hdr span { font-size: 12px; color: var(--text-muted); font-weight: 600; }
  .pulse-sku-layers {
    display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 8px;
    font-weight: 600; text-align: center;
  }
  .pulse-sku-empty { font-size: 12px; color: var(--text-muted); text-align: center; }
  .pulse-sku-art { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .pulse-sku-art .pulse-art-grid { justify-content: center; width: 100%; }
  .pulse-art-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .pulse-art-thumb, .pulse-art-pdf {
    width: 72px; height: 72px; border-radius: 8px; border: 1px solid var(--border);
    overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fff;
  }
  .pulse-art-thumb img { width: 100%; height: 100%; object-fit: cover; cursor: pointer; }
  .pulse-art-pdf { font-size: 24px; cursor: default; }
  .pulse-art-name {
    font-size: 10px; color: var(--text-muted); text-align: center; max-width: 72px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;
  }

`;

function injectThemeCSS() {
  const style = document.createElement('style');
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
}

function renderNav(activePage) {
  // access: 'all' | 'admin' | 'production' | 'operator' | 'account-manager'
  const page = (slug) => (typeof pulsePage === 'function' ? pulsePage(slug) : slug + '.html');
  const safeHref = (href) => {
    try {
      if (typeof window !== 'undefined' && href && href.endsWith('.html')) {
        const probe = new URL(href, window.location.href);
        if (probe.pathname && !probe.pathname.endsWith('.html')) {
          return page('dashboard');
        }
      }
    } catch (_) {}
    return href;
  };
  const pages = [
    { id: 'dashboard',          label: '\uD83C\uDFE0 Dashboard',         href: page('dashboard'),           access: 'all' },
    { id: 'job-ticket',         label: '\uD83C\uDFAB Job Ticket',         href: page('job-ticket'),          access: 'all' },
    { id: 'prepress',           label: '\uD83D\uDCC4 Prepress',          href: page('prepress'),            access: 'production' },
    { id: 'production-manager', label: '\u2699\uFE0F Production',         href: page('production-manager'),  access: 'production' },
    { id: 'operator-terminal',  label: '\uD83D\uDC77 Operator',           href: page('operator-terminal'),   access: 'operator' },
    { id: 'qc-checkout',        label: '\uD83D\uDD0D QC',                 href: page('qc-checkout'),         access: 'production' },
    { id: 'shipping',           label: '\uD83D\uDE9A Shipping',            href: page('shipping'),            access: 'production' },
    { id: 'machine-issues',     label: '\uD83D\uDD27 Report Issue',       href: page('machine-issues'),      access: 'production' },
  ];
  const accessClass = { 'all': '', 'admin': 'nav-admin-only', 'production': 'nav-production-only', 'operator': 'nav-operator-only' };
  const adminMenuActive = activePage === 'admin';
  return `
    <nav class="top-nav">
      <div class="top-nav-leading">
        <div class="top-nav-brand">
          <a href="${page('dashboard')}" class="top-nav-logo-link" title="Pulse ${PULSE_UI_VERSION}">
            <img src="/pulse-logo.png" alt="Pulse" class="top-nav-logo-img">
            <span class="top-nav-version">${PULSE_UI_VERSION}</span>
          </a>
        </div>
        <a href="${safeHref(page('pricing-calculator'))}" data-page-id="pricing-calculator" class="nav-link top-nav-pricing-btn ${activePage === 'pricing-calculator' ? 'active' : ''}">$ Pricing</a>
      </div>
      <div class="nav-links">
        ${pages.map(p => `<a href="${safeHref(p.href)}" data-page-id="${p.id}" class="nav-link ${p.id === activePage ? 'active' : ''} ${accessClass[p.access]||''}">${p.label}</a>`).join('')}
        <div class="nav-admin-submenu nav-admin-only">
          <button type="button" class="nav-dropdown-toggle ${adminMenuActive ? 'active' : ''}" aria-haspopup="true" aria-expanded="false">\u2699\uFE0F Admin \u25BE</button>
          <div class="nav-dropdown-panel" role="menu">
            <a href="${safeHref(page('admin'))}" role="menuitem" data-page-id="admin" class="nav-link ${activePage === 'admin' ? 'active' : ''}">Admin</a>
          </div>
        </div>
      </div>
      <div class="top-nav-user-slot" id="topNavUserSlot"></div>
      <button
        id="topNavSignOutBtn"
        onclick="typeof logoutUser==='function'?logoutUser():location.reload()"
        title="Sign out"
        style="display:none;"
        class="top-nav-signout-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </button>
    </nav>
  `;
}

// P4-A/P4-B: Status badge with icon prefix for accessibility
const STATUS_ICONS = {
  'waiting-approval':       '⏳',
  'new':                    '🆕',
  'pending-confirmation':   '⚠️',
  'pending-review':         '👁',
  'prepress':               '📋',
  'prepress-active':        '🟢',
  'prepress-paused':        '⏸',
  'pending-account-manager':'↩️',
  'in-production':          '▶️',
  'on-hold':                '🔴',
  'qc-checkout':            '🔍',
  'ready-to-ship':          '✅',
  'shipped':                '🚚',
  'waiting-pickup':         '📦',
  'delivery-ready':         '🚚',
  'received':               '✔️',
  'completed':              '✔️',
  'qc-failed':              '❌',
  'reprint':                '🔁',
  // PUL-713/714: Order form statuses
  'order-pending':          '📄',
  'order-priced':           '🔒',
  'order-confirmed':        '✅',
};

// ── SKU versions & artwork (production manager, operator terminal, etc.) ──
let _pulseArtworkUrls = [];

function pulseEscapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isPulseArtImageFile(f) {
  if (f?.type?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|tif|tiff|bmp)$/i.test(f?.name || '');
}

function normalizeJobTicketSku(sku) {
  if (!sku || typeof sku !== 'object') return sku;
  const s = { ...sku };
  if (!s.artworkDataUrl) {
    s.artworkDataUrl = s.dataUrl || s.artwork_url || s.artworkUrl
      || (s.artwork && (s.artwork.dataUrl || s.artwork.url)) || null;
  }
  if (!s.artworkName) s.artworkName = s.artwork_name || s.fileName || s.artwork?.name || '';
  if (!s.artworkType) s.artworkType = s.artwork_type || s.artwork?.type || '';
  if (!s.whiteDataUrl) {
    s.whiteDataUrl = s.white_data_url || s.whiteLayerFile?.dataUrl || s.white?.dataUrl || null;
  }
  if (!s.whiteName) s.whiteName = s.white_name || s.whiteLayerFile?.name || s.white?.name || '';
  if (!s.uvDataUrl) s.uvDataUrl = s.uv_data_url || s.uvFile?.dataUrl || s.uv?.dataUrl || null;
  if (!s.uvName) s.uvName = s.uv_name || s.uvFile?.name || s.uv?.name || '';
  if (!s.foilDataUrl) s.foilDataUrl = s.foil_data_url || s.foilFile?.dataUrl || s.foil?.dataUrl || null;
  if (!s.foilName) s.foilName = s.foil_name || s.foilFile?.name || s.foil?.name || '';
  return s;
}

/** Copy order-level artwork/layer files onto SKU rows when SKUs lack inline media (Supabase specs). */
function hydrateJobTicketOrderMedia(order) {
  if (!order || typeof order !== 'object') return order;
  const o = { ...order };
  const skus = Array.isArray(o.skus) ? o.skus.map(normalizeJobTicketSku) : [];
  if (!skus.length) {
    if (Array.isArray(o.artworkFiles)) {
      o.artworkFiles = o.artworkFiles.map(f => ({ ...f, role: f.role || 'main' }));
    }
    return o;
  }

  const mainFiles = (o.artworkFiles || []).filter(f => f?.dataUrl);
  const pickMain = (i) => mainFiles[i] || (mainFiles.length === 1 ? mainFiles[0] : null);

  o.skus = skus.map((sku, i) => {
    const s = { ...sku };
    const file = pickMain(i);
    if (!s.artworkDataUrl && file?.dataUrl) {
      s.artworkDataUrl = file.dataUrl;
      s.artworkName = s.artworkName || file.name || 'Main artwork';
      s.artworkType = s.artworkType || file.type || '';
    }
    if (!s.whiteDataUrl && o.whiteLayerFile?.dataUrl) {
      s.whiteDataUrl = o.whiteLayerFile.dataUrl;
      s.whiteName = s.whiteName || o.whiteLayerFile.name || 'White layer';
    }
    if (!s.uvDataUrl && o.uvFile?.dataUrl) {
      s.uvDataUrl = o.uvFile.dataUrl;
      s.uvName = s.uvName || o.uvFile.name || 'UV layer';
    }
    if (!s.foilDataUrl && o.foilFile?.dataUrl) {
      s.foilDataUrl = o.foilFile.dataUrl;
      s.foilName = s.foilName || o.foilFile.name || 'Foil layer';
    }
    return s;
  });
  return o;
}

function normalizeJobTicketOrderMedia(order) {
  if (!order || typeof order !== 'object') return order;
  return hydrateJobTicketOrderMedia(order);
}

/**
 * True if an order (or its specs object) carries any artwork / graphics.
 * Checks order-level files and SKU-level inline media. Used by the data layer
 * to guarantee graphics are never dropped on update at any production step.
 */
function pulseOrderHasGraphics(o) {
  if (!o || typeof o !== 'object') return false;
  const fileHas = (f) => !!(f && (f.dataUrl || f.r2Key || f.url));
  if (Array.isArray(o.artworkFiles) && o.artworkFiles.some(fileHas)) return true;
  if (fileHas(o.whiteLayerFile) || fileHas(o.uvFile) || fileHas(o.foilFile)) return true;
  if (Array.isArray(o.skus) && o.skus.some(sk => {
    if (!sk || typeof sk !== 'object') return false;
    if (sk.artworkDataUrl || sk.whiteDataUrl || sk.uvDataUrl || sk.foilDataUrl) return true;
    if (sk.dataUrl || sk.artworkUrl || sk.artwork_url) return true;
    if (Array.isArray(sk.artworkFiles) && sk.artworkFiles.some(fileHas)) return true;
    if (Array.isArray(sk.versions) && sk.versions.length) return true;
    return false;
  })) return true;
  return false;
}

/**
 * Copy stored graphics from a previous order/specs onto an update payload when
 * the incoming update carries no graphics at all. Mutates and returns `target`.
 */
function pulsePreserveGraphics(target, previous) {
  if (!target || !previous) return target;
  if (!pulseOrderHasGraphics(previous)) return target;
  if (pulseOrderHasGraphics(target)) return target;
  if (previous.artworkFiles != null) target.artworkFiles = previous.artworkFiles;
  if (previous.whiteLayerFile != null) target.whiteLayerFile = previous.whiteLayerFile;
  if (previous.uvFile != null) target.uvFile = previous.uvFile;
  if (previous.foilFile != null) target.foilFile = previous.foilFile;
  if (previous.skus != null) target.skus = previous.skus;
  if (previous.skuCount != null) target.skuCount = previous.skuCount;
  return target;
}

function mergeJobTicketSkuMedia(nextSkus, previousSkus) {
  if (!Array.isArray(nextSkus) || !nextSkus.length) {
    return Array.isArray(previousSkus) && previousSkus.length
      ? previousSkus.map(normalizeJobTicketSku)
      : nextSkus;
  }
  if (!Array.isArray(previousSkus) || !previousSkus.length) {
    return nextSkus.map(normalizeJobTicketSku);
  }
  const mediaKeys = [
    'artworkDataUrl', 'artworkName', 'artworkType',
    'whiteDataUrl', 'whiteName', 'uvDataUrl', 'uvName', 'foilDataUrl', 'foilName',
  ];
  return nextSkus.map((sku, i) => {
    const norm = normalizeJobTicketSku(sku);
    const prev = normalizeJobTicketSku(
      previousSkus[i] || previousSkus.find(p => p && norm.name && p.name === norm.name)
    );
    if (!prev) return norm;
    const merged = { ...prev, ...norm };
    mediaKeys.forEach(k => {
      if (!merged[k] && prev[k]) merged[k] = prev[k];
    });
    return merged;
  });
}

if (typeof window !== 'undefined') {
  window.normalizeJobTicketSku = normalizeJobTicketSku;
  window.hydrateJobTicketOrderMedia = hydrateJobTicketOrderMedia;
  window.normalizeJobTicketOrderMedia = normalizeJobTicketOrderMedia;
  window.mergeJobTicketSkuMedia = mergeJobTicketSkuMedia;
  window.pulseOrderHasGraphics = pulseOrderHasGraphics;
  window.pulsePreserveGraphics = pulsePreserveGraphics;
}

function getOrderSkuArtFiles(sku) {
  if (!sku) return [];
  sku = normalizeJobTicketSku(sku);
  const files = [];
  if (sku.artworkDataUrl) {
    files.push({ name: sku.artworkName || 'Main artwork', type: sku.artworkType || '', dataUrl: sku.artworkDataUrl });
  }
  if (sku.whiteDataUrl) {
    files.push({ name: sku.whiteName || 'White layer', type: '', dataUrl: sku.whiteDataUrl });
  }
  if (sku.uvDataUrl) {
    files.push({ name: sku.uvName || 'UV layer', type: '', dataUrl: sku.uvDataUrl });
  }
  if (sku.foilDataUrl) {
    files.push({ name: sku.foilName || 'Foil layer', type: '', dataUrl: sku.foilDataUrl });
  }
  return files;
}

function collectOrderArtworkFiles(order) {
  const files = [];
  const seen = new Set();
  const add = (f) => {
    if (!f?.dataUrl) return;
    const key = String(f.dataUrl).slice(0, 96) + '|' + (f.name || '');
    if (seen.has(key)) return;
    seen.add(key);
    files.push(f);
  };
  (order.artworkFiles || []).forEach(f => add({ name: f.name || 'Main artwork', type: f.type || '', dataUrl: f.dataUrl }));
  if (order.whiteLayerFile?.dataUrl) {
    add({ name: order.whiteLayerFile.name || 'White layer', type: order.whiteLayerFile.type || '', dataUrl: order.whiteLayerFile.dataUrl });
  }
  if (order.uvFile?.dataUrl) {
    add({ name: order.uvFile.name || 'UV layer', type: order.uvFile.type || '', dataUrl: order.uvFile.dataUrl });
  }
  if (order.foilFile?.dataUrl) {
    add({ name: order.foilFile.name || 'Foil layer', type: order.foilFile.type || '', dataUrl: order.foilFile.dataUrl });
  }
  return files;
}

function renderPulseArtThumbGrid(files = []) {
  if (!files.length) return '';
  const start = _pulseArtworkUrls.length;
  files.forEach(f => { if (f?.dataUrl) _pulseArtworkUrls.push(f.dataUrl); });
  return `<div class="pulse-art-grid">${files.map((f, i) => {
    const idx = start + i;
    const isImage = isPulseArtImageFile(f);
    const name = pulseEscapeHtml(f.name || 'file');
    return `<div>
      <div class="${isImage ? 'pulse-art-thumb' : 'pulse-art-pdf'}">${isImage
        ? `<img src="${f.dataUrl}" alt="${name}" onclick="openPulseArtworkByIndex(${idx})">`
        : '📄'}</div>
      <div class="pulse-art-name" title="${name}">${name}</div>
    </div>`;
  }).join('')}</div>`;
}

function getOrderSkusFiltered(order) {
  return (order?.skus || []).filter(s => s && (s.name || s.quantity || getOrderSkuArtFiles(s).length));
}

function getOrderSkuTotalQuantity(order) {
  const skus = getOrderSkusFiltered(order);
  if (!skus.length) return Number(order?.quantity) || 0;
  return skus.reduce((sum, sku) => sum + (Number(sku.quantity) || 0), 0);
}

/** Job detail quantity line — uses per-SKU qty when SKU versions exist. */
function formatOrderQuantityDisplay(order) {
  const skus = getOrderSkusFiltered(order);
  if (skus.length === 1) {
    const q = (Number(skus[0].quantity) || 0).toLocaleString();
    const name = skus[0].name || 'SKU 1';
    return `${q} pcs · ${name}`;
  }
  if (skus.length > 1) {
    const total = getOrderSkuTotalQuantity(order);
    return `${total.toLocaleString()} pcs total (${skus.length} SKUs — see columns below)`;
  }
  const q = Number(order?.quantity) || 0;
  return q ? `${q.toLocaleString()} units` : '—';
}

function renderPulseSkuBlock(sku, index) {
  const files = getOrderSkuArtFiles(sku);
  const label = pulseEscapeHtml(sku.name || `SKU ${index + 1}`);
  const qty = (Number(sku.quantity) || 0).toLocaleString();
  const layers = [];
  if (sku.whiteDataUrl) layers.push('White');
  if (sku.uvDataUrl) layers.push('UV');
  if (sku.foilDataUrl) layers.push('Foil');
  const layersHtml = layers.length
    ? `<span class="pulse-sku-layers">Layers: ${layers.map(pulseEscapeHtml).join(' · ')}</span>`
    : '';
  return `
    <div class="pulse-sku-block">
      <div class="pulse-sku-name">#${index + 1} · ${label}</div>
      <div class="pulse-sku-qty">${qty}</div>
      <div class="pulse-sku-qty-unit">pieces</div>
      ${layersHtml}
      <div class="pulse-sku-art">${files.length
        ? renderPulseArtThumbGrid(files)
        : '<div class="pulse-sku-empty">No artwork files for this SKU.</div>'
      }</div>
    </div>`;
}

/** Grid columns for SKU row: N SKUs → N equal-width columns. */
function pulseSkuColumnsStyle(skus) {
  const n = Math.max(1, skus?.length || 0);
  return `--pulse-sku-cols:${n};grid-template-columns:repeat(${n},minmax(0,1fr));`;
}
if (typeof window !== 'undefined') {
  window.pulseSkuColumnsStyle = pulseSkuColumnsStyle;
  window.getOrderSkusFiltered = getOrderSkusFiltered;
  window.getOrderSkuTotalQuantity = getOrderSkuTotalQuantity;
  window.formatOrderQuantityDisplay = formatOrderQuantityDisplay;
}

/** SKU versions + artwork for production manager / operator job detail */
function renderOrderSkuSection(order) {
  if (!order) return '';
  _pulseArtworkUrls = [];
  const skus = getOrderSkusFiltered(order);
  const globalFiles = collectOrderArtworkFiles(order);
  if (!skus.length && !globalFiles.length) return '';

  const parts = [];
  if (skus.length) {
    const colStyle = pulseSkuColumnsStyle(skus);
    const totalQty = getOrderSkuTotalQuantity(order);
    const titleExtra = totalQty
      ? ` · ${totalQty.toLocaleString()} pcs total`
      : '';
    parts.push(`
      <div class="pulse-sku-section">
        <h4 class="pulse-sku-section-title">📦 SKU versions <span>(${skus.length}${titleExtra})</span></h4>
        <div class="pulse-sku-columns" style="${colStyle}">
          ${skus.map((sku, i) => renderPulseSkuBlock(sku, i)).join('')}
        </div>
      </div>`);
  } else if (globalFiles.length) {
    parts.push(`
      <div class="pulse-sku-section">
        <h4 class="pulse-sku-section-title">Artwork</h4>
        ${renderPulseArtThumbGrid(globalFiles)}
      </div>`);
  }
  return parts.join('');
}

function openPulseArtworkByIndex(idx) {
  const url = _pulseArtworkUrls[idx];
  if (!url) return;
  if (typeof openArtworkLightbox === 'function') {
    openArtworkLightbox(url);
    return;
  }
  const w = window.open('', '_blank', 'width=900,height=700');
  if (w) w.document.write(`<img src="${url}" style="max-width:100%;max-height:100vh;">`);
}

function renderStatusBadge(status) {
  const icon = STATUS_ICONS[status] || '';
  return `<span class="badge badge-${status}">${icon ? icon + '&thinsp;' : ''}${STATUS_LABELS[status] || status}</span>`;
}

function renderMaterialOptions() {
  return MATERIALS.map(g => `<optgroup label="${g.category}">${g.items.map(i => `<option value="${i}">${i}</option>`).join('')}</optgroup>`).join('');
}

// ── P4-C: Breadcrumb navigation ─────────────────────────────
// items: [{label, href?}] — last item has no href (current page)
function renderBreadcrumb(_items) {
  return '';
}

// ── P4-D: Global page toast ──────────────────────────────────
// type: 'success' | 'error' | 'info' | 'warning'
function showPageToast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('page-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'page-toast-container';
    document.body.appendChild(container);
  }
  const colors = {
    success: { bg: '#d4edda', border: '#16a34a', text: '#0f6b2d' },
    error:   { bg: '#fde8e8', border: '#dc2626', text: '#7f1d1d' },
    info:    { bg: '#e0edff', border: '#2563eb', text: '#1d4ed8' },
    warning: { bg: '#fef3cd', border: '#d97706', text: '#78350f' },
  };
  const c = colors[type] || colors.info;
  const el = document.createElement('div');
  el.className = 'page-toast';
  el.style.cssText = `background:${c.bg};border-left-color:${c.border};color:${c.text};`;
  el.innerHTML = message;
  el.onclick = () => el.remove();
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
}

// ── P1-A: Next-step required banner HTML ────────────────────
function renderNextStepBanner(nextMachine, nextOperation) {
  const op = nextOperation ? ` · ${escHtml(nextOperation)}` : '';
  return `<div class="next-step-banner">
    <span style="font-size:20px;">➡️</span>
    <div>
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;opacity:0.75;">Next Required Step</div>
      <div class="next-step-machine">${escHtml(nextMachine)}${op}</div>
      <div style="font-size:11px;font-weight:500;margin-top:2px;opacity:0.8;">Send job to this machine when your step is complete</div>
    </div>
  </div>`;
}

// Auto-seed Personnel in IndexedDB only (Supabase uses profiles table — no browser seeding)
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof pulseUsesSupabaseStorage === 'function' && pulseUsesSupabaseStorage()) return;
  try {
    await seedPersonnelFromProfiles();
    await dedupePersonnelByName();
    if (typeof ensureAuthPersonnelInDb === 'function') await ensureAuthPersonnelInDb();
    await dedupePersonnelByName();
  } catch (_) {}
});

// ── PUL-710: Company logo helper ─────────────────────────────
// Returns the branding-directory path for a given company key,
// relative to the v3 root (same directory as shared.js).
function getCompanyLogo(companyKey) {
  const paths = {
    bazaar: 'branding/bazaar-logo.png',
    pixel:  'branding/pixelpress-logo.png',
  };
  return paths[companyKey] || null;
}
