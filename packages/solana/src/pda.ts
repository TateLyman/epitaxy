import { createHash } from 'node:crypto';
import { base58Decode, base58Encode } from './base58.js';

/**
 * Program-derived addresses.
 *
 * A PDA is a hash that is deliberately NOT a valid ed25519 public key, so no
 * private key can exist for it. That off-curve check is the entire security
 * property: without it, a "derived" address could be one somebody holds the key
 * to, and a program would happily treat an attacker's wallet as its own vault.
 *
 * So the check is implemented properly here rather than skipped. A derivation
 * that returns the first hash without testing it would be right roughly half
 * the time and wrong silently the rest.
 */

const P = 2n ** 255n - 19n;
/** The Edwards curve constant d = -121665/121666 mod p. */
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

export class PdaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdaError';
  }
}

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modPow(base: bigint, exp: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

/**
 * Is this 32-byte value a point on ed25519?
 *
 * Decompresses the y coordinate and asks whether a matching x exists. The curve
 * equation is `-x^2 + y^2 = 1 + d*x^2*y^2`, so `x^2 = (y^2 - 1) / (d*y^2 + 1)`,
 * and the point is on the curve exactly when that quotient is a quadratic
 * residue mod p.
 *
 * A candidate that IS on the curve is rejected as a PDA, because a keypair for
 * it could exist.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  // Little-endian, with the top bit carrying the sign of x rather than y.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] as number);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  const y2 = mod(y * y);
  const numerator = mod(y2 - 1n);
  const denominator = mod(D * y2 + 1n);
  if (denominator === 0n) return false;

  // x^2 = num / den, via Fermat's little theorem for the inverse.
  const x2 = mod(numerator * modPow(denominator, P - 2n));
  if (x2 === 0n) return true;

  // Euler's criterion: a is a residue iff a^((p-1)/2) == 1.
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

/**
 * Derive a PDA, returning the address and the bump that produced it.
 *
 * Walks the bump from 255 down, exactly as the runtime does, and takes the
 * first candidate that is off the curve. Counting UP would find a different
 * valid-looking address that no program would ever agree with.
 */
export function findProgramAddress(
  seeds: readonly (Uint8Array | string)[],
  programId: string,
): { address: string; bump: number } {
  if (seeds.length > MAX_SEEDS) throw new PdaError(`${seeds.length} seeds, maximum is ${MAX_SEEDS}`);
  const raw = seeds.map((s) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s)));
  for (const s of raw) {
    if (s.length > MAX_SEED_LENGTH) throw new PdaError(`seed of ${s.length} bytes, maximum is ${MAX_SEED_LENGTH}`);
  }
  const program = Buffer.from(base58Decode(programId));

  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of raw) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(program);
    h.update(PDA_MARKER);
    const candidate = new Uint8Array(h.digest());
    if (!isOnCurve(candidate)) return { address: base58Encode(candidate), bump };
  }
  // Astronomically unlikely, and a silent wrong answer would be worse.
  throw new PdaError('no off-curve address found for any bump');
}

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * The associated token account for a wallet and mint.
 *
 * Present because it is independently verifiable: surfpool computes the same
 * address from its own implementation, so the two disagreeing is a bug in this
 * file rather than an opinion.
 */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return findProgramAddress(
    [base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)],
    ASSOCIATED_TOKEN_PROGRAM,
  ).address;
}
