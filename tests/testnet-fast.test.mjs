import test from 'node:test';
import assert from 'node:assert/strict';
import { TestnetClient, readConfig, initialState, strategySignal, signalIndicators, marketQuantity, adoptStrategyState, readOnlyRecoveryDelay, runCycle } from '../lib/testnet-bot.mjs';

const config = readConfig({ TESTNET_STRATEGY: 'fast' });
const now = 1_800_000_000_000;
const makeCandles = closes => closes.map((close, index) => ({
  time: now - (closes.length - index) * 60_000,
  close, closeTime: now - (closes.length - index - 1) * 60_000 - 1
}));
const up = makeCandles([100000, 100000, 100000, 100000, 100000, 100000, 100000, 100001]);
const down = makeCandles([100000, 100000, 100000, 100000, 100000, 100000, 100000, 99999]);
const position = { quantity: 0.0012, entryPrice: 100000, openedAt: now - 20_000 };
const symbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'], quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true }
  ]
};

test('fast profile has bounded one-minute defaults and rejects unsafe overrides', () => {
  assert.equal(config.interval, '1m'); assert.equal(config.fast, 3); assert.equal(config.slow, 7);
  assert.equal(config.pollSeconds, 10); assert.equal(config.tradeUsdt, 100);
  assert.equal(config.stopLoss, 0.2); assert.equal(config.takeProfit, 0.3);
  assert.equal(config.maxHoldMinutes, 10); assert.equal(config.cooldownSeconds, 60); assert.equal(config.maxBuysPerHour, 6);
  for (const patch of [{ TESTNET_INTERVAL: '5m' }, { TESTNET_POLL_SECONDS: '1' }, { TESTNET_TRADE_USDT: '101' }, { TESTNET_COOLDOWN_SECONDS: '0' }, { TESTNET_MAX_BUYS_PER_HOUR: '7' }]) {
    assert.throws(() => readConfig({ TESTNET_STRATEGY: 'fast', ...patch }));
  }
  assert.throws(() => readConfig({ TESTNET_STRATEGY: 'random' }));
});

test('fast exits check price even on an already processed closed candle, including exact thresholds', () => {
  const state = { ...initialState(config, 'key'), position, lastCandle: up.at(-1).time };
  assert.equal(strategySignal(up, config, state, 99800, now).reason, '止损');
  assert.equal(strategySignal(up, config, state, 100300, now).reason, '止盈');
  assert.equal(strategySignal(up, config, state, 100000, now).side, null);
  assert.equal(strategySignal(up, { ...config, strategy: 'classic' }, state, 99800, now).side, null);
});

test('fast holding timeout is checked without waiting for the next candle; missing actual entry time fails closed', () => {
  const state = { ...initialState(config, 'key'), position: { ...position, openedAt: now - 600_000 }, lastCandle: up.at(-1).time };
  assert.equal(strategySignal(up, config, state, 100000, now).reason, '最长持仓时间退出');
  state.position.openedAt = undefined;
  assert.throws(() => strategySignal(up, config, state, 100000, now));
});

test('fast crossover entry and exit are still once per closed minute, with matching visible indicators', () => {
  const state = initialState(config, 'key');
  assert.equal(strategySignal(up, config, state, 100001, now).side, 'BUY');
  state.lastCandle = up.at(-1).time;
  assert.equal(strategySignal(up, config, state, 100001, now).side, null);
  state.position = position; state.lastCandle = null;
  assert.equal(strategySignal(down, config, state, 99999, now).reason, '均线下穿');
  state.lastCandle = down.at(-1).time;
  assert.equal(strategySignal(down, config, state, 99999, now).side, null);
  const values = signalIndicators(up, config);
  assert.ok(values.fast > values.slow); assert.equal(values.previousFast, values.previousSlow);
});

