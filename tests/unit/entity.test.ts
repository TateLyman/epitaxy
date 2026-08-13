import { describe, it, expect } from 'vitest';
import { cluster, concentration, netSoldByCluster, type EntityLink, type Holder } from '../../packages/intelligence/src/entity.js';
import { mintFacts, disagreements } from '../../packages/intelligence/src/mintfacts.js';
import { decodeMint } from '../../packages/solana/src/mint.js';

/**
 * §15 — entities, and the mint facts the chain states rather than a provider.
 */

// Named ...PROGRAM rather than TOKEN, because `const TOKEN = '...'` reads as a
// credential assignment to the secret scanner. These are public program ids and
// the right fix is precise naming, not an exception in the scanner.
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const h = (address: string, amount: bigint, historyKnown = true): Holder => ({ address, amount, historyKnown });
const link = (a: string, b: string, kind: EntityLink['kind']): EntityLink => ({ a, b, kind, evidence: 'test' });

describe('clustering', () => {
  it('joins wallets funded from one source', () => {
    const c = cluster(
      [h('A', 10n), h('B', 10n), h('C', 5n)],
      [link('A', 'B', 'COMMON_FUNDER')],
    );
    expect(c[0]?.members).toEqual(['A', 'B']);
    expect(c[0]?.amount).toBe(20n);
  });

  it('is transitive, because the question is how much can hit the market at once', () => {
    // A and B share a funder; B and C bought in one transaction. All three can
    // sell together, so all three are one actor for this purpose.
    const c = cluster(
      [h('A', 10n), h('B', 10n), h('C', 10n)],
      [link('A', 'B', 'COMMON_FUNDER'), link('B', 'C', 'SAME_TRANSACTION')],
    );
    expect(c).toHaveLength(1);
    expect(c[0]?.members).toEqual(['A', 'B', 'C']);
    expect(c[0]?.kinds).toEqual(['COMMON_FUNDER', 'SAME_TRANSACTION']);
  });

  it('ignores a link naming an address we do not hold', () => {
    // Somebody else's graph is not evidence about this holder set.
    const c = cluster([h('A', 10n), h('B', 10n)], [link('A', 'Z', 'DIRECT_TRANSFER')]);
    expect(c).toHaveLength(2);
  });

  it('leaves unlinked holders alone', () => {
    expect(cluster([h('A', 1n), h('B', 1n)], [])).toHaveLength(2);
  });
});

describe('concentration over entities versus addresses', () => {
  it('exposes a launch built to look decentralised', () => {
    // Ten wallets at 7% each looks like broad distribution. One funder filled
    // them all, so it is one actor holding 70%.
    const holders = Array.from({ length: 10 }, (_, i) => h(`w${i}`, 70n));
    holders.push(h('public', 300n));
    const links = Array.from({ length: 9 }, (_, i) => link('w0', `w${i + 1}`, 'COMMON_FUNDER'));

    const r = concentration(holders, links);
    // By address the largest single holder is the honest public one.
    expect(r.topAddressBps[1]).toBe(3_000);
    // By entity the cluster is far larger, and that is the number that predicts
    // a dump.
    expect(r.topEntityBps[1]).toBe(7_000);
    expect(r.entityCount).toBe(2);
    expect(r.addressCount).toBe(11);
  });

  it('rounds concentration UP, because understating it lets a trade through', () => {
    // 1 of 3 is 33.33%, reported as 3,334 bps.
    expect(concentration([h('A', 1n), h('B', 1n), h('C', 1n)], []).topAddressBps[1]).toBe(3_334);
  });

  it('refuses to call the entity figure trustworthy when too many holders are unexamined', () => {
    const holders = [h('A', 1n), h('B', 1n, false), h('C', 1n, false), h('D', 1n)];
    const r = concentration(holders, []);
    expect(r.unknownHistoryCount).toBe(2);
    expect(r.trustworthy).toBe(false);
    // The point: it is a DIFFERENT number, not a better one.
    expect(r.detail).toContain('not a better one');
  });

  it('is trustworthy when nearly every holder was examined', () => {
    const holders = [h('A', 1n), h('B', 1n), h('C', 1n), h('D', 1n, false)];
    expect(concentration(holders, []).trustworthy).toBe(true);
  });
});

