// End-to-end smoke test against an in-memory MongoDB. Run: npm test
process.env.NODE_ENV = 'test';
process.env.SCHEDULER_ENABLED = 'false';
process.env.WEBHOOK_SECRET = 'dev-webhook-secret';

const assert = require('assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let base, passed = 0;
async function call(method, path, body, token, raw) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'text/csv' } : body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Workflows run in the background after the request returns, so poll instead of sleeping a fixed time.
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for background work'); await sleep(100); }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const app = require('../src/app');
  const scheduler = require('../src/services/scheduler');
  const server = app.listen(0);
  base = `http://localhost:${server.address().port}`;

  let admin, salesTok, refresh, apiKey, leadId, salesId;

  await test('register company + login', async () => {
    const r = await call('POST', '/api/auth/register', { companyName: 'Acme', name: 'Ann Admin', email: 'ann@acme.test', password: 'password123' });
    assert.equal(r.status, 201);
    admin = r.body.accessToken; refresh = r.body.refreshToken; apiKey = r.body.company.apiKey;
    assert.equal((await call('POST', '/api/auth/login', { email: 'ann@acme.test', password: 'wrong-pass' })).status, 401);
  });

  await test('refresh token rotates and old one is rejected', async () => {
    const r = await call('POST', '/api/auth/refresh', { refreshToken: refresh });
    assert.equal(r.status, 200);
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: refresh })).status, 401);
  });

  await test('web panel is served', async () => {
    const r = await fetch(base + '/');
    assert(r.ok && (await r.text()).includes('Smart CRM'));
    assert((await fetch(base + '/app.js')).ok);
  });

  await test('unauthenticated requests are rejected', async () => assert.equal((await call('GET', '/api/leads')).status, 401));

  await test('create sales user and login', async () => {
    const r = await call('POST', '/api/users', { name: 'Sam Sales', email: 'sam@acme.test', password: 'password123', role: 'sales' }, admin);
    assert.equal(r.status, 201);
    salesId = r.body.id;
    salesTok = (await call('POST', '/api/auth/login', { email: 'sam@acme.test', password: 'password123' })).body.accessToken;
    assert(salesTok);
  });

  await test('automation: lead.created workflow assigns, messages, tasks, waits, then resumes', async () => {
    const wf = await call('POST', '/api/workflows', {
      name: 'Welcome', trigger: { event: 'lead.created' },
      steps: [
        { type: 'assign', strategy: 'least_loaded' },
        { type: 'send_whatsapp', body: 'Hi {{person.name}}!' },
        { type: 'create_task', title: 'Call {{person.name}}', dueInDays: 1 },
        { type: 'wait', minutes: 0 },
        { type: 'condition', if: { type: 'no_reply' }, then: [{ type: 'notify', to: 'owner', title: 'No reply from {{person.name}}' }], else: [] },
      ],
    }, admin);
    assert.equal(wf.status, 201, JSON.stringify(wf.body));
    const lead = await call('POST', '/api/leads', { name: 'Lola Lead', email: 'lola@x.test', phone: '+15550001', source: 'website', budget: 8000 }, admin);
    assert.equal(lead.status, 201);
    leadId = lead.body._id;
    assert(lead.body.score > 0, 'lead should be scored');
    let runs = await waitFor(async () => { const r = (await call('GET', `/api/workflows/${wf.body._id}/runs`, null, admin)).body; return r[0]?.status === 'waiting' && r; });
    assert.equal(runs[0].status, 'waiting', JSON.stringify(runs[0]));
    await scheduler.tick();
    runs = (await call('GET', `/api/workflows/${wf.body._id}/runs`, null, admin)).body;
    assert.equal(runs[0].status, 'completed', JSON.stringify(runs[0]));
    assert(runs[0].log.some((l) => l.step === 'condition' && l.detail === 'then'));
    const l = (await call('GET', `/api/leads/${leadId}`, null, admin)).body;
    assert.equal(l.assignedTo._id, salesId);
    const tl = (await call('GET', `/api/leads/${leadId}/timeline`, null, admin)).body;
    assert(tl.some((t) => t.type === 'whatsapp.outbound') && tl.some((t) => t.kind === 'task'));
    const notes = (await call('GET', '/api/notifications', null, salesTok)).body;
    assert(notes.data.some((n) => n.title.startsWith('No reply from Lola')));
  });

  await test('inbound reply makes no_reply condition false', async () => {
    const r = await call('POST', '/api/workflows', {
      name: 'Reply check', trigger: { event: 'lead.created' },
      steps: [{ type: 'wait', minutes: 0 }, { type: 'condition', if: { type: 'no_reply' }, then: [{ type: 'add_tag', tag: 'silent' }], else: [{ type: 'add_tag', tag: 'engaged' }] }],
    }, admin);
    const lead = (await call('POST', '/api/leads', { name: 'Rita Reply', phone: '+15550002' }, admin)).body;
    await waitFor(async () => (await call('GET', '/api/workflows', null, admin)).body.data.find((w) => w.name === 'Reply check')?.stats.runs >= 1);
    const hook = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'dev-webhook-secret' },
      body: JSON.stringify({ apiKey, from: 'whatsapp:+15550002', body: 'Great, I am interested!' }),
    });
    assert.equal(hook.status, 201);
    await scheduler.tick();
    const got = (await call('GET', `/api/leads/${lead._id}`, null, admin)).body;
    assert(got.tags.includes('engaged'), `tags: ${got.tags}`);
    assert.equal(r.status, 201);
  });

  await test('duplicate lead detection', async () => {
    const r = await call('POST', '/api/leads', { name: 'Lola Again', email: 'LOLA@x.test' }, admin);
    assert.equal(r.status, 409);
    assert.equal((await call('POST', '/api/leads?force=true', { name: 'Lola Again', email: 'lola@x.test' }, admin)).status, 201);
    assert.equal((await call('GET', '/api/leads/duplicates', null, admin)).body.byEmail.length, 1);
  });

  await test('RBAC: sales cannot delete, only sees own leads, cannot reassign', async () => {
    // let the lead.created workflow finish assigning every lead first
    await waitFor(async () => { const a = (await call('GET', '/api/leads?limit=100', null, admin)).body.data; return a.every((l) => l.assignedTo); });
    assert.equal((await call('DELETE', `/api/leads/${leadId}`, null, salesTok)).status, 403);
    const mine = (await call('GET', '/api/leads', null, salesTok)).body;
    const me = (await call('GET', '/api/auth/me', null, admin)).body;
    const first = mine.data[0]._id;
    assert.equal((await call('POST', `/api/leads/${first}/assign`, { userId: me.id }, admin)).status, 200);
    const all = (await call('GET', '/api/leads', null, admin)).body;
    const mine2 = (await call('GET', '/api/leads', null, salesTok)).body;
    assert.equal(mine2.total, mine.total - 1);
    assert(mine2.total < all.total, 'sales should see only assigned leads');
    assert(mine2.data.every((x) => x.assignedTo._id === salesId));
    assert.equal((await call('POST', `/api/leads/${leadId}/assign`, { userId: salesId }, salesTok)).status, 403);
    assert.equal((await call('GET', '/api/audit-logs', null, salesTok)).status, 403);
  });

  await test('status change, convert, deal pipeline, win, payment', async () => {
    assert.equal((await call('PATCH', `/api/leads/${leadId}`, { status: 'qualified' }, salesTok)).status, 200);
    const conv = await call('POST', `/api/leads/${leadId}/convert`, {}, admin);
    assert.equal(conv.status, 201);
    const deal = await call('POST', '/api/deals', { title: 'Big deal', value: 5000, customer: conv.body.customer._id, lead: leadId }, admin);
    assert.equal(deal.status, 201);
    assert.equal(deal.body.stage, 'new');
    const pipelines = (await call('GET', '/api/pipelines', null, admin)).body.data;
    const board = await call('GET', `/api/deals/board/${pipelines[0]._id}`, null, admin);
    assert.equal(board.body[0].count, 1);
    assert.equal((await call('POST', `/api/deals/${deal.body._id}/payments`, { amount: 1000 }, admin)).status, 201);
    assert.equal((await call('POST', `/api/deals/${deal.body._id}/win`, {}, admin)).status, 200);
    assert.equal((await call('POST', `/api/deals/${deal.body._id}/win`, {}, admin)).status, 409);
  });

  await test('tasks: recurring completion spawns next', async () => {
    const t = await call('POST', '/api/tasks', { title: 'Weekly sync', dueAt: new Date().toISOString(), recurrence: 'weekly' }, admin);
    const done = await call('POST', `/api/tasks/${t.body._id}/complete`, {}, admin);
    assert.equal(done.status, 200);
    assert(done.body.nextTask);
  });

  await test('csv import skips duplicates; export neutralises formulas', async () => {
    const csv = 'name,email,phone,source\nIvan Import,ivan@x.test,,import\nLola Dup,lola@x.test,,import\n=EVIL(),evil@x.test,,import\n';
    const r = await call('POST', '/api/data/import/leads', csv, admin, true);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.imported, 2);
    assert.equal(r.body.skipped, 1);
    const exp = await call('GET', '/api/data/export/leads', null, admin);
    assert(exp.body.includes("'=EVIL()"));
  });

  await test('web form webhook creates a lead once', async () => {
    const post = () => fetch(`${base}/api/webhooks/form/${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Web Wendy', email: 'wendy@x.test' }) });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 200);
    assert.equal((await fetch(`${base}/api/webhooks/form/bad`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  });

  await test('campaign: drip enrolls audience and sends step 1', async () => {
    const c = await call('POST', '/api/campaigns', {
      name: 'Nurture', channel: 'email', audience: { model: 'Lead', filter: { source: 'import' } },
      steps: [{ delayDays: 0, subject: 'Hi {{person.name}}', body: 'Hello' }, { delayDays: 3, subject: 'Still there?', body: 'Ping' }],
    }, admin);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const l = await call('POST', `/api/campaigns/${c.body._id}/launch`, {}, admin);
    assert.equal(l.status, 200, JSON.stringify(l.body));
    assert.equal(l.body.stats.enrolled, 2); // Ivan + =EVIL()
    const a = (await call('GET', `/api/campaigns/${c.body._id}/analytics`, null, admin)).body;
    assert.equal(a.sent + a.failed, 2);
  });

  await test('AI: next best action, nl search, forecast, sentiment', async () => {
    const nba = await call('GET', `/api/ai/next-best-action/${leadId}`, null, admin);
    assert.equal(nba.status, 200);
    assert(nba.body.action);
    const s = await call('POST', '/api/ai/search', { query: 'import', model: 'Lead' }, admin);
    assert(s.body.results.length >= 2);
    assert.equal((await call('GET', '/api/ai/forecast', null, admin)).status, 200);
    assert.equal((await call('POST', '/api/ai/sentiment', { text: 'terrible, I want a refund' }, admin)).body.sentiment, 'negative');
  });

  await test('dashboard & reports', async () => {
    const d = (await call('GET', '/api/reports/dashboard', null, admin)).body;
    assert(d.totalLeads >= 4 && d.wonDeals === 1 && d.salesRevenue === 5000, JSON.stringify(d));
    for (const p of ['leads-by-source', 'funnel', 'revenue', 'conversion', 'team', 'campaigns', 'automation']) {
      assert.equal((await call('GET', `/api/reports/${p}`, null, admin)).status, 200, p);
    }
  });

  await test('ads: approval flow, metrics, auto-pause, attribution, creatives, insights, RBAC', async () => {
    const mk = await call('POST', '/api/users', { name: 'Ada Ads', email: 'ads@acme.test', password: 'password123', role: 'ads_manager' }, admin);
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const adsTok = (await call('POST', '/api/auth/login', { email: 'ads@acme.test', password: 'password123' })).body.accessToken;

    const acc = (await call('POST', '/api/ads/accounts', { platform: 'google', name: 'Google Ads', monthlyBudget: 100000 }, adsTok)).body;
    assert(acc._id);
    const big = (await call('POST', '/api/ads/campaigns', { account: acc._id, name: 'Big Spend', dailyBudget: 20000, totalBudget: 1000 }, adsTok)).body;
    assert.equal(big.status, 'draft');
    assert(big.utm.campaign, 'utm code generated');
    const launched = await call('POST', `/api/ads/campaigns/${big._id}/launch`, {}, adsTok);
    assert.equal(launched.body.status, 'pending_approval');
    assert.equal((await call('POST', `/api/ads/campaigns/${big._id}/approve`, {}, adsTok)).status, 403);
    assert.equal((await call('POST', `/api/ads/campaigns/${big._id}/approve`, {}, admin)).body.status, 'active');

    const camp = (await call('POST', '/api/ads/campaigns', { account: acc._id, name: 'Summer Sale', dailyBudget: 1000, objective: 'leads' }, adsTok)).body;
    assert.equal((await call('POST', `/api/ads/campaigns/${camp._id}/launch`, {}, adsTok)).body.status, 'active');

    const today = new Date().toISOString().slice(0, 10);
    const row = { campaign: camp._id, date: today, impressions: 1000, clicks: 50, spend: 400, leads: 5, revenue: 2000 };
    assert.equal((await call('POST', '/api/ads/metrics', row, adsTok)).status, 201);
    assert.equal((await call('POST', '/api/ads/metrics', { ...row, spend: 450 }, adsTok)).status, 201); // same day = update, not duplicate
    assert.equal((await call('POST', '/api/ads/metrics', { ...row, clicks: 5000 }, adsTok)).status, 400); // clicks > impressions
    let ov = (await call('GET', '/api/ads/overview?days=7', null, adsTok)).body;
    assert.equal(ov.totals.spend, 450);
    assert.equal(ov.totals.ctr, 5);
    assert.equal(ov.totals.cpl, 90);
    assert.equal(ov.totals.roas, 4.44);

    const d1 = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const csv = `date,campaign,impressions,clicks,spend,leads,conversions,revenue\n${d1},Summer Sale,2000,40,300,2,1,500\n${d1},Nope,1,1,1,0,0,0\n`;
    const imp = await call('POST', '/api/ads/metrics/import', csv, adsTok, true);
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    assert.equal(imp.body.saved, 1);
    assert.equal(imp.body.failed, 1);

    // lifetime budget (1000) exceeded -> auto-pause
    await call('POST', '/api/ads/metrics', { campaign: big._id, date: today, impressions: 10, clicks: 1, spend: 1200 }, adsTok);
    const bigNow = (await call('GET', `/api/ads/campaigns/${big._id}`, null, adsTok)).body;
    assert.equal(bigNow.status, 'paused');

    // attribution via tracked form post
    const post = await fetch(`${base}/api/webhooks/form/${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ad Aarti', email: 'aarti@x.test', utm_campaign: camp.utm.campaign }) });
    assert.equal(post.status, 201);
    const attr = (await call('GET', '/api/ads/attribution', null, adsTok)).body;
    const mine = attr.find((a) => a.id === camp._id);
    assert.equal(mine.crmLeads, 1);
    assert((await call('GET', `/api/leads?adCampaign=${camp._id}`, null, adsTok)).body.total === 1);

    const utm = (await call('GET', `/api/ads/campaigns/${camp._id}/utm?url=https://acme.test/lp`, null, adsTok)).body;
    assert(utm.url.includes('utm_campaign=' + camp.utm.campaign));
    assert.equal((await call('GET', `/api/ads/campaigns/${camp._id}/utm?url=javascript:alert(1)`, null, adsTok)).status, 400);

    // A/B creatives
    const a = (await call('POST', '/api/ads/creatives', { campaign: camp._id, name: 'Img A', variant: 'A', headline: 'Save 20%' }, adsTok)).body;
    const b = (await call('POST', '/api/ads/creatives', { campaign: camp._id, name: 'Vid B', variant: 'B', type: 'video' }, adsTok)).body;
    const d2 = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    await call('POST', '/api/ads/metrics', { campaign: camp._id, creative: a._id, date: d2, impressions: 1000, clicks: 20, spend: 100 }, adsTok);
    await call('POST', '/api/ads/metrics', { campaign: camp._id, creative: b._id, date: d2, impressions: 1000, clicks: 60, spend: 100 }, adsTok);
    const cmp = (await call('GET', `/api/ads/creatives/compare/${camp._id}`, null, adsTok)).body;
    assert.equal(cmp.winner.variant, 'B');

    const ins = await call('GET', '/api/ads/insights', null, adsTok);
    assert.equal(ins.status, 200);
    assert(Array.isArray(ins.body.insights));
    const perf = await call('GET', `/api/ads/campaigns/${camp._id}/performance?days=7`, null, adsTok);
    assert.equal(perf.status, 200);
    assert.equal(perf.body.crmLeads, 1);

    // permissions
    assert.equal((await call('GET', '/api/ads/overview', null, salesTok)).status, 403);
    assert.equal((await call('POST', '/api/users', { name: 'X Y', email: 'x@y.test', password: 'password123', role: 'sales' }, adsTok)).status, 403);
    assert.equal((await call('POST', '/api/leads', { name: 'Nope' }, adsTok)).status, 403);
    assert.equal((await call('GET', '/api/leads', null, adsTok)).status, 200);
    const cl = await call('POST', `/api/ads/campaigns/${camp._id}/clone`, {}, adsTok);
    assert.equal(cl.status, 201);
    assert.notEqual(cl.body.utm.campaign, camp.utm.campaign);
  });

  await test('hr: employees, punching, attendance, leave, payroll, self-service, RBAC', async () => {
    const M = require('../src/models');
    const mk = await call('POST', '/api/users', { name: 'Hema HR', email: 'hr@acme.test', password: 'password123', role: 'hr_manager' }, admin);
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const hrTok = (await call('POST', '/api/auth/login', { email: 'hr@acme.test', password: 'password123' })).body.accessToken;

    // every day is a working day and local day == UTC day, so the test does not depend on weekdays or timezone
    assert.equal((await call('PATCH', '/api/hr/settings', { weekOff: [], tzOffsetMinutes: 0 }, hrTok)).status, 200);
    assert.equal((await call('PATCH', '/api/hr/settings', { pfRate: 500 }, hrTok)).status, 400);

    const now = new Date();
    const pm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const daysInPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
    const dstr = (d) => `${pm}-${String(d).padStart(2, '0')}`;
    const joined = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString();
    const salary = { basic: 30000, hra: 12000, allowances: 8000 }; // gross 50,000

    const A = (await call('POST', '/api/hr/employees', { name: 'Sam Sales', email: 'sam@acme.test', department: 'Sales', joinDate: joined, salary }, hrTok)).body;
    const B = (await call('POST', '/api/hr/employees', { name: 'Bela Backoffice', department: 'Ops', joinDate: joined, salary, bank: { account: '1234567890', ifsc: 'HDFC0001' } }, hrTok)).body;
    assert(A.employeeCode && B.employeeCode && A.employeeCode !== B.employeeCode);
    assert(A.user, 'employee is linked to the login with the same email');
    assert.equal((await call('GET', '/api/hr/employees', null, salesTok)).status, 403);

    // self-service punching
    assert.equal((await call('GET', '/api/me/profile', null, admin)).status, 404); // admin has no employee record
    assert.equal((await call('POST', '/api/me/punch-in', {}, salesTok)).status, 201);
    assert.equal((await call('POST', '/api/me/punch-in', {}, salesTok)).status, 409);
    const out = await call('POST', '/api/me/punch-out', {}, salesTok);
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'half_day'); // seconds worked is far below a full day
    assert.equal((await call('POST', '/api/me/punch-out', {}, salesTok)).status, 409);
    const roster = (await call('GET', '/api/hr/attendance/roster', null, hrTok)).body;
    assert.equal(roster.summary.half_day, 1);
    assert.equal(roster.summary.not_marked, 1);

    // manual entry with times
    const today = now.toISOString().slice(0, 10);
    assert.equal((await call('POST', '/api/hr/attendance/mark', { employee: B._id, date: today, checkIn: `${today}T03:00:00Z`, checkOut: `${today}T12:00:00Z` }, hrTok)).status, 201);
    const rb = (await call('GET', '/api/hr/attendance/roster', null, hrTok)).body.rows.find((r) => r.employee.name === 'Bela Backoffice');
    assert.equal(rb.status, 'present');
    assert.equal(rb.hours, 9);
    assert.equal((await call('POST', '/api/hr/attendance/mark', { employee: B._id, date: today, checkIn: `${today}T12:00:00Z`, checkOut: `${today}T03:00:00Z` }, hrTok)).status, 400);

    // holiday + leave (Sam: 2 paid casual days in the previous month)
    assert.equal((await call('POST', '/api/hr/holidays', { date: dstr(10), name: 'Test Holiday' }, hrTok)).status, 201);
    assert.equal((await call('POST', '/api/hr/holidays', { date: dstr(10), name: 'Dup' }, hrTok)).status, 409);
    const lv = await call('POST', '/api/me/leaves', { type: 'casual', from: dstr(3), to: dstr(4), reason: 'family' }, salesTok);
    assert.equal(lv.status, 201, JSON.stringify(lv.body));
    assert.equal(lv.body.days, 2);
    assert.equal((await call('POST', '/api/me/leaves', { type: 'sick', from: dstr(4), to: dstr(5) }, salesTok)).status, 409); // overlap
    assert.equal((await call('POST', '/api/me/leaves', { type: 'casual', from: dstr(12), to: dstr(28) }, salesTok)).status, 400); // beyond balance
    assert.equal((await call('POST', '/api/me/leaves', { type: 'casual', from: dstr(10), to: dstr(10) }, salesTok)).status, 400); // holiday only
    const bal = (await call('GET', '/api/me/balances', null, salesTok)).body;
    assert.equal(bal.casual.pending, 2);
    assert.equal((await call('POST', `/api/hr/leaves/${lv.body._id}/approve`, {}, hrTok)).body.status, 'approved');
    assert.equal((await call('POST', `/api/hr/leaves/${lv.body._id}/approve`, {}, hrTok)).status, 409);
    assert((await call('GET', '/api/me/attendance?month=' + pm, null, salesTok)).body.summary.paidLeave === 2);
    assert.equal((await call('POST', `/api/me/leaves/${lv.body._id}/cancel`, {}, salesTok)).status, 409); // already started: HR only

    // Bela is present every working day of last month except 4 absent days
    const workingDays = daysInPrev - 1; // minus the holiday
    const absentDays = [2, 5, 6, 7];
    const rows = [];
    for (let d = 1; d <= daysInPrev; d++) if (d !== 10 && !absentDays.includes(d)) rows.push({ company: A.company, employee: B._id, date: new Date(dstr(d)), status: 'present', source: 'manual' });
    await M.Attendance.insertMany(rows);

    // payroll
    assert.equal((await call('POST', '/api/hr/payroll/run', { month: '2999-01' }, hrTok)).status, 400);
    const run = await call('POST', '/api/hr/payroll/run', { month: pm }, hrTok);
    assert.equal(run.status, 201, JSON.stringify(run.body));
    let detail = (await call('GET', `/api/hr/payroll/runs/${run.body._id}`, null, hrTok)).body;
    const sb = detail.payslips.find((s) => s.snapshot.name === 'Bela Backoffice');
    const sa = detail.payslips.find((s) => s.snapshot.name === 'Sam Sales');
    assert.equal(sb.workingDays, workingDays);
    assert.equal(sb.paidDays, workingDays - 4);
    const ratio = (workingDays - 4) / workingDays;
    assert(Math.abs(sb.earned - 50000 * ratio) < 0.02, `earned ${sb.earned}`);
    assert(Math.abs(sb.pf - 30000 * ratio * 0.12) < 0.02);
    assert(Math.abs(sb.netPay - (50000 * ratio - 30000 * ratio * 0.12)) < 0.03);
    assert.equal(sa.paidLeaveDays, 2); // approved leave is paid; Sam has no other attendance last month
    assert.equal(sa.paidDays, 2);
    // re-running a draft replaces it
    const run2 = await call('POST', '/api/hr/payroll/run', { month: pm }, hrTok);
    assert.equal(run2.status, 201);
    detail = (await call('GET', `/api/hr/payroll/runs/${run2.body._id}`, null, hrTok)).body;
    assert.equal(detail.payslips.length, 2);
    // adjustments (bonus) while draft
    const slipB = detail.payslips.find((s) => s.snapshot.name === 'Bela Backoffice');
    const adj = await call('PATCH', `/api/hr/payroll/payslips/${slipB._id}`, { adjustments: [{ label: 'Bonus', amount: 1000 }] }, hrTok);
    assert.equal(adj.status, 200);
    assert(Math.abs(adj.body.netPay - (slipB.baseNet + 1000)) < 0.02);
    // employees cannot see payslips until the run is finalized
    assert.equal((await call('GET', '/api/me/payslips', null, salesTok)).body.length, 0);
    assert.equal((await call('POST', `/api/hr/payroll/runs/${run2.body._id}/paid`, {}, hrTok)).status, 409);
    assert.equal((await call('POST', `/api/hr/payroll/runs/${run2.body._id}/finalize`, {}, hrTok)).body.status, 'finalized');
    assert.equal((await call('PATCH', `/api/hr/payroll/payslips/${slipB._id}`, { adjustments: [] }, hrTok)).status, 409);
    assert.equal((await call('POST', '/api/hr/payroll/run', { month: pm }, hrTok)).status, 409);
    const mine = (await call('GET', '/api/me/payslips', null, salesTok)).body;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].snapshot.name, 'Sam Sales');
    assert.equal((await call('GET', `/api/me/payslips/${slipB._id}`, null, salesTok)).status, 404); // someone else's
    assert.equal((await call('GET', `/api/me/payslips/${mine[0]._id}`, null, salesTok)).status, 200);
    assert.equal((await call('POST', `/api/hr/payroll/runs/${run2.body._id}/paid`, {}, hrTok)).body.status, 'paid');
    const csv = await call('GET', `/api/hr/payroll/runs/${run2.body._id}/export`, null, hrTok);
    assert(typeof csv.body === 'string' && csv.body.includes('Bela Backoffice') && csv.body.includes('1234567890'));

    // views
    const month = (await call('GET', `/api/hr/attendance/monthly?month=${pm}`, null, hrTok)).body;
    assert.equal(month.grid.length, 2);
    const cellsB = month.grid.find((g) => g.employee.name === 'Bela Backoffice');
    assert.equal(cellsB.absent, 4);
    assert.equal(cellsB.cells[9], 'O'); // 10th = holiday
    const ov = (await call('GET', '/api/hr/overview', null, hrTok)).body;
    assert.equal(ov.headcount, 2);
    assert.equal((await call('GET', `/api/hr/employees/${B._id}/summary?month=${pm}`, null, hrTok)).status, 200);

    // permissions
    assert.equal((await call('GET', '/api/ads/overview', null, hrTok)).status, 403);
    assert.equal((await call('POST', '/api/leads', { name: 'No' }, hrTok)).status, 403);
    assert.equal((await call('GET', '/api/hr/overview', null, salesTok)).status, 403);
    assert.equal((await call('DELETE', `/api/hr/employees/${B._id}`, null, hrTok)).status, 409); // has payslips
  });

  // ================= Communication Hub =================
  const hookPath = (url) => new URL(url).pathname;
  const postJson = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const postForm = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  let smsHook, waHook, voiceHook, hubFlow;

  await test('hub: providers default to simulated and secrets are encrypted + masked', async () => {
    const list = (await call('GET', '/api/hub/providers', null, admin)).body;
    assert.deepEqual(list.map((p) => p.provider), ['simulated', 'simulated', 'simulated']);
    const r = await call('PUT', '/api/hub/providers/sms', { provider: 'twilio', from: '+15550000', config: { accountSid: 'AC123', authToken: 'supersecret99' } }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.config.authToken, '••••et99');
    assert.equal(r.body.config.accountSid, 'AC123');
    // sending the masked value back keeps the stored secret
    assert.equal((await call('PUT', '/api/hub/providers/sms', { provider: 'twilio', from: '+15550000', config: { accountSid: 'AC123', authToken: '••••et99' } }, admin)).status, 200);
    const stored = await mongoose.model('ChannelProvider').findOne({ channel: 'sms' }).select('+credentials');
    assert(!stored.credentials.includes('supersecret'));
    assert.equal(require('../src/services/providers').unseal(stored.credentials).authToken, 'supersecret99');
    assert.equal((await call('PUT', '/api/hub/providers/sms', { provider: 'meta', config: {} }, admin)).status, 400); // Meta is WhatsApp-only
    assert.equal((await call('PUT', '/api/hub/providers/whatsapp', { provider: 'meta', config: { phoneNumberId: '1' } }, admin)).status, 400); // token missing
    smsHook = hookPath((await call('PUT', '/api/hub/providers/sms', { provider: 'simulated' }, admin)).body.webhooks.inbound);
    waHook = hookPath((await call('PUT', '/api/hub/providers/whatsapp', { provider: 'simulated' }, admin)).body.webhooks.inbound);
    voiceHook = hookPath((await call('PUT', '/api/hub/providers/voice', { provider: 'simulated' }, admin)).body.webhooks.inbound);
    assert.equal((await postJson('/api/webhooks/comm/not-a-token/sms', { from: '+15551', body: 'x' })).status, 404);
  });

  await test('hub: bulk SMS maps CSV numbers to CRM leads, skips DND, tracks delivery and replies', async () => {
    // existing lead stored with a different number format must be matched, not duplicated
    const existing = (await call('POST', '/api/leads?force=true', { name: 'Bulk Bina', phone: '98765 43210' }, admin)).body;
    assert.equal((await call('POST', '/api/hub/optouts', { phone: '+91 9000000003' }, admin)).status, 201);
    const b = (await call('POST', '/api/hub/broadcasts', { name: 'Diwali SMS', channel: 'sms', body: 'Hi {{person.name}}, {{vars.offer}} off today!' }, admin)).body;
    const csv = 'Phone,Name,Offer\n+91-98765-43210,Bina B,20%\n9000000002,New Nikhil,15%\n9000000003,Dnd Dev,10%\nnot-a-number,Bad,1%\n9000000002,Dup,1%';
    const up = await call('POST', `/api/hub/broadcasts/${b._id}/recipients/csv`, csv, admin, true);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.deepEqual([up.body.added, up.body.created, up.body.matched, up.body.invalid], [3, 2, 1, 1]);
    const nikhil = (await call('GET', '/api/leads?q=New Nikhil', null, admin)).body.data[0];
    assert(nikhil && nikhil.tags.includes('bulk:Diwali SMS') && nikhil.source === 'bulk', JSON.stringify(nikhil));
    assert.equal((await call('GET', '/api/leads?q=Bina B', null, admin)).body.total, 0); // no duplicate lead

    const launched = await call('POST', `/api/hub/broadcasts/${b._id}/launch`, null, admin);
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    assert.equal(launched.body.status, 'completed');
    assert.equal(launched.body.stats.sent, 2);
    assert.equal(launched.body.stats.skipped, 1);
    const tl = (await call('GET', `/api/leads/${existing._id}/timeline`, null, admin)).body;
    assert(tl.some((t) => t.type === 'sms.outbound' && t.message === 'Hi Bulk Bina, 20% off today!'), JSON.stringify(tl.slice(0, 3)));

    // delivery receipt + a reply both land on the broadcast
    const sent = (await call('GET', `/api/hub/broadcasts/${b._id}/recipients?status=sent`, null, admin)).body.data;
    const bina = sent.find((r) => r.phone === '+919876543210');
    const smsStatus = smsHook.replace(/\/sms$/, '/status');
    assert.equal((await postJson(smsStatus, { id: bina.providerId, status: 'delivered' })).status, 200);
    const reply = await postJson(smsHook, { from: '9876543210', body: 'YES interested' });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.contact.id, existing._id); // mapped to the existing lead
    const rep = (await call('GET', `/api/hub/broadcasts/${b._id}/report`, null, admin)).body;
    assert.equal(rep.stats.delivered, 1);
    assert.equal(rep.stats.replied, 1);
    assert.equal((await call('POST', `/api/hub/broadcasts/${b._id}/launch`, null, admin)).status, 409);
  });

  await test('hub: AI bot answers from knowledge base, maps intents to CRM, hands off, honours STOP', async () => {
    const put = await call('PUT', '/api/hub/bot', { channels: { whatsapp: true, sms: true }, knowledge: [{ q: 'What is the price of your plans?', a: 'Plans start at Rs 999 per user per month.' }] }, admin);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const sandbox = (await call('POST', '/api/hub/bot/test', { text: 'kitna price hai?' }, admin)).body;
    assert.equal(sandbox.intent, 'pricing');
    assert(sandbox.reply.includes('999'));

    const send = (body, name) => postJson(waHook, { from: '+919111100001', body, name }).then((r) => r.body);
    let r = await send('Hi, what is the price?', 'Priya Prospect');
    assert.equal(r.intent, 'pricing');
    assert(r.reply.includes('999'), r.reply);
    assert.equal(r.createdLead, true);
    assert.equal(r.handoff, false);
    const leadId = r.contact.id;
    let lead = (await call('GET', `/api/leads/${leadId}`, null, admin)).body;
    assert.equal(lead.name, 'Priya Prospect');
    assert.equal(lead.source, 'whatsapp');
    assert(lead.tags.includes('asked-pricing'));

    r = await send('Yes, I am interested');
    assert.equal(r.intent, 'interested');
    lead = (await call('GET', `/api/leads/${leadId}`, null, admin)).body;
    assert.equal(lead.status, 'qualified');
    assert(lead.tags.includes('hot'));

    r = await send('Please call me tomorrow 11 am');
    assert.equal(r.intent, 'callback');
    const tasks = (await call('GET', '/api/tasks?limit=100', null, admin)).body.data;
    assert(tasks.some((t) => t.title.startsWith('Call back Priya Prospect') && t.title.includes('tomorrow')), tasks.map((t) => t.title).join(' | '));

    r = await send('This is terrible, I want a refund');
    assert.equal(r.intent, 'complaint');
    assert.equal(r.handoff, true);
    const conv = (await call('GET', `/api/hub/conversations/${r.conversation}`, null, admin)).body;
    assert.equal(conv.conversation.mode, 'human');
    assert(conv.conversation.assignedTo, 'assigned to an agent');
    assert(conv.messages.filter((m) => m.bot).length >= 4);

    r = await send('Hello?'); // a human owns the chat now: the bot stays quiet
    assert.equal(r.reply, null);
    assert.equal((await call('POST', `/api/hub/conversations/${conv.conversation._id}/reply`, { body: 'Sorry! Fixing it now.' }, admin)).status, 201);
    const mine = (await call('GET', '/api/hub/conversations?view=all', null, salesTok)).body;
    assert(mine.data.every((c) => String(c.assignedTo?._id || c.assignedTo) === String(salesId)));

    r = await send('STOP');
    assert.equal(r.intent, 'opt_out');
    assert.equal((await call('GET', '/api/hub/optouts?q=9111100001', null, admin)).body.total, 1);
    const blocked = await call('POST', '/api/communications/send', { channel: 'whatsapp', kind: 'Lead', id: leadId, body: 'promo' }, admin);
    assert.equal(blocked.status, 409); // DND enforced everywhere
  });

  await test('hub: IVR flow validation, simulator, intent mapping and call log', async () => {
    const sample = (await call('GET', '/api/hub/ivr/flows/meta/sample', null, admin)).body.sample;
    assert.equal((await call('POST', '/api/hub/ivr/flows', { ...sample, nodes: [...sample.nodes, { id: 'x', type: 'say', next: 'missing' }] }, admin)).status, 400);
    hubFlow = (await call('POST', '/api/hub/ivr/flows', { ...sample, isDefaultInbound: true }, admin)).body;
    assert(hubFlow._id, JSON.stringify(hubFlow));

    let s = (await call('POST', '/api/hub/ivr/simulate', { flowId: hubFlow._id, phone: '9222200002' }, admin)).body;
    const id = s.call._id;
    assert(s.verbs.some((v) => v.gather?.input === 'dtmf'));
    s = (await call('POST', `/api/hub/ivr/simulate/${id}`, { digits: '7' }, admin)).body;
    assert(s.verbs.some((v) => v.say?.includes('not a valid')));
    s = (await call('POST', `/api/hub/ivr/simulate/${id}`, { digits: '1' }, admin)).body;
    assert.equal(s.call.intent, 'interested');
    assert(s.verbs.some((v) => v.gather?.input === 'speech'));
    s = (await call('POST', `/api/hub/ivr/simulate/${id}`, { speech: 'Please call me back tomorrow evening' }, admin)).body;
    assert.equal(s.done, true);
    assert.equal(s.call.intent, 'callback');
    const c = (await call('GET', `/api/hub/ivr/calls/${id}`, null, admin)).body;
    assert.equal(c.status, 'completed');
    assert(c.summary);
    assert.equal(c.contact.kind, 'Lead');
    const lead = (await call('GET', `/api/leads/${c.contact.id}`, null, admin)).body;
    assert.equal(lead.source, 'ivr');
    assert.equal(lead.status, 'qualified'); // callback does not move it backwards
    assert((await call('GET', `/api/leads/${lead._id}/timeline`, null, admin)).body.some((t) => t.type === 'call.inbound'));

    // press 9 = opt out
    s = (await call('POST', '/api/hub/ivr/simulate', { flowId: hubFlow._id, phone: '9222200009' }, admin)).body;
    s = (await call('POST', `/api/hub/ivr/simulate/${s.call._id}`, { digits: '9' }, admin)).body;
    assert.equal(s.done, true);
    assert.equal((await call('GET', '/api/hub/optouts?q=9222200009', null, admin)).body.total, 1);
  });

  await test('hub: voice webhooks speak TwiML and IVR broadcasts place calls', async () => {
    let r = await postForm(voiceHook, { From: '+919444400004', CallSid: 'CA1' });
    assert.equal(r.status, 200);
    assert(r.text.includes('<Gather input="dtmf"') && r.text.includes('/voice/step?call='), r.text);
    const callId = /call=([a-f\d]{24})/.exec(r.text)[1];
    r = await postForm(`${voiceHook}/step?call=${callId}&node=menu`, { Digits: '3', CallSid: 'CA1' });
    assert(r.text.includes('<Hangup/>'), r.text);
    await postForm(`${voiceHook}/status`, { CallSid: 'CA1', CallStatus: 'completed', CallDuration: '42' });
    const logged = (await call('GET', `/api/hub/ivr/calls/${callId}`, null, admin)).body;
    assert.equal(logged.durationSec, 42);
    assert.equal(logged.intent, 'callback');

    const ib = (await call('POST', '/api/hub/broadcasts', { name: 'IVR blast', channel: 'ivr', ivrFlow: hubFlow._id }, admin)).body;
    await call('POST', `/api/hub/broadcasts/${ib._id}/recipients/csv`, 'phone\n9333300001\n9333300002', admin, true);
    const l = (await call('POST', `/api/hub/broadcasts/${ib._id}/launch`, null, admin)).body;
    assert.equal(l.stats.sent, 2, JSON.stringify(l.stats));
    const calls = (await call('GET', `/api/hub/ivr/calls?broadcast=${ib._id}`, null, admin)).body;
    assert.equal(calls.total, 2);
    assert(calls.data.every((x) => x.status === 'simulated'));
  });

  await test('hub: panels & permissions for comm_manager, telecaller and sales', async () => {
    const tok = {};
    for (const role of ['comm_manager', 'telecaller']) {
      assert.equal((await call('POST', '/api/users', { name: role, email: `${role}@acme.test`, password: 'password123', role }, admin)).status, 201);
      tok[role] = (await call('POST', '/api/auth/login', { email: `${role}@acme.test`, password: 'password123' })).body.accessToken;
    }
    const ov = await call('GET', '/api/hub/overview?days=7', null, tok.comm_manager);
    assert.equal(ov.status, 200);
    assert(ov.body.messages.outbound > 0 && ov.body.calls.total > 0 && ov.body.intents.length, JSON.stringify(ov.body.messages));
    assert.equal((await call('GET', '/api/hub/providers', null, tok.comm_manager)).status, 200);
    assert.equal((await call('POST', '/api/leads', { name: 'Nope' }, tok.comm_manager)).status, 403);
    assert.equal((await call('GET', '/api/hub/conversations', null, tok.telecaller)).status, 200);
    assert.equal((await call('GET', '/api/hub/providers', null, tok.telecaller)).status, 403);
    assert.equal((await call('POST', '/api/hub/broadcasts', { name: 'x', channel: 'sms', body: 'x' }, tok.telecaller)).status, 403);
    assert.equal((await call('GET', '/api/hub/broadcasts', null, salesTok)).status, 403);
    assert.equal((await call('POST', `/api/hub/ivr/simulate`, { flowId: hubFlow._id, phone: '9000' }, salesTok)).status, 403);
  });

  await test('tenant isolation', async () => {
    const other = (await call('POST', '/api/auth/register', { companyName: 'Other', name: 'Olga', email: 'olga@o.test', password: 'password123' })).body.accessToken;
    assert.equal((await call('GET', `/api/leads/${leadId}`, null, other)).status, 404);
    assert.equal((await call('GET', '/api/leads', null, other)).body.total, 0);
    assert.equal((await call('GET', '/api/hub/conversations?view=all', null, other)).body.total, 0);
    assert.equal((await call('GET', '/api/hub/broadcasts', null, other)).body.total, 0);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
})().catch((e) => { console.error(e); process.exit(1); });
