import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { policyEnvironment, parseVirtualArgs, buildVirtualLaunch } from '../lib/virtual-trading-policy.mjs';
import { TESTNET_ORIGIN, TestnetClient } from '../lib/testnet-bot.mjs';

// Only the public policy source and synthetic environments are used here.
// CLI checks are limited to offline describe/help and invalid describe flags.
// Positive dispatch tests copy only the wrapper and pure modules to a fresh
// temporary fixture. Its runner is a no-network stub, never the real runner.
// No test starts preview, status, stop, or trading against a real account.
const policy = () => ({
  version: 1, mode: 'BINANCE_SPOT_TESTNET_ONLY', strategy: 'tactical', symbol: 'BTCUSDT', interval: '1m',
  pollSeconds: 10, maxPositionUsdt: 100, fastPeriod: 3, slowPeriod: 7,
  stopLossPercent: 0.2, takeProfitPercent: 0.3, maxHoldMinutes: 3, cooldownSeconds: 30, maxBuysPerHour: 60
});
const expectedOverrides = {
  TESTNET_STRATEGY: 'tactical', TESTNET_SYMBOL: 'BTCUSDT', TESTNET_INTERVAL: '1m',
  TESTNET_ADAPTIVE_PROFILE: 'standard',
  TESTNET_POLL_SECONDS: '10', TESTNET_TRADE_USDT: '100', TESTNET_FAST_PERIOD: '3', TESTNET_SLOW_PERIOD: '7',
  TESTNET_STOP_LOSS_PERCENT: '0.2', TESTNET_TAKE_PROFIT_PERCENT: '0.3', TESTNET_MAX_HOLD_MINUTES: '3',
  TESTNET_COOLDOWN_SECONDS: '30', TESTNET_MAX_BUYS_PER_HOUR: '60'
};

test('the checked-in policy is explicit v3 adaptive short, while v1/v2 remain compatible', async () => {
  const saved = JSON.parse(await readFile(new URL('../strategies/virtual-only.json', import.meta.url), 'utf8'));
  assert.equal(saved.version, 3); assert.equal(saved.strategy, 'adaptive'); assert.equal(saved.adaptiveProfile, 'short');
  const plan = buildVirtualLaunch(saved);
  assert.equal(plan.config.pollSeconds, 5); assert.equal(plan.config.slow, 8);
  assert.equal(plan.config.maxHoldMinutes, 3); assert.equal(plan.config.stopLoss, 0.15); assert.equal(plan.config.takeProfit, 0.15);
  assert.equal(plan.config.adaptiveProfile, 'short'); assert.equal(plan.config.softHoldMinutes, 1);
  assert.deepEqual(plan.config.batchFractions, [0.4, 0.3, 0.3]);
  assert.deepEqual(policyEnvironment(policy()), expectedOverrides);
  for (const patch of [{ pollSeconds: 4 }, { pollSeconds: 11 }, { version: 1 }, { strategy: 'tactical' }, { adaptiveProfile: 'standard' }, { maxHoldMinutes: 4 }]) {
    assert.throws(() => policyEnvironment({ ...saved, ...patch }));
  }
  const legacyAdaptive = { ...saved, version: 2 }; delete legacyAdaptive.adaptiveProfile;
  assert.equal(buildVirtualLaunch(legacyAdaptive, 'describe', { TESTNET_ADAPTIVE_PROFILE: 'short' }).config.adaptiveProfile, 'standard');
  const missingProfile = { ...saved }; delete missingProfile.adaptiveProfile;
  assert.throws(() => policyEnvironment(missingProfile));
});

