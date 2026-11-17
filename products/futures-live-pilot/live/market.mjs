import {units,signedUnits,decimal,multiply,divide,absolute,family} from './math.mjs';
export function contractSymbol(value){if(typeof value!=='string'||!/^([A-Z0-9]{2,24}(?:USDT|USDC)|[A-Z0-9]{2,24}USD_PERP)$/.test(value))throw new Error('INVALID_PERPETUAL_SYMBOL');return value;}
const amount=value=>typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):null;
export function contractRules(info,market,symbol){
  family(market);contractSymbol(symbol);
  const row=info?.symbols?.find(r=>r.symbol===symbol);
  if(!row||(row.status??row.contractStatus)!=='TRADING'||row.contractType!=='PERPETUAL'||(row.underlyingType!==undefined&&row.underlyingType!=='COIN')||!row.orderTypes?.includes('LIMIT')||!row.orderTypes?.includes('MARKET'))throw new Error('PERPETUAL_CONTRACT_NOT_AVAILABLE');
  if(!/^[A-Z0-9]{2,24}$/.test(row.marginAsset??''))throw new Error('INVALID_MARGIN_ASSET');
  if(market==='USD_M'&&(!['USDT','USDC'].includes(row.quoteAsset)||row.marginAsset!==row.quoteAsset))throw new Error('SINGLE_SETTLEMENT_STABLECOIN_REQUIRED');
  if(market==='COIN_M'&&(row.quoteAsset!=='USD'||row.marginAsset!==row.baseAsset))throw new Error('INVERSE_COLLATERAL_CONTRACT_REQUIRED');
  const lot=row.filters?.find(f=>f.filterType==='LOT_SIZE'),price=row.filters?.find(f=>f.filterType==='PRICE_FILTER');
  const minimum=row.filters?.find(f=>f.filterType==='MIN_NOTIONAL');
  if(!lot||!price||(market==='USD_M'&&!minimum))throw new Error('MISSING_FUTURES_FILTERS');
  const result={market,symbol,baseAsset:row.baseAsset,marginAsset:row.marginAsset,quoteAsset:row.quoteAsset,
    contractSize:market==='COIN_M'?amount(row.contractSize):'1',stepSize:lot.stepSize,minimumQuantity:lot.minQty,maximumQuantity:lot.maxQty,
    tickSize:price.tickSize,minPrice:price.minPrice,maxPrice:price.maxPrice,minimumNotional:minimum?.notional??minimum?.minNotional??'0'};
  for(const key of ['contractSize','stepSize','minimumQuantity','maximumQuantity','tickSize','minPrice','maxPrice','minimumNotional'])units(result[key]);
  if(!units(result.contractSize)||!units(result.stepSize)||!units(result.tickSize)||units(result.maximumQuantity)<units(result.minimumQuantity))throw new Error('INVALID_FUTURES_FILTERS');
  return result;
}

export function leverageTiers(raw,market,symbol){
  family(market);const row=Array.isArray(raw)?raw.find(r=>r.symbol===symbol):raw;
  if(row?.symbol!==symbol||!Array.isArray(row.brackets)||!row.brackets.length)throw new Error('ACCOUNT_LEVERAGE_BRACKETS_REQUIRED');
  const coefficient=row.notionalCoef===undefined?'1':amount(row.notionalCoef),factor=units(coefficient);
  if(factor<=0n)throw new Error('INVALID_LEVERAGE_COEFFICIENT');
  return row.brackets.map(b=>{
    if(!Number.isSafeInteger(b.initialLeverage)||b.initialLeverage<1||b.initialLeverage>1000)throw new Error('INVALID_LEVERAGE_BRACKET');
    const rawCap=units(amount(market==='USD_M'?b.notionalCap:b.qtyCap));
    // Do not enlarge the returned exchange cap based on an ambiguous optional
    // multiplier. A smaller multiplier always lowers our limit as well.
    const cap=multiply(rawCap,factor),maintenanceRate=amount(b.maintMarginRatio);
    if(maintenanceRate===null||units(maintenanceRate)>units('0.5'))throw new Error('VERIFIED_MAINTENANCE_RATE_REQUIRED');
    return {leverage:b.initialLeverage,cap:decimal(cap<rawCap?cap:rawCap),maintenanceRate};
  }).sort((a,b)=>units(a.cap)<units(b.cap)?-1:1);
}
export function checkLeverage({market,quantity,price,contractSize='1',leverage,tiers}){
  const q=units(quantity),p=units(price),size=units(contractSize);
  const exposure=market==='USD_M'?multiply(q,p):divide(multiply(q,size),p);
  const allowed=tiers.filter(t=>exposure<units(t.cap)).map(t=>t.leverage);
  if(!allowed.length||!Number.isSafeInteger(leverage)||leverage<1||leverage>Math.max(...allowed))throw new Error('SELECTED_LEVERAGE_EXCEEDS_ACCOUNT_BRACKET');
  return Math.max(...allowed);
}
export function checkIsolatedStop({leverage,stopLossPercent,feeRate,tiers}){
  const rates=tiers.filter(t=>t.leverage>=leverage).map(t=>Number(t.maintenanceRate));
  if(!rates.length||rates.some(r=>!Number.isFinite(r)))throw new Error('VERIFIED_MAINTENANCE_RATE_REQUIRED');
  // Conservative feasibility check, not a liquidation-price prediction. The
  // exchange's actual position liquidation price is checked again after entry.
  const headroom=100/(leverage+1)-Math.max(...rates)*100-Number(feeRate)*200-0.1;
  if(stopLossPercent>=headroom)throw new Error('ISOLATED_STOP_TOO_FAR_FOR_SELECTED_LEVERAGE');
}
export function futuresFees(raw,symbol){
  if(raw?.symbol!==symbol)throw new Error('COMMISSION_SYMBOL_MISMATCH');
  const maker=signedUnits(raw.makerCommissionRate),taker=signedUnits(raw.takerCommissionRate);
  if(absolute(maker)>units('0.05')||absolute(taker)>units('0.05'))throw new Error('COMMISSION_RATE_REQUIRES_REVIEW');
  const highest=maker>taker?maker:taker;
  return {maker:decimal(maker),taker:decimal(taker),reserve:decimal(highest>0n?highest:0n)};
}
export function signedPosition(raw){
  if(!raw||!['BOTH','LONG','SHORT'].includes(raw.positionSide))throw new Error('EXPLICIT_POSITION_SIDE_REQUIRED');
  const value=String(raw.positionAmt);if(!/^-?\d{1,18}(\.\d{1,12})?$/.test(value))throw new Error('INVALID_POSITION_QUANTITY');
  const negative=value.startsWith('-'),q=units(negative?value.slice(1):value);
  if(raw.positionSide==='LONG'&&negative&&q)throw new Error('HEDGE_DIRECTION_MISMATCH');
  return {quantity:decimal(absolute(q)),direction:q===0n?null:raw.positionSide==='BOTH'?(negative?'SHORT':'LONG'):raw.positionSide};
}
