import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=readFileSync(new URL('./ui.html',import.meta.url),'utf8');
const source=readFileSync(new URL('./ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function element(){
  return {
    value:'',textContent:'',checked:false,disabled:false,hidden:false,
    parentElement:{after(){}},listeners:{},
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},
    input(value){this.value=String(value);for(const fn of this.listeners.input??[])fn();},
    setAttribute(){},replaceChildren(){},append(){},querySelector(){return {};},
  };
}

async function fixture(){
  const controls=new Map([...html.matchAll(/ id="([^"]+)"/g)].map(([,id])=>[id,element()]));
  const $=id=>{assert.ok(controls.has(id),id);return controls.get(id);};
  const initial={market:'USD_M',symbol:'ETHUSDT',assetMode:'multi',marginMode:'CROSSED',marginPercent:1,leverage:150,directionMode:'both',positionPolicy:'single',externalPositionPolicy:'otherContracts'};
  const snapshot={market:'USD_M',symbol:'ETHUSDT',actualConfigurationMatches:true,configuration:{marginMode:'CROSSED',leverage:150,legs:{LONG:{},SHORT:{}}}};
  const state={version:'sample',unlocked:true,connected:true,tradingAuthorized:true,settings:initial,preferences:{autoConnect:true},snapshot,marginCapacity:{mode:'multi',availableUsdt:'3.47571872'}};
  const calls=[];
  const response=(data,ok=true)=>({ok,json:async()=>structuredClone(data)});
  const routes={
    status:()=>response(state),
    preflight:()=>response({market:'USD_M',symbol:'ETHUSDT',configuration:snapshot.configuration}),
    settings:body=>{state.settings=body.settings;snapshot.actualConfigurationMatches=state.settings.leverage===snapshot.configuration.leverage;return response(state);},
    'contract-settings':()=>{snapshot.configuration.leverage=state.settings.leverage;snapshot.actualConfigurationMatches=true;return response(state);},
    start:()=>{state.running=true;return response(state);},
    stop:()=>{state.running=false;return response(state);}
  };
  const context=vm.createContext({
    document:{getElementById:$,querySelectorAll:()=>[],createElement:element,createDocumentFragment:element},
    location:{hash:'#fixture',pathname:'/'},history:{replaceState(){}},setInterval(){},
    fetch:async(url,request)=>{
      const action=url.slice(5),body=request.body?JSON.parse(request.body):undefined;
      calls.push(action);assert.ok(routes[action],action);return routes[action](body);
    }
  });
  vm.runInContext(source,context);
  await tick();
  return {$,state,calls,routes,refresh:()=>vm.runInContext('refresh()',context)};
}

test('a 10% / 102× edit survives the 150× read, is saved locally first and requires explicit exchange apply',async()=>{
  const {$,state,calls}=await fixture();
  $('percent').input('10');$('leverage').input('102');
  assert.match($('form-status').textContent,/尚未保存.*102×.*10%/);
  assert.match($('saved-settings').textContent,/150×.*1%/);
  assert.equal($('contract-settings').disabled,true);
  await $('preflight').onclick();
  assert.equal($('leverage').value,'102');
  assert.match($('preflight-result').textContent,/150×/);
  await $('apply-settings').onclick();
  assert.equal(state.settings.marginPercent,10);
  assert.match($('notice').textContent,/本机已保存.*102×.*10%/);
  assert.match($('saved-settings').textContent,/102×.*10%/);
  assert.match($('actual-settings').textContent,/150×/);
  assert.equal(calls.includes('contract-settings'),false);
  $('confirmation').input('START REAL FUTURES TRADING');
  assert.equal($('start').disabled,true);
  $('settings-confirmation').input('APPLY FUTURES SETTINGS');
  assert.equal($('contract-settings').disabled,false);
  await $('contract-settings').onclick();
  assert.match($('actual-settings').textContent,/102×/);
  assert.equal($('start').disabled,false);
});

test('invalid local input and server errors are visible and the draft survives',async()=>{
  const {$,state,calls,routes}=await fixture();
  for(const value of ['','0','0.001','101','1.1234567890123']){
    $('percent').input(value);await $('apply-settings').onclick();
    assert.match($('notice').textContent,/保存未完成.*0\.01% 至 100%/);
  }
  assert.equal(calls.includes('settings'),false);
  $('percent').input('10');$('leverage').input('0');await $('apply-settings').onclick();
  assert.match($('notice').textContent,/整数杠杆/);
  $('leverage').input('102');
  routes.settings=()=>({ok:false,json:async()=>({error:'FUTURES_SETTINGS_NOT_SAVED_UNLOCK_PREVIOUS'})});
  await $('apply-settings').onclick();
  assert.match($('notice').textContent,/保存未完成.*重新解锁/);
  assert.equal(state.settings.leverage,150);assert.equal($('leverage').value,'102');
});

test('stop then restart requires fresh confirmation; reverted edits do not keep arming disabled',async()=>{
  const {$,calls}=await fixture();
  assert.match($('wallet-summary').textContent,/账户已核对 · 可用 3\.47571872 USDT/);
  assert.doesNotMatch($('wallet-summary').textContent,/其他合约/);
  assert.match($('wallet-details').textContent,/其他合约/);
  assert.match(html,/<details><summary>钱包与核对详情/);
  $('percent').input('10');$('percent').input('1');
  $('confirmation').input('START REAL FUTURES TRADING');
  assert.equal($('start').disabled,false);
  $('start').onclick();await tick();
  await $('stop').onclick();
  assert.equal($('start').disabled,true);
  assert.match($('start-help').textContent,/重新输入/);
  $('confirmation').input('START REAL FUTURES TRADING');
  assert.equal($('start').disabled,false);
  $('start').onclick();await tick();
  assert.deepEqual(calls.filter(a=>a==='start'||a==='stop'),['start','stop','start']);
});

test('one opportunity below minimum waits while account-wide entry locks still block a flat start',async()=>{
  const {$,state,refresh}=await fixture();
  $('confirmation').input('START REAL FUTURES TRADING');
  state.snapshot.blocker='MARGIN_BUDGET_BELOW_CONTRACT_MINIMUM_OR_FILTER';
  await refresh();
  assert.equal($('start').disabled,false);
  assert.match($('blocker').textContent,/本次委托等待.*最小/);
  state.snapshot.day={blocked:true,reason:'DAILY_USDT_EQUITY_LOSS_20_PERCENT'};
  await refresh();
  assert.equal($('start').disabled,true);
  assert.match($('start-help').textContent,/当日回撤/);
});
