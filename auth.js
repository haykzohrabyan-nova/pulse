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
    pages: ['dashboard','job-ticket','pricing-calculator','quotes','orders','prepress','application-dept','rep-tasks','instagram-leads'],
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
  prepress: {
    label: 'Prepress',
    color: '#6b7280',
    pages: ['dashboard','prepress'],
    canEditAllTickets: false,
    canViewAdmin: false,
    canViewProduction: true,
    canViewOperator: false,
  },
};

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
];

// ── Login modal ───────────────────────────────────────────
let _selectedLoginUser = null;

function getDefaultPageForRole(role) {
  const config = ROLE_CONFIG[role];
  if (!config) return 'dashboard.html';
  if (config.pages.includes('all')) return 'dashboard.html';
  const first = config.pages[0] || 'dashboard';
  return `${first}.html`;
}

function injectLoginModal() {
  const users = Object.entries(OPERATOR_PROFILES).map(([name, p]) => ({ name, role: p.role }));
  const allUsers = [{ name: 'Hayk Zohrabyan', role: 'admin' }, ...EXTRA_AUTH_USERS, ...users];

  const grouped = {};
  allUsers.forEach(u => {
    const r = u.role || 'operator';
    if (!grouped[r]) grouped[r] = [];
    grouped[r].push(u);
  });

  const roleOrder = ['admin','david-review','supervisor','production-manager','account-manager','prepress','operator'];

  const userButtons = roleOrder
    .filter(r => grouped[r])
    .map(r => {
      const cfg = ROLE_CONFIG[r] || { label: r, color: '#6b7280' };
      return `<div style="margin-bottom:12px;">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${cfg.label}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${grouped[r].map(u => `
            <button class="login-user-btn" data-name="${u.name.replace(/'/g,"&#39;")}" data-role="${u.role}" onclick="selectUser('${u.name.replace(/'/g,"\\'")}','${u.role}', this)"
              style="padding:7px 14px;border:1px solid ${cfg.color}44;background:${cfg.color}11;color:#1e293b;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500;transition:background 0.15s;">
              ${u.name}
            </button>`).join('')}
        </div>
      </div>`;
    }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'loginOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,36,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:32px 36px;max-width:560px;width:92%;box-shadow:0 24px 60px rgba(0,0,0,0.25);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <img src="pulse-logo.png" alt="Pulse" style="height:32px;">
      </div>
      <p style="color:#6b7280;font-size:13px;margin:0 0 12px;">Select your name, enter your access code, and Pulse will only show the pages for your role.</p>
      <div id="loginSelectedUser" style="display:none;margin-bottom:12px;padding:12px 14px;border:1px solid #dbeafe;background:#eff6ff;border-radius:10px;font-size:13px;"></div>
      ${userButtons}
      <div style="margin-top:14px;display:flex;gap:10px;align-items:flex-end;">
        <div style="flex:1;">
          <label style="display:block;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Access Code</label>
          <input id="loginAccessCode" type="password" inputmode="numeric" placeholder="Enter 4+ digit code" style="width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;box-sizing:border-box;">
        </div>
        <button onclick="submitLogin()" style="padding:10px 18px;background:#0f172a;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;">Sign In</button>
      </div>
      <div id="loginError" style="display:none;color:#dc2626;font-size:12px;margin-top:8px;"></div>
      <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center;">Role-based access is enforced after login. Contact admin if your name is missing.</p>
    </div>
  `;
  document.body.appendChild(overlay);
  const codeInput = document.getElementById('loginAccessCode');
  if (codeInput) codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLogin();
  });
}

function selectUser(name, role, btn) {
  _selectedLoginUser = { name, role };
  document.querySelectorAll('.login-user-btn').forEach(el => {
    el.style.outline = 'none';
    el.style.boxShadow = 'none';
  });
  if (btn) btn.style.boxShadow = '0 0 0 2px rgba(37,99,235,0.35)';
  const cfg = ROLE_CONFIG[role] || { label: role, color: '#6b7280' };
  const box = document.getElementById('loginSelectedUser');
  if (box) {
    box.style.display = 'block';
    box.innerHTML = `<strong>${name}</strong><div style="font-size:12px;color:${cfg.color};margin-top:2px;">${cfg.label}</div>`;
  }
  const err = document.getElementById('loginError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
}

function submitLogin() {
  const err = document.getElementById('loginError');
  if (!_selectedLoginUser) {
    if (err) { err.style.display = 'block'; err.textContent = 'Select your name first.'; }
    return;
  }
  const code = document.getElementById('loginAccessCode')?.value || '';
  if (typeof isValidAccessCode === 'function' && !isValidAccessCode(code)) {
    if (err) { err.style.display = 'block'; err.textContent = 'Enter a valid 4+ digit access code.'; }
    return;
  }
  setSession(_selectedLoginUser.name, _selectedLoginUser.role);
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.remove();
  const currentPage = document.body.dataset.page || '';
  // Operators always land on the Operator Terminal
  if (_selectedLoginUser.role === 'operator' && currentPage !== 'operator-terminal') {
    window.location.href = 'operator-terminal.html';
    return;
  }
  if (currentPage && !canAccessPage(currentPage)) {
    window.location.href = getDefaultPageForRole(_selectedLoginUser.role);
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

function logoutUser() {
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
function initAuth(pageId) {
  document.body.dataset.page = pageId;

  // Temporary preview mode for local working sessions.
  // If no session exists, default to admin so internal navigation stays usable.
  let session = getSession();
  if (!session) {
    if (pageId === 'operator-terminal') return;
    setSession('Hayk Zohrabyan', 'admin');
    session = getSession();
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
