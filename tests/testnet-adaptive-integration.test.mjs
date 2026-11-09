import test from 'node:test';
import assert from 'node:assert/strict';
import * as bot from '../lib/testnet-bot.mjs';

// Synthetic-only integration coverage. No environment files, credentials,
// sockets, real accounts, or CLI trading processes are used by these tests.
const now = 1_800_000_000_000;
const config = (patch = {}) => bot.readConfig({ TESTNET_STRATEGY: 'adaptive', ...patch });
const book = (price = 101990, halfSpread = 5) => ({
  symbol: 'BTCUSDT', bidPrice: String(price - halfSpread), askPrice: String(price + halfSpread),
  bidQty: '1', askQty: '1'
});
const samples = (at = now) => [
  { time: at - 10000, price: 101950 },
  { time: at - 5000, price: 101970 },
  { time: at, price: 101990 }
];
const stateFor = (patch = {}) => ({
  ...bot.initialState(config(), 'synthetic-adaptive-test-key'), adaptiveSamples: samples(), ...patch
});
const rows = (at = now) => {
  const boundary = Math.floor(at / 60000) * 60000;
  return Array.from({ length: 100 }, (_, i) => {
    const close = 100000 + i * 20;
    const time = boundary - (100 - i) * 60000;
    return [time, String(close - 5), String(close + 80), String(close - 80), String(close), '100',
      time + 59999, String(close * 100), 100, '70', String(close * 70), '0'];
  });
};
const symbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'], quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true }
  ]
};

function exchange(clock, price, { loseResponse = false } = {}) {
  const calls = []; const orders = new Map(); let nextId = 7000; let lost = false;
  return {
    calls, orders, syncTime: async () => clock(),
    request: async (method, path, params = {}) => {
      calls.push({ method, path, params: structuredClone(params) });
      if (path.endsWith('/klines')) return rows(clock());
      if (path.endsWith('/exchangeInfo')) return { symbols: [symbolInfo] };
      if (path.endsWith('/bookTicker')) return book(price());
      if (path.endsWith('/price')) return { price: String(price()) };
      if (path.endsWith('/account')) return { canTrade: true, balances: [
        { asset: 'BTC', free: '1.1', locked: '0' }, { asset: 'USDT', free: '10000', locked: '0' }
      ] };
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/order') && method === 'POST') {
        const executedQty = params.quantity || (Number(params.quoteOrderQty) / price()).toFixed(8);
        const quote = params.quoteOrderQty || String(Number(executedQty) * price());
        const fill = { symbol: 'BTCUSDT', side: params.side, clientOrderId: params.newClientOrderId,
          orderId: ++nextId, status: 'FILLED', executedQty, cummulativeQuoteQty: quote, transactTime: clock() };
        orders.set(fill.orderId, fill);
        if (loseResponse && !lost) { lost = true; throw new Error('synthetic adaptive response lost'); }
        return fill;
      }
      if (path.endsWith('/order')) return [...orders.values()].find(fill => fill.clientOrderId === params.origClientOrderId);
      if (path.endsWith('/myTrades')) return [...orders.values()]
        .filter(fill => !params.orderId || fill.orderId === params.orderId)
        .map(fill => ({ id: fill.orderId, orderId: fill.orderId, qty: fill.executedQty,
          quoteQty: fill.cummulativeQuoteQty, price: String(Number(fill.cummulativeQuoteQty) / Number(fill.executedQty)),
          isBuyer: fill.side === 'BUY', commissionAsset: 'BTC', commission: '0', time: fill.transactTime }));
      throw new Error(`unexpected synthetic adaptive route ${method} ${path}`);
    }
  };
}

test('adaptive profile has a virtual-only five-second cadence and bounded one-minute configuration', () => {
  const cfg = config();
  assert.equal(cfg.strategy, 'adaptive'); assert.equal(cfg.interval, '1m');
  assert.equal(cfg.pollSeconds, 5); assert.equal(cfg.minOrderSeconds, 5); assert.equal(cfg.tradeUsdt, 100);
  assert.deepEqual(cfg.batchFractions, [0.4, 0.3, 0.3]);
  assert.equal(cfg.fast, 3); assert.equal(cfg.slow, 8);
  for (const patch of [{ TESTNET_INTERVAL: '5m' }, { TESTNET_POLL_SECONDS: '4' },
    { TESTNET_POLL_SECONDS: '16' },
    { TESTNET_TRADE_USDT: '101' }, { TESTNET_MAX_BUYS_PER_HOUR: '61' },
    { BINANCE_BASE_URL: 'https://api.binance.com' }, { BINANCE_API_KEY: 'synthetic-production-key' }]) {
    assert.throws(() => config(patch));
  }
});

