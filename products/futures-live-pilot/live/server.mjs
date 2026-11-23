import http from 'node:http';
import {randomBytes,generateKeyPairSync,createPrivateKey,createPublicKey,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FuturesClient} from './client.mjs';
import {FuturesEngine,FUTURES_VERSION,validateSettings} from './engine.mjs';
import {saveVault,loadVault} from '../../spot-live-pilot/live/vault.mjs';
import {parseFuturesStrategy} from './strategy.mjs';
import {contractRules,leverageTiers} from './market.mjs';
import {aggregateAssets,ownedPositions} from './ledger.mjs';
import {parseMarginPolicy,registerMarginPolicy} from './margin-policy.mjs';
import {totalEquityUsdt,signedUnits,decimal} from './math.mjs';
import {reviewReport} from './review.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
export function defaultProfile(){return process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'AdaptiveSpotBot','FuturesPersonal'):process.platform==='darwin'?join(homedir(),'Library','Application Support','AdaptiveSpotBot','FuturesPersonal'):join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'AdaptiveSpotBot','FuturesPersonal');}
const safeError=error=>/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'FUTURES_ACTION_FAILED';
function credentials(value){if(!value||Object.keys(value).some(k=>!['apiKey','apiSecret','privateKeyPem'].includes(k))||typeof value.apiKey!=='string'||!value.apiKey.trim()||(!!value.apiSecret===!!value.privateKeyPem))throw new Error('ONE_FUTURES_SIGNATURE_METHOD_REQUIRED');return value;}
async function registrationPair(profile,password){
  let pair;
  try{pair=await loadVault(resolve(profile,'futures-registration-key.json'),password);}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const publicKey=createPublicKey(createPrivateKey(pair.privateKeyPem)).export({type:'spki',format:'pem'});
  if(publicKey!==pair.publicKey)throw new Error('FUTURES_REGISTRATION_KEY_MISMATCH');
  return pair;
}
function preferences(value){if(value===undefined)return {autoConnect:false};if(!value||Object.keys(value).join(',')!=='autoConnect'||typeof value.autoConnect!=='boolean')throw new Error('INVALID_FUTURES_CONNECTION_PREFERENCE');return value;}
async function bodyOf(request){let size=0;const parts=[];for await(const part of request){size+=part.length;if(size>32768)throw new Error('FUTURES_REQUEST_TOO_LARGE');parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new Error('INVALID_FUTURES_REQUEST_JSON');}}
export async function createFuturesServer({profile=defaultProfile(),port=0,now=Date.now,pollMs=5000,embeddingOrigin=null,tradingAllowed=()=>true,clientFactory=value=>Object.fromEntries(['USD_M','COIN_M'].map(market=>[market,new FuturesClient({market,...value})]))}={}){
  if(typeof tradingAllowed!=='function')throw new Error('TRADING_AUTHORIZATION_REQUIRED');
  if(embeddingOrigin!==null){let url;try{url=new URL(embeddingOrigin);}catch{throw new Error('INVALID_WORKBENCH_ORIGIN');}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.origin!==embeddingOrigin)throw new Error('INVALID_WORKBENCH_ORIGIN');}
  if(!Number.isSafeInteger(pollMs)||pollMs<20)throw new Error('INVALID_FUTURES_MONITOR_INTERVAL');
  const token=randomBytes(32).toString('hex'),vaultPath=resolve(profile,'futures-vault.json');let origin,engine=null,secret=null,settings=null,prefs={autoConnect:false},closing=false,actionBusy=false,nextCheck=Infinity,failures=0;
  let vaultExists=await lstat(vaultPath).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
  let monitorRead=null;
  const logs=[];const record=(event,code=null)=>{logs.push({time:now(),event,code});if(logs.length>200)logs.shift();};
  const status=()=>({version:FUTURES_VERSION,environment:'BINANCE_FUTURES_MAINNET',tradingAuthorized:tradingAllowed()===true,edition:'personal',running:engine?.running??false,autoMarginArmed:engine?.autoMarginArmed??false,unlocked:!!engine,vaultExists,settings,preferences:prefs,
    connected:!!engine?.last?.accountChecked&&!engine.error&&now()>=engine.last.localCheckedAt&&now()-engine.last.localCheckedAt<30000,snapshot:engine?.last??null,pending:!!engine?.state?.pending,error:engine?.error??null,reconnecting:!!engine&&prefs.autoConnect&&failures>0,
    walletRead:engine?.walletRead??null,accountModes:engine?.accountModes??null,marginCapacity:engine?.marginCapacity??null,readFailure:engine?.readFailure??null,checking:!!monitorRead,logs:logs.slice(-100)});
  async function replace(data){
    if(engine?.running||engine?.autoMarginArmed||engine?.busy||engine?.state?.pending||ownedPositions(engine?.state).length)throw new Error('FLAT_STOPPED_RECONCILED_FUTURES_PROFILE_REQUIRED');
    const config=validateSettings(data.settings),savedPrefs=preferences(data.preferences),savedCredentials=credentials(data.credentials),clients=clientFactory(savedCredentials);
    await engine?.close();engine=null;secret=null;settings=null;nextCheck=Infinity;
    // An expired subscription blocks risk increases; a manually confirmed close
    // of an existing owned leg remains available.
    const candidate=new FuturesEngine({profile,clients,settings:config,now,guard:plan=>!closing&&(tradingAllowed()===true||['CLOSE_LONG','CLOSE_SHORT'].includes(plan?.intent))});await candidate.acquire();engine=candidate;secret=savedCredentials;settings=config;prefs=savedPrefs;failures=0;
  }
  async function monitor(){
    if(closing||!engine||(!engine.running&&!engine.autoMarginArmed&&!prefs.autoConnect)||actionBusy||engine.busy||now()<nextCheck)return;
    try{
      const execute=engine.running||engine.autoMarginArmed;
      const check=engine.check({execute});
      if(!execute)monitorRead=check;
      await check;
      if(failures)record('FUTURES_READ_ONLY_CONNECTION_RESTORED');failures=0;nextCheck=now()+((engine.running||engine.autoMarginArmed)?5000:15000);
    }
    catch(error){failures++;nextCheck=now()+Math.min(60000,5000*2**Math.min(failures-1,4));record('FUTURES_READ_ONLY_RECONNECT_WAIT',safeError(error));}
    finally{monitorRead=null;}
  }
  const server=http.createServer(async(request,response)=>{
    const path=request.url,security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...(embeddingOrigin?{}:{'X-Frame-Options':'DENY'}),'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors "+(embeddingOrigin??"'none'")+"; base-uri 'none'; form-action 'self'"};
    const reply=(code,value,headers={})=>{response.writeHead(code,{...security,'Content-Type':'application/json; charset=utf-8',...headers});response.end(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
    if(request.headers.host!==new URL(origin).host)return reply(403,{error:'LOCAL_FUTURES_HOST_REQUIRED'});
    try{
      const assets=new Map([['/','ui.html'],['/ui.js','ui.js'],['/ui.css','ui.css'],['/example-futures-strategy.json','example-futures-strategy.json'],['/example-auto-margin.json','example-auto-margin.json'],['/fonts/AdaptiveNotoSansSC.woff2','fonts/AdaptiveNotoSansSC.woff2']]);
      if(request.method==='GET'&&assets.has(path)){const file=assets.get(path);return reply(200,await readFile(resolve(here,file)),{'Content-Type':file.endsWith('.woff2')?'font/woff2':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8'});}
      const provided=request.headers['x-asbf-session'];if(typeof provided!=='string'||provided.length!==token.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(token)))return reply(403,{error:'LOCAL_FUTURES_SESSION_REQUIRED'});
      if(request.method==='GET'&&path==='/api/status')return reply(200,status());
      if(request.method==='GET'&&path==='/api/review'){if(!engine)throw new Error('UNLOCK_FUTURES_VAULT_FIRST');return reply(200,reviewReport(engine),{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="AdaptiveFuturesBot-Review.md"'});}
      if(request.method==='GET'&&path==='/api/history'){
        if(!engine)throw new Error('UNLOCK_FUTURES_VAULT_FIRST');const fields=['time','market','symbol','intent','side','positionSide','quantity','status'],csv=value=>'"'+String(value??'').replaceAll('"','""')+'"';
        return reply(200,'\uFEFF'+[fields.join(','),...(engine.state?.orders??[]).map(row=>fields.map(key=>csv(row[key])).join(','))].join('\r\n'),{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="AdaptiveFuturesBot-Orders.csv"'});
      }
      if(request.method!=='POST'||request.headers.origin!==origin||request.headers['content-type']!=='application/json')return reply(403,{error:'LOCAL_FUTURES_ORIGIN_REQUIRED'});
      const body=await bodyOf(request);
      if(path==='/api/stop'){engine?.stop();record('FUTURES_MANUAL_STOP');return reply(200,status());}
      if(path==='/api/auto-margin-stop'){engine?.stopAutoMargin();record('JSON_AUTO_MARGIN_STOPPED');return reply(200,status());}
      if(['/api/start','/api/hedge-lock','/api/contract-settings','/api/hedge-mode','/api/add-margin','/api/auto-margin-start'].includes(path)&&tradingAllowed()!==true)return reply(403,{error:'ACTIVE_LIVE_SUBSCRIPTION_REQUIRED'});
      if(path==='/api/check'&&monitorRead&&!actionBusy){await monitorRead;return reply(200,status());}
      if(actionBusy||engine?.busy)throw new Error('FUTURES_ACTION_IN_PROGRESS');actionBusy=true;
      try{
        if(path==='/api/preflight'){
          if(engine?.running||engine?.autoMarginArmed||engine?.state?.pending||ownedPositions(engine?.state).length)throw new Error('FLAT_STOPPED_RECONCILED_FUTURES_PROFILE_REQUIRED');
          const creds=body.credentials?credentials(body.credentials):(await loadVault(vaultPath,body.password)).credentials;
          const probe=new FuturesEngine({profile:resolve(profile,'readonly-probe'),clients:clientFactory(creds),settings:validateSettings({market:body.market,symbol:body.symbol,marginMode:'ISOLATED',leverage:1,marginPercent:1,directionMode:'both',dailyLossPercent:20,externalStrategy:null}),now});
          const env=await probe.environment(),catalog=await probe.client.request('catalog'),rules=contractRules(catalog,body.market,body.symbol),config=await probe.configuration(env,rules),tiers=leverageTiers(await probe.client.request('brackets',{symbol:body.symbol}),body.market,body.symbol);
          const wallets={...env.wallets};for(const market of ['USD_M','COIN_M'])for(const row of env.accounts[market].assets)wallets[market+'.'+row.asset]=decimal(signedUnits(row.walletBalance)+signedUnits(row.unrealizedProfit));
          const equity=totalEquityUsdt(aggregateAssets(wallets),await probe.prices(wallets));
          return reply(200,{preflight:true,marginCapacity:env.capacity??null,market:body.market,symbol:body.symbol,configuration:config,hedge:env.hedge,equityUsdt:equity,leverageTiers:tiers,marginAsset:rules.marginAsset,unmanagedPositions:Object.values(env.positions).flat().filter(row=>signedUnits(String(row.positionAmt))!==0n).length});
        }else if(path==='/api/catalog'){
          if(!['USD_M','COIN_M'].includes(body.market))throw new Error('EXPLICIT_FUTURES_MARKET_REQUIRED');
          const client=engine?.clients[body.market]??clientFactory({})[body.market],raw=await client.request('catalog');
          return reply(200,{symbols:(raw.symbols??[]).flatMap(row=>{try{return [contractRules(raw,body.market,row.symbol)];}catch{return[];}})});
        }else if(path==='/api/save'){
          if(vaultExists)throw new Error('UNLOCK_EXISTING_FUTURES_VAULT_BEFORE_EDITING');
          if(typeof body.password!=='string'||body.password.length<12||body.password!==body.passwordRepeat)throw new Error('MATCHING_FUTURES_VAULT_PASSWORDS_REQUIRED');
          const supplied=body.credentials;
          if(typeof supplied?.apiKey!=='string'||!supplied.apiKey.trim())throw new Error('FUTURES_API_KEY_REQUIRED');
          let signing=supplied;
          if(!supplied.apiSecret&&!supplied.privateKeyPem){
            const pair=await registrationPair(profile,body.password);
            if(!pair)throw new Error('ONE_FUTURES_SIGNATURE_METHOD_REQUIRED');
            signing={...supplied,privateKeyPem:pair.privateKeyPem};
          }
          const data={credentials:credentials(signing),settings:validateSettings(body.settings),preferences:preferences(body.preferences)};
          try{await replace(data);}catch(error){
            if(error.code==='EADDRINUSE')throw new Error('FUTURES_PROFILE_IN_USE');
            if(error.code==='EPERM'||error.code==='EACCES')throw new Error('FUTURES_VAULT_WRITE_DENIED');
            if(error.code==='ENOSPC')throw new Error('FUTURES_VAULT_DISK_FULL');
            throw error;
          }
          try{
            // Another instance might have created the vault since this window opened.
            vaultExists=await lstat(vaultPath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
            if(vaultExists)throw new Error('UNLOCK_EXISTING_FUTURES_VAULT_BEFORE_EDITING');
            await saveVault(vaultPath,data,body.password);
          }catch(error){
            nextCheck=Infinity;prefs.autoConnect=false;
            try{await engine.close();}finally{engine=null;secret=null;settings=null;}
            if(error.code==='EPERM'||error.code==='EACCES')throw new Error('FUTURES_VAULT_WRITE_DENIED');
            if(error.code==='ENOSPC')throw new Error('FUTURES_VAULT_DISK_FULL');
            throw error;
          }
          vaultExists=true;nextCheck=prefs.autoConnect?now():Infinity;record('FUTURES_CONFIGURATION_SAVED');
        }else if(path==='/api/unlock'){
          let saved;
          try{saved=await loadVault(vaultPath,body.password);}catch(error){if(error.code==='ENOENT')throw new Error('FUTURES_FIRST_SAVE_REQUIRED');throw error;}
          await replace(saved);nextCheck=prefs.autoConnect?now():Infinity;record('FUTURES_VAULT_UNLOCKED');
        }
        else if(path==='/api/lock'){
          if(engine?.running||engine?.autoMarginArmed||engine?.state?.pending||ownedPositions(engine?.state).length)throw new Error('FLAT_STOPPED_RECONCILED_FUTURES_PROFILE_REQUIRED');await engine?.close();engine=null;secret=null;settings=null;nextCheck=Infinity;record('FUTURES_VAULT_LOCKED');
        }else if(path==='/api/generate-key'){
          if(engine?.running||engine?.state?.pending)throw new Error('STOP_BEFORE_FUTURES_KEY_GENERATION');if(vaultExists&&!engine)throw new Error('UNLOCK_FUTURES_VAULT_FIRST');
          if(secret?.privateKeyPem)return reply(200,{publicKey:createPublicKey(createPrivateKey(secret.privateKeyPem)).export({type:'spki',format:'pem'}),privateKeyPem:secret.privateKeyPem,reused:true});
          const keyFile=resolve(profile,'futures-registration-key.json'),saved=await registrationPair(profile,body.password);
          if(saved)return reply(200,{...saved,reused:true});
          const keys=generateKeyPairSync('rsa',{modulusLength:3072}),value={publicKey:keys.publicKey.export({type:'spki',format:'pem'}),privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'})};await saveVault(keyFile,value,body.password);record('FUTURES_RSA_PUBLIC_KEY_CREATED');return reply(200,{...value,reused:false});
        }else{
          if(!engine)throw new Error('SAVE_OR_UNLOCK_FUTURES_CONFIGURATION');
          if(path==='/api/check'){await engine.check();failures=0;nextCheck=now()+15000;record('FUTURES_READ_ONLY_ACCOUNT_CHECKED');}
          else if(path==='/api/start'){await engine.start(body.confirmation);nextCheck=now();record('FUTURES_STRATEGY_STARTED_BY_USER');}
          else if(path==='/api/reconcile'){engine.stop();await engine.check();record('FUTURES_ORIGINAL_ORDER_RECONCILED');}
          else if(path==='/api/close-position'){await engine.closeOwnedPosition(body.confirmation,body.direction);record('FUTURES_OWN_POSITION_CLOSED_BY_USER');}
          else if(path==='/api/contract-settings'){await engine.applyContractSettings(body.confirmation);record('FUTURES_SELECTED_CONTRACT_SETTINGS_APPLIED');}
          else if(path==='/api/hedge-mode'){await engine.enableHedgeMode(body.confirmation);record('FUTURES_ACCOUNT_HEDGE_MODE_VERIFIED');}
          else if(path==='/api/hedge-preview')return reply(200,await engine.previewManualHedge());
          else if(path==='/api/hedge-lock'){await engine.manualHedge(body.confirmation,body.expectedPositions);record('FUTURES_MANUAL_HEDGE_LOCK_REVIEWED');}
          else if(path==='/api/hedge-unlock'){await engine.clearManualHedgeLock(body.confirmation);record('FUTURES_MANUAL_HEDGE_LOCK_RELEASED');}
          else if(path==='/api/add-margin'){await engine.addIsolatedMargin({confirmation:body.confirmation,direction:body.direction,amount:body.amount});record('FUTURES_MANUAL_MARGIN_ADDITION_VERIFIED');}
          else if(path==='/api/auto-margin-start'){await engine.armAutoMargin(body.confirmation);nextCheck=now();record('JSON_AUTO_MARGIN_ARMED_BY_USER');}
          else if(path==='/api/margin-policy'){
            if(engine.running||engine.autoMarginArmed||engine.state?.pending)throw new Error('STOP_AND_RECONCILE_BEFORE_AUTO_MARGIN');const policy=body.text?parseMarginPolicy(body.text):null,updated=validateSettings({...settings,externalMarginPolicy:policy});await loadVault(vaultPath,body.password);
            if(policy&&engine.state)await engine.commit(registerMarginPolicy(engine.state,policy));await saveVault(vaultPath,{credentials:secret,settings:updated,preferences:prefs},body.password);engine.settings=settings=updated;record(policy?'JSON_AUTO_MARGIN_POLICY_IMPORTED':'JSON_AUTO_MARGIN_POLICY_REMOVED');
          }
          else if(path==='/api/settings'){
            const saved=await loadVault(vaultPath,body.password),data={credentials:saved.credentials,settings:validateSettings(body.settings),preferences:preferences(body.preferences)};await replace(data);try{await saveVault(vaultPath,data,body.password);}catch(e){prefs.autoConnect=false;throw e;}nextCheck=prefs.autoConnect?now():Infinity;record('FUTURES_LOCAL_SETTINGS_UPDATED');
          }else if(path==='/api/strategy'){
            if(engine.running||engine.autoMarginArmed||engine.state?.pending||ownedPositions(engine.state).length)throw new Error('FLAT_STOPPED_RECONCILED_FUTURES_PROFILE_REQUIRED');
            const external=body.text?parseFuturesStrategy(body.text):null,updated=validateSettings({...settings,externalStrategy:external});await loadVault(vaultPath,body.password);await saveVault(vaultPath,{credentials:secret,settings:updated,preferences:prefs},body.password);engine.settings=settings=updated;record(external?'FUTURES_EXTERNAL_STRATEGY_IMPORTED':'FUTURES_BUILT_IN_STRATEGY_RESTORED');
          }else throw new Error('UNKNOWN_FUTURES_ACTION');
        }
        return reply(200,status());
      }finally{actionBusy=false;}
    }catch(error){record('FUTURES_ACTION_FAILED',safeError(error));return reply(400,{error:safeError(error)});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.maxHeadersCount=40;
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',ok);});origin='http://127.0.0.1:'+server.address().port;
  const timer=setInterval(()=>monitor().catch(()=>{}),pollMs);timer.unref();
  return {server,url:origin+'/#'+token,status,monitor,stop(){engine?.stop();record('FUTURES_MANUAL_STOP');},async close(){closing=true;clearInterval(timer);engine?.stop();await new Promise(ok=>server.close(ok));while(actionBusy||engine?.busy)await new Promise(ok=>setTimeout(ok,50));await engine?.close();}};
}
