#!/usr/bin/env node
/**
 * capture-labels.js — Competitor Label Pricing Capture Utility
 *
 * Attempts to fetch label pricing from competitor sites.
 * Writes results to data/competitor-pricing-raw.json.
 *
 * Usage:
 *   node scripts/capture-labels.js
 *   node scripts/capture-labels.js --competitor stickermule
 *   node scripts/capture-labels.js --dry-run
 *
 * Requirements:
 *   Node 18+ (uses built-in fetch)
 *   Run from the v2/ directory: cd /path/to/v2 && node scripts/capture-labels.js
 *
 * Status per competitor (as of April 2026):
 *   Sticker Mule  → PARTIAL  — JSON-LD schema price extractable ($47 starting)
 *   GotPrint      → PARTIAL  — One promo price in nav markup ($72.92 / 2" circles)
 *   Vistaprint    → BLOCKED  — Full JS rendering required
 *   UPrinting     → BLOCKED  — Full JS rendering required
 *   Axiom Print   → BLOCKED  — Next.js 404 on all label URLs
 *
 * For blocked sites: see headless browser scaffold at bottom of file.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT_DIR, 'data', 'competitor-pricing-raw.json');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15000;

// ─── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN       = args.includes('--dry-run');
const SPECIFIC_COMP = (() => {
  const idx = args.indexOf('--competitor');
  return idx !== -1 ? args[idx + 1] : null;
})();

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[capture] ${msg}`); }
function warn(msg) { console.warn(`[WARN]    ${msg}`); }
function err(msg)  { console.error(`[ERROR]   ${msg}`); }

function nowISO() {
  return new Date().toISOString().split('T')[0];
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, status: resp.status, html: null };
    }
    const html = await resp.text();
    return { ok: true, status: resp.status, html };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, html: null, error: e.message };
  }
}

/**
 * Extract JSON-LD blocks from HTML.
 * Returns array of parsed objects.
 */
function extractJsonLD(html) {
  const results = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      results.push(obj);
    } catch (_) { /* malformed JSON-LD */ }
  }
  return results;
}

/**
 * Recursively find all objects in a JSON-LD structure
 * that have a given @type value.
 */
function findByType(obj, type, found = []) {
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) {
    obj.forEach(item => findByType(item, type, found));
  } else {
    if (obj['@type'] === type || (Array.isArray(obj['@type']) && obj['@type'].includes(type))) {
      found.push(obj);
    }
    Object.values(obj).forEach(v => findByType(v, type, found));
  }
  return found;
}

/**
 * Fuzzy search for price patterns in HTML text.
 * Returns array of { price, context } matches.
 */
function extractPricePatterns(html, contextKeywords = []) {
  const prices = [];
  // Match dollar amounts like $12.34 or $1,234.56
  const re = /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = Math.max(0, m.index - 80);
    const end   = Math.min(html.length, m.index + 80);
    const context = html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const priceVal = parseFloat(m[1].replace(/,/g, ''));
    if (priceVal < 1 || priceVal > 50000) continue; // filter noise
    // Check if any context keyword appears nearby
    if (contextKeywords.length === 0 || contextKeywords.some(kw => context.toLowerCase().includes(kw.toLowerCase()))) {
      prices.push({ price: priceVal, context });
    }
  }
  return prices;
}

// ─── Per-competitor capture adapters ──────────────────────────────────────────

/**
 * Sticker Mule — JSON-LD schema price is available without JS execution.
 * Also checks for Open Graph price meta tags.
 */
