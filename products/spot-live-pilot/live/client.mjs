import { createHmac, createPrivateKey, sign } from 'node:crypto';

export const MAINNET_ORIGIN = 'https://api.binance.com';
export const LIVE_CONFIRMATION = 'START REAL SPOT TRADING';
const routes = new Map([
  ['GET /api/v3/time', []],
  ['GET /api/v3/exchangeInfo', ['symbol']],
  ['GET /api/v3/ticker/bookTicker', ['symbol']],
  ['GET /api/v3/ticker/price', ['symbol']],
  ['GET /api/v3/klines', ['symbol', 'interval', 'limit', 'startTime', 'endTime']],
  ['GET /api/v3/account', []],
  ['GET /api/v3/account/commission', ['symbol']],
  ['GET /api/v3/openOrders', ['symbol']],
  ['GET /api/v3/order', ['symbol', 'origClientOrderId']],
  ['GET /api/v3/myTrades', ['symbol', 'orderId', 'limit']],
  ['POST /api/v3/order', ['symbol', 'side', 'type', 'timeInForce', 'quantity', 'price', 'newClientOrderId', 'newOrderRespType']],
  ['DELETE /api/v3/order', ['symbol', 'origClientOrderId']],
]);
const signedPaths = new Set(['/api/v3/account', '/api/v3/account/commission', '/api/v3/openOrders', '/api/v3/order', '/api/v3/myTrades']);
const positiveDecimal = value => typeof value === 'string' && /^\d{1,18}(\.\d{1,12})?$/.test(value) && Number(value) > 0;
export const ownOrderId = value => typeof value === 'string' && /^asbl_[a-f0-9]{28}$/.test(value);
export function liveSymbol(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{1,20}USDT$/.test(value) || value === 'USDTUSDT') throw new Error('INVALID_USDT_SYMBOL');
  return value;
}

async function limitedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_EXCHANGE_RESPONSE');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 8388608) throw new Error('EXCHANGE_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('INVALID_EXCHANGE_RESPONSE');
  }
}

export class MainnetSpotClient {
  #key; #secret; #private; #fetch; #now; #offset; #syncedAt; #armed = false; #blocked = false;

