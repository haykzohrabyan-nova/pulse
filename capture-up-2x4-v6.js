/**
 * capture-up-2x4-v6.js
 * Attempt 6:
 * - data-value="15485" is the attr_val_id for 2"x4" (discovered in v5)
 * - selectedSpecs["3"] = "1405" for 2"x2" -> need to change to 15485's mapped value
 *
 * Strategy A: Add .open class to btn-group, then Playwright click (element visible)
 * Strategy B: Manipulate Angular selectedSpecs directly + trigger price calc
 * Strategy C: Call internal Angular price calc function with new specs
 */
const { chromium } = require('playwright');
const fs = require('fs');
function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
const RESULTS = [];

async function readScope(page) {
  return page.evaluate(() => {
    if (typeof angular !== 'undefined') {
      for (const el of document.querySelectorAll('[id*="calc"]')) {
        const scope = angular.element(el).scope();
        if (scope?.priceData) {
          const specs = scope.priceData.order_specs || [];
          return {
            w: scope.priceData.width, h: scope.priceData.height,
            qty: scope.priceData.qty, price: scope.priceData.price,
            total_price: scope.priceData.total_price,
            unit_price: scope.priceData.unit_price,
            size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value,
            lam: specs.find(s=>s.order_spec_code==='FLAM')?.order_spec_value,
            material: specs.find(s=>s.order_spec_code==='SUBST')?.order_spec_value,
            selectedSpecs: JSON.stringify(scope.selectedSpecs || {})
          };
        }
      }
    }
    return null;
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  // Track ALL XHR/fetch calls to capture price API
  const priceApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    // Capture any JSON responses that might be price data
    if (url.includes('uprinting.com') || url.includes('module-api') || url.includes('calc-js')) {
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json')) {
        try {
          const text = await resp.text().catch(() => null);
          if (text && text.includes('price')) {
            priceApiCalls.push({ url, body: text.slice(0, 2000) });
            log(`JSON API: ${url.slice(0, 80)}: ${text.slice(0, 200)}`);
          }
        } catch(e) {}
      }
    }
  });

  try {
    log('Loading UPrinting roll labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    log('Initial scope:');
    log(JSON.stringify(await readScope(page)));

    // === STRATEGY A: Add .open to btn-group, then click via Playwright ===
    log('\n=== STRATEGY A: Manual .open class + Playwright click ===');
    const stratA = await page.evaluate(() => {
      // Find the size button group
      const sizeBtn = Array.from(document.querySelectorAll('button.btn.dropdown-toggle'))
        .find(b => b.textContent.trim().includes('x'));
      if (!sizeBtn) return { error: 'no size btn' };
      const btnGroup = sizeBtn.closest('.btn-group, .dropdown');
      if (!btnGroup) return { error: 'no btn-group' };
      btnGroup.classList.add('open');
      return { opened: true, btnGroupClass: btnGroup.className.slice(0, 60), sizeText: sizeBtn.textContent.trim() };
    });
    log(`Strategy A setup: ${JSON.stringify(stratA)}`);

    if (stratA.opened) {
      await page.waitForTimeout(200);
      // Now the element should be visible - try Playwright click
      try {
        const target = page.locator('a.attr-value').filter({ hasText: '2" x 4"' });
        const isVisible = await target.isVisible();
        log(`"2" x 4"" visible after .open: ${isVisible}`);
        if (isVisible) {
          await target.click({ timeout: 3000 });
          log('Clicked "2" x 4"" via Playwright (visible after .open)');
          await page.waitForTimeout(3000);
        } else {
          // Try force click
          await target.click({ timeout: 3000, force: true });
          log('Force-clicked "2" x 4""');
          await page.waitForTimeout(3000);
        }
      } catch(e) {
        log(`Strategy A click error: ${e.message}`);
      }
    }

    let state = await readScope(page);
    log(`After Strategy A: ${JSON.stringify(state)}`);

    if (state?.w !== '4' && state?.h !== '2') {
      // === STRATEGY B: Direct Angular scope manipulation ===
      log('\n=== STRATEGY B: Angular scope direct manipulation ===');
      // data-value="15485" is the attr_val_id for "2" x 4""
      // selectedSpecs["3"] = "1405" for 2"x2" - need to find what 2"x4" maps to
      // Approach: set selectedSpecs["3"] to the data-value and trigger $apply
      const stratB = await page.evaluate(() => {
        if (typeof angular === 'undefined') return { error: 'no angular' };

        for (const el of document.querySelectorAll('[id*="calc"]')) {
          const scope = angular.element(el).scope();
          if (!scope?.priceData) continue;

          // Read current selectedSpecs
          const oldSpecs = JSON.parse(JSON.stringify(scope.selectedSpecs || {}));

          // Find attr_val_id for 2"x4" from the DOM
          const target2x4 = document.querySelector('a[data-value="15485"]');
          if (!target2x4) return { error: 'cannot find data-value=15485 element' };

          // Try to find what spec key to use
          // The attribute_id for SZ is "3" -> selectedSpecs["3"] = old value
          // Try setting to "15485" directly
          scope.selectedSpecs = scope.selectedSpecs || {};

          // Get the attribute_id from the LI parent
          const li = target2x4.closest('li');
          const ul = li?.closest('ul');
          const btnGroup = ul?.closest('[data-attrtype]');
          const attrType = btnGroup?.getAttribute('data-attrtype');
          log(`attr_type of dropdown: ${attrType}`);

          // Try to find the attribute ID
          const attrId = btnGroup?.getAttribute('data-attrid') || '3'; // default to 3 (Size)

          // Set the new selectedSpecs value
          scope.selectedSpecs[attrId] = '15485';

          // Also try updating priceData directly
          scope.priceData.width = '4';
          scope.priceData.height = '2';

          // Find and call the update function
          // Check parent scopes for price calculation trigger
          let parentScope = scope.$parent;
          let calcFunc = null;
          while (parentScope) {
            const funcs = Object.keys(parentScope).filter(k => typeof parentScope[k] === 'function' && !k.startsWith('$'));
            if (funcs.length > 0) { log(`parent funcs: ${funcs.join(', ')}`); }
            parentScope = parentScope.$parent;
          }

          // Trigger digest
          scope.$apply(() => {
            scope.selectedSpecs[attrId] = '15485';
            scope.priceData.width = '4';
            scope.priceData.height = '2';
          });

          return {
            oldSpecs,
            newSpecs: scope.selectedSpecs,
            attrType, attrId,
            priceDataW: scope.priceData.width,
            priceDataH: scope.priceData.height
          };
        }
        return { error: 'no calc scope found' };
      });
      log(`Strategy B: ${JSON.stringify(stratB)}`);
      await page.waitForTimeout(3000);

      state = await readScope(page);
      log(`After Strategy B: ${JSON.stringify(state)}`);
    }

    if (state?.w !== '4' && state?.h !== '2') {
      // === STRATEGY C: Call the price API directly ===
      log('\n=== STRATEGY C: Direct API call ===');
      // UPrinting uses a pricing API. Let's try to call it with size attr_val_id for 2"x4"
      // product_id=33 (roll labels), stock_attr_val_id=295 (White BOPP)
      // We need to find the correct URL from the priceData pricing_system
      const apiInfo = await page.evaluate(() => {
        if (typeof angular === 'undefined') return null;
        for (const el of document.querySelectorAll('[id*="calc"]')) {
          const scope = angular.element(el).scope();
          if (!scope?.priceData) continue;
          return {
            pricing_system: scope.priceData.pricing_system,
            calc_version: scope.priceData.calc_version,
            price_source: scope.priceData.price_source,
            product_id: scope.priceData.product_id,
            stock_attr_val_id: scope.priceData.stock_attr_val_id,
            sku: scope.priceData.sku,
            price_data: JSON.stringify(scope.priceData.price_data || {}).slice(0, 500),
          };
        }
        return null;
      });
      log(`API info: ${JSON.stringify(apiInfo)}`);

      // Try to call UPrinting's price calculation endpoint directly via page.evaluate
      // This bypasses browser CORS using page context
      if (apiInfo?.product_id) {
        const qtysToTry = [1000, 5000, 10000];
        for (const qty of qtysToTry) {
          const priceResult = await page.evaluate(async ({productId, qty, attrValId}) => {
            // Try different API endpoints that UPrinting might use
            const endpoints = [
              // Price grid endpoint pattern
              `/calculate-price?product_id=${productId}&attr_val_ids[]=21&attr_val_ids[]=${attrValId}&qty=${qty}`,
              // Module API endpoint
              `https://module-api.uprinting.com/price-calc?product_id=${productId}&qty=${qty}&attr_val_id=${attrValId}`,
            ];

            // Try getting price from Angular factory
            if (typeof angular !== 'undefined') {
              // Look for the price calculation service
              const injector = angular.element(document.querySelector('[id*="calc"]'))?.injector();
              if (injector) {
                try {
                  const $http = injector.get('$http');
                  // Try calling with new size
                  const result = await $http.get(`/calculate-price`, {
                    params: { product_id: productId, qty: qty, size_attr_val_id: attrValId }
                  });
                  return { method: 'angular_http', result: JSON.stringify(result.data).slice(0, 500) };
                } catch(e) {}
              }
            }
            return null;
          }, { productId: apiInfo.product_id, qty, attrValId: '15485' });
          log(`Direct API qty=${qty}: ${JSON.stringify(priceResult)}`);
        }
      }
    }

    // Final state check
    state = await readScope(page);
    log(`\nFinal scope: ${JSON.stringify(state)}`);
    log(`Price API calls intercepted: ${priceApiCalls.length}`);

    // If we got 2"x4" pricing, capture results
    if (state?.w === '4' && state?.h === '2') {
      log('Got 2"x4" pricing!');
      const qtys = [1000, 5000, 10000];
      for (const qty of qtys) {
        const qtyResult = await page.evaluate((targetQty) => {
          const qStr = targetQty.toLocaleString();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent.trim() === qStr) {
              const parent = node.parentElement;
              if (parent && !['SCRIPT', 'STYLE'].includes(parent.tagName)) { parent.click(); return { clicked: true }; }
            }
          }
          return { clicked: false };
        }, qty);
        await page.waitForTimeout(2000);
        const s = await readScope(page);
        log(`Qty ${qty}: ${JSON.stringify(s)}`);
        if (s) RESULTS.push({ id: `up-label-4x2-${qty}-v6`, site: 'UPrinting', product_type: 'roll_labels',
          qty: s.qty, total_price: parseFloat(s.total_price || s.price), unit_price: parseFloat(s.unit_price),
          spec: { w: parseFloat(s.w), h: parseFloat(s.h), size: s.size, lam: s.lam, material: s.material }, confidence: 'high' });
      }
    }

  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));

  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-v6-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS, price_api_calls: priceApiCalls }, null, 2));
}
run().catch(e => log(`Fatal: ${e}`));
