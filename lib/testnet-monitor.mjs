import { initialState, loadMarket, signalIndicators } from './testnet-bot.mjs';

export function validateMonitorState(saved, config, apiKey) {
  const expected = initialState(config, apiKey);
  if (!saved) return expected;
  if (saved.mode !== expected.mode || saved.version !== 1 || saved.accountTag !== expected.accountTag || saved.symbol !== config.symbol || saved.interval !== config.interval || (saved.strategy || 'classic') !== config.strategy || !Array.isArray(saved.orders)) {
    throw new Error('本机记录与当前测试账户不一致，停止展示以防混用。');
  }
  return saved;
}

export function monitorActivity(activity, config, accountTag, now = Date.now(), alive = false) {
  if (!activity || activity.accountTag !== accountTag) return { status: 'unknown', label: '尚未取得机器人状态' };
  const fresh = now - activity.updatedAt < (config.pollSeconds * 2 + 30) * 1000;
  const status = ['running', 'reconnecting'].includes(activity.status) && (!fresh || !alive) ? 'stale' : activity.status;
  return {
    status, label: ({ running: '自动策略运行中', reconnecting: '行情断线：暂停下单，等待连接恢复', stopped: '策略已停止', error: '策略因错误停止', stale: '心跳过期或进程已退出' })[status] || '状态未知',
    updatedAt: activity.updatedAt,
    action: activity.result?.action || '正在检查测试网行情'
  };
}

export async function monitorSnapshot(client, config, state, activity) {
  // Every remote request here is read-only. The monitor cannot place orders.
  const candles = await loadMarket(client, config);
  const [account, ticker, fills, openOrders] = await Promise.all([
    client.request('GET', '/api/v3/account', { omitZeroBalances: true }, true),
    client.request('GET', '/api/v3/ticker/price', { symbol: config.symbol }),
    client.request('GET', '/api/v3/myTrades', { symbol: config.symbol, limit: 50 }, true),
    client.request('GET', '/api/v3/openOrders', { symbol: config.symbol }, true)
  ]);
  const price = Number(ticker.price);
  if (!Number.isFinite(price) || price <= 0 || !Array.isArray(account.balances) || !Array.isArray(fills) || !Array.isArray(openOrders)) throw new Error('测试网监控数据格式无效。');
  const knownOrders = new Map(state.orders.map(order => [order.orderId, order]));
  const position = state.position ? {
    quantity: state.position.quantity, entryPrice: state.position.entryPrice, openedAt: state.position.openedAt,
    value: state.position.quantity * price,
    estimatedPnl: state.position.quantity * (price - state.position.entryPrice)
  } : null;
  const trades = fills.map(fill => ({
    id: fill.id, orderId: fill.orderId, side: fill.isBuyer ? 'BUY' : 'SELL',
    quantity: Number(fill.qty), price: Number(fill.price), quote: Number(fill.quoteQty),
    commission: Number(fill.commission), commissionAsset: fill.commissionAsset, time: fill.time,
    botOwned: knownOrders.has(fill.orderId), reason: knownOrders.get(fill.orderId)?.reason || '测试账户其他成交'
  })).sort((a, b) => b.time - a.time);
  return {
    mode: 'BINANCE_SPOT_TESTNET', source: '币安测试网账户 API', updatedAt: Date.now(),
    symbol: config.symbol, config, activity, price, position,
    indicators: signalIndicators(candles, config), strategyChangedAt: state.strategyChangedAt || null,
    balances: account.balances.filter(balance => ['USDT', 'BTC', 'ETH', 'SOL'].includes(balance.asset)).map(balance => ({ asset: balance.asset, free: Number(balance.free), locked: Number(balance.locked) })),
    trades, openOrders: openOrders.map(order => ({ orderId: order.orderId, side: order.side, type: order.type, status: order.status, quantity: order.origQty, executed: order.executedQty, price: order.price })),
    botOrders: state.orders.map(({ orderId, side, status, executedQty, quoteQty, reason, time }) => ({ orderId, side, status, executedQty, quoteQty, reason, time })),
    pending: state.pending ? { side: state.pending.side, reason: state.pending.reason } : null,
    candles: candles.slice(-60).map(({ time, close }) => ({ time, close }))
  };
}
