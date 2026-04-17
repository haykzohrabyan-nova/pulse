/**
 * capture-packaging-pass.js
 * NOV-9: Capture competitor pricing for folding cartons and stand-up pouches
 * Also: confirm Vistaprint 3×3/5k label exact size, get UPrinting additional label points
 *
 * Targets:
 *   1. UPrinting folding cartons (straight tuck end box)
 *   2. UPrinting stand-up pouches
 *   3. GotPrint folding cartons
 *   4. Vistaprint roll labels 3×3/5k (confirm size via Cimpress API with DOM selection)
 *   5. UPrinting label pricing — more qty points (2×2 at additional qtys)
 *
 * Run: node capture-packaging-pass.js
 */

const { chromium } = require('playwright');

const RESULTS = [];
const ERRORS = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function recordResult(entry) {
  RESULTS.push(entry);
  log(`CAPTURED: ${JSON.stringify(entry)}`);
}

function recordError(site, step, error) {
  const entry = { site, step, error: String(error) };
  ERRORS.push(entry);
  log(`ERROR [${site}/${step}]: ${error}`);
}

// ─── 1. UPrinting — Folding Cartons ─────────────────────────────────────────
async function captureUPrintingBoxes(browser) {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await context.newPage();

  // Intercept XHR/fetch for pricing API calls
  const priceResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('price') || url.includes('quote') || url.includes('calc') || url.includes('product')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) priceResponses.push({ url, status: resp.status(), body: text.slice(0, 2000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('UP Boxes: loading product-boxes page...');
    await page.goto('https://www.uprinting.com/product-boxes.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Try to extract __NEXT_DATA__ or Angular scope or any price data
    const nextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        if (el) return { type: 'next', data: JSON.parse(el.textContent) };
      } catch (e) {}
      return null;
    });

    if (nextData) {
      log(`UP Boxes: found __NEXT_DATA__ — ${JSON.stringify(nextData).slice(0, 500)}`);
    }

    // Try to get any prices visible on page
    const pageText = await page.evaluate(() => document.body.innerText);
    const priceMatches = pageText.match(/\$[\d,]+\.?\d*/g) || [];
    log(`UP Boxes: visible prices on product-boxes page: ${JSON.stringify(priceMatches.slice(0, 20))}`);

    // Navigate to straight tuck end boxes
    log('UP Boxes: loading straight-tuck-end-boxes page...');
    await page.goto('https://www.uprinting.com/straight-tuck-end-boxes.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Try to find an Angular scope or configurator
    const steData = await page.evaluate(() => {
      const results = {};
      // Try Angular
      try {
        const els = document.querySelectorAll('[ng-controller], [data-ng-controller], #calc_box, .calc-box, [id*="calc"]');
        results.angularEls = Array.from(els).map(e => ({ tag: e.tagName, id: e.id, class: e.className })).slice(0, 5);
      } catch (e) {}

      // Try to find any price display
      const priceEls = document.querySelectorAll('[class*="price"], [id*="price"], .total, [class*="total"]');
      results.priceEls = Array.from(priceEls).map(e => ({ tag: e.tagName, id: e.id, class: e.className, text: e.textContent.trim() })).slice(0, 10);

      // Get all text with dollar amounts
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const priceTexts = [];
      let node;
      while (node = walker.nextNode()) {
        if (/\$\d/.test(node.textContent)) {
          priceTexts.push(node.textContent.trim());
        }
      }
      results.priceTexts = priceTexts.slice(0, 20);

      return results;
    });
    log(`UP Boxes STE data: ${JSON.stringify(steData).slice(0, 1000)}`);

    // Try to interact with a quantity selector if present
    const qtyOptions = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ value: o.value, text: o.text })).slice(0, 20)
      }));
    });
    log(`UP Boxes: selects found: ${JSON.stringify(qtyOptions).slice(0, 1000)}`);

    // Check intercepted API responses
    if (priceResponses.length > 0) {
      log(`UP Boxes: intercepted ${priceResponses.length} pricing API calls`);
      priceResponses.slice(0, 5).forEach(r => {
        log(`  URL: ${r.url}`);
        log(`  Body: ${r.body.slice(0, 300)}`);
      });
    }

    recordResult({
      site: 'UPrinting',
      product_type: 'folding_cartons',
      status: 'investigation',
      page_prices: steData.priceTexts || [],
      api_responses: priceResponses.slice(0, 3).map(r => ({ url: r.url, body: r.body.slice(0, 200) })),
      notes: 'STE page loaded — see api_responses and page_prices for raw data'
    });

  } catch (e) {
    recordError('UPrinting-boxes', 'page-load', e);
  } finally {
    await context.close();
  }
}

