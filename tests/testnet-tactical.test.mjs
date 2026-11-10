import test from 'node:test';
import assert from 'node:assert/strict';
import * as bot from '../lib/testnet-bot.mjs';

// All prices, credentials and exchange responses in this file are synthetic.
// The test client neither accesses the network nor reads local secret files.
const now = 1_800_000_000_000;
const config = () => bot.readConfig({ TESTNET_STRATEGY: 'tactical' });
const candleSet = closes => closes.map((close, index) => ({
  time: now - (closes.length - index) * 60_000,
  close, closeTime: now - (closes.length - index - 1) * 60_000 - 1
}));
const up = candleSet([99900, 99910, 99920, 99930, 99940, 99950, 99960, 99970]);
const down = candleSet([100000, 99990, 99980, 99970, 99960, 99950, 99940, 99930]);
const book = (price = 100000, halfSpread = 0.05) => ({
  symbol: 'BTCUSDT', bidPrice: String(price - halfSpread), askPrice: String(price + halfSpread),
  bidQty: '1', askQty: '1'
});
const samples = (at = now, price = 100000) => [
  { time: at - 30000, price: price * 0.9995 },
  { time: at - 20000, price: price * 0.9996 },
  { time: at - 10000, price: price * 0.9998 },
  { time: at, price }
];
const stateFor = (patch = {}) => ({
  ...bot.initialState(config(), 'synthetic-unit-key'), tacticalSamples: samples(), ...patch
});
const owned = (patch = {}) => ({
  quantity: 0.00025, entryPrice: 99900, openedAt: now - 60000,
  deployedUsdt: 25, batches: 1, lastEntryPrice: 99980, adopted: false, ...patch
});
const order = (side, at = now - 30000) => ({ orderId: at, side, time: at });
const signal = (state = stateFor(), currentBook = book(), at = now, candles = up) =>
  bot.tacticalSignal(candles, config(), state, currentBook, at);

test('tactical defaults check market every 10 seconds rather than blindly cycling orders', () => {
  const cfg = config();
  assert.equal(cfg.strategy, 'tactical'); assert.equal(cfg.interval, '1m');
  assert.equal(cfg.fast, 3); assert.equal(cfg.slow, 7); assert.equal(cfg.pollSeconds, 10);
  assert.equal(cfg.minOrderSeconds, 10); assert.equal(cfg.tradeUsdt, 100);
  assert.deepEqual(cfg.batchFractions, [0.25, 0.25, 0.5]);
  assert.equal(cfg.stopLoss, 0.2); assert.equal(cfg.takeProfit, 0.3);
  assert.equal(cfg.maxHoldMinutes, 3); assert.equal(cfg.cooldownSeconds, 30);
  assert.equal(cfg.maxBuysPerHour, 60);
  assert.equal(cfg.entryMomentumPercent, 0.02); assert.equal(cfg.exitMomentumPercent, 0.04);
  assert.equal(cfg.maxSpreadPercent, 0.05); assert.equal(cfg.maxExtensionPercent, 0.2);
  assert.equal(cfg.addStepPercent, 0.01);
  for (const override of [{ TESTNET_INTERVAL: '5m' }, { TESTNET_POLL_SECONDS: '9' },
    { TESTNET_TRADE_USDT: '101' }, { TESTNET_MAX_BUYS_PER_HOUR: '61' }, { BINANCE_BASE_URL: 'https://api.binance.com' }]) {
    assert.throws(() => bot.readConfig({ TESTNET_STRATEGY: 'tactical', ...override }));
  }
});

test('tactical signal is pure and enters only with trend, fresh positive momentum and a tight spread', () => {
  const state = stateFor(); const before = structuredClone(state); const currentBook = book();
  const entry = signal(state, currentBook);
  assert.equal(entry.side, 'BUY'); assert.equal(entry.batchUsdt, 25); assert.equal(entry.batchIndex, 1);
  assert.deepEqual(state, before); assert.deepEqual(currentBook, book());
  assert.equal(signal(state, currentBook, now, down).side, null);
  assert.equal(signal(stateFor({ tacticalSamples: samples(now, 100100) }), currentBook).side, null);
  assert.equal(signal(state, book(100000, 40)).side, null);
  assert.equal(signal(state, book(100300)).side, null);
});