test('adaptive market loading retains closed OHLCV and rejects invalid candle ranges or volume', async () => {
  const cfg = config();
  const load = raw => bot.loadMarket({ syncTime: async () => now, request: async () => raw }, cfg);
  const raw = rows();
  const loaded = await load([...raw, [now, '1', '1000000', '0.5', '999999', '1', now + 59999]]);
  assert.equal(loaded.length, 100); assert.equal(loaded.at(-1).close, 101980);
  assert.equal(loaded.at(-1).open, 101975); assert.equal(loaded.at(-1).high, 102060);
  assert.equal(loaded.at(-1).low, 101900); assert.equal(loaded.at(-1).volume, 100);
  for (const [index, value] of [[1, 'NaN'], [2, '0'], [2, '101000'], [3, '102500'],
    [5, '-1'], [5, 'Infinity']]) {
    const malformed = structuredClone(raw); malformed[99][index] = value;
    await assert.rejects(load(malformed), `field ${index}=${value}`);
  }
  const gapped = structuredClone(raw); gapped[50][0] += 1;
  await assert.rejects(load(gapped));
  const stale = raw.map(row => [row[0] - 180000, ...row.slice(1, 6), row[6] - 180000, ...row.slice(7)]);
  await assert.rejects(load(stale));
});

test('adaptive preview reports a candidate without persisting samples, risk state, or an order', async () => {
  const cfg = config(); const state = stateFor(); const before = structuredClone(state);
  const client = exchange(() => now, () => 101990);
  const result = await bot.runCycle(client, cfg, state, () => assert.fail('preview persisted'), false, { now });
  assert.equal(result.side, 'BUY'); assert.equal(result.batchUsdt, 40);
  assert.equal(result.route, 'trend_continuation');
  assert.deepEqual(state, before); assert.equal(client.calls.some(call => call.method === 'POST'), false);
});

test('adaptive rejects the manual BUY shortcut before any exchange request', async () => {
  const client = exchange(() => now, () => 101990); const state = stateFor();
  await assert.rejects(bot.runCycle(client, config(), state, async () => {}, true, { now, manualBuy: true }));
  assert.deepEqual(client.calls, []); assert.equal(state.pending, null);
});

test('adopting an earlier virtual position retains ownership and history but makes it exit-only', () => {
  const oldConfig = bot.readConfig({ TESTNET_STRATEGY: 'classic', TESTNET_INTERVAL: '1m' });
  const previous = { ...bot.initialState(oldConfig, 'synthetic-adaptive-test-key'),
    position: { quantity: 0.00024, entryPrice: 101990, openedAt: now - 60000 },
    orders: [{ orderId: 6000, side: 'BUY', time: now - 60000 }] };
  const before = structuredClone(previous);
  const adopted = bot.adoptStrategyState(previous, config(), 'synthetic-adaptive-test-key', now);
  assert.equal(adopted.strategy, 'adaptive'); assert.equal(adopted.position.adopted, true);
  assert.equal(adopted.position.quantity, previous.position.quantity);
  assert.equal(adopted.position.openedAt, previous.position.openedAt);
  assert.deepEqual(adopted.orders, previous.orders); assert.deepEqual(adopted.adaptiveSamples, []);
  assert.deepEqual(previous, before);
  assert.throws(() => bot.adoptStrategyState({ ...previous, pending: { side: 'BUY' } }, config(), 'synthetic-adaptive-test-key', now));
});