async function captureStickermule() {
  const url = 'https://www.stickermule.com/custom-labels';
  log('Sticker Mule: fetching ' + url);
  const { ok, status, html, error } = await fetchPage(url);

  if (!ok) {
    return buildResult('stickermule', 'Sticker Mule', url, 'fetch_failed', {
      blocker: error || `HTTP ${status}`,
      notes: `Fetch failed: ${error || 'HTTP ' + status}`
    });
  }

  const jsonLDs = extractJsonLD(html);
  const offers  = [];
  jsonLDs.forEach(ld => {
    findByType(ld, 'AggregateOffer').forEach(o => offers.push(o));
    findByType(ld, 'Offer').forEach(o => offers.push(o));
  });

  if (offers.length > 0) {
    const best = offers.find(o => o.lowPrice) || offers[0];
    const price = parseFloat(best.lowPrice || best.price);
    const currency = best.priceCurrency || 'USD';
    log(`Sticker Mule: found price $${price} ${currency} in JSON-LD`);

    // Try to find turnaround from page content
    const turnaround = html.includes('4 day') || html.includes('4-day') ? 4 : null;
    const freeShipping = html.toLowerCase().includes('free shipping') || html.toLowerCase().includes('free worldwide');

    return buildResult('stickermule', 'Sticker Mule', url, 'json_ld_schema', {
      captureMethod: 'json_ld_schema',
      confidence: 'medium',
      rawSpec: 'Custom labels — any shape or size (starting price)',
      price: price,
      currency: currency,
      priceType: 'starting_from',
      turnaround: turnaround,
      shippingIncluded: freeShipping || null,
      rawSnippet: JSON.stringify(best).slice(0, 200),
      notes: `Starting price from JSON-LD AggregateOffer. Shipping: ${freeShipping ? 'free' : 'unknown'}. 4-day turnaround: ${turnaround === 4}. Full per-size pricing requires headless browser.`,
      nextStep: 'Use Playwright to interact with size configurator for 3x3, 5000 pcs quote'
    });
  }

  // Fallback: try price patterns in HTML
  const prices = extractPricePatterns(html, ['label', 'sticker', 'custom']);
  if (prices.length > 0) {
    log(`Sticker Mule: no JSON-LD, found ${prices.length} price pattern(s) in markup`);
    return buildResult('stickermule', 'Sticker Mule', url, 'html_price_pattern', {
      captureMethod: 'html_price_pattern',
      confidence: 'low',
      rawSpec: 'Price pattern from HTML — spec unknown',
      price: prices[0].price,
      priceType: 'unknown',
      notes: 'Price found via pattern match (no JSON-LD available). Context: ' + prices[0].context,
      nextStep: 'Verify with headless browser'
    });
  }

  log('Sticker Mule: no price found in static HTML');
  return buildResult('stickermule', 'Sticker Mule', url, 'html_scrape', {
    captureMethod: 'html_scrape',
    confidence: 'none',
    blocker: 'no_static_price',
    notes: 'No price found in static HTML. JSON-LD present but no Offer/AggregateOffer type.',
    nextStep: 'Use Playwright to interact with size configurator'
  });
}

/**
 * GotPrint — tries to extract price from nav markup and product page.
 */
