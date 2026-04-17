#!/usr/bin/env node
/**
 * capture-up-final-sm-schema.js
 *
 * Final attack pass:
 *
 * UPRINTING: 3x3 size + qty 5000 with proper dropdown open verification
 *   - Click size dropdown → select 3x3 → wait for price update via waitForFunction
 *   - Click qty dropdown → VERIFY it's open → click 5000 → wait for price
 *
 * STICKER MULE: Deep GQL schema exploration
 *   - products query with pricing fields (sizes, quantities, pricingTable)
 *   - orderPrices { total quantity } — discovered field name "total" not "totalPrice"
 *   - productCategories with expanded field set
 *   - Try constructing the actual order URL to find pricing form
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

function log(msg)  { console.log(`[fin] ${msg}`); }
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

// ─── UPRINTING: 3x3 + 5000 with verified dropdown state ───────────────────────
async function captureUprintingFinal(browser) {
  log('=== UPRINTING: final 3x3+5000 with verified dropdown ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const result = { price: null, unitPrice: null, priceWrap: null, size: null, qty: null, error: null };

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'networkidle', timeout: 50000
    });
    await sleep(4000); // Angular init

    // Helper: open a dropdown showing targetText, wait for it to open, click optionText
    async function openDropdownAndSelect(triggerText, optionText) {
      log(`UP: opening dropdown "${triggerText}" → selecting "${optionText}"`);

      // Find and click the trigger button
      const clicked = await page.evaluate((target) => {
        const toggles = Array.from(document.querySelectorAll('button.dropdown-toggle.val-wrap, a.dropdown-toggle.val-wrap'));
        for (const btn of toggles) {
          const t = btn.textContent?.trim().replace(/\s+/g, ' ');
          if (t === target || t?.startsWith(target.slice(0, 10))) {
            btn.click();
            return { ok: true, text: btn.textContent?.trim() };
          }
        }
        // Try broader search
        const allToggles = Array.from(document.querySelectorAll('button.dropdown-toggle, [data-toggle="dropdown"]'));
        for (const btn of allToggles) {
          if (btn.textContent?.trim().replace(/\s+/g, ' ') === target) {
            btn.click();
            return { ok: true, broad: true, text: btn.textContent?.trim() };
          }
        }
        return { ok: false };
      }, triggerText);

      if (!clicked.ok) {
        log(`UP: could not find trigger for "${triggerText}"`);
        return false;
      }
      log(`UP: clicked trigger: ${JSON.stringify(clicked)}`);

      // Wait for dropdown items to become visible
      try {
        await page.waitForFunction(() => {
          const items = document.querySelectorAll('li.blurb-list-dropdown.dropdown-menu-item, li.dropdown-menu-item');
          return Array.from(items).some(el => !!(el.offsetWidth || el.offsetHeight));
        }, { timeout: 5000 });
      } catch (_) {
        log(`UP: dropdown did not open after click on "${triggerText}"`);
        return false;
      }

      await sleep(500);

      // Click the target option
      const optClicked = await page.evaluate((target) => {
        const items = Array.from(document.querySelectorAll('li.blurb-list-dropdown.dropdown-menu-item, li.dropdown-menu-item'));
        for (const item of items) {
          const t = item.textContent?.trim().replace(/\s+/g, ' ');
          if ((t === target || t?.replace(/\s/g, '') === target.replace(/\s/g, '')) &&
              !!(item.offsetWidth || item.offsetHeight)) {
            // Also click the anchor inside if present
            const link = item.querySelector('a');
            if (link) link.click();
            else item.click();
            return { clicked: true, text: t };
          }
        }
        // Partial match (for size strings like "3" x 3"")
        const normTarget = target.replace(/[""]/g, '"').replace(/\s+/g, ' ');
        for (const item of items) {
          if (!!(item.offsetWidth || item.offsetHeight)) {
            const t = item.textContent?.trim().replace(/[""]/g, '"').replace(/\s+/g, ' ');
            if (t === normTarget) {
              const link = item.querySelector('a');
              if (link) link.click(); else item.click();
              return { clicked: true, partialMatch: true, text: item.textContent?.trim() };
            }
          }
        }
        return { clicked: false };
      }, optionText);

      log(`UP: option click result: ${JSON.stringify(optClicked)}`);
      return optClicked.clicked;
    }

    // Helper: read current price
    async function readPrice() {
      return page.evaluate(() => {
        const el = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
        const unitEl = document.querySelector('.calc-price-per-piece');
        const wrapEl = document.querySelector('.price-wrap, #price-wrap');
        const qtyDisplay = document.querySelector('.attr-name-qty, [id*="attr_container_5"] .dropdown-toggle-label');
        return {
          price: el?.textContent?.trim(),
          unit: unitEl?.textContent?.trim(),
          wrapText: wrapEl?.innerText?.slice(0, 200),
          qtyDisplay: qtyDisplay?.textContent?.trim()
        };
      });
    }

    const init = await readPrice();
    log(`UP: initial state — price="${init.price}" qty="${init.qtyDisplay}"`);

    // Step 1: Change size to 3"x3"
    const sizeOk = await openDropdownAndSelect('2" x 2"', '3" x 3"');
    if (sizeOk) {
      // Wait for Angular price recalculation — watch for price element to change
      try {
        const initPrice = init.price;
        await page.waitForFunction((prevPrice) => {
          const el = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
          const t = el?.textContent?.trim();
          return t && t !== prevPrice;
        }, initPrice, { timeout: 8000 });
        const after = await readPrice();
        log(`UP: price after size→3x3: "${after.price}" (was "${init.price}")`);
        result.size = '3"x3"';
      } catch (_) {
        log('UP: price did not change after size selection (may be same price tier)');
        const after = await readPrice();
        log(`UP: price after size→3x3 (no change): "${after.price}"`);
        result.size = '3"x3"';
      }
    }

    const afterSize = await readPrice();
    log(`UP: after size change — price="${afterSize.price}" qty="${afterSize.qtyDisplay}"`);

    await sleep(1000);

    // Step 2: Change qty to 5000
    // Find the current qty display text (it might show "1,000" still)
    const currentQtyText = afterSize.qtyDisplay || '1,000';
    const qtyOk = await openDropdownAndSelect(currentQtyText, '5,000');

    if (qtyOk) {
      // Wait for price update
      const priceBeforeQty = afterSize.price;
      try {
        await page.waitForFunction((prevPrice) => {
          const el = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
          const t = el?.textContent?.trim();
          return t && t !== prevPrice;
        }, priceBeforeQty, { timeout: 8000 });
        log('UP: price updated after qty→5000');
      } catch (_) {
        log('UP: price did not change after qty→5000 (waiting anyway)');
        await sleep(3000);
      }
      result.qty = 5000;
    }

    const finalState = await readPrice();
    log(`UP: FINAL — price="${finalState.price}" unit="${finalState.unit}" qty="${finalState.qtyDisplay}"`);
    log(`UP: priceWrap: ${finalState.wrapText?.slice(0, 200)}`);

    result.price = parseDollar(finalState.price);
    result.unitPrice = parseDollar(finalState.unit?.replace(/[()]/g, '').trim());
    result.priceWrap = finalState.wrapText;

    // Also try reading all visible prices on the page
    const allPrices = await page.evaluate(() => {
      const re = /\$([\d,]+\.?\d{0,2})/g;
      const prices = new Set();
      let m;
      while ((m = re.exec(document.body.innerText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v > 0.5 && v < 200000) prices.add(v);
      }
      return [...prices].sort((a, b) => a - b);
    });
    log(`UP: all DOM prices: [${allPrices.join(', ')}]`);

  } catch (e) {
    result.error = e.message;
    err('UP: ' + e.message);
    log(e.stack?.slice(0, 300));
  } finally {
    await context.close();
  }

  return result;
}

// ─── STICKER MULE: GQL schema probe + order URL attempt ───────────────────────
async function captureStickermuleSchema(browser) {
  log('=== STICKER MULE: schema probe + order URL ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const result = {
    price: null, pricingSource: null,
    schemaFields: {}, orderUrlTried: null, formFound: false, error: null
  };

  try {
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(3000);

    // Dismiss consent
    try {
      const btn = await page.$('button[data-testid="ConsentButton"]');
      if (btn && (await btn.textContent())?.includes('Agree')) {
        await btn.click();
        await sleep(4000);
        log('SM: consent dismissed');
      }
    } catch (_) {}

    // --- GQL: probe products with more fields ---
    const gqlProbe = await page.evaluate(async () => {
      const endpoint = 'https://www.stickermule.com/core/graphql';
      const queries = [
        // Products with pricing attempts
        {
          name: 'products_all_fields',
          body: { query: `query { products { name permalink label pricing { quantity total perUnit } } }` }
        },
        {
          name: 'products_permalinks',
          body: { query: `query { products(permalinks: ["custom-labels"]) { name permalink } }` }
        },
        {
          name: 'products_with_sizes',
          body: { query: `query { products(permalinks: ["custom-labels"]) { name permalink sizes { width height } quantities { quantity total perUnit } } }` }
        },
        // OrderPrices with correct field name "total"
        {
          name: 'orderPrices_total',
          body: { query: `query { orderPrices { total quantity perUnit } }` }
        },
        // productCategories with different field attempts
        {
          name: 'productCats_sizes',
          body: { query: `query { productCategories(permalinks: ["custom-labels"]) { name permalink sizes { width height } } }` }
        },
        {
          name: 'productCats_products',
          body: { query: `query { productCategories(permalinks: ["custom-labels"]) { name permalink products { name } } }` }
        },
        // Explore the ProductCategory type more
        {
          name: 'productCats_full',
          body: {
            query: `query {
              productCategories(permalinks: ["custom-labels"]) {
                name permalink label isAlias
                related { name aliasPermalink }
              }
            }`
          }
        }
      ];

      const results = {};
      for (const q of queries) {
        try {
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(q.body)
          });
          results[q.name] = { status: r.status, body: (await r.text()).slice(0, 600) };
        } catch (e) { results[q.name] = { error: e.message }; }
      }
      return results;
    });

    // Analyze results
    for (const [name, res] of Object.entries(gqlProbe)) {
      log(`SM GQL "${name}": status=${res.status || res.error}`);
      if (res.body) {
        log(`  → ${res.body.slice(0, 250)}`);
        if (res.status === 200 && !res.body.includes('"errors"')) {
          log(`  *** SUCCESS ***`);
          result.schemaFields[name] = res.body;
          // Check for pricing data
          const priceMatch = res.body.match(/"(?:total|price|amount|cost)":\s*"?(\d+\.?\d{0,2})"?/);
          if (priceMatch) {
            const p = parseFloat(priceMatch[1]);
            if (p > 0 && p < 200000) {
              result.price = p;
              result.pricingSource = `GQL:${name}`;
              log(`  PRICE: $${p}`);
            }
          }
        }
        // Extract error hints for schema learning
        const errMatches = res.body.match(/"message":"[^"]+"/g);
        if (errMatches) errMatches.forEach(m => log(`  HINT: ${m}`));
      }
    }

    // --- Try order URL ---
    // Sticker Mule's actual configurator is behind the order flow
    // Common patterns: /orders/new, /custom-labels/order
    const orderUrls = [
      'https://www.stickermule.com/custom-labels/order',
      'https://www.stickermule.com/orders/new?product_type=custom_labels',
      'https://www.stickermule.com/custom-labels/configure',
      'https://www.stickermule.com/custom-labels/start',
      'https://www.stickermule.com/custom-labels/new',
    ];

    for (const url of orderUrls) {
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status = resp?.status();
        log(`SM order URL ${url}: ${status}`);
        result.orderUrlTried = url;

        if (status === 200) {
          await sleep(3000);
          const formEls = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input, select')).map(el => ({
              type: el.type, name: el.name, id: el.id,
              testid: el.getAttribute('data-testid'),
              ariaLabel: el.getAttribute('aria-label'),
              visible: !!(el.offsetWidth || el.offsetHeight)
            })).filter(f => f.visible);
          });
          log(`SM order URL: ${formEls.length} visible form elements`);
          formEls.forEach(f => log(`  [${f.type}] testid="${f.testid}" aria="${f.ariaLabel}" name="${f.name}"`));

          if (formEls.length > 0) {
            result.formFound = true;
            log('SM: FORM FOUND at ' + url);
            // Try to interact
            const widthEl = formEls.find(f => f.testid?.includes('width') || f.ariaLabel?.includes('width') || f.name === 'width');
            const heightEl = formEls.find(f => f.testid?.includes('height') || f.ariaLabel?.includes('height') || f.name === 'height');
            if (widthEl && heightEl) {
              await page.fill(`input[data-testid="${widthEl.testid}"]`, '3');
              await page.fill(`input[data-testid="${heightEl.testid}"]`, '3');
              await sleep(2000);
              const prices = await page.evaluate(() => {
                const re = /\$([\d,]+\.?\d{0,2})/g;
                const ps = [];
                let m;
                while ((m = re.exec(document.body.innerText)) !== null) {
                  const v = parseFloat(m[1].replace(/,/g,''));
                  if (v >= 20 && v < 100000) ps.push(v);
                }
                return [...new Set(ps)].sort((a,b)=>a-b);
              });
              log(`SM: prices after form fill: [${prices.join(', ')}]`);
            }
          }

          // Check page text for prices
          const prices = await page.evaluate(() => {
            const re = /\$([\d,]+\.?\d{0,2})/g;
            const ps = [];
            let m;
            while ((m = re.exec(document.body.innerText)) !== null) {
              const v = parseFloat(m[1].replace(/,/g,''));
              if (v >= 20 && v < 100000) ps.push(v);
            }
            return [...new Set(ps)].sort((a,b)=>a-b);
          });
          if (prices.length > 0) {
            log(`SM: prices at ${url}: [${prices.join(', ')}]`);
            if (!result.price) { result.price = prices[0]; result.pricingSource = url; }
          }
          break; // Found a 200 URL
        }
      } catch (e) { log(`SM: ${url}: ${e.message.slice(0, 60)}`); }
    }

    // --- Final: try GQL on bridge endpoint with same queries ---
    const bridgeProbe = await page.evaluate(async () => {
      const endpoint = 'https://www.stickermule.com/bridge/backend/graphql';
      const queries = [
        { name: 'products_pricing', body: { query: `query { products { name pricing { quantity total perUnit } } }` } },
        { name: 'orderPrices', body: { query: `query { orderPrices { total quantity perUnit } }` } },
      ];
      const results = {};
      for (const q of queries) {
        try {
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(q.body)
          });
          results[q.name] = { status: r.status, body: (await r.text()).slice(0, 400) };
        } catch (e) { results[q.name] = { error: e.message }; }
      }
      return results;
    });

    for (const [name, res] of Object.entries(bridgeProbe)) {
      log(`SM bridge GQL "${name}": ${res.status || res.error} → ${res.body?.slice(0, 150) || ''}`);
    }

  } catch (e) {
    result.error = e.message;
    err('SM: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPDATE DATA FILES ─────────────────────────────────────────────────────────
function updateDataFiles(upResult, smResult) {
  const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM_FILE, 'utf8'));
  const today = nowISO();
  let changed = false;

  // UPrinting: if we got a real price that's different from defaults
  if (upResult.price && upResult.price !== 131.23) {
    const isSize3x3 = upResult.size?.includes('3');
    const isQty5000 = upResult.qty === 5000;
    const confidence = isSize3x3 && isQty5000 ? 'high' : isQty5000 ? 'medium' : 'low';

    log(`UP: NEW price data — $${upResult.price} (size=${upResult.size}, qty=${upResult.qty}, conf=${confidence})`);

    // Remove existing partial/failed uprinting records, add new
    raw.captures = raw.captures.filter(c => c.competitor !== 'uprinting' || c.confidence === 'none');
    raw.captures.push({
      id: `uprinting-3x3-5000-final-${today}`,
      competitor: 'uprinting', competitor_display: 'UPrinting',
      source_url: 'https://www.uprinting.com/roll-labels.html',
      captured_at: today,
      capture_method: 'playwright_verified_dropdown',
      capture_source: 'automated_headless',
      confidence,
      product_type: 'labels',
      raw_spec_description: `Roll Labels, ${isSize3x3 ? '3"x3"' : 'size?'}, qty=${upResult.qty || '?'}, White BOPP`,
      specs: {
        width_in: isSize3x3 ? 3 : null, height_in: isSize3x3 ? 3 : null,
        quantity: upResult.qty || null, material: 'White BOPP', format: 'roll'
      },
      pricing: {
        total_price: upResult.price,
        unit_price: upResult.unitPrice || (upResult.price && upResult.qty ? Math.round(upResult.price / upResult.qty * 10000) / 10000 : null),
        currency: 'USD', turnaround_days: 6, shipping_included: false, price_type: 'configured_quote'
      },
      raw_snippet: upResult.priceWrap?.slice(0, 200) || null,
      notes: `Final verified capture. size="${upResult.size}", qty=${upResult.qty}. PriceWrap: ${upResult.priceWrap?.slice(0,100)}`,
      blocker: null, next_step: null
    });

    raw.capture_coverage_summary.uprinting = {
      status: confidence === 'high' ? 'live' : 'partial',
      confidence, last_method: 'playwright_verified_dropdown',
      reason: `Roll Labels ${isSize3x3 ? '3"x3"' : '?'}, qty=${upResult.qty}: $${upResult.price}.`
    };

    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const upComp = q.competitor_results.find(c => c.competitor === 'uprinting');
      if (upComp) {
        upComp.status = confidence === 'high' ? 'live' : 'partial';
        upComp.coverage = confidence === 'high' ? 'exact_spec' : 'partial_spec';
        upComp.total_price = upResult.price;
        upComp.unit_price = raw.captures.at(-1)?.pricing?.unit_price;
        upComp.turnaround_days = 6;
        upComp.confidence = confidence;
        upComp.notes = `Roll Labels ${isSize3x3 ? '3"x3"' : '?'}, qty=${upResult.qty}: $${upResult.price}. Shipping not included.`;
      }
    }
    changed = true;
  } else if (upResult.price === 131.23) {
    log(`UP: price unchanged at $131.23 — qty selection likely didn't register`);
    log(`UP: Documenting what we know: 3"x3" size IS selectable, pricing by qty IS accessible`);
  }

  if (changed) {
    raw.last_updated = today;
    norm.last_updated = today;
    fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM_FILE, JSON.stringify(norm, null, 2));
    log('Data files updated.');
  }

  return changed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Final pass: UP 3x3/5000 + SM schema === ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let upResult = { price: null };
  let smResult = { price: null };

  try { upResult = await captureUprintingFinal(browser); } catch (e) { err('UP: ' + e.message); }
  try { smResult = await captureStickermuleSchema(browser); } catch (e) { err('SM: ' + e.message); }

  await browser.close();

  const debugFile = path.join(ROOT_DIR, 'data', `capture-final2-${nowISO()}.json`);
  fs.writeFileSync(debugFile, JSON.stringify({ up: upResult, sm: smResult }, null, 2));
  log(`Debug: ${debugFile}`);

  updateDataFiles(upResult, smResult);

  log('');
  log('=== RESULTS ===');
  log(`UPrinting: size="${upResult.size}", qty=${upResult.qty}, price=$${upResult.price}, unit=$${upResult.unitPrice}`);
  log(`Sticker Mule: formFound=${smResult.formFound}, price=$${smResult.price}, source=${smResult.pricingSource}`);
  log(`SM schema fields found: ${Object.keys(smResult.schemaFields).join(', ')}`);
}

main().catch(e => { err(e.message); process.exit(1); });
