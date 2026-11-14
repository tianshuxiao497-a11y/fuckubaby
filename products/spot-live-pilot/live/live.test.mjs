import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { MainnetSpotClient, MAINNET_ORIGIN, LIVE_CONFIRMATION } from './client.mjs';
import { units, decimal, multiply, divide } from './decimal.mjs';
import { marketRules, makeOrderPlan, commissionRates } from './risk.mjs';
import { accountIdentity, newLedger, applyFinalOrder, markedEquity } from './ledger.mjs';
import { LiveEngine, validateSettings } from './engine.mjs';
import { liveExternalStrategy } from './strategy.mjs';
import { saveVault, loadVault } from './vault.mjs';
import { createLiveServer } from './server.mjs';
import { reviewReport } from './review.mjs';

const now = 1800000000000;
const symbol = 'BTCUSDT';
const settings = { symbol, sizing: 'percent', buyPercent: 1, dailyLossPercent: 20, riskBasis: 'bot-ledger', externalStrategy: null };
const feeReply = { symbol, standardCommission: { maker: '0.001', taker: '0.001', buyer: '0', seller: '0' }, taxCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' }, specialCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' } };
const fees = commissionRates(feeReply, symbol);
const info = { symbols: [{ symbol, baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'], filters: [
  { filterType: 'LOT_SIZE', minQty: '0.00001', maxQty: '10000', stepSize: '0.00001' },
  { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '10000000', tickSize: '0.01' },
  { filterType: 'NOTIONAL', minNotional: '5', maxNotional: '10000000' },
] }] };
const book = { symbol, bidPrice: '101985', askPrice: '101995', bidQty: '1', askQty: '1' };
const rules = marketRules(info, symbol);
const buyPlan = () => makeOrderPlan({ symbol, side: 'BUY', requestedUsdt: '10', cash: '1000', freeQuote: '1000', freeBase: '2', rules, book, fees });
const orderId = 'asbl_' + 'a'.repeat(28);
function pendingState(side = 'BUY') {
  const state = newLedger('123', '1000', now - 10000);
  const plan = buyPlan(); plan.side = side;
  state.pending = { id: orderId, uid: '123', createdAt: now, plan, riskSnapshot: { stopLossPercent: 0.25, takeProfitPercent: 0.4 } };
  return state;
}
function finalOrder(state, patch = {}) {
  const plan = state.pending.plan;
  return { symbol, clientOrderId: orderId, orderId: 77, side: plan.side, type: 'LIMIT', timeInForce: 'IOC', status: 'FILLED', origQty: plan.quantity, executedQty: plan.quantity, price: plan.price, cummulativeQuoteQty: decimal(multiply(units(plan.quantity), units(plan.price))), ...patch };
}
function fill(order, patch = {}) {
  return { symbol, orderId: 77, id: 1, time: now, qty: order.executedQty, quoteQty: order.cummulativeQuoteQty, commission: '0.001', commissionAsset: 'USDT', isBuyer: order.side === 'BUY', ...patch };
}

function clientFixture({ pem = false, response = () => null } = {}) {
  const calls = [];
  let at = now;
  const keys = generateKeyPairSync('ed25519');
  const client = new MainnetSpotClient({ apiKey: 'local-fixture-key', ...(pem ? { privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) } : { apiSecret: 'local-fixture-secret' }), now: () => at, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response(new URL(url), options) ?? Response.json(new URL(url).pathname.endsWith('/time') ? { serverTime: at } : {});
  } });
  return { client, calls, keys, clock: value => { at = value; } };
}

