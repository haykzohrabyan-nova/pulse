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
    adminTabs: ['personnel','machines','dies','organisation','payment','crm-quote','products','product-workflows','roles','qa-rules','settings','backup'],
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
// Returns true only when supabase-client.js loaded and PULSE_STORAGE_BACKEND='supabase'
function _supaActive() {
  return typeof window.supabaseSignIn === 'function';
}

// Derive email from display name for supabase.auth.signInWithPassword
// "Hayk Zohrabyan" → "hayk@bazaar-admin.com"
// "Admin"          → "admin@bazaar-admin.com"
// "QC Inspector"   → "qc@bazaar-admin.com"
function _getUserEmail(displayName) {
  const first = String(displayName || '').trim().split(/\s+/)[0].toLowerCase();
  return `${first}@bazaar-admin.com`;
}

// ── Local-mode email → {name, role} mapping ───────────────
// Used when Supabase is NOT active. Local password is shared (Pulse2026!) until
// each person rotates it, but gating still happens via the email lookup so the
// UI is consistent with the Supabase form.
const LOCAL_EMAIL_USERS = {
  'admin@bazaar-admin.com':    { name: 'Admin',            role: 'admin' },
  'hayk@bazaar-admin.com':     { name: 'Hayk Zohrabyan',   role: 'admin' },
  'david@bazaar-admin.com':    { name: 'David Zargaryan',  role: 'david-review' },
  'mauricio@bazaar-admin.com': { name: 'Mauricio',         role: 'supervisor' },
  'tigran@bazaar-admin.com':   { name: 'Tigran Zohrabyan', role: 'supervisor' },
  'mike@bazaar-admin.com':     { name: 'Mike',             role: 'production-manager' },
  'shipping@bazaar-admin.com': { name: 'Shipping',          role: 'shipping' },
  'hrach@bazaar-admin.com':    { name: 'Hrach',            role: 'prepress' },
  'qc@bazaar-admin.com':       { name: 'QC Inspector',     role: 'qc' },
  'arsen@bazaar-admin.com':    { name: 'Arsen',            role: 'operator' },
  'tuoyo@bazaar-admin.com':    { name: 'Tuoyo',            role: 'operator' },
  'abel@bazaar-admin.com':     { name: 'Abel',             role: 'operator' },
  'juan@bazaar-admin.com':     { name: 'Juan',             role: 'operator' },
  'vahe@bazaar-admin.com':     { name: 'Vahe',             role: 'operator' },
  'avgustin@bazaar-admin.com': { name: 'Avgustin',         role: 'operator' },
  'jaime@bazaar-admin.com':    { name: 'Jaime',            role: 'operator' },
  'lisandro@bazaar-admin.com': { name: 'Lisandro',         role: 'operator' },
  'adrian@bazaar-admin.com':   { name: 'Adrian',           role: 'operator' },
  'harry@bazaar-admin.com':    { name: 'Harry',            role: 'operator' },
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

// ── Role permission overrides (written by admin, cached in localStorage) ──
// Loaded once synchronously so canAccessPage stays synchronous.
const PULSE_ROLE_OVERRIDES_KEY = 'pulse_role_overrides';
let _authRoleOverrides = {};
(function _loadRoleOverrides() {
  try {
    const raw = localStorage.getItem(PULSE_ROLE_OVERRIDES_KEY);
    if (raw) _authRoleOverrides = JSON.parse(raw) || {};
  } catch (_) {}
})();

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
  { name: 'Admin', role: 'admin', notes: '/admin' },
  { name: 'David Zargaryan', role: 'david-review', notes: 'David review access' },
  // QC Inspector — dedicated production QC login (name TBD, pending Hayk confirmation)
  { name: 'QC Inspector', role: 'qc', notes: 'Dedicated QC role — update name once Hayk confirms person' },
];

// ── Login modal ───────────────────────────────────────────
// Role → landing page after login (PUL-679: V3 role home pages)
const ROLE_HOME_PAGE = {
  'admin':               'dashboard.html',
  'supervisor':          'dashboard.html',
  'prepress':            'prepress.html',
  'production-manager':  'production-manager.html',
  'qc':                  'qc-checkout.html',
  'shipping':            'shipping.html',
  'operator':            'operator-terminal.html',
  'david-review':        'dashboard.html',
};

