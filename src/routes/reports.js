const express = require('express');
const M = require('../models');
const { authorize, scopeFilter } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');

const router = express.Router();

// Optional ?from=&to= window on createdAt (or the supplied date field).
function range(req, field = 'createdAt') {
  const q = {};
  if (req.query.from) { const d = new Date(req.query.from); if (isNaN(d)) throw new HttpError(400, 'Invalid from'); q.$gte = d; }
  if (req.query.to) { const d = new Date(req.query.to); if (isNaN(d)) throw new HttpError(400, 'Invalid to'); q.$lte = d; }
  return Object.keys(q).length ? { [field]: q } : {};
}

const sum = (rows, key = 'n') => rows.reduce((s, r) => s + r[key], 0);

router.get('/dashboard', authorize('dashboard', 'r'), async (req, res) => {
  const co = req.companyId;
  const lf = { company: co, ...scopeFilter(req, 'leads') };
  const df = { company: co, ...scopeFilter(req, 'deals') };
  const tf = { company: co, ...scopeFilter(req, 'tasks') };
  const now = new Date();
  const weekAgo = new Date(Date.now() - 7 * 864e5);
  const month = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalLeads, newLeads, won, lost, followUpsDue, revenueAgg, monthRevAgg, openAgg, topLeads, recent, team] = await Promise.all([
    M.Lead.countDocuments(lf),
    M.Lead.countDocuments({ ...lf, createdAt: { $gte: weekAgo } }),
    M.Deal.countDocuments({ ...df, status: 'won' }),
    M.Deal.countDocuments({ ...df, status: 'lost' }),
    M.Task.countDocuments({ ...tf, status: { $in: ['pending', 'in_progress'] }, dueAt: { $lte: now } }),
    M.Deal.aggregate([{ $match: { ...df, status: 'won' } }, { $group: { _id: null, v: { $sum: '$value' } } }]),
    M.Deal.aggregate([{ $match: { ...df, status: 'won', closedAt: { $gte: month } } }, { $group: { _id: null, v: { $sum: '$value' } } }]),
    M.Deal.aggregate([{ $match: { ...df, status: 'open' } }, { $group: { _id: null, v: { $sum: '$value' }, n: { $sum: 1 } } }]),
    M.Lead.find({ ...lf, status: { $nin: ['won', 'lost'] } }).sort('-score').limit(5).select('name score status'),
    M.Activity.find({ company: co }).sort('-createdAt').limit(15),
    M.Deal.aggregate([
      { $match: { company: co, status: 'won' } },
      { $group: { _id: '$assignedTo', deals: { $sum: 1 }, revenue: { $sum: '$value' } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { deals: 1, revenue: 1, name: { $arrayElemAt: ['$u.name', 0] } } },
      { $sort: { revenue: -1 } }, { $limit: 10 },
    ]),
  ]);
  const closed = won + lost;
  const insights = [];
  if (followUpsDue) insights.push(`${followUpsDue} follow-up(s) are due or overdue - clear them first.`);
  if (topLeads[0]?.score >= 70) insights.push(`"${topLeads[0].name}" is your hottest lead (score ${topLeads[0].score}) - call today.`);
  if (closed && won / closed < 0.3) insights.push('Win rate is under 30% - review qualification criteria.');
  if (!insights.length) insights.push('Pipeline looks healthy. Keep following up.');

  res.json({
    totalLeads, newLeads, followUpsDue, wonDeals: won, lostDeals: lost,
    conversionRate: closed ? +((won / closed) * 100).toFixed(1) : 0,
    salesRevenue: revenueAgg[0]?.v || 0, revenueThisMonth: monthRevAgg[0]?.v || 0,
    openPipeline: { deals: openAgg[0]?.n || 0, value: openAgg[0]?.v || 0 },
    topLeads, teamPerformance: team, activityTimeline: recent, aiInsights: insights,
  });
});

router.use(authorize('reports', 'r'));

