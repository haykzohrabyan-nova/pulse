#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.gotprint.com/service/rest/v1/products/300158845/prices';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA });
  const xhrLog = [];
  context.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('gotprint.com') || resp.status() >= 400) return;
    try { xhrLog.push({ url: u, body: await resp.text() }); } catch (_) {}
  });

  const page = await context.newPage();
  await page.goto('https://www.gotprint.com/products/roll-labels/order', { waitUntil: 'load', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  if (page.url().includes('home.html')) { console.log('BLOCKED'); await browser.close(); return; }

  const specXhr = xhrLog.find(x => x.url.includes('specifications'));
  const sizes = specXhr ? (JSON.parse(specXhr.body).sizes || []) : [];
  console.log('Total sizes from specs:', sizes.length);

  // Print all sizes
  for (const s of sizes) {
    console.log('  id=' + s.id + ' "' + s.label + '"');
  }

  // Build lookup
  const byLabel = {};
  for (const s of sizes) byLabel[s.label] = s.id;

  // Find target sizes
  const find = (pattern) => sizes.find(s => s.label.includes(pattern));

  const s2x2  = find('2" x 2"');
  const s1x1  = find('1" x 1"');
  const s4x4  = find('4" x 4"');
  const s2x3v = find('2" x 3"');
  const s3x4v = find('3" x 4"');
  const s4x2h = find('4" x 2"');

  console.log('\nKey sizes:');
  console.log('2x2:', s2x2 ? s2x2.id + ' "' + s2x2.label + '"' : 'NOT FOUND');
  console.log('1x1:', s1x1 ? s1x1.id + ' "' + s1x1.label + '"' : 'NOT FOUND');
  console.log('4x4:', s4x4 ? s4x4.id + ' "' + s4x4.label + '"' : 'NOT FOUND');
  console.log('2x3:', s2x3v ? s2x3v.id + ' "' + s2x3v.label + '"' : 'NOT FOUND');
  console.log('3x4:', s3x4v ? s3x4v.id + ' "' + s3x4v.label + '"' : 'NOT FOUND');
  console.log('4x2:', s4x2h ? s4x2h.id + ' "' + s4x2h.label + '"' : 'NOT FOUND');

  async function probe(label, shapeId, sizeId) {
    const url = BASE + '?shape=' + shapeId + '&size=' + sizeId + '&paper=12&finish=3';
    const r = await page.evaluate(async (u) => {
      const resp = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return { status: resp.status, body: await resp.text() };
    }, url);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const items = d.items || [];
      const table = items.map(e => 'qty' + e.quantity + '=$' + e.markupPrice).join(', ');
      console.log('  ' + label + ' (shape=' + shapeId + ' size=' + sizeId + '): ' + table);
      return items;
    } else {
      console.log('  ' + label + ': HTTP ' + r.status + ' ' + r.body.slice(0, 150));
      return null;
    }
  }

  console.log('\n=== Pricing probes ===');
  const results = {};

  if (s2x2) results['2x2'] = await probe('2x2 Rounded Square', 4, s2x2.id);
  if (s1x1) results['1x1'] = await probe('1x1 Rounded Square', 4, s1x1.id);
  if (s4x4) results['4x4'] = await probe('4x4 Rounded Square', 4, s4x4.id);

  // Rectangle sizes — try shape 15 (Rectangle) and shape 5 (Rounded Rectangle)
  if (s2x3v) {
    results['2x3-rect']   = await probe('2x3 Rectangle', 15, s2x3v.id);
    results['2x3-rrect']  = await probe('2x3 Rounded Rectangle', 5, s2x3v.id);
  }
  if (s3x4v) {
    results['3x4-rect']  = await probe('3x4 Rectangle', 15, s3x4v.id);
  }
  if (s4x2h) {
    results['4x2-rect']  = await probe('4x2 Rectangle', 15, s4x2h.id);
    results['4x2-rrect'] = await probe('4x2 Rounded Rectangle', 5, s4x2h.id);
  }

  // Print size IDs we found
  console.log('\n=== Summary for data file updates ===');
  console.log(JSON.stringify({
    sizeIds: {
      '1x1': s1x1?.id,
      '2x2': s2x2?.id,
      '4x4': s4x4?.id,
      '2x3': s2x3v?.id,
      '3x4': s3x4v?.id,
      '4x2': s4x2h?.id,
    },
    priceData: Object.fromEntries(
      Object.entries(results)
        .filter(([, items]) => items)
        .map(([k, items]) => [k, Object.fromEntries(items.map(e => [e.quantity, parseFloat(e.markupPrice)]))])
    )
  }, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e.message + '\n' + e.stack); process.exit(1); });
