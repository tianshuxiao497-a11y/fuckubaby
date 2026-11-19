import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createCustomerWorkbench} from './workbench.mjs';

async function fixture(t){
  const base=resolve('tmp/live-customer-tests');await mkdir(base,{recursive:true});
  const profile=await mkdtemp(resolve(base,'profile-'));let active=false,brokerCalls=0,onInvalid;
  const licenseFactory=options=>{onInvalid=options.onInvalid;return {active:()=>active,status:()=>({configured:true,active,status:active?'active':'not_activated'}),activate:async()=>{},refresh:async()=>{},dispose(){}};};
  const factory=()=>{brokerCalls++;throw new Error('NO_EXCHANGE_IN_LICENSE_TEST');};
  const app=await createCustomerWorkbench({profile,licenseFactory,spot:{clientFactory:factory},futures:{clientFactory:factory}});
  t.after(()=>app.close());const url=new URL(app.url),headers={'x-asbw-session':url.hash.slice(1)};
  const pages=await (await fetch(url.origin+'/api/pages',{headers})).json();
  const post=(page,path,body={})=>{const u=new URL(page);return fetch(u.origin+'/api/'+path,{method:'POST',headers:{Origin:u.origin,'Content-Type':'application/json',[page===app.url?'x-asbw-session':page===pages.spot?'x-asbl-session':'x-asbf-session']:u.hash.slice(1)},body:JSON.stringify(body)});};
  return {app,pages,post,calls:()=>brokerCalls,setActive(value){active=value;if(!value)onInvalid();}};
}
test('customer shell requires the local session and blocks all opening/risk-increase actions before any account access',async t=>{
  const f=await fixture(t),u=new URL(f.app.url);
  assert.equal((await fetch(u.origin+'/api/status')).status,403);
  assert.equal((await f.post(f.pages.spot,'start',{confirmation:'START REAL SPOT TRADING'})).status,403);
  for(const path of ['start','hedge-lock','contract-settings','hedge-mode','add-margin','auto-margin-start']){
    const r=await f.post(f.pages.futures,path);assert.equal(r.status,403,path);assert.equal((await r.json()).error,'ACTIVE_LIVE_SUBSCRIPTION_REQUIRED');
  }
  for(const page of [f.pages.spot,f.pages.futures])assert.equal((await f.post(page,'stop')).status,200);
  assert.equal(f.calls(),0);assert.equal(f.app.status().edition,'customer');assert.equal(f.app.status().license.active,false);
});
test('license activation is local-origin protected, never returns the entered license, and switching license stops both strategies',async t=>{
  const f=await fixture(t),u=new URL(f.app.url),licenseKey='OFFLINE-LICENSE-NOT-A-CUSTOMER';
  const headers={'x-asbw-session':u.hash.slice(1),Origin:'https://attacker.invalid','Content-Type':'application/json'};
  assert.equal((await fetch(u.origin+'/api/license-activate',{method:'POST',headers,body:JSON.stringify({licenseKey})})).status,403);
  assert.equal((await f.post(f.app.url,'license-activate',{apiKey:licenseKey})).status,400);
  f.setActive(true);const r=await f.post(f.app.url,'license-activate',{licenseKey});assert.equal(r.status,200);assert.ok(!(await r.text()).includes(licenseKey));
  f.setActive(false);assert.equal((await f.post(f.pages.spot,'start')).status,403);assert.equal(f.calls(),0);
});
