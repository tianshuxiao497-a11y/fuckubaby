const element = id => document.getElementById(id);
const number = (value, digits = 2) => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const knownNumber = (value, digits = 2) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? number(value, digits) : '未取得';
const knownPercent = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${number(value, 4)}%` : '未取得';
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const cell = (row, value, className = '') => { const td = document.createElement('td'); td.textContent = value; td.className = className; row.append(td); return td; };
const label = (container, name, value) => {
  const div = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd');
  dt.textContent = name; dd.textContent = value; div.append(dt, dd); container.append(div);
};
let busy = false;
let lastUpdated = 0;
let lastStrategy = null;
let lastAdaptiveProfile = null;
const auditNumber = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? number(value, digits) : 'unavailable';
const auditPercent = value => typeof value === 'number' && Number.isFinite(value) ? `${number(value, 4)}%` : 'unavailable';
const shortReason = reason => ({
  'Pending Testnet order must be reconciled before another decision': '先核对结果未明的测试网委托，禁止重复下单',
  'Adaptive stop loss': '触发冻结止损', 'Adaptive take profit': '触发冻结止盈',
  'Adaptive maximum holding time exit': '达到最长持仓时间',
  'Waiting for minimum five-second order interval': '等待普通下单最短5秒间隔',
  'Fee-aware trailing exit': '达到扣除假设成本后的追踪退出条件',
  'Fee-covered soft holding timeout': '达到软持仓时间，且当前涨幅覆盖估算成本',
  'Confirmed adaptive trend weakness': '确认趋势转弱',
  'Warming up: need three observations spanning 10–30 seconds': '报价预热中，需要至少3个样本、跨度10–30秒',
  'Public bid/ask spread is too wide': '买卖价差过大',
  'Price is too extended from the fast EMA': '价格偏离快均线过远，避免追高',
  'Volatility research proxy does not cover estimated costs and safety buffer': '波动研究值不足以覆盖估算成本和缓冲',
  'No confirmed trend-continuation or pullback-rebound route': '顺势延续 / 回调反弹均未确认',
  'Existing/adopted inventory is exit-only or already fully staged': '现有持仓只允许退出，或已完成全部分批',
  'Addition requires a profitable holding and a confirmed price advance': '加仓须持仓盈利，且价格较上一批继续上涨',
  'Virtual position deployment budget is exhausted': '本轮虚拟资金投入预算已用完',
  'Daily realized virtual-loss budget reached': '达到当日保守亏损限额',
  'Consecutive-loss cooldown': '连续亏损冷却中', 'Recent-loss cooldown': '最近一笔亏损冷却中',
  'Hourly virtual BUY limit reached': '达到滚动小时买入上限', 'Flat-position re-entry cooldown': '空仓后重新买入冷却中'
})[reason] || (typeof reason === 'string' && /^Confirmed (trend continuation|pullback rebound); tranche [123]\/3$/.test(reason)
  ? reason.replace('Confirmed trend continuation; tranche ', '顺势延续已确认，第 ').replace('Confirmed pullback rebound; tranche ', '回调反弹已确认，第 ').replace('/3', ' / 3 批') : reason || '理由未取得');
function shortAdaptiveSummary(data, accountVerified) {
  if (!accountVerified) return '仅显示已配置规则：账户 / 行情刷新失败，当前决断、费率核验、持仓风险和检查统计均未经确认。配置不代表正在运行或已经成交。';
  const decision = data.adaptive;
  if (!decision) return '尚未取得当前短周期决断；检查次数不是成交次数，不能据此预测下一笔时间。图中 SMA 仅供参考，策略实际使用 EMA。';
  const metrics = decision.indicators || {}; const thresholds = decision.thresholds || {};
  const side = ({ BUY: '拟买入', SELL: '拟卖出' })[decision.side] || '等待';
  const route = ({ trend_continuation: '顺势延续', pullback_rebound: '回调反弹' })[decision.route] || '尚未确认';
  let summary = `${decision.checkedAt ? `策略检查 ${time(decision.checkedAt)}` : '检查时间未取得'} · ${side}：${shortReason(decision.reason)}。路线：${route}；预热${decision.warmReady === true ? '已就绪' : '未就绪'}（${knownNumber(decision.sampleCount, 0)} 个样本）；短动量 ${knownPercent(decision.momentumPercent)}，价差 ${knownPercent(decision.spreadPercent)}。EMA ${data.config.fast}/${data.config.slow}：${knownNumber(decision.fast)} / ${knownNumber(decision.slow)}，RSI 7：${knownNumber(metrics.rsi)}，ATR 7：${knownPercent(metrics.atrPercent)}，5分钟趋势偏差 ${knownPercent(metrics.contextBiasPercent)}。`;
  summary += ` 波动研究值 ${knownPercent(thresholds.opportunityProxyPercent)} / 成本加缓冲门槛 ${knownPercent(thresholds.minGrossOpportunityPercent)}，不是预期收益或盈利预测。`;
  summary += ` 费率：买 ${knownPercent(thresholds.buyFeePercent)} / 卖 ${knownPercent(thresholds.sellFeePercent)}；${thresholds.feeVerified === true ? '已核验测试网账户费率' : '未知或过期，采用保守假设'}${thresholds.checkedAt ? `，核验于 ${time(thresholds.checkedAt)}` : ''}${thresholds.expiresAt ? `，有效至 ${time(thresholds.expiresAt)}` : ''}。`;
  if (decision.side === 'BUY') summary += ` 拟执行第 ${knownNumber(decision.batchIndex, 0)} / 3 批，${knownNumber(decision.batchUsdt)} 虚拟 USDT；拟委托不是已成交。`;
  const risk = data.position?.riskSnapshot || decision.riskSnapshot;
  summary += ` ${data.position ? '持仓冻结风险' : '候选入场风险，首笔成交后才冻结'}：止损 ${knownPercent(risk?.stopLossPercent)} / 止盈 ${knownPercent(risk?.takeProfitPercent)}。`;
  if (data.position?.adopted) summary += ' 接管的旧持仓只管理退出，不加仓。';
  else if (data.position) summary += ` 已成交 ${knownNumber(data.position.batches, 0)} / 3 批，累计投入 ${knownNumber(data.position.deployedUsdt, 4)} / ${data.config.tradeUsdt} 虚拟 USDT。`;
  const stats = data.adaptiveStats;
  if (stats && typeof stats.checks === 'number') {
    summary += ` 自${stats.startedAt ? ` ${time(stats.startedAt)} ` : '开始记录后'}累计检查 ${knownNumber(stats.checks, 0)} 次（不是历史全部检查，也不是成交次数）${stats.lastOrderAt ? `；最近本机委托记录 ${time(stats.lastOrderAt)}（可能早于统计起点）` : '；尚无最近委托时间记录'}。`;
    if (Array.isArray(stats.waitReasons) && stats.waitReasons.length) summary += ` 主要等待原因：${stats.waitReasons.slice(0, 3).map(item => `${shortReason(item.reason)}（${knownNumber(item.count, 0)} 次）`).join('；')}。`;
  } else summary += ' 检查统计尚未取得，不能倒推此前等待时长。';
  if (data.dailyRisk) summary += ` UTC ${data.dailyRisk.dayUtc || '日期未取得'} 保守风控累计 ${knownNumber(data.dailyRisk.realizedUsdt, 4)} USDT，连续保守亏损 ${knownNumber(data.dailyRisk.consecutiveLosses, 0)} 次；这不是收益报告。`;
  return summary;
}
function adaptiveSummary(data, accountVerified) {
  if (data?.config?.adaptiveProfile === 'short' || !data && lastAdaptiveProfile === 'short') return shortAdaptiveSummary(data, accountVerified);
  if (!accountVerified) return 'Configuration only: account / market refresh failed. The current adaptive decision, frozen risk, daily guard and tranche state are unverified. Configuration does not mean running or filled.';
  const decision = data.adaptive;
  if (!decision) return 'No recorded adaptive decision available. Checks are not fills; wait for a verified runner audit. The SMA chart is reference-only, not the adaptive EMA signal.';
  const metrics = decision.indicators || {}; const thresholds = decision.thresholds || {};
  const side = ({ BUY: 'Proposed BUY', SELL: 'Proposed SELL' })[decision.side] || 'WAIT';
  let summary = `Decision checked ${decision.checkedAt ? time(decision.checkedAt) : 'at an unavailable time'} · ${side}: ${decision.reason || 'Reason unavailable'}. Route: ${decision.route || 'none confirmed'}. Warm-up ${decision.warmReady === true ? 'ready' : 'not ready'} (${auditNumber(decision.sampleCount, 0)} observations); momentum ${auditPercent(decision.momentumPercent)}; spread ${auditPercent(decision.spreadPercent)}. EMA ${data.config.fast}/${data.config.slow}: ${auditNumber(decision.fast)} / ${auditNumber(decision.slow)}; RSI 7 ${auditNumber(metrics.rsi)}; ATR 7 ${auditPercent(metrics.atrPercent)}; complete 5m context bias ${auditPercent(metrics.contextBiasPercent)}. `;
  summary += `Volatility research proxy ${auditPercent(thresholds.opportunityProxyPercent)} vs cost-plus-buffer threshold ${auditPercent(thresholds.minGrossOpportunityPercent)}; this is not an expected return or profit forecast. `;
  if (decision.side === 'BUY') summary += `Proposed tranche ${auditNumber(decision.batchIndex, 0)}/3: ${auditNumber(decision.batchUsdt)} virtual USDT; remaining deployment budget ${auditNumber(decision.remainingBudget)}. A proposed order is not a fill. `;
  const risk = data.position?.riskSnapshot || decision.riskSnapshot;
  summary += `${data.position ? 'Frozen position risk' : 'Candidate entry risk, frozen only on the first fill'}: SL ${auditPercent(risk?.stopLossPercent)} / TP ${auditPercent(risk?.takeProfitPercent)}. `;
  if (data.position?.adopted) summary += 'Adopted inventory is exit-only; no additions. ';
  else if (data.position) summary += `Filled tranches ${auditNumber(data.position.batches, 0)}/3; deployed purchase notional ${auditNumber(data.position.deployedUsdt, 4)} / ${data.config.tradeUsdt} virtual USDT. `;
  const guard = data.dailyRisk;
  summary += guard ? `Recorded guard day ${guard.dayUtc || 'unavailable'} UTC: conservative guard P&L ${auditNumber(guard.realizedUsdt, 4)} USDT; consecutive conservative losses ${auditNumber(guard.consecutiveLosses, 0)}. Basis: ${guard.basis || 'unavailable'}. This guard is not a performance estimate.` : 'No daily guard record available; do not interpret missing records as zero profit or loss.';
  return summary;
}
function chart(candles, fast, slow) {
  if (!candles.length) return;
  const closes = candles.map(candle => candle.close);
  const average = period => closes.map((_, index) => index + 1 < period ? null : closes.slice(index + 1 - period, index + 1).reduce((sum, value) => sum + value, 0) / period);
  const fastValues = average(fast); const slowValues = average(slow);
  const min = Math.min(...closes); const max = Math.max(...closes); const range = Math.max(max - min, max * 0.0005);
  const path = values => values.map((value, index) => value === null ? '' : `${index === 0 || values[index - 1] === null ? 'M' : 'L'}${(index / Math.max(1, values.length - 1) * 900).toFixed(2)},${(195 - (value - min) / range * 180).toFixed(2)}`).join(' ');
  element('price-line').setAttribute('d', path(closes)); element('fast-line').setAttribute('d', path(fastValues)); element('slow-line').setAttribute('d', path(slowValues));
  element('chart-high').textContent = `高 $${number(max)}`; element('chart-low').textContent = `低 $${number(min)}`;
  element('chart-start').textContent = time(candles[0].time); element('chart-end').textContent = time(candles.at(-1).time);
}
function renderConfiguration(data, accountVerified = true) {
  lastStrategy = data.config.strategy;
  lastAdaptiveProfile = data.config.adaptiveProfile || null;
  const settings = element('settings'); settings.replaceChildren();
  const rapid = data.config.strategy === 'fast';
  const cycling = data.config.strategy === 'cycle';
  const tactical = data.config.strategy === 'tactical';
  const adaptive = data.config.strategy === 'adaptive';
  const short = adaptive && data.config.adaptiveProfile === 'short';
  const fractions = data.config.batchFractions || (adaptive ? [0.4, 0.3, 0.3] : [0.25, 0.25, 0.5]);
  const settingRows = short
    ? [['模式', '短周期自适应 · 仅测试网虚拟资金 · 盈利未经验证'], ['交易对', data.symbol], ['行情检查', `目标约 ${data.config.pollSeconds} 秒；有信号才下单，不是固定成交`], ['指标', `EMA ${data.config.fast}/${data.config.slow} + RSI 7 + ATR 7；已收盘1分钟行情和完整5分钟趋势`], ['每轮投入上限', `${data.config.tradeUsdt} 虚拟 USDT，不是每批上限`], ['分批', fractions.map(fraction => `${number(fraction * 100, 0)}% / ${number(data.config.tradeUsdt * fraction)} USDT`).join(' → ')], ['开仓预热', '至少3个报价、跨度10–30秒；间断超过15秒重新预热'], ['入场路线', '顺势延续或回调反弹；价格、动量、评分仍需通过'], ['价差 / 追高过滤', `价差 ≤ ${data.config.maxSpreadPercent}%；偏离快线 ≤ ${data.config.maxExtensionPercent}%`], ['成本门槛', '使用5分钟内核验的测试网买/卖费率；未知或过期按每边0.10%。另加每边0.02%滑点、实际价差和0.01%缓冲；零费率时门槛为0.05%＋价差'], ['波动过滤', '4 × ATR须覆盖成本门槛；研究性代理指标，不是预期收益'], ['首次入场风险', `基础止损 ${data.config.stopLoss}% / 止盈 ${data.config.takeProfit}%；ATR调整后止损0.10–0.40%、止盈0.10–0.60%，首笔冻结`], ['退出周期', `普通趋势退出至少持仓10秒；满1分钟且覆盖成本可退出；最长 ${data.config.maxHoldMinutes} 分钟（网络异常可能延迟）`], ['下单间隔', `普通动作至少 ${data.config.minOrderSeconds} 秒；止损 / 止盈 / 最长持仓退出优先`], ['加仓限制', '只给盈利且继续上涨的本程序持仓加仓；不摊低成本'], ['入场冷却', `空仓重入 ${data.config.cooldownSeconds} 秒；保守亏损后60秒；连续3亏暂停15分钟`], ['日内风控', 'UTC当日保守风控累计亏损达到5虚拟USDT，停止新买入，不拦保护卖出'], ['买入上限', `${data.config.maxBuysPerHour} 笔已成交买单 / 滚动小时，包含分批`], ['频率说明', '等待入场没有固定上限；1分钟软退出 / 3分钟最长持仓是规则，不是成交周期预测']]
    : adaptive
    ? [['Strategy', 'Adaptive · Spot Testnet only · profitability unvalidated'], ['Market', data.symbol], ['Decision checks', `Target ~${data.config.pollSeconds}s; not periodic fills; network delays apply`], ['Indicators', `EMA ${data.config.fast}/${data.config.slow} + RSI 7 + ATR 7; closed 1m candles and complete 5m context`], ['Deployment cap', `${data.config.tradeUsdt} virtual USDT per round, not per tranche`], ['Tranches', fractions.map(fraction => `${number(fraction * 100, 0)}% / ${number(data.config.tradeUsdt * fraction)} USDT`).join(' → ')], ['Warm-up', 'At least 3 observations spanning 10–30s; gaps above 15s reset samples'], ['Entry routes', 'Confirmed trend continuation or pullback rebound; otherwise WAIT'], ['Entry filters', `Spread ≤ ${data.config.maxSpreadPercent}%; extension ≤ ${data.config.maxExtensionPercent}% from fast EMA`], ['Costs & opportunity', 'Assume 0.10% fee + 0.02% slippage per side, plus spread and 0.05% buffer; 4 × ATR is a research proxy, not a forecast'], ['Risk inputs', `${data.config.stopLoss}% SL / ${data.config.takeProfit}% TP; ATR-adjusted thresholds frozen on first fill`], ['Holding exits', `Hard maximum ${data.config.maxHoldMinutes}m; soft 3m only when estimated costs are covered`], ['Order spacing', `Ordinary actions at least ${data.config.minOrderSeconds}s apart; SL / TP / hard timeout take priority`], ['Entry safeguards', `Flat re-entry cooldown ${data.config.cooldownSeconds}s; recent loss 60s; no averaging down`], ['Daily guard', 'Block new BUYs at −5 virtual USDT conservative guard P&L per UTC day; not performance P&L'], ['Loss-streak guard', '3 consecutive conservative losses: pause entries for 15m; exits remain allowed'], ['BUY limit', `${data.config.maxBuysPerHour} filled BUY orders / rolling hour, including tranches; exits are not blocked`]]
    : tactical
    ? [['模式', '短周期行情决断（未验证盈利）'], ['交易对', data.symbol], ['行情检查间隔', `目标约 ${data.config.pollSeconds} 秒检查；网络耗时可延后（非固定成交）`], ['普通委托最短间隔', `${data.config.minOrderSeconds} 秒；有信号才执行，风险退出优先`], ['每轮总投入上限', `${data.config.tradeUsdt} 虚拟 USDT（不是每批上限）`], ['分批计划', fractions.map(fraction => `${number(fraction * 100, 0)}% / ${number(data.config.tradeUsdt * fraction, 2)} USDT`).join(' → ')], ['开仓条件', `SMA ${data.config.fast} > ${data.config.slow}，当前价不低于快均线`], ['行情过滤', `20–45 秒短动量 ≥ ${data.config.entryMomentumPercent}%；价差 ≤ ${data.config.maxSpreadPercent}%；偏离快均线 ≤ ${data.config.maxExtensionPercent}%`], ['加仓条件', `信号持续，且较上批上涨 ≥ ${data.config.addStepPercent}%；不摊低成本`], ['止损 / 止盈', `${data.config.stopLoss}% / ${data.config.takeProfit}%`], ['其他退出条件', `均线转弱、短动量 ≤ −${data.config.exitMomentumPercent}%，或持仓满 ${data.config.maxHoldMinutes} 分钟`], ['退出后买入冷却', `${data.config.cooldownSeconds} 秒`], ['买入次数上限', `${data.config.maxBuysPerHour} 次 / 滚动小时（不限制卖出）`]]
    : cycling
    ? [['模式', `${data.config.cycleSeconds} 秒循环试验（非盈利策略）`], ['交易对', data.symbol], ['交易间隔', `${data.config.cycleSeconds} 秒（成交核对后计时）`], ['目标频率', '每分钟约两笔：买一次、卖一次'], ['单笔上限', `${data.config.tradeUsdt} 虚拟 USDT`], ['每轮检查间隔', `${data.config.pollSeconds} 秒 + 请求耗时`], ['买入次数上限', `${data.config.maxBuysPerHour} 次 / 滚动小时（不限制卖出）`], ['信号规则', '不使用均线或止盈止损信号']]
    : [['模式', rapid ? '快速实验（非盈利验证）' : '经典均线'], ['交易对', data.symbol], ['K 线周期', data.config.interval], ['均线', `SMA ${data.config.fast} / ${data.config.slow}`], ['单笔上限', `${data.config.tradeUsdt} 虚拟 USDT`], ['止损 / 止盈', `${data.config.stopLoss}% / ${data.config.takeProfit}%`], ['每轮检查间隔', `${data.config.pollSeconds} 秒 + 请求耗时`]];
  if (rapid) settingRows.push(['最长持仓', `${data.config.maxHoldMinutes} 分钟`], ['买入冷却', `${data.config.cooldownSeconds} 秒（任何成交后）`], ['买入次数上限', `${data.config.maxBuysPerHour} 次 / 滚动小时（不限制卖出）`]);
  for (const [name, value] of settingRows) label(settings, name, value);
  const indicators = accountVerified ? data.indicators : null;
  const decision = accountVerified ? data.tactical : null;
  let tacticalSummary = '规则已配置，尚未取得当前策略决断；检查频率不代表成交频率。';
  if (!accountVerified) tacticalSummary = '规则已配置，但账户 / 行情刷新失败。当前决断、预热、动量、价差与分批状态未经确认；配置不代表已启动或已成交。';
  else if (decision) {
    const action = ({ BUY: '拟买入', SELL: '拟卖出', HOLD: '继续观察', WAIT: '继续观察' })[decision.side] || '继续观察';
    tacticalSummary = `${decision.checkedAt ? `策略决断检查 ${time(decision.checkedAt)}` : '决断检查时间未取得'} · ${action}：${decision.reason || '决断理由未取得'}。行情预热${decision.warmReady ? '已就绪' : '尚未完成'}（${knownNumber(decision.sampleCount, 0)} 个样本） · 短动量 ${knownPercent(decision.momentumPercent)} · 买卖价差 ${knownPercent(decision.spreadPercent)} · SMA ${data.config.fast}：${knownNumber(decision.fast)} / SMA ${data.config.slow}：${knownNumber(decision.slow)}。`;
    if (decision.side === 'BUY') tacticalSummary += ` 拟执行第 ${knownNumber(decision.batchIndex, 0)} / ${fractions.length} 批，委托 ${knownNumber(decision.batchUsdt)} 虚拟 USDT；本轮剩余预算 ${knownNumber(decision.remainingBudget)} 虚拟 USDT。拟委托不是已成交。`;
    if (data.position?.adopted) tacticalSummary += ' 旧持仓已接管：只按退出规则管理，不再加仓。';
    else if (data.position) {
      const batches = Array.isArray(data.position.batches) ? data.position.batches.length : data.position.batches;
      tacticalSummary += ` 本轮已成交 ${knownNumber(batches, 0)} / ${fractions.length} 批，实际累计投入 ${knownNumber(data.position.deployedUsdt, 4)} / ${data.config.tradeUsdt} 虚拟 USDT。`;
    }
  }
  element('signal-summary').textContent = adaptive ? adaptiveSummary(data, accountVerified) : tactical ? tacticalSummary : cycling
    ? `空仓买入、持仓卖出，每次成交核对后至少等待 ${data.config.cycleSeconds} 秒。${accountVerified && data.cycle ? `计划下次${data.cycle.nextSide === 'BUY' ? '买入' : '卖出'}：不早于 ${time(data.cycle.nextActionAt)}；仅策略正常运行时执行。` : '循环规则已配置，尚未取得当前交易数据。'} 图中均线只供参考，不参与循环买卖。`
    : indicators ? `最新 K 线收盘 ${time(indicators.closeTime)} · SMA ${data.config.fast}：${number(indicators.fast)} / SMA ${data.config.slow}：${number(indicators.slow)}。仅最新收盘交叉有效，不补历史信号。${data.strategyChangedAt ? `模式接管于 ${time(data.strategyChangedAt)}。` : ''}` : '均线数据尚未取得';
  element('risk-note').textContent = short
    ? '短周期仅为未验证盈利的测试网试验，不保证一分钟成交一次。止盈、止损、追踪和超时退出由本机程序执行，不是交易所保护单；网络、访问限制、休眠或停止会使退出延后或无法执行。更短持仓可能增加滑点与亏损；只卖本程序记录的持仓。'
    : adaptive
    ? `Experimental Testnet rules, not verified profitability. Frozen ATR-based SL/TP and local trailing/holding exits are not exchange-hosted protection orders. Fees, spread, slippage and latency can dominate small moves. A ${data.config.pollSeconds}-second check is not a fill guarantee. Network/access failures, unknown order outcomes, shutdown or sleep can prevent exits. Only recorded bot-owned inventory may be sold.`
    : tactical
    ? '10 秒左右是观察和决断频率，不保证每 10 秒成交。分批按信号推进，不自动补单、不摊低成本；这套测试网规则尚未验证盈利，滑点和手续费可能导致亏损。仅卖出机器人持仓；网络异常、访问受限、订单结果不明、关机或休眠时无法继续，没有交易所实时保护单。'
    : cycling
    ? '这是固定间隔的虚拟委托流程试验，不是盈利策略。请求和撮合耗时会延后成交，不能保证每分钟恰好两笔。仅卖出机器人持仓；断网、访问受限、订单结果不明、关机或休眠时不能继续买卖，没有交易所实时保护单。'
    : rapid ? `均线交叉按新收盘的一分钟 K 线判断；止损、止盈、最长持仓每轮都检查，不等待下一根收盘。每轮间隔 ${data.config.pollSeconds} 秒加请求耗时，不是实时成交保证。断网、关机或休眠时无法执行。退出可能受最小数量限制。` : '止盈止损按新收盘 K 线检查，不是交易所实时保护单。断网、关机或休眠时无法执行。';
  element('refresh-note').textContent = adaptive && !short ? 'Monitor refresh target: 5s; account cache up to 5s. Use the actual decision and account timestamps. Access refusals stop external refresh until verified and the monitor restarted. Closing this read-only page does not stop the bot.' : `看板每 5 秒请求更新，账户数据最多缓存 ${rapid || cycling || tactical || adaptive ? 5 : 20} 秒。策略决断以实际检查时间为准，网络与撮合耗时会改变成交时间。访问受限时停止外部刷新，核实后需重启看板。关闭看板不会停止机器人。`;
  element('trading-help').textContent = short
    ? '拟买入 / 拟卖出不是已成交。成交表以测试网确认记录为准；手续费和已实现盈亏单独核对，未知费用不当作零。检查统计从本次功能开始记录，不能代表此前20分钟。SMA图仅供参考，实际决断使用EMA、RSI、ATR和5分钟趋势；无信号可以继续等待。'
    : adaptive
    ? 'Confirmed Testnet fills are separate from proposed decisions. Order notes expose recorded commissions, realized P&L and whether fee valuation is complete; unknown fee assets can leave P&L incomplete. The daily conservative entry guard is not a performance estimate. Missing accounting data must not be treated as zero. Chart SMA lines are reference-only; the strategy uses EMA, RSI, ATR and complete 5m context.'
    : tactical
    ? '成交表只显示测试网已确认的实际记录。“拟买入 / 拟卖出”是最近一轮决断，不代表已成交；以订单状态和成交表核对。短动量预热或信号不足时等待，分批金额之和不超过每轮总上限。停止后不会补发错过的委托。'
    : cycling
    ? '成交表只显示测试网已确认的实际记录。循环正常运行时按间隔交替买卖；配置完成不代表已启动，也不代表已成交。停机后不补发错过的循环。'
    : '成交表显示实际买卖记录。价格波动时，持仓估值和浮盈会更新；无信号时保持等待。历史交叉不代表当时程序正在运行，重启不会补执行历史交叉。';
  const legend = document.querySelectorAll('.legend span'); legend[1].textContent = `SMA ${data.config.fast}${short ? '（仅参考）' : adaptive ? ' (reference only)' : cycling ? '（仅参考）' : ''}`; legend[2].textContent = `SMA ${data.config.slow}${short ? '（仅参考）' : adaptive ? ' (reference only)' : cycling ? '（仅参考）' : ''}`;
}
function render(data) {
  element('activity-label').textContent = data.activity.label;
  element('activity-action').textContent = `${data.activity.action}${data.activity.updatedAt ? ` · 最近检查 ${time(data.activity.updatedAt)}` : ''}`;
  element('dot').className = `dot ${data.activity.status}`;
  element('updated').textContent = `账户更新 ${time(data.updatedAt)}`;
  element('price').textContent = `$${number(data.price)}`;
  element('cash').textContent = number(data.balances.find(balance => balance.asset === 'USDT')?.free || 0);
  element('quantity').textContent = number(data.position?.quantity || 0, 8);
  const pnl = data.position?.estimatedPnl || 0;
  element('pnl').textContent = `${pnl >= 0 ? '+' : '−'}${number(Math.abs(pnl), 4)} USDT`;
  element('pnl').className = pnl >= 0 ? 'positive' : 'negative';
  element('entry').textContent = data.position ? `$${number(data.position.entryPrice)}` : data.config.strategy === 'adaptive' ? 'Flat · no bot-owned position' : '当前空仓';
  element('opened').textContent = data.position ? `买入时间 ${time(data.position.openedAt)} · 估值 ${number(data.position.value, 4)} 虚拟 USDT${data.config.strategy === 'tactical' ? data.position.adopted ? ' · 旧持仓，仅管理退出，不加仓' : ` · 已成交 ${knownNumber(Array.isArray(data.position.batches) ? data.position.batches.length : data.position.batches, 0)} / ${(data.config.batchFractions || [0.25, 0.25, 0.5]).length} 批；累计投入 ${knownNumber(data.position.deployedUsdt, 4)} USDT` : ''}` : data.config.strategy === 'cycle' ? '等待下一次循环买入' : '等待策略信号';
  if (data.config.strategy === 'adaptive') element('opened').textContent = data.position ? `Opened ${time(data.position.openedAt)} · mark value ${auditNumber(data.position.value, 4)} virtual USDT · ${data.position.adopted ? 'adopted inventory, exit-only; no additions' : `filled ${auditNumber(data.position.batches, 0)}/3 tranches, deployed ${auditNumber(data.position.deployedUsdt, 4)} / ${data.config.tradeUsdt} USDT`} · frozen SL ${auditPercent(data.position.riskSnapshot?.stopLossPercent)} / TP ${auditPercent(data.position.riskSnapshot?.takeProfitPercent)} · entry fee valuation ${data.position.feeValuationComplete === true ? 'complete' : data.position.feeValuationComplete === false ? 'INCOMPLETE' : 'unknown'}; floating P&L is an estimate, not fee-complete realized performance` : 'Waiting for a confirmed adaptive entry; not a periodic BUY/SELL cycle';
  if (data.config.strategy === 'adaptive' && data.config.adaptiveProfile === 'short') {
    element('entry').textContent = data.position ? `$${number(data.position.entryPrice)}` : '当前空仓 · 无机器人持仓';
    element('opened').textContent = data.position ? `首次买入 ${time(data.position.openedAt)} · 估值 ${knownNumber(data.position.value, 4)} 虚拟 USDT · ${data.position.adopted ? '接管的旧持仓，只退出不加仓' : `已成交 ${knownNumber(data.position.batches, 0)} / 3 批，累计投入 ${knownNumber(data.position.deployedUsdt, 4)} / ${data.config.tradeUsdt} USDT`} · 冻结止损 ${knownPercent(data.position.riskSnapshot?.stopLossPercent)} / 止盈 ${knownPercent(data.position.riskSnapshot?.takeProfitPercent)} · 浮盈为估值，不是完整扣费后的已实现收益` : '等待短周期入场信号，不是定时买卖';
  }
  if (data.dust?.quantity > 0) element('opened').textContent += ` · 另存机器人零头 ${number(data.dust.quantity, 8)} BTC（暂不足合法委托，不并入新仓）`;
  renderConfiguration(data);
  const balances = element('balances'); balances.replaceChildren();
  for (const balance of data.balances) {
    const row = document.createElement('div'); row.className = 'balance-row';
    const asset = document.createElement('span'); asset.textContent = balance.asset;
    const amount = document.createElement('strong'); amount.textContent = number(balance.free, balance.asset === 'USDT' ? 4 : 8);
    const locked = document.createElement('small'); locked.textContent = `冻结 ${number(balance.locked, 8)}`;
    amount.append(locked); row.append(asset, amount); balances.append(row);
  }
  const trades = element('trades'); trades.replaceChildren();
  for (const trade of data.trades) {
    const row = document.createElement('tr');
    cell(row, time(trade.time)); cell(row, trade.side === 'BUY' ? '买入 · 已成交' : '卖出 · 已成交', trade.side === 'BUY' ? 'buy' : 'sell');
    cell(row, number(trade.price)); cell(row, number(trade.quantity, 8)); cell(row, number(trade.quote, 8)); cell(row, String(trade.orderId)); cell(row, trade.botOwned ? '机器人' : '其他测试交易');
    trades.append(row);
  }
  element('trade-count').textContent = `最近 ${data.trades.length} 笔成交（最多 50 笔明细）`;
  element('empty-trades').hidden = data.trades.length !== 0;
  const orders = element('orders'); orders.replaceChildren();
  for (const order of data.botOrders) {
    const row = document.createElement('tr'); cell(row, String(order.orderId)); cell(row, order.side === 'BUY' ? '买入' : '卖出', order.side === 'BUY' ? 'buy' : 'sell');
    cell(row, ({ FILLED: '全部成交', CANCELED: '已取消', EXPIRED: '已过期', REJECTED: '已拒绝' })[order.status] || order.status);
    cell(row, number(order.executedQty, 8)); cell(row, `${number(order.quoteQty, 8)} USDT`);
    const reasonCell = cell(row, data.config.strategy === 'adaptive' && data.config.adaptiveProfile === 'short' ? shortReason(order.reason) : order.reason);
    if (data.config.strategy === 'adaptive') {
      const feeText = Array.isArray(order.commissions) && order.commissions.length ? order.commissions.map(fee => `${auditNumber(fee.amount, 8)} ${fee.asset || 'unknown asset'}`).join(', ') : 'details not recorded';
      const realized = typeof order.realizedUsdt === 'number' && Number.isFinite(order.realizedUsdt) ? `${auditNumber(order.realizedUsdt, 6)} USDT` : order.side === 'BUY' ? 'not applicable to entry' : 'not recorded';
      const note = document.createElement('div'); const detail = document.createElement('small');
      detail.textContent = data.config.adaptiveProfile === 'short' ? `手续费：${feeText} · 已实现：${realized} · 费用计价：${order.realizedPnlComplete === true ? '完整' : order.realizedPnlComplete === false ? '不完整' : '未知'}` : `Fees: ${feeText} · Realized: ${realized} · Fee valuation: ${order.realizedPnlComplete === true ? 'complete' : order.realizedPnlComplete === false ? 'INCOMPLETE' : 'unknown'}`;
      note.append(detail); reasonCell.append(note);
    }
    orders.append(row);
  }
  element('order-count').textContent = `最近 ${data.botOrders.length} 笔订单（最多 200 笔）`;
  element('pending').textContent = data.pending ? '存在待核对委托；程序会先核对，不重复下单。' : '';
  element('open-orders').textContent = `币安未完成委托：${data.openOrders.length} 笔`;
  chart(data.candles, data.config.fast, data.config.slow);
}
async function refresh() {
  if (busy) return;
  busy = true; element('refresh').disabled = true;
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (!response.ok) {
      if (data.mode === 'BINANCE_SPOT_TESTNET' && data.config) renderConfiguration(data, false);
      const error = new Error(data.error || '读取测试账户失败。');
      if (data.mode === 'BINANCE_SPOT_TESTNET') error.localActivity = data.activity;
      throw error;
    }
    if (data.mode !== 'BINANCE_SPOT_TESTNET') throw new Error('数据源不是测试网，已拒绝显示。');
    render(data); lastUpdated = data.updatedAt; element('error').hidden = true;
  } catch (error) {
    const adaptive = lastStrategy === 'adaptive'; const short = adaptive && lastAdaptiveProfile === 'short';
    if (adaptive) element('signal-summary').textContent = adaptiveSummary(null, false);
    element('error').hidden = false;
    element('error').textContent = adaptive && !short ? `Refresh failed: ${error.message}${lastUpdated ? `. Account figures shown are OLD DATA from ${time(lastUpdated)}, not the current state.` : ''}` : `数据刷新失败：${error.message}${lastUpdated ? `。当前显示的是 ${time(lastUpdated)} 的旧数据，请勿当作当前状态。` : ''}`;
    if (!lastUpdated) {
      element('trade-count').textContent = adaptive && !short ? 'Fill records unavailable' : '成交记录暂未取得';
      element('order-count').textContent = adaptive && !short ? 'Order records unavailable' : '订单记录暂未取得';
      element('opened').textContent = adaptive && !short ? 'Current position data unavailable' : '当前持仓数据暂未取得';
      element('open-orders').textContent = adaptive && !short ? 'Open orders unavailable' : '未完成委托暂未取得';
    }
    const confirmedStopped = ['stopped', 'error', 'stale'].includes(error.localActivity?.status);
    element('activity-label').textContent = adaptive && !short ? confirmedStopped ? `${error.localActivity.label} · account refresh failed` : 'Connection failed; trading state UNVERIFIED' : confirmedStopped ? `${error.localActivity.label} · 账户刷新失败` : '连接失败，交易状态未经确认';
    element('activity-action').textContent = adaptive && !short ? confirmedStopped ? error.localActivity.action || 'Local strategy is not running' : 'Current trading state cannot be confirmed. Do not treat old data as live.' : confirmedStopped ? error.localActivity.action || '本机交易程序未运行' : '无法确认当前交易状态，请勿将旧数据当作实时数据。';
    element('dot').className = 'dot error';
  } finally { busy = false; element('refresh').disabled = false; }
}
element('refresh').addEventListener('click', refresh);
void refresh(); setInterval(refresh, 5000);
