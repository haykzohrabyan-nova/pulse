#!/usr/bin/env node
/**
 * capture-final-click-gp-vp.js
 *
 * Final human-click pass based on screenshot inspection:
 *
 * GOTPRINT /products/roll-labels/order:
 *   Confirmed configurator: Shape ▾ → Size ▾ → Paper ▾ → Finish ▾ → Subtotal
 *   Click: Shape=Square → Size (pick closest to 3×3) → Paper=White BOPP → Finish=Matte
 *   Read Subtotal and watch XHR for qty-specific price
 *   Also: look for qty selector below the dropdowns
 *
 * VISTAPRINT /labels-stickers/roll-labels:
 *   Custom (Die-Cut) is clickable and is the shape that allows custom dimensions.
 *   But size inputs are BELOW THE FOLD — need to scroll down after clicking.
 *   Fill width=3, height=3, then capture new Cimpress intercept at qty=5000.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR    = path.resolve(__dirname, '..');
const RAW_FILE    = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE   = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');
const SCREENS_DIR = path.join(ROOT_DIR, 'data', 'screenshots');

if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });

function log(msg)  { console.log(`[fin] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ss(page, label) {
  const f = path.join(SCREENS_DIR, `${label}-${Date.now()}.png`);
  try { await page.screenshot({ path: f, fullPage: false }); log(`  ss→ ${path.basename(f)}`); }
  catch (_) {}
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

// ══════════════════════════════════════════════════════════════════════════════
// GOTPRINT
// URL: https://www.gotprint.com/products/roll-labels/order
// Configurator: Vue.js dropdowns - Shape ▾, Size ▾, Paper ▾, Finish ▾
// ══════════════════════════════════════════════════════════════════════════════
async function runGotprint(browser) {
  log('\n══ GOTPRINT: /products/roll-labels/order click-through ══');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const xhrLog = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com/service/rest/v1') && resp.status() < 400) {
      try {
        const body = await resp.text();
        xhrLog.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
      } catch (_) {}
    }
  });

  const result = {
    shapeOptions: [], sizeOptions: [], paperOptions: [], finishOptions: [], qtyOptions: [],
    shapeSelected: null, sizeSelected: null, paperSelected: null, finishSelected: null, qtySelected: null,
    subtotalAfterShape: null, subtotalAfterSize: null, subtotalAfterPaper: null,
    subtotalAfterFinish: null, subtotalFinal: null,
    priceFromAPI: null,
    method: null, notes: []
  };

  const page = await context.newPage();
  try {
    log('GP: loading /products/roll-labels/order ...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(4000);
    await ss(page, 'gp3-01-loaded');
    log(`GP: title="${await page.title()}" url=${page.url()}`);

    if (page.url().includes('home.html')) {
      result.notes.push('REDIRECT to home.html — roll-labels order page unavailable without login?');
      log('GP: BLOCKED — redirected to home.html');
      await page.close(); await context.close();
      return result;
    }

    // ── Dismiss any popups ──
    for (const s of ['button:has-text("Accept")', '#onetrust-accept-btn-handler', 'button:has-text("OK")']) {
      try { const b = await page.$(s); if (b && await b.isVisible()) { await b.click(); await sleep(800); break; } } catch (_) {}
    }

    // ── Helper: read subtotal from DOM ──
    async function readSubtotal() {
      return page.evaluate(() => {
        const texts = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent.trim();
          if (/\$[\d,]+\.\d{2}/.test(t) && t.length < 50) texts.push(t);
        }
        // Also look for subtotal element
        const subEl = document.querySelector('[class*="subtotal"], [class*="total-price"], [class*="cart-price"]');
        if (subEl) texts.unshift(subEl.textContent.trim());
        return texts.slice(0, 5);
      });
    }

    // ── Helper: click a Vue.js select option ──
    async function clickVueSelect(triggerSelector, optionText, fallbackText = null) {
      log(`GP: clicking Vue select (trigger: ${triggerSelector}, option: "${optionText}")...`);
      // Click the trigger to open dropdown
      const trigger = await page.$(triggerSelector);
      if (!trigger) {
        log(`GP: trigger not found: ${triggerSelector}`);
        return false;
      }
      await trigger.click();
      await sleep(1500);
      await ss(page, `gp3-dropdown-open-${optionText.replace(/[^a-z0-9]/gi, '-').slice(0, 20)}`);

      // Look for the option in the opened dropdown
      const optionSelectors = [
        `li:has-text("${optionText}")`,
        `[class*="option"]:has-text("${optionText}")`,
        `[role="option"]:has-text("${optionText}")`,
        `.vs__option:has-text("${optionText}")`,
        `.dropdown-item:has-text("${optionText}")`,
        `div[class*="item"]:has-text("${optionText}")`,
        `span:has-text("${optionText}")`,
      ];
      for (const sel of optionSelectors) {
        try {
          const option = await page.$(sel);
          if (option && await option.isVisible()) {
            await option.click();
            log(`GP: clicked option "${optionText}" via ${sel}`);
            await sleep(2000);
            return true;
          }
        } catch (_) {}
      }

      // Log all visible list items for debugging
      const listItems = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('li, [role="option"], .vs__option').forEach(el => {
          if (el.offsetWidth > 0 && el.textContent.trim()) items.push(el.textContent.trim().slice(0, 80));
        });
        return items.slice(0, 20);
      });
      log(`GP: visible list items: ${JSON.stringify(listItems)}`);

      // Try fallback text if provided
      if (fallbackText) {
        for (const item of listItems) {
          if (item.toLowerCase().includes(fallbackText.toLowerCase())) {
            log(`GP: trying fallback match: "${item}"`);
            try {
              const el = await page.$(`li:has-text("${item}"), [role="option"]:has-text("${item}")`);
              if (el) { await el.click(); await sleep(2000); return true; }
            } catch (_) {}
          }
        }
      }

      // Press Escape to close if nothing worked
      await page.keyboard.press('Escape');
      await sleep(500);
      return false;
    }

    // ── Step 1: Enumerate all dropdown options ──
    // GP configurator has Vue.js-powered dropdowns
    // Find all dropdown triggers
    const dropdownTriggers = await page.$$('select, [class*="vs__search"], [class*="select__input"], [placeholder="Please select an option"]');
    log(`GP: found ${dropdownTriggers.length} dropdown inputs`);

    // Use a more targeted approach: find the trigger by placeholder text
    const dropdowns = await page.$$('[placeholder="Please select an option"], .vs__search, [class*="select-input"]');
    log(`GP: found ${dropdowns.length} "Please select an option" triggers`);

    // Try to open each dropdown and enumerate options
    for (let i = 0; i < Math.min(dropdowns.length, 4); i++) {
      try {
        await dropdowns[i].click();
        await sleep(1200);
        const opts = await page.evaluate(() =>
          [...document.querySelectorAll('li, [role="option"], .vs__option')]
            .filter(el => el.offsetWidth > 0 && el.textContent.trim())
            .map(el => el.textContent.trim())
        );
        log(`GP dropdown ${i} options: ${opts.slice(0, 15).join(' | ')}`);
        if (i === 0) result.shapeOptions = opts;
        else if (i === 1) result.sizeOptions = opts;
        else if (i === 2) result.paperOptions = opts;
        else if (i === 3) result.finishOptions = opts;
        await page.keyboard.press('Escape');
        await sleep(500);
      } catch (_) {}
    }

    // Try native selects as fallback
    const nativeSelects = await page.$$('select');
    for (const sel of nativeSelects) {
      try {
        const visible = await sel.isVisible();
        if (!visible) continue;
        const opts = await sel.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
        log(`GP native select options: ${opts.slice(0, 10).map(o => o.t).join(' | ')}`);
      } catch (_) {}
    }

    // ── Step 2: Click Shape → Square ──
    // The trigger might be a div/span with "Please select an option" text, or a .vs__search input
    const shapeTriggerSelectors = [
      'div.vs__dropdown-toggle:nth-of-type(1)',
      '.vs__search:first-of-type',
      'select:nth-of-type(1)',
      '[id*="shape"]',
      '[name*="shape"]',
      '[aria-label*="shape" i]',
      '[placeholder="Please select an option"]',
    ];

    // Actually try clicking the "Shape" label first to focus its dropdown
    const allLabels = await page.$$('label');
    let shapeDropdownEl = null;
    for (const lbl of allLabels) {
      const t = (await lbl.textContent() || '').trim();
      if (t === 'Shape') {
        log('GP: found "Shape" label');
        // Get the associated control
        const forAttr = await lbl.getAttribute('for');
        if (forAttr) shapeDropdownEl = await page.$(`#${forAttr}`);
        break;
      }
    }

    // If we found the shape dropdown, click it
    if (shapeDropdownEl) {
      await shapeDropdownEl.click();
      await sleep(1500);
    } else {
      // Try clicking on the first visible dropdown container
      const dropContainers = await page.$$('[class*="vs__dropdown"], [class*="select"], select');
      for (const c of dropContainers.slice(0, 3)) {
        const visible = await c.isVisible().catch(() => false);
        if (visible) { await c.click(); await sleep(1500); break; }
      }
    }

    // After opening, read and select Square
    const openDropdownOpts = await page.evaluate(() =>
      [...document.querySelectorAll('li, [role="option"], .vs__option, .vs__dropdown-option')]
        .filter(el => el.offsetWidth > 0 && el.textContent.trim())
        .map(el => el.textContent.trim())
    );
    log(`GP: open dropdown options: ${openDropdownOpts.join(' | ')}`);

    // Look for Square
    const squareOpt = openDropdownOpts.find(t => /^square$/i.test(t) || /square label/i.test(t));
    if (squareOpt) {
      const squareEls = await page.$$(`:text("${squareOpt}")`);
      for (const el of squareEls) {
        const visible = await el.isVisible().catch(() => false);
        if (visible) { await el.click(); log(`GP: selected shape "${squareOpt}"`); result.shapeSelected = squareOpt; await sleep(3000); break; }
      }
    } else {
      // Close dropdown and try a different approach
      await page.keyboard.press('Escape');
      await sleep(500);

      // Use the page.selectOption for native selects
      const nativeSel = await page.$('select');
      if (nativeSel) {
        const opts = await nativeSel.$$eval('option', os => os.map(o => o.textContent.trim()));
        log(`GP: native select opts: ${opts.join(', ')}`);
        const sq = opts.find(o => /square/i.test(o));
        if (sq) { await nativeSel.selectOption({ label: sq }); log(`GP: selected shape "${sq}" (native)`); result.shapeSelected = sq; await sleep(3000); }
      }
    }

    await ss(page, 'gp3-02-after-shape');
    result.subtotalAfterShape = await readSubtotal();
    log(`GP subtotal after shape: ${JSON.stringify(result.subtotalAfterShape)}`);

    // ── Step 3: Click Size → look for 3x3 or closest ──
    await sleep(1000);
    // After shape selection, size dropdown should be enabled
    // Click the second dropdown or the Size label's control
    const sizeLabels = await page.$$('label');
    let sizeTrigger = null;
    for (const lbl of sizeLabels) {
      const t = (await lbl.textContent() || '').trim();
      if (t === 'Size') {
        const forAttr = await lbl.getAttribute('for');
        if (forAttr) sizeTrigger = await page.$(`#${forAttr}`);
        break;
      }
    }

    if (!sizeTrigger) {
      // Find the second enabled dropdown
      const allDropdownContainers = await page.$$('[class*="vs__dropdown-toggle"], select');
      for (const c of allDropdownContainers.slice(1, 3)) {
        const disabled = await c.getAttribute('aria-disabled') || await c.getAttribute('disabled') || '';
        if (!disabled) { sizeTrigger = c; break; }
      }
    }

    if (sizeTrigger) {
      await sizeTrigger.click();
      await sleep(1500);
    } else {
      // Click somewhere on the Size label area
      const sizeContainer = await page.$(':text("Size")');
      if (sizeContainer) { await sizeContainer.click(); await sleep(1500); }
    }

    const sizeDropdownOpts = await page.evaluate(() =>
      [...document.querySelectorAll('li, [role="option"], .vs__option, .vs__dropdown-option')]
        .filter(el => el.offsetWidth > 0 && el.textContent.trim())
        .map(el => el.textContent.trim())
    );
    log(`GP: size dropdown options: ${sizeDropdownOpts.join(' | ')}`);
    result.sizeOptions = sizeDropdownOpts;

    // Find 3x3 or closest
    const sizeTarget = sizeDropdownOpts.find(t => /3.*x.*3|3".*x.*3"|3×3/i.test(t)) ||
                       sizeDropdownOpts.find(t => /3.*x|x.*3/i.test(t)) ||
                       sizeDropdownOpts[0];

    if (sizeTarget) {
      const sizeEls = await page.$$(`li:has-text("${sizeTarget}"), [role="option"]:has-text("${sizeTarget}")`);
      for (const el of sizeEls) {
        const v = await el.isVisible().catch(() => false);
        if (v) { await el.click(); log(`GP: selected size "${sizeTarget}"`); result.sizeSelected = sizeTarget; await sleep(3000); break; }
      }
    }

    await ss(page, 'gp3-03-after-size');
    result.subtotalAfterSize = await readSubtotal();
    log(`GP subtotal after size: ${JSON.stringify(result.subtotalAfterSize)}`);

    // ── Step 4: Paper → White BOPP ──
    await sleep(1000);
    const paperLabel = await page.$('label:has-text("Paper"), :text-is("Paper")');
    if (paperLabel) {
      const forAttr = await paperLabel.getAttribute?.('for') || null;
      const trigger = forAttr ? await page.$(`#${forAttr}`) : null;
      if (trigger) { await trigger.click(); } else { await paperLabel.click(); }
      await sleep(1500);
    } else {
      // Click third dropdown
      const containers = await page.$$('[class*="vs__dropdown-toggle"], select');
      if (containers[2]) { await containers[2].click(); await sleep(1500); }
    }

    const paperOpts = await page.evaluate(() =>
      [...document.querySelectorAll('li, [role="option"], .vs__option, .vs__dropdown-option')]
        .filter(el => el.offsetWidth > 0 && el.textContent.trim())
        .map(el => el.textContent.trim())
    );
    log(`GP: paper options: ${paperOpts.join(' | ')}`);
    result.paperOptions = paperOpts;

    const boppOpt = paperOpts.find(t => /white.*bopp|bopp.*white/i.test(t)) ||
                   paperOpts.find(t => /bopp/i.test(t)) ||
                   paperOpts.find(t => /white.*vinyl/i.test(t)) ||
                   paperOpts[0];

    if (boppOpt) {
      const boppEls = await page.$$(`li:has-text("${boppOpt}"), [role="option"]:has-text("${boppOpt}")`);
      for (const el of boppEls) {
        const v = await el.isVisible().catch(() => false);
        if (v) { await el.click(); log(`GP: selected paper "${boppOpt}"`); result.paperSelected = boppOpt; await sleep(3000); break; }
      }
    }

    await ss(page, 'gp3-04-after-paper');
    result.subtotalAfterPaper = await readSubtotal();
    log(`GP subtotal after paper: ${JSON.stringify(result.subtotalAfterPaper)}`);

    // ── Step 5: Finish → Matte ──
    await sleep(1000);
    const finishLabel = await page.$('label:has-text("Finish"), :text-is("Finish")');
    if (finishLabel) {
      await finishLabel.click(); await sleep(1500);
    } else {
      const containers = await page.$$('[class*="vs__dropdown-toggle"], select');
      if (containers[3]) { await containers[3].click(); await sleep(1500); }
    }

    const finishOpts = await page.evaluate(() =>
      [...document.querySelectorAll('li, [role="option"], .vs__option, .vs__dropdown-option')]
        .filter(el => el.offsetWidth > 0 && el.textContent.trim())
        .map(el => el.textContent.trim())
    );
    log(`GP: finish options: ${finishOpts.join(' | ')}`);
    result.finishOptions = finishOpts;

    const matteOpt = finishOpts.find(t => /matte/i.test(t)) || finishOpts[0];
    if (matteOpt) {
      const matteEls = await page.$$(`li:has-text("${matteOpt}"), [role="option"]:has-text("${matteOpt}")`);
      for (const el of matteEls) {
        const v = await el.isVisible().catch(() => false);
        if (v) { await el.click(); log(`GP: selected finish "${matteOpt}"`); result.finishSelected = matteOpt; await sleep(3000); break; }
      }
    }

    await ss(page, 'gp3-05-after-finish');
    result.subtotalAfterFinish = await readSubtotal();
    log(`GP subtotal after finish: ${JSON.stringify(result.subtotalAfterFinish)}`);

    // ── Step 6: Find quantity selector and pick 5000 ──
    await sleep(1000);
    // Look for a qty selector below the paper/finish dropdowns
    // Could be: select[name*="qty"], input[name*="qty"], [placeholder*="quantity"], a qty table
    const qtyEl = await page.$('select[name*="qty" i], input[name*="qty" i], [placeholder*="qty" i], [placeholder*="quantity" i]');
    if (qtyEl && await qtyEl.isVisible()) {
      const tag = await qtyEl.evaluate(e => e.tagName);
      if (tag === 'SELECT') {
        const opts = await qtyEl.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
        log(`GP: qty select options: ${opts.map(o => o.t).slice(0, 10).join(', ')}`);
        result.qtyOptions = opts.map(o => o.t);
        const q5k = opts.find(o => o.t.includes('5000') || o.t.includes('5,000') || o.v === '5000');
        if (q5k) {
          await qtyEl.selectOption({ value: q5k.v });
          result.qtySelected = q5k.t;
          log(`GP: selected qty "${q5k.t}"`);
          await sleep(3000);
        }
      } else {
        await qtyEl.fill('5000');
        await page.keyboard.press('Tab');
        result.qtySelected = '5000';
        log('GP: filled qty=5000');
        await sleep(2000);
      }
    }

    // Scroll down to look for qty selector
    await page.evaluate(() => window.scrollBy(0, 400));
    await sleep(1000);

    const moreSelects = await page.$$('select');
    for (const sel of moreSelects) {
      const visible = await sel.isVisible().catch(() => false);
      if (!visible) continue;
      const opts = await sel.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      if (opts.length > 1) {
        log(`GP: select with ${opts.length} opts: ${opts.slice(0, 8).map(o => o.t).join(', ')}`);
        result.qtyOptions.push(...opts.map(o => o.t));
        const q5k = opts.find(o => o.t.includes('5000') || o.t.includes('5,000') || o.v === '5000');
        if (q5k) {
          await sel.selectOption({ value: q5k.v });
          result.qtySelected = q5k.t;
          log(`GP: selected qty "${q5k.t}"`);
          await sleep(3000);
        }
      }
    }

    // ── Step 7: Final price read ──
    await sleep(2000);
    await ss(page, 'gp3-06-final');
    result.subtotalFinal = await readSubtotal();
    log(`GP: final subtotal text: ${JSON.stringify(result.subtotalFinal)}`);

    // Parse a price from subtotal
    for (const t of (result.subtotalFinal || [])) {
      const m = t.match(/\$([\d,]+\.\d{2})/);
      if (m) {
        const amount = parseFloat(m[1].replace(/,/g, ''));
        if (amount > 0) { result.priceFromAPI = amount; break; }
      }
    }

    // ── Step 8: Check all XHR calls for pricing data ──
    log(`GP: ${xhrLog.length} XHR API calls captured`);
    for (const xhr of xhrLog) {
      const endpoint = xhr.url.replace('https://www.gotprint.com/service/rest/v1/', '');
      if (/price|product|order|calc/i.test(endpoint)) {
        log(`  ${endpoint}: ${xhr.body.slice(0, 300)}`);
      }
      // Check body for price data
      try {
        const d = JSON.parse(xhr.body);
        const searchPrice = (obj, path = '') => {
          if (typeof obj === 'number' && obj > 10 && obj < 10000) {
            if (/price|total|subtotal|amount|cost/i.test(path)) {
              log(`GP: price field at ${path} = ${obj}`);
              if (!result.priceFromAPI) result.priceFromAPI = obj;
            }
          }
          if (typeof obj === 'object' && obj !== null && path.split('.').length < 5) {
            for (const k of Object.keys(obj)) searchPrice(obj[k], `${path}.${k}`);
          }
        };
        searchPrice(d);
      } catch (_) {}
    }

    // ── Step 9: Try REST API with browser cookies ──
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    log(`GP: browser has ${cookies.length} cookies`);

    // Try pricing endpoint with cookies
    const priceEndpoints = [
      `https://www.gotprint.com/service/rest/v1/products/price?productType=ROLL_LABEL&qty=5000&width=3&height=3&shape=Square&material=WHITE_BOPP`,
      `https://www.gotprint.com/service/rest/v1/pricing?product=roll-labels&qty=5000&width=3&height=3`,
      `https://www.gotprint.com/service/rest/v1/products?type=ROLL_LABEL`,
    ];
    for (const url of priceEndpoints) {
      try {
        const r = await context.request.get(url, {
          headers: { Cookie: cookieHeader, Accept: 'application/json' },
          timeout: 10000
        });
        log(`GP API ${url.replace('https://www.gotprint.com/service/rest/v1/', '')}: ${r.status()}`);
        if (r.status() < 400) {
          const body = await r.text();
          log(`  body: ${body.slice(0, 400)}`);
        }
      } catch (_) {}
    }

  } catch (e) {
    err(`GP: ${e.message}`);
    result.notes.push(`Exception: ${e.message}`);
  } finally {
    await page.close();
    await context.close();
  }

  log(`GP RESULT: shape=${result.shapeSelected} size=${result.sizeSelected} paper=${result.paperSelected} finish=${result.finishSelected} price=$${result.priceFromAPI}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// VISTAPRINT — scroll to size section after Custom Die-Cut click
// ══════════════════════════════════════════════════════════════════════════════
async function runVistaprint(browser) {
  log('\n══ VISTAPRINT: Custom Die-Cut + scroll to size inputs ══');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const cimpressCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('cimpress.io') && u.includes('/prices/')) {
      try {
        const body = await resp.text();
        const params = {};
        new URL(u).searchParams.forEach((v, k) => { params[k] = v; });
        cimpressCalls.push({ url: u, body, params });
        const sels = Object.fromEntries(Object.entries(params).filter(([k]) => k.includes('selection') || k === 'quantities'));
        const prs  = JSON.parse(body).estimatedPrices || {};
        const qtySummary = Object.entries(prs).map(([q, v]) => `${q}=$${v.totalListPrice?.untaxed}`).join(', ');
        log(`VP Cimpress: sels=${JSON.stringify(sels)} prices=${qtySummary}`);
      } catch (_) {}
    }
  });

  const result = { price5000: null, unit5000: null, allPrices: {}, shape: null, widthFilled: null, heightFilled: null, method: null, notes: [] };

  const page = await context.newPage();
  try {
    log('VP: loading roll labels page...');
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(5000);
    await ss(page, 'vp3-01-loaded');

    // Dismiss cookie
    for (const s of ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")', 'button:has-text("Accept")']) {
      try { const b = await page.$(s); if (b && await b.isVisible()) { await b.click(); await sleep(1000); break; } } catch (_) {}
    }

    // ── Step 1: Click "Custom (Die-Cut)" ──
    log('VP: clicking Custom (Die-Cut) shape...');
    const labels = await page.$$('label');
    for (const lbl of labels) {
      const t = (await lbl.textContent() || '').trim();
      if (t === 'Custom (Die-Cut)') {
        await lbl.click({ force: true });
        result.shape = 'Custom (Die-Cut)';
        log('VP: clicked Custom (Die-Cut)');
        await sleep(4000);
        await ss(page, 'vp3-02-custom-shape');
        break;
      }
    }

    // ── Step 2: Scroll down to find Size section ──
    log('VP: scrolling down to find size inputs...');
    for (let scrollY = 300; scrollY <= 1500; scrollY += 200) {
      await page.evaluate(y => window.scrollTo(0, y), scrollY);
      await sleep(600);

      // Check for size inputs
      const numInputs = await page.$$('input[type="number"], input[inputmode="numeric"]');
      const visNums = [];
      for (const inp of numInputs) {
        const v = await inp.isVisible().catch(() => false);
        if (v) {
          const placeholder = await inp.getAttribute('placeholder') || '';
          const ariaLabel   = await inp.getAttribute('aria-label') || '';
          const id          = await inp.getAttribute('id') || '';
          visNums.push({ placeholder, ariaLabel, id, el: inp });
        }
      }
      if (visNums.length > 0) {
        log(`VP: found ${visNums.length} visible number inputs at scrollY=${scrollY}: ${visNums.map(x => `[${x.placeholder}|${x.ariaLabel}|${x.id}]`).join(', ')}`);
        await ss(page, `vp3-03-size-visible-scrollY-${scrollY}`);

        // Fill width and height
        if (visNums.length >= 2) {
          const wInp = visNums.find(i => /width|w$/i.test(i.placeholder + i.ariaLabel + i.id)) || visNums[0];
          const hInp = visNums.find(i => /height|h$/i.test(i.placeholder + i.ariaLabel + i.id)) || visNums[1];

          try {
            await wInp.el.click();
            await page.keyboard.press('Control+a');
            await wInp.el.type('3', { delay: 50 });
            result.widthFilled = 3;
            log(`VP: filled width="${wInp.placeholder}" → 3`);
            await sleep(800);
          } catch (e) { log(`VP: width fill error: ${e.message}`); }

          try {
            await hInp.el.click();
            await page.keyboard.press('Control+a');
            await hInp.el.type('3', { delay: 50 });
            result.heightFilled = 3;
            log(`VP: filled height="${hInp.placeholder}" → 3`);
            await sleep(800);
          } catch (e) { log(`VP: height fill error: ${e.message}`); }

          await page.keyboard.press('Tab');
          await sleep(4000);
          await ss(page, 'vp3-04-dims-filled');
        } else if (visNums.length === 1) {
          await visNums[0].el.click();
          await page.keyboard.press('Control+a');
          await visNums[0].el.type('3', { delay: 50 });
          result.widthFilled = result.heightFilled = 3;
          log(`VP: filled single size input → 3`);
          await page.keyboard.press('Tab');
          await sleep(4000);
        }
        break;
      }

      // Also look for text inputs with size-related labels
      const textInputs = await page.$$('input[type="text"]');
      const visTxt = [];
      for (const inp of textInputs) {
        const v = await inp.isVisible().catch(() => false);
        if (v) {
          const placeholder = await inp.getAttribute('placeholder') || '';
          const ariaLabel   = await inp.getAttribute('aria-label') || '';
          if (/width|height|size|inch|dim/i.test(placeholder + ariaLabel)) {
            visTxt.push({ placeholder, ariaLabel, el: inp });
          }
        }
      }
      if (visTxt.length > 0) {
        log(`VP: found text inputs at scrollY=${scrollY}: ${visTxt.map(x => x.placeholder + '|' + x.ariaLabel).join(', ')}`);
        break;
      }
    }

    // ── Step 3: Look for qty buttons while scrolled ──
    await sleep(1000);
    log('VP: looking for qty selector...');
    const qtyBtns = await page.$$('button, [role="button"]');
    for (const btn of qtyBtns) {
      const t = (await btn.textContent() || '').trim();
      if (t === '5,000' || t === '5000') {
        await btn.click({ force: true });
        log('VP: clicked qty "5,000" button');
        await sleep(3000);
        break;
      }
    }

    // ── Step 4: Read all Cimpress prices captured ──
    await sleep(3000);
    await ss(page, 'vp3-05-final');

    for (const c of cimpressCalls) {
      try {
        const d = JSON.parse(c.body);
        for (const [qty, ep] of Object.entries(d.estimatedPrices || {})) {
          result.allPrices[qty] = ep.totalListPrice?.untaxed;
        }
      } catch (_) {}
    }
    log(`VP: all prices from intercepts: ${JSON.stringify(result.allPrices)}`);

    if (result.allPrices['5000']) {
      result.price5000 = result.allPrices['5000'];
      result.unit5000  = parseFloat((result.price5000 / 5000).toFixed(4));
      result.method = `intercepted_cimpress_${result.widthFilled && result.heightFilled ? 'with_3x3_filled' : 'no_size_filled'}`;
    }

    // ── Step 5: Make direct Cimpress API call ──
    const lastCall = cimpressCalls.slice().reverse()[0];
    if (lastCall && lastCall.params.pricingContext) {
      const p = lastCall.params;
      const selEntries = Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('selections[')));

      // Log the selections
      log(`VP: selections in last call: ${JSON.stringify(selEntries)}`);

      // Add dimensions if we filled them
      if (result.widthFilled && result.heightFilled) {
        selEntries['selections[Width]'] = '3';
        selEntries['selections[Height]'] = '3';
      }

      const qs = new URLSearchParams({
        requestor: 'inspector-gadget-pdp-configurator-fragment',
        productKey: p.productKey || 'PRD-DF5PWTHC',
        quantities: '5000',
        pricingContext: p.pricingContext,
        merchantId: p.merchantId || 'vistaprint',
        market: 'US',
        optionalPriceComponents: 'UnitPrice',
        ...selEntries
      });

      const apiUrl = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?${qs}`;
      log(`VP: Cimpress direct call selections=${JSON.stringify(selEntries)}`);
      try {
        const r = await context.request.get(apiUrl, {
          headers: { Accept: 'application/json', Origin: 'https://www.vistaprint.com' },
          timeout: 12000
        });
        const body = await r.text();
        log(`VP Cimpress direct: status=${r.status()} body=${body.slice(0, 600)}`);
        const d = JSON.parse(body);
        if (d.estimatedPrices?.['5000']) {
          const ep = d.estimatedPrices['5000'];
          result.price5000 = ep.totalListPrice?.untaxed;
          result.unit5000  = ep.unitListPrice?.untaxed;
          result.method = `cimpress_direct_${selEntries['selections[Width]'] ? 'with_3x3' : 'no_size'}`;
          log(`VP: *** PRICE: $${result.price5000} (unit: $${result.unit5000}) ***`);

          // Log the breakdown
          const breakdown = d.estimatedPrices['5000'].breakdown || [];
          log(`VP: price breakdown: ${JSON.stringify(breakdown.map(b => ({ name: b.name, value: b.value, price: b.listPrice?.untaxed })))}`);
        }
      } catch (e) { log(`VP Cimpress direct failed: ${e.message}`); }

      // ── Also try with Rounded Square + Width/Height ──
      if (!result.price5000 || !result.widthFilled) {
        log('VP: trying Rounded Square + explicit Width/Height...');
        const rsEntries = { ...selEntries, 'selections[Shape]': 'Rounded Square', 'selections[Width]': '3', 'selections[Height]': '3' };
        const rsQs = new URLSearchParams({
          requestor: 'inspector-gadget-pdp-configurator-fragment',
          productKey: p.productKey || 'PRD-DF5PWTHC',
          quantities: '5000',
          pricingContext: p.pricingContext,
          merchantId: 'vistaprint',
          market: 'US',
          optionalPriceComponents: 'UnitPrice',
          ...rsEntries
        });
        try {
          const r2 = await context.request.get(
            `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?${rsQs}`,
            { headers: { Accept: 'application/json', Origin: 'https://www.vistaprint.com' }, timeout: 12000 }
          );
          const body = await r2.text();
          log(`VP RS+3x3: status=${r2.status()} body=${body.slice(0, 400)}`);
          const d = JSON.parse(body);
          if (d.estimatedPrices?.['5000']) {
            const ep = d.estimatedPrices['5000'];
            const rsPrice = ep.totalListPrice?.untaxed;
            log(`VP RS+3x3 price: $${rsPrice}`);
            result.notes.push(`Rounded Square + Width=3 Height=3: $${rsPrice}`);
          }
        } catch (_) {}
      }
    }

  } catch (e) {
    err(`VP: ${e.message}`);
    result.notes.push(`Exception: ${e.message}`);
  } finally {
    await page.close();
    await context.close();
  }

  log(`VP RESULT: shape=${result.shape} widthFilled=${result.widthFilled} heightFilled=${result.heightFilled} price5000=$${result.price5000} method=${result.method}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const raw  = readJSON(RAW_FILE);
  const norm = readJSON(NORM_FILE);
  if (!raw || !norm) { err('Cannot load data files'); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const today   = nowISO();

  try {
    // Run GP first since it's more promising, then VP
    const [gpResult, vpResult] = await Promise.all([
      runGotprint(browser).catch(e => ({ error: e.message })),
      runVistaprint(browser).catch(e => ({ error: e.message }))
    ]);

    // ── Update data files ──
    // GP
    const gpEntry = {
      id: `gotprint-configurator-${today}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: today,
      capture_method: 'playwright_vue_dropdown_click',
      capture_source: 'automated_headless',
      confidence: gpResult.priceFromAPI ? 'medium' : 'none',
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels shape=${gpResult.shapeSelected} size=${gpResult.sizeSelected} paper=${gpResult.paperSelected} finish=${gpResult.finishSelected} qty=${gpResult.qtySelected}`,
      specs: {
        shape: gpResult.shapeSelected,
        size: gpResult.sizeSelected,
        material: gpResult.paperSelected,
        finish: gpResult.finishSelected,
        quantity: gpResult.qtySelected ? parseInt(gpResult.qtySelected.replace(/,/g, '')) : null
      },
      pricing: {
        total_price: gpResult.priceFromAPI,
        unit_price: null,
        currency: 'USD',
        turnaround_days: null,
        shipping_included: false,
        price_type: gpResult.method || 'not_captured'
      },
      raw_snippet: `subtotal=${JSON.stringify(gpResult.subtotalFinal)} shapeOpts=${JSON.stringify(gpResult.shapeOptions.slice(0, 5))} sizeOpts=${JSON.stringify(gpResult.sizeOptions.slice(0, 8))} paperOpts=${JSON.stringify(gpResult.paperOptions.slice(0, 5))}`,
      notes: `GP configurator found at /products/roll-labels/order. Shapes: ${gpResult.shapeOptions.join(', ')}. Sizes: ${gpResult.sizeOptions.join(', ')}. Paper: ${gpResult.paperOptions.join(', ')}. Finish: ${gpResult.finishOptions.join(', ')}. ${gpResult.notes.join('; ')}`,
      blocker: gpResult.priceFromAPI ? null : `Price not in DOM after configuration. Shape=${gpResult.shapeSelected} Size=${gpResult.sizeSelected} Paper=${gpResult.paperSelected} Finish=${gpResult.finishSelected} Qty=${gpResult.qtySelected}`,
      next_step: gpResult.priceFromAPI ? null : 'GP configurator requires specific Vue.js interaction not captured by headless. Try a real browser session on /products/roll-labels/order with DevTools open.'
    };

    const vpEntry = {
      id: `vistaprint-custom-diecut-${today}`,
      competitor: 'vistaprint',
      competitor_display: 'Vistaprint',
      source_url: 'https://www.vistaprint.com/labels-stickers/roll-labels',
      captured_at: today,
      capture_method: 'playwright_custom_diecut_scroll_cimpress',
      capture_source: 'automated_headless',
      confidence: vpResult.price5000 ? (vpResult.widthFilled && vpResult.heightFilled ? 'high' : 'medium') : 'none',
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels Custom Die-Cut ${vpResult.widthFilled ? '3×3' : 'size unconfirmed'}, qty=5000`,
      specs: {
        width_in: vpResult.widthFilled || null,
        height_in: vpResult.heightFilled || null,
        shape: vpResult.shape || 'Custom (Die-Cut)',
        format: 'slit_roll',
        quantity: 5000,
        material: null,
        finish: null
      },
      pricing: {
        total_price: vpResult.price5000,
        unit_price: vpResult.unit5000,
        currency: 'USD',
        turnaround_days: null,
        shipping_included: null,
        price_type: vpResult.method || 'not_captured'
      },
      raw_snippet: `allPrices=${JSON.stringify(vpResult.allPrices)} method=${vpResult.method}`,
      notes: `Custom Die-Cut shape clicked. Size inputs found: ${vpResult.widthFilled ? 'yes' : 'NO — still below fold or not rendering in headless'}. Method: ${vpResult.method}. Notes: ${vpResult.notes.join('; ')}`,
      blocker: !vpResult.price5000 ? 'No price captured' : (!vpResult.widthFilled ? 'Size 3×3 not confirmed — pricingContext may not encode custom dimensions without actual input interaction' : null),
      next_step: !vpResult.widthFilled ? 'VP Custom Die-Cut size inputs require actual browser scroll + fill. Try opening VP in real Chrome, clicking Custom Die-Cut, scrolling to Size section, filling 3×3.' : null
    };

    // Upsert
    const rawIdx = raw.captures.findIndex(c => c.id === gpEntry.id);
    if (rawIdx >= 0) raw.captures[rawIdx] = gpEntry; else raw.captures.push(gpEntry);
    const vpIdx = raw.captures.findIndex(c => c.id === vpEntry.id);
    if (vpIdx >= 0) raw.captures[vpIdx] = vpEntry; else raw.captures.push(vpEntry);
    raw.last_updated = today;

    // Update normalized
    if (gpResult.priceFromAPI) {
      const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
      if (q) {
        const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
        const gpNorm = {
          competitor: 'gotprint',
          competitor_display: 'GotPrint',
          status: 'live',
          coverage: gpResult.sizeSelected?.includes('3') ? 'near_spec' : 'different_size',
          total_price: gpResult.priceFromAPI,
          unit_price: gpResult.qtySelected ? parseFloat((gpResult.priceFromAPI / parseInt(gpResult.qtySelected.replace(/,/g, ''))).toFixed(4)) : null,
          currency: 'USD',
          shipping_included: false,
          confidence: 'medium',
          notes: `GP configurator: shape=${gpResult.shapeSelected} size=${gpResult.sizeSelected} paper=${gpResult.paperSelected} finish=${gpResult.finishSelected} qty=${gpResult.qtySelected}. Price from DOM subtotal.`
        };
        if (gi >= 0) q.competitor_results[gi] = { ...q.competitor_results[gi], ...gpNorm };
        else q.competitor_results.push(gpNorm);
      }
    }

    if (vpResult.price5000) {
      const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
      if (q) {
        const vi = q.competitor_results.findIndex(r => r.competitor === 'vistaprint');
        const vpNorm = {
          status: vpResult.widthFilled && vpResult.heightFilled ? 'live' : 'partial',
          coverage: vpResult.widthFilled && vpResult.heightFilled ? 'exact_spec' : 'size_unconfirmed',
          total_price: vpResult.price5000,
          unit_price: vpResult.unit5000,
          currency: 'USD',
          confidence: vpResult.widthFilled && vpResult.heightFilled ? 'high' : 'medium',
          notes: `Custom Die-Cut shape. Size 3×3 filled: ${!!(vpResult.widthFilled && vpResult.heightFilled)}. Method: ${vpResult.method}.`
        };
        if (vi >= 0) Object.assign(q.competitor_results[vi], vpNorm);
      }
    }

    norm.last_updated = today;
    writeJSON(RAW_FILE, raw);
    writeJSON(NORM_FILE, norm);
    log('\n✓ Data files updated');

    console.log('\n══════════════════════════════════════════');
    console.log(' FINAL CLICK PASS SUMMARY');
    console.log('══════════════════════════════════════════');
    console.log('GOTPRINT:');
    console.log(`  URL:       https://www.gotprint.com/products/roll-labels/order`);
    console.log(`  Shape opts:  ${gpResult.shapeOptions?.join(', ')}`);
    console.log(`  Size opts:   ${gpResult.sizeOptions?.join(', ')}`);
    console.log(`  Paper opts:  ${gpResult.paperOptions?.join(', ')}`);
    console.log(`  Finish opts: ${gpResult.finishOptions?.join(', ')}`);
    console.log(`  Qty opts:    ${gpResult.qtyOptions?.join(', ')}`);
    console.log(`  Selected:    shape=${gpResult.shapeSelected} | size=${gpResult.sizeSelected} | paper=${gpResult.paperSelected} | finish=${gpResult.finishSelected} | qty=${gpResult.qtySelected}`);
    console.log(`  Price:       ${gpResult.priceFromAPI ? '$' + gpResult.priceFromAPI : 'NOT CAPTURED'}`);
    console.log(`  Notes:       ${gpResult.notes?.join('; ')}`);
    console.log('');
    console.log('VISTAPRINT:');
    console.log(`  Shape clicked: ${vpResult.shape}`);
    console.log(`  Width=3: ${vpResult.widthFilled === 3} | Height=3: ${vpResult.heightFilled === 3}`);
    console.log(`  All prices:  ${JSON.stringify(vpResult.allPrices)}`);
    console.log(`  Price 5000:  ${vpResult.price5000 ? '$' + vpResult.price5000 : 'NOT CAPTURED'}`);
    console.log(`  Method:      ${vpResult.method}`);
    console.log(`  Notes:       ${vpResult.notes?.join('; ')}`);
    console.log('══════════════════════════════════════════\n');

    return { gpResult, vpResult };
  } finally {
    await browser.close();
  }
}

main().catch(e => { err(`Fatal: ${e.message}`); process.exit(1); });
