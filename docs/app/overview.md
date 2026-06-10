# Pulse — Bazaar Printing (project description for AI / rebuild spec)

This document describes what **Pulse** is, how it is built, and the **logic + UI/UX patterns** another developer or AI should reproduce to build equivalent software.

---

## 1. Product purpose

**Pulse** is an internal **print-shop operations system** for **Bazaar Printing**. It tracks **orders** from intake through **prepress**, **production** (machines / operators), **QC**, **application** (label application dept), and **shipping**, with **sales** tools (quotes, pricing, account managers, leads, proofs, design tasks).

Primary user-facing metaphor: an **order** is identified by a human-readable **`orderId`** (e.g. `18005`). **Sub-tickets** (additional line items under the same parent order) use IDs like `18005_1`, `18005_2` and store **`parentOrderId`** pointing at the parent. **Reprints** and related flows may use additional suffix conventions (e.g. `_R1`).

---

## 2. Technical architecture

| Layer | Choice |
|--------|--------|
| UI | **Multi-page static HTML** in **`pages/`** — each feature is `pages/*.html` + inline or page-local script. |
| Shared logic | **`js/shared.js`** — navigation, theme CSS, status badges, breadcrumbs, toasts, formatting helpers, and domain helpers. IndexedDB access is **legacy dev only** when `PULSE_STORAGE_BACKEND = 'indexeddb'`. |
| Auth / RBAC | **`js/auth.js`** — roles, `sessionStorage` session (`pulse_session`), `initAuth(pageId)`, nav visibility by role. |
| Backend (production) | **`js/supabase-client.js`** — when `PULSE_STORAGE_BACKEND` is `supabase` (production default), all business data reads/writes go to Supabase Postgres via overrides. IndexedDB is blocked in this mode. |
| Organisation store | **`js/organisation-local-store.js`** — localStorage JSON bundle used only when `PULSE_ORG_STORAGE === 'local-json'`. Production uses **`PULSE_ORG_STORAGE = 'supabase'`**. |
| Config | **`js/pulse-config.js`** — committed production Supabase URL, keys, `PULSE_STORAGE_BACKEND = 'supabase'`. **`js/pulse-config.local.js`** (gitignored) should be **empty** so production config wins; template at `js/pulse-config.local.js.example`. |
| Schema | **`supabase/migrations/*.sql`** — Postgres enums, `orders`, `order_workflow_steps`, `profiles`, `organisations`, `organisation_facilities`, `organisation_hardware`, etc. |
| Seed data | **`data/pulse-organisation-default.json`** — default local-JSON bundle template for `pages/organisation.html` offline mode. |
| Dev utilities | **`scripts/wipe-pulse-browser-macos.command`** — opens `pages/reset-pulse-local-data.html?automated=1` via local HTTP server. |

**Path helpers:** `pulsePage('dashboard')` → `/pages/dashboard.html`, `pulseJs('shared.js')` → `/js/shared.js` (defined in `shared.js`).

**Important:** The **same order object shape** is used whether data comes from IndexedDB or Supabase (`_rowToOrder` / `_orderToRow` in `supabase-client.js` mirror specs into a JSON **`specs`** column on persisted rows).

**Entry:** `index.html` redirects to **`/pages/dashboard.html`**.

**Legacy URLs:** `_redirects` maps old `/dashboard.html` → `/pages/dashboard.html` for bookmarks.

---

## 3. Domain model (orders)

Core **`order`** fields (conceptual):

- **Identity:** `orderId`, optional Supabase UUID `id` / `_supaId` for edits.
- **Customer & sales:** `customerName`, `accountManager`, `quoteRef`, pricing/invoice fields, `facility` (`16th-street` | `boyd-street`).
- **Product:** `productType`, `material`, `quantity`, sheet/piece counts, `colorMode`, `sides`, roll options, finishing (lamination, UV, foil, perforation), **cut** (`cutMethod`, `dieName`, frame counters).
- **Dates:** `dueDate`; timestamps `createdAt` / `updatedAt` (when on Supabase).
- **Hierarchy:** `parentOrderId` for **sub-tickets** (child job tickets).
- **Workflow:** `status` (string enum aligning with DB `order_status` + extras used in JS), `workflowTemplate`, `currentStep`, `workflowSteps[]` with per-step machine/operator/timestamps.
- **Files:** `artworkFiles[]` metadata (name, size, role, optional `r2Key` for object storage — PRI-237 style).
- **Operational flags:** rush, hold, material shortage, prepress/account-manager bounce (`pending-account-manager`, `prepressIssueComment`, etc.), overtime approval, QC notes types.

