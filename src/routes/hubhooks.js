/**
 * Public webhooks for SMS / WhatsApp / voice providers: /api/webhooks/comm/:token/...
 * The token is per company and channel (Communication Hub > Providers shows the full URLs).
 *
 *   POST /sms, /whatsapp     inbound message   (Twilio form, Meta JSON, or generic JSON {from, body, name, id})
 *   GET  /whatsapp           Meta webhook verification
 *   POST /status             delivery receipt  (Twilio MessageStatus, or generic {id, status, error})
 *   POST /voice              call answered (inbound, or ?call= for outbound IVR) -> TwiML
 *   POST /voice/step         caller input -> TwiML
 *   POST /voice/status       call ended
 */
const express = require('express');
const M = require('../models');
const config = require('../config');
const providers = require('../services/providers');
const inbox = require('../services/inbox');
const ivr = require('../services/ivr');
const { HttpError } = require('../utils/helpers');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '1mb' }));

async function load(req, channels) {
  const p = await M.ChannelProvider.findOne({ webhookToken: String(req.params.token) }).select('+credentials');
  if (!p || (channels && !channels.includes(p.channel))) throw new HttpError(404, 'Unknown webhook');
  const cfg = providers.unseal(p.credentials);
  // Twilio signs every request; verify it when we know our public URL.
  if (p.provider === 'twilio' && config.publicUrl && cfg.authToken && !providers.twilioSignatureOk(cfg.authToken, config.publicUrl + req.originalUrl, req.body, req.get('x-twilio-signature'))) {
    throw new HttpError(403, 'Invalid Twilio signature');
  }
  if (p.provider === 'meta' && req.method === 'POST' && cfg.appSecret && !providers.metaSignatureOk(cfg.appSecret, req.rawBody, req.get('x-hub-signature-256'))) {
    throw new HttpError(403, 'Invalid signature');
  }
  return { p, cfg };
}

const twimlOk = (res) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
const later = (fn) => setImmediate(() => fn().catch((e) => console.error('[hub webhook]', e.message)));
const s = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));

// ---------- messages ----------
async function message(req, res, channel) {
  const { p } = await load(req, [channel]);
  const company = p.company;
  if (p.provider === 'twilio') {
    if (!req.body.From) return twimlOk(res);
    // Acknowledge at once (Twilio times out after 15s); the AI reply goes out through the API.
    later(() => inbox.handleInbound({ company, channel, from: req.body.From, body: s(req.body.Body) || (req.body.NumMedia > 0 ? '[media]' : ''), name: s(req.body.ProfileName, 80), providerId: s(req.body.MessageSid, 80) }));
    return twimlOk(res);
  }
  if (p.provider === 'meta') {
    res.sendStatus(200);
    later(async () => {
      for (const entry of req.body?.entry || []) for (const ch of entry.changes || []) {
        const v = ch.value || {};
        for (const st of v.statuses || []) await inbox.deliveryStatus(company, st.id, st.status, st.errors?.[0]?.title);
        for (const m of v.messages || []) {
          const body = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || `[${m.type}]`;
          const name = (v.contacts || []).find((c) => c.wa_id === m.from)?.profile?.name;
          await inbox.handleInbound({ company, channel, from: '+' + m.from, body: s(body), name: s(name, 80), providerId: s(m.id, 120) });
        }
      }
    });
    return;
  }
  // Generic gateway / testing: synchronous, returns the AI reply.
  const from = s(req.body?.from || req.body?.sender || req.body?.mobile, 40);
  if (!from) throw new HttpError(400, 'from is required');
  const r = await inbox.handleInbound({ company, channel, from, body: s(req.body.body || req.body.message || req.body.text) || '', name: s(req.body.name, 80), providerId: s(req.body.id, 120) });
  res.status(201).json({ ok: true, duplicate: !!r.duplicate, reply: r.reply, intent: r.intent, handoff: r.handoff, conversation: r.conversation?._id, contact: r.contact, createdLead: r.createdLead });
}

router.post('/:token/sms', (req, res) => message(req, res, 'sms'));
router.post('/:token/whatsapp', (req, res) => message(req, res, 'whatsapp'));

