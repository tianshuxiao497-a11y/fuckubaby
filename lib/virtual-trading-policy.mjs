import { readConfig, TESTNET_ORIGIN } from './testnet-bot.mjs';
import { testnetSymbol } from './testnet-symbols.mjs';

const fields = [
  'version', 'mode', 'strategy', 'symbol', 'interval', 'pollSeconds',
  'maxPositionUsdt', 'fastPeriod', 'slowPeriod', 'stopLossPercent',
  'takeProfitPercent', 'maxHoldMinutes', 'cooldownSeconds', 'maxBuysPerHour'
];
const settings = [
  ['pollSeconds', 'TESTNET_POLL_SECONDS', 10, 20, true],
  ['maxPositionUsdt', 'TESTNET_TRADE_USDT', 25, 100, false],
  ['fastPeriod', 'TESTNET_FAST_PERIOD', 3, 10, true],
  ['slowPeriod', 'TESTNET_SLOW_PERIOD', 5, 30, true],
  ['stopLossPercent', 'TESTNET_STOP_LOSS_PERCENT', 0.1, 5, false],
  ['takeProfitPercent', 'TESTNET_TAKE_PROFIT_PERCENT', 0.1, 10, false],
  ['maxHoldMinutes', 'TESTNET_MAX_HOLD_MINUTES', 1, 60, true],
  ['cooldownSeconds', 'TESTNET_COOLDOWN_SECONDS', 30, 3600, true],
  ['maxBuysPerHour', 'TESTNET_MAX_BUYS_PER_HOUR', 1, 60, true]
];
const actions = new Map([
  ['describe', []], ['preview', ['--once']],
  ['run', ['--watch', '--enable-testnet-orders']],
  ['status', ['--status']], ['stop', ['--stop']], ['adopt', ['--adopt-strategy']]
]);

// This is a data-only policy, not an executable prompt, URL or code plug-in.
// The existing client still constructs every URL with TESTNET_ORIGIN.
export function policyEnvironment(policy, inherited = {}) {
  const expectedFields = policy?.version === 3 ? [...fields, 'adaptiveProfile'] : fields;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(policy)) ||
      Object.keys(policy).length !== expectedFields.length ||
      expectedFields.some(field => !Object.hasOwn(policy, field)) ||
      Object.keys(policy).some(field => !expectedFields.includes(field))) {
    throw new Error('Strategy file must contain exactly the documented fields; credentials, hosts and code are not accepted.');
  }
  const supported = policy.version === 1 && policy.strategy === 'tactical' || policy.version === 2 && policy.strategy === 'adaptive' ||
    policy.version === 3 && policy.strategy === 'adaptive' && policy.adaptiveProfile === 'short';
  testnetSymbol(policy.symbol);
  if (!supported || policy.mode !== 'BINANCE_SPOT_TESTNET_ONLY' || policy.interval !== '1m') {
    throw new Error('Only reviewed USDT Spot Testnet tactical/adaptive policies are supported.');
  }
  const overrides = {
    TESTNET_STRATEGY: policy.strategy, TESTNET_SYMBOL: policy.symbol, TESTNET_INTERVAL: '1m'
  };
  // Explicitly remove inherited short settings when selecting a legacy policy.
  overrides.TESTNET_ADAPTIVE_PROFILE = policy.version === 3 ? 'short' : 'standard';
  for (const [field, variable, legacyMin, legacyMax, integer] of settings) {
    const min = policy.version >= 2 && ['pollSeconds', 'cooldownSeconds'].includes(field) ? 5 : legacyMin;
    const max = policy.version >= 2 && field === 'pollSeconds' ? 10 : policy.version === 3 && field === 'maxHoldMinutes' ? 3 : legacyMax;
    const value = policy[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
        (integer && !Number.isInteger(value))) {
      throw new Error(`${field} must be a finite ${integer ? 'integer' : 'number'} between ${min} and ${max}.`);
    }
    overrides[variable] = String(value);
  }
  if (policy.fastPeriod >= policy.slowPeriod) throw new Error('fastPeriod must be smaller than slowPeriod.');
  // Preserve the underlying guard against production credentials/settings.
  // Never include inherited values (which may contain secrets) in the result.
  readConfig({ ...inherited, ...overrides });
  return overrides;
}

export function parseVirtualArgs(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || new Set(args).size !== args.length) {
    throw new Error('Arguments must be unique documented flags.');
  }
  const selected = args.filter(arg => [...actions.keys()].some(action => arg === `--${action}`));
  if (args.some(arg => arg !== '--enable-testnet-orders' && !selected.includes(arg)) || selected.length > 1) {
    throw new Error('Choose one action: --describe, --preview, --run, --status, --adopt or --stop.');
  }
  const action = selected.length ? selected[0].slice(2) : 'describe';
  const enable = args.includes('--enable-testnet-orders');
  if ((action === 'run') !== enable) {
    throw new Error('Only --run --enable-testnet-orders can enable virtual orders; the order flag is forbidden for other actions.');
  }
  return action;
}

export function buildVirtualLaunch(policy, action = 'describe', inherited = {}) {
  if (!actions.has(action)) throw new Error('Unsupported virtual trading action.');
  const overrides = policyEnvironment(policy, inherited);
  return {
    action, origin: TESTNET_ORIGIN,
    config: readConfig(overrides), overrides, args: [...actions.get(action)]
  };
}
