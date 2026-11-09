import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLicenseManager, createLeaseGuard, verifyLease, validatePublicConfig, AUDIENCE, LICENSE_REQUEST_MS } from './license.mjs';
import { createController } from './controller.mjs';
const pair=generateKeyPairSync('ed25519');
const config={endpoint:'https://license.example.com/api/validate',publicKey:pair.publicKey.export({type:'spki',format:'pem'}),companyId:'biz_test',productId:'prod_test',planIds:['plan_monthly']};
const start=Date.UTC(2026,9,24);
const encode=c=>{const p=Buffer.from(JSON.stringify(c)).toString('base64url');return p+'.'+sign(null,Buffer.from(p),pair.privateKey).toString('base64url');};
const claims=(session,nonce= randomUUID(),time=start)=>({v:1,aud:AUDIENCE,companyId:'biz_test',productId:'prod_test',planId:'plan_monthly',session,nonce,issuedAt:time,expiresAt:time+120000,paidUntil:time+86400000});
test('public configuration rejects HTTP, foreign shape, missing plans and wrong signing type',()=>{
  assert.doesNotThrow(()=>validatePublicConfig(config));for(const c of [{...config,endpoint:'http://localhost/api/validate'},{...config,publicKey:''},{...config,planIds:[]},{...config,apiKey:'secret'}])assert.throws(()=>validatePublicConfig(c));
});
test('public build config must never contain a private signing key',()=>{
  assert.throws(()=>validatePublicConfig({...config,publicKey:pair.privateKey.export({type:'pkcs8',format:'pem'})}));
});
test('different nonces in the same issued millisecond are valid; exact replay is refused',()=>{
  const session=randomUUID(),guard=createLeaseGuard({config,session,now:()=>start});
  const first=encode(claims(session)),second=encode(claims(session));guard.accept(first);assert.doesNotThrow(()=>guard.accept(second));assert.throws(()=>guard.accept(second),/Replayed/);assert.equal(guard.active(),true);
});
test('oversized chunked licensing response is canceled without reading it all',async()=>{
  let reads=0,canceled=false;const manager=createLicenseManager({config,autoMonitor:false,fetchImpl:async()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(8192));if(reads===100)c.close();},cancel(){canceled=true;}}))});
  await assert.rejects(manager.activate('TEST-ONLY-LICENSE-1234'));assert.equal(manager.active(),false);assert.equal(canceled,true);assert.ok(reads<100);manager.dispose();
});
test('signed grants reject tampering, wrong product/session/nonce, expiry and oversized TTL',()=>{
  const session=randomUUID(),nonce=randomUUID(),c=claims(session,nonce);
  assert.equal(verifyLease(encode(c),{config,session,nonce,now:start}).aud,AUDIENCE);
  for(const token of [encode({...c,productId:'prod_other'}),encode({...c,expiresAt:start+120001}),encode({...c,paidUntil:start}),encode({...c,issuedAt:start+11000}),encode(c).slice(1)])assert.throws(()=>verifyLease(token,{config,session,nonce,now:start}));
  assert.throws(()=>verifyLease(encode(c),{config,session:randomUUID(),nonce,now:start}));
  assert.throws(()=>verifyLease(encode(c),{config,session,nonce:randomUUID(),now:start}));
  assert.throws(()=>verifyLease(encode(c),{config,session,nonce,now:start+120000}));
});
test('wall clock rollback cannot extend an existing lease; replay cannot renew monotonic deadline',()=>{
  let wall=start,clock=0;const session=randomUUID(),guard=createLeaseGuard({config,session,now:()=>wall,mono:()=>clock});const token=encode(claims(session));
  guard.accept(token);assert.equal(guard.active(),true);clock=120000;wall=start-50000;assert.equal(guard.active(),false);assert.throws(()=>guard.accept(token),/Replayed|expired/);
});
test('an expired or stopped worker grant cannot be revived by a later IPC token',()=>{
  const session=randomUUID(),guard=createLeaseGuard({config,session,now:()=>start});guard.accept(encode(claims(session)));guard.clear();assert.throws(()=>guard.accept(encode(claims(session,randomUUID(),start+1))));assert.equal(guard.active(),false);
});
test('missing production config is locked and does not perform a fake activation',async()=>{
  const manager=createLicenseManager({config:{},autoMonitor:false});await assert.rejects(manager.activate('TEST-ONLY-LICENSE-1234'));await assert.rejects(manager.activate('TEST-ONLY-LICENSE-1234'));assert.equal(manager.active(),false);manager.dispose();
});
test('periodic validation loss requests a stop, does not auto-restart; no account details are sent',async()=>{
  let wall=start,clock=0,offline=false,stops=0;const requests=[];
  const manager=createLicenseManager({config,now:()=>wall,mono:()=>clock,autoMonitor:false,onInvalid:()=>{stops++;},fetchImpl:async(url,o)=>{
    assert.equal(url,config.endpoint);requests.push(JSON.parse(o.body));if(offline)throw new Error('network down');
    const req=requests.at(-1);const c=claims(req.session,req.nonce,wall);const {createHash}=await import('node:crypto');c.licenseHash=createHash('sha256').update(req.licenseKey).digest('hex');return new Response(JSON.stringify({active:true,token:encode(c)}));
  }});
  await manager.activate('TEST-ONLY-LICENSE-1234');assert.equal(manager.active(),true);
  assert.deepEqual(Object.keys(requests[0]).sort(),['licenseKey','nonce','session']);offline=true;wall+=30001;clock+=30001;await manager.tick();assert.equal(manager.active(),false);assert.equal(stops,1);offline=false;await manager.tick();assert.equal(requests.length,2);manager.dispose();
});
test('actual controller refuses unlicensed starts even if GUI and account say allowed',async()=>{
  const profile=await mkdtemp(resolve(tmpdir(),'subscription-controller-'));let spawned=0;
  const policy=JSON.parse(await readFile(new URL('../../strategies/virtual-only.json',import.meta.url),'utf8'));
  const c=await createController({profile,policy,emit:()=>{},spawnImpl:()=>{spawned++;},clientFactory:()=>({syncTime:async()=>{},request:async()=>({canTrade:true,balances:[]})})});
  await c.handle({command:'configure',credentials:{apiKey:'A'.repeat(64),apiSecret:'B'.repeat(64),privateKeyPath:''}});await c.handle({command:'connect'});
  await assert.rejects(c.handle({command:'start',confirmVirtualOnly:true,confirmNoOtherBot:true}),/订阅核验/);assert.equal(spawned,0);
  assert.equal((await c.handle({command:'licenseStatus'})).active,false);assert.equal((await c.handle({command:'local'})).running,false);await c.handle({command:'stop'});await c.disconnect();
});