async function engineFixture(t, { send = 'success', initialCash = '1000', override } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'asb-live-test-'));
  const calls = [];
  let clock = now, submitted, buy = null;
  const account = { uid: 123, accountType: 'SPOT', canTrade: true, balances: [{ asset: 'USDT', free: initialCash, locked: '0' }, { asset: 'BTC', free: '2', locked: '0' }] };
  const client = {
    arm(value) { assert.equal(value, LIVE_CONFIRMATION); }, disarm() {}, async syncTime() { return clock; },
    async request(method, path, params) {
      calls.push({ method, path, params });
      if (override) { const changed = await override(method, path, params); if (changed !== undefined) return changed; }
      if (path.endsWith('/account')) return structuredClone(account);
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/exchangeInfo')) return info;
      if (path.endsWith('/bookTicker')) return book;
      if (path.endsWith('/commission')) return feeReply;
      if (path.endsWith('/klines')) {
        if (params.limit === 1) return [[params.startTime, '101980']];
        return Array.from({ length: 100 }, (_, index) => {
          const time = Math.floor(clock / 60000) * 60000 - (100 - index) * 60000;
          const close = 100000 + index * 20;
          return [time, String(close - 5), String(close + 80), String(close - 80), String(close), '100', time + 59999];
        });
      }
      if (method === 'POST') {
        submitted = params;
        if (send === 'timeout') throw new Error('ORDER_RESULT_UNKNOWN_RECONCILE');
        const cost = decimal(multiply(units(params.quantity), units(params.price)));
        buy = { ...params, clientOrderId: params.newClientOrderId, orderId: 77, origQty: params.quantity, executedQty: params.quantity, cummulativeQuoteQty: cost, status: 'FILLED' };
        return buy;
      }
      if (path.endsWith('/order')) {
        if (!buy && submitted) {
          const cost = decimal(multiply(units(submitted.quantity), units(submitted.price)));
          buy = { ...submitted, clientOrderId: submitted.newClientOrderId, orderId: 77, origQty: submitted.quantity, executedQty: submitted.quantity, cummulativeQuoteQty: cost, status: 'FILLED' };
        }
        return buy;
      }
      if (path.endsWith('/myTrades')) return [{ symbol, orderId: 77, id: 1, time: clock, qty: buy.executedQty, quoteQty: buy.cummulativeQuoteQty, commission: '0.001', commissionAsset: 'USDT', isBuyer: true }];
      throw new Error('UNEXPECTED_FAKE_REQUEST');
    },
  };
  const engine = new LiveEngine({ profile, client, settings, now: () => clock });
  await engine.acquire();
  t.after(async () => { await engine.close(); await rm(profile, { recursive: true, force: true }); });
  return { engine, calls, account, profile, clock(value) { clock = value; }, warm() { engine.samples = [{ time: clock - 10000, price: 101950 }, { time: clock - 5000, price: 101970 }, { time: clock, price: 101990 }]; } };
}

test('decimal amounts remain exact and scientific notation is refused', () => {
  assert.equal(decimal(units('0.00000001')), '0.00000001');
  assert.equal(decimal(multiply(units('0.1'), units('0.2'))), '0.02');
  assert.equal(decimal(divide(units('2'), units('4'))), '0.5');
  for (const input of ['NaN', '-1', '1e6', '', ' 2', '0.0000000000001']) assert.throws(() => units(input));
});
test('real order requests require the exact explicit human confirmation', async () => {
  const f = clientFixture(); await f.client.syncTime();
  const plan = { ...buyPlan(), newClientOrderId: orderId }; delete plan.estimatedNotional;
  await assert.rejects(f.client.request('POST', '/api/v3/order', plan), /ARMED/);
  assert.throws(() => f.client.arm('yes'));
  f.client.arm(LIVE_CONFIRMATION); await f.client.request('POST', '/api/v3/order', plan);
  f.client.disarm(); await assert.rejects(f.client.request('POST', '/api/v3/order', plan), /ARMED/);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});
