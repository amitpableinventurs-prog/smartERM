/**
 * Platform owner console API (/api/owner). The owner sits above every company: creates clients, assigns
 * modules, sets licence limits, suspends, manages custom domains and desktop installs, and can open any
 * client's panel. Owner tokens carry aud=owner and are rejected by the normal company API.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../config');
const M = require('../models');
const { validate } = require('../middleware/common');
const { HttpError } = require('../utils/helpers');
const { MODULES, MODULE_KEYS, accessProblem } = require('../modules');
const tenants = require('../services/tenants');
const { issue } = require('./auth');

const router = express.Router();

// ---- auth ----
const signOwner = (o) => jwt.sign({ sub: String(o._id) }, config.jwt.accessSecret, { audience: 'owner', expiresIn: config.ownerTokenTtl });

async function ownerAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  let payload;
  try { payload = jwt.verify(h.slice(7), config.jwt.accessSecret, { audience: 'owner' }); } catch { throw new HttpError(401, 'Owner sign-in required'); }
  const owner = await M.Owner.findById(payload.sub);
  if (!owner || !owner.active) throw new HttpError(401, 'Owner sign-in required');
  req.owner = owner;
  next();
}

router.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), async (req, res) => {
  const o = await M.Owner.findOne({ email: req.body.email.toLowerCase() }).select('+password');
  if (!o || !o.active || !(await bcrypt.compare(req.body.password, o.password))) throw new HttpError(401, 'Invalid credentials');
  res.json({ token: signOwner(o), owner: { name: o.name, email: o.email } });
});

router.use(ownerAuth);

router.get('/me', (req, res) => res.json({ name: req.owner.name, email: req.owner.email }));

router.post('/change-password', validate(z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) })), async (req, res) => {
  const o = await M.Owner.findById(req.owner._id).select('+password');
  if (!(await bcrypt.compare(req.body.currentPassword, o.password))) throw new HttpError(401, 'Current password is wrong');
  o.password = await bcrypt.hash(req.body.newPassword, 10);
  await o.save();
  res.status(204).end();
});

// ---- companies ----
const blankToNull = (v) => (v === '' ? null : v);
const licence = {
  modules: z.array(z.enum(MODULE_KEYS)).optional(),
  validUntil: z.preprocess(blankToNull, z.coerce.date().nullable()).optional(),
  maxUsers: z.preprocess(blankToNull, z.coerce.number().int().positive().nullable()).optional(),
  maxDevices: z.preprocess(blankToNull, z.coerce.number().int().positive().nullable()).optional(),
  branding: z.object({ appName: z.string().max(60).optional(), color: z.union([z.string().regex(/^#[0-9a-f]{6}$/i), z.literal('')]).optional() }).optional(),
};

async function findCompany(id) {
  const co = await M.Company.findById(id);
  if (!co) throw new HttpError(404, 'Company not found');
  return co;
}

const summary = (c, users = 0, devices = 0) => ({
  id: c._id, name: c.name, status: c.status, suspendReason: c.suspendReason, problem: accessProblem(c),
  modules: c.modules ?? MODULE_KEYS, validUntil: c.validUntil, maxUsers: c.maxUsers, maxDevices: c.maxDevices,
  activationKey: c.activationKey, branding: c.branding || {}, createdAt: c.createdAt, users, devices,
  domains: (c.domains || []).map((d) => ({ host: d.host, verified: d.verified, verifiedAt: d.verifiedAt, records: tenants.dnsRecords(d) })),
});

const countBy = (Model, match) => Model.aggregate([{ $match: match }, { $group: { _id: '$company', n: { $sum: 1 } } }])
  .then((rows) => new Map(rows.map((r) => [String(r._id), r.n])));

router.get('/modules', (_req, res) => res.json(MODULE_KEYS.map((key) => ({ key, ...MODULES[key] }))));

router.get('/overview', async (_req, res) => {
  const cos = await M.Company.find().select('status validUntil modules').lean();
  const byModule = Object.fromEntries(MODULE_KEYS.map((k) => [k, cos.filter((c) => (c.modules ?? MODULE_KEYS).includes(k)).length]));
  res.json({
    companies: cos.length,
    active: cos.filter((c) => !accessProblem(c)).length,
    suspended: cos.filter((c) => c.status === 'suspended').length,
    expired: cos.filter((c) => c.status !== 'suspended' && accessProblem(c)).length,
    users: await M.User.countDocuments({ active: true }),
    devices: await M.Device.countDocuments({ revoked: false }),
    byModule,
  });
});

router.get('/companies', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const cos = await M.Company.find(q ? { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}).sort('-createdAt').lean();
  const ids = cos.map((c) => c._id);
  const [users, devices] = await Promise.all([
    countBy(M.User, { company: { $in: ids }, active: true }),
    countBy(M.Device, { company: { $in: ids }, revoked: false }),
  ]);
  res.json(cos.map((c) => summary(c, users.get(String(c._id)), devices.get(String(c._id)))));
});

router.post('/companies', validate(z.object({
  companyName: z.string().min(2), name: z.string().min(2), email: z.string().email(), password: z.string().min(8).max(128), ...licence,
})), async (req, res) => {
  const { company, user } = await tenants.createCompany(req.body);
  res.status(201).json({ ...summary(company, 1, 0), admin: { id: user._id, name: user.name, email: user.email } });
});

router.get('/companies/:id', async (req, res) => {
  const co = await findCompany(req.params.id);
  const [users, devices] = await Promise.all([
    M.User.find({ company: co._id }).select('name email role active createdAt').sort('name').lean(),
    M.Device.find({ company: co._id }).sort('-lastSeenAt').lean(),
  ]);
  res.json({ ...summary(co, users.filter((u) => u.active).length, devices.filter((d) => !d.revoked).length), userList: users, deviceList: devices });
});

router.patch('/companies/:id', validate(z.object({
  name: z.string().min(2).optional(), status: z.enum(['active', 'suspended']).optional(), suspendReason: z.string().max(200).optional(), ...licence,
}).strict()), async (req, res) => {
  const co = await findCompany(req.params.id);
  const suspending = req.body.status === 'suspended' && co.status !== 'suspended';
  co.set(req.body);
  await co.save();
  tenants.invalidate(co);
  // Stop outbound sending straight away; the client resumes these after reactivation.
  if (suspending) {
    await M.Broadcast.updateMany({ company: co._id, status: { $in: ['running', 'scheduled'] } }, { status: 'paused' });
    await M.Campaign.updateMany({ company: co._id, status: 'running' }, { status: 'paused' });
  }
  res.json(summary(co));
});

router.post('/companies/:id/activation-key', async (req, res) => {
  const co = await findCompany(req.params.id);
  co.activationKey = M.Company.schema.path('activationKey').defaultValue();
  await co.save();
  res.json({ activationKey: co.activationKey }); // already-activated computers keep working
});

// Opens the client's panel as their super admin (support / full control). Recorded in the client's audit log.
router.post('/companies/:id/login-as', async (req, res) => {
  const co = await findCompany(req.params.id);
  if (accessProblem(co)) throw new HttpError(409, `Reactivate the company first (${accessProblem(co)})`);
  const admin = await M.User.findOne({ company: co._id, role: 'super_admin', active: true }).sort('createdAt');
  if (!admin) throw new HttpError(404, 'This company has no active super admin');
  await M.AuditLog.create({ company: co._id, user: admin._id, method: 'POST', path: `owner login-as by ${req.owner.email}`, resource: 'owner', action: 'login_as', status: 200, ip: req.ip });
  res.json({ user: { id: admin._id, name: admin.name, email: admin.email, role: admin.role, company: co._id }, workspace: tenants.workspace(co), ...(await issue(admin)) });
});

// ---- custom domains ----
router.post('/companies/:id/domains', validate(z.object({ host: z.string() })), async (req, res) => {
  const co = await findCompany(req.params.id);
  const host = tenants.normalizeHost(req.body.host);
  if (host === tenants.primaryHost()) throw new HttpError(400, 'That is your main server address');
  if (await M.Company.exists({ _id: { $ne: co._id }, 'domains.host': host })) throw new HttpError(409, 'Another company already uses this domain');
  let d = co.domains.find((x) => x.host === host);
  if (!d) {
    co.domains.push({ host, token: tenants.newToken() });
    await co.save();
    d = co.domains.find((x) => x.host === host);
  }
  res.status(201).json({ host, verified: d.verified, records: tenants.dnsRecords(d) });
});

router.post('/companies/:id/domains/:host/verify', async (req, res) => {
  const co = await findCompany(req.params.id);
  const d = co.domains.find((x) => x.host === req.params.host.toLowerCase());
  if (!d) throw new HttpError(404, 'Domain not found');
  if (!(await tenants.checkTxt(d.host, d.token))) {
    throw new HttpError(400, `TXT record not found at ${tenants.dnsRecords(d)[1].name}. DNS changes can take up to an hour; try again later.`);
  }
  d.verified = true;
  d.verifiedAt = new Date();
  await co.save();
  tenants.invalidate(co);
  res.json({ host: d.host, verified: true, records: tenants.dnsRecords(d) });
});

router.delete('/companies/:id/domains/:host', async (req, res) => {
  const co = await findCompany(req.params.id);
  co.domains = co.domains.filter((x) => x.host !== req.params.host.toLowerCase());
  await co.save();
  tenants.invalidate(co);
  res.status(204).end();
});

// ---- desktop installs ----
router.patch('/devices/:id', validate(z.object({ revoked: z.boolean() })), async (req, res) => {
  const d = await M.Device.findByIdAndUpdate(req.params.id, { revoked: req.body.revoked }, { returnDocument: 'after' });
  if (!d) throw new HttpError(404, 'Device not found');
  res.json(d);
});

router.delete('/devices/:id', async (req, res) => {
  await M.Device.deleteOne({ _id: req.params.id });
  res.status(204).end();
});

// Newest Windows installer in the downloads folder (put there by `npm run desktop:build`).
router.get('/installer', (_req, res) => {
  let files = [];
  try { files = fs.readdirSync(config.downloadsDir).filter((f) => f.toLowerCase().endsWith('.exe')); } catch { /* folder not created yet */ }
  const newest = files.map((f) => ({ f, s: fs.statSync(path.join(config.downloadsDir, f)) })).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)[0];
  res.json(newest ? { available: true, file: newest.f, url: `/downloads/${encodeURIComponent(newest.f)}`, size: newest.s.size, builtAt: newest.s.mtime } : { available: false });
});

module.exports = router;