test('policy fields map precisely to Testnet settings and never return inherited secrets or a full environment', () => {
  const input = Object.freeze(policy());
  const inherited = Object.freeze({
    BINANCE_TESTNET_API_KEY: 'synthetic-unit-testnet-key', BINANCE_TESTNET_API_SECRET: 'synthetic-unit-testnet-secret',
    BINANCE_TESTNET_PRIVATE_KEY_PATH: 'synthetic-not-a-real-file.pem',
    TESTNET_STRATEGY: 'cycle', TESTNET_TRADE_USDT: '9999', TESTNET_POLL_SECONDS: '1',
    PATH: 'synthetic-path', UNRELATED_TOKEN: 'synthetic-unrelated-token'
  });
  const inputBefore = structuredClone(input); const inheritedBefore = structuredClone(inherited);
  const overrides = policyEnvironment(input, inherited);
  assert.deepEqual(overrides, expectedOverrides); assert.ok(Object.keys(overrides).every(key => key.startsWith('TESTNET_')));
  const launch = buildVirtualLaunch(input, 'describe', inherited);
  assert.deepEqual(Object.keys(launch).sort(), ['action', 'args', 'config', 'origin', 'overrides']);
  assert.equal(launch.origin, TESTNET_ORIGIN);
  assert.equal(launch.action, 'describe'); assert.deepEqual(launch.args, []); assert.deepEqual(launch.overrides, expectedOverrides);
  assert.equal(launch.config.strategy, 'tactical'); assert.equal(launch.config.symbol, 'BTCUSDT');
  assert.equal(launch.config.interval, '1m'); assert.equal(launch.config.pollSeconds, 10); assert.equal(launch.config.tradeUsdt, 100);
  assert.equal(launch.config.fast, 3); assert.equal(launch.config.slow, 7);
  assert.equal(launch.config.stopLoss, 0.2); assert.equal(launch.config.takeProfit, 0.3);
  assert.equal(launch.config.maxHoldMinutes, 3); assert.equal(launch.config.cooldownSeconds, 30); assert.equal(launch.config.maxBuysPerHour, 60);
  assert.deepEqual(launch.config.batchFractions, [0.25, 0.25, 0.5]); assert.equal(launch.config.minOrderSeconds, 10);
  assert.doesNotMatch(JSON.stringify(launch), /synthetic-|PRIVATE_KEY|API_KEY|API_SECRET|UNRELATED_TOKEN/);
  assert.deepEqual(input, inputBefore); assert.deepEqual(inherited, inheritedBefore);
});

test('virtual policy rejects missing or extra flat keys, credentials, custom hosts and executable content', () => {
  for (const key of Object.keys(policy())) {
    const incomplete = policy(); delete incomplete[key]; assert.throws(() => policyEnvironment(incomplete), key);
  }
  for (const key of ['host', 'origin', 'baseUrl', 'apiKey', 'apiSecret', 'privateKey', 'code', 'execute', 'orderType', '__proto__', 'constructor']) {
    const extended = JSON.parse(JSON.stringify(policy()));
    Object.defineProperty(extended, key, { enumerable: true, value: 'synthetic-forbidden' });
    assert.throws(() => policyEnvironment(extended), key);
  }
  for (const malformed of [null, [], true, 1, 'policy', { ...policy(), risk: { leverage: 1 } }]) {
    assert.throws(() => policyEnvironment(malformed));
  }
});

test('virtual-only identity fields cannot select production, another strategy, symbol or interval', () => {
  for (const patch of [{ version: 2 }, { version: '1' }, { mode: 'LIVE' }, { mode: 'LIVE_MARKET_READ_ONLY' },
    { strategy: 'cycle' }, { strategy: 'classic' }, { symbol: 'ETHBTC' }, { symbol: 'BTCUSDT; anything' }, { interval: '5m' }]) {
    assert.throws(() => policyEnvironment({ ...policy(), ...patch }));
  }
});

test('policy numeric fields require actual finite numbers, never coercible strings, booleans, null or nested values', () => {
  const numericKeys = ['pollSeconds', 'maxPositionUsdt', 'fastPeriod', 'slowPeriod', 'stopLossPercent',
    'takeProfitPercent', 'maxHoldMinutes', 'cooldownSeconds', 'maxBuysPerHour'];
  for (const key of numericKeys) for (const invalid of [String(policy()[key]), true, false, null, undefined, NaN, Infinity, -Infinity, [], {}]) {
    assert.throws(() => policyEnvironment({ ...policy(), [key]: invalid }), `${key}: ${String(invalid)}`);
  }
});

