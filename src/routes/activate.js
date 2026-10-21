/**
 * Desktop app licensing (/api/activate). A computer is activated once with the company's activation key and
 * gets a device secret; every launch then checks in with that secret, so the owner can suspend a company,
 * change its modules or revoke a single computer. Rotating the activation key does not affect activated computers.
 */
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const M = require('../models');
const config = require('../config');
const { validate } = require('../middleware/common');
const { HttpError } = require('../utils/helpers');
const { accessProblem } = require('../modules');
const tenants = require('../services/tenants');

const router = express.Router();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const info = (co) => ({ ...tenants.workspace(co), offlineGraceDays: config.offlineGraceDays });

router.post('/', validate(z.object({
  key: z.string().min(4).max(40), deviceId: z.string().min(8).max(100),
  deviceName: z.string().max(100).optional(), platform: z.string().max(40).optional(), appVersion: z.string().max(20).optional(),
})), async (req, res) => {
  const co = await M.Company.findOne({ activationKey: req.body.key.trim().toUpperCase() });
  if (!co) throw new HttpError(404, 'Activation key not recognised. Check it with your provider.');
  const problem = accessProblem(co);
  if (problem) throw new HttpError(403, problem, { code: 'company_blocked' });

  const existing = await M.Device.findOne({ company: co._id, deviceId: req.body.deviceId });
  if (existing?.revoked) throw new HttpError(403, 'This computer has been deactivated. Contact your provider.', { code: 'device_revoked' });
  if (!existing && co.maxDevices && (await M.Device.countDocuments({ company: co._id, revoked: false })) >= co.maxDevices) {
    throw new HttpError(403, `Your plan allows ${co.maxDevices} computers. Ask your provider to free a slot.`);
  }
  const deviceSecret = crypto.randomBytes(32).toString('hex');
  await M.Device.updateOne(
    { company: co._id, deviceId: req.body.deviceId },
    { name: req.body.deviceName, platform: req.body.platform, appVersion: req.body.appVersion, secretHash: sha(deviceSecret), lastSeenAt: new Date(), lastIp: req.ip },
    { upsert: true }
  );
  res.status(201).json({ deviceSecret, company: info(co) });
});

// Called by the desktop app at launch and every 30 minutes. Always answers 200 with a status the app acts on.
router.post('/check', validate(z.object({
  companyId: z.string(), deviceId: z.string(), deviceSecret: z.string(), appVersion: z.string().max(20).optional(),
})), async (req, res) => {
  const { companyId, deviceId, deviceSecret } = req.body;
  const device = /^[a-f0-9]{24}$/.test(companyId) && (await M.Device.findOne({ company: companyId, deviceId }).select('+secretHash'));
  if (!device || device.secretHash !== sha(deviceSecret)) return res.json({ status: 'unknown', message: 'This computer is not activated. Enter your activation key.' });
  if (device.revoked) return res.json({ status: 'revoked', message: 'This computer has been deactivated. Contact your provider.' });
  const co = await tenants.getCompany(companyId);
  const problem = accessProblem(co);
  device.lastSeenAt = new Date();
  device.lastIp = req.ip;
  if (req.body.appVersion) device.appVersion = req.body.appVersion;
  await device.save();
  if (problem) return res.json({ status: 'blocked', message: problem });
  res.json({ status: 'ok', company: info(co) });
});

module.exports = router;
