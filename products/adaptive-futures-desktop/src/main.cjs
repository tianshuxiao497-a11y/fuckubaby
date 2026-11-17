const {app,BrowserWindow,dialog,session}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
let window,runtime,closing=false;
const selfTestArg=process.argv.find(value=>value.startsWith('--self-test='));
const selfTestRoot=selfTestArg?path.resolve(selfTestArg.slice('--self-test='.length)):null;
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(window){window.show();window.focus();}});
function safeError(error){return /^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'FUTURES_DESKTOP_START_FAILED';}
async function shutdown(){closing=true;runtime?.stop();await runtime?.close();window?.destroy();app.quit();}
app.whenReady().then(async()=>{
  const root=app.isPackaged?path.join(process.resourcesPath,'app-runtime'):path.resolve(__dirname,'../stage/app-runtime');
  const {createFuturesServer,defaultProfile}=await import(pathToFileURL(path.join(root,'products/futures-live-pilot/live/server.mjs')).href);
  let exchangeRequests=0;
  runtime=await createFuturesServer({port:0,profile:selfTestRoot?path.join(selfTestRoot,'fake-profile'):defaultProfile(),
    ...(selfTestRoot?{clientFactory(){exchangeRequests++;throw new Error('NO_EXCHANGE_ACCESS_IN_SELF_TEST');}}:{})});
  const endpoint=new URL(runtime.url);
  const ownUrl=value=>{try{return new URL(value).origin===endpoint.origin;}catch{return false;}};
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!ownUrl(details.url)}));
  window=new BrowserWindow({width:1380,height:940,minWidth:940,minHeight:700,show:false,backgroundColor:'#0b1020',title:'Adaptive Futures Bot · Personal 0.1.0',
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!ownUrl(url))event.preventDefault();});
  await window.loadURL(runtime.url);
  window.show();
  if(selfTestRoot){
    await fs.mkdir(selfTestRoot,{recursive:true});
    try{
      const state=await window.webContents.executeJavaScript("({heading:document.querySelector('h2').textContent,startDisabled:document.getElementById('start').disabled,externalImport:!!document.getElementById('strategy-file'),reset:!!document.getElementById('reset-strategy'),chartEmpty:document.getElementById('chart-line').getAttribute('d')==='',nodeDisabled:typeof require==='undefined',mainnet:document.body.textContent.includes('BINANCE FUTURES MAINNET'),contractSelector:!!document.getElementById('market'),manualMarketClose:!!document.getElementById('close-position')})");
      if(!state.startDisabled||!state.externalImport||!state.reset||!state.chartEmpty||!state.nodeDisabled||!state.mainnet)throw new Error('FUTURES_RENDERER_INITIAL_STATE_FAILED');
      await window.webContents.executeJavaScript("document.querySelector('[data-tab=setup]').click()");
      const setup=await window.webContents.executeJavaScript("({visible:!document.querySelector('[data-view=setup]').hidden,password:document.getElementById('password').type,secret:document.getElementById('secret').type})");
      if(!setup.visible||setup.password!=='password'||setup.secret!=='password')throw new Error('FUTURES_SETUP_VIEW_FAILED');
      await window.webContents.executeJavaScript("document.querySelector('[data-tab=workspace]').click()");
      const start=await fetch(endpoint.origin+'/api/start',{method:'POST',headers:{'x-asbf-session':endpoint.hash.slice(1),Origin:endpoint.origin,'Content-Type':'application/json'},body:JSON.stringify({confirmation:'START REAL FUTURES TRADING'})});
      if(start.status!==400||runtime.status().unlocked||runtime.status().running||exchangeRequests!==0)throw new Error('FUTURES_UNCONFIGURED_EXECUTION_NOT_BLOCKED');
      await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await fs.writeFile(path.join(selfTestRoot,'DESKTOP-PREVIEW.png'),(await window.webContents.capturePage()).toPNG());
      await fs.writeFile(path.join(selfTestRoot,'RESULT.json'),JSON.stringify({passed:true,version:'0.1.0-futures-personal',platform:process.platform,arch:process.arch,electron:process.versions.electron,
        renderer:state,setup,unconfiguredStartBlocked:true,realAccountReads:0,exchangeOrders:0,customerSubscriptionIntegrated:false},null,2));
      await shutdown();
    }catch(error){await fs.writeFile(path.join(selfTestRoot,'FAILED.txt'),safeError(error));await runtime.close();window.destroy();app.exit(1);}
    return;
  }
  window.on('close',async event=>{
    if(closing)return;
    event.preventDefault();
    const state=runtime.status();runtime.stop();
    if(state.running||state.pending||state.snapshot?.position){
      const answer=await dialog.showMessageBox(window,{type:'question',buttons:['返回工作台','停止后退出'],defaultId:0,cancelId:0,
        title:'退出实盘程序',message:'新委托已经停止。退出后，本机持仓管理也会停止。',detail:'真实合约仓位不会自动平仓；已确认的交易所止损保留。本机止盈和追踪退出将停止。请在币安确认账户情况，未确定的订单会保留原记录。'});
      if(answer.response!==1)return;
    }
    await shutdown();
  });
}).catch(async error=>{runtime?.stop();await runtime?.close().catch(()=>{});dialog.showErrorBox('无法打开实盘工作台',safeError(error));app.exit(1);});
app.on('window-all-closed',()=>app.quit());
