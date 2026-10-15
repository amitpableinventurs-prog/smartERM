// Communication Hub demo data: providers (simulated), AI assistant + knowledge base, IVR flows,
// bulk SMS / WhatsApp / IVR broadcasts, AI-handled conversations and IVR calls. Called from seed.js.
// Uses the real services, so every message and call is mapped to CRM records and intent actions run.
const M = require('../src/models');
const bulk = require('../src/services/bulk');
const inbox = require('../src/services/inbox');
const ivr = require('../src/services/ivr');
const contacts = require('../src/services/contacts');

const DAY = 864e5;

// Moves documents (and their conversation/broadcast timestamps) back in time so the dashboard has history.
async function backdate(Model, filter, days, fields = ['createdAt']) {
  const ms = days * DAY;
  await Model.collection.updateMany(filter, [{ $set: Object.fromEntries(fields.map((f) => [f, { $subtract: [`$${f}`, ms] }])) }]);
}

module.exports = async function seedHub({ co, leads, customers, agent }) {
  for (const channel of M.HUB_CHANNELS) await M.ChannelProvider.create({ company: co, channel, provider: 'simulated' });

  await M.BotConfig.create({
    company: co, channels: { sms: true, whatsapp: true, voice: true }, name: 'Aria',
    persona: 'Acme Solutions (Mumbai & Delhi) sells Smart CRM, a sales and support CRM for small and medium businesses in India. Goal: answer questions, understand what the customer needs and book a free demo call with a specialist.',
    knowledge: [
      { q: 'What are your prices and plans?', a: 'Smart CRM plans: Starter ₹999 per user/month, Growth ₹1,999 per user/month (adds WhatsApp, bulk SMS and automation), Enterprise on request. Every plan has a 14-day free trial.' },
      { q: 'Do you offer a free trial or demo?', a: 'Yes! A 14-day free trial (no card needed) and a free 30-minute demo with a specialist. Shall I book the demo for you?' },
      { q: 'What are your support hours?', a: 'Support is available Monday to Saturday, 9 AM to 7 PM IST, on WhatsApp, phone and email.' },
      { q: 'Where is your office located?', a: 'Our head office is in Andheri East, Mumbai, with a branch in Connaught Place, Delhi.' },
      { q: 'Does it integrate with WhatsApp, Tally and Gmail?', a: 'Yes. Smart CRM connects to WhatsApp Business, SMS gateways, IVR, Gmail/Outlook and Tally.' },
      { q: 'What is the Diwali offer discount?', a: 'Diwali offer: 20% off the first year on any annual plan, valid till 15 November.' },
    ],
  });

  const inboundFlow = await M.IvrFlow.create({ company: co, ...ivr.SAMPLE_FLOW, name: 'Main menu (inbound)', description: 'Answers calls to the company number', isDefaultInbound: true,
    nodes: ivr.validateFlow({ start: ivr.SAMPLE_FLOW.start, nodes: ivr.SAMPLE_FLOW.nodes.map((n) => (n.type === 'transfer' ? { ...n, number: '+912240001234' } : n)) }) });
  const offerFlow = await M.IvrFlow.create({
    company: co, name: 'Diwali offer call (outbound)', description: 'Plays the offer, qualifies with AI, books call backs', start: 'intro',
    nodes: ivr.validateFlow({ start: 'intro', nodes: [
      { id: 'intro', type: 'say', text: 'Namaste! This is Aria from Acme Solutions. This Diwali, get 20 percent off the first year of Smart CRM.', next: 'menu' },
      { id: 'menu', type: 'menu', options: [
        { digit: '1', label: 'to know more', next: 'qualify', intent: 'interested' },
        { digit: '2', label: 'a call back from our team', next: 'cb', intent: 'callback' },
        { digit: '9', label: 'to stop these calls', next: 'dnd', intent: 'opt_out' },
      ] },
      { id: 'qualify', type: 'ai', text: 'Wonderful! How many people are in your sales team, and what would you like the CRM to do for you?', goal: 'Learn team size and needs, answer from the knowledge base, and book a demo call.', maxTurns: 3, next: 'bye' },
      { id: 'cb', type: 'hangup', text: 'Thank you! A specialist will call you back today. Happy Diwali!' },
      { id: 'dnd', type: 'hangup', text: 'Understood, we will not call you again. Happy Diwali!' },
      { id: 'bye', type: 'hangup', text: 'Thank you for your time. Happy Diwali!' },
    ] }),
  });

  await M.Template.create([
    { company: co, name: 'Diwali offer (WhatsApp)', channel: 'whatsapp', body: 'Hi {{person.name}} 🪔 Happy Diwali from Acme! Get 20% off the first year of Smart CRM till 15 Nov. Reply YES for a free demo, or STOP to opt out.' },
    { company: co, name: 'Demo reminder (SMS)', channel: 'sms', body: 'Hi {{person.name}}, reminder: your Smart CRM demo is tomorrow. Reply 1 to confirm or call us. -Acme' },
  ]);

  // ---- Bulk SMS, sent 5 days ago, with delivery reports and replies ----
  const sms = await M.Broadcast.create({ company: co, name: 'Diwali offer – open leads (SMS)', channel: 'sms', costPerUnit: 0.18, ratePerMinute: 500,
    body: 'Hi {{person.name}}, Diwali offer from Acme: 20% off Smart CRM till 15 Nov. Reply YES for a free demo. STOP to opt out.' });
  await bulk.addFromCrm(sms, { model: 'Lead', filter: { status: { $in: ['new', 'contacted', 'qualified'] } } });
  await contacts.optOut(co, leads[4].phone, { reason: 'Asked on a call', source: 'manual' });
  await bulk.launch(sms);
  const sent = await M.Communication.find({ broadcast: sms._id, status: 'simulated' });
  for (const [i, c] of sent.entries()) if (i % 5 !== 4) await inbox.deliveryStatus(co, c.providerId, i % 3 ? 'delivered' : 'failed', i % 3 ? undefined : 'Handset unreachable');

  // The telecaller owns a few leads, so their panel has chats of their own.
  await M.Lead.updateMany({ _id: { $in: [leads[0]._id, leads[5]._id, leads[7]._id] } }, { assignedTo: agent._id });

  // ---- AI conversations (WhatsApp / SMS) ----
  const say = (channel, from, body, name) => inbox.handleInbound({ company: co, channel, from, body, name });
  const L = (i) => leads[i].phone;
  const repliers = await M.BroadcastRecipient.find({ broadcast: sms._id, status: 'delivered' }).limit(3);
  for (const [i, r] of repliers.entries()) await say('sms', r.phone, ['YES interested', 'What is the price for 5 users?', 'Call me on Monday morning'][i]);
  await say('sms', L(0), 'YES interested');
  await say('whatsapp', L(0), 'Hi, what are your prices?');
  await say('whatsapp', L(0), 'Okay, please call me tomorrow at 11 am');
  await say('whatsapp', '+919820011122', 'Hello, do you have a free trial?', 'Farhan Qureshi');
  await say('whatsapp', '+919820011122', 'Yes I am interested, send details');
  const complaint = await say('whatsapp', customers[1].phone, 'The software is not working since morning, very disappointed');
  await inbox.agentReply(complaint.conversation, agent, 'Sorry about this! I have raised it with our tech team and will update you within the hour.');
  await say('sms', L(3), 'Not interested, thanks');
  await say('whatsapp', L(5), 'kitna price hai growth plan ka?');
  await say('whatsapp', '+919900112233', 'I want to talk to a person', 'Meenal Shah');
  await say('sms', '+919811122233', 'STOP');
  await say('whatsapp', L(7), 'Is there any Diwali discount?');
  await say('whatsapp', L(7), 'Great, book a demo for Friday evening');

  // ---- WhatsApp broadcast: draft ready to launch ----
  const wa = await M.Broadcast.create({ company: co, name: 'Diwali offer – customers (WhatsApp)', channel: 'whatsapp', costPerUnit: 0.8,
    body: 'Hi {{person.name}} 🪔 Happy Diwali from Acme! As a valued customer, renew now and get 20% off. Reply YES and we will send the details.' });
  await bulk.addFromCrm(wa, { model: 'Customer' });

  // ---- IVR broadcast 2 days ago: a few calls walked through the flow ----
  const ivrB = await M.Broadcast.create({ company: co, name: 'Diwali offer call – qualified leads', channel: 'ivr', ivrFlow: offerFlow._id, costPerUnit: 1.2, ratePerMinute: 100 });
  await bulk.addFromCrm(ivrB, { model: 'Lead', filter: { status: { $in: ['contacted', 'qualified', 'proposal_sent'] } } });
  await bulk.launch(ivrB);
  const calls = await M.IvrCall.find({ broadcast: ivrB._id }).sort('_id');
  const scripts = [
    [{ digits: '1' }, { speech: 'We are a team of 8 people, what is the price?' }, { speech: 'Okay, call me back tomorrow evening' }],
    [{ digits: '2' }],
    [{ digits: '9' }],
    [{ digits: '1' }, { speech: 'Does it work with WhatsApp?' }, { speech: 'Not interested right now' }],
  ];
  for (const [i, call] of calls.entries()) {
    const script = scripts[i];
    if (!script) { if (i % 2) await ivr.finishCall(call, { status: 'no_answer' }); continue; }
    await ivr.begin(call, offerFlow);
    for (const input of script) { if (call.finished) break; await ivr.step(call, offerFlow, call.currentNode, input); }
    if (!call.finished) await ivr.finishCall(call, { status: 'completed' });
    call.durationSec = 25 + i * 17; await call.save();
  }

  // ---- Inbound IVR calls ----
  for (const [phone, steps] of [
    [customers[2].phone, [{ digits: '2' }, { dialStatus: 'no-answer' }, { recordingUrl: 'simulated', speech: 'Please call me about my invoice' }]],
    ['+919765432100', [{ digits: '1' }, { speech: 'I run a coaching institute, do you have a free trial?' }, { speech: 'Yes please book a demo on Monday' }]],
  ]) {
    const call = await ivr.startInbound(co, inboundFlow, phone);
    await ivr.begin(call, inboundFlow);
    for (const input of steps) { if (call.finished) break; await ivr.step(call, inboundFlow, call.currentNode, input); }
    if (!call.finished) await ivr.finishCall(call, { status: 'completed' });
  }

  // History for the dashboard chart.
  await backdate(M.Communication, { broadcast: sms._id }, 5);
  await backdate(M.BroadcastRecipient, { broadcast: sms._id }, 5, ['sentAt', 'createdAt']);
  await backdate(M.Broadcast, { _id: sms._id }, 5, ['launchedAt', 'completedAt', 'createdAt']);
  await backdate(M.Communication, { broadcast: ivrB._id }, 2);
  await backdate(M.IvrCall, { broadcast: ivrB._id }, 2, ['createdAt', 'startedAt', 'endedAt']);
  await backdate(M.Broadcast, { _id: ivrB._id }, 2, ['launchedAt', 'completedAt', 'createdAt']);
  const convs = await M.Conversation.find({ company: co }).sort('_id');
  for (const [i, c] of convs.entries()) {
    const days = [3, 1, 0, 4, 2, 0, 1, 6][i % 8];
    if (!days) continue;
    await backdate(M.Communication, { conversation: c._id }, days);
    await backdate(M.Conversation, { _id: c._id }, days, ['lastMessageAt', 'createdAt']);
  }

  await new Promise((r) => setTimeout(r, 1500)); // let automations triggered by the events above finish
  return { flows: [inboundFlow, offerFlow], broadcasts: [sms, wa, ivrB] };
};