test('adaptive entries deploy at most 40/30/30, retain opening time, and freeze first-entry protective settings', async t => {
  let clock = now; let price = 101990; t.mock.method(Date, 'now', () => clock);
  let cfg = config(); const state = stateFor(); const client = exchange(() => clock, () => price);
  const saved = [];
  const request = client.request;
  client.request = async (method, path, params) => {
    if (method === 'POST') assert.equal(saved.at(-1)?.pending?.clientOrderId, params.newClientOrderId);
    return request(method, path, params);
  };
  const run = () => bot.runCycle(client, cfg, state, async value => saved.push(structuredClone(value)), true, { now: clock });
  await run();
  assert.equal(state.position.batches, 1); assert.equal(state.position.deployedUsdt, 40);
  assert.ok(saved.some(value => value.pending?.side === 'BUY'));
  const firstIntent = saved.find(value => value.pending?.side === 'BUY').pending;
  assert.equal(typeof firstIntent.decisionSnapshot, 'object');
  assert.deepEqual(state.orders[0].decisionSnapshot, firstIntent.decisionSnapshot);
  const openedAt = state.position.openedAt; const firstQty = state.position.quantity;
  const frozenRisk = structuredClone(state.position.riskSnapshot);
  assert.ok(Number.isFinite(frozenRisk.stopLossPercent)); assert.ok(Number.isFinite(frozenRisk.takeProfitPercent));
  clock += 4999; price = 102030; await run();
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  clock += 1; cfg = { ...cfg, stopLoss: 1, takeProfit: 2 }; await run();
  assert.equal(state.position.batches, 2); assert.equal(state.position.deployedUsdt, 70);
  assert.ok(state.position.quantity > firstQty); assert.equal(state.position.openedAt, openedAt);
  assert.deepEqual(state.position.riskSnapshot, frozenRisk);
  clock += 5000; price = 102070; await run();
  assert.equal(state.position.batches, 3); assert.equal(state.position.deployedUsdt, 100);
  assert.deepEqual(state.position.riskSnapshot, frozenRisk); assert.equal(state.position.openedAt, openedAt);
  clock += 5000; price = 102090; await run();
  const posts = client.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => call.params.quoteOrderQty), ['40.00', '30.00', '30.00']);
  assert.equal(new Set(posts.map(call => call.params.newClientOrderId)).size, 3);
});

test('a lost adaptive BUY response reconciles the persisted intent without retrying its POST', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const cfg = config(); const state = stateFor(); const saved = [];
  const client = exchange(() => clock, () => 101990, { loseResponse: true });
  await assert.rejects(bot.runCycle(client, cfg, state, async value => saved.push(structuredClone(value)), true, { now: clock }));
  assert.ok(state.pending); assert.equal(state.position, null);
  assert.ok(saved.some(value => value.pending?.side === 'BUY'));
  const pendingSnapshot = structuredClone(state.pending.decisionSnapshot);
  assert.equal(typeof pendingSnapshot, 'object');
  clock += 1000;
  await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  assert.equal(state.pending, null); assert.equal(state.position.batches, 1); assert.equal(state.position.deployedUsdt, 40);
  assert.ok(Number.isFinite(state.position.riskSnapshot.stopLossPercent));
  assert.deepEqual(state.orders[0].decisionSnapshot, pendingSnapshot);
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
});

test('an adopted position can exit during warm-up and never sells the gifted account BTC', async t => {
  t.mock.method(Date, 'now', () => now);
  const cfg = config();
  const previous = { ...bot.initialState(bot.readConfig({ TESTNET_INTERVAL: '1m' }), 'synthetic-adaptive-test-key'),
    position: { quantity: 0.00024, entryPrice: 103000, openedAt: now - 60000 } };
  const state = bot.adoptStrategyState(previous, cfg, 'synthetic-adaptive-test-key', now);
  const client = exchange(() => now, () => 101990); const saved = [];
  await bot.runCycle(client, cfg, state, async value => saved.push(structuredClone(value)), true, { now });
  const posts = client.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].params.side, 'SELL');
  assert.equal(posts[0].params.quantity, '0.00024000');
  assert.ok(saved.some(value => value.pending?.side === 'SELL')); assert.equal(state.position, null);
  assert.equal(state.dailyRisk.dayUtc, new Date(now).toISOString().slice(0, 10));
  const knownRealized = 0.00024 * (101990 - 103000);
  assert.ok(Math.abs(state.orders[0].realizedUsdt - knownRealized) < 1e-8);
  assert.ok(state.dailyRisk.realizedUsdt <= knownRealized);
  assert.match(state.dailyRisk.basis, /assumed|conservative/i);
  assert.equal(state.dailyRisk.consecutiveLosses, 1); assert.equal(state.dailyRisk.lastLossAt, now);
});

test('adaptive pending preview is read-only and never replaces an unresolved intent', async () => {
  const cfg = config(); const state = stateFor({ pending: { side: 'BUY', clientOrderId: 'synthetic-pending' } });
  const before = structuredClone(state); const client = exchange(() => now, () => 101990); const request = client.request;
  client.request = async (method, path, params) => path.endsWith('/order')
    ? { orderId: 7001, clientOrderId: params.origClientOrderId, status: 'NEW' }
    : request(method, path, params);
  const result = await bot.runCycle(client, cfg, state, () => assert.fail('pending preview persisted'), false, { now });
  assert.equal(result.status, 'NEW'); assert.deepEqual(state, before);
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
});

