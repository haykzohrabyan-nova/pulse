#!/usr/bin/env node
/**
 * capture-gp-single-session.js
 *
 * Single-session GotPrint pass. No page reloads.
 * Navigate once to /products/roll-labels/order, then iterate through
 * all shapes to find which ones have a 3"×3" (or closest) size option.
 * For the best match, configure all dropdowns and read subtotal.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const RAW     = path.join(ROOT, 'data', 'competitor-pricing-raw.json');
const NORM    = path.join(ROOT, 'data', 'competitor-pricing-normalized.json');
const SS_DIR  = path.join(ROOT, 'data', 'screenshots');

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const log  = m => console.log(`[gps] ${m}`);
const err  = m => console.error(`[ERR] ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ss(page, name) {
  try { await page.screenshot({ path: path.join(SS_DIR, `${name}-${Date.now()}.png`) }); } catch (_) {}
}

async function main() {
  const raw  = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM, 'utf8'));
  const today = new Date().toISOString().split('T')[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  const xhrLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('gotprint.com') && resp.status() < 400) {
      try {
        const body = await resp.text();
        xhrLog.push({ url: u, body: body.slice(0, 3000) });
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const result = {
    shapeMap: {},   // shape → list of available sizes
    bestConfig: null,
    capturedPrice: null
  };

  try {
    log('Loading configurator...');
    await page.goto('https://www.gotprint.com/products/roll-labels/order', {
      waitUntil: 'load', timeout: 60000
    });
    await wait(5000);
    await ss(page, 'gps-01-loaded');

    const pageUrl = page.url();
    log(`URL: ${pageUrl} | Title: "${await page.title()}"`);

    if (pageUrl.includes('home.html')) {
      log('BLOCKED: redirected to home.html');
      await page.close(); await context.close(); await browser.close();
      return;
    }

    // ── Enumerate all selects and their names ──
    const selectInfo = await page.evaluate(() => {
      return [...document.querySelectorAll('select')].map(s => ({
        name: s.name || s.id || '',
        visible: s.offsetWidth > 0,
        disabled: s.disabled,
        options: [...s.options].map(o => ({ value: o.value, text: o.text.trim() }))
      }));
    });
    log(`Found ${selectInfo.length} selects:`);
    for (const s of selectInfo) {
      log(`  select[name="${s.name}"] visible=${s.visible} disabled=${s.disabled} opts=${s.options.slice(0, 5).map(o => o.text).join(' | ')}`);
    }

    const shapeInfo = selectInfo.find(s => s.name === 'shape');
    if (!shapeInfo) {
      log('Shape select not found by name. Trying by index...');
      // Use the visible, enabled select with shape-like options
      for (const s of selectInfo) {
        if (s.visible && !s.disabled && s.options.some(o => /square|rectangle|circle/i.test(o.text))) {
          log(`Using select[name="${s.name}"] as shape selector`);
          break;
        }
      }
    }

    const shapeOptions = shapeInfo?.options.filter(o => o.text !== 'Please select an option') ||
      selectInfo.find(s => s.visible && !s.disabled)?.options.filter(o => o.text !== 'Please select an option') ||
      [];

    log(`Shape options: ${shapeOptions.map(o => o.text).join(' | ')}`);

    // ── Iterate through shapes to find size options ──
    for (const shapeOpt of shapeOptions) {
      log(`\nTesting shape: "${shapeOpt.text}"`);

      // Select this shape using native JS
      await page.evaluate((shapeVal) => {
        const sel = document.querySelector('select[name="shape"]') ||
                    [...document.querySelectorAll('select')].find(s =>
                      [...s.options].some(o => /square|rectangle|circle|oval/i.test(o.text))
                    );
        if (sel) {
          sel.value = shapeVal;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, shapeOpt.value);
      await wait(2000);

      // Read size options
      const sizeInfo = await page.evaluate(() => {
        const sel = document.querySelector('select[name="size"]') ||
                    [...document.querySelectorAll('select')].find((s, i) => i === 2);
        if (!sel) return null;
        return {
          disabled: sel.disabled,
          options: [...sel.options].map(o => o.text.trim()).filter(t => t !== 'Please select an option')
        };
      });

      log(`  Size options: ${sizeInfo?.options?.join(' | ') || 'N/A'} (disabled=${sizeInfo?.disabled})`);
      result.shapeMap[shapeOpt.text] = sizeInfo?.options || [];

      // Check for 3×3
      const has3x3 = sizeInfo?.options?.some(s => /^3"?\s*[xX×]\s*3"?$|3.*x.*3/i.test(s));
      if (has3x3) {
        log(`  *** 3×3 found for shape "${shapeOpt.text}"! ***`);
      }
    }

    log('\n── Shape → Size map ──');
    for (const [shape, sizes] of Object.entries(result.shapeMap)) {
      log(`  ${shape}: ${sizes.join(' | ')}`);
    }

    // ── Find best shape for 3×3 target ──
    let targetShape = null;
    let targetSize  = null;

    // Priority: exact 3×3 match
    for (const [shape, sizes] of Object.entries(result.shapeMap)) {
      const exact = sizes.find(s => /^3"?\s*[xX×]\s*3"?$/i.test(s));
      if (exact) { targetShape = shape; targetSize = exact; break; }
    }

    // Fallback: closest to 3×3 (within 1 inch)
    if (!targetShape) {
      let bestDist = Infinity, bestShape = null, bestSize = null;
      for (const [shape, sizes] of Object.entries(result.shapeMap)) {
        for (const s of sizes) {
          const m = s.match(/([\d.]+)"?\s*(?:x|X|×)\s*([\d.]+)"?/i) || s.match(/([\d.]+)"?\s*Diameter/i);
          if (m) {
            const w = parseFloat(m[1]), h = parseFloat(m[2] || m[1]);
            const dist = Math.abs(w - 3) + Math.abs(h - 3);
            if (dist < bestDist) {
              bestDist = dist; bestShape = shape; bestSize = s;
            }
          }
        }
      }
      if (bestShape) { targetShape = bestShape; targetSize = bestSize; }
    }

    // Final fallback: largest Square size
    if (!targetShape && result.shapeMap['Square']) {
      targetShape = 'Square';
      targetSize  = result.shapeMap['Square'].slice(-1)[0] || null;
    }

    log(`\n── Target: shape="${targetShape}" size="${targetSize}" ──`);

    if (targetShape) {
      // ── Full configuration ──
      // 1. Set shape
      await page.evaluate((shapeText) => {
        const sel = document.querySelector('select[name="shape"]') ||
                    [...document.querySelectorAll('select')].find(s =>
                      [...s.options].some(o => /square|rectangle|circle|oval/i.test(o.text))
                    );
        if (!sel) return;
        const opt = [...sel.options].find(o => o.text.trim() === shapeText);
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, targetShape);
      await wait(2500);
      log(`Set shape: "${targetShape}"`);

      // 2. Set size
      if (targetSize) {
        await page.evaluate((sizeText) => {
          const sel = document.querySelector('select[name="size"]') ||
                      [...document.querySelectorAll('select')].find((s, i) => i === 2);
          if (!sel) return;
          const opt = [...sel.options].find(o => o.text.trim() === sizeText);
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, targetSize);
        await wait(2500);
        log(`Set size: "${targetSize}"`);
      }

      // 3. Set paper = White BOPP
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="paper"]') ||
                    [...document.querySelectorAll('select')].find((s, i) => i === 3);
        if (!sel || sel.disabled) return;
        const opt = [...sel.options].find(o => /white.*bopp/i.test(o.text)) ||
                    [...sel.options].find(o => /bopp/i.test(o.text)) ||
                    [...sel.options].find(o => o.text !== 'Please select an option');
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await wait(2500);

      const paperSelected = await page.evaluate(() => {
        const s = document.querySelector('select[name="paper"]');
        return s?.options[s.selectedIndex]?.text || null;
      });
      log(`Paper: "${paperSelected}"`);

      // 4. Set finish = Matte
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="finish"]') ||
                    [...document.querySelectorAll('select')].find((s, i) => i === 4);
        if (!sel || sel.disabled) return;
        const opt = [...sel.options].find(o => /matte/i.test(o.text)) ||
                    [...sel.options].find(o => o.text !== 'Please select an option');
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await wait(2500);

      const finishSelected = await page.evaluate(() => {
        const s = document.querySelector('select[name="finish"]');
        return s?.options[s.selectedIndex]?.text || null;
      });
      log(`Finish: "${finishSelected}"`);

      // 5. Set color
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="color"]') ||
                    [...document.querySelectorAll('select')].find((s, i) => i === 5);
        if (!sel || sel.disabled) return;
        const opt = [...sel.options].find(o => o.text !== 'Please select an option');
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await wait(3000);

      await ss(page, 'gps-02-fully-configured');

      // 6. Read subtotal
      const subtotalData = await page.evaluate(() => {
        // Try the cart-price class (confirmed from CSS)
        const cartPrice = document.querySelector('.cart-price');
        if (cartPrice) return { source: 'cart-price', text: cartPrice.textContent.trim() };

        // Search DOM for price near subtotal text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent.trim();
          if (/^\$[\d,]+\.\d{2}$/.test(t)) {
            const amt = parseFloat(t.replace(/[$,]/g, ''));
            if (amt > 0) return { source: 'walker', text: t, amount: amt };
          }
        }

        // Look at the subtotal row specifically
        const tds = document.querySelectorAll('td, span, div');
        for (const td of tds) {
          if (/subtotal/i.test(td.textContent)) {
            const row = td.closest('tr') || td.parentElement;
            if (row) {
              const priceMatch = row.textContent.match(/\$([\d,]+\.\d{2})/);
              if (priceMatch) return { source: 'subtotal_row', text: `$${priceMatch[1]}`, amount: parseFloat(priceMatch[1].replace(/,/g, '')) };
            }
          }
        }

        return null;
      });
      log(`Subtotal: ${JSON.stringify(subtotalData)}`);

      if (subtotalData?.amount && subtotalData.amount > 0) {
        result.capturedPrice = subtotalData.amount;
        result.bestConfig = { shape: targetShape, size: targetSize, paper: paperSelected, finish: finishSelected };
      }

      // 7. Also read all visible prices
      const allPrices = await page.evaluate(() => {
        const prices = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent.trim();
          if (/\$[\d,]+\.\d{2}/.test(t) && t.length < 50) prices.push(t);
        }
        return [...new Set(prices)].slice(0, 15);
      });
      log(`All visible prices: ${allPrices.join(' | ')}`);

      // 8. Check XHR for pricing data after configuration
      const recentXhr = xhrLog.slice(-10);
      for (const xhr of recentXhr) {
        if (xhr.url.includes('/service/rest/v1')) {
          const endpoint = xhr.url.split('/v1/')[1]?.split('?')[0];
          log(`XHR endpoint: ${endpoint} → ${xhr.body.slice(0, 200)}`);
        }
        try {
          const d = JSON.parse(xhr.body);
          // Look for pricing
          if (d.price || d.totalPrice || d.subtotal) {
            const price = d.price || (Array.isArray(d.totalPrice) ? d.totalPrice[0]?.price : d.totalPrice) || d.subtotal;
            if (price && parseFloat(price) > 0) {
              log(`XHR price field: $${price}`);
              if (!result.capturedPrice) result.capturedPrice = parseFloat(price);
            }
          }
        } catch (_) {}
      }

      // 9. Take screenshot of page bottom with product details
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await wait(1000);
      await ss(page, 'gps-03-bottom');
    }

    // ── Print all shape → size results ──
    console.log('\n═══════════════════════════════════════════════');
    console.log(' GOTPRINT SHAPE → SIZE MAP');
    console.log('═══════════════════════════════════════════════');
    for (const [shape, sizes] of Object.entries(result.shapeMap)) {
      const has3x3 = sizes.some(s => /3.*x.*3/i.test(s));
      console.log(`  ${has3x3 ? '✓' : ' '} ${shape}: ${sizes.join(' | ')}`);
    }
    console.log('');
    console.log(`Best match: shape="${targetShape}" size="${targetSize}"`);
    console.log(`Captured price: ${result.capturedPrice ? '$' + result.capturedPrice : 'NOT CAPTURED'}`);
    console.log(`Best config: ${JSON.stringify(result.bestConfig)}`);
    console.log('═══════════════════════════════════════════════\n');

    // ── Save data ──
    const gpEntry = {
      id: `gotprint-shape-size-map-${today}`,
      competitor: 'gotprint',
      competitor_display: 'GotPrint',
      source_url: 'https://www.gotprint.com/products/roll-labels/order',
      captured_at: today,
      capture_method: 'playwright_native_select_js_dispatch',
      capture_source: 'automated_headless',
      confidence: result.capturedPrice ? 'medium' : 'low',
      product_type: 'roll_labels',
      raw_spec_description: result.bestConfig ? `shape="${result.bestConfig.shape}" size="${result.bestConfig.size}" paper="${result.bestConfig.paper}" finish="${result.bestConfig.finish}"` : 'Shape/size map explored',
      specs: result.bestConfig ? {
        shape: result.bestConfig.shape,
        size: result.bestConfig.size,
        material: result.bestConfig.paper,
        finish: result.bestConfig.finish
      } : {},
      pricing: {
        total_price: result.capturedPrice,
        unit_price: null,
        currency: 'USD',
        price_type: result.capturedPrice ? 'configurator_subtotal' : 'not_captured'
      },
      raw_snippet: `shape_size_map=${JSON.stringify(result.shapeMap).slice(0, 500)}`,
      notes: [
        `Configurator: /products/roll-labels/order — native selects by name=shape/size/paper/finish/color.`,
        `All shape → size options: ${JSON.stringify(result.shapeMap)}.`,
        `Shapes with 3×3: ${Object.entries(result.shapeMap).filter(([, sz]) => sz.some(s => /3.*x.*3/i.test(s))).map(([sh]) => sh).join(', ') || 'NONE FOUND'}.`,
        `Best available for 3×3 target: shape="${targetShape}" size="${targetSize}".`,
        `NOTE: Qty selector NOT on configurator page — must upload artwork to proceed to qty+price.`,
        `Materials confirmed: Clear BOPP, White BOPP, White Vinyl, White Removable, Clear Removable, Silver Foil BOPP.`,
        `Finishes: Clear Gloss (Indoor), Clear Gloss (Outdoor), Matte Finish (Indoor).`
      ].join(' '),
      blocker: result.capturedPrice ? null : 'Subtotal stays $0 until artwork uploaded. Qty/price only available in upload+checkout flow.',
      next_step: `Manual: gotprint.com/products/roll-labels/order → shape="${targetShape}" → size="${targetSize}" → White BOPP → Matte → Upload any image → enter qty 5000 → read subtotal.`
    };

    const idx = raw.captures.findIndex(c => c.id === gpEntry.id);
    if (idx >= 0) raw.captures[idx] = gpEntry; else raw.captures.push(gpEntry);

    // Update coverage summary
    const shapesWith3x3 = Object.entries(result.shapeMap)
      .filter(([, sz]) => sz.some(s => /3.*x.*3/i.test(s)))
      .map(([sh]) => sh);

    raw.capture_coverage_summary.gotprint = {
      status: 'partial',
      confidence: 'medium',
      last_method: 'playwright_native_select_js_dispatch',
      configurator_url: 'https://www.gotprint.com/products/roll-labels/order',
      shape_size_map: result.shapeMap,
      shapes_with_3x3: shapesWith3x3,
      paper_options: ['Clear BOPP Label', 'White BOPP Label', 'White Vinyl Label', 'White Removable Label', 'Clear Removable Label', 'Silver Foil BOPP Label'],
      finish_options: ['Clear Gloss Laminate (Indoor)', 'Clear Gloss Laminate (Outdoor)', 'Matte Finish (Indoor)'],
      best_available_for_3x3: { shape: targetShape, size: targetSize },
      notes: `Configurator found and fully explored. Native selects. No qty selector on config page — qty comes after upload. Subtotal = $0 without upload. Price capture requires manual flow: select options → upload → qty → checkout.`
    };

    // Update normalized
    const q = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
    if (q) {
      const gi = q.competitor_results.findIndex(r => r.competitor === 'gotprint');
      const gpNorm = {
        competitor: 'gotprint',
        competitor_display: 'GotPrint',
        status: 'partial',
        coverage: 'configurator_explored_upload_required_for_price',
        total_price: result.capturedPrice,
        unit_price: null,
        currency: 'USD',
        shipping_included: false,
        confidence: result.capturedPrice ? 'medium' : 'low',
        notes: `Configurator at /products/roll-labels/order fully explored. Shapes with 3×3: [${shapesWith3x3.join(', ')}]. Best available: "${targetShape}" "${targetSize}" + White BOPP + Matte. Qty selector only in upload flow. To get price: upload artwork → set qty 5000 → read subtotal. No automated price capture possible without artwork file.`,
        closest_data_point: {
          description: `Best configurable: ${targetShape} / ${targetSize} / White BOPP / Matte Finish`,
          price: result.capturedPrice,
          spec_delta: `size=${targetSize} (${targetSize === '3" x 3"' ? 'EXACT' : 'closest available'})`,
          confidence: 'low'
        }
      };
      if (gi >= 0) Object.assign(q.competitor_results[gi], gpNorm);
      else q.competitor_results.push(gpNorm);
    }

    raw.last_updated = today;
    norm.last_updated = today;
    fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM, JSON.stringify(norm, null, 2));
    log('✓ Data files updated');

  } catch (e) {
    err(`${e.message}\n${e.stack}`);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
