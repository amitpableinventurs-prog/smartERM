const M = require('../models');
const hr = require('./hr');
const { HttpError } = require('../utils/helpers');
const { notify, logActivity } = require('./events');

const { DAY } = hr;

async function applyLeave({ company, employee, type, from, to, halfDay = false, reason }) {
  const fromMs = hr.dayOnly(from), toMs = hr.dayOnly(to);
  if (toMs < fromMs) throw new HttpError(400, 'End date is before start date');
  if (halfDay && fromMs !== toMs) throw new HttpError(400, 'A half-day leave must be a single day');
  if (toMs - fromMs > 120 * DAY) throw new HttpError(400, 'Leave cannot be longer than 120 days');
  const settings = await hr.getSettings(company);
  const holidays = await hr.holidaySetFor(company, fromMs, toMs + DAY);
  const days = halfDay ? (hr.isWorkingDay(fromMs, settings, holidays) ? 0.5 : 0) : hr.countWorkingDays(fromMs, toMs, settings, holidays);
  if (!days) throw new HttpError(400, 'Those dates have no working days (weekly off / holidays only)');

  const clash = await M.LeaveRequest.exists({ company, employee: employee._id, status: { $in: ['pending', 'approved'] }, from: { $lte: new Date(toMs) }, to: { $gte: new Date(fromMs) } });
  if (clash) throw new HttpError(409, 'You already have a leave request overlapping these dates');

  if (hr.PAID_LEAVE_TYPES.includes(type)) {
    const bal = await hr.leaveBalances(company, employee._id, new Date(fromMs).getUTCFullYear(), settings);
    if (bal[type].available < days) throw new HttpError(400, `Not enough ${type} leave: ${bal[type].available} day(s) available, ${days} requested`);
  }
  return M.LeaveRequest.create({ company, employee: employee._id, type, from: new Date(fromMs), to: new Date(toMs), days, halfDay, reason });
}

// Writes one attendance row per working day of an approved leave.
async function markLeaveDays(req) {
  const settings = await hr.getSettings(req.company);
  const fromMs = hr.dayOnly(req.from), toMs = hr.dayOnly(req.to);
  const holidays = await hr.holidaySetFor(req.company, fromMs, toMs + DAY);
  const ops = [];
  for (let d = fromMs; d <= toMs; d += DAY) {
    if (!hr.isWorkingDay(d, settings, holidays)) continue;
    ops.push({
      updateOne: {
        filter: { company: req.company, employee: req.employee, date: new Date(d) },
        update: { $set: { status: req.halfDay ? 'half_day' : 'leave', leaveType: req.type, source: 'leave', note: `${req.type} leave${req.halfDay ? ' (half day)' : ''}` } },
        upsert: true,
      },
    });
  }
  if (ops.length) await M.Attendance.bulkWrite(ops);
}

async function decideLeave({ request, approve, user, note }) {
  if (request.status !== 'pending') throw new HttpError(409, `Request is already ${request.status}`);
  if (approve) {
    if (hr.PAID_LEAVE_TYPES.includes(request.type)) {
      const settings = await hr.getSettings(request.company);
      const bal = await hr.leaveBalances(request.company, request.employee, request.from.getUTCFullYear(), settings);
      // this request is itself counted as "pending", so only a negative balance is a problem
      if (bal[request.type].available < 0) throw new HttpError(400, `Employee has no ${request.type} leave balance left`);
    }
    await markLeaveDays(request);
  }
  request.status = approve ? 'approved' : 'rejected';
  request.decidedBy = user._id;
  request.decidedAt = new Date();
  request.decisionNote = note;
  await request.save();
  const emp = await M.Employee.findById(request.employee);
  if (emp?.user) await notify(request.company, emp.user, `Leave ${request.status}`, `${request.type} leave ${request.from.toISOString().slice(0, 10)} → ${request.to.toISOString().slice(0, 10)}${note ? ': ' + note : ''}`);
  await logActivity(request.company, { kind: 'Employee', id: request.employee }, `leave.${request.status}`, `${request.type} leave ${request.status}`, null, user._id);
  return request;
}

async function cancelLeave({ request, company, now = new Date() }) {
  if (!['pending', 'approved'].includes(request.status)) throw new HttpError(409, `Request is already ${request.status}`);
  const settings = await hr.getSettings(company);
  if (request.status === 'approved') {
    if (hr.dayOnly(request.from) <= hr.localDayMs(now, settings.tzOffsetMinutes)) throw new HttpError(409, 'Leave that has already started can only be changed by HR');
    await M.Attendance.deleteMany({ company, employee: request.employee, source: 'leave', date: { $gte: request.from, $lte: request.to } });
  }
  request.status = 'cancelled';
  await request.save();
  return request;
}

module.exports = { applyLeave, decideLeave, cancelLeave };
