'use strict';
const $=id=>document.getElementById(id),token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
let current=null,privatePem='',external=null,externalMargin=null,hedgePreview=null,actionNotice=null,busy=false,editing=false;
let editRevision=0;
const titles={workspace:'合约总览 / Workspace',setup:'账户与合约 / Connection & risk',edition:'版本与授权 / Edition',logs:'运行记录 / Activity',help:'使用说明 / Help'};
const messages={EXPLICIT_FUTURES_START_REQUIRED:'请完整输入 START REAL FUTURES TRADING。',EXPLICIT_MARGIN_AND_LEVERAGE_CONFIRMATION_REQUIRED:'请完整输入 APPLY FUTURES SETTINGS。',SAVE_OR_UNLOCK_FUTURES_CONFIGURATION:'请先保存或解锁本机配置。',MATCHING_FUTURES_VAULT_PASSWORDS_REQUIRED:'首次保存的两次密码须一致，且至少 12 字符。',DAILY_USDT_EQUITY_LOSS_20_PERCENT:'当日回撤超过 20%，当天停止新增仓位。',CONTRACT_MARGIN_OR_LEVERAGE_SETTINGS_DIFFER:'本机选择与币安实际保证金模式或杠杆不同，请先空仓核对后应用。',APPLY_SELECTED_CONTRACT_SETTINGS_FIRST:'请先核对并应用所选的保证金模式和杠杆。',FLAT_STOPPED_RECONCILED_FUTURES_PROFILE_REQUIRED:'请先停止策略，确认空仓且没有待核对的委托。',UNMANAGED_OR_CHANGED_FUTURES_POSITION:'发现外部持仓或仓位变化。若要保留其他合约的手动仓，请在「账户与合约」选择其他合约并开启持仓共存。程序仓位数量有变化时，请先到币安核对。',FUTURES_POSITION_DIFFERS_FROM_OWNED_LEDGER:'币安持仓与本机记录不一致。请到币安核对，保留本机记录。',EXCHANGE_PROTECTION_QUERY_UNAVAILABLE:'当前账户的条件止损查询未通过；保持停止，不能开仓。',EXCHANGE_PROTECTION_QUERY_NOT_VERIFIED:'无法确认交易所止损查询能力，不能开仓。',FUTURES_WALLET_DIFFERS_FROM_LEDGER:'钱包变化与本程序账本不一致，请核对外部交易、转账和费用。',FUTURES_READ_ONLY_RECONNECT_WAIT:'连接中断，正在只读重试；不会自动恢复交易。',CLOSED_POSITION_REENTRY_COOLDOWN:'平仓后等待至少一分钟再开新仓。',HOURLY_FUTURES_ENTRY_LIMIT:'已达到每小时六次新开仓的限制。',ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED:'请先在币安关闭本合约的逐仓自动追加保证金。',FUTURES_ACTION_IN_PROGRESS:'正在处理上一项操作，请稍候。',STANDARD_SINGLE_ASSET_FUTURES_MODE_REQUIRED:'请核对币安标准合约账户的资产模式。'};
const message=code=>messages[code]??code??'—';
const num=(value,digits=4)=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:digits});
const when=value=>value?new Date(value).toLocaleString(): '—';
function showTab(tab){document.querySelectorAll('[data-view]').forEach(node=>{node.hidden=node.dataset.view!==tab;});document.querySelectorAll('[data-tab]').forEach(node=>node.classList.toggle('active',node.dataset.tab===tab));$('page-title').textContent=titles[tab];}
document.querySelectorAll('[data-tab],[data-open]').forEach(node=>node.addEventListener('click',()=>showTab(node.dataset.tab??node.dataset.open)));
async function api(path,body){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'x-asbf-session':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(value.error??'FUTURES_ACTION_FAILED');return value;}
function formSettings(){return {market:$('market').value,assetMode:$('asset-mode').value,symbol:$('symbol').value.trim().toUpperCase(),marginMode:$('margin-mode').value,leverage:Number($('leverage').value),marginPercent:Number($('percent').value),directionMode:$('direction').value,dailyLossPercent:20,externalStrategy:external,positionPolicy:$('position-policy').value,externalPositionPolicy:$('external-position-policy').value,externalMarginPolicy:externalMargin};}
function formCredentials(){const pem=$('pem').value.trim()||privatePem;return {apiKey:$('key').value.trim(),...($('secret').value?{apiSecret:$('secret').value.trim()}:{privateKeyPem:pem})};}
function savedForm(){return {password:$('password').value,settings:formSettings(),preferences:{autoConnect:$('auto-connect').checked}};}
function settlementLabel(mode){return mode==='CROSSED'?'全仓':mode==='ISOLATED'?'逐仓':'—';}
function contractLabel(settings){return settings.symbol+' · '+settlementLabel(settings.marginMode)+' · '+settings.leverage+'×';}
function settingsLabel(settings){
  return contractLabel(settings)+' · 每笔 '+settings.marginPercent+'%';
}
function inputError(){
  const {marginPercent,leverage}=formSettings();
  if(!Number.isFinite(marginPercent)||marginPercent<0.01||marginPercent>100||!/^\d+(?:\.\d{1,12})?$/.test(String(marginPercent)))return message('INVALID_FUTURES_MARGIN_PERCENT');
  if(!Number.isInteger(leverage)||leverage<1||leverage>1000)return '请填写 1–1000 之间的整数杠杆，实际可用上限取决于此合约的币安档位。';
  return '';
}
function showSettings(state){
  const saved=state.settings, snapshot=state.snapshot;
  $('saved-settings').textContent=saved?settingsLabel(saved):state.vaultExists?'等待解锁':'尚未保存';
  $('actual-settings').textContent=snapshot?.configuration?
    snapshot.symbol+' · '+settlementLabel(snapshot.configuration.marginMode)+' · '+snapshot.configuration.leverage+'× · '+(snapshot.hedge?'双向':'单向'):'尚待只读核对';
  const draft=formSettings();
  const text=editing?'尚未保存 · '+(inputError()||settingsLabel(draft)):saved?'本机已保存 · '+settingsLabel(saved):'首次配置后请保存到本机。';
  if($('form-status').textContent!==text)$('form-status').textContent=text;
}
const lastTables=new Map();
function table(id,rows){
  const serialized=JSON.stringify(rows);
  if(lastTables.get(id)===serialized)return;
  const fragment=document.createDocumentFragment();
  for(const values of rows){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value??'—';tr.append(td);}fragment.append(tr);}
  $(id).replaceChildren(fragment);
  lastTables.set(id,serialized);
}
function chart(rows){const data=(rows??[]).slice(-60),points=data.map(row=>Number(Array.isArray(row)?row[4]:row.close));if(points.length<2||points.some(p=>!Number.isFinite(p))){$('chart-line').setAttribute('d','');return;}const min=Math.min(...points),span=Math.max(...points)-min||Math.max(min*.001,1);$('chart-line').setAttribute('d',points.map((price,i)=>(i?'L':'M')+(10+i*780/(points.length-1)).toFixed(2)+','+(230-(price-min)*210/span).toFixed(2)).join(' '));}
function startRequirement(state,owned){
  const snapshot=state.snapshot;
  if(state.tradingAuthorized===false)return '请先验证软件许可证。';
  if(!state.unlocked)return '请先解锁账户配置。';
  if(editing)return '配置有未保存的修改，请先保存再核对。';
  if(!state.connected||!snapshot)return '请先完成只读核对。';
  if(state.pending)return '有待核对委托，请先核对。';
  if(snapshot.hedgeLock?.active)return message('MANUAL_HEDGE_LOCK_STRATEGY_PAUSED');
  if(snapshot.actualConfigurationMatches===false)return message('APPLY_SELECTED_CONTRACT_SETTINGS_FIRST');
  if(state.settings?.positionPolicy==='hedge'&&!snapshot.hedge)return message('ENABLE_EXCHANGE_HEDGE_MODE_FIRST');
  if(snapshot.configuration?.marginMode==='ISOLATED'&&snapshot.configuration.autoAddMargin===true)return message('ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED');
  if(snapshot.day?.blocked&&!owned.length)return message(snapshot.day.reason??'DAILY_USDT_EQUITY_LOSS_20_PERCENT');
  if($('confirmation').value!=='START REAL FUTURES TRADING')return '每次启动都需重新输入 START REAL FUTURES TRADING。';
  return '';
}
function render(state){
  current=state;const s=state.snapshot,p=s?.position,plan=s?.plan,owned=Object.values(s?.positions??{}).filter(Boolean);
  renderCheck(state);
  $('running').textContent=state.running?'自动交易运行中 / Running':state.autoMarginArmed?'仅 JSON 自动追加已启用':state.unlocked?'已解锁 · 自动化已停止':'待解锁或配置';
  $('notice').textContent=actionNotice??(state.error?message(state.error):state.reconnecting?'正在只读重连；恢复后需亲自重新启动。':state.connected?'账户已只读核对。启动策略将使用真实资金；停止后交易所已接受的止损仍保留。':'先配置本人合约账户并只读核对，保存配置不会开始交易。');
  $('connection-state').textContent=state.connected?'已连接 / Connected':state.reconnecting?'只读重连':'未连接';
  const startReason=startRequirement(state,owned);
  $('start').disabled=busy||state.running||!!startReason;
  $('start-help').textContent=state.running?'策略正在运行。':startReason;
  $('close-position').disabled=busy||!state.connected||!p||state.pending||$('confirmation').value!=='START REAL FUTURES TRADING';
  for(const id of ['check','reconcile','history','review','apply-settings','strategy-file','reset-strategy','lock'])$(id).disabled=busy||!state.unlocked;
  const applyReason=!state.unlocked||!state.settings?'请先解锁或首次保存。':editing?'有未保存修改，先点「保存修改后的本机配置」。':state.running||state.autoMarginArmed||state.pending||owned.length?'先停止策略和自动追加，核对所选合约空仓且无待处理委托。':$('settings-confirmation').value!=='APPLY FUTURES SETTINGS'?'请输入 APPLY FUTURES SETTINGS，再点下方按钮。':'即将应用到币安 · '+contractLabel(state.settings);
  $('contract-settings').disabled=busy||!state.unlocked||editing||state.running||state.autoMarginArmed||state.pending||owned.length>0||$('settings-confirmation').value!=='APPLY FUTURES SETTINGS';
  $('apply-help').textContent=applyReason;
  $('equity').textContent=num(s?.equityUsdt);$('pnl').textContent=s?.day?.baselineUsdt!=null?num(Number(s.equityUsdt)-Number(s.day.baselineUsdt)):'—';$('loss').textContent=Number.isFinite(s?.lossPercent)?num(Math.max(0,s.lossPercent),2)+'%':'—';$('count').textContent=String(s?.realOrderCount??0);
  $('chart-symbol').textContent=s?s.symbol+' · '+(s.market==='USD_M'?'U 本位':'币本位'):'等待行情';$('mark-price').textContent=num(s?.markPrice,8);$('funding').textContent=s?.fundingRate!==null&&s?.fundingRate!==undefined?num(Number(s.fundingRate)*100,6)+'%':'—';$('funding-time').textContent=when(s?.nextFundingTime);chart(s?.candles);
  $('chart-note').textContent=s?'已收盘的一分钟行情；权益与持仓以账户核对结果为准。':'只显示实际合约行情。';
  $('position').textContent=owned.length===2?`同时持有多空两边：LONG ${s.positions.LONG.quantity} / SHORT ${s.positions.SHORT.quantity}`:p?`${p.direction==='LONG'?'多仓 / Long':'空仓方向 / Short'} · ${p.symbol} · ${p.quantity} · 入场 ${p.entryPrice}`:(state.connected?'本程序在该合约空仓':'等待核对本程序持仓');$('liquidation').textContent=num(s?.liquidationPrice,8);
  $('protection').textContent=s?.protection?`交易所止损已核对 · ${s.protection.triggerPrice} · ${s.protection.status}`:p?'持仓尚无已确认的交易所止损，请立即核对。':'无程序持仓止损';
  $('signal').textContent=s?.signal?`${s.signal.intent??'等待 / Wait'} · ${s.signal.reason??''}`:'等待核对';$('blocker').textContent=s?.blocker?'本次委托等待 · '+message(s.blocker):'';
  $('planned-margin').textContent=plan?.allocation?`${plan.allocation.initialMargin} ${s.marginAsset}（预算 ${plan.allocation.targetMarginUsdt} USDT）`:'—';$('planned-notional').textContent=plan?.allocation?`${plan.allocation.notionalUsdt} USDT`:'—';$('planned-fees').textContent=plan?.allocation?`${plan.allocation.reservedRoundTripFees} ${s.marginAsset}`:'—';
  showSettings(state);
  $('strategy').textContent=state.settings?.externalStrategy?.name??'内置双向 EMA / RSI / ATR';
  renderHedgeAndMargin(state);table('orders',(s?.orders??[]).toReversed().map(row=>[when(row.time),row.market+' / '+row.symbol,row.intent,row.quantity,row.positionSide,row.status]));table('activity',(state.logs??[]).toReversed().map(row=>[when(row.time),row.event,message(row.code)]));
  $('last-updated').textContent=s?'最近核对 '+when(s.checkedAt):'本机运行 · 尚未核对';
}
function fillSettings(state){if(!state.settings)return;const s=state.settings;external=s.externalStrategy;externalMargin=s.externalMarginPolicy??null;for(const [id,value] of Object.entries({market:s.market,symbol:s.symbol,'asset-mode':s.assetMode??'single','margin-mode':s.marginMode,leverage:s.leverage,percent:s.marginPercent,direction:s.directionMode,'position-policy':s.positionPolicy??'single','external-position-policy':s.externalPositionPolicy??'block'}))$(id).value=value;$('auto-connect').checked=state.preferences.autoConnect;updateAssetModeForm();editing=false;}
const saveFeedback=document.createElement('p');
let checking=false,checkNotice='';
const marketNames={USD_M:'U 本位',COIN_M:'币本位'};
const queryNames={time:'服务器时间',balances:'钱包余额',account:'账户资料',accountConfig:'账户权限与模式',multiAssets:'保证金资产模式',positionMode:'单向或双向持仓模式',positions:'持仓',openOrders:'未成交委托',openAlgos:'未触发条件单',catalog:'合约目录',brackets:'杠杆档位',fees:'手续费',symbolConfig:'合约设置',income:'资金流水',mark:'标记价格',candles:'行情',book:'盘口'};
function updateAssetModeForm(){
  const usd=$('market').value==='USD_M',multi=usd&&$('asset-mode').value==='multi';
  $('asset-mode-field').hidden=!usd;
  $('asset-mode-guide').hidden=!usd;
  $('margin-mode').querySelector('option[value="ISOLATED"]').disabled=multi;
  if(multi)$('margin-mode').value='CROSSED';
}
$('asset-mode').addEventListener('change',()=>{updateAssetModeForm();markEditing();});
function capacityText(capacity){
  if(!capacity)return '';
  const value=num(capacity.availableUsdt,8);
  return '扣除持仓和挂单占用后的可用保证金'+(capacity.mode==='multi'?'（联合账户折合）':'')+'：'+value+' USDT';
}
const walletDecimals=new Map([4,8].map(digits=>[digits,new Intl.NumberFormat('en-US',{useGrouping:false,minimumFractionDigits:digits,maximumFractionDigits:digits})]));
function walletMoney(value,digits=8){
  if(value==null||value===''||!Number.isFinite(Number(value)))return '—';
  const amount=Number(value),minimum=10**-digits;
  if(amount>0&&amount<minimum)return '< '+walletDecimals.get(digits).format(minimum);
  if(amount<0&&amount>-minimum)return '> -'+walletDecimals.get(digits).format(minimum);
  return walletDecimals.get(digits).format(amount);
}
function setWalletText(node,value){if(node.textContent!==value)node.textContent=value;}
function walletTime(timestamp){
  if(!timestamp)return '—';
  const date=new Date(timestamp);
  if(!Number.isFinite(date.getTime()))return '—';
  const pad=value=>String(value).padStart(2,'0');
  return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+' '+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());
}
function walletRows(body,rows,rowTag,cellTag){
  const existing=new Map(Array.from(body.children,node=>[node.dataset.key,node]));
  rows.forEach(([key,values],index)=>{
    let node=existing.get(key);
    if(!node){
      node=document.createElement(rowTag);
      node.dataset.key=key;
      for(const _ of values)node.append(document.createElement(cellTag));
    }
    values.forEach((value,i)=>setWalletText(node.children[i],value));
    if(node!==body.children[index])body.insertBefore(node,body.children[index]??null);
    existing.delete(key);
  });
  for(const node of existing.values())node.remove();
}
function renderCheck(state){
  const wallet=state.walletRead,modes=state.accountModes??{},capacity=state.marginCapacity,snapshot=state.snapshot,settings=state.settings;
  const verified=state.connected&&snapshot,available=capacity?.availableUsdt;
  const status=!state.unlocked?(state.vaultExists?'等待解锁':'等待配置'):state.error?'核对未通过':checking?'正在核对':verified?(snapshot.actualConfigurationMatches===false?'设置待应用':'账户已核对'):state.checking?'正在核对':'等待只读核对';
  setWalletText($('wallet-status'),status);
  setWalletText($('wallet-available-brief'),available==null?'—':walletMoney(available,4)+' USDT');
  let alert=verified?'':checkNotice||'';
  if(state.error){
    const issue=state.readFailure;
    const label=issue?[marketNames[issue.market],queryNames[issue.operation]??issue.operation].filter(Boolean).join(' · '):'';
    const code=issue?.binanceCode!=null?'币安 '+issue.binanceCode:issue?.httpStatus?'HTTP '+issue.httpStatus:'';
    alert=[label,message(state.error),code].filter(Boolean).join(' · ');
  }else if(settings?.market==='USD_M'&&capacity?.mode&&capacity.mode!==settings.assetMode){
    alert='本机与币安的保证金资产模式不同，请到「账户与合约」核对。';
  }else if(verified&&snapshot.actualConfigurationMatches===false){
    alert='请核对本机目标和币安实际模式、杠杆。';
  }
  setWalletText($('wallet-alert'),alert);
  $('wallet-alert').hidden=!alert;
  setWalletText($('wallet-asset-mode'),typeof modes.multiAssets==='boolean'?(modes.multiAssets?'多资产':'单资产'):'—');
  setWalletText($('wallet-position-mode'),typeof modes.hedge==='boolean'?(modes.hedge?'双向':'单向'):'—');
  setWalletText($('wallet-read-time'),walletTime(wallet?.time));
  setWalletText($('wallet-check-time'),walletTime(snapshot?.checkedAt));
  const balances=(wallet?.amounts??[]).map(row=>[row.asset,[walletMoney(row.balance),row.asset]]).sort(([a],[b])=>a.localeCompare(b));
  walletRows($('wallet-balances'),balances,'li','span');
  $('wallet-balances-empty').hidden=balances.length>0;
  setWalletText($('wallet-balances-empty'),wallet?'无非零余额':'—');
  setWalletText($('wallet-available'),available==null?'—':walletMoney(available)+' USDT');
  let budget=null;
  if(verified&&settings&&available!=null&&snapshot.equityUsdt!=null){
    const equity=Number(snapshot.equityUsdt);
    const basis=capacity.mode==='multi'?Math.min(equity,Number(capacity.poolEquityUsdt)):equity;
    const capped=Math.min(Number(available),Math.max(0,basis)*settings.marginPercent/100);
    if(Number.isFinite(capped))budget=capped;
  }
  setWalletText($('wallet-budget'),budget==null?'—':walletMoney(budget)+' USDT');
  const limits=snapshot?.contractConstraints;
  const quantityUnit=limits?.quantityUnit==='contracts'?'张':limits?.quantityUnit;
  setWalletText($('wallet-min-quantity'),limits?.minimumQuantity!=null&&quantityUnit?limits.minimumQuantity+' '+quantityUnit:'—');
  setWalletText($('wallet-step-size'),limits?.stepSize!=null&&quantityUnit?limits.stepSize+' '+quantityUnit:'—');
  setWalletText($('wallet-min-notional'),limits?.minimumNotional!=null&&limits.quoteAsset?limits.minimumNotional+' '+limits.quoteAsset:'—');
  const exposure=state.externalExposure;
  const positions=(exposure?.positions??[]).map(row=>[row.market+'|'+row.symbol+'|'+row.direction,[
    row.symbol+' · '+(marketNames[row.market]??row.market),row.direction==='LONG'?'多':row.direction==='SHORT'?'空':'—',
    row.quantity==null?'—':String(row.quantity)
  ]]).sort(([a],[b])=>a.localeCompare(b));
  walletRows($('wallet-positions'),positions,'tr','td');
  setWalletText($('wallet-external-count'),exposure?String(positions.length):'—');
  $('wallet-positions-table').hidden=!positions.length;
  $('wallet-positions-empty').hidden=!!positions.length;
  setWalletText($('wallet-positions-empty'),exposure?'无外部持仓':'尚未核对');
  setWalletText($('wallet-open-orders'),String(exposure?.openOrderCount??'—'));
  setWalletText($('wallet-conditional-orders'),String(exposure?.conditionalOrderCount??'—'));
}
saveFeedback.setAttribute('role','status');
saveFeedback.hidden=true;
$('save').parentElement.after(saveFeedback);
function reportSave(text){
  saveFeedback.hidden=false;
  saveFeedback.textContent=text;
}
async function act(name,body={},after){
  const saving=name==='save';
  const localSave=saving||name==='settings';
  if(busy){
    if(localSave)reportSave('正在处理上一项操作，本次修改还未保存。');
    return;
  }
  if(localSave){
    const problem=inputError();
    if(problem){
      actionNotice='保存未完成 · '+problem;
      reportSave(actionNotice);$('notice').textContent=actionNotice;
      return;
    }
  }
  busy=true;actionNotice=null;
  const revisionAtSubmit=editRevision;
  if(name==='check'){checking=true;checkNotice='';}
  try{
    if(saving){reportSave('正在加密保存到本机…');$('save').disabled=true;}
    if(current)render(current);
    const state=await api(name,body);
    if(state.version){
      render(state);
      if((localSave||name==='unlock')&&revisionAtSubmit===editRevision)fillSettings(state);
      if(name==='strategy')external=state.settings.externalStrategy;
      if(name==='margin-policy')externalMargin=state.settings.externalMarginPolicy??null;
    }
    if(after)await after(state);
    if(localSave){
      actionNotice='本机已保存 · '+settingsLabel(state.settings)+(revisionAtSubmit===editRevision?'。请做只读核对，查看币安实际设置。':'。提交后输入的修改尚未保存。');
      reportSave(actionNotice);$('notice').textContent=actionNotice;
    }
  }catch(error){
    actionNotice=(localSave?'保存未完成 · ':'')+message(error.message);
    $('notice').textContent=actionNotice;
    if(saving||name==='settings')reportSave(actionNotice);
    if(error.message==='FUTURES_SETTINGS_NOT_SAVED_UNLOCK_PREVIOUS'){
      try{render(await api('status'));}catch{/* The save error stays visible if the local service also stopped. */}
    }
    if(name==='check'){
      checkNotice=actionNotice;
      try{render(await api('status'));}catch{checkNotice='本机合约服务未响应，请重新打开软件。';}
    }
  }finally{
    busy=false;
    if(name==='check')checking=false;
    if(saving)$('save').disabled=false;
    if(current)renderButtons();
  }
}
function renderButtons(){const notice=$('notice').textContent;render(current);$('notice').textContent=notice;}
function markEditing(){
  editRevision++;
  const saved=current?.settings,draft=formSettings();
  editing=!saved||['market','symbol','marginMode','marginPercent','leverage','directionMode'].some(key=>draft[key]!==saved[key])
    ||draft.assetMode!==(saved.assetMode??'single')||draft.positionPolicy!==(saved.positionPolicy??'single')
    ||draft.externalPositionPolicy!==(saved.externalPositionPolicy??'block')||$('auto-connect').checked!==current.preferences.autoConnect;
  actionNotice=null;
  $('settings-confirmation').value='';
  saveFeedback.hidden=true;
  if(current)render(current);
}
for(const id of ['market','symbol','asset-mode','margin-mode','leverage','percent','direction','position-policy','external-position-policy','auto-connect'])$(id).addEventListener('input',markEditing);
$('confirmation').addEventListener('input',()=>{if(current)renderButtons();});
$('settings-confirmation').addEventListener('input',()=>{if(current)renderButtons();});
$('market').addEventListener('change',()=>{updateAssetModeForm();$('symbol').value=$('market').value==='USD_M'?'BTCUSDT':'BTCUSD_PERP';$('leverage').value='';$('preflight-result').textContent='合约类型已变，请重新读取设置。';$('symbols').replaceChildren();markEditing();});
$('pem-file').addEventListener('change',async()=>{const f=$('pem-file').files[0];if(!f)return;if(f.size>16384)return void($('notice').textContent='PEM 文件过大。');privatePem=await f.text();$('secret').value='';$('notice').textContent='RSA PEM 已在内存中准备，保存后加密到本机。';});
$('generate').onclick=()=>act('generate-key',{password:$('password').value},value=>{privatePem=value.privateKeyPem;$('secret').value='';$('public-key').textContent=value.publicKey;$('public-key').hidden=false;$('copy-public').hidden=false;$('notice').textContent=value.reused?'已找回同一 RSA 公钥。':'已生成 RSA 公钥，请在币安注册；私钥已加密保存。';});
$('copy-public').onclick=async()=>{try{await navigator.clipboard.writeText($('public-key').textContent);$('notice').textContent='公钥已复制。';}catch{$('notice').textContent='请选中并复制下方公钥。';}};
$('preflight').onclick=()=>act('preflight',{password:$('password').value,market:$('market').value,symbol:$('symbol').value.trim().toUpperCase(),...($('key').value?{credentials:formCredentials()}:{})},value=>{
  if($('market').value!==value.market||$('symbol').value.trim().toUpperCase()!==value.symbol)return;
  if(!$('leverage').value){
    $('leverage').value=value.configuration.leverage;
    markEditing();
  }
  $('preflight-result').textContent='币安实际 · '+contractLabel({symbol:value.symbol,...value.configuration})+'。'+capacityText(value.marginCapacity);
});
$('catalog').onclick=()=>act('catalog',{market:$('market').value},value=>{$('symbols').replaceChildren(...value.symbols.map(row=>{const option=document.createElement('option');option.value=row.symbol;option.label=row.marginAsset;return option;}));$('notice').textContent=`已读取 ${value.symbols.length} 个可用永续合约，请在合约输入栏选择。`;});
$('save').onclick=()=>act('save',{...savedForm(),passwordRepeat:$('password-repeat').value,credentials:formCredentials()},()=>{$('key').value='';$('secret').value='';$('pem').value='';privatePem='';showTab('workspace');});
$('unlock').onclick=()=>act('unlock',{password:$('password').value},()=>showTab('workspace'));
$('lock').onclick=()=>act('lock',{},()=>{$('password').value='';$('password-repeat').value='';privatePem='';$('pem').value='';$('public-key').hidden=true;});
$('apply-settings').onclick=()=>act('settings',savedForm());
$('contract-settings').onclick=()=>{
  if(editing){$('apply-help').textContent='请先保存修改后的本机配置，再重新输入确认文字。';return;}
  return act('contract-settings',{confirmation:$('settings-confirmation').value},state=>{
    $('settings-confirmation').value='';
    if(state.snapshot?.actualConfigurationMatches)actionNotice='币安已核实 · '+contractLabel({symbol:state.snapshot.symbol,...state.snapshot.configuration});
  });
};
$('start').onclick=()=>{if(editing){$('notice').textContent='配置表有未保存修改，请先保存本机配置并只读核对。';return;}act('start',{confirmation:$('confirmation').value},()=>{$('confirmation').value='';});};
$('stop').onclick=async()=>{try{const state=await api('stop',{});$('confirmation').value='';actionNotice=null;render(state);}catch(error){$('notice').textContent=message(error.message);}};
$('close-position').onclick=()=>act('close-position',{confirmation:$('confirmation').value},()=>{$('confirmation').value='';});
$('check').onclick=()=>act('check');$('reconcile').onclick=()=>act('reconcile');
$('strategy-file').onchange=async()=>{const f=$('strategy-file').files[0];if(!f)return;if(f.size>16384){$('notice').textContent='合约策略 JSON 须小于 16KB。';return;}await act('strategy',{text:await f.text(),password:$('password').value});$('strategy-file').value='';};
$('reset-strategy').onclick=()=>act('strategy',{text:'',password:$('password').value});
async function download(path,name){try{const response=await fetch('/api/'+path,{headers:{'x-asbf-session':token}});if(!response.ok){const value=await response.json();throw new Error(value.error);}const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){$('notice').textContent=message(error.message);}}
$('history').onclick=()=>download('history','AdaptiveFuturesBot-Orders.csv');$('review').onclick=()=>download('review','AdaptiveFuturesBot-Review.md');
async function refresh(){if(busy)return;try{const state=await api('status');if(state.unlocked&&!current?.unlocked&&!editing)fillSettings(state);render(state);}catch{$('connection-state').textContent='本机服务未连接';$('start').disabled=true;$('close-position').disabled=true;}}

