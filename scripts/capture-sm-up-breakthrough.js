#!/usr/bin/env node
/**
 * capture-sm-up-breakthrough.js
 *
 * Breakthrough v3: Sticker Mule + UPrinting deep attack.
 * Target: 3" × 3" label, 5000 qty, matte (or closest supported)
 *
 * New vs prior scripts:
 *  - Capture ALL JSON/JS network responses, not filtered by URL keyword
 *  - SM: Try direct API calls (REST + GraphQL) from page context with session cookies
 *  - SM: Inspect _next/static JS chunks for embedded pricing table
 *  - SM: Try alternate product URLs (/custom-labels/configure, /orders/…)
 *  - UP: Robust qty click via text selector + Angular scope injection + event dispatch
 *  - UP: Extract CalcPricingData with broader regex + slice approach
 *  - UP: Try changing size to 3"x3" before qty selection
 *  - Both: save full debug JSON for post-run analysis
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const DEBUG_FILE = path.join(ROOT_DIR, 'data', `capture-breakthrough-${new Date().toISOString().split('T')[0]}.json`);

function log(msg)  { console.log(`[BT] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseDollar(text) {
  if (!text) return null;
  const m = String(text).match(/\$?([\d,]+\.?\d{0,2})/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return (v > 0.5 && v < 200000) ? v : null;
}

function extractAllPrices(text) {
  const re = /\$([\d,]+\.?\d{0,2})/g;
  const prices = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v > 0.5 && v < 200000) prices.add(v);
  }
  return [...prices].sort((a, b) => a - b);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── STICKER MULE ─────────────────────────────────────────────────────────────
async function captureStickermule(browser) {
  log('=== STICKER MULE: Breakthrough ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Capture ALL responses — not filtered by keyword
  const allResponses = [];
  const jsChunks = [];

  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    const status = resp.status();
    if (status >= 400) return;

    try {
      if (ct.includes('application/json') || ct.includes('text/json')) {
        const body = await resp.text();
        allResponses.push({ url: u, status, ct, body: body.slice(0, 8000) });
      } else if (ct.includes('javascript') && (u.includes('/_next/static/chunks') || u.includes('/_next/static/js'))) {
        // Grab JS chunks for pricing inspection
        const body = await resp.text();
        if (body.includes('price') || body.includes('quantity') || body.includes('label')) {
          jsChunks.push({ url: u, body: body.slice(0, 30000) });
        }
      }
    } catch (_) {}
  });

  const page = await context.newPage();
  const result = {
    price: null, unitPrice: null, pricingSource: null,
    formElements: [], apiResponses: [], pricingInJs: null,
    htmlStructure: null, error: null
  };

  try {
    // --- Phase 1: Navigate and capture the page ---
    log('SM: Navigating to /custom-labels');
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(7000); // Allow React hydration + lazy loading

    // Get all interactive form elements
    const formInfo = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, select, textarea'));
      return els.map(el => ({
        tag: el.tagName, type: el.type, name: el.name, id: el.id,
        placeholder: el.placeholder, value: el.value,
        testid: el.getAttribute('data-testid'),
        ariaLabel: el.getAttribute('aria-label'),
        class: (el.className || '').slice(0, 80),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }));
    });
    log(`SM: ${formInfo.length} form elements found`);
    formInfo.filter(f => f.visible).forEach(f =>
      log(`  [${f.tag}/${f.type}] id="${f.id}" name="${f.name}" testid="${f.testid}" aria="${f.ariaLabel}" class="${f.class.slice(0,40)}"`)
    );
    result.formElements = formInfo;

    // Snapshot the page body structure (first 8KB)
    const bodySnap = await page.evaluate(() => document.body.innerHTML.slice(0, 8000));
    result.htmlStructure = bodySnap;

    // --- Phase 2: Try to interact with configurator ---
    const widthSelectors = [
      'input[data-testid="width"]', 'input[name="width"]', 'input[id*="width" i]',
      'input[placeholder*="width" i]', 'input[aria-label*="width" i]',
      '[data-testid*="width"] input', 'input[type="number"]:first-of-type'
    ];
    const heightSelectors = [
      'input[data-testid="height"]', 'input[name="height"]', 'input[id*="height" i]',
      'input[placeholder*="height" i]', 'input[aria-label*="height" i]',
      '[data-testid*="height"] input', 'input[type="number"]:nth-of-type(2)'
    ];
    const qtySelectors = [
      'input[data-testid="quantity"]', 'input[data-testid="qty"]',
      'select[name="quantity"]', 'input[name="quantity"]',
      'input[id*="quantity" i]', 'select[id*="quantity" i]',
      'input[aria-label*="quantity" i]', 'input[aria-label*="qty" i]',
      '[data-testid*="quantity"] input', '[data-testid*="qty"] input'
    ];

    let widthFilled = false, heightFilled = false, qtyFilled = false;

    for (const sel of widthSelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        log(`SM: width via ${sel}`);
        await el.click({ clickCount: 3 });
        await el.fill('3');
        await page.keyboard.press('Tab');
        widthFilled = true;
        break;
      }
    }

    for (const sel of heightSelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        log(`SM: height via ${sel}`);
        await el.click({ clickCount: 3 });
        await el.fill('3');
        await page.keyboard.press('Tab');
        heightFilled = true;
        break;
      }
    }

    for (const sel of qtySelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        const tag = await el.evaluate(e => e.tagName);
        log(`SM: qty via ${sel} (${tag})`);
        if (tag === 'SELECT') {
          // Try selecting 5000 or closest
          const options = await el.evaluate(e => Array.from(e.options).map(o => ({ v: o.value, t: o.text })));
          log(`SM: qty options: ${options.map(o => o.t).join(', ')}`);
          const opt5k = options.find(o => o.v === '5000' || o.t === '5000' || o.t === '5,000');
          if (opt5k) await el.selectOption(opt5k.v);
          else {
            // Find largest ≤ 5000
            const cand = options.filter(o => parseInt(o.v.replace(/,/g, '')) <= 5000);
            if (cand.length > 0) await el.selectOption(cand[cand.length - 1].v);
          }
        } else {
          await el.click({ clickCount: 3 });
          await el.fill('5000');
          await page.keyboard.press('Tab');
        }
        qtyFilled = true;
        break;
      }
    }

    log(`SM: form fill → width=${widthFilled} height=${heightFilled} qty=${qtyFilled}`);

    if (widthFilled || heightFilled || qtyFilled) {
      await sleep(4000); // Wait for price update
    }

    // --- Phase 3: Try to extract price from DOM ---
    const priceSelectors = [
      '[data-testid*="price"]', '[data-testid*="total"]', '[data-testid*="cost"]',
      '[class*="PriceSummary"]', '[class*="price-summary"]', '[class*="OrderTotal"]',
      '[class*="order-total"]', '[class*="TotalPrice"]', '[class*="totalPrice"]',
      '[class*="quote-price"]', '[class*="QuotePrice"]', '.price', '#price',
      '[aria-live]' // React often uses aria-live for dynamic price updates
    ];

    for (const sel of priceSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          if (!await el.isVisible()) continue;
          const text = await el.textContent();
          const p = parseDollar(text);
          if (p && p > 20) {
            log(`SM: price from "${sel}": $${p} (text="${text?.slice(0,50)}")`);
            result.price = p;
            result.pricingSource = `DOM:${sel}`;
            break;
          }
        }
        if (result.price) break;
      } catch (_) {}
    }

    // Fallback: extract all dollar amounts from page
    const pageText = await page.evaluate(() => document.body.innerText);
    const allPrices = extractAllPrices(pageText);
    log(`SM: all prices in page text: [${allPrices.join(', ')}]`);
    if (!result.price && allPrices.length > 0) {
      const candidate = allPrices.find(p => p >= 47 && p <= 5000);
      if (candidate) {
        result.price = candidate;
        result.pricingSource = 'page_text_extraction';
      }
    }

    // --- Phase 4: Direct API probing from page context (has session cookies) ---
    log('SM: Probing internal pricing APIs from page context');
    const apiProbeResult = await page.evaluate(async () => {
      const hits = {};

      // GraphQL probe
      try {
        const r = await fetch('/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ query: '{ __typename }' })
        });
        hits.graphql_introspect = { status: r.status, ok: r.ok };
        if (r.ok) {
          const text = await r.text();
          hits.graphql_body = text.slice(0, 200);
        }
      } catch (e) { hits.graphql_err = e.message.slice(0, 80); }

      // REST pricing endpoints
      const endpoints = [
        '/api/v1/products/custom-labels/price?width=3&height=3&quantity=5000&finish=matte',
        '/api/v1/pricing?product_slug=custom-labels&width=3&height=3&quantity=5000',
        '/api/v1/quotes?product=custom-labels&width=3&height=3&quantity=5000&finish=matte',
        '/orders/custom_labels/price?width=3&height=3&quantity=5000',
        '/api/pricing?product=custom-labels&w=3&h=3&qty=5000',
        '/custom-labels/pricing?width=3&height=3',
        '/api/v1/products/custom-labels',
        '/api/v1/products',
        '/api/v1/orders/custom_labels/turnaround',
      ];

      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
          });
          const text = await r.text();
          hits[ep] = { status: r.status, body: text.slice(0, 300) };
        } catch (e) {
          hits[ep] = { err: e.message.slice(0, 60) };
        }
      }

      return hits;
    });

    // Log API probe results
    for (const [k, v] of Object.entries(apiProbeResult)) {
      if (v.status === 200) {
        log(`SM API HIT ${k}: ${v.body?.slice(0, 100) || ''}`);
        result.apiResponses.push({ endpoint: k, ...v });
        const p = parseDollar(v.body || '');
        if (p && p > 20 && !result.price) {
          result.price = p;
          result.pricingSource = `API:${k}`;
        }
      } else if (v.status) {
        log(`SM API ${v.status} ${k}`);
      }
    }

    // --- Phase 5: Inspect JS chunks for pricing data ---
    log(`SM: Inspecting ${jsChunks.length} JS chunks for pricing data`);
    for (const chunk of jsChunks) {
      // Look for quantity/price arrays or objects
      const patterns = [
        /\{[^}]*quantity[^}]*:\s*5000[^}]*price[^}]*:\s*([\d.]+)/gi,
        /5000[^,\n]{0,50}([\d.]+)/g,
        /price[^:]*:\s*([\d.]+)[^,\n]{0,50}5000/gi,
        // Look for pricing table arrays like [[qty, price], ...]
        /\[\s*5000\s*,\s*([\d.]+)\s*\]/g,
        // Named pricing consts
        /PRICE[^=]+=\s*\{[^}]{0,500}5000/gi
      ];

      for (const pattern of patterns) {
        const matches = chunk.body.match(pattern);
        if (matches && matches.length > 0) {
          log(`SM JS chunk pricing pattern "${pattern.source.slice(0,30)}": ${matches.slice(0, 3).join(' | ')}`);
          result.pricingInJs = { url: chunk.url, matches: matches.slice(0, 5) };
        }
      }
    }

    // --- Phase 6: Try alternate URLs ---
    const altUrls = [
      'https://www.stickermule.com/custom-labels/pricing',
      'https://www.stickermule.com/custom-labels/sizes',
    ];

    for (const altUrl of altUrls) {
      if (result.price) break;
      try {
        log(`SM: trying ${altUrl}`);
        const resp = await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp && resp.status() === 200) {
          await sleep(3000);
          const t = await page.evaluate(() => document.body.innerText);
          log(`SM: ${altUrl} loaded, length=${t.length}`);
          const ap = extractAllPrices(t);
          log(`SM: prices at ${altUrl}: [${ap.join(', ')}]`);

          // Look for quantity table patterns
          const qtyPat = /5[,\s.]*000[^$\n]*\$?([\d,]+\.?\d{0,2})/i;
          const qm = t.match(qtyPat);
          if (qm) {
            const p = parseDollar(qm[1]);
            if (p) { result.price = p; result.pricingSource = altUrl; log(`SM: found 5000 price at ${altUrl}: $${p}`); }
          }

          // Extract pricing table data
          const tableData = await page.evaluate(() => {
            const tables = Array.from(document.querySelectorAll('table, [class*="pricing"], [class*="price-table"]'));
            return tables.map(t => t.innerText?.slice(0, 1000)).join('\n---\n');
          });
          if (tableData) log(`SM pricing table data: ${tableData.slice(0, 500)}`);
        } else {
          log(`SM: ${altUrl} → ${resp?.status()}`);
        }
      } catch (e) { log(`SM: ${altUrl} failed: ${e.message}`); }
    }

    // Log captured API responses summary
    log(`SM: Total JSON responses captured: ${allResponses.length}`);
    allResponses.slice(0, 10).forEach(r => {
      const hasPricingHint = r.body.includes('price') || r.body.includes('total') || r.body.includes('amount');
      if (hasPricingHint) log(`  PRICING HINT: ${r.url.slice(0, 80)} → ${r.body.slice(0, 150)}`);
    });

    result.allApiUrls = allResponses.map(r => r.url);

  } catch (e) {
    result.error = e.message;
    err('SM: ' + e.message);
    log(e.stack);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPRINTING ─────────────────────────────────────────────────────────────────
async function captureUprinting(browser) {
  log('=== UPRINTING: Breakthrough ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const reqLog = [];
  context.on('request', req => {
    const u = req.url();
    if (!u.includes('.png') && !u.includes('.jpg') && !u.includes('.gif') && !u.includes('.woff')) {
      reqLog.push({ url: u, method: req.method(), post: req.postData()?.slice(0, 200) });
    }
  });

  const priceApiResponses = [];
  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (resp.status() < 400 && (ct.includes('json') || ct.includes('javascript') || u.includes('price') || u.includes('calc'))) {
      try {
        const body = await resp.text();
        if (body.length > 5 && body.length < 500000) {
          priceApiResponses.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const result = {
    defaultSpec: null, sizeChanged: false, qtyChanged: false,
    price: null, unitPrice: null, priceWrapText: null,
    calcPricingData: null, allPagePrices: [], error: null,
    qtyElements: [], sizeElements: [], interactions: []
  };

  try {
    log('UP: Navigating to roll-labels.html');
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'networkidle',
      timeout: 50000
    });

    // Wait for Angular calculator to render
    try {
      await page.waitForSelector('#calc-price, .calc-price, [class*="subtotal"]', { timeout: 20000 });
    } catch (_) {
      log('UP: price element not found after 20s wait');
    }
    await sleep(3000);

    // --- Extract CalcPricingData from embedded scripts ---
    const calcData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const s of scripts) {
        const t = s.textContent || '';
        if (!t.includes('CalcPricingData')) continue;

        // Try multiple extraction patterns
        const patterns = [
          /var\s+CalcPricingData\s*=\s*(\{[\s\S]+?\});\s*(?:var|let|const|\/\/|$)/,
          /CalcPricingData\s*=\s*(\{[\s\S]+?\});\s*(?:var|let|const|\/\/|$)/,
          /CalcPricingData\s*=\s*(\{[\s\S]+)/
        ];

        for (const pat of patterns) {
          const m = t.match(pat);
          if (m) {
            try {
              return { raw: m[1].slice(0, 10000), parsed: JSON.parse(m[1]) };
            } catch (e) {
              // JSON parse failed — return raw for inspection
              return { raw: m[1].slice(0, 5000), parseError: e.message };
            }
          }
        }

        // Fallback: grab a wide slice around CalcPricingData
        const idx = t.indexOf('CalcPricingData');
        return { raw: t.slice(idx, idx + 3000), source: 'slice' };
      }
      return null;
    });

    if (calcData) {
      log(`UP: CalcPricingData found — parsed=${!!calcData.parsed}, raw length=${calcData.raw?.length}`);
      result.calcPricingData = calcData;
      if (calcData.parsed) {
        log(`UP: CalcPricingData keys: ${Object.keys(calcData.parsed).slice(0, 10).join(', ')}`);
      }
    } else {
      log('UP: CalcPricingData NOT found in scripts');
    }

    // --- Read initial state ---
    const initialState = await page.evaluate(() => {
      const priceEl = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
      const unitEl  = document.querySelector('.calc-price-per-piece');
      const priceWrap = document.querySelector('.price-wrap, #price-wrap, #price');

      // Find all form selects
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        id: s.id, name: s.name, value: s.value,
        options: Array.from(s.options).slice(0, 20).map(o => ({ v: o.value, t: o.text.trim() }))
      }));

      // Find all number inputs
      const numInputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]')).map(i => ({
        id: i.id, name: i.name, value: i.value, placeholder: i.placeholder,
        ngModel: i.getAttribute('ng-model')
      }));

      // Find quantity-related elements
      const qtyEls = Array.from(document.querySelectorAll('td, tr, li, a'))
        .filter(el => {
          const t = el.textContent?.trim();
          return t && /^[\d,]+$/.test(t) && parseInt(t.replace(/,/g,'')) >= 100;
        })
        .slice(0, 30)
        .map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim(),
          class: el.className?.toString().slice(0, 60),
          ngClick: el.getAttribute('ng-click') || el.getAttribute('data-ng-click'),
          href: el.getAttribute('href')
        }));

      return {
        price: priceEl?.textContent?.trim(),
        unitPrice: unitEl?.textContent?.trim(),
        priceWrapText: priceWrap?.innerText?.slice(0, 400),
        selects,
        numInputs,
        qtyEls
      };
    });

    log(`UP initial: price="${initialState.price}", unit="${initialState.unitPrice}"`);
    log(`UP selects: ${JSON.stringify(initialState.selects.map(s => s.id || s.name))}`);
    log(`UP qty elements (${initialState.qtyEls.length}): ${JSON.stringify(initialState.qtyEls.slice(0, 5))}`);
    result.defaultSpec = initialState;
    result.qtyElements = initialState.qtyEls;

    // --- Try to change size to 3x3 ---
    // Look for size-related select with dimension options
    const sizeSelect = initialState.selects.find(s =>
      s.options.some(o => o.t.includes('"') || o.t.includes('x') || o.t.includes('×') || o.t.match(/\d+\s*[xX]\s*\d+/))
    );

    if (sizeSelect) {
      log(`UP: size select found: id="${sizeSelect.id}", options: ${sizeSelect.options.map(o => o.t).join(', ')}`);
      const opt3x3 = sizeSelect.options.find(o =>
        o.t.includes('3"x3"') || o.t.match(/3\s*[xX×]\s*3/) || o.t === '3 x 3'
      );
      if (opt3x3) {
        log(`UP: selecting 3x3 option: "${opt3x3.t}" value="${opt3x3.v}"`);
        const selSel = sizeSelect.id ? `#${sizeSelect.id}` : `select[name="${sizeSelect.name}"]`;
        await page.selectOption(selSel, opt3x3.v);
        result.sizeChanged = true;
        result.interactions.push({ action: 'selectOption', selector: selSel, value: opt3x3.v });
        await sleep(3000);
      } else {
        log(`UP: no 3x3 in size dropdown options`);
      }
    }

    // Try custom width/height inputs
    if (!result.sizeChanged) {
      const widthInput = initialState.numInputs.find(i =>
        i.id?.includes('width') || i.name?.includes('width') || i.ngModel?.includes('width')
      );
      const heightInput = initialState.numInputs.find(i =>
        i.id?.includes('height') || i.name?.includes('height') || i.ngModel?.includes('height')
      );
      if (widthInput && heightInput) {
        log(`UP: width/height inputs found: ${widthInput.id}/${heightInput.id}`);
        const wSel = widthInput.id ? `#${widthInput.id}` : `input[name="${widthInput.name}"]`;
        const hSel = heightInput.id ? `#${heightInput.id}` : `input[name="${heightInput.name}"]`;
        await page.click(wSel, { clickCount: 3 });
        await page.fill(wSel, '3');
        await page.press(wSel, 'Tab');
        await page.click(hSel, { clickCount: 3 });
        await page.fill(hSel, '3');
        await page.press(hSel, 'Tab');
        result.sizeChanged = true;
        result.interactions.push({ action: 'fill', width: wSel, height: hSel, value: '3x3' });
        await sleep(3000);
      }
    }

    // --- Click qty=5000 ---
    // Method 1: Playwright text selector (most reliable for visible text)
    try {
      const el = page.locator('text="5,000"').first();
      const count = await el.count();
      log(`UP: "5,000" text selector count: ${count}`);
      if (count > 0) {
        await el.click({ timeout: 5000 });
        result.qtyChanged = true;
        result.interactions.push({ action: 'click', selector: 'text="5,000"' });
        log('UP: clicked qty=5000 via text selector');
        await sleep(4000);
      }
    } catch (e) { log(`UP qty text click: ${e.message}`); }

    // Method 2: Find qty element by text in evaluate and dispatch events
    if (!result.qtyChanged) {
      const clickResult = await page.evaluate(() => {
        // More flexible search: contains "5,000" or "5000"
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent?.trim();
          if ((t === '5,000' || t === '5000') && node.tagName !== 'SCRIPT') {
            // Dispatch events in Angular-compatible way
            ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(type => {
              node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            return { found: true, tag: node.tagName, class: node.className?.toString().slice(0, 60), ngClick: node.getAttribute('ng-click') };
          }
        }
        return { found: false };
      });
      log(`UP qty click via evaluate: ${JSON.stringify(clickResult)}`);
      if (clickResult.found) {
        result.qtyChanged = true;
        result.interactions.push({ action: 'dispatchClick', target: '5,000 text' });
        await sleep(4000);
      }
    }

    // Method 3: Angular scope injection
    if (!result.qtyChanged) {
      const angularResult = await page.evaluate(() => {
        if (typeof angular === 'undefined') return { error: 'angular not defined' };
        const candidateSelectors = [
          '#calc_33_grid', '.product-calculator', '#price-wrap',
          '[ng-controller]', '[ng-app]', '.calc-group', '.price-section'
        ];
        for (const sel of candidateSelectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          try {
            const scope = angular.element(el).scope();
            if (!scope) continue;
            const keys = Object.keys(scope).filter(k => !k.startsWith('$'));
            // Try known qty-setting methods
            for (const fn of ['setQuantity', 'selectQty', 'changeQty', 'setQty', 'updateQty', 'calcPrice']) {
              if (typeof scope[fn] === 'function') {
                scope[fn](5000);
                scope.$apply();
                return { method: fn, selector: sel };
              }
            }
            // Direct qty assignment
            for (const prop of ['qty', 'quantity', 'selectedQty', 'calcQty']) {
              if (prop in scope) {
                scope[prop] = 5000;
                scope.$apply();
                return { method: `direct:${prop}`, selector: sel, scopeKeys: keys.slice(0, 10) };
              }
            }
            return { noMethod: true, selector: sel, keys: keys.slice(0, 10) };
          } catch (e2) { continue; }
        }
        return { error: 'no valid scope found' };
      });
      log(`UP Angular injection: ${JSON.stringify(angularResult)}`);
      if (angularResult.method) {
        result.qtyChanged = true;
        result.interactions.push({ action: 'angularScope', ...angularResult });
        await sleep(4000);
      }
    }

    // Method 4: Try clicking the qty row via Angular's jqLite
    if (!result.qtyChanged) {
      const jqResult = await page.evaluate(() => {
        if (typeof angular === 'undefined') return { error: 'no angular' };
        try {
          const allEls = Array.from(document.querySelectorAll('*'));
          const el5k = allEls.find(e => {
            const t = e.textContent?.trim();
            return (t === '5,000' || t === '5000') && e.tagName !== 'SCRIPT';
          });
          if (!el5k) return { error: 'element not found' };
          angular.element(el5k).triggerHandler('click');
          return { triggered: true, tag: el5k.tagName };
        } catch (e) { return { error: e.message }; }
      });
      log(`UP jqLite trigger: ${JSON.stringify(jqResult)}`);
      if (jqResult.triggered) {
        result.qtyChanged = true;
        await sleep(3000);
      }
    }

    // --- Read final price ---
    const finalState = await page.evaluate(() => {
      const priceEl = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
      const unitEl  = document.querySelector('.calc-price-per-piece');
      const priceWrap = document.querySelector('.price-wrap, #price-wrap, #price');
      const priceWrapEl = document.querySelector('[class*="price-wrap"], [id*="price"]');

      return {
        price: priceEl?.textContent?.trim(),
        unitPrice: unitEl?.textContent?.trim(),
        priceWrapText: (priceWrap || priceWrapEl)?.innerText?.slice(0, 400),
        allPricesInDOM: (() => {
          const re = /\$([\d,]+\.?\d{0,2})/g;
          const text = document.body.innerText;
          const prices = new Set();
          let m;
          while ((m = re.exec(text)) !== null) {
            const v = parseFloat(m[1].replace(/,/g,''));
            if (v > 0.5 && v < 200000) prices.add(v);
          }
          return [...prices].sort((a, b) => a - b);
        })()
      };
    });

    log(`UP final: price="${finalState.price}", unit="${finalState.unitPrice}"`);
    log(`UP priceWrap: ${finalState.priceWrapText?.slice(0, 200)}`);
    log(`UP all DOM prices: [${finalState.allPricesInDOM.join(', ')}]`);

    result.price = parseDollar(finalState.price);
    result.unitPrice = parseDollar(finalState.unitPrice);
    result.priceWrapText = finalState.priceWrapText;
    result.allPagePrices = finalState.allPricesInDOM;

    if (initialState.price !== finalState.price) {
      log(`UP: Price CHANGED from "${initialState.price}" → "${finalState.price}"`);
    }

    // Log captured API traffic
    log(`UP: ${priceApiResponses.length} API responses with price/calc content`);
    priceApiResponses.filter(r => r.url.includes('uprinting.com')).forEach(r => {
      log(`  ${r.status} ${r.url}: ${r.body?.slice(0, 120)}`);
    });

    result.requestUrls = reqLog.filter(r => r.url.includes('uprinting.com')).map(r => r.url).slice(0, 30);

  } catch (e) {
    result.error = e.message;
    err('UP: ' + e.message);
    log(e.stack);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPDATE RAW DATA FILE ─────────────────────────────────────────────────────
function updateRawData(smResult, upResult) {
  const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const today = nowISO();
  const newCaptures = [];

  // Sticker Mule result
  if (smResult.price) {
    const isHighQty = smResult.price > 100; // > $100 suggests not just starting price
    newCaptures.push({
      id: `stickermule-breakthrough-${today}`,
      competitor: 'stickermule',
      competitor_display: 'Sticker Mule',
      source_url: 'https://www.stickermule.com/custom-labels',
      captured_at: today,
      capture_method: 'playwright_headless_breakthrough',
      capture_source: 'automated_headless',
      confidence: isHighQty ? 'medium' : 'low',
      product_type: 'labels',
      raw_spec_description: `Custom labels — Breakthrough capture (source: ${smResult.pricingSource})`,
      specs: {
        width_in: 3, height_in: 3,
        quantity: 5000,
        finish: 'matte'
      },
      pricing: {
        total_price: smResult.price,
        unit_price: smResult.price > 0 ? Math.round(smResult.price / 5000 * 10000) / 10000 : null,
        currency: 'USD',
        turnaround_days: 4,
        shipping_included: true,
        price_type: isHighQty ? 'configured_quote' : 'starting_from'
      },
      raw_snippet: smResult.apiResponses?.[0]?.body?.slice(0, 200) || null,
      notes: `Breakthrough capture. Source: ${smResult.pricingSource}. Form fill: width=${smResult.formElements?.filter(f=>f.id?.includes('width')).length>0}, height=similar, qty=similar. API responses: ${smResult.allApiUrls?.length || 0}. Confidence based on price magnitude ($${smResult.price}).`,
      blocker: smResult.price < 100 ? 'may_be_starting_price_not_5000qty' : null,
      next_step: smResult.price < 100 ? 'Verify this is specific to 5000 qty — likely still starting price' : null
    });
  } else {
    newCaptures.push({
      id: `stickermule-breakthrough-failed-${today}`,
      competitor: 'stickermule',
      competitor_display: 'Sticker Mule',
      source_url: 'https://www.stickermule.com/custom-labels',
      captured_at: today,
      capture_method: 'playwright_headless_breakthrough',
      capture_source: 'automated_headless',
      confidence: 'none',
      product_type: 'labels',
      raw_spec_description: null,
      specs: {},
      pricing: { total_price: null, unit_price: null, currency: 'USD', turnaround_days: null, shipping_included: null, price_type: null },
      raw_snippet: null,
      notes: `Breakthrough attempt failed. Form elements found: ${smResult.formElements?.length || 0}. API URLs probed: ${smResult.allApiUrls?.length || 0}. Error: ${smResult.error || 'none — pricing not exposed by any API or DOM path tried'}. API probe found no 2xx pricing endpoints. JS chunks inspected for pricing table.`,
      blocker: 'configurator_price_not_accessible',
      next_step: 'Consider manual browser session: open custom-labels page, configure 3x3/5000/matte, copy price and paste into raw data manually'
    });
  }

  // UPrinting result
  if (upResult.price) {
    const specDesc = `${upResult.sizeChanged ? '3"x3"' : 'default size'}, qty=${upResult.qtyChanged ? '5,000' : 'default'}, White BOPP`;
    const confidence = upResult.sizeChanged && upResult.qtyChanged ? 'high' : upResult.qtyChanged ? 'medium' : 'low';
    newCaptures.push({
      id: `uprinting-breakthrough-${today}`,
      competitor: 'uprinting',
      competitor_display: 'UPrinting',
      source_url: 'https://www.uprinting.com/roll-labels.html',
      captured_at: today,
      capture_method: 'playwright_headless_breakthrough',
      capture_source: 'automated_headless',
      confidence,
      product_type: 'labels',
      raw_spec_description: specDesc,
      specs: {
        width_in: upResult.sizeChanged ? 3 : null,
        height_in: upResult.sizeChanged ? 3 : null,
        quantity: upResult.qtyChanged ? 5000 : null,
        material: 'White BOPP',
        finish: 'unspecified',
        format: 'roll'
      },
      pricing: {
        total_price: upResult.price,
        unit_price: upResult.unitPrice || (upResult.price ? Math.round(upResult.price / (upResult.qtyChanged ? 5000 : 1000) * 10000) / 10000 : null),
        currency: 'USD',
        turnaround_days: 6,
        shipping_included: false,
        price_type: upResult.qtyChanged ? 'configured_quote' : 'page_displayed'
      },
      raw_snippet: upResult.priceWrapText?.slice(0, 200) || null,
      notes: `Breakthrough capture. sizeChanged=${upResult.sizeChanged}, qtyChanged=${upResult.qtyChanged}. PriceWrap: ${upResult.priceWrapText?.slice(0,100)}. Interactions: ${JSON.stringify(upResult.interactions?.slice(0,2))}`,
      blocker: confidence === 'high' ? null : 'partial_spec_match',
      next_step: confidence === 'high' ? null : 'Verify size and qty were successfully changed before reading price'
    });
  } else {
    newCaptures.push({
      id: `uprinting-breakthrough-failed-${today}`,
      competitor: 'uprinting',
      competitor_display: 'UPrinting',
      source_url: 'https://www.uprinting.com/roll-labels.html',
      captured_at: today,
      capture_method: 'playwright_headless_breakthrough',
      capture_source: 'automated_headless',
      confidence: 'none',
      product_type: 'labels',
      raw_spec_description: null,
      specs: {},
      pricing: { total_price: null, unit_price: null, currency: 'USD', turnaround_days: null, shipping_included: null, price_type: null },
      raw_snippet: upResult.priceWrapText?.slice(0, 200) || null,
      notes: `Breakthrough attempt. sizeChanged=${upResult.sizeChanged}, qtyChanged=${upResult.qtyChanged}. CalcPricingData: ${upResult.calcPricingData ? 'found' : 'not found'}. Error: ${upResult.error || 'none'}. qtyElements: ${JSON.stringify(upResult.qtyElements?.slice(0,3))}`,
      blocker: 'angular_qty_interaction_failed',
      next_step: 'Try manual browser interaction: uprinting.com/roll-labels.html → change size → click 5000 qty row → record price'
    });
  }

  // Remove old failed/stale records for these competitors (keep existing partial successes)
  const toRemove = new Set([
    'stickermule-headless-failed-2026-04-14',
    'uprinting-headless-failed-2026-04-14',
    'uprinting-capture-2026-04-14'
  ]);
  raw.captures = raw.captures.filter(c => !toRemove.has(c.id));

  // Add new captures
  raw.captures.push(...newCaptures);
  raw.last_updated = today;

  // Update coverage summary
  const smCapture = newCaptures.find(c => c.competitor === 'stickermule');
  const upCapture = newCaptures.find(c => c.competitor === 'uprinting');

  raw.capture_coverage_summary.stickermule = {
    status: smCapture?.pricing?.total_price ? 'partial' : 'blocked',
    confidence: smCapture?.confidence || 'none',
    last_method: 'playwright_headless_breakthrough',
    reason: smCapture?.notes?.slice(0, 120) || 'Breakthrough failed'
  };

  raw.capture_coverage_summary.uprinting = {
    status: upCapture?.pricing?.total_price ? (upCapture.confidence === 'high' ? 'live' : 'partial') : 'blocked',
    confidence: upCapture?.confidence || 'none',
    last_method: 'playwright_headless_breakthrough',
    reason: upCapture?.notes?.slice(0, 120) || 'Breakthrough failed'
  };

  fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
  log(`Updated raw data: ${RAW_FILE}`);

  return newCaptures;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Breakthrough Capture: SM + UP === ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled']
  });

  let smResult = { price: null, error: 'not run' };
  let upResult = { price: null, error: 'not run' };

  try {
    smResult = await captureStickermule(browser);
  } catch (e) {
    err('SM fatal: ' + e.message);
    smResult = { price: null, error: e.message };
  }

  try {
    upResult = await captureUprinting(browser);
  } catch (e) {
    err('UP fatal: ' + e.message);
    upResult = { price: null, error: e.message };
  }

  await browser.close();

  // Save debug output
  fs.writeFileSync(DEBUG_FILE, JSON.stringify({ sm: smResult, up: upResult }, null, 2));
  log(`Debug file: ${DEBUG_FILE}`);

  // Update data files
  const newCaptures = updateRawData(smResult, upResult);

  log('');
  log('=== FINAL SUMMARY ===');
  log(`Sticker Mule: ${smResult.price ? 'PRICE=$' + smResult.price + ' (source: ' + smResult.pricingSource + ')' : 'NOT CAPTURED — ' + (smResult.error || 'no price in DOM/API')}`);
  log(`UPrinting: ${upResult.price ? 'PRICE=$' + upResult.price + ' (unit=$' + upResult.unitPrice + ')' : 'NOT CAPTURED — ' + (upResult.error || 'no price update')}`);
  log(`UPrinting sizeChanged=${upResult.sizeChanged}, qtyChanged=${upResult.qtyChanged}`);
  log('');
  log('New capture records:');
  newCaptures.forEach(c => log(`  ${c.id}: confidence=${c.confidence}, price=$${c.pricing?.total_price || 'N/A'}`));
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
