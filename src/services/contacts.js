// Maps phone numbers to CRM records and keeps the do-not-disturb list.
const M = require('../models');
const ai = require('./ai');
const { normalize, phoneKey, looseRegex } = require('../utils/phone');

// Customer first (existing relationship), then lead. Returns { kind, doc } or null.
async function findByPhone(company, phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  for (const [kind, Model] of [['Customer', M.Customer], ['Lead', M.Lead]]) {
    let doc = await Model.findOne({ company, phoneKey: key }).sort('-updatedAt');
    if (!doc) {
      // Records saved before phoneKey existed: match on digits, then backfill the key.
      doc = await Model.findOne({ company, phoneKey: { $in: [null, ''] }, phone: looseRegex(key) });
      if (doc) await Model.updateOne({ _id: doc._id }, { phoneKey: key });
    }
    if (doc) return { kind, doc };
  }
  return null;
}

async function createLead(company, phone, { name, source = 'manual', tags = [], customFields } = {}) {
  const lead = new M.Lead({ company, name: (name || '').trim() || normalize(phone), phone: normalize(phone), source, tags, customFields });
  lead.score = ai.heuristicScore(lead).score;
  await lead.save();
  return { kind: 'Lead', doc: lead };
}

async function findOrCreate(company, phone, opts = {}) {
  const hit = await findByPhone(company, phone);
  if (hit) return { ...hit, created: false };
  return { ...(await createLead(company, phone, opts)), created: true };
}

const ref = (c) => (c ? { kind: c.kind, id: c.doc._id } : undefined);

const DND_CHANNEL = { sms: 'sms', whatsapp: 'whatsapp', ivr: 'voice', voice: 'voice', call: 'voice' };

async function isOptedOut(company, phone, channel) {
  const p = normalize(phone);
  if (!p) return false;
  return !!(await M.OptOut.exists({ company, phone: p, channel: { $in: ['all', DND_CHANNEL[channel] || channel] } }));
}

async function optOut(company, phone, { channel = 'all', reason, source = 'manual' } = {}) {
  const p = normalize(phone);
  if (!p) return null;
  return M.OptOut.findOneAndUpdate(
    { company, phone: p, channel },
    { $setOnInsert: { company, phone: p, channel, reason, source } },
    { upsert: true, returnDocument: 'after' }
  );
}

module.exports = { findByPhone, createLead, findOrCreate, ref, isOptedOut, optOut, normalize };
