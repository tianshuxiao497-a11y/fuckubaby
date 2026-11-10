import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Deliberately no globs or recursive directory traversal. Adding a distributable
// source file requires a reviewed change to this list.
export const SOURCE_FILES = Object.freeze([
  '.env.testnet.example', '.env.testnet.fast.example', '.env.testnet.cycle.example',
  '.env.testnet.tactical.example', '.env.testnet.adaptive.example',
  'lib/testnet-bot.mjs', 'lib/testnet-monitor.mjs', 'lib/virtual-trading-policy.mjs',
  'lib/adaptive-strategy.mjs', 'lib/testnet-commission.mjs', 'lib/external-testnet-strategy.mjs',
  'lib/atomic-json.mjs', 'lib/testnet-runner-lifecycle.mjs', 'lib/testnet-symbols.mjs', 'tests/testnet-multi-asset-integration.test.mjs',
  'scripts/testnet.mjs', 'scripts/testnet-keygen.mjs', 'scripts/testnet-dashboard.mjs',
  'scripts/testnet-start.ps1', 'scripts/testnet-dashboard-start.ps1',
  'scripts/virtual-trading.mjs', 'scripts/package-virtual.mjs',
  'strategies/virtual-only.json', 'docs/VIRTUAL_TRADING_LOGIC.md', 'docs/QUANT_PROGRAM.md',
  'docs/INSTALL_ZH.md', 'docs/INSTALL_EN.md',
  'dashboard/index.html', 'dashboard/app.js', 'dashboard/styles.css',
  'tests/testnet-bot.test.mjs', 'tests/testnet-monitor.test.mjs',
  'tests/testnet-fast.test.mjs', 'tests/testnet-cycle.test.mjs',
  'tests/testnet-tactical.test.mjs', 'tests/testnet-dashboard-ui.test.mjs',
  'tests/virtual-trading-policy.test.mjs', 'tests/testnet-adaptive.test.mjs',
  'tests/testnet-adaptive-integration.test.mjs', 'tests/testnet-commission.test.mjs',
  'tests/testnet-short-integration.test.mjs', 'tests/package-virtual.test.mjs',
  'tests/atomic-json.test.mjs', 'tests/testnet-persistence.test.mjs'
].sort());
const GENERATED_FILES = ['package.json', 'package-lock.json', 'README.md', '.gitignore', 'SOURCE_MANIFEST.json'];
const ARCHIVE_NAMES = new Set([...SOURCE_FILES, ...GENERATED_FILES]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 128;
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function assertSafeArchivePath(name) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\') || name.includes('\0') || isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe archive entry path.');
  if (!ARCHIVE_NAMES.has(name)) throw new Error(`File is not in the source allowlist: ${name}`);
  return name;
}
function inside(root, target) {
  const local = relative(root, target);
  return local !== '' && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
}

export function sanitizeExample(name, source) {
  if (!SOURCE_FILES.includes(name) || !/^\.env\.testnet(?:\.[a-z]+)?\.example$/.test(name)) throw new Error('Only explicitly approved environment examples may be sanitized.');
  const header = '# Exported template: all credential fields are blank. Configure private-key paths locally.';
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] === header) lines.shift();
  const required = new Set(['BINANCE_TESTNET_API_KEY', 'BINANCE_TESTNET_API_SECRET', 'BINANCE_TESTNET_PRIVATE_KEY_PATH']);
  const seen = new Set();
  const sanitized = lines.map(line => {
    if (!line.trim() || line.trimStart().startsWith('#')) return line;
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!assignment || seen.has(assignment[1])) throw new Error(`Invalid or duplicate example setting in ${name}`);
    const [, key, raw] = assignment; seen.add(key);
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key === 'BINANCE_TESTNET_PRIVATE_KEY_PATH') {
      // This public relative filename is not a credential. It is nevertheless
      // blanked in every exported template so no machine-specific path escapes.
      if (value && value !== '.secrets/testnet-ed25519-private.pem') throw new Error(`Unexpected private-key path in ${name}; refusing export.`);
      return `${key}=`;
    }
    if (/(?:API_?KEY|API_?SECRET|PASSWORD|PASSPHRASE|TOKEN|PRIVATE_?KEY)$/.test(key) && value) throw new Error(`Nonblank credential in ${name}; refusing export.`);
    if (!required.has(key) && !key.startsWith('TESTNET_')) throw new Error(`Unexpected example setting in ${name}; refusing export.`);
    if (required.has(key)) return `${key}=`;
    return line;
  });
  for (const key of required) if (!seen.has(key)) throw new Error(`Missing blank credential field in ${name}`);
  return `${header}\n${sanitized.join('\n').replace(/\n*$/, '')}\n`;
}
function auditText(name, source) {
  if (source.includes('\0')) throw new Error(`Unexpected binary content in ${name}`);
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,}-----END (?:[A-Z ]+ )?PRIVATE KEY-----/.test(source)) throw new Error(`Private-key material detected in ${name}; refusing export.`);
}

