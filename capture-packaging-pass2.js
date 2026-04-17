/**
 * capture-packaging-pass2.js
 * NOV-9: Targeted pass — extract UPrinting box specs + multi-qty pricing,
 *         UPrinting pouch specs + pricing, UPrinting label multi-qty,
 *         and GotPrint catalog URL discovery.
 *
 * Run: node capture-packaging-pass2.js
 */

const { chromium } = require('playwright');

const RESULTS = [];
const ERRORS = [];

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function recordResult(entry) {
  RESULTS.push(entry);
  log(`CAPTURED: ${JSON.stringify(entry)}`);
}

// ─── UPrinting Boxes — Full Spec + Multi-Qty ─────────────────────────────────
async function captureUPBoxesFull(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const priceAPIs = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('uprinting.com') && (url.includes('price') || url.includes('calc') || url.includes('quote') || url.includes('product_id'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text')) {
          const text = await resp.text().catch(() => null);
          if (text && text.length < 50000) priceAPIs.push({ url, body: text.slice(0, 3000) });
        }
      } catch (e) {}
    }
  });

  try {
    // Load the product-boxes page which showed $2.70/unit $675.00 total
    log('UP Boxes: loading product-boxes page for full spec...');
    await page.goto('https://www.uprinting.com/product-boxes.html', { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(3000);

    // Extract full page state
    const fullState = await page.evaluate(() => {
      // Try Angular scope
      const r = {};
      try {
        if (typeof angular !== 'undefined') {
          const calcEls = document.querySelectorAll('[id*="calc"], [ng-controller], [data-ng-controller]');
          for (const el of calcEls) {
            const scope = angular.element(el).scope();
            if (scope && scope.priceData) {
              r.angularScope = {
                priceData: scope.priceData,
                qty: scope.qty,
                selectedSize: scope.selectedSize,
                orderSpecs: scope.priceData && scope.priceData.order_specs
              };
              break;
            }
          }
        }
      } catch (e) { r.angularError = String(e); }

      // Get all text with prices
      const priceNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (/\$[\d,]+\.?\d*/.test(node.textContent)) {
          const parent = node.parentElement;
          priceNodes.push({
            text: node.textContent.trim(),
            parentId: parent ? parent.id : '',
            parentClass: parent ? parent.className.slice(0, 50) : '',
            parentTag: parent ? parent.tagName : ''
          });
        }
      }
      r.priceNodes = priceNodes.slice(0, 30);

      // Get all select elements with their current state
      r.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      })).filter(s => s.options.length > 1);

      // Get page title and h1
      r.title = document.title;
      r.h1 = document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : '';

      // Look for a product configurator form
      const forms = Array.from(document.querySelectorAll('form'));
      r.forms = forms.map(f => ({ id: f.id, class: f.className.slice(0, 50), action: f.action })).slice(0, 5);

      // Find price display elements
      const priceDisplays = document.querySelectorAll('.price, #price, .total, #total, [class*="price-total"], [class*="total-price"]');
      r.priceDisplays = Array.from(priceDisplays).map(e => ({ tag: e.tagName, id: e.id, class: e.className.slice(0, 50), text: e.textContent.trim() })).slice(0, 10);

      return r;
    });
    log(`UP Boxes full state: ${JSON.stringify(fullState).slice(0, 3000)}`);

    // Try the straight-tuck-end-boxes page with pricing configurator
    log('UP Boxes: loading STE boxes for pricing...');
    await page.goto('https://www.uprinting.com/straight-tuck-end-boxes.html', { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(3000);

    const steState = await page.evaluate(() => {
      const r = {};
      try {
        if (typeof angular !== 'undefined') {
          const calcEls = document.querySelectorAll('[id*="calc"]');
          for (const el of calcEls) {
            const scope = angular.element(el).scope();
            if (scope && scope.priceData) {
              r.angularScope = {
                priceData: scope.priceData,
                orderSpecs: scope.priceData && scope.priceData.order_specs,
                product_id: scope.priceData && scope.priceData.product_id,
                item_name: scope.priceData && scope.priceData.item_name,
                width: scope.priceData && scope.priceData.width,
                height: scope.priceData && scope.priceData.height
              };
              break;
            }
          }
        }
      } catch (e) { r.angularError = String(e); }

      const priceNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (/\$[\d,]+\.?\d*/.test(node.textContent)) {
          priceNodes.push(node.textContent.trim());
        }
      }
      r.priceNodes = priceNodes.slice(0, 20);
      r.title = document.title;

      return r;
    });
    log(`UP STE state: ${JSON.stringify(steState).slice(0, 2000)}`);

    // If Angular found, try clicking qty options
    if (steState.angularScope && steState.angularScope.priceData) {
      log(`UP Boxes STE: Angular scope found! Default price: ${steState.angularScope.priceData.price}`);
      log(`UP Boxes STE specs: ${JSON.stringify(steState.angularScope)}`);

      // Try clicking different qty options
      const qtysToTry = ['25', '50', '100', '250', '500', '1000', '2000', '2500'];
      for (const qty of qtysToTry) {
        const result = await page.evaluate((targetQty) => {
          try {
            const calcEl = Array.from(document.querySelectorAll('[id*="calc"]')).find(el => {
              try { return angular.element(el).scope().priceData; } catch (e) { return false; }
            });
            if (!calcEl) return { error: 'no calc el' };

            // Try to click the qty in grid
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            let clicked = false;
            while (node = walker.nextNode()) {
              const txt = node.textContent.trim().replace(/,/g, '');
              if (txt === targetQty) {
                const parent = node.parentElement;
                if (parent) {
                  parent.click();
                  clicked = true;
                  break;
                }
              }
            }
            if (!clicked) return { error: `qty ${targetQty} text not found` };

            // Give Angular time to update (synchronous in eval context, won't work — return marker)
            return { clicked: true, qty: targetQty };
          } catch (e) {
            return { error: String(e) };
          }
        }, qty);

        if (result.clicked) {
          await page.waitForTimeout(600);
          const priceData = await page.evaluate(() => {
            try {
              const calcEl = Array.from(document.querySelectorAll('[id*="calc"]')).find(el => {
                try { return angular.element(el).scope().priceData; } catch (e) { return false; }
              });
              if (!calcEl) return null;
              const scope = angular.element(calcEl).scope();
              return {
                qty: scope.priceData.qty,
                price: scope.priceData.price,
                unit_price: scope.priceData.unit_price,
                width: scope.priceData.width,
                height: scope.priceData.height,
                item_name: scope.priceData.item_name,
                order_specs: scope.priceData.order_specs
              };
            } catch (e) { return { error: String(e) }; }
          });
          log(`UP Boxes STE qty ${qty}: ${JSON.stringify(priceData)}`);

          if (priceData && priceData.price && !priceData.error) {
            recordResult({
              id: `up-box-ste-${priceData.qty}`,
              site: 'UPrinting',
              product_type: 'straight_tuck_end_box',
              qty: priceData.qty,
              total_price: parseFloat(priceData.price),
              unit_price: parseFloat(priceData.unit_price),
              width: priceData.width,
              height: priceData.height,
              item_name: priceData.item_name,
              order_specs: priceData.order_specs,
              status: 'live',
              confidence: 'high',
              method: 'Angular scope — STE boxes page',
              notes: 'Default size on page load'
            });
          }
        }
      }
    } else {
      log(`UP Boxes STE: no Angular scope. page_prices: ${JSON.stringify(steState.priceNodes)}`);
    }

    // Log all intercepted API responses
    log(`UP Boxes: intercepted ${priceAPIs.length} pricing API calls`);
    priceAPIs.forEach(r => {
      if (!r.url.includes('google') && !r.url.includes('linkedin') && !r.url.includes('facebook')) {
        log(`  API: ${r.url}`);
        log(`  Body: ${r.body.slice(0, 500)}`);
      }
    });

  } catch (e) {
    ERRORS.push({ site: 'UPrinting-boxes', error: String(e) });
    log(`UP Boxes error: ${e}`);
  } finally {
    await context.close();
  }
}

