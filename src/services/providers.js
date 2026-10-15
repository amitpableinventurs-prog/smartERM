/**
 * Channel provider adapters for SMS, WhatsApp and voice.
 *
 *   simulated  - nothing leaves the server; messages are logged with status "simulated"
 *   twilio     - SMS, WhatsApp and voice (TwiML)
 *   meta       - WhatsApp Cloud API (graph.facebook.com)
 *   http       - any gateway with an HTTP API (MSG91, Textlocal, Gupshup, Exotel, ...): url + body template
 *
 * Credentials are stored AES-256-GCM encrypted and are never returned to the browser in clear text.
 */
const crypto = require('crypto');
const config = require('../config');
const M = require('../models');
const { render } = require('../utils/helpers');

// ---------- credential sealing ----------
const KEY = crypto.createHash('sha256').update(String(config.encryptionKey || config.jwt.accessSecret)).digest();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj || {}), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function unseal(str) {
  if (!str) return {};
  try {
    const [iv, tag, data] = str.split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
  } catch {
    return {}; // key changed: credentials must be re-entered
  }
}

// Field definitions drive both validation and the settings form in the panel.
const FIELDS = {
  simulated: [],
  twilio: [
    { k: 'accountSid', label: 'Account SID', req: true },
    { k: 'authToken', label: 'Auth token', secret: true, req: true },
  ],
  meta: [
    { k: 'phoneNumberId', label: 'Phone number ID', req: true },
    { k: 'accessToken', label: 'Permanent access token', secret: true, req: true },
    { k: 'verifyToken', label: 'Webhook verify token (you choose it)', secret: true },
    { k: 'appSecret', label: 'App secret (validates webhook signatures)', secret: true },
    { k: 'apiVersion', label: 'Graph API version', placeholder: 'v21.0' },
  ],
  http: [
    { k: 'url', label: 'Request URL (may contain {{to}}, {{body_url}}, {{from}})', secret: true, req: true },
    { k: 'method', label: 'Method', options: ['POST', 'GET'] },
    { k: 'contentType', label: 'Body format', options: ['json', 'form'] },
    { k: 'headers', label: 'Headers as JSON, e.g. {"authkey":"..."}', secret: true, multiline: true },
    { k: 'bodyTemplate', label: 'Body template, e.g. {"to":"{{to}}","text":"{{body}}"}', secret: true, multiline: true },
    { k: 'idPath', label: 'Message id path in the JSON response (e.g. data.id)' },
  ],
};
const ALLOWED = { sms: ['simulated', 'twilio', 'http'], whatsapp: ['simulated', 'twilio', 'meta', 'http'], voice: ['simulated', 'twilio', 'http'] };

const mask = (v) => (v ? '••••' + String(v).slice(-4) : '');
const isMasked = (v) => typeof v === 'string' && v.startsWith('••••');

function maskedConfig(provider, cfg) {
  const out = {};
  for (const f of FIELDS[provider] || []) if (cfg[f.k] != null && cfg[f.k] !== '') out[f.k] = f.secret ? mask(cfg[f.k]) : cfg[f.k];
  return out;
}

// Applies an update from the panel: masked/empty secret values keep what is stored.
function mergeConfig(provider, oldCfg, incoming = {}) {
  const out = {};
  for (const f of FIELDS[provider] || []) {
    const v = incoming[f.k];
    if (f.secret && (v === undefined || isMasked(v) || v === '')) { if (oldCfg[f.k]) out[f.k] = oldCfg[f.k]; continue; }
    if (v !== undefined && v !== '') out[f.k] = String(v).slice(0, 4000);
  }
  if (out.headers) { try { JSON.parse(out.headers); } catch { throw Object.assign(new Error('headers must be valid JSON'), { status: 400 }); } }
  const missing = (FIELDS[provider] || []).filter((f) => f.req && !out[f.k]).map((f) => f.label);
  if (missing.length) throw Object.assign(new Error(`Missing: ${missing.join(', ')}`), { status: 400 });
  return out;
}

// ---------- resolution ----------
async function resolve(company, channel) {
  const p = company && (await M.ChannelProvider.findOne({ company, channel, active: true }).select('+credentials'));
  if (p) return { type: p.provider, from: p.from, cfg: unseal(p.credentials), doc: p };
  // Legacy: Twilio configured in .env keeps working for SMS/WhatsApp.
  if (channel !== 'voice' && config.twilio.sid) {
    return { type: 'twilio', from: channel === 'sms' ? config.twilio.smsFrom : config.twilio.waFrom, cfg: { accountSid: config.twilio.sid, authToken: config.twilio.token } };
  }
  return { type: 'simulated' };
}

const callbackUrl = (prov, path) => (config.publicUrl && prov.doc ? `${config.publicUrl}/api/webhooks/comm/${prov.doc.webhookToken}/${path}` : undefined);

