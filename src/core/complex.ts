import type { Complex } from './types';

export type ComplexValue = number | Complex;
export const asComplex = (value: ComplexValue): Complex => typeof value === 'number' ? { re: value, im: 0 } : value;
export const complexValue = (re: number, im: number): ComplexValue => im === 0 && !Object.is(im, -0) ? re : { re, im };
export const complexAbs = (value: ComplexValue): number => typeof value === 'number' ? Math.abs(value) : Math.hypot(value.re, value.im);
export const complexFinite = (value: ComplexValue): boolean => typeof value === 'number' ? Number.isFinite(value) : Number.isFinite(value.re) && Number.isFinite(value.im);
const copySign = (magnitude: number, sign: number): number => sign < 0 || Object.is(sign, -0) ? -Math.abs(magnitude) : Math.abs(magnitude);

export function realCoordinate(value: ComplexValue, label = 'Plot coordinate'): number {
  if (!complexFinite(value)) throw new Error(`Non-finite ${label.toLowerCase()}. Check domains and division by zero.`);
  if (typeof value === 'number') return value;
  if (value.im !== 0) throw new Error(`${label} must be real. Use real(...), imag(...), abs(...) or arg(...).`);
  return value.re;
}

export function complexAdd(left: ComplexValue, right: ComplexValue): ComplexValue {
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  const a = asComplex(left), b = asComplex(right);
  return complexValue(a.re + b.re, a.im + b.im);
}
export function complexSubtract(left: ComplexValue, right: ComplexValue): ComplexValue {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const a = asComplex(left), b = asComplex(right);
  return complexValue(a.re - b.re, a.im - b.im);
}
export function complexMultiply(left: ComplexValue, right: ComplexValue): ComplexValue {
  if (typeof left === 'number' && typeof right === 'number') return left * right;
  const a = asComplex(left), b = asComplex(right);
  return complexValue(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}
export function complexDivide(left: ComplexValue, right: ComplexValue): ComplexValue {
  if (typeof left === 'number' && typeof right === 'number') return left / right;
  const a = asComplex(left), b = asComplex(right);
  const divisorScale = Math.max(Math.abs(b.re), Math.abs(b.im));
  if (divisorScale === 0) throw new Error('Division by zero.');
  const numeratorScale = Math.max(Math.abs(a.re), Math.abs(a.im));
  if (numeratorScale === 0) return 0;
  const ar = a.re / numeratorScale, ai = a.im / numeratorScale;
  const br = b.re / divisorScale, bi = b.im / divisorScale, denominator = br * br + bi * bi;
  const ratio = numeratorScale / divisorScale;
  // Normalize both operands to avoid squaring huge/tiny denominator values.
  // Divide before rescaling if the intermediate magnitude ratio overflows.
  if (Number.isFinite(ratio)) return complexValue((ar * br + ai * bi) / denominator * ratio, (ai * br - ar * bi) / denominator * ratio);
  const dividedRatio = (numeratorScale / denominator) / divisorScale;
  return complexValue((ar * br + ai * bi) * dividedRatio, (ai * br - ar * bi) * dividedRatio);
}
export function complexSqrt(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  if (z.im === 0) return z.re < 0 ? { re: 0, im: copySign(Math.sqrt(-z.re), z.im) } : complexValue(Math.sqrt(z.re), z.im);
  const scale = Math.max(Math.abs(z.re), Math.abs(z.im));
  const radius = Math.hypot(z.re / scale, z.im / scale);
  const large = Math.sqrt(scale) * Math.sqrt((radius + Math.abs(z.re) / scale) / 2);
  return z.re >= 0 ? complexValue(large, z.im / (2 * large)) : complexValue(Math.abs(z.im) / (2 * large), z.im < 0 ? -large : large);
}
export function complexLog(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  if (z.im === 0 && z.re >= 0) return complexValue(Math.log(z.re), z.im);
  const scale = Math.max(Math.abs(z.re), Math.abs(z.im));
  const logMagnitude = Math.log(scale) + Math.log(Math.hypot(z.re / scale, z.im / scale));
  return complexValue(logMagnitude, Math.atan2(z.im, z.re));
}
export function complexExp(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  if (z.im === 0) return Math.exp(z.re);
  const halfMagnitude = Math.exp(z.re / 2);
  return complexValue((halfMagnitude * Math.cos(z.im)) * halfMagnitude, (halfMagnitude * Math.sin(z.im)) * halfMagnitude);
}
export function complexPow(base: ComplexValue, exponent: ComplexValue): ComplexValue {
  const a = asComplex(base), b = asComplex(exponent);
  if (b.im === 0 && Number.isSafeInteger(b.re)) {
    let power = Math.abs(b.re), factor = b.re < 0 ? complexDivide(1, base) : base, result: ComplexValue = 1;
    while (power) {
      if (power % 2) result = complexMultiply(result, factor);
      power = Math.floor(power / 2);
      if (power) factor = complexMultiply(factor, factor);
    }
    return result;
  }
  if (a.re === 0 && a.im === 0) {
    if (b.im === 0 && b.re > 0) return 0;
    throw new Error('Undefined complex power of zero.');
  }
  if (a.im === 0 && a.re > 0 && b.im === 0) return a.re ** b.re;
  return complexExp(complexMultiply(exponent, complexLog(base)));
}
export function complexSin(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  return z.im === 0 ? Math.sin(z.re) : complexValue(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im));
}
export function complexCos(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  return z.im === 0 ? Math.cos(z.re) : complexValue(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im));
}
export function complexTan(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  if (z.im === 0) return Math.tan(z.re);
  const q = Math.exp(-2 * Math.abs(z.im)), denominator = 1 + q * q + 2 * q * Math.cos(2 * z.re);
  return complexValue(2 * q * Math.sin(2 * z.re) / denominator, Math.sign(z.im) * (1 - q * q) / denominator);
}
export function complexSinh(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  return z.im === 0 ? Math.sinh(z.re) : complexValue(Math.sinh(z.re) * Math.cos(z.im), Math.cosh(z.re) * Math.sin(z.im));
}
export function complexCosh(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  return z.im === 0 ? Math.cosh(z.re) : complexValue(Math.cosh(z.re) * Math.cos(z.im), Math.sinh(z.re) * Math.sin(z.im));
}
export function complexTanh(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  if (z.im === 0) return Math.tanh(z.re);
  const q = Math.exp(-2 * Math.abs(z.re)), denominator = 1 + q * q + 2 * q * Math.cos(2 * z.im);
  return complexValue(Math.sign(z.re) * (1 - q * q) / denominator, 2 * q * Math.sin(2 * z.im) / denominator);
}
export function complexAsin(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  const x = Math.abs(z.re), y = Math.abs(z.im), scale = Math.max(x, y);
  if (y === 0) return x <= 1 ? complexValue(Math.asin(z.re), z.im) : complexValue(copySign(Math.PI / 2, z.re), copySign(Math.acosh(x), z.im));
  // NIST DLMF 4.23(vi): sin(u) = x/A and cosh(v) = A, where
  // A = (hypot(x+1,y) + hypot(x-1,y))/2. Compute A-1 without
  // subtracting nearly equal numbers so imaginary derivatives survive near R.
  if (scale > 1e150) {
    const imaginary = Math.log(scale) + Math.log(Math.hypot(x / scale, y / scale)) + Math.LN2;
    return complexValue(copySign(Math.atan2(x, y), z.re), copySign(imaginary, z.im));
  }
  const plus = Math.hypot(x + 1, y), minus = Math.hypot(x - 1, y), a = plus / 2 + minus / 2;
  const excess = Math.max(0, x - 1) + (y * (y / (plus + x + 1)) + y * (y / (minus + Math.abs(x - 1)))) / 2;
  const imaginary = excess === 0 && x < 1
    ? Math.asinh(y / Math.sqrt((1 - x) * (1 + x)))
    : Math.log1p(excess + Math.sqrt(excess) * Math.sqrt(excess + 2));
  const real = Math.atan2(x, a * (y / Math.sinh(imaginary)));
  return complexValue(copySign(real, z.re), copySign(imaginary, z.im));
}
export function complexAcos(value: ComplexValue): ComplexValue { return complexSubtract(Math.PI / 2, complexAsin(value)); }
export function complexAtan(value: ComplexValue): ComplexValue {
  const z = asComplex(value);
  if (z.im === 0) return Math.atan(z.re);
  const scale = Math.max(1, Math.abs(z.re), Math.abs(z.im)), x = z.re / scale, y = z.im / scale, unit = 1 / scale;
  const real = Math.atan2(2 * x / scale, unit * unit - x * x - y * y) / 2;
  const denominator = x * x + (y - unit) * (y - unit), ratio = 4 * y / scale / denominator;
  // log1p keeps tiny imaginary parts; logarithm differences handle the
  // neighborhoods of ±i where that ratio can overflow or round to -1.
  const imaginary = ratio > -.5 && Number.isFinite(ratio) ? Math.log1p(ratio) / 4
    : (asComplex(complexLog({ re: z.re, im: z.im + 1 })).re - asComplex(complexLog({ re: z.re, im: z.im - 1 })).re) / 2;
  return complexValue(real, imaginary);
}
