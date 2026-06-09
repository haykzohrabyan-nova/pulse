# Application JavaScript

| File | Role |
|------|------|
| `shared.js` | UI, nav, IndexedDB (legacy dev), `onDBUpdate`, catalog helpers |
| `auth.js` | Login, roles, session |
| `supabase-client.js` | Supabase CRUD overrides + Realtime |
| `pulse-config.js` | Production Supabase URL/key (committed) |
| `pulse-config.local.js` | Deploy-generated overrides (gitignored) |
| `organisation-local-store.js` | Local JSON org bundle (legacy) |
| `notification-config.js` | Notification prefs loader |
| `seed-data.js` | Dev seed (dashboard only) |

HTML pages reference these as `/js/filename.js`.
