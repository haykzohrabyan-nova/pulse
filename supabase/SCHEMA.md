# Pulse — Supabase Schema Documentation

**Project:** Pulse Production Management System  
**Supabase project domain:** pulse.bazaar-admin.com  
**Generated:** 2026-04-27 (PRI-236)

---

## Overview

Pulse migrates from a browser-local IndexedDB app to a shared Supabase/Postgres backend. All data lives in Supabase. Files (artwork, proofs, QC photos) live in Cloudflare R2 private storage — Supabase stores only the R2 key and metadata.

**Key rules:**
- No anonymous access to any table
- Service role key NEVER goes to the frontend
- All secrets (DB password, R2 keys) live in project env secrets / Supabase Vault
- RLS enforces per-role access at the row level

---

## Migration Files

| File | Purpose |
|------|---------|
| `migrations/001_initial_schema.sql` | Enums, all 20 tables, indexes, updated_at triggers, auth trigger |
| `migrations/002_rls_policies.sql` | Enable RLS + all row-level security policies + realtime publication |
| `rollback/001_rollback.sql` | Full teardown — drops everything in safe order |
| `seed.sql` | Reference data: 20 machines, 18 workflow templates, 33 materials, 4 config keys |

### How to apply

```bash
# 1. Link to your Supabase project
supabase link --project-ref <your-project-ref>

# 2. Apply migrations in order
supabase db push
# OR manually:
psql "$DATABASE_URL" -f supabase/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -f supabase/migrations/002_rls_policies.sql

# 3. Load seed data
psql "$DATABASE_URL" -f supabase/seed.sql
```

### How to rollback

```bash
psql "$DATABASE_URL" -f supabase/rollback/001_rollback.sql
```

---

## Entity Relationship Summary

```
auth.users (Supabase built-in)
  └── profiles (1:1 — created by trigger on signup)
        ├── orders (created_by)
        ├── operator_sessions (operator_id)
        ├── operator_points (operator_id)
        └── activity_log (actor_id)

customers
  └── orders (customer_id)
        ├── order_workflow_steps (order_id)
        ├── order_status_history (order_id)
        ├── order_files (order_id) → R2 bucket
        ├── order_comments (order_id)
        ├── qc_records (order_id)
        └── activity_log (order_id)

machines
  └── machine_issues (machine_id)

workflow_templates (step definitions stored as JSONB steps[])

dies (customer_id → customers)

materials
  └── inventory (material_id, per facility)
        └── inventory_usage (inventory_id, order_id)

purchase_orders
  └── purchase_order_items (po_id, material_id)

invoices (order_id, customer_id)
  └── invoice_line_items (invoice_id)

operator_sessions (operator_id → profiles)
  └── operator_breaks (session_id)

knowledge_base (machine/material/operation alerts)
config (key/value app settings)
```

---

## Table Reference

### `profiles`
Extends `auth.users`. Created automatically on signup.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | FK → auth.users |
| display_name | TEXT | Shown in all UI |
| role | user_role | admin/supervisor/production_manager/account_manager/operator/prepress/david_review |
| facility | facility | 16th-street / boyd-street |
| machines | TEXT[] | Which machines they operate |
| active | BOOL | Soft delete for ex-staff |

### `orders`
Central entity. One row = one job ticket.

| Column | Type | Notes |
|--------|------|-------|
| order_id | TEXT UNIQUE | e.g. "17901", "17901_1" for sub-tickets |
| customer_name | TEXT | Denormalized for display |
| status | order_status | Full lifecycle enum (15 statuses) |
| facility | facility | Which location handles this job |
| workflow_template | TEXT | FK name into workflow_templates |
| current_step | INT | Index into order_workflow_steps |
| is_reprint | BOOL | Links to original via reprint_of_order_id |

**Order status lifecycle:**
```
new → pending-review → pending-confirmation → waiting-approval
  → prepress → prepress-active → prepress-paused
  → in-production → qc-checkout
  → ready-to-ship → shipped → received
  OR → on-hold (from any status) → (previous status)
  OR → completed / cancelled
```

### `order_workflow_steps`
One row per production step per order. Steps are numbered by `step_index`.

| Column | Type | Notes |
|--------|------|-------|
| order_id | UUID | FK → orders |
| step_index | INT | 0-based, unique per order |
| machine | TEXT | Machine name (must match machines.name) |
| status | step_status | pending / in-progress / completed / skipped |
| operator_id | UUID | Who is assigned at this step |

### `order_files`
File metadata only. Bytes live in Cloudflare R2 private bucket.

| Column | Type | Notes |
|--------|------|-------|
| r2_key | TEXT UNIQUE | Bucket key. Backend generates presigned URL per request. |
| category | file_category | artwork / proof / prepress / qc / shipping / other |
| size_bytes | BIGINT | Can be up to 2–5 GB for customer artwork |

