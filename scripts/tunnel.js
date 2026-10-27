// Real Twilio calls while developing on localhost: opens a free Cloudflare quick tunnel to this server and starts
// the server with PUBLIC_URL set to the tunnel address, so Twilio can fetch the IVR. Needs cloudflared on PATH.
// Run: npm run tunnel   (stop any other server on the same PORT first)
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ quiet: true });

const port = +process.env.PORT || 5000;
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let server;

tunnel.on('error', (e) => {
  console.error(e.code === 'ENOENT' ? 'cloudflared is not installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' : e.message);
  process.exit(1);
});
tunnel.on('exit', (code) => {
  console.error(`cloudflared stopped (${code})`);
  server?.kill();
  process.exit(code || 1);
});

// cloudflared prints the address in its log; api.trycloudflare.com only shows up in its error messages.
function watch(chunk) {
  const url = !server && /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk))?.[0];
  if (!url) return;
  console.log(`\n  PUBLIC_URL = ${url}`);
  console.log('  The address changes on every run. For incoming calls, open Channel Providers > Voice > Connect Twilio again.');
  console.log('  Sign-in redirects (Google / Facebook) still need your usual PUBLIC_URL.\n');
  server = spawn(process.execPath, ['--watch', path.join(__dirname, '..', 'src', 'server.js')], { stdio: 'inherit', env: { ...process.env, PUBLIC_URL: url } });
  server.on('exit', (code) => { tunnel.kill(); process.exit(code ?? 0); });
}
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server?.kill(); tunnel.kill(); process.exit(0); });
