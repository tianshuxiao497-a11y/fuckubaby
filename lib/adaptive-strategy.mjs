// Pure research rules for the fixed-origin Spot Testnet engine. This module
// has no network, account, environment, persistence or order-execution access.
import { selectCommissionFees } from './testnet-commission.mjs';
import { testnetSymbol } from './testnet-symbols.mjs';

export const ADAPTIVE_DEFAULTS = Object.freeze({
  fast: 3, slow: 8, stopLoss: 0.25, takeProfit: 0.4, maxHoldMinutes: 10,
  cooldownSeconds: 10, maxBuysPerHour: 60, tradeUsdt: 100, pollSeconds: 5,
  minOrderSeconds: 5, batchFractions: Object.freeze([0.4, 0.3, 0.3]),
  feePerSidePercent: 0.1, slippagePerSidePercent: 0.02, minNetEdgePercent: 0.05,
  maxSpreadPercent: 0.03, maxExtensionPercent: 0.35, addStepPercent: 0.03,
  lossCooldownSeconds: 60, minSignalHoldSeconds: 20, softHoldMinutes: 3,
  atrPeriod: 7, rsiPeriod: 7, maxDailyLossUsdt: 5,
  consecutiveLossLimit: 3, consecutiveLossCooldownSeconds: 900,
  minTrendMomentumPercent: 0.008, minReboundMomentumPercent: 0.012,
  reversalMomentumPercent: 0.025, maxSampleGapSeconds: 15, sampleWindowSeconds: 30
});

// An explicit virtual-only experiment, not a promise of a trade every period.
// Signal, deployment and loss controls are identical to the standard profile.
export const ADAPTIVE_SHORT_DEFAULTS = Object.freeze({
  ...ADAPTIVE_DEFAULTS, adaptiveProfile: 'short', stopLoss: 0.15, takeProfit: 0.15,
  maxHoldMinutes: 3, softHoldMinutes: 1, minSignalHoldSeconds: 10, minNetEdgePercent: 0.01
});

const d = ADAPTIVE_DEFAULTS;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const numeric = value => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return Number(value);
  return NaN;
};

function validBook(book) {
  const bid = numeric(book?.bidPrice); const ask = numeric(book?.askPrice);
  const bidQty = numeric(book?.bidQty); const askQty = numeric(book?.askQty);
  if (![bid, ask, bidQty, askQty].every(value => Number.isFinite(value) && value > 0) || ask < bid) {
    throw new Error('Invalid adaptive public bid/ask data.');
  }
  const mid = bid + (ask - bid) / 2;
  if (!Number.isFinite(mid)) throw new Error('Adaptive quote exceeds the supported range.');
  return { bid, ask, mid, spreadPercent: (ask - bid) / mid * 100 };
}

export function updateAdaptiveSamples(samples = [], book, now = Date.now()) {
  const { mid } = validBook(book);
  if (!Number.isSafeInteger(now) || now <= 0 || !Array.isArray(samples) || samples.some((item, index) =>
    !item || !Number.isSafeInteger(item.time) || item.time <= 0 || !finite(item.price) || item.price <= 0 ||
    (index > 0 && item.time <= samples[index - 1].time))) throw new Error('Invalid adaptive sample history.');
  if (samples.at(-1)?.time > now) throw new Error('Adaptive sample clock moved backwards.');
  const recent = now - (samples.at(-1)?.time ?? now) > d.maxSampleGapSeconds * 1000 ? []
    : samples.filter(item => now - item.time <= d.sampleWindowSeconds * 1000);
  const withoutCurrent = recent.at(-1)?.time === now ? recent.slice(0, -1) : recent;
  return [...withoutCurrent.map(item => ({ ...item })), { time: now, price: mid }].slice(-7);
}

function profileDefaults(config) {
  const profile = config?.adaptiveProfile ?? 'standard';
  if (!['standard', 'short'].includes(profile)) throw new Error('Invalid adaptive profile.');
  return profile === 'short' ? ADAPTIVE_SHORT_DEFAULTS : ADAPTIVE_DEFAULTS;
}

