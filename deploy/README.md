# Deploy scripts

Shell scripts for Cloudflare Pages builds and smoke tests live here.

**Release checklist:** [`docs/deploy/release-checklist.md`](../docs/deploy/release-checklist.md)

| Script | Purpose |
|--------|---------|
| `build.sh` | Production build (cache busters, config) |
| `smoke-test.sh` | Post-deploy HTTP checks |
| `rollback.sh` | Roll back Cloudflare Pages deployment |
