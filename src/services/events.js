const crypto = require('crypto');
const { Activity, Notification, Webhook } = require('../models');
const { accessProblem } = require('../modules');
const tenants = require('./tenants');
const errorlog = require('./errorlog');

const logActivity = (company, entity, type, message, meta, by) =>
  Activity.create({ company, entity, type, message, meta, by }).catch(() => {});

const notify = (company, user, title, body, link) =>
  user ? Notification.create({ company, user, title, body, link }).catch(() => {}) : null;

async function pushOutboundWebhooks(company, event, payload) {
  const hooks = await Webhook.find({ company, active: true, $or: [{ events: event }, { events: '*' }] });
  const body = JSON.stringify({ event, data: payload, at: new Date().toISOString() });
  await Promise.allSettled(
    hooks.map((h) =>
      fetch(h.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CRM-Event': event,
          ...(h.secret ? { 'X-CRM-Signature': crypto.createHmac('sha256', h.secret).update(body).digest('hex') } : {}),
        },
        body,
        signal: AbortSignal.timeout(5000),
      })
    )
  );
}

// Fire-and-forget: feeds the automation engine and outbound webhooks. Never throws into the request path.
async function emit(company, event, entity, payload = {}) {
  const automation = require('./automation'); // lazy: automation depends on this module
  // Suspended/expired companies: no automation and no outbound webhooks (scheduler events still fire for them).
  if (accessProblem(await tenants.getCompany(company).catch(() => null))) return;
  return Promise.allSettled([
    automation.trigger(company, event, entity, payload),
    pushOutboundWebhooks(company, event, { entity, ...payload }),
  ]).then((r) => r.forEach((x) => {
    if (x.status !== 'rejected') return;
    console.error(`[emit ${event}]`, x.reason?.message);
    errorlog.background('automation', `event ${event}`, x.reason, { company, context: { entity, payload } });
  }));
}

module.exports = { logActivity, notify, emit };
