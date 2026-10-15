/**
 * HR core logic: settings, calendar helpers, leave-day counting and payroll calculation.
 *
 * Payroll rule of thumb:
 *   paidDays   = present + half days * 0.5 + paid leave + (days still in the future)
 *   ratio      = paidDays / working days in the month   (working day = not a weekly off, not a holiday)
 *   earned     = gross * ratio;  lossOfPay = gross - earned
 *   pf         = basic * ratio * pfRate%;  tax = earned * taxRate%
 *   net        = earned - pf - tax - fixed other deductions + adjustments
 * Days before joining / after exit are never paid, so mid-month joiners are pro-rated automatically.
 */
const M = require('../models');

const DEFAULTS = {
  shiftStart: '09:30', graceMinutes: 15, fullDayHours: 8, weekOff: [0], tzOffsetMinutes: 330,
  quotas: { casual: 12, sick: 10, earned: 15 }, pfRate: 12, taxRate: 0,
};
const PAID_LEAVE_TYPES = ['casual', 'sick', 'earned'];
const DAY = 864e5;
const r2 = (n) => Math.round(n * 100) / 100;

async function getSettings(company) {
  const co = await M.Company.findById(company).select('settings');
  const hr = co?.settings?.hr || {};
  return { ...DEFAULTS, ...hr, quotas: { ...DEFAULTS.quotas, ...(hr.quotas || {}) } };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
// Midnight (UTC) of the calendar day a moment falls on in the company's timezone.
const localDayMs = (date, tzMin) => { const t = new Date(date.getTime() + tzMin * 60000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); };
const dayOnly = (d) => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };
const minutesOfDay = (date, tzMin) => { const t = new Date(date.getTime() + tzMin * 60000); return t.getUTCHours() * 60 + t.getUTCMinutes(); };

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  return { start, end: Date.UTC(y, m, 1), days: Math.round((Date.UTC(y, m, 1) - start) / DAY) };
}

const isWorkingDay = (ms, settings, holidaySet) => !settings.weekOff.includes(new Date(ms).getUTCDay()) && !holidaySet.has(iso(ms));

async function holidaySetFor(company, fromMs, toMs) {
  const rows = await M.Holiday.find({ company, date: { $gte: new Date(fromMs), $lt: new Date(toMs) } }).select('date');
  return new Set(rows.map((h) => iso(h.date)));
}

// Working days between two dates inclusive (used for leave length).
function countWorkingDays(fromMs, toMs, settings, holidaySet) {
  let n = 0;
  for (let d = fromMs; d <= toMs; d += DAY) if (isWorkingDay(d, settings, holidaySet)) n++;
  return n;
}

function isLate(checkIn, settings) {
  const [h, m] = settings.shiftStart.split(':').map(Number);
  return minutesOfDay(checkIn, settings.tzOffsetMinutes) > h * 60 + m + settings.graceMinutes;
}

// A day with enough hours is a full day, otherwise a half day.
function statusFromHours(hours, settings) { return hours >= settings.fullDayHours * 0.75 ? 'present' : 'half_day'; }

async function leaveBalances(company, employeeId, year, settings) {
  const from = new Date(Date.UTC(year, 0, 1)), to = new Date(Date.UTC(year + 1, 0, 1));
  const used = await M.LeaveRequest.aggregate([
    { $match: { company, employee: employeeId, status: { $in: ['approved', 'pending'] }, from: { $gte: from, $lt: to } } },
    { $group: { _id: { type: '$type', status: '$status' }, days: { $sum: '$days' } } },
  ]);
  const get = (t, s) => used.find((u) => u._id.type === t && u._id.status === s)?.days || 0;
  const out = {};
  for (const t of PAID_LEAVE_TYPES) {
    const quota = settings.quotas[t] ?? 0;
    out[t] = { quota, used: get(t, 'approved'), pending: get(t, 'pending'), available: r2(quota - get(t, 'approved') - get(t, 'pending')) };
  }
  out.unpaid = { used: get('unpaid', 'approved'), pending: get('unpaid', 'pending') };
  return out;
}

function recompute(slip) {
  const adj = (slip.adjustments || []).reduce((s, a) => s + (+a.amount || 0), 0);
  slip.netPay = Math.max(0, r2(slip.baseNet + adj));
  return slip;
}