Object.assign(messages,{
  MANUAL_POSITION_ON_SELECTED_CONTRACT:'所选合约已有程序以外的持仓。若要保留手动仓，请为机器人选择另一份合约，保存后重新做只读核对。双向持仓也须分开合约。',
  UNMANAGED_ORDER_ON_SELECTED_CONTRACT:'所选合约有程序以外的委托。请到币安核对普通和条件委托，或为机器人选择一份没有外部仓位与委托的合约。',
  UNIDENTIFIED_EXTERNAL_FUTURES_EXPOSURE:'有持仓或委托无法确认所属合约，已暂停。请在币安检查两个合约钱包的持仓和挂单，再重新核对。',
  ACCOUNT_MODE_CHANGE_REQUIRES_NO_EXTERNAL_EXPOSURE:'账户还有其他合约的持仓或委托，无法切换账户模式。要保留手动仓，请沿用币安当前账户模式。',
  EXTERNAL_BOT_ORDER_REQUIRES_REVIEW:'在其他合约发现带有程序标识的委托，归属待核对。请到币安检查挂单和条件单，并保留本机记录。',
  EXTERNAL_MIDNIGHT_HISTORY_UNVERIFIED:'有其他合约持仓，无法核实零点的账户权益。当天风险基准待核对，已暂停新增仓位。',
  INVALID_SETTLEMENT_ASSET:'交易所钱包返回了当前版本无法识别的资产代码，完整核对已停止。',
  INVALID_USD_M_ASSET_MODE:'请选择单资产或多资产。',
  ASSET_MODE_PREFERENCE_MISMATCH:'本机所选资产模式与币安不同。请到账户与合约核对选择并保存。',
  MULTI_ASSETS_REQUIRES_CROSS:'联合保证金模式需要全仓。',
  MARGIN_CAPACITY_UNVERIFIED:'未取得有效的可用保证金或账户权益，无法计算开仓额度。',
  MARGIN_CONVERSION_INDEX_UNVERIFIED:'用于折算保证金的币安指数缺失或过期，请重新只读核对。',
  MARGIN_BUDGET_BELOW_CONTRACT_MINIMUM_OR_FILTER:'本次预算不足以满足币安最小下单数量或金额。可在钱包详情查看所选合约的限制。',
  USD_M_ASSET_MODE_UNVERIFIED:'币安尚未返回可确认的资产模式，策略保持停止。',
  USD_M_POSITION_MODE_UNVERIFIED:'币安尚未返回可确认的单向或双向持仓模式。',
  FUTURES_QUERY_REJECTED:'币安拒绝了这项查询',
  FUTURES_CONNECTION_FAILED:'未收到币安回复',
  FUTURES_SERVICE_BLOCKED:'此连接已因币安先前拒绝请求而暂停',
  FUTURES_SERVICE_REFUSED_OR_RATE_LIMITED:'币安拒绝访问或限制了请求频率',
  TRADABLE_FUTURES_ACCOUNTS_REQUIRED:'未确认合约账户交易权限',
  BOTH_FUTURES_WALLETS_MUST_BE_READABLE:'未能同时核对 U 本位和币本位钱包',
  STABLE_FUTURES_ACCOUNT_IDENTITY_REQUIRED:'钱包返回的数据不足以确认账户身份',
  POSITIVE_FUTURES_CAPITAL_REQUIRED:'两类合约钱包折算后的初始权益须大于零',
  FUTURES_FIRST_SAVE_REQUIRED:'本机尚无合约配置。请在“账户与合约”下方点“首次保存加密配置”。',
  FUTURES_API_KEY_REQUIRED:'请先填入与本机签名密钥配套的币安合约 API Key。',
  ONE_FUTURES_SIGNATURE_METHOD_REQUIRED:'请选择配套的 RSA 私钥，或填写配套的 HMAC Secret。',
  VAULT_PASSWORD_OR_DATA_INVALID:'本机密码无法打开这份加密文件。请核对创建它时用的密码。',
  INVALID_FUTURES_MARGIN_PERCENT:'每笔初始保证金须为权益的 0.01% 至 100%，最多 12 位小数。',
  EXPLICIT_FUTURES_MARGIN_LEVERAGE_AND_RISK_REQUIRED:'请核对合约类型、保证金模式和杠杆。杠杆须为 1–1000 的整数，实际可用上限取决于该合约的币安档位。',
  SELECTED_LEVERAGE_EXCEEDS_ACCOUNT_BRACKET:'所填杠杆超过币安对该合约及仓位档位的上限。请降低杠杆后保存，再应用到币安。',
  FLAT_STOPPED_ACCOUNT_REQUIRED_FOR_SETTINGS:'请先停止策略，并核对所选合约空仓且无待处理委托。',
  CONTRACT_SETTINGS_NOT_VERIFIED:'币安尚未确认所选合约的模式或杠杆。请只读核对实际值。',
  FUTURES_SETTINGS_NOT_SAVED_UNLOCK_PREVIOUS:'写入失败。请重新解锁上次成功保存的本机配置。',
  FUTURES_START_CANCELLED:'本次启动已取消，策略已停止。',
  FUTURES_PROFILE_IN_USE:'合约配置已被占用，请检查是否同时打开了另一个实例。',
  FUTURES_VAULT_WRITE_DENIED:'Windows 拒绝写入合约配置目录。请检查目录权限或文件占用情况。',
  FUTURES_VAULT_DISK_FULL:'本机磁盘空间不足，合约配置保存失败。',
  FUTURES_RSA_OR_HMAC_REQUIRED:'该私钥类型不受合约版支持，请使用与 API Key 配套的 RSA 私钥或 HMAC Secret。',
  INVALID_FUTURES_CLIENT_OPTIONS:'请核对合约 API Key 和签名方式。这里需要币安 API Key。',
  MANUAL_HEDGE_LOCK_STRATEGY_PAUSED:'手动锁仓状态：自动交易已暂停；两侧保护仍有效。',ENABLE_EXCHANGE_HEDGE_MODE_FIRST:'请先选择双向管理，再在空仓时明确启用币安账户双向模式。',EXPLICIT_EQUAL_HEDGE_CONFIRMATION_REQUIRED:'请输入 LOCK FUTURES POSITION。',HEDGE_POSITION_CHANGED_PREVIEW_AGAIN:'仓位已变化，请重新预览后再确认锁仓。',EXPLICIT_ACCOUNT_HEDGE_MODE_CONFIRMATION_REQUIRED:'请输入 ENABLE FUTURES HEDGE MODE。',BOTH_FUTURES_WALLETS_MUST_BE_FLAT_FOR_MODE_CHANGE:'切换币安持仓模式前，两个合约钱包都需空仓且无委托。',EQUAL_HEDGE_EXCEEDS_SELECTED_MARGIN_BUDGET_OR_FILTER:'等量反向仓超过当前保证金预算或交易最小量，未擅自放大资金。',EXPLICIT_ISOLATED_MARGIN_ADDITION_REQUIRED:'请输入 ADD ISOLATED MARGIN。',POSITIVE_NATIVE_MARGIN_AMOUNT_REQUIRED:'请填写正数追加金额，单位以所选合约的保证金币种为准。',MARGIN_ADDITION_REQUIRES_ISOLATED_POSITION:'只有已核对的本程序逐仓持仓可以在此追加。',MARGIN_ADDITION_RESULT_UNRESOLVED_DO_NOT_RESUBMIT:'追加结果尚未核实。请核对原请求，不要重复追加。',AVAILABLE_COLLATERAL_INSUFFICIENT:'可用保证金不足。',FUTURES_WALLET_DIFFERS_FROM_PROGRAM_LEDGER:'钱包变化与程序账本不一致，请先核对外部交易、转账及费用。',EXPLICIT_JSON_AUTO_MARGIN_CONFIRMATION_REQUIRED:'请输入 ENABLE JSON AUTO MARGIN。',IMPORT_ENABLED_EXTERNAL_AUTO_MARGIN_POLICY_FIRST:'请先导入由你明确填写并启用的自动追加 JSON。',AUTO_MARGIN_POLICY_TARGET_MISMATCH:'JSON 的合约类型、交易对或保证金币种与当前选择不一致。',AUTO_MARGIN_REQUIRES_ISOLATED_POSITION:'JSON 自动追加仅适用于逐仓持仓。',EXCHANGE_AUTO_ADD_MARGIN_ALREADY_ENABLED:'币安原生自动追加显示已开启，不能同时启用本机 JSON 自动追加。',EXCHANGE_AUTO_ADD_MARGIN_STATUS_UNAVAILABLE:'币安没有返回可靠的原生自动追加状态，本机自动追加保持停用。',AUTO_MARGIN_NOT_ARMED:'本次尚未明确启用 JSON 自动追加。',EXTERNAL_AUTO_MARGIN_POLICY_DISABLED:'导入的 JSON 明确设置为禁用。',NO_EXTERNAL_AUTO_MARGIN_POLICY:'尚未导入自动追加 JSON。',AUTO_MARGIN_BUDGET_OR_COUNT_EXHAUSTED:'累计预算或追加次数已用完。',AUTO_MARGIN_COOLDOWN:'正在等待 JSON 规定的冷却间隔。',AUTO_MARGIN_TRIGGER_NOT_MET_OR_LIQUIDATION_UNAVAILABLE:'未达到 JSON 触发条件，或没有可靠强平价格。',AUTO_MARGIN_ACCOUNT_REVIEW_REQUIRED:'账户、委托或保护状态需要先核对。',AUTO_MARGIN_POLICY_ID_ALREADY_BOUND_TO_ANOTHER_TARGET:'该 JSON 策略 ID 已绑定其他合约或币种，请保留原预算记录并核对文件。',AUTO_MARGIN_AMOUNT_BUDGET_TRIGGER_AND_COOLDOWN_REQUIRED:'启用 JSON 需要正数单次额、足够累计预算、正数触发距离和至少 30 秒间隔。',STOP_AND_RECONCILE_BEFORE_AUTO_MARGIN:'请先停止交易与自动追加，并核对原委托。',UNLOCK_EXISTING_FUTURES_VAULT_BEFORE_EDITING:'已有加密配置，请先解锁，再保存修改。',ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED:'币安返回此合约原生自动追加已开启。普通逐仓若本来未开启，不需要额外关闭。'
});
function autoFlag(value){return value===false?'已关闭，无需额外操作':value===true?'已开启，请在币安核对':'未返回可靠状态';}
function renderHedgeAndMargin(state){
  const s=state.snapshot,positions=s?.positions??{},stops=s?.protections??{},confirmation=$('confirmation').value==='START REAL FUTURES TRADING',ready=!busy&&state.unlocked&&state.connected&&!state.pending;
  for(const [key,direction] of [['long','LONG'],['short','SHORT']]){
    const p=positions[direction],stop=stops[direction],risk=s?.configuration?.legs?.[direction];$(''+key+'-position').textContent=p?`${p.quantity} · 入场 ${p.entryPrice}`:'无持仓 / Flat';
    $(key+'-protection').textContent=p?`止损 ${stop?.triggerPrice??'尚未确认'} · 强平 ${risk?.liquidationPrice??'未返回'} · 逐仓保证金 ${risk?.isolatedWallet??'未返回'} ${s.marginAsset}`:'没有该方向的程序仓位';
    $(key+'-signal').textContent=s?.signals?.[direction]?`${s.signals[direction].intent??'等待'} · ${message(s.sideBlockers?.[direction]??s.signals[direction].reason)}`:'等待核对';$( 'close-'+key).disabled=!ready||!p||!confirmation;
  }
  const long=positions.LONG?.quantity??'0',short=positions.SHORT?.quantity??'0',count=Object.values(positions).filter(Boolean).length;
  $('hedge-coverage').textContent=s?`LONG ${long} / SHORT ${short} · ${s.hedgeLock?.active?'手动锁仓暂停中':s.positionPolicy==='hedge'?'多空独立管理':'单仓管理'}${count===2&&long===short?' · 两边数量相等':''}`:'先核对账户与仓位。';
  $('hedge-preview').disabled=!ready||!count||!s?.hedge||s?.positionPolicy!=='hedge';const same=hedgePreview&&hedgePreview.expectedPositions.LONG===long&&hedgePreview.expectedPositions.SHORT===short;
  $('hedge-lock').disabled=!ready||!same||$('hedge-confirmation').value!=='LOCK FUTURES POSITION';$('hedge-unlock').disabled=!ready||!s?.hedgeLock?.active||!confirmation;
  $('position-mode-state').textContent=s?`币安账户：${s.hedge?'双向持仓，可分别管理 LONG / SHORT':'单向持仓'}；本机选择：${state.settings?.positionPolicy==='hedge'?'允许同时多空':'单仓'}`:'尚未读取。';
  $('enable-hedge-mode').disabled=!ready||state.running||state.autoMarginArmed||count>0||s?.hedge||$('mode-confirmation').value!=='ENABLE FUTURES HEDGE MODE';
  $('exchange-auto-margin').textContent=s?`币安原生自动追加：多仓 ${autoFlag(s.configuration.legs.LONG.autoAddMargin)}；空仓 ${autoFlag(s.configuration.legs.SHORT.autoAddMargin)}。`:'币安自动追加：尚未读取。普通逐仓未开启时，无需额外关闭。';
  const direction=$('margin-side').value,position=positions[direction],leg=s?.configuration?.legs?.[direction];$('margin-asset').textContent=s?.marginAsset??'原生保证金币种';$('isolated-wallet-state').textContent=position?`${direction} · 逐仓保证金 ${leg?.isolatedWallet??'未返回'} ${s.marginAsset} · 强平价格 ${leg?.liquidationPrice??'未返回'}`:'所选方向暂无本程序持仓。';
  $('add-margin').disabled=!ready||!position||s?.configuration.marginMode!=='ISOLATED'||$('margin-confirmation').value!=='ADD ISOLATED MARGIN'||!/^\d+(\.\d{1,12})?$/.test($('margin-amount').value.trim())||Number($('margin-amount').value)<=0;
  const policy=state.settings?.externalMarginPolicy,budget=s?.autoMargin?.budget;
  $('auto-margin-state').textContent=state.autoMarginArmed?'本机 JSON 自动追加已启用，仅在本次程序运行时生效。':'本机自动追加未启用，没有内置追加规则。';
  $('auto-margin-summary').textContent=policy?`JSON ${policy.id} · ${policy.market} ${policy.symbol} · 单次 ${policy.perAdditionAmount} ${policy.asset} · 累计 ${budget?.usedAmount??'0'} / ${policy.maxTotalAmount} ${policy.asset} · 次数 ${budget?.additions??0} / ${policy.maxAdditions} · 间隔 ${policy.cooldownSeconds} 秒 · ${message(s?.autoMargin?.decision?.reason??(policy.enabled?'AUTO_MARGIN_NOT_ARMED':'EXTERNAL_AUTO_MARGIN_POLICY_DISABLED'))}`:'用户自行填写外置 JSON 的触发距离、单次金额、累计预算、次数和间隔。格式样例默认禁用、零金额。';
  $('auto-margin-start').disabled=!ready||state.running||state.autoMarginArmed||!policy?.enabled||$('auto-margin-confirmation').value!=='ENABLE JSON AUTO MARGIN';$('auto-margin-stop').disabled=!state.unlocked||!state.autoMarginArmed;
  $('margin-policy-file').disabled=busy||!state.unlocked||state.running||state.autoMarginArmed||state.pending;$('remove-margin-policy').disabled=$('margin-policy-file').disabled||!policy;
  table('margin-events',(s?.marginEvents??[]).toReversed().map(row=>[when(row.time),row.direction,row.amount,row.asset,row.policyId?'JSON '+row.policyId:'本人手动']));
}
for(const id of ['hedge-confirmation','mode-confirmation','margin-confirmation','margin-amount','margin-side','auto-margin-confirmation'])$(id).addEventListener('input',()=>{if(current)renderButtons();});
$('close-long').onclick=()=>act('close-position',{direction:'LONG',confirmation:$('confirmation').value},()=>{$('confirmation').value='';hedgePreview=null;});
$('close-short').onclick=()=>act('close-position',{direction:'SHORT',confirmation:$('confirmation').value},()=>{$('confirmation').value='';hedgePreview=null;});
$('enable-hedge-mode').onclick=()=>act('hedge-mode',{confirmation:$('mode-confirmation').value},()=>{$('mode-confirmation').value='';});
$('hedge-preview').onclick=()=>act('hedge-preview',{},async result=>{hedgePreview=result;$('hedge-preview-result').textContent=result.balanced?'两边数量已经相等，确认锁仓只会暂停自动交易。':`计划补 ${result.direction} ${result.quantity}；初始保证金 ${result.allocation.initialMargin} ${result.asset}；名义金额约 ${result.allocation.notionalUsdt} USDT。行情变化时提交前会再次核对。`;render(await api('status'));});
$('hedge-lock').onclick=()=>act('hedge-lock',{confirmation:$('hedge-confirmation').value,expectedPositions:hedgePreview?.expectedPositions},()=>{$('hedge-confirmation').value='';hedgePreview=null;});
$('hedge-unlock').onclick=()=>act('hedge-unlock',{confirmation:$('confirmation').value},()=>{$('confirmation').value='';});
$('add-margin').onclick=()=>act('add-margin',{confirmation:$('margin-confirmation').value,direction:$('margin-side').value,amount:$('margin-amount').value.trim()},()=>{$('margin-confirmation').value='';$('margin-amount').value='';});
$('margin-policy-file').onchange=async()=>{const f=$('margin-policy-file').files[0];if(!f)return;if(f.size>8192){actionNotice='自动追加 JSON 须小于 8KB。';return;}await act('margin-policy',{text:await f.text(),password:$('password').value});$('margin-policy-file').value='';};
$('remove-margin-policy').onclick=()=>act('margin-policy',{text:'',password:$('password').value});
$('auto-margin-start').onclick=()=>act('auto-margin-start',{confirmation:$('auto-margin-confirmation').value},()=>{$('auto-margin-confirmation').value='';});
$('auto-margin-stop').onclick=async()=>{try{actionNotice=null;render(await api('auto-margin-stop',{}));}catch(error){actionNotice=message(error.message);$('notice').textContent=actionNotice;}};

refresh();setInterval(refresh,2000);
