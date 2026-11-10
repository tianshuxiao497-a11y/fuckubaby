import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { DESKTOP_FILES, ENGINE_DESKTOP_FILES, LICENSED_ENTRY_PRELUDE, VERSION, sourceManifest, sha, packagedLicenseConfig, packagedEngineEntry } from './build.mjs';
import { ICON_SIZES, encodeIco, verifyBrandAssets } from './brand-assets.mjs';

test('desktop build ships the reviewed WPF and original multi-resolution assets only', () => {
  assert.equal(VERSION, '0.5.3');
  for (const name of ['Ui.cs','Desktop.xaml','Theme.xaml','InstallerCore.cs','app.ico','brand.png','brand.svg','brand-assets.mjs','desktop-build.test.mjs']) assert.ok(DESKTOP_FILES.includes(name), name);
  assert.equal(new Set(DESKTOP_FILES).size, DESKTOP_FILES.length);
  for (const name of DESKTOP_FILES) assert.match(name, /^[A-Za-z0-9.\-]+$/);
  for (const name of DESKTOP_FILES) assert.ok(!/env|secret|credential|paper-data|seller-kit/i.test(name), name);
});

test('brand PNG and all Windows icon sizes have verified dimensions', async () => {
  const [icon, png, svg] = await Promise.all(['app.ico','brand.png','brand.svg'].map(name => readFile(new URL(name,import.meta.url))));
  assert.deepEqual(verifyBrandAssets(icon, png), {sizes:[16,24,32,48,64,128,256],pngSize:512});
  assert.ok(!/binance|script|foreignObject|href=|https?:/i.test(svg.toString('utf8').replace('http://www.w3.org/2000/svg','')));
  const frames = ICON_SIZES.map((size,index) => { const entry=6+index*16; const length=icon.readUInt32LE(entry+8),offset=icon.readUInt32LE(entry+12); return {size,data:icon.subarray(offset,offset+length)}; });
  assert.deepEqual(encodeIco(frames),icon);
  assert.throws(()=>encodeIco(frames.slice(1)));
  assert.throws(()=>encodeIco([{size:16,data:Buffer.from('fake')},...frames.slice(1)]));
  const corrupted=Buffer.from(icon); corrupted.writeUInt32LE(0,18); assert.throws(()=>verifyBrandAssets(corrupted,png));
});

test('whole-source manifest is sorted and inventories actual bytes', () => {
  const entries=[{path:'b.js',data:Buffer.from('beta')},{path:'a.js',data:Buffer.from('alpha')}];
  const result=sourceManifest(entries);
  assert.equal(result.version,VERSION);
  assert.deepEqual(result.files,[{path:'a.js',bytes:5,sha256:sha(Buffer.from('alpha'))},{path:'b.js',bytes:4,sha256:sha(Buffer.from('beta'))}]);
  assert.deepEqual(sourceManifest([...entries].reverse()),result);
});

test('release packaging refuses incomplete entitlement config; staging is always locked even with valid source config', () => {
  const pair=generateKeyPairSync('ed25519');
  const valid={endpoint:'https://license.example.com/api/validate',publicKey:pair.publicKey.export({type:'spki',format:'pem'}),companyId:'biz_test',productId:'prod_test',planIds:['plan_monthly']};
  assert.deepEqual(packagedLicenseConfig(valid),valid);
  for(const value of [undefined,{}, {...valid,endpoint:''},{...valid,planIds:[]},{...valid,merchantApiKey:'not-allowed'}]) assert.throws(()=>packagedLicenseConfig(value),/Release blocked/);
  const locked={endpoint:'',publicKey:'',companyId:'',productId:'',planIds:[]};
  assert.deepEqual(packagedLicenseConfig(valid,true),locked);
  assert.deepEqual(packagedLicenseConfig(undefined,true),locked);
  assert.notEqual(packagedLicenseConfig(valid,true),valid);
});

