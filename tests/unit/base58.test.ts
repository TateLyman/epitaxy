import { describe, it, expect } from 'vitest';
import { base58Decode, base58Encode, isValidPubkey, Base58Error } from '../../packages/solana/src/base58.js';
import { WSOL_MINT, USDC_MINT } from '../../packages/domain/src/types.js';

describe('base58', () => {
  it('round-trips known mainnet mints', () => {
    for (const key of [WSOL_MINT, USDC_MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']) {
      const bytes = base58Decode(key);
      expect(bytes.length).toBe(32);
      expect(base58Encode(bytes)).toBe(key);
    }
  });

  it('preserves leading zero bytes as leading ones', () => {
    // The system program is 32 zero bytes and encodes as 32 '1' characters.
    const systemProgram = '1'.repeat(32);
    expect(base58Decode(systemProgram)).toEqual(new Uint8Array(32));
    expect(base58Encode(new Uint8Array(32))).toBe(systemProgram);
  });

  it('rejects characters outside the alphabet', () => {
    // 0, O, I and l are excluded precisely because they are confusable.
    for (const bad of ['0', 'O', 'I', 'l', '+', '/', ' ']) {
      expect(() => base58Decode(`So1111111111111111111111111111111111111111${bad}`)).toThrow(Base58Error);
    }
  });

  it('rejects strings that decode to the wrong length', () => {
    expect(isValidPubkey('abc')).toBe(false);
    expect(isValidPubkey('')).toBe(false);
    // 44 valid characters that decode to 33 bytes, not 32.
    expect(isValidPubkey('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
  });

  it('rejects a mint-shaped string containing a homoglyph', () => {
    const real = WSOL_MINT;
    const spoofed = real.replace('o', '0');
    expect(isValidPubkey(real)).toBe(true);
    expect(isValidPubkey(spoofed)).toBe(false);
  });
});
