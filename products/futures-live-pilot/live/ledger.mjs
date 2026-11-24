import {createHash} from 'node:crypto';
import {units,signedUnits,decimal,absolute,SCALE,pnl} from './math.mjs';
import {contractSymbol,signedPosition} from './market.mjs';
import {ownOrderId,ownAlgoId,ownMarginId} from './client.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const asset=value=>typeof value==='string'&&/^[A-Z0-9]{1,24}$/.test(value);
const walletKey=value=>/^(USD_M|COIN_M)\.[A-Z0-9]{1,24}$/.test(value);
const moment=value=>Number.isSafeInteger(value)&&value>0;
const externalTypes=new Set(['REALIZED_PNL','COMMISSION','FUNDING_FEE']);
// Read-only exchange history can include dated delivery contracts as well as perpetuals.
const incomeSymbol=value=>typeof value==='string'&&/^[\p{L}\p{N}_-]{2,64}$/u.test(value);
const exchangeId=value=>typeof value==='string'?/^\d{1,30}$/.test(value):Number.isSafeInteger(value)&&value>=0;
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
  return validateLedger({version:2,uid,createdAt:now,initialWallets:structuredClone(wallets),orders:[],fills:[],funding:[],marginEvents:[],autoMarginBudgets:{},pending:null,positions:{LONG:null,SHORT:null},protections:{LONG:null,SHORT:null},hedgeLock:null,day:null,incomeThrough:{USD_M:now-1,COIN_M:now-1}});
}
export const ownedPositions=state=>Object.values(state?.positions??{}).filter(Boolean);
export const ownedProtections=state=>Object.values(state?.protections??{}).filter(Boolean);

export function makeExternalSnapshot(rows,observedAt){
  if(!Array.isArray(rows)||!moment(observedAt))throw new Error('EXTERNAL_POSITION_SNAPSHOT_UNVERIFIED');
  const positions=[],seen=new Set();
  for(const row of rows){
    if(!['USD_M','COIN_M'].includes(row?.market)||!incomeSymbol(row.symbol))throw new Error('EXTERNAL_POSITION_SNAPSHOT_UNVERIFIED');
    const position=signedPosition(row);
    if(!position.direction)continue;
    const key=[row.market,row.symbol,row.positionSide].join(':');
    if(seen.has(key)||!units(row.entryPrice))throw new Error('EXTERNAL_POSITION_SNAPSHOT_UNVERIFIED');
    const updateTime=row.updateTime==null||row.updateTime===0||row.updateTime==='0'?null:Number(row.updateTime);
    if(updateTime!==null&&(!moment(updateTime)||updateTime>observedAt))throw new Error('EXTERNAL_POSITION_SNAPSHOT_UNVERIFIED');
    seen.add(key);
    positions.push({market:row.market,symbol:row.symbol,positionSide:row.positionSide,positionAmt:position.direction==='LONG'?position.quantity:'-'+position.quantity,entryPrice:decimal(units(row.entryPrice)),updateTime});
  }
  return {time:observedAt,positions};
}

function openQuantity(positions,side){
  return positions.filter(row=>row.positionSide===side).reduce((sum,row)=>sum+signedUnits(row.positionAmt),0n);
}

