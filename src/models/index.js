const crypto = require('crypto');
const mongoose = require('mongoose');
const { phoneKey } = require('../utils/phone');
const { MODULE_KEYS } = require('../modules');

const { Schema } = mongoose;
const { ObjectId, Mixed } = Schema.Types;

const ROLES = ['super_admin', 'admin', 'manager', 'sales', 'support', 'ads_manager', 'hr_manager', 'comm_manager', 'telecaller'];
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost'];
const CHANNELS = ['email', 'whatsapp', 'sms', 'call', 'note'];

const opts = { timestamps: true };
const scoped = { company: { type: ObjectId, ref: 'Company', required: true, index: true } };

// Keeps phoneKey (last 10 digits) in sync so inbound SMS/WhatsApp/calls map to the right record.
const withPhoneKey = (s) => {
  s.add({ phoneKey: String });
  s.index({ company: 1, phoneKey: 1 });
  s.pre('save', function () { this.phoneKey = phoneKey(this.phone); });
  s.pre('insertMany', function (docs) { for (const d of [].concat(docs)) d.phoneKey = phoneKey(d.phone); });
};

function make(name, def, setup) {
  const schema = new Schema(def, opts);
  if (setup) setup(schema);
  return mongoose.model(name, schema);
}

// XXXX-XXXX-XXXX-XXXX from an alphabet without look-alike characters (0/O, 1/I).
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const activationKey = () => Array.from({ length: 4 }, () => Array.from(crypto.randomBytes(4), (b) => KEY_CHARS[b % 32]).join('')).join('-');

const Company = make('Company', {
  name: { type: String, required: true },
  apiKey: { type: String, default: () => crypto.randomBytes(24).toString('hex'), index: true },
  branches: [{ name: String, address: String }],
  settings: { type: Mixed, default: {} },
  // Licence, managed from the owner console (/owner.html).
  modules: { type: [{ type: String, enum: MODULE_KEYS }], default: () => [...MODULE_KEYS] },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  suspendReason: String,
  validUntil: Date, // empty = no expiry
  maxUsers: Number, // empty = unlimited
  maxDevices: Number, // desktop installs; empty = unlimited
  activationKey: { type: String, default: activationKey, index: true },
  // Client's own domains (crm.client.com -> CNAME to this server). Proven with a DNS TXT record.
  domains: [{ _id: false, host: { type: String, lowercase: true, trim: true }, token: String, verified: { type: Boolean, default: false }, verifiedAt: Date }],
  branding: { appName: String, color: String },
}, (s) => s.index({ 'domains.host': 1 }));

// Platform owner (you): manages every company from the owner console. Not tied to a company.
const Owner = make('Owner', {
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  active: { type: Boolean, default: true },
});

// A desktop install activated with the company's activation key.
const Device = make('Device', {
  ...scoped,
  deviceId: { type: String, required: true },
  secretHash: { type: String, select: false },
  name: String,
  platform: String,
  appVersion: String,
  lastSeenAt: Date,
  lastIp: String,
  revoked: { type: Boolean, default: false },
}, (s) => s.index({ company: 1, deviceId: 1 }, { unique: true }));

const User = make('User', {
  ...scoped,
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, default: 'sales' },
  branch: String,
  active: { type: Boolean, default: true },
  refreshTokens: { type: [String], select: false, default: [] },
  fcmToken: String,
});

const Pipeline = make('Pipeline', {
  ...scoped,
  name: { type: String, required: true },
  stages: [String],
  isDefault: { type: Boolean, default: false },
});

