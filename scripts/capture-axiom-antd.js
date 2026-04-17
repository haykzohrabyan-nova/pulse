#!/usr/bin/env node
/**
 * capture-axiom-antd.js
 * PRI-7 — Axiom Print: interact with Ant Design Select dropdowns to get qty price curve
 *
 * Confirmed from DOM analysis:
 * - Shape: CustomHorizontalSelect (React) — items: Rectangle, Square, Circle, Oval, Custom Cut
 * - Size: Ant Design Select (.ant-select) — current: "2" x 3"" (ant-select-selection-item)
 * - Qty: Ant Design Select (.ant-select) — current: "250"
 * - Price: ProductInfo_finalPrice__lqRBP
 *
 * Three prices visible: $112.68, $147.62, $221.15 — likely 250/500/1000 for 2x3 Rectangle
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SS = path.join(ROOT_DIR, 'data', 'screenshots');
const OUT_FILE = path.join(ROOT_DIR, 'data', `capture-axiom-antd-${nowISO()}.json`);

function log(msg) { console.log(`[ax] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
function nowISO() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function readAxiomPrice(page) {
  return await page.evaluate(() => {
    const finalP = document.querySelector('[class*="finalPrice"]');
    const unitP = document.querySelector('[class*="subHeadingText"]');
    return {
      total: finalP?.textContent?.trim(),
      unit: unitP?.textContent?.trim()
    };
  });
}

async function clickAntdOption(page, currentSelectionText, targetText) {
  // Click the Ant Design select that currently shows currentSelectionText
  // This opens the dropdown, then we click the target option

  // Find the ant-select with the current value
  const clicked = await page.evaluate((currentText, targetText) => {
    const selectionItems = Array.from(document.querySelectorAll('.ant-select-selection-item'));
    const targetSelect = selectionItems.find(el => el.textContent.trim().includes(currentText));
    if (!targetSelect) return { error: 'no select with text: ' + currentText };

    // Click the parent .ant-select element to open dropdown
    const antSelect = targetSelect.closest('.ant-select');
    if (!antSelect) return { error: 'no .ant-select parent' };

    antSelect.click();
    return { clicked: true, classes: antSelect.className };
  }, currentSelectionText, targetText);

  if (clicked.error) {
    log('Antd click error: ' + clicked.error);
    return false;
  }

  await sleep(500);

  // Wait for dropdown to open and click target option
  const optionClicked = await page.evaluate((target) => {
    // Ant Design renders options in .ant-select-dropdown
    const dropdown = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    if (!dropdown) return { error: 'no open dropdown' };

    const options = Array.from(dropdown.querySelectorAll('.ant-select-item-option'));
    const targetOpt = options.find(opt => opt.textContent.trim() === target || opt.textContent.trim().includes(target));
    if (!targetOpt) {
      return { error: 'option not found', available: options.map(o => o.textContent.trim()).slice(0, 20) };
    }

    targetOpt.click();
    return { clicked: targetOpt.textContent.trim() };
  }, targetText);

  log('Option clicked: ' + JSON.stringify(optionClicked));
  return optionClicked.clicked || false;
}

async function main() {
  log('=== Axiom Antd Capture === ' + nowISO());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const results = { prices: [], fullPriceTable: {}, error: null };

  try {
    await page.goto('https://www.axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    log('Loaded: ' + page.url());

    // Read initial state
    const initialPrice = await readAxiomPrice(page);
    log('Initial price: ' + JSON.stringify(initialPrice));

    // Read all Ant Design selects
    const antdSelects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.ant-select')).map(s => ({
        cls: s.className.slice(0, 60),
        value: s.querySelector('.ant-select-selection-item')?.textContent?.trim() || null,
        visible: !!(s.offsetWidth || s.offsetHeight)
      })).filter(s => s.visible);
    });
    log('Antd selects: ' + JSON.stringify(antdSelects));

    // Read multiple prices visible on page
    const allPrices = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[class*="lato_16"]'))
        .filter(el => /\$\d/.test(el.textContent))
        .map(el => el.textContent.trim());
    });
    log('All visible prices: ' + JSON.stringify(allPrices));

    // Strategy: the three visible prices ($112.68, $147.62, $221.15)
    // are likely quantity breakpoints shown inline in a pricing grid
    // Let's capture the full pricing table visible on page
    const pricingGrid = await page.evaluate(() => {
      // Look for any element that shows qty → price mapping
      const body = document.body.innerHTML;

      // Look for pricing table/grid
      const gridCandidates = Array.from(document.querySelectorAll('[class*="price"], [class*="tier"], [class*="table"], [class*="grid"]'))
        .filter(el => /\$\d/.test(el.textContent) && el.offsetWidth)
        .map(el => ({ cls: el.className.slice(0, 60), html: el.innerHTML.slice(0, 500) }))
        .slice(0, 5);

      // Find the pricing area that contains all three prices
      const priceEls = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          if (el.children.length > 3) return false;
          return /\$(112|147|221)/.test(el.textContent);
        })
        .map(el => ({
          tag: el.tagName,
          cls: el.className.slice(0, 60),
          html: el.innerHTML.slice(0, 600)
        })).slice(0, 5);

      return { gridCandidates, priceEls };
    });
    log('Pricing grid candidates: ' + JSON.stringify(pricingGrid).slice(0, 1000));

    // Now change qty via Antd selector
    // Currently: qty=250 → $112.68. Let's try 500, 1000, 2500
    const currentQty = antdSelects.find(s => /^\d{3,4}$/.test(s.value));
    log('Current qty selector: ' + JSON.stringify(currentQty));

    const qtysToTest = ['500', '1000', '2500'];

    for (const targetQty of qtysToTest) {
      const currentQtyValue = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.ant-select-selection-item'))
          .map(el => el.textContent.trim())
          .find(t => /^\d{3,4}$/.test(t));
      });

      log('Current qty value: ' + currentQtyValue + ' → target: ' + targetQty);

      if (currentQtyValue) {
        const result = await clickAntdOption(page, currentQtyValue, targetQty);
        await sleep(2500);
      } else {
        // Try clicking by locator
        const qtyLocator = page.locator('.ant-select').filter({ hasText: /^\d{3}$/ }).first();
        try {
          await qtyLocator.click();
          await sleep(500);
          await page.locator('.ant-select-item-option').filter({ hasText: targetQty }).first().click();
          await sleep(2500);
        } catch(e) {
          log('Locator click failed: ' + e.message);
        }
      }

      const price = await readAxiomPrice(page);
      log(`qty=${targetQty}: ${JSON.stringify(price)}`);
      results.prices.push({ size: '2x3', qty: parseInt(targetQty), price: price.total, unit: price.unit });

      await page.screenshot({ path: path.join(SS, `axiom-antd-qty${targetQty}.png`) });
    }

    // Also try size selector — find 3x4 option
    const currentSize = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.ant-select-selection-item'))
        .map(el => el.textContent.trim())
        .find(t => /\d+"\s*x\s*\d+"|[\d.]+"\s*x\s*[\d.]+"/.test(t));
    });
    log('Current size: ' + currentSize);

    if (currentSize) {
      // Try to find and select 3x4 size
      const sizeResult = await clickAntdOption(page, currentSize, '3" x 4"');
      if (sizeResult) {
        await sleep(2500);
        const price3x4 = await readAxiomPrice(page);
        log('3x4 default qty price: ' + JSON.stringify(price3x4));
        results.size3x4_price = price3x4;

        // Then iterate qtys for 3x4
        for (const targetQty of ['250', '500', '1000', '2500']) {
          const currentQtyValue = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.ant-select-selection-item'))
              .map(el => el.textContent.trim())
              .find(t => /^\d{3,4}$/.test(t));
          });

          if (currentQtyValue) {
            await clickAntdOption(page, currentQtyValue, targetQty);
            await sleep(2500);
          }

          const price = await readAxiomPrice(page);
          log(`3x4 / qty=${targetQty}: ${JSON.stringify(price)}`);
          results.prices.push({ size: '3x4', qty: parseInt(targetQty), price: price.total, unit: price.unit });
        }
      }
    }

    // Screenshot final state
    await page.screenshot({ path: path.join(SS, 'axiom-antd-final.png') });

    // Summary
    log('\n=== AXIOM PRICES ===');
    results.prices.forEach(p => log(`  ${p.size} / ${p.qty}: ${p.price}`));

  } catch(e) {
    err('Axiom: ' + e.message);
    results.error = e.message;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  log('Output: ' + OUT_FILE);
}

main().catch(e => { err('Fatal: ' + e.message); process.exit(1); });