// ─── 2. UPrinting — Stand-Up Pouches ────────────────────────────────────────
async function captureUPrintingPouches(browser) {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await context.newPage();

  const priceResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('price') || url.includes('quote') || url.includes('calc') || url.includes('pouch')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) priceResponses.push({ url, status: resp.status(), body: text.slice(0, 3000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('UP Pouches: loading custom-stand-up-pouches page...');
    await page.goto('https://www.uprinting.com/custom-stand-up-pouches.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const pouchData = await page.evaluate(() => {
      const results = {};
      // Angular scope check
      try {
        const calcEls = document.querySelectorAll('[id*="calc"], [class*="calc"], [ng-app]');
        results.calcEls = Array.from(calcEls).map(e => ({ id: e.id, class: e.className })).slice(0, 5);

        // Try to find Angular scope with pricing
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          try {
            if (typeof angular !== 'undefined') {
              const scope = angular.element(el).scope();
              if (scope && scope.priceData) {
                results.angularScope = { priceData: scope.priceData, qty: scope.qty };
                break;
              }
            }
          } catch (e2) {}
        }
      } catch (e) {}

      // Price texts
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const priceTexts = [];
      let node;
      while (node = walker.nextNode()) {
        if (/\$\d/.test(node.textContent)) {
          priceTexts.push(node.textContent.trim());
        }
      }
      results.priceTexts = priceTexts.slice(0, 25);

      // Selects
      results.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ value: o.value, text: o.text })).slice(0, 20)
      }));

      return results;
    });
    log(`UP Pouches data: ${JSON.stringify(pouchData).slice(0, 1500)}`);

    // If Angular with price grid exists, try clicking qty options
    if (pouchData.priceTexts && pouchData.priceTexts.length > 0) {
      log(`UP Pouches: found prices: ${JSON.stringify(pouchData.priceTexts)}`);
    }

    recordResult({
      site: 'UPrinting',
      product_type: 'stand_up_pouches',
      status: 'investigation',
      page_prices: pouchData.priceTexts || [],
      selects: pouchData.selects || [],
      api_responses: priceResponses.slice(0, 3).map(r => ({ url: r.url, body: r.body.slice(0, 300) })),
      notes: 'Pouch page loaded — see page_prices'
    });

  } catch (e) {
    recordError('UPrinting-pouches', 'page-load', e);
  } finally {
    await context.close();
  }
}

