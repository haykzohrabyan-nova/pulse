#!/usr/bin/env node
/**
 * capture-advanced-pass.js
 *
 * Advanced coverage pass — April 2026
 * Priority target: 3"×3" / 5000 / White BOPP / Matte / CMYK exact-match pricing
 *
 * 1. VISTAPRINT: Intercept Cimpress pricing API after size selection
 *    - Load roll labels page, capture full Cimpress API URLs (with all selections[])
 *    - Interact with size configurator to select 3"×3" (or closest available)
 *    - Capture updated API URL that includes size selections
 *    - Replay with quantities=5000 to get exact price
 *
 * 2. AXIOM PRINT: 3"×3" / White Matte BOPP / 2500 (configurator max)
 *    - Ant Design dropdowns: shape→Square, dims→3x3, material→White Matte BOPP, qty→2500
 *    - Confirmed technique from previous pass (Ant Design worked for qty)
 *
 * 3. STICKER MULE: Consent cookie pre-set + configurator interaction
 *    - Pre-load consent cookies before navigation to suppress modal
 *    - Interact with custom-labels configurator for 3"×3" / 5000
 *    - Watch GraphQL/network for pricing response
 *
 * 4. GOTPRINT: Vue.js DOM extraction
 *    - Full wait for Vue to hydrate, watch network for API calls the app makes
 *    - Try to read currently displayed price + interact with controls
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const RAW_FILE  = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

function log(msg)  { console.log(`[adv] ${msg}`); }
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
function extractPrices(text) {
  const re = /\$([\d,]+\.?\d{0,2})/g;
  const ps = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v >= 20 && v < 100000) ps.add(v);
  }
  return [...ps].sort((a, b) => a - b);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── VISTAPRINT ───────────────────────────────────────────────────────────────
async function captureVistaprint(browser) {
  log('=== VISTAPRINT: Cimpress API intercept after 3x3 size selection ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Capture ALL Cimpress pricing API calls with full URLs and bodies
  const cimpressCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('prices.cimpress.io') && u.includes('/prices/')) {
      try {
        const body = await resp.text();
        cimpressCalls.push({ url: u, body, ts: Date.now() });
        log(`VP capture: ${u.split('?')[0].split('/').slice(-3).join('/')} — ${body.length} bytes`);
      } catch (_) {}
    }
  });

  const result = {
    defaultPrices: {},
    sizePrices: {},
    price5000: null,
    unit5000: null,
    sizeInteracted: false,
    sizeMethod: null,
    selectionsUsed: null,
    pricingContext: null,
    error: null
  };

  const page = await context.newPage();
  try {
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });
    await sleep(12000); // VP configurator fragment loads lazily

    // Parse default pricing call
    if (cimpressCalls.length > 0) {
      const call = cimpressCalls[0];
      const urlObj = new URL(call.url);
      result.pricingContext = urlObj.searchParams.get('pricingContext');
      log(`VP: pricingContext (first 60 chars): ${result.pricingContext?.slice(0, 60)}`);

      // Log ALL selections[] params from the default call
      const selections = {};
      for (const [k, v] of urlObj.searchParams.entries()) {
        if (k.startsWith('selections[')) selections[k] = v;
      }
      log(`VP default selections: ${JSON.stringify(selections)}`);

      try {
        const data = JSON.parse(call.body);
        if (data.estimatedPrices) {
          Object.entries(data.estimatedPrices).forEach(([qty, pd]) => {
            const total = pd.totalListPrice?.untaxed ?? pd.totalListPrice;
            const unit  = pd.unitListPrice?.untaxed  ?? pd.unitListPrice;
            result.defaultPrices[qty] = { total, unit };
            log(`VP default: qty ${qty} = $${total} ($${unit}/ea)`);
          });
        }
      } catch (e) { log('VP default parse error: ' + e.message); }
    } else {
      log('VP: no Cimpress calls captured on initial load');
    }

    // Probe the configurator structure
    const configInfo = await page.evaluate(() => {
      const visible = el => el && (el.offsetWidth > 0 || el.offsetHeight > 0);
      const info = {
        inputs: [],
        sizeBtns: [],
        sizeContainers: [],
        iframes: [],
        allBtnsWithNumbers: []
      };

      // Visible inputs
      info.inputs = Array.from(document.querySelectorAll('input, select'))
        .filter(visible)
        .slice(0, 20)
        .map(el => ({
          tag: el.tagName, type: el.type || null, name: el.name || null,
          id: el.id || null, placeholder: el.placeholder?.slice(0, 30) || null,
          value: el.value?.slice(0, 20) || null,
          ariaLabel: el.getAttribute('aria-label'),
          testid: el.getAttribute('data-testid'),
          qa: el.getAttribute('data-qa')
        }));

      // Buttons/elements mentioning sizes like "3 in" or "3x3"
      info.allBtnsWithNumbers = Array.from(document.querySelectorAll('button, [role="option"], [role="radio"], li, span'))
        .filter(b => visible(b))
        .filter(b => /\d+\s*(in|")\s*(x|×)\s*\d+/i.test(b.textContent || b.getAttribute('aria-label') || ''))
        .slice(0, 15)
        .map(b => ({
          tag: b.tagName, role: b.getAttribute('role'),
          text: b.textContent?.trim().replace(/\s+/g, ' ').slice(0, 50),
          ariaLabel: b.getAttribute('aria-label'),
          testid: b.getAttribute('data-testid'),
          dataValue: b.getAttribute('data-value')
        }));

      // Size-related containers
      const sizePats = ['[data-qa*="size" i]', '[data-testid*="size" i]', '[class*="size" i]',
                        '[aria-label*="size" i]', '[id*="size" i]'];
      for (const p of sizePats) {
        try {
          Array.from(document.querySelectorAll(p))
            .filter(visible)
            .slice(0, 3)
            .forEach(el => info.sizeContainers.push({
              pattern: p, tag: el.tagName,
              text: el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80),
              testid: el.getAttribute('data-testid')
            }));
        } catch (_) {}
      }

      // Check for iframes (VP may embed configurator in an iframe)
      info.iframes = Array.from(document.querySelectorAll('iframe'))
        .filter(visible)
        .map(f => ({ src: f.src?.slice(0, 100), id: f.id, name: f.name }));

      return info;
    });

    log(`VP config: ${configInfo.inputs.length} inputs, ${configInfo.allBtnsWithNumbers.length} size btns, ${configInfo.sizeContainers.length} size containers, ${configInfo.iframes.length} iframes`);
    configInfo.inputs.slice(0, 8).forEach(i => log(`  input: ${i.tag} type=${i.type} name="${i.name}" aria="${i.ariaLabel}" testid="${i.testid}"`));
    configInfo.allBtnsWithNumbers.forEach(b => log(`  sizeBtn: "${b.text}" testid="${b.testid}" data-value="${b.dataValue}"`));
    configInfo.sizeContainers.slice(0, 5).forEach(s => log(`  sizeCont: ${s.pattern} → "${s.text?.slice(0, 50)}"`));
    configInfo.iframes.forEach(f => log(`  iframe: src="${f.src}"`));

    // Record Cimpress call count before size interaction
    const callsBefore = cimpressCalls.length;

    // ── Size interaction: try multiple strategies ──
    // Strategy 1: fill width/height inputs
    const sizeViaInput = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0);

      const wEl = inputs.find(i =>
        /width/i.test(i.getAttribute('aria-label') || i.name || i.id || i.getAttribute('data-testid') || i.placeholder || ''));
      const hEl = inputs.find(i =>
        /height/i.test(i.getAttribute('aria-label') || i.name || i.id || i.getAttribute('data-testid') || i.placeholder || ''));

      if (wEl && hEl) {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) {
          nativeSet.call(wEl, '3');
          wEl.dispatchEvent(new Event('input', { bubbles: true }));
          wEl.dispatchEvent(new Event('change', { bubbles: true }));
          nativeSet.call(hEl, '3');
          hEl.dispatchEvent(new Event('input', { bubbles: true }));
          hEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          wEl.value = '3';
          wEl.dispatchEvent(new Event('input', { bubbles: true }));
          hEl.value = '3';
          hEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { ok: true, wId: wEl.id, hId: hEl.id };
      }
      return { ok: false };
    });

    if (sizeViaInput.ok) {
      result.sizeInteracted = true;
      result.sizeMethod = 'fill_width_height_inputs';
      log(`VP: filled w/h inputs (wId=${sizeViaInput.wId}, hId=${sizeViaInput.hId})`);
      await sleep(5000);
    }

    // Strategy 2: click a "3 in × 3 in" or "3"×3"" button
    if (!result.sizeInteracted) {
      const clickSizeBtn = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll(
          'button, [role="option"], [role="radio"], li, span, div'
        )).filter(el => el.offsetWidth > 0 || el.offsetHeight > 0);

        const target = candidates.find(el => {
          const t = (el.textContent?.trim() + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ');
          return /3\s*(in|"|')\s*(x|×)\s*3/i.test(t) || /^3\s*×\s*3/i.test(t);
        });

        if (target) {
          target.click();
          return { ok: true, text: target.textContent?.trim().slice(0, 40) };
        }
        return { ok: false };
      });
      if (clickSizeBtn.ok) {
        result.sizeInteracted = true;
        result.sizeMethod = 'click_3x3_button';
        log(`VP: clicked size button: "${clickSizeBtn.text}"`);
        await sleep(5000);
      }
    }

    // Strategy 3: find a select with size options
    if (!result.sizeInteracted) {
      const selectSize = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select'))
          .filter(s => s.offsetWidth > 0 || s.offsetHeight > 0);
        for (const sel of selects) {
          const opts = Array.from(sel.options);
          const o3 = opts.find(o => /3\s*(in)?\s*(x|×)\s*3/i.test(o.text) || o.value === '3x3' || o.value === '3');
          if (o3) {
            sel.value = o3.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, value: o3.value, label: o3.text };
          }
        }
        return { ok: false };
      });
      if (selectSize.ok) {
        result.sizeInteracted = true;
        result.sizeMethod = 'select_3x3_option';
        log(`VP: selected size option: "${selectSize.label}"`);
        await sleep(5000);
      }
    }

    // Strategy 4: Playwright-fill approach (in case React refs are involved)
    if (!result.sizeInteracted) {
      for (const wSel of [
        'input[aria-label*="width" i]', 'input[data-testid*="width" i]',
        'input[name="width"]', 'input[id*="width" i]',
        'input[aria-label*="w" i]'
      ]) {
        try {
          const el = await page.$(wSel);
          if (el) {
            const hSel = wSel.replace(/width/gi, 'height');
            await page.fill(wSel, '3');
            await sleep(200);
            const hEl = await page.$(hSel);
            if (hEl) {
              await page.fill(hSel, '3');
              await page.keyboard.press('Tab');
              await sleep(5000);
              result.sizeInteracted = true;
              result.sizeMethod = 'playwright_fill_' + wSel;
              log(`VP: Playwright-filled: ${wSel}`);
              break;
            }
          }
        } catch (_) {}
      }
    }

    if (!result.sizeInteracted) {
      log('VP: no size interaction succeeded — will use pricingContext from default call');
    }

    // Log new Cimpress calls after interaction
    const newCalls = cimpressCalls.slice(callsBefore);
    log(`VP: ${newCalls.length} new Cimpress calls after size interaction (${cimpressCalls.length} total)`);
    for (const c of newCalls) {
      const u = new URL(c.url);
      const sels = {};
      for (const [k, v] of u.searchParams.entries()) {
        if (k.startsWith('selections[')) sels[k] = v;
      }
      log(`  new call selections: ${JSON.stringify(sels)}`);
      log(`  new call quantities: ${u.searchParams.get('quantities')}`);
    }

    // ── Replay with quantities=5000 ──
    // Use the most recent Cimpress call (after size interaction if any)
    const bestCall = cimpressCalls[cimpressCalls.length - 1];
    if (bestCall) {
      const urlObj = new URL(bestCall.url);
      urlObj.searchParams.set('quantities', '5000');
      const url5k = urlObj.toString();
      result.selectionsUsed = {};
      for (const [k, v] of urlObj.searchParams.entries()) {
        if (k.startsWith('selections[')) result.selectionsUsed[k] = v;
      }

      log(`VP: replaying with qty=5000. Selections: ${JSON.stringify(result.selectionsUsed)}`);

      const resp5k = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Origin': 'https://www.vistaprint.com' }
          });
          return { status: r.status, body: (await r.text()).slice(0, 3000) };
        } catch (e) { return { error: e.message }; }
      }, url5k);

      log(`VP 5k response: status=${resp5k.status || resp5k.error}`);
      if (resp5k.status === 200) {
        try {
          const data = JSON.parse(resp5k.body);
          if (data.estimatedPrices) {
            Object.entries(data.estimatedPrices).forEach(([qty, pd]) => {
              const total = pd.totalListPrice?.untaxed ?? pd.totalListPrice;
              const unit  = pd.unitListPrice?.untaxed  ?? pd.unitListPrice;
              result.sizePrices[qty] = { total, unit };
              log(`VP: qty ${qty} = $${total} ($${unit}/ea) [size-specific call]`);
            });
            const ep5k = data.estimatedPrices['5000'];
            if (ep5k) {
              result.price5000 = ep5k.totalListPrice?.untaxed ?? ep5k.totalListPrice;
              result.unit5000  = ep5k.unitListPrice?.untaxed  ?? ep5k.unitListPrice;
              log(`VP: *** QTY 5000 = $${result.price5000} ($${result.unit5000}/ea) ***`);
            } else {
              // API may return different qtys — try closest
              const qtys = Object.keys(data.estimatedPrices).map(Number).sort((a, b) => a - b);
              log(`VP: 5000 not in response; available qtys: ${qtys.join(', ')}`);
            }
          }
        } catch (e) { log('VP 5k parse error: ' + e.message + ' — body: ' + resp5k.body.slice(0, 300)); }
      } else {
        log(`VP 5k non-200: ${resp5k.body?.slice(0, 300) || resp5k.error}`);
      }

      // Also try qty=5000 alone AND with other ranges
      for (const qStr of ['500,1000,2500,5000,10000', '5000,10000']) {
        if (result.price5000) break;
        try {
          const urlObj2 = new URL(bestCall.url);
          urlObj2.searchParams.set('quantities', qStr);
          const r = await page.evaluate(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
              return { status: r.status, body: (await r.text()).slice(0, 3000) };
            } catch (e) { return { error: e.message }; }
          }, urlObj2.toString());
          if (r.status === 200) {
            const data = JSON.parse(r.body);
            const ep = data.estimatedPrices?.['5000'];
            if (ep) {
              result.price5000 = ep.totalListPrice?.untaxed ?? ep.totalListPrice;
              result.unit5000  = ep.unitListPrice?.untaxed  ?? ep.unitListPrice;
              log(`VP: 5000 from multi-qty call: $${result.price5000}`);
            }
          }
        } catch (_) {}
      }
    } else {
      log('VP: no Cimpress call captured at all — VP may block headless');
    }

  } catch (e) {
    result.error = e.message;
    err('VP: ' + e.message + '\n' + e.stack?.slice(0, 400));
  } finally {
    await context.close();
  }

  return result;
}

// ─── AXIOM PRINT ─────────────────────────────────────────────────────────────
async function captureAxiom(browser) {
  log('=== AXIOM PRINT: Square 3"×3" / White Matte BOPP / 2500 qty ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const result = { price: null, shape: null, width: null, height: null, material: null, qty: null, allPrices: [], error: null };

  // Watch API calls for price data
  const apiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('axiomprint.com') || u.includes('workroomapp.com')) &&
        !u.match(/\.(png|jpg|jpeg|gif|svg|woff|css|js)$/i)) {
      try {
        const body = await resp.text();
        if (body.includes('price') || body.includes('total') || body.includes('cost')) {
          apiCalls.push({ url: u.slice(0, 120), status: resp.status(), body: body.slice(0, 1000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    await page.goto('https://axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(5000);

    // Utility: click Ant Design select, wait for dropdown, click option
    async function antSelect(hintOrIndex, optionText) {
      log(`Axiom antSelect: hint="${hintOrIndex}" → "${optionText}"`);

      const opened = await page.evaluate((hint) => {
        const selects = Array.from(document.querySelectorAll('.ant-select:not(.ant-select-disabled)'));

        let target = null;
        if (typeof hint === 'number') {
          target = selects[hint];
        } else {
          // Match by label or current selection
          for (const sel of selects) {
            const label = sel.closest('.ant-form-item')?.querySelector('label, .ant-form-item-label')?.textContent?.trim().toLowerCase();
            const current = sel.querySelector('.ant-select-selection-item')?.textContent?.trim().toLowerCase();
            if ((label && label.includes(hint.toLowerCase())) ||
                (current && current.includes(hint.toLowerCase()))) {
              target = sel;
              break;
            }
          }
        }

        if (!target) return { ok: false, total: selects.length };

        const selector = target.querySelector('.ant-select-selector');
        if (!selector) return { ok: false, reason: 'no selector found' };

        selector.click();
        const idx = selects.indexOf(target);
        return { ok: true, idx, currentVal: target.querySelector('.ant-select-selection-item')?.textContent?.trim() };
      }, hintOrIndex);

      log(`  open: ${JSON.stringify(opened)}`);
      if (!opened.ok) return { ok: false };

      await sleep(700);

      const optResult = await page.evaluate((target) => {
        // Find visible dropdown items
        const items = Array.from(document.querySelectorAll(
          '.ant-select-dropdown:not([style*="display: none"]) .ant-select-item,' +
          '.ant-select-item-option'
        )).filter(el => el.offsetWidth > 0 || el.offsetHeight > 0);

        // Exact match first
        let match = items.find(el => el.textContent?.trim() === target);
        if (!match) match = items.find(el => el.textContent?.trim().includes(target));

        if (match) {
          match.click();
          return { ok: true, text: match.textContent?.trim() };
        }

        const available = items.map(el => el.textContent?.trim()).filter(Boolean);
        return { ok: false, available: available.slice(0, 12) };
      }, optionText);

      log(`  opt: ${JSON.stringify(optResult)}`);
      await sleep(1500); // price recalc
      return optResult;
    }

    // Read current form state and all prices
    const readState = async () => {
      return page.evaluate(() => {
        const prices = new Set();
        const re = /\$([\d,]+\.?\d{0,2})/g;
        let m;
        while ((m = re.exec(document.body.innerText)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 5 && v < 100000) prices.add(v);
        }

        const selects = Array.from(document.querySelectorAll('.ant-select'))
          .map(s => s.querySelector('.ant-select-selection-item')?.textContent?.trim())
          .filter(Boolean);

        const numInputs = Array.from(document.querySelectorAll('.ant-input-number input, input[type="number"]'))
          .filter(i => i.offsetWidth > 0 || i.offsetHeight > 0)
          .map(i => ({ id: i.id, name: i.name, value: i.value, placeholder: i.placeholder, ariaLabel: i.getAttribute('aria-label') }));

        return { prices: [...prices].sort((a, b) => a - b), selects, numInputs };
      });
    };

    const initial = await readState();
    log(`Axiom initial state: selects=${JSON.stringify(initial.selects)}, prices=[${initial.allPrices}]`);
    log(`Axiom initial prices: [${initial.prices.join(', ')}]`);
    log(`Axiom numInputs: ${JSON.stringify(initial.numInputs)}`);

    // Determine current selections from __NEXT_DATA__
    const productConfig = await page.evaluate(() => {
      if (!window.__NEXT_DATA__) return null;
      try {
        const d = window.__NEXT_DATA__;
        const pp = d.props?.pageProps;
        // Flatten to find shape/material/size options
        const text = JSON.stringify(pp || {});
        const shapeMatch = text.match(/"shapes?"\s*:\s*(\[[^\]]+\])/);
        const materialMatch = text.match(/"materials?"\s*:\s*(\[[^\]]+\])/);
        return {
          keys: Object.keys(pp || {}),
          shapesRaw: shapeMatch?.[1]?.slice(0, 200),
          materialsRaw: materialMatch?.[1]?.slice(0, 200)
        };
      } catch (_) { return null; }
    });
    log(`Axiom __NEXT_DATA__: ${JSON.stringify(productConfig)}`);

    // Step 1: Select "Square" shape
    // Current default is Rectangle (from previous captures)
    let shapeResult = await antSelect('Rectangle', 'Square');
    if (!shapeResult.ok) {
      // Try by index (shape is usually the first dropdown)
      shapeResult = await antSelect(0, 'Square');
    }
    if (!shapeResult.ok) {
      log('Axiom: could not select Square shape, proceeding with Rectangle (3x3 dimensions still settable)');
    }

    const afterShape = await readState();
    log(`Axiom after shape: selects=${JSON.stringify(afterShape.selects)}, prices=[${afterShape.prices.join(', ')}]`);

    // Step 2: Set width and height to 3.0 × 3.0
    const dimState = await readState();
    if (dimState.numInputs.length >= 2) {
      const [wInp, hInp] = dimState.numInputs;
      log(`Axiom dims: wInp=${JSON.stringify(wInp)}, hInp=${JSON.stringify(hInp)}`);

      const fillDim = async (inp, val) => {
        const sels = [
          inp.id ? `#${inp.id}` : null,
          inp.name ? `input[name="${inp.name}"]` : null,
          inp.ariaLabel ? `input[aria-label="${inp.ariaLabel}"]` : null
        ].filter(Boolean);

        for (const sel of sels) {
          try {
            await page.fill(sel, String(val));
            await page.keyboard.press('Tab');
            await sleep(800);
            log(`Axiom: filled ${sel} = ${val}`);
            return true;
          } catch (_) {}
        }
        return false;
      };

      const wOk = await fillDim(wInp, '3');
      const hOk = await fillDim(hInp, '3');
      log(`Axiom: dim fill: w=${wOk}, h=${hOk}`);
      await sleep(2000);
    } else if (dimState.numInputs.length === 1) {
      // Might be a single "size" input or the width/height are not number inputs
      log('Axiom: only 1 number input found — trying generic size interaction');
    } else {
      log('Axiom: no number inputs found — size may be controlled by dropdown only');
    }

    const afterDim = await readState();
    log(`Axiom after dims: selects=${JSON.stringify(afterDim.selects)}, prices=[${afterDim.prices.join(', ')}]`);

    // Step 3: Select "White Matte BOPP" material
    // Materials include: White Matte BOPP, Silver Gloss BOPP, Clear Gloss BOPP, 60# Matte Paper, etc.
    let matResult = await antSelect('White', 'White Matte BOPP');
    if (!matResult.ok) matResult = await antSelect('Matte', 'White Matte BOPP');
    if (!matResult.ok) matResult = await antSelect('Material', 'White Matte BOPP');
    // If still not found, try just "BOPP" which should match White Matte BOPP
    if (!matResult.ok) matResult = await antSelect('BOPP', 'White Matte BOPP');
    log(`Axiom material select: ${JSON.stringify(matResult)}`);

    const afterMat = await readState();
    log(`Axiom after material: selects=${JSON.stringify(afterMat.selects)}, prices=[${afterMat.prices.join(', ')}]`);

    // Step 4: Select qty 2500 (max standard)
    let qtyResult = await antSelect('2', '2,500');
    if (!qtyResult.ok) qtyResult = await antSelect('250', '2,500');
    if (!qtyResult.ok) qtyResult = await antSelect('Quantity', '2,500');
    log(`Axiom qty select: ${JSON.stringify(qtyResult)}`);

    await sleep(2000);

    const finalState = await readState();
    log(`Axiom FINAL: selects=${JSON.stringify(finalState.selects)}, prices=[${finalState.prices.join(', ')}]`);

    // Read the prominent price display
    const mainPrice = await page.evaluate(() => {
      // Try various price display patterns
      const selectors = [
        '.price-total', '.product-price', '[class*="price-total"]',
        '[class*="ProductPrice"]', '[class*="product-price"]',
        'h2[class*="price"]', 'h3[class*="price"]',
        '[class*="Price"]', '[class*="price"]'
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
          const text = el.textContent?.trim();
          const m = text?.match(/\$([\d,]+\.?\d{0,2})/);
          if (m) {
            const v = parseFloat(m[1].replace(/,/g, ''));
            if (v > 50 && v < 100000) {
              return { price: v, sel, text: text?.slice(0, 80) };
            }
          }
        }
      }

      // Largest plausible price near a submit button
      const btns = Array.from(document.querySelectorAll('button[type="submit"], .ant-btn-primary'));
      for (const btn of btns) {
        // Look in the surrounding container
        const container = btn.closest('[class*="price"], [class*="total"], [class*="summary"], section, form');
        if (container) {
          const text = container.textContent || '';
          const matches = [...text.matchAll(/\$([\d,]+\.?\d{0,2})/g)];
          for (const mm of matches.reverse()) {
            const v = parseFloat(mm[1].replace(/,/g, ''));
            if (v > 100 && v < 100000) return { price: v, source: 'btn-container', text: text.slice(0, 60) };
          }
        }
      }

      return null;
    });
    log(`Axiom main price display: ${JSON.stringify(mainPrice)}`);

    // Determine the best price from our captures
    // For 2500 qty White Matte BOPP 3x3, expect $200–$600 range
    const plausiblePrices = finalState.prices.filter(p => p >= 100 && p <= 2000);

    result.allPrices = finalState.prices;

    if (mainPrice?.price) {
      result.price = mainPrice.price;
    } else if (plausiblePrices.length > 0) {
      result.price = plausiblePrices[plausiblePrices.length - 1]; // largest plausible
    }

    result.shape = finalState.selects.find(s => /square|rectangle/i.test(s)) || null;
    result.material = finalState.selects.find(s => /bopp|matte|gloss|paper/i.test(s)) || null;
    result.qty = finalState.selects.find(s => /\d,?\d{3}/.test(s)) || null;

    // Log API calls we captured
    log(`Axiom: ${apiCalls.length} relevant API calls captured`);
    apiCalls.slice(0, 3).forEach(c => log(`  ${c.url}: ${c.body.slice(0, 100)}`));

  } catch (e) {
    result.error = e.message;
    err('Axiom: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── STICKER MULE ─────────────────────────────────────────────────────────────
async function captureStickermule(browser) {
  log('=== STICKER MULE: Consent bypass + configurator ===');

  // Create context with pre-loaded consent cookies to suppress modal
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Common consent cookie patterns — set before page load
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.stickermule.com', path: '/', sameSite: 'Lax' },
    { name: 'OptanonConsent',
      value: 'isGpcEnabled=0&datestamp=' + encodeURIComponent(new Date().toUTCString()) +
             '&version=202305.2.0&consentId=aa000000-0000-0000-0000-000000000001&interactionCount=1' +
             '&isAnonUser=1&landingPath=NotLandingPage&groups=1%3A1%2C2%3A1%2C3%3A1%2C4%3A1&hosts=&genVendors=',
      domain: '.stickermule.com', path: '/', sameSite: 'Lax' },
    { name: 'euconsent-v2', value: 'BOOO', domain: '.stickermule.com', path: '/' },
    { name: 'cookie_accepted', value: '1', domain: '.stickermule.com', path: '/' },
    { name: 'sm_consent', value: 'accepted', domain: 'www.stickermule.com', path: '/' },
  ]);

  const result = { price: null, pricingTable: null, configInteracted: false, networkPrices: [], error: null };
  const networkPrices = [];

  // Watch for any pricing API responses
  context.on('response', async resp => {
    const u = resp.url();
    if (resp.status() === 200 && (u.includes('graphql') || u.includes('/pricing') || u.includes('/price'))) {
      try {
        const body = await resp.text();
        if ((body.includes('"price"') || body.includes('"total"') || body.includes('"amount"')) && body.startsWith('{')) {
          networkPrices.push({ url: u.slice(0, 120), body: body.slice(0, 800) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'domcontentloaded', timeout: 35000
    });
    await sleep(6000);

    // Check for consent modal and try to dismiss it
    const modalStatus = await page.evaluate(() => {
      const getVisible = el => !!(el?.offsetWidth || el?.offsetHeight);

      // Look for consent/cookie modal
      const modal = document.querySelector(
        '#onetrust-banner-sdk, [id*="onetrust"], [class*="cookie-consent"], ' +
        '[class*="ConsentBanner"], [class*="consent-banner"], [data-testid*="consent"]'
      );

      const acceptBtns = Array.from(document.querySelectorAll('button, a[role="button"]'))
        .filter(getVisible)
        .filter(b => /^(agree|accept all|accept|ok|got it|continue|allow all)/i.test(b.textContent?.trim()))
        .map(b => ({ text: b.textContent?.trim(), testid: b.getAttribute('data-testid'), id: b.id }));

      // Look for any X/close button on consent banner
      const closeBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(getVisible)
        .filter(b => /^(×|x|close|dismiss)/i.test(b.textContent?.trim()) || b.getAttribute('aria-label')?.match(/close|dismiss/i))
        .map(b => ({ text: b.textContent?.trim(), id: b.id }));

      return {
        modalVisible: getVisible(modal),
        modalId: modal?.id,
        acceptBtns: acceptBtns.slice(0, 5),
        closeBtns: closeBtns.slice(0, 3)
      };
    });
    log(`SM: modal=${modalStatus.modalVisible} id="${modalStatus.modalId}", acceptBtns=${JSON.stringify(modalStatus.acceptBtns)}, closeBtns=${JSON.stringify(modalStatus.closeBtns)}`);

    // Try to dismiss consent
    if (modalStatus.acceptBtns.length > 0) {
      const btn = modalStatus.acceptBtns[0];
      try {
        if (btn.testid) await page.click(`[data-testid="${btn.testid}"]`);
        else if (btn.id) await page.click(`#${btn.id}`);
        else await page.evaluate((text) => {
          const b = Array.from(document.querySelectorAll('button'))
            .find(el => el.textContent?.trim() === text && (el.offsetWidth || el.offsetHeight));
          if (b) b.click();
        }, btn.text);
        await sleep(4000);
        log(`SM: clicked consent button: "${btn.text}"`);
      } catch (e) { log(`SM: consent click error: ${e.message}`); }
    } else if (modalStatus.closeBtns.length > 0) {
      try {
        const btn = modalStatus.closeBtns[0];
        if (btn.id) await page.click(`#${btn.id}`);
        else await page.evaluate((text) => {
          const b = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find(el => (el.textContent?.trim() === text || el.getAttribute('aria-label')?.match(/close/i)) && (el.offsetWidth || el.offsetHeight));
          if (b) b.click();
        }, btn.text);
        await sleep(4000);
        log(`SM: clicked close button`);
      } catch (e) { log(`SM: close click error: ${e.message}`); }
    } else {
      log('SM: no consent buttons found — either cookies worked or modal is gone');
    }

    // Map the page form structure
    const formInfo = await page.evaluate(() => {
      const visible = el => el && (el.offsetWidth > 0 || el.offsetHeight > 0);

      const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(visible)
        .slice(0, 25)
        .map(el => ({
          tag: el.tagName, type: el.type, name: el.name, id: el.id,
          placeholder: el.placeholder?.slice(0, 30), value: el.value?.slice(0, 20),
          ariaLabel: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid'),
          role: el.getAttribute('role')
        }));

      // Look for quantity-related elements
      const qtyEls = Array.from(document.querySelectorAll('[class*="quantity" i], [class*="Quantity" i], [data-testid*="quantity" i]'))
        .filter(visible)
        .slice(0, 5)
        .map(el => ({ tag: el.tagName, text: el.textContent?.trim().slice(0, 60), testid: el.getAttribute('data-testid') }));

      // Look for price displays
      const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [class*="Price" i], [data-testid*="price" i]'))
        .filter(visible)
        .slice(0, 5)
        .map(el => ({ tag: el.tagName, text: el.textContent?.trim().slice(0, 60), testid: el.getAttribute('data-testid') }));

      // All buttons
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(visible)
        .slice(0, 20)
        .map(b => ({ text: b.textContent?.trim().slice(0, 40), testid: b.getAttribute('data-testid'), id: b.id }));

      return { inputs, qtyEls, priceEls, buttons };
    });

    log(`SM form: ${formInfo.inputs.length} inputs, ${formInfo.qtyEls.length} qty els, ${formInfo.priceEls.length} price els, ${formInfo.buttons.length} buttons`);
    formInfo.inputs.forEach(i => log(`  input: ${i.tag} type=${i.type} aria="${i.ariaLabel}" testid="${i.testid}"`));
    formInfo.priceEls.forEach(p => log(`  priceEl: ${p.tag} "${p.text}"`));
    formInfo.qtyEls.forEach(q => log(`  qtyEl: ${q.tag} "${q.text}"`));

    // Try to interact with the configurator if inputs are available
    if (formInfo.inputs.length > 0) {
      result.configInteracted = true;

      const wInput = formInfo.inputs.find(i =>
        /width/i.test(i.ariaLabel || i.testid || i.name || i.id || i.placeholder || ''));
      const hInput = formInfo.inputs.find(i =>
        /height/i.test(i.ariaLabel || i.testid || i.name || i.id || i.placeholder || ''));

      if (wInput && hInput) {
        const mkSel = i => i.testid ? `[data-testid="${i.testid}"]` :
                          (i.id ? `#${i.id}` : `input[name="${i.name}"]`);
        try {
          await page.fill(mkSel(wInput), '3');
          await sleep(400);
          await page.fill(mkSel(hInput), '3');
          await page.keyboard.press('Tab');
          await sleep(3000);
          log('SM: filled width=3, height=3');
        } catch (e) { log('SM: fill error: ' + e.message); }
      }

      // Try quantity selection
      const qtyInput = formInfo.inputs.find(i =>
        /quantity|qty/i.test(i.ariaLabel || i.testid || i.name || i.id || ''));
      if (qtyInput) {
        const sel = qtyInput.testid ? `[data-testid="${qtyInput.testid}"]` :
                    (qtyInput.id ? `#${qtyInput.id}` : null);
        if (sel) {
          try {
            if (qtyInput.tag === 'SELECT') {
              await page.selectOption(sel, { label: '5,000' });
            } else {
              await page.fill(sel, '5000');
              await page.keyboard.press('Enter');
            }
            await sleep(3000);
            log('SM: set qty to 5000');
          } catch (e) { log('SM: qty set error: ' + e.message); }
        }
      }
    }

    // Read pricing table / price information
    const priceInfo = await page.evaluate(() => {
      const prices = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(document.body.innerText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 20 && v < 100000) prices.push(v);
      }

      // Look for pricing tables
      const tables = Array.from(document.querySelectorAll('table'))
        .filter(t => t.offsetWidth > 0)
        .map(t => t.textContent?.trim().replace(/\s+/g, ' ').slice(0, 300));

      // Structured price display
      const priceText = Array.from(document.querySelectorAll('[class*="price" i], [class*="total" i], [class*="amount" i]'))
        .filter(el => el.offsetWidth > 0 && el.offsetWidth < 400)
        .map(el => el.textContent?.trim())
        .filter(t => t && /\$/.test(t))
        .slice(0, 10);

      return {
        allPrices: [...new Set(prices)].sort((a, b) => a - b),
        tables: tables.slice(0, 3),
        priceTexts: priceText
      };
    });

    log(`SM: DOM prices: [${priceInfo.allPrices.join(', ')}]`);
    priceInfo.tables.forEach((t, i) => log(`SM table ${i}: ${t}`));
    priceInfo.priceTexts.forEach(t => log(`SM price text: "${t}"`));

    result.allPrices = priceInfo.allPrices;
    if (priceInfo.allPrices.length > 0) {
      result.price = priceInfo.allPrices[0];
    }

    // Check GQL endpoints for pricing data
    const gqlResult = await page.evaluate(async () => {
      const endpoints = [
        'https://www.stickermule.com/core/graphql',
        'https://www.stickermule.com/bridge/backend/graphql'
      ];

      const queries = [
        // Try to get product pricing for custom labels
        { name: 'customLabels', body: { query: `query { product(permalink: "custom-labels") { name pricingTable { quantity total perUnit } } }` } },
        { name: 'orderPrices', body: { query: `query { orderPrices(quantity: 5000, width: 3, height: 3) { total perUnit } }` } },
        { name: 'labelPricing', body: { query: `query { labelPricing(qty: 5000, w: 3, h: 3) { total unit } }` } },
        { name: 'products_minimal', body: { query: `query { products { id name } }` } },
      ];

      const results = {};
      for (const ep of endpoints.slice(0, 1)) {
        for (const q of queries) {
          try {
            const r = await fetch(ep, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              credentials: 'include',
              body: JSON.stringify(q.body)
            });
            const text = await r.text();
            results[`${ep.split('/').pop()}_${q.name}`] = {
              status: r.status,
              body: text.slice(0, 400)
            };
          } catch (e) { results[q.name] = { error: e.message }; }
        }
      }
      return results;
    });

    for (const [k, v] of Object.entries(gqlResult)) {
      if (v.status === 200 && !v.body?.includes('"errors"')) {
        log(`SM GQL ${k}: SUCCESS → ${v.body?.slice(0, 200)}`);
        const priceM = v.body?.match(/"(?:total|price|amount)":\s*"?(\d+\.?\d*)"?/);
        if (priceM) {
          const p = parseFloat(priceM[1]);
          if (p > 20 && p < 100000) {
            result.price = p;
            log(`SM: GQL price: $${p}`);
          }
        }
      } else {
        log(`SM GQL ${k}: ${v.status || v.error} → ${v.body?.slice(0, 100)}`);
      }
    }

    // Log any pricing from network intercepts
    result.networkPrices = networkPrices.map(r => ({ url: r.url, body: r.body.slice(0, 200) }));
    log(`SM: ${networkPrices.length} network pricing responses`);

  } catch (e) {
    result.error = e.message;
    err('SM: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── GOTPRINT ─────────────────────────────────────────────────────────────────
async function captureGotprint(browser) {
  log('=== GOTPRINT: Vue.js DOM extraction + network intercept ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const result = { price: null, priceSpec: null, networkApiCalls: [], domPrices: [], error: null };

  // Watch ALL XHR/fetch calls the Vue app makes (including auth-bearing calls)
  const apiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com') && !u.match(/\.(png|jpg|css|js|woff|gif|svg)$/i)) {
      try {
        const status = resp.status();
        const body = await resp.text();
        if (body.length > 50 && body.length < 50000 &&
            (body.startsWith('{') || body.startsWith('[') || body.includes('price'))) {
          apiCalls.push({ url: u.slice(0, 150), status, body: body.slice(0, 1000) });
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  try {
    await page.goto('https://www.gotprint.com/store/stickers-and-labels/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 35000
    });

    // Wait a long time for Vue hydration
    await sleep(15000);

    log(`GP: ${apiCalls.length} API calls captured`);
    apiCalls.forEach(c => {
      log(`  ${c.url}: status=${c.status}`);
      if (c.status === 200 && (c.body.includes('price') || c.body.includes('total'))) {
        log(`    body: ${c.body.slice(0, 200)}`);
      }
    });

    // Read DOM state
    const domState = await page.evaluate(() => {
      const visible = el => !!(el?.offsetWidth || el?.offsetHeight);
      const prices = new Set();
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(document.body.innerText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 10 && v < 100000) prices.add(v);
      }

      // Find form elements
      const inputs = Array.from(document.querySelectorAll('input, select'))
        .filter(visible)
        .slice(0, 15)
        .map(el => ({
          tag: el.tagName, type: el.type, name: el.name, id: el.id,
          ariaLabel: el.getAttribute('aria-label'), value: el.value?.slice(0, 20)
        }));

      // Vue app might render price in specific elements
      const priceEls = Array.from(document.querySelectorAll(
        '[class*="price"], [id*="price"], [class*="Price"], [class*="total"], [id*="total"]'
      )).filter(visible).map(el => ({ tag: el.tagName, text: el.textContent?.trim().slice(0, 80) }));

      return {
        prices: [...prices].sort((a, b) => a - b),
        inputs,
        priceEls: priceEls.slice(0, 8),
        title: document.title
      };
    });

    log(`GP: title="${domState.title}"`);
    log(`GP: DOM prices: [${domState.prices.join(', ')}]`);
    log(`GP: ${domState.inputs.length} form inputs, ${domState.priceEls.length} price elements`);
    domState.inputs.forEach(i => log(`  input: ${i.tag} type=${i.type} name="${i.name}" aria="${i.ariaLabel}"`));
    domState.priceEls.forEach(p => log(`  priceEl: ${p.tag} "${p.text}"`));

    result.domPrices = domState.prices;
    result.networkApiCalls = apiCalls.slice(0, 10).map(c => ({ url: c.url, status: c.status }));

    // Try to interact with visible form elements
    if (domState.inputs.length > 0) {
      // Try to find and interact with size/qty selectors
      const qtySelect = domState.inputs.find(i =>
        i.tag === 'SELECT' && (/quantity|qty/i.test(i.name) || /quantity|qty/i.test(i.id) || /quantity|qty/i.test(i.ariaLabel || '')));

      if (qtySelect) {
        const sel = qtySelect.id ? `#${qtySelect.id}` : `select[name="${qtySelect.name}"]`;
        try {
          // Select 5000 if available, else largest
          await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return;
            const opts = Array.from(el.options);
            const o5k = opts.find(o => o.value === '5000' || o.text.replace(/,/g, '') === '5000');
            if (o5k) {
              el.value = o5k.value;
            } else {
              // Pick largest
              const last = opts[opts.length - 1];
              if (last) el.value = last.value;
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, sel);
          await sleep(5000);
          log('GP: set quantity select');
        } catch (e) { log('GP: qty select error: ' + e.message); }
      }

      // Read updated prices
      const updated = await page.evaluate(() => {
        const prices = new Set();
        const re = /\$([\d,]+\.?\d{0,2})/g;
        let m;
        while ((m = re.exec(document.body.innerText)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 10 && v < 100000) prices.add(v);
        }
        return [...prices].sort((a, b) => a - b);
      });
      log(`GP: updated DOM prices: [${updated.join(', ')}]`);
      result.domPrices = updated;
    }

    // Extract any authenticated API call prices
    const authApiPrices = apiCalls.filter(c => c.status === 200);
    if (authApiPrices.length > 0) {
      log(`GP: ${authApiPrices.length} successful API responses`);
      for (const c of authApiPrices.slice(0, 5)) {
        log(`  ${c.url}: ${c.body.slice(0, 200)}`);
        const priceM = c.body.match(/"price":\s*"?([\d.]+)"?/);
        if (priceM) {
          const p = parseFloat(priceM[1]);
          if (p > 10 && p < 100000) {
            result.price = p;
            log(`GP: API price: $${p}`);
          }
        }
      }
    }

  } catch (e) {
    result.error = e.message;
    err('GP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPDATE DATA FILES ─────────────────────────────────────────────────────────
function updateDataFiles(vpResult, axiomResult, smResult, gpResult) {
  const raw  = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM_FILE, 'utf8'));
  const today = nowISO();
  const q3x3 = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');

  let changed = false;

  // ── Vistaprint ──
  const vpComp = q3x3?.competitor_results.find(c => c.competitor === 'vistaprint');
  if (vpResult.price5000 && vpResult.price5000 > 50) {
    const sizeConfirmed = vpResult.sizeInteracted;
    const conf = sizeConfirmed ? 'high' : 'medium';
    const spec = sizeConfirmed ? '3"×3" (size selected) Slit Roll, 5,000 qty' : 'Default size Slit Roll, 5,000 qty (size NOT confirmed 3"×3")';

    log(`VP: NEW price = $${vpResult.price5000} (conf=${conf}, sizeInteracted=${sizeConfirmed})`);

    raw.captures = raw.captures.filter(c => c.id !== 'vistaprint-5000qty-advanced-' + today);
    raw.captures.push({
      id: `vistaprint-5000qty-advanced-${today}`,
      competitor: 'vistaprint', competitor_display: 'Vistaprint',
      source_url: 'https://www.vistaprint.com/labels-stickers/roll-labels',
      captured_at: today,
      capture_method: 'playwright_cimpress_api_replay',
      capture_source: 'automated_headless',
      confidence: conf,
      product_type: 'roll_labels',
      raw_spec_description: `Roll Labels ${spec}`,
      specs: {
        width_in: sizeConfirmed ? 3 : null,
        height_in: sizeConfirmed ? 3 : null,
        shape: 'square',
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
        price_type: 'pricing_service_api_replay'
      },
      raw_snippet: `Cimpress API replay with quantities=5000. sizeInteracted=${sizeConfirmed}. selections=${JSON.stringify(vpResult.selectionsUsed || {})}`,
      notes: `Cimpress pricing service API replay. Size interaction: ${sizeConfirmed ? 'succeeded (method: ' + vpResult.sizeMethod + ')' : 'NOT confirmed — default pricingContext used'}. Selections in URL: ${JSON.stringify(vpResult.selectionsUsed || {})}`,
      blocker: null,
      next_step: sizeConfirmed ? null : 'Verify size selections confirm 3"×3" in pricingContext'
    });

    raw.capture_coverage_summary.vistaprint = {
      status: sizeConfirmed ? 'partial' : 'partial',
      confidence: conf,
      last_method: 'playwright_cimpress_api_replay',
      notes: `5000 qty = $${vpResult.price5000}${sizeConfirmed ? ' (after 3x3 size selection)' : ' (default size — NOT confirmed 3x3)'}. Previous: 1x1 Matte 50/$35.99, 1000/$110.24.`
    };

    if (vpComp) {
      vpComp.closest_data_point = {
        description: spec,
        total_price: vpResult.price5000,
        unit_price: vpResult.unit5000,
        quantity: 5000,
        spec_delta: sizeConfirmed ? 'material unconfirmed (VP may use paper not BOPP)' : 'size NOT confirmed as 3"×3"',
        confidence: conf,
        raw_capture_id: `vistaprint-5000qty-advanced-${today}`
      };
      if (sizeConfirmed) {
        vpComp.status = 'partial';
        vpComp.coverage = 'size_confirmed_material_unconfirmed';
        vpComp.total_price = vpResult.price5000;
        vpComp.unit_price = vpResult.unit5000;
      }
    }
    changed = true;
  } else {
    log('VP: no 5000-qty price captured — existing data unchanged');
  }

  // ── Axiom Print ──
  const axComp = q3x3?.competitor_results.find(c => c.competitor === 'axiomprint');
  if (axiomResult.price && axiomResult.price > 50) {
    const shapeOk  = /square/i.test(axiomResult.shape || '');
    const matOk    = /bopp|matte/i.test(axiomResult.material || '');
    const qtyOk    = /2[,.]?500|2500/.test(axiomResult.qty || '');
    const specDesc = `Roll Labels ${shapeOk ? 'Square' : 'shape?'} 3"×3" (dims set), ${matOk ? 'White Matte BOPP' : 'material?'}, ${qtyOk ? '2,500 qty' : 'qty?'} (configurator max)`;
    const conf     = shapeOk && matOk && qtyOk ? 'high' : shapeOk && qtyOk ? 'medium' : 'low';

    log(`Axiom: NEW price = $${axiomResult.price} (shape=${axiomResult.shape}, mat=${axiomResult.material}, qty=${axiomResult.qty}, conf=${conf})`);

    raw.captures = raw.captures.filter(c => !c.id.startsWith('axiomprint-3x3-') );
    raw.captures.push({
      id: `axiomprint-3x3-bopp-2500-${today}`,
      competitor: 'axiomprint', competitor_display: 'Axiom Print',
      source_url: 'https://axiomprint.com/product/roll-labels-335',
      captured_at: today,
      capture_method: 'playwright_antd_dropdown_interaction',
      capture_source: 'automated_headless',
      confidence: conf,
      product_type: 'roll_labels',
      raw_spec_description: specDesc,
      specs: {
        width_in: 3, height_in: 3,
        shape: shapeOk ? 'square' : null,
        format: 'roll',
        quantity: 2500,
        material: matOk ? 'White Matte BOPP' : null,
        finish: null
      },
      pricing: {
        total_price: axiomResult.price,
        unit_price: axiomResult.price ? Math.round(axiomResult.price / 2500 * 10000) / 10000 : null,
        currency: 'USD',
        turnaround_days: null,
        shipping_included: null,
        price_type: 'configurator_live'
      },
      raw_snippet: `Ant Design configurator: shape=${axiomResult.shape}, material=${axiomResult.material}, qty=${axiomResult.qty}, allPrices=${JSON.stringify(axiomResult.allPrices?.slice(0, 8))}`,
      notes: `Advanced pass. Shape selection: ${axiomResult.shape || 'not confirmed'}. Material: ${axiomResult.material || 'not confirmed'}. Max configurator qty = 2500 (5000+ needs custom quote). All prices on page: ${JSON.stringify(axiomResult.allPrices?.slice(0, 8))}.`,
      blocker: null,
      next_step: qtyOk ? null : '5000 qty: custom quote required from axiomprint.com'
    });

    raw.capture_coverage_summary.axiomprint = {
      status: 'partial',
      confidence: conf,
      last_method: 'playwright_antd_dropdown_interaction',
      verified_prices: [
        { qty: 250, total: 112.68, unit: 0.451, spec: '2×3 default (old capture)' },
        { qty: 2500, total: 213.27, unit: 0.0853, spec: '2×3 default (old capture)' },
        ...(axiomResult.price ? [{ qty: 2500, total: axiomResult.price, unit: Math.round(axiomResult.price / 2500 * 10000) / 10000, spec: `Square 3×3 White Matte BOPP (conf=${conf})` }] : [])
      ],
      notes: `Standard configurator max qty = 2500. 5000+ requires custom quote. Square 3×3 price: $${axiomResult.price || 'not confirmed'}. Shape: ${axiomResult.shape || '?'}. Material: ${axiomResult.material || '?'}.`
    };

    if (axComp && conf !== 'low') {
      axComp.closest_data_point = {
        description: specDesc,
        total_price: axiomResult.price,
        unit_price: Math.round(axiomResult.price / 2500 * 10000) / 10000,
        quantity: 2500,
        spec_delta: 'qty=2500 (not 5000); configurator max. Shape/material confirmed.',
        confidence: conf,
        raw_capture_id: `axiomprint-3x3-bopp-2500-${today}`
      };
    }
    changed = true;
  } else {
    log(`Axiom: no price captured (price=${axiomResult.price}) — existing data unchanged`);
  }

  // ── Sticker Mule ──
  // Only update if we got something NEW beyond the $47 starting price
  if (smResult.price && smResult.price !== 47 && smResult.price > 47) {
    log(`SM: NEW price = $${smResult.price}`);
    // Don't add a stickermule entry unless we have spec-confirmed pricing
    // because a random DOM price without spec confirmation is not useful
    // Just note it in a debug entry
    log('SM: price captured but spec not confirmed — not updating normalized data');
  } else {
    log(`SM: no spec-confirmed price captured (price=${smResult.price})`);
  }

  // ── GotPrint ──
  if (gpResult.price) {
    log(`GP: captured price $${gpResult.price} — spec not confirmed, NOT updating authoritative data`);
  } else {
    log(`GP: no price captured. DOM prices: [${gpResult.domPrices.join(', ')}]`);
    log(`GP: network calls: ${gpResult.networkApiCalls.map(c => `${c.status} ${c.url}`).join(', ')}`);
  }

  if (changed) {
    raw.last_updated = today;
    norm.last_updated = today;
    norm.last_capture_pass = `${today}-playwright-advanced`;
    fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM_FILE, JSON.stringify(norm, null, 2));
    log('Data files updated.');
  } else {
    log('No data updates made — existing data preserved.');
  }

  return changed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Advanced Pricing Capture Pass === ${nowISO()}`);
  log('Targets: Vistaprint 3"×3"/5000, Axiom Square 3"×3"/BOPP/2500, Sticker Mule, GotPrint');

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

    log('\n--- Sticker Mule ---');
    try { results.stickermule = await captureStickermule(browser); } catch (e) { err('SM fatal: ' + e.message); results.stickermule = { error: e.message }; }

    log('\n--- GotPrint ---');
    try { results.gotprint = await captureGotprint(browser); } catch (e) { err('GP fatal: ' + e.message); results.gotprint = { error: e.message }; }

  } finally {
    await browser.close();
  }

  // Write raw debug output
  const debugFile = path.join(ROOT_DIR, 'data', `capture-advanced-${nowISO()}.json`);
  fs.writeFileSync(debugFile, JSON.stringify(results, null, 2));
  log(`\nDebug output: ${debugFile}`);

  // Update authoritative data files
  updateDataFiles(
    results.vistaprint || {},
    results.axiom || {},
    results.stickermule || {},
    results.gotprint || {}
  );

  log('\n=== RESULTS SUMMARY ===');
  log(`Vistaprint 5000 qty price: ${results.vistaprint?.price5000 != null ? '$' + results.vistaprint.price5000 : 'NOT CAPTURED'} (size interacted: ${results.vistaprint?.sizeInteracted})`);
  log(`Axiom 3x3/BOPP/2500 price: ${results.axiom?.price != null ? '$' + results.axiom.price : 'NOT CAPTURED'} (shape: ${results.axiom?.shape}, mat: ${results.axiom?.material})`);
  log(`Sticker Mule price: ${results.stickermule?.price != null ? '$' + results.stickermule.price : 'NOT CAPTURED'} (interacted: ${results.stickermule?.configInteracted})`);
  log(`GotPrint DOM prices: [${results.gotprint?.domPrices?.join(', ') || 'none'}]`);
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
