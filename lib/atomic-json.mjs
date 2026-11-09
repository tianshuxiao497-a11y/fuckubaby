import * as filesystem from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 800]);
const RETRYABLE_WINDOWS_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_TEMP_COLLISIONS = 8;

function retryDelays(value) {
  const result = value === undefined ? DEFAULT_RETRY_DELAYS_MS : value;
  if (!Array.isArray(result) || result.length > 8 ||
      Array.from(result).some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 1000) ||
      result.reduce((total, ms) => total + ms, 0) > 5000) {
    throw new TypeError('retryDelaysMs must contain at most eight integer delays, each 0–1000 ms, totalling at most 5000 ms');
  }
  return [...result];
}

function withTemporaryPath(error, temporaryPath) {
  const result = error instanceof Error ? error : new Error('Atomic JSON write failed', { cause: error });
  try {
    Object.defineProperty(result, 'temporaryPath', { value: temporaryPath, enumerable: true, configurable: true });
    return result;
  } catch {
    const wrapped = new Error('Atomic JSON write failed; the temporary file was preserved', { cause: result });
    wrapped.temporaryPath = temporaryPath;
    if (typeof result.code === 'string') wrapped.code = result.code;
    return wrapped;
  }
}

/**
 * Atomically replace a JSON file without deleting or copying over its previous version.
 * All failures after creating the unique, private temporary file preserve it for recovery.
 * Only transient Windows rename errors receive bounded, local filesystem retries.
 */
export async function atomicWriteJson(destination, value, options = {}) {
  // Serialization must finish before any filesystem operation, including temp creation.
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('The value must serialize to a JSON document');
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new TypeError('destination must be a nonempty filesystem path');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const fs = options.fs ?? filesystem;
  const sleep = options.sleep ?? delay;
  const platform = options.platform ?? process.platform;
  const delays = retryDelays(options.retryDelaysMs);
  if (!fs || typeof fs.open !== 'function' || typeof fs.rename !== 'function' || typeof sleep !== 'function' ||
      typeof platform !== 'string') {
    throw new TypeError('Invalid atomic JSON filesystem, sleep or platform options');
  }

  const target = resolve(destination);
  let temporaryPath;
  let handle;
  // wx prevents even the extremely unlikely UUID collision from changing another file.
  for (let attempt = 0; attempt < MAX_TEMP_COLLISIONS; attempt += 1) {
    temporaryPath = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === MAX_TEMP_COLLISIONS - 1) throw error;
    }
  }

  let preparationError;
  let preparationFailed = false;
  try {
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    preparationFailed = true;
    preparationError = error;
  }
  try {
    // Closing our own handle before rename avoids a Windows sharing violation.
    await handle.close();
  } catch (error) {
    if (!preparationFailed) preparationError = error;
    preparationFailed = true;
  }
  if (preparationFailed) throw withTemporaryPath(preparationError, temporaryPath);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporaryPath, target);
      return;
    } catch (error) {
      if (platform !== 'win32' || !RETRYABLE_WINDOWS_RENAME_CODES.has(error?.code) || attempt >= delays.length) {
        throw withTemporaryPath(error, temporaryPath);
      }
      try {
        await sleep(delays[attempt]);
      } catch (sleepError) {
        throw withTemporaryPath(sleepError, temporaryPath);
      }
    }
  }
}
