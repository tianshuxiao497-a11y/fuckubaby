import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTIVE_DEFAULTS as defaults, ADAPTIVE_SHORT_DEFAULTS as shortDefaults,
  updateAdaptiveSamples, adaptiveSignal } from '../lib/adaptive-strategy.mjs';
import { commissionContext } from '../lib/testnet-commission.mjs';

// Pure synthetic research data. These tests have no client, network, account,
// environment, file, persistence, or order-execution access.
const now = 1_800_000_000_000;
const config = { ...defaults, strategy: 'adaptive', symbol: 'BTCUSDT' };
const candlesFrom = (closes, range = 80) => closes.map((close, index) => {
  const time = now - (closes.length - index) * 60000;
  return { time, closeTime: time + 59999, open: close - Math.min(5, range / 2),
    high: close + range, low: close - range, close, volume: 100 };
});
const trend = () => candlesFrom(Array.from({ length: 100 }, (_, index) => 100000 + index * 20));
const declining = () => candlesFrom(Array.from({ length: 100 }, (_, index) => 100000 - index * 20));
const rebound = () => {
  const closes = Array.from({ length: 100 }, (_, index) => 100000 + index * 20);
  closes.splice(-5, 5, 101800, 101760, 101700, 101600, 101650);
  return candlesFrom(closes);
};
const book = (bid = 101985, ask = bid + 10) => ({
  symbol: 'BTCUSDT', bidPrice: String(bid), askPrice: String(ask), bidQty: '1', askQty: '1'
});
const observations = (mid = 101990, at = now) => [
  { time: at - 10000, price: mid - 40 }, { time: at - 5000, price: mid - 20 }, { time: at, price: mid }
];
const state = patch => ({ position: null, pending: null, orders: [], adaptiveSamples: observations(), ...patch });
const position = patch => ({ quantity: 0.00039, entryPrice: 101900, openedAt: now - 60000,
  deployedUsdt: 40, batches: 1, lastEntryPrice: 101900, peakBid: 101900,
  riskSnapshot: { stopLossPercent: 0.25, takeProfitPercent: 0.4 }, adopted: false, ...patch });
const order = (side = 'BUY', time = now - 10000) => ({ side, time });
const signal = (currentState = state(), currentBook = book(), candles = trend(), currentTime = now, currentConfig = config) =>
  adaptiveSignal(candles, currentConfig, currentState, currentBook, currentTime);
const risk = patch => ({ dayUtc: new Date(now).toISOString().slice(0, 10), realizedUsdt: 0,
  consecutiveLosses: 0, lastLossAt: 0, ...patch });
