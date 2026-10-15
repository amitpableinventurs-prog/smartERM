const { Lead, Customer, Communication, User } = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');
const { logActivity, emit, notify } = require('../services/events');
const ai = require('../services/ai');
const { timeline, ownerDefault, need } = require('./shared');

const dupQuery = (company, d) => {
  const or = [];
  if (d.email) or.push({ email: String(d.email).toLowerCase().trim() });
  if (d.phone) or.push({ phone: String(d.phone).trim() });
  return or.length ? { company, $or: or } : null;
};

async function scoreAndSave(lead) {
  const n = await Communication.countDocuments({ company: lead.company, 'relatedTo.id': lead._id });
  const r = await ai.scoreLead(lead, n);
  lead.score = r.score;
  lead.scoreReason = r.reason;
  await lead.save();
  return r;
}

const c = crud({
  Model: Lead,
  resource: 'leads',
  search: ['name', 'email', 'phone', 'organization'],
  filters: ['status', 'source', 'assignedTo', 'branch', 'tags', 'adCampaign'],
  populate: { path: 'assignedTo', select: 'name email' },
  hooks: {
    async beforeCreate(req, data) {
      ownerDefault(req, data);
      const q = dupQuery(req.companyId, data);
      if (q && req.query.force !== 'true') {
        const dups = await Lead.find(q).select('name email phone status').limit(5);
        if (dups.length) throw new HttpError(409, 'Possible duplicate lead (retry with ?force=true to create anyway)', { duplicates: dups });
      }
      return data;
    },
    async afterCreate(req, lead) {
      await scoreAndSave(lead);
      await logActivity(req.companyId, { kind: 'Lead', id: lead._id }, 'lead.created', `Lead created from ${lead.source}`, null, req.user._id);
      emit(req.companyId, 'lead.created', { kind: 'Lead', id: lead._id });
    },
    beforeUpdate(req, doc, data) {
      if (req.user.role === 'sales') delete data.assignedTo;
      if (data.status && data.status !== 'lost') data.lostReason = undefined;
    },
    async afterUpdate(req, lead, before) {
      if (lead.status !== before.status) {
        await logActivity(req.companyId, { kind: 'Lead', id: lead._id }, 'lead.status_changed', `${before.status} → ${lead.status}`, null, req.user._id);
        emit(req.companyId, 'lead.status_changed', { kind: 'Lead', id: lead._id }, { from: before.status, to: lead.status });
      }
      if (String(lead.assignedTo) !== String(before.assignedTo) && lead.assignedTo) {
        await notify(req.companyId, lead.assignedTo, 'Lead assigned', lead.name, { kind: 'Lead', id: lead._id });
      }
    },
  },
});

c.router.get('/duplicates', authorize('leads', 'r'), async (req, res) => {
  const groups = await Lead.aggregate([
    { $match: { company: req.companyId } },
    { $facet: {
      byEmail: [{ $match: { email: { $nin: [null, ''] } } }, { $group: { _id: '$email', ids: { $push: '$_id' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }],
      byPhone: [{ $match: { phone: { $nin: [null, ''] } } }, { $group: { _id: '$phone', ids: { $push: '$_id' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }],
    } },
  ]);
  res.json(groups[0]);
});

c.router.post('/:id/notes', authorize('leads', 'u'), async (req, res) => {
  const lead = await c.find(req);
  lead.notes.push({ text: need(req.body.text, 'text is required'), by: req.user._id });
  await lead.save();
  await logActivity(req.companyId, { kind: 'Lead', id: lead._id }, 'note', req.body.text, null, req.user._id);
  res.status(201).json(lead.notes.at(-1));
});

c.router.post('/:id/attachments', authorize('leads', 'u'), async (req, res) => {
  const lead = await c.find(req);
  lead.attachments.push({ name: need(req.body.name, 'name is required'), url: need(req.body.url, 'url is required') });
  await lead.save();
  res.status(201).json(lead.attachments.at(-1));
});

c.router.get('/:id/timeline', authorize('leads', 'r'), async (req, res) => {
  const lead = await c.find(req);
  res.json(await timeline(req.companyId, 'Lead', lead._id));
});

c.router.post('/:id/assign', authorize('leads', 'u'), async (req, res) => {
  if (req.user.role === 'sales') throw new HttpError(403, 'Sales users cannot reassign leads');
  const lead = await c.find(req);
  const user = await User.findOne({ _id: need(req.body.userId, 'userId is required'), company: req.companyId, active: true });
  if (!user) throw new HttpError(404, 'User not found');
  lead.assignedTo = user._id;
  await lead.save();
  await notify(req.companyId, user._id, 'Lead assigned', lead.name, { kind: 'Lead', id: lead._id });
  await logActivity(req.companyId, { kind: 'Lead', id: lead._id }, 'lead.assigned', `Assigned to ${user.name}`, null, req.user._id);
  res.json(lead);
});

c.router.post('/:id/score', authorize('leads', 'u'), async (req, res) => {
  const lead = await c.find(req);
  const r = await scoreAndSave(lead);
  res.json({ score: r.score, reason: r.reason, engine: r.engine });
});

c.router.post('/:id/convert', authorize('customers', 'c'), async (req, res) => {
  const lead = await c.find(req);
  if (lead.customer) throw new HttpError(409, 'Lead already converted');
  const customer = await Customer.create({
    company: req.companyId, name: lead.name, email: lead.email, phone: lead.phone, organization: lead.organization,
    assignedTo: lead.assignedTo, tags: lead.tags, customFields: lead.customFields, lifecycle: 'active',
  });
  const from = lead.status;
  lead.customer = customer._id;
  lead.status = 'won';
  await lead.save();
  await logActivity(req.companyId, { kind: 'Lead', id: lead._id }, 'lead.converted', `Converted to customer ${customer._id}`, null, req.user._id);
  if (from !== 'won') emit(req.companyId, 'lead.status_changed', { kind: 'Lead', id: lead._id }, { from, to: 'won' });
  res.status(201).json({ lead, customer });
});

module.exports = c.finish();
