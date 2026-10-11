import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { TestnetClient, TESTNET_ORIGIN, readConfig, loadMarket, strategySignal, marketQuantity, initialState, runCycle, settleOrder } from '../lib/testnet-bot.mjs';

const config = readConfig({ TESTNET_FAST_PERIOD: '3', TESTNET_SLOW_PERIOD: '5' });
const serverTime = 1_800_000_000_000;
const candles = [10, 10, 10, 10, 10, 11].map((close, index) => ({
  time: serverTime - (6 - index) * config.intervalMs, close,
  closeTime: serverTime - (5 - index) * config.intervalMs - 1
}));
const symbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'],
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5.00000000', applyToMarket: true }
  ]
};
const rows = candles.map(c => [c.time, '10', '12', '9', String(c.close), '1', c.closeTime]);
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('production configuration, unsupported market, and invalid risk limits fail closed', () => {
  for (const env of [
    { BINANCE_BASE_URL: 'https://api.binance.com' }, { BINANCE_API_KEY: 'production-key' },
    { BINANCE_API_SECRET: 'production-secret' }, { TESTNET_SYMBOL: 'UNKNOWN' },
    { TESTNET_FAST_PERIOD: '30', TESTNET_SLOW_PERIOD: '20' }, { TESTNET_TRADE_USDT: '10000' }
  ]) assert.throws(() => readConfig(env));
});

test('client allows only hardcoded Testnet routes and requires explicit virtual order enablement', async () => {
  let calls = 0;
  const client = new TestnetClient({ fetchImpl: async url => {
    calls++; assert.equal(url.origin, TESTNET_ORIGIN); return response({ serverTime });
  } });
  await assert.rejects(client.request('GET', 'https://api.binance.com/api/v3/time'));
  await assert.rejects(client.request('POST', '/api/v3/order'));
  await assert.rejects(client.request('GET', '/sapi/v1/asset/transfer'));
  await client.request('GET', '/api/v3/time');
  assert.equal(calls, 1);
});

test('HMAC signatures cover encoded params, without sending the secret', async () => {
  const secret = 'unit-test-secret';
  const client = new TestnetClient({ apiKey: 'unit-key', apiSecret: secret, fetchImpl: async (url, options) => {
    const query = new URLSearchParams(url.search);
    const signature = query.get('signature'); query.delete('signature');
    assert.equal(signature, createHmac('sha256', secret).update(query.toString()).digest('hex'));
    assert.equal(options.headers['X-MBX-APIKEY'], 'unit-key');
    assert.equal(options.redirect, 'error');
    assert.equal(url.toString().includes(secret), false);
    return response({ balances: [] });
  } });
  await client.request('GET', '/api/v3/account', {}, true);
});

test('Ed25519 signed form requests have a verifiable URL-encoded signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const client = new TestnetClient({ apiKey: 'unit-key', privateKey, fetchImpl: async (url, options) => {
    assert.equal(url.origin, TESTNET_ORIGIN);
    const query = new URLSearchParams(options.body);
    const signature = Buffer.from(query.get('signature'), 'base64'); query.delete('signature');
    assert.equal(verify(null, Buffer.from(query.toString()), publicKey, signature), true);
    return response({});
  } });
  await client.request('POST', '/api/v3/order/test', { symbol: 'BTCUSDT', side: 'BUY' }, true);
});

test('missing/conflicting signers are refused; network errors do not expose credentials or retry', async () => {
  await assert.rejects(new TestnetClient().request('GET', '/api/v3/account', {}, true));
  const { privateKey } = generateKeyPairSync('ed25519');
  await assert.rejects(new TestnetClient({ apiKey: 'key', apiSecret: 'secret', privateKey }).request('GET', '/api/v3/account', {}, true));
  let calls = 0;
  const client = new TestnetClient({ apiKey: 'secret-key', apiSecret: 'secret-value', fetchImpl: async () => {
    calls++; throw new Error('secret-key secret-value');
  } });
  await assert.rejects(client.request('GET', '/api/v3/account', {}, true), error => !error.message.includes('secret-'));
  assert.equal(calls, 1);
});

