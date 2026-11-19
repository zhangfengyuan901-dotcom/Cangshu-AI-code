'use strict';
// Run locally. Never print the shared signing secret or pass it as a process argument.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const file = path.join(require('./local-state.cjs').privateDir, 'media-ticket.env');
if (process.argv.includes('--rotate')) {
  const replacement = file + '.new';
  fs.writeFileSync(replacement, 'PIKNO_MEDIA_TICKET_KEY=' + crypto.randomBytes(48).toString('hex') + '\n', { flag:'wx', mode:0o600 });
  fs.renameSync(replacement, file);
}
if (!fs.existsSync(file)) fs.writeFileSync(file, 'PIKNO_MEDIA_TICKET_KEY=' + crypto.randomBytes(48).toString('hex') + '\n', { flag:'wx', mode:0o600 });
const secret = fs.readFileSync(file,'utf8').trim().split('=')[1];
if (!/^[a-f0-9]{96}$/.test(secret)) throw Error('Invalid media secret file');
if (process.argv.includes('--cloudflare')) {
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'../../tools/relay-cli/node_modules/wrangler/bin/wrangler.js'),'secret','put','TICKET_KEY','--config',path.resolve(__dirname,'../../cloudflare/relay-media/wrangler.jsonc')],{input:secret+'\n',encoding:'utf8'});
  if (result.status!==0) { console.error('Secret provisioning failed',result.stderr); process.exit(1); }
  console.log('Cloudflare media secret provisioned; value not displayed.');
} else console.log('Media secret ready in private file; value not displayed.');
