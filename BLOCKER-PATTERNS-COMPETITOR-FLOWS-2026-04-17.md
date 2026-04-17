# Competitor flow blocker patterns, April 17 2026

Scope: Pulse pricing intelligence capture flows for competitor label pricing.

## Exact blocker patterns

### 1) Upload-first wall
- Pattern: price is not exposed until artwork upload or a later checkout step exists.
- Sites: Sticker Mule, earlier GotPrint passes.
- Symptom: DOM shows only upload CTAs, GraphQL or page APIs do not expose quote data, subtotal stays empty or starter-only.
- Workaround:
  - Treat starter price as reference only when exposed in structured data.
  - Use a real browser flow with placeholder artwork when price only appears after upload.
- Status:
  - Sticker Mule remains blocked by this pattern.
  - GotPrint is only partially blocked now. Upload was the original assumption, but the bigger issue was earlier flow ordering and session capture.

### 2) Reactive configurator state not driven by plain DOM events
- Pattern: changing native selects or forcing values updates the DOM but not the app state.
- Sites: GotPrint.
- Symptom: paper and finish remain disabled, qty pricing never unlocks, API calls do not fire after synthetic value changes.
- Root cause:
  - Vue/reactive watchers require the site’s actual state transition sequence, not just `select.value = ...` plus a generic event.
- Workaround:
  - Use the real configurator path in the correct order.
  - Preserve a single live session while walking shape -> size -> paper -> finish so the site emits its own dependent API calls.
  - Capture the pricing request once product, size, paper, and finish IDs are resolved.
- Status:
  - Resolved for GotPrint clear-gloss capture. We now have `/service/rest/v1/products/300158845/prices` for shape=4, size=452, paper=12, finish=1.
  - Matte for the same spec still needs a dedicated pass.

### 3) Hidden or indirect pricing API behind browser state
- Pattern: pricing exists in XHR/fetch responses, but only after browser interactions produce a valid state token or selection bundle.
- Sites: Vistaprint, UPrinting.
- Symptom: raw HTML has no useful quote data; direct fetch without the right state is incomplete.
- Workaround:
  - Intercept network traffic during live interactions.
  - For UPrinting, read Angular scope after the right Bootstrap selections.
  - For Vistaprint, capture Cimpress pricing requests after shape changes and verify whether custom width/height is truly encoded.
- Status:
  - UPrinting resolved.
  - Vistaprint remains directional only for 3x3/5000 because dimensions are not DOM-confirmed.

### 4) Catalog/configurator mismatch
- Pattern: target spec is not actually offered in the standard configurator even though nearby products exist.
- Sites: Axiom Print.
- Symptom: closest size exists, but exact target size or target quantity does not.
- Workaround:
  - Record the exact available sizes and maximum standard quantity.
  - Mark the exact spec as custom-quote-only instead of pretending the nearest option is equivalent.
- Status:
  - Axiom standard roll-label configurator does not offer 3x3 and caps standard qty at 2500.

### 5) Stale blocker notes after a breakthrough
- Pattern: normalized data, notes, and gap summaries drift apart after a later capture succeeds.
- Site/data affected: GotPrint entries in `competitor-pricing-normalized.json`.
- Symptom: one section says pricing is live while another still says price is blocked by upload or Vue cascade.
- Workaround:
  - Update normalized dataset notes and gap summaries in the same pass as the new capture.
  - Separate resolved blockers from remaining gaps.
- Status:
  - Fixed in this pass.

## Current truth by competitor

- UPrinting: exact-spec live benchmark, reliable via Angular scope.
- Vistaprint: partial, pricing service reachable, 3x3 still directional until dimension selection is proven in live browser state.
- Axiom Print: exact target blocked by catalog limits, not by automation failure.
- GotPrint: major blocker partially resolved, live clear-gloss 3x3 pricing captured; matte still pending.
- Sticker Mule: still upload-first blocked for exact automated pricing.

## What changed in this pass
- Documented the blocker taxonomy above.
- Corrected stale GotPrint blocker notes in the normalized dataset so the file matches the latest captured state.
