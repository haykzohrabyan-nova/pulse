#!/usr/bin/env node
/**
 * capture-bc-flyers-stickers.js
 * PUL-288 — Business Cards, Flyers/Postcards, Diecut Stickers competitor pricing
 *
 * TARGETS:
 *   Business Cards:  UPrinting, Vistaprint, GotPrint, Axiom Print
 *     Benchmark: 3.5"×2", 500 pcs, 14pt C2S, Gloss UV; also 250 and 1000 pcs
 *   Flyers/Postcards: UPrinting, Vistaprint, GotPrint, Axiom Print
 *     Benchmark: 4"×6", 1000 pcs, 14pt C2S, full-color both sides; also 500 and 2500 pcs
 *   Diecut Stickers: UPrinting, Sticker Mule (JSON-LD only)
 *     Benchmark: 3" circle, 100 pcs, White BOPP
 *
 * METHODS:
 *   UPrinting:  calculator.digitalroom.com/v1/computePrice (intercept to discover product_id + attrs)
 *   Vistaprint: Cimpress pricing service (intercept pricingContext + productKey, then Node.js call)
 *   GotPrint:   REST API /service/rest/v1/products/{id}/prices (intercept to discover product ID)
 *   Axiom:      Playwright Ant Design dropdown interaction + DOM price scrape
 *   Sticker Mule: JSON-LD schema.org structured data (starting price only)
 */
'use strict';

const { chromium, request: pwRequest } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const RAW  = path.join(ROOT, 'data', 'competitor-pricing-raw.json');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const LOG  = path.join(ROOT, 'data', `capture-bc-flyers-stickers-${new Date().toISOString().split('T')[0]}.json`);

