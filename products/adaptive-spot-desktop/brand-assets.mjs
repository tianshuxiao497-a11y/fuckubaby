import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Windows Vista+ supports lossless PNG-backed icon frames. Keep every shell
// size rather than stretching a small default application icon.
export function encodeIco(frames) {
  if (!Array.isArray(frames) || frames.length !== ICON_SIZES.length) throw new Error('All reviewed icon sizes are required.');
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const size = ICON_SIZES[index], png = frame.data;
    if (frame.size !== size || !Buffer.isBuffer(png) || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error('Invalid icon PNG frame.');
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.data)]);
}

export function verifyBrandAssets(icon, png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512) throw new Error('The brand PNG must be 512 by 512.');
  if (!Buffer.isBuffer(icon) || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) !== ICON_SIZES.length) throw new Error('Invalid multi-resolution ICO header.');
  let expectedOffset = 6 + ICON_SIZES.length * 16;
  for (let index = 0; index < ICON_SIZES.length; index++) {
    const entry = 6 + index * 16, size = ICON_SIZES[index];
    const bytes = icon.readUInt32LE(entry + 8), offset = icon.readUInt32LE(entry + 12);
    if (icon[entry] !== (size % 256) || icon[entry + 1] !== (size % 256) || icon.readUInt16LE(entry + 4) !== 1 || icon.readUInt16LE(entry + 6) !== 32 || offset !== expectedOffset || bytes < 24 || offset + bytes > icon.length) throw new Error('Invalid ICO directory.');
    const frame = icon.subarray(offset, offset + bytes);
    if (!frame.subarray(0, 8).equals(PNG_SIGNATURE) || frame.readUInt32BE(16) !== size || frame.readUInt32BE(20) !== size) throw new Error('Invalid ICO image dimensions.');
    expectedOffset += bytes;
  }
  if (expectedOffset !== icon.length) throw new Error('Unreviewed bytes after the icon frames.');
  return { sizes: [...ICON_SIZES], pngSize: 512 };
}

export async function generateBrandAssets({ sharpPath } = {}) {
  const require = createRequire(import.meta.url);
  const sharp = require(sharpPath || 'sharp');
  const svg = await readFile(new URL('brand.svg', import.meta.url));
  const frames = await Promise.all(ICON_SIZES.map(async size => ({ size, data: await sharp(svg).resize(size, size).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer() })));
  const png = await sharp(svg).resize(512, 512).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  const icon = encodeIco(frames); verifyBrandAssets(icon, png);
  await writeFile(new URL('app.ico', import.meta.url), icon);
  await writeFile(new URL('brand.png', import.meta.url), png);
  return { iconBytes: icon.length, pngBytes: png.length, sizes: [...ICON_SIZES] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--sharp')) throw new Error('Usage: node brand-assets.mjs [--sharp <sharp package directory>]');
  console.log(JSON.stringify(await generateBrandAssets({ sharpPath: args[1] }), null, 2));
}
