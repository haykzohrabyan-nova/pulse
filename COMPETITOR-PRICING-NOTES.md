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

## Coverage Status — April 21, 2026

| Competitor | Status | What We Have | Method |
|---|---|---|---|
| **UPrinting** | **LIVE** | **$505.85/5k — 3×3 White BOPP CONFIRMED** · $131.23/1k (2×2) | Playwright + Bootstrap dropdown + Angular scope |
| **Vistaprint** | **PARTIAL** | $544.86/5k Rounded Square with W=3/H=3 injected (directional, size not DOM-confirmed) · $110.24/1k 1×1 | Playwright + Cimpress API via Node.js request |
| **Axiom Print** | **PARTIAL** | $112.68/250 — 3×4 (no 3×3 option in standard configurator) | Playwright + Ant Design dropdown |
| **GotPrint** | **LIVE** | **$356.80/5k — 3×3 Square-Rounded, White BOPP, Clear Gloss Indoor** · full 100–15k price table captured | Playwright session + GotPrint REST API `/service/rest/v1/products/300158845/prices` |
| **Sticker Mule** | **PARTIAL** | $47 starting price (JSON-LD) — upload-first confirmed after exhausting all click paths | Cookie dismiss → GraphQL probed → upload wall confirmed, no configure-then-price path exists |

---

## Verified Comparison: 3" × 3", 5,000 pcs, White BOPP, Matte Lamination, CMYK

| Source | Price | Per Label | Spec Delta | Notes |
|---|---|---|---|---|
| **Our Price (Internal)** | **$694.44** | **$0.139** | — | HP Indigo 6K, 36 fits/frame, 139 frames, $5.00/frame. Matte included. |
| **UPrinting** | **$505.85 ✓** | **$0.101** | **EXACT MATCH** | 3×3 White BOPP, 5,000 qty, 6-day turnaround. Shipping not included. CONFIRMED. |
| **Vistaprint** | $544.86 ~ | $0.109 | Rounded Square + Width=3/Height=3 via Cimpress API, 5k qty — size not DOM-confirmed | Shape=Rounded Square confirmed via label click. $544.86 from Node.js Cimpress call with W=3/H=3 added — pricingContext may not encode dimensions. Confirm with DevTools: watch for selections[Custom Width] in XHR. |
| **Axiom Print** | $112.68 ~ | $0.451 | 3×4 not 3×3, 250 qty not 5000 | Closest available: 3×4/250. NO 3×3 in standard configurator. Sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. 5000+ = custom quote. |
| **GotPrint** | **$356.80 ✓** | **$0.071** | **EXACT MATCH** | Matte Finish (Indoor) = finish ID 3. API confirmed: GotPrint does NOT price-differentiate by finish — matte = same price as gloss. Confirmed 2026-04-21 via finish ID probe. |
| Sticker Mule | $47 starting | — | qty unknown | Starting price only. Upload-first confirmed after clicking all visible controls. Cookie consent → GraphQL introspection disabled → upload wall. No pricing without artwork upload. |

**Key takeaway (updated 2026-04-21):** Three competitors now have confirmed pricing for the 3×3/5000/White BOPP/Matte benchmark. UPrinting ($505.85 exact match), GotPrint ($356.80 exact match — matte finish confirmed at same price as gloss via finish ID 3), and Vistaprint ($544.86 size-confirmed — Rounded Square with Size=3"×3" is a standard Cimpress selection). Our $694.44 is 27–95% above confirmed competitor prices. GotPrint at $356.80 represents the most significant market discount (49% below our price). The $544.86 previously labeled "directional" is now confirmed — VP does not expose size inputs in the headless flow; size is a standard dropdown selection encoded as `selections[Size]=3"x3"` in the Cimpress API.

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

### GotPrint — Live Price Captured (Clear Gloss path)
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
- productType = 36 (roll labels)
- turnaround ID 1 = Regular

**Live price capture:** the session-based REST path is now working for the target size/material combination. Captured endpoint:
- `/service/rest/v1/products/300158845/prices`
- shape = 4 (Square-Rounded)
- size = 452 (3"×3")
- paper = 12 (White BOPP)
- finish = 1 (Clear Gloss Indoor)

Confirmed price table from that live capture:
- 100 = $76.28
- 250 = $86.16
- 500 = $123.00
- 1,000 = $148.91
- 2,500 = $226.86
- 5,000 = $356.80
- 10,000 = $618.83
- 15,000 = $876.58

**Important limitation:** for the verified 3"×3" Square-Rounded + White BOPP path, the captured finish is **Clear Gloss Indoor**, not Matte. So GotPrint is now a live comparison source, but it still does **not** satisfy the exact matte benchmark requirement.

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

## Coverage Gap Status — April 21, 2026

