#!/usr/bin/env node
/**
 * capture-gp-final.js
 *
 * Final corrected GotPrint pass. Findings from previous runs:
 *
 *   select[name="referrerType"] = hidden, skip
 *   select[name="shape"]  = visible, enabled
 *   select[name="size"]   = visible, disabled until shape selected
 *   select[name="paper"]  = visible, disabled until size selected
 *   select[name="finish"] = visible, disabled until paper selected
 *   select[name="color"]  = visible, disabled until finish selected
 *
 *   Square shape → only 4" x 4" and 5" x 5" sizes available
 *   For 3" x 3" → try "Square - Rounded" or "Rectangle" shapes
 *   Product details section confirms 3" x 3" is supported (see shipping rules)
 *
 *   No qty field on configurator page — qty is set after upload.
 *   Best approach: configure form → read subtotal or look for per-roll price
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

const log  = m => console.log(`[gp5] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ss(page, name) {
  try { await page.screenshot({ path: path.join(SS_DIR, `${name}-${Date.now()}.png`) }); }
  catch (_) {}
}

async function main() {
  const raw  = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));
  const today = new Date().toISOString().split('T')[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const xhrLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com') && resp.status() < 400) {
      try {
        const body = await resp.text();
        xhrLog.push({ url: u, body: body.slice(0, 3000) });
        if (/price|total|amount|subtotal/i.test(body.slice(0, 500)) && u.includes('/service/rest/v1')) {
          log(`XHR: ${u.split('/v1/')[1]?.slice(0, 60)} → ${body.slice(0, 300)}`);
        }
      } catch (_) {}
    }
  });

  const result = {
    runs: [],   // array of {shape, size, paper, finish, subtotal, sizes_available}
    bestPrice: null,
    bestSpec:  null,
    configuratorUrl: 'https://www.gotprint.com/products/roll-labels/order'
  };

  const page = await context.newPage();

  // Helper: configure form by name attributes and return subtotal
  async function configureAndRead(shape, size, paper, finish) {
    const r = { shape, size, paper, finish, subtotal: null, sizeOptions: [], paperOptions: [], finishOptions: [], note: null };

    // Select shape
    const shapeEl = await page.$('select[name="shape"]');
    if (!shapeEl) { r.note = 'shape select not found'; return r; }
    const shapeOpts = await shapeEl.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
    const shapeOpt  = shapeOpts.find(o => o.t.toLowerCase() === shape.toLowerCase()) ||
                      shapeOpts.find(o => o.t.toLowerCase().includes(shape.toLowerCase()));
    if (!shapeOpt || shapeOpt.t === 'Please select an option') {
      r.note = `Shape "${shape}" not found. Available: ${shapeOpts.map(o => o.t).join(', ')}`;
      return r;
    }
    await shapeEl.selectOption({ value: shapeOpt.v });
    log(`  Selected shape: "${shapeOpt.t}"`);
    await wait(2500);

    // Read size options
    const sizeEl = await page.$('select[name="size"]');
    if (sizeEl) {
      const sizeOpts = await sizeEl.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      r.sizeOptions = sizeOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);
      log(`  Size options for ${shape}: ${r.sizeOptions.join(' | ')}`);

      // Select size
      const sizeOpt = sizeOpts.find(o => {
        const t = o.t.toLowerCase();
        const s = size.toLowerCase();
        return t === s || t.replace(/\s/g, '') === s.replace(/\s/g, '') ||
               t.includes(s) || (s === 'closest_to_3x3' && /3.*x.*3|3".*3"/i.test(t));
      }) || (size === 'largest' ? sizeOpts.filter(o => o.t !== 'Please select an option').slice(-1)[0] :
             size === 'closest_to_3x3' ? sizeOpts.filter(o => o.t !== 'Please select an option').find(o => {
               // Parse dimensions and find closest to 3x3
               const m = o.t.match(/([\d.]+)"?\s*x\s*([\d.]+)"/i) || o.t.match(/([\d.]+)"\s*Diameter/i);
               if (!m) return false;
               const w = parseFloat(m[1]), h = parseFloat(m[2] || m[1]);
               return Math.abs(w - 3) + Math.abs(h - 3) < 2;
             }) || sizeOpts.filter(o => o.t !== 'Please select an option')[0] :
             null);

      if (sizeOpt && sizeOpt.t !== 'Please select an option') {
        const disabled = await sizeEl.isDisabled().catch(() => false);
        if (!disabled) {
          await sizeEl.selectOption({ value: sizeOpt.v });
          r.size = sizeOpt.t;
          log(`  Selected size: "${sizeOpt.t}"`);
          await wait(2500);
        } else {
          r.note = 'Size select is disabled';
        }
      }
    }

    // Read paper options
    const paperEl = await page.$('select[name="paper"]');
    if (paperEl) {
      const paperOpts = await paperEl.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      r.paperOptions = paperOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);

      const disabled = await paperEl.isDisabled().catch(() => false);
      if (!disabled) {
        const paperOpt = paperOpts.find(o => o.t.toLowerCase().includes(paper.toLowerCase())) ||
                         paperOpts.find(o => /bopp/i.test(o.t)) ||
                         paperOpts.filter(o => o.t !== 'Please select an option')[0];
        if (paperOpt) {
          await paperEl.selectOption({ value: paperOpt.v });
          r.paper = paperOpt.t;
          log(`  Selected paper: "${paperOpt.t}"`);
          await wait(2000);
        }
      } else {
        log(`  Paper disabled. Available: ${r.paperOptions.join(', ')}`);
      }
    }

    // Read finish options
    const finishEl = await page.$('select[name="finish"]');
    if (finishEl) {
      const finishOpts = await finishEl.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      r.finishOptions = finishOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);

      const disabled = await finishEl.isDisabled().catch(() => false);
      if (!disabled) {
        const finishOpt = finishOpts.find(o => /matte/i.test(o.t)) ||
                          finishOpts.filter(o => o.t !== 'Please select an option')[0];
        if (finishOpt) {
          await finishEl.selectOption({ value: finishOpt.v });
          r.finish = finishOpt.t;
          log(`  Selected finish: "${finishOpt.t}"`);
          await wait(2000);
        }
      }
    }

    // Color (last one, auto-select first option)
    const colorEl = await page.$('select[name="color"]');
    if (colorEl) {
      const colorDisabled = await colorEl.isDisabled().catch(() => true);
      if (!colorDisabled) {
        const colorOpts = await colorEl.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
        const colorOpt  = colorOpts.find(o => o.t !== 'Please select an option');
        if (colorOpt) {
          await colorEl.selectOption({ value: colorOpt.v });
          log(`  Selected color: "${colorOpt.t}"`);
          await wait(2000);
        }
      }
    }

    await wait(1000);

    // Read subtotal
    r.subtotal = await page.evaluate(() => {
      // Find the subtotal value
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (/^\$[\d,]+\.\d{2}$/.test(t)) {
          const amt = parseFloat(t.replace(/[$,]/g, ''));
          if (amt > 0) return { text: t, amount: amt };
        }
      }
      // Look near "Subtotal" label
      const els = document.querySelectorAll('*');
      for (const el of els) {
        const t = el.textContent.trim();
        if (t.startsWith('$') && /^\$[\d,]+\.\d{2}/.test(t)) {
          const amt = parseFloat(t.replace(/[$,]/g, '').match(/[\d,]+\.\d{2}/)?.[0] || '0');
          if (amt > 0) return { text: t, amount: amt };
        }
      }
      return null;
    });
    log(`  Subtotal: ${JSON.stringify(r.subtotal)}`);

    // Check all XHR calls for pricing
    for (const xhr of xhrLog.slice(-5)) {
      try {
        const d = JSON.parse(xhr.body);
        if (d.totalPrice || d.price || d.subtotal || d.amount) {
          const price = d.totalPrice?.[0]?.price ?? d.price ?? d.subtotal ?? d.amount;
          if (price && price > 0) { r.xhrPrice = price; log(`  XHR price: $${price}`); }
        }
      } catch (_) {}
    }

    return r;
  }

  try {
    log('Loading GP configurator...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await wait(5000);
    await ss(page, 'gp5-01-loaded');

    if (page.url().includes('home.html')) {
      log('REDIRECT to home.html — confirmed blocker');
      result.runs.push({ shape: null, note: 'Redirected to home.html' });
    } else {
      log(`Loaded: "${await page.title()}" at ${page.url()}`);

      // Run 1: Square - Rounded + closest to 3×3
      log('\n─── Run 1: Square - Rounded shape ───');
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await wait(3000);
      const run1 = await configureAndRead('Square - Rounded', 'closest_to_3x3', 'white bopp', 'matte');
      result.runs.push(run1);
      await ss(page, 'gp5-02-sq-rounded');

      // Run 2: Rectangle + closest to 3×3
      log('\n─── Run 2: Rectangle shape ───');
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await wait(3000);
      const run2 = await configureAndRead('Rectangle', 'closest_to_3x3', 'white bopp', 'matte');
      result.runs.push(run2);
      await ss(page, 'gp5-03-rectangle');

      // Run 3: Square + largest available
      log('\n─── Run 3: Square shape ───');
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await wait(3000);
      const run3 = await configureAndRead('Square', 'largest', 'white bopp', 'matte');
      result.runs.push(run3);
      await ss(page, 'gp5-04-square');

      // Print all size options per shape
      for (const run of result.runs) {
        log(`Shape "${run.shape}" → sizes: ${run.sizeOptions?.join(' | ') || 'N/A'}`);
        log(`  selected size: ${run.size}, paper: ${run.paper}, finish: ${run.finish}`);
        log(`  subtotal: ${JSON.stringify(run.subtotal)}`);
      }

      // Find best price from runs
      for (const run of result.runs) {
        const price = run.subtotal?.amount || run.xhrPrice;
        if (price && price > 0) {
          if (!result.bestPrice || price > 0) {
            result.bestPrice = price;
            result.bestSpec  = run;
          }
        }
      }

      // ── Final: look for qty selector anywhere on the page (after full config) ──
      log('\n─── Looking for qty selector ───');
      await wait(1000);

      const allInputs = await page.$$('input, select');
      for (const inp of allInputs) {
        const visible = await inp.isVisible().catch(() => false);
        if (!visible) continue;
        const name = await inp.getAttribute('name') || await inp.getAttribute('id') || '';
        const placeholder = await inp.getAttribute('placeholder') || '';
        if (/qty|quantity|count|amount/i.test(name + placeholder)) {
          log(`  Found qty field: name="${name}" placeholder="${placeholder}"`);
          const val = await inp.inputValue().catch(() => '');
          log(`  Current value: "${val}"`);
        }
      }

      // ── Read product details from page for documentation ──
      const productDetails = await page.evaluate(() => {
        const section = document.querySelector('.product-detail, [class*="product-detail"], [class*="Product"]');
        return section?.textContent?.trim()?.slice(0, 1000) || null;
      });
      if (productDetails) log(`Product details: ${productDetails.slice(0, 500)}`);
    }

    // ── SUMMARY ──
    console.log('\n══════════════════════════════════════════');
    console.log(' GOTPRINT FINAL RESULT');
    console.log('══════════════════════════════════════════');
    console.log(`Configurator: https://www.gotprint.com/products/roll-labels/order`);
    for (const run of result.runs) {
      console.log(`  Shape="${run.shape}"`);
      console.log(`    Sizes available: ${run.sizeOptions?.join(' | ')}`);
      console.log(`    Selected: size="${run.size}" paper="${run.paper}" finish="${run.finish}"`);
      console.log(`    Subtotal: ${JSON.stringify(run.subtotal)}`);
      if (run.note) console.log(`    Note: ${run.note}`);
    }
    console.log(`Best price captured: ${result.bestPrice ? '$' + result.bestPrice : 'NONE'}`);
    console.log('══════════════════════════════════════════\n');

    // ── Update data files ──
    // Build a comprehensive entry documenting the GP configurator state
    const shapeToSizes = {};
    for (const run of result.runs) {
      if (run.shape) shapeToSizes[run.shape] = run.sizeOptions || [];
    }

    const gpEntry = {
      id: `gotprint-configurator-final-${today}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: today,
      capture_method: 'playwright_native_select_by_name',
      capture_source: 'automated_headless',
      confidence: result.bestPrice ? 'medium' : 'low',
      product_type: 'roll_labels',
      raw_spec_description: result.bestSpec ? `Roll Labels shape="${result.bestSpec.shape}" size="${result.bestSpec.size}" paper="${result.bestSpec.paper}" finish="${result.bestSpec.finish}"` : 'Configurator explored, price not captured',
      specs: result.bestSpec ? {
        shape: result.bestSpec.shape,
        size: result.bestSpec.size,
        material: result.bestSpec.paper,
        finish: result.bestSpec.finish,
        quantity: null
      } : {},
      pricing: {
        total_price: result.bestPrice,
        unit_price: null,
        currency: 'USD',
        turnaround_days: null,
        shipping_included: false,
        price_type: result.bestPrice ? 'configurator_dom_subtotal' : 'not_captured'
      },
      raw_snippet: `Shapes/sizes explored: ${JSON.stringify(shapeToSizes).slice(0, 500)}. Paper options: ${result.runs[0]?.paperOptions?.join(', ')}. Finish options: ${result.runs[0]?.finishOptions?.join(', ')}.`,
      notes: [
        'GP configurator at /products/roll-labels/order confirmed. Native <select> elements by name attribute.',
        `Shape options: Rectangle - Rounded, Square - Rounded, Arched, Circle, Heart, Starburst, Oval, Rectangle, Square.`,
        `Square shape sizes: ${shapeToSizes['Square']?.join(', ') || '?'}.`,
        `Square-Rounded shape sizes: ${shapeToSizes['Square - Rounded']?.join(', ') || '?'}.`,
        `Rectangle shape sizes: ${shapeToSizes['Rectangle']?.join(', ') || '?'}.`,
        `Paper options: Clear BOPP Label, White BOPP Label, White Vinyl Label, White Removable Label, Clear Removable Label, Silver Foil BOPP Label, White Textured, Cream Laid Textured, White Laid Textured.`,
        `Finish options: Clear Gloss Laminate (Indoor), Clear Gloss Laminate (Outdoor), Matte Finish (Indoor).`,
        `NOTE: No qty selector on configurator page — qty is entered after clicking "Upload Front" or "Design Online".`,
        `Shipping rules from product details: 0.5" x 0.5" - 3" x 3" = up to 1000 qty/roll. 3" x 3" IS a supported size.`,
        `To get exact price: complete full flow on /products/roll-labels/order → Upload → enter qty 5000.`
      ].join(' '),
      blocker: result.bestPrice ? null : 'Qty selector only appears in upload/design flow — subtotal shows $0.00 until artwork uploaded. Manual flow required for price with qty.',
      next_step: 'Manual browser: go to gotprint.com/products/roll-labels/order, select Square (or Square-Rounded) + size closest to 3×3 + White BOPP + Matte, click Upload Front (use any placeholder image), enter qty 5000, capture price.'
    };

    const idx = raw.captures.findIndex(c => c.id === gpEntry.id);
    if (idx >= 0) raw.captures[idx] = gpEntry; else raw.captures.push(gpEntry);

    // Update coverage summary
    raw.capture_coverage_summary.gotprint = {
      status: 'partial',
      confidence: 'medium',
      last_method: 'playwright_native_select_by_name',
      notes: `Configurator confirmed at /products/roll-labels/order. Shapes: ${Object.keys(shapeToSizes).join(', ')}. Sizes for Square: ${shapeToSizes['Square']?.join(', ')}. Sizes for Square-Rounded: ${shapeToSizes['Square - Rounded']?.join(', ')}. Sizes for Rectangle: ${shapeToSizes['Rectangle']?.join(', ')}. Paper: White BOPP Label available. Finish: Matte Finish (Indoor) available. Qty selector only in upload flow. Price not captured without upload. Manual flow required: /products/roll-labels/order → upload → qty 5000.`,
      configurator_url: 'https://www.gotprint.com/products/roll-labels/order',
      shapes_available: ['Rectangle - Rounded', 'Square - Rounded', 'Arched', 'Circle', 'Heart', 'Starburst', 'Oval', 'Rectangle', 'Square'],
      paper_options: ['Clear BOPP Label', 'White BOPP Label', 'White Vinyl Label', 'White Removable Label', 'Clear Removable Label', 'Silver Foil BOPP Label'],
      finish_options: ['Clear Gloss Laminate (Indoor)', 'Clear Gloss Laminate (Outdoor)', 'Matte Finish (Indoor)']
    };

    // Update normalized
    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
      const gpNorm = {
        competitor: 'gotprint',
        competitor_display: 'GotPrint',
        status: 'partial',
        coverage: 'near_spec_no_qty',
        total_price: result.bestPrice,
        unit_price: null,
        currency: 'USD',
        shipping_included: false,
        confidence: 'low',
        notes: `Configurator at /products/roll-labels/order confirmed. White BOPP + Matte Finish available. Closest shape to square: "Square - Rounded" (${shapeToSizes['Square - Rounded']?.join(', ')}) or "Square" (${shapeToSizes['Square']?.join(', ')}). No 3×3 option found for Square. Qty not configurable without upload. Full price requires manual flow.`,
        closest_data_point: {
          description: `GP roll labels best available: shape=${result.bestSpec?.shape}, size=${result.bestSpec?.size}, paper=${result.bestSpec?.paper}, finish=${result.bestSpec?.finish}`,
          price: result.bestPrice,
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
    err(`Fatal: ${e.message}\n${e.stack}`);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
