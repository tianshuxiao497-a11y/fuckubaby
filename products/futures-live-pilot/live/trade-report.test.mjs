import assert from 'node:assert/strict';
import test from 'node:test';
import {createFuturesTradeReporter,futuresTradeReport} from './trade-report.mjs';

const defaults={market:'USD_M',symbol:'BTCUSDT',marginAsset:'USDT',commissionAsset:'USDT',contractSize:'1'};
const inverse={market:'COIN_M',symbol:'BTCUSD_PERP',marginAsset:'BTC',commissionAsset:'BTC',contractSize:'100'};
function fill(id,time,effect,options={}){
  const row={...defaults,orderId:id,time,effect,direction:'LONG',quantity:'1',price:'100',
    realizedPnl:'0',commission:'0.01',...options};
  return {...row,key:row.market+':'+row.symbol+':'+id};
}
function order(fill,quantity,options={}){
  const opening=fill.effect==='OPEN',buy=opening===(fill.direction==='LONG');
  return {id:'local-'+fill.orderId,orderId:fill.orderId,market:fill.market,symbol:fill.symbol,
    intent:fill.effect+'_'+fill.direction,side:buy?'BUY':'SELL',status:'FILLED',quantity,time:fill.time,...options};
}
function funding(time,amount,options={}){
  return {key:'funding-'+time,time,amount,wallet:'USD_M.USDT',symbol:'BTCUSDT',...options};
}
function ledger(fills,options={}){
  return {fills,orders:[],funding:[],incomeThrough:{USD_M:100,COIN_M:100},positions:{LONG:null,SHORT:null},...options};
}
function position(open,options={}){
  const {market,symbol,direction,quantity,marginAsset,contractSize,time,price}=open;
  return {market,symbol,direction,quantity,marginAsset,contractSize,openedAt:time,entryPrice:price,...options};
}

test('groups partial fills and protection close by exchange order, ignoring manual account income',()=>{
  const entry=fill(1,10,'OPEN',{price:'100',quantity:'1',commission:'0.03'});
  const more=fill(2,11,'OPEN',{orderId:1,price:'103',quantity:'2',commission:'0.04'});
  const close=fill(3,30,'CLOSE',{price:'105',quantity:'3',realizedPnl:'9',commission:'0.05'});
  const orders=[order(entry,'3',{time:11}),order(close,'3',{intent:'PROTECTION_CLOSE'}),
    order(close,'0',{id:'expired',orderId:4,status:'EXPIRED',time:35})];
  const state=ledger([entry,more,close,structuredClone(close)],{orders,funding:[funding(20,'-0.2'),
    funding(21,'90',{symbol:'ETHUSDT'})],externalIncome:[funding(23,'80')]});
  const report=futuresTradeReport(state);
  assert.deepEqual(report.orders.map(r=>r.id),['expired','local-3','local-1']);
  assert.equal(report.orders[0].averagePrice,null);
  assert.equal(report.orders[0].fees,null);
  assert.equal(report.orders[1].direction,'LONG');
  assert.equal(report.orders[1].gross,'9');
  assert.deepEqual(report.orders[1].netExFunding,{USDT:'8.95'});
  assert.equal(report.orders[2].averagePrice,'102');
  const [round]=report.roundTrips;
  assert.equal(round.quantity,'3');
  assert.equal(round.entryPrice,'102');
  assert.equal(round.exitPrice,'105');
  assert.equal(round.quantityUnit,'BTC');
  assert.deepEqual(round.openFees,{USDT:'0.07'});
  assert.deepEqual(round.closeFees,{USDT:'0.05'});
  assert.deepEqual(round.funding,{USDT:'-0.2'});
  assert.deepEqual(round.net,{USDT:'8.68'});
  assert.deepEqual(report.unattributedFunding.map(e=>e.symbol),['ETHUSDT']);
});

test('at the exact funding timestamp, old position receives the funding before closing; new entry does not',()=>{
  const a=fill(1,5,'OPEN'),b=fill(2,15,'CLOSE');
  const c=fill(3,15,'OPEN',{direction:'SHORT'}),d=fill(4,25,'CLOSE',{direction:'SHORT'});
  const report=futuresTradeReport(ledger([a,b,c,d],{funding:[funding(5,'30'),funding(15,'0.7'),funding(25,'-0.3')]}));
  const [short,long]=report.roundTrips;
  assert.deepEqual(long.funding,{USDT:'0.7'});
  assert.deepEqual(short.funding,{USDT:'-0.3'});
  assert.deepEqual(report.unattributedFunding.map(r=>r.time),[5]);
});

