# Pulse — Bazaar Printing

Internal print-shop operations system (static HTML + vanilla JS + Supabase).

## Project layout

```
/
├── index.html              Entry → /pages/dashboard.html
├── pages/                  App screens (*.html)
├── js/                     shared.js, auth.js, supabase-client.js, pulse-config.js
├── data/                   JSON seeds & exports
├── deploy/                 build.sh, smoke-test.sh, rollback.sh
├── docs/                   All documentation
├── supabase/migrations/    Postgres SQL
└── scripts/                CLI utilities
```

## Quick start (local dev)

```bash
python3 -m http.server 8081
# Open http://127.0.0.1:8081/pages/dashboard.html
```

Production config is in **`js/pulse-config.js`**. On **Vercel**, `deploy/build.sh` also writes **`js/pulse-config.local.js`** from `VITE_SUPABASE_URL` + **`VITE_SUPABASE_ANON_KEY`** (use **anon public** key only — see [`deploy/README.md`](deploy/README.md)).

## Documentation

**Full index:** [`docs/README.md`](docs/README.md)

| Doc | Purpose |
|-----|---------|
| [`docs/supabase/production-status.md`](docs/supabase/production-status.md) | **Current production state** — login, Realtime, migrations, verification |
| [`docs/app/overview.md`](docs/app/overview.md) | App architecture, pages, roles, UI patterns |
| [`docs/supabase/connection-spec.html`](docs/supabase/connection-spec.html) | Full Supabase spec + developer runbook |
| [`docs/supabase/schema.md`](docs/supabase/schema.md) | Postgres schema reference |
| [`docs/deploy/release-checklist.md`](docs/deploy/release-checklist.md) | Production deploy checklist |

## npm scripts

```bash
npm run import:supabase   # Import backup JSON → Supabase
npm run migrate:supabase  # Apply migration 046 (personnel RPC)
npm run audit:staff       # Compare profiles vs legacy config.personnel
npm run check:david       # Verify David review user auth
```

## Verify Supabase mode

In browser console after login:

```javascript
pulseUsesSupabaseStorage()           // true
(await getAllPersonnel()).length   // matches Supabase profiles count
```

Console on load should show: `[Pulse] Storage backend: Supabase → …`

## Multi-user

All users share one Supabase database. UI updates are **Realtime-driven** (no 60s order polling). See [`docs/supabase/production-status.md#multi-user-realtime-sync`](docs/supabase/production-status.md).
