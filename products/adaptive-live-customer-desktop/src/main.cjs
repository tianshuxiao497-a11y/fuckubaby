const {app,BrowserWindow,dialog,session,powerMonitor,net,safeStorage}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),{pathToFileURL}=require('node:url');
let window,runtime,closing=false;
const selfTestArg=process.argv.find(arg=>arg.startsWith('--self-test=')),selfTestRoot=selfTestArg?path.resolve(selfTestArg.slice(12)):null;
// Disposable Linux display servers have no physical GPU. Keep the same renderer
// isolation while producing native screenshots with the software compositor.
if(selfTestRoot&&process.platform==='linux')app.disableHardwareAcceleration();
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
const safeError=error=>/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'LIVE_WORKBENCH_START_FAILED';
async function shutdown(){closing=true;runtime?.stop();await runtime?.close();window?.destroy();app.quit();}
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function screenshot(name){
  for(let attempt=0;attempt<5;attempt++){
    window.show();window.focus();await wait(300);
    try{const shot=await window.webContents.capturePage();if(shot.isEmpty())throw new Error('NATIVE_SCREENSHOT_EMPTY');await fs.writeFile(path.join(selfTestRoot,name),shot.toPNG());return;}
    catch(error){if(attempt===4||error.message!=='UnknownVizError')throw error;}
  }
}
app.whenReady().then(async()=>{
  const root=app.isPackaged?path.join(process.resourcesPath,'app-runtime'):path.resolve(__dirname,'../stage/app-runtime'),{createCustomerWorkbench}=await import(pathToFileURL(path.join(root,'products/live-customer-license/workbench.mjs')).href);
  let exchangeRequests=0;const fakeFactory=()=>{exchangeRequests++;throw new Error('NO_EXCHANGE_ACCESS_IN_NATIVE_SELF_TEST');};
  const licenseConfig=JSON.parse(await fs.readFile(path.join(root,'products/live-customer-license/license-config.json'),'utf8'));
  const licenseFile=path.join(app.getPath('userData'),'subscription-license.bin');
  const secureStorage=()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');
  const loadSavedLicense=async()=>{if(!secureStorage())return '';try{const stat=await fs.lstat(licenseFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return '';return safeStorage.decryptString(await fs.readFile(licenseFile));}catch{return '';}};
  const saveLicense=async value=>{if(!secureStorage())return false;await fs.mkdir(path.dirname(licenseFile),{recursive:true,mode:0o700});const temporary=licenseFile+'.'+require('node:crypto').randomBytes(8).toString('hex')+'.tmp';try{await fs.writeFile(temporary,safeStorage.encryptString(value),{flag:'wx',mode:0o600});await fs.rename(temporary,licenseFile);return true;}finally{await fs.unlink(temporary).catch(()=>{});}};
  runtime=await createCustomerWorkbench(selfTestRoot?{profile:path.join(selfTestRoot,'customer-profile'),spot:{clientFactory:fakeFactory},futures:{clientFactory:fakeFactory}}:{profile:path.join(app.getPath('userData'),'profile'),loadSavedLicense,saveLicense,licenseOptions:{fetchImpl:(url,options)=>{if(url!==licenseConfig.endpoint)return Promise.reject(new Error('FIXED_LICENSE_SERVICE_REQUIRED'));return net.fetch(url,options);}}});
  const endpoint=new URL(runtime.url),allowed=new Set(runtime.origins),ownUrl=value=>{try{return allowed.has(new URL(value).origin);}catch{return false;}};
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!ownUrl(details.url)&&details.url!==licenseConfig.endpoint}));
  window=new BrowserWindow({width:1440,height:1000,minWidth:1000,minHeight:740,show:false,backgroundColor:'#0b1020',title:'Adaptive Trading Bot Live · Customer 0.3.5',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
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
      const workspaceStatus=runtime.status();
      if([workspaceStatus,workspaceStatus.spot,workspaceStatus.futures].some(state=>state?.edition!=='customer'||state.version!=='0.3.5-customer'))throw new Error('CUSTOMER_WORKSPACE_VERSION_MISMATCH');
      for(const [key,phrase,header] of [['spot','START REAL SPOT TRADING','x-asbl-session'],['futures','START REAL FUTURES TRADING','x-asbf-session']]){const url=new URL(pages[key]),r=await fetch(url.origin+'/api/start',{method:'POST',headers:{[header]:url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({confirmation:phrase})});if(r.status!==403)throw new Error('UNLICENSED_START_NOT_BLOCKED');}
      if(exchangeRequests)throw new Error('UNEXPECTED_REAL_ACCOUNT_CALL');
      await window.webContents.executeJavaScript('document.getElementById("spot-tab").click()');await screenshot('SPOT-PREVIEW.png');
      await window.webContents.executeJavaScript('document.getElementById("futures-tab").click()');
      const future=frames.futures;await future.executeJavaScript('for(let id=1;id<256;id++)clearInterval(id)');
      const synthetic=require('./selftest-state.cjs')();await future.executeJavaScript('const nativeFixtureRender=render; render=()=>nativeFixtureRender('+JSON.stringify(synthetic)+');render();document.getElementById("confirmation").value="START REAL FUTURES TRADING";document.getElementById("confirmation").dispatchEvent(new Event("input"));');
      const legs=await future.executeJavaScript('({long:document.getElementById("long-position").textContent,short:document.getElementById("short-position").textContent,closeLong:!document.getElementById("close-long").disabled,closeShort:!document.getElementById("close-short").disabled})');if(!legs.closeLong||!legs.closeShort||!legs.long.includes('0.01')||!legs.short.includes('0.01'))throw new Error('INDEPENDENT_LEG_UI_FAILED');
      await future.executeJavaScript('document.getElementById("long-position").closest("article.panel").scrollIntoView()');await screenshot('FUTURES-LEGS-OFFLINE.png');
      await future.executeJavaScript('document.querySelector("[data-tab=setup]").click();document.getElementById("margin-amount").value="5";document.getElementById("margin-confirmation").value="ADD ISOLATED MARGIN";document.getElementById("margin-confirmation").dispatchEvent(new Event("input"));document.getElementById("exchange-auto-margin").scrollIntoView()');
      const margin=await future.executeJavaScript('({manualEnabled:!document.getElementById("add-margin").disabled,autoDisabled:document.getElementById("auto-margin-start").disabled,exchangeState:document.getElementById("exchange-auto-margin").textContent,policyImport:!!document.getElementById("margin-policy-file"),selectFontLoaded:getComputedStyle(document.getElementById("margin-side")).fontFamily.includes("Adaptive Noto Sans SC")&&getComputedStyle(document.getElementById("market")).fontFamily.includes("Adaptive Noto Sans SC")})');if(!margin.manualEnabled||!margin.autoDisabled||!margin.policyImport||!margin.selectFontLoaded||!margin.exchangeState.includes('已关闭'))throw new Error('MARGIN_CONTROL_UI_FAILED_'+JSON.stringify(margin));
      const assetModes=await future.executeJavaScript(`(()=>{
        const mode=document.getElementById('asset-mode'),margin=document.getElementById('margin-mode');
        const options=Array.from(mode.options,o=>o.value);
        mode.value='multi';mode.dispatchEvent(new Event('change'));
        return {single:options.includes('single'),multi:options.includes('multi'),cross:margin.value==='CROSSED'&&margin.querySelector('option[value="ISOLATED"]').disabled};
      })()`);
      if(!assetModes.single||!assetModes.multi||!assetModes.cross)throw new Error('USD_M_ASSET_MODE_UI_FAILED');
      const externalPositions=await future.executeJavaScript(`(()=>{
        const control=document.getElementById('external-position-policy');
        const previous=savedForm();
        const legacy={settings:{market:'USD_M',symbol:'ETHUSDT'},preferences:{autoConnect:false}};
        fillSettings(legacy);
        const defaultBlocks=control.value==='block';
        control.value='otherContracts';
        control.dispatchEvent(new Event('input'));
        const settings=savedForm().settings;
        const saved=editing && settings.externalPositionPolicy==='otherContracts';
        fillSettings({...legacy,settings});
        const restored=control.value==='otherContracts'&&!editing;
        fillSettings(previous);
        return {defaultBlocks,saved,restored};
      })()`);
      if(!externalPositions.defaultBlocks||!externalPositions.saved||!externalPositions.restored)throw new Error('EXTERNAL_POSITION_POLICY_UI_FAILED');
      const draft=await future.executeJavaScript(`(()=>{
        fillSettings(${JSON.stringify(synthetic)});
        for(const [id,value] of [['percent','10'],['leverage','102']]){
          const field=document.getElementById(id);
          field.value=value;
          field.dispatchEvent(new Event('input',{bubbles:true}));
        }
        if(!editing||inputError())throw new Error('NATIVE_SETTINGS_DRAFT_REJECTED');
        return savedForm().settings;
      })()`);
      const vault=await import(pathToFileURL(path.join(root,'products/spot-live-pilot/live/vault.mjs')).href);
      const {validateSettings}=await import(pathToFileURL(path.join(root,'products/futures-live-pilot/live/engine.mjs')).href);
      const fixturePath=path.join(selfTestRoot,'offline-settings-'+require('node:crypto').randomUUID()+'.json');
      const fixturePassword=require('node:crypto').randomBytes(24).toString('hex');
      let restored;
      try{
        await vault.saveVault(fixturePath,{settings:validateSettings(draft)},fixturePassword);
        restored=validateSettings((await vault.loadVault(fixturePath,fixturePassword)).settings);
      }finally{await fs.unlink(fixturePath).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      const display=structuredClone(synthetic);
      display.settings=restored;
      display.snapshot.configuration.leverage=150;
      display.snapshot.actualConfigurationMatches=false;
      const settingsRoundTrip=await future.executeJavaScript(`(()=>{
        const state=${JSON.stringify(display)};
        fillSettings(state);nativeFixtureRender(state);
        const get=id=>document.getElementById(id);
        return {
          restored:get('percent').value==='10'&&get('leverage').value==='102'&&!editing,
          localTarget:get('saved-settings').textContent.includes('10%')&&get('saved-settings').textContent.includes('102×'),
          exchangeValue:get('actual-settings').textContent.includes('150×')&&!get('actual-settings').textContent.includes('102×'),
          summaryVisible:get('wallet-summary').textContent.includes('设置待应用'),
          detailsCollapsed:get('wallet-details').closest('details')?.open===false
        };
      })()`);
      if(!Object.values(settingsRoundTrip).every(Boolean))throw new Error('NATIVE_FUTURES_SETTINGS_ROUND_TRIP_FAILED_'+JSON.stringify(settingsRoundTrip));
      await screenshot('FUTURES-MARGIN-OFFLINE.png');
      const template=await (await fetch(new URL('/example-auto-margin.json',pages.futures))).json();if(template.enabled||template.perAdditionAmount!=='0'||template.maxTotalAmount!=='0')throw new Error('NO_DEFAULT_AUTO_MARGIN_SPENDING_ALLOWED');
      if(runtime.status().spot.running||runtime.status().futures.running||runtime.status().futures.autoMarginArmed||exchangeRequests)throw new Error('NATIVE_SELF_TEST_STARTED_TRADING');
      await fs.writeFile(path.join(selfTestRoot,'RESULT.json'),JSON.stringify({passed:true,version:'0.3.5-customer',platform:process.platform,arch:process.arch,electron:process.versions.electron,uiFontLoaded:true,twoWorkspaces:true,renderer,legs,margin,assetModes,externalPositions,settingsRoundTrip,syntheticInterfaceOnly:true,unconfiguredStartBlocked:true,realAccountReads:0,exchangeOrders:0,customerSubscriptionIntegrated:true,unlicensedStartBlocked:true},null,2));await shutdown();
    }catch(error){await fs.writeFile(path.join(selfTestRoot,'FAILED.txt'),String(error?.stack??safeError(error)));runtime.stop();await runtime.close();window.destroy();app.exit(1);}return;
  }
  window.on('close',async event=>{if(closing)return;event.preventDefault();const state=runtime.status();runtime.stop();const active=[state.spot,state.futures].some(s=>s.running||s.autoMarginArmed||s.pending||s.snapshot?.position||Object.values(s.snapshot?.positions??{}).some(Boolean));if(active){const result=await dialog.showMessageBox(window,{type:'question',buttons:['返回工作台','停止后退出'],defaultId:0,cancelId:0,title:'退出真实资金工作台',message:'交易策略与本机自动追加均已停止。退出后不会继续本机持仓管理。',detail:'现货持仓和合约多空仓位不会自动平掉；已确认的交易所保护单保留，请在币安核对。'});if(result.response!==1)return;}await shutdown();});
}).catch(async error=>{runtime?.stop();await runtime?.close().catch(()=>{});dialog.showErrorBox('无法打开统一实盘工作台',safeError(error));app.exit(1);});
app.on('window-all-closed',()=>app.quit());
