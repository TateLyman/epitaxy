import { describe, it, expect } from 'vitest';
import {
  aggregateTokenDeltas,
  deltaFor,
  TokenIdentityMismatch,
} from '../../packages/simulator/src/tokenbalance.js';
import type { ObservedTokenBalance } from '../../packages/simulator/src/protocol.js';

/**
 * P2 — the token-balance identity mismatch, and the eight mutations the
 * directive requires.
 *
 * The defect: the daemon serialised token balances keyed by TOKEN-ACCOUNT
 * PUBKEY; the effect verifier looked them up by `owner:mint`. Two ends of one
 * wire, two meanings for one key, and a lookup that could never match. Every
 * token delta read as unobserved, so a buy that credited its ATA exactly as
 * intended was refused for "output delta is missing" — eleven runtime-
 * successful jobs recorded as economic failures.
 */

const OWNER = 'Owner11111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const bal = (over: Partial<ObservedTokenBalance> = {}): ObservedTokenBalance => ({
  tokenAccount: 'Ata1111111111111111111111111111111111111111',
  owner: OWNER,
  mint: MINT,
  tokenProgram: TOKEN,
  amount: '0',
  ...over,
});

describe('P2.1 — the key is the account, not a string two files must agree about', () => {
  it('finds the delta when the output ATA changes', () => {
    // THE defect, stated directly. The old code looked up `${owner}:${mint}`
    // in a map keyed by ATA pubkey and found nothing, every time.
    const deltas = aggregateTokenDeltas([bal({ amount: '0' })], [bal({ amount: '1000' })]);
    const d = deltaFor(deltas, OWNER, MINT, TOKEN);
    expect(d).not.toBeNull();
    expect(d?.delta).toBe(1000n);
    expect(d?.accounts).toEqual(['Ata1111111111111111111111111111111111111111']);
  });

  it('an unrelated owner does not match', () => {
    const deltas = aggregateTokenDeltas([bal()], [bal({ amount: '1000' })]);
    expect(deltaFor(deltas, 'Someone111111111111111111111111111111111111', MINT, TOKEN)).toBeNull();
  });
});

describe('P2.2 — aggregation is by (owner, mint, tokenProgram)', () => {
  it('groups one owner and mint under one program', () => {
    const deltas = aggregateTokenDeltas([bal({ amount: '500' })], [bal({ amount: '1500' })]);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.owner).toBe(OWNER);
    expect(deltas[0]?.mint).toBe(MINT);
    expect(deltas[0]?.tokenProgram).toBe(TOKEN);
  });
});

describe('P2.3 — two accounts for one mint', () => {
  const a = 'AtaA11111111111111111111111111111111111111';
  const b = 'AtaB11111111111111111111111111111111111111';

  it('sums both when both are observed on both sides', () => {
    const deltas = aggregateTokenDeltas(
      [bal({ tokenAccount: a, amount: '100' }), bal({ tokenAccount: b, amount: '200' })],
      [bal({ tokenAccount: a, amount: '150' }), bal({ tokenAccount: b, amount: '250' })],
    );
    const d = deltaFor(deltas, OWNER, MINT, TOKEN);
    expect(d?.preAtoms).toBe(300n);
    expect(d?.postAtoms).toBe(400n);
    expect(d?.delta).toBe(100n);
    expect(d?.accounts).toEqual([a, b]);
  });

  it('refuses to report a delta when only one of the two was observed after', () => {
    // A partial sum is a smaller number that looks like a complete one.
    const deltas = aggregateTokenDeltas(
      [bal({ tokenAccount: a, amount: '100' }), bal({ tokenAccount: b, amount: '200' })],
      [bal({ tokenAccount: a, amount: '150' })],
    );
    const d = deltaFor(deltas, OWNER, MINT, TOKEN);
    expect(d?.delta).toBeNull();
  });

  it('refuses a duplicate account on one side rather than reconciling it', () => {
    expect(() =>
      aggregateTokenDeltas([bal({ tokenAccount: a }), bal({ tokenAccount: a })], []),
    ).toThrow(TokenIdentityMismatch);
  });
});

