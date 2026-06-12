// ============================================================
// supabase-client.js — Pulse Supabase Backend
// PRI-239: Replace IndexedDB with Supabase for job ticket data
//
// Load order (per HTML page):
//   1. pulse-config.local.js  (sets PULSE_SUPABASE_URL, PULSE_SUPABASE_ANON_KEY,
//                              PULSE_STORAGE_BACKEND = 'supabase')
//   2. shared.js              (defines IndexedDB functions + override hooks)
//   3. supabase-client.js     (this file — overrides hooks when Supabase is active)
//
// When PULSE_STORAGE_BACKEND !== 'supabase' or no URL/key: no-op,
// all global functions keep their IndexedDB implementations.
// ============================================================

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  const SUPA_URL     = window.PULSE_SUPABASE_URL     || '';
  const SUPA_KEY     = window.PULSE_SUPABASE_ANON_KEY || '';
  const BACKEND      = window.PULSE_STORAGE_BACKEND   || 'indexeddb';
  const MIGRATE_TOOL = !!window.PULSE_MIGRATE_TOOL;

  const hasPlaceholderConfig =
    /YOUR-PROJECT-REF/i.test(SUPA_URL) ||
    /YOUR-ANON-KEY/i.test(SUPA_KEY);

  const useSupabaseClient = (BACKEND === 'supabase' || MIGRATE_TOOL) && SUPA_URL && SUPA_KEY && !hasPlaceholderConfig;

  if (!useSupabaseClient) {
    if (BACKEND === 'supabase' && hasPlaceholderConfig) {
      console.warn('[Pulse] Supabase config has placeholder values; using IndexedDB instead.');
    }
    console.log('[Pulse] Storage backend: IndexedDB');
    return; // No-op — IndexedDB functions remain active
  }

  if (MIGRATE_TOOL) {
    console.log('[Pulse] Migrate tool: Supabase client for auth + order copy (local data stays in IndexedDB)');
  } else {
    console.log('[Pulse] Storage backend: Supabase →', SUPA_URL);
  }

  // ── Supabase client init (lazy, with CDN auto-load) ─────────
  let _client = null;
  let _clientReady = false;
  const _clientWaiters = [];

  function _getClient() {
    if (_clientReady) return Promise.resolve(_client);
    return new Promise(resolve => {
      _clientWaiters.push(resolve);
    });
  }

  function _resolveClient(c) {
    _client = c;
    _clientReady = true;
    _clientWaiters.forEach(fn => fn(c));
    _clientWaiters.length = 0;
  }

  function _loadSupabaseJS() {
    return new Promise((resolve, reject) => {
      if (window.supabase && window.supabase.createClient) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  _loadSupabaseJS()
    .then(() => {
      const client = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        realtime: { params: { eventsPerSecond: 10 } },
      });
      _resolveClient(client);
      _registerRealtimeSubscriptions(client);
    })
    .catch(err => {
      console.error('[Pulse/Supabase] Failed to load Supabase JS:', err);
      // Fall back to IndexedDB by NOT resolving _client
    });

  // ── Helper: current authenticated user ──────────────────────
  async function _getCurrentUser() {
    const supa = await _getClient();
    const { data: { session } } = await supa.auth.getSession();
    return session?.user || null;
  }

  async function _getCurrentProfile() {
    const user = await _getCurrentUser();
    if (!user) return null;
    const supa = await _getClient();
    const { data, error } = await supa.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (data) return data;
    if (error && error.code !== 'PGRST116') {
      console.warn('[Pulse/Supabase] getCurrentProfile:', error);
    }
    return _ensurePulseProfileRow();
  }

  /** Create profiles row from auth.users when trigger never ran (RLS needs this). */
  async function _ensurePulseProfileRow() {
    const user = await _getCurrentUser();
    if (!user) return null;
    const supa = await _getClient();
    try {
      const { data, error } = await supa.rpc('ensure_pulse_profile');
      if (!error && data) return data;
      if (error) console.warn('[Pulse/Supabase] ensure_pulse_profile:', error);
    } catch (e) {
      console.warn('[Pulse/Supabase] ensure_pulse_profile:', e);
    }
    const { data: row } = await supa.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return row || null;
  }

  // ── Data mapping: local order object ↔ Supabase row ─────────

  /**
   * Map local order object → Supabase orders row.
   * Explicit columns get their own fields; the rest go into specs JSONB.
   */
  function _orderToRow(order) {
    const specs = {
      jobDescription:           order.jobDescription           || null,
      otherProductDesc:         order.otherProductDesc         || null,
      labelWidth:               order.labelWidth               ?? null,
      labelHeight:              order.labelHeight              ?? null,
      boxDepth:                 order.boxDepth                 ?? null,
      pouchGusset:              order.pouchGusset              ?? null,
      rollDirection:            order.rollDirection            || null,
      customBatching:           order.customBatching           || false,
      unitsPerRoll:             order.unitsPerRoll             ?? null,
      packagingInstructions:    order.packagingInstructions    || null,
      hasSpecialColor:          order.hasSpecialColor          || false,
      specialColorDetails:      order.specialColorDetails      || null,
      hasPerforation:           order.hasPerforation           || false,
      perforationNotes:         order.perforationNotes         || null,
      finishingOptions:         order.finishingOptions         || null,
      finishingNotes:           order.finishingNotes           || null,
      applicationService:       order.applicationService       || false,
      applicationContainerType: order.applicationContainerType || null,
      applicationFeePerPiece:   order.applicationFeePerPiece   ?? null,
      cutMethod:                order.cutMethod                || null,
      dieName:                  order.dieName                  || null,
      extraFrames:              order.extraFrames              ?? 0,
      makeReadyFrames:          order.makeReadyFrames          ?? 0,
      framesWasted:             order.framesWasted             ?? 0,
      skus:                     order.skus                     || null,
      skuCount:                 order.skuCount                 || 0,
      // Keep inline dataUrl payloads for now so existing UI previews remain stable.
      artworkFiles: (order.artworkFiles || []).map(f => ({
        name:  f.name,
        size:  f.size,
        type:  f.type,
        role:  f.role || 'main',
        dataUrl: f.dataUrl || null,
        r2Key: f.r2Key || null, // populated after R2 upload (PRI-237)
      })),
      whiteLayerFile:           order.whiteLayerFile           || null,
      uvFile:                   order.uvFile                   || null,
      foilFile:                 order.foilFile                 || null,
      customerPO:               order.customerPO               || null,
      quoteRef:                 order.quoteRef                 || null,
      pricePerUnit:             order.pricePerUnit             ?? null,
      orderTotal:               order.orderTotal               ?? null,
      paymentTerms:             order.paymentTerms             || null,
      invoiceNumber:            order.invoiceNumber            || null,
      invoiceStatus:            order.invoiceStatus            || 'not-invoiced',
      parentOrderId:            order.parentOrderId            || null,
      // Capacity tracking
      capacityOverride:         order.capacityOverride         || false,
      capacityDetails:          order.capacityDetails          || null,
      needsConfirmation:        order.needsConfirmation        || false,
      confirmationReason:       order.confirmationReason       || null,
      // Note metadata
      noteType:                 order.noteType                 || 'INFO',
      specialNotes:             order.specialNotes             || null,
      // Rush / Hold extras
      rushApprovedAt:           order.rushApprovedAt           || null,
      hasWhiteLayer:            order.hasWhiteLayer            || false,
      hasFoil:                  order.hasFoil                  || false,
      foilNotes:                order.foilNotes                || null,
      holdApprovals:            order.holdApprovals            || null,
      holdRequestedAt:          order.holdRequestedAt          || null,
      // Workflow state extras
      needsAccountManagerAction: order.needsAccountManagerAction || false,
      prepressResubmittedAt:     order.prepressResubmittedAt   || null,
      prepressResubmittedBy:     order.prepressResubmittedBy   || null,
      prepressStartedAt:         order.prepressStartedAt       || null,
      prepressStartedBy:         order.prepressStartedBy       || null,
      prepressPausedAt:          order.prepressPausedAt        || null,
      prepressPausedBy:          order.prepressPausedBy        || null,
      prepressResumedAt:         order.prepressResumedAt       || null,
      prepressResumedBy:         order.prepressResumedBy       || null,
      prepressApprovedAt:        order.prepressApprovedAt      || null,
      prepressApprovedBy:        order.prepressApprovedBy      || null,
      prepressCompletedAt:       order.prepressCompletedAt     || null,
      prepressCompletedBy:       order.prepressCompletedBy     || null,
      prepressIssueAt:           order.prepressIssueAt         || null,
      prepressIssueBy:           order.prepressIssueBy         || null,
      prepressIssueComment:      order.prepressIssueComment    || null,
      prepressIssueCategory:     order.prepressIssueCategory   || null,
      prepressLastUpdatedAt:     order.prepressLastUpdatedAt   || null,
      prepressLastUpdatedBy:     order.prepressLastUpdatedBy   || null,
      prepressChecklist:         order.prepressChecklist       || null,
      prepressComment:           order.prepressComment         || null,
      overtimeApproval:          order.overtimeApproval        || null,
      // Shipping / fulfillment (stored in specs JSONB)
      carrier:                   order.carrier                 || null,
      trackingNumber:            order.trackingNumber          || null,
      packingSlip:               order.packingSlip             || null,
      shippedAt:                 order.shippedAt               || null,
      waitingPickupAt:           order.waitingPickupAt         || null,
      deliveryReadyAt:           order.deliveryReadyAt         || null,
      pickupCompletedAt:         order.pickupCompletedAt       || null,
      pickupCompletedBy:         order.pickupCompletedBy       || null,
      pickupHandoffBy:           order.pickupHandoffBy         || null,
      pickupCompleteNotes:       order.pickupCompleteNotes     || null,
      receivedAt:                order.receivedAt              || null,
      qcPassedAt:                order.qcPassedAt              || null,
      // Order note history removed — keep specs clean
      notesLog:            [],
      conversationHistory: [],
    };

    return {
      order_id:                  order.orderId || '',
      customer_name:             order.customerName || order.customer || '',
      product_type:              order.productType || '',
      material:                  order.material || '',
      print_type:                order.printType || 'Sheet',
      facility:                  order.facility || '16th-street',
      quantity:                  order.quantity || 0,
      sheet_count:               order.sheetCount || 0,
      pieces_per_sheet:          order.piecesPerSheet || 1,
      color_mode:                order.colorMode || order.colors || '',
      sides:                     order.sides || '',
      status:                    order.status || 'new',
      workflow_template:         order.workflowTemplate || null,
      current_step:              order.currentStep || 0,
      due_date:                  order.dueDate || null,
      lamination:                order.lamination || 'None',
      finishing:                 order.finishingNotes || null,
      has_uv:                    order.hasUV || false,
      foil_type:                 order.foilType || 'None',
      die_status:                order.dieStatus || 'none',
      is_rush:                   order.isRush || false,
      rush_approved_by:          order.rushApprovedBy || null,
      account_manager:           order.accountManager || null,
      rep:                       order.rep || null,
      is_reprint:                order.isReprint || false,
      reprint_of_order_id:       order.reprintOfOrderId || null,
      reprint_reason:            order.reprintReason || null,
      reprint_requested_by:      order.reprintRequestedBy || null,
      reprint_notes:             order.reprintNotes || null,
      hold_reason:               order.holdReason || null,
      hold_previous_status:      order.holdPreviousStatus || null,
      hold_requested_by:         order.holdRequestedBy || null,
      material_shortage:         order.materialShortage || false,
      material_shortage_details: order.materialShortageDetails
        ? JSON.stringify(order.materialShortageDetails) : null,
      parent_order_id:           order.parentOrderId || null,
      specs,
    };
  }

  /**
   * Map Supabase orders row + workflow_steps → local order object.
   * Mirrors the shape that IndexedDB produces so pages need no changes.
   */
  function _rowToOrder(row, steps = []) {
    const s = row.specs || {};
    const skusRaw = s.skus || null;
    const skusNorm = Array.isArray(skusRaw)
      ? skusRaw.map(sku => (typeof normalizeJobTicketSku === 'function' ? normalizeJobTicketSku(sku) : sku))
      : skusRaw;
    return {
      // Supabase identity
      id:        row.id,        // UUID — used as editingDbId
      _supaId:   row.id,
      // Core fields
      orderId:       row.order_id,
      customerName:  row.customer_name,
      customer:      row.customer_name,
      productType:   row.product_type,
      material:      row.material,
      printType:     row.print_type,
      facility:      row.facility,
      quantity:      row.quantity,
      sheetCount:    row.sheet_count,
      piecesPerSheet: row.pieces_per_sheet,
      colorMode:     row.color_mode,
      colors:        row.color_mode,
      sides:         row.sides,
      status:        row.status,
      workflowTemplate: row.workflow_template,
      currentStep:   row.current_step,
      dueDate:       row.due_date,
      lamination:    row.lamination,
      finishingNotes: row.finishing,
      hasUV:         row.has_uv,
      foilType:      row.foil_type,
      dieStatus:     row.die_status,
      isRush:        row.is_rush,
      rushApprovedBy: row.rush_approved_by,
      accountManager: row.account_manager,
      rep:           row.rep,
      isReprint:     row.is_reprint,
      reprintOfOrderId:   row.reprint_of_order_id,
      reprintReason:      row.reprint_reason,
      reprintRequestedBy: row.reprint_requested_by,
      reprintNotes:       row.reprint_notes,
      holdReason:          row.hold_reason,
      holdPreviousStatus:  row.hold_previous_status,
      holdRequestedBy:     row.hold_requested_by,
      materialShortage:    row.material_shortage,
      materialShortageDetails: row.material_shortage_details
        ? JSON.parse(row.material_shortage_details) : null,
      parentOrderId: row.parent_order_id,
      createdAt:     row.created_at,
      updatedAt:     row.updated_at,
      // Workflow steps
      workflowSteps: steps.map(ws => ({
        id:          ws.id,
        machine:     ws.machine,
        operation:   ws.operation,
        status:      ws.status,
        assignedTo:  ws.operator_name,
        operator_id: ws.operator_id,
        startedAt:   ws.started_at,
        completedAt: ws.completed_at,
        notes:       ws.notes,
        stepIndex:   ws.step_index,
      })),
      // Specs fields
      jobDescription:           s.jobDescription           || '',
      otherProductDesc:         s.otherProductDesc         || '',
      labelWidth:               s.labelWidth               ?? null,
      labelHeight:              s.labelHeight              ?? null,
      boxDepth:                 s.boxDepth                 ?? null,
      pouchGusset:              s.pouchGusset              ?? null,
      rollDirection:            s.rollDirection            || '',
      customBatching:           s.customBatching           || false,
      unitsPerRoll:             s.unitsPerRoll             ?? null,
      packagingInstructions:    s.packagingInstructions    || '',
      hasSpecialColor:          s.hasSpecialColor          || false,
      specialColorDetails:      s.specialColorDetails      || '',
      hasPerforation:           s.hasPerforation           || false,
      perforationNotes:         s.perforationNotes         || '',
      finishingOptions:         s.finishingOptions         || null,
      applicationService:       s.applicationService       || false,
      applicationContainerType: s.applicationContainerType || null,
      applicationFeePerPiece:   s.applicationFeePerPiece   ?? null,
      cutMethod:                s.cutMethod                || '',
      dieName:                  s.dieName                  || '',
      extraFrames:              s.extraFrames              ?? 0,
      makeReadyFrames:          s.makeReadyFrames          ?? 0,
      framesWasted:             s.framesWasted             ?? 0,
      skus:                     skusNorm,
      skuCount:                 s.skuCount                 || 0,
      artworkFiles:             s.artworkFiles             || [],
      whiteLayerFile:           s.whiteLayerFile           || null,
      uvFile:                   s.uvFile                   || null,
      foilFile:                 s.foilFile                 || null,
      customerPO:               s.customerPO               || '',
      quoteRef:                 s.quoteRef                 || '',
      pricePerUnit:             s.pricePerUnit             ?? null,
      orderTotal:               s.orderTotal               ?? null,
      paymentTerms:             s.paymentTerms             || '',
      invoiceNumber:            s.invoiceNumber            || '',
      invoiceStatus:            s.invoiceStatus            || 'not-invoiced',
      capacityOverride:         s.capacityOverride         || false,
      capacityDetails:          s.capacityDetails          || null,
      needsConfirmation:        s.needsConfirmation        || false,
      confirmationReason:       s.confirmationReason       || '',
      noteType:                 s.noteType                 || 'INFO',
      specialNotes:             s.specialNotes             || '',
      rushApprovedAt:           s.rushApprovedAt           || null,
      hasWhiteLayer:            s.hasWhiteLayer            || false,
      hasFoil:                  s.hasFoil                  || false,
      foilNotes:                s.foilNotes                || '',
      holdApprovals:            s.holdApprovals            || null,
      holdRequestedAt:          s.holdRequestedAt          || null,
      needsAccountManagerAction: s.needsAccountManagerAction || false,
      prepressResubmittedAt:    s.prepressResubmittedAt    || null,
      prepressResubmittedBy:    s.prepressResubmittedBy    || null,
      prepressStartedAt:        s.prepressStartedAt        || null,
      prepressStartedBy:        s.prepressStartedBy        || null,
      prepressPausedAt:         s.prepressPausedAt         || null,
      prepressPausedBy:         s.prepressPausedBy         || null,
      prepressResumedAt:        s.prepressResumedAt        || null,
      prepressResumedBy:        s.prepressResumedBy        || null,
      prepressApprovedAt:       s.prepressApprovedAt       || null,
      prepressApprovedBy:       s.prepressApprovedBy       || null,
      prepressCompletedAt:      s.prepressCompletedAt      || null,
      prepressCompletedBy:      s.prepressCompletedBy      || null,
      prepressIssueAt:          s.prepressIssueAt          || null,
      prepressIssueBy:          s.prepressIssueBy          || null,
      prepressIssueComment:     s.prepressIssueComment     || null,
      prepressIssueCategory:    s.prepressIssueCategory    || null,
      prepressLastUpdatedAt:    s.prepressLastUpdatedAt    || null,
      prepressLastUpdatedBy:    s.prepressLastUpdatedBy    || null,
      prepressChecklist:        s.prepressChecklist        || null,
      prepressComment:          s.prepressComment          || null,
      overtimeApproval:         s.overtimeApproval         || null,
      carrier:                  s.carrier                  || null,
      trackingNumber:           s.trackingNumber           || null,
      packingSlip:              s.packingSlip              || null,
      shippedAt:                s.shippedAt                || null,
      waitingPickupAt:          s.waitingPickupAt          || null,
      deliveryReadyAt:          s.deliveryReadyAt          || null,
      pickupCompletedAt:        s.pickupCompletedAt        || null,
      pickupCompletedBy:        s.pickupCompletedBy        || null,
      pickupHandoffBy:          s.pickupHandoffBy          || null,
      pickupCompleteNotes:      s.pickupCompleteNotes      || null,
      receivedAt:               s.receivedAt               || null,
      qcPassedAt:               s.qcPassedAt               || null,
      notesLog:            [],
      conversationHistory: [],
    };
  }

  // ── Order CRUD ───────────────────────────────────────────────

  // Columns needed for queue/list views — no specs JSONB, no workflow steps.
  // Keeps egress tiny (~1-2 KB/row vs 10-50 KB for SELECT *).
  const _QUEUE_COLS = [
    'id','order_id','customer_name','product_type','facility','quantity',
    'status','due_date','is_rush','account_manager','rep',
    'is_reprint','parent_order_id','created_at','updated_at','current_step',
    'material','cut_method',
  ].join(',');

  async function _getAllOrders() {
    const supa = await _getClient();
    const { data, error } = await supa
      .from('orders')
      .select(`*, order_workflow_steps(*)`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(row =>
      _rowToOrder(row, row.order_workflow_steps || [])
    );
  }

  // Lightweight version: only queue-display columns, no specs, no workflow steps.
  async function _getAllOrdersSummary() {
    const supa = await _getClient();
    const { data, error } = await supa
      .from('orders')
      .select(_QUEUE_COLS)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(row => _rowToOrder(row, []));
  }

  async function _getOrder(id) {
    // id is the Supabase UUID
    const supa = await _getClient();
    const { data, error } = await supa
      .from('orders')
      .select(`*, order_workflow_steps(*)`)
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!data) return null;
    return _rowToOrder(data, data.order_workflow_steps || []);
  }

  async function _getOrderByOrderId(orderId) {
    if (!orderId) return null;
    const supa = await _getClient();
    const { data, error } = await supa
      .from('orders')
      .select(`*, order_workflow_steps(*)`)
      .eq('order_id', String(orderId))
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return _rowToOrder(data, data.order_workflow_steps || []);
  }

  async function _generateOrderId() {
    const supa = await _getClient();
    // Get all base order IDs (numeric part before first underscore)
    const { data, error } = await supa
      .from('orders')
      .select('order_id');
    if (error) throw error;
    const baseIds = (data || [])
      .map(r => parseInt(String(r.order_id || '').split('_')[0], 10))
      .filter(Number.isFinite);
    if (baseIds.length === 0) return '17900';
    return String(Math.max(...baseIds) + 1);
  }

  async function _generateSubTicketId(parentOrderId) {
    const suba = await _getClient();
    const parentBase = String(parentOrderId || '').split('_')[0];
    const { data, error } = await suba
      .from('orders')
      .select('order_id')
      .like('order_id', `${parentBase}_%`);
    if (error) throw error;
    // Find all sub-ticket numbers for this parent
    const existingSubs = (data || [])
      .map(r => {
        const parts = String(r.order_id).split('_');
        return parts.length >= 2 ? parseInt(parts[1], 10) : 0;
      })
      .filter(n => Number.isFinite(n) && n > 0);
    const nextNum = existingSubs.length > 0 ? Math.max(...existingSubs) + 1 : 1;
    return `${parentBase}_${nextNum}`;
  }

  async function _addOrder(order) {
    const supa = await _getClient();
    const user = await _getCurrentUser();
    if (!user) throw new Error('Not signed in to Supabase. Log out and sign in again.');
    const profile = await _getCurrentProfile();
    if (!profile) {
      throw new Error(
        'No profiles row for your login. Run Supabase migration 039_ensure_pulse_profile.sql, then log out and back in.'
      );
    }

    const row = _orderToRow(order);
    if (user) row.created_by = user.id;

    const { data: inserted, error } = await supa
      .from('orders')
      .insert(row)
      .select()
      .single();
    if (error) throw error;

    // Insert workflow steps if any
    if (Array.isArray(order.workflowSteps) && order.workflowSteps.length > 0) {
      const steps = order.workflowSteps.map((step, idx) => ({
        order_id:    inserted.id,
        step_index:  step.stepIndex ?? idx,
        machine:     step.machine,
        operation:   step.operation || null,
        status:      step.status || 'pending',
        operator_name: step.assignedTo || null,
        notes:       step.notes || null,
      }));
      const { error: stepsError } = await supa
        .from('order_workflow_steps')
        .insert(steps);
      if (stepsError) console.error('[Pulse/Supabase] workflow steps insert error:', stepsError);
    }

    // Return the IndexedDB-compatible numeric-like ID (Supabase UUID used as id)
    return inserted.id;
  }

  async function _formatPulseDbError(err, op = 'update') {
    const msg = err?.message || err?.details || String(err || 'Unknown error');
    const verb = op === 'insert' ? 'create' : 'update';
    if (/invalid input value for enum order_status/i.test(msg)) {
      if (/delivery-ready/i.test(msg)) {
        return 'The database does not support the “delivery-ready” status yet. Run Supabase migration 021_delivery_ready_status.sql, then try again.';
      }
      if (/waiting-pickup/i.test(msg)) {
        return 'The database does not support the “waiting-pickup” status yet. Run Supabase migration 021_delivery_ready_status.sql, then try again.';
      }
      return 'This status is not allowed in the database yet. Ask an admin to apply the latest Supabase migrations.';
    }
    if (/PGRST116|0 rows|not found/i.test(msg)) {
      return `Order not found or you do not have permission to ${verb} it. Refresh the page and try again.`;
    }
    if (/permission denied|row-level security|42501|insufficient permissions|was blocked/i.test(msg)) {
      let roleLine = '';
      try {
        const profile = await _getCurrentProfile();
        if (profile?.role) {
          roleLine = ` Your Supabase profiles.role is “${profile.role}” (this controls database access, not the Personnel label).`;
        } else {
          roleLine = ' No profiles row was found for your login — ask an admin to fix your auth user.';
        }
      } catch (_) {}
      const orderHint = op === 'update'
        ? ' Saving with ?order= in the URL updates an existing ticket; use “New ticket” for a fresh create.'
        : '';
      return `You do not have permission to ${verb} this order.${roleLine}${orderHint} Apply migrations 034 and 038 on Supabase if you should have access.`;
    }
    if (/invalid input syntax for type uuid/i.test(msg)) {
      return 'Workflow step save failed due to an invalid step id. Refresh the page and save again.';
    }
    if (/duplicate key|order_workflow_steps_order_id_step_index_key/i.test(msg)) {
      return 'Workflow step save conflict — refresh the page and try again. If it keeps failing, ask an admin to run Supabase migration 040_order_workflow_steps_delete.sql.';
    }
    if (/EMAIL_ALREADY_EXISTS/i.test(msg)) {
      return msg.replace(/^EMAIL_ALREADY_EXISTS:\s*/i, '').trim();
    }
    if (/statement timeout|canceling statement due to statement timeout/i.test(msg)) {
      return 'Save timed out. Refresh the page and try again; if it persists, ask an admin to check Supabase load or apply migration 040.';
    }
    return msg;
  }

  function _isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function _workflowStepPayload(step, idx) {
    return {
      step_index:    step.stepIndex != null ? step.stepIndex : idx,
      machine:       step.machine,
      operation:     step.operation || null,
      status:        step.status || 'pending',
      operator_id:   _isUuid(step.operator_id) ? step.operator_id : null,
      operator_name: step.assignedTo || null,
      started_at:    step.startedAt || null,
      completed_at:  step.completedAt || null,
      notes:         step.notes || null,
    };
  }

  async function _syncWorkflowSteps(supa, orderId, workflowSteps) {
    const { data: existingRows, error: fetchErr } = await supa
      .from('order_workflow_steps')
      .select('id, step_index')
      .eq('order_id', orderId);
    if (fetchErr) throw fetchErr;

    // Canonical step_index is the array position (0..n-1). This guarantees
    // unique indices and avoids any (order_id, step_index) duplicate-key
    // conflicts no matter what stepIndex values the UI sends.
    const steps = Array.isArray(workflowSteps) ? workflowSteps : [];
    const desired = steps.map((step, idx) => {
      const payload = _workflowStepPayload(step, idx);
      payload.step_index = idx;
      return { order_id: orderId, ...payload };
    });

    // Delete rows that are no longer part of the workflow first, so their
    // indices are free before we upsert.
    const keepIndices = new Set(desired.map(d => d.step_index));
    for (const row of existingRows || []) {
      if (keepIndices.has(row.step_index)) continue;
      const { error } = await supa
        .from('order_workflow_steps')
        .delete()
        .eq('id', row.id);
      if (error) throw error;
    }

    if (!desired.length) return;

    // Upsert on the unique (order_id, step_index) key: existing indices are
    // updated in place, new ones inserted — in a single conflict-safe call.
    const { error: upsertErr } = await supa
      .from('order_workflow_steps')
      .upsert(desired, { onConflict: 'order_id,step_index' });
    if (upsertErr) throw upsertErr;
  }

  async function _updateOrder(id, changes) {
    const supa = await _getClient();
    const user = await _getCurrentUser();
    if (!user) throw new Error('Not signed in to Supabase. Log out and sign in again.');
    const profile = await _getCurrentProfile();
    if (!profile) {
      throw new Error(
        'No profiles row for your login. Run Supabase migration 039_ensure_pulse_profile.sql, then log out and back in.'
      );
    }

    let lookupId = id;
    let { data: currentRow, error: fetchErr } = await supa
      .from('orders')
      .select(`*, order_workflow_steps(*)`)
      .eq('id', lookupId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!currentRow && id != null && String(id) !== '') {
      const ref = String(id);
      const { data: byOrderId, error: oidErr } = await supa
        .from('orders')
        .select(`*, order_workflow_steps(*)`)
        .eq('order_id', ref)
        .maybeSingle();
      if (oidErr) throw oidErr;
      if (byOrderId) {
        currentRow = byOrderId;
        lookupId = byOrderId.id;
      }
    }
    if (!currentRow) {
      throw new Error('Order not found');
    }

    const existing = _rowToOrder(currentRow, currentRow.order_workflow_steps || []);
    const combined = { ...existing, ...(changes || {}), id: existing.id };
    const row = _orderToRow(combined);

    if (currentRow?.specs) {
      row.specs = { ...currentRow.specs, ...row.specs };
    }

    // Never lose graphics: if the incoming update carries no artwork at all but
    // the stored order has some, keep the stored graphics so artwork survives
    // every production step (prepress, production, shipping, etc.).
    const _hasGraphics = (typeof window !== 'undefined' && window.pulseOrderHasGraphics) || null;
    const _preserveGraphics = (typeof window !== 'undefined' && window.pulsePreserveGraphics) || null;
    if (_hasGraphics && _preserveGraphics && currentRow?.specs
        && _hasGraphics(currentRow.specs) && !_hasGraphics(row.specs)) {
      _preserveGraphics(row.specs, currentRow.specs);
    }

    const { data: updatedRow, error: updateErr } = await supa
      .from('orders')
      .update(row)
      .eq('id', lookupId)
      .select('id')
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updatedRow) {
      throw new Error('Order update was blocked (not found or insufficient permissions).');
    }

    if (Array.isArray(changes.workflowSteps)) {
      await _syncWorkflowSteps(supa, lookupId, changes.workflowSteps);
    }

    return combined;
  }

  async function _getSubTickets(parentOrderId) {
    if (!parentOrderId) return [];
    const supa = await _getClient();
    const { data, error } = await supa
      .from('orders')
      .select(`*, order_workflow_steps(*)`)
      .eq('parent_order_id', String(parentOrderId))
      .order('order_id', { ascending: true });
    if (error) throw error;
    return (data || []).map(row => _rowToOrder(row, row.order_workflow_steps || []));
  }

  // ── Activity Log ─────────────────────────────────────────────

  async function _resolveOrderUuid(supa, orderIdOrUuid) {
    if (orderIdOrUuid == null || orderIdOrUuid === '') return null;
    const s = String(orderIdOrUuid);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
    const { data, error } = await supa
      .from('orders')
      .select('id')
      .eq('order_id', s)
      .maybeSingle();
    if (error) throw error;
    return data?.id || null;
  }

  async function _addActivity(log) {
    if (!log) return null;
    try {
      const supa = await _getClient();
      const orderUuid = log.orderUuid || log._supaId
        || await _resolveOrderUuid(supa, log.orderId || log.order_id);
      if (!orderUuid) return null;
      const profile = await _getCurrentProfile();
      const actorName = log.operatorName || log.by || profile?.display_name || 'System';
      const details = { ...(typeof log.details === 'object' && log.details ? log.details : {}) };
      if (log.message != null) details.message = log.message;
      if (log.note != null) details.note = log.note;
      if (log.machine != null) details.machine = log.machine;
      if (log.stepIdx != null) details.stepIdx = log.stepIdx;
      if (log.shortfall != null) details.shortfall = log.shortfall;
      const { data, error } = await supa
        .from('activity_log')
        .insert({
          order_id:   orderUuid,
          action:     log.type || log.action || 'activity',
          actor_id:   profile?.id || null,
          actor_name: actorName,
          details:    Object.keys(details).length ? details : null,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    } catch (e) {
      console.warn('[Pulse/Supabase] addActivity:', e);
      return null;
    }
  }

  async function _getActivityLog(orderIdOrUuid) {
    try {
      const supa = await _getClient();
      const orderUuid = await _resolveOrderUuid(supa, orderIdOrUuid);
      if (!orderUuid) return [];

      const events = [];

      const { data: acts, error: actErr } = await supa
        .from('activity_log')
        .select('action, actor_name, created_at, details')
        .eq('order_id', orderUuid)
        .order('created_at', { ascending: true });
      if (actErr) throw actErr;
      for (const row of acts || []) {
        const det = row.details && typeof row.details === 'object' ? row.details : null;
        const t = new Date(row.created_at).getTime();
        if (Number.isNaN(t)) continue;
        events.push({
          ts: t,
          iso: row.created_at,
          title: row.action || 'Activity',
          who: row.actor_name || '',
          note: det?.message || det?.note || (typeof row.details === 'string' ? row.details : ''),
          source: 'activity',
        });
      }

      const { data: hist, error: histErr } = await supa
        .from('order_status_history')
        .select('from_status, to_status, changed_by_name, reason, created_at')
        .eq('order_id', orderUuid)
        .order('created_at', { ascending: true });
      if (histErr) throw histErr;
      for (const row of hist || []) {
        const t = new Date(row.created_at).getTime();
        if (Number.isNaN(t)) continue;
        const from = row.from_status ? String(row.from_status).replace(/-/g, ' ') : '—';
        const to = row.to_status ? String(row.to_status).replace(/-/g, ' ') : '—';
        events.push({
          ts: t,
          iso: row.created_at,
          title: `Status: ${from} → ${to}`,
          who: row.changed_by_name || '',
          note: row.reason || '',
          source: 'status',
        });
      }

      const { data: comments, error: comErr } = await supa
        .from('order_comments')
        .select('author_name, body, created_at')
        .eq('order_id', orderUuid)
        .order('created_at', { ascending: true });
      if (comErr) throw comErr;
      for (const row of comments || []) {
        const t = new Date(row.created_at).getTime();
        if (Number.isNaN(t)) continue;
        events.push({
          ts: t,
          iso: row.created_at,
          title: 'Comment',
          who: row.author_name || '',
          note: row.body || '',
          source: 'comment',
        });
      }

      events.sort((a, b) => a.ts - b.ts);
      return events;
    } catch (e) {
      console.warn('[Pulse/Supabase] getActivityLog:', e);
      return [];
    }
  }

  async function _getAllActivity() {
    return [];
  }

  // ── Order Comments ───────────────────────────────────────────

  async function _getOrderComments(orderId) {
    const supa = await _getClient();
    const { data: orderRow } = await supa
      .from('orders')
      .select('id')
      .eq('order_id', String(orderId))
      .maybeSingle();
    if (!orderRow) return [];
    const { data, error } = await supa
      .from('order_comments')
      .select('*')
      .eq('order_id', orderRow.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function _addOrderComment(orderId, body, authorName) {
    const supa = await _getClient();
    const user = await _getCurrentUser();
    const profile = user ? await _getCurrentProfile() : null;

    // Resolve order UUID
    const { data: orderRow } = await supa
      .from('orders')
      .select('id')
      .eq('order_id', String(orderId))
      .maybeSingle();
    if (!orderRow) throw new Error(`Order ${orderId} not found`);

    const { data, error } = await supa
      .from('order_comments')
      .insert({
        order_id:    orderRow.id,
        author_id:   user?.id || null,
        author_name: authorName || profile?.display_name || 'Unknown',
        body,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ── Realtime subscriptions ───────────────────────────────────

  function _dispatchPulseEvent(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /** Order/workflow/comment/task changes — all pages refresh queues & boards. */
  function _fireOrderRelatedChange(table, payload) {
    const detail = { table, ...payload };
    _dispatchPulseEvent('pulse:order-change', detail);
    // Legacy alias used by dashboard.html / job-ticket.html before Realtime cleanup
    _dispatchPulseEvent('pulse:orders-changed', detail);
  }

  /** Admin catalog, org structure, dies, personnel, machine issues, etc. */
  function _fireReferenceDataChange(table, payload) {
    const scopeByTable = {
      config: 'config',
      dies: 'dies',
      knowledge_base: 'knowledge',
      profiles: 'personnel',
      organisation_facilities: 'organisation',
      organisation_hardware: 'organisation',
      machines: 'machines',
      product_workflows: 'workflows',
      machine_issues: 'machine_issues',
      purchase_orders: 'purchase_orders',
      operator_sessions: 'operator_sessions',
      packaging_products: 'packaging',
    };
    _dispatchPulseEvent('pulse:reference-data-changed', {
      scope: scopeByTable[table] || table,
      table,
      payload,
    });
  }

  function _registerRealtimeSubscriptions(supa) {
    const channel = supa.channel('pulse-realtime');

    ['orders', 'order_workflow_steps', 'order_comments'].forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        _fireOrderRelatedChange(table, payload);
      });
    });

    ['production_tasks', 'qc_tasks'].forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        _fireOrderRelatedChange(table, payload);
        _dispatchPulseEvent('pulse:task-change', { table, ...payload });
      });
    });

    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, (payload) => {
      _dispatchPulseEvent('pulse:activity-change', payload);
    });

    [
      'config',
      'dies',
      'knowledge_base',
      'profiles',
      'organisation_facilities',
      'organisation_hardware',
      'machines',
      'product_workflows',
      'machine_issues',
      'operator_sessions',
    ].forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        _fireReferenceDataChange(table, payload);
      });
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.debug('[Pulse/Supabase] Realtime channel active');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Pulse/Supabase] Realtime channel:', status);
      }
    });
  }

  // ── Auth helpers (exposed globally for pages) ────────────────

  window.supabaseSignIn = async function (email, password) {
    const supa = await _getClient();
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  };

  window.supabaseSignOut = async function () {
    const supa = await _getClient();
    await supa.auth.signOut();
  };

  window.supabaseGetSession = async function () {
    const supa = await _getClient();
    const { data } = await supa.auth.getSession();
    return data?.session || null;
  };

  window.supabaseGetProfile = _getCurrentProfile;
  window.supabaseEnsureProfile = _ensurePulseProfileRow;

  // ── Override global functions from shared.js ─────────────────
  // Skipped on migrate-to-supabase.html so backup import writes to IndexedDB.

  if (MIGRATE_TOOL) {
    // migrateIndexedDBToSupabase only — registered below after internal helpers exist
  } else {

  const _origGetAllOrders       = window.getAllOrders;
  const _origGetOrder           = window.getOrder;
  const _origGetOrderByOrderId  = window.getOrderByOrderId;
  const _origAddOrder           = window.addOrder;
  const _origUpdateOrder        = window.updateOrder;
  const _origGenerateOrderId    = window.generateOrderId;
  const _origGenerateSubTicketId = window.generateSubTicketId;
  const _origGetSubTickets      = window.getSubTickets;
  const _origGetConfig        = window.getConfig;
  const _origSetConfig        = window.setConfig;
  const _origGetAllConfigEntries = window.getAllConfigEntries;
  const _origGetAllPersonnel    = window.getAllPersonnel;
  const _origAddPersonnel       = window.addPersonnel;
  const _origUpdatePersonnel    = window.updatePersonnel;
  const _origDeletePersonnel    = window.deletePersonnel;

  function _newPersonnelId(prefix = 'p') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function _stablePersonnelId(row, index) {
    if (row._profileId) return String(row._profileId);
    if (row.id != null && row.id !== '') return String(row.id);
    if (row.userId != null && String(row.userId).trim()) return `uid:${String(row.userId).trim()}`;
    const nameKey = String(row.name || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (nameKey) return `name:${nameKey}`;
    return _newPersonnelId(`p${index}`);
  }

  function _personnelRoleToDb(role) {
    return String(role || 'operator').trim().replace(/-/g, '_');
  }

  function _personnelRoleFromDb(role) {
    return String(role || 'operator').trim().replace(/_/g, '-');
  }

  function _resolveFacilitySlugForDb(facilityInput) {
    if (typeof pulseResolveFacilitySlug === 'function') {
      return pulseResolveFacilitySlug(facilityInput);
    }
    const raw = String(facilityInput || '').trim();
    if (raw === 'both' || raw === 'Both Facilities' || raw === 'All Facilities') return 'both';
    if (raw === '16th-street' || raw === 'boyd-street') return raw;
    return null;
  }

  // profiles.facility is the Postgres `facility` enum (only '16th-street' /
  // 'boyd-street'). "Both / all facilities" has no enum value, so it is stored
  // as NULL — which RLS already treats as "all facilities".
  function _facilityForProfileColumn(facilityInput) {
    const slug = _resolveFacilitySlugForDb(facilityInput);
    return (slug === '16th-street' || slug === 'boyd-street') ? slug : null;
  }

  function _profileRowToPersonnel(row, userIdOverride) {
    const userId = userIdOverride != null
      ? String(userIdOverride)
      : (row.pulse_user_id != null ? String(row.pulse_user_id) : '');
    return {
      id: row.id,
      _profileId: row.id,
      name: row.display_name,
      role: _personnelRoleFromDb(row.role),
      // NULL facility means "all facilities" → show as 'both' in the editor.
      facility: row.facility || 'both',
      phone: row.phone || '',
      userId,
      active: row.active !== false,
      shift: row.shift_start || '',
      machines: row.machines || [],
      notes: row.notes || '',
    };
  }

  function _isProfileUuid(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''));
  }

  async function _fetchPersonnelFromProfiles() {
    const supa = await _getClient();
    const baseCols = 'id, display_name, role, facility, phone, active, shift_start, machines, notes';
    let { data, error } = await supa
      .from('profiles')
      .select(`${baseCols}, pulse_user_id`)
      .order('display_name');
    if (error?.code === '42703') {
      ({ data, error } = await supa.from('profiles').select(baseCols).order('display_name'));
    }
    if (error) throw error;
    const rows = data || [];
    const userIdByName = await _legacyPersonnelUserIdMap();
    return rows.map(row => {
      const legacyUid = userIdByName.get(String(row.display_name || '').trim().toLowerCase());
      const uid = row.pulse_user_id != null && String(row.pulse_user_id).trim()
        ? row.pulse_user_id
        : legacyUid;
      return _profileRowToPersonnel(row, uid);
    });
  }

  async function _legacyPersonnelUserIdMap() {
    const map = new Map();
    try {
      const rec = await _supaGetConfig('personnel');
      const list = rec?.value && Array.isArray(rec.value) ? rec.value : [];
      list.forEach(p => {
        const name = String(p?.name || '').trim().toLowerCase();
        const uid = String(p?.userId || '').trim();
        if (name && uid) map.set(name, uid);
      });
    } catch (_) {}
    return map;
  }

  function _normalizePersonnelList(list) {
    let changed = false;
    const out = (Array.isArray(list) ? list : []).map((p, i) => {
      const row = { ...(p || {}) };
      const stableId = _stablePersonnelId(row, i);
      if (String(row.id ?? '') !== stableId) {
        row.id = stableId;
        changed = true;
      }
      if (row.active === undefined) row.active = true;
      return row;
    });
    return { list: out, changed };
  }

  async function _getPersonnelList() {
    const rec = await _supaGetConfig('personnel');
    let list = rec?.value && Array.isArray(rec.value) ? rec.value : [];
    const { list: normalized, changed } = _normalizePersonnelList(list);
    if (changed && normalized.length) {
      try { await _supaSetConfig('personnel', normalized); } catch (_) {}
    }
    return normalized;
  }

  async function _savePersonnelList(list) {
    await _supaSetConfig('personnel', list);
  }

  function _notifyPersonnelChanged() {
    if (typeof pulseNotifyReferenceDataChanged === 'function') {
      pulseNotifyReferenceDataChanged({ scope: 'personnel' });
    }
  }

  function _findPersonnelInList(list, id) {
    const key = String(id ?? '');
    return list.find(p =>
      String(p.id) === key ||
      String(p._profileId) === key ||
      (key.startsWith('uid:') && String(p.userId) === key.slice(4)) ||
      (key.startsWith('name:') && String(p.name || '').trim().toLowerCase().replace(/\s+/g, '_') === key.slice(5))
    );
  }

  async function _syncConfigPersonnelRow(person) {
    if (!person?.name) return;
    try {
      const list = await _getPersonnelList();
      const key = String(person.name).trim().toLowerCase();
      const idx = list.findIndex(p => String(p.name || '').trim().toLowerCase() === key);
      const row = {
        ...(idx >= 0 ? list[idx] : {}),
        ...person,
        id: idx >= 0 ? list[idx].id : _stablePersonnelId(person, list.length),
        name: person.name,
      };
      if (idx >= 0) list[idx] = row;
      else list.push(row);
      await _savePersonnelList(list);
    } catch (e) {
      console.warn('[Pulse/Supabase] _syncConfigPersonnelRow:', e);
    }
  }

  async function _updateProfilePersonnel(id, changes) {
    const supa = await _getClient();
    const patch = {};
    if (changes.name != null) patch.display_name = String(changes.name).trim();
    if (changes.role != null) patch.role = _personnelRoleToDb(changes.role);
    if (changes.facility != null) patch.facility = _facilityForProfileColumn(changes.facility);
    if (changes.phone != null) patch.phone = String(changes.phone).trim() || null;
    if (changes.active != null) patch.active = !!changes.active;
    if (changes.userId != null) patch.pulse_user_id = String(changes.userId).trim() || null;

    let query = supa.from('profiles').update(patch).eq('id', id);
    let { data, error } = await query.select().single();
    if (error?.code === '42703' && patch.pulse_user_id !== undefined) {
      delete patch.pulse_user_id;
      ({ data, error } = await supa.from('profiles').update(patch).eq('id', id).select().single());
    }
    if (error) throw error;
    const mapped = _profileRowToPersonnel(data, changes.userId);
    await _syncConfigPersonnelRow(mapped);
    _notifyPersonnelChanged();
    return mapped;
  }

  async function _supaGetConfig(key) {
    const supa = await _getClient();
    const { data, error } = await supa.from('config').select('*').eq('key', key).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function _supaSetConfig(key, value) {
    const supa = await _getClient();
    const { error } = await supa.from('config').upsert(
      { key, value },
      { onConflict: 'key' }
    );
    if (error) throw error;
  }

  async function _supaGetAllConfigEntries() {
    const supa = await _getClient();
    const { data, error } = await supa.from('config').select('*');
    if (error) throw error;
    return data || [];
  }

  window.getConfig = async function (key) {
    try { return await _supaGetConfig(key); }
    catch (e) {
      console.error('[Pulse/Supabase] getConfig:', e);
      return null;
    }
  };

  window.setConfig = async function (key, value) {
    try { return await _supaSetConfig(key, value); }
    catch (e) {
      console.error('[Pulse/Supabase] setConfig:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.getAllConfigEntries = async function () {
    try { return await _supaGetAllConfigEntries(); }
    catch (e) {
      console.error('[Pulse/Supabase] getAllConfigEntries:', e);
      return [];
    }
  };

  function _mergePersonnelRows(primary, secondary) {
    if (!secondary) return primary;
    if (!primary) return secondary;
    const profileId = primary._profileId || primary.id;
    const useProfileId = _isProfileUuid(profileId) ? profileId : (secondary._profileId || secondary.id);
    return {
      ...secondary,
      ...primary,
      id: useProfileId || primary.id || secondary.id,
      _profileId: _isProfileUuid(profileId) ? profileId : (secondary._profileId || null),
      name: primary.name || secondary.name,
      role: primary.role || secondary.role,
      facility: primary.facility || secondary.facility,
      userId: primary.userId || secondary.userId || '',
      phone: primary.phone || secondary.phone || '',
      active: primary.active !== false && secondary.active !== false,
      shift: primary.shift || secondary.shift || '',
      machines: (Array.isArray(primary.machines) && primary.machines.length)
        ? primary.machines
        : (secondary.machines || []),
      notes: primary.notes || secondary.notes || '',
    };
  }

  // ── Personnel CRUD — Supabase profiles table is the single source of truth ──
  // No JSON config blob. All reads/writes go directly to the profiles table.
  // The upsert_pulse_personnel() DB function handles auth account sync too.

  window.getAllPersonnel = async function () {
    try {
      return await _fetchPersonnelFromProfiles();
    } catch (e) {
      console.error('[Pulse/Supabase] getAllPersonnel:', e);
      return [];
    }
  };

  // addPersonnel: called from admin only — uses the DB function that provisions
  // the Supabase auth account + profiles row in one atomic call.
  window.addPersonnel = async function (person) {
    const name = String(person?.name || '').trim();
    if (!name) throw new Error('Name is required');
    try {
      const result = await window.upsertPulsePersonnel(person);
      _notifyPersonnelChanged();
      return result?.id || result;
    } catch (e) {
      console.error('[Pulse/Supabase] addPersonnel:', e);
      throw new Error(e.message || 'Could not add personnel. Make sure you are signed in as admin.');
    }
  };

  // updatePersonnel: routes to profiles table (UUID id) or by name lookup.
  // When called from login auto-save (no admin session), only pulse_user_id is updated.
  window.updatePersonnel = async function (id, changes) {
    const key = String(id ?? '');
    // Direct profile UUID update (most common from admin)
    if (_isProfileUuid(key)) {
      try {
        return await _updateProfilePersonnel(key, changes || {});
      } catch (e) {
        console.error('[Pulse/Supabase] updatePersonnel (profiles):', e);
        throw e;
      }
    }
    // Find profile by non-UUID id (e.g. legacy id stored in personnel record)
    try {
      const allProfiles = await _fetchPersonnelFromProfiles().catch(() => []);
      const match = _findPersonnelInList(allProfiles, key);
      if (match?._profileId) return _updateProfilePersonnel(match._profileId, changes || {});
    } catch (e) {
      console.error('[Pulse/Supabase] updatePersonnel (lookup):', e);
    }
    throw new Error('Personnel record not found in Supabase profiles');
  };

  // deletePersonnel: marks profile as inactive — never hard-deletes.
  window.deletePersonnel = async function (id) {
    const key = String(id ?? '');
    if (_isProfileUuid(key)) {
      await _updateProfilePersonnel(key, { active: false });
      _notifyPersonnelChanged();
      return true;
    }
    const allProfiles = await _fetchPersonnelFromProfiles().catch(() => []);
    const match = _findPersonnelInList(allProfiles, key);
    if (match?._profileId) {
      await _updateProfilePersonnel(match._profileId, { active: false });
      _notifyPersonnelChanged();
      return true;
    }
    throw new Error('Personnel record not found in Supabase profiles');
  };

  window.getAllOrders = async function () {
    window.PULSE_LAST_ORDERS_ERROR = null;
    try { return await _getAllOrders(); }
    catch (e) {
      console.error('[Pulse/Supabase] getAllOrders:', e);
      window.PULSE_LAST_ORDERS_ERROR = e;
      return [];
    }
  };

  // Lightweight queue summary — use this for polling/list views to minimize egress.
  window.getAllOrdersSummary = async function () {
    try { return await _getAllOrdersSummary(); }
    catch (e) {
      console.warn('[Pulse/Supabase] getAllOrdersSummary fallback to full:', e);
      return window.getAllOrders();
    }
  };

  window.getOrder = async function (id) {
    try { return await _getOrder(id); }
    catch (e) { console.error('[Pulse/Supabase] getOrder:', e); return _origGetOrder ? _origGetOrder(id) : null; }
  };

  window.getOrderByOrderId = async function (orderId) {
    try { return await _getOrderByOrderId(orderId); }
    catch (e) { console.error('[Pulse/Supabase] getOrderByOrderId:', e); return _origGetOrderByOrderId ? _origGetOrderByOrderId(orderId) : null; }
  };

  window.addOrder = async function (order) {
    try { return await _addOrder(order); }
    catch (e) {
      console.error('[Pulse/Supabase] addOrder:', e);
      throw new Error(await _formatPulseDbError(e, 'insert'));
    }
  };

  window.updateOrder = async function (id, changes) {
    try { return await _updateOrder(id, changes); }
    catch (e) {
      console.error('[Pulse/Supabase] updateOrder:', e);
      throw new Error(await _formatPulseDbError(e, 'update'));
    }
  };

  window.generateOrderId = async function () {
    try { return await _generateOrderId(); }
    catch (e) { console.error('[Pulse/Supabase] generateOrderId:', e); return _origGenerateOrderId ? _origGenerateOrderId() : '17900'; }
  };

  window.generateSubTicketId = async function (parentOrderId) {
    try { return await _generateSubTicketId(parentOrderId); }
    catch (e) { console.error('[Pulse/Supabase] generateSubTicketId:', e); return _origGenerateSubTicketId ? _origGenerateSubTicketId(parentOrderId) : null; }
  };

  window.getSubTickets = async function (parentOrderId) {
    try { return await _getSubTickets(parentOrderId); }
    catch (e) { console.error('[Pulse/Supabase] getSubTickets:', e); return _origGetSubTickets ? _origGetSubTickets(parentOrderId) : []; }
  };

  window.addActivity = async function (log) {
    try { return await _addActivity(log); }
    catch (e) {
      console.error('[Pulse/Supabase] addActivity:', e);
      return null;
    }
  };

  window.getActivityLog = async function (orderIdOrUuid) {
    try { return await _getActivityLog(orderIdOrUuid); }
    catch (e) {
      console.error('[Pulse/Supabase] getActivityLog:', e);
      return [];
    }
  };

  window.getAllActivity = async function () {
    return [];
  };

  // Expose comment helpers
  window.getOrderComments = _getOrderComments;
  window.addOrderComment  = _addOrderComment;

  } // end !MIGRATE_TOOL CRUD overrides

  // ── Migration helper: IndexedDB → Supabase (full admin + production data) ─

  const _PULSE_CAT_KEYS = {
    colorModes: 'catalogColorModes',
    materials: 'catalogMaterials',
    finishing: 'catalogFinishing',
    products: 'productCatalog',
  };

  function _readIndexedDBStore(storeName) {
    if (!MIGRATE_TOOL) {
      return Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('BazaarPrintDB');
      req.onsuccess = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const all = tx.objectStore(storeName).getAll();
        all.onsuccess = () => resolve(all.result || []);
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _readIndexedDBConfigMap() {
    return _readIndexedDBStore('config').then(rows => {
      const out = {};
      (rows || []).forEach(r => {
        if (r?.key) out[r.key] = r.value !== undefined ? r.value : r;
      });
      return out;
    });
  }

  function _migratePushError(report, phase, item, err) {
    const msg = err?.message || String(err);
    report.errors.push({ phase, item, error: msg });
  }

  let _migrateProgressCb = null;

  async function _migrateUpsertConfig(supa, report, key, value) {
    if (value === undefined || value === null) return;
    const { error } = await supa.from('config').upsert(
      { key, value },
      { onConflict: 'key' }
    );
    if (error) throw error;
    report.counts.config = (report.counts.config || 0) + 1;
  }

  async function _migrateAdminConfig(supa, report) {
    _migrateProgressCb?.({ phase: 'config' });
    const cfg = await _readIndexedDBConfigMap();
    const keys = [
      _PULSE_CAT_KEYS.colorModes,
      _PULSE_CAT_KEYS.materials,
      _PULSE_CAT_KEYS.finishing,
      _PULSE_CAT_KEYS.products,
      'machineCapacity',
      'customRoles',
    ];
    for (const key of keys) {
      if (cfg[key] === undefined) continue;
      try {
        await _migrateUpsertConfig(supa, report, key, cfg[key]);
      } catch (e) {
        _migratePushError(report, 'config', key, e);
      }
    }
    const personnel = await _readIndexedDBStore('personnel');
    if (personnel.length) {
      try {
        await _migrateUpsertConfig(supa, report, 'personnel', personnel);
        report.counts.personnel = personnel.length;
      } catch (e) {
        _migratePushError(report, 'personnel', 'personnel', e);
      }
    }
    const devices = await _readIndexedDBStore('devices');
    if (devices.length) {
      try {
        await _migrateUpsertConfig(supa, report, 'pulse_devices', devices);
        report.counts.devices = devices.length;
      } catch (e) {
        _migratePushError(report, 'devices', 'pulse_devices', e);
      }
    }
    const reprints = await _readIndexedDBStore('reprints');
    if (reprints.length) {
      try {
        await _migrateUpsertConfig(supa, report, 'pulse_reprints', reprints);
        report.counts.reprints = reprints.length;
      } catch (e) {
        _migratePushError(report, 'reprints', 'pulse_reprints', e);
      }
    }
  }

  async function _migrateMachinesTable(supa, report) {
    _migrateProgressCb?.({ phase: 'machines' });
    let machines = [];
    try {
      if (typeof window.getAllMachines === 'function') {
        machines = await window.getAllMachines();
      }
    } catch (_) {}
    if (!machines.length && typeof window !== 'undefined' && typeof window.getPulseOrgMachines === 'function') {
      try {
        const raw = localStorage.getItem('pulse_organisation_bundle_v1');
        const org = raw ? JSON.parse(raw) : null;
        if (org) machines = window.getPulseOrgMachines(org) || [];
      } catch (_) {}
    }
    for (const m of machines) {
      if (!m?.id) continue;
      const row = {
        id: String(m.id),
        name: m.name || m.displayName || m.id,
        display_name: m.displayName || m.name || m.id,
        facility: m.facility === 'boyd' || m.facility === 'boyd-street' ? 'boyd' : '16th',
        category: m.category || 'cutting',
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      };
      try {
        const { error } = await supa.from('machines').upsert(row, { onConflict: 'id' });
        if (error) throw error;
        report.counts.machines = (report.counts.machines || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'machines', row.id, e);
      }
    }
  }

  async function _migrateProductWorkflowsTable(supa, report) {
    _migrateProgressCb?.({ phase: 'product_workflows' });
    let workflows = [];
    try {
      if (typeof window.getAllProductWorkflows === 'function') {
        workflows = await window.getAllProductWorkflows();
      }
    } catch (_) {}
    if (!workflows.length) {
      const cfg = await _readIndexedDBConfigMap();
      const legacy = cfg.productWorkflows || cfg.product_workflows;
      if (Array.isArray(legacy)) workflows = legacy;
    }
    for (const wf of workflows) {
      const catalogId = wf.productCatalogId || wf.product_catalog_id;
      if (!catalogId) continue;
      const row = {
        product_catalog_id: catalogId,
        product_name: wf.productName || wf.product_name || catalogId,
        primary_facility: (wf.primaryFacility || wf.primary_facility) === 'boyd' ? 'boyd' : '16th',
        steps: Array.isArray(wf.steps) ? wf.steps : [],
      };
      try {
        const { error } = await supa.from('product_workflows').upsert(row, { onConflict: 'product_catalog_id' });
        if (error) throw error;
        report.counts.productWorkflows = (report.counts.productWorkflows || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'product_workflows', wf.productName || catalogId, e);
      }
    }
  }

  async function _migrateOrganisationBundle(supa, report) {
    _migrateProgressCb?.({ phase: 'organisation' });
    let bundle = null;
    try {
      if (typeof window !== 'undefined' && window.PulseOrgJsonStore?.loadRaw) {
        bundle = window.PulseOrgJsonStore.loadRaw();
      }
    } catch (_) {}
    if (!bundle) {
      try {
        const raw = localStorage.getItem('pulse_organisation_bundle_v1');
        bundle = raw ? JSON.parse(raw) : null;
      } catch (_) {}
    }
    if (!bundle?.organisation) return;

    const norm = typeof window !== 'undefined' && window.PulseOrgJsonStore?.normalizeBundle
      ? window.PulseOrgJsonStore.normalizeBundle(bundle)
      : bundle;
    const orgMeta = norm.organisation || {};

    let orgId = orgMeta.id;
    try {
      const { data: existingOrg } = await supa.from('organisations').select('id').limit(1);
      if (existingOrg?.length) orgId = existingOrg[0].id;
      else {
        const { data: created, error: cErr } = await supa.from('organisations').insert({
          name: orgMeta.name || 'Bazaar Print',
          short_description: orgMeta.short_description || orgMeta.shortDescription || '',
          website_url: orgMeta.website_url || orgMeta.websiteUrl || null,
          logo_url: orgMeta.logo_url || orgMeta.logoUrl || null,
        }).select('id').single();
        if (cErr) throw cErr;
        orgId = created.id;
      }
      const { error: uErr } = await supa.from('organisations').update({
        name: orgMeta.name || 'Bazaar Print',
        short_description: orgMeta.short_description || orgMeta.shortDescription || '',
        website_url: orgMeta.website_url || orgMeta.websiteUrl || null,
        logo_url: orgMeta.logo_url || orgMeta.logoUrl || null,
      }).eq('id', orgId);
      if (uErr) throw uErr;
      report.counts.organisation = 1;
    } catch (e) {
      _migratePushError(report, 'organisation', 'organisations', e);
      return;
    }

    const slugToFacId = new Map();
    for (const fac of norm.facilities || []) {
      const slug = String(fac.slug || '').trim();
      if (!slug) continue;
      const payload = {
        organisation_id: orgId,
        slug,
        name: fac.name || slug,
        description: fac.description || '',
        sort_order: fac.sort_order ?? fac.sortOrder ?? 0,
      };
      try {
        const { data: found } = await supa.from('organisation_facilities')
          .select('id')
          .eq('organisation_id', orgId)
          .eq('slug', slug)
          .maybeSingle();
        if (found?.id) {
          const { error } = await supa.from('organisation_facilities').update(payload).eq('id', found.id);
          if (error) throw error;
          slugToFacId.set(slug, found.id);
        } else {
          const { data: ins, error } = await supa.from('organisation_facilities').insert(payload).select('id').single();
          if (error) throw error;
          slugToFacId.set(slug, ins.id);
        }
        report.counts.organisationFacilities = (report.counts.organisationFacilities || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'organisation', slug, e);
      }
    }

    for (const fac of norm.facilities || []) {
      const facId = slugToFacId.get(String(fac.slug || '').trim()) || fac.id;
      const list = norm.hardwareByFacilityId?.[fac.id] || norm.hardwareByFacilityId?.[facId] || [];
      for (const h of list) {
        const machineName = h.machine_name || h.machineName;
        if (!facId || !machineName) continue;
        try {
          const { data: exists } = await supa.from('organisation_hardware')
            .select('id')
            .eq('facility_id', facId)
            .eq('machine_name', machineName)
            .maybeSingle();
          const hw = {
            facility_id: facId,
            machine_name: machineName,
            operations: Array.isArray(h.operations) ? h.operations : [],
            daily_capacity_value: h.daily_capacity_value ?? h.dailyCapacity?.value ?? null,
            daily_capacity_unit: h.daily_capacity_unit || h.dailyCapacity?.unit || null,
            notes: h.notes || '',
            sort_order: h.sort_order ?? h.sortOrder ?? 0,
            active: h.active !== false,
          };
          if (exists?.id) {
            const { error } = await supa.from('organisation_hardware').update(hw).eq('id', exists.id);
            if (error) throw error;
          } else {
            const { error } = await supa.from('organisation_hardware').insert(hw);
            if (error) throw error;
          }
          report.counts.organisationHardware = (report.counts.organisationHardware || 0) + 1;
        } catch (e) {
          _migratePushError(report, 'organisation_hardware', machineName, e);
        }
      }
    }
  }

  async function _migrateDies(supa, report) {
    _migrateProgressCb?.({ phase: 'dies' });
    const dies = await _readIndexedDBStore('dies');
    for (const d of dies) {
      const dieNumber = String(d.dieNumber || d.die_number || d.n || '').trim();
      const barcode = String(d.barcode || d.barcodeValue || dieNumber || '').trim();
      if (!dieNumber || !barcode) continue;
      const row = {
        die_number: dieNumber,
        barcode,
        customer_name: d.customer || d.customerName || d.customer_name || 'Unknown',
        machine: d.machine || d.machineName || 'Unknown',
        description: d.description || d.name || null,
        condition: d.condition || 'active',
        usage_count: d.usageCount ?? d.usage_count ?? 0,
      };
      try {
        const { error } = await supa.from('dies').upsert(row, { onConflict: 'die_number' });
        if (error) throw error;
        report.counts.dies = (report.counts.dies || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'dies', dieNumber, e);
      }
    }
  }

  async function _migrateKnowledgeBase(supa, report) {
    _migrateProgressCb?.({ phase: 'knowledge_base' });
    const rows = await _readIndexedDBStore('knowledge_base');
    for (const k of rows) {
      const title = k.title || k.name;
      if (!title) continue;
      const row = {
        machine: k.machine || null,
        machines: Array.isArray(k.machines) ? k.machines : (k.machine ? [k.machine] : []),
        material: k.material || null,
        operation: k.operation || null,
        title,
        description: k.description || k.message || '',
        fix: k.fix || null,
        severity: k.severity || 'warning',
        operators: Array.isArray(k.operators) ? k.operators : [],
        active: k.active !== false,
      };
      try {
        const { error } = await supa.from('knowledge_base').insert(row);
        if (error) throw error;
        report.counts.knowledge_base = (report.counts.knowledge_base || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'knowledge_base', title, e);
      }
    }
  }

  async function _migrateOperatorSessions(supa, report) {
    _migrateProgressCb?.({ phase: 'operator_sessions' });
    const rows = await _readIndexedDBStore('operator_sessions');
    for (const s of rows) {
      if (!s.operatorName && !s.operator_name) continue;
      const row = {
        operator_name: s.operatorName || s.operator_name,
        session_date: s.date || s.session_date || new Date().toISOString().slice(0, 10),
        clock_in: s.clockIn || s.clock_in || s.startedAt || new Date().toISOString(),
        clock_out: s.clockOut || s.clock_out || s.endedAt || null,
        total_work_minutes: s.totalWorkMinutes ?? s.total_work_minutes ?? null,
        violation_flag: !!s.violationFlag || !!s.violation_flag,
        points_earned: s.pointsEarned ?? s.points_earned ?? 0,
        notes: s.notes || null,
      };
      try {
        const { error } = await supa.from('operator_sessions').insert(row);
        if (error) throw error;
        report.counts.operator_sessions = (report.counts.operator_sessions || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'operator_sessions', row.operator_name, e);
      }
    }
  }

  async function _migrateOperatorPoints(supa, report) {
    _migrateProgressCb?.({ phase: 'operator_points' });
    const rows = await _readIndexedDBStore('operator_points');
    for (const p of rows) {
      const row = {
        operator_name: p.operatorName || p.operator_name || 'Unknown',
        earned_date: p.date || p.earned_date || new Date().toISOString().slice(0, 10),
        points: p.points ?? 0,
        reason: p.reason || p.type || 'import',
      };
      try {
        const { error } = await supa.from('operator_points').insert(row);
        if (error) throw error;
        report.counts.operator_points = (report.counts.operator_points || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'operator_points', row.operator_name, e);
      }
    }
  }

  async function _migrateInvoices(supa, report, orderUuidByOrderId) {
    _migrateProgressCb?.({ phase: 'invoices' });
    const rows = await _readIndexedDBStore('invoices');
    for (const inv of rows) {
      const invNum = String(inv.invoiceNumber || inv.invoice_number || '').trim();
      if (!invNum) continue;
      const oid = inv.orderId || inv.order_id;
      const row = {
        invoice_number: invNum,
        order_id: oid ? (orderUuidByOrderId.get(String(oid)) || null) : null,
        customer_name: inv.customerName || inv.customer_name || inv.customer || 'Unknown',
        status: inv.status || 'draft',
        subtotal: inv.subtotal ?? 0,
        discount: inv.discount ?? 0,
        tax: inv.tax ?? 0,
        total: inv.total ?? 0,
        due_date: inv.dueDate || inv.due_date || null,
      };
      try {
        const { error } = await supa.from('invoices').upsert(row, { onConflict: 'invoice_number' });
        if (error) throw error;
        report.counts.invoices = (report.counts.invoices || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'invoices', invNum, e);
      }
    }
  }

  async function _migrateOrders(supa, report, onProgress) {
    const { data: existing } = await supa.from('orders').select('order_id, id');
    const existingIds = new Set((existing || []).map(r => r.order_id));
    const orderUuidByOrderId = new Map((existing || []).map(r => [String(r.order_id), r.id]));

    let idbOrders = [];
    try {
      idbOrders = _origGetAllOrders ? await _origGetAllOrders() : await _readIndexedDBStore('orders');
    } catch (e) {
      idbOrders = await _readIndexedDBStore('orders');
    }

    _migrateProgressCb?.({ phase: 'orders', total: idbOrders.length, done: 0 });
    report.counts.orders = { inserted: 0, skipped: 0 };

    for (let i = 0; i < idbOrders.length; i++) {
      const order = idbOrders[i];
      _migrateProgressCb?.({ phase: 'orders', total: idbOrders.length, done: i, current: order.orderId });

      if (existingIds.has(String(order.orderId))) {
        report.counts.orders.skipped++;
        continue;
      }

      try {
        const created = await _addOrder(order);
        const uuid = created?.id || created?._supaId;
        if (uuid) orderUuidByOrderId.set(String(order.orderId), uuid);
        report.counts.orders.inserted++;
        existingIds.add(String(order.orderId));
      } catch (e) {
        _migratePushError(report, 'orders', order.orderId, e);
      }
    }

    const { data: allOrders } = await supa.from('orders').select('order_id, id');
    (allOrders || []).forEach(r => orderUuidByOrderId.set(String(r.order_id), r.id));
    return orderUuidByOrderId;
  }

  async function _migrateActivityLog(supa, report, orderUuidByOrderId) {
    _migrateProgressCb?.({ phase: 'activity_log' });
    const rows = await _readIndexedDBStore('activity_log');
    for (const act of rows) {
      const oid = act.orderId || act.order_id;
      const orderUuid = oid ? orderUuidByOrderId.get(String(oid)) : null;
      const row = {
        order_id: orderUuid || null,
        action: act.action || act.type || 'note',
        details: act.details || act.meta || act.data || {},
        actor_name: act.user || act.actor || act.actorName || act.actor_name || null,
      };
      try {
        const { error } = await supa.from('activity_log').insert(row);
        if (error) throw error;
        report.counts.activity_log = (report.counts.activity_log || 0) + 1;
      } catch (e) {
        _migratePushError(report, 'activity_log', oid || '—', e);
      }
    }
  }

  /**
   * Migrate admin + production IndexedDB data to Supabase.
   * Called from migrate-to-supabase.html.
   */
  window.migratePulseDataToSupabase = async function (progressCb) {
    _migrateProgressCb = progressCb;
    const supa = await _getClient();
    const report = {
      counts: {},
      errors: [],
      // legacy fields for older UI
      inserted: 0,
      skipped: 0,
    };

    await _migrateAdminConfig(supa, report);
    await _migrateMachinesTable(supa, report);
    await _migrateProductWorkflowsTable(supa, report);
    await _migrateOrganisationBundle(supa, report);
    await _migrateDies(supa, report);
    await _migrateKnowledgeBase(supa, report);
    await _migrateOperatorSessions(supa, report);
    await _migrateOperatorPoints(supa, report);

    const orderUuidByOrderId = await _migrateOrders(supa, report, progressCb);
    await _migrateInvoices(supa, report, orderUuidByOrderId);
    await _migrateActivityLog(supa, report, orderUuidByOrderId);

    report.inserted = report.counts.orders?.inserted ?? 0;
    report.skipped = report.counts.orders?.skipped ?? 0;
    _migrateProgressCb?.({ phase: 'done' });
    return report;
  };

  window.migrateIndexedDBToSupabase = window.migratePulseDataToSupabase;

  function _readIndexedDBOrders() {
    return _readIndexedDBStore('orders');
  }

  function _readIndexedDBActivity(orderId) {
    return _readIndexedDBStore('activity_log').then(rows =>
      (rows || []).filter(a => String(a.orderId || a.order_id) === String(orderId))
    );
  }

  /** Sync client handle for pages that call getSupabaseClient() without awaiting (after init). */
  window.getSupabaseClient = function () {
    return _clientReady ? _client : null;
  };

  // ── Product workflows (admin) ────────────────────────────────

  function _mapMachineRow(row) {
    const facility = row.facility === 'boyd' || row.facility === 'boyd-street' ? 'boyd' : '16th';
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name || row.name,
      facility,
      category: row.category || null,
      capabilities: row.capabilities || [],
    };
  }

  function _mapProductWorkflowRow(row) {
    return {
      id: row.id,
      productCatalogId: row.product_catalog_id,
      productName: row.product_name,
      primaryFacility: row.primary_facility,
      steps: Array.isArray(row.steps) ? row.steps : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function _productWorkflowToRow(wf) {
    return {
      id: wf.id || undefined,
      product_catalog_id: wf.productCatalogId,
      product_name: wf.productName,
      primary_facility: wf.primaryFacility,
      steps: wf.steps || [],
    };
  }

  async function _getAllMachines() {
    const supa = await _getClient();
    const { data, error } = await supa.from('machines').select('*').order('facility').order('category').order('name');
    if (error) throw error;
    const rows = (data || []).map(_mapMachineRow);
    // Workflow steps use slug ids (migration 022). Legacy UUID rows are mapped by display name when possible.
    if (typeof MACHINE_SLUG_TO_DISPLAY === 'undefined') return rows;
    const slugByDisplay = Object.fromEntries(Object.entries(MACHINE_SLUG_TO_DISPLAY));
    const out = new Map();
    for (const m of rows) {
      if (slugByDisplay[m.id]) {
        out.set(m.id, { ...m, id: m.id, displayName: m.displayName || slugByDisplay[m.id] });
        continue;
      }
      const slug = typeof displayNameToMachineSlug === 'function'
        ? displayNameToMachineSlug(m.displayName || m.name)
        : null;
      if (slug && slugByDisplay[slug]) {
        out.set(slug, {
          id: slug,
          name: m.name || slugByDisplay[slug],
          displayName: slugByDisplay[slug],
          facility: m.facility === 'boyd' ? 'boyd' : '16th',
          category: m.category || (typeof MACHINE_SLUG_CATEGORY !== 'undefined' ? MACHINE_SLUG_CATEGORY[slug] : undefined),
          capabilities: m.capabilities || [],
        });
      }
    }
    for (const [id, displayName] of Object.entries(MACHINE_SLUG_TO_DISPLAY)) {
      if (!out.has(id)) {
        out.set(id, {
          id,
          name: displayName,
          displayName,
          facility: ['canon-colorado', 'roland', 'graphtec-vinyl', 'graphtec-flatbed', 'boyd-laminator'].includes(id) ? 'boyd' : '16th',
          category: typeof MACHINE_SLUG_CATEGORY !== 'undefined' ? MACHINE_SLUG_CATEGORY[id] : 'cutting',
          capabilities: [],
        });
      }
    }
    return Array.from(out.values());
  }

  async function _getAllProductWorkflows() {
    const supa = await _getClient();
    const { data, error } = await supa.from('product_workflows').select('*').order('product_name');
    if (error) throw error;
    return (data || []).map(_mapProductWorkflowRow);
  }

  async function _getProductWorkflowByCatalogId(catalogId) {
    const supa = await _getClient();
    const { data, error } = await supa
      .from('product_workflows')
      .select('*')
      .eq('product_catalog_id', catalogId)
      .maybeSingle();
    if (error) throw error;
    return data ? _mapProductWorkflowRow(data) : null;
  }

  // Fallback: look up by product name when the catalog ID has drifted
  // (happens when the catalog was reset and new random IDs were generated).
  // Returns a list (not .maybeSingle) so duplicate product_name rows don't throw
  // and silently turn into a bogus "no workflow configured" message — we just
  // pick the most complete matching row instead.
  async function _getProductWorkflowByName(productName) {
    if (!productName) return null;
    const supa = await _getClient();
    const { data, error } = await supa
      .from('product_workflows')
      .select('*')
      .ilike('product_name', productName);
    if (error) throw error;
    if (!Array.isArray(data) || !data.length) return null;
    // Prefer a row that actually has workflow steps configured.
    const withSteps = data.find(r => Array.isArray(r.steps) && r.steps.length);
    return _mapProductWorkflowRow(withSteps || data[0]);
  }

  async function _upsertProductWorkflow(wf) {
    const supa = await _getClient();
    const row = _productWorkflowToRow(wf);
    const { data, error } = await supa
      .from('product_workflows')
      .upsert(row, { onConflict: 'product_catalog_id' })
      .select()
      .single();
    if (error) throw error;
    return _mapProductWorkflowRow(data);
  }

  async function _deleteProductWorkflow(id) {
    const supa = await _getClient();
    const { error } = await supa.from('product_workflows').delete().eq('id', id);
    if (error) throw error;
  }

  async function _seedProductWorkflowsFromDefaults(catProducts) {
    if (!Array.isArray(catProducts) || !catProducts.length) return { seeded: 0 };
    const existing = await _getAllProductWorkflows();
    const byCatalog = new Map(existing.map(w => [w.productCatalogId, w]));
    let seeded = 0;
    const getDefault = typeof getDefaultProductWorkflowForCatalogName === 'function'
      ? getDefaultProductWorkflowForCatalogName
      : () => ({ primaryFacility: '16th', steps: [] });

    for (const prod of catProducts) {
      if (!prod?.id || byCatalog.has(prod.id)) continue;
      const def = getDefault(prod.name);
      await _upsertProductWorkflow({
        productCatalogId: prod.id,
        productName: prod.name,
        primaryFacility: def.primaryFacility || '16th',
        steps: def.steps || [],
      });
      seeded++;
    }
    return { seeded };
  }

  /** Overwrite every catalogue product workflow with built-in defaults (by product name). */
  async function _resetAllProductWorkflowsFromDefaults(catProducts) {
    if (!Array.isArray(catProducts) || !catProducts.length) return { updated: 0 };
    const supa = await _getClient();
    const { error: delErr } = await supa.from('product_workflows').delete().not('id', 'is', null);
    if (delErr) throw delErr;
    const getDefault = typeof getDefaultProductWorkflowForCatalogName === 'function'
      ? getDefaultProductWorkflowForCatalogName
      : () => ({ primaryFacility: '16th', steps: [] });
    let updated = 0;
    for (const prod of catProducts) {
      if (!prod?.id || !prod.name) continue;
      const def = getDefault(prod.name);
      await _upsertProductWorkflow({
        productCatalogId: prod.id,
        productName: prod.name,
        primaryFacility: def.primaryFacility || '16th',
        steps: def.steps || [],
      });
      updated++;
    }
    return { updated };
  }

  if (!MIGRATE_TOOL) {
  window.getAllMachines = async function () {
    try { return await _getAllMachines(); }
    catch (e) { console.error('[Pulse/Supabase] getAllMachines:', e); return []; }
  };

  window.getAllProductWorkflows = async function (opts = {}) {
    try { return await _getAllProductWorkflows(); }
    catch (e) {
      console.error('[Pulse/Supabase] getAllProductWorkflows:', e);
      if (opts.strict) throw e;
      return [];
    }
  };

  window.getProductWorkflowByCatalogId = async function (catalogId) {
    try { return await _getProductWorkflowByCatalogId(catalogId); }
    catch (e) { console.error('[Pulse/Supabase] getProductWorkflowByCatalogId:', e); return null; }
  };

  window.getProductWorkflowByName = async function (productName) {
    try { return await _getProductWorkflowByName(productName); }
    catch (e) { console.error('[Pulse/Supabase] getProductWorkflowByName:', e); return null; }
  };

  window.upsertProductWorkflow = async function (wf) {
    try { return await _upsertProductWorkflow(wf); }
    catch (e) {
      console.error('[Pulse/Supabase] upsertProductWorkflow:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  // ── Personnel provisioning via DB function ────────────────────────────────
  // Creates/updates the Supabase auth account AND profiles row in one call.
  // The User ID becomes the login password, keeping Admin → Personnel as the
  // single source of truth. Requires admin or supervisor session.
  window.upsertPulsePersonnel = async function (person) {
    const supa = await _getClient();
    const profileId = person.id || person._profileId;
    const rpcArgs = {
      p_display_name: String(person.name || '').trim(),
      p_role:         String(person.role || 'operator'),
      p_user_id:      String(person.userId ?? '').trim(),
      p_facility:     person.facility || null,
      p_active:       person.active !== false,
    };
    if (_isProfileUuid(profileId)) rpcArgs.p_profile_id = profileId;
    const { data, error } = await supa.rpc('upsert_pulse_personnel', rpcArgs);
    if (error) throw new Error(await _formatPulseDbError(error));
    return data;
  };

  async function _logWorkflowOverride(entry) {
    const supa = await _getClient();
    const row = {
      order_id: entry.orderDbId,
      step_index: entry.stepIndex,
      original_machine_id: entry.originalMachineId || null,
      new_machine_id: entry.newMachineId || null,
      original_machine: entry.originalMachine || null,
      new_machine: entry.newMachine,
      changed_by: entry.changedBy || null,
      reason: entry.reason || null,
    };
    const { error } = await supa.from('workflow_override_log').insert(row);
    if (error) throw error;
  }

  window.logWorkflowOverride = async function (entry) {
    try { return await _logWorkflowOverride(entry); }
    catch (e) {
      console.warn('[Pulse/Supabase] logWorkflowOverride:', e);
    }
  };

  window.deleteProductWorkflow = async function (id) {
    try { return await _deleteProductWorkflow(id); }
    catch (e) {
      console.error('[Pulse/Supabase] deleteProductWorkflow:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.seedProductWorkflowsFromDefaults = async function (catProducts) {
    try { return await _seedProductWorkflowsFromDefaults(catProducts); }
    catch (e) {
      console.error('[Pulse/Supabase] seedProductWorkflowsFromDefaults:', e);
      return { seeded: 0, error: e.message };
    }
  };

  window.resetAllProductWorkflowsFromDefaults = async function (catProducts) {
    try { return await _resetAllProductWorkflowsFromDefaults(catProducts); }
    catch (e) {
      console.error('[Pulse/Supabase] resetAllProductWorkflowsFromDefaults:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  // ── Organisation bundle (facilities + hardware from SQL) ─────

  async function _fetchOrganisationBundleFromSupabase() {
    const supa = await _getClient();
    const { data: orgs, error: oe } = await supa.from('organisations').select('*').limit(1);
    if (oe) throw oe;
    const org = orgs?.[0];
    if (!org) return null;

    const { data: facs, error: fe } = await supa
      .from('organisation_facilities')
      .select('*')
      .eq('organisation_id', org.id)
      .order('sort_order', { ascending: true });
    if (fe) throw fe;

    const hardwareByFacilityId = {};
    for (const f of facs || []) {
      const { data: hw, error: he } = await supa
        .from('organisation_hardware')
        .select('*')
        .eq('facility_id', f.id)
        .order('sort_order', { ascending: true });
      if (he) throw he;
      hardwareByFacilityId[f.id] = hw || [];
    }

    return {
      organisation: {
        id: org.id,
        name: org.name,
        short_description: org.short_description || '',
        website_url: org.website_url || '',
        logo_url: org.logo_url || '',
        saved: true,
      },
      facilities: facs || [],
      hardwareByFacilityId,
      people: [],
    };
  }

  window.fetchOrganisationBundleFromSupabase = async function () {
    try { return await _fetchOrganisationBundleFromSupabase(); }
    catch (e) {
      console.error('[Pulse/Supabase] fetchOrganisationBundleFromSupabase:', e);
      return null;
    }
  };

  // ── Machine issues (Report Issue page) ───────────────────────

  function _machineIssueToLocal(row) {
    const specs = row.specs && typeof row.specs === 'object' ? row.specs : {};
    return {
      id: row.id,
      machine: row.machine_name,
      symptom: row.description,
      severity: specs.severity || 'minor',
      problemSource: specs.problemSource || 'legacy',
      problemCategory: specs.problemCategory || null,
      reporter: row.reported_by_name || specs.reporter || null,
      downStart: specs.downStart || null,
      downEnd: specs.downEnd || null,
      resolution: specs.resolution || null,
      fixSource: specs.fixSource || null,
      fixSourceOther: specs.fixSourceOther || null,
      technician: specs.technician || null,
      resolvedAt: row.resolved_at || null,
      resolvedBy: specs.resolvedBy || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  function _machineIssueToRow(issue, profileId) {
    const specs = {
      severity: issue.severity || 'minor',
      problemSource: issue.problemSource || null,
      problemCategory: issue.problemCategory || null,
      downStart: issue.downStart || null,
      downEnd: issue.downEnd || null,
      resolution: issue.resolution || null,
      fixSource: issue.fixSource || null,
      fixSourceOther: issue.fixSourceOther || null,
      technician: issue.technician || null,
      resolvedBy: issue.resolvedBy || null,
    };
    if (String(issue.id || '').startsWith('ISS-')) specs.legacyId = issue.id;
    const row = {
      machine_name: issue.machine,
      description: issue.symptom,
      reported_by_name: issue.reporter || null,
      resolved_at: issue.resolvedAt || null,
      specs,
    };
    if (issue.id && !String(issue.id).startsWith('ISS-')) row.id = issue.id;
    if (profileId) row.reported_by = profileId;
    return row;
  }

  async function _getAllMachineIssues() {
    const supa = await _getClient();
    const { data, error } = await supa
      .from('machine_issues')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(_machineIssueToLocal);
  }

  async function _insertMachineIssue(issue) {
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    const row = _machineIssueToRow(issue, profile?.id || null);
    const { data, error } = await supa.from('machine_issues').insert(row).select('*').single();
    if (error) throw error;
    return _machineIssueToLocal(data);
  }

  async function _updateMachineIssue(issue) {
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    const row = _machineIssueToRow(issue, profile?.id || null);
    const id = row.id;
    delete row.id;
    delete row.reported_by;
    const { data, error } = await supa.from('machine_issues').update(row).eq('id', id).select('*').single();
    if (error) throw error;
    return _machineIssueToLocal(data);
  }

  async function _migrateLocalMachineIssuesOnce() {
    const flag = 'pulse_machine_issues_migrated_v1';
    try {
      if (localStorage.getItem(flag)) return;
      const raw = localStorage.getItem('pulse_machine_issues');
      if (!raw) { localStorage.setItem(flag, '1'); return; }
      let localIssues;
      try { localIssues = JSON.parse(raw); } catch (_) { localIssues = []; }
      if (!Array.isArray(localIssues) || !localIssues.length) {
        localStorage.setItem(flag, '1');
        return;
      }
      const existing = await _getAllMachineIssues();
      if (existing.length) {
        localStorage.setItem(flag, '1');
        return;
      }
      for (const issue of localIssues) {
        try { await _insertMachineIssue(issue); } catch (e) {
          console.warn('[Pulse/Supabase] migrate machine issue:', issue.id, e);
        }
      }
      localStorage.setItem(flag, '1');
    } catch (e) {
      console.warn('[Pulse/Supabase] migrateLocalMachineIssuesOnce:', e);
    }
  }

  window.getAllMachineIssues = async function () {
    try {
      await _migrateLocalMachineIssuesOnce();
      return await _getAllMachineIssues();
    } catch (e) {
      console.error('[Pulse/Supabase] getAllMachineIssues:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.insertMachineIssue = async function (issue) {
    try { return await _insertMachineIssue(issue); }
    catch (e) {
      console.error('[Pulse/Supabase] insertMachineIssue:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.updateMachineIssue = async function (issue) {
    try { return await _updateMachineIssue(issue); }
    catch (e) {
      console.error('[Pulse/Supabase] updateMachineIssue:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  // ── Dies (Die Registry) ─────────────────────────────────────

  const DIE_META = '\n---PULSE_DIE_META---\n';

  function _unpackDieDescription(description) {
    const raw = String(description || '');
    const idx = raw.indexOf(DIE_META);
    if (idx < 0) return { description: raw.trim() || null, meta: {} };
    const base = raw.slice(0, idx).trim();
    const tail = raw.slice(idx + DIE_META.length).trim();
    const jsonStart = tail.indexOf('{');
    if (jsonStart < 0) return { description: base || null, meta: {} };
    try {
      return { description: base || null, meta: JSON.parse(tail.slice(jsonStart)) || {} };
    } catch (_) {
      return { description: base || null, meta: {} };
    }
  }

  function _packDieDescription(desc, meta) {
    const base = String(desc || '').split(DIE_META)[0].trim();
    const extras = {};
    for (const k of ['die_type', 'template_pdf', 'notes', 'photos_url', 'cut_sizes']) {
      if (meta[k] != null && meta[k] !== '') extras[k] = meta[k];
    }
    if (!Object.keys(extras).length) return base || null;
    return (base ? base + '\n' : '') + DIE_META + JSON.stringify(extras);
  }

  function _dieToLocal(row) {
    const { description, meta } = _unpackDieDescription(row.description);
    const condition = row.condition || 'active';
    return {
      id: row.id,
      dieNumber: row.die_number,
      barcode: row.barcode,
      customer: row.customer_name,
      machine: row.machine,
      description: description || '',
      status: condition,
      condition,
      usageCount: row.usage_count ?? 0,
      lastUsed: row.last_used_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
      die_type: meta.die_type || null,
      template_pdf: meta.template_pdf || null,
      notes: meta.notes || null,
      photos_url: meta.photos_url || null,
      cut_sizes: meta.cut_sizes || null,
    };
  }

  function _dieToRow(die) {
    const dieNumber = String(die.dieNumber || die.die_number || '').trim();
    const conditionRaw = String(die.condition || die.status || 'active').toLowerCase();
    const condition = conditionRaw === 'damaged' ? 'damaged' : (conditionRaw === 'retired' ? 'retired' : 'active');
    const row = {
      die_number: dieNumber,
      barcode: String(die.barcode || `DIE-${dieNumber}`).trim(),
      customer_name: die.customer || die.customerName || die.customer_name || 'Unknown',
      machine: die.machine || die.machineName || 'Unknown',
      description: _packDieDescription(die.description || die.name || '', {
        die_type: die.die_type,
        template_pdf: die.template_pdf,
        notes: die.notes,
        photos_url: die.photos_url,
        cut_sizes: die.cut_sizes,
      }),
      condition,
      usage_count: die.usageCount ?? die.usage_count ?? 0,
      last_used_at: die.lastUsed || die.last_used_at || null,
    };
    if (die.id && !/^\d+$/.test(String(die.id))) row.id = die.id;
    return row;
  }

  async function _getAllDies() {
    const supa = await _getClient();
    const { data, error } = await supa.from('dies').select('*').order('die_number', { ascending: true });
    if (error) throw error;
    return (data || []).map(_dieToLocal);
  }

  async function _getDieByNumber(dieNumber) {
    const supa = await _getClient();
    const num = String(dieNumber ?? '').trim();
    if (!num) return null;
    const { data, error } = await supa.from('dies').select('*').eq('die_number', num).maybeSingle();
    if (error) throw error;
    return data ? _dieToLocal(data) : null;
  }

  async function _getDieByBarcode(barcode) {
    const supa = await _getClient();
    const code = String(barcode ?? '').trim();
    if (!code) return null;
    const { data, error } = await supa.from('dies').select('*').eq('barcode', code).maybeSingle();
    if (error) throw error;
    return data ? _dieToLocal(data) : null;
  }

  async function _addDie(die) {
    const supa = await _getClient();
    const row = _dieToRow({
      ...die,
      usageCount: die.usageCount ?? 0,
      lastUsed: die.lastUsed || null,
    });
    delete row.id;
    const { data, error } = await supa.from('dies').insert(row).select('*').single();
    if (error) throw error;
    return _dieToLocal(data);
  }

  async function _updateDie(id, changes) {
    const supa = await _getClient();
    let existing = null;
    const idStr = String(id ?? '');
    if (/^\d+$/.test(idStr)) {
      const all = await _getAllDies();
      existing = all[parseInt(idStr, 10) - 1] || null;
    } else {
      const { data, error } = await supa.from('dies').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      existing = data ? _dieToLocal(data) : null;
    }
    if (!existing) throw new Error('Not found');

    const merged = { ...existing, ...changes };
    const row = _dieToRow(merged);
    row.id = existing.id;
    const { data, error: upErr } = await supa.from('dies').update(row).eq('id', existing.id).select('*').single();
    if (upErr) throw upErr;
    return _dieToLocal(data);
  }

  async function _recordDieUsage(dieId) {
    const supa = await _getClient();
    let die = null;
    const idStr = String(dieId ?? '');
    if (/^\d+$/.test(idStr)) {
      const all = await _getAllDies();
      die = all[parseInt(idStr, 10) - 1] || null;
    } else {
      const { data, error } = await supa.from('dies').select('*').eq('id', dieId).maybeSingle();
      if (error) throw error;
      die = data ? _dieToLocal(data) : null;
    }
    if (!die) throw new Error('Not found');
    const usageCount = (die.usageCount || 0) + 1;
    const lastUsed = new Date().toISOString();
    const { data, error: upErr } = await supa
      .from('dies')
      .update({ usage_count: usageCount, last_used_at: lastUsed })
      .eq('id', die.id)
      .select('*')
      .single();
    if (upErr) throw upErr;
    return _dieToLocal(data);
  }

  window.getAllDies = async function () {
    try { return await _getAllDies(); }
    catch (e) { console.error('[Pulse/Supabase] getAllDies:', e); return []; }
  };

  window.getDieByNumber = async function (dieNumber) {
    try { return await _getDieByNumber(dieNumber); }
    catch (e) { console.error('[Pulse/Supabase] getDieByNumber:', e); return null; }
  };

  window.getDieByBarcode = async function (barcode) {
    try { return await _getDieByBarcode(barcode); }
    catch (e) { console.error('[Pulse/Supabase] getDieByBarcode:', e); return null; }
  };

  window.addDie = async function (die) {
    try { return await _addDie(die); }
    catch (e) {
      console.error('[Pulse/Supabase] addDie:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.updateDie = async function (id, changes) {
    try { return await _updateDie(id, changes); }
    catch (e) {
      console.error('[Pulse/Supabase] updateDie:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.recordDieUsage = async function (dieId) {
    try { return await _recordDieUsage(dieId); }
    catch (e) {
      console.error('[Pulse/Supabase] recordDieUsage:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  // ── Knowledge Base ──────────────────────────────────────────

  function _knowledgeToLocal(row) {
    return {
      id: row.id,
      machine: row.machine || null,
      machines: row.machines || [],
      material: row.material || null,
      operation: row.operation || null,
      title: row.title,
      description: row.description || '',
      fix: row.fix || null,
      severity: row.severity || 'warning',
      operators: row.operators || [],
      active: row.active !== false,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
      createdBy: row.created_by || null,
    };
  }

  function _knowledgeToRow(entry) {
    const sev = String(entry.severity || 'warning').toLowerCase();
    const row = {
      machine: entry.machine || null,
      machines: Array.isArray(entry.machines) ? entry.machines : (entry.machine ? [entry.machine] : []),
      material: entry.material || null,
      operation: entry.operation || null,
      title: entry.title || entry.name,
      description: entry.description || entry.message || '',
      fix: entry.fix || null,
      severity: sev === 'critical' ? 'critical' : 'warning',
      operators: Array.isArray(entry.operators) ? entry.operators : [],
      active: entry.active !== false,
    };
    if (entry.id && !/^\d+$/.test(String(entry.id))) row.id = entry.id;
    return row;
  }

  async function _getAllKnowledge() {
    const supa = await _getClient();
    const { data, error } = await supa.from('knowledge_base').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(_knowledgeToLocal);
  }

  async function _addKnowledgeEntry(entry) {
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    const row = _knowledgeToRow({ ...entry, active: entry.active !== false });
    delete row.id;
    if (profile?.id) row.created_by = profile.id;
    const { data, error } = await supa.from('knowledge_base').insert(row).select('*').single();
    if (error) throw error;
    return _knowledgeToLocal(data);
  }

  async function _updateKnowledge(id, changes) {
    const supa = await _getClient();
    let existing = null;
    const idStr = String(id ?? '');
    if (/^\d+$/.test(idStr)) {
      const all = await _getAllKnowledge();
      existing = all[parseInt(idStr, 10) - 1] || null;
    } else {
      const { data, error } = await supa.from('knowledge_base').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      existing = data ? _knowledgeToLocal(data) : null;
    }
    if (!existing) throw new Error('Not found');

    const row = _knowledgeToRow({ ...existing, ...changes });
    row.id = existing.id;
    const { data, error: upErr } = await supa.from('knowledge_base').update(row).eq('id', existing.id).select('*').single();
    if (upErr) throw upErr;
    return _knowledgeToLocal(data);
  }

  window.getAllKnowledge = async function () {
    try { return await _getAllKnowledge(); }
    catch (e) { console.error('[Pulse/Supabase] getAllKnowledge:', e); return []; }
  };

  window.addKnowledgeEntry = async function (entry) {
    try { return await _addKnowledgeEntry(entry); }
    catch (e) {
      console.error('[Pulse/Supabase] addKnowledgeEntry:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  window.updateKnowledge = async function (id, changes) {
    try { return await _updateKnowledge(id, changes); }
    catch (e) {
      console.error('[Pulse/Supabase] updateKnowledge:', e);
      throw new Error(await _formatPulseDbError(e));
    }
  };

  // ── Config JSON helpers (reprints, devices, notification memory, PO extras) ─

  async function _configJson(key, fallback) {
    const rec = await _supaGetConfig(key);
    const v = rec?.value;
    return v !== undefined && v !== null ? v : fallback;
  }

  async function _setConfigJson(key, value) {
    await _supaSetConfig(key, value);
  }

  // ── Operator sessions + breaks ───────────────────────────────

  const SESSION_META = '\n---PULSE_SESSION_META---\n';

  function _defaultBreaks() {
    return {
      rest1: { start: null, end: null },
      meal1: { start: null, end: null },
      rest2: { start: null, end: null },
      meal2: { start: null, end: null },
    };
  }

  function _unpackSessionNotes(notes) {
    const raw = String(notes || '');
    const idx = raw.indexOf(SESSION_META);
    if (idx < 0) return { notes: raw.trim() || '', meta: {} };
    const base = raw.slice(0, idx).trim();
    const tail = raw.slice(idx + SESSION_META.length).trim();
    const jsonStart = tail.indexOf('{');
    if (jsonStart < 0) return { notes: base, meta: {} };
    try {
      return { notes: base, meta: JSON.parse(tail.slice(jsonStart)) || {} };
    } catch (_) {
      return { notes: base, meta: {} };
    }
  }

  function _packSessionNotes(notes, meta) {
    const base = String(notes || '').split(SESSION_META)[0].trim();
    const extras = {};
    for (const k of ['registeredOperatorId', 'registeredOperatorIdAt']) {
      if (meta[k] != null && meta[k] !== '') extras[k] = meta[k];
    }
    if (!Object.keys(extras).length) return base || null;
    return (base ? base + '\n' : '') + SESSION_META + JSON.stringify(extras);
  }

  async function _loadBreaksForSession(sessionId) {
    const supa = await _getClient();
    const { data, error } = await supa.from('operator_breaks').select('*').eq('session_id', sessionId);
    if (error) throw error;
    const breaks = _defaultBreaks();
    for (const b of data || []) {
      const t = b.break_type;
      if (breaks[t]) breaks[t] = { start: b.started_at || null, end: b.ended_at || null };
    }
    return breaks;
  }

  async function _sessionRowToLocal(row) {
    const { notes, meta } = _unpackSessionNotes(row.notes);
    const breaks = await _loadBreaksForSession(row.id);
    return {
      id: row.id,
      operatorName: row.operator_name,
      date: row.session_date,
      clockIn: row.clock_in,
      clockOut: row.clock_out || null,
      breaks,
      violationFlag: !!row.violation_flag,
      totalWorkMinutes: row.total_work_minutes ?? 0,
      notes: notes || '',
      points: row.points_earned ?? 0,
      registeredOperatorId: meta.registeredOperatorId || null,
      registeredOperatorIdAt: meta.registeredOperatorIdAt || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  async function _upsertBreak(sessionId, breakType, patch) {
    const supa = await _getClient();
    const { data: existing } = await supa.from('operator_breaks')
      .select('id').eq('session_id', sessionId).eq('break_type', breakType).maybeSingle();
    const row = {
      session_id: sessionId,
      break_type: breakType,
      started_at: patch.start ?? null,
      ended_at: patch.end ?? null,
    };
    if (existing?.id) {
      const { error } = await supa.from('operator_breaks').update(row).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supa.from('operator_breaks').insert(row);
      if (error) throw error;
    }
  }

  async function _clockIn(operatorName) {
    const supa = await _getClient();
    const user = await _getCurrentUser();
    const now = new Date();
    const { data, error } = await supa.from('operator_sessions').insert({
      operator_id: user?.id || null,
      operator_name: operatorName,
      session_date: now.toISOString().split('T')[0],
      clock_in: now.toISOString(),
      clock_out: null,
      total_work_minutes: 0,
      violation_flag: false,
      points_earned: 0,
      notes: null,
    }).select('*').single();
    if (error) throw error;
    return data.id;
  }

  async function _clockOut(sessionId) {
    const session = await _getOperatorSessionById(sessionId);
    if (!session) return null;
    const now = new Date();
    const workMin = (now - new Date(session.clockIn)) / 60000;
    const meal1Taken = session.breaks?.meal1?.start;
    const meal2Taken = session.breaks?.meal2?.start;
    const violation = (!meal1Taken && workMin > 300) || (!meal2Taken && workMin > 600);
    const supa = await _getClient();
    const { data, error } = await supa.from('operator_sessions').update({
      clock_out: now.toISOString(),
      total_work_minutes: Math.round(workMin),
      violation_flag: violation || session.violationFlag,
    }).eq('id', sessionId).select('*').single();
    if (error) throw error;
    return _sessionRowToLocal(data);
  }

  async function _startBreak(sessionId, breakType) {
    const session = await _getOperatorSessionById(sessionId);
    if (!session) return null;
    await _upsertBreak(sessionId, breakType, {
      start: new Date().toISOString(),
      end: session.breaks?.[breakType]?.end || null,
    });
    return _getOperatorSessionById(sessionId);
  }

  async function _endBreak(sessionId, breakType) {
    const session = await _getOperatorSessionById(sessionId);
    if (!session) return null;
    await _upsertBreak(sessionId, breakType, {
      start: session.breaks?.[breakType]?.start || null,
      end: new Date().toISOString(),
    });
    return _getOperatorSessionById(sessionId);
  }

  async function _getTodaySessions() {
    const supa = await _getClient();
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supa.from('operator_sessions')
      .select('*').eq('session_date', today).order('clock_in', { ascending: false });
    if (error) throw error;
    return Promise.all((data || []).map(_sessionRowToLocal));
  }

  async function _getOperatorSession(operatorName) {
    const all = await _getTodaySessions();
    return all.find(s => s.operatorName === operatorName && !s.clockOut) || null;
  }

  async function _getOperatorSessionById(sessionId) {
    if (!sessionId) return null;
    const supa = await _getClient();
    const { data, error } = await supa.from('operator_sessions').select('*').eq('id', sessionId).maybeSingle();
    if (error) throw error;
    return data ? _sessionRowToLocal(data) : null;
  }

  async function _updateOperatorSession(sessionId, changes) {
    const existing = await _getOperatorSessionById(sessionId);
    if (!existing) throw new Error('Not found');
    const merged = { ...existing, ...changes };
    const supa = await _getClient();
    const row = {
      operator_name: merged.operatorName,
      session_date: merged.date,
      clock_in: merged.clockIn,
      clock_out: merged.clockOut || null,
      total_work_minutes: merged.totalWorkMinutes ?? 0,
      violation_flag: !!merged.violationFlag,
      points_earned: merged.points ?? 0,
      notes: _packSessionNotes(merged.notes, {
        registeredOperatorId: merged.registeredOperatorId,
        registeredOperatorIdAt: merged.registeredOperatorIdAt,
      }),
    };
    const { data, error } = await supa.from('operator_sessions').update(row).eq('id', sessionId).select('*').single();
    if (error) throw error;
    return _sessionRowToLocal(data);
  }

  window.clockIn = async function (operatorName) {
    try { return await _clockIn(operatorName); }
    catch (e) { console.error('[Pulse/Supabase] clockIn:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.clockOut = async function (sessionId) {
    try { return await _clockOut(sessionId); }
    catch (e) { console.error('[Pulse/Supabase] clockOut:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.startBreak = async function (sessionId, breakType) {
    try { return await _startBreak(sessionId, breakType); }
    catch (e) { console.error('[Pulse/Supabase] startBreak:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.endBreak = async function (sessionId, breakType) {
    try { return await _endBreak(sessionId, breakType); }
    catch (e) { console.error('[Pulse/Supabase] endBreak:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.getTodaySessions = async function () {
    try { return await _getTodaySessions(); }
    catch (e) { console.error('[Pulse/Supabase] getTodaySessions:', e); return []; }
  };
  window.getOperatorSession = async function (operatorName) {
    try { return await _getOperatorSession(operatorName); }
    catch (e) { console.error('[Pulse/Supabase] getOperatorSession:', e); return null; }
  };
  window.getOperatorSessionById = async function (sessionId) {
    try { return await _getOperatorSessionById(sessionId); }
    catch (e) { console.error('[Pulse/Supabase] getOperatorSessionById:', e); return null; }
  };
  window.updateOperatorSession = async function (sessionId, changes) {
    try { return await _updateOperatorSession(sessionId, changes); }
    catch (e) { console.error('[Pulse/Supabase] updateOperatorSession:', e); throw new Error(await _formatPulseDbError(e)); }
  };

  // ── Operator points ─────────────────────────────────────────

  async function _addOperatorPoints(operatorName, points, reason) {
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    const row = {
      operator_name: operatorName,
      earned_date: new Date().toISOString().split('T')[0],
      points: points ?? 0,
      reason: reason || 'earned',
    };
    if (profile?.id) row.operator_id = profile.id;
    const { data, error } = await supa.from('operator_points').insert(row).select('*').single();
    if (error) throw error;
    return {
      id: data.id,
      operatorName: data.operator_name,
      date: data.earned_date,
      points: data.points,
      reason: data.reason,
      timestamp: data.created_at,
    };
  }

  async function _getAllOperatorPoints() {
    const supa = await _getClient();
    const { data, error } = await supa.from('operator_points').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.id,
      operatorName: r.operator_name,
      date: r.earned_date,
      points: r.points,
      reason: r.reason,
      timestamp: r.created_at,
    }));
  }

  async function _getOperatorMonthlyPoints(operatorName) {
    const all = await _getAllOperatorPoints();
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    return all
      .filter(p => p.operatorName === operatorName && p.date >= monthStart)
      .reduce((sum, p) => sum + (p.points || 0), 0);
  }

  window.addOperatorPoints = async function (operatorName, points, reason) {
    try { return await _addOperatorPoints(operatorName, points, reason); }
    catch (e) { console.error('[Pulse/Supabase] addOperatorPoints:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.getAllOperatorPoints = async function () {
    try { return await _getAllOperatorPoints(); }
    catch (e) { console.error('[Pulse/Supabase] getAllOperatorPoints:', e); return []; }
  };
  window.getOperatorMonthlyPoints = async function (operatorName) {
    try { return await _getOperatorMonthlyPoints(operatorName); }
    catch (e) { console.error('[Pulse/Supabase] getOperatorMonthlyPoints:', e); return 0; }
  };

  // ── Purchase orders ─────────────────────────────────────────

  const PO_EXTRAS_KEY = 'pulse_po_extras';

  async function _getPoExtrasMap() {
    return (await _configJson(PO_EXTRAS_KEY, {})) || {};
  }

  async function _setPoExtras(poId, extras) {
    const map = await _getPoExtrasMap();
    map[poId] = { ...(map[poId] || {}), ...extras };
    await _setConfigJson(PO_EXTRAS_KEY, map);
  }

  async function _loadPoItems(poId) {
    const supa = await _getClient();
    const { data, error } = await supa.from('purchase_order_items').select('*').eq('po_id', poId);
    if (error) throw error;
    return data || [];
  }

  function _poToLocal(row, items, extras) {
    return {
      id: row.id,
      poNumber: row.po_number,
      vendor: row.vendor,
      vendorEmail: extras?.vendorEmail || '',
      status: row.status,
      expectedDelivery: row.expected_date || null,
      actualDelivery: row.actual_date || null,
      receivedBy: row.received_by || null,
      receivedAt: row.received_at || null,
      createdAt: row.created_at,
      items: (items || []).map(i => ({
        material: i.material_name,
        quantity: Number(i.quantity),
        unit: i.unit,
        unitCost: i.unit_cost != null ? Number(i.unit_cost) : null,
      })),
    };
  }

  async function _getAllPurchaseOrders() {
    const supa = await _getClient();
    const extrasMap = await _getPoExtrasMap();
    const { data, error } = await supa.from('purchase_orders').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const out = [];
    for (const row of data || []) {
      const items = await _loadPoItems(row.id);
      out.push(_poToLocal(row, items, extrasMap[row.id]));
    }
    return out;
  }

  async function _generatePONumber() {
    const supa = await _getClient();
    const { data } = await supa.from('purchase_orders').select('po_number');
    let maxNum = 1000;
    for (const r of data || []) {
      const num = parseInt(String(r.po_number || '').replace('PO-', ''), 10) || 0;
      if (num > maxNum) maxNum = num;
    }
    return `PO-${maxNum + 1}`;
  }

  async function _addPurchaseOrder(po) {
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    const poNumber = po.poNumber || await _generatePONumber();
    const row = {
      po_number: poNumber,
      vendor: po.vendor,
      status: po.status || 'draft',
      expected_date: po.expectedDelivery || null,
    };
    if (profile?.id) row.created_by = profile.id;
    const { data, error } = await supa.from('purchase_orders').insert(row).select('*').single();
    if (error) throw error;
    const items = po.items || [];
    if (items.length) {
      const itemRows = items.map(i => ({
        po_id: data.id,
        material_name: i.material,
        quantity: i.quantity ?? 0,
        unit: i.unit || 'sheets',
        unit_cost: i.unitCost ?? null,
      }));
      const { error: ie } = await supa.from('purchase_order_items').insert(itemRows);
      if (ie) throw ie;
    }
    if (po.vendorEmail) await _setPoExtras(data.id, { vendorEmail: po.vendorEmail });
    return _poToLocal(data, items.map((i, idx) => ({
      material_name: i.material,
      quantity: i.quantity,
      unit: i.unit,
      unit_cost: i.unitCost,
    })), { vendorEmail: po.vendorEmail || '' });
  }

  async function _updatePurchaseOrder(id, changes) {
    const all = await _getAllPurchaseOrders();
    const existing = all.find(p => String(p.id) === String(id));
    if (!existing) throw new Error('Not found');
    const merged = { ...existing, ...changes };
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    const row = {
      vendor: merged.vendor,
      status: merged.status,
      expected_date: merged.expectedDelivery || null,
      actual_date: merged.actualDelivery || null,
      received_at: merged.receivedAt || null,
    };
    if (merged.receivedBy) row.received_by = profile?.id || null;
    const { data, error } = await supa.from('purchase_orders').update(row).eq('id', id).select('*').single();
    if (error) throw error;
    if (changes.vendorEmail != null) await _setPoExtras(id, { vendorEmail: changes.vendorEmail });
    if (Array.isArray(changes.items)) {
      await supa.from('purchase_order_items').delete().eq('po_id', id);
      const itemRows = changes.items.map(i => ({
        po_id: id,
        material_name: i.material,
        quantity: i.quantity ?? 0,
        unit: i.unit || 'sheets',
        unit_cost: i.unitCost ?? null,
      }));
      if (itemRows.length) {
        const { error: ie } = await supa.from('purchase_order_items').insert(itemRows);
        if (ie) throw ie;
      }
    }
    const extrasMap = await _getPoExtrasMap();
    const items = await _loadPoItems(id);
    return _poToLocal(data, items, extrasMap[id]);
  }

  async function _receivePO(poId, receivedBy) {
    return _updatePurchaseOrder(poId, {
      status: 'received',
      actualDelivery: new Date().toISOString().split('T')[0],
      receivedBy,
      receivedAt: new Date().toISOString(),
    });
  }

  window.getAllPurchaseOrders = async function () {
    try { return await _getAllPurchaseOrders(); }
    catch (e) { console.error('[Pulse/Supabase] getAllPurchaseOrders:', e); return []; }
  };
  window.generatePONumber = async function () {
    try { return await _generatePONumber(); }
    catch (e) { console.error('[Pulse/Supabase] generatePONumber:', e); return `PO-${Date.now()}`; }
  };
  window.addPurchaseOrder = async function (po) {
    try { return await _addPurchaseOrder(po); }
    catch (e) { console.error('[Pulse/Supabase] addPurchaseOrder:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.updatePurchaseOrder = async function (id, changes) {
    try { return await _updatePurchaseOrder(id, changes); }
    catch (e) { console.error('[Pulse/Supabase] updatePurchaseOrder:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.receivePO = async function (poId, receivedBy) {
    try { return await _receivePO(poId, receivedBy); }
    catch (e) { console.error('[Pulse/Supabase] receivePO:', e); throw new Error(await _formatPulseDbError(e)); }
  };

  // ── Reprints (config JSON array) ─────────────────────────────

  const REPRINTS_KEY = 'pulse_reprints';

  async function _getReprintsList() {
    return await _configJson(REPRINTS_KEY, []);
  }

  async function _saveReprintsList(list) {
    await _setConfigJson(REPRINTS_KEY, list);
  }

  async function _addReprint(reprint) {
    const list = await _getReprintsList();
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `rp-${Date.now()}`;
    const row = { ...reprint, id, createdAt: new Date().toISOString() };
    list.push(row);
    await _saveReprintsList(list);
    return id;
  }

  async function _getAllReprints() {
    return await _getReprintsList();
  }

  async function _getReprintsForOrder(parentOrderId) {
    const list = await _getReprintsList();
    return list.filter(r => String(r.parentOrderId) === String(parentOrderId));
  }

  async function _updateReprint(id, changes) {
    const list = await _getReprintsList();
    const idx = list.findIndex(r => String(r.id) === String(id));
    if (idx < 0) throw new Error('Not found');
    list[idx] = { ...list[idx], ...changes, updatedAt: new Date().toISOString() };
    await _saveReprintsList(list);
    return list[idx];
  }

  window.addReprint = async function (reprint) {
    try { return await _addReprint(reprint); }
    catch (e) { console.error('[Pulse/Supabase] addReprint:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.getAllReprints = async function () {
    try { return await _getAllReprints(); }
    catch (e) { console.error('[Pulse/Supabase] getAllReprints:', e); return []; }
  };
  window.getReprintsForOrder = async function (parentOrderId) {
    try { return await _getReprintsForOrder(parentOrderId); }
    catch (e) { console.error('[Pulse/Supabase] getReprintsForOrder:', e); return []; }
  };
  window.updateReprint = async function (id, changes) {
    try { return await _updateReprint(id, changes); }
    catch (e) { console.error('[Pulse/Supabase] updateReprint:', e); throw new Error(await _formatPulseDbError(e)); }
  };

  // ── Notification memory (config, not localStorage) ───────────

  const NOTIF_MEMORY_KEY = 'pulse_notification_memory';

  window.getNotificationMemory = async function () {
    try { return await _configJson(NOTIF_MEMORY_KEY, {}); }
    catch (e) { return {}; }
  };

  window.rememberNotification = async function (key) {
    const memory = await window.getNotificationMemory();
    memory[key] = Date.now();
    await _setConfigJson(NOTIF_MEMORY_KEY, memory);
  };

  // ── Devices (config JSON array) ──────────────────────────────

  const DEVICES_KEY = 'pulse_devices';

  async function _getDevicesList() {
    return await _configJson(DEVICES_KEY, []);
  }

  async function _saveDevicesList(list) {
    await _setConfigJson(DEVICES_KEY, list);
  }

  window.getAllDevices = async function () {
    try { return await _getDevicesList(); }
    catch (e) { console.error('[Pulse/Supabase] getAllDevices:', e); return []; }
  };
  window.addDevice = async function (device) {
    try {
      const list = await _getDevicesList();
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `dev-${Date.now()}`;
      const row = { ...device, id, createdAt: new Date().toISOString(), status: device.status || 'active' };
      list.push(row);
      await _saveDevicesList(list);
      return id;
    } catch (e) { console.error('[Pulse/Supabase] addDevice:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.updateDevice = async function (id, changes) {
    try {
      const list = await _getDevicesList();
      const idx = list.findIndex(d => String(d.id) === String(id));
      if (idx < 0) throw new Error('Not found');
      list[idx] = { ...list[idx], ...changes, updatedAt: new Date().toISOString() };
      await _saveDevicesList(list);
      return list[idx];
    } catch (e) { console.error('[Pulse/Supabase] updateDevice:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.deleteDevice = async function (id) {
    try {
      const list = await _getDevicesList();
      await _saveDevicesList(list.filter(d => String(d.id) !== String(id)));
    } catch (e) { console.error('[Pulse/Supabase] deleteDevice:', e); throw new Error(await _formatPulseDbError(e)); }
  };

  // ── Invoices ─────────────────────────────────────────────────

  async function _loadInvoiceLineItems(invoiceId) {
    const supa = await _getClient();
    const { data, error } = await supa.from('invoice_line_items').select('*').eq('invoice_id', invoiceId);
    if (error) throw error;
    return data || [];
  }

  async function _invoiceToLocal(row, lineItems, orderIdStr) {
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      orderId: orderIdStr || null,
      customerName: row.customer_name,
      status: row.status,
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      tax: Number(row.tax ?? 0),
      total: Number(row.total ?? 0),
      dueDate: row.due_date || null,
      lineItems: (lineItems || []).map(li => ({
        description: li.description,
        quantity: Number(li.quantity),
        unitPrice: Number(li.unit_price),
        total: Number(li.total),
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  async function _resolveOrderIdString(orderUuid) {
    if (!orderUuid) return null;
    const supa = await _getClient();
    const { data } = await supa.from('orders').select('order_id').eq('id', orderUuid).maybeSingle();
    return data?.order_id || null;
  }

  async function _getAllInvoices() {
    const supa = await _getClient();
    const { data, error } = await supa.from('invoices').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const out = [];
    for (const row of data || []) {
      const items = await _loadInvoiceLineItems(row.id);
      const orderIdStr = await _resolveOrderIdString(row.order_id);
      out.push(await _invoiceToLocal(row, items, orderIdStr));
    }
    return out;
  }

  async function _getInvoice(id) {
    const supa = await _getClient();
    const { data, error } = await supa.from('invoices').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const items = await _loadInvoiceLineItems(data.id);
    const orderIdStr = await _resolveOrderIdString(data.order_id);
    return _invoiceToLocal(data, items, orderIdStr);
  }

  async function _addInvoice(inv) {
    const supa = await _getClient();
    const profile = await _getCurrentProfile();
    let orderUuid = null;
    if (inv.orderId) {
      const order = await _getOrderByOrderId(inv.orderId);
      orderUuid = order?.id || order?._supaId || null;
    }
    const row = {
      invoice_number: inv.invoiceNumber || inv.invoice_number || `INV-${Date.now()}`,
      order_id: orderUuid,
      customer_name: inv.customerName || inv.customer_name || inv.customer || 'Unknown',
      status: inv.status || 'draft',
      subtotal: inv.subtotal ?? 0,
      discount: inv.discount ?? 0,
      tax: inv.tax ?? 0,
      total: inv.total ?? 0,
      due_date: inv.dueDate || inv.due_date || null,
    };
    if (profile?.id) row.created_by = profile.id;
    const { data, error } = await supa.from('invoices').insert(row).select('*').single();
    if (error) throw error;
    const lineItems = inv.lineItems || [];
    if (lineItems.length) {
      const rows = lineItems.map(li => ({
        invoice_id: data.id,
        description: li.description || '',
        quantity: li.quantity ?? 1,
        unit_price: li.unitPrice ?? li.unit_price ?? 0,
        total: li.total ?? ((li.quantity ?? 1) * (li.unitPrice ?? li.unit_price ?? 0)),
      }));
      const { error: ie } = await supa.from('invoice_line_items').insert(rows);
      if (ie) throw ie;
    }
    return _getInvoice(data.id);
  }

  async function _updateInvoice(id, changes) {
    const existing = await _getInvoice(id);
    if (!existing) throw new Error('Not found');
    const merged = { ...existing, ...changes };
    const supa = await _getClient();
    let orderUuid = null;
    if (merged.orderId) {
      const order = await _getOrderByOrderId(merged.orderId);
      orderUuid = order?.id || order?._supaId || null;
    }
    const row = {
      invoice_number: merged.invoiceNumber,
      order_id: orderUuid,
      customer_name: merged.customerName,
      status: merged.status,
      subtotal: merged.subtotal ?? 0,
      discount: merged.discount ?? 0,
      tax: merged.tax ?? 0,
      total: merged.total ?? 0,
      due_date: merged.dueDate || null,
    };
    const { data, error } = await supa.from('invoices').update(row).eq('id', id).select('*').single();
    if (error) throw error;
    if (Array.isArray(changes.lineItems)) {
      await supa.from('invoice_line_items').delete().eq('invoice_id', id);
      const rows = changes.lineItems.map(li => ({
        invoice_id: id,
        description: li.description || '',
        quantity: li.quantity ?? 1,
        unit_price: li.unitPrice ?? 0,
        total: li.total ?? ((li.quantity ?? 1) * (li.unitPrice ?? 0)),
      }));
      if (rows.length) {
        const { error: ie } = await supa.from('invoice_line_items').insert(rows);
        if (ie) throw ie;
      }
    }
    return _getInvoice(data.id);
  }

  async function _deleteInvoice(id) {
    const supa = await _getClient();
    await supa.from('invoice_line_items').delete().eq('invoice_id', id);
    const { error } = await supa.from('invoices').delete().eq('id', id);
    if (error) throw error;
  }

  async function _getInvoiceByOrderId(orderId) {
    const all = await _getAllInvoices();
    return all.find(inv => String(inv.orderId) === String(orderId)) || null;
  }

  window.getInvoice = async function (id) {
    try { return await _getInvoice(id); }
    catch (e) { console.error('[Pulse/Supabase] getInvoice:', e); return null; }
  };
  window.getAllInvoices = async function () {
    try { return await _getAllInvoices(); }
    catch (e) { console.error('[Pulse/Supabase] getAllInvoices:', e); return []; }
  };
  window.addInvoice = async function (inv) {
    try { return await _addInvoice(inv); }
    catch (e) { console.error('[Pulse/Supabase] addInvoice:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.updateInvoice = async function (id, changes) {
    try { return await _updateInvoice(id, changes); }
    catch (e) { console.error('[Pulse/Supabase] updateInvoice:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.deleteInvoice = async function (id) {
    try { return await _deleteInvoice(id); }
    catch (e) { console.error('[Pulse/Supabase] deleteInvoice:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.getInvoiceByOrderId = async function (orderId) {
    try { return await _getInvoiceByOrderId(orderId); }
    catch (e) { console.error('[Pulse/Supabase] getInvoiceByOrderId:', e); return null; }
  };
  window.generateInvoiceNumber = async function (orderId) {
    return 'INV-' + String(orderId || '').split('_')[0];
  };

  // ── Packaging catalog ────────────────────────────────────────

  const PACKAGING_CATEGORIES = new Set(['Bags', 'Jars', 'Tubes', 'Labels', 'Pouches', 'Cartons', 'Other']);

  function _packagingToLocal(row) {
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      category: row.category,
      material: row.material || null,
      finish: row.finish || null,
      production_method: row.production_method || null,
      default_cost: Number(row.default_cost ?? 0),
      sell_price: Number(row.sell_price ?? 0),
      tier_pricing: row.tier_pricing || {},
      min_qty: row.min_qty ?? 25,
      lead_time_days: row.lead_time_days ?? null,
      active: row.active !== false,
      notes: row.notes || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  function _packagingToRow(product) {
    const cat = PACKAGING_CATEGORIES.has(product.category) ? product.category : 'Other';
    return {
      sku: product.sku,
      name: product.name,
      category: cat,
      material: product.material || null,
      finish: product.finish || null,
      production_method: product.production_method || null,
      default_cost: product.default_cost ?? 0,
      sell_price: product.sell_price ?? 0,
      tier_pricing: product.tier_pricing || {},
      min_qty: product.min_qty ?? 25,
      lead_time_days: product.lead_time_days ?? null,
      active: product.active !== false,
      notes: product.notes || null,
    };
  }

  async function _getAllPackagingProducts() {
    const supa = await _getClient();
    const { data, error } = await supa.from('packaging_products').select('*').order('sku', { ascending: true });
    if (error) throw error;
    return (data || []).map(_packagingToLocal);
  }

  async function _getPackagingProduct(id) {
    const supa = await _getClient();
    const { data, error } = await supa.from('packaging_products').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? _packagingToLocal(data) : null;
  }

  async function _addPackagingProduct(product) {
    const supa = await _getClient();
    const row = _packagingToRow({ ...product, active: product.active !== false });
    const { data, error } = await supa.from('packaging_products').insert(row).select('*').single();
    if (error) throw error;
    return _packagingToLocal(data);
  }

  async function _updatePackagingProduct(id, changes) {
    const existing = await _getPackagingProduct(id);
    if (!existing) throw new Error('Not found');
    const supa = await _getClient();
    const row = _packagingToRow({ ...existing, ...changes });
    const { data, error } = await supa.from('packaging_products').update(row).eq('id', id).select('*').single();
    if (error) throw error;
    return _packagingToLocal(data);
  }

  async function _deletePackagingProduct(id) {
    const supa = await _getClient();
    const { error } = await supa.from('packaging_products').delete().eq('id', id);
    if (error) throw error;
  }

  async function _seedPackagingCatalogIfEmpty() {
    const existing = await _getAllPackagingProducts();
    if (existing.length > 0) return;
    const seed = typeof PACKAGING_CATALOG_SEED !== 'undefined' ? PACKAGING_CATALOG_SEED : [];
    for (const p of seed) {
      try { await _addPackagingProduct({ ...p }); } catch (e) {
        console.warn('[Pulse/Supabase] seed packaging:', p.sku, e);
      }
    }
  }

  window.getAllPackagingProducts = async function () {
    try { return await _getAllPackagingProducts(); }
    catch (e) { console.error('[Pulse/Supabase] getAllPackagingProducts:', e); return []; }
  };
  window.getPackagingProduct = async function (id) {
    try { return await _getPackagingProduct(id); }
    catch (e) { console.error('[Pulse/Supabase] getPackagingProduct:', e); return null; }
  };
  window.addPackagingProduct = async function (product) {
    try { return await _addPackagingProduct(product); }
    catch (e) { console.error('[Pulse/Supabase] addPackagingProduct:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.updatePackagingProduct = async function (id, changes) {
    try { return await _updatePackagingProduct(id, changes); }
    catch (e) { console.error('[Pulse/Supabase] updatePackagingProduct:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.deletePackagingProduct = async function (id) {
    try { return await _deletePackagingProduct(id); }
    catch (e) { console.error('[Pulse/Supabase] deletePackagingProduct:', e); throw new Error(await _formatPulseDbError(e)); }
  };
  window.seedPackagingCatalogIfEmpty = async function () {
    try { return await _seedPackagingCatalogIfEmpty(); }
    catch (e) { console.error('[Pulse/Supabase] seedPackagingCatalogIfEmpty:', e); }
  };

  // Mark every Supabase override so shared.js never falls back to IndexedDB.
  const PULSE_SUPABASE_OVERRIDE_NAMES = [
    'getConfig', 'setConfig', 'getAllConfigEntries',
    'getAllPersonnel', 'addPersonnel', 'updatePersonnel', 'deletePersonnel',
    'getAllOrders', 'getAllOrdersSummary', 'getOrder', 'getOrderByOrderId', 'addOrder', 'updateOrder',
    'generateOrderId', 'generateSubTicketId', 'getSubTickets',
    'addActivity', 'getActivityLog', 'getAllActivity', 'getOrderComments', 'addOrderComment',
    'getAllMachines', 'getAllProductWorkflows', 'getProductWorkflowByCatalogId', 'getProductWorkflowByName',
    'upsertProductWorkflow', 'deleteProductWorkflow', 'seedProductWorkflowsFromDefaults', 'resetAllProductWorkflowsFromDefaults',
    'getAllMachineIssues', 'insertMachineIssue', 'updateMachineIssue',
    'getAllDies', 'getDieByNumber', 'getDieByBarcode', 'addDie', 'updateDie', 'recordDieUsage',
    'getAllKnowledge', 'addKnowledgeEntry', 'updateKnowledge',
    'clockIn', 'clockOut', 'startBreak', 'endBreak', 'getTodaySessions', 'getOperatorSession',
    'getOperatorSessionById', 'updateOperatorSession',
    'addOperatorPoints', 'getAllOperatorPoints', 'getOperatorMonthlyPoints',
    'getAllPurchaseOrders', 'generatePONumber', 'addPurchaseOrder', 'updatePurchaseOrder', 'receivePO',
    'addReprint', 'getAllReprints', 'getReprintsForOrder', 'updateReprint',
    'getNotificationMemory', 'rememberNotification',
    'getAllDevices', 'addDevice', 'updateDevice', 'deleteDevice',
    'getInvoice', 'getAllInvoices', 'addInvoice', 'updateInvoice', 'deleteInvoice',
    'getInvoiceByOrderId', 'generateInvoiceNumber',
    'getAllPackagingProducts', 'getPackagingProduct', 'addPackagingProduct', 'updatePackagingProduct',
    'deletePackagingProduct', 'seedPackagingCatalogIfEmpty',
  ];
  PULSE_SUPABASE_OVERRIDE_NAMES.forEach((n) => {
    if (typeof window[n] === 'function') window[n].__pulseSupabaseOverride = true;
  });

  window.usePulseSupabaseStorage = function () {
    return true;
  };

  console.log('[Pulse] Supabase backend registered — awaiting client init');
  } else {
    console.log('[Pulse] Migrate tool ready — import backup, then run full migration');
  }

})();