test('cooldown applies after either side and rolling buy cap never blocks exits', () => {
  const state = initialState(config, 'key');
  for (const side of ['BUY', 'SELL']) {
    state.orders = [{ side, time: now - 30_000 }];
    assert.equal(strategySignal(up, config, state, 100001, now).reason, '买入冷却期');
  }
  state.orders = Array.from({ length: 6 }, (_, i) => ({ side: 'BUY', time: now - (i + 2) * 60_000 }));
  assert.equal(strategySignal(up, config, state, 100001, now).reason, '已达每小时买入上限');
  state.position = position; state.lastCandle = up.at(-1).time;
  assert.equal(strategySignal(up, config, state, 99800, now).side, 'SELL');
  state.position = null; state.orders = [{ side: 'BUY', time: now - 3_600_001 }]; state.lastCandle = null;
  assert.equal(strategySignal(up, config, state, 100001, now).side, 'BUY');
});

test('quantity flooring does not create a false lot-sized remainder from exact decimal holdings', () => {
  assert.equal(marketQuantity(0.0012, 100000, symbolInfo), '0.00120000');
  assert.equal(marketQuantity(0.001199999999, 100000, symbolInfo), '0.00119000');
  assert.equal(marketQuantity(1e-5, 1000000, symbolInfo), '0.00001000');
  assert.throws(() => marketQuantity(Infinity, 100000, symbolInfo));
});

test('explicit strategy adoption keeps actual position, entry time and orders, clears only candle dedup', () => {
  const classic = readConfig();
  const saved = { ...initialState(classic, 'key'), position, lastCandle: 123, orders: [{ orderId: 1, side: 'BUY', time: now - 600_000 }] };
  const before = structuredClone(saved);
  const adopted = adoptStrategyState(saved, config, 'key', now);
  assert.equal(adopted.interval, '1m'); assert.equal(adopted.strategy, 'fast'); assert.equal(adopted.lastCandle, null);
  assert.deepEqual(adopted.position, saved.position); assert.deepEqual(adopted.orders, saved.orders);
  assert.equal(adopted.strategyChangedAt, now); assert.deepEqual(saved, before);
  for (const patch of [{ pending: { clientOrderId: 'unresolved' } }, { accountTag: 'other' }, { symbol: 'ETHUSDT' }, { mode: 'LIVE' }, { position: { ...position, openedAt: undefined } }]) {
    assert.throws(() => adoptStrategyState({ ...saved, ...patch }, config, 'key', now));
  }
});

function exchange({ loseResponse = false, price = 99700 } = {}) {
  const calls = []; let submitted;
  const order = () => ({ symbol: 'BTCUSDT', side: submitted.side, clientOrderId: submitted.newClientOrderId, orderId: 99, status: 'FILLED', executedQty: submitted.quantity || '0.001', cummulativeQuoteQty: String(Number(submitted.quantity || 0.001) * price), transactTime: now });
  return {
    calls, syncTime: async () => now,
    request: async (method, path, params) => {
      calls.push({ method, path, params });
      if (path.endsWith('/klines')) return up.map(c => [c.time, '1', '1', '1', String(c.close), '1', c.closeTime]);
      if (path.endsWith('/exchangeInfo')) return { symbols: [symbolInfo] };
      if (path.endsWith('/price')) return { price: String(price) };
      if (path.endsWith('/account')) return { canTrade: true, balances: [{ asset: 'BTC', free: '1.0012' }, { asset: 'USDT', free: '10000' }] };
      if (path.endsWith('/order') && method === 'POST') { submitted = params; if (loseResponse) throw new Error('response lost'); return order(); }
      if (path.endsWith('/order')) return order();
      if (path.endsWith('/myTrades')) return [{ orderId: 99, qty: submitted.quantity || '0.001', commissionAsset: 'BTC', commission: '0' }];
      throw new Error('unexpected request');
    }
  };
}

test('fast sell during the same candle sells only bot-owned BTC, persists before POST, then cannot repeat', async () => {
  const client = exchange(); const state = { ...initialState(config, 'key'), position, lastCandle: up.at(-1).time };
  const snapshots = [];
  await runCycle(client, config, state, async s => snapshots.push(structuredClone(s)), true, { now });
  assert.equal(snapshots[0].pending.side, 'SELL');
  assert.equal(client.calls.find(c => c.method === 'POST').params.quantity, '0.00120000');
  assert.equal(state.position, null); assert.equal(state.pending, null);
  await runCycle(client, config, state, async () => {}, true, { now });
  assert.equal(client.calls.filter(c => c.method === 'POST').length, 1);
});

