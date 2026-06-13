#!/usr/bin/env bash
# Deploy pickup SMS verification: migration + Edge Functions + Twilio secrets.
#
# Prerequisites (one-time):
#   npx supabase login
#   export TWILIO_ACCOUNT_SID=AC...
#   export TWILIO_AUTH_TOKEN=...
#   export TWILIO_PHONE_NUMBER=+1...
#
# Optional — apply migration via psql instead of dashboard:
#   export DATABASE_URL='postgresql://postgres.[ref]:[password]@...pooler.supabase.com:6543/postgres'
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present (handles values with spaces/special chars)
if [[ -f "$ROOT/.env" ]]; then
  eval "$(node -e "
    const fs = require('fs');
    for (const line of fs.readFileSync('$ROOT/.env', 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i);
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('\"') && v.endsWith('\"')) || (v.startsWith(\"'\") && v.endsWith(\"'\"))) v = v.slice(1, -1);
      console.log('export ' + k + '=' + JSON.stringify(v));
    }
  ")"
fi

PROJECT_REF="gkyupebgulpgwugsbvny"
MIGRATION="054_pickup_verifications.sql"

echo "==> Pulse pickup SMS deploy (project: $PROJECT_REF)"
echo

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN is empty in .env"
  echo "Get one at: https://supabase.com/dashboard/account/tokens"
  echo "Or run once: npx supabase login"
  exit 1
fi
export SUPABASE_ACCESS_TOKEN

# ── 1. Migration ─────────────────────────────────────────────────────────────
if [[ "${SKIP_MIGRATION:-}" == "1" ]]; then
  echo "==> Migration skipped (SKIP_MIGRATION=1 — already applied)"
elif [[ -n "${DATABASE_URL:-}" || -n "${SUPABASE_DB_URL:-}" ]]; then
  echo "==> Applying migration via psql…"
  node scripts/apply-supabase-migration.mjs "$MIGRATION"
else
  echo "==> Migration: no DATABASE_URL — trying Management API…"
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    node scripts/apply-migration-via-api.mjs "$MIGRATION"
  else
    echo "    Set SUPABASE_ACCESS_TOKEN or DATABASE_URL, then re-run."
    echo "    Manual SQL: https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
    echo "    File: supabase/migrations/$MIGRATION"
    exit 1
  fi
fi

echo

# ── 2. Twilio secrets (Supabase Edge Functions read these, not Vercel) ───────
if [[ -n "${TWILIO_ACCOUNT_SID:-}" && -n "${TWILIO_AUTH_TOKEN:-}" && -n "${TWILIO_PHONE_NUMBER:-}" ]]; then
  echo "==> Setting Twilio secrets on Supabase…"
  npx supabase secrets set \
    TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
    TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
    TWILIO_PHONE_NUMBER="$TWILIO_PHONE_NUMBER" \
    --project-ref "$PROJECT_REF"
else
  echo "==> Twilio secrets: skipped (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)"
  echo "    Then run:"
  echo "    npx supabase secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_PHONE_NUMBER=... --project-ref $PROJECT_REF"
fi

echo

# ── 3. Edge Functions ────────────────────────────────────────────────────────
echo "==> Deploying Edge Functions…"
npx supabase functions deploy send-pickup-code --project-ref "$PROJECT_REF"
npx supabase functions deploy verify-pickup-code --project-ref "$PROJECT_REF"

echo
echo "==> Done."
echo "    Test: open Shipping → Confirm Pickup → Send Code on a local-pickup order."
