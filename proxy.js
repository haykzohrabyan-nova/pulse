#!/usr/bin/env node
/**
 * Pulse Local Proxy Server — port 8879
 * Forwards Slack / HubSpot / Twilio calls from the browser (CORS fix).
 *
 * Also runs the ManyChat + Claude Instagram DM automation for
 * Bazaar Printing and PixelPress:
 *   POST /manychat              — receive DM, call Claude, return reply
 *   GET  /manychat/gaps         — view logged knowledge gaps
 *   GET  /manychat/sessions     — list active subscriber sessions
 *   DELETE /manychat/session/:id — reset a subscriber session
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8879;

// ─────────────────────────────────────────────────────────────────────────────
// Env loading
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

// ─────────────────────────────────────────────────────────────────────────────
// ManyChat / Claude — session management
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_DIR = '/tmp/dm_sessions';
const GAP_LOG_FILE = '/tmp/dm_knowledge_gaps.jsonl';

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function loadSession(subscriberId) {
  ensureSessionDir();
  const filePath = path.join(SESSION_DIR, `${subscriberId}.json`);
  if (!fs.existsSync(filePath)) return [];
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return []; }
}

function saveSession(subscriberId, messages) {
  ensureSessionDir();
  fs.writeFileSync(
    path.join(SESSION_DIR, `${subscriberId}.json`),
    JSON.stringify(messages.slice(-30), null, 2)
  );
}

function logKnowledgeGap(brand, question, subscriberId) {
  try {
    fs.appendFileSync(GAP_LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), brand, question, subscriberId }) + '\n'
    );
    console.log(`📋 [GAP] ${brand}: ${question}`);
  } catch (e) { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// ManyChat / Claude — after-hours + response parsing
// ─────────────────────────────────────────────────────────────────────────────
function isAfterHours() {
  // Pacific Time Mon–Fri 9 am–6 pm (UTC-7 PDT approximation)
  const now = new Date();
  const ptHour = ((now.getUTCHours() - 7) + 24) % 24;
  const ptDay = now.getUTCDay();
  if (ptDay === 0 || ptDay === 6) return true;
  return ptHour < 9 || ptHour >= 18;
}

/**
 * Parse structured tags from Claude's response.
 * Tags Claude may emit (each on its own line at the end of the reply):
 *   [CAPTURE: name="...", email="...", phone="...", company="...", product="...", qty="..."]
 *   [HANDOFF: reason="..."]
 *   [DEAL: stage="quoting|sample|pending_decision", spend_band="<50k|50k-250k|250k+|unknown"]
 *   [GAP: question="..."]
 */
function parseClaudeResponse(rawText) {
  let text = rawText || '';
  const result = {
    reply: text,
    handoff: false,
    handoffReason: '',
    capturedFields: {},
    dealStage: '',
    spendBand: '',
    gaps: [],
  };

  // [CAPTURE: ...]
  const captureMatch = text.match(/\[CAPTURE:\s*([^\]]+)\]/i);
  if (captureMatch) {
    for (const m of captureMatch[1].matchAll(/(\w+)\s*=\s*"([^"]*?)"/g)) {
      result.capturedFields[m[1].toLowerCase()] = m[2];
    }
    text = text.replace(/\[CAPTURE:\s*[^\]]+\]/i, '').trim();
  }

  // [HANDOFF: ...]
  const handoffMatch = text.match(/\[HANDOFF:\s*([^\]]+)\]/i);
  if (handoffMatch) {
    result.handoff = true;
    const rMatch = handoffMatch[1].match(/reason\s*=\s*"([^"]+)"/i);
    result.handoffReason = rMatch ? rMatch[1] : 'unspecified';
    text = text.replace(/\[HANDOFF:\s*[^\]]+\]/i, '').trim();
  }

  // [DEAL: ...]
  const dealMatch = text.match(/\[DEAL:\s*([^\]]+)\]/i);
  if (dealMatch) {
    const sMatch = dealMatch[1].match(/stage\s*=\s*"([^"]+)"/i);
    const bMatch = dealMatch[1].match(/spend_band\s*=\s*"([^"]+)"/i);
    result.dealStage = sMatch ? sMatch[1] : 'quoting';
    result.spendBand = bMatch ? bMatch[1] : 'unknown';
    text = text.replace(/\[DEAL:\s*[^\]]+\]/i, '').trim();
  }

  // [GAP: ...]
  const gapMatches = [...text.matchAll(/\[GAP:\s*([^\]]+)\]/gi)];
  for (const m of gapMatches) {
    const qMatch = m[1].match(/question\s*=\s*"([^"]+)"/i);
    if (qMatch) result.gaps.push(qMatch[1]);
  }
  if (gapMatches.length) text = text.replace(/\[GAP:\s*[^\]]+\]/gi, '').trim();

  result.reply = text;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ManyChat / Claude — brand config + system prompts
