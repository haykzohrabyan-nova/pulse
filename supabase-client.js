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
    const { data } = await supa.from('profiles').select('*').eq('id', user.id).single();
    return data;
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
      applicationService:       s.applicationService       || false,
      applicationContainerType: s.applicationContainerType || null,
      applicationFeePerPiece:   s.applicationFeePerPiece   ?? null,
      cutMethod:                s.cutMethod                || '',
      dieName:                  s.dieName                  || '',
      extraFrames:              s.extraFrames              ?? 0,
      makeReadyFrames:          s.makeReadyFrames          ?? 0,
      framesWasted:             s.framesWasted             ?? 0,
      skus:                     s.skus                     || null,
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

  function _formatPulseDbError(err) {
    const msg = err?.message || err?.details || String(err || 'Unknown error');
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
      return 'Order not found or you do not have permission to update it. Refresh the page and try again.';
    }
    if (/permission denied|row-level security|42501/i.test(msg)) {
      return 'You do not have permission to update this order. Your DB role is missing an orders update policy; run the latest RLS migrations and verify profiles.role for this user.';
    }
    return msg;
  }

  async function _updateOrder(id, changes) {
    const supa = await _getClient();

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
      await supa.from('order_workflow_steps').delete().eq('order_id', lookupId);
      if (changes.workflowSteps.length > 0) {
        const steps = changes.workflowSteps.map((step, idx) => ({
          order_id:    lookupId,
          step_index:  step.stepIndex ?? idx,
          machine:     step.machine,
          operation:   step.operation || null,
          status:      step.status || 'pending',
          operator_id:   step.operator_id || null,
          operator_name: step.assignedTo || null,
          started_at:    step.startedAt || null,
          completed_at:  step.completedAt || null,
          notes:         step.notes || null,
        }));
        await supa.from('order_workflow_steps').insert(steps);
      }
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

  async function _addActivity(_log) {
    return Promise.resolve();
  }

  async function _getActivityLog(_orderId) {
    return [];
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

  window.getAllPersonnel = async function () {
    try {
      const rec = await _supaGetConfig('personnel');
      if (rec?.value && Array.isArray(rec.value) && rec.value.length) return rec.value;
    } catch (e) {
      console.error('[Pulse/Supabase] getAllPersonnel:', e);
    }
    return _origGetAllPersonnel ? _origGetAllPersonnel() : [];
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
      throw new Error(_formatPulseDbError(e));
    }
  };

  window.updateOrder = async function (id, changes) {
    try { return await _updateOrder(id, changes); }
    catch (e) {
      console.error('[Pulse/Supabase] updateOrder:', e);
      throw new Error(_formatPulseDbError(e));
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

  window.addActivity = async function () {
    return null;
  };

  window.getActivityLog = async function () {
    return [];
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

  console.log('[Pulse] Supabase backend registered — awaiting client init');
  } else {
    console.log('[Pulse] Migrate tool ready — import backup, then run full migration');
  }

})();
