import assert from 'node:assert/strict';
import test from 'node:test';
import {createFuturesTradeReporter, futuresTradeReport} from './trade-report.mjs';

function fill(key, time, orderId, direction, effect, quantity, price, realizedPnl, commission, overrides = {}) {
  return {
    key, time, orderId, direction, effect, quantity, price, realizedPnl, commission,
    market: 'USD_M', symbol: 'BTCUSDT', marginAsset: 'USDT', commissionAsset: 'USDT',
    contractSize: '1', ...overrides
  };
}

function funding(key, time, amount, symbol = 'BTCUSDT', wallet = 'USD_M.USDT') {
  return {key, time, amount, symbol, wallet};
}

function state(fills, events = [], through = 100) {
  return {fills, orders: [], funding: events, positions: {}, incomeThrough: {USD_M: through, COIN_M: through}};
}

function shortWithPartialCloses() {
  return [
    fill('open', 10, 1, 'SHORT', 'OPEN', '0.003', '62000', '0', '0.093'),
    fill('partial', 20, 2, 'SHORT', 'CLOSE', '0.001', '61900', '0.10', '0.03095'),
    fill('final', 30, 3, 'SHORT', 'CLOSE', '0.002', '61800', '0.40', '0.06180')
  ];
}

test('settlement at entry and exit uses the position immediately before the timestamp and ignores duplicate events', () => {
  const [opened, partial, closed] = shortWithPartialCloses();
  const atEntry = funding('at-entry', 10, '0.10');
  const atExit = funding('at-exit', 30, '0.01');
  const otherContract = funding('manual', 22, '200', 'ETHUSDT');
  const ledger = state([closed, partial, opened, closed], [atEntry, atExit, atExit, otherContract], 30);
  const report = createFuturesTradeReporter();
  const result = report(ledger);
  assert.equal(result.roundTrips.length, 1);
  const [trip] = result.roundTrips;
  assert.equal(trip.gross, '0.5');
  assert.deepEqual(trip.openFees, {USDT: '0.093'});
  assert.deepEqual(trip.closeFees, {USDT: '0.09275'});
  assert.deepEqual(trip.funding, {USDT: '0.01'});
  assert.deepEqual(trip.net, {USDT: '0.32425'});
  assert.equal(result.unattributedFunding.length, 2);
  assert.equal(report(state([opened, partial])).roundTrips.length, 0);

  const beforeSync = {...ledger, incomeThrough: {USD_M: 29}};
  assert.equal(report(beforeSync).roundTrips[0].net, null);
  assert.deepEqual(report(ledger).roundTrips[0].net, {USDT: '0.32425'});
});

test('unreported fees, an actual zero, and a rebate paid in a different asset retain their original meaning', () => {
  const [opened, partial, closed] = shortWithPartialCloses();
  const round = finalFill => futuresTradeReport(state([opened, partial, finalFill])).roundTrips[0];
  const missing = round({...closed, commission: undefined});
  assert.equal(missing.closeFees, null);
  assert.equal(missing.net, null);
  assert.deepEqual(round({...closed, commission: '0'}).net, {USDT: '0.37605'});
  const withRebate = round({...closed, commission: '-0.01', commissionAsset: 'BNB'});
  assert.deepEqual(withRebate.closeFees, {BNB: '-0.01', USDT: '0.03095'});
  assert.deepEqual(withRebate.net, {BNB: '0.01', USDT: '0.37605'});
});

test('inverse contracts keep realized PnL, commissions and funding denominated in the settlement coin', () => {
  const coin = {market: 'COIN_M', symbol: 'BTCUSD_PERP', marginAsset: 'BTC', commissionAsset: 'BTC', contractSize: '100'};
  const opened = fill('inverse-open', 10, 4, 'LONG', 'OPEN', '1', '40000', '0', '0.000010', coin);
  const closed = fill('inverse-close', 30, 5, 'LONG', 'CLOSE', '1', '50000', '0.00050000', '0.000009', coin);
  const paid = funding('inverse-funding', 15, '-0.000004', 'BTCUSD_PERP', 'COIN_M.BTC');
  const [trip] = futuresTradeReport(state([opened, closed], [paid])).roundTrips;
  assert.equal(trip.quantityUnit, 'contracts');
  assert.equal(trip.gross, '0.0005');
  assert.deepEqual(trip.net, {BTC: '0.000477'});
});

test('an account-level funding entry shared by two live hedge legs cannot be assigned to either leg, even when it nets to zero', () => {
  const [opened, partial, closed] = shortWithPartialCloses();
  const longOpen = {...opened, key: 'long-open', direction: 'LONG', orderId: 4};
  const longClose = {...closed, key: 'long-close', direction: 'LONG', quantity: '0.003', time: 31, orderId: 5};
  for (const paid of ['-0.002', '0']) {
    const result = futuresTradeReport(state([opened, partial, longOpen, longClose, closed], [funding('shared', 15, paid)]));
    assert.equal(result.roundTrips.length, 2);
    assert.ok(result.roundTrips.every(trip => trip.funding === null && trip.net === null));
    assert.equal(result.unattributedFunding.length, 1);
    assert.equal(result.unattributedFunding[0].amount, paid);
  }
});
