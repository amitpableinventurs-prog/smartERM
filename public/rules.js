'use strict';
/* Input validation shared by the panels (window.Rules, checked before saving) and the API (require('../../public/rules'),
   checked again on every create/update), so both reject the same values with the same messages.

   A spec maps a field path to a rule: { t: type, req, label, min, max, int, opts, re, msg, past, future, item, minItems, maxItems }.
   Types: personName | title (must contain letters) | text | email | phone | url | number | date | enum | tags | id | pattern.
   A spec's $cross(get) returns [[path, message], ...] for checks that involve several fields. */
(function (root, factory) {
  const R = factory();
  if (typeof module === 'object' && module.exports) module.exports = R;
  else root.Rules = R;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const LETTER = /\p{L}/u;
  const PERSON = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’&/(),-]*$/u;
  const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
  const PHONE = /^\+?[\d\s().-]+$/;
  const OID = /^[a-f\d]{24}$/i;
  // The server allows a day of slack on "not in the past" so a browser in another time zone is never refused.
  const SLACK = typeof window === 'undefined' ? 864e5 : 0;

  const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const set = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((x, k) => (x == null ? x : x[k]), o); if (t != null) t[last] = v; };
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  const human = (p) => { const s = p.split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - SLACK; };
  const toDate = (v) => (v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : new Date(NaN));
  const same = (a, b, isDate) => {
    if (a == null || b == null) return a == b; // eslint-disable-line eqeqeq
    // Date inputs keep only minutes, so a saved 10:30:12.345 comes back as 10:30.
    if (isDate || a instanceof Date || b instanceof Date) return Math.floor(toDate(a).getTime() / 6e4) === Math.floor(toDate(b).getTime() / 6e4);
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
  };

  // Returns an error message, or null when the value is fine. Empty values are only checked for `req`.
  function checkValue(v, r, label) {
    const max = r.maxLen || (r.t === 'personName' ? 100 : 2000);
    const len = (s) => {
      if (r.minLen && s.length < r.minLen) return `${label} must be at least ${r.minLen} characters`;
      if (s.length > max) return `${label} is too long (max ${max} characters)`;
      return null;
    };
    switch (r.t) {
      case 'personName': {
        if (typeof v !== 'string') return `${label} must be text`;
        if (!PERSON.test(v)) return /\d/.test(v) ? `${label} cannot contain numbers` : `${label} can only contain letters, spaces and . ' -`;
        return len(v) || (v.replace(/[^\p{L}]/gu, '').length < 2 ? `${label} must be at least 2 letters` : null);
      }
      case 'title':
        if (typeof v !== 'string') return `${label} must be text`;
        if (!LETTER.test(v)) return `${label} must contain letters, not only numbers or symbols`;
        return len(v);
      case 'text':
        if (typeof v !== 'string') return `${label} must be text`;
        return len(v);
      case 'email':
        if (typeof v !== 'string' || v.length > 254 || !EMAIL.test(v)) return `${label} must be a valid email address, e.g. name@example.com`;
        return null;
      case 'phone': {
        const d = String(v).replace(/\D/g, '');
        if ((typeof v !== 'string' && typeof v !== 'number') || !PHONE.test(String(v)) || d.length < 7 || d.length > 15) return `${label} must be a valid phone number (7-15 digits, optional + country code, no letters)`;
        return null;
      }
      case 'url': {
        let u;
        try { u = new URL(String(v)); } catch { u = null; }
        if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return `${label} must be a full web address starting with http:// or https://`;
        return null;
      }
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (!Number.isFinite(n)) return `${label} must be a number`;
        if (r.int && !Number.isInteger(n)) return `${label} must be a whole number`;
        if (r.min != null && n < r.min) return `${label} must be ${r.min === 0 ? '0 or more' : `at least ${r.min}`}`;
        if (r.max != null && n > r.max) return `${label} must be at most ${r.max}`;
        return null;
      }
      case 'date': {
        const d = toDate(v);
        if (Number.isNaN(d.getTime()) || d.getFullYear() < 1900 || d.getFullYear() > 2100) return `${label} must be a valid date`;
        if (r.past === false && d.getTime() < startOfToday()) return `${label} cannot be in the past`;
        if (r.future === false && d.getTime() > Date.now() + SLACK) return `${label} cannot be in the future`;
        return null;
      }
      case 'enum':
        return r.opts.includes(v) ? null : `${label} must be one of: ${r.opts.join(', ')}`;
      case 'id':
        return typeof v === 'string' && OID.test(v) ? null : `Choose a valid ${label.toLowerCase()}`;
      case 'pattern':
        return typeof v === 'string' && r.re.test(v) ? null : r.msg || `${label} is not valid`;
      case 'tags': {
        const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
        if (!list) return `${label} must be a list`;
        if (r.minItems && list.length < r.minItems) return `${label}: add at least ${r.minItems}`;
        if (list.length > (r.maxItems || 50)) return `${label}: at most ${r.maxItems || 50} items`;
        for (const x of list) {
          if (typeof x !== 'string' || !x.trim()) return `${label} cannot contain empty items`;
          if (x.length > (r.maxLen || 50)) return `${label}: "${x.slice(0, 20)}…" is too long (max ${r.maxLen || 50} characters)`;
          if (!/[\p{L}\d]/u.test(x) || (r.item === 'title' && !LETTER.test(x))) return `${label}: "${x}" must contain letters`;
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Checks `data` against a spec (or a spec name). Trims string values in place.
   * opts.partial: an update; only the fields present are checked, required ones may not be cleared.
   * opts.current: the saved record (updates); unchanged values are not re-checked, and $cross sees the merged record.
   * Returns [{ path, message }].
   */
  function validate(data, spec, opts = {}) {
    if (typeof spec === 'string') spec = SPECS[spec];
    if (!spec || !data || typeof data !== 'object') return [];
    const errs = [];
    for (const [path, raw] of Object.entries(spec)) {
      if (path === '$cross') continue;
      const r = typeof raw === 'string' ? { t: raw } : raw;
      const label = r.label || human(path);
      let v = get(data, path);
      if (typeof v === 'string') { const t = v.trim(); if (t !== v) { set(data, path, t); v = t; } }
      if (empty(v)) {
        const present = path.split('.').length === 1 ? Object.prototype.hasOwnProperty.call(data, path) : v !== undefined;
        if (r.req && (!opts.partial || present)) errs.push({ path, message: `${label} is required` });
        continue;
      }
      if (opts.current && same(v, get(opts.current, path), r.t === 'date')) continue;
      const m = checkValue(v, r, label);
      if (m) errs.push({ path, message: m });
    }
    if (spec.$cross && !errs.length) {
      const pick = (p) => { const v = get(data, p); return v !== undefined ? v : opts.current ? get(opts.current, p) : undefined; };
      for (const [path, message] of spec.$cross(pick, opts) || []) errs.push({ path, message });
    }
    return errs;
  }

  const time = (v) => (empty(v) ? NaN : toDate(v).getTime());
  // [[at, msg]] when date a is after date b (both set).
  const order = (pick, a, b, at, msg) => (time(pick(a)) > time(pick(b)) ? [[at, msg]] : []);

  const name = { t: 'personName', req: true, label: 'Name', maxLen: 100 };
  const title = (label, maxLen = 120, req = true) => ({ t: 'title', req, label, maxLen });
  const money = (label, max = 1e12) => ({ t: 'number', min: 0, max, label });

  const SPECS = {
    lead: {
      name, email: { t: 'email', label: 'Email' }, phone: { t: 'phone', label: 'Phone' },
      organization: title('Organization', 120, false), budget: money('Budget'), branch: title('Branch', 60, false),
      score: { t: 'number', min: 0, max: 100, int: true, label: 'Score' }, tags: { t: 'tags', label: 'Tags' }, source: { t: 'text', label: 'Source', maxLen: 40 },
    },
    customer: {
      name, email: { t: 'email', label: 'Email' }, phone: { t: 'phone', label: 'Phone' },
      organization: title('Organization', 120, false), address: title('Address', 300, false),
      birthday: { t: 'date', future: false, label: 'Birthday' }, anniversary: { t: 'date', future: false, label: 'Anniversary' },
      tags: { t: 'tags', label: 'Tags' },
    },
    purchase: { item: title('Item', 120), amount: money('Amount') },
    deal: {
      title: title('Title'), value: money('Value'), probability: { t: 'number', min: 0, max: 100, label: 'Probability' },
      stage: { t: 'text', label: 'Stage', maxLen: 60 }, expectedCloseDate: { t: 'date', label: 'Expected close date' },
      lead: { t: 'id', label: 'Lead' }, customer: { t: 'id', label: 'Customer' },
    },
    task: {
      title: { t: 'title', req: true, label: 'Title', minLen: 3, maxLen: 150 }, description: { t: 'text', label: 'Description', maxLen: 2000 },
      dueAt: { t: 'date', req: true, past: false, label: 'Due date' }, remindAt: { t: 'date', label: 'Reminder' },
      assignedTo: { t: 'id', label: 'Assignee' },
      $cross: (pick) => order(pick, 'remindAt', 'dueAt', 'remindAt', 'Reminder must be before the due date'),
    },
    template: {
      name: title('Name', 80), channel: { t: 'enum', req: true, opts: ['email', 'whatsapp', 'sms'], label: 'Channel' },
      subject: title('Subject', 200, false), body: { t: 'title', req: true, label: 'Message', minLen: 2, maxLen: 4096 },
      $cross: (pick) => (pick('channel') === 'email' && empty(pick('subject')) ? [['subject', 'Subject is required for email templates']] : []),
    },
    campaign: { name: title('Name', 100), cost: money('Cost') },
    workflow: { name: title('Name', 100) },
    broadcast: {
      name: title('Name', 100), body: { t: 'title', label: 'Message', maxLen: 4096 }, mediaUrl: { t: 'url', label: 'Image URL' },
      ratePerMinute: { t: 'number', int: true, min: 1, max: 2000, label: 'Rate per minute' }, costPerUnit: { t: 'number', min: 0, max: 10000, label: 'Cost per unit' },
      scheduledAt: { t: 'date', past: false, label: 'Schedule' }, ivrFlow: { t: 'id', label: 'IVR flow' }, template: { t: 'id', label: 'Template' },
      'waTemplate.name': { t: 'pattern', re: /^[\w.-]{1,120}$/, msg: 'WhatsApp template name can only contain letters, digits, _ . -', label: 'Template name' },
      'waTemplate.language': { t: 'pattern', re: /^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/, msg: 'WhatsApp template language must look like en, hi or en_US', label: 'Language' },
      $cross(pick) {
        const ch = pick('channel');
        if (ch === 'ivr') return empty(pick('ivrFlow')) ? [['ivrFlow', 'Choose an IVR flow']] : [];
        if ((ch === 'sms' || ch === 'whatsapp') && empty(pick('body')) && empty(pick('template')) && empty(pick('waTemplate.name'))) return [['body', 'Write a message or choose a template']];
        return [];
      },
    },
    ivrFlow: {
      name: title('Name', 80), description: { t: 'text', label: 'Description', maxLen: 500 },
      voice: { t: 'pattern', re: /^[\w.-]{1,40}$/, msg: 'Voice must be a voice name like Polly.Aditi', label: 'Voice' },
      language: { t: 'pattern', re: /^[a-z]{2}-[A-Z]{2}$/, msg: 'Language must look like en-IN', label: 'Language' },
    },
    ivrCall: { phone: { t: 'phone', req: true, label: 'Phone number' } },
    adAccount: {
      name: title('Name', 120), accountId: { t: 'pattern', re: /^[\w-]{1,40}$/, msg: 'Account ID can only contain letters, digits, _ and -', label: 'Account ID' },
      currency: { t: 'pattern', re: /^[A-Za-z]{3}$/, msg: 'Currency must be a 3-letter code like INR or USD', label: 'Currency' }, monthlyBudget: money('Monthly budget'),
    },
    adCampaign: {
      name: title('Name', 120), account: { t: 'id', req: true, label: 'Ad account' },
      dailyBudget: money('Daily budget', 1e9), totalBudget: money('Total budget'),
      startDate: { t: 'date', label: 'Start date' }, endDate: { t: 'date', label: 'End date' },
      externalId: { t: 'pattern', re: /^[\w-]{1,64}$/, msg: 'Ad network campaign ID can only contain letters, digits, _ and -', label: 'Ad network campaign ID' },
      'audience.locations': { t: 'tags', label: 'Target locations' }, 'audience.interests': { t: 'tags', label: 'Interests' },
      'audience.ageMin': { t: 'number', int: true, min: 13, max: 100, label: 'Age from' }, 'audience.ageMax': { t: 'number', int: true, min: 13, max: 100, label: 'Age to' },
      notes: { t: 'text', label: 'Notes', maxLen: 2000 },
      $cross: (pick) => [...order(pick, 'startDate', 'endDate', 'endDate', 'End date must be after the start date'),
        ...(Number(pick('audience.ageMin')) > Number(pick('audience.ageMax')) ? [['audience.ageMax', 'Age to must be greater than Age from']] : [])],
    },
    adCreative: {
      campaign: { t: 'id', req: true, label: 'Campaign' }, name: title('Name', 120),
      variant: { t: 'pattern', re: /^[A-Za-z0-9]{1,3}$/, msg: 'Variant must be a short code like A, B or C', label: 'Variant' },
      headline: title('Headline', 150, false), body: title('Ad copy', 2000, false), cta: title('Call to action', 40, false),
      mediaUrl: { t: 'url', label: 'Image/video URL' }, landingUrl: { t: 'url', label: 'Landing URL' },
    },
    employee: {
      name, email: { t: 'email', label: 'Email' }, phone: { t: 'phone', label: 'Phone' },
      employeeCode: { t: 'pattern', re: /^[\w-]{1,20}$/, msg: 'Employee code can only contain letters, digits, _ and -', label: 'Employee code' },
      department: title('Department', 60, false), designation: title('Designation', 60, false), branch: title('Branch', 60, false),
      joinDate: { t: 'date', req: true, label: 'Joining date' }, birthday: { t: 'date', future: false, label: 'Birthday' }, exitDate: { t: 'date', label: 'Exit date' },
      'salary.basic': money('Basic', 1e8), 'salary.hra': money('HRA', 1e8), 'salary.allowances': money('Allowances', 1e8), 'salary.otherDeductions': money('Fixed deductions', 1e8),
      'bank.holder': { t: 'personName', label: 'Account holder', maxLen: 100 }, 'bank.bankName': title('Bank name', 100, false),
      'bank.account': { t: 'pattern', re: /^\d{6,20}$/, msg: 'Account number must be 6-20 digits', label: 'Account number' },
      'bank.ifsc': { t: 'pattern', re: /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, msg: 'IFSC must be 11 characters like HDFC0001234', label: 'IFSC' },
      $cross: (pick) => [...order(pick, 'birthday', 'joinDate', 'birthday', 'Birthday must be before the joining date'), ...order(pick, 'joinDate', 'exitDate', 'exitDate', 'Exit date must be after the joining date')],
    },
    holiday: { name: title('Name', 80), date: { t: 'date', req: true, label: 'Date' } },
    pipeline: {
      name: title('Name', 60), stages: { t: 'tags', req: true, item: 'title', minItems: 1, maxItems: 20, maxLen: 40, label: 'Stages' },
      $cross(pick) {
        const s = [].concat(pick('stages') || []).map((x) => String(x).trim().toLowerCase());
        return new Set(s).size !== s.length ? [['stages', 'Stage names must be unique']] : [];
      },
    },
    optout: { phone: { t: 'phone', req: true, label: 'Phone' }, reason: { t: 'text', label: 'Reason', maxLen: 200 } },
  };

  // ---------- automation steps ----------
  const COND_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists'];
  const STEP_LABEL = { send_whatsapp: 'Send WhatsApp', send_sms: 'Send SMS', send_email: 'Send email', ai_message: 'AI message', create_task: 'Create a task', notify: 'Notify', add_tag: 'Add a tag', update_field: 'Update a field', assign: 'Assign', wait: 'Wait', ad_set_budget: 'Change ad budget', ai_ad_review: 'AI ad review', condition: 'If / else' };
  const has = (v) => !empty(typeof v === 'string' ? v.trim() : v);
  const num = (v, min, max) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && n >= min && n <= max; };

  function condition(c, where) {
    if (!c || typeof c !== 'object') return [`${where}: condition is missing`];
    if (c.type === 'no_reply') return [];
    if (!has(c.field) || !/^[\w.]+$/.test(String(c.field).trim())) return [`${where}: choose a field to check (letters, digits, dots)`];
    if (c.op && !COND_OPS.includes(c.op)) return [`${where}: unknown comparison "${c.op}"`];
    if ((c.op || 'eq') !== 'exists' && !has(c.value)) return [`${where}: enter a value to compare "${c.field}" with`];
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && !num(c.value, -Infinity, Infinity)) return [`${where}: "${c.value}" must be a number for this comparison`];
    return [];
  }

  // Returns a list of messages for a workflow's trigger conditions and (nested) steps.
  function workflowSteps(steps = [], conditions = []) {
    const out = [];
    (conditions || []).forEach((c, i) => out.push(...condition(c, `Trigger condition ${i + 1}`)));
    const walk = (list, prefix) => (list || []).forEach((s, i) => {
      const where = `Step ${prefix}${i + 1} (${STEP_LABEL[s?.type] || s?.type})`;
      const need = (ok, msg) => { if (!ok) out.push(`${where}: ${msg}`); };
      switch (s?.type) {
        case 'send_whatsapp': case 'send_sms':
          need(has(s.templateId) || (has(s.body) && LETTER.test(s.body)), 'write a message (it must contain words)'); break;
        case 'send_email':
          need(has(s.templateId) || (has(s.subject) && LETTER.test(s.subject)), 'enter a subject');
          need(has(s.templateId) || (has(s.body) && LETTER.test(s.body)), 'write the email body'); break;
        case 'ai_message':
          need(has(s.purpose) && LETTER.test(s.purpose), 'describe what the message should do'); break;
        case 'create_task':
          need(has(s.title) && LETTER.test(s.title), 'enter a task title');
          need(s.dueInDays == null || s.dueInDays === '' || num(s.dueInDays, 0, 365), 'due in days must be 0-365'); break;
        case 'notify':
          need(has(s.title) && LETTER.test(s.title), 'enter a title'); break;
        case 'add_tag':
          need(has(s.tag) && /[\p{L}\d]/u.test(s.tag) && String(s.tag).length <= 50, 'enter a tag (max 50 characters)'); break;
        case 'update_field':
          need(has(s.field) && /^[\w.]+$/.test(String(s.field).trim()), 'enter the field to update, e.g. status');
          need(s.value !== undefined && s.value !== '', 'enter the new value'); break;
        case 'assign':
          need(s.strategy !== 'user' || (typeof s.userId === 'string' && OID.test(s.userId)), 'choose the team member'); break;
        case 'wait': {
          const parts = ['days', 'hours', 'minutes'].filter((k) => s[k] != null && s[k] !== '');
          need(parts.length > 0, 'enter how long to wait');
          need(parts.every((k) => num(s[k], 0, 365 * 24 * 60)), 'wait time must be 0 or more'); break;
        }
        case 'ad_set_budget':
          need(has(s.value) || has(s.changePct), 'enter a change % or an exact amount');
          need(!has(s.value) || num(s.value, 1, 1e9), 'exact amount must be more than 0');
          need(!has(s.changePct) || num(s.changePct, -100, 1000), 'change % must be between -100 and 1000');
          need(!has(s.max) || num(s.max, 1, 1e9), 'max must be more than 0'); break;
        case 'ai_ad_review':
          need(!has(s.maxChangePct) || num(s.maxChangePct, 1, 100), 'max change % must be 1-100');
          need(!has(s.everyHours) || num(s.everyHours, 1, 720), 'every N hours must be 1-720'); break;
        case 'condition':
          out.push(...condition(s.if, where));
          walk(s.then, `${prefix}${i + 1}.then.`); walk(s.else, `${prefix}${i + 1}.else.`); break;
        default:
      }
    });
    walk(steps, '');
    return out;
  }

  return { SPECS, validate, checkValue, workflowSteps, isEmail: (v) => !checkValue(v, { t: 'email' }, ''), isPhone: (v) => !checkValue(v, { t: 'phone' }, '') };
}));
