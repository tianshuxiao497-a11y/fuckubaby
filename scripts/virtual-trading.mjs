import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const policyUrl = new URL('../strategies/virtual-only.json', import.meta.url);

async function main() {
  const args = process.argv.slice(2);
  // Emergency graceful-stop requests must not depend on strategy modules
  // being importable during an upgrade. This path loads no keys or API client.
  if (args.length === 1 && args[0] === '--stop') {
    await mkdir(resolve(root, '.paper-data'), { recursive: true });
    await writeFile(resolve(root, '.paper-data/testnet-stop'), 'stop requested');
    console.log('已请求 Testnet 程序安全停止；不平仓，不取消交易所委托。');
    return;
  }
  if (args.length === 1 && args[0] === '--help') {
    console.log('Virtual funds only: Binance Spot Testnet, BTCUSDT, no production/futures adapter.');
    console.log('Default / --describe: validate and describe the policy offline; no credentials, network or orders.');
    console.log('--preview: one read-only Testnet signal preview; does not persist a trade or create orders.');
    console.log('--run --enable-testnet-orders: run the existing Testnet bot with this policy.');
    console.log('--status: read the Testnet account. --stop: request a graceful Testnet stop, without liquidation.');
    console.log('--adopt: migrate stopped local records to the policy, keeping owned inventory exit-only; no orders.');
    return;
  }
  const { buildVirtualLaunch, parseVirtualArgs } = await import('../lib/virtual-trading-policy.mjs');
  const action = parseVirtualArgs(args);
  // A stop request must work even if an edited policy or credential file is
  // broken. The existing runner's --stop path does not load keys or trade.
  const policy = JSON.parse(await readFile(policyUrl, 'utf8'));
  const plan = buildVirtualLaunch(policy, action, process.env);
  if (action === 'describe') {
    console.log(JSON.stringify({
      mode: policy.mode, action, origin: plan.origin, ordersEnabled: false,
      policyFile: fileURLToPath(policyUrl), config: plan.config,
      note: 'Offline description only. No account was read and no bot was started.'
    }, null, 2));
    return;
  }

  console.log(`Virtual funds only: ${plan.origin}; action=${action}. No production/futures trading.`);
  if (action !== 'stop') {
    try { process.loadEnvFile(resolve(root, '.env.testnet')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Apply the validated, non-secret policy after loading the local file so
    // an older TESTNET_* setting cannot silently override this policy.
    Object.assign(process.env, plan.overrides);
  }
  // Reuse the runner in this very process. Its existing signal handlers,
  // pending-order safeguards and finally-block own cleanup; no orphaned child
  // bot can remain if this launcher exits. The module target is never editable
  // through the JSON or command line. The runner rechecks production settings
  // loaded from .env.testnet before any market/account request.
  process.chdir(root);
  process.argv = [process.execPath, fileURLToPath(new URL('./testnet.mjs', import.meta.url)), ...plan.args];
  await import('./testnet.mjs');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
