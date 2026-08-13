import { base58Decode, base58Encode } from './base58.js';
import { findProgramAddress } from './pda.js';

/**
 * Pump.fun bonding curves, decoded from bytes this project has actually read.
 *
 * §13 — every collapse this system has observed routed through Pump liquidity,
 * which makes these the highest-value facts available and the ones most worth
 * getting exactly right.
 *
 * The layout below was VERIFIED against live mainnet accounts rather than taken
 * from memory, and the verification corrected two things a from-memory version
 * would have got wrong:
 *
 *   1. The account is not 81 bytes. Real accounts came back at 115 AND 151
 *      bytes with the same discriminator, so the tail is extensible and a
 *      decoder that requires an exact length would reject live curves.
 *   2. Only the first 49 bytes are established. Everything after is left
 *      undecoded rather than guessed, because a field read at the wrong offset
 *      produces a number, and a number is indistinguishable from a measurement.
 *
 * Two invariants held on every live curve observed and are checked rather than
 * assumed:
 *
 *      virtual_sol_reserves   - real_sol_reserves   == 30 SOL exactly
 *      virtual_token_reserves - real_token_reserves == 279,900,000,000,000
 *
 * They are the curve's initial virtual offsets. A curve that violates them is
 * either a different configuration or a misread, and either way it is not
 * something to price a trade against.
 */

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Anchor discriminator for the BondingCurve account, observed on mainnet. */
export const BONDING_CURVE_DISCRIMINATOR = '17b7f83760d8ac60';

/** The established prefix. Anything beyond this is not decoded. */
export const BONDING_CURVE_VERIFIED_BYTES = 49;

/** Standard virtual offsets, observed exactly on every live curve. */
export const STANDARD_VIRTUAL_SOL_OFFSET = 30_000_000_000n;
export const STANDARD_VIRTUAL_TOKEN_OFFSET = 279_900_000_000_000n;

export class PumpDecodeError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PumpDecodeError';
  }
}

export interface BondingCurve {
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly tokenTotalSupply: bigint;
  /** True once the curve has migrated to PumpSwap. Reserves go to zero. */
  readonly complete: boolean;
  /** Bytes present beyond the verified prefix. Not decoded. */
  readonly undecodedTailBytes: number;
  /** True when both virtual offsets matched the standard configuration. */
  readonly standardConfiguration: boolean;
  readonly anomalies: readonly string[];
}

export function decodeBondingCurve(data: Uint8Array): BondingCurve {
  if (data.length < BONDING_CURVE_VERIFIED_BYTES) {
    throw new PumpDecodeError('CURVE_TOO_SHORT', `${data.length} bytes, need at least ${BONDING_CURVE_VERIFIED_BYTES}`);
  }
  const buf = Buffer.from(data);
  const disc = buf.subarray(0, 8).toString('hex');
  if (disc !== BONDING_CURVE_DISCRIMINATOR) {
    throw new PumpDecodeError('NOT_A_BONDING_CURVE', `discriminator ${disc}`);
  }

  const virtualTokenReserves = buf.readBigUInt64LE(8);
  const virtualSolReserves = buf.readBigUInt64LE(16);
  const realTokenReserves = buf.readBigUInt64LE(24);
  const realSolReserves = buf.readBigUInt64LE(32);
  const tokenTotalSupply = buf.readBigUInt64LE(40);
  const completeByte = buf[48] as number;

  const anomalies: string[] = [];
  // A bool that is neither 0 nor 1 means the offset is wrong, and every field
  // around it is suspect too.
  if (completeByte > 1) anomalies.push(`complete byte is ${completeByte}, expected 0 or 1`);
  if (virtualTokenReserves < realTokenReserves) anomalies.push('virtual token reserves below real');
  if (virtualSolReserves < realSolReserves) anomalies.push('virtual SOL reserves below real');

  const complete = completeByte === 1;
  // A migrated curve zeroes its reserves, so the offsets only mean anything
  // while it is live.
  const solOffset = virtualSolReserves - realSolReserves;
  const tokenOffset = virtualTokenReserves - realTokenReserves;
  const standardConfiguration =
    complete || (solOffset === STANDARD_VIRTUAL_SOL_OFFSET && tokenOffset === STANDARD_VIRTUAL_TOKEN_OFFSET);
  if (!standardConfiguration) {
    anomalies.push(
      `non-standard virtual offsets: SOL ${solOffset} (expected ${STANDARD_VIRTUAL_SOL_OFFSET}), ` +
        `token ${tokenOffset} (expected ${STANDARD_VIRTUAL_TOKEN_OFFSET})`,
    );
  }

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    undecodedTailBytes: data.length - BONDING_CURVE_VERIFIED_BYTES,
    standardConfiguration,
    anomalies,
  };
}

