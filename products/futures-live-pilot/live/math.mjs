// Exact fixed-point amounts. Linear (USD-M) and inverse (COIN-M) formulas are
// deliberately separate; COIN-M quantity is a number of contracts.
import {SCALE,units,decimal,multiply,multiplyUp,divide,floorStep,ceilStep} from '../../spot-live-pilot/live/decimal.mjs';
export {SCALE,units,decimal,multiply,multiplyUp,divide,floorStep,ceilStep};
export function signedUnits(value){
  if(typeof value!=='string'||! /^-?\d{1,18}(\.\d{1,12})?$/.test(value))throw new Error('INVALID_SIGNED_AMOUNT');
  return value.startsWith('-')?-units(value.slice(1)):units(value);
}
export const absolute=value=>value<0n?-value:value;
export function family(value){if(!['USD_M','COIN_M'].includes(value))throw new Error('FUTURES_FAMILY_REQUIRED');return value;}
export function direction(value){if(!['LONG','SHORT'].includes(value))throw new Error('POSITION_DIRECTION_REQUIRED');return value==='LONG'?1n:-1n;}
export function pnl({market,side,quantity,entryPrice,exitPrice,contractSize='1'}){
  family(market);const sign=direction(side),q=units(quantity),a=units(entryPrice),b=units(exitPrice),size=units(contractSize);
  if(!q||!a||!b||!size)throw new Error('POSITIVE_POSITION_AMOUNTS_REQUIRED');
  return decimal(market==='USD_M'?sign*q*(b-a)/SCALE:sign*q*size*(b-a)/(a*b));
}
export function positionNotional({market,quantity,price,contractSize='1'}){
  family(market);const q=units(quantity),p=units(price),size=units(contractSize);
  if(!p||!size)throw new Error('POSITIVE_CONTRACT_PRICE_REQUIRED');
  return decimal(multiply(q,market==='USD_M'?p:size));
}
export function collateralValue({market,quantity,price,contractSize='1'}){
  const quote=units(positionNotional({market,quantity,price,contractSize}));
  return market==='USD_M'?decimal(quote):decimal(divide(quote,units(price)));
}
export function totalEquityUsdt(wallets,prices){
  if(!wallets||Array.isArray(wallets)||!prices)throw new Error('VALUED_WALLETS_REQUIRED');
  let result=0n;
  for(const [asset,amount] of Object.entries(wallets)){
    const native=signedUnits(amount);if(!native)continue;
    const price=asset==='USDT'?SCALE:units(prices[asset]);if(!price)throw new Error('POSITIVE_COLLATERAL_PRICE_REQUIRED');
    result+=native*price/SCALE;
  }
  return decimal(result);
}

// The user selected INITIAL MARGIN as a share of total USDT equity. Leverage
// scales notional; it never silently changes that selected margin budget.
export function openingQuantity({market,totalEquity,marginPercent,collateralUsdt,availableCollateral,leverage,price,contractSize='1',stepSize,minimumQuantity,maximumQuantity,minimumNotional='0',feeRate='0',capToAvailable=false}){
  family(market);
  if(!Number.isSafeInteger(leverage)||leverage<1||leverage>1000||typeof marginPercent!=='number'||!Number.isFinite(marginPercent)||marginPercent<0.01||marginPercent>100)throw new Error('EXPLICIT_MARGIN_PERCENT_AND_LEVERAGE_REQUIRED');
  const equity=units(totalEquity),fx=units(collateralUsdt),p=units(price),size=units(contractSize),step=units(stepSize);
  if(!equity||!fx||!p||!size||!step)throw new Error('POSITIVE_SIZING_INPUTS_REQUIRED');
  const targetUsdt=multiply(equity,units(String(marginPercent)))/100n;
  let margin=divide(targetUsdt,fx);
  if(capToAvailable){
    const available=units(availableCollateral);
    const feeAdjusted=divide(available,SCALE+2n*BigInt(leverage)*units(feeRate));
    if(feeAdjusted<margin)margin=feeAdjusted;
  }
  const collateralNotional=margin*BigInt(leverage);
  const raw=market==='USD_M'?divide(collateralNotional,p):multiply(collateralNotional,p)*SCALE/size;
  const quantity=floorStep(raw,step),notional=units(positionNotional({market,quantity:decimal(quantity),price,contractSize}));
  if(quantity<units(minimumQuantity)||quantity>units(maximumQuantity)||notional<units(minimumNotional)||quantity===0n)throw new Error('MARGIN_BUDGET_BELOW_CONTRACT_MINIMUM_OR_FILTER');
  const nativeNotional=market==='USD_M'?notional:(notional*SCALE+p-1n)/p;
  const actualMargin=(nativeNotional+BigInt(leverage)-1n)/BigInt(leverage);
  const reservedFees=multiplyUp(nativeNotional,units(feeRate))*2n;
  if(actualMargin>margin||actualMargin+reservedFees>units(availableCollateral))throw new Error('AVAILABLE_COLLATERAL_INSUFFICIENT_WITH_FEES');
  return {quantity:decimal(quantity),targetMarginUsdt:decimal(targetUsdt),initialMargin:decimal(actualMargin),initialMarginUsdt:decimal(multiplyUp(actualMargin,fx)),notional:decimal(notional),notionalUsdt:decimal(multiply(nativeNotional,fx)),reservedRoundTripFees:decimal(reservedFees)};
}

export function stopPrice({side,entryPrice,stopLossPercent,tickSize}){
  direction(side);
  if(typeof stopLossPercent!=='number'||!Number.isFinite(stopLossPercent)||stopLossPercent<=0||stopLossPercent>=100)throw new Error('EXPLICIT_STOP_DISTANCE_REQUIRED');
  const price=units(entryPrice),tick=units(tickSize),fraction=units(String(stopLossPercent))/100n;
  const raw=side==='LONG'?multiply(price,SCALE-fraction):multiplyUp(price,SCALE+fraction);
  const rounded=side==='LONG'?ceilStep(raw,tick):floorStep(raw,tick);
  if(!rounded||(side==='LONG'?rounded>=price:rounded<=price))throw new Error('STOP_DISTANCE_BELOW_PRICE_TICK');
  return decimal(rounded);
}

export function dailyLock({previous,date,baselineUsdt,equityUsdt}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||units(baselineUsdt)<=0n)throw new Error('VERIFIED_DAY_BASELINE_REQUIRED');
  const locked=previous?.date===date&&previous.blocked===true;
  return {date,baselineUsdt,blocked:locked||signedUnits(equityUsdt)*100n<units(baselineUsdt)*80n};
}
