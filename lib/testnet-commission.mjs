// Pure Testnet commission evidence. No account, network, file or environment access.
const SOURCE = 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION';
const MAX_AGE_MS = 300_000;
const GROUPS = ['standardCommission', 'taxCommission', 'specialCommission'];
const COMPONENTS = ['maker', 'taker', 'buyer', 'seller'];
const FALLBACK = Object.freeze({
  buyFeePercent: 0.1,
  sellFeePercent: 0.1,
  verified: false,
  source: 'CONSERVATIVE_FALLBACK',
  checkedAt: null,
  expiresAt: null
});

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validSymbol(symbol) {
  return typeof symbol === 'string' && /^[A-Z0-9]{2,30}$/.test(symbol);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value + MAX_AGE_MS);
}

function normalizeRate(value) {
  if (typeof value === 'string') {
    // Number() alone would silently accept whitespace, hex, exponents and blanks.
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new TypeError('Invalid commission rate');
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('Invalid commission rate');
  }
  return value === 0 ? 0 : value;
}

function normalizedRates(raw) {
  if (!isRecord(raw)) throw new TypeError('Missing commission rates');
  const rates = {};
  for (const group of GROUPS) {
    if (!Object.hasOwn(raw, group) || !isRecord(raw[group])) throw new TypeError('Missing commission group');
    const normalized = {};
    for (const component of COMPONENTS) {
      if (!Object.hasOwn(raw[group], component)) throw new TypeError('Missing commission component');
      normalized[component] = normalizeRate(raw[group][component]);
    }
    rates[group] = Object.freeze(normalized);
  }
  return Object.freeze(rates);
}

function feePercent(rates, side) {
  // Market orders pay taker plus buyer/seller rates in all three fee groups.
  // BNB discounts are deliberately ignored rather than assumed available.
  return 100 * GROUPS.reduce((total, group) => total + rates[group].taker + rates[group][side], 0);
}

/** Normalize a successfully retrieved, symbol-specific Testnet commission response. */
export function commissionContext(raw, symbol, now) {
  if (!validSymbol(symbol) || !isRecord(raw) || raw.symbol !== symbol) {
    throw new TypeError('Commission symbol mismatch');
  }
  if (!validTimestamp(now)) throw new TypeError('Invalid commission check timestamp');
  const rates = normalizedRates(raw);
  return Object.freeze({
    source: SOURCE,
    symbol,
    checkedAt: now,
    buyFeePercent: feePercent(rates, 'buyer'),
    sellFeePercent: feePercent(rates, 'seller'),
    rates
  });
}

/** Use only fresh, internally consistent evidence; unknown fees never become zero. */
export function selectCommissionFees(context, symbol, now) {
  try {
    if (!isRecord(context) || !validSymbol(symbol) || context.symbol !== symbol ||
        context.source !== SOURCE || !validTimestamp(now) || !validTimestamp(context.checkedAt) ||
        context.checkedAt > now || now - context.checkedAt > MAX_AGE_MS) return FALLBACK;
    const rates = normalizedRates(context.rates);
    const buyFeePercent = feePercent(rates, 'buyer');
    const sellFeePercent = feePercent(rates, 'seller');
    if (typeof context.buyFeePercent !== 'number' || typeof context.sellFeePercent !== 'number' ||
        context.buyFeePercent !== buyFeePercent || context.sellFeePercent !== sellFeePercent) return FALLBACK;
    return Object.freeze({
      buyFeePercent,
      sellFeePercent,
      verified: true,
      source: SOURCE,
      checkedAt: context.checkedAt,
      expiresAt: context.checkedAt + MAX_AGE_MS
    });
  } catch {
    return FALLBACK;
  }
}