/** The canonical bonding-curve address for a mint. */
export function bondingCurveAddress(mint: string): string {
  return findProgramAddress(['bonding-curve', base58Decode(mint)], PUMP_PROGRAM).address;
}

/**
 * Migration state, which is the fact that decides which venue prices the token.
 *
 * A complete curve holds nothing: its reserves are zero and its liquidity has
 * moved to PumpSwap. Reading a complete curve's reserves as a price gives zero,
 * and zero looks exactly like a rug.
 */
export type PumpVenue = 'BONDING_CURVE' | 'MIGRATED_TO_PUMPSWAP' | 'NOT_A_PUMP_TOKEN' | 'UNKNOWN';

export function venueOf(curve: BondingCurve | null): PumpVenue {
  if (curve === null) return 'NOT_A_PUMP_TOKEN';
  return curve.complete ? 'MIGRATED_TO_PUMPSWAP' : 'BONDING_CURVE';
}

/**
 * Quote a buy against the constant product of the VIRTUAL reserves.
 *
 * Pump prices on virtual reserves, not real ones, which is why a curve with 8.5
 * real SOL prices as though it had 38.5. Using real reserves would overstate
 * impact by a factor of four on a young token.
 *
 * Returns null rather than a number whenever the curve cannot price the trade:
 * migrated, empty, or asked for more tokens than remain. A null here is the
 * difference between "no quote" and "a quote of zero".
 */
export function quoteBuyTokensForSol(curve: BondingCurve, solIn: bigint): bigint | null {
  if (curve.complete) return null;
  if (solIn <= 0n) return null;
  if (curve.virtualSolReserves <= 0n || curve.virtualTokenReserves <= 0n) return null;

  // k = x * y, held constant. tokensOut = y - k/(x + dx).
  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newSol = curve.virtualSolReserves + solIn;
  const newTokens = k / newSol;
  const out = curve.virtualTokenReserves - newTokens;
  if (out <= 0n) return null;
  // The curve cannot sell tokens it does not really hold, whatever the virtual
  // reserves say.
  if (out > curve.realTokenReserves) return null;
  return out;
}

/** Quote a sell. Same curve, opposite direction, same refusals. */
export function quoteSellSolForTokens(curve: BondingCurve, tokensIn: bigint): bigint | null {
  if (curve.complete) return null;
  if (tokensIn <= 0n) return null;
  if (curve.virtualSolReserves <= 0n || curve.virtualTokenReserves <= 0n) return null;
  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newTokens = curve.virtualTokenReserves + tokensIn;
  const newSol = k / newTokens;
  const out = curve.virtualSolReserves - newSol;
  if (out <= 0n) return null;
  // Real SOL is what can actually be paid out.
  if (out > curve.realSolReserves) return null;
  return out;
}

/**
 * How much of the curve's real SOL a position represents.
 *
 * The number that says whether an exit is possible at size. A position worth
 * 40% of the pool's real SOL cannot be sold at anything like its quoted value,
 * and this is the cheapest way to know that before entering.
 */
export function positionShareOfRealSolBps(curve: BondingCurve, positionValueLamports: bigint): number | null {
  if (curve.realSolReserves <= 0n) return null;
  // Rounded UP. This is a risk measure, and truncation makes a position look
  // like a smaller fraction of the pool than it is -- wrong in the direction
  // that lets a trade through.
  const numerator = positionValueLamports * 10_000n;
  return Number((numerator + curve.realSolReserves - 1n) / curve.realSolReserves);
}

/**
 * The protocol fingerprint.
 *
 * §13 — "a fingerprint change begins a new regime and blocks capital modes".
 * Pump has changed its account layout at least once already: this project
 * observed 115-byte and 151-byte curves with the same discriminator on the same
 * day. A decoder that did not notice would keep reading the old offsets out of
 * new bytes.
 */
export interface PumpFingerprint {
  readonly programId: string;
  readonly programDataHash: string | null;
  readonly upgradeAuthority: string | null;
  readonly bondingCurveDiscriminator: string;
  readonly observedAccountLengths: readonly number[];
  readonly capturedUtcMs: number;
}

export function fingerprintChanged(a: PumpFingerprint, b: PumpFingerprint): string[] {
  const changes: string[] = [];
  if (a.programId !== b.programId) changes.push('program id');
  if (a.programDataHash !== b.programDataHash) changes.push('program code');
  if (a.upgradeAuthority !== b.upgradeAuthority) changes.push('upgrade authority');
  if (a.bondingCurveDiscriminator !== b.bondingCurveDiscriminator) changes.push('account discriminator');
  const newLengths = b.observedAccountLengths.filter((l) => !a.observedAccountLengths.includes(l));
  if (newLengths.length > 0) changes.push(`new account length(s) ${newLengths.join(', ')}`);
  return changes;
}

export { base58Encode };