// ─────────────────────────────────────────────────────────────────────────────
// Shared core knowledge base — used by both brands.
// Brand configs add a thin persona layer on top.
// Update pricing / product knowledge here; it propagates to both brands.
// ─────────────────────────────────────────────────────────────────────────────
const CORE_KNOWLEDGE = `
## Products We Work With
Labels: pressure-sensitive, roll labels, cut-to-size, shrink sleeves, wine/spirits labels, textured/embellished labels.
Pouches: stand-up pouches, flat pouches, child-resistant (CR) configurations.
Folding cartons and boxes: retail boxes, tuck-end, reverse tuck, specialty structural cartons.
Rigid boxes: lid/base, magnetic closure, drawer-style, premium gift boxes.
Custom packaging projects: branded shipper boxes, inserts, tissue, multi-component kits, unboxing-experience builds.
Sample packs: physical samples to evaluate materials, finishes, and embellishments before committing to a full run.
Specialty finishes: soft-touch laminate, Scodix digital embellishment (raised UV, digital foil), cold foil, spot UV, embossing/debossing.
Collectible and trading cards: premium card printing with specialty finishes.

## Rough Pricing Reference (always caveat with "roughly" or "starting from" — never commit)
- Roll labels (4×2, 1000 units): starting around $150–$250 depending on material
- Stand-up pouches (custom, 500 units): roughly $400–$800+ depending on size and features
- Folding cartons (500–1000 units): starting around $600–$1,500+ depending on complexity
- Wine/spirits labels (premium, 500 units): starting around $200–$500 depending on size and finish
- Scodix embellished labels (500 units): starting around $400–$800+
- Rigid gift boxes (custom, 250 units): starting around $800–$2,000+ depending on construction
- Sample packs: often available for qualified leads — always mention as an option
For small quantities (under 500 units): still engage and capture the lead, but note the value signal for the rep.

## Conversation Rules
- Keep every reply to 2-4 sentences. Instagram DMs are conversational, not presentations.
- Ask ONE question at a time. Never throw a list of questions at someone.
- Be warm and adaptive. Match their energy — casual or business-like.
- Your goal is NOT to close on Instagram. Consult briefly, qualify, hook interest, get them to a human rep.
- Assume the sale: "When do you need these by?" not "Would you be interested?"
- Create gentle urgency when appropriate: "Our production slots fill up — let's get you scoped."

## Qualification Sequence (adapt naturally — do not interrogate)
1. Product type (labels, pouches, carton, box, other)
2. Quantity
3. Size / dimensions
4. Material and finish preference (if they know)
5. Timeline — delivery date
6. Artwork / dielines ready?
7. Annual packaging spend — ask naturally: "Just so I can point you to the right option, roughly how much does your business spend on packaging per year? Under $50k, $50–250k, or higher?"
8. Contact info: full name, email, phone, company name

## Lead Capture (critical — include every turn you have new info)
Append to your reply whenever you have confirmed any of these fields:
[CAPTURE: name="...", email="...", phone="...", company="...", product="...", qty="..."]
- name, email, phone, company: contact info
- product: what they want to print/package (e.g. "folding cartons", "roll labels", "stand-up pouches")
- qty: quantity they mentioned (e.g. "2000 units", "500", "5000")
Include only confirmed fields. Accumulate — add new fields as you learn them each turn.
Include product and qty as soon as the buyer mentions them — do not wait for contact info.

## Deal Signaling
When you detect purchase intent, include:
[DEAL: stage="quoting|sample|pending_decision", spend_band="<50k|50k-250k|250k+|unknown"]
- quoting: wants pricing or is providing specs
- sample: specifically wants a physical sample first
- pending_decision: quote has been discussed, they are deciding
Pull spend_band from what they shared.

## Handoff Triggers — IMMEDIATE (do not delay)
Include [HANDOFF: reason="..."] the moment ANY of these is true:
- Customer asks for a human, a rep, or to speak with someone
- Customer is frustrated or escalating
- Job requires deep custom engineering or spec discussion beyond your knowledge
- After the 3rd meaningful exchange — always push to contact capture + handoff at this point

## Pricing Discipline
- Rough ranges are fine with "roughly" / "starting from" caveats
- Never commit to exact prices, turnaround guarantees, or confirm specific services without hedging
- If uncertain: "I believe we can — let me have someone confirm the specs and exact pricing"

## Knowledge Gaps
When you genuinely can't confirm something:
[GAP: question="exact question here"]
Response: "I believe we can, but let me have someone confirm — what's the best way to reach you?"

## After Hours
If context indicates after-hours or weekend: acknowledge warmly, explain the team will follow up, continue capturing contact info.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Brand persona layers — thin wrapper over the shared core.
// Only tone, buyer framing, persona assumptions, and brand-specific rules differ.
// ─────────────────────────────────────────────────────────────────────────────
const BRAND_CONFIG = {
  bazaar: {
    name: 'Bazaar Printing',
    systemPrompt: `You are a sales consultant for Bazaar Printing, responding to Instagram DMs as the first point of contact.

