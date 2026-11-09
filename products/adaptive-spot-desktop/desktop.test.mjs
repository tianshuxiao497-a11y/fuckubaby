import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createController, cleanEnvironment, validateCredentials, mayStart, redact } from './controller.mjs';
import { archive, sha, DESKTOP_FILES, NODE_SHA } from './build.mjs';
import { initialState, readConfig } from '../../lib/testnet-bot.mjs';
import { policyEnvironment } from '../../lib/virtual-trading-policy.mjs';
import { testLicense } from './test-license-fixture.mjs';

const policy = JSON.parse(await readFile(new URL('../../strategies/virtual-only.json', import.meta.url),'utf8'));
const credentials = { apiKey:'A'.repeat(64), apiSecret:'B'.repeat(64), privateKeyPath:'' };
const config = readConfig(policyEnvironment(policy,{}));
async function fixture({canTrade = true, delayed = false, now, accountError, openOrders = []} = {}) {
  const profile = await mkdtemp(resolve(tmpdir(),'adaptive-desktop-test-')); const events=[], calls=[], children=[];
  let release;
  const c = await createController({ profile, policy, emit:x=>events.push(x), licenseFactory:testLicense, now,
    env:{SystemRoot:'C:/Windows',NODE_OPTIONS:'--import evil.mjs',BINANCE_API_KEY:'real'},
    clientFactory: options => ({syncTime:async()=> { if(delayed) await new Promise(r=>{release=r;}); }, request:async(method,path)=> {
      calls.push([method,path,options]);
      const failure=accountError?.();
      if(path==='/api/v3/account'&&failure)throw failure;
      return path==='/api/v3/openOrders'?openOrders:{canTrade,balances:[{asset:'USDT',free:'1000',locked:'0'}]};
    }}),
    spawnImpl:(exe,args,opts)=> { const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); children.push({exe,args,opts,child}); return child; }
  });
  return {c, profile, events,calls,children, release:()=>release?.()};
}
const confirm = {command:'start', confirmVirtualOnly:true, confirmNoOtherBot:true};
test('desktop strips inherited production, proxy and Node injection settings',()=> {
  assert.deepEqual(cleanEnvironment({SystemRoot:'C:/Windows',PATH:'evil',NODE_OPTIONS:'evil',BINANCE_API_KEY:'real',HTTP_PROXY:'evil'}),{SystemRoot:'C:/Windows'});
});
test('credential schema rejects hosts, dual signing, invalid keys and relative private paths',()=> {
  assert.deepEqual(validateCredentials(credentials),credentials);
  for(const c of [{...credentials,host:'evil'}, {...credentials,apiKey:'short'}, {...credentials,privateKeyPath:'relative.pem'}, {...credentials,apiSecret:''}]) assert.throws(()=>validateCredentials(c));
});
test('virtual start requires explicit consent, connected account, no worker and no lock',()=> {
  assert.doesNotThrow(()=>mayStart(confirm,true,false,false));
  for(const args of [[{},true,false,false],[confirm,false,false,false],[confirm,true,true,false],[confirm,true,false,true]]) assert.throws(()=>mayStart(...args));
});
test('no automatic orders or account reads on creation, configure or local status',async()=> {
  const f=await fixture(); assert.equal(f.children.length,0);
  await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'local'});
  assert.equal(f.calls.length,0); assert.equal(f.children.length,0); await f.c.disconnect();
});
test('connect is strictly read-only and client has orders disabled',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); const response=await f.c.handle({command:'connect'});
  assert.equal(response.canTrade,true); assert.deepEqual(f.calls.map(x=>x.slice(0,2)),[['GET','/api/v3/account']]); assert.equal(f.calls[0][2].allowOrders,false); assert.equal(f.children.length,0);
});
test('restored credentials retry a network error and reconnect without launching orders',async()=> {
  let time=0, offline=true;
  const f=await fixture({now:()=>time,accountError:()=>offline?Object.assign(new Error('offline'),{readOnlyTransient:true}):null});
  await f.c.handle({command:'configure',credentials,autoConnect:true});
  await f.c.tickConnection();
  assert.equal(f.events.at(-1).status,'retrying');
  await assert.rejects(f.c.handle(confirm),/connection/);
  offline=false; time=4999;
  await f.c.tickConnection(); assert.equal(f.calls.length,1);
  time=5000; await f.c.tickConnection();
  assert.deepEqual(f.calls.map(x=>x.slice(0,2)),[['GET','/api/v3/account'],['GET','/api/v3/account'],['GET','/api/v3/openOrders']]);
  assert.ok(f.calls.every(x=>x[2].allowOrders===false));
  assert.equal(f.events.at(-1).automatic,true); assert.equal(f.events.at(-1).canTrade,true);
  assert.equal(f.children.length,0);
  await f.c.disconnect();
});
test('an open Testnet order or rejected API key requires review without a retry or worker',async()=> {
  for(const options of [{openOrders:[{orderId:1}]},{accountError:()=>Object.assign(new Error('invalid key'),{status:401,code:-2015})}]){
    let time=0;
    const f=await fixture({...options,now:()=>time});
    await f.c.handle({command:'configure',credentials,autoConnect:true});
    await f.c.tickConnection();
    assert.equal(f.events.at(-1).status,'review_required');
    const count=f.calls.length;
    time=100000; await f.c.tickConnection();
    assert.equal(f.calls.length,count);
    await assert.rejects(f.c.handle(confirm),/connection/);
    assert.equal(f.children.length,0);
    await f.c.disconnect();
  }
});
test('account without trading permission cannot start',async()=> {
  const f=await fixture({canTrade:false}); await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'connect'});
  await assert.rejects(f.c.handle(confirm),/connection/); assert.equal(f.children.length,0);
});
test('explicit start launches only fixed worker with clean environment; rejects duplicate',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'connect'});
  assert.equal((await f.c.handle(confirm)).type,'started'); const ch=f.children[0];
  assert.equal(ch.args.length,1); assert.match(ch.args[0],/worker\.mjs$/); assert.equal(ch.opts.cwd,f.profile);
  assert.equal(ch.opts.env.BINANCE_TESTNET_API_KEY,credentials.apiKey); assert.equal(ch.opts.env.NODE_OPTIONS,undefined); assert.equal(ch.opts.env.BINANCE_API_KEY,undefined); assert.equal(ch.opts.env.TESTNET_STRATEGY,'adaptive'); assert.equal(ch.opts.env.TESTNET_POLL_SECONDS,'5');
  await assert.rejects(f.c.handle(confirm),/worker|lock/); await assert.rejects(f.c.handle({command:'configure',credentials}),/Stop/);
  await f.c.handle({command:'stop'}); assert.match(await readFile(resolve(f.profile,'.paper-data/testnet-stop'),'utf8'),/stop/);
  ch.child.emit('close',0); assert.equal(f.c.busy(),false); await assert.rejects(f.c.handle(confirm),/connection/);
});
test('retained lock is never auto-deleted to restart',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'connect'});
  const path=resolve(f.profile,'.paper-data/testnet-bot.lock'); await writeFile(path,'999999');
  await assert.rejects(f.c.handle(confirm),/lock/); assert.equal(await readFile(path,'utf8'),'999999'); assert.equal(f.children.length,0);
});
test('stop racing an asynchronous start cancels the start before any worker',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'connect'});
  const start=f.c.handle(confirm); await f.c.handle({command:'stop'}); await assert.rejects(start,/cancelled/); assert.equal(f.children.length,0);
});
test('pending order and different-account records refuse starts/configuration',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'connect'});
  const state=initialState(config,credentials.apiKey); state.pending={side:'BUY',reason:'unknown result'};
  const path=resolve(f.profile,'.paper-data/testnet-state.json'); await writeFile(path,JSON.stringify(state));
  await assert.rejects(f.c.handle(confirm),/pending/); await assert.rejects(f.c.handle({command:'configure',credentials:{...credentials,apiKey:'C'.repeat(64)}}));
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),state); assert.equal(f.children.length,0);
});
test('stop remains responsive while a read is pending; concurrent configure refused',async()=> {
  const f=await fixture({delayed:true}); await f.c.handle({command:'configure',credentials}); const read=f.c.handle({command:'connect'});
  await assert.rejects(f.c.handle({command:'configure',credentials}),/operation/); await f.c.handle({command:'stop'}); f.release(); await read;
});
test('GUI disconnect gracefully stops worker; no kill, relaunch or clearing state',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); await f.c.handle({command:'connect'}); await f.c.handle(confirm);
  await f.c.disconnect(); assert.match(await readFile(resolve(f.profile,'.paper-data/testnet-stop'),'utf8'),/stop/);
  await assert.rejects(f.c.handle(confirm),/Closing/); assert.equal(f.children.length,1); f.children[0].child.emit('close',0);
});
test('local snapshots expose only selected order fields, no account tags or credentials',async()=> {
  const f=await fixture(); await f.c.handle({command:'configure',credentials}); const state=initialState(config,credentials.apiKey);
  state.orders=[{side:'BUY',time:1,executedQty:1,quoteQty:100,status:'FILLED',apiKey:credentials.apiKey,clientOrderId:'private'}];
  await writeFile(resolve(f.profile,'.paper-data/testnet-state.json'),JSON.stringify(state)); const local=JSON.stringify(await f.c.handle({command:'local'}));
  assert.ok(!local.includes(credentials.apiKey)); assert.ok(!local.includes('accountTag')); assert.ok(!local.includes('private'));
});
test('credentials and PEM material are redacted from line logs',()=> {
  const s=redact(credentials.apiKey+' '+credentials.apiSecret+' -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',credentials);
  assert.ok(!s.includes(credentials.apiKey)); assert.ok(!s.includes(credentials.apiSecret)); assert.ok(!s.includes('secret'));
});
test('repeated key generation reuses the same key without overwrite and returns public material only',async()=> {
  const f=await fixture(); const result=await f.c.handle({command:'generateKey'});
  assert.match(result.publicKey,/BEGIN PUBLIC KEY/); assert.ok(!JSON.stringify(result).includes('BEGIN PRIVATE KEY'));
  const first=await readFile(result.privateKeyPath); const reused=await f.c.handle({command:'generateKey'});
  assert.equal(reused.reused,true); assert.equal(reused.publicKey,result.publicKey); assert.deepEqual(await readFile(result.privateKeyPath),first);
  const status=await f.c.handle({command:'keyStatus'}); assert.equal(status.exists,true); assert.equal(status.privateKeyPath,result.privateKeyPath);
  assert.ok(!JSON.stringify(status).includes('BEGIN PRIVATE KEY')); assert.equal(f.calls.length,0); assert.equal(f.children.length,0);
});