// ─── 3. GotPrint — Folding Cartons ──────────────────────────────────────────
async function captureGotPrintBoxes(browser) {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await context.newPage();

  const priceResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('price') || url.includes('quantity') || url.includes('quantities') || url.includes('option')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) priceResponses.push({ url, status: resp.status(), body: text.slice(0, 3000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('GP Boxes: loading folding-cartons order page...');
    // First try the product listing to find the right URL
    await page.goto('https://www.gotprint.com/products/folding-cartons/order', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const gpBoxData = await page.evaluate(() => {
      const results = {};
      // Check Vue app
      results.hasVue = typeof Vue !== 'undefined';

      // Get selects
      results.selects = Array.from(document.querySelectorAll('select[name]')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ value: o.value, text: o.text.trim() })).slice(0, 20)
      }));

      // Price texts
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const priceTexts = [];
      let node;
      while (node = walker.nextNode()) {
        if (/\$\d/.test(node.textContent)) {
          priceTexts.push(node.textContent.trim());
        }
      }
      results.priceTexts = priceTexts.slice(0, 20);
      results.pageTitle = document.title;
      results.h1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim());

      return results;
    });
    log(`GP Boxes data: ${JSON.stringify(gpBoxData).slice(0, 1500)}`);

    if (gpBoxData.selects && gpBoxData.selects.length > 0) {
      log(`GP Boxes: found selects — trying to cascade through spec`);

      // Try shape/size/paper/finish cascade (same pattern as labels)
      const shapeSelect = gpBoxData.selects.find(s => s.name === 'shape' || s.name === 'style' || s.name === 'box_style');
      if (shapeSelect) {
        log(`GP Boxes: shape/style select found: ${JSON.stringify(shapeSelect)}`);

        // Try first option
        if (shapeSelect.options && shapeSelect.options.length > 1) {
          const firstVal = shapeSelect.options[1].value;
          await page.evaluate((name, val) => {
            const sel = document.querySelector(`select[name="${name}"]`);
            if (sel) {
              sel.value = val;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, shapeSelect.name, firstVal);
          await page.waitForTimeout(2000);
        }
      }

      // After cascading, check for updated prices
      const updatedPrices = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const priceTexts = [];
        let node;
        while (node = walker.nextNode()) {
          if (/\$\d/.test(node.textContent)) {
            priceTexts.push(node.textContent.trim());
          }
        }
        // Also get quantity options
        const qtySelect = document.querySelector('select[name="quantity"], select[name="qty"]');
        return {
          prices: priceTexts.slice(0, 20),
          qtyOptions: qtySelect ? Array.from(qtySelect.options).map(o => ({ v: o.value, t: o.text.trim() })) : []
        };
      });
      log(`GP Boxes after cascade: ${JSON.stringify(updatedPrices)}`);
    }

    recordResult({
      site: 'GotPrint',
      product_type: 'folding_cartons',
      status: 'investigation',
      page_data: gpBoxData,
      api_responses: priceResponses.slice(0, 5).map(r => ({ url: r.url, body: r.body.slice(0, 400) })),
      notes: 'Folding carton configurator probed'
    });

  } catch (e) {
    recordError('GotPrint-boxes', 'page-load', e);
  } finally {
    await context.close();
  }
}

