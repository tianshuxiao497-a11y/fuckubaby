import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync,verify} from 'node:crypto';
import {FuturesClient,FUTURES_CONFIRMATION,SETTINGS_CONFIRMATION,MODE_CONFIRMATION,MARGIN_CONFIRMATION} from './client.mjs';
const time=1800000000000,id='asbf_'+'a'.repeat(28),algo='asbp_'+'b'.repeat(28);
function fixture({market='USD_M',rsa=false,reply}={}){
  const calls=[],pair=rsa?generateKeyPairSync('rsa',{modulusLength:2048}):null;
  const client=new FuturesClient({market,apiKey:'FIXTURE-FUTURES-KEY',...(rsa?{privateKeyPem:pair.privateKey.export({type:'pkcs8',format:'pem'})}:{apiSecret:'FIXTURE-FUTURES-SECRET'}),now:()=>time,
    fetchImpl:async(url,options)=>{calls.push({url:new URL(url),options});return reply?.(url,options)??Response.json(String(url).includes('/time')?{serverTime:time}:{});}});
  return {client,calls,pair};
}
const order={symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'LIMIT',timeInForce:'IOC',quantity:'0.01',price:'100000',newClientOrderId:id,newOrderRespType:'ACK'};
test('account read reports only the query name, market and numeric exchange errors',async()=>{
  const f=fixture({reply:url=>url.pathname.endsWith('/time')?undefined:Response.json({code:-2015,msg:'sensitive upstream text'},{status:401})});
  await f.client.syncTime();
  await assert.rejects(f.client.request('balances'),err=>{
    assert.deepEqual(err.readFailure,{market:'USD_M',operation:'balances',httpStatus:401,binanceCode:-2015});
    assert.doesNotMatch(JSON.stringify(err.readFailure),/sensitive|signature|APIKEY/);
    return true;
  });
});
test('U and coin requests use different fixed origins, paths and HMAC-signed query bodies',async()=>{
  for(const market of ['USD_M','COIN_M']){
    const f=fixture({market});await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);
    await f.client.request('newOrder',{...order,symbol:market==='USD_M'?'BTCUSDT':'BTCUSD_PERP',quantity:market==='USD_M'?'0.01':'1'});
    const request=f.calls.at(-1),params=new URLSearchParams(request.options.body),signature=params.get('signature');params.delete('signature');
    assert.equal(signature,createHmac('sha256','FIXTURE-FUTURES-SECRET').update(params.toString()).digest('hex'));
    assert.equal(request.url.origin,market==='USD_M'?'https://fapi.binance.com':'https://dapi.binance.com');
    assert.equal(request.url.pathname,market==='USD_M'?'/fapi/v1/order':'/dapi/v1/order');assert.equal(request.options.redirect,'error');
  }
});
test('RSA keys use the documented SHA256 PKCS1 signature and Ed25519 is not silently reused from Spot',async()=>{
  const f=fixture({rsa:true});await f.client.syncTime();await f.client.request('account');
  const request=f.calls.at(-1),params=request.url.searchParams,signature=params.get('signature');params.delete('signature');
  assert.equal(verify('sha256',Buffer.from(params.toString()),f.pair.publicKey,Buffer.from(signature,'base64')),true);
  const ed=generateKeyPairSync('ed25519');assert.throws(()=>new FuturesClient({market:'USD_M',privateKeyPem:ed.privateKey.export({type:'pkcs8',format:'pem'})}),/RSA_OR_HMAC/);
});
test('no write can occur on save, clock sync, read-only check or without the exact start confirmation',async()=>{
  const f=fixture();await f.client.syncTime();await assert.rejects(f.client.request('newOrder',order),/EXPLICIT/);
  assert.throws(()=>f.client.arm('START REAL SPOT TRADING'));
  await assert.rejects(f.client.request('setLeverage',{symbol:'BTCUSDT',leverage:10}),/EXPLICIT/);
  assert.equal(f.calls.filter(c=>c.options.method!=='GET').length,0);
});
test('margin/leverage approval does not also grant account-wide mode, transfers or withdrawals',async()=>{
  const f=fixture();await f.client.syncTime();f.client.armSettings(SETTINGS_CONFIRMATION);
  await f.client.request('setLeverage',{symbol:'BTCUSDT',leverage:10});await f.client.request('setMargin',{symbol:'BTCUSDT',marginType:'ISOLATED'});
  await assert.rejects(f.client.request('setPositionMode',{dualSidePosition:'true'}),/EXPLICIT_ACCOUNT/);
  for(const name of ['setMultiAssets','withdraw','transfer','batchOrders'])await assert.rejects(f.client.request(name,{}),/REFUSED/);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,2);
});
test('account Hedge Mode needs a distinct approval and cannot be silently disabled',async()=>{
  const f=fixture();await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);await assert.rejects(f.client.request('setPositionMode',{dualSidePosition:'true'}),/EXPLICIT_ACCOUNT/);
  f.client.armMode(MODE_CONFIRMATION);await f.client.request('setPositionMode',{dualSidePosition:'true'});assert.equal(f.calls.at(-1).url.pathname,'/fapi/v1/positionSide/dual');await assert.rejects(f.client.request('setPositionMode',{dualSidePosition:'false'}));
});
test('isolated additions need their own approval, explicit direction and positive amount; reductions are refused',async()=>{
  const f=fixture({market:'COIN_M'});await f.client.syncTime();const args={symbol:'BTCUSD_PERP',positionSide:'SHORT',amount:'0.001',type:1};
  await assert.rejects(f.client.request('addMargin',args),/EXPLICIT_ISOLATED/);f.client.armMargin(MARGIN_CONFIRMATION);await f.client.request('addMargin',args);assert.equal(f.calls.at(-1).url.pathname,'/dapi/v1/positionMargin');
  await assert.rejects(f.client.request('addMargin',{...args,type:2}));await assert.rejects(f.client.request('addMargin',{...args,amount:'0'}));f.client.disarmMargin();await assert.rejects(f.client.request('addMargin',args));
});
test('market orders only reduce and hedge mode cannot accidentally send reduceOnly',async()=>{
  const f=fixture();await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);
  const market={...order,type:'MARKET'};delete market.price;delete market.timeInForce;
  await assert.rejects(f.client.request('newOrder',market),/MARKET_ONLY/);
  await f.client.request('newOrder',{...market,side:'SELL',reduceOnly:'true'});
  await f.client.request('newOrder',{...market,side:'BUY',positionSide:'SHORT'});
  await assert.rejects(f.client.request('newOrder',{...market,positionSide:'LONG',reduceOnly:'true'}),/HEDGE_MODE/);
});
test('protection uses Algo STOP_MARKET and only a closing direction with an explicit fixed quantity',async()=>{
  const f=fixture({market:'COIN_M'});await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);
  const stop={algoType:'CONDITIONAL',symbol:'BTCUSD_PERP',side:'BUY',positionSide:'SHORT',type:'STOP_MARKET',quantity:'1',triggerPrice:'110000',workingType:'MARK_PRICE',priceProtect:'FALSE',clientAlgoId:algo};
  await f.client.request('newProtection',stop);assert.equal(f.calls.at(-1).url.pathname,'/dapi/v1/algoOrder');
  await assert.rejects(f.client.request('newProtection',{...stop,side:'SELL'}),/REDUCING/);
  await assert.rejects(f.client.request('newProtection',{...stop,closePosition:'true'}),/PARAMETER/);
  await assert.rejects(f.client.request('newOrder',{...order,type:'STOP_MARKET'}),/TYPE_REFUSED/);
});
test('public collateral valuation sends no trading key to the Spot origin',async()=>{
  const f=fixture();await f.client.request('collateralPrice',{symbol:'BTCUSDT'});const call=f.calls.at(-1);
  assert.equal(call.url.origin,'https://api.binance.com');assert.equal(call.options.headers['X-MBX-APIKEY'],undefined);
  await f.client.request('collateralPrice',{symbol:'UUSDT'});
  assert.equal(f.calls.at(-1).url.searchParams.get('symbol'),'UUSDT');
  await assert.rejects(f.client.request('collateralPrice',{symbol:'USDT'}),/INVALID_COLLATERAL_PRICE_SYMBOL/);
});
test('timeout and rate refusal stop writes without resubmitting an order',async()=>{
  let posts=0;const f=fixture({reply:(url,options)=>{if(options.method==='POST'){posts++;throw new Error('network');}}});
  await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);await assert.rejects(f.client.request('newOrder',order),/UNKNOWN_RECONCILE/);assert.equal(posts,1);
  const blocked=fixture({reply:(url)=>String(url).includes('/time')?null:new Response('{}',{status:429})});
  await blocked.client.syncTime();await assert.rejects(blocked.client.request('account'),/REFUSED_OR_RATE/);assert.throws(()=>blocked.client.arm(FUTURES_CONFIRMATION),/BLOCKED/);
});

