// Fills the database with demo data. Run: npm run seed   (re-running replaces the demo company)
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const M = require('../src/models');
const ai = require('../src/services/ai');
const { TEMPLATES } = require('../src/services/automation');
const hrSvc = require('../src/services/hr');
const leaveSvc = require('../src/services/leave');
const seedHub = require('./seed-hub');

const PASSWORD = 'Demo@1234';
const day = 864e5;
const ago = (d) => new Date(Date.now() - d * day);
const ahead = (d) => new Date(Date.now() + d * day);
const pick = (a, i) => a[i % a.length];
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));

const LEADS = [
  ['Rohan Gupta', 'Gupta Traders'], ['Neha Verma', 'Verma Textiles'], ['Amit Shah', 'Shah Logistics'], ['Kavya Nair', 'Nair Foods'],
  ['Vikram Singh', 'Singh Motors'], ['Pooja Iyer', 'Iyer Clinics'], ['Sandeep Rao', 'Rao Builders'], ['Anjali Desai', 'Desai Jewels'],
  ['Manish Kapoor', 'Kapoor Electronics'], ['Ritu Malhotra', 'Malhotra Events'], ['Suresh Reddy', 'Reddy Agro'], ['Divya Joshi', 'Joshi Academy'],
  ['Karan Bhatia', 'Bhatia Pharma'], ['Meera Pillai', 'Pillai Travels'], ['Arjun Menon', 'Menon Software'], ['Sneha Kulkarni', 'Kulkarni Interiors'],
  ['Rahul Chopra', 'Chopra Fitness'], ['Isha Agarwal', 'Agarwal Exports'], ['Nikhil Jain', 'Jain Hardware'], ['Tanvi Mehta', 'Mehta Salons'],
  ['Deepak Yadav', 'Yadav Dairy'], ['Shreya Ghosh', 'Ghosh Publishing'], ['Gaurav Saxena', 'Saxena Solar'], ['Aditi Bansal', 'Bansal Cafe'],
  ['Harsh Vora', 'Vora Chemicals'], ['Simran Kaur', 'Kaur Boutique'], ['Yash Thakur', 'Thakur Realty'], ['Nandini Bose', 'Bose Consulting'],
  ['Mohit Tiwari', 'Tiwari Auto'], ['Lakshmi Naidu', 'Naidu Spices'], ['Abhishek Dubey', 'Dubey Security'], ['Ananya Sen', 'Sen Studio'],
  ['Pranav Kale', 'Kale Printers'], ['Ria Sethi', 'Sethi Wellness'], ['Varun Khanna', 'Khanna Steel'], ['Chhavi Rastogi', 'Rastogi Learning'],
];
const SOURCES = ['website', 'referral', 'whatsapp', 'ads', 'form', 'event', 'manual'];
const STATUSES = ['new', 'new', 'new', 'contacted', 'contacted', 'qualified', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost'];
const slug = (n) => n.toLowerCase().replace(/[^a-z]+/g, '.');

(async () => {
  await mongoose.connect(config.mongoUri);
  const old = await M.User.findOne({ email: 'admin@demo.com' });
  if (old) {
    const c = old.company;
    for (const m of Object.values(M)) if (m.schema?.path?.('company')) await m.deleteMany({ company: c });
    await M.Company.deleteOne({ _id: c });
  }

  const company = await M.Company.create({ name: 'Acme Solutions', branches: [{ name: 'Mumbai HQ' }, { name: 'Delhi' }] });
  const co = company._id;
  const pw = await bcrypt.hash(PASSWORD, 10);
  const mk = (name, email, role, branch) => M.User.create({ company: co, name, email, password: pw, role, branch });
  const admin = await mk('Rajesh Kumar', 'admin@demo.com', 'super_admin', 'Mumbai HQ');
  const manager = await mk('Sunita Patel', 'manager@demo.com', 'manager', 'Mumbai HQ');
  const s1 = await mk('Aarav Mehta', 'sales1@demo.com', 'sales', 'Mumbai HQ');
  const s2 = await mk('Priya Sharma', 'sales2@demo.com', 'sales', 'Delhi');
  const support = await mk('Imran Khan', 'support@demo.com', 'support', 'Delhi');
  const adsUser = await mk('Neeraj Verma', 'ads@demo.com', 'ads_manager', 'Mumbai HQ');
  const hrUser = await mk('Hema Nair', 'hr@demo.com', 'hr_manager', 'Mumbai HQ');
  const commUser = await mk('Kabir Anand', 'comm@demo.com', 'comm_manager', 'Mumbai HQ');
  const agent = await mk('Zoya Ali', 'agent@demo.com', 'telecaller', 'Mumbai HQ');
  const sales = [s1, s2];

  const stages = ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost'];
  const pipeline = await M.Pipeline.create({ company: co, name: 'Default Sales Pipeline', stages, isDefault: true });

  // Leads
  const leads = [];
  for (const [i, [name, org]] of LEADS.entries()) {
    const status = pick(STATUSES, i * 7 + 3);
    const lead = new M.Lead({
      company: co, name, organization: org, email: `${slug(name)}@${slug(org).replace(/\.$/, '')}.in`, phone: `+9198${rnd(10000000, 99999999)}`,
      source: pick(SOURCES, i * 3), status, budget: rnd(2, 40) * 5000, branch: i % 2 ? 'Delhi' : 'Mumbai HQ',
      assignedTo: pick(sales, i)._id, tags: i % 4 === 0 ? ['vip'] : i % 5 === 0 ? ['nurture'] : [], createdAt: ago(rnd(0, 58)),
      lostReason: status === 'lost' ? pick(['Budget', 'Went with competitor', 'No response'], i) : undefined,
    });
    const r = ai.heuristicScore(lead, rnd(0, 4));
    lead.score = r.score; lead.scoreReason = r.reason;
    if (i % 6 === 0) lead.notes.push({ text: 'Asked for a detailed quotation.', by: lead.assignedTo });
    await lead.save();
    leads.push(lead);
  }

  // Customers
  const CUST = ['Sharma Enterprises', 'Patel & Sons', 'Bluewave Tech', 'Greenfield Organics', 'Sunrise Hospital', 'Metro Retail', 'Orbit Learning', 'Zenith Auto', 'Lotus Hotels', 'Pioneer Steel', 'Nova Pharma', 'Craft Studio'];
  const customers = [];
  for (const [i, name] of CUST.entries()) {
    const quiet = i === 3 || i === 9;
    customers.push(await M.Customer.create({
      company: co, name, organization: name, email: `contact@${slug(name).replace(/\.+$/, '')}.in`, phone: `+9199${rnd(10000000, 99999999)}`,
      lifecycle: quiet ? 'at_risk' : i % 5 === 0 ? 'vip' : 'active', assignedTo: pick(sales, i)._id, address: pick(['Mumbai', 'Delhi', 'Pune', 'Bengaluru', 'Jaipur'], i),
      birthday: i === 1 ? ahead(2) : undefined, tags: i % 5 === 0 ? ['vip'] : [],
      purchases: [{ item: 'Annual CRM plan', amount: rnd(2, 12) * 10000, at: ago(rnd(20, 200)) }, ...(i % 3 === 0 ? [{ item: 'Onboarding package', amount: 25000, at: ago(rnd(10, 90)) }] : [])],
      lastActivityAt: quiet ? ago(rnd(40, 70)) : ago(rnd(0, 20)), churnRisk: quiet ? rnd(55, 85) : undefined, createdAt: ago(rnd(60, 300)),
    }));
  }

  // Deals: won across the last 6 months, some lost, many open
  const DEAL_TITLES = ['Website revamp', 'CRM rollout', 'Annual maintenance', 'Mobile app build', 'Marketing automation', 'Cloud migration', 'SEO retainer', 'POS integration', 'Training programme', 'ERP add-on', 'Branding package', 'Support contract', 'Analytics dashboard', 'WhatsApp bot'];
  for (const [i, title] of DEAL_TITLES.entries()) {
    const won = i < 7, lost = i >= 7 && i < 10;
    const stage = won ? 'won' : lost ? 'lost' : pick(['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation'], i);
    const value = rnd(2, 25) * 10000;
    await M.Deal.create({
      company: co, title, value, pipeline: pipeline._id, stage, status: won ? 'won' : lost ? 'lost' : 'open',
      probability: won ? 100 : lost ? 0 : { new: 10, contacted: 20, qualified: 40, proposal_sent: 60, negotiation: 80 }[stage],
      customer: customers[i % customers.length]._id, assignedTo: pick(sales, i)._id,
      closedAt: won || lost ? ago(i * 24 + rnd(1, 15)) : undefined, expectedCloseDate: won || lost ? undefined : ahead(rnd(5, 40)),
      payments: won ? [{ amount: Math.round(value / 2), method: 'bank transfer' }] : [], createdAt: ago(i * 24 + 30),
    });
  }

  // Tasks
  const TASKS = [['Call Rohan Gupta about quotation', 'call', -2, 'urgent'], ['Send proposal to Verma Textiles', 'email', -1, 'high'], ['Demo for Shah Logistics', 'meeting', 0, 'high'],
    ['Follow up with Kavya Nair', 'follow_up', 0, 'medium'], ['Renewal discussion – Sunrise Hospital', 'call', 1, 'high'], ['Prepare contract for Zenith Auto', 'other', 2, 'medium'],
    ['WhatsApp check-in with Pooja Iyer', 'follow_up', 3, 'low'], ['Quarterly review – Metro Retail', 'meeting', 5, 'medium'], ['Win-back call: Greenfield Organics', 'call', -3, 'high'],
    ['Weekly pipeline review', 'meeting', 4, 'medium'], ['Send brochure to Anjali Desai', 'email', -5, 'low'], ['Update CRM notes', 'other', -7, 'low']];
  for (const [i, [title, type, d, priority]] of TASKS.entries()) {
    const done = i >= 10;
    await M.Task.create({ company: co, title, type, priority, status: done ? 'done' : 'pending', dueAt: ahead(d), completedAt: done ? ago(1) : undefined,
      overdueNotified: d < 0, assignedTo: pick([s1, s2, manager, support], i)._id, recurrence: i === 9 ? 'weekly' : 'none' });
  }

  // Communications & activity timeline
  const MSG = [['whatsapp', 'outbound', 'Hi! Thanks for your interest. Can we schedule a quick call?'], ['whatsapp', 'inbound', 'Yes please, tomorrow afternoon works.'], ['email', 'outbound', 'Please find our proposal attached.'],
    ['email', 'inbound', 'Great, looks good. Can you reduce the price a little?'], ['call', 'outbound', 'Discussed requirements; customer wants a demo next week.'], ['sms', 'outbound', 'Reminder: demo tomorrow at 3 PM.'],
    ['whatsapp', 'inbound', 'This is too expensive, I might cancel.']];
  for (let i = 0; i < 26; i++) {
    const [channel, direction, body] = pick(MSG, i);
    const person = i % 3 === 0 ? customers[i % customers.length] : leads[i % leads.length];
    await M.Communication.create({
      company: co, channel, direction, body, subject: channel === 'email' ? 'Regarding your enquiry' : undefined, status: direction === 'inbound' ? 'received' : 'sent',
      to: direction === 'outbound' ? person.phone : undefined, from: direction === 'inbound' ? person.phone : undefined,
      sentiment: direction === 'inbound' ? (body.includes('expensive') ? 'negative' : 'positive') : undefined,
      relatedTo: { kind: person.constructor.modelName, id: person._id }, by: pick(sales, i)._id, createdAt: ago(rnd(0, 14)),
    });
  }
  for (const [i, l] of leads.slice(0, 14).entries()) {
    await M.Activity.create({ company: co, entity: { kind: 'Lead', id: l._id }, type: 'lead.created', message: `Lead created from ${l.source}`, by: admin._id, createdAt: l.createdAt });
    if (l.status !== 'new') await M.Activity.create({ company: co, entity: { kind: 'Lead', id: l._id }, type: 'lead.status_changed', message: `new → ${l.status}`, by: pick(sales, i)._id, createdAt: ago(rnd(0, 6)) });
  }

  // Templates, campaigns, workflows
  const tpl = (name, channel, subject, body) => M.Template.create({ company: co, name, channel, subject, body });
  await tpl('Welcome email', 'email', 'Welcome to Acme, {{person.name}}!', 'Hi {{person.name}},\n\nThanks for reaching out. Our team will contact you shortly.\n\nRegards,\nAcme Solutions');
  await tpl('Welcome WhatsApp', 'whatsapp', null, 'Hi {{person.name}}! Thanks for your interest in Acme. When is a good time to talk?');
  await tpl('Proposal follow-up', 'email', 'Following up on our proposal', 'Hi {{person.name}}, just checking if you had a chance to review our proposal.');
  await tpl('Payment reminder', 'sms', null, 'Hi {{person.name}}, a gentle reminder about your pending payment. Thank you!');

  await M.Campaign.create({ company: co, name: 'Diwali Offer – Email', channel: 'email', status: 'completed', launchedAt: ago(12), cost: 8000,
    audience: { model: 'Customer', filter: {} }, steps: [{ delayDays: 0, subject: 'Festive offer for you, {{person.name}}', body: 'Enjoy 15% off on all plans this week.' }],
    stats: { enrolled: 12, sent: 11, failed: 1, replies: 3 } });
  await M.Campaign.create({ company: co, name: 'New Lead Nurture (3-step drip)', channel: 'whatsapp', status: 'draft',
    audience: { model: 'Lead', filter: { status: 'new' } }, steps: [{ delayDays: 0, body: 'Hi {{person.name}}, welcome to Acme!' }, { delayDays: 2, body: 'Here is how we can help {{person.organization}}.' }, { delayDays: 5, body: 'Shall we book a demo?' }] });

  for (const [i, t] of TEMPLATES.entries()) {
    await M.Workflow.create({ ...JSON.parse(JSON.stringify(t)), company: co, active: i < 3, stats: { runs: i < 3 ? rnd(8, 30) : 0, completed: i < 3 ? rnd(6, 8) : 0, failed: i === 0 ? 1 : 0 } });
  }

  // ---- Advertising ----
  const acc = {};
  for (const [key, platform, name, monthly] of [['g', 'google', 'Google Ads – Acme', 150000], ['m', 'meta', 'Meta Ads – Acme', 120000], ['l', 'linkedin', 'LinkedIn Ads – Acme', 60000]]) {
    acc[key] = await M.AdAccount.create({ company: co, platform, name, accountId: `${rnd(100, 999)}-${rnd(100, 999)}-${rnd(1000, 9999)}`, monthlyBudget: monthly });
  }
  const slugify = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // [name, account, objective, dailyBudget, status, ctr%, cpc, click->lead rate, target ROAS]
  const AD = [
    ['Search – CRM Software', 'g', 'leads', 3000, 'active', 4.5, 28, 0.09, 3.4],
    ['Search – Brand Terms', 'g', 'traffic', 1000, 'active', 9, 8, 0.06, 1.6],
    ['Meta – Lead Form Diwali', 'm', 'leads', 2500, 'active', 1.6, 14, 0.07, 1.5],
    ['Meta – Retargeting', 'm', 'sales', 1200, 'active', 2.8, 9, 0.12, 5.2],
    ['LinkedIn – B2B Decision Makers', 'l', 'leads', 4000, 'active', 0.6, 85, 0.02, 0.45],
    ['YouTube Awareness', 'g', 'awareness', 1500, 'paused', 0.9, 6, 0.01, 0],
    ['Meta – Lookalike Test', 'm', 'leads', 8000, 'pending_approval', 0, 0, 0, 0],
  ];
  const adCamps = [];
  for (const [i, [name, a, objective, dailyBudget, status, ctr, cpc, lr, rpc]] of AD.entries()) {
    const c = await M.AdCampaign.create({
      company: co, account: acc[a]._id, name, objective, dailyBudget, totalBudget: dailyBudget * 60, status, owner: adsUser._id,
      startDate: ago(50), endDate: ahead(10), audience: { locations: ['Mumbai', 'Delhi', 'Bengaluru'], ageMin: 24, ageMax: 50, interests: ['Business software', 'Small business'] },
      utm: { source: acc[a].platform, medium: 'cpc', campaign: slugify(name) }, approvalNote: status === 'pending_approval' ? undefined : undefined,
    });
    adCamps.push(c);
    if (!ctr) continue;
    const creatives = i === 2 ? [await M.AdCreative.create({ company: co, campaign: c._id, name: 'Festive image', variant: 'A', headline: 'Diwali offer: 20% off', cta: 'Sign up' }), await M.AdCreative.create({ company: co, campaign: c._id, name: 'Customer story video', variant: 'B', type: 'video', headline: 'See how Sharma Traders doubled leads', cta: 'Learn more' })] : [];
    if (i === 0) for (const [v, h] of [['A', 'Close more deals with Smart CRM'], ['B', 'The CRM that follows up for you']]) await M.AdCreative.create({ company: co, campaign: c._id, name: 'Headline ' + v, variant: v, headline: h, type: 'text', cta: 'Start free trial' });
    for (let d = 0; d < 45; d++) {
      const date = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - d));
      if (status === 'paused' && d < 12) continue;
      const day = (mult, creative) => {
        const spend = Math.round(dailyBudget * mult * (0.7 + Math.random() * 0.3));
        const clicks = Math.max(1, Math.round(spend / cpc));
        const leads = Math.round(clicks * lr * (0.6 + Math.random() * 0.8));
        const conversions = Math.round(leads * 0.25);
        return { company: co, campaign: c._id, creative: creative?._id || null, date, spend, clicks, impressions: Math.round((clicks / (ctr / 100)) * (0.9 + Math.random() * 0.2)), leads, conversions, revenue: lr ? Math.round(conversions * (rpc * cpc / (lr * 0.25)) * (0.8 + Math.random() * 0.4)) : 0 };
      };
      if (creatives.length) { const [A, B] = creatives; const a = day(0.5, A); const b = day(0.5, B); a.clicks = Math.round(a.clicks * 0.6); b.clicks = Math.round(b.clicks * 1.3); await M.AdMetric.create(a); await M.AdMetric.create(b); }
      else await M.AdMetric.create(day(1));
    }
  }
  // Tie some leads to ad campaigns so attribution has data; a few of them closed as won.
  for (const [i, l] of leads.slice(0, 16).entries()) {
    const camp = adCamps[i % 5];
    l.adCampaign = camp._id; l.source = 'ads';
    if (i % 5 === 0) l.status = 'won';
    await l.save();
    if (l.status === 'won') await M.Deal.create({ company: co, title: `${l.organization} – annual plan`, value: rnd(3, 9) * 10000, pipeline: pipeline._id, stage: 'won', status: 'won', probability: 100, lead: l._id, assignedTo: l.assignedTo, closedAt: ago(rnd(1, 20)) });
  }
  await M.Notification.create({ company: co, user: manager._id, title: 'Ad campaign needs approval', body: 'Meta – Lookalike Test (daily budget 8000)' });

  // ---- HR, attendance & payroll ----
  const TZ = 330, DAYMS = 864e5;
  const nowD = new Date();
  const todayMs = hrSvc.localDayMs(nowD, TZ);
  const EMP = [
    [admin, 'Management', 'Director', 90000, 800], [manager, 'Sales', 'Sales Manager', 55000, 700], [s1, 'Sales', 'Sales Executive', 30000, 500], [s2, 'Sales', 'Sales Executive', 30000, 480],
    [support, 'Support', 'Support Executive', 25000, 420], [adsUser, 'Marketing', 'Ads Manager', 40000, 520], [hrUser, 'HR', 'HR Manager', 45000, 600],
    ['Rohit Jain', 'Engineering', 'Software Developer', 60000, 400], ['Divya Rao', 'Engineering', 'QA Engineer', 38000, 300], ['Karthik Iyer', 'Finance', 'Accountant', 35000, 350],
    ['Fatima Sheikh', 'Operations', 'Coordinator', 28000, 250], ['Vivek Menon', 'Sales', 'Sales Executive', 28000, 20],
  ];
  const employees = [];
  for (const [i, [who, department, designation, basic, joinedDaysAgo]] of EMP.entries()) {
    const u = typeof who === 'string' ? null : who;
    const name = u ? u.name : who;
    employees.push(await M.Employee.create({
      company: co, user: u?._id, employeeCode: `EMP-${String(i + 1).padStart(3, '0')}`, name, email: u ? u.email : `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@acme-demo.in`,
      phone: `+9197${rnd(10000000, 99999999)}`, department, designation, branch: i % 3 === 2 ? 'Delhi' : 'Mumbai HQ', joinDate: new Date(todayMs - joinedDaysAgo * DAYMS),
      birthday: i === 4 ? new Date(Date.UTC(1994, nowD.getUTCMonth(), Math.min(28, nowD.getUTCDate() + 3))) : new Date(Date.UTC(1988 + (i % 8), (i * 5) % 12, 5 + i)),
      salary: { basic, hra: Math.round(basic * 0.4), allowances: Math.round(basic * 0.25), otherDeductions: i % 4 === 0 ? 200 : 0 },
      bank: { holder: name, bankName: pick(['HDFC Bank', 'ICICI Bank', 'SBI'], i), account: String(rnd(10 ** 9, 10 ** 10 - 1)), ifsc: pick(['HDFC0001234', 'ICIC0004321', 'SBIN0000456'], i) },
    }));
  }

  const holidayList = [['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali'], ['2026-12-25', 'Christmas'], ['2027-01-26', 'Republic Day']];
  for (const [d, name] of holidayList) await M.Holiday.create({ company: co, date: new Date(d + 'T00:00:00Z'), name });
  const holidayMs = new Set(holidayList.map(([d]) => Date.parse(d + 'T00:00:00Z')));

  // two full months back plus this month so far
  const fromMs = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 2, 1);
  const attRows = [];
  for (const [ei, e] of employees.entries()) {
    for (let d = Math.max(fromMs, Date.parse(e.joinDate.toISOString().slice(0, 10) + 'T00:00:00Z')); d <= todayMs; d += DAYMS) {
      if (new Date(d).getUTCDay() === 0 || holidayMs.has(d)) continue; // Sunday weekly off + holidays
      const roll = Math.random();
      const base = { company: co, employee: e._id, date: new Date(d), source: 'self' };
      const at = (h, m) => new Date(d + (h * 60 + m) * 60000 - TZ * 60000);
      if (d === todayMs) {
        if (roll < 0.85) { const ci = at(9, rnd(0, 50)); if (ci <= nowD) attRows.push({ ...base, checkIn: ci, late: ci > at(9, 45), status: 'present' }); }
        continue;
      }
      if (roll < 0.04) { attRows.push({ ...base, status: 'absent', source: 'manual' }); continue; }
      const ci = at(9, rnd(0, 75)), half = roll < 0.09;
      const co_ = half ? at(13, rnd(0, 30)) : at(17, rnd(20, 120));
      attRows.push({ ...base, checkIn: ci, checkOut: co_, late: ci > at(9, 45), hoursWorked: Math.round(((co_ - ci) / 36e5) * 100) / 100, status: half ? 'half_day' : 'present' });
    }
  }
  await M.Attendance.insertMany(attRows);

  // leave: one pending, one approved last week, one rejected
  const dayStr = (off) => new Date(todayMs + off * DAYMS).toISOString().slice(0, 10) + 'T00:00:00Z';
  // move a day offset forward until it is a normal working day (not Sunday / holiday)
  const wd = (off) => { let o = off; while (new Date(todayMs + o * DAYMS).getUTCDay() === 0 || holidayMs.has(todayMs + o * DAYMS)) o++; return o; };
  const L = (e, type, a, b, reason) => { const A = wd(a), B = Math.max(wd(b), A); return leaveSvc.applyLeave({ company: co, employee: e, type, from: new Date(dayStr(A)), to: new Date(dayStr(B)), reason }); };
  await L(employees[2], 'casual', 5, 6, 'Family function');
  await L(employees[7], 'earned', 12, 16, 'Vacation');
  await L(employees[10], 'sick', 3, 3, 'Doctor appointment');
  const approved = await L(employees[3], 'sick', -9, -8, 'Fever');
  await leaveSvc.decideLeave({ request: approved, approve: true, user: hrUser, note: 'Get well soon' });
  const rejected = await L(employees[4], 'casual', -14, -12, 'Personal');
  await leaveSvc.decideLeave({ request: rejected, approve: false, user: hrUser, note: 'Team is short-staffed that week' });

  // payroll: the two completed months are done, this month is not yet run
  for (const back of [2, 1]) {
    const month = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
    const run = await hrSvc.buildRun({ company: co, month, userId: hrUser._id });
    run.status = back === 2 ? 'paid' : 'finalized';
    run.finalizedAt = new Date(); if (back === 2) run.paidAt = new Date();
    await run.save();
  }
  await M.Notification.create({ company: co, user: hrUser._id, title: 'Leave request', body: 'Aarav Mehta: casual leave, 2 day(s)' });

  // Communication Hub: bulk SMS / WhatsApp / IVR, AI inbox and calls
  await seedHub({ co, leads, customers, agent });

  for (const u of [admin, manager, s1, s2, support, adsUser, hrUser, commUser, agent]) {
    await M.Notification.create({ company: co, user: u._id, title: 'Welcome to Smart CRM', body: 'Your workspace is loaded with demo data.' });
  }
  await M.Notification.create({ company: co, user: s1._id, title: 'Task overdue', body: 'Call Rohan Gupta about quotation' });
  await M.Notification.create({ company: co, user: manager._id, title: 'Hot lead', body: 'Neha Verma scored above 70' });

  console.log('Demo data ready. Sign in at http://localhost:%d with password %s', config.port, PASSWORD);
  console.table([admin, manager, s1, s2, support, adsUser, hrUser, commUser, agent].map((u) => ({ role: u.role, email: u.email })));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
