const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { User } = require('../models');
const { HttpError } = require('../utils/helpers');

// c=create r=read u=update d=delete. '*' = everything.
const ACL = {
  super_admin: '*',
  admin: '*',
  manager: {
    leads: 'crud', customers: 'crud', deals: 'crud', tasks: 'crud', communications: 'crud',
    templates: 'crud', campaigns: 'crud', workflows: 'crud', pipelines: 'crud', webhooks: 'crud',
    notifications: 'crud', users: 'r', reports: 'r', dashboard: 'r', ai: 'r', audit: 'r', company: 'r', import: 'c', export: 'r', ads: 'crud',
    hub: 'r', bulk: 'crud', ivr: 'crud', inbox: 'crud', hubsetup: 'crud',
  },
  sales: {
    leads: 'cru', customers: 'cru', deals: 'cru', tasks: 'crud', communications: 'cr',
    templates: 'r', campaigns: 'r', pipelines: 'r', notifications: 'ru', users: 'r',
    dashboard: 'r', reports: 'r', ai: 'r', import: 'c', export: 'r', inbox: 'ru',
  },
  hr_manager: { hr: 'crud', dashboard: 'r', reports: 'r', users: 'r', notifications: 'ru', import: 'c', export: 'r' },
  ads_manager: { ads: 'crud', leads: 'r', dashboard: 'r', reports: 'r', ai: 'r', templates: 'r', notifications: 'ru', import: 'c', export: 'r' },
  support: {
    leads: 'r', customers: 'cru', deals: 'r', tasks: 'cru', communications: 'cr',
    templates: 'r', pipelines: 'r', notifications: 'ru', dashboard: 'r', ai: 'r', inbox: 'ru', ivr: 'r',
  },
  // Communication Hub panel: bulk SMS / WhatsApp / IVR, AI bot, providers.
  comm_manager: {
    hub: 'r', bulk: 'crud', ivr: 'crud', inbox: 'crud', hubsetup: 'crud', templates: 'crud', leads: 'r', customers: 'r',
    communications: 'cr', ai: 'r', dashboard: 'r', reports: 'r', users: 'r', notifications: 'ru', import: 'c', export: 'r',
  },
  // Agent / telecaller panel: works the inbox and their own leads.
  telecaller: { inbox: 'ru', leads: 'ru', customers: 'r', tasks: 'cru', communications: 'cr', templates: 'r', ai: 'r', users: 'r', notifications: 'ru' },
};

// Roles restricted to records assigned to them.
const OWN_ONLY = { sales: ['leads', 'deals', 'tasks', 'customers', 'inbox'], telecaller: ['leads', 'tasks', 'inbox'] };

function signAccess(user) {
  return jwt.sign({ sub: String(user._id), company: String(user.company), role: user.role }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
  });
}

function signRefresh(user) {
  return jwt.sign({ sub: String(user._id) }, config.jwt.refreshSecret, { expiresIn: `${config.jwt.refreshDays}d`, jwtid: crypto.randomUUID() });
}

async function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token');
  let payload;
  try {
    payload = jwt.verify(h.slice(7), config.jwt.accessSecret);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  const user = await User.findById(payload.sub);
  if (!user || !user.active) throw new HttpError(401, 'User not found or disabled');
  req.user = user;
  req.companyId = user.company;
  next();
}

function allowed(role, resource, action) {
  const acl = ACL[role];
  if (acl === '*') return true;
  return !!acl?.[resource]?.includes(action);
}

const authorize = (resource, action) => (req, _res, next) => {
  if (!allowed(req.user.role, resource, action)) throw new HttpError(403, `Role '${req.user.role}' cannot ${action} ${resource}`);
  next();
};

// Mongo filter that limits restricted roles to their own records.
function scopeFilter(req, resource) {
  return OWN_ONLY[req.user.role]?.includes(resource) ? { assignedTo: req.user._id } : {};
}

module.exports = { authenticate, authorize, scopeFilter, signAccess, signRefresh, allowed };
