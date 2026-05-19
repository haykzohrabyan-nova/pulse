# Product Workflow Configuration

Per-product **manufacturing routes** in Pulse: which machines a job visits, in what order, with optional conditions and PM swap rules.

This is separate from:

| Area | What it defines |
|------|-----------------|
| **Admin → Products** | Catalog metadata: materials, finishing options, color modes |
| **Admin → Machines** | Daily capacity / scheduling settings per machine **name** |
| **Admin → Product Workflow Configuration** | Production **route** (machine sequence) per catalog product |
| **`WORKFLOW_TEMPLATES` in `shared.js`** | Legacy fine-grained templates (still used as fallback on job tickets) |

---

## Overview

```text
Admin configures route (per catalog product)
        ↓
Job ticket resolves route from DB + job options (lamination, cut method, material, UV/foil)
        ↓
order.workflowSteps[] created with display machine names + alternativeMachines[]
        ↓
Operators / dashboard / PM use existing step pipeline
        ↓
PM may swap a step only to machines in alternatives[] → logged to workflow_override_log
```

---

## Database (Supabase)

Apply migrations in order:

| Migration | Purpose |
|-----------|---------|
| [`022_product_workflows.sql`](supabase/migrations/022_product_workflows.sql) | `machines` registry (18 seeded slugs) + `product_workflows` (JSONB `steps[]`) + RLS |
| [`023_workflow_override_log.sql`](supabase/migrations/023_workflow_override_log.sql) | Audit log when PM swaps a step machine |

### `machines`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Slug, e.g. `press-6k`, `gm-die-cutter` |
| `name` | TEXT | Short name |
| `display_name` | TEXT | UI label (matches `MACHINES` keys in `shared.js`) |
| `facility` | TEXT | `16th` \| `boyd` |
| `category` | TEXT | `press`, `lamination`, `cutting`, `finishing`, `pouching`, `folding` |
| `capabilities` | TEXT[] | Tags for filtering |

### `product_workflows`

| Column | Type | Notes |
|--------|------|-------|
| `product_catalog_id` | TEXT UNIQUE | Links to Admin → Products catalog entry `id` |
| `product_name` | TEXT | Denormalized display name |
| `primary_facility` | TEXT | `16th` \| `boyd` |
| `steps` | JSONB | Array of step objects (see below) |

### Step object (JSONB)

```json
{
  "machineId": "press-15k",
  "stepType": "default",
  "sortOrder": 1,
  "alternatives": ["canon-colorado", "roland"],
  "conditionField": null,
  "conditionOp": null,
  "conditionValue": null,
  "notes": null
}
```

| `stepType` | Behavior |
|------------|----------|
| `default` | Always included when route is resolved |
| `conditional` | Included only when condition matches job options |
| `optional` | Excluded unless explicitly requested (reserved; not used on job ticket today) |

**Condition fields** used in defaults (`shared.js` → `buildProductWorkflowJobOptions`):

| Field | Source on job ticket |
|-------|----------------------|
| `cutMethod` | `cutMethod` select (`gm-die` / `die-cut` → `die`, laser paths → `laser`, `karlville` → `laser`) |
| `lamination` | `none` or normalized lamination value when “has lamination” is on |
| `materialFinish` | `gloss` / `matte` inferred from material name |
| `hasScodixFinishing` | `true` when UV, foil, or emboss is selected |

**Operators:** `equals`, `not_equals`, `in` (comma-separated list in `conditionValue`).

### `workflow_override_log`

| Column | Notes |
|--------|-------|
| `order_id` | UUID → `orders.id` |
| `step_index` | 0-based index in `workflowSteps` |
| `original_machine` / `new_machine` | Display names |
| `original_machine_id` / `new_machine_id` | Slugs when known |
| `changed_by` | From `getCurrentName()` |
| `reason` | PM notes |

---

## Code map

| File | Role |
|------|------|
| [`shared.js`](shared.js) | `PRODUCT_WORKFLOW_DEFAULTS`, `getDefaultProductWorkflowForCatalogName()`, `resolveProductWorkflowSteps()`, `buildProductWorkflowJobOptions()`, `workflowStepsFromResolvedConfig()`, `MACHINE_SLUG_TO_DISPLAY` |
| [`supabase-client.js`](supabase-client.js) | `getAllMachines`, `getProductWorkflowByCatalogId`, `upsertProductWorkflow`, `seedProductWorkflowsFromDefaults`, `logWorkflowOverride` |
| [`admin.html`](admin.html) | Tab **Product Workflow Configuration** — edit routes per catalog product |
| [`job-ticket.html`](job-ticket.html) | Loads + resolves route; **Production route** preview; save builds `workflowSteps` from config |
| [`production-manager.html`](production-manager.html) | **Swap** button (only if alternatives exist); dropdown limited to allowed machines |

