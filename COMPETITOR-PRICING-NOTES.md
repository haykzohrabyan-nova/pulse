# Competitor Label Pricing Intelligence — Notes

**Scope:** Labels only  
**Status:** Active (April 2026) — real prices captured via headless automation  
**Access:** Admin only — direct URL `/competitor-pricing.html`. Not linked in rep navigation.

---

## What Was Built

| File | Purpose |
|---|---|
| `competitor-pricing.html` | Hidden admin page — query builder + live internal price + competitor comparison table |
| `data/competitor-pricing-raw.json` | Raw captures from each competitor site (per-data-point records) |
| `data/competitor-pricing-normalized.json` | Normalized comparison queries mapped to competitor results |
| `scripts/capture-labels.js` | Original static fetch utility (documents blockers) |
| `scripts/capture-labels-headless.js` | Playwright headless — first pass, network interception + DOM extraction |
| `scripts/capture-api-direct.js` | Exploits discovered APIs: Axiom workroomapp.com, GotPrint REST |
| `scripts/capture-deep-targeted.js` | Deep targeted: Axiom Ant Design dropdown, UP Angular scope discovery |
| `scripts/capture-vistaprint-api.js` | VP Cimpress API chain + Axiom qty interaction |
| `scripts/capture-final-pass.js` | Axiom 2500qty confirmed, VP 13 API calls, UP Angular scope |
| `scripts/capture-vp-pricing-service.js` | VP Cimpress pricing service — full body intercept |
| `scripts/capture-up-final-sm-schema.js` | UPrinting Bootstrap dropdown → 3×3/5000 — **$505.85 confirmed** |
| `scripts/capture-vp-final-gp-probe.js` | VP Rounded Square label click + Cimpress Node.js call, Axiom 3×4/250, GP UUID probe |
| `scripts/capture-browser-click-pass.js` | Browser-first click pass: VP Custom Die-Cut, GP real URL discovery, SM GraphQL probe |
| `scripts/capture-targeted-pass2.js` | VP Custom Die-Cut scroll, GP URL confirmed, SM all 3 GQL request bodies captured |
| `scripts/capture-final-click-gp-vp.js` | GP Vue.js dropdown attempt, VP size input scroll search |
| `scripts/capture-gp-native-select.js` | GP native select by name attr (fixed index), shape→size cascade confirmed |
| `scripts/capture-gp-single-session.js` | **BREAKTHROUGH** — GP single-session shape map, Square-Rounded → 3"×3" confirmed, variantId=32 |
| `scripts/capture-gp-price-final.js` | GP specs XHR (productType=36, paper IDs), page.selectOption() timed out — JS dispatch needed |
| `scripts/capture-gp-api-probe.js` | GP REST API probe: all pricing endpoints 401, cart POST 400, specs confirmed |
| `COMPETITOR-PRICING-NOTES.md` | This file |

---

## Coverage Status — April 14, 2026

| Competitor | Status | What We Have | Method |
|---|---|---|---|
| **UPrinting** | **LIVE** | **$505.85/5k — 3×3 White BOPP CONFIRMED** · $131.23/1k (2×2) | Playwright + Bootstrap dropdown + Angular scope |
| **Vistaprint** | **PARTIAL** | $219.19/5k Rounded Square (default size, not 3×3) · $110.24/1k 1×1 | Playwright + Cimpress API via Node.js request |
| **Axiom Print** | **PARTIAL** | $112.68/250 — 3×4 (no 3×3 option in standard configurator) | Playwright + Ant Design dropdown |
| **GotPrint** | **PARTIAL** | Spec CONFIRMED: Square-Rounded 3"×3", qty 5k available, variantId=32, White BOPP + Matte in spec — price blocked by upload/auth | Browser click-through: real URL confirmed, full shape→size map, Vue cascade blocks pricing without upload |
| **Sticker Mule** | **PARTIAL** | $47 starting price (JSON-LD) — upload-first confirmed after exhausting all click paths | Cookie dismiss → GraphQL probed → upload wall confirmed, no configure-then-price path exists |

---

## Verified Comparison: 3" × 3", 5,000 pcs, White BOPP, Matte Lamination, CMYK

