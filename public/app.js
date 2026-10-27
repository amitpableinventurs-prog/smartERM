'use strict';
/* Smart CRM panel UI. Each role gets its own menu; the API enforces permissions regardless. */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
// Like el.replaceChildren but accepts nested arrays and skips null/false.
function setKids(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(k))));
}
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  ks.slice(0, -1).reduce((x, k) => (x[k] ??= {}), o)[ks.at(-1)] = v;
}
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '');
const money = (n) => '₹' + (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  leads: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  customers: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  deals: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  tasks: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  communications: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  templates: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  campaigns: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  workflows: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  reports: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  ai: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  pipelines: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  users: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  audit: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  company: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8L7 17M17 7l2.8-2.8"/>',
  notifications: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  adsdash: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  adcampaigns: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  adcreatives: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  admetrics: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  adaccounts: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  adattr: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  adinsights: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  adai: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  adutm: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  hrdash: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  hremp: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  hrattend: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  hrleave: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  hrholidays: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  hrpayroll: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  hrsettings: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8L7 17M17 7l2.8-2.8"/>',
  myspace: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};
function icon(name) {
  const w = h('span', { style: 'display:inline-flex' });
  w.innerHTML = '<svg class="ic" viewBox="0 0 24 24">' + (ICONS[name] || ICONS.dashboard) + '</svg>'; // static trusted markup
  return w.firstChild;
}
function avatar(name, size) {
  const t = String(name || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
  let n = 0; for (const c of String(name)) n = (n * 31 + c.charCodeAt(0)) % 360;
  return h('span', { class: 'av' + (size === 'lg' ? ' lg' : ''), style: 'background:linear-gradient(135deg,hsl(' + n + ' 70% 55%),hsl(' + ((n + 40) % 360) + ' 70% 45%))' + (size === 'sm' ? ';width:26px;height:26px;font-size:10px' : '') }, t);
}
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------- session & api ----------
const S = { user: JSON.parse(localStorage.getItem('crm_user') || 'null'), access: localStorage.getItem('crm_at'), refresh: localStorage.getItem('crm_rt') };
function saveSession(r) {
  if (r.user) S.user = r.user;
  if (r.workspace) S.user = { ...S.user, workspace: r.workspace }; // company name, licensed modules, branding
  S.access = r.accessToken; S.refresh = r.refreshToken;
  localStorage.setItem('crm_user', JSON.stringify(S.user));
  localStorage.setItem('crm_at', S.access); localStorage.setItem('crm_rt', S.refresh);
}
function clearSession() { S.user = S.access = S.refresh = null; S.meChecked = false; localStorage.clear(); }

// In the Windows desktop app the panels are local files and the API is the central server (desktop/preload.js).
const DESK = window.CRM_CONFIG || {};
async function raw(path, opt = {}) {
  const headers = { ...(opt.body && !opt.csv ? { 'Content-Type': 'application/json' } : {}), ...(opt.csv ? { 'Content-Type': 'text/csv' } : {}), ...(S.access ? { Authorization: 'Bearer ' + S.access } : {}), ...(DESK.deviceId ? { 'X-Device-Id': DESK.deviceId } : {}) };
  return fetch((DESK.apiBase || '') + '/api' + path, { method: opt.method || 'GET', headers, body: opt.csv ? opt.body : opt.body ? JSON.stringify(opt.body) : undefined });
}
async function api(path, opt = {}) {
  let res;
  try { res = await raw(path, opt); } catch (e) {
    // Server unreachable: serve saved data / queue the change (offline.js).
    if (opt.noOffline) throw Object.assign(e, { offline: true });
    return Offline.fallback(path, opt);
  }
  Offline.setOffline(false);
  if (res.status === 401 && S.refresh && !path.startsWith('/auth/')) {
    const r = await raw('/auth/refresh', { method: 'POST', body: { refreshToken: S.refresh } });
    if (r.ok) { saveSession(await r.json()); res = await raw(path, opt); } else { clearSession(); render(); throw new Error(r.status === 403 ? (await r.json()).error : 'Session expired'); }
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    // Company suspended or licence expired: back to the sign-in screen with the reason.
    if (res.status === 403 && data?.details?.code === 'company_blocked' && S.access) { clearSession(); render(); }
    throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status });
  }
  if ((opt.method || 'GET') === 'GET') Offline.remember(path, data);
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- permissions (mirror of server ACL; server is the real gate) ----------
const ACL = {
  manager: { hub: 'r', bulk: 'crud', ivr: 'crud', inbox: 'crud', hubsetup: 'crud', ads: 'crud', leads: 'crud', customers: 'crud', deals: 'crud', tasks: 'crud', communications: 'crud', templates: 'crud', campaigns: 'crud', workflows: 'crud', pipelines: 'crud', users: 'r', reports: 'r', ai: 'r', audit: 'r', company: 'r' },
  sales: { inbox: 'ru', leads: 'cru', customers: 'cru', deals: 'cru', tasks: 'crud', communications: 'cr', templates: 'r', campaigns: 'r', reports: 'r', ai: 'r', pipelines: 'r', users: 'r' },
  ads_manager: { ads: 'crud', leads: 'r', dashboard: 'r', reports: 'r', ai: 'r', templates: 'r' },
  hr_manager: { hr: 'crud', dashboard: 'r', reports: 'r', users: 'r' },
  support: { inbox: 'ru', ivr: 'r', leads: 'r', customers: 'cru', deals: 'r', tasks: 'cru', communications: 'cr', templates: 'r', ai: 'r', pipelines: 'r' },
  comm_manager: { hub: 'r', bulk: 'crud', ivr: 'crud', inbox: 'crud', hubsetup: 'crud', templates: 'crud', leads: 'r', customers: 'r', communications: 'cr', ai: 'r', reports: 'r', users: 'r' },
  telecaller: { inbox: 'ru', leads: 'ru', customers: 'r', tasks: 'cru', communications: 'cr', templates: 'r', ai: 'r', users: 'r' },
};
const can = (res, act) => ['super_admin', 'admin'].includes(S.user.role) || !!ACL[S.user.role]?.[res]?.includes(act);
const isAdmin = () => ['super_admin', 'admin'].includes(S.user.role);
const PANEL = { super_admin: 'Super Admin Panel', admin: 'Admin Panel', manager: 'Manager Panel', sales: 'Sales Panel', support: 'Support Panel', ads_manager: 'Ads Manager Panel', hr_manager: 'HR & Payroll Panel', comm_manager: 'Communication Hub Panel', telecaller: 'Agent / Telecaller Panel' };

// ---------- modal & form ----------
function modal(title, body, buttons = [], wide) {
  const close = () => m.remove();
  const m = h('div', { class: 'modal' + (wide ? ' wide' : '') }, h('div', {}, h('h3', {}, title), body,
    h('div', { class: 'acts' }, buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), onclick: guard(async () => { if ((await b.run?.(close)) !== false && !b.keep) close(); }) }, b.label)),
      h('button', { class: 'btn sec', onclick: close }, 'Close'))));
  document.body.append(m);
  return close;
}

