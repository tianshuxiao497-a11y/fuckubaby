import test from 'node:test';
import assert from 'node:assert/strict';
import * as bot from '../lib/testnet-bot.mjs';
import { commissionContext } from '../lib/testnet-commission.mjs';

// All exchange responses and credentials below are synthetic. These tests do
// not read environment files, open sockets, start processes or use accounts.
const now = 1_800_000_000_000;
const symbol = 'BTCUSDT';
const config = (patch = {}) => bot.readConfig({ TESTNET_STRATEGY: 'adaptive', TESTNET_ADAPTIVE_PROFILE: 'short', ...patch });
const rates = (taker = '0') => ({ symbol,
  standardCommission: { maker: '0', taker, buyer: '0', seller: '0' },
  taxCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' },
  specialCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' }
});
const book = (mid = 100205) => ({ symbol, bidPrice: String(mid - 0.5), askPrice: String(mid + 0.5), bidQty: '1', askQty: '1' });
const samples = (at = now) => [
  { time: at - 10000, price: 100185 }, { time: at - 5000, price: 100195 }, { time: at, price: 100205 }
];
const stateFor = (patch = {}) => ({ ...bot.initialState(config(), 'synthetic-short-key'), adaptiveSamples: samples(), ...patch });
const rows = (at = now) => {
  const boundary = Math.floor(at / 60000) * 60000;
  return Array.from({ length: 100 }, (_, index) => {
    const close = 100000 + index * 2;
    const time = boundary - (100 - index) * 60000;
    return [time, String(close - 1), String(close + 11.25), String(close - 11.25), String(close), '100',
      time + 59999, String(close * 100), 100, '70', String(close * 70), '0'];
  });
};
const symbolInfo = { symbol, baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'], quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '1000.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '1000.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true }
  ] };

function exchange(clock, price, options = {}) {
  const calls = []; const orders = new Map(); let nextId = 19000; let feeReads = 0; let bookReads = 0; let lost = false;
  const client = { apiKey: 'synthetic-short-key', calls, orders, syncTime: async () => clock(),
    request: async (method, path, params = {}, signed = false) => {
      const call = { method, path, params: structuredClone(params), signed };
      calls.push(call);
      if (path.endsWith('/klines')) return rows(clock());
      if (path.endsWith('/exchangeInfo')) return { symbols: [symbolInfo] };
      if (path.endsWith('/bookTicker')) return options.book?.(++bookReads) ?? book(price());
      if (path.endsWith('/price')) return { price: String(price()) };
      if (path.endsWith('/account/commission')) {
        assert.equal(method, 'GET'); assert.equal(signed, true); assert.equal(params.symbol, symbol);
        return options.commission?.(++feeReads) ?? rates();
      }
      if (path.endsWith('/account')) {
        options.account?.();
        return { canTrade: true, balances: [
          { asset: 'BTC', free: '1.1', locked: '0' }, { asset: 'USDT', free: '10000', locked: '0' }
        ] };
      }
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/order') && method === 'POST') {
        options.beforePost?.(call);
        const executedQty = params.quantity || (Number(params.quoteOrderQty) / price()).toFixed(8);
        const fill = { symbol, side: params.side, clientOrderId: params.newClientOrderId, orderId: ++nextId,
          status: 'FILLED', executedQty, cummulativeQuoteQty: params.quoteOrderQty || String(Number(executedQty) * price()),
          transactTime: clock() };
        orders.set(fill.orderId, fill);
        if (options.loseResponse && !lost) { lost = true; throw new Error('synthetic short response lost'); }
        return fill;
      }
      if (path.endsWith('/order')) return [...orders.values()].find(fill => fill.clientOrderId === params.origClientOrderId);
      if (path.endsWith('/myTrades')) return [...orders.values()].filter(fill => !params.orderId || fill.orderId === params.orderId)
        .map(fill => ({ id: fill.orderId, orderId: fill.orderId, qty: fill.executedQty, quoteQty: fill.cummulativeQuoteQty,
          price: String(Number(fill.cummulativeQuoteQty) / Number(fill.executedQty)), isBuyer: fill.side === 'BUY',
          commissionAsset: 'BTC', commission: '0', time: fill.transactTime }));
      throw new Error(`Unexpected synthetic short route ${method} ${path}`);
    }
  };
  return client;
}
const posts = client => client.calls.filter(call => call.method === 'POST');
const feeCalls = client => client.calls.filter(call => call.path.endsWith('/account/commission'));
const verified = (at = now, fee = '0') => commissionContext(rates(fee), symbol, at);

