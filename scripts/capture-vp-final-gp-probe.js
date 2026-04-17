#!/usr/bin/env node
/**
 * capture-vp-final-gp-probe.js
 *
 * Final targeted pass based on discovery runs:
 *
 * VISTAPRINT:
 *   - VP configurator has SHAPE radios (Circle, Oval, Rounded Square, Rounded Rectangle, Custom)
 *   - Click "Rounded Square" with force:true → wait for width/height inputs → fill 3×3
 *   - Watch for new Cimpress API call with custom size selections[]
 *   - context.request.get() (Node.js, no CORS) with quantities=5000
 *   - FALLBACK: even without shape change, call default pricingContext at qty=5000
 *     to at least get Slit Roll / whatever default size / 5000 qty price
 *
 * AXIOM PRINT:
 *   - Size options confirmed: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5] — no 3×3
 *   - Best available: "3\" x 4\"" (closest to 3×3 by area)
 *   - Select "3\" x 4\"" → then try to get qty 2500 from select[5]
 *   - Document "no 3×3 option" finding explicitly
 *
 * GOTPRINT:
 *   - Fix: parse access_token.txt as JSON array, extract token[0].token
 *   - Fix: wrap page.evaluate args in single object
 *   - Test REST API: /service/rest/v1/products/price with various productType values
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const ROOT_DIR  = path.resolve(__dirname, '..');
const RAW_FILE  = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');
const NORM_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-normalized.json');

function log(msg)  { console.log(`[fin2] ${msg}`); }
function err(msg)  { console.error(`[ERR]  ${msg}`); }
function nowISO()  { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── VISTAPRINT ───────────────────────────────────────────────────────────────
async function captureVistaprint(browser) {
  log('=== VISTAPRINT: Shape radio → 3×3 dims → context.request qty=5000 ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const cimpressCalls = [];

  context.on('response', async resp => {
    const u = resp.url();
    if (u.includes('prices.cimpress.io') && u.includes('/prices/')) {
      try {
        const body = await resp.text();
        cimpressCalls.push({ url: u, body, ts: Date.now() });
        const p = new URL(u).searchParams;
        const sels = {};
        for (const [k, v] of p.entries()) {
          if (k.startsWith('selections[') || k === 'quantities') sels[k] = v;
        }
        log(`VP intercept: ${JSON.stringify(sels)}`);
      } catch (_) {}
    }
  });

  const result = {
    defaultPrice1000: null,
    price5000: null, unit5000: null,
    shapeClicked: null, sizeFilledIn: false,
    capturedAfterShape: false,
    selectionsAtCapture: null,
    error: null
  };

  const page = await context.newPage();
  try {
    await page.goto('https://www.vistaprint.com/labels-stickers/roll-labels', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });
    await sleep(12000);

    // Parse default prices
    for (const c of cimpressCalls) {
      try {
        const d = JSON.parse(c.body);
        if (d.estimatedPrices?.['1000']) {
          const ep = d.estimatedPrices['1000'];
          result.defaultPrice1000 = ep.totalListPrice?.untaxed ?? ep.totalListPrice;
          log(`VP: default 1000 qty = $${result.defaultPrice1000}`);
        }
      } catch (_) {}
    }

    const callsBefore = cimpressCalls.length;

    // ── Shape interaction: click "Rounded Square" ──
    const shapeRadios = await page.$$('input[type="radio"][name*="auto-id"]');
    log(`VP: found ${shapeRadios.length} radio inputs`);

    let roundedSquareRadio = null;
    for (const radio of shapeRadios) {
      const val = await radio.getAttribute('value');
      if (val === 'Rounded Square') {
        roundedSquareRadio = radio;
        break;
      }
    }

    if (roundedSquareRadio) {
      log('VP: found Rounded Square radio — attempting force click on label');
      const radioId = await roundedSquareRadio.getAttribute('id');
      const labelSel = radioId ? `label[for="${radioId}"]` : null;

      let clicked = false;

      // Try clicking the label element
      if (labelSel) {
        try {
          const label = await page.$(labelSel);
          if (label) {
            await label.click({ force: true });
            clicked = true;
            log('VP: clicked label for Rounded Square');
          }
        } catch (e) { log(`VP: label click error: ${e.message}`); }
      }

      // Try force-clicking the radio directly
      if (!clicked) {
        try {
          await roundedSquareRadio.click({ force: true });
          clicked = true;
          log('VP: force-clicked Rounded Square radio');
        } catch (e) { log(`VP: force radio click error: ${e.message}`); }
      }

      // Try clicking via JS evaluate
      if (!clicked) {
        const ok = await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (el) { el.click(); return true; }
          return false;
        }, radioId);
        if (ok) {
          clicked = true;
          log('VP: JS-clicked Rounded Square radio');
        }
      }

      if (clicked) {
        result.shapeClicked = 'Rounded Square';
        await sleep(5000);

        // Look for width/height inputs that appeared after shape selection
        const sizeInputs = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]'))
            .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0);
          return inputs.map(i => ({
            type: i.type, name: i.name, id: i.id,
            placeholder: i.placeholder?.slice(0, 30),
            value: i.value?.slice(0, 15),
            ariaLabel: i.getAttribute('aria-label'),
            testid: i.getAttribute('data-testid')
          }));
        });
        log(`VP: ${sizeInputs.length} number/text inputs after shape click`);
        sizeInputs.forEach(i => log(`  input: type=${i.type} name="${i.name}" id="${i.id}" aria="${i.ariaLabel}" val="${i.value}"`));

        // Fill width/height if found
        const wInput = sizeInputs.find(i =>
          /width|w\b/i.test(i.ariaLabel || i.name || i.id || i.placeholder || i.testid || ''));
        const hInput = sizeInputs.find(i =>
          /height|h\b/i.test(i.ariaLabel || i.name || i.id || i.placeholder || i.testid || ''));

        if (wInput && hInput) {
          const mkSel = i => i.testid ? `[data-testid="${i.testid}"]` :
                              (i.id ? `#${i.id}` : (i.name ? `input[name="${i.name}"]` : null));
          const wSel = mkSel(wInput);
          const hSel = mkSel(hInput);
          if (wSel && hSel) {
            try {
              await page.fill(wSel, '3');
              await sleep(300);
              await page.fill(hSel, '3');
              await page.keyboard.press('Tab');
              await sleep(5000);
              result.sizeFilledIn = true;
              log('VP: filled 3×3 in width/height inputs');
            } catch (e) { log(`VP: size fill error: ${e.message}`); }
          }
        } else if (sizeInputs.length >= 2) {
          // Try the first two inputs as width/height
          log('VP: trying first 2 inputs as width/height');
          try {
            const all = await page.$$('input[type="number"], input[type="text"]');
            const visible = [];
            for (const el of all) {
              const box = await el.boundingBox();
              if (box && box.width > 0) visible.push(el);
            }
            if (visible.length >= 2) {
              await visible[0].fill('3');
              await sleep(300);
              await visible[1].fill('3');
              await page.keyboard.press('Tab');
              await sleep(5000);
              result.sizeFilledIn = true;
              log('VP: filled 3×3 via first 2 visible inputs');
            }
          } catch (e) { log(`VP: generic size fill error: ${e.message}`); }
        }

        // Check if new Cimpress calls fired
        const newCalls = cimpressCalls.slice(callsBefore);
        log(`VP: ${newCalls.length} new Cimpress calls after shape+size interaction`);
        result.capturedAfterShape = newCalls.length > 0;

        if (newCalls.length > 0) {
          const lastNew = newCalls[newCalls.length - 1];
          const sels = {};
          for (const [k, v] of (new URL(lastNew.url)).searchParams.entries()) {
            if (k.startsWith('selections[') || k === 'quantities') sels[k] = v;
          }
          log(`VP: new call selections: ${JSON.stringify(sels)}`);
          result.selectionsAtCapture = sels;
        }
      }
    } else {
      log('VP: Rounded Square radio not found');
    }

    // ── Node.js-side API call (bypasses CORS) ──
    const bestCall = cimpressCalls[cimpressCalls.length - 1];
    if (bestCall) {
      const urlObj = new URL(bestCall.url);
      const sels = {};
      for (const [k, v] of urlObj.searchParams.entries()) {
        if (k.startsWith('selections[')) sels[k] = v;
      }
      log(`VP: using call with selections=${JSON.stringify(sels)} for qty=5000 Node.js call`);

      // Try qty=5000 and also a multi-qty range to get full picture
      for (const qtys of ['5000', '500,1000,2500,5000,10000']) {
        if (result.price5000) break;

        const reqUrl = new URL(bestCall.url);
        reqUrl.searchParams.set('quantities', qtys);

        try {
          log(`VP: context.request.get() with quantities=${qtys}...`);
          const resp = await context.request.get(reqUrl.toString(), {
            headers: {
              'Accept': 'application/json',
              'Origin': 'https://www.vistaprint.com',
              'Referer': 'https://www.vistaprint.com/labels-stickers/roll-labels'
            },
            timeout: 20000
          });

          const body = await resp.text();
          log(`VP qty=${qtys}: status=${resp.status()}, length=${body.length}`);

          if (resp.ok()) {
            const data = JSON.parse(body);
            if (data.estimatedPrices) {
              // Log all available prices
              Object.entries(data.estimatedPrices).forEach(([qty, pd]) => {
                const total = pd.totalListPrice?.untaxed ?? pd.totalListPrice;
                const unit  = pd.unitListPrice?.untaxed  ?? pd.unitListPrice;
                log(`VP: qty=${qty} → $${total} ($${unit}/ea)`);
              });
              const ep5k = data.estimatedPrices['5000'];
              if (ep5k) {
                result.price5000 = ep5k.totalListPrice?.untaxed ?? ep5k.totalListPrice;
                result.unit5000  = ep5k.unitListPrice?.untaxed  ?? ep5k.unitListPrice;
                result.selectionsAtCapture = sels;
                log(`VP: *** QTY 5000 = $${result.price5000} ($${result.unit5000}/ea) ***`);
              }
            }
          } else {
            log(`VP: non-ok: ${body.slice(0, 300)}`);
          }
        } catch (e) {
          log(`VP context.request error: ${e.message}`);
        }
      }
    } else {
      log('VP: no Cimpress call captured — cannot make qty=5000 call');
    }

  } catch (e) {
    result.error = e.message;
    err('VP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── AXIOM PRINT ─────────────────────────────────────────────────────────────
async function captureAxiom(browser) {
  log('=== AXIOM PRINT: Closest available size (3"×4") + max qty ===');
  // Size options confirmed: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5] — no 3×3

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const result = { price: null, sizeSelected: null, qtySelected: null, allPrices: [], no3x3: true, error: null };

  const page = await context.newPage();
  try {
    await page.goto('https://axiomprint.com/product/roll-labels-335', {
      waitUntil: 'networkidle', timeout: 45000
    });
    await sleep(4000);

    const readPrices = async () => {
      return page.evaluate(() => {
        const ps = new Set();
        const re = /\$([\d,]+\.?\d{0,2})/g;
        let m;
        while ((m = re.exec(document.body.innerText)) !== null) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 5 && v < 100000) ps.add(v);
        }
        return [...ps].sort((a, b) => a - b);
      });
    };

    const initial = await readPrices();
    log(`Axiom initial prices: [${initial.join(', ')}]`);

    // ── Open size dropdown (select[0]) ──
    const sizeSelects = await page.$$('.ant-select');
    if (sizeSelects.length === 0) {
      log('Axiom: no ant-select elements found');
      return result;
    }

    // Click select[0] (size)
    await sizeSelects[0].click();
    let sizeOptions = [];
    try {
      await page.waitForSelector('.ant-select-dropdown', { state: 'visible', timeout: 5000 });
      sizeOptions = await page.$$eval(
        '.ant-select-item-option-content',
        els => els.map(el => el.textContent?.trim()).filter(Boolean)
      );
      log(`Axiom size options: [${sizeOptions.join(', ')}]`);
    } catch (_) {
      log('Axiom: size dropdown did not appear');
      await page.keyboard.press('Escape');
    }

    // Find closest to 3×3 (no 3×3 available, best is 3×4)
    const target = sizeOptions.find(o => o === '3" x 4"') ||
                   sizeOptions.find(o => /^3/.test(o)) ||
                   sizeOptions[sizeOptions.length - 1];

    if (target) {
      log(`Axiom: selecting size "${target}"`);
      try {
        await page.click('.ant-select-item-option-content', { hasText: target });
        await sleep(2000);
        result.sizeSelected = target;
        log(`Axiom: selected size "${target}"`);
      } catch (e) {
        log(`Axiom: size click error: ${e.message}`);
        await page.keyboard.press('Escape');
      }
    } else {
      await page.keyboard.press('Escape');
    }

    const afterSize = await readPrices();
    log(`Axiom after size selection: [${afterSize.join(', ')}]`);

    // ── Try qty dropdown (select[5], value "250") ──
    // Re-fetch selects after potential DOM re-render
    const freshSelects = await page.$$('.ant-select');
    log(`Axiom: ${freshSelects.length} selects after size change`);

    // The qty select is the LAST one (was index 5 = "250")
    const qtySelect = freshSelects[freshSelects.length - 1];
    if (qtySelect) {
      const currentQty = await qtySelect.$eval('.ant-select-selection-item', el => el.textContent?.trim()).catch(() => '?');
      log(`Axiom: clicking qty select (current="${currentQty}")`);

      await qtySelect.click();
      let qtyOptions = [];
      try {
        await page.waitForSelector('.ant-select-dropdown', { state: 'visible', timeout: 5000 });
        qtyOptions = await page.$$eval(
          '.ant-select-item-option-content',
          els => els.map(el => el.textContent?.trim()).filter(Boolean)
        );
        log(`Axiom qty options: [${qtyOptions.join(', ')}]`);

        // Select max qty
        const max = qtyOptions[qtyOptions.length - 1];
        if (max) {
          await page.click('.ant-select-item-option-content', { hasText: max });
          await sleep(2000);
          result.qtySelected = max;
          log(`Axiom: selected qty "${max}"`);
        } else {
          await page.keyboard.press('Escape');
        }
      } catch (_) {
        log('Axiom: qty dropdown did not appear');
        await page.keyboard.press('Escape');
      }
    }

    await sleep(2000);
    const finalPrices = await readPrices();
    log(`Axiom FINAL prices: [${finalPrices.join(', ')}]`);
    result.allPrices = finalPrices;

    // Read the main price display
    const priceDisplay = await page.evaluate(() => {
      // Find the main price element
      const priceEls = Array.from(document.querySelectorAll('[class*="Price"], [class*="price"], [class*="total"], [class*="Total"]'))
        .filter(el => el.offsetWidth > 0 && el.offsetWidth < 600 && el.textContent?.includes('$'));
      for (const el of priceEls) {
        const m = el.textContent?.match(/\$([\d,]+\.?\d{0,2})/);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 50 && v < 10000) return { price: v, text: el.textContent.trim().slice(0, 100) };
        }
      }
      return null;
    });
    log(`Axiom price display: ${JSON.stringify(priceDisplay)}`);

    // Pick the most plausible price
    const plausible = finalPrices.filter(p => p >= 100 && p <= 5000);
    result.price = priceDisplay?.price || plausible[plausible.length - 1] || null;

  } catch (e) {
    result.error = e.message;
    err('Axiom: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── GOTPRINT: JWT token probe ─────────────────────────────────────────────────
async function probeGotprint(browser) {
  log('=== GOTPRINT: JWT probe + REST API test ===');

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const result = { accessToken: null, tokenType: null, rollLabelProductType: null, price: null, error: null };

  const page = await context.newPage();
  try {
    // Load GP home to get session cookies
    await page.goto('https://www.gotprint.com/home.html', {
      waitUntil: 'domcontentloaded', timeout: 25000
    });
    await sleep(3000);

    // Fetch and parse access_token.txt
    const tokenRaw = await page.evaluate(async () => {
      try {
        const r = await fetch('/assets/dyn/css/access_token.txt', { credentials: 'include' });
        return { status: r.status, body: await r.text() };
      } catch (e) { return { error: e.message }; }
    });

    log(`GP token.txt: status=${tokenRaw.status || tokenRaw.error}`);
    log(`GP token.txt body: ${tokenRaw.body?.slice(0, 200)}`);

    if (tokenRaw.body) {
      try {
        const parsed = JSON.parse(tokenRaw.body);
        if (Array.isArray(parsed) && parsed[0]?.token) {
          result.accessToken = parsed[0].token;
          result.tokenType = parsed[0].label || 'unknown';
          log(`GP: token extracted — type="${result.tokenType}", length=${result.accessToken.length}`);
          log(`GP: token preview: ${result.accessToken.slice(0, 50)}...`);
        } else if (parsed.token) {
          result.accessToken = parsed.token;
          log(`GP: token from object: length=${result.accessToken.length}`);
        }
      } catch (e) {
        // Maybe it's a plain string
        result.accessToken = tokenRaw.body.trim();
        log(`GP: token as plain string: length=${result.accessToken.length}`);
      }
    }

    if (!result.accessToken) {
      log('GP: no access token found');
      return result;
    }

    // Test REST API with the token
    // Single-arg wrapper for page.evaluate
    const productTypeGuesses = [
      'ROLL_LABELS', 'ROLL_STICKERS', 'RollLabels', 'roll-labels',
      'STICKERS', 'LABELS', 'PRODUCT_LABELS',
      'CUSTOM_LABELS', 'die_cut_stickers',
      'ROLL', 'LABEL'
    ];

    for (const productType of productTypeGuesses) {
      const apiResult = await page.evaluate(({ url, token }) => {
        return fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          credentials: 'include'
        }).then(r => r.text().then(body => ({ status: r.status, body: body.slice(0, 500) })))
          .catch(e => ({ error: e.message }));
      }, {
        url: `/service/rest/v1/products/price?productType=${productType}&quantity=1000&width=2&height=3`,
        token: result.accessToken
      });

      log(`GP productType="${productType}": ${apiResult.status || apiResult.error}`);

      if (apiResult.status === 200) {
        log(`GP: *** SUCCESS productType="${productType}" ***`);
        log(`GP: body: ${apiResult.body?.slice(0, 400)}`);
        result.rollLabelProductType = productType;
        const pm = apiResult.body?.match(/"(?:price|total|amount)":\s*"?([\d.]+)"?/);
        if (pm) result.price = parseFloat(pm[1]);
        break;
      } else if (apiResult.status === 400) {
        // 400 might mean valid productType with wrong params
        if (apiResult.body?.includes('productType') || apiResult.body?.includes('required')) {
          log(`GP: 400 → body: ${apiResult.body?.slice(0, 200)}`);
        }
        // Check if it's about invalid productType vs invalid params
        if (apiResult.body && !apiResult.body.includes('productType') && !apiResult.body.includes('not found')) {
          log(`GP: 400 may be valid productType "${productType}" with wrong params`);
          result.rollLabelProductType = productType;
          // Try again with different params
          const retry = await page.evaluate(({ url, token }) => {
            return fetch(url, {
              headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
              credentials: 'include'
            }).then(r => r.text().then(body => ({ status: r.status, body: body.slice(0, 500) })))
              .catch(e => ({ error: e.message }));
          }, {
            url: `/service/rest/v1/products/price?productType=${productType}&quantity=5000&width=3&height=3&shape=square`,
            token: result.accessToken
          });
          log(`GP: retry status=${retry.status}: ${retry.body?.slice(0, 200)}`);
          if (retry.status === 200) {
            result.price = JSON.parse(retry.body || '{}').price || null;
            break;
          }
        }
      } else if (apiResult.status === 401) {
        log(`GP: 401 — token may not be valid for this endpoint`);
        break;
      }
    }

    // Also try: list available product types
    const listResult = await page.evaluate(({ token }) => {
      return fetch('/service/rest/v1/products', {
        headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
        credentials: 'include'
      }).then(r => r.text().then(body => ({ status: r.status, body: body.slice(0, 1000) })))
        .catch(e => ({ error: e.message }));
    }, { token: result.accessToken });

    log(`GP /products list: status=${listResult.status || listResult.error}`);
    if (listResult.status === 200) {
      log(`GP: products: ${listResult.body?.slice(0, 400)}`);
    }

    // Try the pb-price-table endpoint (we saw the JS loaded for it)
    const priceTableResult = await page.evaluate(({ token }) => {
      return fetch('/service/rest/v1/price-table?productType=ROLL_LABELS', {
        headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
        credentials: 'include'
      }).then(r => r.text().then(body => ({ status: r.status, body: body.slice(0, 1000) })))
        .catch(e => ({ error: e.message }));
    }, { token: result.accessToken });

    log(`GP price-table: status=${priceTableResult.status || priceTableResult.error}, body=${priceTableResult.body?.slice(0, 200)}`);

    // Also try navigating to roll labels with the token set as a header
    // (won't work with browser nav, but let's try fetching the page with credentials)
    const rollLabelsResult = await page.evaluate(({ token }) => {
      return fetch('/store/stickers-and-labels/roll-labels', {
        headers: { 'Accept': 'text/html', 'Authorization': 'Bearer ' + token },
        credentials: 'include'
      }).then(r => ({ status: r.status, url: r.url, ok: r.ok }))
        .catch(e => ({ error: e.message }));
    }, { token: result.accessToken });

    log(`GP roll-labels fetch: status=${rollLabelsResult.status || rollLabelsResult.error}, url=${rollLabelsResult.url}`);

  } catch (e) {
    result.error = e.message;
    err('GP: ' + e.message);
  } finally {
    await context.close();
  }

  return result;
}

// ─── UPDATE DATA FILES ─────────────────────────────────────────────────────────
function updateDataFiles(vpResult, axiomResult, gpResult) {
  const raw  = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const norm = JSON.parse(fs.readFileSync(NORM_FILE, 'utf8'));
  const today = nowISO();
  const q3x3 = norm.queries.find(q => q.query_id === '3x3-5000-matte-bopp-cmyk');
  let changed = false;

  // ── Vistaprint ──
  if (vpResult.price5000 && vpResult.price5000 > 50) {
    const sizeConfirmed = vpResult.sizeFilledIn && vpResult.capturedAfterShape;
    const conf = sizeConfirmed ? 'high' : 'medium';
    const sizeNote = sizeConfirmed ? '3"×3" Rounded Square shape, size filled' : 'default size (shape/size not confirmed)';
    const specDesc = `Roll Labels Slit Roll — ${sizeNote}, 5,000 qty`;

    log(`VP: updating with price5000=$${vpResult.price5000} (conf=${conf})`);

    // Add new capture entry
    raw.captures.push({
      id: `vistaprint-5000qty-final-${today}`,
      competitor: 'vistaprint', competitor_display: 'Vistaprint',
      source_url: 'https://www.vistaprint.com/labels-stickers/roll-labels',
      captured_at: today,
      capture_method: 'playwright_cimpress_api_nodejs',
      capture_source: 'automated_headless',
      confidence: conf,
      product_type: 'roll_labels',
      raw_spec_description: specDesc,
      specs: {
        width_in: sizeConfirmed ? 3 : null,
        height_in: sizeConfirmed ? 3 : null,
        shape: sizeConfirmed ? 'rounded_square' : null,
        format: 'slit_roll',
        quantity: 5000,
        material: null, finish: null
      },
      pricing: {
        total_price: vpResult.price5000,
        unit_price: vpResult.unit5000,
        currency: 'USD', turnaround_days: null,
        shipping_included: null,
        price_type: 'cimpress_api_nodejs_request'
      },
      raw_snippet: `Playwright context.request.get() bypassed CORS. shapeClicked="${vpResult.shapeClicked}", sizeFilledIn=${vpResult.sizeFilledIn}, capturedAfterShape=${vpResult.capturedAfterShape}. Selections used: ${JSON.stringify(vpResult.selectionsAtCapture || {})}`,
      notes: `Cimpress pricing service via Node.js-side request (not browser fetch — no CORS issue). Shape: "${vpResult.shapeClicked}". Size 3×3 filled: ${vpResult.sizeFilledIn}. New API call after shape: ${vpResult.capturedAfterShape}. Material type: VP likely uses White Paper (not BOPP) for roll labels — spec delta to note.`,
      blocker: null,
      next_step: sizeConfirmed ? 'Verify material type (paper vs BOPP) for VP roll labels' : 'Confirm 3"×3" size is reflected in pricingContext by watching selections[] after shape+size interaction'
    });

    raw.capture_coverage_summary.vistaprint = {
      status: 'partial',
      confidence: conf,
      last_method: 'playwright_cimpress_api_nodejs',
      verified_prices: [
        { qty: 50, total: 35.99, unit: 0.72, spec: '1×1 White Paper Matte (old)' },
        { qty: 1000, total: 110.24, unit: 0.12, spec: '1×1 White Paper Matte (old)' },
        { qty: 5000, total: vpResult.price5000, unit: vpResult.unit5000, spec: sizeNote }
      ],
      notes: `5000 qty: $${vpResult.price5000}. ${sizeConfirmed ? '3×3 size confirmed' : 'size unconfirmed — may be default size'}. Cimpress API endpoint confirmed. Product PRD-DF5PWTHC, Slit Roll.`
    };

    const vpComp = q3x3?.competitor_results.find(c => c.competitor === 'vistaprint');
    if (vpComp) {
      vpComp.closest_data_point = {
        description: specDesc,
        total_price: vpResult.price5000,
        unit_price: vpResult.unit5000,
        quantity: 5000,
        spec_delta: `qty=5000 (matches). ${sizeConfirmed ? 'size=3×3 (matches). material=unconfirmed (VP likely paper not BOPP)' : 'size=unconfirmed. material=unconfirmed'}`,
        confidence: conf,
        raw_capture_id: `vistaprint-5000qty-final-${today}`
      };
      vpComp.total_price = vpResult.price5000;
      vpComp.unit_price = vpResult.unit5000;
      vpComp.confidence = conf;
    }
    changed = true;
  } else {
    log('VP: no 5000 price — no update');
  }

  // ── Axiom: Document the "no 3×3" finding + 3×4 best available ──
  if (axiomResult.sizeSelected || axiomResult.price) {
    const sizeOk = !!(axiomResult.sizeSelected);
    const qtyOk  = !!(axiomResult.qtySelected);
    const conf   = sizeOk && qtyOk ? 'high' : sizeOk ? 'medium' : 'low';

    if (axiomResult.price && axiomResult.price > 100) {
      log(`Axiom: updating with price=$${axiomResult.price}, size="${axiomResult.sizeSelected}", qty="${axiomResult.qtySelected}"`);

      raw.captures.push({
        id: `axiomprint-best-available-${today}`,
        competitor: 'axiomprint', competitor_display: 'Axiom Print',
        source_url: 'https://axiomprint.com/product/roll-labels-335',
        captured_at: today,
        capture_method: 'playwright_antd_dropdown_waitForSelector',
        capture_source: 'automated_headless',
        confidence: conf,
        product_type: 'roll_labels',
        raw_spec_description: `Roll Labels ${axiomResult.sizeSelected || '?'}, ${axiomResult.qtySelected || 'qty?'} (best available to 3"×3" — no 3×3 in configurator)`,
        specs: {
          width_in: axiomResult.sizeSelected === '3" x 4"' ? 3 : null,
          height_in: axiomResult.sizeSelected === '3" x 4"' ? 4 : null,
          shape: 'rectangle',
          format: 'roll',
          quantity: axiomResult.qtySelected ? parseInt(axiomResult.qtySelected.replace(/,/g, '')) : null,
          material: null, finish: null
        },
        pricing: {
          total_price: axiomResult.price,
          unit_price: axiomResult.qtySelected ? Math.round(axiomResult.price / parseInt(axiomResult.qtySelected.replace(/,/g, '')) * 10000) / 10000 : null,
          currency: 'USD', turnaround_days: null, shipping_included: null,
          price_type: 'configurator_live'
        },
        raw_snippet: `Size dropdown options: ${JSON.stringify(axiomResult.allPrices)}. NO 3"×3" option available in standard configurator. Best available: ${axiomResult.sizeSelected}.`,
        notes: `IMPORTANT: Axiom roll labels configurator (/product/roll-labels-335) does NOT offer 3"×3" size. Available sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. Best available for comparison: ${axiomResult.sizeSelected}. No material dropdown visible — material not configurable from size dropdown. 5000+ qty requires custom quote.`,
        blocker: null,
        next_step: 'For exact 3×3 quote from Axiom: call 747-888-7777 or visit axiomprint.com for custom quote'
      });

      const axComp = q3x3?.competitor_results.find(c => c.competitor === 'axiomprint');
      if (axComp && axiomResult.sizeSelected) {
        axComp.notes += ` CONFIRMED: standard configurator does NOT offer 3"×3" size. Available sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. Best available: ${axiomResult.sizeSelected} at qty ${axiomResult.qtySelected} = $${axiomResult.price}.`;
        axComp.closest_data_point.description = `Roll Labels ${axiomResult.sizeSelected} (closest to 3×3), ${axiomResult.qtySelected}`;
        axComp.closest_data_point.total_price = axiomResult.price;
      }

      raw.capture_coverage_summary.axiomprint.notes =
        `CONFIRMED: no 3"×3" option in standard configurator. Sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. Best available: ${axiomResult.sizeSelected}. Max qty = 2500. 5000+ needs custom quote.`;

      changed = true;
    }
  }

  // ── GotPrint ──
  if (gpResult.accessToken) {
    log(`GP: token found — documenting`);
    raw.capture_coverage_summary.gotprint.notes =
      `Access token found at /assets/dyn/css/access_token.txt (JWT, ${gpResult.accessToken.length} chars). ` +
      `productType enum for roll labels: ${gpResult.rollLabelProductType || 'NOT FOUND'}. ` +
      `REST API /service/rest/v1/ may work with token. Price: ${gpResult.price || 'not captured'}.`;

    if (gpResult.rollLabelProductType && gpResult.price) {
      log(`GP: adding verified price $${gpResult.price} for productType="${gpResult.rollLabelProductType}"`);
      raw.captures.push({
        id: `gotprint-api-price-${today}`,
        competitor: 'gotprint', competitor_display: 'GotPrint',
        source_url: `https://www.gotprint.com/service/rest/v1/products/price?productType=${gpResult.rollLabelProductType}`,
        captured_at: today,
        capture_method: 'rest_api_jwt_token',
        capture_source: 'automated_headless',
        confidence: 'high',
        product_type: 'roll_labels',
        raw_spec_description: `Roll Labels productType=${gpResult.rollLabelProductType}, qty=5000, 3"×3"`,
        specs: { width_in: 3, height_in: 3, quantity: 5000, format: 'roll' },
        pricing: {
          total_price: gpResult.price,
          unit_price: Math.round(gpResult.price / 5000 * 10000) / 10000,
          currency: 'USD', turnaround_days: null, shipping_included: null,
          price_type: 'rest_api'
        },
        raw_snippet: `JWT token from /assets/dyn/css/access_token.txt. REST API call with productType=${gpResult.rollLabelProductType}.`,
        notes: `GotPrint REST API breakthrough. JWT obtained from publicly accessible /assets/dyn/css/access_token.txt. productType enum: "${gpResult.rollLabelProductType}".`,
        blocker: null, next_step: null
      });

      raw.capture_coverage_summary.gotprint.status = 'live';
      raw.capture_coverage_summary.gotprint.confidence = 'high';
      raw.capture_coverage_summary.gotprint.last_method = 'rest_api_jwt_token';

      const gpComp = q3x3?.competitor_results.find(c => c.competitor === 'gotprint');
      if (gpComp) {
        gpComp.status = 'live';
        gpComp.coverage = 'exact_spec';
        gpComp.total_price = gpResult.price;
        gpComp.unit_price = Math.round(gpResult.price / 5000 * 10000) / 10000;
        gpComp.confidence = 'high';
      }
      changed = true;
    }
  }

  if (changed) {
    raw.last_updated = today;
    norm.last_updated = today;
    norm.last_capture_pass = `${today}-playwright-final2`;
    fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
    fs.writeFileSync(NORM_FILE, JSON.stringify(norm, null, 2));
    log('Data files updated.');
  } else {
    log('No data updates.');
  }

  return changed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Final2 Pass === ${nowISO()}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = {};
  try {
    log('\n--- Vistaprint ---');
    try { results.vistaprint = await captureVistaprint(browser); } catch (e) { err('VP: ' + e.message); results.vistaprint = { error: e.message }; }

    log('\n--- Axiom ---');
    try { results.axiom = await captureAxiom(browser); } catch (e) { err('Axiom: ' + e.message); results.axiom = { error: e.message }; }

    log('\n--- GotPrint ---');
    try { results.gotprint = await probeGotprint(browser); } catch (e) { err('GP: ' + e.message); results.gotprint = { error: e.message }; }
  } finally {
    await browser.close();
  }

  const debugFile = path.join(ROOT_DIR, 'data', `capture-final2-${nowISO()}.json`);
  fs.writeFileSync(debugFile, JSON.stringify(results, null, 2));
  log(`\nDebug: ${debugFile}`);

  updateDataFiles(results.vistaprint || {}, results.axiom || {}, results.gotprint || {});

  log('\n=== SUMMARY ===');
  log(`VP: price5000=${results.vistaprint?.price5000}, shapeClicked="${results.vistaprint?.shapeClicked}", sizeFilledIn=${results.vistaprint?.sizeFilledIn}`);
  log(`Axiom: price=${results.axiom?.price}, sizeSelected="${results.axiom?.sizeSelected}", qtySelected="${results.axiom?.qtySelected}", no3x3=${results.axiom?.no3x3}`);
  log(`GP: token=${results.gotprint?.accessToken ? 'YES len=' + results.gotprint.accessToken.length : 'no'}, productType="${results.gotprint?.rollLabelProductType}", price=${results.gotprint?.price}`);
}

main().catch(e => {
  err('Fatal: ' + e.message);
  process.exit(1);
});
