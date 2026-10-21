const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { z } = require('zod');
const M = require('../models');
const { crud, clean } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { validate, audit } = require('../middleware/common');
const { HttpError } = require('../utils/helpers');
const tenants = require('../services/tenants');

// ---- Users ----
const users = express.Router();
users.use(audit('users'));

const ADMIN_ROLES = ['super_admin', 'admin'];

// Seat limit set by the platform owner (company.maxUsers); only active users count.
async function assertSeatFree(req) {
  const max = req.company?.maxUsers;
  if (max && (await M.User.countDocuments({ company: req.companyId, active: true })) >= max) {
    throw new HttpError(403, `Your plan allows ${max} active users. Deactivate a user or contact your provider.`);
  }
}
// Admins may manage everyone except super admins; only a super admin can mint admins.
function assertCanGrant(actor, role) {
  if (role === 'super_admin' && actor.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can grant super_admin');
  if (role === 'admin' && actor.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can grant admin');
}

users.get('/', authorize('users', 'r'), async (req, res) => {
  const f = { company: req.companyId };
  if (req.query.role) f.role = req.query.role;
  res.json(await M.User.find(f).select('name email role branch active createdAt').sort('name'));
});

users.post('/', authorize('users', 'c'), validate(z.object({
  name: z.string().min(2), email: z.string().email(), password: z.string().min(8).max(128),
  role: z.enum(M.ROLES).default('sales'), branch: z.string().optional(),
})), async (req, res) => {
  assertCanGrant(req.user, req.body.role);
  if (await M.User.exists({ email: req.body.email.toLowerCase() })) throw new HttpError(409, 'Email already registered');
  await assertSeatFree(req);
  const u = await M.User.create({ ...req.body, password: await bcrypt.hash(req.body.password, 10), company: req.companyId });
  res.status(201).json({ id: u._id, name: u.name, email: u.email, role: u.role, branch: u.branch });
});

users.patch('/:id', authorize('users', 'u'), validate(z.object({
  name: z.string().min(2).optional(), role: z.enum(M.ROLES).optional(), branch: z.string().optional(),
  active: z.boolean().optional(), password: z.string().min(8).max(128).optional(), fcmToken: z.string().optional(),
}).strict()), async (req, res) => {
  const u = await M.User.findOne({ _id: req.params.id, company: req.companyId });
  if (!u) throw new HttpError(404, 'User not found');
  if (ADMIN_ROLES.includes(u.role) && req.user.role !== 'super_admin' && String(u._id) !== String(req.user._id)) throw new HttpError(403, 'Cannot modify an admin');
  if (req.body.role) assertCanGrant(req.user, req.body.role);
  if (String(u._id) === String(req.user._id) && (req.body.role || req.body.active === false)) throw new HttpError(400, 'You cannot change your own role or deactivate yourself');
  if (req.body.active === true && !u.active) await assertSeatFree(req);
  const { password, ...rest } = req.body;
  u.set(rest);
  if (password) { u.password = await bcrypt.hash(password, 10); u.refreshTokens = []; }
  if (req.body.active === false) u.refreshTokens = [];
  await u.save();
  res.json({ id: u._id, name: u.name, email: u.email, role: u.role, active: u.active, branch: u.branch });
});

// ---- Company ----
const company = express.Router();
company.use(audit('company'));
company.get('/', authorize('company', 'r'), async (req, res) => {
  const co = await M.Company.findById(req.companyId);
  res.json({
    id: co._id, name: co.name, branches: co.branches, settings: co.settings, apiKey: ['super_admin', 'admin'].includes(req.user.role) ? co.apiKey : undefined,
    // Read-only here: the platform owner sets these.
    licence: { modules: co.modules, validUntil: co.validUntil, maxUsers: co.maxUsers, maxDevices: co.maxDevices, domains: co.domains.filter((d) => d.verified).map((d) => d.host) },
  });
});
company.patch('/', authorize('company', 'u'), async (req, res) => {
  const co = await M.Company.findById(req.companyId);
  co.set(clean({ name: req.body.name, branches: req.body.branches, settings: req.body.settings }));
  await co.save();
  tenants.invalidate(co);
  res.json(co);
});
company.post('/rotate-api-key', authorize('company', 'u'), async (req, res) => {
  const co = await M.Company.findById(req.companyId);
  co.apiKey = crypto.randomBytes(24).toString('hex');
  await co.save();
  res.json({ apiKey: co.apiKey });
});

// ---- Pipelines, outbound webhook subscriptions ----
const pipelines = crud({
  Model: M.Pipeline, resource: 'pipelines', scope: false,
  hooks: {
    async beforeCreate(req, d) { if (d.isDefault) await M.Pipeline.updateMany({ company: req.companyId }, { isDefault: false }); },
    async beforeUpdate(req, doc, d) { if (d.isDefault) await M.Pipeline.updateMany({ company: req.companyId }, { isDefault: false }); },
    async beforeDelete(req, doc) {
      if (doc.isDefault) throw new HttpError(409, 'Cannot delete the default pipeline');
      if (await M.Deal.exists({ pipeline: doc._id })) throw new HttpError(409, 'Pipeline still has deals');
    },
  },
}).finish();

const webhooks = crud({
  Model: M.Webhook, resource: 'webhooks', scope: false,
  hooks: {
    beforeCreate(req, d) {
      try { if (!/^https?:$/.test(new URL(d.url).protocol)) throw 0; } catch { throw new HttpError(400, 'url must be http(s)'); }
    },
  },
}).finish();

// ---- Audit log & notifications ----
const auditRouter = express.Router();
auditRouter.get('/', authorize('audit', 'r'), async (req, res) => {
  const page = Math.max(1, +req.query.page || 1);
  const f = { company: req.companyId };
  if (req.query.user) f.user = req.query.user;
  if (req.query.resource) f.resource = req.query.resource;
  const [data, total] = await Promise.all([
    M.AuditLog.find(f).sort('-createdAt').skip((page - 1) * 50).limit(50).populate('user', 'name'),
    M.AuditLog.countDocuments(f),
  ]);
  res.json({ data, page, total });
});

const notifications = express.Router();
notifications.get('/', authorize('notifications', 'r'), async (req, res) => {
  const f = { company: req.companyId, user: req.user._id };
  if (req.query.unread === 'true') f.read = false;
  res.json({ unread: await M.Notification.countDocuments({ ...f, read: false }), data: await M.Notification.find(f).sort('-createdAt').limit(50) });
});
notifications.post('/read-all', authorize('notifications', 'u'), async (req, res) => {
  await M.Notification.updateMany({ company: req.companyId, user: req.user._id, read: false }, { read: true });
  res.status(204).end();
});
notifications.post('/:id/read', authorize('notifications', 'u'), async (req, res) => {
  const n = await M.Notification.findOneAndUpdate({ _id: req.params.id, company: req.companyId, user: req.user._id }, { read: true }, { returnDocument: 'after' });
  if (!n) throw new HttpError(404, 'Notification not found');
  res.json(n);
});

module.exports = { users, company, pipelines, webhooks, auditRouter, notifications };