test('fast exit response loss retains pending and reconciles without a second POST', async () => {
  const client = exchange({ loseResponse: true }); const state = { ...initialState(config, 'key'), position, lastCandle: up.at(-1).time };
  await assert.rejects(runCycle(client, config, state, async () => {}, true, { now }));
  assert.ok(state.pending);
  await runCycle(client, config, state, async () => {}, true, { now });
  assert.equal(state.position, null); assert.equal(state.pending, null);
  assert.equal(client.calls.filter(c => c.method === 'POST').length, 1);
});

test('fast preview is read-only even for an immediate holding timeout', async () => {
  const client = exchange({ price: 100000 });
  const state = { ...initialState(config, 'key'), position: { ...position, openedAt: now - 600_000 }, lastCandle: up.at(-1).time };
  const before = structuredClone(state);
  const result = await runCycle(client, config, state, () => assert.fail('preview persisted'), false, { now });
  assert.equal(result.side, 'SELL'); assert.equal(result.reason, '最长持仓时间退出');
  assert.deepEqual(state, before); assert.equal(client.calls.some(c => c.method === 'POST'), false);
});

test('only known read-only failures without any unresolved order can enter bounded recovery', () => {
  const state = initialState(config, 'key');
  assert.deepEqual([1, 2, 3, 4, 5, 100].map(attempt => readOnlyRecoveryDelay({ readOnlyTransient: true }, config, state, attempt)), [30, 60, 120, 240, 300, 300]);
  assert.equal(readOnlyRecoveryDelay({ readOnlyTransient: false }, config, state, 1), null);
  assert.equal(readOnlyRecoveryDelay({}, config, state, 1), null);
  assert.equal(readOnlyRecoveryDelay({ readOnlyTransient: true }, { ...config, strategy: 'classic' }, state, 1), null);
  state.pending = { clientOrderId: 'unresolved' };
  assert.equal(readOnlyRecoveryDelay({ readOnlyTransient: true }, config, state, 1), null);
});

test('timestamp errors resync exactly once for GET, never retry POST or bypass rate limits', async () => {
  const calls = []; let reads = 0;
  const client = new TestnetClient({ apiKey: 'unit-key', apiSecret: 'unit-secret', allowOrders: true, fetchImpl: async (url, options) => {
    calls.push([options.method, url.pathname]);
    if (url.pathname.endsWith('/time')) return new Response(JSON.stringify({ serverTime: Date.now() }));
    if (options.method === 'GET' && ++reads > 1) return new Response(JSON.stringify({ balances: [] }));
    return new Response(JSON.stringify({ code: -1021 }), { status: 400 });
  } });
  await client.request('GET', '/api/v3/account', {}, true);
  assert.deepEqual(calls, [['GET', '/api/v3/account'], ['GET', '/api/v3/time'], ['GET', '/api/v3/account']]);
  assert.ok(client.clockOffset <= -250);
  await assert.rejects(client.request('POST', '/api/v3/order', {}, true), e => e.code === -1021 && !e.readOnlyTransient);
  assert.equal(calls.filter(c => c[0] === 'POST').length, 1);
  let throttledCalls = 0;
  const throttled = new TestnetClient({ apiKey: 'key', apiSecret: 'secret', fetchImpl: async () => { throttledCalls++; return new Response(JSON.stringify({ code: -1021 }), { status: 429 }); } });
  await assert.rejects(throttled.request('GET', '/api/v3/account', {}, true), e => e.status === 429 && !e.readOnlyTransient);
  assert.equal(throttledCalls, 1);
});

test('a second GET timestamp failure is not retried recursively', async () => {
  let calls = 0;
  const client = new TestnetClient({ apiKey: 'key', apiSecret: 'secret', fetchImpl: async url => {
    calls++;
    return url.pathname.endsWith('/time') ? new Response(JSON.stringify({ serverTime: Date.now() })) : new Response(JSON.stringify({ code: -1021 }), { status: 400 });
  } });
  await assert.rejects(client.request('GET', '/api/v3/account', {}, true), e => e.code === -1021);
  assert.equal(calls, 3);
});
