/**
 * Integer amount math. Every function here is total and bigint-based.
 *
 * The rule this file exists to enforce: a number that can become a transfer
 * amount, a fee, or a balance never passes through an IEEE-754 double.
 */

export class AmountError extends Error {}

const MAX_DECIMALS = 18;

/** Cached 10^n so hot paths avoid repeated exponentiation. */
const POW10: bigint[] = (() => {
  const out: bigint[] = [];
  let v = 1n;
  for (let i = 0; i <= MAX_DECIMALS + 1; i++) {
    out.push(v);
    v *= 10n;
  }
  return out;
})();

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > MAX_DECIMALS + 1) {
    throw new AmountError(`pow10 out of range: ${n}`);
  }
  return POW10[n]!;
}

/**
 * Parse a decimal string into raw integer units.
 * Truncates toward zero beyond `decimals` — never rounds up, so a computed
 * input amount can never exceed what the user authorised.
 */
export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError(`unsupported decimals: ${decimals}`);
  }
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.' || trimmed === '-') {
    throw new AmountError(`unparseable amount: ${JSON.stringify(value.slice(0, 32))}`);
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  const fracTrunc = frac.slice(0, decimals).padEnd(decimals, '0');
  const raw = BigInt(whole === '' ? '0' : whole) * pow10(decimals) + BigInt(fracTrunc === '' ? '0' : fracTrunc);
  return negative ? -raw : raw;
}

/** Render raw integer units as an exact decimal string. Lossless. */
export function formatAmount(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError(`unsupported decimals: ${decimals}`);
  }
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const d = pow10(decimals);
  const whole = abs / d;
  const frac = abs % d;
  const sign = negative ? '-' : '';
  if (decimals === 0) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr === '' ? `${sign}${whole}` : `${sign}${whole}.${fracStr}`;
}

/** Basis-point application, rounding DOWN (favours the conservative side for outputs). */
export function applyBpsDown(amount: bigint, bps: number): bigint {
  assertBps(bps);
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** The bps portion itself, rounded UP so a fee is never understated. */
export function feeFromBpsUp(amount: bigint, bps: number): bigint {
  assertBps(bps);
  const num = amount * BigInt(bps);
  return num % 10_000n === 0n ? num / 10_000n : num / 10_000n + 1n;
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new AmountError(`bps out of range: ${bps}`);
  }
}

/**
 * Loss in basis points going from `before` to `after`.
 * Positive = you lost value. Returns null when `before` is zero.
 */
export function lossBps(before: bigint, after: bigint): number | null {
  if (before <= 0n) return null;
  // Scale first, divide once, so precision is preserved for small differences.
  const scaled = ((before - after) * 10_000n * 1000n) / before;
  return Number(scaled) / 1000;
}

/**
 * Minimum output enforced locally. We never trust a router's own
 * otherAmountThreshold as the only protection.
 */
export function minOutWithSlippage(quotedOut: bigint, slippageBps: number): bigint {
  return applyBpsDown(quotedOut, slippageBps);
}

/** Convert raw units to a float ONLY for scoring/display. Never for amounts. */
export function toDisplayNumber(raw: bigint, decimals: number): number {
  return Number(formatAmount(raw, decimals));
}

export function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBigint(...values: readonly bigint[]): bigint {
  if (values.length === 0) throw new AmountError('minBigint requires at least one value');
  let m = values[0]!;
  for (const v of values) if (v < m) m = v;
  return m;
}