// Reverse external executions against one fixed mark. At that mark an execution
// changes unrealized PNL by its signed mark-to-fill PNL minus its realized PNL.
// This also reconstructs a manual position closed since midnight, even if no
// open position for that contract is returned in the current account snapshot.
export async function externalMidnightPnl(state,snapshot,boundary,{contract,trades}){
  const unavailable=()=>new Error('EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED');
  try{
    if(!moment(boundary)||snapshot?.time<boundary)throw unavailable();
    const current=makeExternalSnapshot(snapshot.positions,snapshot.time);
    const previous=state.externalSnapshot?makeExternalSnapshot(state.externalSnapshot.positions,state.externalSnapshot.time):null;
    const anchor=previous&&previous.time<boundary?previous:null;
    const income=(state.externalIncome??[]).filter(row=>row.time>=boundary&&row.time<=current.time);
    const groups=new Map(),botFills=new Set(state.fills.map(row=>row.key));
    function group(market,symbol){
      const key=market+':'+symbol;
      if(!groups.has(key))groups.set(key,{market,symbol,before:[],after:[],income:[]});
      return groups.get(key);
    }
    for(const row of anchor?.positions??[])group(row.market,row.symbol).before.push(row);
    for(const row of current.positions)group(row.market,row.symbol).after.push(row);
    for(const row of income)group(row.wallet.split('.')[0],row.symbol).income.push(row);
    const totals={};
    for(const {market,symbol,before,after,income:events} of groups.values()){
      const unchanged=after.length>0&&after.every(row=>row.updateTime!==null&&row.updateTime<boundary)
        &&before.every(old=>after.some(row=>row.positionSide===old.positionSide&&row.positionAmt===old.positionAmt&&row.entryPrice===old.entryPrice))
        &&!events.some(event=>event.type!=='FUNDING_FEE');
      const executions=[];
      if(!unchanged){
        if(!anchor)throw unavailable();
        // Binance limits the time window per history request. Separate adjacent
        // inclusive windows and verify the full delta against both snapshots.
        const seen=new Set(),afterBoundaryIds=new Set(),net={LONG:0n,SHORT:0n,BOTH:0n};
        for(let start=anchor.time;start<=current.time;){
          const end=Math.min(current.time,start+7*86400000-1);
          const rows=await trades(market,symbol,start,end);
          if(!Array.isArray(rows))throw unavailable();
          for(const row of rows){
            if(!exchangeId(row?.id)||seen.has(String(row.id))||row.symbol!==symbol||!moment(row.time)||row.time<start||row.time>end||row.time===anchor.time||row.time===current.time||!['BUY','SELL'].includes(row.side)||!Object.hasOwn(net,row.positionSide)||!units(row.qty)||!units(row.price))throw unavailable();
            seen.add(String(row.id));
            if(botFills.has(market+':'+symbol+':'+row.id))continue;
            signedUnits(row.realizedPnl);
            net[row.positionSide]+=(row.side==='BUY'?1n:-1n)*units(row.qty);
            if(row.time>=boundary){executions.push(row);afterBoundaryIds.add(String(row.id));}
          }
          start=end+1;
        }
        for(const side of Object.keys(net))if(openQuantity(before,side)+net[side]!==openQuantity(after,side))throw unavailable();
        for(const event of events)if(event.type!=='FUNDING_FEE'&&event.tradeId!==null&&!afterBoundaryIds.has(event.tradeId))throw unavailable();
      }
      if(!after.length&&!executions.length)continue;
      const {marginAsset,contractSize,markPrice}=await contract(market,symbol);
      if(!asset(marginAsset)||!units(contractSize)||!units(markPrice))throw unavailable();
      const marked=(side,quantity,price)=>signedUnits(pnl({market,side,quantity,entryPrice:price,exitPrice:markPrice,contractSize}));
      let native=0n;
      for(const row of after){
        const {direction,quantity}=signedPosition(row);
        native+=marked(direction,quantity,row.entryPrice);
      }
      for(const trade of executions){
        if(trade.marginAsset&&trade.marginAsset!==marginAsset)throw unavailable();
        native+=signedUnits(trade.realizedPnl)-marked(trade.side==='BUY'?'LONG':'SHORT',trade.qty,trade.price);
      }
      const key=market+'.'+marginAsset;
      totals[key]=decimal(signedUnits(totals[key]??'0')+native);
    }
    return totals;
  }catch{
    throw unavailable();
  }
}
export function migrateLedger(value){
  if(value?.version!==1)return value;
  const next={...value,version:2,positions:{LONG:null,SHORT:null},protections:{LONG:null,SHORT:null},marginEvents:[],autoMarginBudgets:{},hedgeLock:null};
  if(value.position)next.positions[value.position.direction]=value.position;
  const direction=value.position?.direction??(value.protection?.side==='SELL'?'LONG':value.protection?.side==='BUY'?'SHORT':null);
  if(value.protection){if(!direction)throw new Error('LEGACY_PROTECTION_DIRECTION_REQUIRED');next.protections[direction]=value.protection;}
  if(next.pending&&next.pending.kind!=='ORDER')next.pending={...next.pending,direction:next.pending.direction??direction??(next.pending.args?.side==='SELL'?'LONG':'SHORT')};
  delete next.position;delete next.protection;return next;
}
export function validateLedger(state){
  state=migrateLedger(state);
  if(state&&state.version===2&&state.autoMarginBudgets===undefined)state.autoMarginBudgets={};
  if(!state||state.version!==2||!/^[a-f0-9]{64}$/.test(state.uid??'')||!moment(state.createdAt)||!state.initialWallets||!Array.isArray(state.orders)||!Array.isArray(state.fills)||!Array.isArray(state.funding)||!Array.isArray(state.marginEvents)||state.orders.length>10000||state.fills.length>50000||state.funding.length>50000||state.marginEvents.length>10000)throw new Error('INVALID_FUTURES_LEDGER');
  for(const field of ['positions','protections'])if(!state[field]||Object.keys(state[field]).sort().join(',')!=='LONG,SHORT')throw new Error('TWO_EXPLICIT_FUTURES_LEGS_REQUIRED');
  for(const [key,value] of Object.entries(state.initialWallets)){if(!walletKey(key))throw new Error('INVALID_LEDGER_WALLET');signedUnits(value);}
  if(state.externalSnapshot!==undefined)makeExternalSnapshot(state.externalSnapshot?.positions,state.externalSnapshot?.time);
  const fillIds=new Set(),orderIds=new Set(),fundingIds=new Set();
  for(const order of state.orders){if(!ownOrderId(order.id)||orderIds.has(order.id)||!moment(order.time)||!['OPEN_LONG','OPEN_SHORT','CLOSE_LONG','CLOSE_SHORT','PROTECTION_CLOSE'].includes(order.intent))throw new Error('INVALID_FUTURES_ORDER_RECORD');orderIds.add(order.id);}
  for(const fill of state.fills){
    if(typeof fill.key!=='string'||fillIds.has(fill.key)||!moment(fill.time)||!['USD_M','COIN_M'].includes(fill.market)||!asset(fill.marginAsset)||!asset(fill.commissionAsset)||!['LONG','SHORT'].includes(fill.direction)||!['OPEN','CLOSE'].includes(fill.effect))throw new Error('INVALID_FUTURES_FILL_RECORD');
    contractSymbol(fill.symbol);if(!units(fill.quantity)||!units(fill.price)||!units(fill.contractSize))throw new Error('POSITIVE_FILL_AMOUNTS_REQUIRED');
    signedUnits(fill.realizedPnl);signedUnits(fill.commission);fillIds.add(fill.key);
  }
  for(const event of state.funding){if(typeof event.key!=='string'||fundingIds.has(event.key)||!walletKey(event.wallet)||!moment(event.time))throw new Error('INVALID_FUNDING_EVENT');signedUnits(event.amount);fundingIds.add(event.key);}
  if(state.externalIncome!==undefined){
    if(!Array.isArray(state.externalIncome)||state.externalIncome.length>50000)throw new Error('INVALID_EXTERNAL_FUTURES_INCOME');
    for(const event of state.externalIncome){
      const prefix=event?.wallet?.split('.')[0]+':'+event?.type+':';
      if(!externalTypes.has(event?.type)||!walletKey(event.wallet)||!incomeSymbol(event.symbol)||typeof event.key!=='string'||!event.key.startsWith(prefix)||!exchangeId(event.key.slice(prefix.length))||fundingIds.has(event.key)||!moment(event.time)||event.time<state.createdAt||(event.tradeId!==null&&!exchangeId(event.tradeId)))throw new Error('INVALID_EXTERNAL_FUTURES_INCOME');
      signedUnits(event.amount);fundingIds.add(event.key);
    }
  }
  if(state.externalIncomeThrough!==undefined){
    if(!Array.isArray(state.externalIncome)||!state.externalIncomeThrough||typeof state.externalIncomeThrough!=='object'||Array.isArray(state.externalIncomeThrough))throw new Error('INVALID_FUTURES_INCOME_CURSOR');
    for(const [market,through] of Object.entries(state.externalIncomeThrough)){
      if(!['USD_M','COIN_M'].includes(market)||!Number.isSafeInteger(through)||through<state.createdAt-1||through>state.incomeThrough[market])throw new Error('INVALID_FUTURES_INCOME_CURSOR');
    }
  }
  if(state.pending&&(!['ORDER','PROTECTION','CANCEL_PROTECTION','MARGIN_ADD'].includes(state.pending.kind)||!moment(state.pending.createdAt)||!(ownOrderId(state.pending.id)||ownAlgoId(state.pending.id)||ownMarginId(state.pending.id))||!['LONG','SHORT'].includes(state.pending.direction)))throw new Error('INVALID_PENDING_FUTURES_INTENT');
  if(state.makerProtectionDue){
    const receipt=state.orders.find(order=>order.id===state.makerProtectionDue);
    const leg=receipt?.intent==='OPEN_LONG'?'LONG':receipt?.intent==='OPEN_SHORT'?'SHORT':null;
    const position=leg&&state.positions[leg];
    if(!receipt||receipt.timeInForce!=='GTX'||!position||position.market!==receipt.market||position.symbol!==receipt.symbol||
      position.positionSide!==receipt.positionSide||units(position.quantity)!==units(receipt.quantity))throw new Error('INVALID_MAKER_PROTECTION_RECEIPT');
  }
  for(const direction of ['LONG','SHORT']){
    const p=state.positions[direction];if(p){contractSymbol(p.symbol);if(!['USD_M','COIN_M'].includes(p.market)||p.direction!==direction||![direction,'BOTH'].includes(p.positionSide)||!units(p.quantity)||!units(p.entryPrice)||!units(p.contractSize)||!moment(p.openedAt)||!asset(p.marginAsset)||!p.risk)throw new Error('INVALID_OWNED_FUTURES_POSITION');}
    const stop=state.protections[direction];if(stop&&(!ownAlgoId(stop.id)||stop.side!==(direction==='LONG'?'SELL':'BUY')||![direction,'BOTH'].includes(stop.positionSide)))throw new Error('INVALID_OWNED_PROTECTION');
  }
  if(ownedPositions(state).length===2&&(ownedPositions(state).some(p=>p.positionSide==='BOTH')||state.positions.LONG.market!==state.positions.SHORT.market||state.positions.LONG.symbol!==state.positions.SHORT.symbol))throw new Error('ONE_CONTRACT_TWO_DISTINCT_HEDGE_LEGS_REQUIRED');
  const marginIds=new Set();for(const event of state.marginEvents){if(!ownMarginId(event.id)||marginIds.has(event.id)||!['USD_M','COIN_M'].includes(event.market)||!['LONG','SHORT'].includes(event.direction)||!moment(event.time)||!asset(event.asset)||!units(event.amount)||typeof event.historyKey!=='string')throw new Error('INVALID_MARGIN_ADDITION_RECORD');marginIds.add(event.id);}
  if(!state.autoMarginBudgets||Array.isArray(state.autoMarginBudgets)||Object.keys(state.autoMarginBudgets).length>1000)throw new Error('INVALID_AUTO_MARGIN_BUDGETS');
  for(const [id,budget] of Object.entries(state.autoMarginBudgets)){if(!/^[-A-Za-z0-9_]{4,48}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||!['USD_M','COIN_M'].includes(budget.market)||!asset(budget.asset)||!Number.isSafeInteger(budget.additions)||budget.additions<0||!Number.isSafeInteger(budget.lastAdditionAt)||budget.lastAdditionAt<0)throw new Error('INVALID_AUTO_MARGIN_BUDGET');contractSymbol(budget.symbol);units(budget.usedAmount);}
  if(state.hedgeLock&&(state.hedgeLock.active!==true||!moment(state.hedgeLock.since)))throw new Error('INVALID_MANUAL_HEDGE_LOCK');
  // Read-only compatibility for integrations that show a single owned leg.
  // The aliases are not serialized and cannot become a second source of truth.
  for(const [alias,field] of [['position','positions'],['protection','protections']])if(!Object.getOwnPropertyDescriptor(state,alias))Object.defineProperty(state,alias,{enumerable:false,configurable:true,get(){const rows=Object.values(this[field]).filter(Boolean);return rows.length===1?rows[0]:null;}});
  return state;
}