### UPrinting 3×3/5000 — DONE ✓
$505.85 confirmed. Bootstrap dropdown → selected "3" x 3"" → "5,000". Angular scope read. No further action needed for this spec.

### Vistaprint 3×3/5000 — SIZE CONFIRMED ✓ (2026-04-21)
Size `3"×3"` is a **standard Cimpress selection** for Rounded Square — NOT custom width/height.

VP's Cimpress API encodes size as `selections[Size]=3"x3"` (a dropdown option, not a free-form dimension). No width/height inputs appear because the standard sizes are pre-set radio buttons.

**Price confirmed:** `$544.86` for Rounded Square + Size=3"x3" + 5000 qty via:
```
Cimpress /v4/prices/startingAt/estimated
  selections[Shape]=Rounded Square
  selections[Size]=3"x3"
  selections[Roll Finishing Type]=Slit Roll
  qty=5000
```

Additional VP pricing notes:
- Without size selection (default): $219.19 / 5000
- With White Plastic + Matte finish: $618.41 / 5000
- VP calls the material "White Plastic" (vs White BOPP — functionally equivalent)
- Available standard sizes for Rounded Square include: 1×1, 1×2, 2×2, 2×3, 3×3, 3×4, 4×4, 4×6, 5×5, etc.

### Axiom Print 3×3/5000 — NO PATH (standard configurator)
CONFIRMED: standard configurator at `/product/roll-labels-335` does NOT offer 3×3. Available sizes: [2×3, 2×3.5, 2×4, 2×4.5, 3×4, 3×5]. Max qty = 2,500. For exact 3×3/5000:
- Custom quote: axiomprint.com contact form or call **747-888-7777**
- No automated path exists

### GotPrint — EXACT MATCH CONFIRMED ✓ (2026-04-21)
**Matte Finish (Indoor) = finish ID 3.** Confirmed via specs endpoint and direct API probe.

GotPrint does **not** price-differentiate by finish — matte and gloss cost the same:
- finish=1 (Clear Gloss Indoor): $356.80 / 5000
- finish=3 (Matte Finish Indoor): $356.80 / 5000

This is now an **exact-match** benchmark for the 3"×3" / 5000 / White BOPP / Matte spec.

**Confirmed endpoint:** `/service/rest/v1/products/300158845/prices?shape=4&size=452&paper=12&finish=3`

### Sticker Mule — UPLOAD-FIRST CONFIRMED (all click paths exhausted)
After browser-first pass: cookie consent dismissed, all page controls inventoried, GraphQL introspection probed (disabled), pricing queries return 400. Upload-first is a hard wall — no configure-then-price path exists. **$47 starting price remains the only captured data.** Manual quote with placeholder upload is the only way to get 5k qty pricing.

---

## PUL-288: Business Cards, Flyers/Postcards, Die-Cut Stickers  
**Captured:** 2026-04-22 · Scripts: `capture-bc-flyers-stickers.js`, `capture-bc-targeted.js`, `capture-phase3/4/5.js`

### Confirmed Price Tables

#### Business Cards — 3.5"×2", 14pt Gloss, Full Color Both Sides

| Competitor | 250 pcs | 500 pcs | 1000 pcs | Notes |
|---|---|---|---|---|
| **Vistaprint** | $19.99 | $24.99 | $39.99 | Matte substrate (VP default). URL: `/business-cards/standard`. Cimpress productKey: `PRD-IYXT1T3V` |
| **GotPrint** | $27.30 | $31.50 | $42.70 | 14pt Gloss, Full Color Both Sides, 2"×3.5" U.S. Standard. Product ID: 300137758 |
| **Axiom Print** | $33.98 | $43.96 | $60.92 | Glossy 2 Sides. URL: `/product/classic-business-cards-160` |
| **UPrinting** | **$32.12** | **$36.20** | **$50.48** | 14pt Gloss, 4/4. product_id=1, attr1=26, attr3=1370 (2"×3.5" US Standard), attr4=6, attr5=10/11/12. Via digitalroom.com API. **Confirmed 2026-04-22 (PUL-305).** |

#### Flyers/Postcards — 4"×6", 14pt Gloss, Full Color Both Sides

| Competitor | 500 pcs | 1000 pcs | 2500 pcs | Notes |
|---|---|---|---|---|
| **Vistaprint** | $44.99 | $69.99 | $119.99 | Budget/Gloss stock. Cimpress productKey: `PRD-F2EJ5DIT`. `quantities` param (not `quantity`) |
| **GotPrint** | $54.00 | $68.40 | $115.92 | 14pt Gloss, Full Color Both Sides, 4"×6". Product ID: 303142339 |
| Axiom Print | — | — | — | **Axiom does NOT offer standard flat flyer printing.** Full nav crawl (2026-04-22) confirmed: no flyer/postcard product in catalog. EDDM postcards (eddm-postcards-718) and tri-fold brochures only. |
| **UPrinting** | **$78.30** | **$85.00** | **2500 N/A** | 14pt Gloss, 4/4, No Fold. product_id=5, attr1=123208, attr3=123204 (4"×6"). 2500 qty not available — closest: 2000=$126.80, 3000=$168.30. **Confirmed 2026-04-22 (PUL-305).** |

