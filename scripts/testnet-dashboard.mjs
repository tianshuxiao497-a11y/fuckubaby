import { createServer } from 'node:http';
import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TestnetClient, readConfig } from '../lib/testnet-bot.mjs';
import { monitorActivity, monitorSnapshot, validateMonitorState } from '../lib/testnet-monitor.mjs';

const config = readConfig();
const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim() || '';
const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim() || '';
const privateKeyPath = process.env.BINANCE_TESTNET_PRIVATE_KEY_PATH?.trim();
const privateKey = privateKeyPath ? createPrivateKey(await readFile(resolve(privateKeyPath))) : null;
if (!apiKey || (!apiSecret && !privateKey)) throw new Error('本机测试网配置不完整。');
const client = new TestnetClient({ apiKey, apiSecret, privateKey, allowOrders: false });
const port = 3001;
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
let snapshot;
let inFlight;
async function readJson(path) {
  try { return JSON.parse(await readFile(resolve('.paper-data', path), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本机测试记录暂时无法读取。'); }
}
async function refresh() {
  if (snapshot && Date.now() - snapshot.updatedAt < (config.strategy === 'fast' ? 5_000 : 20_000)) return snapshot;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const state = validateMonitorState(await readJson('testnet-state.json'), config, apiKey);
    const heartbeat = await readJson('testnet-heartbeat.json');
    let alive = false;
    if (Number.isSafeInteger(heartbeat?.pid) && heartbeat.pid > 0) {
      try { process.kill(heartbeat.pid, 0); alive = true; } catch { /* process not available */ }
    }
    const activity = monitorActivity(heartbeat, config, state.accountTag, Date.now(), alive);
    const value = await monitorSnapshot(client, config, state, activity);
    snapshot = value;
    return value;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

const server = createServer(async (request, response) => {
  // Prevent public binding, DNS rebinding, cross-origin access and write routes.
  const host = request.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || (request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin))) {
    response.writeHead(403).end('Local access only'); return;
  }
  if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end('Read-only monitor'); return; }
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  };
  const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (path === '/api/snapshot') {
    try {
      const value = await refresh();
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(503, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message, updatedAt: null }));
    }
  } else if (files.has(path)) {
    const [name, type] = files.get(path);
    try { response.writeHead(200, { ...headers, 'Content-Type': type }).end(await readFile(resolve('dashboard', name))); }
    catch { response.writeHead(500).end('Monitor asset unavailable'); }
  } else if (path === '/favicon.ico') response.writeHead(204).end();
  else response.writeHead(404).end('Not found');
});
server.listen(port, '127.0.0.1', () => console.log(`虚拟交易看板：http://127.0.0.1:${port}（仅本机，只读，不是演示余额）`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '看板端口 3001 已被占用，请先确认已有服务。' : '看板启动失败。'); process.exitCode = 1; });
