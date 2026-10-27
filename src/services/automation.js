/**
 * Workflow engine.
 *
 * workflow.trigger = { event, conditions: [cond] }
 * workflow.steps   = [step]
 *
 * Step types:
 *   assign        { strategy: 'least_loaded' | 'user', userId?, roles?: ['sales'] }
 *   send_email | send_whatsapp | send_sms   { templateId? | subject?, body? }
 *   create_task   { title, dueInDays?, priority?, type?, assignTo?: 'owner' | userId }
 *   update_field  { field, value }
 *   add_tag       { tag }
 *   notify        { to: 'owner' | 'managers' | userId, title, body? }
 *   ai_score      {}
 *   ai_message    { channel: 'whatsapp' | 'sms' | 'email', purpose, tone?, context? }  (the LLM writes a personal message, then it is sent)
 *   ai_ad_review  { maxChangePct?: 30, everyHours?: 24 }  (AdCampaign: AI suggests pause/resume/budget; a manager approves)
 *   ad_pause | ad_resume   {}                         (ad campaign triggers; applied on Google Ads / Meta when linked)
 *   ad_set_budget { value? | changePct?, min?, max? } (never above the company's ad approval limit)
 *   wait          { days?, hours?, minutes? }
 *   condition     { if: cond, then: [step], else: [step] }
 *
 * cond = { field, op, value } | { type: 'no_reply' }
 *   op: eq ne gt gte lt lte contains in exists. `field` is a path on the entity
 *   or `payload.*` for the event data, e.g. payload.to for status changes, payload.cpl for ad.performance_updated.
 *
 * Ad events run on the AdCampaign (ad.sync_failed on the AdAccount). ad.performance_updated payload:
 *   last 7 days { spend, leads, clicks, impressions, conversions, revenue, ctr, cpc, cpl, cpa, roas },
 *   today { same fields }, lifetimeSpend, budgetUsedPct.
 */
const M = require('../models');
const { send, addressFor } = require('./communication');
const ai = require('./ai');
const { notify, logActivity } = require('./events');
const { render, addDays } = require('../utils/helpers');
const { accessProblem } = require('../modules');
const tenants = require('./tenants');
const adsync = require('./adsync');
const adai = require('./adai');

const MODELS = { Lead: M.Lead, Customer: M.Customer, Deal: M.Deal, Task: M.Task, AdCampaign: M.AdCampaign, AdAccount: M.AdAccount };
const MAX_STEPS_PER_RUN = 200;

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

async function evalCond(cond, ctx, run) {
  if (cond.type === 'no_reply') {
    const since = new Date(run?.startedAtMs || 0);
    const replied = await M.Communication.exists({
      company: ctx.company, direction: 'inbound', 'relatedTo.id': ctx.entity._id, createdAt: { $gt: since },
    });
    return !replied;
  }
  const actual = get(ctx.data, cond.field);
  const v = cond.value;
  switch (cond.op || 'eq') {
    case 'eq': return String(actual) === String(v);
    case 'ne': return String(actual) !== String(v);
    case 'gt': return +actual > +v;
    case 'gte': return +actual >= +v;
    case 'lt': return +actual < +v;
    case 'lte': return +actual <= +v;
    case 'contains': return Array.isArray(actual) ? actual.includes(v) : String(actual ?? '').toLowerCase().includes(String(v).toLowerCase());
    case 'in': return Array.isArray(v) && v.map(String).includes(String(actual));
    case 'exists': return actual != null && actual !== '';
    default: return false;
  }
}

async function pickAssignee(company, roles = ['sales']) {
  const users = await M.User.find({ company, active: true, role: { $in: roles } }).select('_id');
  if (!users.length) return null;
  const loads = await Promise.all(
    users.map(async (u) => ({
      id: u._id,
      n: await M.Lead.countDocuments({ company, assignedTo: u._id, status: { $nin: ['won', 'lost'] } }),
    }))
  );
  return loads.sort((a, b) => a.n - b.n)[0].id;
}

