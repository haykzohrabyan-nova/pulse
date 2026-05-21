/**
 * pulse-quote-payment.js — shared quote catalog, payment config, checkout gates.
 * Used by payment.html and crm-quote.html (no shared.js / Supabase).
 */
(function (global) {
  'use strict';

  const PAY_STORAGE_KEY = 'pulse_payment_admin_config_v1';
  const QUOTE_STATE_KEY = 'pulse_quote_checkout_v1';
  const PREVIEW_QUOTE_KEY = 'pulse_payment_preview_quote_v1';

  const PAY_CHANNELS = [
    { id: 'cash', label: 'Cash' },
    { id: 'wire', label: 'Wire' },
    { id: 'ach', label: 'ACH' },
    { id: 'zelle', label: 'Zelle' },
    { id: 'check', label: 'Check' },
    { id: 'card', label: 'Card (online)' },
  ];

  const NET_TERMS_DAYS = {
    'net-10': 10,
    'net-15': 15,
    'net-20': 20,
    'net-30': 30,
    'net-45': 45,
    'net-60': 60,
  };

  const LEGACY_NET_TERMS_MAP = {
    'net-90': 'net-60',
    cod: 'net-10',
    'due-on-receipt': 'net-10',
  };

  const FOLLOW_UP_FREQ_VALUES = ['daily', 'every-3-days', 'weekly'];

  const LEGACY_FOLLOW_UP_FREQ_MAP = {
    'every-other-day': 'every-3-days',
    biweekly: 'weekly',
    30: 'weekly',
  };

  function normalizeNetTermsLabel(label) {
    const key = String(label || 'net-30');
    if (NET_TERMS_DAYS[key] != null) return key;
    return LEGACY_NET_TERMS_MAP[key] || 'net-30';
  }

  function getNetTermsDaysFromLabel(label) {
    const key = normalizeNetTermsLabel(label);
    return NET_TERMS_DAYS[key] ?? 30;
  }

  function normalizeFollowUpFreq(freq) {
    const key = String(freq || 'daily');
    if (FOLLOW_UP_FREQ_VALUES.includes(key)) return key;
    return LEGACY_FOLLOW_UP_FREQ_MAP[key] || 'daily';
  }

  const PULSE_COMPANY = {
    company_name: 'Bazzar Printing',
    address_line1: '306 Boyd St',
    city: 'Los Angeles',
    state: 'CA',
    zip: '90013',
    phone: '7473484444',
    email: 'bazarprint@gmail.com',
    website: 'https://bazaarprinting.com/',
  };

  /** Shown in quote “Record payment” modal for client remittance instructions */
  const PAYMENT_REMITTANCE = {
    bankName: 'Chase Bank',
    accountName: 'Bazaar Printing Inc',
    accountNumber: '1234567890',
    routingNumber: '322271627',
    zelle: 'bazarprint@gmail.com',
  };

  const PULSE_QUOTES = {
    '40496516-f693-4d6e-a15a-add7e582444b': {
      ticket: {
        title: 'Labelner',
        reference_code: 'ORD-2026-001',
        ticket_status: 'order',
        quote_channel: 'Email',
        quote_skus: [
          {
            description: 'Labels (Roll) – Matte',
            product_type: 'Labels (Roll)',
            width: 4,
            height: 3,
            quantity: 1000,
            unit_price: 1,
            color_mode: 'CMYK',
            lamination: 'Matte',
            sides: 'Single-sided',
          },
          {
            description: 'Business Cards – 14pt C1S',
            product_type: 'Business Cards',
            width: 3,
            height: 4,
            quantity: 100,
            unit_price: 2,
            material: '14pt C1S',
            color_mode: 'CMYK',
            lamination: 'None',
          },
        ],
        quote_subtotal: 1200,
        quote_shipping: 10,
        discount_type: 'percent',
        discount_value: '10',
        quote_pre_tax_total: 1089,
        quote_tax_rate_percent: 7.3,
        quote_tax_amount: 79.5,
        quote_final_total: 1168.5,
        quote_payment_types: ['Zelle'],
        due_date: '2026-05-21',
        created_at: '2026-05-19T16:00:00.000Z',
        priority: 'Normal',
        rush: true,
        contact_name: 'Nikolay Yeghyan',
        contact_email: 'nikol@gmail.com',
        contact_company: 'Yerevan Marketplace',
        customer: {
          company: 'Yerevan Marketplace',
          first_name: 'Nikolay',
          last_name: 'Yeghyan',
          email: 'nikol@gmail.com',
          phone: '3234813620',
        },
      },
      company: PULSE_COMPANY,
    },
  };

  const DEFAULT_QUOTE_TOKEN = '40496516-f693-4d6e-a15a-add7e582444b';

  const PAY_DEFAULTS = {
    strategy: 'full',
    previewQuoteToken: DEFAULT_QUOTE_TOKEN,
    quotePrice: 1000,
    depositPct: 30,
    depositAmt: 300,
    depHandling: 'cash',
    receiptId: '',
    channelsPartial: ['cash', 'wire', 'ach', 'zelle', 'card'],
    channelsFull: ['wire', 'ach', 'zelle', 'check', 'card'],
    requireClientConfirm: true,
    quoteChannel: 'sms',
    destPhone: '',
    destEmail: '',
    followUpEnabled: true,
    followUpStart: '',
    followUpCount: '3',
    followUpFreq: 'daily',
    netTermsLabel: 'net-30',
  };

  function formatMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function getQuoteTotal(ticket) {
    const v = Number(ticket?.quote_final_total);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function getDepositAmount(paymentCfg, quoteTotal) {
    const total = Math.max(0, Number(quoteTotal) || 0);
    const pct = Number(paymentCfg.depositPct);
    const amt = Number(paymentCfg.depositAmt);
    if (Number.isFinite(pct) && pct > 0) {
      return Math.min(Math.round(((total * pct) / 100) * 100) / 100, total);
    }
    if (Number.isFinite(amt) && amt > 0) return Math.min(amt, total);
    return 0;
  }

  function channelLabels(ids) {
    return (ids || [])
      .map((id) => PAY_CHANNELS.find((c) => c.id === id)?.label || id)
      .join(', ');
  }

  function strategyLabel(strategy) {
    if (strategy === 'full') return 'Pay in full';
    if (strategy === 'net') return 'Net terms';
    return 'Partial payment';
  }

  function emptyQuoteState() {
    return {
      sentAt: null,
      sentChannel: null,
      quotePriceConfirmed: false,
      quotePriceConfirmedAt: null,
      clientConfirmed: false,
      clientConfirmedAt: null,
      payment: {
        totalPaid: null,
        depositRecordedAt: null,
        depositAmount: null,
        depositReceiptId: null,
        depositMethod: null,
        balanceRecordedAt: null,
        fullRecordedAt: null,
        fullAmount: null,
        fullReceiptId: null,
      },
      productionReleasedAt: null,
      notes: '',
    };
  }

  function loadAllQuoteStates() {
    try {
      const raw = localStorage.getItem(QUOTE_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function loadQuoteState(token) {
    const all = loadAllQuoteStates();
    const base = emptyQuoteState();
    const saved = all[token];
    if (!saved) return base;
    return {
      ...base,
      ...saved,
      payment: { ...base.payment, ...(saved.payment || {}) },
    };
  }

  function saveQuoteState(token, patch) {
    const all = loadAllQuoteStates();
    const prev = loadQuoteState(token);
    all[token] = {
      ...prev,
      ...patch,
      payment: { ...prev.payment, ...(patch.payment || {}) },
    };
    localStorage.setItem(QUOTE_STATE_KEY, JSON.stringify(all));
    return all[token];
  }

  function loadPaymentConfig() {
    try {
      const raw = localStorage.getItem(PAY_STORAGE_KEY);
      if (!raw) return { ...PAY_DEFAULTS };
      const parsed = JSON.parse(raw);
      return { ...PAY_DEFAULTS, ...parsed };
    } catch (_) {
      return { ...PAY_DEFAULTS };
    }
  }

  function applyFullCashCheckoutState(token, cfg) {
    if (!hasConfigFullCashReceipt(cfg)) return;
    const pack = getQuotePack(token);
    if (!pack) return;
    const quoteTotal = Number(cfg.quotePrice) > 0 ? Number(cfg.quotePrice) : getQuoteTotal(pack.ticket);
    if (!quoteTotal) return;
    const now = new Date().toISOString();
    const prev = loadQuoteState(token);
    saveQuoteState(token, {
      quotePriceConfirmed: true,
      quotePriceConfirmedAt: prev.quotePriceConfirmedAt || now,
      clientConfirmed: true,
      clientConfirmedAt: prev.clientConfirmedAt || now,
      payment: {
        ...prev.payment,
        totalPaid: quoteTotal,
        fullRecordedAt: prev.payment?.fullRecordedAt || now,
        fullAmount: quoteTotal,
        fullReceiptId: String(cfg.receiptId || '').trim(),
        depositMethod: 'cash',
      },
    });
  }

  function savePaymentConfig(cfg) {
    const merged = { ...cfg, savedAt: new Date().toISOString() };
    localStorage.setItem(PAY_STORAGE_KEY, JSON.stringify(merged));
    if (hasConfigFullCashReceipt(merged)) {
      applyFullCashCheckoutState(getPreviewQuoteToken(merged), merged);
    }
  }

  /** Clear checkout progress so quotes reflect newly saved payment rules. */
  function resetQuoteCheckoutForPaymentConfig(cfg) {
    const preview = getPreviewQuoteToken(cfg);
    const tokens = new Set([...Object.keys(PULSE_QUOTES), preview]);
    const next = {};
    tokens.forEach((token) => {
      if (token) next[token] = emptyQuoteState();
    });
    localStorage.setItem(QUOTE_STATE_KEY, JSON.stringify(next));
    return preview;
  }

  function getPreviewQuoteToken(cfg) {
    const t = cfg?.previewQuoteToken || localStorage.getItem(PREVIEW_QUOTE_KEY);
    if (t && PULSE_QUOTES[t]) return t;
    return DEFAULT_QUOTE_TOKEN;
  }

  function setPreviewQuoteToken(token) {
    if (PULSE_QUOTES[token]) localStorage.setItem(PREVIEW_QUOTE_KEY, token);
  }

  function getQuotePack(token) {
    return PULSE_QUOTES[token] || null;
  }

  function listQuoteOptions() {
    return Object.entries(PULSE_QUOTES).map(([token, pack]) => ({
      token,
      ref: pack.ticket?.reference_code || token.slice(0, 8),
      title: pack.ticket?.title || 'Quote',
      total: getQuoteTotal(pack.ticket),
    }));
  }

  function syncDepositFromTotal(quoteTotal, depositPct, depositAmt, origin, options = {}) {
    const clamp = options.clamp !== false;
    const minPct = Number.isFinite(options.minPct) ? options.minPct : 1;
    const maxPct = Number.isFinite(options.maxPct) ? options.maxPct : 100;
    const total = Math.max(0, Number(quoteTotal) || 0);
    let pct = Number(depositPct);
    let amt = Number(depositAmt);
    if (!Number.isFinite(pct)) pct = 0;
    if (!Number.isFinite(amt)) amt = 0;
    if (origin === 'pct' || origin === 'total') {
      if (clamp) {
        if (pct > maxPct) pct = maxPct;
        if (pct < minPct && total > 0) pct = minPct;
      }
      amt = total > 0 ? (total * pct) / 100 : 0;
    } else {
      if (clamp && amt > total) amt = total;
      if (clamp && amt < 0) amt = 0;
      pct = total > 0 ? (amt / total) * 100 : 0;
      if (clamp) {
        if (pct > maxPct) pct = maxPct;
        if (pct < minPct && total > 0) pct = minPct;
        amt = total > 0 ? (total * pct) / 100 : 0;
      }
    }
    return {
      depositPct: Math.round(pct * 10) / 10,
      depositAmt: Math.round(amt * 100) / 100,
    };
  }

  function isPartialCashDeposit(paymentCfg) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    return cfg.strategy === 'partial' && cfg.depHandling === 'cash';
  }

  function hasConfigDepositReceipt(paymentCfg) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    return isPartialCashDeposit(cfg) && !!String(cfg.receiptId || '').trim();
  }

  function hasConfigFullCashReceipt(paymentCfg) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    return isCashInPersonFull(cfg) && !!String(cfg.receiptId || '').trim();
  }

  function getPaidAmount(quoteState, paymentCfg, quoteTotal) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    const p = quoteState.payment || {};
    const total = Math.max(0, Number(quoteTotal) || 0);
    let paid = 0;

    if (Number.isFinite(p.totalPaid) && p.totalPaid > 0) {
      paid = Number(p.totalPaid);
    }
    if (cfg.strategy === 'full' && p.fullRecordedAt) {
      paid = Math.max(paid, Number(p.fullAmount) || 0);
    }
    if (cfg.strategy === 'full' && hasConfigFullCashReceipt(cfg)) {
      paid = Math.max(paid, total);
    }
    if (cfg.strategy === 'partial') {
      if (p.depositRecordedAt) {
        paid = Math.max(paid, Number(p.depositAmount) || 0);
      }
      if (hasConfigDepositReceipt(cfg)) {
        paid = Math.max(paid, getDepositAmount(cfg, total));
      }
      if (p.balanceRecordedAt || p.fullRecordedAt) {
        paid = Math.max(paid, Number(p.totalPaid) || Number(p.fullAmount) || paid);
      }
    }

    return Math.min(Math.max(0, Math.round(paid * 100) / 100), total);
  }

  function getRemainingAmount(quoteState, paymentCfg, quoteTotal) {
    const total = Math.max(0, Number(quoteTotal) || 0);
    const paid = getPaidAmount(quoteState, paymentCfg, total);
    return Math.max(0, Math.round((total - paid) * 100) / 100);
  }

  function isQuotePriceConfirmed(quoteState, ticket) {
    if (quoteState.quotePriceConfirmed) return true;
    if (quoteState.clientConfirmed) return true;
    return !!ticket?.client_confirmed;
  }

  function isClientConfirmed(paymentCfg, quoteState, ticket) {
    return isQuotePriceConfirmed(quoteState, ticket);
  }

  function isDepositSatisfied(quoteState, paymentCfg, quoteTotal) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    if (cfg.strategy !== 'partial') return false;
    const depositDue = getDepositAmount(cfg, quoteTotal);
    const paid = getPaidAmount(quoteState, paymentCfg, quoteTotal);
    return paid >= depositDue - 0.01;
  }

  function isFullyPaid(quoteState, paymentCfg, quoteTotal) {
    return getRemainingAmount(quoteState, paymentCfg, quoteTotal) <= 0.01;
  }

  /** Payment gate to start production: net = none; partial = deposit; full = 100%. */
  function isPaymentComplete(quoteState, paymentCfg, quoteTotal) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    if (cfg.strategy === 'net') return true;
    const total = Math.max(0, Number(quoteTotal) || 0);
    const paid = getPaidAmount(quoteState, paymentCfg, total);
    if (cfg.strategy === 'full') {
      return paid >= total - 0.01;
    }
    if (cfg.strategy === 'partial') {
      return isDepositSatisfied(quoteState, paymentCfg, quoteTotal);
    }
    return false;
  }

  /** Full payment recorded while confirmation is required → treat as confirmed. */
  function shouldAutoConfirmOnFullPayment(paymentCfg, quoteState, quoteTotal) {
    if (isCashInPersonFull(paymentCfg)) return false;
    if (paymentCfg.requireClientConfirm === false) return false;
    if (paymentCfg.strategy !== 'full') return false;
    const paid = getPaidAmount(quoteState, paymentCfg, quoteTotal);
    return paid >= Number(quoteTotal) - 0.01;
  }

  /** Full payment with cash only — client pays in person; no remote quote confirmation. */
  function isCashInPersonFull(paymentCfg) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    if (cfg.strategy !== 'full') return false;
    const ch = cfg.channelsFull || [];
    return ch.length === 1 && ch[0] === 'cash';
  }

  function computeCheckout(paymentCfg, ticket, quoteState) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    const state = quoteState || emptyQuoteState();
    const quoteTotal = getQuoteTotal(ticket);
    const depositDue = cfg.strategy === 'partial' ? getDepositAmount(cfg, quoteTotal) : 0;
    const dueNow = cfg.strategy === 'full' ? quoteTotal : cfg.strategy === 'partial' ? depositDue : 0;
    const balance = cfg.strategy === 'partial' ? Math.max(0, quoteTotal - depositDue) : 0;
    const channels =
      cfg.strategy === 'full'
        ? cfg.channelsFull || PAY_DEFAULTS.channelsFull
        : cfg.channelsPartial || PAY_DEFAULTS.channelsPartial;

    const cashInPerson = isCashInPersonFull(cfg);
    const partialCashDeposit = isPartialCashDeposit(cfg);
    const needConfirm = !cashInPerson && !partialCashDeposit && cfg.requireClientConfirm !== false;
    const paymentOk = isPaymentComplete(state, cfg, quoteTotal);
    const depositPaid = cfg.strategy === 'partial' ? paymentOk : false;
    const fullyPaid = isFullyPaid(state, cfg, quoteTotal);
    const paid = getPaidAmount(state, cfg, quoteTotal);
    const remaining = getRemainingAmount(state, cfg, quoteTotal);
    const canCollectBalance =
      cfg.strategy === 'partial' && depositPaid && remaining > 0.01;
    const canCollectPayment =
      cfg.strategy === 'full'
        ? remaining > 0.01
        : cfg.strategy === 'partial'
          ? remaining > 0.01
          : false;
    const priceConfirmed = isQuotePriceConfirmed(state, ticket)
      || (cashInPerson && paymentOk)
      || (cashInPerson && hasConfigFullCashReceipt(cfg));
    const confirmed = priceConfirmed || shouldAutoConfirmOnFullPayment(cfg, state, quoteTotal);

    const priceStepDone =
      !needConfirm ||
      priceConfirmed ||
      shouldAutoConfirmOnFullPayment(cfg, state, quoteTotal);

    const steps = [
      {
        id: 'price',
        label: 'Quote price confirmed',
        done: priceStepDone,
        required: needConfirm,
        action: 'confirm-price',
      },
      {
        id: 'payment',
        label: cfg.strategy === 'partial' ? 'Deposit / payment' : 'Payment',
        done:
          cfg.strategy === 'net'
          || (cfg.strategy === 'partial' && depositPaid && priceStepDone)
          || (cfg.strategy === 'full' && fullyPaid && priceStepDone),
        required: cfg.strategy !== 'net',
        action: 'pay',
        remaining,
        paid,
      },
      {
        id: 'production',
        label: 'Ready for production',
        done: !!state.productionReleasedAt,
        required: false,
        action: 'release',
      },
    ];

    let canReleaseProduction = false;
    let blockReason = '';

    if (cfg.strategy === 'net' && !needConfirm) {
      canReleaseProduction = true;
    } else if (cfg.strategy === 'net' && needConfirm) {
      canReleaseProduction = confirmed;
      if (!confirmed) blockReason = 'Client confirmation is required before production.';
    } else if (cfg.strategy === 'partial') {
      const payGate = paymentOk;
      canReleaseProduction = priceStepDone && payGate;
      if (!priceStepDone && needConfirm) {
        blockReason = 'Confirm the quote price before production.';
      } else if (!payGate) {
        blockReason = `Deposit of ${formatMoney(dueNow)} is required before production. Balance can be paid while in production.`;
      }
    } else if (cfg.strategy === 'full') {
      const payGate = paymentOk;
      canReleaseProduction = cashInPerson ? payGate : priceStepDone && payGate;
      if (!cashInPerson && !priceStepDone && needConfirm) {
        blockReason = 'Confirm the quote price before production.';
      } else if (!payGate) {
        blockReason = cashInPerson
          ? `Record cash payment of ${formatMoney(quoteTotal)} (with receipt ID) before production.`
          : `Full payment of ${formatMoney(quoteTotal)} is required before production.`;
      }
    }

    if (canReleaseProduction && !state.productionReleasedAt) {
      // auto-ready visually; release is explicit optional step
    }

    const statusLabel = (() => {
      if (state.productionReleasedAt) {
        if (cfg.strategy === 'partial' && remaining > 0.01) return 'Active · balance due';
        if (cfg.strategy === 'partial') return 'Active · in production';
        return 'Active · in production';
      }
      if (!canReleaseProduction) {
        if (needConfirm && !confirmed) return 'Awaiting confirmation';
        if (cfg.strategy !== 'net' && !paymentOk) return 'Awaiting payment';
        return 'Blocked';
      }
      return 'Ready for production';
    })();

    return {
      quoteTotal,
      dueNow,
      balance,
      remaining,
      paid,
      depositPct: cfg.depositPct,
      depositDue,
      channels,
      channelLabels: channelLabels(channels),
      strategy: cfg.strategy,
      strategyLabel: strategyLabel(cfg.strategy),
      requireClientConfirm: needConfirm,
      cashInPerson,
      partialCashDeposit,
      priceConfirmed: priceStepDone,
      steps,
      canReleaseProduction,
      blockReason,
      statusLabel,
      paymentOk,
      depositPaid,
      fullyPaid,
      canCollectBalance,
      canCollectPayment,
      confirmed,
    };
  }

  function describeGatePreview(paymentCfg, ticket) {
    const cfg = { ...PAY_DEFAULTS, ...paymentCfg };
    const quoteTotal = getQuoteTotal(ticket);
    if (isCashInPersonFull(cfg)) {
      return `With current settings: Cash in person — record full payment (${formatMoney(quoteTotal)}) with receipt ID → production. No quote confirmation.`;
    }
    if (isPartialCashDeposit(cfg)) {
      const dep = getDepositAmount(cfg, quoteTotal);
      return `With current settings: Cash / offline deposit (${formatMoney(dep)}) with receipt ID → production starts. Client can pay remaining balance while in production.`;
    }
    const checkout = computeCheckout(cfg, ticket, emptyQuoteState());
    const parts = [];

    if (cfg.requireClientConfirm !== false) parts.push('Quote price must be confirmed');
    if (cfg.strategy === 'partial') {
      const dep = getDepositAmount(cfg, quoteTotal);
      parts.push(`${cfg.depositPct}% deposit (${formatMoney(dep)}) → production`);
      parts.push('remaining balance optional during production');
    } else if (cfg.strategy === 'full') {
      parts.push(`100% payment (${formatMoney(quoteTotal)}) → production`);
    } else {
      parts.push('No upfront payment (net terms) → production');
    }

    let extra = '';
    if (cfg.strategy === 'full' && cfg.requireClientConfirm === false) {
      extra = ' Production requires payment only (no confirmation step).';
    }

    return `With current settings: ${parts.join(' → ')}.${extra}`;
  }

  function validatePaymentConfig(cfg) {
    if (cfg.strategy === 'partial' && cfg.depHandling === 'cash' && !cfg.receiptId) {
      return { ok: false, message: 'Receipt ID is required when deposit collection is cash / offline.' };
    }
    if (cfg.strategy === 'full' && (cfg.channelsFull || []).includes('cash') && !cfg.receiptId) {
      return { ok: false, message: 'Receipt ID is required when payment method is cash.' };
    }
    if (cfg.requireClientConfirm && !isCashInPersonFull(cfg)) {
      if (cfg.quoteChannel === 'sms' && !cfg.destPhone) {
        return { ok: false, message: 'Phone destination is required.' };
      }
      if (cfg.quoteChannel === 'email' && !cfg.destPhone) {
        return { ok: false, message: 'Email destination is required.' };
      }
      if (cfg.quoteChannel === 'both' && (!cfg.destPhone || !cfg.destEmail)) {
        return { ok: false, message: 'Phone and email destinations are required for SMS + Email.' };
      }
    }
    return { ok: true };
  }

  global.PulseQuotePayment = {
    PAY_STORAGE_KEY,
    QUOTE_STATE_KEY,
    PREVIEW_QUOTE_KEY,
    PAY_CHANNELS,
    NET_TERMS_DAYS,
    normalizeNetTermsLabel,
    getNetTermsDaysFromLabel,
    normalizeFollowUpFreq,
    FOLLOW_UP_FREQ_VALUES,
    hasConfigDepositReceipt,
    hasConfigFullCashReceipt,
    applyFullCashCheckoutState,
    isPartialCashDeposit,
    PULSE_COMPANY,
    PAYMENT_REMITTANCE,
    PULSE_QUOTES,
    DEFAULT_QUOTE_TOKEN,
    PAY_DEFAULTS,
    formatMoney,
    getQuoteTotal,
    getDepositAmount,
    channelLabels,
    strategyLabel,
    emptyQuoteState,
    loadQuoteState,
    saveQuoteState,
    loadPaymentConfig,
    savePaymentConfig,
    resetQuoteCheckoutForPaymentConfig,
    getPreviewQuoteToken,
    setPreviewQuoteToken,
    getQuotePack,
    listQuoteOptions,
    syncDepositFromTotal,
    computeCheckout,
    describeGatePreview,
    validatePaymentConfig,
    getPaidAmount,
    getRemainingAmount,
    isDepositSatisfied,
    isFullyPaid,
    isQuotePriceConfirmed,
    shouldAutoConfirmOnFullPayment,
    isCashInPersonFull,
  };
})(typeof window !== 'undefined' ? window : globalThis);
