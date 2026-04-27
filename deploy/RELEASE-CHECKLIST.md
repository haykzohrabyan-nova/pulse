# Pulse — Release Checklist

Use this checklist for every production deployment to `pulse.bazaar-admin.com`.
Staging deployments (`pulse-staging.bazaar-admin.com`) only require the **Staging** section.

---

## Pre-Deploy: Staging Gate

- [ ] All features for this release are merged to `main`
- [ ] **Staging deploy triggered**: push to `staging` branch (or `workflow_dispatch` on `deploy-staging.yml`)
- [ ] **Staging smoke tests passed** (GitHub Actions `deploy-staging` job shows ✅)
- [ ] **Manual QA on staging** — spot-check:
  - [ ] Login with a test account works (Supabase auth)
  - [ ] Job ticket list loads (Supabase backend active — check console for `[Pulse] Storage backend: Supabase`)
  - [ ] Dashboard live orders render
  - [ ] File upload (R2 presigned upload) works on a test ticket
  - [ ] File download (R2 presigned download) works
  - [ ] QC checkout flow completes
  - [ ] Role-based routing: operator sees only operator pages, QC sees QC, admin sees all
- [ ] **No P0/P1 bugs** open against the staging build in PRI issues
- [ ] Confirm with team that staging is QA-approved (DM/Slack message from Hayk or QA agent)

---

## Pre-Deploy: Production Config Check

- [ ] **Supabase project**: confirm production project ref is in `PROD_SUPABASE_URL` GitHub secret
- [ ] **Supabase anon key**: confirm `PROD_SUPABASE_ANON_KEY` GitHub secret is current (rotate if >90 days)
- [ ] **R2 Edge Functions**: confirm all 4 functions (`r2-presign-upload`, `r2-presign-download`, `r2-confirm-upload`, `r2-delete`) are deployed to production Supabase project
  ```bash
  supabase functions list --project-ref <prod-project-ref>
  ```
- [ ] **Database migrations**: confirm all migrations are applied to production DB
  ```bash
  supabase db diff --project-ref <prod-project-ref>
  # should show no pending changes
  ```
- [ ] **Cloudflare DNS**: `pulse.bazaar-admin.com` → Cloudflare Pages `pulse-production` project (CNAME)
  - Coordinate DNS cutover with Hayk — do NOT change DNS without approval ([PRI-242](/PRI/issues/PRI-242))
- [ ] **Cloudflare Pages project**: `pulse-production` exists in Cloudflare dashboard
  - Build command: `bash deploy/build.sh`
  - Build output directory: `.`
  - Production env vars set: `PULSE_SUPABASE_URL`, `PULSE_SUPABASE_ANON_KEY`, `PULSE_STORAGE_BACKEND=supabase`, `PULSE_ENV=production`

---

## Deploy

1. Go to **GitHub Actions** → `Deploy — pulse production` → **Run workflow**
2. Enter:
   - `reason`: ticket reference + brief description (e.g., `PRI-242: initial production launch`)
   - `staging_verified`: `yes`
3. Watch the workflow run — **do not navigate away**
4. Wait for `deploy` job to show ✅

---

## Post-Deploy: Production Smoke Tests

The workflow runs `deploy/smoke-test.sh` automatically. Verify all checks pass in the Actions log.

Manual post-deploy checks:
- [ ] `https://pulse.bazaar-admin.com/` loads (200)
- [ ] `https://pulse.bazaar-admin.com/pulse-config.local.js` contains `PULSE_SUPABASE_URL` with production URL
- [ ] Log in as each role and verify routing:
  - [ ] Admin — sees all pages
  - [ ] Supervisor — sees dashboard, job-ticket, orders, prepress, qc, quotes
  - [ ] Production Manager — sees dashboard, prepress, production-manager, operator, qc, admin
  - [ ] Operator — sees only operator-terminal
  - [ ] QC — sees qc-checkout
- [ ] Create a test job ticket → confirm it appears in Supabase production DB
- [ ] Upload a test file → confirm presigned URL is generated and file lands in R2

---

## Rollback Procedure

If anything is wrong **immediately after deploy**:

### Option A — Cloudflare Pages UI (fastest, ~10 seconds)
1. Go to Cloudflare Dashboard → Pages → `pulse-production` → Deployments
2. Find the last successful deployment
3. Click `...` → **Rollback to this deployment**
4. Confirm — deployment is live immediately

### Option B — CLI rollback script
```bash
CLOUDFLARE_API_TOKEN=<token> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
bash deploy/rollback.sh
```

### Option C — GitHub Actions re-deploy
1. Identify the last known-good git tag (e.g., `release/20260427-abc1234`)
2. Checkout that tag: `git checkout release/20260427-abc1234`
3. Run `Deploy — pulse production` workflow_dispatch again

### After rollback
- [ ] Run smoke tests against production: `SMOKE_BASE_URL=https://pulse.bazaar-admin.com bash deploy/smoke-test.sh`
- [ ] Notify team the rollback happened
- [ ] Open a post-mortem PRI issue

---

## Cloudflare DNS Coordination

DNS changes to `pulse.bazaar-admin.com` and `pulse-staging.bazaar-admin.com` require Hayk's approval.

**Do not:**
- Point DNS at Pages before the Pages project is created and verified
- Change DNS for production before staging has been live for ≥1 hour with no errors

**DNS cutover steps (coordinate with Hayk):**
1. Confirm Cloudflare Pages project is deployed and smoke tests pass on the default Pages URL (e.g., `pulse-production.pages.dev`)
2. In Cloudflare DNS, add/update CNAME:
   - `pulse-staging` → `pulse-staging.pages.dev` (proxy enabled)
   - `pulse` → `pulse-production.pages.dev` (proxy enabled)
3. Verify custom domain shows in Cloudflare Pages → Custom domains tab
4. Confirm SSL certificate is active (may take a few minutes)
5. Run smoke tests against the custom domain

---

## GitHub Secrets Required

| Secret | Scope | Description |
|--------|-------|-------------|
| `CLOUDFLARE_API_TOKEN` | repo | CF Pages deploy permission |
| `CLOUDFLARE_ACCOUNT_ID` | repo | Cloudflare account ID |
| `STAGING_SUPABASE_URL` | staging env | Supabase staging project URL |
| `STAGING_SUPABASE_ANON_KEY` | staging env | Supabase staging anon key |
| `PROD_SUPABASE_URL` | production env | Supabase production project URL |
| `PROD_SUPABASE_ANON_KEY` | production env | Supabase production anon key |

Set secrets at: `https://github.com/haykzohrabyan-nova/pulse/settings/secrets/actions`
