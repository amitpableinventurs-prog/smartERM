/** HR panel API: employees, attendance, leave, holidays, payroll, settings. All under /api/hr (resource 'hr'). */
const express = require('express');
const { z } = require('zod');
const M = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { validate, audit } = require('../middleware/common');
const { HttpError, toCsv } = require('../utils/helpers');
const { notify } = require('../services/events');
const hr = require('../services/hr');
const leave = require('../services/leave');

const router = express.Router();
const { DAY, iso, r2 } = hr;
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateStr = z.coerce.date();

const monthQuery = (req) => {
  const m = String(req.query.month || iso(Date.now()).slice(0, 7));
  if (!monthRe.test(m)) throw new HttpError(400, 'month must look like 2026-10');
  return m;
};

// ---------------- Employees ----------------
const employees = crud({
  Model: M.Employee, resource: 'hr', search: ['name', 'email', 'employeeCode', 'department', 'designation'], filters: ['department', 'status', 'branch'], scope: false,
  populate: { path: 'user', select: 'email role' }, defaultSort: 'employeeCode',
  hooks: {
    async beforeCreate(req, data) {
      if (!data.joinDate) throw new HttpError(400, 'joinDate is required');
      delete data.user;
      if (!data.employeeCode) {
        let n = (await M.Employee.countDocuments({ company: req.companyId })) + 1;
        while (await M.Employee.exists({ company: req.companyId, employeeCode: `EMP-${String(n).padStart(3, '0')}` })) n++;
        data.employeeCode = `EMP-${String(n).padStart(3, '0')}`;
      }
      // Link to a login with the same email so the employee can use My Space.
      const u = data.email && (await M.User.findOne({ company: req.companyId, email: String(data.email).toLowerCase() }).select('_id'));
      if (u && !(await M.Employee.exists({ company: req.companyId, user: u._id }))) data.user = u._id;
      return data;
    },
    beforeUpdate(req, emp, data) {
      delete data.user;
      if (data.status === 'terminated' && !data.exitDate && !emp.exitDate) data.exitDate = new Date();
    },
    async beforeDelete(req, emp) {
      if (await M.Payslip.exists({ employee: emp._id })) throw new HttpError(409, 'Employee has payslips. Mark them as terminated instead of deleting.');
      await M.Attendance.deleteMany({ employee: emp._id });
      await M.LeaveRequest.deleteMany({ employee: emp._id });
    },
  },
});

employees.router.get('/departments', authorize('hr', 'r'), async (req, res) => res.json((await M.Employee.distinct('department', { company: req.companyId })).filter(Boolean).sort()));

employees.router.get('/:id/summary', authorize('hr', 'r'), async (req, res) => {
  const emp = await employees.find(req);
  const month = monthQuery(req);
  const settings = await hr.getSettings(req.companyId);
  const { start, end } = hr.monthRange(month);
  const rows = await M.Attendance.find({ company: req.companyId, employee: emp._id, date: { $gte: new Date(start), $lt: new Date(end) } }).sort('date');
  const holidays = await hr.holidaySetFor(req.companyId, start, end);
  const slip = hr.computeSlip({ emp, month, settings, holidaySet: holidays, attendance: rows });
  res.json({
    month, attendance: rows, preview: slip, balances: await hr.leaveBalances(req.companyId, emp._id, +month.slice(0, 4), settings),
    payslips: await M.Payslip.find({ company: req.companyId, employee: emp._id }).sort('-month').limit(12).select('month netPay gross run'),
  });
});
router.use('/employees', employees.finish());

// ---------------- Attendance ----------------
const attendance = express.Router();
attendance.use(audit('hr'));

attendance.get('/', authorize('hr', 'r'), async (req, res) => {
  const q = { company: req.companyId };
  if (req.query.employee) q.employee = req.query.employee;
  if (req.query.from || req.query.to) q.date = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) };
  const page = Math.max(1, +req.query.page || 1);
  const [data, total] = await Promise.all([
    M.Attendance.find(q).sort('-date').skip((page - 1) * 30).limit(30).populate('employee', 'name employeeCode department'),
    M.Attendance.countDocuments(q),
  ]);
  res.json({ data, page, limit: 30, total, pages: Math.ceil(total / 30) });
});