const Lead = make(
  'Lead',
  {
    ...scoped,
    name: { type: String, required: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    organization: String,
    source: { type: String, default: 'manual' },
    status: { type: String, enum: LEAD_STAGES, default: 'new' },
    lostReason: String,
    score: { type: Number, default: 0 },
    scoreReason: String,
    budget: Number,
    branch: String,
    assignedTo: { type: ObjectId, ref: 'User' },
    tags: [String],
    customFields: { type: Mixed, default: {} },
    notes: [{ text: String, by: { type: ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }],
    attachments: [{ name: String, url: String, at: { type: Date, default: Date.now } }],
    customer: { type: ObjectId, ref: 'Customer' },
    lastContactedAt: Date,
    adCampaign: { type: ObjectId, ref: 'AdCampaign', index: true },
  },
  (s) => { s.index({ company: 1, email: 1 }).index({ company: 1, phone: 1 }).index({ company: 1, status: 1 }); withPhoneKey(s); }
);

const Customer = make('Customer', {
  ...scoped,
  name: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  phone: String,
  organization: String,
  address: String,
  birthday: Date,
  anniversary: Date,
  lifecycle: { type: String, enum: ['prospect', 'active', 'at_risk', 'churned', 'vip'], default: 'active' },
  assignedTo: { type: ObjectId, ref: 'User' },
  tags: [String],
  customFields: { type: Mixed, default: {} },
  documents: [{ name: String, url: String, at: { type: Date, default: Date.now } }],
  purchases: [{ item: String, amount: Number, at: { type: Date, default: Date.now } }],
  lastActivityAt: { type: Date, default: Date.now },
  churnRisk: Number,
}, withPhoneKey);

const Deal = make('Deal', {
  ...scoped,
  title: { type: String, required: true },
  value: { type: Number, default: 0 },
  pipeline: { type: ObjectId, ref: 'Pipeline' },
  stage: { type: String, default: 'new' },
  status: { type: String, enum: ['open', 'won', 'lost'], default: 'open' },
  lead: { type: ObjectId, ref: 'Lead' },
  customer: { type: ObjectId, ref: 'Customer' },
  assignedTo: { type: ObjectId, ref: 'User' },
  probability: { type: Number, default: 10 },
  expectedCloseDate: Date,
  closedAt: Date,
  payments: [{ amount: Number, method: String, at: { type: Date, default: Date.now } }],
});

const Task = make('Task', {
  ...scoped,
  title: { type: String, required: true },
  description: String,
  type: { type: String, enum: ['follow_up', 'call', 'meeting', 'email', 'other'], default: 'follow_up' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: { type: String, enum: ['pending', 'in_progress', 'done', 'cancelled'], default: 'pending' },
  dueAt: Date,
  remindAt: Date,
  reminded: { type: Boolean, default: false },
  overdueNotified: { type: Boolean, default: false },
  recurrence: { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
  assignedTo: { type: ObjectId, ref: 'User' },
  relatedTo: { kind: { type: String, enum: ['Lead', 'Customer', 'Deal'] }, id: ObjectId },
  completedAt: Date,
});

const Communication = make(
  'Communication',
  {
    ...scoped,
    channel: { type: String, enum: CHANNELS, required: true },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
    subject: String,
    body: String,
    to: String,
    from: String,
    status: { type: String, default: 'sent' },
    sentiment: String,
    summary: String,
    durationSec: Number,
    relatedTo: { kind: { type: String, enum: ['Lead', 'Customer', 'Deal'] }, id: ObjectId },
    campaign: { type: ObjectId, ref: 'Campaign' },
    workflowRun: { type: ObjectId, ref: 'WorkflowRun' },
    by: { type: ObjectId, ref: 'User' },
    providerId: String, // message/call id at the SMS/WhatsApp/voice provider, used by delivery callbacks
    conversation: { type: ObjectId, ref: 'Conversation' },
    broadcast: { type: ObjectId, ref: 'Broadcast' },
    intent: String,
    call: { type: ObjectId, ref: 'IvrCall' },
    bot: { type: Boolean, default: false }, // written by the AI assistant
  },
  (s) => s.index({ company: 1, 'relatedTo.id': 1, createdAt: -1 }).index({ providerId: 1 }, { sparse: true }).index({ conversation: 1, createdAt: 1 })
);

const Template = make('Template', {
  ...scoped,
  name: { type: String, required: true },
  channel: { type: String, enum: ['email', 'whatsapp', 'sms'], required: true },
  subject: String,
  body: { type: String, required: true },
});

const Campaign = make('Campaign', {
  ...scoped,
  name: { type: String, required: true },
  channel: { type: String, enum: ['email', 'whatsapp', 'sms'], required: true },
  audience: { model: { type: String, enum: ['Lead', 'Customer'], default: 'Lead' }, filter: { type: Mixed, default: {} } },
  // One step = one-off blast; several steps with delayDays = drip/nurture sequence.
  steps: [{ delayDays: { type: Number, default: 0 }, subject: String, body: String }],
  status: { type: String, enum: ['draft', 'running', 'completed', 'paused'], default: 'draft' },
  stats: { type: Mixed, default: { enrolled: 0, sent: 0, failed: 0, replies: 0 } },
  cost: { type: Number, default: 0 },
  launchedAt: Date,
});

const CampaignEnrollment = make(
  'CampaignEnrollment',
  {
    ...scoped,
    campaign: { type: ObjectId, ref: 'Campaign', index: true },
    recipient: { kind: String, id: ObjectId },
    step: { type: Number, default: 0 },
    nextAt: Date,
    done: { type: Boolean, default: false },
  },
  (s) => s.index({ done: 1, nextAt: 1 })
);

const Workflow = make('Workflow', {
  ...scoped,
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  isTemplate: { type: Boolean, default: false },
  trigger: {
    event: { type: String, required: true },
    conditions: { type: [Mixed], default: [] },
  },
  // Steps are free-form objects validated by the engine (see services/automation.js).
  steps: { type: [Mixed], default: [] },
  stats: { type: Mixed, default: { runs: 0, completed: 0, failed: 0 } },
});

const WorkflowRun = make(
  'WorkflowRun',
  {
    ...scoped,
    workflow: { type: ObjectId, ref: 'Workflow', index: true },
    event: String,
    entity: { kind: String, id: ObjectId },
    status: { type: String, enum: ['running', 'waiting', 'completed', 'failed'], default: 'running' },
    cursor: { type: [Number], default: [] },
    branches: { type: [String], default: [] },
    resumeAt: Date,
    startedAtMs: Number,
    payload: Mixed, // event data (e.g. ad KPIs) so step conditions and templates can use payload.*
    log: [{ step: String, ok: Boolean, detail: String, at: { type: Date, default: Date.now } }],
    error: String,
  },
  (s) => s.index({ status: 1, resumeAt: 1 })
);

const Activity = make(
  'Activity',
  {
    ...scoped,
    entity: { kind: String, id: ObjectId },
    type: String,
    message: String,
    meta: Mixed,
    by: { type: ObjectId, ref: 'User' },
  },
  (s) => s.index({ company: 1, createdAt: -1 })
);

const AuditLog = make('AuditLog', {
  ...scoped,
  user: { type: ObjectId, ref: 'User' },
  method: String,
  path: String,
  resource: String,
  action: String,
  docId: String,
  status: Number,
  ip: String,
});

const Notification = make('Notification', {
  ...scoped,
  user: { type: ObjectId, ref: 'User', index: true },
  title: String,
  body: String,
  read: { type: Boolean, default: false },
  link: { kind: String, id: ObjectId },
});

const Webhook = make('Webhook', {
  ...scoped,
  url: { type: String, required: true },
  events: [String],
  secret: String,
  active: { type: Boolean, default: true },
});

const AdAccount = make('AdAccount', {
  ...scoped,
  platform: { type: String, enum: ['google', 'meta', 'linkedin', 'tiktok', 'youtube', 'x', 'other'], required: true },
  name: { type: String, required: true },
  accountId: String,
  currency: { type: String, default: 'INR' },
  monthlyBudget: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'paused', 'disconnected'], default: 'active' },
  // Ad network API connection (services/adsync.js). Credentials are an encrypted JSON blob.
  credentials: { type: String, select: false },
  connected: { type: Boolean, default: false },
  autoSync: { type: Boolean, default: true },
  autoPause: { type: Boolean, default: false }, // pause lead campaigns that spend with no leads
  lastSyncAt: Date,
  lastSyncError: String,
});

const AdCampaign = make('AdCampaign', {
  ...scoped,
  account: { type: ObjectId, ref: 'AdAccount', required: true },
  name: { type: String, required: true },
  objective: { type: String, enum: ['leads', 'sales', 'traffic', 'awareness', 'engagement'], default: 'leads' },
  status: { type: String, enum: ['draft', 'pending_approval', 'active', 'paused', 'ended'], default: 'draft' },
  dailyBudget: { type: Number, default: 0 },
  totalBudget: { type: Number, default: 0 },
  startDate: Date,
  endDate: Date,
  audience: {
    locations: [String], ageMin: Number, ageMax: Number, gender: { type: String, default: 'all' }, interests: [String],
  },
  utm: { source: String, medium: { type: String, default: 'cpc' }, campaign: String },
  notes: String,
  owner: { type: ObjectId, ref: 'User' },
  approvalNote: String,
  externalId: String, // campaign id on the ad network; set = linked, status/budget changes are pushed there
  externalBudgetId: String, // Google Ads campaign budget resource name
  syncError: String,
}, (s) => s.index({ company: 1, 'utm.campaign': 1 }).index({ company: 1, account: 1, externalId: 1 }));

const AdCreative = make('AdCreative', {
  ...scoped,
  campaign: { type: ObjectId, ref: 'AdCampaign', required: true, index: true },
  name: { type: String, required: true },
  variant: { type: String, default: 'A' },
  type: { type: String, enum: ['image', 'video', 'carousel', 'text'], default: 'image' },
  headline: String,
  body: String,
  cta: String,
  mediaUrl: String,
  landingUrl: String,
  status: { type: String, enum: ['active', 'paused', 'rejected'], default: 'active' },
});

// One row per campaign (and optionally creative) per day.
const AdMetric = make('AdMetric', {
  ...scoped,
  campaign: { type: ObjectId, ref: 'AdCampaign', required: true },
  creative: { type: ObjectId, ref: 'AdCreative', default: null },
  date: { type: Date, required: true },
  impressions: { type: Number, default: 0, min: 0 },
  clicks: { type: Number, default: 0, min: 0 },
  spend: { type: Number, default: 0, min: 0 },
  leads: { type: Number, default: 0, min: 0 },
  conversions: { type: Number, default: 0, min: 0 },
  revenue: { type: Number, default: 0, min: 0 },
}, (s) => s.index({ company: 1, campaign: 1, creative: 1, date: 1 }, { unique: true }).index({ company: 1, date: -1 }));

const Employee = make('Employee', {
  ...scoped,
  user: { type: ObjectId, ref: 'User' },
  employeeCode: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  phone: String,
  department: String,
  designation: String,
  branch: String,
  joinDate: { type: Date, required: true },
  exitDate: Date,
  birthday: Date,
  status: { type: String, enum: ['active', 'inactive', 'terminated'], default: 'active' },
  salary: {
    basic: { type: Number, default: 0, min: 0 }, hra: { type: Number, default: 0, min: 0 },
    allowances: { type: Number, default: 0, min: 0 }, otherDeductions: { type: Number, default: 0, min: 0 },
  },
  bank: { holder: String, account: String, ifsc: String, bankName: String },
}, (s) => s.index({ company: 1, employeeCode: 1 }, { unique: true }).index({ company: 1, user: 1 }));

const Attendance = make('Attendance', {
  ...scoped,
  employee: { type: ObjectId, ref: 'Employee', required: true },
  date: { type: Date, required: true }, // local calendar day stored as UTC midnight
  checkIn: Date,
  checkOut: Date,
  status: { type: String, enum: ['present', 'absent', 'half_day', 'leave', 'holiday', 'weekoff'], default: 'present' },
  leaveType: String,
  hoursWorked: { type: Number, default: 0 },
  late: { type: Boolean, default: false },
  source: { type: String, enum: ['self', 'manual', 'leave'], default: 'self' },
  note: String,
}, (s) => s.index({ company: 1, employee: 1, date: 1 }, { unique: true }).index({ company: 1, date: 1 }));

const LeaveRequest = make('LeaveRequest', {
  ...scoped,
  employee: { type: ObjectId, ref: 'Employee', required: true, index: true },
  type: { type: String, enum: ['casual', 'sick', 'earned', 'unpaid'], required: true },
  from: { type: Date, required: true },
  to: { type: Date, required: true },
  days: { type: Number, required: true },
  halfDay: { type: Boolean, default: false },
  reason: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  decidedBy: { type: ObjectId, ref: 'User' },
  decidedAt: Date,
  decisionNote: String,
});

const Holiday = make('Holiday', {
  ...scoped,
  date: { type: Date, required: true },
  name: { type: String, required: true },
}, (s) => s.index({ company: 1, date: 1 }, { unique: true }));

const PayrollRun = make('PayrollRun', {
  ...scoped,
  month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  status: { type: String, enum: ['draft', 'finalized', 'paid'], default: 'draft' },
  totals: { type: Mixed, default: {} },
  createdBy: { type: ObjectId, ref: 'User' },
  finalizedAt: Date,
  paidAt: Date,
}, (s) => s.index({ company: 1, month: 1 }, { unique: true }));

const Payslip = make('Payslip', {
  ...scoped,
  run: { type: ObjectId, ref: 'PayrollRun', required: true, index: true },
  employee: { type: ObjectId, ref: 'Employee', required: true, index: true },
  month: String,
  workingDays: Number,
  paidDays: Number,
  presentDays: Number,
  halfDays: Number,
  paidLeaveDays: Number,
  unpaidLeaveDays: Number,
  absentDays: Number,
  lateMarks: Number,
  gross: Number,
  earned: Number,
  lossOfPay: Number,
  pf: Number,
  tax: Number,
  otherDeductions: Number,
  adjustments: [{ label: String, amount: Number }],
  baseNet: Number,
  netPay: Number,
  snapshot: { name: String, employeeCode: String, department: String, designation: String },
});

// ================= Communication Hub (bulk SMS / WhatsApp / IVR + AI) =================
const HUB_CHANNELS = ['sms', 'whatsapp', 'voice'];

// One provider per channel per company. Credentials are an encrypted JSON blob (see services/providers.js).
const ChannelProvider = make('ChannelProvider', {
  ...scoped,
  channel: { type: String, enum: HUB_CHANNELS, required: true },
  provider: { type: String, enum: ['simulated', 'twilio', 'meta', 'http'], default: 'simulated' },
  from: String, // sender id / number
  active: { type: Boolean, default: true },
  credentials: { type: String, select: false },
  webhookToken: { type: String, default: () => crypto.randomBytes(20).toString('hex'), index: true },
  inboundFlow: { type: ObjectId, ref: 'IvrFlow' }, // voice: flow that answers inbound calls
  lastError: String,
}, (s) => s.index({ company: 1, channel: 1 }, { unique: true }));

// AI assistant settings, knowledge base and intent -> CRM action mapping. One per company.
const BotConfig = make('BotConfig', {
  company: { type: ObjectId, ref: 'Company', required: true, unique: true },
  channels: { sms: { type: Boolean, default: false }, whatsapp: { type: Boolean, default: false }, voice: { type: Boolean, default: false } },
  name: { type: String, default: 'Aria' },
  persona: { type: String, default: '' }, // what the business does and what the bot should achieve
  tone: { type: String, default: 'friendly and professional' },
  language: { type: String, default: 'auto' },
  knowledge: [{ q: String, a: String }],
  minConfidence: { type: Number, default: 0.5, min: 0, max: 1 },
  maxBotTurns: { type: Number, default: 6, min: 1, max: 50 },
  autoCreateLeads: { type: Boolean, default: true },
  handoffRoles: { type: [String], default: ['telecaller', 'support', 'sales'] },
  optOutKeywords: { type: [String], default: ['stop', 'unsubscribe', 'stop all', 'opt out', 'optout', 'band karo', 'mat bhejo'] },
  optOutReply: { type: String, default: 'You have been unsubscribed and will not receive further messages.' },
  handoffReply: { type: String, default: 'Thanks! I am connecting you with a member of our team, they will reply here shortly.' },
  intentActions: { type: Mixed, default: null }, // { intent: [action] }; null = defaults from services/bot.js
});

const Broadcast = make('Broadcast', {
  ...scoped,
  name: { type: String, required: true },
  channel: { type: String, enum: ['sms', 'whatsapp', 'ivr'], required: true },
  body: String, // sms / whatsapp text; supports {{person.name}} and CSV columns as {{vars.column}}
  template: { type: ObjectId, ref: 'Template' },
  mediaUrl: String,
  waTemplate: { name: String, language: { type: String, default: 'en' }, params: [String] }, // approved WhatsApp template
  ivrFlow: { type: ObjectId, ref: 'IvrFlow' },
  scheduledAt: Date,
  ratePerMinute: { type: Number, default: 60, min: 1, max: 2000 },
  costPerUnit: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'], default: 'draft' },
  stats: { type: Mixed, default: {} },
  createdBy: { type: ObjectId, ref: 'User' },
  launchedAt: Date,
  completedAt: Date,
});

const BroadcastRecipient = make('BroadcastRecipient', {
  ...scoped,
  broadcast: { type: ObjectId, ref: 'Broadcast', required: true },
  phone: { type: String, required: true },
  name: String,
  contact: { kind: { type: String, enum: ['Lead', 'Customer'] }, id: ObjectId },
  vars: { type: Mixed, default: {} },
  status: { type: String, enum: ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'], default: 'queued' },
  error: String,
  providerId: String,
  comm: { type: ObjectId, ref: 'Communication' },
  call: { type: ObjectId, ref: 'IvrCall' },
  replied: { type: Boolean, default: false },
  answered: { type: Boolean, default: false },
  optedOut: { type: Boolean, default: false },
  claimedAt: Date,
  sentAt: Date,
}, (s) => s.index({ broadcast: 1, phone: 1 }, { unique: true }).index({ broadcast: 1, status: 1 }).index({ company: 1, phone: 1, sentAt: -1 }));

// A chat thread with one phone number on one channel. mode=bot: the AI answers; mode=human: an agent does.
const Conversation = make('Conversation', {
  ...scoped,
  channel: { type: String, enum: ['sms', 'whatsapp'], required: true },
  phone: { type: String, required: true },
  name: String,
  contact: { kind: { type: String, enum: ['Lead', 'Customer'] }, id: ObjectId },
  mode: { type: String, enum: ['bot', 'human'], default: 'bot' },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  assignedTo: { type: ObjectId, ref: 'User' },
  lastMessage: String,
  lastDirection: String,
  lastMessageAt: Date,
  unread: { type: Number, default: 0 },
  intent: String,
  sentiment: String,
  botTurns: { type: Number, default: 0 },
  appliedIntents: { type: [String], default: [] },
  handoffReason: String,
  handoffAt: Date,
  broadcast: { type: ObjectId, ref: 'Broadcast' },
}, (s) => s.index({ company: 1, channel: 1, phone: 1 }, { unique: true }).index({ company: 1, status: 1, lastMessageAt: -1 }));

// IVR call flow: nodes of type say | menu | ai | transfer | voicemail | hangup. See services/ivr.js.
const IvrFlow = make('IvrFlow', {
  ...scoped,
  name: { type: String, required: true },
  description: String,
  active: { type: Boolean, default: true },
  isDefaultInbound: { type: Boolean, default: false },
  start: { type: String, required: true },
  voice: { type: String, default: 'Polly.Aditi' },
  language: { type: String, default: 'en-IN' },
  nodes: { type: [Mixed], default: [] },
});

const IvrCall = make('IvrCall', {
  ...scoped,
  flow: { type: ObjectId, ref: 'IvrFlow' },
  direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
  phone: String, // the customer's number
  contact: { kind: { type: String, enum: ['Lead', 'Customer'] }, id: ObjectId },
  broadcast: { type: ObjectId, ref: 'Broadcast' },
  recipient: { type: ObjectId, ref: 'BroadcastRecipient' },
  providerId: { type: String, index: true },
  simulated: { type: Boolean, default: false },
  status: { type: String, enum: ['queued', 'ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'simulated'], default: 'queued' },
  currentNode: String,
  path: [{ node: String, input: String, at: { type: Date, default: Date.now } }],
  transcript: [{ role: { type: String, enum: ['bot', 'caller', 'system'] }, text: String, at: { type: Date, default: Date.now } }],
  retries: { type: Mixed, default: {} },
  aiTurns: { type: Number, default: 0 },
  digits: { type: String, default: '' },
  intent: String,
  appliedIntents: { type: [String], default: [] },
  sentiment: String,
  summary: String,
  recordingUrl: String,
  durationSec: Number,
  startedAt: Date,
  endedAt: Date,
  finished: { type: Boolean, default: false },
}, (s) => s.index({ company: 1, createdAt: -1 }));

// Do-not-disturb list. Bulk sends, workflows and bot replies all skip these numbers.
const OptOut = make('OptOut', {
  ...scoped,
  phone: { type: String, required: true },
  channel: { type: String, enum: ['all', 'sms', 'whatsapp', 'voice'], default: 'all' },
  reason: String,
  source: { type: String, enum: ['keyword', 'manual', 'ivr', 'intent'], default: 'manual' },
}, (s) => s.index({ company: 1, phone: 1, channel: 1 }, { unique: true }));

module.exports = {
  ChannelProvider, BotConfig, Broadcast, BroadcastRecipient, Conversation, IvrFlow, IvrCall, OptOut, HUB_CHANNELS,
  Employee, Attendance, LeaveRequest, Holiday, PayrollRun, Payslip,
  AdAccount, AdCampaign, AdCreative, AdMetric,
  ROLES, LEAD_STAGES, CHANNELS,
  Company, Owner, Device, User, Pipeline, Lead, Customer, Deal, Task, Communication, Template,
  Campaign, CampaignEnrollment, Workflow, WorkflowRun, Activity, AuditLog, Notification, Webhook,
};