function makerFixture({market='USD_M',direction='LONG',hedge=false,status='PARTIALLY_FILLED',override={},failure}={}){
  const symbol=market==='USD_M'?'BTCUSDT':'BTCUSD_PERP';
  const side=direction==='LONG'?'BUY':'SELL',positionSide=hedge?direction:'BOTH';
  const quantity=market==='USD_M'?'0.003':'3',executedQty=market==='USD_M'?'0.001':'1';
  const args={symbol,side,positionSide,type:'LIMIT',timeInForce:'GTX',quantity,price:'60000',
    newOrderRespType:'ACK',...(hedge?{}:{reduceOnly:'false'})};
  const pending={id,kind:'ORDER',direction,intent:'OPEN_'+direction,market,args,exchangeOrderId:123};
  const observed={orderId:123,clientOrderId:id,symbol,side,positionSide,type:'LIMIT',timeInForce:'GTX',
    origQty:quantity,executedQty,price:'60000.0000',avgPrice:'60000.00',reduceOnly:false,status,...override};
  const f=fixture({market,reply:(url,opts)=>{
    if(failure){const response=failure(url,opts);if(response!==undefined)return response;}
    if(opts.method==='GET'&&url.pathname.endsWith('/order'))return Response.json(observed);
  }});
  const receipt={id,orderId:123,market,symbol,side,positionSide,timeInForce:'GTX',intent:'OPEN_'+direction,
    quantity:executedQty,status,time};
  const stop={symbol,side:side==='BUY'?'SELL':'BUY',positionSide,quantity:executedQty,algoType:'CONDITIONAL',
    type:'STOP_MARKET',workingType:'MARK_PRICE',priceProtect:'FALSE',clientAlgoId:'asbp_'+id.slice(5),
    triggerPrice:direction==='LONG'?'59900':'60100',...(hedge?{}:{reduceOnly:'true'})};
  const writeCalls=()=>f.calls.filter(call=>call.options.method!=='GET');
  return {...f,args,pending,stop,receipt,observed,writeCalls};
}

