import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeExchange} from './testing/fake-exchange.mjs';
import {validateSettings} from './engine.mjs';
import {FUTURES_CONFIRMATION, MODE_CONFIRMATION} from './client.mjs';
import {decimal, signedUnits, units} from './math.mjs';

const botSymbol = 'BTCUSDT';
const manualSymbol = 'ETHUSDT';
const writes = new Set(['newOrder', 'newProtection', 'cancelProtection', 'addMargin', 'setLeverage', 'setMargin', 'setPositionMode']);

function manualPosition(symbol = manualSymbol) {
  return {symbol, positionSide: 'BOTH', positionAmt: '1', entryPrice: '9995.3',
    markPrice: '10000', unRealizedProfit: '4.7', liquidationPrice: '8995', marginType: 'cross'};
}

// The manual client has its own positions and orders. Only their exchange-visible
// snapshots, not the manual client's order-creation controls, enter the bot.
async function accountWithManualClient(t, policy = 'otherContracts') {
  const f = await fakeExchange(t, {hedge: false, positionPolicy: 'single', marginMode: 'CROSSED'});
  const external = {positions: [], openOrders: [], openAlgos: [], locked: '0', pnl: '0'};
  const usd = f.clients.USD_M;
  const request = usd.request.bind(usd);
  usd.request = async (name, args = {}) => {
    if (name === 'marginIndex') return {symbol: args.symbol, index: '1', time: usd.serverNow()};
    const result = await request(name, args);
    if (name === 'accountConfig') return {...result, multiAssetsMargin: true};
    if (['positions', 'openOrders', 'openAlgos'].includes(name)) {
      const observed = [...external[name], ...result];
      return structuredClone(args.symbol ? observed.filter(row => row.symbol === args.symbol) : observed);
    }
    if (name === 'account') {
      const asset = result.assets[0];
      asset.unrealizedProfit = decimal(signedUnits(asset.unrealizedProfit) + signedUnits(external.pnl));
      const balance = (await request('balances'))[0];
      result.totalMarginBalance = decimal(signedUnits(asset.walletBalance) + signedUnits(asset.unrealizedProfit));
      result.availableBalance = decimal(signedUnits(balance.availableBalance) + signedUnits(asset.unrealizedProfit) - units(external.locked));
    }
    return result;
  };
  f.engine.settings = validateSettings({...f.settings, assetMode: 'multi', externalPositionPolicy: policy});
  return {...f, external};
}

function addManualPortfolio(external) {
  external.positions.push(manualPosition());
  external.openOrders.push({symbol: manualSymbol, clientOrderId: 'manual-limit', orderId: 930, positionSide: 'BOTH'});
  external.openAlgos.push({symbol: manualSymbol, clientAlgoId: 'manual-stop', algoId: 931, positionSide: 'BOTH'});
  external.locked = '999.7';
  external.pnl = '4.7';
}

test('other contracts retain their positions and orders while available cross profit funds an independently protected bot trade', async t => {
  const {engine, calls, external} = await accountWithManualClient(t);
  addManualPortfolio(external);
  const original = structuredClone(external);
  const snapshot = await engine.check();
  assert.equal(snapshot.accountChecked, true);
  assert.equal(snapshot.equityUsdt, '1004.7');
  assert.equal(engine.marginCapacity.availableUsdt, '5');
  const allocation = snapshot.plan.allocation;
  const required = units(allocation.initialMargin) + units(allocation.reservedRoundTripFees);
  assert.ok(required > units('0.3'), 'the test trade requires some exchange-credited profit');
  assert.ok(required <= units('5'), 'profit must not be added to available balance again');
  assert.equal(calls.some(c => writes.has(c.name)), false);
  await engine.start(FUTURES_CONFIRMATION);
  await engine.check({execute: true});
  assert.equal(engine.state.positions.LONG.symbol, botSymbol);
  const stopId = engine.state.protections.LONG.id;
  assert.notEqual(stopId, external.openAlgos[0].clientAlgoId);
  await engine.closeOwnedPosition(FUTURES_CONFIRMATION, 'LONG');
  assert.equal(engine.state.positions.LONG, null);
  assert.equal(engine.state.protections.LONG, null);
  const submitted = calls.filter(c => writes.has(c.name));
  assert.equal(submitted.filter(c => c.name === 'newOrder').length, 2);
  assert.equal(submitted.filter(c => c.name === 'newProtection').length, 1);
  assert.deepEqual(submitted.filter(c => c.name === 'cancelProtection').map(c => c.args.clientAlgoId), [stopId]);
  for (const call of submitted) assert.equal(call.args.symbol ?? (call.args.clientAlgoId === stopId ? botSymbol : undefined), botSymbol);
  assert.deepEqual(external, original);
});

test('manual contract may appear after bot starts and survives execution of the bot stop', async t => {
  const {engine, external, triggerStop} = await accountWithManualClient(t);
  await engine.start(FUTURES_CONFIRMATION);
  await engine.check({execute: true});
  addManualPortfolio(external);
  external.locked = '100';
  const original = structuredClone(external);
  assert.equal((await engine.check()).accountChecked, true);
  triggerStop('LONG');
  await engine.check();
  assert.equal(engine.state.positions.LONG, null);
  assert.equal(engine.state.orders.at(-1).intent, 'PROTECTION_CLOSE');
  assert.deepEqual(external, original);
});

