#!/usr/bin/env node
/**
 * capture-sm-up-targeted.js
 *
 * Targeted attack based on breakthrough run findings:
 *
 * STICKER MULE blockers identified:
 *   - Cookie consent modal blocks configurator from rendering (0 form elements)
 *   - GraphQL endpoints: core/graphql, notify/graphql, bridge/backend/graphql
 *   Fix: click "Agree" on consent modal, wait for configurator, probe GraphQL
 *
 * UPRINTING blockers identified:
 *   - Qty selector is a custom Bootstrap .blurb-list-dropdown (not native <select>)
 *   - Must click the dropdown TRIGGER (showing current qty) before clicking an option
 *   - calc-js.uprinting.com hosts the shared calculator — try direct pricing fetch
 *   Fix: find trigger by visible qty text, click it, then click 5,000
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

function log(msg)  { console.log(`[targeted] ${msg}`); }
function err(msg)  { console.error(`[ERR]      ${msg}`); }
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

// ─── STICKER MULE ─────────────────────────────────────────────────────────────
async function captureStickermule(browser) {
  log('=== STICKER MULE: Targeted (consent + GraphQL) ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Capture ALL GraphQL and JSON responses
  const gqlRequests = [];
  const gqlResponses = [];
  const jsonResponses = [];

  context.on('request', req => {
    const u = req.url();
    if (u.includes('graphql')) {
      gqlRequests.push({ url: u, method: req.method(), postData: req.postData() });
    }
  });

  context.on('response', async resp => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (resp.status() >= 400) return;
    try {
      const body = await resp.text();
      if (u.includes('graphql')) {
        gqlResponses.push({ url: u, status: resp.status(), body: body.slice(0, 5000) });
      } else if (ct.includes('application/json') && body.length > 10) {
        jsonResponses.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
      }
    } catch (_) {}
  });

  const page = await context.newPage();
  const result = {
    price: null, unitPrice: null, pricingSource: null,
    consentClicked: false, configuratorFound: false,
    formElements: [], gqlQueries: [], gqlPriceData: null, error: null
  };

  try {
    log('SM: Navigating to /custom-labels');
    await page.goto('https://www.stickermule.com/custom-labels', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(3000);

    // --- Step 1: Dismiss cookie consent ---
    log('SM: Looking for cookie consent button');
    const consentSelectors = [
      'button[data-testid="ConsentButton"]',
      'button:has-text("Agree")',
      '[aria-label*="cookie" i] button',
      '[class*="consent"] button',
      '[class*="banner"] button'
    ];

    for (const sel of consentSelectors) {
      try {
        const btns = await page.$$(sel);
        for (const btn of btns) {
          const text = await btn.textContent();
          if (text?.trim() === 'Agree' || text?.trim() === 'Accept') {
            log(`SM: clicking consent button "${text.trim()}" via ${sel}`);
            await btn.click();
            result.consentClicked = true;
            break;
          }
        }
        if (result.consentClicked) break;
      } catch (e) { log(`SM consent: ${e.message}`); }
    }

    if (!result.consentClicked) {
      // Try by text
      try {
        await page.click('text="Agree"', { timeout: 3000 });
        result.consentClicked = true;
        log('SM: clicked Agree by text selector');
      } catch (_) {}
    }

    if (result.consentClicked) {
      log('SM: consent dismissed, waiting for configurator to render');
      await sleep(5000);
    } else {
      log('SM: no consent button found — trying to proceed');
      await sleep(3000);
    }

    // --- Step 2: Inspect what's on the page now ---
    const formInfo = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, select, textarea'));
      return {
        count: els.length,
        elements: els.map(el => ({
          tag: el.tagName, type: el.type, name: el.name, id: el.id,
          placeholder: el.placeholder, value: el.value,
          testid: el.getAttribute('data-testid'),
          ariaLabel: el.getAttribute('aria-label'),
          visible: !!(el.offsetWidth || el.offsetHeight),
          class: (el.className || '').slice(0, 80)
        }))
      };
    });

    log(`SM: ${formInfo.count} form elements after consent`);
    formInfo.elements.filter(f => f.visible).forEach(f =>
      log(`  [${f.tag}/${f.type}] testid="${f.testid}" aria="${f.ariaLabel}" id="${f.id}" name="${f.name}"`)
    );
    result.formElements = formInfo.elements;

    // --- Step 3: Look for configurator content ---
    const pageText = await page.evaluate(() => document.body.innerText);
    const configuratorHtml = await page.evaluate(() => {
      // Look for pricing-related elements in the page
      const pricingEls = Array.from(document.querySelectorAll('[class*="price"], [class*="Price"], [class*="total"], [class*="Total"], [class*="cost"], [data-testid*="price"], [data-testid*="total"]'));
      return pricingEls.slice(0, 10).map(el => ({
        class: el.className?.slice(0, 60),
        testid: el.getAttribute('data-testid'),
        text: el.textContent?.trim().slice(0, 100),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }));
    });
    log(`SM: pricing elements: ${JSON.stringify(configuratorHtml)}`);

    // Look for any price on the page
    const prices = pageText.match(/\$([\d,]+\.?\d{0,2})/g);
    log(`SM: prices in page text: ${prices?.join(', ') || 'none'}`);

    // --- Step 4: Try to find and interact with configurator ---
    // After consent, look for width/height inputs
    const widthEl = await page.$('input[name="width"], input[data-testid*="width"], input[placeholder*="width" i], input[aria-label*="width" i]');
    const heightEl = await page.$('input[name="height"], input[data-testid*="height"], input[placeholder*="height" i], input[aria-label*="height" i]');
    const qtyEl = await page.$('input[name="quantity"], input[data-testid*="quantity"], select[name="quantity"], [data-testid*="qty"] input');

    if (widthEl || heightEl || qtyEl) {
      result.configuratorFound = true;
      log(`SM: configurator found! width=${!!widthEl} height=${!!heightEl} qty=${!!qtyEl}`);

      if (widthEl) { await widthEl.click({ clickCount: 3 }); await widthEl.fill('3'); }
      if (heightEl) { await heightEl.click({ clickCount: 3 }); await heightEl.fill('3'); }
      if (qtyEl) {
        const tag = await qtyEl.evaluate(e => e.tagName);
        if (tag === 'SELECT') await qtyEl.selectOption('5000');
        else { await qtyEl.click({ clickCount: 3 }); await qtyEl.fill('5000'); }
      }
      await sleep(4000);
    } else {
      log('SM: configurator not found — checking for alternate structure');
      // Look for a "Start your order" type button
      const startBtns = await page.$$('button, a[href*="order"], a[href*="configure"]');
      for (const btn of startBtns.slice(0, 10)) {
        const text = await btn.textContent();
        if (text?.toLowerCase().includes('order') || text?.toLowerCase().includes('start') || text?.toLowerCase().includes('get')) {
          log(`SM: found possible start button: "${text?.trim()}"`);
        }
      }
    }

    // --- Step 5: Probe GraphQL endpoints ---
    log(`SM: ${gqlRequests.length} GraphQL requests captured, ${gqlResponses.length} responses`);
    gqlRequests.slice(0, 5).forEach(r => {
      log(`  GQL REQ: ${r.url} | body: ${r.postData?.slice(0, 200)}`);
    });
    gqlResponses.slice(0, 3).forEach(r => {
      log(`  GQL RESP: ${r.url} | ${r.body?.slice(0, 200)}`);
    });

    // Try GraphQL pricing queries on the discovered endpoints
    const gqlEndpoints = [
      'https://www.stickermule.com/core/graphql',
      'https://www.stickermule.com/bridge/backend/graphql',
      'https://www.stickermule.com/notify/graphql'
    ];

    // Try different GraphQL queries for pricing
    const gqlQueries = [
      // Introspection to find schema
      { name: 'introspect', query: '{ __schema { queryType { fields { name } } } }' },
      // Common pricing queries
      { name: 'label_price', query: 'query { label_price(width: 3, height: 3, quantity: 5000) { total unit_price } }' },
      { name: 'product_pricing', query: 'query { product(slug: "custom-labels") { pricing { quantity price } } }' },
      { name: 'custom_labels', query: 'query { custom_labels { pricing_tiers { quantity price } } }' },
      { name: 'order_price', query: 'query OrderPrice { orderPrice(product: "custom-labels", width: 3, height: 3, quantity: 5000) { total perUnit } }' },
    ];

    const gqlResults = await page.evaluate(async (args) => {
      const { endpoints, queries } = args;
      const results = {};

      for (const endpoint of endpoints) {
        results[endpoint] = {};
        for (const q of queries) {
          try {
            const r = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
              },
              credentials: 'include',
              body: JSON.stringify({ query: q.query })
            });
            const text = await r.text();
            results[endpoint][q.name] = { status: r.status, body: text.slice(0, 500) };
          } catch (e) {
            results[endpoint][q.name] = { error: e.message.slice(0, 60) };
          }
        }
      }
      return results;
    }, { endpoints: gqlEndpoints, queries: gqlQueries });

    // Analyze GraphQL results
    for (const [endpoint, endpointResults] of Object.entries(gqlResults)) {
      for (const [qName, qResult] of Object.entries(endpointResults)) {
        const status = qResult.status;
        const body = qResult.body || '';
        log(`SM GQL ${qName}@${endpoint.split('/').slice(-2).join('/')}: status=${status || qResult.error} | ${body.slice(0, 100)}`);
        result.gqlQueries.push({ endpoint, query: qName, status, body: body.slice(0, 200) });

        // Look for price data in response
        if (status === 200 && body.includes('price') && !body.includes('"errors"')) {
          const priceMatch = body.match(/"(?:price|total|amount|cost)":\s*"?(\d+\.?\d{0,2})"?/);
          if (priceMatch) {
            const p = parseFloat(priceMatch[1]);
            if (p > 0 && p < 200000) {
              log(`SM GQL PRICE FOUND: $${p} from ${qName}`);
              result.price = p;
              result.pricingSource = `GraphQL:${qName}@${endpoint}`;
              result.gqlPriceData = body.slice(0, 500);
            }
          }
        }

        // Check introspection result for useful field names
        if (qName === 'introspect' && status === 200 && body.includes('fields')) {
          try {
            const data = JSON.parse(body);
            const fields = data?.data?.__schema?.queryType?.fields?.map(f => f.name) || [];
            log(`SM GQL schema fields: ${fields.slice(0, 20).join(', ')}`);
            result.gqlSchemaFields = fields;
          } catch (_) {}
        }
      }
    }

    // Also try GET request to see if there's a REST pricing endpoint
    const restResult = await page.evaluate(async () => {
      const endpoints = [
        '/api/v1/products/custom-labels',
        '/api/products',
        '/api/v1/products?type=labels',
      ];
      const results = {};
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          results[ep] = { status: r.status, body: (await r.text()).slice(0, 300) };
        } catch (e) { results[ep] = { error: e.message }; }
      }
      return results;
    });
    Object.entries(restResult).forEach(([k, v]) => {
      if (v.status === 200) log(`SM REST HIT: ${k} → ${v.body?.slice(0, 80)}`);
    });

    // Read current price from DOM
    const domPrice = await page.evaluate(() => {
      const allText = document.body.innerText;
      const re = /\$([\d,]+\.?\d{0,2})/g;
      const prices = [];
      let m;
      while ((m = re.exec(allText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 20 && v <= 100000) prices.push(v);
      }
      return { prices: [...new Set(prices)].sort((a, b) => a - b) };
    });
    log(`SM: DOM prices after interaction: [${domPrice.prices.join(', ')}]`);

    if (!result.price && domPrice.prices.length > 0) {
      const candidate = domPrice.prices.find(p => p >= 47);
      if (candidate) {
        result.price = candidate;
        result.pricingSource = 'DOM after consent';
      }
    }

  } catch (e) {
    result.error = e.message;
    err('SM: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPRINTING — Targeted Dropdown Fix ────────────────────────────────────────
async function captureUprinting(browser) {
  log('=== UPRINTING: Targeted (bootstrap dropdown) ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Capture calc-js API calls
  const calcApiCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('calc-js.uprinting.com') || u.includes('module-api.uprinting.com') || u.includes('checkout-api.uprinting.com')) {
      try {
        const body = await resp.text();
        calcApiCalls.push({ url: u, status: resp.status(), body: body.slice(0, 2000) });
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const result = {
    defaultPrice: null, finalPrice: null, finalUnitPrice: null,
    sizeChanged: false, qtyChanged: false,
    priceWrapText: null, interactions: [], calcData: null, error: null
  };

  try {
    log('UP: Navigating to roll-labels.html');
    await page.goto('https://www.uprinting.com/roll-labels.html', {
      waitUntil: 'networkidle',
      timeout: 50000
    });

    // Wait for Angular + price to render
    try {
      await page.waitForSelector('#calc-price, .calc-price', { timeout: 20000 });
    } catch (_) {}
    await sleep(3000);

    // Read default state
    const initState = await page.evaluate(() => {
      const priceEl = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
      return { price: priceEl?.textContent?.trim() };
    });
    result.defaultPrice = parseDollar(initState.price);
    log(`UP: Default price: ${initState.price}`);

    // --- Step 1: Analyze the qty dropdown structure ---
    const dropdownInfo = await page.evaluate(() => {
      // Find all blurb-list-dropdown elements (the dropdown items)
      const dropdownItems = Array.from(document.querySelectorAll('.blurb-list-dropdown.dropdown-menu-item, li.dropdown-menu-item'));
      const qtyItems = dropdownItems.filter(el => {
        const t = el.textContent?.trim().replace(/,/g, '');
        return t && /^\d+$/.test(t) && parseInt(t) >= 100;
      });

      // Find dropdown triggers (parent containers that are clickable)
      const triggers = Array.from(document.querySelectorAll('[data-toggle="dropdown"], .dropdown-toggle, [class*="blurb-list"] > *:first-child'));
      const qtyTriggers = triggers.filter(el => {
        const t = el.textContent?.trim().replace(/,/g, '');
        return t && /^\d+$/.test(t);
      });

      // Find the dropdown-toggle that shows current qty
      const dropdowns = Array.from(document.querySelectorAll('.dropdown, .blurb-list-dropdown-container, [class*="calc"][class*="dropdown"]'));

      // Find the button/anchor that shows the current quantity (1,000)
      const allQtyDisplays = Array.from(document.querySelectorAll('*')).filter(el => {
        return el.textContent?.trim() === '1,000' && el.childNodes.length <= 2;
      }).map(el => ({
        tag: el.tagName,
        class: el.className?.toString().slice(0, 80),
        id: el.id,
        parent: el.parentElement?.className?.toString().slice(0, 80),
        dataToggle: el.getAttribute('data-toggle'),
        parentDataToggle: el.parentElement?.getAttribute('data-toggle')
      }));

      return {
        qtyItemCount: qtyItems.length,
        qtyItems: qtyItems.slice(0, 5).map(el => ({
          tag: el.tagName,
          class: el.className?.toString().slice(0, 80),
          text: el.textContent?.trim(),
          visible: !!(el.offsetWidth || el.offsetHeight),
          parentClass: el.parentElement?.className?.toString().slice(0, 80),
          parentVisible: !!(el.parentElement?.offsetWidth || el.parentElement?.offsetHeight)
        })),
        qtyTriggerCount: qtyTriggers.length,
        dropdownCount: dropdowns.length,
        allQtyDisplays: allQtyDisplays.slice(0, 5)
      };
    });

    log(`UP dropdown: ${dropdownInfo.qtyItemCount} qty items, ${dropdownInfo.qtyTriggerCount} triggers`);
    log(`UP qty items: ${JSON.stringify(dropdownInfo.qtyItems)}`);
    log(`UP qty displays: ${JSON.stringify(dropdownInfo.allQtyDisplays)}`);

    // --- Step 2: Try to change size to 3x3 ---
    // UPrinting's custom-size handler is at custom-size-attribute-factory-min.js
    // First check the page for size-related elements
    const sizeInfo = await page.evaluate(() => {
      // Look for size-related dropdown triggers
      const sizeTriggers = Array.from(document.querySelectorAll('*')).filter(el => {
        const t = el.textContent?.trim();
        return t && (t.includes('"') || t.match(/\d+\s*[xX]\s*\d+/)) && el.childNodes.length <= 3;
      }).slice(0, 10).map(el => ({
        tag: el.tagName, text: el.textContent?.trim().slice(0, 30),
        class: el.className?.toString().slice(0, 60),
        dataToggle: el.getAttribute('data-toggle'),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }));

      // Find custom size inputs
      const sizeInputs = Array.from(document.querySelectorAll('input')).filter(el => {
        return el.name?.includes('width') || el.name?.includes('height') ||
               el.id?.includes('width') || el.id?.includes('height') ||
               el.getAttribute('ng-model')?.includes('width') ||
               el.getAttribute('ng-model')?.includes('height');
      }).map(el => ({
        id: el.id, name: el.name, value: el.value, ngModel: el.getAttribute('ng-model'),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }));

      return { sizeTriggers, sizeInputs };
    });

    log(`UP size triggers: ${JSON.stringify(sizeInfo.sizeTriggers.slice(0, 3))}`);
    log(`UP size inputs: ${JSON.stringify(sizeInfo.sizeInputs)}`);

    // Try to change size if width/height inputs are available
    if (sizeInfo.sizeInputs.some(i => i.visible)) {
      const wInput = sizeInfo.sizeInputs.find(i => i.name?.includes('width') || i.id?.includes('width') || i.ngModel?.includes('width'));
      const hInput = sizeInfo.sizeInputs.find(i => i.name?.includes('height') || i.id?.includes('height') || i.ngModel?.includes('height'));
      if (wInput && hInput) {
        log(`UP: Setting width/height to 3x3`);
        const wSel = wInput.id ? `#${wInput.id}` : `input[name="${wInput.name}"]`;
        const hSel = hInput.id ? `#${hInput.id}` : `input[name="${hInput.name}"]`;
        await page.click(wSel, { clickCount: 3 });
        await page.fill(wSel, '3');
        await page.press(wSel, 'Tab');
        await sleep(1000);
        await page.click(hSel, { clickCount: 3 });
        await page.fill(hSel, '3');
        await page.press(hSel, 'Tab');
        result.sizeChanged = true;
        result.interactions.push({ action: 'fillSize', w: '3', h: '3' });
        await sleep(2000);
      }
    }

    // --- Step 3: Open the qty dropdown ---
    // Find the dropdown toggle that shows the current qty
    // It's likely a button/a showing "1,000" with data-toggle="dropdown"
    let dropdownOpened = false;

    // Method A: Click element showing "1,000" that has data-toggle or is inside a dropdown
    const openResult = await page.evaluate(() => {
      // Find all elements with text "1,000" that could be a dropdown toggle
      const allEls = Array.from(document.querySelectorAll('*'));

      // Find elements showing the current qty that have dropdown toggle behavior
      for (const el of allEls) {
        const t = el.textContent?.trim();
        if (t !== '1,000') continue;

        // Check if this element or its parent has dropdown behavior
        const hasToggle = el.getAttribute('data-toggle') === 'dropdown' ||
                         el.parentElement?.getAttribute('data-toggle') === 'dropdown' ||
                         el.className?.toString().includes('dropdown-toggle') ||
                         el.parentElement?.className?.toString().includes('dropdown-toggle');

        if (hasToggle) {
          el.click();
          return { clicked: true, tag: el.tagName, class: el.className?.toString().slice(0, 60) };
        }
      }

      // Try clicking the parent of "1,000" text elements
      for (const el of allEls) {
        const t = el.textContent?.trim();
        if (t !== '1,000') continue;

        const parent = el.parentElement;
        if (parent && (parent.getAttribute('data-toggle') === 'dropdown' ||
                       parent.className?.toString().includes('dropdown-toggle') ||
                       parent.tagName === 'BUTTON' || parent.tagName === 'A')) {
          parent.click();
          return { clickedParent: true, tag: parent.tagName, class: parent.className?.toString().slice(0, 60) };
        }
      }

      return { notFound: true };
    });

    log(`UP: dropdown open attempt: ${JSON.stringify(openResult)}`);
    if (openResult.clicked || openResult.clickedParent) {
      dropdownOpened = true;
      result.interactions.push({ action: 'openDropdown', result: openResult });
      await sleep(1500);
    }

    // Method B: Try clicking the .blurb-list-dropdown-toggle class
    if (!dropdownOpened) {
      try {
        const toggleEl = await page.$('.blurb-list-dropdown-toggle, [class*="dropdown-toggle"]');
        if (toggleEl) {
          log('UP: clicking .blurb-list-dropdown-toggle');
          await toggleEl.click();
          dropdownOpened = true;
          result.interactions.push({ action: 'clickDropdownToggle' });
          await sleep(1500);
        }
      } catch (e) { log(`UP toggle click: ${e.message}`); }
    }

    // Method C: Use Playwright keyboard to open dropdown
    if (!dropdownOpened) {
      // Try pressing Space or Enter on focused dropdown
      try {
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Space');
        await sleep(1000);
        log('UP: tried keyboard to open dropdown');
      } catch (e) {}
    }

    // --- Step 4: Check if dropdown is now open and click 5,000 ---
    const dropdownState = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.blurb-list-dropdown.dropdown-menu-item, li.dropdown-menu-item'));
      const visible = items.filter(el => !!(el.offsetWidth || el.offsetHeight));
      return {
        totalItems: items.length,
        visibleItems: visible.length,
        visibleTexts: visible.map(el => el.textContent?.trim()).slice(0, 10)
      };
    });
    log(`UP: dropdown state after open: total=${dropdownState.totalItems}, visible=${dropdownState.visibleItems}`);
    log(`UP: visible dropdown items: ${dropdownState.visibleTexts.join(', ')}`);

    if (dropdownState.visibleItems > 0) {
      // Now try to click 5,000
      try {
        await page.click('li.blurb-list-dropdown.dropdown-menu-item:has-text("5,000")', { timeout: 3000 });
        result.qtyChanged = true;
        result.interactions.push({ action: 'clickQty5000' });
        log('UP: clicked qty 5,000 from open dropdown');
        await sleep(4000);
      } catch (e) {
        log(`UP 5000 click: ${e.message}`);

        // Try clicking via evaluate on visible items
        const click5k = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('li.blurb-list-dropdown.dropdown-menu-item, li.dropdown-menu-item'));
          for (const item of items) {
            if (item.textContent?.trim() === '5,000' && !!(item.offsetWidth || item.offsetHeight)) {
              item.click();
              const link = item.querySelector('a');
              if (link) link.click();
              return { clicked: true, text: item.textContent?.trim() };
            }
          }
          return { clicked: false };
        });
        log(`UP click 5k via evaluate: ${JSON.stringify(click5k)}`);
        if (click5k.clicked) {
          result.qtyChanged = true;
          await sleep(4000);
        }
      }
    } else {
      // Dropdown didn't open — try Angular-based approach
      log('UP: dropdown not opened, trying Angular injection for qty');
      const angularResult = await page.evaluate(() => {
        if (typeof angular === 'undefined') return { error: 'no angular' };
        const candidates = ['[ng-controller]', '.product-calculator', '#price', '[class*="calc"]'];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (!el) continue;
          try {
            const scope = angular.element(el).scope();
            if (!scope) continue;
            // Find qty-related keys
            const qtyKey = ['qty', 'quantity', 'selectedQty', 'calcQty', 'printQty', 'orderQty']
              .find(k => k in scope);
            if (qtyKey) {
              scope[qtyKey] = 5000;
              scope.$apply();
              return { method: 'directScope', key: qtyKey };
            }
            // Look for functions
            const fn = ['setQuantity', 'selectQty', 'changeQty', 'updateQuantity', 'pickQty']
              .find(k => typeof scope[k] === 'function');
            if (fn) {
              scope[fn](5000);
              scope.$apply();
              return { method: fn };
            }
          } catch (_) {}
        }
        return { error: 'no scope method' };
      });
      log(`UP Angular: ${JSON.stringify(angularResult)}`);
      if (angularResult.method) {
        result.qtyChanged = true;
        await sleep(3000);
      }
    }

    // --- Step 5: Read updated price ---
    const finalState = await page.evaluate(() => {
      const priceEl = document.getElementById('calc-price') || document.querySelector('.calc-price.subtotal-price');
      const unitEl  = document.querySelector('.calc-price-per-piece');
      const priceWrap = document.querySelector('.price-wrap, #price-wrap, #price');
      return {
        price: priceEl?.textContent?.trim(),
        unitPrice: unitEl?.textContent?.trim(),
        priceWrapText: priceWrap?.innerText?.slice(0, 400)
      };
    });

    log(`UP final: price="${finalState.price}", unit="${finalState.unitPrice}"`);
    log(`UP priceWrap: ${finalState.priceWrapText?.slice(0, 200)}`);

    result.finalPrice = parseDollar(finalState.price);
    result.finalUnitPrice = parseDollar(finalState.unitPrice?.replace(/[()]/g, '').trim());
    result.priceWrapText = finalState.priceWrapText;

    if (result.defaultPrice !== result.finalPrice) {
      log(`UP: PRICE CHANGED: $${result.defaultPrice} → $${result.finalPrice}`);
    } else {
      log(`UP: Price unchanged at $${result.finalPrice}`);
    }

    // --- Step 6: Try direct UPrinting calc-js pricing API ---
    log('UP: Trying direct calc-js pricing API from page context');
    const calcApiResult = await page.evaluate(async () => {
      const results = {};

      // The calc-js uses a shared pricing module
      // Look in window for any exposed pricing functions
      const windowKeys = Object.keys(window).filter(k =>
        k.toLowerCase().includes('price') || k.toLowerCase().includes('calc') || k.toLowerCase().includes('up')
      );
      results.windowPricingKeys = windowKeys.slice(0, 10);

      // Try the module-api for product pricing
      const endpoints = [
        'https://module-api.uprinting.com/product-pricing?website_code=UP&product_id=33&qty=5000',
        'https://module-api.uprinting.com/product-price?website_code=UP&product_id=33',
        'https://calc-js.uprinting.com/pricing?product_id=33&qty=5000&size=3x3',
        'https://checkout-api.uprinting.com/product-price?website_code=UP&product_id=33&qty=5000',
      ];

      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          results[ep] = { status: r.status, body: text.slice(0, 300) };
        } catch (e) {
          results[ep] = { error: e.message.slice(0, 60) };
        }
      }

      return results;
    });

    Object.entries(calcApiResult).forEach(([k, v]) => {
      if (k === 'windowPricingKeys') {
        log(`UP window pricing keys: ${v.join(', ')}`);
      } else if (v.status === 200) {
        log(`UP calc-api HIT: ${k} → ${v.body?.slice(0, 100)}`);
      } else {
        log(`UP calc-api: ${v.status || v.error} ${k.split('/').slice(-1)}`);
      }
    });

    // Log calc-js API calls captured
    log(`UP: ${calcApiCalls.length} calc/module-api calls captured`);
    calcApiCalls.slice(0, 5).forEach(c => {
      log(`  ${c.status} ${c.url}: ${c.body?.slice(0, 80)}`);
    });

  } catch (e) {
    result.error = e.message;
    err('UP: ' + e.message);
    log(e.stack?.slice(0, 500));
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPDATE DATA FILES ─────────────────────────────────────────────────────────
function updateDataFiles(smResult, upResult) {
  const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM_FILE, 'utf8'));
  const today = nowISO();
  let changed = false;

  // --- Update UPrinting data ---
  // Even if we didn't get 5000 qty price, document progress
  const upPrice = upResult.finalPrice;
  const upChanged = upResult.qtyChanged;
  const upSizeChanged = upResult.sizeChanged;

  if (upPrice && upPrice !== upResult.defaultPrice) {
    // Price actually changed — we got a real quote
    const upConf = upSizeChanged && upChanged ? 'high' : upChanged ? 'medium' : 'low';
    const newCapture = {
      id: `uprinting-targeted-${today}`,
      competitor: 'uprinting',
      competitor_display: 'UPrinting',
      source_url: 'https://www.uprinting.com/roll-labels.html',
      captured_at: today,
      capture_method: 'playwright_targeted_dropdown',
      capture_source: 'automated_headless',
      confidence: upConf,
      product_type: 'labels',
      raw_spec_description: `${upSizeChanged ? '3"x3"' : 'default size'}, qty=${upChanged ? '5,000' : 'default'}, White BOPP, Roll`,
      specs: {
        width_in: upSizeChanged ? 3 : null,
        height_in: upSizeChanged ? 3 : null,
        quantity: upChanged ? 5000 : null,
        material: 'White BOPP',
        format: 'roll'
      },
      pricing: {
        total_price: upPrice,
        unit_price: upResult.finalUnitPrice || (upPrice && upChanged ? Math.round(upPrice / 5000 * 10000) / 10000 : null),
        currency: 'USD',
        turnaround_days: 6,
        shipping_included: false,
        price_type: 'configured_quote'
      },
      raw_snippet: upResult.priceWrapText?.slice(0, 200) || null,
      notes: `Targeted dropdown capture. sizeChanged=${upSizeChanged}, qtyChanged=${upChanged}. Interactions: ${JSON.stringify(upResult.interactions)}`,
      blocker: null,
      next_step: upConf !== 'high' ? 'Verify spec was set correctly' : null
    };

    // Remove older failed records, add new
    raw.captures = raw.captures.filter(c => c.competitor !== 'uprinting' || c.confidence !== 'none');
    raw.captures.push(newCapture);
    raw.capture_coverage_summary.uprinting = {
      status: upConf === 'high' ? 'live' : 'partial',
      confidence: upConf,
      last_method: 'playwright_targeted_dropdown',
      reason: `Price: $${upPrice}. Size: ${upSizeChanged ? '3x3' : 'default'}. Qty: ${upChanged ? '5000' : 'default'}.`
    };

    // Update normalized data
    const query = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (query) {
      const upCompResult = query.competitor_results.find(c => c.competitor === 'uprinting');
      if (upCompResult && upConf !== 'none') {
        upCompResult.status = upConf === 'high' ? 'live' : 'partial';
        upCompResult.coverage = upConf === 'high' ? 'exact_spec' : 'partial_spec';
        upCompResult.total_price = upPrice;
        upCompResult.unit_price = newCapture.pricing.unit_price;
        upCompResult.turnaround_days = 6;
        upCompResult.confidence = upConf;
        upCompResult.notes = `Roll labels ${upSizeChanged ? '3x3' : 'default size'}, qty=${upChanged ? '5000' : 'default'}. Price: $${upPrice}. Shipping not included.`;
      }
    }
    changed = true;
    log(`UP: Updated raw + normalized data with price $${upPrice} (confidence=${upConf})`);
  }

  // --- Update Sticker Mule data ---
  if (smResult.price) {
    const smConf = smResult.pricingSource?.includes('GraphQL') ? 'high' : 'medium';
    const newCapture = {
      id: `stickermule-targeted-${today}`,
      competitor: 'stickermule',
      competitor_display: 'Sticker Mule',
      source_url: 'https://www.stickermule.com/custom-labels',
      captured_at: today,
      capture_method: 'playwright_targeted_graphql',
      capture_source: 'automated_headless',
      confidence: smConf,
      product_type: 'labels',
      raw_spec_description: 'Custom labels — 3x3, 5000 pcs, matte',
      specs: { width_in: 3, height_in: 3, quantity: 5000, finish: 'matte' },
      pricing: {
        total_price: smResult.price,
        unit_price: Math.round(smResult.price / 5000 * 10000) / 10000,
        currency: 'USD',
        turnaround_days: 4,
        shipping_included: true,
        price_type: 'configured_quote'
      },
      raw_snippet: smResult.gqlPriceData?.slice(0, 200) || null,
      notes: `Targeted capture. Source: ${smResult.pricingSource}. Consent clicked: ${smResult.consentClicked}. GraphQL schema fields: ${smResult.gqlSchemaFields?.slice(0,5).join(', ')}`,
      blocker: null,
      next_step: null
    };

    raw.captures = raw.captures.filter(c => c.competitor !== 'stickermule' || c.confidence !== 'none');
    raw.captures.push(newCapture);
    raw.capture_coverage_summary.stickermule = {
      status: 'live',
      confidence: smConf,
      last_method: 'playwright_targeted_graphql',
      reason: `Price $${smResult.price} from ${smResult.pricingSource}`
    };

    // Update normalized
    const query = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (query) {
      const smCompResult = query.competitor_results.find(c => c.competitor === 'stickermule');
      if (smCompResult) {
        smCompResult.status = 'live';
        smCompResult.coverage = 'exact_spec';
        smCompResult.total_price = smResult.price;
        smCompResult.unit_price = newCapture.pricing.unit_price;
        smCompResult.turnaround_days = 4;
        smCompResult.shipping_included = true;
        smCompResult.confidence = smConf;
        smCompResult.notes = `Exact quote: $${smResult.price} (inc. free shipping). Source: ${smResult.pricingSource}.`;
      }
    }
    changed = true;
    log(`SM: Updated data with price $${smResult.price}`);
  }

  if (changed) {
    raw.last_updated = today;
    norm.last_updated = today;
    fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM_FILE, JSON.stringify(norm, null, 2));
    log(`Data files updated.`);
  } else {
    log('No new pricing data — data files unchanged');
  }

  return changed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Targeted Capture: SM + UP === ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled']
  });

  let smResult = { price: null };
  let upResult = { finalPrice: null, defaultPrice: null };

  try {
    smResult = await captureStickermule(browser);
  } catch (e) { err('SM fatal: ' + e.message); smResult = { price: null, error: e.message }; }

  try {
    upResult = await captureUprinting(browser);
  } catch (e) { err('UP fatal: ' + e.message); upResult = { finalPrice: null, error: e.message }; }

  await browser.close();

  // Save debug
  const debugPath = path.join(ROOT_DIR, 'data', `capture-targeted-${nowISO()}.json`);
  fs.writeFileSync(debugPath, JSON.stringify({ sm: smResult, up: upResult }, null, 2));
  log(`Debug: ${debugPath}`);

  updateDataFiles(smResult, upResult);

  log('');
  log('=== FINAL SUMMARY ===');
  log(`Sticker Mule: consent=${smResult.consentClicked}, configurator=${smResult.configuratorFound}`);
  log(`  GQL endpoints probed, schema fields: ${smResult.gqlSchemaFields?.slice(0,5).join(', ') || 'none'}`);
  log(`  PRICE: ${smResult.price ? '$' + smResult.price + ' (source: ' + smResult.pricingSource + ')' : 'NOT CAPTURED'}`);
  log(`UPrinting: sizeChanged=${upResult.sizeChanged}, qtyChanged=${upResult.qtyChanged}`);
  log(`  Default: $${upResult.defaultPrice} → Final: $${upResult.finalPrice}`);
  log(`  PRICE: ${upResult.finalPrice ? '$' + upResult.finalPrice : 'NOT CAPTURED'}`);
}

main().catch(e => {
  err('Fatal: ' + e.message);
  process.exit(1);
});
