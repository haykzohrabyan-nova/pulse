#!/usr/bin/env node
/**
 * capture-multiproduct-pass.js
 * PRI-7 — Multi-product competitor pricing capture
 * Date: 2026-04-17
 *
 * Targets:
 *   1. UPrinting: Roll Labels 4"×2" / 10,000 qty (missing from dataset)
 *   2. Vistaprint: Folding Cartons — STE box equivalent
 *   3. Vistaprint: Stand-Up Pouches
 *   4. GotPrint: Roll Labels — aggressive Vue state trigger attempt
 *
 * Approach:
 *   - UPrinting: Angular scope read (confirmed working technique)
 *   - Vistaprint: Cimpress API intercept (confirmed working for labels)
 *   - GotPrint: Try puppeteer-style full Vue trigger via __vue__ instance access
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');
const OUT_FILE  = path.join(ROOT_DIR, 'data', `capture-multiproduct-${nowISO()}.json`);

function log(msg)  { console.log(`[mpp] ${msg}`); }
function err(msg)  { console.error(`[ERR] ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseDollar(text) {
  if (!text) return null;
  const m = String(text).match(/\$?([\d,]+\.?\d{0,2})/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return (v > 5 && v < 500000) ? v : null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── 1. UPrinting — Roll Labels 4×2 / 10,000 qty ────────────────────────────
async function captureUPrintingLabel4x2(browser) {
  log('=== UPrinting: 4"×2" Roll Labels ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const result = { status: 'failed', prices: {}, rawScope: null, error: null };

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'domcontentloaded', timeout: 45000
    });
    await sleep(5000);

    // Click Bootstrap size dropdown and select 4"×2"
    // UPrinting uses Bootstrap dropdowns for size — attr4 index
    const sizeSelected = await page.evaluate(async () => {
      // Find the size dropdown toggle button
      const toggles = Array.from(document.querySelectorAll('[data-toggle="dropdown"], .dropdown-toggle'));
      for (const toggle of toggles) {
        const label = toggle.textContent.trim();
        // Look for size-related dropdown
        const parent = toggle.closest('.dropdown, .btn-group');
        if (!parent) continue;
        const items = parent.querySelectorAll('.dropdown-menu li a, .dropdown-menu a');
        for (const item of items) {
          const txt = item.textContent.trim();
          if (/4["″]?\s*[×x]\s*2["″]/i.test(txt) || /4\s*x\s*2/i.test(txt)) {
            toggle.click();
            await new Promise(r => setTimeout(r, 300));
            item.click();
            return { found: true, selected: txt };
          }
        }
      }
      return { found: false };
    });
    log(`UP 4x2: size selection = ${JSON.stringify(sizeSelected)}`);
    await sleep(3000);

    // Try clicking the 10,000 quantity option
    const qty10k = await page.evaluate(async () => {
      // Look for qty grid cells
      const cells = Array.from(document.querySelectorAll('td, li, .qty-cell, [class*="qty"]'));
      for (const cell of cells) {
        const txt = cell.textContent.trim().replace(/,/g, '');
        if (txt === '10000' || txt === '10,000') {
          cell.click();
          return { found: true, text: cell.textContent.trim() };
        }
      }
      // Try tree walker approach (confirmed working in prior passes)
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim().replace(/,/g, '');
        if (t === '10000' || t === '10,000') {
          const el = node.parentElement;
          el.click();
          return { found: true, text: el.textContent.trim(), tagName: el.tagName };
        }
      }
      return { found: false };
    });
    log(`UP 4x2: qty 10k click = ${JSON.stringify(qty10k)}`);
    await sleep(3000);

    // Read Angular scope
    const scopeData = await page.evaluate(() => {
      try {
        const calc = document.querySelector('#calc_33_grid, #calc_grid, [id*="calc"]');
        if (calc) {
          const scope = angular.element(calc).scope();
          if (scope && scope.priceData) {
            return {
              method: 'calc_scope',
              priceData: {
                qty: scope.priceData.qty,
                price: scope.priceData.price,
                total_price: scope.priceData.total_price,
                unit_price: scope.priceData.unit_price,
                turnaround: scope.priceData.turnaround
              }
            };
          }
        }
      } catch (_) {}
      // Fallback: find any Angular scope with priceData
      try {
        const allEls = document.querySelectorAll('[ng-controller], [data-ng-controller]');
        for (const el of allEls) {
          try {
            const scope = angular.element(el).scope();
            if (scope && scope.priceData && scope.priceData.price) {
              return {
                method: 'ng_controller',
                priceData: {
                  qty: scope.priceData.qty,
                  price: scope.priceData.price,
                  total_price: scope.priceData.total_price,
                  unit_price: scope.priceData.unit_price,
                  turnaround: scope.priceData.turnaround
                }
              };
            }
          } catch (_) {}
        }
      } catch (_) {}
      return null;
    });
    log(`UP 4x2: scope = ${JSON.stringify(scopeData)}`);

    if (scopeData && scopeData.priceData && scopeData.priceData.price) {
      const pd = scopeData.priceData;
      result.status = 'live';
      result.prices = {
        qty: pd.qty,
        total: parseFloat(pd.total_price || pd.price),
        unit: parseFloat(pd.unit_price || 0),
        turnaround: pd.turnaround
      };
      result.rawScope = pd;
    } else {
      // Fallback: parse DOM prices
      const domPrices = await page.evaluate(() => {
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const text = document.body.innerText;
        const ps = new Set();
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 50 && v < 50000) ps.add(v);
        }
        return [...ps].sort((a, b) => a - b);
      });
      log(`UP 4x2: fallback DOM prices = [${domPrices.join(', ')}]`);
      result.status = 'partial_dom';
      result.prices = { domPrices };
    }
  } catch (e) {
    err(`UP 4x2: ${e.message}`);
    result.error = e.message;
  } finally {
    await context.close();
  }
  return result;
}

// ─── 2. UPrinting — Roll Labels 2×2 extra sizes ──────────────────────────────
async function captureUPrintingLabelSizes(browser) {
  log('=== UPrinting: Additional label sizes (2x3, 2x4, 3x4) at 1000/5000 ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const results = {};

  const sizes = [
    { label: '2x3', pattern: /2["″]?\s*[×x]\s*3["″]/i },
    { label: '2x4', pattern: /2["″]?\s*[×x]\s*4["″]/i },
    { label: '4x4', pattern: /4["″]?\s*[×x]\s*4["″]/i },
  ];

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'domcontentloaded', timeout: 45000
    });
    await sleep(4000);

    for (const sz of sizes) {
      log(`UP sizes: trying ${sz.label}...`);
      // Click size
      const sizeClicked = await page.evaluate(async (pattern) => {
        const re = new RegExp(pattern.source, pattern.flags);
        const toggles = Array.from(document.querySelectorAll('[data-toggle="dropdown"], .dropdown-toggle'));
        for (const toggle of toggles) {
          const parent = toggle.closest('.dropdown, .btn-group');
          if (!parent) continue;
          const items = parent.querySelectorAll('.dropdown-menu li a, .dropdown-menu a');
          for (const item of items) {
            if (re.test(item.textContent.trim())) {
              toggle.click();
              await new Promise(r => setTimeout(r, 300));
              item.click();
              return item.textContent.trim();
            }
          }
        }
        return null;
      }, { source: sz.pattern.source, flags: sz.pattern.flags });
      await sleep(2000);

      for (const qty of [1000, 5000]) {
        const qtyClicked = await page.evaluate(async (targetQty) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            const t = node.textContent.trim().replace(/,/g, '');
            if (parseInt(t) === targetQty) {
              const el = node.parentElement;
              el.click();
              return el.textContent.trim();
            }
          }
          return null;
        }, qty);
        await sleep(2000);

        const pd = await page.evaluate(() => {
          try {
            const els = document.querySelectorAll('[ng-controller], [id*="calc"]');
            for (const el of els) {
              try {
                const scope = angular.element(el).scope();
                if (scope && scope.priceData && scope.priceData.price) {
                  return {
                    qty: scope.priceData.qty,
                    total: parseFloat(scope.priceData.total_price || scope.priceData.price),
                    unit: parseFloat(scope.priceData.unit_price || 0)
                  };
                }
              } catch (_) {}
            }
          } catch (_) {}
          return null;
        });

        const key = `up-${sz.label}-${qty}`;
        if (pd) {
          log(`UP ${sz.label}/${qty}: $${pd.total}`);
          results[key] = { status: 'live', sizeClicked, qtyClicked, ...pd };
        } else {
          results[key] = { status: 'failed', sizeClicked };
        }
      }
    }
  } catch (e) {
    err(`UP sizes: ${e.message}`);
  } finally {
    await context.close();
  }
  return results;
}

// ─── 3. Vistaprint — Folding Cartons ─────────────────────────────────────────
async function captureVistaprintBoxes(browser) {
  log('=== Vistaprint: Folding Cartons / Product Boxes ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const cimpressCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('prices.cimpress.io') || u.includes('cimpress')) && resp.status() < 400) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.text().catch(() => '');
          if (body.length > 10) cimpressCalls.push({ url: u, body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  });

  const result = { status: 'failed', urls_tried: [], prices: {}, cimpressCallCount: 0, error: null };
  const page = await context.newPage();

  const boxUrls = [
    'https://www.vistaprint.com/custom-boxes/product-boxes',
    'https://www.vistaprint.com/custom-boxes',
    'https://www.vistaprint.com/packaging/product-boxes',
    'https://www.vistaprint.com/marketing-materials/packaging/product-boxes',
    'https://www.vistaprint.com/retail-packaging/product-boxes',
  ];

  try {
    for (const url of boxUrls) {
      result.urls_tried.push(url);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        log(`VP boxes: ${url} → ${resp.status()}`);
        if (resp.status() === 200) {
          await sleep(4000);
          const title = await page.title();
          const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
          log(`VP boxes: title="${title}", content preview="${bodyText.slice(0, 200)}"`);
          result.status = 'page_found';
          result.found_url = url;
          result.page_title = title;
          break;
        }
      } catch (e) {
        log(`VP boxes: ${url} → error: ${e.message}`);
      }
    }

    if (result.status === 'page_found') {
      // Try to interact with quantity selector
      await sleep(3000);
      const allPrices = await page.evaluate(() => {
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const text = document.body.innerText;
        const ps = new Set();
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 50 && v < 100000) ps.add(v);
        }
        return [...ps].sort((a, b) => a - b);
      });
      log(`VP boxes: DOM prices = [${allPrices.join(', ')}]`);
      result.dom_prices = allPrices;
    }

    result.cimpressCallCount = cimpressCalls.length;
    result.cimpressSample = cimpressCalls.slice(0, 3).map(c => ({ url: c.url.split('?')[0], body_start: c.body.slice(0, 500) }));
    log(`VP boxes: cimpress calls captured = ${cimpressCalls.length}`);

  } catch (e) {
    err(`VP boxes: ${e.message}`);
    result.error = e.message;
  } finally {
    await context.close();
  }
  return result;
}

// ─── 4. Vistaprint — Stand-Up Pouches ────────────────────────────────────────
async function captureVistaprintPouches(browser) {
  log('=== Vistaprint: Stand-Up Pouches ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const cimpressCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('prices.cimpress.io') || u.includes('cimpress') || u.includes('pricing')) && resp.status() < 400) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.text().catch(() => '');
          if (body.length > 10) cimpressCalls.push({ url: u, body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  });

  const result = { status: 'failed', urls_tried: [], prices: {}, error: null };
  const page = await context.newPage();

  const pouchUrls = [
    'https://www.vistaprint.com/custom-pouches',
    'https://www.vistaprint.com/custom-bags/stand-up-pouches',
    'https://www.vistaprint.com/custom-packaging/stand-up-pouches',
    'https://www.vistaprint.com/packaging/pouches',
  ];

  try {
    for (const url of pouchUrls) {
      result.urls_tried.push(url);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        log(`VP pouches: ${url} → ${resp.status()}`);
        if (resp.status() === 200) {
          await sleep(3000);
          const title = await page.title();
          const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
          log(`VP pouches: found! title="${title}"`);
          log(`VP pouches: content="${bodyText.slice(0, 200)}"`);
          result.status = 'page_found';
          result.found_url = url;
          result.page_title = title;
          break;
        }
      } catch (e) {
        log(`VP pouches: ${url} → error: ${e.message}`);
      }
    }

    if (result.status === 'page_found') {
      await sleep(2000);
      const allPrices = await page.evaluate(() => {
        const re = /\$([\d,]+\.?\d{0,2})/g;
        const text = document.body.innerText;
        const ps = new Set();
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v >= 30 && v < 100000) ps.add(v);
        }
        return [...ps].sort((a, b) => a - b);
      });
      log(`VP pouches: DOM prices = [${allPrices.join(', ')}]`);
      result.dom_prices = allPrices;
      result.cimpressSample = cimpressCalls.slice(0, 3).map(c => ({ url: c.url.split('?')[0], body: c.body.slice(0, 800) }));
    }
  } catch (e) {
    err(`VP pouches: ${e.message}`);
    result.error = e.message;
  } finally {
    await context.close();
  }
  return result;
}

// ─── 5. GotPrint — Roll Labels with Vue Workaround ───────────────────────────
async function captureGotPrintLabels(browser) {
  log('=== GotPrint: Roll Labels — Vue state trigger via __vue__ instance ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const networkCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com') && (u.includes('price') || u.includes('quantity') || u.includes('option') || u.includes('order'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.text().catch(() => '');
          networkCalls.push({ url: u, status: resp.status(), body: body.slice(0, 2000) });
        }
      } catch (_) {}
    }
  });

  const result = {
    status: 'failed',
    shapeSet: false,
    sizeSet: false,
    paperSet: false,
    finishSet: false,
    qtySet: false,
    price: null,
    domPrices: [],
    networkCalls: [],
    error: null
  };

  const page = await context.newPage();

  try {
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'domcontentloaded', timeout: 45000
    });
    await sleep(5000);
    log('GP: page loaded');

    // Step 1: Set shape via Vue internal instance
    const shapeResult = await page.evaluate(async () => {
      const sel = document.querySelector('select[name="shape"]');
      if (!sel) return { error: 'no shape select' };

      // Try Vue 3 internal
      const vueKey = Object.keys(sel).find(k => k.startsWith('__vue'));
      if (vueKey) {
        const vueInst = sel[vueKey];
        if (vueInst && vueInst.$emit) {
          sel.value = 'Square - Rounded';
          vueInst.$emit('change', { target: sel });
          await new Promise(r => setTimeout(r, 500));
          vueInst.$emit('input', sel.value);
          return { method: 'vue3_emit', value: sel.value };
        }
        if (vueInst && vueInst.proxy && vueInst.proxy.$emit) {
          sel.value = 'Square - Rounded';
          vueInst.proxy.$emit('change', sel.value);
          return { method: 'vue3_proxy_emit', value: sel.value };
        }
      }

      // Try Vue 2 internal (__vue__ on parent)
      let el = sel.parentElement;
      for (let i = 0; i < 5; i++) {
        if (!el) break;
        if (el.__vue__) {
          const vm = el.__vue__;
          const formKey = Object.keys(vm.$data || {}).find(k => /shape/i.test(k));
          if (formKey) {
            vm.$set ? vm.$set(vm, formKey, 'Square - Rounded') : (vm[formKey] = 'Square - Rounded');
            await new Promise(r => setTimeout(r, 200));
            return { method: 'vue2_data', key: formKey, value: vm[formKey] };
          }
          // Try triggering through vm.$el event
          const event = new Event('change', { bubbles: true });
          sel.value = 'Square - Rounded';
          sel.dispatchEvent(event);
          await new Promise(r => setTimeout(r, 500));
          return { method: 'vue2_dispatch', value: sel.value };
        }
        el = el.parentElement;
      }

      // Last resort: native event dispatch
      sel.value = 'Square - Rounded';
      ['input', 'change'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      return { method: 'native_dispatch', value: sel.value };
    });
    log(`GP: shape = ${JSON.stringify(shapeResult)}`);
    result.shapeSet = !!shapeResult && !shapeResult.error;
    await sleep(3000);

    // Step 2: Check if size select updated and set 3x3
    const sizeResult = await page.evaluate(async () => {
      const sel = document.querySelector('select[name="size"]');
      if (!sel) return { error: 'no size select' };

      const options = Array.from(sel.options).map(o => o.value);
      const target3x3 = options.find(o => /3["″]?\s*[×x]\s*3["″]/i.test(o) || o.includes('3" x 3"') || o.includes('3x3'));
      log_val = target3x3;

      if (!target3x3 && sel.disabled) {
        return { error: 'select disabled, no 3x3 option visible', options: options.slice(0, 5) };
      }
      if (!target3x3) {
        return { error: 'no 3x3 option found', options };
      }

      sel.value = target3x3;
      const vueKey = Object.keys(sel).find(k => k.startsWith('__vue'));
      if (vueKey && sel[vueKey] && sel[vueKey].$emit) {
        sel[vueKey].$emit('change', { target: sel });
      }
      ['input', 'change'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      return { set: true, value: target3x3, options };
    });
    log(`GP: size = ${JSON.stringify(sizeResult)}`);
    result.sizeSet = !!(sizeResult && sizeResult.set);
    await sleep(3000);

    // Step 3: Try paper select (White BOPP)
    const paperResult = await page.evaluate(async () => {
      const sel = document.querySelector('select[name="paper"]');
      if (!sel || sel.disabled) return { error: sel ? 'disabled' : 'not found', disabled: sel?.disabled };
      const opts = Array.from(sel.options).map(o => ({ v: o.value, t: o.text }));
      const bopp = opts.find(o => /white.*bopp|bopp.*white/i.test(o.t) || /bopp/i.test(o.t));
      if (!bopp) return { error: 'no BOPP option', opts };
      sel.value = bopp.v;
      ['input', 'change'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      return { set: true, value: bopp.t };
    });
    log(`GP: paper = ${JSON.stringify(paperResult)}`);
    result.paperSet = !!(paperResult && paperResult.set);
    await sleep(2000);

    // Step 4: Try finish select (Matte)
    const finishResult = await page.evaluate(async () => {
      const sel = document.querySelector('select[name="finish"]');
      if (!sel || sel.disabled) return { error: sel ? 'disabled' : 'not found', disabled: sel?.disabled };
      const opts = Array.from(sel.options).map(o => ({ v: o.value, t: o.text }));
      const matte = opts.find(o => /matte/i.test(o.t));
      if (!matte) return { error: 'no matte option', opts };
      sel.value = matte.v;
      ['input', 'change'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      return { set: true, value: matte.t };
    });
    log(`GP: finish = ${JSON.stringify(finishResult)}`);
    result.finishSet = !!(finishResult && finishResult.set);
    await sleep(2000);

    // Step 5: Try quantity select (5000)
    const qtyResult = await page.evaluate(async () => {
      const sel = document.querySelector('select[name="qty"], select[name="quantity"]');
      if (!sel || sel.disabled) return { error: sel ? 'disabled' : 'not found' };
      const opts = Array.from(sel.options).map(o => o.value);
      const q5k = opts.find(o => parseInt(o) === 5000);
      if (!q5k) return { error: 'no 5000 option', opts };
      sel.value = q5k;
      ['input', 'change'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      return { set: true, value: q5k };
    });
    log(`GP: qty = ${JSON.stringify(qtyResult)}`);
    result.qtySet = !!(qtyResult && qtyResult.set);
    await sleep(4000);

    // Step 6: Check for price
    const domPrices = await page.evaluate(() => {
      const re = /\$([\d,]+\.?\d{0,2})/g;
      const text = document.body.innerText;
      const ps = new Set();
      let m;
      while ((m = re.exec(text)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 30 && v < 50000) ps.add(v);
      }
      return [...ps].sort((a, b) => a - b);
    });
    log(`GP: DOM prices = [${domPrices.join(', ')}]`);
    result.domPrices = domPrices;

    // Check network calls for pricing
    result.networkCalls = networkCalls.map(c => ({ url: c.url, status: c.status, body_preview: c.body.slice(0, 500) }));
    log(`GP: network API calls captured = ${networkCalls.length}`);

    if (domPrices.length > 0 && result.qtySet) {
      // If we set qty and have prices, pick the most likely one (exclude trivially small/large)
      result.status = 'partial_price_visible';
      result.price = domPrices[0]; // conservative: take lowest visible
    } else if (domPrices.length > 0) {
      result.status = 'prices_visible_spec_unconfirmed';
    } else {
      result.status = 'no_price';
    }

  } catch (e) {
    err(`GP labels: ${e.message}`);
    result.error = e.message;
  } finally {
    await context.close();
  }
  return result;
}

// ─── 6. Sticker Mule — Explore with placeholder file upload ──────────────────
async function captureStickermulePricing(browser) {
  log('=== Sticker Mule: Explore pricing endpoints ===');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const apiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('stickermule.com') && (u.includes('pricing') || u.includes('price') || u.includes('quote') || u.includes('product'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.text().catch(() => '');
          apiCalls.push({ url: u, status: resp.status(), body: body.slice(0, 1000) });
        }
      } catch (_) {}
    }
  });

  const result = { status: 'failed', apiCalls: [], dom_prices: [], error: null };
  const page = await context.newPage();

  try {
    // Try direct pricing URLs
    const pricingUrls = [
      'https://www.stickermule.com/api/v1/products/custom-labels/pricing?width=3&height=3&quantity=5000',
      'https://www.stickermule.com/products/custom-labels',
      'https://www.stickermule.com/custom-labels',
    ];

    for (const url of pricingUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        log(`SM: ${url} → ${resp.status()}`);
        if (resp.status() === 200) {
          await sleep(2000);
          const body = await page.evaluate(() => document.body.innerText.slice(0, 2000));
          log(`SM: content preview: ${body.slice(0, 300)}`);

          const prices = await page.evaluate(() => {
            const re = /\$([\d,]+\.?\d{0,2})/g;
            const text = document.body.innerText;
            const ps = new Set();
            let m;
            while ((m = re.exec(text)) !== null) {
              const v = parseFloat(m[1].replace(/,/g, ''));
              if (v >= 20 && v < 50000) ps.add(v);
            }
            return [...ps].sort((a, b) => a - b);
          });
          if (prices.length) {
            result.dom_prices = prices;
            result.status = 'prices_found';
            result.found_url = url;
          }
        }
      } catch (e) {
        log(`SM: ${url} error: ${e.message}`);
      }
    }

    result.apiCalls = apiCalls.map(c => ({ url: c.url, status: c.status, body: c.body.slice(0, 300) }));
    log(`SM: API calls = ${apiCalls.length}`);

  } catch (e) {
    err(`SM: ${e.message}`);
    result.error = e.message;
  } finally {
    await context.close();
  }
  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Multi-Product Competitor Pricing Capture === ${nowISO()}`);
  log('Targets: UP 4x2/10k labels, UP extra sizes, VP folding cartons, VP pouches, GP roll labels, SM pricing');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const allResults = {};

  try {
    log('\n--- UPrinting: 4x2 label / 10k qty ---');
    try {
      allResults.up_4x2_label = await captureUPrintingLabel4x2(browser);
    } catch (e) {
      err('UP 4x2 fatal: ' + e.message);
      allResults.up_4x2_label = { error: e.message };
    }

    log('\n--- UPrinting: Additional label sizes ---');
    try {
      allResults.up_extra_sizes = await captureUPrintingLabelSizes(browser);
    } catch (e) {
      err('UP sizes fatal: ' + e.message);
      allResults.up_extra_sizes = { error: e.message };
    }

    log('\n--- Vistaprint: Folding Cartons ---');
    try {
      allResults.vp_boxes = await captureVistaprintBoxes(browser);
    } catch (e) {
      err('VP boxes fatal: ' + e.message);
      allResults.vp_boxes = { error: e.message };
    }

    log('\n--- Vistaprint: Stand-Up Pouches ---');
    try {
      allResults.vp_pouches = await captureVistaprintPouches(browser);
    } catch (e) {
      err('VP pouches fatal: ' + e.message);
      allResults.vp_pouches = { error: e.message };
    }

    log('\n--- GotPrint: Roll Labels ---');
    try {
      allResults.gp_labels = await captureGotPrintLabels(browser);
    } catch (e) {
      err('GP labels fatal: ' + e.message);
      allResults.gp_labels = { error: e.message };
    }

    log('\n--- Sticker Mule: Pricing Endpoints ---');
    try {
      allResults.sm_labels = await captureStickermulePricing(browser);
    } catch (e) {
      err('SM fatal: ' + e.message);
      allResults.sm_labels = { error: e.message };
    }

  } finally {
    await browser.close();
  }

  // Write raw output
  const output = {
    run_date: new Date().toISOString(),
    script: 'capture-multiproduct-pass.js',
    results: allResults
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log(`\nOutput written: ${OUT_FILE}`);

  // Summary
  log('\n=== RESULTS SUMMARY ===');
  log(`UP 4x2/10k: ${JSON.stringify(allResults.up_4x2_label?.prices || allResults.up_4x2_label?.status)}`);
  log(`UP extra sizes: ${Object.keys(allResults.up_extra_sizes || {}).join(', ')}`);
  log(`VP boxes: status=${allResults.vp_boxes?.status}, dom_prices=[${(allResults.vp_boxes?.dom_prices || []).slice(0,5).join(', ')}]`);
  log(`VP pouches: status=${allResults.vp_pouches?.status}, dom_prices=[${(allResults.vp_pouches?.dom_prices || []).slice(0,5).join(', ')}]`);
  log(`GP labels: status=${allResults.gp_labels?.status}, price=${allResults.gp_labels?.price}, domPrices=[${(allResults.gp_labels?.domPrices || []).slice(0,5).join(', ')}]`);
  log(`SM: status=${allResults.sm_labels?.status}, dom_prices=[${(allResults.sm_labels?.dom_prices || []).slice(0,5).join(', ')}]`);

  return allResults;
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
