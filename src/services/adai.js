/**
 * AI for advertising.
 *
 *   review     - the LLM reads a campaign's last 7 days against the account average and picks one action:
 *                keep, pause, resume or a daily-budget change (capped at ±maxChangePct and the approval limit)
 *   recommend  - review + store the suggestion as an AdRecommendation and notify managers; nothing reaches
 *                the ad network until a manager approves it (decide)
 *   insights   - plain-language account review on top of the rule-based Ad Insights
 *   adCopy     - headline / text / CTA variants for A/B tests
 *
 * Without an LLM key (or when it fails) the same rules as Ad Insights answer, so every flow keeps working.
 */
const M = require('../models');
const ai = require('./ai');
const adsync = require('./adsync');
const { logActivity } = require('./events');

const r2 = (n) => Math.round(n * 100) / 100;
const day = (d) => { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); };
const ref = (c) => ({ kind: 'AdCampaign', id: c._id });
const err = (status, message) => Object.assign(new Error(message), { status });

const ACTIONS = ['keep', 'pause', 'resume', 'budget'];
const KPI_KEYS = ['impressions', 'clicks', 'spend', 'leads', 'conversions', 'revenue', 'ctr', 'cpc', 'cpl', 'cpa', 'roas'];
const pick = (o = {}, keys = KPI_KEYS) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

// 14-day totals of the whole company, the yardstick a campaign is judged against.
async function accountAverages(company) {
  const from = new Date(day(new Date()).getTime() - 13 * 864e5);
  const [t] = await M.AdMetric.aggregate([{ $match: { company, date: { $gte: from } } }, { $group: { _id: null, ...adsync.SUMS } }]);
  return pick(adsync.kpis(t), ['spend', 'leads', 'ctr', 'cpl', 'cpa', 'roas']);
}

// Same thresholds as the Ad Insights page.
function heuristicReview(c, s, avg) {
  if (c.status !== 'active') return { action: 'keep', reason: `Campaign is ${c.status}.`, confidence: 0.5 };
  if (c.objective === 'leads' && adsync.wastingSpend(s, avg.cpl)) return { action: 'pause', reason: `Spent ${s.spend} in 7 days with no leads.`, confidence: 0.8 };
  if (avg.cpl && s.leads >= 3 && s.cpl > avg.cpl * 1.5) return { action: 'budget', changePct: -30, reason: `Cost per lead ${s.cpl} is ${r2(s.cpl / avg.cpl)}x the account average of ${avg.cpl}.`, confidence: 0.7 };
  if (s.roas >= 3 && s.spend > 0) return { action: 'budget', changePct: 20, reason: `Return on ad spend is ${s.roas}x over 7 days.`, confidence: 0.7 };
  return { action: 'keep', reason: 'Results are within the normal range.', confidence: 0.6 };
}

async function review(c, { maxChangePct = 30 } = {}) {
  const max = Math.min(100, Math.max(5, +maxChangePct || 30));
  const [stats, avg, limit] = await Promise.all([adsync.campaignStats(c), accountAverages(c.company), adsync.approvalLimit(c.company)]);
  const week = pick(stats);
  const facts = {
    campaign: { name: c.name, objective: c.objective, status: c.status, dailyBudget: c.dailyBudget, totalBudget: c.totalBudget || null },
    last7Days: week, today: pick(stats.today), lifetimeSpend: stats.lifetimeSpend, budgetUsedPct: stats.budgetUsedPct,
    accountAverage14Days: avg, dailyBudgetApprovalLimit: limit, currency: 'INR',
  };
  const r = await ai.ask(
    'You manage paid ad campaigns (Google Ads, Meta) for an Indian business and protect its money. From the numbers, choose ONE action: ' +
      '"keep"; "pause" (only an active campaign that is clearly wasting money: spend with no leads or sales, or cost per result far above the account average); ' +
      `"resume" (only a paused campaign whose numbers were good); or "budget" with changePct between -${max} and ${max} (scale a clear winner, trim an expensive one). ` +
      'Prefer "keep" when data is thin (under about 1000 impressions or 3 days of spend) or results are close to the account average. ' +
      'Return JSON {"action":"keep|pause|resume|budget","changePct":0,"reason":"one or two plain sentences quoting the numbers","confidence":0-1}.',
    JSON.stringify(facts),
    async () => heuristicReview(c, week, avg),
    { json: true }
  );
  let action = ACTIONS.includes(r.action) ? r.action : 'keep';
  let reason = String(r.reason || '').slice(0, 600) || 'No reason given.';
  if ((action === 'pause' && c.status !== 'active') || (action === 'resume' && c.status !== 'paused')) action = 'keep';
  let dailyBudget;
  const changePct = Math.max(-max, Math.min(max, Math.round(+r.changePct || 0)));
  if (action === 'budget') {
    dailyBudget = Math.round(c.dailyBudget * (1 + changePct / 100));
    if (dailyBudget > c.dailyBudget && dailyBudget > limit) dailyBudget = Math.max(c.dailyBudget, limit); // never past the approval limit
    if (!c.dailyBudget || !changePct || dailyBudget === c.dailyBudget) { action = 'keep'; dailyBudget = undefined; if (!c.dailyBudget) reason += ' (No daily budget set in the CRM, so no change was proposed.)'; }
  }
  const confidence = Math.max(0, Math.min(1, +r.confidence || 0));
  return { action, changePct: action === 'budget' ? changePct : 0, dailyBudget, reason, confidence, engine: r.engine, note: r.note, stats: { ...week, accountCpl: avg.cpl, accountRoas: avg.roas } };
}

