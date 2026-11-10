import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

// Every child has a fresh temporary engine and a generated test-only signer.
// The real worker, lease verifier and entrypoint guard are copied unchanged.
// The only runner uses data: fetches: no account, secrets, DNS or trading APIs.
const runner = `
import { assertLicensedDesktopEntry } from '../products/adaptive-spot-desktop/entrypoint-gate.mjs';
assertLicensedDesktopEntry();
const report = value => process.stdout.write(JSON.stringify(value) + '\\n');
report({ type: 'runner_started' });
let finish, stopped = false, grace;
const done = new Promise(resolve => { finish = resolve; });
const deadline = setTimeout(finish, 6500);
async function probe(id) {
  let entryAllowed = true;
  try { assertLicensedDesktopEntry(); } catch { entryAllowed = false; }
  try {
    // Check fetch independently: an entrypoint refusal must not mask a missing
    // per-request worker gate when an already-running strategy loses its lease.
    const response = await fetch('data:text/plain,offline-probe');
    report({ type: 'probe', id, entryAllowed, allowed: true, text: await response.text() });
  } catch {
    report({ type: 'probe', id, entryAllowed, allowed: false });
  }
}
process.on('message', message => {
  if (message?.command === 'probe') probe(message.id);
  if (message?.command === 'finish_fixture') finish();
  if (message?.command === 'disconnect_fixture') setImmediate(() => process.disconnect());
});
process.on('SIGTERM', () => {
  if (stopped) return;
  stopped = true;
  report({ type: 'termination_observed' });
  // Keep the runner alive briefly to challenge it with a late signed lease.
  grace = setTimeout(finish, 750);
});
process.on('disconnect', () => { probe('after_disconnect'); });
try { await done; }
finally { clearTimeout(deadline); clearTimeout(grace); }
`;

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'asb-worker-license-test-'));
  const desktop = resolve(directory, 'engine/products/adaptive-spot-desktop');
  const scripts = resolve(directory, 'engine/scripts');
  const profile = resolve(directory, 'empty-test-profile');
  // Both children share engine as a parent. Create that dependency first to
  // avoid recursive-parent creation races on Windows restricted filesystems.
  await mkdir(resolve(directory,'engine'));
  await Promise.all([mkdir(desktop, { recursive: true }), mkdir(scripts), mkdir(profile)]);
  for (const name of ['worker.mjs', 'license.mjs', 'license-device.mjs', 'device-protocol.mjs', 'device-identity.mjs', 'entrypoint-gate.mjs']) {
    await copyFile(fileURLToPath(new URL(name, import.meta.url)), resolve(desktop, name));
  }
  const pair = generateKeyPairSync('ed25519');
  const session = randomUUID();
  await writeFile(resolve(desktop, 'license-config.json'), JSON.stringify({
    endpoint: 'https://offline-fixture.invalid/api/validate',
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    companyId: 'biz_offline', productId: 'prod_offline', planIds: ['plan_monthly']
  }), { flag: 'wx' });
  await writeFile(resolve(scripts, 'testnet.mjs'), runner, { flag: 'wx' });
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, [resolve(desktop, 'worker.mjs')], {
    cwd: profile, windowsHide: true, env: { ...env, ASB_LICENSE_SESSION: session, ASB_LICENSE_DEVICE_HASH: "d".repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const records = [];
  let stderr = '', closed = false;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => { try { records.push(JSON.parse(line)); } catch {} });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const completion = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
  });
  async function waitFor(predicate, timeout = 4000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const found = records.find(predicate);
      if (found) return found;
      if (closed) throw new Error('Offline fixture exited before expected event: ' + stderr);
      await sleep(10);
    }
    throw new Error('Offline fixture event timed out: ' + stderr);
  }
  async function send(message) {
    if (!child.connected) throw new Error('Offline fixture IPC is disconnected.');
    await new Promise((resolveSend, reject) => child.send(message, error => error ? reject(error) : resolveSend()));
  }
  async function exit(timeout = 4000) {
    let timer;
    try { return await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Offline fixture failed to exit: ' + stderr)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  function token({ ttl = 5000, issuedAt = Date.now(), audience = 'AdaptiveSpotBot.Testnet.Subscription.v1', signer = pair.privateKey } = {}) {
    const claims = { v: 2, deviceHash: "d".repeat(64), aud: audience, companyId: 'biz_offline', productId: 'prod_offline', planId: 'plan_monthly',
      session, nonce: randomUUID(), licenseHash: '0'.repeat(64), issuedAt, expiresAt: issuedAt + ttl, paidUntil: issuedAt + 86400000 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return payload + '.' + sign(null, Buffer.from(payload), signer).toString('base64url');
  }
  t.after(async () => {
    if (!closed && child.connected) {
      await send({ command: 'stop' }).catch(() => {});
      await send({ command: 'finish_fixture' }).catch(() => {});
    }
    try { await exit(); }
    catch {
      // Last-resort cleanup applies only to this exact child object/PID.
      // It never discovers, signals or stops an installed trading process.
      child.kill('SIGTERM');
      await completion;
    }
    lines.close();
  });
  return { child, records, send, exit, token, waitFor, stderr: () => stderr };
}

test('real worker never imports runner without a signed lease', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await sleep(200);
  assert.equal(f.records.some(record => record.type === 'runner_started'), false);
  await f.send({ command: 'stop' });
  const ended = await f.exit();
  assert.notEqual(ended.code, 0);
  assert.equal(f.records.some(record => record.type === 'runner_started'), false);
});

