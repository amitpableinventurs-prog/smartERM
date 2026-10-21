// Copies the newest built installer to ../downloads, where the server offers it at /downloads/<file>
// and the owner console links to it.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const out = path.join(__dirname, '..', '..', 'downloads');
const exe = fs.readdirSync(dist).filter((f) => /^SmartCRM-Setup-.*\.exe$/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(dist, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
if (!exe) { console.error('No installer found in desktop/dist'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(dist, exe.f), path.join(out, exe.f));
console.log('Installer ready: downloads/%s', exe.f);
