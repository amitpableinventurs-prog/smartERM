/**
 * Inbound SMS / WhatsApp handling.
 *
 *   message in -> map phone to Lead/Customer (create a lead if unknown) -> conversation thread
 *     -> STOP keywords: opt out (always)
 *     -> bot mode: AI reply + intent -> CRM actions (intent mapping); hand off to an agent when needed
 *     -> human mode: notify the assigned agent
 */
const M = require('../models');
const bot = require('./bot');
const contacts = require('./contacts');
const comm = require('./communication');
const automation = require('./automation');
const { logActivity, notify, emit } = require('./events');
const { normalize } = require('../utils/phone');

const AGENT_FALLBACK_ROLES = ['manager', 'admin', 'super_admin'];
const REPLY_WINDOW_MS = 7 * 864e5; // replies within a week count towards a broadcast

async function companyName(company) {
  return (await M.Company.findById(company).select('name'))?.name || 'our company';
}

// Least-busy active agent among `roles`, preferring the record owner when they can work the inbox.
async function pickAgent(company, roles, preferred) {
  if (preferred) {
    const u = await M.User.findOne({ _id: preferred, company, active: true, role: { $in: [...roles, ...AGENT_FALLBACK_ROLES] } }).select('_id');
    if (u) return u._id;
  }
  for (const set of [roles, AGENT_FALLBACK_ROLES]) {
    const users = await M.User.find({ company, active: true, role: { $in: set } }).select('_id');
    if (!users.length) continue;
    const loads = await Promise.all(users.map(async (u) => ({ id: u._id, n: await M.Conversation.countDocuments({ company, assignedTo: u._id, status: 'open', mode: 'human' }) })));
    return loads.sort((a, b) => a.n - b.n)[0].id;
  }
  return null;
}

async function handoff(conv, reason, cfg) {
  if (conv.mode === 'human' && conv.assignedTo) return conv;
  const contactDoc = conv.contact?.id && (await M[conv.contact.kind].findById(conv.contact.id).select('assignedTo'));
  conv.mode = 'human';
  conv.handoffReason = reason;
  conv.handoffAt = new Date();
  conv.assignedTo = conv.assignedTo || (await pickAgent(conv.company, cfg.handoffRoles?.length ? cfg.handoffRoles : ['support'], contactDoc?.assignedTo));
  await conv.save();
  if (conv.assignedTo) await notify(conv.company, conv.assignedTo, `${conv.channel === 'sms' ? 'SMS' : 'WhatsApp'} chat needs you`, `${conv.name || conv.phone}: ${reason}`, conv.contact);
  if (conv.contact?.id) emit(conv.company, 'conversation.handoff', conv.contact, { channel: conv.channel, reason, conversation: String(conv._id) });
  return conv;
}

const LEAD_ORDER = M.LEAD_STAGES;

// Moves a lead forward (or to lost), never backwards and never away from "won".
async function setLeadStatus(company, contact, to, reason) {
  if (contact?.kind !== 'Lead' || !LEAD_ORDER.includes(to)) return 'skipped';
  const lead = await M.Lead.findOne({ _id: contact.id, company });
  if (!lead || lead.status === 'won' || lead.status === to) return 'unchanged';
  if (to !== 'lost' && LEAD_ORDER.indexOf(to) <= LEAD_ORDER.indexOf(lead.status)) return 'unchanged';
  const from = lead.status;
  lead.status = to;
  if (to === 'lost') lead.lostReason = reason;
  await lead.save();
  await logActivity(company, contact, 'lead.status_changed', `${from} → ${to} (AI: ${reason})`);
  emit(company, 'lead.status_changed', contact, { from, to });
  return `${from} → ${to}`;
}

/**
 * Applies the intent mapping for one intent to a contact. ctx: { channel, message, entities, conversation, call, cfg }.
 * Returns the action results. Custom action types are handled here; the rest go to the workflow engine.
 */