function fieldEl(f, val) {
  if (val && typeof val === 'object' && val._id) val = val._id; // populated reference -> id
  let el;
  if (f.type === 'ref') {
    el = h('select', {}, h('option', { value: '' }, '— select —'));
    api(f.src + (f.src.includes('?') ? '&' : '?') + 'limit=100').then((r) => {
      (Array.isArray(r) ? r : r.data).forEach((o) => el.append(h('option', { value: o._id || o.id }, o.name || o.title)));
      if (val != null && val !== '') el.value = val;
    }).catch(() => {});
  } else if (f.type === 'select') el = h('select', {}, !f.req && h('option', { value: '' }, '—'), f.opts.map((o) => h('option', { value: o }, o)));
  else if (f.type === 'textarea' || f.type === 'json') el = h('textarea', {});
  else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', style: 'width:auto' });
  else el = h('input', { type: f.type === 'number' ? 'number' : f.type === 'datetime' ? 'datetime-local' : f.type === 'date' ? 'date' : f.type === 'password' ? 'password' : 'text' });
  if (val != null && val !== '') {
    if (f.type === 'checkbox') el.checked = !!val;
    else if (f.type === 'json') el.value = JSON.stringify(val, null, 2);
    else if (f.type === 'tags') el.value = [].concat(val).join(', ');
    else if (f.type === 'date') el.value = new Date(val).toISOString().slice(0, 10);
    else if (f.type === 'datetime') el.value = new Date(new Date(val) - new Date(val).getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    else el.value = val;
  }
  return el;
}
function readField(f, el) {
  const v = f.type === 'checkbox' ? el.checked : el.value.trim();
  if (v === '' || v == null) return undefined;
  if (f.type === 'number') return Number(v);
  if (f.type === 'json') return JSON.parse(v);
  if (f.type === 'tags') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (f.type === 'datetime') return new Date(v).toISOString();
  if (f.type === 'date') return v;
  return v;
}
function form(fields, row = {}) {
  const els = fields.map((f) => fieldEl(f, get(row, f.k)));
  const node = h('div', {}, fields.map((f, i) => [h('label', {}, f.label || f.k, f.req ? ' *' : ''), els[i]]));
  node.values = () => {
    const out = {};
    fields.forEach((f, i) => {
      let v;
      try { v = readField(f, els[i]); } catch { throw new Error(`${f.label || f.k}: invalid value`); }
      if (f.req && v === undefined) throw new Error(`${f.label || f.k} is required`);
      if (v !== undefined) setPath(out, f.k, v);
    });
    return out;
  };
  return node;
}

// ---------- generic list module ----------
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost'];
const SOURCES = ['manual', 'website', 'form', 'referral', 'whatsapp', 'sms', 'ivr', 'bulk', 'event', 'ads', 'justdial', 'import'];

function pill(v) { return v == null || v === '' ? '' : h('span', { class: 'pill ' + String(v) }, String(v)); }
const cell = (row, c) => {
  const v = get(row, c.k);
  if (c.who) return h('div', { class: 'who' }, avatar(v), h('div', {}, h('b', {}, v), row.email && h('small', {}, row.email)));
  if (c.score) { const col = v >= 70 ? 'var(--ok)' : v >= 40 ? 'var(--warn)' : 'var(--bad)'; return h('span', { class: 'score', style: '--c:' + col }, h('i', {}, h('b', { style: 'width:' + (v || 0) + '%' })), v ?? 0); }
  if (c.pill) return pill(v);
  if (c.date) return fmtDate(v);
  if (c.money) return money(v);
  return Array.isArray(v) ? v.join(', ') : v ?? '';
};

function listModule(cfg) {
  return async function (root) {
    const st = { page: 1, q: '', filter: '' };
    const holder = h('div', {});
    const bar = h('div', { class: 'bar' });
    root.append(...(cfg.note ? [h('p', { class: 'muted', style: 'margin:0 0 12px' }, cfg.note)] : []), bar, holder);
    if (cfg.search !== false) bar.append(h('div', { class: 'search' }, icon('search'), h('input', { placeholder: 'Search… (press Enter)', onkeydown: (e) => { if (e.key === 'Enter') { st.q = e.target.value; st.page = 1; load(); } } })));
    bar.append(h('div', { class: 'grow' }));
    if (cfg.filterField) bar.append(h('select', { onchange: (e) => { st.filter = e.target.value; st.page = 1; load(); } }, h('option', { value: '' }, `All ${cfg.filterField}`), cfg.filterOpts.map((o) => h('option', { value: o }, o))));
    if (can(cfg.res, 'c') && cfg.fields) bar.append(h('button', { class: 'btn', onclick: () => edit() }, icon('plus'), 'New ' + cfg.title.toLowerCase()));
    (cfg.barExtra || []).forEach((b) => (!b.show || b.show()) && bar.append(h('button', { class: 'btn sec', onclick: guard(() => b.run(load)) }, b.label)));

    function edit(row) {
      if (cfg.editor) return cfg.editor(row, load); // a module with its own editor (e.g. the workflow builder)
      const fields = cfg.fields.filter((f) => (row ? !f.createOnly : !f.editOnly));
      const f = form(fields, row || {});
      modal((row ? 'Edit ' : 'New ') + cfg.title, f, [{ label: 'Save', run: async () => {
        const body = f.values();
        const q = !row && cfg.forceCreate ? '?force=true' : '';
        try { await api(cfg.path + (row ? '/' + row._id : q), { method: row ? 'PATCH' : 'POST', body }); }
        catch (e) {
          if (!row && /duplicate/i.test(e.message) && confirm(e.message + '\n\nCreate anyway?')) await api(cfg.path + '?force=true', { method: 'POST', body });
          else throw e;
        }
        toast('Saved'); load();
      } }]);
    }

    const load = guard(async () => {
      const qs = new URLSearchParams({ page: st.page, limit: 15, ...(typeof cfg.query === 'function' ? cfg.query() : cfg.query || {}) });
      if (st.q) qs.set('q', st.q);
      if (st.filter) qs.set(cfg.filterField, st.filter);
      const r = await api(`${cfg.path}?${qs}`);
      const rows = cfg.rows ? cfg.rows(Array.isArray(r) ? r : r.data) : Array.isArray(r) ? r : r.data; // cfg.rows adds computed columns
      const acts = (cfg.actions || []).filter((a) => !a.perm || can(...a.perm));
      const tbl = h('table', {}, h('thead', {}, h('tr', {}, cfg.cols.map((c) => h('th', {}, c.label || c.k)), h('th', {}))),
        h('tbody', {}, rows.map((row) => h('tr', {}, cfg.cols.map((c) => h('td', {}, cell(row, c))),
          h('td', { class: 'acts-cell' },
            acts.filter((a) => !a.show || a.show(row)).map((a) => h('button', { class: 'btn sm sec', onclick: guard(() => a.run(row, load)) }, a.label)),
            cfg.fields && !cfg.noEdit && can(cfg.res, 'u') && h('button', { class: 'btn sm sec', onclick: () => edit(row) }, 'Edit'),
            can(cfg.res, 'd') && !cfg.noDelete && h('button', { class: 'btn sm bad', onclick: guard(async () => { if (confirm('Delete this record?')) { await api(`${cfg.path}/${row._id}`, { method: 'DELETE' }); toast('Deleted'); load(); } }) }, 'Delete'))))));
      setKids(holder, h('div', { class: 'card flush' }, h('div', { class: 'tw' }, rows.length ? tbl : h('div', { class: 'empty' }, icon('inbox'), h('div', {}, 'Nothing here yet.'))),
        r.pages > 1 && h('div', { class: 'pager' },
          h('span', { class: 'muted' }, `Page ${r.page} of ${r.pages} · ${r.total} records`),
          h('div', {}, h('button', { class: 'btn sec sm', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, '‹ Prev'),
            h('button', { class: 'btn sec sm', disabled: st.page >= r.pages, onclick: () => { st.page++; load(); } }, 'Next ›')))));
    });
    load();
  };
}

// ---------- shared actions ----------
async function showTimeline(kind, row) {
  const items = await api(`/${kind}/${row._id}/timeline`);
  modal(`Timeline — ${row.name}`, items.length ? h('div', { class: 'tl', style: 'margin-top:14px' }, items.map((t) => h('div', { class: 'it' }, h('b', {}, t.type.replace(/[._]/g, ' ')), ' ', t.message || '', ' ', pill(t.status), h('small', {}, fmtDate(t.at))))) : h('p', { class: 'muted' }, 'No activity yet.'), [], true);
}

function messageModal(kind, row) {
  const channel = h('select', {}, ['email', 'whatsapp', 'sms'].map((c) => h('option', {}, c)));
  const subject = h('input', { placeholder: 'Subject (email only)' });
  const body = h('textarea', { placeholder: 'Message… use {{person.name}} for personalisation' });
  const purpose = h('input', { placeholder: 'AI draft: what should the message achieve?' });
  const tpl = h('select', {}, h('option', { value: '' }, '— no template —'));
  api('/templates?limit=100').then((r) => r.data.forEach((t) => tpl.append(h('option', { value: t._id }, `${t.name} (${t.channel})`)))).catch(() => {});
  const node = h('div', {}, h('label', {}, 'Channel'), channel, h('label', {}, 'Template'), tpl, h('label', {}, 'Subject'), subject, h('label', {}, 'Message'), body,
    can('ai', 'r') && [h('label', {}, 'AI assistant'), purpose, h('button', { class: 'btn sm sec', style: 'margin-top:6px', onclick: guard(async () => {
      const r = await api('/ai/generate', { method: 'POST', body: { kind, id: row._id, channel: channel.value, purpose: purpose.value || 'follow up' } });
      const m = /^Subject:\s*(.*)\n+/i.exec(r.text);
      if (m) { subject.value = m[1]; body.value = r.text.slice(m[0].length); } else body.value = r.text;
    }) }, 'Generate draft')]);
  modal(`Message ${row.name}`, node, [{ label: 'Send', run: async () => {
    await api('/communications/send', { method: 'POST', body: { channel: channel.value, kind, id: row._id, templateId: tpl.value || undefined, subject: subject.value || undefined, body: body.value || undefined } });
    toast('Message sent');
  } }]);
}

async function assignModal(row, reload) {
  const users = await api('/users');
  const sel = h('select', {}, users.filter((u) => u.active).map((u) => h('option', { value: u.id || u._id }, `${u.name} (${u.role})`)));
  modal('Assign lead', h('div', {}, h('label', {}, 'Assign to'), sel), [{ label: 'Assign', run: async () => { await api(`/leads/${row._id}/assign`, { method: 'POST', body: { userId: sel.value } }); toast('Assigned'); reload(); } }]);
}

function noteModal(path, row) {
  const t = h('textarea', {});
  modal('Add note', h('div', {}, t), [{ label: 'Save', run: async () => { await api(`${path}/${row._id}/notes`, { method: 'POST', body: { text: t.value } }); toast('Note added'); } }]);
}

// ---------- module configs ----------
const MODULES = {};
const userOpts = []; // filled lazily where needed

MODULES.leads = { title: 'Leads', icon: 'Leads', render: listModule({
  res: 'leads', path: '/leads', title: 'Lead', filterField: 'status', filterOpts: LEAD_STAGES,
  cols: [{ k: 'name', who: true }, { k: 'email' }, { k: 'phone' }, { k: 'source' }, { k: 'status', pill: true }, { k: 'score', score: true }, { k: 'assignedTo.name', label: 'Owner' }],
  fields: [{ k: 'name', req: true }, { k: 'email' }, { k: 'phone' }, { k: 'organization' }, { k: 'source', type: 'select', opts: SOURCES }, { k: 'budget', type: 'number' }, { k: 'status', type: 'select', opts: LEAD_STAGES, editOnly: true, req: true }, { k: 'branch' }, { k: 'tags', type: 'tags' }],
  barExtra: [
    { label: 'Import CSV', show: () => can('leads', 'c'), run: (reload) => { const t = h('textarea', { placeholder: 'name,email,phone,source\nJohn,john@x.com,+1555,website' });
      modal('Import leads (CSV with header row)', t, [{ label: 'Import', run: async () => { const r = await api('/data/import/leads', { method: 'POST', body: t.value, csv: true }); toast(`Imported ${r.imported}, skipped ${r.skipped}, failed ${r.failed}`); reload(); } }], true); } },
    { label: 'Export CSV', run: async () => { const r = await raw('/data/export/leads'); const a = h('a', { href: URL.createObjectURL(await r.blob()), download: 'leads.csv' }); a.click(); } },
  ],
  actions: [
    { label: 'Timeline', run: (r) => showTimeline('leads', r) },
    { label: 'Message', perm: ['communications', 'c'], run: (r) => messageModal('Lead', r) },
    { label: 'Note', perm: ['leads', 'u'], run: (r) => noteModal('/leads', r) },
    { label: 'IVR call', perm: ['ivr', 'c'], show: (r) => !!r.phone, run: (r) => ivrCallModal('Lead', r) },
    { label: 'AI next step', perm: ['ai', 'r'], run: async (r) => { const a = await api('/ai/next-best-action/' + r._id); modal('Next best action', h('div', {}, h('p', {}, h('b', {}, `Score ${a.lead.score}% · `), a.action), pill(a.priority), h('p', { class: 'muted' }, `engine: ${a.engine}`))); } },
    { label: 'Re-score', perm: ['leads', 'u'], run: async (r, reload) => { const s = await api(`/leads/${r._id}/score`, { method: 'POST' }); toast(`Score ${s.score}: ${s.reason}`); reload(); } },
    { label: 'Assign', show: () => S.user.role !== 'sales' && can('leads', 'u'), run: (r, reload) => assignModal(r, reload) },
    { label: 'Convert', perm: ['customers', 'c'], show: (r) => !r.customer, run: async (r, reload) => { await api(`/leads/${r._id}/convert`, { method: 'POST' }); toast('Converted to customer'); reload(); } },
  ],
}) };

MODULES.customers = { title: 'Customers', render: listModule({
  res: 'customers', path: '/customers', title: 'Customer', filterField: 'lifecycle', filterOpts: ['prospect', 'active', 'at_risk', 'churned', 'vip'],
  cols: [{ k: 'name', who: true }, { k: 'email' }, { k: 'phone' }, { k: 'organization' }, { k: 'lifecycle', pill: true }, { k: 'lastActivityAt', label: 'Last activity', date: true }],
  fields: [{ k: 'name', req: true }, { k: 'email' }, { k: 'phone' }, { k: 'organization' }, { k: 'address' }, { k: 'birthday', type: 'datetime' }, { k: 'lifecycle', type: 'select', opts: ['prospect', 'active', 'at_risk', 'churned', 'vip'] }, { k: 'tags', type: 'tags' }],
  actions: [
    { label: 'Timeline', run: (r) => showTimeline('customers', r) },
    { label: 'Message', perm: ['communications', 'c'], run: (r) => messageModal('Customer', r) },
    { label: 'Purchase', perm: ['customers', 'u'], run: (r, reload) => { const f = form([{ k: 'item', req: true }, { k: 'amount', type: 'number' }]); modal('Add purchase', f, [{ label: 'Save', run: async () => { await api(`/customers/${r._id}/purchases`, { method: 'POST', body: f.values() }); toast('Added'); reload(); } }]); } },
    { label: 'Churn risk', perm: ['ai', 'r'], run: async (r) => { const c = await api(`/customers/${r._id}/churn`); modal('Churn risk', h('p', {}, h('b', {}, c.risk + '% '), pill(c.level), ` · ${c.daysInactive} days inactive`)); } },
  ],
}) };

const dealActions = [
  { label: 'Won', perm: ['deals', 'u'], show: (r) => r.status === 'open', run: async (r, reload) => { await api(`/deals/${r._id}/win`, { method: 'POST', body: {} }); toast('Deal won 🎉'); reload(); } },
  { label: 'Lost', perm: ['deals', 'u'], show: (r) => r.status === 'open', run: async (r, reload) => { const reason = prompt('Reason for losing?'); if (reason === null) return; await api(`/deals/${r._id}/lose`, { method: 'POST', body: { reason } }); reload(); } },
  { label: 'Payment', perm: ['deals', 'u'], run: async (r, reload) => { const a = prompt('Amount received?'); if (!a) return; await api(`/deals/${r._id}/payments`, { method: 'POST', body: { amount: Number(a) } }); toast('Payment recorded'); reload(); } },
];
MODULES.deals = { title: 'Deals', render: async (root) => {
  const board = h('div', {});
  const list = h('div', {});
  root.append(h('div', { class: 'bar' }, h('button', { class: 'btn sec', onclick: () => { list.hidden = false; board.hidden = true; } }, 'List'), h('button', { class: 'btn sec', onclick: guard(showBoard) }, 'Board')), list, board);
  board.hidden = true;
  await listModule({
    res: 'deals', path: '/deals', title: 'Deal', filterField: 'status', filterOpts: ['open', 'won', 'lost'],
    cols: [{ k: 'title' }, { k: 'value', money: true }, { k: 'stage' }, { k: 'status', pill: true }, { k: 'customer.name', label: 'Customer' }, { k: 'assignedTo.name', label: 'Owner' }],
    fields: [{ k: 'title', req: true }, { k: 'value', type: 'number' }, { k: 'stage' }, { k: 'probability', type: 'number' }, { k: 'expectedCloseDate', type: 'datetime' }, { k: 'lead', label: 'Lead ID', createOnly: true }, { k: 'customer', label: 'Customer ID', createOnly: true }],
    actions: dealActions,
  })(list);
  async function showBoard() {
    list.hidden = true; board.hidden = false;
    const pipes = (await api('/pipelines')).data;
    const sel = h('select', { onchange: draw }, pipes.map((p) => h('option', { value: p._id }, p.name)));
    const area = h('div', { class: 'cols' });
    setKids(board, sel, h('div', { style: 'height:10px' }), area);
    async function draw() {
      const cols = await api('/deals/board/' + sel.value);
      const stages = cols.map((c) => c.stage);
      setKids(area, ...cols.map((c) => h('div', { class: 'col card' }, h('h4', {}, `${c.stage} · ${c.count} · ${money(c.value)}`),
        c.deals.map((d) => h('div', { class: 'kcard' }, h('b', {}, d.title), h('div', { class: 'muted' }, money(d.value)),
          can('deals', 'u') && h('select', { onchange: guard(async (e) => { await api('/deals/' + d._id, { method: 'PATCH', body: { stage: e.target.value } }); draw(); }) }, stages.map((s) => h('option', { value: s, selected: s === c.stage }, s))))))));
    }
    draw();
  }
} };

MODULES.tasks = { title: 'Tasks', render: listModule({
  res: 'tasks', path: '/tasks', title: 'Task', filterField: 'status', filterOpts: ['pending', 'in_progress', 'done', 'cancelled'],
  cols: [{ k: 'title' }, { k: 'type' }, { k: 'priority', pill: true }, { k: 'status', pill: true }, { k: 'dueAt', label: 'Due', date: true }, { k: 'recurrence' }, { k: 'assignedTo.name', label: 'Assigned' }],
  fields: [{ k: 'title', req: true }, { k: 'description', type: 'textarea' }, { k: 'type', type: 'select', opts: ['follow_up', 'call', 'meeting', 'email', 'other'] }, { k: 'priority', type: 'select', opts: ['low', 'medium', 'high', 'urgent'] }, { k: 'dueAt', type: 'datetime' }, { k: 'remindAt', type: 'datetime' }, { k: 'recurrence', type: 'select', opts: ['none', 'daily', 'weekly', 'monthly'] }, { k: 'assignedTo', type: 'ref', src: '/users', label: 'Assign to' }],
  actions: [{ label: 'Done', perm: ['tasks', 'u'], show: (r) => r.status !== 'done', run: async (r, reload) => { await api(`/tasks/${r._id}/complete`, { method: 'POST' }); toast('Completed'); reload(); } }],
}) };

MODULES.communications = { title: 'Communications', render: listModule({
  res: 'communications', path: '/communications', title: 'Call / note', search: false, filterField: 'channel', filterOpts: ['email', 'whatsapp', 'sms', 'call', 'note'], noDelete: true,
  cols: [{ k: 'createdAt', label: 'When', date: true }, { k: 'channel' }, { k: 'direction' }, { k: 'to' }, { k: 'from' }, { k: 'subject' }, { k: 'body' }, { k: 'status', pill: true }, { k: 'sentiment', pill: true }],
  fields: [{ k: 'channel', type: 'select', opts: ['call', 'note'], req: true }, { k: 'body', type: 'textarea', label: 'Notes / transcript' }, { k: 'durationSec', type: 'number', label: 'Duration (sec)' }, { k: 'relatedTo.kind', type: 'select', opts: ['Lead', 'Customer'] }, { k: 'relatedTo.id', label: 'Lead/Customer ID' }],
  actions: [{ label: 'AI analyze', perm: ['ai', 'r'], show: (r) => !!r.body, run: async (r, reload) => { const a = await api(`/communications/${r._id}/analyze`, { method: 'POST' }); modal('AI analysis', h('div', {}, pill(a.sentiment), h('p', {}, a.summary))); reload(); } }],
}) };

MODULES.templates = { title: 'Templates', render: listModule({
  res: 'templates', path: '/templates', title: 'Template', filterField: 'channel', filterOpts: ['email', 'whatsapp', 'sms'],
  cols: [{ k: 'name' }, { k: 'channel' }, { k: 'subject' }, { k: 'body' }],
  fields: [{ k: 'name', req: true }, { k: 'channel', type: 'select', opts: ['email', 'whatsapp', 'sms'], req: true }, { k: 'subject' }, { k: 'body', type: 'textarea', req: true }],
}) };

MODULES.campaigns = { title: 'Campaigns', render: listModule({
  res: 'campaigns', path: '/campaigns', title: 'Campaign', filterField: 'status', filterOpts: ['draft', 'running', 'paused', 'completed'],
  cols: [{ k: 'name' }, { k: 'channel' }, { k: 'audience.model', label: 'Audience' }, { k: 'status', pill: true }, { k: 'stats.enrolled', label: 'Enrolled' }, { k: 'stats.sent', label: 'Sent' }, { k: 'stats.failed', label: 'Failed' }],
  fields: [{ k: 'name', req: true }, { k: 'channel', type: 'select', opts: ['email', 'whatsapp', 'sms'], req: true }, { k: 'audience.model', type: 'select', opts: ['Lead', 'Customer'], req: true }, { k: 'audience.filter', type: 'json', label: 'Audience filter (JSON, e.g. {"source":"website"})' }, { k: 'steps', type: 'json', req: true, label: 'Steps (JSON: [{"delayDays":0,"subject":"Hi {{person.name}}","body":"…"}, …])' }, { k: 'cost', type: 'number' }],
  actions: [
    { label: 'Launch', perm: ['campaigns', 'u'], show: (r) => ['draft', 'paused'].includes(r.status), run: async (r, reload) => { if (!confirm('Launch this campaign now?')) return; await api(`/campaigns/${r._id}/launch`, { method: 'POST' }); toast('Launched'); reload(); } },
    { label: 'Pause', perm: ['campaigns', 'u'], show: (r) => r.status === 'running', run: async (r, reload) => { await api(`/campaigns/${r._id}/pause`, { method: 'POST' }); reload(); } },
    { label: 'Analytics', run: async (r) => { const a = await api(`/campaigns/${r._id}/analytics`); modal('Analytics — ' + r.name, h('pre', {}, JSON.stringify(a, null, 2))); } },
  ],
}) };

// ---------- visual workflow builder ----------
const EVENT_LABEL = {
  'lead.created': 'New lead (any source)', 'lead.status_changed': 'Lead stage changed', 'deal.created': 'New deal', 'deal.stage_changed': 'Deal stage changed',
  'payment.received': 'Payment received', 'followup.overdue': 'Follow-up overdue', 'customer.inactive': 'Customer inactive', 'customer.birthday': 'Customer birthday',
  'customer.anniversary': 'Customer anniversary', 'form.submitted': 'Website form submitted', 'whatsapp.received': 'WhatsApp received', 'email.received': 'Email received',
  'website.activity': 'Website activity', 'sms.received': 'SMS received', 'message.intent': 'AI detected an intent in a chat or call', 'conversation.handoff': 'Chat handed to a human',
  'call.completed': 'IVR call completed', 'justdial.enquiry': 'JustDial enquiry', 'ad.performance_updated': 'Ad numbers updated (after each sync)', 'ad.no_leads': 'Ad spending with no leads',
  'ad.budget_exhausted': 'Ad total budget used', 'ad.campaign_imported': 'New ad campaign imported', 'ad.status_changed': 'Ad campaign paused / resumed', 'ad.sync_failed': 'Ad account sync failed',
};
const STEP_DEFS = {
  ai_message: { label: '✨ AI writes & sends a message', f: [{ k: 'channel', type: 'select', opts: ['whatsapp', 'sms', 'email'] }, { k: 'purpose', type: 'textarea', label: 'What the message should do' }, { k: 'tone', placeholder: 'tone, e.g. warm' }] },
  ai_score: { label: '✨ AI lead score', f: [] },
  ai_ad_review: { label: '✨ AI reviews the ad campaign (a manager approves changes)', f: [{ k: 'maxChangePct', type: 'number', placeholder: 'max budget change % (30)' }, { k: 'everyHours', type: 'number', placeholder: 'at most every N hours (24)' }] },
  send_whatsapp: { label: 'Send WhatsApp', f: [{ k: 'body', type: 'textarea', label: 'Message, e.g. Hi {{person.name}}' }] },
  send_sms: { label: 'Send SMS', f: [{ k: 'body', type: 'textarea', label: 'Message' }] },
  send_email: { label: 'Send email', f: [{ k: 'subject', placeholder: 'Subject' }, { k: 'body', type: 'textarea', label: 'Body' }] },
  assign: { label: 'Assign to a team member', f: [{ k: 'strategy', type: 'select', opts: ['least_loaded', 'user'] }, { k: 'userId', type: 'user' }] },
  create_task: { label: 'Create a task', f: [{ k: 'title', placeholder: 'Task title' }, { k: 'dueInDays', type: 'number', placeholder: 'due in days' }, { k: 'priority', type: 'select', opts: ['low', 'medium', 'high', 'urgent'] }] },
  notify: { label: 'Notify', f: [{ k: 'to', type: 'select', opts: ['owner', 'managers'] }, { k: 'title', placeholder: 'Title' }, { k: 'body', placeholder: 'Message' }] },
  add_tag: { label: 'Add a tag', f: [{ k: 'tag', placeholder: 'tag' }] },
  update_field: { label: 'Update a field', f: [{ k: 'field', placeholder: 'field, e.g. status' }, { k: 'value', placeholder: 'new value' }] },
  ad_pause: { label: 'Pause the ad campaign', f: [] },
  ad_resume: { label: 'Resume the ad campaign', f: [] },
  ad_set_budget: { label: 'Change the ad daily budget', f: [{ k: 'changePct', type: 'number', placeholder: 'change %, e.g. 20 or -30' }, { k: 'value', type: 'number', placeholder: 'or exact amount' }, { k: 'max', type: 'number', placeholder: 'max' }] },
  wait: { label: 'Wait', f: [{ k: 'days', type: 'number', placeholder: 'days' }, { k: 'hours', type: 'number', placeholder: 'hours' }, { k: 'minutes', type: 'number', placeholder: 'minutes' }] },
  condition: { label: 'If / else', f: [] },
};
const COND_OPS = [['eq', 'is'], ['ne', 'is not'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['in', 'is one of (a, b)'], ['exists', 'is set']];
const COND_FIELDS = ['status', 'source', 'score', 'tags', 'budget', 'objective', 'dailyBudget', 'payload.intent', 'payload.channel', 'payload.to', 'payload.spend', 'payload.leads', 'payload.cpl', 'payload.ctr', 'payload.roas', 'payload.budgetUsedPct', 'payload.today.spend'];

function workflowEditor(meta) {
  return (row, reload) => {
    const st = row ? JSON.parse(JSON.stringify({ name: row.name, active: row.active, trigger: row.trigger || {}, steps: row.steps || [] })) : { name: '', active: false, trigger: { event: 'lead.created', conditions: [] }, steps: [] };
    st.trigger.conditions ||= [];
    let jsonMode = false;
    const body = h('div', {});
    const num = (v) => (v === '' ? undefined : Number(v));
    const setVal = (o, k, v) => { if (v === undefined || v === '') delete o[k]; else o[k] = v; };
    const input = (o, f, onChange) => {
      let el;
      if (f.type === 'select') { el = h('select', {}, f.opts.map((x) => h('option', { value: x }, x))); if (o[f.k] != null && !f.opts.includes(String(o[f.k]))) el.append(h('option', { value: o[f.k] }, o[f.k])); el.value = o[f.k] ?? f.opts[0]; if (o[f.k] == null) o[f.k] = f.opts[0]; }
      else if (f.type === 'user') el = fieldEl({ type: 'ref', src: '/users' }, o[f.k]);
      else if (f.type === 'textarea') { el = h('textarea', { rows: 2, placeholder: f.label || f.k, style: 'flex-basis:100%' }); el.value = o[f.k] ?? ''; }
      else el = h('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || f.label || f.k, value: o[f.k] ?? '' });
      el.addEventListener(f.type === 'select' || f.type === 'user' ? 'change' : 'input', () => { setVal(o, f.k, f.type === 'number' ? num(el.value) : el.value); onChange?.(); });
      return el;
    };
    const condRow = (c, list, i) => {
      const op = h('select', {}, COND_OPS.map(([v, l]) => h('option', { value: v }, l))); op.value = c.op || 'eq';
      const val = h('input', { placeholder: 'value', value: Array.isArray(c.value) ? c.value.join(', ') : c.value ?? '' });
      const field = h('input', { placeholder: 'field', list: 'wf-fields', value: c.field ?? '' });
      const sync = () => { c.field = field.value.trim(); c.op = op.value; c.value = op.value === 'in' ? val.value.split(',').map((x) => x.trim()).filter(Boolean) : val.value; val.style.display = op.value === 'exists' ? 'none' : ''; };
      [field, val].forEach((x) => x.addEventListener('input', sync)); op.addEventListener('change', sync); sync();
      return h('div', { class: 'act-row' }, h('b', {}, i ? 'and' : 'only when'), h('div', { class: 'act-params' }, field, op, val), h('button', { class: 'btn sm bad', onclick: () => { list.splice(i, 1); draw(); } }, '✕'));
    };
    const stepList = (list, depth) => h('div', { style: depth ? 'margin-left:18px;padding-left:12px;border-left:2px solid var(--line)' : '' },
      list.map((s, i) => stepRow(s, list, i, depth)),
      h('div', { class: 'act-params', style: 'margin:8px 0' }, (() => {
        const sel = h('select', {}, h('option', { value: '' }, '+ Add a step…'), Object.entries(STEP_DEFS).filter(([t]) => meta.stepTypes.includes(t)).map(([t, d]) => h('option', { value: t }, d.label)));
        sel.addEventListener('change', () => { if (!sel.value) return; list.push(sel.value === 'condition' ? { type: 'condition', if: { field: 'score', op: 'gte', value: '70' }, then: [], else: [] } : { type: sel.value }); draw(); });
        return sel;
      })()));
    const stepRow = (s, list, i, depth) => {
      const def = STEP_DEFS[s.type] || { label: s.type, f: [] };
      const move = (d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; draw(); };
      const tools = h('div', { style: 'display:flex;gap:4px' }, h('button', { class: 'btn sm sec', title: 'Move up', onclick: () => move(-1) }, '↑'), h('button', { class: 'btn sm sec', title: 'Move down', onclick: () => move(1) }, '↓'), h('button', { class: 'btn sm bad', onclick: () => { list.splice(i, 1); draw(); } }, '✕'));
      if (s.type !== 'condition') return h('div', { class: 'act-row' }, h('b', {}, `${i + 1}. ${def.label}`), h('div', { class: 'act-params' }, def.f.map((f) => input(s, f))), tools);
      s.if ||= { field: 'score', op: 'gte', value: '70' };
      const kind = h('select', {}, h('option', { value: 'field' }, 'a field matches'), h('option', { value: 'no_reply' }, 'they have not replied')); kind.value = s.if.type === 'no_reply' ? 'no_reply' : 'field';
      kind.addEventListener('change', () => { s.if = kind.value === 'no_reply' ? { type: 'no_reply' } : { field: 'score', op: 'gte', value: '70' }; draw(); });
      const ifRow = s.if.type === 'no_reply' ? null : condRow(s.if, [], 0).querySelector('.act-params');
      return h('div', { style: 'border-top:1px dashed var(--line);padding:6px 0' },
        h('div', { class: 'act-row', style: 'border:0' }, h('b', {}, `${i + 1}. If`), h('div', { class: 'act-params' }, kind, ifRow), tools),
        h('div', { class: 'muted', style: 'margin:2px 0 0 4px' }, 'then'), stepList(s.then ||= [], depth + 1),
        h('div', { class: 'muted', style: 'margin:2px 0 0 4px' }, 'else'), stepList(s.else ||= [], depth + 1));
    };
    function draw() {
      if (jsonMode) {
        const ta = h('textarea', { rows: 22, style: 'font-family:monospace;font-size:12px' }); ta.value = JSON.stringify(st, null, 2);
        ta.addEventListener('input', () => { try { Object.assign(st, JSON.parse(ta.value)); ta.style.borderColor = ''; } catch { ta.style.borderColor = 'var(--bad)'; } });
        return setKids(body, h('p', { class: 'muted' }, 'Advanced: edit the workflow as JSON.'), ta);
      }
      const ev = h('select', {}, meta.events.map((e) => h('option', { value: e }, `${EVENT_LABEL[e] || e}  (${e})`))); ev.value = st.trigger.event;
      ev.addEventListener('change', () => { st.trigger.event = ev.value; });
      const name = h('input', { value: st.name, placeholder: 'e.g. Follow up new Meta leads' }); name.addEventListener('input', () => { st.name = name.value; });
      const active = h('input', { type: 'checkbox', style: 'width:auto' }); active.checked = !!st.active; active.addEventListener('change', () => { st.active = active.checked; });
      setKids(body,
        h('datalist', { id: 'wf-fields' }, COND_FIELDS.map((f) => h('option', { value: f }))),
        h('label', {}, 'Name *'), name,
        h('label', { style: 'display:flex;gap:8px;align-items:center' }, active, 'Active (runs automatically)'),
        h('h4', { style: 'margin:16px 0 4px' }, '⚡ When this happens'), ev,
        st.trigger.conditions.map((c, i) => condRow(c, st.trigger.conditions, i)),
        h('button', { class: 'btn sm sec', style: 'margin-top:6px', onclick: () => { st.trigger.conditions.push({ field: 'source', op: 'eq', value: '' }); draw(); } }, '+ Only when…'),
        h('h4', { style: 'margin:18px 0 4px' }, '▶ Do these steps'),
        st.steps.length ? null : h('p', { class: 'muted', style: 'margin:0' }, 'No steps yet. Tip: ✨ steps use AI (Gemini).'),
        stepList(st.steps, 0));
    }
    const toggle = h('button', { class: 'btn sm sec', style: 'float:right', onclick: () => { jsonMode = !jsonMode; toggle.textContent = jsonMode ? 'Visual editor' : 'Edit as JSON'; draw(); } }, 'Edit as JSON');
    draw();
    modal(row ? 'Edit workflow' : 'New workflow', h('div', {}, toggle, body), [{ label: 'Save', run: async () => {
      if (!String(st.name || '').trim()) throw new Error('Name is required');
      const payload = { name: st.name.trim(), active: !!st.active, trigger: st.trigger, steps: st.steps };
      await api('/workflows' + (row ? '/' + row._id : ''), { method: row ? 'PATCH' : 'POST', body: payload });
      toast('Saved'); reload();
    } }], true);
  };
}

MODULES.workflows = { title: 'Automation', render: async (root) => {
  const meta = await api('/workflows/meta');
  const wfFields = [{ k: 'name', req: true }]; // the builder (workflowEditor) replaces the generic form
  if (can('workflows', 'c')) {
    const sel = h('select', {}, h('option', { value: '' }, 'Install a ready-made template…'), meta.templates.map((t, i) => h('option', { value: i }, t.name)));
    root.append(h('div', { class: 'bar' }, sel, h('button', { class: 'btn sec', onclick: guard(async () => { if (sel.value === '') return; await api('/workflows/from-template/' + sel.value, { method: 'POST' }); toast('Installed (inactive — review, then activate)'); location.hash = '#/workflows?' + Date.now(); render(); }) }, 'Install')));
  }
  const holder = h('div', {}); root.append(holder);
  await listModule({
    res: 'workflows', path: '/workflows', title: 'Workflow', noDelete: false,
    cols: [{ k: 'name' }, { k: 'trigger.event', label: 'Trigger' }, { k: 'active', pill: true }, { k: 'stats.runs', label: 'Runs' }, { k: 'stats.completed', label: 'Done' }, { k: 'stats.failed', label: 'Failed' }],
    fields: wfFields, editor: workflowEditor(meta),
    actions: [
      { label: 'On/Off', perm: ['workflows', 'u'], run: async (r, reload) => { await api(`/workflows/${r._id}/toggle`, { method: 'POST' }); reload(); } },
      { label: 'Runs', run: async (r) => { const runs = await api(`/workflows/${r._id}/runs`); modal('Recent runs', runs.length ? h('div', {}, runs.map((x) => h('div', { class: 'kcard' }, h('b', {}, fmtDate(x.createdAt)), ' ', pill(x.status), x.error && h('div', { class: 'muted' }, x.error), h('div', { class: 'muted' }, x.log.map((l) => `${l.ok ? '✓' : '✗'} ${l.step} ${l.detail}`).join(' → '))))) : h('p', { class: 'muted' }, 'No runs yet.'), [], true); } },
      { label: 'Test on…', perm: ['workflows', 'u'], run: async (r) => { const f = form([{ k: 'kind', type: 'select', opts: ['Lead', 'Customer', 'Deal', 'Task', 'AdCampaign', 'AdAccount'], req: true }, { k: 'id', label: 'Record ID', req: true }]); modal('Run workflow on a record', f, [{ label: 'Run', run: async () => { const x = await api(`/workflows/${r._id}/test`, { method: 'POST', body: f.values() }); toast(`Run ${x[0]?.status || 'skipped (conditions not met)'}`); } }]); } },
    ],
  })(holder);
} };

MODULES.reports = { title: 'Reports', render: async (root) => {
  const names = ['leads-by-source', 'funnel', 'revenue', 'conversion', 'team', 'campaigns', 'automation'];
  const out = h('div', {});
  root.append(h('div', { class: 'bar' }, names.map((n) => h('button', { class: 'btn sec', onclick: guard(() => run(n)) }, n))), out);
  async function run(n) {
    const d = await api('/reports/' + n);
    const rows = Array.isArray(d) ? d : d.funnel || d.months || d.workflows;
    const body = rows ? table(rows) : h('pre', {}, JSON.stringify(d, null, 2));
    setKids(out, h('div', { class: 'card tw' }, h('h3', {}, n), !Array.isArray(d) && h('pre', {}, JSON.stringify(Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v !== 'object')), null, 1)), body));
  }
  run('leads-by-source');
} };
function table(rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No data.');
  const cols = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object');
  return h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', {}, String(r[c] ?? '')))))));
}

MODULES.ai = { title: 'AI Assistant', render: async (root) => {
  const q = h('input', { style: 'flex:1;min-width:300px', placeholder: 'e.g. "hot leads from website with budget over 5000"' });
  const model = h('select', {}, ['Lead', 'Customer', 'Deal'].map((m) => h('option', {}, m)));
  const out = h('div', {});
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Natural-language search'), h('div', { class: 'bar' }, q, model, h('button', { class: 'btn', onclick: guard(async () => {
    const r = await api('/ai/search', { method: 'POST', body: { query: q.value, model: model.value } });
    setKids(out, h('p', { class: 'muted' }, `Interpreted as ${JSON.stringify(r.interpretedAs)} (${r.engine})`), table(r.results.map((x) => ({ name: x.name || x.title, email: x.email || '', status: x.status || x.lifecycle || '', score: x.score ?? '' }))));
  }) }, 'Search')), out));
  const f = h('div', { class: 'card' }, h('h3', {}, 'Sales forecast'), h('p', { class: 'muted' }, 'Loading…'));
  const c = h('div', { class: 'card' }, h('h3', {}, 'Customers at churn risk'), h('p', { class: 'muted' }, 'Loading…'));
  root.append(f, c);
  const FC = { pipelineValue: ['Total pipeline value', 'pipelines', '#5b5bf0'], weightedPipeline: ['Weighted pipeline (by win chance)', 'deals', '#0a8bd6'], projectedNextMonth: ['Projected next month', 'ai', '#8b5cf6'], trailingAvgRevenue: ['Avg monthly revenue (last 3)', 'reports', '#12a150'] };
  api('/ai/forecast').then((d) => setKids(f, h('h3', {}, 'Sales forecast'), h('div', { class: 'grid', style: 'margin-bottom:0' }, Object.entries(d).map(([k, v]) => {
    const [label, ic, c] = FC[k] || [k, 'reports', '#5b5bf0'];
    return h('div', { class: 'stat', style: `--c:${c}` }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, money(v)), h('span', {}, label)));
  })))).catch((e) => toast(e.message, true));
  api('/ai/churn').then((d) => setKids(c, h('h3', {}, 'Customers at churn risk'), d.length ? table(d) : h('p', { class: 'muted' }, 'No at-risk customers.'))).catch((e) => toast(e.message, true));
  const aiStatus = await api('/ai/status');
  root.append(h('p', { class: 'muted' }, `AI mode: ${aiStatus.mode}${aiStatus.llmConfigured ? '' : ' (add OPENAI_API_KEY or GEMINI_API_KEY for LLM output)'}`));
} };

