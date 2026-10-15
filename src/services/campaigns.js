const M = require('../models');
const { send, addressFor } = require('./communication');
const { render, addDays } = require('../utils/helpers');

const MAX_AUDIENCE = 5000;

// Audience filters come from API users, so only plain field matches are allowed (no $where etc.).
function safeFilter(filter = {}) {
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$') || k === 'company') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = Object.fromEntries(Object.entries(v).filter(([op]) => ['$gte', '$lte', '$gt', '$lt', '$in', '$ne'].includes(op)));
      if (Object.keys(ops).length) out[k] = ops;
    } else out[k] = v;
  }
  return out;
}

async function launch(campaign) {
  const Model = M[campaign.audience.model];
  const people = await Model.find({ company: campaign.company, ...safeFilter(campaign.audience.filter) }).select('_id').limit(MAX_AUDIENCE);
  const first = campaign.steps[0]?.delayDays || 0;
  await M.CampaignEnrollment.insertMany(
    people.map((p) => ({ company: campaign.company, campaign: campaign._id, recipient: { kind: campaign.audience.model, id: p._id }, nextAt: addDays(new Date(), first) }))
  );
  campaign.status = 'running';
  campaign.launchedAt = new Date();
  campaign.stats = { ...campaign.stats, enrolled: people.length };
  await campaign.save();
  await processDue();
  return campaign;
}

async function processDue() {
  const due = await M.CampaignEnrollment.find({ done: false, nextAt: { $lte: new Date() } }).limit(500);
  const touched = new Set();
  for (const en of due) {
    const claimed = await M.CampaignEnrollment.findOneAndUpdate({ _id: en._id, done: false, nextAt: en.nextAt }, { nextAt: new Date(Date.now() + 3600e3) });
    if (!claimed) continue;
    const campaign = await M.Campaign.findById(en.campaign);
    if (!campaign || campaign.status !== 'running') { await M.CampaignEnrollment.updateOne({ _id: en._id }, { nextAt: en.nextAt }); continue; }
    touched.add(String(campaign._id));
    const step = campaign.steps[en.step];
    const person = await M[en.recipient.kind].findById(en.recipient.id);
    let key = 'sent';
    try {
      if (!person || !step) throw new Error('missing recipient or step');
      const ctx = { person, lead: person, customer: person };
      await send({
        company: campaign.company, channel: campaign.channel, to: addressFor(campaign.channel, person),
        subject: render(step.subject, ctx), body: render(step.body, ctx),
        relatedTo: { kind: en.recipient.kind, id: person._id }, campaign: campaign._id,
      });
    } catch { key = 'failed'; }
    await M.Campaign.updateOne({ _id: campaign._id }, { $inc: { [`stats.${key}`]: 1 } });
    const next = en.step + 1;
    if (next < campaign.steps.length) await M.CampaignEnrollment.updateOne({ _id: en._id }, { step: next, nextAt: addDays(new Date(), campaign.steps[next].delayDays || 0) });
    else await M.CampaignEnrollment.updateOne({ _id: en._id }, { done: true });
  }
  for (const id of touched) {
    if (!(await M.CampaignEnrollment.exists({ campaign: id, done: false }))) await M.Campaign.updateOne({ _id: id, status: 'running' }, { status: 'completed' });
  }
  return due.length;
}

module.exports = { launch, processDue, safeFilter };
