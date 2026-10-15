/** "My Space": every logged-in user's own attendance, leave and payslips (/api/me). No role check: it only ever touches the caller's own employee record. */
const express = require('express');
const { z } = require('zod');
const M = require('../models');
const { validate } = require('../middleware/common');
const { HttpError } = require('../utils/helpers');
const hr = require('../services/hr');
const leave = require('../services/leave');
const { notify } = require('../services/events');

const router = express.Router();
const { DAY, iso, r2 } = hr;

async function myEmployee(req) {
  let emp = await M.Employee.findOne({ company: req.companyId, user: req.user._id });
  if (!emp) {
    // First visit: link by matching email, if HR already created the employee record.
    emp = await M.Employee.findOne({ company: req.companyId, email: req.user.email, user: { $exists: false } });
    if (emp) { emp.user = req.user._id; await emp.save(); }
  }
  if (!emp) throw new HttpError(404, 'No employee profile is linked to your login yet. Ask HR to add you as an employee using your login email.');
  if (emp.status !== 'active') throw new HttpError(403, 'Your employee record is not active');
  return emp;
}

async function dayInfo(company, settings, dayMs) {
  const holidays = await hr.holidaySetFor(company, dayMs, dayMs + DAY);
  const name = holidays.size ? (await M.Holiday.findOne({ company, date: new Date(dayMs) }))?.name : null;
  return { dayType: holidays.size ? 'holiday' : settings.weekOff.includes(new Date(dayMs).getUTCDay()) ? 'weekoff' : 'working', holidayName: name };
}

router.get('/profile', async (req, res) => {
  const emp = await myEmployee(req);
  const s = await hr.getSettings(req.companyId);
  res.json({ employee: emp, policy: { shiftStart: s.shiftStart, graceMinutes: s.graceMinutes, fullDayHours: s.fullDayHours, weekOff: s.weekOff } });
});

router.get('/today', async (req, res) => {
  const emp = await myEmployee(req);
  const s = await hr.getSettings(req.companyId);
  const dayMs = hr.localDayMs(new Date(), s.tzOffsetMinutes);
  const [row, info] = await Promise.all([M.Attendance.findOne({ company: req.companyId, employee: emp._id, date: new Date(dayMs) }), dayInfo(req.companyId, s, dayMs)]);
  res.json({ date: iso(dayMs), serverTime: new Date(), ...info, attendance: row, shiftStart: s.shiftStart });
});

router.post('/punch-in', async (req, res) => {
  const emp = await myEmployee(req);
  const s = await hr.getSettings(req.companyId);
  const now = new Date();
  const dayMs = hr.localDayMs(now, s.tzOffsetMinutes);
  const key = { company: req.companyId, employee: emp._id, date: new Date(dayMs) };
  const row = await M.Attendance.findOne(key);
  if (row?.checkIn) throw new HttpError(409, 'You have already punched in today');
  if (row?.status === 'leave') throw new HttpError(409, 'You are on approved leave today');
  const late = hr.isLate(now, s);
  // A half-day leave keeps its status; anything else becomes a (provisional) present day until punch-out.
  const status = row?.status === 'half_day' && row.leaveType ? 'half_day' : 'present';
  const saved = await M.Attendance.findOneAndUpdate(key, { $set: { checkIn: now, late, status, source: row ? row.source : 'self' }, $setOnInsert: { hoursWorked: 0 } }, { upsert: true, returnDocument: 'after' });
  res.status(201).json(saved);
});

router.post('/punch-out', async (req, res) => {
  const emp = await myEmployee(req);
  const s = await hr.getSettings(req.companyId);
  const now = new Date();
  const row = await M.Attendance.findOne({ company: req.companyId, employee: emp._id, date: new Date(hr.localDayMs(now, s.tzOffsetMinutes)) });
  if (!row?.checkIn) throw new HttpError(409, 'Punch in first');
  if (row.checkOut) throw new HttpError(409, 'You have already punched out today');
  row.checkOut = now;
  row.hoursWorked = r2((now - row.checkIn) / 36e5);
  if (!(row.status === 'half_day' && row.leaveType)) row.status = hr.statusFromHours(row.hoursWorked, s);
  await row.save();
  res.json(row);
});