MODULES.users = { title: 'Team & Users', render: listModule({
  res: 'users', path: '/users', title: 'User', search: false, noDelete: true, filterField: 'role', filterOpts: ['super_admin', 'admin', 'manager', 'sales', 'support', 'ads_manager', 'hr_manager', 'comm_manager', 'telecaller'],
  cols: [{ k: 'name', who: true }, { k: 'email' }, { k: 'role', pill: true }, { k: 'branch' }, { k: 'active', pill: true }],
  fields: [{ k: 'name', req: true }, { k: 'email', req: true, createOnly: true }, { k: 'password', type: 'password', label: 'Password (min 8)' }, { k: 'role', type: 'select', opts: ['admin', 'manager', 'sales', 'support', 'ads_manager', 'hr_manager', 'comm_manager', 'telecaller'], req: true }, { k: 'branch' }, { k: 'active', type: 'checkbox', editOnly: true }],
}) };

MODULES.pipelines = { title: 'Pipelines', render: listModule({
  res: 'pipelines', path: '/pipelines', title: 'Pipeline', search: false,
  cols: [{ k: 'name' }, { k: 'stages' }, { k: 'isDefault', label: 'Default', pill: true }],
  fields: [{ k: 'name', req: true }, { k: 'stages', type: 'tags', req: true, label: 'Stages (comma separated, in order)' }, { k: 'isDefault', type: 'checkbox' }],
}) };

MODULES.audit = { title: 'Audit Log', render: listModule({
  res: 'audit', path: '/audit-logs', title: 'Audit', search: false, noDelete: true,
  cols: [{ k: 'createdAt', label: 'When', date: true }, { k: 'user.name', label: 'User' }, { k: 'method' }, { k: 'path' }, { k: 'status' }],
}) };

MODULES.notifications = { title: 'Notifications', render: async (root) => {
  const holder = h('div', {}); root.append(h('div', { class: 'bar' }, h('button', { class: 'btn sec', onclick: guard(async () => { await api('/notifications/read-all', { method: 'POST' }); load(); }) }, 'Mark all read')), holder);
  const load = guard(async () => {
    const r = await api('/notifications');
    setKids(holder, h('div', { class: 'card' }, r.data.length ? r.data.map((n) => h('p', {}, n.read ? '' : '● ', h('b', {}, n.title), ' ', n.body || '', ' ', h('span', { class: 'muted' }, fmtDate(n.createdAt)))) : h('p', { class: 'muted' }, 'You are all caught up.')));
  });
  load();
} };

