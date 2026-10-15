/**
 * Bulk SMS / WhatsApp / IVR broadcasts.
 *
 * Recipients come from the CRM (lead/customer filter) or a CSV upload. Every CSV number is mapped to
 * an existing lead/customer or becomes a new lead, so all replies, calls and outcomes land on CRM records.
 * Sending is throttled (ratePerMinute) and driven by the scheduler; DND numbers are skipped.
 */
const M = require('../models');
const comm = require('./communication');
const contacts = require('./contacts');
const { safeFilter } = require('./campaigns');
const { logActivity, emit } = require('./events');
const { render, parseCsv, HttpError } = require('../utils/helpers');
const { normalize } = require('../utils/phone');

const MAX_RECIPIENTS = 50000;
const MAX_CSV_ROWS = 10000;
const STUCK_MS = 10 * 60e3;
const PHONE_COLS = ['phone', 'mobile', 'number', 'phone_number', 'mobile_number', 'whatsapp', 'contact'];

async function refreshStats(broadcastId) {
  if (!broadcastId) return;
  const rows = await M.BroadcastRecipient.aggregate([
    { $match: { broadcast: broadcastId } },
    { $group: { _id: '$status', n: { $sum: 1 }, replied: { $sum: { $cond: ['$replied', 1, 0] } }, answered: { $sum: { $cond: ['$answered', 1, 0] } }, optedOut: { $sum: { $cond: ['$optedOut', 1, 0] } } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const stats = {
    total: rows.reduce((s, r) => s + r.n, 0),
    queued: (by.queued || 0) + (by.sending || 0),
    sent: (by.sent || 0) + (by.delivered || 0) + (by.read || 0),
    delivered: (by.delivered || 0) + (by.read || 0),
    read: by.read || 0,
    failed: by.failed || 0,
    skipped: by.skipped || 0,
    replied: sum('replied'),
    answered: sum('answered'),
    optedOut: sum('optedOut'),
  };
  await M.Broadcast.updateOne({ _id: broadcastId }, { stats });
  return stats;
}

async function addRecipients(b, rows) {
  const existing = new Set((await M.BroadcastRecipient.find({ broadcast: b._id }).select('phone')).map((r) => r.phone));
  if (existing.size + rows.length > MAX_RECIPIENTS) throw new HttpError(400, `A broadcast can have at most ${MAX_RECIPIENTS} recipients`);
  const fresh = [];
  let duplicates = 0;
  for (const r of rows) {
    if (existing.has(r.phone)) { duplicates++; continue; }
    existing.add(r.phone);
    fresh.push({ company: b.company, broadcast: b._id, ...r });
  }
  if (fresh.length) await M.BroadcastRecipient.insertMany(fresh, { ordered: false });
  await refreshStats(b._id);
  return { added: fresh.length, duplicates };
}

// Audience from the CRM: { model: 'Lead'|'Customer', filter: {status: ...}, tags: [] }
async function addFromCrm(b, { model = 'Lead', filter = {}, tags = [] } = {}) {
  const Model = model === 'Customer' ? M.Customer : M.Lead;
  const q = { company: b.company, ...safeFilter(filter), phone: { $nin: [null, ''] } };
  if (tags?.length) q.tags = { $in: tags };
  const people = await Model.find(q).select('name phone').limit(MAX_RECIPIENTS);
  let invalid = 0;
  const rows = [];
  for (const p of people) {
    const phone = normalize(p.phone);
    if (!phone) { invalid++; continue; }
    rows.push({ phone, name: p.name, contact: { kind: model === 'Customer' ? 'Customer' : 'Lead', id: p._id } });
  }
  return { matched: people.length, invalid, created: 0, ...(await addRecipients(b, rows)) };
}

// CSV with a phone column (+ optional name and any other columns, usable as {{vars.column}}).
async function addFromCsv(b, text, { triggerAutomation = false, by } = {}) {
  const rows = parseCsv(String(text || ''));
  if (!rows.length) throw new HttpError(400, 'CSV is empty. First row must be a header, e.g. phone,name');
  if (rows.length > MAX_CSV_ROWS) throw new HttpError(400, `Max ${MAX_CSV_ROWS} rows per upload`);
  const lower = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_'), v]));
  const col = PHONE_COLS.find((c) => c in lower(rows[0]));
  if (!col) throw new HttpError(400, `CSV needs a phone column (${PHONE_COLS.join(' / ')})`);
  const tag = `bulk:${b.name}`.slice(0, 60);
  let invalid = 0, created = 0, matched = 0;
  const out = [], newLeads = [];
  const seen = new Set();
  for (const raw of rows) {
    const r = lower(raw);
    const phone = normalize(r[col]);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    const name = r.name || r.full_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || undefined;
    const vars = Object.fromEntries(Object.entries(r).filter(([k]) => k !== col).slice(0, 30));
    const c = await contacts.findOrCreate(b.company, phone, { name, source: 'bulk', tags: [tag] });
    if (c.created) { created++; newLeads.push(c.doc._id); }
    else matched++;
    out.push({ phone, name: c.doc.name, contact: { kind: c.kind, id: c.doc._id }, vars });
  }
  for (const id of newLeads) {
    await logActivity(b.company, { kind: 'Lead', id }, 'lead.created', `Imported for broadcast "${b.name}"`, null, by);
    if (triggerAutomation) emit(b.company, 'lead.created', { kind: 'Lead', id });
  }
  return { rows: rows.length, matched, created, invalid, ...(await addRecipients(b, out)) };
}

function assertReady(b) {
  if (b.channel === 'ivr') { if (!b.ivrFlow) throw new HttpError(400, 'Choose an IVR flow'); }
  else if (!b.body && !b.template && !b.waTemplate?.name) throw new HttpError(400, 'Write a message or pick a template');
}

async function launch(b) {
  if (!['draft', 'scheduled'].includes(b.status)) throw new HttpError(409, `Broadcast is ${b.status}`);
  assertReady(b);
  if (b.channel === 'ivr' && !(await M.IvrFlow.exists({ _id: b.ivrFlow, company: b.company, active: true }))) throw new HttpError(400, 'IVR flow not found or inactive');
  if (!(await M.BroadcastRecipient.exists({ broadcast: b._id, status: 'queued' }))) throw new HttpError(400, 'Add recipients first');
  const later = b.scheduledAt && b.scheduledAt > new Date();
  b.status = later ? 'scheduled' : 'running';
  if (!later) b.launchedAt = new Date();
  await b.save();
  if (!later) await processBroadcast(b);
  return M.Broadcast.findById(b._id);
}

async function contentFor(b) {
  if (!b.template) return { body: b.body };
  const t = await M.Template.findOne({ _id: b.template, company: b.company });
  return { body: t?.body || b.body };
}

async function sendOne(b, r, content, flow) {
  const person = r.contact?.id ? await M[r.contact.kind].findById(r.contact.id) : null;
  if (b.channel === 'ivr') {
    const ivr = require('./ivr'); // lazy: ivr -> inbox -> bulk
    const call = await ivr.dial(b.company, flow, r.phone, { contact: r.contact?.id ? r.contact : undefined, broadcast: b._id, recipient: r._id });
    return { status: 'sent', call: call._id, providerId: call.providerId };
  }
  const p = person ? person.toObject() : { name: r.name, phone: r.phone };
  const ctx = { ...r.vars, person: p, lead: p, customer: p, vars: r.vars || {} };
  const wa = b.waTemplate?.name ? { name: b.waTemplate.name, language: b.waTemplate.language, params: (b.waTemplate.params || []).map((x) => render(x, ctx)) } : undefined;
  const msg = await comm.send({
    company: b.company, channel: b.channel, to: r.phone, body: render(content.body || '', ctx), mediaUrl: b.mediaUrl, waTemplate: wa,
    relatedTo: r.contact?.id ? r.contact : undefined, broadcast: b._id,
  });
  if (person) {
    if (r.contact.kind === 'Lead') { person.lastContactedAt = new Date(); if (person.status === 'new') person.status = 'contacted'; }
    else person.lastActivityAt = new Date();
    await person.save();
  }
  return { status: 'sent', comm: msg._id, providerId: msg.providerId };
}

// Sends up to ratePerMinute queued recipients of one running broadcast.
async function processBroadcast(b) {
  const content = await contentFor(b);
  const flow = b.channel === 'ivr' ? await M.IvrFlow.findOne({ _id: b.ivrFlow, company: b.company }) : null;
  const batch = await M.BroadcastRecipient.find({ broadcast: b._id, status: 'queued' }).sort('_id').limit(b.ratePerMinute || 60);
  for (const r of batch) {
    const claimed = await M.BroadcastRecipient.findOneAndUpdate({ _id: r._id, status: 'queued' }, { status: 'sending', claimedAt: new Date() }, { returnDocument: 'after' });
    if (!claimed) continue;
    const fresh = await M.Broadcast.findById(b._id).select('status');
    if (fresh?.status !== 'running') { await M.BroadcastRecipient.updateOne({ _id: r._id }, { status: 'queued' }); break; } // paused mid-batch
    if (await contacts.isOptedOut(b.company, r.phone, b.channel)) {
      await M.BroadcastRecipient.updateOne({ _id: r._id }, { status: 'skipped', error: 'DND / opted out', optedOut: true });
      continue;
    }
    try {
      const res = await sendOne(b, claimed, content, flow);
      await M.BroadcastRecipient.updateOne({ _id: r._id }, { ...res, sentAt: new Date(), error: undefined });
    } catch (e) {
      await M.BroadcastRecipient.updateOne({ _id: r._id }, { status: 'failed', error: e.message.slice(0, 300), comm: e.comm?._id, call: e.call?._id, sentAt: new Date() });
    }
  }
  const stats = await refreshStats(b._id);
  if (!stats.queued) await M.Broadcast.updateOne({ _id: b._id, status: 'running' }, { status: 'completed', completedAt: new Date() });
  return batch.length;
}

// Scheduler tick: start scheduled broadcasts that are due, then send one batch per running broadcast.
async function processDue() {
  const now = new Date();
  await M.Broadcast.updateMany({ status: 'scheduled', scheduledAt: { $lte: now } }, { status: 'running', launchedAt: now });
  // A crash mid-send leaves recipients "sending"; fail them rather than risk a double send.
  await M.BroadcastRecipient.updateMany({ status: 'sending', claimedAt: { $lt: new Date(Date.now() - STUCK_MS) } }, { status: 'failed', error: 'interrupted' });
  let n = 0;
  for (const b of await M.Broadcast.find({ status: 'running' }).limit(50)) n += await processBroadcast(b);
  return n;
}

async function cancel(b) {
  if (!['draft', 'scheduled', 'running', 'paused'].includes(b.status)) throw new HttpError(409, `Broadcast is ${b.status}`);
  b.status = 'cancelled';
  b.completedAt = new Date();
  await b.save();
  await M.BroadcastRecipient.updateMany({ broadcast: b._id, status: 'queued' }, { status: 'skipped', error: 'cancelled' });
  await refreshStats(b._id);
  return b;
}

// GSM-7 messages: 160 chars (153 per part); anything else is UCS-2: 70 (67 per part).
function smsSegments(text = '') {
  const gsm = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€^{}\\[\]~|]*$/.test(text);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return { chars: text.length, unicode: !gsm, segments: text.length <= one ? 1 : Math.ceil(text.length / many) };
}

module.exports = { refreshStats, addFromCrm, addFromCsv, launch, processBroadcast, processDue, cancel, smsSegments, assertReady };