function assertJsonSafe(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  else if (Array.isArray(value)) for (const item of value) assertJsonSafe(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) {
    assert.notEqual(item, undefined); assertJsonSafe(item);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

test('adaptive defaults are deeply frozen, cost-aware and use five-second observation rather than forced cycles', () => {
  assert.equal(Object.isFrozen(defaults), true); assert.equal(Object.isFrozen(defaults.batchFractions), true);
  assert.equal(defaults.pollSeconds, 5); assert.equal(defaults.minOrderSeconds, 5);
  assert.deepEqual(defaults.batchFractions, [0.4, 0.3, 0.3]); assert.equal(defaults.tradeUsdt, 100);
  assert.equal(defaults.fast, 3); assert.equal(defaults.slow, 8);
  assert.equal(defaults.feePerSidePercent, 0.1); assert.equal(defaults.slippagePerSidePercent, 0.02);
  assert.equal(defaults.minNetEdgePercent, 0.05); assert.equal(defaults.maxSpreadPercent, 0.03);
  assert.equal(defaults.maxDailyLossUsdt, 5); assert.equal(defaults.consecutiveLossLimit, 3);
});

test('trend continuation produces a bounded first tranche using EMA/RSI/ATR/five-minute evidence scores', () => {
  const result = signal();
  assert.equal(result.side, 'BUY'); assert.equal(result.route, 'trend_continuation');
  assert.equal(result.batchIndex, 1); assert.equal(result.batchUsdt, 40); assert.equal(result.candle, now);
  assert.ok(result.fast > result.slow); assert.ok(result.indicators.contextFast > result.indicators.contextSlow);
  assert.equal(result.indicators.rsi, 100); // RSI is scored, not an all-indicators-must-pass stack.
  assert.ok(result.indicators.trendScore >= 4);
  assert.ok(result.thresholds.opportunityProxyPercent > result.thresholds.minGrossOpportunityPercent);
  assert.equal(result.thresholds.opportunityIsResearchProxy, true); assert.equal(result.positionUpdate, null);
  assertJsonSafe(result);
});

test('confirmed pullback rebound is a separate scored route even before fast EMA recrosses slow EMA', () => {
  const result = signal(state({ adaptiveSamples: observations(101660) }), book(101655), rebound());
  assert.equal(result.side, 'BUY'); assert.equal(result.route, 'pullback_rebound'); assert.equal(result.batchUsdt, 40);
  assert.ok(result.fast < result.slow); assert.ok(result.indicators.rsi > result.indicators.previousRsi);
  assert.ok(result.indicators.reboundScore >= 3); assertJsonSafe(result);
});

test('sample updates are pure, midpoint-based, bounded, and reset after a gap longer than 15 seconds', () => {
  const original = observations(); const before = structuredClone(original);
  const updated = updateAdaptiveSamples(original, book(102005), now + 5000);
  assert.deepEqual(original, before); assert.equal(updated.at(-1).price, 102010);
  assert.notEqual(updated[0], original[0]);
  const replacement = updateAdaptiveSamples(original, book(102005), now);
  assert.equal(replacement.length, 3); assert.equal(replacement.at(-1).price, 102010);
  const reset = updateAdaptiveSamples(original, book(), now + 15001);
  assert.deepEqual(reset, [{ time: now + 15001, price: 101990 }]);
  assert.ok(updateAdaptiveSamples(original, book(), now + 15000).length >= 3);
  assert.throws(() => updateAdaptiveSamples([{ time: now + 1, price: 101990 }], book(), now));
  assert.throws(() => updateAdaptiveSamples([{ time: now, price: 1 }, { time: now, price: 1 }], book(), now));
});

test('entries wait for three fresh observations spanning at least ten seconds and never reuse a disconnected sample window', () => {
  for (const adaptiveSamples of [[], [{ time: now - 5000, price: 101950 }], observations(101990, now - 20000)]) {
    const result = signal(state({ adaptiveSamples })); assert.equal(result.side, null); assert.equal(result.warmReady, false);
  }
  assert.equal(signal(state({ adaptiveSamples: observations() })).side, 'BUY');
});

test('estimated round-trip fees, slippage, spread and safety buffer gate the volatility research proxy', () => {
  const smallRange = candlesFrom(Array.from({ length: 100 }, (_, index) => 100000 + index * 0.2), 0.1);
  const result = signal(state({ adaptiveSamples: observations(100020) }), book(100019, 100021), smallRange);
  assert.equal(result.side, null); assert.match(result.reason, /cost|volatility/i);
  assert.ok(result.thresholds.opportunityProxyPercent < result.thresholds.minGrossOpportunityPercent);
  assert.ok(result.thresholds.roundTripCostPercent >= 0.24);
  assert.ok(Math.abs(result.thresholds.minGrossOpportunityPercent - result.thresholds.roundTripCostPercent - 0.05) < 1e-10);
});

test('wide spreads, excessive extension and unconfirmed short momentum do not force an order', () => {
  assert.equal(signal(state(), book(101960, 102020)).side, null);
  assert.equal(signal(state({ adaptiveSamples: observations(102500) }), book(102495)).side, null);
  const negative = [{ time: now - 10000, price: 102030 }, { time: now - 5000, price: 102010 }, { time: now, price: 101990 }];
  assert.equal(signal(state({ adaptiveSamples: negative })).side, null);
});

test('frozen stop and target protect only recorded owned inventory before sample, loss, hourly or order-gap entry guards', () => {
  const current = state({ position: position({ entryPrice: 101985 }), adaptiveSamples: [], orders: [order('BUY', now - 1)],
    dailyRisk: risk({ realizedUsdt: -100, consecutiveLosses: 3, lastLossAt: now - 1 }) });
  const loss = signal(current, book(101985 * (1 - 0.0025)));
  assert.equal(loss.side, 'SELL'); assert.match(loss.reason, /stop loss/i); assert.equal(loss.warmReady, false);
  const gain = signal(current, book(101985 * (1 + 0.004)));
  assert.equal(gain.side, 'SELL'); assert.match(gain.reason, /take profit/i);
  const noOwned = signal(state({ adaptiveSamples: [] }), book(101985 * (1 - 0.0025)));
  assert.equal(noOwned.side, null); assert.equal(noOwned.positionUpdate, null);
});

test('entry risk adapts to ATR within bounds, then frozen position thresholds never widen with later volatility', () => {
  const volatile = candlesFrom(trend().map(item => item.close), 800);
  const entry = signal(state(), book(), volatile);
  assert.equal(entry.side, 'BUY'); assert.ok(entry.riskSnapshot.stopLossPercent >= 0.15 && entry.riskSnapshot.stopLossPercent <= 0.75);
  assert.ok(entry.riskSnapshot.takeProfitPercent >= 0.25 && entry.riskSnapshot.takeProfitPercent <= 1.2);
  const frozen = { stopLossPercent: 0.11, takeProfitPercent: 0.42 };
  const current = state({ position: position({ riskSnapshot: frozen }) });
  const result = signal(current, book(), volatile);
  assert.deepEqual(result.riskSnapshot, frozen);
  const stopped = signal(current, book(101900 * (1 - 0.0012)), volatile);
  assert.equal(stopped.side, 'SELL'); assert.match(stopped.reason, /stop loss/i);
});

test('hard maximum hold exits even during warmup; normal trend exits wait at least twenty seconds and honor the order gap', () => {
  const expired = state({ position: position({ openedAt: now - 600000 }), adaptiveSamples: [] });
  assert.match(signal(expired).reason, /maximum holding/i); assert.equal(signal(expired).side, 'SELL');
  const current = state({ position: position({ entryPrice: 98005, lastEntryPrice: 98005, peakBid: 98005,
    openedAt: now - 19999, adopted: true }), adaptiveSamples: [] });
  assert.equal(signal(current, book(98005), declining()).side, null);
  current.position.openedAt = now - 20000;
  assert.equal(signal(current, book(98005), declining()).side, 'SELL');
  current.orders = [order('BUY', now - 4999)];
  assert.equal(signal(current, book(98005), declining()).side, null);
});

test('soft holding timeout requires current fee coverage while peak-armed trailing remains protective after a fast gap', () => {
  const entryPrice = 101985;
  const held = position({ entryPrice, lastEntryPrice: entryPrice, peakBid: entryPrice,
    openedAt: now - 180000, batches: 3, adopted: true });
  assert.equal(signal(state({ position: held }), book(entryPrice * 1.001)).side, null);
  const covered = signal(state({ position: held }), book(entryPrice * 1.0033));
  assert.equal(covered.side, 'SELL'); assert.match(covered.reason, /soft holding/i);
  const trailed = position({ entryPrice, lastEntryPrice: entryPrice, peakBid: entryPrice * 1.006,
    riskSnapshot: { stopLossPercent: 0.25, takeProfitPercent: 1.2 }, batches: 3 });
  const gap = signal(state({ position: trailed }), book(entryPrice * 1.001));
  assert.equal(gap.side, 'SELL'); assert.match(gap.reason, /trailing/i);
  assert.ok((Number(book(entryPrice * 1.001).bidPrice) / entryPrice - 1) * 100 < gap.thresholds.minGrossOpportunityPercent);
});

test('pending reconciliation blocks all new decisions, including a protective exit', () => {
  const current = state({ pending: { side: 'BUY', clientOrderId: 'synthetic' }, position: position(), adaptiveSamples: [] });
  const result = signal(current, book(100000));
  assert.equal(result.side, null); assert.match(result.reason, /pending|reconciled/i);
});

test('daily realized loss, recent loss and three consecutive losses impose entry-only cooldowns', () => {
  assert.match(signal(state({ dailyRisk: risk({ realizedUsdt: -5 }) })).reason, /daily/i);
  assert.match(signal(state({ dailyRisk: risk({ realizedUsdt: -1, lastLossAt: now - 59999 }) })).reason, /recent.loss/i);
  assert.equal(signal(state({ dailyRisk: risk({ realizedUsdt: -1, lastLossAt: now - 60000 }) })).side, 'BUY');
  const consecutive = risk({ realizedUsdt: -1, consecutiveLosses: 3, lastLossAt: now - 120000 });
  assert.match(signal(state({ dailyRisk: consecutive })).reason, /consecutive/i);
  assert.equal(signal(state({ dailyRisk: { ...consecutive, lastLossAt: now - 900000 } })).side, 'BUY');
  const oldDay = new Date(now - 86400000).toISOString().slice(0, 10);
  assert.equal(signal(state({ dailyRisk: risk({ dayUtc: oldDay, realizedUsdt: -100, lastLossAt: now - 900000 }) })).side, 'BUY');
  assert.match(signal(state({ dailyRisk: risk({ dayUtc: oldDay, lastLossAt: now - 1 }) })).reason, /recent.loss/i);
});

test('malformed or future risk days cannot bypass loss controls, but entry-risk corruption does not disable protective exits', () => {
  for (const dayUtc of ['2026-99-99', '2026-02-30', new Date(now + 86400000).toISOString().slice(0, 10)]) {
    assert.throws(() => signal(state({ dailyRisk: risk({ dayUtc }) })));
  }
  const badRisk = risk({ dayUtc: '2026-99-99', realizedUsdt: NaN });
  const protection = signal(state({ dailyRisk: badRisk, position: position() }), book(100000));
  assert.equal(protection.side, 'SELL'); assert.match(protection.reason, /stop loss/i);
});

test('five-second action interval, flat exit cooldown and rolling hourly BUY cap prevent extra entries, not risk exits', () => {
  assert.equal(signal(state({ orders: [order('BUY', now - 4999)] })).side, null);
  assert.equal(signal(state({ orders: [order('BUY', now - 5000)] })).side, 'BUY');
  assert.equal(signal(state({ orders: [order('SELL', now - 9999)] })).side, null);
  assert.equal(signal(state({ orders: [order('SELL', now - 10000)] })).side, 'BUY');
  const orders = Array.from({ length: 60 }, (_, index) => order('BUY', now - 10000 - index * 1000));
  assert.equal(signal(state({ orders })).side, null);
  assert.equal(signal(state({ orders, position: position() }), book(100000)).side, 'SELL');
});

test('40/30/30 staging is bounded, allows only profitable advances and never adds to adopted or fully staged inventory', () => {
  const current = state({ position: position(), orders: [order()] });
  const second = signal(current); assert.equal(second.side, 'BUY'); assert.equal(second.batchIndex, 2); assert.equal(second.batchUsdt, 30);
  const third = signal(state({ position: position({ batches: 2, deployedUsdt: 70 }) }));
  assert.equal(third.side, 'BUY'); assert.equal(third.batchIndex, 3); assert.equal(third.batchUsdt, 30);
  const partial = signal(state({ position: position({ batches: 2, deployedUsdt: 97.531 }) }));
  assert.equal(partial.batchUsdt, 2.46); assert.ok(partial.batchUsdt + 97.531 <= 100);
  for (const patch of [{ adopted: true }, { batches: 3 }, { deployedUsdt: 100 }, { lastEntryPrice: 101980 }, { entryPrice: 101990 }]) {
    assert.equal(signal(state({ position: position(patch) })).side, null);
  }
  const legacy = { quantity: 0.00039, entryPrice: 101900, openedAt: now - 60000 };
  assert.equal(signal(state({ position: legacy })).side, null);
  assert.deepEqual(signal(state({ position: legacy })).riskSnapshot, { stopLossPercent: config.stopLoss, takeProfitPercent: config.takeProfit });
});

test('signals never mutate candles/config/state/book and peak updates are returned rather than persisted', () => {
  const market = trend(); const current = state({ position: position() }); const quote = book();
  const before = structuredClone({ market, current, quote, config });
  const result = adaptiveSignal(market, config, current, quote, now);
  assert.deepEqual({ market, current, quote, config }, before);
  assert.deepEqual(result.positionUpdate, { peakBid: 101985 }); assert.equal(current.position.peakBid, 101900);
  assertJsonSafe(result);
  const noVolume = market.map(item => ({ ...item, volume: 0 }));
  assertJsonSafe(signal(state(), quote, noVolume));
});

test('an initial or missing peak cannot arm a trailing exit without a previously cost-covered observed gain', () => {
  const fresh = position({ openedAt: now - 20000, peakBid: undefined, batches: 3 });
  const current = signal(state({ position: fresh }), book(101895));
  assert.equal(current.side, null); assert.deepEqual(current.positionUpdate, { peakBid: 101900 });
  assert.equal(fresh.peakBid, undefined);
  const flat = candlesFrom(Array(100).fill(100000), 100);
  const idle = signal(state({ adaptiveSamples: observations(100000) }), book(99995), flat);
  assert.equal(idle.side, null); assert.equal(idle.route, null);
});

test('non-finite observation returns fail closed rather than leaking Infinity into audit data or creating a false entry', () => {
  const corrupted = [{ time: now - 10000, price: Number.MIN_VALUE },
    { time: now - 5000, price: 101970 }, { time: now, price: 101990 }];
  assert.throws(() => signal(state({ adaptiveSamples: corrupted })));
});

test('invalid symbols, quotes, missing OHLCV, open/stale/discontinuous candles and malformed state fail closed', () => {
  for (const quote of [book(0), book(102000, 101000), { ...book(), bidQty: '0' }, { ...book(), bidPrice: true },
    { ...book(), symbol: 'ETHUSDT' }, { ...book(), askPrice: 'Infinity' }]) assert.throws(() => signal(state(), quote));
  const variants = [
    trend().slice(0, 20), trend().filter((_, index) => index !== 50),
    trend().map(item => ({ ...item, time: item.time - 180000, closeTime: item.closeTime - 180000 })),
    trend().map((item, index) => index === 99 ? { ...item, closeTime: now } : item),
    trend().map((item, index) => index === 99 ? { ...item, volume: undefined } : item),
    trend().map((item, index) => index === 99 ? { ...item, low: item.close + 1 } : item),
    trend().map((item, index) => index === 99 ? { ...item, close: NaN } : item)
  ];
  for (const market of variants) assert.throws(() => signal(state(), book(), market));
  assert.throws(() => signal(state({ orders: [{ side: 'BUY', time: NaN }] })));
  assert.throws(() => signal(state({ position: position({ quantity: 0 }) })));
  assert.throws(() => signal(state({ position: position({ riskSnapshot: { stopLossPercent: NaN, takeProfitPercent: 1 } }) })));
});

const shortConfig = { ...shortDefaults, strategy: 'adaptive', symbol: 'BTCUSDT' };
const shortCandles = () => candlesFrom(Array.from({ length: 100 }, (_, index) => 100000 + index * 2), 10);
const shortBook = () => book(100195, 100205);
const shortState = patch => state({ adaptiveSamples: observations(100200), ...patch });
const shortSignal = (current = shortState(), quote = shortBook(), market = shortCandles(), at = now) =>
  adaptiveSignal(market, shortConfig, current, quote, at);
const testFees = (taker = '0', checkedAt = now) => commissionContext({
  symbol: 'BTCUSDT',
  standardCommission: { maker: '0', taker, buyer: '0', seller: '0' },
  specialCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' },
  taxCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' }
}, 'BTCUSDT', checkedAt);

test('explicit short profile changes only bounded exit timing/cost buffer while retaining signal and risk guards', () => {
  assert.equal(Object.isFrozen(shortDefaults), true);
  assert.equal(shortDefaults.adaptiveProfile, 'short'); assert.equal(shortDefaults.pollSeconds, 5);
  assert.equal(shortDefaults.maxHoldMinutes, 3); assert.equal(shortDefaults.softHoldMinutes, 1);
  assert.equal(shortDefaults.minSignalHoldSeconds, 10); assert.equal(shortDefaults.minNetEdgePercent, 0.01);
  assert.equal(shortDefaults.stopLoss, 0.15); assert.equal(shortDefaults.takeProfit, 0.15);
  for (const key of ['fast', 'slow', 'tradeUsdt', 'maxDailyLossUsdt', 'maxBuysPerHour', 'maxSpreadPercent',
    'maxExtensionPercent', 'minTrendMomentumPercent', 'minReboundMomentumPercent', 'slippagePerSidePercent',
    'lossCooldownSeconds', 'consecutiveLossLimit', 'consecutiveLossCooldownSeconds']) {
    assert.equal(shortDefaults[key], defaults[key], key);
  }
  assert.equal(shortDefaults.batchFractions, defaults.batchFractions);
  assert.throws(() => signal(state(), book(), trend(), now, { ...config, adaptiveProfile: 'unknown' }));
});

test('short profile without verified current symbol commissions remains conservatively fee-aware', () => {
  const result = shortSignal();
  assert.equal(result.side, null); assert.match(result.reason, /cost|volatility/i);
  assert.equal(result.thresholds.buyFeePercent, 0.1); assert.equal(result.thresholds.sellFeePercent, 0.1);
  assert.equal(result.thresholds.feeVerified, false);
  assert.ok(result.thresholds.minGrossOpportunityPercent > 0.25);
  assert.equal(result.riskSnapshot.costSnapshot.verified, false);
  assertJsonSafe(result);
});

test('short profile never turns an empty signal into a forced periodic buy', () => {
  const market = candlesFrom(Array(100).fill(100000), 100);
  const result = shortSignal(shortState({ adaptiveSamples: observations(100000) }), book(99995, 100005), market);
  assert.equal(result.warmReady, true);
  assert.ok(result.thresholds.opportunityProxyPercent > result.thresholds.minGrossOpportunityPercent);
  assert.equal(result.side, null); assert.equal(result.route, null);
  assert.match(result.reason, /No confirmed/);
});

test('short ordinary weakness exit starts at ten seconds and hard three-minute exit ignores entry-only guards', () => {
  const held = position({ entryPrice: 98005, lastEntryPrice: 98005, peakBid: 98005,
    openedAt: now - 9999, adopted: true });
  const current = shortState({ position: held, adaptiveSamples: [] });
  assert.equal(shortSignal(current, book(98005), declining()).side, null);
  const weak = shortSignal({ ...current, position: { ...held, openedAt: now - 10000 } }, book(98005), declining());
  assert.equal(weak.side, 'SELL'); assert.match(weak.reason, /trend weakness/i);
  const expired = shortState({ position: position({ openedAt: now - 180000 }), adaptiveSamples: [],
    orders: [order('BUY', now - 1)], dailyRisk: risk({ realizedUsdt: -100, consecutiveLosses: 3, lastLossAt: now - 1 }) });
  const exit = shortSignal(expired, book(), trend());
  assert.equal(exit.side, 'SELL'); assert.match(exit.reason, /maximum holding/i);
});

test('short signal-specific risk stays ATR-bounded and retains legacy positions unchanged', () => {
  const volatile = candlesFrom(trend().map(item => item.close), 800);
  const result = shortSignal(shortState({ adaptiveSamples: observations() }), book(), volatile);
  assert.equal(result.side, 'BUY'); assert.equal(result.riskSnapshot.stopLossPercent, 0.4);
  assert.equal(result.riskSnapshot.takeProfitPercent, 0.6);
  const originalRisk = { stopLossPercent: 0.25, takeProfitPercent: 0.4 };
  const legacy = shortState({ position: position({ riskSnapshot: originalRisk }) });
  assert.deepEqual(shortSignal(legacy, book(), volatile).riskSnapshot, originalRisk);
});

test('only verified current zero Testnet commissions permit a lower-volatility entry; standard assumptions do not change', () => {
  const current = shortState({ adaptiveFeeContext: testFees() });
  const entry = shortSignal(current);
  assert.equal(entry.side, 'BUY'); assert.equal(entry.route, 'trend_continuation');
  assert.equal(entry.thresholds.feeVerified, true);
  assert.equal(entry.thresholds.buyFeePercent, 0); assert.equal(entry.thresholds.sellFeePercent, 0);
  assert.equal(entry.thresholds.checkedAt, now); assert.equal(entry.thresholds.expiresAt, now + 300000);
  assert.ok(entry.thresholds.roundTripCostPercent >= 0.04);
  assert.ok(entry.thresholds.opportunityProxyPercent > entry.thresholds.minGrossOpportunityPercent);
  const standard = adaptiveSignal(shortCandles(), config, current, shortBook(), now);
  assert.equal(standard.side, null); assert.match(standard.reason, /cost|volatility/i);
  assert.ok(standard.thresholds.minGrossOpportunityPercent > 0.29);
  assert.deepEqual(entry.riskSnapshot.costSnapshot, {
    buyFeePercent: 0, sellFeePercent: 0, slippagePerSidePercent: 0.02,
    source: 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION', checkedAt: now, verified: true
  });
  assert.equal(entry.riskSnapshot.stopLossPercent, 0.15);
  assert.equal(entry.riskSnapshot.takeProfitPercent, 0.15); // No legacy 0.25% minimum.
  assertJsonSafe(entry);
});

test('short fees do not silently become zero for nonzero, stale, wrong-symbol, future or inconsistent evidence', () => {
  const verifiedPaid = shortSignal(shortState({ adaptiveFeeContext: testFees('0.001') }));
  assert.equal(verifiedPaid.side, null); assert.equal(verifiedPaid.thresholds.feeVerified, true);
  assert.equal(verifiedPaid.thresholds.buyFeePercent, 0.1); assert.equal(verifiedPaid.thresholds.sellFeePercent, 0.1);
  for (const adaptiveFeeContext of [testFees('0', now - 300001), { ...testFees(), symbol: 'ETHUSDT' },
    testFees('0', now + 1), { ...testFees(), buyFeePercent: 0.1 }, {}, null]) {
    const result = shortSignal(shortState({ adaptiveFeeContext }));
    assert.equal(result.side, null); assert.equal(result.thresholds.feeVerified, false);
    assert.equal(result.thresholds.buyFeePercent, 0.1); assert.equal(result.thresholds.sellFeePercent, 0.1);
    assert.equal(result.thresholds.checkedAt, null); assert.equal(result.thresholds.expiresAt, null);
    assertJsonSafe(result);
  }
});

test('short first-entry risk and cost evidence are frozen across adds and later fee changes without input mutation', () => {
  const first = shortSignal(shortState({ adaptiveFeeContext: testFees() }));
  const held = position({ entryPrice: 100100, lastEntryPrice: 100100, peakBid: 100100,
    riskSnapshot: first.riskSnapshot, openedAt: now - 20000 });
  const current = shortState({ adaptiveFeeContext: testFees(), position: held });
  const before = structuredClone({ current, config: shortConfig });
  const addition = shortSignal(current);
  assert.equal(addition.side, 'BUY'); assert.equal(addition.batchIndex, 2);
  assert.deepEqual(addition.riskSnapshot, first.riskSnapshot);
  assert.notEqual(addition.riskSnapshot.costSnapshot, current.position.riskSnapshot.costSnapshot);
  const changedFees = shortSignal({ ...current, adaptiveFeeContext: testFees('0.001') });
  assert.deepEqual(changedFees.riskSnapshot, first.riskSnapshot);
  assert.equal(changedFees.thresholds.buyFeePercent, 0.1);
  assert.equal(changedFees.riskSnapshot.costSnapshot.buyFeePercent, 0);
  assert.deepEqual({ current, config: shortConfig }, before);
  assertJsonSafe(addition);
});

test('short one-minute soft exit needs cost coverage, while frozen stop/target and hard exit stay protective', () => {
  const entry = shortSignal(shortState({ adaptiveFeeContext: testFees() }));
  const entryPrice = 100195;
  const held = position({ entryPrice, lastEntryPrice: entryPrice, peakBid: entryPrice,
    openedAt: now - 60000, riskSnapshot: entry.riskSnapshot, batches: 3, adopted: true });
  const current = shortState({ adaptiveFeeContext: testFees(), position: held });
  const notCovered = shortSignal(current, book(entryPrice * 1.0002));
  assert.equal(notCovered.side, null);
  const covered = shortSignal(current, book(entryPrice * 1.0008));
  assert.equal(covered.side, 'SELL'); assert.match(covered.reason, /soft holding/i);
  const beforeTimeout = shortSignal({ ...current, position: { ...held, openedAt: now - 59999 } }, book(entryPrice * 1.0008));
  assert.equal(beforeTimeout.side, null);
  const gap = { ...current, adaptiveSamples: [], adaptiveFeeContext: { corrupt: true },
    dailyRisk: risk({ realizedUsdt: -100, lastLossAt: now - 1, consecutiveLosses: 3 }) };
  const stop = shortSignal(gap, book(entryPrice * (1 - 0.0015)));
  assert.equal(stop.side, 'SELL'); assert.match(stop.reason, /stop loss/i);
  const take = shortSignal(gap, book(entryPrice * (1 + 0.0015)));
  assert.equal(take.side, 'SELL'); assert.match(take.reason, /take profit/i);
  assert.deepEqual(stop.riskSnapshot, entry.riskSnapshot);
});