const label = (r) => (r.action === 'pause' ? 'Pause' : r.action === 'resume' ? 'Resume' : r.action === 'budget' ? `Daily budget ${r.currentBudget} → ${r.dailyBudget}` : 'Keep');

// Review a campaign and, when the AI wants a change, store it for approval. Returns { skipped } | { action: 'keep', ... } | AdRecommendation.
async function recommend(c, { maxChangePct, everyHours = 24, source = 'workflow' } = {}) {
  if (await M.AdRecommendation.exists({ company: c.company, campaign: c._id, status: 'pending' })) return { skipped: 'a suggestion is already waiting for approval' };
  if (everyHours && c.aiReviewedAt && Date.now() - c.aiReviewedAt < everyHours * 36e5) return { skipped: `reviewed less than ${everyHours}h ago` };
  const r = await review(c, { maxChangePct });
  await M.AdCampaign.updateOne({ _id: c._id }, { aiReviewedAt: new Date() });
  if (r.action === 'keep') {
    await logActivity(c.company, ref(c), 'ad.ai_review', `AI: keep. ${r.reason}`);
    return r;
  }
  const rec = await M.AdRecommendation.create({
    company: c.company, campaign: c._id, action: r.action, currentBudget: c.dailyBudget, dailyBudget: r.dailyBudget,
    reason: r.reason, confidence: r.confidence, engine: r.engine, source, stats: r.stats,
  });
  await logActivity(c.company, ref(c), 'ad.ai_recommendation', `AI suggests: ${label(rec)}. ${r.reason}`);
  await adsync.notifyApprovers(c.company, `AI suggests: ${label(rec)}`, `${c.name}: ${r.reason}`, c._id);
  return rec;
}

// A manager approves (the change goes to the ad network) or rejects a suggestion.
async function decide(rec, user, approve) {
  if (rec.status !== 'pending') throw err(409, `This suggestion is already ${rec.status}`);
  Object.assign(rec, { decidedBy: user._id, decidedAt: new Date() });
  const c = await M.AdCampaign.findOne({ _id: rec.campaign, company: rec.company });
  if (!approve || !c) {
    rec.status = c ? 'rejected' : 'expired';
    if (!c) rec.error = 'Campaign no longer exists';
    await rec.save();
    if (c) await logActivity(c.company, ref(c), 'ad.ai_rejected', `${user.name} rejected AI suggestion: ${label(rec)}`, null, user._id);
    return rec;
  }
  const note = `AI suggestion approved by ${user.name}: ${rec.reason}`;
  try {
    if (rec.action === 'pause' || rec.action === 'resume') {
      const [from, to] = rec.action === 'pause' ? ['active', 'paused'] : ['paused', 'active'];
      if (c.status !== from) throw new Error(`Campaign is ${c.status} now, not ${from}`);
      await adsync.changeStatus(c, to, { note, by: user._id });
    } else {
      await adsync.changeBudget(c, rec.dailyBudget);
      await logActivity(c.company, ref(c), 'ad.budget', `Daily budget ${rec.currentBudget} -> ${rec.dailyBudget}. ${note}`, null, user._id);
    }
    rec.status = 'applied';
  } catch (e) {
    rec.status = 'failed';
    rec.error = e.message.slice(0, 300);
  }
  await rec.save();
  return rec;
}

