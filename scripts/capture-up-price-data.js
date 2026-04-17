#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.resolve(__dirname, '..');
function log(msg) { console.log(`[up-pd] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  // Intercept the UPrinting AJAX pricing call
  const pricingCalls = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('uprinting.com') && (u.includes('price') || u.includes('calc') || u.includes('issue') || u.includes('muffins'))) {
      try {
        const body = await resp.text();
        if (!body.startsWith('\xff\xd8') && body.length > 10) { // not a JPEG
          pricingCalls.push({ url: u, status: resp.status(), body: body.slice(0, 3000) });
        }
      } catch(_) {}
    }
  });

  const page = await context.newPage();

  try {
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(7000);

    // Get the full priceData from Angular scope
    const priceData = await page.evaluate(() => {
      try {
        const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc"]');
        const scope = angular?.element(calcEl)?.scope?.();
        if (!scope) return { error: 'no scope' };

        // Get the price_data which has the full pricing matrix
        const pd = scope.priceData;
        return {
          // Full priceData
          fullPriceData: JSON.stringify(pd),
          // Key fields
          qty: pd?.qty,
          totalPrice: pd?.total_price,
          price: pd?.price,
          unitPrice: pd?.unit_price,
          width: pd?.width,
          height: pd?.height,
          turnaround: pd?.turnaround,
          // The price_data field specifically
          priceDataField: pd?.price_data ? JSON.stringify(pd.price_data).slice(0, 5000) : null
        };
      } catch(e) { return { error: e.message }; }
    });

    log('UP priceData: qty=' + priceData.qty + ', price=' + priceData.price + ', unitPrice=' + priceData.unitPrice);
    log('UP priceData.price_data: ' + (priceData.priceDataField ? priceData.priceDataField.slice(0, 500) : 'not found'));

    // Now try to click on the "5,000" row in the price table
    // The price-wrap shows a grid with quantities. Try to find and click the 5,000 cell.
    const clickResult = await page.evaluate(() => {
      // Find all text nodes/elements containing "5,000"
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() === '5,000') {
          const el = node.parentElement;
          if (el) {
            el.click();
            return { clicked: true, tag: el.tagName, class: el.className, id: el.id, href: el.href };
          }
        }
      }

      // Try querySelectorAll approach
      const allEls = Array.from(document.querySelectorAll('a, td, span, div, li'));
      const el5k = allEls.find(el => el.textContent?.trim() === '5,000');
      if (el5k) {
        el5k.click();
        return { clicked: true, tag: el5k.tagName, class: el5k.className };
      }

      return { clicked: false };
    });

    log('UP click 5,000: ' + JSON.stringify(clickResult));
    await sleep(5000);

    // Re-read price after click
    const postClickPrice = await page.evaluate(() => {
      try {
        const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc"]');
        const scope = angular?.element(calcEl)?.scope?.();
        const pd = scope?.priceData;
        return {
          qty: pd?.qty,
          price: pd?.price,
          unitPrice: pd?.unit_price,
          totalPrice: pd?.total_price,
          turnaround: pd?.turnaround
        };
      } catch(e) { return { error: e.message }; }
    });
    log('UP price after 5000 click: ' + JSON.stringify(postClickPrice));

    // Get all price links/buttons for each quantity
    const qtyPriceTable = await page.evaluate(() => {
      const rows = [];
      // Look for quantity rows in the price table
      const priceTableEls = Array.from(document.querySelectorAll('[id*="price-wrap"] a, [id*="price"] a, .price-row, [class*="qty-row"], table tr'));
      priceTableEls.forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.match(/[\d,]+/) && text.length < 50) {
          rows.push({ tag: el.tagName, text, href: el.href });
        }
      });

      // Also try to find ALL anchor tags in the price area
      const priceWrap = document.getElementById('price-wrap') || document.getElementById('price');
      if (priceWrap) {
        const links = Array.from(priceWrap.querySelectorAll('a, [onclick], [data-qty]'));
        return links.map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 30),
          href: el.href,
          onclick: el.getAttribute('onclick')?.slice(0, 100),
          dataQty: el.getAttribute('data-qty')
        })).filter(el => el.text);
      }

      return rows;
    });
    log('UP qty price table elements: ' + JSON.stringify(qtyPriceTable).slice(0, 1000));

    // Try using the Angular scope to change qty
    const angularQtyChange = await page.evaluate(() => {
      try {
        const calcEl = document.querySelector('#calc_33_grid') || document.querySelector('[id*="calc"]');
        const scope = angular?.element(calcEl)?.scope?.();
        if (!scope) return { error: 'no scope' };

        // Try to find and call price update function
        const rootScope = scope.$root || scope;
        const fnKeys = Object.keys(scope).filter(k => typeof scope[k] === 'function' && !k.startsWith('$'));
        return {
          functions: fnKeys.slice(0, 20),
          selectedSpecs: JSON.stringify(scope.selectedSpecs || {}).slice(0, 300),
          currentConfig: JSON.stringify(Object.fromEntries(
            Object.entries(scope).filter(([k,v]) => !k.startsWith('$') && typeof v !== 'function' && typeof v !== 'object').slice(0, 20)
          )).slice(0, 500)
        };
      } catch(e) { return { error: e.message }; }
    });
    log('UP Angular functions: ' + JSON.stringify(angularQtyChange).slice(0, 500));

    // Check captured API calls
    log(`UP: ${pricingCalls.length} pricing API calls captured`);
    pricingCalls.forEach(c => {
      log(`  ${c.status} ${c.url}`);
      if (c.body && c.body.length > 5) log(`  body: ${c.body.slice(0, 300)}`);
    });

    // Save everything
    const output = {
      initialPriceData: priceData,
      clickResult,
      postClickPrice,
      qtyPriceTable,
      angularScope: angularQtyChange,
      pricingAPICalls: pricingCalls
    };

    const logFile = path.join(ROOT_DIR, 'data', `capture-up-pd-${nowISO()}.json`);
    fs.writeFileSync(logFile, JSON.stringify(output, null, 2));
    log('Saved to: ' + logFile);

    log('');
    log('=== SUMMARY ===');
    log('Initial: qty=' + priceData.qty + ' price=$' + priceData.price + ' unit=$' + priceData.unitPrice + '/each');
    log('After 5k click: ' + JSON.stringify(postClickPrice));

  } finally {
    await context.close();
    await browser.close();
  }
}
main().catch(e => { console.error('Fatal: ' + e.message); process.exit(1); });
