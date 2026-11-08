import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createDeviceWorker,LicenseDeviceSeats} from './device-worker.mjs';
import {attachProof,hash} from '../subscription-service/device-protocol.mjs';
import {verifyLease,createLicenseManager} from '../adaptive-spot-desktop/license-device.mjs';
function fixture(){
  let clock=1794132000000,status='active';const signer=generateKeyPairSync('ed25519');
  const objects=new Map();const env={WHOP_API_KEY:'OFFLINE-TEST-ONLY-NOT-A-KEY',WHOP_COMPANY_ID:'biz_KAiAyPYUEaP2l1',WHOP_PRODUCT_ID:'prod_KIUnn09xAwsal',WHOP_PLAN_IDS:'plan_hDSOoWy649Nus',LICENSE_SIGNING_PRIVATE_KEY:signer.privateKey.export({type:'pkcs8',format:'pem'}),ASB_RATE_LIMITER:{limit:async()=>({success:true})},ASB_DEVICE_SEATS:{idFromName:name=>name,get(name){
    if(!objects.has(name)){
      let state,queue=Promise.resolve();const storage={transaction(fn){const task=queue.then(()=>fn({get:async()=>structuredClone(state),put:async(k,v)=>{state=structuredClone(v);}}));queue=task.catch(()=>{});return task;}};
      const instance=new LicenseDeviceSeats({storage});objects.set(name,{fetch:(url,init)=>instance.fetch(new Request(url,init))});
    }return objects.get(name);
  }}};
  const licenseKey='QA-DEVICE-WORKER-NOT-REAL';
  const worker=createDeviceWorker({now:()=>clock,fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.whop.com/api/v1/memberships/'+licenseKey);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
    return Response.json({license_key:licenseKey,company:{id:env.WHOP_COMPANY_ID},product:{id:env.WHOP_PRODUCT_ID},plan:{id:env.WHOP_PLAN_IDS},status,valid:status==='active',renewal_period_end:new Date(clock+30*86400000).toISOString()});
  }});
  const config={endpoint:'https://fixture.invalid/api/validate',companyId:env.WHOP_COMPANY_ID,productId:env.WHOP_PRODUCT_ID,planIds:[env.WHOP_PLAN_IDS],publicKey:signer.publicKey.export({type:'spki',format:'pem'})};
  const send=body=>worker.fetch(new Request(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  const key=()=>generateKeyPairSync('ed25519').privateKey;
  const proof=(privateKey,extra={})=>attachProof({licenseKey,session:randomUUID(),nonce:randomUUID(),timestamp:clock,...extra},privateKey);
  return {send,key,proof,config,licenseKey,objects,env,worker,signer,clock:()=>clock,advance:ms=>{clock+=ms;},status:value=>{status=value;}};
}
test('fresh valid membership binds one device, rejects a second device, and signs a device-bound lease',async()=>{
  const f=fixture(),a=f.key(),body=f.proof(a);const r=await f.send(body);assert.equal(r.status,200);
  const result=await r.json(),expectedHash=hash(body.devicePublicKey);
  const claim=verifyLease(result.token,{config:f.config,...body,deviceHash:expectedHash,now:f.clock()});assert.equal(claim.v,2);assert.equal(claim.deviceHash,expectedHash);
  assert.throws(()=>verifyLease(result.token,{config:f.config,...body,deviceHash:'a'.repeat(64),now:f.clock()}));
  const blocked=await f.send(f.proof(f.key()));assert.equal(blocked.status,409);assert.equal((await blocked.json()).reason,'device_limit_reached');
});
test('an inactive membership cannot reserve or steal the single device seat',async()=>{
  const f=fixture();f.status('canceled');assert.equal((await f.send(f.proof(f.key()))).status,403);assert.equal(f.objects.size,0);
  f.status('active');assert.equal((await f.send(f.proof(f.key()))).status,200);
});
test('legacy clients cannot receive unbound grants once the device worker is enabled',async()=>{
  const f=fixture(),r=await f.send({licenseKey:f.licenseKey,session:randomUUID(),nonce:randomUUID()});assert.equal(r.status,426);assert.equal((await r.json()).reason,'client_upgrade_required');
});
test('client manager authenticates each refresh and release without exposing a private device key',async()=>{
  const f=fixture(),privateKey=f.key();let invalidations=0,seen=0;
  const manager=createLicenseManager({config:f.config,now:f.clock,mono:f.clock,autoMonitor:false,identityFactory:async()=>({privateKey,deviceHash:hash(f.proof(privateKey).devicePublicKey)}),fetchImpl:async(url,init)=>{assert.equal(url,f.config.endpoint);assert.doesNotMatch(init.body,/PRIVATE KEY/);seen++;return f.send(JSON.parse(init.body));},onInvalid:()=>{invalidations++;}});
  try{
    assert.ok((await manager.activate(f.licenseKey)).active);f.advance(30001);await manager.tick();assert.ok(manager.active());assert.equal(seen,2);
    f.status('canceled');f.advance(30001);await manager.tick();assert.equal(manager.active(),false);assert.equal(invalidations,1);
  }finally{manager.dispose();}
});
test('private-key owner can release the current session but cannot remove the persistent binding',async()=>{
  const f=fixture(),a=f.key(),body=f.proof(a);await f.send(body);
  assert.equal((await f.send(f.proof(a,{session:body.session,action:'release'}))).status,200);
  assert.equal((await f.send(f.proof(f.key()))).status,409);
  assert.equal((await f.send(f.proof(a))).status,200);
});
test('administrative rebinding requires the seller signature and respects the old lease expiry',async()=>{
  const f=fixture(),a=f.key(),body=f.proof(a);await f.send(body);
  const reset={licenseHash:hash(f.licenseKey),expectedDeviceHash:hash(body.devicePublicKey),nonce:randomUUID(),timestamp:f.clock()};
  const payload=JSON.stringify(['AdaptiveSpotBot.DeviceReset.v2',f.env.WHOP_COMPANY_ID,f.env.WHOP_PRODUCT_ID,reset.licenseHash,reset.expectedDeviceHash,reset.nonce,reset.timestamp]);
  const call=signature=>f.worker.fetch(new Request('https://fixture.invalid/api/device-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...reset,signature})}),f.env);
  assert.equal((await call(sign(null,Buffer.from(payload),f.key()).toString('base64url'))).status,403);
  assert.equal((await call(sign(null,Buffer.from(payload),f.signer.privateKey).toString('base64url'))).status,200);
  assert.equal((await f.send(f.proof(f.key()))).status,409);f.advance(120001);assert.equal((await f.send(f.proof(f.key()))).status,200);
});
