/**
 * Advertising module: accounts, campaigns, creatives, daily performance data,
 * lead attribution, budget approvals, rule-based recommendations and AI (suggestions a manager approves, ad copy).
 * Performance data is entered manually, imported from CSV, or synced from Google Ads / Meta
 * (services/adsync.js); status and budget changes on linked campaigns are pushed to the network.
 */
const express = require('express');
const { z } = require('zod');
const M = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/common');
const { HttpError, parseCsv } = require('../utils/helpers');
const { notify, logActivity } = require('../services/events');
const adsync = require('../services/adsync');
const adai = require('../services/adai');

const router = express.Router();
const APPROVER_ROLES = ['super_admin', 'admin', 'manager'];
const MAX_IMPORT_ROWS = 5000;

const day = (d) => { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); };
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const r2 = (n) => Math.round(n * 100) / 100;
const div = (a, b) => (b ? a / b : 0);
const { kpis, SUMS, approvalLimit, notifyApprovers } = adsync;
const isApprover = (req) => APPROVER_ROLES.includes(req.user.role);

const API_FIELDS = ['credentials', 'connected', 'lastSyncAt', 'lastSyncError']; // only through /:id/connection

// ---------------- Accounts ----------------
const accounts = crud({
  Model: M.AdAccount, resource: 'ads', search: ['name', 'accountId'], filters: ['platform', 'status'], scope: false,
  hooks: {
    beforeCreate(req, data) { for (const k of API_FIELDS) delete data[k]; },
    beforeUpdate(req, acc, data) { for (const k of API_FIELDS) delete data[k]; },
    async beforeDelete(req, acc) { if (await M.AdCampaign.exists({ account: acc._id })) throw new HttpError(409, 'Account still has campaigns'); },
  },
});

// ----- ad network API connection -----
const account = (req) => adsync.loadAccount(req.companyId, req.params.id);

accounts.router.get('/:id/connection', authorize('ads', 'r'), async (req, res) => res.json(adsync.connectionView(await account(req))));

accounts.router.put('/:id/connection', authorize('ads', 'u'), async (req, res) => {
  const acc = await adsync.saveConnection(await account(req), req.body || {});
  await logActivity(req.companyId, { kind: 'AdAccount', id: acc._id }, 'ads.connected', `API connection for "${acc.name}" updated`, null, req.user._id);
  res.json(adsync.connectionView(acc));
});

accounts.router.delete('/:id/connection', authorize('ads', 'u'), async (req, res) => {
  res.json(adsync.connectionView(await adsync.disconnect(await account(req))));
});

accounts.router.post('/:id/sync', authorize('ads', 'u'), async (req, res) => {
  const days = Math.min(90, Math.max(1, +req.body?.days || 30));
  res.json(await adsync.syncAccount(await account(req), { days }));
});

// "Sign in with Google": returns the consent URL; Google redirects to /api/oauth/google-ads/callback.
accounts.router.get('/:id/google-signin', authorize('ads', 'u'), async (req, res) => {
  const acc = await account(req);
  if (acc.platform !== 'google') throw new HttpError(400, 'Not a Google Ads account');
  res.json({ url: require('./oauth').googleConsentUrl(req.companyId, acc._id) });
});

accounts.router.get('/summary', authorize('ads', 'r'), async (req, res) => {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const accs = await M.AdAccount.find({ company: req.companyId });
  const camps = await M.AdCampaign.find({ company: req.companyId }).select('account status');
  const byCamp = new Map(camps.map((c) => [String(c._id), String(c.account)]));
  const rows = await M.AdMetric.aggregate([{ $match: { company: req.companyId, date: { $gte: monthStart } } }, { $group: { _id: '$campaign', spend: { $sum: '$spend' }, leads: { $sum: '$leads' } } }]);
  const spend = {}, leads = {};
  for (const r of rows) { const a = byCamp.get(String(r._id)); spend[a] = (spend[a] || 0) + r.spend; leads[a] = (leads[a] || 0) + r.leads; }
  res.json(accs.map((a) => ({
    id: a._id, name: a.name, platform: a.platform, status: a.status, monthlyBudget: a.monthlyBudget,
    campaigns: camps.filter((c) => String(c.account) === String(a._id)).length,
    activeCampaigns: camps.filter((c) => String(c.account) === String(a._id) && c.status === 'active').length,
    spendThisMonth: r2(spend[a._id] || 0), leadsThisMonth: leads[a._id] || 0,
    budgetUsedPct: a.monthlyBudget ? r2(div(spend[a._id] || 0, a.monthlyBudget) * 100) : null,
  })));
});
router.use('/accounts', accounts.finish());

