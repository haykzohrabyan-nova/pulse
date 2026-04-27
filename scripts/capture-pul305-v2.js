#!/usr/bin/env node
/**
 * capture-pul305-v2.js
 * PUL-305 — Direct API approach for UPrinting BC/Flyers + Axiom Flyers URL search
 *
 * UPrinting: headless didn't fire the calculator. Use getData to get attr structure
 * then computePrice with discovered attr IDs directly.
 *
 * Axiom: flyers-printing-102 redirects to home. Search sitemap/product catalog.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT  = path.resolve(__dirname, '..');
const NORM  = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const TODAY = new Date().toISOString().split('T')[0];
const OUT   = path.join(ROOT, 'data', `capture-pul305-v2-${TODAY}.json`);

const log  = m => console.log(`[3v2] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UP_AUTH = 'Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2';

const output = {
  run_date: new Date().toISOString(),
  uprinting_bc:     { getData: null, easyMapping: null, prices: [], attr_discovery: {}, errors: [] },
  uprinting_flyers: { getData: null, easyMapping: null, prices: [], attr_discovery: {}, errors: [] },
  axiom_flyers:     { url_found: null, sitemap_search: null, prices: [], errors: [] },
};

function upHttpPost(path, body, auth) {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'calculator.digitalroom.com', path, method: 'POST',
      headers: {
        'Authorization': auth || UP_AUTH, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Origin': 'https://www.uprinting.com', 'Referer': 'https://www.uprinting.com/', 'User-Agent': UA,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr); req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/html, */*', ...headers },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(d) }); } catch(_) { resolve({ status: res.statusCode, headers: res.headers, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UPrinting — Get product attr structure via getData
// ─────────────────────────────────────────────────────────────────────────────
async function discoverUpAttrs(productId, refUrl) {
  log(`\ngetData/${productId}...`);
  const r = await upHttpPost(`/v1/getData/${productId}`, { publishedVersion: true, disableDataCache: true });
  log(`getData/${productId}: status=${r.status}`);
  if (r.status !== 200) { log(`  FAILED`); return null; }

  const d = r.body;
  log(`  product_id=${d.product_id}, product_code=${d.product_code}, dynamic_size=${d.dynamic_size}`);
  log(`  start_width=${d.start_width}, end_width=${d.end_width}`);
  log(`  attrs=${JSON.stringify(Object.keys(d).filter(k => k.startsWith('attr') || k === 'attributes'))}`);

  // Log full structure
  const attrKeys = Object.keys(d).filter(k => /^attr/.test(k));
  log(`  attr keys: ${attrKeys.join(', ')}`);
  for (const k of attrKeys.slice(0, 10)) {
    log(`  ${k}: ${JSON.stringify(d[k])?.slice(0, 150)}`);
  }

  return d;
}

async function discoverUpEasyMapping(productId) {
  log(`\ngetEasyMapping/${productId}...`);
  const r = await upHttpPost(`/v1/getEasyMapping/${productId}`, { publishedVersion: true, disableDataCache: true });
  log(`getEasyMapping/${productId}: status=${r.status}, entries=${r.body?.data?.length || 0}`);
  if (r.body?.data) {
    for (const e of (r.body.data || []).slice(0, 20)) {
      log(`  attr_id=${e.attribute_id} code=${e.attribute_code} val_id=${e.prod_attr_val_id} val=${e.attr_value} val_code=${e.attr_val_code}`);
    }
  }
  return r.body?.data || [];
}

