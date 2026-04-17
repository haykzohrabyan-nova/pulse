#!/usr/bin/env node
/**
 * capture-api-direct.js — Direct API capture for competitors whose APIs we discovered
 *
 * GotPrint: /service/rest/v1/products/quantities + /service/rest/v1/products/price
 * Axiom Print: website.workroomapp.com/api/v1/products
 * Vistaprint: Deeper headless with roll-labels configurator
 * Sticker Mule: Headless with cookie consent dismissed + configurator
 * UPrinting: Headless with product page deep navigation
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');

const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const SPECIFIC      = (() => { const i = args.indexOf('--only'); return i !== -1 ? args[i+1] : null; })();
const DEBUG        = args.includes('--debug');

function log(msg)  { console.log(`[api-direct] ${msg}`); }
function dbg(msg)  { if (DEBUG) console.log(`[DBG]        ${msg}`); }
function err(msg)  { console.error(`[ERROR]      ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseDollar(text) {
  if (!text) return null;
  const m = String(text).match(/[\d,]+\.?\d*/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(/,/g, ''));
  return (v > 0 && v < 200000) ? v : null;
}

// ─── GOTPRINT API PROBE ───────────────────────────────────────────────────────
// Their Vue.js configurator JS revealed the API structure:
// GET /service/rest/v1/products/quantities?productType=X&size=X&paper=X&shape=X
// GET /service/rest/v1/products/price?productType=X&size=X&qty=X&paper=X&shape=X&...

