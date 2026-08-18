import { describe, it, expect } from 'vitest';
import {
  buildEntityLinks,
  buildTransactionLinks,
  withExtraLinks,
  entityConcentrationFrom,
  type HistorySource,
  type TransactionSource,
} from '../../packages/intelligence/src/entity-links.js';

/**
 * P11 — the entity links that nothing was building.
 *
 * `entity.ts` clustered holders by union-find over a list of links, and no
 * production caller ever produced a link. Every holder was therefore its own
 * entity and the "entity-adjusted" concentration equalled the address
 * concentration exactly — a number that looked like a second opinion and was
 * the first one restated.
 */

function source(p: {
  first: Record<string, string>;
  payer: Record<string, string | null>;
  throwFor?: string;
}): HistorySource {
  return {
    oldestSignatures: async (address) => {
      if (address === p.throwFor) throw new Error('history unavailable');
      const sig = p.first[address];
      return sig === undefined ? [] : [{ signature: sig, blockTime: 1 }];
    },
    feePayerOf: async (signature) => p.payer[signature] ?? null,
  };
}

const holders = (...xs: [string, bigint][]) => xs.map(([address, amount]) => ({ address, amount }));

describe('P11 — a shared first funder links two wallets', () => {
  it('builds a COMMON_FUNDER link and merges the entities', async () => {
    const r = await buildEntityLinks(
      source({
        first: { A: 'sA', B: 'sB', C: 'sC' },
        payer: { sA: 'FUNDER1', sB: 'FUNDER1', sC: 'OTHER' },
      }),
      holders(['A', 40n], ['B', 40n], ['C', 20n]),
    );
    expect(r.links.length).toBe(1);
    expect(r.links[0]?.kind).toBe('COMMON_FUNDER');
    const reading = entityConcentrationFrom(r);
    expect(reading.addressCount).toBe(3);
    expect(reading.entityCount).toBe(2);
    // A and B are one actor holding 80% of what is examined here.
    expect(reading.topEntityBps[1]).toBeGreaterThan(reading.topAddressBps[1]);
  });

  it('reports the gap, which is the point', async () => {
    // A token that looks decentralised by address and is not by entity.
    const r = await buildEntityLinks(
      source({
        first: { A: 's1', B: 's2', C: 's3', D: 's4', E: 's5' },
        payer: { s1: 'F', s2: 'F', s3: 'F', s4: 'G', s5: 'H' },
      }),
      holders(['A', 20n], ['B', 20n], ['C', 20n], ['D', 20n], ['E', 20n]),
    );
    const reading = entityConcentrationFrom(r);
    expect(reading.topAddressBps[1]).toBe(2_000);
    // A, B and C are one actor holding three fifths of the examined supply.
    expect(reading.topEntityBps[1]).toBe(6_000);
    expect(reading.entityCount).toBe(3);
  });
});

describe('P11 — genericness is a cross-mint fact, not a within-mint share', () => {
  it('does NOT suppress a funder behind most of one mint’s top holders', async () => {
    // The tempting shortcut, and it is backwards here. An exchange funds people
    // who then buy many different tokens, so it sits behind a small fraction of
    // any ONE token's holders. A funder behind all four top wallets of one
    // memecoin is the sniper cluster this measurement exists to find.
    const r = await buildEntityLinks(
      source({
        first: { A: 's1', B: 's2', C: 's3', D: 's4' },
        payer: { s1: 'SNIPER', s2: 'SNIPER', s3: 'SNIPER', s4: 'SNIPER' },
      }),
      holders(['A', 25n], ['B', 25n], ['C', 25n], ['D', 25n]),
    );
    expect(r.links.length).toBe(3);
    expect(entityConcentrationFrom(r).entityCount).toBe(1);
    expect(entityConcentrationFrom(r).topEntityBps[1]).toBe(10_000);
  });

  it('suppresses a funder the CALLER knows is generic', async () => {
    const r = await buildEntityLinks(
      source({
        first: { A: 's1', B: 's2', C: 's3', D: 's4' },
        payer: { s1: 'EXCHANGE', s2: 'EXCHANGE', s3: 'EXCHANGE', s4: 'EXCHANGE' },
      }),
      holders(['A', 25n], ['B', 25n], ['C', 25n], ['D', 25n]),
      { ignoredFunders: new Set(['EXCHANGE']) },
    );
    expect(r.links).toEqual([]);
    expect(entityConcentrationFrom(r).entityCount).toBe(4);
  });

  it('reports how many holders each funder is behind, so the claim is auditable', async () => {
    const r = await buildEntityLinks(
      source({
        first: { A: 's1', B: 's2', C: 's3', D: 's4' },
        payer: { s1: 'PAIR', s2: 'PAIR', s3: 'X', s4: 'Y' },
      }),
      holders(['A', 25n], ['B', 25n], ['C', 25n], ['D', 25n]),
    );
    expect(r.links.length).toBe(1);
    expect(r.notes.join(' ')).toMatch(/first funded 2 of 4 examined holders/);
  });
});

