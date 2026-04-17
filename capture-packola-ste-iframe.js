/**
 * capture-packola-ste-iframe.js
 * PRI-8: Load Packola's quote calculator iframe directly for STE boxes
 * Product IDs:
 *   37422 = Straight Tuck End Boxes
 *   26375 = Stand-Up Pouches
 */

const { chromium } = require('playwright');
const fs = require('fs');

const RESULTS = [];

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function capturePackolaSTE(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Capture quote API calls
  const quoteApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('api-quotes') || url.includes('ecp-price') || url.includes('/quote') || url.includes('/price')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text && text.length < 20000) {
            quoteApiCalls.push({ url, status: resp.status(), body: text });
            log(`QUOTE API [${resp.status()}]: ${url}`);
            log(`  body: ${text.slice(0, 500)}`);
          }
        }
      } catch (e) {}
    }
  });

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('api-quotes') || url.includes('ecp-price') || (url.includes('quote') && !url.includes('request'))) {
      log(`REQUEST: ${req.method()} ${url}`);
      const body = req.postData();
      if (body) log(`  POST: ${body.slice(0, 300)}`);
    }
  });

  try {
    // Load the STE box quote calculator iframe directly
    const url = 'https://quoterequest.packola.com/quote-calc.html?product_id=37422';
    log(`Loading STE box quote calc: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Get page state
    const state = await page.evaluate(() => {
      const r = {};
      r.title = document.title;
      r.h1 = document.querySelector('h1')?.textContent.trim() || '';
      r.formFields = Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
        tag: el.tagName, name: el.name, id: el.id, type: el.getAttribute('type'),
        value: el.value, placeholder: el.placeholder || '',
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 15) : undefined
      })).filter(el => el.name || el.id || el.placeholder);
      r.prices = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = el.textContent.trim();
        return /^\$[\d,]+\.\d{2}$/.test(text);
      }).map(el => ({ text: el.textContent.trim(), class: el.className.slice(0, 30) })).slice(0, 10);
      r.text = document.body.textContent.slice(0, 2000);
      return r;
    });

    log(`STE form: ${JSON.stringify(state.formFields)}`);
    log(`STE prices: ${JSON.stringify(state.prices)}`);
    log(`STE text: ${state.text.slice(0, 500)}`);

    // Try to fill in dimensions
    // Look for inputs by name/id/placeholder
    const inputs = state.formFields.filter(f => f.tag === 'INPUT');
    log(`Inputs: ${JSON.stringify(inputs)}`);

    // Try filling dimension fields
    const dimFields = ['length', 'width', 'depth', 'height', 'l', 'w', 'd', 'h'];
    for (const fname of dimFields) {
      try {
        const sel = `input[name="${fname}"], input[id="${fname}"], input[placeholder*="${fname}" i]`;
        const el = await page.$(sel);
        if (el) {
          const dimMap = { length: '4', l: '4', width: '2', w: '2', depth: '5', d: '5', height: '5', h: '5' };
          const val = dimMap[fname.toLowerCase()] || '4';
          await el.click({ clickCount: 3 });
          await el.fill(val);
          log(`Filled ${fname} = ${val}`);
        }
      } catch (e) {}
    }

    // Try filling by index - 3 number inputs = L, W, D
    const numberInputs = await page.$$('input[type="number"], input[class*="dim"], input[class*="length"], input[class*="width"]');
    log(`Found ${numberInputs.length} number inputs`);
    if (numberInputs.length >= 3) {
      await numberInputs[0].click({ clickCount: 3 }); await numberInputs[0].fill('4'); await page.waitForTimeout(200);
      await numberInputs[1].click({ clickCount: 3 }); await numberInputs[1].fill('2'); await page.waitForTimeout(200);
      await numberInputs[2].click({ clickCount: 3 }); await numberInputs[2].fill('5'); await page.waitForTimeout(200);
      await numberInputs[2].press('Tab');
      log('Filled L=4, W=2, D=5');
      await page.waitForTimeout(2000);
    }

    // Try to set paper type to 18pt and coating to Gloss
    const selects = state.formFields.filter(f => f.tag === 'SELECT' && f.options);
    for (const sel of selects) {
      const pt18 = sel.options?.find(o => o.t.includes('18') || o.t.includes('18pt'));
      if (pt18) {
        await page.selectOption(`select[name="${sel.name}"], select[id="${sel.id}"]`, pt18.v);
        log(`Set 18pt: ${pt18.t}`);
        await page.waitForTimeout(500);
      }
      const gloss = sel.options?.find(o => o.t.toLowerCase().includes('gloss') && !o.t.toLowerCase().includes('soft') && !o.t.toLowerCase().includes('uv'));
      if (gloss && sel.name?.toLowerCase().includes('coat')) {
        await page.selectOption(`select[name="${sel.name}"], select[id="${sel.id}"]`, gloss.v);
        log(`Set gloss: ${gloss.t}`);
        await page.waitForTimeout(500);
      }
    }

    // Get current prices
    await page.waitForTimeout(2000);
    const afterDim = await page.evaluate(() => {
      const prices = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = el.textContent.trim();
        return /\$[\d,]+\.\d{2}/.test(text) && text.length < 80;
      }).map(el => ({ text: el.textContent.trim().slice(0, 60), class: el.className.slice(0, 30) })).slice(0, 15);
      return { prices };
    });
    log(`After dim fill prices: ${JSON.stringify(afterDim.prices)}`);

    // Now iterate through quantities
    const qtysToCapture = [250, 500, 1000, 2000, 2500];

    for (const qty of qtysToCapture) {
      log(`\nTrying qty ${qty}...`);

      // Method 1: select option
      try {
        await page.selectOption('select[name*="qty"], select[id*="qty"], select[name*="quantity"], select[id*="quantity"]', String(qty), { timeout: 2000 });
        log(`Set qty ${qty} via select`);
      } catch (e) {
        // Method 2: click price tier row
        try {
          const tiers = await page.$$('[class*="tier"], [class*="price-row"], tr, li');
          for (const tier of tiers) {
            const text = await tier.textContent();
            if (text && (text.includes(qty.toLocaleString()) || text.trim() === String(qty))) {
              await tier.click();
              log(`Clicked tier for qty ${qty}`);
              break;
            }
          }
        } catch (e2) {}

        // Method 3: type in qty input
        try {
          const qtyInput = await page.$('input[name*="qty"], input[id*="qty"], input[name*="quantity"]');
          if (qtyInput) {
            await qtyInput.click({ clickCount: 3 });
            await qtyInput.fill(String(qty));
            await qtyInput.press('Tab');
            log(`Typed qty ${qty}`);
          }
        } catch (e3) {}
      }

      await page.waitForTimeout(2000);

      // Read price
      const priceState = await page.evaluate((targetQty) => {
        // Look for unit price and total
        const allText = document.body.textContent;
        const dollarMatches = allText.match(/\$[\d,]+\.\d{2}/g) || [];

        // Look for specific price elements
        const els = document.querySelectorAll('[class*="price"], [class*="total"], [class*="subtotal"], [class*="unit"]');
        const priceEls = Array.from(els).map(el => ({
          class: el.className.slice(0, 40),
          text: el.textContent.trim().slice(0, 80)
        })).filter(e => /\$/.test(e.text));

        return {
          priceEls: priceEls.slice(0, 8),
          dollarAmounts: dollarMatches.slice(0, 10)
        };
      }, qty);

      log(`qty ${qty} price state: ${JSON.stringify(priceState)}`);

      // Try to record result if we got a price
      if (priceState.dollarAmounts.length > 0) {
        const firstAmount = parseFloat(priceState.dollarAmounts[0].replace(/[$,]/g, ''));
        if (firstAmount > 0) {
          RESULTS.push({
            id: `packola-box-ste-${qty}-pri8`,
            site: 'Packola',
            product: 'Straight Tuck End Box',
            spec: '4"L×2"W×5"D, 18pt Cardstock, Gloss',
            qty,
            price_text: priceState.dollarAmounts.join(', '),
            first_amount: firstAmount,
            confidence: 'medium',
            notes: 'Via Packola quoterequest.packola.com iframe'
          });
        }
      }
    }

    // Print API call summary
    log(`\nTotal quote API calls: ${quoteApiCalls.length}`);
    quoteApiCalls.forEach(c => log(`  ${c.url}: ${c.body.slice(0, 400)}`));

  } catch (e) {
    log(`ERROR: ${e}`);
  } finally {
    await context.close();
  }
}

async function capturePackolaPouchIframe(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const quoteApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('api-quotes') || url.includes('ecp-price') || (url.includes('quote') && url.includes('packola'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await resp.text().catch(() => null);
          if (text && text.length < 20000) {
            quoteApiCalls.push({ url, status: resp.status(), body: text });
            log(`POUCH API: ${url} - ${text.slice(0, 300)}`);
          }
        }
      } catch (e) {}
    }
  });

  try {
    // Stand-Up Pouches product_id=26375
    const url = 'https://quoterequest.packola.com/quote-calc.html?product_id=26375';
    log(`\nLoading Stand-Up Pouches quote calc: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => {
      const r = {};
      r.title = document.title;
      r.text = document.body.textContent.slice(0, 2000);
      r.selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id, value: s.value,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 20)
      }));
      r.inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]')).map(i => ({
        name: i.name, id: i.id, value: i.value, placeholder: i.placeholder
      }));
      r.prices = Array.from(document.querySelectorAll('*')).filter(el => {
        return /\$[\d,]+\.\d{2}/.test(el.textContent.trim());
      }).map(el => ({ text: el.textContent.trim().slice(0,60), class: el.className.slice(0,30) })).slice(0, 10);
      return r;
    });

    log(`Pouch page text: ${state.text.slice(0, 500)}`);
    log(`Pouch selects: ${JSON.stringify(state.selects)}`);
    log(`Pouch prices: ${JSON.stringify(state.prices)}`);

    // Select size closest to 4.375"×6"×2" gusset
    for (const sel of state.selects) {
      // Look for size options
      const sizeOpt = sel.options?.find(o =>
        o.t.includes('4.375') || o.t.includes('4 3/8') ||
        o.t.includes('4.4') || (o.t.includes('4') && o.t.includes('6'))
      );
      if (sizeOpt) {
        await page.selectOption(`select[name="${sel.name}"], select[id="${sel.id}"]`, sizeOpt.v);
        log(`Set pouch size: ${sizeOpt.t}`);
        await page.waitForTimeout(1000);
      }
    }

    // Iterate quantities
    const qtys = [100, 250, 500, 1000, 2500, 5000];
    for (const qty of qtys) {
      try {
        await page.selectOption('select[name*="qty"], select[id*="qty"]', String(qty), { timeout: 2000 });
      } catch (e) {
        try {
          const qtyInput = await page.$('input[name*="qty"], input[id*="qty"]');
          if (qtyInput) { await qtyInput.fill(String(qty)); await qtyInput.press('Tab'); }
        } catch (e2) {}
      }
      await page.waitForTimeout(1500);

      const priceState = await page.evaluate(() => {
        const allDollars = (document.body.textContent.match(/\$[\d,]+\.\d{2}/g) || []).slice(0, 8);
        const priceEls = Array.from(document.querySelectorAll('[class*="price"], [class*="subtotal"], [class*="total"]'))
          .map(el => ({ class: el.className.slice(0,30), text: el.textContent.trim().slice(0,60) }))
          .filter(e => /\$/.test(e.text));
        return { dollars: allDollars, priceEls: priceEls.slice(0, 5) };
      });

      log(`Pouch qty ${qty}: ${JSON.stringify(priceState)}`);

      if (priceState.dollars.length > 0) {
        RESULTS.push({
          id: `packola-pouch-sup-${qty}-pri8`,
          site: 'Packola',
          product: 'Stand-Up Pouch',
          qty,
          price_text: priceState.dollars.join(', '),
          confidence: 'medium'
        });
      }
    }

    log(`Pouch API calls: ${quoteApiCalls.length}`);
    quoteApiCalls.forEach(c => log(`  ${c.url}: ${c.body.slice(0, 300)}`));

  } catch (e) {
    log(`ERROR pouches: ${e}`);
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await capturePackolaSTE(browser);
    await capturePackolaPouchIframe(browser);
  } finally {
    await browser.close();
  }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));

  fs.writeFileSync(
    '/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-packola-ste-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2)
  );
})();
