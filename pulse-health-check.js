// ============================================================
// pulse-health-check.js — Pulse Supabase Reachability Guard
// PRI-XXX: Defensive safety net — prevent silent IndexedDB fallback
//
// Loaded BEFORE shared.js so it can install handlers before any
// data layer touches storage.
//
// What it does:
//   1. On page load, pings the configured Supabase URL with a HEAD
//      request to /rest/v1/.
//   2. If the ping fails (network error, DNS, CORS, 5xx, timeout),
//      installs a LOUD red banner at the top of the page with text:
//        "⚠️ Database unreachable — DO NOT make changes. Contact admin."
//   3. Disables interactive write controls by setting a global flag
//      `window.PULSE_DB_BLOCKED = true` and adding a CSS rule that
//      pointer-disables form/button submissions inside the app shell.
//   4. Logs structured diagnostics to console for debugging.
//
// Behavior is intentionally conservative:
//   - Non-supabase backends (IndexedDB-only dev mode) skip the check.
//   - A successful retry (every 30s) auto-removes the banner and
//     re-enables writes.
//   - The banner is also shown if PULSE_STORAGE_BACKEND === 'supabase'
//     but PULSE_SUPABASE_URL/_KEY is missing, since that's the silent
//     misconfig case where shared.js would silently fall back to
//     IndexedDB.
// ============================================================

(function () {
  'use strict';

  const BACKEND = window.PULSE_STORAGE_BACKEND || 'indexeddb';
  const URL_    = window.PULSE_SUPABASE_URL || '';
  const KEY_    = window.PULSE_SUPABASE_ANON_KEY || '';

  // Skip when not running in Supabase mode (e.g. local-only dev).
  if (BACKEND !== 'supabase') {
    console.log('[Pulse/Health] Backend != supabase — skipping reachability check');
    return;
  }

  // Misconfig — show banner immediately.
  if (!URL_ || !KEY_) {
    console.error('[Pulse/Health] PULSE_STORAGE_BACKEND=supabase but URL/KEY missing');
    showBanner('Database not configured — contact admin before making any changes.');
    blockWrites();
    return;
  }

  let bannerEl = null;
  let cssEl    = null;
  let retryHandle = null;
  let consecutiveFailures = 0;

  function ping() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    return fetch(`${URL_}/rest/v1/`, {
      method: 'HEAD',
      headers: {
        'apikey': KEY_,
        'Authorization': `Bearer ${KEY_}`,
      },
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(res => {
        clearTimeout(timer);
        // 2xx, 3xx, 4xx all indicate the server responded — only 5xx
        // and network errors should block writes.
        if (res.status >= 500) {
          throw new Error(`Supabase HTTP ${res.status}`);
        }
        return true;
      })
      .catch(err => {
        clearTimeout(timer);
        throw err;
      });
  }

  function showBanner(msg) {
    if (bannerEl) {
      bannerEl.querySelector('.pulse-health-msg').textContent = msg;
      return;
    }
    bannerEl = document.createElement('div');
    bannerEl.id = 'pulse-health-banner';
    bannerEl.setAttribute('role', 'alert');
    bannerEl.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'background:#b00020',
      'color:#fff',
      'font:600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'padding:12px 18px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:12px',
    ].join(';');
    bannerEl.innerHTML = `
      <span class="pulse-health-msg">⚠️ ${escapeHtml(msg)}</span>
      <span style="font-weight:400;opacity:.9;font-size:12px">
        Auto-retrying every 30s · Build ${escapeHtml(window.PULSE_BUILD_VERSION || 'unknown')} · Env ${escapeHtml(window.PULSE_ENV || 'unknown')}
      </span>
    `;
    if (document.body) {
      document.body.prepend(bannerEl);
    } else {
      document.addEventListener('DOMContentLoaded', () => document.body.prepend(bannerEl));
    }
  }

  function hideBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  function blockWrites() {
    window.PULSE_DB_BLOCKED = true;
    if (cssEl) return;
    cssEl = document.createElement('style');
    cssEl.id = 'pulse-health-block-css';
    cssEl.textContent = `
      /* PULSE_DB_BLOCKED: prevent inadvertent submissions while DB unreachable */
      body[data-pulse-db-blocked="true"] form button[type="submit"],
      body[data-pulse-db-blocked="true"] form input[type="submit"],
      body[data-pulse-db-blocked="true"] [data-pulse-write="true"] {
        pointer-events: none !important;
        opacity: 0.45 !important;
        cursor: not-allowed !important;
      }
    `;
    document.head.appendChild(cssEl);
    if (document.body) document.body.dataset.pulseDbBlocked = 'true';
    else document.addEventListener('DOMContentLoaded', () => { document.body.dataset.pulseDbBlocked = 'true'; });
  }

  function unblockWrites() {
    window.PULSE_DB_BLOCKED = false;
    if (document.body) delete document.body.dataset.pulseDbBlocked;
    if (cssEl && cssEl.parentNode) cssEl.parentNode.removeChild(cssEl);
    cssEl = null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function tick() {
    ping()
      .then(() => {
        if (consecutiveFailures > 0) {
          console.log('[Pulse/Health] Supabase reachable again after', consecutiveFailures, 'failure(s)');
        }
        consecutiveFailures = 0;
        hideBanner();
        unblockWrites();
      })
      .catch(err => {
        consecutiveFailures += 1;
        console.error('[Pulse/Health] Supabase unreachable:', err.message || err);
        // First failure → immediate banner. Subsequent failures keep banner up.
        showBanner('Database unreachable — DO NOT make changes. Contact admin.');
        blockWrites();
      });
  }

  // First ping immediately, then every 30s.
  tick();
  retryHandle = setInterval(tick, 30000);

  // Surface a debug helper.
  window.__pulseHealthCheck = { ping, tick, showBanner, hideBanner, blockWrites, unblockWrites };
})();
