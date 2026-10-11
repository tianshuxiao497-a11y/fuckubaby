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
  const symbol = env.TESTNET_SYMBOL || 'BTCUSDT';
  const interval = env.TESTNET_INTERVAL || '5m';
  if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(symbol) || !intervals[interval]) {
    throw new Error('仅支持 BTCUSDT / ETHUSDT / SOLUSDT 以及 1m / 5m / 15m / 1h。');
  }
  const fast = number('TESTNET_FAST_PERIOD', 9, 3, 50, true);
  const slow = number('TESTNET_SLOW_PERIOD', 21, 5, 100, true);
  if (fast >= slow) throw new Error('慢速均线周期必须大于快速均线。');
  return {
    symbol, interval, intervalMs: intervals[interval], fast, slow,
    tradeUsdt: number('TESTNET_TRADE_USDT', 100, 25, 1000),
    stopLoss: number('TESTNET_STOP_LOSS_PERCENT', 1.5, 0.1, 20),
    takeProfit: number('TESTNET_TAKE_PROFIT_PERCENT', 3, 0.1, 50),
    pollSeconds: number('TESTNET_POLL_SECONDS', 60, 30, 3600, true)
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
    const started = Date.now();
    const result = await this.request('GET', '/api/v3/time');
    if (!Number.isFinite(result.serverTime)) throw new Error('Testnet 时间响应无效。');
    this.clockOffset = result.serverTime - (started + Date.now()) / 2;
    return result.serverTime;
  }

  async request(method, path, params = {}, signed = false) {
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
      throw new Error('Testnet HTTPS 连接失败或超时；停止此次操作，不重发订单。');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('Testnet 响应无法解析；订单结果需先核对。'); }
    if (!response.ok || (typeof result.code === 'number' && result.code < 0)) {
      const error = new Error(response.status === 451 || (response.status === 403 && result.code === 0)
        ? 'Testnet 服务端拒绝当前地区或来源的访问，请核实服务资格或联系 Binance 支持。'
        : `Testnet 请求失败（HTTP ${response.status}，代码 ${result.code ?? '未知'}）。`);
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result;
  }
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

export function strategySignal(candles, config, state, currentPrice) {
  const candle = candles.at(-1);
  if (!candle || candles.length < config.slow + 1) throw new Error('均线数据不足。');
  if (state.lastCandle === candle.time) return { side: null, reason: '此根收盘 K 线已处理', candle: candle.time };
  const sma = (period, end) => candles.slice(end - period, end).reduce((sum, item) => sum + item.close, 0) / period;
  const end = candles.length;
  const fast = sma(config.fast, end);
  const slow = sma(config.slow, end);
  const previousFast = sma(config.fast, end - 1);
  const previousSlow = sma(config.slow, end - 1);
  const position = state.position;
  let side = null;
  let reason = '等待均线交叉';
  if (position) {
    const change = (currentPrice / position.entryPrice - 1) * 100;
    if (change <= -config.stopLoss) { side = 'SELL'; reason = '止损'; }
    else if (change >= config.takeProfit) { side = 'SELL'; reason = '止盈'; }
    else if (previousFast >= previousSlow && fast < slow) { side = 'SELL'; reason = '均线下穿'; }
  } else if (previousFast <= previousSlow && fast > slow) { side = 'BUY'; reason = '均线上穿'; }
  return { side, reason, candle: candle.time, fast, slow };
}

// Decimal arithmetic avoids step-size errors such as 0.3 / 0.1 in IEEE floats.
const scale = 100_000_000n;
function decimalUnits(value) {
  if (typeof value === 'number') {
    const units = Math.floor(value * Number(scale));
    if (!Number.isSafeInteger(units) || units < 0) throw new Error('数量超出安全精度范围。');
    return BigInt(units);
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
    symbol: config.symbol, interval: config.interval,
    position: null, lastCandle: null, pending: null, orders: []
  };
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

export async function runCycle(client, config, state, persist, enableOrders = false) {
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
  const signal = strategySignal(candles, config, state, price);
  if (!enableOrders) return { action: '仅预览，不创建委托', symbol: config.symbol, price, ...signal };
  if (!signal.side) {
    state.lastCandle = signal.candle;
    await persist(state);
    return { action: signal.reason, price };
  }
  const account = await client.request('GET', '/api/v3/account', { omitZeroBalances: true }, true);
  if (!account.canTrade) throw new Error('Testnet 密钥没有虚拟交易权限。');
  const free = asset => {
    const balance = Number(account.balances.find(balance => balance.asset === asset)?.free ?? 0);
    if (!Number.isFinite(balance) || balance < 0) throw new Error('Testnet 余额无效。');
    return balance;
  };
  const quantity = marketQuantity(signal.side === 'BUY'
    ? Math.min(config.tradeUsdt, free('USDT') * 0.99) / price
    : Math.min(state.position.quantity, free(symbolInfo.baseAsset)), price, symbolInfo);
  const pending = {
    clientOrderId: 'quant-' + createHash('sha256').update(`${state.accountTag}:${config.symbol}:${config.interval}:${signal.candle}:${signal.side}`).digest('hex').slice(0, 28),
    candle: signal.candle, side: signal.side, reason: signal.reason, quantity
  };
  // Save before POST. If the process crashes or the response is lost, query;
  // NEVER assume the order failed and NEVER blindly retry a POST.
  state.pending = pending;
  await persist(state);
  const order = await client.request('POST', '/api/v3/order', {
    symbol: config.symbol, side: signal.side, type: 'MARKET', quantity,
    newClientOrderId: pending.clientOrderId, newOrderRespType: 'FULL'
  }, true);
  await settleOrder(client, state, pending, order, symbolInfo.baseAsset);
  await persist(state);
  return { action: `Testnet 虚拟${signal.side === 'BUY' ? '买入' : '卖出'}`, orderId: order.orderId, executedQty: order.executedQty };
}