MODULES.company = { title: 'Company Settings', render: async (root) => {
  const co = await api('/company');
  const name = h('input', { value: co.name });
  const key = h('code', {}, co.apiKey || '(hidden)');
  const jdUrl = (k) => `${DESK.apiBase || location.origin}/api/webhooks/justdial/${k}`;
  const jd = h('code', {}, jdUrl(co.apiKey));
  root.append(h('div', { class: 'card' }, h('label', {}, 'Company name'), name,
    isAdmin() && [h('label', {}, 'API key (for web-form webhook: POST /api/webhooks/form/<key>)'), key,
      h('label', {}, 'JustDial lead push URL (send it to your JustDial account manager; new enquiries become leads with source "justdial")'), jd],
    h('div', { class: 'acts' }, can('company', 'u') && h('button', { class: 'btn sec', onclick: guard(async () => { const k = (await api('/company/rotate-api-key', { method: 'POST' })).apiKey; key.textContent = k; jd.textContent = jdUrl(k); toast('Key rotated. Update the JustDial URL too.'); }) }, 'Rotate API key'),
      can('company', 'u') && h('button', { class: 'btn', onclick: guard(async () => { await api('/company', { method: 'PATCH', body: { name: name.value } }); toast('Saved'); }) }, 'Save'))));
} };

MODULES.dashboard = { title: 'Dashboard', render: async (root) => {
  const [d, rev, fun] = await Promise.all([
    api('/reports/dashboard'),
    api('/reports/revenue').catch(() => null),
    api('/reports/funnel').catch(() => null),
  ]);
  const stat = (v, l, ic, c, sub) => h('div', { class: 'stat', style: `--c:${c}` }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, v), h('span', {}, l), sub && h('div', {}, h('em', {}, sub))));
  const hr = new Date().getHours();
  const hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';

  root.append(
    h('div', { class: 'hero' },
      h('div', {}, h('h3', {}, `${hello}, ${S.user.name.split(' ')[0]} 👋`), h('p', {}, `${d.newLeads} new leads this week · ${d.followUpsDue} follow-ups need attention`)),
      h('div', { class: 'tips' }, d.aiInsights.map((i) => h('div', { class: 'tip' }, '✨ ' + i)))),
    h('div', { class: 'grid' },
      stat(d.totalLeads, 'Total leads', 'leads', '#5b5bf0', `+${d.newLeads} this week`),
      stat(d.followUpsDue, 'Follow-ups due', 'tasks', '#f08a05'),
      stat(d.wonDeals, 'Deals won', 'deals', '#12a150', `${d.lostDeals} lost`),
      stat(d.conversionRate + '%', 'Conversion rate', 'reports', '#0a8bd6'),
      stat(money(d.salesRevenue), 'Sales revenue', 'ai', '#8b5cf6', `${money(d.revenueThisMonth)} this month`),
      stat(money(d.openPipeline.value), `Open pipeline · ${d.openPipeline.deals} deals`, 'pipelines', '#e5484d')),
    h('div', { class: 'two' },
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Revenue by month')),
        rev && rev.months.length ? (() => { const max = Math.max(...rev.months.map((m) => m.revenue), 1);
          return h('div', { class: 'bars' }, rev.months.map((m) => h('div', { class: 'b', title: money(m.revenue) }, h('em', {}, money(m.revenue)), h('i', { style: `height:${Math.max(3, (m.revenue / max) * 100)}%` }), h('small', {}, m.month.slice(2)))));
        })() : h('p', { class: 'muted' }, 'No won deals yet.')),
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Sales funnel')),
        fun && fun.total ? fun.funnel.map((f) => h('div', { class: 'hbar' }, h('label', {}, f.stage.replace('_', ' ')), h('div', { class: 'tr' }, h('i', { style: `width:${f.pct}%` })), h('span', {}, `${f.reached} · ${f.pct}%`))) : h('p', { class: 'muted' }, 'No leads yet.'))),
    h('div', { class: 'two' },
      h('div', { class: 'card flush' }, h('div', { class: 'hd', style: 'padding:18px 18px 0' }, h('h3', {}, '🔥 Hottest leads')),
        d.topLeads.length ? table(d.topLeads.map((l) => ({ lead: l.name, score: l.score + '%', status: l.status }))) : h('p', { class: 'empty' }, 'No open leads.')),
      h('div', { class: 'card flush' }, h('div', { class: 'hd', style: 'padding:18px 18px 0' }, h('h3', {}, '🏆 Team performance')),
        d.teamPerformance.length ? table(d.teamPerformance.map((t) => ({ member: t.name || '—', deals: t.deals, revenue: money(t.revenue) }))) : h('p', { class: 'empty' }, 'No won deals yet.'))),
    h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Recent activity')),
      d.activityTimeline.length ? h('div', { class: 'tl' }, d.activityTimeline.map((a) => h('div', { class: 'it' }, h('b', {}, a.type.replace(/[._]/g, ' ')), ' ', a.message || '', h('small', {}, fmtDate(a.createdAt))))) : h('p', { class: 'muted' }, 'Nothing yet.')));
} };

// ================= Advertising panel =================
const PLATFORMS = ['google', 'meta', 'linkedin', 'tiktok', 'youtube', 'x', 'other'];
const PLATFORM_COLOR = { google: '#4285f4', meta: '#0866ff', linkedin: '#0a66c2', tiktok: '#ee1d52', youtube: '#ff0000', x: '#444', other: '#8b5cf6' };
const APPROVERS = ['super_admin', 'admin', 'manager'];
const num2 = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

function platformPill(p) { return h('span', { class: 'pill', style: `--c:${PLATFORM_COLOR[p] || PLATFORM_COLOR.other}` }, p || '—'); }

// Spend bars + leads line, as inline SVG (numbers only; dates come from the API as ISO strings).
function dualChart(daily) {
  if (!daily.length) return h('p', { class: 'muted' }, 'No data yet.');
  const W = 800, H = 220, P = 28, bw = (W - P * 2) / daily.length;
  const maxS = Math.max(...daily.map((d) => d.spend), 1), maxL = Math.max(...daily.map((d) => d.leads), 1);
  const bars = daily.map((d, i) => { const bh = (d.spend / maxS) * (H - P * 2); return `<rect x="${(P + i * bw + bw * 0.15).toFixed(1)}" y="${(H - P - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" rx="3" fill="url(#g1)"><title>${d.date}: spend ${d.spend}, leads ${d.leads}</title></rect>`; }).join('');
  const pts = daily.map((d, i) => `${(P + i * bw + bw / 2).toFixed(1)},${(H - P - (d.leads / maxL) * (H - P * 2)).toFixed(1)}`).join(' ');
  const w = h('div', { class: 'chart' });
  w.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#5b5bf0"/></linearGradient></defs>`
    + [0, 0.5, 1].map((f) => `<line x1="${P}" x2="${W - P}" y1="${(H - P - f * (H - P * 2)).toFixed(1)}" y2="${(H - P - f * (H - P * 2)).toFixed(1)}" stroke="currentColor" opacity=".12"/>`).join('')
    + bars + `<polyline points="${pts}" fill="none" stroke="#12a150" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<text x="${P}" y="${H - 6}" font-size="11" fill="currentColor" opacity=".6">${daily[0].date}</text><text x="${W - P}" y="${H - 6}" font-size="11" text-anchor="end" fill="currentColor" opacity=".6">${daily.at(-1).date}</text>`
    + `<text x="${P}" y="14" font-size="11" fill="currentColor" opacity=".6">max spend ${num2(maxS)}</text></svg>`
    + '<div class="legend"><span><i style="background:#6d5cf0"></i>Spend</span><span><i style="background:#12a150"></i>Leads</span></div>';
  return w;
}

function kpiGrid(t, change = {}) {
  const c = (v, inv) => (v == null ? null : h('em', { style: `color:var(--${(inv ? v <= 0 : v >= 0) ? 'ok' : 'bad'})` }, `${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}% vs previous`));
  const card = (v, l, ic, col, ch) => h('div', { class: 'stat', style: `--c:${col}` }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, v), h('span', {}, l), ch));
  return h('div', { class: 'grid' },
    card(money(t.spend), 'Total spend', 'adaccounts', '#5b5bf0', c(change.spend, true)),
    card(num2(t.impressions), 'Impressions', 'reports', '#0a8bd6', c(change.impressions)),
    card(num2(t.clicks), `Clicks · CTR ${t.ctr}%`, 'leads', '#8b5cf6', c(change.clicks)),
    card(money(t.cpc), 'Cost per click', 'adcampaigns', '#f08a05'),
    card(num2(t.leads), 'Leads', 'customers', '#12a150', c(change.leads)),
    card(money(t.cpl), 'Cost per lead', 'adattr', '#e5484d', c(change.cpl, true)),
    card(t.roas + 'x', `ROAS · revenue ${money(t.revenue)}`, 'ai', '#12a150', c(change.roas)));
}

function metricModal(preset, done) {
  const f = form([
    ...(preset ? [] : [{ k: 'campaign', type: 'ref', src: '/ads/campaigns', label: 'Campaign', req: true }]),
    { k: 'date', type: 'datetime', label: 'Date', req: true },
    { k: 'impressions', type: 'number' }, { k: 'clicks', type: 'number' }, { k: 'spend', type: 'number', label: 'Spend' },
    { k: 'leads', type: 'number' }, { k: 'conversions', type: 'number' }, { k: 'revenue', type: 'number', label: 'Revenue from ads' },
  ], { date: new Date() });
  modal('Add daily performance data', h('div', {}, h('p', { class: 'muted', style: 'margin:0' }, 'Saving a date that already exists updates it.'), f), [{ label: 'Save', run: async () => {
    const body = f.values(); if (preset) body.campaign = preset;
    await api('/ads/metrics', { method: 'POST', body }); toast('Saved'); done && done();
  } }]);
}

MODULES.adsdash = { title: 'Ads Dashboard', render: async (root) => {
  let days = 30;
  const holder = h('div', {});
  const seg = h('div', { class: 'seg' }, [7, 14, 30, 90].map((d) => h('button', { class: d === days ? 'on' : '', onclick: (e) => { days = d; seg.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); load(); } }, d + 'd')));
  root.append(h('div', { class: 'bar' }, seg, h('div', { class: 'grow' }),
    can('ads', 'c') && h('button', { class: 'btn sec', onclick: () => metricModal(null, load) }, icon('plus'), 'Add daily data'),
    can('ads', 'c') && h('a', { class: 'btn', href: '#/adcampaigns' }, icon('plus'), 'New campaign')), holder);
  const load = guard(async () => {
    const [o, ins] = await Promise.all([api('/ads/overview?days=' + days), api('/ads/insights')]);
    const top = ins.insights.slice(0, 3);
    setKids(holder, 
      (o.counts.pendingApproval || top.length) ? h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, '💡 Needs your attention'), h('a', { href: '#/adinsights', class: 'muted' }, 'See all →')),
        o.counts.pendingApproval ? h('p', {}, h('b', {}, o.counts.pendingApproval), ' campaign(s) waiting for manager approval.') : null,
        top.map((i) => h('p', { style: 'margin:6px 0' }, pill(i.severity === 'good' ? 'positive' : i.severity === 'high' ? 'urgent' : 'medium'), ' ', h('b', {}, i.campaign + ': '), i.title, h('span', { class: 'muted' }, ' — ' + i.detail)))) : null,
      kpiGrid(o.totals, o.change),
      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Daily spend & leads')), dualChart(o.daily)),
        h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Spend by platform')),
          o.platforms.length ? o.platforms.map((p) => { const max = o.platforms[0].spend || 1;
            return h('div', { class: 'hbar' }, h('label', {}, p.platform), h('div', { class: 'tr' }, h('i', { style: `width:${(p.spend / max) * 100}%;background:${PLATFORM_COLOR[p.platform] || PLATFORM_COLOR.other}` })), h('span', { style: 'width:150px' }, `${money(p.spend)} · ${p.leads} leads`)); })
            : h('p', { class: 'muted' }, 'No spend recorded in this period.'))),
      h('div', { class: 'card flush' }, h('div', { class: 'hd', style: 'padding:18px 18px 0' }, h('h3', {}, 'Top campaigns by spend')),
        o.topCampaigns.length ? table(o.topCampaigns.map((c) => ({ campaign: c.name, platform: c.platform, status: c.status, spend: money(c.spend), clicks: c.clicks, 'CTR %': c.ctr, leads: c.leads, CPL: money(c.cpl), ROAS: c.roas + 'x' }))) : h('div', { class: 'empty' }, icon('inbox'), h('div', {}, 'Add performance data to see campaigns here.'))));
  });
  load();
} };

MODULES.adaccounts = { title: 'Ad Accounts', render: async (root) => {
  const sum = h('div', { class: 'grid' }); const holder = h('div', {});
  root.append(sum, holder);
  const loadSum = guard(async () => {
    const rows = await api('/ads/accounts/summary');
    setKids(sum, ...rows.map((a) => h('div', { class: 'card', style: 'margin:0' }, h('div', { class: 'who' }, avatar(a.name), h('div', {}, h('b', {}, a.name), h('small', {}, `${a.campaigns} campaigns · ${a.activeCampaigns} active`))), h('div', { style: 'margin:10px 0 4px' }, platformPill(a.platform), ' ', pill(a.status)),
      h('div', { class: 'muted' }, `Spent this month ${money(a.spendThisMonth)}${a.monthlyBudget ? ' of ' + money(a.monthlyBudget) : ''} · ${a.leadsThisMonth} leads`),
      a.budgetUsedPct != null && h('div', { class: 'hbar', style: 'margin-bottom:0' }, h('div', { class: 'tr' }, h('i', { style: `width:${Math.min(100, a.budgetUsedPct)}%;background:${a.budgetUsedPct > 90 ? 'var(--bad)' : ''}` })), h('span', { style: 'width:46px' }, a.budgetUsedPct + '%')))));
  });
  await listModule({
    res: 'ads', path: '/ads/accounts', title: 'Ad account', filterField: 'platform', filterOpts: PLATFORMS,
    note: 'Google Ads and Meta accounts can be connected to their API: campaigns, spend and conversions sync every 3 hours, and Pause / Resume / budget changes in the CRM are applied on the ad network.',
    cols: [{ k: 'name', who: true }, { k: 'platform', pill: true }, { k: 'accountId', label: 'Account ID' }, { k: 'currency' }, { k: 'monthlyBudget', label: 'Monthly budget', money: true }, { k: 'status', pill: true },
      { k: 'api', label: 'API sync' }],
    rows: (rows) => rows.map((r) => ({ ...r, api: !API_PLATFORMS.includes(r.platform) ? '—' : !r.connected ? 'Not connected' : r.lastSyncError ? '⚠ ' + r.lastSyncError.slice(0, 60) : r.lastSyncAt ? 'Synced ' + fmtDate(r.lastSyncAt) : 'Connected' })),
    fields: [{ k: 'platform', type: 'select', opts: PLATFORMS, req: true }, { k: 'name', req: true }, { k: 'accountId', label: 'Account ID (Google: customer ID 123-456-7890 · Meta: act_123…)' }, { k: 'currency' }, { k: 'monthlyBudget', type: 'number' }, { k: 'status', type: 'select', opts: ['active', 'paused', 'disconnected'] }],
    actions: [
      { label: 'Connect API', perm: ['ads', 'u'], show: (r) => API_PLATFORMS.includes(r.platform), run: (r, reload) => connectModal(r, () => { reload(); loadSum(); }) },
      { label: 'Sync now', perm: ['ads', 'u'], show: (r) => r.connected, run: async (r, reload) => { toast('Syncing…'); const x = await api(`/ads/accounts/${r._id}/sync`, { method: 'POST', body: { days: 30 } });
        toast(`Synced: ${x.campaignsCreated} new, ${x.campaignsUpdated} updated campaigns, ${x.metricRows} days of data${x.autoPaused ? `, ${x.autoPaused} auto-paused` : ''}`); reload(); loadSum(); } },
    ],
  })(holder);
  loadSum();
} };

const API_PLATFORMS = ['google', 'meta'];
const API_HELP = {
  google: 'Account ID must be the Google Ads customer ID. Use "Sign in with Google", or paste a refresh token made with your OAuth client (OAuth Playground, scope https://www.googleapis.com/auth/adwords). If the account is managed through an MCC, enter the MCC ID.',
  meta: 'Account ID must be the ad account ID (act_…). Create a System User in Meta Business Settings, assign it the ad account, and generate a token with ads_read and ads_management. Add leads_retrieval (and assign the Facebook Page to the system user) to import lead-form leads every 10 minutes. A WhatsApp token works too if it has those permissions.',
};

