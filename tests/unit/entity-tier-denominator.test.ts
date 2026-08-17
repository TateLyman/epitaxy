import { describe, it, expect } from 'vitest';
import { measureEntityTier, oldestSignatureOf } from '../../packages/pipeline/src/entity-tier.js';
import { entityAdjustedConcentration } from '../../packages/intelligence/src/risk-facts-order.js';

/**
 * MT047 — the entity gate compares a share of SUPPLY, because that is what its
 * limit means.
 *
 * `admitCandidate` checks two concentration figures against two limits. The raw
 * tier feeds it `held / supply.amount`. The entity tier was feeding it
 * `concentration().topEntityBps[10]`, which is a share of the holders that
 * function was handed — a different quantity, compared against a limit written
 * for the first one.
 *
 * Measured 2026-08-17: the raw share across the corpus runs 11.4% to 47.2% of
 * supply, and the entity figure was arriving at 71.0%, 74.9%, 92.5% and 97.3%.
 * The gate refused every candidate — including a 28.4 SOL pool that passed
 * depth, mint safety, mayhem and cashback, whose only refusal was
 * "entity-adjusted share 71.0% vs limit 50.0%".
 *
 * A gate that refuses 100% of the population it is defined over is measuring
 * its own units, not the risk.
 */

/** Twenty holders, each 1% of supply, none linked. */
function stubRpc(opts: {
  readonly holderAtoms: bigint;
  readonly holders: number;
  readonly supply: bigint;
  /** Wallets sharing one funder, so a cluster actually forms. */
  readonly sharedFunderCount?: number;
}) {
  const accounts = Array.from({ length: opts.holders }, (_, i) => ({
    address: `TokenAccount${i}`,
    amount: opts.holderAtoms,
  }));
  const shared = opts.sharedFunderCount ?? 0;
  return {
    getTokenLargestAccounts: async () => ({ accounts }),
    getTokenSupply: async () => ({ amount: opts.supply, decimals: 6 }),
    getTokenAccountOwners: async (tokenAccounts: readonly string[]) =>
      new Map(
        tokenAccounts.map((t) => [
          t,
          { owner: `Owner${t.replace('TokenAccount', '')}`, systemOwned: true, ownerProgram: null },
        ]),
      ),
    getSignaturesForAddress: async (address: string) => [
      { signature: `sig-${address}`, blockTime: 1, slot: 1, failed: false },
    ],
    getTransactionFeePayer: async (signature: string) => {
      const idx = Number(signature.replace('sig-TokenAccount', ''));
      // The first `shared` wallets were all funded by one payer, so they
      // collapse into a single entity and the entity figure exceeds the address
      // figure — which is the gap the tier exists to find.
      return Number.isFinite(idx) && idx < shared ? 'CommonFunder' : `Funder${idx}`;
    },
  };
}

describe('MT047 — the entity tier reports a share of SUPPLY', () => {
  it('twenty holders at 1% of supply each read as 10%, not as 50% of themselves', async () => {
    const r = await measureEntityTier(
      stubRpc({ holderAtoms: 1_000_000n, holders: 20, supply: 100_000_000n }) as never,
      { mint: 'M', poolBaseVault: null },
    );
    expect(r.refusal).toBeNull();
    // Top 10 ENTITIES of 20 unlinked holders = half of what the examined set
    // holds, and the examined set is 20% of supply.
    expect(r.clusteredShareOfExamined).toBeCloseTo(0.5, 3);
    expect(r.clusteredShare).toBeCloseTo(0.1, 3);
    expect(r.addressShare).toBeCloseTo(0.1, 3);
    // And it is admissible against a 50%-of-supply limit, which the
    // within-holders figure never could be.
    expect(r.clusteredShare).toBeLessThan(0.5);
    expect(r.clusteredShareOfExamined).not.toBeLessThan(0.5);
  });

  it('the GAP between entity and address survives the rebase — it is the point', async () => {
    const linked = await measureEntityTier(
      stubRpc({ holderAtoms: 1_000_000n, holders: 20, supply: 100_000_000n, sharedFunderCount: 8 }) as never,
      { mint: 'M', poolBaseVault: null },
    );
    expect(linked.refusal).toBeNull();
    // Eight wallets collapse into one entity, so the top-10 ENTITY share must
    // exceed the top-10 ADDRESS share on the same denominator.
    expect(linked.entityCount).toBeLessThan(linked.addressCount);
    expect(linked.clusteredShare).toBeGreaterThan(linked.addressShare);
    expect(linked.clusteredShareOfExamined).toBeGreaterThan(linked.addressShareOfExamined);
  });

  it('a zero supply is a refusal, never a share of zero', async () => {
    const r = await measureEntityTier(
      stubRpc({ holderAtoms: 1n, holders: 20, supply: 0n }) as never,
      { mint: 'M', poolBaseVault: null },
    );
    expect(r.refusal).toMatch(/zero supply/);
    // And a refusal must never reach the gate as a measured safe number.
    expect(entityAdjustedConcentration({ histories: r.histories, clusteredShare: r.clusteredShare }).kind).toBe(
      'HISTORY_INCOMPLETE',
    );
  });

  it('an incomplete walk still refuses, whatever the denominator', async () => {
    // A page that comes back FULL has not proved anything is older, so the walk
    // is incomplete and the share is a lower bound rather than a fact.
    const full = Array.from({ length: 1_000 }, (_, i) => ({
      signature: `s${i}`,
      blockTime: 1,
      slot: 1,
      failed: false,
    }));
    const o = await oldestSignatureOf(
      { getSignaturesForAddress: async () => full } as never,
      'A',
      2,
    );
    expect(o.reachedEarliest).toBe(false);
    expect(o.pagesWalked).toBe(2);
    expect(
      entityAdjustedConcentration({
        histories: [{ reachedEarliestSignature: false, pagesWalked: 2, links: [] }],
        clusteredShare: 0.01,
      }).kind,
    ).toBe('HISTORY_INCOMPLETE');
  });
});
