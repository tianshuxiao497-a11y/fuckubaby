import {mkdir,writeFile,readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {collectSources} from './package-virtual.mjs';
import {ENGINE_DESKTOP_FILES,packagedEngineEntry,sha} from '../products/adaptive-spot-desktop/build.mjs';
const root=await realpath(process.cwd()),out=resolve(root,'products/adaptive-spot-crossplatform/stage/engine');
await mkdir(out,{recursive:true});const rs=await realpath(out);if(rs!==out)throw new Error('linked_stage_refused');
const sources=(await collectSources(root)).filter(e=>/^(lib\/|scripts\/testnet\.mjs$|strategies\/virtual-only\.json$)/.test(e.path));
const files=sources.map(e=>{const p=packagedEngineEntry(e);return{path:p.path.slice(7),data:p.data};});
for(const file of ENGINE_DESKTOP_FILES){const p=resolve(root,'products/adaptive-spot-desktop',file);const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())throw new Error('unsafe_engine_source');files.push({path:'products/adaptive-spot-desktop/'+file,data:await readFile(p)});}
for(const entry of files){const target=resolve(out,entry.path),r=relative(out,target);if(!r||r.startsWith('..')||isAbsolute(r))throw new Error('unsafe_stage_target');await mkdir(dirname(target),{recursive:true});await writeFile(target,entry.data);}
const {version}=JSON.parse(await readFile(resolve(root,'products/adaptive-spot-crossplatform/package.json'),'utf8'));
await writeFile(resolve(out,'ENGINE-MANIFEST.json'),JSON.stringify({version,mode:'BINANCE_SPOT_TESTNET_ONLY',deviceBoundLicensing:true,files:files.map(e=>({path:e.path,sha256:sha(e.data)}))},null,2)+'\n');
await writeFile(resolve(root,'products/adaptive-spot-crossplatform/src/app.png'),await readFile(resolve(root,'products/adaptive-spot-desktop/brand.png')));
console.log(JSON.stringify({stage:out,files:files.length,deviceBoundLicensing:true,ordersSubmitted:0}));
