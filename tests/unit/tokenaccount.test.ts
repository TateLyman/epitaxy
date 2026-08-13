import { describe, it, expect } from 'vitest';
import {
  encodeTokenAccount,
  decodeTokenAccountAmount,
  rentExemptLamports,
  TokenAccountEncodeError,
  TOKEN_ACCOUNT_LEN,
} from '../../packages/solana/src/tokenaccount.js';
import { base58Encode } from '../../packages/solana/src/base58.js';

/**
 * P4 — exact token provisioning above 2^53.
 *
 * The convenience API takes a JavaScript `number`. Refusing to round was right
 * and it meant an ordinary fresh memecoin position could not be simulated at
 * all: nine decimals against a billion supply is 10^18 atoms.
 *
 * "No amount may be rounded" is the requirement, so every case here checks the
 * amount survives a round trip through the bytes rather than checking that the
 * call did not throw.
 */

const pk = (seed: number): string => {
  const b = new Uint8Array(32);
  b[0] = seed;
  b[31] = 1;
  return base58Encode(b);
};
const MINT = pk(7);
const OWNER = pk(9);

const amountOf = (amount: bigint): bigint | null =>
  decodeTokenAccountAmount(encodeTokenAccount({ mint: MINT, owner: OWNER, amount }));

describe('P4 — no amount is rounded', () => {
  for (const [label, amount] of [
    ['2^53 - 1', 9_007_199_254_740_991n],
    ['2^53', 9_007_199_254_740_992n],
    ['2^53 + 1', 9_007_199_254_740_993n],
    ['10^18 atoms', 1_000_000_000_000_000_000n],
    ['u64 max', 18_446_744_073_709_551_615n],
    ['zero', 0n],
    ['one', 1n],
  ] as const) {
    it(`${label} survives the round trip exactly`, () => {
      expect(amountOf(amount)).toBe(amount);
    });
  }

  it('2^53 and 2^53 + 1 stay distinct, which is the whole point', () => {
    // Through a double they are the same number, and the failure hides itself:
    // the damaged value compares equal to the source literal.
    expect(amountOf(9_007_199_254_740_992n)).not.toBe(amountOf(9_007_199_254_740_993n));
    expect(Number(9_007_199_254_740_992n) === Number(9_007_199_254_740_993n)).toBe(true);
  });

  it('refuses an amount past u64 rather than truncating it to a small one', () => {
    expect(() => encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 2n ** 64n })).toThrow(TokenAccountEncodeError);
    expect(() => encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 2n ** 64n })).toThrow(/does not fit in a u64/);
  });

  it('refuses a negative amount, which is not a balance', () => {
    expect(() => encodeTokenAccount({ mint: MINT, owner: OWNER, amount: -1n })).toThrow(/negative/);
  });
});

describe('P4 — the layout is the real one', () => {
  it('a legacy account is exactly 165 bytes', () => {
    expect(encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 1n }).length).toBe(TOKEN_ACCOUNT_LEN);
  });

  it('writes mint and owner where the token program reads them', () => {
    const data = encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 1n });
    expect(base58Encode(data.subarray(0, 32))).toBe(MINT);
    expect(base58Encode(data.subarray(32, 64))).toBe(OWNER);
  });

  it('marks the account initialised, because an uninitialised one is refused', () => {
    // A partially-written account is one the token program rejects in a way
    // that looks like a route failure.
    expect(encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 1n })[108]).toBe(1);
  });

  it('leaves delegate, close authority and native rent as COption::None', () => {
    const d = encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 1n });
    expect([...d.subarray(72, 76)]).toEqual([0, 0, 0, 0]);
    expect([...d.subarray(109, 113)]).toEqual([0, 0, 0, 0]);
    expect([...d.subarray(129, 133)]).toEqual([0, 0, 0, 0]);
  });

  it('refuses a pubkey that is not 32 bytes rather than padding it', () => {
    expect(() => encodeTokenAccount({ mint: 'abc', owner: OWNER, amount: 1n })).toThrow(TokenAccountEncodeError);
  });
});

describe('P4 — Token-2022 extensions', () => {
  it('appends the account-type byte so a mint can never be mistaken for it', () => {
    const d = encodeTokenAccount({ mint: MINT, owner: OWNER, amount: 5n, extensions: [{ kind: 'immutable_owner' }] });
    expect(d.length).toBeGreaterThan(TOKEN_ACCOUNT_LEN);
    // 2 is Account. 1 is Mint, and reading one as the other is the defect that
    // produced phantom balances owned by addresses that do not exist.
    expect(d[TOKEN_ACCOUNT_LEN]).toBe(2);
  });

  it('carries a transfer-fee amount as a real TLV', () => {
    const d = encodeTokenAccount({
      mint: MINT,
      owner: OWNER,
      amount: 5n,
      extensions: [{ kind: 'transfer_fee_amount', withheldAmount: 1234n }],
    });
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    expect(view.getUint16(TOKEN_ACCOUNT_LEN + 1, true)).toBe(1);
    expect(view.getUint16(TOKEN_ACCOUNT_LEN + 3, true)).toBe(8);
    expect(view.getBigUint64(TOKEN_ACCOUNT_LEN + 5, true)).toBe(1234n);
  });

  it('keeps the amount exact regardless of extensions', () => {
    const huge = 1_000_000_000_000_000_000n;
    const d = encodeTokenAccount({
      mint: MINT,
      owner: OWNER,
      amount: huge,
      extensions: [{ kind: 'immutable_owner' }, { kind: 'transfer_fee_amount', withheldAmount: 0n }],
    });
    expect(decodeTokenAccountAmount(d)).toBe(huge);
  });
});

describe('P4 — rent is derived, not assumed', () => {
  it('a 165-byte account matches the known mainnet minimum', () => {
    expect(rentExemptLamports(TOKEN_ACCOUNT_LEN)).toBe(2_039_280n);
  });

  it('an extended account costs more, so it is not written under-funded', () => {
    // The 165-byte constant would leave a Token-2022 account below the
    // exemption threshold, where the runtime may collect rent from it.
    expect(rentExemptLamports(TOKEN_ACCOUNT_LEN + 16)).toBeGreaterThan(rentExemptLamports(TOKEN_ACCOUNT_LEN));
  });
});
