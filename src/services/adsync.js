/**
 * Ad network APIs: Google Ads and Meta (Facebook / Instagram) Marketing API.
 *
 *   pull   - campaigns and daily numbers (impressions, clicks, spend, conversions) into AdCampaign / AdMetric
 *   push   - pause / resume / daily budget changes made in the CRM are sent to the network first
 *   rules  - lifetime budget cap and (opt-in per account) auto-pause of lead campaigns spending with no leads
 *   events - new numbers (sync, manual entry or CSV) fire workflow triggers on the campaign:
 *            ad.performance_updated, ad.no_leads, ad.budget_exhausted, ad.campaign_imported, ad.status_changed, ad.sync_failed
 *
 * Accounts sync every few hours from the scheduler and on "Sync now". Credentials are sealed like
 * channel-provider credentials (services/providers.js) and never leave the server in clear text.
 * Campaigns are created on the network itself; the CRM imports them and controls status and budget.
 */
const config = require('../config');
const M = require('../models');
const { seal, unseal, maskedConfig, mergeConfig } = require('./providers');
const { notify, logActivity, emit } = require('./events');
const { accessProblem, hasModule } = require('../modules');
const tenants = require('./tenants');

const SYNC_EVERY_MS = 3 * 3600e3;
const SYNC_DAYS = 7; // conversions are attributed late, so recent days are re-read every sync
const APPROVER_ROLES = ['super_admin', 'admin', 'manager'];

const FIELDS = {
  google: [
    { k: 'refreshToken', label: 'OAuth refresh token (filled in by "Sign in with Google")', secret: true, req: true },
    { k: 'loginCustomerId', label: 'Manager (MCC) account ID, if access is through one', placeholder: '123-456-7890' },
    { k: 'developerToken', label: 'Developer token (blank = server default)', secret: true },
    { k: 'clientId', label: 'OAuth client ID (blank = server default)' },
    { k: 'clientSecret', label: 'OAuth client secret (blank = server default)', secret: true },
  ],
  meta: [
    { k: 'accessToken', label: 'System user access token with ads_read + ads_management', secret: true, req: true },
  ],
};
const SUPPORTED = Object.keys(FIELDS);

// ---------- small helpers ----------
const day = (d) => { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); };
const ymd = (d) => d.toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Unique utm_campaign code that ties form leads to a campaign.
const trackingCode = (name) => `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`;

// The same "spending with no leads" rule drives the Insights card and the auto-pause.
const wastingSpend = (m, avgCpl) => m.spend > 0 && m.leads === 0 && m.spend >= Math.max(1000, (avgCpl || 0) * 2);

const DEFAULT_APPROVAL_LIMIT = 5000; // daily budget above this needs a manager (company.settings.adApprovalLimit overrides)
async function approvalLimit(company) {
  const co = await M.Company.findById(company).select('settings');
  return +co?.settings?.adApprovalLimit || DEFAULT_APPROVAL_LIMIT;
}

// Derived KPIs from summed raw numbers.
const div = (a, b) => (b ? a / b : 0);
function kpis(t) {
  const { _id, ...rest } = t || {};
  const x = { impressions: 0, clicks: 0, spend: 0, leads: 0, conversions: 0, revenue: 0, ...rest };
  return {
    ...x,
    spend: r2(x.spend), revenue: r2(x.revenue),
    ctr: r2(div(x.clicks, x.impressions) * 100), cpc: r2(div(x.spend, x.clicks)), cpm: r2(div(x.spend, x.impressions) * 1000),
    cpl: r2(div(x.spend, x.leads)), cpa: r2(div(x.spend, x.conversions)), roas: r2(div(x.revenue, x.spend)),
  };
}
const SUMS = { impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, spend: { $sum: '$spend' }, leads: { $sum: '$leads' }, conversions: { $sum: '$conversions' }, revenue: { $sum: '$revenue' } };
const ref = (c) => ({ kind: 'AdCampaign', id: c._id });

async function call(url, { method = 'GET', headers = {}, json, form } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    // Google: error.details[].errors[].message is the useful part; Meta: error.error_user_msg / error.message.
    const e = data?.error || (Array.isArray(data) && data[0]?.error) || {};
    const detail = e.details?.flatMap((d) => d.errors || []).map((x) => x.message).filter(Boolean).join('; ');
    throw new Error(`${res.status}: ${detail || e.error_user_msg || e.message || e.error_description || String(text).slice(0, 240)}`);
  }
  return data;
}

