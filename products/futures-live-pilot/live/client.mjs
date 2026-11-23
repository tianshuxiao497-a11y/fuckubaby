import {createHmac,createPrivateKey,sign,constants} from 'node:crypto';
import {family} from './math.mjs';
import {contractSymbol} from './market.mjs';
export const FUTURES_CONFIRMATION='START REAL FUTURES TRADING';
export const SETTINGS_CONFIRMATION='APPLY FUTURES SETTINGS';
export const MODE_CONFIRMATION='ENABLE FUTURES HEDGE MODE';
export const MARGIN_CONFIRMATION='ADD ISOLATED MARGIN';
export const HEDGE_CONFIRMATION='LOCK FUTURES POSITION';
export const ownOrderId=value=>typeof value==='string'&&/^asbf_[a-f0-9]{28}$/.test(value);
export const ownAlgoId=value=>typeof value==='string'&&/^asbp_[a-f0-9]{28}$/.test(value);
export const ownMarginId=value=>typeof value==='string'&&/^asbm_[a-f0-9]{28}$/.test(value);
const positive=value=>typeof value==='string'&&/^\d{1,18}(\.\d{1,12})?$/.test(value)&&Number(value)>0;

function routes(market){
  const prefix=market==='USD_M'?'/fapi':'/dapi';
  return new Map([
    ['time',['GET',prefix+'/v1/time',[],false]],
    ['catalog',['GET',prefix+'/v1/exchangeInfo',[],false]],
    ['book',['GET',prefix+'/v1/ticker/bookTicker',['symbol'],false]],
    ['mark',['GET',prefix+'/v1/premiumIndex',['symbol'],false]],
    ['candles',['GET',prefix+'/v1/klines',['symbol','interval','limit','startTime','endTime'],false]],
    ['markCandles',['GET',prefix+'/v1/markPriceKlines',['symbol','interval','limit','startTime','endTime'],false]],
    ['account',['GET',prefix+(market==='USD_M'?'/v3/account':'/v1/account'),[],true]],
    ['balances',['GET',prefix+(market==='USD_M'?'/v3/balance':'/v1/balance'),[],true]],
    ['positionMode',['GET',prefix+'/v1/positionSide/dual',[],true]],
    ['positions',['GET',prefix+(market==='USD_M'?'/v3/positionRisk':'/v1/positionRisk'),[],true]],
    ['brackets',['GET',prefix+(market==='USD_M'?'/v1/leverageBracket':'/v2/leverageBracket'),['symbol'],true]],
    ['fees',['GET',prefix+'/v1/commissionRate',['symbol'],true]],
    ['openOrders',['GET',prefix+'/v1/openOrders',[],true]],
    ['openAlgos',['GET',prefix+'/v1/openAlgoOrders',['symbol'],true]],
    ['order',['GET',prefix+'/v1/order',['symbol','origClientOrderId','orderId'],true]],
    ['algo',['GET',prefix+'/v1/algoOrder',['algoId','clientAlgoId'],true]],
    ['trades',['GET',prefix+'/v1/userTrades',['symbol','orderId','fromId','startTime','endTime','limit'],true]],
    ['income',['GET',prefix+'/v1/income',['symbol','startTime','endTime','limit'],true]],
    ['newOrder',['POST',prefix+'/v1/order',['symbol','side','positionSide','type','timeInForce','quantity','price','reduceOnly','newClientOrderId','newOrderRespType'],true]],
    ['newProtection',['POST',prefix+'/v1/algoOrder',['algoType','symbol','side','positionSide','type','quantity','triggerPrice','workingType','priceProtect','reduceOnly','clientAlgoId'],true]],
    ['cancelOrder',['DELETE',prefix+'/v1/order',['symbol','origClientOrderId'],true]],
    ['cancelProtection',['DELETE',prefix+'/v1/algoOrder',['clientAlgoId'],true]],
    ['setMargin',['POST',prefix+'/v1/marginType',['symbol','marginType'],true]],
    ['setLeverage',['POST',prefix+'/v1/leverage',['symbol','leverage'],true]],
    ['setPositionMode',['POST',prefix+'/v1/positionSide/dual',['dualSidePosition'],true]],
    ['addMargin',['POST',prefix+'/v1/positionMargin',['symbol','positionSide','amount','type'],true]],
    ['marginHistory',['GET',prefix+'/v1/positionMargin/history',['symbol','type','startTime','endTime','limit'],true]],
    ...(market==='USD_M'?[
      ['accountConfig',['GET','/fapi/v1/accountConfig',[],true]],
      ['marginIndex',['GET','/fapi/v1/assetIndex',['symbol'],false]],
      ['multiAssets',['GET','/fapi/v1/multiAssetsMargin',[],true]],
      ['symbolConfig',['GET','/fapi/v1/symbolConfig',['symbol'],true]],
    ]:[]),
    ['collateralPrice',['GET','/api/v3/ticker/price',['symbol'],false,'https://api.binance.com']],
    ['collateralCandles',['GET','/api/v3/klines',['symbol','interval','limit','startTime','endTime'],false,'https://api.binance.com']],
  ]);
}
async function boundedJson(response){
  const reader=response.body?.getReader();if(!reader)throw new Error('EMPTY_FUTURES_RESPONSE');
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8388608)throw new Error();chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{await reader.cancel().catch(()=>{});throw new Error('INVALID_FUTURES_RESPONSE');}finally{reader.releaseLock();}
}
function closing(parameters){return parameters.reduceOnly==='true'||(parameters.positionSide==='LONG'&&parameters.side==='SELL')||(parameters.positionSide==='SHORT'&&parameters.side==='BUY');}
export class FuturesClient{
  #key;#secret;#rsa;#fetch;#now;#offset;#syncedAt;#armed=false;#settings=false;#mode=false;#margin=false;#blocked=false;#routes;#origin;
  constructor({market,apiKey='',apiSecret='',privateKeyPem='',fetchImpl=fetch,now=Date.now,...extra}={}){
    family(market);if(Object.keys(extra).length||[apiKey,apiSecret,privateKeyPem].some(x=>typeof x!=='string')||(apiSecret&&privateKeyPem)||apiKey.startsWith('apik_'))throw new Error('INVALID_FUTURES_CLIENT_OPTIONS');
    Object.defineProperty(this,'market',{value:market,enumerable:true});this.#origin=market==='USD_M'?'https://fapi.binance.com':'https://dapi.binance.com';
    this.#key=apiKey.trim();this.#secret=apiSecret.trim();this.#fetch=fetchImpl;this.#now=now;this.#routes=routes(market);
    if(privateKeyPem){this.#rsa=createPrivateKey(privateKeyPem);if(this.#rsa.asymmetricKeyType!=='rsa')throw new Error('FUTURES_RSA_OR_HMAC_REQUIRED');}
  }
  get origin(){return this.#origin;}
  serverNow(){if(this.#offset===undefined)throw new Error('FRESH_FUTURES_CLOCK_REQUIRED');return Math.floor(this.#now()+this.#offset);}
  arm(value){if(value!==FUTURES_CONFIRMATION)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');if(this.#blocked)throw new Error('FUTURES_SERVICE_BLOCKED');this.#armed=true;}
  disarm(){this.#armed=false;this.#settings=false;this.#mode=false;this.#margin=false;}
  armSettings(value){if(value!==SETTINGS_CONFIRMATION)throw new Error('EXPLICIT_MARGIN_AND_LEVERAGE_CONFIRMATION_REQUIRED');if(this.#blocked)throw new Error('FUTURES_SERVICE_BLOCKED');this.#settings=true;}
  armMode(value){if(value!==MODE_CONFIRMATION)throw new Error('EXPLICIT_ACCOUNT_HEDGE_MODE_CONFIRMATION_REQUIRED');if(this.#blocked)throw new Error('FUTURES_SERVICE_BLOCKED');this.#mode=true;}
  armMargin(value){if(value!==MARGIN_CONFIRMATION)throw new Error('EXPLICIT_ISOLATED_MARGIN_ADDITION_REQUIRED');if(this.#blocked)throw new Error('FUTURES_SERVICE_BLOCKED');this.#margin=true;}
  disarmMargin(){this.#margin=false;}
  async syncTime(){const before=this.#now(),result=await this.request('time'),after=this.#now();if(!Number.isSafeInteger(result.serverTime)||result.serverTime<=0||after<before||after-before>5000)throw new Error('UNRELIABLE_FUTURES_CLOCK');this.#offset=result.serverTime-after-250;this.#syncedAt=after;return result.serverTime;}
  async request(name,parameters={}){
    try{return await this.#send(name,parameters);}
    catch(error){
      if(this.#routes.get(name)?.[0]==='GET'){
        error.readFailure={market:this.market,operation:name,httpStatus:error.httpStatus??null,binanceCode:error.binanceCode??null};
      }
      throw error;
    }
  }
  async #send(name,parameters){
    const route=this.#routes.get(name);if(!route||!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).some(k=>!route[2].includes(k)))throw new Error('FUTURES_ROUTE_OR_PARAMETER_REFUSED');
    if(this.#blocked)throw Object.assign(new Error('FUTURES_SERVICE_BLOCKED'),{httpStatus:this.#blocked});
    const [method,path,,signed,publicOrigin]=route;
    if(name==='marginIndex'){
      if(!['USDTUSD','USDCUSD'].includes(parameters.symbol))throw new Error('INVALID_STABLECOIN_INDEX');
    }else if(parameters.symbol!==undefined){if(publicOrigin){if(!/^[A-Z0-9]{1,24}USDT$/.test(parameters.symbol))throw new Error('INVALID_COLLATERAL_PRICE_SYMBOL');}else contractSymbol(parameters.symbol);}
    if(['book','mark','fees','brackets','newOrder','newProtection','setMargin','setLeverage','order','trades','addMargin','marginHistory'].includes(name)&&!parameters.symbol)throw new Error('EXPLICIT_CONTRACT_REQUIRED');
    if(name.endsWith('Candles')||name==='candles'){
      if(parameters.interval!=='1m'||!Number.isSafeInteger(parameters.limit)||parameters.limit<1||parameters.limit>120)throw new Error('BOUNDED_MINUTE_CANDLES_REQUIRED');
    }
    if(['trades','income'].includes(name)&&parameters.limit!==1000)throw new Error('BOUNDED_FUTURES_HISTORY_REQUIRED');
    if(name==='marginHistory'&&(parameters.limit!==100||parameters.type!==1))throw new Error('BOUNDED_MARGIN_ADDITION_HISTORY_REQUIRED');
    for(const field of ['startTime','endTime','orderId','algoId','fromId'])if(parameters[field]!==undefined&&(!Number.isSafeInteger(parameters[field])||parameters[field]<0))throw new Error('INVALID_FUTURES_HISTORY_REFERENCE');
    if(name==='order'&&!(ownOrderId(parameters.origClientOrderId)||Number.isSafeInteger(parameters.orderId)&&parameters.orderId>0))throw new Error('EXPLICIT_OWNED_ORDER_REFERENCE_REQUIRED');
    if(name==='algo'&&!(ownAlgoId(parameters.clientAlgoId)||Number.isSafeInteger(parameters.algoId)&&parameters.algoId>0))throw new Error('EXPLICIT_OWNED_PROTECTION_REFERENCE_REQUIRED');
    if(name==='cancelOrder'&&!ownOrderId(parameters.origClientOrderId))throw new Error('OWNED_ORDER_REQUIRED');
    if(name==='cancelProtection'&&!ownAlgoId(parameters.clientAlgoId))throw new Error('OWNED_PROTECTION_REQUIRED');
    if(['setMargin','setLeverage'].includes(name)){
      if(!this.#settings)throw new Error('EXPLICIT_MARGIN_AND_LEVERAGE_CONFIRMATION_REQUIRED');
      if(name==='setMargin'&&!['ISOLATED','CROSSED'].includes(parameters.marginType))throw new Error('EXPLICIT_MARGIN_MODE_REQUIRED');
      if(name==='setLeverage'&&(!Number.isSafeInteger(parameters.leverage)||parameters.leverage<1||parameters.leverage>1000))throw new Error('INVALID_SELECTED_LEVERAGE');
    }else if(name==='setPositionMode'){
      if(!this.#mode||parameters.dualSidePosition!=='true')throw new Error('EXPLICIT_ACCOUNT_HEDGE_MODE_CONFIRMATION_REQUIRED');
    }else if(name==='addMargin'){
      if(!this.#margin||parameters.type!==1||!positive(parameters.amount)||!['BOTH','LONG','SHORT'].includes(parameters.positionSide))throw new Error('EXPLICIT_ISOLATED_MARGIN_ADDITION_REQUIRED');
    }else if(method!=='GET'&&!this.#armed)throw new Error('EXPLICIT_FUTURES_START_REQUIRED');
    if(['newOrder','newProtection'].includes(name)){
      if(!['BUY','SELL'].includes(parameters.side)||!['BOTH','LONG','SHORT'].includes(parameters.positionSide)||!positive(parameters.quantity))throw new Error('EXPLICIT_FUTURES_POSITION_AND_QUANTITY_REQUIRED');
      if(parameters.positionSide!=='BOTH'&&parameters.reduceOnly!==undefined)throw new Error('HEDGE_MODE_REDUCE_ONLY_PARAMETER_REFUSED');
      if(parameters.reduceOnly!==undefined&&!['true','false'].includes(parameters.reduceOnly))throw new Error('INVALID_REDUCE_ONLY_PARAMETER');
    }
    if(name==='newOrder'){
      if(!ownOrderId(parameters.newClientOrderId)||parameters.newOrderRespType!=='ACK')throw new Error('PERSISTED_OWN_ORDER_ID_REQUIRED');
      if(parameters.type==='LIMIT'){
        if(parameters.timeInForce!=='IOC'||!positive(parameters.price))throw new Error('LIMIT_IOC_PRICE_REQUIRED');
      }else if(parameters.type==='MARKET'){
        if(!closing(parameters)||parameters.price!==undefined||parameters.timeInForce!==undefined)throw new Error('MARKET_ONLY_FOR_REDUCING_OWN_POSITION');
      }else throw new Error('FUTURES_ORDER_TYPE_REFUSED');
    }
    if(name==='newProtection'&&(!ownAlgoId(parameters.clientAlgoId)||parameters.algoType!=='CONDITIONAL'||parameters.type!=='STOP_MARKET'||parameters.workingType!=='MARK_PRICE'||parameters.priceProtect!=='FALSE'||!positive(parameters.triggerPrice)||!closing(parameters)))throw new Error('OWNED_REDUCING_MARK_PRICE_STOP_REQUIRED');
    const query=new URLSearchParams(Object.entries(parameters).map(([k,v])=>[k,String(v)]));
    const headers={Accept:'application/json'};
    if(signed){
      const now=this.#now();if(!this.#key||(!this.#secret&&!this.#rsa))throw new Error('FUTURES_TRADING_CREDENTIALS_REQUIRED');
      if(this.#offset===undefined||now<this.#syncedAt||now-this.#syncedAt>60000)throw new Error('FRESH_FUTURES_CLOCK_REQUIRED');
      query.set('recvWindow','5000');query.set('timestamp',String(Math.floor(now+this.#offset)));
      const payload=query.toString();query.set('signature',this.#rsa?sign('sha256',Buffer.from(payload),{key:this.#rsa,padding:constants.RSA_PKCS1_PADDING}).toString('base64'):createHmac('sha256',this.#secret).update(payload).digest('hex'));
      headers['X-MBX-APIKEY']=this.#key;
    }
    const url=new URL(path,publicOrigin??this.origin),options={method,headers,redirect:'error',signal:AbortSignal.timeout(12000)};
    if(method==='POST'){headers['Content-Type']='application/x-www-form-urlencoded';options.body=query.toString();}else url.search=query.toString();
    let response;try{response=await this.#fetch(url,options);}catch{throw new Error(method==='GET'?'FUTURES_CONNECTION_FAILED':'FUTURES_RESULT_UNKNOWN_RECONCILE');}
    if([403,418,429,451].includes(response.status)){this.#blocked=response.status;this.disarm();await response.body?.cancel();throw Object.assign(new Error('FUTURES_SERVICE_REFUSED_OR_RATE_LIMITED'),{httpStatus:response.status});}
    let result;try{result=await boundedJson(response);}catch{throw Object.assign(new Error(method==='GET'?'INVALID_FUTURES_RESPONSE':'FUTURES_RESULT_UNKNOWN_RECONCILE'),{httpStatus:response.status});}
    if(!response.ok||(typeof result?.code==='number'&&result.code<0)){
      const error=new Error(method==='GET'?'FUTURES_QUERY_REJECTED':'FUTURES_MUTATION_REJECTED_OR_UNKNOWN');error.binanceCode=Number.isSafeInteger(result?.code)?result.code:null;error.httpStatus=response.status;
      error.definitiveRejection=method==='POST'&&response.status===400&&([-1013,-1021,-2019,-2021,-2022].includes(error.binanceCode)||(error.binanceCode<=-1100&&error.binanceCode>=-1136));throw error;
    }
    if(!result||typeof result!=='object')throw new Error('INVALID_FUTURES_RESPONSE');return result;
  }
}
