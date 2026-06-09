#!/usr/bin/env bash
# deploy/smoke-test.sh — Pulse post-deploy smoke tests
# ─────────────────────────────────────────────────────
# Usage:
#   SMOKE_BASE_URL=https://pulse-staging.bazaar-admin.com bash deploy/smoke-test.sh
#   SMOKE_BASE_URL=https://pulse.bazaar-admin.com bash deploy/smoke-test.sh
#
# Returns exit code 0 on pass, 1 on any failure.

set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:?ERROR: SMOKE_BASE_URL is not set}"
PASS=0
FAIL=0

# Remove trailing slash
BASE_URL="${BASE_URL%/}"

# ── Helpers ─────────────────────────────────────────────────

check_http() {
  local label="$1"
  local url="$2"
  local expected_status="${3:-200}"

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$url")
  if [ "$status" = "$expected_status" ]; then
    echo "  ✅ PASS [$status] $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL [$status expected $expected_status] $label — $url"
    FAIL=$((FAIL + 1))
  fi
}

check_body() {
  local label="$1"
  local url="$2"
  local pattern="$3"

  local body
  body=$(curl -s --max-time 15 "$url")
  if echo "$body" | grep -q "$pattern"; then
    echo "  ✅ PASS [body contains '$pattern'] $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL [body missing '$pattern'] $label — $url"
    FAIL=$((FAIL + 1))
  fi
}

check_header() {
  local label="$1"
  local url="$2"
  local header_pattern="$3"

  local headers
  headers=$(curl -sI --max-time 15 "$url")
  if echo "$headers" | grep -qi "$header_pattern"; then
    echo "  ✅ PASS [header contains '$header_pattern'] $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL [header missing '$header_pattern'] $label — $url"
    FAIL=$((FAIL + 1))
  fi
}

# ── Test Suite ───────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Pulse Smoke Tests"
echo "  Target: $BASE_URL"
echo "═══════════════════════════════════════════════════"

echo ""
echo "── Core pages reachable ────────────────────────────"
check_http "Root / (index)"                 "$BASE_URL/"
check_http "pages/dashboard.html"           "$BASE_URL/pages/dashboard.html"
check_http "pages/prepress.html"             "$BASE_URL/pages/prepress.html"
check_http "pages/production-manager.html"   "$BASE_URL/pages/production-manager.html"
check_http "pages/operator-terminal.html"    "$BASE_URL/pages/operator-terminal.html"
check_http "pages/qc-checkout.html"          "$BASE_URL/pages/qc-checkout.html"
check_http "pages/admin.html"                "$BASE_URL/pages/admin.html"
check_http "pages/job-ticket.html"           "$BASE_URL/pages/job-ticket.html"

echo ""
echo "── Legacy redirects (optional) ─────────────────────"
check_http "dashboard.html redirect"       "$BASE_URL/dashboard.html"

echo ""
echo "── Static assets reachable ─────────────────────────"
check_http "js/shared.js"                  "$BASE_URL/js/shared.js"
check_http "js/auth.js"                    "$BASE_URL/js/auth.js"
check_http "js/supabase-client.js"        "$BASE_URL/js/supabase-client.js"
check_http "js/pulse-config.local.js"     "$BASE_URL/js/pulse-config.local.js"

echo ""
echo "── Config injection check ──────────────────────────"
check_body "pulse-config: PULSE_SUPABASE_URL set"     "$BASE_URL/js/pulse-config.local.js" "PULSE_SUPABASE_URL"
check_body "pulse-config: not placeholder URL"        "$BASE_URL/js/pulse-config.local.js" "supabase.co"
check_body "pulse-config: storage backend = supabase" "$BASE_URL/js/pulse-config.local.js" "supabase"
check_body "pulse-config: PULSE_ENV set"              "$BASE_URL/js/pulse-config.local.js" "PULSE_ENV"

echo ""
echo "── Security headers check ──────────────────────────"
check_header "X-Content-Type-Options"  "$BASE_URL/pages/dashboard.html" "x-content-type-options"
check_header "X-Frame-Options"         "$BASE_URL/pages/dashboard.html" "x-frame-options"

echo ""
echo "── Cache header check ──────────────────────────────"
check_header "HTML no-cache"           "$BASE_URL/pages/dashboard.html" "no-cache"
check_header "JS cacheable"            "$BASE_URL/js/shared.js"      "cache-control"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "❌ Smoke tests FAILED — $FAIL check(s) did not pass."
  exit 1
fi

echo "✅ All smoke tests passed."
exit 0
