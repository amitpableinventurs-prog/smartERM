// Communication Hub API: providers, AI bot & intent mapping, bulk broadcasts, inbox, IVR flows/calls, DND.
const express = require('express');
const { z } = require('zod');
const M = require('../models');
const config = require('../config');
const { crud, escapeRe } = require('../utils/crud');
const { authorize, scopeFilter } = require('../middleware/auth');
const { validate, audit } = require('../middleware/common');
const { HttpError } = require('../utils/helpers');
const { normalize } = require('../utils/phone');
const providers = require('../services/providers');
const bot = require('../services/bot');
const bulk = require('../services/bulk');
const inbox = require('../services/inbox');
const ivr = require('../services/ivr');
const contacts = require('../services/contacts');
const comm = require('../services/communication');
const ai = require('../services/ai');
const { safeFilter } = require('../services/campaigns');

const router = express.Router();
router.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));
// crud sub-routers audit themselves; these are the other mutating endpoints.
router.use(['/providers', '/bot', '/conversations', '/ivr/call'], audit('hub'));

const oid = z.string().regex(/^[a-f\d]{24}$/i);
const page = (req) => ({ page: Math.max(1, +req.query.page || 1), limit: Math.min(100, Math.max(1, +req.query.limit || 20)) });
async function paged(Model, q, req, { sort = '-createdAt', populate = '' } = {}) {
  const { page: p, limit } = page(req);
  const [data, total] = await Promise.all([Model.find(q).sort(sort).skip((p - 1) * limit).limit(limit).populate(populate), Model.countDocuments(q)]);
  return { data, page: p, limit, total, pages: Math.ceil(total / limit) };
}