// Ad network API credentials for one account. Secret values come back masked; leaving them unchanged keeps them.
async function connectModal(acc, done) {
  const c = await api(`/ads/accounts/${acc._id}/connection`);
  const fields = c.fields.map((f) => ({ k: f.k, label: f.label + (f.req ? '' : ' (optional)'), type: f.secret ? 'password' : 'text' }));
  const f = form(fields, c.config);
  const sync = h('input', { type: 'checkbox', style: 'width:auto', checked: c.autoSync });
  const pause = h('input', { type: 'checkbox', style: 'width:auto', checked: c.autoPause });
  const sd = c.serverDefaults;
  const body = h('div', {},
    h('p', { class: 'muted', style: 'margin:0' }, API_HELP[acc.platform]),
    sd && h('p', { class: 'muted' }, `Server defaults: developer token ${sd.developerToken ? 'set' : 'NOT set'} · OAuth client ${sd.oauthClient ? 'set' : 'NOT set'}`),
    c.lastSyncError && h('div', { class: 'warnbar' }, 'Last error: ' + c.lastSyncError),
    c.leadForms && c.connected && h('p', { class: 'muted', style: 'margin:0' }, c.leadSyncError ? '' : `Lead forms: checked ${c.lastLeadSyncAt ? fmtDate(c.lastLeadSyncAt) : 'not yet'}`),
    c.leadForms && c.leadSyncError && h('div', { class: 'warnbar' }, 'Lead form import: ' + c.leadSyncError),
    f,
    h('label', {}, sync, ' Sync automatically every 3 hours'),
    h('label', {}, pause, ' Auto-pause lead campaigns that spend for 14 days with no leads'));
  const buttons = [{ label: 'Save & test', run: async () => {
    const r = await api(`/ads/accounts/${acc._id}/connection`, { method: 'PUT', body: { config: f.values(), autoSync: sync.checked, autoPause: pause.checked } });
    toast(r.lastSyncError ? 'Saved, but the test failed: ' + r.lastSyncError : 'Connected. Press "Sync now" to import campaigns.', !!r.lastSyncError); done();
  } }];
  if (sd?.signIn) buttons.unshift({ keep: true, cls: 'sec', label: 'Sign in with Google', run: async () => { window.open((await api(`/ads/accounts/${acc._id}/google-signin`)).url, '_blank'); toast('Finish in the Google window, then come back and press "Sync now".'); } });
  if (c.connected) buttons.push({ cls: 'bad', label: 'Disconnect', run: async () => { if (!confirm('Remove the API credentials? Imported campaigns and data stay.')) return false; await api(`/ads/accounts/${acc._id}/connection`, { method: 'DELETE' }); toast('Disconnected'); done(); } });
  modal('Connect API — ' + acc.name, body, buttons, true);
}

MODULES.adcampaigns = { title: 'Ad Campaigns', render: listModule({
  res: 'ads', path: '/ads/campaigns', title: 'Campaign', filterField: 'status', filterOpts: ['draft', 'pending_approval', 'active', 'paused', 'ended'],
  note: 'Daily budgets above the approval limit (default ₹5,000) are sent to a manager when launched. Campaigns auto-pause when the total budget is used. Campaigns imported from Google Ads / Meta are paused, resumed and re-budgeted on the ad network too.',
  cols: [{ k: 'name' }, { k: 'account.platform', label: 'Platform', pill: true }, { k: 'objective' }, { k: 'status', pill: true }, { k: 'dailyBudget', label: 'Daily budget', money: true }, { k: 'totalBudget', label: 'Total budget', money: true }, { k: 'endDate', label: 'Ends', date: true }],
  fields: [{ k: 'name', req: true }, { k: 'account', type: 'ref', src: '/ads/accounts', label: 'Ad account', req: true, createOnly: true }, { k: 'objective', type: 'select', opts: ['leads', 'sales', 'traffic', 'awareness', 'engagement'] },
    { k: 'dailyBudget', type: 'number' }, { k: 'totalBudget', type: 'number', label: 'Total (lifetime) budget' }, { k: 'startDate', type: 'datetime' }, { k: 'endDate', type: 'datetime' },
    { k: 'externalId', label: 'Ad network campaign ID (links an existing Google/Meta campaign; set by sync for imported ones)' },
    { k: 'audience.locations', type: 'tags', label: 'Target locations (comma separated)' }, { k: 'audience.ageMin', type: 'number', label: 'Age from' }, { k: 'audience.ageMax', type: 'number', label: 'Age to' }, { k: 'audience.interests', type: 'tags', label: 'Interests (comma separated)' }, { k: 'notes', type: 'textarea' }],
  actions: [
    { label: 'Launch', perm: ['ads', 'u'], show: (r) => r.status === 'draft', run: async (r, reload) => { const x = await api(`/ads/campaigns/${r._id}/launch`, { method: 'POST' }); toast(x.message || 'Campaign is live'); reload(); } },
    { label: 'Approve', show: (r) => r.status === 'pending_approval' && APPROVERS.includes(S.user.role), run: async (r, reload) => { await api(`/ads/campaigns/${r._id}/approve`, { method: 'POST' }); toast('Approved'); reload(); } },
    { label: 'Reject', show: (r) => r.status === 'pending_approval' && APPROVERS.includes(S.user.role), run: async (r, reload) => { const reason = prompt('Reason?'); if (reason === null) return; await api(`/ads/campaigns/${r._id}/reject`, { method: 'POST', body: { reason } }); reload(); } },
    { label: 'Pause', perm: ['ads', 'u'], show: (r) => r.status === 'active', run: async (r, reload) => { await api(`/ads/campaigns/${r._id}/pause`, { method: 'POST' }); reload(); } },
    { label: 'Resume', perm: ['ads', 'u'], show: (r) => r.status === 'paused', run: async (r, reload) => { await api(`/ads/campaigns/${r._id}/resume`, { method: 'POST' }); reload(); } },
    { label: 'Performance', run: async (r) => { const p = await api(`/ads/campaigns/${r._id}/performance?days=30`);
      modal('Performance — ' + r.name, h('div', {}, kpiGrid(p.totals), h('p', { class: 'muted' }, `CRM leads attributed: ${p.crmLeads} · Lifetime spend ${money(p.totalSpentAllTime)}${p.budgetUsedPct != null ? ` (${p.budgetUsedPct}% of total budget)` : ''}`), dualChart(p.daily)), [], true); } },
    { label: 'Add data', perm: ['ads', 'c'], run: (r) => metricModal(r._id) },
    { label: 'Run automation', perm: ['ads', 'u'], run: async (r, reload) => { const x = await api(`/ads/campaigns/${r._id}/run-automation`, { method: 'POST' }); const s = x.stats;
      modal('Automation — ' + r.name, h('div', {},
        h('p', { class: 'muted', style: 'margin:0 0 10px' }, `Last 7 days: spend ${money(s.spend)} · ${s.leads} leads · CPL ${money(s.cpl)} · ROAS ${s.roas}x · CTR ${s.ctr}%. Status now: ${x.campaign.status}${x.autoPaused ? ' (auto-paused)' : ''}`),
        x.runs.length ? x.runs.map((w) => h('div', { class: 'kcard' }, h('b', {}, w.workflow || 'Workflow'), ' ', pill(w.status), w.error && h('div', { class: 'muted' }, w.error), h('div', { class: 'muted' }, w.log.join(' → '))))
          : h('p', { class: 'muted' }, 'No active workflow matched. Install an "Ads:" template under Automation and switch it on.')), [], true);
      reload(); } },
    { label: 'Track link', run: async (r) => { const u = h('input', { placeholder: 'https://yoursite.com/landing-page' }); const out = h('pre', {}, 'Enter your landing page URL and press Generate.');
      modal('Tracking link — ' + r.name, h('div', {}, h('p', { class: 'muted' }, 'Use this as the ad destination URL. When the landing page form posts utm_campaign to the CRM web-form webhook, the lead is linked to this campaign.'), u, h('div', { style: 'height:10px' }), out),
        [{ keep: true, label: 'Generate', run: async () => { const x = await api(`/ads/campaigns/${r._id}/utm?url=${encodeURIComponent(u.value)}`); out.textContent = x.url; } },
          { keep: true, cls: 'sec', label: 'Copy', run: () => navigator.clipboard?.writeText(out.textContent).then(() => toast('Copied')) }], true); } },
    { label: 'Clone', perm: ['ads', 'c'], run: async (r, reload) => { await api(`/ads/campaigns/${r._id}/clone`, { method: 'POST' }); toast('Cloned as draft'); reload(); } },
    { label: 'End', perm: ['ads', 'u'], show: (r) => r.status !== 'ended', run: async (r, reload) => { if (!confirm('End this campaign?')) return; await api(`/ads/campaigns/${r._id}/end`, { method: 'POST' }); reload(); } },
  ],
}) };

MODULES.adcreatives = { title: 'Creatives & A/B Tests', render: listModule({
  res: 'ads', path: '/ads/creatives', title: 'Creative', filterField: 'status', filterOpts: ['active', 'paused', 'rejected'],
  cols: [{ k: 'name' }, { k: 'variant', pill: true }, { k: 'campaign.name', label: 'Campaign' }, { k: 'type' }, { k: 'headline' }, { k: 'status', pill: true }],
  fields: [{ k: 'campaign', type: 'ref', src: '/ads/campaigns', label: 'Campaign', req: true, createOnly: true }, { k: 'name', req: true }, { k: 'variant', label: 'Variant (A, B, C…)' }, { k: 'type', type: 'select', opts: ['image', 'video', 'carousel', 'text'] },
    { k: 'headline' }, { k: 'body', type: 'textarea', label: 'Ad copy' }, { k: 'cta', label: 'Call to action' }, { k: 'mediaUrl', label: 'Image/video URL' }, { k: 'landingUrl' }, { k: 'status', type: 'select', opts: ['active', 'paused', 'rejected'], editOnly: true }],
  barExtra: [{ label: '✨ Write with AI', show: () => can('ads', 'c'), run: async (reload) => {
    const camps = (await api('/ads/campaigns?limit=100')).data;
    const f = form([
      { k: 'campaignId', type: 'select', opts: camps.map((c) => c._id), label: 'Campaign (to save the variants to)' },
      { k: 'product', label: 'Product / service', req: true }, { k: 'audience', label: 'Who it is for (city, age, interest…)' }, { k: 'offer', label: 'Offer (only real ones; the AI never invents discounts)' },
      { k: 'language', type: 'select', opts: ['English', 'Hinglish', 'Hindi', 'Marathi', 'Gujarati', 'Tamil', 'Telugu', 'Bengali'], req: true }, { k: 'tone', type: 'select', opts: ['friendly', 'premium', 'urgent', 'professional', 'fun'], req: true },
      { k: 'platform', type: 'select', opts: ['meta', 'google'], req: true }, { k: 'count', type: 'number', label: 'How many variants (1-6)' }, { k: 'landingUrl', label: 'Landing page URL' },
    ], { count: 3 });
    const sel = f.querySelector('select'); [...sel.options].forEach((o) => { const c = camps.find((x) => x._id === o.value); if (c) o.textContent = c.name; });
    const out = h('div', { style: 'margin-top:12px' });
    let last;
    modal('Write ad copy with AI', h('div', {}, f, out), [
      { label: '✨ Generate', keep: true, run: async () => {
        setKids(out, h('p', { class: 'muted' }, 'Writing…'));
        last = { ...f.values(), save: false };
        const r = await api('/ads/ai/copy', { method: 'POST', body: last });
        setKids(out, h('p', { class: 'muted' }, `by ${r.engine === 'heuristic' ? 'rules (AI unavailable)' : r.engine}`), r.variants.map((v, i) => h('div', { class: 'kcard' }, h('b', {}, `${'ABCDEF'[i]} · ${v.headline}`), h('span', { class: 'muted' }, ` (${v.angle})`), h('p', { style: 'margin:4px 0' }, v.body), pill(v.cta))));
        last.variants = r.variants;
      } },
      { label: 'Save as creatives', run: async () => {
        if (!last) throw new Error('Generate first');
        if (!last.campaignId) throw new Error('Choose a campaign');
        const r = await api('/ads/ai/copy', { method: 'POST', body: { ...last, save: true } });
        toast(`${r.saved.length} creatives saved`); reload();
      } },
    ], true);
  } }, { label: 'Compare A/B', run: async () => {
    const camps = (await api('/ads/campaigns?limit=100')).data;
    const sel = h('select', {}, camps.map((c) => h('option', { value: c._id }, c.name))); const out = h('div', { style: 'margin-top:14px' });
    const go = guard(async () => { const x = await api('/ads/creatives/compare/' + sel.value);
      setKids(out, x.winner ? h('p', {}, '🏆 Winner: ', h('b', {}, `${x.winner.name} (variant ${x.winner.variant})`), ` — CTR ${x.winner.ctr}%`) : h('p', { class: 'muted' }, x.note),
        x.creatives.length ? table(x.creatives.map((c) => ({ creative: c.name, variant: c.variant, impressions: c.impressions, clicks: c.clicks, 'CTR %': c.ctr, spend: money(c.spend), leads: c.leads, CPL: money(c.cpl) }))) : h('p', { class: 'muted' }, 'No creatives on this campaign.')); });
    sel.addEventListener('change', go);
    modal('Compare creatives', h('div', {}, h('label', {}, 'Campaign'), sel, out), [], true); go(); } }],
  actions: [
    { label: 'Pause', perm: ['ads', 'u'], show: (r) => r.status === 'active', run: async (r, reload) => { await api('/ads/creatives/' + r._id, { method: 'PATCH', body: { status: 'paused' } }); reload(); } },
    { label: 'Activate', perm: ['ads', 'u'], show: (r) => r.status === 'paused', run: async (r, reload) => { await api('/ads/creatives/' + r._id, { method: 'PATCH', body: { status: 'active' } }); reload(); } },
  ],
}) };

MODULES.admetrics = { title: 'Performance Data', render: listModule({
  res: 'ads', path: '/ads/metrics', title: 'Data row', search: false,
  note: 'Enter either campaign-level rows or per-creative rows for a campaign — not both, or totals are counted twice. Spend and clicks come from your ad network reports.',
  cols: [{ k: 'date', label: 'Date', date: true }, { k: 'campaign.name', label: 'Campaign' }, { k: 'creative.name', label: 'Creative' }, { k: 'impressions' }, { k: 'clicks' }, { k: 'ctr', label: 'CTR %' }, { k: 'spend', money: true }, { k: 'leads' }, { k: 'cpl', label: 'CPL', money: true }, { k: 'roas', label: 'ROAS' }],
  barExtra: [
    { label: 'Add daily data', show: () => can('ads', 'c'), run: (reload) => metricModal(null, reload) },
    { label: 'Import CSV', show: () => can('ads', 'c'), run: (reload) => { const t = h('textarea', { placeholder: 'date,campaign,impressions,clicks,spend,leads,conversions,revenue\n2026-10-01,Summer Sale,12000,340,5200,18,4,24000' });
      modal('Import ad performance (CSV)', h('div', {}, h('p', { class: 'muted', style: 'margin:0' }, 'Campaign = campaign name or its tracking code. Existing dates are updated.'), t), [{ label: 'Import', run: async () => { const r = await api('/ads/metrics/import', { method: 'POST', body: t.value, csv: true }); toast(`Saved ${r.saved}, failed ${r.failed}${r.errors[0] ? ' — ' + r.errors[0].error : ''}`, !!r.failed); reload(); } }], true); } },
  ],
}) };

MODULES.adattr = { title: 'Lead Attribution', render: async (root) => {
  const rows = await api('/ads/attribution');
  root.append(h('div', { class: 'card flush' }, rows.length ? table(rows.map((r) => ({ campaign: r.campaign, platform: r.platform, spend: money(r.spend), 'CRM leads': r.crmLeads, qualified: r.qualified, won: r.won, 'win rate %': r.winRate, revenue: money(r.revenue), 'cost / lead': money(r.costPerCrmLead), ROAS: r.roas + 'x' })))
    : h('div', { class: 'empty' }, icon('inbox'), h('div', {}, 'No attributed leads yet. Use a campaign’s Track link so form leads carry utm_campaign.'))),
  h('p', { class: 'muted' }, 'These numbers come from the CRM itself: leads that arrived through a tracked ad link and the deals they closed — a check against what the ad network reports.'));
} };

MODULES.adinsights = { title: 'Ad Insights', render: async (root) => {
  const holder = h('div', {}); root.append(holder);
  const aiBox = h('div', {});
  const askAi = guard(async (btn) => {
    btn.disabled = true; btn.textContent = 'Analysing…';
    try {
      const { ai: a } = await api('/ads/insights?ai=1');
      setKids(aiBox, h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, '✨ AI analysis'), h('span', { class: 'muted' }, a.engine === 'heuristic' ? 'AI unavailable, rules used' : `by ${a.engine}`)),
        h('p', { style: 'margin:0 0 10px' }, a.summary),
        a.priorities.map((p) => h('div', { class: 'kcard' }, h('div', {}, pill(p.impact === 'high' ? 'urgent' : p.impact), ' ', h('b', {}, p.title), h('span', { class: 'muted' }, ` · ${p.campaign}`)), h('p', { class: 'muted', style: 'margin:4px 0 0' }, p.detail))),
        can('ads', 'u') && h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn sm sec', href: '#/adai' }, 'Get AI suggestions to approve →'))));
    } finally { btn.disabled = false; btn.textContent = '✨ Analyse with AI'; }
  });
  holder.before(h('div', { class: 'bar' }, h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: (e) => askAi(e.currentTarget) }, '✨ Analyse with AI')), aiBox);
  const load = guard(async () => {
    const r = await api('/ads/insights');
    setKids(holder, h('p', { class: 'muted' }, `Rule-based review of the last ${r.window}. Account averages: CPL ${money(r.accountAvg.cpl)}, CTR ${r.accountAvg.ctr}%, ROAS ${r.accountAvg.roas}x.`),
      r.insights.length ? r.insights.map((i) => h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, i.campaign), pill(i.severity === 'good' ? 'positive' : i.severity === 'high' ? 'urgent' : 'medium')),
        h('p', { style: 'margin:0 0 4px' }, h('b', {}, i.title)), h('p', { class: 'muted', style: 'margin:0' }, i.detail),
        i.apply && can('ads', 'u') && h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn sm', onclick: guard(async () => { if (!confirm(i.apply.label + '?')) return; await api(i.apply.path.replace(/^\/ads/, '/ads'), { method: i.apply.method, body: i.apply.body }); toast('Done'); load(); }) }, i.apply.label))))
        : h('div', { class: 'card empty' }, icon('inbox'), h('div', {}, 'All good — nothing needs action right now.')));
  });
  load();
} };

