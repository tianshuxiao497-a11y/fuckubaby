import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteJson } from '../../../lib/atomic-json.mjs';

const derive = promisify(scrypt);
export async function saveVault(path, value, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('VAULT_PASSWORD_AT_LEAST_12_CHARACTERS');
  const salt = randomBytes(32), iv = randomBytes(12);
  const key = await derive(password, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWriteJson(path, { version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') });
  } finally { key.fill(0); }
}

export async function loadVault(path, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('VAULT_PASSWORD_REQUIRED');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('INVALID_VAULT_FILE');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.salt) || !/^[a-f0-9]{24}$/.test(value.iv) || !/^[a-f0-9]{32}$/.test(value.tag) || typeof value.data !== 'string') throw new Error('INVALID_VAULT_FILE');
  const key = await derive(password, Buffer.from(value.salt, 'hex'), 32);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
    cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new Error('VAULT_PASSWORD_OR_DATA_INVALID'); }
  finally { key.fill(0); }
}
