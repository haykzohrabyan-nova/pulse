/**
 * pulse-benchmark.js — Market Benchmark Panel for Pulse
 * Rewritten per PUL-296/PUL-337: per-competitor spec-aware scoring + transparency data.
 *
 * lookupBenchmark() scores each data row independently per competitor
 * across 8 dimensions (size, qty, material, finish, lamination, UV, foil, shape),
 * returning per-competitor best-match results with full mismatch transparency,
 * staleness tiers, "not captured" rows, and a derived competitor capabilities view.
 *
 * New in PUL-337 (v2 port):
 *   - "outside captured range" label when qty > 5× nearest captured tier
 *   - shape + foil data on GotPrint rows (square-rounded captures, no foil)
 *
 * Usage:
 *   updateBenchmarkPanel(elementId, productType, widthIn, heightIn, quantity, bazaarTotal, specs)
 *
 * specs: { material, finish, lamination, uv, foil, shape } — all optional/nullable.
 *   uv:        'spot'|'full' if requested, null if not
 *   foil:      true if requested, null if not
 *   material:  Pulse material name string, null if not specified
 *   finish:    'matte'|'gloss'|'uncoated'|null
 *   lamination: UI lamination value, null if none
 *   shape:     'rect'|'square'|'rounded'|'die-cut'|null
 *
 * null = not captured / not requested. Never "not applicable".
 */

// ─── Inline dataset ─────────────────────────────────────────────────────────
// Schema: qid, pt, comp, size, qty, mat,
//   finish ('matte'|'gloss'|'uncoated'|null),
//   lam    ('none'|'matte-lam'|'gloss-lam'|'soft-touch'|null),
//   uv     ('none'|'spot'|'full'|null),
//   foil   (true|false|null),
//   shape  ('rect'|'square'|'rounded'|'die-cut'|null),
//   price, uPrice, conf, cap
//
// foil: false on GotPrint rows = standard roll-label offering confirmed without foil.
// shape: "rounded" on GotPrint 3×3 rows = captured as Square-Rounded per normalized JSON.
// All other rows: foil/shape null = not yet explicitly captured per PUL-296 Q1 decision.

