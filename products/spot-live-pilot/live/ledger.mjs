import { units, decimal, multiply, multiplyUp } from './decimal.mjs';
import { ownOrderId, liveSymbol } from './client.mjs';

const terminal = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED']);
const validTime = value => Number.isSafeInteger(value) && value > 0;
export function accountIdentity(account) {
  const uid = account?.uid;
  if (!((Number.isSafeInteger(uid) && uid > 0) || (typeof uid === 'string' && /^[1-9]\d{0,20}$/.test(uid)))) throw new Error('ACCOUNT_UID_REQUIRED');
  if (account.accountType !== 'SPOT' || account.canTrade !== true || !Array.isArray(account.balances)) throw new Error('ACCOUNT_SPOT_TRADING_UNAVAILABLE');
  return String(uid);
}

export function balance(account, asset) {
  const rows = account?.balances?.filter(row => row.asset === asset);
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('INVALID_ACCOUNT_BALANCES');
  const row = rows[0] ?? { free: '0', locked: '0' };
  units(row.free); units(row.locked);
  return row.free;
}

export function newLedger(uid, capital, now) {
  units(capital);
  if (!validTime(now) || units(capital) <= 0n) throw new Error('INVALID_INITIAL_CAPITAL');
  return { version: 1, environment: 'BINANCE_SPOT_MAINNET', uid, capital, cash: capital, positions: {}, fills: [], orders: [], pending: null, createdAt: now, day: null, buyBlocked: null, dailyRisk: null };
}

export function validateLedger(value) {
  if (!value || value.version !== 1 || value.environment !== 'BINANCE_SPOT_MAINNET' || !/^[1-9]\d{0,20}$/.test(value.uid) || !validTime(value.createdAt) || !Array.isArray(value.fills) || !Array.isArray(value.orders) || value.fills.length > 100000 || value.orders.length > 10000 || !value.positions || typeof value.positions !== 'object') throw new Error('INVALID_MAINNET_LEDGER');
  units(value.capital); units(value.cash);
  for (const [symbol, position] of Object.entries(value.positions)) {
    liveSymbol(symbol);
    if (position.symbol !== symbol || !validTime(position.openedAt) || !Number.isInteger(position.batches) || position.batches < 1 || position.batches > 3) throw new Error('INVALID_OWNED_POSITION');
    units(position.quantity); units(position.cost); units(position.peakBid); units(position.lastEntryPrice);
  }
  if (value.pending && (!ownOrderId(value.pending.id) || !validTime(value.pending.createdAt) || value.pending.uid !== value.uid)) throw new Error('INVALID_PENDING_ORDER');
  if (value.day && (!/^\d{4}-\d{2}-\d{2}$/.test(value.day.date) || units(value.day.equity) <= 0n)) throw new Error('INVALID_DAILY_EQUITY');
  return value;
}

export function validateFinalOrder(order, pending) {
  if (!terminal.has(order?.status) || order.symbol !== pending.plan.symbol || order.clientOrderId !== pending.id || order.side !== pending.plan.side || order.type !== 'LIMIT' || order.timeInForce !== 'IOC' || !Number.isSafeInteger(order.orderId) || order.orderId <= 0 || units(order.origQty) !== units(pending.plan.quantity) || units(order.price) !== units(pending.plan.price)) throw new Error('ORDER_NOT_FINAL_OR_IDENTITY_MISMATCH');
  const executed = units(order.executedQty), quote = units(order.cummulativeQuoteQty);
  if (executed > units(pending.plan.quantity) || (executed === 0n) !== (quote === 0n)) throw new Error('INVALID_EXECUTION_TOTALS');
  return { executed, quote };
}

