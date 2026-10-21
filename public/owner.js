'use strict';
/* Platform owner console: every client company, its modules and licence, activation key and desktop installs,
   custom domains, and one-click access to its panel. Talks to /api/owner. */

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
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
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');
const fmtTime = (d) => (d ? new Date(d).toLocaleString() : 'never');
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function modal(title, body, buttons = []) {
  const close = () => m.remove();
  const m = h('div', { class: 'modal wide' }, h('div', {}, h('h3', {}, title), body,
    h('div', { class: 'acts' }, buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), onclick: guard(async () => { if ((await b.run(close)) !== false) close(); }) }, b.label)),
      h('button', { class: 'btn sec', onclick: close }, 'Close'))));
  document.body.append(m);
  return close;
}
const copyBtn = (text) => h('button', { class: 'btn sm sec', onclick: guard(async () => { await navigator.clipboard.writeText(text); toast('Copied'); }) }, 'Copy');

let token = localStorage.getItem('owner_token');
async function api(path, opt = {}) {
  const res = await fetch('/api/owner' + path, {
    method: opt.method || 'GET',
    headers: { ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && path !== '/login') { token = null; localStorage.removeItem('owner_token'); render(); }
  if (!res.ok) throw new Error(data?.details?.[0] ? `${data.details[0].path}: ${data.details[0].message}` : data?.error || res.statusText);
  return data;
}

let MODS = [];
const modLabel = (k) => MODS.find((m) => m.key === k)?.label || k;

// ---------- sign in ----------
function loginScreen() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  return h('div', { class: 'auth' },
    h('div', { class: 'art' }, h('div', { class: 'brand', style: 'position:relative;margin-bottom:28px' }, 'Owner Console'),
      h('h1', {}, 'Every client,', h('br'), 'one control room.'), h('p', {}, 'Assign modules, issue activation keys, connect client domains and switch accounts on or off.')),
    h('div', { class: 'box' }, h('div', { class: 'inner' },
      h('h2', {}, 'Owner sign in'), h('p', { class: 'muted', style: 'margin:0 0 6px' }, 'Create the first owner with: npm run owner:create -- you@example.com "password"'),
      h('form', { onsubmit: guard(async (e) => {
        e.preventDefault();
        const r = await api('/login', { method: 'POST', body: { email: email.value, password: password.value } });
        token = r.token; localStorage.setItem('owner_token', token); render();
      }) }, h('label', {}, 'Email'), email, h('label', {}, 'Password'), password, h('button', { class: 'btn', type: 'submit' }, 'Sign in')))));
}

// ---------- licence form (new client and edit) ----------
function licenceFields(c = {}) {
  const on = new Set(c.modules || MODS.map((m) => m.key));
  const boxes = MODS.map((m) => {
    const cb = h('input', { type: 'checkbox', value: m.key, checked: on.has(m.key), style: 'width:auto;margin:3px 8px 0 0' });
    return { cb, el: h('label', { class: 'modpick' }, cb, h('span', {}, h('b', {}, m.label), h('small', {}, m.desc))) };
  });
  const validUntil = h('input', { type: 'date', value: isoDay(c.validUntil) });
  const maxUsers = h('input', { type: 'number', min: 1, placeholder: 'Unlimited', value: c.maxUsers ?? '' });
  const maxDevices = h('input', { type: 'number', min: 1, placeholder: 'Unlimited', value: c.maxDevices ?? '' });
  const appName = h('input', { placeholder: 'Smart CRM', value: c.branding?.appName || '' });
  const color = h('input', { type: 'color', value: c.branding?.color || '#5b5bf0', style: 'height:42px;padding:4px' });
  const el = h('div', {},
    h('label', {}, 'Modules'), h('div', { class: 'modgrid' }, boxes.map((b) => b.el)),
    h('div', { class: 'cols3' },
      h('div', {}, h('label', {}, 'Licence valid until'), validUntil, h('small', { class: 'hint muted' }, 'Empty = no expiry')),
      h('div', {}, h('label', {}, 'Max active users'), maxUsers),
      h('div', {}, h('label', {}, 'Max desktop computers'), maxDevices)),
    h('div', { class: 'cols2' },
      h('div', {}, h('label', {}, 'App name shown to this client'), appName),
      h('div', {}, h('label', {}, 'Brand colour'), color)));
  const values = () => ({
    modules: boxes.filter((b) => b.cb.checked).map((b) => b.cb.value),
    validUntil: validUntil.value, maxUsers: maxUsers.value, maxDevices: maxDevices.value,
    branding: { appName: appName.value.trim(), color: color.value === '#5b5bf0' ? '' : color.value },
  });
  return { el, values };
}

function newClient(reload) {
  const f = { companyName: h('input', { required: true }), name: h('input', { required: true }), email: h('input', { type: 'email', required: true }), password: h('input', { type: 'text', required: true, placeholder: 'min 8 characters' }) };
  const lic = licenceFields();
  modal('New client', h('div', {},
    h('div', { class: 'cols2' },
      h('div', {}, h('label', {}, 'Company name'), f.companyName), h('div', {}, h('label', {}, 'Admin name'), f.name),
      h('div', {}, h('label', {}, 'Admin email (their login)'), f.email), h('div', {}, h('label', {}, 'Admin password'), f.password)),
    lic.el), [{ label: 'Create client', run: async () => {
    const c = await api('/companies', { method: 'POST', body: { companyName: f.companyName.value, name: f.name.value, email: f.email.value, password: f.password.value, ...lic.values() } });
    toast('Client created');
    reload();
    openCompany(c.id, reload);
  } }]);
}

// ---------- one company ----------
async function openCompany(id, reload) {
  const [c, inst] = await Promise.all([api('/companies/' + id), api('/installer')]);
  const lic = licenceFields(c);
  const name = h('input', { value: c.name });
  const keyEl = h('code', { style: 'font-size:17px;letter-spacing:.06em' }, c.activationKey);
  const refresh = () => { close(); openCompany(id, reload); };

  const domainIn = h('input', { placeholder: 'crm.clientdomain.com' });
  const domains = h('div', {}, c.domains.length ? c.domains.map((d) => h('div', { class: 'card', style: 'margin:10px 0;padding:12px 14px' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, d.host), h('span', { class: 'pill ' + (d.verified ? 'active' : 'waiting') }, d.verified ? 'verified' : 'waiting for DNS')),
    !d.verified && h('p', { class: 'muted', style: 'margin:6px 0' }, 'Ask the client to add these records at their domain registrar, then press Verify:'),
    h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Name / host'), h('th', {}, 'Value'), h('th', {}, ''))),
      h('tbody', {}, d.records.map((r) => h('tr', {}, h('td', {}, r.type), h('td', {}, h('code', {}, r.name)), h('td', {}, h('code', {}, r.value)), h('td', {}, copyBtn(r.value))))))),
    h('div', { class: 'acts', style: 'margin-top:8px' },
      !d.verified && h('button', { class: 'btn sm', onclick: guard(async () => { await api(`/companies/${id}/domains/${d.host}/verify`, { method: 'POST' }); toast('Domain verified'); refresh(); }) }, 'Verify'),
      d.verified && h('a', { class: 'btn sm sec', href: `https://${d.host}`, target: '_blank', rel: 'noopener' }, 'Open'),
      h('button', { class: 'btn sm bad', onclick: guard(async () => { if (!confirm(`Remove ${d.host}?`)) return; await api(`/companies/${id}/domains/${d.host}`, { method: 'DELETE' }); refresh(); }) }, 'Remove'))))
    : h('p', { class: 'muted' }, 'No custom domain. The client uses your main address.'));

  const devices = c.deviceList.length ? h('div', { class: 'tw' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Computer'), h('th', {}, 'Version'), h('th', {}, 'Last seen'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, c.deviceList.map((d) => h('tr', {},
      h('td', {}, d.name || d.deviceId.slice(0, 12), h('small', { class: 'muted', style: 'display:block' }, d.platform || '')),
      h('td', {}, d.appVersion || ''), h('td', {}, fmtTime(d.lastSeenAt), h('small', { class: 'muted', style: 'display:block' }, d.lastIp || '')),
      h('td', {}, h('span', { class: 'pill ' + (d.revoked ? 'failed' : 'active') }, d.revoked ? 'revoked' : 'active')),
      h('td', { class: 'acts-cell' },
        h('button', { class: 'btn sm sec', onclick: guard(async () => { await api('/devices/' + d._id, { method: 'PATCH', body: { revoked: !d.revoked } }); refresh(); }) }, d.revoked ? 'Restore' : 'Revoke'),
        h('button', { class: 'btn sm bad', title: 'Frees the slot; the computer must activate again', onclick: guard(async () => { if (!confirm('Remove this computer? It will need the activation key again.')) return; await api('/devices/' + d._id, { method: 'DELETE' }); refresh(); }) }, 'Remove')))))))
    : h('p', { class: 'muted' }, 'No computer activated yet.');

  const users = h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Status'))),
    h('tbody', {}, c.userList.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, h('span', { class: 'pill ' + u.role }, u.role.replace('_', ' '))), h('td', {}, h('span', { class: 'pill ' + (u.active ? 'active' : 'failed') }, u.active ? 'active' : 'disabled')))))));

  const section = (title, ...kids) => h('div', { class: 'osec' }, h('h4', {}, title), ...kids);
  const close = modal(c.name, h('div', {},
    c.problem && h('div', { class: 'warnbar' }, c.problem),
    section('Company & licence', h('label', {}, 'Company name'), name, lic.el),
    section('Desktop app',
      h('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Send the client the installer and this activation key. On first start the app asks for the key, then shows only the modules above.'),
      h('div', { class: 'row', style: 'gap:10px;align-items:center' }, keyEl, copyBtn(c.activationKey),
        h('button', { class: 'btn sm sec', title: 'Computers already activated keep working', onclick: guard(async () => { if (!confirm('Issue a new key? The old key stops activating new computers.')) return; keyEl.textContent = (await api(`/companies/${id}/activation-key`, { method: 'POST' })).activationKey; reload(); }) }, 'New key')),
      inst.available
        ? h('p', {}, 'Installer: ', h('a', { href: inst.url }, inst.file), h('span', { class: 'muted' }, ` · ${(inst.size / 1048576).toFixed(0)} MB · built ${fmtTime(inst.builtAt)}`), ' ', copyBtn(location.origin + inst.url))
        : h('p', { class: 'muted' }, 'No installer built yet. Run npm run desktop:build on your computer; it lands in the downloads folder.'),
      h('label', {}, `Activated computers (${c.devices}${c.maxDevices ? ' of ' + c.maxDevices : ''})`), devices),
    section('Custom domains', domains, h('div', { class: 'row', style: 'margin-top:8px' }, domainIn,
      h('button', { class: 'btn sec', onclick: guard(async () => { await api(`/companies/${id}/domains`, { method: 'POST', body: { host: domainIn.value } }); refresh(); }) }, 'Add domain'))),
    section(`Users (${c.users} active${c.maxUsers ? ' of ' + c.maxUsers : ''})`, users)),
  [
    { label: 'Save licence', run: async () => { await api('/companies/' + id, { method: 'PATCH', body: { name: name.value, ...lic.values() } }); toast('Saved. Applies to the client right away.'); reload(); return false; } },
    c.status === 'suspended'
      ? { label: 'Reactivate', run: async () => { await api('/companies/' + id, { method: 'PATCH', body: { status: 'active' } }); toast('Reactivated'); reload(); refresh(); return false; } }
      : { label: 'Suspend', cls: 'bad', run: async () => {
        const reason = prompt('Reason shown to the client (optional):', 'Payment due');
        if (reason === null) return false;
        await api('/companies/' + id, { method: 'PATCH', body: { status: 'suspended', suspendReason: reason } });
        toast('Suspended: users are signed out and sending stops'); reload(); refresh(); return false;
      } },
    { label: 'Open their panel', cls: 'sec', run: async () => {
      const r = await api(`/companies/${id}/login-as`, { method: 'POST' });
      // The panel at / reads its session from localStorage (same origin).
      localStorage.setItem('crm_user', JSON.stringify({ ...r.user, workspace: r.workspace }));
      localStorage.setItem('crm_at', r.accessToken); localStorage.setItem('crm_rt', r.refreshToken);
      window.open('/', '_blank');
      return false;
    } },
  ]);
}

