import http from 'node:http';
import { randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { MainnetSpotClient } from './client.mjs';
import { LiveEngine, LIVE_VERSION, validateSettings } from './engine.mjs';
import { saveVault, loadVault } from './vault.mjs';
import { liveExternalStrategy } from './strategy.mjs';
import { reviewReport } from './review.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
export function defaultProfile() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'AdaptiveSpotBot', 'LivePersonal');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'AdaptiveSpotBot', 'LivePersonal');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'AdaptiveSpotBot', 'LivePersonal');
}

async function readBody(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 32768) throw new Error('REQUEST_TOO_LARGE');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('INVALID_JSON'); }
}
function safeError(error) {
  return /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'ACTION_FAILED_CHECK_LOCAL_CONFIGURATION';
}

export async function createLiveServer({ profile = defaultProfile(), port = 3012, clientFactory = credentials => new MainnetSpotClient(credentials), now = Date.now, pollMs = 5000, embeddingOrigin = null } = {}) {
  if(embeddingOrigin!==null){let url;try{url=new URL(embeddingOrigin);}catch{throw new Error('INVALID_WORKBENCH_ORIGIN');}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.origin!==embeddingOrigin)throw new Error('INVALID_WORKBENCH_ORIGIN');}
  if (!Number.isSafeInteger(pollMs) || pollMs < 20) throw new Error('INVALID_MONITOR_INTERVAL');
  const token = randomBytes(32).toString('hex');
  const vaultPath = resolve(profile, 'mainnet-vault.json');
  let engine = null, credentials = null, settings = null, closing = false, actionBusy = false;
  let preferences = {autoConnect: false}, nextCheckAt = Infinity, reconnectFailures = 0, generatedPair = null;
  let vaultExists = await lstat(vaultPath).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
  const logs = [];
  function record(event, code = null) {
    logs.push({time: now(), event, code});
    if (logs.length > 200) logs.shift();
  }
  function readPreferences(value) {
    if (value === undefined) return {autoConnect: false};
    if (!value || Object.keys(value).some(key => key !== 'autoConnect') || typeof value.autoConnect !== 'boolean') throw new Error('INVALID_CONNECTION_PREFERENCES');
    return {autoConnect: value.autoConnect};
  }
  let origin;
  const status = () => ({ version: LIVE_VERSION, environment: 'BINANCE_SPOT_MAINNET', running: engine?.running ?? false,
    connected: !!engine?.last?.accountChecked && !engine.error && now() >= engine.last.checkedAt && now() - engine.last.checkedAt <= 30000,
    unlocked: !!engine, vaultExists, settings, preferences, snapshot: engine?.last ?? null, error: engine?.error ?? null,
    pending: !!engine?.state?.pending, reconnecting: !!engine && preferences.autoConnect && reconnectFailures > 0,
    nextConnectionCheck: Number.isFinite(nextCheckAt) ? nextCheckAt : null, logs: logs.slice(-100), edition: 'personal' });
  async function replaceEngine(data) {
    if (engine?.running || engine?.busy || engine?.state?.pending) throw new Error('STOP_AND_RECONCILE_BEFORE_CONFIGURATION');
    const selected = validateSettings(data.settings);
    const selectedPreferences = readPreferences(data.preferences);
    if (engine?.state && Object.entries(engine.state.positions).some(([symbol, position]) => symbol !== selected.symbol && !position.dust)) throw new Error('CLOSE_OWNED_POSITION_BEFORE_SYMBOL_CHANGE');
    if (!data.credentials || Object.keys(data.credentials).some(key => !['apiKey', 'apiSecret', 'privateKeyPem'].includes(key)) || typeof data.credentials.apiKey !== 'string' || !data.credentials.apiKey.trim() || (!!data.credentials.apiSecret === !!data.credentials.privateKeyPem)) throw new Error('CHOOSE_ONE_PRODUCTION_SIGNATURE_METHOD');
    const candidateClient = clientFactory(data.credentials);
    if (engine) await engine.close();
    engine = null; credentials = null; settings = null; nextCheckAt = Infinity;
    const candidate = new LiveEngine({ profile, client: candidateClient, settings: selected, now, guard: () => !closing });
    await candidate.acquire();
    engine = candidate;
    credentials = data.credentials;
    settings = selected;
    preferences = selectedPreferences;
    reconnectFailures = 0;
    generatedPair = null;
  }

  async function monitor() {
    if (!engine || (!engine.running && !preferences.autoConnect) || actionBusy || engine.busy || closing || now() < nextCheckAt) return;
    try {
      const wasRunning = engine.running;
      await engine.check({execute: wasRunning});
      if (reconnectFailures) record('CONNECTION_RESTORED_MANUAL_START_REQUIRED');
      reconnectFailures = 0;
      nextCheckAt = now() + (engine.running ? 5000 : 15000);
    } catch (error) {
      reconnectFailures++;
      nextCheckAt = now() + Math.min(60000, 5000 * 2 ** Math.min(reconnectFailures - 1, 4));
      record('READ_ONLY_RECONNECT_WAIT', safeError(error));
    }
  }

  const server = http.createServer(async (request, response) => {
    const host = request.headers.host;
    const path = request.url;
    const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(embeddingOrigin?{}:{'X-Frame-Options':'DENY'}), 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors "+(embeddingOrigin??"'none'")+"; base-uri 'none'; form-action 'self'" };
    const reply = (code, value, extra = {}) => {
      response.writeHead(code, { ...security, 'Content-Type': 'application/json; charset=utf-8', ...extra });
      response.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    if (host !== new URL(origin).host) return reply(403, { error: 'LOCAL_HOST_REQUIRED' });
    try {
      if(request.method==='GET'&&path==='/fonts/AdaptiveNotoSansSC.woff2')return reply(200,await readFile(resolve(here,'../../futures-live-pilot/live/fonts/AdaptiveNotoSansSC.woff2')),{'Content-Type':'font/woff2'});
      const assets = new Map([['/', 'ui.html'], ['/ui.js', 'ui.js'], ['/ui.css', 'ui.css'], ['/example-live-strategy.json', 'example-live-strategy.json']]);
      if (request.method === 'GET' && assets.has(path)) {
        const file = assets.get(path);
        return reply(200, await readFile(resolve(here, file), 'utf8'), { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' });
      }
      const supplied = request.headers['x-asbl-session'];
      if (typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return reply(403, { error: 'LOCAL_SESSION_REQUIRED' });
      if (request.method === 'GET' && path === '/api/status') return reply(200, status());
      if (request.method === 'GET' && path === '/api/review') {
        if (!engine) throw new Error('UNLOCK_REQUIRED');
        return reply(200, reviewReport(engine), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="AdaptiveSpotBot-Live-Review.md"' });
      }
      if (request.method === 'GET' && path === '/api/history') {
        if (!engine) throw new Error('UNLOCK_REQUIRED');
        const fields = ['time','symbol','side','quantity','quote','status'];
        const csv = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
        const text = [fields.join(','), ...(engine.state?.orders ?? []).map(row => fields.map(key => csv(row[key])).join(','))].join('\r\n');
        return reply(200, '\uFEFF' + text, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="AdaptiveSpotBot-Live-Orders.csv"'});
      }
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return reply(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
      const body = await readBody(request);
      if (path === '/api/stop') {
        engine?.stop();
        record('MANUAL_STOP');
        return reply(200, status());
      }
      if (actionBusy || engine?.busy) throw new Error('ANOTHER_ACTION_IN_PROGRESS');
      actionBusy = true;
      try {
        if (path === '/api/save') {
          if (engine?.running || engine?.state?.pending) throw new Error('STOP_AND_RECONCILE_BEFORE_CONFIGURATION');
          if (typeof body.password !== 'string' || body.password !== body.passwordRepeat || body.password.length < 12) throw new Error('MATCHING_VAULT_PASSWORDS_REQUIRED');
          const data = { credentials: body.credentials, settings: validateSettings(body.settings), preferences: readPreferences(body.preferences) };
          await replaceEngine(data);
          try { await saveVault(vaultPath, data, body.password); }
          catch (error) { preferences.autoConnect = false; throw error; }
          vaultExists = true;
          nextCheckAt = preferences.autoConnect ? now() : Infinity;
          record('CONFIGURATION_SAVED');
        } else if (path === '/api/unlock') {
          await replaceEngine(await loadVault(vaultPath, body.password));
          nextCheckAt = preferences.autoConnect ? now() : Infinity;
          record('VAULT_UNLOCKED');
        } else if (path === '/api/lock') {
          if (engine?.running || engine?.state?.pending) throw new Error('STOP_AND_RECONCILE_BEFORE_CONFIGURATION');
          await engine?.close();
          engine = null; credentials = null; settings = null; generatedPair = null;
          nextCheckAt = Infinity; reconnectFailures = 0;
          record('VAULT_LOCKED');
        } else if (path === '/api/generate-key') {
          if (engine?.running || engine?.state?.pending) throw new Error('STOP_BEFORE_KEY_GENERATION');
          if (vaultExists && !engine) throw new Error('UNLOCK_TO_REUSE_EXISTING_KEYS');
          const existing = credentials?.privateKeyPem;
          if (existing) return reply(200, {publicKey: createPublicKey(createPrivateKey(existing)).export({type: 'spki', format: 'pem'}), privateKeyPem: existing, reused: true});
          const pairPath = resolve(profile, 'mainnet-registration-key.json');
          const pairExists = await lstat(pairPath).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
          if (pairExists) {
            const saved = await loadVault(pairPath, body.password);
            const derived = createPublicKey(createPrivateKey(saved.privateKeyPem)).export({type: 'spki', format: 'pem'});
            if (derived !== saved.publicKey) throw new Error('SAVED_REGISTRATION_KEY_MISMATCH');
            generatedPair = saved;
            return reply(200, {...saved, reused: true});
          }
          const pair = generateKeyPairSync('ed25519');
          generatedPair = {publicKey: pair.publicKey.export({type: 'spki', format: 'pem'}), privateKeyPem: pair.privateKey.export({type: 'pkcs8', format: 'pem'})};
          await saveVault(pairPath, generatedPair, body.password);
          record('REGISTRATION_PUBLIC_KEY_CREATED');
          return reply(200, {...generatedPair, reused: false});
        } else {
          if (!engine) throw new Error('SAVE_OR_UNLOCK_PRODUCTION_CONFIGURATION');
          if (path === '/api/check') { await engine.check(); reconnectFailures = 0; nextCheckAt = now() + 15000; record('ACCOUNT_CHECKED_READ_ONLY'); }
          else if (path === '/api/start') { await engine.start(body.confirmation); nextCheckAt = now(); record('REAL_STRATEGY_STARTED_BY_USER'); }
          else if (path === '/api/reconcile') {
            engine.stop();
            await engine.reconcile({ cancelOpen: body.cancelOpen === true });
            await engine.check();
          }
          else if (path === '/api/settings') {
            if (engine.running || engine.state?.pending) throw new Error('STOP_AND_RECONCILE_BEFORE_CONFIGURATION');
            const saved = await loadVault(vaultPath, body.password);
            const data = {credentials: saved.credentials, settings: validateSettings(body.settings), preferences: readPreferences(body.preferences)};
            await replaceEngine(data);
            await saveVault(vaultPath, data, body.password);
            nextCheckAt = preferences.autoConnect ? now() : Infinity;
            record('MARKET_AND_SIZING_UPDATED');
          }
          else if (path === '/api/strategy') {
            if (engine.running || engine.state?.pending || Object.keys(engine.state?.positions ?? {}).length) throw new Error('STRATEGY_CHANGE_REQUIRES_FLAT_STOPPED_ACCOUNT');
            const imported = body.text ? liveExternalStrategy(body.text) : { strategy: null, buyPercent: null };
            const updated = validateSettings({ ...settings, externalStrategy: imported.strategy, buyPercent: imported.buyPercent ?? settings.buyPercent });
            await loadVault(vaultPath, body.password);
            await saveVault(vaultPath, { credentials, settings: updated, preferences }, body.password);
            engine.settings = settings = updated;
            record(imported.strategy ? 'EXTERNAL_STRATEGY_IMPORTED' : 'BUILT_IN_STRATEGY_RESTORED');
          } else if (path === '/api/catalog') return reply(200, { symbols: await engine.catalog() });
          else if (path === '/api/review') {
            const report = reviewReport(engine);
            const folder = resolve(profile, 'reviews');
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await writeFile(resolve(folder, engine.last.day.date + '.md'), report, { mode: 0o600 });
          } else throw new Error('UNKNOWN_ACTION');
        }
        return reply(200, status());
      } finally { actionBusy = false; }
    } catch (error) { record('ACTION_FAILED', safeError(error)); return reply(400, { error: safeError(error) }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setInterval(monitor, pollMs);
  timer.unref();
  return {
    server, url: origin + '/#' + token, status, monitor,
    stop() {engine?.stop(); record('MANUAL_STOP');},
    async close() {
      closing = true;
      clearInterval(timer);
      engine?.stop();
      await new Promise(resolveClose => server.close(resolveClose));
      // An in-flight reconciliation must finish before releasing the profile.
      while (engine?.busy || actionBusy) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      await engine?.close();
    },
  };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '""', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).some(arg => !['--desktop', '--no-browser'].includes(arg))) throw new Error('UNSUPPORTED_LIVE_LAUNCH_ARGUMENT');
  createLiveServer().then(app => {
    console.log('Adaptive Spot Bot Live Personal ' + LIVE_VERSION);
    console.log('Local control page: ' + app.url);
    console.log('Configure, read-check, and explicitly confirm before real Spot orders can run.');
    if (!process.argv.includes('--no-browser')) openBrowser(app.url);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
    });
  }).catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
