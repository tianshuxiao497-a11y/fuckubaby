import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, readConfig, readOnlyRecoveryDelay, runCycle } from '../lib/testnet-bot.mjs';
import { finishTestnetRunner } from '../lib/testnet-runner-lifecycle.mjs';

// Synthetic account and exchange only. No environment, private files, network,
// real runner process, or exchange account is accessed by this test suite.
const config = readConfig({ TESTNET_FAST_PERIOD: '3', TESTNET_SLOW_PERIOD: '5' });
const serverTime = 1_800_000_000_000;
const rows = [10, 10, 10, 10, 10, 11].map((close, index) => [
  serverTime - (6 - index) * config.intervalMs, '10', '12', '9', String(close), '1',
  serverTime - (5 - index) * config.intervalMs - 1
]);
const symbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'], quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5.00000000', applyToMarket: true }
  ]
};
const diskFailure = () => Object.assign(new Error('synthetic state replacement failed'), { code: 'EPERM' });

function syntheticExchange() {
  let submitted;
  const calls = [];
  const order = () => ({
    symbol: 'BTCUSDT', side: 'BUY', clientOrderId: submitted.newClientOrderId,
    orderId: 99001, status: 'FILLED', executedQty: '0.00100000',
    cummulativeQuoteQty: '100.00000000', transactTime: serverTime
  });
  return {
    calls,
    syncTime: async () => serverTime,
    request: async (method, path, params) => {
      calls.push({ method, path, params: structuredClone(params) });
      if (path === '/api/v3/klines') return rows;
      if (path === '/api/v3/exchangeInfo') return { symbols: [symbolInfo] };
      if (path === '/api/v3/ticker/price') return { price: '100000' };
      if (path === '/api/v3/account') return { canTrade: true, balances: [{ asset: 'USDT', free: '10000' }] };
      if (path === '/api/v3/order' && method === 'POST') {
        submitted = structuredClone(params);
        return order();
      }
      if (path === '/api/v3/order' && method === 'GET') {
        assert.ok(submitted, 'reconciliation must refer to the already-submitted synthetic order');
        assert.equal(params.origClientOrderId, submitted.newClientOrderId);
        return order();
      }
      if (path === '/api/v3/myTrades') return [{ orderId: 99001, qty: '0.00100000', commissionAsset: 'BTC', commission: '0' }];
      assert.fail(`Unexpected synthetic exchange call: ${method} ${path}`);
    }
  };
}

test('state persistence failure before POST leaves the canonical snapshot unchanged and submits nothing', async () => {
  const client = syntheticExchange();
  const state = initialState(config, 'synthetic-persistence-key');
  const canonical = structuredClone(state);
  const error = diskFailure();
  await assert.rejects(runCycle(client, config, state, async () => { throw error; }, true), value => value === error);
  assert.ok(state.pending, 'the in-memory intent is retained for diagnostic context');
  assert.equal(canonical.pending, null, 'the last successful canonical snapshot was never replaced');
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
});

test('post-settlement persistence failure recovers from the durable intent without a second POST', async () => {
  const client = syntheticExchange();
  const state = initialState(config, 'synthetic-persistence-key');
  let durable;
  let writes = 0;
  const error = diskFailure();
  await assert.rejects(runCycle(client, config, state, async value => {
    if (++writes > 1) throw error;
    durable = structuredClone(value);
  }, true), value => value === error);
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(durable.pending, 'POST was preceded by successfully committed intent');
  assert.equal(durable.position, null);
  assert.equal(state.pending, null, 'settlement may already have updated only the failed process memory');
  assert.equal(state.position.quantity, 0.001);

  // A fatal write error must end the process; restart reads the canonical
  // intent, not the already-settled in-memory state that could submit anew.
  const restarted = structuredClone(durable);
  await runCycle(client, config, restarted, async value => { durable = structuredClone(value); }, true);
  assert.equal(restarted.pending, null);
  assert.equal(restarted.position.quantity, 0.001);
  assert.equal(restarted.orders.length, 1);
  assert.equal(restarted.orders[0].orderId, 99001);
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'GET' && call.path === '/api/v3/order').length, 1);
  assert.deepEqual(durable, restarted);
});