test('GTX requires an armed explicit opening order and definitive -5022 applies only to that exact submission',async()=>{
  for(const direction of ['LONG','SHORT']){
    const f=makerFixture({hedge:true,direction});
    await f.client.syncTime();
    const open={...f.args,newClientOrderId:id};
    await assert.rejects(f.client.request('newOrder',open),/EXPLICIT_FUTURES_START/);
    f.client.arm(FUTURES_CONFIRMATION);
    await f.client.request('newOrder',open);
    await assert.rejects(f.client.request('newOrder',{...open,side:open.side==='BUY'?'SELL':'BUY'}),/GTX_ONLY_FOR_OPENING/);
    await assert.rejects(f.client.request('newOrder',{...open,positionSide:'BOTH',reduceOnly:'true'}),/GTX_ONLY_FOR_OPENING/);
    await assert.rejects(f.client.request('newOrder',{...open,positionSide:'BOTH'}),/GTX_ONLY_FOR_OPENING/);
    assert.equal(f.writeCalls().length,1);
  }
  for(const [tif,http,expected] of [['GTX',400,true],['IOC',400,false],['GTX',503,false]]){
    const f=makerFixture({failure:(_url,opts)=>opts.method==='POST'?Response.json({code:-5022},{status:http}):undefined});
    await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);
    await assert.rejects(f.client.request('newOrder',{...f.args,timeInForce:tif,newClientOrderId:id}),
      error=>error.binanceCode===-5022&&error.definitiveRejection===expected);
  }
});

