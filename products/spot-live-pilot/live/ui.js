const element = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('asbl-local-session') || '';
if (token) sessionStorage.setItem('asbl-local-session', token);
history.replaceState(null, '', '/');
let latest = null, inFlight = 0, candidatePem = '', settingsDirty = false;
const notice = message => { element('notice').textContent = message; };
const titles = {workspace:'交易总览 / Workspace',setup:'账户配置 / Connection',license:'版本与授权 / Edition',logs:'运行日志 / Activity',help:'使用说明 / Help'};
function showTab(tab) {
  if (!Object.hasOwn(titles, tab)) return;
  document.querySelectorAll('[data-view]').forEach(view => { view.hidden = view.dataset.view !== tab; });
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  element('page-title').textContent = titles[tab];
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => showTab(button.dataset.tab)));
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => showTab(button.dataset.open)));
const messages = {
  VAULT_PASSWORD_OR_DATA_INVALID:'保险箱密码不正确，或文件校验失败；原文件保留。',
  VAULT_PASSWORD_AT_LEAST_12_CHARACTERS:'保险箱密码需要 12–256 个字符。',
  MATCHING_VAULT_PASSWORDS_REQUIRED:'首次保存时，两次输入的密码需一致且至少 12 个字符。',
  UNLOCK_TO_REUSE_EXISTING_KEYS:'检测到已有保险箱，请先解锁，再找回原公钥。',
  STOP_AND_RECONCILE_BEFORE_CONFIGURATION:'请先停止，并核对待处理订单后修改配置。',
  STRATEGY_CHANGE_REQUIRES_FLAT_STOPPED_ACCOUNT:'请先停止，处理本程序持仓和待核对订单后更换策略。',
  FRESH_READ_ONLY_CHECK_REQUIRED:'需要先成功核对账户与最新信号，再启动。',
  REAL_TRADING_CONFIRMATION_REQUIRED:'请本人输入完整的 START REAL SPOT TRADING，确认真实资金交易。',
  SAVE_OR_UNLOCK_PRODUCTION_CONFIGURATION:'请先保存或解锁本机账户配置。',
  MAINNET_ACCOUNT_CHANGED:'当前正式账户与原资金账本不一致，请保留记录并核对账户。',
  ANOTHER_ACTION_IN_PROGRESS:'上一项操作仍在进行，请稍等。',
  LIVE_PROFILE_LOCKED_REVIEW_EXISTING_PROCESS:'此配置已有运行实例，请先关闭旧窗口。',
  CLOSE_OWNED_POSITION_BEFORE_SYMBOL_CHANGE:'请先处理当前程序持仓，再切换交易对。',
  VAULT_PASSWORD_REQUIRED:'请填写原保险箱密码；首次生成密钥时设置至少 12 个字符的密码。',
};
const friendly = code => messages[code] ?? '操作未完成：' + code;
const activityNames = {CONFIGURATION_SAVED:'已保存加密配置',VAULT_UNLOCKED:'已解锁保险箱',VAULT_LOCKED:'已锁定保险箱',
  REGISTRATION_PUBLIC_KEY_CREATED:'已生成注册公钥',ACCOUNT_CHECKED_READ_ONLY:'账户只读核对通过',MANUAL_STOP:'用户停止委托',
  REAL_STRATEGY_STARTED_BY_USER:'用户确认启动实盘',READ_ONLY_RECONNECT_WAIT:'等待只读重连',
  CONNECTION_RESTORED_MANUAL_START_REQUIRED:'连接恢复，等待用户重新启动',EXTERNAL_STRATEGY_IMPORTED:'已导入外置策略',
  BUILT_IN_STRATEGY_RESTORED:'已恢复内置策略',MARKET_AND_SIZING_UPDATED:'已更新币种与仓位',ACTION_FAILED:'操作未完成'};
