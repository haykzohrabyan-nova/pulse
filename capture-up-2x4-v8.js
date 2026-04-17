/**
 * capture-up-2x4-v8.js
 * Keyboard navigation approach (proven to trigger Angular updates in v7):
 * 1. Focus size button -> Space to open dropdown
 * 2. Find exact ArrowDown count to reach "2" x 4""
 * 3. Press Enter to confirm
 * 4. Capture prices at 1k, 5k, 10k qty
 */
const { chromium } = require('playwright');
const fs = require('fs');
function log(msg) { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
const RESULTS = [];

async function readScope(page) {
  return page.evaluate(() => {
    if (typeof angular !== 'undefined') {
      for (const el of document.querySelectorAll('[id*="calc"]')) {
        const scope = angular.element(el).scope();
        if (scope?.priceData) {
          const specs = scope.priceData.order_specs || [];
          return {
            w: scope.priceData.width, h: scope.priceData.height,
            qty: scope.priceData.qty, price: scope.priceData.price,
            total: scope.priceData.total_price, unit: scope.priceData.unit_price,
            size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value,
            lam: specs.find(s=>s.order_spec_code==='FLAM')?.order_spec_value,
            mat: specs.find(s=>s.order_spec_code==='SUBST')?.order_spec_value
          };
        }
      }
    }
    return null;
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  // Track price API calls
  const priceApiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (ct.includes('json') && (url.includes('uprinting') || url.includes('module-api') || url.includes('calc-js'))) {
      const text = await resp.text().catch(() => null);
      if (text?.includes('price')) { priceApiCalls.push({ url, body: text.slice(0, 1000) }); }
    }
  });

  try {
    log('Loading UPrinting roll labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    const initial = await readScope(page);
    log(`Initial: w=${initial?.w} h=${initial?.h} size="${initial?.size}" qty=${initial?.qty} price=${initial?.price}`);

    // Step 1: Focus the size button
    const sizeInfo = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button.btn.dropdown-toggle'));
      const sizeBtn = btns.find(b => b.textContent.trim().includes('"') && b.textContent.trim().includes('x'));
      if (sizeBtn) {
        sizeBtn.focus();
        return { focused: true, text: sizeBtn.textContent.trim(), class: sizeBtn.className.slice(0, 40) };
      }
      return { focused: false };
    });
    log(`Size btn focused: ${JSON.stringify(sizeInfo)}`);
    await page.waitForTimeout(200);

    // Step 2: Press Space to open the dropdown
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);

    // Step 3: Measure nav count to reach "2" x 4""
    const navInfo = await page.evaluate(() => {
      // Get the active element right after Space press
      const activeEl = document.activeElement;
      const activeText = activeEl?.textContent?.trim().slice(0, 30);
      const activeRole = activeEl?.getAttribute('role');

      // Find all A elements in the now-open dropdown(s) in DOM order
      // Look for the specific size dropdown by finding one that contains "0.5" x 0.5""
      const allOptions = Array.from(document.querySelectorAll('li a.attr-value'));
      const sizeStart = allOptions.findIndex(a => a.textContent.trim() === '0.5" x 0.5"');
      const target2x4Idx = allOptions.findIndex(a => a.textContent.trim() === '2" x 4"');
      const current2x2Idx = allOptions.findIndex(a => a.textContent.trim() === '2" x 2"');

      // Also check visible items
      const visibleOptions = allOptions.filter(a => {
        const li = a.closest('li');
        return li && window.getComputedStyle(li).display !== 'none';
      });

      return {
        activeText, activeRole,
        totalOptions: allOptions.length,
        visibleOptions: visibleOptions.length,
        sizeStart,
        target2x4Idx,
        current2x2Idx,
        target2x4Text: allOptions[target2x4Idx]?.textContent?.trim(),
        // Get items around the target for context
        context: allOptions.slice(Math.max(0, target2x4Idx - 3), target2x4Idx + 4).map(a => a.textContent.trim())
      };
    });
    log(`Nav info: ${JSON.stringify(navInfo)}`);

    // The keyboard focus after Space is usually on the toggle button OR first item
    // ArrowDown from the button moves to the first item in the dropdown
    // We need to press ArrowDown until we reach "2" x 4""

    // Strategy: press ArrowDown up to 200 times, checking after each press
    // Stop when we see the scope change to "2" x 4"" or when focused element shows "2" x 4""
    log('Starting arrow key navigation...');

    let found = false;
    let prevSize = initial?.size;
    for (let i = 0; i < 200; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(80); // short wait between presses

      // Check current focused element text
      const focusedText = await page.evaluate(() => {
        const f = document.activeElement;
        const text = (f?.textContent || f?.innerText || f?.getAttribute('data-display') || '').trim();
        return text.slice(0, 25);
      });

      if (focusedText === '2" x 4"' || focusedText === '2\\" x 4\\"') {
        log(`Found "2" x 4"" at ArrowDown press #${i + 1}! Text: "${focusedText}"`);
        found = true;
        await page.keyboard.press('Enter');
        log('Pressed Enter to confirm selection');
        await page.waitForTimeout(3000);
        break;
      }

      // Also check Angular scope every 10 presses
      if (i % 10 === 9) {
        const s = await readScope(page);
        log(`Press #${i+1}: focused="${focusedText}" scope: w=${s?.w} h=${s?.h} size="${s?.size}"`);
      }
    }

    if (!found) {
      log('Did not find "2" x 4"" via keyboard nav. Checking scope...');
    }

    const afterNav = await readScope(page);
    log(`After keyboard nav: ${JSON.stringify(afterNav)}`);

    if (afterNav?.w === '4' && afterNav?.h === '2') {
      log('SUCCESS! Size is now 4"x2". Capturing prices at 1k, 5k, 10k...');
      // Close any open dropdown by pressing Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const qtys = [1000, 5000, 10000];
      for (const qty of qtys) {
        const qStr = qty.toLocaleString();
        await page.evaluate((qStr) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent.trim() === qStr && !['SCRIPT','STYLE','OPTION'].includes(node.parentElement?.tagName)) {
              node.parentElement.click();
              return;
            }
          }
        }, qStr);
        await page.waitForTimeout(2500);

        const s = await readScope(page);
        log(`Qty ${qty}: total=${s?.total} unit=${s?.unit} size="${s?.size}" lam="${s?.lam}"`);
        if (s) RESULTS.push({
          id: `up-label-4x2-${qty}`,
          site: 'UPrinting', competitor: 'uprinting',
          product_type: 'roll_labels',
          qty: parseInt(s.qty), total_price: parseFloat(s.total || s.price),
          unit_price: parseFloat(s.unit),
          spec: { w: parseFloat(s.w), h: parseFloat(s.h), size: s.size, lam: s.lam, material: s.mat },
          confidence: 'high', method: 'keyboard_nav_enter'
        });
      }
    } else {
      log(`Size still ${afterNav?.w}"×${afterNav?.h}". Keyboard nav didn't reach "2"×4". Giving up.`);
      log('FINAL DETERMINATION: UPrinting 2"×4" cannot be captured headlessly with current approach.');
      log('Recommended: Manual price capture or direct API discovery via browser DevTools.');
    }

    log(`\nPrice API calls captured: ${priceApiCalls.length}`);
    if (priceApiCalls.length > 0) {
      priceApiCalls.slice(0, 3).forEach(c => log(`  ${c.url}: ${c.body.slice(0, 200)}`));
    }

  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  log(`\n=== RESULTS (${RESULTS.length}) ===`);
  RESULTS.forEach(r => log(JSON.stringify(r)));

  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-v8-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2));
}
run().catch(e => log(`Fatal: ${e}`));