**R2 access pattern:**  
Frontend requests a presigned URL from an Edge Function — NEVER sends R2 credentials to the browser.

### `activity_log`
Immutable append-only audit trail. No UPDATE or DELETE policies exist.

### `operator_sessions` + `operator_breaks`
California labor law compliance. Tracks clock-in/out and meal/rest breaks.  
`violation_flag = TRUE` when meal break rules are not met.

---

## Enums

| Enum | Values |
|------|--------|
| `user_role` | admin, supervisor, production_manager, account_manager, operator, prepress, david_review |
| `facility` | 16th-street, boyd-street |
| `order_status` | new, pending-review, pending-confirmation, waiting-approval, prepress, prepress-active, prepress-paused, in-production, qc-checkout, ready-to-ship, shipped, received, on-hold, completed, cancelled |
| `step_status` | pending, in-progress, completed, skipped |
| `die_status` | existing, new-ordered, none |
| `die_condition` | active, damaged, retired |
| `po_status` | draft, sent, confirmed, shipped, received, cancelled |
| `invoice_status` | draft, sent, paid, overdue, cancelled |
| `file_category` | artwork, proof, prepress, qc, shipping, other |
| `alert_severity` | warning, critical |
| `reprint_reason` | shortage, quality, damage, customer_request, other |

---

## RLS Policy Summary

| Table | Anonymous | operator | prepress | account_manager | production_manager | supervisor | admin |
|-------|-----------|----------|----------|-----------------|-------------------|------------|-------|
| profiles | ✗ | own only | own only | own only | read+edit own | read all | full |
| orders | ✗ | facility read | prepress status read | own orders r/w | facility r/w | all r/w | full |
| order_files | ✗ | read | read | read+upload | read+upload | read+upload | full |
| order_comments | ✗ | read+own write | read+own write | read+own write | read+own write | read+own write | full |
| activity_log | ✗ | read | read | read | read | read | read (no delete) |
| operator_sessions | ✗ | own only | - | - | read all | read+edit all | full |
| purchase_orders | ✗ | - | - | - | read+write | read+write | full |
| invoices | ✗ | - | - | own customers | - | all | full |
| config | ✗ | read | read | read | read | read | full |

**Anonymous = Supabase anon key users** — blocked on all tables.

---

## Realtime Tables

These tables have `supabase_realtime` publication enabled:
- `orders` — for live dashboard/kanban updates
- `order_workflow_steps` — for operator terminal live step tracking
- `order_comments` — for live threaded discussion
- `activity_log` — for live audit feed
- `operator_sessions` — for clock-in/out visibility to supervisors

---

## Backup Strategy

Supabase managed Postgres includes daily automated backups (Point-in-Time Recovery on Pro plan).

### Recommended additional backup steps:
1. **Enable PITR** on the Supabase Pro plan — target 7-day recovery window.
2. **Weekly pg_dump to R2** — add a cron Edge Function that runs `pg_dump` and stores the gzipped dump to a dedicated `pulse-backups` R2 bucket.
3. **R2 versioning** — enable R2 object versioning on the main file bucket so file deletions are recoverable for 30 days.
4. **Staging environment** — pulse-staging.bazaar-admin.com runs against a separate Supabase project (never shares the prod DB). Staging migrations are applied and tested before prod.

### Backup cron SQL (reference — run as scheduled Edge Function):
```sql
-- This runs as a superuser Supabase Edge Function via pg_dump subprocess
-- Output: gs://pulse-backups/YYYY-MM-DD/pulse-full.sql.gz
-- Retention: 30 days (lifecycle rule on bucket)
```

---

## Security Notes

1. **Service role key** — stored only in Supabase Vault / Edge Function env. Never in frontend JS.
2. **Anon key** — safe to use in frontend, but every table has RLS that blocks unauthenticated access.
3. **R2 credentials** — stored only in Cloudflare Worker / Supabase Edge Function env vars.
4. **Presigned URLs** — R2 presigned URLs expire in 1 hour. Generated server-side (Edge Function), never from the browser.
5. **RLS bypass** — only service role bypasses RLS. No stored procedures with `SECURITY DEFINER` that accept untrusted user input without validation.
6. **david_review role** — read-only access to all orders. Cannot write any data.

---

## Known Gaps (to address in follow-up tickets)

| Gap | Tracked In |
|-----|-----------|
| Auth integration (Supabase Auth flows, invite flow) | PRI-238 |
| Migrate existing IndexedDB data to Postgres | PRI-239 |
| Edge Functions for R2 presigned URLs | Follow-up D2 ticket |
| Supabase Vault setup for secrets | PRI-235 |
| Staging environment provisioning | PRI-235 |
| Realtime subscription client implementation | PRI-239+ |
