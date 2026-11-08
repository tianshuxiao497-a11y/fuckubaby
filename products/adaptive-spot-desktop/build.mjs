import { readFile, writeFile, mkdir, copyFile, realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { collectSources, crc32 } from '../../scripts/package-virtual.mjs';
import { verifyBrandAssets } from './brand-assets.mjs';
import { validatePublicConfig } from './license.mjs';

export const VERSION = '0.5.0';
export const DESKTOP_FILES = Object.freeze(['Common.cs', 'Ui.cs', 'Theme.xaml', 'Desktop.xaml', 'Desktop.cs', 'Installer.cs', 'InstallerCore.cs', 'controller.mjs', 'worker.mjs', 'license.mjs', 'license-device.mjs', 'device-protocol.mjs', 'device-identity.mjs', 'entrypoint-gate.mjs', 'license-config.json', 'test-license-fixture.mjs', 'desktop-license.test.mjs', 'desktop-worker-license.test.mjs', 'desktop-key-rotation.test.mjs', 'desktop-symbols.test.mjs', 'app.manifest', 'app.config', 'build.mjs', 'brand-assets.mjs', 'brand.svg', 'brand.png', 'app.ico', 'desktop.test.mjs', 'desktop-build.test.mjs', 'desktop-flow.test.mjs', 'README.md', 'QUICKSTART-ZH.txt', 'QUICKSTART-EN.txt']);
export const ENGINE_DESKTOP_FILES = Object.freeze(['controller.mjs', 'worker.mjs', 'license.mjs', 'license-device.mjs', 'device-protocol.mjs', 'device-identity.mjs', 'entrypoint-gate.mjs', 'license-config.json']);
export const LICENSED_ENTRY_PRELUDE = "import { assertLicensedDesktopEntry } from '../products/adaptive-spot-desktop/entrypoint-gate.mjs';\nassertLicensedDesktopEntry();\n";
export const NODE_SHA = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5';
export const LICENSE_SHA = '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function sourceManifest(entries) {
  const files = entries.map(({path, data}) => ({path, bytes: data.length, sha256: sha(data)})).sort((a,b) => a.path.localeCompare(b.path));
  return {format:1, product:'Adaptive Spot Bot — Windows Testnet Edition', version:VERSION, files};
}

const desktopFirstReadme = staging => Buffer.from(`# Adaptive Spot Bot — Windows desktop ${VERSION}${staging?' — LOCKED QA, NOT FOR SALE':''}\n\nThis is the developer source package, not the buyer installer. It contains the actual Binance Spot Testnet adaptive robot, not the offline EMA demo. Do not give this developer source ZIP to subscription buyers: it also documents the original standalone CLI, which is not remotely revoked by the desktop subscription service.\n\nOrdinary users should use the matching production-configured Windows buyer ZIP and run AdaptiveSpotBot-Testnet-Setup.exe. The installed Adaptive Spot Bot shortcut opens the trading workspace; opening Setup.exe again opens installation/repair, not the bot. No trading starts automatically.\n\nDesktop 0.3.0 verifies its subscription online before trading and rechecks every 30 seconds with signed leases of at most 120 seconds. Failure, expiry or revocation requests stop; stopping is not liquidation/cancellation and local risk rules stop too. Records remain readable. Cancellation of renewal permits use only until the paid term ends. This cannot revoke previously distributed 0.2.0/source editions or guarantee tamper-proof enforcement.\n\n${staging?'This staging archive intentionally contains blank license-service configuration. Trading stays locked even if the seller source had valid production settings. Never upload this QA archive as an active paid product.\n\n':''}Developers: start with products/adaptive-spot-desktop/README.md, then the English or Chinese quick start in that directory. The original root README.md describes the command-line source engine. No personal API keys, account files, seller paperwork, server/private signing keys or transaction records are included. SOURCE_MANIFEST.json inventories this whole source package.\n\nUnsigned technical candidate, not a sale-readiness certificate. Production entitlement/expiry acceptance, clean-PC compatibility, legal terms, platform/payout eligibility and support scope still need review. No live trading, payment processing, automatic updates, hosted operation or profit guarantees.\n`, 'utf8');

export function packagedLicenseConfig(value, staging = false) {
  if (staging) return {endpoint:'',publicKey:'',companyId:'',productId:'',planIds:[]};
  try { validatePublicConfig(value); }
  catch { throw new Error('Release blocked: configure and verify the production license service first. --staging builds a LOCKED non-sale QA package only.'); }
  return value;
}
export function packagedEngineEntry(entry) {
  return {path:'engine/'+entry.path,data:entry.path==='scripts/testnet.mjs'?Buffer.concat([Buffer.from(LICENSED_ENTRY_PRELUDE),entry.data]):entry.data};
}

