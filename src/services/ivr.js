/**
 * IVR engine. A flow is a set of nodes; the engine walks them and returns provider-neutral "verbs":
 *   { say }  { gather: { input: 'dtmf'|'speech', node, prompt } }  { redirect: { node, noinput } }
 *   { dial: { number, node } }  { record: { node, maxSeconds } }  { hangup: true }
 * toTwiml() turns verbs into Twilio TwiML; the panel's call simulator shows them as a phone screen.
 *
 * Node types (every node may also have `intent` and `actions`, run when the node is entered):
 *   say        { text, next }
 *   menu       { text?, options: [{ digit, label, next, intent }], retries?, noInputNext? }
 *   ai         { text (greeting), goal, maxTurns, next, handoffNext }   speech conversation with the AI assistant
 *   transfer   { text, number, next (if nobody answers) }
 *   voicemail  { text, maxSeconds, next }
 *   hangup     { text }
 */
const M = require('../models');
const ai = require('./ai');
const bot = require('./bot');
const contacts = require('./contacts');
const inbox = require('./inbox');
const providers = require('./providers');
const config = require('../config');
const { logActivity, emit } = require('./events');
const { HttpError } = require('../utils/helpers');
const { normalize } = require('../utils/phone');

const NODE_TYPES = ['say', 'menu', 'ai', 'transfer', 'voicemail', 'hangup'];
const MAX_CHAIN = 25;
const ID_RE = /^[\w-]{1,40}$/;

// ---------- validation ----------
function validateFlow({ start, nodes }) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 100) throw new HttpError(400, 'A flow needs 1-100 nodes');
  const str = (v, max = 1000) => (v == null || v === '' ? undefined : String(v).slice(0, max));
  const ids = new Set();
  const clean = nodes.map((n, i) => {
    if (!n || !ID_RE.test(n.id || '')) throw new HttpError(400, `Node ${i + 1}: id must be letters, digits, - or _`);
    if (ids.has(n.id)) throw new HttpError(400, `Duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) throw new HttpError(400, `Node "${n.id}": type must be one of ${NODE_TYPES.join(', ')}`);
    if (n.intent && !bot.INTENTS[n.intent]) throw new HttpError(400, `Node "${n.id}": unknown intent ${n.intent}`);
    const out = { id: n.id, type: n.type, label: str(n.label, 80), text: str(n.text), next: str(n.next, 40), intent: str(n.intent, 40) };
    if (Array.isArray(n.actions) && n.actions.length) {
      out.actions = n.actions.filter((a) => a && bot.ACTION_TYPES.includes(a.type)).slice(0, 10);
    }
    if (n.type === 'menu') {
      const opts = (n.options || []).filter((o) => o && o.digit !== '' && o.digit != null);
      if (!opts.length) throw new HttpError(400, `Menu "${n.id}" needs at least one option`);
      const digits = new Set();
      out.options = opts.map((o) => {
        const d = String(o.digit);
        if (!/^[0-9*#]$/.test(d)) throw new HttpError(400, `Menu "${n.id}": digit must be 0-9, * or #`);
        if (digits.has(d)) throw new HttpError(400, `Menu "${n.id}": digit ${d} used twice`);
        if (o.intent && !bot.INTENTS[o.intent]) throw new HttpError(400, `Menu "${n.id}": unknown intent ${o.intent}`);
        digits.add(d);
        return { digit: d, label: str(o.label, 80), next: str(o.next, 40), intent: str(o.intent, 40) };
      });
      out.retries = Math.min(5, Math.max(0, +n.retries || 2));
      out.noInputNext = str(n.noInputNext, 40);
    }
    if (n.type === 'ai') {
      out.goal = str(n.goal, 500);
      out.maxTurns = Math.min(10, Math.max(1, +n.maxTurns || 4));
      out.handoffNext = str(n.handoffNext, 40);
    }
    if (n.type === 'transfer') {
      out.number = normalize(n.number);
      if (!out.number) throw new HttpError(400, `Transfer "${n.id}" needs a phone number`);
    }
    if (n.type === 'voicemail') out.maxSeconds = Math.min(300, Math.max(5, +n.maxSeconds || 60));
    return out;
  });
  if (!ids.has(start)) throw new HttpError(400, 'Start node does not exist');
  for (const n of clean) {
    for (const ref of [n.next, n.noInputNext, n.handoffNext, ...(n.options || []).map((o) => o.next)]) {
      if (ref && !ids.has(ref)) throw new HttpError(400, `Node "${n.id}" points to missing node "${ref}"`);
    }
  }
  return clean;
}

