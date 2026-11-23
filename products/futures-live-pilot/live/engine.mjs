import {mkdir,readFile,lstat,open,unlink,copyFile,constants} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {atomicWriteJson} from '../../../lib/atomic-json.mjs';
import {FUTURES_CONFIRMATION,SETTINGS_CONFIRMATION,MODE_CONFIRMATION,MARGIN_CONFIRMATION,HEDGE_CONFIRMATION} from './client.mjs';
import {units,signedUnits,decimal,multiply,multiplyUp,divide,floorStep,ceilStep,SCALE,absolute,openingQuantity,stopPrice,totalEquityUsdt,pnl,dailyLock} from './math.mjs';
import {contractSymbol,contractRules,leverageTiers,checkLeverage,checkIsolatedStop,futuresFees,signedPosition} from './market.mjs';
import {accountIdentity,walletSnapshot,newLedger,validateLedger,nativeWalletsAt,aggregateAssets,verifyWallets,addFunding,incomeCursor,makeExternalSnapshot,externalMidnightPnl,applyFinalOrder,ownedPositions,ownedProtections} from './ledger.mjs';
import {parseFuturesStrategy,futuresSignal} from './strategy.mjs';
import {parseMarginPolicy,registerMarginPolicy,autoMarginDecision,AUTO_MARGIN_CONFIRMATION,marginPolicyDigest} from './margin-policy.mjs';
import {acquireProfileLease} from '../../../lib/profile-lease.mjs';
export const FUTURES_VERSION='0.3.0-personal';
export function validateSettings(value){
  const keys=['market','symbol','assetMode','marginMode','leverage','marginPercent','directionMode','dailyLossPercent','externalStrategy','positionPolicy','externalMarginPolicy','externalPositionPolicy'];
  if(!value||Object.keys(value).some(k=>!keys.includes(k))||!['USD_M','COIN_M'].includes(value.market)||!['CROSSED','ISOLATED'].includes(value.marginMode)||!Number.isSafeInteger(value.leverage)||value.leverage<1||value.leverage>1000||!['both','long','short'].includes(value.directionMode)||value.dailyLossPercent!==20)throw new Error('EXPLICIT_FUTURES_MARGIN_LEVERAGE_AND_RISK_REQUIRED');
  const percent=value.marginPercent;
  if(typeof percent!=='number'||!Number.isFinite(percent)||percent<0.01||percent>100||!/^\d+(?:\.\d{1,12})?$/.test(String(percent)))throw new Error('INVALID_FUTURES_MARGIN_PERCENT');
  contractSymbol(value.symbol);
  if(value.positionPolicy!==undefined&&!['single','hedge'].includes(value.positionPolicy))throw new Error('EXPLICIT_POSITION_POLICY_REQUIRED');
  const externalPositionPolicy=value.externalPositionPolicy===undefined?'block':value.externalPositionPolicy;
  if(!['block','otherContracts'].includes(externalPositionPolicy))throw new Error('INVALID_EXTERNAL_POSITION_POLICY');
  const assetMode=value.assetMode===undefined?'single':value.assetMode;
  if(!['single','multi'].includes(assetMode))throw new Error('INVALID_USD_M_ASSET_MODE');
  if(value.market==='USD_M'&&assetMode==='multi'&&value.marginMode!=='CROSSED')throw new Error('MULTI_ASSETS_REQUIRES_CROSS');
  return {...value,assetMode,externalPositionPolicy,positionPolicy:value.positionPolicy??'single',externalStrategy:value.externalStrategy?parseFuturesStrategy(JSON.stringify(value.externalStrategy)):null,externalMarginPolicy:value.externalMarginPolicy?parseMarginPolicy(JSON.stringify(value.externalMarginPolicy)):null};
}
const terminal=new Set(['FILLED','CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH']);
const algoTerminal=new Set(['FINISHED','CANCELED','CANCELLED','REJECTED','EXPIRED','TRIGGERED']);
const mode=value=>value==='cross'||value==='CROSS'||value==='CROSSED'?'CROSSED':value==='isolated'||value==='ISOLATED'?'ISOLATED':null;
const flag=value=>value===true||value==='true'?true:value===false||value==='false'?false:null;
const notFound=error=>[-2011,-2013].includes(error.binanceCode);
const entryId=()=> 'asbf_'+randomBytes(14).toString('hex');
const algoId=()=> 'asbp_'+randomBytes(14).toString('hex');
const dateAt=time=>new Date(time+8*3600000).toISOString().slice(0,10);
const dayStart=time=>Date.parse(dateAt(time)+'T00:00:00.000+08:00');
const validExchangeSymbol=s=>typeof s==='string'&&/^[\p{L}\p{N}_-]{2,64}$/u.test(s);
function marginWalletsOf(env){
  const wallets={};
  for(const [market,account] of Object.entries(env.accounts))for(const a of account.assets){
    if(typeof a.unrealizedProfit!=='string')throw new Error('COMPLETE_UNREALIZED_PNL_REQUIRED');
    wallets[market+'.'+a.asset]=decimal(signedUnits(a.walletBalance)+signedUnits(a.unrealizedProfit));
  }
  return wallets;
}

function matchesOwnedPosition(row,position,verifyEntry){
  const signed=signedPosition(row);
  if(!position||position.symbol!==row.symbol||position.positionSide!==row.positionSide||
    signed.direction!==position.direction||units(signed.quantity)!==units(position.quantity))return false;
  // Binance rounds the displayed entry price. Compare at its eight-decimal reporting precision.
  return !verifyEntry||(typeof row.entryPrice==='string'&&units(row.entryPrice)>0n&&absolute(units(row.entryPrice)-units(position.entryPrice))<=SCALE/100000000n);
}

