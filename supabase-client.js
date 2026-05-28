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

  function _registerRealtimeSubscriptions(supa) {
    supa
      .channel('pulse-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
        // Notify any listening page code via a custom DOM event
        window.dispatchEvent(new CustomEvent('pulse:order-change', { detail: payload }));
      })
      .subscribe();

    supa
      .channel('pulse-activity')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, payload => {
        window.dispatchEvent(new CustomEvent('pulse:activity-change', { detail: payload }));
      })
      .subscribe();
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
    if (typeof OPERATOR_PROFILES !== 'undefined') {
      Object.entries(OPERATOR_PROFILES).forEach(([name, prof]) => {
        const key = String(name).trim().toLowerCase();
        if (!map.has(key) && prof?.userId != null) map.set(key, String(prof.userId));
      });
    }
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
    if (_origSetConfig) {
      try { await _origSetConfig('personnel', list); } catch (_) {}
    }
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
      return _origGetConfig ? _origGetConfig(key) : null;
    }
  };

  window.setConfig = async function (key, value) {
    try { return await _supaSetConfig(key, value); }
    catch (e) {
      console.error('[Pulse/Supabase] setConfig:', e);
      return _origSetConfig ? _origSetConfig(key, value) : null;
    }
  };

  window.getAllConfigEntries = async function () {
    try { return await _supaGetAllConfigEntries(); }
    catch (e) {
      console.error('[Pulse/Supabase] getAllConfigEntries:', e);
      return _origGetAllConfigEntries ? _origGetAllConfigEntries() : [];
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

  window.getAllPersonnel = async function () {
    const byName = new Map();
    const addPerson = (p) => {
      if (!p?.name) return;
      const key = String(p.name).trim().toLowerCase();
      const prev = byName.get(key);
      byName.set(key, prev ? _mergePersonnelRows(p, prev) : { ...p });
    };

    let fromConfig = [];
    let fromProfiles = [];
    try {
      fromConfig = await _getPersonnelList();
    } catch (e) {
      console.error('[Pulse/Supabase] getAllPersonnel (config):', e);
    }
    try {
      fromProfiles = await _fetchPersonnelFromProfiles();
    } catch (e) {
      console.error('[Pulse/Supabase] getAllPersonnel (profiles):', e);
    }

    // config.personnel (legacy JSON) first, then profiles table overwrites — single merged list
    fromConfig.forEach(addPerson);
    fromProfiles.forEach(addPerson);

    if (byName.size) {
      return Array.from(byName.values()).sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
      );
    }

    try {
      const list = await _getPersonnelList();
      if (list.length) return list;
    } catch (_) {}

    return _origGetAllPersonnel ? _origGetAllPersonnel() : [];
  };

  window.addPersonnel = async function (person) {
    const name = String(person?.name || '').trim();
    if (!name) throw new Error('Name is required');

    try {
      const supa = await _getClient();
      const { data: existing } = await supa
        .from('profiles')
        .select('id')
        .eq('display_name', name)
        .maybeSingle();
      if (existing?.id) {
        await _updateProfilePersonnel(existing.id, person);
        return existing.id;
      }
    } catch (e) {
      console.warn('[Pulse/Supabase] addPersonnel profiles lookup:', e);
    }

    try {
      const list = await _getPersonnelList();
      const row = {
        ...(person || {}),
        id: person?.id || _stablePersonnelId(person || {}, list.length),
        createdAt: person?.createdAt || new Date().toISOString(),
        active: person?.active !== false,
      };
      list.push(row);
      await _savePersonnelList(list);
      _notifyPersonnelChanged();
      return row.id;
    } catch (e) {
      console.error('[Pulse/Supabase] addPersonnel:', e);
      if (_origAddPersonnel) return _origAddPersonnel(person);
      throw new Error(
        'Could not add personnel. Create the user in Supabase Auth first (Authentication → Users), then set their User ID here.'
      );
    }
  };

  window.updatePersonnel = async function (id, changes) {
    const key = String(id ?? '');
    if (_isProfileUuid(key)) {
      try {
        return await _updateProfilePersonnel(key, changes || {});
      } catch (e) {
        console.error('[Pulse/Supabase] updatePersonnel (profiles):', e);
        throw e;
      }
    }

    try {
      const list = await _getPersonnelList();
      const idx = list.findIndex(p => _findPersonnelInList([p], key));
      if (idx < 0) {
        const allProfiles = await _fetchPersonnelFromProfiles().catch(() => []);
        const match = _findPersonnelInList(allProfiles, key);
        if (match?._profileId) return _updateProfilePersonnel(match._profileId, changes || {});
        throw new Error('Personnel record not found');
      }
      list[idx] = { ...list[idx], ...(changes || {}), id: list[idx].id };
      await _savePersonnelList(list);
      _notifyPersonnelChanged();
      return list[idx];
    } catch (e) {
      console.error('[Pulse/Supabase] updatePersonnel:', e);
      if (_origUpdatePersonnel) return _origUpdatePersonnel(id, changes);
      throw e;
    }
  };

  window.deletePersonnel = async function (id) {
    const key = String(id ?? '');
    if (_isProfileUuid(key)) {
      try {
        await _updateProfilePersonnel(key, { active: false });
        return true;
      } catch (e) {
        console.error('[Pulse/Supabase] deletePersonnel (profiles):', e);
        throw e;
      }
    }

    try {
      const list = await _getPersonnelList();
      const match = _findPersonnelInList(list, key);
      if (match?._profileId && _isProfileUuid(match._profileId)) {
        await _updateProfilePersonnel(match._profileId, { active: false });
        return true;
      }
      const next = list.filter(p => !_findPersonnelInList([p], key));
      if (next.length === list.length) throw new Error('Personnel record not found');
      await _savePersonnelList(next);
      _notifyPersonnelChanged();
      return true;
    } catch (e) {
      console.error('[Pulse/Supabase] deletePersonnel:', e);
      if (_origDeletePersonnel) return _origDeletePersonnel(id);
      throw e;
    }
  };

  window.getAllOrders = async function () {
    window.PULSE_LAST_ORDERS_ERROR = null;
    try { return await _getAllOrders(); }
    catch (e) {
      console.error('[Pulse/Supabase] getAllOrders:', e);
      window.PULSE_LAST_ORDERS_ERROR = e;
      if (_origGetAllOrders) {
        try {
          const local = await _origGetAllOrders();
          if (local?.length) return local;
        } catch (_) {}
      }
      return [];
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

  window.upsertProductWorkflow = async function (wf) {
    try { return await _upsertProductWorkflow(wf); }
    catch (e) {
      console.error('[Pulse/Supabase] upsertProductWorkflow:', e);
      throw new Error(_formatPulseDbError(e));
    }
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
      throw new Error(_formatPulseDbError(e));
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
      throw new Error(_formatPulseDbError(e));
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
      throw new Error(_formatPulseDbError(e));
    }
  };

  window.insertMachineIssue = async function (issue) {
    try { return await _insertMachineIssue(issue); }
    catch (e) {
      console.error('[Pulse/Supabase] insertMachineIssue:', e);
      throw new Error(_formatPulseDbError(e));
    }
  };

  window.updateMachineIssue = async function (issue) {
    try { return await _updateMachineIssue(issue); }
    catch (e) {
      console.error('[Pulse/Supabase] updateMachineIssue:', e);
      throw new Error(_formatPulseDbError(e));
    }
  };

  window.usePulseSupabaseStorage = function () {
    return true;
  };

  console.log('[Pulse] Supabase backend registered — awaiting client init');
  } else {
    console.log('[Pulse] Migrate tool ready — import backup, then run full migration');
  }

})();
