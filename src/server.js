const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const scheduler = require('./services/scheduler');

if (config.jwt.accessSecret.startsWith('dev-') && process.env.NODE_ENV === 'production') {
  console.error('Refusing to start in production with default JWT secrets. Set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET.');
  process.exit(1);
}

mongoose
  .connect(config.mongoUri)
  .then(() => require('./services/tenants').backfill())
  .then(() => {
    const server = app.listen(config.port, () => console.log(`Smart CRM API on http://localhost:${config.port}`));
    if (config.schedulerEnabled) scheduler.start();
    const shutdown = () => { scheduler.stop(); server.close(() => mongoose.disconnect().then(() => process.exit(0))); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((e) => {
    console.error('MongoDB connection failed:', e.message);
    process.exit(1);
  });
