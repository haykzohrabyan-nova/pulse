/**
 * capture-up-2x4-v5.js
 * Attempt 5: Use Playwright filter({hasText}) to open size dropdown + click 2"x4"
 * Also tries direct Angular scope manipulation as fallback
 */
const { chromium } = require('playwright');
const fs = require('fs');
function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
const RESULTS = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  // Intercept price API calls
  const priceApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('uprinting.com') && (url.includes('price') || url.includes('calc') || url.includes('quote') || url.includes('grid'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('javascript') && !ct.includes('css')) {
          const text = await resp.text().catch(() => null);
          if (text) { priceApiCalls.push({ url, body: text.slice(0, 500) }); log(`PRICE API: ${url.split('?')[0]}: ${text.slice(0, 150)}`); }
        }
      } catch(e) {}
    }
  });

  try {
    log('Loading UPrinting roll labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Get current scope
    const initialScope = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        for (const el of document.querySelectorAll('[id*="calc"]')) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            return { w: scope.priceData.width, h: scope.priceData.height,
                     currentSizeIdValue: scope.currentSizeIdValue,
                     qty: scope.priceData.qty, price: scope.priceData.price };
          }
        }
      }
      return null;
    });
    log(`Initial scope: ${JSON.stringify(initialScope)}`);

    // Explore Angular scope to find size ID map
    const sizeMap = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        for (const el of document.querySelectorAll('[id*="calc"], [ng-controller]')) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            return {
              currentSizeIdValue: scope.currentSizeIdValue,
              selectedSpecs: scope.selectedSpecs ? JSON.stringify(scope.selectedSpecs).slice(0, 1000) : null,
              config_keys: scope.config ? Object.keys(scope.config) : null,
              config_sizes: scope.config?.sizes ? JSON.stringify(scope.config.sizes).slice(0, 500) : null,
              priceData_keys: Object.keys(scope.priceData).filter(k => !k.startsWith('$')),
              attr_val_id: scope.priceData.attr_val_id,
              size_attr_val_id: scope.priceData.size_attr_val_id,
              specs_raw: JSON.stringify(scope.priceData.order_specs || []).slice(0, 500)
            };
          }
        }
      }
      return null;
    });
    log(`Scope size map: ${JSON.stringify(sizeMap)}`);

    // Approach 1: Use Playwright filter({hasText}) to find and click size dropdown button
    log('Approach 1: filter({hasText}) to open size dropdown...');
    try {
      // Find the button with text "2" x 2"" (current size)
      const sizeBtn = page.locator('button.btn.dropdown-toggle').filter({ hasText: '2" x 2"' });
      const btnCount = await sizeBtn.count();
      log(`Size buttons matching "2" x 2"": ${btnCount}`);

      if (btnCount > 0) {
        await sizeBtn.first().click({ timeout: 5000 });
        log('Clicked size dropdown toggle');
        await page.waitForTimeout(700);

        // Check if dropdown opened (Bootstrap adds .open to parent)
        const dropdownOpen = await page.evaluate(() => {
          const openMenus = document.querySelectorAll('.btn-group.open, .dropdown.open');
          return openMenus.length > 0;
        });
        log(`Dropdown opened (has .open class): ${dropdownOpen}`);

        // Now try to click "2" x 4"" in the open dropdown
        const target = page.locator('li a').filter({ hasText: '2" x 4"' });
        const targetCount = await target.count();
        log(`"2" x 4"" link count: ${targetCount}`);

        if (targetCount > 0) {
          await target.first().click({ timeout: 5000, force: true });
          log('Clicked "2" x 4""');
          await page.waitForTimeout(3000);
        }
      }
    } catch(e) {
      log(`Approach 1 error: ${e.message}`);
    }

    // Check scope after Approach 1
    let afterScope = await page.evaluate(() => {
      if (typeof angular !== 'undefined') {
        for (const el of document.querySelectorAll('[id*="calc"]')) {
          const scope = angular.element(el).scope();
          if (scope?.priceData) {
            return { w: scope.priceData.width, h: scope.priceData.height, qty: scope.priceData.qty, price: scope.priceData.price };
          }
        }
      }
      return null;
    });
    log(`After Approach 1: ${JSON.stringify(afterScope)}`);

    if (afterScope?.w !== '2' || afterScope?.h !== '4') {
      log('Approach 1 did not change size. Trying Approach 2: Angular scope direct injection...');

      // Approach 2: Find the Angular controller function for size changes
      // Try calling selectSize or similar function with w=2, h=4
      const approach2Result = await page.evaluate(() => {
        if (typeof angular === 'undefined') return { error: 'no angular' };

        for (const el of document.querySelectorAll('[id*="calc"], [ng-controller]')) {
          const scope = angular.element(el).scope();
          if (!scope?.priceData) continue;

          // Explore scope functions
          const funcs = Object.keys(scope).filter(k => typeof scope[k] === 'function' && !k.startsWith('$'));

          // Look for size-related functions
          const sizeFuncs = funcs.filter(k => /size|attr|select|change|click/i.test(k));

          return {
            allFuncs: funcs.slice(0, 30),
            sizeFuncs,
            priceData_w: scope.priceData.width,
            priceData_h: scope.priceData.height,
          };
        }
        return null;
      });
      log(`Approach 2 scope functions: ${JSON.stringify(approach2Result)}`);

      // Approach 3: Try to find size change via the URL (UPrinting sometimes uses URL params for sizes)
      // Navigate to URL with size parameter
      const currentUrl = page.url();
      log(`Current URL: ${currentUrl}`);

      // Approach 4: Find A elements for 2"x4" specifically, then use JS to:
      // - make the parent dropdown open
      // - click the link with proper event sequence
      const approach4Result = await page.evaluate(() => {
        // Find all A elements with 2"x4" text
        const all_as = Array.from(document.querySelectorAll('a'));
        const target = all_as.find(a => a.textContent.trim() === '2" x 4"');
        if (!target) return { found: false };

        const li = target.closest('li');
        const ul = li?.closest('ul');
        const btnGroup = ul?.closest('.btn-group, .dropdown');

        // Force open the dropdown via Bootstrap if jQuery is available
        if (typeof $ !== 'undefined') {
          // Toggle the dropdown to open it first
          const toggle = btnGroup?.querySelector('.dropdown-toggle');
          if (toggle) {
            $(toggle).dropdown('toggle');
            // Wait a tick then click the target
            setTimeout(() => { $(target).trigger('click'); }, 100);
            return { found: true, method: 'jquery_dropdown_toggle', toggleText: toggle.textContent.trim() };
          }
        }

        // Without jQuery, try adding the 'open' class manually to show the menu
        if (btnGroup) {
          btnGroup.classList.add('open');
          // Now click the target (it's now visible)
          target.click();
          btnGroup.classList.remove('open');
          return { found: true, method: 'manual_open_class_click' };
        }

        return { found: true, method: 'none_worked', liClass: li?.className };
      });
      log(`Approach 4: ${JSON.stringify(approach4Result)}`);
      await page.waitForTimeout(3000);

      afterScope = await page.evaluate(() => {
        if (typeof angular !== 'undefined') {
          for (const el of document.querySelectorAll('[id*="calc"]')) {
            const scope = angular.element(el).scope();
            if (scope?.priceData) {
              return { w: scope.priceData.width, h: scope.priceData.height, qty: scope.priceData.qty, price: scope.priceData.price };
            }
          }
        }
        return null;
      });
      log(`After Approach 4: ${JSON.stringify(afterScope)}`);
    }

    // If we now have 2"x4", get prices at 1000, 5000, 10000
    if (afterScope?.w === '4' && afterScope?.h === '2') {
      log('SUCCESS: Size changed to 4"x2"! Now capturing qtys...');
      const qtys = [1000, 5000, 10000];
      for (const qty of qtys) {
        // Try to click qty
        const qtyResult = await page.evaluate((targetQty) => {
          const qStr = targetQty.toLocaleString();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent.trim() === qStr) {
              const parent = node.parentElement;
              if (parent && parent.tagName !== 'SCRIPT') { parent.click(); return { clicked: true }; }
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
        log(`Qty ${qty} state: ${JSON.stringify(state)}`);

        if (state) {
          RESULTS.push({
            id: `up-label-2x4-${qty}-v5`,
            site: 'UPrinting', competitor: 'uprinting',
            product_type: 'roll_labels',
            qty: state.qty, total_price: parseFloat(state.total_price),
            unit_price: parseFloat(state.unit_price),
            spec: { width_in: parseFloat(state.w), height_in: parseFloat(state.h), size_label: state.size, material: state.material, lamination: state.lam },
            confidence: 'high', method: 'uprinting_size_select_v5'
          });
        }
      }
    } else {
      log(`Size change failed. Final state: w=${afterScope?.w}, h=${afterScope?.h}`);
      log('Capturing whatever price is showing at current size for reference...');
      // Capture current size/qty as reference
      const refState = await page.evaluate(() => {
        if (typeof angular !== 'undefined') {
          for (const el of document.querySelectorAll('[id*="calc"]')) {
            const scope = angular.element(el).scope();
            if (scope?.priceData) {
              const specs = scope.priceData.order_specs || [];
              return { w: scope.priceData.width, h: scope.priceData.height, qty: scope.priceData.qty, price: scope.priceData.price, size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value };
            }
          }
        }
        return null;
      });
      log(`Reference state: ${JSON.stringify(refState)}`);
    }

  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));
  log(`\nAPI calls: ${priceApiCalls.length}`);
  priceApiCalls.forEach(c => log(`  ${c.url}`));

  fs.writeFileSync(
    '/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-v5-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS, api_calls: priceApiCalls }, null, 2)
  );
}
run().catch(e => log(`Fatal: ${e}`));
