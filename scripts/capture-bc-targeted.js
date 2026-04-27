#!/usr/bin/env node
/**
 * capture-bc-targeted.js
 * PUL-288 Phase 2 — Targeted pricing capture using discovered endpoints
 *
 * Phase 1 discoveries:
 *   VP BC productKey: PRD-9TC2NHGKQ
 *   VP Flyer productKey: PRD-F2EJ5DIT
 *   UP Sticker product_id: 55, dieCutType Circle attr_val_id: 60261
 *   Axiom BC URLs: /product/classic-business-cards-160
 *   GotPrint BC page: /products/business-cards/order (selects: size, paper, color)
 *   GotPrint Flyers page: /products/flyers/order (selects: size, paper, color)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');

const log  = m => console.log(`[t2]  ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

const results = { business_cards: [], flyers: [], diecut_stickers: [], errors: [] };

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting Die-Cut Stickers — targeted API calls
// product_id=55, Circle attr_val_id=60261
// Need to discover qty attr_val_ids first via getEasyMapping
// ─────────────────────────────────────────────────────────────────────────────
async function upStickersTargeted() {
  log('\n=== UPrinting Stickers: Targeted API calls ===');

  // Step 1: Get full mapping to find qty attr IDs for product 55
  const mappingR = await httpPost('https://calculator.digitalroom.com/v1/getEasyMapping/55', {
    productType: 'offset', publishedVersion: true, disableDataCache: true,
  }, { 'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/' });

  if (mappingR.status !== 200) {
    err('UP sticker mapping failed: ' + mappingR.status);
    results.errors.push({ step: 'up_sticker_mapping', status: mappingR.status });
    return;
  }

  const mapping = mappingR.body?.data || mappingR.body;
  const attrs = Array.isArray(mapping) ? mapping : [];
  log(`Mapping entries: ${attrs.length}`);

  // Extract qty attr values
  const qtyAttr = attrs.filter(a => a.attribute_code === 'qty' || a.attribute_name?.toLowerCase().includes('qty') || a.attribute_name?.toLowerCase().includes('quantity'));
  const shapeAttr = attrs.filter(a => a.attribute_code === 'dieCutType' || a.attribute_name?.toLowerCase().includes('shape'));
  const sizeAttr = attrs.filter(a => a.attribute_code === 'size' || a.attribute_name?.toLowerCase().includes('size'));

  log(`Qty attrs: ${JSON.stringify(qtyAttr.map(a => ({ code: a.attr_val_code, id: a.prod_attr_val_id, val: a.attr_value })).slice(0, 15))}`);
  log(`Shape attrs: ${JSON.stringify(shapeAttr.map(a => ({ code: a.attr_val_code, id: a.prod_attr_val_id, val: a.attr_value })).slice(0, 8))}`);
  log(`Size attrs: ${JSON.stringify(sizeAttr.map(a => ({ code: a.attr_val_code, id: a.prod_attr_val_id, val: a.attr_value })).slice(0, 10))}`);

  // Find circle shape
  const circleAttr = shapeAttr.find(a => /circle/i.test(a.attr_value || a.attr_val_code));
  log(`Circle: ${JSON.stringify(circleAttr)}`);

  // Find 3" size (look for 3x3, 3"×3", 3" circle)
  const size3 = sizeAttr.find(a => /^3[x"×]3|3\s*x\s*3|^3"/i.test(a.attr_value || a.attr_val_code));
  log(`3" size: ${JSON.stringify(size3)}`);

  // Target qtys
  const targetQtys = [100, 250, 500];
  const targetQtyAttrs = targetQtys.map(q => ({
    qty: q,
    attr: qtyAttr.find(a => String(a.attr_value) === String(q) || a.attr_val_code === String(q) || parseInt(a.attr_value) === q),
  }));
  log(`Target qty attrs: ${JSON.stringify(targetQtyAttrs)}`);

  // Step 2: Make computePrice calls
  for (const { qty, attr } of targetQtyAttrs) {
    if (!attr) { log(`  No attr for qty ${qty} — skip`); continue; }

    const body = {
      productType: 'offset',
      publishedVersion: true,
      disableDataCache: true,
      disablePriceCache: true,
      product_id: '55',
      addon_attributes_limit: {},
    };

    if (circleAttr) body[`attr${circleAttr.attribute_id}`] = circleAttr.prod_attr_val_id;
    if (size3) body[`attr${size3.attribute_id}`] = size3.prod_attr_val_id;
    body[`attr${attr.attribute_id}`] = attr.prod_attr_val_id;

    log(`\n  UP Sticker: qty=${qty}, body=${JSON.stringify(body)}`);
    const r = await httpPost('https://calculator.digitalroom.com/v1/computePrice', body, {
      'Authorization': UP_AUTH,
      'Origin': 'https://www.uprinting.com',
      'Referer': 'https://www.uprinting.com/die-cut-stickers.html',
    });
    log(`  Status: ${r.status}, price=${r.body?.total_price}, unit=${r.body?.unit_price}`);

    if (r.status === 200 && r.body?.total_price) {
      results.diecut_stickers.push({
        competitor: 'UPrinting',
        product_type: 'diecut_stickers',
        spec: { shape: 'circle', size: '3"', qty },
        total_price: parseFloat(r.body.total_price),
        unit_price: parseFloat(r.body.unit_price),
        raw: r.body,
      });
    }
    await wait(300);
  }

  // Also try getting attr IDs from getData endpoint for full attr list
  const dataR = await httpPost('https://calculator.digitalroom.com/v1/getData/55', {}, {
    'Authorization': UP_AUTH,
    'Origin': 'https://www.uprinting.com',
    'Referer': 'https://www.uprinting.com/die-cut-stickers.html',
  });
  log(`getData/55 status: ${dataR.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting Flyers — find product_id then price
// ─────────────────────────────────────────────────────────────────────────────
async function upFlyersTargeted(browser) {
  log('\n=== UPrinting Flyers: product_id discovery ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const apiCalls = [];
  let freshAuth = null;

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('digitalroom.com')) {
      try {
        const body = await resp.text();
        const h = resp.request().headers();
        if (h['authorization']) freshAuth = h['authorization'];
        apiCalls.push({ url: u, method: resp.request().method(), status: resp.status(), body, reqBody: await resp.request().postBody()?.catch(() => null) });
        log(`  UP Flyer XHR: ${resp.request().method()} ${u.slice(0, 80)} → ${resp.status()}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    // Try actual flyers page (not brochures)
    const flyerUrls = [
      'https://www.uprinting.com/flyers.html',
      'https://www.uprinting.com/postcard-printing.html',
      'https://www.uprinting.com/postcards.html',
    ];

    for (const url of flyerUrls) {
      log(`  Trying: ${url}`);
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
      if (r && r.status() < 400 && !page.url().includes('404')) {
        log(`  Landed: ${page.url()} — ${await page.title()}`);
        await wait(7000);

        // Check what product_id is in the API calls
        const priceCalls = apiCalls.filter(c => c.url.includes('computePrice') && c.reqBody);
        for (const call of priceCalls) {
          try {
            const body = JSON.parse(call.reqBody);
            log(`  product_id: ${body.product_id}`);
          } catch (_) {}
        }

        // Try to trigger by interacting with first available select
        const selects = await page.evaluate(() =>
          Array.from(document.querySelectorAll('select')).map(s => ({
            name: s.name, id: s.id,
            options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 10),
          }))
        );
        log(`  Selects: ${selects.map(s => s.name || s.id).join(', ')}`);

        if (priceCalls.length === 0 && selects.length > 0) {
          // Try selecting qty
          for (const sel of selects) {
            if (/qty|quantity|size/i.test(sel.name + sel.id) && sel.options.length > 1) {
              await page.selectOption(`select[name="${sel.name}"]`, sel.options[1].v);
              await wait(3000);
            }
          }
        }

        break;
      }
    }

    await wait(3000);
    const priceCalls = apiCalls.filter(c => c.url.includes('computePrice'));
    log(`Price calls intercepted: ${priceCalls.length}`);

    for (const call of priceCalls) {
      let reqBody = {};
      let respBody = {};
      try { reqBody = JSON.parse(call.reqBody || '{}'); } catch (_) {}
      try { respBody = JSON.parse(call.body || '{}'); } catch (_) {}

      const productId = reqBody.product_id;
      const price = respBody.total_price;
      log(`  product_id=${productId}, total_price=${price}`);

      if (productId && price && productId !== '4') { // 4 is brochures
        // Now make targeted calls for flyer benchmark specs
        const flyers = { 500: null, 1000: null, 2500: null };
        const mapping = await httpPost(`https://calculator.digitalroom.com/v1/getEasyMapping/${productId}`, {},
          { 'Authorization': freshAuth || UP_AUTH, 'Origin': 'https://www.uprinting.com' });

        if (mapping.status === 200) {
          const attrs = mapping.body?.data || [];
          log(`  Mapping entries for product ${productId}: ${attrs.length}`);
          const qtyAttrs = attrs.filter(a => a.attribute_code === 'qty' || /quantity/i.test(a.attribute_name));
          log(`  Qty attrs: ${JSON.stringify(qtyAttrs.map(a => ({ id: a.prod_attr_val_id, val: a.attr_value })).slice(0, 10))}`);
        }
      }
    }

  } catch(e) {
    err('UP flyers: ' + e.message);
    results.errors.push({ step: 'up_flyers_targeted', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vistaprint Business Cards — capture pricingContext token then hit Cimpress
// productKey: PRD-9TC2NHGKQ (Business Cards)
// productKey: PRD-F2EJ5DIT  (Flyers)
// ─────────────────────────────────────────────────────────────────────────────
async function vpTargeted(browser) {
  log('\n=== Vistaprint: Targeted pricing via Cimpress intercept ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') && u.includes('prices')) {
      try {
        const body = await resp.text();
        cimpressCalls.push({ url: u, status: resp.status(), body });
        log(`  Cimpress pricing: ${resp.status()} ${u.slice(0, 100)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    // ── Business Cards ───────────────────────────────────────────────────
    log('Loading VP business cards...');
    await page.goto('https://www.vistaprint.com/business-cards', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await wait(5000);

    // Try clicking through quantity options to trigger Cimpress pricing API
    // Look for quantity selector
    const qtySels = await page.$$('[class*="quantity"], [data-testid*="quantity"], [aria-label*="quantity" i], select[name*="quantity"]');
    log(`VP BC qty selectors found: ${qtySels.length}`);

    // Try clicking 500 pcs option
    try {
      await page.click('[class*="QuantitySelector"], [data-testid="quantity-selector"]', { timeout: 3000 });
      await wait(500);
    } catch (_) {}

    // Look for Cimpress calls that fired
    let vpBcPrice = null;
    let vpBcToken = null;
    let vpBcProductKey = 'PRD-9TC2NHGKQ';

    for (const call of cimpressCalls) {
      if (call.url.includes('prices') && call.url.includes('PRD-9TC2NHGKQ')) {
        vpBcProductKey = 'PRD-9TC2NHGKQ';
        try {
          const b = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
          if (b?.price?.value || b?.totalPrice) {
            vpBcPrice = b.price?.value || b.totalPrice;
            log(`  VP BC price from intercept: $${vpBcPrice}`);
          }
        } catch (_) {}
        // Extract pricingContext
        const urlObj = new URL(call.url);
        vpBcToken = urlObj.searchParams.get('pricingContext') || urlObj.searchParams.get('pricingContextToken');
        if (vpBcToken) log(`  VP BC pricingContext token captured (${vpBcToken.length} chars)`);
      }
    }

    // Try making Cimpress calls with the full URL pattern from intercepted calls
    // The key is using the exact same URL structure as VP uses internally
    const vpBcCalls = cimpressCalls.filter(c => c.url.includes('prices'));
    if (vpBcCalls.length > 0) {
      log(`  Cimpress price calls intercepted: ${vpBcCalls.length}`);
      for (const call of vpBcCalls) {
        log(`    ${call.status} ${call.url.slice(0, 120)}`);
        try {
          const b = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
          // Extract price from various Cimpress response shapes
          const price = b?.price?.value || b?.startingAt?.price?.value || b?.totalPrice || b?.data?.price;
          if (price) {
            // Determine qty from URL
            const qty = parseInt(new URL(call.url).searchParams.get('quantity')) || null;
            log(`    Price: $${price} (qty=${qty})`);
            results.business_cards.push({
              competitor: 'Vistaprint',
              product_type: 'business_cards',
              spec: { qty },
              total_price: parseFloat(price),
              unit_price: qty ? +(parseFloat(price) / qty).toFixed(5) : null,
              raw: b,
            });
          }
        } catch (_) {}
      }
    }

    // If we have a token, replay calls with different qtys
    if (vpBcToken && vpBcCalls.length > 0) {
      const baseUrl = vpBcCalls[0].url;
      const urlObj = new URL(baseUrl);

      for (const qty of [250, 500, 1000]) {
        urlObj.searchParams.set('quantity', qty);
        const targetUrl = urlObj.toString();
        log(`  Hitting VP BC qty=${qty}...`);
        try {
          const r = await httpGet(targetUrl, { 'Referer': 'https://www.vistaprint.com/' });
          log(`    Status: ${r.status}, body: ${JSON.stringify(r.body).slice(0, 100)}`);
          const price = r.body?.price?.value || r.body?.startingAt?.price?.value || r.body?.totalPrice;
          if (price && r.status < 300) {
            results.business_cards.push({
              competitor: 'Vistaprint',
              product_type: 'business_cards',
              spec: { qty, size: '3.5"x2"' },
              total_price: parseFloat(price),
              unit_price: +(parseFloat(price) / qty).toFixed(5),
              raw: r.body,
            });
          }
        } catch (e) {
          log(`    Error: ${e.message}`);
        }
        await wait(500);
      }
    }

    // ── Flyers ─────────────────────────────────────────────────────────
    log('\nLoading VP flyers...');
    cimpressCalls.length = 0;

    await page.goto('https://www.vistaprint.com/marketing-materials/flyers', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await wait(5000);

    const vpFlyCalls = cimpressCalls.filter(c => c.url.includes('prices'));
    log(`VP Flyer Cimpress price calls: ${vpFlyCalls.length}`);

    for (const call of vpFlyCalls) {
      try {
        const b = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
        const price = b?.price?.value || b?.startingAt?.price?.value || b?.totalPrice;
        const qty = parseInt(new URL(call.url).searchParams.get('quantity')) || null;
        log(`  VP Flyer qty=${qty}: $${price}`);
        if (price) {
          results.flyers.push({
            competitor: 'Vistaprint',
            product_type: 'flyers_postcards',
            spec: { qty, size: '4"x6"' },
            total_price: parseFloat(price),
            unit_price: qty ? +(parseFloat(price) / qty).toFixed(5) : null,
            raw: b,
          });
        }
      } catch (_) {}
    }

    // Replay with different qtys if we got a token
    if (vpFlyCalls.length > 0) {
      const baseUrl = vpFlyCalls[0].url;
      const urlObj = new URL(baseUrl);
      log(`VP Flyer base Cimpress URL: ${baseUrl.slice(0, 120)}`);

      for (const qty of [500, 1000, 2500]) {
        urlObj.searchParams.set('quantity', qty);
        try {
          const r = await httpGet(urlObj.toString(), { 'Referer': 'https://www.vistaprint.com/' });
          const price = r.body?.price?.value || r.body?.startingAt?.price?.value || r.body?.totalPrice;
          log(`  VP Flyer qty=${qty}: status=${r.status}, price=$${price}`);
          if (price && r.status < 300) {
            results.flyers.push({
              competitor: 'Vistaprint',
              product_type: 'flyers_postcards',
              spec: { qty, size: '4"x6"' },
              total_price: parseFloat(price),
              unit_price: +(parseFloat(price) / qty).toFixed(5),
              raw: r.body,
            });
          }
        } catch (e) {
          log(`  VP Flyer error: ${e.message}`);
        }
        await wait(500);
      }
    }

  } catch (e) {
    err('VP targeted: ' + e.message);
    results.errors.push({ step: 'vp_targeted', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Axiom Print — Next.js JSON API for product pricing data
// URL: /_next/data/{buildId}/product/classic-business-cards-160.json
// ─────────────────────────────────────────────────────────────────────────────
async function axiomTargeted(browser) {
  log('\n=== Axiom Print: Next.js JSON API ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const nextDataCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('_next/data') && u.includes('product')) {
      try {
        const body = await resp.text();
        nextDataCalls.push({ url: u, status: resp.status(), body });
        log(`  Axiom Next.js: ${resp.status()} ${u.slice(0, 100)}`);
      } catch (_) {}
    }
    // Also capture pricing API calls
    if (u.includes('axiomprint') && (u.includes('price') || u.includes('quote'))) {
      try {
        const body = await resp.text();
        nextDataCalls.push({ url: u, status: resp.status(), body });
        log(`  Axiom price: ${resp.status()} ${u.slice(0, 100)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    // Load classic business cards product page
    log('Loading Axiom classic business cards...');
    await page.goto('https://axiomprint.com/product/classic-business-cards-160', {
      waitUntil: 'networkidle', timeout: 45000,
    });
    await wait(5000);

    const pageData = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      // Try to get Next.js page props
      nextData: window.__NEXT_DATA__ ? JSON.stringify(window.__NEXT_DATA__).slice(0, 2000) : null,
      // Price elements
      priceEls: Array.from(document.querySelectorAll('[class*="price"], [class*="Price"], [class*="total"]'))
        .map(el => ({ cls: el.className?.slice(0, 50), text: el.textContent?.trim() }))
        .filter(e => /\$/.test(e.text))
        .slice(0, 10),
      // Ant Design select current values
      selectValues: Array.from(document.querySelectorAll('.ant-select-selection-item'))
        .map(el => el.textContent?.trim()),
      // Form labels
      labels: Array.from(document.querySelectorAll('.ant-form-item-label label'))
        .map(el => el.textContent?.trim()),
    }));

    log(`Axiom BC: ${pageData.title}`);
    log(`Prices found: ${JSON.stringify(pageData.priceEls)}`);
    log(`Select values: ${JSON.stringify(pageData.selectValues)}`);
    log(`Labels: ${JSON.stringify(pageData.labels)}`);

    // Try to extract pricing data from __NEXT_DATA__
    if (pageData.nextData) {
      log(`Next.js data snippet: ${pageData.nextData.slice(0, 500)}`);
    }

    // Check if there's a pricing API call in next.js data
    for (const call of nextDataCalls) {
      try {
        const data = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
        // Look for pricing info in the response
        const json = JSON.stringify(data);
        if (/price|pricing/i.test(json)) {
          log(`Axiom pricing data in ${call.url.slice(0,80)}: ${json.slice(0, 300)}`);
        }
      } catch (_) {}
    }

    // Try to interact with Ant Design dropdowns to get price
    // Find quantity dropdown and try different values
    const antSelects = await page.$$('.ant-select-selector');
    log(`Ant selects found: ${antSelects.length}`);

    // Find and read the total price
    const currentPrice = await page.evaluate(() => {
      const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"], .ant-typography, [class*="total"]');
      return Array.from(priceEls).map(el => ({
        cls: el.className?.slice(0, 40),
        text: el.textContent?.trim()
      })).filter(e => /\$\d/.test(e.text) || /\d+\.\d{2}/.test(e.text)).slice(0, 5);
    });
    log(`Axiom current prices: ${JSON.stringify(currentPrice)}`);

    if (currentPrice.length > 0) {
      // Try to extract price value
      const priceText = currentPrice[0].text;
      const priceMatch = priceText.match(/\$?([\d,]+\.?\d*)/);
      if (priceMatch) {
        const priceVal = parseFloat(priceMatch[1].replace(',', ''));
        log(`Axiom BC default price: $${priceVal}`);
        results.business_cards.push({
          competitor: 'Axiom Print',
          product_type: 'business_cards',
          spec: { note: 'default page state — qty unknown' },
          total_price: priceVal,
          raw: currentPrice,
        });
      }
    }

    // Try specific qtys by interacting with the qty dropdown
    const qtyTry = [250, 500, 1000];
    for (const qty of qtyTry) {
      try {
        // Find qty selector and click
        const qtyClicked = await page.evaluate(qty => {
          // Find dropdown containing quantity-like values
          const allItems = document.querySelectorAll('.ant-select-item, .ant-select-item-option');
          const qtyItem = Array.from(allItems).find(el => el.textContent?.trim() === String(qty));
          if (qtyItem) { qtyItem.click(); return true; }
          return false;
        }, qty);

        if (!qtyClicked) {
          // Try opening first dropdown then selecting
          if (antSelects.length > 0) {
            await antSelects[0].click({ force: true });
            await wait(500);
            const option = await page.$(`[title="${qty}"], li:has-text("${qty}"),.ant-select-item:has-text("${qty}")`);
            if (option) {
              await option.click({ force: true });
              await wait(2000);

              const price = await page.evaluate(() => {
                const els = document.querySelectorAll('[class*="price"], [class*="Price"], [class*="total"]');
                const priceEl = Array.from(els).find(e => /\$\d/.test(e.textContent));
                return priceEl?.textContent?.trim();
              });
              if (price) {
                log(`  Axiom BC qty=${qty}: ${price}`);
                const priceMatch = price.match(/\$?([\d,]+\.?\d*)/);
                if (priceMatch) {
                  results.business_cards.push({
                    competitor: 'Axiom Print',
                    product_type: 'business_cards',
                    spec: { qty },
                    total_price: parseFloat(priceMatch[1].replace(',', '')),
                    price_text: price,
                  });
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    // Also try Axiom flyers
    log('\nLoading Axiom flyers...');
    await page.goto('https://axiomprint.com/product/flyers-printing-102', {
      waitUntil: 'networkidle', timeout: 30000,
    }).catch(async () => {
      // Try via nav
      await page.goto('https://axiomprint.com/catalog/flyers', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    });
    await wait(4000);

    const flyerData = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      priceEls: Array.from(document.querySelectorAll('[class*="price"], [class*="Price"]'))
        .map(el => el.textContent?.trim()).filter(t => /\$/.test(t)).slice(0, 5),
    }));
    log(`Axiom Flyer: ${flyerData.title} at ${flyerData.url}`);
    if (flyerData.priceEls.length > 0) log(`  Prices: ${JSON.stringify(flyerData.priceEls)}`);

  } catch (e) {
    err('Axiom targeted: ' + e.message);
    results.errors.push({ step: 'axiom_targeted', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GotPrint — Business Cards targeted (trigger Vue.js reactivity properly)
// The GP Vue.js app fires /prices XHR when size+paper are BOTH selected
// ─────────────────────────────────────────────────────────────────────────────
async function gpTargeted(browser) {
  log('\n=== GotPrint: Targeted BC + Flyer capture ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com')) return;
    try {
      const body = await resp.text();
      xhrLog.push({ url: u, status: resp.status(), body });
      if (u.includes('/prices') || (u.includes('/products/') && !u.includes('static'))) {
        log(`  GP XHR: ${resp.status()} ${u.slice(0, 110)}`);
      }
    } catch (_) {}
  });

  const page = await context.newPage();

  async function gpTriggerPrices(productUrl, productLabel, targetSize) {
    log(`\n── ${productLabel}`);
    await page.goto(productUrl, { waitUntil: 'load', timeout: 60000 });
    await wait(6000);

    if (page.url().includes('home.html')) { log('  BLOCKED'); return null; }

    // Read all selects
    const selects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim(), disabled: o.disabled }))
                  .filter(o => o.t && o.t !== 'Please select an option'),
      }))
    );
    log(`  Selects: ${selects.map(s => `${s.name}(${s.options.length})`).join(', ')}`);

    // Select size
    const sizeSel = selects.find(s => s.name === 'size' || s.name === 'Size');
    if (sizeSel) {
      const targetOpt = sizeSel.options.find(o => o.t.includes(targetSize)) || sizeSel.options[0];
      log(`  Selecting size: "${targetOpt?.t}"`);
      await page.evaluate(({ n, v }) => {
        const el = document.querySelector(`select[name="${n}"]`);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // Also trigger Vue.js
        const vNode = el.__vue__;
        if (vNode) vNode.$emit('change', v);
      }, { n: sizeSel.name, v: targetOpt?.v });
      await wait(3000);
    }

    // Select paper
    const paperSel = selects.find(s => s.name === 'paper' || s.name === 'Paper');
    if (paperSel) {
      const pt14C2S = paperSel.options.find(o => /14pt|C2S/i.test(o.t)) || paperSel.options[0];
      log(`  Selecting paper: "${pt14C2S?.t}"`);
      await page.evaluate(({ n, v }) => {
        const el = document.querySelector(`select[name="${n}"]`);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, { n: paperSel.name, v: pt14C2S?.v });
      await wait(3000);
    }

    // Select color
    const colorSel = selects.find(s => s.name === 'color' || s.name === 'Color');
    if (colorSel) {
      const fullColor = colorSel.options.find(o => /4\/4|full color|both side/i.test(o.t)) || colorSel.options[0];
      log(`  Selecting color: "${fullColor?.t}"`);
      await page.evaluate(({ n, v }) => {
        const el = document.querySelector(`select[name="${n}"]`);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, { n: colorSel.name, v: fullColor?.v });
      await wait(4000);
    }

    // Check for prices XHR
    const pricesXhr = [...xhrLog].reverse().find(x => x.url.includes('/prices'));
    if (pricesXhr) {
      const u = new URL(pricesXhr.url);
      const productId = u.pathname.match(/\/products\/(\d+)\/prices/)?.[1];
      const variantId = u.searchParams.get('variantId');
      log(`  Product ID: ${productId}, Variant ID: ${variantId}`);
      log(`  Price URL: ${pricesXhr.url}`);

      if (productId && variantId) {
        // Parse price table
        try {
          const priceData = JSON.parse(pricesXhr.body);
          log(`  Price table keys: ${Object.keys(priceData).join(', ')}`);
          return { productId, variantId, priceData, priceUrl: pricesXhr.url };
        } catch (_) {}
      }
      return { productId, variantId, priceUrl: pricesXhr.url };
    }

    // Try to read price directly from DOM
    const domPrice = await page.evaluate(() => {
      const priceEl = document.querySelector('[class*="price"], [id*="price"], .total-price');
      return priceEl?.textContent?.trim();
    });
    log(`  DOM price: ${domPrice || 'none found'}`);

    return null;
  }

  try {
    // Business Cards (3.5" × 2" = "2" x 3.5" U.S. Standard" in GP)
    const bcResult = await gpTriggerPrices(
      'https://www.gotprint.com/products/business-cards/order',
      'GP Business Cards', '2" x 3.5"'
    );

    if (bcResult?.priceData) {
      log(`GP BC price data: ${JSON.stringify(bcResult.priceData).slice(0, 200)}`);
      // Parse the qty table
      for (const [qty, price] of Object.entries(bcResult.priceData)) {
        const q = parseInt(qty);
        if ([250, 500, 1000].includes(q) && price) {
          results.business_cards.push({
            competitor: 'GotPrint',
            product_type: 'business_cards',
            spec: { qty: q, size: '2"x3.5"', paper: '14pt C2S' },
            total_price: parseFloat(price),
            unit_price: +(parseFloat(price) / q).toFixed(5),
          });
          log(`  GP BC qty=${q}: $${price}`);
        }
      }
    } else if (bcResult?.priceUrl) {
      // Hit the price URL directly for target qtys
      for (const qty of [250, 500, 1000]) {
        const url = new URL(bcResult.priceUrl);
        url.searchParams.set('qty', qty);
        const r = await httpGet(url.toString(), { 'Referer': 'https://www.gotprint.com/' });
        log(`  GP BC direct qty=${qty}: status=${r.status}, body=${JSON.stringify(r.body).slice(0,80)}`);
        if (r.status < 300 && r.body) {
          results.business_cards.push({
            competitor: 'GotPrint',
            product_type: 'business_cards',
            spec: { qty },
            price_raw: r.body,
          });
        }
      }
    }

    // Flyers (4" × 6")
    xhrLog.length = 0;
    const flyResult = await gpTriggerPrices(
      'https://www.gotprint.com/products/flyers/order',
      'GP Flyers', '4" x 6"'
    );

    if (flyResult?.priceData) {
      log(`GP Flyer price data: ${JSON.stringify(flyResult.priceData).slice(0, 200)}`);
      for (const [qty, price] of Object.entries(flyResult.priceData)) {
        const q = parseInt(qty);
        if ([500, 1000, 2500].includes(q) && price) {
          results.flyers.push({
            competitor: 'GotPrint',
            product_type: 'flyers_postcards',
            spec: { qty: q, size: '4"x6"', paper: '14pt C2S' },
            total_price: parseFloat(price),
            unit_price: +(parseFloat(price) / q).toFixed(5),
          });
          log(`  GP Flyer qty=${q}: $${price}`);
        }
      }
    } else if (flyResult?.priceUrl) {
      log(`  GP Flyer price URL found: ${flyResult.priceUrl}`);
    }

  } catch (e) {
    err('GP targeted: ' + e.message);
    results.errors.push({ step: 'gp_targeted', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update normalized JSON
// ─────────────────────────────────────────────────────────────────────────────
function updateNorm() {
  let norm;
  try { norm = JSON.parse(fs.readFileSync(NORM, 'utf8')); }
  catch (_) { norm = { queries: [], last_capture_date: null }; }

  let added = 0;

  const all = [
    ...results.business_cards.map(r => ({ ...r, product_type: 'business_cards' })),
    ...results.flyers.map(r => ({ ...r, product_type: 'flyers_postcards' })),
    ...results.diecut_stickers.map(r => ({ ...r, product_type: 'diecut_stickers' })),
  ];

  for (const r of all) {
    if (!r.total_price || !r.spec?.qty) continue;

    const qid = `${r.product_type}-${r.competitor.toLowerCase().replace(/[\s]+/g, '-')}-${r.spec.qty}`;
    const result = {
      competitor: r.competitor,
      product_type: r.product_type,
      status: 'live',
      total_price: r.total_price,
      unit_price: r.unit_price || +(r.total_price / r.spec.qty).toFixed(5),
      quantity: r.spec.qty,
      spec: r.spec,
      captured_at: new Date().toISOString(),
      source: 'playwright',
    };

    const existing = norm.queries?.find(q => q.query_id === qid);
    if (existing) {
      existing.competitor_results = existing.competitor_results || [];
      if (!existing.competitor_results.find(cr => cr.competitor === r.competitor)) {
        existing.competitor_results.push(result);
        added++;
      }
    } else {
      norm.queries = norm.queries || [];
      norm.queries.push({ query_id: qid, product_type: r.product_type, competitor_results: [result] });
      added++;
    }
  }

  norm.last_capture_date = new Date().toISOString().split('T')[0] + ' · PUL-288 Phase 2';
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  log(`Normalized JSON: +${added} new price points`);
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-288 Phase 2 — Targeted Capture ===');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await upStickersTargeted();
    await upFlyersTargeted(browser);
    await vpTargeted(browser);
    await axiomTargeted(browser);
    await gpTargeted(browser);
  } finally {
    await browser.close();
  }

  const added = updateNorm();

  log('\n=== FINAL SUMMARY ===');
  log(`Business Cards: ${results.business_cards.length} price points`);
  log(`Flyers: ${results.flyers.length} price points`);
  log(`Diecut Stickers: ${results.diecut_stickers.length} price points`);
  log(`Added to normalized JSON: ${added}`);
  log(`Errors: ${results.errors.length}`);

  results.business_cards.forEach(r => log(`  BC  ${r.competitor} qty=${r.spec?.qty || '?'}: $${r.total_price}`));
  results.flyers.forEach(r => log(`  FLY ${r.competitor} qty=${r.spec?.qty || '?'}: $${r.total_price}`));
  results.diecut_stickers.forEach(r => log(`  STK ${r.competitor} qty=${r.spec?.qty || '?'}: $${r.total_price}`));

  // Write raw output
  fs.writeFileSync(
    path.join(ROOT, 'data', `capture-bc-targeted-${new Date().toISOString().split('T')[0]}.json`),
    JSON.stringify({ results, errors: results.errors }, null, 2)
  );
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
