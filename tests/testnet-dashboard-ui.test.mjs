import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { initialState, readConfig } from '../lib/testnet-bot.mjs';
import { monitorActivity, monitorSnapshot } from '../lib/testnet-monitor.mjs';

async function renderPayload(payload, ok = false) {
  const nodes = new Map();
  const node = () => ({ textContent: '', children: [], hidden: false, className: '', append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, addEventListener() {}, setAttribute() {} });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  get('trade-count').textContent = '0 笔'; get('order-count').textContent = '0 笔';
  const legends = [node(), node(), node()]; const calls = [];
  const context = {
    document: { getElementById: get, createElement: node, querySelectorAll: () => legends },
    AbortSignal, Intl, setInterval: () => 1,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok, json: async () => payload }; }
  };
  runInNewContext(await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, legends, refresh: async (nextPayload, nextOk = false) => { payload = nextPayload; ok = nextOk; await context.refresh(); } };
}
const renderError = payload => renderPayload(payload);
const text = element => element.textContent + element.children.map(text).join(' ');
const tacticalConfig = () => ({
  ...readConfig({ TESTNET_STRATEGY: 'fast' }), strategy: 'tactical', pollSeconds: 10,
  minOrderSeconds: 10, tradeUsdt: 100, batchFractions: [0.25, 0.25, 0.5],
  stopLoss: 0.2, takeProfit: 0.3, maxHoldMinutes: 3, cooldownSeconds: 30, maxBuysPerHour: 60,
  entryMomentumPercent: 0.02, exitMomentumPercent: 0.04, maxSpreadPercent: 0.05,
  maxExtensionPercent: 0.2, addStepPercent: 0.01
});
const snapshot = overrides => ({
  mode: 'BINANCE_SPOT_TESTNET', symbol: 'BTCUSDT', config: tacticalConfig(),
  activity: { status: 'running', label: '策略运行中', action: '继续观察', updatedAt: Date.parse('2026-10-13T08:00:00Z') },
  updatedAt: Date.parse('2026-10-13T08:00:02Z'), price: 83000,
  balances: [{ asset: 'USDT', free: 10000, locked: 0 }], position: null,
  trades: [], botOrders: [], openOrders: [], candles: [], pending: null,
  ...overrides
});

test('blocked account UI shows cycle configuration and stopped status without fabricating zero fills or holdings', async () => {
  const config = readConfig({ TESTNET_STRATEGY: 'cycle' });
  const { get, calls, legends } = await renderError({ mode: 'BINANCE_SPOT_TESTNET', config, symbol: config.symbol, activity: { status: 'stopped', label: '策略已停止', action: '已配置，尚未启动' }, error: 'HTTP 451 访问拒绝' });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/snapshot');
  assert.match(get('activity-label').textContent, /策略已停止/);
  assert.equal(get('activity-action').textContent, '已配置，尚未启动');
  assert.equal(get('trade-count').textContent, '成交记录暂未取得');
  assert.equal(get('order-count').textContent, '订单记录暂未取得');
  assert.equal(get('opened').textContent, '当前持仓数据暂未取得');
  assert.match(get('error').textContent, /HTTP 451/);
  assert.match(get('signal-summary').textContent, /至少等待 30 秒/);
  assert.match(text(get('settings')), /每分钟约两笔/);
  assert.match(text(get('settings')), /100 虚拟 USDT/);
  assert.match(get('trading-help').textContent, /不代表已成交/);
  assert.match(legends[1].textContent, /仅参考/);
});

