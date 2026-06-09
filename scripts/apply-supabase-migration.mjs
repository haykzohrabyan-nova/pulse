#!/usr/bin/env node
/**
 * Apply a Supabase SQL migration file to the hosted project.
 *
 * Option A — DATABASE_URL (recommended for one-time setup):
 *   DATABASE_URL='postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres' \
 *   node scripts/apply-supabase-migration.mjs 046_upsert_pulse_personnel_fn.sql
 *
 * Option B — Supabase CLI (linked project):
 *   npx supabase db query --linked -f supabase/migrations/046_upsert_pulse_personnel_fn.sql
 *
 * Option C — Supabase Dashboard → SQL Editor → paste file contents → Run
 */
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] || '046_upsert_pulse_personnel_fn.sql';
const migrationPath = arg.includes('/')
  ? join(root, arg)
  : join(root, 'supabase/migrations', arg);

if (!existsSync(migrationPath)) {
  console.error('Migration not found:', migrationPath);
  process.exit(1);
}

const sql = readFileSync(migrationPath, 'utf8');
const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

console.log('Migration:', basename(migrationPath));

if (dbUrl) {
  console.log('Applying via psql…');
  execSync(`psql ${JSON.stringify(dbUrl)} -v ON_ERROR_STOP=1`, {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('Done.');
  process.exit(0);
}

console.log(`
No DATABASE_URL set — apply manually:

1. Open https://supabase.com/dashboard/project/gkyupebgulpgwugsbvny/sql/new
2. Paste the contents of:
   ${migrationPath}
3. Click Run

Then hard-refresh the app (Cmd+Shift+R) and sign in again.
`);
