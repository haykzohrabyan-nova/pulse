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
    pages: ['dashboard','job-ticket','pricing-calculator','prepress','production-manager','operator-terminal','qc-checkout','machine-issues','admin'],
    canEditAllTickets: false,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: ['personnel','dies','machines'],
  },
  supervisor: {
    label: 'Supervisor',
    color: '#0891b2',
    pages: ['dashboard','job-ticket','pricing-calculator','quotes','orders','prepress','production-manager','qc-checkout','application-dept','rep-tasks','instagram-leads'],
    canEditAllTickets: true,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: false,
  },
  'production-manager': {
    label: 'Production Manager',
    color: '#16a34a',
    pages: ['dashboard','prepress','production-manager','operator-terminal','qc-checkout','admin'],
    canEditAllTickets: false,
    canViewAdmin: true,
    canViewProduction: true,
    canViewOperator: true,
    adminTabs: ['dies','inventory'],
  },
  'account-manager': {
    label: 'Account Manager',
    color: '#d97706',
    pages: ['dashboard','job-ticket','pricing-calculator','quotes','orders','invoices','shipping','application-dept','jm-dashboard','rep-tasks','leads','proofs','instagram-leads'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: false,
    ownTicketsOnly: true,
  },
  operator: {
    label: 'Operator',
    color: '#6b7280',
    pages: ['dashboard','operator-terminal'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: true,
  },
  designer: {
    label: 'Designer',
    color: '#8b5cf6',
    pages: ['dashboard','job-ticket','proofs','leads'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: false,
    canViewOperator: false,
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
  'hayk@bazaar-admin.com':     { name: 'Hayk Zohrabyan',   role: 'admin' },
  'david@bazaar-admin.com':    { name: 'David Zargaryan',  role: 'david-review' },
  'mauricio@bazaar-admin.com': { name: 'Mauricio',         role: 'supervisor' },
  'tigran@bazaar-admin.com':   { name: 'Tigran Zohrabyan', role: 'supervisor' },
  'mike@bazaar-admin.com':     { name: 'Mike',             role: 'production-manager' },
  'gary@bazaar-admin.com':     { name: 'Gary Gharibyan',   role: 'account-manager' },
  'ernesto@bazaar-admin.com':  { name: 'Ernesto Flores',   role: 'account-manager' },
  'bob@bazaar-admin.com':      { name: 'Bob Werner',       role: 'account-manager' },
  'tiko@bazaar-admin.com':     { name: 'Tiko',             role: 'account-manager' },
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
  'marianna@bazaar-admin.com': { name: 'Marianna',         role: 'designer' },
  'harut@bazaar-admin.com':    { name: 'Harut',            role: 'designer' },
  'taron@bazaar-admin.com':    { name: 'Taron',            role: 'designer' },
  'chris@bazaar-admin.com':    { name: 'Chris',            role: 'designer' },
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

// ── Permission helpers ─────────────────────────────────────
function canAccessPage(pageId) {
  const role = getCurrentRole();
  if (!role) return false;
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
  { name: 'David Zargaryan', role: 'david-review', notes: 'David review access' },
  // QC Inspector — dedicated production QC login (name TBD, pending Hayk confirmation)
  { name: 'QC Inspector', role: 'qc', notes: 'Dedicated QC role — update name once Hayk confirms person' },
];

// ── Login modal ───────────────────────────────────────────
function getDefaultPageForRole(role) {
  const config = ROLE_CONFIG[role];
  if (!config) return 'dashboard.html';
  if (config.pages.includes('all')) return 'dashboard.html';
  const first = config.pages[0] || 'dashboard';
  return `${first}.html`;
}

function injectLoginModal() {
  const accent = '#2563eb';
  const overlay = document.createElement('div');
  overlay.id = 'loginOverlay';
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'background:#f3f4f6',
    'z-index:99999',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    'font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif',
  ].join(';') + ';';
  overlay.innerHTML = `
    <form id="loginForm" onsubmit="event.preventDefault(); submitLogin();" style="
      background:#ffffff;
      width:100%;
      max-width:420px;
      border-radius:16px;
      box-shadow:0 10px 30px rgba(15,23,42,0.08), 0 2px 6px rgba(15,23,42,0.04);
      padding:36px 32px 28px;
      box-sizing:border-box;
    ">
      <div style="display:flex;justify-content:center;margin-bottom:20px;">
        <img src="pulse-logo.png" alt="Pulse" style="height:40px;display:block;" onerror="this.style.display='none';">
      </div>
      <h1 style="
        margin:0 0 6px;
        text-align:center;
        font-size:22px;
        font-weight:700;
        color:#0f172a;
        letter-spacing:-0.01em;
      ">Sign in to Pulse</h1>
      <p style="
        margin:0 0 24px;
        text-align:center;
        font-size:13px;
        color:#64748b;
      ">Use your work email and password.</p>

      <label for="loginEmail" style="
        display:block;
        font-size:12px;
        font-weight:600;
        color:#334155;
        margin-bottom:6px;
      ">Email</label>
      <input
        id="loginEmail"
        type="email"
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        placeholder="name@bazaar-admin.com"
        style="
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
        "
        onfocus="this.style.borderColor='${accent}'; this.style.boxShadow='0 0 0 3px rgba(37,99,235,0.15)';"
        onblur="this.style.borderColor='#d1d5db'; this.style.boxShadow='none';"
      >

      <label for="loginPassword" style="
        display:block;
        font-size:12px;
        font-weight:600;
        color:#334155;
        margin:16px 0 6px;
      ">Password</label>
      <div style="position:relative;">
        <input
          id="loginPassword"
          type="password"
          autocomplete="current-password"
          placeholder="Enter your password"
          style="
            width:100%;
            padding:11px 44px 11px 13px;
            border:1px solid #d1d5db;
            border-radius:10px;
            font-size:14px;
            font-family:inherit;
            color:#0f172a;
            background:#ffffff;
            box-sizing:border-box;
            outline:none;
            transition:border-color 0.15s, box-shadow 0.15s;
          "
          onfocus="this.style.borderColor='${accent}'; this.style.boxShadow='0 0 0 3px rgba(37,99,235,0.15)';"
          onblur="this.style.borderColor='#d1d5db'; this.style.boxShadow='none';"
        >
        <button
          type="button"
          id="loginPasswordToggle"
          onclick="togglePulsePassword()"
          aria-label="Show password"
          style="
            position:absolute;
            top:50%;
            right:8px;
            transform:translateY(-50%);
            background:transparent;
            border:none;
            color:#64748b;
            font-size:12px;
            font-weight:600;
            cursor:pointer;
            padding:6px 8px;
            border-radius:6px;
          "
        >Show</button>
      </div>

      <div id="loginError" role="alert" style="
        display:none;
        margin-top:14px;
        padding:9px 12px;
        background:#fef2f2;
        border:1px solid #fecaca;
        color:#b91c1c;
        border-radius:8px;
        font-size:13px;
      "></div>

      <button
        id="loginSubmitBtn"
        type="submit"
        style="
          width:100%;
          margin-top:20px;
          padding:12px 16px;
          background:${accent};
          color:#ffffff;
          border:none;
          border-radius:10px;
          font-size:14px;
          font-weight:600;
          font-family:inherit;
          cursor:pointer;
          transition:background 0.15s, opacity 0.15s;
        "
        onmouseover="this.style.background='#1d4ed8';"
        onmouseout="this.style.background='${accent}';"
      >Sign In</button>

      <p style="
        margin:18px 0 0;
        text-align:center;
        font-size:12px;
        color:#94a3b8;
      ">Contact your admin if you need access.</p>
    </form>
  `;
  document.body.appendChild(overlay);

  // Focus email field on open
  const emailInput = document.getElementById('loginEmail');
  if (emailInput) emailInput.focus();
}

function togglePulsePassword() {
  const input = document.getElementById('loginPassword');
  const btn = document.getElementById('loginPasswordToggle');
  if (!input || !btn) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
    btn.setAttribute('aria-label', 'Hide password');
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
  }
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
  const emailRaw = document.getElementById('loginEmail')?.value || '';
  const password = document.getElementById('loginPassword')?.value || '';
  const email = emailRaw.trim().toLowerCase();

  if (!email || !password) {
    _showLoginError('Enter your email and password.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    _showLoginError('Enter a valid email address.');
    return;
  }

  const btn = document.getElementById('loginSubmitBtn');
  const setLoading = (loading) => {
    if (!btn) return;
    btn.disabled = loading;
    btn.style.opacity = loading ? '0.7' : '1';
    btn.textContent = loading ? 'Signing in…' : 'Sign In';
  };

  let resolvedName = null;
  let resolvedRole = null;

  if (_supaActive()) {
    // ── Supabase real auth ────────────────────────────────
    setLoading(true);
    try {
      await window.supabaseSignIn(email, password);
      const profile = await window.supabaseGetProfile();
      if (!profile) throw new Error('Profile not found — ask admin to set up your account.');
      // DB stores role with underscores; ROLE_CONFIG uses hyphens.
      resolvedRole = String(profile.role || 'operator').replace(/_/g, '-');
      resolvedName = profile.display_name || email.split('@')[0];
    } catch (e) {
      setLoading(false);
      const msg = e?.message || '';
      _showLoginError(
        /invalid|credentials|password|email/i.test(msg)
          ? 'Incorrect email or password.'
          : (msg || 'Sign-in failed. Try again.')
      );
      return;
    }
  } else {
    // ── Local mode: email → role/name lookup + shared password ──
    const user = LOCAL_EMAIL_USERS[email];
    if (!user) {
      _showLoginError('Incorrect email or password.');
      return;
    }
    if (password !== LOCAL_DEFAULT_PASSWORD) {
      _showLoginError('Incorrect email or password.');
      return;
    }
    resolvedName = user.name;
    resolvedRole = user.role;
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
  if (typeof renderQueuePane === 'function') renderQueuePane();
}

// ── Nav user badge + logout ───────────────────────────────
function injectUserBadge() {
  const session = getSession();
  if (!session) return;
  const cfg = ROLE_CONFIG[session.role] || { label: session.role, color: '#6b7280' };
  const badge = document.createElement('div');
  badge.id = 'userBadge';
  badge.style.cssText = 'position:fixed;top:10px;right:12px;z-index:9999;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:20px;padding:5px 12px 5px 8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);font-size:12px;';
  badge.innerHTML = `
    <span style="width:8px;height:8px;border-radius:50%;background:${cfg.color};flex-shrink:0;"></span>
    <span style="font-weight:600;color:#1e293b;">${session.name.split(' ')[0]}</span>
    <span style="color:${cfg.color};font-size:10px;font-weight:600;">${cfg.label.toUpperCase()}</span>
    <button onclick="logoutUser()" style="border:none;background:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:0 0 0 4px;" title="Log out">✕</button>
  `;
  document.body.appendChild(badge);
}

async function logoutUser() {
  if (_supaActive()) {
    try { await window.supabaseSignOut(); } catch (_) {}
  }
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

  if (pageId === 'admin') {
    const allowedTabs = config.adminTabs || (config.canViewAdmin ? 'all' : []);
    if (allowedTabs !== 'all') {
      document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        const canSee = allowedTabs.includes(btn.dataset.tab);
        btn.style.display = canSee ? '' : 'none';
      });
      document.querySelectorAll('.tab-pane[id^="tab-"]').forEach(pane => {
        const tabId = pane.id.replace('tab-', '');
        const canSee = allowedTabs.includes(tabId);
        pane.style.display = canSee ? '' : 'none';
        pane.classList.toggle('active', canSee && tabId === allowedTabs[0]);
      });
      if (allowedTabs[0] && typeof switchTab === 'function') {
        setTimeout(() => switchTab(allowedTabs[0]), 0);
      }
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
    injectLoginModal();
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
}

function _injectAuthLoader() {
  const el = document.createElement('div');
  el.id = 'authLoader';
  el.style.cssText = 'position:fixed;inset:0;background:#f8fafc;z-index:99998;display:flex;align-items:center;justify-content:center;';
  el.innerHTML = '<div style="text-align:center;"><img src="pulse-logo.png" alt="Pulse" style="height:36px;margin:0 auto 10px;display:block;"><div style="color:#64748b;font-size:13px;">Checking session…</div></div>';
  document.body.appendChild(el);
  return el;
}