Statuses appear across the UI with **color-coded badges** (see `THEME_CSS` / `STATUS_*` in `shared.js`): e.g. `prepress`, `prepress-active`, `prepress-paused`, `pending-account-manager`, `in-production`, `qc-checkout`, `on-hold`, shipped/received/completed, etc.

---

## 4. Authentication and roles (`auth.js`)

- Session: **`pulse_session`** in `sessionStorage` → `{ name, role, loginTime }`.
- **Login UI (Supabase production):** **Email + password** via Supabase Auth (`auth.js` → `_submitLoginSupabaseEmail`). Accounts are provisioned in Supabase Auth + **`profiles`** (Admin → Personnel, migration **046**).
- **Login UI (IndexedDB dev mode):** Legacy Name dropdown + User ID — hardcoded fallbacks (`OPERATOR_PROFILES`, etc.) apply only when `PULSE_STORAGE_BACKEND = 'indexeddb'`.
- **Supabase mode:** Role from `profiles.role`; personnel from `profiles` table only (no runtime merge with hardcoded lists).
- **`ROLE_CONFIG`**: each role has **`pages`** whitelist (matches `renderNav()` page `id`s), flags **`canEditAllTickets`**, **`ownTicketsOnly`** (account managers), **`adminTabs`** for admin subsets, plus **`canViewAdmin`**, **`canViewProduction`**, **`canViewOperator`** flags.
- **Runtime overrides:** Admin → Roles → Save writes `config.rolePermissions` to **Supabase `config` table** in production. In IndexedDB dev mode, also caches to `localStorage` (`pulse_role_overrides`). `_applyRoleOverrides()` runs at the top of `initAuth()` on every page load.
- **Nav visibility:** `renderNav(activePage)` outputs links with classes `nav-admin-only`, `nav-production-only`, `nav-operator-only`; **`initAuth`** toggles display based on role config.

Implementing parity: gate links **and** route-level checks (every HTML page calls `initAuth('<page-id>')` pattern).

---

## 5. Global UI / UX system (`shared.js`)

### 5.1 Visual design