test('tactical waits for a real 20-second market sample window and never replays stale data', () => {
  assert.equal(signal(stateFor({ tacticalSamples: [] })).side, null);
  assert.equal(signal(stateFor({ tacticalSamples: [
    { time: now - 10000, price: 99950 }, { time: now, price: 100000 }
  ] })).side, null);
  assert.equal(signal(stateFor({ tacticalSamples: samples(now - 60000) })).side, null);
  assert.equal(signal(stateFor({ tacticalSamples: samples(), pending: { side: 'BUY' } })).side, null);
});

test('sample updates are pure, retain midpoint values, discard old history, and reset after disconnects', () => {
  const original = samples(); const before = structuredClone(original);
  const next = bot.updateTacticalSamples(original, book(100020), now + 10000);
  assert.deepEqual(original, before); assert.notEqual(next, original);
  assert.equal(next.at(-1).time, now + 10000); assert.equal(next.at(-1).price, 100020);
  assert.ok(next.every(sample => sample.time >= now + 10000 - 45000));
  const reset = bot.updateTacticalSamples(original, book(100020), now + 35001);
  assert.deepEqual(reset, [{ time: now + 35001, price: 100020 }]);
});

test('ordinary entries and additions respect the actual 10-second order boundary', () => {
  const state = stateFor({ orders: [order('BUY', now - 9999)] });
  assert.equal(signal(state).side, null);
  state.orders = [order('BUY', now - 10000)];
  assert.equal(signal(state).side, 'BUY');
  state.position = owned(); state.orders = [order('BUY', now - 9999)];
  assert.equal(signal(state).side, null);
  state.orders = [order('BUY', now - 10000)];
  assert.equal(signal(state).side, 'BUY');
});

test('flat exit cooldown and rolling buy cap prevent re-entry, not protective exits', () => {
  const state = stateFor({ orders: [order('SELL', now - 29999)] });
  assert.equal(signal(state).side, null);
  state.orders = [order('SELL', now - 30000)]; assert.equal(signal(state).side, 'BUY');
  state.orders = Array.from({ length: 60 }, (_, index) => order('BUY', now - 60000 - index * 1000));
  assert.equal(signal(state).side, null);
  state.position = owned({ entryPrice: 100500 }); state.tacticalSamples = [];
  assert.equal(signal(state).side, 'SELL');
});

test('additions require continuation, a rising profitable holding, unused budget and fewer than three batches', () => {
  const position = owned(); const state = stateFor({ position, orders: [order('BUY')] });
  const addition = signal(state);
  assert.equal(addition.side, 'BUY'); assert.equal(addition.batchUsdt, 25); assert.equal(addition.batchIndex, 2);
  for (const patch of [{ batches: 3 }, { adopted: true }, { deployedUsdt: 100 },
    { lastEntryPrice: 100000 }, { entryPrice: 100001 }]) {
    assert.equal(signal(stateFor({ position: { ...position, ...patch }, orders: [order('BUY')] })).side, null);
  }
});

test('the last tranche never exceeds remaining total deployment and its amount is floored to cents', () => {
  const position = owned({ batches: 2, deployedUsdt: 75.009 });
  const next = signal(stateFor({ position, orders: [order('BUY')] }));
  assert.equal(next.side, 'BUY'); assert.equal(next.batchIndex, 3);
  assert.equal(next.batchUsdt, 24.99); assert.ok(next.batchUsdt + position.deployedUsdt <= 100);
});

test('risk exits use the sellable bid, run during momentum warmup and ignore entry-only conditions', () => {
  const state = stateFor({ position: owned({ entryPrice: 100000 }), tacticalSamples: [] });
  assert.equal(signal(state, book(99810, 11)).side, 'SELL'); // Bid 99799 breaches -0.2%; midpoint does not.
  assert.equal(signal(state, book(100310, 11)).side, null); // Bid 100299 has not reached +0.3%.
  assert.equal(signal(state, book(100320, 11)).side, 'SELL');
  state.position.openedAt = now - 180000;
  assert.equal(signal(state).side, 'SELL');
});

