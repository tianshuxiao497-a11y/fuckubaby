const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bot',{
  command:message=>ipcRenderer.invoke('bot:command',message),
  pickPem:()=>ipcRenderer.invoke('bot:pickPem'),
  openTestnet:()=>ipcRenderer.invoke('bot:openTestnet'),
  copyPublicKey:value=>ipcRenderer.invoke('bot:copyPublicKey',value),
  restore:()=>ipcRenderer.invoke('bot:restore'),
  onEvent:handler=>{const listener=(event,value)=>handler(value);ipcRenderer.on('bot:event',listener);return()=>ipcRenderer.removeListener('bot:event',listener);}
});