// ---------- engine ----------
const find = (flow, id) => flow.nodes.find((n) => n.id === id);

function speak(call, text) {
  if (!text) return [];
  call.transcript.push({ role: 'bot', text });
  return [{ say: text }];
}

function end(call, text) {
  return [...speak(call, text), { hangup: true }];
}

const menuText = (n) => n.text || n.options.map((o) => `Press ${o.digit}${o.label ? ` for ${o.label}` : ''}`).join('. ') + '.';

function menuPrompt(call, n) {
  const text = menuText(n);
  call.transcript.push({ role: 'bot', text });
  return [{ gather: { input: 'dtmf', numDigits: 1, timeout: 6, node: n.id, prompt: text } }, { redirect: { node: n.id, noinput: true } }];
}

function listen(call, n, prompt) {
  if (prompt) call.transcript.push({ role: 'bot', text: prompt });
  return [{ gather: { input: 'speech', timeout: 5, node: n.id, prompt: prompt || '' } }, { redirect: { node: n.id, noinput: true } }];
}

async function markIntent(call, intent, message, entities) {
  if (!intent || !bot.INTENTS[intent]) return;
  call.intent = intent;
  if (intent === 'opt_out') await contacts.optOut(call.company, call.phone, { channel: 'all', reason: 'IVR', source: 'ivr' });
  if (call.appliedIntents.includes(intent)) return;
  call.appliedIntents.push(intent);
  await inbox.applyIntent(call.company, call.contact?.id ? call.contact : null, intent, { channel: 'ivr call', message, entities, call });
}

async function enter(call, flow, id, depth = 0) {
  const n = find(flow, id);
  if (!n || depth > MAX_CHAIN) return end(call, 'Thank you for calling. Goodbye.');
  call.currentNode = n.id;
  call.path.push({ node: n.id });
  if (n.intent) await markIntent(call, n.intent, n.label || n.id);
  if (n.actions?.length && call.contact?.id) await inbox.runMapped(call.company, call.contact, n.actions, { channel: 'ivr call', call, intent: n.intent || n.id });
  switch (n.type) {
    case 'say': return [...speak(call, n.text), ...(n.next ? await enter(call, flow, n.next, depth + 1) : end(call))];
    case 'menu': return menuPrompt(call, n);
    case 'ai': return listen(call, n, n.text || 'How can I help you today?');
    case 'transfer': return [...speak(call, n.text || 'Please hold while we connect you.'), { dial: { number: n.number, node: n.id, timeout: 25 } }];
    case 'voicemail': return [...speak(call, n.text || 'Please leave your message after the beep.'), { record: { node: n.id, maxSeconds: n.maxSeconds || 60 } }];
    default: return end(call, n.text);
  }
}

async function retry(call, flow, n, msg) {
  const r = { ...(call.retries || {}) };
  r[n.id] = (r[n.id] || 0) + 1;
  call.retries = r;
  call.markModified('retries');
  if (r[n.id] > (n.retries ?? 2)) return n.noInputNext ? enter(call, flow, n.noInputNext) : n.type === 'ai' && n.next ? enter(call, flow, n.next) : end(call, 'We did not receive a response. Goodbye.');
  return [...speak(call, msg), ...(n.type === 'ai' ? listen(call, n, 'Could you please repeat that?') : menuPrompt(call, n))];
}

