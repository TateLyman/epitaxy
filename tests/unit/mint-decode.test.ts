import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeMint,
  MintDecodeError,
  MAX_KNOWN_EXTENSION,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from '../../packages/solana/src/mint.js';

/**
 * Fixtures are real mainnet accounts captured by scripts/capture-mint-fixtures.ts.
 * Hand-written bytes would only prove the decoder agrees with our own reading
 * of the layout, which is the thing under test.
 */
function fixture(name: string): { owner: string; data: Uint8Array; mint: string } {
  const raw = JSON.parse(readFileSync(`tests/fixtures/mints/${name}.json`, 'utf8')) as {
    mint: string;
    owner: string;
    dataBase64: string;
  };
  return { owner: raw.owner, mint: raw.mint, data: new Uint8Array(Buffer.from(raw.dataBase64, 'base64')) };
}

describe('decodeMint — classic SPL Token', () => {
  it('decodes wrapped SOL', () => {
    const f = fixture('wsol');
    const d = decodeMint(f.data, f.owner);
    expect(d.programId).toBe(TOKEN_PROGRAM);
    expect(d.decimals).toBe(9);
    expect(d.isInitialized).toBe(true);
    expect(d.freezeAuthority).toBeNull();
    expect(d.extensions).toEqual([]);
    expect(d.transferFee).toBeNull();
    expect(d.hostileExtensions).toEqual([]);
  });

  it('reports USDC as freezable', () => {
    const f = fixture('usdc');
    const d = decodeMint(f.data, f.owner);
    expect(d.decimals).toBe(6);
    // USDC is centrally freezable. The decoder must say so plainly; a token
    // whose issuer can freeze our account is a token we can be locked out of.
    expect(d.freezeAuthority).not.toBeNull();
    expect(d.mintAuthority).not.toBeNull();
    expect(d.supply).toBeGreaterThan(0n);
  });
});

describe('decodeMint — Token-2022 extensions', () => {
  it('walks the full TLV area of PYUSD', () => {
    const f = fixture('pyusd');
    const d = decodeMint(f.data, f.owner);
    expect(d.programId).toBe(TOKEN_2022_PROGRAM);
    const names = d.extensions.map((e) => e.name);
    expect(names).toContain('TransferFeeConfig');
    expect(names).toContain('PermanentDelegate');
    expect(names).toContain('TransferHook');
    expect(names).toContain('TokenMetadata');
  });

  it('decodes the active transfer fee rather than a misaligned field', () => {
    for (const name of ['pyusd', 'usdg']) {
      const f = fixture(name);
      const d = decodeMint(f.data, f.owner);
      expect(d.transferFee).not.toBeNull();
      // A wrong offset in this struct reads plausible-looking large integers,
      // so the assertion is on exact values, not on "is a number".
      expect(d.transferFee?.basisPoints).toBe(0);
      expect(d.transferFee?.maximumFee).toBe(0n);
    }
  });

  it('flags extensions that can strand or seize a position', () => {
    const f = fixture('pyusd');
    const d = decodeMint(f.data, f.owner);
    expect(d.hostileExtensions).toContain('PermanentDelegate');
    expect(d.hostileExtensions).toContain('TransferHook');
  });
});

describe('decodeMint — fail closed', () => {
  function token2022Mint(extensions: readonly { type: number; len: number }[]): Uint8Array {
    const size = 166 + extensions.reduce((a, e) => a + 4 + e.len, 0);
    const b = new Uint8Array(size);
    b[45] = 1; // initialized
    b[44] = 6; // decimals
    b[165] = 1; // account type: mint
    let o = 166;
    for (const e of extensions) {
      b[o] = e.type & 0xff;
      b[o + 1] = (e.type >> 8) & 0xff;
      b[o + 2] = e.len & 0xff;
      b[o + 3] = (e.len >> 8) & 0xff;
      o += 4 + e.len;
    }
    return b;
  }

  it('accepts the highest documented discriminant', () => {
    const d = decodeMint(token2022Mint([{ type: MAX_KNOWN_EXTENSION, len: 4 }]), TOKEN_2022_PROGRAM);
    expect(d.extensions[0]?.discriminant).toBe(MAX_KNOWN_EXTENSION);
  });

  it('refuses an extension newer than the decoder instead of skipping it', () => {
    // The entire point of the check: a mechanism we have not read about must
    // not be able to travel through this decoder unremarked.
    expect(() => decodeMint(token2022Mint([{ type: MAX_KNOWN_EXTENSION + 1, len: 4 }]), TOKEN_2022_PROGRAM)).toThrow(
      MintDecodeError,
    );
  });

  it('refuses a TLV entry claiming more bytes than the account holds', () => {
    const b = token2022Mint([{ type: 1, len: 4 }]);
    b[168] = 0xff; // overwrite the length with something past the end
    b[169] = 0xff;
    expect(() => decodeMint(b, TOKEN_2022_PROGRAM)).toThrow(MintDecodeError);
  });

  it('refuses an uninitialized mint', () => {
    const b = token2022Mint([]);
    b[45] = 0;
    expect(() => decodeMint(b, TOKEN_2022_PROGRAM)).toThrow(MintDecodeError);
  });

  it('refuses a truncated account', () => {
    expect(() => decodeMint(new Uint8Array(40), TOKEN_PROGRAM)).toThrow(MintDecodeError);
  });

  it('refuses an unrecognised owning program', () => {
    const f = fixture('wsol');
    expect(() => decodeMint(f.data, '11111111111111111111111111111111')).toThrow(MintDecodeError);
  });

  it('refuses an invalid COption tag rather than guessing', () => {
    const f = fixture('wsol');
    const b = new Uint8Array(f.data);
    b[0] = 7; // neither 0 (None) nor 1 (Some)
    expect(() => decodeMint(b, TOKEN_PROGRAM)).toThrow(MintDecodeError);
  });
});
