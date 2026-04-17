/**
 * capture-packola-api.js
 * PRI-8: Intercept Packola quote API calls to get STE box + stand-up pouch pricing
 * Uses browser-first navigation to trigger the API and capture the response
 */

const { chromium } = require('playwright');
const fs = require('fs');

const RESULTS = [];
const API_RESPONSES = [];

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function capturePackolaBoxApi(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Capture ALL network responses
  page.on('response', async (resp) => {
    const url = resp.url();
    const status = resp.status();
    // Look for price/quote API calls
    if ((url.includes('api') || url.includes('quote') || url.includes('price')) &&
        !url.includes('csrf') && !url.includes('manifest') && !url.includes('holiday') &&
        !url.includes('cookie') && !url.includes('search')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json') || status >= 200 && status < 300) {
          const text = await resp.text().catch(() => null);
          if (text && text.length < 50000) {
            const entry = { url, status, body: text.slice(0, 3000) };
            API_RESPONSES.push(entry);
            log(`API call: ${url} [${status}] - ${text.slice(0, 200)}`);
          }
        }
      } catch (e) {}
    }
  });

  try {
    log('=== Packola STE Boxes ===');
    await page.goto('https://www.packola.com/products/product-box', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Get configurator state
    const initialState = await page.evaluate(() => {
      const r = {
        title: document.title,
        selects: [],
        inputs: [],
        buttons: []
      };

      // Get all select elements
      r.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      }));

      // Get number inputs
      r.inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]')).map(i => ({
        name: i.name, id: i.id, value: i.value, placeholder: i.placeholder, class: i.className.slice(0,30)
      })).filter(i => i.name || i.id || i.placeholder);

      // Get buttons
      r.buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(b => ({
        text: b.textContent.trim().slice(0,30), class: b.className.slice(0,30)
      })).filter(b => b.text).slice(0, 20);

      // Get all qty-related elements
      r.qtyEls = Array.from(document.querySelectorAll('[class*="qty"], [class*="quantity"], [data-qty], [id*="qty"]')).map(el => ({
        tag: el.tagName, class: el.className.slice(0,40), text: el.textContent.trim().slice(0,50)
      })).slice(0, 10);

      return r;
    });

    log(`Initial state: inputs=${JSON.stringify(initialState.inputs)}`);
    log(`Selects: ${JSON.stringify(initialState.selects.map(s => s.id || s.name))}`);
    log(`Buttons: ${JSON.stringify(initialState.buttons)}`);

    // Try to select "Straight Tuck End" style if there's a dropdown
    const boxStyleEl = initialState.selects.find(s => s.options.some(o => o.t.toLowerCase().includes('straight') || o.t.toLowerCase().includes('tuck')));
    if (boxStyleEl) {
      const ste = boxStyleEl.options.find(o => o.t.toLowerCase().includes('straight'));
      if (ste) {
        await page.selectOption(`select[name="${boxStyleEl.name}"], select[id="${boxStyleEl.id}"]`, ste.v);
        log(`Selected STE box style: ${ste.t}`);
        await page.waitForTimeout(2000);
      }
    }

    // Enter dimensions: L=4, W=2, D=5
    const dimInputs = await page.$$('input[type="number"]');
    log(`Found ${dimInputs.length} number inputs`);

    if (dimInputs.length >= 1) {
      // Try to identify which is L, W, D by placeholder or label
      for (let i = 0; i < Math.min(dimInputs.length, 4); i++) {
        const ph = await dimInputs[i].getAttribute('placeholder') || '';
        const nm = await dimInputs[i].getAttribute('name') || '';
        const id = await dimInputs[i].getAttribute('id') || '';
        log(`Input ${i}: placeholder="${ph}" name="${nm}" id="${id}"`);
      }

      // Fill dimensions in order (try L, W, D)
      if (dimInputs.length >= 3) {
        await dimInputs[0].triple_click?.() || await dimInputs[0].click({ clickCount: 3 });
        await dimInputs[0].fill('4');
        await page.waitForTimeout(300);
        await dimInputs[1].click({ clickCount: 3 });
        await dimInputs[1].fill('2');
        await page.waitForTimeout(300);
        await dimInputs[2].click({ clickCount: 3 });
        await dimInputs[2].fill('5');
        await page.waitForTimeout(300);
        // Press Tab to trigger update
        await dimInputs[2].press('Tab');
        await page.waitForTimeout(2000);
        log('Filled dimensions 4×2×5');
      }
    }

    // Try to select 18pt paper (if available) and Gloss coating
    for (const sel of initialState.selects) {
      const pt18 = sel.options.find(o => o.t.includes('18'));
      if (pt18) {
        await page.selectOption(`select[name="${sel.name}"]`, pt18.v);
        log(`Set 18pt: ${pt18.t}`);
        await page.waitForTimeout(500);
      }
      const gloss = sel.options.find(o => o.t.toLowerCase().includes('gloss') && !o.t.toLowerCase().includes('soft') && !o.t.toLowerCase().includes('uv'));
      if (gloss) {
        await page.selectOption(`select[name="${sel.name}"]`, gloss.v);
        log(`Set gloss: ${gloss.t}`);
        await page.waitForTimeout(500);
      }
    }

    // Now iterate through quantities and capture pricing
    // Try clicking quantity options in the price grid
    const qtysToCapture = [250, 500, 1000, 2000, 2500];

    for (const qty of qtysToCapture) {
      // Try multiple ways to select quantity
      let qtySet = false;

      // Method 1: Try select element
      try {
        await page.selectOption('select[name*="qty"], select[id*="qty"], select[name*="quantity"]', String(qty), { timeout: 1500 });
        qtySet = true;
        log(`Set qty ${qty} via select`);
      } catch (e) {}

      // Method 2: Try direct text click in price table
      if (!qtySet) {
        try {
          const cells = await page.$$('[class*="price"] td, [class*="qty-row"], [class*="tier"]');
          for (const cell of cells) {
            const text = await cell.textContent();
            if (text && (text.includes(String(qty)) || text.includes(qty.toLocaleString()))) {
              await cell.click();
              qtySet = true;
              log(`Set qty ${qty} via table cell click`);
              break;
            }
          }
        } catch (e) {}
      }

      // Method 3: Find and click qty buttons
      if (!qtySet) {
        try {
          await page.click(`button:has-text("${qty.toLocaleString()}"), [data-qty="${qty}"], span:text-is("${qty.toLocaleString()}")`, { timeout: 1500 });
          qtySet = true;
        } catch (e) {}
      }

      await page.waitForTimeout(1500);

      // Read current price from page
      const priceData = await page.evaluate(() => {
        const r = {};
        // Look for unit price and subtotal
        const unitPriceEl = document.querySelector('.calc-price-per-piece, [class*="unit-price"], [class*="price-per"]');
        const subtotalEl = document.querySelector('.calc-price.subtotal-price, [class*="subtotal"]:not([class*="hidden"]) [class*="price"]');

        if (unitPriceEl) r.unitPrice = unitPriceEl.textContent.trim();
        if (subtotalEl) r.subtotal = subtotalEl.textContent.trim();

        // Also get all visible dollar amounts
        const spans = document.querySelectorAll('span, div, strong');
        const dollars = [];
        for (const el of spans) {
          const text = el.textContent.trim();
          if (/^\$[\d,]+\.\d{2}$/.test(text) && !el.closest('[class*="hidden"]')) {
            dollars.push({ text, class: el.className.slice(0,30) });
          }
        }
        r.allPrices = dollars.slice(0, 6);

        // Get quantity currently selected
        const qtySelect = document.querySelector('select[name*="qty"], select[id*="qty"]');
        if (qtySelect) r.selectedQty = qtySelect.value;

        return r;
      });

      log(`Packola box qty ${qty}: ${JSON.stringify(priceData)}`);
    }

    // Final API call summary
    const boxApiCalls = API_RESPONSES.filter(r => r.url.includes('api-quotes') || r.url.includes('price') || r.url.includes('quote'));
    log(`\nBox API calls captured: ${boxApiCalls.length}`);
    boxApiCalls.forEach(c => log(`  ${c.url}: ${c.body.slice(0, 300)}`));

  } catch (e) {
    log(`ERROR Packola boxes: ${e}`);
  } finally {
    await context.close();
  }
}

