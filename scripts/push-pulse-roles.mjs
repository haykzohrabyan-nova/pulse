#!/usr/bin/env node
/**
 * Push polished roles from data/pulse-roles-export.json → Supabase config (+ optional profiles.role).
 * Run: node scripts/push-pulse-roles.mjs
 * Requires: linked project (npx supabase link)
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inPath = join(root, 'data', 'pulse-roles-export.json');

const configOnly = process.argv.includes('--config-only');
const data = JSON.parse(readFileSync(inPath, 'utf8'));

function escJson(obj) {
  return JSON.stringify(obj).replace(/'/g, "''");
}

const statements = [];

if (Array.isArray(data.customRoles) && data.customRoles.length) {
  statements.push(`
INSERT INTO config (key, value) VALUES ('customRoles', '${escJson(data.customRoles)}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
`);
}

if (data.rolePermissions && typeof data.rolePermissions === 'object') {
  statements.push(`
INSERT INTO config (key, value) VALUES ('rolePermissions', '${escJson(data.rolePermissions)}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
`);
}

if (Array.isArray(data.personnel)) {
  const rows = data.personnel.map(({ _profileId, _loginRole, ...rest }) => rest);
  statements.push(`
INSERT INTO config (key, value) VALUES ('personnel', '${escJson(rows)}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
`);
}

if (!configOnly && Array.isArray(data.profilesLogin)) {
  for (const p of data.profilesLogin) {
    if (!p.id || !p.role) continue;
    const role = String(p.role).replace(/'/g, "''");
    const facility = p.facility == null ? 'NULL' : `'${String(p.facility).replace(/'/g, "''")}'::facility`;
    const active = p.active === false ? 'false' : 'true';
    statements.push(`
UPDATE profiles SET role = '${role}'::user_role, facility = ${facility}, active = ${active}, updated_at = NOW()
WHERE id = '${p.id}'::uuid;
`);
  }
}

if (!statements.length) {
  console.error('Nothing to push — check', inPath);
  process.exit(1);
}

const sql = `-- pulse-roles push ${new Date().toISOString()}\nBEGIN;\n${statements.join('\n')}\nCOMMIT;\n`;
const tmp = join(tmpdir(), `pulse-roles-push-${Date.now()}.sql`);
writeFileSync(tmp, sql);

try {
  execSync(`npx supabase db query --linked -f ${JSON.stringify(tmp)}`, {
    cwd: root,
    stdio: 'inherit',
  });
  console.log('\nDone. Open Admin → Roles → Save Changes to sync localStorage overrides.');
} finally {
  try { unlinkSync(tmp); } catch (_) {}
}