async function notifyApprovers(company, title, body, id) {
  const users = await M.User.find({ company, active: true, role: { $in: APPROVER_ROLES } }).select('_id');
  await Promise.all(users.map((u) => notify(company, u._id, title, body, { kind: 'AdCampaign', id })));
}

// ---------- Google Ads ----------
const tokens = new Map(); // refresh token -> { token, exp }

function googleCfg(cfg) {
  const g = config.googleAds;
  return {
    refreshToken: cfg.refreshToken,
    developerToken: cfg.developerToken || g.developerToken,
    clientId: cfg.clientId || g.clientId,
    clientSecret: cfg.clientId ? cfg.clientSecret : g.clientSecret,
    loginCustomerId: digits(cfg.loginCustomerId || g.loginCustomerId),
  };
}

async function googleToken(c) {
  const hit = tokens.get(c.refreshToken);
  if (hit && hit.exp > Date.now() + 60e3) return hit.token;
  if (!c.clientId || !c.clientSecret) throw new Error('Google OAuth client ID/secret missing (set GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET or enter them on the account)');
  const r = await call('https://oauth2.googleapis.com/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret } });
  tokens.set(c.refreshToken, { token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
  return r.access_token;
}

async function gads(acc, cfg, path, body) {
  const c = googleCfg(cfg);
  if (!c.developerToken) throw new Error('Google Ads developer token missing (GOOGLE_ADS_DEVELOPER_TOKEN)');
  const cid = digits(acc.accountId);
  if (!cid) throw new Error('Set the account ID to the Google Ads customer ID (123-456-7890)');
  const headers = { Authorization: `Bearer ${await googleToken(c)}`, 'developer-token': c.developerToken };
  if (c.loginCustomerId) headers['login-customer-id'] = c.loginCustomerId;
  return call(`https://googleads.googleapis.com/${config.googleAds.apiVersion}/customers/${cid}/${path}`, { method: 'POST', headers, json: body });
}

const gaql = async (acc, cfg, query) => (await gads(acc, cfg, 'googleAds:searchStream', { query })).flatMap((b) => b.results || []);
const G_STATUS = { ENABLED: 'active', PAUSED: 'paused', REMOVED: 'ended' };

const google = {
  async pull(acc, cfg, from, to) {
    const camps = await gaql(acc, cfg, 'SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget, campaign_budget.amount_micros FROM campaign');
    const rows = await gaql(acc, cfg, `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${ymd(from)}' AND '${ymd(to)}'`);
    return {
      campaigns: camps.map((r) => ({
        externalId: String(r.campaign.id), name: r.campaign.name, status: G_STATUS[r.campaign.status] || 'paused',
        budgetId: r.campaign.campaignBudget, dailyBudget: r.campaignBudget?.amountMicros != null ? r2(r.campaignBudget.amountMicros / 1e6) : undefined,
      })),
      // Google reports conversions, not leads: they count as leads on lead-objective campaigns (see save()).
      rows: rows.map((r) => ({
        externalId: String(r.campaign.id), date: r.segments.date,
        impressions: +r.metrics.impressions || 0, clicks: +r.metrics.clicks || 0, spend: r2((+r.metrics.costMicros || 0) / 1e6),
        conversions: r2(+r.metrics.conversions || 0), revenue: r2(+r.metrics.conversionsValue || 0),
      })),
    };
  },
  async setStatus(acc, cfg, c, active) {
    const cid = digits(acc.accountId);
    await gads(acc, cfg, 'campaigns:mutate', { operations: [{ update: { resourceName: `customers/${cid}/campaigns/${c.externalId}`, status: active ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }] });
  },
  // Note: a shared budget changes for every campaign that uses it.
  async setBudget(acc, cfg, c, amount) {
    if (!c.externalBudgetId) throw new Error('Budget not known yet; run a sync first');
    await gads(acc, cfg, 'campaignBudgets:mutate', { operations: [{ update: { resourceName: c.externalBudgetId, amountMicros: String(Math.round(amount * 1e6)) }, updateMask: 'amount_micros' }] });
  },
  async test(acc, cfg) { await gaql(acc, cfg, 'SELECT customer.id FROM customer LIMIT 1'); },
};

// ---------- Meta (Facebook / Instagram) ----------
// Budgets are in the currency's minor unit, except for these currencies.
const NO_MINOR_UNIT = ['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND'];
const minor = (acc) => (NO_MINOR_UNIT.includes(String(acc.currency).toUpperCase()) ? 1 : 100);
const actId = (acc) => { const d = digits(acc.accountId); if (!d) throw new Error('Set the account ID to the Meta ad account ID (act_123…)'); return 'act_' + d; };
const graph = (path) => `https://graph.facebook.com/${config.metaGraphVersion}/${path}`;
const metaAuth = (cfg) => ({ Authorization: `Bearer ${cfg.accessToken}` });

async function metaList(cfg, url, maxPages = 20) {
  const out = [];
  for (let i = 0; url && i < maxPages; i++) {
    const r = await call(url, { headers: metaAuth(cfg) });
    out.push(...(r.data || []));
    url = r.paging?.next;
  }
  return out;
}

const M_STATUS = { ACTIVE: 'active', PAUSED: 'paused', DELETED: 'ended', ARCHIVED: 'ended' };
const M_OBJECTIVE = {
  OUTCOME_LEADS: 'leads', LEAD_GENERATION: 'leads', OUTCOME_SALES: 'sales', CONVERSIONS: 'sales', PRODUCT_CATALOG_SALES: 'sales',
  OUTCOME_TRAFFIC: 'traffic', LINK_CLICKS: 'traffic', OUTCOME_AWARENESS: 'awareness', REACH: 'awareness', BRAND_AWARENESS: 'awareness',
  OUTCOME_ENGAGEMENT: 'engagement', POST_ENGAGEMENT: 'engagement', MESSAGES: 'engagement', VIDEO_VIEWS: 'awareness',
};
// First type present wins: these overlap, so adding them would double count.
const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const PURCHASE_ACTIONS = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const pickAction = (list, types) => { for (const t of types) { const a = (list || []).find((x) => x.action_type === t); if (a) return +a.value || 0; } return 0; };

const meta = {
  async pull(acc, cfg, from, to) {
    const id = actId(acc);
    const camps = await metaList(cfg, graph(`${id}/campaigns?fields=id,name,status,daily_budget,objective&limit=200`));
    const range = encodeURIComponent(JSON.stringify({ since: ymd(from), until: ymd(to) }));
    const rows = await metaList(cfg, graph(`${id}/insights?level=campaign&time_increment=1&time_range=${range}&fields=campaign_id,impressions,clicks,spend,actions,action_values&limit=500`));
    return {
      campaigns: camps.map((c) => ({
        externalId: String(c.id), name: c.name, status: M_STATUS[c.status] || 'paused', objective: M_OBJECTIVE[c.objective],
        dailyBudget: c.daily_budget != null ? r2(+c.daily_budget / minor(acc)) : undefined,
      })),
      rows: rows.map((r) => ({
        externalId: String(r.campaign_id), date: r.date_start,
        impressions: +r.impressions || 0, clicks: +r.clicks || 0, spend: r2(+r.spend || 0),
        leads: Math.round(pickAction(r.actions, LEAD_ACTIONS)), conversions: r2(pickAction(r.actions, PURCHASE_ACTIONS)), revenue: r2(pickAction(r.action_values, PURCHASE_ACTIONS)),
      })),
    };
  },
  async setStatus(acc, cfg, c, active) {
    await call(graph(c.externalId), { method: 'POST', headers: metaAuth(cfg), form: { status: active ? 'ACTIVE' : 'PAUSED' } });
  },
  // Only campaigns with a campaign-level budget (Advantage campaign budget); ad-set budgets are refused by Meta.
  async setBudget(acc, cfg, c, amount) {
    await call(graph(c.externalId), { method: 'POST', headers: metaAuth(cfg), form: { daily_budget: String(Math.round(amount * minor(acc))) } });
  },
  async test(acc, cfg) { await call(graph(`${actId(acc)}?fields=name,currency`), { headers: metaAuth(cfg) }); },
};

const NETWORKS = { google, meta };

// ---------- connection settings ----------
async function loadAccount(company, id) {
  const acc = await M.AdAccount.findOne({ _id: id, company }).select('+credentials');
  if (!acc) throw Object.assign(new Error('Ad account not found'), { status: 404 });
  return acc;
}

function connectionView(acc) {
  const cfg = unseal(acc.credentials);
  return {
    platform: acc.platform, supported: SUPPORTED.includes(acc.platform), connected: !!acc.connected,
    autoSync: acc.autoSync, autoPause: acc.autoPause, lastSyncAt: acc.lastSyncAt, lastSyncError: acc.lastSyncError,
    config: maskedConfig(acc.platform, cfg, FIELDS), fields: FIELDS[acc.platform] || [],
    serverDefaults: acc.platform === 'google' && {
      developerToken: !!config.googleAds.developerToken, oauthClient: !!(config.googleAds.clientId && config.googleAds.clientSecret),
      signIn: !!(config.googleAds.clientId && config.googleAds.clientSecret && config.publicUrl),
    },
  };
}

async function saveConnection(acc, { config: incoming, autoSync, autoPause } = {}) {
  if (!SUPPORTED.includes(acc.platform)) throw Object.assign(new Error(`API sync is available for ${SUPPORTED.join(' and ')} accounts`), { status: 400 });
  if (incoming) {
    const cfg = mergeConfig(acc.platform, unseal(acc.credentials), incoming, FIELDS);
    acc.credentials = seal(cfg);
    acc.connected = true;
    await NETWORKS[acc.platform].test(acc, cfg).then(() => { acc.lastSyncError = undefined; }, (e) => { acc.lastSyncError = e.message; });
  }
  if (autoSync != null) acc.autoSync = !!autoSync;
  if (autoPause != null) acc.autoPause = !!autoPause;
  await acc.save();
  return acc;
}

// Stores a refresh token from the Google sign-in flow (routes/oauth.js); the server OAuth client is used from then on.
async function storeGoogleToken(company, id, refreshToken) {
  const acc = await loadAccount(company, id);
  const { clientId, clientSecret, ...cfg } = unseal(acc.credentials);
  acc.credentials = seal({ ...cfg, refreshToken });
  acc.connected = true;
  acc.lastSyncError = undefined;
  await acc.save();
  return acc;
}

function disconnect(acc) {
  acc.credentials = undefined;
  acc.connected = false;
  acc.lastSyncError = undefined;
  return acc.save();
}

// ---------- pull ----------
async function syncAccount(acc, { days = SYNC_DAYS } = {}) {
  const net = NETWORKS[acc.platform];
  if (!net || !acc.connected) throw Object.assign(new Error('This account is not connected to its ad network'), { status: 400 });
  if (acc.credentials === undefined) acc = await loadAccount(acc.company, acc._id);
  const cfg = unseal(acc.credentials);
  const to = day(new Date());
  const from = new Date(to.getTime() - (days - 1) * 864e5);
  try {
    const { campaigns, rows } = await net.pull(acc, cfg, from, to);
    const { touched, ...result } = await save(acc, campaigns, rows);
    acc.lastSyncAt = new Date();
    acc.lastSyncError = undefined;
    await acc.save();
    result.autoPaused = await afterNewData(acc.company, touched);
    return result;
  } catch (e) {
    const firstFailure = !acc.lastSyncError; // alert once, not every 3 hours while it stays broken
    acc.lastSyncAt = new Date(); // failed accounts wait for the next window instead of retrying every minute
    acc.lastSyncError = e.message.slice(0, 500);
    await acc.save();
    if (firstFailure) await emit(acc.company, 'ad.sync_failed', { kind: 'AdAccount', id: acc._id }, { error: acc.lastSyncError, platform: acc.platform });
    throw Object.assign(e, { status: e.status || 424 });
  }
}

async function save(acc, campaigns, rows) {
  const company = acc.company;
  const local = await M.AdCampaign.find({ company, account: acc._id, externalId: { $in: campaigns.map((c) => c.externalId) } });
  const byExt = new Map(local.map((c) => [c.externalId, c]));
  let updated = 0;
  const created = [];
  for (const x of campaigns) {
    let c = byExt.get(x.externalId);
    if (!c) {
      if (x.status === 'ended') continue; // removed before we ever saw it
      c = new M.AdCampaign({ company, account: acc._id, externalId: x.externalId, name: x.name, objective: x.objective || 'leads', utm: { source: acc.platform, medium: 'cpc', campaign: trackingCode(x.name) } });
      created.push(c);
    } else updated++;
    c.name = x.name;
    if (x.budgetId) c.externalBudgetId = x.budgetId;
    if (x.dailyBudget != null) c.dailyBudget = x.dailyBudget;
    // A campaign waiting for approval in the CRM is paused on the network; keep it waiting.
    if (!(c.status === 'pending_approval' && x.status === 'paused')) c.status = x.status;
    if (c.status === 'active' && !c.startDate) c.startDate = day(new Date());
    c.syncError = undefined;
    byExt.set(x.externalId, c);
    await c.save();
  }
  let saved = 0;
  const touched = new Set();
  for (const r of rows) {
    const c = byExt.get(r.externalId);
    if (!c) continue;
    const { externalId, date, conversions, ...vals } = r;
    // Google has no lead metric: on lead campaigns its conversions are the leads.
    if (vals.leads === undefined) vals.leads = c.objective === 'leads' ? Math.round(conversions) : 0;
    await M.AdMetric.updateOne({ company, campaign: c._id, creative: null, date: day(date) }, { $set: { ...vals, conversions } }, { upsert: true });
    touched.add(String(c._id));
    saved++;
  }
  for (const c of created) await emit(company, 'ad.campaign_imported', ref(c), { platform: acc.platform, externalId: c.externalId });
  return { campaignsCreated: created.length, campaignsUpdated: updated, metricRows: saved, touched: [...touched] };
}

// Last 7 days (plus today and lifetime) of one campaign: the payload of ad.performance_updated,
// so workflow conditions can use payload.cpl, payload.roas, payload.today.spend, payload.budgetUsedPct, ...
async function campaignStats(c) {
  const today = day(new Date());
  const from = new Date(today.getTime() - 6 * 864e5);
  const match = { company: c.company, campaign: c._id };
  const [week, now, life] = await Promise.all([
    M.AdMetric.aggregate([{ $match: { ...match, date: { $gte: from } } }, { $group: { _id: null, ...SUMS } }]),
    M.AdMetric.aggregate([{ $match: { ...match, date: today } }, { $group: { _id: null, ...SUMS } }]),
    M.AdMetric.aggregate([{ $match: match }, { $group: { _id: null, spend: { $sum: '$spend' } } }]),
  ]);
  const lifetimeSpend = r2(life[0]?.spend || 0);
  return {
    days: 7, ...kpis(week[0]), today: kpis(now[0]), lifetimeSpend,
    budgetUsedPct: c.totalBudget ? r2(div(lifetimeSpend, c.totalBudget) * 100) : null,
  };
}

// Runs after new numbers land (API sync, manual entry, CSV import): budget cap, the no-leads rule
// (auto-pause when the account opted in) and the workflow triggers. Returns how many campaigns were auto-paused.
async function afterNewData(company, campaignIds) {
  if (!campaignIds.length) return 0;
  const from = new Date(day(new Date()).getTime() - 13 * 864e5);
  const rows = await M.AdMetric.aggregate([{ $match: { company, date: { $gte: from } } }, { $group: { _id: '$campaign', spend: { $sum: '$spend' }, leads: { $sum: '$leads' } } }]);
  const tot = rows.reduce((a, r) => ({ spend: a.spend + r.spend, leads: a.leads + r.leads }), { spend: 0, leads: 0 });
  const avgCpl = tot.leads ? tot.spend / tot.leads : 0;
  const by = new Map(rows.map((r) => [String(r._id), r]));
  const reload = (id) => M.AdCampaign.findOne({ _id: id, company });
  let paused = 0;
  for (const id of campaignIds) {
    await enforceBudget(company, id);
    let c = await reload(id);
    if (!c) continue;
    const m = by.get(String(id));
    if (m && c.status === 'active' && c.objective === 'leads' && wastingSpend(m, avgCpl)) {
      const since = new Date(Date.now() - 864e5);
      if (!(await M.Activity.exists({ company, 'entity.id': c._id, type: 'ad.no_leads', createdAt: { $gte: since } }))) {
        await logActivity(company, ref(c), 'ad.no_leads', `Spent ${r2(m.spend)} in 14 days with no leads`);
        await emit(company, 'ad.no_leads', ref(c), { spend: r2(m.spend), leads: 0, days: 14, accountAvgCpl: r2(avgCpl) });
      }
      const acc = await M.AdAccount.findById(c.account).select('autoPause');
      c = await reload(id); // a workflow may already have acted on it
      if (acc?.autoPause && c.status === 'active' && (await pauseFor(c, 'Auto-paused: spending with no leads', `${c.name} spent ${r2(m.spend)} in 14 days with no leads`))) paused++;
    }
    c = await reload(id);
    await emit(company, 'ad.performance_updated', ref(c), await campaignStats(c));
  }
  return paused;
}

// ---------- push ----------
// Sends a CRM change to the network before it is saved, so the CRM never shows "paused" while the network keeps spending.
async function push(c, { status, dailyBudget } = {}) {
  if (!c.externalId) return;
  const acc = await M.AdAccount.findOne({ _id: c.account, company: c.company }).select('+credentials');
  const net = acc?.connected && NETWORKS[acc.platform];
  if (!net) return;
  const cfg = unseal(acc.credentials);
  try {
    if (status) await net.setStatus(acc, cfg, c, status === 'active');
    if (dailyBudget != null) await net.setBudget(acc, cfg, c, dailyBudget);
    c.syncError = undefined;
  } catch (e) {
    throw Object.assign(new Error(`${acc.platform === 'google' ? 'Google Ads' : 'Meta'} refused the change: ${e.message}`), { status: 424 });
  }
}

// Status change on a campaign: network first, then the CRM, the activity log and the ad.status_changed trigger.
// "ended" pauses on the network; nothing is ever deleted there.
async function changeStatus(c, to, { note, by } = {}) {
  const from = c.status;
  if (to === 'active' || to === 'paused' || to === 'ended') await push(c, { status: to === 'active' ? 'active' : 'paused' });
  c.status = to;
  if (note) c.approvalNote = note;
  if (to === 'active' && !c.startDate) c.startDate = day(new Date());
  await c.save();
  await logActivity(c.company, ref(c), `ad.${to}`, note || `Campaign "${c.name}" is now ${to}`, null, by);
  if (from !== to) await emit(c.company, 'ad.status_changed', ref(c), { from, to, reason: note });
  return c;
}

async function changeBudget(c, dailyBudget) {
  if (dailyBudget === c.dailyBudget) return c;
  await push(c, { dailyBudget });
  c.dailyBudget = dailyBudget;
  await c.save();
  return c;
}

// Auto-pause when the lifetime budget is used up.
async function enforceBudget(company, campaignId) {
  const c = await M.AdCampaign.findOne({ _id: campaignId, company });
  if (!c || c.status !== 'active' || !c.totalBudget) return;
  const [t] = await M.AdMetric.aggregate([{ $match: { company: c.company, campaign: c._id } }, { $group: { _id: null, spend: { $sum: '$spend' } } }]);
  if ((t?.spend || 0) < c.totalBudget) return;
  await emit(company, 'ad.budget_exhausted', ref(c), { spend: r2(t.spend), totalBudget: c.totalBudget });
  await pauseFor(c, 'Auto-paused: total budget used', `${c.name} reached its total budget`);
}

async function pauseFor(c, note, message) {
  try { await changeStatus(c, 'paused', { note }); } catch (e) {
    c.syncError = e.message;
    await c.save();
    await notifyApprovers(c.company, 'Could not pause campaign on the ad network', `${c.name}: ${e.message}`, c._id);
    return false;
  }
  if (c.owner) await notify(c.company, c.owner, 'Campaign auto-paused', message, { kind: 'AdCampaign', id: c._id });
  else await notifyApprovers(c.company, 'Campaign auto-paused', message, c._id);
  return true;
}

// ---------- scheduler ----------
async function processDue() {
  const due = await M.AdAccount.find({
    connected: true, autoSync: true, status: 'active', platform: { $in: SUPPORTED },
    $or: [{ lastSyncAt: null }, { lastSyncAt: { $lt: new Date(Date.now() - SYNC_EVERY_MS) } }],
  }).select('+credentials').limit(20);
  for (const acc of due) {
    const co = await tenants.getCompany(acc.company);
    if (accessProblem(co) || !hasModule(co, 'ads')) continue;
    try { await syncAccount(acc); } catch (e) { console.error(`[adsync ${acc._id}]`, e.message); }
  }
}

module.exports = {
  FIELDS, SUPPORTED, trackingCode, wastingSpend, notifyApprovers, approvalLimit, kpis, SUMS, push, changeStatus, changeBudget,
  afterNewData, campaignStats, loadAccount, connectionView, saveConnection, storeGoogleToken, disconnect, syncAccount, processDue,
};