async function capturePackolaPouchApi(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  page.on('response', async (resp) => {
    const url = resp.url();
    if ((url.includes('api') || url.includes('quote') || url.includes('price')) &&
        !url.includes('csrf') && !url.includes('manifest') && !url.includes('holiday') &&
        !url.includes('cookie') && !url.includes('search')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text && text.length < 50000) {
            const entry = { url, status: resp.status(), body: text.slice(0, 3000) };
            API_RESPONSES.push(entry);
            log(`POUCH API: ${url} - ${text.slice(0, 200)}`);
          }
        }
      } catch (e) {}
    }
  });

  try {
    log('\n=== Packola Stand-Up Pouches ===');
    await page.goto('https://www.packola.com/products/custom-pouches', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    const pageState = await page.evaluate(() => {
      const r = {};
      r.title = document.title;
      r.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      }));
      r.radioButtons = Array.from(document.querySelectorAll('input[type="radio"]')).map(r => ({
        name: r.name, value: r.value, checked: r.checked,
        label: document.querySelector(`label[for="${r.id}"]`)?.textContent.trim() || ''
      })).slice(0, 20);
      r.sizeButtons = Array.from(document.querySelectorAll('[class*="size"], [data-size], [class*="option"]')).map(el => ({
        text: el.textContent.trim().slice(0,30), class: el.className.slice(0,30)
      })).filter(b => b.text).slice(0, 20);

      // Get visible prices
      const priceEls = [];
      const spans = document.querySelectorAll('span, div, strong');
      for (const el of spans) {
        const text = el.textContent.trim();
        if (/\$[\d,]+\.\d{2}/.test(text) && text.length < 60 && !el.closest('[class*="hidden"]')) {
          priceEls.push({ text: text.slice(0, 50), class: el.className.slice(0, 30) });
        }
      }
      r.prices = priceEls.slice(0, 10);
      return r;
    });

    log(`Pouch state: selects=${JSON.stringify(pageState.selects.map(s => ({id: s.id, options: s.options.map(o => o.t).slice(0, 5)})))}`);
    log(`Prices visible: ${JSON.stringify(pageState.prices)}`);
    log(`Radio buttons: ${JSON.stringify(pageState.radioButtons)}`);

    // Select "Stand-Up" type via radio or button
    try {
      const standup = await page.$('input[value*="stand"], input[value*="Stand"], [data-type="standup"], button:has-text("Stand Up"), label:has-text("Stand Up")');
      if (standup) {
        await standup.click();
        log('Clicked Stand-Up option');
        await page.waitForTimeout(1500);
      }
    } catch (e) {}

    // Select size closest to 4.375"×6"
    // The options from WebFetch were: XS (3.25×4.5), S (3.375×5.5), M (4×6), L (5×7), XL (7×9)
    // Medium (4"×6") is closest to 4.375"×6"×2"
    for (const sel of pageState.selects) {
      const medOpt = sel.options.find(o => o.t.includes('Medium') || o.t.includes('4"') || o.t.includes('4 x 6'));
      if (medOpt) {
        await page.selectOption(`select[name="${sel.name}"], select[id="${sel.id}"]`, medOpt.v);
        log(`Selected medium/4"×6": ${medOpt.t}`);
        await page.waitForTimeout(1000);
        break;
      }
    }

    // Try size buttons
    try {
      await page.click('text=Medium', { timeout: 2000 });
      log('Clicked Medium size');
      await page.waitForTimeout(1000);
    } catch (e) {}

    // Iterate quantities via price tier table clicks
    const qtys = [250, 500, 1000, 2500, 5000];
    for (const qty of qtys) {
      let clicked = false;

      // Try to find a price tier row with this quantity
      const rows = await page.$$('tr, [class*="tier"], [class*="qty-row"]');
      for (const row of rows) {
        try {
          const text = await row.textContent();
          if (text && (text.includes(qty.toLocaleString()) || text.includes(String(qty)))) {
            await row.click();
            clicked = true;
            log(`Clicked tier row for qty ${qty}`);
            break;
          }
        } catch (e) {}
      }

      if (!clicked) {
        // Try select
        try {
          await page.selectOption('select', String(qty), { timeout: 1500 });
          clicked = true;
        } catch (e) {}
      }

      await page.waitForTimeout(1500);

      const priceState = await page.evaluate(() => {
        const unitPriceEl = document.querySelector('.calc-price-per-piece');
        const subtotalEl = document.querySelector('.calc-price.subtotal-price');
        return {
          unitPrice: unitPriceEl?.textContent.trim() || null,
          subtotal: subtotalEl?.textContent.trim() || null
        };
      });

      log(`Packola pouch qty ${qty}: ${JSON.stringify(priceState)}`);
    }

  } catch (e) {
    log(`ERROR Packola pouches: ${e}`);
  } finally {
    await context.close();
  }
}

