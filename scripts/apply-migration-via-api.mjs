#!/usr/bin/env node
/**
 * Apply a migration via Supabase Management API (no psql required).
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/apply-migration-via-api.mjs 054_pickup_verifications.sql
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const PROJECT_REF = 'gkyupebgulpgwugsbvny';
const token = process.env.SUPABASE_ACCESS_TOKEN;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] || '054_pickup_verifications.sql';
const migrationPath = arg.includes('/')
  ? join(root, arg)
  : join(root, 'supabase/migrations', arg);

if (!token) {
  console.error('Set SUPABASE_ACCESS_TOKEN (https://supabase.com/dashboard/account/tokens)');
  process.exit(1);
}
if (!existsSync(migrationPath)) {
  console.error('Migration not found:', migrationPath);
  process.exit(1);
}

const sql = readFileSync(migrationPath, 'utf8');
console.log('Applying via Management API:', basename(migrationPath));

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
});

const body = await res.text();
if (!res.ok) {
  console.error('Migration failed:', res.status, body);
  process.exit(1);
}

console.log('Migration applied successfully.');
if (body && body !== '[]') console.log(body);