async function captureGotprintAPI(browser) {
  log('GotPrint: probing pricing API directly');
  const results = [];

  // First, discover valid product/size/paper parameter values by loading the product page
  // and intercepting the actual API calls made by the Vue.js configurator
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const intercepted = [];
  const priceAPIResponses = [];

  context.on('request', req => {
    const u = req.url();
    if (u.includes('/service/rest/') || u.includes('/api/') || u.includes('price') || u.includes('quantities')) {
      intercepted.push({ url: u, method: req.method(), postData: req.postData() });
    }
  });

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('/service/rest/') || u.includes('price') || u.includes('quantities')) {
      try {
        const body = await resp.text();
        if (body.length > 5 && body.length < 200000) {
          priceAPIResponses.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    // Navigate to the roll labels product page
    const productUrls = [
      'https://www.gotprint.com/g/roll-labels.html',
      'https://www.gotprint.com/store/stickers-and-labels/roll-labels',
      'https://www.gotprint.com/g/label-printing.html'
    ];

    let loaded = false;
    for (const url of productUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
        if (resp && resp.status() < 400) {
          const title = await page.title();
          log(`GotPrint: loaded ${url} → "${title}"`);
          if (!title.includes('404')) { loaded = true; break; }
        }
      } catch (e) { dbg('GP product url: ' + e.message); }
    }

    if (!loaded) {
      // Try to load the category page and click on Roll Labels
      await page.goto('https://www.gotprint.com/store/stickers-and-labels', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);

      // Look for Roll Labels link
      const rollLabelLink = await page.$('a[href*="roll-label"], a:text-matches("Roll Label", "i")');
      if (rollLabelLink) {
        await rollLabelLink.click();
        await sleep(4000);
        loaded = true;
        log('GotPrint: clicked Roll Labels link');
      }
    }

    // Now wait for Vue.js to make configurator API calls
    await sleep(5000);

    log(`GotPrint: intercepted ${intercepted.length} API requests, ${priceAPIResponses.length} API responses`);

    if (intercepted.length > 0) {
      log('GotPrint: intercepted API calls:');
      intercepted.forEach(r => log(`  ${r.method} ${r.url}`));
    }

    if (priceAPIResponses.length > 0) {
      log('GotPrint: API responses captured:');
      for (const r of priceAPIResponses) {
        log(`  ${r.status} ${r.url}`);
        dbg('  body: ' + r.body.slice(0, 300));
      }
    }

    // Try to extract quantities/sizes available from any captured API response
    for (const r of priceAPIResponses) {
      if (r.url.includes('quantities')) {
        try {
          const data = JSON.parse(r.body);
          log('GotPrint: quantities API data: ' + JSON.stringify(data).slice(0, 500));
        } catch (_) {}
      }
    }

    // Now try to interact with the form to trigger price API calls
    await sleep(2000);

    // Find the configurator form selects
    const formState = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]'));
      return {
        selects: selects.map(s => ({
          name: s.name, id: s.id,
          value: s.value,
          options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 15)
        })),
        inputs: inputs.map(i => ({ name: i.name, id: i.id, value: i.value, placeholder: i.placeholder }))
      };
    });

    log(`GotPrint: form state — ${formState.selects.length} selects, ${formState.inputs.length} inputs`);
    if (formState.selects.length > 0) {
      formState.selects.forEach(s => {
        log(`  Select "${s.name||s.id}": [${s.options.map(o => o.t).join(', ').slice(0,100)}]`);
      });
    }

    // Try to select qty = 5000 if there's a qty dropdown
    for (const sel of formState.selects) {
      if (sel.name?.toLowerCase().includes('qty') || sel.id?.toLowerCase().includes('qty') || sel.name?.toLowerCase().includes('quantity')) {
        const opt5k = sel.options.find(o => o.t.includes('5000') || o.v === '5000');
        if (opt5k) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          try {
            await page.selectOption(selector, opt5k.v);
            log(`GotPrint: selected qty 5000 in ${selector}`);
            await sleep(3000); // Wait for price API call
          } catch (e) { dbg('GP qty select: ' + e.message); }
        }
      }
    }

    // Re-check API responses after interaction
    log(`GotPrint: after interaction — ${priceAPIResponses.length} total API responses`);

    for (const r of priceAPIResponses) {
      dbg(`GP API response: ${r.url}`);
      dbg(`GP API body: ${r.body.slice(0, 500)}`);
    }

    // Try direct API calls with discovered parameter patterns
    // Build from the JS we captured: productType, size, paper, shape, qty
    const directAPITests = [
      // Try fetching price for roll labels directly
      'https://www.gotprint.com/service/rest/v1/products/quantities?productType=ROLL_LABELS&size=3x3&paper=BOPP_MATTE&shape=SQUARE',
      'https://www.gotprint.com/service/rest/v1/products/price?productType=ROLL_LABELS&size=3x3&qty=5000&paper=BOPP_MATTE&shape=SQUARE',
      'https://www.gotprint.com/service/rest/v1/products/quantities?productType=LABELS&size=3x3&paper=MATTE',
      'https://www.gotprint.com/service/rest/v1/products/quantities?productType=rollLabels&size=3x3',
    ];

    for (const apiUrl of directAPITests) {
      try {
        const resp = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
            const text = await r.text();
            return { status: r.status, body: text.slice(0, 1000) };
          } catch (e) { return { error: e.message }; }
        }, apiUrl);

        log(`GP direct API: ${apiUrl.split('?')[0].split('/').pop()} → status=${resp.status || resp.error}`);
        if (resp.status === 200) {
          log(`  RESPONSE: ${resp.body.slice(0, 300)}`);
        }
        dbg(`  full: ${JSON.stringify(resp)}`);
      } catch (e) { dbg('GP direct api test: ' + e.message); }
    }

    // Extract any prices from current page state
    const pageText = await page.evaluate(() => document.body.innerText);
    const priceRe = /\$([\d,]+\.?\d{0,2})/g;
    const prices = [];
    let m;
    while ((m = priceRe.exec(pageText)) !== null) {
      const v = parseDollar(m[1]);
      if (v && v >= 10 && v <= 50000) prices.push(v);
    }
    log(`GotPrint: all prices on current page: [${[...new Set(prices)].join(', ')}]`);

    // Check if we intercepted any useful pricing response
    const pricingResp = priceAPIResponses.find(r => r.url.includes('price') || r.url.includes('quote'));
    if (pricingResp) {
      try {
        const data = JSON.parse(pricingResp.body);
        log('GotPrint: pricing API JSON: ' + JSON.stringify(data).slice(0, 500));
        results.push({ source: 'gotprint_api', url: pricingResp.url, data });
      } catch (_) {}
    }

    return { intercepted, priceAPIResponses, prices: [...new Set(prices)], results };

  } finally {
    await context.close();
  }
}

// ─── AXIOM WORKROOMAPP API ────────────────────────────────────────────────────
// Axiom Print uses website.workroomapp.com as their backend.
// The API at /api/v1/products/search-products?organisationName=axiom-print
// returns product catalog data. We need to also hit product-specific pricing.

