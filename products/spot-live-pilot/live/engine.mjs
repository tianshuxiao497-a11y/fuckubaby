import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { atomicWriteJson } from '../../../lib/atomic-json.mjs';
import { liveAdaptiveSignal, updateAdaptiveSamples } from '../../../lib/adaptive-strategy.mjs';
import { parseExternalStrategy } from '../../../lib/external-testnet-strategy.mjs';
import { MainnetSpotClient, LIVE_CONFIRMATION, liveSymbol } from './client.mjs';
import { marketRules, commissionRates, quoteBook, makeOrderPlan } from './risk.mjs';
import { accountIdentity, balance, newLedger, validateLedger, validateFinalOrder, applyFinalOrder, markedEquity } from './ledger.mjs';
import { units, decimal, multiply, floorStep } from './decimal.mjs';

export const LIVE_VERSION = '0.1.0-personal';
export function validateSettings(value) {
  if (!value || Object.keys(value).some(key => !['symbol', 'sizing', 'buyPercent', 'dailyLossPercent', 'riskBasis', 'externalStrategy'].includes(key))) throw new Error('INVALID_LIVE_SETTINGS');
  liveSymbol(value.symbol);
  if (!['thirds', 'percent'].includes(value.sizing) || typeof value.buyPercent !== 'number' || !Number.isFinite(value.buyPercent) || value.buyPercent < 0.01 || value.buyPercent > 100 || value.dailyLossPercent !== 20 || value.riskBasis !== 'bot-ledger') throw new Error('EXPLICIT_SIZING_AND_RISK_BASIS_REQUIRED');
  units(String(value.buyPercent));
  const strategy = value.externalStrategy ? parseExternalStrategy(JSON.stringify(value.externalStrategy)) : null;
  return { symbol: value.symbol, sizing: value.sizing, buyPercent: value.buyPercent, dailyLossPercent: 20, riskBasis: 'bot-ledger', externalStrategy: strategy };
}

function normalizedCandles(rows, now) {
  if (!Array.isArray(rows)) throw new Error('INVALID_LIVE_CANDLES');
  return rows.filter(row => Array.isArray(row) && Number.isSafeInteger(row[6]) && row[6] < now).map(row => ({
    time: row[0], closeTime: row[6], open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
  }));
}

export class LiveEngine {
  constructor({ profile, client, settings, now = Date.now, guard = () => true }) {
    this.profile = resolve(profile);
    this.file = resolve(this.profile, 'mainnet-ledger.json');
    this.client = client ?? new MainnetSpotClient();
    this.settings = validateSettings(settings);
    this.now = now;
    this.guard = guard;
    this.running = false;
    this.state = null;
    this.samples = [];
    this.last = null;
    this.error = null;
    this.busy = false;
  }