export function nativeWalletsAt(state,time=Infinity){
  const totals=Object.fromEntries(Object.entries(state.initialWallets).map(([key,value])=>[key,signedUnits(value)]));
  const add=(key,value)=>{totals[key]=(totals[key]??0n)+value;};
  for(const fill of state.fills)if(fill.time<time){add(fill.market+'.'+fill.marginAsset,signedUnits(fill.realizedPnl));add(fill.market+'.'+fill.commissionAsset,-signedUnits(fill.commission));}
  for(const event of state.funding)if(event.time<time)add(event.wallet,signedUnits(event.amount));
  for(const event of state.externalIncome??[])if(event.time<time)add(event.wallet,signedUnits(event.amount));
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
export function incomeCursor(state,market,scope){
  if(!['USD_M','COIN_M'].includes(market))throw new Error('INVALID_FUTURES_INCOME_CURSOR');
  return scope?(state.externalIncomeThrough?.[market]??state.createdAt-1):state.incomeThrough[market];
}

// The position immediately before the funding timestamp determines who received it.
// Keep a per-symbol timeline so replaying several weeks of overlapping income is bounded.
function ownedFundingHistory(fills,market){
  const histories=new Map();
  for(const fill of fills.filter(fill=>fill.market===market).sort((a,b)=>a.time-b.time)){
    const history=histories.get(fill.symbol)??[],previous=history.at(-1);
    const delta=units(fill.quantity)*(fill.effect==='OPEN'?1n:-1n);
    const quantity=(previous?.quantity??0n)+delta;
    if(quantity<0n)throw new Error('INVALID_HISTORICAL_POSITION');
    if(previous?.time===fill.time)previous.quantity=quantity;
    else history.push({time:fill.time,quantity});
    histories.set(fill.symbol,history);
  }
  return histories;
}
function botHeldAt(history,time){
  let low=0,high=history?.length??0;
  while(low<high){
    const middle=Math.floor((low+high)/2);
    if(history[middle].time<time)low=middle+1;
    else high=middle;
  }
  return low>0&&history[low-1].quantity>0n;
}
function reconcileIncome(state,market,rows,through,scope){
  if(!['USD_M','COIN_M'].includes(scope.market)||!incomeSymbol(scope.symbol)||!Array.isArray(rows)||!Number.isSafeInteger(through)||through<incomeCursor(state,market,scope))throw new Error('COMPLETE_FUNDING_HISTORY_REQUIRED');
  const next=structuredClone(state);
  const funding=new Map(next.funding.map(event=>[event.key,event]));
  const external=new Map((next.externalIncome??[]).map(event=>[event.key,event]));
  const fills=new Map(next.fills.map(fill=>[fill.key,fill]));
  const histories=ownedFundingHistory(next.fills,market);
  for(const row of rows){
    if(!row||!moment(row.time)||row.time<state.createdAt||row.time>through||!asset(row.asset))throw new Error('INVALID_EXCHANGE_INCOME');
    const value=signedUnits(row.income);
    if(!externalTypes.has(row.incomeType)){
      if(value!==0n)throw new Error('UNRECONCILED_FUTURES_CASH_FLOW');
      continue;
    }
    if(!incomeSymbol(row.symbol)||!exchangeId(row.tranId))throw new Error('INVALID_EXCHANGE_INCOME');
    const type=row.incomeType,key=market+':'+type+':'+row.tranId;
    const entry={key,wallet:market+'.'+row.asset,symbol:row.symbol,amount:decimal(value),time:row.time};
    const priorFunding=funding.get(key);
    if(priorFunding&&JSON.stringify(priorFunding)!==JSON.stringify(entry))throw new Error('FUNDING_HISTORY_CHANGED');
    const tradeId=row.tradeId===undefined||row.tradeId===''||row.tradeId===null?null:String(row.tradeId);
    if(tradeId!==null&&!exchangeId(row.tradeId))throw new Error('INVALID_EXCHANGE_INCOME');
    const event={...entry,type,tradeId};
    const priorExternal=external.get(key);
    if(priorExternal){
      if(JSON.stringify(priorExternal)!==JSON.stringify(event))throw new Error('EXTERNAL_INCOME_HISTORY_CHANGED');
      continue;
    }
    const history=histories.get(row.symbol);
    if(type==='FUNDING_FEE'){
      if(botHeldAt(history,row.time)){funding.set(key,entry);continue;}
      // Older builds put every funding payment in the bot report. Reclassify on replay.
      funding.delete(key);
    }else{
      const own=tradeId===null?null:fills.get(market+':'+row.symbol+':'+tradeId);
      if(own){
        const commission=type==='COMMISSION';
        if(row.asset!==(commission?own.commissionAsset:own.marginAsset)||value!==(commission?-signedUnits(own.commission):signedUnits(own.realizedPnl)))throw new Error('FUTURES_INCOME_DIFFERS_FROM_OWNED_FILL');
        continue; // Owned executions already booked the actual commission and realized PNL.
      }
      const pending=state.pending;
      const awaitingFill=pending?.market===market&&pending.args?.symbol===row.symbol&&row.time>=pending.createdAt;
      const isSelected=scope.market===market&&scope.symbol===row.symbol;
      if(awaitingFill||botHeldAt(history,row.time)||(tradeId===null&&(isSelected||history?.length)))throw new Error('UNRECONCILED_MANUAL_FILL_ON_MANAGED_CONTRACT');
    }
    external.set(key,event);
  }
  next.funding=[...funding.values()];
  next.externalIncome=[...external.values()];
  next.incomeThrough[market]=Math.max(next.incomeThrough[market],through);
  next.externalIncomeThrough={...next.externalIncomeThrough,[market]:through};
  return validateLedger(next);
}
export function addFunding(state,market,rows,through,scope){
  if(scope)return reconcileIncome(state,market,rows,through,scope);
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
  const linkedProtection=intent==='PROTECTION_CLOSE'&&ownAlgoId(pending.protectionId)&&state.protections[direction]?.id===pending.protectionId&&pending.exchangeOrderId===order.orderId;
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
      const old=next.positions[direction];
      if(fills.some(row=>signedUnits(row.realizedPnl)!==0n)||(old&&(!pending.allowLockIncrease||!next.hedgeLock?.active||args.positionSide!==direction||old.symbol!==args.symbol||old.market!==market)))throw new Error('OPEN_REQUIRES_FLAT_OWNED_LEG');
      const combined=old?[{quantity:old.quantity,price:old.entryPrice},...fills]:fills;
      next.positions[direction]={market,symbol:args.symbol,direction,positionSide:args.positionSide,quantity:decimal(executed+(old?units(old.quantity):0n)),entryPrice:entryFromFills(combined,market,rules.contractSize),contractSize:rules.contractSize,marginAsset:rules.marginAsset,openedAt:old?.openedAt??Math.min(...fills.map(row=>row.time)),risk:old?.risk??pending.risk,peakReturnPercent:old?.peakReturnPercent??0};
    }else{
      const owned=next.positions[direction];
      if(!owned||owned.market!==market||owned.symbol!==args.symbol||owned.direction!==direction||owned.positionSide!==args.positionSide||executed>units(owned.quantity))throw new Error('CLOSE_CANNOT_REVERSE_OR_USE_UNOWNED_POSITION');
      const remaining=units(owned.quantity)-executed;next.positions[direction]=remaining?{...owned,quantity:decimal(remaining)}:null;
    }
  }
  const maker=args.timeInForce==='GTX';
  if(maker&&(!intent.startsWith('OPEN_')||state.positions[direction]))throw new Error('MAKER_REQUIRES_FLAT_OWNED_LEG');
  next.fills.push(...fills);next.orders.push({id:pending.id,orderId:order.orderId,market,symbol:args.symbol,intent,side:args.side,positionSide:args.positionSide,quantity:decimal(executed),status:order.status,time:fills.length?Math.max(...fills.map(row=>row.time)):pending.createdAt,...(maker?{timeInForce:'GTX'}:{})});next.pending=null;
  if(maker&&executed)next.makerProtectionDue=pending.id;
  else if(executed&&intent.startsWith('CLOSE_')&&state.makerProtectionDue&&state.orders.find(o=>o.id===state.makerProtectionDue)?.intent==='OPEN_'+direction)next.makerProtectionDue=null;
  return validateLedger(next);
}