test('disarmed cancellation requires the exact working order returned by this client and cannot be reused or target another contract',async()=>{
  const f=makerFixture(),g=makerFixture();
  await f.client.syncTime();await g.client.syncTime();
  const reference={symbol:f.args.symbol,origClientOrderId:id};
  const order=await f.client.request('order',reference);
  await assert.rejects(f.client.request('cancelOrder',reference),/EXPLICIT_FUTURES_START/);
  await assert.rejects(g.client.requestOwnedMakerCancel(f.pending,order),/VERIFIED_WORKING/);
  await assert.rejects(f.client.requestOwnedMakerCancel(f.pending,{...order}),/VERIFIED_WORKING/);
  for(const change of [{market:'COIN_M'},{id:'asbf_'+'c'.repeat(28)},{direction:'SHORT'},{exchangeOrderId:124}]){
    await assert.rejects(f.client.requestOwnedMakerCancel({...f.pending,...change},order),/VERIFIED_WORKING/);
  }
  for(const change of [{symbol:'ETHUSDT'},{price:'60100'},{quantity:'0.004'},{timeInForce:'IOC'},{positionSide:'SHORT'},{side:'SELL'}]){
    await assert.rejects(f.client.requestOwnedMakerCancel({...f.pending,args:{...f.args,...change}},order),/VERIFIED_WORKING/);
  }
  assert.equal(f.writeCalls().length,0);
  await f.client.requestOwnedMakerCancel(f.pending,order);
  assert.equal(f.writeCalls().length,1);
  assert.equal(f.writeCalls()[0].options.method,'DELETE');
  assert.equal(f.writeCalls()[0].url.searchParams.get('origClientOrderId'),id);
  await assert.rejects(f.client.requestOwnedMakerCancel(f.pending,order),/VERIFIED_WORKING/);
  const alreadyFilled=makerFixture({status:'FILLED'});
  await alreadyFilled.client.syncTime();
  const terminal=await alreadyFilled.client.request('order',reference);
  await assert.rejects(alreadyFilled.client.requestOwnedMakerCancel(alreadyFilled.pending,terminal),/VERIFIED_WORKING/);
  assert.equal(alreadyFilled.writeCalls().length,0);
});

test('disarmed protection matches the exact terminal maker fill with a fixed closing side, quantity and deterministic algo ID in both markets',async()=>{
  for(const market of ['USD_M','COIN_M'])for(const direction of ['LONG','SHORT'])for(const hedge of [false,true]){
    const f=makerFixture({market,direction,hedge,status:'CANCELED'});
    await f.client.syncTime();
    for(const change of [{quantity:f.args.quantity},{symbol:'ETHUSDT'},{clientAlgoId:algo},{type:'MARKET'},
      {side:f.receipt.side},{triggerPrice:'60000'},{workingType:'CONTRACT_PRICE'},{priceProtect:'TRUE'},
      {closePosition:'true'},hedge?{reduceOnly:'true'}:{reduceOnly:'false'}]){
      await assert.rejects(f.client.requestOwnedMakerProtection({...f.stop,...change},f.receipt),/MATCHING_OWN_MAKER/);
    }
    for(const change of [{market:'OTHER'},{id:'asbf_'+'d'.repeat(28)},{orderId:124},{status:'FILLED'},{timeInForce:'IOC'}]){
      await assert.rejects(f.client.requestOwnedMakerProtection(f.stop,{...f.receipt,...change}),/MATCHING_OWN_MAKER/);
    }
    assert.equal(f.writeCalls().length,0);
    await f.client.requestOwnedMakerProtection(f.stop,f.receipt);
    assert.equal(f.writeCalls().length,1);
    const applied=new URLSearchParams(f.writeCalls()[0].options.body);
    assert.equal(applied.get('clientAlgoId'),f.stop.clientAlgoId);
    assert.equal(applied.get('quantity'),f.receipt.quantity);
    assert.equal(applied.get('side'),direction==='LONG'?'SELL':'BUY');
    assert.equal(applied.get('reduceOnly'),hedge?null:'true');
    await assert.rejects(f.client.requestOwnedMakerProtection(f.stop,f.receipt),/ALREADY_SUBMITTED/);
    await assert.rejects(f.client.request('newOrder',{...f.args,newClientOrderId:id}),/EXPLICIT_FUTURES_START/);
    assert.equal(f.writeCalls().length,1);
  }
});

test('a failed maker proof read is safe to retry but a lost stop submission is left for reconciliation',async()=>{
  let unavailable=true;
  const f=makerFixture({status:'CANCELED',failure:(url,opts)=>{
    if(unavailable&&opts.method==='GET'&&url.pathname.endsWith('/order'))throw new Error('offline');
    if(opts.method==='POST')throw new Error('unknown');
  }});
  await f.client.syncTime();
  await assert.rejects(f.client.requestOwnedMakerProtection(f.stop,f.receipt),
    error=>error.makerProtectionNotSubmitted===true&&error.readFailure.operation==='order');
  assert.equal(f.writeCalls().length,0);
  unavailable=false;
  await assert.rejects(f.client.requestOwnedMakerProtection(f.stop,f.receipt),
    error=>!error.makerProtectionNotSubmitted&&error.message==='FUTURES_RESULT_UNKNOWN_RECONCILE');
  await assert.rejects(f.client.requestOwnedMakerProtection(f.stop,f.receipt),/ALREADY_SUBMITTED/);
  assert.equal(f.writeCalls().length,1);
});