test('short profile is explicit, bounded and requires a preserved-history migration', () => {
  const cfg = config();
  assert.equal(cfg.adaptiveProfile, 'short'); assert.equal(cfg.maxHoldMinutes, 3);
  assert.equal(cfg.pollSeconds, 5); assert.equal(cfg.stopLoss, 0.15); assert.equal(cfg.takeProfit, 0.15);
  assert.equal(cfg.minNetEdgePercent, 0.01); assert.equal(cfg.softHoldMinutes, 1);
  assert.equal(bot.initialState(cfg, 'synthetic-short-key').adaptiveProfile, 'short');
  for (const patch of [{ TESTNET_ADAPTIVE_PROFILE: 'fastest' }, { TESTNET_MAX_HOLD_MINUTES: '4' },
    { TESTNET_POLL_SECONDS: '4' }, { TESTNET_POLL_SECONDS: '11' }, { TESTNET_TRADE_USDT: '101' }]) assert.throws(() => config(patch));
  const risk = { dayUtc: new Date(now).toISOString().slice(0, 10), realizedUsdt: -1, consecutiveLosses: 1, lastLossAt: now - 60000 };
  const stats = { startedAt: now - 60000, checks: 8, lastCheckedAt: now - 5000, lastOrderAt: null, waitReasons: { old: 8 } };
  const previous = { ...bot.initialState(bot.readConfig({ TESTNET_STRATEGY: 'adaptive' }), 'synthetic-short-key'),
    dailyRisk: risk, adaptiveStats: stats, adaptiveSamples: samples(), orders: [{ side: 'SELL', time: now - 60000 }] };
  const before = structuredClone(previous);
  const adopted = bot.adoptStrategyState(previous, cfg, 'synthetic-short-key', now);
  assert.equal(adopted.adaptiveProfile, 'short'); assert.deepEqual(adopted.orders, previous.orders);
  assert.deepEqual(adopted.dailyRisk, risk); assert.deepEqual(adopted.adaptiveStats, stats);
  assert.deepEqual(adopted.adaptiveSamples, []); assert.deepEqual(previous, before);
  assert.throws(() => bot.adoptStrategyState({ ...previous, pending: {} }, cfg, 'synthetic-short-key', now));
});

test('current low-volatility proxy can pass verified-zero short fees but not standard assumed fees', async t => {
  t.mock.method(Date, 'now', () => now);
  const cfg = config(); const state = stateFor(); const saved = [];
  const client = exchange(() => now, () => 100205, { beforePost: call => {
    assert.equal(saved.at(-1).pending.clientOrderId, call.params.newClientOrderId);
  } });
  const result = await bot.runCycle(client, cfg, state, async value => saved.push(structuredClone(value)), true, { now });
  assert.equal(posts(client).length, 1); assert.equal(posts(client)[0].params.side, 'BUY');
  assert.equal(posts(client)[0].params.quoteOrderQty, '40.00');
  assert.ok(result.adaptive.thresholds.opportunityProxyPercent > 0.08);
  assert.ok(result.adaptive.thresholds.opportunityProxyPercent < 0.10);
  assert.equal(result.adaptive.thresholds.feeVerified, true);
  assert.equal(state.position.riskSnapshot.costSnapshot.buyFeePercent, 0);
  assert.equal(state.position.riskSnapshot.costSnapshot.sellFeePercent, 0);
  assert.equal(state.adaptiveStats.checks, 1); assert.equal(state.adaptiveStats.lastOrderAt, now);
  const standardConfig = bot.readConfig({ TESTNET_STRATEGY: 'adaptive' });
  const standardState = { ...bot.initialState(standardConfig, 'synthetic-short-key'), adaptiveSamples: samples() };
  const standardClient = exchange(() => now, () => 100205);
  const standardResult = await bot.runCycle(standardClient, standardConfig, standardState, async () => {}, true, { now });
  assert.equal(posts(standardClient).length, 0); assert.equal(feeCalls(standardClient).length, 0);
  assert.match(standardResult.adaptive.reason, /cost|volatility/i);
});

