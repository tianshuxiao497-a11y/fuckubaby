import { createPrivateKey } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TestnetClient, TESTNET_ORIGIN, readConfig, loadMarket, marketQuantity, initialState, runCycle } from '../lib/testnet-bot.mjs';

const args = process.argv.slice(2);
const allowedArgs = ['--market', '--status', '--validate', '--once', '--watch', '--stop', '--enable-testnet-orders'];
if (args.some(arg => !allowedArgs.includes(arg)) || args.filter(arg => arg !== '--enable-testnet-orders').length !== 1) {
  console.error('用法：npm run testnet:market / testnet:status / testnet:validate / testnet:preview / testnet:run');
  process.exit(1);
}

let lock;
let lockPath;
let stopping = false;
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
    if (enableOrders) {
      await mkdir(directory, { recursive: true });
      lockPath = resolve(directory, 'testnet-bot.lock');
      try { lock = await open(lockPath, 'wx'); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('已有 Testnet 程序或遗留锁。请先核实没有其他实例运行，再处理 .paper-data/testnet-bot.lock。');
        throw error;
      }
      await lock.writeFile(String(process.pid));
      try { await unlink(stopPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Acquire the lock before reading state, so another instance cannot leave
    // us using a stale position snapshot.
    const state = initialState(config, apiKey);
    try {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      if (saved.version !== 1 || saved.mode !== state.mode || saved.accountTag !== state.accountTag || saved.symbol !== config.symbol || saved.interval !== config.interval) {
        throw new Error('已有状态与当前账户/交易对/周期不一致；请先保留原记录并核对持仓。');
      }
      if (!Array.isArray(saved.orders) || (saved.position && (!Number.isFinite(saved.position.quantity) || saved.position.quantity <= 0 || !Number.isFinite(saved.position.entryPrice) || saved.position.entryPrice <= 0))) {
        throw new Error('状态记录无效，请先核对持仓。');
      }
      Object.assign(state, saved);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    const persist = async value => {
      await writeFile(statePath + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(statePath + '.tmp', statePath);
    };
    do {
      if (existsSync(stopPath)) break;
      const result = await runCycle(client, config, state, persist, enableOrders);
      console.log(`${new Date().toISOString()} ${JSON.stringify(result)}`);
      if (!args.includes('--watch') || stopping) break;
      // Poll serially; an exception ends the process rather than auto-resubmitting.
      for (let seconds = 0; seconds < config.pollSeconds && !stopping; seconds++) {
        await sleep(1000);
        if (existsSync(stopPath)) { stopping = true; break; }
      }
    } while (!stopping);
  }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
}
