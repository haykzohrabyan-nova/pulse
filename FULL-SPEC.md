# Print Production Management System — Complete Specification
## Bazaar Printing / PixelPress Print

---

## FACILITIES

### 16th Street — Main Production (~12 people, shift 6AM-6PM, one person at 2:30PM)
**Equipment (13 machines):**
1. HP Indigo 6K — Labels, pouches, sheet labels
2. HP Indigo 15K — Folding cartons, boxes, cardstock
3. Laminator (Nobelus) — Gloss, Matte, Soft Touch, Holo
4. Scodix — Spot UV, foil stamping, embossing, texture (one pass, no plates)
5. Karlville Poucher — Stand-up pouches, flat pouches, barrier bags
6. Moll Brothers Cutter — Cutting (separate machine)
7. Moll Brothers Folder-Gluer — Folding + gluing (separate machine)
8. Duplo — Cutting, scoring, creasing (flatbed)
9. GM Die Cutter w/ JetFX — Multi-function: die cutting + UV + foil + lamination (pouch material)
10. GM Laser Cutter w/ JetFX — Multi-function: laser cutting + UV + foil + lamination (pouch material)
11. Guillotine Cutter
12. UV Coater
13. Booklet Folder

### Boyd Street — Design Hub + Production
**Personnel:** Account Managers, Designers, Operators
**Equipment (6 machine groups):**
1. Canon Colorado — CMYK only, **GLOSS materials ONLY**
2. Roland Printers (multiple) — CMYK + Orange + Red + White + Gloss (UV), **MATTE materials ONLY**
3. Graphtec Vinyl Cutters x4 — For vinyl/roll materials
4. Graphtec Flatbed (Large) x2 — For sheet materials after lamination
5. Graphtec Flatbed (Small) x1 — For sheet materials after lamination
6. Laminator (Boyd) — **Sheet products ONLY. Labels do NOT get laminated at Boyd.**

---

## MATERIALS

### 16th Street Materials:
- **BOPP:** Clear, White, Silver, Holo
- **Cosmetic Web:** Clear, White, Silver
- **Label Sheets:** Gloss, Matte, Semi Gloss
- **Cardstock:** 14pt C1S/C2S, 16pt C1S/C2S, 18pt C1S/C2S, 18pt Silver, 24pt C1S/C2S
- **Cover/Text Stock:** 80lb Cover, 100lb Cover, 110lb Cover, 80lb Text, 100lb Text

### Boyd Street Materials:
- **Vinyl:** Vinyl Matte, Vinyl Gloss, Holographic Vinyl
- **Specialty:** Window Decals, Wallpaper Material, Banner Material
- **Sheet:** 18pt, 20pt, 24pt

---

## COMPLETE ORDER LIFECYCLE

```
Customer Order In
  → Account Manager (Boyd) enters order
  → AM assigns Designer
  → Designer checks/fixes files, prepares print-ready files with layer images
  → Job Ticket created WITH artwork files (big enough for production team to verify at any stage)
  → Route to Boyd Production OR 16th Street
    → If 16th St: Prepress reviews files → sends to presses + UV/foil/cutting machines if needed
  → Production stages (varies by product)
  → QC Checkout (version check, quality, quantity, signature)
  → Ready to Ship / Waiting Pickup
  → Shipped / Picked Up
  → Received (customer confirms)
```

---

## PRODUCTION FLOWS

### HP Indigo 15K Line (Trello board confirmed):
```
Waiting Approval → HOLD → Press 15K → Lamination (Nobelus) → Scodix → 
Moll Brothers Cutter → Moll Brothers Folder-Gluer → Duplo → 
Guillotine Cutter → UV Coater → Booklet Folder → 
QC Checkout → Ready to Ship → Shipped → Received → Waiting Pickup
```

**15K Templates:**
- Box/Folding Carton: 15K → Nobelus → Scodix → Moll Cutter → Moll Folder-Gluer
- Card/Flat Sheet: 15K → Nobelus → Duplo
- Booklet: 15K → Nobelus → Booklet Folder → Guillotine
- Box w/ UV+Foil: 15K → Nobelus → Scodix → Moll Cutter → Moll Folder-Gluer

### HP Indigo 6K Line (Trello board confirmed):
```
HOLD → Artwork → Press 6K → GM Die-Cutter or GM Laser Cutter → 
[Karlville Poucher if pouches] → QC → Ready to Ship → Shipped → Received → Waiting Pickup
```

**Key facts about 6K line:**
- GM Die-Cutter and GM Laser Cutter are MULTI-FUNCTION: cut + UV + foil (via JetFX) + lamination (pouch material)
- No separate Nobelus lamination step on 6K line — GMs handle it for pouches
- Die vs Laser choice: Die = when physical die exists. Laser = any shape, no die needed.

**6K Templates:**
- Labels with die: 6K → GM Die-Cutter
- Labels without die: 6K → GM Laser Cutter
- Pouches with die: 6K → GM Die-Cutter (lamination) → Karlville Poucher
- Pouches without die: 6K → GM Laser Cutter (lamination) → Karlville Poucher

### Plain Cut (no print):
- Sometimes jobs skip the press — go straight to cutting (plain boxes/labels)

### Boyd Street Flows:
**Vinyl Labels (no lamination at Boyd for labels):**
- Gloss vinyl: Canon Colorado → Graphtec Vinyl Cutter
- Matte vinyl: Roland → Graphtec Vinyl Cutter

**Sheet Products (cards, etc.):**
- Gloss: Canon Colorado → Laminator (Boyd) → Graphtec Flatbed
- Matte: Roland → Laminator (Boyd) → Graphtec Flatbed