test('policy ranges and integer-only periods are bounded and fast must remain less than slow', () => {
  const invalid = {
    pollSeconds: [9, 21, 30, 10.5], maxPositionUsdt: [24.99, 100.01], fastPeriod: [2, 11, 3.5], slowPeriod: [4, 31, 7.5],
    stopLossPercent: [0.09, 5.01], takeProfitPercent: [0.09, 10.01], maxHoldMinutes: [0, 61, 3.5],
    cooldownSeconds: [29, 3601, 30.5], maxBuysPerHour: [0, 61, 5.5]
  };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    assert.throws(() => policyEnvironment({ ...policy(), [key]: value }), `${key}: ${value}`);
  }
  assert.throws(() => policyEnvironment({ ...policy(), fastPeriod: 7, slowPeriod: 7 }));
  assert.throws(() => policyEnvironment({ ...policy(), fastPeriod: 10, slowPeriod: 5 }));
  const lower = { ...policy(), pollSeconds: 10, maxPositionUsdt: 25, fastPeriod: 3, slowPeriod: 5,
    stopLossPercent: 0.1, takeProfitPercent: 0.1, maxHoldMinutes: 1, cooldownSeconds: 30, maxBuysPerHour: 1 };
  const upper = { ...policy(), pollSeconds: 20, maxPositionUsdt: 100, fastPeriod: 10, slowPeriod: 30,
    stopLossPercent: 5, takeProfitPercent: 10, maxHoldMinutes: 60, cooldownSeconds: 3600, maxBuysPerHour: 60 };
  assert.equal(buildVirtualLaunch(lower).config.tradeUsdt, 25); assert.equal(buildVirtualLaunch(upper).config.pollSeconds, 20);
  assert.equal(buildVirtualLaunch({ ...policy(), maxPositionUsdt: 25.5 }).config.tradeUsdt, 25.5);
});

test('inherited production credentials or endpoint configuration are refused by both policy helpers', () => {
  for (const inherited of [{ BINANCE_API_KEY: 'synthetic-production-key' }, { BINANCE_API_SECRET: 'synthetic-production-secret' },
    { BINANCE_BASE_URL: 'https://production.invalid' }]) {
    assert.throws(() => policyEnvironment(policy(), inherited));
    for (const action of ['describe', 'preview', 'run', 'status', 'stop']) {
      assert.throws(() => buildVirtualLaunch(policy(), action, inherited));
    }
  }
});

test('virtual argument parser defaults to describe and requires explicit virtual order authorization for run', () => {
  assert.equal(parseVirtualArgs([]), 'describe');
  for (const action of ['describe', 'preview', 'status', 'stop', 'adopt']) assert.equal(parseVirtualArgs([`--${action}`]), action);
  assert.equal(parseVirtualArgs(['--run', '--enable-testnet-orders']), 'run');
  assert.equal(parseVirtualArgs(['--enable-testnet-orders', '--run']), 'run');
  assert.throws(() => parseVirtualArgs(['--run']));
  assert.throws(() => parseVirtualArgs(['--enable-testnet-orders']));
});

test('virtual parser refuses duplicate, mixed, unsupported and misplaced authorization flags', () => {
  const invalid = [
    ['--describe', '--describe'], ['--preview', '--status'], ['--run', '--run', '--enable-testnet-orders'],
    ['--run', '--enable-testnet-orders', '--enable-testnet-orders'], ['--run', '--enable-testnet-orders', '--unknown'],
    ['--unknown'], ['--watch'], ['--once'], ['--buy-test'], ['--adopt-strategy'], ['--live'], ['--help'],
    ['--describe', '--enable-testnet-orders'], ['--preview', '--enable-testnet-orders'],
    ['--status', '--enable-testnet-orders'], ['--stop', '--enable-testnet-orders'], ['--run=true'], ['describe']
  ];
  for (const args of invalid) assert.throws(() => parseVirtualArgs(args), args.join(' '));
});

