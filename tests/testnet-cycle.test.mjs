import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, initialState, adoptStrategyState, cycleSignal, strategySignal, runCycle, readOnlyRecoveryDelay, TestnetClient } from '../lib/testnet-bot.mjs';
import { monitorSnapshot } from '../lib/testnet-monitor.mjs';

const config = readConfig({ TESTNET_STRATEGY: 'cycle' });
const baseTime = 1800000000000;
const symbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'], quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true }
  ]
};
const position = { quantity: 0.001, entryPrice: 100000, openedAt: baseTime - 60000 };
const record = (side, time) => ({ orderId: time, side, time });

function exchange(clock, { loseResponse = false } = {}) {
  const calls = []; const orders = new Map(); let nextId = 200; let lost = false;
  return {
    calls, syncTime: async () => clock(),
    request: async (method, path, params = {}) => {
      calls.push({ method, path, params });
      if (path.endsWith('/klines')) {
        const boundary = Math.floor(clock() / 60000) * 60000;
        return Array.from({ length: 100 }, (_, i) => [boundary - (100 - i) * 60000, '1', '1', '1', '100000', '1', boundary - (99 - i) * 60000 - 1]);
      }
      if (path.endsWith('/exchangeInfo')) return { symbols: [symbolInfo] };
      if (path.endsWith('/price')) return { price: '100000' };
      if (path.endsWith('/account')) return { canTrade: true, balances: [{ asset: 'BTC', free: '1.001', locked: '0' }, { asset: 'USDT', free: '10000', locked: '0' }] };
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/order') && method === 'POST') {
        const executedQty = params.quantity || (Number(params.quoteOrderQty) / 100000).toFixed(8);
        const order = { symbol: 'BTCUSDT', side: params.side, clientOrderId: params.newClientOrderId, orderId: ++nextId, status: 'FILLED', executedQty, cummulativeQuoteQty: String(Number(executedQty) * 100000), transactTime: clock() };
        orders.set(order.orderId, order);
        if (loseResponse && !lost) { lost = true; throw new Error('response lost'); }
        return order;
      }
      if (path.endsWith('/order')) return [...orders.values()].find(order => order.clientOrderId === params.origClientOrderId);
      if (path.endsWith('/myTrades')) {
        return [...orders.values()].filter(order => !params.orderId || order.orderId === params.orderId).map(order => ({ id: order.orderId, orderId: order.orderId, isBuyer: order.side === 'BUY', qty: order.executedQty, price: '100000', quoteQty: order.cummulativeQuoteQty, commissionAsset: 'BTC', commission: '0', time: order.transactTime }));
      }
      throw new Error(`unexpected route ${path}`);
    }
  };
}

test('cycle defaults target one action per 30 seconds with a virtual-only budget and bounded overrides', () => {
  assert.equal(config.strategy, 'cycle'); assert.equal(config.interval, '1m');
  assert.equal(config.cycleSeconds, 30); assert.equal(config.pollSeconds, 5);
  assert.equal(config.tradeUsdt, 100); assert.equal(config.cooldownSeconds, 30); assert.equal(config.maxBuysPerHour, 60);
  for (const patch of [{ TESTNET_CYCLE_SECONDS: '29' }, { TESTNET_TRADE_USDT: '101' }, { TESTNET_POLL_SECONDS: '1' }, { TESTNET_MAX_BUYS_PER_HOUR: '61' }, { TESTNET_INTERVAL: '5m' }, { BINANCE_API_KEY: 'production' }]) {
    assert.throws(() => readConfig({ TESTNET_STRATEGY: 'cycle', ...patch }));
  }
  assert.equal(readConfig().strategy, 'classic');
  assert.equal(readConfig({ TESTNET_STRATEGY: 'fast' }).maxBuysPerHour, 6);
});

test('cycle ignores SMA and candle dedup but never repeats an action before the 30-second boundary', () => {
  const state = initialState(config, 'key'); state.lastCandle = baseTime;
  assert.equal(strategySignal([], config, state, 100000, baseTime).side, 'BUY');
  state.position = { ...position, openedAt: baseTime }; state.orders = [record('BUY', baseTime)];
  assert.equal(cycleSignal(config, state, baseTime + 29999).side, null);
  assert.equal(cycleSignal(config, state, baseTime + 30000).side, 'SELL');
  state.position = null; state.orders.unshift(record('SELL', baseTime + 30000));
  assert.equal(cycleSignal(config, state, baseTime + 59999).side, null);
  assert.equal(cycleSignal(config, state, baseTime + 60000).side, 'BUY');
});

test('cycle uses the latest actual order or entry time and fails closed for bad timing records or pending orders', () => {
  const state = { ...initialState(config, 'key'), position: { ...position, openedAt: baseTime }, orders: [record('BUY', baseTime - 1000)] };
  assert.equal(cycleSignal(config, state, baseTime + 29999).side, null);
  assert.equal(cycleSignal(config, state, baseTime + 30000).side, 'SELL');
  assert.throws(() => cycleSignal(config, { ...state, orders: [record('BUY', NaN)] }, baseTime));
  assert.throws(() => cycleSignal(config, { ...state, position: { ...position, openedAt: undefined } }, baseTime));
  assert.equal(cycleSignal(config, { ...state, pending: { side: 'BUY' } }, baseTime + 60000).side, null);
});