function settings(config, d = ADAPTIVE_DEFAULTS) {
  if (!config) throw new Error('Invalid adaptive Testnet symbol.');
  testnetSymbol(config.symbol);
  const result = {};
  const limits = {
    fast: [2, 30, true], slow: [3, 60, true], stopLoss: [0.1, 5], takeProfit: [0.1, 10],
    maxHoldMinutes: [1, 60, true], cooldownSeconds: [0, 3600, true],
    maxBuysPerHour: [1, 60, true], tradeUsdt: [25, 100]
  };
  for (const [key, [min, max, integer]] of Object.entries(limits)) {
    const value = config[key] ?? d[key];
    if (!finite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid adaptive ${key}.`);
    result[key] = value;
  }
  if (result.fast >= result.slow) throw new Error('Adaptive fast period must be smaller than slow period.');
  return result;
}

function validateCandles(candles, config, now) {
  if (!Array.isArray(candles) || candles.length < Math.max(50, config.slow + 2) || candles.some((item, index) =>
    !item || !Number.isSafeInteger(item.time) || item.time <= 0 || !Number.isSafeInteger(item.closeTime) ||
    item.closeTime !== item.time + 59999 || item.closeTime >= now ||
    !['open', 'high', 'low', 'close', 'volume'].every(key => finite(item[key])) ||
    item.low <= 0 || item.high < item.low || item.open < item.low || item.open > item.high ||
    item.close < item.low || item.close > item.high || item.volume < 0 ||
    (index > 0 && item.time !== candles[index - 1].time + 60000))) throw new Error('Invalid or insufficient closed adaptive OHLCV candles.');
  if (now - candles.at(-1).closeTime > 120000) throw new Error('Adaptive closed candles are stale.');
}

function ema(values, period) {
  const alpha = 2 / (period + 1); let value = values[0]; const result = [value];
  for (const current of values.slice(1)) { value += alpha * (current - value); result.push(value); }
  return result;
}

function rsi(values, period) {
  let gains = 0; let losses = 0; const result = Array(values.length).fill(null);
  const value = () => losses === 0 ? gains === 0 ? 50 : 100 : 100 - 100 / (1 + gains / losses);
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1]; gains += Math.max(change, 0) / period; losses += Math.max(-change, 0) / period;
  }
  result[period] = value();
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    gains = gains * (1 - 1 / period) + Math.max(change, 0) / period;
    losses = losses * (1 - 1 / period) + Math.max(-change, 0) / period;
    result[index] = value();
  }
  return result;
}

function indicators(candles, config, d = ADAPTIVE_DEFAULTS) {
  const closes = candles.map(item => item.close);
  const fast = ema(closes, config.fast); const slow = ema(closes, config.slow); const strengths = rsi(closes, d.rsiPeriod);
  const ranges = candles.slice(1).map((item, index) => Math.max(item.high - item.low,
    Math.abs(item.high - candles[index].close), Math.abs(item.low - candles[index].close)));
  const atr = ranges.slice(-d.atrPeriod).reduce((sum, value) => sum + value / d.atrPeriod, 0);
  // Use only complete UTC-aligned five-minute groups, never a partial group.
  const groups = new Map();
  for (const candle of candles) {
    const key = Math.floor(candle.time / 300000) * 300000;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(candle);
  }
  const context = [...groups.entries()].filter(([time, rows]) => rows.length === 5 &&
    rows.every((row, index) => row.time === time + index * 60000)).map(([, rows]) => rows.at(-1).close);
  if (context.length < 5) throw new Error('Insufficient complete five-minute adaptive context.');
  const contextFast = ema(context, 3).at(-1); const contextSlow = ema(context, 5).at(-1);
  const averageVolume = candles.slice(-11, -1).reduce((sum, item) => sum + item.volume / 10, 0);
  return {
    fast: fast.at(-1), slow: slow.at(-1), previousFast: fast.at(-2), previousSlow: slow.at(-2),
    rsi: strengths.at(-1), previousRsi: strengths.at(-2), atr,
    atrPercent: atr / closes.at(-1) * 100,
    contextFast, contextSlow, contextBiasPercent: (contextFast / contextSlow - 1) * 100,
    volumeRatio: averageVolume > 0 ? candles.at(-1).volume / averageVolume : null
  };
}

function positionData(position, bid, now) {
  if (!position) return null;
  if (!finite(position.quantity) || position.quantity <= 0 || !finite(position.entryPrice) || position.entryPrice <= 0 ||
      !Number.isSafeInteger(position.openedAt) || position.openedAt <= 0 || position.openedAt > now ||
      (position.peakBid !== undefined && (!finite(position.peakBid) || position.peakBid <= 0))) throw new Error('Invalid adaptive owned position.');
  const peakBid = Math.max(position.peakBid ?? position.entryPrice, bid);
  const profitPercent = (bid / position.entryPrice - 1) * 100;
  if (!finite(profitPercent) || !finite((peakBid / position.entryPrice - 1) * 100)) throw new Error('Adaptive position return exceeds the supported range.');
  return { peakBid, profitPercent, heldMs: now - position.openedAt };
}

function entryGuard(config, state, now, d = ADAPTIVE_DEFAULTS) {
  const risk = state.dailyRisk;
  if (risk !== undefined && risk !== null) {
    if (typeof risk !== 'object' || typeof risk.dayUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(risk.dayUtc) || !finite(risk.realizedUsdt) ||
        !Number.isInteger(risk.consecutiveLosses) || risk.consecutiveLosses < 0 ||
        !Number.isSafeInteger(risk.lastLossAt) || risk.lastLossAt < 0 || risk.lastLossAt > now) throw new Error('Invalid adaptive realized-risk record.');
    const currentDay = new Date(now).toISOString().slice(0, 10); const riskDayTime = Date.parse(`${risk.dayUtc}T00:00:00.000Z`);
    if (!Number.isFinite(riskDayTime) || new Date(riskDayTime).toISOString().slice(0, 10) !== risk.dayUtc || risk.dayUtc > currentDay) throw new Error('Invalid adaptive UTC risk day.');
    if (risk.dayUtc === currentDay && risk.realizedUsdt <= -d.maxDailyLossUsdt) return 'Daily realized virtual-loss budget reached';
    if (risk.consecutiveLosses >= d.consecutiveLossLimit && now - risk.lastLossAt < d.consecutiveLossCooldownSeconds * 1000) return 'Consecutive-loss cooldown';
    if (risk.lastLossAt > 0 && now - risk.lastLossAt < d.lossCooldownSeconds * 1000) return 'Recent-loss cooldown';
  }
  if (state.orders.filter(order => order.side === 'BUY' && order.time > now - 3600000).length >= config.maxBuysPerHour) return 'Hourly virtual BUY limit reached';
  if (!state.position) {
    const lastSell = Math.max(0, ...state.orders.filter(order => order.side === 'SELL').map(order => order.time));
    if (now - lastSell < config.cooldownSeconds * 1000) return 'Flat-position re-entry cooldown';
  }
  return null;
}

export function adaptiveSignal(candles, config, state, book, now = Date.now()) {
  const d = profileDefaults(config); const short = d === ADAPTIVE_SHORT_DEFAULTS;
  const cfg = settings(config, d); const quote = validBook(book);
  if (book.symbol !== config.symbol || !Number.isSafeInteger(now) || now <= 0 || !state || !Array.isArray(state.orders) ||
      state.orders.some(order => !order || !['BUY', 'SELL'].includes(order.side) || !Number.isSafeInteger(order.time) || order.time <= 0)) throw new Error('Invalid adaptive decision context.');
  validateCandles(candles, cfg, now);
  const values = indicators(candles, cfg, d);
  if (Object.values(values).some(value => value !== null && !finite(value))) throw new Error('Adaptive indicators exceed the supported range.');
  const samples = updateAdaptiveSamples(state.adaptiveSamples ?? [], book, now);
  const warmReady = samples.length >= 3 && now - samples[0].time >= 10000 &&
    samples.every((item, index) => index === 0 || item.time - samples[index - 1].time <= d.maxSampleGapSeconds * 1000);
  const momentumPercent = warmReady ? (quote.mid / samples[0].price - 1) * 100 : null;
  if (momentumPercent !== null && !finite(momentumPercent)) throw new Error('Adaptive observation return exceeds the supported range.');
  const fees = short ? selectCommissionFees(state.adaptiveFeeContext, config.symbol, now) : null;
  const buyFeePercent = fees?.buyFeePercent ?? d.feePerSidePercent;
  const sellFeePercent = fees?.sellFeePercent ?? d.feePerSidePercent;
  const roundTripCostPercent = buyFeePercent + sellFeePercent + d.slippagePerSidePercent * 2 + quote.spreadPercent;
  const minGrossOpportunityPercent = roundTripCostPercent + d.minNetEdgePercent;
  const opportunityProxyPercent = values.atrPercent * 4;
  if (![roundTripCostPercent, minGrossOpportunityPercent, opportunityProxyPercent].every(finite)) throw new Error('Adaptive cost proxy exceeds the supported range.');
  const position = state.position; const held = positionData(position, quote.bid, now);
  const dynamicRisk = {
    stopLossPercent: clamp(Math.max(cfg.stopLoss, values.atrPercent * 1.4), short ? 0.1 : 0.15, short ? 0.4 : 0.75),
    takeProfitPercent: clamp(Math.max(cfg.takeProfit, values.atrPercent * 2.2, minGrossOpportunityPercent), short ? 0.1 : 0.25, short ? 0.6 : 1.2),
    ...(short ? { costSnapshot: {
      buyFeePercent, sellFeePercent, slippagePerSidePercent: d.slippagePerSidePercent,
      source: fees.source, checkedAt: fees.checkedAt, verified: fees.verified
    } } : {})
  };
  const riskSnapshot = position?.riskSnapshot ? {
    stopLossPercent: position.riskSnapshot.stopLossPercent, takeProfitPercent: position.riskSnapshot.takeProfitPercent,
    ...(position.riskSnapshot.costSnapshot ? { costSnapshot: { ...position.riskSnapshot.costSnapshot } } : {})
  } : position ? { stopLossPercent: cfg.stopLoss, takeProfitPercent: cfg.takeProfit } : dynamicRisk;
  if (!['stopLossPercent', 'takeProfitPercent'].every(key => finite(riskSnapshot[key]) && riskSnapshot[key] > 0 && riskSnapshot[key] <= 50)) throw new Error('Invalid frozen adaptive risk thresholds.');
  if (riskSnapshot.costSnapshot) {
    const cost = riskSnapshot.costSnapshot;
    if (!['buyFeePercent', 'sellFeePercent', 'slippagePerSidePercent'].every(key => finite(cost[key]) && cost[key] >= 0 && cost[key] <= 100) ||
        typeof cost.source !== 'string' || !cost.source || typeof cost.verified !== 'boolean' ||
        !(cost.checkedAt === null || Number.isSafeInteger(cost.checkedAt) && cost.checkedAt > 0 && cost.checkedAt <= now)) {
      throw new Error('Invalid frozen adaptive cost snapshot.');
    }
  }
  const deployed = position ? position.deployedUsdt ?? position.quantity * position.entryPrice : 0;
  if (!finite(deployed) || deployed < 0) throw new Error('Invalid adaptive deployment record.');
  const result = { side: null, reason: '', checkedAt: now, fast: values.fast, slow: values.slow,
    momentumPercent, spreadPercent: quote.spreadPercent, warmReady, sampleCount: samples.length,
    batchIndex: null, batchUsdt: null, candle: Math.floor(now / 5000) * 5000, route: null,
    remainingBudget: Math.max(0, cfg.tradeUsdt - deployed), riskSnapshot,
    positionUpdate: held ? { peakBid: held.peakBid } : null,
    indicators: { ...values, trendScore: 0, reboundScore: 0 },
    thresholds: { roundTripCostPercent, minGrossOpportunityPercent, opportunityProxyPercent,
      netEdgeBufferPercent: d.minNetEdgePercent, opportunityIsResearchProxy: true,
      maxSpreadPercent: d.maxSpreadPercent, maxExtensionPercent: d.maxExtensionPercent,
      minOrderSeconds: d.minOrderSeconds, trailingDistancePercent: clamp(values.atrPercent * 0.8, 0.08, 0.25),
      trailingArmPercent: minGrossOpportunityPercent + 0.1,
      ...(short ? { buyFeePercent, sellFeePercent, feeVerified: fees.verified, feeSource: fees.source,
        checkedAt: fees.checkedAt, expiresAt: fees.expiresAt } : {}) }
  };
  const wait = reason => ({ ...result, reason }); const sell = reason => ({ ...result, side: 'SELL', reason });
  if (state.pending) return wait('Pending Testnet order must be reconciled before another decision');
  // Existing inventory protection takes precedence over entry-only guards.
  if (held) {
    if (held.profitPercent <= -riskSnapshot.stopLossPercent + 1e-10) return sell('Adaptive stop loss');
    if (held.profitPercent >= riskSnapshot.takeProfitPercent - 1e-10) return sell('Adaptive take profit');
    if (held.heldMs >= cfg.maxHoldMinutes * 60000) return sell('Adaptive maximum holding time exit');
  }
  const latestOrder = Math.max(0, ...state.orders.map(order => order.time));
  if (now - latestOrder < d.minOrderSeconds * 1000) return wait('Waiting for minimum five-second order interval');
  if (held && held.heldMs >= d.minSignalHoldSeconds * 1000) {
    const costCovered = held.profitPercent >= minGrossOpportunityPercent;
    const peakProfit = (held.peakBid / position.entryPrice - 1) * 100;
    const retracement = (1 - quote.bid / held.peakBid) * 100;
    // Once the observed peak covers estimated costs plus the buffer, a fast
    // gap below that cost level must not disarm the trailing protection.
    if (peakProfit >= result.thresholds.trailingArmPercent &&
        retracement >= result.thresholds.trailingDistancePercent) return sell('Fee-aware trailing exit');
    if (costCovered && held.heldMs >= d.softHoldMinutes * 60000) return sell('Fee-covered soft holding timeout');
    const contextWeak = values.fast < values.slow && values.contextFast < values.contextSlow;
    const momentumWeak = warmReady && momentumPercent <= -d.reversalMomentumPercent &&
      (values.fast < values.slow || values.rsi < 45);
    if (contextWeak || momentumWeak) return sell('Confirmed adaptive trend weakness');
  }
  if (!warmReady) return wait('Warming up: need three observations spanning 10–30 seconds');
  if (quote.spreadPercent > d.maxSpreadPercent + 1e-10) return wait('Public bid/ask spread is too wide');
  if (Math.abs((quote.mid / values.fast - 1) * 100) > d.maxExtensionPercent + 1e-10) return wait('Price is too extended from the fast EMA');
  if (opportunityProxyPercent < minGrossOpportunityPercent - 1e-10) return wait('Volatility research proxy does not cover estimated costs and safety buffer');
  const trendScore = Number(values.fast > values.slow) + Number(values.fast > values.previousFast) +
    Number(values.contextFast >= values.contextSlow) + Number(momentumPercent >= d.minTrendMomentumPercent) +
    Number(values.rsi >= 45 && values.rsi <= 78) + Number(values.volumeRatio !== null && values.volumeRatio >= 0.8);
  const before = candles.at(-3); const previous = candles.at(-2); const current = candles.at(-1);
  const rebounding = previous.close < before.close && current.close > previous.close;
  const reboundScore = Number(rebounding) + Number(values.rsi > values.previousRsi) +
    Number(values.contextFast >= values.contextSlow) + Number(values.volumeRatio !== null && values.volumeRatio >= 0.7) + Number(quote.mid >= values.fast);
  result.indicators = { ...values, trendScore, reboundScore };
  const trend = values.fast > values.slow && quote.mid >= values.fast && momentumPercent >= d.minTrendMomentumPercent && trendScore >= 4;
  const rebound = rebounding && quote.mid >= current.close && momentumPercent >= d.minReboundMomentumPercent &&
    values.contextBiasPercent >= -0.15 && reboundScore >= 3;
  const route = trend ? 'trend_continuation' : rebound ? 'pullback_rebound' : null;
  if (!route) return wait('No confirmed trend-continuation or pullback-rebound route');
  const blocked = entryGuard(cfg, state, now, d); if (blocked) return wait(blocked);
  if (position) {
    if (position.adopted || !Number.isInteger(position.batches) || position.batches < 1 || position.batches >= 3) return wait('Existing/adopted inventory is exit-only or already fully staged');
    if (!finite(position.lastEntryPrice) || position.lastEntryPrice <= 0) throw new Error('Missing last adaptive tranche execution price.');
    if (quote.bid <= position.entryPrice || quote.mid < position.lastEntryPrice * (1 + d.addStepPercent / 100)) return wait('Addition requires a profitable holding and a confirmed price advance');
  }
  const batchIndex = position ? position.batches + 1 : 1;
  const batchUsdt = Math.floor(Math.min(cfg.tradeUsdt * d.batchFractions[batchIndex - 1], result.remainingBudget) * 100 + 1e-8) / 100;
  if (batchUsdt <= 0) return wait('Virtual position deployment budget is exhausted');
  return { ...result, side: 'BUY', route, batchIndex, batchUsdt,
    reason: `Confirmed ${route.replaceAll('_', ' ')}; tranche ${batchIndex}/3` };
}
