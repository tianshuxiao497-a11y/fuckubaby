'use strict';
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id);let pagesLoaded=false;
async function api(path,post=false){const r=await fetch('/api/'+path,{method:post?'POST':'GET',headers:{'x-asbw-session':token,...(post?{'Content-Type':'application/json'}:{})},...(post?{body:'{}'}:{})});if(!r.ok)throw new Error('工作台连接失败');return r.json();}
function select(kind){for(const market of ['spot','futures']){$(market+'-tab').classList.toggle('active',kind===market);$(market+'-frame').hidden=kind!==market;}}
$('spot-tab').onclick=()=>select('spot');$('futures-tab').onclick=()=>select('futures');
function render(state){for(const market of ['spot','futures']){const s=state[market];$(market+'-state').textContent=s?.running?(s.autoMarginArmed?'交易＋JSON追加运行中':'交易运行中'):s?.autoMarginArmed?'JSON追加运行中':s?.pending?'待核对委托':s?.unlocked?'已解锁 · 已停止':'未启动';}}
$('stop-all').onclick=async()=>{try{render(await api('stop',true));$('notice').textContent='全部自动策略已停止。已有仓位和已接受的交易所保护单仍需在各工作台核对。';}catch(e){$('notice').textContent=e.message;}};
async function refresh(){try{if(!pagesLoaded){const pages=await api('pages');for(const market of ['spot','futures']){$(market+'-frame').src=pages[market];}pagesLoaded=true;}render(await api('status'));}catch(e){$('notice').textContent=e.message;}}
refresh();setInterval(refresh,2000);