test('location refusal is identified; raw server message is not leaked', async () => {
  const client = new TestnetClient({ fetchImpl: async () => response({ code: 0, msg: 'sensitive detail' }, 451) });
  await assert.rejects(client.request('GET', '/api/v3/time'), error => error.status === 451 && !error.message.includes('sensitive'));
});

test('market signals use only closed candles and reject gaps, stale data, and bad prices', async () => {
  const openRow = [serverTime, '10', '12', '9', '999', '1', serverTime + config.intervalMs - 1];
  const client = raw => ({ syncTime: async () => serverTime, request: async () => raw });
  assert.equal((await loadMarket(client([...rows, openRow]), config)).at(-1).close, 11);
  const invalid = [
    rows.slice(0, 4), rows.map(row => [...row.slice(0, 4), 'NaN', ...row.slice(5)]),
    rows.map(row => [row[0] - config.intervalMs * 10, ...row.slice(1, 6), row[6] - config.intervalMs * 10]),
    rows.map((row, index) => index === 3 ? [row[0] + 1, ...row.slice(1)] : row)
  ];
  for (const raw of invalid) await assert.rejects(loadMarket(client(raw), config));
});

test('SMA entry, exit thresholds, and duplicate closed candle protection', () => {
  const state = initialState(config, 'unit-key');
  assert.equal(strategySignal(candles, config, state, 11).side, 'BUY');
  state.position = { quantity: 1, entryPrice: 11 };
  assert.equal(strategySignal(candles, config, state, 10).reason, '止损');
  assert.equal(strategySignal(candles, config, state, 12).reason, '止盈');
  state.lastCandle = candles.at(-1).time;
  assert.equal(strategySignal(candles, config, state, 12).side, null);
});

test('market quantity floors precisely, obeys all steps, and rejects minimum/maximum violations', () => {
  assert.equal(marketQuantity('0.00123456', 100000, symbolInfo), '0.00123000');
  assert.equal(marketQuantity(0.001239999, 100000, symbolInfo), '0.00123000');
  assert.throws(() => marketQuantity('0.00001', 100000, symbolInfo));
  assert.throws(() => marketQuantity('1001', 100000, symbolInfo));
  assert.throws(() => marketQuantity(NaN, 100000, symbolInfo));
  const mixedSteps = { ...symbolInfo, filters: [
    { filterType: 'LOT_SIZE', minQty: '0', maxQty: '1000', stepSize: '0.02' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '1000', stepSize: '0.03' }
  ] };
  assert.equal(marketQuantity('0.31', 100, mixedSteps), '0.30000000');
});

function mockExchange({ loseResponse = false, missingOrder = false } = {}) {
  const calls = [];
  let submitted;
  const order = () => ({ symbol: 'BTCUSDT', side: 'BUY', clientOrderId: submitted.newClientOrderId, orderId: 77, status: 'FILLED', executedQty: submitted.quantity, cummulativeQuoteQty: '100', transactTime: serverTime });
  return {
    calls, syncTime: async () => serverTime,
    request: async (method, path, params) => {
      calls.push({ method, path });
      if (path === '/api/v3/klines') return rows;
      if (path === '/api/v3/exchangeInfo') return { symbols: [symbolInfo] };
      if (path === '/api/v3/ticker/price') return { price: '100000' };
      if (path === '/api/v3/account') return { canTrade: true, balances: [{ asset: 'USDT', free: '10000' }] };
      if (path === '/api/v3/order' && method === 'POST') {
        submitted = params;
        if (loseResponse) throw new Error('response lost');
        return order();
      }
      if (path === '/api/v3/order' && method === 'GET') {
        if (missingOrder) throw Object.assign(new Error('unknown order; manual verification needed'), { code: -2013 });
        return order();
      }
      if (path === '/api/v3/myTrades') return [{ orderId: 77, qty: submitted.quantity, commissionAsset: 'BTC', commission: '0.000001' }];
      throw new Error('unexpected route');
    }
  };
}