test('launch construction returns only the exact existing Testnet runner action arguments without launching', () => {
  const mappings = {
    describe: [], preview: ['--once'], run: ['--watch', '--enable-testnet-orders'], status: ['--status'], stop: ['--stop'], adopt: ['--adopt-strategy']
  };
  for (const [action, args] of Object.entries(mappings)) {
    const launch = buildVirtualLaunch(policy(), action);
    assert.equal(launch.action, action); assert.deepEqual(launch.args, args);
    assert.equal(launch.config.strategy, 'tactical'); assert.deepEqual(launch.overrides, expectedOverrides);
  }
  assert.equal(buildVirtualLaunch(policy()).action, 'describe');
  for (const action of ['live', '--watch', '', null, {}, 'BUY']) assert.throws(() => buildVirtualLaunch(policy(), action));
});

test('the reused virtual trading client retains its hardcoded Testnet origin', async () => {
  assert.equal(TESTNET_ORIGIN, 'https://testnet.binance.vision');
  const requests = [];
  const client = new TestnetClient({ fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options }); return new Response(JSON.stringify({ serverTime: 1800000000000 }));
  } });
  await client.request('GET', '/api/v3/time');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, `${TESTNET_ORIGIN}/api/v3/time`);
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.redirect, 'error');
});

test('importing the virtual CLI as a module does not dispatch the Testnet runner or modify process state', async () => {
  const cwd = process.cwd(); const argv = [...process.argv];
  const interruptListeners = process.listenerCount('SIGINT'); const terminateListeners = process.listenerCount('SIGTERM');
  await import('../scripts/virtual-trading.mjs');
  assert.equal(process.cwd(), cwd); assert.deepEqual(process.argv, argv);
  assert.equal(process.listenerCount('SIGINT'), interruptListeners); assert.equal(process.listenerCount('SIGTERM'), terminateListeners);
});