test('tactical UI distinguishes ten-second observation, conditional batches and overall budget', async () => {
  const { get, legends } = await renderPayload(snapshot({ tactical: {
    side: 'BUY', reason: '上行动量持续，第二批条件满足', checkedAt: Date.parse('2026-10-13T08:00:00Z'),
    fast: 82980, slow: 82970, momentumPercent: 0.025, spreadPercent: 0.0123,
    sampleCount: 4, warmReady: true, batchIndex: 2, batchUsdt: 25, remainingBudget: 75
  }, position: { quantity: 0.0003, entryPrice: 83000, openedAt: Date.parse('2026-10-13T07:59:00Z'), value: 24.9, estimatedPnl: 0.1, batches: 1, deployedUsdt: 24.8 } }), true);
  const settings = text(get('settings'));
  assert.match(settings, /目标约 10 秒检查/);
  assert.match(settings, /非固定成交/);
  assert.match(settings, /每轮总投入上限\s+100 虚拟 USDT/);
  assert.match(settings, /25% \/ 25\.00 USDT → 25% \/ 25\.00 USDT → 50% \/ 50\.00 USDT/);
  assert.match(settings, /风险退出优先/);
  assert.match(settings, /不摊低成本/);
  const summary = get('signal-summary').textContent;
  assert.match(summary, /决断检查 10\/13 16:00:00/);
  assert.match(summary, /上行动量持续，第二批条件满足/);
  assert.match(summary, /预热已就绪/);
  assert.match(summary, /短动量 0\.0250%/);
  assert.match(summary, /买卖价差 0\.0123%/);
  assert.match(summary, /第 2 \/ 3 批/);
  assert.match(summary, /已成交 1 \/ 3 批/);
  assert.match(summary, /实际累计投入 24\.8000 \/ 100/);
  assert.match(summary, /拟委托不是已成交/);
  assert.match(get('opened').textContent, /累计投入 24\.8000 USDT/);
  assert.match(get('risk-note').textContent, /不保证每 10 秒成交/);
  assert.match(get('risk-note').textContent, /尚未验证盈利/);
  assert.match(get('refresh-note').textContent, /最多缓存 5 秒/);
  assert.match(get('trading-help').textContent, /拟买入 \/ 拟卖出/);
  assert.doesNotMatch(legends[1].textContent, /仅参考/);
});

test('tactical warmup shows unavailable metrics rather than inventing zero momentum', async () => {
  const { get } = await renderPayload(snapshot({ tactical: {
    side: 'HOLD', reason: '短动量样本预热中', checkedAt: Date.parse('2026-10-13T08:00:00Z'),
    fast: null, slow: null, momentumPercent: null, spreadPercent: null,
    sampleCount: 1, warmReady: false, batchIndex: null, batchUsdt: null, remainingBudget: 100
  } }), true);
  const summary = get('signal-summary').textContent;
  assert.match(summary, /继续观察：短动量样本预热中/);
  assert.match(summary, /预热尚未完成（1 个样本）/);
  assert.match(summary, /短动量 未取得/);
  assert.match(summary, /买卖价差 未取得/);
  assert.doesNotMatch(summary, /0\.0000%|拟执行|拟委托/);
  assert.equal(get('opened').textContent, '等待策略信号');
});

test('tactical adopted legacy position is visibly exit-only instead of implying further batches', async () => {
  const { get } = await renderPayload(snapshot({ tactical: {
    side: 'HOLD', reason: '已接管现有持仓，等待退出条件', checkedAt: Date.parse('2026-10-13T08:00:00Z'),
    fast: 82980, slow: 82970, momentumPercent: 0.025, spreadPercent: 0.0123,
    sampleCount: 4, warmReady: true
  }, position: { quantity: 0.0012, entryPrice: 83000, openedAt: Date.parse('2026-10-13T07:59:00Z'), value: 99.6, estimatedPnl: 0, batches: 3, deployedUsdt: 99.6, adopted: true } }), true);
  assert.match(get('signal-summary').textContent, /旧持仓已接管：只按退出规则管理，不再加仓/);
  assert.match(get('opened').textContent, /旧持仓，仅管理退出，不加仓/);
  assert.doesNotMatch(get('signal-summary').textContent, /本轮已成交 3/);
});

test('blocked tactical payload shows only configuration, not local stale decisions or market values', async () => {
  const payload = snapshot({ updatedAt: null, activity: { status: 'stopped', label: '策略已停止', action: '网络访问受限' },
    tactical: { side: 'BUY', reason: 'obsolete buy signal', checkedAt: Date.parse('2026-10-13T08:00:00Z'), momentumPercent: 9.99, spreadPercent: 0.01, warmReady: true }, error: 'HTTP 451 访问拒绝' });
  const { get } = await renderError(payload);
  assert.match(text(get('settings')), /每轮总投入上限\s+100 虚拟 USDT/);
  assert.match(get('activity-label').textContent, /策略已停止/);
  assert.match(get('signal-summary').textContent, /账户 \/ 行情刷新失败/);
  assert.match(get('signal-summary').textContent, /分批状态未经确认/);
  assert.doesNotMatch(get('signal-summary').textContent, /obsolete|9\.9900|预热已就绪|拟买入/);
  assert.equal(get('trade-count').textContent, '成交记录暂未取得');
  assert.equal(get('opened').textContent, '当前持仓数据暂未取得');
});