/** Pure calculation for one employee-month. attendance = that employee's rows for the month. */
function computeSlip({ emp, month, settings, holidaySet, attendance, now = new Date() }) {
  const { start, days } = monthRange(month);
  const joinMs = emp.joinDate ? dayOnly(emp.joinDate) : -Infinity;
  const exitMs = emp.exitDate ? dayOnly(emp.exitDate) : Infinity;
  const todayMs = localDayMs(now, settings.tzOffsetMinutes);
  const att = new Map(attendance.map((a) => [iso(a.date), a]));
  let workingDays = 0, paid = 0, present = 0, half = 0, paidLeave = 0, unpaidLeave = 0, absent = 0, late = 0;

  for (let i = 0; i < days; i++) {
    const d = start + i * DAY;
    if (!isWorkingDay(d, settings, holidaySet)) continue;
    workingDays++;
    if (d < joinMs || d > exitMs) continue;
    if (d > todayMs) { paid++; continue; } // not happened yet: do not penalise
    const a = att.get(iso(d));
    if (!a) { absent++; continue; }
    if (a.status === 'present') { present++; paid++; if (a.late) late++; }
    else if (a.status === 'half_day') {
      half++; if (a.late) late++;
      if (a.leaveType && a.leaveType !== 'unpaid') paid += 1; // worked half + paid half-day leave
      else { paid += 0.5; absent += 0.5; }
    }
    else if (a.status === 'leave') { if (a.leaveType === 'unpaid') unpaidLeave++; else { paidLeave++; paid++; } }
    else if (a.status === 'holiday' || a.status === 'weekoff') paid++;
    else absent++;
  }

  const s = emp.salary || {};
  const gross = (s.basic || 0) + (s.hra || 0) + (s.allowances || 0);
  const ratio = workingDays ? paid / workingDays : 0;
  const earned = gross * ratio;
  const pf = (s.basic || 0) * ratio * (settings.pfRate / 100);
  const tax = earned * (settings.taxRate / 100);
  const otherDeductions = ratio > 0 ? s.otherDeductions || 0 : 0;
  const slip = {
    month, workingDays, paidDays: r2(paid), presentDays: present, halfDays: half, paidLeaveDays: paidLeave, unpaidLeaveDays: unpaidLeave,
    absentDays: r2(absent), lateMarks: late, gross: r2(gross), earned: r2(earned), lossOfPay: r2(gross - earned),
    pf: r2(pf), tax: r2(tax), otherDeductions: r2(otherDeductions), adjustments: [],
    baseNet: r2(earned - pf - tax - otherDeductions),
    snapshot: { name: emp.name, employeeCode: emp.employeeCode, department: emp.department, designation: emp.designation },
  };
  return recompute(slip);
}

async function buildRun({ company, month, userId, now }) {
  const settings = await getSettings(company);
  const { start, end } = monthRange(month);
  const holidaySet = await holidaySetFor(company, start, end);
  const emps = await M.Employee.find({ company, joinDate: { $lt: new Date(end) }, $or: [{ exitDate: null }, { exitDate: { $gte: new Date(start) } }] });
  const rows = await M.Attendance.find({ company, date: { $gte: new Date(start), $lt: new Date(end) } });
  const byEmp = new Map();
  for (const r of rows) { const k = String(r.employee); (byEmp.get(k) || byEmp.set(k, []).get(k)).push(r); }

  const run = await M.PayrollRun.create({ company, month, createdBy: userId });
  const slips = emps
    .filter((e) => e.status !== 'inactive' || byEmp.has(String(e._id)))
    .map((e) => ({ company, run: run._id, employee: e._id, ...computeSlip({ emp: e, month, settings, holidaySet, attendance: byEmp.get(String(e._id)) || [], now }) }));
  if (slips.length) await M.Payslip.insertMany(slips);
  run.totals = totalsOf(slips);
  await run.save();
  return run;
}

function totalsOf(slips) {
  const sum = (k) => r2(slips.reduce((s, x) => s + (x[k] || 0), 0));
  return { employees: slips.length, gross: sum('gross'), earned: sum('earned'), lossOfPay: sum('lossOfPay'), pf: sum('pf'), tax: sum('tax'), otherDeductions: sum('otherDeductions'), netPay: sum('netPay') };
}

module.exports = {
  DEFAULTS, PAID_LEAVE_TYPES, getSettings, iso, localDayMs, dayOnly, monthRange, isWorkingDay, holidaySetFor, countWorkingDays,
  isLate, statusFromHours, leaveBalances, computeSlip, recompute, buildRun, totalsOf, DAY, r2,
};