async function captureAxiomWorkroomAPI() {
  log('Axiom Print: probing workroomapp.com API');
  const results = {};

  const baseUrl = 'https://website.workroomapp.com/api/v1';
  const orgName = 'axiom-print';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://axiomprint.com/',
    'Origin': 'https://axiomprint.com'
  };

  // 1. Get org info
  try {
    const resp = await fetch(`${baseUrl}/org/${orgName}`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      log('Axiom: org info keys: ' + Object.keys(data).join(', '));
      results.org = data;
    }
  } catch (e) { dbg('Axiom org: ' + e.message); }

  // 2. Get product catalog
  try {
    const resp = await fetch(`${baseUrl}/products/search-products?organisationName=${orgName}`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      const products = Array.isArray(data) ? data : (data.products || data.data || []);
      log(`Axiom: product catalog — ${products.length} products`);

      // Find label products
      const labelProducts = products.filter(p => {
        const name = (p.name || p.title || p.productName || '').toLowerCase();
        return name.includes('label') || name.includes('sticker') || name.includes('roll');
      });
      log(`Axiom: ${labelProducts.length} label/sticker products found`);
      labelProducts.forEach(p => {
        const id = p.id || p._id || p.slug;
        const name = p.name || p.title || p.productName;
        log(`  - ${name} (id: ${id})`);
      });

      results.catalog = { total: products.length, labels: labelProducts };
    } else {
      log('Axiom: product catalog response: ' + resp.status);
      const text = await resp.text();
      dbg('Axiom catalog body: ' + text.slice(0, 500));
    }
  } catch (e) { dbg('Axiom catalog: ' + e.message); }

  // 3. Hit the roll-labels product directly (we know the URL: /product/roll-labels-335)
  const rollLabelsSlug = 'roll-labels-335';
  const productApiPaths = [
    `${baseUrl}/products/${rollLabelsSlug}`,
    `${baseUrl}/products/slug/${rollLabelsSlug}`,
    `${baseUrl}/products/by-slug/${rollLabelsSlug}`,
    `${baseUrl}/products?slug=${rollLabelsSlug}&organisationName=${orgName}`,
    `${baseUrl}/products/search-products?organisationName=${orgName}&slug=${rollLabelsSlug}`,
    `${baseUrl}/products/search-products?organisationName=${orgName}&productName=roll-labels`,
  ];

  for (const apiPath of productApiPaths) {
    try {
      const resp = await fetch(apiPath, { headers });
      log(`Axiom product API: ${apiPath.split('?')[0].split('/').slice(-2).join('/')} → ${resp.status}`);
      if (resp.ok) {
        const text = await resp.text();
        const data = JSON.parse(text);
        log('Axiom product data keys: ' + (Array.isArray(data) ? `array[${data.length}]` : Object.keys(data).join(', ')));
        log('Axiom product data snippet: ' + JSON.stringify(data).slice(0, 500));
        results.rollLabelsProduct = data;

        // Look for pricing info in the product data
        const jsonStr = JSON.stringify(data);
        const priceMatch = jsonStr.match(/"(?:price|amount|cost|basePrice|unitPrice)":\s*"?(\d+\.?\d*)"?/);
        if (priceMatch) {
          log('Axiom: price field in product data: ' + priceMatch[0]);
        }
        break;
      }
    } catch (e) { dbg('Axiom product api: ' + e.message); }
  }

  // 4. Try to get pricing tables directly
  const pricingPaths = [
    `${baseUrl}/pricing?organisationName=${orgName}&productSlug=${rollLabelsSlug}`,
    `${baseUrl}/products/${rollLabelsSlug}/pricing`,
    `${baseUrl}/products/pricing?slug=${rollLabelsSlug}&organisationName=${orgName}`,
    `${baseUrl}/price-calculator?organisationName=${orgName}`,
  ];

  for (const pp of pricingPaths) {
    try {
      const resp = await fetch(pp, { headers });
      if (resp.ok) {
        const text = await resp.text();
        log(`Axiom pricing API hit: ${pp}`);
        log(`Axiom pricing data: ${text.slice(0, 500)}`);
        results.pricing = text;
        break;
      } else {
        dbg(`Axiom pricing: ${pp} → ${resp.status}`);
      }
    } catch (e) { dbg('Axiom pricing: ' + e.message); }
  }

  return results;
}