// ─── UPrinting Pouches — Full Spec + Multi-Qty ────────────────────────────────
async function captureUPPouchesFull(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const priceAPIs = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('uprinting.com') && (url.includes('price') || url.includes('calc') || url.includes('quote'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text) priceAPIs.push({ url, body: text.slice(0, 3000) });
        }
      } catch (e) {}
    }
  });

  try {
    log('UP Pouches: loading custom-stand-up-pouches page...');
    await page.goto('https://www.uprinting.com/custom-stand-up-pouches.html', { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(3000);

    const pouchState = await page.evaluate(() => {
      const r = {};
      try {
        if (typeof angular !== 'undefined') {
          const calcEls = document.querySelectorAll('[id*="calc"]');
          for (const el of calcEls) {
            const scope = angular.element(el).scope();
            if (scope && scope.priceData) {
              r.angularScope = {
                priceData: scope.priceData,
                qty: scope.qty,
                item_name: scope.priceData.item_name,
                width: scope.priceData.width,
                height: scope.priceData.height,
                order_specs: scope.priceData.order_specs
              };
              break;
            }
          }
        }
      } catch (e) { r.angularError = String(e); }

      const priceNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (/\$[\d,]+\.?\d*/.test(node.textContent)) {
          priceNodes.push(node.textContent.trim());
        }
      }
      r.priceNodes = priceNodes.slice(0, 20);

      r.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      })).filter(s => s.name || s.id);

      return r;
    });
    log(`UP Pouches state: ${JSON.stringify(pouchState).slice(0, 3000)}`);

    if (pouchState.angularScope) {
      log(`UP Pouches: Angular scope found! ${JSON.stringify(pouchState.angularScope)}`);

      // Try clicking qty options
      const qtysToTry = ['100', '250', '500', '1000', '2500', '5000'];
      for (const qty of qtysToTry) {
        await page.evaluate((targetQty) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent.trim().replace(/,/g, '') === targetQty) {
              const parent = node.parentElement;
              if (parent) { parent.click(); return true; }
            }
          }
          return false;
        }, qty);

        await page.waitForTimeout(700);

        const priceData = await page.evaluate(() => {
          try {
            const calcEl = Array.from(document.querySelectorAll('[id*="calc"]')).find(el => {
              try { return angular.element(el).scope().priceData; } catch (e) { return false; }
            });
            if (!calcEl) return null;
            const scope = angular.element(calcEl).scope();
            return {
              qty: scope.priceData.qty,
              price: scope.priceData.price,
              unit_price: scope.priceData.unit_price,
              width: scope.priceData.width,
              height: scope.priceData.height,
              item_name: scope.priceData.item_name,
              order_specs: scope.priceData.order_specs
            };
          } catch (e) { return { error: String(e) }; }
        });

        log(`UP Pouches qty ${qty}: ${JSON.stringify(priceData)}`);
        if (priceData && priceData.price && !priceData.error) {
          recordResult({
            id: `up-pouch-${priceData.qty}`,
            site: 'UPrinting',
            product_type: 'stand_up_pouch',
            qty: priceData.qty,
            total_price: parseFloat(priceData.price),
            unit_price: parseFloat(priceData.unit_price),
            width: priceData.width,
            height: priceData.height,
            item_name: priceData.item_name,
            order_specs: priceData.order_specs,
            status: 'live',
            confidence: 'high',
            method: 'Angular scope — custom-stand-up-pouches page',
            notes: 'Default size on page load'
          });
        }
      }
    }

  } catch (e) {
    ERRORS.push({ site: 'UPrinting-pouches', error: String(e) });
    log(`UP Pouches error: ${e}`);
  } finally {
    await context.close();
  }
}

