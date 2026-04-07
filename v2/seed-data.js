(async function seedData() {
  // Check if data already exists — skip if so
  var existing = await getAllOrders();
  if (existing && existing.length > 0) { console.log('Seed skipped — ' + existing.length + ' orders already exist'); return; }

  var now = new Date();
  function bd(d, n) { var r = new Date(d); var a = 0; while(a < n){ r.setDate(r.getDate()+1); if(r.getDay()!==0&&r.getDay()!==6) a++; } return r; }
  function past(d, n) { var r = new Date(d); r.setDate(r.getDate()-n); return r; }
  function iso(d) { return d.toISOString(); }
  function ds(d) { return d.toISOString().split('T')[0]; }

  var orders = [
    {
      orderId: '17901', customer: 'Kush Co Supply', facility: '16th-street',
      productType: 'Labels (Roll)', material: 'White BOPP', printType: 'Roll',
      colorMode: 'CMYK', sides: 'Front Only', quantity: 25000, piecesPerSheet: 8,
      sheetCount: 3125, lamination: 'Gloss', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '6k-labels-die', dueDate: ds(bd(now, 3)),
      status: 'in-production', currentStep: 1, notes: 'Rush - customer event Fri',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'completed', stepId: 'step_1', startedAt: iso(past(now,1)), completedAt: iso(past(now,0)), operator: 'Juan' },
        { machine: 'GM Die Cutter w/ JetFX', operation: 'Die Cutting', status: 'in-progress', stepId: 'step_2', startedAt: iso(now), operator: 'Vahe' }
      ],
      createdAt: iso(past(now,3)), updatedAt: iso(now)
    },
    {
      orderId: '17902', customer: 'Green Goddess Farms', facility: '16th-street',
      productType: 'Labels (Roll)', material: 'Clear BOPP', printType: 'Roll',
      colorMode: 'CMYK + White', sides: 'Front Only', quantity: 50000, piecesPerSheet: 6,
      sheetCount: 8334, lamination: 'None', finishing: 'Spot UV', hasUV: true, foilType: 'None',
      workflowTemplate: '6k-labels-die', dueDate: ds(bd(now, 4)),
      status: 'in-production', currentStep: 0, notes: '3 SKUs - Sativa/Indica/Hybrid',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'in-progress', stepId: 'step_1', startedAt: iso(now), operator: 'Juan' },
        { machine: 'GM Die Cutter w/ JetFX', operation: 'Die Cutting', status: 'pending', stepId: 'step_2' }
      ],
      createdAt: iso(past(now,2)), updatedAt: iso(now)
    },
    {
      orderId: '17903', customer: 'Pacific Wellness Labs', facility: '16th-street',
      productType: 'Pouches', material: 'White Cosmetic Web', printType: 'Roll',
      colorMode: 'CMYK', sides: 'Front + Back', quantity: 10000, piecesPerSheet: 4,
      sheetCount: 2500, lamination: 'Matte', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '6k-pouches-die', dueDate: ds(bd(now, 6)),
      status: 'in-production', currentStep: 0, notes: 'CBD gummies stand-up pouches',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'in-progress', stepId: 'step_1', startedAt: iso(now), operator: 'Juan' },
        { machine: 'GM Die Cutter w/ JetFX', operation: 'Die Cutting', status: 'pending', stepId: 'step_2' },
        { machine: 'Karlville Poucher', operation: 'Pouching', status: 'pending', stepId: 'step_3' }
      ],
      createdAt: iso(past(now,2)), updatedAt: iso(now)
    },
    {
      orderId: '17904', customer: 'Herbology Inc', facility: '16th-street',
      productType: 'Labels (Roll)', material: 'Silver BOPP', printType: 'Roll',
      colorMode: 'CMYK + White', sides: 'Front Only', quantity: 15000, piecesPerSheet: 10,
      sheetCount: 1500, lamination: 'None', finishing: 'Foil', hasUV: false, foilType: 'Gold',
      workflowTemplate: '6k-labels-laser', dueDate: ds(bd(now, 5)),
      status: 'pending-review', currentStep: 0, notes: 'Gold foil on silver - premium line',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'pending', stepId: 'step_1' },
        { machine: 'GM Laser Cutter w/ JetFX', operation: 'Laser Cutting', status: 'pending', stepId: 'step_2' }
      ],
      createdAt: iso(past(now,1)), updatedAt: iso(now)
    },
    {
      orderId: '17905', customer: 'Cali Extracts', facility: '16th-street',
      productType: 'Folding Cartons / Boxes', material: '16pt C2S', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Both', quantity: 5000, piecesPerSheet: 4,
      sheetCount: 1250, lamination: 'Soft Touch', finishing: 'Scodix UV', hasUV: true, foilType: 'None',
      workflowTemplate: '15k-box-die', dueDate: ds(bd(now, 5)), dieStatus: 'existing',
      status: 'in-production', currentStep: 2, notes: 'Reorder - same die as last run',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'completed', stepId: 'step_1', startedAt: iso(past(now,2)), completedAt: iso(past(now,1)), operator: 'Tuoyo' },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'completed', stepId: 'step_2', startedAt: iso(past(now,1)), completedAt: iso(past(now,1)), operator: 'Lisandro' },
        { machine: 'Scodix', operation: 'Spot UV', status: 'in-progress', stepId: 'step_3', startedAt: iso(now), operator: 'Abel' },
        { machine: 'Moll Brothers Cutter', operation: 'Cutting', status: 'pending', stepId: 'step_4' },
        { machine: 'Moll Brothers Folder-Gluer', operation: 'Folding', status: 'pending', stepId: 'step_5' }
      ],
      createdAt: iso(past(now,4)), updatedAt: iso(now)
    },
    {
      orderId: '17906', customer: 'Bloom Naturals', facility: '16th-street',
      productType: 'Folding Cartons / Boxes', material: '18pt C1S', printType: 'Sheet',
      colorMode: 'CMYK + White', sides: 'Both', quantity: 2000, piecesPerSheet: 2,
      sheetCount: 1000, lamination: 'Matte', finishing: 'Scodix UV + Foil', hasUV: true, foilType: 'Silver',
      workflowTemplate: '15k-box-die', dueDate: ds(bd(now, 7)), dieStatus: 'existing',
      status: 'in-production', currentStep: 1, notes: 'Premium CBD tincture box, embossed logo',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'completed', stepId: 'step_1', startedAt: iso(past(now,1)), completedAt: iso(past(now,1)), operator: 'Tuoyo' },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'in-progress', stepId: 'step_2', startedAt: iso(now), operator: 'Lisandro' },
        { machine: 'Scodix', operation: 'Spot UV', status: 'pending', stepId: 'step_3' },
        { machine: 'Moll Brothers Cutter', operation: 'Cutting', status: 'pending', stepId: 'step_4' },
        { machine: 'Moll Brothers Folder-Gluer', operation: 'Folding', status: 'pending', stepId: 'step_5' }
      ],
      createdAt: iso(past(now,3)), updatedAt: iso(now)
    },
    {
      orderId: '17907', customer: 'LA Vapor Co', facility: '16th-street',
      productType: 'Folding Cartons / Boxes', material: '14pt C2S', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Both', quantity: 10000, piecesPerSheet: 6,
      sheetCount: 1667, lamination: 'Gloss', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '15k-box-die', dueDate: ds(bd(now, 4)), dieStatus: 'existing',
      status: 'in-production', currentStep: 3, notes: 'Vape cartridge boxes - 6 SKUs',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'completed', stepId: 'step_1', operator: 'Tuoyo', completedAt: iso(past(now,3)) },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'completed', stepId: 'step_2', operator: 'Lisandro', completedAt: iso(past(now,2)) },
        { machine: 'Scodix', operation: 'Spot UV', status: 'completed', stepId: 'step_3', operator: 'Abel', completedAt: iso(past(now,2)) },
        { machine: 'Moll Brothers Cutter', operation: 'Cutting', status: 'in-progress', stepId: 'step_4', startedAt: iso(now), operator: 'Jaime' },
        { machine: 'Moll Brothers Folder-Gluer', operation: 'Folding', status: 'pending', stepId: 'step_5' }
      ],
      createdAt: iso(past(now,5)), updatedAt: iso(now)
    },
    {
      orderId: '17908', customer: 'Sunset Supplements', facility: '16th-street',
      productType: 'Folding Cartons / Boxes', material: '18pt C2S', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Both', quantity: 500, piecesPerSheet: 4,
      sheetCount: 125, lamination: 'Soft Touch', finishing: 'Scodix Foil', hasUV: false, foilType: 'Rose Gold',
      workflowTemplate: '15k-box-duplo', dueDate: ds(bd(now, 6)), dieStatus: 'none',
      status: 'new', currentStep: 0, notes: 'Small run - Duplo flatbed cut, no die',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'pending', stepId: 'step_1' },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'pending', stepId: 'step_2' },
        { machine: 'Scodix', operation: 'Foil Stamping', status: 'pending', stepId: 'step_3' },
        { machine: 'Duplo', operation: 'Flatbed Cutting', status: 'pending', stepId: 'step_4' },
        { machine: 'Moll Brothers Folder-Gluer', operation: 'Folding', status: 'pending', stepId: 'step_5' }
      ],
      createdAt: iso(past(now,1)), updatedAt: iso(now)
    },
    {
      orderId: '17909', customer: 'West Coast Edibles', facility: '16th-street',
      productType: 'Folding Cartons / Boxes', material: '16pt C1S', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Front Only', quantity: 20000, piecesPerSheet: 8,
      sheetCount: 2500, lamination: 'Gloss', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '15k-box-die', dueDate: ds(bd(now, 2)), dieStatus: 'existing',
      status: 'in-production', currentStep: 4, notes: 'URGENT - Almost done, fold & glue remaining',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'completed', stepId: 'step_1', operator: 'Tuoyo', completedAt: iso(past(now,4)) },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'completed', stepId: 'step_2', operator: 'Lisandro', completedAt: iso(past(now,3)) },
        { machine: 'Scodix', operation: 'Spot UV', status: 'completed', stepId: 'step_3', operator: 'Abel', completedAt: iso(past(now,2)) },
        { machine: 'Moll Brothers Cutter', operation: 'Cutting', status: 'completed', stepId: 'step_4', operator: 'Jaime', completedAt: iso(past(now,1)) },
        { machine: 'Moll Brothers Folder-Gluer', operation: 'Folding', status: 'in-progress', stepId: 'step_5', startedAt: iso(now), operator: 'Avgustin' }
      ],
      createdAt: iso(past(now,6)), updatedAt: iso(now)
    },
    {
      orderId: '17910', customer: 'Heritage Dispensary', facility: '16th-street',
      productType: 'Business Cards', material: '18pt C2S', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Both', quantity: 1000, piecesPerSheet: 16,
      sheetCount: 63, lamination: 'Soft Touch', finishing: 'Scodix UV', hasUV: true, foilType: 'None',
      workflowTemplate: '15k-card', dueDate: ds(bd(now, 5)),
      status: 'qc-checkout', currentStep: 3, notes: 'Dispensary staff cards',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'completed', stepId: 'step_1', operator: 'Tuoyo', completedAt: iso(past(now,2)) },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'completed', stepId: 'step_2', operator: 'Lisandro', completedAt: iso(past(now,2)) },
        { machine: 'Duplo', operation: 'Flatbed Cutting', status: 'completed', stepId: 'step_3', operator: 'Lisandro', completedAt: iso(past(now,1)) }
      ],
      createdAt: iso(past(now,4)), updatedAt: iso(now)
    },
    {
      orderId: '17911', customer: 'Mindful Mushrooms', facility: '16th-street',
      productType: 'Flyers / Postcards', material: '100lb Cover', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Both', quantity: 5000, piecesPerSheet: 4,
      sheetCount: 1250, lamination: 'None', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '15k-flat-guillotine', dueDate: ds(bd(now, 3)),
      status: 'ready-to-ship', currentStep: 2, notes: 'Promo flyers for trade show',
      workflowSteps: [
        { machine: 'HP Indigo 15K', operation: 'Printing', status: 'completed', stepId: 'step_1', operator: 'Tuoyo', completedAt: iso(past(now,3)) },
        { machine: 'Laminator (Nobelus)', operation: 'Laminating', status: 'completed', stepId: 'step_2', operator: 'Lisandro', completedAt: iso(past(now,2)) },
        { machine: 'Guillotine Cutter', operation: 'Guillotine Cutting', status: 'completed', stepId: 'step_3', operator: 'Lisandro', completedAt: iso(past(now,1)) }
      ],
      createdAt: iso(past(now,5)), updatedAt: iso(now)
    },
    {
      orderId: '17912', customer: 'Venice Beach Wellness', facility: 'boyd-street',
      productType: 'Vinyl Signage', material: 'Vinyl Gloss', printType: 'Roll',
      colorMode: 'CMYK', sides: 'Front Only', quantity: 50, piecesPerSheet: 1,
      sheetCount: 50, lamination: 'None', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: 'boyd-vinyl-gloss', dueDate: ds(bd(now, 2)),
      status: 'in-production', currentStep: 1, notes: 'Storefront window decals x50',
      workflowSteps: [
        { machine: 'Canon Colorado', operation: 'Printing', status: 'completed', stepId: 'step_1', operator: 'Arsen', completedAt: iso(past(now,1)) },
        { machine: 'Graphtec Vinyl Cutter x4', operation: 'Vinyl Cutting', status: 'in-progress', stepId: 'step_2', startedAt: iso(now), operator: 'Arsen' }
      ],
      createdAt: iso(past(now,2)), updatedAt: iso(now)
    },
    {
      orderId: '17913', customer: 'Sweetwater Cannabis Club', facility: 'boyd-street',
      productType: 'Sheet Products (Boyd)', material: '18pt (Boyd)', printType: 'Sheet',
      colorMode: 'CMYK', sides: 'Both', quantity: 200, piecesPerSheet: 2,
      sheetCount: 100, lamination: 'Gloss', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: 'boyd-sheet', dueDate: ds(bd(now, 3)),
      status: 'in-production', currentStep: 0, notes: 'Table tent cards for dispensary',
      workflowSteps: [
        { machine: 'Canon Colorado', operation: 'Printing', status: 'in-progress', stepId: 'step_1', startedAt: iso(now), operator: 'Arsen' },
        { machine: 'Laminator (Boyd)', operation: 'Laminating', status: 'pending', stepId: 'step_2' },
        { machine: 'Graphtec Flatbed (Large) x2', operation: 'Flatbed Cutting', status: 'pending', stepId: 'step_3' }
      ],
      createdAt: iso(past(now,1)), updatedAt: iso(now)
    },
    {
      orderId: '17914', customer: 'HighLife Brands', facility: '16th-street',
      productType: 'Pouches', material: 'Clear Cosmetic Web', printType: 'Roll',
      colorMode: 'CMYK + White', sides: 'Front + Back', quantity: 30000, piecesPerSheet: 4,
      sheetCount: 7500, lamination: 'None', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '6k-pouches-laser', dueDate: ds(bd(now, 10)),
      status: 'on-hold', currentStep: 0, notes: 'ON HOLD - Waiting customer artwork revision (emailed 3/27)',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'pending', stepId: 'step_1' },
        { machine: 'GM Laser Cutter w/ JetFX', operation: 'Laser Cutting', status: 'pending', stepId: 'step_2' },
        { machine: 'Karlville Poucher', operation: 'Pouching', status: 'pending', stepId: 'step_3' }
      ],
      createdAt: iso(past(now,4)), updatedAt: iso(past(now,1))
    },
    {
      orderId: '17915', customer: 'Terp Brothers', facility: '16th-street',
      productType: 'Labels (Roll)', material: 'Holo BOPP', printType: 'Roll',
      colorMode: 'CMYK + White', sides: 'Front Only', quantity: 8000, piecesPerSheet: 12,
      sheetCount: 667, lamination: 'None', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '6k-labels-die', dueDate: ds(bd(now, 4)),
      status: 'waiting-approval', currentStep: 0, notes: 'Holographic labels - needs Tigran approval on pricing',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'pending', stepId: 'step_1' },
        { machine: 'GM Die Cutter w/ JetFX', operation: 'Die Cutting', status: 'pending', stepId: 'step_2' }
      ],
      createdAt: iso(past(now,1)), updatedAt: iso(now)
    },
    {
      orderId: '17916', customer: 'Pure Leaf Organics', facility: '16th-street',
      productType: 'Labels (Roll)', material: 'White BOPP', printType: 'Roll',
      colorMode: 'CMYK', sides: 'Front Only', quantity: 12000, piecesPerSheet: 8,
      sheetCount: 1500, lamination: 'Matte', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '6k-labels-die', dueDate: ds(bd(now, 1)),
      status: 'reprint', currentStep: 0, notes: 'QC FAILED - Color shift on green, reprinting. Original order 17889.',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'pending', stepId: 'step_1' },
        { machine: 'GM Die Cutter w/ JetFX', operation: 'Die Cutting', status: 'pending', stepId: 'step_2' }
      ],
      createdAt: iso(past(now,0)), updatedAt: iso(now)
    },
    {
      orderId: '17917', customer: 'Golden State Topicals', facility: '16th-street',
      productType: 'Labels (Roll)', material: 'Clear BOPP', printType: 'Roll',
      colorMode: 'CMYK + White', sides: 'Front Only', quantity: 5000, piecesPerSheet: 6,
      sheetCount: 834, lamination: 'None', finishing: 'None', hasUV: false, foilType: 'None',
      workflowTemplate: '6k-labels-die', dueDate: ds(bd(now, 2)),
      status: 'in-production', currentStep: 2, notes: 'Apply labels to 5000 jars (customer supplied jars)',
      workflowSteps: [
        { machine: 'HP Indigo 6K', operation: 'Printing', status: 'completed', stepId: 'step_1', operator: 'Juan', completedAt: iso(past(now,2)) },
        { machine: 'GM Die Cutter w/ JetFX', operation: 'Die Cutting', status: 'completed', stepId: 'step_2', operator: 'Vahe', completedAt: iso(past(now,1)) },
        { machine: 'Application Dept', operation: 'Label Application', status: 'in-progress', stepId: 'step_3', startedAt: iso(now), operator: 'Application Team' }
      ],
      createdAt: iso(past(now,4)), updatedAt: iso(now)
    }
  ];

  var added = 0;
  for (var i = 0; i < orders.length; i++) {
    try { await addOrder(orders[i]); added++; } catch(e) { console.error('Failed:', orders[i].orderId, e.message); }
  }
  document.title = 'SEEDED ' + added + ' orders';
  console.log('Seeded ' + added + ' orders');
})();
