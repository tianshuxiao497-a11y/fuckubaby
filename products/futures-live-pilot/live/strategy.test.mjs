import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFuturesStrategy,futuresSignal,futuresIndicators} from './strategy.mjs';
const now=1800000000000;
function candles(){return Array.from({length:80},(_,i)=>{const time=Math.floor(now/60000)*60000-(80-i)*60000,p=100+Math.sin(i/4)*0.5+i*0.01;return [time,String(p),String(p+0.5),String(p-0.5),String(p),'100',time+59999];});}
function strategy({long=true,short=false}={}){
  const group=value=>({match:'all',rules:[{left:'close',op:value?'>':'<',right:0}]}),exit={match:'all',rules:[{left:'positionReturnPercent',op:'>=',right:1}]};
  return {version:1,format:'AdaptiveFuturesBot',name:'Both direction data rules',long:{entry:group(long),exit},short:{entry:group(short),exit},risk:{stopLossPercent:1,takeProfitPercent:2,trailingPercent:0.5}};
}
test('separate external JSON rules can open a short without pretending to sell Spot inventory',()=>{
  const external=parseFuturesStrategy(JSON.stringify(strategy({long:false,short:true})));
  const result=futuresSignal({rows:candles(),now,book:{bidPrice:'100',askPrice:'100.01'},external,roundTripFeePercent:0.1});
  assert.equal(result.intent,'OPEN_SHORT');assert.equal(result.risk.stopLossPercent,1);
});
test('simultaneous conflicting long and short rules wait rather than open two unintended positions',()=>{
  const external=parseFuturesStrategy(JSON.stringify(strategy({long:true,short:true})));
  const result=futuresSignal({rows:candles(),now,book:{bidPrice:'100',askPrice:'100.01'},external});assert.equal(result.intent,null);assert.equal(result.reason,'CONFLICTING_ENTRY_RULES');
});
test('short exits measure profit from a falling price and preserve the entry risk snapshot',()=>{
  const result=futuresSignal({rows:candles(),now,book:{bidPrice:'97.99',askPrice:'98'},position:{direction:'SHORT',entryPrice:'100',risk:{stopLossPercent:1,takeProfitPercent:1.5,trailingPercent:0}}});
  assert.equal(result.intent,'CLOSE_SHORT');assert.ok(result.values.positionReturnPercent>=2);
});
test('invalid, gapped, unfinished-only or stale candles cannot trigger trading',()=>{
  const rows=candles();rows[20][0]+=1;assert.throws(()=>futuresIndicators(rows,now));assert.throws(()=>futuresIndicators(candles(),now+180000));assert.throws(()=>futuresIndicators(candles().slice(-10),now));
});
test('JSON is bounded data only, with explicit rules for both entry directions and exits',()=>{
  assert.throws(()=>parseFuturesStrategy(JSON.stringify({...strategy(),execute:'fetch(secret)'})));
  assert.throws(()=>parseFuturesStrategy(JSON.stringify({...strategy(),risk:{stopLossPercent:0,takeProfitPercent:2,trailingPercent:0}})));
  assert.throws(()=>parseFuturesStrategy('x'.repeat(16385)));
});
