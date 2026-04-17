#!/usr/bin/env node
/**
 * capture-axiom-gp-final.js
 * PRI-7 — Final targeted capture:
 *   1. Axiom: read all visible price tiers from configurator; interact with size/qty selectors
 *   2. GotPrint: select shape+size via real select elements; intercept pricing API calls
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SS = path.join(ROOT_DIR, 'data', 'screenshots');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-axiom-gp-final-${nowISO()}.json`);

function log(msg) { console.log(`[fin] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── AXIOM PRINT ─────────────────────────────────────────────────────────────
// CustomHorizontalSelect React components
// Shapes: Rectangle, Square, Circle, Oval, Custom Cut
// Size options appear after shape selection — likely contains 3x4 option
// Multiple prices visible on load: $112.68, $147.62, $221.15
async function captureAxiom(context) {
  log('=== Axiom Print final capture ===');
  const page = await context.newPage();
  const results = { sections: [], prices: [], error: null, apiCalls: [] };
  const apiCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('axiomprint.com') && resp.status() < 500 && !u.includes('.png') && !u.includes('.js') && !u.includes('.css')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          if (body) apiCalls.push({ url: u.replace('https://www.axiomprint.com', ''), body });
        }
      } catch(_) {}
    }
  });

  try {
    await page.goto('https://www.axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);

    // --- Read all price sections visible on page ---
    // The product page shows pricing tiers inline
    const allPriceData = await page.evaluate(() => {
      // Read all visible $ amounts
      const allTextNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while (node = walker.nextNode()) {
        const t = node.textContent.trim();
        if (/\$[\d,]+\.\d{2}/.test(t)) {
          const parent = node.parentElement;
          allTextNodes.push({
            text: t,
            tag: parent?.tagName,
            cls: parent?.className?.slice(0, 80),
            nearText: parent?.closest('[class*="product"], [class*="price"], [class*="tier"]')?.textContent?.trim()?.slice(0, 100)
          });
        }
      }

      // Also look for a price table or tier table
      const tables = Array.from(document.querySelectorAll('table, [class*="table"], [class*="tier"], [class*="pricing"]'));
      const tableData = tables.map(t => ({
        cls: t.className.slice(0, 60),
        html: t.innerHTML.slice(0, 500)
      })).filter(t => /\$\d/.test(t.html)).slice(0, 5);

      // ProductInfo_finalPrice visible
      const finalPrices = Array.from(document.querySelectorAll('[class*="finalPrice"], [class*="price"]'))
        .filter(el => /\$\d/.test(el.textContent))
        .map(el => ({ cls: el.className.slice(0, 60), text: el.textContent.trim().slice(0, 80) }))
        .slice(0, 10);

      return { allTextNodes: allTextNodes.slice(0, 20), tableData, finalPrices };
    });
    log('Axiom price data: ' + JSON.stringify(allPriceData).slice(0, 1000));
    results.priceData = allPriceData;

    // --- Inspect configurator structure ---
    const configInfo = await page.evaluate(() => {
      // Find the CustomHorizontalSelect components
      const containers = Array.from(document.querySelectorAll('[class*="CustomHorizontalSelect_container"]'));
      const sectionInfo = containers.map(c => ({
        cls: c.className.slice(0, 80),
        labelText: c.closest('[class*="section"], [class*="row"], [class*="group"]')?.querySelector('[class*="label"], [class*="title"], h3, h4, p')?.textContent?.trim(),
        items: Array.from(c.querySelectorAll('[class*="itemBox"]')).map(item => ({
          cls: item.className.slice(0, 80),
          text: item.textContent.trim(),
          active: item.className.includes('acti')
        }))
      }));

      // Also look for any section/row label above each selector
      const allSections = Array.from(document.querySelectorAll('[class*="section"], [class*="row"], [class*="group"]')).filter(el => {
        const h = el.innerHTML;
        return (h.includes('Select') || h.includes('size') || h.includes('qty') || h.includes('quantity')) && el.offsetWidth;
      }).map(el => ({
        cls: el.className.slice(0, 60),
        html: el.innerHTML.slice(0, 300)
      })).slice(0, 10);

      return { containers: sectionInfo, allSections };
    });
    log('Config info: ' + JSON.stringify(configInfo).slice(0, 1200));
    results.configInfo = configInfo;

    // --- Read the qty selector specifically ---
    // Look for qty items that might be the 250/500/1000/2500 tiers
    const qtyItems = await page.evaluate(() => {
      // Try to find quantity section
      const bodyText = document.body.innerHTML;
      const qtyMatch = bodyText.match(/250.*500.*1000.*2500|qty/i);

      // Find items with number-only text (qty values)
      const numItems = Array.from(document.querySelectorAll('[class*="itemBox"], [class*="item"], [class*="option"]'))
        .filter(el => /^\d[\d,]+$/.test(el.textContent.trim()))
        .map(el => ({
          text: el.textContent.trim(),
          cls: el.className.slice(0, 60),
          active: el.className.includes('acti') || el.className.includes('selected')
        }));

      // Find size items
      const sizeItems = Array.from(document.querySelectorAll('[class*="itemBox"], [class*="item"], [class*="option"]'))
        .filter(el => /^\d+"?\s*[x×]\s*\d+"?$/.test(el.textContent.trim()))
        .map(el => ({
          text: el.textContent.trim(),
          cls: el.className.slice(0, 60),
          active: el.className.includes('acti') || el.className.includes('selected')
        }));

      return { numItems, sizeItems };
    });
    log('Qty/Size items: ' + JSON.stringify(qtyItems).slice(0, 600));

    // --- Try clicking shape = Rectangle first (to reveal size options) ---
    const shapeContainers = await page.$$('[class*="CustomHorizontalSelect_container"]');
    log('Shape containers: ' + shapeContainers.length);

    if (shapeContainers.length > 0) {
      // First container is likely shape — try clicking "Rectangle" or "Square"
      const shapeItems = await shapeContainers[0].$$('[class*="itemBox"]');
      log('Shape items: ' + shapeItems.length);
      for (const item of shapeItems) {
        const t = await item.textContent();
        log('  Shape item: ' + t.trim());
      }

      // Click "Rectangle" (first option)
      if (shapeItems.length > 0) {
        await shapeItems[0].click();
        await sleep(2000);
        log('Clicked first shape item');
      }
    }

    // After shape selection, find size options
    await page.screenshot({ path: path.join(SS, 'axiom-final-01-after-shape.png') });

    const sizeContainerInfo = await page.evaluate(() => {
      const containers = Array.from(document.querySelectorAll('[class*="CustomHorizontalSelect_container"]'));
      return containers.map((c, i) => ({
        index: i,
        items: Array.from(c.querySelectorAll('[class*="itemBox"]')).map(item => ({
          text: item.textContent.trim(),
          active: item.className.includes('acti')
        }))
      }));
    });
    log('All containers after shape click: ' + JSON.stringify(sizeContainerInfo).slice(0, 800));
    results.sizeContainerInfo = sizeContainerInfo;

    // Try to find and click size = 3x4 or similar
    const sizeClicked = await page.evaluate(() => {
      const allItems = Array.from(document.querySelectorAll('[class*="itemBox"]'));
      const sizeItem = allItems.find(el => {
        const t = el.textContent.trim();
        return /3.*4|3".*4"|2.*3|2".*3"/i.test(t) && (el.offsetWidth || el.offsetHeight);
      });
      if (sizeItem) {
        sizeItem.click();
        return sizeItem.textContent.trim();
      }
      return 'not found, items: ' + allItems.filter(el => el.offsetWidth).map(el => el.textContent.trim()).slice(0, 20).join(', ');
    });
    log('Size click: ' + sizeClicked);
    await sleep(2000);

    // Read the current price
    const currentPrice = await page.evaluate(() => {
      const priceEl = document.querySelector('[class*="finalPrice"]');
      const unitEl = document.querySelector('[class*="subHeadingText"]');
      return {
        total: priceEl?.textContent?.trim(),
        unit: unitEl?.textContent?.trim()
      };
    });
    log('Current price after size: ' + JSON.stringify(currentPrice));
    results.priceAfterSize = { size: sizeClicked, price: currentPrice };

    // Now iterate through qty options
    // Look for qty items - typically the last CustomHorizontalSelect container
    const allContainers = await page.$$('[class*="CustomHorizontalSelect_container"]');
    log('Total containers: ' + allContainers.length);

    // The qty selector is likely the last one or a specific one
    for (const container of allContainers) {
      const items = await container.$$('[class*="itemBox"]');
      if (items.length === 0) continue;
      const firstText = await items[0].textContent();
      // Qty container has numeric items: 250, 500, 1000, 2500
      if (/^\s*\d{3,4}\s*$/.test(firstText)) {
        log('Found qty container with ' + items.length + ' items');
        for (const item of items) {
          const qty = (await item.textContent()).trim();
          await item.click();
          await sleep(1500);
          const price = await page.evaluate(() => {
            const p = document.querySelector('[class*="finalPrice"]');
            const u = document.querySelector('[class*="subHeadingText"]');
            return { total: p?.textContent?.trim(), unit: u?.textContent?.trim() };
          });
          log(`Axiom qty=${qty}: ${JSON.stringify(price)}`);
          results.prices.push({ qty: parseInt(qty), price: price.total, unit: price.unit });
        }
        break;
      }
    }

    // Also try WooCommerce AJAX to get price variations
    const wooPrice = await page.evaluate(async () => {
      try {
        // Axiom /?wc-ajax=get_variation returned 200 — try with variation data
        const r = await fetch('/?wc-ajax=get_variation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'product_id=335&attribute_shape=Rectangle&attribute_size=3x4&attribute_qty=1000'
        });
        return { status: r.status, body: (await r.text()).slice(0, 500) };
      } catch(e) { return { error: e.message }; }
    });
    log('WooCommerce variation: ' + JSON.stringify(wooPrice).slice(0, 200));
    results.wooPrice = wooPrice;

    results.apiCalls = apiCalls.map(c => ({
      url: c.url,
      preview: JSON.stringify(c.body).slice(0, 200)
    }));

    await page.screenshot({ path: path.join(SS, 'axiom-final-02-done.png') });

  } catch(e) {
    err('Axiom: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
  }

  return results;
}

// ─── GOTPRINT ─────────────────────────────────────────────────────────────────
// Shape select: id="shape" v=4 = Square-Rounded
// Size select: id="size" - populated after shape selection
// Intercept /service/rest/v1/ API calls for pricing
async function captureGotPrint(context) {
  log('=== GotPrint final capture ===');
  const page = await context.newPage();
  const results = { prices: [], sizeOptions: [], error: null, apiCalls: [] };
  const apiCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com/service')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          apiCalls.push({ url: u.replace('https://www.gotprint.com', ''), status: resp.status(), body });
          if (u.includes('price') || u.includes('cart') || u.includes('checkout') || u.includes('specifications')) {
            log('GP pricing call: ' + resp.status() + ' ' + u.replace('https://www.gotprint.com', ''));
          }
        }
      } catch(_) {}
    }
  });

  try {
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    log('GP loaded: ' + page.url());

    // Get shape options
    const shapeOpts = await page.evaluate(() => {
      const sel = document.getElementById('shape');
      if (!sel) return null;
      return Array.from(sel.options).map(o => ({ v: o.value, t: o.text }));
    });
    log('Shape options: ' + JSON.stringify(shapeOpts));

    // Select Square-Rounded (v=4)
    await page.selectOption('#shape', '4');
    log('Selected shape: Square-Rounded (4)');
    await sleep(3000);

    // Now check size options (should populate after shape)
    const sizeOpts = await page.evaluate(() => {
      const sel = document.getElementById('size');
      if (!sel) return null;
      return Array.from(sel.options).map(o => ({ v: o.value, t: o.text }));
    });
    log('Size options after shape: ' + JSON.stringify(sizeOpts?.slice(0, 20)));
    results.sizeOptions = sizeOpts;

    // Find 3"×3" option (v=32 from prior analysis)
    const size3x3 = sizeOpts?.find(o => o.v === '32' || o.t.includes('3" x 3"') || o.t.includes('3x3'));
    log('3x3 option: ' + JSON.stringify(size3x3));

    if (size3x3) {
      await page.selectOption('#size', size3x3.v);
      log('Selected size: 3x3 (v=' + size3x3.v + ')');
      await sleep(3000);

      // After size selection, see what selects appear
      const allSelects = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('select')).filter(s => s.offsetWidth || s.offsetHeight).map(s => ({
          id: s.id,
          name: s.name,
          opts: Array.from(s.options).map(o => ({ v: o.value, t: o.text })).slice(0, 8),
          enabled: !s.disabled,
          value: s.value
        }));
      });
      log('All visible selects after size: ' + JSON.stringify(allSelects).slice(0, 800));
      results.selectsAfterSize = allSelects;

      // Check if material/finish selects appeared and are enabled
      const materialSel = allSelects.find(s => s.id === 'paper_type' || s.name === 'paper_type' || s.opts.some(o => /bopp|paper|vinyl/i.test(o.t)));
      const finishSel = allSelects.find(s => s.id === 'finish' || s.name === 'finish' || s.opts.some(o => /matte|gloss/i.test(o.t)));

      log('Material select: ' + JSON.stringify(materialSel)?.slice(0, 200));
      log('Finish select: ' + JSON.stringify(finishSel)?.slice(0, 200));

      if (materialSel?.enabled && materialSel.opts.some(o => /bopp/i.test(o.t))) {
        const boppOpt = materialSel.opts.find(o => /bopp/i.test(o.t));
        await page.selectOption('#' + materialSel.id, boppOpt.v);
        log('Selected material: ' + boppOpt.t);
        await sleep(2000);
      }

      if (finishSel?.enabled && finishSel.opts.some(o => /matte/i.test(o.t))) {
        const matteOpt = finishSel.opts.find(o => /matte/i.test(o.t));
        await page.selectOption('#' + finishSel.id, matteOpt.v);
        log('Selected finish: ' + matteOpt.t);
        await sleep(2000);
      }
    }

    // Try setting qty via JS and triggering Vue reactivity
    const qtyTargets = [1000, 5000];
    for (const qty of qtyTargets) {
      // Try to set qty input
      const qtySet = await page.evaluate((targetQty) => {
        const qtyInput = document.querySelector('input[name="qty"], input[id="qty"], input[type="number"]');
        if (qtyInput) {
          // Vue reactivity: use input event
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(qtyInput, targetQty);
          qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
          qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, value: qtyInput.value };
        }
        // Try select
        const qtySel = document.querySelector('select[name="qty"], select[id="qty"]');
        if (qtySel) {
          qtySel.value = targetQty;
          qtySel.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: 'select', value: qtySel.value };
        }
        return { found: false };
      }, qty);
      log(`GP qty=${qty} set: ` + JSON.stringify(qtySet));
      await sleep(2000);
    }

    // Check for product specifications endpoint (returned 200 from prior run)
    const specsCall = apiCalls.find(c => c.url.includes('specifications'));
    if (specsCall) {
      log('GP specifications: ' + JSON.stringify(specsCall.body).slice(0, 500));
      results.specifications = specsCall.body;
    }

    // Extract any visible price from page
    const visiblePrice = await page.evaluate(() => {
      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [id*="price"], .price, #price'));
      const prices = priceEls.map(el => el.textContent.trim()).filter(t => /\$\d/.test(t));
      return prices.slice(0, 5);
    });
    log('GP visible prices: ' + JSON.stringify(visiblePrice));
    results.visiblePrices = visiblePrice;

    // Check all API calls captured for pricing data
    const pricingCalls = apiCalls.filter(c =>
      c.url.includes('price') || c.url.includes('checkout') || c.url.includes('cart/item') || c.url.includes('specifications')
    );
    log('GP pricing-related API calls: ' + pricingCalls.length);
    pricingCalls.forEach(c => log('  ' + c.status + ' ' + c.url));

    results.apiCalls = apiCalls.map(c => ({
      url: c.url,
      status: c.status,
      bodyPreview: JSON.stringify(c.body || {}).slice(0, 300)
    }));
    results.pricingCalls = pricingCalls;

    await page.screenshot({ path: path.join(SS, 'gp-final-01.png') });

  } catch(e) {
    err('GotPrint: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
  }

  return results;
}

async function main() {
  log('=== Axiom + GotPrint Final === ' + nowISO());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const output = { run_date: new Date().toISOString(), results: {} };

  try {
    output.results.axiom = await captureAxiom(context);
    output.results.gotprint = await captureGotPrint(context);

    log('\n=== SUMMARY ===');
    log('Axiom prices captured: ' + (output.results.axiom.prices?.length || 0));
    if (output.results.axiom.prices?.length) {
      output.results.axiom.prices.forEach(p => log(`  qty=${p.qty}: ${p.price} (${p.unit})`));
    }
    log('GP pricing calls: ' + (output.results.gotprint.pricingCalls?.length || 0));
    log('GP visible prices: ' + JSON.stringify(output.results.gotprint.visiblePrices));
  } finally {
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('Output: ' + OUT_FILE);
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