// ─── UPrinting Labels — Multi-Qty via Angular ────────────────────────────────
async function captureUPLabelsMultiQty(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    log('UP Labels: loading roll-labels with size 3×3...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Get initial scope
    const initScope = await page.evaluate(() => {
      try {
        const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc_33"]');
        if (!calcEl || typeof angular === 'undefined') return { error: 'no calc or angular' };
        const scope = angular.element(calcEl).scope();
        if (!scope || !scope.priceData) return { error: 'no scope.priceData' };
        return {
          qty: scope.priceData.qty,
          price: scope.priceData.price,
          width: scope.priceData.width,
          height: scope.priceData.height,
          calcElId: calcEl.id
        };
      } catch (e) { return { error: String(e) }; }
    });
    log(`UP Labels init scope: ${JSON.stringify(initScope)}`);

    if (initScope.error) {
      log('UP Labels: Angular not accessible, trying direct grid approach');
      // Try finding the product ID for price API
      const nextData = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (el) return JSON.parse(el.textContent);
        return null;
      });
      if (nextData) {
        log(`UP Labels __NEXT_DATA__ found: ${JSON.stringify(nextData).slice(0, 500)}`);
      }
      return;
    }

    const calcElId = initScope.calcElId;

    // Try different sizes first — find Bootstrap dropdown items
    const sizeItems = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.dropdown-menu a, [data-group="attr4"] a, [class*="size"] a[data-value]'));
      return items.map(a => ({
        text: a.textContent.trim(),
        dataValue: a.getAttribute('data-value'),
        href: a.getAttribute('href')
      })).filter(i => i.text || i.dataValue).slice(0, 20);
    });
    log(`UP Labels size items: ${JSON.stringify(sizeItems)}`);

    // Try to select 3×3 size
    const size3x3 = sizeItems.find(i => i.text.includes('3"') && i.text.includes('x'));
    if (size3x3) {
      log(`UP Labels: clicking 3×3 size item: ${JSON.stringify(size3x3)}`);
      await page.evaluate((val) => {
        const items = Array.from(document.querySelectorAll('a[data-value]'));
        for (const item of items) {
          if (item.getAttribute('data-value') === val || item.textContent.trim().includes('3" x 3"')) {
            item.click();
            break;
          }
        }
      }, size3x3.dataValue);
      await page.waitForTimeout(2000);
    }

    // Capture qty points
    const qtysToCapture = ['100', '250', '500', '1000', '2000', '2500', '3000', '4000', '5000', '10000'];
    for (const qty of qtysToCapture) {
      const result = await page.evaluate((targetQty, calcId) => {
        try {
          const calcEl = document.getElementById(calcId) || document.querySelector('[id*="calc_33"]');
          if (!calcEl || typeof angular === 'undefined') return { error: 'no calc' };

          const walker = document.createTreeWalker(calcEl, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const txt = node.textContent.trim();
            if (txt === targetQty || txt.replace(/,/g, '') === targetQty) {
              const parent = node.parentElement;
              if (parent) {
                parent.click();
                return { clicked: true };
              }
            }
          }
          return { error: `${targetQty} not found in calc grid` };
        } catch (e) { return { error: String(e) }; }
      }, qty, calcElId);

      if (result.clicked) {
        await page.waitForTimeout(500);
        const pd = await page.evaluate((calcId) => {
          try {
            const calcEl = document.getElementById(calcId) || document.querySelector('[id*="calc_33"]');
            const scope = angular.element(calcEl).scope();
            if (!scope || !scope.priceData) return null;
            return {
              qty: scope.priceData.qty,
              price: scope.priceData.price,
              unit_price: scope.priceData.unit_price,
              width: scope.priceData.width,
              height: scope.priceData.height,
              turnaround: scope.priceData.turnaround
            };
          } catch (e) { return null; }
        }, calcElId);

        if (pd && pd.price) {
          log(`UP Labels ${qty}: qty=${pd.qty} total=$${pd.price} unit=$${pd.unit_price} size=${pd.width}x${pd.height}`);
          recordResult({
            id: `up-label-${pd.qty}`,
            site: 'UPrinting',
            product_type: 'roll_labels',
            w: parseFloat(pd.width),
            h: parseFloat(pd.height),
            qty: pd.qty,
            total_price: parseFloat(pd.price),
            unit_price: parseFloat(pd.unit_price),
            turnaround_days: pd.turnaround,
            status: 'live',
            confidence: 'high',
            method: 'Angular scope click'
          });
        }
      } else {
        log(`UP Labels qty ${qty}: ${JSON.stringify(result)}`);
      }
    }

  } catch (e) {
    ERRORS.push({ site: 'UPrinting-labels', error: String(e) });
    log(`UP Labels error: ${e}`);
  } finally {
    await context.close();
  }
}