describe('P2.4 — a created ATA', () => {
  it('has no pre row and one post row, and its delta is the full credit', () => {
    const deltas = aggregateTokenDeltas([], [bal({ amount: '4200' })]);
    const d = deltaFor(deltas, OWNER, MINT, TOKEN);
    expect(d?.created).toBe(true);
    expect(d?.closed).toBe(false);
    expect(d?.preAtoms).toBeNull();
    // The one case where absence IS a number: an account that did not exist
    // held nothing, and that is zero for the purpose of a delta.
    expect(d?.delta).toBe(4200n);
  });
});

describe('P2.5 — a closed ATA', () => {
  it('has one pre row and no post row, and its delta is the full debit', () => {
    const deltas = aggregateTokenDeltas([bal({ amount: '4200' })], []);
    const d = deltaFor(deltas, OWNER, MINT, TOKEN);
    expect(d?.closed).toBe(true);
    expect(d?.created).toBe(false);
    expect(d?.postAtoms).toBeNull();
    expect(d?.delta).toBe(-4200n);
  });
});

describe('P2.6/7 — legacy Token and Token-2022 never collapse', () => {
  it('keeps one owner and mint under two programs as two rows', () => {
    const deltas = aggregateTokenDeltas(
      [
        bal({ tokenAccount: 'Legacy11111111111111111111111111111111111', tokenProgram: TOKEN, amount: '100' }),
        bal({ tokenAccount: 'T2022111111111111111111111111111111111111', tokenProgram: TOKEN_2022, amount: '900' }),
      ],
      [
        bal({ tokenAccount: 'Legacy11111111111111111111111111111111111', tokenProgram: TOKEN, amount: '150' }),
        bal({ tokenAccount: 'T2022111111111111111111111111111111111111', tokenProgram: TOKEN_2022, amount: '800' }),
      ],
    );
    expect(deltas).toHaveLength(2);
    expect(deltaFor(deltas, OWNER, MINT, TOKEN)?.delta).toBe(50n);
    expect(deltaFor(deltas, OWNER, MINT, TOKEN_2022)?.delta).toBe(-100n);
  });

  it('refuses an ambiguous lookup rather than adding two assets together', () => {
    // Summing them produces a balance in an asset that does not exist.
    const deltas = aggregateTokenDeltas(
      [
        bal({ tokenAccount: 'L1111111111111111111111111111111111111111', tokenProgram: TOKEN }),
        bal({ tokenAccount: 'T1111111111111111111111111111111111111111', tokenProgram: TOKEN_2022 }),
      ],
      [],
    );
    expect(() => deltaFor(deltas, OWNER, MINT)).toThrow(TokenIdentityMismatch);
    expect(() => deltaFor(deltas, OWNER, MINT)).toThrow(/must say which/);
  });

  it('a mint or program that changes between the two sides fails closed', () => {
    expect(() =>
      aggregateTokenDeltas([bal({ mint: MINT })], [bal({ mint: 'Other11111111111111111111111111111111111111' })]),
    ).toThrow(/changed mint/);
    expect(() => aggregateTokenDeltas([bal({ tokenProgram: TOKEN })], [bal({ tokenProgram: TOKEN_2022 })])).toThrow(
      /changed token program/,
    );
    expect(() =>
      aggregateTokenDeltas([bal({ owner: OWNER })], [bal({ owner: 'Other11111111111111111111111111111111111111' })]),
    ).toThrow(/changed owner/);
  });
});

describe('P2.8 — absent is not zero', () => {
  it('an account observed on neither side yields no row at all', () => {
    expect(aggregateTokenDeltas([], [])).toEqual([]);
    expect(deltaFor([], OWNER, MINT, TOKEN)).toBeNull();
  });

  it('a zero balance observed on both sides is a real, known zero delta', () => {
    // Distinct from "unobserved". One says the account holds nothing; the
    // other says nobody looked, and only the first is evidence.
    const deltas = aggregateTokenDeltas([bal({ amount: '0' })], [bal({ amount: '0' })]);
    const d = deltaFor(deltas, OWNER, MINT, TOKEN);
    expect(d?.delta).toBe(0n);
    expect(d?.preAtoms).toBe(0n);
  });

  it('keeps raw atoms exact past 2^53', () => {
    // A nine-decimal memecoin with a billion supply is 10^18 atoms.
    const huge = '9007199254740993';
    const deltas = aggregateTokenDeltas([bal({ amount: '0' })], [bal({ amount: huge })]);
    expect(deltaFor(deltas, OWNER, MINT, TOKEN)?.delta).toBe(9_007_199_254_740_993n);
  });
});
