const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { authenticate } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/common');
const admin = require('./routes/admin');
const comms = require('./routes/communications');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
// Webhook signatures (Meta) are computed over the raw body, so keep it for /api/webhooks.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf; } }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

const limiter = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });

app.use(express.static(path.join(__dirname, '..', 'public'))); // role-based web panels at /
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Public
app.use('/api/auth', limiter(15 * 60e3, 50), require('./routes/auth'));
// Provider callbacks (delivery receipts, IVR steps) arrive in bursts during bulk sends: higher limit.
app.use('/api/webhooks/comm', limiter(60e3, 5000), require('./routes/hubhooks'));
app.use('/api/webhooks', limiter(60e3, 120), require('./routes/inbound'));

// Authenticated, company-scoped
const api = express.Router();
api.use(limiter(60e3, 600), authenticate);
api.use('/leads', require('./routes/leads'));
api.use('/customers', require('./routes/customers'));
api.use('/deals', require('./routes/deals'));
api.use('/tasks', require('./routes/tasks'));
api.use('/communications', comms);
api.use('/templates', comms.templates);
api.use('/campaigns', require('./routes/campaigns'));
api.use('/workflows', require('./routes/workflows'));
api.use('/ai', require('./routes/ai'));
api.use('/reports', require('./routes/reports'));
api.use('/data', require('./routes/data'));
api.use('/ads', require('./routes/ads'));
api.use('/hr', require('./routes/hr'));
api.use('/me', require('./routes/self'));
api.use('/hub', require('./routes/hub'));
api.use('/users', admin.users);
api.use('/company', admin.company);
api.use('/pipelines', admin.pipelines);
api.use('/webhook-subscriptions', admin.webhooks);
api.use('/audit-logs', admin.auditRouter);
api.use('/notifications', admin.notifications);
app.use('/api', api);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
