/**
 * Capture UPrinting 2"×4" roll label pricing via their pricing API
 * Discovers attr_val_id for 2×4 size, then calls price grid API
 */
const { chromium } = require('playwright');
const fs = require('fs');
function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
const RESULTS = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();

  // Intercept pricing API calls
  const priceApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('uprinting.com') && (url.includes('price') || url.includes('grid') || url.includes('attr') || url.includes('product_id'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        const text = await resp.text().catch(() => null);
        if (text) { priceApiCalls.push({ url, status: resp.status(), ct, body: text.slice(0, 3000) }); log(`UP API: ${url} -> ${text.slice(0, 200)}`); }
      } catch(e) {}
    }
  });

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('uprinting') && url.includes('price')) log(`REQ: ${req.method()} ${url}`);
  });

  try {
    log('Loading UPrinting roll labels to discover APIs...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Get all data-attrval attributes from the size dropdown
    const sizeAttrVals = await page.evaluate(() => {
      const result = [];
      // Get attr values from A elements in the size dropdown
      const sizeAs = document.querySelectorAll('li.blurb-list-dropdown a.attr-value, li.dropdown-menu-item a.attr-value');
      for (const a of sizeAs) {
        const attrval = a.getAttribute('data-attrval') || '';
        const text = a.textContent.trim();
        result.push({ text, attrval });
      }
      // Also get from any LI with data-attrval
      const sizeItems = document.querySelectorAll('li[data-attrval]');
      for (const li of sizeItems) {
        result.push({ text: li.textContent.trim().slice(0, 20), attrval: li.getAttribute('data-attrval'), from: 'li' });
      }
      return result;
    });
    log(`Size attr vals: ${JSON.stringify(sizeAttrVals.slice(0, 20))}`);

    // Find the 2"x4" attr val
    const target2x4 = sizeAttrVals.find(s => s.text.trim() === '2" x 4"');
    log(`2"x4" attrval entry: ${JSON.stringify(target2x4)}`);

    // Also get initial Angular scope to see product structure
    const angScope = await page.evaluate(() => {
      if (typeof angular === 'undefined') return null;
      for (const el of document.querySelectorAll('[id*="calc"]')) {
        const scope = angular.element(el).scope();
        if (scope?.priceData) {
          return {
            product_id: scope.priceData.product_id,
            stock_attr_val_id: scope.priceData.stock_attr_val_id,
            attr_val_id: scope.priceData.attr_val_id,
            width: scope.priceData.width,
            height: scope.priceData.height,
            // Get the scope object to find useful functions/methods
            scopeKeys: Object.keys(scope).filter(k => !k.startsWith('$')).slice(0, 20)
          };
        }
      }
      return null;
    });
    log(`Angular scope structure: ${JSON.stringify(angScope)}`);

    // Try to get all attr_val_ids available in the Angular scope
    const allAttrVals = await page.evaluate(() => {
      if (typeof angular === 'undefined') return null;
      for (const el of document.querySelectorAll('[id*="calc"]')) {
        const scope = angular.element(el).scope();
        if (scope?.priceData) {
          return {
            attrs: scope.attrs || scope.priceData.attrs || null,
            availableAttrs: scope.availableAttrs || null,
            sizes: scope.sizes || null,
            config: scope.config || null
          };
        }
      }
      return null;
    });
    log(`Available attrs: ${JSON.stringify(String(allAttrVals).slice(0, 500))}`);

    // Try clicking the size to 2"×4" using Playwright's click with proper options
    // First find the exact location of the "2" x 4"" LI element
    const has2x4 = await page.evaluate(() => {
      const lis = document.querySelectorAll('li.blurb-list-dropdown');
      for (const li of lis) {
        if (li.textContent.trim() === '2" x 4"') return true;
      }
      return false;
    });
    log(`Has 2"×4" LI: ${has2x4}`);

    if (has2x4) {
      // Try to use Playwright's locator
      try {
        // First open dropdown by clicking size toggle
        // Find dropdown containing 2"×2" (currently selected) and toggle it
        const allButtons = await page.evaluate(() => {
          const btns = document.querySelectorAll('button.btn.dropdown-toggle');
          return Array.from(btns).map(b => ({ text: b.textContent.trim().slice(0,30), id: b.id, class: b.className.slice(0,40) }));
        });
        log(`All dropdown-toggle buttons: ${JSON.stringify(allButtons)}`);

        // Find the button showing current size
        const sizeBtn = allButtons.find(b => b.text.includes('"') || b.text.includes('x'));
        if (sizeBtn) {
          log(`Found size button: ${JSON.stringify(sizeBtn)}`);
          await page.click(`button.btn.dropdown-toggle:nth-of-type(${allButtons.indexOf(sizeBtn) + 1})`, { timeout: 2000 });
          await page.waitForTimeout(300);
        }

        // Now try to click "2" x 4"" using locator
        await page.locator('li.blurb-list-dropdown').filter({ hasText: '2" x 4"' }).click({ timeout: 5000, force: true });
        log('Clicked 2"×4" via Playwright locator');
        await page.waitForTimeout(2000);
      } catch(e) {
        log(`Locator click failed: ${e}`);

        // Try dispatchEvent with Angular $apply hack
        const angularHack = await page.evaluate(() => {
          const lis = document.querySelectorAll('li.blurb-list-dropdown');
          for (const li of lis) {
            if (li.textContent.trim() === '2" x 4"') {
              // Temporarily show it
              li.classList.remove('hidden');
              const a = li.querySelector('a');
              if (a) {
                // Try angular-ng-click pattern
                const ngClick = a.getAttribute('ng-click') || '';
                // Fire actual browser event to trigger Bootstrap handlers
                a.click();
                // Also trigger jQuery events if available
                if (typeof $ !== 'undefined') {
                  $(a).trigger('click');
                }
                return { clicked: true, text: li.textContent.trim(), ngClick };
              }
            }
          }
          return { clicked: false };
        });
        log(`Angular hack: ${JSON.stringify(angularHack)}`);
        await page.waitForTimeout(2000);
      }

      // Read current state
      const stateAfter = await page.evaluate(() => {
        if (typeof angular !== 'undefined') {
          for (const el of document.querySelectorAll('[id*="calc"]')) {
            const scope = angular.element(el).scope();
            if (scope?.priceData) {
              const specs = scope.priceData.order_specs || [];
              return { w: scope.priceData.width, h: scope.priceData.height, size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value, qty: scope.priceData.qty, price: scope.priceData.total_price };
            }
          }
        }
        return null;
      });
      log(`State after click attempt: ${JSON.stringify(stateAfter)}`);
    }

    // Summarize what we found
    log(`\nAPI calls intercepted: ${priceApiCalls.length}`);
    priceApiCalls.forEach(c => log(`  ${c.url}: ${c.body.slice(0, 300)}`));

  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-api-2026-04-17.json', JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS, note: 'API discovery session' }, null, 2));
}
run().catch(e => log(`Fatal: ${e}`));