export function archive(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200) throw new Error('Invalid archive entry count.');
  const names = new Set(), local = [], central = []; let offset = 0, total = 0;
  for (const { path, data } of [...entries].sort((a,b) => a.path.localeCompare(b.path))) {
    if (typeof path !== 'string' || !/^[A-Za-z0-9_.\-/]+$/.test(path) || path.includes('..') || path.startsWith('/') || names.has(path.toLowerCase())) throw new Error('Unsafe or duplicate archive path.');
    names.add(path.toLowerCase());
    if (!Buffer.isBuffer(data) || data.length > 150_000_000 || (total += data.length) > 250_000_000) throw new Error('Archive byte limit exceeded.');
    const name = Buffer.from(path); const compressed = deflateRawSync(data, { level: 7 }); const crc = crc32(data);
    const a = Buffer.alloc(30); a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20,4); a.writeUInt16LE(0x800,6); a.writeUInt16LE(8,8); a.writeUInt16LE(0x21,12);
    a.writeUInt32LE(crc,14); a.writeUInt32LE(compressed.length,18); a.writeUInt32LE(data.length,22); a.writeUInt16LE(name.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt16LE(8,10); c.writeUInt16LE(0x21,14);
    c.writeUInt32LE(crc,16); c.writeUInt32LE(compressed.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(name.length,28); c.writeUInt32LE(offset,42);
    local.push(a,name,compressed); central.push(c,name); offset += a.length + name.length + compressed.length;
  }
  const size = central.reduce((n,b) => n+b.length,0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(size,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
export async function build({ node, license, now = new Date(), staging = false }) {
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  let originalConfig;
  try { originalConfig=JSON.parse(await readFile(new URL('./license-config.json',import.meta.url),'utf8')); }
  catch { if(!staging) throw new Error('Release blocked: license-config.json is missing or invalid.'); }
  const licenseConfig=packagedLicenseConfig(originalConfig,staging);
  const licensingConfigured=!staging;
  const runtime = await readFile(node), notices = await readFile(license);
  if (sha(runtime) !== NODE_SHA || sha(notices) !== LICENSE_SHA) throw new Error('Bundled runtime/license differs from pinned official Node v24.15.0 x64.');
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const output = resolve(root, 'exports', `AdaptiveSpotBot-Windows-${VERSION}${staging?'-LOCKED-QA':''}-${stamp}`);
  await mkdir(output); const stage = resolve(output, 'build'); await mkdir(stage);
  const sources = await collectSources(root);
  const desktop = [];
  for (const name of DESKTOP_FILES) {
    const path = resolve(root, 'products/adaptive-spot-desktop', name); const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.size > 2_000_000) throw new Error('Only regular, non-linked desktop source within size limits is allowed.');
    desktop.push({ path: `products/adaptive-spot-desktop/${name}`, data: name==='license-config.json'?Buffer.from(JSON.stringify(licenseConfig,null,2)+'\n'):await readFile(path) });
  }
  const sourceByName = name => desktop.find(e => e.path === `products/adaptive-spot-desktop/${name}`).data;
  const icon = sourceByName('app.ico'), brand = sourceByName('brand.png'); verifyBrandAssets(icon, brand);
  if (!sourceByName('Common.cs').toString('utf8').includes(`Version = "${VERSION}"`)) throw new Error('Desktop Shared.Version and build version differ.');
  const framework = resolve(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const csc = resolve(framework, 'csc.exe');
  const references = ['System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Security.dll','System.Web.Extensions.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','Microsoft.CSharp.dll','System.Xaml.dll'].map(x => `/r:${resolve(framework,x)}`);
  references.push(...['PresentationFramework.dll','PresentationCore.dll','WindowsBase.dll'].map(x => `/r:${resolve(framework,'WPF',x)}`));
  const common = resolve(root, 'products/adaptive-spot-desktop/Common.cs');
  const file = name => resolve(root, 'products/adaptive-spot-desktop', name);
  const brandedResources = [`/win32icon:${file('app.ico')}`, `/resource:${file('app.ico')},app.ico`, `/resource:${file('brand.png')},brand.png`, `/resource:${file('Theme.xaml')},theme.xaml`];
  const compile = (name, inputs, extras = []) => execFileSync(csc, ['/nologo','/target:winexe','/platform:x64','/optimize+', `/win32manifest:${file('app.manifest')}`, `/out:${resolve(stage,name)}`, ...references, ...brandedResources, ...extras, common, file('Ui.cs'), ...inputs.map(file)], { encoding:'utf8' });
  try { compile('AdaptiveSpotBot.exe', ['Desktop.cs'], [`/resource:${file('Desktop.xaml')},desktop.xaml`]); } catch(e) { throw new Error('Desktop compile failed:\n' + e.stdout + e.stderr); }
  const engine = sources.filter(e => /^(lib\/|scripts\/testnet\.mjs$|strategies\/virtual-only\.json$)/.test(e.path))
    .map(packagedEngineEntry);
  engine.push(...desktop.filter(e => ENGINE_DESKTOP_FILES.some(name=>e.path===`products/adaptive-spot-desktop/${name}`)).map(e => ({ path:'engine/'+e.path, data:e.data })));
  if(engine.some(e=>/fixture|\.test\.|license-service|\.env/i.test(e.path))) throw new Error('Test fixtures, server source and environments must not enter the buyer engine.');
  const payload = [
    { path:'AdaptiveSpotBot.exe', data:await readFile(resolve(stage,'AdaptiveSpotBot.exe')) },
    { path:'AdaptiveSpotBot.exe.config', data:await readFile(resolve(root,'products/adaptive-spot-desktop/app.config')) },
    { path:'app.ico', data:icon }, { path:'brand.png', data:brand },
    { path:'node.exe', data:runtime }, { path:'NODE-LICENSE.txt', data:notices },
    ...['QUICKSTART-EN.txt','QUICKSTART-ZH.txt'].map(n => ({ path:n, data:desktop.find(e => e.path.endsWith('/'+n)).data })), ...engine
  ];
  const manifest = Object.fromEntries(payload.map(e => [e.path,sha(e.data)]));
  payload.push({ path:'INSTALL-MANIFEST.json', data:Buffer.from(JSON.stringify(manifest,null,2)+'\n') });
  const payloadPath = resolve(stage,'payload.zip'); await writeFile(payloadPath, archive(payload), {flag:'wx'});
  try { compile('AdaptiveSpotBot-Testnet-Setup.exe',['Installer.cs','InstallerCore.cs'],[`/resource:${payloadPath},payload.zip`]); } catch(e) { throw new Error('Installer compile failed:\n' + e.stdout + e.stderr); }
  const setupName = 'AdaptiveSpotBot-Testnet-Setup.exe'; await copyFile(resolve(stage,setupName),resolve(output,setupName));
  const setupBytes = await readFile(resolve(output,setupName));
  const guides = payload.filter(e => e.path.startsWith('QUICKSTART'));
  for (const guide of guides) await writeFile(resolve(output,guide.path),guide.data,{flag:'wx'});
  const checksum = Buffer.from(`${sha(setupBytes)}  ${setupName}\n`);
  const qaNotice={path:'LOCKED-QA-DO-NOT-SELL.txt',data:Buffer.from('LOCKED QA ONLY — NOT AN ACTIVATED BUYER RELEASE\r\nThis package intentionally has no license-service configuration. It cannot start trading. Do not publish it as a paid active product.\r\n仅供离线验收，未配置授权服务，交易锁定，不可作为已激活商品销售。\r\n')};
  if(staging) await writeFile(resolve(output,qaNotice.path),qaNotice.data,{flag:'wx'});
  const buyer = archive([{path:setupName,data:setupBytes}, ...guides, {path:'SHA256SUMS.txt',data:checksum},...(staging?[qaNotice]:[])]);
  const sourceEntries = [...sources, ...desktop, {path:'DESKTOP-START-HERE.md',data:desktopFirstReadme(staging)}];
  sourceEntries.push({path:'SOURCE_MANIFEST.json',data:Buffer.from(JSON.stringify(sourceManifest(sourceEntries),null,2)+'\n')});
  const source = archive(sourceEntries);
  const buyerName = `AdaptiveSpotBot-Windows-Buyer-${VERSION}${staging?'-LOCKED-QA':''}.zip`, sourceName = `AdaptiveSpotBot-Developer-Source-${VERSION}${staging?'-LOCKED-QA':''}.zip`;
  await writeFile(resolve(output,buyerName),buyer,{flag:'wx'}); await writeFile(resolve(output,sourceName),source,{flag:'wx'});
  await writeFile(resolve(output,'SHA256SUMS.txt'),`${checksum}${sha(buyer)}  ${buyerName}\n${sha(source)}  ${sourceName}\n`,{flag:'wx'});
  await writeFile(resolve(output,'BUILD-MANIFEST.json'),JSON.stringify({version:VERSION, unsigned:true, mode:'BINANCE_SPOT_TESTNET_ONLY', subscriptionEnforcement:true, licensingConfigured, staging, saleReady:false,
    runtime:{version:'24.15.0',sha256:NODE_SHA,officialChecksums:'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt',licenseSha256:LICENSE_SHA},
    payload:manifest, brand:{iconSizes:[16,24,32,48,64,128,256], pngPixels:512}, sourceFiles:sourceManifest(sourceEntries).files},null,2)+'\n',{flag:'wx'});
  return { output, setup:resolve(output,setupName), buyer:resolve(output,buyerName), source:resolve(output,sourceName), setupBytes:setupBytes.length, buyerBytes:buyer.length };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args=process.argv.slice(2); if(![4,5].includes(args.length) || args[0]!=='--node' || args[2]!=='--license' || args.length===5 && args[4]!=='--staging') throw new Error('Usage: build.mjs --node <official node.exe> --license <official LICENSE> [--staging]');
  console.log(JSON.stringify(await build({node:args[1],license:args[3],staging:args[4]==='--staging'}),null,2));
}
