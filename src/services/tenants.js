/** Companies as tenants: creation, a short-lived cache for per-request licence checks, and custom domains. */
const dns = require('dns').promises;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { Company, User, Pipeline } = require('../models');
const { HttpError } = require('../utils/helpers');
const { MODULE_KEYS } = require('../modules');

const TTL = 15e3;
const byId = new Map(); // companyId -> { co, at }
const byHost = new Map(); // host -> { co|null, at }

async function getCompany(id) {
  const hit = byId.get(String(id));
  if (hit && Date.now() - hit.at < TTL) return hit.co;
  const co = await Company.findById(id).lean();
  byId.set(String(id), { co, at: Date.now() });
  return co;
}

// Call after changing a company so licence changes apply at once (in this process; others catch up within TTL).
function invalidate(co) {
  byId.delete(String(co._id || co));
  byHost.clear();
}

async function createCompany({ companyName, name, email, password, ...licence }) {
  if (await User.exists({ email: email.toLowerCase() })) throw new HttpError(409, 'Email already registered');
  const company = await Company.create({ name: companyName, ...licence });
  await Pipeline.create({
    company: company._id, name: 'Default Sales Pipeline', isDefault: true,
    stages: ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost'],
  });
  const user = await User.create({ company: company._id, name, email, password: await bcrypt.hash(password, 10), role: 'super_admin' });
  return { company, user };
}

// Companies created before licensing existed: store an activation key and give them every module.
// (Schema defaults only fill these in memory, so without this the key would change on every read.)
async function backfill() {
  const makeKey = Company.schema.path('activationKey').defaultValue;
  for (const co of await Company.find({ activationKey: { $exists: false } }).select('_id').lean()) {
    await Company.updateOne({ _id: co._id, activationKey: { $exists: false } }, { $set: { activationKey: makeKey() } });
  }
  await Company.updateMany({ modules: { $exists: false } }, { $set: { modules: MODULE_KEYS } });
}

// What the panels need to know about the signed-in user's company.
const workspace = (co) => ({ id: co._id, name: co.name, modules: co.modules, branding: co.branding || {}, validUntil: co.validUntil });

// ---- custom domains ----
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeHost(input) {
  const host = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0].replace(/\.$/, '');
  if (!HOST_RE.test(host)) throw new HttpError(400, 'Enter a domain like crm.client.com');
  return host;
}

const primaryHost = () => { try { return new URL(config.publicUrl).hostname; } catch { return ''; } };
const txtName = (host) => `_smartcrm-verify.${host}`;
const newToken = () => 'smartcrm-' + crypto.randomBytes(12).toString('hex');

// DNS records the client must add for a domain.
const dnsRecords = (d) => [
  { type: 'CNAME', name: d.host, value: primaryHost() || '<your server host, set PUBLIC_URL>', purpose: 'Sends the domain to this server' },
  { type: 'TXT', name: txtName(d.host), value: d.token, purpose: 'Proves the client owns the domain' },
];

async function checkTxt(host, token) {
  try {
    return (await dns.resolveTxt(txtName(host))).some((parts) => parts.join('') === token);
  } catch {
    return false; // NXDOMAIN / timeout: not verified yet
  }
}

// Company that owns a verified custom domain, or null.
async function tenantForHost(host) {
  host = String(host || '').toLowerCase().split(':')[0];
  if (!host || host === primaryHost() || host === 'localhost') return null;
  const hit = byHost.get(host);
  if (hit && Date.now() - hit.at < TTL) return hit.co;
  const co = await Company.findOne({ domains: { $elemMatch: { host, verified: true } } }).lean();
  byHost.set(host, { co, at: Date.now() });
  return co;
}

module.exports = { getCompany, invalidate, createCompany, backfill, workspace, normalizeHost, newToken, dnsRecords, checkTxt, tenantForHost, primaryHost };
