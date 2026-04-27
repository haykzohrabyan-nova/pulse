#!/usr/bin/env node
/**
 * capture-quadlabels-v2.js
 * PUL-263 — QuadLabels wholesale login + pricing capture
 *
 * Login: https://orders.quadlabels.com/login
 * Credentials: gary@bazarprinting.com / GRYBZR123
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const nowISO   = () => new Date().toISOString().split('T')[0];
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-quadlabels-v2-${nowISO()}.json`);

const EMAIL    = process.env.EMAIL    || 'gary@bazarprinting.com';
const PASSWORD = process.env.PASSWORD || 'GRYBZR123';
const QL_LOGIN = 'https://orders.quadlabels.com/login';
const UA       = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg) { console.log(`[ql-v2] ${msg}`); }
function err(msg) { console.error(`[ERR]   ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  log(`=== QuadLabels Wholesale Capture v2 === ${nowISO()}`);
  log(`Login URL: ${QL_LOGIN}`);
  log(`Email: ${EMAIL}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const output = {
    run_date: new Date().toISOString(),
    email: EMAIL,
    loginStatus: null,
    loginUrl: QL_LOGIN,
    afterLoginUrl: null,
    pageStructure: [],
    apiCalls: [],
    pricingCalls: [],
    products: [],
    notes: [],
  };

  // Intercept all API calls
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('quadlabels') || u.includes('quad-labels')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          if (body) {
            const entry = { url: u, status: resp.status(), body };
            output.apiCalls.push(entry);
            if (/price|calc|quote|cost|rate|estimat|product|config/i.test(u)) {
              log(`API: ${resp.status()} ${u.replace('https://api.quadlabels.com', '')} → ${JSON.stringify(body).slice(0, 250)}`);
              output.pricingCalls.push(entry);
            }
          }
        }
      } catch(_) {}
    }
  });

  const page = await context.newPage();

  try {
    // ── Step 1: Load login page ───────────────────────────────────────────────
    log(`Navigating to ${QL_LOGIN}...`);
    await page.goto(QL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    const loginState = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasEmail:    !!document.querySelector('input[type="email"], input[name="email"]'),
      hasPassword: !!document.querySelector('input[type="password"]'),
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
      })),
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()),
    }));

    log(`Login page: ${loginState.title} | hasEmail: ${loginState.hasEmail} | hasPassword: ${loginState.hasPassword}`);
    log(`Inputs: ${JSON.stringify(loginState.inputs)}`);
    output.pageStructure.push({ step: 'login_page', data: loginState });

    await page.screenshot({ path: path.join(ROOT_DIR, 'data', 'ql-v2-login.png') });

    if (!loginState.hasEmail || !loginState.hasPassword) {
      output.loginStatus = 'FAILED - no login form found';
      output.notes.push('Login form not found at ' + loginState.url);
      log('No login form — aborting');
      return output;
    }

    // ── Step 2: Fill login form ───────────────────────────────────────────────
    log('Filling login form...');

    // Email
    await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
    await sleep(500);

    // Password
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await sleep(500);

    // Submit
    const submitBtn = await page.$('button[type="submit"]') ||
                      await page.$('input[type="submit"]') ||
                      await page.getByRole('button', { name: /login|sign in/i }).first();

    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await sleep(6000);
    output.afterLoginUrl = page.url();
    log('After login URL: ' + output.afterLoginUrl);

    await page.screenshot({ path: path.join(ROOT_DIR, 'data', 'ql-v2-after-login.png') });

    const loginFailed = output.afterLoginUrl.includes('/login') || output.afterLoginUrl.includes('/signin');
    output.loginStatus = loginFailed ? 'FAILED - still on login page' : 'SUCCESS';
    log('Login status: ' + output.loginStatus);

    // Check for error messages
    const errorText = await page.evaluate(() => {
      const errs = document.querySelectorAll('[class*="error"], [class*="alert"], [class*="message"]');
      return Array.from(errs).map(e => e.textContent.trim()).filter(t => t).slice(0, 5);
    });
    if (errorText.length) {
      log('Error messages: ' + JSON.stringify(errorText));
      output.notes.push('Login errors: ' + JSON.stringify(errorText));
    }

    if (output.loginStatus !== 'SUCCESS') return output;

    // ── Step 3: Explore post-login state ──────────────────────────────────────
    log('=== POST-LOGIN EXPLORATION ===');

    const postLogin = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body.textContent.trim().slice(0, 500),
      links: Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().slice(0, 50), href: a.href,
      })).filter(a => a.text).slice(0, 50),
    }));

    log('Post-login title: ' + postLogin.title);
    log('Post-login URL: ' + postLogin.url);
    output.pageStructure.push({ step: 'post_login', data: postLogin });

    // ── Step 4: Navigate to product catalog / ordering ────────────────────────
    const productUrls = [
      'https://orders.quadlabels.com',
      'https://orders.quadlabels.com/new-order',
      'https://orders.quadlabels.com/order',
      'https://orders.quadlabels.com/products',
      'https://orders.quadlabels.com/catalog',
      'https://orders.quadlabels.com/labels',
    ];

    // Also check for links in post-login page
    const productLinks = postLogin.links.filter(l =>
      /product|order|label|catalog|price|item/i.test(l.href + l.text)
    );
    log('Product links found: ' + productLinks.map(l => l.href).join(', '));
    const productLinkUrls = productLinks.map(l => l.href).filter(u => u.startsWith('http'));

    const allProductUrls = [...new Set([...productLinkUrls, ...productUrls])];

    for (const url of allProductUrls.slice(0, 6)) {
      try {
        log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(3000);

        const state = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          text: document.body.textContent.trim().slice(0, 400),
          selects: Array.from(document.querySelectorAll('select')).map(s => ({
            name: s.name, id: s.id,
            options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 30),
          })),
          priceElements: Array.from(document.querySelectorAll('[class*="price"], [class*="total"], [class*="cost"]'))
            .map(el => el.textContent.trim().slice(0, 60)).filter(t => t).slice(0, 15),
          productCards: Array.from(document.querySelectorAll('[class*="product"], [class*="item"], [class*="card"]'))
            .map(el => el.textContent.trim().slice(0, 80)).filter(t => t).slice(0, 15),
        }));

        log(`${url}: ${state.title}`);
        log(`  selects: ${state.selects.length}, priceEls: ${state.priceElements.length}`);
        output.pageStructure.push({ step: 'product_page', url, data: state });
        output.products.push(state);

        await page.screenshot({ path: path.join(ROOT_DIR, 'data', `ql-v2-${url.split('/').pop() || 'root'}.png`) });

        // If we find selects, try to interact with them
        if (state.selects.length > 0) {
          log('Found selects — attempting to interact and capture prices...');
          for (const sel of state.selects.slice(0, 5)) {
            log(`  select [${sel.name || sel.id}]: ${JSON.stringify(sel.options.map(o => o.t)).slice(0, 200)}`);
          }
          // Try selecting options to trigger price API calls
          for (const sel of state.selects.slice(0, 3)) {
            if (sel.name || sel.id) {
              const selector = sel.name ? `select[name="${sel.name}"]` : `select#${sel.id}`;
              const lastOpt = sel.options[sel.options.length - 1];
              if (lastOpt && lastOpt.v) {
                try {
                  await page.selectOption(selector, lastOpt.v);
                  await sleep(2000);
                  log(`Selected ${lastOpt.t} in ${sel.name || sel.id}`);
                } catch(e) {
                  log(`Select failed: ${e.message}`);
                }
              }
            }
          }

          // Read updated price elements
          const afterSelect = await page.evaluate(() => ({
            priceElements: Array.from(document.querySelectorAll('[class*="price"], [class*="total"], [class*="cost"], [class*="amount"]'))
              .map(el => ({ cls: el.className.slice(0,40), text: el.textContent.trim() })).filter(e => e.text).slice(0, 10),
          }));
          log('Prices after select: ' + JSON.stringify(afterSelect.priceElements));
          output.notes.push({ url, afterSelectPrices: afterSelect.priceElements });
        }

        if (state.priceElements.length > 0 || state.selects.length > 0) break;

      } catch(e) {
        log(`Failed ${url}: ${e.message}`);
      }
    }

    // ── Step 5: Check intercepted API calls ───────────────────────────────────
    log(`\nTotal API calls intercepted: ${output.apiCalls.length}`);
    log(`Price-related calls: ${output.pricingCalls.length}`);
    if (output.pricingCalls.length > 0) {
      log('Price calls:\n' + output.pricingCalls.map(c => `  ${c.url}\n  → ${JSON.stringify(c.body).slice(0, 300)}`).join('\n'));
    }

  } catch(e) {
    err('Fatal: ' + e.message);
    output.notes.push({ fatal: e.message });
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Summary
  log('\n=== SUMMARY ===');
  log('Login status:  ' + output.loginStatus);
  log('API calls:     ' + output.apiCalls.length);
  log('Price calls:   ' + output.pricingCalls.length);

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('Output: ' + OUT_FILE);
  return output;
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
