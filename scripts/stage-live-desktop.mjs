// Public runtime allowlist only; never copy account profiles or environment files.
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
export const LIVE_DESKTOP_FILES=[
  ...['client.mjs','decimal.mjs','engine.mjs','ledger.mjs','risk.mjs','server.mjs','strategy.mjs','vault.mjs','review.mjs','ui.html','ui.js','ui.css','example-live-strategy.json','README-ZH.md'].map(name=>'products/spot-live-pilot/live/'+name),
  ...['adaptive-strategy.mjs','atomic-json.mjs','external-testnet-strategy.mjs','testnet-commission.mjs','testnet-symbols.mjs'].map(name=>'lib/'+name),
];
const destination=resolve(root,'products/adaptive-spot-live-desktop/stage/app-runtime');
await mkdir(destination,{recursive:true});
if(await realpath(destination)!==destination)throw new Error('LINKED_STAGE_REFUSED');
const entries=[];
for(const name of LIVE_DESKTOP_FILES){
  const file=resolve(root,name),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>500000||await realpath(file)!==file)throw new Error('REGULAR_PUBLIC_RUNTIME_FILE_REQUIRED');
  const data=await readFile(file);
  if(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,}/.test(data.toString()))throw new Error('PRIVATE_KEY_CONTENT_REFUSED');
  const target=resolve(destination,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,data);
  entries.push({path:name,sha256:createHash('sha256').update(data).digest('hex')});
}
await writeFile(resolve(destination,'RUNTIME-MANIFEST.json'),JSON.stringify({version:'0.2.0-personal',mode:'BINANCE_SPOT_MAINNET',edition:'personal',files:entries},null,2));
console.log(JSON.stringify({publicRuntimeFiles:entries.length,sourceCredentialFilesIncluded:false}));
