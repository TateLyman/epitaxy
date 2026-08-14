import { describe, it, expect } from 'vitest';
import { buildEntityLinks, entityConcentrationFrom, type HistorySource } from '../../packages/intelligence/src/entity-links.js';

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
    expect(r.holders[0]?.historyKnown).toBe(false);
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
