const {app,BrowserWindow,ipcMain,dialog,safeStorage,shell,clipboard}=require('electron');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const allowed=new Set(['local','licenseStatus','keyStatus','markets','selectSymbol','generateKey','activateLicense','configure','rotateCredentials','connect','snapshot','start','stop']);
let window,child,closing=false,profile;const pending=new Map();let secrets=[];
const selfTestRoot=process.argv.find(x=>x.startsWith('--self-test='))?.slice(12);
const preview=process.argv.includes('--offline-preview')||Boolean(selfTestRoot);
let engineReadyResolve;const engineReady=new Promise(resolve=>{engineReadyResolve=resolve;});
if(!app.requestSingleInstanceLock()){app.quit();}
app.on('second-instance',()=>{if(window){window.show();window.focus();}});
function emit(value){if(window&&!window.isDestroyed())window.webContents.send('bot:event',value);}
function scrub(text){let value=String(text);for(const secret of secrets)if(secret)value=value.split(secret).join('[redacted]');return value.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,'[private key redacted]').slice(0,12000);}
function send(message){
  if(preview&&!selfTestRoot)return Promise.reject(new Error('离线预览不连接账户、不激活、不交易 / Offline preview only.'));
  if(!child?.stdin.writable)return Promise.reject(new Error('交易引擎未就绪 / Engine is not ready.'));
  const requestId=randomUUID();return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);if(message.command==='start'&&child?.stdin.writable)child.stdin.write(JSON.stringify({command:'stop',requestId:randomUUID()})+'\n');reject(new Error('操作超时。请核对引擎状态；不会自动重试订单。'));},45000);
    pending.set(requestId,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({...message,requestId})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(requestId);reject(new Error('引擎连接中断。'));}});
  });
}
function startEngine(){
  const engine=app.isPackaged?path.join(process.resourcesPath,'engine'):path.resolve(__dirname,'../stage/engine');
  const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','LC_ALL','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
  child=spawn(process.execPath,[path.join(engine,'products/adaptive-spot-desktop/controller.mjs'),profile],{cwd:profile,windowsHide:true,env:{...env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});
  createInterface({input:child.stdout}).on('line',line=>{
    try{const value=JSON.parse(line);if(value.type==='ready')engineReadyResolve(value);if(value.requestId&&pending.has(value.requestId)){const task=pending.get(value.requestId);pending.delete(value.requestId);clearTimeout(task.timer);value.type==='error'?task.reject(new Error(scrub(value.text))):task.resolve(value);}emit(value);}catch{emit({type:'log',text:'引擎输出无法识别 / Invalid engine output.'});}
  });
  createInterface({input:child.stderr}).on('line',line=>emit({type:'log',text:scrub(line)}));
  child.on('error',()=>emit({type:'error',text:'无法启动交易引擎 / Engine could not start.'}));
  child.on('close',()=>{child=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error('交易引擎已关闭。'));}pending.clear();emit({type:'engineExit'});});
}
async function saveVault(value){
  if(!safeStorage.isEncryptionAvailable()||(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'))return {saved:false,notice:'系统密钥环不可用：配置仅保留本次会话，不会明文保存。'};
  const file=path.join(profile,'desktop-vault-v1.bin'),temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,safeStorage.encryptString(JSON.stringify(value)),{mode:0o600,flag:'wx'});await fs.rename(temp,file);return {saved:true};
}
let vault={};
async function loadVault(){
  try{if(safeStorage.isEncryptionAvailable()){const file=path.join(profile,'desktop-vault-v1.bin');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error();vault=JSON.parse(safeStorage.decryptString(await fs.readFile(file)));}}catch{emit({type:'notice',text:'本机安全配置未载入；请重新填写。原文件保留。'});}
  secrets=[vault.licenseKey,vault.credentials?.apiKey,vault.credentials?.apiSecret,vault.credentials?.privateKeyPath].filter(Boolean);
}
function caller(event){if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==pathToFileURL(path.join(__dirname,'index.html')).href)throw new Error('Untrusted desktop caller.');}
app.whenReady().then(async()=>{
  profile=selfTestRoot?path.resolve(selfTestRoot,'fake-test-profile'):preview?path.resolve(__dirname,'../preview-profile'):path.join(app.getPath('userData'),'testnet-profile');await fs.mkdir(profile,{recursive:true,mode:0o700});
  window=new BrowserWindow({width:1320,height:900,minWidth:980,minHeight:700,backgroundColor:'#08111e',icon:path.join(__dirname,'app.png'),show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(path.join(__dirname,'index.html')).href)event.preventDefault();});
  ipcMain.handle('bot:command',async(event,message)=>{
    caller(event);if(preview)throw new Error('Offline preview only.');if(!message||typeof message!=='object'||Array.isArray(message)||!allowed.has(message.command)||JSON.stringify(message).length>16384)throw new Error('Unsupported desktop operation.');
    if(message.command==='activateLicense'){secrets.push(message.licenseKey);const result=await send(message);vault.licenseKey=message.licenseKey;const stored=await saveVault(vault);if(!stored.saved)emit({type:'notice',text:stored.notice});return result;}
    if(['configure','rotateCredentials'].includes(message.command)){secrets.push(...Object.values(message.credentials??{}));const result=await send(message);vault.credentials=message.credentials;const stored=await saveVault(vault);if(!stored.saved)emit({type:'notice',text:stored.notice});return result;}
    if(message.command==='start'){
      const answer=await dialog.showMessageBox(window,{type:'question',buttons:['取消 / Cancel','开始虚拟交易 / Start Testnet'],defaultId:0,cancelId:0,title:'Confirm virtual trading',message:'仅使用 Binance Spot Testnet 虚拟资金。',detail:'本次只运行选中的一个币对。请确认没有其他程序同时管理该测试账户。停止或授权失效不会自动平仓，交易频率和收益没有保证。'});
      if(answer.response!==1)throw new Error('已取消 / Canceled.');
      return send({command:'start',confirmVirtualOnly:true,confirmNoOtherBot:true});
    }
    return send(message);
  });
  ipcMain.handle('bot:pickPem',async event=>{caller(event);const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'PEM private key',extensions:['pem']}]});return result.canceled?null:result.filePaths[0];});
  ipcMain.handle('bot:openTestnet',event=>{caller(event);return shell.openExternal('https://testnet.binance.vision/');});
  ipcMain.handle('bot:copyPublicKey',(event,text)=>{caller(event);if(typeof text!=='string'||text.length>1024||!text.startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error('Only a public key can be copied here.');clipboard.writeText(text);return true;});
  ipcMain.handle('bot:restore',async event=>{caller(event);return {licenseKey:vault.licenseKey??'',credentials:vault.credentials??null,preview,platform:process.platform};});
  await window.loadFile(path.join(__dirname,'index.html'));
  if(selfTestRoot){
    const output=path.resolve(selfTestRoot);await fs.mkdir(output,{recursive:true});
    try{
      const state=await window.webContents.executeJavaScript("({heading:document.querySelector('h1').textContent,startDisabled:document.getElementById('start').disabled,licenseInput:document.getElementById('license').type,rendererNodeDisabled:typeof require==='undefined',bridgeAvailable:typeof window.bot.command==='function'})");
      if(!state.startDisabled||state.licenseInput!=='password'||!state.rendererNodeDisabled||!state.bridgeAvailable)throw new Error('renderer_security_or_initial_state_failed');
      startEngine();const ready=await Promise.race([engineReady,new Promise((_,reject)=>setTimeout(()=>reject(new Error('engine_boot_timeout')),12000))]);
      if(ready.mode!=='BINANCE_SPOT_TESTNET_ONLY'||ready.ordersEnabled!==false)throw new Error('engine_initial_mode_failed');
      const local=await send({command:'local'});if(local.running||local.license.active)throw new Error('offline_engine_must_remain_stopped');
      let refused=false;try{await send({command:'start',confirmVirtualOnly:true,confirmNoOtherBot:true});}catch{refused=true;}if(!refused)throw new Error('unconfigured_start_not_refused');
      const image=await window.webContents.capturePage();await fs.writeFile(path.join(output,'DESKTOP-PREVIEW.png'),image.toPNG());
      await fs.writeFile(path.join(output,'RESULT.json'),JSON.stringify({passed:true,platform:process.platform,arch:process.arch,electron:process.versions.electron,node:process.versions.node,renderer:state,bundledControllerBooted:true,unconfiguredStartRefused:true,realAccountReads:0,exchangeOrders:0},null,2));
      await send({command:'close'}).catch(()=>{});child?.stdin.end();closing=true;window.destroy();app.exit(0);
    }catch(error){await fs.writeFile(path.join(output,'FAILED.txt'),scrub(error.message));child?.stdin.end();closing=true;window.destroy();app.exit(1);}
    return;
  }
  window.show();
  if(preview){emit({type:'preview'});}else{await loadVault();startEngine();}
  window.on('close',event=>{
    if(closing||preview)return;event.preventDefault();closing=true;
    // Closing the pipe is the engine's fail-closed guardian signal.
    send({command:'stop'}).catch(()=>{}).finally(async()=>{if(child){child.stdin.end();await Promise.race([new Promise(resolve=>child?.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,10000))]);}window.destroy();app.quit();});
  });
});
app.on('window-all-closed',()=>app.quit());
