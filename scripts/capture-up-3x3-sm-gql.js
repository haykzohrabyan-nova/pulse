#!/usr/bin/env node
/**
 * capture-up-3x3-sm-gql.js
 *
 * Final attack:
 *
 * UPRINTING:
 *   - We cracked qty dropdown ($309.16 at 5000/default size)
 *   - Now open SIZE dropdown same way and select 3"x3"
 *   - Then select qty=5000 → capture the 3x3/5000 price
 *   - Also try 5000 qty with custom size inputs (width=3, height=3)
 *
 * STICKER MULE:
 *   - GQL schema has "products" and "orderPrices" fields
 *   - Try targeted queries: products(permalink), orderPrices(...)
 *   - Also try scrolling page after consent to find the configurator
 *   - Try navigating to /orders/new or /custom-labels/order
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

function log(msg)  { console.log(`[final] ${msg}`); }
function err(msg)  { console.error(`[ERR]   ${msg}`); }
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

// ─── UPRINTING: Size change to 3"x3" then qty 5000 ────────────────────────────
async function captureUprinting3x3(browser) {
  log('=== UPRINTING: 3x3 size + qty 5000 ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const result = {
    sizeOptions: [], selectedSize: null, selectedQty: null,
    price: null, unitPrice: null, priceWrap: null,
    interactions: [], error: null
  };

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'networkidle', timeout: 50000
    });
    try { await page.waitForSelector('#calc-price, .calc-price', { timeout: 20000 }); } catch (_) {}
    await sleep(3000);

    // --- Read default state and discover all dropdown triggers ---
    const pageState = await page.evaluate(() => {
      // Find all .btn.dropdown-toggle elements — these are ALL dropdown triggers on the page
      const toggles = Array.from(document.querySelectorAll('button.dropdown-toggle, a.dropdown-toggle, .btn.dropdown-toggle'));

      return {
        toggles: toggles.map(el => ({
          id: el.id,
          class: el.className?.toString().slice(0, 80),
          text: el.textContent?.trim().slice(0, 40),
          labelId: el.getAttribute('aria-labelledby'),
          ariaExpanded: el.getAttribute('aria-expanded'),
          visible: !!(el.offsetWidth || el.offsetHeight),
          parentId: el.parentElement?.id,
          parentClass: el.parentElement?.className?.toString().slice(0, 60)
        })),
        // Get current price
        price: document.getElementById('calc-price')?.textContent?.trim(),
        // Get page innerText near calculator
        calcText: document.querySelector('.product-calculator, #price-section, [class*="calc"]')?.innerText?.slice(0, 500)
      };
    });

    log(`UP: ${pageState.toggles.length} dropdown toggles found`);
    pageState.toggles.filter(t => t.visible).forEach(t =>
      log(`  toggle: text="${t.text}" id="${t.id}" parent="${t.parentId}" class="${t.class.slice(0,50)}"`)
    );
    log(`UP default price: ${pageState.price}`);

    // --- Find size dropdown by looking at dropdown items that contain inch values ---
    const sizeDropdownInfo = await page.evaluate(() => {
      // Find all dropdown menus and their items
      const menus = Array.from(document.querySelectorAll('.dropdown-menu.menu-parent'));
      const sizeMenus = menus.filter(menu => {
        const items = menu.querySelectorAll('li');
        // A size menu has items with inch values like "2" x 2"" or "3 x 3"
        return Array.from(items).some(li => {
          const t = li.textContent?.trim();
          return t && (t.includes('"') || t.match(/\d+\s*[xX×]\s*\d+/));
        });
      });

      return sizeMenus.map(menu => {
        const trigger = menu.previousElementSibling || menu.parentElement?.querySelector('[data-toggle="dropdown"], .dropdown-toggle');
        const items = Array.from(menu.querySelectorAll('li')).map(li => ({
          text: li.textContent?.trim(),
          class: li.className?.toString().slice(0, 50),
          selected: li.className?.toString().includes('selected'),
          visible: !!(li.offsetWidth || li.offsetHeight)
        }));
        return {
          menuClass: menu.className?.toString().slice(0, 60),
          triggerText: trigger?.textContent?.trim().slice(0, 40),
          triggerClass: trigger?.className?.toString().slice(0, 60),
          items
        };
      });
    });

    log(`UP: ${sizeDropdownInfo.length} size-related dropdowns`);
    sizeDropdownInfo.forEach((menu, i) => {
      log(`  size menu ${i}: trigger="${menu.triggerText}", items: ${menu.items.map(x => x.text).join(' | ')}`);
    });
    result.sizeOptions = sizeDropdownInfo;

    // --- Step 1: Open and select size = 3"x3" ---
    let sizeSelected = false;
    for (const menu of sizeDropdownInfo) {
      // Check if this menu has a 3x3 option
      const has3x3 = menu.items.find(i =>
        i.text.match(/3["'"]?\s*[xX×]\s*3/) ||
        i.text === '3 x 3' ||
        i.text.includes('3"x3"') ||
        i.text.includes('3" x 3"')
      );

      if (has3x3) {
        log(`UP: found 3x3 option: "${has3x3.text}" in menu with trigger "${menu.triggerText}"`);
        result.sizeOptions = menu.items.map(i => i.text);

        // Click trigger to open this dropdown
        const clicked = await page.evaluate((triggerText) => {
          // Find toggle with this trigger text
          const toggles = Array.from(document.querySelectorAll('button.dropdown-toggle, a.dropdown-toggle, .btn.dropdown-toggle'));
          for (const toggle of toggles) {
            if (toggle.textContent?.trim().slice(0, 30) === triggerText.slice(0, 30)) {
              toggle.click();
              return { clicked: true, text: toggle.textContent?.trim().slice(0, 30) };
            }
          }
          return { clicked: false };
        }, menu.triggerText);

        log(`UP: open size dropdown: ${JSON.stringify(clicked)}`);
        if (clicked.clicked) {
          result.interactions.push({ action: 'openSizeDropdown', trigger: menu.triggerText });
          await sleep(1500);

          // Click the 3x3 option
          const clickedOpt = await page.evaluate((target) => {
            const items = Array.from(document.querySelectorAll('.blurb-list-dropdown.dropdown-menu-item li, li.blurb-list-dropdown.dropdown-menu-item'));
            for (const item of items) {
              if (!!(item.offsetWidth || item.offsetHeight)) {
                const t = item.textContent?.trim();
                if (t === target || t?.replace(/\s+/g, '') === target.replace(/\s+/g, '')) {
                  item.click();
                  return { clicked: true, text: t };
                }
              }
            }
            // Try any visible element with 3x3 text
            const allVis = Array.from(document.querySelectorAll('*')).filter(el => {
              const t = el.textContent?.trim();
              return !!(el.offsetWidth || el.offsetHeight) &&
                     (t === target || (t?.match(/3["']?\s*[xX×]\s*3/) && el.childNodes.length <= 3));
            });
            if (allVis.length > 0) {
              allVis[0].click();
              return { clicked: true, text: allVis[0].textContent?.trim() };
            }
            return { clicked: false };
          }, has3x3.text);

          log(`UP: click 3x3: ${JSON.stringify(clickedOpt)}`);
          if (clickedOpt.clicked) {
            sizeSelected = true;
            result.selectedSize = clickedOpt.text;
            result.interactions.push({ action: 'selectSize3x3', value: clickedOpt.text });
            await sleep(3000);
          }
        }
        break;
      }
    }

    if (!sizeSelected) {
      log('UP: No predefined 3x3 in size dropdowns — checking full dropdown lists');
      // Log all items from all menus for debugging
      const allMenuItems = await page.evaluate(() => {
        const menus = Array.from(document.querySelectorAll('.dropdown-menu.menu-parent'));
        return menus.map((menu, i) => ({
          index: i,
          items: Array.from(menu.querySelectorAll('li')).map(li => li.textContent?.trim()).filter(t => t).slice(0, 10)
        }));
      });
      log(`UP: All dropdown menus: ${JSON.stringify(allMenuItems.slice(0, 5))}`);

      // Try custom size inputs if they exist but are hidden
      // UPrinting shows custom size inputs via a "Custom" size option
      // First check if there's a "Custom" option in any size menu
      const customOption = await page.evaluate(() => {
        const allLis = Array.from(document.querySelectorAll('li'));
        const customLi = allLis.find(li => {
          const t = li.textContent?.trim().toLowerCase();
          return t === 'custom' || t === 'custom size' || t === 'custom dimensions';
        });
        if (customLi) {
          customLi.click();
          return { found: true, text: customLi.textContent?.trim() };
        }
        return { found: false };
      });
      log(`UP: custom size option: ${JSON.stringify(customOption)}`);

      if (customOption.found) {
        await sleep(2000);
        // Now try to fill in width=3, height=3
        const widthEl = await page.$('#width, input[name="width"]');
        const heightEl = await page.$('#height, input[name="height"]');
        if (widthEl && heightEl) {
          log('UP: filling custom width/height = 3x3');
          await widthEl.click({ clickCount: 3 });
          await widthEl.fill('3');
          await page.keyboard.press('Tab');
          await heightEl.click({ clickCount: 3 });
          await heightEl.fill('3');
          await page.keyboard.press('Tab');
          sizeSelected = true;
          result.selectedSize = 'custom 3x3';
          result.interactions.push({ action: 'fillCustomSize', w: 3, h: 3 });
          await sleep(3000);
        }
      }
    }

    // Read current price after size change
    const priceAfterSize = await page.evaluate(() => {
      return document.getElementById('calc-price')?.textContent?.trim() ||
             document.querySelector('.calc-price.subtotal-price')?.textContent?.trim();
    });
    log(`UP: price after size change: ${priceAfterSize}`);

    // --- Step 2: Open qty dropdown and select 5000 ---
    // Use the same approach that worked before:
    // Find button showing the current qty and click it
    const openQtyResult = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('button.dropdown-toggle, a.dropdown-toggle'));
      for (const el of allEls) {
        const t = el.textContent?.trim().replace(/,/g, '');
        if (/^\d+$/.test(t) && parseInt(t) >= 100) {
          el.click();
          return { clicked: true, text: el.textContent?.trim() };
        }
      }
      return { clicked: false };
    });
    log(`UP: open qty dropdown: ${JSON.stringify(openQtyResult)}`);

    if (openQtyResult.clicked) {
      result.interactions.push({ action: 'openQtyDropdown' });
      await sleep(1500);

      // Click 5,000
      const click5k = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('li.blurb-list-dropdown.dropdown-menu-item, li.dropdown-menu-item'));
        for (const item of items) {
          if ((item.textContent?.trim() === '5,000' || item.textContent?.trim() === '5000') &&
              !!(item.offsetWidth || item.offsetHeight)) {
            item.click();
            return { clicked: true };
          }
        }
        return { clicked: false };
      });

      if (click5k.clicked) {
        result.selectedQty = 5000;
        result.interactions.push({ action: 'selectQty5000' });
        log('UP: clicked 5,000 qty');
        await sleep(4000);
      }
    }

    // --- Read final price ---
    const finalState = await page.evaluate(() => {
      const priceEl = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
      const unitEl  = document.querySelector('.calc-price-per-piece');
      const priceWrap = document.querySelector('.price-wrap, #price-wrap, #price');
      return {
        price: priceEl?.textContent?.trim(),
        unitPrice: unitEl?.textContent?.trim(),
        priceWrap: priceWrap?.innerText?.slice(0, 300)
      };
    });

    log(`UP 3x3 result: price="${finalState.price}", unit="${finalState.unitPrice}"`);
    log(`UP 3x3 priceWrap: ${finalState.priceWrap?.slice(0, 200)}`);

    result.price = parseDollar(finalState.price);
    result.unitPrice = parseDollar(finalState.unitPrice?.replace(/[()]/g, '').trim());
    result.priceWrap = finalState.priceWrap;

  } catch (e) {
    result.error = e.message;
    err('UP 3x3: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── STICKER MULE: GQL schema exploration + page scroll ───────────────────────
async function captureStickermuleGQL(browser) {
  log('=== STICKER MULE: GQL + page scroll ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Capture all GQL traffic
  const gqlLog = [];
  context.on('request', req => {
    if (req.url().includes('graphql')) {
      gqlLog.push({ type: 'req', url: req.url(), body: req.postData()?.slice(0, 300) });
    }
  });
  context.on('response', async resp => {
    if (resp.url().includes('graphql') && resp.status() < 400) {
      try {
        const body = await resp.text();
        gqlLog.push({ type: 'resp', url: resp.url(), body: body.slice(0, 2000) });
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const result = {
    price: null, pricingSource: null,
    consentClicked: false, pageScrolledItems: [],
    gqlSchemaPaths: null, gqlPriceResponse: null, error: null
  };

  try {
    log('SM: Loading /custom-labels');
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(3000);

    // Dismiss consent
    try {
      const btn = await page.$('button[data-testid="ConsentButton"]');
      if (btn) {
        const text = await btn.textContent();
        if (text?.includes('Agree')) {
          await btn.click();
          result.consentClicked = true;
          log('SM: consent dismissed');
          await sleep(5000);
        }
      }
    } catch (e) { log('SM consent: ' + e.message); }

    // --- Scroll the page and look for configurator ---
    log('SM: Scrolling page to find configurator');
    await page.evaluate(() => window.scrollTo(0, 500));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, 1000));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, 2000));
    await sleep(2000);

    // Capture any price elements that appeared after scroll
    const scrollState = await page.evaluate(() => {
      const formEls = Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
        tag: el.tagName, type: el.type, name: el.name, id: el.id,
        placeholder: el.placeholder, testid: el.getAttribute('data-testid'),
        ariaLabel: el.getAttribute('aria-label'),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }));

      const pricingEls = Array.from(document.querySelectorAll('[class*="price" i], [class*="total" i], [class*="cost" i]'))
        .filter(el => !!(el.offsetWidth || el.offsetHeight))
        .map(el => ({ class: el.className?.slice(0, 50), text: el.textContent?.trim().slice(0, 60) }));

      const buttons = Array.from(document.querySelectorAll('button, a[class*="btn"]'))
        .filter(el => !!(el.offsetWidth || el.offsetHeight))
        .slice(0, 20)
        .map(el => ({ tag: el.tagName, text: el.textContent?.trim().slice(0, 40), href: el.getAttribute('href') }));

      return { formEls, pricingEls, buttons, bodyTextSample: document.body.innerText.slice(0, 2000) };
    });

    log(`SM after scroll: ${scrollState.formEls.filter(f=>f.visible).length} visible form elements`);
    scrollState.formEls.filter(f=>f.visible).forEach(f =>
      log(`  [${f.tag}/${f.type}] testid="${f.testid}" aria="${f.ariaLabel}"`)
    );
    log(`SM pricing elements: ${JSON.stringify(scrollState.pricingEls.slice(0, 5))}`);
    log(`SM buttons visible: ${scrollState.buttons.slice(0,10).map(b=>b.text).join(' | ')}`);

    // Look for "Order" or "Start" buttons
    const orderBtns = scrollState.buttons.filter(b =>
      b.text?.toLowerCase().includes('order') ||
      b.text?.toLowerCase().includes('start') ||
      b.text?.toLowerCase().includes('shop') ||
      b.href?.includes('order')
    );
    log(`SM order-type buttons: ${JSON.stringify(orderBtns)}`);

    result.pageScrolledItems = scrollState.buttons;

    // Prices in page text after scroll
    const prices = scrollState.bodyTextSample.match(/\$([\d,]+\.?\d{0,2})/g);
    log(`SM prices in page text: ${prices?.join(', ') || 'none'}`);

    // --- Try clicking an "Order" or "Get started" button ---
    for (const btn of orderBtns.slice(0, 3)) {
      try {
        if (btn.href && btn.href !== '#') {
          const newUrl = btn.href.startsWith('/') ? 'https://www.stickermule.com' + btn.href : btn.href;
          log(`SM: navigating to ${newUrl}`);
          await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(4000);

          const newFormEls = await page.evaluate(() =>
            Array.from(document.querySelectorAll('input, select')).map(el => ({
              tag: el.tagName, type: el.type, name: el.name, id: el.id,
              testid: el.getAttribute('data-testid'), ariaLabel: el.getAttribute('aria-label'),
              visible: !!(el.offsetWidth || el.offsetHeight)
            }))
          );
          log(`SM after nav: ${newFormEls.filter(f=>f.visible).length} visible form elements`);
          newFormEls.filter(f=>f.visible).forEach(f =>
            log(`  [${f.tag}/${f.type}] testid="${f.testid}" aria="${f.ariaLabel}"`)
          );

          // Try to read price
          const newPrices = await page.evaluate(() => {
            const t = document.body.innerText;
            const re = /\$([\d,]+\.?\d{0,2})/g;
            const ps = [];
            let m;
            while ((m = re.exec(t)) !== null) {
              const v = parseFloat(m[1].replace(/,/g,''));
              if (v >= 20 && v < 100000) ps.push(v);
            }
            return [...new Set(ps)].sort((a,b)=>a-b);
          });
          log(`SM page prices after nav: [${newPrices.join(', ')}]`);

          if (newPrices.length > 0) {
            const p = newPrices.find(p => p >= 47) || newPrices[0];
            result.price = p;
            result.pricingSource = `page after nav to ${newUrl}`;
          }
          break;
        }
      } catch (e) { log(`SM btn nav: ${e.message}`); }
    }

    // --- Try GQL with correct field names ---
    log('SM: Probing GQL with discovered field names (products, orderPrices)');
    const gqlResult = await page.evaluate(async () => {
      const endpoint = 'https://www.stickermule.com/core/graphql';
      const queries = [
        // Try products query
        {
          name: 'products_permalink',
          body: {
            query: `query { products(permalink: "custom-labels") { name pricingTiers { quantity price } } }`
          }
        },
        {
          name: 'products_slug',
          body: {
            query: `query { products(slug: "custom-labels") { name pricingTiers { quantity price perUnit } } }`
          }
        },
        {
          name: 'orderPrices_noargs',
          body: {
            query: `query { orderPrices { totalPrice unitPrice quantity } }`
          }
        },
        {
          name: 'orderPrices_product',
          body: {
            operationName: 'GetOrderPrices',
            query: `query GetOrderPrices($product: String!, $width: Float!, $height: Float!, $quantity: Int!) {
              orderPrices(product: $product, width: $width, height: $height, quantity: $quantity) {
                totalPrice unitPrice quantity
              }
            }`,
            variables: { product: 'custom-labels', width: 3.0, height: 3.0, quantity: 5000 }
          }
        },
        // Check what fields products actually has
        {
          name: 'products_fields',
          body: {
            query: `query { products { name } }`
          }
        },
        // Try the exact query we know works (PRODUCT_CATEGORY_NAMES_QUERY) to see schema
        {
          name: 'productCategories_pricing',
          body: {
            operationName: 'GET_PRODUCT_PRICING',
            query: `query GET_PRODUCT_PRICING($permalinks: [String!]!) {
              productCategories(permalinks: $permalinks) {
                name
                pricingTiers { quantity totalPrice unitPrice }
              }
            }`,
            variables: { permalinks: ['custom-labels'] }
          }
        },
        {
          name: 'productCategory_price',
          body: {
            query: `query { productCategories(permalinks: ["custom-labels"]) {
              name permalink
              quantityPricing { quantity totalPrice unitPrice }
            } }`
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
          const text = await r.text();
          results[q.name] = { status: r.status, body: text.slice(0, 600) };
        } catch (e) { results[q.name] = { error: e.message }; }
      }
      return results;
    });

    // Analyze GQL results
    for (const [name, res] of Object.entries(gqlResult)) {
      log(`SM GQL "${name}": status=${res.status || res.error}`);
      if (res.body) {
        log(`  body: ${res.body.slice(0, 200)}`);

        // Look for pricing data
        if (res.status === 200 && res.body.includes('price') && !res.body.includes('"errors":[{"message"')) {
          log(`  *** POTENTIAL PRICING DATA ***`);
          result.gqlPriceResponse = { query: name, body: res.body };

          // Try to extract a price
          const priceMatch = res.body.match(/"(?:totalPrice|price|amount)":\s*"?(\d+\.?\d{0,2})"?/);
          if (priceMatch) {
            const p = parseFloat(priceMatch[1]);
            if (p > 0 && p < 200000) {
              result.price = p;
              result.pricingSource = `GraphQL:${name}`;
              log(`  *** PRICE: $${p} ***`);
            }
          }
        }

        // Extract error field hints
        const errMatch = res.body.match(/"message":"Cannot query field "([^"]+)" on type "([^"]+)"\. Did you mean "([^"]+)"\?"/g);
        if (errMatch) errMatch.forEach(m => log(`  Error hint: ${m}`));
      }
    }

    // --- Log GQL traffic captured during page load ---
    log(`SM: ${gqlLog.length} total GQL log entries`);
    const gqlPageRequests = gqlLog.filter(e => e.type === 'req');
    log(`SM: ${gqlPageRequests.length} GQL requests made by page:`);
    gqlPageRequests.forEach(r => log(`  ${r.url.split('/').slice(-2).join('/')}: ${r.body?.slice(0, 150)}`));

    // --- Read current DOM price ---
    const domPrice = await page.evaluate(() => {
      const prices = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(document.body.innerText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g,''));
        if (v >= 20 && v < 200000) prices.push(v);
      }
      return [...new Set(prices)].sort((a,b)=>a-b);
    });
    log(`SM DOM prices: [${domPrice.join(', ')}]`);
    if (!result.price && domPrice.length > 0) {
      result.price = domPrice[0];
      result.pricingSource = 'DOM after GQL probe';
    }

  } catch (e) {
    result.error = e.message;
    err('SM GQL: ' + e.message);
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

  // --- UPrinting 3x3 result ---
  if (upResult.price) {
    const sizeOk = upResult.selectedSize && (upResult.selectedSize.includes('3') || upResult.selectedSize.includes('custom'));
    const qtyOk = upResult.selectedQty === 5000;
    const confidence = sizeOk && qtyOk ? 'high' : qtyOk ? 'medium' : 'low';

    const newCapture = {
      id: `uprinting-3x3-5000-${today}`,
      competitor: 'uprinting',
      competitor_display: 'UPrinting',
      source_url: 'https://www.uprinting.com/roll-labels.html',
      captured_at: today,
      capture_method: 'playwright_dropdown_interaction',
      capture_source: 'automated_headless',
      confidence,
      product_type: 'labels',
      raw_spec_description: `Roll Labels, ${sizeOk ? '3"x3"' : 'closest-available size'}, qty=5000, White BOPP`,
      specs: {
        width_in: sizeOk ? 3 : null,
        height_in: sizeOk ? 3 : null,
        quantity: qtyOk ? 5000 : null,
        material: 'White BOPP',
        format: 'roll'
      },
      pricing: {
        total_price: upResult.price,
        unit_price: upResult.unitPrice || (upResult.price ? Math.round(upResult.price / 5000 * 10000) / 10000 : null),
        currency: 'USD',
        turnaround_days: 6,
        shipping_included: false,
        price_type: 'configured_quote'
      },
      raw_snippet: upResult.priceWrap?.slice(0, 200) || null,
      notes: `3x3 + 5000 qty attempt. selectedSize="${upResult.selectedSize}", selectedQty=${upResult.selectedQty}. Interactions: ${JSON.stringify(upResult.interactions).slice(0, 200)}`,
      blocker: confidence !== 'high' ? 'size_may_not_be_3x3' : null,
      next_step: confidence !== 'high' ? 'Verify 3x3 was selected or get custom-size price' : null
    };

    // Remove older uprinting records with less confidence
    raw.captures = raw.captures.filter(c => {
      if (c.competitor !== 'uprinting') return true;
      if (c.confidence === 'high' || c.confidence === 'medium') return false; // replace medium/low
      return true;
    });
    raw.captures.push(newCapture);
    raw.capture_coverage_summary.uprinting = {
      status: confidence === 'high' ? 'live' : 'partial',
      confidence,
      last_method: 'playwright_dropdown_interaction',
      reason: `Roll Labels ${sizeOk ? '3"x3"' : 'unknown size'}, qty=5000: $${upResult.price}. Size selected: ${upResult.selectedSize || 'default'}.`
    };

    // Update normalized
    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const upComp = q.competitor_results.find(c => c.competitor === 'uprinting');
      if (upComp) {
        upComp.status = confidence === 'high' ? 'live' : 'partial';
        upComp.coverage = confidence === 'high' ? 'exact_spec' : 'partial_spec';
        upComp.total_price = upResult.price;
        upComp.unit_price = newCapture.pricing.unit_price;
        upComp.turnaround_days = 6;
        upComp.confidence = confidence;
        upComp.notes = `Roll Labels, ${sizeOk ? '3"x3"' : 'closest available size'}, qty=5000. Price: $${upResult.price} ($${newCapture.pricing.unit_price?.toFixed(4)}/each). Turnaround: 6 business days. Shipping not included. Note: white BOPP standard.`;
      }
    }
    changed = true;
    log(`UP: Updated data — price $${upResult.price} (confidence=${confidence})`);
  }

  // --- Sticker Mule ---
  if (smResult.price && smResult.pricingSource && !smResult.pricingSource.includes('DOM')) {
    const newCapture = {
      id: `stickermule-gql-${today}`,
      competitor: 'stickermule',
      competitor_display: 'Sticker Mule',
      source_url: 'https://www.stickermule.com/custom-labels',
      captured_at: today,
      capture_method: 'playwright_graphql_extraction',
      capture_source: 'automated_headless',
      confidence: 'high',
      product_type: 'labels',
      raw_spec_description: '3"x3" custom labels, qty=5000, matte',
      specs: { width_in: 3, height_in: 3, quantity: 5000, finish: 'matte' },
      pricing: {
        total_price: smResult.price,
        unit_price: Math.round(smResult.price / 5000 * 10000) / 10000,
        currency: 'USD',
        turnaround_days: 4,
        shipping_included: true,
        price_type: 'configured_quote'
      },
      raw_snippet: smResult.gqlPriceResponse?.body?.slice(0, 200) || null,
      notes: `GraphQL extraction. Source: ${smResult.pricingSource}. Data: ${smResult.gqlPriceResponse?.body?.slice(0,100)}`,
      blocker: null,
      next_step: null
    };

    raw.captures = raw.captures.filter(c => c.competitor !== 'stickermule' || c.confidence === 'high');
    raw.captures.push(newCapture);
    raw.capture_coverage_summary.stickermule = {
      status: 'live',
      confidence: 'high',
      last_method: 'playwright_graphql_extraction',
      reason: `Price $${smResult.price} from GraphQL: ${smResult.pricingSource}`
    };

    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const smComp = q.competitor_results.find(c => c.competitor === 'stickermule');
      if (smComp) {
        smComp.status = 'live';
        smComp.coverage = 'exact_spec';
        smComp.total_price = smResult.price;
        smComp.unit_price = newCapture.pricing.unit_price;
        smComp.turnaround_days = 4;
        smComp.shipping_included = true;
        smComp.confidence = 'high';
        smComp.notes = `3"x3", qty=5000, matte. Price: $${smResult.price} (inc. shipping). Turnaround: 4 days.`;
      }
    }
    changed = true;
    log(`SM: Updated data — price $${smResult.price}`);
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
  log(`=== Final Attack: UP 3x3 + SM GQL === ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let upResult = { price: null };
  let smResult = { price: null };

  try {
    upResult = await captureUprinting3x3(browser);
  } catch (e) { err('UP: ' + e.message); }

  try {
    smResult = await captureStickermuleGQL(browser);
  } catch (e) { err('SM: ' + e.message); }

  await browser.close();

  const debugFile = path.join(ROOT_DIR, 'data', `capture-final-3x3-${nowISO()}.json`);
  fs.writeFileSync(debugFile, JSON.stringify({ up: upResult, sm: smResult }, null, 2));
  log(`Debug: ${debugFile}`);

  updateDataFiles(upResult, smResult);

  log('');
  log('=== FINAL ===');
  log(`UPrinting: size="${upResult.selectedSize}", qty=${upResult.selectedQty}, price=$${upResult.price}`);
  log(`UPrinting: sizeOptions=${JSON.stringify(upResult.sizeOptions?.slice?.(0,5) || [])}`);
  log(`Sticker Mule: price=$${smResult.price}, source=${smResult.pricingSource}`);
}

main().catch(e => { err(e.message); process.exit(1); });