router.get('/leads-by-source', async (req, res) => {
  const rows = await M.Lead.aggregate([
    { $match: { company: req.companyId, ...scopeFilter(req, 'leads'), ...range(req) } },
    { $group: { _id: '$source', leads: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } }, avgScore: { $avg: '$score' } } },
    { $project: { source: '$_id', _id: 0, leads: 1, won: 1, avgScore: { $round: ['$avgScore', 1] }, conversion: { $round: [{ $multiply: [{ $divide: ['$won', '$leads'] }, 100] }, 1] } } },
    { $sort: { leads: -1 } },
  ]);
  res.json(rows);
});

router.get('/funnel', async (req, res) => {
  const rows = await M.Lead.aggregate([
    { $match: { company: req.companyId, ...scopeFilter(req, 'leads'), ...range(req) } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const total = sum(rows);
  // A lead at a later stage has passed through all the earlier ones.
  const order = M.LEAD_STAGES.filter((s) => s !== 'lost');
  const funnel = order.map((stage, i) => {
    const reached = order.slice(i).reduce((s, st) => s + (by[st] || 0), 0);
    return { stage, reached, pct: total ? +((reached / total) * 100).toFixed(1) : 0 };
  });
  res.json({ total, lost: by.lost || 0, funnel });
});

router.get('/revenue', async (req, res) => {
  const rows = await M.Deal.aggregate([
    { $match: { company: req.companyId, ...scopeFilter(req, 'deals'), status: 'won', closedAt: { $ne: null }, ...range(req, 'closedAt') } },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$closedAt' } }, revenue: { $sum: '$value' }, deals: { $sum: 1 } } },
    { $sort: { _id: 1 } }, { $project: { _id: 0, month: '$_id', revenue: 1, deals: 1 } },
  ]);
  res.json({ total: sum(rows, 'revenue'), months: rows });
});

router.get('/conversion', async (req, res) => {
  const f = { company: req.companyId, ...scopeFilter(req, 'leads'), ...range(req) };
  const [total, won] = await Promise.all([M.Lead.countDocuments(f), M.Lead.countDocuments({ ...f, status: 'won' })]);
  res.json({ leads: total, won, conversionRate: total ? +((won / total) * 100).toFixed(1) : 0 });
});

router.get('/team', async (req, res) => {
  const co = req.companyId;
  const users = await M.User.find({ company: co, active: true }).select('name role');
  const rows = await Promise.all(users.map(async (u) => {
    const [leads, wonLeads, tasksDone, tasksOpen, rev] = await Promise.all([
      M.Lead.countDocuments({ company: co, assignedTo: u._id }),
      M.Lead.countDocuments({ company: co, assignedTo: u._id, status: 'won' }),
      M.Task.countDocuments({ company: co, assignedTo: u._id, status: 'done' }),
      M.Task.countDocuments({ company: co, assignedTo: u._id, status: { $in: ['pending', 'in_progress'] } }),
      M.Deal.aggregate([{ $match: { company: co, assignedTo: u._id, status: 'won' } }, { $group: { _id: null, v: { $sum: '$value' } } }]),
    ]);
    return { user: u.name, role: u.role, leads, wonLeads, conversion: leads ? +((wonLeads / leads) * 100).toFixed(1) : 0, tasksDone, tasksOpen, revenue: rev[0]?.v || 0 };
  }));
  res.json(rows.sort((a, b) => b.revenue - a.revenue));
});

router.get('/campaigns', async (req, res) => {
  const camps = await M.Campaign.find({ company: req.companyId }).select('name channel status stats cost');
  res.json(camps.map((c) => ({ id: c._id, name: c.name, channel: c.channel, status: c.status, ...c.stats, cost: c.cost })));
});

router.get('/automation', async (req, res) => {
  const wfs = await M.Workflow.find({ company: req.companyId, isTemplate: { $ne: true } }).select('name active trigger stats');
  const waiting = await M.WorkflowRun.countDocuments({ company: req.companyId, status: 'waiting' });
  res.json({
    waitingRuns: waiting,
    workflows: wfs.map((w) => ({ id: w._id, name: w.name, active: w.active, event: w.trigger.event, ...w.stats, successRate: w.stats.runs ? +((w.stats.completed / w.stats.runs) * 100).toFixed(1) : null })),
  });
});

module.exports = router;