test('a visible external profit cannot finance an order if Binance reports no available margin', async t => {
  const {engine, external, calls} = await accountWithManualClient(t);
  addManualPortfolio(external);
  external.locked = '1004.7';
  const snapshot = await engine.check();
  assert.equal(snapshot.accountChecked, true);
  assert.equal(snapshot.equityUsdt, '1004.7');
  assert.equal(engine.marginCapacity.availableUsdt, '0');
  assert.equal(snapshot.plan, null);
  assert.ok(snapshot.blocker);
  await engine.check({execute: true});
  assert.equal(calls.some(c => writes.has(c.name)), false);
});

test('drawdown on a manual contract remains part of the shared account daily loss limit', async t => {
  const {engine, external, calls} = await accountWithManualClient(t);
  addManualPortfolio(external);
  external.locked = '500';
  const first = await engine.check();
  assert.equal(first.day.blocked, false);
  external.pnl = '-250';
  external.positions[0].unRealizedProfit = external.pnl;
  const later = await engine.check();
  assert.equal(later.day.blocked, true);
  assert.equal(later.plan, null);
  await assert.rejects(engine.start(FUTURES_CONFIRMATION), /DAILY/);
  assert.equal(calls.some(c => writes.has(c.name)), false);
});

for (const [label, source, row, error] of [
  ['position on the selected contract', 'positions', manualPosition(botSymbol), /MANUAL_POSITION_ON_SELECTED_CONTRACT/],
  ['unowned order on the selected contract', 'openOrders', {symbol: botSymbol, clientOrderId: 'manual-limit'}, /UNMANAGED_ORDER_ON_SELECTED_CONTRACT/],
  ['unowned stop on the selected contract', 'openAlgos', {symbol: botSymbol, clientAlgoId: 'manual-stop'}, /UNMANAGED_ORDER_ON_SELECTED_CONTRACT/],
  ['unidentified position', 'positions', {...manualPosition(), symbol: undefined}, /UNIDENTIFIED_EXTERNAL_FUTURES_EXPOSURE/],
  ['unidentified order', 'openOrders', {clientOrderId: 'manual-limit'}, /UNIDENTIFIED_EXTERNAL_FUTURES_EXPOSURE/],
  ['unidentified stop', 'openAlgos', {clientAlgoId: 'manual-stop'}, /UNIDENTIFIED_EXTERNAL_FUTURES_EXPOSURE/],
  ['an untracked bot order on another contract', 'openOrders', {symbol: manualSymbol, clientOrderId: 'asbf_' + 'a'.repeat(28)}, /EXTERNAL_BOT_ORDER_REQUIRES_REVIEW/],
  ['an untracked bot stop on another contract', 'openAlgos', {symbol: manualSymbol, clientAlgoId: 'asbp_' + 'b'.repeat(28)}, /EXTERNAL_BOT_ORDER_REQUIRES_REVIEW/],
]) {
  test(`refuses ${label} without submitting any order`, async t => {
    const {engine, external, calls} = await accountWithManualClient(t);
    external[source].push(row);
    await assert.rejects(engine.start(FUTURES_CONFIRMATION), error);
    assert.equal(engine.running, false);
    assert.equal(calls.some(c => writes.has(c.name)), false);
  });
}

test('legacy strict policy still rejects manual holdings on a different contract', async t => {
  const {engine, external, calls} = await accountWithManualClient(t, 'block');
  external.positions.push(manualPosition());
  await assert.rejects(engine.check(), /POSITION/);
  assert.equal(calls.some(c => writes.has(c.name)), false);
});

test('shared position-mode changes remain blocked when a manual contract is open', async t => {
  const {engine, calls, external} = await accountWithManualClient(t);
  external.positions.push(manualPosition());
  await assert.rejects(engine.enableHedgeMode(MODE_CONFIRMATION), /ACCOUNT_MODE_CHANGE_REQUIRES_NO_EXTERNAL_EXPOSURE/);
  assert.equal(calls.some(c => c.name === 'setPositionMode'), false);
});

for (const changedField of ['quantity', 'entryPrice']) {
  test(`an unexplained ${changedField} change on the bot contract halts execution and preserves its exchange stop`, async t => {
    const {engine, positions, calls, stops} = await accountWithManualClient(t);
    await engine.start(FUTURES_CONFIRMATION);
    await engine.check({execute: true});
    const stopId = engine.state.protections.LONG.id;
    const position = positions.get('USD_M:LONG');
    if (changedField === 'quantity') position.quantity = decimal(units(position.quantity) + units('0.001'));
    else position.entryPrice = '9800';
    const firstWriteCount = calls.filter(c => writes.has(c.name)).length;
    await assert.rejects(engine.check({execute: true}), /POSITION/);
    assert.equal(engine.running, false);
    assert.equal(calls.filter(c => writes.has(c.name)).length, firstWriteCount);
    assert.equal(stops.get(stopId).algoStatus, 'NEW');
  });
}
