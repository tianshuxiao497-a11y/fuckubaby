import test from 'node:test';
import assert from 'node:assert/strict';
import {newLedger,applyFinalOrder,nativeWalletsAt,addFunding,incomeCursor,verifyWallets,accountIdentity,walletSnapshot,makeExternalSnapshot,externalMidnightPnl} from './ledger.mjs';
const at=1800000000000,id='asbf_'+'a'.repeat(28);
const initial=()=>newLedger('a'.repeat(64),{'USD_M.USDT':'1000','COIN_M.BTC':'0.1'},at-10000);
test('a one-character settlement asset is preserved in wallet reconciliation and funding',()=>{
  const row={asset:'U',walletBalance:'2.5'};
  const accounts={USD_M:{canTrade:true,assets:[row]},COIN_M:{canTrade:true,assets:[]}};
  const wallets=walletSnapshot(accounts);
  const state=newLedger('a'.repeat(64),wallets,at);
  const funded=addFunding(state,'USD_M',[{incomeType:'FUNDING_FEE',asset:'U',income:'-0.1',time:at+1,tranId:17}],at+2);
  verifyWallets(funded,{'USD_M.U':'2.4'});
  for(const invalid of ['', 'U.USDT', 'u', 'U/USDT']){
    row.asset=invalid;
    assert.throws(()=>walletSnapshot(accounts),/INVALID_SETTLEMENT_ASSET/);
  }
});
function pending(state,{market='USD_M',direction='LONG',close=false,quantity='0.01',price='10000'}={}){
  const symbol=market==='USD_M'?'BTCUSDT':'BTCUSD_PERP';
  state.pending={kind:'ORDER',id,createdAt:at-100,market,direction,intent:(close?'CLOSE_':'OPEN_')+direction,risk:{stopLossPercent:1,takeProfitPercent:2,trailingPercent:0.5},rules:{marginAsset:market==='USD_M'?'USDT':'BTC',contractSize:market==='USD_M'?'1':'100'},args:{symbol,positionSide:'BOTH',side:direction==='LONG'?(close?'SELL':'BUY'):(close?'BUY':'SELL'),type:'LIMIT',timeInForce:'IOC',quantity,price}};
  return state;
}
function response(state,{qty=state.pending.args.quantity,pnl='0',commission='0.05',price=state.pending.args.price,number=1}={}){
  const p=state.pending,args=p.args;
  return [{clientOrderId:p.id,orderId:number,symbol:args.symbol,side:args.side,positionSide:args.positionSide,type:args.type,origQty:args.quantity,executedQty:qty,status:'FILLED'},[{id:number,orderId:number,symbol:args.symbol,side:args.side,positionSide:args.positionSide,qty,price,realizedPnl:pnl,commission,commissionAsset:p.rules.marginAsset,time:at+number}]];
}
test('entry commissions debit the native wallet immediately, before any liquidation',()=>{
  const state=pending(initial()),next=applyFinalOrder(state,...response(state));
  assert.equal(nativeWalletsAt(next)['USD_M.USDT'],'999.95');assert.equal(next.position.entryPrice,'10000');assert.equal(state.orders.length,0);
});
test('actual entry/exit executions and commissions are counted once, without a second slippage debit',()=>{
  const state=pending(initial()),opened=applyFinalOrder(state,...response(state));
  pending(opened,{close:true,price:'11000'});opened.pending.id='asbf_'+'b'.repeat(28);
  const closed=applyFinalOrder(opened,...response(opened,{pnl:'10',commission:'0.055',number:2}));
  assert.equal(nativeWalletsAt(closed)['USD_M.USDT'],'1009.895');assert.equal(closed.position,null);assert.equal(closed.fills.length,2);
});
test('inverse contract entry uses the harmonic execution average and settles realized PNL in coin',()=>{
  const state=pending(initial(),{market:'COIN_M',quantity:'10',price:'20000'}),[order,fills]=response(state,{commission:'0.00005'});
  fills[0].qty='5';fills[0].price='10000';fills.push({...fills[0],id:2,qty:'5',price:'20000',commission:'0.000025'});
  const next=applyFinalOrder(state,order,fills);
  assert.equal(next.position.entryPrice,'13333.333333333333');assert.equal(nativeWalletsAt(next)['COIN_M.BTC'],'0.099925');
});
test('funding paid and received are native cash events and repeated income queries are idempotent',()=>{
  const state=initial(),event={incomeType:'FUNDING_FEE',symbol:'BTCUSD_PERP',asset:'BTC',income:'-0.001',time:at,tranId:'42'};
  const once=addFunding(state,'COIN_M',[event],at+1),twice=addFunding(once,'COIN_M',[event],at+2);
  assert.equal(twice.funding.length,1);assert.equal(nativeWalletsAt(twice)['COIN_M.BTC'],'0.099');
  assert.throws(()=>addFunding(twice,'COIN_M',[{...event,income:'0.001'}],at+3),/HISTORY_CHANGED/);
});
test('income commissions and realized-PNL entries are not counted a second time over fills',()=>{
  const state=pending(initial()),opened=applyFinalOrder(state,...response(state));
  const next=addFunding(opened,'USD_M',[{incomeType:'COMMISSION',income:'-0.05',asset:'USDT',time:at,tranId:'1'}],at+1);
  assert.equal(nativeWalletsAt(next)['USD_M.USDT'],'999.95');
});
test('manual deposits or withdrawals cannot silently change program capital',()=>{
  const state=initial();verifyWallets(state,{'USD_M.USDT':'1000','COIN_M.BTC':'0.1'});
  assert.throws(()=>verifyWallets(state,{'USD_M.USDT':'1010','COIN_M.BTC':'0.1'}),/DIFFERS/);
});
test('overfilled, wrong-side and incomplete orders never update the ledger',()=>{
  const state=pending(initial()),[order,fills]=response(state);
  assert.throws(()=>applyFinalOrder(state,{...order,executedQty:'1'},fills),/OVERFILLED/);
  assert.throws(()=>applyFinalOrder(state,{...order,side:'SELL'},fills),/TERMINAL/);
  assert.throws(()=>applyFinalOrder(state,order,[]),/INCOMPLETE/);assert.equal(state.fills.length,0);
});
test('a reducing order cannot consume an unrelated position or reverse an owned one',()=>{
  const state=pending(initial(),{close:true}),[order,fills]=response(state,{pnl:'1'});
  assert.throws(()=>applyFinalOrder(state,order,fills),/UNOWNED/);
});
test('historical wallets reconstruct the moment before midnight events',()=>{
  const state=pending(initial()),next=applyFinalOrder(state,...response(state));
  assert.equal(nativeWalletsAt(next,at)['USD_M.USDT'],'1000');assert.equal(nativeWalletsAt(next,at+2)['USD_M.USDT'],'999.95');
});
const scope={market:'USD_M',symbol:'BTCUSDT'};
const otherIncome=(incomeType,income,time,tranId,tradeId='29')=>({symbol:'ETHUSDT',asset:'USDT',incomeType,income,time,tranId,tradeId});
test('other contracts can realize profits and losses, pay fees and funding without becoming bot trades',()=>{
  const state=pending(initial()),opened=applyFinalOrder(state,...response(state));
  const manual=[
    otherIncome('REALIZED_PNL','5',at+2,39),
    otherIncome('COMMISSION','-0.03',at+2,39),
    otherIncome('REALIZED_PNL','-2',at+3,40,'30'),
    otherIncome('FUNDING_FEE','-0.01',at+4,41,'')
  ];
  const ownedFee={...manual[1],symbol:'BTCUSDT',tradeId:'1',tranId:203,income:'-0.05',time:at+1};
  const ownedFunding={...manual[3],symbol:'BTCUSDT',tranId:204,income:'0.2'};
  const rows=[...manual,ownedFee,ownedFunding];
  const next=addFunding(opened,'USD_M',rows,at+10,scope),again=addFunding(next,'USD_M',rows,at+11,scope);
  assert.equal(again.externalIncome.length,4);assert.equal(again.funding.length,1);
  assert.equal(again.fills.length,1);assert.equal(again.orders.length,1);
  verifyWallets(again,{'USD_M.USDT':'1003.11','COIN_M.BTC':'0.1'});
  assert.equal(nativeWalletsAt(again,at+3)['USD_M.USDT'],'1004.92');
  assert.throws(()=>addFunding(again,'USD_M',[{...manual[0],income:'8'}],at+12,scope),/HISTORY_CHANGED/);
  assert.throws(()=>addFunding(again,'USD_M',[{...ownedFee,income:'-0.04'}],at+12,scope),/DIFFERS_FROM_OWNED_FILL/);
});
test('unidentified transfers cannot cover a daily loss even when a second cash movement nets to zero',()=>{
  const state=initial();
  for(const type of ['TRANSFER','OTHER']){
    const a={incomeType:type,symbol:'',asset:'USDT',income:'50',time:at+1,tranId:15};
    assert.throws(()=>addFunding(state,'USD_M',[a,{...a,income:'-50',tranId:16}],at+3,scope),/UNRECONCILED_FUTURES_CASH_FLOW/);
    assert.equal(incomeCursor(state,'USD_M',scope),state.createdAt-1);
  }
});
test('a funding-only legacy ledger can replay both markets from creation without doubling balances',()=>{
  const state=initial(),other=otherIncome('FUNDING_FEE','-0.02',at,64,'');
  const old=addFunding(state,'USD_M',[other],at+100);
  assert.equal(incomeCursor(old,'USD_M',scope),state.createdAt-1);
  const partial=addFunding(old,'USD_M',[other],at+1,scope);
  assert.equal(incomeCursor(partial,'USD_M',scope),at+1);
  assert.equal(incomeCursor(partial,'COIN_M',scope),state.createdAt-1);
  assert.equal(incomeCursor(partial,'USD_M'),at+100);
  assert.equal(partial.funding.length,0);assert.equal(partial.externalIncome.length,1);
  assert.equal(nativeWalletsAt(partial)['USD_M.USDT'],'999.98');
});
test('a historical manual fill on a now selected but then flat symbol is external; overlapping or incomplete records stop',()=>{
  const manual={...otherIncome('COMMISSION','-0.07',at,52),symbol:'BTCUSDT'};
  const state=initial(),first=addFunding(state,'USD_M',[manual],at+2,scope);
  assert.equal(first.externalIncome.length,1);
  assert.throws(()=>addFunding(state,'USD_M',[{...manual,tradeId:''}],at+2,scope),/UNRECONCILED_MANUAL_FILL/);
  const pendingOrder=pending(initial());
  assert.throws(()=>addFunding(pendingOrder,'USD_M',[manual],at+2,scope),/UNRECONCILED_MANUAL_FILL/);
  const opened=applyFinalOrder(pendingOrder,...response(pendingOrder));
  assert.throws(()=>addFunding(opened,'USD_M',[{...manual,time:at+2}],at+3,{market:'USD_M',symbol:'SOLUSDT'}),/UNRECONCILED_MANUAL_FILL/);
});
const externalLeg=(market,symbol,qty,entryPrice,updateTime)=>({market,symbol,positionSide:'BOTH',positionAmt:qty,entryPrice,updateTime});
const midnightRule=async(market,symbol)=>market==='USD_M'?{marginAsset:'USDT',contractSize:'1',markPrice:'105'}:{marginAsset:'BTC',contractSize:'100',markPrice:'12000'};
test('external overnight floating PNL uses the midnight mark for an unchanged long and inverse short',async()=>{
  const state=initial(),rows=[externalLeg('USD_M','ETHUSDT','1','100',at-2000),externalLeg('COIN_M','BTCUSD_PERP','-3','10000',at-2000)];
  state.externalSnapshot=makeExternalSnapshot(rows,at-300);
  const current=makeExternalSnapshot(rows,at+1000);
  const result=await externalMidnightPnl(state,current,at,{contract:midnightRule,trades:()=>assert.fail('unchanged holdings have exchange timestamps')});
  assert.deepEqual(result,{'USD_M.USDT':'5','COIN_M.BTC':'-0.005'});
  assert.equal(state.fills.length,0);
});
test('a manual position fully closed since midnight still contributes its exact floating PNL at midnight',async()=>{
  const state=initial();
  state.externalSnapshot=makeExternalSnapshot([externalLeg('USD_M','ETHUSDT','1','100',at-3000)],at-1000);
  const current=makeExternalSnapshot([],at+1000);
  const sale={id:501,time:at+300,symbol:'ETHUSDT',side:'SELL',positionSide:'BOTH',qty:'1',price:'110',realizedPnl:'10'};
  const read=async(market,symbol,start,end)=>{assert.deepEqual([market,symbol,start,end],['USD_M','ETHUSDT',at-1000,at+1000]);return [sale];};
  assert.deepEqual(await externalMidnightPnl(state,current,at,{contract:midnightRule,trades:read}),{'USD_M.USDT':'5'});
  await assert.rejects(externalMidnightPnl(state,current,at,{contract:midnightRule,trades:async()=>[]}),/EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED/);
  await assert.rejects(externalMidnightPnl(state,current,at,{contract:midnightRule,trades:async()=>[sale,sale]}),/EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED/);
});
test('reconstruction separates before/after midnight fills, equity funding and bot-owned fills',async()=>{
  const manual=externalLeg('USD_M','ETHUSDT','2','105',at+100);
  const state=initial();
  state.externalSnapshot=makeExternalSnapshot([],at-1000);
  const current=makeExternalSnapshot([manual],at+1000);
  const buy=(id,time,qty,price)=>({id,time,qty,price,symbol:'ETHUSDT',side:'BUY',positionSide:'BOTH',realizedPnl:'0'});
  const rows=[buy(6,at-400,'1','100'),buy(7,at+100,'1','110'),buy(8,at+150,'1','109')];
  state.fills.push({key:'USD_M:ETHUSDT:8'});
  state.externalIncome=[{type:'COMMISSION',wallet:'USD_M.USDT',symbol:'ETHUSDT',tradeId:'7',time:at+100}];
  assert.deepEqual(await externalMidnightPnl(state,current,at,{contract:midnightRule,trades:async()=>rows}),{'USD_M.USDT':'5'});
  state.externalIncome[0].tradeId='9';
  await assert.rejects(externalMidnightPnl(state,current,at,{contract:midnightRule,trades:async()=>rows}),/EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED/);
});
test('a legacy bot-only account needs no external history, while unverified changed external holdings fail closed',async()=>{
  const fail=()=>assert.fail('no exchange requests expected');
  assert.deepEqual(await externalMidnightPnl(initial(),makeExternalSnapshot([],at+1000),at,{contract:fail,trades:fail}),{});
  const changed=makeExternalSnapshot([externalLeg('USD_M','ETHUSDT','1','100',at+500)],at+1000);
  await assert.rejects(externalMidnightPnl(initial(),changed,at,{contract:midnightRule,trades:async()=>[]}),/EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED/);
});
test('account identity uses stable aliases from both futures wallets, never a public key string',()=>{
  const balances={USD_M:[{accountAlias:'aliasA'}],COIN_M:[{accountAlias:'aliasB'}]};
  assert.match(accountIdentity(balances),/^[a-f0-9]{64}$/);assert.notEqual(accountIdentity(balances),accountIdentity({...balances,COIN_M:[{accountAlias:'other'}]}));
  assert.throws(()=>accountIdentity({...balances,COIN_M:[]}));
  assert.equal(walletSnapshot({USD_M:{canTrade:true,assets:[{asset:'USDT',walletBalance:'100'}]},COIN_M:{canTrade:true,assets:[{asset:'BTC',walletBalance:'0.01'}]}})['COIN_M.BTC'],'0.01');
});
