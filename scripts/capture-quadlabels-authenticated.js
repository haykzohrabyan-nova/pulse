#!/usr/bin/env node
/**
 * capture-quadlabels-authenticated.js
 * PUL-69 — Aggressive Quad Labels pricing capture (post-approval)
 *
 * Run after trade account is approved. Logs in, then systematically
 * captures pricing for all key specs across SYNTHETIC (White BOPP),
 * PAPER, and CLEAR label types.
 *
 * Usage:
 *   node scripts/capture-quadlabels-authenticated.js
 *   EMAIL=info@pixelpressprint.com PASSWORD=Boyd123! node scripts/capture-quadlabels-authenticated.js
 *
 * Output: data/capture-quadlabels-auth-YYYY-MM-DD.json
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-quadlabels-auth-${nowISO()}.json`);

const EMAIL    = process.env.EMAIL    || 'info@pixelpressprint.com';
const PASSWORD = process.env.PASSWORD || 'Boyd123!';

const QL_ORIGIN = 'https://orders.quadlabels.com';
const QL_API    = 'https://api.quadlabels.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg)  { console.log(`[ql-auth] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Target specs to capture (benchmark suite) ────────────────────────────────
// Keyed to match our Delta Nexus benchmark queries

const BENCHMARK_SPECS = [
  // PRIMARY BENCHMARK: 3"×3" White BOPP (SYNTHETIC), 5k — direct comp to UPrinting/GotPrint
  { productTypeId: 15, w: 3, h: 3, qty: 5000,  label: '3x3 SYNTHETIC 5k (PRIMARY BENCHMARK)' },
  { productTypeId: 15, w: 3, h: 3, qty: 1000,  label: '3x3 SYNTHETIC 1k' },
  { productTypeId: 15, w: 3, h: 3, qty: 2500,  label: '3x3 SYNTHETIC 2.5k' },
  { productTypeId: 15, w: 3, h: 3, qty: 10000, label: '3x3 SYNTHETIC 10k' },
  // 2×2 cross-competitor
  { productTypeId: 15, w: 2, h: 2, qty: 1000,  label: '2x2 SYNTHETIC 1k' },
  { productTypeId: 15, w: 2, h: 2, qty: 5000,  label: '2x2 SYNTHETIC 5k' },
  // 2×3
  { productTypeId: 15, w: 2, h: 3, qty: 1000,  label: '2x3 SYNTHETIC 1k' },
  { productTypeId: 15, w: 2, h: 3, qty: 5000,  label: '2x3 SYNTHETIC 5k' },
  // 4×4
  { productTypeId: 15, w: 4, h: 4, qty: 1000,  label: '4x4 SYNTHETIC 1k' },
  { productTypeId: 15, w: 4, h: 4, qty: 5000,  label: '4x4 SYNTHETIC 5k' },
  // 2×4
  { productTypeId: 15, w: 2, h: 4, qty: 1000,  label: '2x4 SYNTHETIC 1k' },
  { productTypeId: 15, w: 2, h: 4, qty: 5000,  label: '2x4 SYNTHETIC 5k' },
  // Small qty tiers — 100/250/500 for 3×3
  { productTypeId: 15, w: 3, h: 3, qty: 100,   label: '3x3 SYNTHETIC 100' },
  { productTypeId: 15, w: 3, h: 3, qty: 250,   label: '3x3 SYNTHETIC 250' },
  { productTypeId: 15, w: 3, h: 3, qty: 500,   label: '3x3 SYNTHETIC 500' },
  // PAPER label equivalents (cheapest substrate)
  { productTypeId: 14, w: 3, h: 3, qty: 5000,  label: '3x3 PAPER 5k' },
  { productTypeId: 14, w: 2, h: 3, qty: 5000,  label: '2x3 PAPER 5k' },
  // CLEAR label
  { productTypeId: 23, w: 3, h: 3, qty: 5000,  label: '3x3 CLEAR 5k' },
  // HOLOGRAPHIC
  { productTypeId: 26, w: 3, h: 3, qty: 5000,  label: '3x3 HOLOGRAPHIC 5k' },
];

// ─── Step 1: Login ────────────────────────────────────────────────────────────

async function login(context) {
  log('=== Login ===');
  const page = await context.newPage();
  const apiCalls = [];

  page.on('response', async resp => {
    if (resp.url().includes('api.quadlabels.com')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          apiCalls.push({ url: resp.url().replace(QL_API, ''), status: resp.status(), body });
        }
      } catch(_) {}
    }
  });

  let authToken = null;

  try {
    await page.goto(QL_ORIGIN + '/login', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    const sub = await page.$('button[type="submit"]');
    if (sub) await sub.click();
    await sleep(5000);

    const afterUrl = page.url();
    log('After login URL: ' + afterUrl);

    const loginCall = apiCalls.find(c => c.url.includes('/login'));
    log('Login API response: ' + JSON.stringify(loginCall?.body).slice(0, 200));

    if (afterUrl.includes('/login')) {
      err('Login failed — account still pending approval or wrong credentials');
      return null;
    }

    log('LOGIN SUCCEEDED');

    // Extract auth token from cookies or localStorage
    const cookies = await context.cookies();
    const tokenCookie = cookies.find(c => /token|auth|jwt|session/i.test(c.name));
    if (tokenCookie) {
      authToken = tokenCookie.value;
      log('Found auth token in cookie: ' + tokenCookie.name);
    }

    // Try localStorage
    const lsToken = await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (/token|auth|jwt/i.test(key)) return { key, value: localStorage.getItem(key) };
      }
      return null;
    });
    if (lsToken) {
      log('Found auth in localStorage: ' + lsToken.key + ' = ' + lsToken.value.slice(0, 50));
      authToken = lsToken.value;
    }

    // Capture what APIs were called after login
    log('Post-login API calls: ' + apiCalls.map(c => c.url + ' ' + c.status).join(', '));

  } catch(e) {
    err('Login error: ' + e.message);
  } finally {
    await page.close();
  }

  return { authToken, apiCalls };
}

// ─── Step 2: Discover authenticated endpoints ─────────────────────────────────

async function discoverAuthEndpoints(context, authToken) {
  log('=== Discovering authenticated price endpoints ===');

  const headers = {
    'Origin': QL_ORIGIN,
    'Referer': QL_ORIGIN + '/',
    'Accept': 'application/json',
    'User-Agent': UA,
  };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

  const candidateEndpoints = [
    ['/customer/price',                  'typeId=15&width=3&height=3&qty=5000'],
    ['/customer/get-price',              'typeId=15&width=3&height=3&qty=5000'],
    ['/customer/calculate-price',        'typeId=15&width=3&height=3&qty=5000'],
    ['/customer/product-price',          'typeId=15&width=3&height=3&qty=5000'],
    ['/customer/products',               ''],
    ['/customer/product-configurator',   'typeId=15'],
    ['/customer/product-configuration',  'typeId=15'],
    ['/customer/product-materials',      'typeId=15'],
    ['/customer/product-finishings',     'typeId=15'],
    ['/customer/product-shapes',         'typeId=15'],
    ['/customer/product-quantities',     'typeId=15'],
    ['/customer/label-types',            ''],
    ['/customer/materials',              'typeId=15'],
    ['/customer/finishings',             'typeId=15'],
    ['/customer/shapes',                 'typeId=15'],
    ['/customer/orders',                 ''],
    ['/customer/profile',                ''],
  ];

  const found = [];
  for (const [ep, qs] of candidateEndpoints) {
    const url = QL_API + ep + (qs ? '?' + qs : '');
    const result = await new Promise(resolve => {
      const req = https.request(url, { method: 'GET', headers }, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
          catch(e) { resolve({ status: res.statusCode, text: b.slice(0, 300) }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.end();
    });

    if (result.status !== 404 && !result.error) {
      log(`${result.status}: ${ep}?${qs} → ${JSON.stringify(result.body || result.text || '').slice(0, 150)}`);
      found.push({ endpoint: ep, qs, status: result.status, body: result.body });
    }
  }

  return found;
}

// ─── Step 3: Intercept pricing API via configurator navigation ────────────────

async function captureViaConfigurator(context) {
  log('=== Capturing pricing via configurator interaction ===');
  const page = await context.newPage();
  const priceCalls = [];
  const allCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('api.quadlabels.com')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          const entry = { url: u.replace(QL_API, ''), status: resp.status(), body };
          allCalls.push(entry);
          if (/price|quote|calc|cost|estimate/i.test(u)) {
            log('PRICE CALL: ' + u.replace(QL_API, '') + ' → ' + JSON.stringify(body).slice(0, 200));
            priceCalls.push(entry);
          }
        }
      } catch(_) {}
    }
  });

  const captures = [];

  try {
    // Navigate to configurator for SYNTHETIC labels
    const configUrls = [
      QL_ORIGIN + '/new-order',
      QL_ORIGIN + '/order',
      QL_ORIGIN + '/create-order',
      QL_ORIGIN + '/order/new',
    ];

    let landed = false;
    for (const url of configUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(3000);
        const cur = page.url();
        if (!cur.includes('/login') && resp.status() < 400) {
          log('Configurator URL: ' + cur);
          landed = true;
          break;
        }
      } catch(e) { log('URL failed: ' + url); }
    }

    if (!landed) {
      err('Could not reach configurator');
      return { captures, allCalls, priceCalls };
    }

    await sleep(3000);

    // Examine page structure
    const structure = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      selects: Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text }))
      })),
      inputs: Array.from(document.querySelectorAll('input:not([type=hidden])')).map(i => ({
        name: i.name, type: i.type, placeholder: i.placeholder, id: i.id
      })).slice(0, 15),
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t).slice(0, 20),
      dropdowns: Array.from(document.querySelectorAll('[class*="select"], [class*="dropdown"], [role="combobox"]'))
        .map(e => ({ cls: e.className.slice(0, 60), role: e.getAttribute('role'), text: e.textContent.trim().slice(0, 50) })).slice(0, 20)
    }));
    log('Configurator structure: ' + JSON.stringify(structure).slice(0, 1000));

    // Try to interact with product type selector for SYNTHETIC (typeId=15)
    // First, look for any visible select or dropdown
    const productSelects = await page.$$('select');
    for (const sel of productSelects) {
      const opts = await sel.evaluate(s => Array.from(s.options).map(o => ({ v: o.value, t: o.text })));
      log('Select options: ' + JSON.stringify(opts).slice(0, 200));
    }

    // Record any price calls from page load
    log('Price calls from load: ' + priceCalls.length);
    log('All API calls: ' + allCalls.map(c => c.url).join(', '));

    captures.push({
      url: page.url(),
      structure,
      priceCallsOnLoad: priceCalls.map(c => ({ url: c.url, body: c.body }))
    });

  } catch(e) {
    err('Configurator capture: ' + e.message);
  } finally {
    await page.close();
  }

  return { captures, allCalls, priceCalls };
}

// ─── Step 4: Direct API price queries (once endpoint discovered) ──────────────

async function directPriceCapture(authToken, priceEndpoint, specs) {
  log('=== Direct price capture via ' + priceEndpoint + ' ===');
  const results = [];

  const headers = {
    'Origin': QL_ORIGIN,
    'Referer': QL_ORIGIN + '/',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': UA,
  };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

  for (const spec of specs) {
    const params = new URLSearchParams({
      typeId: spec.productTypeId,
      width: spec.w,
      height: spec.h,
      qty: spec.qty,
    });

    const url = QL_API + priceEndpoint + '?' + params;
    const result = await new Promise(resolve => {
      const req = https.request(url, { method: 'GET', headers }, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
          catch(e) { resolve({ status: res.statusCode, text: b.slice(0, 500) }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.end();
    });

    const entry = {
      spec: spec.label,
      params: { typeId: spec.productTypeId, w: spec.w, h: spec.h, qty: spec.qty },
      status: result.status,
      response: result.body || result.text
    };
    results.push(entry);
    log(`${spec.label}: ${result.status} → ${JSON.stringify(result.body || '').slice(0, 150)}`);
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Quad Labels Authenticated Capture === ' + nowISO());
  log(`Email: ${EMAIL}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const output = {
    run_date: new Date().toISOString(),
    email: EMAIL,
    results: {}
  };

  try {
    // 1. Login
    const loginResult = await login(context);
    output.results.login = loginResult;

    if (!loginResult) {
      log('ABORT: Login failed. Run this script again after approval is confirmed.');
      output.results.abortReason = 'Login failed — approval pending or wrong credentials';
      return output;
    }

    const { authToken } = loginResult;

    // 2. Discover authenticated endpoints
    output.results.endpointDiscovery = await discoverAuthEndpoints(context, authToken);

    // 3. Capture via configurator (intercept pricing calls)
    output.results.configuratorCapture = await captureViaConfigurator(context);

    // 4. If a price endpoint was found, run full benchmark suite
    const priceEndpoint = output.results.endpointDiscovery
      .find(e => e.status === 200 && /price|calc|quote/i.test(e.endpoint))
      ?.endpoint;

    if (priceEndpoint) {
      log('Price endpoint found: ' + priceEndpoint + ' — running full benchmark suite');
      output.results.benchmarkCapture = await directPriceCapture(authToken, priceEndpoint, BENCHMARK_SPECS);
    } else {
      log('No direct price endpoint found — see configurator capture for intercepted calls');
    }

    // Summary
    log('\n=== SUMMARY ===');
    log('Login: ' + (loginResult ? 'SUCCESS' : 'FAILED'));
    log('Auth endpoints found: ' + (output.results.endpointDiscovery?.length || 0));
    log('Price calls intercepted: ' + (output.results.configuratorCapture?.priceCalls?.length || 0));

  } finally {
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('\nOutput: ' + OUT_FILE);
  return output;
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