// ---------------- Campaigns ----------------
const campaigns = crud({
  Model: M.AdCampaign, resource: 'ads', search: ['name'], filters: ['status', 'account', 'objective'], scope: false,
  populate: [{ path: 'account', select: 'name platform currency' }, { path: 'owner', select: 'name' }],
  hooks: {
    async beforeCreate(req, data) {
      const acc = await M.AdAccount.findOne({ _id: data.account, company: req.companyId });
      if (!acc) throw new HttpError(400, 'Valid ad account is required');
      delete data.status; delete data.approvalNote;
      data.owner = req.user._id;
      data.utm = { source: acc.platform, medium: 'cpc', ...data.utm };
      data.utm.campaign ||= adsync.trackingCode(data.name); // unique tracking code for lead attribution
      if (data.startDate && data.endDate && new Date(data.endDate) < new Date(data.startDate)) throw new HttpError(400, 'endDate is before startDate');
    },
    async beforeUpdate(req, c, data) {
      delete data.status; delete data.approvalNote; delete data.owner; delete data.externalBudgetId; delete data.syncError;
      if (data.account && String(data.account) !== String(c.account)) throw new HttpError(400, 'Account cannot be changed');
      if (data.externalId !== undefined && c.externalId && data.externalId !== c.externalId) throw new HttpError(400, 'Linked network campaign cannot be changed');
      if (data.dailyBudget != null && c.status === 'active' && !isApprover(req) && data.dailyBudget > (await approvalLimit(req.companyId))) {
        throw new HttpError(403, 'Daily budget above the approval limit needs a manager');
      }
      if (data.dailyBudget != null && data.dailyBudget !== c.dailyBudget) await adsync.push(c, { dailyBudget: data.dailyBudget });
    },
    async beforeDelete(req, c) {
      await M.AdCreative.deleteMany({ campaign: c._id });
      await M.AdMetric.deleteMany({ campaign: c._id });
      await M.Lead.updateMany({ adCampaign: c._id }, { $unset: { adCampaign: 1 } });
    },
  },
});

const setStatus = (to, from) => async (req, res) => {
  const c = await campaigns.find(req);
  if (!from.includes(c.status)) throw new HttpError(409, `Cannot do this while campaign is ${c.status}`);
  res.json(await adsync.changeStatus(c, to, { by: req.user._id }));
};

campaigns.router.post('/:id/launch', authorize('ads', 'u'), async (req, res) => {
  const c = await campaigns.find(req);
  if (!['draft', 'paused'].includes(c.status)) throw new HttpError(409, `Cannot launch a ${c.status} campaign`);
  if (!c.dailyBudget) throw new HttpError(400, 'Set a daily budget before launching');
  if (!isApprover(req) && c.dailyBudget > (await approvalLimit(req.companyId))) {
    c.status = 'pending_approval';
    await c.save();
    await notifyApprovers(req.companyId, 'Ad campaign needs approval', `${c.name} (daily budget ${c.dailyBudget})`, c._id);
    return res.json({ ...c.toObject(), message: 'Budget is above your approval limit; sent to a manager.' });
  }
  res.json(await adsync.changeStatus(c, 'active', { by: req.user._id }));
});

campaigns.router.post('/:id/approve', authorize('ads', 'u'), async (req, res) => {
  if (!isApprover(req)) throw new HttpError(403, 'Only a manager or admin can approve');
  const c = await campaigns.find(req);
  if (c.status !== 'pending_approval') throw new HttpError(409, 'Campaign is not waiting for approval');
  await adsync.changeStatus(c, 'active', { note: `Approved by ${req.user.name}`, by: req.user._id });
  await notify(req.companyId, c.owner, 'Campaign approved', c.name, { kind: 'AdCampaign', id: c._id });
  res.json(c);
});