const log  = m => console.log(`[bc]  ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── UPrinting Basic auth (may expire — re-discovered via Playwright intercept) ──
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

// ── Cimpress helper ──────────────────────────────────────────────────────────
function cimp(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json',
        'Referer': 'https://www.vistaprint.com/' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── digitalroom.com helper ───────────────────────────────────────────────────
function upApi(productId, attrs) {
  const body = JSON.stringify({
    productType: 'offset',
    publishedVersion: true,
    disableDataCache: true,
    disablePriceCache: true,
    product_id: String(productId),
    addon_attributes_limit: {},
    ...attrs,
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://calculator.digitalroom.com/v1/computePrice', {
      method: 'POST',
      headers: {
        'Authorization': UP_AUTH,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Origin': 'https://www.uprinting.com',
        'Referer': 'https://www.uprinting.com/',
        'User-Agent': UA,
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Results accumulator ──────────────────────────────────────────────────────
const runOutput = {
  run_date: new Date().toISOString(),
  business_cards: { discovered: {}, prices: [] },
  flyers:         { discovered: {}, prices: [] },
  diecut_stickers:{ discovered: {}, prices: [] },
  errors: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting — Business Cards
// URL: https://www.uprinting.com/business-cards.html
// Method: intercept calculator.digitalroom.com to discover product_id + attrs
// ─────────────────────────────────────────────────────────────────────────────
async function captureUPrintingBusinessCards(browser) {
  log('\n═══ UPRINTING — BUSINESS CARDS ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const apiCalls = [];
  let freshToken = null;

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('calculator.digitalroom.com') || u.includes('digitalroom.com')) {
      try {
        const body = await resp.text();
        const req  = resp.request();
        const headers = req.headers();
        if (headers['authorization']) freshToken = headers['authorization'];
        apiCalls.push({ url: u, method: req.method(), headers, status: resp.status(), body });
        log(`UP XHR: ${req.method()} ${u.slice(0, 80)} → ${resp.status()}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    log('Loading UPrinting business cards...');
    await page.goto('https://www.uprinting.com/business-cards.html', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await wait(8000);

    // Get visible selects to understand dropdown structure
    const selects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select, [class*="dropdown"], [class*="option"]'))
        .slice(0, 20)
        .map(el => ({
          tag: el.tagName, name: el.name, id: el.id,
          cls: el.className?.slice(0, 60),
          options: el.tagName === 'SELECT'
            ? Array.from(el.options).map(o => ({ v: o.value, t: o.text?.trim() })).slice(0, 20)
            : [],
        }))
    );
    log('UP selects found: ' + selects.length);

    // Try to trigger a price calculation by selecting options
    // UPrinting business cards typically have: Qty, Size, Printing (1-sided/2-sided), Paper, Coating
    const qtySel = await page.$('select[name*="qty"], select[id*="qty"], select[name*="Qty"]');
    if (qtySel) {
      const opts = await qtySel.evaluate(s => Array.from(s.options).map(o => ({v: o.value, t: o.text.trim()})));
      log('Qty options: ' + JSON.stringify(opts.slice(0, 8)));

      // Select 500 qty if available, otherwise first non-empty option
      const target500 = opts.find(o => o.t.includes('500'));
      if (target500) {
        await qtySel.selectOption({ value: target500.v });
        await wait(2000);
      }
    }

    // Try Angular scope access
    const angularData = await page.evaluate(() => {
      try {
        const el = document.querySelector('[ng-controller], [data-ng-controller], [ng-app]');
        if (!el) return null;
        const scope = window.angular?.element(el)?.scope?.();
        if (!scope) return null;
        return {
          productId: scope.productId || scope.product_id,
          attrs: scope.selectedAttributes || scope.attributes || scope.attrList,
          price: scope.totalPrice || scope.price,
        };
      } catch(_) { return null; }
    });
    if (angularData) log('Angular scope: ' + JSON.stringify(angularData).slice(0, 200));

    await wait(5000);
    runOutput.business_cards.discovered.uprinting = {
      url: page.url(),
      apiCalls: apiCalls.map(c => ({ url: c.url, status: c.status, body: c.body?.slice(0, 300) })),
      selects: selects.map(s => ({ name: s.name, id: s.id, options: s.options.slice(0, 10) })),
      angularData,
    };

    if (freshToken) {
      log('Fresh auth token captured: ' + freshToken.slice(0, 30) + '...');
    }

    // Process any captured API calls
    const priceCalls = apiCalls.filter(c => c.url.includes('computePrice') && c.method === 'POST');
    log(`API price calls captured: ${priceCalls.length}`);

    if (priceCalls.length > 0) {
      for (const call of priceCalls) {
        try {
          const reqBody = JSON.parse(call.body || '{}');
          const respBody = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
          log(`  product_id: ${reqBody.product_id}, price: ${respBody?.data?.total_price}`);
          runOutput.business_cards.prices.push({
            competitor: 'UPrinting',
            source: 'intercepted',
            product_id: reqBody.product_id,
            attrs: reqBody,
            price: respBody,
          });
        } catch (_) {}
      }
    }

  } catch (e) {
    err('UP business cards: ' + e.message);
    runOutput.errors.push({ step: 'uprinting_business_cards', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting — Flyers (4"×6")
// URL: https://www.uprinting.com/flyers.html or /flyers-printing.html
// ─────────────────────────────────────────────────────────────────────────────
async function captureUPrintingFlyers(browser) {
  log('\n═══ UPRINTING — FLYERS ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const apiCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('digitalroom.com') || u.includes('calculator.digital')) {
      try {
        const body = await resp.text();
        const reqH = resp.request().headers();
        apiCalls.push({ url: u, method: resp.request().method(), status: resp.status(), body, reqHeaders: reqH });
        log(`UP Flyer XHR: ${resp.request().method()} ${u.slice(0, 80)} → ${resp.status()}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const flyerUrls = [
    'https://www.uprinting.com/flyers.html',
    'https://www.uprinting.com/flyers-printing.html',
    'https://www.uprinting.com/brochures.html',
    'https://www.uprinting.com/postcards.html',
  ];

  try {
    let landed = false;
    for (const url of flyerUrls) {
      log(`Trying: ${url}`);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      if (resp && resp.status() < 400 && !page.url().includes('404')) {
        log(`Landed at: ${page.url()}`);
        landed = true;
        await wait(6000);
        break;
      }
    }

    if (!landed) {
      log('No flyer page found — trying nav crawl');
      await page.goto('https://www.uprinting.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await wait(3000);
      const flyerLink = await page.$('a[href*="flyer"], a[href*="postcard"]');
      if (flyerLink) {
        const href = await flyerLink.getAttribute('href');
        log('Found flyer link: ' + href);
        await page.goto(href.startsWith('http') ? href : 'https://www.uprinting.com' + href,
          { waitUntil: 'domcontentloaded', timeout: 20000 });
        await wait(6000);
      }
    }

    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      selects: Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 15),
      })).slice(0, 8),
    }));
    log(`Flyer page: ${pageInfo.title} | selects: ${pageInfo.selects.length}`);

    runOutput.flyers.discovered.uprinting = {
      url: pageInfo.url,
      title: pageInfo.title,
      selects: pageInfo.selects,
      apiCalls: apiCalls.map(c => ({ url: c.url, status: c.status, bodySnip: c.body?.slice(0, 200) })),
    };

    await wait(4000);
    const priceCalls = apiCalls.filter(c => c.url.includes('computePrice'));
    log(`Flyer price API calls: ${priceCalls.length}`);
    for (const call of priceCalls) {
      try {
        const body = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
        runOutput.flyers.prices.push({ competitor: 'UPrinting', source: 'intercepted', data: body });
      } catch (_) {}
    }

  } catch (e) {
    err('UP flyers: ' + e.message);
    runOutput.errors.push({ step: 'uprinting_flyers', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting — Diecut Stickers
// URL: https://www.uprinting.com/die-cut-stickers.html (same Angular+digitalroom pattern)
// ─────────────────────────────────────────────────────────────────────────────
async function captureUPrintingDiecutStickers(browser) {
  log('\n═══ UPRINTING — DIECUT STICKERS ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const apiCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('digitalroom.com')) {
      try {
        const body = await resp.text();
        apiCalls.push({ url: u, method: resp.request().method(), status: resp.status(), body });
        log(`UP Sticker XHR: ${resp.request().method()} ${u.slice(0,80)} → ${resp.status()}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    const stickerUrls = [
      'https://www.uprinting.com/die-cut-stickers.html',
      'https://www.uprinting.com/stickers.html',
      'https://www.uprinting.com/custom-stickers.html',
    ];
    let landed = false;
    for (const url of stickerUrls) {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      if (r && r.status() < 400) { landed = true; await wait(7000); break; }
    }
    log(`Sticker page landed: ${landed} at ${page.url()}`);

    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasQtySelect: !!document.querySelector('select[name*="qty"], select[id*="qty"]'),
      selects: Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 15),
      })).slice(0, 8),
    }));
    log(`Sticker: ${pageInfo.title} hasQty=${pageInfo.hasQtySelect}`);

    // Try to interact with qty dropdown if present, to trigger API call
    if (pageInfo.hasQtySelect) {
      const qtySel = await page.$('select[name*="qty"], select[id*="qty"]');
      if (qtySel) {
        const opts = await qtySel.evaluate(s => Array.from(s.options).map(o => ({v: o.value, t: o.text.trim()})));
        const t100 = opts.find(o => o.t.includes('100'));
        if (t100) { await qtySel.selectOption({ value: t100.v }); await wait(3000); }
      }
    }

    await wait(4000);
    runOutput.diecut_stickers.discovered.uprinting = {
      url: pageInfo.url,
      title: pageInfo.title,
      selects: pageInfo.selects,
      apiCalls: apiCalls.map(c => ({ url: c.url, status: c.status, bodySnip: c.body?.slice(0, 300) })),
    };

    const priceCalls = apiCalls.filter(c => c.url.includes('computePrice') && c.method === 'POST');
    log(`Sticker price calls: ${priceCalls.length}`);
    for (const call of priceCalls) {
      try {
        const body = typeof call.body === 'string' ? JSON.parse(call.body) : call.body;
        runOutput.diecut_stickers.prices.push({ competitor: 'UPrinting', source: 'intercepted', data: body });
      } catch (_) {}
    }

  } catch (e) {
    err('UP stickers: ' + e.message);
    runOutput.errors.push({ step: 'uprinting_diecut_stickers', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vistaprint — Business Cards + Flyers (Cimpress API)
// ─────────────────────────────────────────────────────────────────────────────
async function captureVistaprint(browser) {
  log('\n═══ VISTAPRINT — BUSINESS CARDS + FLYERS ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCalls = [];
  let pricingCtxBC = null;
  let productKeyBC = null;
  let pricingCtxFly = null;
  let productKeyFly = null;

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') || u.includes('vistaprint.com') && u.includes('pricing')) {
      try {
        const body = await resp.text();
        cimpressCalls.push({ url: u, status: resp.status(), body });
        if (u.includes('cimpress')) {
          log(`Cimpress: ${resp.status()} ${u.slice(0, 90)}`);
          if (u.includes('productKey=')) {
            const pk = new URL(u).searchParams.get('productKey');
            const ctx = new URL(u).searchParams.get('pricingContext') || new URL(u).searchParams.get('pricingContextToken');
            if (pk) log(`  productKey: ${pk}`);
          }
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    // ── Business Cards ────────────────────────────────────────────────────
    log('Loading VP business cards...');
    await page.goto('https://www.vistaprint.com/business-cards', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await wait(8000);

    // Get productKey and pricingContext from intercepted calls
    for (const call of cimpressCalls) {
      if (call.url.includes('cimpress')) {
        try {
          const url = new URL(call.url);
          const pk  = url.searchParams.get('productKey');
          const ctx = url.searchParams.get('pricingContext') || url.searchParams.get('pricingContextToken');
          if (pk && !productKeyBC) { productKeyBC = pk; log(`BC productKey: ${pk}`); }
          if (ctx && !pricingCtxBC) { pricingCtxBC = ctx; }
        } catch (_) {}
      }
    }

    // Also try page source for productKey
    if (!productKeyBC) {
      productKeyBC = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const m = s.textContent?.match(/productKey['":\s]+['"](PRD-[A-Z0-9]+)['"]/);
          if (m) return m[1];
          const m2 = s.textContent?.match(/"productKey":"(PRD-[A-Z0-9]+)"/);
          if (m2) return m2[1];
        }
        // Try window.__INITIAL_STATE__ or similar
        try {
          const state = window.__NEXT_DATA__ || window.__INITIAL_STATE__ || {};
          const json = JSON.stringify(state);
          const m = json.match(/PRD-[A-Z0-9]{8,}/);
          if (m) return m[0];
        } catch(_) {}
        return null;
      });
      if (productKeyBC) log(`BC productKey from page: ${productKeyBC}`);
    }

    // Try to interact with qty dropdown to trigger Cimpress call
    const qtyLinks = await page.$$('[class*="quantity"], [data-testid*="qty"], select, [class*="qty"]');
    log(`VP BC qty elements found: ${qtyLinks.length}`);

    // Click "500" if it appears as a quantity option
    try {
      await page.click('text=500', { timeout: 3000 });
      await wait(2000);
    } catch (_) {}

    const pageStructure = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodySnip: document.body.textContent.trim().slice(0, 300),
    }));
    log(`VP BC: ${pageStructure.title}`);
    runOutput.business_cards.discovered.vistaprint = { ...pageStructure, productKey: productKeyBC, cimpressCalls: cimpressCalls.length };

    const cimpCallsBC = [...cimpressCalls];
    cimpressCalls.length = 0; // Reset for flyers

    // ── Flyers ────────────────────────────────────────────────────────────
    log('\nLoading VP flyers...');
    await page.goto('https://www.vistaprint.com/marketing-materials/flyers', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await wait(8000);

    for (const call of cimpressCalls) {
      if (call.url.includes('cimpress')) {
        try {
          const url = new URL(call.url);
          const pk  = url.searchParams.get('productKey');
          const ctx = url.searchParams.get('pricingContext') || url.searchParams.get('pricingContextToken');
          if (pk && !productKeyFly) { productKeyFly = pk; log(`Flyer productKey: ${pk}`); }
          if (ctx && !pricingCtxFly) { pricingCtxFly = ctx; }
        } catch (_) {}
      }
    }

    if (!productKeyFly) {
      productKeyFly = await page.evaluate(() => {
        try {
          const json = JSON.stringify(window.__NEXT_DATA__ || {});
          const m = json.match(/PRD-[A-Z0-9]{8,}/);
          return m ? m[0] : null;
        } catch(_) { return null; }
      });
      if (productKeyFly) log(`Flyer productKey from page: ${productKeyFly}`);
    }

    // Also try /postcards
    if (!productKeyFly) {
      await page.goto('https://www.vistaprint.com/marketing-materials/postcards', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await wait(5000);
      for (const call of cimpressCalls) {
        if (call.url.includes('cimpress')) {
          try {
            const url = new URL(call.url);
            const pk = url.searchParams.get('productKey');
            if (pk && !productKeyFly) { productKeyFly = pk; log(`Postcard productKey: ${pk}`); }
          } catch (_) {}
        }
      }
    }

    runOutput.flyers.discovered.vistaprint = {
      url: page.url(),
      productKey: productKeyFly,
      cimpressCalls: cimpressCalls.length,
    };

    // ── Now hit Cimpress API directly for pricing ─────────────────────────
    // We need a valid pricingContext token — try to get one from the page
    log('\nHitting Cimpress API for business cards...');

    // For business cards, common Cimpress selections:
    //   Size: "3.5"x2"" (standard business card)
    //   Finish: "Gloss Laminated" or just standard
    //   Quantity: 500

    if (productKeyBC) {
      const bcSizes   = ['"3.5"x2""', '"2"x3.5""'];
      const bcQtys    = [250, 500, 1000];
      const bcFinish  = ['Gloss Laminated', 'No Laminate', 'Matte Laminated'];

      for (const qty of bcQtys) {
        // Try with startingAt endpoint
        const urlStr = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?productKey=${encodeURIComponent(productKeyBC)}&quantity=${qty}&customerGroups=SMALL_BUSINESS`;
        try {
          const result = await cimp(urlStr);
          log(`  VP BC qty=${qty}: status=${result.status} price=${result.body?.price?.value || result.body?.totalPrice || JSON.stringify(result.body).slice(0,60)}`);
          if (result.status < 300) {
            runOutput.business_cards.prices.push({
              competitor: 'Vistaprint',
              product_type: 'business_cards',
              spec: { qty },
              price_data: result.body,
              url: urlStr,
            });
          }
        } catch (e) {
          log(`  VP BC error: ${e.message}`);
        }
        await wait(500);
      }
    }

    if (productKeyFly) {
      const flyQtys = [500, 1000, 2500];
      for (const qty of flyQtys) {
        const urlStr = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?productKey=${encodeURIComponent(productKeyFly)}&quantity=${qty}&customerGroups=SMALL_BUSINESS`;
        try {
          const result = await cimp(urlStr);
          log(`  VP Flyer qty=${qty}: status=${result.status} price=${result.body?.price?.value || result.body?.totalPrice || JSON.stringify(result.body).slice(0,60)}`);
          if (result.status < 300) {
            runOutput.flyers.prices.push({
              competitor: 'Vistaprint',
              product_type: 'flyers_postcards',
              spec: { qty },
              price_data: result.body,
              url: urlStr,
            });
          }
        } catch (e) {
          log(`  VP Flyer error: ${e.message}`);
        }
        await wait(500);
      }
    }

  } catch (e) {
    err('Vistaprint: ' + e.message);
    runOutput.errors.push({ step: 'vistaprint', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GotPrint — Business Cards + Flyers
// Method: navigate to product page → intercept /prices XHR → discover product ID
// ─────────────────────────────────────────────────────────────────────────────
async function captureGotPrint(browser) {
  log('\n═══ GOTPRINT — BUSINESS CARDS + FLYERS ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com')) return;
    try {
      const body = await resp.text();
      xhrLog.push({ url: u, status: resp.status(), body });
      if (u.includes('/prices') || u.includes('/products/')) {
        log(`GP XHR: ${resp.status()} ${u.slice(0, 100)}`);
      }
    } catch (_) {}
  });

  const page = await context.newPage();

  async function gpSelectOption(page, name, label) {
    return page.evaluate(({ n, l }) => {
      const sel = document.querySelector(`select[name="${n}"]`);
      if (!sel) return `NOT FOUND: ${n}`;
      const opt = [...sel.options].find(o => o.text.trim() === l);
      if (!opt) {
        return `MISS: "${l}" not in [${[...sel.options].map(o => o.text.trim()).join(', ')}]`;
      }
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      return `OK: ${n}=${opt.value}`;
    }, { n: name, l: label });
  }

  async function gpProbeProduct(productUrl, productLabel) {
    log(`\n── GP ${productLabel}: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'load', timeout: 60000 });
    await wait(5000);

    if (page.url().includes('home.html') || page.url().includes('404')) {
      log(`  REDIRECT/404 — skip`);
      return null;
    }
    log(`  Landed: ${page.url()}`);

    const pageSelects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20),
      }))
    );
    log(`  Selects: ${pageSelects.map(s => s.name || s.id).join(', ')}`);

    // Try to trigger prices XHR by selecting size/paper
    const sizeNames = ['size', 'Size', 'product_size'];
    for (const n of sizeNames) {
      const s = pageSelects.find(s => s.name === n || s.id === n);
      if (s && s.options.length > 1) {
        log(`  Selecting size "${s.options[1].t}"...`);
        await gpSelectOption(page, s.name || s.id, s.options[1].t);
        await wait(3000);
        break;
      }
    }

    // Find prices XHR to get product ID
    const pricesXhr = [...xhrLog].reverse().find(x => x.url.includes('/prices'));
    let productId = null;
    if (pricesXhr) {
      const match = pricesXhr.url.match(/\/products\/(\d+)\/prices/);
      if (match) {
        productId = match[1];
        log(`  Product ID discovered: ${productId}`);
      }
    }

    // If no prices XHR yet, try selecting paper
    if (!productId) {
      const paperNames = ['paper', 'Paper', 'paper_stock'];
      for (const n of paperNames) {
        const s = pageSelects.find(s => s.name === n || s.id === n);
        if (s && s.options.length > 1) {
          await gpSelectOption(page, s.name || s.id, s.options[1].t);
          await wait(3000);
          break;
        }
      }
      const prXhr2 = [...xhrLog].reverse().find(x => x.url.includes('/prices'));
      if (prXhr2) {
        const m = prXhr2.url.match(/\/products\/(\d+)\/prices/);
        if (m) { productId = m[1]; log(`  Product ID (after paper): ${productId}`); }
      }
    }

    return { productId, selects: pageSelects };
  }

  try {
    // ── Business Cards ─────────────────────────────────────────────────────
    const bcProductUrls = [
      'https://www.gotprint.com/products/business-cards/order',
      'https://www.gotprint.com/store/business-cards/order',
      'https://www.gotprint.com/products/standard-business-cards/order',
    ];

    let bcResult = null;
    for (const url of bcProductUrls) {
      bcResult = await gpProbeProduct(url, 'Business Cards');
      if (bcResult?.productId) break;
    }

    if (!bcResult?.productId) {
      // Try from homepage nav
      log('  No BC product ID — crawling GP nav for business cards link...');
      await page.goto('https://www.gotprint.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await wait(3000);
      const bcLink = await page.$('a[href*="business-card"]');
      if (bcLink) {
        const href = await bcLink.getAttribute('href');
        log('  Found BC nav link: ' + href);
        const fullUrl = href.startsWith('http') ? href : 'https://www.gotprint.com' + href;
        bcResult = await gpProbeProduct(fullUrl + '/order', 'Business Cards (nav)');
      }
    }

    runOutput.business_cards.discovered.gotprint = { productId: bcResult?.productId, selects: bcResult?.selects?.map(s => s.name) };

    // If we have a product ID, hit the prices API
    if (bcResult?.productId) {
      log(`\nGP BC prices API with product ${bcResult.productId}...`);
      const gpPricesUrl = `https://www.gotprint.com/service/rest/v1/products/${bcResult.productId}/prices`;

      // Try to get variant ID from the XHR log
      const qtyXhr = [...xhrLog].find(x => x.url.includes('options/quantities'));
      let variantId = null;
      if (qtyXhr) {
        try { variantId = Object.keys(JSON.parse(qtyXhr.body))[0]; } catch(_) {}
      }

      if (variantId) {
        for (const qty of [250, 500, 1000]) {
          const pricesUrl = `${gpPricesUrl}?variantId=${variantId}&qty=${qty}`;
          const r = await fetch(pricesUrl, { headers: { 'User-Agent': UA } }).catch(() => null);
          if (r?.ok) {
            const priceData = await r.json().catch(() => null);
            if (priceData) {
              const price = priceData[qty] || priceData[String(qty)];
              log(`  GP BC qty=${qty}: $${price || JSON.stringify(priceData).slice(0, 60)}`);
              runOutput.business_cards.prices.push({
                competitor: 'GotPrint',
                product_type: 'business_cards',
                spec: { qty },
                price_raw: priceData,
                price: price,
              });
            }
          }
        }
      } else {
        log(`  No variantId found — logging product ID for manual follow-up`);
        runOutput.business_cards.prices.push({
          competitor: 'GotPrint',
          product_type: 'business_cards',
          note: `product_id=${bcResult.productId} — variantId not captured, needs follow-up`,
        });
      }
    }

    // ── Flyers ─────────────────────────────────────────────────────────────
    xhrLog.length = 0; // Reset

    const flyerProductUrls = [
      'https://www.gotprint.com/products/flyers/order',
      'https://www.gotprint.com/products/postcards/order',
      'https://www.gotprint.com/store/flyers/order',
      'https://www.gotprint.com/products/standard-flyers/order',
    ];

    let flyResult = null;
    for (const url of flyerProductUrls) {
      flyResult = await gpProbeProduct(url, 'Flyers');
      if (flyResult?.productId) break;
    }

    runOutput.flyers.discovered.gotprint = { productId: flyResult?.productId };

    if (flyResult?.productId) {
      log(`GP Flyer product ID: ${flyResult.productId}`);
      runOutput.flyers.prices.push({
        competitor: 'GotPrint',
        product_type: 'flyers_postcards',
        note: `product_id=${flyResult.productId} — use /prices API with size/qty params`,
      });
    }

  } catch (e) {
    err('GotPrint: ' + e.message);
    runOutput.errors.push({ step: 'gotprint', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Axiom Print — Business Cards + Flyers (Ant Design dropdown interaction)
// ─────────────────────────────────────────────────────────────────────────────
async function captureAxiom(browser) {
  log('\n═══ AXIOM PRINT — BUSINESS CARDS + FLYERS ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const apiCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('axiomprint.com') && (u.includes('price') || u.includes('quote') || u.includes('product'))) {
      try {
        const body = await resp.text();
        apiCalls.push({ url: u, status: resp.status(), body });
        log(`Axiom XHR: ${resp.status()} ${u.slice(0, 90)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  async function axiomAntSelect(page, labelText, optionText) {
    // Ant Design dropdowns: click the trigger, then click the option
    const selectors = [
      `[class*="Select"]:has([title*="${labelText}"])`,
      `label:has-text("${labelText}") + div [class*="Select"]`,
      `.ant-form-item:has(.ant-form-item-label:has-text("${labelText}")) [class*="selector"]`,
    ];
    let clicked = false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ force: true });
          await wait(800);
          const option = await page.$(`[class*="option"]:has-text("${optionText}")`);
          if (option) { await option.click({ force: true }); clicked = true; break; }
        }
      } catch (_) {}
    }
    if (!clicked) {
      // Try clicking by finding all dropdowns
      try {
        const triggers = await page.$$('.ant-select-selector, [class*="ant-select"] .ant-select-selector');
        log(`  Axiom: found ${triggers.length} ant-select triggers`);
      } catch (_) {}
    }
    return clicked;
  }

  try {
    // ── Find product URLs from Axiom nav ──────────────────────────────────
    log('Loading Axiom Print nav...');
    await page.goto('https://www.axiomprint.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wait(4000);

    const navLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().slice(0, 60),
        href: a.href,
      })).filter(a => /business.card|flyer|postcard|sticker/i.test(a.text + a.href)).slice(0, 10)
    );
    log('Axiom nav links: ' + JSON.stringify(navLinks));

    const bcLink = navLinks.find(l => /business.card/i.test(l.text + l.href));
    const flyLink = navLinks.find(l => /flyer|postcard/i.test(l.text + l.href));

    runOutput.business_cards.discovered.axiom = { navLinks, bcLink, flyLink };

    // ── Business Cards ─────────────────────────────────────────────────────
    if (bcLink) {
      log(`Axiom BC: ${bcLink.href}`);
      await page.goto(bcLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await wait(6000);

      const bcState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        antSelects: Array.from(document.querySelectorAll('.ant-select')).map(el => ({
          cls: el.className?.slice(0, 60),
          value: el.querySelector('.ant-select-selection-item')?.textContent?.trim(),
          trigger: el.querySelector('.ant-select-selector')?.textContent?.trim(),
        })).slice(0, 10),
        priceText: Array.from(document.querySelectorAll('[class*="price"], [class*="total"], [class*="amount"]'))
          .map(el => el.textContent.trim()).filter(t => /\$/.test(t)).slice(0, 5),
      }));

      log(`Axiom BC title: ${bcState.title}`);
      log(`Axiom BC selects: ${JSON.stringify(bcState.antSelects).slice(0, 200)}`);
      log(`Axiom BC prices: ${JSON.stringify(bcState.priceText)}`);

      // Try to interact with qty select
      const qtys = [250, 500, 1000];
      for (const qty of qtys) {
        try {
          // Look for qty dropdown and select it
          const qtyEl = await page.$('.ant-select-selector');
          if (qtyEl) {
            await qtyEl.click({ force: true });
            await wait(500);
            const qtyOpt = await page.$(`li[title="${qty}"], .ant-select-item:has-text("${qty}")`);
            if (qtyOpt) {
              await qtyOpt.click({ force: true });
              await wait(2000);
              const price = await page.evaluate(() => {
                const els = document.querySelectorAll('[class*="price"], [class*="total"], [class*="amount"]');
                return Array.from(els).map(e => e.textContent.trim()).find(t => /\$[\d,.]+/.test(t));
              });
              if (price) {
                log(`  Axiom BC qty=${qty}: ${price}`);
                runOutput.business_cards.prices.push({
                  competitor: 'Axiom Print',
                  product_type: 'business_cards',
                  spec: { qty },
                  price_text: price,
                });
              }
            }
          }
        } catch (_) {}
      }

      runOutput.business_cards.discovered.axiom = { ...runOutput.business_cards.discovered.axiom, bcPageState: bcState };
    }

    // ── Flyers ─────────────────────────────────────────────────────────────
    if (flyLink) {
      log(`Axiom Flyer: ${flyLink.href}`);
      await page.goto(flyLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await wait(6000);

      const flyState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        antSelects: Array.from(document.querySelectorAll('.ant-select')).map(el => ({
          value: el.querySelector('.ant-select-selection-item')?.textContent?.trim(),
        })).slice(0, 8),
        priceText: Array.from(document.querySelectorAll('[class*="price"], [class*="total"], [class*="amount"]'))
          .map(el => el.textContent.trim()).filter(t => /\$/.test(t)).slice(0, 5),
      }));

      log(`Axiom Flyer: ${flyState.title} | prices: ${JSON.stringify(flyState.priceText)}`);
      runOutput.flyers.discovered.axiom = flyState;

      if (flyState.priceText.length > 0) {
        runOutput.flyers.prices.push({
          competitor: 'Axiom Print',
          product_type: 'flyers_postcards',
          note: 'Default page state price',
          price_text: flyState.priceText,
        });
      }
    }

  } catch (e) {
    err('Axiom: ' + e.message);
    runOutput.errors.push({ step: 'axiom', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sticker Mule — JSON-LD starting price only (upload-first, no configurator)
// ─────────────────────────────────────────────────────────────────────────────
async function captureStickerMule(browser) {
  log('\n═══ STICKER MULE — DIECUT STICKERS (JSON-LD only) ═══');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    const urls = [
      'https://www.stickermule.com/custom-die-cut-stickers',
      'https://www.stickermule.com/products/die-cut-stickers',
      'https://www.stickermule.com/die-cut-stickers',
    ];

    let found = false;
    for (const url of urls) {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      if (r && r.status() < 400) {
        log(`SM landed: ${page.url()}`);
        await wait(4000);
        found = true;
        break;
      }
    }

    if (!found) {
      log('SM: trying nav...');
      await page.goto('https://www.stickermule.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await wait(3000);
      const dcLink = await page.$('a[href*="die-cut"]');
      if (dcLink) {
        await dcLink.click({ force: true });
        await wait(4000);
      }
    }

    const data = await page.evaluate(() => {
      // Extract JSON-LD structured data
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const schemas = jsonLdScripts.map(s => { try { return JSON.parse(s.textContent); } catch(_) { return null; } }).filter(Boolean);

      // Look for pricing in meta tags and page content
      const metaPrice = document.querySelector('meta[property="product:price:amount"]')?.content;
      const metaCurrency = document.querySelector('meta[property="product:price:currency"]')?.content;

      // Body text for pricing clues
      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [class*="Price"]'))
        .map(el => el.textContent.trim()).filter(t => /\$/.test(t)).slice(0, 5);

      return {
        url: location.href,
        title: document.title,
        schemas,
        metaPrice,
        metaCurrency,
        priceEls,
        bodySnip: document.body.textContent.slice(0, 500),
      };
    });

    log(`SM diecut: ${data.title}`);
    log(`SM JSON-LD: ${JSON.stringify(data.schemas).slice(0, 200)}`);
    log(`SM price els: ${JSON.stringify(data.priceEls)}`);
    log(`SM meta price: ${data.metaPrice} ${data.metaCurrency}`);

    runOutput.diecut_stickers.discovered.stickermule = data;

    // Extract starting price from JSON-LD or meta
    let startingPrice = null;
    if (data.metaPrice) {
      startingPrice = parseFloat(data.metaPrice);
    } else {
      for (const schema of (data.schemas || [])) {
        if (schema?.offers?.price) { startingPrice = parseFloat(schema.offers.price); break; }
        if (schema?.offers?.[0]?.price) { startingPrice = parseFloat(schema.offers[0].price); break; }
      }
    }

    if (startingPrice) {
      log(`SM starting price: $${startingPrice}`);
      runOutput.diecut_stickers.prices.push({
        competitor: 'Sticker Mule',
        product_type: 'diecut_stickers',
        note: 'JSON-LD starting price — upload-first, exact spec not configurable',
        starting_price: startingPrice,
        currency: data.metaCurrency || 'USD',
      });
    } else {
      log('SM: no starting price found in JSON-LD or meta');
      runOutput.diecut_stickers.prices.push({
        competitor: 'Sticker Mule',
        product_type: 'diecut_stickers',
        note: 'Upload-first product — no price in JSON-LD or meta',
        raw: data.priceEls,
      });
    }

  } catch (e) {
    err('Sticker Mule: ' + e.message);
    runOutput.errors.push({ step: 'stickermule', error: e.message });
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update normalized JSON with captured prices
// ─────────────────────────────────────────────────────────────────────────────
function updateNormalizedJson(runOutput) {
  let norm;
  try { norm = JSON.parse(fs.readFileSync(NORM, 'utf8')); }
  catch (_) { norm = { queries: [], last_capture_date: null, coverage_gaps: [] }; }

  const parsePrice = (priceData) => {
    if (!priceData) return null;
    if (typeof priceData === 'number') return priceData;
    if (priceData.price?.value) return parseFloat(priceData.price.value);
    if (priceData.totalPrice) return parseFloat(priceData.totalPrice);
    if (priceData.data?.total_price) return parseFloat(priceData.data.total_price);
    return null;
  };

  let addedCount = 0;

  // Process all captured prices
  const allPrices = [
    ...runOutput.business_cards.prices.map(p => ({ ...p, product_type: 'business_cards' })),
    ...runOutput.flyers.prices.map(p => ({ ...p, product_type: 'flyers_postcards' })),
    ...runOutput.diecut_stickers.prices.map(p => ({ ...p, product_type: 'diecut_stickers' })),
  ];

  for (const capture of allPrices) {
    if (!capture.competitor || capture.note?.includes('product_id=') || capture.note?.includes('needs follow-up')) {
      // Just a discovery note — add to coverage gaps
      if (!norm.coverage_gaps) norm.coverage_gaps = [];
      norm.coverage_gaps.push({
        competitor: capture.competitor,
        product_type: capture.product_type,
        note: capture.note || 'product ID discovered, variantId needed',
        captured_at: new Date().toISOString(),
      });
      continue;
    }

    const total = parsePrice(capture.price_data || capture.price);
    if (!total) continue;

    // Build query entry
    const qty = capture.spec?.qty;
    if (!qty) continue;

    const queryId = `${capture.product_type}-${capture.competitor.toLowerCase().replace(/\s+/g, '-')}-${qty}`;

    const result = {
      competitor: capture.competitor,
      product_type: capture.product_type,
      status: 'live',
      total_price: total,
      unit_price: qty ? +(total / qty).toFixed(5) : null,
      quantity: qty,
      captured_at: new Date().toISOString(),
      source: capture.source || 'playwright',
    };

    const existing = norm.queries?.find(q => q.query_id === queryId);
    if (existing) {
      existing.competitor_results = existing.competitor_results || [];
      const existingResult = existing.competitor_results.find(r => r.competitor === capture.competitor);
      if (!existingResult) {
        existing.competitor_results.push(result);
        addedCount++;
      }
    } else {
      if (!norm.queries) norm.queries = [];
      norm.queries.push({
        query_id: queryId,
        product_type: capture.product_type,
        competitor_results: [result],
      });
      addedCount++;
    }
  }

  norm.last_capture_date = new Date().toISOString().split('T')[0] + ' · PUL-288 BC/Flyers/Stickers';
  norm.new_product_types_added = ['business_cards', 'flyers_postcards', 'diecut_stickers'];

  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  log(`Normalized JSON updated: +${addedCount} new price points`);
  return addedCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-288 Competitor Pricing Capture — Business Cards / Flyers / Diecut Stickers ===');
  log(`Date: ${new Date().toISOString()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    // Run captures in sequence (each opens/closes its own context)
    await captureUPrintingBusinessCards(browser);
    await captureUPrintingFlyers(browser);
    await captureUPrintingDiecutStickers(browser);
    await captureVistaprint(browser);
    await captureGotPrint(browser);
    await captureAxiom(browser);
    await captureStickerMule(browser);
  } finally {
    await browser.close();
  }

  // Save raw run output
  fs.writeFileSync(LOG, JSON.stringify(runOutput, null, 2));
  log(`\nRaw output: ${LOG}`);

  // Update normalized JSON
  const addedCount = updateNormalizedJson(runOutput);

  // Summary
  log('\n═══ SUMMARY ═══');
  log(`Business Cards prices captured: ${runOutput.business_cards.prices.length}`);
  log(`Flyers prices captured: ${runOutput.flyers.prices.length}`);
  log(`Diecut Stickers prices captured: ${runOutput.diecut_stickers.prices.length}`);
  log(`Errors: ${runOutput.errors.length}`);
  log(`New price points added to normalized JSON: ${addedCount}`);

  if (runOutput.errors.length > 0) {
    log('\nErrors:');
    runOutput.errors.forEach(e => log(`  ${e.step}: ${e.error}`));
  }

  // Print discovery notes for the competitor-pricing-notes.md update
  log('\n═══ DISCOVERIES (for NOTES update) ═══');
  for (const [product, data] of Object.entries(runOutput)) {
    if (typeof data !== 'object' || !data.discovered) continue;
    for (const [comp, disc] of Object.entries(data.discovered)) {
      if (disc?.productKey) log(`  ${comp} ${product} productKey: ${disc.productKey}`);
      if (disc?.productId)  log(`  ${comp} ${product} GP product_id: ${disc.productId}`);
    }
  }

  return runOutput;
}

main().catch(e => { err('Fatal: ' + e.message); console.error(e); process.exit(1); });
