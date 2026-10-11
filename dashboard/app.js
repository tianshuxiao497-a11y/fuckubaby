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
  element('opened').textContent = data.position ? `买入时间 ${time(data.position.openedAt)} · 估值 ${number(data.position.value, 4)} 虚拟 USDT` : '等待策略信号';
  const settings = element('settings'); settings.replaceChildren();
  const rapid = data.config.strategy === 'fast';
  const settingRows = [['模式', rapid ? '快速实验（非盈利验证）' : '经典均线'], ['交易对', data.symbol], ['K 线周期', data.config.interval], ['均线', `SMA ${data.config.fast} / ${data.config.slow}`], ['单笔上限', `${data.config.tradeUsdt} 虚拟 USDT`], ['止损 / 止盈', `${data.config.stopLoss}% / ${data.config.takeProfit}%`], ['每轮检查间隔', `${data.config.pollSeconds} 秒 + 请求耗时`]];
  if (rapid) settingRows.push(['最长持仓', `${data.config.maxHoldMinutes} 分钟`], ['买入冷却', `${data.config.cooldownSeconds} 秒（任何成交后）`], ['买入次数上限', `${data.config.maxBuysPerHour} 次 / 滚动小时（不限制卖出）`]);
  for (const [name, value] of settingRows) label(settings, name, value);
  const indicators = data.indicators;
  element('signal-summary').textContent = indicators ? `最新 K 线收盘 ${time(indicators.closeTime)} · SMA ${data.config.fast}：${number(indicators.fast)} / SMA ${data.config.slow}：${number(indicators.slow)}。仅最新收盘交叉有效，不补历史信号。${data.strategyChangedAt ? `模式接管于 ${time(data.strategyChangedAt)}。` : ''}` : '均线数据尚未取得';
  element('risk-note').textContent = rapid ? `均线交叉按新收盘的一分钟 K 线判断；止损、止盈、最长持仓每轮都检查，不等待下一根收盘。每轮间隔 ${data.config.pollSeconds} 秒加请求耗时，不是实时成交保证。断网、关机或休眠时无法执行。退出可能受最小数量限制。` : '止盈止损按新收盘 K 线检查，不是交易所实时保护单。断网、关机或休眠时无法执行。';
  element('refresh-note').textContent = `看板每 5 秒请求更新，账户数据最多缓存 ${rapid ? 5 : 20} 秒。关闭看板不会停止机器人。`;
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
  element('trade-count').textContent = `${data.trades.length} 笔成交`;
  element('empty-trades').hidden = data.trades.length !== 0;
  const orders = element('orders'); orders.replaceChildren();
  for (const order of data.botOrders) {
    const row = document.createElement('tr'); cell(row, String(order.orderId)); cell(row, order.side === 'BUY' ? '买入' : '卖出', order.side === 'BUY' ? 'buy' : 'sell');
    cell(row, ({ FILLED: '全部成交', CANCELED: '已取消', EXPIRED: '已过期', REJECTED: '已拒绝' })[order.status] || order.status);
    cell(row, number(order.executedQty, 8)); cell(row, `${number(order.quoteQty, 8)} USDT`); cell(row, order.reason); orders.append(row);
  }
  element('order-count').textContent = `${data.botOrders.length} 笔订单`;
  element('pending').textContent = data.pending ? '存在待核对委托；程序会先核对，不重复下单。' : '';
  element('open-orders').textContent = `币安未完成委托：${data.openOrders.length} 笔`;
  const legend = document.querySelectorAll('.legend span'); legend[1].textContent = `SMA ${data.config.fast}`; legend[2].textContent = `SMA ${data.config.slow}`;
  chart(data.candles, data.config.fast, data.config.slow);
}
async function refresh() {
  if (busy) return;
  busy = true; element('refresh').disabled = true;
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取测试账户失败。');
    if (data.mode !== 'BINANCE_SPOT_TESTNET') throw new Error('数据源不是测试网，已拒绝显示。');
    render(data); lastUpdated = data.updatedAt; element('error').hidden = true;
  } catch (error) {
    element('error').hidden = false;
    element('error').textContent = `数据刷新失败：${error.message}${lastUpdated ? `。当前显示的是 ${time(lastUpdated)} 的旧数据，请勿当作当前状态。` : ''}`;
    element('activity-label').textContent = '连接失败，交易状态未经确认'; element('dot').className = 'dot error';
  } finally { busy = false; element('refresh').disabled = false; }
}
element('refresh').addEventListener('click', refresh);
void refresh(); setInterval(refresh, 5000);
