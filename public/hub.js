'use strict';
/* Communication Hub pages: bulk SMS / WhatsApp / IVR, AI inbox, IVR flow builder, call logs, AI bot,
   intent mapping, providers and DND. Loaded after app.js and uses its helpers (h, api, modal, listModule...). */

Object.assign(ICONS, {
  commdash: '<path d="M3 3v18h18"/><polyline points="7 14 11 10 14 13 20 7"/>',
  bulksms: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/>',
  bulkwa: '<path d="M3 21l1.7-4.6A9 9 0 1 1 8 19.6z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8A4 4 0 0 1 10.7 11l.8-1-1-2z"/>',
  ivrcalls: '<polyline points="16 2 22 2 22 8"/><line x1="15" y1="9" x2="22" y2="2"/><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  ivrflows: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  calllogs: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/><line x1="15" y1="4" x2="21" y2="4"/><line x1="15" y1="8" x2="19" y2="8"/>',
  aibot: '<rect x="4" y="8" width="16" height="12" rx="3"/><line x1="12" y1="8" x2="12" y2="4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/><line x1="2" y1="13" x2="2" y2="16"/><line x1="22" y1="13" x2="22" y2="16"/>',
  intentmap: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  providers: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  dnd: '<circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
});

// ---------- small helpers ----------
const HUB_LABEL = { sms: 'SMS', whatsapp: 'WhatsApp', ivr: 'IVR calls', voice: 'Voice / IVR', call: 'Call' };
const el = {
  input: (v, a = {}) => { const x = h('input', a); x.value = v ?? ''; return x; },
  area: (v, a = {}) => { const x = h('textarea', { class: 'plain', ...a }); x.value = v ?? ''; return x; },
  select: (opts, v, a = {}) => { const x = h('select', a, opts.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o)))); if (v != null) x.value = v; return x; },
  check: (v, a = {}) => { const x = h('input', { type: 'checkbox', style: 'width:auto;margin:0', ...a }); x.checked = !!v; return x; },
};
const fld = (label, node, hint) => h('div', { class: 'fld' }, h('label', {}, label), node, hint && h('small', { class: 'muted hint' }, hint));
const inline = (box, text) => h('label', { class: 'inline' }, box, ' ', text);
const intentPill = (i) => (i ? h('span', { class: 'pill i-' + i }, i.replace('_', ' ')) : '');
const chanPill = (c) => h('span', { class: 'pill ch-' + c }, HUB_LABEL[c] || c);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const dur = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const ago = (d) => { if (!d) return ''; const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const hubStat = (v, l, ic, c, sub) => h('div', { class: 'stat', style: `--c:${c}` }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, v), h('span', {}, l), sub && h('div', {}, h('em', { style: 'color:var(--mute)' }, sub))));
const bubbleClass = (role) => 'bub ' + (role === 'caller' || role === 'inbound' ? 'in' : role === 'system' ? 'sys' : 'out');
function seg(options, value, onpick) {
  const s = h('div', { class: 'seg' });
  const draw = (v) => setKids(s, options.map(([k, label]) => h('button', { class: k === v ? 'on' : '', onclick: () => { draw(k); onpick(k); } }, label)));
  draw(value);
  return s;
}
// GSM-7 = 160 chars per SMS (153 when split); anything else (Hindi, emoji) = 70 (67).
function smsInfo(text = '') {
  const gsm = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  const n = !text.length ? 0 : text.length <= one ? 1 : Math.ceil(text.length / many);
  return `${text.length} chars · ${n} SMS part${n === 1 ? '' : 's'}${gsm ? '' : ' · unicode'}`;
}

// ================= Dashboard =================
const SERIES = [['sms', 'SMS', 'var(--s1)'], ['whatsapp', 'WhatsApp', 'var(--s2)'], ['call', 'IVR calls', 'var(--s3)']];

function channelChart(daily) {
  const max = Math.max(1, ...daily.map((d) => d.sms + d.whatsapp + d.call));
  const every = Math.ceil(daily.length / 10);
  const tableBox = h('div', { hidden: true });
  const toggle = h('button', { class: 'btn sm sec', onclick: () => { tableBox.hidden = !tableBox.hidden; toggle.textContent = tableBox.hidden ? 'Show numbers' : 'Hide numbers'; } }, 'Show numbers');
  setKids(tableBox, table(daily.map((d) => ({ date: d.date, SMS: d.sms, WhatsApp: d.whatsapp, 'IVR calls': d.call }))));
  return h('div', {},
    h('div', { class: 'legend', style: 'justify-content:space-between' }, h('div', { class: 'legend', style: 'margin:0' }, SERIES.map(([, l, c]) => h('span', {}, h('i', { style: `background:${c}` }), l))), toggle),
    h('div', { class: 'sbars' }, daily.map((d, i) => {
      const tot = d.sms + d.whatsapp + d.call;
      return h('div', { class: 'sb', title: `${d.date}\nSMS ${d.sms} · WhatsApp ${d.whatsapp} · IVR calls ${d.call}` },
        h('div', { class: 'stk', style: `height:${(tot / max) * 100}%` }, SERIES.map(([k, , c]) => (d[k] ? h('i', { style: `flex:${d[k]};background:${c}` }) : null))),
        h('small', {}, i % every === 0 ? d.date.slice(5) : ''));
    })),
    tableBox);
}

const hbars = (rows, labelKey, valKey, fmt = (r) => r[valKey]) => {
  const max = Math.max(1, ...rows.map((r) => r[valKey]));
  return rows.map((r) => h('div', { class: 'hbar' }, h('label', {}, String(r[labelKey]).replace(/_/g, ' ')), h('div', { class: 'tr' }, h('i', { style: `width:${(r[valKey] / max) * 100}%;background:var(--s1)` })), h('span', {}, fmt(r))));
};

MODULES.commdash = { title: 'Communication Hub', render: async (root) => {
  let days = 7;
  const holder = h('div', {});
  root.append(h('div', { class: 'bar' }, seg([[1, 'Today'], [7, '7 days'], [30, '30 days']], days, (d) => { days = d; load(); }), h('div', { class: 'grow' }),
    can('inbox', 'r') && h('a', { class: 'btn sec', href: '#/inbox' }, icon('inbox'), 'Open inbox'),
    can('bulk', 'c') && h('a', { class: 'btn sec', href: '#/bulkwa' }, icon('bulkwa'), 'WhatsApp blast'),
    can('bulk', 'c') && h('a', { class: 'btn', href: '#/bulksms' }, icon('plus'), 'New SMS blast')), holder);
  const load = guard(async () => {
    const d = await api('/hub/overview?days=' + days);
    const sim = d.providers.filter((p) => p.provider === 'simulated').map((p) => HUB_LABEL[p.channel]);
    const notes = [
      d.conversations.needAgent && h('p', {}, h('b', {}, d.conversations.needAgent), ' chat(s) waiting for an agent. ', h('a', { href: '#/inbox' }, 'Open inbox →')),
      (d.broadcasts.running || d.broadcasts.scheduled) && h('p', {}, `${d.broadcasts.running || 0} broadcast(s) sending, ${d.broadcasts.scheduled || 0} scheduled.`),
      sim.length && h('p', {}, h('span', { class: 'pill paused' }, 'Simulated'), ` ${sim.join(', ')} ${sim.length > 1 ? 'are' : 'is'} not connected to a real provider yet. `, can('hubsetup', 'u') && h('a', { href: '#/providers' }, 'Connect providers →')),
      d.aiMode === 'rules' && h('p', { class: 'muted' }, 'The AI assistant is running on built-in rules (English + Hindi/Hinglish keywords). Add OPENAI_API_KEY or GEMINI_API_KEY for full natural-language answers.'),
    ].filter(Boolean);
    const m = d.messages, c = d.calls, cv = d.conversations;
    setKids(holder,
      notes.length && h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Needs your attention')), notes),
      h('div', { class: 'grid six' },
        hubStat(m.outbound, 'Messages sent', 'send', '#5b5bf0', `${m.deliveryRate}% accepted · ${m.delivered} delivered`),
        hubStat(m.inbound, 'Replies received', 'inbox', '#0a8bd6', `${cv.active} active chats`),
        hubStat(m.botReplies, 'Answered by AI', 'aibot', '#8b5cf6', `${cv.aiResolvedPct}% of chats handled without an agent`),
        hubStat(cv.needAgent, 'Waiting for an agent', 'customers', '#f08a05', `${cv.botActive} chats with the AI now`),
        hubStat(c.total, 'IVR calls', 'ivrcalls', '#12a150', `${c.answered} answered · avg ${dur(c.avgDurationSec)}`),
        hubStat(d.optOuts, 'Opt-outs (DND)', 'dnd', '#e5484d')),
      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Activity by channel')), channelChart(d.daily)),
        h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'What customers want (AI intents)')),
          d.intents.length ? hbars(d.intents, 'intent', 'n') : h('p', { class: 'muted' }, 'Intents appear here once the AI reads replies and calls.'))),
      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Messages by channel')),
          table(m.byChannel.map((x) => ({ channel: HUB_LABEL[x.channel], sent: x.outbound, received: x.inbound }))),
          h('h3', { style: 'margin-top:18px' }, 'Calls by outcome'),
          c.byStatus.length ? hbars(c.byStatus, 'status', 'n') : h('p', { class: 'muted' }, 'No calls yet.')),
        h('div', { class: 'card flush' }, h('div', { class: 'hd', style: 'padding:18px 18px 0' }, h('h3', {}, 'Recent broadcasts')),
          d.recentBroadcasts.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Channel', 'Status', 'Sent', 'Replies / answered'].map((x) => h('th', {}, x)))),
            h('tbody', {}, d.recentBroadcasts.map((b) => h('tr', {}, h('td', {}, b.name), h('td', {}, chanPill(b.channel)), h('td', {}, pill(b.status)),
              h('td', {}, `${b.stats?.sent || 0} / ${b.stats?.total || 0}`), h('td', {}, b.channel === 'ivr' ? b.stats?.answered || 0 : b.stats?.replied || 0))))))
            : h('div', { class: 'empty' }, icon('bulksms'), h('div', {}, 'No broadcasts yet.')))));
  });
  load();
} };