// The caller did something on node `nodeId`: pressed a key, spoke, finished a transfer or a recording.
async function input(call, flow, nodeId, { digits, speech, noinput, recordingUrl, dialStatus } = {}) {
  const n = find(flow, nodeId || call.currentNode);
  if (!n) return end(call, 'Goodbye.');
  call.currentNode = n.id;

  if (n.type === 'menu') {
    const d = noinput ? '' : String(digits ?? '').trim().slice(0, 1);
    const opt = d && n.options.find((o) => o.digit === d);
    if (d) {
      call.digits += d;
      call.transcript.push({ role: 'caller', text: `pressed ${d}${opt?.label ? ` (${opt.label})` : ''}` });
      call.path.push({ node: n.id, input: d });
    }
    if (!opt) return retry(call, flow, n, d ? 'Sorry, that is not a valid option.' : 'Sorry, we did not receive any input.');
    if (opt.intent) await markIntent(call, opt.intent, opt.label || `pressed ${d}`);
    return opt.next ? enter(call, flow, opt.next) : end(call, 'Thank you. Goodbye.');
  }

  if (n.type === 'ai') {
    const text = noinput ? '' : String(speech ?? '').trim().slice(0, 1000);
    if (!text) return retry(call, flow, n, 'Sorry, I could not hear you.');
    call.transcript.push({ role: 'caller', text });
    call.path.push({ node: n.id, input: text.slice(0, 80) });
    const cfg = await bot.getConfig(call.company);
    const doc = call.contact?.id && (await M[call.contact.kind].findById(call.contact.id).select('name status lifecycle'));
    const history = call.transcript.slice(-11, -1).map((t) => ({ role: t.role, text: t.text }));
    const r = await bot.respond({
      cfg, company: await inbox.companyName(call.company), channel: 'voice', text, history, goal: n.goal,
      contact: doc && { name: doc.name, kind: call.contact.kind, status: doc.status || doc.lifecycle },
    });
    call.aiTurns += 1;
    call.sentiment = r.sentiment;
    await markIntent(call, r.intent, text, r.entities);
    await inbox.learnEntities(call.contact?.id ? call.contact : null, r.entities);
    if (bot.CONCLUSIVE.includes(r.intent)) return [...speak(call, r.reply), ...(n.next && r.intent === 'callback' ? await enter(call, flow, n.next) : end(call, 'Thank you for your time. Goodbye.'))];
    if (r.handoff) return [...speak(call, r.reply), ...(n.handoffNext ? await enter(call, flow, n.handoffNext) : n.next ? await enter(call, flow, n.next) : end(call, 'Our team will call you back shortly. Goodbye.'))];
    if (call.aiTurns >= (n.maxTurns || 4)) return [...speak(call, r.reply), ...(n.next ? await enter(call, flow, n.next) : end(call, 'Thank you for your time. Goodbye.'))];
    return listen(call, n, r.reply);
  }

  if (n.type === 'transfer') {
    const ok = ['completed', 'answered'].includes(String(dialStatus || '').toLowerCase());
    call.transcript.push({ role: 'system', text: `transfer to ${n.number}: ${dialStatus || 'no answer'}` });
    if (ok) return end(call);
    return n.next ? enter(call, flow, n.next) : end(call, 'Sorry, no one is available right now. We will call you back.');
  }

  if (n.type === 'voicemail') {
    if (recordingUrl) call.recordingUrl = String(recordingUrl).slice(0, 500);
    call.transcript.push(speech ? { role: 'caller', text: `(voicemail) ${String(speech).slice(0, 1000)}` } : { role: 'system', text: 'voicemail recorded' });
    return n.next ? enter(call, flow, n.next) : end(call, 'Thank you. We will get back to you soon. Goodbye.');
  }
  return end(call);
}

// ---------- call lifecycle ----------
async function mapContact(company, phone, { kind, id, source = 'ivr' } = {}) {
  if (kind && id) return { kind, id };
  const cfg = await bot.getConfig(company);
  const hit = await contacts.findByPhone(company, phone);
  if (hit) return contacts.ref(hit);
  if (!cfg.autoCreateLeads) return undefined;
  const c = await contacts.createLead(company, phone, { source });
  await logActivity(company, contacts.ref(c), 'lead.created', 'New lead from IVR call');
  emit(company, 'lead.created', contacts.ref(c));
  return contacts.ref(c);
}

// Saves the call and closes it when the verbs end it.
async function settle(call, verbs) {
  if (verbs.some((v) => v.hangup)) await finishCall(call, { status: 'completed' });
  else await call.save();
  return verbs;
}

async function begin(call, flow) {
  call.status = 'in_progress';
  call.startedAt = call.startedAt || new Date();
  return settle(call, await enter(call, flow, flow.start));
}

