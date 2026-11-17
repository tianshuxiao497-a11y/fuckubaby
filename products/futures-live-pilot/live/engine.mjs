import {mkdir,readFile,lstat,open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {atomicWriteJson} from '../../../lib/atomic-json.mjs';
import {FUTURES_CONFIRMATION,SETTINGS_CONFIRMATION,ownAlgoId} from './client.mjs';
import {units,signedUnits,decimal,multiply,multiplyUp,divide,floorStep,ceilStep,SCALE,absolute,openingQuantity,stopPrice,totalEquityUsdt,pnl,dailyLock} from './math.mjs';
import {contractSymbol,contractRules,leverageTiers,checkLeverage,checkIsolatedStop,futuresFees,signedPosition} from './market.mjs';
import {accountIdentity,walletSnapshot,newLedger,validateLedger,nativeWalletsAt,aggregateAssets,verifyWallets,addFunding,applyFinalOrder} from './ledger.mjs';
import {parseFuturesStrategy,futuresSignal} from './strategy.mjs';
export const FUTURES_VERSION='0.1.0-futures-personal';
export function validateSettings(value){
  const keys=['market','symbol','marginMode','leverage','marginPercent','directionMode','dailyLossPercent','externalStrategy'];
  if(!value||Object.keys(value).some(k=>!keys.includes(k))||!['USD_M','COIN_M'].includes(value.market)||!['CROSSED','ISOLATED'].includes(value.marginMode)||!Number.isSafeInteger(value.leverage)||value.leverage<1||value.leverage>1000||typeof value.marginPercent!=='number'||!Number.isFinite(value.marginPercent)||value.marginPercent<1||value.marginPercent>2||!['both','long','short'].includes(value.directionMode)||value.dailyLossPercent!==20)throw new Error('EXPLICIT_FUTURES_MARGIN_LEVERAGE_AND_RISK_REQUIRED');
  contractSymbol(value.symbol);
  return {...value,externalStrategy:value.externalStrategy?parseFuturesStrategy(JSON.stringify(value.externalStrategy)):null};
}
const terminal=new Set(['FILLED','CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH']);
const algoTerminal=new Set(['FINISHED','CANCELED','CANCELLED','REJECTED','EXPIRED','TRIGGERED']);
const mode=value=>value==='cross'||value==='CROSS'||value==='CROSSED'?'CROSSED':value==='isolated'||value==='ISOLATED'?'ISOLATED':null;
const notFound=error=>[-2011,-2013].includes(error.binanceCode);
const entryId=()=> 'asbf_'+randomBytes(14).toString('hex');
const algoId=()=> 'asbp_'+randomBytes(14).toString('hex');
const dateAt=time=>new Date(time+8*3600000).toISOString().slice(0,10);
const dayStart=time=>Date.parse(dateAt(time)+'T00:00:00.000+08:00');

export class FuturesEngine{
  constructor({profile,clients,settings,now=Date.now,guard=()=>true,signalFactory=futuresSignal}){
    this.profile=resolve(profile);this.file=resolve(this.profile,'futures-ledger.json');this.clients=clients;this.settings=validateSettings(settings);this.now=now;this.guard=guard;this.signalFactory=signalFactory;this.running=false;this.busy=false;this.state=null;this.last=null;this.error=null;this.cache=new Map();
    if(!clients?.USD_M||!clients?.COIN_M)throw new Error('BOTH_FUTURES_CLIENTS_REQUIRED');
  }
  get client(){return this.clients[this.settings.market];}
  time(){try{return this.client.serverNow?.()??this.now();}catch{return this.now();}}
  async acquire(){
    await mkdir(this.profile,{recursive:true,mode:0o700});if((await lstat(this.profile)).isSymbolicLink())throw new Error('REGULAR_FUTURES_PROFILE_REQUIRED');
    const marker=resolve(this.profile,'futures.lock'),identity=process.platform==='win32'?this.profile.toLowerCase():this.profile,port=42000+createHash('sha256').update(identity).digest().readUInt32BE(0)%17000;
    const socket=createServer(c=>c.destroy());
    try{
      await new Promise((ok,bad)=>{socket.once('error',bad);socket.listen({host:'127.0.0.1',port,exclusive:true},ok);});this.socket=socket;socket.unref();
      try{const pid=(await readFile(marker,'utf8')).trim();if(!/^[1-9]\d{0,9}$/.test(pid))throw new Error('INVALID_FUTURES_LOCK');try{process.kill(Number(pid),0);throw new Error('FUTURES_PROFILE_OWNER_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}await unlink(marker);}catch(e){if(e.code!=='ENOENT')throw e;}
      this.lock=await open(marker,'wx',0o600);await this.lock.writeFile(String(process.pid));await this.lock.sync();this.lockPath=marker;
      try{const info=await lstat(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>67108864)throw new Error('INVALID_FUTURES_LEDGER_FILE');this.state=validateLedger(JSON.parse(await readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
    }catch(error){await this.close();throw error;}
    return this;
  }
  async commit(state){validateLedger(state);await atomicWriteJson(this.file,state);this.state=state;}
  stop(){this.running=false;for(const client of Object.values(this.clients))client.disarm();}
  async close(){this.stop();if(this.lock){await this.lock.close();this.lock=null;await unlink(this.lockPath).catch(()=>{});}if(this.socket){await new Promise(ok=>this.socket.close(ok));this.socket=null;}}
  async cached(key,ttl,read){const old=this.cache.get(key);if(old&&this.now()>=old.time&&this.now()-old.time<ttl)return old.value;const value=await read();this.cache.set(key,{time:this.now(),value});return value;}
  async verifyProtectionQuery(){
    return this.cached('algo-query:'+this.settings.market,60000,async()=>{
      try{await this.client.request('algo',{clientAlgoId:algoId()});}
      catch(error){if(error.binanceCode===-2013)return true;throw new Error('EXCHANGE_PROTECTION_QUERY_UNAVAILABLE');}
      throw new Error('EXCHANGE_PROTECTION_QUERY_NOT_VERIFIED');
    });
  }
  async environment(){
    await Promise.all(Object.values(this.clients).map(c=>c.syncTime()));
    const accounts={},balances={},positions={},orders={},algos={};
    await Promise.all(['USD_M','COIN_M'].map(async market=>{
      const c=this.clients[market];[accounts[market],balances[market],positions[market],orders[market],algos[market]]=await Promise.all([c.request('account'),c.request('balances'),c.request('positions'),c.request('openOrders'),c.request('openAlgos')]);
      if(![balances[market],positions[market],orders[market],algos[market]].every(Array.isArray))throw new Error('COMPLETE_FUTURES_ACCOUNT_SNAPSHOT_REQUIRED');
    }));
    const [positionMode,multiAssets]=await Promise.all([this.cached('positionMode',10000,()=>this.clients.USD_M.request('positionMode')),this.cached('multiAssets',10000,()=>this.clients.USD_M.request('multiAssets'))]);
    if(typeof positionMode.dualSidePosition!=='boolean'||multiAssets.multiAssetsMargin!==false)throw new Error('STANDARD_SINGLE_ASSET_FUTURES_MODE_REQUIRED');
    return {accounts,balances,positions,orders,algos,hedge:positionMode.dualSidePosition,uid:accountIdentity(balances),wallets:walletSnapshot(accounts)};
  }
  assertOwnedEnvironment(env){
    const position=this.state?.position;
    for(const market of ['USD_M','COIN_M']){
      const nonzero=env.positions[market].filter(row=>signedPosition(row).quantity!=='0');
      if(nonzero.length!==(position?.market===market?1:0))throw new Error('UNMANAGED_OR_CHANGED_FUTURES_POSITION');
      if(nonzero.length){const row=nonzero[0],signed=signedPosition(row);if(row.symbol!==position.symbol||row.positionSide!==position.positionSide||signed.direction!==position.direction||units(signed.quantity)!==units(position.quantity))throw new Error('FUTURES_POSITION_DIFFERS_FROM_OWNED_LEDGER');}
      if(env.orders[market].length)throw new Error('UNRESOLVED_OR_UNMANAGED_FUTURES_ORDERS');
      for(const row of env.algos[market])if(this.state?.protection?.market!==market||row.clientAlgoId!==this.state.protection.id)throw new Error('UNMANAGED_FUTURES_PROTECTION_ORDER');
    }
  }
  async configuration(env,rules){
    const rows=env.positions[this.settings.market],position=rows.find(row=>row.symbol===rules.symbol&&(row.positionSide==='BOTH'||row.positionSide==='LONG'));
    let value;
    if(this.settings.market==='USD_M'){
      const result=await this.client.request('symbolConfig',{symbol:rules.symbol});value=Array.isArray(result)?result.find(row=>row.symbol===rules.symbol):result;
    }else value=position??rows.find(row=>row.symbol===rules.symbol);
    if(!value||value.symbol!==rules.symbol||!mode(value.marginType)||!Number.isSafeInteger(Number(value.leverage)))throw new Error('CURRENT_CONTRACT_CONFIGURATION_UNAVAILABLE');
    return {marginMode:mode(value.marginType),leverage:Number(value.leverage),autoAddMargin:value.isAutoAddMargin===true||value.isAutoAddMargin==='true'};
  }
  async prices(wallets,historicalAt=null){
    const assets=Object.entries(aggregateAssets(wallets)).filter(([,value])=>signedUnits(value)!==0n).map(([name])=>name),result={USDT:'1'};
    if(assets.length>24)throw new Error('TOO_MANY_COLLATERAL_ASSETS_REVIEW_REQUIRED');
    await Promise.all(assets.filter(name=>name!=='USDT').map(async name=>{
      const row=historicalAt===null?await this.cached('fx:'+name,3000,()=>this.clients.USD_M.request('collateralPrice',{symbol:name+'USDT'})):await this.clients.USD_M.request('collateralCandles',{symbol:name+'USDT',interval:'1m',limit:1,startTime:historicalAt,endTime:historicalAt+59999});
      const price=historicalAt===null?row.price:Array.isArray(row)&&row[0]?.[0]===historicalAt?row[0][1]:null;
      if(typeof price!=='string'||!units(price))throw new Error('COLLATERAL_USDT_VALUATION_UNAVAILABLE');result[name]=price;
    }));return result;
  }
  async incomeRange(market,start,end,depth=0){
    if(start>end)return[];if(depth>32)throw new Error('FUTURES_INCOME_HISTORY_LIMIT');
    const rows=await this.clients[market].request('income',{startTime:start,endTime:end,limit:1000});if(!Array.isArray(rows))throw new Error('FUTURES_INCOME_HISTORY_REQUIRED');
    if(rows.length<1000)return rows;
    if(end-start<2)throw new Error('FUTURES_INCOME_HISTORY_REQUIRES_MANUAL_ARCHIVE');
    const middle=Math.floor((start+end)/2);return [...await this.incomeRange(market,start,middle,depth+1),...await this.incomeRange(market,middle+1,end,depth+1)];
  }
  async syncFunding(now){
    for(const market of ['USD_M','COIN_M']){
      let through=this.state.incomeThrough[market];if(now-through<15000)continue;
      while(through<now){const end=Math.min(now,through+6*86400000),rows=await this.incomeRange(market,through+1,end);await this.commit(addFunding(this.state,market,rows,end));through=end;}
    }
  }
  async reconcile(){
    const pending=this.state?.pending;if(!pending)return;
    const c=this.clients[pending.market];await c.syncTime();
    if(pending.kind==='ORDER'){
      let order;try{order=await c.request('order',pending.exchangeOrderId?{symbol:pending.args.symbol,orderId:pending.exchangeOrderId}:{symbol:pending.args.symbol,origClientOrderId:pending.id});}
      catch(error){if(notFound(error)&&pending.definitiveRejection){await this.commit({...this.state,pending:null,orders:[...this.state.orders,{id:pending.id,orderId:null,market:pending.market,symbol:pending.args.symbol,intent:pending.intent,side:pending.args.side,positionSide:pending.args.positionSide,quantity:'0',status:'REJECTED',time:pending.createdAt,rejectionCode:pending.definitiveRejection}]});return;}if(notFound(error))throw new Error('FUTURES_ORDER_RESULT_UNRESOLVED_DO_NOT_RESUBMIT');throw error;}
      if(!terminal.has(order.status))throw new Error('FUTURES_ORDER_NOT_TERMINAL');
      const fills=units(order.executedQty)?await c.request('trades',{symbol:pending.args.symbol,orderId:order.orderId,limit:1000}):[];
      await this.commit(applyFinalOrder(this.state,order,fills));return;
    }
    let algo;try{algo=await c.request('algo',{clientAlgoId:pending.id});}catch(error){if(notFound(error)&&pending.kind==='PROTECTION'&&pending.definitiveRejection){await this.commit({...this.state,pending:null,protectionRejected:pending.definitiveRejection});return;}if(notFound(error))throw new Error('FUTURES_PROTECTION_RESULT_UNRESOLVED');throw error;}
    if(pending.kind==='CANCEL_PROTECTION'){
      if(!algoTerminal.has(algo.algoStatus))throw new Error('FUTURES_PROTECTION_CANCEL_NOT_CONFIRMED');
      await this.commit({...this.state,protection:null,pending:null});return;
    }
    const args=pending.args;
    if(algo.clientAlgoId!==pending.id||algo.symbol!==args.symbol||algo.side!==args.side||algo.positionSide!==args.positionSide||(algo.orderType??algo.type)!=='STOP_MARKET'||algo.workingType!=='MARK_PRICE'||units(String(algo.quantity))!==units(args.quantity)||units(String(algo.triggerPrice))!==units(args.triggerPrice)||(args.positionSide==='BOTH'&&algo.reduceOnly!==true))throw new Error('EXCHANGE_PROTECTION_DETAILS_MISMATCH');
    if(!['NEW','TRIGGERED','FINISHED'].includes(algo.algoStatus))throw new Error('EXCHANGE_PROTECTION_NOT_ACTIVE');
    await this.commit({...this.state,pending:null,protection:{...args,id:pending.id,market:pending.market,algoId:algo.algoId,status:algo.algoStatus}});
    await this.syncProtection();
  }
  async syncProtection(){
    const p=this.state?.protection;if(!p)return;const c=this.clients[p.market],algo=await c.request('algo',{clientAlgoId:p.id});
    if(algo.clientAlgoId!==p.id||algo.symbol!==p.symbol||algo.positionSide!==p.positionSide)throw new Error('OWNED_PROTECTION_REFERENCE_MISMATCH');
    if(['TRIGGERED','FINISHED'].includes(algo.algoStatus)){
      const actual=Number(algo.actualOrderId);
      if(!Number.isSafeInteger(actual)||actual<=0)throw new Error('TRIGGERED_PROTECTION_ORDER_NOT_AVAILABLE_YET');
      if(this.state.orders.some(row=>row.market===p.market&&row.orderId===actual))throw new Error('FINISHED_PROTECTION_REQUIRES_MANUAL_REVIEW');
      if(!this.state.position)throw new Error('PROTECTION_TRIGGER_REQUIRES_POSITION_REVIEW');
      const order=await c.request('order',{symbol:p.symbol,orderId:actual});
      if(!terminal.has(order.status))throw new Error('PROTECTION_EXIT_NOT_TERMINAL');
      const fills=units(order.executedQty)?await c.request('trades',{symbol:p.symbol,orderId:actual,limit:1000}):[];
      const rules={marginAsset:this.state.position.marginAsset,contractSize:this.state.position.contractSize};
      const pending={kind:'ORDER',id:entryId(),createdAt:this.time(),market:p.market,intent:'PROTECTION_CLOSE',direction:this.state.position.direction,protectionId:p.id,exchangeOrderId:actual,rules,args:{symbol:p.symbol,side:p.side,positionSide:p.positionSide,type:order.type,quantity:order.origQty}};
      await this.commit({...this.state,pending});await this.commit(applyFinalOrder(this.state,order,fills));
      if(this.state.position)throw new Error('PROTECTION_PARTIALLY_CLOSED_REVIEW_REQUIRED');
      await this.commit({...this.state,protection:null});return;
    }
    if(algo.algoStatus!=='NEW'&&this.state.position)throw new Error('OWNED_POSITION_WITHOUT_ACTIVE_EXCHANGE_STOP');
  }
  async protect(){
    const position=this.state?.position;if(!position||this.state.pending)throw new Error('KNOWN_UNPROTECTED_POSITION_REQUIRED');
    const c=this.clients[position.market],catalog=await this.cached('catalog:'+position.market,600000,()=>c.request('catalog'));
    const rules=contractRules(catalog,position.market,position.symbol),mark=await c.request('mark',{symbol:position.symbol}),row=Array.isArray(mark)?mark.find(r=>r.symbol===position.symbol):mark;
    const trigger=stopPrice({side:position.direction,entryPrice:position.entryPrice,stopLossPercent:position.risk.stopLossPercent,tickSize:rules.tickSize});
    if(!row||!units(row.markPrice)||(position.direction==='LONG'?units(trigger)>=units(row.markPrice):units(trigger)<=units(row.markPrice)))throw new Error('PROTECTIVE_STOP_ALREADY_CROSSED_CLOSE_REVIEW_REQUIRED');
    const actualPositions=await c.request('positions'),actual=actualPositions.find(r=>r.symbol===position.symbol&&r.positionSide===position.positionSide);
    if(!actual||units(signedPosition(actual).quantity)!==units(position.quantity))throw new Error('VERIFY_OWN_POSITION_BEFORE_PROTECTION');
    const liquidation=units(actual.liquidationPrice);
    if(liquidation>0n&&(position.direction==='LONG'?units(trigger)<=liquidation+units(rules.tickSize):units(trigger)+units(rules.tickSize)>=liquidation))throw new Error('PROTECTIVE_STOP_BEYOND_EXCHANGE_LIQUIDATION_PRICE');
    const args={algoType:'CONDITIONAL',symbol:position.symbol,side:position.direction==='LONG'?'SELL':'BUY',positionSide:position.positionSide,type:'STOP_MARKET',quantity:position.quantity,triggerPrice:trigger,workingType:'MARK_PRICE',priceProtect:'FALSE',...(position.positionSide==='BOTH'?{reduceOnly:'true'}:{})};
    const id=algoId();await this.commit({...this.state,pending:{kind:'PROTECTION',market:position.market,id,args,createdAt:this.time()}});
    if(!this.running||!this.guard()){await this.commit({...this.state,pending:null});throw new Error('START_REQUIRED_TO_REPAIR_EXCHANGE_PROTECTION');}
    try{await c.request('newProtection',{...args,clientAlgoId:id});}catch(error){if(error.definitiveRejection)await this.commit({...this.state,pending:{...this.state.pending,definitiveRejection:error.binanceCode}});throw error;}await this.reconcile();
  }
  async cancelProtection(){
    const p=this.state?.protection;if(!p)return;if(this.state.position)throw new Error('FLAT_POSITION_REQUIRED_BEFORE_PROTECTION_REMOVAL');
    const pending={kind:'CANCEL_PROTECTION',market:p.market,id:p.id,createdAt:this.time()};await this.commit({...this.state,pending});
    await this.clients[p.market].request('cancelProtection',{clientAlgoId:p.id});await this.reconcile();
  }
  async baseline(now,currentEquity){
    const date=dateAt(now);if(this.state.day?.date===date)return this.state.day;
    if(dayStart(now)<this.state.createdAt)return {date,baselineUsdt:this.state.firstEquityUsdt??currentEquity,blocked:false,firstDay:true};
    const boundary=dayStart(now),wallets=nativeWalletsAt(this.state,boundary),assets=aggregateAssets(wallets),prices=await this.prices(wallets,boundary);
    let position=null;
    for(const f of [...this.state.fills].filter(f=>f.time<boundary).sort((a,b)=>a.time-b.time)){
      if(f.effect==='OPEN'){
        const old=position?.quantity??'0',q=units(old)+units(f.quantity);
        const value=position?(f.market==='USD_M'?multiply(units(old),units(position.entryPrice)):divide(multiply(units(old),units(f.contractSize)),units(position.entryPrice))):0n;
        const extra=f.market==='USD_M'?multiply(units(f.quantity),units(f.price)):divide(multiply(units(f.quantity),units(f.contractSize)),units(f.price));
        position={...f,quantity:decimal(q),entryPrice:decimal(f.market==='USD_M'?divide(value+extra,q):divide(multiply(q,units(f.contractSize)),value+extra))};
      }else if(position){const q=units(position.quantity)-units(f.quantity);if(q<0n)throw new Error('INVALID_HISTORICAL_POSITION');position=q?{...position,quantity:decimal(q)}:null;}
    }
    if(position){
      const rows=await this.clients[position.market].request('markCandles',{symbol:position.symbol,interval:'1m',limit:1,startTime:boundary,endTime:boundary+59999});
      if(!Array.isArray(rows)||rows[0]?.[0]!==boundary)throw new Error('MIDNIGHT_MARK_PRICE_REQUIRED');
      const profit=pnl({market:position.market,side:position.direction,quantity:position.quantity,entryPrice:position.entryPrice,exitPrice:rows[0][1],contractSize:position.contractSize});
      assets[position.marginAsset]=decimal(signedUnits(assets[position.marginAsset]??'0')+signedUnits(profit));
    }
    const value=totalEquityUsdt(assets,prices);if(signedUnits(value)<=0n)throw new Error('POSITIVE_MIDNIGHT_EQUITY_REQUIRED');return {date,baselineUsdt:value,blocked:false,firstDay:false};
  }
  async check({execute=false}={}){
    if(this.busy)throw new Error('FUTURES_ACTION_IN_PROGRESS');this.busy=true;
    try{
      let env=await this.environment();
      if(this.state&&this.state.uid!==env.uid)throw new Error('FUTURES_ACCOUNT_DIFFERS_FROM_SAVED_LEDGER');
      if(!this.state){this.assertOwnedEnvironment(env);const created=newLedger(env.uid,env.wallets,this.time()),fx=await this.prices(env.wallets);created.firstEquityUsdt=totalEquityUsdt(aggregateAssets(env.wallets),fx);if(signedUnits(created.firstEquityUsdt)<=0n)throw new Error('POSITIVE_FUTURES_CAPITAL_REQUIRED');await this.commit(created);}
      const before=JSON.stringify({pending:this.state.pending,position:this.state.position,protection:this.state.protection});
      await this.reconcile();await this.syncProtection();
      if(before!==JSON.stringify({pending:this.state.pending,position:this.state.position,protection:this.state.protection}))env=await this.environment();
      this.assertOwnedEnvironment(env);
      await this.syncFunding(this.time());verifyWallets(this.state,env.wallets);
      const {market,symbol}=this.settings,c=this.client;
      const catalog=await this.cached('catalog:'+market,600000,()=>c.request('catalog')),rules=contractRules(catalog,market,symbol);
      const started=this.now();
      let [book,mark,rows,rawFees,rawTiers,configuration]=await Promise.all([
        c.request('book',{symbol}),c.request('mark',{symbol}),c.request('candles',{symbol,interval:'1m',limit:100}),
        this.cached('fees:'+market+':'+symbol,60000,()=>c.request('fees',{symbol})),
        this.cached('brackets:'+market+':'+symbol,60000,()=>c.request('brackets',{symbol})),this.configuration(env,rules),
      ]);
      if(Array.isArray(book))book=book.find(row=>row.symbol===symbol);if(Array.isArray(mark))mark=mark.find(row=>row.symbol===symbol);
      if(this.now()<started||this.now()-started>5000||book?.symbol!==symbol||mark?.symbol!==symbol||!units(book.bidPrice)||units(book.askPrice)<units(book.bidPrice)||!units(mark.markPrice))throw new Error('INVALID_OR_STALE_FUTURES_MARKET');
      const now=this.time(),fees=futuresFees(rawFees,symbol),tiers=leverageTiers(rawTiers,market,symbol),marginWallets={...env.wallets};
      for(const family of ['USD_M','COIN_M'])for(const a of env.accounts[family].assets){
        if(typeof a.unrealizedProfit!=='string')throw new Error('COMPLETE_UNREALIZED_PNL_REQUIRED');
        marginWallets[family+'.'+a.asset]=decimal(signedUnits(a.walletBalance)+signedUnits(a.unrealizedProfit));
      }
      const fx=await this.prices(marginWallets),equity=totalEquityUsdt(aggregateAssets(marginWallets),fx);
      const basis=await this.baseline(now,equity),day={...basis,...dailyLock({previous:this.state.day,date:dateAt(now),baselineUsdt:basis.baselineUsdt,equityUsdt:equity})};
      await this.commit({...this.state,day});
      const signal=this.signalFactory({rows,now,book,position:this.state.position,external:this.settings.externalStrategy,directionMode:this.settings.directionMode,roundTripFeePercent:Number(fees.reserve)*200});
      let plan=null,blocker=null;
      const actualConfigurationMatches=configuration.marginMode===this.settings.marginMode&&configuration.leverage===this.settings.leverage;
      if(!actualConfigurationMatches)blocker='CONTRACT_MARGIN_OR_LEVERAGE_SETTINGS_DIFFER';
      if(configuration.marginMode==='ISOLATED'&&configuration.autoAddMargin)blocker='ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED';
      if(this.state.position&&!this.state.protection)blocker='OWNED_POSITION_NEEDS_EXCHANGE_PROTECTION';
      if(this.state.position&&this.state.protection&&this.state.position.quantity!==this.state.protection.quantity)blocker='PARTIAL_CLOSE_PROTECTION_QUANTITY_REVIEW_REQUIRED';
      if(this.state.protection&&!this.state.position)blocker='FLAT_POSITION_HAS_STALE_PROTECTION';
      if(signal.intent?.startsWith('OPEN_')&&day.blocked)blocker='DAILY_USDT_EQUITY_LOSS_20_PERCENT';
      if(signal.intent?.startsWith('OPEN_')){
        const lastClose=Math.max(0,...this.state.orders.filter(row=>row.intent.startsWith('CLOSE_')||row.intent==='PROTECTION_CLOSE').map(row=>row.time));
        if(now-lastClose<60000)blocker='CLOSED_POSITION_REENTRY_COOLDOWN';
        if(this.state.orders.filter(row=>row.intent.startsWith('OPEN_')&&row.quantity!=='0'&&row.time>now-3600000).length>=6)blocker='HOURLY_FUTURES_ENTRY_LIMIT';
      }
      if(signal.intent&&!blocker){
        try{
          const side=signal.intent.endsWith('LONG')?'LONG':'SHORT',closing=signal.intent.startsWith('CLOSE_'),buy=side==='LONG'?!closing:closing;
          const price=buy?ceilStep(multiplyUp(units(book.askPrice),units('1.0005')),units(rules.tickSize)):floorStep(multiply(units(book.bidPrice),units('0.9995')),units(rules.tickSize));
          if(!price||price<units(rules.minPrice)||(units(rules.maxPrice)>0n&&price>units(rules.maxPrice)))throw new Error('CONTRACT_PRICE_FILTER_BLOCKED');
          const positionSide=env.hedge?side:'BOTH';
          let quantity,allocation=null;
          if(closing){quantity=this.state.position.quantity;if(floorStep(units(quantity),units(rules.stepSize))!==units(quantity))throw new Error('OWNED_QUANTITY_NO_LONGER_MATCHES_LOT_STEP');}
          else{
            await this.verifyProtectionQuery();
            const balance=env.balances[market].find(row=>row.asset===rules.marginAsset);
            if(!balance||typeof balance.availableBalance!=='string')throw new Error('SELECTED_COLLATERAL_BALANCE_REQUIRED');
            allocation=openingQuantity({market,totalEquity:equity,marginPercent:this.settings.marginPercent,collateralUsdt:fx[rules.marginAsset]??(rules.marginAsset==='USDT'?'1':undefined),availableCollateral:balance.availableBalance,leverage:this.settings.leverage,price:decimal(price),contractSize:rules.contractSize,stepSize:rules.stepSize,minimumQuantity:rules.minimumQuantity,maximumQuantity:rules.maximumQuantity,minimumNotional:rules.minimumNotional,feeRate:fees.reserve});
            quantity=allocation.quantity;checkLeverage({market,quantity,price:decimal(price),contractSize:rules.contractSize,leverage:this.settings.leverage,tiers});
            if(configuration.marginMode==='ISOLATED')checkIsolatedStop({leverage:this.settings.leverage,stopLossPercent:signal.risk.stopLossPercent,feeRate:fees.reserve,tiers});
          }
          plan={intent:signal.intent,direction:side,market,rules,risk:signal.risk,allocation,args:{symbol,side:buy?'BUY':'SELL',positionSide,type:'LIMIT',timeInForce:'IOC',quantity,price:decimal(price),newOrderRespType:'ACK',...(positionSide==='BOTH'?{reduceOnly:closing?'true':'false'}:{})}};
        }catch(error){blocker=/^[A-Z0-9_]+$/.test(error.message)?error.message:'FUTURES_ORDER_PLAN_BLOCKED';}
      }
      if(this.state.position&&signal.peakReturnPercent!==undefined)await this.commit({...this.state,position:{...this.state.position,peakReturnPercent:signal.peakReturnPercent}});
      const positionRisk=this.state.position?env.positions[market].find(row=>row.symbol===symbol&&row.positionSide===this.state.position.positionSide):null;
      this.last={version:FUTURES_VERSION,environment:'BINANCE_FUTURES_MAINNET',checkedAt:now,localCheckedAt:this.now(),accountChecked:true,equityUsdt:equity,firstEquityUsdt:this.state.firstEquityUsdt,day,lossPercent:(1-Number(equity)/Number(day.baselineUsdt))*100,market,symbol,marginAsset:rules.marginAsset,configuration,actualConfigurationMatches,hedge:env.hedge,
        feeRates:fees,leverageTiers:tiers,markPrice:mark.markPrice,fundingRate:mark.lastFundingRate??null,nextFundingTime:mark.nextFundingTime??null,liquidationPrice:positionRisk?.liquidationPrice??null,position:this.state.position,protection:this.state.protection,pending:this.state.pending,
        signal,plan,blocker,wallets:env.wallets,collateralPrices:fx,book:{bid:book.bidPrice,ask:book.askPrice},candles:signal.candles,orders:this.state.orders.slice(-50),realOrderCount:this.state.orders.length,running:this.running};
      this.error=null;
      if(execute&&this.running&&plan&&this.guard()){
        await this.execute(plan);Object.assign(this.last,{position:this.state.position,protection:this.state.protection,pending:this.state.pending,orders:this.state.orders.slice(-50),realOrderCount:this.state.orders.length});
      }
      return this.last;
    }catch(error){this.error=/^[A-Z0-9_]+$/.test(error.message)?error.message:'FUTURES_CHECK_FAILED';this.stop();throw error;}
    finally{this.busy=false;}
  }
  async execute(plan){
    if(!this.running||!this.guard()||this.state.pending||this.time()<this.last.checkedAt||this.time()-this.last.checkedAt>3000||JSON.stringify(plan)!==JSON.stringify(this.last.plan))throw new Error('REVIEWED_FRESH_FUTURES_PLAN_REQUIRED');
    if(plan.intent.startsWith('OPEN_')&&(this.state.position||this.state.protection||this.state.day.blocked))throw new Error('FUTURES_OPENING_BLOCKED');
    const id=entryId(),pending={kind:'ORDER',id,createdAt:this.time(),market:plan.market,intent:plan.intent,direction:plan.direction,args:plan.args,rules:plan.rules,risk:plan.risk};
    await this.commit({...this.state,pending});
    if(!this.running||!this.guard()||this.time()-this.last.checkedAt>3000){await this.commit({...this.state,pending:null});return;}
    try{await this.clients[plan.market].request('newOrder',{...plan.args,newClientOrderId:id});}catch(error){if(error.definitiveRejection)await this.commit({...this.state,pending:{...this.state.pending,definitiveRejection:error.binanceCode}});throw error;}await this.reconcile();
    if(this.state.position&&!this.state.protection){await this.protect();}
    else if(!this.state.position&&this.state.protection){await this.cancelProtection();}
  }
  async start(confirmation){
    if(confirmation!==FUTURES_CONFIRMATION)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');
    await this.check();
    if(this.state.pending)throw new Error('RECONCILE_PENDING_FUTURES_RESULT_FIRST');
    if(!this.last.actualConfigurationMatches)throw new Error('APPLY_SELECTED_CONTRACT_SETTINGS_FIRST');
    if(this.last.configuration.marginMode==='ISOLATED'&&this.last.configuration.autoAddMargin)throw new Error('ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED');
    if(this.state.day.blocked&&!this.state.position)throw new Error('DAILY_USDT_EQUITY_LOSS_20_PERCENT');
    for(const client of Object.values(this.clients))client.arm(confirmation);this.running=true;
    try{if(this.state.position&&!this.state.protection)await this.protect();if(!this.state.position&&this.state.protection)await this.cancelProtection();}
    catch(error){this.stop();throw error;}return this.last;
  }
  async applyContractSettings(confirmation){
    if(confirmation!==SETTINGS_CONFIRMATION)throw new Error('EXPLICIT_MARGIN_AND_LEVERAGE_CONFIRMATION_REQUIRED');
    if(this.busy||this.running||this.state?.pending||this.state?.position)throw new Error('FLAT_STOPPED_ACCOUNT_REQUIRED_FOR_SETTINGS');this.busy=true;
    try{
      const env=await this.environment();if(this.state&&this.state.uid!==env.uid)throw new Error('FUTURES_ACCOUNT_DIFFERS_FROM_SAVED_LEDGER');this.assertOwnedEnvironment(env);
      const raw=await this.client.request('brackets',{symbol:this.settings.symbol}),tiers=leverageTiers(raw,this.settings.market,this.settings.symbol);
      if(this.settings.leverage>Math.max(...tiers.map(row=>row.leverage)))throw new Error('SELECTED_LEVERAGE_EXCEEDS_ACCOUNT_BRACKET');
      this.client.armSettings(confirmation);
      try{await this.client.request('setMargin',{symbol:this.settings.symbol,marginType:this.settings.marginMode});}catch(error){if(error.binanceCode!==-4046)throw error;}
      await this.client.request('setLeverage',{symbol:this.settings.symbol,leverage:this.settings.leverage});
      const rules=contractRules(await this.client.request('catalog'),this.settings.market,this.settings.symbol),current=await this.configuration(await this.environment(),rules);
      if(current.marginMode!==this.settings.marginMode||current.leverage!==this.settings.leverage)throw new Error('CONTRACT_SETTINGS_NOT_VERIFIED');
    }finally{this.stop();this.busy=false;}
    return this.check();
  }
  async catalog(){const raw=await this.client.request('catalog');return (raw.symbols??[]).flatMap(row=>{try{return [contractRules(raw,this.settings.market,row.symbol)];}catch{return[];}});}
  async closeOwnedPosition(confirmation){
    if(confirmation!==FUTURES_CONFIRMATION)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');this.stop();await this.check();
    const owned=this.state.position;if(!owned||this.state.pending)throw new Error('RECONCILED_OWNED_POSITION_REQUIRED');
    const rules=contractRules(await this.client.request('catalog'),owned.market,owned.symbol);
    const plan={intent:'CLOSE_'+owned.direction,direction:owned.direction,market:owned.market,rules,risk:owned.risk,allocation:null,args:{symbol:owned.symbol,side:owned.direction==='LONG'?'SELL':'BUY',positionSide:owned.positionSide,type:'MARKET',quantity:owned.quantity,newOrderRespType:'ACK',...(owned.positionSide==='BOTH'?{reduceOnly:'true'}:{})}};
    this.last.plan=plan;for(const c of Object.values(this.clients))c.arm(confirmation);this.running=true;
    try{await this.execute(plan);}finally{this.stop();}
    return this.check();
  }
}