test('protective exits may bypass the 10-second gap but an unresolved order always blocks them', () => {
  const state = stateFor({ position: owned({ entryPrice: 100500 }),
    tacticalSamples: [], orders: [order('BUY', now - 1000)] });
  assert.equal(signal(state).side, 'SELL');
  state.pending = { side: 'BUY', clientOrderId: 'synthetic-pending' };
  assert.equal(signal(state).side, null);
});

test('legacy owned positions remain protected without tranche metadata, but cannot be added to', () => {
  const legacy = { quantity: 0.00025, entryPrice: 99900, openedAt: now - 60000 };
  const state = stateFor({ position: legacy, orders: [order('BUY')] });
  assert.equal(signal(state).side, null);
  state.position.entryPrice = 100500; state.tacticalSamples = [];
  assert.equal(signal(state).side, 'SELL');
});

test('migration to tactical is conservative for prior holdings and rejects unresolved orders', () => {
  const previousConfig = bot.readConfig({ TESTNET_STRATEGY: 'cycle' });
  const previous = { ...bot.initialState(previousConfig, 'synthetic-unit-key'),
    position: { quantity: 0.00025, entryPrice: 100000, openedAt: now - 60000 }, orders: [order('BUY')] };
  const before = structuredClone(previous);
  const adopted = bot.adoptStrategyState(previous, config(), 'synthetic-unit-key', now);
  assert.equal(adopted.strategy, 'tactical'); assert.equal(adopted.position.adopted, true);
  assert.equal(adopted.position.batches, 3); assert.equal(adopted.position.openedAt, previous.position.openedAt);
  assert.deepEqual(adopted.orders, previous.orders); assert.deepEqual(adopted.tacticalSamples, []);
  assert.deepEqual(previous, before);
  assert.throws(() => bot.adoptStrategyState({ ...previous, pending: { side: 'BUY' } }, config(), 'synthetic-unit-key', now));
});

test('short-term downward momentum exits owned holdings without requiring a new closed candle', () => {
  const state = stateFor({ position: owned({ batches: 3 }), lastCandle: up.at(-1).time,
    tacticalSamples: [
      { time: now - 30000, price: 100100 }, { time: now - 20000, price: 100080 },
      { time: now - 10000, price: 100040 }, { time: now, price: 100000 }
    ] });
  assert.equal(signal(state).side, 'SELL');
});

const symbolInfo = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'], quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true }
  ]
};

function exchange(clock, currentPrice, { loseResponse = false } = {}) {
  const calls = []; const orders = new Map(); let nextId = 900; let lost = false;
  return {
    calls, syncTime: async () => clock(),
    request: async (method, path, params = {}) => {
      calls.push({ method, path, params });
      if (path.endsWith('/klines')) {
        const closes = [...Array(92).fill(99900), ...up.map(candle => candle.close)];
        const boundary = Math.floor(clock() / 60000) * 60000;
        return closes.map((close, index) => [boundary - (100 - index) * 60000, '1', '1', '1', String(close), '1', boundary - (99 - index) * 60000 - 1]);
      }
      if (path.endsWith('/exchangeInfo')) return { symbols: [symbolInfo] };
      if (path.endsWith('/bookTicker')) return book(currentPrice());
      if (path.endsWith('/price')) return { price: String(currentPrice()) };
      if (path.endsWith('/account')) return { canTrade: true, balances: [
        { asset: 'BTC', free: '1.1', locked: '0' }, { asset: 'USDT', free: '10000', locked: '0' }
      ] };
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/order') && method === 'POST') {
        const executedQty = params.quantity || (Number(params.quoteOrderQty) / currentPrice()).toFixed(8);
        const quote = params.quoteOrderQty || String(Number(executedQty) * currentPrice());
        const fill = { symbol: 'BTCUSDT', side: params.side, clientOrderId: params.newClientOrderId,
          orderId: ++nextId, status: 'FILLED', executedQty, cummulativeQuoteQty: quote, transactTime: clock() };
        orders.set(fill.orderId, fill);
        if (loseResponse && !lost) { lost = true; throw new Error('synthetic response lost'); }
        return fill;
      }
      if (path.endsWith('/order')) return [...orders.values()].find(fill => fill.clientOrderId === params.origClientOrderId);
      if (path.endsWith('/myTrades')) return [...orders.values()]
        .filter(fill => !params.orderId || fill.orderId === params.orderId)
        .map(fill => ({ id: fill.orderId, orderId: fill.orderId, qty: fill.executedQty,
          quoteQty: fill.cummulativeQuoteQty, price: String(Number(fill.cummulativeQuoteQty) / Number(fill.executedQty)),
          isBuyer: fill.side === 'BUY', commissionAsset: 'BTC', commission: '0', time: fill.transactTime }));
      throw new Error(`unexpected synthetic route ${path}`);
    }
  };
}

