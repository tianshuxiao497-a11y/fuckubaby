import test from 'node:test';
import assert from 'node:assert/strict';
import {pnl,positionNotional,collateralValue,openingQuantity,totalEquityUsdt,dailyLock,stopPrice,signedUnits} from './math.mjs';
import {leverageTiers,checkLeverage,checkIsolatedStop,signedPosition} from './market.mjs';

test('linear long and short use signed price difference in settlement currency',()=>{
  const position={market:'USD_M',quantity:'2',entryPrice:'100',exitPrice:'110'};
  assert.equal(pnl({...position,side:'LONG'}),'20');assert.equal(pnl({...position,side:'SHORT'}),'-20');
  assert.equal(pnl({...position,side:'SHORT',exitPrice:'90'}),'20');
});
test('inverse long and short use contract value and reciprocal prices',()=>{
  const position={market:'COIN_M',quantity:'10',contractSize:'100',entryPrice:'10000',exitPrice:'20000'};
  assert.equal(pnl({...position,side:'LONG'}),'0.05');assert.equal(pnl({...position,side:'SHORT'}),'-0.05');
  assert.equal(positionNotional({...position,price:'20000'}),'1000');
  assert.equal(collateralValue({...position,price:'20000'}),'0.05');
});
const linear={market:'USD_M',totalEquity:'1000',marginPercent:2,collateralUsdt:'1',availableCollateral:'1000',leverage:10,price:'100',stepSize:'0.01',minimumQuantity:'0.01',maximumQuantity:'10000',minimumNotional:'5',feeRate:'0.0005'};
test('selected 2% INITIAL MARGIN gives 20 collateral and 200 notional at 10x',()=>{
  const p=openingQuantity(linear);assert.equal(p.targetMarginUsdt,'20');assert.equal(p.initialMargin,'20');assert.equal(p.notionalUsdt,'200');assert.equal(p.quantity,'2');assert.equal(p.reservedRoundTripFees,'0.2');
  const x=openingQuantity({...linear,leverage:20});assert.equal(x.initialMargin,'20');assert.equal(x.notionalUsdt,'400');
});
test('coin-margined sizing returns contract count, not an underlying coin quantity',()=>{
  const p=openingQuantity({...linear,market:'COIN_M',collateralUsdt:'10000',availableCollateral:'0.1',price:'10000',contractSize:'100',stepSize:'1',minimumQuantity:'1',maximumQuantity:'100000'});
  assert.equal(p.quantity,'2');assert.equal(p.initialMargin,'0.002');assert.equal(p.initialMarginUsdt,'20');assert.equal(p.notional,'200');
});
test('fees cannot be silently consumed beyond the available margin balance',()=>{
  assert.throws(()=>openingQuantity({...linear,availableCollateral:'20'}),/AVAILABLE_COLLATERAL/);
});
test('small allocations are rejected without increasing the user-selected margin',()=>{
  assert.throws(()=>openingQuantity({...linear,totalEquity:'10',leverage:1}),/MINIMUM/);
});
test('collateral appreciation/depreciation is included in USDT equity',()=>{
  assert.equal(totalEquityUsdt({USDT:'100',BTC:'0.01'},{BTC:'10000'}),'200');
  assert.equal(totalEquityUsdt({USDT:'100',BTC:'0.01'},{BTC:'5000'}),'150');
  assert.throws(()=>totalEquityUsdt({BTC:'0.01'},{}));
});
test('day lock includes negative equity, stays latched after recovery and resets only with a new supplied baseline',()=>{
  const first=dailyLock({date:'2026-11-17',baselineUsdt:'1000',equityUsdt:'799'});assert.equal(first.blocked,true);
  assert.equal(dailyLock({previous:first,date:first.date,baselineUsdt:'1000',equityUsdt:'1100'}).blocked,true);
  assert.equal(dailyLock({previous:first,date:'2026-11-18',baselineUsdt:'1100',equityUsdt:'1100'}).blocked,false);
  assert.equal(dailyLock({date:first.date,baselineUsdt:'1000',equityUsdt:'-1'}).blocked,true);
  assert.equal(dailyLock({date:first.date,baselineUsdt:'1000',equityUsdt:'800'}).blocked,false);
});
test('protective stop rounding never expands the selected underlying-price distance',()=>{
  assert.equal(stopPrice({side:'LONG',entryPrice:'100',stopLossPercent:1.234,tickSize:'0.1'}),'98.8');
  assert.equal(stopPrice({side:'SHORT',entryPrice:'100',stopLossPercent:1.234,tickSize:'0.1'}),'101.2');
  assert.throws(()=>stopPrice({side:'LONG',entryPrice:'100',stopLossPercent:0.001,tickSize:'1'}));
});
test('exchange tier limits depend on selected notional and do not force maximum leverage',()=>{
  const tiers=leverageTiers([{symbol:'BTCUSDT',brackets:[{initialLeverage:100,notionalCap:1000,maintMarginRatio:0.004},{initialLeverage:20,notionalCap:100000,maintMarginRatio:0.005}]}],'USD_M','BTCUSDT');
  assert.equal(checkLeverage({...linear,quantity:'2',tiers}),100);
  assert.throws(()=>checkLeverage({...linear,quantity:'20',leverage:100,tiers}),/EXCEEDS/);
  assert.equal(checkLeverage({...linear,quantity:'20',leverage:10,tiers}),20);
});
test('inverse bracket exposure is denominated in underlying coin',()=>{
  const tiers=leverageTiers([{symbol:'BTCUSD_PERP',brackets:[{initialLeverage:50,qtyCap:1,maintMarginRatio:0.004}]}],'COIN_M','BTCUSD_PERP');
  assert.equal(checkLeverage({market:'COIN_M',quantity:'10',contractSize:'100',price:'10000',leverage:20,tiers}),50);
});
test('a stop beyond plausible isolated collateral headroom is blocked before an entry',()=>{
  const tiers=[{leverage:125,maintenanceRate:'0.004'}];
  assert.throws(()=>checkIsolatedStop({leverage:125,stopLossPercent:1,feeRate:'0.0005',tiers}),/TOO_FAR/);
  assert.doesNotThrow(()=>checkIsolatedStop({leverage:10,stopLossPercent:1,feeRate:'0.0005',tiers}));
});
test('one-way negative quantities and hedge position sides remain distinct',()=>{
  assert.deepEqual(signedPosition({positionSide:'BOTH',positionAmt:'-2'}),{quantity:'2',direction:'SHORT'});
  assert.deepEqual(signedPosition({positionSide:'SHORT',positionAmt:'2'}),{quantity:'2',direction:'SHORT'});
  assert.equal(signedUnits('-0.001'),-1000000000n);
  assert.throws(()=>signedPosition({positionSide:'LONG',positionAmt:'-2'}));
});