test('short preview can read signed fees but never mutates state or creates an order', async t => {
  t.mock.method(Date, 'now', () => now);
  const state = stateFor(); const before = structuredClone(state);
  const client = exchange(() => now, () => 100205);
  const result = await bot.runCycle(client, config(), state, () => assert.fail('preview persisted'), false, { now });
  assert.equal(result.side, 'BUY'); assert.equal(result.thresholds.feeVerified, true);
  assert.ok(feeCalls(client).length > 0); assert.equal(posts(client).length, 0); assert.deepEqual(state, before);
  const publicClient = exchange(() => now, () => 100205); delete publicClient.apiKey;
  const publicResult = await bot.runCycle(publicClient, config(), state, () => assert.fail('public preview persisted'), false, { now });
  assert.equal(publicResult.side, null); assert.equal(publicResult.thresholds.feeVerified, false);
  assert.equal(feeCalls(publicClient).length, 0); assert.deepEqual(state, before);
});

test('nonzero commission and commission refresh failures cannot create a short BUY', async t => {
  t.mock.method(Date, 'now', () => now);
  const charged = exchange(() => now, () => 100205, { commission: () => rates('0.001') });
  const state = stateFor();
  const result = await bot.runCycle(charged, config(), state, async () => {}, true, { now });
  assert.equal(posts(charged).length, 0); assert.equal(state.pending, null);
  assert.match(result.adaptive.reason, /cost|volatility/i);
  const unavailable = exchange(() => now, () => 100205, { commission: () => { throw new Error('synthetic fee outage'); } });
  const unknown = stateFor();
  await assert.rejects(bot.runCycle(unavailable, config(), unknown, async () => {}, true, { now }), /synthetic fee outage/);
  assert.equal(posts(unavailable).length, 0); assert.equal(unknown.pending, null);
});

test('each prospective BUY forcibly refreshes fees and book, so a raised fee blocks an otherwise valid candidate', async t => {
  t.mock.method(Date, 'now', () => now);
  const state = stateFor({ adaptiveFeeContext: verified() });
  const client = exchange(() => now, () => 100205, { commission: () => rates('0.001') });
  await bot.runCycle(client, config(), state, async () => {}, true, { now });
  assert.ok(feeCalls(client).length >= 1); assert.equal(posts(client).length, 0); assert.equal(state.pending, null);
  assert.equal(state.adaptiveDecision.thresholds.feeVerified, true);
  assert.ok(state.adaptiveDecision.thresholds.buyFeePercent >= 0.1);
  const changing = exchange(() => now, () => 100205, { commission: read => rates(read === 1 ? '0' : '0.001') });
  await bot.runCycle(changing, config(), stateFor(), async () => {}, true, { now });
  assert.ok(feeCalls(changing).length >= 2); assert.equal(posts(changing).length, 0);
});

test('a fresh book invalidates a candidate if the price weakens after account verification', async t => {
  t.mock.method(Date, 'now', () => now);
  const state = stateFor({ adaptiveFeeContext: verified() });
  const client = exchange(() => now, () => 100205, { book: read => book(read === 1 ? 100205 : 100150) });
  await bot.runCycle(client, config(), state, async () => {}, true, { now });
  assert.ok(client.calls.filter(call => call.path.endsWith('/bookTicker')).length >= 2);
  assert.equal(posts(client).length, 0); assert.equal(state.pending, null);
});

test('account verification older than ten seconds discards the short entry before POST', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const state = stateFor({ adaptiveFeeContext: verified() });
  const client = exchange(() => clock, () => 100205, { account: () => { clock += 10001; } });
  await bot.runCycle(client, config(), state, async () => {}, true);
  assert.equal(posts(client).length, 0); assert.equal(state.pending, null); assert.deepEqual(state.adaptiveSamples, []);
  assert.match(state.adaptiveDecision.reason, /ten seconds|stale/i);
});

test('slow pre-BUY commission verification also discards rather than refreshing the signal age', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const state = stateFor({ adaptiveFeeContext: verified() });
  const client = exchange(() => clock, () => 100205, { commission: () => { clock += 10001; return rates(); } });
  await bot.runCycle(client, config(), state, async () => {}, true);
  assert.equal(feeCalls(client).length, 1); assert.equal(posts(client).length, 0);
  assert.equal(state.pending, null); assert.deepEqual(state.adaptiveSamples, []);
  assert.match(state.adaptiveDecision.reason, /ten seconds|stale/i);
});