test('a funding payment combined across hedge legs has unknown attribution even when the aggregate is zero',()=>{
  const a=fill(1,1,'OPEN'),b=fill(2,4,'OPEN',{direction:'SHORT'});
  const c=fill(3,7,'CLOSE'),d=fill(4,8,'CLOSE',{direction:'SHORT'});
  for(const amount of ['0','-0.42']){
    const report=futuresTradeReport(ledger([a,b,c,d],{funding:[funding(5,amount)]}));
    assert.equal(report.roundTrips.length,2);
    assert.ok(report.roundTrips.every(r=>r.funding===null&&r.net===null));
    assert.equal(report.unattributedFunding[0].amount,amount);
  }
  const missingSymbol=futuresTradeReport(ledger([a,c],{funding:[funding(5,'3',{symbol:null})]}));
  assert.equal(missingSymbol.roundTrips[0].net,null);
  assert.equal(missingSymbol.unattributedFunding.length,1);
});

test('a partial close keeps the cycle open; actual cumulative fees and projected taker cost are separate',()=>{
  const a=fill(1,1,'OPEN',{quantity:'3'}),b=fill(2,2,'CLOSE',{price:'105',realizedPnl:'5',commission:'0.02'});
  const c=fill(3,3,'OPEN',{direction:'SHORT',price:'110',commission:'0'});
  const state=ledger([a,b,c],{positions:{LONG:position(a,{quantity:'2'}),SHORT:position(c)}});
  const snapshot={market:'USD_M',symbol:'BTCUSDT',checkedAt:4,markPrice:'107',feeRates:{taker:'0.0005'}};
  const report=futuresTradeReport(state,snapshot);
  assert.equal(report.roundTrips.length,0);
  const long=report.positions.LONG,short=report.positions.SHORT;
  assert.equal(long.unrealized,'14');assert.equal(long.estimatedCloseFee,'0.107');
  assert.deepEqual(long.paidFees,{USDT:'0.03'});
  assert.equal(short.unrealized,'3');assert.equal(short.estimatedCloseFee,'0.0535');
  assert.deepEqual(short.paidFees,{USDT:'0'});
  assert.equal(futuresTradeReport(state,null).positions.LONG.unrealized,null);
  assert.equal(futuresTradeReport(state,{...snapshot,symbol:'ETHUSDT'}).positions.LONG.estimatedCloseFee,null);
  assert.equal(futuresTradeReport(state,{...snapshot,checkedAt:2}).positions.SHORT.unrealized,null);
});

test('coin-margined realized and open PnL stay in BTC, commission rebates in other assets stay separate',()=>{
  const a=fill(1,1,'OPEN',{...inverse,price:'40000',commission:'0.000001'});
  const b=fill(2,4,'CLOSE',{...inverse,price:'50000',realizedPnl:'0.0005',commissionAsset:'BNB',commission:'-0.000002'});
  const state=ledger([a,b],{orders:[order(a,'1'),order(b,'1')]});
  const [cycle]=futuresTradeReport(state).roundTrips;
  assert.equal(cycle.quantityUnit,'contracts');assert.equal(cycle.quoteAsset,'USD');
  assert.equal(cycle.gross,'0.0005');assert.deepEqual(cycle.closeFees,{BNB:'-0.000002'});
  assert.deepEqual(cycle.net,{BTC:'0.000499',BNB:'0.000002'});
  const onlyOpen=ledger([a],{positions:{LONG:position(a),SHORT:null}});
  const {LONG}=futuresTradeReport(onlyOpen,{market:a.market,symbol:a.symbol,checkedAt:2,markPrice:'50000',feeRates:{taker:'0.0005'}}).positions;
  assert.equal(LONG.unrealized,'0.0005');assert.equal(LONG.estimatedCloseFee,'0.000001');
});

test('inverse fills use a harmonic mean, funding and net become available only once income is covered',()=>{
  const a=fill(1,10,'OPEN',{...inverse,price:'30000'});
  const b=fill(2,11,'OPEN',{...inverse,price:'60000',orderId:1});
  const c=fill(3,20,'CLOSE',{...inverse,quantity:'2',price:'40000'});
  const state=ledger([a,b,c],{orders:[order(a,'2')],incomeThrough:{COIN_M:19}});
  const report=createFuturesTradeReporter();
  assert.equal(report(state).orders[0].averagePrice,'40000');
  assert.equal(report(state).roundTrips[0].funding,null);
  assert.equal(report(state).roundTrips[0].net,null);
  const updated=report({...state,incomeThrough:{COIN_M:20}}).roundTrips[0];
  assert.deepEqual(updated.funding,{BTC:'0'});assert.deepEqual(updated.net,{BTC:'-0.03'});
});

test('unknown fee or incompatible records cannot produce an exact net; read-only failure retains control of the engine',()=>{
  const a=fill(1,1,'OPEN',{commission:undefined}),b=fill(2,2,'CLOSE');
  const state=ledger([a,b],{orders:[order(a,'1'),order(b,'2')]});
  const report=futuresTradeReport(state);
  assert.equal(report.orders[0].fees,null);assert.equal(report.orders[1].fees,null);
  assert.equal(report.roundTrips[0].openFees,null);assert.equal(report.roundTrips[0].net,null);
  const broken=createFuturesTradeReporter()(ledger([a,{...a,price:'200'}]));
  assert.equal(broken.error,'FUTURES_TRADE_REPORT_UNAVAILABLE');
  assert.deepEqual(broken.orders,[]);
});
