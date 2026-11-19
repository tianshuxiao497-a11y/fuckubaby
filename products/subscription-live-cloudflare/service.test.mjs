import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { readSettings, validateSubscription, createLimiter, MEMBERSHIP_API_VERSION, OWNER_TEST_UNTIL } from './service.mjs';
const pair=generateKeyPairSync('ed25519');
const settings=readSettings({WHOP_API_KEY:'merchant-test-only',WHOP_COMPANY_ID:'biz_test',WHOP_PRODUCT_ID:'prod_test',WHOP_PLAN_IDS:'plan_monthly',LICENSE_SIGNING_PRIVATE_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'})});
const request={licenseKey:'TEST-ONLY-LICENSE-1234',session:randomUUID(),nonce:randomUUID()};
const now=Date.UTC(2026,9,24);
const base={id:'mem_test',license_key:request.licenseKey,company:{id:'biz_test'},product:{id:'prod_test'},plan:{id:'plan_monthly'},status:'active',renewal_period_end:new Date(now+86400000).toISOString()};
const evaluate=(changes={},opts={})=>validateSubscription(request,{settings,now:()=>now,fetchImpl:async(url,options)=>{
  assert.equal(url,'https://api.whop.com/api/v1/memberships/'+request.licenseKey);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert.equal(MEMBERSHIP_API_VERSION,'2025-01-01');assert.equal(options.headers['Api-Version-Date'],MEMBERSHIP_API_VERSION);
  return new Response(JSON.stringify({...base,...changes}),{status:200});
},...opts});
test('service requires real server configuration and Ed25519 signing',()=>{
  assert.throws(()=>readSettings({}));assert.throws(()=>readSettings({...settings,LICENSE_SIGNING_PRIVATE_KEY:'bad'}));
});
test('server accepts a PEM imported with escaped newlines without exposing it',()=>{
  const escaped=pair.privateKey.export({type:'pkcs8',format:'pem'}).replaceAll('\n','\\n');
  assert.doesNotThrow(()=>readSettings({WHOP_API_KEY:'merchant-test-only',WHOP_COMPANY_ID:'biz_test',WHOP_PRODUCT_ID:'prod_test',WHOP_PLAN_IDS:'plan_monthly',LICENSE_SIGNING_PRIVATE_KEY:escaped}));
});
test('active matching monthly membership grants only a short signed lease, no identities/secrets',async()=>{
  const r=await evaluate();assert.equal(r.status,200);const c=JSON.parse(Buffer.from(r.body.token.split('.')[0],'base64url'));
  assert.equal(c.expiresAt,now+120000);assert.equal(c.session,request.session);assert.equal(c.nonce,request.nonce);
  assert.ok(!JSON.stringify(r).includes(settings.apiKey));assert.ok(!JSON.stringify(r).includes(request.licenseKey));
});
test('cancellation at period end keeps access until expiry',async()=>{assert.equal((await evaluate({cancel_at_period_end:true,canceled_at:new Date(now).toISOString()})).status,200);});

test('only an exact seller-provisioned test key receives a revocable perpetual entitlement without payment',async()=>{
  const hash=createHash('sha256').update(request.licenseKey).digest('hex');
  const granted={...settings,ownerTestLicenseHashes:[hash]};let calls=0;
  const r=await evaluate({status:'canceled',renewal_period_end:null},{settings:granted,fetchImpl:async()=>{calls++;throw new Error('No merchant request for independent seller grant');}});
  assert.equal(r.status,200);assert.equal(calls,0);
  const claims=JSON.parse(Buffer.from(r.body.token.split('.')[0],'base64url'));
  assert.equal(claims.entitlement,'seller_test');assert.equal(claims.perpetual,true);
  assert.equal(claims.paidUntil,OWNER_TEST_UNTIL);assert.equal(claims.expiresAt,now+120000);
  assert.equal(claims.planId,settings.planIds[0]);assert.equal(claims.cancelAtPeriodEnd,false);
  assert.equal((await evaluate({renewal_period_end:null},{settings:{...settings,ownerTestLicenseHashes:['a'.repeat(64)]}})).status,403);
  // Revoking the exact grant restores the ordinary monthly checks, without
  // extending any previously signed two-minute lease.
  assert.equal((await evaluate({status:'canceled',renewal_period_end:null},{settings:{...granted,ownerTestLicenseHashes:[]}})).status,403);
});

test('seller grants accept only bounded SHA256 digests, never raw keys or a wildcard',()=>{
  const env={WHOP_API_KEY:settings.apiKey,WHOP_COMPANY_ID:settings.companyId,WHOP_PRODUCT_ID:settings.productId,WHOP_PLAN_IDS:settings.planIds[0],LICENSE_SIGNING_PRIVATE_KEY:settings.signingKey};
  for(const value of ['*',request.licenseKey,'A'.repeat(64),Array(9).fill('a'.repeat(64)).join(',')])assert.throws(()=>readSettings({...env,ASB_OWNER_TEST_LICENSE_HASHES:value}));
  assert.deepEqual(readSettings(env).ownerTestLicenseHashes,[]);
  assert.deepEqual(readSettings({...env,ASB_OWNER_TEST_LICENSE_HASHES:'a'.repeat(64)}).ownerTestLicenseHashes,['a'.repeat(64)]);
});
test('wrong business/product/plan/key, expired and perpetual dates are denied',async()=>{
  for(const value of [{company:{id:'biz_other'}},{product:{id:'prod_other'}},{plan:{id:'plan_lifetime'}},{license_key:'wrong'},{valid:false},{renewal_period_end:null},{renewal_period_end:'bad'},{renewal_period_end:new Date(now).toISOString()},{payment_collection_paused:true}]) assert.equal((await evaluate(value)).status,403,JSON.stringify(value));
});
test('revoked/past-due/canceled/completed memberships cannot run monthly edition',async()=>{
  for(const status of ['canceled','expired','past_due','paused','completed','unresolved','drafted','revoked'])assert.equal((await evaluate({status})).status,403,status);
});
test('lease never crosses actual billing expiry',async()=>{const r=await evaluate({renewal_period_end:new Date(now+1000).toISOString()});assert.equal(JSON.parse(Buffer.from(r.body.token.split('.')[0],'base64url')).expiresAt,now+1000);});
test('missing config, Whop 401/403/429/500, bad JSON and network error fail closed',async()=>{
  assert.equal((await validateSubscription(request,{})).status,503);
  for(const status of [401,403,429,500]) assert.equal((await evaluate({}, {fetchImpl:async()=>new Response('{}',{status})})).status,503);
  assert.equal((await evaluate({}, {fetchImpl:async()=>new Response('{}',{status:404})})).status,403);
  assert.equal((await evaluate({}, {fetchImpl:async()=>{throw new Error('merchant-test-only');}})).status,503);
  assert.equal((await evaluate({}, {fetchImpl:async()=>new Response('not json')})).status,503);
});
test('validation accepts only license proof, never a plain membership ID or extra credential fields',async()=>{
  for(const r of [{...request,licenseKey:'mem_abcdefghijklmno'},{...request,nonce:'x'},{...request,apiKey:'should-not-be-sent'},{...request,licenseKey:[request.licenseKey]},{...request,session:[request.session]},{...request,nonce:{toString:()=>request.nonce}},null])assert.equal((await validateSubscription(r,{settings})).status,400);
});
test('oversized chunked Whop data is canceled before the complete body is buffered',async()=>{
  let read=0,canceled=false;const stream=new ReadableStream({pull(c){read++;c.enqueue(new Uint8Array(65536));if(read===100)c.close();},cancel(){canceled=true;}});
  const r=await evaluate({}, {fetchImpl:async()=>new Response(stream)});assert.equal(r.status,503);assert.equal(canceled,true);assert.ok(read<100);
});
test('bounded limiter expires old windows',()=>{let t=0;const allow=createLimiter({maximum:2,now:()=>t});assert.equal(allow('ip'),true);assert.equal(allow('ip'),true);assert.equal(allow('ip'),false);t=60000;assert.equal(allow('ip'),true);});
