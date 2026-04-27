#!/usr/bin/env node
/**
 * capture-phase5.js  —  PUL-288 Phase 5 (Final)
 *
 * Remaining targets:
 *   1. Axiom BC qty=250/500/1000  — use Playwright waitForSelector after click, not evaluate()
 *   2. Axiom Flyers qty=500/1000/2500 — load correct URL, wait for ant-select
 *   3. GotPrint BC  — fix regex for size detection; wait for paper select to be enabled
 *   4. GotPrint Flyers — same
 *   5. UP Die-Cut Stickers — use real Angular attr IDs from live page share URL
 *                            attr247=width(in), attr248=height(in), attr10=861975(circle)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const ROOT = path.resolve(__dirname, '..');
const NORM = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');

const log  = m => console.log(`[p5]  ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

const confirmed = { business_cards: [], flyers_postcards: [], diecut_stickers: [] };

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
// UPrinting Stickers — use real Angular attr IDs from live page
// Live page share URL has: attr247=2 (width), attr248=2 (height), attr10=861975 (circle)
// ─────────────────────────────────────────────────────────────────────────────
async function upStickersV2() {
  log('\n=== UP Stickers: Using real Angular attr IDs ===');

  // Base attrs from live page share URL (product_id=55, current state: 2"x2" circle)
  const baseAttrs = {
    product_id: '55',
    attr1: '1723312',   // likely: proofing
    attr3: '1355567',   // likely: coatings
    attr4: '2384',      // likely: turnaround
    attr5: '15569',     // likely: sides
    attr6: '140229',    // likely: finishing
    attr10: '861975',   // shape = circle (NOT 60261 which is from getEasyMapping)
    attr247: '2',       // width in inches (default=2, we want 3)
    attr248: '2',       // height in inches (default=2, we want 3)
    attr400: '119070',  // unknown but present in live URL
    attr1381: '1723313',// unknown but present in live URL
    productType: 'offset',
    publishedVersion: true,
    disableDataCache: true,
    disablePriceCache: true,
  };

  // First: test with default 2x2 to confirm the attr set works
  const testR = await httpPost('https://calculator.digitalroom.com/v1/computePrice',
    { ...baseAttrs, qty: 100 },
    { 'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/die-cut-stickers.html' }
  );
  log(`Test 2"x2" circle qty=100: status=${testR.status}, total=${testR.body?.total_price}, exceeded=${testR.body?.exceeded_pricing_threshold}`);

  if (testR.status === 200 && testR.body?.total_price && testR.body.exceeded_pricing_threshold !== 'y') {
    log('Base attrs work! Now pricing 3"x3" circle...');

    // Now get prices for 3"x3" circle at benchmark qtys
    for (const qty of [100, 250, 500]) {
      const body = { ...baseAttrs, attr247: '3', attr248: '3', qty };
      const r = await httpPost('https://calculator.digitalroom.com/v1/computePrice', body,
        { 'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/die-cut-stickers.html' }
      );
      log(`UP Sticker 3"x3" qty=${qty}: status=${r.status}, total=${r.body?.total_price}, exceeded=${r.body?.exceeded_pricing_threshold}`);
      if (r.status === 200 && r.body?.total_price && r.body.exceeded_pricing_threshold !== 'y') {
        confirmed.diecut_stickers.push({
          competitor: 'UPrinting', product_type: 'diecut_stickers',
          spec: { qty, shape: 'circle', size: '3"x3"', paper: 'White BOPP' },
          total_price: parseFloat(r.body.total_price),
          unit_price: parseFloat(r.body.unit_price || 0),
        });
      }
      await wait(300);
    }
  } else {
    log(`Base attrs FAILED. Trying without optional attrs...`);
    // Try stripping down to minimal attrs
    const minimalBody = {
      product_id: '55',
      attr10: '861975',   // circle shape
      attr247: '3',       // width=3"
      attr248: '3',       // height=3"
      qty: 100,
      productType: 'offset',
      publishedVersion: true,
      disableDataCache: true,
      disablePriceCache: true,
    };
    const r2 = await httpPost('https://calculator.digitalroom.com/v1/computePrice', minimalBody,
      { 'Authorization': UP_AUTH, 'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/die-cut-stickers.html' }
    );
    log(`Minimal 3"x3" qty=100: status=${r2.status}, total=${r2.body?.total_price}, exceeded=${r2.body?.exceeded_pricing_threshold}`);
    log(`Full resp: ${JSON.stringify(r2.body).slice(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Axiom Print — use waitForSelector after clicking dropdown
// ─────────────────────────────────────────────────────────────────────────────
async function axiomV2(browser) {
  log('\n=== Axiom: Playwright waitForSelector dropdown ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  async function getPrice() {
    const el = await page.$('[class*="finalPrice"]');
    if (!el) return null;
    const text = await el.textContent();
    const m = text.trim().match(/\$([\d,]+\.\d{2})/);
    return m ? parseFloat(m[1].replace(',', '')) : null;
  }

  async function selectQty(targetQty) {
    // Find qty select: the one whose current value looks like a number
    const allSelectors = await page.$$('.ant-select-selector');
    let qtyIdx = -1;
    for (let i = 0; i < allSelectors.length; i++) {
      const text = await allSelectors[i].$eval('.ant-select-selection-item', el => el.textContent.trim()).catch(() => '');
      if (/^\d+$/.test(text)) { qtyIdx = i; break; }
    }
    if (qtyIdx === -1) { log(`  No qty select found`); return false; }

    const currentVal = await allSelectors[qtyIdx].$eval('.ant-select-selection-item', el => el.textContent.trim()).catch(() => '?');
    log(`  Qty select at index ${qtyIdx}, current: ${currentVal}`);

    if (currentVal === String(targetQty)) { log(`  Already at ${targetQty}`); return true; }

    // Click to open
    await allSelectors[qtyIdx].click();
    // Wait for dropdown with a visible option
    try {
      await page.waitForSelector('.ant-select-dropdown .ant-select-item-option', { state: 'visible', timeout: 5000 });
    } catch (_) {
      log(`  Dropdown did not appear after click`);
      // Try pressing space or arrow key
      await page.keyboard.press('ArrowDown');
      await wait(500);
    }

    // Get all options from ANY visible dropdown (Ant Design uses a portal)
    const options = await page.$$('.ant-select-item-option');
    log(`  Found ${options.length} options in dropdown`);
    const optTexts = [];
    for (const opt of options) {
      const t = await opt.textContent().catch(() => '');
      optTexts.push(t.trim());
    }
    log(`  Options: ${JSON.stringify(optTexts)}`);

    // Click the target
    for (const opt of options) {
      const t = await opt.textContent().catch(() => '');
      if (t.trim() === String(targetQty)) {
        await opt.click();
        await wait(2500);
        return true;
      }
    }

    // Not found: press Escape to close
    await page.keyboard.press('Escape');
    await wait(300);
    log(`  Option ${targetQty} not found. Available: ${JSON.stringify(optTexts)}`);
    return false;
  }

  try {
    // Business Cards
    log('Loading Axiom BC...');
    await page.goto('https://axiomprint.com/product/classic-business-cards-160', { waitUntil: 'networkidle', timeout: 45000 });
    await wait(5000);

    // Get default price (qty=50)
    const p50 = await getPrice();
    log(`BC qty=50 price: $${p50}`);
    if (p50) confirmed.business_cards.push({
      competitor: 'Axiom Print', product_type: 'business_cards',
      spec: { qty: 50, size: '3.5"x2"', paper: 'Glossy' },
      total_price: p50, unit_price: +(p50 / 50).toFixed(5),
    });

    for (const qty of [250, 500, 1000]) {
      log(`\nAxiom BC qty=${qty}...`);
      const ok = await selectQty(qty);
      if (ok) {
        const price = await getPrice();
        log(`  price: $${price}`);
        if (price) confirmed.business_cards.push({
          competitor: 'Axiom Print', product_type: 'business_cards',
          spec: { qty, size: '3.5"x2"', paper: 'Glossy' },
          total_price: price, unit_price: +(price / qty).toFixed(5),
        });
      }
    }

    // Flyers
    log('\nLoading Axiom Flyers...');
    await page.goto('https://axiomprint.com/product/flyers-printing-102', { waitUntil: 'networkidle', timeout: 45000 });
    await wait(5000);

    const flySelects = await page.$$('.ant-select-selector');
    log(`Flyer ant-selects: ${flySelects.length}`);
    const flySelectVals = [];
    for (const s of flySelects) {
      const t = await s.$eval('.ant-select-selection-item', el => el.textContent.trim()).catch(() => 'N/A');
      flySelectVals.push(t);
    }
    log(`Flyer select values: ${JSON.stringify(flySelectVals)}`);

    const flyDefaultPrice = await getPrice();
    log(`Flyer default price: $${flyDefaultPrice}`);

    if (flySelects.length > 0) {
      // Try to select 4"x6" size (first dropdown)
      log('Selecting 4"x6" size...');
      await flySelects[0].click();
      try {
        await page.waitForSelector('.ant-select-dropdown .ant-select-item-option', { state: 'visible', timeout: 5000 });
        const sizeOpts = await page.$$('.ant-select-item-option');
        const sizeTexts = [];
        for (const o of sizeOpts) {
          const t = await o.textContent().catch(() => '');
          sizeTexts.push(t.trim());
        }
        log(`Size options: ${JSON.stringify(sizeTexts)}`);

        // Find 4x6
        for (const opt of sizeOpts) {
          const t = await opt.textContent().catch(() => '');
          if (/4.*6|6.*4/i.test(t)) {
            log(`Clicking size: ${t.trim()}`);
            await opt.click();
            await wait(3000);
            break;
          }
        }
      } catch (e) {
        log(`Size dropdown error: ${e.message}`);
        await page.keyboard.press('Escape').catch(() => {});
      }

      // Now select qty
      for (const qty of [500, 1000, 2500]) {
        log(`\nAxiom Flyer qty=${qty}...`);
        const ok = await selectQty(qty);
        if (ok) {
          const price = await getPrice();
          log(`  price: $${price}`);
          if (price) confirmed.flyers_postcards.push({
            competitor: 'Axiom Print', product_type: 'flyers_postcards',
            spec: { qty, size: '4"x6"' },
            total_price: price, unit_price: +(price / qty).toFixed(5),
          });
        }
      }
    }

  } catch (e) {
    err('Axiom v2: ' + e.message);
  } finally {
    await page.close();
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GotPrint — fix size regex + wait for paper to be enabled
// ─────────────────────────────────────────────────────────────────────────────
async function gpV2(browser) {
  log('\n=== GotPrint: Fixed size regex + wait for enabled ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com')) return;
    try {
      const body = await resp.text();
      xhrLog.push({ url: u, status: resp.status(), body });
      if (u.includes('/service/rest/v1/products/') && (u.includes('/prices') || u.includes('/variants') || u.includes('/quantities'))) {
        log(`  GP REST: ${resp.status()} ${u.slice(0, 120)}`);
        log(`  Body: ${body.slice(0, 300)}`);
      }
    } catch (_) {}
  });

  const page = await context.newPage();

  async function captureGP(productUrl, label, targetSizeText, targetQtys) {
    log(`\n── ${label}`);
    xhrLog.length = 0;

    await page.goto(productUrl, { waitUntil: 'load', timeout: 60000 });
    await wait(8000);

    if (page.url().includes('home.html')) { log('  BLOCKED'); return null; }

    // Read all selects with full option text
    const selects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map((s, i) => ({
        idx: i, name: s.name, id: s.id, disabled: s.disabled,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim(), d: o.disabled }))
      }))
    );

    log(`Selects: ${selects.map(s => `[${s.idx}]${s.name||s.id||'?'}(${s.options.length}) ${s.disabled?'DISABLED':''}`).join(', ')}`);

    // FIXED: detect size select by options containing dimension pattern like "2" x 3.5""
    const sizeSel = selects.find(s => s.options.some(o => /\d['"]\s*x\s*\d|\d+\s*x\s*\d+['"]/i.test(o.t)));
    // Fallback: unnamed select with > 4 options that includes numbers with x
    const sizeSelFallback = !sizeSel && selects.find(s => !s.name && s.options.length > 4 && s.options.some(o => / x /i.test(o.t)));
    const finalSizeSel = sizeSel || sizeSelFallback;

    log(`Size select found: [${finalSizeSel?.idx}] (pattern match: ${!!sizeSel}, fallback: ${!!sizeSelFallback})`);
    if (finalSizeSel) log(`Size options: ${JSON.stringify(finalSizeSel.options.slice(0, 8))}`);

    if (!finalSizeSel) {
      // Last resort: select by index 1 which had size options in all prior runs
      const idx1 = selects.find(s => s.idx === 1);
      log(`[Fallback] Using select index 1: ${JSON.stringify(idx1?.options?.slice(0, 4))}`);
      if (idx1 && idx1.options.length > 2) {
        const targetOpt = idx1.options.find(o => o.t.includes(targetSizeText) && !o.d) || idx1.options.find(o => o.v && !o.d);
        if (targetOpt) {
          log(`[Fallback] Selecting size: ${targetOpt.v} "${targetOpt.t}"`);
          await page.locator('select').nth(1).selectOption(targetOpt.v);
          await wait(4000);
        }
      }
    } else {
      const targetOpt = finalSizeSel.options.find(o => o.t.includes(targetSizeText) && !o.d)
                     || finalSizeSel.options.find(o => o.v && !o.d);
      if (targetOpt) {
        log(`Selecting size: ${targetOpt.v} "${targetOpt.t}"`);
        await page.locator('select').nth(finalSizeSel.idx).selectOption(targetOpt.v);
        await wait(4000);
      }
    }

    // Wait for paper select to become enabled (it's disabled until size is selected)
    const paperSel = selects.find(s => s.options.some(o => /14\s*pt|gloss|matte/i.test(o.t)));
    if (paperSel) {
      log(`Waiting for paper select [${paperSel.idx}] to be enabled...`);
      try {
        await page.waitForFunction(idx => {
          const sels = document.querySelectorAll('select');
          return sels[idx] && !sels[idx].disabled;
        }, paperSel.idx, { timeout: 10000 });
        log('Paper select enabled!');
      } catch (_) {
        log('Paper select still disabled after timeout — trying anyway');
      }

      // Re-read paper options
      const paperOpts = await page.evaluate(idx => {
        const sel = document.querySelectorAll('select')[idx];
        return Array.from(sel?.options || []).map(o => ({ v: o.value, t: o.text.trim(), d: o.disabled }));
      }, paperSel.idx);
      log(`Paper options: ${JSON.stringify(paperOpts.slice(0, 6))}`);

      const pt14Gloss = paperOpts.find(o => /14\s*pt.*gloss/i.test(o.t) && !o.d)
                     || paperOpts.find(o => /14\s*pt/i.test(o.t) && !o.d)
                     || paperOpts.find(o => o.v && !o.d);
      if (pt14Gloss) {
        log(`Selecting paper: ${pt14Gloss.v} "${pt14Gloss.t}"`);
        await page.locator('select').nth(paperSel.idx).selectOption(pt14Gloss.v);
        await wait(4000);
      }
    }

    // Select color
    const colorSel = selects.find(s => s.options.some(o => /full.color|4\/4/i.test(o.t)));
    if (colorSel) {
      const fullColor = colorSel.options.find(o => /4\/4|full color both/i.test(o.t) && !o.d)
                     || colorSel.options.find(o => /full.color/i.test(o.t) && !o.d)
                     || colorSel.options.find(o => o.v && !o.d);
      if (fullColor) {
        log(`Selecting color: ${fullColor.v} "${fullColor.t}"`);
        await page.locator('select').nth(colorSel.idx).selectOption(fullColor.v);
        await wait(5000);
      }
    }

    // Check REST calls for price data
    const pricesXhr = [...xhrLog].reverse().find(x => x.url.includes('/prices'));
    const variantsXhr = [...xhrLog].reverse().find(x => x.url.includes('/products/') && x.url.includes('/quantities'));
    const productXhr = [...xhrLog].reverse().find(x => /\/products\/\d+\/prices/.test(x.url));

    log(`Price XHR found: ${!!pricesXhr}`);
    log(`Quantities XHR found: ${!!variantsXhr}`);
    log(`Product prices XHR: ${!!productXhr}`);

    // If we have prices, extract them
    if (pricesXhr) {
      try {
        const data = JSON.parse(pricesXhr.body);
        log(`Price data: ${JSON.stringify(data).slice(0, 400)}`);
        return { priceData: data, priceUrl: pricesXhr.url };
      } catch(_) {
        log(`Price body: ${pricesXhr.body.slice(0, 200)}`);
      }
    }

    // Check all REST calls for price info
    const allRestCalls = xhrLog.filter(x => x.url.includes('/service/rest'));
    log(`Total REST calls: ${allRestCalls.length}`);
    for (const c of allRestCalls.slice(-8)) {
      log(`  ${c.status} ${c.url.slice(0, 100)}`);
    }

    // Check DOM for price
    const domPrice = await page.evaluate(() => {
      const el = document.querySelector('.grand-total, .cart-total, [class*="total-price"], [id*="total"]');
      return el?.textContent?.trim();
    });
    if (domPrice) log(`DOM price: ${domPrice}`);

    // Extract variant/product IDs from captured XHR to hit price endpoint directly
    const productXhrs = allRestCalls.filter(x => /\/products\/\d+/.test(x.url));
    for (const c of productXhrs) {
      const m = c.url.match(/\/products\/(\d+)/);
      if (m) {
        log(`  Product ID from XHR: ${m[1]}, URL: ${c.url.slice(0, 100)}`);
      }
    }

    // Try extracting from quantities endpoint which GP fires when all options selected
    const qtyEndpoints = allRestCalls.filter(x => x.url.includes('/quantities'));
    for (const c of qtyEndpoints) {
      log(`  Quantities endpoint: ${c.url.slice(0, 100)}`);
      try {
        const d = JSON.parse(c.body);
        log(`  Body: ${JSON.stringify(d).slice(0, 300)}`);
      } catch(_) {}
    }

    return null;
  }

  try {
    const bcResult = await captureGP(
      'https://www.gotprint.com/products/business-cards/order',
      'GP Business Cards', '2" x 3.5"', [250, 500, 1000]
    );

    if (bcResult?.priceData) {
      const data = bcResult.priceData;
      const priceMap = Array.isArray(data)
        ? Object.fromEntries(data.map(p => [p.qty || p.quantity, p.price || p.totalPrice || p.total]))
        : data;
      for (const [qty, price] of Object.entries(priceMap)) {
        const q = parseInt(qty);
        if ([250, 500, 1000].includes(q) && price) {
          confirmed.business_cards.push({
            competitor: 'GotPrint', product_type: 'business_cards',
            spec: { qty: q, size: '3.5"x2"', paper: '14pt Gloss', sides: '4/4' },
            total_price: parseFloat(price),
            unit_price: +(parseFloat(price) / q).toFixed(5),
          });
          log(`GP BC qty=${q}: $${price}`);
        }
      }
    }

    const flyResult = await captureGP(
      'https://www.gotprint.com/products/flyers/order',
      'GP Flyers', '4" x 6"', [500, 1000, 2500]
    );

    if (flyResult?.priceData) {
      const data = flyResult.priceData;
      const priceMap = Array.isArray(data)
        ? Object.fromEntries(data.map(p => [p.qty || p.quantity, p.price || p.totalPrice || p.total]))
        : data;
      for (const [qty, price] of Object.entries(priceMap)) {
        const q = parseInt(qty);
        if ([500, 1000, 2500].includes(q) && price) {
          confirmed.flyers_postcards.push({
            competitor: 'GotPrint', product_type: 'flyers_postcards',
            spec: { qty: q, size: '4"x6"', paper: '14pt Gloss', sides: '4/4' },
            total_price: parseFloat(price),
            unit_price: +(parseFloat(price) / q).toFixed(5),
          });
          log(`GP Flyer qty=${q}: $${price}`);
        }
      }
    }

  } catch (e) {
    err('GP v2: ' + e.message);
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
    if (!r.total_price || !r.spec?.qty) continue;
    const qid = `${r.product_type}-${r.competitor.toLowerCase().replace(/\s+/g, '-')}-${r.spec.qty}`;
    const entry = {
      query_id: qid, competitor: r.competitor, product_type: r.product_type,
      quantity: r.spec.qty, total_price: r.total_price,
      unit_price: r.unit_price || +(r.total_price / r.spec.qty).toFixed(5),
      spec: r.spec, status: 'live',
      captured_at: new Date().toISOString(), source: 'playwright-phase5',
    };
    const existing = (norm.queries || []).find(q => q.query_id === qid);
    if (existing) {
      existing.competitor_results = existing.competitor_results || [];
      if (!existing.competitor_results.find(cr => cr.competitor === r.competitor)) {
        existing.competitor_results.push(entry); added++;
        log(`Updated: ${qid}`);
      } else { log(`Skip dup: ${qid}`); }
    } else {
      norm.queries = norm.queries || [];
      norm.queries.push({ query_id: qid, product_type: r.product_type, competitor_results: [entry] });
      added++; log(`New: ${qid}`);
    }
  }

  norm.last_capture_date = new Date().toISOString().split('T')[0] + ' · PUL-288 Phase 5';
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-288 Phase 5 — Final Capture ===');

  // UP Stickers: no browser needed
  await upStickersV2();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    await axiomV2(browser);
    await gpV2(browser);
  } finally {
    await browser.close();
  }

  const added = updateNorm();

  log('\n=== FINAL SUMMARY ===');
  log(`BC: ${confirmed.business_cards.length} pts, FLY: ${confirmed.flyers_postcards.length} pts, STK: ${confirmed.diecut_stickers.length} pts`);
  log(`Added to norm JSON: ${added}`);
  confirmed.business_cards.forEach(r => log(`  BC  ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
  confirmed.flyers_postcards.forEach(r => log(`  FLY ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
  confirmed.diecut_stickers.forEach(r => log(`  STK ${r.competitor} qty=${r.spec?.qty}: $${r.total_price}`));
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
