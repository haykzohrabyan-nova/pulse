/**
 * capture-pri8-targeted.js
 * PRI-8: Targeted capture for missing data points:
 *   1. UPrinting Roll Labels — 4"×2" at 1000, 5000, 10000 qty
 *   2. Packola Boxes — 4"L×2"W×5"D STE, 250/500/1000/2000/2500 qty
 *   3. Packola Stand-Up Pouches — 4.375"×6"×2" gusset, 500/1000/2500/5000 qty
 *
 * Run: node capture-pri8-targeted.js
 */

const { chromium } = require('playwright');
const fs = require('fs');

const RESULTS = [];
const ERRORS = [];

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function recordResult(entry) {
  RESULTS.push(entry);
  log(`CAPTURED: ${JSON.stringify(entry)}`);
}

function recordError(site, step, error) {
  ERRORS.push({ site, step, error: String(error) });
  log(`ERROR [${site}/${step}]: ${error}`);
}

// ─── 1. UPrinting Roll Labels — 4"×2" multi-qty ──────────────────────────────
async function captureUPrinting4x2Labels(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    log('UP 4x2 Labels: loading roll-labels page...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Get initial Angular scope state
    const initialState = await page.evaluate(() => {
      const r = {};
      try {
        if (typeof angular !== 'undefined') {
          const calcEls = document.querySelectorAll('[id*="calc"]');
          for (const el of calcEls) {
            const scope = angular.element(el).scope();
            if (scope && scope.priceData) {
              r.priceData = {
                qty: scope.priceData.qty,
                price: scope.priceData.price,
                total_price: scope.priceData.total_price,
                unit_price: scope.priceData.unit_price,
                width: scope.priceData.width,
                height: scope.priceData.height,
                item_name: scope.priceData.item_name,
                order_specs: scope.priceData.order_specs
              };
              break;
            }
          }
        }
      } catch (e) { r.err = String(e); }

      // List all size options in Bootstrap dropdown
      r.sizeOptions = [];
      const sizeDropdowns = document.querySelectorAll('[data-option-type="size"], [data-attrtype="SZ"], .attr-item');
      sizeDropdowns.forEach(el => {
        r.sizeOptions.push({ text: el.textContent.trim().slice(0,50), val: el.getAttribute('data-val') || el.getAttribute('data-attrval') || '' });
      });

      // Also look for size links in dropdown menus
      const allLinks = document.querySelectorAll('a[data-attrval], li[data-attrval]');
      r.attrLinks = Array.from(allLinks).slice(0, 50).map(el => ({
        text: el.textContent.trim().slice(0,30),
        attrval: el.getAttribute('data-attrval'),
        attrtype: el.getAttribute('data-attrtype') || el.parentElement?.getAttribute('data-attrtype')
      }));

      return r;
    });

    log(`UP 4x2 initial state: ${JSON.stringify(initialState).slice(0, 1000)}`);

    // Look for 4"x2" or 2"x4" size option and click it
    const sizeClicked = await page.evaluate(() => {
      // Try to find and click 4"x2" size option in Bootstrap dropdowns
      const allEls = document.querySelectorAll('a, li, span, div');
      for (const el of allEls) {
        const text = el.textContent.trim();
        if ((text.includes('4') && text.includes('2') && text.includes('"') && text.length < 20) ||
            text === '4" x 2"' || text === '2" x 4"' || text === '4×2' || text === '4" × 2"') {
          el.click();
          return { clicked: true, text };
        }
      }

      // Try Bootstrap dropdown pattern — find dropdown containing size options
      const dropdowns = document.querySelectorAll('.dropdown-menu li a');
      const sizeOptions = [];
      for (const a of dropdowns) {
        const text = a.textContent.trim();
        if (text.match(/\d+["']?\s*[x×]\s*\d+/i)) {
          sizeOptions.push(text);
        }
      }
      return { clicked: false, availableSizes: sizeOptions.slice(0, 20) };
    });

    log(`UP 4x2 size click: ${JSON.stringify(sizeClicked)}`);

    if (!sizeClicked.clicked) {
      // Try to find size via button/option text search
      try {
        await page.click('text=4" x 2"', { timeout: 3000 });
        log('UP 4x2: clicked "4" x 2"" text');
      } catch (e) {
        try {
          await page.click('text=4 x 2', { timeout: 3000 });
        } catch (e2) {
          log(`UP 4x2: no 4x2 click found, will try to use dropdown. Available: ${JSON.stringify(sizeClicked.availableSizes)}`);
        }
      }
    }

    await page.waitForTimeout(2000);

    // Now try to get pricing at multiple qty points
    const qtysToCapture = ['1,000', '5,000', '10,000'];

    for (const qtyText of qtysToCapture) {
      // Click the quantity option
      const qtyClicked = await page.evaluate((targetQty) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.trim() === targetQty) {
            const parent = node.parentElement;
            if (parent) {
              parent.click();
              return { clicked: true, tag: parent.tagName, text: node.textContent.trim() };
            }
          }
        }
        return { clicked: false };
      }, qtyText);

      log(`UP 4x2 qty click ${qtyText}: ${JSON.stringify(qtyClicked)}`);
      await page.waitForTimeout(2000);

      // Read the Angular scope after click
      const state = await page.evaluate(() => {
        try {
          if (typeof angular !== 'undefined') {
            const calcEls = document.querySelectorAll('[id*="calc"]');
            for (const el of calcEls) {
              const scope = angular.element(el).scope();
              if (scope && scope.priceData) {
                return {
                  qty: scope.priceData.qty,
                  price: scope.priceData.price,
                  total_price: scope.priceData.total_price,
                  unit_price: scope.priceData.unit_price,
                  width: scope.priceData.width,
                  height: scope.priceData.height,
                  order_specs: (scope.priceData.order_specs || []).map(s => ({
                    code: s.order_spec_code, value: s.order_spec_value
                  }))
                };
              }
            }
          }
        } catch (e) {}
        return null;
      });

      if (state && state.qty) {
        const qty = parseInt(String(state.qty).replace(/,/g, ''));
        recordResult({
          id: `up-label-4x2-${qty}-pri8`,
          site: 'UPrinting',
          product_type: 'roll_labels',
          qty: qty,
          total_price: parseFloat(state.total_price) || parseFloat(state.price),
          unit_price: parseFloat(state.unit_price),
          width: parseFloat(state.width),
          height: parseFloat(state.height),
          confidence: 'high',
          method: 'angular_scope',
          notes: `4"x2" roll label at ${qty} qty. W=${state.width}, H=${state.height}`,
          order_specs: state.order_specs,
          status: 'live'
        });
      } else {
        log(`UP 4x2 qty ${qtyText}: no Angular scope found`);
      }
    }

  } catch (e) {
    recordError('UPrinting', '4x2-labels', e);
  } finally {
    await context.close();
  }
}

