#!/usr/bin/env node
/**
 * capture-vp-size-confirm.js
 *
 * TARGET: Confirm Vistaprint 3×3 size encoding for Rounded Square Roll Labels
 *
 * QUESTION: Does selecting "Rounded Square" on VP's roll labels page expose
 * size (width/height) inputs? If yes, does filling them with 3×3 produce a
 * Cimpress XHR that encodes `selections[Custom Width]=3` and `selections[Custom Height]=3`?
 *
 * PRIOR STATE:
 *  - Cimpress API call with injected W=3/H=3 returned $544.86 for 5000 qty
 *  - Shape "Rounded Square" confirmed via label force-click
 *  - No size input fields appeared in previous headless run after shape click
 *  - Previous Node.js-side Cimpress call added Width/Height params manually
 *  - Need to know if VP treats Rounded Square as a FIXED 3×3 size, or if
 *    user must specify custom dimensions
 *
 * APPROACH:
 *  1. Load VP roll labels page, intercept ALL Cimpress XHR
 *  2. Select "Rounded Square" shape, wait for Cimpress calls
 *  3. Scan DOM for any width/height/dimension inputs that appeared
 *  4. If found: fill 3" × 3", wait for XHR, inspect URL params
 *  5. Also hit Cimpress directly from Node.js side with correct pricingContext
 *     for qty=5000 with Rounded Square shape to confirm $544.86
 *  6. Report: is size user-specified or fixed? what does the XHR encode?
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');

const log  = m => console.log(`[vp-confirm] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().split('T')[0];
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function main() {
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const cimpressCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('cimpress.io') && !u.includes('vistaprint') && !u.includes('vpsvc')) return;
    try {
      const body = await resp.text();
      cimpressCaptures.push({ url: u, status: resp.status(), body });
    } catch (_) {}
  });

  const result = {
    sizeInputsFound: false,
    sizeInputDetails: null,
    cimpressCallsAfterShape: [],
    pricingContextToken: null,
    price5000RoundedSquare: null,
    price5000WithSize: null,
    sizeEncodedInXhr: false,
    conclusion: null,
  };

  const page = await context.newPage();
  try {
    log('Loading VP roll labels page...');
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });
    await wait(8000);
    log(`URL: ${page.url()} | Title: "${await page.title()}"`);

    const capturesBefore = cimpressCaptures.length;

    // ── Step 1: Find and click the Rounded Square option ──
    const shapeClicked = await page.evaluate(() => {
      // VP uses radio inputs or labels for shape selection
      const labels = [...document.querySelectorAll('label, button, [role="radio"], input[type="radio"]')];
      const rsLabel = labels.find(el => {
        const t = (el.textContent || el.getAttribute('aria-label') || el.value || '').toLowerCase();
        return t.includes('rounded square') || (t.includes('rounded') && t.includes('square'));
      });
      if (rsLabel) {
        rsLabel.click();
        return { found: true, tag: rsLabel.tagName, text: rsLabel.textContent?.trim().slice(0, 50), id: rsLabel.id };
      }

      // Also try: look for image-based selectors (VP sometimes uses radio + img)
      const radios = [...document.querySelectorAll('input[type="radio"]')];
      for (const r of radios) {
        const lbl = document.querySelector(`label[for="${r.id}"]`);
        const t = (lbl?.textContent || r.value || '').toLowerCase();
        if (t.includes('rounded') && t.includes('square')) {
          r.click();
          return { found: true, via: 'radio', id: r.id, value: r.value };
        }
      }

      // Last resort: force-click any element with rounded square text
      const allEls = [...document.querySelectorAll('*')];
      for (const el of allEls) {
        if (el.children.length === 0) {
          const t = el.textContent?.trim().toLowerCase() || '';
          if (t === 'rounded square' || t === 'rounded-square') {
            el.click();
            return { found: true, via: 'text-node', tag: el.tagName, text: el.textContent?.trim() };
          }
        }
      }

      return {
        found: false,
        allLabels: labels.slice(0, 20).map(l => l.textContent?.trim().slice(0, 30))
      };
    });
    log(`Shape click result: ${JSON.stringify(shapeClicked)}`);

    if (!shapeClicked.found) {
      // Try using page.click() with text selector
      try {
        await page.click('text=Rounded Square', { force: true, timeout: 5000 });
        log('Clicked via text selector: "Rounded Square"');
      } catch (_) {
        log('Could not find Rounded Square option — trying to list all shape-related elements');
        const shapeEls = await page.evaluate(() => {
          const all = [...document.querySelectorAll('[class*="shape"], [data-testid*="shape"], [aria-label*="shape"]')];
          return all.slice(0, 10).map(el => ({
            tag: el.tagName,
            text: el.textContent?.trim().slice(0, 40),
            class: el.className?.slice(0, 50)
          }));
        });
        log(`Shape elements: ${JSON.stringify(shapeEls)}`);
      }
    }

    await wait(5000);

    // ── Step 2: Scan DOM for size/dimension inputs after shape selection ──
    const domScan = await page.evaluate(() => {
      const findings = {
        widthInputs: [],
        heightInputs: [],
        dimensionInputs: [],
        sizeSelects: [],
        allInputs: []
      };

      // Width inputs
      const wInputs = [...document.querySelectorAll('input')].filter(el => {
        const attrs = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].map(a => (a || '').toLowerCase());
        return attrs.some(a => a.includes('width') || a.includes('custom width') || a === 'w');
      });
      findings.widthInputs = wInputs.map(el => ({ tag: el.tagName, name: el.name, id: el.id, value: el.value, placeholder: el.placeholder, visible: el.offsetWidth > 0 }));

      // Height inputs
      const hInputs = [...document.querySelectorAll('input')].filter(el => {
        const attrs = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].map(a => (a || '').toLowerCase());
        return attrs.some(a => a.includes('height') || a === 'h');
      });
      findings.heightInputs = hInputs.map(el => ({ tag: el.tagName, name: el.name, id: el.id, value: el.value, placeholder: el.placeholder, visible: el.offsetWidth > 0 }));

      // Size-related selects
      const sizeSelects = [...document.querySelectorAll('select')].filter(el => {
        const t = (el.name + el.id + (el.getAttribute('aria-label') || '')).toLowerCase();
        return t.includes('size') || t.includes('dimension');
      });
      findings.sizeSelects = sizeSelects.map(sel => ({
        name: sel.name, id: sel.id,
        options: [...sel.options].map(o => o.text.trim()).slice(0, 10)
      }));

      // All visible inputs for inspection
      findings.allInputs = [...document.querySelectorAll('input')].filter(el => el.offsetWidth > 0).map(el => ({
        name: el.name, id: el.id, type: el.type, placeholder: el.placeholder, value: el.value,
        'aria-label': el.getAttribute('aria-label')
      })).slice(0, 20);

      return findings;
    });

    log(`DOM scan after Rounded Square click:`);
    log(`  Width inputs: ${JSON.stringify(domScan.widthInputs)}`);
    log(`  Height inputs: ${JSON.stringify(domScan.heightInputs)}`);
    log(`  Size selects: ${JSON.stringify(domScan.sizeSelects)}`);
    log(`  All visible inputs: ${JSON.stringify(domScan.allInputs)}`);

    result.sizeInputsFound = domScan.widthInputs.length > 0 || domScan.heightInputs.length > 0 || domScan.sizeSelects.length > 0;
    result.sizeInputDetails = domScan;

    // ── Step 3: Check Cimpress calls that fired after shape click ──
    const capturesAfterShape = cimpressCaptures.slice(capturesBefore);
    log(`\nCimpress calls after shape click: ${capturesAfterShape.length}`);
    for (const cap of capturesAfterShape) {
      const parsedUrl = new URL(cap.url);
      const params = {};
      parsedUrl.searchParams.forEach((v, k) => { params[k] = v; });
      log(`  ${parsedUrl.pathname}`);
      log(`  params: ${JSON.stringify(params).slice(0, 500)}`);
      result.cimpressCallsAfterShape.push({ path: parsedUrl.pathname, params, status: cap.status });

      // Extract pricingContext for later use
      if (params.pricingContext && !result.pricingContextToken) {
        result.pricingContextToken = params.pricingContext;
        log(`  *** pricingContext captured: ${params.pricingContext.slice(0, 40)}...`);
      }

      // Check if size/width/height are encoded
      const hasWidth  = params['selections[Custom Width]'] || params['Width'] || params['width'];
      const hasHeight = params['selections[Custom Height]'] || params['Height'] || params['height'];
      if (hasWidth || hasHeight) {
        result.sizeEncodedInXhr = true;
        log(`  *** Size found in XHR: Width=${hasWidth} Height=${hasHeight} ***`);
      }

      // Parse prices if this is a pricing call
      if (parsedUrl.pathname.includes('price') && cap.status === 200) {
        try {
          const d = JSON.parse(cap.body);
          if (d.estimatedPrices) {
            log(`  Prices: ${JSON.stringify(Object.fromEntries(Object.entries(d.estimatedPrices).map(([q, p]) => [q, p.totalListPrice?.untaxed || p.totalListPrice])))}`);
          }
        } catch (_) {}
      }
    }

    // ── Step 4: If size inputs exist, fill them and trigger XHR ──
    if (result.sizeInputsFound && (domScan.widthInputs.length > 0 || domScan.heightInputs.length > 0)) {
      log('\nFilling size inputs with 3" × 3"...');
      const fillResult = await page.evaluate(() => {
        const wEl = document.querySelector('input[name*="width" i], input[id*="width" i], input[placeholder*="width" i]');
        const hEl = document.querySelector('input[name*="height" i], input[id*="height" i], input[placeholder*="height" i]');

        if (wEl) {
          wEl.value = '3';
          wEl.dispatchEvent(new Event('input', { bubbles: true }));
          wEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (hEl) {
          hEl.value = '3';
          hEl.dispatchEvent(new Event('input', { bubbles: true }));
          hEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { wFilled: !!wEl, hFilled: !!hEl };
      });
      log(`Fill result: ${JSON.stringify(fillResult)}`);
      await wait(4000);

      // Check new Cimpress calls
      const capturesAfterSize = cimpressCaptures.slice(capturesBefore + capturesAfterShape.length);
      log(`Cimpress calls after size input: ${capturesAfterSize.length}`);
      for (const cap of capturesAfterSize) {
        const parsedUrl = new URL(cap.url);
        const params = {};
        parsedUrl.searchParams.forEach((v, k) => { params[k] = v; });
        const hasWidth  = params['selections[Custom Width]'] || params['Width'];
        const hasHeight = params['selections[Custom Height]'] || params['Height'];
        if (hasWidth || hasHeight) {
          result.sizeEncodedInXhr = true;
          log(`*** CONFIRMED: Size 3×3 in Cimpress XHR: Width=${hasWidth} Height=${hasHeight} ***`);
        }
        log(`  params: ${JSON.stringify(params).slice(0, 400)}`);
      }
    }

    // ── Step 5: Hit Cimpress directly from Node.js for qty=5000 ──
    // Use the captured pricingContext to make a Node.js-side request (bypasses CORS)
    if (result.pricingContextToken) {
      log('\nHitting Cimpress directly for qty=5000 with Rounded Square...');
      const qty5000Url = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?` +
        `requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=1000,2000,5000,10000&` +
        `pricingContext=${encodeURIComponent(result.pricingContextToken)}&merchantId=vistaprint&` +
        `selections%5BRoll%20Finishing%20Type%5D=Slit%20Roll&` +
        `selections%5BShape%5D=Rounded%20Square&market=US&optionalPriceComponents=UnitPrice`;

      const directResult = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          return { status: r.status, body: await r.text() };
        } catch(e) { return { error: e.message }; }
      }, qty5000Url);

      log(`Direct Cimpress result: status=${directResult.status}`);
      if (directResult.status === 200) {
        try {
          const d = JSON.parse(directResult.body);
          if (d.estimatedPrices) {
            for (const [qty, priceData] of Object.entries(d.estimatedPrices)) {
              const total = priceData.totalListPrice?.untaxed ?? priceData.totalListPrice;
              const unit  = priceData.unitListPrice?.untaxed  ?? priceData.unitListPrice;
              log(`  qty ${qty}: $${total} ($${unit}/ea)`);
              if (qty === '5000') result.price5000RoundedSquare = total;
            }
          }
        } catch(e) { log(`  Parse error: ${e.message}`); }
      }

      // Also try WITH explicit 3×3 size params (the approach that returned $544.86 previously)
      log('\nHitting Cimpress with explicit W=3/H=3 for 5000 qty...');
      const qty5000WithSizeUrl = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?` +
        `requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=5000&` +
        `pricingContext=${encodeURIComponent(result.pricingContextToken)}&merchantId=vistaprint&` +
        `selections%5BRoll%20Finishing%20Type%5D=Slit%20Roll&` +
        `selections%5BShape%5D=Rounded%20Square&` +
        `selections%5BCustom%20Width%5D=3&selections%5BCustom%20Height%5D=3&` +
        `market=US&optionalPriceComponents=UnitPrice`;

      const directWithSize = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          return { status: r.status, body: await r.text() };
        } catch(e) { return { error: e.message }; }
      }, qty5000WithSizeUrl);

      log(`Direct Cimpress (with 3×3) status=${directWithSize.status}`);
      if (directWithSize.status === 200) {
        try {
          const d = JSON.parse(directWithSize.body);
          if (d.estimatedPrices) {
            const ep5k = d.estimatedPrices['5000'];
            if (ep5k) {
              const total = ep5k.totalListPrice?.untaxed ?? ep5k.totalListPrice;
              const unit  = ep5k.unitListPrice?.untaxed  ?? ep5k.unitListPrice;
              log(`  qty 5000 with 3×3 size: $${total} ($${unit}/ea)`);
              result.price5000WithSize = total;
            }
          }
        } catch(e) { log(`  Parse error: ${e.message}`); }
      }
    } else {
      log('\nNo pricingContext captured — cannot make direct Cimpress call');
      // Try the hardcoded token from a prior run as a fallback
      // (Note: these tokens expire; this is best-effort only)
    }

  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // ── Conclusion ──
  console.log('\n═══════════════════════════════════════════════');
  console.log(' VISTAPRINT 3×3 SIZE CONFIRMATION RESULTS');
  console.log('═══════════════════════════════════════════════');
  console.log(`Size inputs appeared after Rounded Square click: ${result.sizeInputsFound}`);
  console.log(`  Width inputs: ${JSON.stringify(result.sizeInputDetails?.widthInputs)}`);
  console.log(`  Height inputs: ${JSON.stringify(result.sizeInputDetails?.heightInputs)}`);
  console.log(`Size encoded in Cimpress XHR: ${result.sizeEncodedInXhr}`);
  console.log(`Cimpress calls intercepted after shape click: ${result.cimpressCallsAfterShape.length}`);
  console.log(`Price at 5000 (Rounded Square, no explicit size): ${result.price5000RoundedSquare ? '$' + result.price5000RoundedSquare : 'N/A'}`);
  console.log(`Price at 5000 (Rounded Square + W=3/H=3 injected): ${result.price5000WithSize ? '$' + result.price5000WithSize : 'N/A'}`);
  console.log('');

  // Determine conclusion
  if (result.sizeEncodedInXhr) {
    result.conclusion = 'CONFIRMED: VP Rounded Square exposes size inputs. 3×3 is properly encoded in Cimpress XHR. $' + (result.price5000WithSize || '?') + ' is a valid exact-match price.';
  } else if (result.price5000WithSize) {
    result.conclusion = 'DIRECTIONAL: Size inputs not confirmed in DOM but Cimpress API accepts W=3/H=3 alongside Rounded Square. $' + result.price5000WithSize + ' returned — verify in DevTools whether pricingContext encodes dimensions.';
  } else if (!result.pricingContextToken) {
    result.conclusion = 'INCONCLUSIVE: No pricingContext captured — VP may have blocked headless session or page structure changed. Manual DevTools verification required.';
  } else {
    result.conclusion = 'PARTIAL: Rounded Square shape clickable, Cimpress XHR captured, but no size inputs appeared and W=3/H=3 injection not confirmed. Manual DevTools run required.';
  }

  console.log('CONCLUSION: ' + result.conclusion);
  console.log('═══════════════════════════════════════════════\n');

  // ── Update normalized JSON with latest finding ──
  if (result.price5000WithSize || result.price5000RoundedSquare) {
    const t = today();
    const price = result.price5000WithSize || result.price5000RoundedSquare;
    const coverage = result.sizeEncodedInXhr ? 'exact_spec' : 'size_unconfirmed';
    const status   = result.sizeEncodedInXhr ? 'live' : 'partial';

    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const vi = q.competitor_results.findIndex(r => r.competitor === 'vistaprint');
      const vpUpdate = {
        competitor: 'vistaprint',
        competitor_display: 'Vistaprint',
        status,
        coverage,
        total_price: parseFloat(price),
        unit_price: parseFloat((price / 5000).toFixed(6)),
        currency: 'USD',
        notes: result.conclusion,
        closest_data_point: {
          description: 'Roll Labels Rounded Square, 3" × 3", 5,000 qty via Cimpress pricing API',
          total_price: parseFloat(price),
          quantity: 5000,
          spec_delta: result.sizeEncodedInXhr ? 'exact match' : '3x3 size injected via API — DOM not confirmed',
          confidence: result.sizeEncodedInXhr ? 'high' : 'medium'
        }
      };
      if (vi >= 0) Object.assign(q.competitor_results[vi], vpUpdate);
      else q.competitor_results.push(vpUpdate);
      norm.last_updated = t;
      fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
      log('✓ Updated normalized JSON: 3x3-5000-matte-bopp-cmyk / vistaprint');
    }
  }
}

main().catch(e => { err(e.message + '\n' + e.stack); process.exit(1); });
