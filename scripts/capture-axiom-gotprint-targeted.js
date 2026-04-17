#!/usr/bin/env node
/**
 * capture-axiom-gotprint-targeted.js
 * PRI-7 — Targeted capture:
 *   1. Axiom Print: inspect custom dropdown structure + click through multiple qtys
 *   2. GotPrint: exploit REST API (/service/rest/v1/) for pricing
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SS = path.join(ROOT_DIR, 'data', 'screenshots');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-axiom-gp-targeted-${nowISO()}.json`);

function log(msg) { console.log(`[tgt] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── AXIOM PRINT ─────────────────────────────────────────────────────────────
async function captureAxiom(context) {
  log('=== Axiom Print targeted capture ===');
  const page = await context.newPage();
  const results = { prices: [], structure: null, error: null };
  const apiCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('axiomprint.com') || u.includes('axiom')) && resp.status() < 500) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          if (body) apiCalls.push({ url: u.replace('https://www.axiomprint.com', ''), body });
        }
      } catch(_) {}
    }
  });

  try {
    await page.goto('https://www.axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);

    // Deep inspect the configurator DOM structure
    const domInfo = await page.evaluate(() => {
      // Look for any element with price in DOM
      const priceEls = Array.from(document.querySelectorAll('*')).filter(el => {
        if (el.children.length > 0) return false;
        const t = el.textContent.trim();
        return /\$[\d,]+\.\d{2}/.test(t);
      }).map(el => ({
        tag: el.tagName,
        cls: el.className.slice(0, 60),
        id: el.id,
        text: el.textContent.trim()
      })).slice(0, 10);

      // Look for custom dropdown elements (React custom selects)
      const dropdownCandidates = Array.from(document.querySelectorAll(
        '[class*="dropdown"], [class*="select"], [class*="option"], [class*="picker"], ' +
        '[class*="Dropdown"], [class*="Select"], [class*="Option"]'
      )).filter(el => el.offsetWidth || el.offsetHeight).map(el => ({
        tag: el.tagName,
        cls: el.className.slice(0, 80),
        id: el.id,
        text: el.textContent.trim().slice(0, 60),
        children: el.children.length
      })).slice(0, 20);

      // Look for buttons/clickable items that might be size/qty selectors
      const clickables = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="listbox"]')).filter(el => {
        const t = el.textContent.trim();
        return /\d.*x.*\d|qty|quantity|\d+"/i.test(t) && (el.offsetWidth || el.offsetHeight);
      }).map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        cls: el.className.slice(0, 60),
        text: el.textContent.trim().slice(0, 40)
      })).slice(0, 20);

      // Check for any React app root
      const reactRoot = document.querySelector('#root, #app, [data-reactroot]');

      return { priceEls, dropdownCandidates, clickables, hasReact: !!reactRoot };
    });

    log('DOM info: ' + JSON.stringify(domInfo).slice(0, 1000));
    await page.screenshot({ path: path.join(SS, 'axiom-targeted-01.png') });

    // Try to find the configurator widget more precisely
    const configuratorInfo = await page.evaluate(() => {
      // Axiom uses woocommerce or custom PHP — look for typical patterns
      // Check for woocommerce variations
      const varForms = document.querySelectorAll('.variations, .woocommerce-variation, form.cart');
      if (varForms.length > 0) {
        return {
          type: 'woocommerce',
          forms: Array.from(varForms).map(f => ({
            tag: f.tagName,
            cls: f.className,
            html: f.innerHTML.slice(0, 500)
          }))
        };
      }

      // Look for table-based configurator (common in print shops)
      const tables = document.querySelectorAll('table');
      const tableInfo = Array.from(tables).map(t => ({
        rows: t.rows.length,
        html: t.innerHTML.slice(0, 300)
      })).filter(t => t.rows > 1).slice(0, 3);

      // Look for any div with class containing 'config' or 'option'
      const configDivs = Array.from(document.querySelectorAll('[class*="config"], [class*="option-group"], [class*="product-option"]'))
        .filter(el => el.offsetWidth).map(el => ({
          cls: el.className.slice(0, 60),
          html: el.innerHTML.slice(0, 200)
        })).slice(0, 5);

      // Check for any AJAX calls in scripts
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerHTML.slice(0, 500)).filter(s => s.includes('price') || s.includes('ajax')).slice(0, 3);

      return { type: 'custom', tableInfo, configDivs, scripts };
    });

    log('Configurator type: ' + JSON.stringify(configuratorInfo).slice(0, 1000));

    // Get the full page HTML structure around the price element
    const priceArea = await page.evaluate(() => {
      const priceEl = Array.from(document.querySelectorAll('*')).find(el => {
        if (el.children.length > 0) return false;
        return /\$112|\$\d{3}/.test(el.textContent);
      });
      if (!priceEl) return null;
      // Walk up to find the configurator container
      let el = priceEl;
      for (let i = 0; i < 5; i++) {
        el = el.parentElement;
        if (!el) break;
      }
      return el ? el.innerHTML.slice(0, 2000) : null;
    });
    log('Price area HTML: ' + (priceArea || '').slice(0, 500));

    // Try to find and interact with Axiom's form via various selector strategies
    // Strategy 1: Look for <li> elements with size text and click them
    const sizeClicked = await page.evaluate(() => {
      const allLis = Array.from(document.querySelectorAll('li, [data-value]'));
      const sizeItems = allLis.filter(li => {
        const t = li.textContent.trim();
        return /^\d+"?\s*[x×]\s*\d+"?$/.test(t) || /^[\d.]+"\s*x\s*[\d.]+"$/.test(t);
      });
      if (sizeItems.length > 0) {
        const target = sizeItems.find(li => /3.*4|4.*3/i.test(li.textContent));
        if (target) { target.click(); return target.textContent.trim(); }
        return 'found sizes: ' + sizeItems.map(li => li.textContent.trim()).join(', ');
      }
      return null;
    });
    log('Size click attempt: ' + sizeClicked);

    if (sizeClicked && !sizeClicked.startsWith('found')) {
      await sleep(2000);
      // Try to change quantity
      for (const qty of ['500', '1000', '2500']) {
        const qtyClicked = await page.evaluate((targetQty) => {
          const allEls = Array.from(document.querySelectorAll('li, [data-value], button, a'));
          const qtyItem = allEls.find(el => el.textContent.trim() === targetQty);
          if (qtyItem) { qtyItem.click(); return true; }
          return false;
        }, qty);
        await sleep(1500);
        const price = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('*'));
          for (const el of els) {
            if (el.children.length === 0 && /^\$[\d,]+\.\d{2}$/.test(el.textContent.trim())) {
              return el.textContent.trim();
            }
          }
          return null;
        });
        log(`Axiom 3x4 / ${qty}: price=${price} qtyClick=${qtyClicked}`);
        results.prices.push({ size: '3x4', qty: parseInt(qty), price, clicked: qtyClicked });
      }
    }

    // API calls captured
    results.apiCalls = apiCalls.map(c => ({
      url: c.url,
      bodyPreview: JSON.stringify(c.body).slice(0, 300)
    }));
    results.structure = { domInfo, configuratorInfo };

    // Try a direct API call: Axiom WooCommerce variation price
    // WooCommerce stores often have /wp-json/wc/store/v1/ or /?wc-ajax=get_variation
    const wooAttempts = [
      'https://www.axiomprint.com/wp-json/wc/v2/products?category=roll-labels&per_page=5',
      'https://www.axiomprint.com/?wc-ajax=get_variation',
      'https://www.axiomprint.com/wp-json/wc/store/v1/products?slug=roll-labels-335',
      'https://www.axiomprint.com/wp-admin/admin-ajax.php',
    ];

    for (const url of wooAttempts) {
      try {
        const resp = await context.request.get(url, {
          headers: { 'Origin': 'https://www.axiomprint.com' }
        });
        log('Axiom API ' + url.replace('https://www.axiomprint.com', '') + ': ' + resp.status());
        if (resp.status() === 200) {
          const body = await resp.text().catch(() => '');
          results.wooApi = { url, status: 200, preview: body.slice(0, 500) };
        }
      } catch(e) {
        log('Axiom API err: ' + e.message.slice(0, 60));
      }
    }

  } catch(e) {
    err('Axiom: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
  }

  return results;
}

// ─── GOTPRINT REST API ────────────────────────────────────────────────────────
// From page analysis: GP uses /service/rest/v1/ API
// OAuth at /service/rest/v1/oauth/token
// Pricing at /service/rest/v1/users/self/cart/checkout/prices
async function captureGotPrint(context) {
  log('=== GotPrint REST API capture ===');
  const results = { token: null, prices: null, error: null, apiCalls: [] };

  const page = await context.newPage();
  const allNetworkCalls = [];

  page.on('request', async req => {
    if (req.url().includes('gotprint.com/service')) {
      allNetworkCalls.push({
        type: 'request',
        method: req.method(),
        url: req.url().replace('https://www.gotprint.com', ''),
        headers: { ...req.headers() },
        postData: req.postData()?.slice(0, 300)
      });
    }
  });

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com/service')) {
      const ct = resp.headers()['content-type'] || '';
      try {
        const body = ct.includes('json') ? await resp.json().catch(() => null) : null;
        allNetworkCalls.push({
          type: 'response',
          url: u.replace('https://www.gotprint.com', ''),
          status: resp.status(),
          body: body ? JSON.stringify(body).slice(0, 500) : null
        });
        log('GP API: ' + resp.status() + ' ' + u.replace('https://www.gotprint.com', ''));
      } catch(_) {}
    }
  });

  try {
    // Load the order page to see all initial API calls
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    log('GP page loaded: ' + page.url());

    // Get OAuth token first — check if GP makes any auth request on load
    const tokenCalls = allNetworkCalls.filter(c => c.url.includes('oauth') || c.url.includes('token'));
    log('Token-related calls: ' + tokenCalls.length);
    tokenCalls.forEach(c => log('  ' + c.type + ' ' + c.url + ' ' + (c.status || '') + ' | ' + (c.postData || c.body || '').slice(0, 100)));

    // Try to get a client credentials token
    const tokenResp = await page.evaluate(async () => {
      try {
        const r = await fetch('/service/rest/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&client_id=guest&client_secret=guest',
          credentials: 'include'
        });
        const body = await r.text();
        return { status: r.status, body: body.slice(0, 300) };
      } catch(e) { return { error: e.message }; }
    });
    log('Token attempt (guest creds): ' + JSON.stringify(tokenResp));

    // Try anonymous flow
    const anonToken = await page.evaluate(async () => {
      try {
        const r = await fetch('/service/rest/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=password&username=anonymous&password=anonymous',
          credentials: 'include'
        });
        const body = await r.text();
        return { status: r.status, body: body.slice(0, 300) };
      } catch(e) { return { error: e.message }; }
    });
    log('Token attempt (anon): ' + JSON.stringify(anonToken));

    // Get all network calls to understand GP's API
    results.apiCalls = allNetworkCalls.slice(0, 30);

    // Try fetching product config/pricing endpoints directly
    const gpEndpoints = [
      '/service/rest/v1/products/roll-labels',
      '/service/rest/v1/products',
      '/service/rest/v1/catalog/products/roll-labels',
      '/service/rest/v1/catalog/roll-labels/options',
      '/service/rest/v1/pricing/roll-labels',
      '/service/rest/v1/pricing?product=roll-labels&width=3&height=3&qty=5000',
      '/service/rest/v1/price?variantId=32&paperTypeId=12&qty=5000',
      '/service/rest/v1/cart',
      '/service/rest/v2/pricing',
    ];

    const httpResults = {};
    for (const ep of gpEndpoints) {
      try {
        const resp = await context.request.get('https://www.gotprint.com' + ep, {
          headers: {
            'Origin': 'https://www.gotprint.com',
            'Referer': 'https://www.gotprint.com/products/roll-labels/order',
            'Accept': 'application/json',
          }
        });
        if (resp.status() < 404) {
          const body = resp.status() === 200 ? await resp.text().catch(() => '') : '';
          httpResults[ep] = { status: resp.status(), preview: body.slice(0, 200) };
          if (resp.status() === 200) log('GP 200! ' + ep + ' | ' + body.slice(0, 100));
          else log('GP ' + resp.status() + ': ' + ep);
        }
      } catch(e) {
        log('GP err: ' + ep + ' - ' + e.message.slice(0, 50));
      }
    }
    results.httpResults = httpResults;

    // Try to interact with the configurator and capture the actual pricing call
    // Click through: Shape=Square-Rounded, Size=3x3, Material=White BOPP
    // Then look for pricing calls that get fired
    log('Attempting GP configurator interaction...');

    // Check what selects are visible
    const gpSelects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name,
        id: s.id,
        cls: s.className.slice(0, 40),
        opts: Array.from(s.options).map(o => ({ v: o.value, t: o.text })).slice(0, 10),
        visible: !!(s.offsetWidth || s.offsetHeight)
      }));
    });
    log('GP selects: ' + JSON.stringify(gpSelects.filter(s => s.visible)).slice(0, 600));

    // Try to select shape
    if (gpSelects.some(s => s.opts.some(o => /square|circle|oval/i.test(o.t)))) {
      await page.select('select[name="shape"], select[id="shape"]', '32').catch(() => {});
      await sleep(1000);
      log('Tried shape=32 (square-rounded)');
    }

    // Try setting up cart item via API (GP's Vue.js triggers cart API calls on selection)
    const pricingCallMade = allNetworkCalls.filter(c =>
      c.url.includes('price') || c.url.includes('cart') || c.url.includes('checkout')
    );
    log('Pricing-related calls seen: ' + pricingCallMade.length);
    pricingCallMade.forEach(c => log('  ' + JSON.stringify(c).slice(0, 200)));

    results.token = tokenResp;
    results.allNetworkCalls = allNetworkCalls;

  } catch(e) {
    err('GotPrint: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
  }

  return results;
}

async function main() {
  log('=== Axiom + GotPrint Targeted === ' + nowISO());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const output = { run_date: new Date().toISOString(), results: {} };

  try {
    output.results.axiom = await captureAxiom(context);
    output.results.gotprint = await captureGotPrint(context);

    log('\n=== SUMMARY ===');
    log('Axiom prices: ' + (output.results.axiom.prices?.length || 0));
    log('GP network calls: ' + (output.results.gotprint.allNetworkCalls?.length || 0));
    log('GP 200 endpoints: ' + Object.values(output.results.gotprint.httpResults || {}).filter(r => r.status === 200).length);
  } finally {
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('Output: ' + OUT_FILE);
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
