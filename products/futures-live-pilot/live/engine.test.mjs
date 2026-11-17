import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FuturesEngine} from './engine.mjs';
import {FUTURES_CONFIRMATION,SETTINGS_CONFIRMATION} from './client.mjs';
import {units,signedUnits,decimal,multiply,pnl} from './math.mjs';
const initialTime=Date.UTC(2026,10,17,13);
async function fixture(t,{market='USD_M',direction='LONG',hedge=false,timeout=false,reject=false,unmanaged=false,algoUnsupported=false}={}){
  const profile=await mkdtemp(join(tmpdir(),'asbf-engine-'));let clock=initialTime,forceClose=false,sequence=100,protection=null,collateralPrice='10000';
  const cash={USD_M:{USDT:market==='USD_M'?'1000':'0'},COIN_M:{BTC:market==='COIN_M'?'0.1':'0'}};
  const orders=new Map(),fills=new Map(),positions={USD_M:null,COIN_M:null},income={USD_M:[],COIN_M:[]},calls=[];
  const config={USD_M:{leverage:10,marginMode:'ISOLATED'},COIN_M:{leverage:10,marginMode:'ISOLATED'}};
  if(unmanaged)positions.USD_M={symbol:'BTCUSDT',direction:'LONG',quantity:'1',entryPrice:'10000',positionSide:hedge?'LONG':'BOTH'};
  const symbolOf=kind=>kind==='USD_M'?'BTCUSDT':'BTCUSD_PERP';
  function catalog(kind){return {symbols:[{symbol:symbolOf(kind),status:'TRADING',contractStatus:'TRADING',contractType:'PERPETUAL',underlyingType:'COIN',baseAsset:'BTC',quoteAsset:kind==='USD_M'?'USDT':'USD',marginAsset:kind==='USD_M'?'USDT':'BTC',contractSize:100,orderTypes:['LIMIT','MARKET'],filters:[{filterType:'LOT_SIZE',minQty:kind==='USD_M'?'0.001':'1',maxQty:'100000',stepSize:kind==='USD_M'?'0.001':'1'},{filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'10000000',tickSize:'0.1'},...(kind==='USD_M'?[{filterType:'MIN_NOTIONAL',notional:'5'}]:[])]}]};}
  function positionRows(kind){const p=positions[kind],side=hedge?(p?.direction??'LONG'):'BOTH';return [{symbol:symbolOf(kind),positionAmt:p?(p.direction==='SHORT'?'-':'')+p.quantity:'0',positionSide:side,entryPrice:p?.entryPrice??'0',markPrice:'10000',liquidationPrice:'0',leverage:String(config[kind].leverage),marginType:config[kind].marginMode.toLowerCase(),isAutoAddMargin:'false'}];}
  const clients={};
  for(const kind of ['USD_M','COIN_M'])clients[kind]={
    market:kind,armed:false,settings:false,arm(value){assert.equal(value,FUTURES_CONFIRMATION);this.armed=true;},armSettings(value){assert.equal(value,SETTINGS_CONFIRMATION);this.settings=true;},disarm(){this.armed=false;this.settings=false;},async syncTime(){return clock;},serverNow(){return clock;},
    async request(name,args={}){
      calls.push({kind,name,args:structuredClone(args)});
      if(name==='account')return {canTrade:true,assets:Object.entries(cash[kind]).map(([asset,walletBalance])=>({asset,walletBalance,unrealizedProfit:positions[kind]?pnl({market:kind,side:positions[kind].direction,quantity:positions[kind].quantity,entryPrice:positions[kind].entryPrice,exitPrice:'10000',contractSize:kind==='USD_M'?'1':'100'}):'0'}))};
      if(name==='balances')return Object.entries(cash[kind]).map(([asset,balance])=>({asset,balance,availableBalance:balance,accountAlias:kind+'-same-owner'}));
      if(name==='positions')return positionRows(kind);
      if(name==='positionMode')return {dualSidePosition:hedge};if(name==='multiAssets')return {multiAssetsMargin:false};
      if(name==='openOrders')return [];
      if(name==='openAlgos')return protection?.market===kind&&protection.algoStatus==='NEW'?[structuredClone(protection)]:[];
      if(name==='catalog')return catalog(kind);
      if(name==='book')return {symbol:args.symbol,bidPrice:'9999',askPrice:'10000',bidQty:'10',askQty:'10'};
      if(name==='mark')return {symbol:args.symbol,markPrice:'10000',lastFundingRate:'0.0001',nextFundingTime:clock+3600000};
      if(name==='fees')return {symbol:args.symbol,makerCommissionRate:'0.0002',takerCommissionRate:'0.0005'};
      if(name==='brackets')return [{symbol:args.symbol,brackets:[{initialLeverage:20,notionalCap:1000000,qtyCap:100,maintMarginRatio:0.004}]}];
      if(name==='symbolConfig')return [{symbol:args.symbol,leverage:config[kind].leverage,marginType:config[kind].marginMode,isAutoAddMargin:false}];
      if(name==='candles')return Array.from({length:100},(_,i)=>{const time=Math.floor(clock/60000)*60000-(100-i)*60000;return [time,'10000','10005','9995','10000','100',time+59999];});
      if(name==='collateralPrice')return {symbol:args.symbol,price:collateralPrice};
      if(name==='collateralCandles'||name==='markCandles')return [[args.startTime,'10000']];
      if(name==='income')return income[kind].filter(e=>e.time>=args.startTime&&e.time<=args.endTime);
      if(name==='order'){
        const row=args.orderId?[...orders.values()].find(r=>r.orderId===args.orderId):orders.get(args.origClientOrderId);
        if(!row){const error=new Error('not found');error.binanceCode=-2013;throw error;}return structuredClone(row);
      }
      if(name==='trades')return structuredClone(fills.get(args.orderId)??[]);
      if(name==='newOrder'){
        assert.equal(this.armed,true);const saved=JSON.parse(await readFile(join(profile,'futures-ledger.json'),'utf8'));assert.equal(saved.pending.id,args.newClientOrderId);
        if(reject){const error=new Error('rejected');error.binanceCode=-2019;error.definitiveRejection=true;throw error;}
        const close=args.reduceOnly==='true'||(args.positionSide==='LONG'&&args.side==='SELL')||(args.positionSide==='SHORT'&&args.side==='BUY');
        const old=positions[kind],side=close?old.direction:(args.side==='BUY'?'LONG':'SHORT'),size=kind==='USD_M'?'1':'100',price=args.price??'10000';
        const profit=close?pnl({market:kind,side,quantity:args.quantity,entryPrice:old.entryPrice,exitPrice:price,contractSize:size}):'0';
        const value=kind==='USD_M'?multiply(units(args.quantity),units(price)):units(args.quantity)*units(size)/units(price),fee=decimal(multiply(value,units('0.0005'))),asset=kind==='USD_M'?'USDT':'BTC';
        cash[kind][asset]=decimal(signedUnits(cash[kind][asset])+signedUnits(profit)-units(fee));
        positions[kind]=close?null:{symbol:args.symbol,direction:side,quantity:args.quantity,entryPrice:price,positionSide:args.positionSide};
        const number=++sequence,row={...args,clientOrderId:args.newClientOrderId,orderId:number,origQty:args.quantity,executedQty:args.quantity,status:'FILLED'};
        orders.set(args.newClientOrderId,row);fills.set(number,[{symbol:args.symbol,orderId:number,id:number,side:args.side,positionSide:args.positionSide,qty:args.quantity,price,commission:fee,commissionAsset:asset,realizedPnl:profit,time:clock}]);
        if(timeout)throw new Error('ORDER_RESULT_UNKNOWN');return {orderId:number};
      }
      if(name==='newProtection'){assert.equal(this.armed,true);protection={...args,market:kind,algoId:++sequence,algoStatus:'NEW',orderType:args.type,reduceOnly:args.reduceOnly==='true',actualOrderId:0};return {algoId:protection.algoId};}
      if(name==='algo'){if(algoUnsupported)throw new Error('UNSUPPORTED_ALGO_ROUTE');if(!protection||args.clientAlgoId!==protection.clientAlgoId){const error=new Error('not found');error.binanceCode=-2013;throw error;}return structuredClone(protection);}
      if(name==='cancelProtection'){assert.equal(this.armed,true);protection.algoStatus='CANCELED';return {code:200};}
      if(name==='setMargin'){assert.equal(this.settings,true);config[kind].marginMode=args.marginType;return {code:200};}
      if(name==='setLeverage'){assert.equal(this.settings,true);config[kind].leverage=args.leverage;return {leverage:args.leverage};}
      throw new Error('UNEXPECTED_FAKE_REQUEST_'+name);
    },
  };
  const settings={market,symbol:symbolOf(market),marginMode:'ISOLATED',leverage:10,marginPercent:2,directionMode:'both',dailyLossPercent:20,externalStrategy:null};
  const engine=new FuturesEngine({profile,clients,settings,now:()=>clock,signalFactory:({position})=>({intent:position?(forceClose?'CLOSE_'+position.direction:null):'OPEN_'+direction,reason:'FIXTURE_RESEARCH_ONLY',risk:{stopLossPercent:1,takeProfitPercent:2,trailingPercent:0},candles:[],values:{}})});
  await engine.acquire();t.after(async()=>{await engine.close();await rm(profile,{recursive:true,force:true});});
  return {engine,calls,clients,settings,advance:ms=>{clock+=ms;},collateralPrice:value=>{collateralPrice=value;},forceClose:()=>{forceClose=true;},async triggerStop(){
    const p=positions[market],a=protection,asset=market==='USD_M'?'USDT':'BTC',size=market==='USD_M'?'1':'100',price=a.triggerPrice;
    const profit=pnl({market,side:p.direction,quantity:p.quantity,entryPrice:p.entryPrice,exitPrice:price,contractSize:size});
    const value=market==='USD_M'?multiply(units(p.quantity),units(price)):units(p.quantity)*units(size)/units(price),fee=decimal(multiply(value,units('0.0005'))),id=++sequence;
    cash[market][asset]=decimal(signedUnits(cash[market][asset])+signedUnits(profit)-units(fee));positions[market]=null;
    const row={symbol:p.symbol,clientOrderId:'exchange-triggered-order',orderId:id,side:a.side,positionSide:p.positionSide,type:'MARKET',origQty:p.quantity,executedQty:p.quantity,status:'FILLED'};
    orders.set(String(id),row);fills.set(id,[{symbol:p.symbol,orderId:id,id,side:a.side,positionSide:p.positionSide,qty:p.quantity,price,commission:fee,commissionAsset:asset,realizedPnl:profit,time:clock}]);
    protection={...a,algoStatus:'FINISHED',actualOrderId:id};
  },fund(amount){const asset=market==='USD_M'?'USDT':'BTC';cash[market][asset]=decimal(signedUnits(cash[market][asset])+signedUnits(amount));income[market].push({incomeType:'FUNDING_FEE',symbol:settings.symbol,asset,income:amount,time:clock,tranId:String(++sequence)});}};
}
for(const market of ['USD_M','COIN_M'])for(const direction of ['LONG','SHORT'])test(market+' '+direction+' requires manual start, records entry before POST, installs exchange protection and closes owned position',async t=>{
  const f=await fixture(t,{market,direction}),snapshot=await f.engine.check();assert.equal(snapshot.plan.allocation.targetMarginUsdt,'20');assert.equal(f.calls.some(c=>c.name==='newOrder'),false);
  await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});
  assert.equal(f.engine.state.position.direction,direction);assert.ok(f.engine.state.protection);assert.equal(f.engine.state.orders.length,1);
  f.forceClose();await f.engine.check({execute:true});assert.equal(f.engine.state.position,null);assert.equal(f.engine.state.protection,null);assert.equal(f.engine.state.orders.length,2);
});
test('hedge mode uses the selected position side and never sends forbidden reduceOnly',async t=>{
  const f=await fixture(t,{direction:'SHORT',hedge:true});await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});
  const call=f.calls.find(c=>c.name==='newOrder');assert.equal(call.args.positionSide,'SHORT');assert.equal(call.args.reduceOnly,undefined);
  const stop=f.calls.find(c=>c.name==='newProtection');assert.equal(stop.args.side,'BUY');assert.equal(stop.args.positionSide,'SHORT');assert.equal(stop.args.reduceOnly,undefined);
});
test('lost entry response reconciles the original ID and never submits the opening a second time',async t=>{
  const f=await fixture(t,{timeout:true});await f.engine.start(FUTURES_CONFIRMATION);await assert.rejects(f.engine.check({execute:true}));
  assert.ok(f.engine.state.pending);assert.equal(f.engine.running,false);
  await f.engine.check();assert.equal(f.engine.state.pending,null);assert.ok(f.engine.state.position);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);
  await f.engine.start(FUTURES_CONFIRMATION);assert.ok(f.engine.state.protection);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);
});
test('a definitively rejected and confirmed absent order is recorded without permanently wedging the account',async t=>{
  const f=await fixture(t,{reject:true});await f.engine.start(FUTURES_CONFIRMATION);await assert.rejects(f.engine.check({execute:true}));await f.engine.check();
  assert.equal(f.engine.state.pending,null);assert.equal(f.engine.state.orders[0].status,'REJECTED');assert.equal(f.engine.state.position,null);
});
test('existing manual positions are read but never adopted, modified or sold',async t=>{
  const f=await fixture(t,{unmanaged:true});await assert.rejects(f.engine.check(),/UNMANAGED/);assert.equal(f.engine.state,null);assert.equal(f.calls.some(c=>['newOrder','newProtection','setMargin','setLeverage'].includes(c.name)),false);
});
test('daily USDT drawdown blocks new entries while an owned position can still be reduced and closed',async t=>{
  const f=await fixture(t);await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});f.advance(30000);f.fund('-201');f.forceClose();
  await f.engine.check({execute:true});assert.equal(f.engine.state.day.blocked,true);assert.equal(f.engine.state.position,null);assert.equal(f.engine.state.orders.length,2);
});
test('leverage/margin writes require a distinct confirmation and never change shared position mode',async t=>{
  const f=await fixture(t);f.engine.settings.leverage=5;f.engine.settings.marginMode='CROSSED';await assert.rejects(f.engine.applyContractSettings('yes'));
  await f.engine.applyContractSettings(SETTINGS_CONFIRMATION);assert.equal(f.engine.last.actualConfigurationMatches,true);assert.equal(f.engine.running,false);
  assert.equal(f.calls.filter(c=>c.name==='setMargin').length,1);assert.equal(f.calls.filter(c=>c.name==='setLeverage').length,1);assert.equal(f.calls.some(c=>c.name==='setPositionMode'),false);
});
for(const market of ['USD_M','COIN_M'])test(market+' confirmed exchange stop is linked to actual fills once, with native PNL and fees',async t=>{
  const f=await fixture(t,{market});await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});f.advance(20000);await f.triggerStop();await f.engine.check();
  assert.equal(f.engine.state.position,null);assert.equal(f.engine.state.protection,null);assert.equal(f.engine.state.orders.at(-1).intent,'PROTECTION_CLOSE');assert.equal(f.engine.state.fills.length,2);
  await f.engine.check();assert.equal(f.engine.state.fills.length,2);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);
});
test('unsupported COIN-M stop query blocks opening before any exchange mutation',async t=>{
  const f=await fixture(t,{market:'COIN_M',algoUnsupported:true});const value=await f.engine.check();assert.equal(value.plan,null);assert.equal(value.blocker,'EXCHANGE_PROTECTION_QUERY_UNAVAILABLE');
  await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});assert.equal(f.calls.some(c=>c.name.startsWith('new')),false);
});
test('manual owned market close requires exact confirmation and stops afterwards',async t=>{
  const f=await fixture(t,{direction:'SHORT',hedge:true});await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});
  await assert.rejects(f.engine.closeOwnedPosition('yes'));await f.engine.closeOwnedPosition(FUTURES_CONFIRMATION);
  assert.equal(f.engine.state.position,null);assert.equal(f.engine.running,false);const close=f.calls.filter(c=>c.name==='newOrder').at(-1);assert.equal(close.args.type,'MARKET');assert.equal(close.args.positionSide,'SHORT');assert.equal(close.args.side,'BUY');
});
test('stop during durable opening intent prevents POST and removes only the unsent intent',async t=>{
  const f=await fixture(t);await f.engine.start(FUTURES_CONFIRMATION);const commit=f.engine.commit.bind(f.engine);f.engine.commit=async state=>{await commit(state);if(state.pending?.kind==='ORDER')f.engine.stop();};
  await f.engine.check({execute:true});assert.equal(f.calls.some(c=>c.name==='newOrder'),false);assert.equal(f.engine.state.pending,null);
});
test('next UTC+8 midnight baseline is reconstructed from ledger and market history across restart',async t=>{
  const f=await fixture(t,{market:'COIN_M'});await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});f.advance(4*3600000);await f.engine.check();const baseline=f.engine.state.day.baselineUsdt;
  assert.equal(f.engine.state.day.firstDay,false);assert.ok(f.calls.some(c=>c.name==='markCandles'));await f.engine.close();await f.engine.acquire();await f.engine.check();assert.equal(f.engine.state.day.baselineUsdt,baseline);assert.ok(f.engine.state.position);
});
test('collateral coin depreciation alone triggers the same daily USDT-equity entry lock',async t=>{
  const f=await fixture(t,{market:'COIN_M'});await f.engine.check();f.collateralPrice('7900');f.advance(4000);const current=await f.engine.check();assert.equal(current.equityUsdt,'790');assert.equal(current.day.blocked,true);assert.equal(current.plan,null);assert.equal(current.blocker,'DAILY_USDT_EQUITY_LOSS_20_PERCENT');
});
test('stopping while a stop intent is being persisted does not leave an unsent order permanently pending',async t=>{
  const f=await fixture(t);await f.engine.start(FUTURES_CONFIRMATION);const commit=f.engine.commit.bind(f.engine);f.engine.commit=async state=>{await commit(state);if(state.pending?.kind==='PROTECTION')f.engine.stop();};
  await assert.rejects(f.engine.check({execute:true}),/START_REQUIRED/);assert.equal(f.engine.state.pending,null);assert.ok(f.engine.state.position);assert.equal(f.calls.some(c=>c.name==='newProtection'),false);
  f.engine.commit=commit;await f.engine.start(FUTURES_CONFIRMATION);assert.ok(f.engine.state.protection);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);
});
