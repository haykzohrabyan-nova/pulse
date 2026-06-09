# Deploy scripts

Build and verify Pulse before/after hosting. See [`docs/deploy/release-checklist.md`](../docs/deploy/release-checklist.md).

| Script | Purpose | When it runs |
|--------|---------|--------------|
| `build.sh` | Generates `js/pulse-config.local.js`, updates JS cache-busters in HTML | **Every deploy** (required) |
| `smoke-test.sh` | HTTP checks after deploy | CI or manual |
| `rollback.sh` | Roll back Cloudflare Pages deployment | Manual emergency only |

---

## Vercel (git push deploy)

The repo includes **`vercel.json`** so Vercel runs `bash deploy/build.sh` on each deploy.

### Required: Vercel environment variables

**Project → Settings → Environment Variables** (Production + Preview):

| Variable | Example / value |
|----------|-----------------|
| `PULSE_SUPABASE_URL` | `https://gkyupebgulpgwugsbvny.supabase.co` |
| `PULSE_SUPABASE_ANON_KEY` | **anon public** key (JWT `eyJ...`) — **never** `sb_secret_...` |
| `VITE_SUPABASE_ANON_KEY` | Same as above if using Vite-style names |

**Wrong key = 401 everywhere.** Supabase → Settings → API → copy **anon** / **public**, not **service_role** / **secret**.
| `PULSE_STORAGE_BACKEND` | `supabase` |
| `PULSE_ENV` | `production` (or `preview` for preview deploys) |

Same values as committed `js/pulse-config.js` unless you use a separate Supabase project for staging.

**Already have `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`?** `build.sh` uses those automatically if `PULSE_*` is not set.

Optional (defaults exist if omitted):

| Variable | Value |
|----------|--------|
| `PULSE_STORAGE_BACKEND` | `supabase` (default) |
| `PULSE_ENV` | `production` or `preview` (default: `production`) |

### Verify after deploy

1. **Build log** (Vercel → Deployment → Building) should show:
   ```
   [build] Generated js/pulse-config.local.js
   [build] Cache-buster updated to ...
   ```
2. Open `https://YOUR-SITE/js/pulse-config.local.js` → **200**, not 404.
3. Browser console: no `pulse-config.local.js` 404; `[Pulse] Storage backend: Supabase`.

If build fails with `PULSE_SUPABASE_URL is not set`, add the env vars above and redeploy.

---

## Cloudflare Pages / GitHub Actions

Workflows `.github/workflows/deploy-staging.yml` and `deploy-production.yml` run `build.sh` and `smoke-test.sh` automatically.

`rollback.sh` is for Cloudflare only (needs `CLOUDFLARE_API_TOKEN`).

---

## Local dev

`js/pulse-config.local.js` is gitignored. For local HTTP server you can:

- Rely on **`js/pulse-config.js`** alone (leave local file absent — you may see a harmless 404), or
- Run once: `PULSE_SUPABASE_URL=... PULSE_SUPABASE_ANON_KEY=... PULSE_ENV=development bash deploy/build.sh`
