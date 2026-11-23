'use strict';
const $=id=>document.getElementById(id),token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
let current=null,privatePem='',external=null,externalMargin=null,hedgePreview=null,actionNotice=null,busy=false,editing=false;
const titles={workspace:'合约总览 / Workspace',setup:'账户与合约 / Connection & risk',edition:'版本与授权 / Edition',logs:'运行记录 / Activity',help:'使用说明 / Help'};
const messages={EXPLICIT_FUTURES_START_REQUIRED:'请完整输入 START REAL FUTURES TRADING。',EXPLICIT_MARGIN_AND_LEVERAGE_CONFIRMATION_REQUIRED:'请完整输入 APPLY FUTURES SETTINGS。',SAVE_OR_UNLOCK_FUTURES_CONFIGURATION:'请先保存或解锁本机配置。',MATCHING_FUTURES_VAULT_PASSWORDS_REQUIRED:'首次保存的两次密码须一致，且至少 12 字符。',DAILY_USDT_EQUITY_LOSS_20_PERCENT:'当日回撤超过 20%，当天停止新增仓位。',CONTRACT_MARGIN_OR_LEVERAGE_SETTINGS_DIFFER:'本机选择与币安实际保证金模式或杠杆不同，请先空仓核对后应用。',APPLY_SELECTED_CONTRACT_SETTINGS_FIRST:'请先核对并应用所选的保证金模式和杠杆。',FLAT_STOPPED_RECONCILED_FUTURES_PROFILE_REQUIRED:'请先停止策略，确认空仓且没有待核对的委托。',UNMANAGED_OR_CHANGED_FUTURES_POSITION:'发现其他持仓或仓位变化，已停止。请先到币安核对。',FUTURES_POSITION_DIFFERS_FROM_OWNED_LEDGER:'币安持仓与本机记录不一致。请到币安核对，保留本机记录。',EXCHANGE_PROTECTION_QUERY_UNAVAILABLE:'当前账户的条件止损查询未通过；保持停止，不能开仓。',EXCHANGE_PROTECTION_QUERY_NOT_VERIFIED:'无法确认交易所止损查询能力，不能开仓。',FUTURES_WALLET_DIFFERS_FROM_LEDGER:'钱包变化与本程序账本不一致，请核对外部交易、转账和费用。',FUTURES_READ_ONLY_RECONNECT_WAIT:'连接中断，正在只读重试；不会自动恢复交易。',CLOSED_POSITION_REENTRY_COOLDOWN:'平仓后等待至少一分钟再开新仓。',HOURLY_FUTURES_ENTRY_LIMIT:'已达到每小时六次新开仓的限制。',ISOLATED_AUTO_ADD_MARGIN_MUST_BE_DISABLED:'请先在币安关闭本合约的逐仓自动追加保证金。',FUTURES_ACTION_IN_PROGRESS:'正在处理上一项操作，请稍候。',STANDARD_SINGLE_ASSET_FUTURES_MODE_REQUIRED:'请核对币安标准合约账户的资产模式。'};
const message=code=>messages[code]??code??'—';
const num=(value,digits=4)=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:digits});
const when=value=>value?new Date(value).toLocaleString(): '—';
function showTab(tab){document.querySelectorAll('[data-view]').forEach(node=>{node.hidden=node.dataset.view!==tab;});document.querySelectorAll('[data-tab]').forEach(node=>node.classList.toggle('active',node.dataset.tab===tab));$('page-title').textContent=titles[tab];}
document.querySelectorAll('[data-tab],[data-open]').forEach(node=>node.addEventListener('click',()=>showTab(node.dataset.tab??node.dataset.open)));
async function api(path,body){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'x-asbf-session':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(value.error??'FUTURES_ACTION_FAILED');return value;}
function formSettings(){return {market:$('market').value,assetMode:$('asset-mode').value,symbol:$('symbol').value.trim().toUpperCase(),marginMode:$('margin-mode').value,leverage:Number($('leverage').value),marginPercent:Number($('percent').value),directionMode:$('direction').value,dailyLossPercent:20,externalStrategy:external,positionPolicy:$('position-policy').value,externalMarginPolicy:externalMargin};}
function formCredentials(){const pem=$('pem').value.trim()||privatePem;return {apiKey:$('key').value.trim(),...($('secret').value?{apiSecret:$('secret').value.trim()}:{privateKeyPem:pem})};}
function savedForm(){return {password:$('password').value,settings:formSettings(),preferences:{autoConnect:$('auto-connect').checked}};}
function table(id,rows){const target=$(id);target.replaceChildren();for(const values of rows){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value??'—';tr.append(td);}target.append(tr);}}
function chart(rows){const data=(rows??[]).slice(-60),points=data.map(row=>Number(Array.isArray(row)?row[4]:row.close));if(points.length<2||points.some(p=>!Number.isFinite(p))){$('chart-line').setAttribute('d','');return;}const min=Math.min(...points),span=Math.max(...points)-min||Math.max(min*.001,1);$('chart-line').setAttribute('d',points.map((price,i)=>(i?'L':'M')+(10+i*780/(points.length-1)).toFixed(2)+','+(230-(price-min)*210/span).toFixed(2)).join(' '));}
function render(state){
  current=state;const s=state.snapshot,p=s?.position,plan=s?.plan,owned=Object.values(s?.positions??{}).filter(Boolean);
  renderCheck(state);
  $('running').textContent=state.running?'自动交易运行中 / Running':state.autoMarginArmed?'仅 JSON 自动追加已启用':state.unlocked?'已解锁 · 自动化已停止':'待解锁或配置';
  $('notice').textContent=actionNotice??(state.error?message(state.error):state.reconnecting?'正在只读重连；恢复后需亲自重新启动。':state.connected?'账户已只读核对。启动策略将使用真实资金；停止后交易所已接受的止损仍保留。':'先配置本人合约账户并只读核对，保存配置不会开始交易。');
  $('connection-state').textContent=state.connected?'已连接 / Connected':state.reconnecting?'只读重连':'未连接';
  $('start').disabled=busy||!state.unlocked||!state.connected||state.running||state.pending||(!owned.length&&!!s?.blocker)||!!s?.hedgeLock?.active||$('confirmation').value!=='START REAL FUTURES TRADING';
  $('close-position').disabled=busy||!state.connected||!p||state.pending||$('confirmation').value!=='START REAL FUTURES TRADING';
  for(const id of ['check','reconcile','history','review','apply-settings','contract-settings','strategy-file','reset-strategy','lock'])$(id).disabled=busy||!state.unlocked;
  $('equity').textContent=num(s?.equityUsdt);$('pnl').textContent=s?num(Number(s.equityUsdt)-Number(s.day.baselineUsdt)):'—';$('loss').textContent=s?num(Math.max(0,s.lossPercent),2)+'%':'—';$('count').textContent=String(s?.realOrderCount??0);
  $('chart-symbol').textContent=s?s.symbol+' · '+(s.market==='USD_M'?'U 本位':'币本位'):'等待行情';$('mark-price').textContent=num(s?.markPrice,8);$('funding').textContent=s?.fundingRate!==null&&s?.fundingRate!==undefined?num(Number(s.fundingRate)*100,6)+'%':'—';$('funding-time').textContent=when(s?.nextFundingTime);chart(s?.candles);
  $('chart-note').textContent=s?'已收盘的一分钟行情；权益与持仓以账户核对结果为准。':'只显示实际合约行情。';
  $('position').textContent=owned.length===2?`同时持有多空两边：LONG ${s.positions.LONG.quantity} / SHORT ${s.positions.SHORT.quantity}`:p?`${p.direction==='LONG'?'多仓 / Long':'空仓方向 / Short'} · ${p.symbol} · ${p.quantity} · 入场 ${p.entryPrice}`:'无持仓 / Flat';$('liquidation').textContent=num(s?.liquidationPrice,8);
  $('protection').textContent=s?.protection?`交易所止损已核对 · ${s.protection.triggerPrice} · ${s.protection.status}`:p?'持仓尚无已确认的交易所止损，请立即核对。':'无程序持仓止损';
  $('signal').textContent=s?.signal?`${s.signal.intent??'等待 / Wait'} · ${s.signal.reason??''}`:'等待核对';$('blocker').textContent=s?.blocker?message(s.blocker):'';
  $('planned-margin').textContent=plan?.allocation?`${plan.allocation.initialMargin} ${s.marginAsset}（预算 ${plan.allocation.targetMarginUsdt} USDT）`:'—';$('planned-notional').textContent=plan?.allocation?`${plan.allocation.notionalUsdt} USDT`:'—';$('planned-fees').textContent=plan?.allocation?`${plan.allocation.reservedRoundTripFees} ${s.marginAsset}`:'—';$('actual-settings').textContent=s?`${s.configuration.marginMode} / ${s.configuration.leverage}× / ${s.hedge?'双向':'单向'}`:'—';
  $('strategy').textContent=state.settings?.externalStrategy?.name??'内置双向 EMA / RSI / ATR';
  renderHedgeAndMargin(state);table('orders',(s?.orders??[]).toReversed().map(row=>[when(row.time),row.market+' / '+row.symbol,row.intent,row.quantity,row.positionSide,row.status]));table('activity',(state.logs??[]).toReversed().map(row=>[when(row.time),row.event,message(row.code)]));
  $('last-updated').textContent=s?'最近核对 '+when(s.checkedAt):'本机运行 · 尚未核对';
}
function fillSettings(state){if(!state.settings)return;const s=state.settings;external=s.externalStrategy;externalMargin=s.externalMarginPolicy??null;for(const [id,value] of Object.entries({market:s.market,symbol:s.symbol,'asset-mode':s.assetMode??'single','margin-mode':s.marginMode,leverage:s.leverage,percent:s.marginPercent,direction:s.directionMode,'position-policy':s.positionPolicy??'single'}))$(id).value=value;$('auto-connect').checked=state.preferences.autoConnect;updateAssetModeForm();editing=false;}
const saveFeedback=document.createElement('p');
const checkFeedback=document.createElement('p');
checkFeedback.className='signal';
checkFeedback.setAttribute('role','status');
$('check').parentElement.after(checkFeedback);
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
$('asset-mode').addEventListener('change',updateAssetModeForm);
function capacityText(capacity){
  if(!capacity)return '';
  const value=num(capacity.availableUsdt,8);
  return '扣除持仓和挂单占用后的可用保证金'+(capacity.mode==='multi'?'（联合账户折合）':'')+'：'+value+' USDT';
}
function renderCheck(state){
  const wallet=state.walletRead;
  const parts=[];
  if(wallet){
    const amount=wallet.amounts.map(row=>num(row.balance,12)+' '+row.asset).join('，');
    parts.push('上次读取'+marketNames[wallet.market]+'钱包（'+when(wallet.time)+'） · '+(amount||'没有返回非零余额'));
  }
  const modes=state.accountModes;
  if(modes){
    const labels=[];
    if(typeof modes.multiAssets==='boolean')labels.push(modes.multiAssets?'多资产保证金':'单资产保证金');
    if(typeof modes.hedge==='boolean')labels.push(modes.hedge?'双向持仓':'单向持仓');
    if(labels.length)parts.push('币安 U 本位账户 · '+labels.join(' / '));
  }
  const capacity=state.marginCapacity;
  if(capacity){
    parts.push(capacityText(capacity));
    const equity=state.connected?state.snapshot?.equityUsdt:null;
    if(equity&&state.settings){
      const sizingEquity=capacity.mode==='multi'?Math.min(Number(equity),Number(capacity.poolEquityUsdt)):Number(equity);
      const budget=Math.min(Number(capacity.availableUsdt),Math.max(0,sizingEquity)*state.settings.marginPercent/100);
      parts.push('本次初始保证金上限 '+num(budget,8)+' USDT，实际下单再预留费用并按合约步长向下取整');
    }
    if(capacity.eligible?.length>1)parts.push('可联合抵押的有余额资产：'+capacity.eligible.join('、')+'。是否共用由你选择。');
    else if(wallet?.amounts.length===1&&wallet.amounts[0].asset==='USDT'&&Number(wallet.amounts[0].balance)>0)parts.push('目前钱包只持有 USDT，单资产即可交易 USDT 合约。');
    if(state.settings?.assetMode&&state.settings.assetMode!==capacity.mode)parts.push(message('ASSET_MODE_PREFERENCE_MISMATCH'));
  }
  if(!state.unlocked)parts.push(state.vaultExists?'请先在「账户与合约」解锁已有配置。':'请先在「账户与合约」保存加密配置。');
  else if(checking||state.checking)parts.push('正在只读核对…');
  else if(state.error){
    const issue=state.readFailure;
    const reason=message(state.error);
    if(issue){
      const details=[marketNames[issue.market],queryNames[issue.operation]??issue.operation,reason];
      if(issue.httpStatus)details.push('HTTP '+issue.httpStatus);
      if(issue.binanceCode!==null)details.push('币安 '+issue.binanceCode);
      parts.push(details.join(' · '));
    }else parts.push('完整核对未通过 · '+reason);
  }else if(checkNotice)parts.push(checkNotice);
  else if(state.connected)parts.push(state.snapshot?.blocker?'账户已连接 · '+message(state.snapshot.blocker):'账户与合约核对已通过。');
  else parts.push('点击「只读核对」读取合约钱包。');
  const text=parts.join('　');
  if(checkFeedback.textContent!==text)checkFeedback.textContent=text;
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
  if(busy){
    if(saving)reportSave('上一项操作仍在处理，请稍后再保存。');
    return;
  }
  busy=true;actionNotice=null;
  if(name==='check'){checking=true;checkNotice='';}
  try{
    if(saving){reportSave('正在加密保存到本机…');$('save').disabled=true;}
    if(current)render(current);
    const state=await api(name,body);
    if(state.version){
      render(state);
      if(['save','unlock','settings','strategy','margin-policy'].includes(name))fillSettings(state);
    }
    if(after)await after(state);
    if(saving){
      actionNotice='合约配置已保存并解锁。可在合约总览点击“只读核对”。';
      reportSave(actionNotice);$('notice').textContent=actionNotice;
    }
  }catch(error){
    actionNotice=message(error.message);
    $('notice').textContent=actionNotice;
    if(saving)reportSave(actionNotice);
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
for(const id of ['market','symbol','asset-mode','margin-mode','leverage','percent','direction','position-policy','auto-connect'])$(id).addEventListener('input',()=>{editing=true;});
$('confirmation').addEventListener('input',()=>{if(current)renderButtons();});
$('market').addEventListener('change',()=>{updateAssetModeForm();$('symbol').value=$('market').value==='USD_M'?'BTCUSDT':'BTCUSD_PERP';$('leverage').value='';$('preflight-result').textContent='合约类型已变，请重新读取设置。';$('symbols').replaceChildren();});
$('pem-file').addEventListener('change',async()=>{const f=$('pem-file').files[0];if(!f)return;if(f.size>16384)return void($('notice').textContent='PEM 文件过大。');privatePem=await f.text();$('secret').value='';$('notice').textContent='RSA PEM 已在内存中准备，保存后加密到本机。';});
$('generate').onclick=()=>act('generate-key',{password:$('password').value},value=>{privatePem=value.privateKeyPem;$('secret').value='';$('public-key').textContent=value.publicKey;$('public-key').hidden=false;$('copy-public').hidden=false;$('notice').textContent=value.reused?'已找回同一 RSA 公钥。':'已生成 RSA 公钥，请在币安注册；私钥已加密保存。';});
$('copy-public').onclick=async()=>{try{await navigator.clipboard.writeText($('public-key').textContent);$('notice').textContent='公钥已复制。';}catch{$('notice').textContent='请选中并复制下方公钥。';}};
$('preflight').onclick=()=>act('preflight',{password:$('password').value,market:$('market').value,symbol:$('symbol').value.trim().toUpperCase(),...($('key').value?{credentials:formCredentials()}:{})},value=>{if($('asset-mode').value!=='multi'||$('market').value!=='USD_M')$('margin-mode').value=value.configuration.marginMode;$('leverage').value=value.configuration.leverage;$('preflight-result').textContent=`币安当前：${value.configuration.marginMode} / ${value.configuration.leverage}×；总权益 ${num(value.equityUsdt)} USDT；发现 ${value.unmanagedPositions} 个非零仓位。${capacityText(value.marginCapacity)} 读取不会改变账户。`;});
$('catalog').onclick=()=>act('catalog',{market:$('market').value},value=>{$('symbols').replaceChildren(...value.symbols.map(row=>{const option=document.createElement('option');option.value=row.symbol;option.label=row.marginAsset;return option;}));$('notice').textContent=`已读取 ${value.symbols.length} 个可用永续合约，请在合约输入栏选择。`;});
$('save').onclick=()=>act('save',{...savedForm(),passwordRepeat:$('password-repeat').value,credentials:formCredentials()},()=>{$('key').value='';$('secret').value='';$('pem').value='';privatePem='';showTab('workspace');});
$('unlock').onclick=()=>act('unlock',{password:$('password').value},()=>showTab('workspace'));
$('lock').onclick=()=>act('lock',{},()=>{$('password').value='';$('password-repeat').value='';privatePem='';$('pem').value='';$('public-key').hidden=true;});
$('apply-settings').onclick=()=>act('settings',savedForm());
$('contract-settings').onclick=()=>act('contract-settings',{confirmation:$('settings-confirmation').value},()=>{$('settings-confirmation').value='';});
$('start').onclick=()=>{if(editing){$('notice').textContent='配置表有未保存修改，请先保存本机配置并只读核对。';return;}act('start',{confirmation:$('confirmation').value},()=>{$('confirmation').value='';});};
$('stop').onclick=async()=>{try{render(await api('stop',{}));}catch(error){$('notice').textContent=message(error.message);}};
$('close-position').onclick=()=>act('close-position',{confirmation:$('confirmation').value},()=>{$('confirmation').value='';});
$('check').onclick=()=>act('check');$('reconcile').onclick=()=>act('reconcile');
$('strategy-file').onchange=async()=>{const f=$('strategy-file').files[0];if(!f)return;if(f.size>16384){$('notice').textContent='合约策略 JSON 须小于 16KB。';return;}await act('strategy',{text:await f.text(),password:$('password').value});$('strategy-file').value='';};
$('reset-strategy').onclick=()=>act('strategy',{text:'',password:$('password').value});
async function download(path,name){try{const response=await fetch('/api/'+path,{headers:{'x-asbf-session':token}});if(!response.ok){const value=await response.json();throw new Error(value.error);}const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){$('notice').textContent=message(error.message);}}
$('history').onclick=()=>download('history','AdaptiveFuturesBot-Orders.csv');$('review').onclick=()=>download('review','AdaptiveFuturesBot-Review.md');
async function refresh(){if(busy)return;try{const state=await api('status');render(state);}catch{$('connection-state').textContent='本机服务未连接';$('start').disabled=true;$('close-position').disabled=true;}}

Object.assign(messages,{
  INVALID_USD_M_ASSET_MODE:'请选择单资产或多资产。',
  ASSET_MODE_PREFERENCE_MISMATCH:'本机所选资产模式与币安不同。请到账户与合约核对选择并保存。',
  MULTI_ASSETS_REQUIRES_CROSS:'联合保证金模式需要全仓。',
  MARGIN_CAPACITY_UNVERIFIED:'未取得有效的可用保证金或账户权益，无法计算开仓额度。',
  MARGIN_CONVERSION_INDEX_UNVERIFIED:'用于折算保证金的币安指数缺失或过期，请重新只读核对。',
  MARGIN_BUDGET_BELOW_CONTRACT_MINIMUM_OR_FILTER:'按所选比例和当前可用保证金计算的仓位未达到合约最小数量或金额。',
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
  EXPLICIT_FUTURES_MARGIN_LEVERAGE_AND_RISK_REQUIRED:'请核对合约类型、保证金模式、1%–2% 的保证金比例及杠杆。杠杆可由“读取币安现有设置（只读）”填入。',
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