test('lost public file is recovered from the original private key; a missing private key never gets replaced',async()=> {
  const f=await fixture(); assert.equal((await f.c.handle({command:'keyStatus'})).exists,false);
  const pair=await f.c.handle({command:'generateKey'}), first=await readFile(pair.privateKeyPath);
  const publicPath=resolve(f.profile,'keys/testnet-public.pem'); await unlink(publicPath);
  const recovered=await f.c.handle({command:'generateKey'}); assert.equal(recovered.publicKey,pair.publicKey);
  assert.deepEqual(await readFile(pair.privateKeyPath),first); assert.equal(await readFile(publicPath,'utf8'),pair.publicKey);
  await unlink(pair.privateKeyPath); await assert.rejects(f.c.handle({command:'generateKey'}),/配套私钥缺失/);
  await assert.rejects(readFile(pair.privateKeyPath),/ENOENT/); assert.equal(await readFile(publicPath,'utf8'),pair.publicKey);
});

test('malformed existing public key is preserved and wrong credential categories have actionable non-secret errors',async()=> {
  const f=await fixture(); const pair=await f.c.handle({command:'generateKey'}), first=await readFile(pair.privateKeyPath);
  const publicPath=resolve(f.profile,'keys/testnet-public.pem'); await writeFile(publicPath,'broken-public-file');
  await assert.rejects(f.c.handle({command:'generateKey'}),/不配套/); assert.deepEqual(await readFile(pair.privateKeyPath),first);
  assert.equal(await readFile(publicPath,'utf8'),'broken-public-file');
  for (const [value,expected] of [['apik_fixture-merchant-key',/Whop 商户/],['A-FIXTURE-SOFTWARE-LICENSE',/软件许可证/],['-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----',/PEM 公钥/]]) {
    assert.throws(()=>validateCredentials({...credentials,apiKey:value}), error=>expected.test(error.message) && !error.message.includes(value));
  }
});
test('unsupported IPC commands never launch a process',async()=> {
  const f=await fixture(); for(const command of ['exec','withdraw','live','buy','sell','adopt','kill']) await assert.rejects(f.c.handle({command})); assert.equal(f.children.length,0);
});
test('archive is deterministic and rejects traversal, duplicates or invalid content',()=> {
  const entries=[{path:'Setup.exe',data:Buffer.from('test')}]; const result=archive(entries); assert.equal(result.readUInt32LE(0),0x04034b50); assert.equal(sha(result),sha(archive(entries)));
  for(const path of ['../secret','/abs','C:/key','foo\\bar','a/../../b']) assert.throws(()=>archive([{path,data:Buffer.from('x')}]));
  assert.throws(()=>archive([...entries,...entries])); assert.throws(()=>archive([{path:'x',data:'not Buffer'}])); assert.equal(NODE_SHA.length,64); assert.ok(DESKTOP_FILES.includes('desktop.test.mjs'));
});
