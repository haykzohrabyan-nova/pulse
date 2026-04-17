#!/usr/bin/env node
/**
 * capture-gp-native-select.js
 *
 * GotPrint /products/roll-labels/order uses NATIVE <select> elements.
 * Confirmed from screenshot + enumeration:
 *   select[0] = Shape  (Rectangle - Rounded | Square - Rounded | ... | Square)
 *   select[1] = Size   (disabled until shape selected; updates after shape change)
 *   select[2] = Paper  (Clear BOPP Label | White BOPP Label | ...)
 *   select[3] = Finish (Clear Gloss | Clear Gloss Outdoor | Matte Finish Indoor)
 *   select[4] = Color  (Full Color Front, No Back)
 *
 * Strategy:
 *   1. Select Shape = "Square"
 *   2. Wait for Size dropdown to update with square sizes
 *   3. Select Size = closest to 3×3 (enumerate after shape selection)
 *   4. Select Paper = "White BOPP Label"
 *   5. Select Finish = "Matte Finish (Indoor)"
 *   6. Wait for Subtotal to update
 *   7. Scroll down to look for qty selector; also try typing 5000
 *   8. Capture subtotal price
 *   9. Intercept any XHR /service/rest/v1/price* calls
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

function log(msg)  { console.log(`[gp] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ss(page, label) {
  const f = path.join(SCREENS_DIR, `${label}-${Date.now()}.png`);
  try { await page.screenshot({ path: f, fullPage: false }); log(`  ss→ ${path.basename(f)}`); } catch (_) {}
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

async function main() {
  const raw  = readJSON(RAW_FILE);
  const norm = readJSON(NORM_FILE);
  if (!raw || !norm) { err('Cannot load data files'); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const today = nowISO();

  // Capture pricing-related XHR
  const xhrPricing = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com') && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (/price|total|subtotal|amount|cost|qty/i.test(u) || /price|totalPrice|amount/i.test(body.slice(0, 500))) {
          xhrPricing.push({ url: u, status: resp.status(), body: body.slice(0, 2000) });
          if (u.includes('/service/rest/v1')) {
            log(`GP XHR: ${u.replace('https://www.gotprint.com/service/rest/v1/', '')} → ${body.slice(0, 400)}`);
          }
        }
      } catch (_) {}
    }
  });

  const result = {
    shapeOptions: [], sizeOptions: [], paperOptions: [], finishOptions: [], qtyOptions: [],
    shapeSelected: null, sizeSelected: null, paperSelected: null, finishSelected: null, qtySelected: null,
    priceRaw: null, priceNormalized: null,
    priceNote: null,
    notes: []
  };

  const page = await context.newPage();
  try {
    log('Loading https://www.gotprint.com/products/roll-labels/order ...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await sleep(4000);
    await ss(page, 'gp4-01-loaded');
    log(`Title: "${await page.title()}" | URL: ${page.url()}`);

    if (page.url().includes('home.html')) {
      result.notes.push('Redirected to home.html — page requires login or is geo-blocked');
      log('BLOCKED: redirected to home.html');
      await page.close(); await context.close(); await browser.close();
      return;
    }

    // Helper: read subtotal
    async function readSubtotal() {
      const t = await page.$eval(
        '.cart-price, [class*="subtotal"], [class*="total-price"], [class*="cart"], span:has-text("$")',
        el => el.textContent.trim()
      ).catch(() => null);
      if (t && /\$/.test(t)) return t;
      // fallback: find any $xx.xx near "Subtotal"
      return page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n; const found = [];
        while ((n = walker.nextNode())) {
          const t = n.textContent.trim();
          if (/^\$[\d,]+\.\d{2}$/.test(t)) found.push(t);
        }
        return found.slice(0, 5).join(' | ');
      });
    }

    // ── STEP 1: Enumerate all native selects ──
    const selectHandles = await page.$$('select');
    log(`Found ${selectHandles.length} native <select> elements`);

    for (let i = 0; i < selectHandles.length; i++) {
      const visible = await selectHandles[i].isVisible().catch(() => false);
      const disabled = await selectHandles[i].isDisabled().catch(() => false);
      const opts = await selectHandles[i].$$eval('option', os => os.map(o => o.textContent.trim()));
      const name = await selectHandles[i].getAttribute('name') || await selectHandles[i].getAttribute('id') || `select[${i}]`;
      log(`  select[${i}] name="${name}" visible=${visible} disabled=${disabled} opts(${opts.length}): ${opts.slice(0, 12).join(' | ')}`);

      if (i === 0) result.shapeOptions = opts.filter(o => o !== 'Please select an option');
      if (i === 1) result.sizeOptions  = opts.filter(o => o !== 'Please select an option');
      if (i === 2) result.paperOptions = opts.filter(o => o !== 'Please select an option');
      if (i === 3) result.finishOptions = opts.filter(o => o !== 'Please select an option');
    }

    // ── STEP 2: Select Shape = "Square" ──
    log('\nStep 2: selecting Shape = Square...');
    // Use the first select (index 0)
    const shapeSelect = selectHandles[0];
    const shapeOpts = await shapeSelect.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
    log(`Shape options: ${shapeOpts.map(o => o.t).join(' | ')}`);

    // Find exact "Square" (not "Square - Rounded")
    const squareOpt = shapeOpts.find(o => o.t.toLowerCase() === 'square') ||
                      shapeOpts.find(o => /^square$/i.test(o.t)) ||
                      shapeOpts.find(o => /square/i.test(o.t) && !/rounded/i.test(o.t)) ||
                      shapeOpts.find(o => /square/i.test(o.t));

    if (squareOpt) {
      await shapeSelect.selectOption({ value: squareOpt.v });
      result.shapeSelected = squareOpt.t;
      log(`Shape selected: "${squareOpt.t}"`);
      await sleep(3000); // Wait for size options to load
      await ss(page, 'gp4-02-shape-selected');

      // Re-enumerate size options after shape selection
      const sizeSelectH = (await page.$$('select'))[1];
      if (sizeSelectH) {
        const sizeOpts = await sizeSelectH.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
        result.sizeOptions = sizeOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);
        log(`Size options after Shape=Square: ${sizeOpts.map(o => o.t).join(' | ')}`);
      }
    } else {
      log('Square option not found. Available: ' + shapeOpts.map(o => o.t).join(', '));
      result.notes.push('Square shape option not found');
    }

    // Re-get all selects (DOM may have updated)
    const selects2 = await page.$$('select');

    // ── STEP 3: Select Size — closest to 3"×3" ──
    log('\nStep 3: selecting Size closest to 3×3...');
    const sizeSelect = selects2[1];
    if (sizeSelect) {
      const sizeOpts = await sizeSelect.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      log(`All size options: ${sizeOpts.map(o => o.t).join(' | ')}`);
      result.sizeOptions = sizeOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);

      // Priority: exact 3×3, then close to 3×3
      const sizeTarget =
        sizeOpts.find(o => /^3"?\s*x\s*3"?$|^3\s*x\s*3$/i.test(o.t)) ||
        sizeOpts.find(o => o.t.includes('3') && o.t.toLowerCase().includes('x') && o.t.includes('3')) ||
        sizeOpts.find(o => /3.*x|x.*3/.test(o.t)) ||
        sizeOpts.filter(o => o.t !== 'Please select an option').slice(-1)[0]; // largest available

      if (sizeTarget && sizeTarget.t !== 'Please select an option') {
        await sizeSelect.selectOption({ value: sizeTarget.v });
        result.sizeSelected = sizeTarget.t;
        log(`Size selected: "${sizeTarget.t}"`);
        await sleep(3000);
        await ss(page, 'gp4-03-size-selected');

        const sub = await readSubtotal();
        log(`Subtotal after size: ${sub}`);
      } else {
        log('No suitable size option found');
        result.notes.push(`Size options after Square: ${result.sizeOptions.join(', ')}`);
      }
    }

    // ── STEP 4: Select Paper = "White BOPP Label" ──
    const selects3 = await page.$$('select');
    log('\nStep 4: selecting Paper = White BOPP...');
    const paperSelect = selects3[2];
    if (paperSelect) {
      const paperOpts = await paperSelect.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      log(`Paper options: ${paperOpts.map(o => o.t).join(' | ')}`);
      result.paperOptions = paperOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);

      const boppOpt =
        paperOpts.find(o => /white.*bopp/i.test(o.t)) ||
        paperOpts.find(o => /bopp/i.test(o.t)) ||
        paperOpts.find(o => /white/i.test(o.t));

      if (boppOpt && boppOpt.t !== 'Please select an option') {
        const disabled = await paperSelect.isDisabled().catch(() => false);
        if (disabled) {
          log(`Paper select is disabled — skipping`);
          result.notes.push('Paper dropdown disabled (may need size selected first)');
        } else {
          await paperSelect.selectOption({ value: boppOpt.v });
          result.paperSelected = boppOpt.t;
          log(`Paper selected: "${boppOpt.t}"`);
          await sleep(3000);
          await ss(page, 'gp4-04-paper-selected');

          const sub = await readSubtotal();
          log(`Subtotal after paper: ${sub}`);
        }
      }
    }

    // ── STEP 5: Select Finish = "Matte Finish (Indoor)" ──
    const selects4 = await page.$$('select');
    log('\nStep 5: selecting Finish = Matte...');
    const finishSelect = selects4[3];
    if (finishSelect) {
      const finishOpts = await finishSelect.$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      log(`Finish options: ${finishOpts.map(o => o.t).join(' | ')}`);
      result.finishOptions = finishOpts.filter(o => o.t !== 'Please select an option').map(o => o.t);

      const matteOpt =
        finishOpts.find(o => /matte.*indoor/i.test(o.t)) ||
        finishOpts.find(o => /matte/i.test(o.t));

      if (matteOpt && matteOpt.t !== 'Please select an option') {
        const disabled = await finishSelect.isDisabled().catch(() => false);
        if (disabled) {
          log(`Finish select is disabled — skipping`);
          result.notes.push('Finish dropdown disabled');
        } else {
          await finishSelect.selectOption({ value: matteOpt.v });
          result.finishSelected = matteOpt.t;
          log(`Finish selected: "${matteOpt.t}"`);
          await sleep(3000);
          await ss(page, 'gp4-05-finish-selected');
        }
      }
    }

    // ── STEP 6: Look for Quantity selector ──
    await sleep(1000);
    log('\nStep 6: finding qty selector...');

    // Scroll down to look for qty input
    await page.evaluate(() => window.scrollBy(0, 400));
    await sleep(1000);
    await ss(page, 'gp4-06-scrolled');

    const allSelects5 = await page.$$('select');
    log(`Total selects after scroll: ${allSelects5.length}`);
    for (let i = 0; i < allSelects5.length; i++) {
      const visible  = await allSelects5[i].isVisible().catch(() => false);
      const disabled = await allSelects5[i].isDisabled().catch(() => false);
      if (!visible) continue;
      const opts = await allSelects5[i].$$eval('option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
      const name = await allSelects5[i].getAttribute('name') || await allSelects5[i].getAttribute('id') || `[${i}]`;
      log(`  select[${i}] name="${name}" disabled=${disabled}: ${opts.slice(0, 8).map(o => o.t).join(' | ')}`);

      // Check for qty options
      if (opts.some(o => /\d{3,}|qty|quantity/i.test(o.t))) {
        result.qtyOptions = opts.map(o => o.t);
        log(`  → Looks like qty! opts: ${opts.map(o => o.t).slice(0, 10).join(' | ')}`);
        const q5k = opts.find(o => o.t.includes('5000') || o.t.includes('5,000') || o.v === '5000' ||
                                    o.t.includes('5 000') || o.v.includes('5000'));
        if (q5k && !disabled) {
          await allSelects5[i].selectOption({ value: q5k.v });
          result.qtySelected = q5k.t;
          log(`  → Selected qty: "${q5k.t}"`);
          await sleep(3000);
          await ss(page, 'gp4-07-qty-selected');
        } else if (!disabled && opts.length > 1) {
          // Select the largest qty available
          const largests = opts.filter(o => o.t !== 'Please select an option').sort((a, b) => {
            const na = parseInt(a.t.replace(/\D/g, '')) || 0;
            const nb = parseInt(b.t.replace(/\D/g, '')) || 0;
            return nb - na;
          });
          if (largests[0]) {
            await allSelects5[i].selectOption({ value: largests[0].v });
            result.qtySelected = largests[0].t;
            log(`  → Selected largest qty: "${largests[0].t}"`);
            await sleep(3000);
          }
        }
      }
    }

    // Also look for qty input
    const qtyInputEls = await page.$$('input[name*="qty" i], input[id*="qty" i], input[placeholder*="qty" i]');
    for (const qi of qtyInputEls) {
      const visible = await qi.isVisible().catch(() => false);
      if (visible) {
        await qi.fill('5000');
        await page.keyboard.press('Tab');
        result.qtySelected = '5000';
        log('Found and filled qty input = 5000');
        await sleep(2000);
      }
    }

    // ── STEP 7: Read final subtotal ──
    await sleep(2000);
    await ss(page, 'gp4-08-final');

    // Read subtotal element specifically
    const subtotalEl = await page.$('.cart-price, [class*="subtotal"], [class*="total"]');
    if (subtotalEl) {
      const st = await subtotalEl.textContent();
      log(`Subtotal element text: "${st}"`);
      const m = st?.match(/\$([\d,]+\.\d{2})/);
      if (m) result.priceRaw = parseFloat(m[1].replace(/,/g, ''));
    }

    // Broader DOM scan
    const allPriceTexts = await page.evaluate(() => {
      const r = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const t = n.textContent.trim();
        if (/\$[\d,]+\.\d{2}/.test(t) && t.length < 80) r.push(t);
      }
      return r.slice(0, 20);
    });
    log(`All price texts on page: ${JSON.stringify(allPriceTexts)}`);

    // Extract the subtotal specifically
    const subtotalText = await page.evaluate(() => {
      // Look for element near "Subtotal" label
      const labels = document.querySelectorAll('*');
      for (const el of labels) {
        if (el.textContent.trim() === 'Subtotal (excludes shipping) :' || el.textContent.includes('Subtotal')) {
          const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
          if (next) return next.textContent.trim();
          return el.parentElement?.textContent.trim().slice(0, 100) || null;
        }
      }
      return null;
    });
    log(`Subtotal area text: "${subtotalText}"`);

    if (subtotalText) {
      const m = subtotalText.match(/\$([\d,]+\.\d{2})/);
      if (m) {
        const amt = parseFloat(m[1].replace(/,/g, ''));
        if (amt > 0) result.priceRaw = amt;
      }
    }

    // Try to get from all $ amounts - exclude small promo/nav prices
    if (!result.priceRaw) {
      for (const t of allPriceTexts) {
        const m = t.match(/\$([\d,]+\.\d{2})/);
        if (m) {
          const amt = parseFloat(m[1].replace(/,/g, ''));
          if (amt > 50) { result.priceRaw = amt; break; }
        }
      }
    }

    // ── STEP 8: Check XHR for pricing data ──
    log(`\nXHR pricing calls: ${xhrPricing.length}`);
    for (const xhr of xhrPricing) {
      if (xhr.url.includes('/service/rest/v1')) {
        log(`  ${xhr.url.split('/v1/')[1]?.slice(0, 50)} → ${xhr.body.slice(0, 300)}`);
      }
      try {
        const d = JSON.parse(xhr.body);
        // Deep search for price fields
        const findPrices = (obj, path = '') => {
          if (typeof obj === 'number' && obj > 5 && obj < 50000) {
            if (/price|total|amount|subtotal|cost/i.test(path)) {
              log(`  XHR price field ${path} = ${obj}`);
              if (obj > 50 && !result.priceNormalized) result.priceNormalized = obj;
            }
          }
          if (typeof obj === 'object' && obj !== null && path.length < 100) {
            for (const k of Object.keys(obj)) findPrices(obj[k], `${path}.${k}`);
          }
        };
        findPrices(d);
      } catch (_) {}
    }

    // ── STEP 9: Also try probing the GP REST API for price table ──
    log('\nProbing GP REST API for pricing...');
    const cookies = await context.cookies();
    const cookieHdr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Try specific product pricing endpoints now that we have session cookies
    const priceProbes = [
      `https://www.gotprint.com/service/rest/v1/products/price-table?productType=ROLL_LABEL&shape=Square&size=3x3&qty=5000&material=WHITE_BOPP_LABEL&finish=MATTE`,
      `https://www.gotprint.com/service/rest/v1/products/price?shape=Square&width=3&height=3&qty=5000&paper=WHITE_BOPP_LABEL&finish=MATTE_INDOOR`,
      `https://www.gotprint.com/service/rest/v1/quote?product=roll-labels&qty=5000`,
      `https://www.gotprint.com/service/rest/v1/products/100/price?qty=5000`,
    ];
    for (const url of priceProbes) {
      try {
        const r = await context.request.get(url, {
          headers: { Cookie: cookieHdr, Accept: 'application/json' },
          timeout: 10000
        });
        log(`API probe ${url.split('/v1/')[1]?.slice(0, 60)}: ${r.status()}`);
        if (r.status() < 400) {
          const body = await r.text();
          log(`  body: ${body.slice(0, 400)}`);
        }
      } catch (_) {}
    }

    // ── Summary ──
    result.priceNormalized = result.priceNormalized || result.priceRaw;

    log('\n═══════════════════════════════════════');
    log('GP RESULT SUMMARY:');
    log(`  Shape: ${result.shapeSelected}`);
    log(`  Size:  ${result.sizeSelected} (all: ${result.sizeOptions.slice(0, 10).join(' | ')})`);
    log(`  Paper: ${result.paperSelected}`);
    log(`  Finish: ${result.finishSelected}`);
    log(`  Qty: ${result.qtySelected} (opts: ${result.qtyOptions.slice(0, 10).join(' | ')})`);
    log(`  Price (DOM): $${result.priceRaw}`);
    log(`  Price (XHR): $${result.priceNormalized}`);
    log(`  Notes: ${result.notes.join('; ')}`);
    log('═══════════════════════════════════════\n');

    // ── Update data files ──
    const gpEntry = {
      id: `gotprint-native-select-${today}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: today,
      capture_method: 'playwright_native_select_direct',
      capture_source: 'automated_headless',
      confidence: result.priceNormalized ? 'medium' : 'none',
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels shape="${result.shapeSelected}" size="${result.sizeSelected}" paper="${result.paperSelected}" finish="${result.finishSelected}" qty="${result.qtySelected}"`,
      specs: {
        shape: result.shapeSelected,
        size: result.sizeSelected,
        material: result.paperSelected,
        finish: result.finishSelected,
        quantity: result.qtySelected ? parseInt(result.qtySelected.replace(/\D/g, '')) : null
      },
      pricing: {
        total_price: result.priceNormalized,
        unit_price: result.qtySelected ? parseFloat((result.priceNormalized / parseInt(result.qtySelected.replace(/\D/g, '') || 1)).toFixed(4)) : null,
        currency: 'USD',
        turnaround_days: null,
        shipping_included: false,
        price_type: result.priceNormalized ? 'configurator_dom_subtotal' : 'not_captured'
      },
      raw_snippet: `allPriceTexts=${JSON.stringify(allPriceTexts.slice(0, 5))}`,
      notes: `GP /products/roll-labels/order — native <select> confirmed. Shapes: ${result.shapeOptions.join(', ')}. Sizes: ${result.sizeOptions.slice(0, 8).join(', ')}. Paper: ${result.paperOptions.join(', ')}. Finish: ${result.finishOptions.join(', ')}. ${result.notes.join('; ')}`,
      blocker: result.priceNormalized ? null : `Price not captured. Shape=${result.shapeSelected} Size=${result.sizeSelected} Paper=${result.paperSelected} Finish=${result.finishSelected}. All price texts: ${allPriceTexts.join(' ')}`,
      next_step: result.priceNormalized ? null : 'Manual: open gotprint.com/products/roll-labels/order in Chrome, select Square, choose largest size, White BOPP, Matte Finish, note subtotal + qty selector'
    };

    const gpRawIdx = raw.captures.findIndex(c => c.id === gpEntry.id);
    if (gpRawIdx >= 0) raw.captures[gpRawIdx] = gpEntry; else raw.captures.push(gpEntry);
    raw.last_updated = today;

    if (result.priceNormalized) {
      const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
      if (q) {
        const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
        const gpNorm = {
          competitor: 'gotprint',
          competitor_display: 'GotPrint',
          status: 'live',
          coverage: result.sizeSelected?.includes('3') ? 'near_spec' : 'different_size',
          total_price: result.priceNormalized,
          confidence: 'medium',
          notes: `Native select configurator at /products/roll-labels/order. Shape=${result.shapeSelected} Size=${result.sizeSelected} Paper=${result.paperSelected} Finish=${result.finishSelected} Qty=${result.qtySelected}`
        };
        if (gi >= 0) Object.assign(q.competitor_results[gi], gpNorm);
        else q.competitor_results.push(gpNorm);
      }
    }

    norm.last_updated = today;
    writeJSON(RAW_FILE, raw);
    writeJSON(NORM_FILE, norm);
    log('✓ Data files updated');

  } catch (e) {
    err(`Fatal: ${e.message}`);
    result.notes.push(`Exception: ${e.message}`);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