// Everyone's status for one day.
attendance.get('/roster', authorize('hr', 'r'), async (req, res) => {
  const settings = await hr.getSettings(req.companyId);
  const dayMs = req.query.date ? hr.dayOnly(new Date(String(req.query.date))) : hr.localDayMs(new Date(), settings.tzOffsetMinutes);
  if (Number.isNaN(dayMs)) throw new HttpError(400, 'Invalid date');
  const holidays = await hr.holidaySetFor(req.companyId, dayMs, dayMs + DAY);
  const holidayName = holidays.size ? (await M.Holiday.findOne({ company: req.companyId, date: new Date(dayMs) }))?.name : null;
  const dayType = holidays.size ? 'holiday' : settings.weekOff.includes(new Date(dayMs).getUTCDay()) ? 'weekoff' : 'working';
  const emps = await M.Employee.find({ company: req.companyId, status: 'active', joinDate: { $lte: new Date(dayMs) } }).sort('employeeCode');
  const rows = new Map((await M.Attendance.find({ company: req.companyId, date: new Date(dayMs) })).map((a) => [String(a.employee), a]));
  const out = emps.map((e) => {
    const a = rows.get(String(e._id));
    return { employee: { id: e._id, name: e.name, code: e.employeeCode, department: e.department }, status: a?.status || (dayType === 'working' ? 'not_marked' : dayType), checkIn: a?.checkIn, checkOut: a?.checkOut, hours: a?.hoursWorked || 0, late: !!a?.late, leaveType: a?.leaveType, note: a?.note, id: a?._id };
  });
  const count = (s) => out.filter((r) => r.status === s).length;
  res.json({ date: iso(dayMs), dayType, holidayName, summary: { total: out.length, present: count('present'), half_day: count('half_day'), leave: count('leave'), absent: count('absent'), not_marked: count('not_marked'), late: out.filter((r) => r.late).length }, rows: out });
});

const markSchema = z.object({
  employee: z.string().length(24), date: dateStr, status: z.enum(['present', 'absent', 'half_day', 'leave', 'holiday', 'weekoff']).optional(),
  checkIn: z.coerce.date().optional(), checkOut: z.coerce.date().optional(), leaveType: z.enum(['casual', 'sick', 'earned', 'unpaid']).optional(), note: z.string().max(300).optional(),
});

async function upsertMark(company, settings, b) {
  const emp = await M.Employee.findOne({ _id: b.employee, company });
  if (!emp) throw new HttpError(404, 'Employee not found');
  const dayMs = hr.dayOnly(b.date);
  const set = { source: 'manual', note: b.note };
  const unset = {};
  if (b.checkIn) { set.checkIn = b.checkIn; set.late = hr.isLate(b.checkIn, settings); }
  if (b.checkOut) {
    if (b.checkIn && b.checkOut < b.checkIn) throw new HttpError(400, 'Check-out is before check-in');
    set.checkOut = b.checkOut;
  }
  if (b.checkIn && b.checkOut) set.hoursWorked = r2((b.checkOut - b.checkIn) / 36e5);
  set.status = b.status || (b.checkIn && b.checkOut ? hr.statusFromHours(set.hoursWorked, settings) : 'present');
  if (set.status === 'leave') set.leaveType = b.leaveType || 'casual'; else unset.leaveType = 1;
  if (['absent', 'leave', 'holiday', 'weekoff'].includes(set.status) && !b.checkIn) { unset.checkIn = 1; unset.checkOut = 1; set.hoursWorked = 0; set.late = false; }
  await M.Attendance.updateOne({ company, employee: emp._id, date: new Date(dayMs) }, { $set: set, ...(Object.keys(unset).length && { $unset: unset }) }, { upsert: true });
}

attendance.post('/mark', authorize('hr', 'c'), validate(markSchema), async (req, res) => {
  await upsertMark(req.companyId, await hr.getSettings(req.companyId), req.body);
  res.status(201).json({ saved: true });
});