router.get('/attendance', async (req, res) => {
  const emp = await myEmployee(req);
  const month = String(req.query.month || iso(Date.now()).slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must look like 2026-10');
  const s = await hr.getSettings(req.companyId);
  const { start, end } = hr.monthRange(month);
  const rows = await M.Attendance.find({ company: req.companyId, employee: emp._id, date: { $gte: new Date(start), $lt: new Date(end) } }).sort('date');
  const holidays = await M.Holiday.find({ company: req.companyId, date: { $gte: new Date(start), $lt: new Date(end) } }).sort('date').select('date name');
  const hs = new Set(holidays.map((h) => iso(h.date)));
  const slip = hr.computeSlip({ emp, month, settings: s, holidaySet: hs, attendance: rows });
  res.json({
    month, weekOff: s.weekOff, holidays, attendance: rows,
    summary: { workingDays: slip.workingDays, present: slip.presentDays, halfDays: slip.halfDays, paidLeave: slip.paidLeaveDays, unpaidLeave: slip.unpaidLeaveDays, absent: slip.absentDays, late: slip.lateMarks, hours: r2(rows.reduce((a, r) => a + (r.hoursWorked || 0), 0)) },
  });
});

router.get('/balances', async (req, res) => {
  const emp = await myEmployee(req);
  res.json(await hr.leaveBalances(req.companyId, emp._id, +req.query.year || new Date().getUTCFullYear(), await hr.getSettings(req.companyId)));
});

router.get('/leaves', async (req, res) => {
  const emp = await myEmployee(req);
  res.json(await M.LeaveRequest.find({ company: req.companyId, employee: emp._id }).sort('-createdAt').limit(50));
});

router.post('/leaves', validate(z.object({ type: z.enum(['casual', 'sick', 'earned', 'unpaid']), from: z.coerce.date(), to: z.coerce.date(), halfDay: z.boolean().optional(), reason: z.string().max(500).optional() })), async (req, res) => {
  const emp = await myEmployee(req);
  const lr = await leave.applyLeave({ company: req.companyId, employee: emp, ...req.body });
  // tell HR
  const hrUsers = await M.User.find({ company: req.companyId, active: true, role: { $in: ['hr_manager', 'admin', 'super_admin'] } }).select('_id');
  await Promise.all(hrUsers.map((u) => notify(req.companyId, u._id, 'Leave request', `${emp.name}: ${lr.type} leave, ${lr.days} day(s)`)));
  res.status(201).json(lr);
});

router.post('/leaves/:id/cancel', async (req, res) => {
  const emp = await myEmployee(req);
  const lr = await M.LeaveRequest.findOne({ _id: req.params.id, company: req.companyId, employee: emp._id });
  if (!lr) throw new HttpError(404, 'Leave request not found');
  res.json(await leave.cancelLeave({ request: lr, company: req.companyId }));
});

router.get('/holidays', async (req, res) => {
  const s = await hr.getSettings(req.companyId);
  res.json(await M.Holiday.find({ company: req.companyId, date: { $gte: new Date(hr.localDayMs(new Date(), s.tzOffsetMinutes)) } }).sort('date').limit(10).select('date name'));
});

// Only finalized/paid payslips are visible to the employee.
router.get('/payslips', async (req, res) => {
  const emp = await myEmployee(req);
  const runs = await M.PayrollRun.find({ company: req.companyId, status: { $in: ['finalized', 'paid'] } }).select('month status');
  const slips = await M.Payslip.find({ company: req.companyId, employee: emp._id, run: { $in: runs.map((r) => r._id) } }).sort('-month').limit(24);
  const st = new Map(runs.map((r) => [String(r._id), r.status]));
  res.json(slips.map((s) => ({ ...s.toObject(), runStatus: st.get(String(s.run)) })));
});

router.get('/payslips/:id', async (req, res) => {
  const emp = await myEmployee(req);
  const s = await M.Payslip.findOne({ _id: req.params.id, company: req.companyId, employee: emp._id });
  const run = s && (await M.PayrollRun.findById(s.run));
  if (!s || !['finalized', 'paid'].includes(run?.status)) throw new HttpError(404, 'Payslip not found');
  const co = await M.Company.findById(req.companyId).select('name');
  res.json({ ...s.toObject(), company: co.name, runStatus: run.status });
});

module.exports = router;