// ================= Bulk broadcasts =================
const NOTES = {
  sms: 'Send an SMS to a CRM segment or an uploaded list. Every number is matched to a lead/customer (new numbers become leads), DND numbers are skipped and replies go to the AI inbox.',
  whatsapp: 'WhatsApp broadcasts. Outside the 24-hour customer-service window Meta only allows approved templates, so fill in the template name for cold audiences. Replies are answered by the AI assistant.',
  ivr: 'Automated voice calls. Each call runs an IVR flow (keypad menu or AI voice agent); key presses and spoken answers update the CRM through intent mapping.',
};

function broadcastModule(ch) {
  return async (root) => {
    const [flows, templates] = await Promise.all([
      ch === 'ivr' && can('ivr', 'r') ? api('/hub/ivr/flows?limit=100').then((r) => r.data) : [],
      ch !== 'ivr' ? api('/templates?limit=100&channel=' + ch).then((r) => r.data).catch(() => []) : [],
    ]);
    const holder = h('div', {});
    root.append(h('p', { class: 'muted', style: 'margin:0 0 12px' }, NOTES[ch]), holder);
    const lastCol = ch === 'ivr' ? { k: 'stats.answered', label: 'Answered' } : { k: 'stats.replied', label: 'Replies' };
    await listModule({
      res: 'bulk', path: '/hub/broadcasts', query: { channel: ch }, title: 'Broadcast', filterField: 'status', filterOpts: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'],
      cols: [{ k: 'name' }, { k: 'status', pill: true }, { k: 'stats.total', label: 'Recipients' }, { k: 'stats.sent', label: ch === 'ivr' ? 'Calls placed' : 'Sent' },
        ...(ch === 'ivr' ? [] : [{ k: 'stats.delivered', label: 'Delivered' }]), lastCol, { k: 'stats.failed', label: 'Failed' }, { k: 'stats.skipped', label: 'DND skipped' },
        { k: 'scheduledAt', label: 'Scheduled', date: true }, { k: 'launchedAt', label: 'Launched', date: true }],
      barExtra: [{ label: '+ New broadcast', show: () => can('bulk', 'c'), run: (reload) => broadcastEditor(ch, flows, templates, null, reload) }],
      actions: [
        { label: 'Recipients', perm: ['bulk', 'u'], show: (r) => ['draft', 'scheduled', 'paused'].includes(r.status), run: (r, reload) => recipientsModal(r, reload) },
        { label: 'Edit', perm: ['bulk', 'u'], show: (r) => ['draft', 'scheduled'].includes(r.status), run: (r, reload) => broadcastEditor(ch, flows, templates, r, reload) },
        { label: 'Launch', perm: ['bulk', 'u'], show: (r) => ['draft', 'scheduled'].includes(r.status), run: async (r, reload) => {
          const when = r.scheduledAt && new Date(r.scheduledAt) > new Date() ? `on ${fmtDate(r.scheduledAt)}` : 'now';
          if (!confirm(`Send "${r.name}" to ${r.stats?.queued || 0} recipient(s) ${when}?\nDND numbers are skipped automatically.`)) return;
          const b = await api(`/hub/broadcasts/${r._id}/launch`, { method: 'POST' });
          toast(b.status === 'scheduled' ? 'Scheduled' : `Sending — ${b.stats.sent} sent so far`); reload();
        } },
        { label: 'Pause', perm: ['bulk', 'u'], show: (r) => ['running', 'scheduled'].includes(r.status), run: async (r, reload) => { await api(`/hub/broadcasts/${r._id}/pause`, { method: 'POST' }); reload(); } },
        { label: 'Resume', perm: ['bulk', 'u'], show: (r) => r.status === 'paused', run: async (r, reload) => { await api(`/hub/broadcasts/${r._id}/resume`, { method: 'POST' }); reload(); } },
        { label: 'Cancel', perm: ['bulk', 'u'], show: (r) => ['scheduled', 'running', 'paused'].includes(r.status), run: async (r, reload) => { if (confirm('Cancel this broadcast? Unsent recipients are skipped.')) { await api(`/hub/broadcasts/${r._id}/cancel`, { method: 'POST' }); reload(); } } },
        { label: 'Report', run: (r) => reportModal(r) },
      ],
    })(holder);
  };
}

function broadcastEditor(ch, flows, templates, row, reload) {
  const r = row || {};
  const name = el.input(r.name, { placeholder: 'e.g. Diwali offer – Pune leads' });
  const parts = [fld('Name', name)];
  let body, tpl, media, waName, waLang, waParams, flow;
  if (ch === 'ivr') {
    flow = el.select([['', '— choose an IVR flow —'], ...flows.map((f) => [f._id, f.name])], r.ivrFlow?._id || r.ivrFlow || '');
    parts.push(fld('IVR flow', flow, flows.length ? 'Design flows under IVR Flows. Test them with the call simulator first.' : 'No flows yet — create one under IVR Flows.'));
  } else {
    tpl = el.select([['', '— write a message below —'], ...templates.map((t) => [t._id, t.name])], r.template?._id || r.template || '');
    body = el.area(r.body, { rows: 5, placeholder: 'Hi {{person.name}}, our Diwali offer is live: 20% off till Sunday. Reply YES to know more or STOP to opt out.' });
    const info = h('small', { class: 'muted hint' });
    const upd = () => { info.textContent = ch === 'sms' ? smsInfo(body.value) : `${body.value.length} chars`; };
    body.addEventListener('input', upd); upd();
    tpl.addEventListener('change', () => { const t = templates.find((x) => x._id === tpl.value); if (t) { body.value = t.body; upd(); } });
    const purpose = el.input('', { placeholder: 'Tell the AI what to write, e.g. "festive offer 20% off, reply YES"' });
    parts.push(templates.length ? fld('Template', tpl) : null,
      fld('Message', body, 'Personalise with {{person.name}} or any CSV column as {{vars.column}}. Always tell people how to opt out (STOP).'), info,
      can('ai', 'r') && h('div', { class: 'row' }, purpose, h('button', { class: 'btn sec', onclick: guard(async () => {
        const x = await api('/hub/broadcasts/compose', { method: 'POST', body: { channel: ch, purpose: purpose.value || 'special offer' } });
        body.value = x.text; upd(); toast(`Drafted (${x.engine})`);
      }) }, icon('ai'), 'AI write')));
    if (ch === 'whatsapp') {
      media = el.input(r.mediaUrl, { placeholder: 'https://… image to attach (optional)' });
      waName = el.input(r.waTemplate?.name, { placeholder: 'approved template name (Meta) or content SID (Twilio)' });
      waLang = el.input(r.waTemplate?.language || 'en', { placeholder: 'en / hi / en_US' });
      waParams = el.input((r.waTemplate?.params || []).join(' | '), { placeholder: '{{person.name}} | 20%' });
      parts.push(fld('Image URL', media), h('details', { class: 'adv', open: !!r.waTemplate?.name }, h('summary', {}, 'Approved WhatsApp template (needed for people who have not messaged you in 24h)'),
        h('div', { class: 'cols2' }, fld('Template name', waName), fld('Language', waLang)), fld('Body variables, separated by |', waParams, 'Fill {{1}}, {{2}}… of the template. Placeholders like {{person.name}} work here too.')));
    }
  }
  const when = el.input(r.scheduledAt ? new Date(new Date(r.scheduledAt) - new Date(r.scheduledAt).getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '', { type: 'datetime-local' });
  const rate = el.input(r.ratePerMinute ?? (ch === 'ivr' ? 20 : 60), { type: 'number', min: 1, max: 2000 });
  const cost = el.input(r.costPerUnit ?? '', { type: 'number', min: 0, step: '0.01', placeholder: '0.20' });
  parts.push(h('div', { class: 'cols3' }, fld('Schedule (optional)', when, 'Empty = send on launch'), fld(ch === 'ivr' ? 'Calls per minute' : 'Messages per minute', rate), fld('Cost per ' + (ch === 'ivr' ? 'call' : 'message'), cost, 'For ROI in the report')));
  modal(row ? 'Edit broadcast' : `New ${HUB_LABEL[ch]} broadcast`, h('div', {}, parts), [{ label: row ? 'Save' : 'Save & add recipients', run: async () => {
    if (!name.value.trim()) throw new Error('Name is required');
    const payload = { name: name.value.trim(), channel: ch, scheduledAt: when.value ? new Date(when.value).toISOString() : null, ratePerMinute: +rate.value || 60, costPerUnit: +cost.value || 0 };
    if (ch === 'ivr') payload.ivrFlow = flow.value || undefined;
    else {
      Object.assign(payload, { body: body.value, template: tpl.value || null });
      if (ch === 'whatsapp') Object.assign(payload, { mediaUrl: media.value || undefined, waTemplate: waName.value ? { name: waName.value.trim(), language: waLang.value.trim() || 'en', params: waParams.value ? waParams.value.split('|').map((x) => x.trim()) : [] } : { name: '' } });
    }
    const saved = await api('/hub/broadcasts' + (row ? '/' + row._id : ''), { method: row ? 'PATCH' : 'POST', body: payload });
    toast('Saved'); reload();
    if (!row) recipientsModal(saved, reload);
  } }], true);
}

function recipientsModal(b, reload) {
  const count = h('b', {}, '…');
  const result = h('div', { class: 'result' });
  const refresh = async () => { const x = await api('/hub/broadcasts/' + b._id); count.textContent = `${x.stats?.total || 0} recipient(s)`; };
  const show = (r) => {
    setKids(result, h('div', { class: 'okbox' }, h('b', {}, `Added ${r.added}`),
      r.created != null && ` · ${r.created} new lead(s) created`, r.matched != null && ` · ${r.matched} matched to existing CRM records`,
      r.invalid ? ` · ${r.invalid} invalid number(s)` : '', r.duplicates ? ` · ${r.duplicates} already in the list` : ''));
    refresh(); reload();
  };

  // From CRM
  const model = el.select(['Lead', 'Customer'], 'Lead');
  const status = h('select', {});
  const source = el.select([['', 'Any source'], ...SOURCES.map((s) => [s, s])], '');
  const tags = el.input('', { placeholder: 'vip, nurture' });
  const preview = h('p', { class: 'muted' });
  const drawStatus = () => { setKids(status, h('option', { value: '' }, 'Any ' + (model.value === 'Lead' ? 'status' : 'lifecycle')), (model.value === 'Lead' ? LEAD_STAGES : ['prospect', 'active', 'at_risk', 'churned', 'vip']).map((s) => h('option', { value: s }, s))); source.disabled = model.value !== 'Lead'; };
  model.addEventListener('change', drawStatus); drawStatus();
  const audience = () => {
    const filter = {};
    if (status.value) filter[model.value === 'Lead' ? 'status' : 'lifecycle'] = status.value;
    if (source.value && model.value === 'Lead') filter.source = source.value;
    return { model: model.value, filter, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) };
  };
  const crmPane = h('div', {}, h('div', { class: 'cols2' }, fld('Records', model), fld('Status', status), fld('Source', source), fld('Has any of these tags', tags)), preview,
    h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: guard(async () => { const p = await api('/hub/broadcasts/preview-audience', { method: 'POST', body: audience() }); setKids(preview, h('b', {}, `${p.count} with a phone number`), p.sample.length ? ` — e.g. ${p.sample.map((s) => s.name).join(', ')}` : ''); }) }, 'Preview'),
      h('button', { class: 'btn', onclick: guard(async () => show(await api(`/hub/broadcasts/${b._id}/recipients/crm`, { method: 'POST', body: audience() }))) }, 'Add to broadcast')));

  // CSV
  const csv = el.area('', { rows: 7, class: '', placeholder: 'phone,name,city\n9876543210,Rohan Gupta,Pune\n+91 98200 12345,Neha Verma,Mumbai' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', onchange: async (e) => { const f = e.target.files[0]; if (f) csv.value = await f.text(); } });
  const auto = el.check(false);
  const csvPane = h('div', {}, h('p', { class: 'muted' }, 'First row is the header. A phone column is required (phone / mobile / number); name and any other columns are optional and usable as {{vars.column}}. Numbers already in the CRM are matched (any format); new numbers are created as leads tagged with this broadcast.'),
    file, csv, inline(auto, 'Run "lead created" automations for new leads'),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: guard(async () => { if (!csv.value.trim()) throw new Error('Paste numbers or choose a CSV file'); show(await api(`/hub/broadcasts/${b._id}/recipients/csv?automation=${auto.checked}`, { method: 'POST', body: csv.value, csv: true })); }) }, 'Upload & map to CRM')));

  const pane = h('div', {}, csvPane);
  const node = h('div', {}, h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Currently: ', count, b.status === 'draft' && can('bulk', 'u') && [' · ', h('a', { href: 'javascript:void 0', onclick: guard(async () => { if (confirm('Remove all recipients?')) { await api(`/hub/broadcasts/${b._id}/recipients`, { method: 'DELETE' }); refresh(); reload(); } }) }, 'clear list')]),
    seg([['csv', 'Upload CSV / paste numbers'], ['crm', 'From CRM']], 'csv', (k) => setKids(pane, k === 'csv' ? csvPane : crmPane)), h('div', { style: 'height:6px' }), pane, result);
  refresh();
  modal(`Recipients — ${b.name}`, node, [], true);
}