// ─── AXIOM HEADLESS — Navigate to actual product page ─────────────────────────
async function captureAxiomProductPage(browser) {
  log('Axiom Print: navigating to actual product configurator');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const apiCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('workroomapp.com') || u.includes('price') || u.includes('product') || u.includes('quote')) {
      try {
        const body = await resp.text();
        if (body.length > 20 && body.length < 500000) {
          apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 10000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let prices = [];
  let productData = null;

  try {
    // Go directly to the roll labels product page
    await page.goto('https://axiomprint.com/product/roll-labels-335', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(4000);

    const title = await page.title();
    log('Axiom product page title: ' + title);

    // Extract all prices from page
    const pageText = await page.evaluate(() => document.body.innerText);
    const priceRe = /\$([\d,]+\.?\d{0,2})/g;
    let m;
    while ((m = priceRe.exec(pageText)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v >= 1 && v <= 100000) prices.push(v);
    }
    prices = [...new Set(prices)];
    log('Axiom roll labels page prices: ' + prices.join(', '));

    // Extract form elements and configurator data
    const configState = await page.evaluate(() => {
      const state = {
        selects: [],
        inputs: [],
        priceElements: [],
        nextData: null,
        customVars: {}
      };

      // Selects
      state.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      }));

      // Number inputs
      state.inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        name: i.name, id: i.id, type: i.type, value: i.value, placeholder: i.placeholder,
        dataAttr: i.dataset ? Object.entries(i.dataset).slice(0,5).map(([k,v]) => `${k}=${v}`).join(',') : ''
      })).slice(0, 20);

      // Price-looking elements
      state.priceElements = Array.from(document.querySelectorAll('[class*="price"], [class*="cost"], [class*="total"], [data-price], [data-total]'))
        .map(el => ({ tag: el.tagName, class: el.className.slice(0,50), text: el.textContent.trim().slice(0, 50) }))
        .slice(0, 15);

      // Next.js data
      if (window.__NEXT_DATA__) {
        state.nextData = JSON.stringify(window.__NEXT_DATA__).slice(0, 8000);
      }

      return state;
    });

    log(`Axiom: ${configState.selects.length} selects, ${configState.inputs.length} inputs, ${configState.priceElements.length} price elements`);

    if (configState.selects.length > 0) {
      configState.selects.forEach(s => log(`  Select "${s.name||s.id}": options=[${s.options.slice(0,5).map(o=>o.t).join(', ')}...]`));
    }
    if (configState.priceElements.length > 0) {
      configState.priceElements.forEach(el => log(`  Price el <${el.tag}.${el.class.split(' ')[0]}>: "${el.text}"`));
    }

    // Parse __NEXT_DATA__ for product + pricing info
    if (configState.nextData) {
      dbg('Axiom __NEXT_DATA__: ' + configState.nextData.slice(0, 1000));

      // Look for price data
      const nextData = JSON.parse(configState.nextData);
      const jsonStr = configState.nextData;

      // Common price field patterns
      const priceFields = ['price', 'basePrice', 'unitPrice', 'startingPrice', 'from_price', 'minPrice', 'amount'];
      for (const field of priceFields) {
        const re = new RegExp(`"${field}":\\s*"?(\\d+\\.?\\d*)"?`, 'g');
        let pm;
        while ((pm = re.exec(jsonStr)) !== null) {
          const v = parseFloat(pm[1]);
          if (v > 0 && v < 100000) {
            log(`Axiom __NEXT_DATA__ "${field}": $${v}`);
          }
        }
      }

      productData = nextData;
    }

    // Check workroomapp.com API captures
    const workroomCaptures = apiCaptures.filter(c => c.url.includes('workroomapp.com'));
    log(`Axiom: ${workroomCaptures.length} workroomapp.com API responses`);

    for (const cap of workroomCaptures) {
      log(`  Workroom API: ${cap.url}`);
      dbg(`  body: ${cap.body.slice(0, 500)}`);

      // Look for pricing in the workroom API response
      if (cap.body.includes('price') || cap.body.includes('amount') || cap.body.includes('quantity')) {
        log(`  *** Contains price/quantity data ***`);
        try {
          const data = JSON.parse(cap.body);
          const jsonStr = JSON.stringify(data);

          // Find all price-like values
          const priceRe = /"(?:price|amount|cost|basePrice|unitPrice|startingPrice)":\s*"?(\d+\.?\d*)"?/g;
          let pm;
          while ((pm = priceRe.exec(jsonStr)) !== null) {
            log(`    Price field: ${pm[0]}`);
          }

          // Find quantity tiers
          if (jsonStr.includes('quantity') || jsonStr.includes('tier')) {
            const quantityData = jsonStr.match(/\[.*?\]/g);
            if (quantityData) {
              log(`    Has array data (possible tiers): ${quantityData[0]?.slice(0, 200)}`);
            }
          }
        } catch (_) {}
      }
    }

    // Try to interact with configurator
    if (configState.selects.length > 0) {
      // Try to find quantity selector and select 5000
      for (const sel of configState.selects) {
        const opt5k = sel.options.find(o => o.t.includes('5000') || o.v === '5000');
        if (opt5k) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          try {
            await page.selectOption(selector, opt5k.v);
            log(`Axiom: selected qty 5000`);
            await sleep(3000);

            // Re-check prices
            const updatedText = await page.evaluate(() => document.body.innerText);
            const newPrices = [];
            const re = /\$([\d,]+\.?\d{0,2})/g;
            let nm;
            while ((nm = re.exec(updatedText)) !== null) {
              const v = parseFloat(nm[1].replace(/,/g, ''));
              if (v >= 1 && v <= 100000) newPrices.push(v);
            }
            log('Axiom prices after qty=5000: ' + [...new Set(newPrices)].join(', '));
            if (newPrices.length > 0) prices = [...new Set(newPrices)];
          } catch (e) { dbg('Axiom qty select: ' + e.message); }
          break;
        }
      }
    }

  } finally {
    await context.close();
  }

  return { prices, productData, apiCaptures: apiCaptures.map(c => ({ url: c.url, status: c.status, bodySnippet: c.body.slice(0,200) })) };
}

