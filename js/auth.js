// ============================================================
// auth.js — Pulse Role-Based Access Control
// Session stored in sessionStorage: pulse_session
// ============================================================

const ROLE_CONFIG = {
  admin: {
    label: 'Admin',
    color: '#7c3aed',
    pages: ['all'],
    canEditAllTickets: true,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
  },
  'david-review': {
    label: 'David Review',
    color: '#2563eb',
    pages: ['dashboard','job-ticket','pricing-calculator','prepress','production-manager','operator-terminal','qc-checkout','shipping','machine-issues','organisation','admin'],
    canEditAllTickets: false,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: ['personnel','machines','dies','organisation','products','product-workflows','roles','qa-rules','configuration','backup'],
  },
  supervisor: {
    label: 'Supervisor',
    color: '#0891b2',
    pages: ['dashboard','job-ticket','pricing-calculator','prepress','production-manager','operator-terminal','qc-checkout','shipping','machine-issues','organisation'],
    canEditAllTickets: true,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: true,
  },
  'production-manager': {
    label: 'Production Manager',
    color: '#16a34a',
    pages: ['dashboard','job-ticket','prepress','production-manager','operator-terminal','qc-checkout','shipping','machine-issues','organisation','admin'],
    canEditAllTickets: false,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: ['machines','dies','organisation','products','product-workflows'],
  },
  'account-manager': {
    label: 'Account Manager',
    color: '#ea580c',
    pages: ['dashboard','job-ticket','pricing-calculator'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
  shipping: {
    label: 'Shipping',
    color: '#0d9488',
    pages: ['dashboard','shipping','qc-checkout'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
  operator: {
    label: 'Operator',
    color: '#6b7280',
    pages: ['dashboard','operator-terminal','machine-issues'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: true,
  },
  prepress: {
    label: 'Prepress',
    color: '#6b7280',
    pages: ['dashboard','prepress','job-ticket'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: false,
  },
  qc: {
    label: 'QC Inspector',
    color: '#0d9488',
    pages: ['dashboard','qc-checkout','shipping'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
  },
};

// ── Supabase auth detection ───────────────────────────────
/** True when production Supabase storage is configured (same check as login form). */
function _useSupabaseEmailLogin() {
  return typeof pulseUsesSupabaseStorage === 'function' && pulseUsesSupabaseStorage();
}

// Returns true when supabase-client.js loaded and sign-in is available
function _supaActive() {
  return _useSupabaseEmailLogin() && typeof window.supabaseSignIn === 'function';
}

// Derive email from display name for supabase.auth.signInWithPassword
// "Hayk Zohrabyan" → "hayk@bazaarprinting.com"
// "Admin"          → "admin@bazaarprinting.com"
// "QC Inspector"   → "qc@bazaarprinting.com"
function _getUserEmail(displayName) {
  const first = String(displayName || '').trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first}@bazaarprinting.com` : '';
}

/** Login email derived from personnel display name (Admin → Personnel). */
window.pulsePersonnelLoginEmail = _getUserEmail;

// ── Local-mode email → {name, role} mapping (IndexedDB dev only) ─────────────
// Supabase mode: login list + roles come from profiles table only.
const LOCAL_EMAIL_USERS = {
  'admin@bazaarprinting.com':    { name: 'Admin',            role: 'admin' },
  'hayk@bazaarprinting.com':     { name: 'Hayk Zohrabyan',   role: 'admin' },
  'david@bazaarprinting.com':    { name: 'David Zargaryan',  role: 'david-review' },
  'mauricio@bazaarprinting.com': { name: 'Mauricio',         role: 'supervisor' },
  'tigran@bazaarprinting.com':   { name: 'Tigran Zohrabyan', role: 'supervisor' },
  'mike@bazaarprinting.com':     { name: 'Mike',             role: 'production-manager' },
  'shipping@bazaarprinting.com': { name: 'Shipping',          role: 'shipping' },
  'hrach@bazaarprinting.com':    { name: 'Hrach',            role: 'prepress' },
  'qc@bazaarprinting.com':       { name: 'QC Inspector',     role: 'qc' },
  'arsen@bazaarprinting.com':    { name: 'Arsen',            role: 'operator' },
  'tuoyo@bazaarprinting.com':    { name: 'Tuoyo',            role: 'operator' },
  'abel@bazaarprinting.com':     { name: 'Abel',             role: 'operator' },
  'juan@bazaarprinting.com':     { name: 'Juan',             role: 'operator' },
  'vahe@bazaarprinting.com':     { name: 'Vahe',             role: 'operator' },
  'avgustin@bazaarprinting.com': { name: 'Avgustin',         role: 'operator' },
  'jaime@bazaarprinting.com':    { name: 'Jaime',            role: 'operator' },
  'lisandro@bazaarprinting.com': { name: 'Lisandro',         role: 'operator' },
  'adrian@bazaarprinting.com':   { name: 'Adrian',           role: 'operator' },
  'harry@bazaarprinting.com':    { name: 'Harry',            role: 'operator' },
};
const LOCAL_DEFAULT_PASSWORD = 'Pulse2026!';

// ── Session helpers ───────────────────────────────────────
function getSession() {
  try { return JSON.parse(sessionStorage.getItem('pulse_session') || 'null'); } catch(e) { return null; }
}
function setSession(name, role) {
  sessionStorage.setItem('pulse_session', JSON.stringify({ name, role, loginTime: Date.now() }));
}
function clearSession() {
  sessionStorage.removeItem('pulse_session');
}
function getCurrentUser() { return getSession(); }
function getCurrentRole() { return getSession()?.role || null; }
function getCurrentName() { return getSession()?.name || null; }

// ── Role permission overrides (in-memory cache; Supabase config is source of truth) ──
const PULSE_ROLE_OVERRIDES_KEY = 'pulse_role_overrides';
let _authRoleOverrides = {};

function pulseSetRoleOverridesCache(overrides) {
  _authRoleOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  _applyRoleOverrides(_authRoleOverrides);
}
window.pulseSetRoleOverridesCache = pulseSetRoleOverridesCache;

// ── Permission helpers ─────────────────────────────────────
function canAccessPage(pageId) {
  const role = getCurrentRole();
  if (!role) return false;

  // Admin always has full access — never block via overrides
  if (role === 'admin') return true;

  // Apply saved overrides (non-empty pages array only)
  const override = _authRoleOverrides[role];
  if (override && Array.isArray(override.pages) && override.pages.length > 0) {
    return override.pages.includes(pageId);
  }

  const config = ROLE_CONFIG[role];
  if (!config) return false;
  if (config.pages.includes('all')) return true;
  return config.pages.includes(pageId);
}

function canEditTicket(ticket) {
  const session = getSession();
  if (!session) return false;
  const config = ROLE_CONFIG[session.role];
  if (!config) return false;
  if (config.canEditAllTickets) return true;
  // Account managers can only edit their own tickets
  if (config.ownTicketsOnly) {
    const repName = ticket?.accountManager || ticket?.rep || '';
    return repName === session.name;
  }
  return false;
}

function isAdminOrSupervisor() {
  const role = getCurrentRole();
  return role === 'admin' || role === 'supervisor';
}

const EXTRA_AUTH_USERS = [
  // IndexedDB dev fallback only — not merged into login when Supabase is active.
  { name: 'Admin', role: 'admin', notes: '/admin' },
  { name: 'David Zargaryan', role: 'david-review', notes: 'David review access' },
  // QC Inspector — dedicated production QC login (name TBD, pending Hayk confirmation)
  { name: 'QC Inspector', role: 'qc', notes: 'Dedicated QC role — update name once Hayk confirms person' },
];

// ── Login modal ───────────────────────────────────────────
function _pulsePage(slug) {
  return (typeof pulsePage === 'function') ? pulsePage(slug) : `${slug}.html`;
}

// Role → landing page after login (PUL-679: V3 role home pages)
const ROLE_HOME_PAGE = {
  'admin':               _pulsePage('dashboard'),
  'supervisor':          _pulsePage('dashboard'),
  'prepress':            _pulsePage('prepress'),
  'production-manager':  _pulsePage('production-manager'),
  'qc':                  _pulsePage('qc-checkout'),
  'shipping':            _pulsePage('shipping'),
  'operator':            _pulsePage('operator-terminal'),
  'david-review':        _pulsePage('dashboard'),
};

function getDefaultPageForRole(role) {
  if (ROLE_HOME_PAGE[role]) return ROLE_HOME_PAGE[role];
  const config = ROLE_CONFIG[role];
  if (!config) return _pulsePage('dashboard');
  if (config.pages.includes('all')) return _pulsePage('dashboard');
  const first = config.pages[0] || 'dashboard';
  return _pulsePage(first);
}

const _inputStyle = (accent) => `
  width:100%;
  padding:11px 13px;
  border:1px solid #d1d5db;
  border-radius:10px;
  font-size:14px;
  font-family:inherit;
  color:#0f172a;
  background:#ffffff;
  box-sizing:border-box;
  outline:none;
  transition:border-color 0.15s, box-shadow 0.15s;
`;
const _labelStyle = `
  display:block;
  font-size:12px;
  font-weight:600;
  color:#334155;
  margin-bottom:6px;
  text-transform:uppercase;
  letter-spacing:.04em;
`;

/** Fill gaps only — IndexedDB dev fallback. Supabase uses profiles table only. */
function mergeLoginPeople(base) {
  let people = typeof dedupePeopleByName === 'function'
    ? dedupePeopleByName(base)
    : (Array.isArray(base) ? base : []);
  if (typeof pulseUsesSupabaseStorage === 'function' && pulseUsesSupabaseStorage()) {
    return people;
  }
  const has = new Set(people.map(p => p.name));
  const addIfMissing = (entry) => {
    if (!entry?.name || has.has(entry.name)) return;
    people.push({
      name: entry.name,
      role: entry.role || 'operator',
      userId: entry.userId != null ? String(entry.userId) : '',
    });
    has.add(entry.name);
  };
  if (typeof EXTRA_AUTH_USERS !== 'undefined') {
    EXTRA_AUTH_USERS.forEach(u => addIfMissing({ name: u.name, role: u.role, userId: '' }));
  }
  if (typeof LOCAL_EMAIL_USERS !== 'undefined') {
    Object.values(LOCAL_EMAIL_USERS).forEach(u => addIfMissing({ name: u.name, role: u.role, userId: '' }));
  }
  if (typeof OPERATOR_PROFILES !== 'undefined') {
    Object.entries(OPERATOR_PROFILES).forEach(([name, p]) => {
      addIfMissing({ name, role: p.role, userId: p.userId });
    });
  }
  return typeof dedupePeopleByName === 'function' ? dedupePeopleByName(people) : people;
}

/** Best User ID for a name from config.personnel (legacy cloud blob). */
async function _configPersonnelUserId(name) {
  try {
    if (typeof getConfig !== 'function') return '';
    const rec = await getConfig('personnel');
    const list = rec?.value ?? rec;
    if (!Array.isArray(list)) return '';
    const rows = list.filter(p => p.name === name);
    if (!rows.length) return '';
    const best = rows.sort((a, b) => {
      const score = p => (String(p?.userId || '').trim() ? 2 : 0) + (p.active !== false ? 1 : 0);
      return score(b) - score(a);
    })[0];
    return String(best?.userId || '').trim();
  } catch (_) {
    return '';
  }
}

/** Match login name + User ID against Supabase profiles (or IndexedDB personnel in dev). */
async function _resolvePersonForLogin(selectedName, enteredId, allPersonnel) {
  const supabaseMode = _useSupabaseEmailLogin();
  let merged = supabaseMode ? (allPersonnel || []) : mergeLoginPeople(allPersonnel);
  if (!supabaseMode) {
    const cfgUserId = await _configPersonnelUserId(selectedName);
    if (cfgUserId) {
      merged = merged.map(p =>
        p.name === selectedName && !String(p.userId || '').trim() ? { ...p, userId: cfgUserId } : p
      );
    }
  }

  const matches = merged.filter(p => p.name === selectedName);
  const byName = matches.length
    ? matches.sort((a, b) => {
        const score = p => (String(p.userId || '').trim() ? 2 : 0) + (p.active !== false ? 1 : 0);
        return score(b) - score(a);
      })[0]
    : null;

  if (byName) {
    const storedId = String(byName.userId || '').trim();
    if (!storedId) {
      return { ...byName, userId: enteredId, _autoSaveUserId: true };
    }
    if (storedId === enteredId) return byName;
    // Seeded Supabase accounts still use Pulse2026! as auth password while User ID is numeric.
    if (_supaActive() && enteredId !== storedId && enteredId === LOCAL_DEFAULT_PASSWORD) {
      return { ...byName, userId: storedId };
    }
  }

  return null;
}

/** Add admin / review logins to Personnel if missing (so dropdown + User ID validation stay in sync). */
async function ensureAuthPersonnelInDb() {
  if (typeof pulseUsesSupabaseStorage === 'function' && pulseUsesSupabaseStorage()) return;
  if (typeof getAllPersonnel !== 'function' || typeof addPersonnel !== 'function') return;
  const existing = await getAllPersonnel();
  const candidates = [];
  if (typeof EXTRA_AUTH_USERS !== 'undefined') {
    EXTRA_AUTH_USERS.forEach(u => candidates.push(u));
  }
  if (typeof LOCAL_EMAIL_USERS !== 'undefined') {
    Object.values(LOCAL_EMAIL_USERS).forEach(u => {
      if (!candidates.some(c => c.name === u.name)) candidates.push({ name: u.name, role: u.role, notes: '' });
    });
  }
  for (const u of candidates) {
    if (existing.some(p => p.name === u.name)) continue;
    const prof = typeof OPERATOR_PROFILES !== 'undefined' ? OPERATOR_PROFILES[u.name] : null;
    await addPersonnel({
      name: u.name,
      role: u.role,
      notes: u.notes || '',
      facility: prof?.facility || '16th-street',
      phone: '',
      active: true,
      userId: prof?.userId != null ? String(prof.userId) : '',
    });
  }
}

async function injectLoginModal() {
  const accent = '#2563eb';
  const supabaseMode = _useSupabaseEmailLogin();

  let loginFieldsHtml;
  let loginSubtitle;

  if (supabaseMode) {
    loginSubtitle = 'Sign in with your Supabase account email and password.';
    loginFieldsHtml = `
      <label style="${_labelStyle}">Email</label>
      <input
        id="loginEmail"
        type="email"
        autocomplete="username"
        placeholder="you@bazaarprinting.com"
        style="${_inputStyle(accent)}"
        onfocus="this.style.borderColor='${accent}'; this.style.boxShadow='0 0 0 3px rgba(37,99,235,0.15)';"
        onblur="this.style.borderColor='#d1d5db'; this.style.boxShadow='none';"
      >

      <label style="${_labelStyle}margin-top:16px;">Password</label>
      <input
        id="loginPassword"
        type="password"
        autocomplete="current-password"
        placeholder="Enter your password"
        style="${_inputStyle(accent)}"
        onfocus="this.style.borderColor='${accent}'; this.style.boxShadow='0 0 0 3px rgba(37,99,235,0.15)';"
        onblur="this.style.borderColor='#d1d5db'; this.style.boxShadow='none';"
      >`;
  } else {
    if (typeof dedupePersonnelByName === 'function') await dedupePersonnelByName();
    await ensureAuthPersonnelInDb();
    if (typeof dedupePersonnelByName === 'function') await dedupePersonnelByName();

    let people = [];
    try {
      if (typeof getAllPersonnel === 'function') {
        people = mergeLoginPeople(await getAllPersonnel()).filter(p => p.active !== false);
      }
    } catch (_) {}
    people.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const options = people.map(p =>
      `<option value="${p.name.replace(/"/g, '&quot;')}">${p.name}</option>`
    ).join('');

    loginSubtitle = 'Select your name and enter your User ID.';
    loginFieldsHtml = `
      <label style="${_labelStyle}">Name</label>
      <select id="loginName" style="${_inputStyle(accent)}cursor:pointer;"
        onfocus="this.style.borderColor='${accent}'; this.style.boxShadow='0 0 0 3px rgba(37,99,235,0.15)';"
        onblur="this.style.borderColor='#d1d5db'; this.style.boxShadow='none';"
      >
        <option value="">— Select your name —</option>
        ${options}
      </select>

      <label style="${_labelStyle}margin-top:16px;">User ID</label>
      <input
        id="loginUserId"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        placeholder="Enter your User ID"
        style="${_inputStyle(accent)}"
        onfocus="this.style.borderColor='${accent}'; this.style.boxShadow='0 0 0 3px rgba(37,99,235,0.15)';"
        onblur="this.style.borderColor='#d1d5db'; this.style.boxShadow='none';"
      >`;
  }

  const overlay = document.createElement('div');
  overlay.id = 'loginOverlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:#f3f4f6', 'z-index:99999',
    'display:flex', 'align-items:center', 'justify-content:center',
    'padding:24px', 'font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif',
  ].join(';') + ';';

  overlay.innerHTML = `
    <form id="loginForm" onsubmit="event.preventDefault(); submitLogin();" style="
      background:#ffffff; width:100%; max-width:420px;
      border-radius:16px;
      box-shadow:0 10px 30px rgba(15,23,42,0.08), 0 2px 6px rgba(15,23,42,0.04);
      padding:36px 32px 28px; box-sizing:border-box;
    ">
      <div style="display:flex;justify-content:center;margin-bottom:20px;">
        <img src="/pulse-logo.png" alt="Pulse" style="height:40px;display:block;" onerror="this.style.display='none';">
      </div>
      <h1 style="margin:0 0 6px;text-align:center;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">
        Sign in to Pulse
      </h1>
      <p style="margin:0 0 24px;text-align:center;font-size:13px;color:#64748b;">
        ${loginSubtitle}
      </p>

      ${loginFieldsHtml}

      <div id="loginError" role="alert" style="
        display:none; margin-top:14px; padding:9px 12px;
        background:#fef2f2; border:1px solid #fecaca;
        color:#b91c1c; border-radius:8px; font-size:13px;
      "></div>

      <button id="loginSubmitBtn" type="submit" style="
        width:100%; margin-top:20px; padding:12px 16px;
        background:${accent}; color:#ffffff; border:none;
        border-radius:10px; font-size:14px; font-weight:600;
        font-family:inherit; cursor:pointer;
        transition:background 0.15s, opacity 0.15s;
      "
        onmouseover="this.style.background='#1d4ed8';"
        onmouseout="this.style.background='${accent}';"
      >Sign In</button>

      <p style="margin:18px 0 0;text-align:center;font-size:12px;color:#94a3b8;">
        Contact your admin if you need access.
      </p>
    </form>
  `;
  document.body.appendChild(overlay);
  const firstField = document.getElementById(supabaseMode ? 'loginEmail' : 'loginName');
  if (firstField) firstField.focus();
}


function _showLoginError(message) {
  const err = document.getElementById('loginError');
  if (!err) return;
  err.style.display = 'block';
  err.textContent = message;
}

function _clearLoginError() {
  const err = document.getElementById('loginError');
  if (!err) return;
  err.style.display = 'none';
  err.textContent = '';
}

function _formatLoginError(err) {
  const msg = err?.message || String(err || '');
  if (/invalid login credentials/i.test(msg)) {
    return 'Incorrect email or password. Ask your admin to reset your account in Supabase if needed.';
  }
  if (/email not confirmed/i.test(msg)) {
    return 'Email not confirmed. Ask your admin to confirm the account in Supabase Auth.';
  }
  if (/database error querying schema/i.test(msg)) {
    return 'Auth account is misconfigured in Supabase (token columns). Ask your admin to run migration 047c.';
  }
  return msg || 'Sign-in failed. Check your email and password.';
}

function _finishLogin(resolvedName, resolvedRole) {
  setSession(resolvedName, resolvedRole);

  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.remove();

  const currentPage = document.body.dataset.page || '';
  if (resolvedRole === 'operator' && currentPage !== 'operator-terminal') {
    window.location.href = _pulsePage('operator-terminal');
    return;
  }
  if (resolvedRole === 'qc' && currentPage !== 'qc-checkout') {
    window.location.href = _pulsePage('qc-checkout');
    return;
  }
  if (currentPage && !canAccessPage(currentPage)) {
    window.location.href = getDefaultPageForRole(resolvedRole);
    return;
  }
  applyRoleAccess(currentPage);
  injectUserBadge();
  window.dispatchEvent(new CustomEvent('pulse:auth-ready'));
  if (typeof renderQueuePane === 'function') renderQueuePane();
}

async function _submitLoginSupabaseEmail(email, password) {
  await window.supabaseSignIn(email, password);
  const session = await window.supabaseGetSession();
  if (!session?.user?.id) throw new Error('Supabase session not established');
  let profile = await window.supabaseGetProfile();
  if (!profile && typeof window.supabaseEnsureProfile === 'function') {
    profile = await window.supabaseEnsureProfile();
  }
  if (!profile) {
    throw new Error(
      'Your account has no profiles row. Ask an admin to add you in Admin → Personnel or apply migration 039.'
    );
  }
  return {
    name: profile.display_name || email.split('@')[0],
    role: String(profile.role || 'operator').replace(/_/g, '-'),
  };
}

async function submitLogin() {
  _clearLoginError();

  const btn = document.getElementById('loginSubmitBtn');
  const setLoading = (loading) => {
    if (!btn) return;
    btn.disabled = loading;
    btn.style.opacity = loading ? '0.7' : '1';
    btn.textContent = loading ? 'Signing in…' : 'Sign In';
  };

  // ── Supabase: email + password (direct auth.users sign-in) ──
  if (_useSupabaseEmailLogin()) {
    const email = (document.getElementById('loginEmail')?.value || '').trim().toLowerCase();
    const password = document.getElementById('loginPassword')?.value || '';
    if (!email) { _showLoginError('Please enter your email.'); return; }
    if (!password) { _showLoginError('Please enter your password.'); return; }
    if (typeof window.supabaseSignIn !== 'function') {
      _showLoginError(
        'Supabase login is not ready. Hard refresh (Cmd+Shift+R). ' +
        'If this persists, check that pulse-config.js and supabase-client.js load before auth.js.'
      );
      return;
    }

    setLoading(true);
    try {
      const { name, role } = await _submitLoginSupabaseEmail(email, password);
      _finishLogin(name, role);
    } catch (err) {
      console.warn('[Pulse/Auth] Supabase sign-in failed:', err);
      _showLoginError(_formatLoginError(err));
    } finally {
      setLoading(false);
    }
    return;
  }

  // ── IndexedDB dev: name + User ID ──
  const selectedName = (document.getElementById('loginName')?.value || '').trim();
  const enteredId   = (document.getElementById('loginUserId')?.value || '').trim();

  if (!selectedName) { _showLoginError('Please select your name.'); return; }
  if (!enteredId)    { _showLoginError('Please enter your User ID.'); return; }

  let personRecord = null;
  let allPersonnel = [];
  try {
    if (typeof getAllPersonnel === 'function') {
      allPersonnel = await getAllPersonnel();
    }
  } catch (_) {}

  personRecord = await _resolvePersonForLogin(selectedName, enteredId, allPersonnel);
  if (personRecord?._autoSaveUserId && typeof updatePersonnel === 'function') {
    try {
      await updatePersonnel(personRecord.id, { ...personRecord, userId: enteredId });
    } catch (_) {}
    delete personRecord._autoSaveUserId;
  }

  if (!personRecord) {
    _showLoginError('Incorrect User ID. Contact your admin if you need help.');
    return;
  }

  _finishLogin(
    personRecord.name,
    String(personRecord.role || 'operator').replace(/_/g, '-')
  );
}

// ── Nav user badge + logout ───────────────────────────────
function injectUserBadge() {
  const session = getSession();

  // If a page provides its own Sign Out button, wire it up.
  const signOutBtn = document.getElementById('topNavSignOutBtn');
  if (signOutBtn) {
    signOutBtn.style.display = session ? 'inline-flex' : 'none';
    if (session && !signOutBtn.dataset.pulseBound) {
      signOutBtn.dataset.pulseBound = '1';
      signOutBtn.addEventListener('click', logoutUser);
    }
  }

  if (!session) {
    document.getElementById('pulseFloatingUser')?.remove();
    return;
  }

  const cfg = ROLE_CONFIG[session.role] || { label: session.role, color: '#6b7280' };
  const firstName = String(session.name || '').split(' ')[0] || 'User';

  // Page with a dedicated nav slot: render badge there (+ a sign-out button).
  const userSlot = document.getElementById('topNavUserSlot');
  if (userSlot) {
    document.getElementById('userBadge')?.remove();
    const badge = document.createElement('div');
    badge.id = 'userBadge';
    badge.className = 'user-badge';
    badge.innerHTML = `
      <span class="user-badge-dot" style="background:${cfg.color};"></span>
      <span class="user-badge-name">${firstName}</span>
      <span class="user-badge-role" style="color:${cfg.color};">${cfg.label.toUpperCase()}</span>
    `;
    userSlot.appendChild(badge);
    if (!signOutBtn && !document.getElementById('pulseSlotSignOut')) {
      const b = document.createElement('button');
      b.id = 'pulseSlotSignOut';
      b.type = 'button';
      b.textContent = '⎋ Sign Out';
      b.style.cssText = 'margin-left:8px;border:none;background:#ef4444;color:#fff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;';
      b.addEventListener('click', logoutUser);
      userSlot.appendChild(b);
    }
    return;
  }

  // No nav slot / no placeholder: build a self-contained floating control so
  // every page has a visible Log Out button regardless of its layout.
  if (signOutBtn) return; // page already shows its own button somewhere
  let pill = document.getElementById('pulseFloatingUser');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'pulseFloatingUser';
    pill.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9000',
      'display:flex', 'align-items:center', 'gap:10px',
      'background:#ffffff', 'border:1px solid #e2e8f0', 'border-radius:999px',
      'padding:6px 8px 6px 14px', 'box-shadow:0 4px 14px rgba(0,0,0,0.12)',
      'font-family:Inter,system-ui,-apple-system,sans-serif',
    ].join(';');
    document.body.appendChild(pill);
  }
  pill.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:#111827;white-space:nowrap;">
      <span style="width:8px;height:8px;border-radius:50%;background:${cfg.color};"></span>
      ${firstName}
      <span style="color:${cfg.color};font-weight:700;font-size:11px;letter-spacing:0.04em;">${cfg.label.toUpperCase()}</span>
    </span>
    <button id="pulseFloatingSignOut" type="button"
      style="border:none;background:#ef4444;color:#fff;font-size:12px;font-weight:600;padding:7px 14px;border-radius:999px;cursor:pointer;white-space:nowrap;">⎋ Sign Out</button>
  `;
  document.getElementById('pulseFloatingSignOut')?.addEventListener('click', logoutUser);
}

async function logoutUser() {
  if (_supaActive()) {
    try { await window.supabaseSignOut(); } catch (_) {}
  }
  if (typeof clearAllJobTicketEditUnlocks === 'function') clearAllJobTicketEditUnlocks();
  clearSession();
  location.reload();
}

// ── Page access control ───────────────────────────────────
function applyRoleAccess(pageId) {
  const session = getSession();
  const role = session?.role;
  const config = ROLE_CONFIG[role] || {};
  const allowedPages = config.pages || [];

  // Hide admin nav item for non-admins/supervisors
  document.querySelectorAll('.nav-admin-only').forEach(el => {
    el.style.display = (config.canViewAdmin) ? '' : 'none';
  });
  // Hide production nav items for account managers/operators
  document.querySelectorAll('.nav-production-only').forEach(el => {
    el.style.display = (config.canViewProduction) ? '' : 'none';
  });
  // Hide operator nav items for account managers
  document.querySelectorAll('.nav-operator-only').forEach(el => {
    el.style.display = (config.canViewOperator) ? '' : 'none';
  });

  document.querySelectorAll('.nav-link[data-page-id]').forEach(el => {
    const targetPage = el.dataset.pageId;
    const canSee = allowedPages.includes('all') || allowedPages.includes(targetPage);
    el.style.display = canSee ? '' : 'none';
  });

  // Organisation: top-level for roles without Admin menu; under Admin dropdown when canViewAdmin
  document.querySelectorAll('.nav-organisation-standalone').forEach(el => {
    const canSee = allowedPages.includes('all') || allowedPages.includes('organisation');
    const showStandalone = canSee && !config.canViewAdmin;
    el.style.display = showStandalone ? '' : 'none';
  });

  if (pageId === 'admin') {
    let allowedTabs = config.adminTabs || (config.canViewAdmin ? 'all' : []);
    if (allowedTabs !== 'all' && config.canViewAdmin && Array.isArray(allowedTabs) && !allowedTabs.includes('backup')) {
      allowedTabs = [...allowedTabs, 'backup'];
    }
    if (allowedTabs !== 'all') {
      const allowed = Array.isArray(allowedTabs) ? allowedTabs : [];
      document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        const canSee = allowed.includes(btn.dataset.tab);
        btn.style.display = canSee ? '' : 'none';
      });
      document.querySelectorAll('.admin-content > .tab-pane[id^="tab-"]').forEach(pane => {
        const tabId = pane.id.replace('tab-', '');
        const canSee = allowed.includes(tabId);
        if (!canSee) {
          pane.style.display = 'none';
          pane.classList.remove('active');
        } else {
          pane.style.removeProperty('display');
        }
      });
      const first = allowed[0];
      if (first && typeof switchTab === 'function') {
        setTimeout(() => switchTab(first), 0);
      }
    } else {
      document.querySelectorAll('.admin-content > .tab-pane[id^="tab-"]').forEach(pane => {
        pane.style.removeProperty('display');
      });
      document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        btn.style.removeProperty('display');
      });
    }
  }
}

// ── Job ticket: lock fields if not authorized ─────────────
function applyTicketEditLock(ticket) {
  if (canEditTicket(ticket)) return; // allowed — do nothing
  // Read-only mode
  document.querySelectorAll('.jt-container input, .jt-container select, .jt-container textarea').forEach(el => {
    el.disabled = true;
    el.style.opacity = '0.7';
    el.style.cursor = 'not-allowed';
  });
  // Hide save buttons
  document.querySelectorAll('.save-bar button').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.title = 'You can only edit your own job tickets';
  });
  // Show read-only banner
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#fef9c3;border:1px solid #fcd34d;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#92400e;display:flex;align-items:center;gap:8px;';
  banner.innerHTML = '🔒 <strong>Read-only.</strong> This ticket belongs to ' + (ticket?.accountManager || 'another rep') + '. You can view but not edit.';
  const header = document.querySelector('.jt-header');
  if (header?.nextSibling) header.parentNode.insertBefore(banner, header.nextSibling);
}

// ── Init — called on every page load ─────────────────────
// Apply any saved role-permission overrides to ROLE_CONFIG so access checks use the latest settings.
// Reads from localStorage (written by admin "Save Changes") for instant, sync access.
function _applyRoleOverrides(overrides) {
  try {
    if (!overrides) return;
    Object.entries(overrides).forEach(([role, ov]) => {
      if (!ROLE_CONFIG[role]) return;
      if (role === 'admin') return; // admin always retains pages:['all'] — never override
      if (Array.isArray(ov.pages) && ov.pages.length > 0) ROLE_CONFIG[role].pages = [...ov.pages];
      ['canEditAllTickets','canViewAdmin','canViewProduction','canViewOperator'].forEach(k => {
        if (k in ov) ROLE_CONFIG[role][k] = ov[k];
      });
      if (Array.isArray(ov.adminTabs) && ov.adminTabs.length > 0) {
        ROLE_CONFIG[role].adminTabs = [...ov.adminTabs];
      }
      if (ROLE_CONFIG[role].canViewAdmin) {
        const tabs = ROLE_CONFIG[role].adminTabs;
        if (tabs !== 'all' && Array.isArray(tabs) && !tabs.includes('backup')) {
          ROLE_CONFIG[role].adminTabs = [...tabs, 'backup'];
        }
      }
    });
  } catch (_) {}
}
// Apply in-memory overrides (populated from Supabase on initAuth)
_applyRoleOverrides(_authRoleOverrides);

// Load role permissions from Supabase config (in-memory cache for sync access checks)
async function _syncRolePermissionsFromDB() {
  try {
    if (typeof getConfig !== 'function') return;
    const cfg = await getConfig('rolePermissions');
    const overrides = cfg?.value ?? cfg;
    if (!overrides || typeof overrides !== 'object') return;
    pulseSetRoleOverridesCache(overrides);
  } catch (_) {}
}

async function initAuth(pageId) {
  document.body.dataset.page = pageId;

  if (_supaActive()) {
    // ── Supabase mode: check for an existing valid session ──
    const loader = _injectAuthLoader();
    try {
      const supaSession = await window.supabaseGetSession();
      if (supaSession) {
        let profile = await window.supabaseGetProfile();
        if (!profile && typeof window.supabaseEnsureProfile === 'function') {
          profile = await window.supabaseEnsureProfile();
        }
        if (profile) {
          // DB role uses underscores; ROLE_CONFIG uses hyphens
          const role = String(profile.role || 'operator').replace(/_/g, '-');
          setSession(profile.display_name, role);
          // Sync role permissions from DB (non-blocking — updates ROLE_CONFIG + localStorage)
          _syncRolePermissionsFromDB().catch(() => {});
        }
      } else {
        // No valid Supabase session — clear any stale sessionStorage so login is required.
        // Without this, auth.uid() stays null and all Supabase RLS queries return empty.
        clearSession();
      }
    } catch (e) {
      console.error('[Pulse/Auth] Session check error:', e);
      // On error also clear stale session to avoid ghost-login state
      clearSession();
    } finally {
      loader.remove();
    }
  }

  let session = getSession();
  if (!session) {
    // No session — show the email/password login modal
    // (works for both Supabase and local modes; submitLogin branches internally).
    await injectLoginModal();
    return;
  }

  if (typeof getConfig === 'function') {
    await _syncRolePermissionsFromDB();
  }

  // Check page access
  if (!canAccessPage(pageId) && pageId !== 'operator-terminal') {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;font-family:Inter,sans-serif;">
        <div style="text-align:center;padding:40px;">
          <div style="font-size:48px;margin-bottom:16px;">🔒</div>
          <h2 style="margin:0 0 8px;color:#1e293b;">Access Restricted</h2>
          <p style="color:#6b7280;margin-bottom:20px;">Your role (${ROLE_CONFIG[session.role]?.label || session.role}) does not have access to this page.</p>
          <button onclick="logoutUser()" style="padding:8px 20px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">Switch User</button>
          <a href="${typeof pulsePage === 'function' ? pulsePage('dashboard') : '/pages/dashboard.html'}" style="display:block;margin-top:12px;color:#6b7280;font-size:13px;">← Back to Dashboard</a>
        </div>
      </div>`;
    return;
  }

  applyRoleAccess(pageId);
  injectUserBadge();
  window.dispatchEvent(new CustomEvent('pulse:auth-ready'));
}

function _injectAuthLoader() {
  const el = document.createElement('div');
  el.id = 'authLoader';
  el.style.cssText = 'position:fixed;inset:0;background:#f8fafc;z-index:99998;display:flex;align-items:center;justify-content:center;';
  el.innerHTML = '<div style="text-align:center;"><img src="/pulse-logo.png" alt="Pulse" style="height:36px;margin:0 auto 10px;display:block;"><div style="color:#64748b;font-size:13px;">Checking session…</div></div>';
  document.body.appendChild(el);
  return el;
}