export class FuturesEngine{
  stopGeneration=0;
  constructor({profile,clients,settings,now=Date.now,guard=()=>true,signalFactory=futuresSignal}){
    this.profile=resolve(profile);this.file=resolve(this.profile,'futures-ledger.json');this.clients=clients;this.settings=validateSettings(settings);this.now=now;this.guard=guard;this.signalFactory=signalFactory;this.running=false;this.autoMarginArmed=false;this.busy=false;this.state=null;this.last=null;this.error=null;this.cache=new Map();
    if(!clients?.USD_M||!clients?.COIN_M)throw new Error('BOTH_FUTURES_CLIENTS_REQUIRED');
  }
  get client(){return this.clients[this.settings.market];}
  get allowExternal(){return this.settings.externalPositionPolicy==='otherContracts';}
  time(){try{return this.client.serverNow?.()??this.now();}catch{return this.now();}}
  async acquire(){
    await mkdir(this.profile,{recursive:true,mode:0o700});if((await lstat(this.profile)).isSymbolicLink())throw new Error('REGULAR_FUTURES_PROFILE_REQUIRED');
    const marker=resolve(this.profile,'futures.lock'),identity=process.platform==='win32'?this.profile.toLowerCase():this.profile;
    try{
      this.socket=await acquireProfileLease(identity);
      try{const pid=(await readFile(marker,'utf8')).trim();if(!/^[1-9]\d{0,9}$/.test(pid))throw new Error('INVALID_FUTURES_LOCK');try{process.kill(Number(pid),0);throw new Error('FUTURES_PROFILE_OWNER_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}await unlink(marker);}catch(e){if(e.code!=='ENOENT')throw e;}
      this.lock=await open(marker,'wx',0o600);await this.lock.writeFile(String(process.pid));await this.lock.sync();this.lockPath=marker;
      try{const info=await lstat(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>67108864)throw new Error('INVALID_FUTURES_LEDGER_FILE');const saved=JSON.parse(await readFile(this.file,'utf8'));this.state=validateLedger(saved);if(saved.version===1){const backups=resolve(this.profile,'backups');await mkdir(backups,{recursive:true,mode:0o700});if((await lstat(backups)).isSymbolicLink())throw new Error('LINKED_FUTURES_BACKUP_REFUSED');await copyFile(this.file,resolve(backups,'futures-ledger-v1-'+this.now()+'-'+randomBytes(4).toString('hex')+'.json'),constants.COPYFILE_EXCL);}}catch(e){if(e.code!=='ENOENT')throw e;}
    }catch(error){await this.close();throw error;}
    return this;
  }
  async commit(state){validateLedger(state);await atomicWriteJson(this.file,state);this.state=state;}
  stop(){this.stopGeneration++;this.running=false;this.autoMarginArmed=false;for(const client of Object.values(this.clients))client.disarm();this.syncLastState();}
  stopAutoMargin(){this.autoMarginArmed=false;for(const client of Object.values(this.clients))client.disarmMargin?.();}
  async close(){this.stop();if(this.lock){await this.lock.close();this.lock=null;await unlink(this.lockPath).catch(()=>{});}if(this.socket){await new Promise(ok=>this.socket.close(ok));this.socket=null;}}
  async cached(key,ttl,read){const old=this.cache.get(key);if(old&&this.now()>=old.time&&this.now()-old.time<ttl)return old.value;const value=await read();this.cache.set(key,{time:this.now(),value});return value;}
  async verifyProtectionQuery(){
    return this.cached('algo-query:'+this.settings.market,60000,async()=>{
      try{await this.client.request('algo',{clientAlgoId:algoId()});}
      catch(error){if(error.binanceCode===-2013)return true;throw new Error('EXCHANGE_PROTECTION_QUERY_UNAVAILABLE');}
      throw new Error('EXCHANGE_PROTECTION_QUERY_NOT_VERIFIED');
    });
  }
  async environment({showWallet=false,readCapacity=true}={}){
    const accounts={},balances={},positions={},orders={},algos={};
    this.accountModes=null;this.marginCapacity=null;this.externalExposure=null;
    const selected=this.settings.market;
    if(showWallet){
      await this.client.syncTime();
      balances[selected]=await this.client.request('balances');
      const rows=balances[selected];
      if(!Array.isArray(rows))throw new Error('COMPLETE_FUTURES_ACCOUNT_SNAPSHOT_REQUIRED');
      // This signed balance is useful even if a later strategy-readiness check fails.
      const amounts=rows.filter(row=>/^[A-Z0-9]{1,24}$/.test(row?.asset)&&typeof row.balance==='string'&&/^-?\d+(\.\d+)?$/.test(row.balance)&&(Number(row.balance)!==0||row.asset==='USDT'));
      this.walletRead={market:selected,time:this.now(),amounts:amounts.map(({asset,balance})=>({asset,balance}))};
    }
    await Promise.all(Object.entries(this.clients).filter(([market])=>!showWallet||market!==selected).map(([,c])=>c.syncTime()));
    await Promise.all(['USD_M','COIN_M'].map(async market=>{
      const c=this.clients[market];[accounts[market],balances[market],positions[market],orders[market],algos[market]]=await Promise.all([c.request('account'),balances[market]??c.request('balances'),c.request('positions'),c.request('openOrders'),c.request('openAlgos')]);
      if(![balances[market],positions[market],orders[market],algos[market]].every(Array.isArray))throw new Error('COMPLETE_FUTURES_ACCOUNT_SNAPSHOT_REQUIRED');
    }));
    const usd=this.clients.USD_M;
    const config=await usd.request('accountConfig');
    const modes={multiAssets:flag(config?.multiAssetsMargin),hedge:flag(config?.dualSidePosition)};
    this.accountModes=modes;
    if(modes.multiAssets===null)modes.multiAssets=flag((await usd.request('multiAssets'))?.multiAssetsMargin);
    if(modes.multiAssets===null)throw new Error('USD_M_ASSET_MODE_UNVERIFIED');
    if(modes.hedge===null)modes.hedge=flag((await usd.request('positionMode'))?.dualSidePosition);
    if(modes.hedge===null)throw new Error('USD_M_POSITION_MODE_UNVERIFIED');
    if(selected==='USD_M'&&readCapacity){
      this.marginCapacity=await this.readMarginCapacity(modes,accounts.USD_M,balances.USD_M);
    }
    // USD-M Account Information V3 supplies wallet amounts; Account Configuration supplies permissions.
    if(config?.canTrade!==true||!accounts.USD_M||('canTrade' in accounts.USD_M&&accounts.USD_M.canTrade!==true))throw new Error('TRADABLE_FUTURES_ACCOUNTS_REQUIRED');
    accounts.USD_M={...accounts.USD_M,canTrade:config.canTrade};
    return {accounts,balances,positions,orders,algos,hedge:modes.hedge,capacity:this.marginCapacity,uid:accountIdentity(balances),wallets:walletSnapshot(accounts),observedAt:this.time()};
  }
  async readMarginCapacity(modes,account,balances){
    const asset=this.settings.symbol.endsWith('USDC')?'USDC':'USDT';
    const usd=this.clients.USD_M;
    const eligible=balances.filter(r=>flag(r.marginAvailable)===true&&signedUnits(r.balance)>0n).map(r=>r.asset);
    const readAmount=value=>{
      if(typeof value!=='string'||!/^[-]?\d{1,18}(\.\d{1,12})?$/.test(value))throw new Error('MARGIN_CAPACITY_UNVERIFIED');
      const amount=signedUnits(value);
      return amount>0n?amount:0n;
    };
    const mode=modes.multiAssets?'multi':'single';
    if(mode==='single'){
      const row=balances.find(r=>r.asset===asset);
      const available=readAmount(row?.availableBalance);
      const fx=asset==='USDT'?'1':(await this.prices({['USD_M.'+asset]:'1'}))[asset];
      return {mode,asset,availableNative:decimal(available),availableUsdt:decimal(multiply(available,units(fx))),assetUsdt:fx,eligible,time:this.now()};
    }
    const availableUsd=readAmount(account?.availableBalance),equityUsd=readAmount(account?.totalMarginBalance);
    const index=async coin=>{
      const symbol=coin+'USD',row=await usd.request('marginIndex',{symbol});
      const age=this.time()-row?.time;
      if(row?.symbol!==symbol||!Number.isSafeInteger(row.time)||age < -5000||age>60000||!readAmount(row.index))throw new Error('MARGIN_CONVERSION_INDEX_UNVERIFIED');
      return units(row.index);
    };
    const usdtUsd=await index('USDT'),assetUsd=asset==='USDT'?usdtUsd:await index(asset);
    // Binance already nets position and order margin in its USD account-wide availableBalance.
    return {mode,asset,availableUsd:decimal(availableUsd),availableNative:decimal(divide(availableUsd,assetUsd)),availableUsdt:decimal(divide(availableUsd,usdtUsd)),poolEquityUsdt:decimal(divide(equityUsd,usdtUsd)),assetUsdt:decimal((assetUsd*SCALE+usdtUsd-1n)/usdtUsd),eligible,time:this.now()};
  }
  assertOwnedEnvironment(env,{markets=['USD_M','COIN_M'],requireAccountFlat=false}={}){
    const positions=ownedPositions(this.state),protections=ownedProtections(this.state);
    const summary={positions:[],openOrderCount:0,conditionalOrderCount:0},external=[];
    for(const market of markets){
      const reserved=symbol=>(market===this.settings.market&&symbol===this.settings.symbol)||positions.some(p=>p.market===market&&p.symbol===symbol)||protections.some(p=>p.market===market&&p.symbol===symbol);
      const nonzero=env.positions[market].filter(row=>signedPosition(row).quantity!=='0');
      if(!this.allowExternal&&nonzero.length!==positions.filter(p=>p.market===market).length)throw new Error('UNMANAGED_OR_CHANGED_FUTURES_POSITION');
      const matched=new Set();
      for(const row of nonzero){
        const {direction,quantity}=signedPosition(row);
        if(this.allowExternal&&!validExchangeSymbol(row.symbol))throw new Error('UNIDENTIFIED_EXTERNAL_FUTURES_EXPOSURE');
        if(this.allowExternal&&!reserved(row.symbol)){
          external.push({...row,market});summary.positions.push({market,symbol:row.symbol,direction,quantity});continue;
        }
        const position=positions.find(p=>p.market===market&&p.symbol===row.symbol&&p.direction===direction);
        if(!position&&this.allowExternal)throw new Error('MANUAL_POSITION_ON_SELECTED_CONTRACT');
        if(matched.has(position)||!matchesOwnedPosition(row,position,this.allowExternal))throw new Error('FUTURES_POSITION_DIFFERS_FROM_OWNED_LEDGER');
        matched.add(position);
      }
      if(positions.some(p=>p.market===market&&!matched.has(p)))throw new Error('FUTURES_POSITION_DIFFERS_FROM_OWNED_LEDGER');
      for(const [conditional,rows] of [[false,env.orders[market]],[true,env.algos[market]]]){
        for(const row of rows){
          const id=conditional?row.clientAlgoId:row.clientOrderId;
          if(conditional&&protections.some(p=>p.market===market&&id===p.id&&(!this.allowExternal||row.symbol===p.symbol)))continue;
          if(!this.allowExternal)throw new Error(conditional?'UNMANAGED_FUTURES_PROTECTION_ORDER':'UNRESOLVED_OR_UNMANAGED_FUTURES_ORDERS');
          if(!validExchangeSymbol(row.symbol)||typeof id!=='string'||!id.trim())throw new Error('UNIDENTIFIED_EXTERNAL_FUTURES_EXPOSURE');
          if(/^asb[fpm]_/.test(id))throw new Error('EXTERNAL_BOT_ORDER_REQUIRES_REVIEW');
          if(reserved(row.symbol))throw new Error('UNMANAGED_ORDER_ON_SELECTED_CONTRACT');
          if(conditional)summary.conditionalOrderCount++;else summary.openOrderCount++;
        }
      }
    }
    if(!env.hedge&&positions.length>1)throw new Error('EXCHANGE_POSITION_MODE_DIFFERS_FROM_LEDGER');
    if(requireAccountFlat&&(external.length||summary.openOrderCount||summary.conditionalOrderCount))throw new Error('ACCOUNT_MODE_CHANGE_REQUIRES_NO_EXTERNAL_EXPOSURE');
    if(markets.length===2)this.externalExposure=summary;
    return external;
  }
  async configuration(env,rules){
    const rows=env.positions[this.settings.market],position=rows.find(row=>row.symbol===rules.symbol&&(row.positionSide==='BOTH'||row.positionSide==='LONG'));
    let value;
    if(this.settings.market==='USD_M'){
      const result=await this.client.request('symbolConfig',{symbol:rules.symbol});value=Array.isArray(result)?result.find(row=>row.symbol===rules.symbol):result;
    }else value=position??rows.find(row=>row.symbol===rules.symbol);
    if(!value||value.symbol!==rules.symbol||!mode(value.marginType)||!Number.isSafeInteger(Number(value.leverage)))throw new Error('CURRENT_CONTRACT_CONFIGURATION_UNAVAILABLE');
    const legs={};for(const direction of ['LONG','SHORT']){const row=rows.find(r=>r.symbol===rules.symbol&&r.positionSide===(env.hedge?direction:'BOTH'));legs[direction]={autoAddMargin:flag(row?.isAutoAddMargin)??flag(value.isAutoAddMargin),isolatedWallet:row?.isolatedWallet??row?.isolatedMargin??null,liquidationPrice:row?.liquidationPrice??null};}
    const flags=Object.values(legs).map(leg=>leg.autoAddMargin);
    return {marginMode:mode(value.marginType),leverage:Number(value.leverage),autoAddMargin:flags.some(f=>f===true)?true:flags.every(f=>f===false)?false:null,legs};
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
  async syncFunding(now,force=false){
    const scope=this.allowExternal||this.state.externalIncomeThrough?this.settings:undefined;
    for(const market of ['USD_M','COIN_M']){
      let through=incomeCursor(this.state,market,scope);if(!force&&now-through<15000)continue;
      while(through<now||(force&&through===now)){
        const end=Math.min(now,through+6*86400000);
        const start=scope?Math.max(this.state.createdAt,through-60000):through+1;
        const rows=await this.incomeRange(market,start,end);
        await this.commit(addFunding(this.state,market,rows,end,scope));through=end;
        if(end===now)break;
      }
    }
  }
  async reconcile(){
    const pending=this.state?.pending;if(!pending)return;
    const c=this.clients[pending.market],direction=pending.direction;await c.syncTime();
    if(pending.kind==='MARGIN_ADD')return this.reconcileMargin(pending);
    if(pending.kind==='ORDER'){
      let order;try{order=await c.request('order',pending.exchangeOrderId?{symbol:pending.args.symbol,orderId:pending.exchangeOrderId}:{symbol:pending.args.symbol,origClientOrderId:pending.id});}
      catch(error){if(notFound(error)&&pending.definitiveRejection){await this.commit({...this.state,pending:null,orders:[...this.state.orders,{id:pending.id,orderId:null,market:pending.market,symbol:pending.args.symbol,intent:pending.intent,side:pending.args.side,positionSide:pending.args.positionSide,quantity:'0',status:'REJECTED',time:pending.createdAt,rejectionCode:pending.definitiveRejection}]});return;}if(notFound(error))throw new Error('FUTURES_ORDER_RESULT_UNRESOLVED_DO_NOT_RESUBMIT');throw error;}
      if(!terminal.has(order.status))throw new Error('FUTURES_ORDER_NOT_TERMINAL');
      const fills=units(order.executedQty)?await c.request('trades',{symbol:pending.args.symbol,orderId:order.orderId,limit:1000}):[];
      await this.commit(applyFinalOrder(this.state,order,fills));return;
    }
    let algo;try{algo=await c.request('algo',{clientAlgoId:pending.id});}catch(error){if(notFound(error)&&pending.kind==='PROTECTION'&&pending.definitiveRejection){await this.commit({...this.state,pending:null,protectionRejected:pending.definitiveRejection});return;}if(notFound(error))throw new Error('FUTURES_PROTECTION_RESULT_UNRESOLVED');throw error;}
    if(pending.kind==='CANCEL_PROTECTION'){
      if(['TRIGGERED','FINISHED'].includes(algo.algoStatus)){await this.commit({...this.state,pending:null});await this.syncProtection(direction);return;}
      if(!['CANCELED','CANCELLED','REJECTED','EXPIRED'].includes(algo.algoStatus))throw new Error('FUTURES_PROTECTION_CANCEL_NOT_CONFIRMED');
      await this.commit({...this.state,protections:{...this.state.protections,[direction]:null},pending:null});return;
    }
    const args=pending.args;
    if(algo.clientAlgoId!==pending.id||algo.symbol!==args.symbol||algo.side!==args.side||algo.positionSide!==args.positionSide||(algo.orderType??algo.type)!=='STOP_MARKET'||algo.workingType!=='MARK_PRICE'||units(String(algo.quantity))!==units(args.quantity)||units(String(algo.triggerPrice))!==units(args.triggerPrice)||(args.positionSide==='BOTH'&&algo.reduceOnly!==true))throw new Error('EXCHANGE_PROTECTION_DETAILS_MISMATCH');
    if(!['NEW','TRIGGERED','FINISHED'].includes(algo.algoStatus))throw new Error('EXCHANGE_PROTECTION_NOT_ACTIVE');
    await this.commit({...this.state,pending:null,protections:{...this.state.protections,[direction]:{...args,id:pending.id,market:pending.market,algoId:algo.algoId,status:algo.algoStatus}}});await this.syncProtection(direction);
  }
  async syncProtection(direction){
    const p=this.state?.protections[direction];if(!p)return;const c=this.clients[p.market],algo=await c.request('algo',{clientAlgoId:p.id});
    if(algo.clientAlgoId!==p.id||algo.symbol!==p.symbol||algo.positionSide!==p.positionSide)throw new Error('OWNED_PROTECTION_REFERENCE_MISMATCH');
    if(['TRIGGERED','FINISHED'].includes(algo.algoStatus)){
      const actual=Number(algo.actualOrderId);if(!Number.isSafeInteger(actual)||actual<=0)throw new Error('TRIGGERED_PROTECTION_ORDER_NOT_AVAILABLE_YET');
      if(this.state.orders.some(row=>row.market===p.market&&row.orderId===actual))throw new Error('FINISHED_PROTECTION_REQUIRES_MANUAL_REVIEW');
      const order=await c.request('order',{symbol:p.symbol,orderId:actual});if(!terminal.has(order.status))throw new Error('PROTECTION_EXIT_NOT_TERMINAL');
      const position=this.state.positions[direction];
      if(!position){if(units(order.executedQty))throw new Error('PROTECTION_TRIGGER_REQUIRES_POSITION_REVIEW');await this.commit({...this.state,protections:{...this.state.protections,[direction]:null}});return;}
      const fills=units(order.executedQty)?await c.request('trades',{symbol:p.symbol,orderId:actual,limit:1000}):[];
      const pending={kind:'ORDER',id:entryId(),createdAt:this.time(),market:p.market,intent:'PROTECTION_CLOSE',direction,protectionId:p.id,exchangeOrderId:actual,rules:{marginAsset:position.marginAsset,contractSize:position.contractSize},args:{symbol:p.symbol,side:p.side,positionSide:p.positionSide,type:order.type,quantity:order.origQty}};
      await this.commit({...this.state,pending});await this.commit(applyFinalOrder(this.state,order,fills));await this.commit({...this.state,protections:{...this.state.protections,[direction]:null}});
      if(this.state.positions[direction])throw new Error('PROTECTION_PARTIALLY_CLOSED_REVIEW_REQUIRED');return;
    }
    if(algo.algoStatus!=='NEW'&&this.state.positions[direction])throw new Error('OWNED_POSITION_WITHOUT_ACTIVE_EXCHANGE_STOP');
  }
  async protect(direction){
    const position=this.state?.positions[direction];if(!position||this.state.pending||this.state.protections[direction])throw new Error('KNOWN_UNPROTECTED_POSITION_REQUIRED');
    const c=this.clients[position.market],catalog=await this.cached('catalog:'+position.market,600000,()=>c.request('catalog'));
    const rules=contractRules(catalog,position.market,position.symbol),mark=await c.request('mark',{symbol:position.symbol}),row=Array.isArray(mark)?mark.find(r=>r.symbol===position.symbol):mark;
    const trigger=stopPrice({side:direction,entryPrice:position.entryPrice,stopLossPercent:position.risk.stopLossPercent,tickSize:rules.tickSize});
    if(!row||!units(row.markPrice)||(direction==='LONG'?units(trigger)>=units(row.markPrice):units(trigger)<=units(row.markPrice)))throw new Error('PROTECTIVE_STOP_ALREADY_CROSSED_CLOSE_REVIEW_REQUIRED');
    const actualPositions=await c.request('positions'),actual=actualPositions.find(r=>r.symbol===position.symbol&&r.positionSide===position.positionSide);
    if(!actual||!matchesOwnedPosition(actual,position,this.allowExternal))throw new Error('VERIFY_OWN_POSITION_BEFORE_PROTECTION');
    const liquidation=units(actual.liquidationPrice);if(liquidation>0n&&(direction==='LONG'?units(trigger)<=liquidation+units(rules.tickSize):units(trigger)+units(rules.tickSize)>=liquidation))throw new Error('PROTECTIVE_STOP_BEYOND_EXCHANGE_LIQUIDATION_PRICE');
    const args={algoType:'CONDITIONAL',symbol:position.symbol,side:direction==='LONG'?'SELL':'BUY',positionSide:position.positionSide,type:'STOP_MARKET',quantity:position.quantity,triggerPrice:trigger,workingType:'MARK_PRICE',priceProtect:'FALSE',...(position.positionSide==='BOTH'?{reduceOnly:'true'}:{})};
    const id=algoId();await this.commit({...this.state,pending:{kind:'PROTECTION',market:position.market,direction,id,args,createdAt:this.time()}});
    if(!this.running||!this.guard()){await this.commit({...this.state,pending:null});throw new Error('START_REQUIRED_TO_REPAIR_EXCHANGE_PROTECTION');}
    try{await c.request('newProtection',{...args,clientAlgoId:id});}catch(error){if(error.definitiveRejection)await this.commit({...this.state,pending:{...this.state.pending,definitiveRejection:error.binanceCode}});throw error;}await this.reconcile();
  }
  async cancelProtection(direction,{replace=false}={}){
    const p=this.state?.protections[direction];if(!p)return;if(this.state.positions[direction]&&!replace)throw new Error('FLAT_POSITION_REQUIRED_BEFORE_PROTECTION_REMOVAL');
    await this.commit({...this.state,pending:{kind:'CANCEL_PROTECTION',market:p.market,direction,id:p.id,createdAt:this.time()}});
    // A completed owned close may remove its now-unneeded stop after expiry.
    // Replacing a stop on a remaining position still needs normal permission.
    const authorizationPlan=this.state.positions[direction]?undefined:{intent:'CLOSE_'+direction};
    if(!this.running||!this.guard(authorizationPlan)){await this.commit({...this.state,pending:null});throw new Error('START_REQUIRED_TO_REPAIR_EXCHANGE_PROTECTION');}
    await this.clients[p.market].request('cancelProtection',{clientAlgoId:p.id});await this.reconcile();
  }
  async ensureProtections(){
    for(const direction of ['LONG','SHORT']){
      let position=this.state.positions[direction],protection=this.state.protections[direction];
      if(protection&&(!position||units(protection.quantity)!==units(position.quantity))){await this.cancelProtection(direction,{replace:!!position});position=this.state.positions[direction];protection=this.state.protections[direction];}
      if(position&&!protection)await this.protect(direction);
    }
  }
  async externalTrades(market,symbol,start,end){
    const rows=await this.clients[market].request('trades',{symbol,startTime:start,endTime:end,limit:1000});
    if(!Array.isArray(rows))throw new Error('EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED');
    if(rows.length<1000)return rows;
    if(start>=end)throw new Error('EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED');
    const middle=Math.floor((start+end)/2);
    return [...await this.externalTrades(market,symbol,start,middle),...await this.externalTrades(market,symbol,middle+1,end)];
  }
  async baseline(now,currentEquity,externalSnapshot){
    const date=dateAt(now);if(this.state.day?.date===date)return this.state.day;
    if(dayStart(now)<this.state.createdAt)return {date,baselineUsdt:this.state.firstEquityUsdt??currentEquity,blocked:false,firstDay:true};
    const boundary=dayStart(now),wallets=nativeWalletsAt(this.state,boundary),positions={LONG:null,SHORT:null};
    if(externalSnapshot){
      const externalPnl=await externalMidnightPnl(this.state,externalSnapshot,boundary,{
        trades:(...args)=>this.externalTrades(...args),
        contract:async(market,symbol)=>{
          const client=this.clients[market],catalog=await this.cached('catalog:'+market,600000,()=>client.request('catalog'));
          const row=catalog?.symbols?.find(r=>r.symbol===symbol);
          const bars=await client.request('markCandles',{symbol,interval:'1m',limit:1,startTime:boundary,endTime:boundary+59999});
          if(!row||!/^[A-Z0-9]{1,24}$/.test(row.marginAsset)||!Array.isArray(bars)||bars[0]?.[0]!==boundary||!units(bars[0][1]))throw new Error('EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED');
          return {marginAsset:row.marginAsset,contractSize:market==='USD_M'?'1':String(row.contractSize),markPrice:bars[0][1]};
        }
      });
      for(const [key,amount] of Object.entries(externalPnl))wallets[key]=decimal(signedUnits(wallets[key]??'0')+signedUnits(amount));
    }
    const assets=aggregateAssets(wallets),prices=await this.prices(wallets,boundary);
    for(const f of [...this.state.fills].filter(f=>f.time<boundary).sort((a,b)=>a.time-b.time)){
      const old=positions[f.direction];
      if(f.effect==='OPEN'){
        const q=units(old?.quantity??'0')+units(f.quantity),value=old?(f.market==='USD_M'?multiply(units(old.quantity),units(old.entryPrice)):divide(multiply(units(old.quantity),units(f.contractSize)),units(old.entryPrice))):0n;
        const extra=f.market==='USD_M'?multiply(units(f.quantity),units(f.price)):divide(multiply(units(f.quantity),units(f.contractSize)),units(f.price));
        positions[f.direction]={...f,quantity:decimal(q),entryPrice:decimal(f.market==='USD_M'?divide(value+extra,q):divide(multiply(q,units(f.contractSize)),value+extra))};
      }else{if(!old||old.market!==f.market||old.symbol!==f.symbol)throw new Error('INVALID_HISTORICAL_POSITION');const q=units(old.quantity)-units(f.quantity);if(q<0n)throw new Error('INVALID_HISTORICAL_POSITION');positions[f.direction]=q?{...old,quantity:decimal(q)}:null;}
    }
    const marks=new Map();for(const position of Object.values(positions).filter(Boolean)){
      const key=position.market+':'+position.symbol;let mark=marks.get(key);
      if(!mark){const rows=await this.clients[position.market].request('markCandles',{symbol:position.symbol,interval:'1m',limit:1,startTime:boundary,endTime:boundary+59999});if(!Array.isArray(rows)||rows[0]?.[0]!==boundary)throw new Error('MIDNIGHT_MARK_PRICE_REQUIRED');mark=rows[0][1];marks.set(key,mark);}
      const profit=pnl({market:position.market,side:position.direction,quantity:position.quantity,entryPrice:position.entryPrice,exitPrice:mark,contractSize:position.contractSize});assets[position.marginAsset]=decimal(signedUnits(assets[position.marginAsset]??'0')+signedUnits(profit));
    }
    const value=totalEquityUsdt(assets,prices);if(signedUnits(value)<=0n)throw new Error('POSITIVE_MIDNIGHT_EQUITY_REQUIRED');return {date,baselineUsdt:value,blocked:false,firstDay:false};
  }
  async buildPlan({env,rules,book,fees,tiers,equity,fx,configuration,signal,direction,overrideQuantity=null,allowLockIncrease=false}){
    const market=this.settings.market,symbol=this.settings.symbol,closing=signal.intent.startsWith('CLOSE_'),buy=direction==='LONG'?!closing:closing;
    const price=buy?ceilStep(multiplyUp(units(book.askPrice),units('1.0005')),units(rules.tickSize)):floorStep(multiply(units(book.bidPrice),units('0.9995')),units(rules.tickSize));
    if(!price||price<units(rules.minPrice)||(units(rules.maxPrice)>0n&&price>units(rules.maxPrice)))throw new Error('CONTRACT_PRICE_FILTER_BLOCKED');
    const positionSide=env.hedge?direction:'BOTH';let quantity,allocation=null;
    if(closing){const owned=this.state.positions[direction];if(!owned)throw new Error('OWNED_POSITION_REQUIRED');quantity=owned.quantity;if(floorStep(units(quantity),units(rules.stepSize))!==units(quantity))throw new Error('OWNED_QUANTITY_NO_LONGER_MATCHES_LOT_STEP');}
    else{
      const capacity=env.capacity;
      if(market==='USD_M'&&(!capacity||capacity.mode!==this.settings.assetMode||capacity.asset!==rules.marginAsset))throw new Error('ASSET_MODE_PREFERENCE_MISMATCH');
      if(capacity?.mode==='multi'&&configuration.marginMode!=='CROSSED')throw new Error('MULTI_ASSETS_REQUIRES_CROSS');
      const available=capacity?.availableNative??env.balances[market].find(row=>row.asset===rules.marginAsset)?.availableBalance;
      if(typeof available!=='string')throw new Error('SELECTED_COLLATERAL_BALANCE_REQUIRED');
      await this.verifyProtectionQuery();
      const sizeEquity=capacity?.mode==='multi'&&units(capacity.poolEquityUsdt)<signedUnits(equity)?capacity.poolEquityUsdt:equity;
      const options={market,totalEquity:sizeEquity,marginPercent:this.settings.marginPercent,collateralUsdt:capacity?.assetUsdt??fx[rules.marginAsset]??(rules.marginAsset==='USDT'?'1':undefined),availableCollateral:available,capToAvailable:market==='USD_M'&&!overrideQuantity,leverage:this.settings.leverage,price:decimal(price),contractSize:rules.contractSize,stepSize:rules.stepSize,minimumQuantity:rules.minimumQuantity,maximumQuantity:rules.maximumQuantity,minimumNotional:rules.minimumNotional,feeRate:fees.reserve};
      if(overrideQuantity)options.availableCollateral='999999999999999999';
      allocation=openingQuantity(options);quantity=overrideQuantity??allocation.quantity;
      if(overrideQuantity){
        const q=units(quantity),existing=units(this.state.positions[direction]?.quantity??'0');
        if(!q||floorStep(q,units(rules.stepSize))!==q||q<units(rules.minimumQuantity)||q>units(rules.maximumQuantity)||q+existing>units(allocation.quantity))throw new Error('EQUAL_HEDGE_EXCEEDS_SELECTED_MARGIN_BUDGET_OR_FILTER');
        const notional=market==='USD_M'?multiply(q,price):multiply(q,units(rules.contractSize)),native=market==='USD_M'?notional:(notional*SCALE+price-1n)/price,margin=(native+BigInt(this.settings.leverage)-1n)/BigInt(this.settings.leverage),fee=multiplyUp(native,units(fees.reserve))*2n;
        if(notional<units(rules.minimumNotional)||margin+fee>units(available))throw new Error('AVAILABLE_COLLATERAL_INSUFFICIENT_WITH_FEES');
        allocation={quantity,targetMarginUsdt:allocation.targetMarginUsdt,initialMargin:decimal(margin),initialMarginUsdt:decimal(multiplyUp(margin,units(options.collateralUsdt))),notional:decimal(notional),notionalUsdt:decimal(multiply(native,units(options.collateralUsdt))),reservedRoundTripFees:decimal(fee)};
      }
      const gross=units(quantity)+ownedPositions(this.state).reduce((sum,p)=>sum+units(p.quantity),0n);checkLeverage({market,quantity:decimal(gross),price:decimal(price),contractSize:rules.contractSize,leverage:this.settings.leverage,tiers});
      if(configuration.marginMode==='ISOLATED')checkIsolatedStop({market,quantity:decimal(gross),price:decimal(price),contractSize:rules.contractSize,leverage:this.settings.leverage,stopLossPercent:signal.risk.stopLossPercent,feeRate:fees.reserve,tiers});
    }
    return {intent:signal.intent,direction,market,rules,risk:signal.risk,allocation,allowLockIncrease,args:{symbol,side:buy?'BUY':'SELL',positionSide,type:'LIMIT',timeInForce:'IOC',quantity,price:decimal(price),newOrderRespType:'ACK',...(positionSide==='BOTH'?{reduceOnly:closing?'true':'false'}:{})}};
  }
  async check({execute=false,closingOnly=false}={}){
    if(this.busy)throw new Error('FUTURES_ACTION_IN_PROGRESS');this.busy=true;
    try{
      let env=await this.environment({showWallet:!execute,readCapacity:!closingOnly});if(this.state&&this.state.uid!==env.uid)throw new Error('FUTURES_ACCOUNT_DIFFERS_FROM_SAVED_LEDGER');
      if(!this.state){this.assertOwnedEnvironment(env);const created=newLedger(env.uid,env.wallets,env.observedAt),wallets=marginWalletsOf(env),fx=await this.prices(wallets);created.firstEquityUsdt=totalEquityUsdt(aggregateAssets(wallets),fx);if(signedUnits(created.firstEquityUsdt)<=0n)throw new Error('POSITIVE_FUTURES_CAPITAL_REQUIRED');await this.commit(created);}
      const before=JSON.stringify({pending:this.state.pending,positions:this.state.positions,protections:this.state.protections});await this.reconcile();for(const direction of ['LONG','SHORT'])await this.syncProtection(direction);
      if(before!==JSON.stringify({pending:this.state.pending,positions:this.state.positions,protections:this.state.protections}))env=await this.environment({readCapacity:!closingOnly});
      const external=this.assertOwnedEnvironment(env);
      const trackExternal=this.allowExternal||!!this.state.externalSnapshot;
      const externalSnapshot=trackExternal?makeExternalSnapshot(external,env.observedAt):null;
      await this.syncFunding(env.observedAt,trackExternal&&this.state.day?.date!==dateAt(env.observedAt));
      try{verifyWallets(this.state,env.wallets);}catch(error){
        if(!trackExternal)throw error;
        await this.syncFunding(env.observedAt,true);verifyWallets(this.state,env.wallets);
      }
      const {market,symbol}=this.settings,c=this.client,catalog=await this.cached('catalog:'+market,600000,()=>c.request('catalog')),rules=contractRules(catalog,market,symbol),started=this.now();
      let [book,mark,rows,rawFees,rawTiers,configuration]=await Promise.all([c.request('book',{symbol}),c.request('mark',{symbol}),c.request('candles',{symbol,interval:'1m',limit:100}),this.cached('fees:'+market+':'+symbol,60000,()=>c.request('fees',{symbol})),this.cached('brackets:'+market+':'+symbol,60000,()=>c.request('brackets',{symbol})),this.configuration(env,rules)]);
      if(Array.isArray(book))book=book.find(row=>row.symbol===symbol);if(Array.isArray(mark))mark=mark.find(row=>row.symbol===symbol);
      if(this.now()<started||this.now()-started>5000||book?.symbol!==symbol||mark?.symbol!==symbol||!units(book.bidPrice)||units(book.askPrice)<units(book.bidPrice)||!units(mark.markPrice))throw new Error('INVALID_OR_STALE_FUTURES_MARKET');
      const now=this.time(),fees=futuresFees(rawFees,symbol),tiers=leverageTiers(rawTiers,market,symbol),marginWallets=marginWalletsOf(env);
      const fx=await this.prices(marginWallets),equity=totalEquityUsdt(aggregateAssets(marginWallets),fx);
      if(dateAt(env.observedAt)!==dateAt(now))throw new Error('RECHECK_AFTER_DAILY_BOUNDARY');
      let day;
      try{
        const basis=await this.baseline(now,equity,externalSnapshot);
        day=basis.reason==='EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED'?basis:{...basis,...dailyLock({previous:this.state.day,date:dateAt(now),baselineUsdt:basis.baselineUsdt,equityUsdt:equity})};
      }catch(error){
        if(!trackExternal||error.message!=='EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED')throw error;
        // Keep verified exits available and today's anchor for tomorrow. Never reset an unknown daily loss to zero.
        day={date:dateAt(now),baselineUsdt:null,blocked:true,reason:error.message};
      }
      await this.commit({...this.state,day,...(trackExternal?{externalSnapshot}:{})});
      const assetModeMatches=market!=='USD_M'||(this.accountModes.multiAssets?'multi':'single')===this.settings.assetMode;
      const actualConfigurationMatches=assetModeMatches&&configuration.marginMode===this.settings.marginMode&&configuration.leverage===this.settings.leverage;let common=null;
      if(!actualConfigurationMatches)common='CONTRACT_MARGIN_OR_LEVERAGE_SETTINGS_DIFFER';
      if(configuration.marginMode==='ISOLATED'&&configuration.autoAddMargin===true)common='ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED';
      if(!assetModeMatches){common='ASSET_MODE_PREFERENCE_MISMATCH';this.stop();}
      for(const direction of ['LONG','SHORT']){const p=this.state.positions[direction],stop=this.state.protections[direction];if(p&&!stop)common='OWNED_POSITION_NEEDS_EXCHANGE_PROTECTION';if(stop&&!p)common='FLAT_POSITION_HAS_STALE_PROTECTION';if(p&&stop&&units(p.quantity)!==units(stop.quantity))common='PARTIAL_CLOSE_PROTECTION_QUANTITY_REVIEW_REQUIRED';}
      const signals={},plans={},blockers={};
      // Preserve the single-position strategy's conflict decision when both entry rules match.
      const flatSingleSignal=this.settings.positionPolicy==='single'&&!ownedPositions(this.state).length?this.signalFactory({rows,now,book,position:null,external:this.settings.externalStrategy,directionMode:this.settings.directionMode,roundTripFeePercent:Number(fees.reserve)*200}):null;
      for(const direction of ['LONG','SHORT']){
        const position=this.state.positions[direction],signal=flatSingleSignal??this.signalFactory({rows,now,book,position,external:this.settings.externalStrategy,directionMode:direction==='LONG'?'long':'short',roundTripFeePercent:Number(fees.reserve)*200});signals[direction]=signal;let blocker=common;
        if(signal.intent&&!signal.intent.endsWith(direction)){signals[direction]={...signal,intent:null};continue;}
        const opening=signal.intent?.startsWith('OPEN_');
        if(opening){
          if(closingOnly)blocker='MARGIN_CAPACITY_UNVERIFIED';
          if(this.settings.directionMode!=='both'&&this.settings.directionMode!==(direction==='LONG'?'long':'short'))blocker='SELECTED_DIRECTION_DISABLED';
          if(day.blocked)blocker=day.reason??'DAILY_USDT_EQUITY_LOSS_20_PERCENT';
          if(this.settings.positionPolicy==='single'&&ownedPositions(this.state).length)blocker='SINGLE_POSITION_POLICY';
          if(this.settings.positionPolicy==='hedge'&&!env.hedge)blocker='ENABLE_EXCHANGE_HEDGE_MODE_FIRST';
          const lastClose=Math.max(0,...this.state.orders.filter(row=>row.intent==='CLOSE_'+direction||row.intent==='PROTECTION_CLOSE'&&row.positionSide===(env.hedge?direction:'BOTH')).map(row=>row.time));
          if(now-lastClose<60000)blocker='CLOSED_POSITION_REENTRY_COOLDOWN';if(this.state.orders.filter(row=>row.intent.startsWith('OPEN_')&&row.quantity!=='0'&&row.time>now-3600000).length>=6)blocker='HOURLY_FUTURES_ENTRY_LIMIT';
        }
        if(this.state.hedgeLock?.active)blocker='MANUAL_HEDGE_LOCK_STRATEGY_PAUSED';
        if(signal.intent&&!blocker)try{plans[direction]=await this.buildPlan({env,rules,book,fees,tiers,equity,fx,configuration,signal,direction});}catch(error){blocker=/^[A-Z0-9_]+$/.test(error.message)?error.message:'FUTURES_ORDER_PLAN_BLOCKED';}
        blockers[direction]=blocker;
        if(position&&signal.peakReturnPercent!==undefined)await this.commit({...this.state,positions:{...this.state.positions,[direction]:{...position,peakReturnPercent:signal.peakReturnPercent}}});
      }
      const plan=Object.values(plans).find(p=>p.intent.startsWith('CLOSE_'))??Object.values(plans)[0]??null,primary=plan?.direction??ownedPositions(this.state)[0]?.direction??Object.keys(signals).find(d=>signals[d].intent)??'LONG';
      this.last={version:FUTURES_VERSION,environment:'BINANCE_FUTURES_MAINNET',checkedAt:now,localCheckedAt:this.now(),accountChecked:true,equityUsdt:equity,firstEquityUsdt:this.state.firstEquityUsdt,day,lossPercent:(1-Number(equity)/Number(day.baselineUsdt))*100,market,symbol,marginAsset:rules.marginAsset,configuration,actualConfigurationMatches,hedge:env.hedge,positionPolicy:this.settings.positionPolicy,feeRates:fees,leverageTiers:tiers,markPrice:mark.markPrice,fundingRate:mark.lastFundingRate??null,nextFundingTime:mark.nextFundingTime??null,liquidationPrice:configuration.legs[primary]?.liquidationPrice??null,positions:this.state.positions,protections:this.state.protections,position:this.state.position,protection:this.state.protection,pending:this.state.pending,hedgeLock:this.state.hedgeLock,signals,plans,sideBlockers:blockers,signal:signals[primary],plan,blocker:common??blockers[primary],wallets:env.wallets,collateralPrices:fx,book:{bid:book.bidPrice,ask:book.askPrice},candles:signals[primary].candles,orders:this.state.orders.slice(-50),marginEvents:this.state.marginEvents.slice(-50),realOrderCount:this.state.orders.length,running:this.running};
      this.last.externalExposure=this.externalExposure;
      this.last.contractConstraints={minimumQuantity:rules.minimumQuantity,stepSize:rules.stepSize,minimumNotional:rules.minimumNotional,baseAsset:rules.baseAsset,quoteAsset:rules.quoteAsset,quantityUnit:market==='USD_M'?rules.baseAsset:'contracts'};
      if(day.baselineUsdt===null){this.last.lossPercent=null;this.last.blocker??=day.reason;}
      this.context={env,rules,book,fees,tiers,equity,fx,configuration};this.error=null;this.readFailure=null;
      const marginBalance=env.balances[market].find(row=>row.asset===rules.marginAsset),autoDecision=autoMarginDecision({policy:this.settings.externalMarginPolicy,state:this.state,snapshot:this.last,armed:this.autoMarginArmed,now,availableCollateral:marginBalance?.availableBalance??'0'});
      this.last.autoMargin={armed:this.autoMarginArmed,policy:this.settings.externalMarginPolicy,budget:this.settings.externalMarginPolicy?this.state.autoMarginBudgets[this.settings.externalMarginPolicy.id]??null:null,decision:autoDecision};
      if(execute&&this.guard()){
        if(this.running&&plan?.intent.startsWith('CLOSE_'))await this.execute(plan);
        else if(this.autoMarginArmed&&autoDecision.eligible)await this.submitMargin(autoDecision.direction,autoDecision.amount,{automaticPolicy:this.settings.externalMarginPolicy});
        else if(this.running&&plan)await this.execute(plan);
        this.syncLastState();
      }return this.last;
    }catch(error){this.error=/^[A-Z0-9_]+$/.test(error.message)?error.message:'FUTURES_CHECK_FAILED';this.readFailure=error.readFailure??null;this.stop();this.syncLastState();throw error;}finally{this.busy=false;}
  }
  syncLastState(){if(this.last&&this.state){Object.assign(this.last,{positions:this.state.positions,protections:this.state.protections,position:this.state.position,protection:this.state.protection,pending:this.state.pending,hedgeLock:this.state.hedgeLock,orders:this.state.orders.slice(-50),marginEvents:this.state.marginEvents.slice(-50),realOrderCount:this.state.orders.length,running:this.running});if(this.last.autoMargin){this.last.autoMargin.armed=this.autoMarginArmed;const id=this.settings.externalMarginPolicy?.id;this.last.autoMargin.budget=id?this.state.autoMarginBudgets[id]??null:null;}}}
  async recheckSelectedContract(allocation=null){
    if(!this.allowExternal)return;
    const {market,symbol}=this.settings,client=this.client;
    // COIN-M positionRisk accepts pair rather than symbol; keep its full signed snapshot.
    const [positions,orders,algos,account,balances]=await Promise.all([
      client.request('positions',market==='USD_M'?{symbol}:{}),client.request('openOrders',{symbol}),client.request('openAlgos',{symbol}),
      allocation&&market==='USD_M'?client.request('account'):null,allocation?client.request('balances'):null
    ]);
    if(![positions,orders,algos].every(Array.isArray))throw new Error('COMPLETE_FUTURES_ACCOUNT_SNAPSHOT_REQUIRED');
    this.assertOwnedEnvironment({positions:{[market]:positions},orders:{[market]:orders},algos:{[market]:algos},hedge:this.last.hedge},{markets:[market]});
    if(allocation){
      let available;
      if(market==='USD_M')available=(await this.readMarginCapacity(this.accountModes,account,balances)).availableNative;
      else available=balances.find(b=>b.asset===this.last.marginAsset)?.availableBalance;
      if(typeof available!=='string'||signedUnits(available)<units(allocation.initialMargin)+units(allocation.reservedRoundTripFees))throw new Error('AVAILABLE_COLLATERAL_INSUFFICIENT_WITH_FEES');
    }
  }
  async execute(plan){
    if(!this.running||!this.guard(plan)||this.state.pending||this.time()<this.last.checkedAt||this.time()-this.last.checkedAt>3000||JSON.stringify(plan)!==JSON.stringify(this.last.plan))throw new Error('REVIEWED_FRESH_FUTURES_PLAN_REQUIRED');
    if(this.state.hedgeLock?.active&&!plan.manualLock)throw new Error('MANUAL_HEDGE_LOCK_STRATEGY_PAUSED');
    if(plan.intent.startsWith('OPEN_')&&(this.state.day.blocked||this.state.protections[plan.direction]&&!plan.allowLockIncrease||this.state.positions[plan.direction]&&!plan.allowLockIncrease||this.settings.positionPolicy==='single'&&ownedPositions(this.state).length))throw new Error('FUTURES_OPENING_BLOCKED');
    await this.recheckSelectedContract(plan.allocation);
    const id=entryId(),pending={kind:'ORDER',id,createdAt:this.time(),market:plan.market,intent:plan.intent,direction:plan.direction,args:plan.args,rules:plan.rules,risk:plan.risk,allowLockIncrease:plan.allowLockIncrease===true};await this.commit({...this.state,pending});
    if(!this.running||!this.guard(plan)||this.time()-this.last.checkedAt>3000){await this.commit({...this.state,pending:null});return;}
    try{await this.clients[plan.market].request('newOrder',{...plan.args,newClientOrderId:id});}catch(error){if(error.definitiveRejection)await this.commit({...this.state,pending:{...this.state.pending,definitiveRejection:error.binanceCode}});throw error;}await this.reconcile();await this.ensureProtections();
  }
  armTrading(){for(const client of Object.values(this.clients))client.arm(FUTURES_CONFIRMATION);this.running=true;}
  async start(confirmation){
    if(confirmation!==FUTURES_CONFIRMATION)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');
    const generation=this.stopGeneration;
    await this.check();if(this.state.pending)throw new Error('RECONCILE_PENDING_FUTURES_RESULT_FIRST');if(this.state.hedgeLock?.active)throw new Error('MANUAL_HEDGE_LOCK_STRATEGY_PAUSED');
    if(!this.last.actualConfigurationMatches)throw new Error('APPLY_SELECTED_CONTRACT_SETTINGS_FIRST');if(this.settings.positionPolicy==='hedge'&&!this.last.hedge)throw new Error('ENABLE_EXCHANGE_HEDGE_MODE_FIRST');if(this.last.configuration.marginMode==='ISOLATED'&&this.last.configuration.autoAddMargin===true)throw new Error('ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED');if(this.state.day.blocked&&!ownedPositions(this.state).length)throw new Error('DAILY_USDT_EQUITY_LOSS_20_PERCENT');
    if(!this.guard())throw new Error('FUTURES_START_AUTHORIZATION_REQUIRED');
    if(generation!==this.stopGeneration)throw new Error('FUTURES_START_CANCELLED');
    this.armTrading();
    try{
      await this.ensureProtections();
      if(generation!==this.stopGeneration)throw new Error('FUTURES_START_CANCELLED');
    }catch(error){this.stop();throw error;}
    this.syncLastState();return this.last;
  }
  async applyContractSettings(confirmation){
    if(confirmation!==SETTINGS_CONFIRMATION)throw new Error('EXPLICIT_MARGIN_AND_LEVERAGE_CONFIRMATION_REQUIRED');if(this.busy||this.running||this.state?.pending||ownedPositions(this.state).length)throw new Error('FLAT_STOPPED_ACCOUNT_REQUIRED_FOR_SETTINGS');this.busy=true;
    try{
      const env=await this.environment();
      if(env.capacity&&env.capacity.mode!==this.settings.assetMode)throw new Error('ASSET_MODE_PREFERENCE_MISMATCH');
      if(this.state&&this.state.uid!==env.uid)throw new Error('FUTURES_ACCOUNT_DIFFERS_FROM_SAVED_LEDGER');
      this.assertOwnedEnvironment(env);
      const {symbol,market,leverage,marginMode}=this.settings;
      const tiers=leverageTiers(await this.client.request('brackets',{symbol}),market,symbol);
      if(leverage>Math.max(...tiers.map(row=>row.leverage)))throw new Error('SELECTED_LEVERAGE_EXCEEDS_ACCOUNT_BRACKET');
      const rules=contractRules(await this.client.request('catalog'),market,symbol);
      const before=await this.configuration(env,rules);
      this.client.armSettings(confirmation);
      if(before.marginMode!==marginMode){
        try{await this.client.request('setMargin',{symbol,marginType:marginMode});}
        catch(error){if(error.binanceCode!==-4046)throw error;}
      }
      if(before.leverage!==leverage)await this.client.request('setLeverage',{symbol,leverage});
      const current=await this.configuration(await this.environment(),rules);
      if(current.marginMode!==marginMode||current.leverage!==leverage)throw new Error('CONTRACT_SETTINGS_NOT_VERIFIED');
    }finally{this.stop();this.busy=false;}
    return this.check();
  }
  async enableHedgeMode(confirmation){
    if(confirmation!==MODE_CONFIRMATION)throw new Error('EXPLICIT_ACCOUNT_HEDGE_MODE_CONFIRMATION_REQUIRED');if(this.running||this.busy||this.state?.pending||ownedPositions(this.state).length||ownedProtections(this.state).length)throw new Error('BOTH_FUTURES_WALLETS_MUST_BE_FLAT_FOR_MODE_CHANGE');this.busy=true;
    try{const env=await this.environment();if(this.state&&this.state.uid!==env.uid)throw new Error('FUTURES_ACCOUNT_DIFFERS_FROM_SAVED_LEDGER');this.assertOwnedEnvironment(env,{requireAccountFlat:true});if(!env.hedge){const c=this.clients.USD_M;c.armMode(confirmation);try{await c.request('setPositionMode',{dualSidePosition:'true'});}catch(error){if(error.binanceCode!==-4059)throw error;}}this.cache.delete('positionMode');const actual=await this.environment();if(!actual.hedge)throw new Error('EXCHANGE_HEDGE_MODE_NOT_VERIFIED');this.assertOwnedEnvironment(actual,{requireAccountFlat:true});}finally{this.stop();this.busy=false;}return this.check();
  }
  async catalog(){const raw=await this.client.request('catalog');return (raw.symbols??[]).flatMap(row=>{try{return [contractRules(raw,this.settings.market,row.symbol)];}catch{return[];}});}
  selectedDirection(direction){const owned=ownedPositions(this.state);if(direction===undefined&&owned.length===1)return owned[0].direction;if(!['LONG','SHORT'].includes(direction))throw new Error('CHOOSE_LONG_OR_SHORT_LEG');return direction;}
  async closeOwnedPosition(confirmation,direction){
    if(confirmation!==FUTURES_CONFIRMATION)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');this.stop();await this.check({closingOnly:true});direction=this.selectedDirection(direction);const owned=this.state.positions[direction];if(!owned||this.state.pending)throw new Error('RECONCILED_OWNED_POSITION_REQUIRED');this.busy=true;
    try{const rules=contractRules(await this.client.request('catalog'),owned.market,owned.symbol),plan={intent:'CLOSE_'+direction,direction,market:owned.market,rules,risk:owned.risk,allocation:null,manualLock:true,args:{symbol:owned.symbol,side:direction==='LONG'?'SELL':'BUY',positionSide:owned.positionSide,type:'MARKET',quantity:owned.quantity,newOrderRespType:'ACK',...(owned.positionSide==='BOTH'?{reduceOnly:'true'}:{})}};this.last.plan=plan;this.armTrading();await this.execute(plan);}finally{this.stop();this.busy=false;}return this.check({closingOnly:true});
  }
  async previewManualHedge(){
    await this.check();if(!this.last.hedge||this.settings.positionPolicy!=='hedge')throw new Error('ENABLE_EXCHANGE_HEDGE_MODE_FIRST');if(this.state.pending||!ownedPositions(this.state).length)throw new Error('RECONCILED_OWNED_POSITION_REQUIRED');
    const quantities={LONG:this.state.positions.LONG?.quantity??'0',SHORT:this.state.positions.SHORT?.quantity??'0'},long=units(quantities.LONG),short=units(quantities.SHORT),gap=absolute(long-short);
    if(!gap)return {balanced:true,expectedPositions:quantities,quantity:'0',checkedAt:this.time()};if(this.state.day.blocked)throw new Error('DAILY_USDT_EQUITY_LOSS_20_PERCENT');
    const direction=long>short?'SHORT':'LONG',other=this.state.positions[direction==='LONG'?'SHORT':'LONG'],plan=await this.buildPlan({...this.context,signal:{intent:'OPEN_'+direction,risk:{...other.risk}},direction,overrideQuantity:decimal(gap),allowLockIncrease:true});
    return {balanced:false,expectedPositions:quantities,direction,quantity:decimal(gap),allocation:plan.allocation,asset:this.last.marginAsset,checkedAt:this.time()};
  }
  async manualHedge(confirmation,expectedPositions=null){
    if(confirmation!==HEDGE_CONFIRMATION)throw new Error('EXPLICIT_EQUAL_HEDGE_CONFIRMATION_REQUIRED');this.stop();await this.check();if(!this.last.hedge||this.settings.positionPolicy!=='hedge')throw new Error('ENABLE_EXCHANGE_HEDGE_MODE_FIRST');if(this.state.pending||!ownedPositions(this.state).length)throw new Error('RECONCILED_OWNED_POSITION_REQUIRED');if(this.state.day.blocked)throw new Error('DAILY_USDT_EQUITY_LOSS_20_PERCENT');if(!this.last.actualConfigurationMatches)throw new Error('APPLY_SELECTED_CONTRACT_SETTINGS_FIRST');if(this.last.configuration.marginMode==='ISOLATED'&&this.last.configuration.autoAddMargin===true)throw new Error('ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED');
    if(expectedPositions){if(Object.keys(expectedPositions).sort().join(',')!=='LONG,SHORT'||['LONG','SHORT'].some(side=>units(expectedPositions[side])!==units(this.state.positions[side]?.quantity??'0')))throw new Error('HEDGE_POSITION_CHANGED_PREVIEW_AGAIN');}
    await this.commit({...this.state,hedgeLock:this.state.hedgeLock??{active:true,since:this.time()}});this.armTrading();
    try{this.busy=true;await this.ensureProtections();this.busy=false;await this.check();this.busy=true;const long=units(this.state.positions.LONG?.quantity??'0'),short=units(this.state.positions.SHORT?.quantity??'0'),gap=absolute(long-short);if(gap){const direction=long>short?'SHORT':'LONG',other=this.state.positions[direction==='LONG'?'SHORT':'LONG'];const signal={intent:'OPEN_'+direction,risk:{...other.risk}},plan=await this.buildPlan({...this.context,signal,direction,overrideQuantity:decimal(gap),allowLockIncrease:true});plan.manualLock=true;this.last.plan=plan;await this.execute(plan);}}finally{this.stop();this.busy=false;}return this.check();
  }
  async clearManualHedgeLock(confirmation){
    if(confirmation!==FUTURES_CONFIRMATION)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');if(this.running||this.busy||this.state?.pending)throw new Error('STOP_AND_RECONCILE_BEFORE_UNLOCKING_HEDGE');await this.check();await this.commit({...this.state,hedgeLock:null});this.syncLastState();return this.last;
  }
  async addIsolatedMargin({confirmation,direction,amount}){
    if(confirmation!==MARGIN_CONFIRMATION)throw new Error('EXPLICIT_ISOLATED_MARGIN_ADDITION_REQUIRED');if(typeof amount!=='string'||!units(amount))throw new Error('POSITIVE_NATIVE_MARGIN_AMOUNT_REQUIRED');this.stop();await this.check();direction=this.selectedDirection(direction);const position=this.state.positions[direction];if(!position||this.state.pending)throw new Error('RECONCILED_OWNED_POSITION_REQUIRED');if(this.last.configuration.marginMode!=='ISOLATED')throw new Error('MARGIN_ADDITION_REQUIRES_ISOLATED_POSITION');const balance=this.context.env.balances[position.market].find(row=>row.asset===position.marginAsset);if(!balance||units(amount)>units(balance.availableBalance))throw new Error('AVAILABLE_COLLATERAL_INSUFFICIENT');this.busy=true;
    try{await this.submitMargin(direction,amount);}finally{this.stop();this.busy=false;this.syncLastState();}return this.check();
  }
  async armAutoMargin(confirmation){
    if(confirmation!==AUTO_MARGIN_CONFIRMATION)throw new Error('EXPLICIT_JSON_AUTO_MARGIN_CONFIRMATION_REQUIRED');if(this.running||this.busy||this.state?.pending)throw new Error('STOP_AND_RECONCILE_BEFORE_AUTO_MARGIN');await this.check();const policy=this.settings.externalMarginPolicy;
    if(!policy?.enabled)throw new Error('IMPORT_ENABLED_EXTERNAL_AUTO_MARGIN_POLICY_FIRST');if(policy.market!==this.settings.market||policy.symbol!==this.settings.symbol||policy.asset!==this.last.marginAsset)throw new Error('AUTO_MARGIN_POLICY_TARGET_MISMATCH');if(this.last.configuration.marginMode!=='ISOLATED')throw new Error('AUTO_MARGIN_REQUIRES_ISOLATED_POSITION');if(this.last.configuration.autoAddMargin===true)throw new Error('EXCHANGE_AUTO_ADD_MARGIN_ALREADY_ENABLED');if(this.last.configuration.autoAddMargin!==false)throw new Error('EXCHANGE_AUTO_ADD_MARGIN_STATUS_UNAVAILABLE');if(this.state.day.blocked)throw new Error('DAILY_USDT_EQUITY_LOSS_20_PERCENT');
    await this.commit(registerMarginPolicy(this.state,policy));this.autoMarginArmed=true;this.syncLastState();return this.check();
  }
  async submitMargin(direction,amount,{automaticPolicy=null}={}){
    const position=this.state.positions[direction];if(!position||this.state.pending)throw new Error('RECONCILED_OWNED_POSITION_REQUIRED');
    await this.recheckSelectedContract();
    if(automaticPolicy){const p=this.settings.externalMarginPolicy,balance=this.context.env.balances[position.market].find(row=>row.asset===position.marginAsset),decision=autoMarginDecision({policy:p,state:this.state,snapshot:this.last,armed:this.autoMarginArmed,now:this.time(),availableCollateral:balance?.availableBalance??'0'});if(!p||marginPolicyDigest(p)!==marginPolicyDigest(automaticPolicy)||!decision.eligible||decision.direction!==direction||decision.amount!==amount||this.time()-this.last.checkedAt>3000)throw new Error('FRESH_EXTERNAL_AUTO_MARGIN_DECISION_REQUIRED');}
    const id='asbm_'+randomBytes(14).toString('hex'),args={symbol:position.symbol,positionSide:position.positionSide,type:1,amount:decimal(units(amount))},policyId=automaticPolicy?.id??null;
    await this.commit({...this.state,pending:{kind:'MARGIN_ADD',id,direction,market:position.market,asset:position.marginAsset,args,createdAt:this.time(),policyId,policyDigest:automaticPolicy?marginPolicyDigest(automaticPolicy):null}});
    if(!this.guard()||(automaticPolicy&&!this.autoMarginArmed)){await this.commit({...this.state,pending:null});throw new Error('MARGIN_ADDITION_CANCELLED_BEFORE_SUBMISSION');}
    const client=this.clients[position.market];client.armMargin(MARGIN_CONFIRMATION);
    try{try{const response=await client.request('addMargin',args);if(response.code!==200)throw new Error('MARGIN_ADDITION_RESULT_UNKNOWN');await this.commit({...this.state,pending:{...this.state.pending,acknowledged:true}});}catch(error){if(error.definitiveRejection)await this.commit({...this.state,pending:{...this.state.pending,definitiveRejection:error.binanceCode}});throw error;}await this.reconcile();}finally{client.disarmMargin?.();}
  }
  async reconcileMargin(pending){
    const rows=await this.clients[pending.market].request('marginHistory',{symbol:pending.args.symbol,type:1,startTime:pending.createdAt,endTime:this.time()+1000,limit:100});if(!Array.isArray(rows)||rows.length>=100)throw new Error('COMPLETE_MARGIN_ADDITION_HISTORY_REQUIRED');
    const matches=rows.filter(row=>row.symbol===pending.args.symbol&&row.positionSide===pending.args.positionSide&&Number(row.type)===1&&row.asset===pending.asset&&Number.isSafeInteger(row.time)&&row.time>=pending.createdAt&&units(String(row.amount))===units(pending.args.amount)).filter(row=>!this.state.marginEvents.some(event=>event.historyKey===`${pending.market}:${row.symbol}:${row.positionSide}:${row.time}:${decimal(units(String(row.amount)))}`));
    if(matches.length!==1){if(!matches.length&&pending.definitiveRejection){await this.commit({...this.state,pending:null,lastMarginRejection:pending.definitiveRejection});return;}throw new Error('MARGIN_ADDITION_RESULT_UNRESOLVED_DO_NOT_RESUBMIT');}
    const row=matches[0],event={id:pending.id,market:pending.market,direction:pending.direction,symbol:row.symbol,asset:row.asset,amount:decimal(units(String(row.amount))),time:row.time,policyId:pending.policyId??null,policyDigest:pending.policyDigest??null,historyKey:`${pending.market}:${row.symbol}:${row.positionSide}:${row.time}:${decimal(units(String(row.amount)))}`},budgets={...this.state.autoMarginBudgets};
    if(pending.policyId){const budget=budgets[pending.policyId];if(!budget||budget.market!==pending.market||budget.symbol!==row.symbol||budget.asset!==row.asset)throw new Error('AUTO_MARGIN_BUDGET_TARGET_CHANGED');budgets[pending.policyId]={...budget,usedAmount:decimal(units(budget.usedAmount)+units(event.amount)),additions:budget.additions+1,lastAdditionAt:event.time};}
    await this.commit({...this.state,pending:null,marginEvents:[...this.state.marginEvents,event],autoMarginBudgets:budgets});
  }
}
