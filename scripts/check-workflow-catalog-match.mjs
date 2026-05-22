#!/usr/bin/env node
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function query(sql) {
  const raw = execSync(
    `npx supabase db query --linked --output json ${JSON.stringify(sql)}`,
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(raw).rows || [];
}

const catalogRow = query("SELECT value FROM config WHERE key = 'productCatalog';")[0];
const products = catalogRow?.value || [];
const wfs = query(
  'SELECT product_catalog_id, product_name, jsonb_array_length(steps) AS steps FROM product_workflows ORDER BY product_name;'
);

const catalogIds = new Set(products.map((p) => p.id));
let match = 0;
for (const w of wfs) {
  if (catalogIds.has(w.product_catalog_id)) match++;
}

console.log('Catalog products:', products.length);
console.log('product_workflows rows:', wfs.length);
console.log('Rows whose product_catalog_id matches live catalog:', match);
console.log('Rows with NO matching catalog product:', wfs.length - match);
console.log('\nCatalog IDs:');
products.forEach((p) => console.log(' ', p.id, p.name));

const orphan = wfs.filter((w) => !catalogIds.has(w.product_catalog_id));
if (orphan.length) {
  console.log('\nOrphan workflows (stale catalog IDs):');
  orphan.forEach((w) => console.log(' ', w.product_catalog_id, w.product_name, 'steps=', w.steps));
}

const missing = products.filter((p) => !wfs.some((w) => w.product_catalog_id === p.id && w.steps > 0));
console.log('\nCatalog products with no workflow steps in SQL:');
missing.forEach((p) => console.log(' ', p.id, p.name));