// ─── 2. Packola Box — 4"L×2"W×5"D STE, multi-qty ────────────────────────────
async function capturePackolaBoxes(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Intercept API calls
  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('packola') && (url.includes('price') || url.includes('quote') || url.includes('calc') || url.includes('api'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) apiCalls.push({ url, body: text.slice(0, 2000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('Packola boxes: loading product-box page...');
    await page.goto('https://www.packola.com/products/product-box', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Get initial page state + pricing
    const initialState = await page.evaluate(() => {
      const r = {};
      // Get all price-related text
      const priceEls = document.querySelectorAll('[class*="price"], [id*="price"], [class*="total"], [class*="subtotal"], [class*="unit"]');
      r.priceElements = Array.from(priceEls).map(el => ({
        class: el.className.slice(0,40),
        text: el.textContent.trim().slice(0,50)
      }));

      // Get any JSON embedded in the page
      const scripts = document.querySelectorAll('script[type="application/json"], script[id*="__NEXT"], script[id*="data"]');
      r.scriptCount = scripts.length;
      r.firstScript = scripts[0] ? scripts[0].textContent.slice(0, 500) : '';

      // Get form elements
      r.inputs = Array.from(document.querySelectorAll('input[name], select[name]')).map(el => ({
        name: el.name, type: el.type, value: el.value || '', id: el.id
      }));

      // Page title
      r.title = document.title;

      return r;
    });

    log(`Packola initial: title="${initialState.title}", prices: ${JSON.stringify(initialState.priceElements?.slice(0,5))}`);

    // Try to enter dimensions 4, 2, 5 for L, W, D
    // First find length/width/depth inputs
    try {
      const dimInputs = await page.$$('input[type="number"], input[placeholder*="Length"], input[placeholder*="Width"], input[placeholder*="Depth"], input[placeholder*="height"]');
      log(`Packola: found ${dimInputs.length} dimension inputs`);

      if (dimInputs.length >= 3) {
        await dimInputs[0].fill('4');
        await page.waitForTimeout(500);
        await dimInputs[1].fill('2');
        await page.waitForTimeout(500);
        await dimInputs[2].fill('5');
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      log(`Packola: dim input error: ${e}`);
    }

    // Try to find and set quantity, then capture price
    const qtysToTry = [250, 500, 1000, 2000, 2500];

    for (const qty of qtysToTry) {
      // Try to set quantity
      try {
        await page.selectOption('select[name*="qty"], select[name*="quantity"], select[id*="qty"]', String(qty), { timeout: 2000 });
        await page.waitForTimeout(1500);
      } catch (e) {
        // Try clicking quantity option
        try {
          await page.click(`text=${qty.toLocaleString()}`, { timeout: 2000 });
          await page.waitForTimeout(1500);
        } catch (e2) {}
      }

      // Read price
      const priceState = await page.evaluate(() => {
        const priceEls = document.querySelectorAll('[class*="price"], [class*="total"], [class*="subtotal"], [class*="unit-price"]');
        const prices = [];
        for (const el of priceEls) {
          const text = el.textContent.trim();
          if (/\$[\d,]+\.?\d*/.test(text)) {
            prices.push({ class: el.className.slice(0,40), text: text.slice(0,50) });
          }
        }
        // Also get any number in a price-looking span
        const spans = document.querySelectorAll('span, div, p');
        for (const el of spans) {
          const text = el.textContent.trim();
          if (/^\$[\d,]+\.\d{2}$/.test(text)) {
            prices.push({ class: el.className.slice(0,30), text });
          }
        }
        return prices.slice(0, 10);
      });

      log(`Packola qty ${qty}: prices = ${JSON.stringify(priceState)}`);

      if (apiCalls.length > 0) {
        log(`Packola API calls so far: ${apiCalls.map(a => a.url).join(', ')}`);
      }
    }

    log(`Packola total API calls intercepted: ${apiCalls.length}`);
    apiCalls.forEach(c => log(`  API: ${c.url} | ${c.body.slice(0, 200)}`));

  } catch (e) {
    recordError('Packola', 'boxes', e);
  } finally {
    await context.close();
  }
}

// ─── 3. Packola Stand-Up Pouches ──────────────────────────────────────────────
async function capturePackolaPouches(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if ((url.includes('packola') || url.includes('api')) && (url.includes('price') || url.includes('quote') || url.includes('calc'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) apiCalls.push({ url, body: text.slice(0, 2000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('Packola pouches: loading custom-pouches page...');
    await page.goto('https://www.packola.com/products/custom-pouches', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    const pageState = await page.evaluate(() => {
      const r = {};
      r.title = document.title;
      // Get all text with prices
      const priceEls = [];
      const spans = document.querySelectorAll('span, div, p, strong');
      for (const el of spans) {
        const text = el.textContent.trim();
        if (/\$[\d,]+\.?\d*/.test(text) && text.length < 60) {
          priceEls.push({ text, class: el.className.slice(0,30) });
        }
      }
      r.priceEls = priceEls.slice(0, 15);

      // List all select elements
      r.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => o.text.trim()).slice(0, 15)
      }));

      // List all input elements
      r.inputs = Array.from(document.querySelectorAll('input[type="number"]')).map(i => ({
        name: i.name, id: i.id, value: i.value, placeholder: i.placeholder
      }));

      return r;
    });

    log(`Packola pouches: ${JSON.stringify(pageState).slice(0, 1000)}`);

    // Try to select "stand-up" type if there's a choice
    try {
      await page.click('text=Stand Up', { timeout: 3000 });
      log('Packola pouches: clicked Stand Up');
      await page.waitForTimeout(1500);
    } catch (e) {
      try {
        await page.click('text=Stand-Up', { timeout: 2000 });
        await page.waitForTimeout(1500);
      } catch (e2) {}
    }

    // Try to set size close to 4.375"×6"
    // Look for size selects
    try {
      await page.selectOption('select', 'Medium', { timeout: 2000 });
      await page.waitForTimeout(1000);
    } catch (e) {}

    // Capture prices at different qty points
    const qtys = [500, 1000, 2500, 5000];
    for (const qty of qtys) {
      try {
        await page.click(`text=${qty.toLocaleString()}`, { timeout: 2000 });
        await page.waitForTimeout(1500);
      } catch (e) {}

      const priceState = await page.evaluate(() => {
        const prices = [];
        const els = document.querySelectorAll('span, div, strong, p');
        for (const el of els) {
          const text = el.textContent.trim();
          if (/^\$[\d,]+\.\d{2}$/.test(text) || /^\$[\d,]+\.\d{2} per unit$/.test(text)) {
            prices.push({ text, class: el.className.slice(0,30) });
          }
        }
        return prices.slice(0, 8);
      });

      log(`Packola pouches qty ${qty}: ${JSON.stringify(priceState)}`);
    }

    log(`Packola pouches API calls: ${apiCalls.length}`);
    apiCalls.forEach(c => log(`  API: ${c.url} | ${c.body.slice(0, 200)}`));

  } catch (e) {
    recordError('Packola', 'pouches', e);
  } finally {
    await context.close();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    log('=== PRI-8 Targeted Capture ===');

    await captureUPrinting4x2Labels(browser);
    await capturePackolaBoxes(browser);
    await capturePackolaPouches(browser);

  } finally {
    await browser.close();
  }

  const output = {
    run_date: new Date().toISOString(),
    results: RESULTS,
    errors: ERRORS
  };

  const outPath = '/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-pri8-2026-04-17.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`=== DONE. ${RESULTS.length} results, ${ERRORS.length} errors. Written to ${outPath} ===`);

  // Print results summary
  log('\n=== RESULTS SUMMARY ===');
  RESULTS.forEach(r => {
    log(`${r.site} | ${r.product_type} | qty=${r.qty} | total=$${r.total_price} | unit=$${r.unit_price} | ${r.confidence}`);
  });
  if (ERRORS.length > 0) {
    log('\n=== ERRORS ===');
    ERRORS.forEach(e => log(`${e.site}/${e.step}: ${e.error}`));
  }
})();
