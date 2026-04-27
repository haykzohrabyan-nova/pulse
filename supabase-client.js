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

  if (BACKEND !== 'supabase' || !SUPA_URL || !SUPA_KEY) {
    console.log('[Pulse] Storage backend: IndexedDB');
    return; // No-op — IndexedDB functions remain active
  }

  console.log('[Pulse] Storage backend: Supabase →', SUPA_URL);

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
      // Artwork file metadata only (bytes live in R2 via PRI-237)
      artworkFiles: (order.artworkFiles || []).map(f => ({
        name:  f.name,
        size:  f.size,
        type:  f.type,
        role:  f.role || 'main',
        r2Key: f.r2Key || null, // populated after R2 upload (PRI-237)
      })),
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
      overtimeApproval:          order.overtimeApproval        || null,
      // Legacy notes (migrated from IndexedDB; new records use order_comments)
      notesLog:            order.notesLog            || [],
      conversationHistory: order.conversationHistory || [],
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
      overtimeApproval:         s.overtimeApproval         || null,
      notesLog:            s.notesLog            || [],
      conversationHistory: s.conversationHistory || [],
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

  async function _updateOrder(id, changes) {
    const supa = await _getClient();

    // Fetch current order so we can merge specs
    const { data: current, error: fetchErr } = await supa
      .from('orders')
      .select('specs, parent_order_id')
      .eq('id', id)
      .single();
    if (fetchErr) throw fetchErr;

    // Build the update payload
    const combined = { ...changes, id };
    const row = _orderToRow(combined);

    // Merge specs (don't obliterate existing keys not in this update)
    if (current?.specs) {
      row.specs = { ...current.specs, ...row.specs };
    }

    const { error: updateErr } = await supa
      .from('orders')
      .update(row)
      .eq('id', id);
    if (updateErr) throw updateErr;

    // Update workflow steps if provided
    if (Array.isArray(changes.workflowSteps)) {
      // Delete existing steps and re-insert
      await supa.from('order_workflow_steps').delete().eq('order_id', id);
      if (changes.workflowSteps.length > 0) {
        const steps = changes.workflowSteps.map((step, idx) => ({
          order_id:    id,
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

    return { ...current, ...changes };
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

  async function _addActivity(log) {
    const supa = await _getClient();
    const user = await _getCurrentUser();

    // Resolve order UUID from orderId text
    let orderUuid = null;
    if (log.orderId) {
      const { data } = await supa
        .from('orders')
        .select('id')
        .eq('order_id', String(log.orderId))
        .maybeSingle();
      orderUuid = data?.id || null;
    }

    const entry = {
      order_id:   orderUuid,
      action:     log.type || log.action || 'note',
      details:    log.message ? { message: log.message } : (log.details || null),
      actor_id:   user?.id || null,
      actor_name: log.by || log.actorName || null,
    };
    const { error } = await supa.from('activity_log').insert(entry);
    if (error) console.error('[Pulse/Supabase] activity_log insert error:', error);
  }

  async function _getActivityLog(orderId) {
    const supa = await _getClient();
    // Resolve UUID
    const { data: orderRow } = await supa
      .from('orders')
      .select('id')
      .eq('order_id', String(orderId))
      .maybeSingle();
    if (!orderRow) return [];
    const { data, error } = await supa
      .from('activity_log')
      .select('*')
      .eq('order_id', orderRow.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(r => ({
      id:        r.id,
      orderId,
      type:      r.action,
      message:   r.details?.message || r.action,
      by:        r.actor_name,
      timestamp: r.created_at,
    }));
  }

  async function _getAllActivity() {
    const supa = await _getClient();
    const { data, error } = await supa
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
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
  // Each override falls back to IndexedDB if Supabase client is unavailable.

  const _origGetAllOrders       = window.getAllOrders;
  const _origGetOrder           = window.getOrder;
  const _origGetOrderByOrderId  = window.getOrderByOrderId;
  const _origAddOrder           = window.addOrder;
  const _origUpdateOrder        = window.updateOrder;
  const _origGenerateOrderId    = window.generateOrderId;
  const _origGenerateSubTicketId = window.generateSubTicketId;
  const _origGetSubTickets      = window.getSubTickets;
  const _origAddActivity        = window.addActivity;
  const _origGetActivityLog     = window.getActivityLog;
  const _origGetAllActivity     = window.getAllActivity;

  window.getAllOrders = async function () {
    try { return await _getAllOrders(); }
    catch (e) { console.error('[Pulse/Supabase] getAllOrders:', e); return _origGetAllOrders ? _origGetAllOrders() : []; }
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
    catch (e) { console.error('[Pulse/Supabase] addOrder:', e); return _origAddOrder ? _origAddOrder(order) : null; }
  };

  window.updateOrder = async function (id, changes) {
    try { return await _updateOrder(id, changes); }
    catch (e) { console.error('[Pulse/Supabase] updateOrder:', e); return _origUpdateOrder ? _origUpdateOrder(id, changes) : null; }
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
    catch (e) { console.error('[Pulse/Supabase] addActivity:', e); return _origAddActivity ? _origAddActivity(log) : null; }
  };

  window.getActivityLog = async function (orderId) {
    try { return await _getActivityLog(orderId); }
    catch (e) { console.error('[Pulse/Supabase] getActivityLog:', e); return _origGetActivityLog ? _origGetActivityLog(orderId) : []; }
  };

  window.getAllActivity = async function () {
    try { return await _getAllActivity(); }
    catch (e) { console.error('[Pulse/Supabase] getAllActivity:', e); return _origGetAllActivity ? _origGetAllActivity() : []; }
  };

  // Expose comment helpers
  window.getOrderComments = _getOrderComments;
  window.addOrderComment  = _addOrderComment;

  // ── Migration helper: export IndexedDB → Supabase ────────────

  /**
   * Migrate all existing IndexedDB orders to Supabase.
   * Skips orders whose order_id already exists in Supabase.
   * Called from migrate-to-supabase.html.
   */
  window.migrateIndexedDBToSupabase = async function (onProgress) {
    const supa = await _getClient();
    const report = { inserted: 0, skipped: 0, errors: [] };

    // Get existing order IDs from Supabase
    const { data: existing } = await supa.from('orders').select('order_id');
    const existingIds = new Set((existing || []).map(r => r.order_id));

    // Read from IndexedDB using original function
    let idbOrders = [];
    try {
      idbOrders = _origGetAllOrders ? await _origGetAllOrders() : [];
    } catch (e) {
      // Direct IndexedDB read if override not available
      idbOrders = await _readIndexedDBOrders();
    }

    onProgress?.({ phase: 'reading', total: idbOrders.length, done: 0 });

    for (let i = 0; i < idbOrders.length; i++) {
      const order = idbOrders[i];
      onProgress?.({ phase: 'inserting', total: idbOrders.length, done: i, current: order.orderId });

      if (existingIds.has(String(order.orderId))) {
        report.skipped++;
        continue;
      }

      try {
        await _addOrder(order);
        // Also migrate activity log for this order
        const activities = _origGetActivityLog
          ? await _origGetActivityLog(order.orderId)
          : await _readIndexedDBActivity(order.orderId);
        for (const act of (activities || [])) {
          await _addActivity({ ...act, orderId: order.orderId });
        }
        report.inserted++;
      } catch (e) {
        report.errors.push({ orderId: order.orderId, error: e.message });
      }
    }

    onProgress?.({ phase: 'done', total: idbOrders.length, done: idbOrders.length });
    return report;
  };

  /** Direct IndexedDB read (bypasses our overrides) */
  function _readIndexedDBOrders() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('BazaarPrintDB');
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('orders', 'readonly');
        const all = tx.objectStore('orders').getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror  = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _readIndexedDBActivity(orderId) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('BazaarPrintDB');
        req.onsuccess = e => {
          const db = e.target.result;
          const tx = db.transaction('activity_log', 'readonly');
          const idx = tx.objectStore('activity_log').index('orderId');
          const all = idx.getAll(orderId);
          all.onsuccess = () => resolve(all.result);
          all.onerror  = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  }

  console.log('[Pulse] Supabase backend registered — awaiting client init');

})();