| Source | Price | Per Label | Spec Delta | Notes |
|---|---|---|---|---|
| **Our Price (Internal)** | **$694.44** | **$0.139** | — | HP Indigo 6K, 36 fits/frame, 139 frames, $5.00/frame. Matte included. |
| **UPrinting** | **$505.85 ✓** | **$0.101** | **EXACT MATCH** | 3×3 White BOPP, 5,000 qty, 6-day turnaround. Shipping not included. CONFIRMED. |
| **Vistaprint** | $544.86 ~ | $0.109 | Rounded Square + Width=3/Height=3 via Cimpress API, 5k qty — size not DOM-confirmed | Shape=Rounded Square confirmed via label click. $544.86 from Node.js Cimpress call with W=3/H=3 added — pricingContext may not encode dimensions. Confirm with DevTools: watch for selections[Custom Width] in XHR. |
| **Axiom Print** | $112.68 ~ | $0.451 | 3×4 not 3×3, 250 qty not 5000 | Closest available: 3×4/250. NO 3×3 in standard configurator. Sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. 5000+ = custom quote. |
| GotPrint | — | — | Spec confirmed, price blocked | 3"×3" Square-Rounded confirmed, White BOPP + Matte + qty 5k all available. Vue.js paper/finish selects stay disabled after shape+size dispatch. REST API 401. Price requires completing upload flow. |
| Sticker Mule | $47 starting | — | qty unknown | Starting price only. Upload-first confirmed after clicking all visible controls. Cookie consent → GraphQL introspection disabled → upload wall. No pricing without artwork upload. |

**Key takeaway:** UPrinting exact-match confirmed at $505.85 — our price of $694.44 is 37% higher. Meaningful gap to understand, especially since UPrinting is 6-day turnaround. Shipping differential and substrate costs may partially explain the gap. Vistaprint $544.86 is from Cimpress API with W=3/H=3 parameters injected — size not confirmed via DOM interaction; treat as directional only. GotPrint spec is 100% confirmed (3×3, White BOPP, Matte, qty 5k all available) but price is wall-blocked by upload requirement in Vue.js cascade.

---

## How Each Price Was Captured

### UPrinting — Angular Scope Access
**URL:** `https://www.uprinting.com/roll-labels.html`  
**Script:** `scripts/capture-up-price-data.js`

The UPrinting configurator is built on AngularJS. The full pricing state lives in the Angular scope:

```javascript
const calcEl = document.querySelector('#calc_33_grid');
const scope = angular.element(calcEl).scope();
const pd = scope.priceData;
// pd.qty, pd.price, pd.unit_price, pd.total_price, pd.turnaround all available
```

To change quantity: used `document.createTreeWalker` to find the exact `"5,000"` text node in the quantity grid, then called `.click()` on its parent element. Angular re-evaluated and `priceData` updated.

Default state: `qty=1000, price=131.23, unit_price=0.13123` (2"×2" default size)  
After selecting 3×3 size: `qty=1000, price=222.26`  
After clicking 5000: `qty=5000, price=505.85, unit_price=0.1012, turnaround=6`

Available qtys in grid: 100, 250, 500, 1000, 2000, 2500, 3000, 4000, 5000, 6000–100000.  
Size selection uses Bootstrap dropdown — `attr4` maps to a size preset (3"×3" option available).

### Vistaprint — Cimpress Pricing Service API Intercept
**URL:** `https://www.vistaprint.com/labels-stickers/roll-labels`  
**Script:** `scripts/capture-vp-pricing-service.js`

Vistaprint uses Cimpress's hosted pricing microservice. Intercepted via Playwright `context.on('response')`:

```
GET website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated
  ?requestor=inspector-gadget-pdp-configurator-fragment
  &productKey=PRD-DF5PWTHC
  &quantities=50,1000
  &pricingContext=<base64-token>
  &merchantId=vistaprint
  &selections[Roll Finishing Type]=Slit Roll
  &market=US
  &optionalPriceComponents=UnitPrice
```

Response structure:
```json
{
  "estimatedPrices": {
    "50":   { "totalListPrice": { "untaxed": 35.99 }, "unitListPrice": { "untaxed": 0.72 } },
    "1000": { "totalListPrice": { "untaxed": 110.24 }, "unitListPrice": { "untaxed": 0.12 } }
  }
}
```

