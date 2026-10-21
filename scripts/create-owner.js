// Creates the platform owner (or resets their password). Run: npm run owner:create -- you@example.com "StrongPass123" "Your Name"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const { Owner } = require('../src/models');

const [email, password, name = 'Owner'] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: npm run owner:create -- <email> <password (min 8)> [name]');
  process.exit(1);
}

(async () => {
  await mongoose.connect(config.mongoUri);
  await Owner.updateOne({ email: email.toLowerCase() }, { name, password: await bcrypt.hash(password, 10), active: true }, { upsert: true });
  console.log('Owner %s ready. Sign in at http://localhost:%d/owner.html', email, config.port);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
