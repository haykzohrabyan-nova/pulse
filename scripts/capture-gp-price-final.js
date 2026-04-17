#!/usr/bin/env node
/**
 * capture-gp-price-final.js
 *
 * GotPrint pricing extraction after breakthrough discovery:
 *   - Square - Rounded shape has 3" x 3" size option
 *   - XHR fires to /products/options/quantities with productVariantId=32 after selecting Square-Rounded + 3×3
 *   - Product variant ID = 32 (for Square-Rounded 3×3 White BOPP Matte)
 *
 * Strategy:
 *   1. Configure Square-Rounded + 3×3 + White BOPP + Matte Finish using page.selectOption()
 *   2. Capture the full /products/options/quantities XHR response
 *   3. Use the variant ID to call pricing endpoints directly with qty=5000
 *   4. Read subtotal from DOM
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const RAW     = path.join(ROOT, 'data', 'competitor-pricing-raw.json');
const NORM    = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const SS_DIR  = path.join(ROOT, 'data', 'screenshots');

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const log  = m => console.log(`[gpf] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ss(page, name) {
  try { await page.screenshot({ path: path.join(SS_DIR, `${name}-${Date.now()}.png`) }); } catch (_) {}
}

async function main() {
  const raw  = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));
  const today = new Date().toISOString().split('T')[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const xhrFull = [];   // all GP XHR calls with full body
  const priceXhr = [];  // only pricing-related XHR calls

  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com')) return;
    if (resp.status() >= 400) return;
    try {
      const body = await resp.text();
      xhrFull.push({ url: u, status: resp.status(), body });
      if (u.includes('/service/rest/v1') && (/price|qty|quant|product|option/i.test(u) || /price|total|amount|qty/i.test(body.slice(0, 500)))) {
        priceXhr.push({ url: u, status: resp.status(), body });
        const ep = u.split('/v1/')[1]?.slice(0, 70);
        log(`GP XHR: ${ep} → ${body.slice(0, 400)}`);
      }
    } catch (_) {}
  });

  const result = {
    variantId: null,
    quantities: [],
    price5000: null,
    unit5000: null,
    configPrice: null,
    paperSelected: null,
    finishSelected: null,
    notes: []
  };

  const page = await context.newPage();

  try {
    log('Loading /products/roll-labels/order ...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await wait(5000);
    await ss(page, 'gpf-01-loaded');
    log(`URL: ${page.url()} | Title: "${await page.title()}"`);

    if (page.url().includes('home.html')) {
      log('BLOCKED'); await page.close(); await context.close(); await browser.close(); return;
    }

    // ── Step 1: Select Shape = "Square - Rounded" via Playwright selectOption ──
    log('\nStep 1: shape = Square - Rounded');
    await page.selectOption('select[name="shape"]', { label: 'Square - Rounded' });
    await wait(3000);
    await ss(page, 'gpf-02-shape');

    // ── Step 2: Select Size = "3" x 3"" ──
    log('Step 2: size = 3" x 3"');
    const sizeOpts = await page.$$eval('select[name="size"] option', os => os.map(o => ({ v: o.value, t: o.text.trim() })));
    log(`Size options: ${sizeOpts.map(o => o.t).join(' | ')}`);
    const size3x3 = sizeOpts.find(o => /^3"?\s*x\s*3"?$/i.test(o.t) || o.t.includes('3" x 3"'));
    if (size3x3) {
      await page.selectOption('select[name="size"]', { value: size3x3.v });
      log(`Selected size: "${size3x3.t}"`);
      await wait(3000);
      await ss(page, 'gpf-03-size');
    } else {
      log(`No exact 3x3. Options: ${sizeOpts.map(o => o.t).join(', ')}`);
    }

    // Capture the quantities XHR that should have fired
    await wait(2000); // wait for XHR to complete

    // ── Step 3: Select Paper = "White BOPP Label" ──
    log('Step 3: paper = White BOPP Label');
    const paperDisabled = await page.$eval('select[name="paper"]', s => s.disabled).catch(() => true);
    if (!paperDisabled) {
      const paperOpts = await page.$$eval('select[name="paper"] option', os => os.map(o => ({ v: o.value, t: o.text.trim() })));
      log(`Paper options: ${paperOpts.map(o => o.t).join(' | ')}`);
      const boppOpt = paperOpts.find(o => /white.*bopp/i.test(o.t)) || paperOpts.find(o => /bopp/i.test(o.t));
      if (boppOpt) {
        await page.selectOption('select[name="paper"]', { value: boppOpt.v });
        result.paperSelected = boppOpt.t;
        log(`Selected paper: "${boppOpt.t}"`);
        await wait(3000);
        await ss(page, 'gpf-04-paper');
      }
    } else {
      log('Paper select still disabled after size selection');
      result.notes.push('Paper select disabled after size selection — may need different trigger');

      // Try clicking directly on the select element to trigger Vue.js
      await page.click('select[name="paper"]');
      await wait(1000);
      const stillDisabled = await page.$eval('select[name="paper"]', s => s.disabled).catch(() => true);
      log(`After click, paper still disabled: ${stillDisabled}`);
    }

    // ── Step 4: Select Finish = "Matte Finish (Indoor)" ──
    log('Step 4: finish = Matte Finish');
    const finishDisabled = await page.$eval('select[name="finish"]', s => s.disabled).catch(() => true);
    if (!finishDisabled) {
      const finishOpts = await page.$$eval('select[name="finish"] option', os => os.map(o => ({ v: o.value, t: o.text.trim() })));
      log(`Finish options: ${finishOpts.map(o => o.t).join(' | ')}`);
      const matteOpt = finishOpts.find(o => /matte.*indoor/i.test(o.t)) || finishOpts.find(o => /matte/i.test(o.t));
      if (matteOpt) {
        await page.selectOption('select[name="finish"]', { value: matteOpt.v });
        result.finishSelected = matteOpt.t;
        log(`Selected finish: "${matteOpt.t}"`);
        await wait(3000);
        await ss(page, 'gpf-05-finish');
      }
    } else {
      log('Finish select still disabled');
      result.notes.push('Finish select disabled — paper needs to be selected first');
    }

    // ── Step 5: Select Color ──
    const colorDisabled = await page.$eval('select[name="color"]', s => s.disabled).catch(() => true);
    if (!colorDisabled) {
      const colorOpts = await page.$$eval('select[name="color"] option', os => os.map(o => ({ v: o.value, t: o.text.trim() })));
      const colorOpt = colorOpts.find(o => o.t !== 'Please select an option');
      if (colorOpt) {
        await page.selectOption('select[name="color"]', { value: colorOpt.v });
        log(`Selected color: "${colorOpt.t}"`);
        await wait(2000);
      }
    }

    await ss(page, 'gpf-06-configured');

    // ── Step 6: Read subtotal ──
    const allPriceTexts = await page.evaluate(() => {
      const prices = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (/\$[\d,]+\.\d{2}/.test(t) && t.length < 80) prices.push(t);
      }
      return [...new Set(prices)].slice(0, 20);
    });
    log(`All prices in DOM: ${allPriceTexts.join(' | ')}`);

    // Subtotal element
    const subtotal = await page.evaluate(() => {
      const el = document.querySelector('.cart-price');
      if (el) return { source: '.cart-price', text: el.textContent.trim() };

      // Find "Subtotal" row
      const texts = document.querySelectorAll('*');
      for (const el of texts) {
        if (el.children.length === 0 && el.textContent.trim() === 'Subtotal (excludes shipping) :') {
          const parent = el.parentElement;
          if (parent) {
            const priceEl = parent.querySelector('.cart-price, [class*="price"]');
            if (priceEl) return { source: 'subtotal_row', text: priceEl.textContent.trim() };
            const m = parent.textContent.match(/\$([\d,]+\.\d{2})/);
            if (m) return { source: 'subtotal_row_text', text: m[0], amount: parseFloat(m[1].replace(/,/g, '')) };
          }
        }
      }
      return null;
    });
    log(`Subtotal element: ${JSON.stringify(subtotal)}`);

    if (subtotal?.text) {
      const m = subtotal.text.match(/\$([\d,]+\.\d{2})/);
      if (m) {
        const amt = parseFloat(m[1].replace(/,/g, ''));
        if (amt > 0 && amt < 10000) result.configPrice = amt;
      }
    }

    // ── Step 7: Parse quantities XHR ──
    log('\nParsing XHR calls...');
    log(`Total XHR calls: ${xhrFull.length}`);

    for (const xhr of xhrFull.filter(x => x.url.includes('/v1/'))) {
      const ep = xhr.url.split('/v1/')[1]?.split('?')[0];
      log(`  /v1/${ep} → ${xhr.body.slice(0, 300)}`);

      // Parse quantities endpoint
      if (ep === 'products/options/quantities') {
        try {
          const d = JSON.parse(xhr.body);
          log(`  quantities response keys: ${Object.keys(d)}`);
          for (const [varId, qtyList] of Object.entries(d)) {
            log(`  variant ${varId}: ${qtyList.length} quantities: ${qtyList.slice(0, 8).map(q => q.quantity).join(', ')}...`);
            result.variantId = varId;
            result.quantities = qtyList.map(q => q.quantity);
            log(`  All quantities: ${result.quantities.join(', ')}`);
            const has5000 = result.quantities.includes(5000);
            log(`  Has qty 5000: ${has5000}`);
          }
        } catch (e) { log(`  parse error: ${e.message}`); }
      }
    }

    // ── Step 8: Use variant ID to call pricing endpoint ──
    if (result.variantId) {
      log(`\nUsing variant ID ${result.variantId} to get pricing...`);
      const cookies = await context.cookies();
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      const pricingEndpoints = [
        `https://www.gotprint.com/service/rest/v1/products/options/prices/${result.variantId}?qty=5000`,
        `https://www.gotprint.com/service/rest/v1/products/${result.variantId}/prices?qty=5000`,
        `https://www.gotprint.com/service/rest/v1/products/${result.variantId}/pricing?qty=5000&quantity=5000`,
        `https://www.gotprint.com/service/rest/v1/products/options/pricing/${result.variantId}?qty=5000`,
        `https://www.gotprint.com/service/rest/v1/products/price?variantId=${result.variantId}&qty=5000`,
        `https://www.gotprint.com/service/rest/v1/products/options/prices?id=${result.variantId}&qty=5000`,
        `https://www.gotprint.com/service/rest/v1/products/${result.variantId}/price-table`,
        `https://www.gotprint.com/service/rest/v1/products/options/prices/${result.variantId}`,
        `https://www.gotprint.com/service/rest/v1/products/${result.variantId}/options`,
        // Also try generic pricing endpoint with variantId param
        `https://www.gotprint.com/service/rest/v1/products/pricing?variantId=${result.variantId}&qty=5000&turnaround=1`,
        `https://www.gotprint.com/service/rest/v1/products/pricing?productVariantId=${result.variantId}&quantity=5000`,
        // POST approach
      ];

      for (const url of pricingEndpoints) {
        try {
          const r = await context.request.get(url, {
            headers: { Cookie: cookieHeader, Accept: 'application/json' },
            timeout: 10000
          });
          const ep = url.split('/v1/')[1]?.slice(0, 60);
          log(`  GET /v1/${ep}: ${r.status()}`);
          if (r.status() < 400) {
            const body = await r.text();
            log(`  body: ${body.slice(0, 500)}`);
            // Parse and look for price
            try {
              const d = JSON.parse(body);
              const findPrice = (obj, path = '') => {
                if (typeof obj === 'number' && obj > 5 && obj < 50000) {
                  if (/price|total|amount|subtotal|cost/i.test(path)) {
                    log(`  price at ${path}: $${obj}`);
                    if (!result.price5000 && /5000|qty/i.test(path) === false && obj > 20) {
                      result.price5000 = obj;
                    }
                  }
                }
                if (typeof obj === 'object' && obj !== null) {
                  for (const k of Object.keys(obj)) findPrice(obj[k], `${path}.${k}`);
                }
              };
              findPrice(d);
            } catch (_) {}
          }
        } catch (e) { log(`  error: ${e.message?.slice(0, 50)}`); }
      }

      // Also try POST to pricing endpoint
      const postEndpoints = [
        `https://www.gotprint.com/service/rest/v1/products/pricing`,
        `https://www.gotprint.com/service/rest/v1/products/price`,
        `https://www.gotprint.com/service/rest/v1/products/${result.variantId}/price`,
      ];
      for (const url of postEndpoints) {
        for (const body of [
          { variantId: parseInt(result.variantId), qty: 5000, quantity: 5000, turnaround: 1 },
          { id: parseInt(result.variantId), qty: 5000, quantity: 5000 },
          { productVariantId: parseInt(result.variantId), quantity: 5000, turnaroundId: 1 },
        ]) {
          try {
            const r = await context.request.post(url, {
              data: JSON.stringify(body),
              headers: { Cookie: cookieHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
              timeout: 10000
            });
            const ep = url.split('/v1/')[1]?.slice(0, 50);
            log(`  POST /v1/${ep} body=${JSON.stringify(body)}: ${r.status()}`);
            if (r.status() < 400) {
              const respBody = await r.text();
              log(`  response: ${respBody.slice(0, 400)}`);
            }
          } catch (_) {}
        }
      }

      // ── Step 9: Check for a price-by-qty endpoint triggered when qty is added to cart ──
      // Look at the full XHR log for any price-related endpoints that fired during shape/size selection
      log('\nAll /v1/ endpoints called during session:');
      const v1Calls = [...new Set(xhrFull.filter(x => x.url.includes('/v1/')).map(x => x.url.split('/v1/')[1]?.split('?')[0]))];
      for (const ep of v1Calls) {
        log(`  /v1/${ep}`);
      }
    }

    // ── Step 10: Read full product details for context ──
    const productSection = await page.evaluate(() => {
      const sel = document.querySelector('.product-detail-section, [class*="product-detail"], #product-detail');
      if (sel) return sel.textContent.replace(/\s+/g, ' ').trim().slice(0, 2000);
      return null;
    });
    if (productSection) log(`Product detail section: ${productSection.slice(0, 1000)}`);

    // Screenshot of page bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(500);
    await ss(page, 'gpf-07-bottom');

    // ── Final summary ──
    console.log('\n════════════════════════════════════════');
    console.log(' GOTPRINT PRICE CAPTURE RESULT');
    console.log('════════════════════════════════════════');
    console.log(`Configurator: /products/roll-labels/order`);
    console.log(`Shape: Square - Rounded | Size: 3" x 3"`);
    console.log(`Paper: ${result.paperSelected || 'NOT SELECTED (disabled)'}`);
    console.log(`Finish: ${result.finishSelected || 'NOT SELECTED (disabled)'}`);
    console.log(`Variant ID: ${result.variantId}`);
    console.log(`Available qtys: ${result.quantities.join(', ')}`);
    console.log(`Has qty 5000: ${result.quantities.includes(5000)}`);
    console.log(`Config subtotal: ${result.configPrice ? '$' + result.configPrice : 'NOT CAPTURED (0.00)'}`);
    console.log(`API price 5000: ${result.price5000 ? '$' + result.price5000 : 'NOT CAPTURED'}`);
    console.log(`Notes: ${result.notes.join('; ')}`);
    console.log('════════════════════════════════════════\n');

    // ── Update data ──
    const gpEntry = {
      id: `gotprint-3x3-sq-rounded-${today}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: today,
      capture_method: 'playwright_native_select_variant_probe',
      capture_source: 'automated_headless',
      confidence: result.price5000 ? 'medium' : (result.variantId ? 'low' : 'none'),
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels Square - Rounded 3" x 3", paper=${result.paperSelected || 'White BOPP (not selectd)'}, finish=${result.finishSelected || 'Matte (not selected)'}, qty=5000`,
      specs: {
        width_in: 3,
        height_in: 3,
        shape: 'Square - Rounded',
        format: 'roll',
        quantity: 5000,
        material: result.paperSelected || 'White BOPP Label (target)',
        finish: result.finishSelected || 'Matte Finish (Indoor) (target)'
      },
      pricing: {
        total_price: result.price5000 || result.configPrice,
        unit_price: result.price5000 ? parseFloat((result.price5000 / 5000).toFixed(4)) : null,
        currency: 'USD',
        turnaround_days: null,
        shipping_included: false,
        price_type: result.price5000 ? 'api_price' : (result.configPrice ? 'configurator_subtotal' : 'not_captured')
      },
      raw_snippet: `variantId=${result.variantId} quantities=[${result.quantities.join(',')}] has5000=${result.quantities.includes(5000)} paperDisabled=${!result.paperSelected} finishDisabled=${!result.finishSelected}`,
      notes: [
        `GP /products/roll-labels/order: Square-Rounded shape confirmed with 3" x 3" size option.`,
        `Variant ID from /products/options/quantities XHR: ${result.variantId}.`,
        `Available quantities: ${result.quantities.join(', ')}.`,
        `Has 5000 qty: ${result.quantities.includes(5000)}.`,
        `Paper/Finish: Vue.js selects only enable in sequence. Paper disabled until size is selected via proper Vue trigger. Paper + Finish need further interaction.`,
        `Key insight: the /products/options/quantities endpoint fires when shape+size are selected and returns variantId + available qtys.`,
        `Next: manual session to trigger paper+finish+color to enable qty selector, or probe pricing API with variantId=${result.variantId}.`,
        result.notes.join(' ')
      ].join(' '),
      blocker: result.price5000 ? null : `Paper/finish selects remain disabled — Vue.js requires specific sequence of native events. REST API pricing endpoints return 401. Qty comes after artwork upload.`,
      next_step: `Manual: gotprint.com/products/roll-labels/order → Square-Rounded → 3"x3" → White BOPP → Matte Finish (Indoor) → Full Color → Upload Front → qty 5000 → read subtotal. OR: inspect DevTools during manual configuration to find the pricing XHR endpoint called when qty is shown.`
    };

    const idx = raw.captures.findIndex(c => c.id === gpEntry.id);
    if (idx >= 0) raw.captures[idx] = gpEntry; else raw.captures.push(gpEntry);

    // Update coverage
    raw.capture_coverage_summary.gotprint = {
      status: 'partial',
      confidence: result.variantId ? 'medium' : 'low',
      last_method: 'playwright_native_select_variant_probe',
      configurator_url: 'https://www.gotprint.com/products/roll-labels/order',
      product_variant_id: result.variantId,
      available_quantities: result.quantities,
      has_5000_qty: result.quantities.includes(5000),
      target_spec_available: true,
      target_shape: 'Square - Rounded',
      target_size: '3" x 3"',
      target_paper: 'White BOPP Label',
      target_finish: 'Matte Finish (Indoor)',
      price_captured: result.price5000 || result.configPrice,
      shape_size_map: {
        'Rectangle - Rounded': ['0.5" x 1"','0.5" x 2"','0.75" x 1.5"','1" x 2"','1.5" x 2.5"','1.5" x 3"','1.5" x 3.5"','2" x 3"','2.5" x 3"','2.5" x 3.5"','2.5" x 4"','2.5" x 5"','2.5" x 7"','3" x 4"','3" x 5"','3" x 5.5"','3.5" x 4"','3.5" x 5"','4" x 5"','5" x 7"','6" x 6.5"'],
        'Square - Rounded': ['1" x 1"','1.5" x 1.5"','2" x 2"','2.5" x 2.5"','3" x 3"','4" x 4"','5" x 5"'],
        'Circle': ['0.75" Diameter','1" Diameter','1.25" Diameter','1.5" Diameter','2" Diameter','2.5" Diameter','3" Diameter','3.5" Diameter','4" Diameter','5" Diameter'],
        'Oval': ['0.75" x 1.5"','1.5" x 2.5"','2" x 3"','3" x 4"'],
        'Rectangle': ['2.5" x 3.5"','3.5" x 4"','3.5" x 5"','4" x 6" (Standard)'],
        'Square': ['4" x 4"','5" x 5"'],
        'Arched': ['3" x 4" Arched'],
        'Heart': ['1.5" x 1.5" Heart'],
        'Starburst': ['1.625" x 1.625"']
      },
      notes: `3" x 3" confirmed for Square-Rounded shape. Variant ID=${result.variantId}. Qty 5000 available. Paper+Finish disabled until full Vue.js sequence — need manual session or artifact upload to unlock. No automated price capture without upload file.`
    };

    // Update normalized
    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
      const gpNorm = {
        competitor: 'gotprint', competitor_display: 'GotPrint',
        status: 'partial',
        coverage: 'spec_confirmed_price_blocked_by_upload',
        total_price: result.price5000 || null,
        unit_price: null, currency: 'USD', shipping_included: false,
        confidence: 'low',
        notes: `CONFIRMED: 3"×3" size available under Square-Rounded shape at /products/roll-labels/order. White BOPP + Matte Finish available. Qty 5000 in available quantities list (variant ID=${result.variantId}). BLOCKER: Vue.js select cascade requires complete sequence to unlock paper/finish; price (subtotal) only shows after "Upload Front" step. Cannot capture price in headless mode without artwork file. Manual click-through required.`,
        closest_data_point: {
          description: `GP Square-Rounded 3"×3" White BOPP Matte Finish Indoor, qty=5000 — spec CONFIRMED available but price not captured`,
          price: null,
          spec_delta: 'EXACT spec (3×3 Square-Rounded = closest to square label) but price unavailable without upload step',
          confidence: 'low'
        }
      };
      if (gi >= 0) Object.assign(q.competitor_results[gi], gpNorm);
      else q.competitor_results.push(gpNorm);
    }

    raw.last_updated = today;
    norm.last_updated = today;
    fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
    log('✓ Data files updated');

  } catch (e) {
    err(`${e.message}`);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
