#!/usr/bin/env node
/**
 * capture-pul305.js
 * PUL-305 — UPrinting BC/Flyers attr ID discovery + Axiom Flyers URL discovery
 *
 * Targets:
 *   UPrinting BC:     product_id=1, dynamic_size=n — need live attr IDs from page intercept
 *                     Benchmark: 3.5"×2", 14pt Gloss, 4/4, 250/500/1000 pcs
 *   UPrinting Flyers: product_id=5 — same issue, need live attr IDs
 *                     Benchmark: 4"×6", 14pt Gloss, 4/4, 500/1000/2500 pcs
 *   Axiom Flyers:     flyers-printing-102 fails in headless — find correct slug via nav
 *                     Benchmark: 500/1000/2500 pcs
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT    = path.resolve(__dirname, '..');
const NORM    = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const TODAY   = new Date().toISOString().split('T')[0];
const OUT     = path.join(ROOT, 'data', `capture-pul305-${TODAY}.json`);

const log  = m => console.log(`[305] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

function upPost(body) {
  const bodyStr = JSON.stringify({ productType: 'offset', publishedVersion: true,
    disableDataCache: true, disablePriceCache: true, addon_attributes_limit: {}, ...body });
  return new Promise((resolve, reject) => {
    const req = https.request('https://calculator.digitalroom.com/v1/computePrice', {
      method: 'POST',
      headers: {
        'Authorization': UP_AUTH, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/', 'User-Agent': UA,
      },
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

const output = {
  run_date: new Date().toISOString(),
  uprinting_bc:     { attr_ids: null, prices: [], errors: [] },
  uprinting_flyers: { attr_ids: null, prices: [], errors: [] },
  axiom_flyers:     { url_found: null, prices: [], errors: [] },
};

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting Business Cards — intercept live page to get valid attr IDs
// ─────────────────────────────────────────────────────────────────────────────
async function captureUprintingBC(browser) {
  log('\n═══ UPRINTING BUSINESS CARDS (product_id=1) ═══');
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const intercepted = [];
  let freshAuth = UP_AUTH;

  ctx.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('digitalroom.com')) return;
    try {
      const body = await resp.text();
      const reqH = resp.request().headers();
      if (reqH['authorization']) freshAuth = reqH['authorization'];
      intercepted.push({ url: u, method: resp.request().method(), status: resp.status(), body, reqBody: await resp.request().postBody().catch(() => null) });
      log(`UP XHR: ${resp.request().method()} ${u.slice(35)} → ${resp.status()}`);
    } catch (_) {}
  });

  const page = await ctx.newPage();
  try {
    log('Loading https://www.uprinting.com/business-cards.html ...');
    await page.goto('https://www.uprinting.com/business-cards.html', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await wait(10000); // Let Angular + page fully init and fire initial computePrice

    // Extract Angular scope attrs (if accessible)
    const scopeData = await page.evaluate(() => {
      try {
        // Look for the main calc element
        const el = document.querySelector('#calc_1_grid, [ng-app], [data-ng-app]');
        if (!el) return null;
        const scope = window.angular?.element(el)?.scope?.() || window.angular?.element(document.body)?.scope?.();
        if (!scope) return null;
        // Walk up to find the right scope
        const s2 = window.angular?.element(document.querySelector('[ng-controller]'))?.scope?.();
        return {
          priceData: s2?.priceData || scope?.priceData,
          selectedAttributes: s2?.selectedAttributes || scope?.selectedAttributes,
          attrValues: s2?.attrValues || scope?.attrValues,
          attrs: s2?.attrs || scope?.attrs,
        };
      } catch(e) { return { err: e.message }; }
    });
    log(`Angular scope: ${JSON.stringify(scopeData)?.slice(0, 200)}`);

    // Get all selects and share-config-input
    const pageInfo = await page.evaluate(() => {
      const shareInput = document.querySelector('#share_calc_config_input, [id*="share_calc"]');
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text?.trim() })).slice(0, 20),
      }));
      // Look for qty grid (the click-grid pattern used in roll-labels)
      const qtyGrid = document.querySelector('#calc_1_grid, .qty-grid, [class*="qty_grid"]');
      const qtyItems = qtyGrid
        ? Array.from(qtyGrid.querySelectorAll('a, button, li, [class*="grid-item"]'))
            .map(el => ({ text: el.textContent?.trim(), cls: el.className?.slice(0, 40) }))
            .filter(i => i.text)
            .slice(0, 20)
        : [];
      // Also read DOM-embedded attr data
      const attrEls = Array.from(document.querySelectorAll('[data-attr-id], [data-prod-attr-val-id], [data-value]'))
        .map(el => ({
          tag: el.tagName, cls: el.className?.slice(0, 40),
          attrId: el.dataset?.attrId, valId: el.dataset?.prodAttrValId || el.dataset?.value,
          text: el.textContent?.trim().slice(0, 30),
        }))
        .filter(e => e.attrId || e.valId)
        .slice(0, 40);
      return {
        url: location.href,
        title: document.title,
        shareInputVal: shareInput?.value?.slice(0, 200),
        selects,
        qtyItems,
        attrEls,
      };
    });
    log(`Page: ${pageInfo.title}`);
    log(`Share config: ${pageInfo.shareInputVal || 'none'}`);
    log(`Qty grid items: ${JSON.stringify(pageInfo.qtyItems)}`);

    // Find computePrice calls from page load
    const priceCalls = intercepted.filter(c => c.url.includes('computePrice') && c.method === 'POST');
    log(`computePrice calls intercepted: ${priceCalls.length}`);

    let baseAttrs = null;
    if (priceCalls.length > 0) {
      try {
        const firstCall = priceCalls[0];
        const reqBody = JSON.parse(firstCall.reqBody || '{}');
        log(`Default computePrice body: ${JSON.stringify(reqBody)}`);
        output.uprinting_bc.attr_ids = { raw: reqBody, source: 'page_intercept' };

        // Parse the response to see what was computed
        const respBody = JSON.parse(firstCall.body || '{}');
        log(`Default price: $${respBody.total_price} (${respBody.qty} pcs)`);
        log(`Order specs: ${JSON.stringify(respBody.order_specs?.slice(0, 5))}`);

        // Extract the attr map from the response's price_data/order_specs
        baseAttrs = reqBody;
      } catch(e) {
        log(`Parse error: ${e.message}`);
      }
    }

    // If we got base attrs, try to understand size/qty attrs from the page DOM
    // UPrinting BC uses Bootstrap dropdown — look for data attributes on <a> elements in dropdowns
    const attrMap = await page.evaluate(() => {
      const result = {};
      // Collect all dropdown items with data-value or data-attr
      const dropdownItems = document.querySelectorAll('.dropdown-menu a, [data-attr-val-id], [data-value]');
      dropdownItems.forEach(el => {
        const text = el.textContent?.trim();
        const val = el.dataset?.value || el.dataset?.attrValId;
        if (text && val) {
          if (!result[text]) result[text] = val;
        }
      });
      // Also look for hidden inputs with attr values
      const hiddenInputs = document.querySelectorAll('input[type="hidden"]');
      hiddenInputs.forEach(i => {
        if (i.name?.match(/^attr\d+$/) && i.value) {
          result[`_hidden_${i.name}`] = i.value;
        }
      });
      return result;
    });
    log(`DOM attr map: ${JSON.stringify(attrMap)}`);

    // Now try to navigate through qty options (250, 500, 1000)
    // First try clicking the qty grid items
    const targetQtys = [250, 500, 1000];

    for (const qty of targetQtys) {
      const beforeCount = intercepted.filter(c => c.url.includes('computePrice')).length;

      // Try clicking qty in the Bootstrap grid / dropdown
      const clicked = await page.evaluate(q => {
        // Find element containing the qty text (look for exact match first)
        const all = document.querySelectorAll('a, button, li, td, [class*="grid"], [class*="qty"]');
        for (const el of all) {
          const t = el.textContent?.trim().replace(/,/g, '');
          if (t === String(q)) {
            el.click();
            return { found: true, tag: el.tagName, cls: el.className?.slice(0, 40) };
          }
        }
        // Try select option
        for (const sel of document.querySelectorAll('select')) {
          const opt = Array.from(sel.options).find(o => o.text?.trim().replace(/,/g, '') === String(q) || o.value === String(q));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, tag: 'SELECT', name: sel.name };
          }
        }
        return { found: false };
      }, qty);

      log(`Qty ${qty} click: ${JSON.stringify(clicked)}`);
      await wait(3000);

      const afterCalls = intercepted.filter(c => c.url.includes('computePrice'));
      const newCall = afterCalls[afterCalls.length - 1];
      if (afterCalls.length > beforeCount && newCall) {
        try {
          const rb = JSON.parse(newCall.reqBody || '{}');
          const rsp = JSON.parse(newCall.body || '{}');
          const price = rsp.total_price;
          log(`  qty=${qty}: $${price} (attrs: ${JSON.stringify(rb)})`);
          if (price) {
            output.uprinting_bc.prices.push({
              competitor: 'UPrinting',
              product_type: 'business_cards',
              spec: { qty, size: '3.5"×2"', paper: '14pt Gloss', sides: '4/4' },
              total_price: parseFloat(price),
              unit_price: parseFloat(rsp.unit_price || (price / qty)),
              attr_body: rb,
              captured_at: new Date().toISOString(),
            });
          }
        } catch(e) { log(`  Parse error: ${e.message}`); }
      } else {
        log(`  No new computePrice call fired for qty=${qty}`);
      }
    }

    // If we still have no prices, try direct API calls using the captured baseAttrs
    if (output.uprinting_bc.prices.length === 0 && baseAttrs) {
      log('\nFalling back to direct API calls with intercepted attr IDs...');
      // Find qty attr_id from the response order_specs
      const firstCall = priceCalls[0];
      if (firstCall) {
        try {
          const respBody = JSON.parse(firstCall.body || '{}');
          const qtySpec = respBody.order_specs?.find(s => s.order_spec_code === 'QTY' || s.attribute_name === 'Quantity');
          const qtyAttrId = qtySpec?.attribute_id;
          log(`Qty attribute_id: ${qtyAttrId}`);

          // We need to find the qty attr_val_ids — try getEasyMapping
          const mapR = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ productType: 'offset', publishedVersion: true, disableDataCache: true });
            const req = https.request(`https://calculator.digitalroom.com/v1/getEasyMapping/1`, {
              method: 'POST', headers: { 'Authorization': freshAuth, 'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body), 'Origin': 'https://www.uprinting.com', 'User-Agent': UA },
            }, res => {
              let d = ''; res.on('data', c => d += c);
              res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, body: d }); } });
            });
            req.on('error', reject); req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body); req.end();
          });
          log(`getEasyMapping/1: status=${mapR.status}, entries=${mapR.body?.data?.length || 0}`);
          if (mapR.body?.data) log(`Entries: ${JSON.stringify(mapR.body.data.slice(0, 10))}`);
          output.uprinting_bc.attr_ids.easy_mapping = mapR.body?.data;
        } catch(e) { log(`Fallback error: ${e.message}`); }
      }
    }

    output.uprinting_bc.page_info = {
      shareInput: pageInfo.shareInputVal,
      selects: pageInfo.selects,
      qtyItems: pageInfo.qtyItems,
      attrEls: pageInfo.attrEls,
      attrMap,
      allIntercepted: intercepted.map(c => ({
        url: c.url.slice(35),
        status: c.status,
        reqBody: c.reqBody?.slice(0, 400),
        respSnip: c.body?.slice(0, 300),
      })),
    };

  } catch(e) {
    err('UP BC: ' + e.message);
    output.uprinting_bc.errors.push(e.message);
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting Flyers — find product_id=5 page and intercept attrs
// ─────────────────────────────────────────────────────────────────────────────
async function captureUprintingFlyers(browser) {
  log('\n═══ UPRINTING FLYERS (product_id=5) ═══');
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const intercepted = [];
  let freshAuth = UP_AUTH;

  ctx.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('digitalroom.com')) return;
    try {
      const body = await resp.text();
      const reqH = resp.request().headers();
      if (reqH['authorization']) freshAuth = reqH['authorization'];
      intercepted.push({ url: u, method: resp.request().method(), status: resp.status(), body, reqBody: await resp.request().postBody().catch(() => null) });
      log(`UP Flyer XHR: ${resp.request().method()} ${u.slice(35)} → ${resp.status()}`);
    } catch (_) {}
  });

  const page = await ctx.newPage();

  // UPrinting flyer product URLs to try
  const flyerUrls = [
    'https://www.uprinting.com/flyers.html',
    'https://www.uprinting.com/flyer-printing.html',
    'https://www.uprinting.com/flyers-printing.html',
    'https://www.uprinting.com/postcards.html',
    'https://www.uprinting.com/postcard-printing.html',
  ];

  try {
    let landedUrl = null;
    let landedProductId = null;

    for (const url of flyerUrls) {
      log(`Trying: ${url}`);
      intercepted.length = 0;
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
      if (!resp || resp.status() >= 400 || page.url().includes('404')) continue;

      await wait(8000);
      log(`Landed: ${page.url()} — ${await page.title()}`);

      // Check product_id from intercepted calls
      const priceCalls = intercepted.filter(c => c.url.includes('computePrice') || c.url.includes('getData'));
      for (const call of priceCalls) {
        try {
          const rb = JSON.parse(call.reqBody || '{}');
          const rsp = JSON.parse(call.body || '{}');
          const pid = rb.product_id || rsp.product_id;
          if (pid) {
            log(`  product_id=${pid} at ${url}`);
            if (pid === '5') { landedUrl = page.url(); landedProductId = pid; break; }
            // If not 5, note it and continue
            output.uprinting_flyers.errors.push({ note: `URL ${url} → product_id=${pid} (not 5)` });
          }
        } catch(_) {}
      }
      if (landedProductId === '5') break;

      // Also try reading from page getData
      const dataCall = intercepted.find(c => c.url.includes('getData'));
      if (dataCall) {
        try {
          const body = JSON.parse(dataCall.body || '{}');
          const pid = body.product_id || body.data?.product_id;
          log(`  getData product_id=${pid} at ${url}`);
        } catch(_) {}
      }
    }

    // If we never got product_id=5, search nav for a flyer link
    if (!landedProductId) {
      log('No product_id=5 found — crawling nav for flyers link');
      await page.goto('https://www.uprinting.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await wait(3000);
      const navLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('nav a, header a, .menu a'))
          .map(a => ({ text: a.textContent?.trim(), href: a.href }))
          .filter(a => /flyer|postcard/i.test(a.text + a.href))
          .slice(0, 10)
      );
      log(`Nav links: ${JSON.stringify(navLinks)}`);

      for (const link of navLinks) {
        if (!link.href) continue;
        intercepted.length = 0;
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
        await wait(8000);
        const priceCalls = intercepted.filter(c => c.url.includes('computePrice'));
        for (const call of priceCalls) {
          try {
            const rb = JSON.parse(call.reqBody || '{}');
            const pid = rb.product_id;
            log(`  nav link ${link.href} → product_id=${pid}`);
            if (pid === '5') { landedUrl = page.url(); landedProductId = '5'; break; }
          } catch(_) {}
        }
        if (landedProductId === '5') break;
      }
    }

    output.uprinting_flyers.url_discovered = landedUrl;

    // If we found product_id=5, now get targeted pricing
    const priceCalls = intercepted.filter(c => c.url.includes('computePrice') && c.method === 'POST');
    log(`\ncomputePrice calls for flyers: ${priceCalls.length}`);

    let baseAttrs = null;
    if (priceCalls.length > 0) {
      try {
        const rb = JSON.parse(priceCalls[0].reqBody || '{}');
        const rsp = JSON.parse(priceCalls[0].body || '{}');
        log(`Default flyer body: ${JSON.stringify(rb)}`);
        log(`Default flyer price: $${rsp.total_price} (product_id=${rsp.product_id})`);
        log(`Order specs: ${JSON.stringify(rsp.order_specs?.map(s => ({ attr: s.attribute_name, val: s.order_spec_value })))}`);
        baseAttrs = rb;
        output.uprinting_flyers.attr_ids = { raw: rb, source: 'page_intercept', productId: rsp.product_id };
      } catch(e) { log(`Parse error: ${e.message}`); }
    }

    // Iterate qtys to capture pricing
    const targetQtys = [500, 1000, 2500];
    for (const qty of targetQtys) {
      const beforeCount = intercepted.filter(c => c.url.includes('computePrice')).length;

      const clicked = await page.evaluate(q => {
        const all = document.querySelectorAll('a, button, li, td, [class*="grid"], [class*="qty"]');
        for (const el of all) {
          const t = el.textContent?.trim().replace(/,/g, '');
          if (t === String(q)) { el.click(); return { found: true, tag: el.tagName }; }
        }
        for (const sel of document.querySelectorAll('select')) {
          const opt = Array.from(sel.options).find(o => o.text?.trim().replace(/,/g, '') === String(q) || o.value === String(q));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, tag: 'SELECT', name: sel.name };
          }
        }
        return { found: false };
      }, qty);

      log(`Qty ${qty} click: ${JSON.stringify(clicked)}`);
      await wait(3000);

      const afterCalls = intercepted.filter(c => c.url.includes('computePrice'));
      const newCall = afterCalls[afterCalls.length - 1];
      if (afterCalls.length > beforeCount && newCall) {
        try {
          const rb = JSON.parse(newCall.reqBody || '{}');
          const rsp = JSON.parse(newCall.body || '{}');
          const price = rsp.total_price;
          log(`  qty=${qty}: $${price}`);
          if (price) {
            output.uprinting_flyers.prices.push({
              competitor: 'UPrinting',
              product_type: 'flyers_postcards',
              spec: { qty, size: '4"×6"', paper: '14pt Gloss', sides: '4/4' },
              total_price: parseFloat(price),
              unit_price: parseFloat(rsp.unit_price || (price / qty)),
              turnaround: rsp.turnaround,
              attr_body: rb,
              captured_at: new Date().toISOString(),
            });
          }
        } catch(e) { log(`  Parse error: ${e.message}`); }
      } else {
        log(`  No new call for qty=${qty}`);
      }
    }

    // Store all intercepted data for analysis
    output.uprinting_flyers.all_intercepted = intercepted.map(c => ({
      url: c.url.slice(35),
      status: c.status,
      reqBody: c.reqBody?.slice(0, 400),
      respSnip: c.body?.slice(0, 300),
    }));

  } catch(e) {
    err('UP Flyers: ' + e.message);
    output.uprinting_flyers.errors.push(e.message);
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Axiom Flyers — find correct product URL via nav then interact
// ─────────────────────────────────────────────────────────────────────────────
async function captureAxiomFlyers(browser) {
  log('\n═══ AXIOM PRINT FLYERS ═══');
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const apiCalls = [];
  ctx.on('response', async resp => {
    const u = resp.url();
    if (u.includes('axiomprint.com') && (u.includes('price') || u.includes('quote') || u.includes('product') || u.includes('api'))) {
      try {
        const body = await resp.text();
        apiCalls.push({ url: u, status: resp.status(), body });
        log(`Axiom XHR: ${resp.status()} ${u.slice(0, 90)}`);
      } catch(_) {}
    }
  });

  const page = await ctx.newPage();
  try {
    // Step 1: Crawl Axiom nav to find flyer product URL
    log('Crawling Axiom nav for flyer product URL...');
    await page.goto('https://axiomprint.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wait(4000);

    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map(a => ({ text: a.textContent?.trim().slice(0, 60), href: a.href }))
        .filter(a => a.href && a.href.includes('axiomprint.com') &&
          /flyer|postcard|brochure/i.test(a.text + a.href))
        .slice(0, 15)
    );
    log(`Axiom flyer nav links: ${JSON.stringify(allLinks)}`);
    output.axiom_flyers.nav_links = allLinks;

    // Try the known slug first, then each nav link
    const flyerCandidates = [
      'https://axiomprint.com/product/flyers-printing-102',
      ...allLinks.map(l => l.href),
    ];

    let bestUrl = null;
    let bestTitle = null;
    let foundAntSelects = false;

    for (const url of flyerCandidates) {
      if (!url || !url.includes('axiomprint.com')) continue;
      log(`\nTrying Axiom URL: ${url}`);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await wait(5000);

      if (!resp || resp.status() >= 400) { log('  Failed / 404'); continue; }
      const currentUrl = page.url();
      if (currentUrl.includes('404') || currentUrl === 'https://axiomprint.com/') { log('  Redirected to home/404'); continue; }

      const pageState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        antSelectCount: document.querySelectorAll('.ant-select').length,
        antSelectValues: Array.from(document.querySelectorAll('.ant-select-selection-item'))
          .map(el => el.textContent?.trim()).slice(0, 10),
        priceText: Array.from(document.querySelectorAll('[class*="price"], [class*="Price"], [class*="total"], [class*="amount"]'))
          .map(el => el.textContent?.trim()).filter(t => /\$\d/.test(t)).slice(0, 5),
        nextDataSnip: JSON.stringify(window.__NEXT_DATA__ || {}).slice(0, 500),
      }));

      log(`  Title: ${pageState.title}`);
      log(`  Ant selects: ${pageState.antSelectCount}, values: ${JSON.stringify(pageState.antSelectValues)}`);
      log(`  Prices: ${JSON.stringify(pageState.priceText)}`);

      if (pageState.antSelectCount > 0) {
        bestUrl = currentUrl;
        bestTitle = pageState.title;
        foundAntSelects = true;
        output.axiom_flyers.url_found = currentUrl;
        output.axiom_flyers.page_state = pageState;
        break;
      }

      // Check if there's a price even without Ant selects
      if (pageState.priceText.length > 0 && !bestUrl) {
        bestUrl = currentUrl;
        bestTitle = pageState.title;
        output.axiom_flyers.url_found = currentUrl;
        output.axiom_flyers.page_state = pageState;
      }
    }

    if (!bestUrl) {
      log('No valid Axiom flyer URL found — recording failure');
      output.axiom_flyers.errors.push('No valid product page with Ant Design selects found from nav crawl');
      return;
    }

    log(`\nUsing Axiom flyer URL: ${bestUrl}`);
    if (!foundAntSelects) {
      log('WARNING: No Ant Design selects found — page may not have loaded correctly');
    }

    // Step 2: Navigate qty options for 500, 1000, 2500
    const targetQtys = [500, 1000, 2500];

    for (const qty of targetQtys) {
      try {
        // Open the qty Ant Design dropdown
        const qtyDropdown = await page.$('.ant-select-selector');
        if (!qtyDropdown) { log(`  No qty dropdown for qty=${qty}`); continue; }

        await qtyDropdown.click({ force: true });
        await wait(800);

        // Find and click the option
        const option = await page.$(`li[title="${qty}"], .ant-select-item-option[title="${qty}"], .ant-select-item:has-text("${qty}"), li:has-text("${qty}")`);
        if (option) {
          await option.click({ force: true });
          await wait(2000);

          const price = await page.evaluate(() => {
            // Target the specific price elements we saw in phase 2
            const els = [
              document.querySelector('[class*="finalPrice"]'),
              document.querySelector('[class*="totalBlock"]'),
              document.querySelector('[class*="priceContainer"]'),
            ];
            for (const el of els) {
              if (!el) continue;
              const m = el.textContent?.match(/\$?([\d,]+\.?\d{2})/);
              if (m) return parseFloat(m[1].replace(',', ''));
            }
            // Fallback: find any price element
            const allPrices = document.querySelectorAll('[class*="price"], [class*="Price"], [class*="total"], [class*="amount"]');
            for (const el of allPrices) {
              const m = el.textContent?.match(/\$?([\d,]+\.\d{2})/);
              if (m) return parseFloat(m[1].replace(',', ''));
            }
            return null;
          });

          log(`  Axiom Flyer qty=${qty}: $${price}`);
          if (price) {
            output.axiom_flyers.prices.push({
              competitor: 'Axiom Print',
              product_type: 'flyers_postcards',
              spec: { qty, size: '4"×6"', paper: '14pt Gloss', sides: '4/4' },
              total_price: price,
              unit_price: +(price / qty).toFixed(5),
              url: bestUrl,
              captured_at: new Date().toISOString(),
            });
          }
        } else {
          log(`  Option ${qty} not found in dropdown`);
          // Try listing available options
          const options = await page.$$eval('.ant-select-item, .ant-select-item-option', els =>
            els.map(e => e.textContent?.trim()).slice(0, 15));
          log(`  Available options: ${JSON.stringify(options)}`);
          if (options.length > 0) output.axiom_flyers.available_qty_options = options;

          // Close dropdown
          await page.keyboard.press('Escape');
          await wait(300);
        }
      } catch(e) {
        log(`  Error at qty=${qty}: ${e.message}`);
      }
    }

    // If qty interaction failed, capture default state price at least
    if (output.axiom_flyers.prices.length === 0) {
      const defaultPrice = await page.evaluate(() => {
        const el = document.querySelector('[class*="finalPrice"], [class*="totalBlock"]');
        if (!el) return null;
        const m = el.textContent?.match(/\$?([\d,]+\.\d{2})/);
        return m ? parseFloat(m[1].replace(',', '')) : null;
      });
      const defaultQty = await page.evaluate(() => {
        const el = document.querySelector('.ant-select-selection-item');
        return el?.textContent?.trim();
      });
      log(`Axiom Flyer default price: $${defaultPrice} (qty=${defaultQty})`);
      if (defaultPrice) {
        output.axiom_flyers.prices.push({
          competitor: 'Axiom Print',
          product_type: 'flyers_postcards',
          spec: { qty: defaultQty || 'default', size: '4"×6"', note: 'default page state' },
          total_price: defaultPrice,
          url: bestUrl,
          captured_at: new Date().toISOString(),
        });
      }
    }

    output.axiom_flyers.api_calls = apiCalls.map(c => ({ url: c.url, status: c.status, body: c.body?.slice(0, 200) }));

  } catch(e) {
    err('Axiom Flyers: ' + e.message);
    output.axiom_flyers.errors.push(e.message);
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update normalized JSON with confirmed prices
// ─────────────────────────────────────────────────────────────────────────────
function updateNorm() {
  let norm;
  try { norm = JSON.parse(fs.readFileSync(NORM, 'utf8')); }
  catch(_) { norm = { queries: [], last_capture_date: null }; }

  let added = 0;
  const allPrices = [
    ...output.uprinting_bc.prices,
    ...output.uprinting_flyers.prices,
    ...output.axiom_flyers.prices,
  ];

  for (const r of allPrices) {
    const qty = typeof r.spec?.qty === 'number' ? r.spec.qty : null;
    if (!qty || !r.total_price) continue;

    const qid = `${r.product_type}-${r.competitor.toLowerCase().replace(/\s+/g, '-')}-${qty}`;
    const result = {
      competitor: r.competitor,
      product_type: r.product_type,
      status: 'live',
      total_price: r.total_price,
      unit_price: r.unit_price || +(r.total_price / qty).toFixed(5),
      quantity: qty,
      spec: r.spec,
      captured_at: r.captured_at || new Date().toISOString(),
      source: 'playwright_pul305',
    };

    const existing = norm.queries?.find(q => q.query_id === qid);
    if (existing) {
      existing.competitor_results = existing.competitor_results || [];
      if (!existing.competitor_results.find(cr => cr.competitor === r.competitor)) {
        existing.competitor_results.push(result);
        added++;
      } else {
        // Update existing
        const idx = existing.competitor_results.findIndex(cr => cr.competitor === r.competitor);
        existing.competitor_results[idx] = result;
        added++;
      }
    } else {
      norm.queries = norm.queries || [];
      norm.queries.push({ query_id: qid, product_type: r.product_type, competitor_results: [result] });
      added++;
    }
  }

  norm.last_capture_date = `${TODAY} · PUL-305 UP-BC/Flyers + Axiom-Flyers`;
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-305 Capture: UPrinting BC/Flyers + Axiom Flyers ===');
  log(`Date: ${new Date().toISOString()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    await captureUprintingBC(browser);
    await captureUprintingFlyers(browser);
    await captureAxiomFlyers(browser);
  } finally {
    await browser.close();
  }

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  log(`\nRaw output: ${OUT}`);

  const added = updateNorm();

  log('\n═══ SUMMARY ═══');
  log(`UPrinting BC prices:     ${output.uprinting_bc.prices.length}`);
  log(`UPrinting Flyer prices:  ${output.uprinting_flyers.prices.length}`);
  log(`Axiom Flyer prices:      ${output.axiom_flyers.prices.length}`);
  log(`Axiom Flyer URL found:   ${output.axiom_flyers.url_found || 'NOT FOUND'}`);
  log(`Normalized JSON: +${added} price points`);

  output.uprinting_bc.prices.forEach(r => log(`  BC  ${r.competitor} qty=${r.spec.qty}: $${r.total_price}`));
  output.uprinting_flyers.prices.forEach(r => log(`  FLY ${r.competitor} qty=${r.spec.qty}: $${r.total_price}`));
  output.axiom_flyers.prices.forEach(r => log(`  AXM ${r.competitor} qty=${r.spec.qty}: $${r.total_price}`));
}

main().catch(e => { err('Fatal: ' + e.message); console.error(e); process.exit(1); });
