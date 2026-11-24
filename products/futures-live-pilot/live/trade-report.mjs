import {decimal,units,signedUnits,absolute,SCALE,pnl,collateralValue} from './math.mjs';

const rowLimit=50;
const contractKey=(market,symbol)=>market+':'+symbol;
const exchangeOrderKey=row=>contractKey(row.market,row.symbol)+':'+row.orderId;
const currency=name=>typeof name==='string'&&/^[A-Z0-9]{1,24}$/.test(name);
const money=()=>new Map();
const credit=(m,asset,amount)=>m.set(asset,(m.get(asset)??0n)+amount);
const amounts=m=>Object.fromEntries([...m].sort(([a],[b])=>a.localeCompare(b)).map(([a,v])=>[a,decimal(v)]));
const zero=asset=>new Map([[asset,0n]]);
function addCurrencies(target,source,sign=1n){
  for(const [asset,value] of source)credit(target,asset,sign*value);
  return target;
}
function quoteUnits(market,symbol){
  if(market==='COIN_M')return {quantityUnit:'contracts',quoteAsset:'USD'};
  const quoteAsset=['USDT','USDC'].find(quote=>symbol.endsWith(quote))??null;
  return {quantityUnit:quoteAsset?symbol.slice(0,-quoteAsset.length):null,quoteAsset};
}
function newExecutions(){
  return {quantity:0n,weighted:0n,singlePrice:null,fees:money(),feesComplete:true,gross:0n,grossComplete:true};
}
function recordExecution(summary,fill){
  const quantity=units(fill.quantity),price=units(fill.price);
  if(!quantity||!price)throw new Error('INVALID_REPORT_EXECUTION');
  if(!summary.quantity)summary.singlePrice=price;
  else if(summary.singlePrice!==price)summary.singlePrice=null;
  summary.quantity+=quantity;
  // A linear contract uses a quantity-weighted arithmetic mean. Inverse
  // contracts use the reciprocal mean because their cash flows settle in coin.
  summary.weighted+=fill.market==='USD_M'?quantity*price:quantity*SCALE*SCALE*SCALE/price;
  if(typeof fill.realizedPnl==='string')summary.gross+=signedUnits(fill.realizedPnl);
  else summary.grossComplete=false;
  if(currency(fill.commissionAsset)&&typeof fill.commission==='string')credit(summary.fees,fill.commissionAsset,signedUnits(fill.commission));
  else summary.feesComplete=false;
}
function average(summary,market){
  if(!summary.quantity||!summary.weighted)return null;
  return decimal(summary.singlePrice??(market==='USD_M'?summary.weighted/summary.quantity:summary.quantity*SCALE*SCALE*SCALE/summary.weighted));
}
function feeOutput(summary){
  return summary.quantity>0n&&summary.feesComplete?amounts(summary.fees):null;
}
function finishOrder(order,summary){
  const direction=order.intent?.endsWith('_LONG')?'LONG':order.intent?.endsWith('_SHORT')?'SHORT':order.side==='BUY'?'SHORT':'LONG';
  const filled=!!summary&&summary.quantity>0n&&summary.quantity===units(order.quantity);
  const marginAsset=summary?.asset??null,gross=filled&&summary.grossComplete?summary.gross:null;
  const fees=filled?feeOutput(summary):null;
  const net=fees&&gross!==null&&currency(marginAsset)?amounts(addCurrencies(new Map([[marginAsset,gross]]),summary.fees,-1n)):null;
  return {id:order.id,time:order.time,market:order.market,symbol:order.symbol,direction,intent:order.intent,status:order.status,
    quantity:order.quantity,...quoteUnits(order.market,order.symbol),averagePrice:filled?average(summary,order.market):null,
    marginAsset,gross:gross===null?null:decimal(gross),fees,netExFunding:net};
}
function historyOf(state){
  const byOrder=new Map(),byContract=new Map(),closed=[],unattributedFunding=[];
  const timeline=[];
  for(const [type,rows] of [['fill',state.fills],['funding',state.funding]]){
    const unique=new Map();
    for(const row of rows??[]){
      const prior=unique.get(row.key);
      if(prior){
        if(JSON.stringify(prior)!==JSON.stringify(row))throw new Error('CONFLICTING_TRADE_HISTORY');
        continue;
      }
      unique.set(row.key,row);
      timeline.push({time:row.time,[type]:row});
    }
  }
  // Funding belongs to the position immediately before settlement. Fills at
  // the exact settlement timestamp are applied afterwards, as in the ledger.
  timeline.sort((a,b)=>a.time-b.time||Number(!!b.funding)-Number(!!a.funding));
  for(const item of timeline){
    if(item.funding){
      const event=item.funding,[market,asset]=event.wallet.split('.');
      const hasSymbol=typeof event.symbol==='string'&&event.symbol.length>0;
      const candidates=hasSymbol?[...(byContract.get(contractKey(market,event.symbol))?.values()??[])]:
        [...byContract.values()].flatMap(legs=>[...legs.values()].filter(c=>c.market===market&&c.asset===asset));
      const value=signedUnits(event.amount);
      if(hasSymbol&&candidates.length===1)credit(candidates[0].funding,asset,value);
      else{
        for(const cycle of candidates)cycle.ambiguous=true;
        unattributedFunding.push({market,symbol:event.symbol??null,asset,amount:decimal(value),time:event.time});
      }
      continue;
    }
    const fill=item.fill,key=contractKey(fill.market,fill.symbol),orderKey=exchangeOrderKey(fill);
    let order=byOrder.get(orderKey);
    if(!order){order=newExecutions();order.asset=fill.marginAsset;byOrder.set(orderKey,order);}
    recordExecution(order,fill);
    let legs=byContract.get(key);
    if(!legs){legs=new Map();byContract.set(key,legs);}
    let cycle=legs.get(fill.direction);
    if(!cycle){
      if(fill.effect!=='OPEN')throw new Error('INCOMPLETE_POSITION_CYCLE');
      cycle={id:fill.key,market:fill.market,symbol:fill.symbol,direction:fill.direction,asset:fill.marginAsset,openedAt:fill.time,
        opened:newExecutions(),closed:newExecutions(),funding:zero(fill.marginAsset),ambiguous:false};
      legs.set(fill.direction,cycle);
    }
    if(fill.marginAsset!==cycle.asset)throw new Error('INCONSISTENT_CYCLE_SETTLEMENT');
    recordExecution(fill.effect==='OPEN'?cycle.opened:cycle.closed,fill);
    if(cycle.closed.quantity>cycle.opened.quantity)throw new Error('INCOMPLETE_POSITION_CYCLE');
    if(cycle.closed.quantity===cycle.opened.quantity){
      cycle.closedAt=fill.time;closed.push(cycle);legs.delete(fill.direction);
      if(!legs.size)byContract.delete(key);
    }
  }
  const orders=[...(state.orders??[])].reverse().sort((a,b)=>b.time-a.time).slice(0,rowLimit)
    .map(o=>finishOrder(o,byOrder.get(exchangeOrderKey(o))));
  return {orders,closed:closed.slice(-rowLimit).reverse(),byContract,unattributedFunding:unattributedFunding.slice(-rowLimit).reverse()};
}
function closedReport(cycle,through){
  const {opened,closed,asset,market}=cycle;
  const gross=opened.grossComplete&&closed.grossComplete?opened.gross+closed.gross:null;
  const fundingKnown=!cycle.ambiguous&&Number.isSafeInteger(through)&&through>=cycle.closedAt;
  let net=null;
  if(fundingKnown&&gross!==null&&opened.feesComplete&&closed.feesComplete){
    const result=new Map([[asset,gross]]);
    addCurrencies(result,opened.fees,-1n);addCurrencies(result,closed.fees,-1n);addCurrencies(result,cycle.funding);
    net=amounts(result);
  }
  return {id:cycle.id,market,symbol:cycle.symbol,direction:cycle.direction,openedAt:cycle.openedAt,closedAt:cycle.closedAt,
    quantity:decimal(opened.quantity),entryPrice:average(opened,market),exitPrice:average(closed,market),...quoteUnits(market,cycle.symbol),marginAsset:asset,
    gross:gross===null?null:decimal(gross),openFees:feeOutput(opened),closeFees:feeOutput(closed),funding:fundingKnown?amounts(cycle.funding):null,
    fundingThrough:through??null,net};
}
function positionReport(position,cycle,through,snapshot){
  const {market,symbol,direction,quantity,marginAsset,entryPrice,contractSize}=position;
  const matched=cycle&&cycle.opened.quantity-cycle.closed.quantity===units(quantity)&&cycle.openedAt===position.openedAt;
  let unrealized=null,estimatedCloseFee=null,markedAt=null;
  if(snapshot?.market===market&&snapshot.symbol===symbol&&snapshot.checkedAt>=position.openedAt&&snapshot.markPrice&&units(snapshot.markPrice)>0n){
    const mark=snapshot.markPrice;
    unrealized=pnl({market,side:direction,quantity,entryPrice,exitPrice:mark,contractSize});markedAt=snapshot.checkedAt;
    if(typeof snapshot.feeRates?.taker==='string'){
      const native=units(collateralValue({market,quantity,price:mark,contractSize})),rate=signedUnits(snapshot.feeRates.taker);
      const fee=(native*absolute(rate)+SCALE-1n)/SCALE;
      estimatedCloseFee=decimal(rate<0n?-fee:fee);
    }
  }
  const paidFees=matched&&cycle.opened.feesComplete&&cycle.closed.feesComplete?amounts(addCurrencies(new Map(cycle.opened.fees),cycle.closed.fees)):null;
  const funding=matched&&!cycle.ambiguous&&Number.isSafeInteger(through)&&through>=cycle.openedAt?amounts(cycle.funding):null;
  return {market,symbol,direction,quantity,marginAsset,entryPrice,...quoteUnits(market,symbol),unrealized,paidFees,funding,fundingThrough:through??null,estimatedCloseFee,markedAt};
}
function reportFrom(state,snapshot,history){
  const through=state.incomeThrough??{},positions={LONG:null,SHORT:null};
  for(const p of Object.values(state.positions??{})){
    if(!p)continue;
    const cycle=history.byContract.get(contractKey(p.market,p.symbol))?.get(p.direction);
    positions[p.direction]=positionReport(p,cycle,through[p.market],snapshot);
  }
  return {orders:history.orders,roundTrips:history.closed.map(cycle=>closedReport(cycle,through[cycle.market])),positions,unattributedFunding:history.unattributedFunding};
}
export function futuresTradeReport(state,snapshot=null){
  return reportFrom(state,snapshot,historyOf(state));
}
// Used only when displaying a workspace snapshot. The trading loop never
// depends on report generation, and repeated UI polling reuses history.
export function createFuturesTradeReporter(){
  let fills,orders,funding,history;
  return (state,snapshot=null)=>{
    if(!state)return null;
    try{
      if(!history||fills!==state.fills||orders!==state.orders||funding!==state.funding){
        history=historyOf(state);fills=state.fills;orders=state.orders;funding=state.funding;
      }
      return reportFrom(state,snapshot,history);
    }catch{
      return {orders:[],roundTrips:[],positions:{LONG:null,SHORT:null},unattributedFunding:[],error:'FUTURES_TRADE_REPORT_UNAVAILABLE'};
    }
  };
}