test('flat cached fees refresh after sixty seconds while a newer cache still requires pre-BUY verification', async t => {
  t.mock.method(Date, 'now', () => now);
  const state = stateFor({ adaptiveSamples: [], adaptiveFeeContext: verified(now - 60001) });
  const client = exchange(() => now, () => 100205);
  await bot.runCycle(client, config(), state, async () => {}, true, { now });
  assert.equal(posts(client).length, 0); assert.ok(feeCalls(client).length >= 1);
  assert.equal(state.adaptiveFeeContext.checkedAt, now);
  const recent = stateFor({ adaptiveSamples: [], adaptiveFeeContext: verified(now - 59999) });
  const recentClient = exchange(() => now, () => 100205);
  await bot.runCycle(recentClient, config(), recent, async () => {}, true, { now });
  assert.equal(posts(recentClient).length, 0); assert.equal(feeCalls(recentClient).length, 0);
});

test('three-minute protective SELL bypasses commission endpoint failure, expired cache and entry loss caps', async t => {
  t.mock.method(Date, 'now', () => now);
  const state = stateFor({ adaptiveSamples: [], adaptiveFeeContext: verified(now - 300001),
    dailyRisk: { dayUtc: new Date(now).toISOString().slice(0, 10), realizedUsdt: -5, consecutiveLosses: 3, lastLossAt: now - 1000 },
    position: { quantity: 0.0003, entryPrice: 100205, openedAt: now - 180000, deployedUsdt: 30.0615,
      batches: 3, lastEntryPrice: 100205, adopted: true, feeValuationComplete: true,
      riskSnapshot: { stopLossPercent: 1, takeProfitPercent: 1 } } });
  const client = exchange(() => now, () => 100205, { commission: () => assert.fail('protective SELL queried commission') });
  const result = await bot.runCycle(client, config(), state, async () => {}, true, { now });
  assert.equal(feeCalls(client).length, 0); assert.equal(posts(client).length, 1);
  assert.equal(posts(client)[0].params.side, 'SELL'); assert.equal(posts(client)[0].params.quantity, '0.00030000');
  assert.equal(state.position, null); assert.match(result.reason, /maximum holding time/i);
});

test('first-entry cost assumptions remain detached and frozen through profitable staged additions', async t => {
  let clock = now; let price = 100205; let rawFee = '0'; let firstIntent;
  t.mock.method(Date, 'now', () => clock);
  const state = stateFor(); const client = exchange(() => clock, () => price, { commission: () => rates(rawFee) });
  const run = () => bot.runCycle(client, config(), state, async value => {
    if (value.pending?.side === 'BUY') firstIntent ??= value.pending;
  }, true, { now: clock });
  await run(); const frozen = structuredClone(state.position.riskSnapshot);
  assert.equal(frozen.costSnapshot.buyFeePercent, 0);
  firstIntent.riskSnapshot.costSnapshot.buyFeePercent = 0.8;
  assert.deepEqual(state.position.riskSnapshot, frozen);
  clock += 5000; price = 100245; rawFee = '0.00001'; await run();
  assert.equal(state.position.batches, 2); assert.equal(state.position.deployedUsdt, 70);
  assert.deepEqual(state.position.riskSnapshot, frozen);
  clock += 5000; price = 100285; await run();
  assert.equal(state.position.batches, 3); assert.equal(state.position.deployedUsdt, 100);
  assert.deepEqual(state.position.riskSnapshot, frozen);
  assert.deepEqual(posts(client).map(call => call.params.quoteOrderQty), ['40.00', '30.00', '30.00']);
});

test('lost BUY reconciliation restores its saved cost snapshot without a new commission request or POST', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  let feesAvailable = true;
  const state = stateFor(); const client = exchange(() => clock, () => 100205, {
    loseResponse: true, commission: () => {
      assert.equal(feesAvailable, true, 'pending reconciliation queried commission'); return rates();
    }
  });
  await assert.rejects(bot.runCycle(client, config(), state, async () => {}, true, { now: clock }), /response lost/);
  const pending = structuredClone(state.pending); const callsBefore = client.calls.length;
  assert.equal(pending.riskSnapshot.costSnapshot.verified, true); assert.equal(posts(client).length, 1);
  feesAvailable = false; clock += 1000;
  await bot.runCycle(client, config(), state, async () => {}, true, { now: clock });
  assert.equal(state.pending, null); assert.equal(state.position.batches, 1);
  assert.deepEqual(state.position.riskSnapshot, pending.riskSnapshot);
  assert.deepEqual(state.orders[0].decisionSnapshot, pending.decisionSnapshot);
  assert.equal(state.adaptiveStats.lastOrderAt, clock);
  assert.equal(posts(client).length, 1);
  assert.equal(client.calls.slice(callsBefore).some(call => call.path.endsWith('/account/commission')), false);
});