async function reportModal(b) {
  const rep = await api(`/hub/broadcasts/${b._id}/report`);
  const s = rep.stats, ivr = b.channel === 'ivr';
  const funnel = [['Recipients', s.total], [ivr ? 'Calls placed' : 'Sent', s.sent], ...(ivr ? [] : [['Delivered', s.delivered]]), ...(b.channel === 'whatsapp' ? [['Read', s.read]] : []), [ivr ? 'Answered' : 'Replied', ivr ? s.answered : s.replied]];
  const list = h('div', {});
  const filter = el.select([['', 'All recipients'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed'], ['skipped', 'Skipped (DND)'], ['queued', 'Queued']], '');
  const loadList = guard(async () => {
    const r = await api(`/hub/broadcasts/${b._id}/recipients?limit=50${filter.value ? '&status=' + filter.value : ''}`);
    setKids(list, r.data.length ? h('div', { class: 'tw' }, table(r.data.map((x) => ({ phone: x.phone, name: x.name || '', status: x.status, [ivr ? 'answered' : 'replied']: (ivr ? x.answered : x.replied) ? 'yes' : '', error: x.error || '' })))) : h('p', { class: 'muted' }, 'Nobody here.'),
      r.total > 50 && h('p', { class: 'muted' }, `Showing 50 of ${r.total}.`));
  });
  filter.addEventListener('change', loadList);
  modal('Report — ' + b.name, h('div', {},
    h('div', { class: 'grid mini' },
      hubStat(`${pct(ivr ? s.answered : s.replied, s.sent)}%`, ivr ? 'Answer rate' : 'Reply rate', ivr ? 'ivrcalls' : 'inbox', '#5b5bf0'),
      hubStat(s.failed, 'Failed', 'dnd', '#e5484d', `${s.skipped} skipped · ${s.optedOut} opted out`),
      hubStat(money(rep.revenue), 'Revenue from recipients', 'deals', '#12a150', `${rep.wonDeals} deal(s) won since launch`),
      hubStat(rep.roi == null ? '—' : rep.roi + '%', 'ROI', 'reports', '#8b5cf6', `cost ${money(rep.cost)}`)),
    h('div', { class: 'two' },
      h('div', {}, h('h3', {}, 'Funnel'), funnel.map(([l, v]) => h('div', { class: 'hbar' }, h('label', {}, l), h('div', { class: 'tr' }, h('i', { style: `width:${pct(v, s.total)}%;background:var(--s1)` })), h('span', {}, `${v} · ${pct(v, s.total)}%`)))),
      h('div', {}, h('h3', {}, 'Intents in replies'), rep.intents.length ? hbars(rep.intents, 'intent', 'n') : h('p', { class: 'muted' }, 'No AI-classified replies yet.'),
        rep.leadsByStatus.length ? [h('h3', { style: 'margin-top:14px' }, 'Where the leads are now'), hbars(rep.leadsByStatus, 'status', 'n')] : null)),
    h('div', { class: 'bar', style: 'margin:16px 0 8px' }, h('h3', { style: 'margin:0' }, 'Recipients'), h('div', { class: 'grow' }), filter,
      ivr && h('a', { class: 'btn sec', href: '#/calllogs?broadcast=' + b._id, onclick: () => document.querySelector('.modal')?.remove() }, 'Open call logs')), list), [], true);
  loadList();
}

MODULES.bulksms = { title: 'Bulk SMS', render: broadcastModule('sms') };
MODULES.bulkwa = { title: 'Bulk WhatsApp', render: broadcastModule('whatsapp') };
MODULES.ivrcalls = { title: 'IVR Call Campaigns', render: broadcastModule('ivr') };

// ================= Inbox =================
MODULES.inbox = { title: 'Inbox', render: async (root) => {
  const st = { view: 'open', channel: '', q: '', sel: null };
  const own = ['sales', 'telecaller'].includes(S.user.role);
  const templates = await api('/templates?limit=100').then((r) => r.data.filter((t) => t.channel !== 'email')).catch(() => []);
  const listEl = h('div', { class: 'ib-items' });
  const threadEl = h('div', { class: 'ib-thread card flush' }, h('div', { class: 'empty' }, icon('inbox'), h('div', {}, 'Pick a conversation. The AI answers new chats; it hands over to an agent when the customer complains, asks for a person or the AI is unsure.')));
  const tabsBox = h('div', {});
  const chan = el.select([['', 'All channels'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS']], '', { onchange: (e) => { st.channel = e.target.value; loadList(); } });
  const search = el.input('', { placeholder: 'Search name, number, text…', onkeydown: (e) => { if (e.key === 'Enter') { st.q = e.target.value; loadList(); } } });
  root.append(h('div', { class: 'bar' }, tabsBox, chan, h('div', { class: 'search' }, icon('search'), search), h('div', { class: 'grow' }),
    can('inbox', 'u') && h('button', { class: 'btn', onclick: () => newChat() }, icon('plus'), 'New chat')),
  h('div', { class: 'inbox' }, h('div', { class: 'ib-list card flush' }, listEl), threadEl));

  const modePill = (c) => (c.status === 'closed' ? h('span', { class: 'pill' }, 'closed') : c.mode === 'bot' ? h('span', { class: 'pill bot' }, 'AI') : h('span', { class: 'pill human' }, c.assignedTo?.name ? 'Agent · ' + c.assignedTo.name.split(' ')[0] : 'Needs agent'));

  const loadList = guard(async () => {
    const qs = new URLSearchParams({ view: st.view, limit: 50 });
    if (st.channel) qs.set('channel', st.channel);
    if (st.q) qs.set('q', st.q);
    const r = await api('/hub/conversations?' + qs);
    setKids(tabsBox, seg([['open', 'Open'], ['needs_agent', `Needs agent (${r.counts.needs_agent})`], ['bot', `AI handling (${r.counts.bot})`], ['mine', `Mine (${r.counts.mine})`], ['closed', 'Closed']], st.view, (v) => { st.view = v; loadList(); }));
    setKids(listEl, r.data.length ? r.data.map((c) => h('div', { class: 'ib-item' + (c._id === st.sel ? ' on' : '') + (c.unread && c.lastDirection === 'inbound' ? ' unread' : ''), 'data-id': c._id, onclick: guard(() => openConv(c._id)) },
      avatar(c.name || c.phone),
      h('div', { class: 'grow' },
        h('div', { class: 'r1' }, h('b', {}, c.name || c.phone), h('small', {}, ago(c.lastMessageAt))),
        h('div', { class: 'r2' }, c.lastDirection === 'outbound' ? '↩ ' : '', c.lastMessage || ''),
        h('div', { class: 'r3' }, chanPill(c.channel), modePill(c), intentPill(c.intent), c.unread && c.lastDirection === 'inbound' ? h('span', { class: 'badge' }, c.unread) : null))))
      : h('div', { class: 'empty' }, 'No conversations here.'));
  });

  let parts = null;
  async function openConv(id, refresh) {
    const d = await api('/hub/conversations/' + id);
    if (!refresh || !parts || parts.id !== id) {
      st.sel = id;
      const body = el.area('', { rows: 2, placeholder: 'Type a reply… (Enter to send, Shift+Enter for a new line)' });
      const send = guard(async () => {
        if (!body.value.trim()) return;
        await api(`/hub/conversations/${id}/reply`, { method: 'POST', body: { body: body.value } });
        body.value = ''; await openConv(id, true); loadList();
      });
      body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      const tpl = templates.length && el.select([['', 'Insert template…'], ...templates.map((t) => [t._id, `${t.name} (${t.channel})`])], '', { onchange: (e) => { const t = templates.find((x) => x._id === e.target.value); if (t) body.value = t.body.replace(/\{\{\s*(person|lead|customer)\.name\s*\}\}/g, parts.name || ''); e.target.value = ''; } });
      parts = { id, head: h('div', { class: 'ib-head' }), note: h('div', {}), msgs: h('div', { class: 'ib-msgs' }), name: '' };
      setKids(threadEl, parts.head, parts.note, parts.msgs, can('inbox', 'u') && h('div', { class: 'ib-compose' }, body,
        h('div', { class: 'row' }, tpl, can('ai', 'r') && h('button', { class: 'btn sm sec', onclick: guard(async () => { const x = await api(`/hub/conversations/${id}/suggest`, { method: 'POST' }); body.value = x.text; body.focus(); }) }, icon('ai'), 'AI suggest'),
          h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: send }, icon('send'), 'Send'))));
    }
    const c = d.conversation;
    parts.name = (c.name || '').split(' ')[0];
    const act = (label, path, cls = 'sec') => h('button', { class: 'btn sm ' + cls, onclick: guard(async () => { await api(`/hub/conversations/${id}/${path}`, { method: 'POST' }); await openConv(id, true); loadList(); }) }, label);
    setKids(parts.head, avatar(c.name || c.phone, 'lg'),
      h('div', { class: 'grow' }, h('b', {}, c.name || c.phone), h('div', { class: 'muted meta' }, c.phone, ' ', chanPill(c.channel), ' ', modePill(c), ' ', intentPill(c.intent), ' ', c.sentiment && pill(c.sentiment),
        d.contact && h('span', {}, ` · ${d.contact.kind} · ${d.contact.status || d.contact.lifecycle || ''}${d.contact.score != null ? ` · score ${d.contact.score}` : ''}${d.contact.assignedTo ? ` · owner ${d.contact.assignedTo.name}` : ''}`))),
      h('div', { class: 'head-acts' },
        can('inbox', 'u') && c.mode === 'bot' && act('Take over', 'takeover', ''),
        can('inbox', 'u') && c.mode === 'human' && act('Hand back to AI', 'release'),
        can('inbox', 'u') && !own && h('button', { class: 'btn sm sec', onclick: guard(() => assignChat(id)) }, 'Assign'),
        can('inbox', 'u') && c.status === 'open' && act('Close', 'close'),
        d.contact && h('button', { class: 'btn sm sec', onclick: guard(() => showTimeline(d.contact.kind === 'Lead' ? 'leads' : 'customers', d.contact)) }, 'CRM timeline')));
    setKids(parts.note,
      d.dnd && h('div', { class: 'warnbar' }, 'This number has opted out (DND). Messages to it are blocked.'),
      c.mode === 'human' && c.handoffReason && h('div', { class: 'infobar' }, `Handed to an agent: ${c.handoffReason}`));
    const m = parts.msgs;
    const atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 60;
    setKids(m, d.messages.map((x) => h('div', { class: bubbleClass(x.direction) + (x.bot ? ' bot' : '') + (x.status === 'failed' ? ' failed' : '') },
      x.direction === 'outbound' && h('small', { class: 'who' }, x.bot ? '✨ AI assistant' : x.by?.name || 'Agent'),
      h('div', { class: 'txt' }, x.body),
      h('small', { class: 'meta' }, new Date(x.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }), x.direction === 'outbound' ? ` · ${x.status}` : '', x.intent ? ` · ${x.intent.replace('_', ' ')}` : '', x.status === 'failed' && x.summary ? ` · ${x.summary}` : ''))));
    if (!refresh || atBottom) m.scrollTop = m.scrollHeight;
    listEl.querySelectorAll('.ib-item').forEach((x) => x.classList.toggle('on', x.dataset.id === id));
  }

  async function assignChat(id) {
    const users = await api('/users');
    const sel = el.select(users.filter((u) => u.active).map((u) => [u._id || u.id, `${u.name} (${u.role})`]));
    modal('Assign conversation', fld('Agent', sel), [{ label: 'Assign', run: async () => { await api(`/hub/conversations/${id}/assign`, { method: 'POST', body: { userId: sel.value } }); toast('Assigned'); openConv(id, true); loadList(); } }]);
  }

  function newChat() {
    const channel = el.select([['whatsapp', 'WhatsApp'], ['sms', 'SMS']], 'whatsapp');
    const phone = el.input('', { placeholder: '9876543210 or +91…' });
    const body = el.area('', { rows: 4 });
    modal('New conversation', h('div', {}, fld('Channel', channel), fld('Phone', phone, 'Matched to the CRM; unknown numbers become new leads.'), fld('Message', body)), [{ label: 'Send', run: async () => {
      const c = await api('/hub/conversations', { method: 'POST', body: { channel: channel.value, phone: phone.value, body: body.value } });
      st.view = 'open'; await loadList(); openConv(c._id);
    } }]);
  }

  await loadList();
  const timer = setInterval(() => {
    if (!document.body.contains(root)) return clearInterval(timer);
    if (document.hidden) return;
    loadList();
    if (st.sel) openConv(st.sel, true).catch(() => {});
  }, 8000);
} };

// ================= IVR flows =================
const NODE_TYPES = [['say', 'Say a message'], ['menu', 'Keypad menu'], ['ai', 'AI voice agent'], ['transfer', 'Transfer to a person'], ['voicemail', 'Voicemail'], ['hangup', 'Hang up']];

async function flowEditor(row, reload) {
  const meta = await api('/hub/ivr/flows/meta/sample');
  const INT = Object.keys(meta.intents);
  const src = row || { ...meta.sample, name: 'New IVR flow', active: true, isDefaultInbound: false };
  const st = JSON.parse(JSON.stringify({ name: src.name, description: src.description || '', active: src.active !== false, isDefaultInbound: !!src.isDefaultInbound, start: src.start, voice: src.voice || 'Polly.Aditi', language: src.language || 'en-IN', nodes: src.nodes }));
  const nodesEl = h('div', { class: 'nodes' });
  const startSel = h('select', { onchange: (e) => { st.start = e.target.value; draw(); } });
  const ids = () => st.nodes.map((n) => n.id);
  const nextSel = (val, onpick, empty = '— end the call —') => el.select([['', empty], ...ids().map((i) => [i, i])], val || '', { onchange: (e) => onpick(e.target.value || undefined) });
  const intentSel = (val, onpick, empty = '— no intent —') => el.select([['', empty], ...INT.map((k) => [k, k.replace('_', ' ')])], val || '', { onchange: (e) => onpick(e.target.value || undefined) });

  function relink(fn) {
    for (const x of st.nodes) { for (const k of ['next', 'noInputNext', 'handoffNext']) x[k] = fn(x[k]); (x.options || []).forEach((o) => { o.next = fn(o.next); }); }
    st.start = fn(st.start) || st.nodes[0]?.id;
  }

  function optionsBox(n) {
    const wrap = h('div', { class: 'opts' });
    const drawOpts = () => setKids(wrap, h('label', {}, 'Keypad options'),
      n.options.map((o, j) => h('div', { class: 'opt' },
        el.input(o.digit, { class: 'dig', maxlength: 1, title: 'Key', oninput: (e) => { o.digit = e.target.value; } }),
        el.input(o.label, { placeholder: 'Label (spoken), e.g. Sales', oninput: (e) => { o.label = e.target.value; } }),
        nextSel(o.next, (v) => { o.next = v; }),
        intentSel(o.intent, (v) => { o.intent = v; }, 'no intent'),
        h('button', { class: 'btn sm bad', title: 'Remove', onclick: () => { n.options.splice(j, 1); drawOpts(); } }, '✕'))),
      h('button', { class: 'btn sm sec', onclick: () => { n.options.push({ digit: String(n.options.length + 1), label: '' }); drawOpts(); } }, '+ Option'));
    drawOpts();
    return wrap;
  }

  function nodeCard(n, i) {
    const set = (k) => (e) => { n[k] = e.target.value || undefined; };
    const txt = (k, label, ph) => fld(label, el.area(n[k], { rows: 2, placeholder: ph, oninput: set(k) }));
    const nxt = (k, label, empty) => fld(label, nextSel(n[k], (v) => { n[k] = v; }, empty));
    const num = (k, label, def, min, max) => fld(label, el.input(n[k] ?? def, { type: 'number', min, max, oninput: (e) => { n[k] = +e.target.value; } }));
    let body;
    switch (n.type) {
      case 'say': body = [txt('text', 'The IVR says', 'Welcome to Acme…'), nxt('next', 'Then go to')]; break;
      case 'menu': body = [txt('text', 'Prompt (leave empty to read the option labels)', 'Press 1 for sales, 2 for support…'), optionsBox(n), h('div', { class: 'cols2' }, num('retries', 'Retries on wrong/no key', 2, 0, 5), nxt('noInputNext', 'After too many retries', '— hang up —'))]; break;
      case 'ai': body = [txt('text', 'Greeting', 'Tell me briefly what you are looking for.'), txt('goal', 'Goal for the AI', 'Understand the requirement and budget; offer a call back from a specialist.'),
        h('div', { class: 'cols3' }, num('maxTurns', 'Max AI turns', 4, 1, 10), nxt('next', 'When done'), nxt('handoffNext', 'If the caller wants a person', '— same as done —')),
        h('small', { class: 'muted hint' }, 'The AI answers from the knowledge base (AI Bot page) and detects intents; "call me back", "not interested" and "stop" end the conversation.')]; break;
      case 'transfer': body = [txt('text', 'Say before transferring', 'Connecting you to our team.'), fld('Transfer to number', el.input(n.number, { placeholder: '+91…', oninput: set('number') })), nxt('next', 'If nobody answers', '— hang up —')]; break;
      case 'voicemail': body = [txt('text', 'Prompt', 'Please leave a message after the beep.'), h('div', { class: 'cols2' }, num('maxSeconds', 'Max seconds', 60, 5, 300), nxt('next', 'Then go to', '— thank & hang up —'))]; break;
      default: body = [txt('text', 'Goodbye message', 'Thank you for calling.')];
    }
    return h('div', { class: 'node' + (n.id === st.start ? ' start' : '') },
      h('div', { class: 'node-hd' },
        h('span', { class: 'node-n' }, i + 1),
        el.input(n.id, { class: 'node-id', title: 'Step id (used by "go to")', onchange: (e) => {
          const nu = e.target.value.trim().replace(/[^\w-]/g, '_');
          if (!nu || (nu !== n.id && ids().includes(nu))) { toast('Step ids must be unique', true); e.target.value = n.id; return; }
          const old = n.id; relink((v) => (v === old ? nu : v)); n.id = nu; draw();
        } }),
        el.select(NODE_TYPES, n.type, { onchange: (e) => { n.type = e.target.value; if (n.type === 'menu' && !n.options?.length) n.options = [{ digit: '1', label: '' }]; draw(); } }),
        h('div', { class: 'grow' }),
        n.id === st.start ? h('span', { class: 'pill active' }, 'start') : h('button', { class: 'btn sm sec', onclick: () => { st.start = n.id; draw(); } }, 'Make start'),
        h('button', { class: 'btn sm sec', disabled: i === 0, title: 'Move up', onclick: () => { st.nodes.splice(i - 1, 0, st.nodes.splice(i, 1)[0]); draw(); } }, '↑'),
        h('button', { class: 'btn sm sec', disabled: i === st.nodes.length - 1, title: 'Move down', onclick: () => { st.nodes.splice(i + 1, 0, st.nodes.splice(i, 1)[0]); draw(); } }, '↓'),
        h('button', { class: 'btn sm bad', title: 'Delete step', onclick: () => { if (st.nodes.length === 1) return; st.nodes.splice(i, 1); relink((v) => (v === n.id ? undefined : v)); draw(); } }, '✕')),
      h('div', { class: 'node-bd' }, body,
        fld('When the caller reaches this step, mark intent', intentSel(n.intent, (v) => { n.intent = v; }), 'Runs the CRM actions from Intent Mapping (e.g. "interested" → lead qualified + follow-up task).')));
  }

  function draw() {
    setKids(startSel, ids().map((i) => h('option', { value: i }, i)));
    startSel.value = st.start;
    setKids(nodesEl, st.nodes.map(nodeCard));
  }

  const addType = el.select(NODE_TYPES, 'say');
  const json = el.area('', { rows: 14, class: '' });
  const jsonBox = h('details', { class: 'adv', ontoggle: (e) => { if (e.target.open) json.value = JSON.stringify(st.nodes, null, 2); } }, h('summary', {}, 'Edit steps as JSON'), json,
    h('button', { class: 'btn sm sec', onclick: guard(() => { const v = JSON.parse(json.value); if (!Array.isArray(v) || !v.length) throw new Error('Expected a non-empty array'); st.nodes = v; if (!ids().includes(st.start)) st.start = v[0].id; draw(); toast('Applied'); }) }, 'Apply JSON'));
  const name = el.input(st.name, { oninput: (e) => { st.name = e.target.value; } });
  const desc = el.input(st.description, { placeholder: 'What this flow is for', oninput: (e) => { st.description = e.target.value; } });
  const lang = el.select([['en-IN', 'English (India)'], ['hi-IN', 'Hindi'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)']], st.language, { onchange: (e) => { st.language = e.target.value; } });
  const voice = el.input(st.voice, { oninput: (e) => { st.voice = e.target.value; } });
  const active = el.check(st.active, { onchange: (e) => { st.active = e.target.checked; } });
  const inbound = el.check(st.isDefaultInbound, { onchange: (e) => { st.isDefaultInbound = e.target.checked; } });
  draw();
  modal(row ? 'Edit IVR flow' : 'New IVR flow', h('div', {},
    h('div', { class: 'cols2' }, fld('Name', name), fld('Description', desc), fld('Start step', startSel), fld('Language', lang), fld('Voice (Twilio, e.g. Polly.Aditi)', voice),
      h('div', { class: 'fld' }, h('label', {}, 'Options'), inline(active, 'Active'), inline(inbound, 'Answers inbound calls by default'))),
    h('h3', { style: 'margin:18px 0 4px' }, 'Steps'), nodesEl,
    h('div', { class: 'row', style: 'margin-top:8px' }, addType, h('button', { class: 'btn sec', onclick: () => {
      const t = addType.value; let k = 1; while (ids().includes(`${t}${k}`)) k++;
      st.nodes.push({ id: `${t}${k}`, type: t, ...(t === 'menu' ? { options: [{ digit: '1', label: '' }] } : {}) }); draw();
    } }, '+ Add step')),
    jsonBox), [{ label: 'Save flow', run: async () => {
    const saved = await api('/hub/ivr/flows' + (row ? '/' + row._id : ''), { method: row ? 'PATCH' : 'POST', body: st });
    toast('Flow saved'); reload && reload();
    return saved;
  } }], true);
}

// Phone-style call simulator: walks a flow with real CRM mapping and intent actions.
function simulator(flow) {
  const phone = el.input('', { placeholder: 'Caller number, e.g. 9876543210' });
  const dir = el.select([['inbound', 'Customer calls in'], ['outbound', 'IVR calls the customer']], 'inbound');
  const speak = el.check(!!window.speechSynthesis);
  const screen = h('div', { class: 'ph-screen' }, h('div', { class: 'muted ph-hint' }, 'Enter a number and start the call. The caller is matched to a CRM record (unknown numbers become leads) and intent actions really run — use a test number.'));
  const ctrls = h('div', { class: 'ph-ctrls' });
  let callId = null, seen = 0;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const start = guard(async () => {
    const r = await api('/hub/ivr/simulate', { method: 'POST', body: { flowId: flow._id, phone: phone.value, direction: dir.value } });
    callId = r.call._id; seen = 0; draw(r);
  });
  const send = guard(async (body) => draw(await api(`/hub/ivr/simulate/${callId}`, { method: 'POST', body })));
  const hangBtn = () => h('button', { class: 'btn bad', onclick: guard(async () => draw(await api(`/hub/ivr/simulate/${callId}/hangup`, { method: 'POST' }))) }, 'Hang up');

  function draw(r) {
    const t = r.call.transcript;
    setKids(screen, t.map((x) => h('div', { class: x.role === 'caller' ? 'bub out' : x.role === 'bot' ? 'bub in' : 'bub sys' }, x.text)));
    screen.scrollTop = screen.scrollHeight;
    const fresh = t.slice(seen).filter((x) => x.role === 'bot').map((x) => x.text).join(' ');
    seen = t.length;
    if (speak.checked && fresh && window.speechSynthesis) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(fresh); u.lang = flow.language || 'en-IN'; speechSynthesis.speak(u); }
    if (r.done) {
      setKids(ctrls, h('div', { class: 'ph-end' }, h('b', {}, 'Call ended'), ' ', pill(r.call.status), ' ', intentPill(r.call.intent), ' ', r.call.sentiment && pill(r.call.sentiment),
        r.call.summary && h('p', {}, r.call.summary),
        h('p', { class: 'muted' }, r.call.contact ? `Logged on the ${r.call.contact.kind.toLowerCase()}'s CRM timeline; intent actions have run.` : 'No CRM record (auto-create leads is off).'),
        h('button', { class: 'btn sec', onclick: start }, 'Call again')));
      return;
    }
    const g = r.verbs.find((v) => v.gather)?.gather, dl = r.verbs.find((v) => v.dial)?.dial, rec = r.verbs.find((v) => v.record);
    if (g?.input === 'dtmf') {
      setKids(ctrls, h('div', { class: 'keypad' }, '123456789*0#'.split('').map((k) => h('button', { onclick: () => send({ digits: k }) }, k))),
        h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: () => send({ noinput: true }) }, 'Stay silent'), h('div', { class: 'grow' }), hangBtn()));
    } else if (g) {
      const say = el.input('', { placeholder: 'Say something as the caller…', onkeydown: (e) => { if (e.key === 'Enter' && say.value.trim()) send({ speech: say.value }); } });
      const chips = ['Yes, I am interested', 'How much does it cost?', 'Call me tomorrow evening', 'Not interested', 'I want to talk to a person'];
      setKids(ctrls, h('div', { class: 'chips' }, chips.map((c) => h('button', { onclick: () => send({ speech: c }) }, c))),
        h('div', { class: 'row' }, say, SR && h('button', { class: 'btn sec', title: 'Speak with your microphone', onclick: () => { const rcg = new SR(); rcg.lang = flow.language || 'en-IN'; rcg.onresult = (e) => send({ speech: e.results[0][0].transcript }); rcg.onerror = () => toast('Microphone not available', true); rcg.start(); toast('Listening…'); } }, '🎤'),
          h('button', { class: 'btn', onclick: () => say.value.trim() && send({ speech: say.value }) }, 'Say')),
        h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: () => send({ noinput: true }) }, 'Stay silent'), h('div', { class: 'grow' }), hangBtn()));
    } else if (dl) {
      setKids(ctrls, h('p', {}, `Transferring to ${dl.number}…`), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => send({ dialStatus: 'completed' }) }, 'Agent answered'), h('button', { class: 'btn sec', onclick: () => send({ dialStatus: 'no-answer' }) }, 'No answer'), h('div', { class: 'grow' }), hangBtn()));
    } else if (rec) {
      const vm = el.area('', { rows: 3, placeholder: 'What the caller says in the voicemail' });
      setKids(ctrls, vm, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => send({ recordingUrl: 'simulated', speech: vm.value }) }, 'Leave voicemail'), h('div', { class: 'grow' }), hangBtn()));
    } else setKids(ctrls, hangBtn());
  }

  modal('Test call — ' + flow.name, h('div', { class: 'sim' },
    h('div', { class: 'sim-setup' }, fld('Caller number', phone), fld('Direction', dir), window.speechSynthesis && inline(speak, 'Read the IVR lines aloud'), h('button', { class: 'btn', style: 'margin-top:14px', onclick: start }, icon('phone'), 'Start call'),
      h('p', { class: 'muted hint' }, 'Keypad menus show a dial pad; AI steps take typed or spoken answers. Everything is saved under Call Logs.')),
    h('div', { class: 'ph' }, h('div', { class: 'ph-top' }, flow.name), screen, ctrls)), [], true);
}

