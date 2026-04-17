/**
 * capture-up-2x4-v7.js
 * Final focused attempts:
 * A) Keyboard nav: Tab to size btn -> Enter/Space -> Arrow keys -> Enter
 * B) selectedSpecs["3"] = data-value of 2"x4" A element, then $apply()
 * C) Force display:block on the A element's parent LI, then Playwright click
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
            qty: scope.priceData.qty,
            price: scope.priceData.price,
            total_price: scope.priceData.total_price,
            unit_price: scope.priceData.unit_price,
            size: specs.find(s=>s.order_spec_code==='SZ')?.order_spec_value,
            lam: specs.find(s=>s.order_spec_code==='FLAM')?.order_spec_value,
            selectedSpecs: JSON.stringify(scope.selectedSpecs || {})
          };
        }
      }
    }
    return null;
  });
}

async function setQtyAndRead(page, qty) {
  const qStr = qty.toLocaleString();
  await page.evaluate((qStr) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.trim() === qStr && !['SCRIPT','STYLE'].includes(node.parentElement?.tagName)) {
        node.parentElement.click();
        return;
      }
    }
  }, qStr);
  await page.waitForTimeout(2000);
  return readScope(page);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  try {
    log('Loading UPrinting roll labels...');
    await page.goto('https://www.uprinting.com/roll-labels.html', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    const initial = await readScope(page);
    log(`Initial: ${JSON.stringify(initial)}`);

    // ─── STRATEGY B: Direct Angular scope manipulation ───
    // data-value="15485" on the "2" x 4"" A element
    // selectedSpecs["3"] = "1405" for 2"×2"
    // Try setting to "15485" and $apply()
    log('\n=== STRATEGY B: selectedSpecs injection ===');
    const stratB = await page.evaluate(() => {
      if (typeof angular === 'undefined') return { error: 'no angular' };
      for (const el of document.querySelectorAll('[id*="calc"]')) {
        const scope = angular.element(el).scope();
        if (!scope?.priceData) continue;

        // Find the 2"x4" A element to confirm data-value
        const a2x4 = document.querySelector('a[data-value="15485"]');
        const a2x2 = document.querySelector('a[aria-selected="true"]') || document.querySelector('button.btn.dropdown-toggle.val-wrap:first-child');

        // Try to get the data-value of the currently selected item
        const currentSelected = document.querySelector('a.attr-value[aria-selected="true"]');
        const currentDataValue = currentSelected?.getAttribute('data-value');

        // Inject new selectedSpecs and $apply
        try {
          scope.$apply(() => {
            scope.selectedSpecs['3'] = '15485';
          });
          return {
            method: '$apply_selectedSpecs',
            a2x4Found: !!a2x4,
            currentDataValue,
            newSpecs: JSON.stringify(scope.selectedSpecs)
          };
        } catch(e1) {
          // If $apply fails (already in digest), try $evalAsync
          try {
            scope.$evalAsync(() => {
              scope.selectedSpecs['3'] = '15485';
            });
            return { method: '$evalAsync', error: e1.message };
          } catch(e2) {
            return { error: `$apply: ${e1.message}, $evalAsync: ${e2.message}` };
          }
        }
      }
      return { error: 'no scope found' };
    });
    log(`Strategy B: ${JSON.stringify(stratB)}`);
    await page.waitForTimeout(3000);

    let state = await readScope(page);
    log(`After B: ${JSON.stringify(state)}`);

    if (state?.w !== '4' || state?.h !== '2') {
      // ─── STRATEGY C: Force display on LI, then Playwright click ───
      log('\n=== STRATEGY C: Force display:block on parent LI ===');
      const stratC = await page.evaluate(() => {
        // Find the LI containing "2" x 4""
        const a2x4 = document.querySelector('a[data-value="15485"]');
        if (!a2x4) return { error: 'no a[data-value=15485]' };

        const li = a2x4.closest('li');
        const ul = li?.closest('ul');
        const btnGroup = ul?.closest('.btn-group, .site-dropdown, .dropdown');

        if (li) li.style.display = 'block';
        if (ul) ul.style.display = 'block';
        if (btnGroup) btnGroup.classList.add('open');

        // Also try removing hidden classes
        li?.classList.remove('hidden', 'ng-hide');
        ul?.classList.remove('hidden', 'ng-hide');

        // Force visibility
        if (a2x4) {
          a2x4.style.display = 'block';
          a2x4.style.visibility = 'visible';
          a2x4.style.opacity = '1';
        }

        return {
          liDisplay: li ? window.getComputedStyle(li).display : null,
          aDisplay: a2x4 ? window.getComputedStyle(a2x4).display : null,
          aVisible: a2x4 ? window.getComputedStyle(a2x4).visibility : null,
          liClass: li?.className.slice(0, 60),
          btnGroupOpen: btnGroup?.classList.contains('open')
        };
      });
      log(`Strategy C DOM state: ${JSON.stringify(stratC)}`);
      await page.waitForTimeout(200);

      // Check if element is now visible to Playwright
      try {
        const target = page.locator('a[data-value="15485"]');
        const isVis = await target.isVisible();
        log(`Element visible after CSS force: ${isVis}`);

        if (isVis) {
          await target.click({ timeout: 5000 });
          log('Clicked via Playwright!');
        } else {
          // Try force click even if not visible
          await target.click({ force: true, timeout: 5000 });
          log('Force-clicked via Playwright');
        }
        await page.waitForTimeout(3000);
      } catch(e) {
        log(`Strategy C click error: ${e.message}`);
      }

      state = await readScope(page);
      log(`After C: ${JSON.stringify(state)}`);
    }

    if (state?.w !== '4' || state?.h !== '2') {
      // ─── STRATEGY D: Keyboard navigation ───
      log('\n=== STRATEGY D: Keyboard navigation ===');
      try {
        // Find the size button and focus it
        await page.evaluate(() => {
          const sizeBtn = Array.from(document.querySelectorAll('button.btn.dropdown-toggle'))
            .find(b => b.textContent.trim().includes('"') && b.textContent.trim().includes('x'));
          if (sizeBtn) sizeBtn.focus();
        });
        await page.waitForTimeout(200);

        // Press space/enter to open the dropdown
        await page.keyboard.press('Space');
        await page.waitForTimeout(500);

        // Check if dropdown is open
        const dropdownState = await page.evaluate(() => {
          const openGroups = document.querySelectorAll('.open, [aria-expanded="true"]');
          const allLiVisible = Array.from(document.querySelectorAll('li.blurb-list-dropdown'))
            .filter(li => window.getComputedStyle(li).display !== 'none').length;
          return { openGroups: openGroups.length, visibleLi: allLiVisible };
        });
        log(`After Space key: ${JSON.stringify(dropdownState)}`);

        if (dropdownState.visibleLi > 0 || dropdownState.openGroups > 0) {
          // Press arrow down several times to navigate to "2" x 4""
          // and read current focused option
          for (let i = 0; i < 20; i++) {
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(100);
            const focused = await page.evaluate(() => {
              const f = document.activeElement;
              return { tag: f?.tagName, text: f?.textContent?.trim().slice(0, 20), role: f?.getAttribute('role') };
            });
            if (focused.text === '2" x 4"') {
              log(`Navigated to "2" x 4"" via keyboard!`);
              await page.keyboard.press('Enter');
              break;
            }
          }
          await page.waitForTimeout(3000);

          state = await readScope(page);
          log(`After keyboard nav: ${JSON.stringify(state)}`);
        }
      } catch(e) {
        log(`Strategy D error: ${e.message}`);
      }
    }

    // ─── STRATEGY E: Page route with pre-selected size ───
    if (state?.w !== '4' || state?.h !== '2') {
      log('\n=== STRATEGY E: URL parameter approach ===');
      // Try loading with a URL parameter for the size
      const urlVariants = [
        'https://www.uprinting.com/roll-labels.html?size=15485',
        'https://www.uprinting.com/roll-labels.html?attr_val_id=15485',
        'https://www.uprinting.com/roll-labels.html?specs=15485',
        'https://www.uprinting.com/roll-labels.html#size=15485',
      ];

      for (const url of urlVariants) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
        const s = await readScope(page);
        log(`URL ${url.split('?')[1] || url.split('#')[1]}: w=${s?.w} h=${s?.h}`);
        if (s?.w === '4' || s?.h === '2') {
          state = s;
          break;
        }
      }
    }

    // Final result
    state = await readScope(page);
    log(`\n=== FINAL STATE: w=${state?.w} h=${state?.h} ===`);

    if (state?.w === '4' && state?.h === '2') {
      log('SUCCESS! Capturing prices at 1k, 5k, 10k...');
      for (const qty of [1000, 5000, 10000]) {
        const s = await setQtyAndRead(page, qty);
        log(`Qty ${qty}: ${JSON.stringify(s)}`);
        if (s) RESULTS.push({
          id: `up-label-4x2-${qty}-v7`,
          site: 'UPrinting', product_type: 'roll_labels',
          qty: s.qty, total_price: parseFloat(s.total_price || s.price),
          unit_price: parseFloat(s.unit_price),
          spec: { w: parseFloat(s.w), h: parseFloat(s.h), size: s.size, lam: s.lam },
          confidence: 'high'
        });
      }
    } else {
      log('FAILED to select 2"x4". Capturing reference at current size for documentation.');
      const refState = await readScope(page);
      if (refState) log(`Reference (unchanged): ${JSON.stringify(refState)}`);
    }

  } catch(e) { log(`ERROR: ${e}`); }
  finally { await browser.close(); }

  log(`\nRESULTS (${RESULTS.length}): ${JSON.stringify(RESULTS)}`);
  fs.writeFileSync('/Users/bazaarprinting/.openclaw/workspace/print-production-system/v2/capture-up-2x4-v7-2026-04-17.json',
    JSON.stringify({ run_date: new Date().toISOString(), results: RESULTS }, null, 2));
}
run().catch(e => log(`Fatal: ${e}`));