campaigns.router.post('/:id/reject', authorize('ads', 'u'), async (req, res) => {
  if (!isApprover(req)) throw new HttpError(403, 'Only a manager or admin can reject');
  const c = await campaigns.find(req);
  if (c.status !== 'pending_approval') throw new HttpError(409, 'Campaign is not waiting for approval');
  c.status = 'draft';
  c.approvalNote = `Rejected by ${req.user.name}: ${req.body.reason || 'no reason given'}`;
  await c.save();
  await notify(req.companyId, c.owner, 'Campaign rejected', c.approvalNote, { kind: 'AdCampaign', id: c._id });
  res.json(c);
});

campaigns.router.post('/:id/pause', authorize('ads', 'u'), setStatus('paused', ['active']));
campaigns.router.post('/:id/resume', authorize('ads', 'u'), setStatus('active', ['paused']));
campaigns.router.post('/:id/end', authorize('ads', 'u'), setStatus('ended', ['active', 'paused', 'draft']));

// Re-checks one campaign now: budget cap, no-leads rule and the ad.performance_updated workflows (normally after each sync / data entry).
campaigns.router.post('/:id/run-automation', authorize('ads', 'u'), async (req, res) => {
  const c = await campaigns.find(req);
  const since = new Date();
  const autoPaused = await adsync.afterNewData(req.companyId, [c._id]);
  const runs = await M.WorkflowRun.find({ company: req.companyId, 'entity.id': c._id, createdAt: { $gte: since } }).populate('workflow', 'name');
  res.json({
    campaign: await M.AdCampaign.findById(c._id), autoPaused, stats: await adsync.campaignStats(c),
    runs: runs.map((r) => ({ workflow: r.workflow?.name, event: r.event, status: r.status, error: r.error, log: r.log.map((l) => `${l.ok ? '✓' : '✗'} ${l.step} ${l.detail}`) })),
  });
});

campaigns.router.post('/:id/clone', authorize('ads', 'c'), async (req, res) => {
  const c = (await campaigns.find(req)).toObject();
  const { _id, __v, createdAt, updatedAt, status, utm, approvalNote, externalId, externalBudgetId, syncError, ...rest } = c;
  const copy = await M.AdCampaign.create({ ...rest, name: `${c.name} (copy)`, owner: req.user._id, utm: { ...utm, campaign: adsync.trackingCode(c.name) } });
  const creatives = await M.AdCreative.find({ campaign: c._id });
  await M.AdCreative.insertMany(creatives.map((x) => { const o = x.toObject(); delete o._id; delete o.__v; delete o.createdAt; delete o.updatedAt; return { ...o, campaign: copy._id }; }));
  res.status(201).json(copy);
});

// Tracking link: GET /campaigns/:id/utm?url=https://site.com/landing[&content=creativeA]
campaigns.router.get('/:id/utm', authorize('ads', 'r'), async (req, res) => {
  const c = await campaigns.find(req);
  let u;
  try { u = new URL(String(req.query.url)); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw new HttpError(400, 'url must be a valid http(s) URL'); }
  u.searchParams.set('utm_source', c.utm.source || 'ads');
  u.searchParams.set('utm_medium', c.utm.medium || 'cpc');
  u.searchParams.set('utm_campaign', c.utm.campaign);
  if (req.query.content) u.searchParams.set('utm_content', String(req.query.content).slice(0, 60));
  res.json({ url: u.toString(), utmCampaign: c.utm.campaign });
});