async function applyIntent(company, contact, intent, ctx) {
  const cfg = ctx.cfg || (await bot.getConfig(company));
  const results = await runMapped(company, contact, bot.actionsFor(cfg, intent), { ...ctx, cfg, intent });
  if (contact) {
    await logActivity(company, contact, 'ai.intent', `${intent} on ${ctx.channel}${ctx.message ? `: ${String(ctx.message).slice(0, 100)}` : ''}`, { results });
    emit(company, 'message.intent', contact, { intent, channel: ctx.channel, message: ctx.message, entities: ctx.entities || {} });
  }
  return results;
}

// Runs mapped actions (intent mapping, IVR node actions) on a contact.
async function runMapped(company, contact, actions = [], ctx = {}) {
  const intent = ctx.intent || 'ivr';
  const cfg = ctx.cfg || (await bot.getConfig(company));
  const results = [];
  const flow = [];
  for (const a of actions) {
    if (a.type === 'set_status') results.push({ step: a.type, detail: await setLeadStatus(company, contact, a.value, `${intent} on ${ctx.channel}`) });
    else if (a.type === 'opt_out') {
      const phone = ctx.conversation?.phone || ctx.call?.phone;
      if (phone) await contacts.optOut(company, phone, { channel: 'all', reason: `${intent} on ${ctx.channel}`, source: ctx.call ? 'ivr' : 'intent' });
      results.push({ step: a.type, detail: phone || 'no phone' });
    } else if (a.type === 'handoff') {
      if (ctx.conversation) await handoff(ctx.conversation, `AI: ${intent}`, cfg);
      else if (contact) {
        // Voice: nobody to chat with, so the owner gets an urgent call task instead.
        const owner = (await M[contact.kind].findById(contact.id).select('assignedTo'))?.assignedTo;
        await M.Task.create({ company, title: `Call back (${intent} on ${ctx.channel})`, type: 'call', priority: 'urgent', dueAt: new Date(), assignedTo: owner, relatedTo: contact });
      }
      results.push({ step: a.type, detail: 'handed off' });
    } else flow.push(a.type === 'create_task' ? { ...a, type_: a.taskType || 'follow_up' } : a);
  }
  if (contact && flow.length) results.push(...(await automation.runActions(company, contact, flow, { channel: ctx.channel, intent, message: ctx.message, entities: ctx.entities || {} })));
  return results;
}

// Fill in name/email the customer told the bot, without overwriting real data.
async function learnEntities(contact, ents) {
  if (!contact || !ents) return;
  const doc = await M[contact.kind].findById(contact.id);
  if (!doc) return;
  let dirty = false;
  if (ents.name && (!doc.name || /^\+?\d[\d\s-]+$/.test(doc.name))) { doc.name = ents.name; dirty = true; }
  if (ents.email && !doc.email) { doc.email = ents.email; dirty = true; }
  if (dirty) await doc.save();
}

// Credits the reply to the latest broadcast on the same channel sent to this number in the last week.
async function markBroadcastReply(company, phone, channel) {
  const recent = await M.BroadcastRecipient.find({ company, phone, replied: false, sentAt: { $gte: new Date(Date.now() - REPLY_WINDOW_MS) }, status: { $in: ['sent', 'delivered', 'read'] } })
    .sort('-sentAt').limit(5).populate('broadcast', 'channel');
  const r = recent.find((x) => x.broadcast?.channel === channel);
  if (!r) return null;
  await M.BroadcastRecipient.updateOne({ _id: r._id }, { replied: true });
  await require('./bulk').refreshStats(r.broadcast._id);
  return r.broadcast._id;
}

async function sendReply(conv, body, extra = {}) {
  try {
    const msg = await comm.send({ company: conv.company, channel: conv.channel, to: conv.phone, body, relatedTo: conv.contact, conversation: conv._id, ...extra });
    conv.lastMessage = body.slice(0, 200); conv.lastDirection = 'outbound'; conv.lastMessageAt = new Date();
    return msg;
  } catch (e) {
    return e.comm || null; // logged as failed on the thread
  }
}

/**
 * Entry point for every inbound SMS/WhatsApp message.
 * input: { company, channel: 'sms'|'whatsapp', from, body, name?, providerId? }
 */
