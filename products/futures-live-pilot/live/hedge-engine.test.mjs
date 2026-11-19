import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fakeExchange} from './testing/fake-exchange.mjs';
import {FUTURES_CONFIRMATION,HEDGE_CONFIRMATION,MODE_CONFIRMATION,MARGIN_CONFIRMATION} from './client.mjs';
import {AUTO_MARGIN_CONFIRMATION,parseMarginPolicy} from './margin-policy.mjs';
const policy=(market='USD_M')=>parseMarginPolicy(JSON.stringify({version:1,format:'AdaptiveAutoMargin',id:'persistent-auto-budget',enabled:true,market,symbol:market==='USD_M'?'BTCUSDT':'BTCUSD_PERP',asset:market==='USD_M'?'USDT':'BTC',positionSides:['LONG','SHORT'],trigger:{liquidationDistancePercentAtMost:2},perAdditionAmount:market==='USD_M'?'5':'0.001',maxTotalAmount:market==='USD_M'?'10':'0.002',maxAdditions:2,cooldownSeconds:30}));
async function openLong(f){await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});assert.ok(f.engine.state.positions.LONG);}
test('single-position policy preserves a combined conflicting entry decision instead of choosing long arbitrarily',async t=>{const f=await fakeExchange(t,{positionPolicy:'single'});f.entry.SHORT=true;await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});assert.equal(f.calls.some(c=>c.name==='newOrder'),false);f.entry.LONG=false;await f.engine.check({execute:true});assert.ok(f.engine.state.positions.SHORT);assert.equal(f.engine.state.positions.LONG,null);});
for(const market of ['USD_M','COIN_M'])test(market+' independent long/short legs have distinct stops and closing one never closes the other',async t=>{
  const f=await fakeExchange(t,{market});await openLong(f);f.entry.SHORT=true;await f.engine.check({execute:true});const s=f.engine.state;assert.ok(s.positions.LONG&&s.positions.SHORT);assert.notEqual(s.protections.LONG.id,s.protections.SHORT.id);
  await f.engine.closeOwnedPosition(FUTURES_CONFIRMATION,'LONG');assert.equal(f.engine.state.positions.LONG,null);assert.ok(f.engine.state.positions.SHORT);assert.ok(f.engine.state.protections.SHORT);assert.equal(f.engine.state.protections.LONG,null);
});
for(const market of ['USD_M','COIN_M'])test(market+' next midnight reconstructs both legs and collateral equity without treating margin additions as deposits',async t=>{const f=await fakeExchange(t,{market});await openLong(f);f.entry.SHORT=true;await f.engine.check({execute:true});f.engine.stop();await f.engine.check();const expected=f.engine.last.equityUsdt;f.advance(20*3600000);await f.engine.check();assert.equal(f.engine.state.day.firstDay,false);assert.equal(f.engine.state.day.baselineUsdt,expected);assert.equal(f.calls.filter(c=>c.name==='markCandles').length,1);});
for(const market of ['USD_M','COIN_M'])test(market+' manual equal hedge pauses trading, keeps both stops and requires explicit release',async t=>{
  const f=await fakeExchange(t,{market});await openLong(f);await assert.rejects(f.engine.manualHedge('yes'));await f.engine.manualHedge(HEDGE_CONFIRMATION);
  assert.equal(f.engine.state.positions.LONG.quantity,f.engine.state.positions.SHORT.quantity);assert.ok(f.engine.state.protections.LONG&&f.engine.state.protections.SHORT);assert.equal(f.engine.running,false);assert.equal(f.engine.state.hedgeLock.active,true);
  await assert.rejects(f.engine.start(FUTURES_CONFIRMATION),/MANUAL_HEDGE_LOCK/);await f.engine.clearManualHedgeLock(FUTURES_CONFIRMATION);assert.equal(f.engine.running,false);assert.equal(f.engine.state.hedgeLock,null);
});
test('partially filled manual hedge is reported as partial and only a later explicit click supplements the difference',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.partialNext('0.009');await f.engine.manualHedge(HEDGE_CONFIRMATION);assert.notEqual(f.engine.state.positions.LONG.quantity,f.engine.state.positions.SHORT.quantity);const stop=f.engine.state.protections.SHORT.id;
  assert.equal(f.calls.filter(c=>c.name==='newOrder').length,2);await f.engine.manualHedge(HEDGE_CONFIRMATION);assert.equal(f.engine.state.positions.LONG.quantity,f.engine.state.positions.SHORT.quantity);assert.notEqual(f.engine.state.protections.SHORT.id,stop);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,3);
});
test('manual hedge does not raise the chosen margin budget merely to reach equal contract quantity',async t=>{
  const f=await fakeExchange(t,{market:'COIN_M',coinCash:'0.1'});await openLong(f);await assert.rejects(f.engine.manualHedge(HEDGE_CONFIRMATION),/BUDGET|FILTER/);assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);assert.equal(f.engine.running,false);
});
test('one exchange stop can trigger while the other leg remains independently protected',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.entry.SHORT=true;await f.engine.check({execute:true});f.triggerStop('LONG');await f.engine.check();assert.equal(f.engine.state.positions.LONG,null);assert.ok(f.engine.state.positions.SHORT&&f.engine.state.protections.SHORT);assert.equal(f.engine.state.orders.at(-1).intent,'PROTECTION_CLOSE');
});
test('shared daily loss lock blocks a new hedge leg and still permits both owned legs to close',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.entry.SHORT=true;await f.engine.check({execute:true});f.advance(30000);f.fund('-210');await f.engine.check();assert.equal(f.engine.state.day.blocked,true);await assert.rejects(f.engine.manualHedge(HEDGE_CONFIRMATION),/DAILY/);await f.engine.closeOwnedPosition(FUTURES_CONFIRMATION,'LONG');await f.engine.closeOwnedPosition(FUTURES_CONFIRMATION,'SHORT');assert.equal(f.engine.state.position,null);assert.equal(Object.values(f.engine.state.positions).filter(Boolean).length,0);
});
test('shared account Hedge Mode is changed only with its exact confirmation and while both wallets are flat',async t=>{
  const f=await fakeExchange(t,{hedge:false});await assert.rejects(f.engine.enableHedgeMode('yes'));await f.engine.enableHedgeMode(MODE_CONFIRMATION);assert.equal(f.engine.last.hedge,true);await openLong(f);await assert.rejects(f.engine.enableHedgeMode(MODE_CONFIRMATION),/FLAT/);assert.equal(f.calls.filter(c=>c.name==='setPositionMode').length,1);
});
for(const market of ['USD_M','COIN_M'])test(market+' manual isolated margin addition is directional and does not invent an equity deposit',async t=>{
  const f=await fakeExchange(t,{market});await openLong(f);f.engine.stop();const before=f.engine.state.initialWallets,amount=market==='USD_M'?'5':'0.001';await f.engine.addIsolatedMargin({confirmation:MARGIN_CONFIRMATION,direction:'LONG',amount});assert.equal(f.engine.state.marginEvents.length,1);assert.equal(f.engine.state.marginEvents[0].direction,'LONG');assert.equal(f.engine.state.marginEvents[0].amount,amount);assert.deepEqual(f.engine.state.initialWallets,before);assert.equal(f.engine.state.pending,null);assert.equal(f.engine.running,false);
});
test('unknown margin response reconciles history once and never sends the same addition twice',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.timeoutNext('margin');await assert.rejects(f.engine.addIsolatedMargin({confirmation:MARGIN_CONFIRMATION,direction:'LONG',amount:'5'}));assert.equal(f.engine.state.pending.kind,'MARGIN_ADD');await f.engine.check();assert.equal(f.engine.state.pending,null);assert.equal(f.engine.state.marginEvents.length,1);assert.equal(f.calls.filter(c=>c.name==='addMargin').length,1);
});
test('cross margin and unowned directions cannot be manually topped up through the isolated endpoint',async t=>{
  const f=await fakeExchange(t,{marginMode:'CROSSED'});await openLong(f);await assert.rejects(f.engine.addIsolatedMargin({confirmation:MARGIN_CONFIRMATION,direction:'LONG',amount:'5'}),/ISOLATED/);assert.equal(f.calls.some(c=>c.name==='addMargin'),false);
});
test('external automatic budget survives stop/restart and repeated policy registration',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.engine.stop();f.engine.settings.externalMarginPolicy=policy();f.setLiquidation('LONG','9900');await f.engine.armAutoMargin(AUTO_MARGIN_CONFIRMATION);await f.engine.check({execute:true});assert.equal(f.engine.state.autoMarginBudgets['persistent-auto-budget'].usedAmount,'5');assert.equal(f.engine.state.marginEvents.length,1);await f.engine.check({execute:true});assert.equal(f.engine.state.marginEvents.length,1);
  f.engine.stop();await f.engine.close();await f.engine.acquire();assert.equal(f.engine.autoMarginArmed,false);assert.equal(f.engine.state.autoMarginBudgets['persistent-auto-budget'].usedAmount,'5');f.advance(31000);await f.engine.armAutoMargin(AUTO_MARGIN_CONFIRMATION);await f.engine.check({execute:true});assert.equal(f.engine.state.autoMarginBudgets['persistent-auto-budget'].usedAmount,'10');f.advance(31000);await f.engine.check({execute:true});assert.equal(f.calls.filter(c=>c.name==='addMargin').length,2);
});
test('an automatic addition with a lost response debits its budget only after history proves it',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.engine.stop();f.engine.settings.externalMarginPolicy=policy();f.setLiquidation('LONG','9900');await f.engine.armAutoMargin(AUTO_MARGIN_CONFIRMATION);f.timeoutNext('margin');await assert.rejects(f.engine.check({execute:true}));assert.equal(f.engine.autoMarginArmed,false);assert.equal(f.engine.state.autoMarginBudgets['persistent-auto-budget'].usedAmount,'0');await f.engine.check();assert.equal(f.engine.state.autoMarginBudgets['persistent-auto-budget'].usedAmount,'5');assert.equal(f.calls.filter(c=>c.name==='addMargin').length,1);
});
test('stop during automatic margin intent persistence cancels only the unsent action',async t=>{
  const f=await fakeExchange(t);await openLong(f);f.engine.stop();f.engine.settings.externalMarginPolicy=policy();f.setLiquidation('LONG','9900');await f.engine.armAutoMargin(AUTO_MARGIN_CONFIRMATION);const commit=f.engine.commit.bind(f.engine);f.engine.commit=async state=>{await commit(state);if(state.pending?.kind==='MARGIN_ADD')f.engine.stopAutoMargin();};await assert.rejects(f.engine.check({execute:true}),/CANCELLED/);assert.equal(f.engine.state.pending,null);assert.equal(f.calls.some(c=>c.name==='addMargin'),false);
});
test('legacy single-leg ledger migrates with its existing orders and a backup, without opening another position',async t=>{
  const f=await fakeExchange(t,{positionPolicy:'single'});await openLong(f);await f.engine.close();const path=join(f.profile,'futures-ledger.json'),old=JSON.parse(await readFile(path,'utf8'));old.version=1;old.position=old.positions.LONG;old.protection=old.protections.LONG;delete old.positions;delete old.protections;delete old.marginEvents;delete old.autoMarginBudgets;delete old.hedgeLock;await writeFile(path,JSON.stringify(old));await f.engine.acquire();await f.engine.check();assert.equal(f.engine.state.version,2);assert.ok(f.engine.state.positions.LONG);assert.equal(f.engine.state.orders.length,1);assert.ok((await readdir(join(f.profile,'backups'))).some(name=>name.startsWith('futures-ledger-v1-')));assert.equal(f.calls.filter(c=>c.name==='newOrder').length,1);
});