function getDefaultPageForRole(role) {
  if (ROLE_HOME_PAGE[role]) return ROLE_HOME_PAGE[role];
  const config = ROLE_CONFIG[role];
  if (!config) return 'dashboard.html';
  if (config.pages.includes('all')) return 'dashboard.html';
  const first = config.pages[0] || 'dashboard';
  return `${first}.html`;
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

/** Fill gaps only — names missing from Personnel (no duplicate rows). */
function mergeLoginPeople(base) {
  let people = typeof dedupePeopleByName === 'function'
    ? dedupePeopleByName(base)
    : (Array.isArray(base) ? base : []);
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

/** Add admin / review logins to Personnel if missing (so dropdown + User ID validation stay in sync). */
async function ensureAuthPersonnelInDb() {
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

  if (typeof dedupePersonnelByName === 'function') await dedupePersonnelByName();
  await ensureAuthPersonnelInDb();
  if (typeof dedupePersonnelByName === 'function') await dedupePersonnelByName();

  // Primary source: Admin → Personnel; merge only missing static accounts.
  let people = [];
  try {
    if (typeof getAllPersonnel === 'function') {
      people = (await getAllPersonnel()).filter(p => p.active !== false);
    }
  } catch (_) {}

  people = mergeLoginPeople(people);
  people.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const options = people.map(p =>
    `<option value="${p.name.replace(/"/g, '&quot;')}">${p.name}</option>`
  ).join('');

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
        <img src="pulse-logo.png" alt="Pulse" style="height:40px;display:block;" onerror="this.style.display='none';">
      </div>
      <h1 style="margin:0 0 6px;text-align:center;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">
        Sign in to Pulse
      </h1>
      <p style="margin:0 0 24px;text-align:center;font-size:13px;color:#64748b;">
        Select your name and enter your User ID.
      </p>

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
      >

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
  const nameSelect = document.getElementById('loginName');
  if (nameSelect) nameSelect.focus();
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

async function submitLogin() {
  _clearLoginError();
  const selectedName = (document.getElementById('loginName')?.value || '').trim();
  const enteredId   = (document.getElementById('loginUserId')?.value || '').trim();

  if (!selectedName) { _showLoginError('Please select your name.'); return; }
  if (!enteredId)    { _showLoginError('Please enter your User ID.'); return; }

  const btn = document.getElementById('loginSubmitBtn');
  const setLoading = (loading) => {
    if (!btn) return;
    btn.disabled = loading;
    btn.style.opacity = loading ? '0.7' : '1';
    btn.textContent = loading ? 'Signing in…' : 'Sign In';
  };

  // ── Validate against personnel records ────────────────
  let personRecord = null;
  let allPersonnel = [];
  try {
    if (typeof getAllPersonnel === 'function') {
      allPersonnel = await getAllPersonnel();
    }
  } catch (_) {}

  if (allPersonnel.length) {
    const matches = allPersonnel.filter(p => p.name === selectedName);
    const byName = matches.length
      ? matches.sort((a, b) => {
          const score = p => (String(p.userId || '').trim() ? 2 : 0) + (p.active !== false ? 1 : 0);
          return score(b) - score(a);
        })[0]
      : null;
    if (byName) {
      const storedId = String(byName.userId || '').trim();
      if (!storedId) {
        // No userId set yet — allow login and auto-save the entered ID
        personRecord = { ...byName, userId: enteredId };
        try { await updatePersonnel(byName.id, { ...byName, userId: enteredId }); } catch (_) {}
      } else if (storedId === enteredId) {
        personRecord = byName;
      }
    }
  }

  // Fallback: OPERATOR_PROFILES (static, always available)
  if (!personRecord && typeof OPERATOR_PROFILES !== 'undefined') {
    const profile = OPERATOR_PROFILES[selectedName];
    if (profile) {
      const storedId = String(profile.userId || '').trim();
      if (!storedId || storedId === enteredId) {
        personRecord = { name: selectedName, role: profile.role, userId: enteredId };
      }
    }
  }

  // Fallback: LOCAL_EMAIL_USERS for admin accounts (Hayk, David, etc.)
  if (!personRecord) {
    const localUser = Object.values(LOCAL_EMAIL_USERS).find(u => u.name === selectedName);
    if (localUser && (enteredId === LOCAL_DEFAULT_PASSWORD || !enteredId)) {
      personRecord = { name: localUser.name, role: localUser.role, userId: enteredId };
    }
  }

  if (!personRecord) {
    _showLoginError('Incorrect User ID. Contact your admin if you need help.');
    return;
  }

  let resolvedName = personRecord.name;
  let resolvedRole = String(personRecord.role || 'operator').replace(/_/g, '-');

  if (_supaActive()) {
    // ── Supabase: require a real auth session in cloud mode ──
    setLoading(true);
    try {
      const email = _getUserEmail(selectedName);
      let signedIn = false;
      try {
        await window.supabaseSignIn(email, enteredId);
        signedIn = true;
      } catch (_) {
        // Fallback for seeded users (shared temporary password).
        if (LOCAL_DEFAULT_PASSWORD && enteredId !== LOCAL_DEFAULT_PASSWORD) {
          await window.supabaseSignIn(email, LOCAL_DEFAULT_PASSWORD);
          signedIn = true;
        }
      }
      if (!signedIn) throw new Error('Supabase sign-in failed');
      const session = await window.supabaseGetSession();
      if (!session?.user?.id) throw new Error('Supabase session not established');
      const profile = await window.supabaseGetProfile();
      if (profile) {
        const dbRole = String(profile.role || resolvedRole).replace(/_/g, '-');
        const personnelRole = String(personRecord.role || '').replace(/_/g, '-');
        if (personnelRole && dbRole !== personnelRole) {
          console.warn(
            `[Pulse] Personnel role (${personnelRole}) differs from profiles.role (${dbRole}). Database permissions use profiles.role.`
          );
        }
        resolvedRole = dbRole;
        resolvedName = profile.display_name || resolvedName;
      }
    } catch (_) {
      _showLoginError('Cloud login failed. Use your Supabase password (or Pulse2026! if not changed yet).');
      return;
    } finally {
      setLoading(false);
    }
  }

  setSession(resolvedName, resolvedRole);

  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.remove();

  const currentPage = document.body.dataset.page || '';
  if (resolvedRole === 'operator' && currentPage !== 'operator-terminal') {
    window.location.href = 'operator-terminal.html';
    return;
  }
  if (resolvedRole === 'qc' && currentPage !== 'qc-checkout') {
    window.location.href = 'qc-checkout.html';
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

// ── Nav user badge + logout ───────────────────────────────
function injectUserBadge() {
  const session = getSession();
  if (!session) return;
  const existing = document.getElementById('userBadge');
  if (existing) existing.remove();
  const cfg = ROLE_CONFIG[session.role] || { label: session.role, color: '#6b7280' };
  const badge = document.createElement('div');
  badge.id = 'userBadge';
  badge.className = 'user-badge';
  badge.innerHTML = `
    <span class="user-badge-dot" style="background:${cfg.color};"></span>
    <span class="user-badge-name">${session.name.split(' ')[0]}</span>
    <span class="user-badge-role" style="color:${cfg.color};">${cfg.label.toUpperCase()}</span>
    <button class="user-badge-logout" onclick="logoutUser()" title="Log out">✕</button>
  `;
  const userSlot = document.getElementById('topNavUserSlot');
  if (userSlot) userSlot.appendChild(badge);
  else {
    const navLinks = document.querySelector('.top-nav .nav-links');
    if (navLinks) navLinks.appendChild(badge);
    else document.body.appendChild(badge);
  }
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
function _applyRoleOverrides() {
  try {
    const raw = localStorage.getItem('pulse_role_overrides');
    if (!raw) return;
    const overrides = JSON.parse(raw);
    const allPageKeys = ['dashboard','job-ticket','pricing-calculator','prepress','production-manager',
      'operator-terminal','qc-checkout','machine-issues','shipping','organisation','admin'];
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
_applyRoleOverrides();

async function initAuth(pageId) {
  document.body.dataset.page = pageId;

  if (_supaActive()) {
    // ── Supabase mode: check for an existing valid session ──
    const loader = _injectAuthLoader();
    try {
      const session = await window.supabaseGetSession();
      if (session) {
        const profile = await window.supabaseGetProfile();
        if (profile) {
          // DB role uses underscores; ROLE_CONFIG uses hyphens
          const role = String(profile.role || 'operator').replace(/_/g, '-');
          setSession(profile.display_name, role);
        }
      }
    } catch (e) {
      console.error('[Pulse/Auth] Session check error:', e);
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

  // Check page access
  if (!canAccessPage(pageId) && pageId !== 'operator-terminal') {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;font-family:Inter,sans-serif;">
        <div style="text-align:center;padding:40px;">
          <div style="font-size:48px;margin-bottom:16px;">🔒</div>
          <h2 style="margin:0 0 8px;color:#1e293b;">Access Restricted</h2>
          <p style="color:#6b7280;margin-bottom:20px;">Your role (${ROLE_CONFIG[session.role]?.label || session.role}) does not have access to this page.</p>
          <button onclick="logoutUser()" style="padding:8px 20px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">Switch User</button>
          <a href="dashboard.html" style="display:block;margin-top:12px;color:#6b7280;font-size:13px;">← Back to Dashboard</a>
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
  el.innerHTML = '<div style="text-align:center;"><img src="pulse-logo.png" alt="Pulse" style="height:36px;margin:0 auto 10px;display:block;"><div style="color:#64748b;font-size:13px;">Checking session…</div></div>';
  document.body.appendChild(el);
  return el;
}
