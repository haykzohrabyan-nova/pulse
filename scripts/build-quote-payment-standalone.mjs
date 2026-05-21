#!/usr/bin/env node
/**
 * Builds quote-payment-standalone.html — single file with Payment + Quote tabs.
 * Run: node scripts/build-quote-payment-standalone.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'quote-payment-standalone.html');

const THEME_CSS = `
  :root {
    --bg: #f4f6f9; --card: #ffffff; --card-hover: #f0f2f5; --border: #d8dee6;
    --text: #1a2233; --text-muted: #5f6b7a; --accent: #2563eb; --radius: 8px;
    --shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--text); cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn:hover { background: var(--card-hover); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  input, select, textarea { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); padding: 8px 12px; font-size: 14px; width: 100%; font-family: inherit; }
`;

const SHELL_CSS = `
  .qp-standalone-header { position: sticky; top: 0; z-index: 50; background: var(--card); border-bottom: 1px solid var(--border); padding: 12px 16px; box-shadow: var(--shadow); }
  .qp-standalone-header h1 { font-size: 16px; font-weight: 800; margin: 0 0 8px; }
  .qp-standalone-header p { margin: 0 0 10px; font-size: 12px; color: var(--text-muted); max-width: 720px; line-height: 1.45; }
  .qp-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
  .qp-tab { border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; background: #fff; }
  .qp-tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .qp-pane { display: none; min-height: calc(100vh - 110px); overflow: auto; }
  .qp-pane.active { display: block; }
`;

function sliceBetween(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing end: ${endMarker}`);
  return html.slice(start, end);
}

function sliceScript(html, afterMarker) {
  const idx = html.indexOf(afterMarker);
  const open = html.indexOf('<script>', idx);
  const close = html.indexOf('</script>', open);
  return html.slice(open + '<script>'.length, close);
}

const pqpRaw = fs.readFileSync(path.join(root, 'pulse-quote-payment.js'), 'utf8');
const paymentHtml = fs.readFileSync(path.join(root, 'payment.html'), 'utf8');
const quoteHtml = fs.readFileSync(path.join(root, 'crm-quote.html'), 'utf8');

const paymentBodyFixed = sliceBetween(paymentHtml, '<div id="payRoot"', '\n\n<script>');

let paymentScript = sliceScript(paymentHtml, '<body class="pay-page">');
paymentScript = paymentScript
  .replace(/injectThemeCSS\(\);\s*\n/, '')
  .replace(
    /const PAY_EMBEDDED[\s\S]*?if \(bcEl\) bcEl\.remove\(\);\s*\}/,
    "document.body.classList.add('pay-page', 'pay-embedded');"
  )
  .replace(/\$\{PAY_EMBEDDED \? '20px 16px 24px' : '24px 16px 40px'\}/g, "'20px 16px 24px'")
  .replace(
    /document\.addEventListener\('DOMContentLoaded', async \(\) => \{[\s\S]*?\}\);/,
    'loadPaymentConfig();'
  )
  .replace(
    "document.getElementById('page-styles').textContent = `",
    "document.getElementById('page-styles-payment').textContent = `"
  );

const quoteBodyFixed =
  sliceBetween(quoteHtml, '<div id="quoteRoot"', '<div id="payModal"') +
  sliceBetween(quoteHtml, '<div id="payModal"', '\n\n<script>');

let quoteScript = sliceScript(quoteHtml, '<body data-page="admin">');
quoteScript = quoteScript
  .replace(
    /const EMBEDDED = new URLSearchParams\(window\.location\.search\)\.get\('embedded'\) === 'admin';/,
    'const EMBEDDED = true;'
  )
  .replace(
    /function goToPaymentSettings\(\) \{\s*if \(EMBEDDED[\s\S]*?\n  \}/,
    `function goToPaymentSettings() {
    if (typeof window.switchQuotePaymentTab === 'function') {
      window.switchQuotePaymentTab('payment');
    }
  }`
  )
  .replace(
    /if \(EMBEDDED\) \{\s*document\.body\.classList\.add\('q-embedded'\);\s*document\.getElementById\('nav'\)\.style\.display = 'none';\s*document\.getElementById\('breadcrumb'\)\.style\.display = 'none';\s*\}/,
    `if (EMBEDDED) {
    document.body.classList.add('q-embedded');
    const navEl = document.getElementById('nav');
    const bcEl = document.getElementById('breadcrumb');
    if (navEl) navEl.style.display = 'none';
    if (bcEl) bcEl.style.display = 'none';
  }`
  )
  .replace(/\s*if \(!EMBEDDED\) initAuth\('admin'\);\s*/g, '\n')
  .replace(
    "document.getElementById('page-styles').textContent = `",
    "document.getElementById('page-styles-quote').textContent = `"
  )
  .replace(
    /renderQuote\(resolveQuoteToken\(\)\);/,
    `const _quoteToken = resolveQuoteToken();
  window.renderQuote = renderQuote;
  renderQuote(_quoteToken);`
  );

