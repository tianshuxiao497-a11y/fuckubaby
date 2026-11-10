import { initialState, loadMarket, signalIndicators, cycleSignal } from './testnet-bot.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 600) : null;
const flag = value => typeof value === 'boolean' ? value : null;
const pickNumbers = (source, fields) => Object.fromEntries(fields.map(key => [key, finite(source?.[key])]));
const commissionSource = value => ['BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION', 'CONSERVATIVE_FALLBACK', 'ADAPTIVE_STANDARD_ASSUMPTION'].includes(value) ? value : null;
const frozenRisk = source => source ? {
  ...pickNumbers(source, ['stopLossPercent', 'takeProfitPercent']),
  ...(source.costSnapshot ? { costSnapshot: {
    ...pickNumbers(source.costSnapshot, ['buyFeePercent', 'sellFeePercent', 'slippagePerSidePercent', 'checkedAt']),
    source: commissionSource(source.costSnapshot.source), verified: flag(source.costSnapshot.verified)
  } } : {})
} : null;
function adaptiveStats(source) {
  if (!source || typeof source !== 'object') return null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const waitReasons = source.waitReasons && typeof source.waitReasons === 'object' && !Array.isArray(source.waitReasons)
    ? Object.entries(source.waitReasons).filter(([reason, total]) => typeof reason === 'string' && reason.length > 0 && count(total) !== null)
      .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([reason, total]) => ({ reason: text(reason), count: total })) : [];
  return { startedAt: finite(source.startedAt), checks: count(source.checks), lastCheckedAt: finite(source.lastCheckedAt), lastOrderAt: finite(source.lastOrderAt), waitReasons };
}
function adaptiveAudit(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    side: ['BUY', 'SELL'].includes(source.side) ? source.side : null,
    reason: text(source.reason), checkedAt: finite(source.checkedAt),
    ...pickNumbers(source, ['fast', 'slow', 'momentumPercent', 'spreadPercent', 'sampleCount', 'batchIndex', 'batchUsdt', 'remainingBudget']),
    warmReady: flag(source.warmReady),
    route: ['trend_continuation', 'pullback_rebound'].includes(source.route) ? source.route : null,
    riskSnapshot: frozenRisk(source.riskSnapshot),
    indicators: pickNumbers(source.indicators, ['fast', 'slow', 'previousFast', 'previousSlow', 'rsi', 'previousRsi', 'atr', 'atrPercent', 'contextFast', 'contextSlow', 'contextBiasPercent', 'volumeRatio', 'trendScore', 'reboundScore']),
    thresholds: {
      ...pickNumbers(source.thresholds, ['roundTripCostPercent', 'minGrossOpportunityPercent', 'opportunityProxyPercent', 'netEdgeBufferPercent', 'maxSpreadPercent', 'maxExtensionPercent', 'minOrderSeconds', 'trailingDistancePercent', 'trailingArmPercent', 'buyFeePercent', 'sellFeePercent', 'checkedAt', 'expiresAt']),
      opportunityIsResearchProxy: flag(source.thresholds?.opportunityIsResearchProxy),
      feeVerified: flag(source.thresholds?.feeVerified), feeSource: commissionSource(source.thresholds?.feeSource)
    }
  };
}

export function validateMonitorState(saved, config, apiKey) {
  const expected = initialState(config, apiKey);
  if (!saved) return expected;
  if (saved.mode !== expected.mode || saved.version !== 1 || saved.accountTag !== expected.accountTag || saved.symbol !== config.symbol || saved.interval !== config.interval || (saved.strategy || 'classic') !== config.strategy || !Array.isArray(saved.orders)) {
    throw new Error('本机记录与当前测试账户不一致，停止展示以防混用。');
  }
  if (config.strategy === 'adaptive' && (saved.adaptiveProfile ?? 'standard') !== (config.adaptiveProfile ?? 'standard')) {
    throw new Error('本机记录与看板的长短周期配置不同，请使用同一策略并重启只读看板。');
  }
  return saved;
}

