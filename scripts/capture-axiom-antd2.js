#!/usr/bin/env node
/**
 * capture-axiom-antd2.js — Fixed version
 * Interact with Ant Design selects on Axiom print configurator
 * Structures: Antd Select (size, qty) + CustomHorizontalSelect (shape, material, corner)
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SS = path.join(ROOT_DIR, 'data', 'screenshots');
const OUT = path.join(ROOT_DIR, 'data', `capture-axiom-antd2-${nowISO()}.json`);

function log(msg) { console.log(`[ax2] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Select an Ant Design option by clicking the trigger then the option
async function antdSelect(page, currentVal, targetVal) {
  // Click the ant-select that currently shows currentVal
  const opened = await page.evaluate(({ current }) => {
    const items = Array.from(document.querySelectorAll('.ant-select-selection-item'));
    const item = items.find(el => el.textContent.trim() === current);
    if (!item) return false;
    const selector = item.closest('.ant-select');
    if (!selector || selector.classList.contains('ant-select-disabled')) return false;
    selector.click();
    return true;
  }, { current: currentVal });

  if (!opened) { log('Could not open Antd for: ' + currentVal); return false; }
  await sleep(400);

  // Click the target option in the open dropdown
  const selected = await page.evaluate(({ target }) => {
    const dd = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    if (!dd) return null;
    const opts = Array.from(dd.querySelectorAll('.ant-select-item-option'));
    const opt = opts.find(o => o.textContent.trim() === target || o.textContent.trim().includes(target));
    if (!opt) return 'options: ' + opts.map(o => o.textContent.trim()).join(', ');
    opt.click();
    return opt.textContent.trim();
  }, { target: targetVal });

  log(`  Antd ${currentVal} → ${selected}`);
  await sleep(2000);
  return !!selected && selected !== 'options:';
}

async function readPrice(page) {
  return page.evaluate(() => {
    const fp = document.querySelector('[class*="finalPrice"]');
    const sp = document.querySelector('[class*="subHeadingText"]:last-child');
    return {
      total: fp?.textContent?.trim() || null,
      unit: sp?.textContent?.trim() || null
    };
  });
}

async function getCurrentAntdValues(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.ant-select-selection-item'))
      .map(el => el.textContent.trim());
  });
}

async function main() {
  log('=== Axiom Antd2 === ' + nowISO());

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const results = { prices: [], allPriceTableVisible: null, error: null };

  try {
    await page.goto('https://www.axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);

    // Read all visible prices on page (might be a quantity pricing table)
    const allVisible = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^\$[\d,]+\.\d{2}$/.test(el.textContent.trim()))
        .map(el => ({
          price: el.textContent.trim(),
          cls: el.className.slice(0, 60),
          parentCls: el.parentElement?.className?.slice(0, 60),
          nearQty: el.closest('[class]')?.textContent?.trim()?.slice(0, 80)
        }));
    });
    log('All visible dollar amounts: ' + JSON.stringify(allVisible));
    results.allPriceTableVisible = allVisible;

    // Get current selection state
    const currentVals = await getCurrentAntdValues(page);
    log('Current Antd values: ' + JSON.stringify(currentVals));

    const initialPrice = await readPrice(page);
    log('Initial (2x3 / 250): ' + JSON.stringify(initialPrice));
    results.prices.push({ size: '2x3', qty: 250, price: initialPrice.total, unit: initialPrice.unit });

    // ─── Capture 2"×3" price at different quantities ──────────────────────────
    const qtysFor2x3 = ['500', '1000', '2500'];
    let currentQty = '250';

    for (const qty of qtysFor2x3) {
      const ok = await antdSelect(page, currentQty, qty);
      if (ok) currentQty = qty;
      const p = await readPrice(page);
      log(`2x3 / ${qty}: ${JSON.stringify(p)}`);
      results.prices.push({ size: '2x3', qty: parseInt(qty), price: p.total, unit: p.unit });
      await page.screenshot({ path: path.join(SS, `ax2-2x3-qty${qty}.png`) });
    }

    // ─── Switch to 3"×4" size ─────────────────────────────────────────────────
    const currentSize = (await getCurrentAntdValues(page)).find(v => /\d.*x.*\d/.test(v));
    log('Current size: ' + currentSize);

    if (currentSize) {
      const sizeOk = await antdSelect(page, currentSize, '3" x 4"');
      if (sizeOk) {
        // Reset qty to 250 first
        const currentQtyNow = (await getCurrentAntdValues(page)).find(v => /^\d{3,4}$/.test(v));
        if (currentQtyNow !== '250') {
          await antdSelect(page, currentQtyNow, '250');
          await sleep(500);
        }

        const p3x4_250 = await readPrice(page);
        log(`3x4 / 250: ${JSON.stringify(p3x4_250)}`);
        results.prices.push({ size: '3x4', qty: 250, price: p3x4_250.total, unit: p3x4_250.unit });

        // Iterate qtys for 3x4
        let qtyNow = '250';
        for (const qty of ['500', '1000', '2500']) {
          const ok = await antdSelect(page, qtyNow, qty);
          if (ok) qtyNow = qty;
          const p = await readPrice(page);
          log(`3x4 / ${qty}: ${JSON.stringify(p)}`);
          results.prices.push({ size: '3x4', qty: parseInt(qty), price: p.total, unit: p.unit });
          await page.screenshot({ path: path.join(SS, `ax2-3x4-qty${qty}.png`) });
        }
      }
    }

    // ─── Read all price amounts now visible (post-iteration) ──────────────────
    const finalVisible = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^\$[\d,]+\.\d{2}$/.test(el.textContent.trim()))
        .map(el => el.textContent.trim());
    });
    log('Final visible prices: ' + JSON.stringify(finalVisible));

    log('\n=== AXIOM PRICE TABLE ===');
    results.prices.forEach(p => log(`  ${p.size} / ${p.qty}: ${p.price} (${p.unit})`));

  } catch(e) {
    err(e.message);
    results.error = e.message;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  log('Output: ' + OUT);
}

main().catch(e => { err(e.message); process.exit(1); });