attendance.post('/bulk', authorize('hr', 'c'), validate(z.object({ date: dateStr, status: z.enum(['present', 'absent', 'holiday', 'weekoff']), employees: z.array(z.string().length(24)).min(1).max(500) })), async (req, res) => {
  const settings = await hr.getSettings(req.companyId);
  let saved = 0;
  for (const employee of req.body.employees) { await upsertMark(req.companyId, settings, { employee, date: req.body.date, status: req.body.status, note: 'Bulk update' }); saved++; }
  res.status(201).json({ saved });
});

// Month grid: one row per employee with a status per day.
attendance.get('/monthly', authorize('hr', 'r'), async (req, res) => {
  const month = monthQuery(req);
  const settings = await hr.getSettings(req.companyId);
  const { start, end, days } = hr.monthRange(month);
  const holidays = await hr.holidaySetFor(req.companyId, start, end);
  const todayMs = hr.localDayMs(new Date(), settings.tzOffsetMinutes);
  const emps = await M.Employee.find({ company: req.companyId, joinDate: { $lt: new Date(end) }, $or: [{ exitDate: null }, { exitDate: { $gte: new Date(start) } }] }).sort('employeeCode');
  const rows = await M.Attendance.find({ company: req.companyId, date: { $gte: new Date(start), $lt: new Date(end) } });
  const by = new Map();
  for (const r of rows) { const k = `${r.employee}|${iso(r.date)}`; by.set(k, r); }
  const CODE = { present: 'P', half_day: 'H', leave: 'L', absent: 'A', holiday: 'O', weekoff: 'W' };
  const grid = emps.map((e) => {
    const cells = []; const tot = { present: 0, half: 0, leave: 0, absent: 0, late: 0 };
    for (let i = 0; i < days; i++) {
      const d = start + i * DAY, key = iso(d);
      const a = by.get(`${e._id}|${key}`);
      let c;
      if (d < hr.dayOnly(e.joinDate) || (e.exitDate && d > hr.dayOnly(e.exitDate))) c = '';
      else if (a) c = CODE[a.status];
      else if (holidays.has(key)) c = 'O';
      else if (settings.weekOff.includes(new Date(d).getUTCDay())) c = 'W';
      else c = d > todayMs ? '' : 'A';
      cells.push(c);
      if (c === 'P') tot.present++; else if (c === 'H') tot.half++; else if (c === 'L') tot.leave++; else if (c === 'A') tot.absent++;
      if (a?.late) tot.late++;
    }
    return { employee: { id: e._id, name: e.name, code: e.employeeCode, department: e.department }, cells, ...tot };
  });
  res.json({ month, days, legend: { P: 'Present', H: 'Half day', L: 'Leave', A: 'Absent', O: 'Holiday', W: 'Weekly off' }, grid });
});

attendance.delete('/:id', authorize('hr', 'd'), async (req, res) => {
  const r = await M.Attendance.deleteOne({ _id: req.params.id, company: req.companyId });
  if (!r.deletedCount) throw new HttpError(404, 'Attendance record not found');
  res.status(204).end();
});
router.use('/attendance', attendance);

// ---------------- Leave ----------------
const leaves = express.Router();
leaves.use(audit('hr'));

leaves.get('/', authorize('hr', 'r'), async (req, res) => {
  const q = { company: req.companyId };
  for (const k of ['status', 'employee', 'type']) if (req.query[k]) q[k] = req.query[k];
  const page = Math.max(1, +req.query.page || 1);
  const [data, total] = await Promise.all([
    M.LeaveRequest.find(q).sort('-createdAt').skip((page - 1) * 20).limit(20).populate('employee', 'name employeeCode department'),
    M.LeaveRequest.countDocuments(q),
  ]);
  res.json({ data, page, limit: 20, total, pages: Math.ceil(total / 20) });
});