// AI suggestions (from the ai_ad_review workflow step or "Review now"); nothing changes on the ad network until approved.
MODULES.adai = { title: 'AI Suggestions', render: async (root) => {
  const approver = ['super_admin', 'admin', 'manager'].includes(S.user.role);
  const st = { status: 'pending' };
  const holder = h('div', {});
  const tabs = h('select', { onchange: (e) => { st.status = e.target.value; load(); } }, [['pending', 'Waiting for approval'], ['applied', 'Applied'], ['rejected', 'Rejected'], ['failed', 'Failed'], ['', 'All']].map(([v, l]) => h('option', { value: v }, l)));
  const review = guard(async (btn) => {
    btn.disabled = true; btn.textContent = 'AI is reviewing…';
    try {
      const r = await api('/ads/ai/review', { method: 'POST', body: {} });
      const n = r.results.filter((x) => x.recommendation).length;
      toast(n ? `${n} new suggestion(s)` : 'AI reviewed every campaign: nothing to change right now');
      modal('AI review', h('div', {}, r.results.map((x) => h('div', { class: 'kcard' }, h('b', {}, x.campaign), ' ', x.skipped ? h('span', { class: 'muted' }, x.skipped) : pill(x.action === 'keep' ? 'keep' : x.label), x.reason && h('p', { class: 'muted', style: 'margin:4px 0 0' }, x.reason)))));
      load();
    } finally { btn.disabled = false; btn.textContent = '✨ Review all campaigns now'; }
  });
  root.append(h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'The AI reads each campaign\'s last 7 days against your account average and suggests pausing, resuming or changing the daily budget. Nothing changes on Google or Meta until a manager approves. Add the "AI: review ad campaigns after each sync" template under Automation to get suggestions automatically.'),
    h('div', { class: 'bar' }, tabs, h('div', { class: 'grow' }), can('ads', 'u') && h('button', { class: 'btn', onclick: (e) => review(e.currentTarget) }, '✨ Review all campaigns now')), holder);
  const decide = (r, path) => guard(async () => { const x = await api(`/ads/recommendations/${r._id}/${path}`, { method: 'POST' }); toast(x.status === 'failed' ? `Failed: ${x.error}` : x.status === 'applied' ? 'Applied on the ad network' : 'Rejected', x.status === 'failed'); load(); });
  const what = (r) => (r.action === 'budget' ? `Daily budget ${money(r.currentBudget)} → ${money(r.dailyBudget)}` : r.action === 'pause' ? 'Pause campaign' : 'Resume campaign');
  const load = guard(async () => {
    const { data } = await api('/ads/recommendations' + (st.status ? `?status=${st.status}` : ''));
    setKids(holder, data.length ? data.map((r) => h('div', { class: 'card' },
      h('div', { class: 'hd' }, h('h3', {}, r.campaign?.name || '(deleted campaign)'), pill(r.status)),
      h('p', { style: 'margin:0 0 4px' }, h('b', {}, what(r)), h('span', { class: 'muted' }, ` · confidence ${Math.round((r.confidence || 0) * 100)}% · ${r.engine === 'heuristic' ? 'rules' : r.engine} · ${fmtDate(r.createdAt)}`)),
      h('p', { class: 'muted', style: 'margin:0' }, r.reason),
      r.stats && h('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, `7 days: spend ${money(r.stats.spend)}, leads ${r.stats.leads ?? 0}, CPL ${money(r.stats.cpl)}, CTR ${r.stats.ctr ?? 0}%, ROAS ${r.stats.roas ?? 0}x · account CPL ${money(r.stats.accountCpl)}`),
      r.error && h('p', { style: 'margin:6px 0 0;color:var(--bad)' }, r.error),
      r.decidedBy && h('p', { class: 'muted', style: 'margin:6px 0 0' }, `${r.status} by ${r.decidedBy.name} · ${fmtDate(r.decidedAt)}`),
      r.status === 'pending' && (approver
        ? h('div', { style: 'margin-top:12px;display:flex;gap:8px' }, h('button', { class: 'btn sm', onclick: decide(r, 'approve') }, '✓ Approve & apply'), h('button', { class: 'btn sm sec', onclick: decide(r, 'reject') }, 'Reject'))
        : h('p', { class: 'muted', style: 'margin:8px 0 0' }, 'Waiting for a manager to approve.'))))
      : h('div', { class: 'card empty' }, icon('inbox'), h('div', {}, st.status === 'pending' ? 'No suggestions waiting. Press "Review all campaigns now" or let the automation do it after each sync.' : 'Nothing here yet.')));
  });
  load();
} };

MODULES.adutm = { title: 'UTM & Form Setup', render: async (root) => {
  const camps = (await api('/ads/campaigns?limit=100')).data;
  const sel = h('select', {}, camps.map((c) => h('option', { value: c._id }, c.name)));
  const url = h('input', { placeholder: 'https://yoursite.com/landing-page' });
  const content = h('input', { placeholder: 'optional: creative name, e.g. video-a' });
  const out = h('pre', {}, 'Choose a campaign, enter your landing page and press Generate.');
  const co = isAdmin() ? await api('/company') : null;
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Tracking link builder'), h('label', {}, 'Campaign'), sel, h('label', {}, 'Landing page URL'), url, h('label', {}, 'Creative / content tag'), content,
    h('div', { class: 'acts', style: 'justify-content:flex-start' }, h('button', { class: 'btn', onclick: guard(async () => { const x = await api(`/ads/campaigns/${sel.value}/utm?url=${encodeURIComponent(url.value)}&content=${encodeURIComponent(content.value)}`); out.textContent = x.url; }) }, 'Generate'),
      h('button', { class: 'btn sec', onclick: () => navigator.clipboard?.writeText(out.textContent).then(() => toast('Copied')) }, 'Copy')), h('div', { style: 'height:12px' }), out),
  h('div', { class: 'card' }, h('h3', {}, 'Connect your landing-page form'), h('p', { class: 'muted' }, 'Post the form fields plus the utm_* values from the page URL to this endpoint. The lead is created, scored, and attributed to the campaign.'),
    h('pre', {}, `POST ${location.origin}/api/webhooks/form/${co ? co.apiKey : '<your-company-api-key>'}\nContent-Type: application/json\n\n{ "name": "Asha Rao", "email": "asha@example.com", "phone": "+919800000000",\n  "utm_campaign": "<tracking code from the campaign>", "utm_source": "google", "utm_medium": "cpc" }`),
    !co && h('p', { class: 'muted' }, 'Ask an admin for the company API key (Company Settings).')));
} };

// ================= HR, Attendance & Payroll =================
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const money2 = (n) => '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thisMonth = () => new Date().toISOString().slice(0, 7);
const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid'];

function payslipModal(s) {
  const row = (l, v, cls) => h('tr', { class: cls }, h('td', {}, l), h('td', { style: 'text-align:right' }, v));
  const adj = (s.adjustments || []);
  const node = h('div', { class: 'payslip' },
    h('div', { class: 'ps-head' }, h('div', {}, h('h3', {}, s.company || 'Payslip'), h('div', { class: 'muted' }, 'Payslip for ' + monthLabel(s.month))), h('div', { style: 'text-align:right' }, h('b', {}, s.snapshot.name), h('div', { class: 'muted' }, `${s.snapshot.employeeCode} · ${s.snapshot.designation || s.snapshot.department || ''}`))),
    h('p', { class: 'muted', style: 'margin:10px 0' }, `Working days ${s.workingDays} · Paid days ${s.paidDays} · Present ${s.presentDays} · Half days ${s.halfDays} · Paid leave ${s.paidLeaveDays} · Unpaid leave ${s.unpaidLeaveDays} · Absent ${s.absentDays} · Late marks ${s.lateMarks}`),
    h('div', { class: 'two', style: 'gap:12px' },
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Earnings'), h('th', { style: 'text-align:right' }, 'Amount'))), h('tbody', {},
        row('Gross salary', money2(s.gross)), row('Loss of pay', '− ' + money2(s.lossOfPay)), row('Earned salary', money2(s.earned), 'tot'), ...adj.filter((a) => a.amount > 0).map((a) => row(a.label, money2(a.amount))))),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Deductions'), h('th', { style: 'text-align:right' }, 'Amount'))), h('tbody', {},
        row('Provident fund', money2(s.pf)), row('Tax', money2(s.tax)), row('Other deductions', money2(s.otherDeductions)), ...adj.filter((a) => a.amount < 0).map((a) => row(a.label, money2(-a.amount)))))),
    h('div', { class: 'ps-net' }, h('span', {}, 'Net pay'), h('b', {}, money2(s.netPay))));
  modal('Payslip', node, [{ label: 'Print', keep: true, run: () => window.print() }], true);
}

// ---------- HR dashboard ----------
MODULES.hrdash = { title: 'HR Dashboard', render: async (root) => {
  const o = await api('/hr/overview');
  const stat = (v, l, ic, c, sub) => h('div', { class: 'stat', style: `--c:${c}` }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('b', {}, v), h('span', {}, l), sub && h('div', {}, h('em', { style: 'color:var(--mute)' }, sub))));
  const a = o.attendance;
  const maxDept = Math.max(...o.departments.map((d) => d.count), 1);
  setKids(root,
    h('div', { class: 'grid' },
      stat(o.headcount, 'Active employees', 'hremp', '#5b5bf0'),
      stat(a.present + a.halfDay, 'In today', 'hrattend', '#12a150', `${a.present} full · ${a.halfDay} half`),
      stat(a.onLeave, 'On leave today', 'hrleave', '#0a8bd6'),
      stat(a.late, 'Late arrivals', 'hrattend', '#f08a05'),
      stat(o.workingDay ? a.notMarked : '—', o.workingDay ? 'Not marked yet' : 'Non-working day', 'hrattend', '#e5484d'),
      stat(o.pendingLeaves, 'Leave requests pending', 'hrleave', '#8b5cf6')),
    h('div', { class: 'two' },
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Attendance — last 14 days')),
        h('div', { class: 'bars' }, o.trend.map((d) => h('div', { class: 'b', title: `${d.date}: ${d.present} in, ${d.leave} on leave` }, h('em', {}, d.working ? d.present : '–'), h('i', { style: `height:${d.working ? Math.max(3, (d.present / Math.max(o.headcount, 1)) * 100) : 3}%;${d.working ? '' : 'opacity:.25'}` }), h('small', {}, d.date.slice(8)))))),
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Headcount by department')),
        o.departments.length ? o.departments.map((d) => h('div', { class: 'hbar' }, h('label', {}, d.department), h('div', { class: 'tr' }, h('i', { style: `width:${(d.count / maxDept) * 100}%` })), h('span', { style: 'width:30px' }, d.count))) : h('p', { class: 'muted' }, 'No employees yet.'))),
    h('div', { class: 'two' },
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Payroll')),
        o.lastPayroll ? h('div', {}, h('p', { style: 'margin:0 0 6px' }, h('b', {}, monthLabel(o.lastPayroll.month)), ' ', pill(o.lastPayroll.status)),
          h('div', { class: 'muted' }, `${o.lastPayroll.totals.employees} employees · Gross ${money(o.lastPayroll.totals.gross)} · Net pay ${money(o.lastPayroll.totals.netPay)}`)) : h('p', { class: 'muted' }, 'No payroll run yet.'),
        h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn sm', href: '#/hrpayroll' }, 'Open payroll'))),
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Coming up')),
        o.upcomingHolidays.map((x) => h('p', { style: 'margin:6px 0' }, '🎉 ', h('b', {}, x.name), h('span', { class: 'muted' }, ' — ' + ymd(x.date)))),
        o.birthdays.map((x) => h('p', { style: 'margin:6px 0' }, '🎂 ', h('b', {}, x.name), h('span', { class: 'muted' }, ` — birthday on the ${x.day}th`))),
        o.newJoiners.map((x) => h('p', { style: 'margin:6px 0' }, '👋 ', h('b', {}, x.name), h('span', { class: 'muted' }, ` joined ${ymd(x.joinDate)}`))),
        !o.upcomingHolidays.length && !o.birthdays.length && !o.newJoiners.length ? h('p', { class: 'muted' }, 'Nothing scheduled.') : null)));
} };

// ---------- Employees ----------
MODULES.hremp = { title: 'Employees', render: listModule({
  res: 'hr', path: '/hr/employees', title: 'Employee', filterField: 'status', filterOpts: ['active', 'inactive', 'terminated'],
  cols: [{ k: 'name', who: true }, { k: 'employeeCode', label: 'Code' }, { k: 'department' }, { k: 'designation' }, { k: 'joinDate', label: 'Joined', date: true }, { k: 'salary.basic', label: 'Basic', money: true }, { k: 'status', pill: true }],
  fields: [{ k: 'name', req: true }, { k: 'email', label: 'Email (links their login to My Space)' }, { k: 'phone' }, { k: 'department' }, { k: 'designation' }, { k: 'branch' },
    { k: 'joinDate', type: 'date', req: true, label: 'Joining date' }, { k: 'birthday', type: 'date' }, { k: 'status', type: 'select', opts: ['active', 'inactive', 'terminated'], editOnly: true }, { k: 'exitDate', type: 'date', editOnly: true },
    { k: 'salary.basic', type: 'number', label: 'Basic (monthly)' }, { k: 'salary.hra', type: 'number', label: 'HRA (monthly)' }, { k: 'salary.allowances', type: 'number', label: 'Other allowances (monthly)' }, { k: 'salary.otherDeductions', type: 'number', label: 'Fixed deductions (monthly)' },
    { k: 'bank.holder', label: 'Bank account holder' }, { k: 'bank.bankName', label: 'Bank name' }, { k: 'bank.account', label: 'Account number' }, { k: 'bank.ifsc', label: 'IFSC' }],
  actions: [{ label: 'Month view', run: async (r) => {
    const m = await api(`/hr/employees/${r._id}/summary?month=${thisMonth()}`);
    const p = m.preview, b = m.balances;
    modal(`${r.name} — ${monthLabel(m.month)}`, h('div', {},
      h('p', { class: 'muted' }, `Working days ${p.workingDays} · present ${p.presentDays} · half ${p.halfDays} · leave ${p.paidLeaveDays + p.unpaidLeaveDays} · absent ${p.absentDays} · late ${p.lateMarks}`),
      h('div', { class: 'grid' }, ['casual', 'sick', 'earned'].map((t) => h('div', { class: 'stat' }, h('div', {}, h('b', {}, `${b[t].available}/${b[t].quota}`), h('span', {}, t + ' leave left'))))),
      h('p', {}, 'Estimated pay so far this month (if run today): ', h('b', {}, money2(p.netPay))),
      m.payslips.length ? table(m.payslips.map((s) => ({ month: s.month, gross: money(s.gross), 'net pay': money(s.netPay) }))) : null), [], true); } }],
}) };

// ---------- Attendance ----------
const STATUS_LABEL = { present: 'Present', half_day: 'Half day', leave: 'Leave', absent: 'Absent', not_marked: 'Not marked', holiday: 'Holiday', weekoff: 'Weekly off' };
function statusPill(s) { return h('span', { class: 'pill st-' + s }, STATUS_LABEL[s] || s); }

