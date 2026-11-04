// Admin > Error Log: records failures with what is needed to trace them (request, user, stack, context).
// Never throws: the database itself may be what is failing.
const crypto = require('crypto');
const { ErrorLog } = require('../models');

const SECRET = /pass|token|secret|key|auth|credential|signature|cookie|otp/i;
const REPEAT_MS = 10 * 60e3; // the same error again within 10 minutes bumps the count instead of adding a row

// Copies a value for the log: secrets masked, long strings and big objects cut down.
function scrub(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
  if (depth > 4) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, SECRET.test(k) ? '••••' : scrub(x, depth + 1)]));
  return String(v);
}

const fingerprint = (parts) => crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex');

async function record({ source = 'api', company, user, requestId, status, method, path, route, message, stack, context }) {
  try {
    const msg = String(message || 'Unknown error').slice(0, 2000);
    // Record ids and numbers differ between repeats of the same error, so they are left out of the fingerprint.
    const fp = fingerprint([company, source, status, method, route || path, msg.replace(/[a-f\d]{24}|\d+/gi, '#')]);
    const now = new Date();
    const ctx = context && scrub(context);
    const hit = await ErrorLog.findOneAndUpdate(
      { fingerprint: fp, lastSeenAt: { $gte: new Date(now - REPEAT_MS) } },
      { $inc: { count: 1 }, $set: { lastSeenAt: now, resolved: false, ...(user && { user }), ...(ctx && { context: ctx }) }, ...(requestId && { $push: { requestIds: { $each: [requestId], $slice: -20 } } }) },
      { returnDocument: 'after' },
    );
    if (hit) return hit;
    return await ErrorLog.create({
      company, user, source, requestIds: requestId ? [requestId] : [], status, method, path: path && String(path).slice(0, 500),
      message: msg, stack: stack && String(stack).slice(0, 8000), context: ctx, fingerprint: fp, lastSeenAt: now,
    });
  } catch {
    return null;
  }
}

// A request that failed: 5xx, or 424 when Twilio / Meta / Google refused the call.
function fromRequest(req, err, status) {
  return record({
    source: req.originalUrl.startsWith('/api/webhooks/') ? 'webhook' : status === 424 ? 'integration' : 'api',
    company: req.companyId, user: req.user?._id, requestId: req.id, status, method: req.method,
    path: req.originalUrl.split('?')[0], route: req.route ? req.baseUrl + req.route.path : undefined,
    message: err.message, stack: err.stack,
    context: { query: req.query, params: req.params, body: req.body, details: err.details, ip: req.ip, userAgent: req.get('user-agent'), role: req.user?.role },
  });
}

// Work outside a request: scheduler jobs, ad sync, webhook processing after the provider got its reply.
function background(source, label, err, { company, context } = {}) {
  return record({ source, company, path: label, message: err?.message || String(err), stack: err?.stack, context });
}

module.exports = { record, fromRequest, background, scrub };
