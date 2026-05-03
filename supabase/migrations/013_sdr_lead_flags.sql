-- =============================================================================
-- PUL-685: Pulse V3 — Digital SDR Dashboard
-- Migration 013: Lead flags + channel enum expansion
-- Target: Supabase/Postgres (project: pulse.bazaar-admin.com)
-- Generated: 2026-05-03
-- =============================================================================
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- If your migration runner wraps in BEGIN/COMMIT, run the ALTER TYPE
-- statements separately first (they auto-commit), then run the rest.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend lead_source enum with channels from V3 Digital SDR spec
-- Spec channels: email, web, IG, FB, SMS, phone, voicemail
-- Existing values: walk_in, phone, email, instagram, website, referral, repeat, other
-- Net-new: facebook, sms, voicemail
-- ---------------------------------------------------------------------------

ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'facebook';
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'sms';
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'voicemail';

-- ---------------------------------------------------------------------------
-- 2. Add SDR dashboard flags to leads table
--
--   is_hostile:    TRUE when lead has used threatening/abusive language.
--                  Triggers the Escalation Widget on the SDR dashboard.
--                  SDR (or admin) sets this on the lead detail page.
--
--   is_high_value: TRUE when the lead is associated with a known high-value
--                  account (customer with significant order history or manual
--                  flag by manager). Triggers gold-flag in the SDR queue.
-- ---------------------------------------------------------------------------

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_hostile    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_high_value BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial indexes: only index rows where flags are true (rare, fast lookups)
CREATE INDEX IF NOT EXISTS leads_hostile_idx    ON leads(id)         WHERE is_hostile    = TRUE;
CREATE INDEX IF NOT EXISTS leads_high_value_idx ON leads(created_at) WHERE is_high_value = TRUE;

-- ---------------------------------------------------------------------------
-- 3. RLS — existing leads policies already cover new columns (no new policies
--    needed; the columns inherit the table-level SELECT/UPDATE policies from
--    migration 002_rls_policies.sql)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Schema documentation update (inline comment for SCHEMA.md reference)
-- New columns on leads:
--   is_hostile    BOOLEAN DEFAULT FALSE  — escalation flag for hostile leads
--   is_high_value BOOLEAN DEFAULT FALSE  — gold-flag for high-value accounts
-- New lead_source enum values: facebook, sms, voicemail
-- ---------------------------------------------------------------------------