test('tactical refresh failure removes authoritative decision presentation and marks previous holdings stale', async () => {
  const config = tacticalConfig();
  const { get, refresh } = await renderPayload(snapshot({ tactical: { side: 'HOLD', reason: 'fresh observation', checkedAt: Date.parse('2026-10-13T08:00:00Z'), warmReady: true, sampleCount: 4, momentumPercent: 0.02, spreadPercent: 0.01 } }), true);
  await refresh({ mode: 'BINANCE_SPOT_TESTNET', config, symbol: 'BTCUSDT', activity: { status: 'running', label: '运行中' }, error: '网络超时', tactical: { side: 'BUY', reason: 'unverified buy' } });
  assert.match(get('activity-label').textContent, /未经确认/);
  assert.match(get('error').textContent, /旧数据，请勿当作当前状态/);
  assert.match(get('signal-summary').textContent, /未经确认/);
  assert.doesNotMatch(get('signal-summary').textContent, /fresh observation|unverified buy|预热已就绪/);
});

test('unverified or wrong-source error payload never claims the strategy is running', async () => {
  const { get } = await renderError({ mode: 'LIVE', config: readConfig({ TESTNET_STRATEGY: 'cycle' }), activity: { status: 'running', label: '运行中' }, error: 'unverified' });
  assert.match(get('activity-label').textContent, /未经确认/);
  assert.equal(get('settings').children.length, 0);
  assert.equal(get('error').hidden, false);
});

const adaptiveConfig = () => readConfig({ TESTNET_STRATEGY: 'adaptive' });
const adaptiveDecision = () => ({
  side: 'BUY', reason: 'Confirmed trend continuation; tranche 2/3', route: 'trend_continuation',
  checkedAt: Date.parse('2026-10-17T08:00:00Z'), fast: 83020, slow: 83010,
  momentumPercent: 0.014, spreadPercent: 0.012, warmReady: true, sampleCount: 4,
  batchIndex: 2, batchUsdt: 30, remainingBudget: 60,
  riskSnapshot: { stopLossPercent: 0.35, takeProfitPercent: 0.7 },
  indicators: { rsi: 62, atrPercent: 0.14, contextBiasPercent: 0.08, trendScore: 5, reboundScore: 2 },
  thresholds: { roundTripCostPercent: 0.252, minGrossOpportunityPercent: 0.302, opportunityProxyPercent: 0.56, opportunityIsResearchProxy: true }
});

