// ============================================================
// shared.js — Bazaar Printing Production Management System
// IndexedDB wrapper, constants, BroadcastChannel sync
// ============================================================

const DB_NAME = 'BazaarPrintDB';
const DB_VERSION = 6;
const PULSE_UI_VERSION = 'v21';

if (typeof document !== 'undefined' && !document.querySelector('script[data-pulse-local-notifications]')) {
  const localConfigScript = document.createElement('script');
  localConfigScript.src = 'notification-config.local.js';
  localConfigScript.dataset.pulseLocalNotifications = 'true';
  document.head.appendChild(localConfigScript);
}

// Load pulse-config.local.js (gitignored) if present — sets PULSE_SUPABASE_URL,
// PULSE_SUPABASE_ANON_KEY, PULSE_STORAGE_BACKEND for supabase-client.js
if (typeof document !== 'undefined' && !document.querySelector('script[data-pulse-config]')) {
  const pulseConfigScript = document.createElement('script');
  pulseConfigScript.src = 'pulse-config.local.js';
  pulseConfigScript.dataset.pulseConfig = 'true';
  document.head.appendChild(pulseConfigScript);
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

// ── Production Lines ───────────────────────────────────────
// Classify which production line an order belongs to based on its workflow
const PRODUCTION_LINES = {
  '6k': {
    name: 'HP Indigo 6K Line',
    color: '#2563eb',    // blue
    bgColor: 'rgba(37,99,235,0.08)',
    borderColor: 'rgba(37,99,235,0.3)',
    // Typical process stages in order
    stages: ['Prepress', 'Press 6K', 'GM Die/Laser Cut', 'Lamination', 'Pouching', 'Application', 'QC', 'Ready to Ship']
  },
  '15k': {
    name: 'HP Indigo 15K Line',
    color: '#7c3aed',    // purple
    bgColor: 'rgba(124,58,237,0.08)',
    borderColor: 'rgba(124,58,237,0.3)',
    stages: ['Prepress', 'Press 15K', 'Lamination', 'Scodix', 'Die Cut (Moll)', 'Flatbed Cut (Duplo)', 'Flatbed Cut (Boyd)', 'Guillotine', 'Fold & Glue', 'Hand Glue', 'UV Coat', 'Application', 'QC', 'Ready to Ship']
  },
  'boyd': {
    name: 'Boyd Street',
    color: '#d97706',    // amber/orange
    bgColor: 'rgba(217,119,6,0.08)',
    borderColor: 'rgba(217,119,6,0.3)',
    stages: ['Prepress', 'Printing', 'Lamination', 'Cutting', 'Application', 'QC', 'Ready to Ship']
  }
};

// Determine production line from order data
function getProductionLine(order) {
  const steps = order.workflowSteps || [];
  const machines = steps.map(s => s.machine);
  // Check workflow steps first
  if (machines.some(m => m && m.includes('6K'))) return '6k';
  if (machines.some(m => m && m.includes('15K'))) return '15k';
  if (order.facility === 'boyd-street') return 'boyd';
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
// These are operational rules, not suggestions.
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
  const lt = LEAD_TIMES[productType];
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

  const minDate = getMinDueDate(productType, quantity);
  minDate.setHours(0,0,0,0);
  const lt = LEAD_TIMES[productType];

  if (dueDateObj < minDate) {
    const businessDaysBetween = countBusinessDays(today, dueDateObj);
    return {
      isRush: true,
      isPast: false,
      message: `Rush order: ${businessDaysBetween} business days. Standard is ${lt ? lt.label : '3-5 business days'}. Requires supervisor approval (Tigran).`,
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
      if (['completed','shipped','received','waiting-pickup','cancelled'].includes(o.status)) return false;
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
  // Account Managers / Sales Reps
  'Gary Gharibyan':   { facility: 'all', machines: [], role: 'account-manager', shift: '—', notes: 'Account Manager' },
  'Ernesto Flores':   { facility: 'all', machines: [], role: 'account-manager', shift: '—', notes: 'Account Manager' },
  'Bob Werner':       { facility: 'all', machines: [], role: 'account-manager', shift: '—', notes: 'Account Manager' },
  'Tiko':             { facility: 'all', machines: [], role: 'account-manager', shift: '—', notes: 'Account Manager' },
  'Tigran Zohrabyan': { facility: 'all', machines: [], role: 'supervisor', shift: '—', notes: 'Supervisor / Sales Manager' },
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

function getMachineAssignedOperators(machineName) {
  return Object.entries(OPERATOR_PROFILES)
    .filter(([, profile]) => profile.role === 'operator' && Array.isArray(profile.machines) && profile.machines.includes(machineName))
    .map(([name, profile]) => ({
      name,
      hoursPerDay: OPERATOR_DAILY_HOURS_OVERRIDES[name] || DEFAULT_PRODUCTIVE_HOURS_PER_DAY,
      shift: profile.shift,
      profile,
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
  'shipped', 'waiting-pickup', 'received', 'completed'
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
  'received': 'Received',
  'completed': 'Completed',
  'qc-failed': 'QC Failed',
  'reprint': 'Reprint'
};

const STATUS_COLORS = {
  'waiting-approval': '#8b949e',
  'new': '#58a6ff',
  'pending-confirmation': '#ea580c',
  'pending-review': '#d29922',
  'prepress': '#2563eb',
  'prepress-active': '#16a34a',
  'prepress-paused': '#d97706',
  'step-paused': '#d97706',
  'pending-account-manager': '#dc2626',
  'in-production': '#3fb950',
  'on-hold': '#f85149',
  'qc-checkout': '#bc8cff',
  'ready-to-ship': '#3fb950',
  'shipped': '#8b949e',
  'waiting-pickup': '#d29922',
  'received': '#3fb950',
  'completed': '#8b949e',
  'qc-failed': '#f85149',
  'reprint': '#f97316'
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
// supabase-client.js fires 'pulse:order-change' / 'pulse:activity-change' on window
// when Supabase pushes a realtime update; mirror those into _dbUpdateCallbacks so
// all pages with onDBUpdate() handlers refresh without polling.
window.addEventListener('pulse:order-change', (event) => {
  const id = (event.detail && (event.detail.new?.id || event.detail.old?.id)) || null;
  _dbUpdateCallbacks.forEach(cb => cb({ type: 'db-update', store: 'orders', id }));
});
window.addEventListener('pulse:activity-change', (event) => {
  const id = (event.detail && (event.detail.new?.id || event.detail.old?.id)) || null;
  _dbUpdateCallbacks.forEach(cb => cb({ type: 'db-update', store: 'activity_log', id }));
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

function openDB() {
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
      // Material Inventory — v3
      if (!db.objectStoreNames.contains('inventory')) {
        const inv = db.createObjectStore('inventory', { keyPath: 'id', autoIncrement: true });
        inv.createIndex('material', 'material', { unique: false });
        inv.createIndex('facility', 'facility', { unique: false });
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

// Generic CRUD helpers
function _add(storeName, data) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.add(data);
    req.onsuccess = () => { broadcastUpdate(storeName, req.result); resolve(req.result); };
    req.onerror = () => reject(req.error);
  }));
}

function _get(storeName, id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _getAll(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function _update(storeName, id, changes) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const getReq = store.get(id);
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
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
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
  order.createdAt = order.createdAt || new Date().toISOString();
  order.updatedAt = new Date().toISOString();
  order.workflowSteps = order.workflowSteps || [];
  order.currentStep = order.currentStep ?? 0;
  order.status = order.status || 'new';
  return _add('orders', order);
}

function getOrder(id) { return _get('orders', id); }
function getAllOrders() { return _getAll('orders'); }
function updateOrder(id, changes) { return _update('orders', id, changes); }

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
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const idx = tx.objectStore('orders').index('orderId');
    const req = idx.get(orderId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
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
  try {
    return JSON.parse(localStorage.getItem('pulse_notification_memory') || '{}');
  } catch (e) {
    return {};
  }
}

function rememberNotification(key) {
  const memory = getNotificationMemory();
  memory[key] = Date.now();
  localStorage.setItem('pulse_notification_memory', JSON.stringify(memory));
}

function hasRecentNotification(key, cooldownMinutes = 60) {
  const memory = getNotificationMemory();
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
  if (hasRecentNotification(dedupeKey, cooldown)) return { ok: false, skipped: 'cooldown' };

  const message = typeof messageBuilder === 'function' ? messageBuilder(order, settings) : String(messageBuilder || '').trim();
  if (!message) return { ok: false, skipped: 'empty-message' };

  for (const recipient of recipients) {
    await sendSmsViaPulseProxy({ to: recipient.phone, message, proxyBase: settings.proxyBase });
  }
  rememberNotification(dedupeKey);
  return { ok: true, count: recipients.length };
}

// ── Personnel CRUD ─────────────────────────────────────────

function addPersonnel(person) {
  person.createdAt = new Date().toISOString();
  person.active = person.active !== false;
  return _add('personnel', person);
}
function getAllPersonnel() { return _getAll('personnel'); }
function updatePersonnel(id, changes) { return _update('personnel', id, changes); }
function deletePersonnel(id) { return _delete('personnel', id); }

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
    });
  }
}
async function getPersonnelByName(name) {
  const people = await getAllPersonnel();
  return people.find(p => p.name === name) || null;
}
async function getOperatorProfile(name) {
  const staticProfile = OPERATOR_PROFILES[name] || null;
  const dbPerson = await getPersonnelByName(name);
  if (!staticProfile && !dbPerson) return null;
  return {
    ...(staticProfile || {}),
    ...(dbPerson || {}),
    name,
    machines: dbPerson?.machines || staticProfile?.machines || [],
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

// ── Activity Log ───────────────────────────────────────────

function addActivity(log) {
  log.timestamp = log.timestamp || new Date().toISOString();
  return _add('activity_log', log);
}

function getActivityLog(orderId) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('activity_log', 'readonly');
    const idx = tx.objectStore('activity_log').index('orderId');
    const req = idx.getAll(orderId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function getAllActivity() { return _getAll('activity_log'); }

// ── Config (for admin variable overrides) ──────────────────

function getConfig(key) { return _get('config', key); }

function setConfig(key, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    const req = tx.objectStore('config').put({ key, value, updatedAt: new Date().toISOString() });
    req.onsuccess = () => { broadcastUpdate('config', key); resolve(); };
    req.onerror = () => reject(req.error);
  }));
}

// ── Knowledge Base (Operator Alerts) ──────────────────────

function addKnowledgeEntry(entry) {
  return _add('knowledge_base', { ...entry, active: true, createdAt: new Date().toISOString() });
}

function getAllKnowledge() { return _getAll('knowledge_base'); }

function updateKnowledge(id, changes) { return _update('knowledge_base', id, changes); }

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
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('reprints', 'readonly');
    const idx = tx.objectStore('reprints').index('parentOrderId');
    const req = idx.getAll(parentOrderId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
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

function getAllDies() { return _getAll('dies'); }
function updateDie(id, changes) { return _update('dies', id, changes); }

function getDieByNumber(dieNumber) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('dies', 'readonly');
    const idx = tx.objectStore('dies').index('dieNumber');
    const req = idx.get(dieNumber);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function getDieByBarcode(barcode) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('dies', 'readonly');
    const idx = tx.objectStore('dies').index('barcode');
    const req = idx.get(barcode);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
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

// ── Material Inventory ────────────────────────────────────

function addInventoryItem(item) {
  return _add('inventory', {
    ...item,
    createdAt: new Date().toISOString(),
    lastRestocked: item.lastRestocked || null,
    quantityOnHand: item.quantityOnHand || 0,
    unit: item.unit || 'sheets', // sheets, linear-feet, sq-ft, rolls, units
    reorderPoint: item.reorderPoint || 0,
    usageHistory: [], // { date, quantityUsed, orderId }
  });
}

function getAllInventory() { return _getAll('inventory'); }
function updateInventoryItem(id, changes) { return _update('inventory', id, changes); }

// Check if we have enough material for an order — includes pending orders' demand
async function checkMaterialAvailability(material, facility, quantityNeeded) {
  const all = await getAllInventory();
  const match = all.find(i => i.material === material && i.facility === facility);
  const onHand = match?.quantityOnHand || 0;

  // Calculate total demand from pending/in-production orders using the same material
  const allOrders = await getAllOrders();
  const pendingDemand = allOrders
    .filter(o => !['completed','shipped','received','cancelled'].includes(o.status) && o.material === material && o.facility === facility)
    .reduce((sum, o) => sum + (o.sheetCount || o.quantity || 0), 0);

  const totalNeeded = pendingDemand + quantityNeeded;
  const shortfall = Math.max(0, totalNeeded - onHand);
  const shortfallForThisOrder = Math.max(0, quantityNeeded - Math.max(0, onHand - pendingDemand));

  return {
    available: shortfallForThisOrder === 0,
    onHand,
    needed: quantityNeeded,
    pendingDemand,
    totalNeeded,
    shortfall,
    shortfallForThisOrder,
    inventoryId: match?.id || null,
    noInventoryRecord: !match,
  };
}

// Full material check for a new order — returns warnings and suggestions
async function checkMaterialForOrder(order) {
  const material = order.material;
  const facility = order.facility;
  const sheetCount = order.sheetCount || Math.ceil((order.quantity || 0) / (order.piecesPerSheet || 1));

  if (!material || !facility) return { ok: true, warnings: [] };

  const check = await checkMaterialAvailability(material, facility, sheetCount);
  const warnings = [];

  if (check.noInventoryRecord) {
    warnings.push({
      level: 'info',
      message: `⚠️ Material "${material}" has no inventory record at ${FACILITIES[facility]?.name || facility}. Add it in Admin → Inventory to enable tracking.`,
    });
    return { ok: true, warnings }; // Don't block — just inform
  }

  if (!check.available) {
    warnings.push({
      level: 'critical',
      message: `🔴 MATERIAL SHORTAGE: "${material}" — need ${sheetCount.toLocaleString()} (${order.printType === 'Roll' ? 'frames' : 'sheets'}) but only ${Math.max(0, check.onHand - check.pendingDemand).toLocaleString()} available after pending orders.`,
      details: `On hand: ${check.onHand.toLocaleString()} | Already committed: ${check.pendingDemand.toLocaleString()} | This order needs: ${sheetCount.toLocaleString()} | Shortfall: ${check.shortfallForThisOrder.toLocaleString()}`,
    });
  } else if (check.onHand > 0 && (check.onHand - check.totalNeeded) < (check.onHand * 0.2)) {
    // Less than 20% remaining after this order
    const remaining = check.onHand - check.totalNeeded;
    warnings.push({
      level: 'warning',
      message: `⚠️ LOW STOCK WARNING: "${material}" will be at ${remaining.toLocaleString()} after this order + pending. Consider reordering.`,
    });
  }

  return {
    ok: warnings.every(w => w.level !== 'critical'),
    warnings,
    availability: check,
  };
}

// Record material received from PO
async function receiveMaterial(inventoryId, quantityReceived, poId) {
  const item = await _get('inventory', inventoryId);
  if (!item) return null;
  return _update('inventory', inventoryId, {
    quantityOnHand: (item.quantityOnHand || 0) + quantityReceived,
    lastRestocked: new Date().toISOString(),
    lastPO: poId,
  });
}

// Calculate usage trend (1 week, 2 weeks, 1 month) for reorder suggestions
async function getUsageTrend(material, facility, periodDays) {
  const all = await getAllInventory();
  const match = all.find(i => i.material === material && i.facility === facility);
  if (!match || !match.usageHistory || match.usageHistory.length === 0) return { dailyAvg: 0, periodTotal: 0, suggestedOrder: 0 };
  const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
  const recentUsage = match.usageHistory.filter(u => u.date >= cutoff);
  const periodTotal = recentUsage.reduce((s, u) => s + (u.quantityUsed || 0), 0);
  const dailyAvg = periodTotal / periodDays;
  // Suggest enough for the same period + 20% buffer
  const suggestedOrder = Math.ceil(dailyAvg * periodDays * 1.2);
  return { dailyAvg: Math.round(dailyAvg), periodTotal, suggestedOrder };
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
  // Update inventory for each item in PO
  for (const item of (po.items || [])) {
    if (item.inventoryId) {
      await receiveMaterial(item.inventoryId, item.quantity, po.poNumber);
    }
  }
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
  .badge-waiting-approval { background: #f1f3f5; color: #5f6b7a; }
  .badge-new { background: #e0edff; color: #1d4ed8; }
  .badge-pending-confirmation { background: #fff1e6; color: #c2410c; }
  .badge-pending-review { background: #fef3cd; color: #92600a; }
  .badge-prepress { background: #e0edff; color: #1d4ed8; }
  .badge-prepress-active { background: #d4edda; color: #0f6b2d; }
  .badge-prepress-paused { background: #fef3cd; color: #92600a; }
  .badge-pending-account-manager { background: #fee2e2; color: #b91c1c; }
  .badge-in-production { background: #d4edda; color: #0f6b2d; }
  .badge-on-hold { background: #fde8e8; color: #b91c1c; }
  .badge-qc-checkout { background: #ede9fe; color: #6d28d9; }
  .badge-ready-to-ship { background: #d4edda; color: #0f6b2d; }
  .badge-shipped { background: #f1f3f5; color: #5f6b7a; }
  .badge-waiting-pickup { background: #fef3cd; color: #92600a; }
  .badge-received { background: #d4edda; color: #0f6b2d; }
  .badge-completed { background: #ede9fe; color: #6d28d9; }
  .badge-qc-failed { background: #fde8e8; color: #b91c1c; }
  .badge-reprint { background: #fff7ed; color: #c2410c; }

  /* Navigation */
  .top-nav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 24px; background: #fff; border-bottom: 2px solid #e5e7eb;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .top-nav h1 { font-size: 18px; font-weight: 700; color: var(--text); }
  .top-nav .nav-links { display: flex; gap: 16px; }
  .top-nav .nav-links a { font-size: 13px; color: var(--text-muted); padding: 4px 8px; border-radius: 4px; }
  .top-nav .nav-links a:hover, .top-nav .nav-links a.active { color: var(--accent); background: #e0edff; text-decoration: none; }

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

  /* ── Preview build indicator ── */
  .preview-build-tag {
    display:inline-flex; align-items:center; gap:5px;
    padding:3px 10px; border-radius:999px;
    background:#fef9c3; border:1px solid #fde047; color:#854d0e;
    font-size:11px; font-weight:700; letter-spacing:0.02em;
  }
`;

function injectThemeCSS() {
  const style = document.createElement('style');
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
}

function renderNav(activePage) {
  // access: 'all' | 'admin' | 'production' | 'operator' | 'account-manager'
  const safeHref = (href) => {
    try {
      if (typeof window !== 'undefined' && href && href.endsWith('.html')) {
        const probe = new URL(href, window.location.href);
        if (probe.pathname && !probe.pathname.endsWith('.html')) {
          return 'dashboard.html';
        }
      }
    } catch (_) {}
    return href;
  };
  const pages = [
    { id: 'dashboard',          label: '\uD83C\uDFE0 Dashboard',         href: 'dashboard.html',           access: 'all' },
    { id: 'job-ticket',         label: '\uD83C\uDFAB Job Ticket',         href: 'job-ticket.html',          access: 'all' },
    { id: 'pricing-calculator', label: '\uD83D\uDCB2 Pricing',            href: 'pricing-calculator.html',  access: 'all' },
    { id: 'quotes',             label: '\uD83D\uDCAC Quotes',             href: 'quotes.html',              access: 'all' },
    { id: 'orders',             label: '\uD83D\uDCE6 Orders',             href: 'orders.html',              access: 'all' },
    { id: 'invoices',           label: '\uD83D\uDCCB Invoices',           href: 'invoice.html',             access: 'all' },
    { id: 'prepress',           label: '\uD83D\uDCC4 Prepress',          href: 'prepress.html',            access: 'production' },
    { id: 'production-manager', label: '\u2699\uFE0F Production',         href: 'production-manager.html',  access: 'production' },
    { id: 'operator-terminal',  label: '\uD83D\uDC77 Operator',           href: 'operator-terminal.html',   access: 'operator' },
    { id: 'qc-checkout',        label: '\uD83D\uDD0D QC',                 href: 'qc-checkout.html',         access: 'production' },
    { id: 'application-dept',   label: '\uD83C\uDFF7\uFE0F Application',  href: 'application-dept.html',    access: 'production' },
    { id: 'rep-tasks',          label: '\uD83D\uDCCB Rep Tasks',          href: 'rep-tasks.html',           access: 'all' },
    { id: 'instagram-leads',    label: '\uD83D\uDCF8 Instagram',           href: 'instagram-leads.html',     access: 'all' },
    { id: 'machine-issues',     label: '\uD83D\uDD27 Machines',           href: 'machine-issues.html',      access: 'production' },
    { id: 'admin',              label: '\u2699\uFE0F Admin',              href: 'admin.html',               access: 'admin' },
  ];
  const accessClass = { 'all': '', 'admin': 'nav-admin-only', 'production': 'nav-production-only', 'operator': 'nav-operator-only' };
  return `
    <nav class="top-nav">
      <a href="dashboard.html" style="display:flex;flex-direction:column;align-items:flex-start;text-decoration:none;gap:6px;">
        <img src="pulse-logo.png" alt="Pulse" style="height:88px;width:auto;display:block;">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:12px;font-weight:700;letter-spacing:0.02em;">${PULSE_UI_VERSION}</span>
        <span class="preview-build-tag">🔍 UX Preview</span>
      </a>
      <div class="nav-links">
        ${pages.map(p => `<a href="${safeHref(p.href)}" data-page-id="${p.id}" class="nav-link ${p.id === activePage ? 'active' : ''} ${accessClass[p.access]||''}">${p.label}</a>`).join('')}
      </div>
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
  'received':               '✔️',
  'completed':              '✔️',
  'qc-failed':              '❌',
  'reprint':                '🔁',
};

function renderStatusBadge(status) {
  const icon = STATUS_ICONS[status] || '';
  return `<span class="badge badge-${status}">${icon ? icon + '&thinsp;' : ''}${STATUS_LABELS[status] || status}</span>`;
}

function renderMaterialOptions() {
  return MATERIALS.map(g => `<optgroup label="${g.category}">${g.items.map(i => `<option value="${i}">${i}</option>`).join('')}</optgroup>`).join('');
}

// ── P4-C: Breadcrumb navigation ─────────────────────────────
// items: [{label, href?}] — last item has no href (current page)
function renderBreadcrumb(items) {
  const all = [{ label: '🏠 Dashboard', href: 'dashboard.html' }, ...items];
  return `<nav class="breadcrumb" aria-label="Breadcrumb">` +
    all.map((c, i) =>
      i < all.length - 1
        ? `<a href="${c.href}" class="bc-link">${c.label}</a><span class="bc-sep">›</span>`
        : `<span class="bc-current">${c.label}</span>`
    ).join('') +
  `</nav>`;
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

// Auto-seed Personnel DB from OPERATOR_PROFILES on every page load (idempotent — skips if already seeded)
document.addEventListener('DOMContentLoaded', () => { seedPersonnelFromProfiles().catch(() => {}); });