MODULES.hrattend = { title: 'Attendance', render: async (root) => {
  let tab = 'daily';
  const holder = h('div', {});
  const seg = h('div', { class: 'seg' }, [['daily', 'Daily roster'], ['monthly', 'Monthly sheet']].map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: (e) => { tab = k; seg.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); draw(); } }, l)));
  root.append(h('div', { class: 'bar' }, seg), holder);
  const date = h('input', { type: 'date', value: ymd(Date.now()) });
  const month = h('input', { type: 'month', value: thisMonth() });

  const mark = guard(async (employee, status, extra = {}) => { await api('/hr/attendance/mark', { method: 'POST', body: { employee, date: date.value, status, ...extra } }); drawDaily(); });

  async function drawDaily() {
    const r = await api('/hr/attendance/roster?date=' + date.value);
    const s = r.summary;
    setKids(holder,
      h('div', { class: 'bar' }, date, h('button', { class: 'btn sec', onclick: drawDaily }, 'Load'), h('div', { class: 'grow' }),
        r.dayType === 'working' && can('hr', 'c') && s.not_marked ? h('button', { class: 'btn', onclick: guard(async () => { const ids = r.rows.filter((x) => x.status === 'not_marked').map((x) => x.employee.id); if (!confirm(`Mark ${ids.length} unmarked employee(s) present?`)) return; await api('/hr/attendance/bulk', { method: 'POST', body: { date: date.value, status: 'present', employees: ids } }); drawDaily(); }) }, 'Mark all unmarked present') : null),
      r.dayType !== 'working' ? h('p', { class: 'muted' }, r.dayType === 'holiday' ? `Holiday: ${r.holidayName}` : 'Weekly off') : null,
      h('div', { class: 'grid' }, [['Present', s.present, '#12a150'], ['Half day', s.half_day, '#f08a05'], ['On leave', s.leave, '#0a8bd6'], ['Absent', s.absent, '#e5484d'], ['Not marked', s.not_marked, '#6f7a93'], ['Late', s.late, '#8b5cf6']]
        .map(([l, v, c]) => h('div', { class: 'stat', style: `--c:${c}` }, h('div', {}, h('b', {}, v), h('span', {}, l))))),
      h('div', { class: 'card flush' }, h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['Employee', 'Department', 'Status', 'In', 'Out', 'Hours', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.rows.map((x) => h('tr', {}, h('td', {}, h('div', { class: 'who' }, avatar(x.employee.name), h('div', {}, h('b', {}, x.employee.name), h('small', {}, x.employee.code)))), h('td', {}, x.employee.department || ''),
          h('td', {}, statusPill(x.status), x.late ? h('span', { class: 'pill', style: '--c:var(--warn);margin-left:6px' }, 'late') : null, x.leaveType ? h('span', { class: 'muted' }, ' ' + x.leaveType) : null),
          h('td', {}, fmtTime(x.checkIn)), h('td', {}, fmtTime(x.checkOut)), h('td', {}, x.hours || '—'),
          h('td', { class: 'acts-cell' }, can('hr', 'c') && [
            h('button', { class: 'btn sm sec', onclick: () => mark(x.employee.id, 'present') }, 'P'), h('button', { class: 'btn sm sec', onclick: () => mark(x.employee.id, 'half_day') }, '½'),
            h('button', { class: 'btn sm sec', onclick: () => mark(x.employee.id, 'absent') }, 'A'), h('button', { class: 'btn sm sec', onclick: () => mark(x.employee.id, 'leave', { leaveType: 'casual' }) }, 'L'),
            h('button', { class: 'btn sm sec', onclick: () => { const f = form([{ k: 'checkIn', type: 'datetime', label: 'Check-in', req: true }, { k: 'checkOut', type: 'datetime', label: 'Check-out' }, { k: 'note' }], { checkIn: x.checkIn || `${date.value}T09:30:00` , checkOut: x.checkOut });
              modal(`Set times — ${x.employee.name}`, f, [{ label: 'Save', run: async () => { await api('/hr/attendance/mark', { method: 'POST', body: { employee: x.employee.id, date: date.value, ...f.values() } }); drawDaily(); } }]); } }, 'Times')]))))))),
      h('p', { class: 'muted' }, 'P = present, ½ = half day, A = absent, L = casual leave. Employees punch in/out themselves from My Space; use these buttons to correct or fill in.'));
  }

  async function drawMonthly() {
    const r = await api('/hr/attendance/monthly?month=' + month.value);
    const head = h('tr', {}, h('th', {}, 'Employee'), ...Array.from({ length: r.days }, (_, i) => h('th', { style: 'text-align:center;padding:8px 4px' }, i + 1)), ...['P', 'H', 'L', 'A', 'Late'].map((x) => h('th', { style: 'text-align:center' }, x)));
    setKids(holder,
      h('div', { class: 'bar' }, month, h('button', { class: 'btn sec', onclick: drawMonthly }, 'Load'), h('div', { class: 'grow' }), h('span', { class: 'muted' }, Object.entries(r.legend).map(([k, v]) => `${k} = ${v}`).join(' · '))),
      h('div', { class: 'card flush' }, h('div', { class: 'tw' }, h('table', { class: 'sheet' }, h('thead', {}, head),
        h('tbody', {}, r.grid.map((g) => h('tr', {}, h('td', { style: 'white-space:nowrap' }, h('b', {}, g.employee.name), h('small', { class: 'muted', style: 'display:block' }, g.employee.code)),
          ...g.cells.map((c) => h('td', { class: 'sc sc-' + (c || 'x') }, c)), h('td', { class: 'sc' }, g.present), h('td', { class: 'sc' }, g.half), h('td', { class: 'sc' }, g.leave), h('td', { class: 'sc' }, g.absent), h('td', { class: 'sc' }, g.late))))))));
  }
  const draw = guard(() => (tab === 'daily' ? drawDaily() : drawMonthly()));
  draw();
} };

// ---------- Leave ----------
MODULES.hrleave = { title: 'Leave Requests', render: listModule({
  res: 'hr', path: '/hr/leaves', title: 'Leave', search: false, noDelete: true, filterField: 'status', filterOpts: ['pending', 'approved', 'rejected', 'cancelled'],
  cols: [{ k: 'employee.name', label: 'Employee' }, { k: 'type', pill: true }, { k: 'from', date: true }, { k: 'to', date: true }, { k: 'days' }, { k: 'reason' }, { k: 'status', pill: true }, { k: 'decisionNote', label: 'Note' }],
  barExtra: [{ label: 'Add leave for an employee', show: () => can('hr', 'c'), run: (reload) => {
    const f = form([{ k: 'employee', type: 'ref', src: '/hr/employees', label: 'Employee', req: true }, { k: 'type', type: 'select', opts: LEAVE_TYPES, req: true }, { k: 'from', type: 'date', req: true }, { k: 'to', type: 'date', req: true }, { k: 'halfDay', type: 'checkbox', label: 'Half day' }, { k: 'reason' }]);
    modal('New leave request', f, [{ label: 'Create', run: async () => { await api('/hr/leaves', { method: 'POST', body: f.values() }); toast('Request created'); reload(); } }]); } }],
  actions: [
    { label: 'Approve', perm: ['hr', 'u'], show: (r) => r.status === 'pending', run: async (r, reload) => { await api(`/hr/leaves/${r._id}/approve`, { method: 'POST', body: {} }); toast('Approved — attendance updated'); reload(); } },
    { label: 'Reject', perm: ['hr', 'u'], show: (r) => r.status === 'pending', run: async (r, reload) => { const note = prompt('Reason (optional)'); if (note === null) return; await api(`/hr/leaves/${r._id}/reject`, { method: 'POST', body: { note } }); reload(); } },
    { label: 'Cancel', perm: ['hr', 'u'], show: (r) => ['pending', 'approved'].includes(r.status), run: async (r, reload) => { if (!confirm('Cancel this leave?')) return; await api(`/hr/leaves/${r._id}/cancel`, { method: 'POST' }); reload(); } },
  ],
}) };

MODULES.hrholidays = { title: 'Holidays', render: listModule({
  res: 'hr', path: '/hr/holidays', title: 'Holiday', search: false,
  cols: [{ k: 'date', date: true, label: 'Date' }, { k: 'name' }],
  fields: [{ k: 'name', req: true }, { k: 'date', type: 'date', req: true }],
}) };

// ---------- Payroll ----------
MODULES.hrpayroll = { title: 'Payroll', render: async (root) => {
  const holder = h('div', {});
  const month = h('input', { type: 'month', value: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7) });
  root.append(h('div', { class: 'bar' }, h('label', { style: 'margin:0' }, 'Month'), month,
    can('hr', 'c') && h('button', { class: 'btn', onclick: guard(async () => { await api('/hr/payroll/run', { method: 'POST', body: { month: month.value } }); toast('Payroll calculated (draft)'); load(); }) }, icon('plus'), 'Run payroll'),
    h('span', { class: 'muted' }, 'Calculated from attendance and approved leave. A draft can be re-run until you finalize it.')), holder);

  async function openRun(id) {
    const d = await api('/hr/payroll/runs/' + id);
    const draft = d.run.status === 'draft';
    const body = h('div', {}, h('p', { class: 'muted', style: 'margin:0 0 8px' }, `${d.run.totals.employees} employees · Gross ${money(d.run.totals.gross)} · Loss of pay ${money(d.run.totals.lossOfPay)} · Net payable ${money(d.run.totals.netPay)}`),
      h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['Employee', 'Paid / working days', 'Gross', 'Loss of pay', 'PF', 'Net pay', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, d.payslips.map((s) => h('tr', {}, h('td', {}, h('b', {}, s.snapshot.name), h('small', { class: 'muted', style: 'display:block' }, s.snapshot.employeeCode)), h('td', {}, `${s.paidDays} / ${s.workingDays}`), h('td', {}, money(s.gross)), h('td', {}, money(s.lossOfPay)), h('td', {}, money(s.pf)), h('td', {}, h('b', {}, money(s.netPay))),
          h('td', { class: 'acts-cell' }, h('button', { class: 'btn sm sec', onclick: () => payslipModal(s) }, 'Payslip'),
            draft && can('hr', 'u') && h('button', { class: 'btn sm sec', onclick: () => { const f = form([{ k: 'label', label: 'Adjustment (e.g. Bonus, Advance recovery)', req: true }, { k: 'amount', type: 'number', label: 'Amount (+ adds, − deducts)', req: true }]);
              modal(`Adjust — ${s.snapshot.name}`, h('div', {}, s.adjustments.length ? h('p', { class: 'muted' }, 'Existing: ' + s.adjustments.map((a) => `${a.label} ${a.amount}`).join(', ')) : null, f), [
                { label: 'Add', run: async () => { await api('/hr/payroll/payslips/' + s._id, { method: 'PATCH', body: { adjustments: [...s.adjustments.map(({ label, amount }) => ({ label, amount })), f.values()] } }); toast('Updated'); openRun(id); load(); } },
                s.adjustments.length && { label: 'Clear all', cls: 'sec', run: async () => { await api('/hr/payroll/payslips/' + s._id, { method: 'PATCH', body: { adjustments: [] } }); openRun(id); load(); } }].filter(Boolean)); } }, 'Adjust'))))))));
    const btns = [
      draft && can('hr', 'u') && { label: 'Finalize & publish payslips', run: async () => { if (!confirm('Finalize? Payslips become visible to employees and the run can no longer be changed.')) return false; await api(`/hr/payroll/runs/${id}/finalize`, { method: 'POST' }); toast('Finalized'); load(); } },
      d.run.status === 'finalized' && can('hr', 'u') && { label: 'Mark as paid', run: async () => { await api(`/hr/payroll/runs/${id}/paid`, { method: 'POST' }); toast('Marked paid'); load(); } },
      { label: 'Download bank sheet (CSV)', cls: 'sec', keep: true, run: async () => { const r = await raw(`/hr/payroll/runs/${id}/export`); h('a', { href: URL.createObjectURL(await r.blob()), download: `payroll-${d.run.month}.csv` }).click(); } },
      draft && can('hr', 'd') && { label: 'Delete draft', cls: 'bad', run: async () => { if (!confirm('Delete this draft?')) return false; await api('/hr/payroll/runs/' + id, { method: 'DELETE' }); load(); } },
    ].filter(Boolean);
    modal(`Payroll — ${monthLabel(d.run.month)}  (${d.run.status})`, body, btns, true);
  }

  const load = guard(async () => {
    const runs = await api('/hr/payroll/runs');
    setKids(holder, h('div', { class: 'card flush' }, runs.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['Month', 'Status', 'Employees', 'Gross', 'Loss of pay', 'Net payable', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, h('b', {}, monthLabel(r.month))), h('td', {}, pill(r.status)), h('td', {}, r.totals.employees), h('td', {}, money(r.totals.gross)), h('td', {}, money(r.totals.lossOfPay)), h('td', {}, h('b', {}, money(r.totals.netPay))),
        h('td', { class: 'acts-cell' }, h('button', { class: 'btn sm', onclick: guard(() => openRun(r._id)) }, 'Open'))))))) : h('div', { class: 'empty' }, icon('inbox'), h('div', {}, 'No payroll runs yet. Pick a month and press Run payroll.'))));
  });
  load();
} };

// ---------- Settings ----------
MODULES.hrsettings = { title: 'HR Settings', render: async (root) => {
  const s = await api('/hr/settings');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const f = form([
    { k: 'shiftStart', label: 'Shift start (HH:MM)' }, { k: 'graceMinutes', type: 'number', label: 'Grace period (minutes before "late")' }, { k: 'fullDayHours', type: 'number', label: 'Hours in a full day' },
    { k: 'tzOffsetMinutes', type: 'number', label: 'Timezone offset from UTC, minutes (India = 330)' },
    { k: 'quotas.casual', type: 'number', label: 'Casual leave per year' }, { k: 'quotas.sick', type: 'number', label: 'Sick leave per year' }, { k: 'quotas.earned', type: 'number', label: 'Earned leave per year' },
    { k: 'pfRate', type: 'number', label: 'Provident fund % of basic' }, { k: 'taxRate', type: 'number', label: 'Tax (TDS) % of earned salary' },
  ], s);
  const off = DAYS.map((d, i) => h('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin:0 14px 0 0;font-size:13px;color:var(--ink)' }, h('input', { type: 'checkbox', style: 'width:auto', checked: s.weekOff.includes(i), 'data-d': i }), d));
  root.append(h('div', { class: 'card', style: 'max-width:640px' }, f, h('label', {}, 'Weekly off days'), h('div', {}, off),
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: guard(async () => { const body = f.values(); body.weekOff = off.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => +i.dataset.d); await api('/hr/settings', { method: 'PATCH', body }); toast('Settings saved'); }) }, 'Save settings'))),
  h('p', { class: 'muted' }, 'These rules drive late marks, half days, leave balances and payroll. Changing them affects future calculations; finalized payslips never change.'));
} };

// ---------- My Space (every role) ----------
MODULES.myspace = { title: 'My Space', render: async (root) => {
  let me;
  try { me = await api('/me/profile'); } catch (e) { root.append(h('div', { class: 'card empty' }, icon('inbox'), h('div', {}, e.message))); return; }
  const clock = h('div', { class: 'clock' }); const status = h('div', { class: 'muted' }); const btns = h('div', { class: 'acts', style: 'justify-content:flex-start;margin-top:14px' });
  const calHolder = h('div', {}); const side = h('div', {});
  let month = thisMonth();

  const tick = setInterval(() => { if (!document.body.contains(clock)) return clearInterval(tick); clock.textContent = new Date().toLocaleTimeString(); }, 1000);
  clock.textContent = new Date().toLocaleTimeString();

  async function drawToday() {
    const t = await api('/me/today'); const a = t.attendance;
    status.textContent = '';
    setKids(status, t.dayType !== 'working' ? h('div', {}, `Today is a ${t.dayType === 'holiday' ? 'holiday: ' + t.holidayName : 'weekly off'}.`) : null,
      a?.checkIn ? h('div', {}, `Punched in at ${fmtTime(a.checkIn)}`, a.late ? h('span', { class: 'pill', style: '--c:var(--warn);margin-left:8px' }, 'late') : null, a.checkOut ? ` · out at ${fmtTime(a.checkOut)} · ${a.hoursWorked}h · ${STATUS_LABEL[a.status]}` : ' · still working') : h('div', {}, `Not punched in yet. Shift starts ${t.shiftStart}.`),
      a?.status === 'leave' ? h('div', {}, 'You are on approved leave today.') : null);
    const canIn = !a?.checkIn && a?.status !== 'leave', canOut = a?.checkIn && !a?.checkOut;
    setKids(btns, h('button', { class: 'btn', disabled: !canIn, onclick: guard(async () => { await api('/me/punch-in', { method: 'POST' }); toast('Punched in'); drawToday(); drawMonth(); }) }, icon('hrattend'), 'Punch in'),
      h('button', { class: 'btn sec', disabled: !canOut, onclick: guard(async () => { const r = await api('/me/punch-out', { method: 'POST' }); toast(`Punched out — ${r.hoursWorked}h (${STATUS_LABEL[r.status]})`); drawToday(); drawMonth(); }) }, 'Punch out'));
  }

  async function drawMonth() {
    const m = await api('/me/attendance?month=' + month);
    const by = new Map(m.attendance.map((x) => [ymd(x.date), x])); const hol = new Map(m.holidays.map((x) => [ymd(x.date), x.name]));
    const first = new Date(month + '-01T00:00:00Z'); const days = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    const cells = Array.from({ length: first.getUTCDay() }, () => h('div', { class: 'cd empty' }));
    for (let d = 1; d <= days; d++) {
      const key = `${month}-${String(d).padStart(2, '0')}`; const dt = new Date(key + 'T00:00:00Z'); const a = by.get(key);
      const st = a ? a.status : hol.has(key) ? 'holiday' : m.weekOff.includes(dt.getUTCDay()) ? 'weekoff' : key < ymd(Date.now()) ? 'absent' : '';
      cells.push(h('div', { class: 'cd st-' + st, title: a ? `${STATUS_LABEL[a.status]} ${fmtTime(a.checkIn)}–${fmtTime(a.checkOut)} ${a.hoursWorked || ''}h` : hol.get(key) || '' }, h('b', {}, d), h('small', {}, a ? (a.status === 'leave' ? 'Leave' : a.checkIn ? fmtTime(a.checkIn) : STATUS_LABEL[a.status]) : hol.get(key) ? '🎉' : '')));
    }
    const s = m.summary;
    setKids(calHolder, h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, monthLabel(month)), h('div', {}, h('button', { class: 'btn sm sec', onclick: () => { const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); month = ymd(d).slice(0, 7); drawMonth(); } }, '‹'), h('button', { class: 'btn sm sec', onclick: () => { const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); month = ymd(d).slice(0, 7); drawMonth(); } }, '›'))),
      h('div', { class: 'cal' }, ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('div', { class: 'ch' }, x)), ...cells),
      h('p', { class: 'muted', style: 'margin:12px 0 0' }, `Working days ${s.workingDays} · Present ${s.present} · Half days ${s.halfDays} · Leave ${s.paidLeave + s.unpaidLeave} · Absent ${s.absent} · Late ${s.late} · ${s.hours}h logged`)));
  }

  async function drawSide() {
    const [bal, leaves, slips, hols] = await Promise.all([api('/me/balances'), api('/me/leaves'), api('/me/payslips'), api('/me/holidays')]);
    setKids(side,
      h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Leave balance'), h('button', { class: 'btn sm', onclick: () => applyModal() }, icon('plus'), 'Apply')),
        h('div', { class: 'grid', style: 'margin:0' }, ['casual', 'sick', 'earned'].map((t) => h('div', { class: 'stat' }, h('div', {}, h('b', {}, bal[t].available), h('span', {}, `${t} of ${bal[t].quota}`), bal[t].pending ? h('div', {}, h('em', { style: 'color:var(--warn)' }, `${bal[t].pending} pending`)) : null))))),
      h('div', { class: 'card flush' }, h('div', { class: 'hd', style: 'padding:16px 18px 0' }, h('h3', {}, 'My leave requests')),
        leaves.length ? h('div', { class: 'tw' }, h('table', {}, h('tbody', {}, leaves.slice(0, 8).map((l) => h('tr', {}, h('td', {}, pill(l.type)), h('td', {}, `${ymd(l.from)} → ${ymd(l.to)}`), h('td', {}, l.days + 'd'), h('td', {}, pill(l.status)),
          h('td', { class: 'acts-cell' }, ['pending', 'approved'].includes(l.status) && h('button', { class: 'btn sm sec', onclick: guard(async () => { if (!confirm('Cancel this leave?')) return; await api(`/me/leaves/${l._id}/cancel`, { method: 'POST' }); toast('Cancelled'); drawSide(); drawMonth(); }) }, 'Cancel'))))))) : h('div', { class: 'empty' }, 'No leave requests yet.')),
      h('div', { class: 'card flush' }, h('div', { class: 'hd', style: 'padding:16px 18px 0' }, h('h3', {}, 'My payslips')),
        slips.length ? h('div', { class: 'tw' }, h('table', {}, h('tbody', {}, slips.map((s) => h('tr', {}, h('td', {}, h('b', {}, monthLabel(s.month))), h('td', {}, money(s.netPay)), h('td', {}, pill(s.runStatus)),
          h('td', { class: 'acts-cell' }, h('button', { class: 'btn sm sec', onclick: guard(async () => payslipModal(await api('/me/payslips/' + s._id))) }, 'View'))))))) : h('div', { class: 'empty' }, 'No payslips published yet.')),
      hols.length ? h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', {}, 'Upcoming holidays')), hols.map((x) => h('p', { style: 'margin:6px 0' }, '🎉 ', h('b', {}, x.name), h('span', { class: 'muted' }, ' — ' + ymd(x.date))))) : null);
  }

  function applyModal() {
    const f = form([{ k: 'type', type: 'select', opts: LEAVE_TYPES, req: true }, { k: 'from', type: 'date', req: true }, { k: 'to', type: 'date', req: true }, { k: 'halfDay', type: 'checkbox', label: 'Half day (single date only)' }, { k: 'reason', type: 'textarea' }]);
    modal('Apply for leave', f, [{ label: 'Submit', run: async () => { await api('/me/leaves', { method: 'POST', body: f.values() }); toast('Leave request sent to HR'); drawSide(); } }]);
  }

  root.append(h('div', { class: 'hero' }, h('div', {}, h('h3', {}, me.employee.name), h('p', {}, `${me.employee.designation || ''} ${me.employee.department ? '· ' + me.employee.department : ''} · ${me.employee.employeeCode}`)), h('div', { style: 'flex:1;min-width:240px;text-align:right' }, clock, status, btns)),
    h('div', { class: 'two' }, calHolder, side));
  drawToday(); drawMonth(); drawSide();
} };

