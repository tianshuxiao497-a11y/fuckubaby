import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SOURCE_FILES, assertSafeArchivePath, collectSources, crc32, createStoredZip, packageVirtual, sanitizeExample, standalonePackage } from '../scripts/package-virtual.mjs';

const blankEnv = 'BINANCE_TESTNET_API_KEY=\nBINANCE_TESTNET_API_SECRET=\nBINANCE_TESTNET_PRIVATE_KEY_PATH=\nTESTNET_SYMBOL=BTCUSDT\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'virtual-package-test-'));
  t.after(async () => {
    const absolute = resolve(root);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.match(absolute.split(/[\\/]/).at(-1), /^virtual-package-test-/);
    await rm(absolute, { recursive: true, force: true });
  });
  for (const name of SOURCE_FILES) {
    const target = join(root, ...name.split('/')); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, name.startsWith('.env') ? blankEnv : `// safe fixture: ${name}\n`);
  }
  return root;
}
function readStoredEntries(zip) {
  let offset = 0; const entries = new Map();
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    assert.equal(zip.readUInt16LE(offset + 10), 0);
    assert.equal(zip.readUInt16LE(offset + 12), 0x21);
    const length = zip.readUInt32LE(offset + 18); const nameLength = zip.readUInt16LE(offset + 26); const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength; const data = zip.subarray(start, start + length);
    assert.equal(crc32(data), zip.readUInt32LE(offset + 14)); entries.set(name, data); offset = start + length;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), entries.size);
  assert.equal(zip.readUInt32LE(zip.length - 6), offset);
  return entries;
}

test('allowlist excludes credentials, private keys, state, Next/live app and arbitrary paths', () => {
  for (const name of SOURCE_FILES) assert.equal(assertSafeArchivePath(name), name);
  for (const name of ['../docs/QUANT_PROGRAM.md', '/docs/QUANT_PROGRAM.md', 'C:/secret.txt', 'scripts\\testnet.mjs', '.env.testnet', '.secrets/testnet-ed25519-private.pem', '.paper-data/testnet-state.json', '.git/config', 'node_modules/pkg/index.js', 'Ubuntu.iso', 'live-dashboard/index.html', 'lib/live-market.mjs']) assert.throws(() => assertSafeArchivePath(name));
});

test('examples reject nonblank secrets and export all three credential fields blank, idempotently', () => {
  const name = '.env.testnet.tactical.example';
  const source = blankEnv.replace('PRIVATE_KEY_PATH=', 'PRIVATE_KEY_PATH=.secrets/testnet-ed25519-private.pem');
  const clean = sanitizeExample(name, source);
  assert.match(clean, /^BINANCE_TESTNET_API_KEY=$/m); assert.match(clean, /^BINANCE_TESTNET_API_SECRET=$/m); assert.match(clean, /^BINANCE_TESTNET_PRIVATE_KEY_PATH=$/m);
  assert.doesNotMatch(clean, /PRIVATE_KEY_PATH=\S/); assert.equal(sanitizeExample(name, clean), clean);
  for (const key of ['BINANCE_TESTNET_API_KEY', 'BINANCE_TESTNET_API_SECRET']) assert.throws(() => sanitizeExample(name, blankEnv.replace(`${key}=`, `${key}=do-not-export-this`)), /Nonblank credential/);
  assert.throws(() => sanitizeExample(name, blankEnv.replace('PRIVATE_KEY_PATH=', 'PRIVATE_KEY_PATH=C:/private.pem')), /Unexpected private-key path/);
  assert.throws(() => sanitizeExample(name, `${blankEnv}ACCESS_TOKEN=example`), /credential|Unexpected/);
  assert.throws(() => sanitizeExample('.env.testnet', source));
});

test('generated package is standalone with explicit pure tests and no installation/build hook', () => {
  const pkg = standalonePackage();
  assert.equal(pkg.engines.node, '>=24 <25'); assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts['virtual:run'], 'node scripts/virtual-trading.mjs --run');
  assert.equal(pkg.scripts['virtual:stop'], 'node scripts/virtual-trading.mjs --stop');
  assert.equal(pkg.scripts['virtual:adopt'], 'node scripts/virtual-trading.mjs --adopt');
  assert.equal(pkg.scripts['testnet:dashboard'], 'node --env-file-if-exists=.env.testnet scripts/testnet-dashboard.mjs');
  assert.match(pkg.scripts.test, /tests\/testnet-adaptive-integration\.test\.mjs/);
  assert.doesNotMatch(pkg.scripts.test, /live-|\*/);
  for (const name of ['preinstall', 'postinstall', 'prepare', 'start', 'dev', 'build']) assert.equal(pkg.scripts[name], undefined);
});

test('distribution includes the Chinese setup guide and links safe, explicit launch instructions', async t => {
  assert.ok(SOURCE_FILES.includes('docs/INSTALL_ZH.md'));
  const root = await fixture(t);
  const entries = await collectSources(root);
  const readme = entries.find(entry => entry.path === 'README.md').data.toString('utf8');
  assert.match(readme, /中文安装与使用手册/);
  assert.match(readme, /docs\/INSTALL_ZH\.md/);
  assert.match(readme, /npm\.cmd run virtual:run -- --enable-testnet-orders/);
  assert.match(readme, /不自动平仓或撤单/);
  assert.match(readme, /无需 npm install/);
  assert.match(readme, /不是发布者数字签名/);
});