test('adaptive monitor UI identifies EMA/RSI/ATR research logic, frozen risk and conservative guard rather than classic SMA', async () => {
  const data = snapshot({ config: adaptiveConfig(), adaptive: adaptiveDecision(),
    position: { quantity: 0.00048, entryPrice: 83000, openedAt: Date.parse('2026-10-17T07:59:00Z'), value: 39.84, estimatedPnl: 0, batches: 1, deployedUsdt: 39.8, riskSnapshot: { stopLossPercent: 0.28, takeProfitPercent: 0.6 }, feeValuationComplete: false },
    dailyRisk: { dayUtc: '2026-10-17', realizedUsdt: -0.91, consecutiveLosses: 2, basis: 'Conservative known P&L less assumed round-trip fees/slippage; not a performance estimate' },
    botOrders: [{ orderId: 42, side: 'SELL', status: 'FILLED', executedQty: 0.0001, quoteQty: 8.3, reason: 'Adaptive take profit', commissions: [{ asset: 'BNB', amount: 0.0002 }], realizedUsdt: 0.12, realizedPnlComplete: false },
      { orderId: 41, side: 'SELL', status: 'FILLED', executedQty: 0.0001, quoteQty: 8.3, reason: 'Old record' }]
  });
  const { get, legends } = await renderPayload(data, true);
  const settings = text(get('settings')); const summary = get('signal-summary').textContent;
  assert.match(settings, /Adaptive · Spot Testnet only/); assert.doesNotMatch(settings, /经典均线/);
  assert.match(settings, /Target ~5s; not periodic fills/);
  assert.match(settings, /EMA 3\/8 \+ RSI 7 \+ ATR 7/);
  assert.match(settings, /40% \/ 40\.00 USDT → 30% \/ 30\.00 USDT → 30% \/ 30\.00 USDT/);
  assert.match(settings, /Hard maximum 10m; soft 3m only when estimated costs are covered/);
  assert.match(settings, /3 consecutive conservative losses: pause entries for 15m/);
  assert.match(summary, /Decision checked 10\/17 16:00:00/);
  assert.match(summary, /Proposed BUY/); assert.match(summary, /trend_continuation/);
  assert.match(summary, /EMA 3\/8/); assert.match(summary, /RSI 7 62\.00/);
  assert.match(summary, /complete 5m context bias 0\.0800%/);
  assert.match(summary, /research proxy 0\.5600%/);
  assert.match(summary, /not an expected return or profit forecast/);
  assert.match(summary, /Frozen position risk: SL 0\.2800% \/ TP 0\.6000%/);
  assert.match(summary, /conservative guard P&L -0\.9100 USDT/);
  assert.match(summary, /not a performance estimate/);
  assert.match(get('opened').textContent, /entry fee valuation INCOMPLETE/);
  assert.match(get('opened').textContent, /frozen SL 0\.2800%/);
  assert.match(text(get('orders')), /0\.00020000 BNB/);
  assert.match(text(get('orders')), /Realized: 0\.120000 USDT · Fee valuation: INCOMPLETE/);
  assert.match(text(get('orders')), /Realized: not recorded · Fee valuation: unknown/);
  assert.match(legends[1].textContent, /SMA 3 \(reference only\)/);
  assert.match(legends[2].textContent, /SMA 8 \(reference only\)/);
});

test('adaptive missing warm-up metrics and guard records are unavailable, never fabricated zeros', async () => {
  const { get } = await renderPayload(snapshot({ config: adaptiveConfig(), adaptive: { ...adaptiveDecision(), side: null, route: null, momentumPercent: null, warmReady: false, sampleCount: 1, riskSnapshot: null, indicators: {}, thresholds: {} } }), true);
  const summary = get('signal-summary').textContent;
  assert.match(summary, /WAIT:/); assert.match(summary, /Warm-up not ready \(1 observations\)/);
  assert.match(summary, /momentum unavailable/); assert.match(summary, /RSI 7 unavailable/);
  assert.match(summary, /No daily guard record available/);
  assert.doesNotMatch(summary, /momentum 0\.0000|guard P&L 0\.0000|Proposed tranche/);
  assert.match(get('opened').textContent, /not a periodic BUY\/SELL cycle/);
});

test('failed adaptive snapshots show only configuration, not stale decisions, frozen risk or guard records', async () => {
  const payload = snapshot({ config: adaptiveConfig(), adaptive: adaptiveDecision(), dailyRisk: { realizedUsdt: -99 }, updatedAt: null, activity: { status: 'stopped', label: 'Strategy stopped', action: 'Access refused' }, error: 'HTTP 451' });
  const { get } = await renderError(payload);
  assert.match(text(get('settings')), /Adaptive/);
  assert.match(get('signal-summary').textContent, /Configuration only/);
  assert.match(get('signal-summary').textContent, /daily guard and tranche state are unverified/);
  assert.doesNotMatch(get('signal-summary').textContent, /trend_continuation|-99|0\.3500/);
  assert.equal(get('trade-count').textContent, 'Fill records unavailable');
  assert.equal(get('opened').textContent, 'Current position data unavailable');
  assert.match(get('activity-label').textContent, /Strategy stopped · account refresh failed/);
});