async function step(call, flow, nodeId, inp) {
  if (call.finished) return [{ hangup: true }];
  return settle(call, await input(call, flow, nodeId, inp));
}

const CALL_STATUS = { completed: 'completed', busy: 'busy', 'no-answer': 'no_answer', no_answer: 'no_answer', failed: 'failed', canceled: 'no_answer', cancelled: 'no_answer' };

async function finishCall(call, { status = 'completed', durationSec } = {}) {
  if (durationSec != null && Number.isFinite(+durationSec)) call.durationSec = +durationSec;
  if (call.finished) {
    await call.save();
    if (durationSec != null) await M.Communication.updateOne({ company: call.company, call: call._id }, { durationSec: call.durationSec }).catch(() => {});
    return call;
  }
  call.finished = true;
  call.status = CALL_STATUS[status] || 'completed';
  call.endedAt = new Date();
  if (call.durationSec == null && call.startedAt) call.durationSec = Math.round((call.endedAt - call.startedAt) / 1000);
  const text = call.transcript.map((t) => `${t.role === 'caller' ? 'Caller' : t.role === 'bot' ? 'IVR' : '-'}: ${t.text}`).join('\n');
  const spoken = call.transcript.filter((t) => t.role === 'caller' && !t.text.startsWith('pressed ')).map((t) => t.text).join(' ');
  if (call.transcript.some((t) => t.role === 'caller')) {
    call.summary = (await ai.summarize(text)).text;
    if (!call.sentiment && spoken) call.sentiment = (await ai.sentiment(spoken)).sentiment;
  }
  await call.save();
  const answered = call.status === 'completed' && call.path.length > 0;
  await M.Communication.create({
    company: call.company, channel: 'call', direction: call.direction, bot: true,
    to: call.direction === 'outbound' ? call.phone : undefined, from: call.direction === 'inbound' ? call.phone : undefined,
    subject: `IVR call${call.intent ? ` · ${call.intent}` : ''}`, body: text.slice(0, 20000), summary: call.summary, sentiment: call.sentiment,
    durationSec: call.durationSec, status: call.status, call: call._id, relatedTo: call.contact?.id ? call.contact : undefined, broadcast: call.broadcast, intent: call.intent,
  });
  if (call.recipient) {
    await M.BroadcastRecipient.updateOne({ _id: call.recipient }, answered ? { answered: true, status: 'delivered' } : { status: 'failed', error: call.status });
    await require('./bulk').refreshStats(call.broadcast);
  }
  if (call.contact?.id) {
    const now = new Date();
    if (call.contact.kind === 'Lead') await M.Lead.updateOne({ _id: call.contact.id }, { lastContactedAt: now });
    else await M.Customer.updateOne({ _id: call.contact.id }, { lastActivityAt: now });
    if (answered && call.contact.kind === 'Lead') await M.Lead.updateOne({ _id: call.contact.id, status: 'new' }, { status: 'contacted' });
    await logActivity(call.company, call.contact, 'call.completed', `IVR ${call.direction} call ${call.status}${call.intent ? ` · ${call.intent}` : ''} (${call.durationSec || 0}s)`);
    emit(call.company, 'call.completed', call.contact, { intent: call.intent, digits: call.digits, status: call.status, durationSec: call.durationSec, direction: call.direction });
  }
  return call;
}

// Places an outbound IVR call (from a broadcast, the panel or the simulator).
async function dial(company, flow, phone, { contact, broadcast, recipient } = {}) {
  const prov = await providers.resolve(company, 'voice');
  const to = normalize(phone);
  if (!to) throw new HttpError(400, 'Invalid phone number');
  if (await contacts.isOptedOut(company, to, 'voice')) throw new HttpError(409, 'Number is on the DND list');
  const call = await M.IvrCall.create({ company, flow: flow._id, direction: 'outbound', phone: to, contact, broadcast, recipient, simulated: prov.type === 'simulated' });
  try {
    const base = config.publicUrl && prov.doc ? `${config.publicUrl}/api/webhooks/comm/${prov.doc.webhookToken}` : '';
    const r = await providers.placeCall(prov, to, { answerUrl: base && `${base}/voice?call=${call._id}`, statusUrl: base && `${base}/voice/status?call=${call._id}` });
    call.providerId = r.providerId;
    call.status = r.status === 'simulated' ? 'simulated' : 'queued';
    await call.save();
  } catch (e) {
    call.status = 'failed';
    call.finished = true;
    call.transcript.push({ role: 'system', text: e.message });
    await call.save();
    throw Object.assign(e, { call });
  }
  return call;
}

