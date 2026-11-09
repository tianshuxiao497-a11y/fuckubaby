import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createController, verifiedAccountUid, verifiedOrderIdentity } from './controller.mjs';
import { initialState, readConfig } from '../../lib/testnet-bot.mjs';
import { policyEnvironment } from '../../lib/virtual-trading-policy.mjs';
import { testLicense } from './test-license-fixture.mjs';

// Fabricated keys/responses and isolated profiles only. No user secrets or network.
const policy = JSON.parse(await readFile(new URL('../../strategies/virtual-only.json', import.meta.url)));
const config = readConfig(policyEnvironment(policy, {}));
const old = { apiKey: 'A'.repeat(64), apiSecret: 'B'.repeat(64), privateKeyPath: '' };
const next = { apiKey: 'C'.repeat(64), apiSecret: 'D'.repeat(64), privateKeyPath: '' };
const privateOrder = { symbol: config.symbol, orderId: 123, clientOrderId: 'quant-private-order-fixture', time: 1790000000000,
  side: 'BUY', status: 'FILLED', origQty: '0.00100000', executedQty: '0.00100000' };
async function fixture({ oldUid = '123456', nextUid = '123456', pending = false, failedKey = null, waitOnNew = false, wrongOrderProof = false, missingOrder = false } = {}) {
  const profile = await mkdtemp(resolve(tmpdir(), 'asb-key-rotation-'));
  const calls = [], events = []; let release, newRead;
  const newStarted = new Promise(r => { newRead = r; });
  const controller = await createController({ profile, policy, emit: x => events.push(x), licenseFactory: testLicense,
    spawnImpl: () => { throw new Error('Rotation must not launch a worker'); },
    clientFactory: options => ({ syncTime: async () => {}, request: async (method, path) => {
      calls.push({ method, path, key: options.apiKey, allowOrders: options.allowOrders });
      assert.equal(method, 'GET'); assert.ok(['/api/v3/account', '/api/v3/order'].includes(path)); assert.equal(options.allowOrders, false);
      if (options.apiKey === failedKey) throw new Error('Fixture network/signature error');
      if (path === '/api/v3/order') {
        if (missingOrder) throw new Error('Historical private order is unavailable');
        return { ...privateOrder, ...(wrongOrderProof && options.apiKey === next.apiKey ? { clientOrderId: 'quant-another-private-account' } : {}) };
      }
      if (waitOnNew && options.apiKey === next.apiKey) { newRead(); await new Promise(r => { release = r; }); }
      return { uid: options.apiKey === old.apiKey ? oldUid : nextUid, canTrade: true, balances: [] };
    } })
  });
  const saved = { ...initialState(config, old.apiKey),
    orders: [{ orderId: 123, side: 'BUY', status: 'FILLED', executedQty: 0.001, quoteQty: 60 }],
    dailyRisk: { dayUtc: '2026-11-06', realizedUsdt: -2, consecutiveLosses: 2 },
    position: { quantity: 0.001, entryPrice: 60000, openedAt: 1790000000000 },
    ...(pending ? { pending: { side: 'SELL', clientOrderId: 'pending-fixture' } } : {}) };
  const statePath = resolve(profile, '.paper-data/testnet-state.json');
  await writeFile(statePath, JSON.stringify(saved));
  await writeFile(resolve(profile, 'credentials.dpapi'), 'encrypted-fixture-only');
  await controller.handle({ command: 'configure', credentials: old });
  return { controller, profile, statePath, saved, calls, events, newStarted, release: () => release?.() };
}
const rotate = () => ({ command: 'rotateCredentials', credentials: next, confirmSameTestnetAccount: true });
async function unchanged(f) { assert.deepEqual(JSON.parse(await readFile(f.statePath)), f.saved); }

test('UID comparison refuses absent, unsafe or malformed identity', () => {
  for (const uid of [undefined, null, 0, -1, NaN, 9007199254740992, '', '00123', 'x', {}, '1'.repeat(21)]) assert.equal(verifiedAccountUid({ uid }), null);
  assert.equal(verifiedAccountUid({ uid: 123456 }), '123456');
  assert.equal(verifiedAccountUid({ uid: '123456' }), '123456');
});

test('changing a key first requires explicit choice and never creates a fresh history', async () => {
  const f = await fixture();
  await assert.rejects(f.controller.handle({ command: 'configure', credentials: next }), e => e.code === 'ACCOUNT_KEY_CHANGED');
  await assert.rejects(f.controller.handle({ ...rotate(), confirmSameTestnetAccount: false }), /明确确认/);
  assert.equal(f.calls.length, 0); await unchanged(f);
  await f.controller.disconnect();
});

