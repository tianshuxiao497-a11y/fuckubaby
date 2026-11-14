import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [resolve(root, 'products/spot-live-pilot/live/server.mjs'), '--no-browser'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
const endpoint = await new Promise((resolveEndpoint, reject) => {
  const timeout = setTimeout(() => reject(new Error('LIVE_UI_STARTUP_TIMEOUT')), 15000);
  child.on('exit', code => { clearTimeout(timeout); reject(new Error('LIVE_UI_EARLY_EXIT_' + code)); });
  child.stderr.on('data', () => {});
  child.stdout.on('data', data => {
    output += data.toString();
    const match = output.match(/Local control page: (http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64}))/);
    if (match) { clearTimeout(timeout); resolveEndpoint(new URL(match[1])); }
  });
});
try {
  const page = await fetch(endpoint.origin + '/');
  const html = await page.text();
  if (!page.ok || !html.includes('启动实盘策略') || !html.includes('只读核对账户与信号')) throw new Error('LIVE_UI_INCOMPLETE');
  const status = await fetch(endpoint.origin + '/api/status', { headers: { 'x-asbl-session': endpoint.hash.slice(1) } });
  const value = await status.json();
  if (!status.ok || value.version !== '0.1.0-personal' || value.unlocked || value.running || value.connected || value.snapshot !== null) throw new Error('LIVE_UI_MUST_START_UNCONFIGURED');
  if ((await fetch(endpoint.origin + '/api/status')).status !== 403) throw new Error('LIVE_UI_SESSION_GUARD_FAILED');
  await mkdir(resolve(root, 'exports'), { recursive: true });
  const result = { passed: true, version: value.version, platform: process.platform, arch: process.arch, exchangeRequests: 0, startupUnconfigured: true, defaultRunning: false, sessionGuardPassed: true };
  await writeFile(resolve(root, 'exports/live-personal-native-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await exited;
}
