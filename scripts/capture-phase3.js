#!/usr/bin/env node
/**
 * capture-phase3.js
 * PUL-288 Phase 3 — Fix targeted issues from Phase 2
 *
 * Issues:
 *   1. VP Flyers: intercepted Cimpress 200 but price path wrong — dump full body + fix parsing
 *   2. Axiom BC: finalPrice$25.70 in DOM but regex matched "Apr 27" — target finalPrice element
 *   3. UP Stickers: getEasyMapping has shape only, no size/qty — use computePrice with width/height
 *   4. GotPrint: Vue.js events not firing /prices XHR — try Playwright native select + wait for network
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const OUT  = path.join(ROOT, 'data', `capture-phase3-${new Date().toISOString().split('T')[0]}.json`);

const log  = m => console.log(`[p3]  ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

const rawData = {}; // Dump everything here for analysis
const confirmed = { business_cards: [], flyers_postcards: [], diecut_stickers: [] };

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1: UPrinting Die-Cut Stickers
// getEasyMapping only returns shape attrs — die-cut stickers use custom dimensions
// Approach: load the sticker page, intercept computePrice with circle shape + dimensions
// then try: attr10=60261 (circle) + width=3&height=3 directly
// ─────────────────────────────────────────────────────────────────────────────
async function fixUpStickers(browser) {
  log('\n=== [Fix 1] UPrinting Die-Cut Stickers ===');

  // First: probe getData/55 to see full attribute structure
  const dataR = await httpPost('https://calculator.digitalroom.com/v1/getData/55', {
    publishedVersion: true
  }, { 'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/die-cut-stickers.html' });
  log(`getData/55: status=${dataR.status}`);
  rawData.upGetData55 = dataR.body;

  // Look for dimension/size/qty attributes in the full getData response
  const attrData = dataR.body?.data || dataR.body?.attributes || dataR.body;
  if (Array.isArray(attrData)) {
    log(`getData attrs count: ${attrData.length}`);
    const dimensionAttrs = attrData.filter(a =>
      /width|height|size|qty|quantity|dimension/i.test(a.attribute_name || a.attribute_code || a.attr_value || '')
    );
    log(`Dimension/qty attrs: ${JSON.stringify(dimensionAttrs.slice(0, 20))}`);
  } else if (attrData && typeof attrData === 'object') {
    log(`getData keys: ${Object.keys(attrData).join(', ')}`);
    rawData.upGetData55_snippet = JSON.stringify(attrData).slice(0, 1000);
  }

  // Now try: computePrice with circle shape + custom width/height dimensions
  // UP die-cut sticker calculator typically uses width/height as separate params
  const testBodies = [
    // Attempt 1: shape attr + width/height as numeric fields
    { product_id: '55', attr10: '60261', width: '3', height: '3', qty: '100',
      productType: 'offset', publishedVersion: true, disableDataCache: true, disablePriceCache: true },
    // Attempt 2: shape + size as text, qty as text
    { product_id: '55', attr10: '60261', size: '3x3', qty: '100',
      productType: 'offset', publishedVersion: true, disableDataCache: true },
    // Attempt 3: no shape attr, just dimensions
    { product_id: '55', width: 3, height: 3, qty: 100,
      productType: 'offset', publishedVersion: true, disableDataCache: true },
  ];

  for (let i = 0; i < testBodies.length; i++) {
    const body = testBodies[i];
    log(`\nAttempt ${i+1}: ${JSON.stringify(body)}`);
    const r = await httpPost('https://calculator.digitalroom.com/v1/computePrice', body, {
      'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com',
      'Referer': 'https://www.uprinting.com/die-cut-stickers.html',
    });
    log(`  Status: ${r.status}`);
    if (r.status === 200) {
      log(`  Body: ${JSON.stringify(r.body).slice(0, 400)}`);
      rawData[`upSticker_attempt${i+1}`] = r.body;
      if (r.body?.total_price) {
        log(`  SUCCESS! total_price=${r.body.total_price}`);
      }
    } else {
      log(`  Error body: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    await wait(300);
  }

  // Last resort: load the actual sticker page and capture what computePrice is called with
  log('\nLoading UP sticker page to capture live API call...');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const calls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('digitalroom.com')) {
      try {
        const body = await resp.json().catch(() => resp.text());
        const reqBody = await resp.request().postBody()?.catch(() => null);
        calls.push({ url: u, status: resp.status(), body, reqBody });
        log(`  UP XHR: ${resp.request().method()} ${u.slice(0, 80)} → ${resp.status()}`);
        if (reqBody) log(`    Req: ${String(reqBody).slice(0, 200)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  await page.goto('https://www.uprinting.com/die-cut-stickers.html', { waitUntil: 'load', timeout: 30000 });
  await wait(8000);

  // Read current select state
  const selects = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select, [class*="dropdown"]')).slice(0, 10).map(s => ({
      tag: s.tagName, name: s.name, id: s.id,
      options: Array.from(s.options || []).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 8)
    }))
  );
  log(`Page selects: ${JSON.stringify(selects)}`);

  // Check for Angular scope / Vue data
  const appState = await page.evaluate(() => {
    // Angular
    try {
      const el = document.querySelector('[data-ng-app], [ng-app], .ng-scope');
      if (el) {
        const scope = angular?.element(el)?.scope?.();
        return { type: 'angular', data: JSON.stringify(scope?.product || scope?.calculator || {}).slice(0, 500) };
      }
    } catch(_) {}
    // Check for custom sticker configurator state
    try {
      const cfg = window.stickerConfig || window.ProductConfig || window.printConfig;
      if (cfg) return { type: 'config', data: JSON.stringify(cfg).slice(0, 500) };
    } catch(_) {}
    // Check page source for product info
    const scripts = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent?.slice(0, 200)).filter(t => /product_id|computePrice/i.test(t));
    return { type: 'scripts', scripts: scripts.slice(0, 3) };
  });
  log(`App state: ${JSON.stringify(appState)}`);

  rawData.upStickerPageCalls = calls;

  if (calls.length > 0) {
    log(`Captured ${calls.length} UP XHR calls`);
    for (const call of calls) {
      if (call.url.includes('computePrice') && call.body?.total_price) {
        log(`Found live computePrice: ${call.reqBody}`);
        log(`Price: ${call.body.total_price}`);
      }
    }
  }

  await page.close();
  await context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2: Vistaprint — dump actual Cimpress response bodies
// ─────────────────────────────────────────────────────────────────────────────
async function fixVP(browser) {
  log('\n=== [Fix 2] Vistaprint Cimpress response format ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') && u.includes('prices')) {
      try {
        const body = await resp.text();
        const reqHeaders = resp.request().headers();
        cimpressCalls.push({ url: u, status: resp.status(), body, headers: reqHeaders });
        log(`  Cimpress: ${resp.status()} ${u.slice(0, 100)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  // ── VP Business Cards
  log('Loading VP BC...');
  await page.goto('https://www.vistaprint.com/business-cards', { waitUntil: 'networkidle', timeout: 60000 });
  await wait(3000);

  // Try scrolling and interacting to trigger more Cimpress calls
  await page.evaluate(() => window.scrollBy(0, 400));
  await wait(2000);

  // Try clicking quantity options
  const bcCalls = [...cimpressCalls];
  log(`VP BC Cimpress calls: ${bcCalls.length}`);
  for (const c of bcCalls) {
    log(`  URL: ${c.url.slice(0, 150)}`);
    try {
      const b = JSON.parse(c.body);
      log(`  Body keys: ${Object.keys(b).join(', ')}`);
      log(`  Full body: ${JSON.stringify(b).slice(0, 600)}`);
      rawData[`vpBC_cimpress_${bcCalls.indexOf(c)}`] = b;
    } catch (e) {
      log(`  Body (raw): ${c.body.slice(0, 300)}`);
    }
  }

  // ── VP Flyers
  cimpressCalls.length = 0;
  log('\nLoading VP Flyers...');
  await page.goto('https://www.vistaprint.com/marketing-materials/flyers', { waitUntil: 'networkidle', timeout: 60000 });
  await wait(5000);

  log(`VP Flyer Cimpress calls: ${cimpressCalls.length}`);
  for (const c of cimpressCalls) {
    log(`  URL: ${c.url.slice(0, 150)}`);
    try {
      const b = JSON.parse(c.body);
      log(`  Body keys: ${Object.keys(b).join(', ')}`);
      log(`  Full body: ${JSON.stringify(b).slice(0, 600)}`);
      rawData[`vpFlyer_cimpress_${cimpressCalls.indexOf(c)}`] = b;

      // Extract the right price field now that we see the structure
      // Try every possible price field
      const priceFields = ['price', 'startingAt', 'totalPrice', 'amount', 'cost', 'data'];
      for (const f of priceFields) {
        if (b[f] !== undefined) log(`  b.${f} = ${JSON.stringify(b[f]).slice(0, 100)}`);
      }
    } catch (e) {
      log(`  Body (raw): ${c.body.slice(0, 400)}`);
    }
  }

  // If we captured Cimpress URLs, try to replay with different qtys
  if (cimpressCalls.length > 0) {
    const baseCall = cimpressCalls[0];
    const baseUrl = new URL(baseCall.url);
    log(`\nBase Cimpress URL params: ${[...baseUrl.searchParams.entries()].map(([k,v]) => `${k}=${v.slice(0,30)}`).join(', ')}`);

    // Try to parse the base response first
    let priceField = null;
    try {
      const b = JSON.parse(baseCall.body);
      // Traverse the object to find a field with a number that looks like a price
      function findPrice(obj, depth = 0, path = '') {
        if (depth > 5) return null;
        for (const [k, v] of Object.entries(obj || {})) {
          const p = path ? `${path}.${k}` : k;
          if (typeof v === 'number' && v > 1 && v < 1000 && String(v).includes('.')) {
            log(`  Price candidate: ${p} = ${v}`);
            return { path: p, value: v };
          }
          if (typeof v === 'string' && /^\d+\.\d{2}$/.test(v) && parseFloat(v) > 1) {
            log(`  Price string candidate: ${p} = ${v}`);
            return { path: p, value: parseFloat(v) };
          }
          if (typeof v === 'object' && v !== null) {
            const found = findPrice(v, depth + 1, p);
            if (found) return found;
          }
        }
        return null;
      }
      priceField = findPrice(b);
    } catch (_) {}

    // Now replay with different qtys
    for (const qty of [500, 1000, 2500]) {
      baseUrl.searchParams.set('quantity', String(qty));
      log(`\nReplaying VP Flyer qty=${qty}...`);
      try {
        const r = await httpGet(baseUrl.toString(), {
          'Referer': 'https://www.vistaprint.com/',
          'Origin': 'https://www.vistaprint.com',
        });
        log(`  Status: ${r.status}`);
        if (r.status === 200 && r.body && typeof r.body === 'object') {
          log(`  Body keys: ${Object.keys(r.body).join(', ')}`);
          log(`  Full body: ${JSON.stringify(r.body).slice(0, 400)}`);
          rawData[`vpFlyer_qty${qty}`] = r.body;

          // Find price using same traversal
          function extractPrice(obj, depth = 0) {
            if (depth > 5) return null;
            for (const [k, v] of Object.entries(obj || {})) {
              if (typeof v === 'number' && v > 1 && v < 2000 && String(v).includes('.')) return v;
              if (typeof v === 'string' && /^\d+\.\d{2}$/.test(v)) return parseFloat(v);
              if (typeof v === 'object' && v !== null) {
                const f = extractPrice(v, depth + 1);
                if (f) return f;
              }
            }
            return null;
          }
          const price = extractPrice(r.body);
          if (price) {
            log(`  PRICE FOUND: $${price}`);
            confirmed.flyers_postcards.push({
              competitor: 'Vistaprint', product_type: 'flyers_postcards',
              spec: { qty, size: '4"x6"', paper: '14pt C2S', sides: '4/4' },
              total_price: price,
              unit_price: +(price / qty).toFixed(5),
            });
          }
        }
      } catch (e) {
        log(`  Error: ${e.message}`);
      }
      await wait(500);
    }

    // Also replay BC
    const bcBase = bcCalls[0];
    if (bcBase) {
      const bcUrl = new URL(bcBase.url);
      for (const qty of [250, 500, 1000]) {
        bcUrl.searchParams.set('quantity', String(qty));
        try {
          const r = await httpGet(bcUrl.toString(), { 'Referer': 'https://www.vistaprint.com/' });
          log(`VP BC qty=${qty}: status=${r.status}`);
          if (r.status === 200 && r.body) {
            function extractPrice(obj, depth = 0) {
              if (depth > 5) return null;
              for (const [k, v] of Object.entries(obj || {})) {
                if (typeof v === 'number' && v > 1 && v < 2000 && String(v).includes('.')) return v;
                if (typeof v === 'string' && /^\d+\.\d{2}$/.test(v)) return parseFloat(v);
                if (typeof v === 'object' && v !== null) {
                  const f = extractPrice(v, depth + 1);
                  if (f) return f;
                }
              }
              return null;
            }
            const price = extractPrice(r.body);
            log(`  VP BC qty=${qty} price: $${price}`);
            rawData[`vpBC_qty${qty}`] = r.body;
            if (price) {
              confirmed.business_cards.push({
                competitor: 'Vistaprint', product_type: 'business_cards',
                spec: { qty, size: '3.5"x2"', paper: '14pt C2S' },
                total_price: price,
                unit_price: +(price / qty).toFixed(5),
              });
            }
          }
        } catch(e) { log(`  VP BC qty=${qty} error: ${e.message}`); }
        await wait(400);
      }
    }
  }

  await page.close();
  await context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3: Axiom Print — target finalPrice element + interact with qty dropdown
// ─────────────────────────────────────────────────────────────────────────────
async function fixAxiom(browser) {
  log('\n=== [Fix 3] Axiom Print — correct price element ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const apiCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('axiomprint.com') && (u.includes('price') || u.includes('quote') || u.includes('product'))) {
      try {
        const body = await resp.text();
        apiCalls.push({ url: u, status: resp.status(), body });
        if (u.includes('price') || u.includes('quote')) log(`  Axiom API: ${resp.status()} ${u.slice(0, 100)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  async function getAxiomPrice() {
    // Target ONLY the finalPrice element which had "$25.70"
    return await page.evaluate(() => {
      // Primary: finalPrice class
      const finalPriceEl = document.querySelector('[class*="finalPrice"]');
      if (finalPriceEl) {
        const text = finalPriceEl.textContent.trim();
        const m = text.match(/\$?([\d,]+\.\d{2})/);
        if (m) return { source: 'finalPrice', text, value: parseFloat(m[1].replace(',', '')) };
      }
      // Secondary: totalBlock
      const totalEl = document.querySelector('[class*="totalBlock"]');
      if (totalEl) {
        const text = totalEl.textContent.trim();
        const m = text.match(/\$?([\d,]+\.\d{2})/);
        if (m) return { source: 'totalBlock', text, value: parseFloat(m[1].replace(',', '')) };
      }
      // Fallback: any element with class matching "price" but not "container"
      const priceEls = Array.from(document.querySelectorAll('[class*="price"]'))
        .filter(el => !/container|wrap|block|info/i.test(el.className))
        .filter(el => /\$\d/.test(el.textContent));
      if (priceEls[0]) {
        const text = priceEls[0].textContent.trim();
        const m = text.match(/\$?([\d,]+\.\d{2})/);
        if (m) return { source: 'fallback', cls: priceEls[0].className.slice(0, 40), text, value: parseFloat(m[1].replace(',', '')) };
      }
      return null;
    });
  }

  async function getAxiomSelects() {
    return await page.evaluate(() => ({
      antSelects: Array.from(document.querySelectorAll('.ant-select-selector')).map(el => ({
        value: el.querySelector('.ant-select-selection-item')?.textContent?.trim(),
        parent: el.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.textContent?.trim(),
      })),
      labels: Array.from(document.querySelectorAll('.ant-form-item-label')).map(el => el.textContent?.trim()),
      allSelectValues: Array.from(document.querySelectorAll('.ant-select-selection-item')).map(el => el.textContent?.trim()),
    }));
  }

  try {
    log('Loading Axiom BC...');
    await page.goto('https://axiomprint.com/product/classic-business-cards-160', {
      waitUntil: 'networkidle', timeout: 45000,
    });
    await wait(4000);

    const defaultSelects = await getAxiomSelects();
    log(`Default select state: ${JSON.stringify(defaultSelects)}`);

    const defaultPrice = await getAxiomPrice();
    log(`Default price: ${JSON.stringify(defaultPrice)}`);
    rawData.axiomBC_default = { selects: defaultSelects, price: defaultPrice };

    // Try to interact: click each ant-select dropdown and select target quantities
    // From default state: ["3.5\" x 2\"","Glossy, 2 Sides","50"] — need to change qty from 50 to 250/500/1000
    // The qty dropdown is likely the last one (index 2)

    const targetQtys = [250, 500, 1000];

    for (const qty of targetQtys) {
      log(`\nTrying Axiom BC qty=${qty}...`);

      // Strategy 1: Click the dropdown that currently shows "50", then select qty
      const clicked = await page.evaluate(async (targetQty) => {
        // Find the select that contains "50" (quantity)
        const selItems = Array.from(document.querySelectorAll('.ant-select-selection-item'));
        const qtyItem = selItems.find(el => /^\d+$/.test(el.textContent.trim()));
        if (!qtyItem) return { success: false, reason: 'no qty select found' };

        const trigger = qtyItem.closest('.ant-select');
        if (!trigger) return { success: false, reason: 'no ant-select wrapper' };

        trigger.click();
        await new Promise(r => setTimeout(r, 600));

        // Find the dropdown popup and look for our target quantity
        const options = Array.from(document.querySelectorAll('.ant-select-item-option, .ant-select-item'));
        const targetOpt = options.find(el => el.textContent.trim() === String(targetQty));
        if (!targetOpt) {
          const allOpts = options.map(el => el.textContent.trim()).slice(0, 20);
          // Close dropdown
          document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { success: false, reason: 'option not found', available: allOpts };
        }

        targetOpt.click();
        return { success: true, qty: targetQty };
      }, qty);

      log(`  Click result: ${JSON.stringify(clicked)}`);

      if (clicked.success) {
        await wait(2500); // Wait for price to update
        const price = await getAxiomPrice();
        log(`  Price after selecting ${qty}: ${JSON.stringify(price)}`);
        if (price?.value) {
          confirmed.business_cards.push({
            competitor: 'Axiom Print', product_type: 'business_cards',
            spec: { qty, size: '3.5"x2"', paper: 'Glossy' },
            total_price: price.value,
            unit_price: +(price.value / qty).toFixed(5),
          });
        }
      } else {
        // Close any open dropdown before next attempt
        await page.keyboard.press('Escape');
        await wait(300);

        // Strategy 2: Use Playwright's locator to find qty dropdown options
        if (clicked.available) {
          log(`  Available options: ${JSON.stringify(clicked.available)}`);
        }
        // Try via page.locator
        try {
          const dropdown = page.locator('.ant-select-selector').filter({ hasText: /^\d+$/ });
          await dropdown.click({ timeout: 3000 });
          await wait(500);
          await page.locator(`.ant-select-item-option-content:text-is("${qty}")`).click({ timeout: 3000 });
          await wait(2500);
          const price = await getAxiomPrice();
          log(`  Price (locator method) qty=${qty}: ${JSON.stringify(price)}`);
          if (price?.value) {
            confirmed.business_cards.push({
              competitor: 'Axiom Print', product_type: 'business_cards',
              spec: { qty, size: '3.5"x2"', paper: 'Glossy' },
              total_price: price.value,
              unit_price: +(price.value / qty).toFixed(5),
            });
          }
        } catch (e2) {
          log(`  Locator method failed: ${e2.message}`);
        }
      }
    }

    // Check if any Axiom price API was called
    const priceCalls = apiCalls.filter(c => c.url.includes('price') || c.url.includes('quote'));
    if (priceCalls.length > 0) {
      log(`\nAxiom price API calls: ${priceCalls.length}`);
      for (const c of priceCalls) {
        log(`  ${c.url.slice(0, 100)}: ${c.body.slice(0, 200)}`);
      }
    }

    // Load Axiom Flyers page
    log('\nLoading Axiom Flyers (flyers-printing-102)...');
    await page.goto('https://axiomprint.com/product/flyers-printing-102', { waitUntil: 'networkidle', timeout: 45000 });
    await wait(4000);

    const flyerSelects = await getAxiomSelects();
    log(`Flyer selects: ${JSON.stringify(flyerSelects)}`);
    const flyerPrice = await getAxiomPrice();
    log(`Flyer default price: ${JSON.stringify(flyerPrice)}`);
    rawData.axiomFlyer_default = { selects: flyerSelects, price: flyerPrice };

    // Select 4"x6" size and 1000 qty
    if (flyerPrice?.value) {
      // Check if default is already close to benchmark
      const defaultQtyText = flyerSelects.allSelectValues?.find(v => /^\d+$/.test(v));
      log(`Flyer default qty: ${defaultQtyText}`);
    }

    // Try to set size=4x6 and qty=1000
    for (const qty of [500, 1000, 2500]) {
      log(`\nAxiom Flyer qty=${qty}...`);
      try {
        const dropdown = page.locator('.ant-select-selector').filter({ hasText: /^\d+$/ });
        await dropdown.click({ timeout: 3000 });
        await wait(500);
        await page.locator(`.ant-select-item-option-content:text-is("${qty}")`).click({ timeout: 3000 });
        await wait(2500);
        const price = await getAxiomPrice();
        log(`  Axiom Flyer qty=${qty}: ${JSON.stringify(price)}`);
        if (price?.value) {
          confirmed.flyers_postcards.push({
            competitor: 'Axiom Print', product_type: 'flyers_postcards',
            spec: { qty, size: '4"x6"' },
            total_price: price.value,
            unit_price: +(price.value / qty).toFixed(5),
          });
        }
      } catch (e) {
        log(`  Error: ${e.message}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

  } catch (e) {
    err('Axiom fix: ' + e.message);
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 4: GotPrint — use Playwright's native select() to trigger Vue.js reactivity
// Then intercept the REST prices API call
// ─────────────────────────────────────────────────────────────────────────────
async function fixGP(browser) {
  log('\n=== [Fix 4] GotPrint — native select interaction ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com')) return;
    try {
      const body = await resp.text();
      xhrLog.push({ url: u, status: resp.status(), body });
      if (u.includes('/service/rest') || u.includes('/prices') || u.includes('/variants')) {
        log(`  GP REST: ${resp.status()} ${u.slice(0, 110)}`);
        log(`  Body: ${body.slice(0, 200)}`);
      }
    } catch (_) {}
  });

  const page = await context.newPage();

  async function captureGP(productUrl, label, targetSize) {
    log(`\n── ${label}`);
    xhrLog.length = 0;

    await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await wait(5000);

    if (page.url().includes('home.html')) { log('  BLOCKED'); return null; }

    // Read all selects
    const selects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() }))
      }))
    );
    log(`Selects: ${JSON.stringify(selects.map(s => ({ name: s.name, options: s.options.length })))}`);

    // Use Playwright's native page.selectOption which properly triggers framework events
    const sizeSel = selects.find(s => s.name === 'size' || s.name === 'Size' || /size/i.test(s.id));
    const paperSel = selects.find(s => s.name === 'paper' || s.name === 'Paper' || /paper/i.test(s.id));
    const colorSel = selects.find(s => s.name === 'color' || s.name === 'Color' || /color/i.test(s.id));

    log(`Size select: ${JSON.stringify(sizeSel?.options?.slice(0, 5))}`);
    log(`Paper select: ${JSON.stringify(paperSel?.options?.slice(0, 5))}`);
    log(`Color select: ${JSON.stringify(colorSel?.options?.slice(0, 5))}`);

    // Use Playwright's selectOption — this fires change, input, AND the framework events
    if (sizeSel) {
      const targetOpt = sizeSel.options.find(o => o.t.includes(targetSize));
      const optValue = targetOpt?.v || sizeSel.options.filter(o => o.v)[0]?.v;
      if (optValue) {
        log(`Selecting size: ${optValue} (${targetOpt?.t})`);
        await page.selectOption(`select[name="${sizeSel.name}"]`, optValue);
        await page.waitForResponse(resp => resp.url().includes('/service/rest') || resp.url().includes('/prices'), { timeout: 5000 }).catch(() => {});
        await wait(2000);
      }
    }

    if (paperSel) {
      const pt14 = paperSel.options.find(o => /14pt|C2S/i.test(o.t)) || paperSel.options.find(o => o.v);
      if (pt14) {
        log(`Selecting paper: ${pt14.v} (${pt14.t})`);
        await page.selectOption(`select[name="${paperSel.name}"]`, pt14.v);
        await page.waitForResponse(resp => resp.url().includes('/service/rest') || resp.url().includes('/prices'), { timeout: 5000 }).catch(() => {});
        await wait(2000);
      }
    }

    if (colorSel) {
      const fullColor = colorSel.options.find(o => /4\/4|full|both/i.test(o.t)) || colorSel.options.find(o => o.v);
      if (fullColor) {
        log(`Selecting color: ${fullColor.v} (${fullColor.t})`);
        await page.selectOption(`select[name="${colorSel.name}"]`, fullColor.v);
        await page.waitForResponse(resp => resp.url().includes('/service/rest') || resp.url().includes('/prices'), { timeout: 5000 }).catch(() => {});
        await wait(3000);
      }
    }

    // Look for price XHR
    const restCalls = xhrLog.filter(x => x.url.includes('/service/rest'));
    log(`\nGP REST calls after selection: ${restCalls.length}`);
    for (const c of restCalls) {
      log(`  ${c.url.slice(0, 120)}: ${c.body.slice(0, 300)}`);
    }

    // Also check DOM for price display
    const domPrices = await page.evaluate(() => {
      const priceEls = document.querySelectorAll('[class*="price"], [id*="price"], .total-price, .grand-total');
      return Array.from(priceEls).map(el => ({ cls: el.className?.slice(0,30), text: el.textContent?.trim() }))
        .filter(e => /\$\d/.test(e.text));
    });
    log(`DOM prices: ${JSON.stringify(domPrices)}`);

    // Get all XHR calls to understand what's being called
    const allCalls = xhrLog.filter(x => !x.url.includes('.js') && !x.url.includes('.css') && !x.url.includes('.png'));
    log(`All GP XHR calls (non-static): ${allCalls.length}`);
    for (const c of allCalls.slice(-10)) {
      log(`  ${c.status} ${c.url.slice(0, 100)}`);
    }

    // Find price data
    const priceCall = restCalls.find(c => c.url.includes('/prices'));
    if (priceCall) {
      log(`\nGP Price URL: ${priceCall.url}`);
      try {
        const data = JSON.parse(priceCall.body);
        log(`GP Price data: ${JSON.stringify(data).slice(0, 500)}`);
        rawData[`gp_${label.replace(/\s+/g, '_')}`] = data;
        return { priceData: data, priceUrl: priceCall.url };
      } catch (_) {
        log(`GP Price body raw: ${priceCall.body.slice(0, 300)}`);
      }
    }

    return null;
  }

  try {
    const bcResult = await captureGP(
      'https://www.gotprint.com/products/business-cards/order',
      'GP Business Cards', '2" x 3.5"'
    );

    if (bcResult?.priceData) {
      const prices = bcResult.priceData;
      log(`BC price data structure: ${JSON.stringify(prices).slice(0, 400)}`);
      // GP price format: { qty: price } or { results: [...] } or array
      const priceMap = Array.isArray(prices) ? Object.fromEntries(prices.map(p => [p.qty || p.quantity, p.price || p.total]))
        : prices;
      for (const [qty, price] of Object.entries(priceMap)) {
        const q = parseInt(qty);
        if ([250, 500, 1000].includes(q) && price) {
          confirmed.business_cards.push({
            competitor: 'GotPrint', product_type: 'business_cards',
            spec: { qty: q, size: '3.5"x2"', paper: '14pt C2S', sides: '4/4' },
            total_price: parseFloat(price),
            unit_price: +(parseFloat(price) / q).toFixed(5),
          });
          log(`GP BC qty=${q}: $${price}`);
        }
      }
    }

    const flyResult = await captureGP(
      'https://www.gotprint.com/products/flyers/order',
      'GP Flyers', '4" x 6"'
    );

    if (flyResult?.priceData) {
      const prices = flyResult.priceData;
      log(`Flyer price data: ${JSON.stringify(prices).slice(0, 400)}`);
      const priceMap = Array.isArray(prices) ? Object.fromEntries(prices.map(p => [p.qty || p.quantity, p.price || p.total]))
        : prices;
      for (const [qty, price] of Object.entries(priceMap)) {
        const q = parseInt(qty);
        if ([500, 1000, 2500].includes(q) && price) {
          confirmed.flyers_postcards.push({
            competitor: 'GotPrint', product_type: 'flyers_postcards',
            spec: { qty: q, size: '4"x6"', paper: '14pt C2S', sides: '4/4' },
            total_price: parseFloat(price),
            unit_price: +(parseFloat(price) / q).toFixed(5),
          });
          log(`GP Flyer qty=${q}: $${price}`);
        }
      }
    }

  } catch (e) {
    err('GP fix: ' + e.message);
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update normalized JSON with confirmed prices
// ─────────────────────────────────────────────────────────────────────────────
function updateNorm() {
  let norm;
  try { norm = JSON.parse(fs.readFileSync(NORM, 'utf8')); }
  catch (_) { norm = { queries: [], last_capture_date: null }; }

  let added = 0;

  const all = [
    ...confirmed.business_cards.map(r => ({ ...r, product_type: 'business_cards' })),
    ...confirmed.flyers_postcards.map(r => ({ ...r, product_type: 'flyers_postcards' })),
    ...confirmed.diecut_stickers.map(r => ({ ...r, product_type: 'diecut_stickers' })),
  ];

  for (const r of all) {
    if (!r.total_price || !r.spec?.qty) { log(`Skip: no price or qty — ${JSON.stringify(r)}`); continue; }
    const competitor = r.competitor;
    const qty = r.spec.qty;
    const product_type = r.product_type;

    const qid = `${product_type}-${competitor.toLowerCase().replace(/[\s]+/g, '-')}-${qty}`;

    const entry = {
      query_id: qid,
      competitor,
      product_type,
      quantity: qty,
      total_price: r.total_price,
      unit_price: r.unit_price || +(r.total_price / qty).toFixed(5),
      spec: r.spec,
      status: 'live',
      captured_at: new Date().toISOString(),
      source: 'playwright-phase3',
    };

    // Find existing query group or create
    const existing = (norm.queries || []).find(q => q.query_id === qid);
    if (existing) {
      if (!existing.competitor_results) existing.competitor_results = [];
      const already = existing.competitor_results.find(cr => cr.competitor === competitor);
      if (!already) {
        existing.competitor_results.push(entry);
        added++;
        log(`Updated: ${qid}`);
      } else {
        log(`Skip dup: ${qid}`);
      }
    } else {
      norm.queries = norm.queries || [];
      norm.queries.push({
        query_id: qid,
        product_type,
        competitor_results: [entry],
      });
      added++;
      log(`Added: ${qid}`);
    }
  }

  norm.last_capture_date = new Date().toISOString().split('T')[0] + ' · PUL-288 Phase 3';
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-288 Phase 3 — Targeted Fix Run ===');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await fixUpStickers(browser);
    await fixVP(browser);
    await fixAxiom(browser);
    await fixGP(browser);
  } finally {
    await browser.close();
  }

  // Save raw data
  fs.writeFileSync(OUT, JSON.stringify({ confirmed, rawData }, null, 2));
  log(`\nRaw data saved: ${OUT}`);

  const added = updateNorm();

  log('\n=== FINAL SUMMARY ===');
  log(`Business Cards: ${confirmed.business_cards.length} price points`);
  log(`Flyers/Postcards: ${confirmed.flyers_postcards.length} price points`);
  log(`Die-cut Stickers: ${confirmed.diecut_stickers.length} price points`);
  log(`Added to normalized JSON: ${added}`);

  confirmed.business_cards.forEach(r => log(`  BC  ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
  confirmed.flyers_postcards.forEach(r => log(`  FLY ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
  confirmed.diecut_stickers.forEach(r => log(`  STK ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
