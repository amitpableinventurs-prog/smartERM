const { Customer, Communication } = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { logActivity } = require('../services/events');
const ai = require('../services/ai');
const { timeline, ownerDefault, need } = require('./shared');

const c = crud({
  Model: Customer,
  resource: 'customers',
  search: ['name', 'email', 'phone', 'organization'],
  filters: ['lifecycle', 'assignedTo', 'tags'],
  populate: { path: 'assignedTo', select: 'name email' },
  hooks: {
    beforeCreate: (req, data) => ownerDefault(req, data),
    beforeUpdate(req, doc, data) {
      if (req.user.role === 'sales') delete data.assignedTo;
    },
    async afterUpdate(req, cust, before) {
      if (cust.lifecycle !== before.lifecycle) {
        await logActivity(req.companyId, { kind: 'Customer', id: cust._id }, 'lifecycle', `${before.lifecycle} → ${cust.lifecycle}`, null, req.user._id);
      }
    },
  },
});

c.router.post('/:id/purchases', authorize('customers', 'u'), async (req, res) => {
  const cust = await c.find(req);
  cust.purchases.push({ item: need(req.body.item, 'item is required'), amount: +req.body.amount || 0 });
  cust.lastActivityAt = new Date();
  await cust.save();
  await logActivity(req.companyId, { kind: 'Customer', id: cust._id }, 'purchase', `${req.body.item} (${+req.body.amount || 0})`, null, req.user._id);
  res.status(201).json(cust.purchases.at(-1));
});

c.router.post('/:id/documents', authorize('customers', 'u'), async (req, res) => {
  const cust = await c.find(req);
  cust.documents.push({ name: need(req.body.name, 'name is required'), url: need(req.body.url, 'url is required') });
  await cust.save();
  res.status(201).json(cust.documents.at(-1));
});

c.router.get('/:id/timeline', authorize('customers', 'r'), async (req, res) => {
  const cust = await c.find(req);
  res.json(await timeline(req.companyId, 'Customer', cust._id));
});

c.router.get('/:id/churn', authorize('customers', 'r'), async (req, res) => {
  const cust = await c.find(req);
  const days = Math.floor((Date.now() - cust.lastActivityAt) / 864e5);
  const neg = await Communication.countDocuments({ company: req.companyId, 'relatedTo.id': cust._id, sentiment: 'negative' });
  const r = ai.churnRisk(cust, days, neg);
  cust.churnRisk = r.risk;
  await cust.save();
  res.json({ ...r, daysInactive: days, negativeMessages: neg });
});

module.exports = c.finish();