test('daily conservative risk uses entry-frozen verified fees rather than always deducting 0.24 percent', async t => {
  t.mock.method(Date, 'now', () => now);
  const costSnapshot = { buyFeePercent: 0, sellFeePercent: 0, slippagePerSidePercent: 0.02,
    source: 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION', checkedAt: now - 60000, verified: true };
  const state = stateFor({ dailyRisk: { dayUtc: new Date(now).toISOString().slice(0, 10),
    realizedUsdt: -1, consecutiveLosses: 1, lastLossAt: now - 60000 },
  position: { quantity: 0.0004, entryPrice: 100000, openedAt: now - 60000, deployedUsdt: 40,
    batches: 1, lastEntryPrice: 100000, feeValuationComplete: true,
    riskSnapshot: { stopLossPercent: 0.15, takeProfitPercent: 0.15, costSnapshot } } });
  const pending = { side: 'SELL', strategy: 'adaptive', clientOrderId: 'synthetic-short-settlement', candle: now, reason: 'synthetic short risk accounting' };
  const order = { symbol, side: 'SELL', clientOrderId: pending.clientOrderId, orderId: 22001, status: 'FILLED',
    executedQty: '0.0004', cummulativeQuoteQty: '40', transactTime: now };
  const client = { request: async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/api/v3/myTrades');
    return [{ orderId: order.orderId, qty: '0.0004', commissionAsset: 'BTC', commission: '0' }];
  } };
  state.pending = pending;
  await bot.settleOrder(client, state, pending, order, 'BTC');
  assert.equal(state.orders[0].realizedUsdt, 0); assert.equal(state.orders[0].realizedPnlComplete, true);
  assert.ok(Math.abs(state.dailyRisk.realizedUsdt - (-1.016)) < 1e-10);
  assert.equal(state.dailyRisk.consecutiveLosses, 2); assert.equal(state.pending, null);
});

test('enabled WAIT records reason counts while preserving prior stats and loss records', async t => {
  t.mock.method(Date, 'now', () => now);
  const dailyRisk = { dayUtc: new Date(now).toISOString().slice(0, 10), realizedUsdt: -0.1, consecutiveLosses: 1, lastLossAt: now - 120000 };
  const stats = { startedAt: now - 120000, checks: 7, lastCheckedAt: now - 5000, lastOrderAt: now - 60000, waitReasons: { previous: 7 } };
  const state = stateFor({ adaptiveStats: structuredClone(stats), dailyRisk });
  const client = exchange(() => now, () => 100205, { commission: () => rates('0.001') });
  const result = await bot.runCycle(client, config(), state, async () => {}, true, { now });
  assert.equal(state.adaptiveStats.checks, 8); assert.equal(state.adaptiveStats.startedAt, stats.startedAt);
  assert.equal(state.adaptiveStats.lastOrderAt, stats.lastOrderAt); assert.equal(state.adaptiveStats.lastCheckedAt, now);
  assert.equal(state.adaptiveStats.waitReasons.previous, 7);
  assert.equal(state.adaptiveStats.waitReasons[result.adaptive.reason], 1); assert.deepEqual(state.dailyRisk, dailyRisk);
});

test('commission route is signed read-only and cannot escape the fixed Testnet origin', async t => {
  t.mock.method(Date, 'now', () => now);
  const seen = [];
  const client = new bot.TestnetClient({ apiKey: 'synthetic-short-key', apiSecret: 'synthetic-short-secret', allowOrders: false,
    fetchImpl: async (url, options) => { seen.push({ url: new URL(url), options }); return new Response(JSON.stringify(rates()), { status: 200 }); }
  });
  await client.request('GET', '/api/v3/account/commission', { symbol }, true);
  assert.equal(seen.length, 1); assert.equal(seen[0].url.origin, bot.TESTNET_ORIGIN);
  assert.equal(seen[0].url.pathname, '/api/v3/account/commission'); assert.equal(seen[0].options.method, 'GET');
  assert.equal(seen[0].options.redirect, 'error'); assert.equal(seen[0].url.searchParams.get('symbol'), symbol);
  assert.ok(seen[0].url.searchParams.get('signature')); assert.ok(seen[0].url.searchParams.get('timestamp'));
  assert.equal(seen[0].options.headers['X-MBX-APIKEY'], 'synthetic-short-key');
  await assert.rejects(client.request('POST', '/api/v3/account/commission', { symbol }, true));
  await assert.rejects(client.request('GET', 'https://api.binance.com/api/v3/account/commission', { symbol }, true));
  assert.equal(seen.length, 1);
});
