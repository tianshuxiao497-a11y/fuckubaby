import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, initialState } from '../lib/testnet-bot.mjs';
import { validateMonitorState, monitorActivity, monitorSnapshot } from '../lib/testnet-monitor.mjs';

const config = readConfig({ TESTNET_FAST_PERIOD: '3', TESTNET_SLOW_PERIOD: '5' });
test('monitor rejects a different account, production mode or different symbol', () => {
  const state = initialState(config, 'unit-key');
  assert.deepEqual(validateMonitorState(null, config, 'unit-key'), state);
  for (const patch of [{ accountTag: 'other' }, { mode: 'LIVE' }, { symbol: 'ETHUSDT' }, { orders: null }]) {
    assert.throws(() => validateMonitorState({ ...state, ...patch }, config, 'unit-key'));
  }
});
test('monitor distinguishes a live heartbeat, stopped process, stale data and missing status', () => {
  const now = Date.now(); const heartbeat = { accountTag: 'tag', status: 'running', updatedAt: now, result: { action: 'waiting' } };
  assert.equal(monitorActivity(heartbeat, config, 'tag', now, true).status, 'running');
  assert.equal(monitorActivity(heartbeat, config, 'tag', now, false).status, 'stale');
  assert.equal(monitorActivity(heartbeat, config, 'tag', now + 200000, true).status, 'stale');
  assert.equal(monitorActivity({ ...heartbeat, status: 'stopped' }, config, 'tag', now, true).status, 'stopped');
  assert.equal(monitorActivity(null, config, 'tag').status, 'unknown');
});
test('snapshot has real account fills and only bot-owned position, no credentials or mutating calls', async () => {
  const state = initialState(config, 'unit-key');
  state.position = { quantity: 0.0012, entryPrice: 83000, openedAt: 1 };
  state.orders = [{ orderId: 123, side: 'BUY', status: 'FILLED', executedQty: 0.0012, quoteQty: 99.6, time: 1, reason: 'manual', clientOrderId: 'private-internal-id' }];
  const now = 1800000000000; const paths = [];
  const client = {
    syncTime: async () => now,
    request: async (method, path) => {
      assert.equal(method, 'GET'); paths.push(path);
      if (path.endsWith('/klines')) return Array.from({ length: 6 }, (_, i) => [now - (6 - i) * config.intervalMs, '1', '1', '1', '83010', '1', now - (5 - i) * config.intervalMs - 1]);
      if (path.endsWith('/account')) return { apiKey: 'must-not-leak', balances: [{ asset: 'BTC', free: '1.0012', locked: '0' }, { asset: 'USDT', free: '9900.4', locked: '0' }] };
      if (path.endsWith('/price')) return { price: '83010' };
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/myTrades')) return [
        { id: 1, orderId: 123, isBuyer: true, qty: '0.0012', price: '83000', quoteQty: '99.6', commission: '0', commissionAsset: 'BTC', time: 1 },
        { id: 2, orderId: 456, isBuyer: false, qty: '0.01', price: '83000', quoteQty: '830', commission: '0', commissionAsset: 'BTC', time: 2 }
      ];
      throw new Error('unexpected');
    }
  };
  const data = await monitorSnapshot(client, config, state, { status: 'running' });
  assert.equal(data.position.quantity, 0.0012);
  assert.equal(data.balances[0].free, 1.0012);
  assert.equal(data.trades.find(t => t.orderId === 123).botOwned, true);
  assert.equal(data.trades.find(t => t.orderId === 456).botOwned, false);
  assert.equal(data.botOrders[0].status, 'FILLED');
  assert.equal(JSON.stringify(data).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(data).includes('private-internal-id'), false);
  assert.equal(paths.length, 5);
});
