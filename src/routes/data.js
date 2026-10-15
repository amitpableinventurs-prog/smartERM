const express = require('express');
const M = require('../models');
const { authorize, scopeFilter } = require('../middleware/auth');
const { HttpError, parseCsv, toCsv } = require('../utils/helpers');
const { emit } = require('../services/events');
const ai = require('../services/ai');

const router = express.Router();
router.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));

const MAX_ROWS = 5000;
const FIELDS = {
  leads: ['name', 'email', 'phone', 'organization', 'source', 'status', 'score', 'budget', 'branch', 'tags', 'createdAt'],
  customers: ['name', 'email', 'phone', 'organization', 'lifecycle', 'tags', 'createdAt'],
};

// POST /import/leads  (Content-Type: text/csv, or JSON {"csv": "..."})
router.post('/import/leads', authorize('import', 'c'), authorize('leads', 'c'), async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!text) throw new HttpError(400, 'Send CSV as text/csv body or JSON {"csv": "..."}');
  const rows = parseCsv(text);
  if (rows.length > MAX_ROWS) throw new HttpError(400, `Max ${MAX_ROWS} rows per import`);

  const existing = await M.Lead.find({ company: req.companyId }).select('email phone');
  const seen = new Set(existing.flatMap((l) => [l.email && `e:${l.email}`, l.phone && `p:${l.phone}`]).filter(Boolean));
  const created = [], skipped = [], errors = [];

  for (const [i, r] of rows.entries()) {
    const email = r.email?.toLowerCase();
    const keys = [email && `e:${email}`, r.phone && `p:${r.phone}`].filter(Boolean);
    if (!r.name) { errors.push({ row: i + 2, error: 'name is required' }); continue; }
    if (keys.some((k) => seen.has(k))) { skipped.push({ row: i + 2, reason: 'duplicate' }); continue; }
    const budget = r.budget ? +r.budget : undefined;
    const data = {
      company: req.companyId, name: r.name, email, phone: r.phone, organization: r.organization, source: r.source || 'import',
      branch: r.branch, budget: Number.isFinite(budget) ? budget : undefined, tags: r.tags ? r.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
      status: M.LEAD_STAGES.includes(r.status) ? r.status : 'new',
      assignedTo: req.user.role === 'sales' ? req.user._id : undefined,
    };
    try {
      const lead = new M.Lead(data);
      lead.score = ai.heuristicScore(lead).score; // bulk import uses the cheap scorer, not one LLM call per row
      await lead.save();
      keys.forEach((k) => seen.add(k));
      created.push(lead._id);
    } catch (e) {
      errors.push({ row: i + 2, error: e.message });
    }
  }
  created.forEach((id) => emit(req.companyId, 'lead.created', { kind: 'Lead', id }));
  res.status(201).json({ imported: created.length, skipped: skipped.length, failed: errors.length, skippedRows: skipped.slice(0, 50), errors: errors.slice(0, 50) });
});

for (const [name, Model] of [['leads', M.Lead], ['customers', M.Customer]]) {
  router.get(`/export/${name}`, authorize('export', 'r'), authorize(name, 'r'), async (req, res) => {
    const docs = await Model.find({ company: req.companyId, ...scopeFilter(req, name) }).limit(20000).lean();
    res.type('text/csv').attachment(`${name}.csv`).send(toCsv(docs, FIELDS[name]));
  });
}

module.exports = router;