// Also try to intercept the Packola quote API during a price tier click
async function capturePackolaViaApiProbe(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const priceApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('api-quotes.packola.com') || url.includes('quoterequest.packola.com') || url.includes('ecp-price')) {
      try {
        const text = await resp.text().catch(() => null);
        if (text) {
          priceApiCalls.push({ url, status: resp.status(), body: text.slice(0, 5000) });
          log(`PRICE API: ${url} [${resp.status()}]: ${text.slice(0, 500)}`);
        }
      } catch (e) {}
    }
  });

  // Also intercept requests to see what API calls are being made
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('api-quotes') || url.includes('price') || url.includes('quote-calc')) {
      log(`REQUEST: ${req.method()} ${url}`);
      const body = req.postData();
      if (body) log(`  BODY: ${body.slice(0, 300)}`);
    }
  });

  try {
    log('\n=== Packola API Probe — Box Price Tiers ===');
    await page.goto('https://www.packola.com/products/product-box', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);

    // Find and click all price tier rows to trigger API
    const rows = await page.$$('tr, [class*="tier-row"], [class*="price-row"], [class*="qty-option"]');
    log(`Found ${rows.length} potential tier rows`);

    for (const row of rows.slice(0, 10)) {
      try {
        const text = await row.textContent();
        if (text && /\d{2,5}/.test(text) && text.length < 100) {
          log(`Clicking row: ${text.trim().slice(0,50)}`);
          await row.click();
          await page.waitForTimeout(1000);
        }
      } catch (e) {}
    }

    // Try clicking specific quantity amounts if visible
    const qtys = [250, 500, 1000, 2000, 2500];
    for (const qty of qtys) {
      try {
        const el = await page.$(`[data-qty="${qty}"], [data-quantity="${qty}"]`);
        if (el) {
          await el.click();
          log(`Clicked data-qty=${qty}`);
          await page.waitForTimeout(800);
        }
      } catch (e) {}
    }

    // Click Update/Get Quote button if visible
    try {
      await page.click('button:has-text("Update"), button:has-text("Get Quote"), button:has-text("Calculate"), button[type="submit"]', { timeout: 3000 });
      log('Clicked update/quote button');
      await page.waitForTimeout(2000);
    } catch (e) {}

    log(`\nPrice API calls captured: ${priceApiCalls.length}`);
    priceApiCalls.forEach(c => log(`  ${c.url}: ${c.body}`));

  } catch (e) {
    log(`ERROR API probe: ${e}`);
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await capturePackolaBoxApi(browser);
    await capturePackolaPouchApi(browser);
    await capturePackolaViaApiProbe(browser);
  } finally {
    await browser.close();
  }

  const output = {
    run_date: new Date().toISOString(),
    results: RESULTS,
    api_responses: API_RESPONSES.filter(r => r.url.includes('quote') || r.url.includes('price')).slice(0, 20)
  };

  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-packola-api-2026-04-17.json', JSON.stringify(output, null, 2));
  log('Done.');
})();