// ================= Overview =================
router.get('/overview', authorize('hub', 'r'), async (req, res) => {
  const days = Math.min(90, Math.max(1, +req.query.days || 7));
  const since = new Date(Date.now() - days * 864e5);
  const co = req.companyId;
  const win = { company: co, createdAt: { $gte: since } };
  const [msgs, intents, daily, calls, callIntents, convs, needAgent, botActive, handoffs, optOuts, recent, provs, bc] = await Promise.all([
    M.Communication.aggregate([{ $match: { ...win, channel: { $in: ['sms', 'whatsapp'] } } }, { $group: { _id: { channel: '$channel', direction: '$direction', status: '$status', bot: '$bot' }, n: { $sum: 1 } } }]),
    M.Communication.aggregate([{ $match: { ...win, direction: 'inbound', intent: { $ne: null } } }, { $group: { _id: '$intent', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    M.Communication.aggregate([
      { $match: { ...win, channel: { $in: ['sms', 'whatsapp', 'call'] } } },
      { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, c: '$channel' }, n: { $sum: 1 } } },
    ]),
    M.IvrCall.aggregate([{ $match: win }, { $group: { _id: '$status', n: { $sum: 1 }, dur: { $sum: { $ifNull: ['$durationSec', 0] } } } }]),
    M.IvrCall.aggregate([{ $match: { ...win, intent: { $ne: null } } }, { $group: { _id: '$intent', n: { $sum: 1 } } }]),
    M.Conversation.countDocuments({ company: co, lastMessageAt: { $gte: since } }),
    M.Conversation.countDocuments({ company: co, status: 'open', mode: 'human' }),
    M.Conversation.countDocuments({ company: co, status: 'open', mode: 'bot' }),
    M.Conversation.countDocuments({ company: co, handoffAt: { $gte: since } }),
    M.OptOut.countDocuments(win),
    M.Broadcast.find({ company: co }).sort('-updatedAt').limit(6).select('name channel status stats launchedAt scheduledAt'),
    M.ChannelProvider.find({ company: co }).select('channel provider active'),
    M.Broadcast.aggregate([{ $match: { company: co, status: { $in: ['running', 'scheduled'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const count = (f) => msgs.filter((m) => f(m._id)).reduce((s, m) => s + m.n, 0);
  const out = count((k) => k.direction === 'outbound');
  const failed = count((k) => k.direction === 'outbound' && k.status === 'failed');
  const delivered = count((k) => k.direction === 'outbound' && ['delivered', 'read'].includes(k.status));
  const answered = calls.find((c) => c._id === 'completed');
  const totalCalls = calls.reduce((s, c) => s + c.n, 0);
  const dayKeys = [...Array(days)].map((_, i) => new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10));
  res.json({
    days,
    messages: {
      outbound: out, inbound: count((k) => k.direction === 'inbound'), failed, delivered,
      botReplies: count((k) => k.direction === 'outbound' && k.bot),
      deliveryRate: out ? Math.round(((out - failed) / out) * 100) : 0,
      byChannel: ['sms', 'whatsapp'].map((c) => ({ channel: c, outbound: count((k) => k.channel === c && k.direction === 'outbound'), inbound: count((k) => k.channel === c && k.direction === 'inbound') })),
    },
    conversations: { active: convs, needAgent, botActive, handoffs, aiResolvedPct: convs ? Math.max(0, Math.round(((convs - handoffs) / convs) * 100)) : 0 },
    calls: { total: totalCalls, answered: answered?.n || 0, avgDurationSec: answered?.n ? Math.round(answered.dur / answered.n) : 0, byStatus: calls.map((c) => ({ status: c._id, n: c.n })) },
    intents: Object.entries([...intents, ...callIntents].reduce((a, i) => ({ ...a, [i._id]: (a[i._id] || 0) + i.n }), {})).map(([intent, n]) => ({ intent, n })).sort((a, b) => b.n - a.n),
    daily: dayKeys.map((d) => ({ date: d, sms: 0, whatsapp: 0, call: 0, ...Object.fromEntries(daily.filter((x) => x._id.d === d).map((x) => [x._id.c, x.n])) })),
    optOuts, recentBroadcasts: recent,
    broadcasts: Object.fromEntries(bc.map((x) => [x._id, x.n])),
    providers: M.HUB_CHANNELS.map((c) => { const p = provs.find((x) => x.channel === c); return { channel: c, provider: p?.active ? p.provider : 'simulated' }; }),
    aiMode: ai.hasKey() ? 'llm' : 'rules',
  });
});

// ================= Providers =================
const baseUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
function providerView(req, channel, p) {
  const token = p?.webhookToken;
  const hooks = token && {
    sms: { inbound: `/sms`, status: `/status` },
    whatsapp: { inbound: `/whatsapp`, status: `/status` },
    voice: { inbound: `/voice`, status: `/voice/status` },
  }[channel];
  return {
    channel, provider: p?.provider || 'simulated', from: p?.from || '', active: p ? p.active : true, configured: !!p,
    config: p ? providers.maskedConfig(p.provider, providers.unseal(p.credentials)) : {},
    inboundFlow: p?.inboundFlow, lastError: p?.lastError,
    webhooks: hooks ? Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, `${baseUrl(req)}/api/webhooks/comm/${token}${v}`])) : null,
    publicUrlSet: !!config.publicUrl,
  };
}

router.get('/providers/meta', authorize('hubsetup', 'r'), (_req, res) => res.json({ fields: providers.FIELDS, allowed: providers.ALLOWED }));

router.get('/providers', authorize('hubsetup', 'r'), async (req, res) => {
  const list = await M.ChannelProvider.find({ company: req.companyId }).select('+credentials');
  res.json(M.HUB_CHANNELS.map((c) => providerView(req, c, list.find((p) => p.channel === c))));
});

router.put('/providers/:channel', authorize('hubsetup', 'u'), validate(z.object({
  provider: z.enum(['simulated', 'twilio', 'meta', 'http']), from: z.string().max(60).optional(), active: z.boolean().optional(),
  config: z.record(z.string(), z.any()).optional(), inboundFlow: oid.nullable().optional(),
})), async (req, res) => {
  const { channel } = req.params;
  if (!M.HUB_CHANNELS.includes(channel)) throw new HttpError(404, 'Unknown channel');
  const b = req.body;
  if (!providers.ALLOWED[channel].includes(b.provider)) throw new HttpError(400, `${b.provider} does not support ${channel}`);
  if (b.inboundFlow && !(await M.IvrFlow.exists({ _id: b.inboundFlow, company: req.companyId }))) throw new HttpError(400, 'IVR flow not found');
  let p = await M.ChannelProvider.findOne({ company: req.companyId, channel }).select('+credentials');
  const old = p && p.provider === b.provider ? providers.unseal(p.credentials) : {};
  let cfg;
  try { cfg = providers.mergeConfig(b.provider, old, b.config); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  if (b.provider !== 'simulated' && b.provider !== 'meta' && !b.from) throw new HttpError(400, 'Sender number / ID is required');
  p ||= new M.ChannelProvider({ company: req.companyId, channel });
  p.set({ provider: b.provider, from: b.from, active: b.active ?? true, credentials: providers.seal(cfg), lastError: undefined });
  if (channel === 'voice') p.inboundFlow = b.inboundFlow || undefined;
  await p.save();
  res.json(providerView(req, channel, p));
});

// WhatsApp `template` (approved template name, e.g. hello_world) reaches numbers that have not messaged you in the last 24h.
router.post('/providers/:channel/test', authorize('hubsetup', 'u'), validate(z.object({
  to: z.string().min(6).max(30), body: z.string().max(500).optional(),
  template: z.string().max(120).optional(), language: z.string().max(20).optional(),
})), async (req, res) => {
  const { channel } = req.params;
  if (!M.HUB_CHANNELS.includes(channel)) throw new HttpError(404, 'Unknown channel');
  const to = normalize(req.body.to);
  const prov = await providers.resolve(req.companyId, channel);
  try {
    if (channel === 'voice') {
      const base = config.publicUrl && prov.doc ? `${config.publicUrl}/api/webhooks/comm/${prov.doc.webhookToken}` : '';
      const r = await providers.placeCall(prov, to, { answerUrl: base && `${base}/voice?test=1` });
      return res.json({ ok: true, status: r.status, providerId: r.providerId, provider: prov.type });
    }
    const waTemplate = channel === 'whatsapp' && req.body.template ? { name: req.body.template, language: req.body.language || 'en_US' } : undefined;
    const m = await comm.send({ company: req.companyId, channel, to, body: req.body.body || `Test message from ${(await M.Company.findById(req.companyId)).name} CRM`, by: req.user._id, waTemplate });
    res.json({ ok: true, status: m.status, providerId: m.providerId, provider: prov.type });
  } catch (e) {
    if (prov.doc) await M.ChannelProvider.updateOne({ _id: prov.doc._id }, { lastError: e.message.slice(0, 300) });
    throw new HttpError(424, `Test failed: ${e.message}`);
  }
});

// ================= AI bot & intent mapping =================
const actionSchema = z.object({ type: z.enum(bot.ACTION_TYPES) }).passthrough();
const botSchema = z.object({
  channels: z.object({ sms: z.boolean(), whatsapp: z.boolean(), voice: z.boolean() }).partial().optional(),
  name: z.string().min(1).max(40).optional(), persona: z.string().max(4000).optional(), tone: z.string().max(100).optional(), language: z.string().max(40).optional(),
  knowledge: z.array(z.object({ q: z.string().max(500), a: z.string().max(2000) })).max(200).optional(),
  minConfidence: z.number().min(0).max(1).optional(), maxBotTurns: z.number().int().min(1).max(50).optional(),
  autoCreateLeads: z.boolean().optional(), handoffRoles: z.array(z.enum(M.ROLES)).optional(),
  optOutKeywords: z.array(z.string().min(1).max(40)).max(30).optional(), optOutReply: z.string().max(500).optional(), handoffReply: z.string().max(500).optional(),
  intentActions: z.record(z.string(), z.array(actionSchema).max(10)).nullable().optional(),
}).strict();

const botView = (cfg) => ({ ...cfg.toObject(), intentActions: Object.fromEntries(Object.keys(bot.INTENTS).map((i) => [i, bot.actionsFor(cfg, i)])) });

router.get('/bot', authorize('hubsetup', 'r'), async (req, res) => {
  res.json({ config: botView(await bot.getConfig(req.companyId)), intents: bot.INTENTS, actionTypes: bot.ACTION_TYPES, defaults: bot.DEFAULT_ACTIONS, aiMode: ai.hasKey() ? 'llm' : 'rules' });
});

router.put('/bot', authorize('hubsetup', 'u'), validate(botSchema), async (req, res) => {
  const cfg = await bot.getConfig(req.companyId);
  const { channels, ...rest } = req.body;
  if (rest.intentActions) rest.intentActions = Object.fromEntries(Object.entries(rest.intentActions).filter(([k]) => bot.INTENTS[k]));
  cfg.set(rest);
  if (channels) for (const [k, v] of Object.entries(channels)) cfg.set(`channels.${k}`, v);
  if (rest.intentActions) cfg.markModified('intentActions');
  await cfg.save();
  res.json(botView(cfg));
});

// Sandbox: what would the bot answer and which CRM actions would run? Nothing is sent or changed.
router.post('/bot/test', authorize('hubsetup', 'r'), validate(z.object({
  text: z.string().min(1).max(2000), channel: z.enum(['sms', 'whatsapp', 'voice']).default('whatsapp'),
  history: z.array(z.object({ role: z.enum(['caller', 'bot']), text: z.string().max(2000) })).max(20).optional(),
})), async (req, res) => {
  const cfg = await bot.getConfig(req.companyId);
  const r = await bot.respond({ cfg, company: await inbox.companyName(req.companyId), channel: req.body.channel, text: req.body.text, history: req.body.history || [], contact: { name: 'Test Customer', kind: 'Lead', status: 'new' } });
  const actions = bot.actionsFor(cfg, r.intent);
  const handoff = r.handoff || actions.some((a) => a.type === 'handoff') || r.confidence < cfg.minConfidence;
  res.json({ ...r, reply: r.confidence < cfg.minConfidence && !r.handoff ? cfg.handoffReply : r.reply, handoff, actions });
});

// ================= Bulk broadcasts =================
const bc = crud({
  Model: M.Broadcast, resource: 'bulk', search: ['name'], filters: ['channel', 'status'], scope: false, populate: 'ivrFlow template',
  hooks: {
    beforeCreate(req, d) {
      for (const k of ['status', 'stats', 'launchedAt', 'completedAt']) delete d[k];
      d.createdBy = req.user._id;
      if (d.channel === 'ivr') delete d.body;
    },
    beforeUpdate(req, doc, d) {
      for (const k of ['status', 'stats', 'launchedAt', 'completedAt', 'channel', 'createdBy']) delete d[k];
      if (!['draft', 'scheduled'].includes(doc.status)) throw new HttpError(409, 'Only draft or scheduled broadcasts can be edited');
    },
    async beforeDelete(req, doc) {
      if (['running', 'scheduled'].includes(doc.status)) throw new HttpError(409, 'Pause or cancel the broadcast first');
      await M.BroadcastRecipient.deleteMany({ broadcast: doc._id });
    },
  },
});
const loadB = (req) => bc.find(req);

bc.router.post('/compose', authorize('bulk', 'c'), validate(z.object({ channel: z.enum(['sms', 'whatsapp']), purpose: z.string().min(3).max(500), tone: z.string().max(40).optional() })), async (req, res) => {
  const r = await ai.generateMessage({ channel: req.body.channel, purpose: req.body.purpose, tone: req.body.tone, person: { name: '{{person.name}}' } });
  res.json({ text: String(r.text || '').replace(/^Subject:.*\n+/i, ''), engine: r.engine });
});

bc.router.post('/segments', authorize('bulk', 'r'), (req, res) => res.json(bulk.smsSegments(String(req.body?.text || ''))));

bc.router.post('/preview-audience', authorize('bulk', 'r'), async (req, res) => {
  const Model = req.body?.model === 'Customer' ? M.Customer : M.Lead;
  const q = { company: req.companyId, ...safeFilter(req.body?.filter), phone: { $nin: [null, ''] } };
  if (req.body?.tags?.length) q.tags = { $in: req.body.tags };
  res.json({ count: await Model.countDocuments(q), sample: await Model.find(q).select('name phone').limit(5) });
});

bc.router.get('/:id/recipients', authorize('bulk', 'r'), async (req, res) => {
  const b = await loadB(req);
  const q = { broadcast: b._id };
  if (req.query.status) q.status = String(req.query.status);
  if (req.query.replied === 'true') q.replied = true;
  if (req.query.answered === 'true') q.answered = true;
  if (req.query.q) q.$or = [{ phone: new RegExp(escapeRe(String(req.query.q))) }, { name: new RegExp(escapeRe(String(req.query.q)), 'i') }];
  res.json(await paged(M.BroadcastRecipient, q, req, { sort: '_id' }));
});

bc.router.post('/:id/recipients/csv', authorize('bulk', 'u'), async (req, res) => {
  const b = await loadB(req);
  if (!['draft', 'scheduled', 'paused'].includes(b.status)) throw new HttpError(409, `Cannot add recipients to a ${b.status} broadcast`);
  const text = typeof req.body === 'string' ? req.body : req.body?.csv;
  res.status(201).json(await bulk.addFromCsv(b, text, { triggerAutomation: req.query.automation === 'true' || req.body?.automation === true, by: req.user._id }));
});

bc.router.post('/:id/recipients/crm', authorize('bulk', 'u'), validate(z.object({ model: z.enum(['Lead', 'Customer']).default('Lead'), filter: z.record(z.string(), z.any()).optional(), tags: z.array(z.string()).optional() })), async (req, res) => {
  const b = await loadB(req);
  if (!['draft', 'scheduled', 'paused'].includes(b.status)) throw new HttpError(409, `Cannot add recipients to a ${b.status} broadcast`);
  res.status(201).json(await bulk.addFromCrm(b, req.body));
});

bc.router.delete('/:id/recipients', authorize('bulk', 'u'), async (req, res) => {
  const b = await loadB(req);
  if (b.status !== 'draft') throw new HttpError(409, 'Only a draft broadcast can be cleared');
  await M.BroadcastRecipient.deleteMany({ broadcast: b._id });
  res.json(await bulk.refreshStats(b._id));
});

bc.router.post('/:id/launch', authorize('bulk', 'u'), async (req, res) => res.json(await bulk.launch(await loadB(req))));
bc.router.post('/:id/pause', authorize('bulk', 'u'), async (req, res) => {
  const b = await loadB(req);
  if (b.status !== 'running' && b.status !== 'scheduled') throw new HttpError(409, 'Broadcast is not running');
  b.status = 'paused'; await b.save(); res.json(b);
});
bc.router.post('/:id/resume', authorize('bulk', 'u'), async (req, res) => {
  const b = await loadB(req);
  if (b.status !== 'paused') throw new HttpError(409, 'Broadcast is not paused');
  b.status = 'running'; b.launchedAt ||= new Date(); await b.save();
  await bulk.processBroadcast(b);
  res.json(await M.Broadcast.findById(b._id));
});
bc.router.post('/:id/cancel', authorize('bulk', 'u'), async (req, res) => res.json(await bulk.cancel(await loadB(req))));

bc.router.get('/:id/report', authorize('bulk', 'r'), async (req, res) => {
  const b = await loadB(req);
  const stats = await bulk.refreshStats(b._id);
  const ids = (await M.BroadcastRecipient.find({ broadcast: b._id, 'contact.id': { $ne: null } }).select('contact')).map((r) => r.contact.id);
  const [intents, won, leadsByStatus] = await Promise.all([
    M.Communication.aggregate([{ $match: { company: req.companyId, direction: 'inbound', intent: { $ne: null }, 'relatedTo.id': { $in: ids }, createdAt: { $gte: b.launchedAt || b.createdAt } } }, { $group: { _id: '$intent', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    M.Deal.aggregate([{ $match: { company: req.companyId, status: 'won', closedAt: { $gte: b.launchedAt || b.createdAt }, $or: [{ lead: { $in: ids } }, { customer: { $in: ids } }] } }, { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: '$value' } } }]),
    M.Lead.aggregate([{ $match: { company: req.companyId, _id: { $in: ids } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const callIntents = b.channel === 'ivr' ? await M.IvrCall.aggregate([{ $match: { broadcast: b._id, intent: { $ne: null } } }, { $group: { _id: '$intent', n: { $sum: 1 } } }]) : [];
  const cost = Math.round((stats.sent || 0) * (b.costPerUnit || 0) * 100) / 100;
  res.json({
    broadcast: b, stats, cost, revenue: won[0]?.revenue || 0, wonDeals: won[0]?.n || 0,
    roi: cost > 0 ? Math.round((((won[0]?.revenue || 0) - cost) / cost) * 100) : null,
    intents: [...intents, ...callIntents].map((i) => ({ intent: i._id, n: i.n })),
    leadsByStatus: leadsByStatus.map((l) => ({ status: l._id, n: l.n })),
  });
});
router.use('/broadcasts', bc.finish());

// ================= Inbox =================
const OWN_INBOX = (req) => scopeFilter(req, 'inbox'); // sales/telecaller: only their conversations

async function loadConv(req) {
  const c = await M.Conversation.findOne({ _id: req.params.id, company: req.companyId, ...OWN_INBOX(req) });
  if (!c) throw new HttpError(404, 'Conversation not found');
  return c;
}

router.get('/conversations', authorize('inbox', 'r'), async (req, res) => {
  const q = { company: req.companyId, ...OWN_INBOX(req) };
  const v = req.query.view;
  if (v === 'needs_agent') Object.assign(q, { status: 'open', mode: 'human' });
  else if (v === 'bot') Object.assign(q, { status: 'open', mode: 'bot' });
  else if (v === 'mine') Object.assign(q, { assignedTo: req.user._id, status: 'open' });
  else if (v === 'closed') q.status = 'closed';
  else if (v !== 'all') q.status = 'open';
  if (['sms', 'whatsapp'].includes(req.query.channel)) q.channel = req.query.channel;
  if (req.query.q) { const re = new RegExp(escapeRe(String(req.query.q)), 'i'); q.$or = [{ name: re }, { phone: re }, { lastMessage: re }]; }
  const out = await paged(M.Conversation, q, req, { sort: '-lastMessageAt', populate: { path: 'assignedTo', select: 'name' } });
  const base = { company: req.companyId, ...OWN_INBOX(req) };
  out.counts = {
    needs_agent: await M.Conversation.countDocuments({ ...base, status: 'open', mode: 'human' }),
    bot: await M.Conversation.countDocuments({ ...base, status: 'open', mode: 'bot' }),
    mine: await M.Conversation.countDocuments({ ...base, status: 'open', assignedTo: req.user._id }),
  };
  res.json(out);
});

router.get('/conversations/:id', authorize('inbox', 'r'), async (req, res) => {
  const c = await loadConv(req);
  if (c.unread) { c.unread = 0; await c.save(); }
  const [messages, contact] = await Promise.all([
    M.Communication.find({ conversation: c._id }).sort('createdAt').limit(300).populate('by', 'name'),
    c.contact?.id ? M[c.contact.kind].findById(c.contact.id).select('name email phone status lifecycle score tags assignedTo organization').populate('assignedTo', 'name') : null,
  ]);
  await c.populate('assignedTo', 'name');
  res.json({ conversation: c, messages, contact: contact && { kind: c.contact.kind, ...contact.toObject() }, dnd: await contacts.isOptedOut(req.companyId, c.phone, c.channel) });
});

router.post('/conversations/:id/reply', authorize('inbox', 'u'), validate(z.object({ body: z.string().min(1).max(4000) })), async (req, res) => {
  const c = await loadConv(req);
  try { res.status(201).json(await inbox.agentReply(c, req.user, req.body.body)); }
  catch (e) { throw new HttpError(424, `Not delivered: ${e.message}`); }
});

router.post('/conversations/:id/takeover', authorize('inbox', 'u'), async (req, res) => {
  const c = await loadConv(req);
  Object.assign(c, { mode: 'human', assignedTo: req.user._id, status: 'open', handoffReason: c.handoffReason || `Taken over by ${req.user.name}`, handoffAt: c.handoffAt || new Date() });
  await c.save(); res.json(c);
});
router.post('/conversations/:id/release', authorize('inbox', 'u'), async (req, res) => {
  const c = await loadConv(req);
  Object.assign(c, { mode: 'bot', botTurns: 0, status: 'open' });
  await c.save(); res.json(c);
});
router.post('/conversations/:id/close', authorize('inbox', 'u'), async (req, res) => {
  const c = await loadConv(req);
  c.status = 'closed'; c.unread = 0; await c.save(); res.json(c);
});
router.post('/conversations/:id/assign', authorize('inbox', 'u'), validate(z.object({ userId: oid })), async (req, res) => {
  if (OWN_INBOX(req).assignedTo) throw new HttpError(403, 'You cannot reassign conversations');
  const c = await loadConv(req);
  const u = await M.User.findOne({ _id: req.body.userId, company: req.companyId, active: true });
  if (!u) throw new HttpError(404, 'User not found');
  Object.assign(c, { assignedTo: u._id, mode: 'human', status: 'open' });
  await c.save();
  await require('../services/events').notify(req.companyId, u._id, 'Conversation assigned to you', `${c.name || c.phone} (${c.channel})`, c.contact);
  res.json(c);
});
router.post('/conversations/:id/suggest', authorize('inbox', 'r'), async (req, res) => {
  const c = await loadConv(req);
  const last = await M.Communication.findOne({ conversation: c._id, direction: 'inbound' }).sort('-createdAt');
  if (!last) throw new HttpError(400, 'No customer message to reply to');
  const cfg = await bot.getConfig(req.companyId);
  const history = (await M.Communication.find({ conversation: c._id, _id: { $ne: last._id } }).sort('-createdAt').limit(10).select('direction body')).reverse();
  const r = await bot.respond({ cfg, company: await inbox.companyName(req.companyId), channel: c.channel, text: last.body, history, contact: { name: c.name } });
  res.json({ text: r.reply, intent: r.intent, engine: r.engine });
});

// Start a chat with any number or CRM record.
router.post('/conversations', authorize('inbox', 'u'), validate(z.object({
  channel: z.enum(['sms', 'whatsapp']), body: z.string().min(1).max(4000),
  phone: z.string().optional(), kind: z.enum(['Lead', 'Customer']).optional(), id: oid.optional(),
})), async (req, res) => {
  const { channel, body, kind, id } = req.body;
  let contact, phone = normalize(req.body.phone);
  if (kind && id) {
    const doc = await M[kind].findOne({ _id: id, company: req.companyId, ...scopeFilter(req, kind === 'Lead' ? 'leads' : 'customers') });
    if (!doc) throw new HttpError(404, `${kind} not found`);
    contact = { kind, doc }; phone = normalize(doc.phone);
  } else if (phone) contact = await contacts.findOrCreate(req.companyId, phone, { source: channel });
  if (!phone) throw new HttpError(400, 'A phone number is required');
  const conv = await M.Conversation.findOneAndUpdate(
    { company: req.companyId, channel, phone },
    { $setOnInsert: { company: req.companyId, channel, phone } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  if (OWN_INBOX(req).assignedTo && conv.assignedTo && String(conv.assignedTo) !== String(req.user._id)) throw new HttpError(403, 'This number is handled by another agent');
  Object.assign(conv, { contact: contacts.ref(contact), name: contact?.doc.name || phone, status: 'open' });
  try { await inbox.agentReply(conv, req.user, body); } catch (e) { throw new HttpError(424, `Not delivered: ${e.message}`); }
  res.status(201).json(conv);
});

// ================= IVR =================
const flowSchema = z.object({
  name: z.string().min(1).max(80), description: z.string().max(500).optional(), active: z.boolean().optional(), isDefaultInbound: z.boolean().optional(),
  start: z.string().min(1).max(40), voice: z.string().max(40).optional(), language: z.string().max(10).optional(), nodes: z.array(z.any()).min(1).max(100),
});
const flows = crud({
  Model: M.IvrFlow, resource: 'ivr', search: ['name'], filters: ['active'], scope: false,
  hooks: {
    async beforeCreate(req, d) {
      const v = flowSchema.parse(d);
      v.nodes = ivr.validateFlow(v);
      if (v.isDefaultInbound) await M.IvrFlow.updateMany({ company: req.companyId }, { isDefaultInbound: false });
      return v;
    },
    async beforeUpdate(req, doc, d) {
      const v = flowSchema.partial().parse(d);
      if (v.nodes || v.start) v.nodes = ivr.validateFlow({ start: v.start || doc.start, nodes: v.nodes || doc.nodes });
      if (v.isDefaultInbound) await M.IvrFlow.updateMany({ company: req.companyId, _id: { $ne: doc._id } }, { isDefaultInbound: false });
      return v;
    },
    async beforeDelete(req, doc) {
      if (await M.Broadcast.exists({ company: req.companyId, ivrFlow: doc._id, status: { $in: ['running', 'scheduled', 'paused'] } })) throw new HttpError(409, 'Flow is used by an active broadcast');
    },
  },
});
flows.router.get('/meta/sample', authorize('ivr', 'r'), (_req, res) => res.json({ sample: ivr.SAMPLE_FLOW, nodeTypes: ivr.NODE_TYPES, intents: bot.INTENTS }));
router.use('/ivr/flows', flows.finish());

router.get('/ivr/calls', authorize('ivr', 'r'), async (req, res) => {
  const q = { company: req.companyId };
  for (const f of ['status', 'direction', 'intent']) if (req.query[f]) q[f] = String(req.query[f]);
  if (req.query.flow && /^[a-f\d]{24}$/i.test(req.query.flow)) q.flow = req.query.flow;
  if (req.query.broadcast && /^[a-f\d]{24}$/i.test(req.query.broadcast)) q.broadcast = req.query.broadcast;
  if (req.query.q) q.phone = new RegExp(escapeRe(String(req.query.q)));
  const out = await paged(M.IvrCall, q, req, { populate: { path: 'flow', select: 'name' } });
  const names = {};
  for (const kind of ['Lead', 'Customer']) {
    const ids = out.data.filter((c) => c.contact?.kind === kind).map((c) => c.contact.id);
    if (ids.length) (await M[kind].find({ _id: { $in: ids } }).select('name')).forEach((d) => { names[d._id] = d.name; });
  }
  out.data = out.data.map((c) => ({ ...c.toObject(), contactName: c.contact?.id ? names[c.contact.id] : undefined }));
  res.json(out);
});

router.get('/ivr/calls/:id', authorize('ivr', 'r'), async (req, res) => {
  const c = await M.IvrCall.findOne({ _id: req.params.id, company: req.companyId }).populate('flow', 'name');
  if (!c) throw new HttpError(404, 'Call not found');
  res.json(c);
});

async function loadFlow(req, id) {
  const f = await M.IvrFlow.findOne({ _id: id, company: req.companyId });
  if (!f) throw new HttpError(404, 'IVR flow not found');
  return f;
}

// Real outbound IVR call to one number or CRM record (simulated when no voice provider is set up).
router.post('/ivr/call', authorize('ivr', 'c'), validate(z.object({ flowId: oid, phone: z.string().optional(), kind: z.enum(['Lead', 'Customer']).optional(), id: oid.optional() })), async (req, res) => {
  const flow = await loadFlow(req, req.body.flowId);
  let phone = req.body.phone, contact;
  if (req.body.kind && req.body.id) {
    const doc = await M[req.body.kind].findOne({ _id: req.body.id, company: req.companyId });
    if (!doc) throw new HttpError(404, 'Record not found');
    phone = doc.phone; contact = { kind: req.body.kind, id: doc._id };
  }
  contact ||= await ivr.mapContact(req.companyId, normalize(phone));
  try { res.status(201).json(await ivr.dial(req.companyId, flow, phone, { contact })); }
  catch (e) { throw new HttpError(e.status || 424, e.message); }
});

// ---- Call simulator: walk a flow in the browser, with real CRM mapping and intent actions ----
const simView = (call, verbs) => ({
  call: { _id: call._id, status: call.status, currentNode: call.currentNode, intent: call.intent, digits: call.digits, finished: call.finished, summary: call.summary, sentiment: call.sentiment, contact: call.contact, transcript: call.transcript, durationSec: call.durationSec },
  verbs, done: call.finished,
});

router.post('/ivr/simulate', authorize('ivr', 'c'), validate(z.object({ flowId: oid, phone: z.string().min(6).max(30), direction: z.enum(['inbound', 'outbound']).default('inbound') })), async (req, res) => {
  const flow = await loadFlow(req, req.body.flowId);
  const phone = normalize(req.body.phone);
  if (!phone) throw new HttpError(400, 'Invalid phone number');
  const call = req.body.direction === 'inbound'
    ? await ivr.startInbound(req.companyId, flow, phone, { simulated: true })
    : await M.IvrCall.create({ company: req.companyId, flow: flow._id, direction: 'outbound', phone, contact: await ivr.mapContact(req.companyId, phone), simulated: true });
  res.status(201).json(simView(call, await ivr.begin(call, flow)));
});

async function loadSim(req) {
  const call = await M.IvrCall.findOne({ _id: req.params.id, company: req.companyId, simulated: true });
  if (!call) throw new HttpError(404, 'Simulated call not found');
  return call;
}

router.post('/ivr/simulate/:id', authorize('ivr', 'c'), validate(z.object({
  digits: z.string().max(5).optional(), speech: z.string().max(1000).optional(), noinput: z.boolean().optional(),
  dialStatus: z.enum(['completed', 'no-answer', 'busy']).optional(), recordingUrl: z.string().max(300).optional(),
})), async (req, res) => {
  const call = await loadSim(req);
  const flow = await M.IvrFlow.findById(call.flow);
  if (!flow) throw new HttpError(404, 'Flow was deleted');
  res.json(simView(call, await ivr.step(call, flow, call.currentNode, req.body)));
});

router.post('/ivr/simulate/:id/hangup', authorize('ivr', 'c'), async (req, res) => {
  const call = await loadSim(req);
  await ivr.finishCall(call, { status: 'completed' });
  res.json(simView(call, [{ hangup: true }]));
});

// ================= DND / opt-outs =================
const dnd = crud({
  Model: M.OptOut, resource: 'hubsetup', search: ['phone', 'reason'], filters: ['channel', 'source'], scope: false,
  hooks: {
    beforeCreate(req, d) {
      d.phone = normalize(d.phone);
      if (!d.phone) throw new HttpError(400, 'Invalid phone number');
      d.source = 'manual';
    },
    beforeUpdate() { throw new HttpError(405, 'Delete and re-add instead'); },
  },
});
router.use('/optouts', dnd.finish());

module.exports = router;