describe('P11 — an unread history is unknown, never independent', () => {
  it('marks a holder whose history threw as history-unknown', async () => {
    const r = await buildEntityLinks(
      source({ first: { A: 's1', B: 's2' }, payer: { s1: 'F', s2: 'F' }, throwFor: 'B' }),
      holders(['A', 50n], ['B', 50n]),
    );
    expect(r.holders.find((h) => h.address === 'B')?.historyKnown).toBe(false);
    // One examined holder cannot pair with anyone.
    expect(r.links).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/history unreadable/);
  });

  it('marks holders beyond the examined window as history-unknown', async () => {
    const r = await buildEntityLinks(
      source({ first: { A: 's1', B: 's2' }, payer: { s1: 'F', s2: 'F' } }),
      holders(['A', 50n], ['B', 40n], ['C', 30n]),
      { maxHolders: 2 },
    );
    expect(r.holders.find((h) => h.address === 'C')?.historyKnown).toBe(false);
    expect(r.notes.join(' ')).toMatch(/beyond the top 2/);
  });

  it('an untrustworthy reading says so rather than looking authoritative', async () => {
    const r = await buildEntityLinks(
      source({ first: {}, payer: {} }),
      holders(['A', 50n], ['B', 30n], ['C', 20n]),
    );
    const reading = entityConcentrationFrom(r);
    expect(reading.unknownHistoryCount).toBe(3);
    expect(reading.trustworthy).toBe(false);
  });

  it('a wallet that funded itself is not linked to itself', async () => {
    const r = await buildEntityLinks(
      source({ first: { A: 's1' }, payer: { s1: 'A' } }),
      holders(['A', 100n]),
    );
    expect(r.links).toEqual([]);
    expect(r.funderOf.has('A')).toBe(false);
    /**
     * READ, and the answer is "nobody else funded it".
     *
     * This asserted `historyKnown === false`, which conflated two different
     * facts: "the RPC told us nothing" and "we read the creation and the payer
     * was the wallet itself". `concentration()` calls a reading untrustworthy
     * once a quarter of holders are unexamined, so under the old rule a token
     * where EVERY holder self-funded — the maximally dispersed case — scored
     * exactly as untrustworthy as one the endpoint refused to answer for.
     *
     * Measured live before the change: 19 of 19 histories reached their
     * earliest signature and `trustworthy` was false on all three mints tried.
     */
    expect(r.holders[0]?.historyKnown).toBe(true);
  });

  it('the system program is never a funder', async () => {
    const r = await buildEntityLinks(
      source({
        first: { A: 's1', B: 's2' },
        payer: { s1: '11111111111111111111111111111111', s2: '11111111111111111111111111111111' },
      }),
      holders(['A', 50n], ['B', 50n]),
    );
    expect(r.links).toEqual([]);
  });
});


/**
 * The three stronger link kinds, from transaction bodies.
 *
 * `COMMON_FUNDER` is the cheap one and the weakest: sharing a first funder is
 * suggestive. These three are progressively harder to explain away, and each
 * costs a whole transaction body to obtain — which is why they are a separate
 * call with a separate source, so a caller with a small budget can decline them
 * and get a smaller claim rather than a wrong one.
 */
function txSource(p: {
  txs: Record<string, { feePayer: string | null; participants: string[] }>;
  transfers?: Record<string, { from: string; to: string }[]>;
  throwFor?: string;
}): TransactionSource {
  return {
    participantsOf: async (sig) => {
      if (sig === p.throwFor) throw new Error('transaction unavailable');
      return p.txs[sig] ?? null;
    },
    transfersIn: async (sig) => p.transfers?.[sig] ?? [],
  };
}

