#!/usr/bin/env node
/**
 * capture-targeted-pass2.js
 *
 * Follow-up targeted pass based on discoveries from browser-click pass:
 *
 * VISTAPRINT:
 *   - Click "Custom (Die-Cut)" shape — this is the shape that shows actual W×H inputs
 *   - Fill width=3, height=3
 *   - Capture new Cimpress API call with custom dimensions
 *   - Also try clicking Rounded Square and checking if there's a preset 3"×3" size option
 *
 * GOTPRINT:
 *   - X-API-Key: bb601953-a518-4817-b64a-993a4af65c84 returns 200 on /service/rest/v1/products
 *   - Enumerate product IDs from /products response
 *   - Find roll labels product
 *   - Call /service/rest/v1/products/{id}/pricing (or similar) with qty=5000
 *   - Also: navigate to the correct configurator URL (the old URL redirects to home.html)
 *
 * STICKER MULE:
 *   - SM uses GraphQL at /bridge/backend/graphql, /core/graphql, /notify/graphql
 *   - Navigate to custom-labels, dismiss cookie, capture ALL GraphQL request bodies
 *   - Inspect what queries/mutations the configurator uses
 *   - Try to call pricing query directly with variables: product=custom-labels, width=3, height=3, qty=5000
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR     = path.resolve(__dirname, '..');
const RAW_FILE     = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE    = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');
const SCREENS_DIR  = path.join(ROOT_DIR, 'data', 'screenshots');

if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });

function log(msg)  { console.log(`[t2] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function screenshot(page, label) {
  const file = path.join(SCREENS_DIR, `${label}-${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); log(`  ss → ${path.basename(file)}`); }
  catch (_) {}
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

// ══════════════════════════════════════════════════════════════════════════════
// VISTAPRINT: Custom (Die-Cut) shape → W=3 H=3 → capture Cimpress price
// ══════════════════════════════════════════════════════════════════════════════
async function captureVP(browser) {
  log('\n── VISTAPRINT: Custom Die-Cut click-through ──');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCalls = [];
  const allIntercepted = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') && u.includes('/prices/')) {
      try {
        const body = await resp.text();
        const params = {};
        try { new URL(u).searchParams.forEach((v, k) => { params[k] = v; }); } catch (_) {}
        cimpressCalls.push({ url: u, body, params });
        const sels = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('selections[') || k === 'quantities'));
        log(`VP intercept: ${JSON.stringify(sels)}`);
        try {
          const d = JSON.parse(body);
          const qtys = d.estimatedPrices ? Object.keys(d.estimatedPrices) : [];
          for (const q of qtys) {
            const ep = d.estimatedPrices[q];
            log(`  qty=${q}: total=$${ep.totalListPrice?.untaxed} unit=$${ep.unitListPrice?.untaxed}`);
          }
        } catch (_) {}
      } catch (_) {}
    }
  });

  const result = { price5000: null, unit5000: null, shapeClicked: null, widthFilled: null, heightFilled: null, sizeNote: null, method: null, allPrices: {} };

  const page = await context.newPage();
  try {
    log('VP: loading roll labels page...');
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(5000);
    await screenshot(page, 'vp2-01-loaded');

    // Log all label texts
    const labelTexts = await page.$$eval('label', els => els.map(e => e.textContent.trim()).filter(t => t.length < 80));
    log(`VP: labels on page: ${labelTexts.slice(0, 20).join(' | ')}`);

    // ── Step 1: Try to click "Rounded Square" and check for preset sizes ──
    log('VP: Step 1 — click Rounded Square, check for size dropdown...');
    const labels = await page.$$('label');
    for (const label of labels) {
      const t = await label.textContent();
      if (t?.trim() === 'Rounded Square') {
        await label.click({ force: true });
        result.shapeClicked = 'Rounded Square';
        log('VP: clicked Rounded Square');
        await sleep(3000);
        await screenshot(page, 'vp2-02-rounded-sq');
        break;
      }
    }

    // Look for any size selector that appeared (preset sizes)
    const sizeSelects = await page.$$('select');
    for (const sel of sizeSelects) {
      try {
        const visible = await sel.isVisible();
        if (!visible) continue;
        const options = await sel.$$eval('option', opts => opts.map(o => o.textContent.trim()));
        if (options.some(o => /\d+.*x.*\d+|inch|"/.test(o))) {
          log(`VP: size dropdown found: ${options.slice(0, 10).join(', ')}`);
          // Look for 3x3
          const opt3x3 = options.find(o => o.includes('3') && o.includes('3'));
          if (opt3x3) {
            await sel.selectOption({ label: opt3x3 });
            log(`VP: selected size preset "${opt3x3}"`);
            result.widthFilled = 3; result.heightFilled = 3;
            result.sizeNote = `Selected preset: ${opt3x3}`;
            await sleep(3000);
            await screenshot(page, 'vp2-03-size-preset');
          }
        }
      } catch (_) {}
    }

    // Also check for any radio buttons with size values
    const sizeRadios = await page.$$('input[type="radio"]');
    log(`VP: ${sizeRadios.length} radio buttons`);
    for (const r of sizeRadios) {
      const val = await r.getAttribute('value') || '';
      const id  = await r.getAttribute('id')    || '';
      if (/3.*x.*3|3".*3"|size/i.test(val) || /3.*x.*3|3".*3"|size/i.test(id)) {
        log(`VP: found potential 3x3 radio: val="${val}" id="${id}"`);
      }
    }

    // ── Step 2: Click "Custom (Die-Cut)" shape ──
    log('VP: Step 2 — click Custom (Die-Cut)...');
    const customTargets = ['Custom (Die-Cut)', 'Custom Die-Cut', 'Custom', 'Die Cut', 'Die-Cut'];
    for (const target of customTargets) {
      for (const label of await page.$$('label')) {
        const t = (await label.textContent() || '').trim();
        if (t === target || t.startsWith(target)) {
          await label.click({ force: true });
          result.shapeClicked = target;
          log(`VP: clicked shape "${target}"`);
          await sleep(4000);
          await screenshot(page, `vp2-04-custom-shape`);
          break;
        }
      }
      if (result.shapeClicked === target) break;
    }

    // ── Step 3: After clicking Custom, find width/height inputs ──
    await sleep(2000);
    const allInputs = await page.$$('input');
    const visibleNumInputs = [];
    for (const inp of allInputs) {
      const type = await inp.getAttribute('type') || '';
      const placeholder = await inp.getAttribute('placeholder') || '';
      const label = await inp.getAttribute('aria-label') || '';
      const name  = await inp.getAttribute('name') || '';
      const id    = await inp.getAttribute('id') || '';
      const visible = await inp.isVisible().catch(() => false);
      if (visible && (type === 'number' || type === 'text' || /width|height|size|dim/i.test(placeholder + label + name + id))) {
        const val = await inp.inputValue().catch(() => '');
        visibleNumInputs.push({ type, placeholder, label, name, id, val, el: inp });
        log(`VP: visible input: type=${type} placeholder="${placeholder}" label="${label}" name="${name}" id="${id}" val="${val}"`);
      }
    }
    log(`VP: ${visibleNumInputs.length} visible inputs after custom shape click`);

    if (visibleNumInputs.length >= 2) {
      // Fill width
      const wInp = visibleNumInputs.find(i => /width|w$/i.test(i.placeholder + i.label + i.name + i.id)) || visibleNumInputs[0];
      const hInp = visibleNumInputs.find(i => /height|h$/i.test(i.placeholder + i.label + i.name + i.id)) || visibleNumInputs[1];

      try {
        await wInp.el.click();
        await wInp.el.selectAll?.();
        await page.keyboard.press('Control+a');
        await wInp.el.fill('3');
        result.widthFilled = 3;
        log(`VP: filled width input (placeholder="${wInp.placeholder}") = 3`);
        await sleep(500);
      } catch (e) { log(`VP: width fill error: ${e.message}`); }

      try {
        await hInp.el.click();
        await page.keyboard.press('Control+a');
        await hInp.el.fill('3');
        result.heightFilled = 3;
        log(`VP: filled height input (placeholder="${hInp.placeholder}") = 3`);
        await sleep(500);
      } catch (e) { log(`VP: height fill error: ${e.message}`); }

      await page.keyboard.press('Tab');
      await sleep(4000);
      await screenshot(page, 'vp2-05-dims-filled');
    } else if (visibleNumInputs.length === 1) {
      try {
        await visibleNumInputs[0].el.click();
        await visibleNumInputs[0].el.fill('3');
        log('VP: filled single dimension input = 3');
        result.widthFilled = result.heightFilled = 3;
        await page.keyboard.press('Tab');
        await sleep(3000);
      } catch (_) {}
    }

    // ── Step 4: Look for qty selector / price display ──
    await sleep(2000);

    // Find 5000 qty in any selector or button
    let qtySet = false;
    const allBtns = await page.$$('button, [role="button"]');
    for (const btn of allBtns) {
      try {
        const t = (await btn.textContent() || '').trim();
        if (t === '5,000' || t === '5000') {
          await btn.click({ force: true });
          log(`VP: clicked qty "5,000" button`);
          qtySet = true;
          await sleep(3000);
          break;
        }
      } catch (_) {}
    }

    if (!qtySet) {
      for (const sel of await page.$$('select')) {
        try {
          const visible = await sel.isVisible();
          if (!visible) continue;
          const opts = await sel.$$eval('option', o => o.map(x => ({ v: x.value, t: x.textContent.trim() })));
          const q5k  = opts.find(o => o.t.includes('5000') || o.t.includes('5,000') || o.v === '5000');
          if (q5k) {
            await sel.selectOption({ value: q5k.v });
            log(`VP: selected qty "5,000" from select`);
            qtySet = true;
            await sleep(3000);
            break;
          }
        } catch (_) {}
      }
    }

    // ── Step 5: Read intercepted Cimpress calls ──
    await sleep(3000);
    await screenshot(page, 'vp2-06-final');

    log(`VP: ${cimpressCalls.length} Cimpress calls total`);
    for (const c of cimpressCalls) {
      try {
        const d = JSON.parse(c.body);
        const qtys = Object.keys(d.estimatedPrices || {});
        for (const q of qtys) result.allPrices[q] = d.estimatedPrices[q]?.totalListPrice?.untaxed;
      } catch (_) {}
    }
    log(`VP: all captured prices: ${JSON.stringify(result.allPrices)}`);

    if (result.allPrices['5000']) {
      result.price5000 = result.allPrices['5000'];
      result.unit5000  = parseFloat((result.price5000 / 5000).toFixed(4));
      result.method = 'intercepted_cimpress_after_custom_shape';
    }

    // ── Step 6: Make Cimpress API call with proper custom selections ──
    const lastCall = cimpressCalls.slice().reverse()[0];
    if (lastCall) {
      const p = lastCall.params;
      log(`VP: last call params: ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => k.includes('selection') || k.includes('product') || k.includes('pricing'))))}`);

      if (p.pricingContext) {
        // Custom shape dimensions go into selections[Width] and selections[Height] (in inches)
        const selectionEntries = Object.entries(p)
          .filter(([k]) => k.startsWith('selections['))
          .reduce((a, [k, v]) => { a[k] = v; return a; }, {});

        // Add or override width/height
        if (result.shapeClicked && /custom|die.cut/i.test(result.shapeClicked)) {
          selectionEntries['selections[Width]'] = '3';
          selectionEntries['selections[Height]'] = '3';
        }

        const qs = new URLSearchParams({
          requestor: 'inspector-gadget-pdp-configurator-fragment',
          productKey: p.productKey || 'PRD-DF5PWTHC',
          quantities: '5000',
          pricingContext: p.pricingContext,
          merchantId: p.merchantId || 'vistaprint',
          market: 'US',
          optionalPriceComponents: 'UnitPrice',
          ...selectionEntries
        });

        const apiUrl = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?${qs}`;
        log(`VP: direct Cimpress call (${Object.keys(selectionEntries).length} selections)...`);
        try {
          const r = await context.request.get(apiUrl, { headers: { Accept: 'application/json' }, timeout: 12000 });
          const body = await r.text();
          log(`VP Cimpress direct: status=${r.status()} body=${body.slice(0, 600)}`);
          const d = JSON.parse(body);
          if (d.estimatedPrices?.['5000']) {
            const ep = d.estimatedPrices['5000'];
            result.price5000 = ep.totalListPrice?.untaxed;
            result.unit5000  = ep.unitListPrice?.untaxed;
            result.method = 'cimpress_api_direct_with_custom_shape';
            log(`VP: *** PRICE: $${result.price5000} for 5000 qty ***`);
          }
        } catch (e) { log(`VP Cimpress direct call failed: ${e.message}`); }
      }
    }

  } catch (e) { err(`VP: ${e.message}`); }
  finally { await page.close(); await context.close(); }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// GOTPRINT: X-API-Key confirmed. Navigate to actual configurator, capture pricing.
// Strategy:
//   1. Find correct roll-labels product URL (try known patterns + follow nav links)
//   2. Use REST API with X-API-Key to enumerate products + get price table
//   3. Interact with actual configurator to get DOM price
// ══════════════════════════════════════════════════════════════════════════════
async function captureGP(browser) {
  log('\n── GOTPRINT: API + configurator targeted pass ──');

  const GP_API = 'https://www.gotprint.com/service/rest/v1';
  const API_KEY = 'bb601953-a518-4817-b64a-993a4af65c84';
  const API_HEADERS = { 'X-API-Key': API_KEY, 'Accept': 'application/json' };

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const priceApiCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com/service/rest/v1') && resp.status() < 400) {
      try {
        const body = await resp.text();
        priceApiCalls.push({ url: u, status: resp.status(), body: body.slice(0, 2000) });
        if (/price|total|amount|quote/i.test(u) || /price|total|amount/i.test(body.slice(0, 200))) {
          log(`GP API: ${u.slice(u.indexOf('/v1/') + 4, u.indexOf('/v1/') + 50)} → ${body.slice(0, 200)}`);
        }
      } catch (_) {}
    }
  });

  const result = { price5000: null, unit5000: null, productId: null, priceTable: null, configuratorUrl: null, method: null, notes: [] };

  const page = await context.newPage();
  try {
    // ── Step 1: REST API — enumerate products ──
    log('GP: enumerating products via X-API-Key...');
    const productsResp = await context.request.get(`${GP_API}/products`, { headers: API_HEADERS, timeout: 15000 });
    log(`GP /products: status=${productsResp.status()}`);
    const productsBody = await productsResp.text();
    log(`GP /products body (500 chars): ${productsBody.slice(0, 500)}`);

    let productIds = [];
    try {
      const d = JSON.parse(productsBody);
      if (Array.isArray(d)) productIds = d.map(p => p.id || p.productId || p.Id);
      else if (d.items) productIds = d.items.map(p => p.id || p.productId);
      else if (d.products) productIds = d.products.map(p => p.id || p.productId);
      log(`GP: found ${productIds.length} product IDs: ${productIds.slice(0, 10).join(', ')}`);
    } catch (e) { log(`GP: could not parse products: ${e.message}`); }

    // ── Step 2: Try to find roll labels product by inspecting product details ──
    // Also try common product IDs for roll labels
    const rollLabelCandidates = [
      ...productIds.slice(0, 5),  // First 5 from enumeration
      1, 2, 3, 10, 50, 100, 200, 300, 500  // Common ID patterns
    ];

    for (const id of rollLabelCandidates.slice(0, 8)) {
      try {
        const r = await context.request.get(`${GP_API}/products/${id}`, { headers: API_HEADERS, timeout: 8000 });
        if (r.status() === 200) {
          const body = await r.text();
          if (/roll.*label|label.*roll/i.test(body)) {
            log(`GP: found roll labels at /products/${id}: ${body.slice(0, 200)}`);
            result.productId = id;
            break;
          }
        }
      } catch (_) {}
    }

    // ── Step 3: Try price-table API directly ──
    const priceEndpoints = [
      `/products/price`,
      `/price-table`,
      `/products/pricetable`,
      `/pricing`,
      `/quote`,
    ];
    for (const ep of priceEndpoints) {
      try {
        const r = await context.request.get(`${GP_API}${ep}`, { headers: API_HEADERS, timeout: 8000 });
        log(`GP ${ep}: status=${r.status()}`);
        if (r.status() === 200) {
          const body = await r.text();
          log(`  body: ${body.slice(0, 300)}`);
        } else if (r.status() === 405) {
          // Method Not Allowed — try POST
          const postR = await context.request.post(`${GP_API}${ep}`, {
            headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
            data: JSON.stringify({ productType: 'ROLL_LABEL', qty: 5000, width: 3, height: 3, material: 'WHITE_BOPP' }),
            timeout: 8000
          });
          log(`GP POST ${ep}: status=${postR.status()}`);
          if (postR.status() < 400) {
            const body = await postR.text();
            log(`  body: ${body.slice(0, 400)}`);
          }
        }
      } catch (_) {}
    }

    // ── Step 4: Navigate to GP homepage, find the actual roll labels URL ──
    log('GP: loading homepage to find configurator URL...');
    await page.goto('https://www.gotprint.com', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    // Find all links to roll labels
    const rollLinks = await page.$$eval('a[href]', links =>
      links
        .map(a => ({ href: a.href, text: a.textContent.trim() }))
        .filter(l => /roll.?label|label.*roll/i.test(l.href + l.text))
    );
    log(`GP: roll label links found: ${JSON.stringify(rollLinks.slice(0, 5))}`);

    // Navigate to first roll label link
    if (rollLinks.length > 0) {
      const targetUrl = rollLinks[0].href;
      result.configuratorUrl = targetUrl;
      log(`GP: navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(5000);
      await screenshot(page, 'gp2-01-configurator');
      log(`GP: configurator URL = ${page.url()}`);
      log(`GP: title = "${await page.title()}"`);
    }

    // ── Step 5: If on configurator page, click through options ──
    const currentUrl = page.url();
    if (!currentUrl.includes('home.html') && !currentUrl.includes('gotprint.com/g/')) {
      log('GP: on product configurator page — clicking through options...');

      // Find shape selectors (Vue.js or HTML radio)
      const shapeOptions = await page.$$('[class*="shape"], [class*="option"], input[type="radio"]');
      log(`GP: found ${shapeOptions.length} shape/option elements`);

      // Look for "Square" option and click it
      for (const el of shapeOptions) {
        try {
          const text = await el.textContent();
          if (/square/i.test(text || '')) {
            await el.click({ force: true });
            log('GP: clicked Square shape option');
            await sleep(2000);
            break;
          }
        } catch (_) {}
      }

      // Find size input fields
      await sleep(1000);
      const wInput = await page.$('input[name*="width" i], input[placeholder*="width" i]');
      const hInput = await page.$('input[name*="height" i], input[placeholder*="height" i]');
      if (wInput) { await wInput.fill('3'); log('GP: filled width=3'); await sleep(500); }
      if (hInput) { await hInput.fill('3'); log('GP: filled height=3'); await sleep(500); }
      if (wInput || hInput) { await page.keyboard.press('Tab'); await sleep(2000); }

      // Find qty field/select
      const qtyInput = await page.$('input[name*="qty" i], input[id*="qty" i]');
      const qtySelect = await page.$('select[name*="qty" i], select[id*="qty" i]');
      if (qtyInput) { await qtyInput.fill('5000'); await page.keyboard.press('Tab'); log('GP: filled qty=5000'); await sleep(2000); }
      if (qtySelect) {
        const opts = await qtySelect.$$eval('option', o => o.map(x => ({ v: x.value, t: x.textContent.trim() })));
        const q5k = opts.find(o => o.t.includes('5000') || o.v === '5000');
        if (q5k) { await qtySelect.selectOption({ value: q5k.v }); log('GP: selected qty 5000'); await sleep(2000); }
      }

      await screenshot(page, 'gp2-02-configured');
    }

    // ── Step 6: Check what the GP configurator looks like on the redirect page ──
    if (currentUrl.includes('home.html')) {
      log('GP: still on home.html — trying product search/catalog navigation...');

      // Try clicking on roll labels in the navigation
      const navLinks = await page.$$('a');
      for (const link of navLinks) {
        const href = await link.getAttribute('href') || '';
        const text = await link.textContent() || '';
        if (/roll.*label/i.test(text) && href.includes('gotprint.com')) {
          log(`GP: following roll label nav link: ${href}`);
          await page.goto(href, { waitUntil: 'networkidle', timeout: 25000 });
          await sleep(3000);
          await screenshot(page, 'gp2-03-nav-click');
          log(`GP: navigated to ${page.url()}`);
          result.configuratorUrl = page.url();
          break;
        }
      }
    }

    // ── Step 7: Try API endpoints discovered from page network calls ──
    log('GP: checking REST API endpoints with X-API-Key...');

    // Check settings to understand API structure
    const settingsResp = await context.request.get(`${GP_API}/settings`, { headers: API_HEADERS, timeout: 8000 });
    if (settingsResp.status() === 200) {
      const s = JSON.parse(await settingsResp.text());
      log(`GP settings: site=${s.subDomain}, country=${s.country}, phone=${s.phone}`);
    }

    // Try product search
    const searchEndpoints = [
      `/products?type=ROLL_LABEL`,
      `/products?category=labels`,
      `/products?name=roll+labels`,
      `/products?search=roll+label`,
      `/catalog/products?type=ROLL_LABEL`,
    ];
    for (const ep of searchEndpoints) {
      try {
        const r = await context.request.get(`${GP_API}${ep}`, { headers: API_HEADERS, timeout: 8000 });
        log(`GP ${ep}: status=${r.status()}`);
        if (r.status() === 200) {
          const body = await r.text();
          log(`  ${body.slice(0, 300)}`);
        }
      } catch (_) {}
    }

    // ── Step 8: Get the actual pricing page for roll labels ──
    // Try the GP URL pattern: /g/product-name.html or /store/category/product
    const gpUrlPatterns = [
      'https://www.gotprint.com/g/roll-labels.html',
      'https://www.gotprint.com/g/stickers-and-labels/roll-labels.html',
      'https://www.gotprint.com/store/stickers-and-labels/roll-labels/',
      'https://www.gotprint.com/products/roll-labels',
      'https://www.gotprint.com/roll-labels',
      'https://www.gotprint.com/stickers/roll-labels'
    ];
    for (const url of gpUrlPatterns) {
      try {
        const r = await context.request.get(url, { headers: { 'Accept': 'text/html', 'User-Agent': UA }, timeout: 8000 });
        log(`GP URL test: ${url.replace('https://www.gotprint.com', '')} → ${r.status()}`);
        if (r.status() === 200) {
          const body = await r.text();
          if (/roll.*label|configurator|price/i.test(body.slice(0, 5000))) {
            log(`  → Contains roll labels content!`);
            result.configuratorUrl = url;
          }
        }
      } catch (_) {}
    }

    // ── Step 9: Navigate to discovered URL and read price ──
    if (result.configuratorUrl && !result.configuratorUrl.includes('home.html')) {
      log(`GP: loading confirmed configurator: ${result.configuratorUrl}`);
      await page.goto(result.configuratorUrl, { waitUntil: 'networkidle', timeout: 35000 });
      await sleep(5000);
      await screenshot(page, 'gp2-04-final-config');
      log(`GP: final URL = ${page.url()}`);

      // Read all prices from DOM
      const domPrices = await page.evaluate(() => {
        const prices = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const t = n.textContent.trim();
          if (/\$[\d,]+\.\d{2}/.test(t)) prices.push(t);
        }
        return prices.slice(0, 20);
      });
      log(`GP DOM prices: ${JSON.stringify(domPrices)}`);

      // Check intercepted API calls
      log(`GP: ${priceApiCalls.length} API calls from configurator`);
      for (const c of priceApiCalls.slice(0, 10)) {
        log(`  ${c.url.slice(c.url.indexOf('/v1/') + 4)} → ${c.body.slice(0, 200)}`);
      }
    }

    // ── Step 10: Scan all REST API calls made during page load for pricing ──
    for (const c of priceApiCalls) {
      try {
        const d = JSON.parse(c.body);
        // Check for price fields
        const checkPrice = (obj, path = '') => {
          if (typeof obj === 'number' && obj > 20 && obj < 10000 && path.toLowerCase().includes('price')) {
            log(`GP: potential price at ${path}: ${obj}`);
          }
          if (typeof obj === 'object' && obj !== null) {
            for (const k of Object.keys(obj)) checkPrice(obj[k], `${path}.${k}`);
          }
        };
        checkPrice(d);
      } catch (_) {}
    }

  } catch (e) { err(`GP: ${e.message}`); result.notes.push(`Exception: ${e.message}`); }
  finally { await page.close(); await context.close(); }

  log(`GP result: ${JSON.stringify({ price5000: result.price5000, productId: result.productId, confUrl: result.configuratorUrl, method: result.method })}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// STICKER MULE: GraphQL intercept + full configurator interaction
// Strategy:
//   - SM uses /bridge/backend/graphql and /core/graphql
//   - Capture ALL request bodies sent to graphql endpoints
//   - Navigate to custom-labels, dismiss modal, look for what happens when
//     you try to interact with size/qty fields before upload
//   - Also try their "Get a free sample" and pricing-table pages
//   - Try intercepting a POST to /core/graphql with pricing query
// ══════════════════════════════════════════════════════════════════════════════
async function captureSM(browser) {
  log('\n── STICKER MULE: GraphQL intercept + configurator ──');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const gqlCalls = [];
  const gqlRequests = [];

  // Capture both requests AND responses for GraphQL
  context.on('request', async req => {
    const u = req.url();
    if (u.includes('graphql')) {
      try {
        const body = req.postData() || '';
        if (body) {
          gqlRequests.push({ url: u, body: body.slice(0, 2000), method: req.method() });
          try {
            const d = JSON.parse(body);
            const opName = d.operationName || d.query?.match(/^(?:query|mutation)\s+(\w+)/)?.[1] || 'unknown';
            log(`SM GQL request: ${u.split('/').pop()} operationName=${opName}`);
          } catch (_) {}
        }
      } catch (_) {}
    }
  });

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('graphql') && resp.status() < 400) {
      try {
        const body = await resp.text();
        gqlCalls.push({ url: u, body: body.slice(0, 3000) });
        if (/price|cost|amount|total|quote/i.test(body)) {
          log(`SM GQL response (pricing): ${body.slice(0, 400)}`);
        }
      } catch (_) {}
    }
  });

  const result = { price5000: null, unit5000: null, configuratorInteracted: false, gqlPricingQuery: null, method: null, notes: [] };

  const page = await context.newPage();
  try {
    log('SM: loading custom-labels page...');
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(5000);
    await screenshot(page, 'sm2-01-loaded');
    log(`SM: title="${await page.title()}" url=${page.url()}`);

    // Dismiss consent
    const consentBtns = ['button:has-text("OK")', 'button:has-text("Accept")', '#cookie-accept', '.consent-btn'];
    for (const s of consentBtns) {
      try {
        const b = await page.$(s);
        if (b && await b.isVisible()) { await b.click(); log(`SM: dismissed: ${s}`); await sleep(1500); break; }
      } catch (_) {}
    }
    await screenshot(page, 'sm2-02-after-consent');

    // ── Inspect all 3 visible form elements ──
    const allVis = await page.$$('input:visible, select:visible, textarea:visible, button:visible');
    log(`SM: ${allVis.length} visible form/button elements`);
    for (const el of allVis.slice(0, 30)) {
      try {
        const tag  = await el.evaluate(e => e.tagName);
        const type = await el.getAttribute('type') || '';
        const name = await el.getAttribute('name') || await el.getAttribute('id') || await el.getAttribute('aria-label') || await el.getAttribute('placeholder') || '';
        const text = (await el.textContent() || '').trim().slice(0, 50);
        log(`  <${tag} type="${type}" name/id/label="${name}" text="${text}">`);
      } catch (_) {}
    }

    // ── Inspect page structure for configurator elements ──
    const pageBody = await page.evaluate(() => {
      // Look for elements that might be size/qty configurator
      const results = [];
      const sel = '[class*="size"], [class*="qty"], [class*="quantity"], [class*="config"], [class*="option"], [data-product], [data-size], [data-qty]';
      document.querySelectorAll(sel).forEach(el => {
        if (el.offsetWidth > 0) results.push({
          tag: el.tagName,
          className: el.className.slice(0, 80),
          text: el.textContent.trim().slice(0, 100),
          dataAttrs: Object.fromEntries([...el.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value]))
        });
      });
      return results.slice(0, 20);
    });
    log(`SM: configurator elements: ${JSON.stringify(pageBody.slice(0, 5))}`);

    // ── Try scrolling to find more content / lazy-loaded configurator ──
    await page.evaluate(() => window.scrollTo(0, 500));
    await sleep(2000);
    await screenshot(page, 'sm2-03-scrolled');

    // ── Check GQL requests captured on page load ──
    log(`SM: ${gqlRequests.length} GQL requests made on page load`);
    for (const r of gqlRequests.slice(0, 10)) {
      try {
        const d = JSON.parse(r.body);
        log(`  operationName="${d.operationName || '?'}" variables=${JSON.stringify(d.variables || {}).slice(0, 100)}`);
      } catch (_) { log(`  raw: ${r.body.slice(0, 100)}`); }
    }

    // ── Find a pricing-related GQL query from intercepted requests ──
    let pricingQuery = null;
    for (const r of gqlRequests) {
      try {
        const d = JSON.parse(r.body);
        if (/price|cost|quote|order/i.test(d.operationName || '') || /price|cost|amount/i.test(d.query || '')) {
          pricingQuery = { url: r.url, operationName: d.operationName, query: d.query, variables: d.variables };
          log(`SM: found pricing GQL: ${d.operationName} at ${r.url}`);
          break;
        }
      } catch (_) {}
    }
    result.gqlPricingQuery = pricingQuery;

    // ── Try replaying the pricing query with our variables ──
    if (pricingQuery) {
      log(`SM: replaying pricing query with 3×3/5000 variables...`);
      const newVars = {
        ...pricingQuery.variables,
        width: 3, height: 3, quantity: 5000, qty: 5000,
        product: 'custom-labels', productSlug: 'custom-labels'
      };
      try {
        const resp = await context.request.post(pricingQuery.url, {
          data: JSON.stringify({ operationName: pricingQuery.operationName, query: pricingQuery.query, variables: newVars }),
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          timeout: 12000
        });
        const body = await resp.text();
        log(`SM GQL replay: status=${resp.status()} body=${body.slice(0, 500)}`);
      } catch (e) { log(`SM GQL replay failed: ${e.message}`); }
    }

    // ── Try known SM GQL queries for product pricing ──
    const smGqlUrl = 'https://www.stickermule.com/bridge/backend/graphql';
    const coreGqlUrl = 'https://www.stickermule.com/core/graphql';

    const pricingQueries = [
      // Query 1: getProductPrice
      { url: smGqlUrl, body: { operationName: 'getProductPrice', query: `query getProductPrice($productSlug: String!, $width: Float, $height: Float, $quantity: Int) { productPrice(productSlug: $productSlug, width: $width, height: $height, quantity: $quantity) { price totalPrice unitPrice } }`, variables: { productSlug: 'custom-labels', width: 3, height: 3, quantity: 5000 } } },
      // Query 2: ProductPricing
      { url: smGqlUrl, body: { operationName: 'ProductPricing', query: `query ProductPricing($slug: String!, $qty: Int!, $w: Float!, $h: Float!) { pricing(productSlug: $slug, quantity: $qty, width: $w, height: $h) { totalPrice unitPrice } }`, variables: { slug: 'custom-labels', qty: 5000, w: 3, h: 3 } } },
      // Query 3: price calculator
      { url: coreGqlUrl, body: { operationName: 'PriceCalculator', query: `query PriceCalculator($product: String!, $quantity: Int!, $width: Float!, $height: Float!) { price(product: $product, quantity: $quantity, width: $width, height: $height) { total unit } }`, variables: { product: 'custom-labels', quantity: 5000, width: 3, height: 3 } } },
    ];

    // First, try to find the actual query structure from intercepted responses
    let foundQueryStructure = null;
    for (const r of gqlCalls.slice(0, 20)) {
      try {
        const d = JSON.parse(r.body);
        if (d.data) {
          const keys = Object.keys(d.data);
          log(`SM GQL response keys: ${keys.join(', ')}`);
          if (/price|cost|order/i.test(keys.join(''))) {
            foundQueryStructure = { url: r.url, dataKeys: keys, body: r.body.slice(0, 500) };
          }
        }
      } catch (_) {}
    }
    if (foundQueryStructure) log(`SM: found pricing response structure: ${JSON.stringify(foundQueryStructure)}`);

    // Try probing GQL introspection to understand schema
    try {
      const introspectResp = await context.request.post(smGqlUrl, {
        data: JSON.stringify({ query: '{ __schema { queryType { fields { name args { name type { name kind ofType { name } } } } } } }' }),
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      const body = await introspectResp.text();
      log(`SM introspection: status=${introspectResp.status()} body=${body.slice(0, 600)}`);
      if (introspectResp.status() === 200) {
        try {
          const d = JSON.parse(body);
          const fields = d.data?.__schema?.queryType?.fields;
          if (fields) {
            const priceFields = fields.filter(f => /price|cost|order|quote/i.test(f.name));
            log(`SM GQL pricing-related queries: ${priceFields.map(f => f.name).join(', ')}`);
            result.notes.push(`GQL queries: ${priceFields.map(f => f.name).join(', ')}`);
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Try the probing queries
    for (const q of pricingQueries) {
      try {
        const r = await context.request.post(q.url, {
          data: JSON.stringify(q.body),
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          timeout: 8000
        });
        log(`SM GQL probe "${q.body.operationName}": status=${r.status()}`);
        if (r.status() < 400) {
          const body = await r.text();
          log(`  body: ${body.slice(0, 300)}`);
        }
      } catch (_) {}
    }

    // ── Try stickermule.com/custom-stickers as reference ──
    // SM might have a different URL for labels that works better
    log('SM: trying /custom-stickers for reference...');
    await page.goto('https://www.stickermule.com/custom-stickers', { waitUntil: 'networkidle', timeout: 25000 });
    await sleep(3000);
    await screenshot(page, 'sm2-04-stickers');
    const stickerPrices = await page.evaluate(() => {
      const r = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const t = n.textContent.trim();
        if (/\$[\d,]+\.?\d*/.test(t) && t.length < 50) r.push(t);
      }
      return r.slice(0, 10);
    });
    log(`SM stickers prices: ${JSON.stringify(stickerPrices)}`);

    // ── Check if SM exposes a pricing page ──
    const smPricingUrls = [
      'https://www.stickermule.com/custom-labels/pricing',
      'https://www.stickermule.com/custom-labels#pricing',
      'https://www.stickermule.com/api/v1/custom-labels/pricing_table',
    ];
    for (const url of smPricingUrls) {
      try {
        const r = await context.request.get(url, { headers: { Accept: 'application/json,text/html' }, timeout: 8000 });
        log(`SM pricing URL: ${url.replace('https://www.stickermule.com', '')} → ${r.status()}`);
        if (r.status() === 200) {
          const body = await r.text();
          log(`  body: ${body.slice(0, 300)}`);
        }
      } catch (_) {}
    }

    // ── Final: check all collected GQL for price info ──
    log(`SM: total GQL responses: ${gqlCalls.length}`);
    for (const c of gqlCalls.slice(0, 10)) {
      const snippet = c.body.slice(0, 300);
      if (/price|cost|amount|total/i.test(snippet)) {
        log(`SM: pricing in GQL: ${snippet}`);
      }
    }

  } catch (e) { err(`SM: ${e.message}`); result.notes.push(`Exception: ${e.message}`); }
  finally { await page.close(); await context.close(); }

  log(`SM result: ${JSON.stringify({ price5000: result.price5000, gqlQuery: result.gqlPricingQuery ? 'found' : 'not found', method: result.method })}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const raw  = readJSON(RAW_FILE);
  const norm = readJSON(NORM_FILE);
  if (!raw || !norm) { err('Cannot load data files'); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  try {
    const [vpResult, gpResult, smResult] = await Promise.allSettled([
      captureVP(browser),
      captureGP(browser),
      captureSM(browser)
    ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : { error: x.reason?.message }));

    console.log('\n══════════════════════════════════════════');
    console.log(' TARGETED PASS 2 SUMMARY');
    console.log('══════════════════════════════════════════');
    console.log('VISTAPRINT:');
    console.log(`  Price 5000: ${vpResult?.price5000 ? '$' + vpResult.price5000 : 'not captured'}`);
    console.log(`  Shape:      ${vpResult?.shapeClicked}`);
    console.log(`  Width=3:    ${vpResult?.widthFilled === 3} | Height=3: ${vpResult?.heightFilled === 3}`);
    console.log(`  Method:     ${vpResult?.method || 'N/A'}`);
    console.log(`  All prices: ${JSON.stringify(vpResult?.allPrices || {})}`);
    console.log('');
    console.log('GOTPRINT:');
    console.log(`  Price 5000: ${gpResult?.price5000 ? '$' + gpResult.price5000 : 'not captured'}`);
    console.log(`  Product ID: ${gpResult?.productId}`);
    console.log(`  Config URL: ${gpResult?.configuratorUrl}`);
    console.log(`  Method:     ${gpResult?.method || 'N/A'}`);
    console.log('');
    console.log('STICKER MULE:');
    console.log(`  Price 5000: ${smResult?.price5000 ? '$' + smResult.price5000 : 'not captured'}`);
    console.log(`  GQL query:  ${smResult?.gqlPricingQuery ? 'found' : 'not found'}`);
    console.log(`  Method:     ${smResult?.method || 'N/A'}`);
    console.log(`  Notes:      ${smResult?.notes?.join('; ')}`);
    console.log('══════════════════════════════════════════\n');
  } finally {
    await browser.close();
  }
}

main().catch(e => { err(`Fatal: ${e.message}`); process.exit(1); });
