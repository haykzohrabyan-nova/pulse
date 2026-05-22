#!/usr/bin/env node
/**
 * Pull roles from linked Supabase + merge auth.js defaults → data/pulse-roles-export.json
 * Run: node scripts/build-roles-export.mjs
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'data', 'pulse-roles-export.json');

const ROLE_CONFIG_DEFAULTS = {
  admin: {
    label: 'Admin',
    color: '#7c3aed',
    pages: ['all'],
    canEditAllTickets: true,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: 'all',
  },
  'david-review': {
    label: 'David Review',
    color: '#2563eb',
    pages: ['dashboard', 'job-ticket', 'pricing-calculator', 'prepress', 'production-manager', 'operator-terminal', 'qc-checkout', 'shipping', 'machine-issues', 'organisation', 'admin'],
    canEditAllTickets: false,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: ['personnel', 'machines', 'dies', 'organisation', 'payment', 'crm-quote', 'products', 'product-workflows', 'roles', 'qa-rules', 'settings', 'backup'],
  },
  supervisor: {
    label: 'Supervisor',
    color: '#0891b2',
    pages: ['dashboard', 'job-ticket', 'pricing-calculator', 'prepress', 'production-manager', 'operator-terminal', 'qc-checkout', 'shipping', 'machine-issues', 'organisation'],
    canEditAllTickets: true,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: true,
  },
  'production-manager': {
    label: 'Production Manager',
    color: '#16a34a',
    pages: ['dashboard', 'job-ticket', 'prepress', 'production-manager', 'operator-terminal', 'qc-checkout', 'shipping', 'machine-issues', 'organisation', 'admin'],
    canEditAllTickets: false,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: ['machines', 'dies', 'organisation', 'products', 'product-workflows'],
  },
  'account-manager': {
    label: 'Account Manager',
    color: '#ea580c',
    pages: ['dashboard', 'job-ticket', 'pricing-calculator', 'crm-quote'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
  sales: {
    label: 'Sales',
    color: '#c2410c',
    pages: ['dashboard', 'job-ticket', 'pricing-calculator', 'crm-quote'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
  shipping: {
    label: 'Shipping',
    color: '#0d9488',
    pages: ['dashboard', 'shipping', 'qc-checkout'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
  operator: {
    label: 'Operator',
    color: '#6b7280',
    pages: ['dashboard', 'operator-terminal', 'machine-issues'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: true,
  },
  prepress: {
    label: 'Prepress',
    color: '#6b7280',
    pages: ['dashboard', 'prepress', 'job-ticket'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: false,
  },
  qc: {
    label: 'QC Inspector',
    color: '#0d9488',
    pages: ['dashboard', 'qc-checkout', 'shipping'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
};

const PAGE_KEYS = [
  'dashboard', 'job-ticket', 'pricing-calculator', 'prepress', 'production-manager',
  'operator-terminal', 'qc-checkout', 'machine-issues', 'shipping', 'organisation', 'admin',
];

function query(sql) {
  const raw = execSync(
    `npx supabase db query --linked --output json ${JSON.stringify(sql)}`,
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const parsed = JSON.parse(raw);
  return parsed.rows || [];
}

function profileRoleToPersonnelKey(role) {
  return String(role || 'operator').replace(/_/g, '-');
}

function toRolePermissions(cfg) {
  const pages = cfg.pages?.includes('all') ? [...PAGE_KEYS] : [...(cfg.pages || [])];
  const out = {
    pages,
    canEditAllTickets: !!cfg.canEditAllTickets,
    canViewAdmin: !!cfg.canViewAdmin,
    canViewProduction: !!cfg.canViewProduction,
    canViewOperator: !!cfg.canViewOperator,
  };
  if (cfg.adminTabs) out.adminTabs = cfg.adminTabs === 'all' ? 'all' : [...cfg.adminTabs];
  return out;
}

function slugUserId(name, index) {
  const base = String(name || 'USR')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3) || 'USR';
  return `${base}${String(1000 + index).slice(-4)}`;
}

const configRows = query(
  "SELECT key, value FROM config WHERE key IN ('customRoles', 'rolePermissions', 'personnel') ORDER BY key;"
);
const profiles = query(
  'SELECT id, display_name, role, facility, phone, active FROM profiles ORDER BY display_name;'
);

const byKey = Object.fromEntries(configRows.map((r) => [r.key, r.value]));

let customRoles = Array.isArray(byKey.customRoles) ? byKey.customRoles : [];
const existingKeys = new Set(customRoles.map((r) => r.key));

for (const [key, cfg] of Object.entries(ROLE_CONFIG_DEFAULTS)) {
  if (!existingKeys.has(key)) {
    customRoles.push({ key, label: cfg.label, color: cfg.color });
    existingKeys.add(key);
  }
}

customRoles.sort((a, b) => a.label.localeCompare(b.label));

const rolePermissions = {};
for (const role of customRoles) {
  const cfg = ROLE_CONFIG_DEFAULTS[role.key];
  if (cfg) rolePermissions[role.key] = toRolePermissions(cfg);
}
if (byKey.rolePermissions && typeof byKey.rolePermissions === 'object') {
  for (const [k, v] of Object.entries(byKey.rolePermissions)) {
    rolePermissions[k] = { ...rolePermissions[k], ...v };
  }
}

let personnel = Array.isArray(byKey.personnel) ? byKey.personnel : [];
if (!personnel.length && profiles.length) {
  personnel = profiles.map((p, i) => ({
    name: p.display_name,
    role: profileRoleToPersonnelKey(p.role),
    userId: slugUserId(p.display_name, i),
    facility: p.facility || '',
    phone: p.phone || '',
    active: p.active !== false,
    _profileId: p.id,
    _loginRole: p.role,
  }));
}

const payload = {
  _meta: {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: 'gkyupebgulpgwugsbvny',
    instructions: [
      'Edit customRoles (dropdown labels/colors), rolePermissions (matrix), personnel (Admin table).',
      'profilesLogin: optional — updates profiles.role for Supabase sign-in (underscore keys: account_manager).',
      'Push: node scripts/push-pulse-roles.mjs',
      'Then Admin → Roles → Save Changes once to refresh localStorage pulse_role_overrides.',
      'Add matching entries to auth.js ROLE_CONFIG for new keys (e.g. sales, account-manager) before deploy.',
    ],
    pageKeys: PAGE_KEYS,
    adminTabKeys: [
      'personnel', 'machines', 'dies', 'organisation', 'payment', 'crm-quote',
      'products', 'product-workflows', 'roles', 'qa-rules', 'settings', 'backup',
    ],
    remoteHad: {
      customRoles: !!byKey.customRoles,
      rolePermissions: !!byKey.rolePermissions,
      personnel: !!byKey.personnel,
    },
  },
  customRoles,
  rolePermissions,
  personnel,
  profilesLogin: profiles.map((p) => ({
    id: p.id,
    display_name: p.display_name,
    role: p.role,
    facility: p.facility,
    active: p.active,
  })),
};

writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log('Wrote', outPath);
console.log('Roles:', customRoles.length, '| Permissions:', Object.keys(rolePermissions).length, '| Personnel:', personnel.length);