test('tactical preview remains read-only, including samples, and cannot add a manual trade shortcut', async () => {
  const cfg = config(); const client = exchange(() => now, () => 100000); const state = stateFor();
  const before = structuredClone(state);
  const result = await bot.runCycle(client, cfg, state, () => assert.fail('preview persisted'), false, { now });
  assert.equal(result.side, 'BUY'); assert.deepEqual(state, before);
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
  await assert.rejects(bot.runCycle(client, cfg, state, async () => {}, true, { now, manualBuy: true }), /禁止额外手动/);
});

test('tactical stages at most 25/25/50 USDT, accumulates quantity and retains original opening time', async t => {
  let clock = now; let price = 100000; t.mock.method(Date, 'now', () => clock);
  const cfg = config(); const client = exchange(() => clock, () => price); const state = stateFor(); const saved = [];
  const run = () => bot.runCycle(client, cfg, state, async value => saved.push(structuredClone(value)), true, { now: clock });
  await run();
  assert.ok(saved.some(value => value.pending?.side === 'BUY')); assert.equal(state.position.batches, 1);
  const firstQty = state.position.quantity; const openedAt = state.position.openedAt;
  clock += 9999; price = 100020; await run();
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  clock += 1; await run();
  assert.equal(state.position.batches, 2); assert.ok(state.position.quantity > firstQty);
  assert.equal(state.position.openedAt, openedAt); assert.equal(state.position.deployedUsdt, 50);
  clock += 10000; price = 100040; await run();
  assert.equal(state.position.batches, 3); assert.equal(state.position.deployedUsdt, 100);
  assert.equal(state.position.openedAt, openedAt);
  clock += 10000; price = 100060; await run();
  const posts = client.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => call.params.quoteOrderQty), ['25.00', '25.00', '50.00']);
  assert.equal(new Set(posts.map(call => call.params.newClientOrderId)).size, 3);
});

test('tactical protects only robot-owned quantity, persists order intent before POST and never catches up slots', async t => {
  t.mock.method(Date, 'now', () => now);
  const cfg = config(); const state = stateFor({ position: owned({ entryPrice: 100500 }), tacticalSamples: [] });
  const client = exchange(() => now, () => 100000); const saved = [];
  await bot.runCycle(client, cfg, state, async value => saved.push(structuredClone(value)), true, { now });
  const sell = client.calls.find(call => call.method === 'POST');
  assert.equal(sell.params.side, 'SELL'); assert.equal(sell.params.quantity, '0.00025000');
  assert.ok(saved.some(value => value.pending?.side === 'SELL')); assert.equal(state.position, null);
  await bot.runCycle(client, cfg, state, async () => {}, true, { now });
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
});

test('lost tactical BUY response is reconciled once without overwriting the existing tranche or resubmitting', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const cfg = config(); const client = exchange(() => clock, () => 100000, { loseResponse: true });
  const state = stateFor({ position: owned(), orders: [order('BUY')] }); const original = structuredClone(state.position);
  await assert.rejects(bot.runCycle(client, cfg, state, async () => {}, true, { now: clock }));
  assert.ok(state.pending); assert.deepEqual(state.position, original);
  clock += 1000; await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  assert.equal(state.pending, null); assert.ok(state.position.quantity > original.quantity);
  assert.equal(state.position.openedAt, original.openedAt); assert.equal(state.position.batches, 2);
  await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
});

