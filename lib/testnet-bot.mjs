import { createHash, createHmac, sign } from 'node:crypto';
import { ADAPTIVE_DEFAULTS, ADAPTIVE_SHORT_DEFAULTS, updateAdaptiveSamples, adaptiveSignal } from './adaptive-strategy.mjs';
import { commissionContext, selectCommissionFees } from './testnet-commission.mjs';
import { testnetSymbol } from './testnet-symbols.mjs';

// There is deliberately no configurable host or production adapter.
export const TESTNET_ORIGIN = 'https://testnet.binance.vision';
const routes = new Set([
  'GET /api/v3/time', 'GET /api/v3/klines', 'GET /api/v3/exchangeInfo',
  'GET /api/v3/ticker/price', 'GET /api/v3/ticker/bookTicker', 'GET /api/v3/account', 'GET /api/v3/order',
  'GET /api/v3/openOrders', 'GET /api/v3/myTrades', 'GET /api/v3/account/commission',
  'POST /api/v3/order/test', 'POST /api/v3/order'
]);
const intervals = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

export function readConfig(env = process.env) {
  if (env.BINANCE_BASE_URL || env.BINANCE_API_KEY || env.BINANCE_API_SECRET) {
    throw new Error('检测到非 Testnet 配置。请移除 BINANCE_BASE_URL / BINANCE_API_KEY / BINANCE_API_SECRET。');
  }
  const number = (name, fallback, min, max, integer = false) => {
    const value = Number(env[name] || fallback);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} 必须在 ${min}–${max} 范围内${integer ? '且为整数' : ''}。`);
    }
    return value;
  };
  const strategy = env.TESTNET_STRATEGY || 'classic';
  if (!['classic', 'fast', 'cycle', 'tactical', 'adaptive'].includes(strategy)) throw new Error('Unsupported Testnet strategy.');
  const rapid = strategy === 'fast';
  const cycling = strategy === 'cycle';
  const tactical = strategy === 'tactical';
  const adaptive = strategy === 'adaptive';
  const adaptiveProfile = env.TESTNET_ADAPTIVE_PROFILE || 'standard';
  if (!['standard', 'short'].includes(adaptiveProfile) || (!adaptive && adaptiveProfile !== 'standard')) throw new Error('Invalid adaptive Testnet profile.');
  const shortAdaptive = adaptive && adaptiveProfile === 'short';
  const adaptiveDefaults = shortAdaptive ? ADAPTIVE_SHORT_DEFAULTS : ADAPTIVE_DEFAULTS;
  const shortProfile = rapid || cycling || tactical || adaptive;
  const symbol = env.TESTNET_SYMBOL || 'BTCUSDT';
  const interval = env.TESTNET_INTERVAL || (shortProfile ? '1m' : '5m');
  testnetSymbol(symbol);
  if (!intervals[interval]) {
    throw new Error('仅支持 USDT 现货测试网及 1m / 5m / 15m / 1h。');
  }
  if (shortProfile && interval !== '1m') throw new Error('快速/循环实验只使用 1m 已收盘行情作校验。');
  const fast = number('TESTNET_FAST_PERIOD', shortProfile ? 3 : 9, 3, adaptive ? 30 : 50, true);
  const slow = number('TESTNET_SLOW_PERIOD', adaptive ? 8 : shortProfile ? 7 : 21, 5, adaptive ? 60 : 100, true);
  if (fast >= slow) throw new Error('慢速均线周期必须大于快速均线。');
  const cycleSeconds = cycling ? number('TESTNET_CYCLE_SECONDS', 30, 30, 300, true) : 0;
  return {
    ...(adaptive ? { ...adaptiveDefaults, adaptiveProfile } : {}),
    strategy, symbol, interval, intervalMs: intervals[interval], fast, slow,
    tradeUsdt: number('TESTNET_TRADE_USDT', 100, 25, shortProfile ? 100 : 1000),
    stopLoss: number('TESTNET_STOP_LOSS_PERCENT', adaptive ? adaptiveDefaults.stopLoss : shortProfile ? 0.2 : 1.5, 0.1, adaptive ? 5 : 20),
    takeProfit: number('TESTNET_TAKE_PROFIT_PERCENT', adaptive ? adaptiveDefaults.takeProfit : shortProfile ? 0.3 : 3, 0.1, adaptive ? 10 : 50),
    pollSeconds: number('TESTNET_POLL_SECONDS', cycling || adaptive ? 5 : shortProfile ? 10 : 60, cycling || adaptive ? 5 : shortProfile ? 10 : 30, adaptive ? 10 : cycling || tactical ? 30 : 3600, true),
    maxHoldMinutes: rapid || tactical || adaptive ? number('TESTNET_MAX_HOLD_MINUTES', adaptive ? adaptiveDefaults.maxHoldMinutes : tactical ? 3 : 10, 1, shortAdaptive ? 3 : 60, true) : 0,
    cooldownSeconds: cycling ? cycleSeconds : rapid || tactical || adaptive ? number('TESTNET_COOLDOWN_SECONDS', adaptive ? 10 : tactical ? 30 : 60, adaptive ? 5 : tactical ? 30 : 60, 3600, true) : 0,
    maxBuysPerHour: shortProfile ? number('TESTNET_MAX_BUYS_PER_HOUR', cycling || tactical || adaptive ? 60 : 6, 1, cycling || tactical || adaptive ? 60 : 6, true) : 0,
    cycleSeconds,
    ...(tactical ? {
      minOrderSeconds: 10, batchFractions: [0.25, 0.25, 0.5],
      entryMomentumPercent: 0.02, exitMomentumPercent: 0.04,
      maxSpreadPercent: 0.05, maxExtensionPercent: 0.2, addStepPercent: 0.01
    } : {})
  };
}

export class TestnetClient {
  constructor({ apiKey = '', apiSecret = '', privateKey = null, allowOrders = false, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.privateKey = privateKey;
    this.allowOrders = allowOrders;
    this.fetchImpl = fetchImpl;
    this.clockOffset = 0;
  }

  async syncTime() {
    const result = await this.request('GET', '/api/v3/time');
    if (!Number.isFinite(result.serverTime)) throw new Error('Testnet 时间响应无效。');
    // Binance rejects timestamps >= 1s ahead. A midpoint estimate can be
    // ahead under asymmetric latency; prefer a conservative received time.
    this.clockOffset = result.serverTime - Date.now() - 250;
    return result.serverTime;
  }

  async request(method, path, params = {}, signed = false, allowTimeResync = true) {
    if (!routes.has(`${method} ${path}`)) throw new Error('禁止的 Testnet API 路径。');
    if (method === 'POST' && path === '/api/v3/order' && !this.allowOrders) {
      throw new Error('当前为预览模式，禁止创建 Testnet 委托。');
    }
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const headers = { Accept: 'application/json' };
    if (signed) {
      if (!this.apiKey || (!this.apiSecret && !this.privateKey)) {
        throw new Error('还未填写本机 .env.testnet 的 Testnet 专用密钥。');
      }
      if (this.apiSecret && this.privateKey) throw new Error('HMAC 与 Ed25519 只能选择一种签名方式。');
      query.set('recvWindow', '5000');
      query.set('timestamp', String(Math.round(Date.now() + this.clockOffset)));
      const payload = query.toString();
      const signature = this.privateKey
        ? sign(null, Buffer.from(payload), this.privateKey).toString('base64')
        : createHmac('sha256', this.apiSecret).update(payload).digest('hex');
      query.set('signature', signature);
      headers['X-MBX-APIKEY'] = this.apiKey;
    }
    const url = new URL(path, TESTNET_ORIGIN);
    const options = { method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) };
    if (method === 'GET') url.search = query.toString();
    else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = query.toString();
    }
    let response;
    try {
      response = await this.fetchImpl(url, options);
    } catch {
      const error = new Error('Testnet HTTPS 连接失败或超时；停止此次操作，不重发订单。');
      error.readOnlyTransient = method === 'GET';
      throw error;
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('Testnet 响应无法解析；订单结果需先核对。'); }
    if (!response.ok || (typeof result.code === 'number' && result.code < 0)) {
      // A GET is read-only. Resync exactly once for -1021; NEVER retry POST.
      if (signed && method === 'GET' && response.status === 400 && result.code === -1021 && allowTimeResync) {
        await this.syncTime();
        return this.request(method, path, params, signed, false);
      }
      const error = new Error(response.status === 451 || (response.status === 403 && result.code === 0)
        ? 'Testnet 服务端拒绝当前地区或来源的访问，请核实服务资格或联系 Binance 支持。'
        : `Testnet 请求失败（HTTP ${response.status}，代码 ${result.code ?? '未知'}）。`);
      error.status = response.status;
      error.code = result.code;
      error.readOnlyTransient = method === 'GET' && ((response.status === 400 && result.code === -1021) || response.status >= 500);
      throw error;
    }
    return result;
  }
}

export function readOnlyRecoveryDelay(error, config, state, attempts) {
  if (!['fast', 'cycle', 'tactical', 'adaptive'].includes(config.strategy) || error.readOnlyTransient !== true || state.pending) return null;
  return Math.min(300, 30 * 2 ** Math.min(Math.max(0, attempts - 1), 4));
}

export async function loadMarket(client, config) {
  const serverTime = await client.syncTime();
  const raw = await client.request('GET', '/api/v3/klines', {
    symbol: config.symbol, interval: config.interval, limit: Math.max(100, config.slow + 3)
  });
  if (!Array.isArray(raw)) throw new Error('Testnet K 线响应无效。');
  const numeric = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) ? Number(value) : NaN;
  if (config.strategy === 'adaptive' && raw.some(row => !Array.isArray(row) || row.length < 7 ||
    !Number.isSafeInteger(numeric(row[0])) || !Number.isSafeInteger(numeric(row[6])) ||
    numeric(row[0]) <= 0 || numeric(row[6]) !== numeric(row[0]) + config.intervalMs - 1)) {
    throw new Error('Malformed adaptive candle timestamps; no order.');
  }
  const candles = raw.map(row => ({ time: numeric(row?.[0]), close: numeric(row?.[4]), closeTime: numeric(row?.[6]),
    ...(config.strategy === 'adaptive' ? { open: numeric(row?.[1]), high: numeric(row?.[2]), low: numeric(row?.[3]), volume: numeric(row?.[5]) } : {}) }))
    .filter(row => row.closeTime < serverTime);
  if (candles.length < config.slow + 1 || candles.some(row => !Number.isFinite(row.time) || !Number.isFinite(row.closeTime) || !Number.isFinite(row.close) || row.close <= 0)) {
    throw new Error('有效已收盘 K 线不足，跳过交易。');
  }
  if (config.strategy === 'adaptive' && (candles.length < 60 || candles.some(row =>
    !Number.isInteger(row.time) || row.time % config.intervalMs !== 0 || row.closeTime !== row.time + config.intervalMs - 1 ||
    ![row.open, row.high, row.low, row.volume].every(Number.isFinite) || row.open <= 0 || row.low <= 0 || row.volume < 0 ||
    row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close)))) {
    throw new Error('Invalid or insufficient closed adaptive OHLCV candles; no order.');
  }
  if (serverTime - candles.at(-1).closeTime > config.intervalMs * 2) {
    throw new Error('Testnet K 线过期，跳过交易。');
  }
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].time - candles[index - 1].time !== config.intervalMs) {
      throw new Error('Testnet K 线不连续，跳过交易。');
    }
  }
  return candles;
}

export function signalIndicators(candles, config) {
  if (candles.length < config.slow + 1) throw new Error('均线数据不足。');
  const sma = (period, end) => candles.slice(end - period, end).reduce((sum, item) => sum + item.close, 0) / period;
  const end = candles.length;
  return {
    candle: candles.at(-1).time, closeTime: candles.at(-1).closeTime,
    fast: sma(config.fast, end), slow: sma(config.slow, end),
    previousFast: sma(config.fast, end - 1), previousSlow: sma(config.slow, end - 1)
  };
}

function entryLimit(config, state, now) {
  if (!['fast', 'cycle'].includes(config.strategy)) return null;
  const latest = Math.max(0, ...state.orders.map(order => order.time));
  if (now - latest < config.cooldownSeconds * 1000) return '买入冷却期';
  const buys = state.orders.filter(order => order.side === 'BUY' && order.time > now - 3_600_000);
  if (buys.length >= config.maxBuysPerHour) return '已达每小时买入上限';
  return null;
}

export function cycleSignal(config, state, now = Date.now()) {
  if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(config.cycleSeconds) || config.cycleSeconds < 30 || !Array.isArray(state.orders)) throw new Error('循环计时数据无效，禁止下单。');
  if (state.orders.some(order => !Number.isFinite(order.time) || order.time <= 0 || !['BUY', 'SELL'].includes(order.side))) throw new Error('循环订单记录无效，禁止下单。');
  if (state.position && (!Number.isFinite(state.position.openedAt) || state.position.openedAt <= 0)) throw new Error('循环持仓缺少实际买入时间，禁止下单。');
  const latest = Math.max(0, state.position?.openedAt || 0, ...state.orders.map(order => order.time));
  const nextSide = state.position ? 'SELL' : 'BUY';
  const nextActionAt = latest ? latest + config.cycleSeconds * 1000 : now;
  const result = { side: null, nextSide, nextActionAt, candle: Math.floor(now / (config.cycleSeconds * 1000)) * config.cycleSeconds * 1000 };
  if (state.pending) return { ...result, reason: '循环暂停：存在待核对委托' };
  if (now < nextActionAt) return { ...result, reason: `循环等待：下次${nextSide === 'BUY' ? '买入' : '卖出'}还需约 ${Math.ceil((nextActionAt - now) / 1000)} 秒` };
  const blocked = nextSide === 'BUY' ? entryLimit(config, state, now) : null;
  if (blocked) return { ...result, reason: blocked };
  // One current action only: no catch-up burst after downtime, no SMA gating.
  return { ...result, side: nextSide, reason: `${config.cycleSeconds}秒循环试验${nextSide === 'BUY' ? '买入' : '卖出'}` };
}

function tacticalBook(book) {
  const bid = Number(book?.bidPrice); const ask = Number(book?.askPrice);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask < bid ||
      !Number.isFinite(Number(book?.bidQty)) || Number(book.bidQty) <= 0 ||
      !Number.isFinite(Number(book?.askQty)) || Number(book.askQty) <= 0) {
    throw new Error('测试网盘口数据无效，禁止下单。');
  }
  return { bid, ask, mid: (bid + ask) / 2, spreadPercent: (ask - bid) / ((bid + ask) / 2) * 100 };
}

export function updateTacticalSamples(samples = [], book, now = Date.now()) {
  const { mid } = tacticalBook(book);
  if (!Number.isFinite(now) || now <= 0 || !Array.isArray(samples) || samples.some((sample, i) =>
    !Number.isFinite(sample.time) || sample.time <= 0 || !Number.isFinite(sample.price) || sample.price <= 0 ||
    (i > 0 && sample.time <= samples[i - 1].time))) throw new Error('短线采样记录无效。');
  if (samples.at(-1)?.time > now) throw new Error('短线采样时间倒退，禁止下单。');
  const recent = now - (samples.at(-1)?.time ?? now) > 35_000 ? [] : samples.filter(sample => now - sample.time <= 45_000);
  if (recent.at(-1)?.time === now) return [...recent.slice(0, -1), { time: now, price: mid }];
  return [...recent, { time: now, price: mid }].slice(-6);
}

export function tacticalSignal(candles, config, state, book, now = Date.now()) {
  const { bid, mid, spreadPercent } = tacticalBook(book);
  if (book.symbol !== config.symbol || !Number.isFinite(now) || now <= 0 || !Array.isArray(state.orders) ||
      state.orders.some(order => !Number.isFinite(order.time) || order.time <= 0 || !['BUY', 'SELL'].includes(order.side))) {
    throw new Error('短线判断数据无效，禁止下单。');
  }
  const indicators = signalIndicators(candles, config);
  const samples = state.tacticalSamples || [];
  // Validate persisted samples; only contiguous, recent observations may enter.
  updateTacticalSamples(samples, book, now);
  const recent = samples.filter(sample => now - sample.time <= 45_000 && sample.time <= now);
  const first = recent[0]; const last = recent.at(-1);
  const warmReady = recent.length >= 3 && last.time === now && now - first.time >= 20_000 &&
    recent.every((sample, index) => index === 0 || sample.time - recent[index - 1].time <= 35_000);
  const momentumPercent = warmReady ? (mid / first.price - 1) * 100 : null;
  const position = state.position;
  if (position && (!Number.isFinite(position.quantity) || position.quantity <= 0 || !Number.isFinite(position.entryPrice) || position.entryPrice <= 0 || !Number.isFinite(position.openedAt) || position.openedAt <= 0)) throw new Error('短线持仓记录无效。');
  const deployed = position ? position.deployedUsdt ?? position.quantity * position.entryPrice : 0;
  if (!Number.isFinite(deployed) || deployed < 0) throw new Error('分批投入记录无效。');
  const remainingBudget = Math.max(0, config.tradeUsdt - deployed);
  const result = { side: null, reason: '', checkedAt: now, fast: indicators.fast, slow: indicators.slow,
    momentumPercent, spreadPercent, sampleCount: recent.length, warmReady, batchIndex: null, batchUsdt: null,
    remainingBudget, candle: Math.floor(now / 10_000) * 10_000 };
  const wait = reason => ({ ...result, reason });
  const sell = reason => ({ ...result, side: 'SELL', reason });
  if (state.pending) return wait('存在待核对委托，暂停新决策');
  // Risk exits do not require warm-up, entry signals, or a buy cooldown.
  if (position) {
    const change = (bid / position.entryPrice - 1) * 100;
    if (change <= -config.stopLoss + 1e-10) return sell('短线止损');
    if (change >= config.takeProfit - 1e-10) return sell('短线止盈');
    if (now - position.openedAt >= config.maxHoldMinutes * 60_000) return sell('短线持仓超时');
  }
  const latest = Math.max(0, ...state.orders.map(order => order.time));
  if (now - latest < config.minOrderSeconds * 1000) return wait('等待最短 10 秒下单间隔');
  if (position && indicators.fast < indicators.slow) return sell('短线趋势转弱');
  if (position && warmReady && momentumPercent <= -config.exitMomentumPercent + 1e-10) return sell('短线动量反转');
  if (!warmReady) return wait('采样预热：等待连续 20–45 秒价格观察');
  if (spreadPercent > config.maxSpreadPercent + 1e-10) return wait('买卖价差过大，暂不买入');
  if (indicators.fast <= indicators.slow || mid < indicators.fast) return wait('趋势未向上，暂不买入');
  if (momentumPercent < config.entryMomentumPercent - 1e-10) return wait('上涨动量不足，暂不买入');
  if ((mid / indicators.fast - 1) * 100 > config.maxExtensionPercent + 1e-10) return wait('偏离均线过大，不追高');
  const buys = state.orders.filter(order => order.side === 'BUY' && order.time > now - 3_600_000);
  if (buys.length >= config.maxBuysPerHour) return wait('已达每小时买入上限');
  if (!position) {
    const lastSell = Math.max(0, ...state.orders.filter(order => order.side === 'SELL').map(order => order.time));
    if (now - lastSell < config.cooldownSeconds * 1000) return wait('卖出后买入冷却期');
  } else {
    if (position.adopted || !Number.isInteger(position.batches) || position.batches < 1 || position.batches >= 3) return wait('持仓监控：已完成分批或接管旧仓，不再加仓');
    if (!Number.isFinite(position.lastEntryPrice) || position.lastEntryPrice <= 0) throw new Error('缺少上一批真实买入价，禁止加仓。');
    if (bid < position.entryPrice || mid < position.lastEntryPrice * (1 + config.addStepPercent / 100)) return wait('加仓确认不足，不摊低成本');
  }
  const batchIndex = position ? position.batches + 1 : 1;
  const batchUsdt = Math.floor(Math.min(config.tradeUsdt * config.batchFractions[batchIndex - 1], remainingBudget) * 100 + 1e-8) / 100;
  if (batchUsdt <= 0) return wait('本轮投入已达上限');
  return { ...result, side: 'BUY', reason: `趋势与动量确认，第 ${batchIndex}/3 批买入`, batchIndex, batchUsdt };
}

export function strategySignal(candles, config, state, currentPrice, now = Date.now()) {
  if (config.strategy === 'cycle') return cycleSignal(config, state, now);
  const candle = candles.at(-1);
  if (!candle || candles.length < config.slow + 1) throw new Error('均线数据不足。');
  const rapid = config.strategy === 'fast';
  const duplicate = state.lastCandle === candle.time;
  if (!rapid && duplicate) return { side: null, reason: '此根收盘 K 线已处理', candle: candle.time };
  const { fast, slow, previousFast, previousSlow } = signalIndicators(candles, config);
  const position = state.position;
  let side = null;
  let reason = '等待均线交叉';
  if (position) {
    const change = (currentPrice / position.entryPrice - 1) * 100;
    if (rapid && (!Number.isFinite(position.openedAt) || position.openedAt <= 0)) throw new Error('快速策略缺少真实买入时间，请先核对持仓。');
    if (change <= -config.stopLoss + 1e-10) { side = 'SELL'; reason = '止损'; }
    else if (change >= config.takeProfit - 1e-10) { side = 'SELL'; reason = '止盈'; }
    else if (rapid && now - position.openedAt >= config.maxHoldMinutes * 60_000) { side = 'SELL'; reason = '最长持仓时间退出'; }
    else if (!duplicate && previousFast >= previousSlow && fast < slow) { side = 'SELL'; reason = '均线下穿'; }
    else if (rapid) reason = duplicate ? '持仓监控：本分钟均线已检查，继续检查退出条件' : '持仓监控：未触发退出';
  } else if (!duplicate && previousFast <= previousSlow && fast > slow) {
    const blocked = entryLimit(config, state, now);
    if (blocked) reason = blocked;
    else { side = 'BUY'; reason = '均线上穿'; }
  } else if (duplicate) reason = '此根收盘 K 线已处理';
  return { side, reason, candle: candle.time, fast, slow };
}

// Decimal arithmetic avoids step-size errors such as 0.3 / 0.1 in IEEE floats.
const scale = 100_000_000n;
function decimalUnits(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.floor(value * Number(scale)))) throw new Error('数量超出安全精度范围。');
    // Parse the shortest decimal representation, not a binary-float product:
    // 0.0012 * 1e8 can be 119999.99999999999 and lose an entire lot step.
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const digits = BigInt(whole + fraction);
    const shift = 8 + Number(exponent) - fraction.length;
    return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  }
  const source = String(value);
  if (!/^\d+(\.\d{1,8})?$/.test(source)) throw new Error('数量/步长不是有效的正十进制数。');
  const [whole, fraction = ''] = source.split('.');
  return BigInt(whole) * scale + BigInt(fraction.padEnd(8, '0'));
}
function fromUnits(units) { return `${units / scale}.${(units % scale).toString().padStart(8, '0')}`; }
function minimumOrderError(message) { return Object.assign(new Error(message), { code: 'TESTNET_MINIMUM_ORDER' }); }

export function marketQuantity(available, price, symbolInfo) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('价格无效。');
  if (symbolInfo.status !== 'TRADING' || !symbolInfo.orderTypes.includes('MARKET')) throw new Error('交易对当前不支持市价交易。');
  let quantity = decimalUnits(available);
  const filters = symbolInfo.filters.filter(filter => ['LOT_SIZE', 'MARKET_LOT_SIZE'].includes(filter.filterType));
  if (!filters.some(filter => filter.filterType === 'LOT_SIZE')) throw new Error('Testnet 缺少数量限制。');
  // Common multiple of all enabled steps; supports non-power-of-ten steps.
  const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
  let commonStep = 1n;
  for (const filter of filters) {
    const step = decimalUnits(filter.stepSize);
    if (step > 0n) commonStep = commonStep / gcd(commonStep, step) * step;
  }
  quantity = quantity / commonStep * commonStep;
  for (const filter of filters) {
    const min = decimalUnits(filter.minQty);
    const max = decimalUnits(filter.maxQty);
    if (quantity < min) throw minimumOrderError('下单数量不符合 Testnet 数量限制。');
    if (max > 0n && quantity > max) throw new Error('下单数量不符合 Testnet 数量限制。');
  }
  const notional = Number(fromUnits(quantity)) * price;
  for (const filter of symbolInfo.filters) {
    if (filter.filterType === 'MIN_NOTIONAL' && filter.applyToMarket && notional < Number(filter.minNotional)) {
      throw minimumOrderError('数量低于 Testnet 最小委托金额。');
    }
    if (filter.filterType === 'NOTIONAL' && filter.applyMinToMarket && notional < Number(filter.minNotional)) throw minimumOrderError('数量不符合 Testnet 委托金额限制。');
    if (filter.filterType === 'NOTIONAL' && filter.applyMaxToMarket && notional > Number(filter.maxNotional)) throw new Error('数量不符合 Testnet 委托金额限制。');
  }
  if (quantity <= 0n) throw minimumOrderError('数量不足，跳过交易。');
  return fromUnits(quantity);
}

function validateDust(dust = []) {
  if (!Array.isArray(dust) || dust.some(item => !item || !Number.isFinite(item.quantity) || item.quantity <= 0 ||
      !Number.isFinite(item.entryPrice) || item.entryPrice <= 0 || !Number.isFinite(item.openedAt) || item.openedAt <= 0 ||
      !Number.isFinite(item.createdAt) || item.createdAt <= 0 || typeof item.reason !== 'string')) throw new Error('机器人零头记录无效，暂停以便核对。');
}

// Residual inventory remains owned and visible, but is never mixed with gifted
// BTC or the next round's position. Only explicit minimum-size failures qualify;
// malformed filters, halted markets and maximum-size failures still stop.
function archiveUntradeableRemainder(state, symbolInfo, price, now) {
  if (!state.position) return;
  try { marketQuantity(state.position.quantity, price, symbolInfo); }
  catch (error) {
    if (error.code !== 'TESTNET_MINIMUM_ORDER') throw error;
    validateDust(state.dust);
    const { quantity, entryPrice, openedAt } = state.position;
    state.dust = [...(state.dust ?? []), { quantity, entryPrice, openedAt, createdAt: now, reason: error.message }];
    state.position = null;
  }
}

export function initialState(config, apiKey) {
  return {
    version: 1, mode: 'BINANCE_SPOT_TESTNET',
    accountTag: createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
    symbol: config.symbol, interval: config.interval, strategy: config.strategy,
    ...(config.strategy === 'adaptive' ? { adaptiveProfile: config.adaptiveProfile ?? 'standard' } : {}),
    position: null, dust: [], lastCandle: null, pending: null, orders: []
  };
}

export function adoptStrategyState(saved, config, apiKey, now = Date.now()) {
  const expected = initialState(config, apiKey);
  if (!saved || saved.version !== 1 || saved.mode !== expected.mode || saved.accountTag !== expected.accountTag || saved.symbol !== expected.symbol || !intervals[saved.interval] || !Array.isArray(saved.orders)) {
    throw new Error('不能接续不同账户、交易对或无效的测试记录。');
  }
  if (saved.pending) throw new Error('存在待核对委托，禁止切换策略。请先用原配置核对。');
  validateDust(saved.dust);
  if (saved.position && (!Number.isFinite(saved.position.quantity) || saved.position.quantity <= 0 || !Number.isFinite(saved.position.entryPrice) || saved.position.entryPrice <= 0 || !Number.isFinite(saved.position.openedAt) || saved.position.openedAt <= 0)) {
    throw new Error('已有持仓数据无效，禁止切换策略。');
  }
  if (saved.orders.some(order => !Number.isFinite(order.time) || order.time <= 0 || !['BUY', 'SELL'].includes(order.side))) throw new Error('历史订单数据无效，禁止切换策略。');
  const adopted = { ...saved, interval: config.interval, strategy: config.strategy, lastCandle: null, strategyChangedAt: now, previousInterval: saved.interval };
  if (config.strategy === 'adaptive') adopted.adaptiveProfile = config.adaptiveProfile ?? 'standard';
  if (['tactical', 'adaptive'].includes(config.strategy)) {
    const prefix = config.strategy;
    adopted[`${prefix}Samples`] = []; adopted[`${prefix}Decision`] = null;
    if (saved.position) adopted.position = { ...saved.position,
      deployedUsdt: saved.position.deployedUsdt ?? saved.position.quantity * saved.position.entryPrice,
      batches: 3, lastEntryPrice: saved.position.entryPrice, adopted: true };
    if (config.strategy === 'adaptive' && adopted.position && !adopted.position.riskSnapshot) {
      adopted.position.riskSnapshot = { stopLossPercent: config.stopLoss, takeProfitPercent: config.takeProfit };
    }
    if (config.strategy === 'adaptive' && adopted.position) adopted.position.feeValuationComplete = saved.position.feeValuationComplete === true;
  }
  return adopted;
}

export async function settleOrder(client, state, pending, order, baseAsset) {
  if (order.symbol !== state.symbol || order.side !== pending.side || order.clientOrderId !== pending.clientOrderId) {
    throw new Error('Testnet 委托身份不匹配，保留待核对状态。');
  }
  if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(order.status)) {
    throw new Error('Testnet 委托尚未完成，保留待核对记录，暂不创建新委托。');
  }
  const executed = Number(order.executedQty);
  const quote = Number(order.cummulativeQuoteQty);
  if (!Number.isFinite(executed) || executed < 0 || !Number.isFinite(quote) || quote < 0) {
    throw new Error('Testnet 成交数据无效，需要核对。');
  }
  let commissions = [];
  let realizedUsdt = null;
  let realizedPnlComplete = true;
  let nextDailyRisk = state.dailyRisk;
  if (executed > 0) {
    const fills = await client.request('GET', '/api/v3/myTrades', { symbol: state.symbol, orderId: order.orderId, limit: 1000 }, true);
    const matching = Array.isArray(fills) ? fills.filter(fill => fill.orderId === order.orderId) : [];
    if (matching.some(fill => !Number.isFinite(Number(fill.qty)) || Number(fill.qty) <= 0 ||
        !Number.isFinite(Number(fill.commission)) || Number(fill.commission) < 0)) throw new Error('成交数量或手续费数据无效，保留待核对状态。');
    if (!matching.length || Math.abs(matching.reduce((sum, fill) => sum + Number(fill.qty), 0) - executed) > 1e-8) {
      throw new Error('成交明细尚未完全返回，保留待核对状态。');
    }
    const baseFee = matching.filter(fill => fill.commissionAsset === baseAsset).reduce((sum, fill) => sum + Number(fill.commission), 0);
    if (!Number.isFinite(baseFee) || baseFee < 0) throw new Error('成交手续费数据无效。');
    const quoteFee = matching.filter(fill => fill.commissionAsset === 'USDT').reduce((sum, fill) => sum + Number(fill.commission), 0);
    if (!Number.isFinite(quoteFee) || quoteFee < 0) throw new Error('Invalid quote commission.');
    if (matching.some(fill => typeof fill.commissionAsset !== 'string' || !fill.commissionAsset)) throw new Error('Invalid commission asset.');
    commissions = [...new Set(matching.map(fill => fill.commissionAsset))].map(asset => ({
      asset, amount: matching.filter(fill => fill.commissionAsset === asset).reduce((sum, fill) => sum + Number(fill.commission), 0)
    }));
    const unknownFee = commissions.some(fee => fee.amount > 0 && ![baseAsset, 'USDT'].includes(fee.asset));
    if (pending.side === 'BUY') {
      if (baseFee >= executed || quote <= 0) throw new Error('Testnet 买入成交数据无效。');
      if (['tactical', 'adaptive'].includes(pending.strategy)) {
        const previous = state.position;
        const deployedUsdt = (previous?.deployedUsdt ?? 0) + quote;
        if (quote > Number(pending.quoteOrderQty) + 1e-8 || deployedUsdt > (pending.positionBudget ?? 100) + 1e-8 ||
            !Number.isInteger(pending.batchIndex) || pending.batchIndex !== (previous?.batches ?? 0) + 1) {
          throw new Error('分批成交超出预算或批次不一致，保留待核对记录。');
        }
        const quantity = (previous?.quantity ?? 0) + executed - baseFee;
        const cost = (previous ? previous.quantity * previous.entryPrice : 0) + quote + quoteFee;
        const riskSnapshot = previous?.riskSnapshot ?? pending.riskSnapshot;
        if (pending.strategy === 'adaptive' && (!riskSnapshot ||
          !Number.isFinite(riskSnapshot.stopLossPercent) || riskSnapshot.stopLossPercent <= 0 ||
          !Number.isFinite(riskSnapshot.takeProfitPercent) || riskSnapshot.takeProfitPercent <= 0)) {
          throw new Error('Missing frozen adaptive risk settings; retain pending order.');
        }
        state.position = { quantity, entryPrice: cost / quantity, openedAt: previous?.openedAt ?? order.transactTime ?? order.time,
          deployedUsdt, batches: pending.batchIndex, lastEntryPrice: quote / executed, adopted: false,
          feeValuationComplete: previous?.feeValuationComplete !== false && !unknownFee,
          ...(pending.strategy === 'adaptive' ? { riskSnapshot: structuredClone(riskSnapshot), peakBid: Math.max(previous?.peakBid ?? 0, quote / executed) } : {}) };
      } else state.position = { quantity: executed - baseFee, entryPrice: (quote + quoteFee) / (executed - baseFee), openedAt: order.transactTime ?? order.time,
        feeValuationComplete: !unknownFee };
    } else {
      if (!state.position || executed + baseFee > state.position.quantity + 1e-8) throw new Error('卖出成交超过机器人持仓，保留待核对状态。');
      realizedUsdt = quote - quoteFee - state.position.entryPrice * (executed + baseFee);
      realizedPnlComplete = !unknownFee && state.position.feeValuationComplete !== false;
      if (pending.strategy === 'adaptive') {
        const settledAt = Date.now();
        const dayUtc = new Date(settledAt).toISOString().slice(0, 10);
        const old = state.dailyRisk;
        if (old && (typeof old.dayUtc !== 'string' || !Number.isFinite(old.realizedUsdt) ||
          !Number.isInteger(old.consecutiveLosses) || old.consecutiveLosses < 0 || !Number.isFinite(old.lastLossAt))) throw new Error('Invalid daily risk record; retain pending.');
        // Unknown fee assets remain explicitly unvalued in the P&L audit. The
        // entry guard uses at least conservative round-trip fee/slippage costs.
        const notionalCost = state.position.entryPrice * (executed + baseFee);
        const frozenCost = state.position.riskSnapshot?.costSnapshot;
        if (frozenCost && (![frozenCost.buyFeePercent, frozenCost.sellFeePercent, frozenCost.slippagePerSidePercent].every(value =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) ||
          !['BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION', 'CONSERVATIVE_FALLBACK'].includes(frozenCost.source) ||
          typeof frozenCost.verified !== 'boolean' ||
          (frozenCost.verified && (!Number.isSafeInteger(frozenCost.checkedAt) || frozenCost.checkedAt <= 0)))) {
          throw new Error('Invalid frozen cost audit; retain pending order.');
        }
        const costPercent = frozenCost ? frozenCost.buyFeePercent + frozenCost.sellFeePercent + 2 * frozenCost.slippagePerSidePercent
          : 2 * (ADAPTIVE_DEFAULTS.feePerSidePercent + ADAPTIVE_DEFAULTS.slippagePerSidePercent);
        const assumedCosts = notionalCost * costPercent / 100;
        const gross = quote - notionalCost;
        const guardPnl = Math.min(realizedUsdt, gross - assumedCosts);
        const losing = guardPnl < -1e-10;
        nextDailyRisk = { dayUtc, realizedUsdt: (old?.dayUtc === dayUtc ? old.realizedUsdt : 0) + guardPnl,
          consecutiveLosses: losing ? (old?.consecutiveLosses ?? 0) + 1 : 0,
          lastLossAt: losing ? settledAt : old?.lastLossAt ?? 0,
          basis: 'Conservative known P&L less at least assumed round-trip fees/slippage; not a performance estimate' };
      }
      const remaining = Math.max(0, (state.position?.quantity ?? 0) - executed - baseFee);
      state.position = remaining > 1e-12 ? { ...state.position, quantity: remaining } : null;
    }
  }
  if (nextDailyRisk) state.dailyRisk = nextDailyRisk;
  state.orders = [{ orderId: order.orderId, clientOrderId: pending.clientOrderId, side: pending.side, status: order.status,
    executedQty: executed, quoteQty: quote, reason: pending.reason, time: Date.now(), commissions, realizedUsdt, realizedPnlComplete,
    ...(pending.strategy ? { strategy: pending.strategy } : {}),
    ...(pending.adaptiveProfile ? { adaptiveProfile: pending.adaptiveProfile } : {}),
    ...(pending.decisionSnapshot ? { decisionSnapshot: structuredClone(pending.decisionSnapshot) } : {}) }, ...state.orders].slice(0, 200);
  state.lastCandle = pending.candle;
  if (pending.strategy === 'adaptive' && state.adaptiveStats) state.adaptiveStats.lastOrderAt = Date.now();
  state.pending = null;
  return state;
}

// Observation counters are operational diagnostics, not estimated profits or
// a guarantee about the time until another fill. Preserve them across restarts.
function recordAdaptiveCheck(state, decision, now) {
  const old = state.adaptiveStats;
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const waitReasons = Object.fromEntries(Object.entries(old?.waitReasons ?? {}).filter(([key, value]) => key.length <= 600 && validCount(value)).slice(0, 100));
  if (!decision.side) waitReasons[decision.reason] = (waitReasons[decision.reason] ?? 0) + 1;
  state.adaptiveStats = {
    startedAt: Number.isSafeInteger(old?.startedAt) && old.startedAt > 0 ? old.startedAt : now,
    checks: (validCount(old?.checks) ? old.checks : 0) + 1, lastCheckedAt: now,
    lastOrderAt: old?.lastOrderAt ?? null, waitReasons
  };
}

export async function runCycle(client, config, state, persist, enableOrders = false, { manualBuy = false, now } = {}) {
  validateDust(state.dust);
  if (manualBuy && ['cycle', 'tactical', 'adaptive'].includes(config.strategy)) throw new Error('信号/循环策略禁止额外手动试单，以免绕过规则。');
  const candles = await loadMarket(client, config);
  const info = await client.request('GET', '/api/v3/exchangeInfo', { symbol: config.symbol });
  const symbolInfo = info.symbols?.find(symbol => symbol.symbol === config.symbol);
  if (!symbolInfo) throw new Error('Testnet 未返回交易对信息。');
  if (state.pending) {
    const order = await client.request('GET', '/api/v3/order', { symbol: config.symbol, origClientOrderId: state.pending.clientOrderId }, true);
    if (!enableOrders) return { action: '仅预览待核对委托，不修改记录', orderId: order.orderId, status: order.status };
    const pendingSide = state.pending.side;
    const remainderPrice = pendingSide === 'SELL' ? Number((await client.request('GET', '/api/v3/ticker/price', { symbol: config.symbol })).price) : null;
    await settleOrder(client, state, state.pending, order, symbolInfo.baseAsset);
    if (pendingSide === 'SELL') archiveUntradeableRemainder(state, symbolInfo, remainderPrice, now ?? Date.now());
    await persist(state);
    return { action: '已核对上一次 Testnet 委托', orderId: order.orderId };
  }
  const ticker = await client.request('GET', '/api/v3/ticker/price', { symbol: config.symbol });
  const price = Number(ticker.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Testnet 价格无效。');
  let decisionNow = now ?? Date.now();
  let tacticalDecision;
  let adaptiveDecision;
  if (config.strategy === 'tactical') {
    const book = await client.request('GET', '/api/v3/ticker/bookTicker', { symbol: config.symbol });
    decisionNow = now ?? Date.now();
    const tacticalSamples = updateTacticalSamples(state.tacticalSamples, book, decisionNow);
    tacticalDecision = tacticalSignal(candles, config, { ...state, tacticalSamples }, book, decisionNow);
    if (enableOrders) { state.tacticalSamples = tacticalSamples; state.tacticalDecision = tacticalDecision; }
  }
  if (config.strategy === 'adaptive') {
    let adaptiveFeeContext = state.adaptiveFeeContext;
    if (config.adaptiveProfile === 'short' && !state.position && (enableOrders || client.apiKey) &&
        (!selectCommissionFees(adaptiveFeeContext, config.symbol, now ?? Date.now()).verified ||
          (now ?? Date.now()) - adaptiveFeeContext.checkedAt >= 60_000)) {
      const rawFees = await client.request('GET', '/api/v3/account/commission', { symbol: config.symbol }, true);
      adaptiveFeeContext = commissionContext(rawFees, config.symbol, now ?? Date.now());
    }
    const book = await client.request('GET', '/api/v3/ticker/bookTicker', { symbol: config.symbol });
    decisionNow = now ?? Date.now();
    const adaptiveSamples = updateAdaptiveSamples(state.adaptiveSamples, book, decisionNow);
    adaptiveDecision = adaptiveSignal(candles, config, { ...state, adaptiveSamples, adaptiveFeeContext }, book, decisionNow);
    if (enableOrders) {
      state.adaptiveSamples = adaptiveSamples; state.adaptiveDecision = adaptiveDecision;
      if (config.adaptiveProfile === 'short' && adaptiveFeeContext) state.adaptiveFeeContext = structuredClone(adaptiveFeeContext);
      if (state.position && adaptiveDecision.positionUpdate) state.position = { ...state.position, ...adaptiveDecision.positionUpdate };
    }
  }
  if (manualBuy && state.position) throw new Error('已有机器人持仓，拒绝重复执行买入试单。');
  if (manualBuy && entryLimit(config, state, decisionNow)) throw new Error('快速策略买入限速中，拒绝手动买入试单。');
  let signal = manualBuy
    ? { side: 'BUY', reason: '用户确认的虚拟买入试单', candle: candles.at(-1).time }
    : adaptiveDecision ?? tacticalDecision ?? strategySignal(candles, config, state, price, decisionNow);
  if (!enableOrders) return { action: '仅预览，不创建委托', symbol: config.symbol, price, ...signal };
  if (!signal.side) {
    if (adaptiveDecision) recordAdaptiveCheck(state, signal, decisionNow);
    state.lastCandle = signal.candle;
    await persist(state);
    return { action: signal.reason, price, candle: signal.candle, fast: signal.fast, slow: signal.slow, nextActionAt: signal.nextActionAt, nextSide: signal.nextSide, ...(tacticalDecision ? { tactical: tacticalDecision } : {}), ...(adaptiveDecision ? { adaptive: adaptiveDecision } : {}) };
  }
  const account = await client.request('GET', '/api/v3/account', { omitZeroBalances: true }, true);
  if (!account.canTrade) throw new Error('Testnet 密钥没有虚拟交易权限。');
  if (['tactical', 'adaptive'].includes(config.strategy)) {
    const openOrders = await client.request('GET', '/api/v3/openOrders', { symbol: config.symbol }, true);
    if (!Array.isArray(openOrders) || openOrders.length) throw new Error('测试账户存在未完成委托，暂停短线下单以便核对。');
    if (now === undefined && Date.now() - decisionNow > 10_000) {
      const prefix = config.strategy;
      state[`${prefix}Samples`] = []; state[`${prefix}Decision`] = { ...signal, side: null, reason: 'Account verification exceeded ten seconds; discarded stale signal' };
      if (adaptiveDecision) recordAdaptiveCheck(state, state.adaptiveDecision, now ?? Date.now());
      await persist(state); return { action: state[`${prefix}Decision`].reason };
    }
  }
  if (adaptiveDecision && config.adaptiveProfile === 'short' && signal.side === 'BUY') {
    // Do not rely on yesterday's zero-fee fills or a cache when committing a
    // BUY. Recheck the complete symbol commission, then a fresh current quote.
    // SELL protection deliberately never depends on this extra endpoint.
    const rawFees = await client.request('GET', '/api/v3/account/commission', { symbol: config.symbol }, true);
    const context = commissionContext(rawFees, config.symbol, now ?? Date.now());
    const currentBook = await client.request('GET', '/api/v3/ticker/bookTicker', { symbol: config.symbol });
    if (now === undefined && Date.now() - decisionNow > 10_000) {
      state.adaptiveFeeContext = structuredClone(context); state.adaptiveSamples = [];
      state.adaptiveDecision = { ...signal, side: null, reason: 'Commission/account verification exceeded ten seconds; discarded stale signal' };
      recordAdaptiveCheck(state, state.adaptiveDecision, Date.now());
      await persist(state); return { action: state.adaptiveDecision.reason, adaptive: state.adaptiveDecision };
    }
    decisionNow = now ?? Date.now();
    const adaptiveSamples = updateAdaptiveSamples(state.adaptiveSamples, currentBook, decisionNow);
    signal = adaptiveDecision = adaptiveSignal(candles, config, { ...state, adaptiveSamples, adaptiveFeeContext: context }, currentBook, decisionNow);
    state.adaptiveSamples = adaptiveSamples; state.adaptiveDecision = adaptiveDecision; state.adaptiveFeeContext = structuredClone(context);
    if (state.position && signal.positionUpdate) state.position = { ...state.position, ...signal.positionUpdate };
    if (!signal.side) {
      state.lastCandle = signal.candle; recordAdaptiveCheck(state, signal, decisionNow);
      await persist(state); return { action: signal.reason, price, adaptive: signal };
    }
  }
  const free = asset => {
    const balance = Number(account.balances.find(balance => balance.asset === asset)?.free ?? 0);
    if (!Number.isFinite(balance) || balance < 0) throw new Error('Testnet 余额无效。');
    return balance;
  };
  const targetBudget = ['tactical', 'adaptive'].includes(config.strategy) && signal.side === 'BUY' ? signal.batchUsdt : config.tradeUsdt;
  const budget = Math.floor(Math.min(targetBudget, manualBuy ? 99.9 : config.tradeUsdt, free('USDT') * 0.99) * 100 + 1e-8) / 100;
  const quoteBuy = signal.side === 'BUY';
  if (quoteBuy && !symbolInfo.quoteOrderQtyMarketAllowed) throw new Error('交易对不支持按虚拟 USDT 金额买入，停止以保证预算上限。');
  const quantity = marketQuantity(signal.side === 'BUY'
    ? budget / price
    : Math.min(state.position.quantity, free(symbolInfo.baseAsset)), price, symbolInfo);
  const pending = {
    clientOrderId: 'quant-' + createHash('sha256').update(`${state.accountTag}:${config.symbol}:${config.interval}:${signal.candle}:${signal.side}:${config.strategy}:${manualBuy ? 'manual' : 'strategy'}:${state.orders[0]?.orderId ?? 'initial'}`).digest('hex').slice(0, 28),
    candle: signal.candle, side: signal.side, reason: signal.reason, quantity,
    ...(quoteBuy ? { quoteOrderQty: budget.toFixed(2) } : {}),
    ...(['tactical', 'adaptive'].includes(config.strategy) ? { strategy: config.strategy, batchIndex: signal.batchIndex, positionBudget: config.tradeUsdt } : {}),
    ...(adaptiveDecision ? { adaptiveProfile: config.adaptiveProfile ?? 'standard', riskSnapshot: structuredClone(signal.riskSnapshot), decisionSnapshot: structuredClone(signal) } : {})
  };
  // Save before POST. If the process crashes or the response is lost, query;
  // NEVER assume the order failed and NEVER blindly retry a POST.
  state.pending = pending;
  if (adaptiveDecision) recordAdaptiveCheck(state, signal, decisionNow);
  await persist(state);
  const order = await client.request('POST', '/api/v3/order', {
    symbol: config.symbol, side: signal.side, type: 'MARKET',
    ...(quoteBuy ? { quoteOrderQty: pending.quoteOrderQty } : { quantity }),
    newClientOrderId: pending.clientOrderId, newOrderRespType: 'FULL'
  }, true);
  await settleOrder(client, state, pending, order, symbolInfo.baseAsset);
  if (adaptiveDecision && state.adaptiveStats) state.adaptiveStats.lastOrderAt = Date.now();
  if (signal.side === 'SELL') archiveUntradeableRemainder(state, symbolInfo, price, now ?? Date.now());
  await persist(state);
  return { action: `Testnet 虚拟${signal.side === 'BUY' ? '买入' : '卖出'}`, reason: signal.reason, orderId: order.orderId, executedQty: order.executedQty, candle: signal.candle, fast: signal.fast, slow: signal.slow, ...(tacticalDecision ? { tactical: tacticalDecision } : {}), ...(adaptiveDecision ? { adaptive: adaptiveDecision } : {}) };
}
