import {createHash} from 'node:crypto';
import {units,signedUnits,decimal,absolute,SCALE} from './math.mjs';
import {contractSymbol} from './market.mjs';
import {ownOrderId,ownAlgoId} from './client.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const asset=value=>typeof value==='string'&&/^[A-Z0-9]{2,24}$/.test(value);
const walletKey=value=>/^(USD_M|COIN_M)\.[A-Z0-9]{2,24}$/.test(value);
const moment=value=>Number.isSafeInteger(value)&&value>0;
export function accountIdentity(balances){
  const names=[];
  for(const market of ['USD_M','COIN_M']){
    const rows=balances[market];if(!Array.isArray(rows)||!rows.length)throw new Error('BOTH_FUTURES_WALLETS_MUST_BE_READABLE');
    const aliases=[...new Set(rows.map(row=>row.accountAlias))];
    if(aliases.length!==1||typeof aliases[0]!=='string'||!/^[A-Za-z0-9_-]{2,80}$/.test(aliases[0]))throw new Error('STABLE_FUTURES_ACCOUNT_IDENTITY_REQUIRED');
    names.push([market,aliases[0]]);
  }
  return hash(JSON.stringify(names));
}
export function walletSnapshot(accounts){
  const result={};
  for(const market of ['USD_M','COIN_M']){
    const account=accounts[market];if(account?.canTrade!==true||!Array.isArray(account.assets))throw new Error('TRADABLE_FUTURES_ACCOUNTS_REQUIRED');
    for(const row of account.assets){
      if(!asset(row.asset))throw new Error('INVALID_SETTLEMENT_ASSET');
      const key=market+'.'+row.asset;if(Object.hasOwn(result,key))throw new Error('DUPLICATE_FUTURES_WALLET');
      signedUnits(row.walletBalance);result[key]=row.walletBalance;
    }
  }
  return result;
}
export function newLedger(uid,wallets,now){
  return validateLedger({version:1,uid,createdAt:now,initialWallets:structuredClone(wallets),orders:[],fills:[],funding:[],pending:null,position:null,protection:null,day:null,incomeThrough:{USD_M:now-1,COIN_M:now-1}});
}
export function validateLedger(state){
  if(!state||state.version!==1||!/^[a-f0-9]{64}$/.test(state.uid??'')||!moment(state.createdAt)||!state.initialWallets||!Array.isArray(state.orders)||!Array.isArray(state.fills)||!Array.isArray(state.funding)||state.orders.length>10000||state.fills.length>50000||state.funding.length>50000)throw new Error('INVALID_FUTURES_LEDGER');
  for(const [key,value] of Object.entries(state.initialWallets)){if(!walletKey(key))throw new Error('INVALID_LEDGER_WALLET');signedUnits(value);}
  const fillIds=new Set(),orderIds=new Set(),fundingIds=new Set();
  for(const order of state.orders){if(!ownOrderId(order.id)||orderIds.has(order.id)||!moment(order.time)||!['OPEN_LONG','OPEN_SHORT','CLOSE_LONG','CLOSE_SHORT','PROTECTION_CLOSE'].includes(order.intent))throw new Error('INVALID_FUTURES_ORDER_RECORD');orderIds.add(order.id);}
  for(const fill of state.fills){
    if(typeof fill.key!=='string'||fillIds.has(fill.key)||!moment(fill.time)||!['USD_M','COIN_M'].includes(fill.market)||!asset(fill.marginAsset)||!asset(fill.commissionAsset)||!['LONG','SHORT'].includes(fill.direction)||!['OPEN','CLOSE'].includes(fill.effect))throw new Error('INVALID_FUTURES_FILL_RECORD');
    contractSymbol(fill.symbol);if(!units(fill.quantity)||!units(fill.price)||!units(fill.contractSize))throw new Error('POSITIVE_FILL_AMOUNTS_REQUIRED');
    signedUnits(fill.realizedPnl);signedUnits(fill.commission);fillIds.add(fill.key);
  }
  for(const event of state.funding){if(typeof event.key!=='string'||fundingIds.has(event.key)||!walletKey(event.wallet)||!moment(event.time))throw new Error('INVALID_FUNDING_EVENT');signedUnits(event.amount);fundingIds.add(event.key);}
  if(state.pending&&(!['ORDER','PROTECTION','CANCEL_PROTECTION'].includes(state.pending.kind)||!moment(state.pending.createdAt)||!(ownOrderId(state.pending.id)||ownAlgoId(state.pending.id))))throw new Error('INVALID_PENDING_FUTURES_INTENT');
  if(state.position){const p=state.position;contractSymbol(p.symbol);if(!['USD_M','COIN_M'].includes(p.market)||!['LONG','SHORT'].includes(p.direction)||!['BOTH','LONG','SHORT'].includes(p.positionSide)||!units(p.quantity)||!units(p.entryPrice)||!moment(p.openedAt)||!asset(p.marginAsset))throw new Error('INVALID_OWNED_FUTURES_POSITION');}
  if(state.protection&&!ownAlgoId(state.protection.id))throw new Error('INVALID_OWNED_PROTECTION');
  return state;
}