async function startInbound(company, flow, phone, { providerId, simulated } = {}) {
  const p = normalize(phone);
  const contact = await mapContact(company, p);
  const call = await M.IvrCall.create({ company, flow: flow?._id, direction: 'inbound', phone: p, contact, providerId, simulated: !!simulated, startedAt: new Date() });
  return call;
}

async function inboundFlow(company, provider) {
  if (provider?.inboundFlow) {
    const f = await M.IvrFlow.findOne({ _id: provider.inboundFlow, company, active: true });
    if (f) return f;
  }
  return (await M.IvrFlow.findOne({ company, active: true, isDefaultInbound: true })) || M.IvrFlow.findOne({ company, active: true }).sort('createdAt');
}

// ---------- TwiML ----------
const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function toTwiml(verbs, { base, callId, voice = 'Polly.Aditi', language = 'en-IN' }) {
  const url = (node, extra = '') => xml(`${base}/voice/step?call=${callId}&node=${encodeURIComponent(node)}${extra}`);
  const say = (t) => (t ? `<Say voice="${xml(voice)}" language="${xml(language)}">${xml(t)}</Say>` : '');
  const body = verbs.map((v) => {
    if (v.say) return say(v.say);
    if (v.gather) {
      const g = v.gather;
      const attrs = g.input === 'dtmf' ? `input="dtmf" numDigits="${g.numDigits || 1}"` : `input="speech" speechTimeout="auto" language="${xml(language)}"`;
      return `<Gather ${attrs} timeout="${g.timeout || 5}" action="${url(g.node)}" method="POST">${say(g.prompt)}</Gather>`;
    }
    if (v.redirect) return `<Redirect method="POST">${url(v.redirect.node, v.redirect.noinput ? '&noinput=1' : '')}</Redirect>`;
    if (v.dial) return `<Dial action="${url(v.dial.node, '&dial=1')}" method="POST" timeout="${v.dial.timeout || 25}">${xml(v.dial.number)}</Dial>`;
    if (v.record) return `<Record action="${url(v.record.node)}" method="POST" maxLength="${v.record.maxSeconds || 60}" playBeep="true"/>`;
    if (v.hangup) return '<Hangup/>';
    return '';
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

// A ready-made flow to start from in the panel.
const SAMPLE_FLOW = {
  name: 'Main menu',
  start: 'welcome',
  nodes: [
    { id: 'welcome', type: 'say', text: 'Welcome! This call may be recorded for quality.', next: 'menu' },
    { id: 'menu', type: 'menu', options: [
      { digit: '1', label: 'Sales', next: 'sales_ai', intent: 'interested' },
      { digit: '2', label: 'Support', next: 'support' },
      { digit: '3', label: 'a call back', next: 'callback', intent: 'callback' },
      { digit: '9', label: 'stop receiving calls', next: 'bye_dnd', intent: 'opt_out' },
    ] },
    { id: 'sales_ai', type: 'ai', text: 'Great! Tell me briefly what you are looking for.', goal: 'Understand the requirement and budget, answer from the knowledge base, and offer a call back from a specialist.', maxTurns: 4, next: 'thanks' },
    { id: 'support', type: 'transfer', text: 'Connecting you to our support team.', number: '+910000000000', next: 'voicemail' },
    { id: 'voicemail', type: 'voicemail', text: 'Our team is busy. Please leave a message after the beep.', next: 'thanks' },
    { id: 'callback', type: 'hangup', text: 'Thank you! Our team will call you back shortly. Goodbye.' },
    { id: 'bye_dnd', type: 'hangup', text: 'You will not receive further calls from us. Goodbye.' },
    { id: 'thanks', type: 'hangup', text: 'Thank you for calling. Have a great day!' },
  ],
};

module.exports = { NODE_TYPES, validateFlow, enter, input, begin, step, finishCall, dial, startInbound, inboundFlow, mapContact, toTwiml, SAMPLE_FLOW, CALL_STATUS };