campaigns.router.get('/:id/performance', authorize('ads', 'r'), async (req, res) => {
  const c = await campaigns.find(req);
  const days = Math.min(365, Math.max(1, +req.query.days || 30));
  const from = addDays(day(new Date()), -(days - 1));
  const match = { company: req.companyId, campaign: c._id, date: { $gte: from } };
  const [tot, series, all, crm] = await Promise.all([
    M.AdMetric.aggregate([{ $match: match }, { $group: { _id: null, ...SUMS } }]),
    M.AdMetric.aggregate([{ $match: match }, { $group: { _id: '$date', ...SUMS } }, { $sort: { _id: 1 } }]),
    M.AdMetric.aggregate([{ $match: { company: req.companyId, campaign: c._id } }, { $group: { _id: null, spend: { $sum: '$spend' } } }]),
    M.Lead.countDocuments({ company: req.companyId, adCampaign: c._id }),
  ]);
  const spent = all[0]?.spend || 0;
  res.json({
    campaign: { id: c._id, name: c.name, status: c.status, dailyBudget: c.dailyBudget, totalBudget: c.totalBudget },
    totals: kpis(tot[0]), crmLeads: crm, totalSpentAllTime: r2(spent), budgetUsedPct: c.totalBudget ? r2(div(spent, c.totalBudget) * 100) : null,
    daily: series.map((s) => ({ date: s._id.toISOString().slice(0, 10), ...kpis(s) })),
  });
});
router.use('/campaigns', campaigns.finish());

// ---------------- Creatives (A/B) ----------------
const creatives = crud({
  Model: M.AdCreative, resource: 'ads', search: ['name', 'headline'], filters: ['campaign', 'status', 'type'], scope: false,
  populate: { path: 'campaign', select: 'name' },
  hooks: {
    async beforeCreate(req, data) { if (!(await M.AdCampaign.exists({ _id: data.campaign, company: req.companyId }))) throw new HttpError(400, 'Valid campaign is required'); },
    beforeUpdate(req, doc, data) { delete data.campaign; },
    async beforeDelete(req, cr) { await M.AdMetric.deleteMany({ creative: cr._id }); },
  },
});

// Compare creatives of a campaign; winner = best CTR among creatives with enough impressions.
creatives.router.get('/compare/:campaignId', authorize('ads', 'r'), async (req, res) => {
  const camp = await M.AdCampaign.findOne({ _id: req.params.campaignId, company: req.companyId });
  if (!camp) throw new HttpError(404, 'Campaign not found');
  const items = await M.AdCreative.find({ company: req.companyId, campaign: camp._id });
  const rows = await M.AdMetric.aggregate([{ $match: { company: req.companyId, campaign: camp._id, creative: { $in: items.map((i) => i._id) } } }, { $group: { _id: '$creative', ...SUMS } }]);
  const by = Object.fromEntries(rows.map((r) => [String(r._id), r]));
  const list = items.map((i) => ({ id: i._id, name: i.name, variant: i.variant, status: i.status, ...kpis(by[String(i._id)]) }));
  const eligible = list.filter((x) => x.impressions >= 500);
  const winner = eligible.length >= 2 ? eligible.reduce((a, b) => (b.ctr > a.ctr ? b : a)) : null;
  res.json({ creatives: list, winner: winner && { id: winner.id, name: winner.name, variant: winner.variant, ctr: winner.ctr }, note: winner ? undefined : 'Need at least two creatives with 500+ impressions of data to pick a winner.' });
});
router.use('/creatives', creatives.finish());

// ---------------- Performance data ----------------
const metrics = express.Router();
const num = z.coerce.number().min(0).default(0);
const rowSchema = z.object({
  campaign: z.string().length(24), creative: z.string().length(24).nullish(), date: z.coerce.date(),
  impressions: num, clicks: num, spend: num, leads: num, conversions: num, revenue: num,
}).refine((r) => r.clicks <= r.impressions || r.impressions === 0, { message: 'clicks cannot exceed impressions' });

async function upsertMetric(company, r) {
  if (!(await M.AdCampaign.exists({ _id: r.campaign, company }))) throw new Error('Campaign not found');
  if (r.creative && !(await M.AdCreative.exists({ _id: r.creative, company, campaign: r.campaign }))) throw new Error('Creative does not belong to campaign');
  const { campaign, creative, date, ...vals } = r;
  await M.AdMetric.updateOne({ company, campaign, creative: creative || null, date: day(date) }, { $set: vals }, { upsert: true });
}

