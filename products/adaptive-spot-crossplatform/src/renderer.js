'use strict';
const $=id=>document.getElementById(id);let ready=false,licensed=false,connected=false,running=false,busy=false,restored=false,preview=false;const observations=[];
const number=value=>Number.isFinite(Number(value))?Number(value).toLocaleString(undefined,{maximumFractionDigits:8}):'—';
function notice(value){$('notice').textContent=String(value??'');}
function controls(){ $('start').disabled=!ready||!licensed||!connected||running||busy||preview;$('symbol').disabled=running||busy;$('refreshMarkets').disabled=running||busy; }
function log(text){const node=$('logs');node.textContent=(new Date().toLocaleTimeString()+'  '+text+'\n'+node.textContent).slice(0,16000);}
function market(symbol){if(!symbol)return;if($('symbol').value!==symbol){if(![...$('symbol').options].some(x=>x.value===symbol))$('symbol').add(new Option(symbol,symbol));$('symbol').value=symbol;}$('priceAsset').textContent=symbol.slice(0,-4)+' / USDT';$('positionAsset').textContent=symbol.slice(0,-4);}
function balance(items){const value=items?.find(x=>x.asset==='USDT');if(value)$('balance').textContent=number(value.free);}
function license(value){
  licensed=value.active===true;
  const waiting=value.status==='waiting_for_connection'||value.status==='waiting_for_session';
  $('licenseState').textContent=licensed?'有效 / Active':waiting?'待复核 / Retrying':'待核验 / Locked';
  $('paidUntil').textContent=value.paidUntil?'有效至 '+new Date(value.paidUntil).toLocaleString():value.status==='waiting_for_session'?'Waiting for previous session to close':waiting?'Waiting for connection. Retrying automatically.':'请在连接与授权页完成核验';
  $('device').textContent=value.deviceHash?'绑定设备 / Device: '+value.deviceHash:'设备标识在激活后显示。';controls();
}
function chart(candles){const values=candles?.map(x=>Number(x.close)).filter(x=>Number.isFinite(x)&&x>0)??observations;if(values.length<2){$('chartLine').setAttribute('d','');return;}const lo=Math.min(...values),hi=Math.max(...values),spread=hi-lo||hi*.001;$('chartLine').setAttribute('d',values.map((v,i)=>(i?'L':'M')+(10+i*780/(values.length-1)).toFixed(2)+','+(215-(v-lo)*200/spread).toFixed(2)).join(' '));}
function orders(items){const body=$('orders');body.replaceChildren();if(!items?.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=6;cell.className='empty';cell.textContent='没有程序交易记录 / No program orders.';row.append(cell);body.append(row);return;}for(const order of [...items].slice(-50).reverse()){const row=document.createElement('tr');for(const text of [order.time?new Date(order.time).toLocaleString():'—',order.side,number(order.executedQty),number(order.quoteQty),order.status,order.reason]){const cell=document.createElement('td');cell.textContent=String(text??'—');row.append(cell);}body.append(row);}}
async function restore(){if(restored)return;restored=true;const value=await window.bot.restore();preview=value.preview;$('license').value=value.licenseKey??'';if(value.credentials){$('apiKey').value=value.credentials.apiKey??'';$('pem').value=value.credentials.privateKeyPath??'';$('secret').value=value.credentials.apiSecret??'';}if(preview){notice('离线界面预览：不会激活、读取账户或下单。');$('engineStatus').textContent='OFFLINE PREVIEW';}controls();}
function event(value){
  if(value.type==='ready'){ready=true;$('engineStatus').textContent='引擎就绪 / Ready';market(value.symbol);restore().catch(e=>notice(e.message));}
  if(value.type==='preview'){preview=true;restore().catch(()=>{});}
  if(value.type==='license')license(value);
  if(value.type==='notice'||value.type==='error')notice(value.text);
  if(value.type==='log')log(value.text);
  if(value.type==='engineExit'){ready=false;connected=false;running=false;notice('引擎已停止。请重新打开软件并核对记录。');}
  if(value.type==='started'){running=true;$('runState').textContent='策略运行中 / Running';notice(value.text);}
  if(['stopping','workerExit'].includes(value.type)){running=false;$('runState').textContent='已停止 / Stopped';if(value.type==='workerExit')connected=false;}
  if(value.type==='markets'){$('symbol').replaceChildren(...value.items.map(x=>new Option(x.symbol+(x.eligible?'':' · 仅记录'),x.symbol)));market(value.symbol);}
  if(value.type==='configured')connected=false;
  if(value.type==='symbolSelected'||value.type==='symbolChanged'){market(value.symbol);connected=false;observations.length=0;$('price').textContent='—';$('position').textContent='—';$('balance').textContent='—';chart();orders([]);}
  if(value.type==='testnetConnection'){
    connected=false;
    notice(value.status==='retrying'?'测试网暂不可用，约 '+value.retrySeconds+' 秒后自动重试。':value.status==='connecting'?'正在自动只读连接测试网。':value.text);
  }
  if(value.type==='connected'){connected=value.canTrade===true;market(value.symbol);balance(value.balances);notice(connected?'测试账户连接成功；尚未开始交易。':'账户未授予测试网交易权限。');}
  if(value.type==='publicKey'){$('pem').value=value.privateKeyPath;$('publicKey').value=value.publicKey;notice(value.reused?'已找回现有密钥；把配套公钥注册到币安测试网。':'新密钥已在本机生成。只把公钥注册到币安测试网。');}
  if(value.type==='local'){running=value.running;market(value.config?.symbol);$('runState').textContent=running?'策略运行中 / Running':'已停止 / Stopped';$('position').textContent=number(value.position?.quantity??0);license(value.license);orders(value.orders);$('signal').textContent=value.activity?.action??'等待信号 / Waiting';}
  if(value.type==='snapshot'){const s=value.snapshot;market(s.symbol);$('price').textContent=number(s.price);$('position').textContent=number(s.position?.quantity??0);balance(s.balances);observations.push(s.price);if(observations.length>60)observations.shift();chart(s.candles);orders(s.botOrders);$('signal').textContent=s.activity?.action??'观察中 / Observing';}
  controls();
}
window.bot.onEvent(value=>{if(!value.requestId)event(value);});
async function command(message,{quiet=false}={}){busy=true;controls();try{const result=await window.bot.command(message);event(result);return result;}catch(e){if(!quiet)notice(e.message);throw e;}finally{busy=false;controls();}}
function click(id,handler){$(id).addEventListener('click',()=>Promise.resolve().then(handler).catch(()=>{}));}
for(const button of document.querySelectorAll('.nav'))button.addEventListener('click',()=>{const setup=button.dataset.tab==='setup';$('setup').hidden=!setup;$('dashboard').hidden=setup;for(const item of document.querySelectorAll('.nav'))item.classList.toggle('active',item===button);$('heading').textContent=setup?'连接与授权 / Setup':'交易工作台 / Workspace';});
click('activate',()=>command({command:'activateLicense',licenseKey:$('license').value.trim()}));
click('refreshMarkets',()=>command({command:'markets'}));
$('symbol').addEventListener('change',async()=>{try{const result=await command({command:'selectSymbol',symbol:$('symbol').value});connected=false;observations.length=0;chart();$('price').textContent='—';$('balance').textContent='—';$('position').textContent='—';orders([]);market(result.symbol);notice('交易对已切换。请重新连接账户，确认后手动开始。');}catch{await command({command:'local'},{quiet:true}).catch(()=>{});}});
click('generateKey',()=>command({command:'generateKey'}));
click('openTestnet',()=>window.bot.openTestnet());
click('pickPem',async()=>{const selected=await window.bot.pickPem();if(selected)$('pem').value=selected;});
click('copyPublicKey',async()=>{await window.bot.copyPublicKey($('publicKey').value);notice('已复制公钥 / Public key copied.');});
click('connect',async()=>{
  const credentials={apiKey:$('apiKey').value.trim(),privateKeyPath:$('pem').value.trim(),apiSecret:$('secret').value.trim()};
  try{await command({command:'configure',credentials});}catch(e){if(!/API.*旧记录|ACCOUNT_KEY_CHANGED/.test(e.message))throw e;if(!window.confirm('API 与旧记录不同。是否只读核对同一测试账户后接续？不会清空历史。'))throw e;await command({command:'rotateCredentials',credentials});}
  await command({command:'connect'});await command({command:'local'});
});
click('snapshot',()=>command({command:'snapshot'}));
click('start',()=>command({command:'start'}));
click('stop',()=>command({command:'stop'}));
let polling=false,ticks=0;
setInterval(async()=>{if(!ready||busy||polling||preview)return;polling=true;try{await command({command:'local'},{quiet:true});if(connected&&++ticks%5===0)await command({command:'snapshot'},{quiet:true});}catch{}finally{polling=false;}},3000);
restore().catch(()=>{});
