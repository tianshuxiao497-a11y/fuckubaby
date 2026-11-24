import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FuturesEngine,validateSettings} from './engine.mjs';
import {FUTURES_CONFIRMATION,SETTINGS_CONFIRMATION} from './client.mjs';
import {units,signedUnits,decimal,multiply,pnl} from './math.mjs';
const initialTime=Date.UTC(2026,10,17,13);
test('initial margin accepts 0.01–100% and preserves the fixed daily limit and leverage checks',()=>{
  const settings={market:'USD_M',symbol:'BTCUSDT',marginMode:'ISOLATED',leverage:102,directionMode:'both',dailyLossPercent:20};
  for(const marginPercent of [0.01,0.125,1,2,10,99.99,100])assert.equal(validateSettings({...settings,marginPercent}).marginPercent,marginPercent);
  for(const marginPercent of [undefined,'10',null,NaN,Infinity,-1,0,0.009,0.0199999999999995,100.01])assert.throws(()=>validateSettings({...settings,marginPercent}),/^Error: INVALID_FUTURES_MARGIN_PERCENT$/);
  assert.throws(()=>validateSettings({...settings,marginPercent:10,leverage:1.5}),/EXPLICIT_FUTURES_MARGIN_LEVERAGE_AND_RISK_REQUIRED/);
  assert.throws(()=>validateSettings({...settings,marginPercent:10,dailyLossPercent:99}),/EXPLICIT_FUTURES_MARGIN_LEVERAGE_AND_RISK_REQUIRED/);
});
async function fixture(t,{market='USD_M',direction='LONG',hedge=false,timeout=false,reject=false,unmanaged=false,algoUnsupported=false,usdBalance='1000',maker=null}={}){
  const profile=await mkdtemp(join(tmpdir(),'asbf-engine-'));let clock=initialTime,forceClose=false,sequence=100,protection=null,collateralPrice='10000';
  const cash={USD_M:{USDT:market==='USD_M'?usdBalance:'0'},COIN_M:{BTC:market==='COIN_M'?'0.1':'0'}};
  const orders=new Map(),fills=new Map(),positions={USD_M:null,COIN_M:null},income={USD_M:[],COIN_M:[]},calls=[];
  const config={USD_M:{leverage:10,marginMode:'ISOLATED'},COIN_M:{leverage:10,marginMode:'ISOLATED'}};
  if(unmanaged)positions.USD_M={symbol:'BTCUSDT',direction:'LONG',quantity:'1',entryPrice:'10000',positionSide:hedge?'LONG':'BOTH'};
  const symbolOf=kind=>kind==='USD_M'?'BTCUSDT':'BTCUSD_PERP';
  function catalog(kind){return {symbols:[{symbol:symbolOf(kind),status:'TRADING',contractStatus:'TRADING',contractType:'PERPETUAL',underlyingType:'COIN',baseAsset:'BTC',quoteAsset:kind==='USD_M'?'USDT':'USD',marginAsset:kind==='USD_M'?'USDT':'BTC',contractSize:100,orderTypes:['LIMIT','MARKET'],filters:[{filterType:'LOT_SIZE',minQty:kind==='USD_M'?'0.001':'1',maxQty:'100000',stepSize:kind==='USD_M'?'0.001':'1'},{filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'10000000',tickSize:'0.1'},...(kind==='USD_M'?[{filterType:'MIN_NOTIONAL',notional:'5'}]:[])]}]};}
  function positionRows(kind){const p=positions[kind],side=hedge?(p?.direction??'LONG'):'BOTH';return [{symbol:symbolOf(kind),positionAmt:p?(p.direction==='SHORT'?'-':'')+p.quantity:'0',positionSide:side,entryPrice:p?.entryPrice??'0',markPrice:'10000',liquidationPrice:'0',leverage:String(config[kind].leverage),marginType:config[kind].marginMode.toLowerCase(),isAutoAddMargin:'false'}];}
  const clients={};
  for(const kind of ['USD_M','COIN_M'])clients[kind]={
    market:kind,armed:false,settings:false,arm(value){assert.equal(value,FUTURES_CONFIRMATION);this.armed=true;},armSettings(value){assert.equal(value,SETTINGS_CONFIRMATION);this.settings=true;},disarm(){this.armed=false;this.settings=false;},async syncTime(){return clock;},serverNow(){return clock;},
    async requestOwnedMakerCancel(pending,order){
      assert.equal(order.clientOrderId,pending.id);assert.equal(order.orderId,pending.exchangeOrderId);
      calls.push({kind,name:'makerCancel',armed:this.armed});
      if(maker.cancelOffline)throw new Error('CANCEL_NETWORK_TIMEOUT');
      if(!maker.fillAtCancel)orders.get(pending.id).status='CANCELED';
      maker.terminalVisible=true;
      if(maker.cancelAckLost)throw new Error('CANCEL_ACK_LOST');
    },
    async requestOwnedMakerProtection(args,receipt){
      const saved=JSON.parse(await readFile(join(profile,'futures-ledger.json'),'utf8'));
      assert.equal(saved.makerProtectionDue,receipt.id);
      assert.equal(saved.pending.id,args.clientAlgoId);
      assert.equal(receipt.quantity,args.quantity);
      calls.push({kind,name:'makerProtection',armed:this.armed,args});
      if(maker.protectionReadOffline)throw Object.assign(new Error('RECEIPT_READ_OFFLINE'),{makerProtectionNotSubmitted:true});
      protection={...args,market:kind,algoId:++sequence,algoStatus:'NEW',orderType:args.type,reduceOnly:args.reduceOnly==='true',actualOrderId:0};
      if(maker.protectionAckLost)throw new Error('STOP_ACK_LOST');
      return {algoId:protection.algoId};
    },
    async request(name,args={}){
      calls.push({kind,name,args:structuredClone(args)});
      if(name==='account')return {canTrade:true,assets:Object.entries(cash[kind]).map(([asset,walletBalance])=>({asset,walletBalance,unrealizedProfit:positions[kind]?pnl({market:kind,side:positions[kind].direction,quantity:positions[kind].quantity,entryPrice:positions[kind].entryPrice,exitPrice:'10000',contractSize:kind==='USD_M'?'1':'100'}):'0'}))};
      if(name==='balances')return Object.entries(cash[kind]).map(([asset,balance])=>({asset,balance,availableBalance:balance,accountAlias:kind+'-same-owner'}));
      if(name==='positions')return positionRows(kind);
      if(name==='accountConfig')return {dualSidePosition:hedge,multiAssetsMargin:false,canTrade:true};
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
        if(!row){const error=new Error('not found');error.binanceCode=-2013;throw error;}
        if(row.timeInForce==='GTX'&&maker?.expiredExternally)return {...row,status:'EXPIRED'};
        if(row.timeInForce==='GTX'&&maker?.fillAtCancel&&!maker.terminalVisible)return {...row,status:'NEW',executedQty:'0'};
        return structuredClone(row);
      }
      if(name==='trades')return structuredClone(fills.get(args.orderId)??[]);
      if(name==='newOrder'){
        assert.equal(this.armed,true);const saved=JSON.parse(await readFile(join(profile,'futures-ledger.json'),'utf8'));assert.equal(saved.pending.id,args.newClientOrderId);
        if(reject){const error=new Error('rejected');error.binanceCode=-2019;error.definitiveRejection=true;throw error;}
        const postOnly=args.timeInForce==='GTX';
        if(postOnly&&maker.rejection)throw Object.assign(new Error('simulated post rejection'),maker.rejection);
        const quantity=postOnly?(maker.quantity??args.quantity):args.quantity;
        const close=args.reduceOnly==='true'||(args.positionSide==='LONG'&&args.side==='SELL')||(args.positionSide==='SHORT'&&args.side==='BUY');
        const old=positions[kind],side=close?old.direction:(args.side==='BUY'?'LONG':'SHORT'),size=kind==='USD_M'?'1':'100',price=args.price??'10000';
        const profit=close?pnl({market:kind,side,quantity:args.quantity,entryPrice:old.entryPrice,exitPrice:price,contractSize:size}):'0';
        const value=kind==='USD_M'?multiply(units(quantity),units(price)):units(quantity)*units(size)/units(price),fee=decimal(multiply(value,units('0.0005'))),asset=kind==='USD_M'?'USDT':'BTC';
        cash[kind][asset]=decimal(signedUnits(cash[kind][asset])+signedUnits(profit)-units(fee));
        if(units(quantity))positions[kind]=close?null:{symbol:args.symbol,direction:side,quantity,entryPrice:price,positionSide:args.positionSide};
        const number=++sequence,row={...args,clientOrderId:args.newClientOrderId,orderId:number,origQty:args.quantity,executedQty:quantity,status:quantity===args.quantity?'FILLED':units(quantity)?'PARTIALLY_FILLED':'NEW'};
        orders.set(args.newClientOrderId,row);fills.set(number,units(quantity)?[{symbol:args.symbol,orderId:number,id:number,side:args.side,positionSide:args.positionSide,qty:quantity,price,commission:fee,commissionAsset:asset,realizedPnl:profit,time:clock}]:[]);
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
  const settings={market,symbol:symbolOf(market),marginMode:'ISOLATED',leverage:10,marginPercent:2,directionMode:'both',dailyLossPercent:20,externalStrategy:null,...(maker?{openingExecution:'makerPreferred'}:{})};
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
  const countsBeforeReport=f.calls.length;
  const report=JSON.parse(JSON.stringify(f.engine.last)).tradeReport;
  assert.equal(report.roundTrips.length,1);
  assert.equal(report.roundTrips[0].market,market);
  assert.equal(report.roundTrips[0].direction,direction);
  assert.equal(report.orders.length,2);
  assert.equal(f.calls.length,countsBeforeReport);
});
const openingRequests=f=>f.calls.filter(c=>c.name==='newOrder').map(c=>c.args);
for(const [market,direction] of [['USD_M','LONG'],['COIN_M','SHORT']])test(market+' maker first waits at the passive quote and retries zero fills only on the next eligible tick',async t=>{
  const f=await fixture(t,{market,direction,maker:{quantity:'0'}});
  await f.engine.start(FUTURES_CONFIRMATION);
  f.engine.waitForMaker=async ms=>f.advance(ms);
  await f.engine.check({execute:true});
  assert.equal(openingRequests(f).length,1);
  const [first]=openingRequests(f);
  assert.equal(first.timeInForce,'GTX');assert.equal(first.price,direction==='LONG'?'9999':'10000');
  assert.equal(f.engine.state.orders[0].status,'CANCELED');
  assert.equal(f.engine.state.position,null);
  assert.equal(f.calls.filter(c=>c.name==='makerCancel').length,1);
  await f.engine.check();
  assert.equal(openingRequests(f).length,1);
  await f.engine.check({execute:true});
  assert.deepEqual(openingRequests(f).map(o=>o.timeInForce),['GTX','IOC']);
  assert.ok(units(openingRequests(f)[1].quantity)<=units(first.quantity));
  assert.ok(f.engine.state.position);assert.ok(f.engine.state.protection);
  await f.engine.check({execute:true});
  assert.equal(openingRequests(f).length,2);
});
test('a partial maker fill cancels immediately and protects exactly the actual quantity; exits retain their normal execution',async t=>{
  const f=await fixture(t,{maker:{quantity:'0.004'}});
  f.engine.waitForMaker=()=>assert.fail('partial fill must not keep resting');
  await f.engine.start(FUTURES_CONFIRMATION);
  await f.engine.check({execute:true});
  assert.equal(f.engine.state.position.quantity,'0.004');
  assert.equal(f.engine.state.protection.quantity,'0.004');
  assert.equal(f.engine.state.makerProtectionDue,null);
  assert.equal(f.engine.state.fills.length,1);
  await f.engine.check({execute:true});
  assert.equal(openingRequests(f).length,1);
  f.forceClose();await f.engine.check({execute:true});
  assert.equal(openingRequests(f)[1].timeInForce,'IOC');assert.equal(f.engine.state.position,null);
});
test('a full fill racing stop and cancellation receives its own protection after disarm, without another entry',async t=>{
  const f=await fixture(t,{maker:{fillAtCancel:true}});
  f.engine.waitForMaker=async()=>f.engine.stop();
  await f.engine.start(FUTURES_CONFIRMATION);
  await f.engine.check({execute:true});
  assert.equal(f.engine.running,false);
  assert.equal(f.calls.find(c=>c.name==='makerCancel').armed,false);
  assert.equal(f.calls.find(c=>c.name==='makerProtection').armed,false);
  assert.equal(f.engine.state.fills.length,1);assert.ok(f.engine.state.protection);
  assert.equal(openingRequests(f).length,1);assert.equal(f.engine.makerRetry,null);
});
test('unconfirmed partial cancellation survives restart; signed reconciliation protects once without rearming',async t=>{
  const maker={quantity:'0.004',cancelOffline:true},f=await fixture(t,{maker});
  await f.engine.start(FUTURES_CONFIRMATION);
  await assert.rejects(f.engine.check({execute:true}),/MAKER_CANCEL_UNCONFIRMED/);
  const id=f.engine.state.pending.id;
  assert.ok(f.engine.state.pending.exchangeOrderId);assert.equal(f.engine.state.fills.length,0);
  await f.engine.close();
  const restored=new FuturesEngine({profile:f.engine.profile,clients:f.clients,settings:f.settings,now:f.engine.now,signalFactory:f.engine.signalFactory});
  await restored.acquire();t.after(()=>restored.close());
  assert.equal(restored.needsMakerCleanup,true);maker.cancelOffline=false;
  await restored.check();
  assert.equal(restored.running,false);assert.equal(restored.needsMakerCleanup,false);
  assert.equal(restored.state.orders[0].id,id);assert.equal(restored.state.position.quantity,'0.004');
  assert.equal(restored.state.protection.quantity,'0.004');assert.equal(restored.state.fills.length,1);
  assert.equal(openingRequests(f).length,1);assert.equal(f.calls.filter(c=>c.name==='makerProtection').length,1);
});
test('a failed receipt read and a lost stop acknowledgement recover without duplicating a protection',async t=>{
  const maker={protectionReadOffline:true},f=await fixture(t,{maker});
  await f.engine.start(FUTURES_CONFIRMATION);
  await assert.rejects(f.engine.check({execute:true}),/RECEIPT_READ_OFFLINE/);
  assert.equal(f.engine.state.pending,null);assert.ok(f.engine.state.makerProtectionDue);
  maker.protectionReadOffline=false;maker.protectionAckLost=true;
  await assert.rejects(f.engine.check(),/STOP_ACK_LOST/);
  assert.equal(f.engine.state.pending.kind,'PROTECTION');
  const attempts=f.calls.filter(c=>c.name==='makerProtection').length;
  await f.engine.check();
  assert.equal(f.calls.filter(c=>c.name==='makerProtection').length,attempts);
  assert.equal(f.engine.state.makerProtectionDue,null);assert.ok(f.engine.state.protection);
  assert.equal(openingRequests(f).length,1);assert.equal(f.engine.running,false);
});
test('post-only rejection needs a known -5022 and non-existent order; vanished signals discard the taker leg',async t=>{
  const maker={rejection:{definitiveRejection:true,binanceCode:-5022}},f=await fixture(t,{maker});
  await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});
  assert.equal(f.engine.state.orders[0].rejectionCode,-5022);
  const signal=f.engine.signalFactory;
  f.engine.signalFactory=parameters=>({...signal(parameters),intent:null});
  await f.engine.check({execute:true});assert.equal(openingRequests(f).length,1);
  f.engine.signalFactory=signal;maker.rejection={binanceCode:-1007};
  await assert.rejects(f.engine.check({execute:true}),/simulated post rejection/);
  assert.ok(f.engine.state.pending);assert.equal(f.engine.makerRetry,null);
  await assert.rejects(f.engine.check(),/FUTURES_ORDER_RESULT_UNRESOLVED_DO_NOT_RESUBMIT/);
  assert.deepEqual(openingRequests(f).map(r=>r.timeInForce),['GTX','GTX']);
});
test('externally expired or ambiguously canceled zero-fill orders never authorize an IOC fallback',async t=>{
  for(const scenario of [{expiredExternally:true},{cancelAckLost:true}]){
    const f=await fixture(t,{maker:{quantity:'0',...scenario}});
    f.engine.waitForMaker=async ms=>f.advance(ms);
    await f.engine.start(FUTURES_CONFIRMATION);
    await f.engine.check({execute:true});
    assert.equal(f.engine.state.pending,null);assert.equal(f.engine.state.position,null);
    await f.engine.check({execute:true});
    assert.deepEqual(openingRequests(f).map(r=>r.timeInForce),['GTX','GTX']);
  }
});
for(const market of ['USD_M','COIN_M'])test(market+' read-only workspace exposes contract limits and the magnitude of a manual short',async t=>{
  const {engine,clients,calls,settings}=await fixture(t,{market});
  engine.settings=validateSettings({...settings,externalPositionPolicy:'otherContracts'});
  const usd=market==='USD_M',symbol=usd?'ETHUSDT':'ETHUSD_PERP',quantity=usd?'0.25':'3';
  const client=clients[market],request=client.request.bind(client);
  client.request=async(name,args)=>{
    const value=await request(name,args);
    if(name==='positions')value.push({symbol,positionSide:'BOTH',positionAmt:'-'+quantity,entryPrice:'1200',updateTime:initialTime-1000});
    return value;
  };
  const snapshot=await engine.check();
  assert.deepEqual(snapshot.contractConstraints,{minimumQuantity:usd?'0.001':'1',stepSize:usd?'0.001':'1',minimumNotional:usd?'5':'0',
    baseAsset:'BTC',quoteAsset:usd?'USDT':'USD',quantityUnit:usd?'BTC':'contracts'});
  assert.deepEqual(snapshot.externalExposure.positions,[{market,symbol,direction:'SHORT',quantity}]);
  assert.equal(calls.some(({name})=>['newOrder','newProtection','setMargin','setLeverage'].includes(name)),false);
});
test('manual stop immediately updates the snapshot; a confirmed restart keeps an existing stop and never duplicates the entry',async t=>{
  const f=await fixture(t);await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});
  const stopId=f.engine.state.protection.id;
  f.engine.stop();
  assert.equal(f.engine.running,false);assert.equal(f.engine.last.running,false);
  await assert.rejects(f.engine.start(''),/EXPLICIT_FUTURES_START_REQUIRED/);
  await f.engine.start(FUTURES_CONFIRMATION);
  assert.equal(f.engine.running,true);assert.equal(f.engine.last.running,true);assert.equal(f.engine.state.protection.id,stopId);
  assert.equal(f.calls.filter(call=>call.name==='newOrder').length,1);
  assert.equal(f.calls.filter(call=>call.name==='newProtection').length,1);
});
test('stopping during a restart verification cancels that start; a later explicit start still succeeds',async t=>{
  const f=await fixture(t),client=f.clients.USD_M,request=client.request.bind(client);
  let entered,resume;
  const reading=new Promise(resolve=>{entered=resolve;}),release=new Promise(resolve=>{resume=resolve;});
  await f.engine.start(FUTURES_CONFIRMATION);f.engine.stop();
  client.request=async(name,args)=>{if(name==='account'){entered();await release;}return request(name,args);};
  const starting=f.engine.start(FUTURES_CONFIRMATION);
  await reading;f.engine.stop();resume();
  await assert.rejects(starting,/FUTURES_START_CANCELLED/);
  assert.equal(f.engine.running,false);assert.equal(client.armed,false);
  const started=await f.engine.start(FUTURES_CONFIRMATION);
  assert.equal(started.running,true);assert.equal(f.calls.some(call=>call.name==='newOrder'),false);
});
test('five USDT and the USD-M V3 account response pass read-only checks; missing trading permission still blocks readiness',async t=>{
  const {engine,clients,calls}=await fixture(t,{usdBalance:'5'});
  const client=clients.USD_M,request=client.request.bind(client);
  let permitted=true;
  client.request=async(name,args)=>{
    const value=await request(name,args);
    if(name==='account')delete value.canTrade;
    if(name==='accountConfig')value.canTrade=permitted;
    return value;
  };
  const snapshot=await engine.check();
  assert.equal(snapshot.accountChecked,true);
  assert.equal(snapshot.equityUsdt,'5');
  assert.deepEqual(engine.walletRead.amounts,[{asset:'USDT',balance:'5'}]);
  permitted=false;
  await assert.rejects(engine.check(),/TRADABLE_FUTURES_ACCOUNTS_REQUIRED/);
  assert.deepEqual(engine.walletRead.amounts,[{asset:'USDT',balance:'5'}]);
  assert.equal(calls.some(call=>call.name==='newOrder'),false);
  assert.equal(engine.running,false);
});
test('read-only BTCUSDT reconciliation includes a zero-balance U asset and keeps the saved mode separate',async t=>{
  const {engine,clients,calls,settings}=await fixture(t,{usdBalance:'7.39859088'});
  const usd=clients.USD_M,request=usd.request.bind(usd);
  usd.request=async(name,args)=>{
    if(name==='accountConfig')return {canTrade:true,multiAssetsMargin:true,dualSidePosition:false};
    if(name==='marginIndex')return {symbol:'USDTUSD',index:'1',time:usd.serverNow()};
    const result=await request(name,args);
    if(name==='account'){
      result.assets.push({asset:'U',walletBalance:'0.00000000',unrealizedProfit:'0.00000000'});
      return {...result,totalMarginBalance:'7.39859088',availableBalance:'0.52087928'};
    }
    if(name==='symbolConfig')return result.map(row=>({...row,marginType:'CROSSED'}));
    return result;
  };
  assert.equal((await engine.check()).blocker,'ASSET_MODE_PREFERENCE_MISMATCH');
  engine.settings=validateSettings({...settings,assetMode:'multi',marginMode:'CROSSED'});
  const snapshot=await engine.check();
  assert.equal(snapshot.accountChecked,true);
  assert.equal(snapshot.actualConfigurationMatches,true);
  assert.equal(snapshot.equityUsdt,'7.39859088');
  assert.equal(snapshot.wallets['USD_M.U'],'0.00000000');
  assert.equal(engine.marginCapacity.availableUsdt,'0.52087928');
  assert.equal(calls.some(c=>c.name==='newOrder'||c.name.startsWith('set')||c.args?.symbol==='UUSDT'),false);
});
test('USD-M asset and position modes are verified independently without changing the exchange',async t=>{
  const {engine,clients}=await fixture(t,{usdBalance:'5.11000047'});
  const request=clients.USD_M.request.bind(clients.USD_M),queries=[];
  let config={},assetReply={},positionReply={};
  clients.USD_M.request=async(name,args)=>{
    queries.push(name);
    if(name==='accountConfig')return {canTrade:true,...config};
    if(name==='multiAssets')return assetReply;
    if(name==='positionMode')return positionReply;
    if(name==='account')return {...await request(name,args),totalMarginBalance:'5.11000047',availableBalance:'5.11000047'};
    if(name==='marginIndex')return {symbol:args.symbol,index:'1',time:clients.USD_M.serverNow()};
    return request(name,args);
  };
  config={multiAssetsMargin:'false',dualSidePosition:'false'};
  assert.equal((await engine.check()).accountChecked,true);
  assert.deepEqual(engine.accountModes,{multiAssets:false,hedge:false});
  assert.ok(!queries.includes('multiAssets')&&!queries.includes('positionMode'));

  config={};assetReply={multiAssetsMargin:false};positionReply={dualSidePosition:true};
  assert.equal((await engine.check()).hedge,true);
  assert.ok(queries.includes('multiAssets')&&queries.includes('positionMode'));

  config={multiAssetsMargin:'true',dualSidePosition:false};
  assert.equal((await engine.check()).blocker,'ASSET_MODE_PREFERENCE_MISMATCH');
  assert.deepEqual(engine.walletRead.amounts,[{asset:'USDT',balance:'5.11000047'}]);
  assert.deepEqual(engine.accountModes,{multiAssets:true,hedge:false});

  config={};assetReply={multiAssetsMargin:'unexpected'};
  await assert.rejects(engine.check(),/USD_M_ASSET_MODE_UNVERIFIED/);
  assetReply={multiAssetsMargin:false};positionReply={};
  await assert.rejects(engine.check(),/USD_M_POSITION_MODE_UNVERIFIED/);
  assert.equal(engine.running,false);
  assert.ok(!queries.some(name=>name.startsWith('set')||name.startsWith('new')));
});
test('multi-assets caps BTCUSDT orders by the net USD pool even with no USDT cash; mode changes stop new orders',async t=>{
  const {engine,clients,settings,calls}=await fixture(t,{usdBalance:'0'});
  assert.equal(validateSettings(settings).assetMode,'single');
  assert.throws(()=>validateSettings({...settings,assetMode:'multi'}),/REQUIRES_CROSS/);
  engine.settings=validateSettings({...settings,assetMode:'multi',marginMode:'CROSSED'});
  const usd=clients.USD_M,request=usd.request.bind(usd);
  let availableUsd='6',indexTime=usd.serverNow(),multi=true,foreignOrder=false;
  usd.request=async(name,args)=>{
    if(name==='accountConfig')return {canTrade:true,dualSidePosition:false,multiAssetsMargin:multi};
    if(name==='marginIndex')return {symbol:args.symbol,index:args.symbol==='USDCUSD'?'1':'1.2',time:indexTime};
    if(name==='account')return {canTrade:true,totalMarginBalance:'1200',availableBalance:availableUsd,assets:[
      {asset:'USDT',walletBalance:'0',unrealizedProfit:'0'},
      {asset:'BTC',walletBalance:'0.1',unrealizedProfit:'0'}]};
    if(name==='balances')return [{asset:'USDT',balance:'0',availableBalance:'0',accountAlias:'USD_M-same-owner'},{asset:'BTC',balance:'0.1',availableBalance:'0',marginAvailable:true,accountAlias:'USD_M-same-owner'}];
    if(name==='symbolConfig')return [{symbol:args.symbol,marginType:'CROSSED',leverage:10}];
    if(name==='openOrders'&&foreignOrder)return [{symbol:'ETHUSDT'}];
    return request(name,args);
  };
  foreignOrder=true;
  await assert.rejects(engine.check(),/UNRESOLVED_OR_UNMANAGED_FUTURES_ORDERS/);
  assert.equal(engine.marginCapacity.availableUsdt,'5');
  foreignOrder=false;
  const snapshot=await engine.check();
  assert.deepEqual(engine.marginCapacity.eligible,['BTC']);
  assert.equal(engine.marginCapacity.poolEquityUsdt,'1000');
  assert.ok(snapshot.plan&&Number(snapshot.plan.allocation.initialMargin)+Number(snapshot.plan.allocation.reservedRoundTripFees)<=5);
  assert.equal(calls.filter(c=>c.name==='newOrder').length,0);
  await engine.start(FUTURES_CONFIRMATION);
  multi=false;
  await engine.check({execute:true});
  assert.equal(engine.running,false);
  assert.equal(calls.filter(c=>c.name==='newOrder').length,0);
  multi=true;availableUsd='-1';
  assert.equal((await engine.check()).plan,null);
  assert.equal(engine.marginCapacity.availableUsdt,'0');
  availableUsd=undefined;
  await assert.rejects(engine.check(),/MARGIN_CAPACITY_UNVERIFIED/);
  availableUsd='6';indexTime-=120000;
  await assert.rejects(engine.check(),/MARGIN_CONVERSION_INDEX_UNVERIFIED/);
});
test('multi-assets simulated fill and owned reduce-only close remain available during a conversion feed outage',async t=>{
  const {engine,settings,clients,calls}=await fixture(t);
  engine.settings=validateSettings({...settings,assetMode:'multi',marginMode:'CROSSED'});
  const usd=clients.USD_M,request=usd.request.bind(usd);
  let online=true;
  usd.request=async(name,args)=>{
    if(name==='accountConfig')return {canTrade:true,multiAssetsMargin:true,dualSidePosition:false};
    if(name==='marginIndex'){
      if(!online)throw new Error('MARGIN_CONVERSION_INDEX_UNVERIFIED');
      return {symbol:args.symbol,index:'1',time:usd.serverNow()};
    }
    const reply=await request(name,args);
    if(name==='account')return {...reply,availableBalance:'600',totalMarginBalance:'1000'};
    if(name==='symbolConfig')return reply.map(row=>({...row,marginType:'CROSSED'}));
    return reply;
  };
  await engine.start(FUTURES_CONFIRMATION);
  await engine.check({execute:true});
  assert.ok(engine.state.position&&engine.state.protection);
  online=false;
  await assert.rejects(engine.check(),/MARGIN_CONVERSION_INDEX_UNVERIFIED/);
  await engine.closeOwnedPosition(FUTURES_CONFIRMATION);
  assert.equal(engine.state.position,null);
  const orders=calls.filter(c=>c.name==='newOrder');
  assert.equal(orders.length,2);
  assert.equal(orders[1].args.reduceOnly,'true');
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
// The exchange responses below simulate an independent manual position. All reads and
// price changes stay inside the fixture; it has no production transport or keys.
async function manualOvernightFixture(t){
  const f=await fixture(t),usd=f.clients.USD_M,request=usd.request.bind(usd);
  const symbol='外部USDT_261225',midnight=initialTime+3*3600000,closedAt=midnight+1800000;
  const data={closed:false,hideTrades:false,pnl:'100'};
  f.engine.settings=validateSettings({...f.settings,externalPositionPolicy:'otherContracts'});
  usd.request=async(name,args={})=>{
    if(name==='trades'&&args.symbol===symbol){
      if(data.hideTrades||!data.closed||closedAt<args.startTime||closedAt>args.endTime)return [];
      return [{symbol,id:18,qty:'5',price:'140',side:'SELL',positionSide:'BOTH',realizedPnl:'200',time:closedAt}];
    }
    if(name==='income'&&data.closed&&closedAt>=args.startTime&&closedAt<=args.endTime){
      return [{incomeType:'REALIZED_PNL',symbol,tradeId:'18',tranId:69,income:'200',asset:'USDT',time:closedAt}];
    }
    if(name==='markCandles'&&args.symbol===symbol)return [[args.startTime,'160']];
    const value=await request(name,args);
    if(name==='positions'&&!data.closed)value.push({symbol,positionAmt:'5',entryPrice:'100',positionSide:'BOTH',updateTime:initialTime-10000});
    if(name==='catalog')value.symbols.push({symbol,marginAsset:'USDT',contractType:'CURRENT_QUARTER'});
    if(name==='account'){
      value.assets[0].walletBalance=data.closed?'1200':'1000';
      value.assets[0].unrealizedProfit=data.closed?'0':data.pnl;
    }
    return value;
  };
  return {f,data};
}
test('manual overnight PNL is included in opening equity and the account-wide daily loss stops only new entries',async t=>{
  const {f,data}=await manualOvernightFixture(t);
  assert.equal((await f.engine.check()).day.baselineUsdt,'1100');
  data.pnl='0';f.advance(4*3600000);
  const next=await f.engine.check();
  assert.equal(next.day.baselineUsdt,'1300');assert.equal(next.day.blocked,true);assert.equal(next.plan,null);
  assert.equal(f.engine.state.fills.length,0);assert.equal(f.calls.some(row=>row.name==='newOrder'),false);
});
test('after an overnight manual position closes, the account balance and the historical day baseline both reconcile',async t=>{
  const {f,data}=await manualOvernightFixture(t);
  await f.engine.check();data.closed=true;f.advance(4*3600000);
  const next=await f.engine.check();
  assert.equal(next.equityUsdt,'1200');assert.equal(next.day.baselineUsdt,'1300');assert.equal(next.day.blocked,false);
  assert.equal(f.engine.state.externalSnapshot.positions.length,0);
  assert.equal(f.engine.state.externalIncome.length,1);assert.equal(f.engine.state.fills.length,0);
  assert.equal(f.calls.some(row=>row.name==='newOrder'),false);
});
test('incomplete manual fill history locks just the affected day and a verified next midnight recovers',async t=>{
  const {f,data}=await manualOvernightFixture(t);
  await f.engine.check();data.closed=true;data.hideTrades=true;f.advance(4*3600000);
  const locked=await f.engine.check();
  assert.equal(locked.blocker,'EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED');assert.equal(locked.day.baselineUsdt,null);
  assert.equal(locked.plan,null);assert.equal(f.engine.state.externalSnapshot.positions.length,0);
  data.hideTrades=false;f.advance(60000);
  assert.equal((await f.engine.check()).day.blocked,true);
  f.advance(86400000);
  const recovered=await f.engine.check();
  assert.equal(recovered.day.baselineUsdt,'1200');assert.equal(recovered.day.blocked,false);
  assert.equal(f.calls.some(row=>row.name==='newOrder'),false);
});
test('collateral coin depreciation alone triggers the same daily USDT-equity entry lock',async t=>{
  const f=await fixture(t,{market:'COIN_M'});await f.engine.check();f.collateralPrice('7900');f.advance(4000);const current=await f.engine.check();assert.equal(current.equityUsdt,'790');assert.equal(current.day.blocked,true);assert.equal(current.plan,null);assert.equal(current.blocker,'DAILY_USDT_EQUITY_LOSS_20_PERCENT');
});
test('stopping while a stop intent is being persisted does not leave an unsent order permanently pending',async t=>{
  const f=await fixture(t);await f.engine.start(FUTURES_CONFIRMATION);const commit=f.engine.commit.bind(f.engine);f.engine.commit=async state=>{await commit(state);if(state.pending?.kind==='PROTECTION')f.engine.stop();};
  await assert.rejects(f.engine.check({execute:true}),/START_REQUIRED/);assert.equal(f.engine.state.pending,null);assert.ok(f.engine.state.position);assert.equal(f.calls.some(c=>c.name==='newProtection'),false);
  f.engine.commit=commit;await f.engine.start(FUTURES_CONFIRMATION);assert.ok(f.engine.state.protection);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);
});