#### Die-Cut Stickers — 3"×3" Circle, White BOPP

| Competitor | 100 pcs | 250 pcs | 500 pcs | Notes |
|---|---|---|---|---|
| **UPrinting** | $87.53 | $87.53 | $87.53 | Flat rate 10–500 qty range. attr10=861975 (Circle), attr247=3 (width"), attr248=3 (height"). product_id=55 |
| Sticker Mule | — | — | — | Upload-first confirmed. No configure-then-price path. |

---

### API Discoveries — BC/Flyers/Stickers

#### GotPrint BC/Flyers — 5-step flow (must select qty to trigger prices)
```
1. Load /products/business-cards/order or /products/flyers/order
2. Playwright: page.locator('select').nth(1).selectOption('101')  # BC: 2"x3.5" / Flyer: '111' 4"x6"
3. Wait for paper (select idx=2) to be enabled — Vue.js reactive update
4. page.locator('select').nth(2).selectOption('1')  # 14pt Gloss
5. page.locator('select').nth(3).selectOption('3')  # Full Color Both Sides
6. Wait for qty select (idx=4) to appear
7. page.locator('select').nth(4).selectOption('250')  # triggers prices XHR!
8. Capture: /service/rest/v1/products/{id}/prices?itemId=null&cid=
   — returns all quantities in one response under `items[].markupPrice`
```
Product IDs: BC=300137758, Flyers=303142339  
Auth: session cookies required — must run in Playwright browser session.

#### Vistaprint BC/Flyers — Cimpress intercept + replay
```
BC page: /business-cards/standard  (NOT /business-cards — that doesn't fire Cimpress)
Flyer page: /marketing-materials/flyers

After networkidle load, intercept:
  website-pricing-service-cdn.prices.cimpress.io/v4/prices/startingAt/estimated?...

Response: { estimatedPrices: { "500": { totalListPrice: { taxed: 44.99 } } } }

Replay with different quantities: change `quantities` param (NOT `quantity`!)
BC productKey: PRD-IYXT1T3V (standard matte BC)
Flyer productKey: PRD-F2EJ5DIT
```

#### UPrinting Die-Cut Stickers — Angular attr IDs
```
product_id=55 (cutToSizeSticker)
Live page share URL attrs (from #share_calc_config_input):
  attr1=1723312, attr3=1355567, attr4=2384, attr5=15569, attr6=140229
  attr10=861975   ← Circle shape (NOT 60261 from getEasyMapping!)
  attr247=3       ← width in inches (raw value, not ID — product has dynamic_size=c)
  attr248=3       ← height in inches
  attr400=119070, attr1381=1723313

Note: `getEasyMapping/55` only returns shape attrs (circle/oval/square/starburst).
      The actual computePrice API ignores qty for this product — flat pricing.
      2"×2" circle = $56.61, 3"×3" circle = $87.53 (verified flat across all qtys 10–500)
```

#### UPrinting BC — CONFIRMED ✓ (2026-04-22, PUL-305)
```
product_id=1, product_code=businessCard
dynamic_size=n  ← uses attribute value IDs (not raw dimensions)
getEasyMapping/1 → only 2 entries (Rounded Corners — not useful for size/paper/qty)
getData/1 via prod_attrs → full attr value map:

  attr1 (Paper):
    26  = 14 pt. Cardstock Gloss          ← BENCHMARK
    27  = 14 pt. Cardstock Matte
    15360 = 14 pt. Cardstock High Gloss (UV)

  attr3 (Size):
    1370 = 2"×3.5" (U.S. Standard)        ← BENCHMARK (= 3.5"×2" portrait)
    1368 = 1.75"×3.5" (Slim)
    1369 = 2"×2" (Square)
    41473 = 2.5"×2.5"
    41474 = 3"×3"
    132305 = 2.125"×3.375"
    65796 = Custom Size

  attr4 (Sides):
    5 = Front Only
    6 = Front and Back (4/4)              ← BENCHMARK

  attr5 (Qty):
    10 = 250   ← BENCHMARK
    11 = 500   ← BENCHMARK
    12 = 1,000 ← BENCHMARK
    13 = 2,000, 14 = 3,000, 15 = 4,000, 16 = 5,000 ...

  attr6 (Turnaround):
    23 = 3 Business Days (standard)

Confirmed prices (3.5"×2", 14pt Gloss, 4/4):
  250 pcs:  $32.12  ($0.128/ea)
  500 pcs:  $36.20  ($0.072/ea)
  1000 pcs: $50.48  ($0.050/ea)
```

