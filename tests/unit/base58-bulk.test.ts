/**
 * `base58DecodeBulk` must be byte-for-byte identical to `base58Decode`, or it is worthless.
 *
 * The bulk decoder exists only because base58 decoding is 99.4% of the cost of a backfill — 311.7ms
 * against 1.9ms of JSON.parse on the same blocks, measured on real SQD data. A ten-fold speedup on
 * a research pipeline is worth having; a decoder that disagrees with the canonical one on a single
 * input is not, because the corpus it produces would be silently wrong and every conclusion drawn
 * from it would inherit that.
 *
 * So equivalence is not asserted on a handful of vectors. It is asserted on the structure of the
 * problem: every length from empty to long, every leading-zero pattern, the alphabet boundaries,
 * randomised round trips, and the exact payload shape this is actually being bought for.
 *
 * The canonical decoder remains the signer path and is NOT modified. This file only proves the
 * fast one may be substituted where signing is not involved.
 */
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode, base58DecodeBulk, Base58Error } from '../../packages/solana/src/base58.js';

/** Deterministic PRNG — `Math.random` is banned in this repository and a seeded draw replays. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

describe('base58DecodeBulk is byte-identical to base58Decode', () => {
  it('agrees on the empty string', () => {
    expect(Array.from(base58DecodeBulk(''))).toEqual(Array.from(base58Decode('')));
    expect(base58DecodeBulk('').length).toBe(0);
  });

  it('agrees on every single character of the alphabet', () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (const c of alphabet) {
      expect(Array.from(base58DecodeBulk(c)), `char ${c}`).toEqual(Array.from(base58Decode(c)));
    }
  });

  /**
   * THE LEADING-ZERO RULE IS THE EASIEST THING TO GET WRONG. Each leading '1' is one leading zero
   * BYTE regardless of the numeric value, and a fast decoder that strips zeros numerically loses
   * them. A Solana pubkey with a leading zero byte is a real address, so this is not academic.
   */
  it('agrees on runs of leading ones, alone and followed by a value', () => {
    for (let n = 1; n <= 40; n += 1) {
      const ones = '1'.repeat(n);
      expect(Array.from(base58DecodeBulk(ones)), `${n} ones`).toEqual(Array.from(base58Decode(ones)));
      const withTail = `${ones}zzz`;
      expect(Array.from(base58DecodeBulk(withTail)), `${n} ones + tail`).toEqual(Array.from(base58Decode(withTail)));
    }
  });

  /** Group boundaries: the bulk decoder consumes five digits at a time, so lengths around multiples of five matter most. */
  it('agrees across every length from 1 to 200', () => {
    const rnd = lcg(20260822);
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let len = 1; len <= 200; len += 1) {
      let s = '';
      for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(rnd() * 58)] as string;
      expect(Array.from(base58DecodeBulk(s, 4096)), `len ${len} -> ${s.slice(0, 24)}`).toEqual(Array.from(base58Decode(s, 4096)));
    }
  });

  it('round-trips random byte arrays through encode, including ones with leading zero bytes', () => {
    const rnd = lcg(7);
    for (let trial = 0; trial < 400; trial += 1) {
      const len = 1 + Math.floor(rnd() * 300);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(rnd() * 256);
      const lead = Math.floor(rnd() * 4);
      for (let i = 0; i < lead && i < len; i += 1) bytes[i] = 0;
      const enc = base58Encode(bytes);
      expect(Array.from(base58DecodeBulk(enc, 4096)), `trial ${trial}`).toEqual(Array.from(base58Decode(enc, 4096)));
      expect(Array.from(base58DecodeBulk(enc, 4096))).toEqual(Array.from(bytes));
    }
  });

  /** The shape this is actually bought for: PumpSwap emit_cpi payloads average 594 base58 chars. */
  it('agrees on payloads the size of a PumpSwap event', () => {
    const rnd = lcg(594);
    for (let trial = 0; trial < 60; trial += 1) {
      const bytes = new Uint8Array(430);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(rnd() * 256);
      const enc = base58Encode(bytes);
      expect(enc.length).toBeGreaterThan(500);
      expect(Array.from(base58DecodeBulk(enc, 4096)), `payload trial ${trial}`).toEqual(Array.from(base58Decode(enc, 4096)));
    }
  });

  it('refuses the same inputs the canonical decoder refuses', () => {
    expect(() => base58DecodeBulk('0')).toThrow(Base58Error);
    expect(() => base58Decode('0')).toThrow(Base58Error);
    expect(() => base58DecodeBulk('O')).toThrow(Base58Error);
    expect(() => base58DecodeBulk('I')).toThrow(Base58Error);
    expect(() => base58DecodeBulk('l')).toThrow(Base58Error);
    expect(() => base58DecodeBulk('abc def')).toThrow(Base58Error);
    expect(() => base58DecodeBulk('1'.repeat(50), 10)).toThrow(Base58Error);
    expect(() => base58Decode('1'.repeat(50), 10)).toThrow(Base58Error);
  });

  it('rejects an invalid character even when it sits inside a five-digit group', () => {
    // The bulk decoder reads five digits before doing any arithmetic; a bad char in position 3 of a
    // group must still throw rather than being folded into the accumulator.
    for (let pos = 0; pos < 5; pos += 1) {
      const s = `${'z'.repeat(pos)}0${'z'.repeat(4 - pos)}`;
      expect(() => base58DecodeBulk(s), `bad char at ${pos}`).toThrow(Base58Error);
    }
  });
});
