import * as defaultFs from 'node:fs/promises';

// Cleanup must never mask the runner's original failure or prevent an owned
// lock from being closed merely because the best-effort heartbeat failed.
// Operational errors are returned to the caller for secondary diagnostics.
export async function finishTestnetRunner({ lock, lockPath, pid, status, result, publishActivity }, { fs = defaultFs } = {}) {
  const errors = [];
  try { await publishActivity(status, result); } catch (error) { errors.push(error); }
  if (!lock) return errors;

  try { await lock.close(); } catch (error) {
    errors.push(error);
    // A failed close may leave the handle active. Preserve its lock instead
    // of allowing a second runner to start while that ownership is uncertain.
    return errors;
  }

  let owner;
  try { owner = (await fs.readFile(lockPath, 'utf8')).trim(); } catch (error) {
    if (error.code !== 'ENOENT') errors.push(error);
    return errors;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || owner !== String(pid)) {
    errors.push(Object.assign(new Error('Testnet lock ownership changed during cleanup; lock retained.'), {
      code: 'TESTNET_LOCK_OWNERSHIP'
    }));
    return errors;
  }
  try { await fs.unlink(lockPath); } catch (error) {
    if (error.code !== 'ENOENT') errors.push(error);
  }
  return errors;
}