test('tactical settlement accounts for a base-asset fee without losing the prior tranche or its cost', async () => {
  const state = stateFor({ position: owned({ entryPrice: 100000, lastEntryPrice: 100000 }) });
  const previous = structuredClone(state.position);
  const pending = { side: 'BUY', strategy: 'tactical', batchIndex: 2, positionBudget: 100,
    quoteOrderQty: '25.00', clientOrderId: 'synthetic-fee-order', candle: now, reason: 'unit second tranche' };
  const fill = { symbol: 'BTCUSDT', side: 'BUY', clientOrderId: pending.clientOrderId, orderId: 1001,
    status: 'FILLED', executedQty: '0.00025000', cummulativeQuoteQty: '25.00', transactTime: now };
  const client = { request: async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/api/v3/myTrades');
    return [{ orderId: fill.orderId, qty: fill.executedQty, commissionAsset: 'BTC', commission: '0.00000001' }];
  } };
  state.pending = pending;
  await bot.settleOrder(client, state, pending, fill, 'BTC');
  assert.ok(Math.abs(state.position.quantity - 0.00049999) < 1e-12);
  assert.ok(Math.abs(state.position.quantity * state.position.entryPrice - 50) < 1e-8);
  assert.equal(state.position.deployedUsdt, 50); assert.equal(state.position.openedAt, previous.openedAt);
  assert.equal(state.position.batches, 2); assert.equal(state.pending, null);
});

test('malformed fill quantities and fees retain the pending order rather than accepting incomplete proof', async t => {
  const cases = [
    { name: 'non-numeric fill quantity', qty: 'bad', commissionAsset: 'BTC', commission: '0' },
    { name: 'infinite fill quantity', qty: 'Infinity', commissionAsset: 'BTC', commission: '0' },
    { name: 'negative fill quantity', qty: '-0.00025', commissionAsset: 'BTC', commission: '0' },
    { name: 'non-numeric base fee', qty: '0.00025', commissionAsset: 'BTC', commission: 'bad' },
    { name: 'negative quote fee', qty: '0.00025', commissionAsset: 'USDT', commission: '-0.01' },
    { name: 'non-finite third-asset fee', qty: '0.00025', commissionAsset: 'BNB', commission: 'Infinity' },
    { name: 'negative third-asset fee', qty: '0.00025', commissionAsset: 'BNB', commission: '-0.01' }
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const state = stateFor();
    const pending = { side: 'BUY', strategy: 'tactical', batchIndex: 1, positionBudget: 100,
      quoteOrderQty: '25.00', clientOrderId: 'synthetic-malformed-fill', candle: now, reason: 'unit malformed fill' };
    state.pending = pending; const before = structuredClone(state);
    const fill = { symbol: 'BTCUSDT', side: 'BUY', clientOrderId: pending.clientOrderId, orderId: 1002,
      status: 'FILLED', executedQty: '0.00025000', cummulativeQuoteQty: '25.00', transactTime: now };
    const client = { request: async () => [{ orderId: fill.orderId, ...sample }] };
    await assert.rejects(bot.settleOrder(client, state, pending, fill, 'BTC'));
    assert.deepEqual(state, before); assert.equal(state.pending.clientOrderId, pending.clientOrderId);
  });
});

const assertDust = (state, original, soldQty, at) => {
  assert.equal(state.position, null); assert.equal(state.pending, null);
  assert.equal(state.dust.length, 1);
  const remainder = state.dust[0];
  assert.ok(Math.abs(remainder.quantity - (original.quantity - soldQty)) < 1e-12);
  assert.equal(remainder.entryPrice, original.entryPrice); assert.equal(remainder.openedAt, original.openedAt);
  assert.equal(remainder.createdAt, at); assert.equal(typeof remainder.reason, 'string'); assert.ok(remainder.reason.length);
  assert.ok(Math.abs(soldQty + remainder.quantity + (state.position?.quantity ?? 0) - original.quantity) < 1e-12);
};

