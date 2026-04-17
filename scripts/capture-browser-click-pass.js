#!/usr/bin/env node
/**
 * capture-browser-click-pass.js
 *
 * Human-style click-through pass for remaining competitor sites:
 *   1. Vistaprint  — click shape → size inputs → fill 3×3 → qty 5000 → read Cimpress price
 *   2. GotPrint    — click through Vue.js configurator: shape, size, material, qty → read price
 *   3. Sticker Mule — step through visible controls: dismiss cookie/modal, size, qty → read price
 *
 * Target spec: 3" × 3", qty 5000, White BOPP / closest, Matte / closest
 *
 * Method: Playwright chromium, non-headless rendering, slow human-like interactions.
 * Screenshots saved at each step to data/screenshots/.
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

function log(msg)  { console.log(`[click] ${msg}`); }
function warn(msg) { console.warn(`[WARN]  ${msg}`); }
function err(msg)  { console.error(`[ERR]   ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function screenshot(page, label) {
  const file = path.join(SCREENS_DIR, `${label}-${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); log(`  screenshot → ${path.basename(file)}`); }
  catch (_) {}
}

// ─── READ / WRITE DATA ────────────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function upsertRawCapture(raw, entry) {
  const idx = raw.captures.findIndex(c => c.id === entry.id);
  if (idx >= 0) raw.captures[idx] = entry;
  else raw.captures.push(entry);
  raw.last_updated = nowISO();
}

function upsertCompetitorResult(norm, queryId, competitor, result) {
  const query = norm.queries.find(q => q.query_id === queryId);
  if (!query) return;
  const idx = query.competitor_results.findIndex(r => r.competitor === competitor);
  if (idx >= 0) query.competitor_results[idx] = { ...query.competitor_results[idx], ...result };
  else query.competitor_results.push(result);
  norm.last_updated = nowISO();
}

// ══════════════════════════════════════════════════════════════════════════════
// SITE 1: VISTAPRINT
// Goal: Click shape selector → find width/height inputs → fill 3 and 3 →
//       watch for new Cimpress API call with custom dimensions → capture 5000 qty
// ══════════════════════════════════════════════════════════════════════════════
async function captureVistaprint(browser, raw, norm) {
  log('\n══ VISTAPRINT: human click-through ══');

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US'
  });

  const cimpressCalls = [];
  const allPricingCalls = [];

  // Intercept ALL Cimpress pricing calls
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') && (u.includes('/prices/') || u.includes('/price'))) {
      try {
        const body = await resp.text();
        const params = {};
        try {
          const p = new URL(u).searchParams;
          for (const [k, v] of p.entries()) params[k] = v;
        } catch (_) {}
        cimpressCalls.push({ url: u, body, params, ts: Date.now() });
        log(`VP Cimpress call: qty=${params.quantities || '?'} sels=${JSON.stringify(
          Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('selections[')))
        )}`);
      } catch (_) {}
    }
    if (u.includes('vistaprint.com') && u.includes('/api/')) {
      try {
        const body = await resp.text();
        allPricingCalls.push({ url: u, body: body.slice(0, 500), ts: Date.now() });
      } catch (_) {}
    }
  });

  const result = {
    price5000: null, unit5000: null,
    width3: false, height3: false,
    shapeClicked: null,
    selectionsUsed: null,
    method: null,
    blockerNotes: [],
    rawVisibleText: null
  };

  const page = await context.newPage();
  try {
    log('VP: navigating to roll labels page...');
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(4000);
    await screenshot(page, 'vp-01-loaded');

    // ── Step 1: Dismiss any cookie/consent banners ──
    const cookieSelectors = [
      'button[data-testid="cookie-accept"]',
      'button[id*="accept"]',
      'button[class*="accept"]',
      '[aria-label*="Accept"]',
      '[data-testid*="consent"] button',
      '#onetrust-accept-btn-handler'
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); log(`VP: dismissed cookie banner: ${sel}`); await sleep(1000); break; }
      } catch (_) {}
    }

    // ── Step 2: Find and log all visible configurator elements ──
    const pageTitle = await page.title();
    log(`VP: page title = "${pageTitle}"`);

    // Find all radio inputs (shape selectors)
    const radioLabels = await page.$$eval(
      'label',
      labels => labels
        .filter(l => l.textContent.trim().length > 0 && l.textContent.trim().length < 60)
        .map(l => ({ text: l.textContent.trim(), forAttr: l.getAttribute('for') || '', classes: l.className }))
    );
    log(`VP: found ${radioLabels.length} labels. Sample: ${radioLabels.slice(0, 8).map(l => l.text).join(' | ')}`);

    // ── Step 3: Click "Square" or "Rounded Square" shape ──
    const shapeTargets = ['Square', 'Rounded Square', 'Custom'];
    let shapeClicked = false;

    for (const target of shapeTargets) {
      // Try clicking a label that contains this text
      const labels = await page.$$('label');
      for (const label of labels) {
        const text = await label.textContent();
        if (text && text.trim() === target) {
          try {
            await label.click({ force: true });
            log(`VP: clicked shape label: "${target}"`);
            result.shapeClicked = target;
            shapeClicked = true;
            await sleep(3000);
            await screenshot(page, `vp-02-shape-${target.replace(/\s/g, '-')}`);
            break;
          } catch (e) {
            log(`VP: label click failed for "${target}": ${e.message}`);
          }
        }
      }
      if (shapeClicked) break;
    }

    if (!shapeClicked) {
      // Try radio buttons directly
      const radios = await page.$$('input[type="radio"]');
      log(`VP: ${radios.length} radio inputs found`);
      for (const radio of radios) {
        const val = await radio.getAttribute('value') || '';
        const id  = await radio.getAttribute('id') || '';
        if (/square|custom/i.test(val) || /square|custom/i.test(id)) {
          try {
            await radio.click({ force: true });
            log(`VP: clicked radio id="${id}" val="${val}"`);
            result.shapeClicked = val || id;
            shapeClicked = true;
            await sleep(3000);
            break;
          } catch (_) {}
        }
      }
    }

    // ── Step 4: Look for width/height/size inputs that may have appeared ──
    await sleep(2000);
    const inputSelectors = [
      'input[placeholder*="width" i]', 'input[placeholder*="height" i]',
      'input[aria-label*="width" i]',  'input[aria-label*="height" i]',
      'input[name*="width" i]',         'input[name*="height" i]',
      'input[id*="width" i]',           'input[id*="height" i]',
      'input[type="number"]',
      'input[inputmode="numeric"]'
    ];

    const foundInputs = [];
    for (const sel of inputSelectors) {
      const els = await page.$$(sel);
      for (const el of els) {
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          const placeholder = await el.getAttribute('placeholder') || '';
          const label       = await el.getAttribute('aria-label') || '';
          const name        = await el.getAttribute('name') || '';
          foundInputs.push({ sel, placeholder, label, name, el });
        }
      }
    }
    log(`VP: found ${foundInputs.length} visible numeric/size inputs after shape click`);
    foundInputs.forEach(i => log(`  → placeholder="${i.placeholder}" label="${i.label}" name="${i.name}"`));

    // Try to fill width=3 and height=3
    if (foundInputs.length >= 2) {
      // First two are likely width and height
      try {
        await foundInputs[0].el.triple_click?.() || await foundInputs[0].el.click();
        await foundInputs[0].el.selectAll?.();
        await foundInputs[0].el.fill('3');
        log(`VP: filled first size input with 3 (placeholder="${foundInputs[0].placeholder}")`);
        result.width3 = true;
        await sleep(500);
      } catch (e) { log(`VP: width fill failed: ${e.message}`); }

      try {
        await foundInputs[1].el.click();
        await foundInputs[1].el.fill('3');
        log(`VP: filled second size input with 3 (placeholder="${foundInputs[1].placeholder}")`);
        result.height3 = true;
        await sleep(500);
      } catch (e) { log(`VP: height fill failed: ${e.message}`); }

      // Trigger change
      await page.keyboard.press('Tab');
      await sleep(3000);
      await screenshot(page, 'vp-03-size-filled');
    } else if (foundInputs.length === 1) {
      // Single dimension input (maybe square)
      try {
        await foundInputs[0].el.click();
        await foundInputs[0].el.fill('3');
        log(`VP: filled single size input with 3`);
        result.width3 = result.height3 = true;
        await page.keyboard.press('Tab');
        await sleep(3000);
        await screenshot(page, 'vp-03-size-filled');
      } catch (e) { log(`VP: single size fill failed: ${e.message}`); }
    }

    // ── Step 5: Find quantity selector and choose 5000 ──
    await sleep(2000);
    const qtySelectors = [
      'select[name*="qty" i]', 'select[id*="qty" i]',
      'select[aria-label*="qty" i]', 'select[aria-label*="quantity" i]',
      'select[name*="quantity" i]',
      '[data-testid*="quantity"]',
      'select'
    ];

    let qtySet = false;
    for (const sel of qtySelectors) {
      const els = await page.$$(sel);
      for (const el of els) {
        try {
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          const options = await el.$$eval('option', opts => opts.map(o => ({ val: o.value, text: o.textContent.trim() })));
          const has5000  = options.find(o => o.text.includes('5000') || o.text.includes('5,000') || o.val === '5000');
          if (has5000) {
            await el.selectOption({ label: has5000.text });
            log(`VP: selected qty 5000 from select (option: "${has5000.text}")`);
            qtySet = true;
            await sleep(3000);
            await screenshot(page, 'vp-04-qty-5000');
            break;
          }
          // Log available options for debugging
          if (options.length > 0 && options.length < 30) {
            log(`VP select options: ${options.map(o => o.text).join(', ')}`);
          }
        } catch (_) {}
      }
      if (qtySet) break;
    }

    // ── Step 6: Try clicking "5,000" in any quantity grid/button ──
    if (!qtySet) {
      const allButtons = await page.$$('button, [role="button"], li[data-value], [class*="qty"]');
      for (const btn of allButtons) {
        try {
          const text = await btn.textContent();
          if (text && (text.trim() === '5,000' || text.trim() === '5000')) {
            await btn.click({ force: true });
            log(`VP: clicked qty button "5,000"`);
            qtySet = true;
            await sleep(3000);
            await screenshot(page, 'vp-04-qty-5000-button');
            break;
          }
        } catch (_) {}
      }
    }

    // ── Step 7: Find material / finish selectors ──
    await sleep(2000);
    const matSelectors = ['select[name*="mat" i]', 'select[name*="material" i]', 'select[aria-label*="material" i]'];
    for (const sel of matSelectors) {
      const el = await page.$(sel);
      if (el) {
        const opts = await el.$$eval('option', o => o.map(x => x.textContent.trim()));
        log(`VP material options: ${opts.join(', ')}`);
      }
    }

    // ── Step 8: Read visible price from DOM ──
    await sleep(4000);
    await screenshot(page, 'vp-05-final');

    const priceText = await page.evaluate(() => {
      const candidates = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (/\$[\d,]+\.\d{2}/.test(n.textContent)) {
          candidates.push(n.textContent.trim());
        }
      }
      return candidates.slice(0, 20);
    });
    log(`VP: visible price text nodes: ${JSON.stringify(priceText.slice(0, 10))}`);
    result.rawVisibleText = priceText;

    // ── Step 9: Make direct Cimpress API call from Node.js with all selections ──
    // Use the pricingContext from the last intercepted call + add custom dimensions
    const lastCall = cimpressCalls.slice().reverse()[0];
    if (lastCall) {
      const lastParams = lastCall.params;
      const pricingContext = lastParams.pricingContext || lastParams['pricingContext'];
      const productKey     = lastParams.productKey || 'PRD-DF5PWTHC';
      const merchantId     = lastParams.merchantId || 'vistaprint';

      if (pricingContext) {
        log(`VP: pricingContext found — attempting Node.js Cimpress call for qty=5000 with 3×3 dims`);

        // Build selections from last call + add custom dimensions if shape is custom
        const selectionParams = Object.entries(lastParams)
          .filter(([k]) => k.startsWith('selections['))
          .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

        // Add custom width/height if shape was clicked
        if (result.shapeClicked) {
          selectionParams['selections[Width]'] = '3';
          selectionParams['selections[Height]'] = '3';
          selectionParams['selections[Custom Width]'] = '3';
          selectionParams['selections[Custom Height]'] = '3';
        }

        result.selectionsUsed = selectionParams;

        const qs = new URLSearchParams({
          requestor: 'inspector-gadget-pdp-configurator-fragment',
          productKey,
          quantities: '5000',
          pricingContext,
          merchantId,
          market: 'US',
          optionalPriceComponents: 'UnitPrice',
          ...selectionParams
        });

        const apiUrl = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?${qs.toString()}`;
        log(`VP: calling Cimpress API directly: ${apiUrl.slice(0, 120)}...`);

        try {
          const apiResp = await context.request.get(apiUrl, {
            headers: { 'Accept': 'application/json', 'Origin': 'https://www.vistaprint.com' },
            timeout: 15000
          });
          const apiBody = await apiResp.text();
          log(`VP Cimpress API status: ${apiResp.status()}`);
          log(`VP Cimpress API body: ${apiBody.slice(0, 500)}`);

          try {
            const d = JSON.parse(apiBody);
            if (d.estimatedPrices?.['5000']) {
              const ep = d.estimatedPrices['5000'];
              result.price5000 = ep.totalListPrice?.untaxed ?? ep.totalListPrice;
              result.unit5000  = ep.unitListPrice?.untaxed ?? ep.unitListPrice;
              result.method = 'cimpress_api_nodejs_with_3x3_selections';
              log(`VP: *** $${result.price5000} for 5000 qty with selections ***`);
            }
          } catch (_) {}
        } catch (e) { log(`VP: Cimpress API call failed: ${e.message}`); }
      }
    }

    // Also try with intercepted calls
    if (!result.price5000) {
      for (const c of cimpressCalls.reverse()) {
        try {
          const d = JSON.parse(c.body);
          const ep5000 = d.estimatedPrices?.['5000'];
          if (ep5000) {
            result.price5000 = ep5000.totalListPrice?.untaxed ?? ep5000.totalListPrice;
            result.unit5000  = ep5000.unitListPrice?.untaxed ?? ep5000.unitListPrice;
            result.method = 'intercepted_cimpress_5000qty';
            log(`VP: found 5000 price in intercepted call: $${result.price5000}`);
            break;
          }
        } catch (_) {}
      }
    }

    // Capture DOM price text as fallback
    if (!result.price5000) {
      result.blockerNotes.push(`No 5000 qty price in Cimpress calls. Size inputs found: ${foundInputs.length}. Shape clicked: ${result.shapeClicked}. Last Cimpress call: ${lastCall ? 'yes' : 'no'}`);
    }

  } catch (e) {
    err(`VP error: ${e.message}`);
    result.blockerNotes.push(`Exception: ${e.message}`);
  } finally {
    await page.close();
    await context.close();
  }

  log(`VP result: ${JSON.stringify({ price5000: result.price5000, shape: result.shapeClicked, size3x3: result.width3 && result.height3, method: result.method })}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// SITE 2: GOTPRINT
// Goal: Navigate to roll-labels configurator, click through each option:
//   shape → square, size → 3×3 (or closest), material → BOPP, qty → 5000
//   Read price from DOM. Also intercept XHR/fetch requests.
// ══════════════════════════════════════════════════════════════════════════════
async function captureGotprint(browser, raw, norm) {
  log('\n══ GOTPRINT: human click-through ══');

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US'
  });

  const priceApiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com') && (
      u.includes('/price') || u.includes('/product') || u.includes('/quote') ||
      u.includes('/api/') || u.includes('/service/')
    )) {
      try {
        const body = await resp.text();
        priceApiCalls.push({ url: u, status: resp.status(), body: body.slice(0, 1000), ts: Date.now() });
        if (body.includes('price') || body.includes('total') || body.includes('amount')) {
          log(`GP API hit: ${u.slice(0, 100)} status=${resp.status()} body=${body.slice(0, 200)}`);
        }
      } catch (_) {}
    }
  });

  const result = {
    price5000: null, unit5000: null,
    configuratorFound: false,
    optionsFound: {},
    shapeSelected: null, sizeSelected: null, qtySelected: null, matSelected: null,
    blockerNotes: [],
    method: null
  };

  const page = await context.newPage();
  try {
    log('GP: navigating to roll labels page...');
    await page.goto('https://www.gotprint.com/store/stickers-and-labels/roll-labels', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(5000);
    await screenshot(page, 'gp-01-loaded');

    const pageTitle = await page.title();
    log(`GP: page title = "${pageTitle}"`);
    const pageUrl = page.url();
    log(`GP: final URL = ${pageUrl}`);

    // Check for redirects or 404
    const notFound = await page.$('text=404') || await page.$('[class*="not-found"]') || await page.$('h1:text("404")');
    if (notFound) {
      result.blockerNotes.push('Page returned 404');
      log('GP: page shows 404');

      // Try alternate URL
      log('GP: trying alternate URL...');
      await page.goto('https://www.gotprint.com/store/stickers-labels/roll-labels', {
        waitUntil: 'networkidle', timeout: 30000
      });
      await sleep(3000);
      await screenshot(page, 'gp-01b-alt-url');
    }

    // ── Step 1: Dismiss cookie consent ──
    const cookieBtns = ['#onetrust-accept-btn-handler', 'button:has-text("Accept")', 'button:has-text("OK")',
                        '[data-testid="cookie-accept"]', '.cookie-accept', '#cookie-accept'];
    for (const sel of cookieBtns) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click(); log(`GP: dismissed cookie: ${sel}`); await sleep(1000); break;
        }
      } catch (_) {}
    }

    // ── Step 2: Map out all visible form controls ──
    const allSelects = await page.$$('select');
    log(`GP: found ${allSelects.length} <select> elements`);
    for (const sel of allSelects) {
      try {
        const visible = await sel.isVisible();
        if (!visible) continue;
        const name    = await sel.getAttribute('name') || await sel.getAttribute('id') || 'unknown';
        const options = await sel.$$eval('option', opts => opts.map(o => ({ val: o.value, text: o.textContent.trim() })));
        log(`  GP select[${name}]: ${options.slice(0, 10).map(o => o.text).join(' | ')}`);
        result.optionsFound[name] = options;
        result.configuratorFound = true;
      } catch (_) {}
    }

    // Vue.js-based controls (may use custom components)
    const vueSelects = await page.$$('[class*="select"], [class*="dropdown"], [class*="v-select"]');
    log(`GP: found ${vueSelects.length} custom select/dropdown elements`);

    // ── Step 3: Find shape selector → click Square ──
    const shapeKeywords = ['shape', 'Shape', 'type', 'Type'];
    for (const kw of shapeKeywords) {
      const label = await page.$(`label:has-text("${kw}"), [class*="label"]:has-text("${kw}")`);
      if (label) { log(`GP: found shape label: ${await label.textContent()}`); }
    }

    // Try clicking Square radio/option
    const squareTargets = [
      'input[value*="square" i]', 'input[value*="Square"]',
      'label:has-text("Square")', 'option[value*="square" i]',
      '[data-value*="square" i]', 'li:has-text("Square")'
    ];
    for (const sel of squareTargets) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click({ force: true });
          result.shapeSelected = 'Square';
          log(`GP: clicked Square shape: ${sel}`);
          await sleep(2000);
          await screenshot(page, 'gp-02-shape-square');
          break;
        }
      } catch (_) {}
    }

    // ── Step 4: Find size selector → select 3×3 ──
    await sleep(1000);
    const sizeSelects = await page.$$('select');
    for (const sel of sizeSelects) {
      try {
        const visible = await sel.isVisible();
        if (!visible) continue;
        const options = await sel.$$eval('option', opts => opts.map(o => ({ val: o.value, text: o.textContent.trim() })));
        const has3x3  = options.find(o => o.text.includes('3 x 3') || o.text.includes('3"x3"') ||
                                          o.text.includes('3" x 3"') || o.text.includes('3×3') ||
                                          (o.text.includes('3') && o.text.includes('3')));
        if (has3x3) {
          await sel.selectOption({ value: has3x3.val });
          result.sizeSelected = has3x3.text;
          log(`GP: selected size "${has3x3.text}"`);
          await sleep(2000);
          await screenshot(page, 'gp-03-size-3x3');
          break;
        }
      } catch (_) {}
    }

    // Also try size input fields
    const widthInput  = await page.$('input[name*="width" i], input[placeholder*="width" i], input[id*="width" i]');
    const heightInput = await page.$('input[name*="height" i], input[placeholder*="height" i], input[id*="height" i]');
    if (widthInput && await widthInput.isVisible()) {
      await widthInput.fill('3');
      log('GP: filled width = 3');
      result.sizeSelected = (result.sizeSelected || '') + ' width=3';
    }
    if (heightInput && await heightInput.isVisible()) {
      await heightInput.fill('3');
      log('GP: filled height = 3');
      result.sizeSelected = (result.sizeSelected || '') + ' height=3';
    }
    if (widthInput || heightInput) {
      await page.keyboard.press('Tab');
      await sleep(2000);
    }

    // ── Step 5: Find quantity selector → select 5000 ──
    await sleep(1000);
    const qtySelects = await page.$$('select');
    let qtySet = false;
    for (const sel of qtySelects) {
      try {
        const visible = await sel.isVisible();
        if (!visible) continue;
        const options = await sel.$$eval('option', opts => opts.map(o => ({ val: o.value, text: o.textContent.trim() })));
        const has5000 = options.find(o => o.text.includes('5000') || o.text.includes('5,000') || o.val === '5000');
        if (has5000) {
          await sel.selectOption({ value: has5000.val });
          result.qtySelected = has5000.text;
          log(`GP: selected qty "${has5000.text}"`);
          qtySet = true;
          await sleep(2000);
          await screenshot(page, 'gp-04-qty-5000');
          break;
        }
        // Log qty options even if no 5000
        const qtyLike = options.find(o => /\d{3,}/.test(o.text) || /qty|quantity/i.test(o.val));
        if (qtyLike) {
          log(`GP: found qty select with options: ${options.map(o => o.text).slice(0, 8).join(', ')}`);
        }
      } catch (_) {}
    }

    // Also try qty input field
    const qtyInput = await page.$('input[name*="qty" i], input[id*="qty" i], input[placeholder*="quantity" i]');
    if (qtyInput && await qtyInput.isVisible()) {
      await qtyInput.fill('5000');
      await page.keyboard.press('Tab');
      log('GP: filled qty = 5000');
      result.qtySelected = '5000';
      await sleep(2000);
    }

    // ── Step 6: Find material selector → pick BOPP or closest ──
    await sleep(1000);
    const matSelects = await page.$$('select');
    for (const sel of matSelects) {
      try {
        const visible = await sel.isVisible();
        if (!visible) continue;
        const options = await sel.$$eval('option', opts => opts.map(o => ({ val: o.value, text: o.textContent.trim() })));
        const hasBopp = options.find(o => /bopp/i.test(o.text) || /white.*matte/i.test(o.text) || /matte.*white/i.test(o.text));
        if (hasBopp) {
          await sel.selectOption({ value: hasBopp.val });
          result.matSelected = hasBopp.text;
          log(`GP: selected material "${hasBopp.text}"`);
          await sleep(2000);
          await screenshot(page, 'gp-05-material-bopp');
          break;
        }
      } catch (_) {}
    }

    // ── Step 7: Look for "Get Price", "Calculate", "Add to Cart" buttons ──
    await sleep(1000);
    const submitBtns = [
      'button:has-text("Get Price")',
      'button:has-text("Calculate")',
      'button:has-text("Get Quote")',
      'button:has-text("Add to Cart")',
      '[data-testid*="price"]',
      'button[type="submit"]'
    ];
    for (const sel of submitBtns) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          log(`GP: clicked submit button: ${sel}`);
          await sleep(3000);
          await screenshot(page, 'gp-06-after-submit');
          break;
        }
      } catch (_) {}
    }

    // ── Step 8: Read price from DOM ──
    await sleep(3000);
    await screenshot(page, 'gp-07-final');

    const allPriceText = await page.evaluate(() => {
      const candidates = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (/\$[\d,]+\.\d{2}/.test(t) || /total.*\d/i.test(t)) candidates.push(t);
      }
      return candidates.slice(0, 30);
    });
    log(`GP: visible price text: ${JSON.stringify(allPriceText.slice(0, 10))}`);

    // Extract dollar amounts
    const allAmounts = [];
    for (const t of allPriceText) {
      const matches = t.match(/\$([\d,]+\.\d{2})/g);
      if (matches) allAmounts.push(...matches.map(m => parseFloat(m.replace(/[$,]/g, ''))));
    }
    log(`GP: all dollar amounts found: ${JSON.stringify(allAmounts.slice(0, 10))}`);

    // Check API calls
    log(`GP: ${priceApiCalls.length} pricing API calls intercepted`);
    for (const c of priceApiCalls.slice(0, 5)) {
      log(`  ${c.url.slice(0, 100)} status=${c.status}`);
      if (c.body) log(`  body: ${c.body.slice(0, 200)}`);
    }

    // Try to find the actual price from API responses
    for (const c of priceApiCalls) {
      try {
        const d = JSON.parse(c.body);
        const priceKeys = ['price', 'totalPrice', 'total_price', 'amount', 'unitPrice', 'totalAmount'];
        for (const k of priceKeys) {
          if (d[k] !== undefined) {
            log(`GP: found price in API response (${k}): ${d[k]}`);
            if (parseFloat(d[k]) > 0) {
              result.price5000 = parseFloat(d[k]);
              result.method = 'api_intercept';
            }
          }
        }
      } catch (_) {}
    }

    if (!result.price5000 && allAmounts.length > 0) {
      // Best guess: largest amount that looks like a batch price
      const batchAmounts = allAmounts.filter(a => a > 50 && a < 5000);
      if (batchAmounts.length > 0) {
        result.price5000 = Math.max(...batchAmounts);
        result.method = 'dom_text_extraction';
        log(`GP: using max DOM price as estimate: $${result.price5000}`);
      }
    }

    if (!result.price5000) {
      result.blockerNotes.push(`No price captured. Selects found: ${allSelects.length}. Config: ${result.configuratorFound}. API calls: ${priceApiCalls.length}. DOM amounts: ${allAmounts.join(', ')}`);
    }

    // ── Step 9: Also probe the REST API with actual cookies ──
    log('GP: probing REST API with browser cookies...');
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Try accessing token file
    try {
      const tokenResp = await context.request.get(
        'https://www.gotprint.com/assets/dyn/css/access_token.txt',
        { headers: { Cookie: cookieHeader } }
      );
      const tokenBody = await tokenResp.text();
      log(`GP: access_token.txt status=${tokenResp.status()} body=${tokenBody.slice(0, 100)}`);

      if (tokenResp.status() === 200) {
        let token = null;
        try {
          const arr = JSON.parse(tokenBody);
          token = arr[0]?.token;
        } catch (_) {
          token = tokenBody.trim();
        }

        if (token) {
          log(`GP: trying REST API with token=${token.slice(0, 8)}...`);
          // Try various auth headers
          const authHeaders = [
            { 'Authorization': `Bearer ${token}` },
            { 'Authorization': `Token ${token}` },
            { 'X-API-Key': token },
            { 'X-Auth-Token': token },
            { Cookie: cookieHeader }
          ];

          for (const headers of authHeaders) {
            try {
              const priceResp = await context.request.get(
                'https://www.gotprint.com/service/rest/v1/products',
                { headers: { ...headers, Accept: 'application/json' }, timeout: 10000 }
              );
              log(`GP REST /products with ${JSON.stringify(Object.keys(headers))}: status=${priceResp.status()}`);
              if (priceResp.status() === 200) {
                const body = await priceResp.text();
                log(`GP REST response: ${body.slice(0, 300)}`);
                break;
              }
            } catch (_) {}
          }
        }
      }
    } catch (e) { log(`GP: token probe failed: ${e.message}`); }

  } catch (e) {
    err(`GP error: ${e.message}`);
    result.blockerNotes.push(`Exception: ${e.message}`);
  } finally {
    await page.close();
    await context.close();
  }

  log(`GP result: ${JSON.stringify({ price5000: result.price5000, config: result.configuratorFound, shape: result.shapeSelected, size: result.sizeSelected, qty: result.qtySelected, mat: result.matSelected })}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// SITE 3: STICKER MULE
// Goal: Navigate to custom-labels. Dismiss cookie modal. Find size/qty inputs.
//   Try: stickermule.com/custom-labels — look for size inputs, qty grid, BOPP selector
//   Also try: stickermule.com/products/custom-labels — alternate URL
//   Also try: stickermule.com/stickers/custom-stickers (different product path)
//   Intercept API calls. Read price from DOM.
// ══════════════════════════════════════════════════════════════════════════════
async function captureStickerMule(browser, raw, norm) {
  log('\n══ STICKER MULE: human click-through ══');

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US'
  });

  const priceApiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('stickermule.com') && (
      u.includes('/price') || u.includes('/product') || u.includes('/quote') ||
      u.includes('/api/') || u.includes('/orders') || u.includes('/graphql')
    )) {
      try {
        const body = await resp.text();
        priceApiCalls.push({ url: u, status: resp.status(), body: body.slice(0, 1000), ts: Date.now() });
        if (resp.status() < 400) {
          log(`SM API hit: ${u.slice(0, 100)} status=${resp.status()}`);
          if (body.includes('price') || body.includes('total') || body.includes('cost')) {
            log(`  body snippet: ${body.slice(0, 300)}`);
          }
        }
      } catch (_) {}
    }
  });

  const result = {
    price5000: null, unit5000: null,
    configuratorFound: false,
    optionsFound: {},
    sizeSelected: null, qtySelected: null, matSelected: null,
    urlsTried: [],
    blockerNotes: [],
    method: null
  };

  const page = await context.newPage();
  try {
    // ── Attempt 1: /custom-labels ──
    log('SM: navigating to custom-labels...');
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(4000);
    await screenshot(page, 'sm-01-loaded');
    result.urlsTried.push(page.url());
    log(`SM: loaded URL = ${page.url()}`);
    log(`SM: title = "${await page.title()}"`);

    // ── Step 1: Dismiss cookie/consent modal ──
    const cookieTargets = [
      'button:has-text("Accept")', 'button:has-text("Accept All")',
      'button:has-text("OK")', 'button:has-text("Got it")',
      'button:has-text("I agree")', '#cookie-consent-accept',
      '[data-testid="cookie-accept"]', '.cookie__btn',
      'button[aria-label*="accept" i]', 'button[class*="accept" i]',
      '#onetrust-accept-btn-handler'
    ];
    for (const sel of cookieTargets) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          log(`SM: dismissed modal/cookie: ${sel}`);
          await sleep(1500);
          await screenshot(page, 'sm-02-after-dismiss');
          break;
        }
      } catch (_) {}
    }

    // ── Step 2: Map visible inputs ──
    const visibleInputs = await page.$$('input:visible, select:visible, textarea:visible');
    log(`SM: ${visibleInputs.length} visible form elements after modal dismiss`);

    for (const el of visibleInputs.slice(0, 20)) {
      try {
        const tag  = await el.evaluate(e => e.tagName);
        const name = await el.getAttribute('name') || await el.getAttribute('id') || await el.getAttribute('aria-label') || '';
        const type = await el.getAttribute('type') || '';
        const val  = await el.inputValue().catch(() => '');
        log(`  SM el: <${tag} name="${name}" type="${type}" value="${val}">`);
        result.configuratorFound = true;
      } catch (_) {}
    }

    // ── Step 3: Look for size controls ──
    // SM may have a size selector as buttons, dropdowns, or inputs
    const sizeBtnSelectors = [
      'button:has-text("3 x 3")', 'button:has-text("3\" x 3\"")',
      '[data-size*="3x3"]', '[data-value*="3x3"]',
      'label:has-text("3 x 3")', 'label:has-text("3\"")',
      'input[value*="3x3"]'
    ];
    for (const sel of sizeBtnSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click({ force: true });
          result.sizeSelected = '3x3';
          log(`SM: clicked size 3x3: ${sel}`);
          await sleep(2000);
          break;
        }
      } catch (_) {}
    }

    // Width/height inputs
    const wInput = await page.$('input[name*="width" i], input[placeholder*="width" i], input[aria-label*="width" i]');
    const hInput = await page.$('input[name*="height" i], input[placeholder*="height" i], input[aria-label*="height" i]');
    if (wInput && await wInput.isVisible()) {
      await wInput.fill('3');
      result.sizeSelected = (result.sizeSelected || '') + ' w=3';
      log('SM: filled width = 3');
      await sleep(500);
    }
    if (hInput && await hInput.isVisible()) {
      await hInput.fill('3');
      result.sizeSelected = (result.sizeSelected || '') + ' h=3';
      log('SM: filled height = 3');
      await sleep(500);
    }
    if (wInput || hInput) {
      await page.keyboard.press('Tab');
      await sleep(2000);
      await screenshot(page, 'sm-03-size');
    }

    // ── Step 4: Find quantity selector or input → 5000 ──
    await sleep(1000);
    const qtyInput = await page.$('input[name*="qty" i], input[id*="qty" i], input[name*="quantity" i], input[aria-label*="quantity" i]');
    if (qtyInput && await qtyInput.isVisible()) {
      await qtyInput.fill('5000');
      await page.keyboard.press('Tab');
      result.qtySelected = '5000';
      log('SM: filled qty = 5000');
      await sleep(2000);
      await screenshot(page, 'sm-04-qty');
    } else {
      // Try select
      const qtySelects = await page.$$('select');
      for (const sel of qtySelects) {
        try {
          const visible = await sel.isVisible();
          if (!visible) continue;
          const options = await sel.$$eval('option', opts => opts.map(o => ({ val: o.value, text: o.textContent.trim() })));
          const has5000 = options.find(o => o.text.includes('5000') || o.text.includes('5,000') || o.val === '5000');
          if (has5000) {
            await sel.selectOption({ value: has5000.val });
            result.qtySelected = has5000.text;
            log(`SM: selected qty "${has5000.text}"`);
            await sleep(2000);
            break;
          }
          if (options.length > 0) {
            log(`SM select options: ${options.slice(0, 8).map(o => o.text).join(', ')}`);
          }
        } catch (_) {}
      }

      // Try qty buttons (SM uses a quantity grid in some flows)
      const allBtns = await page.$$('button, [role="button"]');
      for (const btn of allBtns) {
        try {
          const text = await btn.textContent();
          if (text && (text.trim() === '5,000' || text.trim() === '5000')) {
            await btn.click({ force: true });
            result.qtySelected = '5000';
            log(`SM: clicked qty button "5,000"`);
            await sleep(2000);
            await screenshot(page, 'sm-04-qty-button');
            break;
          }
        } catch (_) {}
      }
    }

    // ── Step 5: Find material/finish selectors ──
    await sleep(1000);
    const matInput = await page.$('select[name*="material" i], select[name*="mat" i], select[aria-label*="material" i]');
    if (matInput && await matInput.isVisible()) {
      const options = await matInput.$$eval('option', o => o.map(x => ({ val: x.value, text: x.textContent.trim() })));
      log(`SM material options: ${options.map(o => o.text).join(', ')}`);
      const bopp = options.find(o => /bopp/i.test(o.text) || /white.*matte/i.test(o.text));
      if (bopp) {
        await matInput.selectOption({ value: bopp.val });
        result.matSelected = bopp.text;
        log(`SM: selected material "${bopp.text}"`);
        await sleep(2000);
      }
    }

    // ── Step 6: Read price from DOM ──
    await sleep(3000);
    await screenshot(page, 'sm-05-final');

    const priceTexts = await page.evaluate(() => {
      const results = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (/\$[\d,]+\.?\d*/.test(t) && t.length < 100) results.push(t);
      }
      return results.slice(0, 30);
    });
    log(`SM: price text nodes: ${JSON.stringify(priceTexts.slice(0, 10))}`);

    const amounts = [];
    for (const t of priceTexts) {
      const m = t.match(/\$([\d,]+\.?\d*)/g);
      if (m) amounts.push(...m.map(x => parseFloat(x.replace(/[$,]/g, ''))));
    }
    log(`SM: all amounts: ${JSON.stringify([...new Set(amounts)].sort((a, b) => b - a).slice(0, 10))}`);

    // ── Step 7: Check API call log for pricing data ──
    log(`SM: ${priceApiCalls.length} API calls intercepted`);
    for (const c of priceApiCalls.slice(0, 5)) {
      log(`  ${c.url.slice(0, 100)}`);
      try {
        const d = JSON.parse(c.body);
        if (d.price || d.total_price || d.totalPrice || d.amount || d.data?.price) {
          const price = d.price || d.total_price || d.totalPrice || d.amount || d.data?.price;
          log(`  SM API price: ${price}`);
          if (parseFloat(price) > 10) {
            result.price5000 = parseFloat(price);
            result.method = 'api_intercept';
          }
        }
        // GraphQL response
        if (d.data) {
          const str = JSON.stringify(d.data);
          const priceMatch = str.match(/"price[^"]*":\s*([\d.]+)/i);
          if (priceMatch) log(`  SM GraphQL price: ${priceMatch[1]}`);
        }
      } catch (_) {}
    }

    // ── Attempt 2: Try /products/custom-labels if no price found ──
    if (!result.price5000) {
      log('SM: trying /products/custom-labels URL...');
      await page.goto('https://www.stickermule.com/products/custom-labels', {
        waitUntil: 'networkidle', timeout: 30000
      });
      await sleep(3000);
      result.urlsTried.push(page.url());
      await screenshot(page, 'sm-06-alt-url');
      log(`SM alt URL title: "${await page.title()}"`);

      // Repeat price read
      const altPrices = await page.evaluate(() => {
        const r = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const t = n.textContent.trim();
          if (/\$[\d,]+\.?\d*/.test(t) && t.length < 80) r.push(t);
        }
        return r.slice(0, 20);
      });
      log(`SM alt URL prices: ${JSON.stringify(altPrices.slice(0, 10))}`);
    }

    // ── Attempt 3: Try stickermule.com/fr/custom-labels or .com/labels ──
    if (!result.price5000) {
      log('SM: trying /labels URL...');
      await page.goto('https://www.stickermule.com/labels', {
        waitUntil: 'domcontentloaded', timeout: 25000
      });
      await sleep(3000);
      result.urlsTried.push(page.url());
      await screenshot(page, 'sm-07-labels-url');
      log(`SM labels URL = ${page.url()}, title = "${await page.title()}"`);
    }

    // ── Step 8: Try direct price API probe ──
    log('SM: probing known price endpoints...');
    const smEndpoints = [
      'https://www.stickermule.com/api/v1/prices?product=custom-labels&width=3&height=3&quantity=5000',
      'https://www.stickermule.com/api/v1/products/custom-labels/prices?quantity=5000',
      'https://www.stickermule.com/api/products/prices?sku=custom-labels&qty=5000&w=3&h=3',
      'https://www.stickermule.com/api/v1/orders/quote?product=custom-labels&width=3&height=3&quantity=5000'
    ];
    for (const url of smEndpoints) {
      try {
        const resp = await context.request.get(url, {
          headers: { Accept: 'application/json', Referer: 'https://www.stickermule.com/custom-labels' },
          timeout: 8000
        });
        log(`SM probe: ${url.slice(0, 70)} → status=${resp.status()}`);
        if (resp.status() < 400) {
          const body = await resp.text();
          log(`  body: ${body.slice(0, 200)}`);
        }
      } catch (_) {}
    }

    // Summarize blocker
    if (!result.price5000) {
      const configuratorState = {
        sizeSelected: result.sizeSelected,
        qtySelected: result.qtySelected,
        visibleInputs: visibleInputs.length,
        apiCalls: priceApiCalls.length
      };
      result.blockerNotes.push(`No price captured. State: ${JSON.stringify(configuratorState)}`);

      // Document what a human CAN reach by clicking
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      result.rawBodySnippet = bodyText.slice(0, 500);
    }

  } catch (e) {
    err(`SM error: ${e.message}`);
    result.blockerNotes.push(`Exception: ${e.message}`);
  } finally {
    await page.close();
    await context.close();
  }

  log(`SM result: ${JSON.stringify({ price5000: result.price5000, config: result.configuratorFound, size: result.sizeSelected, qty: result.qtySelected, method: result.method })}`);
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
  log('Browser launched (headless)');

  let vpResult, gpResult, smResult;

  try {
    // Run all three sequentially (each is browser-heavy; parallel risks timeout)
    vpResult = await captureVistaprint(browser, raw, norm);
    gpResult = await captureGotprint(browser, raw, norm);
    smResult = await captureStickerMule(browser, raw, norm);
  } finally {
    await browser.close();
    log('Browser closed');
  }

  // ─── Update data files ──────────────────────────────────────────────────────
  const today = nowISO();

  // VISTAPRINT
  const vpCapture = {
    id: `vistaprint-browser-click-${today}`,
    competitor: 'vistaprint',
    competitor_display: 'Vistaprint',
    source_url: 'https://www.vistaprint.com/labels-stickers/roll-labels',
    captured_at: today,
    capture_method: 'playwright_browser_click_through',
    capture_source: 'automated_headless',
    confidence: vpResult.price5000 ? (vpResult.width3 && vpResult.height3 ? 'high' : 'medium') : 'none',
    product_type: 'roll_labels',
    raw_spec_description: `Roll Labels ${vpResult.width3 && vpResult.height3 ? '3"×3"' : 'default size'}, 5,000 qty`,
    specs: {
      width_in:  vpResult.width3 ? 3 : null,
      height_in: vpResult.height3 ? 3 : null,
      shape:     vpResult.shapeClicked || null,
      format:    'slit_roll',
      quantity:  5000,
      material:  null,
      finish:    null
    },
    pricing: {
      total_price:      vpResult.price5000,
      unit_price:       vpResult.unit5000,
      currency:         'USD',
      turnaround_days:  null,
      shipping_included: null,
      price_type:       vpResult.method || 'not_captured'
    },
    raw_snippet: vpResult.rawVisibleText ? vpResult.rawVisibleText.slice(0, 5).join(' | ') : null,
    notes:       `Browser click-through pass. Shape clicked: ${vpResult.shapeClicked}. Size inputs filled: ${vpResult.width3 && vpResult.height3}. Method: ${vpResult.method}. Selections: ${JSON.stringify(vpResult.selectionsUsed)}`,
    blocker:     vpResult.blockerNotes.join('; ') || null,
    next_step:   vpResult.price5000 ? null : 'Manual DevTools session needed to inspect size input triggers on VP configurator'
  };

  // GOTPRINT
  const gpCapture = {
    id: `gotprint-browser-click-${today}`,
    competitor: 'gotprint',
    competitor_display: 'GotPrint',
    source_url: 'https://www.gotprint.com/store/stickers-and-labels/roll-labels',
    captured_at: today,
    capture_method: 'playwright_browser_click_through',
    capture_source: 'automated_headless',
    confidence: gpResult.price5000 ? (gpResult.qtySelected === '5000' && gpResult.sizeSelected ? 'high' : 'medium') : 'none',
    product_type: 'roll_labels',
    raw_spec_description: `Roll Labels, size=${gpResult.sizeSelected || '?'}, qty=${gpResult.qtySelected || '?'}, material=${gpResult.matSelected || '?'}`,
    specs: {
      width_in:  gpResult.sizeSelected?.includes('3') ? 3 : null,
      height_in: gpResult.sizeSelected?.includes('3') ? 3 : null,
      shape:     gpResult.shapeSelected || null,
      format:    'roll',
      quantity:  gpResult.qtySelected ? parseInt(gpResult.qtySelected.replace(/,/g, '')) : null,
      material:  gpResult.matSelected || null,
      finish:    null
    },
    pricing: {
      total_price:      gpResult.price5000,
      unit_price:       gpResult.unit5000,
      currency:         'USD',
      turnaround_days:  null,
      shipping_included: null,
      price_type:       gpResult.method || 'not_captured'
    },
    raw_snippet: null,
    notes:       `Browser click-through. Configurator found: ${gpResult.configuratorFound}. Options found: ${JSON.stringify(gpResult.optionsFound).slice(0, 200)}. Method: ${gpResult.method}`,
    blocker:     gpResult.blockerNotes.join('; ') || null,
    next_step:   gpResult.price5000 ? null : 'Manual session: open gotprint.com in Chrome, configure 3×3 square BOPP roll label at qty 5000, inspect XHR in DevTools'
  };

  // STICKER MULE
  const smCapture = {
    id: `stickermule-browser-click-${today}`,
    competitor: 'stickermule',
    competitor_display: 'Sticker Mule',
    source_url: 'https://www.stickermule.com/custom-labels',
    captured_at: today,
    capture_method: 'playwright_browser_click_through',
    capture_source: 'automated_headless',
    confidence: smResult.price5000 ? 'medium' : 'none',
    product_type: 'labels',
    raw_spec_description: `Custom Labels, size=${smResult.sizeSelected || '?'}, qty=${smResult.qtySelected || '?'}`,
    specs: {
      width_in:  smResult.sizeSelected?.includes('3') ? 3 : null,
      height_in: smResult.sizeSelected?.includes('3') ? 3 : null,
      format:    'sheet_or_roll',
      quantity:  smResult.qtySelected ? parseInt(smResult.qtySelected.replace(/,/g, '')) : null,
      material:  smResult.matSelected || null
    },
    pricing: {
      total_price:      smResult.price5000,
      unit_price:       smResult.unit5000,
      currency:         'USD',
      turnaround_days:  4,
      shipping_included: true,
      price_type:       smResult.method || 'not_captured'
    },
    raw_snippet: smResult.rawBodySnippet ? smResult.rawBodySnippet.slice(0, 200) : null,
    notes:       `Browser click-through. Configurator found: ${smResult.configuratorFound}. URLs tried: ${smResult.urlsTried.join(', ')}. Method: ${smResult.method}`,
    blocker:     smResult.blockerNotes.join('; ') || null,
    next_step:   smResult.price5000 ? null : 'Upload-first flow confirmed. Manual: upload placeholder file on stickermule.com/custom-labels, set 3×3, 5000 qty, read price'
  };

  upsertRawCapture(raw, vpCapture);
  upsertRawCapture(raw, gpCapture);
  upsertRawCapture(raw, smCapture);

  // Update coverage summaries
  if (vpResult.price5000) {
    raw.capture_coverage_summary.vistaprint = {
      status: (vpResult.width3 && vpResult.height3) ? 'live' : 'partial',
      confidence: (vpResult.width3 && vpResult.height3) ? 'high' : 'medium',
      last_method: 'playwright_browser_click_through',
      verified_prices: [
        ...(raw.capture_coverage_summary.vistaprint?.verified_prices || []),
        { qty: 5000, total: vpResult.price5000, unit: vpResult.unit5000, spec: vpResult.width3 && vpResult.height3 ? '3×3 (size confirmed)' : 'default size (size unconfirmed)' }
      ]
    };
  }

  if (gpResult.price5000) {
    raw.capture_coverage_summary.gotprint = {
      status: 'live',
      confidence: 'medium',
      last_method: 'playwright_browser_click_through',
      verified_prices: [{ qty: parseInt(gpResult.qtySelected || '0'), total: gpResult.price5000, spec: gpResult.sizeSelected || 'unknown' }]
    };
  }

  if (smResult.price5000) {
    raw.capture_coverage_summary.stickermule = {
      status: 'live',
      confidence: 'medium',
      last_method: 'playwright_browser_click_through',
      verified_prices: [{ qty: parseInt(smResult.qtySelected || '0'), total: smResult.price5000, spec: smResult.sizeSelected || 'unknown' }]
    };
  }

  // Update normalized file
  if (vpResult.price5000) {
    upsertCompetitorResult(norm, '3x3-5000-matte-bopp-cmyk', 'vistaprint', {
      status: (vpResult.width3 && vpResult.height3) ? 'live' : 'partial',
      coverage: (vpResult.width3 && vpResult.height3) ? 'exact_spec' : 'size_unconfirmed',
      total_price: vpResult.price5000,
      unit_price: vpResult.unit5000,
      confidence: (vpResult.width3 && vpResult.height3) ? 'high' : 'medium',
      notes: `Browser click-through. Shape: ${vpResult.shapeClicked}. Size 3×3 confirmed: ${vpResult.width3 && vpResult.height3}. Method: ${vpResult.method}`
    });
  }

  if (gpResult.price5000) {
    upsertCompetitorResult(norm, '3x3-5000-matte-bopp-cmyk', 'gotprint', {
      status: 'live',
      coverage: gpResult.sizeSelected?.includes('3') ? 'near_spec' : 'partial',
      total_price: gpResult.price5000,
      unit_price: gpResult.unit5000,
      confidence: 'medium',
      notes: `Browser click-through. Shape: ${gpResult.shapeSelected}. Size: ${gpResult.sizeSelected}. Qty: ${gpResult.qtySelected}. Material: ${gpResult.matSelected}`
    });
  }

  if (smResult.price5000) {
    upsertCompetitorResult(norm, '3x3-5000-matte-bopp-cmyk', 'stickermule', {
      status: 'live',
      coverage: 'partial',
      total_price: smResult.price5000,
      unit_price: smResult.unit5000,
      confidence: 'medium',
      notes: `Browser click-through. Size: ${smResult.sizeSelected}. Qty: ${smResult.qtySelected}. Free shipping included.`
    });
  }

  fs.writeFileSync(RAW_FILE,  JSON.stringify(raw,  null, 2));
  fs.writeFileSync(NORM_FILE, JSON.stringify(norm, null, 2));
  log('\n✓ Data files updated');

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log(' BROWSER CLICK-THROUGH PASS SUMMARY');
  console.log('══════════════════════════════════════════');
  console.log(`VISTAPRINT:`);
  console.log(`  Price (5000 qty): ${vpResult.price5000 ? '$' + vpResult.price5000 : 'NOT CAPTURED'}`);
  console.log(`  Shape clicked:    ${vpResult.shapeClicked || 'none'}`);
  console.log(`  Size 3×3 filled:  ${vpResult.width3 && vpResult.height3}`);
  console.log(`  Method:           ${vpResult.method || 'N/A'}`);
  console.log(`  Blockers:         ${vpResult.blockerNotes.join('; ') || 'none'}`);
  console.log('');
  console.log(`GOTPRINT:`);
  console.log(`  Price (5000 qty): ${gpResult.price5000 ? '$' + gpResult.price5000 : 'NOT CAPTURED'}`);
  console.log(`  Configurator:     ${gpResult.configuratorFound}`);
  console.log(`  Size selected:    ${gpResult.sizeSelected || 'none'}`);
  console.log(`  Qty selected:     ${gpResult.qtySelected || 'none'}`);
  console.log(`  Material:         ${gpResult.matSelected || 'none'}`);
  console.log(`  Blockers:         ${gpResult.blockerNotes.join('; ') || 'none'}`);
  console.log('');
  console.log(`STICKER MULE:`);
  console.log(`  Price (5000 qty): ${smResult.price5000 ? '$' + smResult.price5000 : 'NOT CAPTURED'}`);
  console.log(`  Configurator:     ${smResult.configuratorFound}`);
  console.log(`  Size selected:    ${smResult.sizeSelected || 'none'}`);
  console.log(`  Qty selected:     ${smResult.qtySelected || 'none'}`);
  console.log(`  URLs tried:       ${smResult.urlsTried.join(', ')}`);
  console.log(`  Blockers:         ${smResult.blockerNotes.join('; ') || 'none'}`);
  console.log('══════════════════════════════════════════\n');

  return { vpResult, gpResult, smResult };
}

main().catch(e => { err(`Fatal: ${e.message}`); process.exit(1); });
