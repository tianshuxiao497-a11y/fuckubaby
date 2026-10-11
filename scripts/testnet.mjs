import { createPrivateKey } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TestnetClient, TESTNET_ORIGIN, readConfig, loadMarket, marketQuantity, initialState, adoptStrategyState, readOnlyRecoveryDelay, runCycle } from '../lib/testnet-bot.mjs';

const args = process.argv.slice(2);
const allowedArgs = ['--market', '--status', '--validate', '--once', '--watch', '--buy-test', '--stop', '--adopt-strategy', '--enable-testnet-orders'];
if (args.some(arg => !allowedArgs.includes(arg)) || args.filter(arg => arg !== '--enable-testnet-orders').length !== 1) {
  console.error('用法：npm run testnet:market / testnet:status / testnet:validate / testnet:preview / testnet:run');
  process.exit(1);
}

let lock;
let lockPath;
let stopping = false;
let activity;
let lastError = null;
const activityPath = resolve('.paper-data/testnet-heartbeat.json');
const publishActivity = async (status, result = null) => {
  if (!activity) return;
  activity = { ...activity, status, updatedAt: Date.now(), ...(result ? { result } : {}) };
  await writeFile(activityPath + '.tmp', JSON.stringify(activity), { mode: 0o600 });
  await rename(activityPath + '.tmp', activityPath);
};
const stopPath = resolve('.paper-data/testnet-stop');
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  if (args.includes('--stop')) {
    await mkdir(resolve('.paper-data'), { recursive: true });
    await writeFile(stopPath, 'stop requested');
    console.log('已请求 Testnet 程序安全停止；不平仓，不取消交易所委托。');
  } else {
  const config = readConfig();
  const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim() || '';
  const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim() || '';
  const privateKeyPath = process.env.BINANCE_TESTNET_PRIVATE_KEY_PATH?.trim();
  let privateKey = null;
  if (privateKeyPath) {
    privateKey = createPrivateKey(await readFile(resolve(privateKeyPath)));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('此程序的私钥签名只支持 Ed25519。');
  }
  const enableOrders = args.includes('--enable-testnet-orders');
  const adoptStrategy = args.includes('--adopt-strategy');
  if (adoptStrategy && enableOrders) throw new Error('切换记录不能同时开启交易。');
  if (adoptStrategy && !apiKey) throw new Error('接续策略必须使用原测试账户的本机密钥。');
  if (args.includes('--buy-test') && !enableOrders) throw new Error('试单必须显式开启 Testnet 虚拟委托。');
  const client = new TestnetClient({ apiKey, apiSecret, privateKey, allowOrders: enableOrders });
  console.log(`模式：Binance Spot Testnet（虚拟资金）；地址：${TESTNET_ORIGIN}`);

  if (args.includes('--market')) {
    const candles = await loadMarket(client, config);
    console.log(JSON.stringify({ symbol: config.symbol, interval: config.interval, closedCandles: candles.length, lastClose: candles.at(-1).close, closedAt: new Date(candles.at(-1).closeTime).toISOString() }, null, 2));
  } else if (args.includes('--status')) {
    await client.syncTime();
    const account = await client.request('GET', '/api/v3/account', { omitZeroBalances: true }, true);
    console.log(JSON.stringify({ canTrade: account.canTrade, balances: account.balances.filter(balance => ['USDT', 'BTC', 'ETH', 'SOL'].includes(balance.asset)).map(({ asset, free, locked }) => ({ asset, free, locked })) }, null, 2));
  } else if (args.includes('--validate')) {
    await client.syncTime();
    const info = await client.request('GET', '/api/v3/exchangeInfo', { symbol: config.symbol });
    const symbolInfo = info.symbols.find(symbol => symbol.symbol === config.symbol);
    const ticker = await client.request('GET', '/api/v3/ticker/price', { symbol: config.symbol });
    const quantity = marketQuantity(config.tradeUsdt / Number(ticker.price), Number(ticker.price), symbolInfo);
    await client.request('POST', '/api/v3/order/test', { symbol: config.symbol, side: 'BUY', type: 'MARKET', quantity }, true);
    console.log('Testnet 委托参数和签名检查通过；此操作不进入撮合引擎。');
  } else {
    if (enableOrders && (!apiKey || (!apiSecret && !privateKey))) throw new Error('请先在本机 .env.testnet 填入 Testnet 专用密钥。');
    const directory = resolve('.paper-data');
    const statePath = resolve(directory, 'testnet-state.json');
    if (enableOrders || adoptStrategy) {
      await mkdir(directory, { recursive: true });
      lockPath = resolve(directory, 'testnet-bot.lock');
      try { lock = await open(lockPath, 'wx'); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('已有 Testnet 程序或遗留锁。请先核实没有其他实例运行，再处理 .paper-data/testnet-bot.lock。');
        throw error;
      }
      await lock.writeFile(String(process.pid));
      if (enableOrders) {
        try { await unlink(stopPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    // Acquire the lock before reading state, so another instance cannot leave
    // us using a stale position snapshot.
    const state = initialState(config, apiKey);
    try {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      if (adoptStrategy) Object.assign(state, adoptStrategyState(saved, config, apiKey));
      else {
      if (saved.version !== 1 || saved.mode !== state.mode || saved.accountTag !== state.accountTag || saved.symbol !== config.symbol || saved.interval !== config.interval || (saved.strategy || 'classic') !== config.strategy) {
        throw new Error('已有状态与当前账户/交易对/周期不一致；请先保留原记录并核对持仓。');
      }
      if (!Array.isArray(saved.orders) || (saved.position && (!Number.isFinite(saved.position.quantity) || saved.position.quantity <= 0 || !Number.isFinite(saved.position.entryPrice) || saved.position.entryPrice <= 0))) {
        throw new Error('状态记录无效，请先核对持仓。');
      }
      Object.assign(state, saved);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (adoptStrategy) throw new Error('没有可接续的原账户记录，拒绝创建空白持仓记录。');
    }
    if (enableOrders) {
      activity = { pid: process.pid, accountTag: state.accountTag, startedAt: Date.now(), config };
      await publishActivity('running');
    }

    const persist = async value => {
      await writeFile(statePath + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(statePath + '.tmp', statePath);
    };
    if (adoptStrategy) {
      await persist(state);
      console.log(`已接续 ${config.strategy} 策略（${config.interval}，SMA ${config.fast}/${config.slow}）；保留真实测试网持仓与订单，不补执行历史交叉，本次不下单。`);
    } else {
    let readFailures = 0;
    do {
      if (enableOrders && existsSync(stopPath)) break;
      let delay = config.pollSeconds;
      try {
      const result = await runCycle(client, config, state, persist, enableOrders, { manualBuy: args.includes('--buy-test') });
      readFailures = 0;
      await publishActivity('running', result);
      console.log(`${new Date().toISOString()} ${JSON.stringify(result)}`);
      } catch (error) {
        const recovery = readOnlyRecoveryDelay(error, config, state, ++readFailures);
        if (!enableOrders || !args.includes('--watch') || recovery === null) throw error;
        delay = recovery;
        const result = { action: '只读行情连接中断：暂停下单，等待连接恢复', retryAfterSeconds: delay };
        await publishActivity('reconnecting', result);
        console.log(`${new Date().toISOString()} ${JSON.stringify(result)}`);
      }
      if (!args.includes('--watch') || stopping) break;
      // Only known read-only transient failures may resume, with backoff.
      // A pending/ambiguous order or POST failure always ends this process.
      for (let seconds = 0; seconds < delay && !stopping; seconds++) {
        await sleep(1000);
        if (existsSync(stopPath)) { stopping = true; break; }
        if (activity?.status === 'reconnecting' && seconds % 20 === 19) await publishActivity('reconnecting');
      }
    } while (!stopping);
    }
  }
  }
} catch (error) {
  lastError = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock) {
    await publishActivity(lastError ? 'error' : 'stopped', lastError ? { action: lastError } : null);
    await lock.close();
    await unlink(lockPath);
  }
}
