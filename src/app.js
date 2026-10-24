const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { authenticate, requireModule } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/common');
const admin = require('./routes/admin');
const comms = require('./routes/communications');
const tenants = require('./services/tenants');

// Origin of pages inside the Windows desktop app (desktop/main.js serves the panels from app://smartcrm).
const DESKTOP_ORIGIN = 'app://smartcrm';
const corsList = config.corsOrigin === '*' ? null : config.corsOrigin.split(',').map((o) => o.trim());

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
// With CORS_ORIGIN set, the desktop app and clients' verified custom domains are still allowed.
app.use(cors({
  origin(origin, cb) {
    if (!corsList || !origin || origin === DESKTOP_ORIGIN || corsList.includes(origin)) return cb(null, true);
    let host;
    try { host = new URL(origin).hostname; } catch { return cb(null, false); }
    tenants.tenantForHost(host).then((co) => cb(null, !!co), () => cb(null, false));
  },
}));
// Webhook signatures (Meta) are computed over the raw body, so keep it for /api/webhooks.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf; } }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

const limiter = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });

app.use(express.static(path.join(__dirname, '..', 'public'))); // role-based web panels at /, owner console at /owner.html
app.use('/downloads', express.static(config.downloadsDir)); // desktop installer
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Login page branding: on a client's verified domain show their name and hide sign-up.
app.get('/api/tenant', async (req, res) => {
  const co = await tenants.tenantForHost(req.hostname);
  res.json({ tenant: co && { name: co.name, branding: co.branding || {} }, signup: config.allowSignup && !co });
});
// Caddy on-demand TLS asks here before issuing a certificate for a hostname (see deploy/Caddyfile).
app.get('/api/domains/allowed', limiter(60e3, 300), async (req, res) => {
  res.status((await tenants.tenantForHost(String(req.query.domain || ''))) ? 200 : 404).end();
});

// Public
app.use('/api/auth', limiter(15 * 60e3, 50), require('./routes/auth'));
app.use('/api/owner/login', limiter(15 * 60e3, 20)); // the owner account controls every company
app.use('/api/owner', limiter(60e3, 300), require('./routes/owner'));
app.use('/api/activate', limiter(15 * 60e3, 100), require('./routes/activate'));
// Provider callbacks (delivery receipts, IVR steps) arrive in bursts during bulk sends: higher limit.
app.use('/api/webhooks/comm', limiter(60e3, 5000), require('./routes/hubhooks'));
app.use('/api/webhooks', limiter(60e3, 120), require('./routes/inbound'));
app.use('/api/oauth', limiter(15 * 60e3, 60), require('./routes/oauth')); // ad-network sign-in callbacks

// Authenticated, company-scoped
const api = express.Router();
api.use(limiter(60e3, 600), authenticate);
// Module gates follow the licence the owner assigned. Leads/customers/tasks are shared by the modules that work on contacts.
const mod = requireModule;
api.use('/leads', mod('crm', 'hub', 'ads'), require('./routes/leads'));
api.use('/customers', mod('crm', 'hub'), require('./routes/customers'));
api.use('/deals', mod('crm'), require('./routes/deals'));
api.use('/tasks', mod('crm', 'hub'), require('./routes/tasks'));
api.use('/communications', mod('crm', 'hub'), comms);
api.use('/templates', mod('crm', 'hub'), comms.templates);
api.use('/campaigns', mod('crm'), require('./routes/campaigns'));
api.use('/workflows', mod('crm'), require('./routes/workflows'));
api.use('/ai', mod('ai'), require('./routes/ai'));
// The dashboard summary is part of every plan; the detailed reports are the Reports module.
api.use('/reports', (req, res, next) => (req.path === '/dashboard' ? next() : mod('reports')(req, res, next)), require('./routes/reports'));
api.use('/data', mod('crm'), require('./routes/data'));
api.use('/ads', mod('ads'), require('./routes/ads'));
api.use('/hr', mod('hr'), require('./routes/hr'));
api.use('/me', mod('hr'), require('./routes/self'));
api.use('/hub', mod('hub'), require('./routes/hub'));
api.use('/users', admin.users);
api.use('/company', admin.company);
api.use('/pipelines', mod('crm'), admin.pipelines);
api.use('/webhook-subscriptions', admin.webhooks);
api.use('/audit-logs', admin.auditRouter);
api.use('/notifications', admin.notifications);
app.use('/api', api);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