- **CSS variables:** `--bg`, `--card`, `--border`, `--text`, `--accent` (#2563eb blue), semantic greens/red/amber/purple, `--radius`, `--shadow`.
- **Typography:** system UI stack (-apple-system, Segoe UI, Roboto).
- **Components:** `.btn`, `.btn-primary`, `.btn-sm`, `.card`, `.data-table`, modals `.modal-overlay`.

### 5.2 Chrome

- **Top nav:** logo `pulse-logo.png`, **UX Preview** pill, horizontal link row, **active** state (blue tinted background).
- **Breadcrumbs:** `renderBreadcrumb([{label, href?}])` — first crumb is Dashboard.
- **Toasts:** `#page-toast-container` fixed bottom-right; `showPageToast(message, variant)`.
- **Status:** icon + badge styling for pipeline states; **flash-red** utility for urgency.

### 5.3 Patterns to replicate

- Heavy use of **inline styles** alongside shared classes on older pages; newer work still follows the same palette.
- **Role-based hiding** of nav items, not only disabled links.
- **Tables and cards** for operational lists; operator-facing pages favor **large touch targets** and step clarity.

---

## 6. Application pages (current repo)

**Standard script load order** (production pages):

```html
<script src="/js/pulse-config.js"></script>
<script src="/js/pulse-config.local.js"></script>
<script src="/js/shared.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="/js/supabase-client.js"></script>
<script src="/js/auth.js"></script>
```

Each page calls `injectThemeCSS()`, `renderNav(pageId)`, `renderBreadcrumb(...)`, `initAuth(pageId)`.

### 6.1 Nav pages (`renderNav` in `shared.js`)

| Page id | File | Nav access | Purpose |
|---------|------|------------|---------|
| `dashboard` | `pages/dashboard.html` | all roles | KPIs, order groupings (parents + sub-tickets) |
| `job-ticket` | `pages/job-ticket.html` | all roles | Core order editor + sidebar queue |
| `pricing-calculator` | `pages/pricing-calculator.html` | top nav ($ Pricing) | Embeds `pages/pricing-calculator-sales.html` in iframe |
| `prepress` | `pages/prepress.html` | production | Prepress queue |
| `production-manager` | `pages/production-manager.html` | production | Production planning / PM actions |
| `operator-terminal` | `pages/operator-terminal.html` | operator | Shop floor operators (1s UI clock timer only — not a DB poll) |
| `qc-checkout` | `pages/qc-checkout.html` | production | QC pass/fail |
| `shipping` | `pages/shipping.html` | production | Shipping |
| `machine-issues` | `pages/machine-issues.html` | production | Machine issue log |
| `admin` | `pages/admin.html` | admin-only nav | Tabbed admin console |

**Standalone (not in main nav row):** `pages/organisation.html` — company / facilities / hardware; also embedded in Admin → Organisation tab (`?embedded=admin`).

### 6.2 Utility / migration pages (no nav)

| File | Purpose |
|------|---------|
| `pages/migrate-to-supabase.html` | One-time IndexedDB → Supabase migration UI |
| `pages/migrate.html` | Legacy migration helper |
| `pages/reset-pulse-local-data.html` | Wipe browser IndexedDB/localStorage |

### 6.3 Removed / not in this repo

Older specs referenced sales/CRM pages (`quotes.html`, `sdr-pipeline-portal.html`, `jm-dashboard.html`, etc.) and a `v2/` folder. **Those files are not present** in the current tree — only the 15 pages under `pages/` listed above (+ `index.html` redirect at repo root).

**`pages/dashboard.html`** groups orders into **parents + sub-tickets** and surfaces batching / progress summaries — mirror that mental model elsewhere for consistency.

---

## 7. Job Ticket page (`pages/job-ticket.html`) — detailed UX + logic

This is the **richest form** in the product. Another implementation should preserve these behaviors unless requirements change.

### 7.1 Layout shell

- Document class **`jt-page-fixed`**: **`html`/`body` height 100%, `overflow: hidden`** — **no whole-page scrolling**.
- **`#jtViewportRoot`**: column flex — nav + breadcrumb fixed footprint; **`#splitWrapper`** flex row fills remaining height.
- **`#formPane`**: **scrolls internally** (`overflow-y: auto`, `overscroll-behavior: contain`).
- **`#queuePane`**: right-hand **Orders** sidebar (~340px), same column scroll for the list region (`.qp-list`).

Horizontal split: **form left**, **queue right**. Sidebar can **collapse** (`#queuePane.collapsed`, **`#showQueueBtn`** expands).

### 7.2 Orders sidebar (queue)

- Header: title **Orders** + count; collapse control.
- **Search** (`#queueSearch`) by order id or customer substring.
- **Status filter** (`#queueStatusFilter`): All, Active, Prepress variants, Needs My Fix, Overdue, On Hold, Closed, etc.
- **Date filter** (`#queueDateFilter`): filtered by **placement time** — use order **`createdAt` / `updatedAt`** (`jtOrderPlacedMs`), labels like **Placed today / yesterday / last 7–30 days / custom**.
- **Account manager filter row** (`#queueRepFilter`): visible for role **`account-manager`** — “My orders” vs all reps vs specific rep.
- **Attention box** (`#queueAttentionBox`): for AM role, surfaced **pending-account-manager** orders assigned to current user (can still mention sub-tickets if present).
- **Queue list**: cards (`.qp-card`) — `#orderId`, facility chip, optional **sales lock** when status is not editable by sales; status dot color; merged meta line (**product**, **quantity**, cut short label, due countdown); material + rep line.
- **Sidebar list intentionally omits child job tickets:** after rep-scoped **`allOrders`**, build **`sidebarOrdersOnly = allOrders.filter(o => !o.parentOrderId)`** — only **parent / standalone** orders appear in the scroll list (sub-tickets remain reachable via **`?order=18005_2`**, **order navigator** on the form, dashboard, etc.).
- **Sorting:** primarily by **placed** time descending; ties broken by due date then `orderId` string compare.

### 7.3 Form behavior (high level)

- **`jobTicketNumber`** field mirrors **`orderId`**; auto-generation when empty; **sub-tickets** get generated ids from **`generateSubTicketId(parent)`** and set **`parentOrderId`** on save.
- **Order navigator** accordion: lists **parent + sub-tickets** with Open links (`renderOrderNavigator`).
- **Dirty guard:** `beforeunload` only when **`_formDirty`** is true (avoids Permissions-Policy console warnings on idle navigation).
- **Save:** validates facility, customer, product, material; handles **rush**, **material shortage** warnings; new orders default **`status`** commonly **`prepress`** (prepress intake); **`addActivity`** style logging for create/edit.
- **Edit locks:** restricted statuses → read-only UI for some roles + **admin confirmation modal** for unlock path when applicable (`#adminCodeModal`).
- **Design task modal** (#createDesignTaskModal): optional workflow for creating design tasks from the ticket context.

### 7.4 Product-specific UI simplifications (current direction)

Implementations aligning with recent product decisions:

- **Single primary SKU path** for saves (no multi-SKU “add version” flow on ticket); legacy DB may still have **`skus`** arrays — load/save tolerant.
- **Linear dimensions in inches only** for label/box sizing in the UX (conversion helpers **`jtToInches` / `jtFromInches`**, **`calcLabelFit`** treat stored numbers as inches in the streamlined path).
- **Merged summary panels:** combine quantity/size/artwork awareness with cutting & die + due date into **paired sub-panels** (`.jt-merge-*`) for denser scanning.
- **QR code column** for queue cards removed from this page (no ticket QR stub in sidebar cards).

---

## 8. Data access and multi-user sync

### 8.1 CRUD helpers

- Prefer **`getAllOrders()`**, **`getOrderByOrderId(id)`**, **`addOrder`** / **`updateOrder`** / Supabase equivalents as defined on `window` from `shared.js` + overrides in `supabase-client.js`.
- **Activities / comments:** centralized helpers (`addActivity`, notes types INFO / CRITICAL / INSTRUCTIONS) for audit trail parity.
- **Workflow steps:** updated when operators advance jobs on **`pages/operator-terminal.html`**; **`pages/production-manager.html`** assigns templates/steps.

### 8.2 Realtime (production — June 2026)

Multiple users share one Supabase database. **`js/supabase-client.js`** subscribes to `postgres_changes` on orders, workflow steps, comments, tasks, activity, config, dies, org tables, profiles, machine_issues, etc. Events dispatch:

- `pulse:order-change` and legacy alias `pulse:orders-changed`
- `pulse:reference-data-changed` (config, dies, org, profiles, …)
- `pulse:task-change` (production_tasks)

**`onDBUpdate()`** in `shared.js` lets pages register refresh handlers. Dashboard and job-ticket **do not** poll Supabase on a timer anymore.

**Known limits:** last-save-wins on the same open ticket; no fallback poll if the Realtime WebSocket drops (user may need manual refresh).

See [`production-status.md`](../supabase/production-status.md) and migration **048**.

---

## 9. Admin panel (`pages/admin.html`)

The admin panel is a tabbed single-page shell. Tab visibility is controlled per-role via `adminTabs` in `ROLE_CONFIG`.

### 9.1 Tab inventory

| Tab key | Purpose |
|---------|---------|
| `personnel` | Personnel registry — add/edit/delete staff records |
| `machines` | Machine registry |
| `dies` | Die registry (card and table views) |
| `organisation` | Embedded `pages/organisation.html` iframe — company profile, facilities, hardware |
| `inventory` | Material inventory |
| `purchase-orders` | Purchase orders |
| `knowledge` | Knowledge base |
| `qa-rules` | QA rule builder |
| `roles` | 🔐 Roles & Permissions matrix |
| `settings` | System settings |
| `products` | Product catalogue |
| `product-workflows` | **Product Workflow Configuration** — per-product manufacturing routes (machines, conditions, alternatives) |

### 9.2 Product Workflow Configuration (`product-workflows`)

Defines **how** each catalog product is manufactured (ordered machine sequence), not what materials/options the product offers (see **Products** tab).

- **Data:** Supabase tables `machines` + `product_workflows` (migration `022`); PM swap audit `workflow_override_log` (migration `023`). Steps stored as JSONB on `product_workflows.steps`.
- **Defaults:** `PRODUCT_WORKFLOW_DEFAULTS` in `shared.js`; auto-seeded for catalog products on first tab load via `seedProductWorkflowsFromDefaults()`.
- **Job tickets:** Resolve route from DB + job options (`lamination`, `cutMethod`, `materialFinish`, Scodix flags); preview under Cutting; save builds `workflowSteps[]` with display names. Legacy `WORKFLOW_TEMPLATES` used if config missing.
- **Production Manager:** **Swap** only when step has configured alternatives; logged to `workflow_override_log`.
- **Full reference:** [`product-workflow-config.md`](product-workflow-config.md).

### 9.3 Personnel tab (Supabase production)

- Table columns: **Name**, **Email**, **Role**, **User ID**, **Facility**, **Phone**, **Status**, **Actions**.
- Modal title: **Add Personnel** / **Edit Personnel**; button: **+ Add Personnel**.
- Required fields: **Name \***, **Role \***, **Facility \*** (multi-checkbox), **User ID \***.
- **Login email (auto):** shown under the Name field in the modal and in the table — derived via `window.pulsePersonnelLoginEmail()` in `auth.js` (first word of name + `@bazaar-admin.com`, e.g. `David Zargaryan` → `david@bazaar-admin.com`). Not a separate form field.
- **Duplicate email guard:** before save, the UI blocks if that login email is already used by another person; migration **049** makes `upsert_pulse_personnel` reject duplicate emails on add (and when editing would steal another account’s email). Use a unique first word in the display name if two people share a first name (e.g. `John2 Smith`).
- **Save** calls RPC **`upsert_pulse_personnel`** (migrations **046** + **049**):
  - **Login email** = first word of name + `@bazaar-admin.com`.
  - **Login password** = the **User ID** the admin sets (or `Pulse2026!` if empty).
  - Optional RPC arg **`p_profile_id`** when editing — keeps the same auth account.
  - Upserts Supabase Auth user + **`profiles`** row.
- Users sign in on the login form with that **email + password** (not Name dropdown).
- Search box matches name, email, User ID, phone, role label, facility.
- **Bulk Set User IDs**: legacy bulk helper for the `userId` / password field.

### 9.4 Roles & Permissions matrix

- Replaces the static read-only table with an **interactive checkbox matrix**.
- **Rows** = every role in `ROLE_CONFIG` (plus any custom roles added via **+ Add Role**).
- **Columns** = 25 pages + 4 special permissions (Edit All Tickets, View Admin, View Production, View Operator), separated by a visual divider.
- Column headers are vertically rotated for compactness; table scrolls horizontally inside `rolesMatrixWrap`.
- Each cell is a live `<input type="checkbox">` wired to `roleMatrixChange()`.
- **Save Changes** → calls `saveRolePermissions()` which persists to Supabase **`config.rolePermissions`** (production) and applies to live `ROLE_CONFIG` in the current session. IndexedDB dev mode also writes `localStorage` key `pulse_role_overrides`.
- **↺ Reset** (amber button, per-row) — visible when a row has unsaved or saved overrides; clears that role's overrides and re-renders.
- **✕ Delete** (red button, per-row) — removes a custom role from the selector (admin role is protected).
- `pages: ['all']` roles (Admin) always render with all page checkboxes checked; empty override arrays are treated as "inherit defaults" to prevent accidental lock-out.
- Changes propagate to all pages via `_applyRoleOverrides()` running in `initAuth()`.

### 9.5 Organisation tab

- Loaded as an embedded `<iframe src="/pages/organisation.html?embedded=admin">`.
- **`pages/organisation.html`** is also a standalone page (role: `organisation`); it detects `?embedded=admin` to suppress its own nav.
- **Storage mode** — auto-detected at runtime:
  - **Supabase** (`PULSE_STORAGE_BACKEND === 'supabase'` and valid URL/key): reads/writes `organisations`, `organisation_facilities`, `organisation_hardware` tables; logo uploads to `org-assets` storage bucket.
  - **Local JSON** (fallback or `PULSE_ORG_STORAGE === 'local-json'`): uses `PulseOrgJsonStore` (localStorage key `pulse_organisation_bundle_v1`); Export / Import buttons allow syncing the bundle as a `.json` file; `data/pulse-organisation-default.json` is the seed template.
- **Sections:** Company profile (name, description, website, logo upload), Facilities list (add / edit / delete; each facility has slug, name, description, address, manager), Hardware per facility (machine name, operations array, daily capacity, notes).
- Facility slugs/names defined here are the **source of truth** for the Personnel facility dropdown (polled via `_waitForSupabaseClient()`; falls back to `FACILITIES` constant).

### 9.6 Seeds and migrations

SQL under **`supabase/migrations/`** — run in numeric order:

| Migration | Purpose |
|-----------|---------|
| 001–007 | Core schema: enums, `orders`, `order_workflow_steps`, `profiles`, `machines`, `materials`, RLS policies. |
| 008 | Seed auth users for demo/dev (operators + admin). |
| 009–014 | Incremental column additions and RLS refinements. |
| 015 | Add secondary admin auth user (`admin@bazaar-admin.com`). Idempotent. |
| 016 | **Destructive utility** — wipes all orders and order-related audit rows (`activity_log`, `invoices`, `orders` + cascades). Preserves profiles, customers, machines, leads. Apply only for a clean-slate reset. |
| 017 | Add `organisations`, `organisation_facilities`, `organisation_hardware` tables with RLS + `org-assets` storage bucket. Seeds two default facilities and all known machines with capacity defaults. |
| 018 | Add `organisations.website_url TEXT` column. |
| 019 | Add `organisation_facilities.address TEXT NOT NULL DEFAULT ''` column. |
| 020 | Add `organisation_facilities.manager_id UUID` FK → `profiles(id) ON DELETE SET NULL`; creates index. |

---

## 10. How to regenerate the same software (checklist)

1. **Implement** Postgres (or compatible) schema from migrations: orders + workflow_steps + profiles + ancillary tables (dies, inventory, invoices, organisation_facilities, organisation_hardware as scoped).
2. **Implement** session auth: Supabase mode uses **email + password** (`supabaseSignIn`); IndexedDB dev mode may use Name + User ID with static fallbacks.
3. **Ship** static HTML pages with **`shared.js`-equivalent**: theme injection, nav, breadcrumbs, badges, Supabase adapter (production) OR IndexedDB adapter (legacy dev) with **identical client order shape**.
4. **Implement `_applyRoleOverrides()`** pattern: on every `initAuth()` call, read `config.rolePermissions` from Supabase (or `localStorage.pulse_role_overrides` in IndexedDB dev) and patch the in-memory `ROLE_CONFIG`.
5. **Reproduce** **`job-ticket.html`** viewport-locked split, internal scroll panes, queue filters (**placed-date** semantics), **exclude `parentOrderId` rows from sidebar list**, navigator for multi-ticket families, save/lock/rush/hold/prepress-return flows.
6. **Reproduce** **`pages/dashboard.html`** grouping of parent/sub orders and operational widgets.
7. **Match operator / QC / shipping** transitions to the same **`status`** strings expected across reports and filters.
8. **Admin personnel modal**: in Supabase mode, provision via email + password + **`upsert_pulse_personnel`**; facility dropdown queries `organisation_facilities`.
9. **Organisation page dual-storage**: production uses Supabase tables; local JSON mode (`PULSE_ORG_STORAGE = 'local-json'`) delegates to `PulseOrgJsonStore`. Seed with `data/pulse-organisation-default.json`.
10. **Config template**: ship `js/pulse-config.local.js.example`; gitignore `js/pulse-config.local.js`.
11. **Multi-user Realtime**: subscribe in `supabase-client.js`, bridge via `onDBUpdate()`; no order-list polling on dashboard/job-ticket.

---

## 11. Naming & branding strings

- Product name: **Pulse**; subtitle / nav: **Bazaar Printing** / **UX Preview** build tag on nav.

---

---

## 12. Change log (major updates)

| Date | Change |
|------|--------|
| 2026-06-09 | **Admin Personnel email UX** — table **Email** column; modal login-email hint; duplicate-email validation (UI + migration **049**). `pulsePersonnelLoginEmail()` exported from `auth.js`. |
| 2026-06-09 | **Supabase Realtime multi-user sync** — removed dashboard/job-ticket polling; Realtime push via `supabase-client.js` + `onDBUpdate`. Migration **048** for reference-table publication. See [`production-status.md`](../supabase/production-status.md). |
| 2026-06-09 | **Email + password login** (Supabase mode) in `auth.js`. |
| 2026-06-09 | **Supabase production cutover** — `PULSE_STORAGE_BACKEND = 'supabase'`. Migrations 046, 047a/b/c. |
| 2026-05-18 | **Product Workflow Configuration** — Admin tab to define per-product manufacturing routes (`machines`, `product_workflows`, migrations 022–023). See [`product-workflow-config.md`](product-workflow-config.md). |
| 2026-06-09 | **Repo layout** — HTML in `pages/`, JS in `js/`; path helpers `pulsePage()` / `pulseJs()`; `_redirects` for legacy URLs. |
| 2026-05-12 | **Login (May 2025 experiment, superseded June 2026)** — brief Name + User ID UI; **current production** uses email + password again. |
| 2026-05-12 | **Roles & Permissions matrix** — replaced static table with interactive checkbox grid (rows=roles, columns=pages+special perms). Editable, saved to `rolePermissions` config + `localStorage`. Changes applied globally via `_applyRoleOverrides()` in `initAuth()`. |
| 2026-05-12 | **Personnel modal hardened** — required: Name, Role, User ID, Facility. Role dropdown removes Admin/Account Manager. Facility options loaded live from `organisation_facilities` (Supabase). Bulk Set User IDs action added. |
| 2026-05-12 | **david-review `adminTabs`** updated to include `roles` — David Zargaryan can now see the Roles & Permissions tab. |
| 2026-05-12 | **Organisation tab** embedded as iframe in admin; `organisation.html` manages company profile, facilities (address, manager), and hardware. Dual storage: Supabase (migrations 017–020) or local JSON via `PulseOrgJsonStore` (`organisation-local-store.js`). |
| 2026-05-12 | **`organisation-local-store.js`** added — localStorage bundle store for offline / local-JSON mode. Exported type `PulseOrgJsonStore` with `loadRaw`, `saveRaw`, `exportDownload`, `normalizeBundle`. |
| 2026-05-12 | **`data/pulse-organisation-default.json`** added — seed template for organisation offline mode. |
| 2026-05-12 | **`pulse-config.local.js.example`** added — documented config template with `PULSE_ORG_STORAGE` instructions and security notes. |
| 2026-05-12 | **`scripts/wipe-pulse-browser-macos.command`** added — macOS utility to clear all local Pulse data in one double-click. |
| 2026-05-12 | **Migrations 015–020** — secondary admin seed (015), orders wipe utility (016), organisation tables + storage bucket (017), website_url (018), facility address (019), facility manager FK (020). |

*(Removed from repo: `sdr-pipeline-portal.html` and other CRM/sales pages referenced in older changelogs.)*

---

*End of specification. Treat this document as authoritative for breadth; individual HTML files remain the literal source for field-level parity.*