test('real worker rejects a forged Ed25519 lease before importing runner', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const other = generateKeyPairSync('ed25519');
  await f.send({ command: 'licenseLease', token: f.token({ signer: other.privateKey }) });
  const ended = await f.exit();
  assert.notEqual(ended.code, 0);
  assert.equal(f.records.some(record => record.type === 'runner_started'), false);
});

test('real signed lease permits guarded runner and an offline data fetch', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.send({ command: 'licenseLease', token: f.token() });
  await f.waitFor(record => record.type === 'runner_started');
  await f.send({ command: 'probe', id: 'authorized' });
  const result = await f.waitFor(record => record.type === 'probe' && record.id === 'authorized');
  assert.equal(result.allowed, true);
  assert.equal(result.entryAllowed, true);
  assert.equal(result.text, 'offline-probe');
  await f.send({ command: 'finish_fixture' });
  assert.equal((await f.exit()).code, 0, f.stderr());
});

test('real worker expires, blocks fetches, and cannot revive from a late valid lease', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.send({ command: 'licenseLease', token: f.token({ ttl: 1200 }) });
  await f.waitFor(record => record.type === 'runner_started');
  await f.waitFor(record => record.type === 'termination_observed');
  await f.send({ command: 'licenseLease', token: f.token() });
  await f.send({ command: 'probe', id: 'after_expiry_and_late_lease' });
  const result = await f.waitFor(record => record.type === 'probe' && record.id === 'after_expiry_and_late_lease');
  assert.equal(result.allowed, false);
  assert.equal(result.entryAllowed, false);
  await f.send({ command: 'finish_fixture' });
  await f.exit();
  assert.equal(f.records.filter(record => record.type === 'runner_started').length, 1);
});

test('real worker STOP blocks fetches and rejects a later signed lease', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.send({ command: 'licenseLease', token: f.token() });
  await f.waitFor(record => record.type === 'runner_started');
  await f.send({ command: 'stop' });
  await f.waitFor(record => record.type === 'termination_observed');
  await f.send({ command: 'licenseLease', token: f.token() });
  await f.send({ command: 'probe', id: 'after_stop_and_late_lease' });
  const result = await f.waitFor(record => record.type === 'probe' && record.id === 'after_stop_and_late_lease');
  assert.equal(result.allowed, false);
  assert.equal(result.entryAllowed, false);
  await f.send({ command: 'finish_fixture' });
  await f.exit();
});

test('real worker IPC disconnection blocks later offline fetches and exits', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.send({ command: 'licenseLease', token: f.token() });
  await f.waitFor(record => record.type === 'runner_started');
  // Request that the fixture close the real IPC channel from the child side.
  // This produces the worker's actual disconnect event without relying on
  // Windows' parent-side synchronous child.disconnect() implementation.
  await f.send({ command: 'disconnect_fixture' });
  const result = await f.waitFor(record => record.type === 'probe' && record.id === 'after_disconnect');
  assert.equal(result.allowed, false);
  assert.equal(result.entryAllowed, false);
  await f.exit();
});