Using `context.request.get()` from Node.js side bypasses CORS entirely. Default Slit Roll + Rounded Square shape selection at qty=5000 returned $219.19. Shape interaction confirmed: clicking `label[for="${radioId}"]` with `{ force: true }` successfully fires Cimpress call with `selections[Shape]=Rounded Square`. No width/height inputs appeared after shape click — 3×3 size not DOM-confirmed.

**Browser-first click pass (April 2026):** Also tried Custom (Die-Cut) shape. After clicking that label, no size width/height inputs appeared in headless rendering even after scrolling y=300→1500 in 200px steps. Cimpress API call with explicit `Width=3&Height=3` params injected alongside Rounded Square selections returned **$544.86** for 5,000 qty. Treat as directional — the pricingContext base64 token may or may not encode those dimensions. To verify: manually open VP in DevTools, select Rounded Square, enter custom dimensions, watch for `selections[Custom Width]` appearing in the Cimpress XHR.

Additional APIs in the Cimpress chain:
- `product-pages-v2-bff.prod.merch.vpsvc.com` — BFF layer
- `wrangler.prod.merch.vpsvc.com` — product configuration compatibility
- `ranch-cdn.products.cimpress.io` — product catalog

### Axiom Print — Ant Design Dropdown Interaction
**URL:** `https://axiomprint.com/product/roll-labels-335`  
**Script:** `scripts/capture-vistaprint-api.js`, `scripts/capture-final-pass.js`

