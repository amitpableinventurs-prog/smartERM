// Bakes the central server address into the installer: SERVER_URL=https://crm.example.com npm run dist
// Without SERVER_URL the current app-config.json is kept (empty = the activation screen asks for the address).
const fs = require('fs');
const path = require('path');

const url = (process.env.SERVER_URL || '').trim().replace(/\/+$/, '');
const file = path.join(__dirname, '..', 'app-config.json');
if (url) {
  if (!/^https?:\/\/[^/]+$/.test(url)) { console.error(`SERVER_URL must look like https://crm.example.com (got ${url})`); process.exit(1); }
  fs.writeFileSync(file, JSON.stringify({ serverUrl: url }, null, 2) + '\n');
}
console.log('Server address in this build: %s', JSON.parse(fs.readFileSync(file, 'utf8')).serverUrl || '(asked on first start)');