MODULES.ivrflows = { title: 'IVR Flows', render: listModule({
  res: 'ivr', path: '/hub/ivr/flows', title: 'Flow', search: true,
  note: 'A flow is what callers hear: greetings, keypad menus, an AI voice agent that answers questions, transfers to your team and voicemail. Steps can mark an intent, which runs the CRM actions from Intent Mapping.',
  cols: [{ k: 'name' }, { k: 'description' }, { k: 'nodes.length', label: 'Steps' }, { k: 'active', pill: true }, { k: 'isDefaultInbound', label: 'Inbound default', pill: true }, { k: 'updatedAt', label: 'Updated', date: true }],
  barExtra: [{ label: '+ New flow', show: () => can('ivr', 'c'), run: (reload) => flowEditor(null, reload) }],
  actions: [
    { label: 'Edit', perm: ['ivr', 'u'], run: (r, reload) => flowEditor(r, reload) },
    { label: 'Test call', perm: ['ivr', 'c'], run: (r) => simulator(r) },
    { label: 'Call a number', perm: ['ivr', 'c'], run: (r) => { const p = el.input('', { placeholder: '+91…' }); modal('Place a real IVR call', h('div', {}, fld('Number', p, 'Uses the voice provider (simulated if none is connected). Respects the DND list.')), [{ label: 'Call', run: async () => { const c = await api('/hub/ivr/call', { method: 'POST', body: { flowId: r._id, phone: p.value } }); toast(`Call ${c.status}`); } }]); } },
  ],
}) };

