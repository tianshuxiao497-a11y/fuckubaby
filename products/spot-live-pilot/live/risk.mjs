import { SCALE, units, decimal, multiply, multiplyUp, divide, minimum, floorStep, ceilStep } from './decimal.mjs';
import { liveSymbol } from './client.mjs';

export function marketRules(info, symbol) {
  liveSymbol(symbol);
  const item = info?.symbols?.find(row => row.symbol === symbol);
  if (!item || item.status !== 'TRADING' || item.quoteAsset !== 'USDT' || item.baseAsset !== symbol.slice(0, -4) || item.isSpotTradingAllowed !== true || !item.orderTypes?.includes('LIMIT')) throw new Error('SPOT_MARKET_NOT_AVAILABLE');
  const lot = item.filters?.find(row => row.filterType === 'LOT_SIZE');
  const price = item.filters?.find(row => row.filterType === 'PRICE_FILTER');
  const amounts = item.filters?.filter(row => ['MIN_NOTIONAL', 'NOTIONAL'].includes(row.filterType));
  if (!lot || !price || !amounts?.length) throw new Error('MISSING_EXCHANGE_FILTERS');
  const minNotional = amounts.map(row => units(row.minNotional)).reduce((a, b) => a > b ? a : b);
  const maxima = amounts.filter(row => row.maxNotional !== undefined).map(row => units(row.maxNotional)).filter(value => value > 0n);
  const rules = {
    symbol, baseAsset: item.baseAsset, quoteAsset: 'USDT',
    step: units(lot.stepSize), minQty: units(lot.minQty), maxQty: units(lot.maxQty),
    tick: units(price.tickSize), minPrice: units(price.minPrice), maxPrice: units(price.maxPrice),
    minNotional, maxNotional: maxima.length ? minimum(...maxima) : null,
  };
  if (rules.step <= 0n || rules.tick <= 0n || rules.minNotional <= 0n || rules.maxQty < rules.minQty || (rules.maxPrice > 0n && rules.maxPrice < rules.minPrice) || (rules.maxNotional !== null && rules.maxNotional < rules.minNotional)) throw new Error('INVALID_EXCHANGE_FILTERS');
  return rules;
}

export function commissionRates(raw, symbol) {
  if (raw?.symbol !== symbol) throw new Error('COMMISSION_SYMBOL_MISMATCH');
  let buy = 0n;
  let sell = 0n;
  for (const group of ['standardCommission', 'taxCommission', 'specialCommission']) {
    const value = raw[group];
    if (!value) throw new Error('MISSING_COMMISSION_RATES');
    const maker = units(value.maker), taker = units(value.taker);
    const maximumRate = maker > taker ? maker : taker;
    buy += maximumRate + units(value.buyer);
    sell += maximumRate + units(value.seller);
  }
  if (buy > units('0.05') || sell > units('0.05')) throw new Error('COMMISSION_RATE_REQUIRES_REVIEW');
  return { buy: decimal(buy), sell: decimal(sell) };
}

export function quoteBook(book, symbol) {
  if (book?.symbol !== symbol) throw new Error('QUOTE_SYMBOL_MISMATCH');
  const bid = units(book.bidPrice), ask = units(book.askPrice);
  if (bid <= 0n || ask < bid || units(book.bidQty) <= 0n || units(book.askQty) <= 0n) throw new Error('INVALID_LIVE_QUOTE');
  return { bid, ask };
}

export function makeOrderPlan({ symbol, side, requestedUsdt, ownedQuantity = '0', cash, freeQuote, freeBase, rules, book, fees, maxOrderUsdt = null }) {
  if (!['BUY', 'SELL'].includes(side) || rules.symbol !== symbol) throw new Error('INVALID_ORDER_SIDE');
  const quote = quoteBook(book, symbol);
  const slippage = units('0.0005');
  const price = side === 'BUY' ? ceilStep(multiplyUp(quote.ask, SCALE + slippage), rules.tick) : floorStep(multiply(quote.bid, SCALE - slippage), rules.tick);
  if (price <= 0n || (rules.minPrice > 0n && price < rules.minPrice) || (rules.maxPrice > 0n && price > rules.maxPrice)) throw new Error('PRICE_FILTER_BLOCKED');
  const fee = units(side === 'BUY' ? fees.buy : fees.sell);
  let quantity;
  if (side === 'BUY') {
    const budget = minimum(units(requestedUsdt), divide(units(cash), SCALE + fee), divide(units(freeQuote), SCALE + fee));
    const cap = maxOrderUsdt === null ? budget : minimum(budget, units(maxOrderUsdt));
    quantity = floorStep(divide(cap, price), rules.step);
  } else {
    // Reserve base-asset fees as well: selling the full owned amount could
    // otherwise consume an unrelated manual position to pay commission.
    const available = divide(minimum(units(ownedQuantity), units(freeBase)), SCALE + fee);
    quantity = floorStep(maxOrderUsdt === null ? available : minimum(available, divide(units(maxOrderUsdt), price)), rules.step);
  }
  const notional = multiplyUp(quantity, price);
  if (quantity < rules.minQty || quantity > rules.maxQty || notional < rules.minNotional || (rules.maxNotional !== null && notional > rules.maxNotional)) throw new Error('ORDER_AMOUNT_BELOW_MINIMUM_OR_FILTER_BLOCKED');
  if (side === 'BUY') {
    // Entry must leave room for fees, a configured exit decline and rounding.
    const expectedNet = multiply(quantity, SCALE - units(fees.buy));
    const expectedSell = floorStep(divide(expectedNet, SCALE + units(fees.sell)), rules.step);
    const exitPrice = floorStep(multiply(quote.bid, units('0.99')), rules.tick);
    if (multiply(expectedSell, exitPrice) < rules.minNotional) throw new Error('BUDGET_TOO_SMALL_FOR_ROUND_TRIP');
  }
  return { symbol, side, type: 'LIMIT', timeInForce: 'IOC', quantity: decimal(quantity), price: decimal(price), newOrderRespType: 'FULL', estimatedNotional: decimal(notional) };
}
