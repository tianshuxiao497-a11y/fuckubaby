// Public runtime allowlist only; never copy account profiles or environment files.
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
export const FUTURES_DESKTOP_FILES=[
  "products/futures-live-pilot/live/fonts/AdaptiveNotoSansSC.woff2",
  "products/futures-live-pilot/live/fonts/OFL.txt",
  "products/futures-live-pilot/live/fonts/DERIVATION.json",
  "products/futures-live-pilot/live/math.mjs",
  "products/futures-live-pilot/live/market.mjs",
  "products/futures-live-pilot/live/client.mjs",
  "products/futures-live-pilot/live/ledger.mjs",
  "products/futures-live-pilot/live/strategy.mjs",
  "products/futures-live-pilot/live/engine.mjs",
  "products/futures-live-pilot/live/review.mjs",
  "products/futures-live-pilot/live/server.mjs",
  "products/futures-live-pilot/live/ui.html",
  "products/futures-live-pilot/live/ui.js",
  "products/futures-live-pilot/live/ui.css",
  "products/futures-live-pilot/live/example-futures-strategy.json",
  "products/futures-live-pilot/live/README-ZH.md",
  "products/futures-live-pilot/live/README-EN.md",
  "products/spot-live-pilot/live/decimal.mjs",
  "products/spot-live-pilot/live/vault.mjs",
  "lib/atomic-json.mjs",
  "lib/external-testnet-strategy.mjs"
];
const destination=resolve(root,'products/adaptive-futures-desktop/stage/app-runtime');
await mkdir(destination,{recursive:true});
if(await realpath(destination)!==destination)throw new Error('LINKED_STAGE_REFUSED');
const entries=[];
for(const name of FUTURES_DESKTOP_FILES){
  const file=resolve(root,name),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>500000||await realpath(file)!==file)throw new Error('REGULAR_PUBLIC_RUNTIME_FILE_REQUIRED');
  const data=await readFile(file);
  if(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,}/.test(data.toString()))throw new Error('PRIVATE_KEY_CONTENT_REFUSED');
  const target=resolve(destination,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,data);
  entries.push({path:name,sha256:createHash('sha256').update(data).digest('hex')});
}
await writeFile(resolve(destination,'RUNTIME-MANIFEST.json'),JSON.stringify({version:'0.1.0-futures-personal',mode:'BINANCE_FUTURES_MAINNET',edition:'personal',files:entries},null,2));
console.log(JSON.stringify({publicRuntimeFiles:entries.length,sourceCredentialFilesIncluded:false}));
