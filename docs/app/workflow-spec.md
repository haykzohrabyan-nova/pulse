# Complete Workflow Specification — Bazaar Printing / PixelPress Print

## OVERALL FLOW

### Order Lifecycle:
```
Customer Order In → Account Manager (Boyd) → Designer Assignment → 
File Check/Prep → Job Ticket Created with print-ready files + layer images →
Route to Boyd Production OR 16th Street Production → 
Prepress Review (16th only) → Production Stages → QC Checkout → Ship/Pickup
```

---

## BOYD STREET — Design Hub + Production

### Personnel:
- Account Managers
- Designers
- Operators (cutting)

### Pre-Production Flow:
1. Customer order comes in (with or without files)
2. Account Manager enters order
3. AM assigns job to a Designer
4. Designer opens files, checks, fixes, prepares print-ready files
5. Designer creates Job Ticket WITH:
   - Print-ready files
   - Layer images (large enough for production team to verify at ANY stage)
   - All specs filled in
6. Job routes to either Boyd production OR 16th Street

### Boyd Equipment:

**Printers:**
- **Canon Colorado** — CMYK only, GLOSS materials only
- **Roland (multiple)** — CMYK + Orange + Red + White + Gloss (UV), MATTE materials only

**Rule: Gloss → Canon Colorado. Matte → Roland.**

**Vinyl Cutting (4x Graphtec cutters):**
- For vinyl/roll materials
- Materials: Vinyl Matte, Vinyl Gloss, Holographic, Window Decals, Wallpaper, Banner Material

**Flatbed Cutting (3x Graphtec flatbed — 2 big, 1 small):**
- For sheet materials (18pt, 20pt, 24pt)
- Sheet → Lamination → Graphtec Flatbed

**Laminator (Boyd):**
- Used ONLY for sheet products (cards, etc.)
- Labels do NOT get laminated at Boyd — go straight to cut

### Boyd Production Flows:

**Vinyl Labels (no lamination):**
```
Print (Roland or Canon Colorado) → Vinyl Cut (Graphtec x4)
```

**Sheet Products (cards, etc.):**
```
Print (Roland or Canon Colorado) → Lamination → Flatbed Cut (Graphtec Flatbed x3)
```

### Boyd Materials:
- Vinyl Matte
- Vinyl Gloss  
- Holographic Vinyl
- Window Decal Material
- Wallpaper Material
- Banner Material
- 18pt Sheet
- 20pt Sheet
- 24pt Sheet

### ⚠️ PERFORATION — Boyd vs 16th Street (CRITICAL DIFFERENCE):

**At Boyd:** Operator must manually set a special condition on the Graphtec and adjust knife position for perforation. **Job ticket MUST explicitly state perforation requirements** because it's a manual process.

**At 16th Street:** Perforation is embedded in the file sent to GM Laser Cutter — machine reads it automatically from the file. Die cutting also has perforations built into the metal die. Much more automated.

→ Job Ticket needs a "Perforation Required" flag with notes field, and the system should show DIFFERENT instructions based on facility.

---

## 16TH STREET — Main Production

### Pre-Production at 16th:
1. Job arrives from Boyd designers
2. **Prepress** at 16th reviews everything — verifies files are correct
3. Prepress sends files to presses (6K or 15K)
4. If job requires UV/Foil/Duplo flatbed cutting → Prepress ALSO sends files to those machines

### Production Lines:

**HP Indigo 6K Line (Labels/Pouches):**
```
Press 6K → Lamination (Nobelus) → GM Die Cutter w/ JetFX OR GM Laser Cutter w/ JetFX → [Karlville Poucher if pouches]
```

**HP Indigo 15K Line (Boxes/Cards/Booklets):**
```
Press 15K → Lamination (Nobelus) → Scodix → Moll Brothers Cutter → Moll Brothers Folder-Gluer → [Duplo] → [Guillotine] → [UV Coater] → [Booklet Folder]
```

