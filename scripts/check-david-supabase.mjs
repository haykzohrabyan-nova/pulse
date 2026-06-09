#!/usr/bin/env node
/**
 * Read-only check: David auth/profile + user_role enum on hosted Supabase.
 *   node scripts/check-david-supabase.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'pulse-config.js'), 'utf8');
const url = raw.match(/PULSE_SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1];
const key = raw.match(/PULSE_SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1];

const supa = createClient(url, key);
const email = process.env.PULSE_ADMIN_EMAIL || 'admin@bazaar-admin.com';
const pass = process.env.PULSE_ADMIN_PASSWORD || 'Pulse2026!';

const { error: authErr } = await supa.auth.signInWithPassword({ email, password: pass });
if (authErr) {
  console.error('Admin sign-in failed:', authErr.message);
  process.exit(1);
}

const { data: davidProfiles } = await supa.from('profiles').select('id,display_name,role,pulse_user_id,active').ilike('display_name', '%david%');
const { data: allRoles } = await supa.from('profiles').select('role');
const uniqueRoles = [...new Set((allRoles || []).map(r => r.role))].sort();

const { data: cfg } = await supa.from('config').select('value').eq('key', 'personnel').maybeSingle();
const davidCfg = (cfg?.value || []).filter(p => /david/i.test(p.name || ''));

console.log('\n=== David in profiles table ===');
console.log(davidProfiles?.length ? davidProfiles : '(none — run migration 047)');

console.log('\n=== David in config.personnel (legacy) ===');
console.log(davidCfg.length ? davidCfg : '(none)');

console.log('\n=== Roles currently used in profiles ===');
console.log(uniqueRoles.join(', '));
console.log(uniqueRoles.includes('david_review') ? '✓ david_review in use' : '✗ no profile with david_review yet');

console.log('\n=== David auth login test ===');
const supa2 = createClient(url, key);
for (const pw of ['1111', 'Pulse2026!']) {
  const { error } = await supa2.auth.signInWithPassword({ email: 'david@bazaar-admin.com', password: pw });
  console.log(`  david@bazaar-admin.com / ${pw}:`, error ? error.message : 'OK');
  if (!error) await supa2.auth.signOut();
}

console.log('\nIf David auth fails with "Database error querying schema", run 047c_fix_david_auth_tokens.sql in SQL Editor.\n');