test('license diagnostics distinguish timeout, denial and invalid signature without echoing upstream secrets',async()=>{
  assert.ok(LICENSE_REQUEST_MS>8000 && LICENSE_REQUEST_MS<30000);
  for(const [expected,fetchImpl] of [
    ['request_timeout',async()=>{throw new DOMException('private-upstream-error-do-not-echo','TimeoutError');}],
    ['http_403',async()=>new Response('private-upstream-error-do-not-echo',{status:403})],
    ['signature',async()=>Response.json({active:true,token:'invalid-signature'})]
  ]){
    const manager=createLicenseManager({config,autoMonitor:false,fetchImpl});
    await assert.rejects(manager.activate('TEST-ONLY-LICENSE-1234'));assert.equal(manager.status().lastErrorCode,expected);
    const safe=JSON.stringify(manager.status());assert.ok(!safe.includes('TEST-ONLY-LICENSE'));assert.ok(!safe.includes('private-upstream-error'));assert.equal(manager.active(),false);manager.dispose();
  }
});

test('an in-flight slower validation cannot revive a lease that expired while waiting',async()=>{
  let wall=start,clock=0,calls=0,release,request;
  const signed=async body=>{const c=claims(body.session,body.nonce,wall);const {createHash}=await import('node:crypto');c.licenseHash=createHash('sha256').update(body.licenseKey).digest('hex');return Response.json({active:true,token:encode(c)});};
  const manager=createLicenseManager({config,autoMonitor:false,now:()=>wall,mono:()=>clock,fetchImpl:async(url,options)=>{
    request=JSON.parse(options.body);if(++calls===1)return signed(request);return new Promise(resolve=>{release=resolve;});
  }});
  await manager.activate('TEST-ONLY-LICENSE-1234');wall+=30001;clock+=30001;const waiting=manager.refresh().catch(()=>{});await Promise.resolve();
  wall=start+120001;clock=120001;await manager.tick();assert.equal(manager.active(),false);
  release(await signed(request));await waiting;assert.equal(manager.active(),false);manager.dispose();
});
test('revocation IPC reaches a running worker and records remain readable',async()=>{
  const profile=await mkdtemp(resolve(tmpdir(),'subscription-revoke-'));const policy=JSON.parse(await readFile(new URL('../../strategies/virtual-only.json',import.meta.url),'utf8'));
  let invalid;const sent=[];const child=new EventEmitter();child.connected=true;child.stdout=new PassThrough();child.stderr=new PassThrough();child.send=x=>sent.push(x);
  const c=await createController({profile,policy,emit:()=>{},clientFactory:()=>({syncTime:async()=>{},request:async()=>({canTrade:true,balances:[]})}),spawnImpl:()=>child,
    licenseFactory:options=>{invalid=options.onInvalid;return {status:()=>({active:true}),active:()=>true,refresh:async()=>{},dispose(){},session:randomUUID(),token:()=> 'test-not-a-valid-worker-token'};}});
  await c.handle({command:'configure',credentials:{apiKey:'A'.repeat(64),apiSecret:'B'.repeat(64),privateKeyPath:''}});await c.handle({command:'connect'});await c.handle({command:'start',confirmVirtualOnly:true,confirmNoOtherBot:true});
  await invalid();assert.ok(sent.some(m=>m.command==='stop'));assert.match(await readFile(resolve(profile,'.paper-data/testnet-stop'),'utf8'),/stop/);assert.deepEqual((await c.handle({command:'local'})).orders,[]);child.emit('close',0);await c.disconnect();
});
test('worker validates signed IPC lease before loading runner and before outbound fetches',async()=>{
  const source=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');assert.ok(source.indexOf('await Promise.race')<source.indexOf("await import('../../scripts/testnet.mjs')"));assert.match(source,/!subscription.active\(\)/);assert.match(source,/subscription.accept\(message.token\)/);
});