test('distribution includes truthful English bot onboarding, not the offline replay product', async t => {
  assert.ok(SOURCE_FILES.includes('docs/INSTALL_EN.md'));
  const root = await fixture(t);
  const entries = await collectSources(root);
  const readme = entries.find(entry => entry.path === 'README.md').data.toString('utf8');
  assert.match(readme, /docs\/INSTALL_EN\.md/);
  assert.match(readme, /original automated Testnet bot/);
  assert.match(readme, /no\s+production adapter/);
  assert.match(readme, /some dashboard labels remain Chinese/);
  assert.match(readme, /Pre-commercial candidate/);
});

test('CRC32 matches a standard vector and deterministic ZIP entries reject traversal or duplicates', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const entries = [{ path: 'docs/QUANT_PROGRAM.md', data: Buffer.from('Guide') }, { path: 'README.md', data: Buffer.from('Readme') }];
  const zip = createStoredZip(entries); assert.deepEqual(createStoredZip([...entries].reverse()), zip);
  assert.equal(readStoredEntries(zip).get('docs/QUANT_PROGRAM.md').toString(), 'Guide');
  assert.throws(() => createStoredZip([{ path: '../README.md', data: Buffer.from('bad') }]));
  assert.throws(() => createStoredZip([entries[0], entries[0]]), /Duplicate/);
  assert.throws(() => createStoredZip([{ path: 'README.md', data: Buffer.alloc(2 * 1024 * 1024 + 1) }]), /size limit/);
});

test('source collection ignores unlisted secret/state files rather than reading or packaging them', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '.secrets')); await mkdir(join(root, '.paper-data'));
  const sentinel = 'PRIVATE_DECOY_MUST_NEVER_APPEAR';
  await writeFile(join(root, '.env.testnet'), sentinel); await writeFile(join(root, '.secrets', 'private.pem'), sentinel);
  await writeFile(join(root, '.paper-data', 'testnet-state.json'), sentinel); await writeFile(join(root, 'Ubuntu.iso'), sentinel);
  const sources = await collectSources(root);
  assert.equal(sources.length, SOURCE_FILES.length + 4);
  assert.ok(sources.every(entry => !entry.data.includes(Buffer.from(sentinel))));
  assert.equal(sources.filter(entry => entry.origin === 'sanitized-template').length, 5);
  assert.ok(!sources.some(entry => entry.path === '.env.testnet'));
  const result = await packageVirtual({ projectRoot: root, checkOnly: true });
  assert.equal(result.checked, true); assert.equal(result.sourceCount, SOURCE_FILES.length);
  assert.ok(!(await readdir(root)).includes('exports'));
});

test('missing mandatory sources and embedded private-key blocks fail closed', async t => {
  const missing = await fixture(t);
  await rm(join(missing, 'lib', 'testnet-bot.mjs'));
  await assert.rejects(collectSources(missing), /Missing mandatory source file: lib\/testnet-bot.mjs/);
  const key = await fixture(t);
  await writeFile(join(key, 'docs', 'QUANT_PROGRAM.md'), ['-----BEGIN PRIVATE KEY-----', 'A'.repeat(64), '-----END PRIVATE KEY-----'].join('\n'));
  await assert.rejects(collectSources(key), /Private-key material detected/);
});

test('ZIP, detached checksum and manifest agree, and exports are byte-reproducible without overwrite', async t => {
  const root = await fixture(t);
  const first = await packageVirtual({ projectRoot: root, now: '2026-10-17T01:02:03.000Z' });
  const second = await packageVirtual({ projectRoot: root, now: '2026-10-17T01:02:04.000Z' });
  const zip = await readFile(first.archivePath); const entries = readStoredEntries(zip);
  assert.deepEqual(await readFile(second.archivePath), zip); assert.equal(first.sha256, second.sha256);
  assert.equal(digest(zip), first.sha256); assert.equal(entries.size, SOURCE_FILES.length + 5);
  assert.match(await readFile(first.checksumPath, 'utf8'), new RegExp(`^${first.sha256}  virtual-quant-source-`));
  const internal = JSON.parse(entries.get('SOURCE_MANIFEST.json')); const external = JSON.parse(await readFile(first.manifestPath, 'utf8'));
  assert.equal(internal.sourceCount, SOURCE_FILES.length); assert.equal(external.archiveSha256, first.sha256);
  assert.equal(external.archiveBytes, zip.length); assert.equal(internal.files.length, entries.size - 1);
  for (const file of internal.files) { assert.equal(digest(entries.get(file.path)), file.sha256); assert.equal(entries.get(file.path).length, file.bytes); }
  await assert.rejects(packageVirtual({ projectRoot: root, now: '2026-10-17T01:02:03.000Z' }), /EEXIST/);
  assert.deepEqual(await readFile(first.archivePath), zip);
});

test('linked source directories and export destinations cannot escape the selected fixture', async t => {
  const root = await fixture(t);
  await rename(join(root, 'lib'), join(root, 'actual-lib'));
  try { await symlink(join(root, 'actual-lib'), join(root, 'lib'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This host cannot create a test link.'); return; } throw error; }
  await assert.rejects(collectSources(root), /non-linked source files/);
  const clean = await fixture(t); await mkdir(join(clean, 'other-output'));
  await symlink(join(clean, 'other-output'), join(clean, 'exports'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packageVirtual({ projectRoot: clean }), /Export directory must be a regular local directory/);
  assert.deepEqual(await readdir(join(clean, 'other-output')), []);
});
