import type { Cents, Ppm, Rational } from './types.ts';

/** Money is integer cents as bigint. Nothing here ever touches a float. */

export function dollarsToCents(dollars: string): Cents {
  const m = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(dollars.replace(/[$,\s]/g, ''));
  if (!m) throw new Error(`not a dollar amount: ${dollars}`);
  const sign = dollars.trim().startsWith('-') ? -1n : 1n;
  const whole = BigInt(m[1] ?? '0');
  const frac = BigInt((m[2] ?? '').padEnd(2, '0'));
  return sign * (whole * 100n + frac);
}

export function centsToDollars(c: Cents): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Round-half-up division of bigints, on the magnitude so negatives behave symmetrically. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero');
  const neg = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

/** Truncating division, for the cases where a source prescribes it. */
export function divTrunc(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero');
  return numerator / denominator;
}

/** Apply a parts-per-million rate to a cents amount, rounding half up to the cent. */
export function applyPpm(amount: Cents, rate: Ppm): Cents {
  return divRoundHalfUp(amount * rate, 1_000_000n);
}

/** Apply an exact rational, rounding half up to the cent. */
export function applyRational(amount: Cents, r: Rational): Cents {
  return divRoundHalfUp(amount * r.numerator, r.denominator);
}

/** Round a cents amount to whole dollars, half up. */
export function roundToWholeDollars(c: Cents): Cents {
  return divRoundHalfUp(c, 100n) * 100n;
}

export function maxCents(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}
