const { Activity, Communication, Task } = require('../models');
const { HttpError } = require('../utils/helpers');

// Merged, newest-first history for any lead/customer/deal.
async function timeline(company, kind, id, limit = 100) {
  const [acts, comms, tasks] = await Promise.all([
    Activity.find({ company, 'entity.id': id }).sort('-createdAt').limit(limit).lean(),
    Communication.find({ company, 'relatedTo.id': id }).sort('-createdAt').limit(limit).lean(),
    Task.find({ company, 'relatedTo.id': id }).sort('-createdAt').limit(limit).lean(),
  ]);
  return [
    ...acts.map((a) => ({ at: a.createdAt, kind: 'activity', type: a.type, message: a.message, meta: a.meta })),
    ...comms.map((c) => ({ at: c.createdAt, kind: 'communication', type: `${c.channel}.${c.direction}`, message: c.subject || c.body, status: c.status, sentiment: c.sentiment })),
    ...tasks.map((t) => ({ at: t.createdAt, kind: 'task', type: t.type, message: t.title, status: t.status })),
  ].sort((a, b) => b.at - a.at).slice(0, limit);
}

// Sales users are limited to their own records; they cannot hand records to someone else.
function ownerDefault(req, data) {
  if (req.user.role === 'sales') data.assignedTo = req.user._id;
  return data;
}

const need = (v, msg) => { if (!v) throw new HttpError(400, msg); return v; };

module.exports = { timeline, ownerDefault, need };
