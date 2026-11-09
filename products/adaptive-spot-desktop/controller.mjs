import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, open, lstat, unlink, readdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { TestnetClient, readConfig } from '../../lib/testnet-bot.mjs';
import { policyEnvironment } from '../../lib/virtual-trading-policy.mjs';
import { validateMonitorState, monitorActivity, monitorSnapshot } from '../../lib/testnet-monitor.mjs';
import { createLicenseManager } from './license-device.mjs';
import { atomicWriteJson } from '../../lib/atomic-json.mjs';
import { testnetSymbol, testnetCatalog } from '../../lib/testnet-symbols.mjs';

export function verifiedAccountUid(account) {
  const value = account?.uid;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  return null;
}
export function verifiedOrderIdentity(order, symbol, orderId) {
  const id = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) :
    typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
  if (!order || order.symbol !== symbol || !id(order.orderId) || id(order.orderId) !== id(orderId) ||
      order.status !== 'FILLED' || !['BUY', 'SELL'].includes(order.side) ||
      typeof order.clientOrderId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(order.clientOrderId) ||
      !Number.isSafeInteger(order.time) || order.time <= 0 ||
      ![order.origQty, order.executedQty].every(x => typeof x === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(x) && Number(x) > 0)) return null;
  return { symbol, orderId: id(order.orderId), clientOrderId: order.clientOrderId, time: order.time,
    side: order.side, origQty: order.origQty, executedQty: order.executedQty, status: 'FILLED' };
}

export function cleanEnvironment(input = {}) {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE']
    .filter(key => typeof input[key] === 'string').map(key => [key, input[key]]));
}
export function validateCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['apiKey', 'apiSecret', 'privateKeyPath'].includes(k))) throw new Error('Invalid credential fields.');
  const c = Object.fromEntries(['apiKey', 'apiSecret', 'privateKeyPath'].map(k => [k, String(value[k] ?? '').trim()]));
  if (!/^[A-Za-z0-9]{16,256}$/.test(c.apiKey)) {
    if (/^apik_/i.test(c.apiKey)) throw new Error('这里填币安 Spot Testnet 的 API Key，不是 Whop 商户 API 密钥。软件许可证请填“订阅授权”页。');
    if (/-----BEGIN|[\r\n]|[+/=]/.test(c.apiKey)) throw new Error('这里不能填 PEM 公钥或私钥。请先把公钥注册到币安测试网，再复制测试网生成的 API Key；私钥文件在下方选择。');
    if (c.apiKey.includes('-')) throw new Error('这里填币安 Spot Testnet 的 API Key，不是软件许可证。Whop 授权码只填“订阅授权”页。');
    throw new Error('请从币安 Spot Testnet 复制 API Key；不能填公钥、PEM 路径或 Whop 软件许可证。');
  }
  if (Boolean(c.apiSecret) === Boolean(c.privateKeyPath)) throw new Error('请选择一种签名方式：填写 Ed25519 私钥 PEM 路径，或填写 HMAC Secret；不要同时填写。');
  if (c.apiSecret && !/^[A-Za-z0-9]{16,256}$/.test(c.apiSecret)) throw new Error('Invalid HMAC secret.');
  if (c.privateKeyPath && (!isAbsolute(c.privateKeyPath) || /[\r\n\0]/.test(c.privateKeyPath))) throw new Error('请选择本机 Ed25519 私钥 PEM 文件，或粘贴该文件的完整路径；不能填公钥内容。');
  return c;
}
async function keyFile(path) {
  let stat; try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('密钥文件类型或大小异常；原文件已保留，请人工核对。');
  return readFile(path);
}
export async function storedKeyPair(profile) {
  try { const dir = await lstat(resolve(profile, 'keys')); if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('密钥目录异常，请保留原目录并人工核对。'); }
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
  const privateKeyPath = resolve(profile, 'keys/testnet-private.pem'), publicKeyPath = resolve(profile, 'keys/testnet-public.pem');
  const [privateBytes, publicBytes] = await Promise.all([keyFile(privateKeyPath), keyFile(publicKeyPath)]);
  if (!privateBytes) {
    if (publicBytes) throw new Error('已有公钥但配套私钥缺失；不会生成新私钥冒充原密钥，请找回原私钥。');
    return { exists: false };
  }
  let privateKey, publicKey;
  try {
    privateKey = createPrivateKey(privateBytes);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
    publicKey = createPublicKey(privateKey);
    if (publicBytes && !createPublicKey(publicBytes).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
  } catch { throw new Error('已有密钥无法解析，或公私钥不配套。原文件已保留，不会覆盖，请核对正确的 Ed25519 密钥。'); }
  return { exists: true, privateKeyPath, publicKeyPath, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), publicFileExists: !!publicBytes };
}
export function credentialEnvironment(c) {
  return { BINANCE_TESTNET_API_KEY: c.apiKey, BINANCE_TESTNET_API_SECRET: c.apiSecret,
    BINANCE_TESTNET_PRIVATE_KEY_PATH: c.privateKeyPath };
}
export function mayStart(message, connected, busy, locked) {
  if (message.confirmVirtualOnly !== true || message.confirmNoOtherBot !== true) throw new Error('Explicit virtual-funds and single-account-instance confirmation required.');
  if (!connected) throw new Error('Test the read-only connection successfully first.');
  if (busy || locked) throw new Error('An active worker or retained safety lock exists. Stop and reconcile first; never delete records to force a restart.');
}
export function redact(text, credentials) {
  let result = String(text).replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, '[private key redacted]');
  for (const value of [credentials?.apiKey, credentials?.apiSecret, credentials?.privateKeyPath].filter(Boolean)) result = result.split(value).join('[redacted]');
  return result.slice(0, 12000);
}