metrics.get('/', authorize('ads', 'r'), async (req, res) => {
  const q = { company: req.companyId };
  if (req.query.campaign) q.campaign = req.query.campaign;
  if (req.query.from || req.query.to) q.date = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
  const page = Math.max(1, +req.query.page || 1);
  const [data, total] = await Promise.all([
    M.AdMetric.find(q).sort('-date').skip((page - 1) * 20).limit(20).populate('campaign', 'name').populate('creative', 'name variant').lean(),
    M.AdMetric.countDocuments(q),
  ]);
  res.json({ data: data.map((d) => ({ ...d, ...kpis(d), date: d.date })), page, limit: 20, total, pages: Math.ceil(total / 20) });
});

metrics.post('/', authorize('ads', 'c'), validate(rowSchema), async (req, res) => {
  try { await upsertMetric(req.companyId, req.body); } catch (e) { throw new HttpError(400, e.message); }
  await adsync.afterNewData(req.companyId, [req.body.campaign]); // budget cap, no-leads rule, workflow triggers
  res.status(201).json({ saved: true });
});

// CSV columns: date,campaign,impressions,clicks,spend,leads,conversions,revenue ("campaign" = name or utm code)
metrics.post('/import', express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }), authorize('ads', 'c'), async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!text) throw new HttpError(400, 'Send CSV as text/csv body or JSON {"csv": "..."}');
  const rows = parseCsv(text);
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Max ${MAX_IMPORT_ROWS} rows per import`);
  const camps = await M.AdCampaign.find({ company: req.companyId }).select('name utm');
  const byKey = new Map(camps.flatMap((c) => [[c.name.toLowerCase(), c._id], [String(c.utm?.campaign || '').toLowerCase(), c._id]]));
  let saved = 0; const errors = []; const touched = new Set();
  for (const [i, r] of rows.entries()) {
    const id = byKey.get(String(r.campaign || '').toLowerCase());
    if (!id) { errors.push({ row: i + 2, error: `Unknown campaign "${r.campaign}"` }); continue; }
    const parsed = rowSchema.safeParse({ ...r, campaign: String(id), creative: undefined });
    if (!parsed.success) { errors.push({ row: i + 2, error: parsed.error.issues[0].message }); continue; }
    try { await upsertMetric(req.companyId, parsed.data); saved++; touched.add(String(id)); } catch (e) { errors.push({ row: i + 2, error: e.message }); }
  }
  await adsync.afterNewData(req.companyId, [...touched]);
  res.status(201).json({ saved, failed: errors.length, errors: errors.slice(0, 50) });
});

metrics.delete('/:id', authorize('ads', 'd'), async (req, res) => {
  const r = await M.AdMetric.deleteOne({ _id: req.params.id, company: req.companyId });
  if (!r.deletedCount) throw new HttpError(404, 'Metric row not found');
  res.status(204).end();
});
router.use('/metrics', metrics);

// ---------------- Overview, attribution, insights ----------------
async function loadContext(company) {
  const [camps, accs] = await Promise.all([M.AdCampaign.find({ company }), M.AdAccount.find({ company })]);
  return { camps, accs, accById: new Map(accs.map((a) => [String(a._id), a])) };
}

router.get('/overview', authorize('ads', 'r'), async (req, res) => {
  const days = Math.min(365, Math.max(1, +req.query.days || 30));
  const to = day(new Date());
  const from = addDays(to, -(days - 1));
  const prevFrom = addDays(from, -days);
  const co = req.companyId;
  const { camps, accById } = await loadContext(co);
  const [cur, prev, series, byCamp] = await Promise.all([
    M.AdMetric.aggregate([{ $match: { company: co, date: { $gte: from } } }, { $group: { _id: null, ...SUMS } }]),
    M.AdMetric.aggregate([{ $match: { company: co, date: { $gte: prevFrom, $lt: from } } }, { $group: { _id: null, ...SUMS } }]),
    M.AdMetric.aggregate([{ $match: { company: co, date: { $gte: from } } }, { $group: { _id: '$date', ...SUMS } }, { $sort: { _id: 1 } }]),
    M.AdMetric.aggregate([{ $match: { company: co, date: { $gte: from } } }, { $group: { _id: '$campaign', ...SUMS } }]),
  ]);
  const campById = new Map(camps.map((c) => [String(c._id), c]));
  const perCampaign = byCamp.map((r) => {
    const c = campById.get(String(r._id));
    return { id: r._id, name: c?.name || '(deleted)', status: c?.status, platform: accById.get(String(c?.account))?.platform, ...kpis(r) };
  }).sort((a, b) => b.spend - a.spend);
  const platforms = {};
  for (const p of perCampaign) { const k = p.platform || 'other'; const x = (platforms[k] ||= { impressions: 0, clicks: 0, spend: 0, leads: 0, conversions: 0, revenue: 0 }); for (const f of Object.keys(x)) x[f] += p[f]; }
  const dailyMap = new Map(series.map((s) => [s._id.toISOString().slice(0, 10), s]));
  const daily = Array.from({ length: days }, (_, i) => { const d = addDays(from, i).toISOString().slice(0, 10); return { date: d, ...kpis(dailyMap.get(d)) }; });
  const now = kpis(cur[0]), before = kpis(prev[0]);
  const delta = (k) => (before[k] ? r2(((now[k] - before[k]) / before[k]) * 100) : null);
  res.json({
    days, totals: now, previous: before,
    change: { spend: delta('spend'), leads: delta('leads'), clicks: delta('clicks'), impressions: delta('impressions'), cpl: delta('cpl'), roas: delta('roas') },
    daily, platforms: Object.entries(platforms).map(([platform, v]) => ({ platform, ...kpis(v) })).sort((a, b) => b.spend - a.spend),
    topCampaigns: perCampaign.slice(0, 8),
    counts: { active: camps.filter((c) => c.status === 'active').length, pendingApproval: camps.filter((c) => c.status === 'pending_approval').length, total: camps.length },
  });
});

// CRM view: which ad campaigns actually produced leads and revenue.
router.get('/attribution', authorize('ads', 'r'), async (req, res) => {
  const co = req.companyId;
  const { camps, accById } = await loadContext(co);
  const leadRows = await M.Lead.aggregate([
    { $match: { company: co, adCampaign: { $ne: null } } },
    { $group: { _id: '$adCampaign', leads: { $sum: 1 }, qualified: { $sum: { $cond: [{ $in: ['$status', ['qualified', 'proposal_sent', 'negotiation', 'won']] }, 1, 0] } }, won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } } } },
  ]);
  const leadToCamp = new Map((await M.Lead.find({ company: co, adCampaign: { $ne: null } }).select('adCampaign')).map((l) => [String(l._id), String(l.adCampaign)]));
  const deals = await M.Deal.find({ company: co, status: 'won', lead: { $in: [...leadToCamp.keys()] } }).select('lead value');
  const revenue = {};
  for (const d of deals) { const c = leadToCamp.get(String(d.lead)); revenue[c] = (revenue[c] || 0) + d.value; }
  const spendRows = await M.AdMetric.aggregate([{ $match: { company: co } }, { $group: { _id: '$campaign', spend: { $sum: '$spend' } } }]);
  const spend = Object.fromEntries(spendRows.map((s) => [String(s._id), s.spend]));
  const lb = Object.fromEntries(leadRows.map((l) => [String(l._id), l]));
  res.json(camps.filter((c) => lb[String(c._id)] || spend[String(c._id)]).map((c) => {
    const l = lb[String(c._id)] || { leads: 0, qualified: 0, won: 0 };
    const sp = spend[String(c._id)] || 0, rev = revenue[String(c._id)] || 0;
    return {
      id: c._id, campaign: c.name, platform: accById.get(String(c.account))?.platform, utm: c.utm?.campaign,
      spend: r2(sp), crmLeads: l.leads, qualified: l.qualified, won: l.won, revenue: rev,
      costPerCrmLead: r2(div(sp, l.leads)), roas: r2(div(rev, sp)), winRate: r2(div(l.won, l.leads) * 100),
    };
  }).sort((a, b) => b.revenue - a.revenue || b.crmLeads - a.crmLeads));
});

// Rule-based recommendations over the last 14 days.
router.get('/insights', authorize('ads', 'r'), async (req, res) => {
  const co = req.companyId;
  const from = addDays(day(new Date()), -13);
  const { camps } = await loadContext(co);
  const active = camps.filter((c) => c.status === 'active');
  const rows = await M.AdMetric.aggregate([{ $match: { company: co, date: { $gte: from } } }, { $group: { _id: '$campaign', ...SUMS } }]);
  const by = Object.fromEntries(rows.map((r) => [String(r._id), kpis(r)]));
  const overall = kpis(rows.reduce((a, r) => { for (const k of Object.keys(SUMS)) a[k] = (a[k] || 0) + r[k]; return a; }, {}));
  const life = Object.fromEntries((await M.AdMetric.aggregate([{ $match: { company: co } }, { $group: { _id: '$campaign', spend: { $sum: '$spend' } } }])).map((s) => [String(s._id), s.spend]));
  const out = [];
  const add = (sev, c, title, detail, apply) => out.push({ severity: sev, campaignId: c._id, campaign: c.name, title, detail, apply });

  for (const c of active) {
    const m = by[String(c._id)];
    if (!m || (!m.impressions && !m.spend)) { add('medium', c, 'No delivery', 'Active but no data in 14 days. Check the ad network or import fresh numbers.'); continue; }
    if (adsync.wastingSpend(m, overall.cpl)) {
      add('high', c, 'Spending with no leads', `Spent ${m.spend} with zero leads in 14 days.`, { label: 'Pause campaign', method: 'POST', path: `/ads/campaigns/${c._id}/pause` });
    } else if (overall.cpl && m.leads >= 3 && m.cpl > overall.cpl * 1.5) {
      add('high', c, 'Cost per lead is high', `CPL ${m.cpl} vs account average ${overall.cpl}. Reduce budget or fix targeting.`, { label: 'Cut daily budget 30%', method: 'PATCH', path: `/ads/campaigns/${c._id}`, body: { dailyBudget: Math.round(c.dailyBudget * 0.7) } });
    }
    if (m.roas >= 3 && m.spend > 0) {
      add('good', c, 'Strong return', `ROAS ${m.roas}x. Consider scaling.`, { label: 'Raise daily budget 20%', method: 'PATCH', path: `/ads/campaigns/${c._id}`, body: { dailyBudget: Math.round(c.dailyBudget * 1.2) } });
    }
    if (m.impressions >= 1000 && m.ctr < 0.8) add('medium', c, 'Low click-through rate', `CTR ${m.ctr}%. Refresh headlines/creatives or tighten the audience.`);
    if (c.totalBudget) {
      const used = div(life[String(c._id)] || 0, c.totalBudget);
      if (used >= 0.9) add('high', c, 'Budget almost used', `${Math.round(used * 100)}% of total budget spent. It will auto-pause at 100%.`);
      if (c.startDate && c.endDate) {
        const elapsed = div(Date.now() - c.startDate, c.endDate - c.startDate);
        if (elapsed > 0 && elapsed < 1 && used - elapsed > 0.2) add('medium', c, 'Overspending vs schedule', `${Math.round(used * 100)}% spent after ${Math.round(elapsed * 100)}% of the flight.`);
        if (elapsed > 0.3 && elapsed < 1 && elapsed - used > 0.3) add('medium', c, 'Underspending vs schedule', `${Math.round(used * 100)}% spent after ${Math.round(elapsed * 100)}% of the flight.`);
      }
    }
  }
  const pending = camps.filter((c) => c.status === 'pending_approval');
  for (const c of pending) add('medium', c, 'Waiting for approval', `Daily budget ${c.dailyBudget} is above the approval limit.`);
  const rank = { high: 0, medium: 1, good: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const accountAvg = { cpl: overall.cpl, ctr: overall.ctr, roas: overall.roas };
  // ?ai=1 adds a plain-language review by the LLM (one call, so it is only made on request).
  let aiReview;
  if (req.query.ai === '1') {
    const campaigns = camps.filter((c) => ['active', 'paused'].includes(c.status) && by[String(c._id)])
      .sort((a, b) => by[String(b._id)].spend - by[String(a._id)].spend).slice(0, 25)
      .map((c) => ({ name: c.name, status: c.status, objective: c.objective, dailyBudget: c.dailyBudget, last14Days: by[String(c._id)] }));
    aiReview = await adai.insights({ window: '14 days', accountAverage: { ...accountAvg, spend: overall.spend, leads: overall.leads }, campaigns, ruleFindings: out.map(({ campaign, title, detail, severity }) => ({ campaign, title, detail, severity })) });
  }
  res.json({ engine: 'rules', window: '14 days', accountAvg, insights: out, ai: aiReview });
});

// ---------------- AI: campaign suggestions (approved by a manager), ad copy ----------------
const loadRec = async (req) => {
  const r = await M.AdRecommendation.findOne({ _id: req.params.id, company: req.companyId });
  if (!r) throw new HttpError(404, 'Suggestion not found');
  return r;
};

router.get('/recommendations', authorize('ads', 'r'), async (req, res) => {
  const q = { company: req.companyId };
  if (req.query.status) q.status = String(req.query.status);
  const data = await M.AdRecommendation.find(q).sort('-createdAt').limit(Math.min(200, +req.query.limit || 100))
    .populate('campaign', 'name status dailyBudget objective').populate('decidedBy', 'name');
  res.json({ data, pending: await M.AdRecommendation.countDocuments({ company: req.companyId, status: 'pending' }) });
});

for (const [path, approve] of [['approve', true], ['reject', false]]) {
  router.post(`/recommendations/:id/${path}`, authorize('ads', 'u'), async (req, res) => {
    if (!isApprover(req)) throw new HttpError(403, 'Only a manager or admin can decide AI suggestions');
    res.json(await adai.decide(await loadRec(req), req.user, approve));
  });
}

// Review one campaign (campaignId) or every active/paused linked campaign now, ignoring the every-24h limit.
router.post('/ai/review', authorize('ads', 'u'), validate(z.object({ campaignId: z.string().length(24).optional(), maxChangePct: z.number().min(5).max(100).optional() })), async (req, res) => {
  const q = { company: req.companyId, status: { $in: ['active', 'paused'] } };
  if (req.body.campaignId) q._id = req.body.campaignId;
  const camps = await M.AdCampaign.find(q).limit(20);
  if (!camps.length) throw new HttpError(404, 'No active or paused campaign to review');
  const results = [];
  for (const c of camps) {
    const r = await adai.recommend(c, { maxChangePct: req.body.maxChangePct, everyHours: 0, source: 'manual' });
    results.push({ campaign: c.name, ...(r.skipped ? { skipped: r.skipped } : { action: r.action, label: adai.label(r), reason: r.reason, engine: r.engine, recommendation: r._id }) });
  }
  res.json({ results });
});

router.post('/ai/copy', authorize('ads', 'r'), validate(z.object({
  product: z.string().min(2).max(500), audience: z.string().max(300).optional(), offer: z.string().max(300).optional(),
  language: z.string().max(40).optional(), tone: z.string().max(40).optional(), platform: z.enum(['meta', 'google']).optional(),
  count: z.number().int().min(1).max(6).optional(),
  campaignId: z.string().length(24).optional(), landingUrl: z.string().max(500).optional(), save: z.boolean().optional(),
  // save the variants already shown instead of writing new ones
  variants: z.array(z.object({ angle: z.string().max(40).optional(), headline: z.string().min(1).max(80), body: z.string().min(1).max(500), cta: z.enum(adai.CTAS) })).max(6).optional(),
})), async (req, res) => {
  const out = req.body.save && req.body.variants?.length ? { variants: req.body.variants } : await adai.adCopy(req.body);
  if (req.body.save) {
    if (!req.body.campaignId) throw new HttpError(400, 'Choose a campaign to save the creatives to');
    const c = await M.AdCampaign.findOne({ _id: req.body.campaignId, company: req.companyId }).select('_id');
    if (!c) throw new HttpError(404, 'Campaign not found');
    const used = new Set((await M.AdCreative.find({ campaign: c._id }).select('variant')).map((x) => x.variant));
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !used.has(l));
    out.saved = await M.AdCreative.insertMany(out.variants.map((v, i) => ({
      company: req.companyId, campaign: c._id, name: `AI ${v.angle || 'variant'} ${letters[i] || i + 1}`, variant: letters[i] || String(i + 1),
      type: 'image', headline: v.headline, body: v.body, cta: v.cta, landingUrl: req.body.landingUrl,
    })));
  }
  res.json(out);
});

module.exports = router;