test('hourly cycle buy cap never prevents selling owned holdings', () => {
  const state = initialState(config, 'key');
  state.orders = Array.from({ length: 60 }, (_, i) => record('BUY', baseTime - 60000 - i * 1000));
  assert.equal(cycleSignal(config, state, baseTime).reason, '已达每小时买入上限');
  state.position = position;
  assert.equal(cycleSignal(config, state, baseTime).side, 'SELL');
});

test('cycle round trip obeys real settlement timing, budget, ownership and unique order intents', async t => {
  let clock = baseTime; t.mock.method(Date, 'now', () => clock);
  const client = exchange(() => clock); const state = initialState(config, 'key'); const snapshots = [];
  const run = () => runCycle(client, config, state, async value => snapshots.push(structuredClone(value)), true, { now: clock });
  await run();
  assert.equal(snapshots[0].pending.side, 'BUY');
  assert.equal(client.calls.find(call => call.method === 'POST').params.quoteOrderQty, '100.00');
  assert.equal(state.position.quantity, 0.001);
  clock += 29999; await run(); assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  clock += 1; await run(); assert.equal(state.position, null);
  const sell = client.calls.filter(call => call.method === 'POST')[1];
  assert.equal(sell.params.side, 'SELL'); assert.equal(sell.params.quantity, '0.00100000');
  clock += 30000; await run();
  const posts = client.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => call.params.side), ['BUY', 'SELL', 'BUY']);
  assert.equal(new Set(posts.map(call => call.params.newClientOrderId)).size, 3);
});

test('cycle preview remains read-only and extra manual trial orders cannot bypass timing', async () => {
  const client = exchange(() => baseTime); const state = initialState(config, 'key'); const before = structuredClone(state);
  const result = await runCycle(client, config, state, () => assert.fail('preview wrote state'), false, { now: baseTime });
  assert.equal(result.side, 'BUY'); assert.deepEqual(state, before);
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
  await assert.rejects(runCycle(client, config, state, async () => {}, true, { manualBuy: true, now: baseTime }), /禁止额外手动/);
});

test('cycle response loss preserves pending and reconciles without blindly resubmitting', async t => {
  let clock = baseTime; t.mock.method(Date, 'now', () => clock);
  const client = exchange(() => clock, { loseResponse: true }); const state = initialState(config, 'key');
  await assert.rejects(runCycle(client, config, state, async () => {}, true, { now: clock }));
  assert.ok(state.pending);
  clock += 5000;
  await runCycle(client, config, state, async () => {}, true, { now: clock });
  assert.equal(state.pending, null); assert.equal(state.position.quantity, 0.001);
  await runCycle(client, config, state, async () => {}, true, { now: clock });
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
});

test('cycle resumes with a single current action, never catching up missed time slots', async t => {
  t.mock.method(Date, 'now', () => baseTime);
  const client = exchange(() => baseTime);
  const state = { ...initialState(config, 'key'), orders: [record('SELL', baseTime - 3600000)] };
  await runCycle(client, config, state, async () => {}, true, { now: baseTime });
  await runCycle(client, config, state, async () => {}, true, { now: baseTime });
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
});

test('cycle migration retains owned holdings and order history without clearing unresolved orders', () => {
  const old = { ...initialState(readConfig({ TESTNET_STRATEGY: 'fast' }), 'key'), position, orders: [record('BUY', baseTime - 60000)] };
  const migrated = adoptStrategyState(old, config, 'key', baseTime);
  assert.equal(migrated.strategy, 'cycle'); assert.deepEqual(migrated.position, old.position); assert.deepEqual(migrated.orders, old.orders);
  assert.throws(() => adoptStrategyState({ ...old, pending: { side: 'SELL' } }, config, 'key', baseTime));
});

test('cycle supports only safe read-only recovery and stops on HTTP 451 without placing any order', async () => {
  const state = initialState(config, 'key');
  assert.equal(readOnlyRecoveryDelay({ readOnlyTransient: true }, config, state, 1), 30);
  assert.equal(readOnlyRecoveryDelay({ status: 451, readOnlyTransient: false }, config, state, 1), null);
  assert.equal(readOnlyRecoveryDelay({ readOnlyTransient: true }, config, { ...state, pending: {} }, 1), null);
  const methods = [];
  const client = new TestnetClient({ allowOrders: true, fetchImpl: async (_, options) => {
    methods.push(options.method); return new Response(JSON.stringify({ code: 0 }), { status: 451 });
  } });
  await assert.rejects(runCycle(client, config, state, async () => {}, true), error => error.status === 451);
  assert.deepEqual(methods, ['GET']); assert.equal(state.pending, null);
});

test('cycle monitor shows scheduling metadata, only actual fills, and keeps all calls read-only', async t => {
  t.mock.method(Date, 'now', () => baseTime);
  const client = exchange(() => baseTime); const state = initialState(config, 'key');
  const data = await monitorSnapshot(client, config, state, { status: 'stopped' });
  assert.equal(data.config.strategy, 'cycle'); assert.equal(data.cycle.nextSide, 'BUY');
  assert.equal(data.position, null); assert.deepEqual(data.trades, []);
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
});
