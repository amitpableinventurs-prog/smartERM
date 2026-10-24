// Public endpoints: website forms, JustDial and WhatsApp/email providers push data in here.
const express = require('express');
const crypto = require('crypto');
const M = require('../models');
const config = require('../config');
const { HttpError } = require('../utils/helpers');
const { accessProblem } = require('../modules');
const { logActivity, emit } = require('../services/events');
const ai = require('../services/ai');
const inbox = require('../services/inbox');
const contacts = require('../services/contacts');

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

async function newLead(company, fields) {
  const lead = await M.Lead.create({ company, ...fields });
  const r = await ai.scoreLead(lead);
  lead.score = r.score; lead.scoreReason = r.reason;
  await lead.save();
  return lead;
}

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
    lead = await newLead(co._id, {
      name: str(name), email: str(email), phone: str(phone), organization: str(organization),
      source: ad ? 'ads' : str(source, 40) || 'form', adCampaign: ad?._id,
      customFields: { ...Object.fromEntries(Object.entries(extra).slice(0, 20)), ...(utmCampaign && { utm: { source: utmSource, medium: utmMedium, campaign: utmCampaign, content: utmContent } }) },
    });
  }
  if (message) lead.notes.push({ text: str(message, 2000) }), await lead.save();
  await logActivity(co._id, { kind: 'Lead', id: lead._id }, 'form.submitted', isNew ? 'New lead from form' : 'Existing lead submitted form again');
  if (isNew) emit(co._id, 'lead.created', { kind: 'Lead', id: lead._id });
  emit(co._id, 'form.submitted', { kind: 'Lead', id: lead._id });
  res.status(isNew ? 201 : 200).json({ id: lead._id, created: isNew });
});

// JustDial lead push: give JustDial the URL /api/webhooks/justdial/<apiKey> (Company Settings shows it).
// JustDial sends GET query parameters or a form/JSON POST (leadid, prefix, name, mobile, phone, email, category,
// city, area, brancharea, pincode, company, date, time, ...) and expects the plain-text reply "RECEIVED".
// Repeat pushes of the same leadid are ignored; a known phone/email gets a note instead of a duplicate lead.
router.all('/justdial/:apiKey', express.urlencoded({ extended: false, limit: '100kb' }), async (req, res) => {
  const co = await companyFromKey(req.params.apiKey);
  const b = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const pick = (...keys) => keys.map((k) => (b[k] == null ? '' : String(b[k]).trim().slice(0, 300))).find(Boolean) || undefined;
  const received = () => res.type('text/plain').send('RECEIVED');

  const leadId = pick('leadid', 'leadId', 'lead_id');
  const phone = contacts.normalize(pick('mobile', 'mobileno', 'mobile_no', 'phone', 'phone_no'));
  const email = pick('email', 'emailid')?.toLowerCase();
  if (!phone && !email) throw new HttpError(400, 'mobile or email is required');
  if (leadId && (await M.Activity.exists({ company: co._id, type: 'justdial.enquiry', 'meta.leadId': leadId }))) return received();

  const name = [pick('prefix'), pick('name')].filter(Boolean).join(' ');
  const enquiry = {
    leadId, leadType: pick('leadtype', 'lead_type'), category: pick('category'), city: pick('city'), area: pick('area'),
    branchArea: pick('brancharea'), pincode: pick('pincode'), enquiredAt: [pick('date'), pick('time')].filter(Boolean).join(' ') || undefined,
    dnd: pick('dncmobile', 'dncphone') === '1' || undefined,
  };
  for (const k of Object.keys(enquiry)) if (enquiry[k] === undefined) delete enquiry[k];
  const summary = ['JustDial enquiry', enquiry.category, [enquiry.area, enquiry.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ');

  const hit = (phone && (await contacts.findByPhone(co._id, phone)))
    || (email && (await M.Lead.findOne({ company: co._id, email }).then((d) => d && { kind: 'Lead', doc: d })));
  let entity;
  if (hit) {
    entity = { kind: hit.kind, id: hit.doc._id };
    if (hit.kind === 'Lead') { hit.doc.notes.push({ text: summary }); await hit.doc.save(); }
  } else {
    const lead = await newLead(co._id, {
      name: name || phone || email, phone: phone || undefined, email, organization: pick('company'),
      source: 'justdial', tags: ['justdial', ...(enquiry.category ? [enquiry.category.slice(0, 60)] : [])],
      customFields: { justdial: enquiry }, notes: [{ text: summary }],
    });
    entity = { kind: 'Lead', id: lead._id };
    emit(co._id, 'lead.created', entity);
  }
  await logActivity(co._id, entity, 'justdial.enquiry', hit ? `New JustDial enquiry from existing ${hit.kind.toLowerCase()}` : 'New lead from JustDial', { leadId });
  emit(co._id, 'justdial.enquiry', entity, { enquiry });
  received();
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
