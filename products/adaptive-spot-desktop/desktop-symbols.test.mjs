import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdtemp,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createController } from './controller.mjs';
import { testLicense } from './test-license-fixture.mjs';
import { testnetCatalog,testnetSymbol } from '../../lib/testnet-symbols.mjs';
import { initialState,readConfig } from '../../lib/testnet-bot.mjs';
import { policyEnvironment } from '../../lib/virtual-trading-policy.mjs';

const policy=JSON.parse(await readFile(new URL('../../strategies/virtual-only.json',import.meta.url),'utf8'));
const credentials={apiKey:'A'.repeat(64),apiSecret:'B'.repeat(64),privateKeyPath:''};
const entry=symbol=>({symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,orderTypes:['MARKET'],quoteOrderQtyMarketAllowed:true,filters:[{filterType:'LOT_SIZE'},{filterType:'NOTIONAL'}]});
const listing=()=>({symbols:['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','1INCHUSDT'].map(entry)});
const config=symbol=>readConfig(policyEnvironment({...policy,symbol}));
const state=symbol=>initialState(config(symbol),credentials.apiKey);
async function fixture(){
  const profile=await mkdtemp(resolve(tmpdir(),'asb-symbols-')),calls=[],children=[];
  const controller=await createController({profile,policy,emit:()=>{},licenseFactory:testLicense,
    clientFactory:options=>({syncTime:async()=>{},request:async(method,path,params)=>{
      calls.push({method,path,params,allowOrders:options.allowOrders});assert.equal(method,'GET');assert.equal(options.allowOrders,false);
      if(path==='/api/v3/exchangeInfo')return listing();
      if(path==='/api/v3/account')return {canTrade:true,balances:['USDT','BTC','ETH','DOGE'].map(asset=>({asset,free:'1000',locked:'0'}))};
      throw new Error('unexpected offline request');
    }}),
    spawnImpl:(exe,args,options)=>{const child=new EventEmitter();child.connected=true;child.stdout=new PassThrough();child.stderr=new PassThrough();child.send=()=>{};children.push({child,options});return child;}
  });
  await controller.handle({command:'configure',credentials});
  return {controller,profile,calls,children,statePath:symbol=>resolve(symbol==='BTCUSDT'?profile:resolve(profile,'markets',symbol),'.paper-data/testnet-state.json'),
    async put(symbol,saved){const p=this.statePath(symbol);await mkdir(resolve(p,'..'),{recursive:true});await writeFile(p,JSON.stringify(saved));},
    async close(){for(const {child}of children)child.emit('close',0);await controller.disconnect();}};
}
test('catalog derives every eligible USDT market from exchange metadata, excluding unavailable/unsafe pairs',()=>{
  const value=listing();value.symbols.push({...entry('BADUSDT'),status:'BREAK'}, {...entry('OFFUSDT'),isSpotTradingAllowed:false},{...entry('NOUSDT'),quoteOrderQtyMarketAllowed:false},{...entry('ETHBTC'),quoteAsset:'BTC'});
  assert.deepEqual(testnetCatalog(value).map(x=>x.symbol),['1INCHUSDT','BTCUSDT','DOGEUSDT','ETHUSDT','SOLUSDT']);
  assert.throws(()=>testnetCatalog({symbols:[entry('BTCUSDT'),entry('BTCUSDT')]}));assert.throws(()=>testnetCatalog({symbols:[]}));
});
test('symbol syntax and policy stay Testnet/USDT only while allowing new eligible bases',()=>{
  for(const symbol of ['BTCUSDT','ETHUSDT','DOGEUSDT','1INCHUSDT'])assert.equal(readConfig(policyEnvironment({...policy,symbol})).symbol,symbol);
  for(const symbol of ['ETHBTC','btcusdt','https://evil/USDT','../ETHUSDT','BTCUSDT;anything','USDTUSDT','',null])assert.throws(()=>testnetSymbol(symbol));
  assert.throws(()=>policyEnvironment({...policy,mode:'LIVE',symbol:'DOGEUSDT'}));
});
test('catalog refresh is public read-only and never creates account reads, workers or orders',async()=>{
  const f=await fixture();const result=await f.controller.handle({command:'markets'});assert.equal(result.items.length,5);assert.deepEqual(f.calls.map(x=>x.path),['/api/v3/exchangeInfo']);assert.equal(f.children.length,0);await f.close();
});
test('BTC history remains byte-identical while ETH records use a separate directory, and switching back restores BTC',async()=>{
  const f=await fixture(),btc={...state('BTCUSDT'),orders:[{time:1,side:'BUY',executedQty:1,quoteQty:10,status:'FILLED'}],dailyRisk:{dayUtc:'2026-11-08',realizedUsdt:-1}};
  await f.put('BTCUSDT',btc);const before=await readFile(f.statePath('BTCUSDT'));
  await f.controller.handle({command:'selectSymbol',symbol:'ETHUSDT'});assert.equal(f.controller.selectedSymbol(),'ETHUSDT');assert.equal((await f.controller.handle({command:'local'})).orders.length,0);
  await f.put('ETHUSDT',{...state('ETHUSDT'),orders:[{time:2,side:'SELL',executedQty:2,quoteQty:20,status:'FILLED'}]});
  await f.controller.handle({command:'selectSymbol',symbol:'BTCUSDT'});const local=await f.controller.handle({command:'local'});
  assert.equal(local.config.symbol,'BTCUSDT');assert.equal(local.orders[0].quoteQty,10);assert.deepEqual(await readFile(f.statePath('BTCUSDT')),before);assert.equal(f.children.length,0);await f.close();
});
test('position, pending order, current retained lock or sibling retained lock prevent escaping by switching',async()=>{
  for(const kind of ['position','pending','own-lock','other-lock']){
    const f=await fixture(),saved=state('BTCUSDT');
    if(kind==='position')saved.position={quantity:0.001,entryPrice:100,openedAt:1};if(kind==='pending')saved.pending={side:'BUY'};await f.put('BTCUSDT',saved);
    if(kind==='own-lock')await writeFile(resolve(f.profile,'.paper-data/testnet-bot.lock'),'fixture');
    if(kind==='other-lock'){await f.put('ETHUSDT',state('ETHUSDT'));await writeFile(resolve(f.profile,'markets/ETHUSDT/.paper-data/testnet-bot.lock'),'fixture');}
    await assert.rejects(f.controller.handle({command:'selectSymbol',symbol:'ETHUSDT'}));assert.equal(f.controller.selectedSymbol(),'BTCUSDT');assert.deepEqual(JSON.parse(await readFile(f.statePath('BTCUSDT'))),saved);await f.close();
  }
});
test('unsupported exchange symbol and mismatched target records cannot overwrite or reset current history',async()=>{
  const f=await fixture();await assert.rejects(f.controller.handle({command:'selectSymbol',symbol:'FAKEUSDT'}));
  await f.put('ETHUSDT',state('BTCUSDT'));await assert.rejects(f.controller.handle({command:'selectSymbol',symbol:'ETHUSDT'}));assert.equal(f.controller.selectedSymbol(),'BTCUSDT');assert.equal(JSON.parse(await readFile(f.statePath('ETHUSDT'))).symbol,'BTCUSDT');await f.close();
});
test('ETH connection reports ETH/USDT and worker receives ETH policy and isolated cwd, requiring manual reconnect/start',async()=>{
  const f=await fixture();await f.controller.handle({command:'selectSymbol',symbol:'ETHUSDT'});
  const start={command:'start',confirmVirtualOnly:true,confirmNoOtherBot:true};await assert.rejects(f.controller.handle(start));assert.equal(f.children.length,0);
  const connected=await f.controller.handle({command:'connect'});assert.deepEqual(connected.balances.map(x=>x.asset),['USDT','ETH']);
  await f.controller.handle(start);assert.equal(f.children[0].options.env.TESTNET_SYMBOL,'ETHUSDT');assert.equal(f.children[0].options.cwd,resolve(f.profile,'markets/ETHUSDT'));
  await assert.rejects(f.controller.handle({command:'selectSymbol',symbol:'DOGEUSDT'}));assert.equal(f.controller.selectedSymbol(),'ETHUSDT');await f.close();
});
test('an old target API tag requires per-market identity rebind without exposing foreign records or starting',async()=>{
  const f=await fixture(),saved={...state('ETHUSDT'),accountTag:'another-api-tag'};await f.put('ETHUSDT',saved);
  const result=await f.controller.handle({command:'selectSymbol',symbol:'ETHUSDT'});assert.equal(result.requiresCredentialRebind,true);
  await assert.rejects(f.controller.handle({command:'local'}));await assert.rejects(f.controller.handle({command:'connect'}));assert.deepEqual(JSON.parse(await readFile(f.statePath('ETHUSDT'))),saved);await f.close();
});
test('another market with pending work blocks startup; selecting it preserves its pending record for review',async()=>{
  const f=await fixture(),saved={...state('ETHUSDT'),pending:{side:'SELL',clientOrderId:'offline-pending'}};await f.put('ETHUSDT',saved);await f.controller.handle({command:'connect'});
  await assert.rejects(f.controller.handle({command:'start',confirmVirtualOnly:true,confirmNoOtherBot:true}));assert.equal(f.children.length,0);
  await f.controller.handle({command:'selectSymbol',symbol:'ETHUSDT'});assert.equal((await f.controller.handle({command:'local'})).pending.side,'SELL');await f.close();
});
test('selection persists independently of credentials and controller can boot over preexisting history',async()=>{
  const f=await fixture();await f.put('BTCUSDT',{...state('BTCUSDT'),orders:[]});await f.controller.handle({command:'selectSymbol',symbol:'DOGEUSDT'});await f.close();
  const restored=await createController({profile:f.profile,policy,emit:()=>{},licenseFactory:testLicense,clientFactory:()=>{throw new Error('No boot network');}});
  assert.equal(restored.selectedSymbol(),'DOGEUSDT');assert.equal((await restored.handle({command:'local'})).config.symbol,'DOGEUSDT');await restored.disconnect();
});