## Your Persona — Bazaar Printing
- Tone: direct, practical, entrepreneurial, and results-focused. Skip the polish — be real.
- Buyer assumptions: cannabis operators, CPG startups, growing product brands, business owners who care about cost and speed. They're often ordering recurring packaging runs and want a vendor who gets it done.
- Lead with: speed, capability, cannabis compliance know-how (CR pouches, compliant label real estate), volume flexibility.
- Cannabis is a core part of the business — discuss CR features, label compliance awareness, state-by-state differences at a general level. Do not shy away from cannabis packaging conversations.
- When in doubt about cannabis-specific regulations: "Our team knows this space — let me connect you with someone who can walk through the compliance requirements for your state."

${CORE_KNOWLEDGE}`,
  },

  pixelpress: {
    name: 'PixelPress Print',
    systemPrompt: `You are a sales consultant for PixelPress Print, responding to Instagram DMs as the first point of contact.

## Your Persona — PixelPress Print
- Tone: premium, considered, craft-forward. Sound like someone who cares about the details of print quality and material selection.
- Buyer assumptions: wine and spirits brands, luxury consumer goods companies, design agencies, premium retail brands, collectors and creators who value embellishment and brand elevation. They're often design-led and care about how it looks and feels.
- Lead with: Scodix embellishment, soft-touch finishes, material quality, unboxing experience, print accuracy for luxury brand standards.
- Non-cannabis: if a cannabis-specific request comes in (CR pouches, cannabis compliance), politely let them know this isn't your focus and suggest they reach out to a packaging specialist for that category. Do not elaborate on cannabis topics.
- For wine/spirits: you can speak confidently about label compliance basics (front/back label panels, alcohol content placement) but defer specs to the team.