// ─── VISTAPRINT ROLL LABELS ───────────────────────────────────────────────────
// We now know the real URL: /labels-stickers/roll-labels
// Try to interact with the configurator there

async function captureVistaprintRollLabels(browser) {
  log('Vistaprint: targeting roll labels configurator');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US'
  });

  const apiCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (ct.includes('json') && resp.status() < 400 && !u.includes('analytics') && !u.includes('tracking')) {
      try {
        const body = await resp.text();
        if (body.length > 20 && body.length < 500000) {
          apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let prices = [];
  let priceFound = null;

  try {
    // Navigate to roll labels
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', { waitUntil: 'networkidle', timeout: 35000 });
    await sleep(5000);

    const title = await page.title();
    log('Vistaprint roll labels title: ' + title);

    // Extract all text and prices
    const pageText = await page.evaluate(() => document.body.innerText);
    log('VP page text sample: ' + pageText.slice(0, 400));

    const priceRe = /\$([\d,]+\.?\d{0,2})/g;
    let m;
    while ((m = priceRe.exec(pageText)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v >= 5 && v <= 10000) prices.push(v);
    }
    prices = [...new Set(prices)];
    log('VP roll labels page prices: ' + prices.join(', '));

    // Check API captures
    log(`VP: ${apiCaptures.length} JSON API responses captured`);
    for (const cap of apiCaptures) {
      dbg(`VP API: ${cap.url}`);
      if (cap.body.includes('"price"') || cap.body.includes('"amount"') || cap.body.includes('"total"')) {
        log(`VP pricing API: ${cap.url}`);
        log(`VP pricing body: ${cap.body.slice(0, 500)}`);

        // Try to extract price
        const pm = cap.body.match(/"(?:price|amount|total|listPrice|salePrice)":\s*"?(\d+\.?\d*)"?/);
        if (pm) {
          const p = parseFloat(pm[1]);
          if (p > 5) {
            log(`VP: API price: $${p}`);
            priceFound = p;
          }
        }
      }
    }

    // Look for quantity selector and interact
    const configState = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      }));

      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [data-automation*="price"], [data-testid*="price"]'))
        .map(el => ({ class: el.className.slice(0,50), text: el.textContent.trim().slice(0, 60) }));

      return { selects, priceEls };
    });

    log(`VP: ${configState.selects.length} selects, ${configState.priceEls.length} price elements`);
    configState.priceEls.forEach(el => log(`  Price el: "${el.text}"`));

    if (configState.selects.length > 0) {
      for (const sel of configState.selects) {
        log(`  Select "${sel.name||sel.id}": [${sel.options.slice(0,8).map(o=>o.t).join(' | ')}]`);
        // Try to find and select qty 5000
        const opt5k = sel.options.find(o => o.t.includes('5000') || o.v === '5000');
        if (opt5k) {
          try {
            const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
            await page.selectOption(selector, opt5k.v);
            log(`VP: selected qty 5000 in ${selector}`);
            await sleep(4000);

            // Re-read prices
            const newText = await page.evaluate(() => document.body.innerText);
            const newPrices = [];
            const re = /\$([\d,]+\.?\d{0,2})/g;
            let nm;
            while ((nm = re.exec(newText)) !== null) {
              const v = parseFloat(nm[1].replace(/,/g, ''));
              if (v >= 5 && v <= 10000) newPrices.push(v);
            }
            log('VP prices after qty=5000: ' + [...new Set(newPrices)].join(', '));
            if (newPrices.length > 0) prices = [...new Set(newPrices)];
          } catch (e) { dbg('VP qty: ' + e.message); }
        }
      }
    }

    // Try product labels on sheets page too (may have qty pricing table)
    if (!priceFound && prices.length === 0) {
      await page.goto('https://www.vistaprint.com/labels-stickers/product-labels-on-sheets', { waitUntil: 'networkidle', timeout: 25000 });
      await sleep(4000);
      const sheetsText = await page.evaluate(() => document.body.innerText);
      log('VP product labels on sheets sample: ' + sheetsText.slice(0, 300));

      const sheetPrices = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let nm;
      while ((nm = re.exec(sheetsText)) !== null) {
        const v = parseFloat(nm[1].replace(/,/g, ''));
        if (v >= 5 && v <= 10000) sheetPrices.push(v);
      }
      if (sheetPrices.length > 0) {
        log('VP sheets prices: ' + [...new Set(sheetPrices)].join(', '));
        prices.push(...sheetPrices);
      }
    }

  } finally {
    await context.close();
  }

  return { prices: [...new Set(prices)], priceFound, apiCaptures: apiCaptures.map(c => ({ url: c.url, bodySnippet: c.body.slice(0,200) })) };
}