function controls() {
  const value = latest ?? {}, blocked = inFlight > 0;
  for (const id of ['save','unlock','generate']) element(id).disabled = blocked || value.running;
  for (const id of ['lock','apply-settings','catalog','check','reconcile','review','history','reset-strategy']) element(id).disabled = blocked || !value.unlocked || (['lock','apply-settings','reset-strategy'].includes(id) && value.running);
  element('strategy-file').disabled = blocked || !value.unlocked || value.running;
  element('start').disabled = blocked || !value.connected || value.running || value.pending;
  element('stop').disabled = !value.unlocked;
}
function chart(snapshot) {
  const points = (snapshot?.candles ?? []).filter(row => Number.isSafeInteger(row.time) && Number.isFinite(row.close) && row.close > 0);
  let path = '';
  if (points.length > 1) {
    const values = points.map(point => point.close), low = Math.min(...values), high = Math.max(...values);
    const span = high - low || Math.max(1, high * 0.0001);
    path = points.map((point, index) => (index ? 'L' : 'M') + (15 + index / (points.length - 1) * 770).toFixed(2) + ',' + (225 - (point.close - low) / span * 200).toFixed(2)).join(' ');
  }
  element('chart-line').setAttribute('d', path);
  element('chart-note').textContent = points.length ? '最近 ' + points.length + ' 根已收盘 1 分钟价格 · ' + new Date(snapshot.checkedAt).toLocaleString() : '等待只读核对行情，不生成虚构价格。';
}
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-asbl-session': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'REQUEST_FAILED');
  return result;
}
function render(value) {
  latest = value;
  const snapshot = value.snapshot;
  element('running').textContent = value.running ? '实盘策略运行中' : value.reconnecting ? '只读重连中 · 委托已停止' : value.unlocked ? '已解锁 · 策略已停止' : value.vaultExists ? '已有配置 · 等待解锁' : '待配置';
  element('equity').textContent = snapshot ? Number(snapshot.equity).toFixed(4) : '—';
  element('pnl').textContent = snapshot ? (Number(snapshot.equity) - Number(snapshot.day.equity)).toFixed(4) : '—';
  element('loss').textContent = snapshot ? Math.max(0, snapshot.lossPercent).toFixed(2) + '%' : '—';
  element('count').textContent = String(snapshot?.realOrderCount ?? 0);
  element('signal').textContent = snapshot?.signal.reason ?? '等待账户核对';
  element('blocker').textContent = value.error ?? snapshot?.blocker ?? (snapshot ? '最低订单额 ' + snapshot.minOrderUsdt + ' USDT' : '');
  element('strategy').textContent = value.settings?.externalStrategy?.name ?? '内置自适应 EMA / RSI / ATR';
  element('chart-symbol').textContent = snapshot?.symbol ?? value.settings?.symbol ?? 'BTCUSDT';
  element('connection-state').textContent = value.connected ? '已连接 / Connected' : value.reconnecting ? '重连中 / Reconnecting' : '未连接 / Disconnected';
  element('bid').textContent = snapshot?.book?.bid ?? '—';
  element('ask').textContent = snapshot?.book?.ask ?? '—';
  element('position').textContent = snapshot?.position ? snapshot.position.quantity : '空仓';
  element('last-updated').textContent = snapshot ? '最近核对：' + new Date(snapshot.checkedAt).toLocaleString() : '本机运行 · 尚未核对账户';
  if (value.settings && !settingsDirty) {
    element('symbol').value = value.settings.symbol;
    element('percent').value = String(value.settings.buyPercent);
    element('auto-connect').checked = value.preferences?.autoConnect === true;
  }
  chart(snapshot);
  const activity = element('activity'); activity.replaceChildren();
  for (const entry of [...(value.logs ?? [])].reverse()) {
    const row = activity.insertRow();
    for (const text of [new Date(entry.time).toLocaleString(), activityNames[entry.event] ?? entry.event, entry.code ?? '—']) row.insertCell().textContent = text;
  }
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
  controls();
}
async function action(name, body = {}) {
  if (inFlight && name !== 'stop') throw new Error('ANOTHER_ACTION_IN_PROGRESS');
  inFlight++; controls();
  try {
    const result = await api(name, body);
    if (result.environment) render(result);
    notice('操作完成。' + (result.running ? '真实现货策略已启用。' : '可以查看账户与信号状态。'));
    return result;
  } catch (error) { notice(friendly(error.message)); throw error; }
  finally { inFlight--; controls(); }
}
function on(id, handler) { element(id).addEventListener('click', () => Promise.resolve().then(handler).catch(error => notice(friendly(error.message)))); }
on('save', async () => {
  await action('save', {
    password: element('password').value, passwordRepeat: element('password-repeat').value,
    credentials: { apiKey: element('key').value.trim(), apiSecret: element('secret').value.trim(), privateKeyPem: candidatePem || element('pem').value.trim() },
    settings: { symbol: element('symbol').value.trim().toUpperCase(), sizing: 'percent', buyPercent: Number(element('percent').value), dailyLossPercent: 20, riskBasis: 'bot-ledger', externalStrategy: latest?.settings?.externalStrategy ?? null },
    preferences: {autoConnect: element('auto-connect').checked},
  });
  for (const id of ['key', 'secret', 'pem', 'password-repeat']) element(id).value = '';
  candidatePem = ''; settingsDirty = false;
});
on('unlock', async () => {
  const value = await action('unlock', { password: element('password').value });
  element('symbol').value = value.settings.symbol;
  element('percent').value = String(value.settings.buyPercent);
  element('auto-connect').checked = value.preferences.autoConnect;
  settingsDirty = false;
});
on('lock', async () => { await action('lock'); element('password').value = ''; candidatePem = ''; });
for (const id of ['symbol','percent','auto-connect']) element(id).addEventListener('change', () => { settingsDirty = true; });
on('apply-settings', async () => {
  await action('settings', {password: element('password').value, preferences: {autoConnect: element('auto-connect').checked},
    settings: {symbol: element('symbol').value.trim().toUpperCase(), sizing: 'percent', buyPercent: Number(element('percent').value), dailyLossPercent: 20, riskBasis: 'bot-ledger', externalStrategy: latest?.settings?.externalStrategy ?? null}});
  settingsDirty = false;
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
  const value = await action('generate-key', {password: element('password').value});
  candidatePem = value.privateKeyPem;
  element('pem').value = '';
  element('secret').value = '';
  element('public-key').hidden = false;
  element('public-key').textContent = value.publicKey;
  element('copy-public').hidden = false;
  notice('将上面的公钥注册到币安正式现货 API，API Key 填回第一栏，然后保存本机配置。');
});
on('copy-public', async () => { await navigator.clipboard.writeText(element('public-key').textContent); notice('注册公钥已复制。'); });
element('secret').addEventListener('input', () => { if (element('secret').value) { candidatePem = ''; element('pem').value = ''; } });
element('pem').addEventListener('input', () => { if (element('pem').value) { candidatePem = ''; element('secret').value = ''; } });
element('pem-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || file.size > 8192) return notice('请选择 8 KB 以内的 Ed25519 PEM 文件。');
  candidatePem = await file.text(); element('pem').value = ''; element('secret').value = ''; notice('已读取本机 PEM；保存后加密保管。');
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
on('history', async () => {
  const response = await fetch('/api/history', {headers: {'x-asbl-session': token}});
  if (!response.ok) throw new Error('HISTORY_EXPORT_FAILED');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = 'AdaptiveSpotBot-Live-Orders.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function refresh() {
  try { render(await api('status')); }
  catch (error) { notice(error.message === 'LOCAL_SESSION_REQUIRED' ? '请从启动窗口重新打开完整控制页地址。' : '本机程序连接中断，请检查启动窗口。'); }
}
refresh();
setInterval(refresh, 3000);