export function standalonePackage() {
  const tests = SOURCE_FILES.filter(name => name.startsWith('tests/') && name.endsWith('.test.mjs'));
  return {
    name: 'virtual-quant-testnet-source', version: '1.0.0', private: true, type: 'module',
    description: 'Standalone Binance Spot Testnet virtual-funds quant program. No production execution.',
    engines: { node: '>=24 <25' },
    scripts: {
      test: `node --test ${tests.join(' ')}`, check: 'node scripts/package-virtual.mjs --check',
      'virtual:describe': 'node scripts/virtual-trading.mjs --describe',
      'virtual:preview': 'node scripts/virtual-trading.mjs --preview',
      'virtual:run': 'node scripts/virtual-trading.mjs --run',
      'virtual:status': 'node scripts/virtual-trading.mjs --status',
      'virtual:adopt': 'node scripts/virtual-trading.mjs --adopt',
      'virtual:stop': 'node scripts/virtual-trading.mjs --stop',
      'testnet:market': 'node scripts/testnet.mjs --market',
      'testnet:validate': 'node --env-file-if-exists=.env.testnet scripts/testnet.mjs --validate',
      'testnet:status': 'node --env-file-if-exists=.env.testnet scripts/testnet.mjs --status',
      'testnet:preview': 'node --env-file-if-exists=.env.testnet scripts/testnet.mjs --once',
      'testnet:stop': 'node scripts/testnet.mjs --stop',
      'testnet:dashboard': 'node --env-file-if-exists=.env.testnet scripts/testnet-dashboard.mjs',
      'package:virtual': 'node scripts/package-virtual.mjs'
    }
  };
}
function generatedEntries() {
  const pkg = standalonePackage();
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, engines: pkg.engines } } };
  const readme = `# Adaptive Spot Bot — Binance Spot Testnet source candidate

**English: start with [installation and operation](docs/INSTALL_EN.md).**
This is the original automated Testnet bot, not the separate offline EMA replay app.
It can submit virtual Testnet orders after explicit local enablement. It has no
production adapter or live-money switch; some dashboard labels remain Chinese.
Pre-commercial candidate only: seller terms, product approval and payment setup
are not finalized. No person, exchange or payment platform endorses this package.

## 虚拟量化交易程序完整包（仅币安现货测试网）

**先阅读 [中文安装与使用手册](docs/INSTALL_ZH.md)。** 包含源码、策略配置、空白密钥模板、只读交易看板和离线测试；不含任何人的密钥、账户记录、日志或实盘交易模块。

## 从哪里开始

1. 安装 [Node.js 24](https://nodejs.org/en/download)，解压到新空文件夹。
2. 在该文件夹打开 PowerShell，先运行下方离线检查。无需 npm install，不需要 Python、Docker 或 Next.js。
3. 按中文手册自行配置本机测试网密钥，先只读预览，再明确开启虚拟委托。

\`\`\`text
node --version
node scripts/virtual-trading.mjs --describe
npm.cmd test
npm.cmd run check
\`\`\`

macOS / Linux 将 npm.cmd 换为 npm。解压、导入或默认 describe 都不会自动交易；不要为查看源码而再启动一个实例。已经在原电脑运行的用户，请先看中文手册的“原电脑续用与迁移”部分。

## 常用入口（完成配置后）

| 用途 | 命令 |
| --- | --- |
| 只读信号预览，不下单 | \`npm.cmd run virtual:preview\` |
| 读取测试网账户 | \`npm.cmd run virtual:status\` |
| 明确启用测试网自动交易 | \`npm.cmd run virtual:run -- --enable-testnet-orders\` |
| 另开终端启动只读看板 | \`npm.cmd run testnet:dashboard\` |
| 请求安全停止，不自动平仓或撤单 | \`npm.cmd run virtual:stop\` |

看板地址：[http://127.0.0.1:3001/](http://127.0.0.1:3001/)。只在本机可见，网页不是交易开关。运行时不要关闭交易终端；断网、休眠和停止都会使本机保护性退出无法执行。

## 当前默认策略

v3 adaptive short，BTCUSDT，约每 5 秒检查；有确认信号才下单，不是定时强买强卖。每轮最多 100 虚拟 USDT，按 40 / 30 / 30 分批；1 分钟为有条件软退出，默认 3 分钟为本机最长持仓退出规则，网络故障可导致延迟。它不是高频交易平台，也不保证盈利或成交频率。

- [中文安装、全部可调配置与排错](docs/INSTALL_ZH.md)
- [English installation, security and recovery](docs/INSTALL_EN.md)
- [详细策略规则与兼容版本参考](docs/VIRTUAL_TRADING_LOGIC.md)
- [开发者使用与安全设计参考](docs/QUANT_PROGRAM.md)
- [当前可执行策略配置](strategies/virtual-only.json)
- [.env 空白配置模板](.env.testnet.adaptive.example)

SOURCE_MANIFEST.json 记录包内文件的 SHA-256；压缩包旁的 .sha256 校验 ZIP。校验值只检查文件一致性，不是发布者数字签名，也不是收益证明。发布 GitHub 时只分享干净源码，绝不上传实际 .env.testnet、.secrets/ 或 .paper-data/。
`;
  const ignore = '# Runtime credentials and account records never belong in source exports.\n.env\n.env.*\n!.env.testnet*.example\n.secrets/\n.paper-data/\nexports/\nnode_modules/\n*.pem\n*.key\n*.log\n';
  return [['package.json', json(pkg)], ['package-lock.json', json(lock)], ['README.md', readme], ['.gitignore', ignore]].map(([path, text]) => ({ path, data: Buffer.from(text), origin: 'generated' }));
}