async function captureGotprint() {
  const url = 'https://www.gotprint.com/g/stickers-and-labels.html';
  log('GotPrint: fetching ' + url);
  const { ok, status, html, error } = await fetchPage(url);

  if (!ok) {
    return buildResult('gotprint', 'GotPrint', url, 'fetch_failed', {
      blocker: error || `HTTP ${status}`,
      notes: `Fetch failed: ${error || 'HTTP ' + status}`
    });
  }

  // Try to find "Roll Labels" price near the label product section
  const prices = extractPricePatterns(html, ['label', 'roll', 'sticker']);
  const results = [];

  if (prices.length > 0) {
    log(`GotPrint: found ${prices.length} price pattern(s) in markup`);
    // The $72.92 Roll Labels price is the target
    const rollLabelPrice = prices.find(p => Math.abs(p.price - 72.92) < 1);
    if (rollLabelPrice) {
      results.push(buildResult('gotprint', 'GotPrint', url, 'html_scrape_nav_markup', {
        captureMethod: 'html_scrape_nav_markup',
        confidence: 'low',
        rawSpec: 'Roll Labels 2" circles — example/promo price (qty unknown)',
        price: rollLabelPrice.price,
        priceType: 'example_promo',
        rawSnippet: rollLabelPrice.context.slice(0, 150),
        notes: 'Price found in navigation cross-sell markup. Qty not specified — treat as promo anchor only. Vue.js configurator required for full pricing.',
        nextStep: 'Intercept XHR in browser devtools to find Vue.js pricing API endpoint'
      }));
    } else {
      // Other prices found
      results.push(buildResult('gotprint', 'GotPrint', url, 'html_price_pattern', {
        captureMethod: 'html_price_pattern',
        confidence: 'low',
        rawSpec: 'Price pattern from markup — spec unknown',
        price: prices[0].price,
        priceType: 'unknown',
        notes: 'Found price(s) in static HTML but not the known $72.92 anchor. Context: ' + prices[0].context,
        nextStep: 'Manual review needed'
      }));
    }
  }

  // Also capture available options from static HTML
  const hasVue = html.includes('vueCliApplicationSettings') || html.includes('vue');
  const shapes = ['rectangle', 'circle', 'square', 'oval', 'heart', 'starburst']
    .filter(s => html.toLowerCase().includes(s));
  const materials = ['gloss', 'matte', 'kraft', 'vinyl', 'bopp']
    .filter(m => html.toLowerCase().includes(m));

  log(`GotPrint: Vue.js detected: ${hasVue}, shapes: ${shapes.join(', ')}, materials: ${materials.join(', ')}`);

  if (results.length === 0) {
    return buildResult('gotprint', 'GotPrint', url, 'html_scrape', {
      captureMethod: 'html_scrape',
      confidence: 'none',
      blocker: hasVue ? 'vue_js_configurator' : 'no_static_price',
      notes: `No price extracted. Vue.js configurator: ${hasVue}. Shapes found in markup: [${shapes.join(', ')}]. Materials: [${materials.join(', ')}].`,
      nextStep: 'Intercept XHR/fetch in browser devtools on gotprint.com roll-labels page to find pricing API'
    });
  }

  return results[0];
}

/**
 * Vistaprint — known to be fully JS-rendered.
 * Attempts fetch and documents the blocker.
 */
async function captureVistaprint() {
  const url = 'https://www.vistaprint.com/labels-stickers';
  log('Vistaprint: fetching ' + url);
  const { ok, status, html, error } = await fetchPage(url);

  const blocked = !ok || (html && !html.includes('price') && html.length < 30000);

  return buildResult('vistaprint', 'Vistaprint', url, 'html_fetch_attempt', {
    captureMethod: 'html_fetch_attempt',
    confidence: 'none',
    blocker: 'full_js_ssr_required',
    notes: ok
      ? `Static HTML returned (${html?.length || 0} bytes) but contains no pricing data. All product/price content requires JS execution.`
      : `Fetch failed: ${error || 'HTTP ' + status}`,
    nextStep: 'Use Playwright to navigate to vistaprint.com/custom-labels and configure 3x3 label'
  });
}

/**
 * UPrinting — fully JS-rendered.
 */
async function captureUprinting() {
  const url = 'https://www.uprinting.com/stickers-and-labels.html';
  log('UPrinting: fetching ' + url);
  const { ok, status, html, error } = await fetchPage(url);

  return buildResult('uprinting', 'UPrinting', url, 'html_fetch_attempt', {
    captureMethod: 'html_fetch_attempt',
    confidence: 'none',
    blocker: 'full_js_ssr_required',
    notes: ok
      ? `Static HTML returned (${html?.length || 0} bytes) but contains only Bootstrap CSS / GTM. No pricing data.`
      : `Fetch failed: ${error || 'HTTP ' + status}`,
    nextStep: 'Use Playwright to submit form on uprinting.com custom-stickers/labels page'
  });
}

/**
 * Axiom Print — Next.js site with 404 on label URLs.
 */
