// Renderer-only fixture. The native self-test's broker factories always throw.
function rendererFixture(){
  const p=direction=>({market:'USD_M',symbol:'BTCUSDT',direction,positionSide:direction,quantity:'0.01',entryPrice:direction==='LONG'?'10005':'9994',marginAsset:'USDT',contractSize:'1',risk:{stopLossPercent:1,takeProfitPercent:2,trailingPercent:0.5}});
  const stop=direction=>({id:'offline-'+direction,quantity:'0.01',triggerPrice:direction==='LONG'?'9905':'10094',status:'NEW'});
  const policy={version:1,format:'AdaptiveAutoMargin',id:'offline-ui-budget',enabled:true,market:'USD_M',symbol:'BTCUSDT',asset:'USDT',positionSides:['LONG','SHORT'],trigger:{liquidationDistancePercentAtMost:2},perAdditionAmount:'5',maxTotalAmount:'10',maxAdditions:2,cooldownSeconds:60};
  return {tradingAuthorized:true,version:'0.4.1-customer',environment:'BINANCE_FUTURES_MAINNET',edition:'customer',running:false,autoMarginArmed:false,unlocked:true,vaultExists:true,connected:true,pending:false,error:null,reconnecting:false,logs:[],preferences:{autoConnect:false},settings:{market:'USD_M',symbol:'BTCUSDT',marginMode:'ISOLATED',leverage:10,marginPercent:1,positionPolicy:'hedge',directionMode:'both',dailyLossPercent:20,externalStrategy:null,externalMarginPolicy:policy},snapshot:{accountChecked:true,equityUsdt:'999',day:{baselineUsdt:'1000',blocked:false,firstDay:true},lossPercent:0.1,realOrderCount:2,market:'USD_M',symbol:'BTCUSDT',marginAsset:'USDT',markPrice:'10000',fundingRate:'0.0001',nextFundingTime:Date.now()+3600000,configuration:{marginMode:'ISOLATED',leverage:10,autoAddMargin:false,legs:{LONG:{autoAddMargin:false,isolatedWallet:'10',liquidationPrice:'9100'},SHORT:{autoAddMargin:false,isolatedWallet:'10',liquidationPrice:'10900'}}},hedge:true,positionPolicy:'hedge',actualConfigurationMatches:true,positions:{LONG:p('LONG'),SHORT:p('SHORT')},protections:{LONG:stop('LONG'),SHORT:stop('SHORT')},position:null,protection:null,hedgeLock:null,signals:{LONG:{intent:null,reason:'HOLD_POSITION'},SHORT:{intent:null,reason:'HOLD_POSITION'}},sideBlockers:{LONG:null,SHORT:null},signal:{intent:null,reason:'HOLD_POSITION'},plan:null,blocker:null,candles:[],orders:[],marginEvents:[],autoMargin:{armed:false,policy,budget:{usedAmount:'0',additions:0},decision:{eligible:false,reason:'AUTO_MARGIN_NOT_ARMED'}},checkedAt:Date.now()}};
}

// Use the customer's reporting code with fills and income generated entirely in memory.
module.exports=function(buildTradeReport){
  const state=rendererFixture();
  if(!buildTradeReport)return state;
  const snapshot=state.snapshot;
  const start=snapshot.checkedAt-3600000;
  function fill(orderId,minutes,effect,direction,price,commission,overrides={}){
    return {key:'offline-fill-'+orderId,market:'USD_M',symbol:'BTCUSDT',marginAsset:'USDT',
      contractSize:'1',orderId,time:start+minutes*60000,effect,direction,quantity:'0.01',
      price,realizedPnl:'0',commission,commissionAsset:'USDT',...overrides};
  }
  function order(row){
    return {id:'offline-order-'+row.orderId,orderId:row.orderId,market:row.market,symbol:row.symbol,
      intent:row.effect+'_'+row.direction,side:(row.effect==='OPEN')===(row.direction==='LONG')?'BUY':'SELL',
      status:'FILLED',quantity:row.quantity,time:row.time};
  }
  function funding(minutes,symbol,amount){
    return {key:'USD_M:FUNDING_FEE:'+minutes,time:start+minutes*60000,wallet:'USD_M.USDT',symbol,amount};
  }
  const fills=[
    fill(51,3,'OPEN','LONG','10000','0.04'),
    fill(52,19,'CLOSE','LONG','10100','0.05',{realizedPnl:'1'}),
    fill(53,27,'OPEN','LONG','10000','0.02'),
    fill(54,36,'OPEN','SHORT','10060','0.001',{commissionAsset:'BNB'})
  ];
  const orders=fills.map(order);
  orders.push({...orders[0],id:'offline-no-fill',orderId:55,status:'EXPIRED',quantity:'0',time:start+42*60000});
  for(const row of fills.slice(2)){
    Object.assign(snapshot.positions[row.direction],{entryPrice:row.price,openedAt:row.time});
  }
  snapshot.markPrice='10040';
  snapshot.feeRates={taker:'0.0005'};
  snapshot.tradeReport=buildTradeReport({fills,orders,positions:snapshot.positions,
    incomeThrough:{USD_M:snapshot.checkedAt},funding:[funding(11,'BTCUSDT','0.02'),funding(24,'ETHUSDT','-0.003')]},snapshot);
  return state;
};