export function applyFinalOrder(current, order, trades, feePrices = {}) {
  validateLedger(current);
  const pending = current.pending;
  if (!pending) throw new Error('PENDING_INTENT_REQUIRED');
  if (current.orders.some(previous => previous.id === pending.id || previous.orderId === order.orderId)) throw new Error('ORDER_ALREADY_RECONCILED');
  const { executed, quote } = validateFinalOrder(order, pending);
  if (!Array.isArray(trades) || trades.length >= 1000) throw new Error('INCOMPLETE_ORDER_FILLS');
  const state = structuredClone(current);
  const symbol = pending.plan.symbol, base = symbol.slice(0, -4), buy = pending.plan.side === 'BUY';
  const ids = new Set();
  let qty = 0n, totalQuote = 0n, baseFee = 0n, cashFee = 0n;
  const events = [];
  for (const trade of trades) {
    if (trade.symbol !== symbol || trade.orderId !== order.orderId || !Number.isSafeInteger(trade.id) || trade.id < 0 || ids.has(trade.id) || trade.isBuyer !== buy || !/^[A-Z0-9]{1,30}$/.test(trade.commissionAsset) || !validTime(trade.time) || trade.time < pending.createdAt - 10000) throw new Error('FILL_IDENTITY_MISMATCH');
    ids.add(trade.id);
    const amount = units(trade.qty), cost = units(trade.quoteQty), fee = units(trade.commission);
    const quoteRounding = units('0.00000001');
    if (amount <= 0n || cost <= 0n || (buy && cost > multiplyUp(amount, units(pending.plan.price)) + quoteRounding) || (!buy && cost + quoteRounding < multiply(amount, units(pending.plan.price)))) throw new Error('FILL_OUTSIDE_LIMIT_PRICE');
    qty += amount; totalQuote += cost;
    let baseCharge = 0n, cashCharge = 0n;
    if (trade.commissionAsset === base) baseCharge = fee;
    else if (trade.commissionAsset === 'USDT') cashCharge = fee;
    else if (fee > 0n) {
      const valuation = feePrices[trade.commissionAsset];
      if (!valuation) throw new Error('FEE_VALUE_UNKNOWN_RECONCILE');
      cashCharge = multiplyUp(fee, units(valuation));
    }
    baseFee += baseCharge; cashFee += cashCharge;
    events.push({ symbol, time: trade.time, orderId: order.orderId, tradeId: trade.id, side: pending.plan.side, quantity: decimal(amount), quote: decimal(cost), baseFee: decimal(baseCharge), cashFee: decimal(cashCharge), commission: trade.commission, commissionAsset: trade.commissionAsset });
  }
  if (qty !== executed || totalQuote !== quote) throw new Error('ORDER_FILL_TOTALS_NOT_RECONCILED');
  if (executed > 0n) {
    const old = state.positions[symbol];
    if (buy) {
      const netQty = qty - baseFee, debit = totalQuote + cashFee;
      if (netQty <= 0n || debit > units(state.cash)) throw new Error('LEDGER_BUDGET_OR_FEE_BREACH');
      state.cash = decimal(units(state.cash) - debit);
      const active = old && !old.dust ? old : null;
      state.positions[symbol] = {
        symbol, quantity: decimal(units(old?.quantity ?? '0') + netQty), cost: decimal(units(old?.cost ?? '0') + debit),
        openedAt: active?.openedAt ?? Math.min(...events.map(event => event.time)), batches: (active?.batches ?? 0) + 1,
        lastEntryPrice: decimal(totalQuote * 1000000000000n / qty), peakBid: active?.peakBid ?? pending.plan.price,
        riskSnapshot: active?.riskSnapshot ?? pending.riskSnapshot, dust: false,
      };
    } else {
      const removed = qty + baseFee;
      if (!old || removed > units(old.quantity) || cashFee > totalQuote) throw new Error('CANNOT_SELL_UNOWNED_INVENTORY');
      const remaining = units(old.quantity) - removed;
      state.cash = decimal(units(state.cash) + totalQuote - cashFee);
      const allocatedCost = units(old.cost) * removed / units(old.quantity);
      const realized = Number(decimal(totalQuote - cashFee - allocatedCost));
      const settledAt = Math.max(...events.map(event => event.time));
      const dayUtc = new Date(settledAt).toISOString().slice(0, 10);
      const risk = state.dailyRisk ?? { dayUtc, realizedUsdt: 0, consecutiveLosses: 0, lastLossAt: 0 };
      state.dailyRisk = { dayUtc, realizedUsdt: (risk.dayUtc === dayUtc ? risk.realizedUsdt : 0) + realized,
        consecutiveLosses: realized < 0 ? risk.consecutiveLosses + 1 : 0,
        lastLossAt: realized < 0 ? settledAt : risk.lastLossAt };
      if (remaining === 0n) delete state.positions[symbol];
      else state.positions[symbol] = { ...old, quantity: decimal(remaining), cost: decimal(units(old.cost) * remaining / units(old.quantity)) };
    }
  }
  state.fills.push(...events);
  state.orders.push({ id: pending.id, orderId: order.orderId, symbol, side: pending.plan.side, status: order.status, quantity: order.executedQty, quote: order.cummulativeQuoteQty, time: events.length ? Math.max(...events.map(event => event.time)) : pending.createdAt });
  state.pending = null;
  return validateLedger(state);
}

export function markedEquity(state, bids, sellFees) {
  let equity = units(state.cash);
  for (const [symbol, position] of Object.entries(state.positions)) {
    const value = multiply(units(position.quantity), units(bids[symbol]));
    equity += value - multiplyUp(value, units(sellFees[symbol]));
  }
  return decimal(equity);
}