test('preview creates no order, writes no state, and never queries account balances', async () => {
  const exchange = mockExchange(); const state = initialState(config, 'unit-key');
  const result = await runCycle(exchange, config, state, () => assert.fail('preview persisted'), false);
  assert.equal(result.side, 'BUY'); assert.equal(state.pending, null);
  assert.equal(exchange.calls.some(call => call.method === 'POST' || call.path === '/api/v3/account'), false);
});

test('pending is durable before POST and response loss reconciles without resubmitting', async () => {
  const exchange = mockExchange({ loseResponse: true }); const state = initialState(config, 'unit-key');
  const snapshots = []; const persist = async value => snapshots.push(structuredClone(value));
  await assert.rejects(runCycle(exchange, config, state, persist, true));
  assert.ok(snapshots[0].pending); assert.ok(state.pending);
  const result = await runCycle(exchange, config, state, persist, true);
  assert.equal(result.orderId, 77); assert.equal(state.pending, null);
  assert.equal(state.position.quantity, 0.001 - 0.000001);
  await runCycle(exchange, config, state, persist, true);
  assert.equal(exchange.calls.filter(call => call.method === 'POST').length, 1);
});

test('unknown pending order halts without retry or clearing recovery state', async () => {
  const exchange = mockExchange({ loseResponse: true, missingOrder: true }); const state = initialState(config, 'unit-key');
  await assert.rejects(runCycle(exchange, config, state, async () => {}, true));
  await assert.rejects(runCycle(exchange, config, state, async () => {}, true));
  assert.ok(state.pending);
  assert.equal(exchange.calls.filter(call => call.method === 'POST').length, 1);
});

test('pending preview is read-only; failed persistence prevents submitting', async () => {
  const exchange = mockExchange({ loseResponse: true }); const state = initialState(config, 'unit-key');
  await assert.rejects(runCycle(exchange, config, state, async () => {}, true));
  const snapshot = structuredClone(state);
  await runCycle(exchange, config, state, () => assert.fail('preview persisted'), false);
  assert.deepEqual(state, snapshot);
  const second = mockExchange();
  await assert.rejects(runCycle(second, config, initialState(config, 'unit-key'), async () => { throw new Error('disk full'); }, true));
  assert.equal(second.calls.some(call => call.method === 'POST'), false);
});

test('settlement rejects mismatched, unfinished, or incompletely reported orders', async () => {
  const state = initialState(config, 'unit-key');
  const pending = { side: 'BUY', clientOrderId: 'quant-test', candle: 1 };
  const order = { symbol: 'BTCUSDT', side: 'BUY', clientOrderId: 'quant-test', orderId: 77, status: 'FILLED', executedQty: '0.001', cummulativeQuoteQty: '100' };
  const client = { request: async () => [] };
  for (const patch of [{ symbol: 'ETHUSDT' }, { side: 'SELL' }, { clientOrderId: 'other' }, { status: 'NEW' }, { executedQty: 'NaN' }, {}]) {
    await assert.rejects(settleOrder(client, state, pending, { ...order, ...patch }, 'BTC'));
  }
});

test('sell settlement consumes only the bot-owned position, including base-asset fees', async () => {
  const state = initialState(config, 'unit-key'); state.position = { quantity: 0.001, entryPrice: 100000 };
  const pending = { side: 'SELL', clientOrderId: 'quant-sell', candle: 1 };
  const order = { symbol: 'BTCUSDT', side: 'SELL', clientOrderId: 'quant-sell', orderId: 78, status: 'FILLED', executedQty: '0.000999', cummulativeQuoteQty: '99.9' };
  const client = { request: async () => [{ orderId: 78, qty: '0.000999', commissionAsset: 'BTC', commission: '0.000001' }] };
  await settleOrder(client, state, pending, order, 'BTC');
  assert.equal(state.position, null); assert.equal(state.lastCandle, 1);
});
