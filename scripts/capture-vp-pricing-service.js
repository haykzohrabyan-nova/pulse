#!/usr/bin/env node
/**
 * capture-vp-pricing-service.js
 *
 * Hit the Vistaprint pricing service API directly for 5000 qty.
 * Also access UPrinting's Angular priceData scope for full qty table.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.resolve(__dirname, '..');

function log(msg) { console.log(`[vp-ps] ${msg}`); }
function err(msg) { console.error(`[ERR]   ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = {};

  try {
    // ─── VISTAPRINT PRICING SERVICE API ────────────────────────────────────────
    // We saw the API call pattern for qty=50 and qty=1000.
    // The pricingContext is a base64 encoded JSON that appears to be static for anonymous users.
    // Decoded: {"version":0,"merchantId":"VISTAPRINT","market":"US","customerGroups":["anonymous_users",...]}
    // Try calling it directly without a browser session first.
    log('=== VISTAPRINT Pricing Service API ===');

    const vpContext = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const vpApiCaptures = [];
    vpContext.on('response', async resp => {
      const u = resp.url();
      if (u.includes('website-pricing-service') || u.includes('prices.cimpress.io')) {
        try {
          const body = await resp.text();
          vpApiCaptures.push({ url: u, status: resp.status(), body }); // No slice - full body
        } catch(_) {}
      }
    });

    const vpPage = await vpContext.newPage();

    try {
      await vpPage.goto('https://www.vistaprint.com/labels-stickers/roll-labels', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(8000);

      // Extract the pricingContext token from intercepted calls
      const pricingContext = await vpPage.evaluate(() => {
        // Look for the pricingContext in the page or window state
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        for (const s of scripts) {
          if (s.textContent.includes('pricingContext')) {
            const m = s.textContent.match(/pricingContext['":\s]+([A-Za-z0-9+/=]{20,})/);
            if (m) return m[1];
          }
        }
        // Also check window
        if (window.__pricingContext) return window.__pricingContext;
        return null;
      });

      log(`VP: pricingContext from page: ${pricingContext ? pricingContext.slice(0, 50) + '...' : 'not found'}`);

      // Get full body from the captured API calls (no size limit this time)
      log(`VP: ${vpApiCaptures.length} pricing API responses`);

      for (const cap of vpApiCaptures) {
        log(`VP pricing service: ${cap.url.split('?')[0].split('/').slice(-3).join('/')}`);
        log(`  status=${cap.status}, body length=${cap.body.length}`);

        try {
          const data = JSON.parse(cap.body);
          log('  data keys: ' + Object.keys(data).join(', '));

          if (data.estimatedPrices) {
            log('  estimated prices for quantities:');
            const prices = data.estimatedPrices;
            Object.entries(prices).forEach(([qty, priceData]) => {
              const total = priceData.totalListPrice?.untaxed || priceData.totalListPrice;
              const unit = priceData.unitListPrice?.untaxed || priceData.unitListPrice;
              log(`    qty ${qty}: $${total} ($${unit}/each)`);
            });
            results.vistaprintPrices = prices;
          }
        } catch(e) {
          log('  parse error: ' + e.message);
          log('  raw: ' + cap.body.slice(0, 500));
        }
      }

      // Now call the pricing service directly for specific quantities including 5000
      // Use the pricingContext token from what we captured (it appears in URLs)
      const capturedPricingContext = vpApiCaptures.find(c => c.url.includes('pricingContext='))?.url.match(/pricingContext=([^&]+)/)?.[1];

      if (capturedPricingContext) {
        log('VP: using pricingContext from captured URL');
        const decodedPC = decodeURIComponent(capturedPricingContext);

        const quantities = [500, 1000, 2500, 5000, 10000];
        for (const qty of quantities) {
          const url = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?` +
            `requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=${qty}&` +
            `pricingContext=${encodeURIComponent(decodedPC)}&merchantId=vistaprint&` +
            `selections%5BRoll%20Finishing%20Type%5D=Slit%20Roll&market=US&optionalPriceComponents=UnitPrice`;

          const priceResult = await vpPage.evaluate(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
              return { status: r.status, body: await r.text() };
            } catch(e) { return { error: e.message }; }
          }, url);

          if (priceResult.status === 200) {
            try {
              const priceData = JSON.parse(priceResult.body);
              const ep = priceData.estimatedPrices?.[qty.toString()];
              if (ep) {
                const total = ep.totalListPrice?.untaxed || ep.totalListPrice;
                const unit = ep.unitListPrice?.untaxed || ep.unitListPrice;
                log(`VP: qty ${qty} = $${total} ($${unit}/each)`);
                if (!results.vistaprintPrices) results.vistaprintPrices = {};
                results.vistaprintPrices[qty] = { total, unit };
              }
            } catch(e) { log(`VP qty ${qty} parse: ${e.message}`); }
          } else {
            log(`VP qty ${qty}: ${priceResult.status || priceResult.error}`);
          }
        }
      }

    } finally {
      await vpContext.close();
    }

    // ─── UPRINTING Angular priceData ──────────────────────────────────────────
    log('');
    log('=== UPRINTING — Angular priceData extraction ===');

    const upContext = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const upPage = await upContext.newPage();

    try {
      await upPage.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 40000 });
      await sleep(7000);

      // Access the Angular scope's priceData
      const angularPriceData = await upPage.evaluate(() => {
        try {
          const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc"]');
          if (!calcEl) return { error: 'no calc element' };

          const scope = angular?.element(calcEl)?.scope?.();
          if (!scope) return { error: 'no angular scope' };

          const scopeKeys = Object.keys(scope).filter(k => !k.startsWith('$'));

          // Get priceData
          const priceData = scope.priceData;
          if (priceData) {
            return {
              found: true,
              priceDataType: typeof priceData,
              priceDataKeys: typeof priceData === 'object' ? Object.keys(priceData) : null,
              priceDataSample: JSON.stringify(priceData).slice(0, 5000)
            };
          }

          // Try other useful scope properties
          const selectedSpecs = scope.selectedSpecs;
          const products = scope.products_template_data;

          return {
            found: false,
            scopeKeys,
            selectedSpecs: JSON.stringify(selectedSpecs || {}).slice(0, 500),
            products: JSON.stringify(products || {}).slice(0, 500)
          };
        } catch(e) {
          return { error: e.message };
        }
      });

      log('UP Angular priceData: ' + JSON.stringify(angularPriceData).slice(0, 1000));

      if (angularPriceData.priceDataSample) {
        // Try to find 5000 qty pricing in the priceData
        const pd = angularPriceData.priceDataSample;
        const match5k = pd.match(/"(?:quantity|qty)":\s*"?5000"?[^}]*"(?:price|total|amount)":\s*"?(\d+\.?\d*)"?/);
        if (match5k) {
          log('UP: 5000-qty price found in priceData: $' + match5k[1]);
          results.uprintingPrice5000 = parseFloat(match5k[1]);
        }

        // Extract all quantity/price pairs
        const qtyPricePairs = [];
        const re = /"(?:quantity|qty)":\s*"?(\d+)"?[^}]*"price":\s*"?(\d+\.?\d*)"?/g;
        let m;
        while ((m = re.exec(pd)) !== null) {
          qtyPricePairs.push({ qty: parseInt(m[1]), price: parseFloat(m[2]) });
        }
        if (qtyPricePairs.length > 0) {
          log('UP: qty/price pairs: ' + JSON.stringify(qtyPricePairs));
          results.uprintingQtyPrices = qtyPricePairs;
        }
      }

      // Also try triggering price update with JavaScript
      const priceUpdate5k = await upPage.evaluate(() => {
        try {
          const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc"]');
          if (!calcEl) return { error: 'no calc' };

          const scope = angular?.element(calcEl)?.scope?.();
          if (!scope) return { error: 'no scope' };

          // Try to update the quantity and trigger price recalculation
          const qtyEl = document.getElementById('quantity') || document.querySelector('[id*="qty"]');
          if (qtyEl) {
            qtyEl.value = '5000';
            angular.element(qtyEl).triggerHandler('change');
            scope.$apply();
            return { triggered: true, qtyEl: qtyEl.id };
          }

          // Try through scope directly
          if (scope.config && scope.config.quantity !== undefined) {
            scope.config.quantity = 5000;
            scope.$apply();
            return { triggeredViaScope: true };
          }

          return { error: 'could not trigger', configKeys: Object.keys(scope.config || {}).slice(0, 10) };
        } catch(e) { return { error: e.message }; }
      });

      log('UP 5000 qty trigger: ' + JSON.stringify(priceUpdate5k));
      await sleep(4000);

      // Read updated price
      const updatedPrice = await upPage.evaluate(() => {
        const calcPriceEl = document.getElementById('calc-price') ||
                            document.querySelector('[id*="price"]');
        const allText = document.body.innerText;
        const matches = allText.match(/Printing Cost:\s*\$?([\d,]+\.?\d{0,2})/g);
        return {
          calcPrice: calcPriceEl?.textContent?.trim(),
          allPrintingCosts: matches?.map(m => m.replace('Printing Cost:', '').trim()),
          currentQty: document.getElementById('quantity')?.value
        };
      });
      log('UP updated price state: ' + JSON.stringify(updatedPrice));

      // Also try to access the price calculation API used by UPrinting
      const upAPIResult = await upPage.evaluate(async () => {
        // Try the UPrinting pricing calculation endpoint
        // From the network calls we saw: checkout-api.uprinting.com/product-valid-auto-apply-coupon/33
        // The pricing calc is likely through a different endpoint
        const apis = [
          '/muffins/_log.php?action=price&product_id=33&qty=5000',
          '/api/prices?product_id=33&qty=5000',
        ];

        const results = [];
        for (const api of apis) {
          try {
            const r = await fetch(api, { credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } });
            results.push({ api, status: r.status, body: (await r.text()).slice(0, 200) });
          } catch(e) { results.push({ api, error: e.message }); }
        }
        return results;
      });
      log('UP API tests: ' + JSON.stringify(upAPIResult));

      // Re-read the calc-price element after all interactions
      const finalState = await upPage.evaluate(() => {
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const text = document.body.innerText;
        const prices = [];
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 10 && v <= 50000) prices.push(v);
        }
        return {
          prices: [...new Set(prices)],
          printingCost: document.querySelector('[id*="price"], [class*="price"]')?.textContent?.trim()?.slice(0, 100)
        };
      });
      log('UP final state: ' + JSON.stringify(finalState));
      if (finalState.prices.length > 0) results.uprintingCurrentPrices = finalState.prices;

    } finally {
      await upContext.close();
    }

  } finally {
    await browser.close();
  }

  // Save results
  const logFile = path.join(ROOT_DIR, 'data', `capture-vp-ps-${nowISO()}.json`);
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));
  log('Log: ' + logFile);

  log('');
  log('=== FINAL RESULTS ===');
  log('Vistaprint prices: ' + JSON.stringify(results.vistaprintPrices || {}));
  log('UPrinting 5000 price: ' + (results.uprintingPrice5000 || 'not captured'));
  log('UPrinting qty prices: ' + JSON.stringify(results.uprintingQtyPrices || []));
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