  constructor({ apiKey = '', apiSecret = '', privateKeyPem = '', fetchImpl = fetch, now = Date.now, ...extra } = {}) {
    if (Object.keys(extra).length || [apiKey, apiSecret, privateKeyPem].some(v => typeof v !== 'string')) throw new Error('INVALID_CLIENT_OPTIONS');
    if (apiKey.startsWith('apik_') || (apiSecret && privateKeyPem)) throw new Error('PRODUCTION_EXCHANGE_CREDENTIALS_REQUIRED');
    this.#key = apiKey.trim();
    this.#secret = apiSecret.trim();
    this.#fetch = fetchImpl;
    this.#now = now;
    if (privateKeyPem) {
      this.#private = createPrivateKey(privateKeyPem);
      if (this.#private.asymmetricKeyType !== 'ed25519') throw new Error('ED25519_PRIVATE_KEY_REQUIRED');
    }
  }

  arm(confirmation) {
    if (confirmation !== LIVE_CONFIRMATION) throw new Error('REAL_TRADING_CONFIRMATION_REQUIRED');
    if (this.#blocked) throw new Error('SERVICE_ACCESS_BLOCKED');
    this.#armed = true;
  }
  disarm() { this.#armed = false; }

  async syncTime() {
    const before = this.#now();
    const result = await this.request('GET', '/api/v3/time');
    const after = this.#now();
    if (!Number.isSafeInteger(result.serverTime) || result.serverTime <= 0 || after < before || after - before > 5000) throw new Error('UNRELIABLE_EXCHANGE_CLOCK');
    this.#offset = result.serverTime - after - 250;
    this.#syncedAt = after;
    return result.serverTime;
  }

  async request(method, path, parameters = {}) {
    const allowed = routes.get(`${method} ${path}`);
    if (!allowed || !parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).some(k => !allowed.includes(k))) throw new Error('ROUTE_OR_PARAMETER_NOT_ALLOWED');
    if (this.#blocked) throw new Error('SERVICE_ACCESS_BLOCKED');
    if (allowed.includes('symbol') && !(path === '/api/v3/exchangeInfo' && parameters.symbol === undefined)) liveSymbol(parameters.symbol);
    if (path === '/api/v3/klines' && (parameters.interval !== '1m' || !Number.isInteger(parameters.limit) || parameters.limit < 1 || parameters.limit > 120)) throw new Error('INVALID_CANDLE_REQUEST');
    if (path === '/api/v3/myTrades' && (!Number.isSafeInteger(parameters.orderId) || parameters.orderId <= 0 || parameters.limit !== 1000)) throw new Error('BOUNDED_ORDER_FILLS_REQUIRED');
    if (path === '/api/v3/order' && method !== 'POST' && !ownOrderId(parameters.origClientOrderId)) throw new Error('BOT_OWNED_ORDER_REQUIRED');
    if (method === 'POST' && (!this.#armed || !ownOrderId(parameters.newClientOrderId) || !['BUY', 'SELL'].includes(parameters.side) || parameters.type !== 'LIMIT' || parameters.timeInForce !== 'IOC' || parameters.newOrderRespType !== 'FULL' || !positiveDecimal(parameters.quantity) || !positiveDecimal(parameters.price))) throw new Error('ARMED_LIMIT_IOC_ORDER_REQUIRED');

    const query = new URLSearchParams(Object.entries(parameters).map(([k, v]) => [k, String(v)]));
    const headers = { Accept: 'application/json' };
    if (signedPaths.has(path)) {
      const now = this.#now();
      if (!this.#key || (!this.#secret && !this.#private)) throw new Error('PRODUCTION_CREDENTIALS_REQUIRED');
      if (this.#offset === undefined || now < this.#syncedAt || now - this.#syncedAt > 60000) throw new Error('FRESH_CLOCK_SYNC_REQUIRED');
      query.set('recvWindow', '5000');
      query.set('timestamp', String(Math.floor(now + this.#offset)));
      const payload = query.toString();
      query.set('signature', this.#private ? sign(null, Buffer.from(payload), this.#private).toString('base64') : createHmac('sha256', this.#secret).update(payload).digest('hex'));
      headers['X-MBX-APIKEY'] = this.#key;
    }
    const url = new URL(path, MAINNET_ORIGIN);
    const options = { method, headers, redirect: 'error', signal: AbortSignal.timeout(12000) };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = query.toString();
    } else url.search = query.toString();
    let response;
    try { response = await this.#fetch(url, options); }
    catch { throw new Error(method === 'POST' ? 'ORDER_RESULT_UNKNOWN_RECONCILE' : 'EXCHANGE_CONNECTION_FAILED'); }
    if ([403, 418, 429, 451].includes(response.status)) {
      this.#blocked = true;
      this.disarm();
      await response.body?.cancel().catch(() => {});
      throw new Error('SERVICE_REFUSED_OR_RATE_LIMITED');
    }
    let result;
    try { result = await limitedJson(response); }
    catch { throw new Error(method === 'POST' ? 'ORDER_RESULT_UNKNOWN_RECONCILE' : 'INVALID_EXCHANGE_RESPONSE'); }
    if (!response.ok || (typeof result?.code === 'number' && result.code < 0)) {
      const error = new Error(method === 'POST' ? 'ORDER_REJECTED_OR_UNKNOWN_RECONCILE' : 'BINANCE_REQUEST_REJECTED');
      error.binanceCode = Number.isInteger(result?.code) ? result.code : null;
      error.httpStatus = response.status;
      error.definitiveRejection = method === 'POST' && response.status === 400 &&
        ([-1013, -1021, -2010, -2015].includes(error.binanceCode) || (error.binanceCode <= -1100 && error.binanceCode >= -1136));
      throw error;
    }
    if (!result || typeof result !== 'object') throw new Error('INVALID_EXCHANGE_RESPONSE');
    return result;
  }
}
