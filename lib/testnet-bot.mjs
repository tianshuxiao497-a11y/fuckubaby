import { createHash, createHmac, sign } from 'node:crypto';

// There is deliberately no configurable host or production adapter.
export const TESTNET_ORIGIN = 'https://testnet.binance.vision';
const routes = new Set([
  'GET /api/v3/time', 'GET /api/v3/klines', 'GET /api/v3/exchangeInfo',
  'GET /api/v3/ticker/price', 'GET /api/v3/account', 'GET /api/v3/order',
  'GET /api/v3/openOrders', 'GET /api/v3/myTrades',
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
  if (!['classic', 'fast', 'cycle'].includes(strategy)) throw new Error('仅支持 classic / fast / cycle 测试策略。');
  const rapid = strategy === 'fast';
  const cycling = strategy === 'cycle';
  const shortProfile = rapid || cycling;
  const symbol = env.TESTNET_SYMBOL || 'BTCUSDT';
  const interval = env.TESTNET_INTERVAL || (shortProfile ? '1m' : '5m');
  if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(symbol) || !intervals[interval]) {
    throw new Error('仅支持 BTCUSDT / ETHUSDT / SOLUSDT 以及 1m / 5m / 15m / 1h。');
  }
  if (shortProfile && interval !== '1m') throw new Error('快速/循环实验只使用 1m 已收盘行情作校验。');
  const fast = number('TESTNET_FAST_PERIOD', shortProfile ? 3 : 9, 3, 50, true);
  const slow = number('TESTNET_SLOW_PERIOD', shortProfile ? 7 : 21, 5, 100, true);
  if (fast >= slow) throw new Error('慢速均线周期必须大于快速均线。');
  const cycleSeconds = cycling ? number('TESTNET_CYCLE_SECONDS', 30, 30, 300, true) : 0;
  return {
    strategy, symbol, interval, intervalMs: intervals[interval], fast, slow,
    tradeUsdt: number('TESTNET_TRADE_USDT', 100, 25, shortProfile ? 100 : 1000),
    stopLoss: number('TESTNET_STOP_LOSS_PERCENT', shortProfile ? 0.2 : 1.5, 0.1, 20),
    takeProfit: number('TESTNET_TAKE_PROFIT_PERCENT', shortProfile ? 0.3 : 3, 0.1, 50),
    pollSeconds: number('TESTNET_POLL_SECONDS', cycling ? 5 : rapid ? 10 : 60, cycling ? 5 : rapid ? 10 : 30, cycling ? 30 : 3600, true),
    maxHoldMinutes: rapid ? number('TESTNET_MAX_HOLD_MINUTES', 10, 1, 60, true) : 0,
    cooldownSeconds: cycling ? cycleSeconds : rapid ? number('TESTNET_COOLDOWN_SECONDS', 60, 60, 3600, true) : 0,
    maxBuysPerHour: shortProfile ? number('TESTNET_MAX_BUYS_PER_HOUR', cycling ? 60 : 6, 1, cycling ? 60 : 6, true) : 0,
    cycleSeconds
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
  if (!['fast', 'cycle'].includes(config.strategy) || error.readOnlyTransient !== true || state.pending) return null;
  return Math.min(300, 30 * 2 ** Math.min(Math.max(0, attempts - 1), 4));
}

export async function loadMarket(client, config) {
  const serverTime = await client.syncTime();
  const raw = await client.request('GET', '/api/v3/klines', {
    symbol: config.symbol, interval: config.interval, limit: Math.max(100, config.slow + 3)
  });
  if (!Array.isArray(raw)) throw new Error('Testnet K 线响应无效。');
  const candles = raw.map(row => ({ time: Number(row[0]), close: Number(row[4]), closeTime: Number(row[6]) }))
    .filter(row => row.closeTime < serverTime);
  if (candles.length < config.slow + 1 || candles.some(row => !Number.isFinite(row.time) || !Number.isFinite(row.closeTime) || !Number.isFinite(row.close) || row.close <= 0)) {
    throw new Error('有效已收盘 K 线不足，跳过交易。');
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
    if (quantity < min || (max > 0n && quantity > max)) throw new Error('下单数量不符合 Testnet 数量限制。');
  }
  const notional = Number(fromUnits(quantity)) * price;
  for (const filter of symbolInfo.filters) {
    if (filter.filterType === 'MIN_NOTIONAL' && filter.applyToMarket && notional < Number(filter.minNotional)) {
      throw new Error('数量低于 Testnet 最小委托金额。');
    }
    if (filter.filterType === 'NOTIONAL' && ((filter.applyMinToMarket && notional < Number(filter.minNotional)) || (filter.applyMaxToMarket && notional > Number(filter.maxNotional)))) {
      throw new Error('数量不符合 Testnet 委托金额限制。');
    }
  }
  if (quantity <= 0n) throw new Error('数量不足，跳过交易。');
  return fromUnits(quantity);
}

export function initialState(config, apiKey) {
  return {
    version: 1, mode: 'BINANCE_SPOT_TESTNET',
    accountTag: createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
    symbol: config.symbol, interval: config.interval, strategy: config.strategy,
    position: null, lastCandle: null, pending: null, orders: []
  };
}

export function adoptStrategyState(saved, config, apiKey, now = Date.now()) {
  const expected = initialState(config, apiKey);
  if (!saved || saved.version !== 1 || saved.mode !== expected.mode || saved.accountTag !== expected.accountTag || saved.symbol !== expected.symbol || !intervals[saved.interval] || !Array.isArray(saved.orders)) {
    throw new Error('不能接续不同账户、交易对或无效的测试记录。');
  }
  if (saved.pending) throw new Error('存在待核对委托，禁止切换策略。请先用原配置核对。');
  if (saved.position && (!Number.isFinite(saved.position.quantity) || saved.position.quantity <= 0 || !Number.isFinite(saved.position.entryPrice) || saved.position.entryPrice <= 0 || !Number.isFinite(saved.position.openedAt) || saved.position.openedAt <= 0)) {
    throw new Error('已有持仓数据无效，禁止切换策略。');
  }
  if (saved.orders.some(order => !Number.isFinite(order.time) || order.time <= 0 || !['BUY', 'SELL'].includes(order.side))) throw new Error('历史订单数据无效，禁止切换策略。');
  return { ...saved, interval: config.interval, strategy: config.strategy, lastCandle: null, strategyChangedAt: now, previousInterval: saved.interval };
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
  if (executed > 0) {
    const fills = await client.request('GET', '/api/v3/myTrades', { symbol: state.symbol, orderId: order.orderId, limit: 1000 }, true);
    const matching = Array.isArray(fills) ? fills.filter(fill => fill.orderId === order.orderId) : [];
    if (!matching.length || Math.abs(matching.reduce((sum, fill) => sum + Number(fill.qty), 0) - executed) > 1e-8) {
      throw new Error('成交明细尚未完全返回，保留待核对状态。');
    }
    const baseFee = matching.filter(fill => fill.commissionAsset === baseAsset).reduce((sum, fill) => sum + Number(fill.commission), 0);
    if (!Number.isFinite(baseFee) || baseFee < 0) throw new Error('成交手续费数据无效。');
    if (pending.side === 'BUY') {
      if (baseFee >= executed || quote <= 0) throw new Error('Testnet 买入成交数据无效。');
      state.position = { quantity: executed - baseFee, entryPrice: quote / executed, openedAt: order.transactTime ?? order.time };
    } else {
      const remaining = Math.max(0, (state.position?.quantity ?? 0) - executed - baseFee);
      state.position = remaining > 1e-8 ? { ...state.position, quantity: remaining } : null;
    }
  }
  state.orders = [{ orderId: order.orderId, clientOrderId: pending.clientOrderId, side: pending.side, status: order.status, executedQty: executed, quoteQty: quote, reason: pending.reason, time: Date.now() }, ...state.orders].slice(0, 200);
  state.lastCandle = pending.candle;
  state.pending = null;
  return state;
}

export async function runCycle(client, config, state, persist, enableOrders = false, { manualBuy = false, now = Date.now() } = {}) {
  if (manualBuy && config.strategy === 'cycle') throw new Error('循环模式禁止额外手动试单，以免绕过交易间隔。');
  const candles = await loadMarket(client, config);
  const info = await client.request('GET', '/api/v3/exchangeInfo', { symbol: config.symbol });
  const symbolInfo = info.symbols?.find(symbol => symbol.symbol === config.symbol);
  if (!symbolInfo) throw new Error('Testnet 未返回交易对信息。');
  if (state.pending) {
    const order = await client.request('GET', '/api/v3/order', { symbol: config.symbol, origClientOrderId: state.pending.clientOrderId }, true);
    if (!enableOrders) return { action: '仅预览待核对委托，不修改记录', orderId: order.orderId, status: order.status };
    await settleOrder(client, state, state.pending, order, symbolInfo.baseAsset);
    await persist(state);
    return { action: '已核对上一次 Testnet 委托', orderId: order.orderId };
  }
  const ticker = await client.request('GET', '/api/v3/ticker/price', { symbol: config.symbol });
  const price = Number(ticker.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Testnet 价格无效。');
  if (manualBuy && state.position) throw new Error('已有机器人持仓，拒绝重复执行买入试单。');
  if (manualBuy && entryLimit(config, state, now)) throw new Error('快速策略买入限速中，拒绝手动买入试单。');
  const signal = manualBuy
    ? { side: 'BUY', reason: '用户确认的虚拟买入试单', candle: candles.at(-1).time }
    : strategySignal(candles, config, state, price, now);
  if (!enableOrders) return { action: '仅预览，不创建委托', symbol: config.symbol, price, ...signal };
  if (!signal.side) {
    state.lastCandle = signal.candle;
    await persist(state);
    return { action: signal.reason, price, candle: signal.candle, fast: signal.fast, slow: signal.slow, nextActionAt: signal.nextActionAt, nextSide: signal.nextSide };
  }
  const account = await client.request('GET', '/api/v3/account', { omitZeroBalances: true }, true);
  if (!account.canTrade) throw new Error('Testnet 密钥没有虚拟交易权限。');
  const free = asset => {
    const balance = Number(account.balances.find(balance => balance.asset === asset)?.free ?? 0);
    if (!Number.isFinite(balance) || balance < 0) throw new Error('Testnet 余额无效。');
    return balance;
  };
  const budget = Math.floor(Math.min(config.tradeUsdt, manualBuy ? 99.9 : config.tradeUsdt, free('USDT') * 0.99) * 100) / 100;
  const quoteBuy = signal.side === 'BUY';
  if (quoteBuy && !symbolInfo.quoteOrderQtyMarketAllowed) throw new Error('交易对不支持按虚拟 USDT 金额买入，停止以保证预算上限。');
  const quantity = marketQuantity(signal.side === 'BUY'
    ? budget / price
    : Math.min(state.position.quantity, free(symbolInfo.baseAsset)), price, symbolInfo);
  const pending = {
    clientOrderId: 'quant-' + createHash('sha256').update(`${state.accountTag}:${config.symbol}:${config.interval}:${signal.candle}:${signal.side}:${config.strategy}:${manualBuy ? 'manual' : 'strategy'}:${state.orders[0]?.orderId ?? 'initial'}`).digest('hex').slice(0, 28),
    candle: signal.candle, side: signal.side, reason: signal.reason, quantity,
    ...(quoteBuy ? { quoteOrderQty: budget.toFixed(2) } : {})
  };
  // Save before POST. If the process crashes or the response is lost, query;
  // NEVER assume the order failed and NEVER blindly retry a POST.
  state.pending = pending;
  await persist(state);
  const order = await client.request('POST', '/api/v3/order', {
    symbol: config.symbol, side: signal.side, type: 'MARKET',
    ...(quoteBuy ? { quoteOrderQty: pending.quoteOrderQty } : { quantity }),
    newClientOrderId: pending.clientOrderId, newOrderRespType: 'FULL'
  }, true);
  await settleOrder(client, state, pending, order, symbolInfo.baseAsset);
  await persist(state);
  return { action: `Testnet 虚拟${signal.side === 'BUY' ? '买入' : '卖出'}`, reason: signal.reason, orderId: order.orderId, executedQty: order.executedQty, candle: signal.candle, fast: signal.fast, slow: signal.slow };
}
