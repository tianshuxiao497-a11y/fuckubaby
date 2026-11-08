import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,createPrivateKey} from 'node:crypto';
import {mkdtemp,readFile,cp,rm,mkdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {attachProof,verifyDeviceProof} from './device-protocol.mjs';
import {claimSeat,releaseSeat,resetSeat} from './device-seats.mjs';
import {loadDeviceIdentity} from '../adaptive-spot-desktop/device-identity.mjs';
function storage(){let state,queue=Promise.resolve();return {transaction(fn){const task=queue.then(()=>fn({get:async()=>structuredClone(state),put:async(k,v)=>{state=structuredClone(v);}}));queue=task.catch(()=>{});return task;}};}
const a='a'.repeat(64),b='b'.repeat(64),time=1794132000000;
const request=(deviceHash,extra={})=>({deviceHash,session:randomUUID(),nonce:randomUUID(),now:time,paidUntil:time+86400000,...extra});
test('two simultaneous first-device registrations allocate only one device',async()=>{
  const store=storage();const result=await Promise.all([claimSeat(store,request(a)),claimSeat(store,request(b))]);
  assert.equal(result.filter(r=>r.ok).length,1);assert.equal(result.find(r=>!r.ok).reason,'device_limit_reached');
});
test('binding survives session expiry and permits only the same device',async()=>{
  const store=storage(),first=request(a);assert.ok((await claimSeat(store,first)).ok);
  assert.equal((await claimSeat(store,request(b,{now:time+999999}))).reason,'device_limit_reached');
  assert.ok((await claimSeat(store,request(a,{now:time+999999}))).ok);
});
test('same device heartbeat renews, simultaneous second session refuses, release keeps device bound',async()=>{
  const store=storage(),first=request(a);await claimSeat(store,first);
  assert.ok((await claimSeat(store,{...first,nonce:randomUUID(),now:time+30000})).ok);
  assert.equal((await claimSeat(store,request(a,{now:time+30001}))).reason,'session_in_use');
  assert.equal((await releaseSeat(store,{deviceHash:a,session:randomUUID()})).ok,false);
  assert.ok((await releaseSeat(store,first)).ok);
  assert.equal((await claimSeat(store,request(b))).reason,'device_limit_reached');
  assert.ok((await claimSeat(store,request(a))).ok);
});
test('nonce replay is refused and renewal does not outlive the paid term',async()=>{
  const store=storage(),first=request(a,{paidUntil:time+5000});
  assert.equal((await claimSeat(store,first)).expiresAt,time+5000);
  assert.equal((await claimSeat(store,first)).reason,'replayed_request');
  assert.equal((await claimSeat(store,request(a,{paidUntil:time}))).ok,false);
});
test('seller reset requires the expected binding and waits for outstanding leases before rebinding',async()=>{
  const store=storage();await claimSeat(store,request(a));
  assert.equal((await resetSeat(store,{expectedDeviceHash:b,nonce:randomUUID(),now:time})).ok,false);
  const reset=await resetSeat(store,{expectedDeviceHash:a,nonce:randomUUID(),now:time+1000});assert.ok(reset.ok);
  assert.equal((await claimSeat(store,request(b,{now:time+119999}))).reason,'device_reset_wait');
  assert.ok((await claimSeat(store,request(b,{now:time+120001}))).ok);
  assert.equal((await claimSeat(store,request(a,{now:time+120002}))).reason,'device_limit_reached');
});
test('signed device proof is bound to license, action, session, nonce, timestamp and key',()=>{
  const {privateKey}=generateKeyPairSync('ed25519');
  const body=attachProof({licenseKey:'QA-LICENSE-NOT-A-CUSTOMER-KEY',session:randomUUID(),nonce:randomUUID(),timestamp:time},privateKey);
  assert.ok(verifyDeviceProof(body,time));
  for(const patch of [{licenseKey:'DIFFERENT-LICENSE-NOT-CUSTOMER'},{session:randomUUID()},{nonce:randomUUID()},{timestamp:time+1},{action:'release'},{extra:'refuse'}])assert.equal(verifyDeviceProof({...body,...patch},time),null);
  assert.equal(verifyDeviceProof(body,time+45001),null);
});
test('sealed identity survives restart but a copied profile does not unlock on another machine',async()=>{
  const parent=resolve('tmp/device-identity-tests');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(resolve(parent,'profile-')),copy=dir+'-copy';
  try{
    const first=await loadDeviceIdentity(dir,{machineProvider:async()=>Buffer.alloc(32,1)});
    const second=await loadDeviceIdentity(dir,{machineProvider:async()=>Buffer.alloc(32,1)});
    assert.equal(first.deviceHash,second.deviceHash);
    assert.doesNotMatch(await readFile(resolve(dir,'device/identity-v2.json'),'utf8'),/PRIVATE KEY/);
    await cp(dir,copy,{recursive:true});
    await assert.rejects(loadDeviceIdentity(copy,{machineProvider:async()=>Buffer.alloc(32,2)}),/does_not_match_machine/);
    const proof=attachProof({licenseKey:'QA-LICENSE-NOT-A-CUSTOMER-KEY',session:randomUUID(),nonce:randomUUID(),timestamp:time},first.privateKey);
    assert.equal(verifyDeviceProof(proof,time).deviceHash,first.deviceHash);
  }finally{for(const target of [dir,copy]){const path=relative(parent,resolve(target));assert.ok(path&&!path.startsWith('..')&&!isAbsolute(path));await rm(target,{recursive:true,force:true});}}
});
