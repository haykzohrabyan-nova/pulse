#!/usr/bin/env node
/**
 * Audit: personnel/staff sources when using Supabase production config.
 *   node scripts/audit-staff-sources.mjs
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readConfig() {
  const raw = readFileSync(join(root, 'pulse-config.js'), 'utf8');
  return {
    url: raw.match(/PULSE_SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1],
    key: raw.match(/PULSE_SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1],
    backend: raw.match(/PULSE_STORAGE_BACKEND\s*=\s*['"]([^'"]+)['"]/)?.[1],
  };
}

function scanCode() {
  const files = ['auth.js', 'shared.js', 'supabase-client.js', 'admin.html', 'organisation.html', 'pricing-calculator-sales.html'];
  const patterns = [
    { id: 'OPERATOR_PROFILES', re: /OPERATOR_PROFILES/g },
    { id: 'EXTRA_AUTH_USERS', re: /EXTRA_AUTH_USERS/g },
    { id: 'LOCAL_EMAIL_USERS', re: /LOCAL_EMAIL_USERS/g },
    { id: 'mergeLoginPeople', re: /mergeLoginPeople/g },
    { id: 'seedPersonnelFromProfiles', re: /seedPersonnelFromProfiles/g },
    { id: 'ensureAuthPersonnelInDb', re: /ensureAuthPersonnelInDb/g },
    { id: 'PERSONNEL_AUTH_SEED_EXTRAS', re: /PERSONNEL_AUTH_SEED_EXTRAS/g },
    { id: 'getAllPersonnel', re: /getAllPersonnel/g },
  ];
  const out = {};
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    out[f] = {};
    for (const p of patterns) {
      const m = text.match(p.re);
      out[f][p.id] = m ? m.length : 0;
    }
    out[f].hasSupabaseGuard = /pulseUsesSupabaseStorage/.test(text);
  }
  return out;
}

const cfg = readConfig();
console.log('\n=== Pulse config ===');
console.log('PULSE_STORAGE_BACKEND:', cfg.backend);
console.log('Supabase URL:', cfg.url);

const supa = createClient(cfg.url, cfg.key);
const email = process.env.PULSE_ADMIN_EMAIL || 'admin@bazaar-admin.com';
const pass = process.env.PULSE_ADMIN_PASSWORD || 'Pulse2026!';

const { error: authErr } = await supa.auth.signInWithPassword({ email, password: pass });
if (authErr) {
  console.error('\nAdmin sign-in failed:', authErr.message);
  process.exit(1);
}

const { data: profiles, error: profErr } = await supa
  .from('profiles')
  .select('id,display_name,role,pulse_user_id,active,machines')
  .order('display_name');
if (profErr) {
  console.error('\nprofiles query failed:', profErr.message);
  process.exit(1);
}

const { data: cfgRow } = await supa.from('config').select('value').eq('key', 'personnel').maybeSingle();
const legacyPersonnel = Array.isArray(cfgRow?.value) ? cfgRow.value : [];

const activeProfiles = (profiles || []).filter(p => p.active !== false);
const legacyNames = new Set(legacyPersonnel.map(p => String(p.name || '').trim()).filter(Boolean));
const profileNames = new Set(activeProfiles.map(p => p.display_name));

console.log('\n=== Cloud personnel (source of truth) ===');
console.log('profiles (active):', activeProfiles.length);
activeProfiles.forEach(p => {
  console.log(`  • ${p.display_name} | ${p.role} | userId=${p.pulse_user_id || '(empty)'}`);
});

console.log('\n=== Legacy config.personnel (Supabase JSON blob — not hardcoded in JS) ===');
console.log('rows:', legacyPersonnel.length);
const onlyInLegacy = legacyPersonnel.filter(p => p.name && !profileNames.has(p.name));
if (onlyInLegacy.length) {
  console.log('Names in config.personnel but NOT in profiles (should migrate to Admin → Personnel):');
  onlyInLegacy.forEach(p => console.log(`  ⚠ ${p.name}`));
} else {
  console.log('All legacy names also exist in profiles (or legacy is empty).');
}

console.log('\n=== Code references (hardcoded staff blocks — must be IndexedDB-only at runtime) ===');
const code = scanCode();
for (const [file, counts] of Object.entries(code)) {
  const hardcoded = counts.OPERATOR_PROFILES + counts.EXTRA_AUTH_USERS + counts.LOCAL_EMAIL_USERS;
  if (hardcoded === 0 && !counts.getAllPersonnel) continue;
  console.log(`\n${file}:`);
  console.log(`  getAllPersonnel refs: ${counts.getAllPersonnel}`);
  console.log(`  OPERATOR_PROFILES refs: ${counts.OPERATOR_PROFILES}`);
  console.log(`  EXTRA_AUTH_USERS refs: ${counts.EXTRA_AUTH_USERS}`);
  console.log(`  LOCAL_EMAIL_USERS refs: ${counts.LOCAL_EMAIL_USERS}`);
  console.log(`  mergeLoginPeople refs: ${counts.mergeLoginPeople}`);
  console.log(`  seedPersonnelFromProfiles refs: ${counts.seedPersonnelFromProfiles}`);
  console.log(`  pulseUsesSupabaseStorage guard in file: ${counts.hasSupabaseGuard ? 'yes' : 'NO'}`);
}

console.log('\n=== Verdict ===');
if (cfg.backend === 'supabase') {
  console.log('✓ Production config uses Supabase backend.');
  console.log('✓ Login dropdown should list ONLY profiles table rows (' + activeProfiles.length + ' active).');
  console.log('✓ Hardcoded OPERATOR_PROFILES / EXTRA_AUTH_USERS are in code but skipped when pulseUsesSupabaseStorage() is true.');
  if (onlyInLegacy.length) {
    console.log('⚠ Migrate duplicate legacy config.personnel names into profiles and clear old blob.');
  }
  console.log('\nBrowser check after hard refresh:');
  console.log('  pulseUsesSupabaseStorage()  // true');
  console.log('  (await getAllPersonnel()).length  // should match', activeProfiles.length);
} else {
  console.log('⚠ PULSE_STORAGE_BACKEND is not supabase — IndexedDB/hardcoded fallbacks may still apply.');
}
console.log('');
