#!/usr/bin/env node
/**
 * Pulse Local Proxy Server
 * Runs on port 8879 — forwards Slack + HubSpot calls from the browser
 * Fixes CORS: browser → localhost:8879/proxy/... → real API
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8879;

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

loadLocalEnv();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function forwardRequest(options, body, res) {
  const req = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, corsHeaders());
      res.end(data || JSON.stringify({ ok: true }));
    });
  });
  req.on('error', (e) => {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: e.message }));
  });
  if (body) req.write(body);
  req.end();
}

function twilioJson(res, statusCode, payload) {
  res.writeHead(statusCode, corsHeaders());
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {

    // ── POST /proxy/slack ──
    if (req.method === 'POST' && req.url === '/proxy/slack') {
      const payload = JSON.parse(body);
      const webhookUrl = payload._webhook;
      delete payload._webhook;

      if (!webhookUrl || !webhookUrl.includes('hooks.slack.com')) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: 'Missing or invalid webhook URL' }));
        return;
      }

      const path = new URL(webhookUrl).pathname;
      const postBody = JSON.stringify(payload);

      forwardRequest({
        hostname: 'hooks.slack.com',
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, postBody, res);
      return;
    }

    // ── POST /proxy/hubspot/contacts ──
    if (req.method === 'POST' && req.url === '/proxy/hubspot/contacts') {
      const payload = JSON.parse(body);
      const token = payload._token;
      delete payload._token;

      if (!token) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: 'Missing HubSpot token' }));
        return;
      }

      const postBody = JSON.stringify(payload);

      forwardRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/contacts',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postBody),
        },
      }, postBody, res);
      return;
    }

    // ── POST /proxy/twilio/sms ──
    if (req.method === 'POST' && req.url === '/proxy/twilio/sms') {
      const payload = JSON.parse(body || '{}');
      const accountSid = process.env.PULSE_TWILIO_ACCOUNT_SID;
      const authToken = process.env.PULSE_TWILIO_AUTH_TOKEN;
      const from = process.env.PULSE_TWILIO_FROM;
      const messagingServiceSid = process.env.PULSE_TWILIO_MESSAGING_SERVICE_SID;
      const testTo = process.env.PULSE_TWILIO_TEST_TO;
      const to = testTo || payload.to;
      const message = String(payload.message || payload.body || '').trim();

      if (!accountSid || !authToken) {
        twilioJson(res, 400, { error: 'Twilio SID/token not configured on proxy.' });
        return;
      }
      if (!to || !message) {
        twilioJson(res, 400, { error: 'Missing SMS destination or message.' });
        return;
      }
      if (!from && !messagingServiceSid) {
        twilioJson(res, 400, { error: 'Twilio sender missing. Set PULSE_TWILIO_FROM or PULSE_TWILIO_MESSAGING_SERVICE_SID.' });
        return;
      }

      const params = new URLSearchParams();
      params.set('To', to);
      params.set('Body', message);
      if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
      else params.set('From', from);

      const postBody = params.toString();
      const request = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
        },
      }, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(data || '{}'); } catch (e) { parsed = { raw: data }; }
          twilioJson(res, apiRes.statusCode || 200, parsed);
        });
      });

      request.on('error', (e) => twilioJson(res, 500, { error: e.message }));
      request.write(postBody);
      request.end();
      return;
    }

    // ── OAuth Callback — handles both ?code= and #access_token= ──
    if (req.method === 'GET' && req.url.startsWith('/auth')) {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error: ${error}</h2><p>${url.searchParams.get('error_description') || ''}</p>`);
        return;
      }
      if (code) {
        console.log('\u2705 OAuth code received:', code);
        const tokenPath = `/v19.0/oauth/access_token?client_id=1198137935565314&redirect_uri=https://instagram.pixelpressprint.com/auth&code=${code}&client_secret=8d390d143e27928c223934e153d3e8b7`;
        const tokenReq = https.request({ hostname: 'graph.facebook.com', path: tokenPath, method: 'GET' }, (tokenRes) => {
          let data = '';
          tokenRes.on('data', chunk => data += chunk);
          tokenRes.on('end', () => {
            const fs = require('fs');
            fs.writeFileSync('/tmp/instagram_token.json', data);
            console.log('\u2705 Token saved:', data);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<h1>\u2705 Instagram Connected!</h1><pre>${data}</pre><p>Token saved. You can close this window.</p>`);
          });
        });
        tokenReq.end();
        return;
      }
      // No code — serve HTML page that captures #access_token fragment and POSTs it back
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body>
        <h2>\u23F3 Capturing token...</h2>
        <script>
          const hash = window.location.hash.substring(1);
          const params = new URLSearchParams(hash);
          const token = params.get('access_token');
          const longToken = params.get('long_lived_token');
          if (token || longToken) {
            fetch('/save-token', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({access_token: token, long_lived_token: longToken, raw: hash})})
              .then(() => { document.body.innerHTML = '<h1>\u2705 Instagram Connected! Token saved. Close this window.</h1>'; })
              .catch(e => { document.body.innerHTML = '<h1>\u274C Error: ' + e + '</h1>'; });
          } else {
            document.body.innerHTML = '<h1>\u274C No token in URL. Try again.</h1><pre>' + hash + '</pre>';
          }
        <\/script>
      </body></html>`);
      return;
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No code received');
      return;
    }

    // ── Save Token ──
    if (req.method === 'POST' && req.url === '/save-token') {
      const fs = require('fs');
      fs.writeFileSync('/tmp/instagram_token.json', body);
      console.log('\u2705 Instagram access token saved!');
      console.log(body);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Meta Webhook Verification (GET) ──
    if (req.method === 'GET' && req.url.startsWith('/webhook')) {
      const url = new URL(req.url, 'http://localhost');
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === 'bazaar_pulse_2026') {
        console.log('✅ Meta webhook verified!');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        res.writeHead(403);
        res.end('Forbidden');
      }
      return;
    }

    // ── Meta Webhook Events (POST) ──
    if (req.method === 'POST' && req.url.startsWith('/webhook')) {
      console.log('📩 Instagram DM webhook received');
      console.log(body);
      // TODO: process DM and generate AI draft
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('EVENT_RECEIVED');
      return;
    }

    // ── Health check ──
    if (req.url === '/health') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'ok', service: 'Pulse Proxy', port: PORT }));
      return;
    }

    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Unknown proxy route' }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Pulse Proxy running at http://localhost:${PORT}`);
  console.log(`   /proxy/slack         → Slack webhooks`);
  console.log(`   /proxy/hubspot/contacts → HubSpot CRM`);
  console.log(`   /proxy/twilio/sms    → Twilio SMS relay`);
  console.log(`   /health              → status check`);
});