// Menu per role panel (the API still enforces permissions on every call).
const ADS = ['adsdash', 'adcampaigns', 'adcreatives', 'admetrics', 'adaccounts', 'adattr', 'adinsights', 'adai', 'adutm'];
const HRP = ['hrdash', 'hremp', 'hrattend', 'hrleave', 'hrholidays', 'hrpayroll', 'hrsettings'];
// Communication Hub pages live in hub.js.
const HUB = ['commdash', 'inbox', 'bulksms', 'bulkwa', 'ivrcalls', 'ivrflows', 'calllogs', 'aibot', 'intentmap', 'providers', 'dnd'];
const ALL = ['dashboard', 'leads', 'customers', 'deals', 'tasks', 'communications', 'templates', 'campaigns', 'workflows', 'reports', 'ai', 'pipelines', 'users', 'audit', 'company', ...HUB, ...ADS, ...HRP, 'myspace', 'notifications'];
const MENU = {
  ads_manager: [...ADS, 'myspace', 'notifications'],
  hr_manager: [...HRP, 'myspace', 'notifications'],
  comm_manager: [...HUB, 'templates', 'leads', 'myspace', 'notifications'],
  telecaller: ['inbox', 'leads', 'customers', 'tasks', 'ai', 'myspace', 'notifications'],
  super_admin: ALL, admin: ALL,
  manager: ['dashboard', 'leads', 'customers', 'deals', 'tasks', 'communications', 'templates', 'campaigns', 'workflows', 'reports', 'ai', 'pipelines', 'users', 'audit', ...HUB, ...ADS, 'myspace', 'notifications'],
  sales: ['dashboard', 'inbox', 'leads', 'customers', 'deals', 'tasks', 'communications', 'reports', 'ai', 'myspace', 'notifications'],
  support: ['dashboard', 'inbox', 'customers', 'tasks', 'communications', 'calllogs', 'leads', 'ai', 'myspace', 'notifications'],
};
// Licensed modules a page needs (any one of them). Mirrors the module gates in src/app.js. Unlisted pages are always on.
const PAGE_NEEDS = {
  dashboard: ['crm'], leads: ['crm', 'hub', 'ads'], customers: ['crm', 'hub'], tasks: ['crm', 'hub'], communications: ['crm', 'hub'], templates: ['crm', 'hub'],
  deals: ['crm'], campaigns: ['crm'], workflows: ['crm'], pipelines: ['crm'], reports: ['reports'], ai: ['ai'], myspace: ['hr'],
  ...Object.fromEntries(HUB.map((p) => [p, ['hub']])), ...Object.fromEntries(ADS.map((p) => [p, ['ads']])), ...Object.fromEntries(HRP.map((p) => [p, ['hr']])),
};
const licensed = (page) => { const mods = S.user?.workspace?.modules; return !mods || !PAGE_NEEDS[page] || PAGE_NEEDS[page].some((m) => mods.includes(m)); };
const brandName = () => S.user?.workspace?.branding?.appName || 'Smart CRM';
function applyBranding(color) {
  if (/^#[0-9a-f]{6}$/i.test(color || '')) document.documentElement.style.setProperty('--brand', color);
  else document.documentElement.style.removeProperty('--brand');
}
const GROUPS = [['Overview', ['dashboard']], ['Sales', ['leads', 'customers', 'deals', 'tasks']], ['Engage', ['communications', 'templates', 'campaigns', 'workflows']], ['Insights', ['reports', 'ai']], ['Communication Hub', HUB], ['Advertising', ADS], ['People & Payroll', HRP], ['Me', ['myspace']], ['Admin', ['pipelines', 'users', 'audit', 'company']], ['', ['notifications']]];
const SUBS = {
  dashboard: 'Your business at a glance', leads: 'Capture, score and move prospects through the pipeline', customers: 'Profiles, purchases and relationship health',
  deals: 'Track opportunities and revenue', tasks: 'Follow-ups, reminders and to-dos', communications: 'Every call, email and message in one place',
  templates: 'Reusable messages with personalisation', campaigns: 'Blasts and multi-step drip sequences', workflows: 'Automate repetitive work with triggers and steps',
  reports: 'Performance, conversion and revenue', ai: 'Smart search, forecasts and churn risk', pipelines: 'Customise your sales stages', users: 'Manage your team and roles',
  audit: 'Who changed what, and when',
  hrdash: 'Headcount, attendance and payroll at a glance', hremp: 'Employee records, salary and bank details', hrattend: 'Daily roster and monthly attendance sheet',
  hrleave: 'Approve leave and keep balances right', hrholidays: 'Company holidays (not counted as working days)', hrpayroll: 'Run monthly payroll from attendance and publish payslips',
  hrsettings: 'Shift timings, leave quotas, PF and tax rules', myspace: 'Punch in/out, apply for leave and view your payslips',
  adsdash: 'Spend, leads and return across all ad platforms', adcampaigns: 'Plan, launch and control ad campaigns', adcreatives: 'Ad creatives and A/B test results',
  admetrics: 'Daily spend and results from your ad networks', adaccounts: 'Connected ad accounts and monthly budgets', adattr: 'Leads and revenue each campaign really produced',
  adinsights: 'Recommended actions based on recent results', adai: 'AI suggestions to pause, resume or rebudget campaigns: you approve',
  commdash: 'Bulk messaging, AI conversations and IVR calls at a glance', inbox: 'WhatsApp & SMS chats - the AI answers first, agents take over',
  bulksms: 'Send SMS to CRM segments or uploaded lists', bulkwa: 'WhatsApp broadcasts with templates and media', ivrcalls: 'Automated voice call campaigns driven by IVR flows',
  ivrflows: 'Design menus, AI voice agents, transfers and voicemail', calllogs: 'Every IVR call with transcript, intent and AI summary',
  aibot: 'What the AI assistant knows and when it hands over', intentmap: 'What happens in the CRM when the AI detects an intent',
  providers: 'Connect SMS, WhatsApp and voice gateways', dnd: 'Numbers that must never be messaged or called', adutm: 'Tracking links and landing-page form setup', company: 'Workspace settings and integrations', notifications: 'Alerts and assignments',
};

// ---------- auth screen & shell ----------
const DEMO = [['comm@demo.com', 'Comm Manager', 'Bulk SMS, WhatsApp & IVR'], ['agent@demo.com', 'Telecaller', 'AI inbox & own leads'], ['hr@demo.com', 'HR Manager', 'Attendance & payroll'], ['ads@demo.com', 'Ads Manager', 'Campaigns & spend'], ['admin@demo.com', 'Super Admin', 'Everything'], ['manager@demo.com', 'Manager', 'Team & reports'], ['sales1@demo.com', 'Sales', 'Own pipeline'], ['support@demo.com', 'Support', 'Customers & tasks']];
const BULLETS = [['zap', 'Automate follow-ups with a visual-style workflow engine'], ['ai', 'AI lead scoring, replies and next-best-action'], ['reports', 'Live pipeline, revenue and team analytics'], ['bulkwa', 'Bulk SMS, WhatsApp & IVR handled by an AI assistant'], ['users', 'Separate panels for admins, managers, sales and support']];

function loginScreen() {
  let mode = 'login';
  // A client's own domain or desktop install shows the client's name and hides sign-up and demo logins.
  let site = DESK.company ? { tenant: DESK.company, signup: false } : { tenant: null, signup: true };
  const inner = h('div', { class: 'inner' });
  const artBrand = h('span', {}, 'Smart CRM');
  const siteName = () => site.tenant && (site.tenant.branding?.appName || site.tenant.name);
  async function submit(body) {
    const r = await api('/auth/' + mode, { method: 'POST', body });
    saveSession(r); render();
  }
  const draw = () => {
    const open = site.signup && !site.tenant;
    if (!open) mode = 'login';
    artBrand.textContent = siteName() || 'Smart CRM';
    applyBranding(site.tenant?.branding?.color);
    const fields = mode === 'login'
      ? [{ k: 'email', req: true, label: 'Email' }, { k: 'password', type: 'password', req: true, label: 'Password' }]
      : [{ k: 'companyName', req: true, label: 'Company name' }, { k: 'name', req: true, label: 'Your name' }, { k: 'email', req: true, label: 'Email' }, { k: 'password', type: 'password', req: true, label: 'Password (min 8 characters)' }];
    const f = form(fields);
    const fm = h('form', { onsubmit: guard(async (e) => { e.preventDefault(); await submit(f.values()); }) }, f, h('button', { class: 'btn', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account'));
    setKids(inner, 
      h('h2', {}, mode === 'login' ? (siteName() ? `Sign in to ${siteName()}` : 'Welcome back') : 'Create your workspace'),
      h('p', { class: 'muted', style: 'margin:0 0 6px' }, mode === 'login' ? 'Sign in to your CRM panel' : 'You will be the Super Admin'),
      fm,
      open && h('div', { class: 'switch' }, mode === 'login' ? 'New company? ' : 'Already have an account? ', h('a', { onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } }, mode === 'login' ? 'Create account' : 'Sign in')),
      open && mode === 'login' && h('div', { class: 'demo' }, h('p', {}, 'Demo accounts (password Demo@1234) — click to sign in:'),
        h('div', { class: 'row' }, DEMO.map(([email, role, sub]) => h('button', { type: 'button', onclick: guard(() => submit({ email, password: 'Demo@1234' })) }, avatar(role, 'sm'), h('span', {}, h('b', {}, role), h('small', {}, sub)))))));
  };
  draw();
  if (!DESK.company) api('/tenant').then((t) => { site = t; draw(); }).catch(() => {});
  return h('div', { class: 'auth' },
    h('div', { class: 'art' }, h('div', { class: 'brand', style: 'position:relative;margin-bottom:28px' }, h('div', { class: 'logo' }, icon('zap')), artBrand),
      h('h1', {}, 'Sell smarter.', h('br'), 'Automate the rest.'), h('p', {}, 'Leads, customers, deals and campaigns — with automation and AI built in.'),
      h('ul', {}, BULLETS.map(([ic, t]) => h('li', {}, h('span', {}, icon(ic)), t)))),
    h('div', { class: 'box' }, inner));
}

function route() { return (location.hash.replace(/^#\//, '').split('?')[0]) || 'dashboard'; }

async function render() {
  const app = $('#app');
  if (!S.access || !S.user) { applyBranding(); setKids(app, loginScreen()); return; }
  // Pick up module/branding changes made by the platform owner since this session started.
  if (!S.meChecked) {
    S.meChecked = true;
    api('/auth/me').then((me) => {
      const before = JSON.stringify(S.user.workspace);
      S.user = { ...S.user, ...me };
      localStorage.setItem('crm_user', JSON.stringify(S.user));
      if (JSON.stringify(me.workspace) !== before) render();
    }).catch(() => {});
  }
  const ws = S.user.workspace || {};
  applyBranding(ws.branding?.color);
  document.title = ws.name ? `${ws.name} · ${brandName()}` : brandName();
  const menu = (MENU[S.user.role] || MENU.support).filter(licensed);
  let page = route();
  if (!menu.includes(page)) page = menu[0];
  const bell = h('a', { class: 'iconbtn', href: '#/notifications', title: 'Notifications' }, icon('notifications'));
  const badge = h('span', { class: 'badge', hidden: true });
  const main = h('div', { class: 'main' });
  main.append(
    h('div', { class: 'top' }, h('div', { class: 'ttl' }, h('h2', {}, MODULES[page].title), h('p', {}, SUBS[page] || '')), bell,
      h('button', { class: 'btn sec', onclick: guard(async () => {
        const waiting = await Offline.pendingCount();
        if (waiting && !confirm(`${waiting} change(s) made offline have not synced yet and will be lost. Sign out anyway?`)) return;
        await api('/auth/logout', { method: 'POST', body: { refreshToken: S.refresh }, noOffline: true }).catch(() => {});
        await Offline.clearUser(S.user.id);
        clearSession(); render();
      }) }, 'Sign out')));
  const body = h('div', {});
  main.append(body);

  const nav = h('nav', { class: 'nav' });
  for (const [label, items] of GROUPS) {
    const vis = items.filter((m) => menu.includes(m) && m !== 'notifications');
    if (!vis.length) continue;
    if (label) nav.append(h('div', { class: 'grp' }, label));
    vis.forEach((m) => nav.append(h('a', { class: m === page ? 'on' : '', href: '#/' + m }, icon(m), MODULES[m].title)));
  }
  nav.append(h('div', { class: 'grp' }, 'Inbox'), h('a', { class: page === 'notifications' ? 'on' : '', href: '#/notifications' }, icon('notifications'), 'Notifications', badge));

  setKids(app, h('div', { class: 'shell' },
    h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('zap')), brandName()), h('div', { class: 'rolechip' }, PANEL[S.user.role]), ws.name && h('div', { class: 'coname' }, ws.name), nav,
      h('div', { class: 'me' }, avatar(S.user.name, 'lg'), h('div', {}, h('b', {}, S.user.name), h('span', {}, S.user.email)))), main));

  api('/notifications?unread=true').then((r) => { if (r.unread) { badge.textContent = r.unread; badge.hidden = false; bell.append(h('span', { class: 'dot' }, r.unread)); } }).catch(() => {});
  try { await MODULES[page].render(body); } catch (e) { toast(e.message, true); }
}
window.addEventListener('hashchange', render);
// hub.js adds pages after this file, so render once every script has run.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