test('virtual CLI default/describe/help are offline and disclose no synthetic inherited credentials', () => {
  const script = fileURLToPath(new URL('../scripts/virtual-trading.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const env = { BINANCE_TESTNET_API_KEY: 'synthetic-cli-unit-key', BINANCE_TESTNET_API_SECRET: 'synthetic-cli-unit-secret' };
  for (const args of [[], ['--describe'], ['--help']]) {
    const child = spawnSync(process.execPath, [script, ...args], { cwd, env, shell: false, encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /virtual|testnet|policy/i);
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-cli-unit-(key|secret)/);
  }
  // Even if an invalid describe flag were mistakenly ignored, the selected
  // action is still describe. Never spawn a valid or ambiguous trading action.
  for (const args of [['--unknown'], ['--describe', '--describe'], ['--describe', '--enable-testnet-orders']]) {
    const child = spawnSync(process.execPath, [script, ...args], { cwd, env, shell: false, encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error); assert.notEqual(child.status, 0); assert.ok(child.stderr.trim().length > 0);
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-cli-unit-(key|secret)/);
  }
});

async function virtualFixture(t, { policyText = JSON.stringify(policy()), envText = '', envDirectory = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'virtual-policy-test-'));
  t.after(async () => {
    // Recursively remove only the exact fresh fixture created by mkdtemp.
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('virtual-policy-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  for (const folder of ['scripts', 'lib', 'strategies']) await mkdir(join(directory, folder));
  for (const relative of ['scripts/virtual-trading.mjs', 'lib/virtual-trading-policy.mjs', 'lib/testnet-bot.mjs', 'lib/adaptive-strategy.mjs', 'lib/testnet-commission.mjs', 'lib/testnet-symbols.mjs']) {
    await copyFile(new URL(`../${relative}`, import.meta.url), join(directory, relative));
  }
  await writeFile(join(directory, 'strategies', 'virtual-only.json'), policyText);
  if (envDirectory) await mkdir(join(directory, '.env.testnet'));
  else await writeFile(join(directory, '.env.testnet'), envText);
  // Explicitly write a stub instead of copying the real scripts/testnet.mjs.
  // It defines no client, fetch, socket, file write, order, or watch loop.
  await writeFile(join(directory, 'scripts', 'testnet.mjs'), [
    "import { readConfig } from '../lib/testnet-bot.mjs';",
    'const config = readConfig();',
    'console.log(JSON.stringify({ fixtureStub: true, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), config,',
    "  keyLoaded: process.env.BINANCE_TESTNET_API_KEY === 'synthetic-fixture-key',",
    "  secretLoaded: process.env.BINANCE_TESTNET_API_SECRET === 'synthetic-fixture-secret' }));"
  ].join('\n'));
  return directory;
}

const runFixture = (directory, args) => spawnSync(process.execPath, [join(directory, 'scripts', 'virtual-trading.mjs'), ...args], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), env: {}, shell: false, encoding: 'utf8', timeout: 10000
});
const stubResult = child => {
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split(/\r?\n/).find(value => value.startsWith('{"fixtureStub":true'));
  assert.ok(line, child.stdout); const result = JSON.parse(line);
  assert.equal(result.pid, child.pid, 'the wrapper must dispatch in the same process, not an orphanable child');
  assert.doesNotMatch(child.stdout + child.stderr, /synthetic-fixture-(key|secret)/);
  return result;
};

test('isolated stub dispatch loads synthetic credentials while validated policy settings override older file settings', async t => {
  const directory = await virtualFixture(t, { envText: [
    'BINANCE_TESTNET_API_KEY=synthetic-fixture-key', 'BINANCE_TESTNET_API_SECRET=synthetic-fixture-secret',
    'TESTNET_STRATEGY=cycle', 'TESTNET_TRADE_USDT=9999', 'TESTNET_POLL_SECONDS=29', 'TESTNET_FAST_PERIOD=30'
  ].join('\n') });
  const cases = [
    [['--preview'], ['--once']], [['--run', '--enable-testnet-orders'], ['--watch', '--enable-testnet-orders']],
    [['--status'], ['--status']]
  ];
  for (const [args, expectedArgs] of cases) {
    const result = stubResult(runFixture(directory, args));
    assert.deepEqual(result.argv, expectedArgs); assert.equal(resolve(result.cwd), resolve(directory));
    assert.equal(result.keyLoaded, true); assert.equal(result.secretLoaded, true);
    assert.equal(result.config.strategy, 'tactical'); assert.equal(result.config.tradeUsdt, 100);
    assert.equal(result.config.pollSeconds, 10); assert.equal(result.config.fast, 3);
  }
});

test('isolated stop dispatch works despite malformed policy and an unreadable env-file path without loading either', async t => {
  const directory = await virtualFixture(t, { policyText: '{ deliberately malformed policy', envDirectory: true });
  // Simulate an incomplete upgrade: graceful stop must not import the engine.
  await rm(join(directory, 'lib', 'adaptive-strategy.mjs'));
  const child = runFixture(directory, ['--stop']);
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /fixtureStub/);
  assert.equal(await readFile(join(directory, '.paper-data', 'testnet-stop'), 'utf8'), 'stop requested');
});

test('isolated dispatch refuses production configuration loaded from the synthetic credential file', async t => {
  const directory = await virtualFixture(t, { envText: [
    'BINANCE_BASE_URL=https://production.invalid', 'BINANCE_TESTNET_API_KEY=synthetic-fixture-key',
    'BINANCE_TESTNET_API_SECRET=synthetic-fixture-secret'
  ].join('\n') });
  const child = runFixture(directory, ['--preview']);
  assert.ifError(child.error); assert.notEqual(child.status, 0); assert.match(child.stderr, /BINANCE_BASE_URL|Testnet/i);
  assert.doesNotMatch(child.stdout, /"fixtureStub":true/);
  assert.doesNotMatch(child.stdout + child.stderr, /synthetic-fixture-(key|secret)/);
});

test('isolated default description and help never load even an unreadable synthetic credential-file path', async t => {
  const directory = await virtualFixture(t, { envDirectory: true });
  for (const args of [[], ['--describe'], ['--help']]) {
    const child = runFixture(directory, args);
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /virtual|testnet|policy/i); assert.doesNotMatch(child.stdout, /"fixtureStub":true/);
  }
});
