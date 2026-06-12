# Roles export / push

Editable snapshot for Admin **Roles**, **Personnel**, and Supabase **login roles**.

## Files

| File | Purpose |
|------|---------|
| `data/pulse-roles-export.json` | Edit this (generated from live DB + defaults) |
| `scripts/build-roles-export.mjs` | Re-pull from linked Supabase |
| `scripts/push-pulse-roles.mjs` | Upsert `config` + optional `profiles.role` updates |

## Workflow

1. **Export (refresh from cloud)**

   ```bash
   node scripts/build-roles-export.mjs
   ```

2. **Polish** `data/pulse-roles-export.json`:
   - `customRoles` — role labels in Admin Roles matrix (`key`, `label`, `color`)
   - `rolePermissions` — page matrix per role (`pages`, `canViewAdmin`, `adminTabs`, …)
   - `personnel` — Admin personnel rows (`name`, `role`, `userId`, `facility`, `active`) — production source of truth is **`profiles`** table
   - `profilesLogin` — sign-in role on `profiles` (Postgres `user_role` enum)

3. **Push**

   ```bash
   node scripts/push-pulse-roles.mjs
   ```

4. In the app: **Admin → Roles → Save Changes** (writes `config.rolePermissions` to Supabase).

5. For new role keys used at login, add matching entries in `js/auth.js` → `ROLE_CONFIG` and deploy the app.

**Login (production):** Users sign in with **email + password** (Supabase Auth). Admin → Personnel provisions accounts via RPC `upsert_pulse_personnel` (migration **046**).

## `profiles.role` enum (Supabase)

Allowed today: `admin`, `supervisor`, `production_manager`, `account_manager`, `operator`, `prepress`, `david_review`, `qc`.

- **Sales** in Personnel uses key `sales`; for login you may keep `profiles.role` as `account_manager` until a migration adds `sales` to the enum.
- DB uses underscores (`account_manager`); Admin personnel uses hyphens (`account-manager`).

## What was on remote when exported

- `config.customRoles` — yes (8 roles; export adds Account Manager + Sales)
- `config.rolePermissions` — no (filled from `auth.js` defaults)
- `config.personnel` — no (built from `profiles` table)