// ─── 4. Vistaprint — Roll Labels 3×3/5k (confirm size) ──────────────────────
async function captureVistaprintLabels(browser) {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await context.newPage();

  const priceResponses = [];
  context.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('cimpress') || url.includes('pricing') || url.includes('vistaprint') && url.includes('price')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text && text.includes('Price')) {
            priceResponses.push({ url, status: resp.status(), body: text.slice(0, 3000) });
          }
        }
      } catch (e) {}
    }
  });

  try {
    log('VP Labels: loading roll-labels page...');
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Look for shape radio buttons (Rounded Square)
    const radioData = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      return radios.map(r => ({
        id: r.id, name: r.name, value: r.value,
        label: (() => {
          const lbl = document.querySelector(`label[for="${r.id}"]`);
          return lbl ? lbl.textContent.trim() : '';
        })()
      })).slice(0, 30);
    });
    log(`VP Labels: radio inputs: ${JSON.stringify(radioData).slice(0, 1000)}`);

    // Find shape selection buttons/radios
    const shapeEls = await page.evaluate(() => {
      // Look for shape selector elements
      const els = Array.from(document.querySelectorAll('[data-testid*="shape"], [class*="shape"], button[data-value*="shape"], [aria-label*="shape"]'));
      return els.map(e => ({ tag: e.tagName, text: e.textContent.trim(), attr: e.getAttribute('data-testid') || e.getAttribute('aria-label') || '' })).slice(0, 20);
    });
    log(`VP Labels: shape elements: ${JSON.stringify(shapeEls).slice(0, 500)}`);

    // Try clicking "Rounded Square" or "Custom Size" if found
    const roundedSquareRadio = radioData.find(r => r.label.toLowerCase().includes('rounded') || r.label.toLowerCase().includes('square'));
    if (roundedSquareRadio) {
      log(`VP Labels: found Rounded Square radio — clicking: ${JSON.stringify(roundedSquareRadio)}`);
      await page.click(`label[for="${roundedSquareRadio.id}"]`, { force: true }).catch(e => log(`VP click err: ${e}`));
      await page.waitForTimeout(3000);
    }

    // Check for size inputs after shape selection
    const sizeInputs = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="number"], input[placeholder*="width"], input[placeholder*="height"], input[name*="width"], input[name*="height"]'));
      return inputs.map(i => ({ name: i.name, placeholder: i.placeholder, value: i.value, id: i.id }));
    });
    log(`VP Labels: size inputs after shape click: ${JSON.stringify(sizeInputs)}`);

    // If size inputs found, try setting 3×3
    if (sizeInputs.length > 0) {
      for (const input of sizeInputs) {
        if (input.name.includes('width') || input.placeholder.toLowerCase().includes('width')) {
          await page.fill(`input[name="${input.name}"]`, '3').catch(() => {});
        }
        if (input.name.includes('height') || input.placeholder.toLowerCase().includes('height')) {
          await page.fill(`input[name="${input.name}"]`, '3').catch(() => {});
        }
      }
      await page.waitForTimeout(3000);
    }

    // Check intercepted Cimpress calls
    log(`VP Labels: intercepted ${priceResponses.length} pricing responses`);
    priceResponses.forEach(r => {
      log(`  Cimpress URL: ${r.url}`);
      log(`  Body: ${r.body.slice(0, 500)}`);
    });

    // Get current page prices
    const vpPrices = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const priceTexts = [];
      let node;
      while (node = walker.nextNode()) {
        if (/\$\d+\.\d{2}/.test(node.textContent)) {
          priceTexts.push(node.textContent.trim());
        }
      }
      return priceTexts.slice(0, 20);
    });
    log(`VP Labels: page prices: ${JSON.stringify(vpPrices)}`);

    // Try to use the Cimpress Node.js direct request for 3×3/5k
    // Known from previous capture: PRD-DF5PWTHC is the roll labels product key
    const cimpressUrl = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=5000&merchantId=vistaprint&market=US&optionalPriceComponents=UnitPrice&selections[Shape]=Rounded%20Square&selections[Roll%20Finishing%20Type]=Slit%20Roll&selections[Custom%20Width]=3&selections[Custom%20Height]=3`;

    log(`VP Labels: trying direct Cimpress request...`);
    const cimpressResp = await context.request.get(cimpressUrl).catch(e => null);
    if (cimpressResp) {
      const cimpressBody = await cimpressResp.text().catch(() => null);
      log(`VP Labels Cimpress direct (3×3/5k): status=${cimpressResp.status()} body=${cimpressBody ? cimpressBody.slice(0, 1000) : 'null'}`);

      if (cimpressBody && cimpressResp.status() === 200) {
        try {
          const parsed = JSON.parse(cimpressBody);
          const p5k = parsed.estimatedPrices && parsed.estimatedPrices['5000'];
          if (p5k) {
            recordResult({
              id: 'vp-3x3-5000-confirmed',
              site: 'Vistaprint',
              product_type: 'roll_labels',
              w: 3, h: 3, qty: 5000,
              total_price: p5k.totalListPrice ? p5k.totalListPrice.untaxed : null,
              unit_price: p5k.unitListPrice ? p5k.unitListPrice.untaxed : null,
              status: 'partial',
              confidence: 'medium',
              method: 'Cimpress API direct with selections[Custom Width/Height]=3',
              notes: 'Size passed via API params — Custom Width/Height; not DOM-confirmed. Rounded Square + Slit Roll.',
              raw: JSON.stringify(p5k)
            });
          }
        } catch (pe) {
          log(`VP parse error: ${pe}`);
        }
      }
    }

    // Also try without custom size params — just rounded square + slit roll
    const cimpressUrl2 = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=5000,1000,250&merchantId=vistaprint&market=US&optionalPriceComponents=UnitPrice&selections[Shape]=Rounded%20Square&selections[Roll%20Finishing%20Type]=Slit%20Roll`;

    const cimpressResp2 = await context.request.get(cimpressUrl2).catch(e => null);
    if (cimpressResp2) {
      const body2 = await cimpressResp2.text().catch(() => null);
      log(`VP Labels Cimpress (RS default, 250/1k/5k): status=${cimpressResp2.status()} body=${body2 ? body2.slice(0, 1000) : 'null'}`);
      if (body2 && cimpressResp2.status() === 200) {
        try {
          const parsed2 = JSON.parse(body2);
          Object.entries(parsed2.estimatedPrices || {}).forEach(([qty, pdata]) => {
            recordResult({
              id: `vp-rs-${qty}`,
              site: 'Vistaprint',
              product_type: 'roll_labels',
              shape: 'Rounded Square',
              qty: parseInt(qty),
              total_price: pdata.totalListPrice ? pdata.totalListPrice.untaxed : null,
              unit_price: pdata.unitListPrice ? pdata.unitListPrice.untaxed : null,
              status: 'partial',
              confidence: 'medium',
              method: 'Cimpress API — Rounded Square default, no size specified',
              notes: 'Default size for Rounded Square shape — exact dimensions unknown'
            });
          });
        } catch (pe2) {}
      }
    }

  } catch (e) {
    recordError('Vistaprint-labels', 'page-load', e);
  } finally {
    await context.close();
  }
}