// ---------- main screen ----------
async function render() {
  const app = $('#app');
  if (!token) { app.replaceChildren(loginScreen()); return; }
  if (!MODS.length) MODS = await api('/modules');
  const me = await api('/me');
  const stats = h('div', { class: 'grid' });
  const tbody = h('tbody');
  const q = h('input', { placeholder: 'Search clients…', type: 'search' });

  async function load() {
    const [o, list] = await Promise.all([api('/overview'), api('/companies' + (q.value ? '?q=' + encodeURIComponent(q.value) : ''))]);
    const stat = (v, l, c) => h('div', { class: 'stat', style: `--c:${c}` }, h('div', {}, h('b', {}, v), h('span', {}, l)));
    stats.replaceChildren(stat(o.companies, 'Clients', 'var(--brand)'), stat(o.active, 'Active', 'var(--ok)'), stat(o.suspended + o.expired, 'Suspended / expired', 'var(--bad)'), stat(o.users, 'Active users', 'var(--info)'), stat(o.devices, 'Desktop installs', 'var(--warn)'));
    tbody.replaceChildren(...(list.length ? list.map((c) => h('tr', { style: 'cursor:pointer', onclick: guard(() => openCompany(c.id, load)) },
      h('td', {}, h('b', {}, c.name), h('small', { class: 'muted', style: 'display:block' }, c.domains.filter((d) => d.verified).map((d) => d.host).join(', ') || 'main address')),
      h('td', {}, h('div', { class: 'chips' }, c.modules.length ? c.modules.map((m) => h('span', { class: 'pill' }, modLabel(m))) : h('span', { class: 'muted' }, 'none'))),
      h('td', {}, `${c.users}${c.maxUsers ? ' / ' + c.maxUsers : ''}`), h('td', {}, `${c.devices}${c.maxDevices ? ' / ' + c.maxDevices : ''}`),
      h('td', {}, c.validUntil ? fmtDate(c.validUntil) : 'No expiry'),
      h('td', {}, h('span', { class: 'pill ' + (c.problem ? 'failed' : 'active') }, c.status === 'suspended' ? 'suspended' : c.problem ? 'expired' : 'active'))))
      : [h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No clients yet. Press "New client".'))]));
  }

  q.addEventListener('input', guard(load));
  app.replaceChildren(h('div', { class: 'owner' },
    h('div', { class: 'top' }, h('div', { class: 'ttl' }, h('h2', {}, 'Owner Console'), h('p', {}, `Signed in as ${me.email}`)),
      h('button', { class: 'btn', onclick: () => newClient(load) }, '+ New client'),
      h('button', { class: 'btn sec', onclick: () => { token = null; localStorage.removeItem('owner_token'); render(); } }, 'Sign out')),
    stats,
    h('div', { class: 'card flush' }, h('div', { class: 'bar', style: 'padding:14px 16px 0' }, q),
      h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['Client', 'Modules', 'Users', 'Computers', 'Licence until', 'Status'].map((t) => h('th', {}, t)))), tbody)))));
  await load();
}

render().catch((e) => toast(e.message, true));
