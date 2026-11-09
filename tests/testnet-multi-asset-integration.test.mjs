// Synthetic exchange only. Exercise actual signal/order/fee/position code with
// different base assets, including an asset name beginning with a digit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig,initialState,runCycle} from '../lib/testnet-bot.mjs';

for(const [base,unit,step]of [['ETH',10,'0.001'],['DOGE',0.001,'1'],['1INCH',0.001,'1']])test(base+' signal BUY/SELL uses selected pair, its filters and base-asset fees',async()=>{
  const symbol=base+'USDT',now=1800000000000;
  const config=readConfig({TESTNET_SYMBOL:symbol,TESTNET_STRATEGY:'fast',TESTNET_FAST_PERIOD:'3',TESTNET_SLOW_PERIOD:'5',TESTNET_TRADE_USDT:'100'});
  const state=initialState(config,'synthetic-multi-asset-only'),saved=[],calls=[],fills=new Map();let id=0,price=110*unit,owned=0;
  const boundary=Math.floor(now/60000)*60000;
  const candles=Array.from({length:60},(_,i)=>{const close=(i===57?99:i===58?100:i===59?110:100)*unit;const time=boundary-(60-i)*60000;return [time,String(close),String(close),String(close),String(close),'1',time+59999];});
  const info={symbol,baseAsset:base,quoteAsset:'USDT',status:'TRADING',quoteOrderQtyMarketAllowed:true,orderTypes:['MARKET'],isSpotTradingAllowed:true,
    filters:[{filterType:'LOT_SIZE',minQty:step,maxQty:'10000000',stepSize:step},{filterType:'MARKET_LOT_SIZE',minQty:'0',maxQty:'10000000',stepSize:'0'},{filterType:'MIN_NOTIONAL',minNotional:'5',applyToMarket:true}]};
  const persist=async s=>saved.push(structuredClone(s));
  const client={syncTime:async()=>now,request:async(method,path,params={})=>{
    calls.push({method,path,params:structuredClone(params)});if(params.symbol)assert.equal(params.symbol,symbol);
    if(path==='/api/v3/klines')return candles;if(path==='/api/v3/exchangeInfo')return {symbols:[info]};if(path==='/api/v3/ticker/price')return {symbol,price:String(price)};
    if(path==='/api/v3/account')return {canTrade:true,balances:[{asset:'USDT',free:'1000'},{asset:base,free:String(owned)}]};
    if(path==='/api/v3/myTrades')return fills.get(params.orderId);
    if(method==='POST'&&path==='/api/v3/order'){
      assert.ok(saved.some(s=>s.pending?.clientOrderId===params.newClientOrderId));id++;
      let quantity,quote,fee,feeAsset;
      if(params.side==='BUY'){
        assert.ok(Number(params.quoteOrderQty)<=100);quantity=Math.floor(Number(params.quoteOrderQty)/price/Number(step))*Number(step);quote=quantity*price;fee=quantity*0.001;feeAsset=base;owned=quantity-fee;
      }else{quantity=Number(params.quantity);assert.ok(quantity<=owned+1e-8);quote=quantity*price;fee=quote*0.001;feeAsset='USDT';owned-=quantity;}
      fills.set(id,[{orderId:id,qty:String(quantity),commission:String(fee),commissionAsset:feeAsset}]);
      return {symbol,orderId:id,clientOrderId:params.newClientOrderId,side:params.side,status:'FILLED',executedQty:String(quantity),cummulativeQuoteQty:String(quote),transactTime:now};
    }
    throw new Error('Unexpected offline route');
  }};
  await runCycle(client,config,state,persist,true,{now});assert.equal(state.orders.length,1);assert.equal(state.orders[0].side,'BUY');assert.equal(state.orders[0].commissions[0].asset,base);assert.ok(state.position.quantity>0);
  price*=1.02;await runCycle(client,config,state,persist,true,{now:now+1000});
  assert.equal(state.orders.length,2);assert.equal(state.orders[0].side,'SELL');assert.equal(state.orders[0].commissions[0].asset,'USDT');assert.equal(state.orders[0].realizedPnlComplete,true);assert.ok(state.orders[0].realizedUsdt>0);
  assert.equal(state.pending,null);assert.equal(state.position,null);assert.ok(state.dust.every(d=>d.quantity<Number(step)+1e-8));
  assert.equal(calls.filter(c=>c.method==='POST').length,2);assert.ok(calls.filter(c=>c.method==='POST').every(c=>c.params.symbol===symbol));
});
