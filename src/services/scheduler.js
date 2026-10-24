const M = require('../models');
const automation = require('./automation');
const campaigns = require('./campaigns');
const bulk = require('./bulk');
const ai = require('./ai');
const adsync = require('./adsync');
const { emit, notify, logActivity } = require('./events');

const INACTIVE_DAYS = 30;
let timer;

async function overdueAndReminders() {
  const now = new Date();
  const open = { status: { $in: ['pending', 'in_progress'] } };

  for (const t of await M.Task.find({ ...open, dueAt: { $lt: now }, overdueNotified: false }).limit(200)) {
    t.overdueNotified = true;
    await t.save();
    await notify(t.company, t.assignedTo, 'Task overdue', t.title, { kind: 'Task', id: t._id });
    await emit(t.company, 'followup.overdue', { kind: 'Task', id: t._id });
  }
  for (const t of await M.Task.find({ ...open, remindAt: { $lte: now }, reminded: false }).limit(200)) {
    t.reminded = true;
    await t.save();
    await notify(t.company, t.assignedTo, 'Reminder', t.title, { kind: 'Task', id: t._id });
  }
}

async function inactiveCustomers() {
  const cutoff = new Date(Date.now() - INACTIVE_DAYS * 864e5);
  for (const c of await M.Customer.find({ lifecycle: 'active', lastActivityAt: { $lt: cutoff } }).limit(200)) {
    const days = Math.floor((Date.now() - c.lastActivityAt) / 864e5);
    const neg = await M.Communication.countDocuments({ 'relatedTo.id': c._id, sentiment: 'negative' });
    c.churnRisk = ai.churnRisk(c, days, neg).risk;
    c.lifecycle = 'at_risk'; // also stops this customer re-triggering every tick
    await c.save();
    await emit(c.company, 'customer.inactive', { kind: 'Customer', id: c._id }, { daysInactive: days });
  }
}

async function dateEvents() {
  const now = new Date();
  const m = now.getUTCMonth() + 1, d = now.getUTCDate();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (const [field, event] of [['birthday', 'customer.birthday'], ['anniversary', 'customer.anniversary']]) {
    const people = await M.Customer.find({
      [field]: { $ne: null },
      $expr: { $and: [{ $eq: [{ $month: `$${field}` }, m] }, { $eq: [{ $dayOfMonth: `$${field}` }, d] }] },
    }).limit(500);
    for (const c of people) {
      if (await M.Activity.exists({ 'entity.id': c._id, type: event, createdAt: { $gte: start } })) continue; // once per day
      await logActivity(c.company, { kind: 'Customer', id: c._id }, event, `${field} today`);
      await emit(c.company, event, { kind: 'Customer', id: c._id });
    }
  }
}

async function tick() {
  for (const job of [automation.resumeDue, campaigns.processDue, bulk.processDue, overdueAndReminders, inactiveCustomers, dateEvents, adsync.processDue]) {
    try { await job(); } catch (e) { console.error(`[scheduler:${job.name}]`, e.message); }
  }
}

function start(intervalMs = 60000) {
  timer = setInterval(tick, intervalMs);
  timer.unref();
  console.log(`Scheduler started (every ${intervalMs / 1000}s)`);
}

const stop = () => clearInterval(timer);

module.exports = { start, stop, tick };
