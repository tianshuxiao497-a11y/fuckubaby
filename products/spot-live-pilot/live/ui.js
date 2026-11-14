const element = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('asbl-local-session') || '';
if (token) sessionStorage.setItem('asbl-local-session', token);
history.replaceState(null, '', '/');
let latest = null;
const notice = message => { element('notice').textContent = message; };
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-asbl-session': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'REQUEST_FAILED');
  return result;
}
function render(value) {
  latest = value;
  const snapshot = value.snapshot;
  element('running').textContent = value.running ? '实盘策略运行中' : value.unlocked ? '已解锁 · 策略已停止' : '待配置';
  element('equity').textContent = snapshot ? Number(snapshot.equity).toFixed(4) : '—';
  element('pnl').textContent = snapshot ? (Number(snapshot.equity) - Number(snapshot.day.equity)).toFixed(4) : '—';
  element('loss').textContent = snapshot ? snapshot.lossPercent.toFixed(2) + '%' : '—';
  element('count').textContent = String(snapshot?.realOrderCount ?? 0);
  element('signal').textContent = snapshot?.signal.reason ?? '等待账户核对';
  element('blocker').textContent = value.error ?? snapshot?.blocker ?? (snapshot ? '最低订单额 ' + snapshot.minOrderUsdt + ' USDT' : '');
  element('strategy').textContent = value.settings?.externalStrategy?.name ?? '内置自适应 EMA / RSI / ATR';
  element('save').disabled = value.running;
  element('unlock').disabled = value.running;
  const body = element('orders');
  body.replaceChildren();
  const orders = snapshot?.orders ?? [];
  if (!orders.length) {
    const row = body.insertRow();
    const cell = row.insertCell(); cell.colSpan = 6; cell.textContent = '尚无本程序核验的真实委托';
  }
  for (const order of [...orders].reverse()) {
    const row = body.insertRow();
    for (const text of [new Date(order.time).toLocaleString(), order.symbol, order.side, order.quantity, order.quote, order.status]) row.insertCell().textContent = text;
  }
}
async function action(name, body = {}) {
  try {
    const result = await api(name, body);
    if (result.environment) render(result);
    notice('操作完成。' + (result.running ? '真实现货策略已启用。' : '可以查看账户与信号状态。'));
    return result;
  } catch (error) { notice(error.message); throw error; }
}
function on(id, handler) { element(id).addEventListener('click', () => Promise.resolve().then(handler).catch(() => {})); }
on('save', async () => {
  await action('save', {
    password: element('password').value, passwordRepeat: element('password-repeat').value,
    credentials: { apiKey: element('key').value.trim(), apiSecret: element('secret').value.trim(), privateKeyPem: element('pem').value.trim() },
    settings: { symbol: element('symbol').value.trim().toUpperCase(), sizing: 'percent', buyPercent: Number(element('percent').value), dailyLossPercent: 20, riskBasis: 'bot-ledger', externalStrategy: latest?.settings?.externalStrategy ?? null },
  });
  for (const id of ['key', 'secret', 'pem', 'password-repeat']) element(id).value = '';
});
on('unlock', async () => {
  const value = await action('unlock', { password: element('password').value });
  element('symbol').value = value.settings.symbol;
  element('percent').value = String(value.settings.buyPercent);
});
on('check', () => action('check'));
on('reconcile', () => action('reconcile', { cancelOpen: true }));
on('start', async () => {
  const value = await action('start', { confirmation: element('confirmation').value });
  element('confirmation').value = '';
  render(value);
});
on('stop', () => action('stop'));
on('generate', async () => {
  const value = await action('generate-key');
  element('pem').value = value.privateKeyPem;
  element('secret').value = '';
  element('public-key').hidden = false;
  element('public-key').textContent = value.publicKey;
  notice('将上面的公钥注册到币安正式现货 API，API Key 填回第一栏，然后保存本机配置。');
});
element('pem-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || file.size > 8192) return notice('请选择 8 KB 以内的 Ed25519 PEM 文件。');
  element('pem').value = await file.text(); element('secret').value = '';
});
element('strategy-file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file || file.size > 8192) throw new Error('策略最大 8 KB。');
    const value = await action('strategy', { text: await file.text(), password: element('password').value });
    element('percent').value = String(value.settings.buyPercent);
  } catch (error) { notice(error.message); }
});
on('reset-strategy', () => action('strategy', { text: '', password: element('password').value }));
on('catalog', async () => {
  const result = await action('catalog');
  element('symbols').replaceChildren(...result.symbols.map(symbol => { const option = document.createElement('option'); option.value = symbol; return option; }));
  notice('已载入 ' + result.symbols.length + ' 个当前正式 USDT 现货币对。');
});
on('review', async () => {
  await action('review');
  const response = await fetch('/api/review', { headers: { 'x-asbl-session': token } });
  if (!response.ok) throw new Error('REVIEW_EXPORT_FAILED');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = 'AdaptiveSpotBot-Live-Review.md'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function refresh() {
  try { render(await api('status')); }
  catch (error) { notice(error.message === 'LOCAL_SESSION_REQUIRED' ? '请从启动窗口重新打开完整控制页地址。' : '本机程序连接中断，请检查启动窗口。'); }
}
refresh();
setInterval(refresh, 3000);