// HR can file a request on someone's behalf.
leaves.post('/', authorize('hr', 'c'), validate(z.object({ employee: z.string().length(24), type: z.enum(['casual', 'sick', 'earned', 'unpaid']), from: dateStr, to: dateStr, halfDay: z.boolean().optional(), reason: z.string().max(500).optional() })), async (req, res) => {
  const emp = await M.Employee.findOne({ _id: req.body.employee, company: req.companyId });
  if (!emp) throw new HttpError(404, 'Employee not found');
  res.status(201).json(await leave.applyLeave({ company: req.companyId, employee: emp, ...req.body }));
});

const decide = (approve) => async (req, res) => {
  const lr = await M.LeaveRequest.findOne({ _id: req.params.id, company: req.companyId });
  if (!lr) throw new HttpError(404, 'Leave request not found');
  res.json(await leave.decideLeave({ request: lr, approve, user: req.user, note: req.body?.note }));
};
leaves.post('/:id/approve', authorize('hr', 'u'), decide(true));
leaves.post('/:id/reject', authorize('hr', 'u'), decide(false));
leaves.post('/:id/cancel', authorize('hr', 'u'), async (req, res) => {
  const lr = await M.LeaveRequest.findOne({ _id: req.params.id, company: req.companyId });
  if (!lr) throw new HttpError(404, 'Leave request not found');
  res.json(await leave.cancelLeave({ request: lr, company: req.companyId }));
});
leaves.get('/balances/:employeeId', authorize('hr', 'r'), async (req, res) => {
  const emp = await M.Employee.findOne({ _id: req.params.employeeId, company: req.companyId });
  if (!emp) throw new HttpError(404, 'Employee not found');
  res.json(await hr.leaveBalances(req.companyId, emp._id, +req.query.year || new Date().getUTCFullYear(), await hr.getSettings(req.companyId)));
});
router.use('/leaves', leaves);

// ---------------- Holidays ----------------
const holidays = crud({
  Model: M.Holiday, resource: 'hr', search: ['name'], scope: false, defaultSort: 'date',
  hooks: {
    beforeCreate(req, d) { d.date = new Date(hr.dayOnly(d.date)); },
    beforeUpdate(req, doc, d) { if (d.date) d.date = new Date(hr.dayOnly(d.date)); },
    listFilter(req) { const y = +req.query.year; return y ? { date: { $gte: new Date(Date.UTC(y, 0, 1)), $lt: new Date(Date.UTC(y + 1, 0, 1)) } } : {}; },
  },
});
router.use('/holidays', holidays.finish());

// ---------------- Payroll ----------------
const payroll = express.Router();
payroll.use(audit('hr'));

payroll.get('/runs', authorize('hr', 'r'), async (req, res) => res.json(await M.PayrollRun.find({ company: req.companyId }).sort('-month').limit(36)));

payroll.post('/run', authorize('hr', 'c'), validate(z.object({ month: z.string().regex(monthRe) })), async (req, res) => {
  const settings = await hr.getSettings(req.companyId);
  const thisMonth = new Date(hr.localDayMs(new Date(), settings.tzOffsetMinutes)).toISOString().slice(0, 7);
  if (req.body.month > thisMonth) throw new HttpError(400, 'Cannot run payroll for a future month');
  const existing = await M.PayrollRun.findOne({ company: req.companyId, month: req.body.month });
  if (existing) {
    if (existing.status !== 'draft') throw new HttpError(409, `Payroll for ${req.body.month} is already ${existing.status}`);
    await M.Payslip.deleteMany({ run: existing._id }); // re-run a draft from the latest attendance
    await existing.deleteOne();
  }
  const run = await hr.buildRun({ company: req.companyId, month: req.body.month, userId: req.user._id });
  res.status(201).json(run);
});

payroll.get('/runs/:id', authorize('hr', 'r'), async (req, res) => {
  const run = await M.PayrollRun.findOne({ _id: req.params.id, company: req.companyId });
  if (!run) throw new HttpError(404, 'Payroll run not found');
  res.json({ run, payslips: await M.Payslip.find({ run: run._id }).populate('employee', 'name employeeCode department').sort('snapshot.employeeCode') });
});

