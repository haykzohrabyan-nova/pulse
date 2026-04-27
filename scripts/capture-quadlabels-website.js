#!/usr/bin/env node
/**
 * capture-quadlabels-website.js
 * PUL-263 — QuadLabels wholesale login via quadlabels.com website wholesale toggle
 *
 * Credentials: gary@bazarprinting.com / GRYBZR123
 * Entry: quadlabels.com → wholesale toggle (upper right) → login
 *
 * Goal: capture pricing for benchmark specs (White BOPP labels, various sizes/qtys)
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const nowISO    = () => new Date().toISOString().split('T')[0];
const OUT_FILE  = path.join(ROOT_DIR, 'data', `capture-quadlabels-website-${nowISO()}.json`);

const EMAIL    = process.env.EMAIL    || 'gary@bazarprinting.com';
const PASSWORD = process.env.PASSWORD || 'GRYBZR123';
const UA       = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg) { console.log(`[ql-web] ${msg}`); }
function err(msg) { console.error(`[ERR]    ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Target specs ─────────────────────────────────────────────────────────────
const SPECS = [
  { w: 3, h: 3, qty: 100,   label: '3x3 100' },
  { w: 3, h: 3, qty: 250,   label: '3x3 250' },
  { w: 3, h: 3, qty: 500,   label: '3x3 500' },
  { w: 3, h: 3, qty: 1000,  label: '3x3 1k' },
  { w: 3, h: 3, qty: 2500,  label: '3x3 2.5k' },
  { w: 3, h: 3, qty: 5000,  label: '3x3 5k  ← PRIMARY BENCHMARK' },
  { w: 3, h: 3, qty: 10000, label: '3x3 10k' },
  { w: 2, h: 2, qty: 1000,  label: '2x2 1k' },
  { w: 2, h: 2, qty: 5000,  label: '2x2 5k' },
  { w: 2, h: 4, qty: 1000,  label: '2x4 1k' },
  { w: 2, h: 4, qty: 5000,  label: '2x4 5k' },
];

async function main() {
  log(`=== QuadLabels Website Capture === ${nowISO()}`);
  log(`Credentials: ${EMAIL}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const output = {
    run_date: new Date().toISOString(),
    email: EMAIL,
    site: 'quadlabels.com wholesale toggle',
    loginStatus: null,
    pageStructure: null,
    apiEndpoints: [],
    pricingCalls: [],
    captures: [],
    screenshots: [],
    notes: [],
  };

  const allApiCalls = [];

  // Intercept all network calls
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('quadlabels') || u.includes('quad')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          const entry = { url: u, status: resp.status(), body };
          allApiCalls.push(entry);
          if (/price|calc|quote|cost|rate|estimat/i.test(u)) {
            log(`PRICE CALL: ${u} → ${JSON.stringify(body).slice(0, 200)}`);
            output.pricingCalls.push(entry);
          }
        }
      } catch(_) {}
    }
  });

  const page = await context.newPage();

  try {
    // ── Step 1: Load quadlabels.com home ──────────────────────────────────────
    log('Loading quadlabels.com...');
    await page.goto('https://quadlabels.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    log('Page URL: ' + page.url());
    log('Page title: ' + await page.title());

    // Capture page structure for wholesale toggle discovery
    const homeStructure = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      links: Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().slice(0, 60),
        href: a.href
      })).filter(a => a.text).slice(0, 40),
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim().slice(0, 60)).filter(t => t),
      topNav: Array.from(document.querySelectorAll('header a, nav a, [class*="nav"] a, [class*="header"] a'))
        .map(a => ({ text: a.textContent.trim().slice(0,40), href: a.href })).filter(a => a.text).slice(0, 30),
      wholesaleElements: Array.from(document.querySelectorAll('*')).filter(el => {
        const t = el.textContent.trim().toLowerCase();
        return t.includes('wholesale') && t.length < 100;
      }).map(el => ({
        tag: el.tagName,
        text: el.textContent.trim().slice(0, 80),
        cls: el.className.slice(0, 80),
        href: el.getAttribute && el.getAttribute('href')
      })).slice(0, 20),
    }));

    output.pageStructure = homeStructure;
    log('Home links: ' + homeStructure.links.slice(0,10).map(l => l.text).join(', '));
    log('Wholesale elements found: ' + homeStructure.wholesaleElements.length);
    homeStructure.wholesaleElements.forEach(el => log('  wholesale el: ' + JSON.stringify(el)));

    // Save screenshot
    const ss1 = path.join(ROOT_DIR, 'data', 'ql-home.png');
    await page.screenshot({ path: ss1, fullPage: false });
    output.screenshots.push(ss1);

    // ── Step 2: Find and click wholesale toggle ────────────────────────────────
    log('Looking for wholesale toggle...');

    let wholesaleClicked = false;

    // Strategy 1: Look for element containing "wholesale" text
    const wholesaleEl = await page.$x('//*[contains(translate(text(), "WHOLESALE", "wholesale"), "wholesale")]').catch(() => []);
    if (wholesaleEl && wholesaleEl.length > 0) {
      log('Found wholesale element via XPath');
      try {
        await wholesaleEl[0].click({ force: true });
        wholesaleClicked = true;
        await sleep(2000);
      } catch(e) {
        log('XPath click failed: ' + e.message);
      }
    }

    // Strategy 2: CSS selector scan
    if (!wholesaleClicked) {
      const selectors = [
        'a[href*="wholesale"]',
        'a[href*="trade"]',
        '[class*="wholesale"]',
        '[id*="wholesale"]',
        'button:has-text("Wholesale")',
        'a:has-text("Wholesale")',
        '[class*="toggle"]:has-text("Wholesale")',
      ];
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            log('Found wholesale el via: ' + sel);
            await el.click({ force: true });
            wholesaleClicked = true;
            await sleep(2000);
            break;
          }
        } catch(_) {}
      }
    }

    // Strategy 3: Playwright text selector
    if (!wholesaleClicked) {
      try {
        await page.getByText('Wholesale', { exact: false }).first().click({ timeout: 5000, force: true });
        wholesaleClicked = true;
        await sleep(2000);
        log('Clicked via getByText("Wholesale")');
      } catch(e) {
        log('getByText wholesale failed: ' + e.message);
      }
    }

    output.notes.push(`Wholesale toggle clicked: ${wholesaleClicked}`);
    log('Wholesale toggle clicked: ' + wholesaleClicked);

    const ss2 = path.join(ROOT_DIR, 'data', 'ql-after-toggle.png');
    await page.screenshot({ path: ss2, fullPage: false });
    output.screenshots.push(ss2);

    log('URL after toggle: ' + page.url());

    // ── Step 3: Look for login form ────────────────────────────────────────────
    const loginPage = await page.evaluate(() => ({
      url: location.href,
      hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"]'),
      hasPasswordInput: !!document.querySelector('input[type="password"]'),
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, placeholder: i.placeholder, id: i.id
      })).slice(0, 10),
      formAction: document.querySelector('form')?.action,
    }));
    log('Login page state: ' + JSON.stringify(loginPage));

    // If no login form visible, try navigating to login page
    if (!loginPage.hasEmailInput) {
      log('No login form visible — trying direct login URLs...');

      const loginUrls = [
        'https://quadlabels.com/login',
        'https://quadlabels.com/account/login',
        'https://quadlabels.com/wholesale/login',
        'https://orders.quadlabels.com/login',
        'https://quadlabels.com/signin',
      ];

      for (const url of loginUrls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await sleep(1500);
          const hasForm = await page.evaluate(() =>
            !!(document.querySelector('input[type="email"], input[name="email"]') &&
               document.querySelector('input[type="password"]'))
          );
          if (hasForm) {
            log('Found login form at: ' + url);
            break;
          }
          log('No form at: ' + url);
        } catch(e) {
          log('URL failed: ' + url);
        }
      }
    }

    // ── Step 4: Fill and submit login form ────────────────────────────────────
    const loginFormState = await page.evaluate(() => ({
      url: location.href,
      hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"], input[placeholder*="email" i]'),
      hasPasswordInput: !!document.querySelector('input[type="password"]'),
    }));

    if (loginFormState.hasEmailInput && loginFormState.hasPasswordInput) {
      log('Filling login form...');

      // Fill email
      const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]'];
      for (const sel of emailSelectors) {
        const el = await page.$(sel);
        if (el) { await el.fill(EMAIL); break; }
      }

      // Fill password
      const pwEl = await page.$('input[type="password"]');
      if (pwEl) await pwEl.fill(PASSWORD);

      // Submit
      const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")', 'button:has-text("Sign in")'];
      let submitted = false;
      for (const sel of submitSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          submitted = true;
          break;
        }
      }

      if (!submitted) await page.keyboard.press('Enter');

      await sleep(5000);
      const afterLoginUrl = page.url();
      log('After login URL: ' + afterLoginUrl);

      const isLoggedIn = !afterLoginUrl.includes('/login') && !afterLoginUrl.includes('/signin');
      output.loginStatus = isLoggedIn ? 'SUCCESS' : 'FAILED - still on login page';
      log('Login status: ' + output.loginStatus);

      const ss3 = path.join(ROOT_DIR, 'data', 'ql-after-login.png');
      await page.screenshot({ path: ss3, fullPage: false });
      output.screenshots.push(ss3);

    } else {
      output.loginStatus = 'FAILED - no login form found';
      log('No login form found at ' + page.url());
    }

    // ── Step 5: Explore post-login state ──────────────────────────────────────
    if (output.loginStatus && output.loginStatus.includes('SUCCESS')) {
      log('=== POST-LOGIN EXPLORATION ===');

      const postLoginState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        links: Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim().slice(0, 50),
          href: a.href
        })).filter(a => a.text && a.href).slice(0, 40),
        pricingLinks: Array.from(document.querySelectorAll('a')).filter(a => {
          const t = (a.textContent + a.href).toLowerCase();
          return t.includes('price') || t.includes('product') || t.includes('order') || t.includes('label') || t.includes('catalog');
        }).map(a => ({ text: a.textContent.trim().slice(0,50), href: a.href })).slice(0, 20),
      }));

      log('Post-login links: ' + postLoginState.pricingLinks.map(l => l.text + '→' + l.href).join(', '));
      output.captures.push({ type: 'post_login_state', data: postLoginState });

      // Try to navigate to product ordering/configurator
      const productUrls = [
        'https://quadlabels.com/products',
        'https://quadlabels.com/order',
        'https://quadlabels.com/labels',
        'https://quadlabels.com/catalog',
        'https://orders.quadlabels.com',
        'https://orders.quadlabels.com/new-order',
      ];

      for (const url of productUrls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
          await sleep(2500);

          const state = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            bodyText: document.body.textContent.trim().slice(0, 300),
            hasPricingContent: document.body.textContent.toLowerCase().includes('price') ||
              document.body.textContent.toLowerCase().includes('order'),
            productElements: Array.from(document.querySelectorAll('[class*="product"], [class*="item"], [class*="catalog"]'))
              .map(el => el.textContent.trim().slice(0, 60)).filter(t => t).slice(0, 10),
          }));

          log(`${url}: ${state.title} | hasPricing: ${state.hasPricingContent}`);
          output.captures.push({ url, data: state });

          if (state.hasPricingContent) {
            const ssP = path.join(ROOT_DIR, 'data', `ql-product-${url.split('/').pop() || 'page'}.png`);
            await page.screenshot({ path: ssP, fullPage: false });
            output.screenshots.push(ssP);
            break;
          }
        } catch(e) {
          log('URL failed: ' + url + ' → ' + e.message);
        }
      }
    }

    // ── Step 6: Collect all intercepted API calls ──────────────────────────────
    output.apiEndpoints = allApiCalls.map(c => ({ url: c.url, status: c.status, bodySnippet: JSON.stringify(c.body).slice(0, 200) }));
    log('Total QuadLabels API calls intercepted: ' + allApiCalls.length);
    log('Price calls intercepted: ' + output.pricingCalls.length);

  } catch(e) {
    err('Fatal: ' + e.message);
    output.notes.push('Fatal error: ' + e.message);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('\nOutput saved: ' + OUT_FILE);
  log('Login status: ' + output.loginStatus);
  log('Price calls intercepted: ' + output.pricingCalls.length);
  return output;
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