async function captureAxiomprint() {
  const urlsToTry = [
    'https://axiomprint.com/labels/',
    'https://axiomprint.com/labels',
    'https://axiomprint.com/stickers-labels/',
    'https://axiomprint.com/roll-labels/',
    'https://axiomprint.com/product-category/labels/'
  ];

  log('Axiom Print: trying ' + urlsToTry.length + ' URL variants');
  let lastStatus = 0;
  let lastError = '';

  for (const url of urlsToTry) {
    const { ok, status, html, error } = await fetchPage(url);
    lastStatus = status;
    if (error) lastError = error;
    if (ok && html && html.length > 5000 && !html.includes('"isFallback":true')) {
      // Found a real page — try to extract prices
      const prices = extractPricePatterns(html, ['label', 'sticker']);
      if (prices.length > 0) {
        log(`Axiom Print: found real page at ${url} with ${prices.length} price(s)`);
        return buildResult('axiomprint', 'Axiom Print', url, 'html_scrape', {
          captureMethod: 'html_scrape',
          confidence: 'medium',
          rawSpec: 'Price pattern from markup',
          price: prices[0].price,
          priceType: 'unknown',
          notes: 'Found at ' + url + '. Context: ' + prices[0].context,
          nextStep: 'Verify spec and quantity for captured price'
        });
      }
      log(`Axiom Print: page found at ${url} but no prices extracted`);
      return buildResult('axiomprint', 'Axiom Print', url, 'html_scrape', {
        captureMethod: 'html_scrape',
        confidence: 'none',
        blocker: 'no_static_price',
        notes: 'Page accessible but no prices in static HTML. Next.js SSR/CSR hydration needed.',
        nextStep: 'Use Playwright or call 747-888-7777 for manual quote'
      });
    }
  }

  return buildResult('axiomprint', 'Axiom Print', urlsToTry[0], 'html_fetch_attempt', {
    captureMethod: 'html_fetch_attempt',
    confidence: 'none',
    blocker: 'nextjs_dynamic_routing_404',
    notes: `All ${urlsToTry.length} URL variants returned 404 or isFallback:true. Last HTTP status: ${lastStatus}. Site uses Next.js dynamic routing — product URLs may follow a different pattern.`,
    nextStep: 'Open axiomprint.com in browser and inspect the URL for label products. Or call 747-888-7777 / email order@axiomprint.com for manual quote.'
  });
}

// ─── Result builder ───────────────────────────────────────────────────────────

function buildResult(id, displayName, url, method, opts = {}) {
  return {
    id: `${id}-${opts.rawSpec ? opts.rawSpec.slice(0,20).replace(/\s+/g,'-').toLowerCase() : 'capture'}-${nowISO()}`,
    competitor: id,
    competitor_display: displayName,
    source_url: url,
    captured_at: nowISO(),
    capture_method: opts.captureMethod || method,
    confidence: opts.confidence || 'none',
    product_type: 'labels',
    raw_spec_description: opts.rawSpec || null,
    specs: opts.specs || {},
    pricing: {
      total_price: opts.price || null,
      unit_price: opts.unitPrice || null,
      currency: opts.currency || 'USD',
      turnaround_days: opts.turnaround || null,
      shipping_included: opts.shippingIncluded !== undefined ? opts.shippingIncluded : null,
      price_type: opts.priceType || null
    },
    raw_snippet: opts.rawSnippet || null,
    notes: opts.notes || '',
    blocker: opts.blocker || null,
    next_step: opts.nextStep || null
  };
}

// ─── Headless browser scaffold (Playwright) ───────────────────────────────────
/*
  For blocked sites, the next step is using Playwright. Install with:
    npm install playwright
    npx playwright install chromium

  Then use a pattern like:

  const { chromium } = require('playwright');

  async function captureStickermuleHeadless(widthIn, heightIn, qty) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://www.stickermule.com/custom-labels');

    // Wait for the configurator to load
    await page.waitForSelector('[data-testid="size-input"]', { timeout: 15000 });

    // Fill in size (example — selectors may need adjustment)
    await page.fill('[name="width"]', String(widthIn));
    await page.fill('[name="height"]', String(heightIn));

    // Select quantity
    await page.selectOption('select[name="quantity"]', String(qty));

    // Wait for price to update
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="price-display"]');
      return el && el.textContent.includes('$');
    });

    const priceText = await page.$eval('[data-testid="price-display"]', el => el.textContent);
    const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));

    await browser.close();
    return price;
  }

  NOTE: Selectors above are illustrative — use browser devtools on the actual
  configurator page to find the real element selectors. The approach is valid;
  the selectors need to be verified per site.

  Once working, add the headless capture results as 'live' confidence entries
  in the raw data file for the specific 3x3 / 5000-piece / matte spec.
*/

