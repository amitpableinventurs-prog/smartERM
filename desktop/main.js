/**
 * Smart CRM for Windows. The panels (../public) ship inside the app and are served from app://smartcrm; all data
 * lives on the central server. A computer is activated once with the company's activation key, then checks its
 * licence at every start and every 30 minutes. Without a connection it keeps working for the grace period the
 * server sets (offline.js in the panels queues changes until the server is reachable).
 */
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const ORIGIN = 'app://smartcrm';
const CHECK_EVERY = 30 * 60e3;
const PUBLIC_DIR = app.isPackaged ? path.join(process.resourcesPath, 'public') : path.join(__dirname, '..', 'public');
const UI_DIR = path.join(__dirname, 'ui');
const BUILD = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8')); // { serverUrl } baked in at build time

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// ---- licence state (userData/licence.json) ----
// { serverUrl, deviceId, secret (DPAPI-encrypted when available), company, lastOkAt }
const stateFile = () => path.join(app.getPath('userData'), 'licence.json');
let state = {};
const loadState = () => { try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { state = {}; } };
const saveState = () => fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
const encrypted = () => safeStorage.isEncryptionAvailable();
const setSecret = (s) => { state.secret = encrypted() ? { enc: safeStorage.encryptString(s).toString('base64') } : { plain: s }; };
const getSecret = () => (state.secret?.enc ? safeStorage.decryptString(Buffer.from(state.secret.enc, 'base64')) : state.secret?.plain);
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

async function post(url, body) {
  const res = await net.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20e3) });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, data };
}

// 'ok' | 'revoked' | 'blocked' | 'unknown' (server answered) or 'offline' (it did not).
async function checkLicence() {
  try {
    const r = await post(state.serverUrl + '/api/activate/check', { companyId: String(state.company.id), deviceId: state.deviceId, deviceSecret: getSecret(), appVersion: app.getVersion() });
    if (!r.ok || !r.data?.status) return { status: 'offline' };
    if (r.data.status === 'ok') { state.company = r.data.company; state.lastOkAt = Date.now(); saveState(); }
    return r.data;
  } catch {
    return { status: 'offline' };
  }
}

// ---- window ----
let win;
const title = () => (state.company ? `${state.company.branding?.appName || 'Smart CRM'} - ${state.company.name}` : 'Smart CRM');

function showApp() {
  win.setTitle(title());
  win.loadURL(`${ORIGIN}/index.html`);
}
function showActivation(opts = {}) {
  win.setTitle(title());
  win.loadURL(`${ORIGIN}/_desktop/activate.html?${new URLSearchParams(opts)}`);
}

async function start() {
  if (!state.company) return showActivation();
  const r = await checkLicence();
  if (r.status === 'ok') return showApp();
  if (r.status === 'offline') {
    const grace = (state.company.offlineGraceDays || 7) * 864e5;
    if (state.lastOkAt && Date.now() - state.lastOkAt < grace) return showApp();
    return showActivation({ mode: 'blocked', message: `Cannot reach ${state.serverUrl}. Connect to the internet once to verify your licence.` });
  }
  showActivation({ mode: 'blocked', message: r.message || 'Licence check failed.' });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 640, show: false, autoHideMenuBar: true, title: title(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // Links to websites open in the normal browser; the app window only shows the bundled panels.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN + '/')) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  start();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'App', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
      { label: 'Check licence now', click: () => start() },
      { type: 'separator' },
      { label: 'Deactivate this computer…', click: () => deactivate() },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { label: 'Help', submenu: [{ label: `Version ${app.getVersion()}`, enabled: false }, { label: 'Device ID: ' + (state.deviceId || '').slice(0, 8), enabled: false }] },
  ]));
}

async function deactivate() {
  const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Deactivate'], defaultId: 0, message: 'Deactivate this computer?', detail: 'You will need the activation key to use the app here again. Changes made offline that have not synced will stay on this computer until you sign in again.' });
  if (response !== 1) return;
  delete state.company; delete state.secret; delete state.lastOkAt;
  saveState();
  showActivation();
}

// ---- IPC for preload.js ----
ipcMain.on('desk:config', (e) => {
  e.returnValue = {
    desktop: true, version: app.getVersion(), deviceId: state.deviceId,
    apiBase: state.company ? state.serverUrl : '', defaultServer: state.serverUrl || BUILD.serverUrl || '',
    company: state.company ? { name: state.company.name, branding: state.company.branding || {}, modules: state.company.modules } : null,
  };
});

ipcMain.handle('desk:activate', async (_e, { serverUrl, key }) => {
  serverUrl = cleanUrl(serverUrl);
  if (!/^https?:\/\/[^/]+/.test(serverUrl)) return { error: 'Enter the server address, e.g. https://crm.example.com' };
  let r;
  try {
    r = await post(serverUrl + '/api/activate', { key, deviceId: state.deviceId, deviceName: os.hostname(), platform: `${os.type()} ${os.release()}`, appVersion: app.getVersion() });
  } catch {
    return { error: `Cannot reach ${serverUrl}. Check the address and your internet connection.` };
  }
  if (!r.ok) return { error: r.data?.error || `Server answered ${r.status}` };
  state.serverUrl = serverUrl;
  state.company = r.data.company;
  state.lastOkAt = Date.now();
  setSecret(r.data.deviceSecret);
  saveState();
  showApp();
  return { ok: true };
});

ipcMain.handle('desk:retry', () => start());

// ---- lifecycle ----
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  loadState();
  if (!state.deviceId) { state.deviceId = crypto.randomUUID(); saveState(); }

  protocol.handle(SCHEME, (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const [base, sub] = rel.startsWith('_desktop/') ? [UI_DIR, rel.slice('_desktop/'.length)] : [PUBLIC_DIR, rel];
    const file = path.normalize(path.join(base, sub));
    if (!file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  buildMenu();
  createWindow();

  setInterval(async () => {
    if (!state.company) return;
    const r = await checkLicence();
    if (['revoked', 'blocked', 'unknown'].includes(r.status)) showActivation({ mode: 'blocked', message: r.message });
  }, CHECK_EVERY);
});

app.on('window-all-closed', () => app.quit());
