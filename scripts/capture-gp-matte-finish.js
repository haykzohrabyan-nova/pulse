#!/usr/bin/env node
/**
 * capture-gp-matte-finish.js
 *
 * TARGET: GotPrint 3"×3" Square-Rounded, White BOPP, Matte Finish (Indoor), 5000 qty
 *
 * APPROACH:
 *  1. Load GP configurator to establish a real browser session + cookies
 *  2. Configure shape=Square-Rounded, size=3"x3", paper=White BOPP to trigger
 *     the /options/quantities XHR (captures variantId)
 *  3. Hit the specs endpoint to enumerate all finish option IDs
 *  4. Test /service/rest/v1/products/300158845/prices with matte finish ID
 *     across full qty table (confirms matte price at 5000)
 *  5. Write results to data files
 *
 * Known IDs from prior runs:
 *   variantId=32, paper=12 (White BOPP), finish=1 (Clear Gloss Indoor → $356.80/5k)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW  = path.join(ROOT, 'data', 'competitor-pricing-raw.json');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');

const log  = m => console.log(`[gp-matte] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().split('T')[0];
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function main() {
  const raw  = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const xhrLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com') || resp.status() >= 400) return;
    try { xhrLog.push({ url: u, status: resp.status(), body: await resp.text() }); } catch (_) {}
  });

  const result = {
    variantId: '32',  // known
    finishOptions: [],
    matteFinishId: null,
    priceTable: null,
    price5000: null,
    unit5000: null,
  };

  const page = await context.newPage();
  try {
    log('Loading GP configurator...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await wait(5000);

    if (page.url().includes('home.html')) {
      log('BLOCKED: redirected to home. GP may be geo-blocking or session expired.');
      return;
    }
    log(`Loaded: ${page.url()}`);

    // ── Step 1: Configure shape → size to trigger quantities XHR ──
    async function jsSelect(name, label) {
      return page.evaluate(({ n, l }) => {
        const sel = document.querySelector(`select[name="${n}"]`);
        if (!sel) return `NOT FOUND: select[name="${n}"]`;
        const opt = [...sel.options].find(o => o.text.trim() === l);
        if (!opt) return `OPTION NOT FOUND: "${l}" in ${n}. Available: ${[...sel.options].map(o => o.text.trim()).join(', ')}`;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('input',  { bubbles: true }));
        return `OK: ${n}="${opt.value}" (${opt.text.trim()})`;
      }, { n: name, l: label });
    }

    log(await jsSelect('shape', 'Square - Rounded'));
    await wait(3000);

    log(await jsSelect('size', '3" x 3"'));
    await wait(3000);

    log(await jsSelect('paper', 'White BOPP Label'));
    await wait(2000);

    // ── Step 2: Discover finish options from the finish select ──
    const finishOptions = await page.evaluate(() => {
      const sel = document.querySelector('select[name="finish"]');
      if (!sel) return null;
      return [...sel.options].map(o => ({ value: o.value, text: o.text.trim() }))
                             .filter(o => o.text && o.text !== 'Please select an option');
    });

    log(`Finish options: ${JSON.stringify(finishOptions)}`);
    result.finishOptions = finishOptions || [];

    // Find matte finish
    const matteOpt = (finishOptions || []).find(o => /matte/i.test(o.text));
    if (matteOpt) {
      result.matteFinishId = matteOpt.value;
      log(`Matte finish: id=${matteOpt.value} label="${matteOpt.text}"`);
    } else {
      log('WARNING: No matte finish option found in dropdown');
    }

    // ── Step 3: Capture session cookies ──
    const cookies = await context.cookies();
    const cookieHdr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    log(`Session cookies: ${cookies.length} cookies`);

    // ── Step 4: Check XHR for variant confirmation ──
    const qtyXhr = xhrLog.find(x => x.url.includes('options/quantities'));
    if (qtyXhr) {
      try {
        const d = JSON.parse(qtyXhr.body);
        const entries = Object.entries(d);
        if (entries.length > 0) {
          const [vid, qtys] = entries[0];
          result.variantId = vid;
          log(`VariantId from XHR: ${vid}, qtys: ${qtys.map(q => q.quantity).join(', ')}`);
        }
      } catch (_) {}
    }

    // ── Step 5: Also check specs endpoint for full finish/paper ID map ──
    const specXhr = xhrLog.find(x => x.url.includes('specifications'));
    if (specXhr) {
      try {
        const d = JSON.parse(specXhr.body);
        log(`Specs data keys: ${Object.keys(d).join(', ')}`);
        // Look for finish-related keys
        const finishKey = Object.keys(d).find(k => /finish|lamination/i.test(k));
        if (finishKey) {
          log(`Finish specs: ${JSON.stringify(d[finishKey]).slice(0, 500)}`);
        }
        // Also surface paper IDs for confirmation
        const paperKey = Object.keys(d).find(k => /paper|material/i.test(k));
        if (paperKey) {
          log(`Paper specs: ${JSON.stringify(d[paperKey]).slice(0, 300)}`);
        }
      } catch (_) {}
    }

    // ── Step 6: Hit the pricing API with matte finish ID ──
    // Known working endpoint: /service/rest/v1/products/300158845/prices
    // Known working params:   shape=4&size=452&paper=12&finish=1&qty=5000
    // We need to test finish=<matteId> and map the shape/size/paper numeric IDs

    // First, try to discover shape/size/paper numeric IDs from existing XHR
    const pricesXhr = xhrLog.find(x => x.url.includes('/products/') && x.url.includes('/prices'));
    let shapeId = '4', sizeId = '452', paperId = '12';

    if (pricesXhr) {
      const params = new URL(pricesXhr.url).searchParams;
      shapeId = params.get('shape') || shapeId;
      sizeId  = params.get('size')  || sizeId;
      paperId = params.get('paper') || paperId;
      const existingFinish = params.get('finish');
      log(`Existing prices XHR params: shape=${shapeId} size=${sizeId} paper=${paperId} finish=${existingFinish}`);
    } else {
      log(`No prices XHR captured yet. Using known IDs: shape=${shapeId} size=${sizeId} paper=${paperId}`);
    }

    // Test finish IDs: if we have the matte ID from dropdown, use it.
    // Also try common candidates (finish=2 or finish=3 are typical candidates after finish=1)
    const finishIdsToTest = [];
    if (result.matteFinishId) finishIdsToTest.push(result.matteFinishId);
    // Add candidates if not already included
    for (const candidate of ['2', '3', '4', '5']) {
      if (!finishIdsToTest.includes(candidate)) finishIdsToTest.push(candidate);
    }

    log(`\nTesting finish IDs: ${finishIdsToTest.join(', ')}`);

    const BASE = 'https://www.gotprint.com/service/rest/v1/products/300158845/prices';
    for (const finId of finishIdsToTest) {
      const url = `${BASE}?shape=${shapeId}&size=${sizeId}&paper=${paperId}&finish=${finId}`;
      const apiResult = await page.evaluate(async ({ u, ch }) => {
        try {
          const r = await fetch(u, {
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/plain, */*', 'Cookie': ch }
          });
          return { status: r.status, body: await r.text() };
        } catch(e) { return { error: e.message }; }
      }, { u: url, ch: cookieHdr });

      if (apiResult.status === 200) {
        try {
          const data = JSON.parse(apiResult.body);
          log(`finish=${finId}: HTTP 200 — keys: ${Object.keys(data).join(', ')}`);

          // Print full price table
          if (Array.isArray(data)) {
            log(`  Price table (${data.length} entries):`);
            for (const entry of data) {
              const qty  = entry.quantity || entry.qty;
              const price = entry.price || entry.total || entry.totalPrice;
              const unit  = entry.unitPrice || entry.unit;
              log(`    qty ${qty}: $${price}${unit ? ` ($${unit}/ea)` : ''}`);
            }
            const entry5k = data.find(e => (e.quantity || e.qty) == 5000);
            if (entry5k) {
              const p5k = entry5k.price || entry5k.total || entry5k.totalPrice;
              log(`  *** 5000 qty price: $${p5k} (finish=${finId}) ***`);
              if (result.matteFinishId && finId === result.matteFinishId) {
                result.price5000 = parseFloat(p5k);
                result.unit5000  = entry5k.unitPrice ? parseFloat(entry5k.unitPrice) : parseFloat((p5k / 5000).toFixed(6));
                result.priceTable = data;
              }
            }
          } else if (data.prices || data.pricingData) {
            const table = data.prices || data.pricingData;
            log(`  ${JSON.stringify(table).slice(0, 400)}`);
          } else {
            log(`  ${JSON.stringify(data).slice(0, 400)}`);
          }
        } catch(e) { log(`  finish=${finId}: parse error: ${e.message} | body: ${apiResult.body.slice(0, 200)}`); }
      } else {
        log(`finish=${finId}: HTTP ${apiResult.status || 'ERR: ' + apiResult.error}`);
        if (apiResult.body) log(`  body: ${apiResult.body.slice(0, 200)}`);
      }
    }

    // ── Step 7: If no explicit matte ID found, try to extract from form option values ──
    // The dropdown option value IS the finish ID we need for the API
    if (!result.price5000 && finishOptions && finishOptions.length > 0) {
      log('\nRetrying with all dropdown finish option values as API IDs...');
      for (const fOpt of finishOptions) {
        if (fOpt.value === '1') { log(`  Skipping finish=1 (Clear Gloss Indoor, already known)`); continue; }
        const url = `${BASE}?shape=${shapeId}&size=${sizeId}&paper=${paperId}&finish=${fOpt.value}`;
        const apiResult = await page.evaluate(async ({ u }) => {
          try {
            const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
            return { status: r.status, body: await r.text() };
          } catch(e) { return { error: e.message }; }
        }, { u: url });

        if (apiResult.status === 200) {
          try {
            const data = JSON.parse(apiResult.body);
            log(`  finish="${fOpt.value}" (${fOpt.text}): HTTP 200`);
            if (Array.isArray(data)) {
              const e5k = data.find(e => (e.quantity || e.qty) == 5000);
              if (e5k) {
                const p5k = e5k.price || e5k.total || e5k.totalPrice;
                log(`  *** 5000 qty → $${p5k} ***`);
                if (/matte/i.test(fOpt.text)) {
                  result.price5000 = parseFloat(p5k);
                  result.matteFinishId = fOpt.value;
                  result.priceTable = data;
                }
              }
            }
          } catch(_) { log(`  finish="${fOpt.value}": parse error`); }
        } else {
          log(`  finish="${fOpt.value}" (${fOpt.text}): HTTP ${apiResult.status}`);
        }
      }
    }

  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // ── Results ──
  console.log('\n═══════════════════════════════════════════════');
  console.log(' GOTPRINT MATTE FINISH RESULTS');
  console.log('═══════════════════════════════════════════════');
  console.log(`Finish options found: ${result.finishOptions.map(o => `${o.value}=${o.text}`).join(', ')}`);
  console.log(`Matte finish ID: ${result.matteFinishId || 'NOT FOUND'}`);
  console.log(`5000 qty matte price: ${result.price5000 ? '$' + result.price5000 : 'NOT CAPTURED'}`);
  console.log(`Unit price at 5000: ${result.unit5000 ? '$' + result.unit5000 : 'N/A'}`);
  if (result.priceTable) {
    console.log('Full matte price table:');
    for (const e of result.priceTable) {
      const qty = e.quantity || e.qty;
      const p   = e.price || e.total || e.totalPrice;
      console.log(`  qty ${qty}: $${p}`);
    }
  }
  console.log('═══════════════════════════════════════════════\n');

  // ── Update data files if we got a price ──
  if (result.price5000) {
    const t = today();

    // Update normalized JSON for primary benchmark
    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
      const updated = {
        competitor: 'gotprint',
        competitor_display: 'GotPrint',
        status: 'live',
        coverage: 'exact_spec',
        total_price: result.price5000,
        unit_price: result.unit5000,
        currency: 'USD',
        shipping_included: false,
        confidence: 'high',
        notes: `3"×3" Square-Rounded, White BOPP, Matte Finish (Indoor), 5000 qty. Captured via /service/rest/v1/products/300158845/prices with finish=${result.matteFinishId}. Captured ${t}.`,
        closest_data_point: {
          description: `Roll Labels 3"×3" Square-Rounded, White BOPP, Matte Finish Indoor, 5,000 qty`,
          total_price: result.price5000,
          unit_price: result.unit5000,
          quantity: 5000,
          spec_delta: 'exact match',
          confidence: 'high'
        }
      };
      if (gi >= 0) Object.assign(q.competitor_results[gi], updated);
      else q.competitor_results.push(updated);
      log('✓ Updated normalized JSON: 3x3-5000-matte-bopp-cmyk / gotprint');
    }

    // Add raw capture entry
    const rawEntry = {
      id: `gotprint-3x3-5000-matte-bopp-${t}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: t,
      capture_method: 'gotprint_rest_api_direct',
      capture_source: 'automated_headless',
      confidence: 'high',
      product_type: 'roll_labels',
      raw_spec_description: `Square-Rounded 3"×3" White BOPP Matte Finish Indoor variantId=${result.variantId}`,
      specs: {
        shape: 'Square - Rounded',
        size: '3" x 3"',
        material: 'White BOPP Label',
        finish: 'Matte Finish (Indoor)',
        variant_id: result.variantId,
        api_params: `shape=4&size=452&paper=12&finish=${result.matteFinishId}`
      },
      pricing: {
        total_price: result.price5000,
        unit_price: result.unit5000,
        quantity: 5000,
        currency: 'USD',
        price_type: 'api_direct',
        price_table: result.priceTable ? result.priceTable.map(e => ({
          qty: e.quantity || e.qty,
          total: e.price || e.total || e.totalPrice,
          unit: e.unitPrice
        })) : null
      },
      notes: `Direct API capture via /service/rest/v1/products/300158845/prices. Matte finish ID=${result.matteFinishId}. EXACT MATCH for 3×3/5000/White BOPP/Matte benchmark.`
    };
    raw.captures.push(rawEntry);

    raw.last_updated = t;
    norm.last_updated = t;
    fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
    log('✓ Data files written');
  } else {
    log('No matte price captured — data files not updated');
  }
}

main().catch(e => { err(e.message + '\n' + e.stack); process.exit(1); });