// Plain-language review of the whole ad account. `facts` = per-campaign numbers + account average + rule findings.
async function insights(facts) {
  const r = await ai.ask(
    'You are a senior performance marketer reviewing a business\'s paid ads for its owner. Use only the numbers given (currency INR) and simple English. ' +
      'Return JSON {"summary":"2-3 sentences on overall health","priorities":[{"campaign":"exact campaign name, or All campaigns","title":"short","detail":"what to do and why, quoting numbers","impact":"high|medium|low"}]} ' +
      'with at most 6 priorities, most important first. Include creative or targeting ideas where CTR or cost per lead is weak.',
    JSON.stringify(facts),
    async () => ({
      summary: `${facts.campaigns.length} campaigns reviewed. Account cost per lead ${facts.accountAverage.cpl}, CTR ${facts.accountAverage.ctr}%, ROAS ${facts.accountAverage.roas}x over 14 days.`,
      priorities: facts.ruleFindings.slice(0, 6).map((f) => ({ campaign: f.campaign, title: f.title, detail: f.detail, impact: f.severity === 'high' ? 'high' : f.severity === 'good' ? 'medium' : 'low' })),
    }),
    { json: true }
  );
  const priorities = (Array.isArray(r.priorities) ? r.priorities : []).slice(0, 6).map((p) => ({
    campaign: String(p.campaign || '').slice(0, 120), title: String(p.title || '').slice(0, 160), detail: String(p.detail || '').slice(0, 800),
    impact: ['high', 'medium', 'low'].includes(p.impact) ? p.impact : 'medium',
  }));
  return { summary: String(r.summary || '').slice(0, 1200), priorities, engine: r.engine, note: r.note };
}

const CTAS = ['Learn More', 'Sign Up', 'Get Quote', 'Book Now', 'Contact Us', 'Shop Now', 'Apply Now', 'Call Now', 'Send WhatsApp Message'];

async function adCopy({ product, audience = '', offer = '', language = 'English', tone = 'friendly', platform = 'meta', count = 3 }) {
  const n = Math.min(6, Math.max(1, +count || 3));
  const r = await ai.ask(
    `You write high-converting ${platform === 'google' ? 'Google search' : 'Facebook/Instagram'} ad copy for Indian businesses. ` +
      `Write ${n} clearly different variants for an A/B test (angles such as benefit, offer/urgency, social proof, problem/solution). Language: ${language}. Tone: ${tone}. ` +
      `Headline at most 40 characters, primary text at most 125 characters, CTA exactly one of: ${CTAS.join(', ')}. ` +
      'Never invent prices, discounts, guarantees or claims that are not in the brief. Return JSON {"variants":[{"angle":"...","headline":"...","body":"...","cta":"..."}]}.',
    `Product/service: ${product}\nTarget audience: ${audience || '(not given)'}\nOffer: ${offer || '(none)'}`,
    async () => ({
      variants: [
        { angle: 'benefit', headline: String(product).slice(0, 40), body: `${product}${audience ? ` for ${audience}` : ''}. ${offer || 'Talk to our team today.'}`.slice(0, 125), cta: 'Learn More' },
        { angle: 'offer', headline: (offer || `Get ${product}`).slice(0, 40), body: `Looking for ${product}? ${offer || 'Get a free quote in minutes.'}`.slice(0, 125), cta: 'Get Quote' },
        { angle: 'action', headline: `Book your ${product}`.slice(0, 40), body: `Limited slots this week. Message us to book ${product}.`.slice(0, 125), cta: 'Book Now' },
      ].slice(0, n),
    }),
    { json: true }
  );
  const variants = (Array.isArray(r.variants) ? r.variants : []).slice(0, n).map((v) => ({
    angle: String(v.angle || '').slice(0, 40), headline: String(v.headline || '').slice(0, 80), body: String(v.body || '').slice(0, 500),
    cta: CTAS.find((x) => x.toLowerCase() === String(v.cta || '').toLowerCase()) || 'Learn More',
  })).filter((v) => v.headline && v.body);
  if (!variants.length) throw err(502, 'The AI did not return any ad copy; try again');
  return { variants, engine: r.engine, note: r.note };
}

module.exports = { review, recommend, decide, insights, adCopy, label, heuristicReview, CTAS };
