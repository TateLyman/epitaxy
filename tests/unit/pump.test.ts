import { describe, it, expect } from 'vitest';
import {
  decodeBondingCurve,
  quoteBuyTokensForSol,
  quoteSellSolForTokens,
  positionShareOfRealSolBps,
  bondingCurveAddress,
  venueOf,
  fingerprintChanged,
  PumpDecodeError,
  BONDING_CURVE_DISCRIMINATOR,
  STANDARD_VIRTUAL_SOL_OFFSET,
  STANDARD_VIRTUAL_TOKEN_OFFSET,
  PUMP_PROGRAM,
  type PumpFingerprint,
} from '../../packages/solana/src/pump.js';
import { associatedTokenAddress, isOnCurve, findProgramAddress } from '../../packages/solana/src/pda.js';
import { base58Decode } from '../../packages/solana/src/base58.js';

/**
 * §13 — Pump decoding, against bytes read from mainnet rather than from memory.
 *
 * The fixtures below are REAL live curves captured during development. The
 * from-memory version of this decoder had the account at 81 bytes; the real
 * ones are 115 and 151, with the same discriminator.
 */

/** Build a curve account from verified field values. */
function curveBytes(
  v: { vTok: bigint; vSol: bigint; rTok: bigint; rSol: bigint; supply: bigint; complete: number },
  totalLength = 151,
): Uint8Array {
  const b = Buffer.alloc(totalLength);
  Buffer.from(BONDING_CURVE_DISCRIMINATOR, 'hex').copy(b, 0);
  b.writeBigUInt64LE(v.vTok, 8);
  b.writeBigUInt64LE(v.vSol, 16);
  b.writeBigUInt64LE(v.rTok, 24);
  b.writeBigUInt64LE(v.rSol, 32);
  b.writeBigUInt64LE(v.supply, 40);
  b[48] = v.complete;
  return new Uint8Array(b);
}

/** A live curve captured from mainnet, 151 bytes. */
const LIVE = {
  vTok: 836_032_889_977_608n,
  vSol: 38_503_269_927n,
  rTok: 556_132_889_977_608n,
  rSol: 8_503_269_927n,
  supply: 1_000_000_000_000_000n,
  complete: 0,
};

/** A second live curve, captured at 115 bytes. Same discriminator. */
const LIVE_SHORT = {
  vTok: 1_072_996_467_552_563n,
  vSol: 30_000_098_765n,
  rTok: 793_096_467_552_563n,
  rSol: 98_765n,
  supply: 1_000_000_000_000_000n,
  complete: 0,
};

/** A migrated curve: reserves zeroed, complete set. */
const MIGRATED = { vTok: 0n, vSol: 0n, rTok: 0n, rSol: 0n, supply: 1_000_000_000_000_000n, complete: 1 };

describe('decodeBondingCurve against real mainnet shapes', () => {
  it('decodes a 151-byte curve', () => {
    const c = decodeBondingCurve(curveBytes(LIVE, 151));
    expect(c.virtualSolReserves).toBe(38_503_269_927n);
    expect(c.realSolReserves).toBe(8_503_269_927n);
    expect(c.complete).toBe(false);
    expect(c.undecodedTailBytes).toBe(151 - 49);
  });

  it('decodes a 115-byte curve with the same discriminator', () => {
    // The account length varies in the wild. A decoder requiring an exact
    // length would reject live curves, and one assuming 81 bytes would read
    // every field after the prefix out of the wrong offsets.
    const c = decodeBondingCurve(curveBytes(LIVE_SHORT, 115));
    expect(c.virtualSolReserves).toBe(30_000_098_765n);
    expect(c.undecodedTailBytes).toBe(115 - 49);
  });

  it('confirms both standard virtual offsets on both live curves', () => {
    // These held EXACTLY on every live curve observed, and they are what makes
    // the offsets trustworthy rather than plausible.
    for (const v of [LIVE, LIVE_SHORT]) {
      expect(v.vSol - v.rSol).toBe(STANDARD_VIRTUAL_SOL_OFFSET);
      expect(v.vTok - v.rTok).toBe(STANDARD_VIRTUAL_TOKEN_OFFSET);
      expect(decodeBondingCurve(curveBytes(v)).standardConfiguration).toBe(true);
    }
  });

  it('flags a non-standard configuration AND refuses to price it', () => {
    const odd = decodeBondingCurve(curveBytes({ ...LIVE, vSol: LIVE.rSol + 1n }));
    expect(odd.standardConfiguration).toBe(false);
    expect(odd.anomalies.join(' ')).toContain('non-standard virtual offsets');
    // Measured against the router: every standard curve agreed at a stable 123
    // bps across three tokens and six sizes, and every disagreement -- up to
    // 13,064 bps, with the router paying MORE than the constant product allows
    // -- was on a non-standard curve. Flagging it was not enough.
    expect(quoteBuyTokensForSol(odd, 20_000_000n)).toBeNull();
    expect(quoteSellSolForTokens(odd, 1_000_000n)).toBeNull();
  });

  it('refuses anything that is not a bonding curve', () => {
    const wrong = Buffer.alloc(151);
    expect(() => decodeBondingCurve(new Uint8Array(wrong))).toThrow(PumpDecodeError);
    expect(() => decodeBondingCurve(new Uint8Array(10))).toThrow(/CURVE_TOO_SHORT/);
  });

  it('flags a complete byte that is neither 0 nor 1', () => {
    // A bool that is not a bool means the offset is wrong, and every field
    // around it is suspect too.
    const c = decodeBondingCurve(curveBytes({ ...LIVE, complete: 7 }));
    expect(c.anomalies.join(' ')).toContain('complete byte is 7');
  });
});