export async function collectSources(projectRoot) {
  const root = await realpath(resolve(projectRoot));
  const entries = []; let total = 0;
  for (const name of SOURCE_FILES) {
    assertSafeArchivePath(name);
    const absolute = resolve(root, ...name.split('/'));
    if (!inside(root, absolute)) throw new Error('Source escaped the selected project directory.');
    const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') throw new Error(`Missing mandatory source file: ${name}`); throw error; });
    if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`Only regular, non-linked source files may be exported: ${name}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`Source file exceeds export size limit: ${name}`);
    const original = await readFile(absolute); const text = original.toString('utf8'); auditText(name, text);
    const template = name.startsWith('.env.testnet');
    const data = template ? Buffer.from(sanitizeExample(name, text)) : original;
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Source package exceeds total export size limit.');
    entries.push({ path: name, data, origin: template ? 'sanitized-template' : 'source' });
  }
  return [...entries, ...generatedEntries()].sort(byPath);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// ZIP STORE, UTF-8 paths, fixed 1980-01-01 timestamps: identical source bytes
// produce identical ZIP bytes regardless of host clock or filesystem mtimes.
export function createStoredZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_FILES) throw new Error('Invalid ZIP entry count.');
  const names = new Set(); const localParts = []; const centralParts = []; let offset = 0; let total = 0;
  for (const entry of [...entries].sort(byPath)) {
    assertSafeArchivePath(entry.path);
    if (names.has(entry.path)) throw new Error('Duplicate ZIP entry.'); names.add(entry.path);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    total += data.length;
    if (data.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('ZIP content exceeds export size limit.');
    const name = Buffer.from(entry.path, 'utf8'); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x20, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, data); centralParts.push(central, name); offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function packageVirtual({ projectRoot = fileURLToPath(new URL('../', import.meta.url)), now = new Date(), checkOnly = false } = {}) {
  const root = await realpath(resolve(projectRoot)); const entries = await collectSources(root);
  const manifest = {
    formatVersion: 1, mode: 'BINANCE_SPOT_TESTNET_ONLY', archiveFormat: 'ZIP_STORE',
    reproducibleTimestamps: '1980-01-01T00:00:00Z', sourceCount: SOURCE_FILES.length,
    fileCountExcludingManifest: entries.length,
    files: entries.map(entry => ({ path: entry.path, bytes: entry.data.length, sha256: sha256(entry.data), origin: entry.origin }))
  };
  if (checkOnly) return { checked: true, sourceCount: SOURCE_FILES.length, fileCount: entries.length + 1, contentBytes: entries.reduce((sum, entry) => sum + entry.data.length, 0) };
  const date = new Date(now); if (!Number.isFinite(date.getTime())) throw new Error('Invalid package timestamp.');
  const stamp = date.toISOString().replace(/[-:.]/g, '');
  const filename = `virtual-quant-source-${stamp}.zip`;
  const outputRoot = resolve(root, 'exports');
  const existing = await lstat(outputRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(outputRoot) !== outputRoot)) throw new Error('Export directory must be a regular local directory, not a link.');
  await mkdir(outputRoot, { recursive: true });
  if (!inside(root, await realpath(outputRoot))) throw new Error('Export directory escaped the project.');
  const archive = createStoredZip([...entries, { path: 'SOURCE_MANIFEST.json', data: Buffer.from(json(manifest)), origin: 'generated' }]);
  const checksum = sha256(archive); const archivePath = resolve(outputRoot, filename);
  // Exclusive creation never replaces an existing deliverable. No source or
  // runtime file is edited or removed by this exporter.
  await writeFile(archivePath, archive, { flag: 'wx' });
  const checksumPath = `${archivePath}.sha256`; const manifestPath = `${archivePath}.manifest.json`;
  await writeFile(checksumPath, `${checksum}  ${filename}\n`, { flag: 'wx' });
  await writeFile(manifestPath, json({ ...manifest, archive: filename, archiveBytes: archive.length, archiveSha256: checksum }), { flag: 'wx' });
  return { archivePath, checksumPath, manifestPath, sha256: checksum, archiveBytes: archive.length, sourceCount: SOURCE_FILES.length, fileCount: entries.length + 1 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/package-virtual.mjs [--check]');
    console.log('Export explicitly allowlisted Testnet source to exports/*.zip, with SHA-256 and manifest. No credentials, account, network or bot actions.'); return;
  }
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') throw new Error('Only --check or --help is supported.');
  console.log(JSON.stringify(await packageVirtual({ checkOnly: args.includes('--check') }), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
