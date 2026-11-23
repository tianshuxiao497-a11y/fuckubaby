import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFuturesServer} from './server.mjs';
import {loadVault} from '../../spot-live-pilot/live/vault.mjs';
import {fakeExchange} from './testing/fake-exchange.mjs';
import {request} from 'node:http';
const password='fabricated-password-12345',settings={market:'USD_M',symbol:'BTCUSDT',marginMode:'ISOLATED',leverage:5,marginPercent:1,directionMode:'both',dailyLossPercent:20,externalStrategy:null};
async function fixture(t,makeClients){const profile=await mkdtemp(join(tmpdir(),'asbf-server-')),calls=[];const app=await createFuturesServer({profile,pollMs:100000,clientFactory:makeClients??(()=>Object.fromEntries(['USD_M','COIN_M'].map(market=>[market,{disarm(){},request(name){calls.push({market,name});if(name==='catalog')return {symbols:[]};throw new Error('NO_EXCHANGE_ACCESS_IN_SERVER_TEST');}}])))});
  t.after(async()=>{await app.close();await rm(profile,{recursive:true,force:true});});const url=new URL(app.url),headers={'x-asbf-session':url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
  return {app,profile,calls,url,async get(path,override={}){return fetch(url.origin+path,{headers:{...headers,...override}});},async post(name,body={},override={}){const response=await fetch(url.origin+'/api/'+name,{method:'POST',headers:{...headers,...override},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};}};
}
test('an unwriteable vault keeps the previous config and cannot leave a larger unsaved allocation active',async t=>{
  const f=await fixture(t),credentials={apiKey:'fabricated-api',apiSecret:'fabricated-secret'};
  const saved=await f.post('save',{credentials,password,passwordRepeat:password,settings,preferences:{autoConnect:false}});
  assert.equal(saved.status,200);
  const path=join(f.profile,'futures-vault.json'),before=await readFile(path);
  // The vault must back up its previous encrypted file before it can replace it.
  await writeFile(join(f.profile,'backups'),'occupied by a regular file',{flag:'wx'});
  const failed=await f.post('settings',{password,settings:{...settings,marginPercent:10,leverage:102},preferences:{autoConnect:true}});
  assert.equal(failed.status,400);
  assert.equal(failed.value.error,'FUTURES_SETTINGS_NOT_SAVED_UNLOCK_PREVIOUS');
  assert.deepEqual(await readFile(path),before);
  assert.equal(f.app.status().unlocked,false);
  assert.equal(f.app.status().settings,null);
  assert.equal(f.app.status().preferences.autoConnect,false);
  assert.equal((await f.post('start',{confirmation:'START REAL FUTURES TRADING'})).value.error,'SAVE_OR_UNLOCK_FUTURES_CONFIGURATION');
  const restored=await f.post('unlock',{password});
  assert.equal(restored.status,200);
  assert.equal(restored.value.settings.marginPercent,settings.marginPercent);
  assert.equal(restored.value.settings.leverage,settings.leverage);
  assert.deepEqual(f.calls,[]);
});

for(const interrupt of [false,true])test('a manual restart during a background read '+(interrupt?'honors a newer stop':'waits for the read and can start again'),async t=>{
  const exchange=await fakeExchange(t,{hedge:false,positionPolicy:'single'});
  const f=await fixture(t,()=>exchange.clients),confirmation='START REAL FUTURES TRADING';
  const initial=await f.post('save',{password,passwordRepeat:password,credentials:{apiKey:'fake',apiSecret:'fake-secret'},settings:exchange.settings,preferences:{autoConnect:true}});
  assert.equal(initial.status,200);
  assert.equal((await f.post('start',{confirmation})).value.running,true);
  assert.equal((await f.post('stop')).value.running,false);
  let entered,release;
  const beganReading=new Promise(resolve=>{entered=resolve;});
  const readGate=new Promise(resolve=>{release=resolve;});
  const dollar=exchange.clients.USD_M,request=dollar.request.bind(dollar);
  let paused=false;
  dollar.request=async(name,args)=>{
    if(!paused&&name==='account'){paused=true;entered();await readGate;}
    return request(name,args);
  };
  const monitoring=f.app.monitor();
  let restarting;
  try{
    await Promise.race([beganReading,monitoring.then(()=>{throw new Error('Expected the offline account read to wait');})]);
    restarting=f.post('start',{confirmation});
    for(let i=0;i<300&&!f.app.status().logs.some(row=>row.event==='FUTURES_START_WAITING_FOR_ACCOUNT_CHECK');i++)await delay(10);
    assert.ok(f.app.status().logs.some(row=>row.event==='FUTURES_START_WAITING_FOR_ACCOUNT_CHECK'));
    if(interrupt)assert.equal((await f.post('stop')).status,200);
  }finally{release();}
  await monitoring;
  const result=await restarting;
  if(interrupt){assert.equal(result.status,400);assert.equal(result.value.error,'FUTURES_START_CANCELLED');}
  else assert.equal(result.status,200);
  assert.equal(f.app.status().running,!interrupt);
  assert.equal(exchange.calls.some(row=>['newOrder','newProtection','setLeverage','setMargin'].includes(row.name)),false);
});

test('local session, Host and Origin protections reject unauthorised actions with no exchange access',async t=>{
  const f=await fixture(t);assert.equal((await f.get('/api/status',{'x-asbf-session':'wrong'})).status,403);
  const hostStatus=await new Promise((ok,bad)=>{const req=request(f.url.origin+'/api/status',{headers:{Host:'attacker.invalid','x-asbf-session':f.url.hash.slice(1)}},res=>{res.resume();ok(res.statusCode);});req.on('error',bad);req.end();});assert.equal(hostStatus,403);
  assert.equal((await f.post('start',{}, {Origin:'https://attacker.invalid'})).status,403);assert.equal((await f.post('start',{confirmation:'START REAL FUTURES TRADING'})).status,400);assert.equal(f.calls.length,0);
});
test('unconfigured renderer assets are local, script-isolated and do not expose session tokens',async t=>{
  const f=await fixture(t);for(const path of ['/','/ui.js','/ui.css','/example-futures-strategy.json']){const response=await f.get(path);assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes(f.url.hash.slice(1)));assert.equal(response.headers.get('x-frame-options'),'DENY');}
});
test('bundled Chinese glyphs are served as the original binary WOFF2, without external font requests',async t=>{
  const f=await fixture(t),response=await f.get('/fonts/AdaptiveNotoSansSC.woff2');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'font/woff2');
  const data=Buffer.from(await response.arrayBuffer());assert.equal(data.subarray(0,4).toString(),'wOF2');assert.deepEqual(data,await readFile(new URL('./fonts/AdaptiveNotoSansSC.woff2',import.meta.url)));assert.equal(f.calls.length,0);
});
test('public contract catalog uses the selected family without an encrypted account or broker writes',async t=>{
  const f=await fixture(t);assert.equal((await f.post('catalog',{market:'COIN_M'})).status,200);assert.deepEqual(f.calls,[{market:'COIN_M',name:'catalog'}]);assert.equal((await f.post('catalog',{market:'OTHER'})).status,400);
});
test('save encrypts credentials; unlock does not trade; wrong password cannot replace existing account data',async t=>{
  const f=await fixture(t),credentials={apiKey:'fabricated-api',apiSecret:'fabricated-secret'};
  const saved=await f.post('save',{credentials,password,passwordRepeat:password,settings,preferences:{autoConnect:false}});assert.equal(saved.status,200);assert.equal(saved.value.running,false);assert.equal(f.calls.length,0);
  const raw=await readFile(join(f.profile,'futures-vault.json'),'utf8');assert.ok(!raw.includes(credentials.apiKey));assert.ok(!raw.includes(credentials.apiSecret));assert.ok(!JSON.stringify(saved.value).includes(credentials.apiKey));
  await f.post('lock');assert.equal((await f.post('unlock',{password:'incorrect-password-long'})).status,400);assert.equal((await f.post('unlock',{password})).status,200);assert.equal(f.calls.length,0);
  assert.equal((await f.post('save',{credentials,password,passwordRepeat:password,settings,preferences:{autoConnect:false}})).status,400);assert.equal(await readFile(join(f.profile,'futures-vault.json'),'utf8'),raw);
});
test('generated RSA private key is encrypted, recoverable and never regenerated after a wrong password',async t=>{
  const f=await fixture(t),first=await f.post('generate-key',{password});assert.equal(first.status,200);assert.match(first.value.publicKey,/BEGIN PUBLIC KEY/);assert.match(first.value.privateKeyPem,/BEGIN PRIVATE KEY/);
  const file=join(f.profile,'futures-registration-key.json'),raw=await readFile(file,'utf8');assert.ok(!raw.includes('BEGIN PRIVATE KEY'));assert.equal((await f.post('generate-key',{password:'incorrect-password-long'})).status,400);assert.equal(await readFile(file,'utf8'),raw);
  const second=await f.post('generate-key',{password});assert.equal(second.value.reused,true);assert.equal(second.value.publicKey,first.value.publicKey);
});
test('invalid external strategy and wrong password preserve saved settings; local changes cause no exchange writes',async t=>{
  const f=await fixture(t);await f.post('save',{credentials:{apiKey:'fake',apiSecret:'fake-secret'},password,passwordRepeat:password,settings,preferences:{autoConnect:false}});
  const before=await readFile(join(f.profile,'futures-vault.json'),'utf8');assert.equal((await f.post('strategy',{password,text:'{"code":"run"}'})).status,400);assert.equal(await readFile(join(f.profile,'futures-vault.json'),'utf8'),before);
  assert.equal((await f.post('settings',{password:'wrong-password-long',settings:{...settings,marginPercent:2},preferences:{autoConnect:false}})).status,400);assert.equal(await readFile(join(f.profile,'futures-vault.json'),'utf8'),before);
  assert.equal((await f.post('settings',{password,settings:{...settings,marginPercent:2},preferences:{autoConnect:false}})).status,200);assert.equal((await loadVault(join(f.profile,'futures-vault.json'),password)).settings.marginPercent,2);assert.equal(f.calls.length,0);
});
test('changing 1% and 150x to 10% and 102x survives lock and unlock without changing the exchange',async t=>{
  const f=await fixture(t),preferences={autoConnect:false};
  const initial=await f.post('save',{credentials:{apiKey:'fake',apiSecret:'fake-secret'},password,passwordRepeat:password,settings:{...settings,leverage:150},preferences});
  assert.equal(initial.status,200);
  const changed={...settings,marginPercent:10,leverage:102},file=join(f.profile,'futures-vault.json');
  const saved=await f.post('settings',{password,settings:changed,preferences});
  assert.equal(saved.status,200);assert.equal(saved.value.settings.marginPercent,10);assert.equal(saved.value.settings.leverage,102);
  const persisted=await readFile(file,'utf8');
  const invalid=await f.post('settings',{password,settings:{...changed,marginPercent:100.01},preferences});
  assert.equal(invalid.status,400);assert.equal(invalid.value.error,'INVALID_FUTURES_MARGIN_PERCENT');
  assert.equal(await readFile(file,'utf8'),persisted);
  assert.equal((await f.post('lock')).status,200);
  const unlocked=await f.post('unlock',{password});
  assert.equal(unlocked.status,200);assert.equal(unlocked.value.settings.marginPercent,10);assert.equal(unlocked.value.settings.leverage,102);
  assert.equal(unlocked.value.settings.dailyLossPercent,20);assert.deepEqual(f.calls,[]);
});
test('read-only connection failure stops strategy and preserves encrypted configuration for retry',async t=>{
  const f=await fixture(t);await f.post('save',{credentials:{apiKey:'fake',apiSecret:'fake-secret'},password,passwordRepeat:password,settings,preferences:{autoConnect:true}});await f.app.monitor();assert.equal(f.app.status().running,false);assert.equal(f.app.status().reconnecting,true);assert.equal((await loadVault(join(f.profile,'futures-vault.json'),password)).credentials.apiKey,'fake');
});
test('the workspace gets the signed five-USDT balance even if the other wallet cannot be checked',async t=>{
  const readFailure={market:'COIN_M',operation:'time',httpStatus:403,binanceCode:null};
  const f=await fixture(t,()=>({
    USD_M:{disarm(){},async syncTime(){},async request(name){
      assert.equal(name,'balances');
      return [{asset:'USDT',balance:'5',accountAlias:'private-account-label'}];
    }},
    COIN_M:{disarm(){},async syncTime(){throw Object.assign(new Error('FUTURES_SERVICE_REFUSED_OR_RATE_LIMITED'),{readFailure});}}
  }));
  await f.post('save',{credentials:{apiKey:'fake',apiSecret:'fake-secret'},password,passwordRepeat:password,settings});
  assert.equal((await f.post('check')).status,400);
  const state=await (await f.get('/api/status')).json();
  assert.deepEqual(state.walletRead.amounts,[{asset:'USDT',balance:'5'}]);
  assert.deepEqual(state.readFailure,readFailure);
  assert.equal(JSON.stringify(state).includes('private-account-label'),false);
  assert.equal(state.connected,false);
  assert.equal(state.running,false);
});
test('external margin import requires the vault password and never arms itself or grants exchange writes',async t=>{
  const f=await fixture(t),text=await readFile(new URL('./example-auto-margin.json',import.meta.url),'utf8');
  await f.post('save',{credentials:{apiKey:'fake',apiSecret:'fake-secret'},password,passwordRepeat:password,settings,preferences:{autoConnect:false}});
  const before=await readFile(join(f.profile,'futures-vault.json'),'utf8');assert.equal((await f.post('margin-policy',{password:'wrong-password-long',text})).status,400);assert.equal(await readFile(join(f.profile,'futures-vault.json'),'utf8'),before);
  const saved=await f.post('margin-policy',{password,text});assert.equal(saved.status,200);assert.equal(saved.value.autoMarginArmed,false);assert.equal((await loadVault(join(f.profile,'futures-vault.json'),password)).settings.externalMarginPolicy.enabled,false);
  for(const route of ['hedge-mode','hedge-lock','add-margin','auto-margin-start'])assert.equal((await f.post(route,{}, {Origin:'https://attacker.invalid'})).status,403);
  assert.equal(f.calls.length,0);
});
