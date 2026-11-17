import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync,verify} from 'node:crypto';
import {FuturesClient,FUTURES_CONFIRMATION,SETTINGS_CONFIRMATION} from './client.mjs';
const time=1800000000000,id='asbf_'+'a'.repeat(28),algo='asbp_'+'b'.repeat(28);
function fixture({market='USD_M',rsa=false,reply}={}){
  const calls=[],pair=rsa?generateKeyPairSync('rsa',{modulusLength:2048}):null;
  const client=new FuturesClient({market,apiKey:'FIXTURE-FUTURES-KEY',...(rsa?{privateKeyPem:pair.privateKey.export({type:'pkcs8',format:'pem'})}:{apiSecret:'FIXTURE-FUTURES-SECRET'}),now:()=>time,
    fetchImpl:async(url,options)=>{calls.push({url:new URL(url),options});return reply?.(url,options)??Response.json(String(url).includes('/time')?{serverTime:time}:{});}});
  return {client,calls,pair};
}
const order={symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'LIMIT',timeInForce:'IOC',quantity:'0.01',price:'100000',newClientOrderId:id,newOrderRespType:'ACK'};
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
test('only explicitly confirmed per-symbol margin and leverage writes exist; global mode, transfers and withdrawals do not',async()=>{
  const f=fixture();await f.client.syncTime();f.client.armSettings(SETTINGS_CONFIRMATION);
  await f.client.request('setLeverage',{symbol:'BTCUSDT',leverage:10});await f.client.request('setMargin',{symbol:'BTCUSDT',marginType:'ISOLATED'});
  for(const name of ['setPositionMode','setMultiAssets','withdraw','transfer','batchOrders'])await assert.rejects(f.client.request(name,{}),/REFUSED/);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,2);
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
});
test('timeout and rate refusal stop writes without resubmitting an order',async()=>{
  let posts=0;const f=fixture({reply:(url,options)=>{if(options.method==='POST'){posts++;throw new Error('network');}}});
  await f.client.syncTime();f.client.arm(FUTURES_CONFIRMATION);await assert.rejects(f.client.request('newOrder',order),/UNKNOWN_RECONCILE/);assert.equal(posts,1);
  const blocked=fixture({reply:(url)=>String(url).includes('/time')?null:new Response('{}',{status:429})});
  await blocked.client.syncTime();await assert.rejects(blocked.client.request('account'),/REFUSED_OR_RATE/);assert.throws(()=>blocked.client.arm(FUTURES_CONFIRMATION),/BLOCKED/);
});
