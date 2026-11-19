import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeExchange} from '../futures-live-pilot/live/testing/fake-exchange.mjs';
import {FUTURES_CONFIRMATION} from '../futures-live-pilot/live/client.mjs';

for(const market of ['USD_M','COIN_M'])test(market+' entitlement loss prevents an opening during intent persistence, then allows an explicitly confirmed owned close',async t=>{
  const f=await fakeExchange(t,{market});let active=true;
  f.engine.guard=plan=>active||['CLOSE_LONG','CLOSE_SHORT'].includes(plan?.intent);
  await f.engine.start(FUTURES_CONFIRMATION);await f.engine.check({execute:true});assert.ok(f.engine.state.positions.LONG);
  f.entry.SHORT=true;const commit=f.engine.commit.bind(f.engine);
  f.engine.commit=async state=>{await commit(state);if(state.pending?.kind==='ORDER'&&state.pending.intent==='OPEN_SHORT')active=false;};
  const before=f.calls.filter(c=>c.name==='newOrder').length;
  await f.engine.check({execute:true});assert.equal(f.calls.filter(c=>c.name==='newOrder').length,before);assert.equal(f.engine.state.pending,null);assert.equal(f.engine.state.positions.SHORT,null);
  f.engine.stop();await f.engine.closeOwnedPosition(FUTURES_CONFIRMATION,'LONG');assert.equal(f.engine.state.positions.LONG,null);
  assert.equal(f.calls.filter(c=>c.name==='newOrder').length,before+1);
});
