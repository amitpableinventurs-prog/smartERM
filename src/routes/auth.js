const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../config');
const { Company, User, Pipeline } = require('../models');
const { validate } = require('../middleware/common');
const { authenticate, signAccess, signRefresh } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');

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

router.post(
  '/register',
  validate(z.object({ companyName: z.string().min(2), name: z.string().min(2), email: z.string().email(), password: passwordRule })),
  async (req, res) => {
    const { companyName, name, email, password } = req.body;
    if (await User.exists({ email: email.toLowerCase() })) throw new HttpError(409, 'Email already registered');
    const company = await Company.create({ name: companyName });
    await Pipeline.create({
      company: company._id, name: 'Default Sales Pipeline', isDefault: true,
      stages: ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost'],
    });
    const user = await User.create({ company: company._id, name, email, password: await bcrypt.hash(password, 10), role: 'super_admin' });
    res.status(201).json({ user: publicUser(user), company: { id: company._id, name: company.name, apiKey: company.apiKey }, ...(await issue(user)) });
  }
);

router.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+password');
  // Same message for unknown user and wrong password.
  if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.password))) throw new HttpError(401, 'Invalid credentials');
  res.json({ user: publicUser(user), ...(await issue(user)) });
});

// Refresh-token rotation: each token works once; reuse of an old one is rejected.
router.post('/refresh', validate(z.object({ refreshToken: z.string() })), async (req, res) => {
  let payload;
  try { payload = jwt.verify(req.body.refreshToken, config.jwt.refreshSecret); } catch { throw new HttpError(401, 'Invalid refresh token'); }
  const h = hash(req.body.refreshToken);
  const user = await User.findOneAndUpdate({ _id: payload.sub, active: true, refreshTokens: h }, { $pull: { refreshTokens: h } }, { returnDocument: 'after' });
  if (!user) throw new HttpError(401, 'Refresh token revoked');
  res.json(await issue(user));
});

router.post('/logout', validate(z.object({ refreshToken: z.string() })), async (req, res) => {
  await User.updateOne({ refreshTokens: hash(req.body.refreshToken) }, { $pull: { refreshTokens: hash(req.body.refreshToken) } });
  res.status(204).end();
});

router.get('/me', authenticate, (req, res) => res.json(publicUser(req.user)));

router.post('/change-password', authenticate, validate(z.object({ currentPassword: z.string(), newPassword: passwordRule })), async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await bcrypt.compare(req.body.currentPassword, user.password))) throw new HttpError(401, 'Current password is wrong');
  user.password = await bcrypt.hash(req.body.newPassword, 10);
  user.refreshTokens = []; // sign out everywhere
  await user.save();
  res.status(204).end();
});

module.exports = router;