**Rule: Gloss → Canon Colorado. Matte → Roland.**

---

## PERFORATION — CRITICAL DIFFERENCE BETWEEN FACILITIES

### At 16th Street:
- Perforation is embedded in the file sent to GM Laser Cutter
- Machine reads it automatically from the file
- Die cutting also has perforations built into the metal die
- **More automated — less operator intervention**

### At Boyd Street:
- Operator must MANUALLY set a special condition on the Graphtec
- Must manually adjust knife position for perforation
- **Job ticket MUST explicitly state perforation requirements**
- System should show DIFFERENT instructions based on facility

---

## JOB TICKET FIELDS (implemented)

### Top Level:
- **Facility** (top of form — drives all dropdowns below)

### Customer & Sales:
- Customer Name, Account Manager, Designer

### Job Specifications:
- **Product Type** (filters materials automatically): Labels (Roll), Labels (Sheet), Pouches, Folding Cartons/Boxes, Business Cards, Flyers, Booklets, Stickers, Vinyl Signage, Banners, Window Decals, Wallpaper, Sheet Products (Boyd), Other
- Job Description (free text)
- Quantity
- Material (filtered by product type)
- Print Type (Sheet/Roll — auto-set by product)
- **Roll Direction** (1-4, shows only for Roll)
- Colors
- **White Layer** toggle — if yes, asks for **White Layer File** upload
- Sides (Single/Double)

### Finishing:
- Lamination (None, Gloss, Matte, Soft Touch, Holo, Coating)
- **Spot UV** toggle — if yes, asks for **UV File** upload
- **Foil** toggle — if yes, asks for **Foil Color** (Gold, Silver, Holographic Dot, Green, Red, Blue)
- Copy Position

### Cutting:
- **Cut Method**: Die Cutting (GM), Laser Cutting (GM), Duplo Flatbed, Moll Brothers, Guillotine, Graphtec Vinyl (Boyd), Graphtec Flatbed (Boyd) — filtered by facility
- **Die Status** (shows for Die/Laser): Existing Die, New Die (Ordered), No Die Needed
- **Die Name/Number** (free text): e.g. "Stiizy Die 3.5x2.5", "Armen Fanta Die", "Kiana 20ct Die"
- **Label Size** (shows for label products): e.g. 3.5" x 2.5"

### Scheduling:
- Entry Date (auto), Due Date

### Notes:
- Special Notes, QC Notes (red highlighted)

### Attachments:
- Multiple file upload (images, PDFs, AI, PSD, TIF, EPS)
- **120x120 thumbnails** with click-to-lightbox for full-size viewing
- Files travel with the order to Production Manager and Operator screens

---

## FEATURES TO BUILD (specified, partially implemented)

### 1. Workflow Blockers ⚠️
**Problem:** Jobs skip required steps (e.g., operator at lamination doesn't see UV is needed, sends to cutting, skipping Scodix)
**Solution:**
- System BLOCKS marking a step complete if next required step hasn't been acknowledged
- Shows "NEXT STEP: [Machine Name]" in big text after each step
- WARNING if operator tries to skip: "This job requires [Scodix] before [Cutting]"
- Color-coded workflow visualization on every screen

### 2. Operator Knowledge Base / Contradiction Log 🧠
**Problem:** Production issues happen once, get fixed, but knowledge isn't captured. Same mistakes repeat.
**Solution:**
- When issue occurs, log it with: machine, material, operation, what went wrong, what the fix was, severity
- Next time matching job comes through, operator sees NON-BLOCKING alert
- Pre-seeded issues:
  - JetFX Foil: lay foil on White BOPP first, print on top leaving foil areas empty
  - Corona Treatment: TURN OFF on both GM and 6K when printing on foil material
  - Boyd Perforation: Graphtec requires manual knife position adjustment

### 3. Reprint / Shortage Handling 🔁
**Problem:** Job gets short at a production stage, needs partial reprint
**Solution:**
- Operator flags "SHORT" with count at any step
- Creates REPRINT sub-ticket (e.g. 18191-R1) linked to parent order
- Reprint tracked separately on dashboard
- Reprint re-enters workflow after printing
- Parent order can continue or pause depending on severity

### 4. QC Final Checkout ✅ (before "Ready to Ship")
- Version check (correct artwork version)
- Quality inspection (pass/fail per criteria)
- Quantity verification (expected vs actual count)
- Loss reconciliation (total across all steps)
- Who picked up (name)
- Signature capture (touch/canvas)
- Date/time stamped sign-off
- Order CANNOT move to "Ready to Ship" without QC sign-off

### 5. Prepress Step (16th Street only)
- After job arrives from Boyd designers, Prepress at 16th reviews everything
- Verifies files are correct before sending to presses
- If UV/foil/Duplo needed → Prepress also sends files to those machines

### 6. Designer Assignment (Boyd)
- AM assigns job to designer
- Designer checks files, prepares print-ready files
- Job ticket created WITH artwork files and layer images

---

## ORDER NUMBERING CONVENTION
- Standard: "18136"
- Multi-part: "18116-1", "18116-2", "18116-3" (dash + part number)
- Reprints: "18191-R1" (dash + R + reprint number)

---

## STATUS LIFECYCLE (11 states)
1. Waiting Approval (artwork approval from customer)
2. New (just entered)
3. Pending Review (at production manager)
4. On Hold (blocked — with reason)
5. In Production (released to floor)
6. QC Checkout (final quality check)
7. Ready to Ship
8. Shipped
9. Waiting Pickup
10. Received (customer confirmed)
11. Completed
