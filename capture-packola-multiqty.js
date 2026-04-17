/**
 * capture-packola-multiqty.js
 * PRI-8: Get Packola STE box pricing at multiple quantities
 * Uses the main product page calculator (not the iframe)
 */

const { chromium } = require('playwright');
const fs = require('fs');

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

const RESULTS = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Track API calls
  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('api-quotes') || url.includes('price-trad') || url.includes('calc-price')) {
      try {
        const text = await resp.text().catch(() => null);
        if (text) { apiCalls.push({ url, body: text.slice(0, 2000) }); log(`API: ${url}: ${text.slice(0, 200)}`); }
      } catch(e) {}
    }
  });

  try {
    log('Loading Packola product box page...');
    await page.goto('https://www.packola.com/products/product-box', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(4000);

    // Inspect the page structure of the price calculator
    const calcState = await page.evaluate(() => {
      const r = {};

      // Get the calc container
      const calc = document.querySelector('[class*="calc"], [class*="calculator"], [class*="price-config"]');
      if (calc) r.calcHtml = calc.outerHTML.slice(0, 3000);

      // Get all elements with qty-related text
      const qtyEls = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (/^(50|100|250|500|1,?000|1000|2,?000|2000|2,?500|2500|5,?000|5000|10,?000|10000)$/.test(text)) {
          qtyEls.push({
            tag: node.tagName,
            text,
            class: node.className.slice(0, 50),
            id: node.id,
            role: node.getAttribute('role') || '',
            onclick: node.getAttribute('onclick') || '',
            'data-qty': node.getAttribute('data-qty') || ''
          });
        }
      }
      r.qtyEls = qtyEls.slice(0, 30);

      // Get all buttons/clickable elements with prices nearby
      r.priceSectionHtml = document.querySelector('[class*="price-section"]')?.outerHTML.slice(0, 3000) || '';

      return r;
    });

    log(`Qty elements found: ${JSON.stringify(calcState.qtyEls)}`);
    log(`Price section: ${calcState.priceSectionHtml.slice(0, 1000)}`);

    // Fill in dimensions L=4, W=2, D=5
    const numberInputs = await page.$$('input[type="number"]');
    log(`Number inputs found: ${numberInputs.length}`);

    if (numberInputs.length >= 3) {
      // Check labels for each input
      for (let i = 0; i < Math.min(numberInputs.length, 5); i++) {
        const attrs = await page.evaluate(el => ({
          name: el.name, id: el.id, value: el.value,
          placeholder: el.placeholder,
          ariaLabel: el.getAttribute('aria-label') || ''
        }), numberInputs[i]);
        log(`Input ${i}: ${JSON.stringify(attrs)}`);
      }

      // Try to figure out order by looking at surrounding labels
      const inputLabels = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="number"]')).map(input => {
          // Find label
          const labelEl = document.querySelector(`label[for="${input.id}"]`);
          const parentText = input.parentElement?.textContent.trim().slice(0, 30) || '';
          return {
            id: input.id, name: input.name, value: input.value,
            label: labelEl?.textContent.trim() || parentText
          };
        });
      });
      log(`Input labels: ${JSON.stringify(inputLabels)}`);

      // Fill by position (first is usually Length/Width/Height)
      await numberInputs[0].click({ clickCount: 3 });
      await numberInputs[0].fill('4');
      await page.waitForTimeout(400);
      await numberInputs[1].click({ clickCount: 3 });
      await numberInputs[1].fill('2');
      await page.waitForTimeout(400);
      await numberInputs[2].click({ clickCount: 3 });
      await numberInputs[2].fill('5');
      await numberInputs[2].press('Tab');
      await page.waitForTimeout(3000);
      log('Filled dimensions 4×2×5, waiting for price update...');

      // Check price after dim fill
      const afterDim = await page.evaluate(() => {
        const unitEl = document.querySelector('.calc-price-per-piece');
        const totalEl = document.querySelector('.calc-price.subtotal-price');
        return {
          unit: unitEl?.textContent.trim(),
          total: totalEl?.textContent.trim()
        };
      });
      log(`After dim 4x2x5: ${JSON.stringify(afterDim)}`);
    }

    // Now try to click different quantity tiers
    // From the HTML we saw: "Quantity: 250  1  10" — these appear to be preset tier buttons
    // Let's find all qty elements and try clicking them

    const qtyEls = calcState.qtyEls;
    log(`Trying to click these qty elements: ${qtyEls.map(e => e.text).join(', ')}`);

    const uniqueQtys = ['250', '500', '1,000', '1000', '2,000', '2000', '2,500', '2500'];

    for (const qtyCandidates of [['250'], ['500'], ['1,000', '1000'], ['2,000', '2000'], ['2,500', '2500']]) {
      let clicked = false;

      for (const qtyText of qtyCandidates) {
        // Try by exact text
        const qtyEl = qtyEls.find(e => e.text === qtyText || e.text === qtyText.replace(',', ''));
        if (qtyEl) {
          try {
            const sel = qtyEl.id ? `#${qtyEl.id}` :
                        qtyEl.class ? `${qtyEl.tag.toLowerCase()}[class*="${qtyEl.class.split(' ')[0]}"]` :
                        `${qtyEl.tag.toLowerCase()}:text("${qtyText}")`;
            await page.click(sel, { timeout: 2000 });
            clicked = true;
            log(`Clicked qty element: ${qtyText} (${qtyEl.tag}.${qtyEl.class})`);
            break;
          } catch (e) {}
        }

        // Try Playwright text selector
        try {
          // Find exact match text elements that are clickable
          await page.click(`text="${qtyText}"`, { timeout: 1500 });
          clicked = true;
          log(`Clicked text="${qtyText}"`);
          break;
        } catch (e) {}

        // Try finding by evaluating
        try {
          const clickResult = await page.evaluate((target) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while (node = walker.nextNode()) {
              if (node.textContent.trim() === target && node.children.length === 0) {
                node.click();
                return { clicked: true, tag: node.tagName, class: node.className };
              }
            }
            return { clicked: false };
          }, qtyText);
          if (clickResult.clicked) {
            clicked = true;
            log(`Clicked ${qtyText} via evaluate: ${JSON.stringify(clickResult)}`);
            break;
          }
        } catch (e) {}
      }

      if (!clicked) log(`Could not click qty: ${qtyCandidates.join('/')}`);

      await page.waitForTimeout(2000);

      // Read price
      const priceState = await page.evaluate(() => {
        const unitEl = document.querySelector('.calc-price-per-piece');
        const totalEl = document.querySelector('.calc-price.subtotal-price');
        const subtotalContainer = document.querySelector('.subtotal-container');
        return {
          unit: unitEl?.textContent.trim(),
          total: totalEl?.textContent.trim(),
          subtotal: subtotalContainer?.textContent.trim()
        };
      });

      log(`Qty ${qtyCandidates[0]}: ${JSON.stringify(priceState)}`);

      if (priceState.total && priceState.unit) {
        const totalPrice = parseFloat(priceState.total.replace(/[$,]/g, ''));
        const unitPrice = parseFloat(priceState.unit.replace(/[$,\s]/g, '').replace(/each/i, ''));
        const qty = parseInt(qtyCandidates[0].replace(',', ''));

        RESULTS.push({
          id: `packola-box-ste-4x2x5-${qty}-pri8`,
          site: 'Packola',
          competitor: 'packola',
          competitor_display: 'Packola',
          product: 'Straight Tuck End Box',
          qty,
          total_price: totalPrice,
          unit_price: unitPrice,
          spec: '4"L×2"W×5"D, 18pt Cardstock, Gloss, STE style',
          confidence: clicked ? 'high' : 'medium',
          method: 'packola_angular_dom_extraction',
          notes: `Unit: ${priceState.unit} Total: ${priceState.total}. qty_click_confirmed: ${clicked}`
        });
      }
    }

    // Also do stand-up pouches on separate page load
    log('\n=== Now loading pouches ===');
    await page.goto('https://www.packola.com/products/custom-pouches', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(4000);

    const pouchState = await page.evaluate(() => {
      const unitEl = document.querySelector('.calc-price-per-piece');
      const totalEl = document.querySelector('.calc-price.subtotal-price');

      // Get qty elements
      const qtyEls = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (/^(100|250|500|1,?000|2,?500|5,?000)$/.test(text) && node.children.length === 0) {
          qtyEls.push({ tag: node.tagName, text, class: node.className.slice(0, 50), id: node.id });
        }
      }

      // Get selects for type/size
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name, id: s.id,
        options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })).slice(0, 15)
      }));

      return {
        defaultUnit: unitEl?.textContent.trim(),
        defaultTotal: totalEl?.textContent.trim(),
        qtyEls: qtyEls.slice(0, 20),
        selects
      };
    });

    log(`Pouch default: unit=${pouchState.defaultUnit}, total=${pouchState.defaultTotal}`);
    log(`Pouch qty elements: ${JSON.stringify(pouchState.qtyEls)}`);
    log(`Pouch selects: ${JSON.stringify(pouchState.selects)}`);

    // Click Stand-Up type
    try {
      await page.click('text=Stand Up', { timeout: 3000 });
      log('Selected Stand Up pouch type');
      await page.waitForTimeout(2000);
    } catch (e) { log(`No Stand Up button: ${e}`); }

    // Select Medium size (closest to 4.375"×6")
    for (const sel of pouchState.selects) {
      const medOpt = sel.options?.find(o =>
        o.t.toLowerCase().includes('medium') || o.t.includes('4 x 6') || o.t.includes('4"×6"') || o.t.includes('4" x 6"')
      );
      if (medOpt) {
        try {
          await page.selectOption(`select[id="${sel.id}"], select[name="${sel.name}"]`, medOpt.v);
          log(`Selected size: ${medOpt.t}`);
          await page.waitForTimeout(1000);
        } catch(e) {}
      }
    }

    // Capture pouch prices at different qtys
    const pouchQtys = ['250', '500', '1,000', '2,500', '5,000'];
    for (const qtyText of pouchQtys) {
      const qty = parseInt(qtyText.replace(',', ''));

      // Try to click qty tier
      let clicked = false;
      const qtyEl = pouchState.qtyEls.find(e => e.text === qtyText || e.text === String(qty));
      if (qtyEl) {
        try {
          if (qtyEl.id) await page.click(`#${qtyEl.id}`, { timeout: 2000 });
          else await page.click(`text="${qtyText}"`, { timeout: 2000 });
          clicked = true;
          log(`Clicked pouch qty: ${qtyText}`);
        } catch(e) {}
      }

      if (!clicked) {
        try {
          const r = await page.evaluate((t) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let n;
            while (n = walker.nextNode()) {
              if (n.textContent.trim() === t && n.children.length === 0) { n.click(); return true; }
            }
            return false;
          }, qtyText);
          if (r) { clicked = true; log(`Eval-clicked pouch qty ${qtyText}`); }
        } catch(e) {}
      }

      await page.waitForTimeout(1500);

      const priceState = await page.evaluate(() => ({
        unit: document.querySelector('.calc-price-per-piece')?.textContent.trim(),
        total: document.querySelector('.calc-price.subtotal-price')?.textContent.trim()
      }));

      log(`Pouch qty ${qtyText}: ${JSON.stringify(priceState)}`);

      if (priceState.total) {
        const totalPrice = parseFloat(priceState.total.replace(/[$,]/g, ''));
        const unitPrice = priceState.unit ? parseFloat(priceState.unit.replace(/[$,\s]/g, '').replace(/each/i, '')) : null;

        RESULTS.push({
          id: `packola-pouch-sup-${qty}-pri8`,
          site: 'Packola',
          competitor: 'packola',
          competitor_display: 'Packola',
          product: 'Stand-Up Pouch',
          qty,
          total_price: totalPrice,
          unit_price: unitPrice,
          spec: 'Stand-Up, ~Medium (4"×6") size, closest to 4.375"×6"×2"',
          confidence: clicked ? 'high' : 'medium',
          method: 'packola_angular_dom',
          notes: `Unit: ${priceState.unit} Total: ${priceState.total}. qty_confirmed: ${clicked}`
        });
      }
    }

  } catch (e) {
    log(`FATAL: ${e}`);
  } finally {
    await browser.close();
  }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));

  fs.writeFileSync(
    '/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-packola-multiqty-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2)
  );
  log('Done.');
}

run().catch(e => { log(`Unhandled: ${e}`); process.exit(1); });