export async function createController({ profile, emit, spawnImpl = spawn, clientFactory = options => new TestnetClient(options), policy, env = process.env, licenseFactory = createLicenseManager, now = Date.now }) {
  if (!isAbsolute(profile)) throw new Error('Absolute private profile required.');
  const marketProfileFor = symbol => { testnetSymbol(symbol);return symbol==='BTCUSDT'?profile:resolve(profile,'markets',symbol); };
  async function ensureMarketDirectory(symbol){
    const marketProfile=marketProfileFor(symbol);
    for(const part of symbol==='BTCUSDT'?[profile,resolve(profile,'.paper-data')]:[profile,resolve(profile,'markets'),marketProfile,resolve(marketProfile,'.paper-data')]){
      await mkdir(part,{recursive:true});const stat=await lstat(part);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('交易记录目录异常，请保留文件并核对。');
    }
    return marketProfile;
  }
  let overrides=policyEnvironment(policy,{}),config=readConfig(overrides);
  try{
    const saved=JSON.parse(await readFile(resolve(profile,'market-selection.json'),'utf8'));
    if(saved?.version!==1||Object.keys(saved).length!==2)throw new Error('Invalid saved market selection.');testnetSymbol(saved.symbol);
    overrides=policyEnvironment({...policy,symbol:saved.symbol},{});config=readConfig(overrides);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  let marketProfile=await ensureMarketDirectory(config.symbol),data=resolve(marketProfile,'.paper-data');
  let catalog=[],catalogAt=0,marketVerified=config.symbol==='BTCUSDT';
  let credentials, client, connected = false, worker, stopping = false, readJob;
  let closing = false, operation = false, stopGeneration = 0, revision=0;
  let autoConnect = false, nextConnectionCheck = Infinity, connectionFailures = 0;
  let reviewRequired = false;
  let licenseDiagnostic = Promise.resolve();
  const send = value => emit(value);
  const license = licenseFactory({ profile, onChange: value => {
    send(value);
    const diagnostic={checkedAt:new Date().toISOString(),status:value.status,active:value.active===true,
      errorCode:value.lastErrorCode??null,requestMs:value.lastRequestMs??null};
    licenseDiagnostic=licenseDiagnostic.then(()=>writeFile(resolve(data,'license-network-status.json'),JSON.stringify(diagnostic),{mode:0o600})).catch(()=>{});
    if (value.active && !stopping && worker?.connected && typeof worker.send === 'function') {
      try { worker.send({command:'licenseLease',token:license.token()},()=>{}); } catch { stop().catch(()=>{}); }
    }
  }, onInvalid: async () => {
    if(!worker)return;
    send({type:'notice',text:'Subscription expired or could not be verified. Trading is stopping; positions and records are preserved. Local protections will stop too. Reconcile positions manually.'});
    await stop();
  } });
  const exists = async path => { try { await readFile(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  const json = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Local records unreadable; preserve and reconcile them.'); } };
  async function storedSymbols(){
    const result=new Set(['BTCUSDT',config.symbol]);
    try{
      const parent=await lstat(resolve(profile,'markets'));if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('交易记录目录异常，请先核对。');
      for(const entry of await readdir(resolve(profile,'markets'),{withFileTypes:true})){
      try{testnetSymbol(entry.name);}catch{continue;}
      if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('交易记录目录异常，请先核对。');result.add(entry.name);
    }}catch(error){if(error.code!=='ENOENT')throw error;}
    return [...result];
  }
  const anyMarketLock=async()=>{for(const symbol of await storedSymbols())if(await exists(resolve(marketProfileFor(symbol),'.paper-data/testnet-bot.lock')))return true;return false;};
  async function loadCatalog(){
    const publicClient=client??clientFactory({allowOrders:false});
    const next=testnetCatalog(await publicClient.request('GET','/api/v3/exchangeInfo'));
    catalog=next;catalogAt=Date.now();marketVerified=catalog.some(x=>x.symbol===config.symbol);
    const all=new Map(catalog.map(x=>[x.symbol,x]));
    for(const symbol of await storedSymbols())if(!all.has(symbol))all.set(symbol,{symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',eligible:false});
    return {type:'markets',symbol:config.symbol,items:[...all.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol))};
  }
  async function selectSymbol(symbol){
    testnetSymbol(symbol);
    if(worker||readJob||stopping||await anyMarketLock())throw new Error('先安全停止当前机器人并核对交易锁，再切换交易对。');
    if(symbol===config.symbol)return {type:'symbolChanged',symbol,requiresCredentialRebind:false};
    const generation=stopGeneration,saved=await state();
    if(saved.position||saved.pending)throw new Error('当前交易对还有程序持仓或待核对委托，不能切换；请先核对并处理。');
    if(!catalogAt||Date.now()-catalogAt>300000)await loadCatalog();
    const eligible=catalog.some(x=>x.symbol===symbol);
    if(!eligible&&!(await storedSymbols()).includes(symbol))throw new Error('币安测试网未提供此 USDT 现货交易对，不能启用。');
    const nextOverrides=policyEnvironment({...policy,symbol},{}),nextConfig=readConfig(nextOverrides);
    const nextProfile=await ensureMarketDirectory(symbol),nextData=resolve(nextProfile,'.paper-data');
    const target=await json(resolve(nextData,'testnet-state.json'));let requiresCredentialRebind=false;
    if(credentials){
      try{validateMonitorState(target,nextConfig,credentials.apiKey);}
      catch(error){
        const expected=validateMonitorState(null,nextConfig,credentials.apiKey);
        if(!target||target.accountTag===expected.accountTag)throw error;
        validateMonitorState({...target,accountTag:expected.accountTag},nextConfig,credentials.apiKey);requiresCredentialRebind=true;
      }
    }else if(target)throw new Error('先保存测试网配置，再切换已有记录的交易对。');
    if(closing||generation!==stopGeneration||await anyMarketLock())throw new Error('切换已取消：当前工作或停止状态发生变化。');
    await atomicWriteJson(resolve(profile,'market-selection.json'),{version:1,symbol});
    overrides=nextOverrides;config=nextConfig;marketProfile=nextProfile;data=nextData;connected=false;marketVerified=eligible;revision++;
    nextConnectionCheck = Infinity;
    if(requiresCredentialRebind)client=null;
    return {type:'symbolChanged',symbol,eligible,requiresCredentialRebind};
  }
  async function credentialClient(value) {
    const next = validateCredentials(value);
    let privateKey;
    if (next.privateKeyPath) {
      try { const bytes = await keyFile(next.privateKeyPath); if (!bytes) throw new Error(); privateKey = createPrivateKey(bytes); if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(); }
      catch { throw new Error('找不到可用的 Ed25519 私钥文件。请选择 testnet-private.pem，不要选 testnet-public.pem；原文件不会被修改。'); }
    }
    return { next, client: clientFactory({ apiKey: next.apiKey, apiSecret: next.apiSecret, privateKey, allowOrders: false }),
      publicKey: privateKey ? createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) : '' };
  }
  async function accountFor(c) {
    await c.syncTime();
    const account = await c.request('GET', '/api/v3/account', { omitZeroBalances: true }, true);
    if (!Array.isArray(account?.balances)) throw new Error('测试网账户响应无效，不能接续旧记录。原配置与记录已保留。');
    return account;
  }
  async function rotateCredentials(m) {
    connected = false; client = null;
    if (m.confirmSameTestnetAccount !== true) throw new Error('需要明确确认：只为同一个测试网账户更换 API。');
    if (worker || readJob || closing || await anyMarketLock()) throw new Error('先安全停止并核对交易锁，再更换 API。');
    const next = await credentialClient(m.credentials);
    const statePath = resolve(data, 'testnet-state.json');
    const identityPath = resolve(data, 'testnet-account-identity.json');
    const lockPath = resolve(data, 'testnet-bot.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('存在运行或待核对的交易锁，不能更换 API。请先正常停止并核对。'); throw e; }
    try {
      await lock.writeFile(String(process.pid));
      const generation = stopGeneration;
      const original = await readFile(statePath);
      const saved = JSON.parse(original);
      const expected = validateMonitorState(null, config, next.next.apiKey);
      validateMonitorState({ ...saved, accountTag: expected.accountTag }, config, next.next.apiKey);
      if (saved.accountTag === expected.accountTag) throw new Error('这是原 API，无需接续；请直接保存并只读连接。');
      if (saved.pending) throw new Error('存在待核对委托，必须先使用原配置核对，不能更换 API。');
      const identity = await json(identityPath);
      const lastOrder = [...saved.orders].reverse().find(x => x?.status === 'FILLED' && x.orderId != null);
      const cachedOrderProof = identity?.version === 1 && identity.accountTag === saved.accountTag && lastOrder ?
        verifiedOrderIdentity(identity.orderProof, config.symbol, lastOrder.orderId) : null;
      let oldUid = identity?.version === 1 && identity.accountTag === saved.accountTag ? verifiedAccountUid(identity) : null;
      let oldClient;
      if (credentials && validateMonitorState(null, config, credentials.apiKey).accountTag === saved.accountTag) {
        oldClient = (await credentialClient(credentials)).client;
      }
      if (!oldUid && !cachedOrderProof && oldClient) oldUid = verifiedAccountUid(await accountFor(oldClient));
      const newUid = verifiedAccountUid(await accountFor(next.client));
      let orderProof = null;
      if (oldUid && newUid) {
        if (oldUid !== newUid) throw new Error('新旧 API 属于不同测试网账户，禁止混用记录。原配置与记录已保留。');
      } else {
        // Spot Testnet can omit uid. Both keys must authenticate access to exactly
        // the same private, filled historical order; balances are never identity proof.
        if (!lastOrder) throw new Error('测试网没有返回账户编号，也没有可核实的历史订单。请保留原 API 和记录，不能自动接续。');
        orderProof = cachedOrderProof;
        if (!orderProof && oldClient) {
          await oldClient.syncTime();
          const order = await oldClient.request('GET', '/api/v3/order', { symbol: config.symbol, orderId: lastOrder.orderId }, true);
          orderProof = verifiedOrderIdentity(order, config.symbol, lastOrder.orderId);
        }
        if (!orderProof) throw new Error('尚未核实旧账户身份。请保留原 API 并先只读连接；旧记录已保留。');
        const nextOrder = await next.client.request('GET', '/api/v3/order', { symbol: config.symbol, orderId: lastOrder.orderId }, true);
        const nextProof = verifiedOrderIdentity(nextOrder, config.symbol, lastOrder.orderId);
        if (!nextProof || JSON.stringify(nextProof) !== JSON.stringify(orderProof)) throw new Error('新旧 API 的私有历史订单不匹配，禁止混用记录。原配置与记录已保留。');
      }
      if (closing || generation !== stopGeneration) throw new Error('Stop requested during API verification; change cancelled.');
      if (!(await readFile(statePath)).equals(original)) throw new Error('核对期间交易记录发生变化，取消更换 API，请重新核对。');
      // Keep every order, lot, position and risk counter; never treat rotation as a reset.
      const backups = resolve(profile, 'account-key-backups');
      await mkdir(backups, { recursive: true });
      const info = await lstat(backups);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('备份目录异常；原记录已保留。');
      const backupPath = resolve(backups, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
      await mkdir(backupPath);
      await writeFile(resolve(backupPath, 'testnet-state.json'), original, { flag: 'wx', mode: 0o600 });
      for (const [source, name] of [[identityPath, 'testnet-account-identity.json'], [resolve(profile, 'credentials.dpapi'), 'credentials.dpapi']]) {
        let bytes; try { bytes = await readFile(source); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        await writeFile(resolve(backupPath, name), bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(resolve(backupPath, 'rotation.json'), JSON.stringify({ version: 1, sameAccountVerified: true, ordersPreserved: saved.orders.length, changedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      if (closing || generation !== stopGeneration) throw new Error('Stop requested during API verification; change cancelled.');
      // A failed write leaves the old state or complete backup available, and no connection/start permission.
      await atomicWriteJson(identityPath, { version: 1, accountTag: expected.accountTag, uid: newUid, ...(orderProof ? { orderProof } : {}), checkedAt: new Date().toISOString() });
      await atomicWriteJson(statePath, { ...saved, accountTag: expected.accountTag });
      credentials = next.next; client = next.client;revision++;
      return { type: 'configured', publicKey: next.publicKey, accountRebound: true, backupPath, ordersPreserved: saved.orders.length };
    } finally { await lock.close(); await unlink(lockPath); }
  }
  const state = async () => {const selectedData=data,selectedConfig=config,key=credentials?.apiKey||'';return validateMonitorState(await json(resolve(selectedData,'testnet-state.json')),selectedConfig,key);};
  function retryConnection(error) {
    nextConnectionCheck = Infinity;
    if (!autoConnect || closing) return;
    const retryable = error.readOnlyTransient === true || error.status === 429;
    if (retryable) {
      const delay = error.status === 429 ? 60 : Math.min(60, 5 * 2 ** Math.min(connectionFailures, 4));
      connectionFailures++;
      nextConnectionCheck = now() + delay * 1000;
      send({ type: 'testnetConnection', status: 'retrying', retrySeconds: delay });
    } else {
      reviewRequired = true;
      send({ type: 'testnetConnection', status: 'review_required', text: redact(error.message, credentials) });
    }
  }
  async function local(internal=false) {
    if(operation&&!internal)return {type:'localBusy'};
    const selectedRevision=revision,selectedData=data,selectedConfig=config,key=credentials?.apiKey||'';
    const saved=validateMonitorState(await json(resolve(selectedData,'testnet-state.json')),selectedConfig,key);const heart=await json(resolve(selectedData,'testnet-heartbeat.json'));
    let alive = false; if (Number.isSafeInteger(heart?.pid) && heart.pid > 0) { try { process.kill(heart.pid, 0); alive = true; } catch {} }
    const activity = monitorActivity(heart, selectedConfig, saved.accountTag, Date.now(), alive);
    const locked=await exists(resolve(selectedData,'testnet-bot.lock'));
    if(revision!==selectedRevision)return {type:'localBusy'};
    return { type: 'local', running: Boolean(worker), stopping, license:license.status(), config: { symbol: selectedConfig.symbol, pollSeconds: selectedConfig.pollSeconds, tradeUsdt: selectedConfig.tradeUsdt }, activity,
      position: saved.position ? { quantity: saved.position.quantity, entryPrice: saved.position.entryPrice } : null,
      pending: saved.pending ? { side: saved.pending.side, reason: saved.pending.reason } : null,
      locked,
      orders: saved.orders.slice(-100).map(({ time, side, executedQty, quoteQty, status, reason, realizedUsdt, realizedPnlComplete }) => ({ time, side, executedQty, quoteQty, status, reason, realizedUsdt, realizedPnlComplete })) };
  }
  async function stop() {
    stopGeneration++;
    // Sticky IPC survives startup clearing an old filesystem stop marker.
    if (worker?.connected && typeof worker.send === 'function') {
      try { worker.send({ command: 'stop' }, () => {}); } catch { /* retain file request below */ }
    }
    if (worker || await exists(resolve(data, 'testnet-bot.lock'))) {
      await writeFile(resolve(data, 'testnet-stop'), 'desktop graceful stop requested'); stopping = true;
      send({ type: 'notice', text: 'Stop requested; waiting for in-flight work. No liquidation or order cancellation.' });
    }
  }
  async function readOnly(command, automatic = false) {
    if (!client) throw new Error('Save valid Testnet credentials first.');
    if (automatic && await anyMarketLock()) throw new Error('检测到交易锁，请先核对上一次运行。');
    await client.syncTime();
    if (command === 'connect') {
      if(!marketVerified)await loadCatalog();
      const account = await client.request('GET', '/api/v3/account', { omitZeroBalances: true }, true);
      if (!Array.isArray(account.balances)) throw new Error('Invalid account response.');
      const saved = await state();
      const uid = verifiedAccountUid(account);
      let priorUid;
      if (automatic || reviewRequired) {
        const identity = await json(resolve(data, 'testnet-account-identity.json'));
        priorUid = identity?.accountTag === saved.accountTag ? verifiedAccountUid(identity) : null;
        if (uid && priorUid && uid !== priorUid) {
          throw new Error('测试网账户与本机记录不一致，请核对原账户。');
        }
        if (saved.pending) throw new Error('存在待核对委托，请核对订单后再启动。');
        const openOrders = await client.request('GET', '/api/v3/openOrders', { symbol: config.symbol }, true);
        if (!Array.isArray(openOrders) || openOrders.length) throw new Error('无法确认当前交易对没有未完成委托，请到测试网核对。');
        if (saved.position) {
          const balance = account.balances.find(item => item.asset === config.symbol.slice(0,-4));
          const available = balance ? Number(balance.free) + Number(balance.locked) : 0;
          if (!Number.isFinite(available) || available + 1e-8 < saved.position.quantity) {
            throw new Error('测试网余额与本机策略持仓不一致，请先核对。');
          }
        }
      }
      if (uid && uid !== priorUid && !worker && !await exists(resolve(data, 'testnet-bot.lock'))) {
        await atomicWriteJson(resolve(data, 'testnet-account-identity.json'), { version: 1, accountTag: saved.accountTag, uid, checkedAt: new Date().toISOString() });
      }
      connected = account.canTrade === true;
      reviewRequired = false;
      return { type: 'connected', symbol:config.symbol, canTrade: connected, balances: account.balances.filter(x => [config.symbol.slice(0,-4), 'USDT'].includes(x.asset)).map(({ asset, free, locked }) => ({ asset, free, locked })) };
    }
    const s = await state(); const l = await local(true);
    return { type: 'snapshot', snapshot: await monitorSnapshot(client, config, s, l.activity) };
  }
  async function handle(m) {
    if (closing && m.command !== 'stop') throw new Error('Closing safely; no new operation accepted.');
    if (m.command === 'configure') {
      if (worker || readJob) throw new Error('Stop active work before changing credentials.');
      connected = false;
      client = null; // A failed replacement must not reconnect the prior account.
      autoConnect = false; nextConnectionCheck = Infinity; connectionFailures = 0;
      const candidate = await credentialClient(m.credentials);
      const next = candidate.next;
      // Validate stored account identity BEFORE replacing the in-memory account.
      const saved = await json(resolve(data, 'testnet-state.json'));
      try { validateMonitorState(saved, config, next.apiKey); }
      catch (e) {
        const expected = validateMonitorState(null, config, next.apiKey);
        if (saved && saved.accountTag !== expected.accountTag) {
          validateMonitorState({ ...saved, accountTag: expected.accountTag }, config, next.apiKey);
          const mismatch = new Error('当前 API 与旧记录的 API 不同。可只读核对同一账户后接续；不会清空历史或风险统计。');
          mismatch.code = 'ACCOUNT_KEY_CHANGED'; throw mismatch;
        }
        throw e;
      }
      credentials = next; connected = false;revision++;
      client = candidate.client;
      autoConnect = m.autoConnect === true;
      if (autoConnect) nextConnectionCheck = now();
      return { type: 'configured', publicKey: candidate.publicKey };
    }
    if (m.command === 'rotateCredentials') return rotateCredentials(m);
    if (m.command === 'selectSymbol') return selectSymbol(m.symbol);
    if (m.command === 'markets') { if(worker||readJob)throw new Error('先安全停止，再刷新币种。');return loadCatalog(); }
    if (m.command === 'connect' || m.command === 'snapshot') {
      if (readJob) throw new Error('A read-only request is already in progress.');
      if (m.command === 'connect' && client) autoConnect = true;
      readJob = readOnly(m.command);
      try {
        const result = await readJob;
        if (m.command === 'connect') { nextConnectionCheck = Infinity; connectionFailures = 0; }
        return result;
      } catch (error) { connected = false; if (client) retryConnection(error); throw error; }
      finally { readJob = null; }
    }
    if (m.command === 'local') return local();
    if (m.command === 'licenseStatus') return license.status();
    if (m.command === 'activateLicense') {
      if (worker || readJob) throw new Error('Stop and reconcile active work before changing a subscription key.');
      return license.activate(m.licenseKey);
    }
    if (m.command === 'start') {
      const requestedGeneration = stopGeneration;
      mayStart(m, connected, Boolean(worker || readJob), await anyMarketLock());
      if(!marketVerified)throw new Error('当前交易对不在测试网可交易币种列表中；请刷新币种并核对。');
      const saved = await state();
      if (saved.pending) throw new Error('Unresolved pending order: reconcile before restart.');
      for(const symbol of (await storedSymbols()).filter(s=>s!==config.symbol)){
        const other=await json(resolve(marketProfileFor(symbol),'.paper-data/testnet-state.json'));
        if(other?.position||other?.pending)throw new Error('另一交易对有遗留程序持仓或待核对订单；先切换到该交易对核对，不能并行启动。');
      }
      // Always make a fresh online check. A GUI flag or cached date cannot start orders.
      await license.refresh();
      if (!license.active()) throw new Error('An active online subscription is required.');
      if (closing) throw new Error('Closing; start refused.');
      if (stopGeneration !== requestedGeneration) throw new Error('Stop requested during start; start cancelled.');
      // Worker receives only reviewed Testnet settings. Never inherit NODE_OPTIONS,
      // production credentials, proxy rewrites, dotenv files or arbitrary commands.
      worker = spawnImpl(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
        cwd: marketProfile, windowsHide: true, env: { ...cleanEnvironment(env), ...overrides, ...credentialEnvironment(credentials), ASB_LICENSE_SESSION:license.session, ASB_LICENSE_DEVICE_HASH:license.status().deviceHash??'', ...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      stopping = false;
      if (worker.connected && typeof worker.send === 'function') worker.send({command:'licenseLease',token:license.token()},()=>{});
      for (const stream of [worker.stdout, worker.stderr]) {
        createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => send({ type: 'log', text: redact(line, credentials) }));
      }
      worker.on('error', () => send({ type: 'error', text: 'Worker failed to launch. No automatic restart.' }));
      worker.on('close', code => { worker = null; stopping = false; connected = false; send({ type: 'workerExit', code, text: 'Worker exited. Review records before restarting.' }); });
      return { type: 'started', text: 'Virtual strategy started. A signal check is not a promise of an order.' };
    }
    if (m.command === 'stop') { await stop(); return { type: 'stopping' }; }
    if (m.command === 'keyStatus') return { type: 'keyStatus', ...await storedKeyPair(profile) };
    if (m.command === 'generateKey') {
      if (worker || readJob || await anyMarketLock()) throw new Error('Stop and reconcile before generating keys.');
      const existing = await storedKeyPair(profile);
      if (existing.exists) {
        if (!existing.publicFileExists) await writeFile(existing.publicKeyPath, existing.publicKey, { flag: 'wx', mode: 0o600 });
        return { type: 'publicKey', reused: true, publicKey: existing.publicKey, privateKeyPath: existing.privateKeyPath };
      }
      const dir = resolve(profile, 'keys'); await mkdir(dir, { recursive: true });
      const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      const keyPath = resolve(dir, 'testnet-private.pem');
      // Exclusive creation: never replace an existing private key.
      const file = await open(keyPath, 'wx', 0o600); try { await file.writeFile(privateKey); } finally { await file.close(); }
      await writeFile(resolve(dir, 'testnet-public.pem'), publicKey, { flag: 'wx', mode: 0o600 });
      return { type: 'publicKey', publicKey, privateKeyPath: keyPath };
    }
    if (m.command === 'close') { closing = true; license.dispose(); await stop(); if (readJob) await readJob.catch(() => {}); return { type: 'closing' }; }
    throw new Error('Unsupported desktop command.');
  }
  return { async tickConnection() {
    if (closing || operation || readJob || worker || stopping || connected || !client ||
        now() < nextConnectionCheck || license.status().status === 'checking') return;
    operation = true;
    nextConnectionCheck = Infinity;
    send({ type: 'testnetConnection', status: 'connecting' });
    readJob = readOnly('connect', true);
    try {
      const result = await readJob;
      if (!closing) send({ ...result, automatic: true });
      connectionFailures = 0;
    } catch (error) {
      connected = false;
      retryConnection(error);
    } finally {
      readJob = null; operation = false;
    }
  }, async handle(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Invalid IPC command.');
    if (['local', 'licenseStatus', 'keyStatus', 'stop', 'close'].includes(m.command)) return handle(m);
    if (operation) throw new Error('Another desktop operation is active.');
    operation = true; try { return await handle(m); } finally { operation = false; }
  }, busy: () => Boolean(worker || readJob), selectedSymbol:()=>config.symbol, safeError: error => redact(error?.message || 'Desktop operation failed.', credentials),
  async disconnect() { closing = true; license.dispose(); await stop(); if (readJob) await readJob.catch(() => {}); } };
}

async function main() {
  const profile = process.argv[2];
  const policy = JSON.parse(await readFile(new URL('../../strategies/virtual-only.json', import.meta.url), 'utf8'));
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const controller = await createController({ profile, policy, emit });
  emit({ type: 'ready', mode: 'BINANCE_SPOT_TESTNET_ONLY', symbol:controller.selectedSymbol(), ordersEnabled: false });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Keep STOP responsive even while a network request is pending.
  lines.on('line', line => {
    if (line.length > 16384) { emit({ type: 'error', text: 'IPC input too large.' }); return; }
    let message;
    Promise.resolve().then(() => {
      message=JSON.parse(line);
      if(message.requestId!==undefined&&!/^[a-f0-9-]{36}$/.test(message.requestId))throw new Error('Invalid desktop request ID.');
      return controller.handle(message);
    }).then(result=>emit({...result,...(message.requestId?{requestId:message.requestId}:{})}))
      .catch(error => emit({ type: 'error', text: controller.safeError(error), ...(message?.requestId?{requestId:message.requestId}:{}), ...(error?.code === 'ACCOUNT_KEY_CHANGED' ? { code: error.code } : {}) }));
  });
  const connectionTimer = setInterval(() => controller.tickConnection().catch(() => {}), 1000);
  connectionTimer.unref();
  lines.on('close', () => { clearInterval(connectionTimer); controller.disconnect().catch(() => {}); });
  // A closed/crashed GUI cannot leave an unattended trading loop behind.
  // The child stays alive only long enough for the runner's graceful cleanup.
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(() => { process.stderr.write('Desktop controller could not start.\n'); process.exitCode = 1; });