describe('netSoldByCluster', () => {
  it('says when the flows were not observed rather than reporting zero', () => {
    const c = cluster([h('A', 1n), h('B', 1n)], [link('A', 'B', 'COMMON_FUNDER')])[0];
    const flows = new Map([['A', { bought: 10n, sold: 4n }]]);
    const r = netSoldByCluster(c!, flows);
    // A cluster that has not been watched has not been shown to be holding.
    expect(r.observed).toBe(false);
  });

  it('nets buying against selling across the whole cluster', () => {
    const c = cluster([h('A', 1n), h('B', 1n)], [link('A', 'B', 'COMMON_FUNDER')])[0];
    const flows = new Map([
      ['A', { bought: 10n, sold: 40n }],
      ['B', { bought: 5n, sold: 0n }],
    ]);
    const r = netSoldByCluster(c!, flows);
    expect(r.observed).toBe(true);
    expect(r.netSold).toBe(25n);
  });
});

describe('mint facts come from the chain, not a provider', () => {
  function mintBytes(opts: { mintAuthority?: boolean; freezeAuthority?: boolean } = {}): Uint8Array {
    const b = Buffer.alloc(82);
    b.writeUInt32LE(opts.mintAuthority === true ? 1 : 0, 0);
    b.writeBigUInt64LE(1_000n, 36);
    b[44] = 9;
    b[45] = 1;
    b.writeUInt32LE(opts.freezeAuthority === true ? 1 : 0, 46);
    return new Uint8Array(b);
  }

  it('reads a clean mint as safe', () => {
    const f = mintFacts(decodeMint(mintBytes(), TOKEN_PROGRAM));
    expect(f.mintAuthority).toBe('SAFE');
    expect(f.freezeAuthority).toBe('SAFE');
    expect(f.overall).toBe('SAFE');
  });

  it('reads a live mint authority as hostile, with a reason', () => {
    const f = mintFacts(decodeMint(mintBytes({ mintAuthority: true }), TOKEN_PROGRAM));
    expect(f.mintAuthority).toBe('HOSTILE');
    expect(f.overall).toBe('HOSTILE');
    expect(f.reasons.join(' ')).toContain('supply can be inflated');
  });

  it('treats an unread mint as UNKNOWN, never as clean', () => {
    // This is the direction errors travel, and the whole reason for three
    // states instead of two.
    const f = mintFacts(null);
    expect(f.overall).toBe('UNKNOWN');
    expect(f.mintAuthority).toBe('UNKNOWN');
    expect(f.reasons.join(' ')).toContain('was not read');
  });

  it('records where the provider disagrees with the chain', () => {
    const f = mintFacts(decodeMint(mintBytes({ freezeAuthority: true }), TOKEN_PROGRAM));
    const d = disagreements(f, { mintAuthorityDisabled: true, freezeAuthorityDisabled: true });
    expect(d).toHaveLength(1);
    expect(d[0]?.field).toBe('freezeAuthority');
    expect(d[0]?.providerSaid).toBe('disabled');
    expect(d[0]?.chainSays).toBe('live');
  });

  it('does not report a disagreement when the chain is unknown', () => {
    // We cannot contradict the provider with a fact we do not have.
    expect(disagreements(mintFacts(null), { mintAuthorityDisabled: true })).toEqual([]);
  });

  it('never grades a mint with an unknown extension, because it does not decode at all', () => {
    // decodeMint THROWS on an extension newer than itself rather than returning
    // one. That is stronger than grading it: there is no decoded mint to grade,
    // so the caller gets UNKNOWN with the decoder's own reason.
    const b = Buffer.alloc(165 + 1 + 4);
    b[45] = 1;
    b[165] = 1;
    b.writeUInt16LE(9_999, 166);
    b.writeUInt16LE(0, 168);
    expect(() => decodeMint(new Uint8Array(b), TOKEN_2022_PROGRAM)).toThrow(/unknown|newer/i);

    let f;
    try {
      f = mintFacts(decodeMint(new Uint8Array(b), TOKEN_2022_PROGRAM));
    } catch (e) {
      f = mintFacts(null, (e as Error).message);
    }
    expect(f.overall).toBe('UNKNOWN');
    expect(f.decodeFailure).not.toBeNull();
    expect(f.reasons.join(' ')).toContain('did not decode');
  });
});
