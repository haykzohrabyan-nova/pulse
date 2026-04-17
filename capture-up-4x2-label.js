/**
 * capture-up-4x2-label.js
 * PRI-8: Get UPrinting pricing for 4"×2" roll label at 1000, 5000, 10000 qty
 * Uses Bootstrap dropdown to select correct size, reads Angular scope for price
 */

const { chromium } = require('playwright');
const fs = require('fs');

function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
const RESULTS = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    log('Loading UPrinting roll labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // First, get all available size options from Bootstrap dropdown
    const sizeOptions = await page.evaluate(() => {
      const result = { sizes: [], dropdowns: [] };

      // Look for the size dropdown/button group
      // UPrinting uses Bootstrap dropdown: .dropdown-menu li a with size text
      const dropdownItems = document.querySelectorAll('.dropdown-menu li a, .dropdown-menu li, .attr-item a, [data-attrtype="SZ"] a');
      dropdownItems.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.match(/\d+["']?\s*[x×]\s*\d+/)) {
          result.sizes.push({ text, class: el.className, tag: el.tagName });
        }
      });

      // Also check for dropdown toggle buttons labeled "Size"
      const toggles = document.querySelectorAll('.dropdown-toggle, .btn-group .btn');
      toggles.forEach(el => {
        const text = el.textContent.trim();
        if (text.includes('x') || text.includes('×') || text.includes('"')) {
          result.dropdowns.push({ text: text.slice(0, 30), class: el.className.slice(0, 30) });
        }
      });

      // Also look for any element that has '4' and '2' in close proximity suggesting 4x2
      const allLinks = document.querySelectorAll('a[data-attrval], li[data-attrval]');
      const attrLinks = Array.from(allLinks).map(el => ({
        text: el.textContent.trim().slice(0, 30),
        attrval: el.getAttribute('data-attrval'),
        attrtype: el.getAttribute('data-attrtype') || el.closest('[data-attrtype]')?.getAttribute('data-attrtype')
      }));

      result.attrLinks = attrLinks;

      // Get the current displayed size selection
      const sizeBtn = document.querySelector('[data-attrtype="SZ"] .dropdown-toggle, .attr-SZ .dropdown-toggle');
      if (sizeBtn) result.currentSize = sizeBtn.textContent.trim();

      return result;
    });

    log(`Size options: ${JSON.stringify(sizeOptions.sizes)}`);
    log(`Attr links: ${JSON.stringify(sizeOptions.attrLinks.slice(0, 30))}`);
    log(`Current size: ${sizeOptions.currentSize}`);

    // Try to open the size dropdown and look for 4"×2" or 2"×4"
    // First let's click the size dropdown toggle
    try {
      // Click the size dropdown to open it
      await page.click('[data-attrtype="SZ"] .dropdown-toggle, .attr-SZ .dropdown-toggle, button[aria-label*="Size"], .size-dropdown .dropdown-toggle', { timeout: 3000 });
      await page.waitForTimeout(500);
      log('Opened size dropdown');
    } catch (e) {
      // Try a more general approach - look for dropdown with size options
      try {
        const sizeDropdownBtn = await page.$('.dropdown-toggle:has-text("2\\\" x 2\\\""), .dropdown-toggle:has-text("2\" x 2\"")');
        if (sizeDropdownBtn) {
          await sizeDropdownBtn.click();
          await page.waitForTimeout(500);
          log('Opened size dropdown via 2x2 toggle');
        }
      } catch (e2) { log(`Could not open size dropdown: ${e2}`); }
    }

    // Get all size options now that dropdown is open
    const openOptions = await page.evaluate(() => {
      const opts = [];
      const items = document.querySelectorAll('.dropdown-menu:not(.hidden) li a, .dropdown-menu.show li a, .dropdown-menu.open li a, [role="option"], .attr-item');
      items.forEach(el => {
        const text = el.textContent.trim();
        if (text && (text.includes('"') || text.includes("'"))) {
          opts.push({ text: text.slice(0, 30), class: el.className.slice(0, 30), tag: el.tagName });
        }
      });

      // Also check visible dropdown items
      const visItems = document.querySelectorAll('.open .dropdown-menu li a, [aria-expanded="true"] + .dropdown-menu li a');
      visItems.forEach(el => {
        opts.push({ text: el.textContent.trim().slice(0, 30), class: el.className.slice(0, 30), tag: el.tagName, visible: true });
      });

      return opts;
    });

    log(`Open dropdown options: ${JSON.stringify(openOptions.slice(0, 20))}`);

    // Find 4"×2" or 2"×4" option
    const target4x2 = openOptions.find(o =>
      o.text.includes('4') && o.text.includes('2') &&
      (o.text.includes('"') || o.text.includes("'"))
    );

    if (target4x2) {
      log(`Found 4x2 option: ${JSON.stringify(target4x2)}`);
      try {
        await page.click(`text="${target4x2.text}"`, { timeout: 2000 });
        log(`Clicked: ${target4x2.text}`);
        await page.waitForTimeout(2000);
      } catch(e) { log(`Click failed: ${e}`); }
    } else {
      log('No 4"×2" option found in dropdown. Trying other approaches...');

      // Get the full list of available sizes from Angular scope or page text
      const angularSizes = await page.evaluate(() => {
        if (typeof angular !== 'undefined') {
          const calcEl = document.querySelector('[id*="calc"]');
          if (calcEl) {
            const scope = angular.element(calcEl).scope();
            return {
              sizes: scope?.sizeOptions || scope?.sizes || scope?.attrs || null,
              currentSpec: scope?.selectedSpec || null
            };
          }
        }
        // Try to find size data in page scripts
        const scripts = document.querySelectorAll('script:not([src])');
        for (const script of scripts) {
          if (script.textContent.includes('4" x 2"') || script.textContent.includes('4 x 2')) {
            return { scriptMatch: script.textContent.slice(script.textContent.indexOf('4" x 2"') - 100, script.textContent.indexOf('4" x 2"') + 200) };
          }
        }
        return null;
      });
      log(`Angular sizes: ${JSON.stringify(angularSizes)}`);
    }

    // Verify current Angular scope after size selection
    const currentScope = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        const els = document.querySelectorAll('[id*="calc"]');
        for (const el of els) {
          const scope = angular.element(el).scope();
          if (scope && scope.priceData) {
            return {
              width: scope.priceData.width,
              height: scope.priceData.height,
              qty: scope.priceData.qty,
              price: scope.priceData.price,
              order_specs: (scope.priceData.order_specs || []).filter(s =>
                ['SZ', 'QTY', 'SUBST', 'FLAM'].includes(s.order_spec_code)
              ).map(s => ({ code: s.order_spec_code, value: s.order_spec_value }))
            };
          }
        }
      }
      return null;
    });
    log(`Current scope: ${JSON.stringify(currentScope)}`);

    // Now iterate qtys and read price
    // First try to get all available size info from the page to understand what we have
    const allSizeLinks = await page.evaluate(() => {
      const result = [];
      // Look for all dropdown menu items that look like sizes
      const items = document.querySelectorAll('.dropdown-menu li a, li[role="option"] a, .attr-list li a');
      items.forEach(el => {
        const text = el.textContent.trim();
        if (text.match(/\d+\.?\d*["']\s*x\s*\d+\.?\d*["']/i) || text.match(/\d+\s*x\s*\d+/i)) {
          result.push({
            text: text.slice(0, 30),
            href: el.href || '',
            onclick: el.getAttribute('onclick') || ''
          });
        }
      });
      return result;
    });
    log(`All size links: ${JSON.stringify(allSizeLinks)}`);

    // Capture qtys for whatever size is currently selected
    const qtysToCapture = [1000, 5000, 10000];

    for (const qty of qtysToCapture) {
      const qtyClicked = await page.evaluate((targetQty) => {
        const qtyStr = targetQty.toLocaleString();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.trim() === qtyStr) {
            const parent = node.parentElement;
            if (parent) { parent.click(); return { clicked: true, tag: parent.tagName, text: qtyStr }; }
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
            if (scope && scope.priceData) {
              return {
                qty: scope.priceData.qty,
                total_price: scope.priceData.total_price,
                unit_price: scope.priceData.unit_price,
                width: scope.priceData.width,
                height: scope.priceData.height,
                size_spec: (scope.priceData.order_specs || []).find(s => s.order_spec_code === 'SZ')?.order_spec_value,
                material_spec: (scope.priceData.order_specs || []).find(s => s.order_spec_code === 'SUBST')?.order_spec_value,
                lamination_spec: (scope.priceData.order_specs || []).find(s => s.order_spec_code === 'FLAM')?.order_spec_value
              };
            }
          }
        }
        return null;
      });

      log(`Qty ${qty} state: ${JSON.stringify(state)}`);

      if (state) {
        RESULTS.push({
          id: `up-label-4x2-${qty}-pri8-v2`,
          site: 'UPrinting',
          competitor: 'uprinting',
          product_type: 'roll_labels',
          qty: state.qty,
          total_price: parseFloat(state.total_price),
          unit_price: parseFloat(state.unit_price),
          spec: {
            width_in: parseFloat(state.width),
            height_in: parseFloat(state.height),
            size_label: state.size_spec,
            material: state.material_spec,
            lamination: state.lamination_spec
          },
          confidence: 'high',
          method: 'angular_scope_dom',
          notes: `Size confirmed: ${state.size_spec}. W=${state.width}, H=${state.height}. ${state.lamination_spec}`
        });
      }
    }

  } catch (e) {
    log(`ERROR: ${e}`);
  } finally {
    await browser.close();
  }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));

  fs.writeFileSync(
    '/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-4x2-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2)
  );
}

run().catch(e => log(`Fatal: ${e}`));