test('slow account verification invalidates an adaptive entry rather than submitting an old signal', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const state = stateFor(); const client = exchange(() => clock, () => 101990); const request = client.request;
  client.request = async (method, path, params) => {
    const result = await request(method, path, params);
    if (path.endsWith('/account')) clock += 10001;
    return result;
  };
  await bot.runCycle(client, config(), state, async () => {}, true);
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
  assert.deepEqual(state.adaptiveSamples, []); assert.equal(state.pending, null);
});

test('adaptive respects read-only recovery, pending-order halts, and regional or rate refusals', async () => {
  const cfg = config(); const state = stateFor();
  assert.equal(bot.readOnlyRecoveryDelay({ readOnlyTransient: true }, cfg, state, 1), 30);
  assert.equal(bot.readOnlyRecoveryDelay({ readOnlyTransient: true }, cfg, { ...state, pending: {} }, 1), null);
  for (const status of [451, 429, 418]) {
    const methods = [];
    const client = new bot.TestnetClient({ allowOrders: true, fetchImpl: async (_, options) => {
      methods.push(options.method); return new Response(JSON.stringify({ code: 0 }), { status });
    } });
    await assert.rejects(bot.runCycle(client, cfg, state, async () => {}, true), error => error.status === status);
    assert.deepEqual(methods, ['GET']); assert.equal(state.pending, null);
  }
});

const settlement = (side = 'BUY', patch = {}) => {
  const pending = { side, strategy: 'adaptive', clientOrderId: 'synthetic-adaptive-settlement', candle: now,
    reason: 'synthetic adaptive accounting', batchIndex: 1, positionBudget: 100, quoteOrderQty: '40.00',
    riskSnapshot: { stopLossPercent: 0.25, takeProfitPercent: 0.4 },
    decisionSnapshot: { side, route: 'trend_continuation', checkedAt: now }, ...patch };
  const order = { symbol: 'BTCUSDT', side, clientOrderId: pending.clientOrderId, orderId: 8000,
    status: 'FILLED', executedQty: '0.00040000', cummulativeQuoteQty: '40.00', transactTime: now };
  return { pending, order };
};
const fillClient = (order, fills) => ({ request: async (method, path) => {
  assert.equal(method, 'GET'); assert.equal(path, '/api/v3/myTrades');
  return fills.map(fill => ({ orderId: order.orderId, ...fill }));
} });

test('adaptive settlement accounts for known fees, flags unvalued fees, and retains frozen risk and peak across adds', async () => {
  const position = { quantity: 0.0004, entryPrice: 100000, openedAt: now - 60000, deployedUsdt: 40,
    batches: 1, lastEntryPrice: 100000, adopted: false, peakBid: 102000,
    riskSnapshot: { stopLossPercent: 0.25, takeProfitPercent: 0.4 }, feeValuationComplete: true };
  const state = stateFor({ position });
  const { pending, order } = settlement('BUY', { batchIndex: 2, quoteOrderQty: '30.00',
    riskSnapshot: { stopLossPercent: 0.75, takeProfitPercent: 1.2 } });
  order.executedQty = '0.00030000'; order.cummulativeQuoteQty = '30.00';
  state.pending = pending;
  const client = fillClient(order, [
    { qty: '0.0001', commissionAsset: 'BTC', commission: '0.00000001' },
    { qty: '0.0001', commissionAsset: 'USDT', commission: '0.03' },
    { qty: '0.0001', commissionAsset: 'BNB', commission: '0.001' }
  ]);
  await bot.settleOrder(client, state, pending, order, 'BTC');
  assert.ok(Math.abs(state.position.quantity - 0.00069999) < 1e-12);
  assert.ok(Math.abs(state.position.quantity * state.position.entryPrice - 70.03) < 1e-8);
  assert.equal(state.position.deployedUsdt, 70); assert.equal(state.position.batches, 2);
  assert.deepEqual(state.position.riskSnapshot, position.riskSnapshot);
  assert.equal(state.position.peakBid, 102000); assert.equal(state.position.openedAt, position.openedAt);
  assert.equal(state.position.feeValuationComplete, false); assert.equal(state.pending, null);
  assert.deepEqual(state.orders[0].decisionSnapshot, pending.decisionSnapshot);
  pending.decisionSnapshot.route = 'mutated-after-settlement';
  assert.equal(state.orders[0].decisionSnapshot.route, 'trend_continuation');
});

