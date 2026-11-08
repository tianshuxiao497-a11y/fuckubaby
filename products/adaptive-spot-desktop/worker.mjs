// No dotenv loading and no user-provided entry point. State lives in the
// isolated desktop profile (cwd), code lives in the installed engine.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopSubscription as subscription } from './entrypoint-gate.mjs';
delete process.env.ASB_LICENSE_SESSION;
delete process.env.ASB_LICENSE_DEVICE_HASH;
const originalFetch = globalThis.fetch;
let stopRequested = false;
let firstLease;
const authorized = new Promise(resolve => { firstLease=resolve; });
// Refuse any new API request immediately after guardian loss, including an
// order whose signal was calculated just before the controller disappeared.
globalThis.fetch = (...args) => {
  if (stopRequested || !process.connected || !subscription.active()) return Promise.reject(new Error('Desktop stopped, guardian disconnected or subscription expired.'));
  return originalFetch(...args);
};
let initialized=false;
const guardian = setInterval(() => {
  if (stopRequested || !process.connected || (initialized && !subscription.active())) { stopRequested=true; subscription.clear(); process.emit('SIGTERM'); }
}, 100);
guardian.unref();
process.on('message', message => {
  if (message?.command === 'licenseLease' && !stopRequested) {
    try { subscription.accept(message.token); initialized=true; firstLease(); }
    catch { stopRequested=true; subscription.clear(); process.emit('SIGTERM'); firstLease(); }
  }
  if (message?.command === 'stop') { stopRequested = true; subscription.clear(); process.emit('SIGTERM'); firstLease(); }
});
process.on('disconnect', async () => {
  stopRequested = true;
  subscription.clear(); firstLease();
  process.emit('SIGTERM');
  await mkdir(resolve('.paper-data'), { recursive: true });
  await writeFile(resolve('.paper-data/testnet-stop'), 'desktop guardian disconnected');
});
process.argv = [process.execPath, fileURLToPath(new URL('../../scripts/testnet.mjs', import.meta.url)),
  '--watch', '--enable-testnet-orders'];
try {
  let timeout;
  try { await Promise.race([authorized,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('No signed subscription lease.')),10000);})]); }
  finally {clearTimeout(timeout);}
  if(stopRequested || !process.connected || !subscription.active()) throw new Error('Subscription required before worker startup.');
  await import('../../scripts/testnet.mjs');
}
finally { clearInterval(guardian); if (process.connected) process.disconnect(); }
