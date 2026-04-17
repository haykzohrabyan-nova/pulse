#!/usr/bin/env node
/**
 * capture-gp-breakthrough.js
 * PRI-7 — GotPrint: shape(4=Square-Rounded) → size(452=3x3) → paper(12=White BOPP) → finish → qty → price
 * Material and finish selects are NOW ENABLED after shape+size selection!
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SS = path.join(ROOT_DIR, 'data', 'screenshots');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-gp-breakthrough-${nowISO()}.json`);

function log(msg) { console.log(`[gp] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GP_BASE = 'https://www.gotprint.com';

async function captureGotPrint(context) {
  const page = await context.newPage();
  const result = { prices: [], selects: [], apiCalls: [], error: null };
  const apiCalls = [];

  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com/service')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        const body = ct.includes('json') ? await resp.json().catch(() => null) : null;
        apiCalls.push({ url: u.replace(GP_BASE, ''), status: resp.status(), body });
        if (resp.status() === 200 && (u.includes('price') || u.includes('cart') || u.includes('checkout'))) {
          log('PRICING CALL: ' + u.replace(GP_BASE, '') + ' | ' + JSON.stringify(body || {}).slice(0, 200));
        }
      } catch(_) {}
    }
  });

  try {
    await page.goto(GP_BASE + '/products/roll-labels/order', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    log('Loaded: ' + page.url());
    await page.screenshot({ path: path.join(SS, 'gpb-01-loaded.png') });

    // Step 1: Shape = Square-Rounded (v=4)
    await page.selectOption('#shape', '4');
    log('Shape: Square-Rounded');
    await sleep(2000);
    await page.screenshot({ path: path.join(SS, 'gpb-02-shape.png') });

    // Step 2: Size = 3"×3" (v=452)
    const sizeOpts = await page.evaluate(() => {
      const sel = document.getElementById('size');
      return sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.text })) : [];
    });
    log('Size options: ' + sizeOpts.map(o => o.v + '=' + o.t).join(', '));

    const size3x3 = sizeOpts.find(o => o.t.includes('3" x 3"') || o.v === '452');
    if (size3x3) {
      await page.selectOption('#size', size3x3.v);
      log('Size: 3" x 3" (v=' + size3x3.v + ')');
      await sleep(2000);
    } else {
      log('3x3 not found in options: ' + JSON.stringify(sizeOpts));
    }
    await page.screenshot({ path: path.join(SS, 'gpb-03-size.png') });

    // Step 3: Dump ALL form elements to understand the full form
    const allFormElements = await page.evaluate(() => {
      const elements = [];

      // Selects
      Array.from(document.querySelectorAll('select')).forEach(s => {
        elements.push({
          type: 'select',
          id: s.id, name: s.name,
          disabled: s.disabled,
          value: s.value,
          opts: Array.from(s.options).map(o => ({ v: o.value, t: o.text })).filter(o => o.v)
        });
      });

      // All visible inputs
      Array.from(document.querySelectorAll('input')).filter(i => i.offsetWidth || i.offsetHeight).forEach(i => {
        elements.push({
          type: 'input',
          id: i.id, name: i.name,
          inputType: i.type,
          disabled: i.disabled,
          value: i.value,
          placeholder: i.placeholder
        });
      });

      // Hidden inputs that might be qty
      Array.from(document.querySelectorAll('input[type="hidden"]')).filter(i => /qty|quantity/i.test(i.name + i.id)).forEach(i => {
        elements.push({ type: 'hidden', id: i.id, name: i.name, value: i.value });
      });

      return elements;
    });
    log('Form elements: ' + JSON.stringify(allFormElements).slice(0, 1500));
    result.allFormElements = allFormElements;

    // Step 4: Select paper = White BOPP (v=12)
    const paperSel = allFormElements.find(e => e.id === 'paper' || e.opts?.some(o => /bopp/i.test(o.t)));
    log('Paper select: ' + JSON.stringify(paperSel)?.slice(0, 200));

    if (paperSel && !paperSel.disabled) {
      await page.selectOption('#paper', '12'); // White BOPP
      log('Paper: White BOPP Label (v=12)');
      await sleep(2000);
    }
    await page.screenshot({ path: path.join(SS, 'gpb-04-paper.png') });

    // Step 5: Select finish = Matte (v=3)
    const finishSel = allFormElements.find(e => e.id === 'finish' || e.opts?.some(o => /matte/i.test(o.t)));
    log('Finish select: ' + JSON.stringify(finishSel)?.slice(0, 200));

    if (finishSel && !finishSel.disabled) {
      // Get Matte option value
      const finishOpts = await page.evaluate(() => {
        const sel = document.getElementById('finish');
        return sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.text })) : [];
      });
      const matteOpt = finishOpts.find(o => /matte/i.test(o.t) && !/outdoor/i.test(o.t));
      if (matteOpt) {
        await page.selectOption('#finish', matteOpt.v);
        log('Finish: ' + matteOpt.t + ' (v=' + matteOpt.v + ')');
        await sleep(2000);
      }
      log('Finish options: ' + JSON.stringify(finishOpts));
    }
    await page.screenshot({ path: path.join(SS, 'gpb-05-finish.png') });

    // Step 6: Find qty input/select after paper+finish selection
    const formAfterFinish = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select, input')).map(el => ({
        tag: el.tagName,
        type: el.tagName === 'INPUT' ? el.type : 'select',
        id: el.id, name: el.name,
        visible: !!(el.offsetWidth || el.offsetHeight),
        disabled: el.disabled,
        value: el.value,
        placeholder: el.placeholder,
        opts: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({ v: o.value, t: o.text })).slice(0, 10) : []
      })).filter(e => e.visible || /qty|quantity/i.test(e.name + e.id));
    });
    log('Form after finish: ' + JSON.stringify(formAfterFinish).slice(0, 1200));
    result.formAfterFinish = formAfterFinish;

    // Find qty
    const qtyEl = formAfterFinish.find(e =>
      /qty|quantity/i.test(e.id + e.name + e.placeholder) ||
      (e.type === 'select' && e.opts.some(o => /^\d{3,5}$/.test(o.t)))
    );
    log('Qty element: ' + JSON.stringify(qtyEl));

    // Set qty for 5000 and 1000
    const qtysToTest = [5000, 1000];
    for (const qty of qtysToTest) {
      if (qtyEl?.type === 'select') {
        const opt = qtyEl.opts.find(o => parseInt(o.t.replace(/,/g,'')) === qty);
        if (opt) {
          await page.selectOption('#' + qtyEl.id, opt.v);
          log(`Qty set to ${qty} via select`);
        }
      } else if (qtyEl?.type === 'number' || qtyEl?.type === 'text') {
        // Use Vue-compatible input event
        await page.evaluate(({ id, val }) => {
          const el = document.getElementById(id) || document.querySelector('input[name="' + id + '"]');
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }, { id: qtyEl.id || qtyEl.name, val: qty.toString() });
        log(`Qty set to ${qty} via input`);
      } else {
        // Try clicking a qty input by text/placeholder
        const qtyInput = await page.$('input[placeholder*="qty" i], input[placeholder*="quantity" i], input[name*="qty" i], #qty, #quantity');
        if (qtyInput) {
          await qtyInput.fill(qty.toString());
          await qtyInput.press('Tab');
          log(`Qty set to ${qty} via fill`);
        } else {
          log('No qty element found for ' + qty);
        }
      }

      await sleep(3000);
      await page.screenshot({ path: path.join(SS, `gpb-06-qty${qty}.png`) });

      // Read price
      const priceResult = await page.evaluate(() => {
        // All text with $ sign
        const priceTexts = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while (node = walker.nextNode()) {
          const t = node.textContent.trim();
          if (/\$[\d,]+\.\d{2}/.test(t) || /total.*\$\d/i.test(t)) {
            priceTexts.push({ text: t, parentCls: node.parentElement?.className?.slice(0, 60) });
          }
        }

        // Also check specific price containers
        const priceEls = Array.from(document.querySelectorAll(
          '[class*="price"], [id*="price"], .total, #total, [class*="total"], [class*="amount"]'
        )).map(el => ({ cls: el.className.slice(0, 60), text: el.textContent.trim().slice(0, 50) }))
          .filter(e => /\$/.test(e.text));

        return { priceTexts, priceEls };
      });

      log(`Price at qty=${qty}: ` + JSON.stringify(priceResult));

      // Check pricing API calls
      const newPricingCalls = apiCalls.filter(c =>
        c.url.includes('price') || c.url.includes('checkout') || c.url.includes('total')
      );
      log(`Pricing API calls at qty=${qty}: ` + newPricingCalls.length);
      newPricingCalls.slice(-3).forEach(c => log('  ' + c.status + ' ' + c.url + ' | ' + JSON.stringify(c.body || {}).slice(0, 200)));

      result.prices.push({
        qty,
        priceResult,
        pricingApiCalls: newPricingCalls.map(c => ({ url: c.url, status: c.status, body: JSON.stringify(c.body || {}).slice(0, 300) }))
      });
    }

    // Try direct cart API call with session cookies
    // The session is established from page visit — try /service/rest/v1/users/self/cart/checkout/prices
    const cartPriceResp = await page.evaluate(async () => {
      try {
        const r = await fetch('/service/rest/v1/users/self/cart/checkout/prices', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        const body = await r.text();
        return { status: r.status, body: body.slice(0, 500) };
      } catch(e) { return { error: e.message }; }
    });
    log('Cart checkout prices API: ' + JSON.stringify(cartPriceResp));
    result.cartPriceApi = cartPriceResp;

    // Try the product price API with the spec IDs we know
    const directPriceResp = await page.evaluate(async () => {
      try {
        // Based on specifications endpoint: paper IDs, shape IDs, etc.
        const r = await fetch('/service/rest/v1/products/roll-labels/price?shapeId=4&sizeId=452&paperId=12&finishId=3&qty=5000', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        const body = await r.text();
        return { status: r.status, body: body.slice(0, 500) };
      } catch(e) { return { error: e.message }; }
    });
    log('Direct product price API: ' + JSON.stringify(directPriceResp));
    result.directPriceApi = directPriceResp;

    // All captured API calls
    result.apiCalls = apiCalls.map(c => ({
      url: c.url,
      status: c.status,
      bodyPreview: JSON.stringify(c.body || {}).slice(0, 200)
    }));

  } catch(e) {
    err('GotPrint: ' + e.message);
    result.error = e.message;
  } finally {
    await page.close();
  }

  return result;
}

async function main() {
  log('=== GotPrint Breakthrough === ' + nowISO());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const output = { run_date: new Date().toISOString(), results: {} };

  try {
    output.results.gotprint = await captureGotPrint(context);

    log('\n=== SUMMARY ===');
    const prices = output.results.gotprint.prices || [];
    prices.forEach(p => log(`qty=${p.qty}: ` + JSON.stringify(p.priceResult?.priceEls || [])));
  } finally {
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('Output: ' + OUT_FILE);
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
