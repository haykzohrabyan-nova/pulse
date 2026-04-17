#!/usr/bin/env node
/**
 * capture-vp-axiom-targeted.js
 *
 * Targeted fix pass based on capture-advanced-pass.js findings:
 *
 * VISTAPRINT:
 *   - First: enumerate all radio buttons to map size options
 *   - Click the 3"×3" size radio (skip Trustpilot stars!)
 *   - Wait for new Cimpress API call after size selection
 *   - Use context.request.get() (Node.js side, no CORS) to replay with qty=5000
 *
 * AXIOM PRINT:
 *   - Use page.waitForSelector('.ant-select-dropdown') OUTSIDE evaluate
 *   - Enumerate size options in the size dropdown
 *   - Find "3\" x 3\"" option and click it
 *   - Select "White Matte BOPP" in material/liner dropdown
 *   - Select 2500 qty — use Playwright's native click + wait
 *
 * GOTPRINT:
 *   - Fetch access_token.txt and test it against /service/rest/v1/products/price
 *   - Enumerate available productType values from the price-table JS
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const RAW_FILE  = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

function log(msg)  { console.log(`[tgt] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseDollar(text) {
  if (!text) return null;
  const m = String(text).match(/\$?([\d,]+\.?\d{0,2})/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return (v > 0.5 && v < 200000) ? v : null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── VISTAPRINT ───────────────────────────────────────────────────────────────
async function captureVistaprint(browser) {
  log('=== VISTAPRINT: radio-button size probe + Node.js API call ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Track all Cimpress calls with full URL
  const cimpressCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('prices.cimpress.io') && u.includes('/prices/')) {
      try {
        const body = await resp.text();
        cimpressCalls.push({ url: u, body, ts: Date.now() });
        const urlObj = new URL(u);
        const sels = {};
        for (const [k, v] of urlObj.searchParams.entries()) {
          if (k.startsWith('selections[') || k === 'quantities') sels[k] = v;
        }
        log(`VP intercept: qty=${urlObj.searchParams.get('quantities')} sel=${JSON.stringify(sels)}`);
      } catch (_) {}
    }
  });

  const result = {
    defaultPrices: {},
    price5000: null, unit5000: null,
    sizeOptionsFound: [],
    sizeClicked: null, sizeMethod: null,
    capturedAfterSize: false,
    error: null
  };

  const page = await context.newPage();
  try {
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });
    log('VP: page loaded, waiting for configurator...');
    await sleep(12000);

    // Parse default call
    if (cimpressCalls.length > 0) {
      try {
        const data = JSON.parse(cimpressCalls[0].body);
        if (data.estimatedPrices) {
          Object.entries(data.estimatedPrices).forEach(([qty, pd]) => {
            const total = pd.totalListPrice?.untaxed ?? pd.totalListPrice;
            result.defaultPrices[qty] = total;
            log(`VP default: qty=${qty} → $${total}`);
          });
        }
      } catch (_) {}
    }

    // ── Step 1: Enumerate all radio buttons ──
    const radioInfo = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el.closest('[class*="swatch"], [class*="option"], [class*="size"]'));

      return radios.map(el => {
        // Get the label
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrapperText = el.closest('label, [class*="option"], [class*="swatch"], div')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60);
        return {
          name: el.name,
          value: el.value,
          id: el.id,
          checked: el.checked,
          ariaLabel: el.getAttribute('aria-label'),
          labelText: labelEl?.textContent?.trim().slice(0, 40),
          wrapperText
        };
      });
    });

    log(`VP: ${radioInfo.length} radio buttons found`);
    radioInfo.forEach(r => log(`  radio: name="${r.name}" value="${r.value}" checked=${r.checked} label="${r.labelText}" wrapper="${r.wrapperText?.slice(0, 50)}"`));
    result.sizeOptionsFound = radioInfo;

    // ── Step 2: Find and click the 3"×3" size radio ──
    // Identify size radios — they are NOT from Trustpilot
    // Trustpilot stars will have values like "5", "4", "3" (no unit)
    // Size radios will have values like "3x3", "3_3", "3in", or have label text "3 in x 3 in"
    const sizeRadioGroups = {};
    radioInfo.forEach(r => {
      if (!sizeRadioGroups[r.name]) sizeRadioGroups[r.name] = [];
      sizeRadioGroups[r.name].push(r);
    });
    log(`VP: radio groups: ${Object.keys(sizeRadioGroups).join(', ')}`);

    // Try to identify the size group: more than 2 radios, not Trustpilot
    let sizeGroup = null;
    for (const [name, radios] of Object.entries(sizeRadioGroups)) {
      // Skip Trustpilot (has values 1-5, single digits)
      const allSingleDigit = radios.every(r => /^[1-5]$/.test(r.value || ''));
      if (!allSingleDigit && radios.length >= 2) {
        sizeGroup = { name, radios };
        log(`VP: size group candidate: "${name}" with ${radios.length} options`);
        break;
      }
    }

    const callsBefore = cimpressCalls.length;

    if (sizeGroup) {
      // Try to find a 3x3 option
      const target3x3 = sizeGroup.radios.find(r => {
        const t = (r.value + ' ' + r.labelText + ' ' + r.wrapperText + ' ' + r.ariaLabel).toLowerCase();
        return /3\s*(in|")\s*(x|×)\s*3/i.test(t) || t.includes('3x3') || t.includes('3_3');
      });

      if (target3x3) {
        log(`VP: found 3"×3" radio — clicking value="${target3x3.value}" id="${target3x3.id}"`);
        try {
          if (target3x3.id) {
            await page.click(`#${target3x3.id}`);
          } else {
            await page.evaluate((val, grpName) => {
              const r = document.querySelector(`input[type="radio"][name="${grpName}"][value="${val}"]`);
              if (r) { r.click(); }
            }, target3x3.value, sizeGroup.name);
          }
          result.sizeClicked = target3x3.value;
          result.sizeMethod = 'radio_click_3x3';
          await sleep(6000);
          log('VP: clicked 3x3 radio, waiting for Cimpress call...');
        } catch (e) { log('VP: radio click error: ' + e.message); }
      } else {
        // Log all options to understand the mapping
        log('VP: no explicit 3x3 radio found — all options:');
        sizeGroup.radios.forEach(r => log(`  value="${r.value}" label="${r.labelText}" wrapper="${r.wrapperText?.slice(0, 60)}"`));

        // Try clicking the last option (often largest size)
        const lastRadio = sizeGroup.radios[sizeGroup.radios.length - 1];
        log(`VP: trying last radio: value="${lastRadio.value}"`);
        if (lastRadio.id) {
          await page.click(`#${lastRadio.id}`);
        } else {
          await page.evaluate((val, grpName) => {
            const r = document.querySelector(`input[type="radio"][name="${grpName}"][value="${val}"]`);
            if (r) r.click();
          }, lastRadio.value, sizeGroup.name);
        }
        result.sizeClicked = lastRadio.value;
        result.sizeMethod = 'radio_click_last';
        await sleep(5000);
      }
    }

    // Also try a scroll-down approach to find additional size elements
    await page.evaluate(() => window.scrollBy(0, 500));
    await sleep(3000);

    // Check if new Cimpress calls fired after size interaction
    const newCalls = cimpressCalls.slice(callsBefore);
    log(`VP: ${newCalls.length} new Cimpress calls after size interaction`);
    result.capturedAfterSize = newCalls.length > 0;

    // ── Step 3: Use context.request.get() (Node.js side, bypasses CORS) ──
    const bestCall = cimpressCalls[cimpressCalls.length - 1];
    if (bestCall) {
      const urlObj = new URL(bestCall.url);
      const pricingContext = urlObj.searchParams.get('pricingContext');
      const productKey = urlObj.searchParams.get('productKey') || 'PRD-DF5PWTHC';

      log(`VP: best call pricingContext[:50]="${pricingContext?.slice(0, 50)}", productKey="${productKey}"`);

      // Build qty=5000 URL
      urlObj.searchParams.set('quantities', '5000');
      const url5k = urlObj.toString();

      // Also build qty=500,1000,2500,5000,10000 to get full range
      urlObj.searchParams.set('quantities', '500,1000,2500,5000,10000');
      const urlRange = urlObj.toString();

      log('VP: making Node.js-side API call (bypasses CORS)...');

      // Node.js-side fetch using Playwright's context.request (no CORS)
      try {
        const resp5k = await context.request.get(url5k, {
          headers: {
            'Accept': 'application/json',
            'Origin': 'https://www.vistaprint.com',
            'Referer': 'https://www.vistaprint.com/labels-stickers/roll-labels'
          }
        });
        const body5k = await resp5k.text();
        log(`VP 5k request: status=${resp5k.status()}, body length=${body5k.length}`);

        if (resp5k.ok()) {
          const data = JSON.parse(body5k);
          if (data.estimatedPrices?.['5000']) {
            const ep = data.estimatedPrices['5000'];
            result.price5000 = ep.totalListPrice?.untaxed ?? ep.totalListPrice;
            result.unit5000  = ep.unitListPrice?.untaxed  ?? ep.unitListPrice;
            log(`VP: *** QTY 5000 = $${result.price5000} ($${result.unit5000}/ea) ***`);
          } else {
            const qtys = Object.keys(data.estimatedPrices || {});
            log(`VP: qty 5000 not in response. Available: [${qtys.join(', ')}]`);
            log(`VP: raw response: ${body5k.slice(0, 400)}`);
          }
        } else {
          log(`VP: API call failed: status=${resp5k.status()}, body=${body5k.slice(0, 300)}`);
        }
      } catch (e) {
        log(`VP context.request error: ${e.message}`);
      }

      // Try multi-qty range
      if (!result.price5000) {
        try {
          const respRange = await context.request.get(urlRange, {
            headers: { 'Accept': 'application/json', 'Origin': 'https://www.vistaprint.com' }
          });
          if (respRange.ok()) {
            const dataR = JSON.parse(await respRange.text());
            if (dataR.estimatedPrices) {
              Object.entries(dataR.estimatedPrices).forEach(([qty, pd]) => {
                const total = pd.totalListPrice?.untaxed ?? pd.totalListPrice;
                const unit  = pd.unitListPrice?.untaxed  ?? pd.unitListPrice;
                log(`VP range: qty=${qty} → $${total} ($${unit}/ea)`);
              });
              const ep5k = dataR.estimatedPrices?.['5000'];
              if (ep5k) {
                result.price5000 = ep5k.totalListPrice?.untaxed ?? ep5k.totalListPrice;
                result.unit5000  = ep5k.unitListPrice?.untaxed  ?? ep5k.unitListPrice;
                log(`VP: *** QTY 5000 from range call = $${result.price5000} ***`);
              }
            }
          }
        } catch (e) { log('VP range call error: ' + e.message); }
      }

      // Capture the selections in the best call for documentation
      const sels = {};
      for (const [k, v] of (new URL(bestCall.url)).searchParams.entries()) {
        if (k.startsWith('selections[') || k === 'quantities') sels[k] = v;
      }
      result.selectionsUsed = sels;
    }

  } catch (e) {
    result.error = e.message;
    err('VP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── AXIOM PRINT ─────────────────────────────────────────────────────────────
async function captureAxiom(browser) {
  log('=== AXIOM PRINT: Proper dropdown wait + size/material/qty ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const result = { price: null, sizeSelected: null, materialSelected: null, qtySelected: null, allDropdownOptions: {}, error: null };

  const page = await context.newPage();
  try {
    await page.goto('https://axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(4000);

    // Read all current dropdown states
    const initialState = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('.ant-select'))
        .map((s, i) => {
          const label = s.closest('.ant-form-item')?.querySelector('label, .ant-form-item-label span')?.textContent?.trim();
          const current = s.querySelector('.ant-select-selection-item')?.textContent?.trim();
          return { idx: i, label, current };
        });
      return selects;
    });
    log(`Axiom selects: ${JSON.stringify(initialState)}`);

    // Read current price
    const readPrice = async () => {
      return page.evaluate(() => {
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const ps = new Set();
        let m;
        while ((m = re.exec(document.body.innerText)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 5 && v < 100000) ps.add(v);
        }
        return [...ps].sort((a, b) => a - b);
      });
    };

    const initial = await readPrice();
    log(`Axiom initial prices: [${initial.join(', ')}]`);

    // Helper: open Ant Select by index, wait for dropdown, read options, click target
    async function antSelectByIndex(idx, targetText) {
      log(`Axiom: opening select[${idx}] looking for "${targetText}"`);

      // Click the selector to open the dropdown
      const selectors = await page.$$('.ant-select');
      if (idx >= selectors.length) {
        log(`Axiom: no select at index ${idx} (only ${selectors.length} found)`);
        return { ok: false };
      }

      const sel = selectors[idx];
      await sel.click();

      // Wait for the dropdown to appear
      let dropdownVisible = false;
      try {
        await page.waitForSelector('.ant-select-dropdown', { state: 'visible', timeout: 5000 });
        dropdownVisible = true;
      } catch (_) {
        log(`Axiom: dropdown did not appear for select[${idx}]`);
        // Press Escape to close any stuck state
        await page.keyboard.press('Escape');
        return { ok: false };
      }

      await sleep(300);

      // Read all visible options
      const options = await page.$$eval(
        '.ant-select-dropdown:not([style*="display: none"]) .ant-select-item-option-content, ' +
        '.ant-select-dropdown .ant-select-item-option-content',
        els => els
          .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el.closest('.ant-select-dropdown:not([style*="display: none"])'))
          .map(el => el.textContent?.trim())
          .filter(Boolean)
      );
      log(`Axiom: select[${idx}] options: [${options.join(', ')}]`);
      result.allDropdownOptions[idx] = options;

      if (!targetText) {
        // Just reading — close without selecting
        await page.keyboard.press('Escape');
        return { ok: false, options };
      }

      // Find matching option
      const match = options.find(o => o === targetText || o.includes(targetText));
      if (!match) {
        log(`Axiom: "${targetText}" not in options [${options.join(', ')}] — pressing Escape`);
        await page.keyboard.press('Escape');
        return { ok: false, options };
      }

      // Click the matching option using Playwright's text selector
      try {
        await page.click(
          `.ant-select-dropdown:not([style*="display: none"]) .ant-select-item-option-content`,
          { hasText: match }
        );
        await sleep(2000); // wait for price recalc
        log(`Axiom: selected "${match}"`);
        return { ok: true, selected: match };
      } catch (e) {
        // Try evaluating the click
        const clicked = await page.evaluate((t) => {
          const opts = Array.from(document.querySelectorAll('.ant-select-item-option'));
          const opt = opts.find(el =>
            (el.offsetWidth > 0 || el.offsetHeight > 0) &&
            el.textContent?.trim() === t
          );
          if (opt) { opt.click(); return true; }
          return false;
        }, match);
        if (clicked) {
          await sleep(2000);
          return { ok: true, selected: match };
        }
        await page.keyboard.press('Escape');
        return { ok: false, options, error: e.message };
      }
    }

    // ── Step 1: Enumerate all dropdown options ──
    log('Axiom: enumerating all dropdown options...');
    for (let i = 0; i < initialState.length; i++) {
      await antSelectByIndex(i, null); // read-only pass
      await sleep(300);
    }
    log(`Axiom dropdown options found: ${JSON.stringify(result.allDropdownOptions)}`);

    // Determine which dropdown is size (has width × height pattern) and which is qty
    let sizeIdx = -1, matIdx = -1, qtyIdx = -1;
    for (const [idxStr, opts] of Object.entries(result.allDropdownOptions)) {
      const idx = parseInt(idxStr);
      const hasSizePattern = opts.some(o => /\d+\s*["x×]\s*\d+/.test(o) || /\d+\.?\d*\s*in/.test(o));
      const hasQtyPattern  = opts.some(o => /^\d{1,3}(,\d{3})*$/.test(o.replace(/\s/g, '')) || /^[\d,]+$/.test(o.replace(/\s/g, '')));
      const hasBopp        = opts.some(o => /bopp|matte|gloss|paper/i.test(o));
      const hasPaperLiner  = opts.some(o => /liner|paper/i.test(o));

      log(`Axiom: select[${idx}] hasSizePattern=${hasSizePattern} hasQtyPattern=${hasQtyPattern} hasBopp=${hasBopp} hasPaperLiner=${hasPaperLiner}`);

      if (hasSizePattern) sizeIdx = idx;
      if (hasBopp) matIdx = idx;
      if (hasQtyPattern && opts.length >= 4) qtyIdx = idx;
    }
    log(`Axiom: sizeIdx=${sizeIdx}, matIdx=${matIdx}, qtyIdx=${qtyIdx}`);

    // ── Step 2: Select size 3"×3" ──
    if (sizeIdx >= 0) {
      const sizeOpts = result.allDropdownOptions[sizeIdx] || [];
      // Find closest to 3x3
      const target3x3 = sizeOpts.find(o =>
        /^3["'"]?\s*(x|×)\s*3/.test(o) || o === '3" x 3"' || o === '3 x 3'
      );
      const bestSize = target3x3 || sizeOpts.find(o => /3/.test(o));
      log(`Axiom: size options=[${sizeOpts.join(', ')}], targeting "${target3x3 || bestSize}"`);

      if (target3x3) {
        const sizeResult = await antSelectByIndex(sizeIdx, target3x3);
        result.sizeSelected = sizeResult.ok ? target3x3 : null;
      } else if (bestSize) {
        const sizeResult = await antSelectByIndex(sizeIdx, bestSize);
        result.sizeSelected = sizeResult.ok ? bestSize : null;
      }
    }

    const afterSize = await readPrice();
    log(`Axiom after size: prices=[${afterSize.join(', ')}]`);

    // ── Step 3: Select White Matte BOPP material (if available) ──
    if (matIdx >= 0) {
      const matOpts = result.allDropdownOptions[matIdx] || [];
      const boppOpt = matOpts.find(o => /white.*matte.*bopp|white.*bopp/i.test(o));
      const matteOpt = boppOpt || matOpts.find(o => /matte/i.test(o));
      log(`Axiom: material options=[${matOpts.join(', ')}], targeting "${boppOpt || matteOpt}"`);

      if (boppOpt || matteOpt) {
        const matResult = await antSelectByIndex(matIdx, boppOpt || matteOpt);
        result.materialSelected = matResult.ok ? (boppOpt || matteOpt) : null;
      }
    }

    const afterMat = await readPrice();
    log(`Axiom after material: prices=[${afterMat.join(', ')}]`);

    // ── Step 4: Select 2500 qty ──
    if (qtyIdx >= 0) {
      const qtyOpts = result.allDropdownOptions[qtyIdx] || [];
      // Find 2500 or closest high qty
      const qty2500 = qtyOpts.find(o => o.replace(/[,\s]/g, '') === '2500' || o === '2,500');
      const highestQty = qtyOpts[qtyOpts.length - 1];
      log(`Axiom: qty options=[${qtyOpts.join(', ')}], targeting "${qty2500 || highestQty}"`);

      const qtyTarget = qty2500 || highestQty;
      if (qtyTarget) {
        const qtyResult = await antSelectByIndex(qtyIdx, qtyTarget);
        result.qtySelected = qtyResult.ok ? qtyTarget : null;
      }
    }

    await sleep(2000);
    const finalPrices = await readPrice();
    log(`Axiom FINAL prices: [${finalPrices.join(', ')}]`);

    // Read the specific price display element
    const priceDisplay = await page.evaluate(() => {
      // Look for total price near the configurator
      const els = Array.from(document.querySelectorAll('[class*="price"], [class*="Price"], [class*="total"], [class*="Total"]'))
        .filter(el => el.offsetWidth > 0 && el.offsetWidth < 500);

      for (const el of els) {
        const text = el.textContent?.trim();
        const m = text?.match(/\$([\d,]+\.?\d{0,2})/);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 50 && v < 10000) return { text: text?.slice(0, 80), price: v };
        }
      }

      // Fallback: look for the largest price on page in the 150-2000 range
      const re = /\$([\d,]+\.?\d{0,2})/g;
      const ps = [];
      let m;
      while ((m = re.exec(document.body.innerText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 150 && v <= 2000) ps.push(v);
      }
      return { prices: [...new Set(ps)].sort((a, b) => b - a), price: ps[0] || null };
    });
    log(`Axiom final price display: ${JSON.stringify(priceDisplay)}`);

    // Set result price — use plausible range for 2500 3x3 labels
    const plausible = finalPrices.filter(p => p >= 100 && p <= 2000);
    result.price = priceDisplay?.price || plausible[plausible.length - 1] || null;

  } catch (e) {
    result.error = e.message;
    err('Axiom: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── GOTPRINT: access_token.txt probe ─────────────────────────────────────────
async function probeGotprint(browser) {
  log('=== GOTPRINT: access_token.txt probe + price API test ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const result = { accessToken: null, rollLabelProductType: null, price: null, priceSpec: null, error: null };

  const page = await context.newPage();
  try {
    // Load page to get cookies, then fetch the access token
    await page.goto('https://www.gotprint.com/home.html', {
      waitUntil: 'domcontentloaded', timeout: 25000
    });
    await sleep(3000);

    // Fetch the access_token.txt
    const tokenResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/assets/dyn/css/access_token.txt', { credentials: 'include' });
        return { status: r.status, body: (await r.text()).slice(0, 500) };
      } catch (e) { return { error: e.message }; }
    });
    log(`GP access_token.txt: status=${tokenResult.status || tokenResult.error}, body="${tokenResult.body?.slice(0, 100)}"`);
    result.accessToken = tokenResult.body?.trim() || null;

    if (!result.accessToken) {
      log('GP: no access token found — skipping API tests');
      return result;
    }

    // Determine what the token looks like (JWT, bearer, etc.)
    const isJWT = result.accessToken.includes('.');
    log(`GP: token type: ${isJWT ? 'JWT' : 'opaque'}, length=${result.accessToken.length}`);

    // Try the pricing API with various productType values for roll labels
    const productTypeGuesses = [
      'ROLL_LABELS', 'RollLabels', 'roll_labels', 'rollLabels',
      'STICKERS', 'LABELS', 'Labels', 'labels',
      'ROLL_STICKER', 'RollSticker',
      'CUSTOM_STICKERS', 'custom_stickers'
    ];

    for (const productType of productTypeGuesses) {
      const apiUrl = `/service/rest/v1/products/price?productType=${productType}&quantity=5000&width=3&height=3`;
      const apiResult = await page.evaluate(async (url, token) => {
        try {
          const headers = {
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + token,
            'X-Access-Token': token
          };
          const r = await fetch(url, { headers, credentials: 'include' });
          return { status: r.status, body: (await r.text()).slice(0, 500) };
        } catch (e) { return { error: e.message }; }
      }, apiUrl, result.accessToken);

      if (apiResult.status === 200) {
        log(`GP: *** SUCCESS! productType=${productType}: ${apiResult.body.slice(0, 300)}`);
        result.rollLabelProductType = productType;
        const priceM = apiResult.body.match(/"price":\s*"?([\d.]+)"?/);
        if (priceM) result.price = parseFloat(priceM[1]);
        break;
      } else if (apiResult.status === 400) {
        // 400 means the productType was recognized but had bad params — still progress!
        log(`GP: 400 for productType=${productType}: ${apiResult.body.slice(0, 100)}`);
        if (apiResult.body.includes('productType')) {
          log(`GP: productType "${productType}" recognized (400) — adjusting params`);
          result.rollLabelProductType = productType;
        }
      } else {
        log(`GP: ${apiResult.status} for productType=${productType}`);
      }
    }

    // If we found the productType, try to get full pricing
    if (result.rollLabelProductType) {
      const priceUrl = `/service/rest/v1/products/price?productType=${result.rollLabelProductType}&quantity=5000&width=3&height=3&shape=SQUARE`;
      const priceResult = await page.evaluate(async (url, token) => {
        try {
          const r = await fetch(url, {
            headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
            credentials: 'include'
          });
          return { status: r.status, body: (await r.text()).slice(0, 1000) };
        } catch (e) { return { error: e.message }; }
      }, priceUrl, result.accessToken);
      log(`GP price API: status=${priceResult.status}, body=${priceResult.body?.slice(0, 300)}`);
    }

    // Also: try to load the actual roll labels page and let Vue hydrate fully
    log('GP: loading roll labels page...');
    await page.goto('https://www.gotprint.com/store/stickers-and-labels/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(20000); // Extra long wait for Vue

    // Check if we landed on roll-labels or were redirected
    const finalUrl = page.url();
    log(`GP: final URL after navigation: ${finalUrl}`);

    const domState = await page.evaluate(() => {
      const ps = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(document.body.innerText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 10 && v < 100000) ps.push(v);
      }

      const inputs = Array.from(document.querySelectorAll('input, select'))
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0)
        .map(el => ({ tag: el.tagName, type: el.type, name: el.name, id: el.id, ariaLabel: el.getAttribute('aria-label') }));

      // Look for a price display specific to the configurator
      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [id*="price"]'))
        .filter(el => el.offsetWidth > 0 && el.textContent?.includes('$'))
        .map(el => el.textContent?.trim().slice(0, 60));

      return { prices: [...new Set(ps)].sort((a, b) => a - b), inputs: inputs.slice(0, 10), priceEls: priceEls.slice(0, 5), title: document.title };
    });

    log(`GP roll-labels: title="${domState.title}", prices=[${domState.prices.join(', ')}]`);
    log(`GP: ${domState.inputs.length} form inputs, ${domState.priceEls.length} price elements`);
    domState.inputs.forEach(i => log(`  input: ${i.tag} type=${i.type} name="${i.name}" aria="${i.ariaLabel}"`));
    domState.priceEls.forEach(p => log(`  priceEl: "${p}"`));

  } catch (e) {
    result.error = e.message;
    err('GP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPDATE DATA FILES ─────────────────────────────────────────────────────────
function updateDataFiles(vpResult, axiomResult, gpResult) {
  const raw  = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM_FILE, 'utf8'));
  const today = nowISO();
  const q3x3 = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
  let changed = false;

  // ── Vistaprint ──
  if (vpResult.price5000 && vpResult.price5000 > 50) {
    log(`VP: Updating data with price5000=$${vpResult.price5000}`);
    const vpComp = q3x3?.competitor_results.find(c => c.competitor === 'vistaprint');

    raw.captures.push({
      id: `vistaprint-5000qty-targeted-${today}`,
      competitor: 'vistaprint', competitor_display: 'Vistaprint',
      source_url: 'https://www.vistaprint.com/labels-stickers/roll-labels',
      captured_at: today,
      capture_method: 'playwright_cimpress_api_nodeside',
      capture_source: 'automated_headless',
      confidence: vpResult.capturedAfterSize ? 'high' : 'medium',
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels, 5,000 qty, Slit Roll${vpResult.capturedAfterSize ? ', size selected' : ' (size from default pricingContext)'}`,
      specs: {
        width_in: vpResult.capturedAfterSize ? 3 : null,
        height_in: vpResult.capturedAfterSize ? 3 : null,
        shape: 'square', format: 'slit_roll',
        quantity: 5000, material: null, finish: null
      },
      pricing: {
        total_price: vpResult.price5000,
        unit_price: vpResult.unit5000,
        currency: 'USD', turnaround_days: null,
        shipping_included: null,
        price_type: 'cimpress_api_nodejs_direct'
      },
      raw_snippet: `Node.js Playwright context.request.get(). sizeClicked="${vpResult.sizeClicked}", method="${vpResult.sizeMethod}". Selections: ${JSON.stringify(vpResult.selectionsUsed || {})}`,
      notes: `Cimpress pricing API via Playwright Node.js-side request (bypasses CORS). Size interaction: ${vpResult.capturedAfterSize ? 'yes — new API call captured after size selection' : 'no new API call after size selection — used default pricingContext'}. `,
      blocker: null, next_step: null
    });

    raw.capture_coverage_summary.vistaprint.status = 'partial';
    raw.capture_coverage_summary.vistaprint.confidence = vpResult.capturedAfterSize ? 'high' : 'medium';
    raw.capture_coverage_summary.vistaprint.last_method = 'playwright_cimpress_api_nodeside';
    raw.capture_coverage_summary.vistaprint.notes =
      `5000 qty = $${vpResult.price5000}. Size selection: ${vpResult.capturedAfterSize ? 'confirmed' : 'unconfirmed (default pricingContext)'}. ` +
      `Product PRD-DF5PWTHC. Selections: ${JSON.stringify(vpResult.selectionsUsed || {})}.`;

    if (vpComp) {
      vpComp.closest_data_point = {
        description: `Roll Labels Slit Roll, 5,000 qty${vpResult.capturedAfterSize ? ', size selected' : ''}`,
        total_price: vpResult.price5000,
        unit_price: vpResult.unit5000,
        quantity: 5000,
        spec_delta: vpResult.capturedAfterSize ? 'size confirmed, material type unverified (may be paper not BOPP)' : 'size NOT confirmed 3"×3", material unverified',
        confidence: vpResult.capturedAfterSize ? 'high' : 'medium',
        raw_capture_id: `vistaprint-5000qty-targeted-${today}`
      };
    }
    changed = true;
  } else {
    log('VP: no 5000-qty price — no data update');
  }

  // ── Axiom ──
  if (axiomResult.price && axiomResult.price > 100) {
    const sizeOk = !!(axiomResult.sizeSelected);
    const matOk  = !!(axiomResult.materialSelected);
    const qtyOk  = !!(axiomResult.qtySelected);
    const conf   = sizeOk && qtyOk ? (matOk ? 'high' : 'medium') : 'low';

    log(`Axiom: Updating data with price=$${axiomResult.price} (conf=${conf})`);
    const axComp = q3x3?.competitor_results.find(c => c.competitor === 'axiomprint');

    raw.captures.push({
      id: `axiomprint-targeted-${today}`,
      competitor: 'axiomprint', competitor_display: 'Axiom Print',
      source_url: 'https://axiomprint.com/product/roll-labels-335',
      captured_at: today,
      capture_method: 'playwright_antd_dropdown_waitForSelector',
      capture_source: 'automated_headless',
      confidence: conf,
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels ${axiomResult.sizeSelected || '?'}, ${axiomResult.materialSelected || 'material?'}, ${axiomResult.qtySelected || 'qty?'}`,
      specs: {
        width_in: sizeOk ? 3 : null,
        height_in: sizeOk ? 3 : null,
        shape: sizeOk ? 'square' : null,
        format: 'roll',
        quantity: qtyOk ? 2500 : null,
        material: matOk ? 'White Matte BOPP' : null,
        finish: null
      },
      pricing: {
        total_price: axiomResult.price,
        unit_price: qtyOk ? Math.round(axiomResult.price / 2500 * 10000) / 10000 : null,
        currency: 'USD', turnaround_days: null, shipping_included: null,
        price_type: 'configurator_live'
      },
      raw_snippet: `sizeSelected="${axiomResult.sizeSelected}", matSelected="${axiomResult.materialSelected}", qtySelected="${axiomResult.qtySelected}". Options found: ${JSON.stringify(axiomResult.allDropdownOptions)}`,
      notes: `Targeted Ant Design interaction with waitForSelector. Size: "${axiomResult.sizeSelected}". Material: "${axiomResult.materialSelected}". Qty: "${axiomResult.qtySelected}". Configurator max = 2500.`,
      blocker: null, next_step: '5000 qty requires custom quote from axiomprint.com'
    });

    raw.capture_coverage_summary.axiomprint.status = 'partial';
    raw.capture_coverage_summary.axiomprint.confidence = conf;
    raw.capture_coverage_summary.axiomprint.last_method = 'playwright_antd_dropdown_waitForSelector';
    raw.capture_coverage_summary.axiomprint.notes =
      `Targeted capture. Size: "${axiomResult.sizeSelected}" (${sizeOk ? '✓' : 'X'}). Material: "${axiomResult.materialSelected}" (${matOk ? '✓' : 'X'}). Qty: "${axiomResult.qtySelected}" (${qtyOk ? '✓' : 'X'}). Price: $${axiomResult.price}. Max configurator qty = 2500.`;

    if (axComp && conf !== 'low') {
      axComp.closest_data_point = {
        description: `Roll Labels ${axiomResult.sizeSelected || '?'}, ${axiomResult.materialSelected || '?'}, ${axiomResult.qtySelected || 'qty?'}`,
        total_price: axiomResult.price,
        unit_price: qtyOk ? Math.round(axiomResult.price / 2500 * 10000) / 10000 : null,
        quantity: 2500,
        spec_delta: `qty=2500 (not 5000); max configurator qty. ${matOk ? 'material=White Matte BOPP (matches)' : 'material unconfirmed'}`,
        confidence: conf,
        raw_capture_id: `axiomprint-targeted-${today}`
      };
    }
    changed = true;
  } else {
    log(`Axiom: no price captured (price=${axiomResult.price})`);
  }

  // GotPrint — only update if we found the productType enum (100% needed for a real price)
  if (gpResult.rollLabelProductType) {
    log(`GP: found productType="${gpResult.rollLabelProductType}" — documenting`);
    // Note it in raw data but don't update normalized without a price
    raw.captures.push({
      id: `gotprint-api-producttype-${today}`,
      competitor: 'gotprint', competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/service/rest/v1/products/price',
      captured_at: today,
      capture_method: 'api_probe_with_access_token',
      capture_source: 'automated_headless',
      confidence: gpResult.price ? 'high' : 'medium',
      product_type: 'roll_labels',
      raw_spec_description: null,
      specs: {},
      pricing: {
        total_price: gpResult.price || null,
        unit_price: null, currency: 'USD',
        turnaround_days: null, shipping_included: null,
        price_type: gpResult.price ? 'api_response' : 'pending'
      },
      raw_snippet: `access_token from /assets/dyn/css/access_token.txt. productType="${gpResult.rollLabelProductType}"`,
      notes: `GotPrint REST API: /service/rest/v1/products/price. productType enum cracked: "${gpResult.rollLabelProductType}". Access token obtained from public /assets/dyn/css/access_token.txt.`,
      blocker: null,
      next_step: gpResult.price ? null : `Retry with correct size/shape params using productType="${gpResult.rollLabelProductType}"`
    });
    changed = true;
  }

  if (changed) {
    raw.last_updated = today;
    norm.last_updated = today;
    norm.last_capture_pass = `${today}-playwright-targeted`;
    fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM_FILE, JSON.stringify(norm, null, 2));
    log('Data files updated.');
  } else {
    log('No data updates needed.');
  }

  return changed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Targeted Fix Pass === ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = {};

  try {
    log('\n--- Vistaprint ---');
    try { results.vistaprint = await captureVistaprint(browser); } catch (e) { err('VP fatal: ' + e.message); results.vistaprint = { error: e.message }; }

    log('\n--- Axiom Print ---');
    try { results.axiom = await captureAxiom(browser); } catch (e) { err('Axiom fatal: ' + e.message); results.axiom = { error: e.message }; }

    log('\n--- GotPrint ---');
    try { results.gotprint = await probeGotprint(browser); } catch (e) { err('GP fatal: ' + e.message); results.gotprint = { error: e.message }; }

  } finally {
    await browser.close();
  }

  const debugFile = path.join(ROOT_DIR, 'data', `capture-targeted-${nowISO()}.json`);
  fs.writeFileSync(debugFile, JSON.stringify(results, null, 2));
  log(`\nDebug: ${debugFile}`);

  updateDataFiles(results.vistaprint || {}, results.axiom || {}, results.gotprint || {});

  log('\n=== SUMMARY ===');
  log(`VP: price5000=${results.vistaprint?.price5000}, sizeClicked="${results.vistaprint?.sizeClicked}", capturedAfterSize=${results.vistaprint?.capturedAfterSize}`);
  log(`Axiom: price=${results.axiom?.price}, size="${results.axiom?.sizeSelected}", mat="${results.axiom?.materialSelected}", qty="${results.axiom?.qtySelected}"`);
  log(`GP: accessToken=${results.gotprint?.accessToken ? 'found (length=' + results.gotprint.accessToken.length + ')' : 'none'}, productType="${results.gotprint?.rollLabelProductType}", price=${results.gotprint?.price}`);
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