test('verified rotation preserves all history, position and risk; creates exact backups and requires reconnect', async () => {
  const f = await fixture();
  const result = await f.controller.handle(rotate());
  assert.equal(result.type, 'configured'); assert.equal(result.accountRebound, true);
  assert.deepEqual(JSON.parse(await readFile(f.statePath)), { ...f.saved, accountTag: initialState(config, next.apiKey).accountTag });
  assert.deepEqual(JSON.parse(await readFile(resolve(result.backupPath, 'testnet-state.json'))), f.saved);
  assert.equal(await readFile(resolve(result.backupPath, 'credentials.dpapi'), 'utf8'), 'encrypted-fixture-only');
  assert.equal((await f.controller.handle({ command: 'local' })).orders.length, 1);
  await assert.rejects(f.controller.handle({ command: 'start', confirmVirtualOnly: true, confirmNoOtherBot: true }), /connection/);
  assert.equal(f.calls.length, 2);
  assert.ok(!(await readdir(resolve(f.profile, '.paper-data'))).includes('testnet-bot.lock'));
  const output = JSON.stringify([result, ...f.events]);
  for (const value of [old.apiKey, next.apiKey, old.apiSecret, next.apiSecret, '123456']) assert.ok(!output.includes(value));
  await f.controller.disconnect();
});

test('different UID, missing UID and failed new signature/network retain original state and never reconnect old client', async () => {
  for (const options of [{ nextUid: '999' }, { nextUid: null, oldUid: null, wrongOrderProof: true }, { failedKey: next.apiKey }]) {
    const f = await fixture(options);
    await assert.rejects(f.controller.handle(rotate())); await unchanged(f);
    await assert.rejects(f.controller.handle({ command: 'connect' }), /credentials/);
    await f.controller.disconnect();
  }
});

test('Testnet without uid requires matching authenticated private historical order, not identical balances', async () => {
  const f = await fixture({ oldUid: null, nextUid: null });
  const result = await f.controller.handle(rotate());
  assert.equal(result.accountRebound, true);
  assert.equal(f.calls.filter(x => x.path === '/api/v3/order').length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.statePath)), { ...f.saved, accountTag: initialState(config, next.apiKey).accountTag });
  await f.controller.disconnect();
  const g = await fixture({ oldUid: null, nextUid: null, missingOrder: true });
  await assert.rejects(g.controller.handle(rotate()), /unavailable/); await unchanged(g);
  await g.controller.disconnect();
});

test('cached authenticated order proof permits rotation after the old API is revoked', async () => {
  const f = await fixture({ oldUid: null, nextUid: null, failedKey: old.apiKey });
  await writeFile(resolve(f.profile, '.paper-data/testnet-account-identity.json'), JSON.stringify({ version: 1, accountTag: f.saved.accountTag,
    uid: null, orderProof: verifiedOrderIdentity(privateOrder, config.symbol, 123) }));
  assert.equal((await f.controller.handle(rotate())).accountRebound, true);
  assert.ok(f.calls.every(x => x.key === next.apiKey));
  await f.controller.disconnect();
});

test('unresolved order and existing lock prevent rotation and preserve the original lock', async () => {
  const f = await fixture({ pending: true });
  await assert.rejects(f.controller.handle(rotate()), /待核对/); await unchanged(f);
  const g = await fixture();
  const lock = resolve(g.profile, '.paper-data/testnet-bot.lock'); await writeFile(lock, 'external-lock');
  await assert.rejects(g.controller.handle(rotate()), /交易锁/);
  assert.equal(await readFile(lock, 'utf8'), 'external-lock'); await unchanged(g);
  assert.equal(f.calls.length + g.calls.length, 0);
  await f.controller.disconnect(); await g.controller.disconnect();
});

test('cached identity from a successful old-account connection permits verified replacement of a revoked old key', async () => {
  const f = await fixture({ failedKey: old.apiKey });
  await writeFile(resolve(f.profile, '.paper-data/testnet-account-identity.json'), JSON.stringify({ version: 1, accountTag: f.saved.accountTag, uid: '123456' }));
  const result = await f.controller.handle(rotate());
  assert.equal(result.accountRebound, true); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].key, next.apiKey);
  await f.controller.disconnect();
});

test('STOP during online identity verification cancels migration with history intact', async () => {
  const f = await fixture({ waitOnNew: true });
  const operation = f.controller.handle(rotate());
  await f.newStarted; await f.controller.handle({ command: 'stop' }); f.release();
  await assert.rejects(operation, /cancelled/); await unchanged(f);
  await f.controller.disconnect();
});

test('ordinary successful read-only connection caches UID without rewriting trading state', async () => {
  const f = await fixture();
  await f.controller.handle({ command: 'connect' }); await unchanged(f);
  const identity = JSON.parse(await readFile(resolve(f.profile, '.paper-data/testnet-account-identity.json')));
  assert.equal(identity.uid, '123456'); assert.equal(identity.accountTag, f.saved.accountTag);
  await f.controller.disconnect();
});