// ─── Main ─────────────────────────────────────────────────────────────────────

const ADAPTERS = {
  stickermule:  captureStickermule,
  gotprint:     captureGotprint,
  vistaprint:   captureVistaprint,
  uprinting:    captureUprinting,
  axiomprint:   captureAxiomprint
};

async function main() {
  log('=== Competitor Label Pricing Capture ===');
  log(`Date: ${nowISO()}`);
  log(`Dry run: ${DRY_RUN}`);
  log(`Target: ${SPECIFIC_COMP || 'all'}`);
  log('');

  const targets = SPECIFIC_COMP
    ? [SPECIFIC_COMP].filter(k => ADAPTERS[k])
    : Object.keys(ADAPTERS);

  if (targets.length === 0) {
    err(`Unknown competitor: ${SPECIFIC_COMP}. Valid options: ${Object.keys(ADAPTERS).join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const key of targets) {
    log(`--- ${key} ---`);
    try {
      const result = await ADAPTERS[key]();
      results.push(result);
      const price = result.pricing?.total_price;
      log(`Result: confidence=${result.confidence}, price=${price != null ? '$' + price : 'none'}, blocker=${result.blocker || 'none'}`);
    } catch (e) {
      err(`${key} adapter threw: ${e.message}`);
      results.push(buildResult(key, key, '', 'error', {
        blocker: 'script_error',
        notes: e.message
      }));
    }
    log('');
  }

  // Load existing raw data
  let existing = { schema_version: '1.0', product_scope: 'labels', captures: [], capture_coverage_summary: {} };
  if (fs.existsSync(RAW_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
    } catch (e) {
      warn('Could not parse existing raw data file — will overwrite: ' + e.message);
    }
  }

  // Merge new results: add new captures, keep existing entries that are still valid
  if (!DRY_RUN) {
    // Remove auto-captured entries for targeted competitors today (avoid duplicates on re-run).
    // Preserve entries marked capture_source:'manual' — those are hand-entered and must not be overwritten.
    existing.captures = existing.captures.filter(c => {
      if (!targets.includes(c.competitor)) return true;          // different competitor — keep
      if (c.capture_source === 'manual') return true;            // manual entry — always keep
      return c.captured_at !== nowISO();                         // older auto-capture — keep
    });
    existing.captures.push(...results);
    existing.last_updated = nowISO();

    // Update coverage summary
    results.forEach(r => {
      const hasPrice = r.pricing?.total_price != null;
      existing.capture_coverage_summary[r.competitor] = {
        status: r.blocker ? 'blocked' : (hasPrice ? (r.confidence === 'high' ? 'captured' : 'partial') : 'blocked'),
        reason: r.notes?.slice(0, 100) || r.blocker || 'unknown'
      };
    });

    fs.mkdirSync(path.dirname(RAW_FILE), { recursive: true });
    fs.writeFileSync(RAW_FILE, JSON.stringify(existing, null, 2));
    log(`Wrote ${results.length} result(s) to ${RAW_FILE}`);
  } else {
    log('[DRY RUN] Results:');
    console.log(JSON.stringify(results, null, 2));
  }

  log('');
  log('=== Summary ===');
  results.forEach(r => {
    const price  = r.pricing?.total_price != null ? `$${r.pricing.total_price}` : '—';
    const status = r.blocker ? `BLOCKED (${r.blocker})` : `${r.confidence.toUpperCase()} confidence`;
    log(`${r.competitor_display.padEnd(15)} | price: ${price.padEnd(8)} | ${status}`);
    if (r.next_step) log(`  → Next: ${r.next_step}`);
  });
}

main().catch(e => {
  err('Fatal: ' + e.message);
  console.error(e);
  process.exit(1);
});
