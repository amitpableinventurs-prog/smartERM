const express = require('express');
const { z } = require('zod');
const M = require('../models');
const { authorize, scopeFilter } = require('../middleware/auth');
const { validate } = require('../middleware/common');
const { HttpError } = require('../utils/helpers');
const ai = require('../services/ai');
const { timeline } = require('./shared');

const router = express.Router();
router.use(authorize('ai', 'r'));

const KINDS = { Lead: ['leads', M.Lead], Customer: ['customers', M.Customer] };

async function load(req, kind, id) {
  const [resource, Model] = KINDS[kind] || [];
  if (!Model) throw new HttpError(400, 'kind must be Lead or Customer');
  const doc = await Model.findOne({ _id: id, company: req.companyId, ...scopeFilter(req, resource) });
  if (!doc) throw new HttpError(404, `${kind} not found`);
  return doc;
}

router.get('/status', (_req, res) => res.json({ llmConfigured: ai.hasKey(), mode: ai.hasKey() ? 'llm' : 'heuristic' }));

router.post('/generate', validate(z.object({
  kind: z.enum(['Lead', 'Customer']), id: z.string().length(24),
  channel: z.enum(['email', 'whatsapp', 'sms']).default('email'),
  purpose: z.string().min(3).max(500), tone: z.string().max(40).optional(), context: z.string().max(2000).optional(),
})), async (req, res) => {
  const person = await load(req, req.body.kind, req.body.id);
  res.json(await ai.generateMessage({ ...req.body, person: person.toObject() }));
});

router.post('/suggest-reply', validate(z.object({ kind: z.enum(['Lead', 'Customer']), id: z.string().length(24), message: z.string().min(1).max(4000) })), async (req, res) => {
  const person = await load(req, req.body.kind, req.body.id);
  res.json(await ai.suggestReply(req.body.message, person.toObject()));
});

router.post('/sentiment', validate(z.object({ text: z.string().min(1).max(8000) })), async (req, res) => res.json(await ai.sentiment(req.body.text)));
router.post('/summarize', validate(z.object({ text: z.string().min(1).max(20000) })), async (req, res) => res.json(await ai.summarize(req.body.text)));

router.get('/next-best-action/:id', async (req, res) => {
  const lead = await load(req, 'Lead', req.params.id);
  const history = (await timeline(req.companyId, 'Lead', lead._id, 10)).map((t) => `${t.type}: ${t.message}`);
  res.json({ lead: { id: lead._id, name: lead.name, score: lead.score, status: lead.status }, ...(await ai.nextBestAction(lead.toObject(), history)) });
});

router.get('/forecast', async (req, res) => {
  const [open, monthly] = await Promise.all([
    M.Deal.find({ company: req.companyId, status: 'open' }).select('value probability'),
    M.Deal.aggregate([
      { $match: { company: req.companyId, status: 'won' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$closedAt' } }, revenue: { $sum: '$value' } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  res.json(ai.forecast(open, monthly.map((m) => ({ month: m._id, revenue: m.revenue }))));
});

router.get('/churn', async (req, res) => {
  const customers = await M.Customer.find({ company: req.companyId, ...scopeFilter(req, 'customers'), lifecycle: { $ne: 'churned' } }).limit(500);
  const scored = customers.map((c) => {
    const days = Math.floor((Date.now() - c.lastActivityAt) / 864e5);
    return { id: c._id, name: c.name, daysInactive: days, ...ai.churnRisk(c, days) };
  });
  res.json(scored.filter((s) => s.level !== 'low').sort((a, b) => b.risk - a.risk).slice(0, 50));
});

// Natural-language search, e.g. "hot leads from website with budget over 5000".
router.post('/search', validate(z.object({ query: z.string().min(2).max(300), model: z.enum(['Lead', 'Customer', 'Deal']).default('Lead') })), async (req, res) => {
  const { query, model } = req.body;
  const resource = { Lead: 'leads', Customer: 'customers', Deal: 'deals' }[model];
  const { filter, text, engine } = await ai.nlSearchFilter(query, model);
  const q = { company: req.companyId, ...scopeFilter(req, resource), ...filter };
  if (text) {
    const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = ai.SEARCHABLE[model].filter((f) => f !== 'tags').map((f) => ({ [f]: re }));
  }
  res.json({ interpretedAs: { filter, text }, engine, results: await M[model].find(q).limit(50) });
});

module.exports = router;