// From a lead/customer row (Leads page).
async function ivrCallModal(kind, row) {
  const flows = (await api('/hub/ivr/flows?limit=100&active=true')).data;
  if (!flows.length) throw new Error('Create an IVR flow first (Communication Hub › IVR Flows)');
  const sel = el.select(flows.map((f) => [f._id, f.name]));
  modal(`IVR call — ${row.name}`, h('div', {}, fld('Flow', sel, `Calls ${row.phone}. The outcome and intent are logged on the ${kind.toLowerCase()}.`)), [{ label: 'Call now', run: async () => {
    const c = await api('/hub/ivr/call', { method: 'POST', body: { flowId: sel.value, kind, id: row._id } });
    toast(c.status === 'simulated' ? 'Simulated call placed (no voice provider connected). Use IVR Flows › Test call to walk through it.' : `Calling… (${c.status})`);
  } }]);
}

// ================= Call logs =================
async function callDetails(id) {
  const c = await api('/hub/ivr/calls/' + id);
  modal(`Call · ${c.phone}`, h('div', {},
    h('p', { class: 'meta' }, pill(c.status), ' ', c.direction, ' · ', c.flow?.name || 'no flow', ' · ', dur(c.durationSec), ' ', intentPill(c.intent), ' ', c.sentiment && pill(c.sentiment), c.digits ? ` · keys pressed: ${c.digits}` : '', c.simulated ? ' · simulated' : ''),
    c.summary && h('div', { class: 'infobar' }, h('b', {}, 'AI summary: '), c.summary),
    c.recordingUrl && /^https?:\/\//.test(c.recordingUrl) && h('audio', { controls: true, src: c.recordingUrl, style: 'width:100%;margin:8px 0' }),
    h('div', { class: 'chatlog' }, c.transcript.length ? c.transcript.map((t) => h('div', { class: t.role === 'caller' ? 'bub out' : t.role === 'bot' ? 'bub in' : 'bub sys' }, t.text)) : h('p', { class: 'muted' }, 'No transcript.')),
    h('p', { class: 'muted' }, 'Path: ' + (c.path.map((p) => p.node + (p.input ? ` (${p.input})` : '')).join(' → ') || '—'))), [], true);
}