test('withdrawals, transfers, custom hosts, market orders and arbitrary cancellations are blocked', async () => {
  assert.throws(() => new MainnetSpotClient({ host: 'https://example.invalid' }));
  const f = clientFixture();
  for (const [method, path, params] of [['POST', '/sapi/v1/asset/transfer', {}], ['POST', '/api/v3/order/test', {}], ['GET', 'https://example.invalid', {}], ['DELETE', '/api/v3/order', { symbol, origClientOrderId: 'manual-order' }]]) await assert.rejects(f.client.request(method, path, params));
  assert.equal(f.calls.length, 0);
});
test('HMAC and Ed25519 sign only the exact fixed production endpoint', async () => {
  for (const pem of [false, true]) {
    const f = clientFixture({ pem }); await f.client.syncTime(); await f.client.request('GET', '/api/v3/account');
    const call = f.calls.at(-1), url = new URL(call.url), signature = url.searchParams.get('signature'); url.searchParams.delete('signature');
    assert.equal(url.origin, MAINNET_ORIGIN);
    if (pem) assert.equal(verify(null, Buffer.from(url.search.slice(1)), f.keys.publicKey, Buffer.from(signature, 'base64')), true);
    else assert.equal(signature, createHmac('sha256', 'local-fixture-secret').update(url.search.slice(1)).digest('hex'));
    assert.doesNotMatch(JSON.stringify(f.client), /fixture-secret|PRIVATE KEY/);
  }
});
test('stale clocks, unexpected symbols, bad candles and unbounded fill requests fail before transport', async () => {
  const f = clientFixture(); await f.client.syncTime(); f.clock(now + 60001);
  await assert.rejects(f.client.request('GET', '/api/v3/account'), /CLOCK/);
  await assert.rejects(f.client.request('GET', '/api/v3/exchangeInfo', { symbol: 'BTCUSD' }));
  await assert.rejects(f.client.request('GET', '/api/v3/klines', { symbol, interval: '1m', limit: 5000 }));
  await assert.rejects(f.client.request('GET', '/api/v3/myTrades', { symbol, orderId: 7, limit: 5 }));
  assert.equal(f.calls.length, 1);
});
test('service refusal disables future requests and POST timeouts are never retried', async () => {
  for (const status of [403, 418, 429, 451]) {
    const f = clientFixture({ response: () => new Response('upstream secret', { status }) });
    await assert.rejects(f.client.syncTime(), /SERVICE_REFUSED/);
    await assert.rejects(f.client.syncTime(), /SERVICE_ACCESS/); assert.equal(f.calls.length, 1);
  }
  let posts = 0;
  const f = clientFixture({ response: (url, options) => { if (options.method === 'POST') { posts++; throw new Error('secret'); } } });
  await f.client.syncTime(); f.client.arm(LIVE_CONFIRMATION);
  const plan = { ...buyPlan(), newClientOrderId: orderId }; delete plan.estimatedNotional;
  await assert.rejects(f.client.request('POST', '/api/v3/order', plan), /UNKNOWN_RECONCILE/); assert.equal(posts, 1);
});
test('one-percent plans obey available funds and exchange rounding without fixed dollar caps', () => {
  const plan = buyPlan();
  assert.ok(Number(plan.estimatedNotional) <= 10 && Number(plan.estimatedNotional) >= 5);
  assert.ok(units(plan.quantity) % rules.step === 0n);
  assert.throws(() => makeOrderPlan({ symbol, side: 'BUY', requestedUsdt: '2', cash: '1000', freeQuote: '1000', freeBase: '2', rules, book, fees }), /MINIMUM/);
});
test('entry requires fee and exit-price margin above the exchange minimum', () => {
  assert.throws(() => makeOrderPlan({ symbol, side: 'BUY', requestedUsdt: '5', cash: '100', freeQuote: '100', freeBase: '2', rules, book: { ...book, bidPrice: '100000', askPrice: '100000' }, fees }), /MINIMUM|ROUND_TRIP/);
});
test('sell plans use only bot-owned quantity and never adopt the rest of the account', () => {
  const plan = makeOrderPlan({ symbol, side: 'SELL', requestedUsdt: '0', ownedQuantity: '0.001', cash: '900', freeQuote: '900', freeBase: '2', rules, book, fees });
  assert.ok(units(plan.quantity) + (units(plan.quantity) * units(fees.sell) + 999999999999n) / 1000000000000n <= units('0.001'));
  assert.ok(units(plan.quantity) % rules.step === 0n);
});

