const { Task } = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { HttpError, addDays } = require('../utils/helpers');
const { notify } = require('../services/events');
const { ownerDefault } = require('./shared');

const NEXT = { daily: (d) => addDays(d, 1), weekly: (d) => addDays(d, 7), monthly: (d) => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; } };

const c = crud({
  Model: Task,
  resource: 'tasks',
  search: ['title', 'description'],
  filters: ['status', 'priority', 'type', 'assignedTo', 'relatedTo.id'],
  populate: { path: 'assignedTo', select: 'name' },
  defaultSort: 'dueAt',
  hooks: {
    beforeCreate: (req, data) => {
      ownerDefault(req, data);
      data.assignedTo ||= req.user._id;
    },
    // ?due=overdue | today
    listFilter(req) {
      const now = new Date();
      if (req.query.due === 'overdue') return { dueAt: { $lt: now }, status: { $in: ['pending', 'in_progress'] } };
      if (req.query.due === 'today') {
        const s = new Date(now); s.setHours(0, 0, 0, 0);
        return { dueAt: { $gte: s, $lt: addDays(s, 1) } };
      }
      return {};
    },
    async beforeUpdate(req, task, data) {
      if (req.user.role === 'sales') delete data.assignedTo;
      if (data.dueAt) { data.overdueNotified = false; data.reminded = false; }
    },
    async afterUpdate(req, task, before) {
      if (String(task.assignedTo) !== String(before.assignedTo)) {
        await notify(req.companyId, task.assignedTo, 'Task assigned', task.title, { kind: 'Task', id: task._id });
      }
    },
    async afterCreate(req, task) {
      if (String(task.assignedTo) !== String(req.user._id)) await notify(req.companyId, task.assignedTo, 'Task assigned', task.title, { kind: 'Task', id: task._id });
    },
  },
});

c.router.post('/:id/complete', authorize('tasks', 'u'), async (req, res) => {
  const task = await c.find(req);
  if (task.status === 'done') throw new HttpError(409, 'Task already completed');
  task.status = 'done';
  task.completedAt = new Date();
  await task.save();
  let next = null;
  if (task.recurrence !== 'none' && task.dueAt) {
    const { _id, createdAt, updatedAt, completedAt, ...rest } = task.toObject();
    next = await Task.create({ ...rest, status: 'pending', dueAt: NEXT[task.recurrence](task.dueAt), remindAt: task.remindAt && NEXT[task.recurrence](task.remindAt), reminded: false, overdueNotified: false });
  }
  res.json({ task, nextTask: next });
});

// Calendar feed: tasks within [from, to).
c.router.get('/calendar/range', authorize('tasks', 'r'), async (req, res) => {
  const from = new Date(req.query.from), to = new Date(req.query.to);
  if (isNaN(from) || isNaN(to)) throw new HttpError(400, 'from and to must be valid dates');
  res.json(await Task.find({ ...c.base(req), dueAt: { $gte: from, $lt: to } }).sort('dueAt').populate('assignedTo', 'name'));
});

module.exports = c.finish();
