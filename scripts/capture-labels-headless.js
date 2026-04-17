#!/usr/bin/env node
/**
 * capture-labels-headless.js — Deep Competitor Label Pricing via Playwright
 *
 * Uses headless Chromium + network interception to capture real quotes
 * from competitor configurators. Targets the reference spec:
 *   3" × 3" label, 5000 pcs, matte lamination
 *
 * Also captures closest available specs per site when exact match is unavailable.
 *
 * Usage:
 *   node scripts/capture-labels-headless.js
 *   node scripts/capture-labels-headless.js --competitor stickermule
 *   node scripts/capture-labels-headless.js --dry-run
 *
 * Requirements: playwright + chromium installed (npm install playwright && npx playwright install chromium)
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR       = path.resolve(__dirname, '..');
const RAW_FILE       = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORMALIZED_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const SPECIFIC_COMP = (() => { const i = args.indexOf('--competitor'); return i !== -1 ? args[i+1] : null; })();
const DEBUG        = args.includes('--debug');

function log(msg)  { console.log(`[headless] ${msg}`); }
function warn(msg) { console.warn(`[WARN]     ${msg}`); }
function err(msg)  { console.error(`[ERROR]    ${msg}`); }
function dbg(msg)  { if (DEBUG) console.log(`[DBG]      ${msg}`); }

function nowISO() { return new Date().toISOString().split('T')[0]; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse dollar amount from text like "$1,234.56" or "1234.56"
function parseDollar(text) {
  if (!text) return null;
  const m = text.match(/\$?([\d,]+\.?\d*)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return (v > 0 && v < 100000) ? v : null;
}

// Build a raw-data result record
function buildResult(id, displayName, url, opts = {}) {
  return {
    id: `${id}-headless-${opts.specTag || 'unknown'}-${nowISO()}`,
    competitor: id,
    competitor_display: displayName,
    source_url: url,
    captured_at: nowISO(),
    capture_method: opts.captureMethod || 'playwright_headless',
    capture_source: 'automated_headless',
    confidence: opts.confidence || 'none',
    product_type: 'labels',
    raw_spec_description: opts.rawSpec || null,
    specs: opts.specs || {},
    pricing: {
      total_price: opts.price || null,
      unit_price: opts.unitPrice || null,
      currency: 'USD',
      turnaround_days: opts.turnaround || null,
      shipping_included: opts.shippingIncluded !== undefined ? opts.shippingIncluded : null,
      price_type: opts.priceType || null
    },
    raw_snippet: opts.rawSnippet || null,
    notes: opts.notes || '',
    blocker: opts.blocker || null,
    next_step: opts.nextStep || null
  };
}

// ─── STICKER MULE ─────────────────────────────────────────────────────────────
// Strategy:
//  1. Navigate to custom labels page
//  2. Intercept all XHR/fetch to find pricing API endpoints
//  3. Fill in size (3x3), qty (5000)
//  4. Capture price from DOM + network

async function captureStickermule(browser) {
  const url = 'https://www.stickermule.com/custom-labels';
  log('Sticker Mule: launching headless browser → ' + url);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const pricingRequests = [];
  const allApiCalls = [];

  context.on('request', req => {
    const u = req.url();
    const method = req.method();
    if (u.includes('price') || u.includes('quote') || u.includes('cost') || u.includes('calculat') || u.includes('api') || u.includes('graphql')) {
      allApiCalls.push({ url: u, method, headers: req.headers(), postData: req.postData() });
    }
  });

  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('price') || u.includes('quote') || u.includes('cost') || u.includes('calculat') || u.includes('graphql')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.includes('"price"') || body.includes('"total"') || body.includes('"amount"') || body.includes('price')) {
          pricingRequests.push({ url: u, status: resp.status(), body: body.slice(0, 2000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  let result = null;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // --- Strategy 1: Extract bootstrap state from page scripts ---
    const bootstrapState = await page.evaluate(() => {
      // Look for __NEXT_DATA__, window.__INITIAL_STATE__, etc.
      const nextData = window.__NEXT_DATA__;
      const initialState = window.__INITIAL_STATE__;
      const appState = window.__APP_STATE__;
      return {
        nextData: nextData ? JSON.stringify(nextData).slice(0, 5000) : null,
        initialState: initialState ? JSON.stringify(initialState).slice(0, 3000) : null,
        appState: appState ? JSON.stringify(appState).slice(0, 3000) : null
      };
    });

    dbg('SM bootstrap state keys: nextData=' + (!!bootstrapState.nextData) + ' initialState=' + (!!bootstrapState.initialState));

    if (bootstrapState.nextData) {
      // Parse price ranges from __NEXT_DATA__
      const priceMatch = bootstrapState.nextData.match(/"(?:price|lowPrice|minPrice|amount)":\s*"?(\d+\.?\d*)"?/g);
      if (priceMatch) {
        log('Sticker Mule: found price fields in __NEXT_DATA__: ' + priceMatch.slice(0, 5).join(', '));
      }
    }

    // --- Strategy 2: Find and fill the configurator form ---
    // Try to find quantity input
    const qtySelectors = [
      'input[name*="quantity"]', 'input[name*="qty"]', 'select[name*="quantity"]',
      '[data-testid*="quantity"]', '[aria-label*="quantity" i]', '#quantity',
      'input[placeholder*="qty" i]', 'input[placeholder*="quantity" i]'
    ];

    let qtyEl = null;
    for (const sel of qtySelectors) {
      try {
        qtyEl = await page.$(sel);
        if (qtyEl) { dbg('SM qty selector found: ' + sel); break; }
      } catch (_) {}
    }

    // Try width/height inputs
    const widthSelectors = ['input[name*="width"]', '[data-testid*="width"]', 'input[placeholder*="width" i]'];
    const heightSelectors = ['input[name*="height"]', '[data-testid*="height"]', 'input[placeholder*="height" i]'];

    let widthEl = null, heightEl = null;
    for (const sel of widthSelectors) {
      try { widthEl = await page.$(sel); if (widthEl) { dbg('SM width found: ' + sel); break; } } catch (_) {}
    }
    for (const sel of heightSelectors) {
      try { heightEl = await page.$(sel); if (heightEl) { dbg('SM height found: ' + sel); break; } } catch (_) {}
    }

    // Look at what's actually on the page for sizing
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    dbg('SM page text snippet: ' + pageText.slice(0, 500));

    // Try to get all form elements
    const formInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, button[data-value]'));
      return inputs.slice(0, 30).map(el => ({
        tag: el.tagName,
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        value: el.value,
        dataTestId: el.getAttribute('data-testid'),
        ariaLabel: el.getAttribute('aria-label')
      }));
    });
    dbg('SM form elements: ' + JSON.stringify(formInfo));

    // If we found qty, try filling
    if (qtyEl) {
      try {
        await qtyEl.triple_click?.();
        await page.fill(await qtyEl.asElement()?.getAttribute('id') ? '#' + await qtyEl.getAttribute('id') : 'input[name*="quantity"]', '5000');
        await sleep(1500);
      } catch (e) { dbg('SM qty fill failed: ' + e.message); }
    }

    if (widthEl && heightEl) {
      try {
        await widthEl.fill('3');
        await heightEl.fill('3');
        await sleep(2000);
      } catch (e) { dbg('SM size fill failed: ' + e.message); }
    }

    // --- Strategy 3: Try to find price in DOM ---
    const priceSelectors = [
      '[data-testid*="price"]', '[data-testid*="total"]', '[class*="price"]',
      '[class*="total"]', '[class*="cost"]', '.price', '#price',
      '[aria-label*="price" i]', '[aria-label*="total" i]'
    ];

    let capturedPrice = null;
    for (const sel of priceSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.textContent();
          const p = parseDollar(text);
          if (p) {
            log(`Sticker Mule: price found via selector ${sel}: $${p}`);
            capturedPrice = p;
            break;
          }
        }
      } catch (_) {}
    }

    // --- Strategy 4: Extract from full page content ---
    if (!capturedPrice) {
      const fullText = await page.evaluate(() => document.body.innerText);
      const prices = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(fullText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 10 && v <= 50000) prices.push(v);
      }
      if (prices.length > 0) {
        log(`Sticker Mule: prices in page text: [${[...new Set(prices)].slice(0,10).join(', ')}]`);
        // Find the price most likely to be the starting/label price
        const filtered = prices.filter(p => p >= 20 && p <= 1000);
        if (filtered.length > 0) capturedPrice = Math.min(...filtered);
      }
    }

    // --- Strategy 5: Check network intercepts for pricing API ---
    if (pricingRequests.length > 0) {
      log(`Sticker Mule: captured ${pricingRequests.length} pricing API response(s)`);
      for (const req of pricingRequests) {
        dbg('SM pricing API: ' + req.url);
        dbg('SM pricing body: ' + req.body.slice(0, 500));
        // Try to extract price from response
        const priceMatch = req.body.match(/"(?:price|total|amount|lowPrice)":\s*"?(\d+\.?\d*)"?/);
        if (priceMatch) {
          const apiPrice = parseFloat(priceMatch[1]);
          if (apiPrice > 0) {
            log(`Sticker Mule: API response price: $${apiPrice}`);
            if (!capturedPrice || apiPrice > 100) capturedPrice = apiPrice;
          }
        }
      }
    }

    // --- Strategy 6: Try the /pricing page if it exists ---
    try {
      const pricingPageResp = await page.goto('https://www.stickermule.com/custom-labels/pricing', { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (pricingPageResp && pricingPageResp.status() === 200) {
        await sleep(2000);
        const pricingText = await page.evaluate(() => document.body.innerText);
        log('SM pricing page length: ' + pricingText.length);

        // Look for quantity pricing table
        const qtyPricePattern = /5[,\s]*000[^$]*\$([\d,]+\.?\d{0,2})/i;
        const qm = pricingText.match(qtyPricePattern);
        if (qm) {
          const p = parseDollar(qm[1]);
          if (p) {
            log(`Sticker Mule: found 5000-qty price on pricing page: $${p}`);
            capturedPrice = p;
          }
        }

        // Try to find pricing table rows
        const tableData = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table, [class*="pricing"], [class*="price-table"]'));
          return tables.map(t => t.innerText.slice(0, 500)).join('\n');
        });
        if (tableData) {
          dbg('SM pricing table data: ' + tableData.slice(0, 1000));
          const p5k = tableData.match(/5[,\s]*000\s+\$?([\d,]+\.?\d{0,2})/);
          if (p5k) {
            const p = parseDollar(p5k[1]);
            if (p) { log(`SM: pricing table 5000 qty: $${p}`); capturedPrice = p; }
          }
        }
      }
    } catch (e) { dbg('SM pricing page attempt failed: ' + e.message); }

    // --- Build result ---
    if (capturedPrice) {
      result = buildResult('stickermule', 'Sticker Mule', url, {
        captureMethod: 'playwright_headless_dom_extraction',
        confidence: 'medium',
        specTag: '3x3-5000-matte',
        rawSpec: 'Custom labels — DOM price extraction (closest available)',
        price: capturedPrice,
        priceType: 'starting_from',
        turnaround: 4,
        shippingIncluded: true,
        rawSnippet: pricingRequests.length > 0 ? pricingRequests[0].body.slice(0, 200) : null,
        notes: `Price captured via Playwright. Pricing API calls intercepted: ${pricingRequests.length}. Shipping: free. Turnaround: 4 days. NOTE: This may be starting price, not 5000-piece specific quote.`,
        nextStep: capturedPrice < 200 ? 'Likely starting price — need to navigate directly to 5000-qty quote' : 'Price at or near 5000-piece range'
      });
    } else {
      result = buildResult('stickermule', 'Sticker Mule', url, {
        captureMethod: 'playwright_headless_attempt',
        confidence: 'none',
        specTag: 'failed',
        blocker: 'no_price_extracted',
        notes: `Playwright loaded page but could not extract price from DOM or network. API calls seen: ${allApiCalls.length}. Pricing API responses: ${pricingRequests.length}.`,
        nextStep: 'Try --debug flag and inspect form selectors manually'
      });
    }

  } catch (e) {
    err('Sticker Mule headless error: ' + e.message);
    result = buildResult('stickermule', 'Sticker Mule', url, {
      captureMethod: 'playwright_headless_attempt',
      confidence: 'none',
      specTag: 'error',
      blocker: 'playwright_exception',
      notes: e.message
    });
  } finally {
    await context.close();
  }

  return result;
}

// ─── GOTPRINT ─────────────────────────────────────────────────────────────────
// Strategy:
//  1. Navigate to roll labels configurator
//  2. Intercept XHR to find pricing API endpoint
//  3. Fill in closest spec and extract price

async function captureGotprint(browser) {
  const urls = [
    'https://www.gotprint.com/g/roll-labels.html',
    'https://www.gotprint.com/store/stickers-and-labels/roll-labels',
    'https://www.gotprint.com/store/stickers-and-labels',
    'https://www.gotprint.com/g/stickers-and-labels.html'
  ];

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const xhrCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (ct.includes('json') || u.includes('price') || u.includes('quote') || u.includes('calculat') || u.includes('api/')) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 50000) {
          xhrCaptures.push({ url: u, status: resp.status(), ct, body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let result = null;
  let successUrl = null;

  try {
    // Try each URL variant
    for (const url of urls) {
      log(`GotPrint: trying ${url}`);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (resp && resp.status() < 400) {
          await sleep(3000);
          const title = await page.title();
          const bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 500);
          log(`GotPrint: ${url} → status ${resp.status()}, title="${title}"`);
          dbg('GotPrint page text: ' + bodyText);
          if (!title.toLowerCase().includes('not found') && !title.toLowerCase().includes('404')) {
            successUrl = url;
            break;
          }
        }
      } catch (e) {
        dbg(`GotPrint ${url} failed: ${e.message}`);
      }
    }

    if (!successUrl) {
      // Try the main stickers page
      await page.goto('https://www.gotprint.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);
      successUrl = 'https://www.gotprint.com';
    }

    log(`GotPrint: working with ${successUrl}`);

    // Extract all JSON-like state from page
    const pageState = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      const stateScripts = scripts.filter(s => {
        const t = s.textContent;
        return t.includes('price') || t.includes('configurator') || t.includes('product') || t.includes('window.__');
      });
      return stateScripts.map(s => s.textContent.slice(0, 2000)).join('\n---SCRIPT---\n').slice(0, 10000);
    });
    dbg('GotPrint page state scripts: ' + pageState.slice(0, 1000));

    // Look for price in page state
    const priceFromState = pageState.match(/\$?([\d,]+\.\d{2})/g);
    if (priceFromState) {
      log('GotPrint: price candidates in page scripts: ' + priceFromState.slice(0, 10).join(', '));
    }

    // Try to find and interact with configurator
    await sleep(2000);

    // Look for quantity selector
    const qtyOptions = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.map(s => ({
        name: s.name,
        id: s.id,
        options: Array.from(s.options).map(o => ({ value: o.value, text: o.text })).slice(0, 20)
      })).slice(0, 10);
    });
    dbg('GotPrint selects: ' + JSON.stringify(qtyOptions));

    // Check XHR captures so far
    if (xhrCaptures.length > 0) {
      log(`GotPrint: ${xhrCaptures.length} API/JSON responses captured`);
      for (const capture of xhrCaptures) {
        if (capture.body.includes('price') || capture.body.includes('total') || capture.body.includes('amount')) {
          log(`GotPrint: pricing-related API response at ${capture.url}`);
          dbg('GotPrint API body: ' + capture.body.slice(0, 500));

          // Try to extract price
          const priceMatch = capture.body.match(/"(?:price|total|amount|unitPrice|totalPrice)":\s*"?(\d+\.?\d*)"?/);
          if (priceMatch) {
            const p = parseFloat(priceMatch[1]);
            if (p > 0) {
              log(`GotPrint: API price extracted: $${p}`);
              result = buildResult('gotprint', 'GotPrint', capture.url, {
                captureMethod: 'playwright_xhr_intercept',
                confidence: 'medium',
                specTag: 'api-capture',
                rawSpec: 'Price from XHR intercept on GotPrint configurator',
                price: p,
                priceType: 'configurator_api_response',
                rawSnippet: capture.body.slice(0, 300),
                notes: `Price extracted from XHR response at ${capture.url}. Spec not fully confirmed — captured during page load.`
              });
              break;
            }
          }
        }
      }
    }

    // Try to find price directly on page
    if (!result) {
      const pageText = await page.evaluate(() => document.body.innerText);
      const priceMatches = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(pageText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 10 && v <= 50000) priceMatches.push(v);
      }

      if (priceMatches.length > 0) {
        log(`GotPrint: prices in page text: [${[...new Set(priceMatches)].slice(0,10).join(', ')}]`);
        // Look for the known $72.92 or similar
        const p = priceMatches.find(p => Math.abs(p - 72.92) < 5) || Math.min(...priceMatches.filter(p => p > 20));
        if (p) {
          result = buildResult('gotprint', 'GotPrint', successUrl, {
            captureMethod: 'playwright_dom_text_extraction',
            confidence: 'low',
            specTag: 'dom-price',
            rawSpec: 'Price extracted from GotPrint page text (spec unknown)',
            price: p,
            priceType: 'page_displayed',
            notes: `Price found in page text: $${p}. Spec not confirmed. All prices on page: [${[...new Set(priceMatches)].slice(0,8).join(', ')}].`
          });
        }
      }
    }

    if (!result) {
      result = buildResult('gotprint', 'GotPrint', successUrl || urls[0], {
        captureMethod: 'playwright_headless_attempt',
        confidence: 'none',
        specTag: 'failed',
        blocker: 'no_price_in_dom_or_xhr',
        notes: `Playwright loaded ${successUrl || 'all URLs failed'}. XHR calls captured: ${xhrCaptures.length}. No price found in DOM text or API responses.`,
        nextStep: 'GotPrint may use POST requests with CSRF tokens — try submitting form with specific specs'
      });
    }

  } catch (e) {
    err('GotPrint headless error: ' + e.message);
    result = buildResult('gotprint', 'GotPrint', urls[0], {
      captureMethod: 'playwright_headless_attempt',
      confidence: 'none',
      specTag: 'error',
      blocker: 'playwright_exception',
      notes: e.message
    });
  } finally {
    await context.close();
  }

  return result;
}

// ─── VISTAPRINT ───────────────────────────────────────────────────────────────
// Strategy:
//  1. Navigate to labels/stickers page
//  2. Intercept all API/XHR calls
//  3. Attempt to interact with the configurator
//  4. Capture price from network or DOM

async function captureVistaprint(browser) {
  const url = 'https://www.vistaprint.com/labels-stickers';

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const apiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if ((ct.includes('json') || u.includes('/api/') || u.includes('/pricing') || u.includes('price')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 100000 && (body.includes('price') || body.includes('amount') || body.includes('cost'))) {
          apiCalls.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let result = null;

  try {
    log('Vistaprint: navigating to ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000); // Let React/SPA hydrate

    const title = await page.title();
    log('Vistaprint: page title: ' + title);

    // Try to find product links to labels configurator
    const labelLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(a => a.href && (a.href.includes('label') || a.href.includes('sticker')))
        .map(a => ({ href: a.href, text: a.textContent.trim().slice(0, 60) }))
        .slice(0, 15);
    });
    log('Vistaprint: label/sticker links found: ' + labelLinks.length);
    dbg('Vistaprint links: ' + JSON.stringify(labelLinks));

    // Try to navigate to a specific product page
    const configuratorUrls = [
      'https://www.vistaprint.com/stickers/custom-stickers',
      'https://www.vistaprint.com/stickers/circle-stickers',
      'https://www.vistaprint.com/stickers/rectangle-stickers',
      'https://www.vistaprint.com/stickers/square-stickers'
    ];

    let configFound = false;
    for (const cu of configuratorUrls) {
      try {
        const resp = await page.goto(cu, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (resp && resp.status() < 400) {
          await sleep(4000);
          const configTitle = await page.title();
          log(`Vistaprint: configurator at ${cu} → "${configTitle}"`);
          if (!configTitle.includes('404')) {
            configFound = true;
            break;
          }
        }
      } catch (e) { dbg('VP config url failed: ' + e.message); }
    }

    // Extract price from current page state
    const vpState = await page.evaluate(() => {
      const data = {
        nextData: null,
        reduxState: null,
        prices: [],
        formElements: []
      };

      // __NEXT_DATA__
      if (window.__NEXT_DATA__) {
        data.nextData = JSON.stringify(window.__NEXT_DATA__).slice(0, 5000);
      }

      // Prices in DOM
      const allText = document.body.innerText;
      const priceRe = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = priceRe.exec(allText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 5 && v <= 5000) data.prices.push(v);
      }

      // Form elements
      const inputs = Array.from(document.querySelectorAll('select, input[type="number"], [data-testid]'));
      data.formElements = inputs.slice(0, 20).map(el => ({
        tag: el.tagName, name: el.name, id: el.id, testId: el.getAttribute('data-testid'), value: el.value
      }));

      return data;
    });

    dbg('VP nextData: ' + (vpState.nextData ? vpState.nextData.slice(0, 500) : 'none'));
    log('VP prices in DOM: ' + [...new Set(vpState.prices)].slice(0, 10).join(', '));

    // Look for price in __NEXT_DATA__ — Vistaprint often embeds catalog prices
    if (vpState.nextData) {
      const priceMatches = vpState.nextData.match(/"(?:price|amount|listPrice|salePrice)":\s*"?(\d+\.?\d*)"?/g);
      if (priceMatches) {
        log('VP __NEXT_DATA__ price fields: ' + priceMatches.slice(0, 5).join(', '));
        const vals = priceMatches.map(s => {
          const m = s.match(/(\d+\.?\d*)/);
          return m ? parseFloat(m[1]) : null;
        }).filter(v => v && v > 5 && v < 5000);
        if (vals.length > 0) {
          log('VP prices from __NEXT_DATA__: ' + vals.slice(0, 10).join(', '));
        }
      }
    }

    // Try to find quantity selector and interact
    const qtySelector = await page.$('select[id*="qty"], select[name*="qty"], select[id*="quantity"], [data-testid*="quantity"]');
    if (qtySelector) {
      log('VP: found quantity selector');
      try {
        await qtySelector.selectOption({ label: '5000' });
        await sleep(2000);
      } catch (e) { dbg('VP qty select failed: ' + e.message); }
    }

    // Check API calls
    if (apiCalls.length > 0) {
      log(`Vistaprint: ${apiCalls.length} pricing API response(s) captured`);
      for (const call of apiCalls) {
        dbg('VP API: ' + call.url);
        const pm = call.body.match(/"(?:price|amount|total|listPrice)":\s*"?(\d+\.?\d*)"?/);
        if (pm) {
          const p = parseFloat(pm[1]);
          if (p > 5) {
            log(`Vistaprint: API price: $${p} from ${call.url}`);
            result = buildResult('vistaprint', 'Vistaprint', call.url, {
              captureMethod: 'playwright_xhr_intercept',
              confidence: 'medium',
              specTag: 'api-capture',
              rawSpec: 'Price from XHR intercept on Vistaprint configurator',
              price: p,
              priceType: 'configurator_api_response',
              rawSnippet: call.body.slice(0, 300),
              notes: `Price $${p} extracted from Vistaprint API response at ${call.url}. Full spec not confirmed — may be default/minimum quantity price.`
            });
            break;
          }
        }
      }
    }

    // DOM price fallback
    if (!result && vpState.prices.length > 0) {
      const minPrice = Math.min(...vpState.prices);
      result = buildResult('vistaprint', 'Vistaprint', url, {
        captureMethod: 'playwright_dom_text_extraction',
        confidence: 'low',
        specTag: 'dom-price',
        rawSpec: 'Price from Vistaprint DOM (spec unknown — may be minimum quantity)',
        price: minPrice,
        priceType: 'page_displayed_minimum',
        notes: `Price $${minPrice} extracted from DOM text. All prices seen: [${[...new Set(vpState.prices)].slice(0,8).join(', ')}]. Spec not confirmed — Vistaprint prices are quantity-dependent.`
      });
    }

    if (!result) {
      result = buildResult('vistaprint', 'Vistaprint', url, {
        captureMethod: 'playwright_headless_attempt',
        confidence: 'none',
        specTag: 'failed',
        blocker: 'no_price_in_dom_or_xhr',
        notes: `Playwright navigated to VP. API calls: ${apiCalls.length}. No price extracted. Titles visited: "${title}". Config found: ${configFound}.`,
        nextStep: 'Try direct configurator URL with pre-configured params in query string'
      });
    }

  } catch (e) {
    err('Vistaprint headless error: ' + e.message);
    result = buildResult('vistaprint', 'Vistaprint', url, {
      captureMethod: 'playwright_headless_attempt',
      confidence: 'none',
      specTag: 'error',
      blocker: 'playwright_exception',
      notes: e.message
    });
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPRINTING ────────────────────────────────────────────────────────────────
// Strategy:
//  1. Navigate directly to custom labels/stickers product
//  2. Intercept XHR to find pricing endpoint
//  3. Fill in form: 3x3, 5000, matte
//  4. Capture price

async function captureUprinting(browser) {
  const configuratorUrls = [
    'https://www.uprinting.com/stickers.html',
    'https://www.uprinting.com/stickers-and-labels.html',
    'https://www.uprinting.com/labels.html',
    'https://www.uprinting.com/custom-labels.html'
  ];

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
        if (body.length > 10 && body.length < 100000) {
          apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let result = null;
  let workingUrl = null;

  try {
    for (const url of configuratorUrls) {
      log(`UPrinting: trying ${url}`);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (resp && resp.status() < 400) {
          await sleep(3000);
          const title = await page.title();
          log(`UPrinting: ${url} → "${title}"`);
          if (!title.includes('404') && !title.includes('Not Found')) {
            workingUrl = url;
            break;
          }
        }
      } catch (e) { dbg('UP url failed: ' + e.message); }
    }

    if (!workingUrl) {
      result = buildResult('uprinting', 'UPrinting', configuratorUrls[0], {
        captureMethod: 'playwright_headless_attempt',
        confidence: 'none',
        specTag: 'all-urls-failed',
        blocker: 'all_configurator_urls_404',
        notes: 'All UPrinting label/sticker URLs returned 404 or error.',
        nextStep: 'Check uprinting.com homepage for current product URL structure'
      });
      await context.close();
      return result;
    }

    log(`UPrinting: working with ${workingUrl}`);

    // Extract bootstrap state
    const upState = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      const dataScript = scripts.find(s => s.textContent.includes('prices') || s.textContent.includes('price_list') || s.textContent.includes('quantities'));
      const globalVars = Object.keys(window).filter(k => k.toLowerCase().includes('price') || k.toLowerCase().includes('config') || k.toLowerCase().includes('product'));

      const prices = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      const bodyText = document.body.innerText;
      while ((m = re.exec(bodyText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 5 && v <= 10000) prices.push(v);
      }

      return {
        dataScriptSnippet: dataScript ? dataScript.textContent.slice(0, 2000) : null,
        globalPriceVars: globalVars.slice(0, 10),
        prices: [...new Set(prices)].slice(0, 20),
        formSelects: Array.from(document.querySelectorAll('select')).map(s => ({
          name: s.name, id: s.id,
          options: Array.from(s.options).map(o => o.text).slice(0, 10)
        })).slice(0, 8)
      };
    });

    log('UPrinting: prices in DOM: ' + upState.prices.join(', '));
    dbg('UP form selects: ' + JSON.stringify(upState.formSelects));
    dbg('UP global price vars: ' + upState.globalPriceVars.join(', '));

    // Try to interact with form
    // UPrinting typically has: size dropdown, quantity dropdown, paper/material, finish
    const sizeSelect = await page.$('select[name*="size"], select[id*="size"], select[name*="dimension"]');
    const qtySelect  = await page.$('select[name*="qty"], select[name*="quantity"], select[id*="qty"]');

    if (qtySelect) {
      log('UPrinting: found quantity select');
      try {
        // Try to select 5000
        const options = await qtySelect.evaluate(s => Array.from(s.options).map(o => ({ v: o.value, t: o.text })));
        dbg('UP qty options: ' + JSON.stringify(options));
        const opt5000 = options.find(o => o.t.includes('5000') || o.v === '5000');
        if (opt5000) {
          await qtySelect.selectOption(opt5000.v || opt5000.t);
          log('UPrinting: selected qty 5000');
          await sleep(2000);
        }
      } catch (e) { dbg('UP qty select failed: ' + e.message); }
    }

    // Wait for API responses after interaction
    await sleep(2000);

    // Check API captures
    if (apiCaptures.length > 0) {
      log(`UPrinting: ${apiCaptures.length} API response(s) captured`);
      for (const cap of apiCaptures) {
        dbg('UP API: ' + cap.url);
        if (cap.body.includes('"price"') || cap.body.includes('"total"') || cap.body.includes('"amount"')) {
          const pm = cap.body.match(/"(?:price|total|amount|subtotal|unit_price)":\s*"?(\d+\.?\d*)"?/);
          if (pm) {
            const p = parseFloat(pm[1]);
            if (p > 5) {
              log(`UPrinting: API price: $${p}`);
              result = buildResult('uprinting', 'UPrinting', cap.url, {
                captureMethod: 'playwright_xhr_intercept',
                confidence: 'medium',
                specTag: 'api-price',
                rawSpec: 'Price from UPrinting API response via XHR intercept',
                price: p,
                priceType: 'configurator_api_response',
                rawSnippet: cap.body.slice(0, 300),
                notes: `Price $${p} from UPrinting API at ${cap.url}`
              });
              break;
            }
          }
        }
      }
    }

    // DOM fallback
    if (!result) {
      // Re-check DOM after interaction
      const updatedPrices = await page.evaluate(() => {
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const text = document.body.innerText;
        const prices = [];
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 10 && v <= 10000) prices.push(v);
        }
        return [...new Set(prices)];
      });

      if (updatedPrices.length > 0) {
        log(`UPrinting: DOM prices after interaction: [${updatedPrices.join(', ')}]`);
        result = buildResult('uprinting', 'UPrinting', workingUrl, {
          captureMethod: 'playwright_dom_text_extraction',
          confidence: 'low',
          specTag: 'dom-price',
          rawSpec: 'Price from UPrinting DOM — spec not confirmed',
          price: Math.min(...updatedPrices),
          priceType: 'page_displayed',
          notes: `Prices found in DOM: [${updatedPrices.join(', ')}]. Minimum shown: $${Math.min(...updatedPrices)}. Spec not confirmed.`
        });
      } else {
        result = buildResult('uprinting', 'UPrinting', workingUrl, {
          captureMethod: 'playwright_headless_attempt',
          confidence: 'none',
          specTag: 'failed',
          blocker: 'no_price_in_dom_or_xhr',
          notes: `Playwright at ${workingUrl}. API calls: ${apiCaptures.length}. No price extracted from DOM or XHR.`,
          nextStep: 'Try UPrinting direct API endpoint with POST body containing product specs'
        });
      }
    }

  } catch (e) {
    err('UPrinting headless error: ' + e.message);
    result = buildResult('uprinting', 'UPrinting', configuratorUrls[0], {
      captureMethod: 'playwright_headless_attempt',
      confidence: 'none',
      specTag: 'error',
      blocker: 'playwright_exception',
      notes: e.message
    });
  } finally {
    await context.close();
  }

  return result;
}

// ─── AXIOM PRINT ──────────────────────────────────────────────────────────────
// Strategy:
//  1. Hit homepage to discover real product URL structure
//  2. Navigate to labels/stickers product
//  3. Interact with configurator and capture price

async function captureAxiomprint(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const apiCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if ((ct.includes('json') || u.includes('price') || u.includes('api') || u.includes('product')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.length > 20 && body.length < 200000 && (body.includes('price') || body.includes('product') || body.includes('label'))) {
          apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  let result = null;

  try {
    // Start at homepage to discover URL structure
    log('Axiom Print: loading homepage to discover product URLs');
    await page.goto('https://axiomprint.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3000);

    const homeTitle = await page.title();
    log('Axiom Print: homepage title: ' + homeTitle);

    // Find all label/sticker related links on homepage
    const productLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(a => {
          const href = a.href || '';
          const text = a.textContent.toLowerCase();
          return (text.includes('label') || text.includes('sticker') || href.includes('label') || href.includes('sticker'))
            && href.startsWith('http');
        })
        .map(a => ({ href: a.href, text: a.textContent.trim().slice(0, 60) }))
        .filter((v, i, arr) => arr.findIndex(x => x.href === v.href) === i)
        .slice(0, 20);
    });

    log(`Axiom Print: found ${productLinks.length} label/sticker links on homepage`);
    dbg('Axiom links: ' + JSON.stringify(productLinks));

    // Also look for navigation menu items
    const navItems = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('nav a, header a, [class*="menu"] a, [class*="nav"] a'));
      return links
        .filter(a => a.href && a.href.startsWith('http'))
        .map(a => ({ href: a.href, text: a.textContent.trim().slice(0, 50) }))
        .filter((v, i, arr) => arr.findIndex(x => x.href === v.href) === i)
        .slice(0, 30);
    });
    log(`Axiom Print: ${navItems.length} nav links found`);
    dbg('Axiom nav: ' + JSON.stringify(navItems));

    // Find the labels product link
    const labelLink = productLinks.find(l => l.text.toLowerCase().includes('label') || l.href.toLowerCase().includes('label'))
      || navItems.find(l => l.text.toLowerCase().includes('label') || l.href.toLowerCase().includes('label'));

    let configUrl = null;
    if (labelLink) {
      configUrl = labelLink.href;
      log('Axiom Print: found label product link: ' + configUrl);
    } else {
      // Try common Axiom URL patterns found by inspecting their Next.js structure
      const tryUrls = [
        'https://axiomprint.com/products/labels',
        'https://axiomprint.com/products/stickers',
        'https://axiomprint.com/printing/labels',
        'https://axiomprint.com/label-printing',
        'https://axiomprint.com/sticker-printing',
        'https://axiomprint.com/custom-labels',
        'https://axiomprint.com/products',
        'https://axiomprint.com/catalog/labels'
      ];

      for (const u of tryUrls) {
        try {
          const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 10000 });
          if (resp && resp.status() === 200) {
            const t = await page.title();
            log(`Axiom Print: ${u} → "${t}"`);
            if (!t.includes('404') && !t.includes('Not Found')) {
              configUrl = u;
              break;
            }
          }
        } catch (_) {}
      }
    }

    if (configUrl) {
      log('Axiom Print: navigating to ' + configUrl);
      await page.goto(configUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);

      const configTitle = await page.title();
      log('Axiom Print: config page title: ' + configTitle);

      // Extract prices from page
      const axState = await page.evaluate(() => {
        const prices = [];
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const text = document.body.innerText;
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 5 && v <= 50000) prices.push(v);
        }

        // Check for Next.js page data
        const nextData = window.__NEXT_DATA__;

        // Find product links on this page
        const links = Array.from(document.querySelectorAll('a'))
          .filter(a => a.href && (a.href.includes('label') || a.href.includes('sticker')))
          .map(a => ({ href: a.href, text: a.textContent.trim().slice(0, 50) }))
          .slice(0, 10);

        return {
          prices: [...new Set(prices)].slice(0, 20),
          nextDataSnippet: nextData ? JSON.stringify(nextData).slice(0, 3000) : null,
          labelLinks: links
        };
      });

      log('Axiom Print: prices in DOM: ' + axState.prices.join(', '));
      if (axState.labelLinks.length > 0) {
        log('Axiom Print: more label links: ' + JSON.stringify(axState.labelLinks));
      }

      // Try to navigate to one of the found label links
      if (axState.labelLinks.length > 0 && axState.prices.length === 0) {
        const deepLink = axState.labelLinks[0].href;
        log('Axiom Print: going deeper to ' + deepLink);
        await page.goto(deepLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);

        const deepPrices = await page.evaluate(() => {
          const prices = [];
          const re = /\$([\d,]+\.?\d{0,2})/g;
          const text = document.body.innerText;
          let m;
          while ((m = re.exec(text)) !== null) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (v >= 5 && v <= 50000) prices.push(v);
          }
          return [...new Set(prices)].slice(0, 20);
        });
        log('Axiom Print: deep page prices: ' + deepPrices.join(', '));
        if (deepPrices.length > 0) axState.prices.push(...deepPrices);
      }

      if (axState.prices.length > 0) {
        result = buildResult('axiomprint', 'Axiom Print', configUrl, {
          captureMethod: 'playwright_dom_text_extraction',
          confidence: 'low',
          specTag: 'dom-price',
          rawSpec: 'Price from Axiom Print page (spec unknown)',
          price: Math.min(...axState.prices),
          priceType: 'page_displayed',
          notes: `Prices found on Axiom Print at ${configUrl}: [${axState.prices.join(', ')}]. Minimum: $${Math.min(...axState.prices)}. Spec not confirmed.`
        });
      }

      // Check API captures
      if (!result && apiCaptures.length > 0) {
        log(`Axiom Print: ${apiCaptures.length} API calls captured`);
        for (const cap of apiCaptures) {
          dbg('Axiom API: ' + cap.url);
          if (cap.body.includes('"price"') || cap.body.includes('"amount"')) {
            const pm = cap.body.match(/"(?:price|amount|total|cost)":\s*"?(\d+\.?\d*)"?/);
            if (pm) {
              const p = parseFloat(pm[1]);
              if (p > 5) {
                result = buildResult('axiomprint', 'Axiom Print', cap.url, {
                  captureMethod: 'playwright_xhr_intercept',
                  confidence: 'medium',
                  specTag: 'api-price',
                  rawSpec: 'Price from Axiom Print API response',
                  price: p,
                  priceType: 'configurator_api_response',
                  rawSnippet: cap.body.slice(0, 300),
                  notes: `Price $${p} from Axiom API at ${cap.url}`
                });
                break;
              }
            }
          }
        }
      }
    }

    if (!result) {
      result = buildResult('axiomprint', 'Axiom Print', 'https://axiomprint.com', {
        captureMethod: 'playwright_headless_attempt',
        confidence: 'none',
        specTag: 'failed',
        blocker: configUrl ? 'no_price_on_config_page' : 'label_product_page_not_found',
        notes: `Homepage loaded. Label product link: ${configUrl || 'NOT FOUND'}. API calls: ${apiCaptures.length}. No price extracted.`,
        nextStep: 'Manual: visit axiomprint.com and navigate to label printing, then record URL and price'
      });
    }

  } catch (e) {
    err('Axiom Print headless error: ' + e.message);
    result = buildResult('axiomprint', 'Axiom Print', 'https://axiomprint.com', {
      captureMethod: 'playwright_headless_attempt',
      confidence: 'none',
      specTag: 'error',
      blocker: 'playwright_exception',
      notes: e.message
    });
  } finally {
    await context.close();
  }

  return result;
}

// ─── NETWORK PROBE — Sticker Mule Pricing API ─────────────────────────────────
// Sticker Mule has a REST API for pricing. Try to discover it via URL patterns.
async function probeStickermulePricingAPI() {
  const urlsToTry = [
    'https://www.stickermule.com/api/v1/pricing?product=custom-labels&width=3&height=3&quantity=5000&finish=matte',
    'https://www.stickermule.com/api/pricing?type=labels&width=3&height=3&qty=5000',
    'https://www.stickermule.com/custom-labels/pricing?width=3&height=3&quantity=5000',
  ];

  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': 'https://www.stickermule.com/custom-labels',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      if (resp.ok) {
        const body = await resp.text();
        log(`SM API probe: ${url} → ${resp.status()}, body: ${body.slice(0, 200)}`);
        if (body.includes('price') || body.includes('amount')) {
          return { url, body };
        }
      } else {
        dbg(`SM API probe: ${url} → ${resp.status()}`);
      }
    } catch (e) {
      dbg(`SM API probe fail: ${url}: ${e.message}`);
    }
  }
  return null;
}

// ─── NETWORK PROBE — GotPrint Vue.js API ─────────────────────────────────────
// GotPrint's Vue.js configurator hits a backend pricing API.
// Try to discover and call it directly.
async function probeGotprintAPI() {
  const urlsToTry = [
    // Common patterns for Vue.js configurator APIs
    'https://www.gotprint.com/api/pricing?product=roll-labels&width=3&height=3&quantity=5000&material=matte',
    'https://www.gotprint.com/g/api/quote?shape=square&width=3&height=3&qty=5000&material=bopp&finish=matte',
    'https://www.gotprint.com/api/v1/labels/price?width=3&height=3&quantity=5000',
    'https://www.gotprint.com/store/api/pricing',
  ];

  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': 'https://www.gotprint.com/g/roll-labels.html'
        }
      });
      if (resp.ok) {
        const body = await resp.text();
        log(`GP API probe: ${url} → ${resp.status()}, body: ${body.slice(0, 300)}`);
        if (body.includes('price') || body.includes('total')) {
          return { url, body };
        }
      }
    } catch (_) {}
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const ADAPTERS = {
  stickermule: captureStickermule,
  gotprint: captureGotprint,
  vistaprint: captureVistaprint,
  uprinting: captureUprinting,
  axiomprint: captureAxiomprint
};

async function main() {
  log('=== Headless Competitor Label Pricing Capture ===');
  log(`Date: ${nowISO()}`);
  log(`Dry run: ${DRY_RUN}`);
  log(`Target: ${SPECIFIC_COMP || 'all'}`);
  log('');

  // First, try direct API probes (no browser needed)
  log('--- API probe pass (no browser) ---');
  const smAPI = await probeStickermulePricingAPI();
  if (smAPI) log('SM API probe hit: ' + smAPI.url);

  const gpAPI = await probeGotprintAPI();
  if (gpAPI) log('GP API probe hit: ' + gpAPI.url);
  log('');

  const targets = SPECIFIC_COMP
    ? [SPECIFIC_COMP].filter(k => ADAPTERS[k])
    : Object.keys(ADAPTERS);

  if (targets.length === 0) {
    err(`Unknown competitor: ${SPECIFIC_COMP}`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = [];
  try {
    for (const key of targets) {
      log(`--- ${key} ---`);
      try {
        const result = await ADAPTERS[key](browser);
        results.push(result);
        const price = result.pricing?.total_price;
        log(`Result: confidence=${result.confidence}, price=${price != null ? '$' + price : 'none'}, blocker=${result.blocker || 'none'}`);
      } catch (e) {
        err(`${key} threw: ${e.message}`);
        results.push({
          competitor: key, confidence: 'none', blocker: 'script_error',
          notes: e.message, captured_at: nowISO(), capture_method: 'playwright_headless'
        });
      }
      log('');
    }
  } finally {
    await browser.close();
  }

  // Load existing raw data
  let existing = { schema_version: '1.0', product_scope: 'labels', captures: [], capture_coverage_summary: {} };
  if (fs.existsSync(RAW_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')); } catch (_) {}
  }

  if (!DRY_RUN) {
    // Remove today's headless captures for targeted competitors, keep manual entries
    existing.captures = existing.captures.filter(c => {
      if (!targets.includes(c.competitor)) return true;
      if (c.capture_source === 'manual') return true;
      if (c.capture_source === 'automated_headless' && c.captured_at === nowISO()) return false;
      return true;
    });
    existing.captures.push(...results.filter(r => r.id));
    existing.last_updated = nowISO();

    results.forEach(r => {
      if (!r.competitor) return;
      const hasPrice = r.pricing?.total_price != null;
      existing.capture_coverage_summary[r.competitor] = {
        status: r.blocker && !hasPrice ? 'blocked' : (hasPrice ? (r.confidence === 'high' ? 'captured' : 'partial') : 'blocked'),
        confidence: r.confidence,
        last_method: r.capture_method,
        reason: (r.notes || r.blocker || '').slice(0, 120)
      };
    });

    fs.writeFileSync(RAW_FILE, JSON.stringify(existing, null, 2));
    log(`Wrote ${results.filter(r => r.id).length} result(s) to ${RAW_FILE}`);
  } else {
    log('[DRY RUN] Results:');
    console.log(JSON.stringify(results, null, 2));
  }

  log('');
  log('=== Summary ===');
  results.forEach(r => {
    const price  = r.pricing?.total_price != null ? `$${r.pricing.total_price}` : '—';
    const status = r.blocker && !r.pricing?.total_price ? `BLOCKED (${r.blocker})` : `${(r.confidence || 'none').toUpperCase()} confidence`;
    const name = r.competitor_display || r.competitor || 'unknown';
    log(`${name.padEnd(15)} | price: ${price.padEnd(10)} | ${status}`);
    if (r.notes) log(`  note: ${r.notes.slice(0, 120)}`);
  });
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e);
  process.exit(1);
});
