'use strict';
/* Offline support for the panels (used by api() in app.js).
   - Every successful GET is remembered, so pages opened before keep working without a connection.
   - While offline, everyday writes (new/edited leads, customers, deals, tasks, notes, call logs) are queued
     on this computer and replayed in order once the server is reachable. Everything else needs a connection.
   - The central server stays the source of truth: queued changes go through the normal API and its checks. */
const Offline = (() => {
  const QUEUEABLE = [
    ['POST', /^\/(leads|customers|deals|tasks|communications)$/],
    ['PATCH', /^\/(leads|customers|deals|tasks)\/[\w-]+$/],
    ['POST', /^\/leads\/[\w-]+\/notes$/],
    ['POST', /^\/tasks\/[\w-]+\/complete$/],
  ];
  const MAX_AGE = 30 * 864e5;
  const uid = () => (typeof S !== 'undefined' && S.user?.id) || 'anon';
  const key = (path) => uid() + '|' + path;

  let dbp;
  function db() {
    return (dbp ??= new Promise((resolve, reject) => {
      const r = indexedDB.open('smartcrm-offline', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('cache');
        r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        r.result.createObjectStore('failed', { keyPath: 'id', autoIncrement: true });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  const run = (store, mode, op) => db().then((d) => new Promise((resolve, reject) => {
    const r = op(d.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const mine = (store) => run(store, 'readonly', (s) => s.getAll()).then((all) => all.filter((x) => x.user === uid()));

  // ---- status pill (bottom-left) ----
  let offline = false, syncing = false;
  const pill = document.createElement('div');
  pill.className = 'netpill';
  pill.hidden = true;
  pill.addEventListener('click', () => reviewFailed());
  document.addEventListener('DOMContentLoaded', () => document.body.append(pill));

  async function refreshPill() {
    let waiting = 0, failed = 0;
    try { [waiting, failed] = await Promise.all([mine('outbox'), mine('failed')]).then((r) => r.map((x) => x.length)); } catch { /* IndexedDB unavailable */ }
    const parts = [];
    if (offline) parts.push('Offline: showing saved data');
    if (syncing) parts.push('Syncing…');
    if (waiting) parts.push(`${waiting} change${waiting > 1 ? 's' : ''} waiting to sync`);
    if (failed) parts.push(`${failed} could not sync (review)`);
    pill.textContent = parts.join(' · ');
    pill.className = 'netpill' + (offline ? ' off' : '') + (failed ? ' bad' : '');
    pill.hidden = !parts.length;
  }

  function setOffline(v) {
    if (offline === v) return;
    offline = v;
    refreshPill();
    if (!v) flush();
  }

  // ---- reads ----
  async function remember(path, data) {
    try { await run('cache', 'readwrite', (s) => s.put({ data, at: Date.now() }, key(path))); } catch { /* quota or private mode: just skip */ }
  }

  // Cached list plus what this user created or edited offline, so their work shows up straight away.
  async function withPending(path, data) {
    if (!data || !Array.isArray(data.data)) return data;
    const base = path.split('?')[0];
    const out = await mine('outbox');
    const created = out.filter((i) => i.method === 'POST' && i.path === base).map((i) => ({ ...i.body, _id: i.tempId, _offline: true, createdAt: new Date(i.at).toISOString() }));
    const edits = new Map(out.filter((i) => i.method === 'PATCH' && i.path.startsWith(base + '/')).map((i) => [i.path.slice(base.length + 1), i.body]));
    const rows = data.data.map((r) => (edits.has(r._id) ? { ...r, ...edits.get(r._id), _offline: true } : r));
    return { ...data, data: [...created.reverse(), ...rows] };
  }

  // Called by api() when the request could not reach the server.
  async function fallback(path, opt) {
    const method = opt.method || 'GET';
    setOffline(true);
    if (method === 'GET') {
      const hit = await run('cache', 'readonly', (s) => s.get(key(path))).catch(() => null);
      if (!hit) throw new Error('You are offline, and this page has not been opened on this computer before.');
      return withPending(path, hit.data);
    }
    const bare = path.split('?')[0];
    if (opt.csv || !QUEUEABLE.some(([m, re]) => m === method && re.test(bare))) throw new Error('You are offline. This action needs an internet connection.');
    const tempId = method === 'POST' && /^\/\w+$/.test(bare) ? 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) : undefined;
    await run('outbox', 'readwrite', (s) => s.add({ user: uid(), method, path, body: opt.body, tempId, at: Date.now() }));
    refreshPill();
    if (typeof toast === 'function') toast('Saved on this computer. It will sync when you are back online.');
    return { ...(opt.body || {}), _id: tempId || bare.split('/')[2], _offline: true };
  }

  // ---- sync ----
  let flushing = false;
  async function flush() {
    if (flushing || typeof S === 'undefined' || !S.access) return;
    flushing = true;
    let done = 0;
    try {
      const items = await mine('outbox');
      if (!items.length) return;
      syncing = true;
      refreshPill();
      const idMapKey = key('__idmap');
      const idMap = (await run('cache', 'readonly', (s) => s.get(idMapKey)).catch(() => null)) || {};
      for (const it of items) {
        // Records created offline get their real id from the server; later queued changes must use it.
        let { path } = it, body = it.body;
        for (const [tmp, real] of Object.entries(idMap)) {
          path = path.split(tmp).join(real);
          if (body) body = JSON.parse(JSON.stringify(body).split(tmp).join(real));
        }
        try {
          const r = await api(path, { method: it.method, body, noOffline: true });
          if (it.tempId && r?._id) { idMap[it.tempId] = r._id; await run('cache', 'readwrite', (s) => s.put(idMap, idMapKey)); }
          done++;
        } catch (e) {
          if (e.offline) break; // still unreachable: try again later
          // The server refused it (duplicate, validation, permission): keep it for the user to review.
          await run('failed', 'readwrite', (s) => s.add({ ...it, path, body, error: e.message, failedAt: Date.now() }));
        }
        await run('outbox', 'readwrite', (s) => s.delete(it.id));
      }
    } catch (e) {
      console.warn('offline sync', e);
    } finally {
      flushing = false;
      syncing = false;
      refreshPill();
      if (done && typeof toast === 'function') {
        toast(`Synced ${done} offline change${done > 1 ? 's' : ''}`);
        if (!document.querySelector('.modal') && typeof render === 'function') render();
      }
    }
  }

  async function reviewFailed() {
    const failed = await mine('failed');
    if (!failed.length || typeof modal !== 'function') return;
    const list = h('div', {}, failed.map((f) => h('div', { class: 'card', style: 'margin:8px 0;padding:10px 12px' },
      h('b', {}, `${f.method} ${f.path}`), h('div', { class: 'muted' }, new Date(f.at).toLocaleString()),
      h('div', { style: 'color:var(--bad)' }, f.error),
      f.body && h('pre', { style: 'white-space:pre-wrap;font-size:12px;margin:6px 0 0' }, JSON.stringify(f.body, null, 1)))));
    modal('Changes that could not sync', h('div', {}, h('p', { class: 'muted' }, 'The server refused these changes made offline. Re-enter them if they are still needed, then discard.'), list), [
      { label: 'Try again', run: async () => {
        for (const f of failed) {
          await run('failed', 'readwrite', (s) => s.delete(f.id));
          await run('outbox', 'readwrite', (s) => s.add({ user: f.user, method: f.method, path: f.path, body: f.body, tempId: f.tempId, at: f.at }));
        }
        flush();
      } },
      { label: 'Discard all', cls: 'sec', run: async () => { for (const f of failed) await run('failed', 'readwrite', (s) => s.delete(f.id)); refreshPill(); } },
    ], true);
  }

  async function pendingCount() { try { return (await mine('outbox')).length; } catch { return 0; } }

  // On sign-out: forget this user's saved data and queue.
  async function clearUser(id) {
    try {
      const d = await db();
      for (const store of ['outbox', 'failed']) for (const x of await run(store, 'readonly', (s) => s.getAll())) if (x.user === id) await run(store, 'readwrite', (s) => s.delete(x.id));
      const keys = await run('cache', 'readonly', (s) => s.getAllKeys());
      const t = d.transaction('cache', 'readwrite');
      keys.filter((k) => String(k).startsWith(id + '|')).forEach((k) => t.objectStore('cache').delete(k));
    } catch { /* nothing stored */ }
    refreshPill();
  }

  // Drop saved pages nobody opened for a month.
  db().then((d) => {
    const t = d.transaction('cache', 'readwrite');
    t.objectStore('cache').openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (c.value?.at && Date.now() - c.value.at > MAX_AGE) c.delete();
      c.continue();
    };
  }).catch(() => {});

  window.addEventListener('online', () => flush());
  setInterval(() => { if (offline || !pill.hidden) flush(); }, 30e3);
  setTimeout(() => { refreshPill(); flush(); }, 1500);

  return { remember, fallback, setOffline, flush, pendingCount, clearUser };
})();