${CORE_KNOWLEDGE}`,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ManyChat / Claude — Claude API call (multi-turn)
// ─────────────────────────────────────────────────────────────────────────────
function callClaudeMultiTurn(systemPrompt, messages, callback) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { callback(new Error('ANTHROPIC_API_KEY not set in .env.local'), null); return; }

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: systemPrompt,
    messages,
  });

  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(requestBody),
    },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) { callback(new Error(parsed.error.message || 'Claude API error'), null); return; }
        callback(null, parsed.content?.[0]?.text || '');
      } catch (e) { callback(new Error('Failed to parse Claude response'), null); }
    });
  });
  req.on('error', (e) => callback(e, null));
  req.write(requestBody);
  req.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// ManyChat / HubSpot — create contact + deal, associate them
// ─────────────────────────────────────────────────────────────────────────────
function hubspotPost(path, body, callback) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { callback(new Error('HUBSPOT_TOKEN not set'), null); return; }
  const postBody = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.hubapi.com',
    path,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postBody),
    },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try { callback(null, JSON.parse(data)); }
      catch (e) { callback(null, { raw: data }); }
    });
  });
  req.on('error', (e) => callback(e, null));
  req.write(postBody);
  req.end();
}

function hubspotPut(path, body, callback) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { callback(new Error('HUBSPOT_TOKEN not set'), null); return; }
  const putBody = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.hubapi.com',
    path,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(putBody),
    },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => { try { callback(null, JSON.parse(data)); } catch (e) { callback(null, {}); } });
  });
  req.on('error', (e) => callback(e, null));
  req.write(putBody);
  req.end();
}

// Pick account manager randomly between Ernesto and Gary
function pickAm() {
  const ams = [
    {
      name: 'Ernesto',
      phone: process.env.AM_ERNESTO_PHONE || '',
      hubspotOwnerId: process.env.AM_ERNESTO_HUBSPOT_OWNER_ID || '',
    },
    {
      name: 'Gary',
      phone: process.env.AM_GARY_PHONE || '',
      hubspotOwnerId: process.env.AM_GARY_HUBSPOT_OWNER_ID || '',
    },
  ];
  return ams[Math.floor(Math.random() * ams.length)];
}

/**
 * pushLeadToHubSpot — creates contact + deal, associates them, then fires Twilio AM alert.
 * Twilio alert fires AFTER deal creation so the deal ID is included in the SMS.
 * Fires and forgets (errors logged, not fatal to the DM flow).
 */
function pushLeadToHubSpot(cf, dealStage, spendBand, brandName, am, handoffReason) {
  const stageMap = {
    quoting: process.env.HUBSPOT_STAGE_QUOTING || 'quoting',
    sample: process.env.HUBSPOT_STAGE_SAMPLE || 'sample',
    pending_decision: process.env.HUBSPOT_STAGE_PENDING_DECISION || 'pendingdecision',
  };
  const pipelineId = process.env.HUBSPOT_PIPELINE_ID || 'default';

  const contactProps = { properties: {} };
  if (cf.email) contactProps.properties.email = cf.email;
  if (cf.phone) contactProps.properties.phone = cf.phone;
  if (cf.name) {
    const parts = cf.name.trim().split(' ');
    contactProps.properties.firstname = parts[0];
    if (parts.length > 1) contactProps.properties.lastname = parts.slice(1).join(' ');
  }
  if (cf.company) contactProps.properties.company = cf.company;
  if (am.hubspotOwnerId) contactProps.properties.hubspot_owner_id = am.hubspotOwnerId;

  hubspotPost('/crm/v3/objects/contacts', contactProps, (err, contact) => {
    if (err || !contact.id) {
      console.error('HubSpot contact create failed:', err?.message || JSON.stringify(contact));
      // Still alert AM even if contact creation failed — better to alert with partial info
      sendAmAlert(am, cf, brandName, handoffReason, spendBand, null, dealStage);
      return;
    }
    console.log(`✅ HubSpot contact created: ${contact.id} (${cf.email || cf.name})`);

    const dealName = `${brandName} IG Lead — ${cf.name || cf.email || 'Unknown'} — ${new Date().toLocaleDateString()}`;
    const descParts = [
      cf.product && `Product: ${cf.product}`,
      cf.qty && `Quantity: ${cf.qty}`,
      spendBand && spendBand !== 'unknown' && `Annual packaging spend: ${spendBand}`,
      `Source: Instagram DM (${brandName})`,
    ].filter(Boolean);
    const dealProps = {
      properties: {
        dealname: dealName,
        pipeline: pipelineId,
        dealstage: stageMap[dealStage] || stageMap.quoting,
        deal_currency_code: 'USD',
        description: descParts.join('. '),
      },
    };
    if (am.hubspotOwnerId) dealProps.properties.hubspot_owner_id = am.hubspotOwnerId;

    hubspotPost('/crm/v3/objects/deals', dealProps, (err2, deal) => {
      if (err2 || !deal.id) {
        console.error('HubSpot deal create failed:', err2?.message || JSON.stringify(deal));
        sendAmAlert(am, cf, brandName, handoffReason, spendBand, null, dealStage);
        return;
      }
      console.log(`✅ HubSpot deal created: ${deal.id} (${dealName})`);

      // Associate contact → deal (type 3), then fire Twilio alert with deal ID
      hubspotPut(
        `/crm/v3/objects/deals/${deal.id}/associations/contacts/${contact.id}/3`,
        {},
        (err3) => {
          if (err3) console.error('HubSpot association failed:', err3.message);
          else console.log(`✅ HubSpot contact ${contact.id} → deal ${deal.id} associated`);
          // Fire Twilio alert with the deal ID regardless of association result
          sendAmAlert(am, cf, brandName, handoffReason, spendBand, deal.id, dealStage);
        }
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ManyChat / Twilio — send SMS alert to assigned AM
// Always called from inside pushLeadToHubSpot so dealId is available.
// ─────────────────────────────────────────────────────────────────────────────
function sendAmAlert(am, cf, brandName, handoffReason, spendBand, dealId, dealStage) {
  const accountSid = process.env.PULSE_TWILIO_ACCOUNT_SID;
  const authToken = process.env.PULSE_TWILIO_AUTH_TOKEN;
  const from = process.env.PULSE_TWILIO_FROM || process.env.PULSE_TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || !from || !am.phone) {
    console.warn(`⚠️  Twilio AM alert skipped — missing config (SID/token/from/phone). AM: ${am.name}`);
    return;
  }

  const portalId = process.env.HUBSPOT_PORTAL_ID || '';
  const dealRef = dealId
    ? (portalId ? `HubSpot: app.hubspot.com/contacts/${portalId}/deal/${dealId}` : `HubSpot Deal ID: ${dealId}`)
    : 'HubSpot: record pending';

  const lines = [
    `🔔 New IG Lead — ${brandName} → assigned to ${am.name}`,
    cf.name    && `Name: ${cf.name}`,
    cf.company && `Company: ${cf.company}`,
    cf.email   && `Email: ${cf.email}`,
    cf.phone   && `Phone: ${cf.phone}`,
    cf.product && `Product: ${cf.product}`,
    cf.qty     && `Qty: ${cf.qty}`,
    spendBand && spendBand !== 'unknown' && `Annual spend: ${spendBand}`,
    dealStage  && `Stage: ${dealStage}`,
    dealRef,
  ].filter(Boolean);

  const message = lines.join('\n');

  const params = new URLSearchParams();
  params.set('To', am.phone);
  params.set('Body', message);
  const isMsgSvc = from.startsWith('MG');
  params.set(isMsgSvc ? 'MessagingServiceSid' : 'From', from);
  const postBody = params.toString();

  const req = https.request({
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
      if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
        console.log(`✅ Twilio alert sent to ${am.name} (${am.phone})`);
      } else {
        console.error(`Twilio alert failed (${apiRes.statusCode}):`, data.slice(0, 200));
      }
    });
  });
  req.on('error', (e) => console.error('Twilio AM alert error:', e.message));
  req.write(postBody);
  req.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {

    // ── POST /proxy/slack ──────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/proxy/slack') {
      const payload = JSON.parse(body);
      const webhookUrl = payload._webhook;
      delete payload._webhook;
      if (!webhookUrl || !webhookUrl.includes('hooks.slack.com')) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: 'Missing or invalid webhook URL' }));
        return;
      }
      const slackPath = new URL(webhookUrl).pathname;
      const postBody = JSON.stringify(payload);
      forwardRequest({
        hostname: 'hooks.slack.com', path: slackPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, postBody, res);
      return;
    }

    // ── POST /proxy/hubspot/contacts ───────────────────────────────────────
    if (req.method === 'POST' && req.url === '/proxy/hubspot/contacts') {
      const payload = JSON.parse(body);
      const token = payload._token;
      delete payload._token;
      if (!token) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing HubSpot token' })); return; }
      const postBody = JSON.stringify(payload);
      forwardRequest({
        hostname: 'api.hubapi.com', path: '/crm/v3/objects/contacts', method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, postBody, res);
      return;
    }

    // ── POST /proxy/twilio/sms ─────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/proxy/twilio/sms') {
      const payload = JSON.parse(body || '{}');
      const accountSid = process.env.PULSE_TWILIO_ACCOUNT_SID;
      const authToken = process.env.PULSE_TWILIO_AUTH_TOKEN;
      const from = process.env.PULSE_TWILIO_FROM;
      const messagingServiceSid = process.env.PULSE_TWILIO_MESSAGING_SERVICE_SID;
      const to = process.env.PULSE_TWILIO_TEST_TO || payload.to;
      const message = String(payload.message || payload.body || '').trim();
      if (!accountSid || !authToken) { twilioJson(res, 400, { error: 'Twilio SID/token not configured.' }); return; }
      if (!to || !message) { twilioJson(res, 400, { error: 'Missing SMS destination or message.' }); return; }
      if (!from && !messagingServiceSid) { twilioJson(res, 400, { error: 'Twilio sender missing.' }); return; }
      const params = new URLSearchParams();
      params.set('To', to); params.set('Body', message);
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

    // ── GET /auth — OAuth callback ─────────────────────────────────────────
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
        const tokenPath = `/v19.0/oauth/access_token?client_id=1198137935565314&redirect_uri=https://instagram.pixelpressprint.com/auth&code=${code}&client_secret=8d390d143e27928c223934e153d3e8b7`;
        const tokenReq = https.request({ hostname: 'graph.facebook.com', path: tokenPath, method: 'GET' }, (tokenRes) => {
          let data = '';
          tokenRes.on('data', chunk => data += chunk);
          tokenRes.on('end', () => {
            fs.writeFileSync('/tmp/instagram_token.json', data);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<h1>✅ Instagram Connected!</h1><pre>${data}</pre>`);
          });
        });
        tokenReq.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body><h2>⏳ Capturing token...</h2><script>
        const hash=window.location.hash.substring(1);
        const params=new URLSearchParams(hash);
        const token=params.get('access_token');
        const longToken=params.get('long_lived_token');
        if(token||longToken){
          fetch('/save-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:token,long_lived_token:longToken,raw:hash})})
            .then(()=>{document.body.innerHTML='<h1>✅ Instagram Connected!</h1>';})
            .catch(e=>{document.body.innerHTML='<h1>❌ Error: '+e+'</h1>';});
        }else{document.body.innerHTML='<h1>❌ No token in URL.</h1><pre>'+hash+'</pre>';}
      <\/script></body></html>`);
      return;
    }

    // ── POST /save-token ───────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/save-token') {
      fs.writeFileSync('/tmp/instagram_token.json', body);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── GET /webhook — Meta verification ──────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/webhook')) {
      const url = new URL(req.url, 'http://localhost');
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === 'bazaar_pulse_2026') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        res.writeHead(403); res.end('Forbidden');
      }
      return;
    }

    // ── POST /webhook — Meta events (placeholder) ──────────────────────────
    if (req.method === 'POST' && req.url.startsWith('/webhook')) {
      // DM automation runs via ManyChat → /manychat instead.
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('EVENT_RECEIVED');
      return;
    }

    // ── POST /manychat — ManyChat External Request → Claude AI reply ───────
    //
    // Receives from ManyChat: { message, first_name, last_name, subscriber_id, brand }
    // Returns: { reply, handoff, brand, status, captured_name, captured_email,
    //            captured_phone, captured_company }
    // ManyChat maps response fields to subscriber custom attributes and
    // routes to handoff flow when handoff == "true".
    if (req.method === 'POST' && req.url === '/manychat') {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch (e) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      const message = String(payload.message || '').trim();
      const firstName = String(payload.first_name || '').trim();
      const lastName = String(payload.last_name || '').trim();
      const subscriberId = String(payload.subscriber_id || payload.subscriber_psid || 'unknown');
      const brandKey = String(payload.brand || 'bazaar').toLowerCase();
      const brand = BRAND_CONFIG[brandKey] || BRAND_CONFIG.bazaar;

      if (!message) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing message' })); return; }

      const history = loadSession(subscriberId);
      const turnNumber = Math.ceil(history.length / 2) + 1;

      // First-turn context injection
      let contextNote = '';
      if (history.length === 0) {
        const nameParts = [firstName, lastName].filter(Boolean);
        if (nameParts.length) contextNote = `[Subscriber name from Instagram: ${nameParts.join(' ')}]\n`;
        if (isAfterHours()) contextNote += `[Context: currently outside business hours PT — team will follow up]\n`;
      }
      if (turnNumber === 3) contextNote += `[Context: turn 3 — this is the last qualification question. After this response, push hard for contact info and handoff.]\n`;
      if (turnNumber >= 4) contextNote += `[DIRECTIVE: turn ${turnNumber} — you MUST wrap up. If you have email or phone, include [HANDOFF: reason="turn limit reached"] now. If not, ask for email/phone and include [HANDOFF:] in this same reply.]\n`;

      const userContent = contextNote ? `${contextNote}${message}` : message;
      history.push({ role: 'user', content: userContent });

      console.log(`📲 DM [${brand.name}] sub=${subscriberId} turn=${turnNumber}: ${message.slice(0, 80)}`);

      callClaudeMultiTurn(brand.systemPrompt, history, (err, rawReply) => {
        if (err) {
          console.error('Claude error:', err.message);
          res.writeHead(500, corsHeaders());
          res.end(JSON.stringify({ error: err.message, status: 'error' }));
          return;
        }

        const parsed = parseClaudeResponse(rawReply);
        history.push({ role: 'assistant', content: parsed.reply });
        saveSession(subscriberId, history);

        // Log knowledge gaps
        parsed.gaps.forEach(q => logKnowledgeGap(brandKey, q, subscriberId));

        const cf = parsed.capturedFields;

        // Push to HubSpot + alert AM as soon as email is captured (deal stage defaults to quoting).
        // Also fires on handoff even without email (phone alone is enough signal).
        // HubSpot push + Twilio AM alert always fire together.
        // Twilio fires from inside pushLeadToHubSpot after deal creation (includes deal ID).
        if (cf.email || (parsed.handoff && cf.phone)) {
          const am = pickAm();
          const stage = parsed.dealStage || 'quoting';
          console.log(`🤝 Lead push → HubSpot (stage: ${stage}) + Twilio to ${am.name}`);
          pushLeadToHubSpot(cf, stage, parsed.spendBand, brand.name, am, parsed.handoffReason);
        }

        if (parsed.handoff) {
          console.log(`🚨 HANDOFF [${brand.name}] sub=${subscriberId}: ${parsed.handoffReason}`);
        }

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          reply: parsed.reply,
          handoff: parsed.handoff ? 'true' : 'false',
          brand: brandKey,
          status: 'ok',
          captured_name: cf.name || '',
          captured_email: cf.email || '',
          captured_phone: cf.phone || '',
          captured_company: cf.company || '',
        }));
      });
      return;
    }

    // ── GET /manychat/gaps — view knowledge gap log ────────────────────────
    if (req.method === 'GET' && req.url === '/manychat/gaps') {
      try {
        if (!fs.existsSync(GAP_LOG_FILE)) { res.writeHead(200, corsHeaders()); res.end(JSON.stringify({ gaps: [], count: 0 })); return; }
        const lines = fs.readFileSync(GAP_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
        const gaps = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ gaps, count: gaps.length }));
      } catch (e) { res.writeHead(500, corsHeaders()); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── GET /manychat/sessions — list active sessions ──────────────────────
    if (req.method === 'GET' && req.url === '/manychat/sessions') {
      try {
        ensureSessionDir();
        const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
        const sessions = files.map(f => {
          const id = f.replace('.json', '');
          try {
            const h = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
            return { subscriberId: id, turns: Math.ceil(h.length / 2), last: h[h.length - 1]?.content?.slice(0, 80) || '' };
          } catch (e) { return { subscriberId: id, turns: 0 }; }
        });
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ sessions, count: sessions.length }));
      } catch (e) { res.writeHead(500, corsHeaders()); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── DELETE /manychat/session/:id — reset a subscriber session ──────────
    if (req.method === 'DELETE' && req.url.startsWith('/manychat/session/')) {
      const subscriberId = req.url.replace('/manychat/session/', '').split('?')[0];
      const filePath = path.join(SESSION_DIR, `${subscriberId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, deleted: subscriberId }));
      } else {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, message: 'Session not found' }));
      }
      return;
    }

    // ── GET /health ────────────────────────────────────────────────────────
    if (req.url === '/health') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'ok', service: 'Pulse Proxy', port: PORT }));
      return;
    }

    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Unknown route' }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Pulse Proxy running at http://localhost:${PORT}`);
  console.log(`   /proxy/slack            → Slack webhooks`);
  console.log(`   /proxy/hubspot/contacts → HubSpot CRM (browser)`);
  console.log(`   /proxy/twilio/sms       → Twilio SMS relay (browser)`);
  console.log(`   /manychat               → ManyChat+Claude DM handler (Bazaar & PixelPress)`);
  console.log(`   /manychat/gaps          → knowledge gap log`);
  console.log(`   /manychat/sessions      → active DM sessions`);
  console.log(`   /health                 → status check`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set');
  if (!process.env.HUBSPOT_TOKEN) console.warn('⚠️  HUBSPOT_TOKEN not set — HubSpot lead push disabled');
  if (!process.env.AM_ERNESTO_PHONE) console.warn('⚠️  AM_ERNESTO_PHONE not set — Twilio AM alerts disabled');
});