// ─── STICKER MULE — Dismiss cookie + navigate to pricing ─────────────────────
async function captureStickermuleDeep(browser) {
  log('Sticker Mule: deep capture with cookie dismiss + pricing page');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const apiCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('price') || u.includes('quote') || u.includes('api') || u.includes('graphql')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 200000 && (body.includes('price') || body.includes('amount') || body.includes('total') || body.includes('quote'))) {
          apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let prices = [];
  let pricingTableData = null;

  try {
    await page.goto('https://www.stickermule.com/custom-labels', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Dismiss cookie consent
    const consentSelectors = [
      'button:text-matches("Agree", "i")',
      'button:text-matches("Accept", "i")',
      'button:text-matches("OK", "i")',
      '[data-testid*="accept"]',
      '[class*="consent"] button',
      '#onetrust-accept-btn-handler',
      '.cookie-accept'
    ];

    for (const sel of consentSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          log('SM: dismissed cookie consent via ' + sel);
          await sleep(2000);
          break;
        }
      } catch (_) {}
    }

    // Now try to navigate to a specific label size/qty URL
    // Sticker Mule often has URLs like /custom-labels?width=3&height=3&quantity=5000
    const configuratorUrls = [
      'https://www.stickermule.com/custom-labels?width=3&height=3&quantity=5000',
      'https://www.stickermule.com/custom-labels?w=3&h=3&qty=5000',
      'https://www.stickermule.com/custom-labels/3x3/5000',
    ];

    for (const cu of configuratorUrls) {
      try {
        const resp = await page.goto(cu, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp && resp.status() < 400) {
          await sleep(3000);
          const cu_text = await page.evaluate(() => document.body.innerText);
          const cu_prices = [];
          const re = /\$([\d,]+\.?\d{0,2})/g;
          let m;
          while ((m = re.exec(cu_text)) !== null) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (v >= 20 && v <= 10000) cu_prices.push(v);
          }
          if (cu_prices.length > 0) {
            log(`SM: prices at ${cu}: [${[...new Set(cu_prices)].join(', ')}]`);
            prices.push(...cu_prices);
          }
        }
      } catch (_) {}
    }

    // Try the pricing page
    const pricingUrls = [
      'https://www.stickermule.com/pricing',
      'https://www.stickermule.com/custom-labels/pricing',
      'https://www.stickermule.com/custom-labels/sizes',
    ];

    for (const pu of pricingUrls) {
      try {
        const resp = await page.goto(pu, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp && resp.status() < 400) {
          await sleep(3000);
          const puText = await page.evaluate(() => document.body.innerText);
          log(`SM: pricing page ${pu} text sample: ${puText.slice(0, 400)}`);

          // Look for pricing table with qty 5000
          if (puText.includes('5,000') || puText.includes('5000')) {
            log('SM: found 5000 qty reference on pricing page!');
            // Extract the surrounding context
            const idx = puText.search(/5[,\s]?000/);
            if (idx > -1) {
              log('SM: 5000-qty context: ' + puText.slice(Math.max(0, idx-100), idx+200));
            }
          }

          const puPrices = [];
          const re = /\$([\d,]+\.?\d{0,2})/g;
          let m;
          while ((m = re.exec(puText)) !== null) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (v >= 20 && v <= 50000) puPrices.push(v);
          }
          if (puPrices.length > 0) {
            log(`SM: pricing page prices: [${[...new Set(puPrices)].join(', ')}]`);
            prices.push(...puPrices);
            pricingTableData = puText.slice(0, 2000);
          }
          if (resp.status() === 200) break;
        }
      } catch (_) {}
    }

    // Try GraphQL endpoint if we can find it
    const graphqlEndpoints = [
      'https://www.stickermule.com/api/graphql',
      'https://www.stickermule.com/graphql',
    ];

    for (const gql of graphqlEndpoints) {
      try {
        const resp = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                query: `{ product(slug: "custom-labels") { id name pricing { quantity price } } }`,
                variables: {}
              })
            });
            return { status: r.status, body: (await r.text()).slice(0, 1000) };
          } catch (e) { return { error: e.message }; }
        }, gql);
        log(`SM GraphQL: ${gql} → ${resp.status || resp.error}: ${(resp.body || '').slice(0, 200)}`);
      } catch (_) {}
    }

    log(`SM: API responses captured: ${apiCaptures.length}`);
    for (const cap of apiCaptures) {
      log(`  SM API: ${cap.url}`);
      dbg(`  body: ${cap.body.slice(0, 300)}`);
    }

  } finally {
    await context.close();
  }

  return { prices: [...new Set(prices)], pricingTableData, apiCaptures: apiCaptures.map(c => ({ url: c.url, bodySnippet: c.body.slice(0,300) })) };
}

