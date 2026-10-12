const element = id => document.getElementById(id);
const number = (value, digits = 2) => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const cell = (row, value, className = '') => { const td = document.createElement('td'); td.textContent = value; td.className = className; row.append(td); };
const label = (container, name, value) => {
  const div = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd');
  dt.textContent = name; dd.textContent = value; div.append(dt, dd); container.append(div);
};
let busy = false;
let lastUpdated = 0;
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
function renderConfiguration(data) {
  const settings = element('settings'); settings.replaceChildren();
  const rapid = data.config.strategy === 'fast';
  const cycling = data.config.strategy === 'cycle';
  const settingRows = cycling
    ? [['模式', `${data.config.cycleSeconds} 秒循环试验（非盈利策略）`], ['交易对', data.symbol], ['交易间隔', `${data.config.cycleSeconds} 秒（成交核对后计时）`], ['目标频率', '每分钟约两笔：买一次、卖一次'], ['单笔上限', `${data.config.tradeUsdt} 虚拟 USDT`], ['每轮检查间隔', `${data.config.pollSeconds} 秒 + 请求耗时`], ['买入次数上限', `${data.config.maxBuysPerHour} 次 / 滚动小时（不限制卖出）`], ['信号规则', '不使用均线或止盈止损信号']]
    : [['模式', rapid ? '快速实验（非盈利验证）' : '经典均线'], ['交易对', data.symbol], ['K 线周期', data.config.interval], ['均线', `SMA ${data.config.fast} / ${data.config.slow}`], ['单笔上限', `${data.config.tradeUsdt} 虚拟 USDT`], ['止损 / 止盈', `${data.config.stopLoss}% / ${data.config.takeProfit}%`], ['每轮检查间隔', `${data.config.pollSeconds} 秒 + 请求耗时`]];
  if (rapid) settingRows.push(['最长持仓', `${data.config.maxHoldMinutes} 分钟`], ['买入冷却', `${data.config.cooldownSeconds} 秒（任何成交后）`], ['买入次数上限', `${data.config.maxBuysPerHour} 次 / 滚动小时（不限制卖出）`]);
  for (const [name, value] of settingRows) label(settings, name, value);
  const indicators = data.indicators;
  element('signal-summary').textContent = cycling
    ? `空仓买入、持仓卖出，每次成交核对后至少等待 ${data.config.cycleSeconds} 秒。${data.cycle ? `计划下次${data.cycle.nextSide === 'BUY' ? '买入' : '卖出'}：不早于 ${time(data.cycle.nextActionAt)}；仅策略正常运行时执行。` : '循环规则已配置，尚未取得当前交易数据。'} 图中均线只供参考，不参与循环买卖。`
    : indicators ? `最新 K 线收盘 ${time(indicators.closeTime)} · SMA ${data.config.fast}：${number(indicators.fast)} / SMA ${data.config.slow}：${number(indicators.slow)}。仅最新收盘交叉有效，不补历史信号。${data.strategyChangedAt ? `模式接管于 ${time(data.strategyChangedAt)}。` : ''}` : '均线数据尚未取得';
  element('risk-note').textContent = cycling
    ? '这是固定间隔的虚拟委托流程试验，不是盈利策略。请求和撮合耗时会延后成交，不能保证每分钟恰好两笔。仅卖出机器人持仓；断网、访问受限、订单结果不明、关机或休眠时不能继续买卖，没有交易所实时保护单。'
    : rapid ? `均线交叉按新收盘的一分钟 K 线判断；止损、止盈、最长持仓每轮都检查，不等待下一根收盘。每轮间隔 ${data.config.pollSeconds} 秒加请求耗时，不是实时成交保证。断网、关机或休眠时无法执行。退出可能受最小数量限制。` : '止盈止损按新收盘 K 线检查，不是交易所实时保护单。断网、关机或休眠时无法执行。';
  element('refresh-note').textContent = `看板每 5 秒请求更新，账户数据最多缓存 ${rapid || cycling ? 5 : 20} 秒。访问受限时停止外部刷新，核实后需重启看板。关闭看板不会停止机器人。`;
  element('trading-help').textContent = cycling
    ? '成交表只显示测试网已确认的实际记录。循环正常运行时按间隔交替买卖；配置完成不代表已启动，也不代表已成交。停机后不补发错过的循环。'
    : '成交表显示实际买卖记录。价格波动时，持仓估值和浮盈会更新；无信号时保持等待。历史交叉不代表当时程序正在运行，重启不会补执行历史交叉。';
  const legend = document.querySelectorAll('.legend span'); legend[1].textContent = `SMA ${data.config.fast}${cycling ? '（仅参考）' : ''}`; legend[2].textContent = `SMA ${data.config.slow}${cycling ? '（仅参考）' : ''}`;
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
  element('entry').textContent = data.position ? `$${number(data.position.entryPrice)}` : '当前空仓';
  element('opened').textContent = data.position ? `买入时间 ${time(data.position.openedAt)} · 估值 ${number(data.position.value, 4)} 虚拟 USDT` : data.config.strategy === 'cycle' ? '等待下一次循环买入' : '等待策略信号';
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
    cell(row, number(order.executedQty, 8)); cell(row, `${number(order.quoteQty, 8)} USDT`); cell(row, order.reason); orders.append(row);
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
      if (data.mode === 'BINANCE_SPOT_TESTNET' && data.config) renderConfiguration(data);
      const error = new Error(data.error || '读取测试账户失败。');
      if (data.mode === 'BINANCE_SPOT_TESTNET') error.localActivity = data.activity;
      throw error;
    }
    if (data.mode !== 'BINANCE_SPOT_TESTNET') throw new Error('数据源不是测试网，已拒绝显示。');
    render(data); lastUpdated = data.updatedAt; element('error').hidden = true;
  } catch (error) {
    element('error').hidden = false;
    element('error').textContent = `数据刷新失败：${error.message}${lastUpdated ? `。当前显示的是 ${time(lastUpdated)} 的旧数据，请勿当作当前状态。` : ''}`;
    if (!lastUpdated) {
      element('trade-count').textContent = '成交记录暂未取得';
      element('order-count').textContent = '订单记录暂未取得';
      element('opened').textContent = '当前持仓数据暂未取得';
      element('open-orders').textContent = '未完成委托暂未取得';
    }
    const confirmedStopped = ['stopped', 'error', 'stale'].includes(error.localActivity?.status);
    element('activity-label').textContent = confirmedStopped ? `${error.localActivity.label} · 账户刷新失败` : '连接失败，交易状态未经确认';
    element('activity-action').textContent = confirmedStopped ? error.localActivity.action || '本机交易程序未运行' : '无法确认当前交易状态，请勿将旧数据当作实时数据。';
    element('dot').className = 'dot error';
  } finally { busy = false; element('refresh').disabled = false; }
}
element('refresh').addEventListener('click', refresh);
void refresh(); setInterval(refresh, 5000);