  async acquire() {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    this.lockPath = resolve(this.profile, 'mainnet.lock');
    const identity = process.platform === 'win32' ? this.profile.toLowerCase() : this.profile;
    const lockPort = 42000 + createHash('sha256').update(identity).digest().readUInt32BE(0) % 17000;
    const lease = createServer(socket => socket.destroy());
    try {
      await new Promise((resolveListen, reject) => {
        lease.once('error', reject);
        lease.listen({ port: lockPort, host: '127.0.0.1', exclusive: true }, resolveListen);
      });
      this.profileLease = lease;
      lease.unref();
      try {
        const owner = (await readFile(this.lockPath, 'utf8')).trim();
        if (!/^[1-9]\d{0,9}$/.test(owner)) throw new Error('INVALID_PROFILE_OWNER');
        try {
          process.kill(Number(owner), 0);
          throw new Error('PROFILE_OWNER_STILL_RUNNING');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        // The process-exclusive socket serializes recovery with all runners.
        // A dead owner's marker can be removed only while holding that lease.
        await unlink(this.lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      this.lock = await open(this.lockPath, 'wx', 0o600);
      await this.lock.writeFile(String(process.pid));
      await this.lock.sync();
    } catch {
      if (this.lock) await this.lock.close().catch(() => {});
      this.lock = null;
      if (this.profileLease) await new Promise(resolveClose => this.profileLease.close(resolveClose));
      this.profileLease = null;
      throw new Error('LIVE_PROFILE_LOCKED_REVIEW_EXISTING_PROCESS');
    }
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 67108864) throw new Error('INVALID_LEDGER_FILE');
      this.state = validateLedger(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.close();
        throw new Error('MAINNET_LEDGER_INVALID_PRESERVED');
      }
    }
  }

  async commit(next) {
    validateLedger(next);
    await atomicWriteJson(this.file, next);
    this.state = next;
  }

  stop() {
    this.running = false;
    this.client.disarm();
  }

  async close() {
    this.stop();
    try {
      if (this.lock) {
        await this.lock.close();
        this.lock = null;
        if ((await readFile(this.lockPath, 'utf8')).trim() === String(process.pid)) await unlink(this.lockPath);
      }
    } finally {
      if (this.profileLease) await new Promise(resolveClose => this.profileLease.close(resolveClose));
      this.profileLease = null;
    }
  }

  async start(confirmation) {
    if (confirmation !== LIVE_CONFIRMATION) throw new Error('REAL_TRADING_CONFIRMATION_REQUIRED');
    if (!this.last?.accountChecked || this.now() < this.last.checkedAt || this.now() - this.last.checkedAt > 30000 || this.error || this.state?.pending) throw new Error('FRESH_READ_ONLY_CHECK_REQUIRED');
    this.client.arm(confirmation);
    this.running = true;
  }

  async catalog() {
    const info = await this.client.request('GET', '/api/v3/exchangeInfo');
    if (!Array.isArray(info?.symbols) || info.symbols.length > 10000) throw new Error('INVALID_MAINNET_CATALOG');
    return info.symbols.filter(item => {
      try { marketRules({ symbols: [item] }, item.symbol); return true; }
      catch { return false; }
    }).map(item => item.symbol).sort();
  }

  async reconcile({ cancelOpen = false } = {}) {
    if (!this.state?.pending) return;
    const pending = this.state.pending;
    await this.client.syncTime();
    const account = await this.client.request('GET', '/api/v3/account');
    if (accountIdentity(account) !== this.state.uid) throw new Error('MAINNET_ACCOUNT_CHANGED');
    let order;
    try {
      order = await this.client.request('GET', '/api/v3/order', { symbol: pending.plan.symbol, origClientOrderId: pending.id });
    } catch (error) {
      if (error.binanceCode === -2013 && Number.isInteger(pending.definitiveRejection)) {
        await this.commit({ ...this.state, pending: null });
        return;
      }
      throw error;
    }
    if (cancelOpen && ['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL'].includes(order?.status)) {
      await this.client.request('DELETE', '/api/v3/order', { symbol: pending.plan.symbol, origClientOrderId: pending.id });
      order = await this.client.request('GET', '/api/v3/order', { symbol: pending.plan.symbol, origClientOrderId: pending.id });
    }
    const { executed } = validateFinalOrder(order, pending);
    const trades = executed === 0n ? [] : await this.client.request('GET', '/api/v3/myTrades', { symbol: pending.plan.symbol, orderId: order.orderId, limit: 1000 });
    if (!Array.isArray(trades)) throw new Error('INVALID_ORDER_FILLS');
    const feePrices = {};
    const base = pending.plan.symbol.slice(0, -4);
    for (const asset of new Set(trades.filter(trade => units(trade.commission) > 0n && !['USDT', base].includes(trade.commissionAsset)).map(trade => trade.commissionAsset))) {
      const ticker = await this.client.request('GET', '/api/v3/ticker/price', { symbol: liveSymbol(asset + 'USDT') });
      if (ticker.symbol !== asset + 'USDT' || units(ticker.price) <= 0n) throw new Error('FEE_VALUE_UNKNOWN_RECONCILE');
      // A conservative 1% valuation allowance for fees paid in another asset.
      feePrices[asset] = decimal(multiply(units(ticker.price), units('1.01')));
    }
    await this.commit(applyFinalOrder(this.state, order, trades, feePrices));
  }

  async openingEquity(now) {
    const offset = 8 * 60 * 60 * 1000;
    const date = new Date(now + offset).toISOString().slice(0, 10);
    if (this.state.day?.date === date) return this.state.day;
    if (this.state.day?.date > date) throw new Error('CLOCK_MOVED_TO_EARLIER_RISK_DAY');
    const midnight = Date.parse(date + 'T00:00:00.000Z') - offset;
    if (this.state.createdAt >= midnight) return { date, equity: this.state.capital, source: 'PROGRAM_START_USDT' };
    // Rebuild cash and bot-owned quantities immediately before UTC midnight.
    let cash = units(this.state.capital);
    const inventory = {};
    for (const fill of this.state.fills.filter(fill => fill.time < midnight)) {
      const sign = fill.side === 'BUY' ? 1n : -1n;
      cash -= sign * units(fill.quote) + units(fill.cashFee);
      inventory[fill.symbol] = (inventory[fill.symbol] ?? 0n) + sign * units(fill.quantity) - units(fill.baseFee);
    }
    let equity = cash;
    for (const [symbol, quantity] of Object.entries(inventory)) {
      if (quantity < 0n) throw new Error('INVALID_HISTORICAL_INVENTORY');
      if (quantity === 0n) continue;
      const rows = await this.client.request('GET', '/api/v3/klines', { symbol, interval: '1m', startTime: midnight, limit: 1 });
      if (!Array.isArray(rows) || rows[0]?.[0] !== midnight || units(rows[0][1]) <= 0n) throw new Error('DAILY_OPEN_PRICE_UNAVAILABLE');
      equity += multiply(quantity, units(rows[0][1]));
    }
    if (equity <= 0n) throw new Error('INVALID_DAILY_OPENING_EQUITY');
    return { date, equity: decimal(equity), source: 'BOT_LEDGER_UTC_PLUS_8_OPEN_CANDLE' };
  }

  async check({ execute = false } = {}) {
    if (this.busy) throw new Error('CHECK_ALREADY_IN_PROGRESS');
    if (!this.lock) throw new Error('MAINNET_PROFILE_LOCK_REQUIRED');
    this.busy = true;
    try {
      const symbol = this.settings.symbol;
      const serverTime = await this.client.syncTime();
      if (Math.abs(serverTime - this.now()) > 30000) throw new Error('LOCAL_CLOCK_DIFFERS_FROM_EXCHANGE');
      let account = await this.client.request('GET', '/api/v3/account');
      const uid = accountIdentity(account);
      if (this.state && this.state.uid !== uid) throw new Error('MAINNET_ACCOUNT_CHANGED');
      if (!this.state) await this.commit(newLedger(uid, balance(account, 'USDT'), this.now()));
      if (this.state.pending) {
        await this.reconcile();
        account = await this.client.request('GET', '/api/v3/account');
        if (accountIdentity(account) !== uid) throw new Error('MAINNET_ACCOUNT_CHANGED');
      }
      if (Object.entries(this.state.positions).some(([key, held]) => key !== symbol && !held.dust)) throw new Error('ANOTHER_SYMBOL_HAS_OWNED_INVENTORY');
      const orders = await this.client.request('GET', '/api/v3/openOrders', { symbol });
      if (!Array.isArray(orders) || orders.length) throw new Error('OPEN_ORDERS_REQUIRE_REVIEW');
      const marketStarted = this.now();
      const [info, book, rawFees, rows] = await Promise.all([
        this.client.request('GET', '/api/v3/exchangeInfo', { symbol }),
        this.client.request('GET', '/api/v3/ticker/bookTicker', { symbol }),
        this.client.request('GET', '/api/v3/account/commission', { symbol }),
        this.client.request('GET', '/api/v3/klines', { symbol, interval: '1m', limit: 100 }),
      ]);
      const now = this.now();
      if (now < marketStarted || now - marketStarted > 5000) throw new Error('MARKET_SNAPSHOT_TOO_SLOW');
      const rules = marketRules(info, symbol), fees = commissionRates(rawFees, symbol);
      quoteBook(book, symbol);
      const bids = { [symbol]: book.bidPrice }, sellFees = { [symbol]: fees.sell };
      for (const [heldSymbol, held] of Object.entries(this.state.positions)) {
        if (units(balance(account, heldSymbol.slice(0, -4))) < units(held.quantity)) throw new Error('OWNED_INVENTORY_DIFFERS_FROM_ACCOUNT');
        if (heldSymbol === symbol) continue;
        const heldBook = await this.client.request('GET', '/api/v3/ticker/bookTicker', { symbol: heldSymbol });
        quoteBook(heldBook, heldSymbol);
        const heldFees = commissionRates(await this.client.request('GET', '/api/v3/account/commission', { symbol: heldSymbol }), heldSymbol);
        bids[heldSymbol] = heldBook.bidPrice; sellFees[heldSymbol] = heldFees.sell;
      }
      if (units(balance(account, 'USDT')) < units(this.state.cash)) throw new Error('ACCOUNT_QUOTE_BELOW_PROGRAM_LEDGER');
      const equity = markedEquity(this.state, bids, sellFees);
      const day = await this.openingEquity(now);
      const lossPercent = (1 - Number(equity) / Number(day.equity)) * 100;
      const next = structuredClone(this.state);
      next.day = day;
      if (units(equity) * 100n <= units(day.equity) * 80n) next.buyBlocked = `DAILY_LOSS_20_PERCENT_${day.date}`;
      else if (next.buyBlocked?.startsWith('DAILY_LOSS_20_PERCENT_') && !next.buyBlocked.endsWith(day.date)) next.buyBlocked = null;
      const holding = next.positions[symbol];
      if (holding) {
        holding.peakBid = decimal(units(holding.peakBid) > units(book.bidPrice) ? units(holding.peakBid) : units(book.bidPrice));
        const sellable = floorStep(units(holding.quantity), rules.step);
        holding.dust = sellable < rules.minQty || multiply(sellable, units(book.bidPrice)) < rules.minNotional;
      }
      await this.commit(next);
      const maxBudget = Number(this.state.capital);
      const position = holding?.dust ? null : holding;
      const researchState = {
        orders: this.state.orders, adaptiveSamples: this.samples, pending: this.state.pending, dailyRisk: this.state.dailyRisk,
        position: position ? { quantity: Number(position.quantity), entryPrice: Number(position.cost) / Number(position.quantity), deployedUsdt: Number(position.cost), openedAt: position.openedAt, batches: position.batches, lastEntryPrice: Number(position.lastEntryPrice), peakBid: Number(next.positions[symbol].peakBid), riskSnapshot: position.riskSnapshot, adopted: false } : null,
      };
      const signal = liveAdaptiveSignal(normalizedCandles(rows, now), { symbol, tradeUsdt: maxBudget, externalStrategy: this.settings.externalStrategy, liveFeeRates: { buyFeePercent: Number(fees.buy) * 100, sellFeePercent: Number(fees.sell) * 100 } }, researchState, book, now);
      this.samples = updateAdaptiveSamples(this.samples, book, now);
      let plan = null, blocker = null;
      if (signal.side === 'BUY' && this.state.buyBlocked) blocker = this.state.buyBlocked;
      if (signal.side && !blocker) {
        const percent = units(String(this.settings.buyPercent));
        const requested = this.settings.sizing === 'thirds' ? decimal(units(this.state.capital) / 3n) : decimal(multiply(units(this.state.cash), percent) / 100n);
        try {
          plan = makeOrderPlan({ symbol, side: signal.side, requestedUsdt: requested, ownedQuantity: position?.quantity ?? '0', cash: this.state.cash, freeQuote: balance(account, 'USDT'), freeBase: balance(account, rules.baseAsset), rules, book, fees });
        } catch (error) { blocker = error.message; }
      }
      this.last = { checkedAt: now, environment: 'BINANCE_SPOT_MAINNET', accountChecked: true, symbol, equity, capital: this.state.capital, cash: this.state.cash, day, lossPercent, buyBlocked: this.state.buyBlocked, position: this.state.positions[symbol] ?? null, signal, plan, blocker, feeRates: fees, minOrderUsdt: decimal(rules.minNotional), realOrderCount: this.state.orders.length, pending: this.state.pending, orders: this.state.orders.slice(-50), fills: this.state.fills.slice(-100), running: this.running, version: LIVE_VERSION };
      this.error = null;
      if (execute && this.running && plan && this.guard()) await this.execute(plan, signal.riskSnapshot);
      return this.last;
    } catch (error) {
      this.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LIVE_CHECK_FAILED';
      this.stop();
      throw error;
    } finally { this.busy = false; }
  }

  async execute(plan, riskSnapshot) {
    if (!this.running || !this.guard() || this.state.pending || this.now() < this.last.checkedAt || this.now() - this.last.checkedAt > 3000) throw new Error('LIVE_EXECUTION_GUARD_BLOCKED');
    if (JSON.stringify(plan) !== JSON.stringify(this.last.plan) || (plan.side === 'BUY' && this.state.buyBlocked)) throw new Error('REVIEWED_PLAN_REQUIRED');
    if (this.state.orders.length >= 10000) throw new Error('HISTORY_LIMIT_REQUIRES_ARCHIVE');
    const id = 'asbl_' + randomBytes(14).toString('hex');
    const orderParameters = { ...plan, newClientOrderId: id };
    delete orderParameters.estimatedNotional;
    await this.commit({ ...this.state, pending: { id, uid: this.state.uid, createdAt: this.now(), plan, riskSnapshot } });
    // Stop requests can arrive during disk writes. Check again immediately
    // before the only operation that can create a matching-engine order.
    if (!this.running || !this.guard() || this.now() < this.last.checkedAt || this.now() - this.last.checkedAt > 3000) {
      await this.commit({ ...this.state, pending: null });
      return;
    }
    try {
      await this.client.request('POST', '/api/v3/order', orderParameters);
      await this.reconcile();
    } catch (error) {
      this.stop();
      if (error.definitiveRejection && this.state.pending?.id === id) {
        await this.commit({ ...this.state, pending: { ...this.state.pending, definitiveRejection: error.binanceCode } });
      }
      throw error;
    }
  }
}