payroll.patch('/payslips/:id', authorize('hr', 'u'), validate(z.object({ adjustments: z.array(z.object({ label: z.string().min(1).max(60), amount: z.number().finite() })).max(20) })), async (req, res) => {
  const slip = await M.Payslip.findOne({ _id: req.params.id, company: req.companyId });
  if (!slip) throw new HttpError(404, 'Payslip not found');
  const run = await M.PayrollRun.findById(slip.run);
  if (run.status !== 'draft') throw new HttpError(409, 'Only draft payroll can be adjusted');
  slip.adjustments = req.body.adjustments;
  hr.recompute(slip);
  await slip.save();
  run.totals = hr.totalsOf(await M.Payslip.find({ run: run._id }));
  await run.save();
  res.json(slip);
});

payroll.post('/runs/:id/finalize', authorize('hr', 'u'), async (req, res) => {
  const run = await M.PayrollRun.findOne({ _id: req.params.id, company: req.companyId });
  if (!run) throw new HttpError(404, 'Payroll run not found');
  if (run.status !== 'draft') throw new HttpError(409, `Run is already ${run.status}`);
  const slips = await M.Payslip.find({ run: run._id }).populate('employee', 'user');
  if (!slips.length) throw new HttpError(400, 'Run has no payslips');
  run.status = 'finalized';
  run.finalizedAt = new Date();
  await run.save();
  await Promise.all(slips.map((s) => notify(req.companyId, s.employee?.user, `Payslip ready — ${run.month}`, `Net pay ${s.netPay}`)));
  res.json(run);
});

payroll.post('/runs/:id/paid', authorize('hr', 'u'), async (req, res) => {
  const run = await M.PayrollRun.findOne({ _id: req.params.id, company: req.companyId });
  if (!run) throw new HttpError(404, 'Payroll run not found');
  if (run.status !== 'finalized') throw new HttpError(409, 'Finalize the run before marking it paid');
  run.status = 'paid';
  run.paidAt = new Date();
  await run.save();
  res.json(run);
});

payroll.delete('/runs/:id', authorize('hr', 'd'), async (req, res) => {
  const run = await M.PayrollRun.findOne({ _id: req.params.id, company: req.companyId });
  if (!run) throw new HttpError(404, 'Payroll run not found');
  if (run.status !== 'draft') throw new HttpError(409, 'Only draft runs can be deleted');
  await M.Payslip.deleteMany({ run: run._id });
  await run.deleteOne();
  res.status(204).end();
});

// Bank transfer sheet.
payroll.get('/runs/:id/export', authorize('hr', 'r'), async (req, res) => {
  const run = await M.PayrollRun.findOne({ _id: req.params.id, company: req.companyId });
  if (!run) throw new HttpError(404, 'Payroll run not found');
  const slips = await M.Payslip.find({ run: run._id }).populate('employee', 'bank');
  const rows = slips.map((s) => ({ code: s.snapshot.employeeCode, name: s.snapshot.name, department: s.snapshot.department, account: s.employee?.bank?.account, ifsc: s.employee?.bank?.ifsc, gross: s.gross, lossOfPay: s.lossOfPay, pf: s.pf, tax: s.tax, netPay: s.netPay }));
  res.type('text/csv').attachment(`payroll-${run.month}.csv`).send(toCsv(rows, ['code', 'name', 'department', 'account', 'ifsc', 'gross', 'lossOfPay', 'pf', 'tax', 'netPay']));
});

payroll.get('/payslips/:id', authorize('hr', 'r'), async (req, res) => {
  const s = await M.Payslip.findOne({ _id: req.params.id, company: req.companyId }).populate('employee', 'bank joinDate');
  if (!s) throw new HttpError(404, 'Payslip not found');
  res.json(s);
});
router.use('/payroll', payroll);