// ─── UPRINTING DEEP ───────────────────────────────────────────────────────────
async function captureUprintingDeep(browser) {
  log('UPrinting: deep capture targeting configurator');

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const apiCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if ((ct.includes('json') || u.includes('price') || u.includes('quote') || u.includes('api') || u.includes('calculat')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 500000) {
          apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let prices = [];
  let configState = null;

  try {
    // Try stickers product page directly (not the category page)
    const productUrls = [
      'https://www.uprinting.com/stickers.html',
      'https://www.uprinting.com/circle-stickers.html',
      'https://www.uprinting.com/square-stickers.html',
      'https://www.uprinting.com/roll-labels.html',
      'https://www.uprinting.com/labels.html'
    ];

    let workingUrl = null;
    for (const url of productUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
        if (resp && resp.status() < 400) {
          const title = await page.title();
          log(`UP: ${url} → "${title}"`);
          if (!title.includes('404') && !title.includes('Not Found')) {
            workingUrl = url;
            break;
          }
        }
      } catch (e) { dbg('UP url: ' + e.message); }
    }

    if (!workingUrl) {
      log('UP: no product page found, trying category with deep nav');
      await page.goto('https://www.uprinting.com/stickers-and-labels.html', { waitUntil: 'networkidle', timeout: 25000 });
      await sleep(3000);

      // Try clicking on a product
      const productLink = await page.$('a[href*="sticker"], a[href*="label"]');
      if (productLink) {
        const href = await productLink.getAttribute('href');
        log(`UP: clicking product link: ${href}`);
        await productLink.click();
        await sleep(4000);
        workingUrl = page.url();
      }
    }

    log(`UP: working with ${workingUrl || page.url()}`);

    // Extract form state + prices
    configState = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      }));

      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        name: i.name, id: i.id, type: i.type, value: i.value, placeholder: i.placeholder
      })).slice(0, 20);

      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [data-price], [id*="price"]'))
        .map(el => ({ class: el.className.slice(0,50), text: el.textContent.trim().slice(0,80), id: el.id }))
        .filter(el => el.text.length > 0)
        .slice(0, 10);

      return { selects, inputs, priceEls };
    });

    log(`UP: ${configState.selects.length} selects, ${configState.inputs.length} inputs, ${configState.priceEls.length} price elements`);
    configState.selects.forEach(s => log(`  Select "${s.name||s.id}": [${s.options.slice(0,8).map(o=>o.t).join(' | ')}]`));
    configState.priceEls.forEach(el => log(`  Price: "${el.text}"`));

    // Extract current prices
    const pageText = await page.evaluate(() => document.body.innerText);
    const priceRe = /\$([\d,]+\.?\d{0,2})/g;
    let m;
    while ((m = priceRe.exec(pageText)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v >= 5 && v <= 50000) prices.push(v);
    }
    prices = [...new Set(prices)];
    log('UP initial page prices: ' + prices.join(', '));

    // Interact with form
    for (const sel of configState.selects) {
      const name = (sel.name || sel.id || '').toLowerCase();
      if (name.includes('qty') || name.includes('quantity')) {
        const opt5k = sel.options.find(o => o.t.includes('5,000') || o.t.includes('5000') || o.v === '5000');
        if (opt5k) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          try {
            await page.selectOption(selector, opt5k.v);
            log(`UP: selected qty 5000`);
            await sleep(4000);
          } catch (e) { dbg('UP qty: ' + e.message); }
        }
      }
    }

    // Re-check prices after interaction
    await sleep(2000);
    const updatedText = await page.evaluate(() => document.body.innerText);
    const newPrices = [];
    const re = /\$([\d,]+\.?\d{0,2})/g;
    let nm;
    while ((nm = re.exec(updatedText)) !== null) {
      const v = parseFloat(nm[1].replace(/,/g, ''));
      if (v >= 5 && v <= 50000) newPrices.push(v);
    }
    if (newPrices.length > 0) {
      log('UP prices after interaction: ' + [...new Set(newPrices)].join(', '));
      prices = [...new Set([...prices, ...newPrices])];
    }

    // Check API captures for pricing endpoint
    log(`UP: ${apiCaptures.length} API responses captured`);
    const pricingCaps = apiCaptures.filter(c => c.body.includes('"price"') || c.body.includes('"amount"') || c.body.includes('"total"'));
    for (const cap of pricingCaps) {
      log(`  UP pricing API: ${cap.url}`);
      log(`  UP pricing body: ${cap.body.slice(0, 400)}`);
    }

  } finally {
    await context.close();
  }

  return {
    prices,
    configState,
    apiCaptures: apiCaptures.slice(0, 20).map(c => ({ url: c.url, status: c.status, bodySnippet: c.body.slice(0, 300) }))
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Direct API + Deep Headless Capture ===');
  log(`Date: ${nowISO()}`);
  log('');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const allResults = {};

  try {
    // Run captures — some in parallel where safe
    if (!SPECIFIC || SPECIFIC === 'axiom') {
      log('=== AXIOM PRINT — workroomapp.com API ===');
      const axiomApi = await captureAxiomWorkroomAPI();
      allResults.axiomApi = axiomApi;
      log('');
    }

    if (!SPECIFIC || SPECIFIC === 'axiom') {
      log('=== AXIOM PRINT — Product Page ===');
      const axiomPage = await captureAxiomProductPage(browser);
      allResults.axiomPage = axiomPage;
      log('');
    }

    if (!SPECIFIC || SPECIFIC === 'gotprint') {
      log('=== GOTPRINT — API Probe ===');
      const gp = await captureGotprintAPI(browser);
      allResults.gotprint = gp;
      log('');
    }

    if (!SPECIFIC || SPECIFIC === 'vistaprint') {
      log('=== VISTAPRINT — Roll Labels ===');
      const vp = await captureVistaprintRollLabels(browser);
      allResults.vistaprint = vp;
      log('');
    }

    if (!SPECIFIC || SPECIFIC === 'stickermule') {
      log('=== STICKER MULE — Deep ===');
      const sm = await captureStickermuleDeep(browser);
      allResults.stickermule = sm;
      log('');
    }

    if (!SPECIFIC || SPECIFIC === 'uprinting') {
      log('=== UPRINTING — Deep ===');
      const up = await captureUprintingDeep(browser);
      allResults.uprinting = up;
      log('');
    }

  } finally {
    await browser.close();
  }

  // Write raw capture log
  const captureLog = path.join(ROOT_DIR, 'data', `capture-log-${nowISO()}.json`);
  if (!DRY_RUN) {
    fs.writeFileSync(captureLog, JSON.stringify(allResults, null, 2));
    log(`Capture log written to: ${captureLog}`);
  }

  log('');
  log('=== RESULTS SUMMARY ===');

  // Axiom
  const axiomPrices = allResults.axiomPage?.prices || [];
  const axiomApiProducts = allResults.axiomApi?.catalog?.labels || [];
  log(`Axiom Print: ${axiomPrices.length} prices from page [${axiomPrices.join(', ')}], ${axiomApiProducts.length} label products from API`);

  // GotPrint
  const gpPrices = allResults.gotprint?.prices || [];
  const gpApiHits = (allResults.gotprint?.priceAPIResponses || []).length;
  log(`GotPrint: ${gpPrices.length} prices [${gpPrices.join(', ')}], ${gpApiHits} pricing API responses`);

  // Vistaprint
  const vpPrices = allResults.vistaprint?.prices || [];
  log(`Vistaprint: ${vpPrices.length} prices [${vpPrices.join(', ')}]`);

  // Sticker Mule
  const smPrices = allResults.stickermule?.prices || [];
  log(`Sticker Mule: ${smPrices.length} prices [${smPrices.join(', ')}]`);

  // UPrinting
  const upPrices = allResults.uprinting?.prices || [];
  log(`UPrinting: ${upPrices.length} prices [${upPrices.join(', ')}]`);
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e);
  process.exit(1);
});