test('a failed reconciliation commit retains the durable intent and can be safely queried on a later restart', async () => {
  const client = syntheticExchange();
  let durable;
  await assert.rejects(runCycle(client, config, initialState(config, 'synthetic-persistence-key'), async value => {
    if (!durable) durable = structuredClone(value);
    else throw diskFailure();
  }, true));
  const savedIntent = structuredClone(durable);
  await assert.rejects(runCycle(client, config, structuredClone(durable), async () => { throw diskFailure(); }, true));
  assert.deepEqual(durable, savedIntent);
  const restarted = structuredClone(durable);
  await runCycle(client, config, restarted, async value => { durable = structuredClone(value); }, true);
  assert.equal(restarted.pending, null);
  assert.equal(restarted.orders.length, 1);
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'GET' && call.path === '/api/v3/order').length, 2);
});

test('file-system errors never qualify for automatic read-only network recovery', () => {
  for (const strategy of ['fast', 'cycle', 'tactical', 'adaptive']) {
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'EIO']) {
      const error = Object.assign(new Error('synthetic file-system failure'), { code });
      assert.equal(readOnlyRecoveryDelay(error, { ...config, strategy }, { pending: null }, 1), null);
      assert.equal(readOnlyRecoveryDelay(error, { ...config, strategy }, { pending: { clientOrderId: 'synthetic' } }, 1), null);
    }
  }
});

function cleanupFixture({ owner = '43210\n', publishError, closeError, readError, unlinkError } = {}) {
  const calls = [];
  const lockPath = 'synthetic-lock-only';
  return {
    calls,
    args: {
      pid: 43210, lockPath, status: 'error', result: { action: 'synthetic primary state error' },
      publishActivity: async (status, result) => {
        calls.push(['publish', status, result]);
        if (publishError) throw publishError;
      },
      lock: { close: async () => {
        calls.push(['close']);
        if (closeError) throw closeError;
      } }
    },
    options: { fs: {
      readFile: async (path, encoding) => {
        assert.equal(path, lockPath); assert.equal(encoding, 'utf8');
        calls.push(['read']);
        if (readError) throw readError;
        return owner;
      },
      unlink: async path => {
        assert.equal(path, lockPath); calls.push(['unlink']);
        if (unlinkError) throw unlinkError;
      }
    } }
  };
}

test('heartbeat cleanup failure still closes and removes only the owned lock', async () => {
  const primary = diskFailure();
  const heartbeatError = Object.assign(new Error('synthetic heartbeat failure'), { code: 'EPERM' });
  const { args, options, calls } = cleanupFixture({ publishError: heartbeatError });
  const errors = await finishTestnetRunner(args, options);
  assert.deepEqual(errors, [heartbeatError]);
  assert.deepEqual(calls.map(call => call[0]), ['publish', 'close', 'read', 'unlink']);
  assert.equal(primary.code, 'EPERM');
  assert.equal(primary.message, 'synthetic state replacement failed', 'cleanup does not replace the original failure');
});

test('failed lock close retains the lock and skips ownership read/unlink', async () => {
  const closeError = new Error('synthetic close failure');
  const { args, options, calls } = cleanupFixture({ closeError });
  assert.deepEqual(await finishTestnetRunner(args, options), [closeError]);
  assert.deepEqual(calls.map(call => call[0]), ['publish', 'close']);
});

test('a foreign or empty lock is never removed after closing the old handle', async () => {
  for (const owner of ['43211', '', 'not-a-pid']) {
    const { args, options, calls } = cleanupFixture({ owner });
    const errors = await finishTestnetRunner(args, options);
    assert.equal(errors.length, 1); assert.equal(errors[0].code, 'TESTNET_LOCK_OWNERSHIP');
    assert.deepEqual(calls.map(call => call[0]), ['publish', 'close', 'read']);
  }
});

test('cleanup ignores missing lock paths but reports other read/unlink failures', async () => {
  for (const operation of ['readError', 'unlinkError']) {
    const missing = Object.assign(new Error('synthetic missing lock'), { code: 'ENOENT' });
    const absent = cleanupFixture({ [operation]: missing });
    assert.deepEqual(await finishTestnetRunner(absent.args, absent.options), []);
    const denied = Object.assign(new Error('synthetic denied lock access'), { code: 'EACCES' });
    const failing = cleanupFixture({ [operation]: denied });
    assert.deepEqual(await finishTestnetRunner(failing.args, failing.options), [denied]);
  }
});

test('all independent cleanup failures are secondary diagnostics and never throw', async () => {
  const publishError = new Error('synthetic heartbeat failure');
  const closeError = new Error('synthetic close failure');
  const { args, options, calls } = cleanupFixture({ publishError, closeError });
  assert.deepEqual(await finishTestnetRunner(args, options), [publishError, closeError]);
  assert.deepEqual(calls.map(call => call[0]), ['publish', 'close']);
});
