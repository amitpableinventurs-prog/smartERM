const { z } = require('zod');
const { Workflow, WorkflowRun } = require('../models');
const { crud } = require('../utils/crud');
const { authorize } = require('../middleware/auth');
const { HttpError } = require('../utils/helpers');
const automation = require('../services/automation');

const STEP_TYPES = ['assign', 'send_email', 'send_whatsapp', 'send_sms', 'create_task', 'update_field', 'add_tag', 'notify', 'ai_score', 'wait', 'condition'];

const step = z.lazy(() =>
  z.object({ type: z.enum(STEP_TYPES), then: z.array(step).optional(), else: z.array(step).optional() }).passthrough()
);
const definition = z.object({
  name: z.string().min(1).optional(),
  active: z.boolean().optional(),
  trigger: z.object({ event: z.enum(automation.EVENTS), conditions: z.array(z.record(z.string(), z.any())).optional() }).optional(),
  steps: z.array(step).optional(),
}).passthrough();

// Reject malformed definitions at save time instead of failing mid-run.
const check = (data) => { definition.parse(data); };

const c = crud({
  Model: Workflow,
  resource: 'workflows',
  search: ['name'],
  filters: ['active', 'trigger.event'],
  scope: false,
  hooks: {
    beforeCreate(req, data) { check(data); delete data.stats; delete data.isTemplate; },
    beforeUpdate(req, doc, data) { check(data); delete data.stats; delete data.isTemplate; },
    async beforeDelete(req, wf) { await WorkflowRun.deleteMany({ workflow: wf._id, status: { $in: ['waiting', 'running'] } }); },
  },
});

c.router.get('/meta', authorize('workflows', 'r'), (_req, res) => res.json({ events: automation.EVENTS, stepTypes: STEP_TYPES, templates: automation.TEMPLATES }));

// Install one of the built-in workflow templates into this company (created inactive so it can be reviewed).
c.router.post('/from-template/:index', authorize('workflows', 'c'), async (req, res) => {
  const tpl = automation.TEMPLATES[+req.params.index];
  if (!tpl) throw new HttpError(404, 'Template not found');
  res.status(201).json(await Workflow.create({ ...JSON.parse(JSON.stringify(tpl)), company: req.companyId, active: false }));
});

c.router.post('/:id/toggle', authorize('workflows', 'u'), async (req, res) => {
  const wf = await c.find(req);
  wf.active = !wf.active;
  await wf.save();
  res.json(wf);
});

c.router.get('/:id/runs', authorize('workflows', 'r'), async (req, res) => {
  const wf = await c.find(req);
  res.json(await WorkflowRun.find({ company: req.companyId, workflow: wf._id }).sort('-createdAt').limit(50));
});

// Manually fire a workflow for one record (useful for testing a definition).
c.router.post('/:id/test', authorize('workflows', 'u'), async (req, res) => {
  const wf = await c.find(req);
  const { kind, id } = req.body;
  if (!['Lead', 'Customer', 'Deal', 'Task'].includes(kind) || !id) throw new HttpError(400, 'kind and id are required');
  res.json(await automation.trigger(req.companyId, wf.trigger.event, { kind, id }, { test: true }, wf._id));
});

module.exports = c.finish();
