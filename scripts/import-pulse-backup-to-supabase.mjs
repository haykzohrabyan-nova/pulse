#!/usr/bin/env node
/**
 * Import Pulse Admin Export JSON → Supabase (dies, knowledge, organisation, optional config).
 *
 * Usage:
 *   PULSE_ADMIN_EMAIL=admin@bazaar-admin.com PULSE_ADMIN_PASSWORD='...' \
 *   node scripts/import-pulse-backup-to-supabase.mjs \
 *     --file /path/to/pulse-full-backup-2026-06-09.json
 *
 * Flags:
 *   --dry-run       Count only, no writes
 *   --force-config  Upsert config keys even when cloud already has data
 *   --verbose
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIE_META = '\n---PULSE_DIE_META---\n';

function parseArgs(argv) {
  const out = { dryRun: false, forceConfig: false, verbose: false, file: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force-config') out.forceConfig = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--file') out.file = argv[++i];
    else if (!a.startsWith('-') && !out.file) out.file = a;
  }
  return out;
}

function loadPulseConfig() {
  const raw = readFileSync(join(root, 'pulse-config.js'), 'utf8');
  const url = raw.match(/PULSE_SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1] || process.env.PULSE_SUPABASE_URL;
  const key = raw.match(/PULSE_SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1] || process.env.PULSE_SUPABASE_ANON_KEY;
  return { url, key };
}

function packDieDescription(desc, meta) {
  const base = String(desc || '').split(DIE_META)[0].trim();
  const extras = {};
  for (const k of ['die_type', 'template_pdf', 'notes', 'photos_url', 'cut_sizes']) {
    if (meta[k] != null && meta[k] !== '') extras[k] = meta[k];
  }
  if (!Object.keys(extras).length) return base || null;
  return (base ? base + '\n' : '') + DIE_META + JSON.stringify(extras);
}

function dieConditionFromLocal(d) {
  const s = String(d.condition || d.status || 'active').toLowerCase();
  if (s === 'damaged') return 'damaged';
  if (s === 'retired') return 'retired';
  return 'active';
}

function dieToRow(d) {
  const dieNumber = String(d.dieNumber || d.die_number || d.n || '').trim();
  const barcode = String(d.barcode || d.barcodeValue || `DIE-${dieNumber}`).trim();
  return {
    die_number: dieNumber,
    barcode,
    customer_name: d.customer || d.customerName || d.customer_name || 'Unknown',
    machine: d.machine || d.machineName || 'Unknown',
    description: packDieDescription(d.description || d.name || '', {
      die_type: d.die_type,
      template_pdf: d.template_pdf,
      notes: d.notes,
      photos_url: d.photos_url,
      cut_sizes: d.cut_sizes,
    }),
    condition: dieConditionFromLocal(d),
    usage_count: d.usageCount ?? d.usage_count ?? 0,
    last_used_at: d.lastUsed || d.last_used_at || null,
  };
}

function knowledgeToRow(k) {
  const title = k.title || k.name;
  if (!title) return null;
  const sev = String(k.severity || 'warning').toLowerCase();
  return {
    machine: k.machine || null,
    machines: Array.isArray(k.machines) ? k.machines : (k.machine ? [k.machine] : []),
    material: k.material || null,
    operation: k.operation || null,
    title,
    description: k.description || k.message || '',
    fix: k.fix || null,
    severity: sev === 'critical' ? 'critical' : 'warning',
    operators: Array.isArray(k.operators) ? k.operators : [],
    active: k.active !== false,
  };
}

function collectDies(payload) {
  const fromIdb = payload.indexedDB?.dies;
  const fromAdmin = payload.admin?.dies;
  const list = Array.isArray(fromIdb) && fromIdb.length ? fromIdb : (fromAdmin || []);
  return list.filter(d => String(d.dieNumber || d.die_number || d.n || '').trim());
}

function collectKnowledge(payload) {
  return (payload.indexedDB?.knowledge_base || []).filter(k => k.title || k.name);
}

async function importDies(supa, dies, report, dryRun) {
  report.dies = { upserted: 0, skipped: 0, errors: [] };
  for (const d of dies) {
    const row = dieToRow(d);
    if (!row.die_number || !row.barcode) {
      report.dies.skipped++;
      continue;
    }
    if (dryRun) {
      report.dies.upserted++;
      continue;
    }
    const { error } = await supa.from('dies').upsert(row, { onConflict: 'die_number' });
    if (error) report.dies.errors.push({ item: row.die_number, error: error.message });
    else report.dies.upserted++;
  }
}

async function importKnowledge(supa, rows, report, dryRun) {
  report.knowledge_base = { inserted: 0, skipped: 0, errors: [] };
  const keys = new Set();
  if (!dryRun) {
    const { data: existing } = await supa.from('knowledge_base').select('id, title, machine');
    for (const r of existing || []) keys.add(`${r.title}::${r.machine || ''}`);
  }

  for (const k of rows) {
    const row = knowledgeToRow(k);
    if (!row) continue;
    const key = `${row.title}::${row.machine || ''}`;
    if (keys.has(key)) {
      report.knowledge_base.skipped++;
      continue;
    }
    if (dryRun) {
      report.knowledge_base.inserted++;
      continue;
    }
    const { error } = await supa.from('knowledge_base').insert(row);
    if (error) report.knowledge_base.errors.push({ item: row.title, error: error.message });
    else {
      report.knowledge_base.inserted++;
      keys.add(key);
    }
  }
}

async function importOrganisation(supa, bundle, report, dryRun) {
  report.organisation = { updated: 0, errors: [] };
  if (!bundle?.organisation) return;

  const norm = bundle;
  const orgMeta = norm.organisation || {};
  let orgId = null;

  if (dryRun) {
    report.organisation.updated = (norm.facilities || []).length;
    return;
  }

  const { data: existingOrg } = await supa.from('organisations').select('id').limit(1);
  orgId = existingOrg?.[0]?.id;

  if (!orgId && !dryRun) {
    const { data: created, error } = await supa.from('organisations').insert({
      name: orgMeta.name || 'Bazaar Print',
      short_description: orgMeta.short_description || orgMeta.shortDescription || '',
      website_url: orgMeta.website_url || orgMeta.websiteUrl || null,
      logo_url: orgMeta.logo_url || orgMeta.logoUrl || null,
    }).select('id').single();
    if (error) {
      report.organisation.errors.push({ item: 'organisations', error: error.message });
      return;
    }
    orgId = created.id;
  } else if (orgId && !dryRun) {
    const { error } = await supa.from('organisations').update({
      name: orgMeta.name || 'Bazaar Print',
      short_description: orgMeta.short_description || orgMeta.shortDescription || '',
      website_url: orgMeta.website_url || orgMeta.websiteUrl || null,
      logo_url: orgMeta.logo_url || orgMeta.logoUrl || null,
    }).eq('id', orgId);
    if (error) report.organisation.errors.push({ item: 'organisations', error: error.message });
  }

  if (!orgId) {
    report.organisation.updated = (norm.facilities || []).length;
    return;
  }

  const slugToFacId = new Map();
  for (const fac of norm.facilities || []) {
    const slug = String(fac.slug || '').trim();
    if (!slug) continue;
    if (dryRun) {
      report.organisation.updated++;
      continue;
    }
    const payload = {
      organisation_id: orgId,
      slug,
      name: fac.name || slug,
      description: fac.description || '',
      sort_order: fac.sort_order ?? fac.sortOrder ?? 0,
    };
    const { data: found } = await supa.from('organisation_facilities')
      .select('id').eq('organisation_id', orgId).eq('slug', slug).maybeSingle();
    if (found?.id) {
      const { error } = await supa.from('organisation_facilities').update(payload).eq('id', found.id);
      if (error) report.organisation.errors.push({ item: slug, error: error.message });
      else slugToFacId.set(slug, found.id);
    } else {
      const { data: ins, error } = await supa.from('organisation_facilities').insert(payload).select('id').single();
      if (error) report.organisation.errors.push({ item: slug, error: error.message });
      else slugToFacId.set(slug, ins.id);
    }
    report.organisation.updated++;
  }

  for (const fac of norm.facilities || []) {
    const facId = slugToFacId.get(String(fac.slug || '').trim()) || fac.id;
    const list = norm.hardwareByFacilityId?.[fac.id] || norm.hardwareByFacilityId?.[facId] || [];
    for (const h of list) {
      const machineName = h.machine_name || h.machineName;
      if (!facId || !machineName) continue;
      if (dryRun) continue;
      const hw = {
        facility_id: facId,
        machine_name: machineName,
        operations: Array.isArray(h.operations) ? h.operations : [],
        daily_capacity_value: h.daily_capacity_value ?? h.dailyCapacity?.value ?? null,
        daily_capacity_unit: h.daily_capacity_unit || h.dailyCapacity?.unit || null,
        notes: h.notes || '',
        sort_order: h.sort_order ?? h.sortOrder ?? 0,
        active: h.active !== false,
      };
      const { data: exists } = await supa.from('organisation_hardware')
        .select('id').eq('facility_id', facId).eq('machine_name', machineName).maybeSingle();
      if (exists?.id) {
        await supa.from('organisation_hardware').update(hw).eq('id', exists.id);
      } else {
        await supa.from('organisation_hardware').insert(hw);
      }
    }
  }
}

async function importConfigKeys(supa, payload, report, dryRun, forceConfig) {
  report.config = { upserted: 0, skipped: 0, errors: [] };
  const entries = Array.isArray(payload.config) ? payload.config : [];
  const catalog = payload.catalog || payload.admin?.products || null;

  const upsert = async (key, value) => {
    if (value === undefined) return;
    if (!forceConfig && !dryRun) {
      const { data } = await supa.from('config').select('key').eq('key', key).maybeSingle();
      if (data?.key) {
        report.config.skipped++;
        return;
      }
    }
    if (dryRun) {
      report.config.upserted++;
      return;
    }
    const { error } = await supa.from('config').upsert({ key, value }, { onConflict: 'key' });
    if (error) report.config.errors.push({ item: key, error: error.message });
    else report.config.upserted++;
  };

  for (const row of entries) {
    if (row?.key) await upsert(row.key, row.value);
  }
  if (catalog) {
    if (catalog.colorModes) await upsert('catalogColorModes', catalog.colorModes);
    if (catalog.materials) await upsert('catalogMaterials', catalog.materials);
    if (catalog.finishing) await upsert('catalogFinishing', catalog.finishing);
    if (catalog.products) await upsert('productCatalog', catalog.products);
  }
  if (Array.isArray(payload.admin?.personnel)) {
    await upsert('personnel', payload.admin.personnel);
  }
}

async function importConfigJsonArray(supa, key, rows, report, dryRun, label) {
  report[label] = { upserted: 0, skipped: 0, errors: [] };
  if (!Array.isArray(rows) || !rows.length) return;
  if (!dryRun) {
    const { data } = await supa.from('config').select('key').eq('key', key).maybeSingle();
    if (data?.key) {
      report[label].skipped = rows.length;
      return;
    }
    const { error } = await supa.from('config').upsert({ key, value: rows }, { onConflict: 'key' });
    if (error) report[label].errors.push({ item: key, error: error.message });
    else report[label].upserted = rows.length;
  } else {
    report[label].upserted = rows.length;
  }
}

async function importOperatorSessions(supa, rows, report, dryRun) {
  report.operator_sessions = { inserted: 0, skipped: 0, errors: [] };
  for (const s of rows || []) {
    const name = s.operatorName || s.operator_name;
    if (!name) continue;
    const row = {
      operator_name: name,
      session_date: s.date || s.session_date || new Date().toISOString().slice(0, 10),
      clock_in: s.clockIn || s.clock_in || new Date().toISOString(),
      clock_out: s.clockOut || s.clock_out || null,
      total_work_minutes: s.totalWorkMinutes ?? s.total_work_minutes ?? null,
      violation_flag: !!s.violationFlag || !!s.violation_flag,
      points_earned: s.points ?? s.points_earned ?? 0,
      notes: s.notes || null,
    };
    if (dryRun) { report.operator_sessions.inserted++; continue; }
    const { error } = await supa.from('operator_sessions').insert(row);
    if (error) report.operator_sessions.errors.push({ item: name, error: error.message });
    else report.operator_sessions.inserted++;
  }
}

async function importOperatorPoints(supa, rows, report, dryRun) {
  report.operator_points = { inserted: 0, skipped: 0, errors: [] };
  for (const p of rows || []) {
    const row = {
      operator_name: p.operatorName || p.operator_name || 'Unknown',
      earned_date: p.date || p.earned_date || new Date().toISOString().slice(0, 10),
      points: p.points ?? 0,
      reason: p.reason || p.type || 'import',
    };
    if (dryRun) { report.operator_points.inserted++; continue; }
    const { error } = await supa.from('operator_points').insert(row);
    if (error) report.operator_points.errors.push({ item: row.operator_name, error: error.message });
    else report.operator_points.inserted++;
  }
}

async function importPurchaseOrders(supa, rows, report, dryRun) {
  report.purchase_orders = { inserted: 0, skipped: 0, errors: [] };
  for (const po of rows || []) {
    const poNumber = po.poNumber || po.po_number;
    if (!poNumber) continue;
    if (dryRun) { report.purchase_orders.inserted++; continue; }
    const { data: exists } = await supa.from('purchase_orders').select('id').eq('po_number', poNumber).maybeSingle();
    if (exists?.id) { report.purchase_orders.skipped++; continue; }
    const { data, error } = await supa.from('purchase_orders').insert({
      po_number: poNumber,
      vendor: po.vendor || 'Unknown',
      status: po.status || 'draft',
      expected_date: po.expectedDelivery || po.expected_date || null,
      actual_date: po.actualDelivery || po.actual_date || null,
    }).select('id').single();
    if (error) {
      report.purchase_orders.errors.push({ item: poNumber, error: error.message });
      continue;
    }
    if (po.vendorEmail) {
      const { data: cfg } = await supa.from('config').select('value').eq('key', 'pulse_po_extras').maybeSingle();
      const map = cfg?.value && typeof cfg.value === 'object' ? cfg.value : {};
      map[data.id] = { vendorEmail: po.vendorEmail };
      await supa.from('config').upsert({ key: 'pulse_po_extras', value: map }, { onConflict: 'key' });
    }
    for (const item of po.items || []) {
      await supa.from('purchase_order_items').insert({
        po_id: data.id,
        material_name: item.material || item.material_name || 'Material',
        quantity: item.quantity ?? 0,
        unit: item.unit || 'sheets',
        unit_cost: item.unitCost ?? item.unit_cost ?? null,
      });
    }
    report.purchase_orders.inserted++;
  }
}

async function importLocalStorageToConfig(supa, ls, report, dryRun, forceConfig) {
  report.localStorage = { upserted: 0, skipped: 0, errors: [] };
  if (!ls || typeof ls !== 'object') return;
  const map = {
    pulse_pricing_rates_v1: 'pulsePricingRates',
    pulse_notification_memory: 'pulse_notification_memory',
    pulse_qa_rules: 'pulseQARules',
    pulse_role_overrides: 'rolePermissions',
  };
  for (const [lsKey, cfgKey] of Object.entries(map)) {
    if (!(lsKey in ls)) continue;
    let value = ls[lsKey];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) {}
    }
    if (!forceConfig) {
      const { data } = await supa.from('config').select('key').eq('key', cfgKey).maybeSingle();
      if (data?.key) { report.localStorage.skipped++; continue; }
    }
    if (dryRun) { report.localStorage.upserted++; continue; }
    const { error } = await supa.from('config').upsert({ key: cfgKey, value }, { onConflict: 'key' });
    if (error) report.localStorage.errors.push({ item: cfgKey, error: error.message });
    else report.localStorage.upserted++;
  }
}

function printReport(report, dryRun) {
  console.log(dryRun ? '\n=== DRY RUN SUMMARY ===' : '\n=== IMPORT SUMMARY ===');
  for (const [phase, data] of Object.entries(report)) {
    if (phase === 'errors') continue;
    console.log(`  ${phase}:`, JSON.stringify(data));
  }
  const errCount = Object.values(report).reduce((n, v) => n + (v.errors?.length || 0), 0);
  if (errCount) {
    console.log('\nErrors:');
    for (const v of Object.values(report)) {
      (v.errors || []).forEach(e => console.log(' ', e.item, '-', e.error));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: node scripts/import-pulse-backup-to-supabase.mjs --file path/to/backup.json');
    process.exit(1);
  }

  const filePath = resolve(args.file);
  const payload = JSON.parse(readFileSync(filePath, 'utf8'));
  const { url, key } = loadPulseConfig();
  const email = process.env.PULSE_ADMIN_EMAIL || 'admin@bazaar-admin.com';
  const password = process.env.PULSE_ADMIN_PASSWORD;

  if (!url || !key) {
    console.error('Missing Supabase URL/key in pulse-config.js or env');
    process.exit(1);
  }
  if (!password && !args.dryRun) {
    console.error('Set PULSE_ADMIN_PASSWORD (Supabase Auth password for admin user)');
    process.exit(1);
  }

  const supa = createClient(url, key);
  if (!args.dryRun) {
    const { error: authErr } = await supa.auth.signInWithPassword({ email, password });
    if (authErr) {
      console.error('Auth failed:', authErr.message);
      process.exit(1);
    }
    console.log('Signed in as', email);
  }

  const dies = collectDies(payload);
  const knowledge = collectKnowledge(payload);
  const org = payload.organisation || payload.admin?.organisation || null;

  const idb = payload.indexedDB || {};
  console.log('File:', filePath);
  console.log('Counts in file — dies:', dies.length, 'knowledge:', knowledge.length,
    'orders:', idb.orders?.length ?? 0, 'reprints:', idb.reprints?.length ?? 0,
    'operator_sessions:', idb.operator_sessions?.length ?? 0);

  const report = {};
  await importDies(supa, dies, report, args.dryRun);
  await importKnowledge(supa, knowledge, report, args.dryRun);
  if (org) await importOrganisation(supa, org, report, args.dryRun);
  await importConfigKeys(supa, payload, report, args.dryRun, args.forceConfig);
  await importConfigJsonArray(supa, 'pulse_reprints', idb.reprints, report, args.dryRun, 'reprints');
  await importConfigJsonArray(supa, 'pulse_devices', idb.devices, report, args.dryRun, 'devices');
  await importOperatorSessions(supa, idb.operator_sessions, report, args.dryRun);
  await importOperatorPoints(supa, idb.operator_points, report, args.dryRun);
  await importPurchaseOrders(supa, idb.purchase_orders, report, args.dryRun);
  await importLocalStorageToConfig(supa, payload.localStorage, report, args.dryRun, args.forceConfig);

  printReport(report, args.dryRun);

  if (!args.dryRun) {
    const { count: dieCount } = await supa.from('dies').select('*', { count: 'exact', head: true });
    const { count: kbCount } = await supa.from('knowledge_base').select('*', { count: 'exact', head: true });
    const { count: sessCount } = await supa.from('operator_sessions').select('*', { count: 'exact', head: true });
    console.log('\nCloud now — dies:', dieCount, 'knowledge_base:', kbCount, 'operator_sessions:', sessCount);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
