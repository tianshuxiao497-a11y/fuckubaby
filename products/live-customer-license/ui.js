'use strict';
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id);let pagesLoaded=false;
async function api(path,post=false,body={}){const r=await fetch('/api/'+path,{method:post?'POST':'GET',headers:{'x-asbw-session':token,...(post?{'Content-Type':'application/json'}:{})},...(post?{body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok){if(result.license)renderLicense(result.license);throw new Error(result.license?.lastErrorCode?'核验未通过：'+result.license.lastErrorCode:'操作未完成，请检查配置或授权。');}return result;}
function select(kind){for(const market of ['spot','futures']){$(market+'-tab').classList.toggle('active',kind===market);$(market+'-frame').hidden=kind!==market;}}
$('spot-tab').onclick=()=>select('spot');$('futures-tab').onclick=()=>select('futures');
function render(state){if(state.license)renderLicense(state.license);for(const market of ['spot','futures']){const s=state[market];$(market+'-state').textContent=s?.running?(s.autoMarginArmed?'交易＋JSON追加运行中':'交易运行中'):s?.autoMarginArmed?'JSON追加运行中':s?.pending?'待核对委托':s?.unlocked?'已解锁 · 已停止':'未启动';}}
$('stop-all').onclick=async()=>{try{render(await api('stop',true));$('notice').textContent='全部自动策略已停止。已有仓位和已接受的交易所保护单仍需在各工作台核对。';}catch(e){$('notice').textContent=e.message;}};
async function refresh(){try{if(!pagesLoaded){const pages=await api('pages');for(const market of ['spot','futures']){$(market+'-frame').src=pages[market];}pagesLoaded=true;}render(await api('status'));}catch(e){$('notice').textContent=e.message;}}
refresh();setInterval(refresh,2000);

function renderLicense(s){const labels={active:'授权有效 / Active',not_activated:'尚未激活 / Not activated',checking:'正在核验 / Checking',waiting_for_connection:'等待联网 / Waiting for connection',waiting_for_session:'等待旧会话结束 / Waiting for session',expired:'订阅已到期 / Expired',verification_required:'需要核验 / Verification required'};$('license-state').textContent=labels[s.status]||s.status;$('license-detail').textContent=s.active?('有效期至 '+new Date(s.paidUntil).toLocaleString()+'；'+(s.saved?'已在系统密钥存储中保存。':'当前为会话使用，未在系统密钥存储中保存。')+' 交易需要手动启动。'):'请使用这个实盘商品的买家许可证。旧测试版许可证、Whop 商户 API Key 和币安 API Key 均不适用。已有仓位请在币安核对。';}
$('license-activate').onclick=async()=>{const key=$('license-key').value.trim();$('license-activate').disabled=true;try{render(await api('license-activate',true,{licenseKey:key}));$('license-key').value='';}catch(e){$('notice').textContent=e.message;}finally{$('license-activate').disabled=false;}};
$('license-refresh').onclick=async()=>{try{render(await api('license-refresh',true));}catch(e){$('notice').textContent=e.message;}};