describe('P11 — SAME_TRANSACTION', () => {
  it('links two tracked holders that appear in one transaction', async () => {
    const r = await buildTransactionLinks(
      txSource({ txs: { s1: { feePayer: 'PAYER', participants: ['A', 'B', 'STRANGER'] } } }),
      ['A', 'B'],
      ['s1'],
    );
    const same = r.links.filter((l) => l.kind === 'SAME_TRANSACTION');
    expect(same.length).toBe(1);
    expect([same[0]?.a, same[0]?.b].sort()).toEqual(['A', 'B']);
  });

  it('ignores participants that are not tracked holders', async () => {
    const r = await buildTransactionLinks(
      txSource({ txs: { s1: { feePayer: null, participants: ['A', 'STRANGER'] } } }),
      ['A', 'B'],
      ['s1'],
    );
    expect(r.links).toEqual([]);
  });
});

describe('P11 — SHARED_FEE_PAYER', () => {
  it('links holders whose activity somebody else paid for', async () => {
    const r = await buildTransactionLinks(
      txSource({
        txs: {
          s1: { feePayer: 'SPONSOR', participants: ['A'] },
          s2: { feePayer: 'SPONSOR', participants: ['B'] },
        },
      }),
      ['A', 'B'],
      ['s1', 's2'],
    );
    expect(r.links.filter((l) => l.kind === 'SHARED_FEE_PAYER').length).toBe(1);
  });

  it('a holder paying for its own transaction links nobody', async () => {
    // Self-payment is the normal case and says nothing about anyone else.
    const r = await buildTransactionLinks(
      txSource({
        txs: {
          s1: { feePayer: 'A', participants: ['A'] },
          s2: { feePayer: 'B', participants: ['B'] },
        },
      }),
      ['A', 'B'],
      ['s1', 's2'],
    );
    expect(r.links.filter((l) => l.kind === 'SHARED_FEE_PAYER')).toEqual([]);
  });
});

describe('P11 — DIRECT_TRANSFER', () => {
  it('links a holder that sent value straight to another', async () => {
    const r = await buildTransactionLinks(
      txSource({
        txs: { s1: { feePayer: null, participants: [] } },
        transfers: { s1: [{ from: 'A', to: 'B' }] },
      }),
      ['A', 'B'],
      ['s1'],
    );
    const direct = r.links.filter((l) => l.kind === 'DIRECT_TRANSFER');
    expect(direct.length).toBe(1);
    expect(direct[0]?.evidence).toMatch(/->/);
  });

  it('ignores a transfer to somebody outside the holder set', async () => {
    const r = await buildTransactionLinks(
      txSource({
        txs: { s1: { feePayer: null, participants: [] } },
        transfers: { s1: [{ from: 'A', to: 'OUTSIDER' }] },
      }),
      ['A', 'B'],
      ['s1'],
    );
    expect(r.links).toEqual([]);
  });

  it('never links an address to itself', async () => {
    const r = await buildTransactionLinks(
      txSource({
        txs: { s1: { feePayer: null, participants: [] } },
        transfers: { s1: [{ from: 'A', to: 'A' }] },
      }),
      ['A'],
      ['s1'],
    );
    expect(r.links).toEqual([]);
  });
});

describe('P11 — the transaction pass fails soft and folds in', () => {
  it('records an unreadable transaction and keeps going', async () => {
    const r = await buildTransactionLinks(
      txSource({
        txs: { s2: { feePayer: 'P', participants: ['A', 'B'] } },
        throwFor: 's1',
      }),
      ['A', 'B'],
      ['s1', 's2'],
    );
    expect(r.examined).toBe(1);
    expect(r.notes.join(' ')).toMatch(/unreadable/);
    expect(r.links.length).toBeGreaterThan(0);
  });

  it('fetches nothing the caller did not ask for', async () => {
    // The budget stays with the caller. This examines exactly the signatures
    // it was handed and never goes looking for more.
    let calls = 0;
    const source: TransactionSource = {
      participantsOf: async () => {
        calls += 1;
        return { feePayer: null, participants: [] };
      },
      transfersIn: async () => [],
    };
    await buildTransactionLinks(source, ['A'], ['s1', 's2', 's3']);
    expect(calls).toBe(3);
  });

  it('folds the stronger links into a funder-built result without losing holders', async () => {
    const base = await buildEntityLinks(
      source({ first: { A: 's1', B: 's2' }, payer: { s1: 'F', s2: 'G' } }),
      holders(['A', 60n], ['B', 40n]),
    );
    expect(base.links).toEqual([]);
    const merged = withExtraLinks(base, [
      { a: 'A', b: 'B', kind: 'DIRECT_TRANSFER', evidence: 'A -> B' },
    ]);
    expect(merged.holders.length).toBe(2);
    // One entity now, where the funder pass alone saw two.
    expect(entityConcentrationFrom(merged).entityCount).toBe(1);
    expect(entityConcentrationFrom(base).entityCount).toBe(2);
  });
});