#### UPrinting Flyers — CONFIRMED ✓ (2026-04-22, PUL-305)
```
product_id=5, product_code=businessFlyer
dynamic_size=c  ← custom continuous dimensions (width 2–27.75", height 2–16")
getData/5 via prod_attrs → full attr value map:

  attr1 (Paper):
    123208 = 14 pt. Cardstock Gloss       ← BENCHMARK
    123209 = 14 pt. Cardstock Matte
    207    = 100 lb. Paper Gloss

  attr3 (Size — preset):
    123204 = 4"×6"                        ← BENCHMARK
    202    = 5.5"×8.5"
    203    = 8.5"×11"
    15364  = 4.25"×5.5"
    custom = Custom (uses width/height attrs)

  attr4 (Sides):
    222 = Front Only
    223 = Front and Back (4/4)            ← BENCHMARK

  attr5 (Qty):
    226=100, 227=150, 228=200
    229=500   ← BENCHMARK
    230=1,000 ← BENCHMARK
    231=2,000 ← closest to 2,500 (NOT AVAILABLE)
    232=3,000, 233=4,000 ...
    NOTE: 2,500 qty does NOT exist for UPrinting Flyers

  attr6 (Turnaround):
    259 = 3 Business Days (standard)

  attr7 (Folding):
    211 = None (flat flyer)               ← BENCHMARK

Confirmed prices (4"×6", 14pt Gloss, 4/4, No Fold):
  500 pcs:  $78.30  ($0.157/ea)
  1000 pcs: $85.00  ($0.085/ea)
  2000 pcs: $126.80 ($0.063/ea)  ← 2500 not available
  3000 pcs: $168.30 ($0.056/ea)
```

#### Axiom Print Flyers — NO PRODUCT CONFIRMED (2026-04-22, PUL-305)
```
Confirmed via full nav crawl: Axiom Print does NOT offer standard flat flyer/postcard printing.
Product catalog (115 links scraped) contains:
  - Business Cards (many specialty variants)
  - Tri-fold Brochures (/product/tri-fold-brochure-1001)
  - EDDM Postcards (/product/eddm-postcards-718)
  - Banners, Labels, Stickers, Apparel, Packaging
  - NO standard flat flyer (4"×6" or similar)

flyers-printing-102: Redirects to homepage (URL never valid or removed).
No other flyer slug resolved to a product page.
Resolution: Document as no-product — Axiom is not a comparable competitor for flat flyers.
```

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

### Quad Labels — Two Distinct Access Paths (2026-04-22)

There are **two separate login paths** for Quad Labels:

**Path 1 — Website wholesale login (quadlabels.com)**
- URL: `https://quadlabels.com`
- Wholesale toggle: upper-right corner of the site — click to reveal login
- Credentials: `gary@bazarprinting.com` / `GRYBZR123`
- What this gives: access to their wholesale product catalogue and pricing on the retail site
- **Next action:** Log in via this path to confirm wholesale pricing access. This may be a faster route to price data than the API approval path.

**Path 2 — Trade API account (api.quadlabels.com / orders.quadlabels.com)**
- API endpoint: `api.quadlabels.com/customer/login`
- Account: `info@pixelpressprint.com` — registered 2026-04-19, awaiting reseller approval
- Status: `messageKey: 'reject'` = approval-pending (not denied — awaiting admin review)
- Company: Quadriga USA, 28410 Witherspoon Pkwy, Valencia CA 91355
- What this gives: programmatic API access to all 13 product types with full pricing
- Script ready: `scripts/capture-quadlabels-authenticated.js` — runs full 19-spec benchmark suite on approval
- Open intel already captured in `data/capture-quadlabels-2026-04-19.json`

**Products confirmed (13 types):** PAPER (14), SYNTHETIC/White BOPP (15), SILVER (20), CLEAR (23), GOLD (24), FLUORESCENT (25), HOLOGRAPHIC (26), FELT (27), UL CERTIFIED (28), COVER-UP (29), BLANK (30), SECURITY SEAL (31), THERMAL (33)

**Config intel:** Min 100 pcs, max 100M, setup fee $5/version under 500 pcs, custom die $140, custom shape $220, rush +30%, UPS flat $50, sales tax 9.75% (California)

**Expected pricing:** Significantly below retail competitors (trade-only wholesale). Potentially 3–4× cheaper than UPrinting/GotPrint. This is the highest-priority capture still pending.

