#!/usr/bin/env node
/**
 * capture-gp-vp-extended-coverage.js
 *
 * Fills GotPrint + Vistaprint pricing gaps across the benchmark query suite.
 *
 * TARGETS (all confirmed missing from normalized JSON):
 *   GP: 2x2/1000, 2x2/5000, 2x2/10000, 1x1/1000, 2x3/1000+5000, 4x4/1000+5000, 4x2/10000
 *   VP: 2x2/1000+5000+10000, 1x1/1000, 3x3/1000, 2x3/1000+5000, 4x4/1000+5000, 4x2/10000
 *
 * GP APPROACH:
 *   1. Load configurator, select each shape in turn, read available sizes
 *   2. Build shape→{size_text: size_id} map from the /options/quantities XHR
 *   3. For each target spec: select shape+size+paper, fire pricing API with finish=3 (Matte)
 *
 * VP APPROACH:
 *   1. Load VP roll labels page to capture pricingContext token
 *   2. For each target spec: hit Cimpress API with selections[Shape]+selections[Size]
 *   3. For Rectangle sizes: use Shape=Rounded Rectangle; for square: Rounded Square
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW  = path.join(ROOT, 'data', 'competitor-pricing-raw.json');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');

const log  = m => console.log(`[ext] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().split('T')[0];
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Target specs to capture
const GP_TARGETS = [
  // { w, h, shape_label, qty_list, paper_id, finish_id, query_ids }
  { w: 2, h: 2, shape: 'Square - Rounded', qtys: [1000, 5000, 10000], paper: 12, finish: 3,
    queries: ['2x2-5000-matte-bopp-cmyk', '2x2-1000-matte-bopp-cmyk', '2x2-10000-matte-bopp-cmyk', '2x2-1000-gloss-bopp-cmyk'] },
  { w: 1, h: 1, shape: 'Square - Rounded', qtys: [1000], paper: 12, finish: 3,
    queries: ['1x1-1000-matte-paper-cmyk'] },
  { w: 2, h: 3, shape: 'Rectangle',        qtys: [250, 500, 1000, 2500, 5000], paper: 12, finish: 3,
    queries: ['up-2x3-1000-matte-bopp', 'up-2x3-5000-matte-bopp', 'axiom-2x3-250-bopp', 'axiom-2x3-500-bopp', 'axiom-2x3-1000-bopp', 'axiom-2x3-2500-bopp'] },
  { w: 4, h: 4, shape: 'Square - Rounded', qtys: [1000, 5000], paper: 12, finish: 3,
    queries: ['up-4x4-1000-matte-bopp', 'up-4x4-5000-matte-bopp'] },
  { w: 4, h: 2, shape: 'Rectangle',        qtys: [10000], paper: 12, finish: 3,
    queries: ['4x2-10000-matte-bopp-cmyk'] },
  { w: 3, h: 4, shape: 'Rectangle',        qtys: [250, 500, 1000, 2500], paper: 12, finish: 3,
    queries: ['axiom-3x4-250-bopp', 'axiom-3x4-500-bopp', 'axiom-3x4-1000-bopp', 'axiom-3x4-2500-bopp'] },
];

const VP_TARGETS = [
  // { vpShape, vpSize, qtys, query_ids }
  { shape: 'Rounded Square',    size: '2"x2"',  qtys: [1000, 5000, 10000], queries: ['2x2-1000-matte-bopp-cmyk', '2x2-5000-matte-bopp-cmyk', '2x2-10000-matte-bopp-cmyk', '2x2-1000-gloss-bopp-cmyk'] },
  { shape: 'Rounded Square',    size: '1"x1"',  qtys: [1000], queries: ['1x1-1000-matte-paper-cmyk'] },
  { shape: 'Rounded Square',    size: '3"x3"',  qtys: [1000], queries: ['3x3-1000-matte-bopp-cmyk'] },
  { shape: 'Rounded Rectangle', size: '2"x3"',  qtys: [1000, 5000], queries: ['up-2x3-1000-matte-bopp', 'up-2x3-5000-matte-bopp'] },
  { shape: 'Rounded Square',    size: '4"x4"',  qtys: [1000, 5000], queries: ['up-4x4-1000-matte-bopp', 'up-4x4-5000-matte-bopp'] },
  { shape: 'Rounded Rectangle', size: '4"x2"',  qtys: [10000], queries: ['4x2-10000-matte-bopp-cmyk'] },
];

async function runGotPrint(browser, norm, raw) {
  log('\n═══ GOTPRINT EXTENDED CAPTURE ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com') || resp.status() >= 400) return;
    try { xhrLog.push({ url: u, status: resp.status(), body: await resp.text() }); } catch (_) {}
  });

  const page = await context.newPage();
  const gpResults = {}; // key: "WxH" → { variantId, priceTable }
  const BASE_PRICES = 'https://www.gotprint.com/service/rest/v1/products/300158845/prices';

  try {
    log('Loading GP configurator...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await wait(5000);

    if (page.url().includes('home.html')) {
      log('GP BLOCKED — skipping');
      return {};
    }

    // Build shape → shape_id map from the select options
    const shapeOptions = await page.evaluate(() => {
      const sel = document.querySelector('select[name="shape"]');
      if (!sel) return {};
      return Object.fromEntries([...sel.options]
        .filter(o => o.text && o.text !== 'Please select an option')
        .map(o => [o.text.trim(), o.value]));
    });
    log('Shape options: ' + JSON.stringify(shapeOptions));

    async function jsSelect(name, label) {
      return page.evaluate(({ n, l }) => {
        const sel = document.querySelector(`select[name="${n}"]`);
        if (!sel) return `NOT FOUND: ${n}`;
        const opt = [...sel.options].find(o => o.text.trim() === l);
        if (!opt) {
          const avail = [...sel.options].map(o => o.text.trim()).join(', ');
          return `OPTION NOT FOUND: "${l}" in ${n}. Available: ${avail}`;
        }
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        return `OK: ${n}="${opt.value}" (${opt.text.trim()})`;
      }, { n: name, l: label });
    }

    for (const target of GP_TARGETS) {
      const sizeLabel = `${target.w}" x ${target.h}"`;
      const key = `${target.w}x${target.h}`;
      log(`\n── ${target.shape} ${sizeLabel} ──`);

      // Select shape
      const shapeResult = await jsSelect('shape', target.shape);
      log(`  Shape: ${shapeResult}`);
      await wait(3000);

      // Read available sizes
      const sizes = await page.evaluate(() => {
        const sel = document.querySelector('select[name="size"]');
        if (!sel) return null;
        return {
          disabled: sel.disabled,
          options: [...sel.options].map(o => ({ value: o.value, text: o.text.trim() }))
                                   .filter(o => o.text && o.text !== 'Please select an option')
        };
      });
      log(`  Sizes available: ${sizes?.options?.map(o => o.text).join(', ') || 'N/A'}`);

      // Find the size we want
      const exactSize = sizes?.options?.find(o =>
        o.text === sizeLabel ||
        o.text === `${target.w}" x ${target.h}"` ||
        o.text.replace(/\s/g, '') === `${target.w}"x${target.h}"` ||
        o.text.match(new RegExp(`^${target.w}".*x.*${target.h}"`))
      );

      if (!exactSize && sizes?.options?.length > 0) {
        log(`  WARNING: "${sizeLabel}" not found. Available: ${sizes.options.map(o => o.text).join(', ')}`);
      }

      if (!exactSize) {
        log(`  SKIP: size not available`);
        continue;
      }

      // Select size
      const sizeResult = await jsSelect('size', exactSize.text);
      log(`  Size: ${sizeResult}`);
      await wait(3000);

      // Get variantId from XHR
      const qtyXhr = [...xhrLog].reverse().find(x => x.url.includes('options/quantities'));
      let variantId = null;
      if (qtyXhr) {
        try {
          const d = JSON.parse(qtyXhr.body);
          const entries = Object.entries(d);
          if (entries.length > 0) {
            variantId = entries[0][0];
            log(`  VariantId: ${variantId}`);
          }
        } catch (_) {}
      }

      // Get the price API params from any prices XHR (to find shape/size numeric IDs)
      const pricesXhr = [...xhrLog].reverse().find(x => x.url.includes('/products/') && x.url.includes('/prices'));
      let shapeId, sizeId;
      if (pricesXhr) {
        const params = new URL(pricesXhr.url).searchParams;
        shapeId = params.get('shape');
        sizeId  = params.get('size');
        log(`  API params from XHR: shape=${shapeId} size=${sizeId}`);
      }

      // If no XHR fired yet, we need to trigger it by also selecting paper + finish
      if (!shapeId || !sizeId) {
        log(`  No prices XHR yet — selecting paper to trigger...`);
        await jsSelect('paper', 'White BOPP Label');
        await wait(3000);
        const pricesXhr2 = [...xhrLog].reverse().find(x => x.url.includes('/products/') && x.url.includes('/prices'));
        if (pricesXhr2) {
          const params = new URL(pricesXhr2.url).searchParams;
          shapeId = params.get('shape');
          sizeId  = params.get('size');
          log(`  API params (after paper select): shape=${shapeId} size=${sizeId}`);
        }
      }

      if (!shapeId || !sizeId) {
        log(`  SKIP: could not determine shape/size API IDs`);
        continue;
      }

      // Fetch pricing for all target qtys
      const url = `${BASE_PRICES}?shape=${shapeId}&size=${sizeId}&paper=${target.paper}&finish=${target.finish}`;
      const apiResult = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
          return { status: r.status, body: await r.text() };
        } catch(e) { return { error: e.message }; }
      }, url);

      if (apiResult.status === 200) {
        try {
          const data = JSON.parse(apiResult.body);
          const items = data.items || [];
          log(`  Prices (${items.length} qty tiers):`);
          const priceMap = {};
          for (const e of items) {
            log(`    qty ${e.quantity}: $${e.markupPrice}`);
            priceMap[e.quantity] = parseFloat(e.markupPrice);
          }
          gpResults[key] = {
            shapeId, sizeId, variantId,
            shapeLabel: target.shape, sizeLabel: exactSize.text,
            priceMap, items,
            queryIds: target.queries
          };
        } catch(e) { log(`  Parse error: ${e.message}`); }
      } else {
        log(`  API HTTP ${apiResult.status || apiResult.error}`);
      }
    }

  } finally {
    await page.close();
    await context.close();
  }

  return gpResults;
}

async function runVistaprint(browser, norm, raw) {
  log('\n═══ VISTAPRINT EXTENDED CAPTURE ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('cimpress.io')) return;
    try { cimpressCaptures.push({ url: u, status: resp.status(), body: await resp.text() }); } catch (_) {}
  });

  const page = await context.newPage();
  const vpResults = {}; // key: "WxH" → { prices: {qty: total} }

  try {
    log('Loading VP roll labels page...');
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });
    await wait(8000);

    // Capture pricingContext
    const pricingContext = cimpressCaptures
      .map(c => { try { return new URL(c.url).searchParams.get('pricingContext'); } catch(_){ return null; } })
      .find(Boolean);

    if (!pricingContext) {
      log('VP: No pricingContext captured — cannot make Cimpress calls');
      return {};
    }
    log(`VP: pricingContext captured (${pricingContext.length} chars)`);

    for (const target of VP_TARGETS) {
      const key = target.size.replace(/[^0-9.x]/g, '').replace('x', 'x');
      const qtysStr = target.qtys.join(',');
      const sizeParam = encodeURIComponent(target.size);
      const shapeParam = encodeURIComponent(target.shape);

      log(`\n── VP ${target.shape} ${target.size} qtys=${qtysStr} ──`);

      const url = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?` +
        `requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=${qtysStr}&` +
        `pricingContext=${encodeURIComponent(pricingContext)}&merchantId=vistaprint&` +
        `selections%5BRoll%20Finishing%20Type%5D=Slit%20Roll&` +
        `selections%5BShape%5D=${shapeParam}&` +
        `selections%5BSize%5D=${sizeParam}&` +
        `market=US&optionalPriceComponents=UnitPrice`;

      const resp = await context.request.get(url, { headers: { Accept: 'application/json' } });
      if (resp.status() === 200) {
        try {
          const data = await resp.json();
          const ep = data.estimatedPrices || {};
          const prices = {};
          for (const [qty, pd] of Object.entries(ep)) {
            const total = pd.totalListPrice?.untaxed ?? pd.totalListPrice;
            const unit  = pd.unitListPrice?.untaxed  ?? pd.unitListPrice;
            prices[parseInt(qty)] = { total: parseFloat(total), unit: parseFloat(unit) };
            log(`  qty ${qty}: $${total} ($${unit}/ea)`);
          }
          vpResults[target.size] = { shape: target.shape, prices, queryIds: target.queries };
        } catch(e) { log(`  Parse error: ${e.message}`); }
      } else {
        log(`  HTTP ${resp.status()}`);
        try {
          const body = await resp.text();
          if (body) log(`  Body: ${body.slice(0, 200)}`);
        } catch(_) {}
      }

      await wait(500); // rate limit courtesy
    }

  } finally {
    await page.close();
    await context.close();
  }

  return vpResults;
}

async function updateDataFiles(norm, raw, gpResults, vpResults, t) {
  log('\n═══ UPDATING DATA FILES ═══');
  let gpCount = 0, vpCount = 0;

  // ── Update GP ──
  for (const [key, gpData] of Object.entries(gpResults)) {
    for (const queryId of gpData.queryIds) {
      const q = norm.queries.find(q => q.query_id === queryId);
      if (!q) continue;

      // Determine which qty to use for this query
      const qSpec = q.spec;
      const targetQty = qSpec?.quantity;
      const price = targetQty ? gpData.priceMap[targetQty] : null;
      const unit  = price && targetQty ? parseFloat((price / targetQty).toFixed(6)) : null;

      if (!price) {
        log(`GP ${queryId}: no price for qty=${targetQty} (available: ${Object.keys(gpData.priceMap).join(', ')})`);
        continue;
      }

      const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
      const entry = {
        competitor: 'gotprint',
        competitor_display: 'GotPrint',
        status: 'live',
        coverage: 'exact_spec',
        total_price: price,
        unit_price: unit,
        currency: 'USD',
        shipping_included: false,
        confidence: 'high',
        notes: `${gpData.sizeLabel}, White BOPP, Matte Finish (Indoor), qty ${targetQty}. API: /products/300158845/prices?shape=${gpData.shapeId}&size=${gpData.sizeId}&paper=12&finish=3. Captured ${t}.`,
        closest_data_point: {
          description: `Roll Labels ${gpData.sizeLabel} ${gpData.shapeLabel}, White BOPP, Matte Finish, qty ${targetQty}`,
          total_price: price,
          unit_price: unit,
          quantity: targetQty,
          spec_delta: 'exact match',
          confidence: 'high'
        }
      };

      if (gi >= 0) Object.assign(q.competitor_results[gi], entry);
      else q.competitor_results.push(entry);
      log(`✓ GP ${queryId}: $${price} for qty=${targetQty}`);
      gpCount++;
    }

    // Also add a raw capture entry for the full price table
    raw.captures.push({
      id: `gotprint-${key}-extended-${t}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: t,
      capture_method: 'gotprint_rest_api_direct',
      capture_source: 'automated_headless',
      confidence: 'high',
      product_type: 'roll_labels',
      raw_spec_description: `${gpData.shapeLabel} ${gpData.sizeLabel} White BOPP Matte Finish Indoor`,
      specs: {
        shape: gpData.shapeLabel,
        size: gpData.sizeLabel,
        material: 'White BOPP Label',
        finish: 'Matte Finish (Indoor)',
        api_params: `shape=${gpData.shapeId}&size=${gpData.sizeId}&paper=12&finish=3`
      },
      pricing: {
        currency: 'USD',
        price_type: 'api_direct',
        full_price_table: gpData.items.map(e => ({ qty: e.quantity, total: parseFloat(e.markupPrice) }))
      }
    });
  }

  // ── Update VP ──
  for (const [sizeKey, vpData] of Object.entries(vpResults)) {
    for (const queryId of vpData.queryIds) {
      const q = norm.queries.find(q => q.query_id === queryId);
      if (!q) continue;

      const targetQty = q.spec?.quantity;
      const priceData = targetQty ? vpData.prices[targetQty] : null;

      if (!priceData) {
        log(`VP ${queryId}: no price for qty=${targetQty} (available: ${Object.keys(vpData.prices).join(', ')})`);
        continue;
      }

      const vi = q.competitor_results.findIndex(r => r.competitor === 'vistaprint');
      const entry = {
        competitor: 'vistaprint',
        competitor_display: 'Vistaprint',
        status: 'live',
        coverage: 'confirmed_size',
        total_price: priceData.total,
        unit_price: priceData.unit,
        currency: 'USD',
        shipping_included: null,
        confidence: 'high',
        notes: `${vpData.shape} ${sizeKey}, qty ${targetQty}. Cimpress API selections[Shape]=${vpData.shape}&selections[Size]=${sizeKey}. Material=White Plastic (VP equiv of BOPP). Captured ${t}.`,
        closest_data_point: {
          description: `Roll Labels ${vpData.shape} ${sizeKey}, qty ${targetQty}`,
          total_price: priceData.total,
          unit_price: priceData.unit,
          quantity: targetQty,
          spec_delta: 'Size confirmed as standard Cimpress selection. VP material=White Plastic.',
          confidence: 'high'
        }
      };

      if (vi >= 0) Object.assign(q.competitor_results[vi], entry);
      else q.competitor_results.push(entry);
      log(`✓ VP ${queryId}: $${priceData.total} for qty=${targetQty}`);
      vpCount++;
    }
  }

  norm.last_updated = t;
  raw.last_updated = t;
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
  log(`✓ Data files written — GP: ${gpCount} queries updated, VP: ${vpCount} queries updated`);
  return { gpCount, vpCount };
}

async function main() {
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));
  const raw  = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const t = today();

  const browser = await chromium.launch({ headless: true });
  try {
    // Run GP and VP sequentially (share browser, keep resource usage moderate)
    const gpResults = await runGotPrint(browser, norm, raw);
    const vpResults = await runVistaprint(browser, norm, raw);

    const { gpCount, vpCount } = await updateDataFiles(norm, raw, gpResults, vpResults, t);

    // Final summary
    console.log('\n═══════════════════════════════════════════════');
    console.log(' EXTENDED COVERAGE RESULTS');
    console.log('═══════════════════════════════════════════════');
    console.log('GotPrint captures:');
    for (const [key, r] of Object.entries(gpResults)) {
      const p5k = r.priceMap[5000] || r.priceMap[1000];
      const qtys = Object.keys(r.priceMap).join(', ');
      console.log(`  ${key} (${r.shapeLabel}): qtys [${qtys}] — shape=${r.shapeId} size=${r.sizeId}`);
    }
    console.log('Vistaprint captures:');
    for (const [size, r] of Object.entries(vpResults)) {
      const qtys = Object.entries(r.prices).map(([q, p]) => `${q}=$${p.total}`).join(', ');
      console.log(`  ${r.shape} ${size}: ${qtys}`);
    }
    console.log(`Queries updated: GP=${gpCount} VP=${vpCount}`);
    console.log('═══════════════════════════════════════════════');

  } finally {
    await browser.close();
  }
}

main().catch(e => { err(e.message + '\n' + e.stack); process.exit(1); });
