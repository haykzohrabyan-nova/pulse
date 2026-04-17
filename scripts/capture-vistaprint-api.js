#!/usr/bin/env node
/**
 * capture-vistaprint-api.js — Direct API call to Vistaprint's pricing service
 *
 * We discovered their pricing API during browser session:
 * product-pages-v2-bff.prod.merch.vpsvc.com/v1/compatibility-pricing/vistaprint/en-us/PRD-DF5PWTHC
 * PRD-DF5PWTHC = Roll Labels, version 75
 *
 * Also hitting Axiom's price configurator for 3x3/5000 spec.
 * And UPrinting's roll labels with Playwright interaction.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const RAW_FILE  = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');

function log(msg)  { console.log(`[vp-api] ${msg}`); }
function err(msg)  { console.error(`[ERR]    ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ─── VISTAPRINT API DIRECT ────────────────────────────────────────────────────
// Use a Playwright page context to call the VP API with proper session cookies
async function captureVistaprintAPI(browser) {
  log('Vistaprint: direct pricing API call for roll labels PRD-DF5PWTHC');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const results = {};

  try {
    // First load the roll-labels page to get session/cookies established
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(5000);

    // Now call the compatibility-pricing API with 5000 qty
    // This API returns pricing for all listed quantities at once
    const pricingResult = await page.evaluate(async () => {
      const quantities = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
      const selections = {};

      // API 1: compatibility-pricing (returns quantity price table)
      const api1Url = `https://product-pages-v2-bff.prod.merch.vpsvc.com/v1/compatibility-pricing/vistaprint/en-us/PRD-DF5PWTHC?` +
        `selections=${encodeURIComponent(JSON.stringify(selections))}&` +
        `productPageOptions=${encodeURIComponent(JSON.stringify(['Shape','Size','Custom Height','Custom Width','Material','Roll Finishing Type']))}&` +
        `quantities=${encodeURIComponent(JSON.stringify(quantities))}&` +
        `version=75&applyProductConstraints=true&currentQuantity=0&requestor=po-product-page-configurator`;

      let api1Data = null;
      try {
        const r1 = await fetch(api1Url, { credentials: 'include', headers: { 'Accept': 'application/json', 'Requestor': 'po-product-page-configurator' } });
        api1Data = { status: r1.status, body: await r1.text() };
      } catch(e) { api1Data = { error: e.message }; }

      // API 2: wrangler configuratorData with selectedQuantity=5000
      const api2Url = `https://wrangler.prod.merch.vpsvc.com/api/v1/vistaprint/en-us/configuratorData/PRD-DF5PWTHC/75?` +
        `merchandisingExperience=UploadFlow&responseComponents=standardConfigurator&selectedQuantity=5000&` +
        `requestor=inspector-gadget-pdp-configurator-fragment&includeVat=false&priceStyle=relative`;

      let api2Data = null;
      try {
        const r2 = await fetch(api2Url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        api2Data = { status: r2.status, body: await r2.text() };
      } catch(e) { api2Data = { error: e.message }; }

      // API 3: website-pricing-service for specific quantity
      const api3Url = `https://website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?` +
        `requestor=inspector-gadget-pdp-configurator-fragment&productKey=PRD-DF5PWTHC&quantities=5000&` +
        `merchantId=vistaprint&market=US&optionalPriceComponents=UnitPrice`;

      let api3Data = null;
      try {
        const r3 = await fetch(api3Url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        api3Data = { status: r3.status, body: await r3.text() };
      } catch(e) { api3Data = { error: e.message }; }

      return { api1: api1Data, api2: api2Data, api3: api3Data };
    });

    log(`VP API 1 (compatibility-pricing): status=${pricingResult.api1?.status || pricingResult.api1?.error}`);
    log(`VP API 2 (configuratorData 5000): status=${pricingResult.api2?.status || pricingResult.api2?.error}`);
    log(`VP API 3 (startingAt/estimated): status=${pricingResult.api3?.status || pricingResult.api3?.error}`);

    // Parse API 1 — quantity price table
    if (pricingResult.api1?.status === 200) {
      try {
        const data = JSON.parse(pricingResult.api1.body);
        log('VP API 1 keys: ' + Object.keys(data).join(', '));

        // Look for quantity pricing
        const jsonStr = JSON.stringify(data);

        // Find prices associated with quantity 5000
        const price5k = jsonStr.match(/"quantity":\s*5000[^}]*"(?:totalListPrice|totalDiscountedPrice|price)":\s*(\d+\.?\d*)/);
        if (price5k) {
          log(`VP: 5000 qty price from API 1: $${price5k[1]}`);
          results.api1_price_5000 = parseFloat(price5k[1]);
        }

        // Extract all quantity/price pairs
        const quantityPrices = [];
        const qtyRe = /"(?:quantity|qty)":\s*"?(\d+)"?[^}]*"(?:totalListPrice|listPrice|price|amount)":\s*(\d+\.?\d*)/g;
        let m;
        while ((m = qtyRe.exec(jsonStr)) !== null) {
          quantityPrices.push({ qty: parseInt(m[1]), price: parseFloat(m[2]) });
        }
        if (quantityPrices.length > 0) {
          log('VP: quantity pricing table from API 1:');
          quantityPrices.forEach(qp => log(`  qty ${qp.qty}: $${qp.price}`));
          results.quantityPricingTable = quantityPrices;
        }

        // Also look for price arrays
        if (data.quantities) {
          log('VP API 1 quantities: ' + JSON.stringify(data.quantities).slice(0, 500));
          results.api1_quantities = data.quantities;
        }

        results.api1_full = JSON.stringify(data).slice(0, 3000);
        log('VP API 1 sample: ' + results.api1_full.slice(0, 500));
      } catch(e) {
        log('VP API 1 parse error: ' + e.message);
        log('VP API 1 raw: ' + pricingResult.api1.body?.slice(0, 500));
      }
    } else {
      log('VP API 1 error body: ' + pricingResult.api1?.body?.slice(0, 300));
    }

    // Parse API 2 — configuratorData with qty=5000
    if (pricingResult.api2?.status === 200) {
      try {
        const data = JSON.parse(pricingResult.api2.body);
        log('VP API 2 keys: ' + Object.keys(data).join(', '));

        const config = data.standardConfigurator || data;
        if (config.price) {
          log('VP API 2 price: ' + JSON.stringify(config.price));
          results.api2_price = config.price;
        }
        if (config.quantities) {
          log('VP API 2 quantities: ' + JSON.stringify(config.quantities).slice(0, 500));
          results.api2_quantities = config.quantities;
        }

        results.api2_full = JSON.stringify(data).slice(0, 3000);
      } catch(e) {
        log('VP API 2 parse error: ' + e.message);
        log('VP API 2 raw: ' + pricingResult.api2.body?.slice(0, 300));
      }
    } else {
      log('VP API 2 error: ' + (pricingResult.api2?.body || pricingResult.api2?.error)?.slice?.(0, 300));
    }

    // Parse API 3 — starting at price
    if (pricingResult.api3?.status === 200) {
      try {
        const data = JSON.parse(pricingResult.api3.body);
        log('VP API 3: ' + JSON.stringify(data).slice(0, 500));
        results.api3_data = data;
      } catch(e) {
        log('VP API 3 raw: ' + pricingResult.api3.body?.slice(0, 300));
      }
    } else {
      log('VP API 3 error: ' + (pricingResult.api3?.body || pricingResult.api3?.error)?.slice?.(0, 300));
    }

    // Also try to interact with the configurator directly on the page
    // Select qty=1000 first (visible in the page), then see what price shows
    const configState = await page.evaluate(() => {
      // Get price display
      const priceEls = Array.from(document.querySelectorAll('[class*="price"], [data-testid*="price"], [aria-label*="price"]'));
      const priceTexts = priceEls.map(el => ({ class: el.className?.slice(0,60), text: el.textContent?.trim().slice(0,80) })).filter(el => el.text.length > 0);

      // Get quantity options
      const qtyOptions = Array.from(document.querySelectorAll('[data-testid*="quantity"], [class*="quantity"], select'));

      // Get all buttons that might be quantity buttons
      const qtButtons = Array.from(document.querySelectorAll('button, [role="radio"], [role="option"]'))
        .filter(el => /^\d+$/.test(el.textContent?.trim()) || el.textContent?.trim().match(/^[\d,]+$/))
        .map(el => ({ tag: el.tagName, text: el.textContent.trim(), class: el.className?.slice(0,60) }))
        .slice(0, 20);

      return { priceTexts, qtyButtons };
    });

    log(`VP: ${configState.priceTexts.length} price elements on page`);
    configState.priceTexts.forEach(el => log(`  "${el.text}"`));
    log(`VP: ${configState.qtyButtons?.length || 0} quantity buttons`);
    if (configState.qtyButtons?.length > 0) {
      configState.qtyButtons.forEach(b => log(`  btn: "${b.text}"`));
    }

  } catch(e) {
    err('VP API capture: ' + e.message);
  } finally {
    await context.close();
  }

  return results;
}

// ─── AXIOM — Interact with Ant Design Configurator ───────────────────────────
// The page uses ant-select dropdowns. We need to click them to change specs.
// Default: 2"x3", qty=250. Target: 3"x3", qty=5000, White Matte BOPP
async function captureAxiomConfigurator(browser) {
  log('Axiom: interacting with Ant Design configurator for 3x3/5000 spec');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('workroomapp.com') || u.includes('axiomprint.com')) && !u.includes('image') && !u.includes('gallery')) {
      try {
        const body = await resp.text();
        apiLog.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const results = { prices: [], interactions: [], finalSpec: null };

  try {
    await page.goto('https://axiomprint.com/product/roll-labels-335', { waitUntil: 'networkidle', timeout: 35000 });
    await sleep(5000);

    // Current default: 2"x3" size, qty=250, 5 business days = $112.68

    // Step 1: Change SIZE to 3"x3"
    // The configurator uses ant-select components. Click to open dropdown.
    // The size selector is the first ant-select on the page
    log('Axiom: attempting to change size to 3"x3"');

    // Find and click the size selector (shows "2" x 3"")
    const sizeClicked = await page.evaluate(async () => {
      // Find the size ant-select
      const antSelects = document.querySelectorAll('.ant-select');
      for (const sel of antSelects) {
        const text = sel.textContent?.trim();
        if (text?.includes('x') && text?.match(/\d+["']?\s*x\s*\d+/)) {
          sel.click();
          return { found: true, text };
        }
      }
      return { found: false };
    });

    log('Axiom: size selector click: ' + JSON.stringify(sizeClicked));
    await sleep(2000);

    // Check if dropdown opened
    const dropdown = await page.$('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    if (dropdown) {
      log('Axiom: dropdown opened, looking for 3"x3" option');

      // Find and click 3"x3" option
      const opt3x3 = await page.$('.ant-select-item-option:has-text("3")');
      const allOptions = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.ant-select-item-option')).map(el => el.textContent?.trim());
      });
      log('Axiom: dropdown options: ' + allOptions.join(', '));

      // Look for 3x3
      const option3 = allOptions.find(o => o.includes('3') && o.toLowerCase().includes('x'));
      if (option3) {
        await page.click(`.ant-select-item-option:has-text("${option3}")`);
        log(`Axiom: selected size "${option3}"`);
        await sleep(3000);
        results.interactions.push({ action: 'size', value: option3 });
      } else {
        // Try custom size
        const customOption = allOptions.find(o => o.toLowerCase().includes('custom'));
        if (customOption) {
          log(`Axiom: trying custom size option: "${customOption}"`);
          await page.click(`.ant-select-item-option:has-text("${customOption}")`);
          await sleep(2000);

          // Look for width/height inputs that may appear
          const widthInput = await page.$('input[placeholder*="width" i], input[placeholder*="W" ]');
          const heightInput = await page.$('input[placeholder*="height" i], input[placeholder*="H"]');
          if (widthInput) {
            await widthInput.fill('3');
            log('Axiom: filled width=3');
          }
          if (heightInput) {
            await heightInput.fill('3');
            log('Axiom: filled height=3');
          }
          await sleep(2000);
          results.interactions.push({ action: 'custom_size', value: '3x3' });
        }
      }
    } else {
      log('Axiom: dropdown did not open, trying keyboard approach');
      // Try pressing on the selector element
      await page.keyboard.press('Escape');
      await sleep(500);
    }

    // Read current price
    let currentPrice = await page.evaluate(() => {
      const el = document.querySelector('[class*="priceContainer"], [class*="totalBlock"], [class*="price"]');
      return el ? el.textContent?.trim() : null;
    });
    log('Axiom: price after size selection: ' + currentPrice);

    // Step 2: Change QUANTITY to 5000
    log('Axiom: attempting to change quantity to 5000');
    const qtyClicked = await page.evaluate(async () => {
      const antSelects = document.querySelectorAll('.ant-select');
      for (const sel of antSelects) {
        const text = sel.textContent?.trim();
        // Quantity selector shows a number like "250"
        if (text && /^\d+$/.test(text) && parseInt(text) < 100000) {
          sel.click();
          return { found: true, text };
        }
      }
      return { found: false };
    });

    log('Axiom: qty selector click: ' + JSON.stringify(qtyClicked));
    await sleep(2000);

    const qtyDropdown = await page.$('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    if (qtyDropdown) {
      const qtyOptions = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.ant-select-item-option')).map(el => ({
          text: el.textContent?.trim(),
          value: el.getAttribute('data-value') || el.textContent?.trim()
        }));
      });
      log('Axiom: qty options: ' + qtyOptions.map(o => o.text).join(', '));

      // Find closest to 5000
      const opt5k = qtyOptions.find(o => o.text === '5000' || o.text === '5,000');
      const optClosest = qtyOptions.filter(o => !isNaN(parseInt(o.text.replace(/,/g,'')))).reduce((best, cur) => {
        const bv = Math.abs(parseInt(best.text.replace(/,/g,'')) - 5000);
        const cv = Math.abs(parseInt(cur.text.replace(/,/g,'')) - 5000);
        return cv < bv ? cur : best;
      }, qtyOptions[0]);

      const targetOpt = opt5k || optClosest;
      if (targetOpt) {
        await page.click(`.ant-select-item-option:has-text("${targetOpt.text}")`);
        log(`Axiom: selected qty "${targetOpt.text}"`);
        await sleep(4000);
        results.interactions.push({ action: 'quantity', value: targetOpt.text });
      }
    } else {
      log('Axiom: qty dropdown did not open');
      // Try pressing Escape and retry
      await page.keyboard.press('Escape');
    }

    // Read final price
    const finalPriceText = await page.evaluate(() => {
      const el = document.querySelector('[class*="priceContainer"], [class*="totalBlock"]');
      return el ? el.textContent?.trim() : null;
    });
    log('Axiom: price after qty selection: ' + finalPriceText);

    // Read all prices from page
    const pageText = await page.evaluate(() => document.body.innerText);
    const priceRe = /\$([\d,]+\.?\d{0,2})/g;
    let m;
    while ((m = priceRe.exec(pageText)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v >= 1 && v <= 100000) results.prices.push(v);
    }
    results.prices = [...new Set(results.prices)];
    log('Axiom: final all prices: ' + results.prices.join(', '));

    // Also try to read the spec from the page
    results.finalSpec = await page.evaluate(() => {
      const pageText = document.body.innerText;
      const sizeMatch = pageText.match(/Size[^\n]*\n([^\n]+)/);
      const qtyMatch = pageText.match(/Quantity[^\n]*\n([^\n]+)/);
      const matMatch = pageText.match(/Material[^\n]*\n([^\n]+)/);
      const priceMatch = pageText.match(/Total:\s*\$?([\d,]+\.?\d{0,2})/);
      const unitMatch = pageText.match(/\$?([\d,]+\.?\d{0,2})\s*each/);
      return { size: sizeMatch?.[1]?.trim(), qty: qtyMatch?.[1]?.trim(), material: matMatch?.[1]?.trim(), totalPrice: priceMatch?.[1], unitPrice: unitMatch?.[1] };
    });
    log('Axiom: final spec: ' + JSON.stringify(results.finalSpec));

    // Check workroom API calls made during interaction
    log(`Axiom: ${apiLog.length} workroom API calls total`);
    const pricingCalls = apiLog.filter(c => c.body.includes('"price"') || c.body.includes('"amount"') || c.body.includes('"total"'));
    log(`Axiom: ${pricingCalls.length} pricing-related API calls`);
    pricingCalls.forEach(c => {
      log(`  ${c.url}`);
      log(`  body: ${c.body.slice(0, 300)}`);
    });

  } catch(e) {
    err('Axiom configurator: ' + e.message);
    results.error = e.message;
  } finally {
    await context.close();
  }

  return results;
}

// ─── UPRINTING — Roll Labels Configurator ────────────────────────────────────
// Found the real product URL: /roll-labels.html
// Has a "price-wrap" element with quantities: 1,000, 100, 250, 500
async function captureUprintingRollLabels(browser) {
  log('UPrinting: roll labels configurator /roll-labels.html');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('uprinting.com') || u.includes('price') || u.includes('quote') || u.includes('api')) && !u.includes('google') && !u.includes('double')) {
      try {
        const body = await resp.text();
        if (body.length > 10 && body.length < 500000) {
          apiLog.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
        }
      } catch(_) {}
    }
  });

  const page = await context.newPage();
  const results = { prices: [], priceTable: null, configState: null, apiCalls: [], error: null };

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(5000);

    log('UP: page title: ' + await page.title());

    // Get full page config state
    const configState = await page.evaluate(() => {
      return {
        priceWrap: document.getElementById('price-wrap')?.innerText?.slice(0, 2000),
        allPriceEls: Array.from(document.querySelectorAll('[id*="price"], [class*="price"]'))
          .map(el => ({ id: el.id, class: el.className?.slice(0,60), text: el.innerText?.trim().slice(0,200) }))
          .filter(el => el.text.length > 0),
        formData: {
          selects: Array.from(document.querySelectorAll('select')).map(s => ({
            name: s.name, id: s.id, value: s.value,
            options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 25)
          })),
          inputs: Array.from(document.querySelectorAll('input')).map(i => ({
            name: i.name, id: i.id, type: i.type, value: i.value, placeholder: i.placeholder,
            min: i.min, max: i.max
          })).filter(i => i.name || i.id).slice(0, 30)
        },
        // Look for price data in page scripts
        priceDataScript: Array.from(document.querySelectorAll('script:not([src])')).find(s =>
          s.textContent.includes('price') && s.textContent.includes('quantity') && s.textContent.length < 50000
        )?.textContent?.slice(0, 3000) || null,
        pageGlobals: Object.keys(window).filter(k =>
          k.toLowerCase().includes('price') || k.toLowerCase().includes('config') || k.toLowerCase().includes('product')
        ).slice(0, 10)
      };
    });

    results.configState = configState;
    log('UP price-wrap: ' + (configState.priceWrap || 'not found'));
    log(`UP: ${configState.allPriceEls.length} price elements`);
    configState.allPriceEls.forEach(el => log(`  [${el.id||el.class?.split(' ')[0]}]: "${el.text.slice(0,100)}"`));

    if (configState.formData.selects.length > 0) {
      configState.formData.selects.forEach(s => log(`  Select "${s.name||s.id}": [${s.options.map(o=>o.t).join(' | ').slice(0,150)}]`));
    }

    log(`UP: pageGlobals: ${configState.pageGlobals.join(', ')}`);
    if (configState.priceDataScript) {
      log('UP: found price data in script, snippet: ' + configState.priceDataScript.slice(0, 500));
    }

    // Try to find and read price data from window variables
    const windowPriceData = await page.evaluate(() => {
      const result = {};

      // Common UPrinting price variable names
      const checkVars = ['prices', 'price_data', 'priceTable', 'productPrices', 'quantityPrices', 'pricing'];
      checkVars.forEach(v => {
        if (window[v]) result[v] = JSON.stringify(window[v]).slice(0, 500);
      });

      // Also try the page data config
      if (window.ddConfig) result.ddConfig = JSON.stringify(window.ddConfig).slice(0, 2000);
      if (window.ecommerce_product_data) result.ecommerce = JSON.stringify(window.ecommerce_product_data).slice(0, 500);

      return result;
    });

    if (Object.keys(windowPriceData).length > 0) {
      log('UP: window price data found: ' + JSON.stringify(windowPriceData).slice(0, 500));
    }

    // Click through the form options to trigger price updates
    // UPrinting uses quantity buttons (not select) based on the price-wrap element
    // The price-wrap shows: "Quantity: 1,000, 100, 250, 500"
    // We need to click on a quantity to update the price

    // Try clicking the 1,000 quantity option
    try {
      const qtyButtons = await page.$$('[class*="qty-option"], [class*="quantity-option"], [data-qty], [class*="quantityOptions"] button, #quantity-table td, .qty-btn');
      log(`UP: ${qtyButtons.length} quantity option buttons`);

      // Try clicking on text "1,000" or similar
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('*')).filter(el => {
          const text = el.textContent?.trim();
          return text === '1,000' || text === '1000' || (text === '500') || (text === '5,000');
        });
        if (els.length > 0) els[0].click();
      });
      await sleep(3000);
    } catch(e) { log('UP: qty click error: ' + e.message); }

    // Try looking for the price in common UPrinting price element IDs
    const priceValues = await page.evaluate(() => {
      const priceEl = document.getElementById('total_price') || document.getElementById('price') ||
                      document.querySelector('[class*="total-price"], [class*="totalPrice"]');
      const unitPriceEl = document.getElementById('unit_price') || document.querySelector('[class*="unit-price"]');

      // Extract all dollar amounts
      const allText = document.body.innerText;
      const dollars = [];
      const re = /\$([\d,]+\.?\d{0,2})/g;
      let m;
      while ((m = re.exec(allText)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 5 && v <= 50000) dollars.push(v);
      }

      return {
        totalPrice: priceEl?.textContent?.trim(),
        unitPrice: unitPriceEl?.textContent?.trim(),
        allPrices: [...new Set(dollars)].slice(0, 30)
      };
    });

    log('UP: price values: ' + JSON.stringify(priceValues));
    if (priceValues.allPrices.length > 0) {
      results.prices = priceValues.allPrices;
    }
    results.priceTable = priceValues;

    // Try interacting with the standard UPrinting form
    // UPrinting often has a "Custom Stickers" style form with dropdowns
    const standardSelects = configState.formData.selects;
    for (const sel of standardSelects) {
      const name = (sel.name || sel.id || '').toLowerCase();
      if (name.includes('quantity') || name.includes('qty')) {
        const opt5k = sel.options.find(o => o.t.includes('5,000') || o.t.includes('5000'));
        const opt1k = sel.options.find(o => o.t.includes('1,000') || o.t.includes('1000'));
        const targetOpt = opt5k || opt1k;

        if (targetOpt) {
          const selector = sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`;
          await page.selectOption(selector, targetOpt.v);
          log(`UP: selected qty ${targetOpt.t}`);
          await sleep(4000);

          // Re-read prices
          const newPrices = await page.evaluate(() => {
            const allText = document.body.innerText;
            const dollars = [];
            const re = /\$([\d,]+\.?\d{0,2})/g;
            let m;
            while ((m = re.exec(allText)) !== null) {
              const v = parseFloat(m[1].replace(/,/g, ''));
              if (v >= 5 && v <= 50000) dollars.push(v);
            }
            return [...new Set(dollars)];
          });
          log('UP: prices after qty selection: ' + newPrices.join(', '));
          results.prices = newPrices;
        }
        break;
      }
    }

    // Check API calls
    const relevantApis = apiLog.filter(c => !c.url.includes('google') && !c.url.includes('pinterest') && !c.url.includes('youtube') && !c.url.includes('cookielaw') && !c.url.includes('doubleclick'));
    log(`UP: ${relevantApis.length} relevant API calls`);
    for (const call of relevantApis) {
      log(`  ${call.status} ${call.url}`);
      if (call.body?.includes('"price"') || call.body?.includes('"amount"') || call.body?.includes('"total"')) {
        log(`  *** PRICING DATA: ${call.body.slice(0, 500)}`);
      }
    }

    results.apiCalls = relevantApis.slice(0, 10).map(c => ({ url: c.url, status: c.status, body: c.body?.slice(0, 500) }));

  } catch(e) {
    results.error = e.message;
    err('UP: ' + e.message);
  } finally {
    await context.close();
  }

  return results;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Vistaprint API + Axiom Configurator + UPrinting Roll Labels ===');
  log(`Date: ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const allResults = {};

  try {
    log('');
    log('=== VISTAPRINT — Direct API Call ===');
    allResults.vistaprint = await captureVistaprintAPI(browser);
    log('');

    log('=== AXIOM — Ant Design Configurator ===');
    allResults.axiom = await captureAxiomConfigurator(browser);
    log('');

    log('=== UPRINTING — Roll Labels Configurator ===');
    allResults.uprinting = await captureUprintingRollLabels(browser);
    log('');

  } finally {
    await browser.close();
  }

  // Write log
  const logFile = path.join(ROOT_DIR, 'data', `capture-vp-axiom-up-${nowISO()}.json`);
  fs.writeFileSync(logFile, JSON.stringify(allResults, null, 2));
  log('Capture log: ' + logFile);

  log('');
  log('=== SUMMARY ===');
  log('Vistaprint pricing table: ' + (allResults.vistaprint?.quantityPricingTable ? JSON.stringify(allResults.vistaprint.quantityPricingTable) : 'not captured'));
  log('Axiom final prices: ' + (allResults.axiom?.prices?.join(', ') || 'none'));
  log('UPrinting prices: ' + (allResults.uprinting?.prices?.join(', ') || 'none'));
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
