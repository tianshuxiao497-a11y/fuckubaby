import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createController } from './controller.mjs';
import { initialState, readConfig } from '../../lib/testnet-bot.mjs';
import { policyEnvironment } from '../../lib/virtual-trading-policy.mjs';
import { testLicense } from './test-license-fixture.mjs';

// All fixtures use fabricated responses and new temporary profiles. This file
// never loads the user's saved credentials, account records, or a network API.
const policy = JSON.parse(await readFile(new URL('../../strategies/virtual-only.json', import.meta.url), 'utf8'));
const config = readConfig(policyEnvironment(policy, {}));
const credentials = { apiKey: 'Q'.repeat(64), apiSecret: 'R'.repeat(64), privateKeyPath: '' };
const consent = { command: 'start', confirmVirtualOnly: true, confirmNoOtherBot: true };

async function fixture() {
  const profile = await mkdtemp(resolve(tmpdir(), 'adaptive-desktop-flow-'));
  const calls = [], children = [], messages = [];
  let readFailure = false;
  const boundary = Math.floor(Date.now() / 60_000) * 60_000;
  const candles = Array.from({ length: 100 }, (_, i) => {
    const time = boundary - (100 - i) * 60_000;
    const close = 60_000 + i;
    return [time, String(close - 1), String(close + 3), String(close - 3), String(close), '12', time + 59_999];
  });
  const controller = await createController({
    profile, policy, env: {}, emit: event => messages.push(event), licenseFactory:testLicense,
    clientFactory: options => ({
      syncTime: async () => { if (readFailure) throw new Error('offline fixture disconnection'); return boundary + 1000; },
      request: async (method, path) => {
        calls.push({ method, path, allowOrders: options.allowOrders });
        assert.equal(method, 'GET', 'the desktop monitor must never submit an order');
        if (path === '/api/v3/klines') return candles;
        if (path === '/api/v3/account') return { canTrade: true, balances: [{ asset: 'USDT', free: '1000', locked: '0' }] };
        if (path === '/api/v3/ticker/price') return { price: '60100' };
        if (path === '/api/v3/myTrades' || path === '/api/v3/openOrders') return [];
        throw new Error('Unexpected fixture endpoint: ' + path);
      }
    }),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.connected = true;
      child.sent = [];
      child.send = message => { child.sent.push(message); return true; };
      children.push(child);
      return child;
    }
  });
  return { controller, profile, calls, children, messages, candles, failReads: () => { readFailure = true; } };
}

test('fresh dashboard local status is honest and never reads account or starts worker', async () => {
  const f = await fixture();
  const local = await f.controller.handle({ command: 'local' });
  assert.equal(local.type, 'local'); assert.equal(local.running, false);
  assert.equal(local.position, null); assert.equal(local.pending, null);
  assert.deepEqual(local.orders, []);
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  await f.controller.disconnect();
});

test('saved account records require matching configure and never imply auto-connect or auto-start', async () => {
  const f = await fixture();
  const saved = initialState(config, credentials.apiKey);
  saved.orders = [{ time: 1, side: 'BUY', executedQty: 0.0005, quoteQty: 30, status: 'FILLED', reason: 'offline fixture' }];
  await writeFile(resolve(f.profile, '.paper-data/testnet-state.json'), JSON.stringify(saved));
  await assert.rejects(f.controller.handle({ command: 'local' }), /记录|account/i);
  assert.equal((await f.controller.handle({ command: 'configure', credentials })).type, 'configured');
  assert.equal((await f.controller.handle({ command: 'local' })).orders.length, 1);
  await assert.rejects(f.controller.handle(consent), /connection/i);
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  await f.controller.disconnect();
});

test('monitor chart data is actual validated closed-price response, GET-only, without credentials', async () => {
  const f = await fixture();
  await f.controller.handle({ command: 'configure', credentials });
  await f.controller.handle({ command: 'connect' });
  const { snapshot } = await f.controller.handle({ command: 'snapshot' });
  assert.equal(snapshot.price, 60100);
  assert.deepEqual(snapshot.candles, f.candles.slice(-60).map(row => ({ time: row[0], close: Number(row[4]) })));
  assert.ok(snapshot.candles.every(point => point.time + 59_999 < Math.floor(Date.now() / 60_000) * 60_000 + 1000));
  assert.equal(snapshot.position, null);
  const output = JSON.stringify(snapshot);
  assert.ok(!output.includes(credentials.apiKey)); assert.ok(!output.includes(credentials.apiSecret));
  assert.ok(f.calls.every(call => call.method === 'GET' && call.allowOrders === false));
  assert.equal(f.children.length, 0);
  await f.controller.disconnect();
});

test('failed monitor refresh clears prior start authorization without auto-retrying or spawning', async () => {
  const f = await fixture();
  await f.controller.handle({ command: 'configure', credentials });
  await f.controller.handle({ command: 'connect' });
  f.failReads();
  await assert.rejects(f.controller.handle({ command: 'snapshot' }), /disconnection/);
  await assert.rejects(f.controller.handle(consent), /connection/i);
  assert.equal(f.children.length, 0);
  await f.controller.disconnect();
});

test('failed replacement credentials invalidate prior connection authorization', async () => {
  const f = await fixture();
  await f.controller.handle({ command: 'configure', credentials });
  await f.controller.handle({ command: 'connect' });
  await assert.rejects(f.controller.handle({ command: 'configure', credentials: { ...credentials, apiKey: 'invalid' } }));
  await assert.rejects(f.controller.handle(consent), /connection/i);
  await assert.rejects(f.controller.handle({ command: 'connect' }), /credentials/i);
  assert.equal(f.children.length, 0);
  await f.controller.disconnect();
});

test('STOP reaches child through sticky IPC, not just a startup-erasable file', async () => {
  const f = await fixture();
  await f.controller.handle({ command: 'configure', credentials });
  await f.controller.handle({ command: 'connect' });
  await f.controller.handle(consent);
  await f.controller.handle({ command: 'stop' });
  assert.ok(f.children[0].sent.some(message => message?.command === 'stop'), 'the child must receive an explicit stop intent that startup cannot erase');
  assert.match(await readFile(resolve(f.profile, '.paper-data/testnet-stop'), 'utf8'), /stop/i);
  f.children[0].emit('close', 0);
  await f.controller.disconnect();
});
