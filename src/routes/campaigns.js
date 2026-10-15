const { Campaign, CampaignEnrollment, Deal, Lead, Customer, Communication } = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');
const campaigns = require('../services/campaigns');

const c = crud({
  Model: Campaign,
  resource: 'campaigns',
  search: ['name'],
  filters: ['status', 'channel'],
  scope: false,
  hooks: {
    beforeCreate(req, data) {
      delete data.status; delete data.stats; delete data.launchedAt;
      if (!data.steps?.length) throw new HttpError(400, 'At least one step is required');
      if (data.audience?.filter) data.audience.filter = campaigns.safeFilter(data.audience.filter);
    },
    beforeUpdate(req, doc, data) {
      delete data.status; delete data.stats; delete data.launchedAt;
      if (doc.status !== 'draft') throw new HttpError(409, 'Only draft campaigns can be edited');
      if (data.audience?.filter) data.audience.filter = campaigns.safeFilter(data.audience.filter);
    },
  },
});

c.router.post('/preview-audience', authorize('campaigns', 'r'), async (req, res) => {
  const model = req.body.model === 'Customer' ? Customer : Lead;
  const filter = { company: req.companyId, ...campaigns.safeFilter(req.body.filter) };
  res.json({ count: await model.countDocuments(filter), sample: await model.find(filter).select('name email phone').limit(5) });
});

c.router.post('/:id/launch', authorize('campaigns', 'u'), async (req, res) => {
  const camp = await c.find(req);
  if (camp.status !== 'draft' && camp.status !== 'paused') throw new HttpError(409, `Campaign is ${camp.status}`);
  if (camp.status === 'paused') { camp.status = 'running'; await camp.save(); return res.json(camp); }
  res.json(await campaigns.launch(camp));
});

c.router.post('/:id/pause', authorize('campaigns', 'u'), async (req, res) => {
  const camp = await c.find(req);
  if (camp.status !== 'running') throw new HttpError(409, 'Campaign is not running');
  camp.status = 'paused';
  await camp.save();
  res.json(camp);
});

// Campaign analytics: delivery stats, replies and ROI from won deals attributed to recipients.
c.router.get('/:id/analytics', authorize('campaigns', 'r'), async (req, res) => {
  const camp = await c.find(req);
  const recipients = (await CampaignEnrollment.find({ campaign: camp._id }).select('recipient')).map((e) => e.recipient.id);
  const replies = await Communication.countDocuments({ company: req.companyId, direction: 'inbound', 'relatedTo.id': { $in: recipients }, createdAt: { $gte: camp.launchedAt || 0 } });
  const converted = await Lead.countDocuments({ company: req.companyId, _id: { $in: recipients }, status: 'won' });
  const [rev] = await Deal.aggregate([
    { $match: { company: req.companyId, status: 'won', $or: [{ lead: { $in: recipients } }, { customer: { $in: recipients } }] } },
    { $group: { _id: null, revenue: { $sum: '$value' } } },
  ]);
  const revenue = rev?.revenue || 0;
  res.json({
    ...camp.stats, replies, converted, revenue, cost: camp.cost,
    roi: camp.cost > 0 ? Math.round(((revenue - camp.cost) / camp.cost) * 100) : null,
    deliveryRate: camp.stats.enrolled ? Math.round((camp.stats.sent / camp.stats.enrolled) * 100) : 0,
  });
});

module.exports = c.finish();