const BENCHMARK_ROWS = [
  // Roll Labels ─────────────────────────────────────────────────────────────
  {qid:"3x3-5000-matte-bopp-cmyk",  pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:5000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:false,shape:"rounded",price:356.80, uPrice:0.07136,conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-5000-matte-bopp-cmyk",  pt:"roll_labels",comp:"uprinting", size:"3x3",  qty:5000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:505.85, uPrice:0.1012, conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-5000-matte-bopp-cmyk",  pt:"roll_labels",comp:"vistaprint",size:"3x3",  qty:5000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:544.86, uPrice:0.109,  conf:"medium",cap:"2026-04-17"},
  {qid:"2x2-5000-matte-bopp-cmyk",  pt:"roll_labels",comp:"uprinting", size:"2x2",  qty:5000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:309.16, uPrice:0.06183,conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-1000-matte-bopp-cmyk",  pt:"roll_labels",comp:"uprinting", size:"3x3",  qty:1000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:222.26, uPrice:0.22226,conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-1000-matte-bopp-cmyk",  pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:1000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:false,shape:"rounded",price:148.91, uPrice:0.14891,conf:"high",  cap:"2026-04-17"},
  {qid:"2x2-1000-matte-bopp-cmyk",  pt:"roll_labels",comp:"uprinting", size:"2x2",  qty:1000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:131.23, uPrice:0.13123,conf:"high",  cap:"2026-04-17"},
  {qid:"1x1-1000-matte-paper-cmyk", pt:"roll_labels",comp:"vistaprint",size:"1x1",  qty:1000, mat:"White Paper",      finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:110.24, uPrice:0.12,   conf:"medium",cap:"2026-04-17"},
  {qid:"4x2-10000-matte-bopp-cmyk", pt:"roll_labels",comp:"uprinting", size:"4x2",  qty:10000,mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:683.03, uPrice:0.0683, conf:"high",  cap:"2026-04-17"},
  {qid:"2x2-10000-matte-bopp-cmyk", pt:"roll_labels",comp:"uprinting", size:"2x2",  qty:10000,mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:400.00, uPrice:0.04,   conf:"high",  cap:"2026-04-17"},
  {qid:"up-2x3-1000-matte-bopp",    pt:"roll_labels",comp:"uprinting", size:"2x3",  qty:1000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:95.87,  uPrice:0.09587,conf:"high",  cap:"2026-04-17"},
  {qid:"up-2x3-5000-matte-bopp",    pt:"roll_labels",comp:"uprinting", size:"2x3",  qty:5000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:204.27, uPrice:0.04085,conf:"high",  cap:"2026-04-17"},
  {qid:"up-4x4-1000-matte-bopp",    pt:"roll_labels",comp:"uprinting", size:"4x4",  qty:1000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:268.21, uPrice:0.26821,conf:"high",  cap:"2026-04-17"},
  {qid:"up-4x4-5000-matte-bopp",    pt:"roll_labels",comp:"uprinting", size:"4x4",  qty:5000, mat:"White BOPP",       finish:"matte",lam:null,uv:null,foil:null, shape:null,     price:789.05, uPrice:0.15781,conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-2x3-250-bopp",        pt:"roll_labels",comp:"axiomprint",size:"2x3",  qty:250,  mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:112.68, uPrice:0.4507, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-2x3-500-bopp",        pt:"roll_labels",comp:"axiomprint",size:"2x3",  qty:500,  mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:124.76, uPrice:0.2495, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-2x3-1000-bopp",       pt:"roll_labels",comp:"axiomprint",size:"2x3",  qty:1000, mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:148.32, uPrice:0.1483, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-2x3-2500-bopp",       pt:"roll_labels",comp:"axiomprint",size:"2x3",  qty:2500, mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:213.27, uPrice:0.0853, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-3x4-250-bopp",        pt:"roll_labels",comp:"axiomprint",size:"3x4",  qty:250,  mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:120.28, uPrice:0.4811, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-3x4-500-bopp",        pt:"roll_labels",comp:"axiomprint",size:"3x4",  qty:500,  mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:139.45, uPrice:0.2789, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-3x4-1000-bopp",       pt:"roll_labels",comp:"axiomprint",size:"3x4",  qty:1000, mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:176.67, uPrice:0.1767, conf:"high",  cap:"2026-04-17"},
  {qid:"axiom-3x4-2500-bopp",       pt:"roll_labels",comp:"axiomprint",size:"3x4",  qty:2500, mat:"White Matte BOPP", finish:"matte",lam:null,uv:null,foil:null, shape:"rect",   price:277.76, uPrice:0.1111, conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-100-gloss-bopp-cmyk",   pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:100,  mat:"White BOPP",       finish:"gloss",lam:null,uv:null,foil:false,shape:"rounded",price:76.28,  uPrice:0.7628, conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-250-gloss-bopp-cmyk",   pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:250,  mat:"White BOPP",       finish:"gloss",lam:null,uv:null,foil:false,shape:"rounded",price:86.16,  uPrice:0.34464,conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-500-gloss-bopp-cmyk",   pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:500,  mat:"White BOPP",       finish:"gloss",lam:null,uv:null,foil:false,shape:"rounded",price:123.00, uPrice:0.246,  conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-2500-gloss-bopp-cmyk",  pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:2500, mat:"White BOPP",       finish:"gloss",lam:null,uv:null,foil:false,shape:"rounded",price:226.86, uPrice:0.09074,conf:"high",  cap:"2026-04-17"},
  {qid:"3x3-10000-gloss-bopp-cmyk", pt:"roll_labels",comp:"gotprint",  size:"3x3",  qty:10000,mat:"White BOPP",       finish:"gloss",lam:null,uv:null,foil:false,shape:"rounded",price:618.83, uPrice:0.06188,conf:"high",  cap:"2026-04-17"},
  // Folding Cartons ─────────────────────────────────────────────────────────
  {qid:"box-ste-4x2x5-250-18pt-gloss", pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:250, mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:675.00, uPrice:2.70,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-250-18pt-gloss", pt:"folding_cartons",comp:"packola",  size:"4x2x5",qty:250, mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:717.50, uPrice:2.87,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-500-18pt-gloss", pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:500, mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:1180.00,uPrice:2.36,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-500-18pt-gloss", pt:"folding_cartons",comp:"packola",  size:"4x2x5",qty:500, mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:1255.00,uPrice:2.51,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-1000-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:1000,mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:1690.00,uPrice:1.69,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-1000-18pt-gloss",pt:"folding_cartons",comp:"packola",  size:"4x2x5",qty:1000,mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:1800.00,uPrice:1.80,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2000-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:2000,mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:2020.00,uPrice:1.01,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2000-18pt-gloss",pt:"folding_cartons",comp:"packola",  size:"4x2x5",qty:2000,mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:2160.00,uPrice:1.08,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2500-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:2500,mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:2250.00,uPrice:0.90,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2500-18pt-gloss",pt:"folding_cartons",comp:"packola",  size:"4x2x5",qty:2500,mat:"18pt SBS",finish:"gloss",lam:null,uv:null,foil:null,shape:null,price:2400.00,uPrice:0.96,conf:"high",cap:"2026-04-17"},
  // Stand-up Pouches ────────────────────────────────────────────────────────
  {qid:"pouch-sup-4375x6-100-white", pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:100, mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:434.67, uPrice:4.347,conf:"high",  cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-250-white", pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:250, mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:505.87, uPrice:2.023,conf:"high",  cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-250-white", pt:"stand_up_pouches",comp:"packola",  size:"4.375x6",qty:250, mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:421.51, uPrice:1.69, conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-500-white", pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:500, mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:630.22, uPrice:1.26, conf:"high",  cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-500-white", pt:"stand_up_pouches",comp:"packola",  size:"4.375x6",qty:500, mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:462.76, uPrice:0.93, conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-1000-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:1000,mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:897.26, uPrice:0.897,conf:"high",  cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-1000-white",pt:"stand_up_pouches",comp:"packola",  size:"4.375x6",qty:1000,mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:545.29, uPrice:0.55, conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-2500-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:2500,mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:1664.25,uPrice:0.666,conf:"high",  cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-2500-white",pt:"stand_up_pouches",comp:"packola",  size:"4.375x6",qty:2500,mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:792.83, uPrice:0.32, conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-5000-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:5000,mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:2941.00,uPrice:0.588,conf:"high",  cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-5000-white",pt:"stand_up_pouches",comp:"packola",  size:"4.375x6",qty:5000,mat:"Thick Gauge White",finish:null,lam:null,uv:null,foil:null,shape:null,price:1205.42,uPrice:0.24, conf:"medium",cap:"2026-04-17"},
];

// Map Pulse UI product type names → benchmark product_type keys
const BENCHMARK_PT_MAP = {
  'Labels (Roll)':          'roll_labels',
  'Diecut Stickers':        'roll_labels',   // similar spec range — directional only
  'Pouches':                'stand_up_pouches',
  'Folding Cartons / Boxes':'folding_cartons',
};

const COMP_DISPLAY = {
  uprinting:   'UPrinting',
  vistaprint:  'Vistaprint',
  gotprint:    'GotPrint',
  packola:     'Packola',
  axiomprint:  'Axiom',
  stickermule: 'Sticker Mule',
};

// All competitors tracked in our universe (for "Not captured" rows)
const KNOWN_COMPETITORS = ['uprinting', 'gotprint', 'vistaprint', 'packola', 'axiomprint'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _parseSize(s) {
  if (!s) return null;
  const parts = s.replace(/"/g, '').split('x');
  const w = parseFloat(parts[0]);
  const h = parseFloat(parts[1]);
  return { w: isNaN(w) ? null : w, h: isNaN(h) ? null : h };
}

/**
 * Collapse common material synonyms to a canonical token for comparison.
 */
function _normalizeMaterial(s) {
  if (!s) return null;
  const l = s.toLowerCase().trim();
  if (l.includes('bopp') || l.includes('polypropylene')) return 'bopp';
  if (l.includes('paper') || l.includes('kraft'))         return 'paper';
  if (l.includes('sbs') || l.includes('18pt') || l.includes('carton') || l.includes('cardstock')) return 'cardstock';
  if (l.includes('thick gauge') || l.includes('pouch'))   return 'pouch-white';
  if (l.includes('polyester') || l.includes('pet'))       return 'polyester';
  return l;
}

/**
 * Compute staleness tier from a capture date string (YYYY-MM-DD).
 * Tiers: 0–14d = fresh · 15–90d = dated · 90+d = stale
 */
function _staleness(capDate) {
  if (!capDate) return 'stale';
  const today   = new Date();
  const ageDays = Math.floor((today - new Date(capDate)) / 86400000);
  if (ageDays <= 14) return 'fresh';
  if (ageDays <= 90) return 'dated';
  return 'stale';
}

function _captureAgeDays(capDate) {
  if (!capDate) return null;
  return Math.floor((new Date() - new Date(capDate)) / 86400000);
}

// ─── Per-row scoring ─────────────────────────────────────────────────────────

/**
 * Score a single dataset row against the user's input spec.
 * Returns { score, mismatchReasons }.  Lower score = better match.
 *
 * Scoring weights:
 *   qty:           × 1.5  (log₂ factor distance — major driver)
 *   size:          × 1.0  (log₂ area ratio)
 *   material:      + 1.5  (material class mismatch)
 *   finish:        + 0.8  (finish mismatch when both sides are known)
 *   lam:           + 0.8  (lamination mismatch when both sides are known)
 *   uv:            + 0.5 if not captured, +1.5 if not supported
 *   foil:          + 0.5 if not captured, +1.5 if not supported
 *   shape:         + 0.5  (shape mismatch when both sides are known)
 *   qty-out-range: flagged when userQty > 5× the benchmark qty (TC7)
 */
function _scoreRow(row, userArea, userQty, specs) {
  const { material, finish, lamination, uv, foil, shape } = specs || {};
  const mismatchReasons = [];
  let score = 0;

  // Quantity: log₂ distance — penalises being off by a factor
  const qtyRatio = Math.max(userQty, row.qty) / Math.min(userQty, row.qty);
  score += Math.abs(Math.log2(qtyRatio)) * 1.5;

  // Outside captured range: userQty more than 5× away from nearest data point
  if (qtyRatio > 5) {
    mismatchReasons.push('qty-outside-range');
  }

  // Size: log₂ area ratio
  if (userArea) {
    const s = _parseSize(row.size);
    if (s && s.w && s.h) {
      const benchArea = s.w * s.h;
      score += Math.abs(Math.log2(Math.max(userArea, benchArea) / Math.min(userArea, benchArea)));
    } else {
      score += 0.5; // unknown benchmark size — mild penalty
    }
  }

  // Material
  if (material) {
    const uMat = _normalizeMaterial(material);
    const rMat = _normalizeMaterial(row.mat);
    if (rMat && uMat !== rMat) {
      score += 1.5;
      mismatchReasons.push('material');
    }
  }

  // Finish — only penalise when both sides are known
  if (finish && row.finish !== null) {
    if (row.finish !== finish) {
      score += 0.8;
      mismatchReasons.push('finish');
    }
  }

  // Lamination — normalise user value for comparison
  if (lamination && lamination !== 'None' && row.lam !== null) {
    const uLam = lamination.toLowerCase().replace(/\s+lam(ination)?$/, '').replace(/\s+/g, '-');
    if (row.lam !== uLam) {
      score += 0.8;
      mismatchReasons.push('lamination');
    }
  }

  // UV — only relevant when user explicitly requests UV
  if (uv) {
    if (row.uv === null) {
      score += 0.5;
      mismatchReasons.push('uv-not-captured');
    } else if (row.uv === 'none') {
      score += 1.5;
      mismatchReasons.push('uv-not-supported');
    }
    // row.uv === 'spot'|'full' → exact match, no penalty
  }

  // Foil — only relevant when user explicitly requests foil
  if (foil) {
    if (row.foil === null) {
      score += 0.5;
      mismatchReasons.push('foil-not-captured');
    } else if (row.foil === false) {
      score += 1.5;
      mismatchReasons.push('foil-not-supported');
    }
    // row.foil === true → exact match, no penalty
  }

  // Shape — only penalise when both sides are known
  if (shape && row.shape !== null) {
    if (row.shape !== shape) {
      score += 0.5;
      mismatchReasons.push('shape');
    }
  }

  return { score, mismatchReasons };
}

/**
 * Classify match quality for a competitor's winning row.
 * 'exact'       — qty ≤ 1.3×, size ≤ 1.5× area, no mismatch reasons
 * 'close'       — qty ≤ 3×, size ≤ 1.5×, only soft flags (not-captured UV)
 * 'approximate' — hard spec mismatch, size/qty far off, or outside captured range
 */
function _perCompMatchQuality(row, userArea, userQty, mismatchReasons) {
  const qtyRatio = Math.max(userQty, row.qty) / Math.min(userQty, row.qty);

  const sizeClose = userArea ? (() => {
    const s = _parseSize(row.size);
    if (!s || !s.w || !s.h) return false;
    return Math.max(userArea, s.w * s.h) / Math.min(userArea, s.w * s.h) <= 1.5;
  })() : true;

  const hardMismatches = mismatchReasons.filter(r => HARD_MISMATCHES.has(r));

  if (hardMismatches.length > 0 || qtyRatio > 3 || !sizeClose) return 'approximate';
  if (qtyRatio <= 1.3 && mismatchReasons.length === 0)           return 'exact';
  return 'close';
}

// ─── Competitor capability view ───────────────────────────────────────────────

/**
 * Derive competitor capability status from normalized capture data.
 * Returns: 'supported' | 'stale-support' | 'not-offered' | 'not-captured'
 *   supported     — competitor has ≥1 capture with feature within 90 days
 *   stale-support — capture exists but >90 days old
 *   not-offered   — capture exists with feature explicitly = none/false
 *   not-captured  — no capture record for this feature at all
 */
function _deriveCapabilities(comp) {
  const rows   = BENCHMARK_ROWS.filter(r => r.comp === comp);
  const today  = new Date();
  const recent = (capDate) => capDate && (today - new Date(capDate)) <= 90 * 86400000;

  function featureStatus(hasFeature, anyRecorded) {
    if (rows.some(r => recent(r.cap) && hasFeature(r))) return 'supported';
    if (rows.some(r => hasFeature(r)))                   return 'stale-support';
    if (rows.some(r => anyRecorded(r)))                  return 'not-offered';
    return 'not-captured';
  }

  return {
    uv:   featureStatus(r => r.uv   && r.uv !== 'none',  r => r.uv   !== null),
    foil: featureStatus(r => r.foil === true,              r => r.foil !== null),
  };
}

// ─── lookupBenchmark() ────────────────────────────────────────────────────────

/**
 * Per-competitor spec-aware benchmark lookup.
 *
 * Each competitor independently scores all of its rows and picks the single
 * best-matching one. Returns a per-competitor result array with full mismatch
 * transparency, staleness tier, match quality, and "not captured" rows.
 *
 * @param {string}      productType
 * @param {number|null} widthIn
 * @param {number|null} heightIn
 * @param {number|null} quantity
 * @param {object|null} specs  — { material, finish, lamination, uv, foil, shape }
 * @returns {object|null}
 */
function lookupBenchmark(productType, widthIn, heightIn, quantity, specs) {
  const benchPT = BENCHMARK_PT_MAP[productType];
  if (!benchPT) return null;

  const candidates = BENCHMARK_ROWS.filter(r => r.pt === benchPT);
  if (!candidates.length) return null;

  const userArea  = (widthIn && heightIn) ? widthIn * heightIn : null;
  const userQty   = quantity || 1;
  const safeSpecs = specs || {};

  // ── Per-competitor independent scoring ───────────────────────────────────
  const competitorResults = [];

  KNOWN_COMPETITORS.forEach(comp => {
    const compRows = candidates.filter(r => r.comp === comp);

    if (!compRows.length) {
      // Competitor tracked but has no data for this product type → TC5
      competitorResults.push({
        comp,
        notCaptured:  true,
        capabilities: _deriveCapabilities(comp),
      });
      return;
    }

    // Score every row; pick the lowest-score one as the best match
    let bestRow = null, bestScore = Infinity, bestMismatches = [];
    compRows.forEach(row => {
      const { score, mismatchReasons } = _scoreRow(row, userArea, userQty, safeSpecs);
      if (score < bestScore) {
        bestScore      = score;
        bestRow        = row;
        bestMismatches = mismatchReasons;
      }
    });

    const staleness = _staleness(bestRow.cap);
    const matchQual = _perCompMatchQuality(bestRow, userArea, userQty, bestMismatches);

    competitorResults.push({
      comp,
      notCaptured:        false,
      price:              bestRow.price,
      uPrice:             bestRow.uPrice,
      conf:               bestRow.conf,
      matchedSpec: {
        size:   bestRow.size,
        qty:    bestRow.qty,
        mat:    bestRow.mat,
        finish: bestRow.finish,
        lam:    bestRow.lam,
        uv:     bestRow.uv,
        foil:   bestRow.foil,
        shape:  bestRow.shape,
      },
      matchScore:         bestScore,
      matchQuality:       matchQual,        // 'exact' | 'close' | 'approximate'
      mismatchReasons:    bestMismatches,
      isApproximateMatch: matchQual === 'approximate',
      staleness,                            // 'fresh' | 'dated' | 'stale'
      captureDate:        bestRow.cap,
      captureAgeDays:     _captureAgeDays(bestRow.cap),
      capabilities:       _deriveCapabilities(comp),
    });
  });

  // ── Market average ────────────────────────────────────────────────────────
  // Use fresh, priced, non-approximate matches for the avg. Fall back to all
  // priced if no fresh/close results are available.
  const priced     = competitorResults.filter(r => !r.notCaptured);
  const goodForAvg = priced.filter(r => r.staleness === 'fresh' && r.matchQuality !== 'approximate');
  const avgSource  = goodForAvg.length >= 1 ? goodForAvg : priced;
  const marketAvg  = avgSource.length
    ? avgSource.reduce((s, r) => s + r.price, 0) / avgSource.length
    : null;
  const limitedData = avgSource.length <= 1;

  // Sort: priced rows by price asc, then not-captured rows
  const sortedPriced    = [...priced].sort((a, b) => a.price - b.price);
  const notCapturedRows = competitorResults.filter(r => r.notCaptured);

  return {
    productType: benchPT,
    userSpec: { widthIn, heightIn, quantity, ...safeSpecs },
    competitors: [...sortedPriced, ...notCapturedRows],
    marketAvg,
    limitedData,
  };
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function _fmt(n) {
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtDim(w, h) {
  if (!w && !h) return null;
  if (w && h)   return `${w}×${h}"`;
  return w ? `${w}"` : `${h}"`;
}

function _capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Badge showing match quality per competitor row. */
function _matchQualityBadge(quality) {
  if (quality === 'exact')
    return '<span style="color:#16a34a;font-size:10px;font-weight:600;white-space:nowrap;">● Exact</span>';
  if (quality === 'close')
    return '<span style="color:#d97706;font-size:10px;font-weight:600;white-space:nowrap;">◑ Close</span>';
  return '<span style="color:#dc2626;font-size:10px;font-weight:600;white-space:nowrap;">△ Approx</span>';
}

/** Staleness badge — empty for fresh data. */
function _stalenessBadge(c) {
  if (c.staleness === 'fresh') return '';
  if (c.staleness === 'dated')
    return `<span style="color:#94a3b8;font-size:10px;background:#f1f5f9;border-radius:4px;padding:1px 4px;">${c.captureAgeDays}d ago</span>`;
  return `<span style="color:#f97316;font-size:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:4px;padding:1px 5px;" title="Pricing may have changed — recapture recommended">⚠ ${c.captureAgeDays}d ago</span>`;
}

/**
 * Human-readable labels for mismatch reason codes.
 * Hard mismatches get red; soft flags get amber.
 */
const MISMATCH_LABELS = {
  'material':           'Material mismatch',
  'finish':             'Finish mismatch',
  'lamination':         'Lamination mismatch',
  'uv-not-captured':    'UV not captured — contact for UV pricing',
  'uv-not-supported':   'UV not available — price shown is base',
  'foil-not-captured':  'Foil not captured — contact for foil pricing',
  'foil-not-supported': 'Foil not available — price shown is base',
  'shape':              'Shape mismatch',
  'qty-outside-range':  'Outside captured range — qty not benchmarked at this scale',
};

const HARD_MISMATCHES = new Set([
  'material',
  'uv-not-supported',
  'foil-not-supported',
  'qty-outside-range',
]);

/** Inline disclosure block for a competitor row's mismatch reasons. */
function _mismatchDisclosure(mismatchReasons) {
  if (!mismatchReasons || !mismatchReasons.length) return '';
  const hasHard = mismatchReasons.some(r => HARD_MISMATCHES.has(r));
  const color   = hasHard ? '#dc2626' : '#92400e';
  const text    = mismatchReasons.map(r => MISMATCH_LABELS[r] || r).join(' · ');
  return `<div style="font-size:10px;color:${color};margin-top:2px;line-height:1.4;">${text}</div>`;
}

/** Short spec label for the matched row: "3×3 · White BOPP · Matte · 5,000 pcs" */
function _matchedSpecLabel(ms) {
  const parts = [];
  if (ms.size)   parts.push(ms.size.replace(/x/g, '×'));
  if (ms.mat)    parts.push(ms.mat);
  if (ms.finish) parts.push(_capitalize(ms.finish));
  if (ms.qty)    parts.push(Number(ms.qty).toLocaleString() + ' pcs');
  return parts.join(' · ');
}

/**
 * Build the "Benchmarked for:" header line from user inputs and specs.
 */
function _queryHeaderLine(widthIn, heightIn, quantity, specs) {
  const parts = [];
  const dimStr = _fmtDim(widthIn, heightIn);
  if (dimStr)   parts.push(dimStr);
  if (quantity) parts.push(Number(quantity).toLocaleString() + ' pcs');
  if (specs) {
    if (specs.material)   parts.push(specs.material);
    if (specs.finish)     parts.push(_capitalize(specs.finish));
    const lam = specs.lamination;
    if (lam && lam !== 'None') parts.push(lam);
    if (specs.uv)         parts.push('UV coating');
    if (specs.foil)       parts.push('Foil');
    if (specs.shape && specs.shape !== 'rect') parts.push(_capitalize(specs.shape));
  }
  return parts.length ? 'Benchmarked for: ' + parts.join(' · ') : null;
}

// ─── updateBenchmarkPanel() ──────────────────────────────────────────────────

/**
 * Build and inject the benchmark panel HTML into the given element.
 *
 * @param {string}      elementId
 * @param {string}      productType
 * @param {number|null} widthIn
 * @param {number|null} heightIn
 * @param {number|null} quantity
 * @param {number|null} bazaarTotal  — our quoted total (null = hide delta row)
 * @param {object|null} specs        — { material, finish, lamination, uv, foil, shape }
 */
function updateBenchmarkPanel(elementId, productType, widthIn, heightIn, quantity, bazaarTotal, specs) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const match = lookupBenchmark(productType, widthIn, heightIn, quantity, specs);

  if (!match || !match.competitors.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  el.style.display = '';

  const { competitors, marketAvg, limitedData } = match;
  const headerLine = _queryHeaderLine(widthIn, heightIn, quantity, specs);

  // ── Query header ─────────────────────────────────────────────────────────
  const headerHTML = headerLine
    ? `<div style="font-size:11px;color:#64748b;margin-bottom:8px;padding:5px 7px;background:#f8fafc;border-radius:5px;border:1px solid #e2e8f0;">${headerLine}</div>`
    : '';

  // ── Per-competitor rows (priced) ──────────────────────────────────────────
  const pricedRows = competitors.filter(c => !c.notCaptured).map(c => {
    const specLabel      = _matchedSpecLabel(c.matchedSpec);
    const stalenessBadge = _stalenessBadge(c);
    const matchBadge     = _matchQualityBadge(c.matchQuality);
    const disclosure     = _mismatchDisclosure(c.mismatchReasons);

    return `
    <div style="padding:5px 0;border-bottom:1px solid #f1f5f9;">
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:4px 8px;align-items:baseline;font-size:12px;">
        <span style="font-weight:500;color:#374151;">${COMP_DISPLAY[c.comp] || c.comp}</span>
        <span style="font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums;">${_fmt(c.price)}</span>
        <span style="display:flex;gap:4px;align-items:center;">${matchBadge}${stalenessBadge ? '&nbsp;' + stalenessBadge : ''}</span>
      </div>
      ${specLabel ? `<div style="font-size:10px;color:#94a3b8;margin-top:1px;">${specLabel}</div>` : ''}
      ${disclosure}
    </div>`;
  }).join('');

  // ── Not-captured rows (TC5) ───────────────────────────────────────────────
  const notCapturedRows = competitors.filter(c => c.notCaptured).map(c => `
    <div style="padding:4px 0;border-bottom:1px solid #f1f5f9;">
      <div style="display:grid;grid-template-columns:1fr auto;gap:4px 8px;align-items:center;font-size:12px;">
        <span style="font-weight:500;color:#9ca3af;">${COMP_DISPLAY[c.comp] || c.comp}</span>
        <span style="font-size:10px;color:#9ca3af;font-style:italic;">Not captured</span>
      </div>
    </div>`).join('');

  // ── Market average ────────────────────────────────────────────────────────
  let avgRow = '';
  if (marketAvg) {
    const avgLabel = limitedData
      ? 'Market avg <span style="font-size:10px;color:#94a3b8;font-weight:400;">(limited data)</span>'
      : 'Market avg';
    avgRow = `
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:5px 0 2px;font-size:12px;font-weight:600;color:#374151;">
      <span>${avgLabel}</span>
      <span style="font-variant-numeric:tabular-nums;">${_fmt(marketAvg)}</span>
    </div>`;
  }

  // ── Our price delta ───────────────────────────────────────────────────────
  let deltaRow = '';
  if (bazaarTotal && bazaarTotal > 0 && marketAvg) {
    const deltaPct = ((bazaarTotal - marketAvg) / marketAvg) * 100;
    const absPct   = Math.abs(deltaPct).toFixed(0);
    let deltaColor, deltaSymbol;
    if (Math.abs(deltaPct) < 5)  { deltaColor = '#16a34a'; deltaSymbol = '≈ at market avg'; }
    else if (deltaPct > 30)      { deltaColor = '#dc2626'; deltaSymbol = `▲ ${absPct}% above avg`; }
    else if (deltaPct > 0)       { deltaColor = '#d97706'; deltaSymbol = `▲ ${absPct}% above avg`; }
    else                         { deltaColor = '#16a34a'; deltaSymbol = `▼ ${absPct}% below avg`; }
    deltaRow = `
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:2px 0 5px;border-bottom:2px solid #e2e8f0;font-size:12px;font-weight:700;">
      <span>Your total</span>
      <span style="color:var(--accent,#2563eb);font-variant-numeric:tabular-nums;">${_fmt(bazaarTotal)}</span>
    </div>
    <div style="font-size:12px;font-weight:700;color:${deltaColor};padding-top:4px;">${deltaSymbol}</div>`;
  }

  // ── Oldest capture date footer ────────────────────────────────────────────
  const oldestCapDate = competitors
    .filter(c => !c.notCaptured && c.captureDate)
    .reduce((oldest, c) => (!oldest || c.captureDate < oldest ? c.captureDate : oldest), null);

  el.innerHTML = `
<div style="margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
    <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;">📊 Market Benchmark</span>
    ${oldestCapDate ? `<span style="font-size:10px;color:#94a3b8;">${oldestCapDate}</span>` : ''}
  </div>
  ${headerHTML}
  ${pricedRows}
  ${notCapturedRows}
  ${avgRow}
  ${deltaRow}
  <div style="font-size:10px;color:#94a3b8;margin-top:6px;">Advisory only — turnaround &amp; shipping may differ.</div>
</div>`;
}
