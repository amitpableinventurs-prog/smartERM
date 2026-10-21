// Public endpoints: website forms and WhatsApp/email providers push data in here.
const express = require('express');
const crypto = require('crypto');
const M = require('../models');
const config = require('../config');
const { HttpError } = require('../utils/helpers');
const { accessProblem } = require('../modules');
const { logActivity, emit } = require('../services/events');
const ai = require('../services/ai');
const inbox = require('../services/inbox');

const router = express.Router();

const safeEqual = (a = '', b = '') => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function companyFromKey(key) {
  const co = key && (await M.Company.findOne({ apiKey: String(key) }));
  if (!co) throw new HttpError(401, 'Invalid API key');
  if (accessProblem(co)) throw new HttpError(403, 'Account suspended');
  return co;
}

function requireSecret(req) {
  if (!safeEqual(req.get('x-webhook-secret'), config.webhookSecret)) throw new HttpError(401, 'Invalid webhook secret');
}

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined);

// Website/landing-page form -> lead. Existing contact (same email/phone) is not duplicated.
router.post('/form/:apiKey', async (req, res) => {
  const co = await companyFromKey(req.params.apiKey);
  const { name, email, phone, organization, message, source, utm_campaign: utmCampaign, utm_source: utmSource, utm_medium: utmMedium, utm_content: utmContent, ...extra } = req.body || {};
  if (!str(name) || !(str(email) || str(phone))) throw new HttpError(400, 'name and email or phone are required');
  const or = [str(email) && { email: email.toLowerCase().trim() }, str(phone) && { phone: phone.trim() }].filter(Boolean);
  // utm_campaign on the form post ties the lead to an ad campaign (see Ads > UTM builder).
  const ad = str(utmCampaign) ? await M.AdCampaign.findOne({ company: co._id, 'utm.campaign': utmCampaign }).select('_id') : null;
  let lead = await M.Lead.findOne({ company: co._id, $or: or });
  const isNew = !lead;
  if (isNew) {
    lead = await M.Lead.create({
      company: co._id, name: str(name), email: str(email), phone: str(phone), organization: str(organization),
      source: ad ? 'ads' : str(source, 40) || 'form', adCampaign: ad?._id,
      customFields: { ...Object.fromEntries(Object.entries(extra).slice(0, 20)), ...(utmCampaign && { utm: { source: utmSource, medium: utmMedium, campaign: utmCampaign, content: utmContent } }) },
    });
    const r = await ai.scoreLead(lead);
    lead.score = r.score; lead.scoreReason = r.reason;
    await lead.save();
  }
  if (message) lead.notes.push({ text: str(message, 2000) }), await lead.save();
  await logActivity(co._id, { kind: 'Lead', id: lead._id }, 'form.submitted', isNew ? 'New lead from form' : 'Existing lead submitted form again');
  if (isNew) emit(co._id, 'lead.created', { kind: 'Lead', id: lead._id });
  emit(co._id, 'form.submitted', { kind: 'Lead', id: lead._id });
  res.status(isNew ? 201 : 200).json({ id: lead._id, created: isNew });
});

// Inbound message from WhatsApp/email provider. Matched to a lead/customer by phone/email.
async function inbound(req, res, channel) {
  requireSecret(req);
  const co = await companyFromKey(req.body.apiKey);
  const from = str(req.body.from, 200)?.replace(/^whatsapp:/, '').trim();
  if (!from) throw new HttpError(400, 'from is required');
  const field = channel === 'email' ? 'email' : 'phone';
  const value = channel === 'email' ? from.toLowerCase() : from;
  const customer = await M.Customer.findOne({ company: co._id, [field]: value });
  const lead = customer ? null : await M.Lead.findOne({ company: co._id, [field]: value });
  const person = customer || lead;
  const body = str(req.body.body, 8000) || '';
  const s = body ? await ai.sentiment(body) : {};
  const msg = await M.Communication.create({
    company: co._id, channel, direction: 'inbound', from, subject: str(req.body.subject), body, status: 'received',
    sentiment: s.sentiment, relatedTo: person && { kind: customer ? 'Customer' : 'Lead', id: person._id },
  });
  if (person) {
    if (customer) { customer.lastActivityAt = new Date(); if (customer.lifecycle === 'at_risk') customer.lifecycle = 'active'; await customer.save(); }
    await logActivity(co._id, { kind: customer ? 'Customer' : 'Lead', id: person._id }, `${channel}.received`, body.slice(0, 120));
    emit(co._id, `${channel}.received`, { kind: customer ? 'Customer' : 'Lead', id: person._id }, { message: body });
  }
  res.status(201).json({ id: msg._id, matched: !!person });
}
// WhatsApp goes through the Communication Hub inbox (AI bot, intent mapping, handoff).
// New integrations should use the per-provider URLs under /api/webhooks/comm/:token.
router.post('/whatsapp', async (req, res) => {
  requireSecret(req);
  const co = await companyFromKey(req.body.apiKey);
  const r = await inbox.handleInbound({ company: co._id, channel: 'whatsapp', from: str(req.body.from, 200), body: str(req.body.body, 8000) || '', name: str(req.body.name, 80) });
  res.status(201).json({ id: r.message?._id, matched: !!r.contact && !r.createdLead, leadCreated: !!r.createdLead, reply: r.reply, intent: r.intent });
});
router.post('/email', (req, res) => inbound(req, res, 'email'));

// Website behaviour tracking (page views etc.) for a known contact.
router.post('/activity/:apiKey', async (req, res) => {
  const co = await companyFromKey(req.params.apiKey);
  const email = str(req.body.email)?.toLowerCase();
  if (!email) throw new HttpError(400, 'email is required');
  const lead = await M.Lead.findOne({ company: co._id, email });
  if (!lead) return res.json({ matched: false });
  await logActivity(co._id, { kind: 'Lead', id: lead._id }, 'website.activity', `${str(req.body.event, 60) || 'visit'} ${str(req.body.page, 200) || ''}`.trim());
  emit(co._id, 'website.activity', { kind: 'Lead', id: lead._id }, { event: req.body.event, page: req.body.page });
  res.json({ matched: true });
});

module.exports = router;