**Plain Boxes/Labels (no print needed):**
- Sometimes jobs skip the press entirely — go straight to cutting
- Pre-cut plain boxes or plain labels

---

## WORKFLOW BLOCKERS (CRITICAL FEATURE)

### Problem:
Jobs skip required steps because operators don't see the full workflow. Example: Job has UV but operator at lamination doesn't see it and sends directly to Duplo cutting, skipping Scodix.

### Solution — Mandatory Step Enforcement:
- System BLOCKS an operator from marking a step complete if the NEXT required step hasn't been acknowledged
- When operator finishes a step, system shows: "NEXT STEP: [Machine Name]" in big text
- If operator tries to send job somewhere else → WARNING: "This job requires [Scodix] before [Cutting]"
- Color-coded workflow visualization on every screen showing remaining steps

---

## OPERATOR KNOWLEDGE BASE / CONTRADICTION LOG (NEW FEATURE)

### Problem:
Production issues happen once, get fixed, but the knowledge isn't captured. Next time same issue happens, same mistakes.

### Solution — Issue Log / Operator Alerts:
- When an issue occurs, it gets logged with:
  - Machine involved
  - Material involved
  - Process/operation
  - What went wrong
  - What the fix was
  - Severity (info / warning / critical)
- Next time a job with matching machine + material + operation comes through, operator sees a NON-BLOCKING alert:
  - "⚠️ Previous Issue: When printing on foil with 6K, turn off corona treatment on both GM and 6K"
  - "⚠️ Previous Issue: JetFX foil jobs — lay foil on white BOPP first, print on top leaving foil areas empty"

### Example Issues to Pre-Seed:
1. **JetFX Foil Jobs:** "When using JetFX for foil, lay down foil on White BOPP first, print on top leaving foil areas empty."
2. **Corona Treatment:** "When printing on foil material, TURN OFF corona treatment on both the GM and the HP Indigo 6K. Failure to do so causes adhesion issues."
3. **Perforation at Boyd:** "Graphtec perforation requires manual knife position adjustment. Check cut settings before running."

### Data Structure:
```
{
  id: auto-increment,
  machine: string (or array),
  material: string (optional),
  operation: string,
  title: string,
  description: string,
  fix: string,
  severity: "info" | "warning" | "critical",
  createdBy: string,
  createdAt: ISO datetime,
  active: boolean
}
```

Match logic: When operator starts a step, system checks knowledge base for entries matching (machine OR material OR operation) and displays relevant alerts.

---

## HP INDIGO 6K LINE — Complete Flow (from Trello)

### Trello Columns:
```
HOLD → Artwork → Press HP Indigo 6K → GM Die-Cutter → GM Laser Cutter → Pouch Maker → Ready to Ship → Shipped → Received → Waiting for Pickup
```

### Key Facts:
- **GM Die-Cutter and GM Laser Cutter are MULTI-FUNCTION machines:**
  - Cut (die or laser)
  - UV finishing (via JetFX)
  - Foil finishing (via JetFX)
  - Lamination (for pouch material)
- **No separate Nobelus lamination step on 6K line** — GMs handle lamination for pouch material
- **Die vs Laser decision:** Die = when physical die exists (faster for repeat jobs). Laser = any shape, no die needed.

### 6K Production Flows:

**Labels with physical die:**
```
Press 6K → GM Die-Cutter (cut + UV/foil via JetFX)
```

**Labels without die:**
```
Press 6K → GM Laser Cutter (cut + UV/foil via JetFX)
```

**Pouches with die:**
```
Press 6K → GM Die-Cutter (lamination) → Pouch Maker (Karlville)
```

**Pouches without die:**
```
Press 6K → GM Laser Cutter (lamination) → Pouch Maker (Karlville)
```

### Notes:
- Artwork approval happens before press
- "computing time" labels on Trello cards = time tracking per stage
- Multi-part orders use dash convention (18116-1, 18116-2, etc.)
