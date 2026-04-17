/**
 * capture-up-2x4-angular.js
 * Directly interact with UPrinting Angular scope to select 2"×4" label size
 * and capture pricing at multiple qtys with Matte lamination
 */
const { chromium } = require('playwright');
const fs = require('fs');
function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
const RESULTS = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();

  try {
    log('Loading UPrinting roll labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Step 1: Find the LI element for "2" x 4"" and click its A child directly via JS
    const sizeResult = await page.evaluate(() => {
      // Find all LI elements in the size dropdown that contain "2" x 4""
      const lis = document.querySelectorAll('li.blurb-list-dropdown');
      let target2x4 = null;
      for (const li of lis) {
        const text = li.textContent.trim();
        if (text === '2" x 4"') {
          target2x4 = li;
          break;
        }
      }
      if (!target2x4) return { found: false };

      // Get the inner <a> element
      const a = target2x4.querySelector('a.attr-value');
      if (!a) return { found: true, no_a: true };

      // Dispatch click event directly (bypasses visibility check)
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      return { found: true, text: target2x4.textContent.trim(), aText: a.textContent.trim() };
    });
    log(`2"×4" size select: ${JSON.stringify(sizeResult)}`);
    await page.waitForTimeout(2000);

    // Check Angular scope after size change
    let currentState = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        for (const el of document.querySelectorAll('[id*="calc"]')) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            const specs = scope.priceData.order_specs || [];
            return { w: scope.priceData.width, h: scope.priceData.height, size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value, lam: specs.find(s=>s.order_spec_code==='FLAM')?.order_spec_value, qty: scope.priceData.qty, price: scope.priceData.price };
          }
        }
      }
      return null;
    });
    log(`After size: ${JSON.stringify(currentState)}`);

    // Step 2: Try to set Matte lamination
    const lamResult = await page.evaluate(() => {
      const lis = document.querySelectorAll('li.blurb-list-dropdown');
      let matteLi = null;
      for (const li of lis) {
        const text = li.textContent.trim();
        if (text.toLowerCase().includes('matte') && !text.toLowerCase().includes('soft touch')) {
          matteLi = li;
          break;
        }
      }
      if (!matteLi) {
        // List all LI texts for debugging
        const allTexts = Array.from(lis).map(li => li.textContent.trim()).filter(t => t.length > 0);
        return { found: false, allLiTexts: allTexts.slice(0, 30) };
      }
      const a = matteLi.querySelector('a.attr-value');
      if (a) {
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { found: true, text: matteLi.textContent.trim() };
      }
      return { found: true, no_a: true };
    });
    log(`Matte lam: ${JSON.stringify(lamResult)}`);
    await page.waitForTimeout(2000);

    currentState = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        for (const el of document.querySelectorAll('[id*="calc"]')) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            const specs = scope.priceData.order_specs || [];
            return { w: scope.priceData.width, h: scope.priceData.height, size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value, lam: specs.find(s=>s.order_spec_code==='FLAM')?.order_spec_value, qty: scope.priceData.qty, price: scope.priceData.total_price };
          }
        }
      }
      return null;
    });
    log(`After matte: ${JSON.stringify(currentState)}`);

    // Step 3: Capture prices at qtys 1000, 5000, 10000
    const qtys = [1000, 5000, 10000];
    for (const qty of qtys) {
      const qtyResult = await page.evaluate((targetQty) => {
        const qtyStr = targetQty.toLocaleString();
        // Find qty SPAN or LI with this text
        const spans = document.querySelectorAll('span.val, span.qty-value, li.qty-item span, .qty-grid-item span');
        for (const span of spans) {
          if (span.textContent.trim() === qtyStr) {
            span.click();
            return { clicked: true, via: 'span', text: qtyStr };
          }
        }
        // Try all text nodes
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.trim() === qtyStr) {
            const p = node.parentElement;
            if (p && p.tagName !== 'SCRIPT' && p.tagName !== 'STYLE') {
              p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return { clicked: true, via: 'textnode', tag: p.tagName, class: p.className.slice(0, 30) };
            }
          }
        }
        return { clicked: false };
      }, qty);
      log(`Qty ${qty}: ${JSON.stringify(qtyResult)}`);
      await page.waitForTimeout(2000);

      const state = await page.evaluate(() => {
        if (typeof angular !== 'undefined') {
          for (const el of document.querySelectorAll('[id*="calc"]')) {
            const scope = angular.element(el).scope();
            if (scope?.priceData) {
              const specs = scope.priceData.order_specs || [];
              return {
                qty: scope.priceData.qty,
                total_price: scope.priceData.total_price || scope.priceData.price,
                unit_price: scope.priceData.unit_price,
                w: scope.priceData.width,
                h: scope.priceData.height,
                size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value,
                lam: specs.find(s=>s.order_spec_code==='FLAM')?.order_spec_value,
                material: specs.find(s=>s.order_spec_code==='SUBST')?.order_spec_value
              };
            }
          }
        }
        return null;
      });
      log(`Qty ${qty} price: ${JSON.stringify(state)}`);

      if (state) {
        RESULTS.push({
          id: `up-label-${state.size?.replace(/[^\d.]/g,'x')}-${qty}-pri8`,
          site: 'UPrinting', competitor: 'uprinting',
          product_type: 'roll_labels',
          qty: state.qty,
          total_price: parseFloat(state.total_price),
          unit_price: parseFloat(state.unit_price),
          spec: { width_in: parseFloat(state.w), height_in: parseFloat(state.h), size_label: state.size, material: state.material, lamination: state.lam },
          confidence: 'high',
          method: 'uprinting_angular_dispatchevent'
        });
      }
    }
  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));
  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-angular-2026-04-17.json', JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2));
}
run().catch(e => log(`Fatal: ${e}`));