// The person a message goes to: the entity itself, or the lead/customer behind a deal/task.
async function personOf(ctx) {
  const e = ctx.entity;
  if (ctx.kind === 'Lead' || ctx.kind === 'Customer') return e;
  const rel = ctx.kind === 'Deal' ? (e.lead && { k: 'Lead', id: e.lead }) || (e.customer && { k: 'Customer', id: e.customer }) : e.relatedTo?.id && { k: e.relatedTo.kind, id: e.relatedTo.id };
  return rel ? MODELS[rel.k]?.findById(rel.id) : null;
}

// Sends one message to the workflow's person and records the contact.
async function deliver(ctx, run, person, channel, subject, body) {
  const comm = await send({
    company: ctx.company, channel, to: addressFor(channel, person), subject, body,
    relatedTo: { kind: person.constructor.modelName, id: person._id }, workflowRun: run._id,
  });
  if (person.lastContactedAt !== undefined) { person.lastContactedAt = new Date(); await person.save(); }
  return comm;
}

async function doStep(step, ctx, run) {
  const { company, entity } = ctx;
  const withPerson = async () => { const p = await personOf(ctx); return { ...ctx.data, person: p, lead: p, customer: p }; };
  switch (step.type) {
    case 'assign': {
      const uid = step.strategy === 'user' ? step.userId : await pickAssignee(company, step.roles);
      if (!uid) return 'no assignee available';
      entity.assignedTo = uid;
      await entity.save();
      await notify(company, uid, 'New assignment', `${entity.name || entity.title} was assigned to you`, { kind: ctx.kind, id: entity._id });
      return `assigned to ${uid}`;
    }
    case 'send_email':
    case 'send_whatsapp':
    case 'send_sms': {
      const channel = step.type.slice(5);
      const person = await personOf(ctx);
      if (!person) return 'no recipient';
      let { subject, body } = step;
      if (step.templateId) {
        const t = await M.Template.findOne({ _id: step.templateId, company });
        if (!t) throw new Error('Template not found');
        ({ subject, body } = t);
      }
      const tctx = { ...ctx.data, person, lead: person, customer: person };
      const comm = await deliver(ctx, run, person, channel, render(subject, tctx), render(body, tctx));
      return `${channel} ${comm.status} to ${comm.to}`;
    }
    case 'ai_message': {
      const channel = ['whatsapp', 'sms', 'email'].includes(step.channel) ? step.channel : 'whatsapp';
      const person = await personOf(ctx);
      if (!person) return 'no recipient';
      if (!step.purpose) throw new Error('ai_message needs a purpose');
      const tctx = { ...ctx.data, person, lead: person, customer: person };
      const camp = person.adCampaign && (await M.AdCampaign.findById(person.adCampaign).select('name'));
      const about = {
        name: person.name, organization: person.organization, source: person.source, status: person.status || person.lifecycle,
        tags: person.tags, budget: person.budget, adCampaign: camp?.name, formAnswers: person.customFields,
      };
      const r = await ai.generateMessage({ channel, purpose: render(step.purpose, tctx), tone: step.tone || 'friendly', person: about, context: step.context ? render(step.context, tctx) : '' });
      let body = String(r.text || '').trim();
      let subject;
      if (channel === 'email') {
        const m = /^\W*subject:\W*(.+)\n+/i.exec(body);
        subject = m ? m[1].replace(/\*+$/, '').trim() : render(step.subject || 'Hello {{person.name}}', tctx);
        if (m) body = body.slice(m[0].length).trim();
      }
      if (!body) throw new Error('The AI returned an empty message');
      const comm = await deliver(ctx, run, person, channel, subject, body);
      return `${channel} ${comm.status} to ${comm.to} (written by ${r.engine})`;
    }
    case 'create_task': {
      const assignedTo = step.assignTo && step.assignTo !== 'owner' ? step.assignTo : entity.assignedTo;
      const t = await M.Task.create({
        company, title: render(step.title, await withPerson()), type: step.type_ || 'follow_up', priority: step.priority || 'medium',
        dueAt: addDays(new Date(), step.dueInDays ?? 1), assignedTo, relatedTo: { kind: ctx.kind, id: entity._id },
      });
      return `task ${t._id}`;
    }
    case 'update_field':
      if (['_id', 'company', 'password'].includes(step.field)) throw new Error('Field not updatable');
      entity.set(step.field, step.value);
      await entity.save();
      return `${step.field}=${step.value}`;
    case 'add_tag':
      if (entity.tags && !entity.tags.includes(step.tag)) { entity.tags.push(step.tag); await entity.save(); }
      return step.tag;
    case 'notify': {
      const tdata = await withPerson();
      let targets = [];
      if (step.to === 'owner') targets = [entity.assignedTo || entity.owner];
      else if (step.to === 'managers') targets = (await M.User.find({ company, role: { $in: ['manager', 'admin', 'super_admin'] }, active: true }).select('_id')).map((u) => u._id);
      else targets = [step.to];
      await Promise.all(targets.filter(Boolean).map((u) => notify(company, u, render(step.title, tdata), render(step.body || '', tdata), { kind: ctx.kind, id: entity._id })));
      return `${targets.filter(Boolean).length} notified`;
    }
    case 'ad_pause':
    case 'ad_resume': {
      if (ctx.kind !== 'AdCampaign') return 'skipped (not an ad campaign)';
      const to = step.type === 'ad_pause' ? 'paused' : 'active';
      if (entity.status === to) return `already ${to}`;
      if (step.type === 'ad_resume' && entity.status !== 'paused') return `skipped (campaign is ${entity.status})`;
      await adsync.changeStatus(entity, to, { note: `${to === 'paused' ? 'Paused' : 'Resumed'} by workflow` });
      return to;
    }
    case 'ad_set_budget': {
      if (ctx.kind !== 'AdCampaign') return 'skipped (not an ad campaign)';
      const cur = entity.dailyBudget || 0;
      let next = step.value != null ? +step.value : Math.round(cur * (1 + (+step.changePct || 0) / 100));
      if (step.max != null) next = Math.min(next, +step.max);
      if (step.min != null) next = Math.max(next, +step.min);
      if (!(next > 0)) throw new Error('Budget must be above 0');
      const limit = await adsync.approvalLimit(company);
      if (next > cur && next > limit) throw new Error(`New budget ${next} is above the approval limit ${limit}; a manager must raise it`);
      await adsync.changeBudget(entity, next);
      await logActivity(company, { kind: 'AdCampaign', id: entity._id }, 'ad.budget', `Daily budget ${cur} -> ${next} by workflow`);
      return `daily budget ${cur} -> ${next}`;
    }
    case 'ai_ad_review': {
      if (ctx.kind !== 'AdCampaign') return 'skipped (not an ad campaign)';
      const r = await adai.recommend(entity, { maxChangePct: step.maxChangePct, everyHours: step.everyHours ?? 24 });
      if (r.skipped) return `skipped (${r.skipped})`;
      return r.action === 'keep' ? `AI: keep (${r.engine})` : `AI suggests ${adai.label(r)}; waiting for a manager`;
    }
    case 'ai_score': {
      if (ctx.kind !== 'Lead') return 'skipped (not a lead)';
      const n = await M.Communication.countDocuments({ company, 'relatedTo.id': entity._id });
      const r = await ai.scoreLead(entity, n);
      entity.score = r.score; entity.scoreReason = r.reason;
      await entity.save();
      return `score ${r.score}`;
    }
    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

// Returns 'done' | 'wait'. cursor/branches on the run make it resumable after a wait, even inside branches.
async function runSteps(run, steps, depth, ctx) {
  const start = run.cursor[depth] ?? 0;
  for (let i = start; i < steps.length; i++) {
    if (run.log.length > MAX_STEPS_PER_RUN) throw new Error('Step limit exceeded');
    const resuming = i === start && run.cursor.length > depth + 1;
    if (!resuming) run.cursor.length = depth;
    run.cursor[depth] = i;
    const step = steps[i];

    if (step.type === 'wait') {
      const ms = ((step.days || 0) * 1440 + (step.hours || 0) * 60 + (step.minutes || 0)) * 60000;
      run.cursor[depth] = i + 1;
      run.resumeAt = new Date(Date.now() + ms);
      run.status = 'waiting';
      run.log.push({ step: 'wait', ok: true, detail: `until ${run.resumeAt.toISOString()}` });
      return 'wait';
    }

    if (step.type === 'condition') {
      let branch = resuming ? run.branches[depth] : null;
      if (!branch) {
        branch = (await evalCond(step.if || {}, ctx, run)) ? 'then' : 'else';
        run.branches[depth] = branch;
        run.markModified('branches');
        run.log.push({ step: 'condition', ok: true, detail: branch });
      }
      if ((await runSteps(run, step[branch] || [], depth + 1, ctx)) === 'wait') return 'wait';
      continue;
    }

    try {
      const detail = await doStep(step, ctx, run);
      run.log.push({ step: step.type, ok: true, detail: String(detail ?? '') });
    } catch (e) {
      run.log.push({ step: step.type, ok: false, detail: e.message });
      if (!step.continueOnError) throw e;
    }
  }
  return 'done';
}

async function execute(run) {
  const wf = await M.Workflow.findById(run.workflow);
  const Model = MODELS[run.entity.kind];
  const entity = Model && (await Model.findById(run.entity.id));
  try {
    if (!wf || !entity) throw new Error('Workflow or entity no longer exists');
    run.status = 'running';
    run.resumeAt = undefined;
    const data = () => ({ ...entity.toObject(), [run.entity.kind.toLowerCase()]: entity.toObject(), entity: entity.toObject(), payload: run.payload || {} });
    const ctx = { company: run.company, kind: run.entity.kind, entity, get data() { return data(); } };
    const result = await runSteps(run, wf.steps, 0, ctx);
    if (result === 'done') {
      run.status = 'completed';
      await M.Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.completed': 1 } });
    }
  } catch (e) {
    run.status = 'failed';
    run.error = e.message;
    if (wf) await M.Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.failed': 1 } });
  }
  run.markModified('cursor');
  await run.save();
  return run;
}

// `only` (a workflow id) runs just that workflow even if inactive - used by the test endpoint.
async function trigger(company, event, entityRef, payload = {}, only) {
  const workflows = await M.Workflow.find(only ? { _id: only, company } : { company, active: true, isTemplate: { $ne: true }, 'trigger.event': event });
  if (!workflows.length) return [];
  const Model = MODELS[entityRef.kind];
  const entity = await Model.findById(entityRef.id);
  if (!entity) return [];
  const data = { ...entity.toObject(), payload };
  const runs = [];
  for (const wf of workflows) {
    const ctx = { company, entity, data };
    let ok = true;
    for (const c of wf.trigger.conditions || []) if (!(await evalCond(c, ctx))) { ok = false; break; }
    if (!ok) continue;
    const run = await M.WorkflowRun.create({ company, workflow: wf._id, event, entity: entityRef, payload, startedAtMs: Date.now() });
    await M.Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.runs': 1 } });
    runs.push(await execute(run));
  }
  return runs;
}

// Runs a flat list of steps (no wait/condition) on one record outside any workflow. Used by AI intent mapping.
async function runActions(company, entityRef, steps = [], payload = {}) {
  const Model = MODELS[entityRef?.kind];
  const entity = Model && (await Model.findOne({ _id: entityRef.id, company }));
  if (!entity) return [];
  const ctx = { company, kind: entityRef.kind, entity, get data() { return { ...entity.toObject(), payload }; } };
  const out = [];
  for (const step of steps) {
    if (!step?.type || step.type === 'wait' || step.type === 'condition') continue;
    try { out.push({ step: step.type, ok: true, detail: String((await doStep(step, ctx, {})) ?? '') }); }
    catch (e) { out.push({ step: step.type, ok: false, detail: e.message }); }
  }
  return out;
}

async function resumeDue() {
  const due = await M.WorkflowRun.find({ status: 'waiting', resumeAt: { $lte: new Date() } }).limit(100);
  for (const run of due) {
    // Suspended/expired company: check again in an hour instead of sending.
    if (accessProblem(await tenants.getCompany(run.company))) {
      await M.WorkflowRun.updateOne({ _id: run._id, status: 'waiting' }, { resumeAt: new Date(Date.now() + 36e5) });
      continue;
    }
    // Claim atomically so overlapping scheduler ticks don't double-run.
    const claimed = await M.WorkflowRun.findOneAndUpdate({ _id: run._id, status: 'waiting' }, { status: 'running' }, { returnDocument: 'after' });
    if (claimed) await execute(claimed);
  }
  return due.length;
}

const EVENTS = [
  'lead.created', 'lead.status_changed', 'deal.created', 'deal.stage_changed', 'payment.received',
  'followup.overdue', 'customer.inactive', 'customer.birthday', 'customer.anniversary',
  'form.submitted', 'whatsapp.received', 'email.received', 'website.activity',
  'sms.received', 'message.intent', 'conversation.handoff', 'call.completed', 'justdial.enquiry',
  'ad.performance_updated', 'ad.no_leads', 'ad.budget_exhausted', 'ad.campaign_imported', 'ad.status_changed', 'ad.sync_failed',
];

// Ready-made workflows a company can clone.
const TEMPLATES = [
  {
    name: 'New lead welcome & follow-up',
    trigger: { event: 'lead.created', conditions: [] },
    steps: [
      { type: 'assign', strategy: 'least_loaded' },
      { type: 'send_whatsapp', body: 'Hi {{person.name}}, thanks for your interest! Our team will reach out shortly.' },
      { type: 'send_email', subject: 'Welcome, {{person.name}}', body: 'Hi {{person.name}},\n\nThanks for getting in touch. We will contact you soon.' },
      { type: 'create_task', title: 'Call {{person.name}}', dueInDays: 1, priority: 'high' },
      { type: 'wait', days: 2 },
      { type: 'condition', if: { type: 'no_reply' }, then: [
        { type: 'send_whatsapp', body: 'Hi {{person.name}}, just checking in - any questions we can answer?' },
        { type: 'notify', to: 'owner', title: 'No reply from {{person.name}}', body: 'Lead has not replied in 2 days' },
      ], else: [] },
    ],
  },
  {
    name: 'Score-based routing',
    trigger: { event: 'lead.created', conditions: [] },
    steps: [
      { type: 'ai_score' },
      { type: 'condition', if: { field: 'score', op: 'gt', value: 70 }, then: [
        { type: 'send_whatsapp', body: 'Hi {{person.name}}, we would love to set up a quick call. When suits you?' },
        { type: 'create_task', title: 'Hot lead: call {{person.name}}', dueInDays: 0, priority: 'urgent' },
        { type: 'assign', strategy: 'least_loaded' },
        { type: 'notify', to: 'managers', title: 'Hot lead', body: '{{person.name}} scored above 70' },
      ], else: [{ type: 'send_email', subject: 'Learn more about us', body: 'Hi {{person.name}}, here is some information to get you started.' }, { type: 'add_tag', tag: 'nurture' }] },
    ],
  },
  {
    name: 'Overdue follow-up escalation',
    trigger: { event: 'followup.overdue', conditions: [] },
    steps: [{ type: 'notify', to: 'owner', title: 'Overdue follow-up', body: '{{title}}' }, { type: 'notify', to: 'managers', title: 'Follow-up overdue', body: '{{title}}' }],
  },
  {
    name: 'Birthday greeting',
    trigger: { event: 'customer.birthday', conditions: [] },
    steps: [{ type: 'send_whatsapp', body: 'Happy birthday {{person.name}}! 🎉 Enjoy a special 10% off this week.' }],
  },
  {
    name: 'Win-back inactive customers',
    trigger: { event: 'customer.inactive', conditions: [] },
    steps: [{ type: 'send_email', subject: 'We miss you, {{person.name}}', body: 'It has been a while! Here is something special for you.' }, { type: 'create_task', title: 'Call inactive customer {{person.name}}', dueInDays: 2 }],
  },
  {
    name: 'JustDial enquiry: assign, WhatsApp, call task',
    trigger: { event: 'justdial.enquiry', conditions: [] },
    steps: [
      { type: 'assign', strategy: 'least_loaded' },
      { type: 'send_whatsapp', body: 'Hi {{person.name}}, thanks for your enquiry on JustDial! Our team will call you shortly.' },
      { type: 'create_task', title: 'Call JustDial enquiry {{person.name}}', dueInDays: 0, priority: 'high' },
    ],
  },
  {
    name: 'Ads: pause when cost per lead is too high',
    trigger: { event: 'ad.performance_updated', conditions: [
      { field: 'status', op: 'eq', value: 'active' }, { field: 'objective', op: 'eq', value: 'leads' },
      { field: 'payload.leads', op: 'gte', value: 3 }, { field: 'payload.cpl', op: 'gt', value: 800 },
    ] },
    steps: [
      { type: 'ad_pause' },
      { type: 'notify', to: 'managers', title: 'Paused {{name}}', body: 'Cost per lead {{payload.cpl}} over the last 7 days (spend {{payload.spend}}, {{payload.leads}} leads)' },
    ],
  },
  {
    name: 'Ads: scale winners by 20% (capped)',
    trigger: { event: 'ad.performance_updated', conditions: [
      { field: 'status', op: 'eq', value: 'active' }, { field: 'payload.roas', op: 'gte', value: 3 }, { field: 'payload.spend', op: 'gte', value: 2000 },
    ] },
    steps: [
      { type: 'ad_set_budget', changePct: 20, max: 5000 },
      { type: 'notify', to: 'managers', title: 'Scaled {{name}}', body: 'ROAS {{payload.roas}}x over 7 days; daily budget raised by 20%' },
    ],
  },
  {
    name: 'Ads: spending with no leads',
    trigger: { event: 'ad.no_leads', conditions: [] },
    steps: [
      { type: 'ad_pause' },
      { type: 'notify', to: 'managers', title: '{{name}} paused: no leads', body: 'Spent {{payload.spend}} in {{payload.days}} days without a lead' },
    ],
  },
  {
    name: 'AI: follow up new ad leads (score, personal WhatsApp, route hot leads)',
    trigger: { event: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'ads' }] },
    steps: [
      { type: 'ai_score' },
      { type: 'ai_message', channel: 'whatsapp', tone: 'warm', purpose: 'Thank them for responding to our ad, refer to what they asked for in the form, ask one short question about their requirement and offer a quick call' },
      { type: 'condition', if: { field: 'score', op: 'gte', value: 70 }, then: [
        { type: 'assign', strategy: 'least_loaded' },
        { type: 'create_task', title: 'Hot ad lead: call {{person.name}} now', dueInDays: 0, priority: 'urgent' },
        { type: 'notify', to: 'managers', title: 'Hot ad lead: {{person.name}}', body: 'AI score {{score}}: {{scoreReason}}' },
      ], else: [
        { type: 'assign', strategy: 'least_loaded' },
        { type: 'create_task', title: 'Call ad lead {{person.name}}', dueInDays: 1, priority: 'medium' },
        { type: 'add_tag', tag: 'nurture' },
      ] },
      { type: 'wait', days: 1 },
      { type: 'condition', if: { type: 'no_reply' }, then: [
        { type: 'ai_message', channel: 'whatsapp', tone: 'friendly', purpose: 'Polite one-line follow-up: check whether they are still interested and when is a good time to talk' },
      ], else: [] },
    ],
  },
  {
    name: 'AI: review ad campaigns after each sync (manager approves changes)',
    trigger: { event: 'ad.performance_updated', conditions: [{ field: 'status', op: 'in', value: ['active', 'paused'] }] },
    steps: [{ type: 'ai_ad_review', maxChangePct: 30, everyHours: 24 }],
  },
  {
    name: 'Ads: alert when an ad account stops syncing',
    trigger: { event: 'ad.sync_failed', conditions: [] },
    steps: [{ type: 'notify', to: 'managers', title: 'Ad sync failed: {{name}}', body: '{{payload.error}}' }],
  },
];

module.exports = { trigger, resumeDue, execute, runActions, EVENTS, TEMPLATES, evalCond, MODELS };
