#!/usr/bin/env bash
# deploy/rollback.sh — Pulse production rollback helper
# ──────────────────────────────────────────────────────
# Rollback using the Cloudflare Pages API.
# Cloudflare Pages keeps a full deployment history — rollback is instantaneous.
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN env var (must have Pages:Edit permission)
#   - CLOUDFLARE_ACCOUNT_ID env var
#   - curl + jq installed
#
# Usage:
#   # Rollback production to the previous deployment
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bash deploy/rollback.sh
#
#   # Rollback to a specific deployment ID
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#     bash deploy/rollback.sh --deployment-id <deployment-id>
#
#   # List recent deployments (dry run)
#   bash deploy/rollback.sh --list

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?ERROR: CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?ERROR: CLOUDFLARE_ACCOUNT_ID is not set}"

CF_API="https://api.cloudflare.com/client/v4"
PROJECT_NAME="${CF_PROJECT_NAME:-pulse-production}"
TARGET_DEPLOYMENT_ID=""
LIST_ONLY=false

# ── Parse args ───────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-id)
      TARGET_DEPLOYMENT_ID="$2"
      shift 2
      ;;
    --project)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --list)
      LIST_ONLY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

CF_HEADERS=(
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  -H "Content-Type: application/json"
)

# ── List recent deployments ──────────────────────────────────
echo ""
echo "Recent deployments for: $PROJECT_NAME"
echo "────────────────────────────────────────"

DEPLOYMENTS=$(curl -s "${CF_HEADERS[@]}" \
  "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments?per_page=10")

if ! echo "$DEPLOYMENTS" | jq -e '.success' >/dev/null 2>&1; then
  echo "❌ Failed to fetch deployments. Check your API token and project name."
  echo "$DEPLOYMENTS" | jq .
  exit 1
fi

echo "$DEPLOYMENTS" | jq -r '
  .result[] |
  [.id[0:8], .created_on[0:19], .deployment_trigger.metadata.branch // "?",
   (.stages[-1].name // "?"), (.stages[-1].status // "?")] |
  @tsv
' | column -t -s $'\t' | head -10

if $LIST_ONLY; then
  echo ""
  echo "Run with --deployment-id <id> to rollback to a specific deployment."
  exit 0
fi

# ── Determine rollback target ────────────────────────────────
if [ -z "$TARGET_DEPLOYMENT_ID" ]; then
  # Default: rollback to the deployment BEFORE the current live one
  CURRENT_ID=$(echo "$DEPLOYMENTS" | jq -r '.result[0].id')
  PREV_ID=$(echo "$DEPLOYMENTS" | jq -r '.result[1].id')
  PREV_SHA=$(echo "$DEPLOYMENTS" | jq -r '.result[1].deployment_trigger.metadata.commit_hash // "unknown"')
  PREV_DATE=$(echo "$DEPLOYMENTS" | jq -r '.result[1].created_on[0:19]')

  echo ""
  echo "Current deployment : $CURRENT_ID"
  echo "Rollback target    : $PREV_ID ($PREV_SHA @ $PREV_DATE)"
  TARGET_DEPLOYMENT_ID="$PREV_ID"
fi

# ── Confirm ──────────────────────────────────────────────────
echo ""
read -rp "⚠️  Roll back $PROJECT_NAME to deployment $TARGET_DEPLOYMENT_ID? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Rollback cancelled."
  exit 0
fi

# ── Execute rollback ─────────────────────────────────────────
echo "Rolling back..."

ROLLBACK=$(curl -s -X POST "${CF_HEADERS[@]}" \
  "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments/$TARGET_DEPLOYMENT_ID/rollback")

if echo "$ROLLBACK" | jq -e '.success' >/dev/null 2>&1; then
  LIVE_URL=$(echo "$ROLLBACK" | jq -r '.result.url // "https://pulse.bazaar-admin.com"')
  echo ""
  echo "✅ Rollback complete!"
  echo "   Live URL: $LIVE_URL"
  echo ""
  echo "Next steps:"
  echo "  1. Run smoke tests: SMOKE_BASE_URL=https://pulse.bazaar-admin.com bash deploy/smoke-test.sh"
  echo "  2. Notify the team that a rollback occurred"
  echo "  3. Open a post-mortem issue for the failed deploy"
else
  echo "❌ Rollback failed:"
  echo "$ROLLBACK" | jq .
  exit 1
fi