// ---------- HTTP helpers ----------
async function post(url, { headers = {}, form, json, method = 'POST' }) {
  const res = await fetch(url, {
    method,
    headers: { ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: method === 'GET' ? undefined : form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status}: ${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 240)}`);
  return data;
}

const twilioAuth = (cfg) => ({ Authorization: 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64') });
const getPath = (o, p) => (p ? p.split('.').reduce((x, k) => (x == null ? x : x[k]), o) : undefined);

// Renders a template, escaping values for where they end up (URL, JSON string or form value).
function fill(tpl, vars, mode) {
  const esc = mode === 'url' ? encodeURIComponent : mode === 'json' ? (v) => JSON.stringify(String(v)).slice(1, -1) : (v) => v;
  return render(tpl, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, esc(v ?? '')])));
}

async function httpGateway(cfg, vars) {
  const url = fill(cfg.url, vars, 'url');
  const method = cfg.method === 'GET' ? 'GET' : 'POST';
  const headers = cfg.headers ? JSON.parse(cfg.headers) : {};
  let data;
  if (method === 'GET' || !cfg.bodyTemplate) data = await post(url, { headers, method });
  else if (cfg.contentType === 'form') {
    const pairs = fill(cfg.bodyTemplate, vars, 'url');
    data = await post(url, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, method, json: undefined, form: Object.fromEntries(new URLSearchParams(pairs)) });
  } else data = await post(url, { headers, method, json: JSON.parse(fill(cfg.bodyTemplate, vars, 'json')) });
  return String(getPath(data, cfg.idPath) ?? '') || undefined;
}

const gatewayVars = (prov, to, extra) => ({ to, to_digits: to.replace(/\D/g, ''), to_national: to.replace(/\D/g, '').slice(-10), from: prov.from || '', ...extra });

// ---------- messages ----------
// Returns { status: 'sent' | 'simulated', providerId }. Throws on provider errors.
async function sendMessage(prov, channel, to, body, opts = {}) {
  if (prov.type === 'simulated') return { status: 'simulated', providerId: 'sim_' + crypto.randomBytes(8).toString('hex') };
  const cfg = prov.cfg;
  if (prov.type === 'twilio') {
    const wa = channel === 'whatsapp';
    const form = { To: wa ? `whatsapp:${to}` : to, From: wa && !String(prov.from).startsWith('whatsapp:') ? `whatsapp:${prov.from}` : prov.from };
    if (wa && opts.waTemplate?.name) {
      form.ContentSid = opts.waTemplate.name; // Twilio content template SID (HX...)
      form.ContentVariables = JSON.stringify(Object.fromEntries((opts.waTemplate.params || []).map((v, i) => [String(i + 1), v])));
    } else form.Body = body;
    if (opts.mediaUrl) form.MediaUrl = opts.mediaUrl;
    const cb = callbackUrl(prov, 'status');
    if (cb) form.StatusCallback = cb;
    const r = await post(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, { headers: twilioAuth(cfg), form });
    return { status: 'sent', providerId: r.sid };
  }
  if (prov.type === 'meta') {
    if (channel !== 'whatsapp') throw new Error('Meta provider only supports WhatsApp');
    const msg = { messaging_product: 'whatsapp', to: to.replace(/\D/g, '') };
    if (opts.waTemplate?.name) {
      msg.type = 'template';
      msg.template = { name: opts.waTemplate.name, language: { code: opts.waTemplate.language || 'en' } };
      if (opts.waTemplate.params?.length) msg.template.components = [{ type: 'body', parameters: opts.waTemplate.params.map((text) => ({ type: 'text', text: String(text) })) }];
    } else if (opts.mediaUrl) {
      msg.type = 'image';
      msg.image = { link: opts.mediaUrl, caption: body };
    } else {
      msg.type = 'text';
      msg.text = { body, preview_url: true };
    }
    const r = await post(`https://graph.facebook.com/${cfg.apiVersion || 'v21.0'}/${cfg.phoneNumberId}/messages`, { headers: { Authorization: `Bearer ${cfg.accessToken}` }, json: msg });
    return { status: 'sent', providerId: r.messages?.[0]?.id };
  }
  if (prov.type === 'http') {
    const providerId = await httpGateway(cfg, gatewayVars(prov, to, { body, body_url: body, channel, media_url: opts.mediaUrl || '' }));
    return { status: 'sent', providerId };
  }
  throw new Error(`Unknown provider ${prov.type}`);
}

// ---------- voice ----------
// answerUrl must be publicly reachable; the provider fetches TwiML from it when the call is answered.
async function placeCall(prov, to, { answerUrl, statusUrl }) {
  if (prov.type === 'simulated') return { status: 'simulated', providerId: 'simcall_' + crypto.randomBytes(8).toString('hex') };
  if (!answerUrl || !/^https?:\/\//.test(answerUrl)) throw new Error('Set PUBLIC_URL in .env so the voice provider can reach this server');
  const cfg = prov.cfg;
  if (prov.type === 'twilio') {
    const form = { To: to, From: prov.from, Url: answerUrl, Method: 'POST', Timeout: '30' };
    if (statusUrl) { form.StatusCallback = statusUrl; form.StatusCallbackMethod = 'POST'; }
    const r = await post(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, { headers: twilioAuth(cfg), form });
    return { status: 'queued', providerId: r.sid };
  }
  if (prov.type === 'http') {
    const providerId = await httpGateway(cfg, gatewayVars(prov, to, { answer_url: answerUrl, status_url: statusUrl || '', body: '', body_url: '' }));
    return { status: 'queued', providerId };
  }
  throw new Error(`${prov.type} does not support voice calls`);
}

// ---------- webhook verification ----------
const safeEqual = (a = '', b = '') => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// https://www.twilio.com/docs/usage/security#validating-requests
function twilioSignatureOk(authToken, url, params, signature) {
  const data = url + Object.keys(params || {}).sort().map((k) => k + params[k]).join('');
  return safeEqual(crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64'), signature);
}

function metaSignatureOk(appSecret, rawBody, header) {
  if (!rawBody) return false;
  return safeEqual('sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'), header);
}

module.exports = {
  seal, unseal, FIELDS, ALLOWED, maskedConfig, mergeConfig, resolve, sendMessage, placeCall, callbackUrl,
  twilioSignatureOk, metaSignatureOk, safeEqual,
};
