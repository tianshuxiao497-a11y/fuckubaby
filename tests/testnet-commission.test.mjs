import test from 'node:test';
import assert from 'node:assert/strict';
import { commissionContext, selectCommissionFees } from '../lib/testnet-commission.mjs';

// Synthetic fixtures only: no network, environment, account, persistence or orders.
const now = 1_800_000_000_000;
const symbol = 'BTCUSDT';
const groups = ['standardCommission', 'taxCommission', 'specialCommission'];
const components = ['maker', 'taker', 'buyer', 'seller'];
const zero = () => ({
  symbol,
  ...Object.fromEntries(groups.map(group => [group, Object.fromEntries(components.map(key => [key, '0.00000000']))]))
});
const fallback = {
  buyFeePercent: 0.1, sellFeePercent: 0.1, verified: false,
  source: 'CONSERVATIVE_FALLBACK', checkedAt: null, expiresAt: null
};

test('explicitly verified zero commission is usable for at most five minutes', () => {
  const context = commissionContext(zero(), symbol, now);
  assert.equal(context.source, 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION');
  assert.equal(context.symbol, symbol);
  assert.equal(context.checkedAt, now);
  assert.equal(context.buyFeePercent, 0);
  assert.equal(context.sellFeePercent, 0);
  for (const at of [now, now + 299999, now + 300000]) {
    assert.deepEqual(selectCommissionFees(context, symbol, at), {
      buyFeePercent: 0, sellFeePercent: 0, verified: true,
      source: context.source, checkedAt: now, expiresAt: now + 300000
    });
  }
  assert.deepEqual(selectCommissionFees(context, symbol, now + 300001), fallback);
  assert.deepEqual(selectCommissionFees(context, symbol, now - 1), fallback);
});

test('market fee includes standard, tax and special taker plus respective buyer/seller rates', () => {
  const raw = zero();
  raw.standardCommission = { maker: '0.9', taker: '0.001', buyer: '0.0001', seller: '0.0002' };
  raw.taxCommission = { maker: 0.8, taker: 0.00003, buyer: 0.00004, seller: 0.00005 };
  raw.specialCommission = { maker: '0.7', taker: 0.000006, buyer: 0.000007, seller: 0.000008 };
  raw.discount = { enabledForAccount: true, enabledForSymbol: true, discountAsset: 'BNB', discount: '1' };
  const context = commissionContext(raw, symbol, now);
  assert.ok(Math.abs(context.buyFeePercent - 0.1183) < 1e-12);
  assert.ok(Math.abs(context.sellFeePercent - 0.1294) < 1e-12);
  assert.equal(context.rates.standardCommission.taker, 0.001);
  assert.equal(selectCommissionFees(context, symbol, now).verified, true);
  const withoutDiscount = structuredClone(raw);
  delete withoutDiscount.discount;
  assert.deepEqual(commissionContext(withoutDiscount, symbol, now), context);
});

test('all twelve rate components are required and validated, including unused maker components', () => {
  for (const group of groups) {
    const missingGroup = zero();
    delete missingGroup[group];
    assert.throws(() => commissionContext(missingGroup, symbol, now));
    for (const component of components) {
      const missing = zero();
      delete missing[group][component];
      assert.throws(() => commissionContext(missing, symbol, now));
      for (const bad of ['', ' ', ' 0.1', '0.1 ', '.1', '1.', '00.1', '1e-3', '0x0', '-0', '-0.1',
        'Infinity', 'NaN', '1.000001', true, false, null, undefined, NaN, Infinity, -Infinity, -0.1, 1.1, [], {}]) {
        const raw = zero();
        raw[group][component] = bad;
        assert.throws(() => commissionContext(raw, symbol, now), `${group}.${component}: ${String(bad)}`);
      }
    }
  }
});

test('finite numeric and canonical decimal rates include both boundaries', () => {
  const raw = zero();
  raw.standardCommission = { maker: 1, taker: '1.00000000', buyer: 0, seller: -0 };
  const context = commissionContext(raw, symbol, now);
  assert.equal(context.buyFeePercent, 100);
  assert.equal(context.sellFeePercent, 100);
  assert.equal(Object.is(context.rates.standardCommission.seller, -0), false);
});

test('missing, malformed or mismatched symbol evidence never authorizes zero fees', () => {
  for (const value of [null, undefined, [], {}, true, 0, 'BTCUSDT']) {
    assert.throws(() => commissionContext(value, symbol, now));
    assert.deepEqual(selectCommissionFees(value, symbol, now), fallback);
  }
  for (const badSymbol of ['', 'btcusdt', 'BTC/USDT', ' BTCUSDT', null, true, 123, 'A'.repeat(31)]) {
    assert.throws(() => commissionContext(zero(), badSymbol, now));
    assert.deepEqual(selectCommissionFees(commissionContext(zero(), symbol, now), badSymbol, now), fallback);
  }
  const raw = zero(); raw.symbol = 'ETHUSDT';
  assert.throws(() => commissionContext(raw, symbol, now));
  assert.deepEqual(selectCommissionFees(commissionContext(zero(), symbol, now), 'ETHUSDT', now), fallback);
});

test('unsafe, missing, nonnumeric and nonpositive timestamps are rejected conservatively', () => {
  const context = commissionContext(zero(), symbol, now);
  for (const bad of [undefined, null, true, '', String(now), 0, -1, 0.1, now + 0.5,
    NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => commissionContext(zero(), symbol, bad));
    assert.deepEqual(selectCommissionFees(context, symbol, bad), fallback);
    assert.deepEqual(selectCommissionFees({ ...context, checkedAt: bad }, symbol, now), fallback);
  }
});

test('stored arithmetic, provenance and every rate are revalidated before selection', () => {
  const context = commissionContext(zero(), symbol, now);
  for (const changed of [
    { source: 'BINANCE_MAINNET_ACCOUNT_COMMISSION' }, { source: undefined },
    { buyFeePercent: 0.01 }, { sellFeePercent: 0.01 }, { buyFeePercent: '0' },
    { sellFeePercent: NaN }, { symbol: 'ETHUSDT' }, { rates: null },
    { checkedAt: now + 1 }
  ]) assert.deepEqual(selectCommissionFees({ ...context, ...changed }, symbol, now), fallback);
  for (const group of groups) for (const component of components) {
    const tampered = structuredClone(context);
    delete tampered.rates[group][component];
    assert.deepEqual(selectCommissionFees(tampered, symbol, now), fallback);
  }
  const altered = structuredClone(context);
  altered.rates.standardCommission.taker = 0.001;
  assert.deepEqual(selectCommissionFees(altered, symbol, now), fallback);
});

test('context is a detached deeply frozen clone and selector does not mutate either input', () => {
  const raw = zero();
  const before = structuredClone(raw);
  const context = commissionContext(raw, symbol, now);
  assert.deepEqual(raw, before);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.rates), true);
  for (const group of groups) assert.equal(Object.isFrozen(context.rates[group]), true);
  raw.standardCommission.taker = '0.9';
  assert.equal(context.rates.standardCommission.taker, 0);
  assert.throws(() => { context.rates.standardCommission.taker = 0.9; });
  const copy = structuredClone(context);
  const copiedBefore = structuredClone(copy);
  const result = selectCommissionFees(copy, symbol, now);
  assert.deepEqual(copy, copiedBefore);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(selectCommissionFees(null, symbol, now)), true);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
});
