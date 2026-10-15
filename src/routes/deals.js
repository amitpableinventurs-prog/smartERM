const { Deal, Pipeline, Lead, Customer } = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');
const { logActivity, emit } = require('../services/events');
const { ownerDefault } = require('./shared');

const ref = (d) => ({ kind: 'Deal', id: d._id });

const c = crud({
  Model: Deal,
  resource: 'deals',
  search: ['title'],
  filters: ['status', 'stage', 'pipeline', 'assignedTo'],
  populate: [{ path: 'assignedTo', select: 'name' }, { path: 'lead', select: 'name' }, { path: 'customer', select: 'name' }],
  hooks: {
    async beforeCreate(req, data) {
      ownerDefault(req, data);
      const pipeline = data.pipeline
        ? await Pipeline.findOne({ _id: data.pipeline, company: req.companyId })
        : await Pipeline.findOne({ company: req.companyId, isDefault: true });
      if (data.pipeline && !pipeline) throw new HttpError(404, 'Pipeline not found');
      if (pipeline) {
        data.pipeline = pipeline._id;
        data.stage ||= pipeline.stages[0];
        if (!pipeline.stages.includes(data.stage)) throw new HttpError(400, `Stage must be one of: ${pipeline.stages.join(', ')}`);
      }
      delete data.status; // status only changes via /win and /lose
      delete data.payments;
    },
    async afterCreate(req, deal) {
      await logActivity(req.companyId, ref(deal), 'deal.created', `Deal "${deal.title}" created`, null, req.user._id);
      emit(req.companyId, 'deal.created', ref(deal));
    },
    async beforeUpdate(req, deal, data) {
      if (req.user.role === 'sales') delete data.assignedTo;
      delete data.status; delete data.payments; delete data.closedAt;
      if (deal.status !== 'open') throw new HttpError(409, 'Closed deals cannot be edited');
      if (data.stage && deal.pipeline) {
        const p = await Pipeline.findById(deal.pipeline);
        if (p && !p.stages.includes(data.stage)) throw new HttpError(400, `Stage must be one of: ${p.stages.join(', ')}`);
      }
    },
    async afterUpdate(req, deal, before) {
      if (deal.stage !== before.stage) {
        await logActivity(req.companyId, ref(deal), 'deal.stage_changed', `${before.stage} → ${deal.stage}`, null, req.user._id);
        emit(req.companyId, 'deal.stage_changed', ref(deal), { from: before.stage, to: deal.stage });
      }
    },
  },
});

async function close(req, res, status) {
  const deal = await c.find(req);
  if (deal.status !== 'open') throw new HttpError(409, `Deal already ${deal.status}`);
  deal.status = status;
  deal.closedAt = new Date();
  deal.probability = status === 'won' ? 100 : 0;
  await deal.save();
  if (status === 'won') {
    if (deal.customer) await Customer.updateOne({ _id: deal.customer }, { $push: { purchases: { item: deal.title, amount: deal.value } }, lastActivityAt: new Date() });
    if (deal.lead) await Lead.updateOne({ _id: deal.lead }, { status: 'won' });
  } else if (deal.lead) await Lead.updateOne({ _id: deal.lead }, { status: 'lost', lostReason: req.body.reason });
  await logActivity(req.companyId, ref(deal), `deal.${status}`, req.body.reason || `Deal ${status}`, null, req.user._id);
  res.json(deal);
}

c.router.post('/:id/win', authorize('deals', 'u'), (req, res) => close(req, res, 'won'));
c.router.post('/:id/lose', authorize('deals', 'u'), (req, res) => close(req, res, 'lost'));

c.router.post('/:id/payments', authorize('deals', 'u'), async (req, res) => {
  const deal = await c.find(req);
  const amount = +req.body.amount;
  if (!(amount > 0)) throw new HttpError(400, 'amount must be a positive number');
  deal.payments.push({ amount, method: req.body.method });
  await deal.save();
  await logActivity(req.companyId, ref(deal), 'payment.received', `Payment of ${amount} received`, null, req.user._id);
  emit(req.companyId, 'payment.received', ref(deal), { amount });
  res.status(201).json(deal.payments.at(-1));
});

// Kanban board: open deals grouped by stage.
c.router.get('/board/:pipelineId', authorize('deals', 'r'), async (req, res) => {
  const pipeline = await Pipeline.findOne({ _id: req.params.pipelineId, company: req.companyId });
  if (!pipeline) throw new HttpError(404, 'Pipeline not found');
  const deals = await Deal.find({ ...c.base(req), pipeline: pipeline._id, status: 'open' }).sort('-value');
  res.json(pipeline.stages.map((stage) => {
    const items = deals.filter((d) => d.stage === stage);
    return { stage, count: items.length, value: items.reduce((s, d) => s + d.value, 0), deals: items };
  }));
});

module.exports = c.finish();