test('an untradeable lot-size remainder is tracked as owned dust, not retried or topped up with gifted BTC', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const cfg = config(); const original = owned({ quantity: 0.0009996, entryPrice: 100500, deployedUsdt: 100, batches: 3 });
  const state = stateFor({ position: structuredClone(original), tacticalSamples: [], dust: [] });
  const client = exchange(() => clock, () => 100000);
  await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  const sell = client.calls.find(call => call.method === 'POST');
  assert.equal(sell.params.side, 'SELL'); assert.equal(sell.params.quantity, '0.00099000');
  assertDust(state, original, Number(sell.params.quantity), clock);
  clock += 10000;
  await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(state.dust.length, 1);
});

test('a terminal partial sell below minimum notional preserves its residual inventory as dust', async t => {
  t.mock.method(Date, 'now', () => now);
  const cfg = config(); const original = owned({ quantity: 0.001, entryPrice: 100500, deployedUsdt: 100, batches: 3 });
  const state = stateFor({ position: structuredClone(original), tacticalSamples: [], dust: [] });
  const client = exchange(() => now, () => 100000); const request = client.request;
  client.request = async (method, path, params) => {
    const result = await request(method, path, params);
    if (method === 'POST' && path.endsWith('/order')) {
      result.status = 'CANCELED'; result.executedQty = '0.00096000'; result.cummulativeQuoteQty = '96.00';
    }
    return result;
  };
  await bot.runCycle(client, cfg, state, async () => {}, true, { now });
  assertDust(state, original, 0.00096, now);
  assert.ok(state.dust[0].quantity >= 0.00001); // Lot size is legal; notional of 4 USDT is not.
});

test('lost SELL response reconciliation moves dust exactly once without sending another sell', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const cfg = config(); const original = owned({ quantity: 0.0009996, entryPrice: 100500, deployedUsdt: 100, batches: 3 });
  const state = stateFor({ position: structuredClone(original), tacticalSamples: [], dust: [] });
  const client = exchange(() => clock, () => 100000, { loseResponse: true });
  await assert.rejects(bot.runCycle(client, cfg, state, async () => {}, true, { now: clock }));
  assert.ok(state.pending); assert.deepEqual(state.position, original); assert.deepEqual(state.dust, []);
  clock += 1000;
  await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  assertDust(state, original, 0.00099, clock);
  clock += 1000;
  await bot.runCycle(client, cfg, state, async () => {}, true, { now: clock });
  assert.equal(client.calls.filter(call => call.method === 'POST').length, 1); assert.equal(state.dust.length, 1);
});

test('strategy adoption preserves prior owned dust without merging it into the tradable position', () => {
  const priorConfig = bot.readConfig({ TESTNET_STRATEGY: 'cycle' });
  const dust = [{ quantity: 0.0000096, entryPrice: 100000, openedAt: now - 60000, createdAt: now - 30000, reason: 'unit old dust' }];
  const saved = { ...bot.initialState(priorConfig, 'synthetic-unit-key'), position: null, dust };
  const before = structuredClone(saved);
  const adopted = bot.adoptStrategyState(saved, config(), 'synthetic-unit-key', now);
  assert.deepEqual(adopted.dust, dust); assert.equal(adopted.position, null); assert.deepEqual(saved, before);
});

test('slow account verification discards a stale tactical signal without creating an order', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const cfg = config(); const state = stateFor(); const client = exchange(() => clock, () => 100000);
  const request = client.request;
  client.request = async (method, path, params) => {
    const result = await request(method, path, params);
    if (path.endsWith('/account')) clock += 10001;
    return result;
  };
  await bot.runCycle(client, cfg, state, async () => {}, true);
  assert.equal(client.calls.some(call => call.method === 'POST'), false);
  assert.deepEqual(state.tacticalSamples, []); assert.equal(state.pending, null);
  assert.equal(state.tacticalDecision.side, null);
});

test('tactical retains pending-order and regional/rate refusal stop safeguards', async () => {
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