router.get('/:token/whatsapp', async (req, res) => {
  const { cfg } = await load(req, ['whatsapp']);
  if (req.query['hub.mode'] === 'subscribe' && cfg.verifyToken && providers.safeEqual(req.query['hub.verify_token'], cfg.verifyToken)) return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  res.sendStatus(403);
});

router.post('/:token/status', async (req, res) => {
  const { p } = await load(req, ['sms', 'whatsapp']);
  const b = req.body || {};
  const id = b.MessageSid || b.SmsSid || b.id || b.message_id;
  const status = b.MessageStatus || b.SmsStatus || b.status;
  await inbox.deliveryStatus(p.company, s(id, 120), s(status, 30), s(b.ErrorMessage || b.ErrorCode || b.error, 300));
  if (p.provider === 'twilio') return twimlOk(res);
  res.json({ ok: true });
});

// ---------- voice ----------
const base = (req) => `/api/webhooks/comm/${req.params.token}`;
const twiml = (res, req, flow, call, verbs) => res.type('text/xml').send(ivr.toTwiml(verbs, { base: base(req), callId: call._id, voice: flow?.voice, language: flow?.language }));
const sayOnly = (res, text) => res.type('text/xml').send(ivr.toTwiml([{ say: text }, { hangup: true }], { base: '', callId: '' }));
const params = (req) => ({ ...req.query, ...req.body });

router.post('/:token/voice', async (req, res) => {
  const { p } = await load(req, ['voice']);
  const q = params(req);
  if (q.test) return sayOnly(res, 'This is a test call from your CRM. Your voice provider is connected. Goodbye.');
  let call, flow;
  if (q.call) {
    call = /^[a-f\d]{24}$/i.test(q.call) && (await M.IvrCall.findOne({ _id: q.call, company: p.company }));
    if (!call) return sayOnly(res, 'Goodbye.');
    flow = await M.IvrFlow.findById(call.flow);
    if (q.CallSid) call.providerId = s(q.CallSid, 80);
  } else {
    flow = await ivr.inboundFlow(p.company, p);
    if (!flow) return sayOnly(res, 'Thank you for calling. Please try again later.');
    call = await ivr.startInbound(p.company, flow, q.From || q.from, { providerId: s(q.CallSid, 80) });
  }
  if (!flow) return sayOnly(res, 'Goodbye.');
  twiml(res, req, flow, call, await ivr.begin(call, flow));
});

router.post('/:token/voice/step', async (req, res) => {
  const { p } = await load(req, ['voice']);
  const q = params(req);
  const call = /^[a-f\d]{24}$/i.test(q.call || '') && (await M.IvrCall.findOne({ _id: q.call, company: p.company }));
  if (!call) return sayOnly(res, 'Goodbye.');
  const flow = await M.IvrFlow.findById(call.flow);
  if (!flow) return sayOnly(res, 'Goodbye.');
  const verbs = await ivr.step(call, flow, s(q.node, 40), {
    digits: s(q.Digits, 5), speech: s(q.SpeechResult, 1000), noinput: q.noinput === '1',
    recordingUrl: s(q.RecordingUrl, 500), dialStatus: q.dial ? s(q.DialCallStatus, 30) || 'no-answer' : undefined,
  });
  twiml(res, req, flow, call, verbs);
});

router.post('/:token/voice/status', async (req, res) => {
  const { p } = await load(req, ['voice']);
  const q = params(req);
  const call = q.call && /^[a-f\d]{24}$/i.test(q.call)
    ? await M.IvrCall.findOne({ _id: q.call, company: p.company })
    : q.CallSid && (await M.IvrCall.findOne({ company: p.company, providerId: s(q.CallSid, 80) }));
  const st = String(q.CallStatus || q.status || '').toLowerCase();
  if (call && ivr.CALL_STATUS[st]) await ivr.finishCall(call, { status: st, durationSec: q.CallDuration ?? q.duration });
  else if (call && ['ringing', 'in-progress'].includes(st) && !call.finished) { call.status = st === 'ringing' ? 'ringing' : 'in_progress'; await call.save(); }
  twimlOk(res);
});

module.exports = router;
