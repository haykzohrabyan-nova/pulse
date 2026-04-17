#!/usr/bin/env node
/**
 * capture-deep-targeted.js
 *
 * Targeted deep capture for competitors where we now have real product URLs:
 *
 * AXIOM PRINT:
 *   - product page: axiomprint.com/product/roll-labels-335
 *   - Prices already visible ($112.68 default, $0.45 each)
 *   - Need: interact with configurator to get 3x3 / 5000 / matte price
 *
 * GOTPRINT:
 *   - Vue.js configurator with known REST API: /service/rest/v1/products/
 *   - Need: intercept the actual pricing call after form interaction
 *
 * VISTAPRINT:
 *   - Roll labels URL confirmed: /labels-stickers/roll-labels
 *   - Need: interact with quantity selector and capture price
 *
 * STICKER MULE:
 *   - Dismiss cookie consent, then interact with configurator
 *   - Also check /pricing page for quantity table
 *
 * UPRINTING:
 *   - Need to find working product-level URL (not category page)
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const RAW_FILE  = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const LOG_FILE  = path.join(ROOT_DIR, 'data', `capture-deep-${new Date().toISOString().split('T')[0]}.json`);

function log(msg)  { console.log(`[deep] ${msg}`); }
function dbg(msg)  { console.log(`[dbg]  ${msg}`); }
function err(msg)  { console.error(`[ERR]  ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseDollar(text) {
  if (!text) return null;
  const m = String(text).match(/([\d,]+\.?\d*)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return (v > 0 && v < 500000) ? v : null;
}

function extractPrices(text) {
  const re = /\$([\d,]+\.?\d{0,2})/g;
  const prices = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseDollar(m[1]);
    if (v && v >= 1 && v <= 100000) prices.push(v);
  }
  return [...new Set(prices)];
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ─── AXIOM PRINT — Full Configurator Interaction ─────────────────────────────
async function captureAxiom(browser) {
  log('AXIOM: starting targeted product page capture');
  const result = { competitor: 'axiomprint', prices: [], apiCalls: [], configState: null, specData: null, error: null };

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Intercept all API calls to workroomapp.com and axiomprint
  const apiLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('workroomapp.com') || u.includes('axiomprint.com/api')) {
      try {
        const body = await resp.text();
        apiLog.push({ url: u, status: resp.status(), body });
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    await page.goto('https://axiomprint.com/product/roll-labels-335', { waitUntil: 'networkidle', timeout: 35000 });
    await sleep(4000);

    // Extract __NEXT_DATA__ without truncation
    const nextDataRaw = await page.evaluate(() => {
      if (window.__NEXT_DATA__) return JSON.stringify(window.__NEXT_DATA__);
      return null;
    });

    if (nextDataRaw) {
      try {
        const nextData = JSON.parse(nextDataRaw);
        result.specData = nextData;
        dbg('Axiom __NEXT_DATA__ keys: ' + Object.keys(nextData?.props?.pageProps || {}).join(', '));

        // Extract product options from pageProps
        const pageProps = nextData?.props?.pageProps;
        if (pageProps) {
          const productData = pageProps.data || pageProps.product || {};
          log('Axiom product title: ' + productData.title);

          // Look for size options, material options, qty options
          const optionFields = ['options', 'sizes', 'materials', 'quantities', 'finishes', 'attributes', 'variants'];
          optionFields.forEach(f => {
            if (productData[f]) {
              log(`Axiom product.${f}: ${JSON.stringify(productData[f]).slice(0, 300)}`);
            }
          });

          // Also check for pricing info
          const pricingFields = ['pricing', 'price', 'prices', 'basePrice', 'tiers'];
          pricingFields.forEach(f => {
            if (productData[f]) {
              log(`Axiom product.${f}: ${JSON.stringify(productData[f]).slice(0, 300)}`);
            }
          });

          // Log all keys in productData
          log('Axiom productData keys: ' + Object.keys(productData).join(', '));
        }
      } catch (e) { dbg('Axiom nextData parse: ' + e.message); }
    }

    // Get current visible prices
    const pageText = await page.evaluate(() => document.body.innerText);
    result.prices = extractPrices(pageText);
    log('Axiom initial prices: ' + result.prices.join(', '));

    // Find the configurator form elements
    const formInfo = await page.evaluate(() => {
      // Look for all interactive elements in the product configurator
      const allEls = Array.from(document.querySelectorAll('select, input, button[data-value], [role="option"], [role="listbox"], [class*="option"], [class*="select"], [class*="dropdown"]'));
      return allEls.slice(0, 40).map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        class: el.className?.slice(0, 60),
        name: el.name,
        id: el.id,
        type: el.type,
        value: el.value,
        text: el.textContent?.trim().slice(0, 50),
        dataAttr: JSON.stringify(el.dataset || {}).slice(0, 100)
      }));
    });

    log(`Axiom: ${formInfo.length} interactive elements`);
    formInfo.forEach(el => {
      if (el.text || el.value) {
        log(`  <${el.tag} class="${el.class?.split(' ')[0]}" name="${el.name}" id="${el.id}"> text="${el.text}" val="${el.value}"`);
      }
    });

    // Look specifically for size and quantity controls
    // Axiom often uses custom dropdown components (not native selects)
    const priceContainerText = await page.evaluate(() => {
      const priceEl = document.querySelector('[class*="priceContainer"], [class*="ProductInfo_price"], [class*="price"]');
      return priceEl ? priceEl.textContent : null;
    });
    log('Axiom price container text: ' + priceContainerText);

    // Try to find the configurator options by class patterns specific to their Next.js/Workroom app
    const workroomConfig = await page.evaluate(() => {
      // Workroom apps often use React state stored in fiber
      const configEls = Array.from(document.querySelectorAll('[class*="ConfiguratorOption"], [class*="ProductOption"], [class*="Option_"], [class*="option_"]'));
      return configEls.slice(0, 20).map(el => ({
        class: el.className?.slice(0, 80),
        text: el.textContent?.trim().slice(0, 100),
        onclick: el.onclick ? 'has onclick' : null,
        dataAttr: JSON.stringify(Object.fromEntries(Object.entries(el.dataset || {}).slice(0, 5)))
      }));
    });

    log(`Axiom workroom config elements: ${workroomConfig.length}`);
    workroomConfig.forEach(el => log(`  [${el.class?.split(' ')[0]}]: "${el.text}"`));

    // Try to get the Workroom API calls for this product
    await sleep(2000);

    // Check what API calls were made on page load
    log(`Axiom: ${apiLog.length} workroom API calls so far`);
    apiLog.forEach(call => {
      log(`  ${call.status} ${call.url}`);
      if (call.body.length < 2000) dbg(`    body: ${call.body.slice(0, 500)}`);
    });

    // Try to intercept the price calculation API by clicking on size options
    // Look for size option buttons
    const sizeButtons = await page.$$('[class*="size"], [data-size], button[data-value], [class*="Size"]');
    log(`Axiom: ${sizeButtons.length} potential size buttons`);

    // Try clicking elements to trigger price updates
    const clickableOptions = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, [role="button"], [class*="option"], [class*="Option"]'))
        .filter(el => {
          const text = el.textContent?.trim().toLowerCase();
          return text && (text.includes('x') || /\d+"\s*x\s*\d+/.test(text) || text.includes('3') || text.includes('matte') || text.includes('square'));
        });
      return els.slice(0, 10).map(el => ({
        tag: el.tagName, class: el.className?.slice(0,60), text: el.textContent?.trim().slice(0,50)
      }));
    });

    log('Axiom: clickable options with size/spec text: ' + JSON.stringify(clickableOptions));

    // Get full page screenshot data via text extraction
    const fullPageText = await page.evaluate(() => document.body.innerText);
    log('Axiom full page text sample: ' + fullPageText.slice(0, 1000));

    // Look for quantity in page text
    const qtyContext = fullPageText.match(/(?:qty|quantity|pieces?|pcs)[^\n]*\n?[^\n]*/gi);
    if (qtyContext) {
      log('Axiom qty-related text: ' + qtyContext.slice(0, 5).join(' | '));
    }

    // Look for size in page text
    const sizeContext = fullPageText.match(/\d+["']?\s*[x×]\s*\d+["']?/g);
    if (sizeContext) {
      log('Axiom size references: ' + sizeContext.slice(0, 10).join(', '));
    }

    // Look for material/finish in page text
    if (fullPageText.toLowerCase().includes('matte')) {
      const matteIdx = fullPageText.toLowerCase().indexOf('matte');
      log('Axiom matte context: ' + fullPageText.slice(Math.max(0, matteIdx-50), matteIdx+100));
    }

    // Now get the workroomapp API URL for this specific product's pricing
    // Hit the API that the Axiom product page uses to calculate price
    const workroomProductId = 335; // from URL
    const workroomApiTests = [
      `https://website.workroomapp.com/api/v1/products/${workroomProductId}`,
      `https://website.workroomapp.com/api/v1/products/${workroomProductId}/price`,
      `https://website.workroomapp.com/api/v1/products/${workroomProductId}/pricing`,
      `https://website.workroomapp.com/api/v1/quote?productId=${workroomProductId}&qty=5000`,
    ];

    for (const apiUrl of workroomApiTests) {
      try {
        const resp = await page.evaluate(async (url) => {
          const r = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Referer': 'https://axiomprint.com/product/roll-labels-335' }
          });
          const text = await r.text();
          return { status: r.status, body: text.slice(0, 2000) };
        }, apiUrl);
        log(`Axiom Workroom API: ${apiUrl.split('/').slice(-2).join('/')} → ${resp.status}`);
        if (resp.status === 200) {
          log(`  RESPONSE: ${resp.body.slice(0, 400)}`);
        }
      } catch (e) { dbg('Axiom workroom test: ' + e.message); }
    }

    // Try to trigger a price calculation by interacting with the page
    // Look for any quantity input fields
    const qtyInputs = await page.$$('input[type="number"], input[placeholder*="qty" i], input[placeholder*="quantity" i], input[name*="qty"], input[name*="quantity"]');
    log(`Axiom: ${qtyInputs.length} quantity inputs`);

    if (qtyInputs.length > 0) {
      for (const input of qtyInputs) {
        try {
          const placeholder = await input.getAttribute('placeholder');
          const name = await input.getAttribute('name');
          log(`Axiom: qty input name="${name}" placeholder="${placeholder}"`);
          await input.triple_click?.();
          await input.fill('5000');
          log('Axiom: filled qty=5000');
          await sleep(3000);

          // Re-read prices
          const newText = await page.evaluate(() => document.body.innerText);
          const newPrices = extractPrices(newText);
          log('Axiom prices after qty=5000: ' + newPrices.join(', '));
          if (newPrices.length > 0) result.prices = newPrices;
        } catch (e) { dbg('Axiom qty input: ' + e.message); }
        break;
      }
    }

    // Store all API calls captured
    result.apiCalls = apiLog.map(c => ({ url: c.url, status: c.status, body: c.body.slice(0, 500) }));

  } catch (e) {
    result.error = e.message;
    err('Axiom: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── GOTPRINT — Deeper Configurator Interaction ───────────────────────────────
async function captureGotprint(browser) {
  log('GOTPRINT: targeting roll labels configurator with full interaction');
  const result = { competitor: 'gotprint', prices: [], apiCalls: [], configState: null, error: null };

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiLog = [];
  context.on('request', req => {
    const u = req.url();
    if (u.includes('/service/rest/') || u.includes('gotprint.com/api')) {
      apiLog.push({ url: u, method: req.method(), postData: req.postData() });
    }
  });

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('/service/rest/') || u.includes('gotprint.com/api') || u.includes('/price') || u.includes('quantities')) {
      try {
        const body = await resp.text();
        apiLog.push({ url: u, status: resp.status(), body: body.slice(0, 5000), type: 'response' });
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    // Try the roll-labels product page
    const urls = [
      'https://www.gotprint.com/g/roll-labels.html',
      'https://www.gotprint.com/store/stickers-and-labels/roll-labels',
    ];

    let loaded = false;
    for (const url of urls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        if (resp && resp.status() < 400) {
          const title = await page.title();
          log(`GP: ${url} → "${title}" (${resp.status()})`);
          if (!title.includes('404') && title.length > 5) { loaded = true; break; }
        }
      } catch (e) { dbg('GP: ' + e.message); }
    }

    if (!loaded) {
      // Try category with product click
      await page.goto('https://www.gotprint.com/store/stickers-and-labels', { waitUntil: 'networkidle', timeout: 25000 });
      await sleep(3000);

      const rollLink = await page.$('a:has-text("Roll Label"), a[href*="roll-label"]');
      if (rollLink) {
        await rollLink.click();
        await sleep(5000);
        loaded = true;
        log('GP: navigated to roll labels via category link');
      }
    }

    await sleep(3000);

    // Get full page state including Vue.js component data
    const vueState = await page.evaluate(() => {
      const state = {
        selects: [],
        vueInstances: [],
        pageText: document.body.innerText.slice(0, 3000)
      };

      // Standard selects
      state.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 25)
      }));

      // Look for Vue app instance
      const vueApp = document.querySelector('[id$="app"], [class*="v-app"], #vue-app, #app');
      if (vueApp && vueApp.__vue__) {
        try {
          state.vueInstances.push({
            data: JSON.stringify(vueApp.__vue__.$data || {}).slice(0, 2000)
          });
        } catch (_) {}
      }

      // All Vue components on page
      const vueEls = Array.from(document.querySelectorAll('*')).filter(el => el.__vue__);
      state.vueInstances.push(...vueEls.slice(0, 5).map(el => {
        try {
          return { component: el.tagName, data: JSON.stringify(el.__vue__?.$data || {}).slice(0, 500) };
        } catch (_) { return null; }
      }).filter(Boolean));

      return state;
    });

    log(`GP: ${vueState.selects.length} selects`);
    vueState.selects.forEach(s => {
      log(`  Select "${s.name||s.id}" val="${s.value}": [${s.options.map(o=>o.t).join(' | ').slice(0,120)}]`);
    });

    if (vueState.vueInstances.length > 0) {
      log(`GP: ${vueState.vueInstances.length} Vue instances found`);
      vueState.vueInstances.forEach((vi, i) => log(`  Vue[${i}] ${vi.component||''}: ${vi.data?.slice(0,300)}`));
    }

    result.prices = extractPrices(vueState.pageText);
    log('GP initial page prices: ' + result.prices.join(', '));
    log('GP page text: ' + vueState.pageText.slice(0, 500));

    // Interact with the form
    // GotPrint's roll labels configurator has: shape, size, paper/material, quantity
    // Try to click/select options to trigger the pricing API

    // Step 1: Select shape (Square)
    const shapeSelectors = ['select[name*="shape"], [data-label="Shape"], label:has-text("Shape") + select'];
    for (const sel of shapeSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.selectOption({ label: /square/i });
          log('GP: selected Square shape');
          await sleep(2000);
          break;
        }
      } catch (_) {}
    }

    // Step 2: Try setting size
    // GotPrint has size options like "3 x 3" or custom size inputs
    const widthInput = await page.$('input[name*="width"], input[placeholder*="width" i]');
    const heightInput = await page.$('input[name*="height"], input[placeholder*="height" i]');
    if (widthInput && heightInput) {
      await widthInput.fill('3');
      await heightInput.fill('3');
      log('GP: set size 3x3');
      await sleep(2000);
    }

    // Step 3: Set quantity
    for (const sel of vueState.selects) {
      if ((sel.name || sel.id || '').toLowerCase().includes('qty') || (sel.name || sel.id || '').toLowerCase().includes('quantity')) {
        const opt5k = sel.options.find(o => o.t.includes('5000') || o.t.includes('5,000') || o.v === '5000');
        if (opt5k) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          await page.selectOption(selector, opt5k.v);
          log(`GP: selected qty 5000`);
          await sleep(4000); // Wait for API call
          break;
        } else {
          // Log available quantities
          log(`GP: qty options available: [${sel.options.map(o=>o.t).join(', ')}]`);
        }
      }
    }

    // Wait and collect API responses
    await sleep(3000);

    // Check captured API calls
    const apiResponses = apiLog.filter(l => l.type === 'response');
    log(`GP: ${apiLog.length} total API interactions, ${apiResponses.length} responses`);
    apiLog.filter(l => !l.type).forEach(req => log(`  REQ ${req.method} ${req.url}`));
    apiResponses.forEach(resp => {
      log(`  RESP ${resp.status} ${resp.url}`);
      if (resp.body && resp.body.length > 5 && resp.body.length < 5000) {
        dbg(`    body: ${resp.body.slice(0, 500)}`);
      }
    });

    // Re-read prices
    const updatedText = await page.evaluate(() => document.body.innerText);
    const updatedPrices = extractPrices(updatedText);
    log('GP prices after interaction: ' + updatedPrices.join(', '));
    if (updatedPrices.length > 0) result.prices = updatedPrices;

    // Try to call the pricing API directly using the params we know
    // From the JS: /service/rest/v1/products/quantities?productType=X&size=X&paper=X
    const directApiAttempts = [
      '/service/rest/v1/products/price?productType=ROLL_LABELS&size=3x3&paper=BOPP&qty=5000&shape=SQUARE',
      '/service/rest/v1/products/price?productType=ROLL_LABELS&size=3x3&qty=5000',
      '/service/rest/v1/products/quantities?productType=ROLL_LABELS&size=3x3&paper=BOPP&shape=SQUARE',
    ];

    for (const apiPath of directApiAttempts) {
      try {
        const resp = await page.evaluate(async (path) => {
          const r = await fetch(path, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          return { status: r.status, body: (await r.text()).slice(0, 1000) };
        }, apiPath);
        log(`GP direct API: ${apiPath.split('?')[0].split('/').pop()} → ${resp.status}: ${resp.body.slice(0, 200)}`);
      } catch (_) {}
    }

    result.apiCalls = apiLog.map(l => ({ url: l.url, method: l.method, status: l.status, body: l.body?.slice(0, 300) }));

  } catch (e) {
    result.error = e.message;
    err('GotPrint: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── VISTAPRINT — Roll Labels Configurator ────────────────────────────────────
async function captureVistaprint(browser) {
  log('VISTAPRINT: targeting roll labels configurator');
  const result = { competitor: 'vistaprint', prices: [], apiCalls: [], error: null };

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (ct.includes('json') && !u.includes('analytics') && !u.includes('doubleclick') && !u.includes('google')) {
      try {
        const body = await resp.text();
        if (body.length > 20 && body.length < 500000) {
          apiLog.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(6000); // Give React more time to hydrate

    const title = await page.title();
    log('VP roll labels title: ' + title);

    const pageText = await page.evaluate(() => document.body.innerText);
    result.prices = extractPrices(pageText);
    log('VP initial prices: ' + result.prices.join(', '));
    log('VP page text sample: ' + pageText.slice(0, 600));

    // Get full DOM state
    const domState = await page.evaluate(() => {
      return {
        selects: Array.from(document.querySelectorAll('select')).map(s => ({
          name: s.name, id: s.id, value: s.value,
          options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
        })),
        inputsWithValues: Array.from(document.querySelectorAll('input')).map(i => ({
          name: i.name, id: i.id, type: i.type, value: i.value,
          testId: i.getAttribute('data-testid'),
          ariaLabel: i.getAttribute('aria-label')
        })).slice(0, 20),
        priceElements: Array.from(document.querySelectorAll('[class*="price"], [class*="Price"], [data-testid*="price"]'))
          .map(el => ({ class: el.className?.slice(0,60), text: el.textContent?.trim().slice(0,80) }))
          .filter(el => el.text.length > 0),
        configElements: Array.from(document.querySelectorAll('[class*="config"], [class*="Config"], [class*="option"], [class*="Option"]'))
          .map(el => ({ class: el.className?.slice(0,60), text: el.textContent?.trim().slice(0,60) }))
          .filter(el => el.text.length > 0)
          .slice(0, 15)
      };
    });

    log(`VP: ${domState.selects.length} selects, ${domState.inputsWithValues.length} inputs, ${domState.priceElements.length} price elements`);
    domState.selects.forEach(s => log(`  Select "${s.name||s.id}": [${s.options.slice(0,8).map(o=>o.t).join(' | ')}]`));
    domState.priceElements.forEach(el => log(`  Price: "${el.text}"`));
    domState.configElements.forEach(el => log(`  Config: "${el.text}"`));

    // Check API captures
    const relevantApis = apiLog.filter(c => !c.url.includes('i18n') && !c.url.includes('locale'));
    log(`VP: ${relevantApis.length} relevant API responses`);
    for (const cap of relevantApis) {
      log(`  ${cap.status} ${cap.url}`);
      if (cap.body.includes('"price"') || cap.body.includes('"amount"') || cap.body.includes('"quantity"')) {
        log(`  *** PRICING DATA ***`);
        log(`  body: ${cap.body.slice(0, 600)}`);

        // Extract price
        const priceMatch = cap.body.match(/"(?:price|amount|total|listPrice|salePrice)":\s*"?(\d+\.?\d*)"?/);
        if (priceMatch) {
          log(`  Extracted price: $${priceMatch[1]}`);
        }
      }
    }

    // Try to interact with quantity selector
    if (domState.selects.length > 0) {
      for (const sel of domState.selects) {
        const opt = sel.options.find(o => o.t.includes('5000') || o.t.includes('5,000'));
        if (opt) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          try {
            await page.selectOption(selector, opt.v);
            log(`VP: selected qty 5000`);
            await sleep(5000);
            const newText = await page.evaluate(() => document.body.innerText);
            const newPrices = extractPrices(newText);
            log('VP prices after qty=5000: ' + newPrices.join(', '));
            if (newPrices.length > 0) result.prices = newPrices;
          } catch (e) { dbg('VP qty: ' + e.message); }
          break;
        }
      }
    }

    // Try Vistaprint's internal pricing API patterns
    // VP sometimes uses a pricing endpoint with product + option codes
    const vpApiAttempts = [
      'https://www.vistaprint.com/api/pricing/roll-labels?quantity=5000',
      'https://www.vistaprint.com/api/v1/products/roll-labels/pricing?qty=5000',
    ];

    for (const apiUrl of vpApiAttempts) {
      try {
        const resp = await page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          return { status: r.status, body: (await r.text()).slice(0, 500) };
        }, apiUrl);
        log(`VP API test: ${apiUrl} → ${resp.status}: ${resp.body.slice(0, 200)}`);
      } catch (_) {}
    }

    result.apiCalls = relevantApis.map(c => ({ url: c.url, status: c.status, bodySnippet: c.body.slice(0, 300) }));

  } catch (e) {
    result.error = e.message;
    err('Vistaprint: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── STICKER MULE — Sizing Page ───────────────────────────────────────────────
async function captureStickermule(browser) {
  log('STICKER MULE: targeting sizes/pricing pages');
  const result = { competitor: 'stickermule', prices: [], pricingTable: null, apiCalls: [], error: null };

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('api') || u.includes('price') || u.includes('quote') || u.includes('graphql') || u.includes('stickermule.com')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 500000 && (body.includes('price') || body.includes('amount') || body.includes('total') || body.includes('quote') || body.includes('quantity'))) {
          apiLog.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    // Start at the custom labels page
    await page.goto('https://www.stickermule.com/custom-labels', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Dismiss consent modal
    try {
      await page.click('button:text-matches("Agree|Accept|OK|Got it", "i")', { timeout: 5000 });
      log('SM: dismissed consent');
      await sleep(2000);
    } catch (_) {}

    // Get page text
    const text1 = await page.evaluate(() => document.body.innerText);
    log('SM custom-labels text sample: ' + text1.slice(0, 500));
    result.prices.push(...extractPrices(text1).filter(p => p >= 20));

    // Look for pricing table or qty selector
    const domState = await page.evaluate(() => {
      return {
        selects: Array.from(document.querySelectorAll('select')).map(s => ({
          name: s.name, id: s.id,
          options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 25)
        })),
        priceEls: Array.from(document.querySelectorAll('[class*="price"], [data-testid*="price"]'))
          .map(el => el.textContent?.trim().slice(0, 80)).filter(t => t),
        tables: Array.from(document.querySelectorAll('table')).map(t => t.innerText?.slice(0, 500))
      };
    });

    log(`SM: ${domState.selects.length} selects, ${domState.priceEls.length} price elements`);
    domState.selects.forEach(s => log(`  Select "${s.name||s.id}": [${s.options.map(o=>o.t).join(' | ').slice(0,120)}]`));
    domState.priceEls.forEach(el => log(`  Price: "${el}"`));

    // Try to click on a size like 3x3
    try {
      const size3x3 = await page.$('button:text-matches("3.*3|3x3|3 x 3", "i"), [data-size="3x3"]');
      if (size3x3) {
        await size3x3.click();
        log('SM: clicked 3x3 size option');
        await sleep(2000);
      }
    } catch (_) {}

    // Try qty dropdown interaction
    for (const sel of domState.selects) {
      const opt5k = sel.options.find(o => o.t.includes('5,000') || o.t.includes('5000') || o.v === '5000');
      if (opt5k) {
        const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
        try {
          await page.selectOption(selector, opt5k.v);
          log('SM: selected qty 5000');
          await sleep(3000);
          const newText = await page.evaluate(() => document.body.innerText);
          const newPrices = extractPrices(newText).filter(p => p >= 20);
          log('SM prices after qty=5000: ' + newPrices.join(', '));
          if (newPrices.length > 0) result.prices.push(...newPrices);
        } catch (e) { dbg('SM qty: ' + e.message); }
        break;
      }
    }

    // Try the static /pricing page
    try {
      const pResp = await page.goto('https://www.stickermule.com/custom-labels/pricing', { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (pResp && pResp.status() < 400) {
        await sleep(3000);
        const pText = await page.evaluate(() => document.body.innerText);
        log('SM /pricing page text: ' + pText.slice(0, 600));
        const pPrices = extractPrices(pText).filter(p => p >= 20);
        log('SM /pricing prices: ' + pPrices.join(', '));
        if (pText.includes('5,000') || pText.includes('5000')) {
          const idx = pText.search(/5[,\s]?000/);
          log('SM 5000-qty context: ' + pText.slice(Math.max(0, idx-50), idx+200));
        }
        result.prices.push(...pPrices);
        result.pricingTable = pText.slice(0, 3000);
      }
    } catch (e) { dbg('SM pricing page: ' + e.message); }

    // Try fetching sizes JSON
    try {
      const sizesResp = await page.evaluate(async () => {
        const endpoints = [
          '/api/v1/products/custom-labels/pricing',
          '/api/pricing?product=custom-labels',
          '/custom-labels/sizes.json',
        ];
        const results = [];
        for (const ep of endpoints) {
          try {
            const r = await fetch(ep, { credentials: 'include', headers: { Accept: 'application/json' } });
            const body = await r.text();
            results.push({ ep, status: r.status, body: body.slice(0, 500) });
          } catch (e) { results.push({ ep, error: e.message }); }
        }
        return results;
      });
      sizesResp.forEach(r => {
        log(`SM endpoint ${r.ep}: status=${r.status || r.error} body=${r.body?.slice(0,200)}`);
      });
    } catch (_) {}

    log(`SM: ${apiLog.length} API responses with price data`);
    apiLog.forEach(c => {
      log(`  ${c.status} ${c.url}`);
      if (c.body) dbg(`    body: ${c.body.slice(0, 300)}`);
    });

    result.prices = [...new Set(result.prices)];
    result.apiCalls = apiLog.map(c => ({ url: c.url, status: c.status, bodySnippet: c.body?.slice(0, 300) }));

  } catch (e) {
    result.error = e.message;
    err('SM: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPRINTING — Targeted Product Page ───────────────────────────────────────
async function captureUprinting(browser) {
  log('UPRINTING: targeting product configurator pages');
  const result = { competitor: 'uprinting', prices: [], apiCalls: [], configState: null, error: null };

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if ((ct.includes('json') || u.includes('price') || u.includes('quote') || u.includes('api')) && resp.status() < 400 && !u.includes('google') && !u.includes('double') && !u.includes('pinterest')) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 500000) {
          apiLog.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    // Try to find a product-level URL that has the configurator
    // UPrinting product configurators are usually at /product-name.html
    const productUrls = [
      'https://www.uprinting.com/custom-stickers-squares.html',
      'https://www.uprinting.com/custom-labels-squares.html',
      'https://www.uprinting.com/roll-labels.html',
      'https://www.uprinting.com/stickers-custom.html',
      'https://www.uprinting.com/labels-square-stickers.html',
      'https://www.uprinting.com/custom-square-stickers.html',
      'https://www.uprinting.com/stickers-squares.html',
    ];

    let workingUrl = null;
    for (const url of productUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp && resp.status() < 400) {
          const title = await page.title();
          log(`UP: ${url} → "${title}" (${resp.status()})`);
          if (!title.includes('404')) { workingUrl = url; break; }
        }
      } catch (e) { dbg('UP: ' + e.message); }
    }

    if (!workingUrl) {
      // Navigate to stickers category and find a product
      await page.goto('https://www.uprinting.com/stickers-and-labels.html', { waitUntil: 'networkidle', timeout: 25000 });
      await sleep(4000);

      // Find product links in the listing
      const productLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*=".html"]'));
        return links
          .filter(a => {
            const text = a.textContent?.toLowerCase();
            return text?.includes('sticker') || text?.includes('label') || a.href.includes('sticker') || a.href.includes('label');
          })
          .map(a => ({ href: a.href, text: a.textContent?.trim().slice(0, 50) }))
          .filter((v, i, arr) => arr.findIndex(x => x.href === v.href) === i)
          .slice(0, 10);
      });

      log(`UP category: found ${productLinks.length} product links`);
      productLinks.forEach(l => log(`  ${l.href} — "${l.text}"`));

      if (productLinks.length > 0) {
        const squareLink = productLinks.find(l => l.text.toLowerCase().includes('square') || l.href.includes('square')) || productLinks[0];
        workingUrl = squareLink.href;
        await page.goto(workingUrl, { waitUntil: 'networkidle', timeout: 25000 });
        await sleep(4000);
        log(`UP: navigated to ${workingUrl}`);
      }
    } else {
      await sleep(5000); // Wait for configurator to load
    }

    if (!workingUrl) {
      result.error = 'no product URL found';
      return result;
    }

    log(`UP: working with ${workingUrl}`);

    // Extract page state
    const upState = await page.evaluate(() => {
      return {
        title: document.title,
        selects: Array.from(document.querySelectorAll('select')).map(s => ({
          name: s.name, id: s.id, value: s.value,
          options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 25)
        })),
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({
          name: i.name, id: i.id, type: i.type, value: i.value, placeholder: i.placeholder
        })).filter(i => i.name || i.id).slice(0, 20),
        priceEls: Array.from(document.querySelectorAll('[id*="price"], [class*="price"], [data-price]'))
          .map(el => ({ id: el.id, class: el.className?.slice(0,60), text: el.textContent?.trim().slice(0,80) }))
          .filter(el => el.text.length > 0),
        pageText: document.body.innerText.slice(0, 3000)
      };
    });

    log(`UP: title="${upState.title}"`);
    log(`UP: ${upState.selects.length} selects, ${upState.inputs.length} inputs, ${upState.priceEls.length} price elements`);
    upState.selects.forEach(s => log(`  Select "${s.name||s.id}" val="${s.value}": [${s.options.map(o=>o.t).join(' | ').slice(0,130)}]`));
    upState.priceEls.forEach(el => log(`  Price el "${el.id||el.class?.split(' ')[0]}": "${el.text}"`));
    log('UP page text: ' + upState.pageText.slice(0, 500));

    result.prices = extractPrices(upState.pageText).filter(p => p >= 5);
    log('UP initial prices: ' + result.prices.join(', '));

    // Interact with form
    let interacted = false;
    for (const sel of upState.selects) {
      const name = (sel.name || sel.id || '').toLowerCase();
      if (name.includes('qty') || name.includes('quantity')) {
        const opt5k = sel.options.find(o => o.t.includes('5,000') || o.t.includes('5000') || o.v === '5000');
        if (opt5k) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          try {
            await page.selectOption(selector, opt5k.v);
            log('UP: selected qty 5000');
            interacted = true;
            await sleep(5000);
          } catch (e) { dbg('UP qty: ' + e.message); }
        } else {
          // Select max qty available
          const lastOpt = sel.options[sel.options.length - 1];
          if (lastOpt) {
            log(`UP: max qty available: ${lastOpt.t}`);
          }
        }
        break;
      }
    }

    if (interacted) {
      const newText = await page.evaluate(() => document.body.innerText);
      const newPrices = extractPrices(newText).filter(p => p >= 5);
      log('UP prices after interaction: ' + newPrices.join(', '));
      result.prices = newPrices;

      // Re-check price elements
      const updatedPriceEls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[id*="price"], [class*="price"]'))
          .map(el => el.textContent?.trim().slice(0, 80))
          .filter(t => t && t.includes('$'));
      });
      log('UP price elements after interaction: ' + updatedPriceEls.join(' | '));
    }

    // Check API captures
    const relevantApis = apiLog.filter(c => !c.url.includes('google') && !c.url.includes('pinterest') && !c.url.includes('youtube'));
    log(`UP: ${relevantApis.length} relevant API responses`);
    relevantApis.slice(0, 10).forEach(c => {
      log(`  ${c.status} ${c.url}`);
      if (c.body?.includes('"price"') || c.body?.includes('"amount"') || c.body?.includes('"total"')) {
        log(`  *** PRICING DATA: ${c.body.slice(0, 400)}`);
      }
    });

    result.apiCalls = relevantApis.slice(0, 15).map(c => ({ url: c.url, status: c.status, bodySnippet: c.body?.slice(0, 300) }));
    result.prices = [...new Set(result.prices)];

  } catch (e) {
    result.error = e.message;
    err('UPrinting: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Deep Targeted Capture ===');
  log(`Date: ${nowISO()}`);
  log('');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const captureResults = {};

  try {
    // Axiom - we know the product page works, get full data
    captureResults.axiomprint = await captureAxiom(browser);
    log('');

    // GotPrint - deeper configurator interaction
    captureResults.gotprint = await captureGotprint(browser);
    log('');

    // Vistaprint - roll labels specific
    captureResults.vistaprint = await captureVistaprint(browser);
    log('');

    // Sticker Mule - pricing page exploration
    captureResults.stickermule = await captureStickermule(browser);
    log('');

    // UPrinting - product level
    captureResults.uprinting = await captureUprinting(browser);
    log('');

  } finally {
    await browser.close();
  }

  // Save capture log
  fs.writeFileSync(LOG_FILE, JSON.stringify(captureResults, null, 2));
  log(`Capture log: ${LOG_FILE}`);

  // Summary
  log('');
  log('=== FINAL SUMMARY ===');
  for (const [key, res] of Object.entries(captureResults)) {
    const prices = res.prices || [];
    log(`${key.padEnd(14)}: prices=[${prices.join(', ')}]${res.error ? ' ERROR:' + res.error : ''}`);
  }
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
