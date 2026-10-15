const { z } = require('zod');
const M = require('../models');
const { crud } = require('../utils/crud');
const { authorize, scopeFilter } = require('../middleware/auth');
const { validate } = require('../middleware/common');
const { HttpError, render } = require('../utils/helpers');
const comm = require('../services/communication');
const { logActivity } = require('../services/events');
const ai = require('../services/ai');

const KINDS = { Lead: M.Lead, Customer: M.Customer };

// ---- Communications log ----
const c = crud({
  Model: M.Communication,
  resource: 'communications',
  filters: ['channel', 'direction', 'status', 'relatedTo.id', 'campaign'],
  scope: false,
  hooks: {
    // The generic POST only logs calls and notes; email/WhatsApp/SMS must go through /send so they are really delivered.
    beforeCreate(req, data) {
      if (!['call', 'note'].includes(data.channel)) throw new HttpError(400, 'Use POST /communications/send for email, whatsapp and sms');
      data.direction = 'outbound';
      data.by = req.user._id;
    },
  },
});

const sendSchema = z.object({
  channel: z.enum(['email', 'whatsapp', 'sms']),
  kind: z.enum(['Lead', 'Customer']),
  id: z.string().length(24),
  templateId: z.string().length(24).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
});

c.router.post('/send', authorize('communications', 'c'), validate(sendSchema), async (req, res) => {
  const { channel, kind, id, templateId } = req.body;
  const person = await KINDS[kind].findOne({ _id: id, company: req.companyId, ...scopeFilter(req, kind === 'Lead' ? 'leads' : 'customers') });
  if (!person) throw new HttpError(404, `${kind} not found`);
  let { subject, body } = req.body;
  if (templateId) {
    const t = await M.Template.findOne({ _id: templateId, company: req.companyId });
    if (!t) throw new HttpError(404, 'Template not found');
    if (t.channel !== channel) throw new HttpError(400, `Template is for ${t.channel}`);
    ({ subject, body } = t);
  }
  if (!body) throw new HttpError(400, 'body or templateId is required');
  const ctx = { person, lead: person, customer: person, user: req.user };
  let msg;
  try {
    msg = await comm.send({
      company: req.companyId, channel, to: comm.addressFor(channel, person), subject: render(subject, ctx), body: render(body, ctx),
      relatedTo: { kind, id: person._id }, by: req.user._id,
    });
  } catch (e) {
    throw new HttpError(/opted out/i.test(e.message) ? 409 : 502, `Delivery failed: ${e.message}`);
  }
  const now = new Date();
  if (kind === 'Lead') {
    person.lastContactedAt = now;
    if (person.status === 'new') person.status = 'contacted';
  } else {
    person.lastActivityAt = now;
    if (person.lifecycle === 'at_risk') person.lifecycle = 'active';
  }
  await person.save();
  await logActivity(req.companyId, { kind, id: person._id }, `${channel}.sent`, subject || body.slice(0, 80), null, req.user._id);
  res.status(201).json(msg);
});

// Run sentiment + summary on a stored message/call transcript and save the result.
c.router.post('/:id/analyze', authorize('communications', 'r'), async (req, res) => {
  const m = await c.find(req);
  const text = m.body || '';
  if (!text) throw new HttpError(400, 'Message has no body to analyze');
  const [s, sum] = await Promise.all([ai.sentiment(text), ai.summarize(text)]);
  m.sentiment = s.sentiment;
  m.summary = sum.text;
  await m.save();
  res.json({ sentiment: s.sentiment, confidence: s.confidence, summary: sum.text, engine: s.engine });
});

module.exports = c.finish();

// ---- Templates ----
const t = crud({ Model: M.Template, resource: 'templates', search: ['name'], filters: ['channel'], scope: false });
module.exports.templates = t.finish();