export function monitorActivity(activity, config, accountTag, now = Date.now(), alive = false) {
  if (!activity || activity.accountTag !== accountTag) return { status: 'unknown', label: '尚未取得机器人状态' };
  const fresh = now - activity.updatedAt < (config.pollSeconds * 2 + 30) * 1000;
  const status = ['running', 'reconnecting'].includes(activity.status) && (!fresh || !alive) ? 'stale' : activity.status;
  return {
    status, label: config.strategy === 'adaptive' && config.adaptiveProfile !== 'short' ? ({ running: 'Adaptive Testnet strategy running', reconnecting: 'Market disconnected; orders paused', stopped: 'Strategy stopped', error: 'Strategy stopped after an error', stale: 'Heartbeat stale or process exited' })[status] || 'Strategy state unknown' : ({ running: '自动策略运行中', reconnecting: '行情断线：暂停下单，等待连接恢复', stopped: '策略已停止', error: '策略因错误停止', stale: '心跳过期或进程已退出' })[status] || '状态未知',
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
    batches: state.position.batches ?? null, deployedUsdt: state.position.deployedUsdt ?? null, adopted: state.position.adopted === true,
    riskSnapshot: frozenRisk(state.position.riskSnapshot), peakBid: finite(state.position.peakBid),
    feeValuationComplete: flag(state.position.feeValuationComplete),
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
    dust: { quantity: (state.dust ?? []).reduce((sum, item) => sum + item.quantity, 0), lots: (state.dust ?? []).length,
      note: '机器人卖出后的不可交易零头，单独保留，不借账户赠送资产补量，不并入新仓。' },
    indicators: signalIndicators(candles, config), strategyChangedAt: state.strategyChangedAt || null,
    cycle: config.strategy === 'cycle' ? cycleSignal(config, state) : null,
    tactical: config.strategy === 'tactical' && state.tacticalDecision ? Object.fromEntries(
      ['side', 'reason', 'checkedAt', 'fast', 'slow', 'momentumPercent', 'spreadPercent', 'sampleCount', 'warmReady', 'batchIndex', 'batchUsdt', 'remainingBudget']
        .map(key => [key, state.tacticalDecision[key] ?? null])) : null,
    adaptive: config.strategy === 'adaptive' ? adaptiveAudit(state.adaptiveDecision) : null,
    adaptiveStats: config.strategy === 'adaptive' ? adaptiveStats(state.adaptiveStats) : null,
    dailyRisk: config.strategy === 'adaptive' && state.dailyRisk ? {
      dayUtc: /^\d{4}-\d{2}-\d{2}$/.test(state.dailyRisk.dayUtc) ? state.dailyRisk.dayUtc : null,
      realizedUsdt: finite(state.dailyRisk.realizedUsdt), consecutiveLosses: finite(state.dailyRisk.consecutiveLosses),
      lastLossAt: finite(state.dailyRisk.lastLossAt), basis: text(state.dailyRisk.basis), isPerformanceEstimate: false
    } : null,
    balances: account.balances.filter(balance => ['USDT', config.symbol.slice(0,-4)].includes(balance.asset)).map(balance => ({ asset: balance.asset, free: Number(balance.free), locked: Number(balance.locked) })),
    trades, openOrders: openOrders.map(order => ({ orderId: order.orderId, side: order.side, type: order.type, status: order.status, quantity: order.origQty, executed: order.executedQty, price: order.price })),
    botOrders: state.orders.map(({ orderId, side, status, executedQty, quoteQty, reason, time, commissions, realizedUsdt, realizedPnlComplete, decisionSnapshot }) => ({
      orderId, side, status, executedQty, quoteQty, reason, time,
      commissions: Array.isArray(commissions) ? commissions.map(fee => ({ asset: /^[A-Z0-9]{1,16}$/.test(fee?.asset) ? fee.asset : null, amount: finite(fee?.amount) })) : null,
      realizedUsdt: finite(realizedUsdt), realizedPnlComplete: flag(realizedPnlComplete),
      decisionSnapshot: config.strategy === 'adaptive' ? adaptiveAudit(decisionSnapshot) : null
    })),
    pending: state.pending ? { side: state.pending.side, reason: state.pending.reason } : null,
    candles: candles.slice(-60).map(({ time, close }) => ({ time, close }))
  };
}
