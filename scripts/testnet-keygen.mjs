import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This is a local key pair, not a Binance production credential.
const directory = resolve('.secrets');
await mkdir(directory, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
// Refuse to replace an existing private key.
await writeFile(resolve(directory, 'testnet-ed25519-private.pem'), privateKey, { flag: 'wx', mode: 0o600 });
await writeFile(resolve(directory, 'testnet-ed25519-public.pem'), publicKey, { flag: 'wx', mode: 0o600 });
console.log('本机 Testnet Ed25519 密钥对已创建。私钥不会输出，请仅将 public.pem 注册到测试网。');
