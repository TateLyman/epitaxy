import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { base58Encode, base58Decode, isValidPubkey, Base58Error } from '../../packages/solana/src/base58.js';

/**
 * Base58 is the boundary between a public key as bytes and a public key as a
 * string, and every address comparison in this system happens on the string
 * side. An encoder that dropped a leading zero would produce a *different
 * address that still looks plausible*, which is exactly the class of bug that
 * survives review and fails at the wallet.
 *
 * Leading zeros get their own generator because they are the historical failure
 * mode: base58 has no positional zero, so leading zero bytes must be carried as
 * explicit '1' characters rather than falling out of the arithmetic.
 */

const anyBytes = fc.uint8Array({ minLength: 0, maxLength: 96 });

const bytesWithLeadingZeros = fc
  .tuple(fc.integer({ min: 0, max: 8 }), fc.uint8Array({ minLength: 1, maxLength: 40 }))
  .map(([zeros, rest]) => new Uint8Array([...new Uint8Array(zeros), ...rest]));

describe('base58 round-trips', () => {
  it('decode(encode(bytes)) is the identity on arbitrary bytes', () => {
    fc.assert(
      fc.property(anyBytes, (bytes) => {
        expect([...base58Decode(base58Encode(bytes))]).toEqual([...bytes]);
      }),
    );
  });

  it('preserves leading zero bytes exactly', () => {
    fc.assert(
      fc.property(bytesWithLeadingZeros, (bytes) => {
        const round = base58Decode(base58Encode(bytes));
        expect(round.length).toBe(bytes.length);
        expect([...round]).toEqual([...bytes]);
      }),
    );
  });

  it('renders each leading zero byte as exactly one leading 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 1, max: 255 }), (zeros, tail) => {
        const bytes = new Uint8Array([...new Uint8Array(zeros), tail]);
        const encoded = base58Encode(bytes);
        expect(encoded.length - encoded.replace(/^1+/, '').length).toBe(zeros);
      }),
    );
  });

  it('is injective: different bytes never encode to the same string', () => {
    fc.assert(
      fc.property(anyBytes, anyBytes, (a, b) => {
        const same = a.length === b.length && a.every((v, i) => v === b[i]);
        if (!same) expect(base58Encode(a)).not.toBe(base58Encode(b));
      }),
    );
  });
});

describe('base58 rejects rather than repairs', () => {
  it('refuses any string containing a non-alphabet character', () => {
    // 0, O, I and l are excluded from the alphabet precisely because they are
    // confusable; accepting them would silently resolve an address typo.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 44 }).filter((s) => /[0OIl+/=\s]/.test(s)),
        (s) => {
          expect(() => base58Decode(s)).toThrow(Base58Error);
        },
      ),
    );
  });
});

describe('pubkey validation is a length claim, not a charset claim', () => {
  it('accepts exactly the 32-byte encodings', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        expect(isValidPubkey(base58Encode(bytes))).toBe(true);
      }),
    );
  });

  it('rejects well-formed base58 of any other length', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }).filter((b) => b.length !== 32),
        (bytes) => {
          expect(isValidPubkey(base58Encode(bytes))).toBe(false);
        },
      ),
    );
  });
});
