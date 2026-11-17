import {parseExternalStrategy,externalRulesMatch} from '../../../lib/external-testnet-strategy.mjs';
const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).sort().join(',')===[...keys].sort().join(',');
export function parseFuturesStrategy(text){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>16384)throw new Error('FUTURES_STRATEGY_MAX_16_KB');
  let value;try{value=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('INVALID_FUTURES_STRATEGY_JSON');}
  if(!exact(value,['version','format','name','long','short','risk'])||value.version!==1||value.format!=='AdaptiveFuturesBot'||!exact(value.risk,['stopLossPercent','takeProfitPercent','trailingPercent']))throw new Error('EXPLICIT_LONG_SHORT_AND_RISK_RULES_REQUIRED');
  const result={version:1,format:value.format,name:value.name,risk:{...value.risk}};
  for(const key of ['long','short']){
    if(!exact(value[key],['entry','exit']))throw new Error('EXPLICIT_DIRECTION_RULES_REQUIRED');
    const parsed=parseExternalStrategy(JSON.stringify({version:1,name:value.name,...value[key]}));
    result[key]={entry:parsed.entry,exit:parsed.exit};result.name=parsed.name;
  }
  const r=result.risk;
  if(!['stopLossPercent','takeProfitPercent','trailingPercent'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k]))||r.stopLossPercent<0.05||r.stopLossPercent>50||r.takeProfitPercent<0.05||r.takeProfitPercent>100||r.trailingPercent<0||r.trailingPercent>50)throw new Error('BOUNDED_FUTURES_EXIT_RISK_REQUIRED');
  return result;
}
const ema=(values,period)=>{let v=values[0];return values.map((x,i)=>i?(v+=(x-v)*2/(period+1)):v);};
export function futuresIndicators(rows,now){
  if(!Array.isArray(rows))throw new Error('CLOSED_FUTURES_CANDLES_REQUIRED');
  const candles=rows.filter(row=>Array.isArray(row)&&Number.isSafeInteger(row[6])&&row[6]<now).map(row=>({time:row[0],open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),closeTime:row[6]}));
  if(candles.length<35||candles.some((r,i)=>!Number.isSafeInteger(r.time)||r.time%60000||r.closeTime!==r.time+59999||![r.open,r.high,r.low,r.close].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(r.volume)||r.volume<0||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||(i>0&&r.time!==candles[i-1].time+60000))||now-candles.at(-1).closeTime>120000)throw new Error('INVALID_OR_STALE_FUTURES_CANDLES');
  const closes=candles.map(row=>row.close),fast=ema(closes,8),slow=ema(closes,21),strength=[];
  let gains=0,losses=0;
  for(let i=1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];if(i<=7){gains+=Math.max(d,0)/7;losses+=Math.max(-d,0)/7;}else{gains=gains*6/7+Math.max(d,0)/7;losses=losses*6/7+Math.max(-d,0)/7;}
    strength.push(i<7?50:losses===0?(gains===0?50:100):100-100/(1+gains/losses));
  }
  const last=candles.at(-1),ranges=candles.slice(-7).map((row,i)=>{const previous=candles[candles.length-8+i].close;return Math.max(row.high-row.low,Math.abs(row.high-previous),Math.abs(row.low-previous));});
  const averageVolume=candles.slice(-11,-1).reduce((sum,row)=>sum+row.volume,0)/10;
  const values={fast:fast.at(-1),slow:slow.at(-1),previousFast:fast.at(-2),previousSlow:slow.at(-2),rsi:strength.at(-1),previousRsi:strength.at(-2),atrPercent:ranges.reduce((a,b)=>a+b,0)/7/last.close*100,volumeRatio:averageVolume>0?last.volume/averageVolume:0,contextBiasPercent:(fast.at(-1)/slow.at(-1)-1)*100,momentumPercent:(last.close/closes.at(-4)-1)*100,close:last.close,previousClose:closes.at(-2)};
  if(Object.values(values).some(v=>!Number.isFinite(v)))throw new Error('INVALID_FUTURES_INDICATORS');
  return {values,candles:candles.slice(-60).map(row=>({time:row.time,close:row.close}))};
}
export function futuresSignal({rows,now,book,position=null,external=null,directionMode='both',roundTripFeePercent=0}){
  const {values,candles}=futuresIndicators(rows,now),bid=Number(book.bidPrice),ask=Number(book.askPrice);
  if(!(bid>0&&ask>=bid)||!Number.isFinite(roundTripFeePercent)||roundTripFeePercent<0||!['both','long','short'].includes(directionMode))throw new Error('INVALID_FUTURES_SIGNAL_CONTEXT');
  values.spreadPercent=(ask/bid-1)*100;values.positionReturnPercent=position?(position.direction==='LONG'?bid/Number(position.entryPrice)-1:1-ask/Number(position.entryPrice))*100:0;
  const stop=Math.min(2.5,Math.max(0.2,values.atrPercent*1.5)),risk=external?.risk??{stopLossPercent:stop,takeProfitPercent:stop*1.8,trailingPercent:stop/2};
  if(position){
    const activeRisk=position.risk,peak=Math.max(position.peakReturnPercent??0,values.positionReturnPercent);
    if(!activeRisk)throw new Error('SAVED_POSITION_RISK_REQUIRED');
    const selected=external?.[position.direction==='LONG'?'long':'short'];
    const close=values.positionReturnPercent<=-activeRisk.stopLossPercent||values.positionReturnPercent>=activeRisk.takeProfitPercent||(activeRisk.trailingPercent>0&&peak>=activeRisk.takeProfitPercent/2&&peak-values.positionReturnPercent>=activeRisk.trailingPercent)||(selected?externalRulesMatch(selected.exit,values):position.direction==='LONG'?values.fast<values.slow:values.fast>values.slow);
    return {intent:close?'CLOSE_'+position.direction:null,reason:close?'POSITION_EXIT_RULE':'HOLD_POSITION',risk:activeRisk,peakReturnPercent:peak,values,candles};
  }
  const canEnter=values.spreadPercent<0.1&&values.atrPercent*3>roundTripFeePercent+values.spreadPercent+0.05&&risk.takeProfitPercent>roundTripFeePercent+values.spreadPercent+0.02;
  let long=external?externalRulesMatch(external.long.entry,values):values.fast>values.slow&&values.rsi>=45&&values.rsi<=78&&values.momentumPercent>0.02&&values.volumeRatio>=0.8;
  let short=external?externalRulesMatch(external.short.entry,values):values.fast<values.slow&&values.rsi>=22&&values.rsi<=55&&values.momentumPercent<-0.02&&values.volumeRatio>=0.8;
  long=long&&directionMode!=='short';short=short&&directionMode!=='long';
  return {intent:canEnter&&long!==short?(long?'OPEN_LONG':'OPEN_SHORT'):null,reason:long&&short?'CONFLICTING_ENTRY_RULES':!canEnter?'COST_OR_SPREAD_GUARD':long||short?'ENTRY_RULE':'WAIT_FOR_SIGNAL',risk,values,candles};
}