test('adaptive account refresh failure invalidates prior audit and marks account figures old', async () => {
  const { get, refresh } = await renderPayload(snapshot({ config: adaptiveConfig(), adaptive: adaptiveDecision() }), true);
  await refresh({ mode: 'BINANCE_SPOT_TESTNET', symbol: 'BTCUSDT', config: adaptiveConfig(), error: 'Network timeout', activity: { status: 'running', label: 'running' }, adaptive: adaptiveDecision() });
  assert.match(get('error').textContent, /OLD DATA/);
  assert.match(get('activity-label').textContent, /UNVERIFIED/);
  assert.match(get('signal-summary').textContent, /Configuration only/);
  assert.doesNotMatch(get('signal-summary').textContent, /Proposed BUY|research proxy 0\.5600/);
  await refresh({ mode: 'LIVE', error: 'Wrong source' });
  assert.match(get('signal-summary').textContent, /Configuration only/);
  assert.doesNotMatch(get('signal-summary').textContent, /Proposed BUY/);
});

test('adaptive snapshot exposes only a read-only whitelisted decision, risk and accounting audit', async () => {
  const config = adaptiveConfig(); const state = initialState(config, 'fixture-testnet-key');
  const secret = 'MUST_NOT_LEAK_PRIVATE_METADATA';
  const decision = { ...adaptiveDecision(), apiKey: secret, positionUpdate: { peakBid: 83000, secret }, indicators: { ...adaptiveDecision().indicators, token: secret }, riskSnapshot: { stopLossPercent: 0.28, takeProfitPercent: 0.6, privateKey: secret } };
  state.adaptiveDecision = decision;
  state.position = { quantity: 0.001, entryPrice: 83000, openedAt: 1, batches: 1, deployedUsdt: 83, peakBid: 83010, feeValuationComplete: false, riskSnapshot: { stopLossPercent: 0.28, takeProfitPercent: 0.6, secret } };
  state.dailyRisk = { dayUtc: '2026-10-17', realizedUsdt: -0.9, consecutiveLosses: 1, lastLossAt: 1000, basis: 'Conservative guard only; not a performance estimate', secret };
  state.orders = [{ orderId: 12, side: 'SELL', status: 'FILLED', executedQty: 0.0001, quoteQty: 8.3, time: 1, reason: 'Adaptive exit', clientOrderId: secret, commissions: [{ asset: 'BNB', amount: 0.0001, secret }], realizedUsdt: 0.02, realizedPnlComplete: false, decisionSnapshot: decision }];
  const now = 1800000000000; const requests = [];
  const client = { syncTime: async () => now, request: async (method, path) => {
    requests.push({ method, path }); assert.equal(method, 'GET');
    if (path.endsWith('/klines')) return Array.from({ length: 60 }, (_, index) => [now - (60 - index) * 60000, '83000', '83050', '82950', '83000', '1', now - (59 - index) * 60000 - 1]);
    if (path.endsWith('/account')) return { apiKey: secret, balances: [{ asset: 'USDT', free: '10000', locked: '0' }] };
    if (path.endsWith('/price')) return { price: '83000' };
    if (path.endsWith('/openOrders')) return [];
    if (path.endsWith('/myTrades')) return [];
    throw new Error('Unexpected mock path');
  } };
  const data = await monitorSnapshot(client, config, state, { status: 'stopped' });
  assert.equal(data.adaptive.route, 'trend_continuation'); assert.equal(data.adaptive.checkedAt, decision.checkedAt);
  assert.equal(data.position.riskSnapshot.stopLossPercent, 0.28); assert.equal(data.position.feeValuationComplete, false);
  assert.equal(data.dailyRisk.realizedUsdt, -0.9); assert.equal(data.dailyRisk.isPerformanceEstimate, false);
  assert.equal(data.botOrders[0].commissions[0].asset, 'BNB'); assert.equal(data.botOrders[0].realizedUsdt, 0.02); assert.equal(data.botOrders[0].realizedPnlComplete, false);
  assert.equal(data.botOrders[0].decisionSnapshot.route, 'trend_continuation');
  assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal(requests.length, 5); assert.ok(requests.every(request => request.method === 'GET'));
  assert.equal(state.adaptiveDecision.apiKey, secret);
  const heartbeat = { accountTag: state.accountTag, status: 'running', updatedAt: now, result: { action: 'WAIT' } };
  assert.match(monitorActivity(heartbeat, config, state.accountTag, now, true).label, /Adaptive Testnet strategy running/);
});