async function handleInbound({ company, channel, from, body = '', name, providerId }) {
  const phone = normalize(from);
  if (!phone) throw Object.assign(new Error('from must be a phone number'), { status: 400 });
  if (providerId && (await M.Communication.exists({ company, providerId, direction: 'inbound' }))) return { duplicate: true }; // provider retry
  const cfg = await bot.getConfig(company);
  body = String(body).slice(0, 4000);

  // 1. Map to the CRM.
  let contact = await contacts.findByPhone(company, phone);
  let createdLead = false;
  if (!contact && cfg.autoCreateLeads) { contact = await contacts.createLead(company, phone, { name, source: channel }); createdLead = true; }
  const cref = contacts.ref(contact);

  // 2. Thread.
  const botOn = !!cfg.channels?.[channel];
  let conv = await M.Conversation.findOneAndUpdate(
    { company, channel, phone },
    { $setOnInsert: { company, channel, phone, mode: botOn ? 'bot' : 'human' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  if (conv.status === 'closed') Object.assign(conv, { status: 'open', mode: botOn ? 'bot' : 'human', botTurns: 0, appliedIntents: [], handoffReason: undefined });
  if (cref) conv.contact = cref;
  // Chats with a record's owner are theirs from the first message (they see them while the AI is answering too).
  if (!conv.assignedTo && contact?.doc.assignedTo) conv.assignedTo = contact.doc.assignedTo;
  conv.name = contact?.doc.name || name || conv.name;

  const msg = await M.Communication.create({ company, channel, direction: 'inbound', from: phone, body, status: 'received', relatedTo: cref, conversation: conv._id, providerId });
  Object.assign(conv, { lastMessage: body.slice(0, 200), lastDirection: 'inbound', lastMessageAt: new Date() });
  conv.unread += 1;

  if (contact) {
    const d = contact.doc;
    if (contact.kind === 'Customer') { d.lastActivityAt = new Date(); if (d.lifecycle === 'at_risk') d.lifecycle = 'active'; await d.save(); }
    await logActivity(company, cref, `${channel}.received`, body.slice(0, 120));
    if (createdLead) {
      await logActivity(company, cref, 'lead.created', `New lead from inbound ${channel}`);
      emit(company, 'lead.created', cref);
    }
    emit(company, `${channel}.received`, cref, { message: body });
  }
  const broadcast = await markBroadcastReply(company, phone, channel);
  if (broadcast) conv.broadcast = broadcast;

  const out = { message: msg, conversation: conv, contact: cref, createdLead, reply: null, intent: null, handoff: false };

  // 3. Opt-out is honoured even when the bot is off.
  if (bot.isOptOut(body, cfg)) {
    await sendReply(conv, cfg.optOutReply, { bot: true, ignoreDnd: true });
    msg.intent = 'opt_out'; await msg.save();
    if (!conv.appliedIntents.includes('opt_out')) { conv.appliedIntents.push('opt_out'); await applyIntent(company, cref, 'opt_out', { channel, message: body, conversation: conv, cfg }); }
    await contacts.optOut(company, phone, { channel: 'all', reason: `"${body.slice(0, 40)}" on ${channel}`, source: 'keyword' });
    await M.BroadcastRecipient.updateMany({ company, phone, sentAt: { $gte: new Date(Date.now() - REPLY_WINDOW_MS) } }, { optedOut: true });
    Object.assign(conv, { intent: 'opt_out', status: 'closed' });
    await conv.save();
    return { ...out, intent: 'opt_out', reply: cfg.optOutReply };
  }

  // 4. AI handles the chat.
  if (conv.mode === 'bot' && botOn) {
    const history = (await M.Communication.find({ conversation: conv._id, _id: { $ne: msg._id } }).sort('-createdAt').limit(10).select('direction body')).reverse();
    const r = await bot.respond({ cfg, company: await companyName(company), channel, text: body, history, contact: contact && { name: contact.doc.name, kind: contact.kind, status: contact.doc.status || contact.doc.lifecycle } });
    msg.intent = r.intent; msg.sentiment = r.sentiment; await msg.save();
    conv.intent = r.intent; conv.sentiment = r.sentiment; conv.botTurns += 1;

    const mapped = bot.actionsFor(cfg, r.intent);
    // The bot's own answer is still sent on an intent handoff; it is replaced only when the bot is unsure or out of turns.
    let why = null, unsure = false;
    if (r.handoff || mapped.some((a) => a.type === 'handoff')) why = `AI: ${r.intent}`;
    else if (r.confidence < cfg.minConfidence) { why = `AI not confident (${Math.round(r.confidence * 100)}%)`; unsure = true; }
    else if (conv.botTurns > cfg.maxBotTurns) { why = `${cfg.maxBotTurns} AI replies reached`; unsure = true; }
    const reply = unsure ? cfg.handoffReply : r.reply;

    await sendReply(conv, reply, { bot: true });
    await learnEntities(cref, r.entities);
    if (!conv.appliedIntents.includes(r.intent)) {
      conv.appliedIntents.push(r.intent);
      await conv.save();
      await applyIntent(company, cref, r.intent, { channel, message: body, entities: r.entities, conversation: conv, cfg });
    }
    if (why) await handoff(conv, why, cfg);
    Object.assign(out, { reply, intent: r.intent, confidence: r.confidence, engine: r.engine, handoff: !!why || conv.mode === 'human' });
  } else if (conv.assignedTo) {
    await notify(company, conv.assignedTo, `New ${channel === 'sms' ? 'SMS' : 'WhatsApp'} message`, `${conv.name || phone}: ${body.slice(0, 100)}`, cref);
  } else if (conv.mode === 'human') await handoff(conv, 'New message (AI off)', cfg);

  await conv.save();
  return out;
}

// Agent reply from the inbox. Taking part in a bot conversation takes it over.
async function agentReply(conv, user, body) {
  if (conv.mode === 'bot') { conv.mode = 'human'; conv.handoffReason = `Taken over by ${user.name}`; conv.handoffAt = new Date(); }
  if (!conv.assignedTo) conv.assignedTo = user._id;
  conv.status = 'open';
  conv.unread = 0;
  const msg = await comm.send({ company: conv.company, channel: conv.channel, to: conv.phone, body, relatedTo: conv.contact, conversation: conv._id, by: user._id });
  Object.assign(conv, { lastMessage: body.slice(0, 200), lastDirection: 'outbound', lastMessageAt: new Date() });
  await conv.save();
  if (conv.contact?.id) {
    await logActivity(conv.company, conv.contact, `${conv.channel}.sent`, body.slice(0, 80), null, user._id);
    if (conv.contact.kind === 'Lead') await M.Lead.updateOne({ _id: conv.contact.id, status: 'new' }, { status: 'contacted', lastContactedAt: new Date() });
  }
  return msg;
}

// ---------- delivery receipts ----------
const RANK = { queued: 0, sending: 0, simulated: 1, sent: 1, delivered: 2, read: 3 };
const MAP = { accepted: 'sent', queued: 'sent', sending: 'sent', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' };

async function deliveryStatus(company, providerId, rawStatus, error) {
  const status = MAP[String(rawStatus).toLowerCase()];
  if (!providerId || !status) return null;
  const c = await M.Communication.findOne({ company, providerId, direction: 'outbound' });
  if (!c) return null;
  if (status === 'failed' || (RANK[status] ?? 0) > (RANK[c.status] ?? 0)) {
    c.status = status;
    if (error) c.summary = String(error).slice(0, 300);
    await c.save();
  }
  if (c.broadcast) {
    const r = await M.BroadcastRecipient.findOne({ broadcast: c.broadcast, comm: c._id });
    if (r && (status === 'failed' || (RANK[status] ?? 0) > (RANK[r.status] ?? 0))) {
      r.status = status;
      if (error) r.error = String(error).slice(0, 300);
      await r.save();
      await require('./bulk').refreshStats(c.broadcast);
    }
  }
  return c;
}

module.exports = { handleInbound, agentReply, applyIntent, runMapped, learnEntities, handoff, pickAgent, deliveryStatus, setLeadStatus, companyName };
