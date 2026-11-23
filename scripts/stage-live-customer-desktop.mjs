// Public runtime allowlist only; never copy account profiles or environment files.
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
export const CUSTOMER_DESKTOP_FILES=[
  "lib/profile-lease.mjs",
  "products/live-customer-license/license-device.mjs",
  "products/live-customer-license/device-protocol.mjs",
  "products/live-customer-license/device-identity.mjs",
  "products/live-customer-license/license-config.json",
  "products/futures-live-pilot/live/math.mjs",
  "products/futures-live-pilot/live/market.mjs",
  "products/futures-live-pilot/live/client.mjs",
  "products/futures-live-pilot/live/ledger.mjs",
  "products/futures-live-pilot/live/strategy.mjs",
  "products/futures-live-pilot/live/engine.mjs",
  "products/futures-live-pilot/live/review.mjs",
  "products/futures-live-pilot/live/server.mjs",
  "products/futures-live-pilot/live/margin-policy.mjs",
  "products/futures-live-pilot/live/ui.html",
  "products/futures-live-pilot/live/ui.js",
  "products/futures-live-pilot/live/ui.css",
  "products/futures-live-pilot/live/example-futures-strategy.json",
  "products/futures-live-pilot/live/example-auto-margin.json",
  "products/futures-live-pilot/live/README-ZH.md",
  "products/futures-live-pilot/live/README-EN.md",
  "products/futures-live-pilot/live/fonts/AdaptiveNotoSansSC.woff2",
  "products/futures-live-pilot/live/fonts/OFL.txt",
  "products/futures-live-pilot/live/fonts/DERIVATION.json",
  "products/spot-live-pilot/live/client.mjs",
  "products/spot-live-pilot/live/decimal.mjs",
  "products/spot-live-pilot/live/engine.mjs",
  "products/spot-live-pilot/live/ledger.mjs",
  "products/spot-live-pilot/live/risk.mjs",
  "products/spot-live-pilot/live/server.mjs",
  "products/spot-live-pilot/live/strategy.mjs",
  "products/spot-live-pilot/live/vault.mjs",
  "products/spot-live-pilot/live/review.mjs",
  "products/spot-live-pilot/live/ui.html",
  "products/spot-live-pilot/live/ui.js",
  "products/spot-live-pilot/live/ui.css",
  "products/spot-live-pilot/live/example-live-strategy.json",
  "products/spot-live-pilot/live/README-ZH.md",
  "products/spot-live-pilot/live/README-EN.md",
  "products/live-customer-license/workbench.mjs",
  "products/live-customer-license/ui.html",
  "products/live-customer-license/ui.js",
  "products/live-customer-license/ui.css",
  "products/live-customer-license/README-ZH.md",
  "products/live-customer-license/README-EN.md",
  "lib/adaptive-strategy.mjs",
  "lib/atomic-json.mjs",
  "lib/external-testnet-strategy.mjs",
  "lib/testnet-commission.mjs",
  "lib/testnet-symbols.mjs"
];
const destination=resolve(root,'products/adaptive-live-customer-desktop/stage/app-runtime');
await mkdir(destination,{recursive:true});
if(await realpath(destination)!==destination)throw new Error('LINKED_STAGE_REFUSED');
const entries=[];
for(const name of CUSTOMER_DESKTOP_FILES){
  const file=resolve(root,name),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>500000||await realpath(file)!==file)throw new Error('REGULAR_PUBLIC_RUNTIME_FILE_REQUIRED');
  let data=await readFile(file);
  if(name==='products/spot-live-pilot/live/engine.mjs'||name==='products/futures-live-pilot/live/engine.mjs'){
    data=Buffer.from(data.toString().replace("'0.3.0-personal'","'0.3.5-customer'"));
  }
  if(name==='products/spot-live-pilot/live/server.mjs')data=Buffer.from(data.toString().replace('tradingAllowed = () => true','tradingAllowed = () => false'));
  if(name==='products/futures-live-pilot/live/server.mjs')data=Buffer.from(data.toString().replace('tradingAllowed=()=>true','tradingAllowed=()=>false'));
  if(name==='products/spot-live-pilot/live/server.mjs'||name==='products/futures-live-pilot/live/server.mjs'){
    data=Buffer.from(data.toString().replace(/edition:\s*'personal'/g,"edition:'customer'"));
  }
  if(name==='products/spot-live-pilot/live/ui.js')data=Buffer.from(data.toString().replace("element('start').disabled = blocked", "element('start').disabled = value.tradingAuthorized === false || blocked"));
  if(name==='products/futures-live-pilot/live/ui.js'){
    let text=data.toString().replace("$('start').disabled=busy", "$('start').disabled=state.tradingAuthorized===false||busy");
    for(const control of ['hedge-lock','add-margin','auto-margin-start','apply-settings','enable-hedge'])text=text.replace("$('"+control+"').disabled=", "$('"+control+"').disabled=state.tradingAuthorized===false||");
    data=Buffer.from(text);
  }
  if(name==='products/spot-live-pilot/live/ui.html'||name==='products/futures-live-pilot/live/ui.html'){
    let text=data.toString('utf8').replaceAll('LIVE PERSONAL','LIVE CUSTOMER').replaceAll('FUTURES PERSONAL','FUTURES CUSTOMER').replaceAll('MAINNET SPOT ONLY','MAINNET SPOT ONLY').replaceAll('PERSONAL MAINNET','CUSTOMER MAINNET').replaceAll('Live Personal','Live Customer').replaceAll('· Personal','· Customer').replaceAll('DESKTOP 0.3.0 · PERSONAL','DESKTOP 0.3.5 · CUSTOMER');
    const section='<article class="panel narrow"><p class="eyebrow">CUSTOMER EDITION 0.3.5</p><h3>实盘客户订阅版</h3><p>在窗口顶部填写本实盘商品的 Whop 买家许可证。一证一机；使用购买账号在订单中复制。旧测试版许可证不能用于本版。</p><p>每 30 秒联网核验，短期授权最多 120 秒。失效或断网后停止自动化，不自动平仓；现有交易所保护单保留，手动合约平仓通道保留。恢复后仍需本人确认启动。</p><p>模拟检查与四平台启动检查不等于已完成真实账户成交验收。</p></article>';
    text=text.replace(/(<section data-view="(?:license|edition)" hidden>)[\s\S]*?<\/section>/,(_,start)=>start+section+'</section>').replace('本版尚未接入客户收费交付。模拟验收不代表已完成真实账户成交验证。','本版使用独立的 Whop 实盘商品授权。模拟验收不代表已完成真实账户成交验证。');
    data=Buffer.from(text);
  }
  if(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,}/.test(data.toString()))throw new Error('PRIVATE_KEY_CONTENT_REFUSED');
  const target=resolve(destination,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,data);
  entries.push({path:name,sha256:createHash('sha256').update(data).digest('hex')});
}
await writeFile(resolve(destination,'RUNTIME-MANIFEST.json'),JSON.stringify({version:'0.3.5-customer',mode:'BINANCE_SPOT_AND_FUTURES_MAINNET',edition:'customer',files:entries},null,2));
console.log(JSON.stringify({publicRuntimeFiles:entries.length,sourceCredentialFilesIncluded:false}));