MODULES.calllogs = { title: 'Call Logs', render: async (root) => {
  const bq = new URLSearchParams(location.hash.split('?')[1] || '').get('broadcast');
  const flows = can('ivr', 'c') ? (await api('/hub/ivr/flows?limit=100')).data : [];
  await listModule({
    res: 'ivr', path: '/hub/ivr/calls', title: 'Call', noDelete: true, query: bq ? { broadcast: bq } : {},
    note: bq ? 'Showing calls from one IVR broadcast. Open Call Logs from the menu to see all.' : 'Every IVR call — inbound and outbound — with what the caller pressed or said, the detected intent and an AI summary.',
    filterField: 'status', filterOpts: ['completed', 'no_answer', 'busy', 'failed', 'in_progress', 'queued', 'simulated'],
    cols: [{ k: 'createdAt', label: 'When', date: true }, { k: 'direction' }, { k: 'phone' }, { k: 'contactName', label: 'CRM contact' }, { k: 'flow.name', label: 'Flow' }, { k: 'status', pill: true }, { k: 'durationSec', label: 'Sec' }, { k: 'intent', pill: true }, { k: 'digits', label: 'Keys' }],
    barExtra: flows.length ? [{ label: 'Test a call', run: () => { const sel = el.select(flows.map((f) => [f._id, f.name])); modal('Choose a flow', fld('Flow', sel), [{ label: 'Open simulator', run: () => { simulator(flows.find((f) => f._id === sel.value)); } }]); } }] : [],
    actions: [{ label: 'Details', run: (r) => callDetails(r._id) }],
  })(root);
} };

