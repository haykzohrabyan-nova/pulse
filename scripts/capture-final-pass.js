#!/usr/bin/env node
/**
 * capture-final-pass.js
 *
 * Final data extraction pass:
 *
 * 1. UPrinting: Extract full CalcPricingData from page, then use JS to set
 *    qty=5000, trigger price update, read result. Also get 3"x3" pricing.
 *
 * 2. Axiom: Use proper Ant Design interaction (mousedown + click events)
 *    to select qty=5000. Read price for 3x3 if size option available.
 *
 * 3. Vistaprint: Hit compatibility-pricing API with domcontentloaded wait.
 *    Extract quantity pricing table for Roll Labels.
 *
 * 4. Sticker Mule: Try to get the pricing page or extract from page JS state.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const RAW_FILE  = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');

function log(msg)  { console.log(`[final] ${msg}`); }
function err(msg)  { console.error(`[ERR]   ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ─── UPRINTING — CalcPricingData extraction ───────────────────────────────────
async function captureUprintingPricingMatrix(browser) {
  log('UPrinting: extracting CalcPricingData + triggering 5000 qty price');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Intercept the UPrinting pricing calculator API calls
  const pricingApiCalls = [];
  context.on('request', req => {
    const u = req.url();
    if (u.includes('muffins') && u.includes('price') || u.includes('calc-js') || u.includes('pricing')) {
      pricingApiCalls.push({ url: u, method: req.method(), postData: req.postData() });
    }
  });

  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('muffins') || u.includes('uprinting.com/api') || u.includes('checkout-api')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        if (body.includes('price') || body.includes('amount')) {
          pricingApiCalls.push({ url: u, status: resp.status(), type: 'response', body: body.slice(0, 1000) });
        }
      } catch(_) {}
    }
  });

  const page = await context.newPage();
  const result = { prices: {}, calPricingData: null, error: null };

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(6000);

    // Extract the full CalcPricingData from page
    const fullPageData = await page.evaluate(() => {
      const result = {
        // Try to get CalcPricingData
        calcPricingData: null,
        initialData: {},
        quantityOptions: [],
        currentPrice: null
      };

      // Get CalcPricingData from script tags
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const script of scripts) {
        const text = script.textContent;
        if (text.includes('CalcPricingData')) {
          const match = text.match(/var CalcPricingData\s*=\s*(\{[\s\S]*?\});?\s*(?:var|$)/);
          if (match) {
            try {
              result.calcPricingData = JSON.parse(match[1]);
            } catch(e) {
              result.calcPricingDataRaw = match[1].slice(0, 5000);
            }
          }
        }
        if (text.includes('initialProductName')) {
          const vars = ['initialProductName', 'initialUnitPrice', 'initialQty', 'initialEcommerceVariant'];
          vars.forEach(v => {
            const m = text.match(new RegExp(`var ${v}\\s*=\\s*'([^']+)'`));
            if (m) result.initialData[v] = m[1];
          });
        }
      }

      // Get quantity options from the price table
      const priceWrap = document.getElementById('price-wrap') || document.getElementById('price');
      if (priceWrap) {
        result.priceWrapHTML = priceWrap.innerHTML?.slice(0, 5000);
        result.priceWrapText = priceWrap.innerText?.slice(0, 2000);
      }

      // Get all quantity options visible on page
      const qtyEls = Array.from(document.querySelectorAll('[data-qty], [class*="qty"], [id*="qty"]'))
        .map(el => ({ tag: el.tagName, text: el.textContent?.trim().slice(0,30), value: el.getAttribute('data-qty') || el.value }))
        .filter(el => el.text || el.value);
      result.quantityOptions = qtyEls.slice(0, 30);

      // Get current price
      result.currentPrice = document.getElementById('calc-price')?.textContent?.trim();
      result.currentUnitPrice = document.getElementById('calc-price-per-piece')?.textContent?.trim();

      return result;
    });

    log('UP CalcPricingData present: ' + (!!fullPageData.calcPricingData || !!fullPageData.calcPricingDataRaw));
    log('UP initial data: ' + JSON.stringify(fullPageData.initialData));
    log('UP current price: ' + fullPageData.currentPrice + ' / ' + fullPageData.currentUnitPrice);

    if (fullPageData.calcPricingData) {
      const cpd = fullPageData.calcPricingData;
      log('UP CalcPricingData keys: ' + Object.keys(cpd).join(', '));
      if (cpd.request) log('UP CalcPricingData.request: ' + JSON.stringify(cpd.request).slice(0, 500));
      result.calPricingData = cpd;
    } else if (fullPageData.calcPricingDataRaw) {
      log('UP CalcPricingData raw: ' + fullPageData.calcPricingDataRaw.slice(0, 500));
    }

    // Current: 1000 qty, 2"x2" = $131.23
    result.prices['1000_qty_2x2_bopp'] = { price: 131.23, unitPrice: 0.13, turnaround: '6 Business Days', spec: '2"x2" White BOPP Roll, Rounded Corners, 1,000 qty' };

    // Now try to trigger a price update for qty=5000 by manipulating the Angular form
    const priceUpdate = await page.evaluate(async () => {
      // UPrinting uses Angular. Try to find the Angular scope and update quantity.
      try {
        // Find the calculator element
        const calcEl = document.querySelector('#calc_33_grid, [id*="calc"]');
        if (!calcEl) return { error: 'no calc element' };

        // Try Angular scope injection
        const scope = angular?.element(calcEl)?.scope?.();
        if (scope) {
          return { angularScope: true, keys: Object.keys(scope).filter(k => !k.startsWith('$')).slice(0, 20) };
        }
      } catch(e) {}

      // Try to find and click the 5000 qty row/option
      // Look for "5,000" text in the page
      const allEls = Array.from(document.querySelectorAll('*'));
      const qty5kEl = allEls.find(el =>
        el.childNodes.length === 1 && el.textContent?.trim() === '5,000' &&
        (el.tagName === 'TD' || el.tagName === 'LI' || el.tagName === 'A' || el.tagName === 'SPAN')
      );

      if (qty5kEl) {
        qty5kEl.click();
        return { clicked: true, tag: qty5kEl.tagName, class: qty5kEl.className };
      }

      // Try clicking on any element that has 5,000 text
      const qty5kParent = allEls.find(el => el.textContent?.trim() === '5,000');
      if (qty5kParent) {
        qty5kParent.click();
        return { clickedParent: true, tag: qty5kParent.tagName };
      }

      return { error: 'qty 5000 element not found' };
    });

    log('UP qty 5000 interaction: ' + JSON.stringify(priceUpdate));
    await sleep(3000);

    // Re-read price
    const updatedPrice = await page.evaluate(() => ({
      price: document.getElementById('calc-price')?.textContent?.trim(),
      unitPrice: document.getElementById('calc-price-per-piece')?.textContent?.trim(),
      qty: document.getElementById('calc-qty')?.value || document.querySelector('[id*="qty"]')?.value
    }));
    log('UP price after qty=5000 click: ' + JSON.stringify(updatedPrice));

    if (updatedPrice.price && updatedPrice.price !== '$131.23') {
      const p = parseFloat(updatedPrice.price.replace(/[^0-9.]/g, ''));
      const u = parseFloat(updatedPrice.unitPrice?.replace(/[^0-9.]/g, '') || '0');
      if (p > 0) {
        log(`UP: got updated price for qty=5000: $${p} ($${u}/each)`);
        result.prices['5000_qty'] = { price: p, unitPrice: u, spec: 'qty=5000 (size may still be default 2x2)' };
      }
    }

    // Try accessing the UPrinting pricing calc API directly
    // They use a service worker + calc-js. Try the direct pricing endpoint.
    const directPriceResult = await page.evaluate(async () => {
      // Try to find the pricing fetch in window.ProductCalculator
      const pc = window.ProductCalculator;
      if (pc) return { type: 'ProductCalculator', keys: Object.keys(pc).slice(0, 10) };

      // Try calling the pricing API directly
      try {
        const r = await fetch('/muffins/issue.php?requestTokenOnly=1', { credentials: 'include' });
        const token = await r.text();
        return { tokenResponse: token.slice(0, 100) };
      } catch(e) { return { error: e.message }; }
    });
    log('UP direct price API: ' + JSON.stringify(directPriceResult));

    // Log any pricing API calls captured
    log(`UP: ${pricingApiCalls.length} pricing API interactions`);
    pricingApiCalls.forEach(c => {
      if (c.type === 'response' && c.body) {
        log(`  RESP ${c.status} ${c.url}: ${c.body.slice(0, 200)}`);
      }
    });

  } catch(e) {
    result.error = e.message;
    err('UP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── AXIOM — Better Ant Design Interaction ────────────────────────────────────
async function captureAxiomQty5000(browser) {
  log('Axiom: using JS injection to interact with React/Ant Design state');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const result = { prices: [], specs: null, error: null };

  try {
    await page.goto('https://axiomprint.com/product/roll-labels-335', { waitUntil: 'networkidle', timeout: 35000 });
    await sleep(5000);

    // Default: 2"x3" qty=250 = $112.68 ($0.45/each)
    result.prices.push({ qty: 250, size: '2"x3"', price: 112.68, unitPrice: 0.45, turnaround: '5 business days' });

    // Read all available options from the page
    const pageConfig = await page.evaluate(() => {
      const config = {
        availableSizes: [],
        availableQtys: [],
        availableMaterials: [],
        currentSpec: {}
      };

      // Get text content of configurator area
      const pageText = document.body.innerText;

      // Extract sizes from the page text
      const sizeSection = pageText.match(/Size \(W x H\)\n([\s\S]*?)(?:Orientation|Material|Print)/);
      if (sizeSection) {
        config.availableSizes = sizeSection[1].split('\n').map(s => s.trim()).filter(s => s && s.includes('"'));
      }

      // Extract materials
      const matSection = pageText.match(/Material\n([\s\S]*?)(?:Print Color|Round Corners|Lamination)/);
      if (matSection) {
        config.availableMaterials = matSection[1].split('\n').map(s => s.trim()).filter(s => s.length > 2);
      }

      // Extract all Ant Design select option values from the DOM
      // This is a clever trick - look at the React fiber for the dropdown options
      const antSelects = Array.from(document.querySelectorAll('.ant-select'));
      config.antSelectCount = antSelects.length;

      // Try to find the qty input directly
      const qtyInput = document.querySelector('input[id*="qty"], input[name*="qty"], input[placeholder*="qty"]');
      config.qtyInput = qtyInput ? { id: qtyInput.id, name: qtyInput.name, value: qtyInput.value, type: qtyInput.type } : null;

      return config;
    });

    log('Axiom config: sizes=' + pageConfig.availableSizes.join(', '));
    log('Axiom config: materials=' + pageConfig.availableMaterials.join(', '));
    log('Axiom config: antSelects=' + pageConfig.antSelectCount);
    log('Axiom config: qtyInput=' + JSON.stringify(pageConfig.qtyInput));

    // Now try to change the quantity selector
    // Ant Design selects need: focus → click → wait for dropdown → click option
    // Try clicking the qty select using keyboard navigation
    const antSelects = await page.$$('.ant-select');
    log(`Axiom: found ${antSelects.length} .ant-select elements`);

    // Identify which one is quantity (shows "250")
    let qtySelect = null;
    for (const sel of antSelects) {
      const text = await sel.textContent();
      if (text?.trim().match(/^\d+$/) && parseInt(text.trim()) < 100000) {
        qtySelect = sel;
        log(`Axiom: found qty selector showing "${text.trim()}"`);
        break;
      }
    }

    if (qtySelect) {
      // Click the selector to open dropdown
      await qtySelect.click();
      await sleep(2000);

      // Check if dropdown opened
      const dropdown = await page.$('.ant-select-dropdown');
      if (dropdown) {
        const isVisible = await dropdown.evaluate(el => !el.classList.contains('ant-select-dropdown-hidden'));
        log('Axiom: dropdown visible: ' + isVisible);

        if (isVisible) {
          // Get all options
          const options = await page.evaluate(() => {
            const opts = Array.from(document.querySelectorAll('.ant-select-item-option'));
            return opts.map(o => ({
              text: o.textContent?.trim(),
              value: o.getAttribute('title') || o.getAttribute('data-value') || o.textContent?.trim(),
              selected: o.classList.contains('ant-select-item-option-selected')
            }));
          });
          log(`Axiom: ${options.length} dropdown options: ${options.map(o => o.text).join(', ')}`);

          // Find 5000
          const opt5k = options.find(o => o.text === '5,000' || o.text === '5000');
          const optMax = options.reduce((best, cur) => {
            const bv = parseInt(best.text?.replace(/,/g, '') || '0');
            const cv = parseInt(cur.text?.replace(/,/g, '') || '0');
            return cv > bv ? cur : best;
          }, options[0]);

          const targetOpt = opt5k || optMax;
          if (targetOpt) {
            await page.click(`.ant-select-item-option[title="${targetOpt.value}"], .ant-select-item-option:has-text("${targetOpt.text}")`);
            log(`Axiom: clicked qty option "${targetOpt.text}"`);
            await sleep(4000);

            // Read updated price
            const newPriceText = await page.evaluate(() => {
              const el = document.querySelector('[class*="priceContainer"], [class*="totalBlock"]');
              return el?.textContent?.trim();
            });
            log('Axiom: price after qty selection: ' + newPriceText);

            if (newPriceText) {
              const priceMatch = newPriceText.match(/\$?([\d,]+\.?\d{0,2})/g);
              const prices = priceMatch?.map(p => parseFloat(p.replace(/[^0-9.]/g, ''))).filter(p => p > 0);
              if (prices?.length > 0) {
                log(`Axiom: extracted price(s) after qty update: [${prices.join(', ')}]`);
                result.prices.push({ qty: targetOpt.text, price: Math.min(...prices), spec: `Axiom Roll Labels qty=${targetOpt.text}` });
              }
            }

            // Also read unit price
            const unitPriceText = await page.evaluate(() => {
              const allText = document.body.innerText;
              const match = allText.match(/\$?([\d,]+\.?\d{0,2})\s*each/);
              return match ? match[0] : null;
            });
            log('Axiom: unit price after update: ' + unitPriceText);
          }
        } else {
          log('Axiom: dropdown was not visible after click');
        }
      } else {
        log('Axiom: no dropdown found after click');
      }
    }

    // Now try to change SIZE to 3"x3"
    // Find the size selector (shows "2" x 3"")
    const sizeAntSelects = await page.$$('.ant-select');
    let sizeSelect = null;
    for (const sel of sizeAntSelects) {
      const text = await sel.textContent();
      if (text?.includes('"') && text?.includes('x')) {
        sizeSelect = sel;
        log(`Axiom: found size selector showing "${text.trim()}"`);
        break;
      }
    }

    if (sizeSelect) {
      await sizeSelect.click();
      await sleep(2000);

      const sizeDropdown = await page.$('.ant-select-dropdown');
      if (sizeDropdown) {
        const sizeVisible = await sizeDropdown.evaluate(el => !el.classList.contains('ant-select-dropdown-hidden'));
        if (sizeVisible) {
          const sizeOpts = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.ant-select-item-option'))
              .map(o => o.textContent?.trim()).filter(t => t);
          });
          log('Axiom: size options: ' + sizeOpts.join(', '));

          // Find 3"x3" or closest
          const opt3x3 = sizeOpts.find(o => o.includes('3') && o.includes('3') && o.includes('x'));
          if (opt3x3) {
            await page.click(`.ant-select-item-option:has-text("${opt3x3}")`);
            log(`Axiom: selected size "${opt3x3}"`);
            await sleep(3000);

            const sizePrice = await page.evaluate(() => {
              const el = document.querySelector('[class*="priceContainer"], [class*="totalBlock"]');
              return el?.textContent?.trim();
            });
            log('Axiom: price after size change: ' + sizePrice);
          }
        }
      }
    }

    // Final price read
    const finalState = await page.evaluate(() => {
      const allText = document.body.innerText;
      const priceMatch = allText.match(/Total:\s*\$?([\d,]+\.?\d{0,2})/);
      const unitMatch = allText.match(/\$?([\d,]+\.?\d{0,2})\s*each/);
      const qtyMatch = allText.match(/Quantity\n\n([^\n]+)/);
      const sizeMatch = allText.match(/Size \(W x H\)\n([^\n]+)\n\nOrientation/);
      return {
        totalPrice: priceMatch?.[1],
        unitPrice: unitMatch?.[1],
        qty: qtyMatch?.[1]?.trim(),
        size: sizeMatch?.[1]?.trim()
      };
    });
    log('Axiom: final state: ' + JSON.stringify(finalState));
    result.specs = finalState;

    // All prices on page
    const allPrices = await page.evaluate(() => {
      const re = /\$([\d,]+\.?\d{0,2})/g;
      const prices = [];
      const text = document.body.innerText;
      let m;
      while ((m = re.exec(text)) !== null) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 1 && v <= 100000) prices.push(v);
      }
      return [...new Set(prices)];
    });
    log('Axiom: all page prices: ' + allPrices.join(', '));

  } catch(e) {
    result.error = e.message;
    err('Axiom: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── VISTAPRINT — API with domcontentloaded ────────────────────────────────────
async function captureVistaprintAPIv2(browser) {
  log('Vistaprint: API capture with domcontentloaded wait');
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const apiCaptures = [];
  context.on('response', async resp => {
    const u = resp.url();
    if ((u.includes('product-pages-v2-bff') || u.includes('website-pricing-service') || u.includes('wrangler.prod.merch') || u.includes('compatibility-pricing')) && resp.status() < 400) {
      try {
        const body = await resp.text();
        apiCaptures.push({ url: u, status: resp.status(), body: body.slice(0, 10000) });
      } catch(_) {}
    }
  });

  const page = await context.newPage();
  const result = { quantityPrices: [], rawApiResponse: null, error: null };

  try {
    // Use domcontentloaded to avoid timeout
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(8000); // Give APIs time to fire

    log(`VP: ${apiCaptures.length} pricing API responses captured`);

    for (const cap of apiCaptures) {
      log(`VP API: ${cap.url.split('?')[0].split('/').slice(-3).join('/')}`);

      if (cap.url.includes('compatibility-pricing')) {
        try {
          const data = JSON.parse(cap.body);
          log('VP compatibility-pricing keys: ' + Object.keys(data).join(', '));
          log('VP compatibility-pricing sample: ' + JSON.stringify(data).slice(0, 1000));
          result.rawApiResponse = data;

          // Extract quantity pricing
          const jsonStr = JSON.stringify(data);

          // Look for quantity array with prices
          if (data.quantities) {
            log('VP quantities: ' + JSON.stringify(data.quantities).slice(0, 1000));
            result.quantityPrices = data.quantities;
          }

          // Parse for price fields
          const priceMatches = [];
          const re = /"(?:quantity)":\s*"?(\d+)"?[^}]{0,200}"(?:totalListPrice|totalDiscountedPrice|listPrice|price)":\s*(\d+\.?\d*)/g;
          let m;
          while ((m = re.exec(jsonStr)) !== null) {
            priceMatches.push({ qty: parseInt(m[1]), price: parseFloat(m[2]) });
          }
          if (priceMatches.length > 0) {
            log('VP: quantity price pairs found: ' + JSON.stringify(priceMatches).slice(0, 500));
            result.quantityPrices = priceMatches;
          }

          // Also try alternate structure
          if (Array.isArray(data)) {
            data.forEach(item => {
              if (item.quantity && (item.price || item.totalListPrice)) {
                result.quantityPrices.push({ qty: item.quantity, price: item.price || item.totalListPrice });
              }
            });
          }

        } catch(e) { log('VP compat-pricing parse: ' + e.message + ' | raw: ' + cap.body.slice(0, 200)); }
      }

      if (cap.url.includes('website-pricing-service')) {
        try {
          const data = JSON.parse(cap.body);
          log('VP pricing-service: ' + JSON.stringify(data).slice(0, 500));
        } catch(_) { log('VP pricing-service raw: ' + cap.body.slice(0, 200)); }
      }

      if (cap.url.includes('wrangler') && cap.url.includes('configuratorData')) {
        try {
          const data = JSON.parse(cap.body);
          const config = data.standardConfigurator || data;
          if (config.price) {
            log('VP wrangler price: ' + JSON.stringify(config.price));
          }
          if (config.quantities) {
            log('VP wrangler quantities: ' + JSON.stringify(config.quantities).slice(0, 500));
          }
        } catch(e) { log('VP wrangler parse: ' + e.message); }
      }
    }

    // Try calling the compatibility-pricing API directly from the page context
    const directApiResult = await page.evaluate(async () => {
      const quantities = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
      const url = `https://product-pages-v2-bff.prod.merch.vpsvc.com/v1/compatibility-pricing/vistaprint/en-us/PRD-DF5PWTHC?` +
        `selections=${encodeURIComponent(JSON.stringify({}))}&` +
        `quantities=${encodeURIComponent(JSON.stringify(quantities))}&` +
        `version=75&applyProductConstraints=true&currentQuantity=0&requestor=po-product-page-configurator`;

      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json', 'Origin': 'https://www.vistaprint.com' }
        });
        const text = await r.text();
        return { status: r.status, body: text };
      } catch(e) { return { error: e.message }; }
    });

    log(`VP direct compatibility-pricing: status=${directApiResult.status || directApiResult.error}`);
    if (directApiResult.status === 200) {
      try {
        const data = JSON.parse(directApiResult.body);
        log('VP direct API keys: ' + Object.keys(data).join(', '));
        log('VP direct API sample: ' + JSON.stringify(data).slice(0, 1000));

        // Extract all quantity/price pairs
        const jsonStr = JSON.stringify(data);
        const priceRe = /"quantity":\s*"?(\d+)"?[^}]*"(?:totalListPrice|totalDiscountedPrice|price)":\s*(\d+\.?\d*)/g;
        let m;
        const pairs = [];
        while ((m = priceRe.exec(jsonStr)) !== null) {
          pairs.push({ qty: parseInt(m[1]), price: parseFloat(m[2]) });
        }
        if (pairs.length > 0) {
          log('VP: quantity price table from direct API: ' + JSON.stringify(pairs));
          result.quantityPrices = pairs;
        }

        result.directApiResponse = JSON.stringify(data).slice(0, 3000);
      } catch(e) { log('VP direct API parse: ' + e.message); }
    }

    // Try the wrangler API for qty=5000 directly
    const wranglerResult = await page.evaluate(async () => {
      const url = `https://wrangler.prod.merch.vpsvc.com/api/v1/vistaprint/en-us/configuratorData/PRD-DF5PWTHC/75?` +
        `merchandisingExperience=UploadFlow&responseComponents=standardConfigurator&selectedQuantity=5000&` +
        `requestor=inspector-gadget-pdp-configurator-fragment&includeVat=false&priceStyle=relative`;
      try {
        const r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        return { status: r.status, body: text };
      } catch(e) { return { error: e.message }; }
    });

    log(`VP wrangler qty=5000: status=${wranglerResult.status || wranglerResult.error}`);
    if (wranglerResult.status === 200) {
      try {
        const data = JSON.parse(wranglerResult.body);
        const config = data.standardConfigurator || data;
        log('VP wrangler qty=5000 price: ' + JSON.stringify(config.price || config.quantities?.selected || 'none'));

        if (config.price?.totalListPrice) {
          log(`VP: price at qty=5000 from wrangler: $${config.price.totalListPrice}`);
          result.price5000 = config.price.totalListPrice;
        }
        if (config.quantities) {
          log('VP quantities: ' + JSON.stringify(config.quantities).slice(0, 500));
        }
      } catch(e) { log('VP wrangler parse: ' + e.message + ' raw: ' + wranglerResult.body.slice(0, 200)); }
    }

  } catch(e) {
    result.error = e.message;
    err('VP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Final Capture Pass ===');
  log(`Date: ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = {};

  try {
    log('');
    log('=== UPRINTING — CalcPricingData ===');
    results.uprinting = await captureUprintingPricingMatrix(browser);
    log('');

    log('=== AXIOM — Qty 5000 Interaction ===');
    results.axiom = await captureAxiomQty5000(browser);
    log('');

    log('=== VISTAPRINT — API v2 ===');
    results.vistaprint = await captureVistaprintAPIv2(browser);
    log('');
  } finally {
    await browser.close();
  }

  const logFile = path.join(ROOT_DIR, 'data', `capture-final-${nowISO()}.json`);
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));
  log('Log: ' + logFile);

  log('');
  log('=== FINAL SUMMARY ===');
  log('Vistaprint qty prices: ' + JSON.stringify(results.vistaprint?.quantityPrices || []));
  log('Vistaprint price@5000: ' + (results.vistaprint?.price5000 || 'not captured'));
  log('Axiom prices: ' + results.axiom?.prices?.map(p => JSON.stringify(p)).join(', '));
  log('UPrinting prices: ' + JSON.stringify(results.uprinting?.prices || {}));
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