// Try to get a live computePrice using a Playwright-intercepted page to get the real auth token
// and then iterate through options
async function tryHeadedCapture(browser, productId, pageUrl, targetQtys, output_target) {
  log(`\nHeaded capture attempt: ${pageUrl}`);
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 },
    // Disable webdriver detection
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

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
      if (u.includes('computePrice') || u.includes('getData')) {
        log(`  XHR: ${resp.request().method()} ${u.slice(35)} → ${resp.status()}`);
        if (resp.request().method() === 'POST') {
          const rb = resp.request().postBody().catch(() => null);
          log(`  ReqBody: ${(await rb)?.slice(0, 200)}`);
        }
      }
    } catch(_) {}
  });

  const page = await ctx.newPage();

  // Remove navigator.webdriver
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
    log(`  Loaded: ${page.url()}`);
    await wait(12000); // Long wait for Angular to fully init

    // Check if there are any computePrice calls
    const priceCalls = intercepted.filter(c => c.url.includes('computePrice'));
    log(`  computePrice calls after load: ${priceCalls.length}`);

    if (priceCalls.length > 0) {
      const first = priceCalls[0];
      const rb = JSON.parse(first.reqBody || '{}');
      const rsp = JSON.parse(first.body || '{}');
      log(`  Default price: $${rsp.total_price} for product_id=${rb.product_id}`);
      output_target.attr_discovery.default_call = rb;
      output_target.attr_discovery.default_response = {
        product_id: rsp.product_id,
        total_price: rsp.total_price,
        qty: rsp.qty,
        order_specs: rsp.order_specs,
      };
    }

    // Try to get angular scope data
    const angData = await page.evaluate(() => {
      try {
        // Try multiple selectors for the Angular app root
        const selectors = ['[ng-app]', '[data-ng-app]', '#main-content', '.configurator', '#calc-wrapper', '#product-config'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          if (window.angular) {
            const scope = window.angular.element(el).scope();
            if (scope) return { source: sel, priceData: scope.priceData, product_id: scope.productId || scope.product_id };
          }
        }
        // Try body scope
        if (window.angular) {
          const bodyScope = window.angular.element(document.body).scope();
          if (bodyScope) return { source: 'body', priceData: bodyScope.priceData, product_id: bodyScope.productId };
        }
        return null;
      } catch(e) { return { error: e.message }; }
    });
    log(`  Angular scope: ${JSON.stringify(angData)?.slice(0, 200)}`);

    // Look at page structure
    const structure = await page.evaluate(() => {
      // Is there a price display?
      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [id*="price"], [class*="total"]'))
        .map(e => ({ cls: e.className?.slice(0, 50), text: e.textContent?.trim().slice(0, 60) }))
        .filter(e => /\$/.test(e.text))
        .slice(0, 5);
      // What form elements exist?
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, options: Array.from(s.options).map(o => ({ v: o.value, t: o.text?.trim() })).slice(0, 15),
      }));
      // Any ng-* elements?
      const ngEls = Array.from(document.querySelectorAll('[ng-model], [ng-click], [ng-change]'))
        .map(e => ({ tag: e.tagName, ng: e.getAttribute('ng-model') || e.getAttribute('ng-click'), val: e.value || e.textContent?.slice(0, 30) }))
        .slice(0, 20);
      // Buttons and links with price-related text
      const priceButtons = Array.from(document.querySelectorAll('a, button'))
        .map(e => ({ text: e.textContent?.trim().slice(0, 40), href: e.getAttribute('href')?.slice(0, 60), cls: e.className?.slice(0, 40) }))
        .filter(e => /\$|\d{2,}/.test(e.text))
        .slice(0, 10);
      return { priceEls, selects, ngEls: ngEls.slice(0, 10), priceButtons, bodyText: document.body.innerText?.slice(0, 500) };
    });

    log(`  Price elements: ${JSON.stringify(structure.priceEls)}`);
    log(`  Selects: ${structure.selects.map(s => `${s.name}(${s.options.length})`).join(', ')}`);
    log(`  NG elements: ${structure.ngEls.length}`);
    log(`  Body text snip: ${structure.bodyText?.slice(0, 200)}`);
    output_target.attr_discovery.page_structure = structure;

    // Try scrolling / clicking to trigger calculator
    await page.evaluate(() => window.scrollBy(0, 400));
    await wait(2000);

    // Try clicking any qty-like button
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('a, button, li');
      for (const btn of buttons) {
        const t = btn.textContent?.trim();
        if (/^(250|500|1,000|1000)$/.test(t)) { btn.click(); return t; }
      }
    });
    await wait(3000);

    const afterPriceCalls = intercepted.filter(c => c.url.includes('computePrice'));
    log(`  computePrice calls after interaction: ${afterPriceCalls.length}`);

    return { freshAuth, intercepted, priceCalls: afterPriceCalls };
  } catch(e) {
    log(`  Error: ${e.message}`);
    return { freshAuth, intercepted, priceCalls: [] };
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Try to compute price by probing known attr IDs for BC (product_id=1)
// UPrinting BC uses attr1=paper, attr3=size, attr4=sides, attr5=qty, attr6=turnaround
// We need to find the attr_val_ids for: 3.5x2 size, 4/4, 500/1000 qty
// ─────────────────────────────────────────────────────────────────────────────
async function probeUpBcAttrIds() {
  log('\n=== Probing UPrinting BC attr IDs ===');

  // From getData/1, we know the attribute IDs. Now we need attr_val_ids.
  // Strategy: probe computePrice with candidate val IDs and see which gives a valid response.
  // From roll-labels (product_id=33), we know how the attr system works.
  // For BC (product_id=1), dynamic_size=n means size is a fixed attr value (not custom dimensions).

  // Common BC sizes at UPrinting:
  //   3.5"×2" is the standard — likely attr3 for size
  // Let's try getData for product 1 to see the attribute value list

  const getDataR = await upHttpPost('/v1/getData/1', { publishedVersion: true, disableDataCache: true });
  output.uprinting_bc.getData = getDataR.body;

  if (getDataR.status !== 200) {
    log(`getData/1 failed: ${getDataR.status}`);
    return;
  }

  const d = getDataR.body;
  log(`product_code=${d.product_code}, dynamic_size=${d.dynamic_size}`);

  // Log ALL keys in getData response to understand the structure
  const allKeys = Object.keys(d);
  log(`All keys: ${allKeys.join(', ')}`);

  // Look for attributes array
  if (d.attributes || d.attrs) {
    const attrs = d.attributes || d.attrs;
    log(`attributes type: ${typeof attrs}, length: ${Array.isArray(attrs) ? attrs.length : 'n/a'}`);
    if (Array.isArray(attrs)) {
      for (const attr of attrs.slice(0, 30)) {
        log(`  attr: ${JSON.stringify(attr).slice(0, 200)}`);
      }
    } else {
      log(`attrs snippet: ${JSON.stringify(attrs)?.slice(0, 500)}`);
    }
  }

  // Check if there's an attr_values or product_attributes field
  for (const key of allKeys) {
    const val = d[key];
    if (typeof val === 'object' && val !== null) {
      log(`Key ${key}: ${JSON.stringify(val)?.slice(0, 200)}`);
    }
  }

  // Now get getEasyMapping for product 1 to see ALL available attr values
  const mapR = await upHttpPost('/v1/getEasyMapping/1', { publishedVersion: true, disableDataCache: true });
  output.uprinting_bc.easyMapping = mapR.body?.data;
  log(`\ngetEasyMapping/1: ${mapR.body?.data?.length || 0} entries`);

  if (mapR.body?.data) {
    for (const e of mapR.body.data) {
      log(`  ${JSON.stringify(e)}`);
    }
  }

  // Try getSpecs or similar endpoint
  const specsR = await httpGet('https://www.uprinting.com/settings/product/specifications?productType=1', {
    'Referer': 'https://www.uprinting.com/business-cards.html',
    'Accept': 'application/json',
  });
  log(`\nUP specs endpoint: status=${specsR.status}`);
  if (specsR.status === 200) {
    log(`Specs: ${JSON.stringify(specsR.body)?.slice(0, 500)}`);
    output.uprinting_bc.attr_discovery.specs = specsR.body;
  }

  // Try using the share URL format to extract attr IDs
  // From roll-labels notes: share URL has attr values in query params
  // Let's try the getProductSharingUrl or related endpoint
  const shareR = await httpGet('https://www.uprinting.com/business-cards.html', {
    'Accept': 'text/html',
  });
  if (shareR.status === 200) {
    const html = shareR.body;
    // Look for calc_config or attr values in the HTML source
    const configMatch = html.match(/calc_config[^'"]*['"]([^'"]+)['"]/);
    const attrMatches = html.matchAll(/attr(\d+)['":\s]+['"]([\d]+)['"]/g);
    const attrValMatches = html.matchAll(/data-attr-val-id=['"](\d+)['"]/g);
    const prodAttrValMatches = html.matchAll(/prod_attr_val_id['":\s]+(\d+)/g);

    const attrVals = [];
    for (const m of attrMatches) attrVals.push({ attr: m[1], val: m[2] });
    const attrValIds = [];
    for (const m of attrValMatches) attrValIds.push(m[1]);
    const prodVals = [];
    for (const m of prodAttrValMatches) prodVals.push(m[1]);

    log(`HTML attr vals: ${JSON.stringify(attrVals.slice(0, 20))}`);
    log(`HTML attr-val-ids: ${JSON.stringify(attrValIds.slice(0, 20))}`);
    log(`HTML prod_attr_val_ids: ${JSON.stringify(prodVals.slice(0, 20))}`);

    // Also look for calculator config JSON embedded in page
    const calcConfigMatch = html.match(/var\s+calcConfig\s*=\s*({[^}]+})/);
    const initDataMatch = html.match(/initData['":\s]+({[^}]+})/);
    const productDataMatch = html.match(/"product_id"\s*:\s*"(\d+)"/);

    log(`calcConfig: ${calcConfigMatch?.[1]?.slice(0, 200)}`);
    log(`initData: ${initDataMatch?.[1]?.slice(0, 200)}`);
    log(`product_id in HTML: ${productDataMatch?.[1]}`);

    output.uprinting_bc.attr_discovery.html_attrs = { attrVals, attrValIds: attrValIds.slice(0, 30), prodVals: prodVals.slice(0, 30) };
  }
}

async function probeUpFlyersAttrIds() {
  log('\n=== Probing UPrinting Flyers attr IDs ===');

  // Try multiple possible product codes for flyers
  // product_id 4 = Brochures, 5 = ? Let's try 5 directly
  const productCandidates = [5, 8, 12, 14, 15, 20, 25];

  for (const pid of productCandidates) {
    const r = await upHttpPost(`/v1/getData/${pid}`, { publishedVersion: true, disableDataCache: true });
    if (r.status === 200 && r.body?.product_code) {
      log(`product_id=${pid}: code=${r.body.product_code}, name=${r.body.product_name}, dynamic_size=${r.body.dynamic_size}`);
      if (/flyer|postcard|flat/i.test(r.body.product_name || '') || /flyer/i.test(r.body.product_code || '')) {
        log(`  *** POTENTIAL FLYER PRODUCT: ${r.body.product_name} ***`);
        output.uprinting_flyers.getData = r.body;
        output.uprinting_flyers.attr_discovery.product_id = pid;
      }
    } else {
      log(`product_id=${pid}: status=${r.status}`);
    }
    await wait(200);
  }

  // Also check the flyer-printing page source for product_id reference
  const flyerPageR = await httpGet('https://www.uprinting.com/flyer-printing.html', {
    'Accept': 'text/html',
  });
  if (flyerPageR.status === 200) {
    const html = flyerPageR.body;
    const pidMatch = html.match(/"product_id"\s*:\s*"(\d+)"/);
    const pidMatch2 = html.match(/product_id['":\s]+['"]?(\d+)['"]?/);
    const calcMatch = html.match(/\/v1\/getData\/(\d+)/);
    const dataMatch = html.match(/getEasyMapping\/(\d+)/);
    log(`Flyer page product_id match: ${pidMatch?.[1] || pidMatch2?.[1]}`);
    log(`Flyer page getData ref: ${calcMatch?.[1]}`);
    log(`Flyer page getEasyMapping ref: ${dataMatch?.[1]}`);
    output.uprinting_flyers.attr_discovery.page_refs = { pidMatch: pidMatch?.[1], calcMatch: calcMatch?.[1] };

    // Also look for attr data
    const attrMatches = html.matchAll(/attr(\d+)['":\s]+['"]?([\d]+)['"]?/g);
    const attrVals = [];
    for (const m of attrMatches) attrVals.push({ attr: m[1], val: m[2] });
    log(`Flyer HTML attr refs: ${JSON.stringify(attrVals.slice(0, 15))}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Axiom Flyers — systematic URL search
// ─────────────────────────────────────────────────────────────────────────────
async function findAxiomFlyerUrl(browser) {
  log('\n=== Axiom Flyers URL Search ===');

  // Try to get Axiom sitemap or product catalog
  const sitemapUrls = [
    'https://axiomprint.com/sitemap.xml',
    'https://axiomprint.com/sitemap_index.xml',
    'https://axiomprint.com/robots.txt',
  ];

  for (const url of sitemapUrls) {
    const r = await httpGet(url, { 'Accept': 'text/html,application/xml,text/xml,*/*' });
    log(`${url}: status=${r.status}`);
    if (r.status === 200) {
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      // Extract all product URLs from sitemap
      const productUrls = [...body.matchAll(/axiomprint\.com\/(product|catalog)\/[^\s<"&]+/g)].map(m => m[0]);
      const flyerUrls = productUrls.filter(u => /flyer|postcard|handbill/i.test(u));
      log(`  Flyer-related URLs: ${JSON.stringify(flyerUrls.slice(0, 15))}`);
      if (flyerUrls.length > 0) {
        output.axiom_flyers.sitemap_search = { found: flyerUrls };
      }
      // Also log a broader product list
      const allProductUrls = productUrls.slice(0, 30);
      log(`  All product URLs (sample): ${JSON.stringify(allProductUrls)}`);
      output.axiom_flyers.sitemap_search = { ...(output.axiom_flyers.sitemap_search || {}), allProducts: allProductUrls };
      break;
    }
  }

  // Try the Axiom API/product catalog endpoint
  const catalogCandidates = [
    'https://axiomprint.com/api/products',
    'https://axiomprint.com/api/catalog',
    'https://newapi.axiomprint.com/api/products',
    'https://newapi.axiomprint.com/api/v1/products',
    'https://website.workroomapp.com/api/v1/products?site=axiomprint',
  ];

  for (const url of catalogCandidates) {
    const r = await httpGet(url).catch(() => ({ status: 0, body: null }));
    log(`Catalog ${url}: ${r.status}`);
    if (r.status === 200) {
      log(`  Body: ${JSON.stringify(r.body)?.slice(0, 300)}`);
    }
  }

  // Try known URL patterns for flyers
  const flyerSlugCandidates = [
    'flyers',
    'flyers-printing',
    'flyer-printing',
    'flyers-printing-102',
    'flyers-printing-500',
    'flyers-printing-1000',
    'digital-flyers',
    'digital-flyers-printing',
    'halfsheet-flyers',
    'full-color-flyers',
    'flyers-100',
    'flyers-200',
    'flyers-300',
    'flyers-400',
    'flyers-500',
    'flyers-103',
    'flyers-104',
    'postcards',
    'postcards-printing',
    'postcard-printing',
    'postcard-printing-718',
    'handouts',
    'handbills',
  ];

  log('\nTrying Axiom URL slug candidates...');
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  let foundUrl = null;

  for (const slug of flyerSlugCandidates) {
    const url = `https://axiomprint.com/product/${slug}`;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const currentUrl = page.url();
      const status = resp?.status();

      if (status >= 400 || currentUrl === 'https://axiomprint.com/' || currentUrl.includes('/404')) {
        continue; // Skip failures
      }

      // Check if it's a product page with Ant Design
      const antCount = await page.evaluate(() => document.querySelectorAll('.ant-select').length);
      const title = await page.title();

      log(`  ${slug} → ${currentUrl} | ${title} | ant-selects=${antCount}`);

      if (antCount > 0) {
        foundUrl = currentUrl;
        log(`  *** FOUND VALID PRODUCT PAGE: ${currentUrl} ***`);

        // Get page state
        const pageState = await page.evaluate(() => ({
          title: document.title,
          antSelects: Array.from(document.querySelectorAll('.ant-select-selection-item')).map(e => e.textContent?.trim()),
          price: (() => {
            const el = document.querySelector('[class*="finalPrice"]');
            const m = el?.textContent?.match(/\$?([\d,]+\.\d{2})/);
            return m ? parseFloat(m[1].replace(',', '')) : null;
          })(),
          nextDataSnip: JSON.stringify(window.__NEXT_DATA__ || {}).slice(0, 800),
        }));
        log(`  Title: ${pageState.title}`);
        log(`  Default values: ${JSON.stringify(pageState.antSelects)}`);
        log(`  Default price: $${pageState.price}`);
        output.axiom_flyers.url_found = currentUrl;
        output.axiom_flyers.page_state = pageState;
        break;
      }
    } catch(_) {
      // Skip timeout / navigation errors
    }
    await wait(500);
  }

  // If still not found, try scraping the Axiom product list page
  if (!foundUrl) {
    log('\nTrying Axiom product listing pages...');
    const listingPages = [
      'https://axiomprint.com/products',
      'https://axiomprint.com/catalog',
      'https://axiomprint.com/shop',
      'https://axiomprint.com/all-products',
      'https://axiomprint.com/categories',
    ];

    for (const url of listingPages) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp?.status() >= 400) continue;
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a'))
            .map(a => ({ text: a.textContent?.trim(), href: a.href }))
            .filter(a => /flyer|postcard/i.test(a.text + a.href))
            .slice(0, 20)
        );
        log(`  ${url} flyer links: ${JSON.stringify(links)}`);
        if (links.length > 0) {
          output.axiom_flyers.sitemap_search = { ...(output.axiom_flyers.sitemap_search || {}), listing_links: links };
          break;
        }
      } catch(_) {}
    }
  }

  await page.close();
  await ctx.close();
  return foundUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture Axiom Flyer prices once URL is found
// ─────────────────────────────────────────────────────────────────────────────
async function captureAxiomFlyerPrices(browser, url) {
  log(`\n=== Capturing Axiom Flyer Prices at ${url} ===`);
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await wait(3000);

    // Get all Ant Design selects and their options
    const selectData = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('.ant-select'));
      return selects.map((sel, idx) => ({
        idx,
        value: sel.querySelector('.ant-select-selection-item')?.textContent?.trim(),
        label: (() => {
          // Try to find form label
          let el = sel.closest('.ant-form-item');
          if (!el) el = sel.parentElement;
          return el?.querySelector('.ant-form-item-label label, label')?.textContent?.trim();
        })(),
      }));
    });
    log(`Ant selects: ${JSON.stringify(selectData)}`);

    // Find the quantity select (look for the one showing a number)
    const qtySelectIdx = selectData.findIndex(s =>
      /^\d+$/.test(s.value?.replace(/,/g, '')) ||
      /qty|quantity/i.test(s.label || '')
    );
    log(`Qty select index: ${qtySelectIdx}`);

    if (qtySelectIdx === -1) {
      log('No qty select found');
      output.axiom_flyers.errors.push('No quantity select found on page');
      return;
    }

    // Click the qty select to see available options
    const antSelects = await page.$$('.ant-select-selector');
    if (qtySelectIdx < antSelects.length) {
      await antSelects[qtySelectIdx].click({ force: true });
      await wait(1000);

      const options = await page.$$eval('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item',
        els => els.map(e => e.textContent?.trim()));
      log(`Qty options available: ${JSON.stringify(options)}`);
      output.axiom_flyers.available_qty_options = options;

      await page.keyboard.press('Escape');
      await wait(500);
    }

    // Capture prices for target qtys
    const targetQtys = [500, 1000, 2500];

    for (const qty of targetQtys) {
      try {
        // Click qty dropdown
        if (qtySelectIdx < antSelects.length) {
          await antSelects[qtySelectIdx].click({ force: true });
          await wait(800);

          // Find option matching qty
          const options = await page.$$('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item');
          let clicked = false;
          for (const opt of options) {
            const text = await opt.textContent();
            if (text?.trim().replace(/,/g, '') === String(qty)) {
              await opt.click({ force: true });
              await wait(2500); // Wait for price update
              clicked = true;
              break;
            }
          }

          if (!clicked) {
            log(`  qty=${qty}: option not found in dropdown`);
            await page.keyboard.press('Escape');
            await wait(300);
            continue;
          }

          // Read price
          const price = await page.evaluate(() => {
            const candidates = [
              document.querySelector('[class*="finalPrice"]'),
              document.querySelector('[class*="totalBlock"]'),
              document.querySelector('[class*="ProductInfo_finalPrice"]'),
              document.querySelector('[class*="ProductInfo_totalBlock"]'),
            ];
            for (const el of candidates) {
              if (!el) continue;
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
              url,
              captured_at: new Date().toISOString(),
            });
          }
        }
      } catch(e) {
        log(`  Error at qty=${qty}: ${e.message}`);
      }
    }

  } catch(e) {
    err('Axiom prices: ' + e.message);
    output.axiom_flyers.errors.push(e.message);
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update normalized JSON
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
      competitor: r.competitor, product_type: r.product_type, status: 'live',
      total_price: r.total_price, unit_price: r.unit_price || +(r.total_price / qty).toFixed(5),
      quantity: qty, spec: r.spec, captured_at: r.captured_at || new Date().toISOString(),
      source: 'playwright_pul305v2',
    };

    const existing = norm.queries?.find(q => q.query_id === qid);
    if (existing) {
      const idx = (existing.competitor_results || []).findIndex(cr => cr.competitor === r.competitor);
      if (idx >= 0) { existing.competitor_results[idx] = result; }
      else { (existing.competitor_results = existing.competitor_results || []).push(result); }
      added++;
    } else {
      (norm.queries = norm.queries || []).push({ query_id: qid, product_type: r.product_type, competitor_results: [result] });
      added++;
    }
  }

  norm.last_capture_date = `${TODAY} · PUL-305v2`;
  fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('=== PUL-305 v2 — Direct API + Axiom URL Search ===');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    // UPrinting BC — API probe
    await probeUpBcAttrIds();

    // UPrinting Flyers — API probe
    await probeUpFlyersAttrIds();

    // Try headed capture for UPrinting BC (longer wait, anti-bot bypass)
    const bcCapture = await tryHeadedCapture(browser, 1, 'https://www.uprinting.com/business-cards.html', [250, 500, 1000], output.uprinting_bc);
    log(`BC headed capture: ${bcCapture.priceCalls.length} computePrice calls`);

    // Try headed capture for UPrinting Flyers
    const flyCapture = await tryHeadedCapture(browser, 5, 'https://www.uprinting.com/flyer-printing.html', [500, 1000, 2500], output.uprinting_flyers);
    log(`Flyer headed capture: ${flyCapture.priceCalls.length} computePrice calls`);

    // Axiom Flyers — URL search
    const axiomUrl = await findAxiomFlyerUrl(browser);
    if (axiomUrl) {
      await captureAxiomFlyerPrices(browser, axiomUrl);
    }
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
  log(`Axiom Flyer URL:         ${output.axiom_flyers.url_found || 'NOT FOUND'}`);
  log(`Normalized JSON: +${added} price points`);

  output.uprinting_bc.prices.forEach(r => log(`  BC  ${r.competitor} qty=${r.spec.qty}: $${r.total_price}`));
  output.uprinting_flyers.prices.forEach(r => log(`  FLY ${r.competitor} qty=${r.spec.qty}: $${r.total_price}`));
  output.axiom_flyers.prices.forEach(r => log(`  AXM ${r.competitor} qty=${r.spec.qty}: $${r.total_price}`));
}

main().catch(e => { err('Fatal: ' + e.message); console.error(e); process.exit(1); });
