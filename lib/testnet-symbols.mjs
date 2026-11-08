// USDT-quoted Spot Testnet symbols only. Trading eligibility comes from the
// exchange catalog, never from this syntax check alone.
export function testnetSymbol(value){
  if(typeof value!=='string'||!/^[A-Z0-9]{1,20}USDT$/.test(value)||value==='USDTUSDT')throw new Error('需要有效的 USDT 现货测试网交易对。');
  return value;
}
export function testnetCatalog(info){
  if(!Array.isArray(info?.symbols)||info.symbols.length>10000)throw new Error('测试网币种列表无效。');
  const symbols=new Map();
  for(const item of info.symbols){
    try{testnetSymbol(item?.symbol);}catch{continue;}
    if(item.baseAsset!==item.symbol.slice(0,-4)||item.quoteAsset!=='USDT'||item.status!=='TRADING'||item.isSpotTradingAllowed!==true||
      !item.orderTypes?.includes('MARKET')||item.quoteOrderQtyMarketAllowed!==true||!Array.isArray(item.filters)||
      !item.filters.some(f=>f.filterType==='LOT_SIZE')||!item.filters.some(f=>['NOTIONAL','MIN_NOTIONAL'].includes(f.filterType)))continue;
    if(symbols.has(item.symbol))throw new Error('测试网币种列表重复，暂不更新。');
    symbols.set(item.symbol,{symbol:item.symbol,baseAsset:item.baseAsset,quoteAsset:'USDT',eligible:true});
  }
  if(!symbols.size)throw new Error('测试网没有返回可交易的 USDT 现货币种。');
  return [...symbols.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol));
}