// ================= AI bot =================
MODULES.aibot = { title: 'AI Bot & Knowledge', render: async (root) => {
  const { config: cfg, aiMode } = await api('/hub/bot');
  const ch = { sms: el.check(cfg.channels?.sms), whatsapp: el.check(cfg.channels?.whatsapp), voice: el.check(cfg.channels?.voice) };
  const name = el.input(cfg.name), tone = el.input(cfg.tone);
  const lang = el.select([['auto', 'Same as the customer (English / Hindi / Hinglish)'], ['English', 'English'], ['Hindi', 'Hindi'], ['Hinglish', 'Hinglish'], ['Marathi', 'Marathi'], ['Gujarati', 'Gujarati'], ['Tamil', 'Tamil'], ['Telugu', 'Telugu'], ['Bengali', 'Bengali']], cfg.language);
  const persona = el.area(cfg.persona, { rows: 4, placeholder: 'We are Acme Solutions, Pune. We sell CRM software for small businesses. Goal: answer questions, qualify interest and book a demo call.' });
  const conf = el.input(cfg.minConfidence, { type: 'range', min: 0, max: 1, step: 0.05 });
  const confVal = h('b', {}, Math.round(cfg.minConfidence * 100) + '%');
  conf.addEventListener('input', () => { confVal.textContent = Math.round(conf.value * 100) + '%'; });
  const turns = el.input(cfg.maxBotTurns, { type: 'number', min: 1, max: 50 });
  const autoLead = el.check(cfg.autoCreateLeads);
  const roles = Object.fromEntries(['telecaller', 'support', 'sales', 'manager'].map((r) => [r, el.check(cfg.handoffRoles.includes(r))]));
  const handoffReply = el.area(cfg.handoffReply, { rows: 2 });
  const optKw = el.input(cfg.optOutKeywords.join(', '));
  const optReply = el.area(cfg.optOutReply, { rows: 2 });

  const kbBox = h('div', { class: 'kb' });
  const kb = (cfg.knowledge || []).map((k) => ({ q: k.q, a: k.a }));
  const drawKb = () => setKids(kbBox, kb.length ? kb.map((k, i) => h('div', { class: 'kb-row' },
    el.input(k.q, { placeholder: 'Question, e.g. What are your prices?', oninput: (e) => { k.q = e.target.value; } }),
    el.area(k.a, { rows: 2, placeholder: 'Answer the AI may give', oninput: (e) => { k.a = e.target.value; } }),
    h('button', { class: 'btn sm bad', onclick: () => { kb.splice(i, 1); drawKb(); } }, '✕'))) : h('p', { class: 'muted' }, 'No answers yet. Add your prices, timings, address, offers and FAQs — the AI never invents facts that are not here.'));
  drawKb();

  const save = guard(async () => {
    await api('/hub/bot', { method: 'PUT', body: {
      channels: { sms: ch.sms.checked, whatsapp: ch.whatsapp.checked, voice: ch.voice.checked },
      name: name.value || 'Aria', tone: tone.value, language: lang.value, persona: persona.value,
      minConfidence: +conf.value, maxBotTurns: +turns.value || 6, autoCreateLeads: autoLead.checked,
      handoffRoles: Object.entries(roles).filter(([, c]) => c.checked).map(([r]) => r),
      handoffReply: handoffReply.value, optOutKeywords: optKw.value.split(',').map((x) => x.trim()).filter(Boolean), optOutReply: optReply.value,
      knowledge: kb.filter((k) => k.q?.trim() && k.a?.trim()),
    } });
    toast('AI assistant saved');
  });

  // Sandbox chat
  const history = [];
  const chat = h('div', { class: 'chatlog sandbox' }, h('p', { class: 'muted' }, 'Try a customer message. Nothing is sent and no CRM record changes. Save first to test new answers.'));
  const tch = el.select([['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['voice', 'Phone (IVR)']], 'whatsapp');
  const msg = el.input('', { placeholder: 'e.g. kitna price hai? / I want a demo tomorrow', onkeydown: (e) => { if (e.key === 'Enter') ask(); } });
  const ask = guard(async () => {
    if (!msg.value.trim()) return;
    const text = msg.value; msg.value = '';
    if (history.length === 0) setKids(chat);
    chat.append(h('div', { class: 'bub in' }, text));
    const r = await api('/hub/bot/test', { method: 'POST', body: { text, channel: tch.value, history: history.slice(-10) } });
    history.push({ role: 'caller', text }, { role: 'bot', text: r.reply });
    chat.append(h('div', { class: 'bub out bot' }, h('small', { class: 'who' }, `✨ ${name.value || 'AI'}`), h('div', { class: 'txt' }, r.reply),
      h('small', { class: 'meta' }, intentPill(r.intent), ` ${Math.round(r.confidence * 100)}% · ${r.engine}`, r.handoff ? ' · hands over to an agent' : '',
        r.actions.length ? ' · CRM: ' + r.actions.map(describeAction).join(', ') : '')));
    chat.scrollTop = chat.scrollHeight;
  });

  root.append(
    h('div', { class: aiMode === 'llm' ? 'infobar' : 'warnbar' }, aiMode === 'llm' ? 'AI engine: language model connected — the assistant understands free-form messages in any language.' : 'AI engine: built-in rules (English + Hindi/Hinglish keywords, knowledge-base matching). Add OPENAI_API_KEY or GEMINI_API_KEY in .env for full natural-language understanding.'),
    h('div', { class: 'two' },
      h('div', {},
        h('div', { class: 'card' }, h('h3', {}, 'Let the AI answer automatically on'),
          h('div', { class: 'toggles' }, inline(ch.whatsapp, 'WhatsApp'), inline(ch.sms, 'SMS'), inline(ch.voice, 'Voice (AI steps in IVR flows)')),
          h('small', { class: 'muted hint' }, 'When off, messages still land in the Inbox and are mapped to the CRM, and STOP is still honoured.')),
        h('div', { class: 'card' }, h('h3', {}, 'Personality'), h('div', { class: 'cols2' }, fld('Assistant name', name), fld('Tone', tone)), fld('Reply language', lang), fld('About your business & what the AI should achieve', persona)),
        h('div', { class: 'card' }, h('h3', {}, 'Hand over to a person'),
          fld('Hand over when the AI is less sure than', h('div', { class: 'row' }, conf, confVal)),
          h('div', { class: 'cols2' }, fld('Max AI replies per chat', turns), h('div', { class: 'fld' }, h('label', {}, 'Agents who receive chats'), h('div', { class: 'toggles' }, Object.entries(roles).map(([r, c]) => inline(c, r))))),
          fld('Message sent when handing over', handoffReply),
          h('small', { class: 'muted hint' }, 'Complaints, support questions and "talk to a person" always go to an agent (least busy, preferring the record owner).')),
        h('div', { class: 'card' }, h('h3', {}, 'CRM mapping & opt-out'), inline(autoLead, 'Create a lead for every unknown number that messages or calls'),
          fld('Opt-out keywords (comma separated)', optKw), fld('Opt-out confirmation', optReply))),
      h('div', {},
        h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Knowledge base'), h('button', { class: 'btn sm sec', onclick: () => { kb.push({ q: '', a: '' }); drawKb(); } }, '+ Add answer')), kbBox),
        h('div', { class: 'card' }, h('h3', {}, 'Test the assistant'), chat, h('div', { class: 'row' }, tch, msg, h('button', { class: 'btn', onclick: ask }, 'Send'))))),
    can('hubsetup', 'u') && h('div', { class: 'savebar' }, h('button', { class: 'btn', onclick: save }, 'Save AI assistant')));
} };

// ================= Intent mapping =================
const ACTION_LABEL = { set_status: 'Set lead status', add_tag: 'Add tag', create_task: 'Create task', notify: 'Notify', assign: 'Assign owner', handoff: 'Hand over to an agent', opt_out: 'Add to DND', send_sms: 'Send SMS', send_whatsapp: 'Send WhatsApp', send_email: 'Send email', ai_score: 'Re-score lead (AI)', update_field: 'Update field' };
function describeAction(a) {
  const d = { set_status: a.value, add_tag: a.tag, create_task: a.title, notify: a.to, send_sms: a.body, send_whatsapp: a.body, send_email: a.subject, update_field: a.field && `${a.field}=${a.value}` }[a.type];
  return ACTION_LABEL[a.type] + (d ? ` (${String(d).slice(0, 40)})` : '');
}

function actionRow(a, onremove) {
  const inp = (k, ph, w) => el.input(a[k], { placeholder: ph, style: w ? `max-width:${w}px` : '', oninput: (e) => { a[k] = e.target.value; } });
  const sel = (k, opts) => { if (a[k] == null) a[k] = Array.isArray(opts[0]) ? opts[0][0] : opts[0]; return el.select(opts, a[k], { onchange: (e) => { a[k] = e.target.value; } }); };
  let params;
  switch (a.type) {
    case 'set_status': params = [sel('value', LEAD_STAGES)]; break;
    case 'add_tag': params = [inp('tag', 'tag')]; break;
    case 'create_task': params = [inp('title', 'Task title, e.g. Call {{person.name}}'), el.input(a.dueInDays ?? 0, { type: 'number', min: 0, style: 'max-width:80px', title: 'Due in days', oninput: (e) => { a.dueInDays = +e.target.value; } }), sel('priority', ['high', 'urgent', 'medium', 'low']), sel('taskType', ['call', 'follow_up', 'meeting', 'email'])]; break;
    case 'notify': params = [sel('to', [['owner', 'record owner'], ['managers', 'managers']]), inp('title', 'Title'), inp('body', 'Message')]; break;
    case 'assign': a.strategy = 'least_loaded'; params = [h('span', { class: 'muted' }, 'least busy sales user')]; break;
    case 'send_sms': case 'send_whatsapp': params = [inp('body', 'Message, e.g. Thanks {{person.name}}!')]; break;
    case 'send_email': params = [inp('subject', 'Subject'), inp('body', 'Body')]; break;
    case 'update_field': params = [inp('field', 'field', 140), inp('value', 'value', 160)]; break;
    case 'handoff': params = [h('span', { class: 'muted' }, 'chat goes to a human; on calls, an urgent call-back task')]; break;
    case 'opt_out': params = [h('span', { class: 'muted' }, 'number is never messaged or called again')]; break;
    default: params = [];
  }
  return h('div', { class: 'act-row' }, h('b', {}, ACTION_LABEL[a.type] || a.type), h('div', { class: 'act-params' }, params), h('button', { class: 'btn sm bad', onclick: onremove }, '✕'));
}

MODULES.intentmap = { title: 'Intent Mapping', render: async (root) => {
  const { config: cfg, intents: INT, actionTypes, defaults } = await api('/hub/bot');
  const map = JSON.parse(JSON.stringify(cfg.intentActions));
  const cards = h('div', {});
  const drawIntent = (box, intent) => {
    const list = map[intent] ||= [];
    const add = el.select([['', '+ Add action…'], ...actionTypes.map((t) => [t, ACTION_LABEL[t] || t])], '', { onchange: (e) => { if (e.target.value) { list.push({ type: e.target.value }); drawIntent(box, intent); } } });
    setKids(box, h('div', { class: 'im-hd' }, intentPill(intent), h('span', { class: 'muted' }, INT[intent]), h('div', { class: 'grow' }),
      h('button', { class: 'btn sm sec', onclick: () => { map[intent] = JSON.parse(JSON.stringify(defaults[intent] || [])); drawIntent(box, intent); } }, 'Reset')),
    list.length ? list.map((a, i) => actionRow(a, () => { list.splice(i, 1); drawIntent(box, intent); })) : h('p', { class: 'muted', style: 'margin:6px 0' }, 'No CRM action — the AI just replies.'),
    can('hubsetup', 'u') && add);
  };
  for (const intent of Object.keys(INT)) { const box = h('div', { class: 'card im' }); drawIntent(box, intent); cards.append(box); }
  root.append(
    h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'When the AI detects an intent in a WhatsApp/SMS reply or an IVR call (spoken, or a keypad option marked with that intent), these actions run once on the matched lead/customer. Use {{person.name}}, {{payload.message}} and {{payload.entities.callbackTime}} in texts. For multi-step logic, build an Automation on the events message.intent or call.completed.'),
    cards,
    can('hubsetup', 'u') && h('div', { class: 'savebar' }, h('button', { class: 'btn', onclick: guard(async () => { await api('/hub/bot', { method: 'PUT', body: { intentActions: map } }); toast('Intent mapping saved'); }) }, 'Save intent mapping')));
} };

// ================= Providers =================
MODULES.providers = { title: 'Channel Providers', render: async (root) => {
  const [meta, list, flows] = await Promise.all([api('/hub/providers/meta'), api('/hub/providers'), can('ivr', 'r') ? api('/hub/ivr/flows?limit=100').then((r) => r.data) : []]);
  const NAMES = { simulated: 'Simulated (nothing is really sent)', twilio: 'Twilio', meta: 'Meta WhatsApp Cloud API', http: 'HTTP gateway (MSG91, Textlocal, Gupshup, Exotel…)' };
  const FROM = { sms: 'Sender ID / number', whatsapp: 'WhatsApp business number', voice: 'Caller ID (your voice number)' };
  const HELP = {
    twilio: 'Twilio console › Phone Numbers › your number: paste "Incoming" into "A message comes in" (or "A call comes in" for voice). Delivery reports are sent automatically when PUBLIC_URL is set.',
    meta: 'Meta developer app › WhatsApp › Configuration: Callback URL = Incoming message URL, Verify token = the one you set above; subscribe to "messages". Delivery and read receipts come on the same URL.',
    http: 'Point your gateway\'s inbound-message webhook to "Incoming" (POST JSON {"from","body","name","id"}) and its delivery report webhook to "Status" ({"id","status"}). In URL / body templates use {{to}}, {{to_digits}}, {{to_national}}, {{from}}, {{body}}.',
    simulated: 'Simulated mode logs every message and call without sending it, so you can try campaigns, the AI inbox and IVR flows safely. You can still post test messages to the Incoming URL.',
  };
  const grid = h('div', { class: 'prov-grid' });
  root.append(h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Each channel uses one provider. Credentials are stored encrypted and never shown again in full.'), grid);

  const copyRow = (label, url) => h('div', { class: 'copy' }, h('small', {}, label), h('code', {}, url), h('button', { class: 'btn sm sec', onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Copied')) }, 'Copy'));

  for (const p0 of list) {
    const box = h('div', { class: 'card' });
    grid.append(box);
    const draw = (p) => {
      const prov = el.select(meta.allowed[p.channel].map((x) => [x, NAMES[x]]), p.provider);
      const from = el.input(p.from, { placeholder: p.channel === 'sms' ? 'ACMECO or +1555…' : '+91…' });
      const active = el.check(p.active);
      const fieldsBox = h('div', {});
      const inputs = {};
      const help = h('small', { class: 'muted hint' });
      const drawFields = () => {
        for (const k of Object.keys(inputs)) delete inputs[k];
        const same = prov.value === p.provider;
        setKids(fieldsBox, (meta.fields[prov.value] || []).map((f) => {
          const v = same ? p.config[f.k] : '';
          const i = f.options ? el.select(f.options, v || f.options[0]) : f.multiline ? el.area(v, { rows: 3, placeholder: f.secret && v ? '(unchanged)' : '' }) : el.input(v, { placeholder: f.placeholder || '', autocomplete: 'off' });
          inputs[f.k] = i;
          return fld(f.label + (f.req ? ' *' : ''), i);
        }));
        help.textContent = HELP[prov.value];
      };
      prov.addEventListener('change', drawFields); drawFields();
      const flowSel = p.channel === 'voice' && el.select([['', '— the flow marked "inbound default" —'], ...flows.map((f) => [f._id, f.name])], p.inboundFlow || '');
      const testTo = el.input('', { placeholder: 'Your number', style: 'max-width:170px' });
      const save = guard(async () => {
        const body = { provider: prov.value, from: from.value.trim() || undefined, active: active.checked, config: Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])) };
        if (flowSel) body.inboundFlow = flowSel.value || null;
        draw(await api('/hub/providers/' + p.channel, { method: 'PUT', body }));
        toast('Saved');
      });
      // Meta/Twilio only deliver free text to people who messaged you in the last 24h; a template proves delivery to anyone.
      const testTpl = p.channel === 'whatsapp' && el.input('', { placeholder: 'Template, e.g. hello_world', style: 'max-width:190px', title: 'Approved template name (optional). Needed unless this number messaged you in the last 24 hours.' });
      const test = guard(async () => {
        const tpl = testTpl && testTpl.value.trim();
        const r = await api(`/hub/providers/${p.channel}/test`, { method: 'POST', body: { to: testTo.value, ...(tpl && { template: tpl }) } });
        toast(`Test ${r.status} via ${r.provider}${r.providerId ? ' · id ' + r.providerId : ''}`);
      });
      setKids(box,
        h('div', { class: 'hd' }, h('h3', { class: 'ttl-ic' }, icon(p.channel === 'sms' ? 'bulksms' : p.channel === 'whatsapp' ? 'bulkwa' : 'ivrcalls'), HUB_LABEL[p.channel]),
          p.provider === 'simulated' ? h('span', { class: 'pill paused' }, 'Simulated') : h('span', { class: 'pill ' + (p.active ? 'active' : 'paused') }, NAMES[p.provider].split(' (')[0])),
        fld('Provider', prov), fld(FROM[p.channel], from), fieldsBox,
        flowSel && fld('Inbound calls are answered by', flowSel),
        inline(active, 'Active'), help,
        p.lastError && h('div', { class: 'warnbar' }, 'Last error: ' + p.lastError),
        can('hubsetup', 'u') && h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: save }, 'Save'), h('div', { class: 'grow' }), testTo, testTpl, h('button', { class: 'btn sec', onclick: test }, p.channel === 'voice' ? 'Test call' : 'Send test')),
        p.webhooks ? h('div', { class: 'hooks' }, h('label', {}, 'Webhook URLs for your provider'),
          Object.entries(p.webhooks).map(([k, u]) => copyRow(k === 'inbound' ? (p.channel === 'voice' ? 'Incoming call' : 'Incoming message') : 'Status / delivery report', u)),
          !p.publicUrlSet && p.provider !== 'simulated' && h('div', { class: 'warnbar' }, 'Set PUBLIC_URL in .env to your public https address so the provider can reach this server (needed for delivery reports and outbound calls).'))
          : h('p', { class: 'muted' }, 'Save once to get the webhook URLs.'));
    };
    draw(p0);
  }
} };

// ================= DND =================
MODULES.dnd = { title: 'DND / Opt-outs', render: listModule({
  res: 'hubsetup', path: '/hub/optouts', title: 'Number', filterField: 'channel', filterOpts: ['all', 'sms', 'whatsapp', 'voice'], noEdit: true,
  note: 'Numbers here are skipped by every broadcast, workflow and reply. People are added automatically when they reply STOP, press the opt-out key in an IVR menu, or the AI detects an opt-out.',
  cols: [{ k: 'createdAt', label: 'Added', date: true }, { k: 'phone' }, { k: 'channel', pill: true }, { k: 'source', pill: true }, { k: 'reason' }],
  fields: [{ k: 'phone', req: true }, { k: 'channel', type: 'select', opts: ['all', 'sms', 'whatsapp', 'voice'], req: true }, { k: 'reason' }],
}) };
