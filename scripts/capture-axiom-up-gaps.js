#!/usr/bin/env node
/**
 * capture-axiom-up-gaps.js
 * PRI-7 — Fill remaining gaps:
 *   1. Axiom Print roll labels: 3x4 (closest to 3x3) at 250/500/1000/2500 qty
 *   2. UPrinting 4x2 at 1000 + 10000 qty
 *   3. GotPrint REST API probe (try alternate auth/endpoints)
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-axiom-up-gaps-${nowISO()}.json`);

function log(msg) { console.log(`[gap] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── AXIOM PRINT ─────────────────────────────────────────────────────────────
// Configurator at /product/roll-labels-335
// Sizes available (from prior passes): 2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5
// Qty options: 250, 500, 1000, 2500 (5k = custom quote)
// Target: 3×4 at all available quantities (closest to our 3×3 benchmark)
async function captureAxiom(context) {
  log('=== Axiom Print capture ===');
  const page = await context.newPage();
  const results = { prices: [], error: null };

  const axiomApiCalls = [];
  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('axiomprint.com') && resp.status() < 400) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json().catch(() => null);
          if (body) axiomApiCalls.push({ url: u, body });
        }
      } catch(_) {}
    }
  });

  try {
    await page.goto('https://www.axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    log('Axiom loaded: ' + page.url());

    // Check page structure
    const structure = await page.evaluate(() => ({
      title: document.title,
      selects: Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        opts: Array.from(s.options).map(o => ({ v: o.value, t: o.text })).slice(0, 20)
      })),
      priceEl: document.querySelector('[class*="price"], [id*="price"], .total')?.textContent?.trim() || null
    }));
    log('Axiom structure: ' + JSON.stringify(structure).slice(0, 800));

    // Find size and qty selects
    const sizeSelect = await page.$('select[name*="size" i], select[name*="Size" i], select#size, select#Size');
    const qtySelect = await page.$('select[name*="qty" i], select[name*="quantity" i], select[name*="Qty" i], select#qty, select#quantity');

    if (!sizeSelect || !qtySelect) {
      // Try by index or label-based approach
      const allSelects = await page.$$('select');
      log('Found ' + allSelects.length + ' select elements');
      results.selectCount = allSelects.length;
      results.structure = structure;
    }

    const targetSizes = ['3" x 4"', '3x4', '3 x 4', '3"x4"'];
    const targetQtys = ['250', '500', '1000', '2500'];

    // Try to select size via select options
    const allSelects = await page.$$('select');
    let sizeSel = null, qtySel = null;

    for (const sel of allSelects) {
      const opts = await sel.evaluate(s => Array.from(s.options).map(o => o.text));
      if (opts.some(o => /3.*4|3x4/i.test(o))) {
        sizeSel = sel;
        log('Found size select: ' + opts.slice(0, 8).join(', '));
      }
      if (opts.some(o => /^250$|^500$|^1000$|^2500$/.test(o.trim()))) {
        qtySel = sel;
        log('Found qty select: ' + opts.slice(0, 8).join(', '));
      }
    }

    if (sizeSel) {
      // Select 3x4 size
      const sizeOpts = await sizeSel.evaluate(s => Array.from(s.options).map(o => ({ v: o.value, t: o.text })));
      const size3x4 = sizeOpts.find(o => /3.*4|3x4/i.test(o.t));
      if (size3x4) {
        await sizeSel.selectOption(size3x4.v);
        log('Selected size: ' + size3x4.t);
        await sleep(2000);
      }
    }

    if (qtySel && sizeSel) {
      const qtyOpts = await qtySel.evaluate(s => Array.from(s.options).map(o => ({ v: o.value, t: o.text })));
      log('Qty options: ' + qtyOpts.map(o => o.t).join(', '));

      for (const qty of ['250', '500', '1000', '2500']) {
        const opt = qtyOpts.find(o => o.t.trim() === qty || o.v === qty);
        if (!opt) { log('No qty option for ' + qty); continue; }

        await qtySel.selectOption(opt.v);
        log('Selected qty: ' + opt.t);
        await sleep(2500);

        // Read price
        const price = await page.evaluate(() => {
          const candidates = [
            document.querySelector('[class*="total-price"], [class*="totalprice"], [class*="price-total"]'),
            document.querySelector('[class*="price"] .amount, [class*="price"] .value'),
            document.querySelector('.price, #price, .total, #total'),
            document.querySelector('[data-price], [data-total]'),
          ].filter(Boolean);
          for (const el of candidates) {
            const t = el.textContent.trim();
            if (/\$[\d,]+/.test(t)) return t;
          }
          // Broader search
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            if (el.children.length === 0) {
              const t = el.textContent.trim();
              if (/^\$[\d,]+(\.\d{2})?$/.test(t)) return t;
            }
          }
          return null;
        });

        // Also check API calls
        const priceCall = axiomApiCalls.find(c => c.body && (c.body.price || c.body.total));

        log(`Axiom 3x4 / ${qty}: DOM price=${price} | API calls=${axiomApiCalls.length}`);
        results.prices.push({
          competitor: 'axiomprint',
          size: '3x4',
          qty: parseInt(qty),
          dom_price: price,
          api_calls: axiomApiCalls.length,
          last_api: axiomApiCalls[axiomApiCalls.length - 1]?.body || null,
        });
      }
    } else {
      log('Could not find size or qty selects — may be React/custom dropdowns');
      results.structure = structure;

      // Take screenshot
      await page.screenshot({ path: path.join(ROOT_DIR, 'data', 'screenshots', 'axiom-gaps-01.png') });
    }

    // Check for all API calls that might contain price data
    results.apiCalls = axiomApiCalls.map(c => ({
      url: c.url.replace('https://www.axiomprint.com', ''),
      bodyPreview: JSON.stringify(c.body).slice(0, 300)
    }));

  } catch(e) {
    err('Axiom: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
  }

  return results;
}

// ─── UPRINTING 4×2 ───────────────────────────────────────────────────────────
// Bootstrap dropdown approach with .dropdown-toggle.val-wrap text matching
// Then Angular scope read for price
async function captureUPrinting4x2(context) {
  log('=== UPrinting 4x2 capture ===');
  const page = await context.newPage();
  const results = { prices: [], error: null };

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    log('UPrinting loaded: ' + page.url());

    // Helper: select option in Bootstrap dropdown by label text
    async function selectBootstrapOption(optionText) {
      // Click the toggle to open dropdown
      const toggles = await page.$$('.dropdown-toggle.val-wrap');
      log('Bootstrap toggles: ' + toggles.length);

      for (const toggle of toggles) {
        const txt = await toggle.textContent();
        log('Toggle text: ' + txt.trim().slice(0, 30));
      }

      // Use evaluate to find and click the right option
      const clicked = await page.evaluate((targetText) => {
        const items = Array.from(document.querySelectorAll('.dropdown-menu li a, .dropdown-menu li'));
        for (const item of items) {
          const t = item.textContent.trim();
          if (t === targetText || t.includes(targetText)) {
            item.click();
            return t;
          }
        }
        return null;
      }, optionText);
      return clicked;
    }

    // First: get current structure
    const dropdowns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-ng-model], [ng-model]')).map(el => ({
        model: el.getAttribute('data-ng-model') || el.getAttribute('ng-model'),
        tag: el.tagName,
        val: el.value,
        id: el.id
      })).slice(0, 20);
    });
    log('Angular models: ' + JSON.stringify(dropdowns).slice(0, 500));

    // Strategy: use Angular scope to set size directly
    const target_sizes_qtys = [
      { width: 4, height: 2, qty: 1000 },
      { width: 4, height: 2, qty: 10000 },
    ];

    for (const spec of target_sizes_qtys) {
      // Try Angular scope injection
      const priceData = await page.evaluate(({ w, h, q }) => {
        try {
          // Find the Angular scope
          const el = document.querySelector('[ng-controller], [data-ng-controller]') ||
                     document.querySelector('.form-group') ||
                     document.querySelector('form');
          if (!el) return { error: 'no ng-controller element' };

          const scope = window.angular && window.angular.element(el).scope();
          if (!scope) return { error: 'no scope' };

          // Log current scope keys related to size/qty
          const keys = Object.keys(scope).filter(k => !k.startsWith('$') && !k.startsWith('_'));
          return { scopeKeys: keys.slice(0, 30), hasScope: true };
        } catch(e) {
          return { error: e.message };
        }
      }, { w: spec.width, h: spec.height, q: spec.qty });

      log(`UP 4x2/${spec.qty} scope probe: ` + JSON.stringify(priceData).slice(0, 200));
    }

    // Alternative: try size dropdown click
    // First find what size options look like
    const sizeInfo = await page.evaluate(() => {
      const allDropdowns = Array.from(document.querySelectorAll('.dropdown'));
      const info = [];
      for (const dd of allDropdowns.slice(0, 10)) {
        const toggle = dd.querySelector('.dropdown-toggle, .val-wrap');
        const items = Array.from(dd.querySelectorAll('li a, li')).map(li => li.textContent.trim()).filter(t => t).slice(0, 10);
        if (toggle || items.length > 0) {
          info.push({ label: toggle?.textContent?.trim()?.slice(0, 30), items });
        }
      }
      return info;
    });
    log('Dropdown info: ' + JSON.stringify(sizeInfo).slice(0, 600));

    // Try clicking dropdown that contains size options
    const clicked = await page.evaluate(() => {
      // Find all dropdowns with size-like options
      const dropdowns = Array.from(document.querySelectorAll('.dropdown'));
      for (const dd of dropdowns) {
        const items = Array.from(dd.querySelectorAll('li a'));
        const hasSize = items.some(a => /\d+"\s*[x×]\s*\d+/i.test(a.textContent));
        if (hasSize) {
          // Click toggle to open
          const toggle = dd.querySelector('[data-toggle="dropdown"], .dropdown-toggle');
          if (toggle) toggle.click();
          return items.map(a => a.textContent.trim()).slice(0, 15);
        }
      }
      return null;
    });
    log('Size dropdown options: ' + JSON.stringify(clicked));

    if (clicked) {
      // Now click 4"×2" option
      await sleep(500);
      const selected = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.dropdown.open li a, .dropdown.show li a'));
        for (const item of items) {
          const t = item.textContent.trim();
          if (/4.*2|4".*2"|4 x 2/i.test(t)) {
            item.click();
            return t;
          }
        }
        return null;
      });
      log('Selected 4x2: ' + selected);
      await sleep(2000);
    }

    // Try qty dropdown at 1000 and 10000
    for (const qty of [1000, 10000]) {
      const qtyClicked = await page.evaluate((targetQty) => {
        // Find and click qty dropdown
        const dropdowns = Array.from(document.querySelectorAll('.dropdown'));
        for (const dd of dropdowns) {
          const items = Array.from(dd.querySelectorAll('li a'));
          const qtyItems = items.filter(a => /^\d[\d,]+$/.test(a.textContent.trim().replace(/,/g, '')));
          if (qtyItems.length > 2) {
            // This is likely the qty dropdown — open it and find target
            const toggle = dd.querySelector('[data-toggle="dropdown"], .dropdown-toggle');
            if (toggle) toggle.click();
            const target = qtyItems.find(a => parseInt(a.textContent.replace(/,/g,'')) === targetQty);
            if (target) { target.click(); return a => parseInt(a.textContent.replace(/,/g,'')) === targetQty; }
            return `opened, items: ${qtyItems.map(a=>a.textContent.trim()).join(',')}`;
          }
        }
        return null;
      }, qty);
      log(`Qty ${qty} click: ` + qtyClicked);
      await sleep(2000);

      // Read price via Angular scope
      const priceResult = await page.evaluate(() => {
        try {
          const els = document.querySelectorAll('[ng-controller], [data-ng-controller], .ang-scope');
          for (const el of els) {
            const scope = window.angular?.element(el).scope();
            if (!scope) continue;
            // Look for price data
            const keys = ['priceData', 'price', 'totalPrice', 'quotePrice', 'orderPrice', 'productPrice', 'pricing'];
            for (const k of keys) {
              if (scope[k] !== undefined) return { key: k, val: scope[k] };
            }
            // Walk scope for price-like numbers
            for (const k of Object.keys(scope)) {
              if (k.startsWith('$')) continue;
              const v = scope[k];
              if (typeof v === 'number' && v > 50 && v < 50000) return { key: k, val: v };
              if (typeof v === 'object' && v && typeof v.price === 'number') return { key: k, val: v };
            }
          }
          // Fallback: DOM price text
          const priceEls = Array.from(document.querySelectorAll('[class*="price"], [id*="price"]'));
          for (const el of priceEls) {
            const t = el.textContent.trim();
            if (/\$[\d,]+\.\d{2}/.test(t)) return { dom: t };
          }
        } catch(e) { return { error: e.message }; }
        return null;
      });

      log(`UP 4x2/${qty} price: ` + JSON.stringify(priceResult));
      results.prices.push({ size: '4x2', qty, result: priceResult });
    }

    await page.screenshot({ path: path.join(ROOT_DIR, 'data', 'screenshots', 'up-4x2-gaps.png') });

  } catch(e) {
    err('UPrinting 4x2: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
  }

  return results;
}

// ─── GOTPRINT REST PROBE ──────────────────────────────────────────────────────
// Try alternate GotPrint API approaches
async function probeGotPrint(context) {
  log('=== GotPrint REST probe ===');
  const results = { endpoints: [], jsBundle: null };

  // Try known GotPrint API structure from their Angular SPA
  const baseUrl = 'https://www.gotprint.com';
  const apiBase = 'https://www.gotprint.com/api';
  const headers = {
    'Origin': baseUrl,
    'Referer': baseUrl + '/products/roll-labels/order',
    'Accept': 'application/json',
  };

  // From prior analysis: GP uses /api/ prefix
  // Try pricing endpoints with params we know from prior form interaction
  // variantId=32 = 3x3 Square-Rounded size; paper_id=12 = White BOPP; finish options needed
  const endpoints = [
    '/api/price?variantId=32&paper_id=12&finish=matte&qty=5000',
    '/api/price?variantId=32&qty=5000',
    '/api/product/roll-labels/price?variantId=32&qty=5000',
    '/api/v1/price?variantId=32&paper_id=12&qty=5000',
    '/api/calculator?variantId=32&qty=5000',
    '/api/products/roll-labels/calculator',
    '/g/api/price?variantId=32&qty=5000',
    '/api/quotes/roll-labels?size=3x3&qty=5000',
    '/api/product-price?product=roll-labels&width=3&height=3&qty=5000',
    '/api/order/price?productCode=roll-labels&width=3&height=3&qty=5000&paper=12&finish=matte',
  ];

  for (const ep of endpoints) {
    try {
      const resp = await context.request.get(baseUrl + ep, { headers });
      const status = resp.status();
      if (status < 404) {
        const body = status === 200 ? await resp.text().catch(() => '') : '';
        results.endpoints.push({ ep, status, preview: body.slice(0, 200) });
        if (status === 200) log('GP 200: ' + ep + ' | ' + body.slice(0, 100));
        else log('GP ' + status + ': ' + ep);
      }
    } catch(e) {
      log('GP ERR: ' + ep + ' - ' + e.message);
    }
  }

  // Also try to find pricing in their JS bundle / main app JS
  try {
    const page = await context.newPage();
    await page.goto(baseUrl + '/products/roll-labels/order', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await sleep(2000);

    // Look for pricing in page source or variables
    const pageData = await page.evaluate(() => {
      // Check window variables for price tables
      const interesting = {};
      for (const k of Object.keys(window)) {
        try {
          const v = window[k];
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            const s = JSON.stringify(v);
            if (s && s.includes('price') && s.length < 5000) {
              interesting[k] = s.slice(0, 500);
            }
          }
        } catch(_) {}
      }
      return {
        title: document.title,
        url: location.href,
        interesting: Object.keys(interesting).slice(0, 5),
        interestingData: Object.fromEntries(Object.entries(interesting).slice(0, 3)),
      };
    });
    log('GP page data: ' + JSON.stringify(pageData).slice(0, 400));
    results.pageData = pageData;
    await page.close();
  } catch(e) {
    log('GP page probe err: ' + e.message);
  }

  return results;
}

async function main() {
  log('=== Gap Fill Pass === ' + nowISO());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 }
  });

  const output = { run_date: new Date().toISOString(), results: {} };

  try {
    // Run Axiom and GotPrint in sequence (same context)
    output.results.axiom = await captureAxiom(context);
    output.results.uprinting4x2 = await captureUPrinting4x2(context);
    output.results.gotprint = await probeGotPrint(context);

    // Summary
    log('\n=== SUMMARY ===');
    log('Axiom prices captured: ' + (output.results.axiom.prices?.length || 0));
    log('UP 4x2 prices captured: ' + (output.results.uprinting4x2.prices?.length || 0));
    log('GP 200 endpoints: ' + output.results.gotprint.endpoints.filter(e => e.status === 200).length);

    const axiomPrices = (output.results.axiom.prices || []).filter(p => p.dom_price);
    if (axiomPrices.length) {
      log('Axiom prices found:');
      axiomPrices.forEach(p => log(`  3x4 / ${p.qty}: ${p.dom_price}`));
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