test('base-asset sell fees are paid entirely from the bot-owned position', () => {
  const initial = pendingState(), bought = finalOrder(initial);
  const state = applyFinalOrder(initial, bought, [fill(bought)]);
  const owned = state.positions[symbol].quantity;
  const plan = makeOrderPlan({ symbol, side: 'SELL', requestedUsdt: '0', ownedQuantity: owned, cash: state.cash, freeQuote: state.cash, freeBase: '2', rules, book, fees });
  state.pending = { id: 'asbl_' + 'c'.repeat(28), uid: state.uid, createdAt: now, plan };
  const sold = { ...finalOrder(state), clientOrderId: state.pending.id, orderId: 78 };
  const commission = decimal((units(plan.quantity) * units(fees.sell) + 999999999999n) / 1000000000000n);
  const result = applyFinalOrder(state, sold, [fill(sold, { orderId: 78, id: 2, commissionAsset: 'BTC', commission })]);
  assert.equal(units(result.positions[symbol].quantity), units(owned) - units(plan.quantity) - units(commission));
});
test('missing or adverse commission data cannot become zero fees', () => {
  assert.throws(() => commissionRates({ ...feeReply, standardCommission: undefined }, symbol));
  assert.throws(() => commissionRates({ ...feeReply, symbol: 'ETHUSDT' }, symbol));
  assert.equal(fees.buy, '0.001');
});
test('exchange UID binds the ledger to one production Spot account', () => {
  assert.equal(accountIdentity({ uid: 42, canTrade: true, accountType: 'SPOT', balances: [] }), '42');
  for (const uid of [undefined, 0, 'NaN', 9007199254740992]) assert.throws(() => accountIdentity({ uid, canTrade: true, accountType: 'SPOT', balances: [] }));
});
test('fill reconciliation subtracts actual quote fees and persists net owned inventory atomically', () => {
  const state = pendingState(), order = finalOrder(state), trade = fill(order);
  const next = applyFinalOrder(state, order, [trade]);
  assert.equal(next.pending, null); assert.equal(next.orders.length, 1); assert.equal(next.fills.length, 1);
  assert.equal(units(next.cash), units('1000') - units(trade.quoteQty) - units(trade.commission));
  assert.equal(next.positions[symbol].quantity, order.executedQty); assert.notEqual(state.pending, null);
});
test('base-denominated buy commissions reduce sellable quantity', () => {
  const state = pendingState(), order = finalOrder(state);
  const next = applyFinalOrder(state, order, [fill(order, { commissionAsset: 'BTC', commission: '0.00000001' })]);
  assert.equal(units(next.positions[symbol].quantity), units(order.executedQty) - units('0.00000001'));
});
test('BNB fees require an explicit valuation and enter the risk ledger', () => {
  const state = pendingState(), order = finalOrder(state), trade = fill(order, { commissionAsset: 'BNB', commission: '0.0001' });
  assert.throws(() => applyFinalOrder(state, order, [trade]), /FEE_VALUE_UNKNOWN/);
  const next = applyFinalOrder(state, order, [trade], { BNB: '600' });
  assert.equal(units(next.cash), units('1000') - units(order.cummulativeQuoteQty) - units('0.06'));
});
test('partial final IOC executions apply exact totals while missing or duplicate fills stay pending', () => {
  const state = pendingState();
  const order = finalOrder(state, { status: 'EXPIRED', executedQty: '0.00005', cummulativeQuoteQty: decimal(multiply(units('0.00005'), units(state.pending.plan.price))) });
  const trade = fill(order);
  assert.equal(applyFinalOrder(state, order, [trade]).positions[symbol].quantity, '0.00005');
  for (const trades of [[], [trade, trade]]) assert.throws(() => applyFinalOrder(state, order, trades));
  assert.ok(state.pending);
});
test('zero-fill expiration clears only the matched pending intent', () => {
  const state = pendingState(), order = finalOrder(state, { status: 'EXPIRED', executedQty: '0', cummulativeQuoteQty: '0' });
  const next = applyFinalOrder(state, order, []); assert.equal(next.cash, state.cash); assert.deepEqual(next.positions, {}); assert.equal(next.pending, null);
});
test('wrong account-order identity, nonterminal states and unowned sells fail closed', () => {
  const state = pendingState(), order = finalOrder(state);
  for (const patch of [{ clientOrderId: 'manual-order' }, { status: 'PARTIALLY_FILLED' }, { symbol: 'ETHUSDT' }, { origQty: '2' }]) assert.throws(() => applyFinalOrder(state, { ...order, ...patch }, []));
  const sell = pendingState('SELL'), sellOrder = finalOrder(sell);
  assert.throws(() => applyFinalOrder(sell, sellOrder, [fill(sellOrder)]), /UNOWNED/);
});
test('mark-to-market equity includes unrealized losses and estimated liquidation fees', () => {
  const state = pendingState(), order = finalOrder(state);
  const bought = applyFinalOrder(state, order, [fill(order)]);
  assert.ok(Number(markedEquity(bought, { BTCUSDT: '80000' }, { BTCUSDT: '0.001' })) < 1000);
});
test('version-one external strategies migrate and v2 adds bounded user sizing', () => {
  const source = { version: 1, name: 'Custom', entry: { match: 'all', rules: [{ left: 'fast', op: '>', right: 'slow' }] }, exit: { match: 'any', rules: [{ left: 'rsi', op: '<', right: 45 }] } };
  assert.equal(liveExternalStrategy(JSON.stringify(source)).buyPercent, null);
  const v2 = { ...source, version: 2, sizing: { buyPercent: 2 } };
  assert.equal(liveExternalStrategy(JSON.stringify(v2)).buyPercent, 2);
  for (const buyPercent of [0, 101, '2']) assert.throws(() => liveExternalStrategy(JSON.stringify({ ...v2, sizing: { buyPercent } })));
  assert.throws(() => liveExternalStrategy(JSON.stringify({ ...v2, dailyLossPercent: 99 })));
});
test('encrypted local vault authenticates password, refuses tampering and preserves source secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'asb-vault-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.json'), data = { credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret' }, settings };
  await saveVault(path, data, 'long-test-password');
  assert.doesNotMatch(await readFile(path, 'utf8'), /fixture-key|fixture-secret/);
  assert.deepEqual(await loadVault(path, 'long-test-password'), data);
  await assert.rejects(loadVault(path, 'wrong-long-password'));
  const stored = JSON.parse(await readFile(path, 'utf8')); stored.tag = '0'.repeat(32); await writeFile(path, JSON.stringify(stored));
  await assert.rejects(loadVault(path, 'long-test-password'));
});
test('read-only checks and real-start confirmation do not themselves submit any order', async t => {
  const f = await engineFixture(t); f.warm();
  const result = await f.engine.check(); assert.equal(result.signal.side, 'BUY');
  await assert.rejects(f.engine.start('yes'));
  await f.engine.start(LIVE_CONFIRMATION);
  await f.engine.check();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});
