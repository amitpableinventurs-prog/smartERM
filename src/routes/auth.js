const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../config');
const { User, Device } = require('../models');
const { validate } = require('../middleware/common');
const { authenticate, signAccess, signRefresh } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');
const { accessProblem } = require('../modules');
const tenants = require('../services/tenants');

const router = express.Router();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const MAX_SESSIONS = 5;

async function issue(user) {
  const refreshToken = signRefresh(user);
  // Only a hash of the refresh token is stored; the newest MAX_SESSIONS are kept.
  await User.updateOne({ _id: user._id }, { $push: { refreshTokens: { $each: [hash(refreshToken)], $slice: -MAX_SESSIONS } } });
  return { accessToken: signAccess(user), refreshToken };
}

const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, company: u.company, branch: u.branch });

const passwordRule = z.string().min(8).max(128);

// Stops sign-in for suspended/expired companies and for desktop installs the owner revoked.
async function assertCanSignIn(req, user) {
  const co = await tenants.getCompany(user.company);
  const problem = accessProblem(co);
  if (problem) throw new HttpError(403, problem, { code: 'company_blocked' });
  const deviceId = req.get('x-device-id');
  if (deviceId && (await Device.exists({ company: user.company, deviceId, revoked: true }))) {
    throw new HttpError(403, 'This computer has been deactivated. Contact your provider.', { code: 'device_revoked' });
  }
  return co;
}

router.post(
  '/register',
  validate(z.object({ companyName: z.string().min(2), name: z.string().min(2), email: z.string().email(), password: passwordRule })),
  async (req, res) => {
    // With ALLOW_SIGNUP=false only the platform owner creates companies (owner console).
    if (!config.allowSignup || (await tenants.tenantForHost(req.hostname))) throw new HttpError(403, 'Sign-up is disabled. Contact your provider for an account.');
    const { company, user } = await tenants.createCompany(req.body);
    res.status(201).json({ user: publicUser(user), workspace: tenants.workspace(company), company: { id: company._id, name: company.name, apiKey: company.apiKey }, ...(await issue(user)) });
  }
);

router.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+password');
  // Same message for unknown user and wrong password.
  if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.password))) throw new HttpError(401, 'Invalid credentials');
  // On a client's own domain only that client's users can sign in.
  const tenant = await tenants.tenantForHost(req.hostname);
  if (tenant && String(tenant._id) !== String(user.company)) throw new HttpError(401, 'Invalid credentials');
  const co = await assertCanSignIn(req, user);
  res.json({ user: publicUser(user), workspace: tenants.workspace(co), ...(await issue(user)) });
});

// Refresh-token rotation: each token works once; reuse of an old one is rejected.
router.post('/refresh', validate(z.object({ refreshToken: z.string() })), async (req, res) => {
  let payload;
  try { payload = jwt.verify(req.body.refreshToken, config.jwt.refreshSecret); } catch { throw new HttpError(401, 'Invalid refresh token'); }
  const h = hash(req.body.refreshToken);
  const user = await User.findOneAndUpdate({ _id: payload.sub, active: true, refreshTokens: h }, { $pull: { refreshTokens: h } }, { returnDocument: 'after' });
  if (!user) throw new HttpError(401, 'Refresh token revoked');
  await assertCanSignIn(req, user);
  res.json(await issue(user));
});

router.post('/logout', validate(z.object({ refreshToken: z.string() })), async (req, res) => {
  await User.updateOne({ refreshTokens: hash(req.body.refreshToken) }, { $pull: { refreshTokens: hash(req.body.refreshToken) } });
  res.status(204).end();
});

router.get('/me', authenticate, (req, res) => res.json({ ...publicUser(req.user), workspace: tenants.workspace(req.company) }));

router.post('/change-password', authenticate, validate(z.object({ currentPassword: z.string(), newPassword: passwordRule })), async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await bcrypt.compare(req.body.currentPassword, user.password))) throw new HttpError(401, 'Current password is wrong');
  user.password = await bcrypt.hash(req.body.newPassword, 10);
  user.refreshTokens = []; // sign out everywhere
  await user.save();
  res.status(204).end();
});

module.exports = router;
module.exports.issue = issue;
