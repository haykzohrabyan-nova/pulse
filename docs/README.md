# Pulse documentation

All project documentation lives under **`docs/`**.

> **For AI assistants:** Start with [`app/overview.md`](app/overview.md) (how the app works today) and [`supabase/production-status.md`](supabase/production-status.md) (production config, login, Realtime, migrations). Business reference specs are in `docs/app/`; do not treat `docs/planning/` as current runtime behavior.

---

## Start here

| Doc | Audience | Purpose |
|-----|----------|---------|
| [**Supabase production status**](supabase/production-status.md) | Everyone deploying or verifying prod | Current backend mode, login, migrations, Realtime, verification |
| [**App overview**](app/overview.md) | Developers / AI rebuild | Architecture, pages, roles, UI patterns |
| [**Release checklist**](deploy/release-checklist.md) | Deployers | Staging gate, migrations, smoke tests, rollback |
| [**Supabase connection spec**](supabase/connection-spec.html) | Developers | Full Supabase runbook (open in browser) |

---

## Folder layout

```
docs/
├── README.md                 ← you are here
├── app/                      Business & product specs
├── supabase/                 Backend & database docs
├── deploy/                   Release checklist
├── roles/                    Roles export tooling
└── planning/                 Scope / cleanup notes

Application code (not in docs/):
├── pages/                    All app HTML screens
├── js/                       shared.js, auth.js, supabase-client.js, pulse-config.js
├── index.html                Redirects to /pages/dashboard.html
├── deploy/*.sh               Build & smoke-test scripts
└── supabase/migrations/      SQL migrations
```

---

## By topic

### Multi-user / production

- [Production status — Realtime sync](supabase/production-status.md#multi-user-realtime-sync)
- [Release checklist — post-deploy Realtime test](deploy/release-checklist.md)
- [Connection spec §7 — Realtime](supabase/connection-spec.html#realtime)

### Login & personnel

- [Production status — login flow](supabase/production-status.md#login-supabase-mode)
- [Roles export workflow](roles/export.md)
- Migration **046** — Admin → Personnel save (`upsert_pulse_personnel`)

### Schema & migrations

- [Schema reference](supabase/schema.md)
- Apply pending migrations: `supabase db push --linked --yes`

### Business rules

- [Full spec — facilities & materials](app/full-spec.md)
- [Workflow spec — order lifecycle](app/workflow-spec.md)
- [Product workflow config — machine routes](app/product-workflow-config.md)

---

## Quick local dev

```bash
python3 -m http.server 8081
# http://127.0.0.1:8081/pages/dashboard.html — not file://
```

Production config: **`js/pulse-config.js`** (`PULSE_STORAGE_BACKEND = 'supabase'`). Leave **`js/pulse-config.local.js`** empty unless testing IndexedDB-only mode.

---

## npm scripts

| Command | Purpose |
|---------|---------|
| `npm run import:supabase` | Import backup JSON → Supabase |
| `npm run migrate:supabase` | Instructions for migration 046 |
| `npm run migrate:david-a/b/c` | David review user migrations 047 |
| `npm run audit:staff` | Compare `profiles` vs legacy config |
| `npm run check:david` | Verify David review auth user |

---

## Files outside `docs/` (intentional)

| Path | Why it stays |
|------|----------------|
| `README.md` (repo root) | Standard GitHub entry point — links into `docs/` |
| `supabase/migrations/*.sql` | SQL lives next to the schema tooling |
| `deploy/*.sh` | Deploy scripts (checklist is in `docs/deploy/`) |