describe('migration is the fact that decides the venue', () => {
  it('reports a migrated curve as migrated, not as empty', () => {
    const c = decodeBondingCurve(curveBytes(MIGRATED));
    expect(venueOf(c)).toBe('MIGRATED_TO_PUMPSWAP');
    // THE trap: a complete curve holds nothing, so reading its reserves as a
    // price gives zero, and zero looks exactly like a rug.
    expect(quoteBuyTokensForSol(c, 20_000_000n)).toBeNull();
    expect(quoteSellSolForTokens(c, 1_000_000n)).toBeNull();
  });

  it('distinguishes a token with no curve from one that migrated', () => {
    expect(venueOf(null)).toBe('NOT_A_PUMP_TOKEN');
  });
});

describe('quoting on virtual reserves', () => {
  const live = decodeBondingCurve(curveBytes(LIVE));

  it('prices against virtual reserves, not real ones', () => {
    const out = quoteBuyTokensForSol(live, 1_000_000_000n);
    expect(out).not.toBeNull();
    // Constant product on the virtual reserves: k/(x+dx) leaves this many.
    const k = LIVE.vSol * LIVE.vTok;
    const expected = LIVE.vTok - k / (LIVE.vSol + 1_000_000_000n);
    expect(out).toBe(expected);
    // Using REAL reserves would have overstated impact roughly fourfold on this
    // curve, which has 8.5 real SOL against 38.5 virtual.
    expect(LIVE.vSol / LIVE.rSol).toBeGreaterThanOrEqual(4n);
  });

  it('refuses to sell more SOL than the curve really holds', () => {
    // The virtual reserves would happily quote it. The curve cannot pay it.
    expect(quoteSellSolForTokens(live, 10n ** 18n)).toBeNull();
  });

  it('refuses to sell more tokens than really remain', () => {
    expect(quoteBuyTokensForSol(live, 10n ** 15n)).toBeNull();
  });

  it('returns null rather than zero for a nonsensical size', () => {
    expect(quoteBuyTokensForSol(live, 0n)).toBeNull();
    expect(quoteBuyTokensForSol(live, -1n)).toBeNull();
  });

  it('measures a position against REAL sol, which is what an exit consumes', () => {
    // A position worth 40% of the pool's real SOL cannot be exited at anything
    // like its quoted value, and this is the cheapest way to know beforehand.
    // Rounded up: 850,326,992 of 8,503,269,927 is 999.99 bps, reported as 1000.
    // Truncating would make the position look smaller than it is, which is
    // wrong in the direction that lets a trade through.
    expect(positionShareOfRealSolBps(live, 850_326_992n)).toBe(1_000);
    expect(positionShareOfRealSolBps(live, 8_503_269_927n)).toBe(10_000);
    expect(positionShareOfRealSolBps(decodeBondingCurve(curveBytes(MIGRATED)), 1n)).toBeNull();
  });
});

describe('PDA derivation', () => {
  it('derives the ATA the real runtime actually created', () => {
    // Independent verification: this exact address appeared as the created
    // account in every prospective-parity run against a live SVM.
    expect(
      associatedTokenAddress('8MNXnWvhMvzfkNrySGQiPSiTYUxs2TboM9pzXCZw7AJ3', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    ).toBe('HoQ6taGg5d5iwDip7Fs8fVUMmV1XyjS9BCDjuWwwu6ZV');
  });

  it('produces off-curve addresses, which is the entire security property', () => {
    // A "derived" address that IS on the curve could have a private key, and a
    // program would treat somebody's wallet as its own vault.
    const wallet = '8MNXnWvhMvzfkNrySGQiPSiTYUxs2TboM9pzXCZw7AJ3';
    expect(isOnCurve(base58Decode(wallet))).toBe(true);
    const pda = findProgramAddress(['bonding-curve', base58Decode(wallet)], PUMP_PROGRAM);
    expect(isOnCurve(base58Decode(pda.address))).toBe(false);
    expect(pda.bump).toBeLessThanOrEqual(255);
  });

  it('derives a bonding curve address deterministically', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(bondingCurveAddress(mint)).toBe(bondingCurveAddress(mint));
    expect(isOnCurve(base58Decode(bondingCurveAddress(mint)))).toBe(false);
  });
});

describe('protocol fingerprints', () => {
  const base: PumpFingerprint = {
    programId: PUMP_PROGRAM,
    programDataHash: 'aaaa',
    upgradeAuthority: 'auth',
    bondingCurveDiscriminator: BONDING_CURVE_DISCRIMINATOR,
    observedAccountLengths: [115, 151],
    capturedUtcMs: 1,
  };

  it('notices new program code', () => {
    expect(fingerprintChanged(base, { ...base, programDataHash: 'bbbb' })).toContain('program code');
  });

  it('notices a new account length, which is how a layout change shows up first', () => {
    // Pump has already done this: 115-byte and 151-byte curves with the same
    // discriminator, observed on the same day. A decoder that did not notice
    // would keep reading old offsets out of new bytes.
    expect(fingerprintChanged(base, { ...base, observedAccountLengths: [115, 151, 187] }).join(' ')).toContain('187');
  });

  it('says nothing changed when nothing changed', () => {
    expect(fingerprintChanged(base, { ...base, capturedUtcMs: 999 })).toEqual([]);
  });
});