// ─── 5. UPrinting — Additional Label Points + Angular Scope ─────────────────
async function captureUPrintingLabelsExtra(browser) {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await context.newPage();

  try {
    log('UP Labels Extra: loading roll-labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Read Angular scope state
    const scopeData = await page.evaluate(() => {
      try {
        const calcEl = document.querySelector('#calc_33_grid') ||
                       document.querySelector('[id*="calc_33"]') ||
                       document.querySelector('[id*="calc"]');
        if (!calcEl) return { error: 'no calc element found' };
        if (typeof angular === 'undefined') return { error: 'angular not defined' };
        const scope = angular.element(calcEl).scope();
        if (!scope) return { error: 'no scope on element' };
        return {
          priceData: scope.priceData,
          qty: scope.qty,
          selectedSize: scope.selectedSize,
          selectedAttr4: scope.selectedAttr4
        };
      } catch (e) {
        return { error: String(e) };
      }
    });
    log(`UP Labels scope: ${JSON.stringify(scopeData)}`);

    const capturedPoints = [];

    if (!scopeData.error) {
      // Try multiple size presets (attr4 values)
      // Known: 3×3 is attr4 = some index. Let's discover the size select options
      const sizeOpts = await page.evaluate(() => {
        // Find the size bootstrap dropdown
        const sizeDropdown = document.querySelector('.attr4_group') ||
                             document.querySelector('[data-group="attr4"]') ||
                             document.querySelector('select[name="attr4"]');
        if (sizeDropdown) {
          const opts = Array.from(sizeDropdown.querySelectorAll('option, li, a[data-value]'));
          return opts.map(o => ({ value: o.getAttribute('data-value') || o.value, text: o.textContent.trim() }));
        }
        // Try bootstrap dropdown items
        const ddItems = Array.from(document.querySelectorAll('[data-group="attr4"] a, .size-select a, .attr_select a'));
        return ddItems.map(a => ({ value: a.getAttribute('data-value') || a.getAttribute('value'), text: a.textContent.trim() }));
      });
      log(`UP Labels size opts: ${JSON.stringify(sizeOpts).slice(0, 500)}`);

      // Try specific qty points for current size
      const qtysToCapture = ['100', '250', '500', '1000', '2500', '5000', '10000'];
      for (const qtyText of qtysToCapture) {
        const priceData = await page.evaluate((targetQty) => {
          try {
            // Find the qty in the grid
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            let foundNode = null;
            while (node = walker.nextNode()) {
              if (node.textContent.trim() === targetQty || node.textContent.replace(/,/g, '') === targetQty) {
                foundNode = node;
                break;
              }
            }
            if (foundNode) {
              const parent = foundNode.parentElement;
              if (parent) parent.click();
              // Wait for Angular
              const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc"]');
              if (!calcEl) return { error: 'no calc el after click', qty: targetQty };
              const scope = angular.element(calcEl).scope();
              if (!scope) return { error: 'no scope', qty: targetQty };
              return { qty: scope.priceData && scope.priceData.qty, price: scope.priceData && scope.priceData.price, unit: scope.priceData && scope.priceData.unit_price };
            }
            return { error: `qty text "${targetQty}" not found in DOM` };
          } catch (e) {
            return { error: String(e), qty: targetQty };
          }
        }, qtyText);

        log(`UP Labels qty ${qtyText}: ${JSON.stringify(priceData)}`);
        await page.waitForTimeout(500);

        if (priceData && priceData.price && !priceData.error) {
          capturedPoints.push({
            id: `up-${priceData.qty}-captured`,
            site: 'UPrinting',
            product_type: 'roll_labels',
            qty: priceData.qty,
            total_price: priceData.price,
            unit_price: priceData.unit,
            status: 'live',
            confidence: 'high',
            method: 'Angular scope read',
            notes: 'Default size on page load (check size selection)'
          });
        }
      }
    }

    recordResult({
      site: 'UPrinting',
      product_type: 'roll_labels_extra',
      status: 'investigation',
      scope_data: scopeData,
      captured_points: capturedPoints,
      notes: 'Additional label qty points captured'
    });

  } catch (e) {
    recordError('UPrinting-labels-extra', 'capture', e);
  } finally {
    await context.close();
  }
}

// ─── 6. GotPrint Labels — Try authenticated cookie approach ─────────────────
async function captureGotPrintLabelsPrice(browser) {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await context.newPage();

  const priceResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('price') || url.includes('quantities') || url.includes('options')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) priceResponses.push({ url, status: resp.status(), body: text.slice(0, 3000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('GP Labels: attempting price extraction via full human flow simulation...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Select shape: Square - Rounded
    await page.evaluate(() => {
      const shapeSelect = document.querySelector('select[name="shape"]');
      if (!shapeSelect) return;
      shapeSelect.value = 'Square - Rounded';
      shapeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(2500);

    // Select size: 3" x 3"
    const sizeSelected = await page.evaluate(() => {
      const sizeSelect = document.querySelector('select[name="size"]');
      if (!sizeSelect) return false;
      // Find option with 3x3
      for (const opt of sizeSelect.options) {
        if (opt.text.includes('3"') && opt.text.includes('3"') && opt.text.includes('x')) {
          sizeSelect.value = opt.value;
          sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: opt.value, text: opt.text };
        }
      }
      return false;
    });
    log(`GP Labels: size select result: ${JSON.stringify(sizeSelected)}`);
    await page.waitForTimeout(2500);

    // Check if paper/finish selects are enabled now
    const selectState = await page.evaluate(() => {
      const selects = ['shape', 'size', 'paper', 'finish', 'color', 'quantity'].map(name => {
        const sel = document.querySelector(`select[name="${name}"]`);
        if (!sel) return { name, found: false };
        return {
          name, found: true, disabled: sel.disabled, value: sel.value,
          options: Array.from(sel.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
        };
      });
      return selects;
    });
    log(`GP Labels: select states after size: ${JSON.stringify(selectState).slice(0, 2000)}`);

    // Try force-enabling and selecting paper via Vue internal trigger
    // Using __vue__ if available
    const vuePaperResult = await page.evaluate(() => {
      const paperSel = document.querySelector('select[name="paper"]');
      if (!paperSel) return { error: 'no paper select' };

      // Try Vue instance
      const vueInstance = paperSel.__vue__ || (paperSel._vei && Object.values(paperSel._vei)[0]);
      if (vueInstance) {
        return { hasVue: true, type: typeof vueInstance };
      }

      // Try parent Vue
      let el = paperSel;
      while (el) {
        if (el.__vue__) return { hasVue: true, onParent: true };
        el = el.parentElement;
      }

      // Force enable and set
      paperSel.disabled = false;
      paperSel.removeAttribute('disabled');
      for (const opt of paperSel.options) {
        if (opt.text.includes('White BOPP') || opt.text.includes('BOPP')) {
          paperSel.value = opt.value;
          // Try multiple event types
          ['change', 'input', 'blur'].forEach(evType => {
            paperSel.dispatchEvent(new Event(evType, { bubbles: true }));
          });
          return { forceSet: opt.value, text: opt.text };
        }
      }
      return { error: 'no BOPP option found', options: Array.from(paperSel.options).map(o => o.text) };
    });
    log(`GP Labels: Vue paper result: ${JSON.stringify(vuePaperResult)}`);
    await page.waitForTimeout(2500);

    // Select finish: Matte
    const vueMatte = await page.evaluate(() => {
      const finishSel = document.querySelector('select[name="finish"]');
      if (!finishSel) return { error: 'no finish select' };
      finishSel.disabled = false;
      finishSel.removeAttribute('disabled');
      for (const opt of finishSel.options) {
        if (opt.text.toLowerCase().includes('matte')) {
          finishSel.value = opt.value;
          ['change', 'input'].forEach(ev => finishSel.dispatchEvent(new Event(ev, { bubbles: true })));
          return { finishSet: opt.value, text: opt.text };
        }
      }
      return { options: Array.from(finishSel.options).map(o => o.text) };
    });
    log(`GP Labels: Matte finish result: ${JSON.stringify(vueMatte)}`);
    await page.waitForTimeout(2000);

    // Try qty = 5000
    const vueQty = await page.evaluate(() => {
      const qtySel = document.querySelector('select[name="quantity"], select[name="qty"]');
      if (!qtySel) return { error: 'no qty select' };
      qtySel.disabled = false;
      for (const opt of qtySel.options) {
        if (opt.value === '5000' || opt.text.includes('5000') || opt.text.includes('5,000')) {
          qtySel.value = opt.value;
          ['change', 'input'].forEach(ev => qtySel.dispatchEvent(new Event(ev, { bubbles: true })));
          return { qtySet: opt.value };
        }
      }
      return { options: Array.from(qtySel.options).map(o => ({ v: o.value, t: o.text })) };
    });
    log(`GP Labels: qty 5000 result: ${JSON.stringify(vueQty)}`);
    await page.waitForTimeout(2000);

    // Check for price display
    const priceDisplay = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const priceTexts = [];
      let node;
      while (node = walker.nextNode()) {
        if (/\$[\d,]+\.?\d*/.test(node.textContent)) {
          priceTexts.push(node.textContent.trim());
        }
      }
      // Also check specific price elements
      const priceEls = document.querySelectorAll('[class*="price"], [id*="price"], .total-price, .order-total');
      const priceElTexts = Array.from(priceEls).map(e => e.textContent.trim()).filter(t => /\$/.test(t));
      return { priceTexts: priceTexts.slice(0, 20), priceElTexts };
    });
    log(`GP Labels: price display after full cascade: ${JSON.stringify(priceDisplay)}`);

    // Log all API responses
    log(`GP Labels: intercepted ${priceResponses.length} pricing API responses`);
    priceResponses.slice(0, 10).forEach(r => {
      log(`  URL: ${r.url}`);
      log(`  Body: ${r.body.slice(0, 400)}`);
    });

    recordResult({
      site: 'GotPrint',
      product_type: 'roll_labels',
      spec: { w: 3, h: 3, qty: 5000, material: 'White BOPP', finish: 'Matte' },
      status: 'investigation',
      select_states: selectState,
      price_display: priceDisplay,
      api_responses: priceResponses.slice(0, 10).map(r => ({ url: r.url, body: r.body.slice(0, 400) })),
      notes: 'Full cascade attempted with Vue force-enable'
    });

  } catch (e) {
    recordError('GotPrint-labels', 'capture', e);
  } finally {
    await context.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    log('=== NOV-9 Packaging Capture Pass ===');
    log('Running all capture functions...');

    // Run sequentially to avoid resource contention
    await captureUPrintingLabelsExtra(browser);
    await captureVistaprintLabels(browser);
    await captureGotPrintLabelsPrice(browser);
    await captureUPrintingBoxes(browser);
    await captureUPrintingPouches(browser);
    await captureGotPrintBoxes(browser);

  } finally {
    await browser.close();
  }

  const output = {
    run_date: new Date().toISOString(),
    results: RESULTS,
    errors: ERRORS
  };

  const fs = require('fs');
  const outPath = `/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-packaging-${new Date().toISOString().slice(0,10)}.json`;
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n=== DONE. Results saved to ${outPath} ===`);
  log(`Captured ${RESULTS.length} results, ${ERRORS.length} errors`);

  console.log('\n\n=== FINAL RESULTS ===');
  console.log(JSON.stringify(output, null, 2));
})();
