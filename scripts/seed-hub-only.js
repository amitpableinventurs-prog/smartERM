// Adds the Communication Hub demo users (comm@demo.com, agent@demo.com) and hub demo data to an
// EXISTING demo company without deleting anything. Safe to re-run. Run: npm run seed:hub
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const M = require('../src/models');
const seedHub = require('./seed-hub');

const PASSWORD = 'Demo@1234';

(async () => {
  await mongoose.connect(config.mongoUri);
  const admin = await M.User.findOne({ email: 'admin@demo.com' });
  if (!admin) {
    console.log('No demo company found. Run "npm run seed" first.');
    return mongoose.disconnect();
  }
  const co = admin.company;
  const pw = await bcrypt.hash(PASSWORD, 10);
  const ensure = async (name, email, role) => {
    const u = await M.User.findOne({ email });
    if (u) { console.log(`exists   ${email}`); return u; }
    console.log(`created  ${email} (${role})`);
    const created = await M.User.create({ company: co, name, email, password: pw, role, branch: 'Mumbai HQ' });
    await M.Notification.create({ company: co, user: created._id, title: 'Welcome to Smart CRM', body: 'Your Communication Hub workspace is ready.' });
    return created;
  };
  await ensure('Kabir Anand', 'comm@demo.com', 'comm_manager');
  const agent = await ensure('Zoya Ali', 'agent@demo.com', 'telecaller');

  if (await M.ChannelProvider.exists({ company: co })) {
    console.log('Communication Hub data already present - skipped.');
  } else {
    const leads = await M.Lead.find({ company: co, phone: { $nin: [null, ''] } }).sort('_id');
    const customers = await M.Customer.find({ company: co, phone: { $nin: [null, ''] } }).sort('_id');
    if (leads.length < 8 || customers.length < 3) console.log('Not enough demo leads/customers with phone numbers - hub demo data skipped.');
    else { await seedHub({ co, leads, customers, agent }); console.log('Communication Hub demo data added.'); }
  }
  console.log(`Sign in with password ${PASSWORD}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
