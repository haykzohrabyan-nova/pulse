/**
 * capture-up-2x4-final.js
 * Select "2" x 4"" size from UPrinting roll labels (= 4"×2" rectangle),
 * capture price at 1000, 5000, 10000 qty, change lamination to Matte
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

    // Click the size dropdown toggle to open it
    const dropdownOpened = await page.evaluate(() => {
      // Find the size dropdown button (currently showing "2" x 2"")
      const sizeDropdown = document.querySelector('.attr-SZ .dropdown-toggle, [data-attrtype="SZ"] .dropdown-toggle, .btn-group.attr-SZ button');
      if (sizeDropdown) {
        sizeDropdown.click();
        return { clicked: true, text: sizeDropdown.textContent.trim() };
      }
      // Try finding by label text
      const labels = document.querySelectorAll('.calculator-label, .attr-label');
      for (const label of labels) {
        if (label.textContent.trim() === 'Size') {
          const btn = label.closest('.attr-container')?.querySelector('.dropdown-toggle');
          if (btn) { btn.click(); return { clicked: true, via: 'label', text: btn.textContent.trim() }; }
        }
      }
      return { clicked: false };
    });
    log(`Size dropdown opened: ${JSON.stringify(dropdownOpened)}`);
    await page.waitForTimeout(500);

    // Click on "2" x 4"" option
    const clicked2x4 = await page.evaluate(() => {
      // Find LI or A element with exactly '2" x 4"'
      const target = '2" x 4"';
      const els = document.querySelectorAll('.dropdown-menu li a, .attr-value, li.dropdown-menu-item a');
      for (const el of els) {
        if (el.textContent.trim() === target) {
          el.click();
          return { clicked: true, tag: el.tagName, class: el.className };
        }
      }
      // Try via Angular click - find the LI with this text
      const lis = document.querySelectorAll('li');
      for (const li of lis) {
        if (li.textContent.trim() === target) {
          li.click();
          const a = li.querySelector('a');
          if (a) a.click();
          return { clicked: true, via: 'LI', text: li.textContent.trim() };
        }
      }
      return { clicked: false, available: Array.from(document.querySelectorAll('.attr-value')).filter(e => e.textContent.trim().includes('4')).map(e => e.textContent.trim()).slice(0, 10) };
    });
    log(`2"x4" click: ${JSON.stringify(clicked2x4)}`);
    await page.waitForTimeout(2000);

    // Check current scope after size selection
    const afterSize = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        const els = document.querySelectorAll('[id*="calc"]');
        for (const el of els) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            return { w: scope.priceData.width, h: scope.priceData.height, size: (scope.priceData.order_specs||[]).find(s=>s.order_spec_code==='SZ')?.order_spec_value, lam: (scope.priceData.order_specs||[]).find(s=>s.order_spec_code==='FLAM')?.order_spec_value, qty: scope.priceData.qty, price: scope.priceData.price };
          }
        }
      }
      return null;
    });
    log(`After size select: ${JSON.stringify(afterSize)}`);

    // Now try to change lamination to Matte (Matte Indoor or similar)
    // First open the lamination dropdown
    const lamState = await page.evaluate(() => {
      const lamDropdown = document.querySelector('.attr-FLAM .dropdown-toggle, [data-attrtype="FLAM"] .dropdown-toggle');
      if (lamDropdown) {
        lamDropdown.click();
        return { clicked: true, current: lamDropdown.textContent.trim() };
      }
      return { clicked: false };
    });
    log(`Lamination dropdown: ${JSON.stringify(lamState)}`);
    await page.waitForTimeout(300);

    // Click Matte option
    const matteClicked = await page.evaluate(() => {
      const els = document.querySelectorAll('.attr-FLAM .dropdown-menu li a, [data-attrtype="FLAM"] .dropdown-menu li a, .attr-FLAM .attr-value');
      for (const el of els) {
        const text = el.textContent.trim();
        if (text.toLowerCase().includes('matte') && !text.toLowerCase().includes('soft')) {
          el.click();
          return { clicked: true, text };
        }
      }
      // Try all dropdown items looking for Matte
      const allOptions = document.querySelectorAll('.dropdown-menu.open li a, .dropdown-menu.show li a');
      for (const el of allOptions) {
        const text = el.textContent.trim();
        if (text.toLowerCase().includes('matte')) {
          el.click();
          return { clicked: true, text };
        }
      }
      return { clicked: false };
    });
    log(`Matte click: ${JSON.stringify(matteClicked)}`);
    await page.waitForTimeout(2000);

    // Check current lamination
    const afterLam = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        const els = document.querySelectorAll('[id*="calc"]');
        for (const el of els) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            return { lam: (scope.priceData.order_specs||[]).find(s=>s.order_spec_code==='FLAM')?.order_spec_value, size: (scope.priceData.order_specs||[]).find(s=>s.order_spec_code==='SZ')?.order_spec_value };
          }
        }
      }
      return null;
    });
    log(`After lam: ${JSON.stringify(afterLam)}`);

    // Now get prices at 1000, 5000, 10000 qty
    const qtys = [1000, 5000, 10000];
    for (const qty of qtys) {
      const qtyClicked = await page.evaluate((q) => {
        const qStr = q.toLocaleString();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.trim() === qStr) {
            const parent = node.parentElement;
            if (parent) { parent.click(); return { clicked: true }; }
          }
        }
        return { clicked: false };
      }, qty);
      log(`Qty ${qty} click: ${JSON.stringify(qtyClicked)}`);
      await page.waitForTimeout(2000);

      const state = await page.evaluate(() => {
        if (typeof angular !== 'undefined') {
          const els = document.querySelectorAll('[id*="calc"]');
          for (const el of els) {
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
      log(`Qty ${qty} state: ${JSON.stringify(state)}`);

      if (state) {
        RESULTS.push({
          id: `up-label-2x4-${qty}-pri8`,
          site: 'UPrinting', competitor: 'uprinting',
          product_type: 'roll_labels',
          qty: state.qty,
          total_price: parseFloat(state.total_price),
          unit_price: parseFloat(state.unit_price),
          spec: { width_in: parseFloat(state.w), height_in: parseFloat(state.h), size_label: state.size, material: state.material, lamination: state.lam },
          confidence: 'high',
          method: 'uprinting_angular_scope',
          notes: `Size: ${state.size} W=${state.w} H=${state.h}. Lam: ${state.lam}`
        });
      }
    }
  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));
  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-2026-04-17.json', JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2));
}
run().catch(e => log(`Fatal: ${e}`));
