# Corrections from Hayk — Apply to shared.js

## Materials Corrections

### Cardstock — C1S and C2S variants
Replace:
```
{ category: 'Cardstock', items: ['14pt', '16pt', '16pt Holo', '18pt', '24pt'] }
```
With:
```
{ category: 'Cardstock', items: [
  '14pt C1S', '14pt C2S',
  '16pt C1S', '16pt C2S',
  '18pt C1S', '18pt C2S',
  '18pt Silver',
  '24pt C1S', '24pt C2S'
]}
```

### Cover/Text Stock — add 80lb Text
Replace:
```
{ category: 'Cover Stock', items: ['80lb Cover', '100lb Cover', '110lb Cover', '100lb Text'] }
```
With:
```
{ category: 'Cover/Text Stock', items: ['80lb Cover', '100lb Cover', '110lb Cover', '80lb Text', '100lb Text'] }
```

## Equipment Corrections — 16th Street

### Missing machines to add:
- **GM Die Cutter w/ JetFX** → operations: ['Die Cutting', 'JetFX Finishing']
- **GM Laser Cutter w/ JetFX** → operations: ['Laser Cutting', 'JetFX Finishing']  
- **Guillotine Cutter** → operations: ['Guillotine Cutting']

### Moll Brothers — split into TWO separate machines:
- **Moll Brothers Cutter** → operations: ['Cutting']
- **Moll Brothers Folder-Gluer** → operations: ['Folding', 'Gluing']

### Updated MACHINES constant for 16th Street:
```javascript
'HP Indigo 6K': { operations: ['Printing'], facility: '16th-street', products: ['Roll Labels', 'Sheet Labels', 'Pouches'] },
'HP Indigo 15K': { operations: ['Printing'], facility: '16th-street', products: ['Folding Cartons', 'Boxes', 'Cardstock'] },
'Laminator': { operations: ['Laminating'], facility: '16th-street', options: ['Gloss', 'Matte', 'Soft Touch', 'Holo'] },
'Scodix': { operations: ['Spot UV', 'Foil Stamping', 'Embossing', 'Texture'], facility: '16th-street' },
'Karlville Poucher': { operations: ['Pouching'], facility: '16th-street', products: ['Stand-up Pouches', 'Flat Pouches', 'Barrier Bags'] },
'Moll Brothers Cutter': { operations: ['Cutting'], facility: '16th-street' },
'Moll Brothers Folder-Gluer': { operations: ['Folding', 'Gluing'], facility: '16th-street' },
'Duplo': { operations: ['Cutting', 'Scoring', 'Creasing'], facility: '16th-street' },
'GM Die Cutter w/ JetFX': { operations: ['Die Cutting', 'JetFX Finishing'], facility: '16th-street' },
'GM Laser Cutter w/ JetFX': { operations: ['Laser Cutting', 'JetFX Finishing'], facility: '16th-street' },
'Guillotine Cutter': { operations: ['Guillotine Cutting'], facility: '16th-street' },
```

### Updated 16th Street facility machines list:
```javascript
'16th-street': { 
  name: '16th Street — Main Production', 
  machines: [
    'HP Indigo 6K', 'HP Indigo 15K', 'Laminator', 'Scodix', 
    'Karlville Poucher', 'Moll Brothers Cutter', 'Moll Brothers Folder-Gluer',
    'Duplo', 'GM Die Cutter w/ JetFX', 'GM Laser Cutter w/ JetFX', 'Guillotine Cutter'
  ] 
}
```

## Pending: Trello workflow map (Hayk sharing next)

## Additional Machines (from Trello board)

### Missing from 16th Street:
- **UV Coater** → operations: ['UV Coating']
- **Booklet Folder** → operations: ['Booklet Folding']

### Laminator correction:
- Rename "Laminator" to "Laminator (Nobelus)" or just note brand is Nobelus

### Complete HP Indigo 15K Production Flow (from Trello):
```
HOLD → Press HP Indigo 15K → Lamination Nobelus → Scodix → Cutter Moll Brothers → Fold & Glue Moll Brothers → Duplo → Guillotine Cutter → UV Coater → Booklet Folder → Ready to Ship → Shipped
```
Note: Not all jobs go through ALL stations. Manager picks which steps apply per job.

## New Features Required

### 1. Reprint / Shortage Handling
- At any production step, operator can flag "SHORT" with count
- This triggers a REPRINT sub-ticket (e.g., 18191-R1) linked to parent order
- Reprint tracked separately on dashboard
- Reprint re-enters workflow after printing step
- Parent order can continue or pause depending on severity
- Manager gets notified of all shortage events

### 2. QC Final Checkout (new section/screen — before "Ready to Ship")
- Version check: verify correct artwork version
- Quality inspection: pass/fail per configurable criteria
- Quantity verification: expected qty vs actual count
- Loss reconciliation: total losses across all steps
- Pickup: who picked up the order (name)
- Signature: touch/canvas signature capture
- Date/time stamp on sign-off
- Order cannot move to "Ready to Ship" without QC sign-off
- QC report stored with order, printable

## Pending: HP Indigo 6K line Trello board (different flow — labels/pouches)
## Pending: Boyd Street flow (if any)

## Complete HP Indigo 15K Lifecycle (from Trello — FULL board)

### Pre-Production:
1. Waiting Customer Approval (artwork sign-off)

### Production:
2. HOLD
3. Press — HP Indigo 15K
4. Lamination — Nobelus
5. Scodix
6. Cutter — Moll Brothers
7. Fold & Glue — Moll Brothers
8. Duplo
9. Guillotine Cutter
10. UV Coater
11. Booklet Folder

### Post-Production:
12. Ready to Ship
13. Shipped
14. Received (customer confirms)
15. Waiting For Pickup (alternate to Ship)

### Order Numbering Convention:
- Standard: "18136"
- Multi-part: "18116-3", "17718-2" (dash + part number)
- Reprints: will use "18191-R1" convention

### Notes:
- Not every job goes through all production stations
- Manager selects which stations apply per job
- Jobs can have artwork attachments (visual preview)
- Time tracking per stage is important ("computing time" labels in Trello)