---

## Admin UI

**Path:** Admin → **Product Workflow Configuration**

1. Left: catalog products (search, badges: Configured / Not configured / **Pending route** for unmapped defaults).
2. Right: step list with reorder (↑↓), Edit (type, condition, alternatives), Add Step, **Reset to Default**, **Save**.
3. **Primary facility** dropdown (`16th` / `boyd`) stored on the workflow row.

On first tab load, `seedProductWorkflowsFromDefaults()` inserts rows for catalog products that have no DB row yet, using `PRODUCT_WORKFLOW_DEFAULTS`.

**Validation:**

- At least one step.
- Conditional steps require field, operator, and value.
- Alternatives must be same `category` as the primary machine.

If tables are missing, the tab shows an error pointing at migration `022`.

---

## Job ticket behavior

When product type or related options change (`autoDetectWorkflow` → `applyProductWorkflowFromConfig`):

1. Find catalog product: `_jtProductCatalog.find(p => p.name === productType)`.
2. Load workflow: `getProductWorkflowByCatalogId(id)` or `getDefaultProductWorkflowForCatalogName(name)`.
3. Build options: `buildProductWorkflowJobOptions({ cutMethod, lamination, hasUV, hasFoil, material, … })`.
4. Resolve: `resolveProductWorkflowSteps(steps, jobOptions)`.
5. Preview: `#workflowRoutePreview` lists machines (source: Admin config / Default template / Legacy auto-detect).
6. On save: `buildWorkflowStepsForSave()` → `workflowStepsFromResolvedConfig()` (sets `machine`, `machineId`, `alternativeMachines`).

**Legacy fallback:** If no config steps resolve, the old `WORKFLOW_TEMPLATES` + `legacyAutoDetectWorkflowKey()` path still runs.

**Hidden field:** `workflowTemplate` may be set to `product-workflow:<catalogId>` when using the new system.

**Boyd perforation:** When facility is Boyd and perforation is checked, production hints show **MANUAL SETUP REQUIRED** (Graphtec knife setup).

---

## Production Manager

- **Swap** appears only when the step has `alternatives` or `alternativeMachines`.
- Machine dropdown lists **only** allowed alternatives (not all facility machines).
- Full redirect updates the step and calls `logWorkflowOverride()`.
- Activity log entry still written via `addActivity()`.

---

## Default product families

Seeded in `PRODUCT_WORKFLOW_DEFAULTS` (`shared.js`), mapped from catalog names via `CATALOG_NAME_TO_DEFAULT_KEY` and regex partials:

| Key | Typical catalog name |
|-----|----------------------|
| `labels-roll` | Labels (Roll) |
| `labels-sheet` | Labels (Sheet) |
| `pouches` | Pouches |
| `boxes` | Folding Cartons / Boxes |
| `business-cards` | Business Cards |
| `flyers` | Flyers / Postcards |
| `booklets` | Booklets |
| `diecut-stickers` | Diecut Stickers |
| `vinyl-labels` / `vinyl-signage` / `banners` / `window-decals` / `wallpaper` | Boyd vinyl / signage products |
| `boyd-sheets` | Sheet products (Boyd) |
| `placeholder` | Unknown custom names (flagged **Pending route** in Admin) |

---

## Deploy checklist

1. Apply migrations **022** and **023** on Supabase (see [`deploy/RELEASE-CHECKLIST.md`](deploy/RELEASE-CHECKLIST.md)).
2. Open Admin → Product Workflow Configuration; confirm products seeded; adjust routes; Save.
3. Create a test job ticket; confirm **Production route** preview updates when changing lamination / cut method.
4. In Production Manager, open a job with alternatives on a step; confirm Swap is limited and saves.

---

## Open items (business confirmation)

The Admin tab notes **4 routes pending Hayk confirmation** (from the Nova/Hayk spec). Do not hard-code final behavior until confirmed:

1. Variable data labels — always GM Laser vs optional die  
2. Kiss cut stickers — laser vs die  
3. Plain (no-print) jobs — skip press?  
4. Cardstock at Boyd — standard Roland/Colorado → laminator → flatbed exceptions  

---

## Related docs

- [`WORKFLOW-SPEC.md`](WORKFLOW-SPEC.md) — operational flows by facility (Boyd vs 16th)  
- [`Description`](Description) — project overview; Admin tab inventory  
- [`supabase/SCHEMA.md`](supabase/SCHEMA.md) — full schema reference  
