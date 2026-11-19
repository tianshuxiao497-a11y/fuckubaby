import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseMarginPolicy,registerMarginPolicy,autoMarginDecision} from './margin-policy.mjs';
import {newLedger} from './ledger.mjs';
const now=1800000000000;
const enabled=()=>({version:1,format:'AdaptiveAutoMargin',id:'my-explicit-budget',enabled:true,market:'USD_M',symbol:'BTCUSDT',asset:'USDT',positionSides:['LONG','SHORT'],trigger:{liquidationDistancePercentAtMost:2},perAdditionAmount:'5',maxTotalAmount:'10',maxAdditions:2,cooldownSeconds:30});
function fixture(){const policy=parseMarginPolicy(JSON.stringify(enabled()));let state=newLedger('a'.repeat(64),{'USD_M.USDT':'1000','COIN_M.BTC':'0'},now-1000);state=registerMarginPolicy(state,policy);state.day={blocked:false};for(const direction of ['LONG','SHORT']){state.positions[direction]={quantity:'1'};state.protections[direction]={quantity:'1'};}const snapshot={accountChecked:true,market:'USD_M',symbol:'BTCUSDT',marginAsset:'USDT',configuration:{marginMode:'ISOLATED',autoAddMargin:false,legs:{LONG:{liquidationPrice:'9900'},SHORT:{liquidationPrice:'10050'}}},actualConfigurationMatches:true,markPrice:'10000'};return {policy,state,snapshot,armed:true,now,availableCollateral:'100'};}
test('there is no built-in spending rule: the shipped JSON example is disabled with zero amounts',async()=>{
  const example=parseMarginPolicy(await readFile(new URL('./example-auto-margin.json',import.meta.url),'utf8'));assert.equal(example.enabled,false);assert.equal(example.perAdditionAmount,'0');assert.equal(autoMarginDecision({...fixture(),policy:null}).eligible,false);
});
test('an external enabled JSON still cannot spend until explicitly armed',()=>{const f=fixture();assert.equal(autoMarginDecision({...f,armed:false}).reason,'AUTO_MARGIN_NOT_ARMED');assert.equal(autoMarginDecision(f).direction,'SHORT');});
test('both directions share the same persistent total budget, count and cooldown',()=>{
  const f=fixture(),b=f.state.autoMarginBudgets[f.policy.id];b.usedAmount='5';b.additions=1;b.lastAdditionAt=now-1000;assert.equal(autoMarginDecision(f).reason,'AUTO_MARGIN_COOLDOWN');b.lastAdditionAt=now-30000;assert.equal(autoMarginDecision(f).eligible,true);b.usedAmount='10';b.additions=2;assert.equal(autoMarginDecision(f).reason,'AUTO_MARGIN_BUDGET_OR_COUNT_EXHAUSTED');
  const imported=registerMarginPolicy(f.state,parseMarginPolicy(JSON.stringify({...enabled(),perAdditionAmount:'1'})));assert.equal(imported.autoMarginBudgets[f.policy.id].usedAmount,'10');assert.equal(imported.autoMarginBudgets[f.policy.id].additions,2);
});
test('unknown native auto-add state, daily stop, unprotected quantity and insufficient funds prevent automatic addition',()=>{
  let f=fixture();f.snapshot.configuration.autoAddMargin=null;assert.equal(autoMarginDecision(f).eligible,false);f=fixture();f.state.day.blocked=true;assert.equal(autoMarginDecision(f).reason,'DAILY_USDT_EQUITY_LOSS_20_PERCENT');f=fixture();f.state.protections={LONG:null,SHORT:null};assert.equal(autoMarginDecision(f).eligible,false);assert.equal(autoMarginDecision({...fixture(),availableCollateral:'4'}).eligible,false);
});
test('policy identities cannot be rebound to another asset and arbitrary executable fields are rejected',()=>{
  const f=fixture();assert.throws(()=>registerMarginPolicy(f.state,{...f.policy,asset:'BTC'}),/ALREADY_BOUND/);assert.throws(()=>parseMarginPolicy(JSON.stringify({...enabled(),code:'execute()'})));assert.throws(()=>parseMarginPolicy(JSON.stringify({...enabled(),cooldownSeconds:0})));assert.throws(()=>parseMarginPolicy(JSON.stringify({...enabled(),maxTotalAmount:'4'})));assert.throws(()=>parseMarginPolicy(JSON.stringify({...enabled(),id:'__proto__'})));
});
test('an unprotected opposite leg blocks automatic addition even when excluded from the policy directions',()=>{const f=fixture();f.policy.positionSides=['LONG'];f.state.protections.SHORT=null;assert.equal(autoMarginDecision(f).reason,'AUTO_MARGIN_ACCOUNT_REVIEW_REQUIRED');});
