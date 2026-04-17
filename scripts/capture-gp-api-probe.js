#!/usr/bin/env node
/**
 * capture-gp-api-probe.js
 *
 * GotPrint REST API probe using confirmed data:
 *   - productType = 36 (roll labels) — from settings/product/specifications XHR
 *   - Paper IDs: 12=White BOPP, 13=Clear BOPP, 14=White Vinyl (Glossy)
 *   - Variant ID = 32 (Square-Rounded 3"x3") — from /products/options/quantities XHR
 *   - Available qtys include 5000
 *
 * Also: configure form via JS dispatch (works), then probe all pricing endpoints.
 * Also: watch for any /price* XHR after full form configuration.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT   = path.resolve(__dirname, '..');
const RAW    = path.join(ROOT, 'data', 'competitor-pricing-raw.json');
const NORM   = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const SS_DIR = path.join(ROOT, 'data', 'screenshots');

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const log  = m => console.log(`[gpa] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ss(page, n) { try { await page.screenshot({ path: path.join(SS_DIR, `${n}-${Date.now()}.png`) }); } catch (_) {} }

async function main() {
  const raw  = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));
  const today = new Date().toISOString().split('T')[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const allXhr = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com') || resp.status() >= 400) return;
    try {
      const body = await resp.text();
      allXhr.push({ url: u, status: resp.status(), body });
    } catch (_) {}
  });

  const result = {
    specData: null,
    variantId: '32',  // known from previous run
    quantities: [],
    price5000: null,
    unit5000: null,
    configPrice: null,
    notes: []
  };

  const page = await context.newPage();

  try {
    log('Loading /products/roll-labels/order ...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await wait(6000);
    await ss(page, 'gpa-01-loaded');
    log(`URL: ${page.url()}`);

    if (page.url().includes('home.html')) { log('BLOCKED'); return; }

    // ── Capture specs XHR ──
    for (const xhr of allXhr) {
      if (xhr.url.includes('specifications')) {
        log(`SPEC XHR: ${xhr.url.split('?')[1]} → ${xhr.body.slice(0, 800)}`);
        try { result.specData = JSON.parse(xhr.body); } catch (_) {}
      }
    }

    // ── Configure form via JS dispatch (proven to work) ──
    log('\nConfiguring form via JS dispatch...');

    async function jsSelectOption(selectName, optionLabel) {
      return page.evaluate(({ name, label }) => {
        const sel = document.querySelector(`select[name="${name}"]`);
        if (!sel) return `select[name="${name}"] not found`;
        const opt = [...sel.options].find(o => o.text.trim() === label);
        if (!opt) return `option "${label}" not found in ${name}. Available: ${[...sel.options].map(o => o.text.trim()).join(', ')}`;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        // Also trigger Vue.js-specific events
        sel.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return `OK: selected "${opt.text.trim()}" (value=${opt.value}) in select[${name}]`;
      }, { name: selectName, label: optionLabel });
    }

    // Step 1: Shape
    const r1 = await jsSelectOption('shape', 'Square - Rounded');
    log(`Shape: ${r1}`);
    await wait(3000);

    // Step 2: Size
    const r2 = await jsSelectOption('size', '3" x 3"');
    log(`Size: ${r2}`);
    await wait(3000);

    // Read updated variant ID
    for (const xhr of allXhr.slice().reverse()) {
      if (xhr.url.includes('options/quantities')) {
        log(`Quantities XHR: ${xhr.body.slice(0, 400)}`);
        try {
          const d = JSON.parse(xhr.body);
          for (const [vid, qlist] of Object.entries(d)) {
            result.variantId = vid;
            result.quantities = qlist.map(q => q.quantity);
            log(`Variant ID: ${vid}, qtys: ${result.quantities.join(', ')}`);
          }
        } catch (_) {}
        break;
      }
    }

    // Step 3: Paper (may need special trigger)
    const paperDisabled = await page.$eval('select[name="paper"]', s => s.disabled).catch(() => true);
    log(`Paper disabled: ${paperDisabled}`);

    if (!paperDisabled) {
      const r3 = await jsSelectOption('paper', 'White BOPP Label');
      log(`Paper: ${r3}`);
      await wait(3000);
    } else {
      // Try to manually enable and select via JS
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="paper"]');
        if (sel) {
          sel.disabled = false;
          const opt = [...sel.options].find(o => /white.*bopp/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      await wait(2000);
      const paperVal = await page.$eval('select[name="paper"]', s => s.options[s.selectedIndex]?.text || null).catch(() => null);
      log(`Paper (after force-enable): ${paperVal}`);
    }

    // Step 4: Finish (may need special trigger)
    const finishDisabled = await page.$eval('select[name="finish"]', s => s.disabled).catch(() => true);
    log(`Finish disabled: ${finishDisabled}`);

    if (!finishDisabled) {
      const r4 = await jsSelectOption('finish', 'Matte Finish (Indoor)');
      log(`Finish: ${r4}`);
      await wait(3000);
    } else {
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="finish"]');
        if (sel) {
          sel.disabled = false;
          const opt = [...sel.options].find(o => /matte/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      await wait(2000);
    }

    // Step 5: Color
    await page.evaluate(() => {
      const sel = document.querySelector('select[name="color"]');
      if (sel) {
        sel.disabled = false;
        const opt = [...sel.options].find(o => o.text !== 'Please select an option');
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await wait(3000);

    await ss(page, 'gpa-02-configured');

    // ── Read subtotal ──
    const subtotalText = await page.evaluate(() => {
      const cp = document.querySelector('.cart-price');
      if (cp) return cp.textContent.trim();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (/^\$[\d,]+\.\d{2}$/.test(t) && parseFloat(t.replace(/[$,]/g, '')) > 0) return t;
      }
      return null;
    });
    log(`Subtotal: ${subtotalText}`);
    if (subtotalText) {
      const m = subtotalText.match(/\$([\d,]+\.\d{2})/);
      if (m) result.configPrice = parseFloat(m[1].replace(/,/g, ''));
    }

    // ── Check all XHR calls after form configuration ──
    log(`\nAll GP XHR calls (${allXhr.filter(x => x.url.includes('/v1/')).length} v1 calls):`);
    for (const xhr of allXhr.filter(x => x.url.includes('/v1/'))) {
      const ep = xhr.url.split('/v1/')[1]?.split('?')[0];
      log(`  /v1/${ep} → ${xhr.body.slice(0, 300)}`);
    }

    // ── REST API probe with cookies + known IDs ──
    log('\nProbing REST API for pricing...');
    const cookies = await context.cookies();
    const cookieHdr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // From spec data: productType=36, paper ID 12 = White BOPP Label
    // Variant ID 32 for Square-Rounded 3"x3"

    const probeUrls = [
      // Variant-based pricing
      `https://www.gotprint.com/service/rest/v1/products/options/prices?variantId=${result.variantId}&qty=5000`,
      `https://www.gotprint.com/service/rest/v1/products/options/prices?productVariantId=${result.variantId}&quantity=5000`,
      `https://www.gotprint.com/service/rest/v1/products/options/prices/${result.variantId}?qty=5000&quantity=5000`,
      // Product type + specs pricing
      `https://www.gotprint.com/service/rest/v1/products/price-table?productType=36&qty=5000`,
      `https://www.gotprint.com/service/rest/v1/products/pricing?productType=36&qty=5000&paper=12&finish=matte`,
      // Generic price lookup
      `https://www.gotprint.com/service/rest/v1/pricing/products/36/price?qty=5000&variantId=${result.variantId}`,
      `https://www.gotprint.com/service/rest/v1/products/36/pricing?qty=5000`,
      `https://www.gotprint.com/service/rest/v1/products/36/price-table?qty=5000`,
      // Cart-based approach: add to cart, read price
      `https://www.gotprint.com/service/rest/v1/users/self/cart`,
    ];

    for (const url of probeUrls) {
      try {
        const r = await context.request.get(url, {
          headers: { Cookie: cookieHdr, Accept: 'application/json' },
          timeout: 10000
        });
        const ep = url.split('/v1/')[1]?.slice(0, 60);
        log(`  GET /v1/${ep}: ${r.status()}`);
        if (r.status() < 400) {
          const body = await r.text();
          log(`  body: ${body.slice(0, 600)}`);

          // Try to extract price
          try {
            const d = JSON.parse(body);
            const scan = (obj, path = '') => {
              if (typeof obj === 'number' && obj > 5 && obj < 50000) {
                if (/price|total|amount|subtotal|cost/i.test(path)) {
                  log(`  ** price at ${path}: $${obj}`);
                  if (!result.price5000) result.price5000 = obj;
                }
              }
              if (typeof obj === 'object' && obj !== null) {
                Object.keys(obj).forEach(k => scan(obj[k], `${path}.${k}`));
              }
            };
            scan(d);
          } catch (_) {}
        }
      } catch (_) {}
    }

    // POST to cart (add item, read price)
    log('\nTrying cart-based price: POST to /users/self/cart...');
    try {
      const cartBody = {
        productVariantId: parseInt(result.variantId),
        quantity: 5000,
        turnaroundId: 1,
        sides: 1
      };
      const r = await context.request.post('https://www.gotprint.com/service/rest/v1/users/self/cart', {
        data: JSON.stringify(cartBody),
        headers: { Cookie: cookieHdr, Accept: 'application/json', 'Content-Type': 'application/json' },
        timeout: 15000
      });
      log(`Cart POST: ${r.status()}`);
      if (r.status() < 400) {
        const body = await r.text();
        log(`Cart response: ${body.slice(0, 800)}`);
        // Read cart to get price
        const cartResp = await context.request.get('https://www.gotprint.com/service/rest/v1/users/self/cart?includeTotal=true&requestValues=true&includeCount=false&type=1', {
          headers: { Cookie: cookieHdr, Accept: 'application/json' }
        });
        const cartBody2 = await cartResp.text();
        log(`Cart GET after add: ${cartBody2.slice(0, 800)}`);
        try {
          const d = JSON.parse(cartBody2);
          const totalPrice = d.totalPrice?.[0]?.price;
          if (totalPrice && parseFloat(totalPrice) > 0) {
            result.price5000 = parseFloat(totalPrice);
            log(`*** CART PRICE: $${result.price5000} ***`);
          }
        } catch (_) {}
      }
    } catch (e) { log(`Cart POST failed: ${e.message}`); }

    // ── Print all spec data ──
    if (result.specData) {
      log('\nFull spec data from API:');
      log(JSON.stringify(result.specData, null, 2).slice(0, 2000));
    }

  } catch (e) {
    err(`${e.message}`);
  } finally {
    // ── Final summary ──
    console.log('\n════════════════════════════════════════');
    console.log(' GOTPRINT API PROBE RESULT');
    console.log('════════════════════════════════════════');
    console.log(`Variant ID: ${result.variantId}`);
    console.log(`Available qtys: ${result.quantities.join(', ')}`);
    console.log(`Has qty 5000: ${result.quantities.includes(5000)}`);
    console.log(`Config subtotal: ${result.configPrice ? '$' + result.configPrice : 'N/A'}`);
    console.log(`API price 5000: ${result.price5000 ? '$' + result.price5000 : 'NOT CAPTURED'}`);
    console.log(`Notes: ${result.notes.join('; ')}`);
    console.log('════════════════════════════════════════\n');

    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
