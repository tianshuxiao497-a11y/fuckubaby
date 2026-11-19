const {app,BrowserWindow,dialog,session,powerMonitor}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),{pathToFileURL}=require('node:url');
let window,runtime,closing=false;
const selfTestArg=process.argv.find(arg=>arg.startsWith('--self-test=')),selfTestRoot=selfTestArg?path.resolve(selfTestArg.slice(12)):null;
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
const safeError=error=>/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'LIVE_WORKBENCH_START_FAILED';
async function shutdown(){closing=true;runtime?.stop();await runtime?.close();window?.destroy();app.quit();}
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
app.whenReady().then(async()=>{
  const root=app.isPackaged?path.join(process.resourcesPath,'app-runtime'):path.resolve(__dirname,'../stage/app-runtime'),{createWorkbenchServer}=await import(pathToFileURL(path.join(root,'products/live-workbench/server.mjs')).href);
  let exchangeRequests=0;const fakeFactory=()=>{exchangeRequests++;throw new Error('NO_EXCHANGE_ACCESS_IN_NATIVE_SELF_TEST');};
  runtime=await createWorkbenchServer(selfTestRoot?{spot:{profile:path.join(selfTestRoot,'spot-profile'),clientFactory:fakeFactory},futures:{profile:path.join(selfTestRoot,'futures-profile'),clientFactory:fakeFactory}}:{});
  const endpoint=new URL(runtime.url),allowed=new Set(runtime.origins),ownUrl=value=>{try{return allowed.has(new URL(value).origin);}catch{return false;}};
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!ownUrl(details.url)}));
  window=new BrowserWindow({width:1440,height:1000,minWidth:1000,minHeight:740,show:false,backgroundColor:'#0b1020',title:'Adaptive Trading Bot Live · Personal 0.3.0',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(!ownUrl(url))event.preventDefault();});
  powerMonitor.on('suspend',()=>runtime?.stop());
  await window.loadURL(runtime.url);window.show();
  if(selfTestRoot){
    await fs.mkdir(selfTestRoot,{recursive:true});
    try{
      const pages=await (await fetch(endpoint.origin+'/api/pages',{headers:{'x-asbw-session':endpoint.hash.slice(1)}})).json();
      const origins={spot:new URL(pages.spot).origin,futures:new URL(pages.futures).origin};let frames;
      for(let i=0;i<150;i++){frames=Object.fromEntries(Object.entries(origins).map(([key,origin])=>[key,window.webContents.mainFrame.frames.find(frame=>{try{return new URL(frame.url).origin===origin;}catch{return false;}})]));if(frames.spot&&frames.futures)break;await wait(100);}
      if(!frames.spot||!frames.futures)throw new Error('TWO_NATIVE_WORKSPACE_FRAMES_REQUIRED');
      for(const frame of Object.values(frames)){
        let ready=false;for(let i=0;i<100;i++){ready=await frame.executeJavaScript('document.readyState==="complete"&&!!document.getElementById("start")');if(ready)break;await wait(50);}if(!ready)throw new Error('WORKSPACE_RENDERER_NOT_READY');
        const font=await frame.executeJavaScript('(async()=>{await document.fonts.load(\'14px "Adaptive Noto Sans SC"\',"现货合约账户");await document.fonts.ready;return [...document.fonts].some(f=>f.family.includes("Adaptive Noto Sans SC")&&f.status==="loaded");})()');if(!font)throw new Error('BUNDLED_CHINESE_FONT_REQUIRED');
      }
      const renderer={};for(const [key,frame] of Object.entries(frames)){renderer[key]=await frame.executeJavaScript('({startDisabled:document.getElementById("start").disabled,nodeDisabled:typeof require==="undefined",externalImport:!!document.getElementById("strategy-file")})');if(!renderer[key].startDisabled||!renderer[key].nodeDisabled||!renderer[key].externalImport)throw new Error('WORKSPACE_INITIAL_SAFETY_STATE_FAILED');}
      for(const [key,phrase,header] of [['spot','START REAL SPOT TRADING','x-asbl-session'],['futures','START REAL FUTURES TRADING','x-asbf-session']]){const url=new URL(pages[key]),r=await fetch(url.origin+'/api/start',{method:'POST',headers:{[header]:url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({confirmation:phrase})});if(r.status!==400)throw new Error('UNCONFIGURED_START_NOT_BLOCKED');}
      if(exchangeRequests)throw new Error('UNEXPECTED_REAL_ACCOUNT_CALL');
      await window.webContents.executeJavaScript('document.getElementById("spot-tab").click()');await wait(100);await fs.writeFile(path.join(selfTestRoot,'SPOT-PREVIEW.png'),(await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript('document.getElementById("futures-tab").click()');
      const future=frames.futures;await future.executeJavaScript('for(let id=1;id<256;id++)clearInterval(id)');
      const synthetic=require('./selftest-state.cjs')();await future.executeJavaScript('render('+JSON.stringify(synthetic)+');document.getElementById("confirmation").value="START REAL FUTURES TRADING";document.getElementById("confirmation").dispatchEvent(new Event("input"));');
      const legs=await future.executeJavaScript('({long:document.getElementById("long-position").textContent,short:document.getElementById("short-position").textContent,closeLong:!document.getElementById("close-long").disabled,closeShort:!document.getElementById("close-short").disabled})');if(!legs.closeLong||!legs.closeShort||!legs.long.includes('0.01')||!legs.short.includes('0.01'))throw new Error('INDEPENDENT_LEG_UI_FAILED');
      await future.executeJavaScript('document.getElementById("long-position").closest("article.panel").scrollIntoView()');await wait(100);await fs.writeFile(path.join(selfTestRoot,'FUTURES-LEGS-OFFLINE.png'),(await window.webContents.capturePage()).toPNG());
      await future.executeJavaScript('document.querySelector("[data-tab=setup]").click();document.getElementById("margin-amount").value="5";document.getElementById("margin-confirmation").value="ADD ISOLATED MARGIN";document.getElementById("margin-confirmation").dispatchEvent(new Event("input"));document.getElementById("exchange-auto-margin").scrollIntoView()');
      const margin=await future.executeJavaScript('({manualEnabled:!document.getElementById("add-margin").disabled,autoDisabled:document.getElementById("auto-margin-start").disabled,exchangeState:document.getElementById("exchange-auto-margin").textContent,policyImport:!!document.getElementById("margin-policy-file")})');if(!margin.manualEnabled||!margin.autoDisabled||!margin.policyImport||!margin.exchangeState.includes('已关闭'))throw new Error('MARGIN_CONTROL_UI_FAILED');
      await wait(100);await fs.writeFile(path.join(selfTestRoot,'FUTURES-MARGIN-OFFLINE.png'),(await window.webContents.capturePage()).toPNG());
      const template=await (await fetch(new URL('/example-auto-margin.json',pages.futures))).json();if(template.enabled||template.perAdditionAmount!=='0'||template.maxTotalAmount!=='0')throw new Error('NO_DEFAULT_AUTO_MARGIN_SPENDING_ALLOWED');
      if(runtime.status().spot.running||runtime.status().futures.running||runtime.status().futures.autoMarginArmed||exchangeRequests)throw new Error('NATIVE_SELF_TEST_STARTED_TRADING');
      await fs.writeFile(path.join(selfTestRoot,'RESULT.json'),JSON.stringify({passed:true,version:'0.3.0-personal',platform:process.platform,arch:process.arch,electron:process.versions.electron,uiFontLoaded:true,twoWorkspaces:true,renderer,legs,margin,syntheticInterfaceOnly:true,unconfiguredStartBlocked:true,realAccountReads:0,exchangeOrders:0,customerSubscriptionIntegrated:false},null,2));await shutdown();
    }catch(error){await fs.writeFile(path.join(selfTestRoot,'FAILED.txt'),safeError(error));runtime.stop();await runtime.close();window.destroy();app.exit(1);}return;
  }
  window.on('close',async event=>{if(closing)return;event.preventDefault();const state=runtime.status();runtime.stop();const active=[state.spot,state.futures].some(s=>s.running||s.autoMarginArmed||s.pending||s.snapshot?.position||Object.values(s.snapshot?.positions??{}).some(Boolean));if(active){const result=await dialog.showMessageBox(window,{type:'question',buttons:['返回工作台','停止后退出'],defaultId:0,cancelId:0,title:'退出真实资金工作台',message:'交易策略与本机自动追加均已停止。退出后不会继续本机持仓管理。',detail:'现货持仓和合约多空仓位不会自动平掉；已确认的交易所保护单保留，请在币安核对。'});if(result.response!==1)return;}await shutdown();});
}).catch(async error=>{runtime?.stop();await runtime?.close().catch(()=>{});dialog.showErrorBox('无法打开统一实盘工作台',safeError(error));app.exit(1);});
app.on('window-all-closed',()=>app.quit());