const shortConfig = () => ({ ...adaptiveConfig(), adaptiveProfile: 'short', stopLoss: 0.15, takeProfit: 0.15, maxHoldMinutes: 3, softHoldMinutes: 1, minSignalHoldSeconds: 10, minNetEdgePercent: 0.01 });
const shortDecision = () => ({ ...adaptiveDecision(), side: null, route: null,
  reason: 'Volatility research proxy does not cover estimated costs and safety buffer',
  riskSnapshot: { stopLossPercent: 0.15, takeProfitPercent: 0.15, costSnapshot: { buyFeePercent: 0, sellFeePercent: 0, slippagePerSidePercent: 0.02, source: 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION', checkedAt: Date.parse('2026-10-17T08:00:00Z'), verified: true } },
  thresholds: { roundTripCostPercent: 0.052, minGrossOpportunityPercent: 0.062, opportunityProxyPercent: 0.04, opportunityIsResearchProxy: true,
    buyFeePercent: 0, sellFeePercent: 0, feeVerified: true, feeSource: 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION', checkedAt: Date.parse('2026-10-17T08:00:00Z'), expiresAt: Date.parse('2026-10-17T08:05:00Z') }
});

test('short adaptive UI is Chinese, distinguishes entry waiting from shorter holding exits and reports current verified fees', async () => {
  const { get, legends } = await renderPayload(snapshot({ config: shortConfig(), adaptive: shortDecision(),
    adaptiveStats: { startedAt: Date.parse('2026-10-17T07:59:00Z'), checks: 12, lastCheckedAt: Date.parse('2026-10-17T08:00:00Z'), lastOrderAt: null,
      waitReasons: [{ reason: 'Volatility research proxy does not cover estimated costs and safety buffer', count: 9 }, { reason: 'No confirmed trend-continuation or pullback-rebound route', count: 3 }] }
  }), true);
  const settings = text(get('settings')); const summary = get('signal-summary').textContent;
  assert.match(settings, /短周期自适应/); assert.match(settings, /盈利未经验证/);
  assert.match(settings, /目标约 5 秒；有信号才下单，不是固定成交/);
  assert.match(settings, /普通趋势退出至少持仓10秒；满1分钟且覆盖成本可退出；最长 3 分钟/);
  assert.match(settings, /零费率时门槛为0\.05%＋价差/);
  assert.match(settings, /未知或过期按每边0\.10%/);
  assert.match(settings, /等待入场没有固定上限/);
  assert.match(summary, /等待：波动研究值不足以覆盖估算成本和缓冲/);
  assert.match(summary, /不是预期收益或盈利预测/);
  assert.match(summary, /买 0\.0000% \/ 卖 0\.0000%；已核验测试网账户费率/);
  assert.match(summary, /核验于 10\/17 16:00:00，有效至 10\/17 16:05:00/);
  assert.match(summary, /累计检查 12 次（不是历史全部检查，也不是成交次数）/);
  assert.match(summary, /主要等待原因：波动研究值不足以覆盖估算成本和缓冲（9 次）/);
  assert.match(summary, /尚无最近委托时间记录/);
  assert.match(get('opened').textContent, /等待短周期入场信号，不是定时买卖/);
  assert.match(get('risk-note').textContent, /不保证一分钟成交一次/);
  assert.match(get('risk-note').textContent, /不是交易所保护单/);
  assert.match(legends[1].textContent, /仅参考/);
});

test('short adaptive fallback and absent statistics remain unknown rather than zero activity history', async () => {
  const decision = shortDecision(); decision.thresholds = { ...decision.thresholds, buyFeePercent: 0.1, sellFeePercent: 0.1, feeVerified: false, feeSource: 'CONSERVATIVE_FALLBACK', checkedAt: null, expiresAt: null };
  const { get } = await renderPayload(snapshot({ config: shortConfig(), adaptive: decision }), true);
  const summary = get('signal-summary').textContent;
  assert.match(summary, /买 0\.1000% \/ 卖 0\.1000%；未知或过期，采用保守假设/);
  assert.match(summary, /检查统计尚未取得，不能倒推此前等待时长/);
  assert.doesNotMatch(summary, /累计检查 0|已核验测试网账户费率|核验于|有效至/);
});

test('short adaptive failures invalidate fee and statistics audit and mark old data in Chinese', async () => {
  const config = shortConfig();
  const { get, refresh } = await renderPayload(snapshot({ config, adaptive: shortDecision(), adaptiveStats: { startedAt: 1, checks: 999, waitReasons: [] } }), true);
  await refresh({ mode: 'BINANCE_SPOT_TESTNET', config, symbol: 'BTCUSDT', activity: { status: 'running', label: '运行中' }, error: '网络超时', adaptive: shortDecision(), adaptiveStats: { checks: 999 } });
  assert.match(get('signal-summary').textContent, /当前决断、费率核验、持仓风险和检查统计均未经确认/);
  assert.doesNotMatch(get('signal-summary').textContent, /已核验|999|0\.0000%/);
  assert.match(get('error').textContent, /旧数据，请勿当作当前状态/);
  assert.match(get('activity-label').textContent, /交易状态未经确认/);
  const result = await renderError({ mode: 'BINANCE_SPOT_TESTNET', config, symbol: 'BTCUSDT', activity: { status: 'stopped', label: '策略已停止' }, error: '访问拒绝' });
  assert.equal(result.get('trade-count').textContent, '成交记录暂未取得');
  assert.equal(result.get('opened').textContent, '当前持仓数据暂未取得');
});

test('short adaptive snapshot allowlists fee contexts and recording statistics without another remote request', async () => {
  const config = shortConfig(); const state = initialState(config, 'fixture-testnet-key'); const secret = 'MUST_NOT_LEAK_SHORT_FEE_METADATA';
  state.adaptiveDecision = { ...shortDecision(), thresholds: { ...shortDecision().thresholds, privateKey: secret }, riskSnapshot: { ...shortDecision().riskSnapshot, costSnapshot: { ...shortDecision().riskSnapshot.costSnapshot, apiKey: secret } } };
  state.position = { quantity: 0.001, entryPrice: 83000, openedAt: 1, batches: 1, deployedUsdt: 83, riskSnapshot: state.adaptiveDecision.riskSnapshot };
  state.adaptiveStats = { startedAt: 1000, checks: 12, lastCheckedAt: 2000, lastOrderAt: null, waitReasons: { warmup: 3, volatility: 9, invalid: NaN }, apiKey: secret };
  const now = 1800000000000; const requests = [];
  const client = { syncTime: async () => now, request: async (method, path) => {
    requests.push({ method, path }); assert.equal(method, 'GET');
    if (path.endsWith('/klines')) return Array.from({ length: 60 }, (_, index) => [now - (60 - index) * 60000, '83000', '83050', '82950', '83000', '1', now - (59 - index) * 60000 - 1]);
    if (path.endsWith('/account')) return { balances: [{ asset: 'USDT', free: '10000', locked: '0' }] };
    if (path.endsWith('/price')) return { price: '83000' };
    if (path.endsWith('/openOrders') || path.endsWith('/myTrades')) return [];
    throw new Error('Unexpected mock path');
  } };
  const data = await monitorSnapshot(client, config, state, { status: 'stopped' });
  assert.equal(data.adaptive.thresholds.buyFeePercent, 0); assert.equal(data.adaptive.thresholds.feeVerified, true);
  assert.equal(data.adaptive.thresholds.feeSource, 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION');
  assert.equal(data.adaptive.thresholds.expiresAt, state.adaptiveDecision.thresholds.expiresAt);
  assert.equal(data.position.riskSnapshot.costSnapshot.source, 'BINANCE_SPOT_TESTNET_ACCOUNT_COMMISSION');
  assert.equal(data.position.riskSnapshot.costSnapshot.verified, true);
  assert.deepEqual(data.adaptiveStats, { startedAt: 1000, checks: 12, lastCheckedAt: 2000, lastOrderAt: null, waitReasons: [{ reason: 'volatility', count: 9 }, { reason: 'warmup', count: 3 }] });
  assert.equal(JSON.stringify(data).includes(secret), false); assert.equal(requests.length, 5);
  const heartbeat = { accountTag: state.accountTag, status: 'running', updatedAt: now, result: { action: 'WAIT' } };
  assert.equal(monitorActivity(heartbeat, config, state.accountTag, now, true).label, '自动策略运行中');
});