// ─── GotPrint — Discover Packaging URLs ─────────────────────────────────────
async function captureGotPrintCatalog(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    log('GP Catalog: loading GotPrint products page...');
    await page.goto('https://www.gotprint.com/products/info.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const allLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="products"]'));
      return links.map(a => ({
        text: a.textContent.trim(),
        href: a.href
      })).filter(l => l.text.length > 0);
    });
    log(`GP Catalog: all product links: ${JSON.stringify(allLinks).slice(0, 3000)}`);

    // Filter for packaging/carton/box/pouch related
    const packagingLinks = allLinks.filter(l =>
      /box|carton|pouch|packaging|folding|container/i.test(l.text + l.href)
    );
    log(`GP Catalog: packaging links: ${JSON.stringify(packagingLinks)}`);

    recordResult({
      site: 'GotPrint',
      product_type: 'catalog_discovery',
      all_product_links: allLinks.slice(0, 50),
      packaging_links: packagingLinks,
      notes: 'Product catalog scraped for packaging URLs'
    });

  } catch (e) {
    ERRORS.push({ site: 'GotPrint-catalog', error: String(e) });
    log(`GP Catalog error: ${e}`);
  } finally {
    await context.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    log('=== NOV-9 Packaging Pass 2 ===');
    await captureUPLabelsMultiQty(browser);
    await captureUPBoxesFull(browser);
    await captureUPPouchesFull(browser);
    await captureGotPrintCatalog(browser);
  } finally {
    await browser.close();
  }

  const fs = require('fs');
  const outPath = `/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-packaging2-${new Date().toISOString().slice(0,10)}.json`;
  fs.writeFileSync(outPath, JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS, errors: ERRORS }, null, 2));
  log(`\n=== DONE. Saved to ${outPath} ===`);
  log(`${RESULTS.length} results, ${ERRORS.length} errors`);
  process.stdout.write('\n\n=== FINAL RESULTS ===\n' + JSON.stringify(RESULTS, null, 2) + '\n');
})();
