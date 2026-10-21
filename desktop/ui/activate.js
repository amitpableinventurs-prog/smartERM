'use strict';
// Activation / locked screen of the desktop app. window.desktop and window.CRM_CONFIG come from preload.js.
const $ = (id) => document.getElementById(id);
const cfg = window.CRM_CONFIG || {};
const params = new URLSearchParams(location.search);

if (cfg.company) $('brand').textContent = cfg.company.branding?.appName || cfg.company.name;
$('server').value = cfg.defaultServer || '';
if (!cfg.defaultServer) $('adv').open = true; // no server baked into this build: ask for it

function showForm() { $('blocked').hidden = true; $('form').hidden = false; $('key').focus(); }
if (params.get('mode') === 'blocked') {
  $('reason').textContent = params.get('message') || 'Licence check failed.';
  $('blocked').hidden = false;
  $('form').hidden = true;
} else {
  showForm();
}

$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  $('retry').textContent = 'Checking…';
  await window.desktop.retry(); // main process reloads the right screen
});
$('rekey').addEventListener('click', showForm);

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').hidden = true;
  $('go').disabled = true;
  $('go').textContent = 'Activating…';
  const r = await window.desktop.activate($('server').value, $('key').value.trim());
  if (r?.error) {
    $('err').textContent = r.error;
    $('err').hidden = false;
    $('go').disabled = false;
    $('go').textContent = 'Activate';
  }
});
