import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readConfig } from '../lib/testnet-bot.mjs';

async function renderError(payload) {
  const nodes = new Map();
  const node = () => ({ textContent: '', children: [], hidden: false, className: '', append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, addEventListener() {}, setAttribute() {} });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  get('trade-count').textContent = '0 笔'; get('order-count').textContent = '0 笔';
  const legends = [node(), node(), node()]; const calls = [];
  const context = {
    document: { getElementById: get, createElement: node, querySelectorAll: () => legends },
    AbortSignal, Intl, setInterval: () => 1,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: false, json: async () => payload }; }
  };
  runInNewContext(await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, legends };
}

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
  const text = element => element.textContent + element.children.map(text).join(' ');
  assert.match(text(get('settings')), /每分钟约两笔/);
  assert.match(text(get('settings')), /100 虚拟 USDT/);
  assert.match(get('trading-help').textContent, /不代表已成交/);
  assert.match(legends[1].textContent, /仅参考/);
});

test('unverified or wrong-source error payload never claims the strategy is running', async () => {
  const { get } = await renderError({ mode: 'LIVE', config: readConfig({ TESTNET_STRATEGY: 'cycle' }), activity: { status: 'running', label: '运行中' }, error: 'unverified' });
  assert.match(get('activity-label').textContent, /未经确认/);
  assert.equal(get('settings').children.length, 0);
  assert.equal(get('error').hidden, false);
});