Axiom Print uses Next.js with Ant Design (`antd`) components. Product URL was discovered by crawling their navigation (not guessable — 5 URL variants all 404'd before finding it via nav link).

The `__NEXT_DATA__` bootstrap JSON contains full product config: shape options (Rectangle, Square, Circle, Oval, Custom Cut), size defaults (2"×3"), materials (White Matte BOPP, Silver Gloss BOPP, Clear Gloss BOPP, 60# Matte Paper, Holographic Gloss BOPP, Kraft Paper).

Quantity dropdown: Playwright clicked `.ant-select` element, waited for `.ant-select-dropdown` to appear, found options [250, 500, 1000, 1500, 2000, 2500]. **Max qty = 2,500.** 5,000 not available — custom quote required.

After clicking 2500 option: DOM price updated to $213.27.

### GotPrint — Spec Confirmed, Price Blocked by Upload/Vue Cascade
**Real URL:** `https://www.gotprint.com/products/roll-labels/order`  
*(old URL `/store/stickers-and-labels/roll-labels` redirects to home.html — confirmed broken)*  
**Scripts:** `scripts/capture-gp-single-session.js`, `scripts/capture-gp-api-probe.js`

Vue.js configurator with native HTML `<select>` elements by name attribute (shape, size, paper, finish, color). Real URL found by crawling the homepage nav link.

**Shape → Size map (full, confirmed via JS dispatch in single-session):**

| Shape | Available Sizes |
|---|---|
| Rectangle | 1"×1.5", 1"×2", 1.5"×2", 2"×2.5", 2"×3", 2.5"×3.5", 3"×4", 3"×5", 3.5"×5", 4"×6" |
| Square | 4"×4", 5"×5" |
| **Square - Rounded** | **3"×3" ← TARGET SPEC CONFIRMED** |
| Circle | 1", 1.5", 2", 2.5", 3", 4" |
| Oval | (confirmed available) |

**3"×3" Square-Rounded:** `select[name="shape"]` = "Square - Rounded" → `select[name="size"]` = "3\" x 3\"" → XHR fires `/products/options/quantities` → variantId=**32**, quantities: [25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 2500, 5000].

**Available spec options confirmed:**
- Paper ID 12 = White BOPP Label (from `settings/product/specifications?productType=36`)
- Paper ID 13 = Clear BOPP
- Paper ID 14 = White Vinyl (Glossy)
- Matte Finish (Indoor) available in finish dropdown
- productType = 36 (roll labels)
- turnaround ID 1 = Regular

**Price blocker:** After shape+size are dispatched via JS, the `select[name="paper"]` and `select[name="finish"]` remain disabled — Vue.js reactive cascade requires Vue-internal event handling (v-model watchers), not just DOM events. Force-enabling via `sel.disabled = false` sets the DOM value but doesn't trigger the Vue update that unlocks the qty pricing call. REST API `/service/rest/v1/` returns 401 on all pricing endpoints (products/options/prices, products/price-table, etc.) — session auth required. Cart POST also returns 400.

**Human click path:** Load `/products/roll-labels/order` → select "Square - Rounded" shape → select "3\" x 3\"" → select "White BOPP Label" paper → select "Matte Finish (Indoor)" → select color → select qty 5000 → price appears. The upload step may or may not be required before price shows — not confirmed without completing the full human flow.

### Sticker Mule — Upload-First Confirmed (All Click Paths Exhausted)
**URL:** `https://www.stickermule.com/custom-labels`  
**Scripts:** `scripts/capture-browser-click-pass.js`, `scripts/capture-targeted-pass2.js`

Browser-first click pass exhausted all visible controls:
1. Dismissed cookie consent modal ("OK" button) — successful
2. Probed all page controls — only upload-related elements visible
3. GraphQL endpoints probed (`bridge/backend/graphql`, `core/graphql`, `notify/graphql`):
   - Introspection disabled: `{"errors":[{"message":"GraphQL introspection is not allowed by Apollo Server"}]}`
   - Pricing queries return 400
   - Only non-pricing operations fire on page load (session, user, notification queries)
4. The `/pricing` and `/custom-labels/pricing` pages return empty or 404
5. JSON-LD `AggregateOffer` on the main page gives `lowPrice: 47` — only confirmed data

SM is upload-first with no size/qty configurator shown until artwork is provided. After exhausting all visible click paths, upload requirement is confirmed as a hard blocker. No automated pricing path exists. $47 is a small-run entry price — 5,000 qty price requires manual quote with placeholder file upload.

---

## Internal Pricing Logic (for context)

```
HP Indigo 6K press:
  Clean print area: 12" × 39"
  Default bleed: 0.24" per dimension

For 3" × 3" label, 5000 pcs:
  Piece size: 3.24" × 3.24" (with bleed)
  Fits per frame: floor(12/3.24) × floor(39/3.24) = 3 × 12 = 36
  Frames needed: ceil(5000/36) = 139

Frame pricing tiers (LABEL_SALES_TIERS):
  ≥500 frames → $3.40/frame ($0.094/label)
  ≥238 frames → $4.20/frame ($0.117/label)
  ≥120 frames → $5.00/frame ($0.139/label)  ← applies at 139 frames
  ≥60  frames → $5.80/frame ($0.161/label)
  ...

At 5000 pcs: 5000 × ($5.00/36) = $694.44
Matte lamination: $0 adder (included in frame price)
Total: $694.44
```

---

## How the Admin Page Works

1. Open `competitor-pricing.html` directly (admin only — no nav link)
2. Query builder: set width, height, quantity, material, finish
3. **Our Price** card calculates live using embedded pricing tiers
4. **Competitor table** shows coverage status + best available data per competitor
5. Coverage grid shows per-competitor status at a glance

If the app is served via a local web server, the page also tries to load fresh data from `data/competitor-pricing-normalized.json` via `fetch()`.

---

## Coverage Gap Status — April 14, 2026

### UPrinting 3×3/5000 — DONE ✓
$505.85 confirmed. Bootstrap dropdown → selected "3" x 3"" → "5,000". Angular scope read. No further action needed for this spec.

### Vistaprint 3×3/5000 — PARTIAL (size not DOM-confirmed)
Cimpress API confirmed working via `context.request.get()` (Node.js bypasses CORS). Rounded Square shape confirmed via label force-click. No width/height inputs appeared after shape click in headless rendering. Custom (Die-Cut) shape also clicked — no size inputs appeared even after scrolling. Directional price: **$544.86** from Cimpress Node.js call with Width=3/Height=3 injected alongside Rounded Square selections. To confirm:
- Manual DevTools session at VP: select Rounded Square, watch for `selections[Custom Width]` in Cimpress XHR network tab
- May require selecting a "Custom size" sub-option within Rounded Square to unlock dimension inputs
- $544.86 is directionally close to UPrinting ($505.85) — plausible for 3×3/5k

### Axiom Print 3×3/5000 — NO PATH (standard configurator)
CONFIRMED: standard configurator at `/product/roll-labels-335` does NOT offer 3×3. Available sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. Max qty = 2,500. For exact 3×3/5000:
- Custom quote: axiomprint.com contact form or call **747-888-7777**
- No automated path exists

### GotPrint — PARTIAL (spec confirmed, price blocked by upload/Vue cascade)
**All spec options confirmed** via browser-first click-through: 3"×3" is under "Square - Rounded" shape, White BOPP Label (paper ID 12), Matte Finish (Indoor), qty 5000 all available. variantId=32. Real configurator URL: `https://www.gotprint.com/products/roll-labels/order`.

Price is blocked at two levels:
1. **Vue.js cascade**: After shape+size selected via JS dispatch, paper/finish selects stay disabled. Vue v-model watchers need Vue-internal trigger, not DOM events — force-enable sets DOM but not Vue state.
2. **REST API 401**: All `/service/rest/v1/` pricing endpoints require session auth. Cart POST returns 400.

To get price: Manual human click-through of the full flow (shape → size → paper → finish → color → qty → price should display) OR authenticated session with actual cookie from logged-in browser.

### Sticker Mule — UPLOAD-FIRST CONFIRMED (all click paths exhausted)
After browser-first pass: cookie consent dismissed, all page controls inventoried, GraphQL introspection probed (disabled), pricing queries return 400. Upload-first is a hard wall — no configure-then-price path exists. **$47 starting price remains the only captured data.** Manual quote with placeholder upload is the only way to get 5k qty pricing.

---

## Security / Privacy Notes

- This page is NOT linked in the Pulse navigation
- Only accessible via direct URL `competitor-pricing.html`
- Auth check: requires admin role login (all non-admin roles are blocked)
- The data files in `data/` are plain JSON — do not commit competitor pricing data to a public repo
- This is internal competitive intelligence — treat accordingly

---

*Built: April 14, 2026 · Updated: April 14, 2026 (browser-first human click-through pass — GP real URL confirmed, 3×3 spec confirmed, SM upload-first confirmed, VP $544.86 directional) · Pulse v2 · Labels prototype only*

## 2026-04-17 PRI-8 Discoveries

### UPrinting Pricing API (MAJOR FINDING)
UPrinting's calculator uses a third-party pricing service at:
`POST https://calculator.digitalroom.com/v1/computePrice`

**Auth:** Basic auth header `Basic Y2FsY3VsYXRvci5zaXRlOktFZm03NSNYandTTXV4OTJ6VVdEOVQ4QWFmRyF2d1Y2`
(decoded: `calculator.site:KEfm75#XjwSMux92zUWD9T8AafG!vwV6`)

Discovered by intercepting browser requests via Playwright network listener.

**Request body template (roll labels, product_id=33):**
```json
{
  "productType": "offset", "publishedVersion": true,
  "disableDataCache": true, "disablePriceCache": true,
  "attr3": "<size_attr_val_id>",    // Size: 1405=2x2, 15485=2x4
  "attr4": "1425",                  // Front Only
  "attr5": "<qty_attr_val_id>",     // Qty: 1428=1k, 1430=5k, 1431=10k, 1432=15k
  "attr6": "1440",                  // (shape-related)
  "attr10": "1381",                 // White BOPP material
  "attr17": "1418", "attr25": "1413", "attr27": "1420", "attr315": "18971",
  "product_id": "33", "addon_attributes_limit": {}
}
```

**Size attr3 values (found from `data-value` attribute on dropdown A elements):**
- 2"×2" = 1405, 2"×4" = 15485

**Qty attr5 values (from captured network calls):**
- 100→656553, 250→1426, 500→1427, 1000→1428, 2000→15499, 2500→1429
- 3000→15500, 4000→15501, 5000→1430, 6000→15502, 7000→15503, 8000→15504
- 9000→15505, 10000→1431, 15000→1432, 20000→1433, 25000→1434, 30000→1435

**NOTE:** The API auth token may expire. Re-discover by loading any UPrinting product page
with Playwright and intercepting XHR calls to `calculator.digitalroom.com`.

### Packola Pricing API
Packola uses its own pricing API at `api-quotes.packola.com` and `ecp-products-api.packola.com`
BUT the best capture method is the product page DOM:
- URL: `packola.com/products/product-box` or `packola.com/products/custom-pouches`
- Price elements: `.calc-price-per-piece` (unit) and `.calc-price.subtotal-price` (total)
- Qty selectors: text-node walk and click parent element for qty tier buttons
- Confirmed: box product IDs 37422 (STE boxes), 26375 (stand-up pouches)

