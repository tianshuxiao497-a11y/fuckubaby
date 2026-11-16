import { parseExternalStrategy, EXTERNAL_STRATEGY_BYTES } from '../../../lib/external-testnet-strategy.mjs';

export function liveExternalStrategy(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > EXTERNAL_STRATEGY_BYTES) throw new Error('EXTERNAL_STRATEGY_MAX_8_KB');
  let doc;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('INVALID_STRATEGY_JSON'); }
  if (doc?.version === 1) return { strategy: parseExternalStrategy(text), buyPercent: null };
  if (!doc || doc.version !== 2 || Object.keys(doc).sort().join(',') !== 'entry,exit,name,sizing,version' || Object.keys(doc.sizing ?? {}).join(',') !== 'buyPercent' || typeof doc.sizing.buyPercent !== 'number' || !Number.isFinite(doc.sizing.buyPercent) || doc.sizing.buyPercent < 0.01 || doc.sizing.buyPercent > 100) throw new Error('INVALID_EXTERNAL_SIZING');
  const { sizing, ...rules } = doc;
  return { strategy: parseExternalStrategy(JSON.stringify({ ...rules, version: 1 })), buyPercent: sizing.buyPercent };
}
