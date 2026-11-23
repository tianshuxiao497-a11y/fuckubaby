import test from 'node:test';
import assert from 'node:assert/strict';
import {newLedger,applyFinalOrder,nativeWalletsAt,addFunding,verifyWallets,accountIdentity,walletSnapshot} from './ledger.mjs';
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
test('account identity uses stable aliases from both futures wallets, never a public key string',()=>{
  const balances={USD_M:[{accountAlias:'aliasA'}],COIN_M:[{accountAlias:'aliasB'}]};
  assert.match(accountIdentity(balances),/^[a-f0-9]{64}$/);assert.notEqual(accountIdentity(balances),accountIdentity({...balances,COIN_M:[{accountAlias:'other'}]}));
  assert.throws(()=>accountIdentity({...balances,COIN_M:[]}));
  assert.equal(walletSnapshot({USD_M:{canTrade:true,assets:[{asset:'USDT',walletBalance:'100'}]},COIN_M:{canTrade:true,assets:[{asset:'BTC',walletBalance:'0.01'}]}})['COIN_M.BTC'],'0.01');
});