const html = `<!-- GENERATED FILE — do not edit quote-payment-standalone.html directly.
     Change payment.html, crm-quote.html, or pulse-quote-payment.js in Pulse, then run:
     node scripts/build-quote-payment-standalone.mjs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pulse — Quote &amp; Payment (standalone)</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js" crossorigin="anonymous"><\/script>
  <style id="theme-styles">${THEME_CSS}</style>
  <style id="shell-styles">${SHELL_CSS}</style>
  <style id="page-styles-payment"></style>
  <style id="page-styles-quote"></style>
</head>
<body>
<header class="qp-standalone-header">
  <h1>Pulse — Quote &amp; Payment</h1>
  <p>Standalone copy of the Admin <strong>Payment</strong> and <strong>Quote</strong> tabs. Settings and checkout progress are stored in this browser’s <code>localStorage</code> (no server). Open this file directly or host it locally.</p>
  <div class="qp-tabs" role="tablist">
    <button type="button" class="qp-tab active" data-tab="payment" role="tab" aria-selected="true">Payment settings</button>
    <button type="button" class="qp-tab" data-tab="quote" role="tab" aria-selected="false">Quote &amp; checkout</button>
  </div>
</header>

<section id="pane-payment" class="qp-pane active" role="tabpanel" aria-label="Payment settings">
${paymentBodyFixed}
</section>

<section id="pane-quote" class="qp-pane" role="tabpanel" aria-label="Quote">
${quoteBodyFixed}
</section>

<script>
${pqpRaw}
<\/script>
<script>
${paymentScript}
<\/script>
<script>
${quoteScript}
<\/script>
<script>
(function () {
  function switchQuotePaymentTab(tab) {
    document.querySelectorAll('.qp-tab').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.qp-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === 'pane-' + tab);
    });
    if (tab === 'quote' && typeof window.renderQuote === 'function') {
      try {
        const PQP = window.PulseQuotePayment;
        const token = PQP.getPreviewQuoteToken(PQP.loadPaymentConfig());
        window.renderQuote(token);
      } catch (_) {}
    }
  }
  window.switchQuotePaymentTab = switchQuotePaymentTab;
  document.querySelectorAll('.qp-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchQuotePaymentTab(btn.dataset.tab));
  });
  window.addEventListener('storage', (e) => {
    if (e.key === 'pulse_payment_admin_config_v1') {
      switchQuotePaymentTab('quote');
    }
  });
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'quote') switchQuotePaymentTab('quote');

  const PQP = window.PulseQuotePayment;
  if (PQP && typeof PQP.savePaymentConfig === 'function') {
    const _saveCfg = PQP.savePaymentConfig.bind(PQP);
    PQP.savePaymentConfig = function (cfg) {
      _saveCfg(cfg);
      if (typeof window.renderQuote === 'function') {
        try {
          window.renderQuote(PQP.getPreviewQuoteToken(cfg));
        } catch (_) {}
      }
    };
  }
})();
<\/script>
</body>
</html>
`;

const cleaned = html.replace(/\s*if \(!EMBEDDED\) initAuth\('admin'\);\s*/g, '\n');
fs.writeFileSync(outPath, cleaned, 'utf8');
console.log('Wrote', outPath, `(${Math.round(cleaned.length / 1024)} KB)`);
