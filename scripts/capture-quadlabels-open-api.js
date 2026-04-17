#!/usr/bin/env node
/**
 * capture-quadlabels-open-api.js
 * PRI-7 — Quadlabels wholesale pricing via open API + configurator interception
 *
 * Approach:
 *   1. Load home/configurator, intercept ALL api.quadlabels.com calls
 *   2. Interact with product type + material + shape + size selectors
 *   3. Find pricing API endpoints from intercepted calls
 *   4. Replay pricing calls for specific specs (White BOPP, 3x3, 5000)
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-quadlabels-${nowISO()}.json`);

function log(msg) { console.log(`[ql] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const QL_ORIGIN = 'https://orders.quadlabels.com';
const QL_API = 'https://api.quadlabels.com';

async function probeOpenEndpoints(context) {
  log('=== Probing open API endpoints ===');
  const headers = { 'Origin': QL_ORIGIN, 'Referer': QL_ORIGIN + '/' };
  const results = {};

  async function get(path, qs = '') {
    const url = QL_API + path + (qs ? '?' + qs : '');
    try {
      const resp = await context.request.get(url, { headers });
      const status = resp.status();
      if (status === 200) {
        try { return { status, body: await resp.json() }; }
        catch(e) { return { status, text: (await resp.text().catch(() => '')).slice(0, 500) }; }
      }
      return { status };
    } catch(e) {
      return { error: e.message };
    }
  }

  // Known working endpoints
  results.config = await get('//open/get-project-configuration');
  log('config: ' + (results.config.status || 'err'));

  // Try product-specific open endpoints
  const productEndpoints = [
    ['//open/product-configurations'],
    ['//open/product-configurator'],
    ['//open/product-configurator', 'productId=15'],
    ['//open/product-configurator', 'typeId=15'],
    ['//open/configurator'],
    ['//open/configurator', 'productId=15'],
    ['//open/products-list'],
    ['//open/product-list'],
    ['//open/product-materials'],
    ['//open/product-materials', 'typeId=15'],
    ['//open/materials'],
    ['//open/materials', 'typeId=15'],
    ['//open/shapes'],
    ['//open/shapes', 'typeId=15'],
    ['//open/shapes', 'productId=15'],
    ['//open/get-price'],
    ['//open/get-price', 'typeId=15&width=3&height=3&qty=5000'],
    ['//open/price'],
    ['//open/price', 'typeId=15&width=3&height=3&qty=5000'],
    ['//open/calculate-price'],
    ['//open/calculate-price', 'typeId=15&width=3&height=3&qty=5000'],
    ['//open/pricing'],
    ['//open/pricing', 'typeId=15&width=3&height=3&qty=5000'],
    ['//open/quote'],
    ['//open/get-quote'],
  ];

  for (const [path, qs = ''] of productEndpoints) {
    const res = await get(path, qs);
    if (res.status === 200) {
      log(`FOUND: ${path}?${qs} -> 200`);
      results[path.slice(7) + (qs ? '?' + qs : '')] = res;
    }
  }

  return results;
}

async function interactWithConfigurator(context) {
  log('=== Interacting with configurator to intercept pricing API calls ===');
  const page = await context.newPage();
  const apiCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('api.quadlabels.com') && resp.status() < 500) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          apiCalls.push({ url: u, status: resp.status(), body });
        } else {
          apiCalls.push({ url: u, status: resp.status(), ct });
        }
      } catch(_) {}
    }
  });

  const result = {
    pagesVisited: [],
    apiCallsCaptured: [],
    configuratorInteracted: false,
    pricingApiFound: false,
    priceData: null,
  };

  try {
    // Start at home page configurator
    await page.goto(QL_ORIGIN + '/home', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    result.pagesVisited.push(page.url());
    log('Home page loaded: ' + page.url());

    // Examine all interactive elements
    const elems = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('select, [role="combobox"], [class*="select"], [class*="dropdown"], [class*="picker"]'));
      return all.map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        cls: el.className.slice(0, 60),
        id: el.id,
        name: el.getAttribute('name'),
        visible: !!(el.offsetWidth || el.offsetHeight),
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({ v: o.value, t: o.text })) : []
      })).filter(e => e.visible);
    });
    log('Interactive elements: ' + JSON.stringify(elems).slice(0, 500));

    // Try to navigate to order page directly
    const orderUrls = [
      QL_ORIGIN + '/order',
      QL_ORIGIN + '/new-order',
      QL_ORIGIN + '/create-order',
      QL_ORIGIN + '/product/15',
      QL_ORIGIN + '/products/15',
      QL_ORIGIN + '/configure',
    ];

    for (const url of orderUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        log('Order URL: ' + url + ' -> ' + resp.status() + ' -> ' + page.url());
        if (resp.status() === 200 && !page.url().includes('/home') && !page.url().includes('/login')) {
          await sleep(3000);
          result.pagesVisited.push(page.url());
          const newCalls = apiCalls.filter(c => !result.apiCallsCaptured.find(e => e.url === c.url));
          log('New API calls after nav: ' + newCalls.map(c => c.url.replace(QL_API, '')).join(', '));
          break;
        }
      } catch(e) {
        log('URL failed: ' + url + ' - ' + e.message);
      }
    }

    // Back to home, try clicking through the configurator widget
    await page.goto(QL_ORIGIN + '/home', { waitUntil: 'networkidle', timeout: 20000 });
    await sleep(2000);

    // Click any button that might trigger configurator
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a[href*="order"]'));
      for (const btn of btns) {
        const txt = btn.textContent.trim();
        if (/get.?started|order.?now|configure|start.?order/i.test(txt) && (btn.offsetWidth || btn.offsetHeight)) {
          btn.click();
          return txt;
        }
      }
      return null;
    });
    log('Clicked button: ' + clicked);
    await sleep(4000);

    result.pagesVisited.push(page.url());
    log('After click URL: ' + page.url());

    // Capture all API calls seen so far
    result.apiCallsCaptured = apiCalls.map(c => ({
      url: c.url.replace(QL_API, ''),
      status: c.status,
      bodyPreview: JSON.stringify(c.body || {}).slice(0, 400)
    }));

    // Check if any pricing endpoints were called
    const pricingCalls = apiCalls.filter(c => /price|quote|calc|cost/i.test(c.url));
    if (pricingCalls.length > 0) {
      result.pricingApiFound = true;
      result.priceData = pricingCalls.map(c => ({ url: c.url, body: c.body }));
      log('PRICING API FOUND: ' + pricingCalls.map(c => c.url).join(', '));
    }

    // If we navigated to a configurator page, look at its structure
    const currentUrl = page.url();
    if (!currentUrl.includes('/home')) {
      const structure = await page.evaluate(() => {
        return {
          title: document.title,
          url: location.href,
          selects: Array.from(document.querySelectorAll('select')).map(s => ({
            name: s.name, id: s.id,
            opts: Array.from(s.options).map(o => o.text).slice(0, 15)
          })),
          inputs: Array.from(document.querySelectorAll('input')).filter(i => i.type !== 'hidden').map(i => ({
            name: i.name, type: i.type, placeholder: i.placeholder, value: i.value
          })).slice(0, 10),
          priceText: Array.from(document.querySelectorAll('[class*="price"], [id*="price"], .total, [class*="total"]'))
            .map(e => e.textContent.trim()).filter(t => /\$/.test(t)).slice(0, 5)
        };
      });
      log('Configurator structure: ' + JSON.stringify(structure).slice(0, 1000));
      result.configuratorInteracted = true;
      result.configuratorStructure = structure;
    }
  } catch(e) {
    err('Configurator: ' + e.message);
    result.error = e.message;
  } finally {
    await page.close();
  }

  return result;
}

async function probeWithLogin(context, email, password) {
  log('=== Attempting wholesale login ===');
  const page = await context.newPage();
  const apiCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('api.quadlabels.com')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          apiCalls.push({ url: u.replace(QL_API, ''), status: resp.status(), body });
        }
      } catch(_) {}
    }
  });

  const result = { loginAttempted: true, loginSucceeded: false, apiCalls: [], error: null };

  try {
    await page.goto(QL_ORIGIN + '/login', { waitUntil: 'networkidle', timeout: 20000 });
    await sleep(2000);
    log('Login page: ' + page.url());

    const loginForm = await page.evaluate(() => ({
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, id: i.id, placeholder: i.placeholder })),
      btns: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim())
    }));
    log('Login form: ' + JSON.stringify(loginForm));

    // Fill email
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="user" i]');
    if (emailInput) {
      await emailInput.fill(email);
      log('Filled email field');
    } else {
      log('No email input found');
    }

    // Fill password
    const passInput = await page.$('input[type="password"]');
    if (passInput) {
      await passInput.fill(password);
      log('Filled password field');
    } else {
      log('No password input found');
    }

    // Submit
    const submitBtn = await page.$('button[type="submit"], button:text("Sign in"), button:text("Login"), button:text("Log in")');
    if (submitBtn) {
      await submitBtn.click();
      await sleep(4000);
      log('Submitted login form. URL: ' + page.url());
    }

    const loginFailed = apiCalls.some(c => c.url.includes('/auth') && c.status >= 400);
    const afterUrl = page.url();
    result.loginSucceeded = !afterUrl.includes('/login') && !loginFailed;
    log('Login succeeded: ' + result.loginSucceeded + ' | URL: ' + afterUrl);

    if (result.loginSucceeded) {
      await sleep(2000);
      // Capture what APIs were called after login
      result.apiCalls = apiCalls;

      // Navigate to order page
      await page.goto(QL_ORIGIN + '/new-order', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      log('After login, order page URL: ' + page.url());
      result.postLoginUrl = page.url();
    }
  } catch(e) {
    err('Login: ' + e.message);
    result.error = e.message;
  } finally {
    await page.close();
  }

  result.apiCalls = apiCalls;
  return result;
}

async function main() {
  log('=== Quadlabels Open API + Login Capture === ' + nowISO());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const output = { run_date: new Date().toISOString(), results: {} };

  try {
    // 1. Probe open endpoints
    output.results.openEndpoints = await probeOpenEndpoints(context);

    // 2. Interact with configurator to catch pricing API
    output.results.configurator = await interactWithConfigurator(context);

    log('\n=== SUMMARY ===');
    const openFound = Object.keys(output.results.openEndpoints).filter(k => output.results.openEndpoints[k].status === 200);
    log('Open endpoints with data: ' + openFound.join(', '));
    log('Pricing API found via configurator: ' + output.results.configurator.pricingApiFound);
    log('API calls captured: ' + output.results.configurator.apiCallsCaptured.length);
    if (output.results.configurator.apiCallsCaptured.length > 0) {
      log('Captured URLs: ' + output.results.configurator.apiCallsCaptured.map(c => c.url).join('\n  '));
    }

  } finally {
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('\nOutput: ' + OUT_FILE);
  return output;
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