export function nativeWalletsAt(state,time=Infinity){
  const totals=Object.fromEntries(Object.entries(state.initialWallets).map(([key,value])=>[key,signedUnits(value)]));
  const add=(key,value)=>{totals[key]=(totals[key]??0n)+value;};
  for(const fill of state.fills)if(fill.time<time){add(fill.market+'.'+fill.marginAsset,signedUnits(fill.realizedPnl));add(fill.market+'.'+fill.commissionAsset,-signedUnits(fill.commission));}
  for(const event of state.funding)if(event.time<time)add(event.wallet,signedUnits(event.amount));
  return Object.fromEntries(Object.entries(totals).map(([key,value])=>[key,decimal(value)]));
}
export function aggregateAssets(wallets){
  const result={};for(const [key,value] of Object.entries(wallets)){if(!walletKey(key))throw new Error('INVALID_WALLET_KEY');const name=key.split('.')[1];result[name]=decimal((result[name]===undefined?0n:signedUnits(result[name]))+signedUnits(value));}return result;
}
export function verifyWallets(state,actual){
  const expected=nativeWalletsAt(state);
  for(const key of new Set([...Object.keys(expected),...Object.keys(actual)])){
    // Native exchange balances generally settle to 8 decimal places. Do not
    // absorb a deposit, withdrawal, manual trade or unrecognized fee silently.
    if(absolute(signedUnits(expected[key]??'0')-signedUnits(actual[key]??'0'))>10000n)throw new Error('FUTURES_WALLET_DIFFERS_FROM_PROGRAM_LEDGER');
  }
}
export function addFunding(state,market,rows,through){
  if(!Array.isArray(rows)||!Number.isSafeInteger(through)||through<state.incomeThrough[market])throw new Error('COMPLETE_FUNDING_HISTORY_REQUIRED');
  const next=structuredClone(state),known=new Map(next.funding.map(row=>[row.key,row]));
  for(const row of rows){
    if(row.incomeType!=='FUNDING_FEE')continue;
    if(!asset(row.asset)||!moment(row.time)||row.time>through||row.time<state.createdAt||typeof row.tranId!=='string'&&!Number.isSafeInteger(row.tranId))throw new Error('INVALID_EXCHANGE_FUNDING');
    const key=market+':FUNDING_FEE:'+String(row.tranId),event={key,wallet:market+'.'+row.asset,symbol:row.symbol,amount:decimal(signedUnits(row.income)),time:row.time};
    if(known.has(key)){if(JSON.stringify(known.get(key))!==JSON.stringify(event))throw new Error('FUNDING_HISTORY_CHANGED');continue;}
    next.funding.push(event);known.set(key,event);
  }
  next.incomeThrough[market]=through;return validateLedger(next);
}
function entryFromFills(fills,market,size){
  let q=0n,value=0n;
  for(const f of fills){const amount=units(f.quantity),price=units(f.price);q+=amount;value+=market==='USD_M'?amount*price/SCALE:amount*units(size)/price;}
  if(!q||!value)throw new Error('POSITIVE_ENTRY_FILL_VALUE_REQUIRED');
  return decimal(market==='USD_M'?value*SCALE/q:q*units(size)/value);
}
export function applyFinalOrder(state,order,rawFills){
  const pending=state.pending;if(pending?.kind!=='ORDER'||!ownOrderId(pending.id)||!Array.isArray(rawFills))throw new Error('OWNED_PENDING_ORDER_REQUIRED');
  const {args,market,intent,rules,direction}=pending;
  const linkedProtection=intent==='PROTECTION_CLOSE'&&ownAlgoId(pending.protectionId)&&state.protection?.id===pending.protectionId&&pending.exchangeOrderId===order.orderId;
  if((!linkedProtection&&order.clientOrderId!==pending.id)||order.symbol!==args.symbol||order.side!==args.side||order.positionSide!==args.positionSide||order.type!==args.type||units(order.origQty)!==units(args.quantity)||!Number.isSafeInteger(order.orderId)||order.orderId<=0||!['FILLED','CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH'].includes(order.status))throw new Error('TERMINAL_OWNED_FUTURES_ORDER_REQUIRED');
  const executed=units(order.executedQty);if(executed>units(args.quantity))throw new Error('ORDER_OVERFILLED');
  const unique=new Set(),fills=[];
  for(const row of rawFills){
    if(row.orderId!==order.orderId||row.symbol!==args.symbol||row.side!==args.side||row.positionSide!==args.positionSide||!Number.isSafeInteger(row.id)||row.id<0||unique.has(row.id)||!moment(row.time)||!asset(row.commissionAsset)||!units(row.qty)||!units(row.price))throw new Error('COMPLETE_OWNED_ORDER_FILLS_REQUIRED');
    if(args.type==='LIMIT'&&(args.side==='BUY'?units(row.price)>units(args.price):units(row.price)<units(args.price)))throw new Error('FILL_OUTSIDE_ORDER_LIMIT');
    signedUnits(row.realizedPnl);signedUnits(row.commission);unique.add(row.id);
    fills.push({key:market+':'+row.symbol+':'+row.id,market,symbol:row.symbol,orderId:row.orderId,time:row.time,quantity:row.qty,price:row.price,realizedPnl:row.realizedPnl,commission:row.commission,commissionAsset:row.commissionAsset,marginAsset:rules.marginAsset,contractSize:rules.contractSize,direction,effect:intent.startsWith('OPEN_')?'OPEN':'CLOSE'});
  }
  if(fills.reduce((sum,row)=>sum+units(row.quantity),0n)!==executed||fills.length>=1000)throw new Error('INCOMPLETE_ORDER_FILL_HISTORY');
  const next=structuredClone(state);if(next.fills.some(row=>fills.some(fill=>fill.key===row.key)))throw new Error('FILL_ALREADY_ACCOUNTED');
  if(executed){
    if(intent.startsWith('OPEN_')){
      if(next.position||fills.some(row=>signedUnits(row.realizedPnl)!==0n))throw new Error('OPEN_REQUIRES_FLAT_OWNED_LEDGER');
      next.position={market,symbol:args.symbol,direction,positionSide:args.positionSide,quantity:decimal(executed),entryPrice:entryFromFills(fills,market,rules.contractSize),contractSize:rules.contractSize,marginAsset:rules.marginAsset,openedAt:Math.min(...fills.map(row=>row.time)),risk:pending.risk};
    }else{
      const owned=next.position;
      if(!owned||owned.market!==market||owned.symbol!==args.symbol||owned.direction!==direction||owned.positionSide!==args.positionSide||executed>units(owned.quantity))throw new Error('CLOSE_CANNOT_REVERSE_OR_USE_UNOWNED_POSITION');
      const remaining=units(owned.quantity)-executed;next.position=remaining?{...owned,quantity:decimal(remaining)}:null;
    }
  }
  next.fills.push(...fills);next.orders.push({id:pending.id,orderId:order.orderId,market,symbol:args.symbol,intent,side:args.side,positionSide:args.positionSide,quantity:decimal(executed),status:order.status,time:fills.length?Math.max(...fills.map(row=>row.time)):pending.createdAt});next.pending=null;
  return validateLedger(next);
}