// ---------------- Settings ----------------
const settingsSchema = z.object({
  shiftStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), graceMinutes: z.number().int().min(0).max(180), fullDayHours: z.number().min(1).max(24),
  weekOff: z.array(z.number().int().min(0).max(6)).max(6), tzOffsetMinutes: z.number().int().min(-720).max(840),
  quotas: z.object({ casual: z.number().min(0).max(60), sick: z.number().min(0).max(60), earned: z.number().min(0).max(60) }),
  pfRate: z.number().min(0).max(100), taxRate: z.number().min(0).max(60),
}).partial();

router.get('/settings', authorize('hr', 'r'), async (req, res) => res.json(await hr.getSettings(req.companyId)));
router.patch('/settings', authorize('hr', 'u'), audit('hr'), validate(settingsSchema), async (req, res) => {
  const co = await M.Company.findById(req.companyId);
  co.settings = { ...(co.settings || {}), hr: { ...(co.settings?.hr || {}), ...req.body } };
  co.markModified('settings');
  await co.save();
  res.json(await hr.getSettings(req.companyId));
});

// ---------------- Overview ----------------
router.get('/overview', authorize('hr', 'r'), async (req, res) => {
  const co = req.companyId;
  const settings = await hr.getSettings(co);
  const todayMs = hr.localDayMs(new Date(), settings.tzOffsetMinutes);
  const [headcount, rows, pendingLeaves, depts, joiners, lastRun] = await Promise.all([
    M.Employee.countDocuments({ company: co, status: 'active' }),
    M.Attendance.find({ company: co, date: new Date(todayMs) }),
    M.LeaveRequest.countDocuments({ company: co, status: 'pending' }),
    M.Employee.aggregate([{ $match: { company: co, status: 'active' } }, { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    M.Employee.find({ company: co, joinDate: { $gte: new Date(todayMs - 30 * DAY) } }).select('name designation joinDate').sort('-joinDate').limit(5),
    M.PayrollRun.findOne({ company: co }).sort('-month'),
  ]);
  const holidays = await hr.holidaySetFor(co, todayMs, todayMs + DAY);
  const working = hr.isWorkingDay(todayMs, settings, holidays);
  const marked = new Set(rows.map((r) => String(r.employee)));
  const cnt = (f) => rows.filter(f).length;
  // 14-day trend
  const from = todayMs - 13 * DAY;
  const hol14 = await hr.holidaySetFor(co, from, todayMs + DAY);
  const att14 = await M.Attendance.aggregate([{ $match: { company: co, date: { $gte: new Date(from), $lte: new Date(todayMs) } } }, { $group: { _id: { d: '$date', s: '$status' }, n: { $sum: 1 } } }]);
  const trend = Array.from({ length: 14 }, (_, i) => {
    const d = from + i * DAY, k = iso(d);
    const g = (s) => att14.find((a) => iso(a._id.d) === k && a._id.s === s)?.n || 0;
    return { date: k, working: hr.isWorkingDay(d, settings, hol14), present: g('present') + g('half_day'), leave: g('leave') };
  });
  const bdays = (await M.Employee.find({ company: co, status: 'active', birthday: { $ne: null } }).select('name birthday')).filter((e) => e.birthday.getUTCMonth() === new Date(todayMs).getUTCMonth()).sort((a, b) => a.birthday.getUTCDate() - b.birthday.getUTCDate());
  res.json({
    today: iso(todayMs), workingDay: working, headcount,
    attendance: { present: cnt((r) => r.status === 'present'), halfDay: cnt((r) => r.status === 'half_day'), onLeave: cnt((r) => r.status === 'leave'), late: cnt((r) => r.late), notMarked: working ? Math.max(0, headcount - marked.size) : 0 },
    pendingLeaves, departments: depts.map((d) => ({ department: d._id, count: d.n })), trend, newJoiners: joiners,
    upcomingHolidays: await M.Holiday.find({ company: co, date: { $gte: new Date(todayMs) } }).sort('date').limit(4).select('date name'),
    birthdays: bdays.map((e) => ({ name: e.name, day: e.birthday.getUTCDate() })),
    lastPayroll: lastRun && { month: lastRun.month, status: lastRun.status, totals: lastRun.totals },
  });
});

module.exports = router;