test('adaptive first-entry peak is positive so a later monitoring cycle can validate the owned position', async () => {
  const state = stateFor(); const { pending, order } = settlement(); state.pending = pending;
  await bot.settleOrder(fillClient(order, [{ qty: order.executedQty, commissionAsset: 'BTC', commission: '0' }]),
    state, pending, order, 'BTC');
  assert.ok(Number.isFinite(state.position.peakBid)); assert.ok(state.position.peakBid > 0);
  assert.deepEqual(state.position.riskSnapshot, pending.riskSnapshot);
});

test('a partial adaptive SELL preserves residual ownership and audits realized quote P&L separately from the risk guard', async t => {
  t.mock.method(Date, 'now', () => now);
  const position = { quantity: 0.0005, entryPrice: 100000, openedAt: now - 60000,
    deployedUsdt: 50, batches: 2, feeValuationComplete: true };
  const state = stateFor({ position }); const { pending, order } = settlement('SELL');
  order.executedQty = '0.00049000'; order.cummulativeQuoteQty = '49.00'; order.status = 'CANCELED';
  state.pending = pending;
  await bot.settleOrder(fillClient(order, [
    { qty: '0.00024', commissionAsset: 'USDT', commission: '0.1' },
    { qty: '0.00025', commissionAsset: 'BTC', commission: '0.00000001' }
  ]), state, pending, order, 'BTC');
  const expected = 49 - 0.1 - 100000 * (0.00049 + 0.00000001);
  assert.ok(Math.abs(state.orders[0].realizedUsdt - expected) < 1e-8);
  assert.equal(state.orders[0].realizedPnlComplete, true);
  assert.ok(Math.abs(state.position.quantity - 0.00000999) < 1e-12);
  assert.ok(state.dailyRisk.realizedUsdt <= expected); assert.equal(state.dailyRisk.consecutiveLosses, 1);
  assert.equal(state.pending, null);
});

test('entry loss caps stop new adaptive BUYs without blocking a protective SELL', async t => {
  t.mock.method(Date, 'now', () => now);
  const cfg = config(); const dailyRisk = { dayUtc: new Date(now).toISOString().slice(0, 10),
    realizedUsdt: -5, consecutiveLosses: 3, lastLossAt: now - 1000 };
  const client = exchange(() => now, () => 101990); const flat = stateFor({ dailyRisk });
  await bot.runCycle(client, cfg, flat, async () => {}, true, { now });
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
  const held = stateFor({ dailyRisk, adaptiveSamples: [], position: {
    quantity: 0.00024, entryPrice: 103000, openedAt: now - 60000,
    deployedUsdt: 24.72, batches: 3, adopted: true,
    riskSnapshot: { stopLossPercent: 0.25, takeProfitPercent: 0.4 }
  } });
  await bot.runCycle(client, cfg, held, async () => {}, true, { now });
  const posts = client.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].params.side, 'SELL'); assert.equal(held.position, null);
});

test('malformed adaptive reconciliation evidence leaves the pending journal and owned position untouched', async t => {
  const invalid = [
    { name: 'missing frozen risk', patch: { riskSnapshot: null } },
    { name: 'non-finite frozen risk', patch: { riskSnapshot: { stopLossPercent: Infinity, takeProfitPercent: 0.4 } } },
    { name: 'mismatched tranche', patch: { batchIndex: 2 } },
    { name: 'over-budget fill', orderPatch: { cummulativeQuoteQty: '40.01' } },
    { name: 'bad fee', fillPatch: { commission: 'NaN' } },
    { name: 'missing fee currency', fillPatch: { commissionAsset: '' } },
    { name: 'incomplete fill proof', fillPatch: { qty: '0.0003' } }
  ];
  for (const sample of invalid) await t.test(sample.name, async () => {
    const state = stateFor(); const { pending, order } = settlement('BUY', sample.patch);
    Object.assign(order, sample.orderPatch); state.pending = pending; const before = structuredClone(state);
    const fill = { qty: order.executedQty, commissionAsset: 'BTC', commission: '0', ...sample.fillPatch };
    await assert.rejects(bot.settleOrder(fillClient(order, [fill]), state, pending, order, 'BTC'));
    assert.deepEqual(state, before);
  });
});
