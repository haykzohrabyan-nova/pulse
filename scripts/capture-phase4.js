#!/usr/bin/env node
/**
 * capture-phase4.js
 * PUL-288 Phase 4 — Final targeted pricing capture
 *
 * Fixes from Phase 3:
 *   VP: change `quantities` param (not `quantity`), parse estimatedPrices[qty].totalListPrice.taxed
 *   VP BC: load /business-cards/design page (product configurator) not marketing page
 *   Axiom BC: click .ant-select-selector by index (nth=2 for qty), not by text filter
 *   GotPrint: use page.locator('select').nth() by index, not by empty name
 *   UP Stickers: intercept live page → detect Angular widget params
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const ROOT = path.resolve(__dirname, '..');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');

const log  = m => console.log(`[p4]  ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

const confirmed = { business_cards: [], flyers_postcards: [], diecut_stickers: [] };

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers } }, res => {
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
  const mod = u.protocol === 'https:' ? https : http;
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
// Vistaprint — corrected approach
// BC: load /business-cards (product page, NOT /design), wait for networkidle
// Flyer: already intercepts — replay with `quantities` param (not `quantity`)
// ─────────────────────────────────────────────────────────────────────────────
async function vpFix(browser) {
  log('\n=== VP: Corrected Cimpress approach ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') && u.includes('prices')) {
      try {
        const body = await resp.text();
        cimpressCalls.push({ url: u, status: resp.status(), body });
        log(`  Cimpress: ${resp.status()} ${u.slice(0, 110)}`);
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  // Helper: extract price from Cimpress estimatedPrices at a given qty key
  function parseCimpressPrice(body, targetQty) {
    try {
      const b = typeof body === 'string' ? JSON.parse(body) : body;
      const eps = b?.estimatedPrices;
      if (!eps) return null;
      // Find the qty key — it might be the only key
      const key = String(targetQty);
      if (eps[key]) return eps[key].totalListPrice?.taxed || eps[key].totalDiscountedPrice?.taxed;
      // Fall back to first key
      const firstKey = Object.keys(eps)[0];
      return firstKey ? eps[firstKey].totalListPrice?.taxed : null;
    } catch (_) { return null; }
  }

  try {
    // ── VP Business Cards
    log('Loading VP BC product page...');
    // The product-level page that fires pricing
    await page.goto('https://www.vistaprint.com/business-cards', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await wait(6000);

    // Try triggering pricing by clicking a size/finish option
    await page.evaluate(() => window.scrollBy(0, 300));
    await wait(2000);

    // Try clicking any product option to trigger Cimpress
    const clickables = await page.$$('[class*="option"], [class*="quantity"], button[data-quantity]');
    for (const el of clickables.slice(0, 5)) {
      try { await el.click({ timeout: 1000 }); await wait(1000); } catch (_) {}
    }

    let bcCalls = cimpressCalls.filter(c => c.url.includes('PRD-9TC2NHGKQ') || c.url.includes('business-card'));
    log(`VP BC Cimpress calls captured: ${bcCalls.length}`);

    if (bcCalls.length === 0) {
      // Try the /business-cards/design page which is the configurator
      log('Trying BC design/configurator page...');
      cimpressCalls.length = 0;
      await page.goto('https://www.vistaprint.com/business-cards/standard', { waitUntil: 'networkidle', timeout: 45000 });
      await wait(4000);
      bcCalls = [...cimpressCalls];
      log(`BC standard page Cimpress calls: ${bcCalls.length}`);
    }

    if (bcCalls.length > 0) {
      const baseCall = bcCalls[0];
      const baseUrl = new URL(baseCall.url);
      log(`BC base params: ${[...baseUrl.searchParams.entries()].map(([k,v]) => `${k}=${v.slice(0,25)}`).join(', ')}`);

      for (const qty of [250, 500, 1000]) {
        baseUrl.searchParams.set('quantities', String(qty));
        baseUrl.searchParams.delete('quantity');
        try {
          const r = await httpGet(baseUrl.toString(), { 'Referer': 'https://www.vistaprint.com/' });
          const price = parseCimpressPrice(r.body, qty);
          log(`VP BC qty=${qty}: status=${r.status}, price=$${price}`);
          if (price && r.status === 200) {
            confirmed.business_cards.push({
              competitor: 'Vistaprint', product_type: 'business_cards',
              spec: { qty, size: '3.5"x2"', paper: '14pt C2S', sides: '4/4' },
              total_price: price,
              unit_price: +(price / qty).toFixed(5),
            });
          }
        } catch (e) { log(`VP BC qty=${qty} error: ${e.message}`); }
        await wait(400);
      }
    }

    // ── VP Flyers
    cimpressCalls.length = 0;
    log('\nLoading VP Flyers...');
    await page.goto('https://www.vistaprint.com/marketing-materials/flyers', { waitUntil: 'networkidle', timeout: 60000 });
    await wait(5000);

    const flyerCalls = [...cimpressCalls];
    log(`VP Flyer Cimpress calls: ${flyerCalls.length}`);
    for (const c of flyerCalls) {
      log(`  ${c.url.slice(0, 120)}`);
      const b = (() => { try { return JSON.parse(c.body); } catch(_) { return null; } })();
      if (b?.estimatedPrices) {
        const keys = Object.keys(b.estimatedPrices);
        log(`  estimatedPrices keys: ${keys.join(', ')}`);
        for (const k of keys) {
          const price = b.estimatedPrices[k].totalListPrice?.taxed;
          log(`  qty=${k}: $${price}`);
        }
      }
    }

    if (flyerCalls.length > 0) {
      const baseCall = flyerCalls[0];
      const baseUrl = new URL(baseCall.url);

      // Check if there's already a call with qty=500+
      for (const c of flyerCalls) {
        const u = new URL(c.url);
        const qtiesParam = u.searchParams.get('quantities');
        const b = (() => { try { return JSON.parse(c.body); } catch(_) { return null; } })();
        if (b?.estimatedPrices && qtiesParam) {
          const price = parseCimpressPrice(b, parseInt(qtiesParam));
          if (price && [500, 1000, 2500].includes(parseInt(qtiesParam))) {
            confirmed.flyers_postcards.push({
              competitor: 'Vistaprint', product_type: 'flyers_postcards',
              spec: { qty: parseInt(qtiesParam), size: '4"x6"', paper: 'Budget/Gloss' },
              total_price: price,
              unit_price: +(price / parseInt(qtiesParam)).toFixed(5),
            });
            log(`  CONFIRMED VP Flyer qty=${qtiesParam}: $${price} (from intercept)`);
          }
        }
      }

      // Replay with correct `quantities` param for benchmark specs
      for (const qty of [500, 1000, 2500]) {
        // Skip if already captured
        if (confirmed.flyers_postcards.find(r => r.competitor === 'Vistaprint' && r.spec.qty === qty)) continue;

        baseUrl.searchParams.set('quantities', String(qty));
        baseUrl.searchParams.delete('quantity');
        try {
          const r = await httpGet(baseUrl.toString(), { 'Referer': 'https://www.vistaprint.com/' });
          const price = parseCimpressPrice(r.body, qty);
          log(`VP Flyer qty=${qty}: status=${r.status}, price=$${price}`);
          if (price && r.status === 200) {
            confirmed.flyers_postcards.push({
              competitor: 'Vistaprint', product_type: 'flyers_postcards',
              spec: { qty, size: '4"x6"', paper: 'Budget/Gloss' },
              total_price: price,
              unit_price: +(price / qty).toFixed(5),
            });
          }
        } catch (e) { log(`VP Flyer qty=${qty} error: ${e.message}`); }
        await wait(400);
      }
    }

  } catch (e) {
    err('VP fix: ' + e.message);
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Axiom Print — click ant-select by DOM position (3rd = qty)
// ─────────────────────────────────────────────────────────────────────────────
async function axiomFix(browser) {
  log('\n=== Axiom: ant-select by index ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  async function getPrice() {
    return await page.evaluate(() => {
      const el = document.querySelector('[class*="finalPrice"]');
      if (!el) return null;
      const m = el.textContent.trim().match(/\$([\d,]+\.\d{2})/);
      return m ? parseFloat(m[1].replace(',', '')) : null;
    });
  }

  async function getQtyOptions() {
    return await page.evaluate(() => {
      // Find ant-select that currently shows a pure number (the qty dropdown)
      const selectors = Array.from(document.querySelectorAll('.ant-select-selector'));
      for (let i = 0; i < selectors.length; i++) {
        const itemEl = selectors[i].querySelector('.ant-select-selection-item');
        if (itemEl && /^\d+$/.test(itemEl.textContent.trim())) {
          return { index: i, currentValue: itemEl.textContent.trim() };
        }
      }
      return null;
    });
  }

  async function clickAntSelectQty(targetQty) {
    // Click the qty dropdown and select target quantity
    const qtyInfo = await getQtyOptions();
    if (!qtyInfo) { log(`  No qty dropdown found`); return false; }
    log(`  Qty select at index ${qtyInfo.index}, current: ${qtyInfo.currentValue}`);

    if (qtyInfo.currentValue === String(targetQty)) {
      log(`  Already at qty=${targetQty}`);
      return true;
    }

    // Click the selector at the given index to open dropdown
    const opened = await page.evaluate(idx => {
      const selectors = Array.from(document.querySelectorAll('.ant-select-selector'));
      if (selectors[idx]) { selectors[idx].click(); return true; }
      return false;
    }, qtyInfo.index);

    if (!opened) return false;
    await wait(700);

    // Find and click the option with our target qty
    const selected = await page.evaluate(qty => {
      const opts = Array.from(document.querySelectorAll('.ant-select-dropdown:not([style*="display: none"]) .ant-select-item'));
      const target = opts.find(el => el.textContent.trim() === String(qty));
      if (target) { target.click(); return { success: true, opts: opts.map(o => o.textContent.trim()) }; }
      return { success: false, opts: opts.map(o => o.textContent.trim()) };
    }, targetQty);

    log(`  Select result: ${JSON.stringify(selected)}`);
    await wait(2500);
    return selected.success;
  }

  try {
    // Business Cards
    log('Loading Axiom BC...');
    await page.goto('https://axiomprint.com/product/classic-business-cards-160', { waitUntil: 'networkidle', timeout: 45000 });
    await wait(4000);

    const defaultPrice = await getPrice();
    log(`BC default price (qty=50): $${defaultPrice}`);
    if (defaultPrice) {
      confirmed.business_cards.push({
        competitor: 'Axiom Print', product_type: 'business_cards',
        spec: { qty: 50, size: '3.5"x2"', paper: 'Glossy' },
        total_price: defaultPrice,
        unit_price: +(defaultPrice / 50).toFixed(5),
      });
    }

    for (const qty of [250, 500, 1000]) {
      log(`\nAxiom BC qty=${qty}...`);
      const ok = await clickAntSelectQty(qty);
      if (ok) {
        const price = await getPrice();
        log(`  Price: $${price}`);
        if (price) {
          confirmed.business_cards.push({
            competitor: 'Axiom Print', product_type: 'business_cards',
            spec: { qty, size: '3.5"x2"', paper: 'Glossy' },
            total_price: price,
            unit_price: +(price / qty).toFixed(5),
          });
        }
      }
    }

    // Flyers
    log('\nLoading Axiom Flyers...');
    await page.goto('https://axiomprint.com/product/flyers-printing-102', { waitUntil: 'networkidle', timeout: 45000 });
    await wait(4000);

    const flyDefaultPrice = await getPrice();
    const flyDefault = await getQtyOptions();
    log(`Flyer default: $${flyDefaultPrice}, qty dropdown: ${JSON.stringify(flyDefault)}`);

    // First select 4"x6" size if needed
    const flySelects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ant-select-selection-item')).map(el => el.textContent.trim())
    );
    log(`Flyer current selects: ${JSON.stringify(flySelects)}`);

    // Click size dropdown (index 0) and select 4x6
    const sizeOpened = await page.evaluate(() => {
      const sel = document.querySelectorAll('.ant-select-selector')[0];
      if (sel) { sel.click(); return true; }
      return false;
    });
    await wait(700);
    if (sizeOpened) {
      const sizeSelected = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('.ant-select-dropdown:not([style*="display: none"]) .ant-select-item'));
        const allOpts = opts.map(o => o.textContent.trim());
        // Find 4x6 option
        const target = opts.find(el => /4.*6|6.*4/i.test(el.textContent));
        log_result = { opts: allOpts, found: target?.textContent?.trim() };
        if (target) { target.click(); return log_result; }
        return { opts: allOpts, found: null };
      });
      log(`Size options: ${JSON.stringify(sizeSelected)}`);
      await wait(2500);
    }

    for (const qty of [500, 1000, 2500]) {
      log(`\nAxiom Flyer qty=${qty}...`);
      const ok = await clickAntSelectQty(qty);
      if (ok) {
        const price = await getPrice();
        log(`  Price: $${price}`);
        if (price) {
          confirmed.flyers_postcards.push({
            competitor: 'Axiom Print', product_type: 'flyers_postcards',
            spec: { qty, size: '4"x6"' },
            total_price: price,
            unit_price: +(price / qty).toFixed(5),
          });
        }
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
// GotPrint — use select by nth() index (not by name)
// Size select is nth=1 (index 1), paper=nth=2, color=nth=3
// ─────────────────────────────────────────────────────────────────────────────
async function gpFix(browser) {
  log('\n=== GotPrint: nth() select approach ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com')) return;
    try {
      const body = await resp.text();
      xhrLog.push({ url: u, status: resp.status(), body });
      if (u.includes('/service/rest/v1/products/') && u.includes('/prices')) {
        log(`  GP PRICES: ${resp.status()} ${u}`);
        log(`  Body: ${body.slice(0, 400)}`);
      }
    } catch (_) {}
  });

  const page = await context.newPage();

  async function captureGP(productUrl, label, targetSizeText) {
    log(`\n── ${label}`);
    xhrLog.length = 0;

    await page.goto(productUrl, { waitUntil: 'load', timeout: 60000 });
    await wait(7000);

    if (page.url().includes('home.html')) { log('  BLOCKED'); return null; }

    // Read all selects with their index
    const selects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map((s, i) => ({
        idx: i, name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim(), d: o.disabled }))
      }))
    );
    log(`Selects found: ${selects.map(s => `[${s.idx}]${s.name||'unnamed'}(${s.options.length})`).join(', ')}`);

    // Find size select — it has the size options with inches
    const sizeSel = selects.find(s => s.options.some(o => /"\s*x\s*"|inch/i.test(o.t)));
    // Paper select — has "14 pt" options
    const paperSel = selects.find(s => s.options.some(o => /14\s*pt|C2S|gloss/i.test(o.t)));
    // Color select — has "Full Color" options
    const colorSel = selects.find(s => s.options.some(o => /full.color|4\/4/i.test(o.t)));

    log(`Size: [${sizeSel?.idx}], Paper: [${paperSel?.idx}], Color: [${colorSel?.idx}]`);
    log(`Size options: ${JSON.stringify(sizeSel?.options?.slice(0,6))}`);
    log(`Paper options: ${JSON.stringify(paperSel?.options?.slice(0,6))}`);
    log(`Color options: ${JSON.stringify(colorSel?.options?.slice(0,5))}`);

    // Select size using nth()
    if (sizeSel) {
      const targetOpt = sizeSel.options.find(o => o.t.includes(targetSizeText) && !o.d) || sizeSel.options.find(o => o.v && !o.d);
      if (targetOpt) {
        log(`Selecting size: ${targetOpt.v} "${targetOpt.t}"`);
        await page.locator('select').nth(sizeSel.idx).selectOption(targetOpt.v);
        await wait(3000);
      }
    }

    if (paperSel) {
      const pt14 = paperSel.options.find(o => /14\s*pt.*gloss/i.test(o.t) && !o.d)
                || paperSel.options.find(o => /14\s*pt/i.test(o.t) && !o.d)
                || paperSel.options.find(o => o.v && !o.d);
      if (pt14) {
        log(`Selecting paper: ${pt14.v} "${pt14.t}"`);
        await page.locator('select').nth(paperSel.idx).selectOption(pt14.v);
        await wait(3000);
      }
    }

    if (colorSel) {
      const fullColor = colorSel.options.find(o => /4\/4|full color both/i.test(o.t) && !o.d)
                     || colorSel.options.find(o => /full.color/i.test(o.t) && !o.d)
                     || colorSel.options.find(o => o.v && !o.d);
      if (fullColor) {
        log(`Selecting color: ${fullColor.v} "${fullColor.t}"`);
        await page.locator('select').nth(colorSel.idx).selectOption(fullColor.v);
        await wait(4000);
      }
    }

    // Check for prices XHR
    const pricesXhr = xhrLog.find(x => x.url.includes('/products/') && x.url.includes('/prices'));
    if (pricesXhr) {
      log(`  Price XHR found: ${pricesXhr.url}`);
      try {
        const data = JSON.parse(pricesXhr.body);
        log(`  Price data: ${JSON.stringify(data).slice(0, 500)}`);
        return { priceData: data, priceUrl: pricesXhr.url };
      } catch(_) {
        log(`  Price body: ${pricesXhr.body.slice(0, 300)}`);
      }
    }

    // Log what XHR calls were made for debugging
    const restCalls = xhrLog.filter(x => x.url.includes('/service/rest/v1/'));
    log(`  Total REST calls: ${restCalls.length}`);
    for (const c of restCalls.slice(-5)) {
      if (c.url.includes('/prices') || c.url.includes('/variant') || c.url.includes('/product')) {
        log(`    ${c.status} ${c.url.slice(0, 100)}`);
      }
    }

    // Last resort: check what changed in the DOM
    const domPrices = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*="price"], [id*="price"], .price-total'))
        .map(el => el.textContent?.trim()).filter(t => t && /\$/.test(t)).slice(0, 5)
    );
    log(`  DOM prices: ${JSON.stringify(domPrices)}`);

    return null;
  }

  try {
    const bcResult = await captureGP(
      'https://www.gotprint.com/products/business-cards/order',
      'GP Business Cards', '2" x 3.5"'
    );

    if (bcResult?.priceData) {
      const data = bcResult.priceData;
      // GP price format varies — could be {qty: price} or [{qty, price}] or {prices: [...]}
      log(`BC price data type: ${typeof data}, keys: ${Array.isArray(data) ? 'array' : Object.keys(data).slice(0,5).join(', ')}`);
      const priceMap = Array.isArray(data)
        ? Object.fromEntries(data.map(p => [p.qty || p.quantity, p.price || p.totalPrice || p.total]))
        : data;
      for (const [qty, price] of Object.entries(priceMap)) {
        const q = parseInt(qty);
        if (q > 0 && price) {
          log(`  GP BC qty=${q}: $${price}`);
          if ([250, 500, 1000].includes(q)) {
            confirmed.business_cards.push({
              competitor: 'GotPrint', product_type: 'business_cards',
              spec: { qty: q, size: '3.5"x2"', paper: '14pt Gloss', sides: '4/4' },
              total_price: parseFloat(price),
              unit_price: +(parseFloat(price) / q).toFixed(5),
            });
          }
        }
      }
    }

    const flyResult = await captureGP(
      'https://www.gotprint.com/products/flyers/order',
      'GP Flyers', '4" x 6"'
    );

    if (flyResult?.priceData) {
      const data = flyResult.priceData;
      log(`Flyer price data: ${JSON.stringify(data).slice(0, 300)}`);
      const priceMap = Array.isArray(data)
        ? Object.fromEntries(data.map(p => [p.qty || p.quantity, p.price || p.totalPrice || p.total]))
        : data;
      for (const [qty, price] of Object.entries(priceMap)) {
        const q = parseInt(qty);
        if (q > 0 && price) {
          log(`  GP Flyer qty=${q}: $${price}`);
          if ([500, 1000, 2500].includes(q)) {
            confirmed.flyers_postcards.push({
              competitor: 'GotPrint', product_type: 'flyers_postcards',
              spec: { qty: q, size: '4"x6"', paper: '14pt Gloss', sides: '4/4' },
              total_price: parseFloat(price),
              unit_price: +(parseFloat(price) / q).toFixed(5),
            });
          }
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
// UPrinting Stickers — load page, read Angular configurator, capture live call
// then submit with 3" circle + benchmark qtys
// ─────────────────────────────────────────────────────────────────────────────
async function upStickersFix(browser) {
  log('\n=== UPrinting Die-Cut Stickers — Angular form capture ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const calls = [];
  let freshAuth = UP_AUTH;

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('digitalroom.com')) {
      try {
        const body = await resp.text();
        const reqBody = await resp.request().postBody()?.catch(() => null);
        const h = resp.request().headers();
        if (h['authorization']) freshAuth = h['authorization'];
        calls.push({ url: u, method: resp.request().method(), status: resp.status(), body, reqBody });
        log(`  UP XHR: ${resp.request().method()} ${u.slice(0, 80)} → ${resp.status()}`);
        if (reqBody) log(`    Req: ${String(reqBody).slice(0, 300)}`);
        if (u.includes('computePrice') && resp.status() === 200) {
          try {
            const b = JSON.parse(body);
            log(`    total_price: ${b.total_price}, exceeded: ${b.exceeded_pricing_threshold}`);
          } catch (_) {}
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();

  try {
    log('Loading UP die-cut sticker page...');
    await page.goto('https://www.uprinting.com/die-cut-stickers.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wait(10000); // Wait for Angular to fully init

    // Check for Angular-driven dimension inputs (not <select> elements)
    const inputs = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('input, select, [ng-model], [data-ng-model]'));
      return all.map(el => ({
        tag: el.tagName, type: el.type, name: el.name, id: el.id,
        ngModel: el.getAttribute('ng-model') || el.getAttribute('data-ng-model'),
        value: el.value,
        cls: el.className?.slice(0, 40),
      })).filter(e => e.tag !== 'INPUT' || e.type !== 'hidden').slice(0, 30);
    });
    log(`Angular inputs: ${JSON.stringify(inputs)}`);

    // Look for width/height inputs specifically
    const widthInput = await page.$('[ng-model*="width"], [name*="width"], #width, input[placeholder*="width" i]');
    const heightInput = await page.$('[ng-model*="height"], [name*="height"], #height, input[placeholder*="height" i]');
    log(`Width input found: ${!!widthInput}, Height input found: ${!!heightInput}`);

    if (widthInput && heightInput) {
      // Fill in 3" dimensions
      await widthInput.triple_click().catch(() => widthInput.click());
      await widthInput.fill('3');
      await heightInput.triple_click().catch(() => heightInput.click());
      await heightInput.fill('3');
      await wait(3000);
      log('Filled 3x3 dimensions');
    }

    // Check for shape selector (circle)
    const shapeEl = await page.$('[ng-model*="shape"], [name*="shape"], select[name*="diecut"], .shape-select');
    if (shapeEl) {
      log('Shape selector found');
      const options = await page.evaluate(el => Array.from(el.options || []).map(o => ({ v: o.value, t: o.text })), shapeEl);
      log(`Shape options: ${JSON.stringify(options.slice(0, 6))}`);
      const circle = options.find(o => /circle/i.test(o.t));
      if (circle) {
        await page.selectOption(shapeEl, circle.v);
        await wait(2000);
      }
    }

    // Look for quantity input/select
    const qtyEl = await page.$('[ng-model*="qty"], [ng-model*="quantity"], [name*="qty"], select[name*="quantity"]');
    if (qtyEl) {
      log('Qty selector found');
    }

    // Wait for any API calls to fire after interactions
    await wait(5000);

    const computeCalls = calls.filter(c => c.url.includes('computePrice'));
    log(`\ncomputePrice calls captured: ${computeCalls.length}`);

    for (const c of computeCalls) {
      let reqBody = {};
      let respBody = {};
      try { reqBody = JSON.parse(c.reqBody || '{}'); } catch(_) {}
      try { respBody = JSON.parse(c.body || '{}'); } catch(_) {}
      log(`  Req: ${JSON.stringify(reqBody)}`);
      log(`  Resp total_price: ${respBody.total_price}, exceeded: ${respBody.exceeded_pricing_threshold}`);

      if (respBody.total_price && respBody.exceeded_pricing_threshold !== 'y') {
        // Use this as template for our benchmark calls
        const templateBody = { ...reqBody };
        log(`  Valid price! Using as template.`);

        // Now call for different qtys
        for (const qty of [100, 250, 500]) {
          const body = { ...templateBody, qty: String(qty) };
          const r = await httpPost('https://calculator.digitalroom.com/v1/computePrice', body, {
            'Authorization': freshAuth, 'Origin': 'https://www.uprinting.com',
            'Referer': 'https://www.uprinting.com/die-cut-stickers.html',
          });
          log(`  UP Sticker qty=${qty}: status=${r.status}, total_price=${r.body?.total_price}`);
          if (r.status === 200 && r.body?.total_price && r.body.exceeded_pricing_threshold !== 'y') {
            confirmed.diecut_stickers.push({
              competitor: 'UPrinting', product_type: 'diecut_stickers',
              spec: { qty, shape: 'circle', size: '3"x3"' },
              total_price: parseFloat(r.body.total_price),
              unit_price: parseFloat(r.body.unit_price || 0),
            });
          }
          await wait(300);
        }
        break;
      }
    }

    // If no valid computePrice call, try using the page's Angular scope to get the API params
    if (computeCalls.filter(c => { try { return JSON.parse(c.body)?.exceeded_pricing_threshold !== 'y'; } catch(_) { return false; } }).length === 0) {
      log('\nNo valid computePrice captured. Trying to read Angular scope data...');

      // Try reading product data from page scripts
      const productData = await page.evaluate(() => {
        // Look for window-level product/calculator config
        const keys = Object.keys(window).filter(k => /product|calculator|sticker|config|ctrl/i.test(k));
        const data = {};
        for (const k of keys.slice(0, 10)) {
          try { data[k] = JSON.stringify(window[k]).slice(0, 200); } catch(_) {}
        }
        // Try Angular controllers
        try {
          const scope = window.angular?.element(document.querySelector('[ng-controller]'))?.scope?.();
          data.angularScope = scope ? JSON.stringify(scope).slice(0, 500) : null;
        } catch(_) {}
        return data;
      });
      log(`Product data: ${JSON.stringify(productData)}`);

      // Try direct API call with proper dimension encoding
      // UP sticker uses attr10=60261 (circle) + a size attribute or width/height in a specific format
      // Let's check what getData/55 `easy_mapping` says about size
      const dataR = await httpPost('https://calculator.digitalroom.com/v1/getData/55',
        { publishedVersion: true },
        { 'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com' }
      );

      if (dataR.status === 200 && dataR.body) {
        const d = dataR.body;
        log(`getData dynamic_size: ${d.dynamic_size}`);
        log(`getData start_width: ${d.start_width}, end_width: ${d.end_width}`);
        log(`getData start_height: ${d.start_height}, end_height: ${d.end_height}`);
        log(`getData start_qty: ${d.start_qty}, end_qty: ${d.end_qty}`);
        log(`getData size_increment: ${d.size_increment}`);

        // dynamic_size=true means we pass custom width/height
        // But why is total_price=1 and exceeded=y?
        // The issue: price grid uses a STACK (GRID_STACK) — need proper width/height units
        // Maybe inches need to be passed differently (e.g. in points or 0.1" increments)

        log(`\nTrying different width/height encodings for 3x3 circle...`);

        // Try different formats
        const attempts = [
          { product_id: '55', attr10: '60261', width: 3, height: 3, qty: 100 },
          { product_id: '55', attr10: '60261', width: '3.00', height: '3.00', qty: 100 },
          { product_id: '55', attr10: '60261', width: 30, height: 30, qty: 100 }, // in 0.1" units?
          { product_id: '55', attr10: '60261', w: 3, h: 3, quantity: 100 },
          { product_id: '55', attr10: '60261', customWidth: 3, customHeight: 3, qty: 100 },
          { product_id: '55', attr10: '60261', width: 3, height: 3, qty: 100, sizeUnit: 'in' },
        ];

        for (let i = 0; i < attempts.length; i++) {
          const body = { ...attempts[i], productType: 'offset', publishedVersion: true, disableDataCache: true, disablePriceCache: true };
          const r = await httpPost('https://calculator.digitalroom.com/v1/computePrice', body, {
            'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com',
            'Referer': 'https://www.uprinting.com/die-cut-stickers.html',
          });
          log(`  Attempt ${i+1} (${JSON.stringify(attempts[i])}): ${r.status}, total=${r.body?.total_price}, exceeded=${r.body?.exceeded_pricing_threshold}`);
          if (r.status === 200 && r.body?.total_price && r.body.exceeded_pricing_threshold !== 'y') {
            log(`  SUCCESS! Using this format.`);
            for (const qty of [100, 250, 500]) {
              const fb = { ...body, qty };
              const fr = await httpPost('https://calculator.digitalroom.com/v1/computePrice', fb, {
                'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/die-cut-stickers.html',
              });
              if (fr.status === 200 && fr.body?.total_price) {
                confirmed.diecut_stickers.push({
                  competitor: 'UPrinting', product_type: 'diecut_stickers',
                  spec: { qty, shape: 'circle', size: '3"x3"' },
                  total_price: parseFloat(fr.body.total_price),
                  unit_price: parseFloat(fr.body.unit_price || 0),
                });
                log(`  Sticker qty=${qty}: $${fr.body.total_price}`);
              }
              await wait(300);
            }
            break;
          }
          await wait(300);
        }
      }
    }

  } catch (e) {
    err('UP stickers fix: ' + e.message);
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
    ...confirmed.business_cards.map(r => ({ ...r, product_type: 'business_cards' })),
    ...confirmed.flyers_postcards.map(r => ({ ...r, product_type: 'flyers_postcards' })),
    ...confirmed.diecut_stickers.map(r => ({ ...r, product_type: 'diecut_stickers' })),
  ];

  for (const r of all) {
    if (!r.total_price || !r.spec?.qty) { log(`Skip: ${JSON.stringify(r).slice(0,80)}`); continue; }
    const qid = `${r.product_type}-${r.competitor.toLowerCase().replace(/\s+/g, '-')}-${r.spec.qty}`;

    const entry = {
      query_id: qid, competitor: r.competitor, product_type: r.product_type,
      quantity: r.spec.qty, total_price: r.total_price,
      unit_price: r.unit_price || +(r.total_price / r.spec.qty).toFixed(5),
      spec: r.spec, status: 'live',
      captured_at: new Date().toISOString(), source: 'playwright-phase4',
    };

    const existing = (norm.queries || []).find(q => q.query_id === qid);
    if (existing) {
      existing.competitor_results = existing.competitor_results || [];
      if (!existing.competitor_results.find(cr => cr.competitor === r.competitor)) {
        existing.competitor_results.push(entry); added++;
        log(`Updated query: ${qid}`);
      } else { log(`Skip dup: ${qid}`); }
    } else {
      norm.queries = norm.queries || [];
      norm.queries.push({ query_id: qid, product_type: r.product_type, competitor_results: [entry] });
      added++;
      log(`New query: ${qid}`);
    }
  }

  norm.last_capture_date = new Date().toISOString().split('T')[0] + ' · PUL-288 Phase 4';
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-288 Phase 4 — Final Pricing Capture ===');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await vpFix(browser);
    await axiomFix(browser);
    await gpFix(browser);
    await upStickersFix(browser);
  } finally {
    await browser.close();
  }

  const added = updateNorm();

  log('\n=== FINAL SUMMARY ===');
  log(`Business Cards: ${confirmed.business_cards.length} price points`);
  log(`Flyers/Postcards: ${confirmed.flyers_postcards.length} price points`);
  log(`Die-cut Stickers: ${confirmed.diecut_stickers.length} price points`);
  log(`Added to normalized JSON: ${added}`);
  log('');
  confirmed.business_cards.forEach(r => log(`  BC  ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
  confirmed.flyers_postcards.forEach(r => log(`  FLY ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
  confirmed.diecut_stickers.forEach(r => log(`  STK ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
