export const SCALE = 1000000000000n;

export function units(value) {
  if (typeof value !== 'string' || !/^\d{1,18}(\.\d{1,12})?$/.test(value)) {
    throw new Error('INVALID_DECIMAL');
  }
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer) * SCALE + BigInt(fraction.padEnd(12, '0'));
}

export function decimal(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / SCALE}${fraction ? '.' + fraction : ''}`;
}

export function multiply(a, b) { return a * b / SCALE; }
export function multiplyUp(a, b) { return (a * b + SCALE - 1n) / SCALE; }
export function divide(a, b) {
  if (b <= 0n) throw new Error('INVALID_DIVISOR');
  return a * SCALE / b;
}
export function floorStep(value, step) {
  if (step <= 0n) throw new Error('INVALID_STEP');
  return value / step * step;
}
export function ceilStep(value, step) {
  if (step <= 0n) throw new Error('INVALID_STEP');
  return (value + step - 1n) / step * step;
}
export function minimum(...values) { return values.reduce((a, b) => a < b ? a : b); }
