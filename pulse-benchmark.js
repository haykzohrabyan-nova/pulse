/**
 * pulse-benchmark.js — Market Benchmark Panel for Pulse
 *
 * Looks up the captured competitor pricing dataset and renders a comparison
 * panel next to internal price totals. Works in pricing-calculator-sales.html
 * and quotes.html.
 *
 * Usage:
 *   updateBenchmarkPanel('benchmarkPanel', productType, widthIn, heightIn, quantity, bazaarTotal)
 *
 * productType must match a Pulse product type string (e.g. "Labels (Roll)").
 * widthIn / heightIn are label/item dimensions in inches (may be null).
 * quantity is the order quantity (number).
 * bazaarTotal is our quoted total price in dollars (may be null to hide delta).
 */

// ─── Inline dataset (from data/market-benchmark.json, captured 2026-04-17) ───

const BENCHMARK_ROWS = [
  // Roll Labels
  {qid:"3x3-5000-matte-bopp-cmyk",pt:"roll_labels",comp:"gotprint",size:"3x3",qty:5000,mat:"White BOPP",price:356.80,uPrice:0.07136,conf:"high",cap:"2026-04-17"},
  {qid:"3x3-5000-matte-bopp-cmyk",pt:"roll_labels",comp:"uprinting",size:"3x3",qty:5000,mat:"White BOPP",price:505.85,uPrice:0.1012,conf:"high",cap:"2026-04-17"},
  {qid:"3x3-5000-matte-bopp-cmyk",pt:"roll_labels",comp:"vistaprint",size:"3x3",qty:5000,mat:"White BOPP",price:544.86,uPrice:0.109,conf:"medium",cap:"2026-04-17"},
  {qid:"2x2-5000-matte-bopp-cmyk",pt:"roll_labels",comp:"uprinting",size:"2x2",qty:5000,mat:"White BOPP",price:309.16,uPrice:0.06183,conf:"high",cap:"2026-04-17"},
  {qid:"3x3-1000-matte-bopp-cmyk",pt:"roll_labels",comp:"uprinting",size:"3x3",qty:1000,mat:"White BOPP",price:222.26,uPrice:0.22226,conf:"high",cap:"2026-04-17"},
  {qid:"3x3-1000-matte-bopp-cmyk",pt:"roll_labels",comp:"gotprint",size:"3x3",qty:1000,mat:"White BOPP",price:148.91,uPrice:0.14891,conf:"high",cap:"2026-04-17"},
  {qid:"2x2-1000-matte-bopp-cmyk",pt:"roll_labels",comp:"uprinting",size:"2x2",qty:1000,mat:"White BOPP",price:131.23,uPrice:0.13123,conf:"high",cap:"2026-04-17"},
  {qid:"1x1-1000-matte-paper-cmyk",pt:"roll_labels",comp:"vistaprint",size:"1x1",qty:1000,mat:"White Paper",price:110.24,uPrice:0.12,conf:"medium",cap:"2026-04-17"},
  {qid:"4x2-10000-matte-bopp-cmyk",pt:"roll_labels",comp:"uprinting",size:"4x2",qty:10000,mat:"White BOPP",price:683.03,uPrice:0.0683,conf:"high",cap:"2026-04-17"},
  {qid:"2x2-10000-matte-bopp-cmyk",pt:"roll_labels",comp:"uprinting",size:"2x2",qty:10000,mat:"White BOPP",price:400.00,uPrice:0.04,conf:"high",cap:"2026-04-17"},
  {qid:"up-2x3-1000-matte-bopp",pt:"roll_labels",comp:"uprinting",size:"2x3",qty:1000,mat:"White BOPP",price:95.87,uPrice:0.09587,conf:"high",cap:"2026-04-17"},
  {qid:"up-2x3-5000-matte-bopp",pt:"roll_labels",comp:"uprinting",size:"2x3",qty:5000,mat:"White BOPP",price:204.27,uPrice:0.04085,conf:"high",cap:"2026-04-17"},
  {qid:"up-4x4-1000-matte-bopp",pt:"roll_labels",comp:"uprinting",size:"4x4",qty:1000,mat:"White BOPP",price:268.21,uPrice:0.26821,conf:"high",cap:"2026-04-17"},
  {qid:"up-4x4-5000-matte-bopp",pt:"roll_labels",comp:"uprinting",size:"4x4",qty:5000,mat:"White BOPP",price:789.05,uPrice:0.15781,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-2x3-250-bopp",pt:"roll_labels",comp:"axiomprint",size:"2x3",qty:250,mat:"White Matte BOPP",price:112.68,uPrice:0.4507,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-2x3-500-bopp",pt:"roll_labels",comp:"axiomprint",size:"2x3",qty:500,mat:"White Matte BOPP",price:124.76,uPrice:0.2495,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-2x3-1000-bopp",pt:"roll_labels",comp:"axiomprint",size:"2x3",qty:1000,mat:"White Matte BOPP",price:148.32,uPrice:0.1483,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-2x3-2500-bopp",pt:"roll_labels",comp:"axiomprint",size:"2x3",qty:2500,mat:"White Matte BOPP",price:213.27,uPrice:0.0853,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-3x4-250-bopp",pt:"roll_labels",comp:"axiomprint",size:"3x4",qty:250,mat:"White Matte BOPP",price:120.28,uPrice:0.4811,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-3x4-500-bopp",pt:"roll_labels",comp:"axiomprint",size:"3x4",qty:500,mat:"White Matte BOPP",price:139.45,uPrice:0.2789,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-3x4-1000-bopp",pt:"roll_labels",comp:"axiomprint",size:"3x4",qty:1000,mat:"White Matte BOPP",price:176.67,uPrice:0.1767,conf:"high",cap:"2026-04-17"},
  {qid:"axiom-3x4-2500-bopp",pt:"roll_labels",comp:"axiomprint",size:"3x4",qty:2500,mat:"White Matte BOPP",price:277.76,uPrice:0.1111,conf:"high",cap:"2026-04-17"},
  // Folding Cartons
  {qid:"box-ste-4x2x5-250-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:250,mat:"18pt SBS",price:675.00,uPrice:2.70,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-250-18pt-gloss",pt:"folding_cartons",comp:"packola",size:"4x2x5",qty:250,mat:"18pt SBS",price:717.50,uPrice:2.87,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-500-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:500,mat:"18pt SBS",price:1180.00,uPrice:2.36,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-500-18pt-gloss",pt:"folding_cartons",comp:"packola",size:"4x2x5",qty:500,mat:"18pt SBS",price:1255.00,uPrice:2.51,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-1000-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:1000,mat:"18pt SBS",price:1690.00,uPrice:1.69,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-1000-18pt-gloss",pt:"folding_cartons",comp:"packola",size:"4x2x5",qty:1000,mat:"18pt SBS",price:1800.00,uPrice:1.80,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2000-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:2000,mat:"18pt SBS",price:2020.00,uPrice:1.01,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2000-18pt-gloss",pt:"folding_cartons",comp:"packola",size:"4x2x5",qty:2000,mat:"18pt SBS",price:2160.00,uPrice:1.08,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2500-18pt-gloss",pt:"folding_cartons",comp:"uprinting",size:"4x2x5",qty:2500,mat:"18pt SBS",price:2250.00,uPrice:0.90,conf:"high",cap:"2026-04-17"},
  {qid:"box-ste-4x2x5-2500-18pt-gloss",pt:"folding_cartons",comp:"packola",size:"4x2x5",qty:2500,mat:"18pt SBS",price:2400.00,uPrice:0.96,conf:"high",cap:"2026-04-17"},
  // Stand-up Pouches
  {qid:"pouch-sup-4375x6-100-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:100,mat:"Thick Gauge White",price:434.67,uPrice:4.347,conf:"high",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-250-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:250,mat:"Thick Gauge White",price:505.87,uPrice:2.023,conf:"high",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-250-white",pt:"stand_up_pouches",comp:"packola",size:"4.375x6",qty:250,mat:"Thick Gauge White",price:421.51,uPrice:1.69,conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-500-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:500,mat:"Thick Gauge White",price:630.22,uPrice:1.26,conf:"high",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-500-white",pt:"stand_up_pouches",comp:"packola",size:"4.375x6",qty:500,mat:"Thick Gauge White",price:462.76,uPrice:0.93,conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-1000-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:1000,mat:"Thick Gauge White",price:897.26,uPrice:0.897,conf:"high",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-1000-white",pt:"stand_up_pouches",comp:"packola",size:"4.375x6",qty:1000,mat:"Thick Gauge White",price:545.29,uPrice:0.55,conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-2500-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:2500,mat:"Thick Gauge White",price:1664.25,uPrice:0.666,conf:"high",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-2500-white",pt:"stand_up_pouches",comp:"packola",size:"4.375x6",qty:2500,mat:"Thick Gauge White",price:792.83,uPrice:0.32,conf:"medium",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-5000-white",pt:"stand_up_pouches",comp:"uprinting",size:"4.375x6",qty:5000,mat:"Thick Gauge White",price:2941.00,uPrice:0.588,conf:"high",cap:"2026-04-17"},
  {qid:"pouch-sup-4375x6-5000-white",pt:"stand_up_pouches",comp:"packola",size:"4.375x6",qty:5000,mat:"Thick Gauge White",price:1205.42,uPrice:0.24,conf:"medium",cap:"2026-04-17"},
];

// Map Pulse UI product type names → benchmark product_type keys
const BENCHMARK_PT_MAP = {
  'Labels (Roll)':          'roll_labels',
  'Diecut Stickers':        'roll_labels',   // similar spec range
  'Pouches':                'stand_up_pouches',
  'Folding Cartons / Boxes':'folding_cartons',
};

const COMP_DISPLAY = {
  uprinting:  'UPrinting',
  vistaprint: 'Vistaprint',
  gotprint:   'GotPrint',
  packola:    'Packola',
  axiomprint: 'Axiom',
  stickermule:'Sticker Mule',
};

// ─── Matching ────────────────────────────────────────────────────────────────

function _parseSize(s) {
  if (!s) return null;
  const parts = s.replace(/"/g, '').split('x');
  const w = parseFloat(parts[0]);
  const h = parseFloat(parts[1]);
  return { w: isNaN(w) ? null : w, h: isNaN(h) ? null : h };
}

/**
 * Find the best-matching benchmark spec for the given inputs.
 * Returns null when no benchmark coverage exists for this product type.
 *
 * @param {string} productType  — Pulse product type label
 * @param {number|null} widthIn  — item width in inches (or null if unknown)
 * @param {number|null} heightIn — item height in inches (or null if unknown)
 * @param {number|null} quantity — order quantity (or null)
 * @returns {object|null} match result
 */
function lookupBenchmark(productType, widthIn, heightIn, quantity) {
  const benchPT = BENCHMARK_PT_MAP[productType];
  if (!benchPT) return null;

  const candidates = BENCHMARK_ROWS.filter(r => r.pt === benchPT);
  if (!candidates.length) return null;

  const userArea = (widthIn && heightIn) ? widthIn * heightIn : null;
  const userQty  = quantity || 1;

  // Score each unique query_id by how well it matches the user's spec.
  // Lower score = better match.
  const byQid = {};
  candidates.forEach(r => {
    if (!byQid[r.qid]) byQid[r.qid] = r; // first row per qid is representative
  });

  let bestQid = null, bestScore = Infinity;
  Object.entries(byQid).forEach(([qid, rep]) => {
    // Quantity score: log2 distance (penalises being off by a factor)
    const qtyScore = Math.abs(Math.log2(Math.max(userQty, rep.qty) / Math.min(userQty, rep.qty)));

    // Size score: log2 area ratio — 0 if no dimensions provided
    let sizeScore = 0;
    if (userArea) {
      const s = _parseSize(rep.size);
      if (s && s.w && s.h) {
        const benchArea = s.w * s.h;
        sizeScore = Math.abs(Math.log2(Math.max(userArea, benchArea) / Math.min(userArea, benchArea)));
      } else {
        sizeScore = 0.5; // unknown benchmark size — mild penalty
      }
    }

    const score = qtyScore * 1.5 + sizeScore;
    if (score < bestScore) { bestScore = score; bestQid = qid; }
  });

  if (!bestQid) return null;

  const repRow = byQid[bestQid];
  const matchedRows = candidates.filter(r => r.qid === bestQid);

  // Determine match quality
  const qtyRatio = userQty && repRow.qty
    ? Math.max(userQty, repRow.qty) / Math.min(userQty, repRow.qty)
    : 99;
  const sizeClose = userArea ? (() => {
    const s = _parseSize(repRow.size);
    if (!s || !s.w || !s.h) return false;
    const benchArea = s.w * s.h;
    const ratio = Math.max(userArea, benchArea) / Math.min(userArea, benchArea);
    return ratio <= 1.5; // within 50% area
  })() : true; // no size info — assume ok

  let matchQuality;
  if (qtyRatio <= 1.3 && sizeClose) matchQuality = 'exact';
  else if (qtyRatio <= 3 && sizeClose) matchQuality = 'directional';
  else matchQuality = 'loose';

  // Market average: prefer high-confidence rows; fall back to all priced
  const highConf = matchedRows.filter(r => r.conf === 'high');
  const avgSource = highConf.length >= 1 ? highConf : matchedRows;
  const marketAvg = avgSource.reduce((s, r) => s + r.price, 0) / avgSource.length;

  return {
    qid:         bestQid,
    size:        repRow.size,
    quantity:    repRow.qty,
    productType: repRow.pt,
    material:    repRow.mat,
    captureDate: repRow.cap,
    competitors: [...matchedRows].sort((a, b) => a.price - b.price),
    marketAvg,
    matchQuality,       // 'exact' | 'directional' | 'loose'
    bestScore,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function _fmt(n) {
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Staleness badge based on capture date string "YYYY-MM-DD"
function _stalenessInfo(capDate) {
  if (!capDate) return { daysAgo: null, badge: '' };
  const cap = new Date(capDate + 'T00:00:00');
  const daysAgo = Math.floor((Date.now() - cap.getTime()) / 86400000);
  if (daysAgo <= 14) {
    return { daysAgo, badge: '' }; // Fresh — no badge
  } else if (daysAgo <= 90) {
    return { daysAgo, badge: `<span style="font-size:10px;color:#92400e;background:#fef3c7;padding:1px 6px;border-radius:8px;" title="Captured ${daysAgo} days ago — verify before quoting">📅 ${daysAgo}d ago</span>` };
  } else {
    return { daysAgo, badge: `<span style="font-size:10px;color:#9a3412;background:#ffedd5;border:1px solid #fed7aa;padding:1px 6px;border-radius:8px;" title="Pricing may have changed — recapture recommended">⚠ ${daysAgo}d — Stale</span>` };
  }
}

// Per-competitor capture confidence badge
function _confBadge(conf) {
  if (conf === 'high')   return '<span style="font-size:10px;color:#16a34a;font-weight:600;">● Exact</span>';
  if (conf === 'medium') return '<span style="font-size:10px;color:#d97706;font-weight:600;">◑ Close</span>';
  return                        '<span style="font-size:10px;color:#9ca3af;font-weight:600;">○ Approx</span>';
}

// Overall query-to-benchmark match quality badge
function _matchQualityBadge(matchQuality) {
  if (matchQuality === 'exact')
    return '<span style="font-size:10px;font-weight:700;color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;padding:1px 8px;border-radius:10px;">✓ Exact match</span>';
  if (matchQuality === 'directional')
    return '<span style="font-size:10px;font-weight:700;color:#d97706;background:#fffbeb;border:1px solid #fde68a;padding:1px 8px;border-radius:10px;">≈ Close match</span>';
  return   '<span style="font-size:10px;font-weight:700;color:#9a3412;background:#ffedd5;border:1px solid #fdba74;padding:1px 8px;border-radius:10px;">~ Approximate</span>';
}

/**
 * Build and inject the benchmark panel HTML into the element with the given id.
 *
 * @param {string} elementId    — DOM element id to inject into
 * @param {string} productType  — Pulse product type
 * @param {number|null} widthIn
 * @param {number|null} heightIn
 * @param {number|null} quantity
 * @param {number|null} bazaarTotal — our quoted total (null = hide delta row)
 * @param {object} [opts]       — optional transparency hints: { material, lamination, uv, colorMode }
 */
function updateBenchmarkPanel(elementId, productType, widthIn, heightIn, quantity, bazaarTotal, opts = {}) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const match = lookupBenchmark(productType, widthIn, heightIn, quantity);

  if (!match || !match.competitors.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  el.style.display = '';

  const { competitors, marketAvg, matchQuality, size, quantity: benchQty, material: benchMat } = match;

  // ── Query header ─────────────────────────────────────────────────────────
  const queryParts = [];
  if (widthIn && heightIn) queryParts.push(`${widthIn}"×${heightIn}"`);
  if (quantity) queryParts.push(`${Number(quantity).toLocaleString()} pcs`);
  if (opts.material) queryParts.push(opts.material);
  if (opts.lamination) queryParts.push(`${opts.lamination} Lam`);
  if (opts.uv) queryParts.push('UV Coat');
  const queryLine = queryParts.length ? `Benchmarked for: ${queryParts.join(' · ')}` : '';

  // ── Mismatch disclosure ───────────────────────────────────────────────────
  const mismatches = [];
  if (widthIn && heightIn && size) {
    const s = _parseSize(size);
    if (s && s.w && s.h) {
      const areaRatio = Math.max(widthIn * heightIn, s.w * s.h) / Math.min(widthIn * heightIn, s.w * s.h);
      if (areaRatio > 1.15) {
        mismatches.push(`Size: benchmark is ${size.replace(/x/g,'×')}" (queried ${widthIn}"×${heightIn}")`);
      }
    }
  }
  if (quantity && benchQty) {
    const qtyRatio = Math.max(quantity, benchQty) / Math.min(quantity, benchQty);
    if (qtyRatio > 1.5) {
      mismatches.push(`Qty: benchmark is ${Number(benchQty).toLocaleString()} (queried ${Number(quantity).toLocaleString()})`);
    }
  }
  if (opts.material && benchMat) {
    const userMatKey = opts.material.toLowerCase().split(' ')[0];
    if (!benchMat.toLowerCase().includes(userMatKey)) {
      mismatches.push(`Material: benchmark uses ${benchMat}`);
    }
  }

  let mismatchHtml = '';
  if (mismatches.length === 1) {
    mismatchHtml = `<div style="font-size:11px;color:#92400e;margin-top:3px;margin-bottom:2px;">Close match — ${mismatches[0]}</div>`;
  } else if (mismatches.length >= 2) {
    const bullets = mismatches.slice(0, 4).map(m => `<li style="margin-bottom:1px;">${m}</li>`).join('');
    mismatchHtml = `<div style="font-size:11px;color:#92400e;margin-top:3px;"><ul style="margin:2px 0 0 14px;padding:0;">${bullets}</ul></div>`;
  }

  // ── Odd size disclosure ───────────────────────────────────────────────────
  let oddSizeNote = '';
  if (widthIn && heightIn && size) {
    const s = _parseSize(size);
    if (s && s.w && s.h && (widthIn !== s.w || heightIn !== s.h)) {
      oddSizeNote = `<div style="font-size:10px;color:#6b7280;margin-top:4px;">Non-standard size (${widthIn}"×${heightIn}"). Nearest benchmark: ${size.replace(/x/g,'×')}".</div>`;
    }
  }

  // ── Per-competitor rows ───────────────────────────────────────────────────
  const compRows = competitors.map(r => {
    const { badge: staleBadge } = _stalenessInfo(r.cap);
    return `
    <div style="padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span style="font-weight:600;font-size:12px;color:#374151;">${COMP_DISPLAY[r.comp] || r.comp}</span>
        <span style="font-weight:700;font-size:13px;color:#0f172a;font-variant-numeric:tabular-nums;">${_fmt(r.price)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap;">
        <span style="font-size:10px;color:#94a3b8;">${r.size.replace(/x/g,'×')}" · ${Number(r.qty).toLocaleString()} · ${r.mat}</span>
        ${_confBadge(r.conf)}
        ${staleBadge}
      </div>
    </div>`;
  }).join('');

  // ── Market avg / limited data note ───────────────────────────────────────
  const compCount = competitors.length;
  const avgLabel = compCount === 1 ? 'Listed price (limited data)' : 'Market avg';
  const avgRow = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0 2px;font-size:12px;font-weight:600;color:#374151;">
      <span>${avgLabel}</span>
      <span style="font-variant-numeric:tabular-nums;">${_fmt(marketAvg)}</span>
    </div>`;
  const limitedNote = compCount === 1
    ? '<div style="font-size:10px;color:#9ca3af;font-style:italic;margin-bottom:2px;">Only 1 competitor captured — avg not meaningful.</div>'
    : '';

  // ── Our price delta row ───────────────────────────────────────────────────
  let deltaRow = '';
  if (bazaarTotal && bazaarTotal > 0 && marketAvg) {
    const deltaPct = ((bazaarTotal - marketAvg) / marketAvg) * 100;
    const absPct   = Math.abs(deltaPct).toFixed(0);
    let deltaColor, deltaSymbol;
    if (Math.abs(deltaPct) < 5) {
      deltaColor = '#16a34a'; deltaSymbol = '≈ at market avg';
    } else if (deltaPct > 30) {
      deltaColor = '#dc2626'; deltaSymbol = `▲ ${absPct}% above avg`;
    } else if (deltaPct > 0) {
      deltaColor = '#d97706'; deltaSymbol = `▲ ${absPct}% above avg`;
    } else {
      deltaColor = '#16a34a'; deltaSymbol = `▼ ${absPct}% below avg`;
    }
    deltaRow = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 0 5px;border-bottom:2px solid #e2e8f0;font-size:12px;font-weight:700;">
      <span>Your total</span>
      <span style="color:var(--accent,#2563eb);font-variant-numeric:tabular-nums;">${_fmt(bazaarTotal)}</span>
    </div>
    <div style="font-size:12px;font-weight:700;color:${deltaColor};padding-top:4px;">${deltaSymbol}</div>`;
  }

  el.innerHTML = `
<div style="margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
    <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;">📊 Market Benchmark</span>
    ${_matchQualityBadge(matchQuality)}
  </div>
  ${queryLine ? `<div style="font-size:11px;color:#64748b;margin-bottom:4px;">${queryLine}</div>` : ''}
  ${mismatchHtml}
  ${oddSizeNote}
  <div style="margin-top:4px;">${compRows}</div>
  ${avgRow}
  ${limitedNote}
  ${deltaRow}
  <div style="font-size:10px;color:#94a3b8;margin-top:6px;">Advisory only — turnaround &amp; shipping may differ.</div>
</div>`;
}