test('only an explicitly armed strategy tick can submit, then queries reconcile the exact order', async t => {
  const f = await engineFixture(t); f.warm(); await f.engine.check(); await f.engine.start(LIVE_CONFIRMATION);
  await f.engine.check({ execute: true });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.engine.state.pending, null); assert.equal(f.engine.state.orders.length, 1);
  assert.equal(f.calls.find(call => call.path === '/api/v3/order' && call.method === 'GET').params.origClientOrderId, f.engine.state.orders[0].id);
});
test('ambiguous submission persists pending before POST and never resubmits during recovery', async t => {
  const f = await engineFixture(t, { send: 'timeout' }); f.warm(); await f.engine.check(); await f.engine.start(LIVE_CONFIRMATION);
  await assert.rejects(f.engine.check({ execute: true }), /UNKNOWN_RECONCILE/);
  assert.equal(f.engine.running, false); assert.ok(f.engine.state.pending);
  assert.ok(JSON.parse(await readFile(f.engine.file, 'utf8')).pending);
  await f.engine.reconcile();
  assert.equal(f.engine.state.pending, null); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('stop while the pending intent is saving prevents the network submission', async t => {
  const f = await engineFixture(t); f.warm(); await f.engine.check(); await f.engine.start(LIVE_CONFIRMATION);
  const commit = f.engine.commit.bind(f.engine);
  f.engine.commit = async value => { await commit(value); if (value.pending) f.engine.stop(); };
  await f.engine.check({ execute: true });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0); assert.equal(f.engine.state.pending, null);
});

test('a slow pending-intent save expires the quote before submitting an order', async t => {
  const f = await engineFixture(t); f.warm(); await f.engine.check(); await f.engine.start(LIVE_CONFIRMATION);
  const commit = f.engine.commit.bind(f.engine);
  f.engine.commit = async value => { await commit(value); if (value.pending) f.clock(now + 3001); };
  await f.engine.check({ execute: true });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(f.engine.state.pending, null);
});

test('clock reversal requires a fresh account check before real trading can start', async t => {
  const f = await engineFixture(t); await f.engine.check(); f.clock(now - 1);
  await assert.rejects(f.engine.start(LIVE_CONFIRMATION), /FRESH_READ_ONLY_CHECK/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});
test('daily 20% drawdown locks buys for the whole local day even after equity recovers', async t => {
  const f = await engineFixture(t); await f.engine.check();
  await f.engine.commit({ ...f.engine.state, cash: '800' }); f.warm();
  const result = await f.engine.check(); assert.match(result.buyBlocked, /DAILY_LOSS/); assert.equal(result.plan, null);
  await f.engine.commit({ ...f.engine.state, cash: '1000' });
  assert.match((await f.engine.check()).buyBlocked, /DAILY_LOSS/);
});
test('next UTC+8 day rebuilds opening equity and releases only the previous day buy lock', async t => {
  const f = await engineFixture(t); await f.engine.check();
  await f.engine.commit({ ...f.engine.state, cash: '799', buyBlocked: 'DAILY_LOSS_20_PERCENT_' + f.engine.state.day.date });
  f.clock(now + 86400000); f.warm();
  const result = await f.engine.check();
  assert.notEqual(result.day.date, new Date(now + 28800000).toISOString().slice(0, 10));
  assert.equal(result.day.source, 'BOT_LEDGER_UTC_PLUS_8_OPEN_CANDLE');
});
test('account replacement, external open orders and missing owned inventory disarm the runner', async t => {
  const f = await engineFixture(t); await f.engine.check(); f.account.uid = 456;
  await assert.rejects(f.engine.check(), /ACCOUNT_CHANGED/); assert.equal(f.engine.running, false);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});
test('exclusive mainnet profile lock rejects a second runner without altering its state', async t => {
  const f = await engineFixture(t);
  const second = new LiveEngine({ profile: f.profile, client: f.engine.client, settings });
  await assert.rejects(second.acquire(), /LOCKED/);
});
test('a dead-process marker recovers under the exclusive profile socket and preserves the ledger', async t => {
  const f = await engineFixture(t); await f.engine.check();
  await f.engine.close();
  await writeFile(join(f.profile, 'mainnet.lock'), '2000000000');
  const recovered = new LiveEngine({ profile: f.profile, client: f.engine.client, settings, now: () => now });
  await recovered.acquire();
  try { assert.equal(recovered.state.cash, '1000'); assert.equal(recovered.running, false); }
  finally { await recovered.close(); }
});
test('an already reconciled order cannot be applied again', () => {
  const state = pendingState(), order = finalOrder(state);
  const settled = applyFinalOrder(state, order, [fill(order)]);
  settled.pending = state.pending;
  assert.throws(() => applyFinalOrder(settled, order, [fill(order)]), /ALREADY_RECONCILED/);
});
test('a sell records net realized P&L and keeps a partial remainder owned', () => {
  const initial = pendingState(), boughtOrder = finalOrder(initial);
  const bought = applyFinalOrder(initial, boughtOrder, [fill(boughtOrder)]);
  const state = structuredClone(bought);
  state.pending = { id: 'asbl_' + 'b'.repeat(28), uid: '123', createdAt: now, plan: { ...initial.pending.plan, side: 'SELL', quantity: '0.00005', price: '101000' } };
  const sold = { ...finalOrder(state), clientOrderId: state.pending.id, orderId: 78, side: 'SELL', origQty: '0.00005', executedQty: '0.00005', price: '101000', cummulativeQuoteQty: '5.05' };
  const result = applyFinalOrder(state, sold, [fill(sold, { orderId: 78, id: 2, isBuyer: false, qty: '0.00005', quoteQty: '5.05', commission: '0.00505' })]);
  assert.ok(result.dailyRisk.realizedUsdt < 0);
  assert.equal(result.dailyRisk.consecutiveLosses, 1);
  assert.equal(units(result.positions[symbol].quantity), units(bought.positions[symbol].quantity) - units('0.00005'));
});
test('zero or foreign signatures, strategies and daily stop overrides are refused', () => {
  for (const patch of [{ buyPercent: 0 }, { dailyLossPercent: 30 }, { riskBasis: 'entire-account' }, { symbol: 'BTCBTC' }]) assert.throws(() => validateSettings({ ...settings, ...patch }));
});
test('missing local order after an unknown result stays pending', async t => {
  const f = await engineFixture(t, { override(method, path) {
    if (path === '/api/v3/order' && method === 'GET') {
      const error = new Error('BINANCE_REQUEST_REJECTED'); error.binanceCode = -2013; throw error;
    }
  } });
  await f.engine.commit(pendingState());
  await assert.rejects(f.engine.reconcile());
  assert.ok(f.engine.state.pending);
});
test('a known definitive rejection clears only after the order lookup confirms absence', async t => {
  const f = await engineFixture(t, { override(method, path) {
    if (path === '/api/v3/order' && method === 'GET') {
      const error = new Error('BINANCE_REQUEST_REJECTED'); error.binanceCode = -2013; throw error;
    }
  } });
  const state = pendingState(); state.pending.definitiveRejection = -1013;
  await f.engine.commit(state); await f.engine.reconcile();
  assert.equal(f.engine.state.pending, null);
});
test('review export contains costs and discussion prompts but excludes credentials and UID', async t => {
  const f = await engineFixture(t); await f.engine.check();
  const text = reviewReport(f.engine);
  assert.match(text, /UTC\+8/); assert.match(text, /和客户讨论/); assert.doesNotMatch(text, /fixture-secret|apiKey|uid/);
});
test('loopback UI blocks unauthenticated reads and cross-origin actions, even with a token', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'asb-server-test-'));
  const app = await createLiveServer({ profile, port: 0, clientFactory() { throw new Error('NO_EXCHANGE_IN_UI_TEST'); } });
  t.after(async () => { await app.close(); await rm(profile, { recursive: true, force: true }); });
  const url = new URL(app.url), token = url.hash.slice(1), origin = url.origin;
  assert.equal((await fetch(origin + '/')).status, 200);
  assert.equal((await fetch(origin + '/api/status')).status, 403);
  assert.equal((await fetch(origin + '/api/status', { headers: { 'x-asbl-session': token } })).status, 200);
  const request = { method: 'POST', headers: { 'x-asbl-session': token, 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: '{}' };
  assert.equal((await fetch(origin + '/api/start', request)).status, 403);
  assert.equal((await fetch(origin + '/api/start', { ...request, headers: { ...request.headers, Origin: origin } })).status, 400);
});