test('buyer engine allowlist excludes fixtures/server/secrets and gates the derived CLI entry without changing source', () => {
  assert.deepEqual(ENGINE_DESKTOP_FILES,['controller.mjs','worker.mjs','license.mjs','license-device.mjs','device-protocol.mjs','device-identity.mjs','entrypoint-gate.mjs','license-config.json']);
  for(const name of ENGINE_DESKTOP_FILES) { assert.ok(DESKTOP_FILES.includes(name)); assert.ok(!/fixture|test\.|service|secret|private|\.env/i.test(name)); }
  const original={path:'scripts/testnet.mjs',data:Buffer.from('export const sample = 1;\n')};
  const result=packagedEngineEntry(original);
  assert.equal(result.path,'engine/scripts/testnet.mjs');
  assert.equal(result.data.toString(),LICENSED_ENTRY_PRELUDE+original.data.toString());
  assert.match(LICENSED_ENTRY_PRELUDE,/import \{ assertLicensedDesktopEntry \} from '\.\.\/products\/adaptive-spot-desktop\/entrypoint-gate\.mjs';\nassertLicensedDesktopEntry\(\);/);
  assert.equal(original.data.toString(),'export const sample = 1;\n');
  assert.equal(packagedEngineEntry({path:'lib/example.mjs',data:original.data}).data,original.data);
});

test('desktop UI keeps activation and account work serialized, labels missing service locked and does not start automatically', async () => {
  const ui=await readFile(new URL('./Desktop.cs',import.meta.url),'utf8');
  assert.match(ui,/bool requestedConnect=connectAfterSave; connectAfterSave=false/);
  assert.match(ui,/if\(RestoreLicense\(\)\) connectAfterLicense=requestedConnect;\s*else if\(requestedConnect\) Read\("connect"\)/);
  assert.match(ui,/if\(!licenseWorking && connectAfterLicense\) \{ connectAfterLicense=false; Read\("connect"\); \}/);
  assert.match(ui,/if\(preview \|\| !ready \|\| running \|\| closing \|\| working \|\| licenseWorking\) return/);
  assert.match(ui,/configured && !working && !licenseWorking && !preview/);
  assert.match(ui,/授权服务未配置 · 交易已锁定/);
  assert.match(ui,/expiry\.Value<=253402300799999d/);
  const restore=ui.slice(ui.indexOf('bool RestoreLicense()'),ui.indexOf('void ActivateLicense'));
  assert.doesNotMatch(restore,/Send\("start"/);
  assert.doesNotMatch(ui,/未接入订阅权限校验/);
});

test('0.3.0 guides disclose verification cadence, stop risks and older-version limits without false readiness', async () => {
  const [en,zh,readme]=await Promise.all(['QUICKSTART-EN.txt','QUICKSTART-ZH.txt','README.md'].map(name=>readFile(new URL(name,import.meta.url),'utf8')));
  for(const text of [en,zh,readme]) { assert.match(text,/0\.3\.0/); assert.match(text,/30/); assert.match(text,/120/); assert.match(text,/0\.2\.0/); assert.match(text,/LOCKED.QA/); }
  assert.match(en,/LOCAL RISK RULES STOP TOO/);
  assert.match(en,/does NOT remotely stop/);
  assert.match(zh,/本机止盈止损等保护也随之停止/);
  assert.match(readme,/not a sale-readiness certificate/);
  assert.doesNotMatch(en,/No subscription entitlement integration/);
  assert.doesNotMatch(zh,/未接 Whop 订阅验证/);
});

test('installer describes the included subscription gate without claiming a final release', async () => {
  const installer=await readFile(new URL('./Installer.cs',import.meta.url),'utf8');
  assert.match(installer,/联网订阅校验 · 到期停止新任务/);
  assert.match(installer,/未签名候选版/);
  assert.doesNotMatch(installer,/不含[^"\n]*订阅校验/);
});
