import { describe, it, expect } from 'vitest';
import {
  vaultAmounts,
  poolEventFrom,
  assignOrderInSlot,
  fetchInterveningEvents,
} from '../../packages/pipeline/src/event-source.js';
import { replayPlan, planIsUsable } from '../../packages/pipeline/src/event-replay.js';
import type { LandedTransaction, SolanaRpc } from '../../packages/solana/src/rpc.js';

/**
 * Item 49 — reading the intervening events off a provider.
 *
 * `preTokenBalances`/`postTokenBalances` OMIT accounts whose balance did not
 * change, which makes "absent" ambiguous in exactly the way that inverts a
 * trade's direction if read carelessly.
 */

const BASE = 'BaseVault';
const QUOTE = 'QuoteVault';

function landed(o: Partial<LandedTransaction> & { signature: string }): LandedTransaction {
  return {
    slot: 100,
    blockTime: 0,
    failed: false,
    feeLamports: 5_000n,
    accountKeys: [BASE, QUOTE],
    preTokenBalances: [],
    postTokenBalances: [],
    preBalances: [],
    postBalances: [],
    logMessages: [],
    ...o,
  };
}

const bal = (accountIndex: number, amount: bigint) => ({ accountIndex, mint: 'M', owner: null, amount });

describe('49 — the vault balance arrays, read exactly', () => {
  it('reads a plain change on both sides', () => {
    const tx = landed({
      signature: 'a',
      preTokenBalances: [bal(0, 100n), bal(1, 50n)],
      postTokenBalances: [bal(0, 90n), bal(1, 60n)],
    });
    expect(vaultAmounts(tx, BASE)).toEqual({ pre: 100n, post: 90n });
    expect(vaultAmounts(tx, QUOTE)).toEqual({ pre: 50n, post: 60n });
  });

  it('reads absent-on-one-side as a change from or to zero', () => {
    // The chain omits the side that was zero. Reading the absence as "no data"
    // would lose a real move; reading BOTH absences as zero would invent one.
    const tx = landed({ signature: 'b', preTokenBalances: [], postTokenBalances: [bal(0, 90n)] });
    expect(vaultAmounts(tx, BASE)).toEqual({ pre: 0n, post: 90n });
  });

  it('reads absent-on-both as no change, not as unknown', () => {
    const tx = landed({ signature: 'c' });
    expect(vaultAmounts(tx, BASE)).toEqual({ pre: 0n, post: 0n });
  });

  it('reports UNKNOWN when the vault is not in the transaction at all', () => {
    // Not "the balance did not move" — the listing returned a transaction that
    // does not concern this pool, and calling that a no-op event would be a
    // claim about a pool it never touched.
    const tx = landed({ signature: 'd', accountKeys: ['Other'] });
    expect(vaultAmounts(tx, BASE)).toEqual({ pre: null, post: null });
  });

  it('builds an event whose slot comes from the LISTING, not the body', () => {
    // The ordering was computed from the listing's slots. Taking the slot from
    // the transaction body would let the two disagree and reorder the replay
    // against the sequence that was validated.
    const tx = landed({
      signature: 'e',
      slot: 999,
      preTokenBalances: [bal(0, 100n), bal(1, 50n)],
      postTokenBalances: [bal(0, 90n), bal(1, 60n)],
    });
    const ev = poolEventFrom(tx, { baseVault: BASE, quoteVault: QUOTE, orderInSlot: 3, slot: 100 });
    expect(ev).toEqual({
      signature: 'e',
      slot: 100,
      orderInSlot: 3,
      baseVaultDeltaAtoms: -10n,
      quoteVaultDeltaLamports: 10n,
    });
  });
});

describe('49 — intra-block position from a newest-first listing', () => {
  it('reverses to block order and numbers within each slot', () => {
    const out = assignOrderInSlot([
      { signature: 'newest', slot: 6 },
      { signature: 'mid2', slot: 5 },
      { signature: 'mid1', slot: 5 },
      { signature: 'oldest', slot: 4 },
    ]);
    expect(out).toEqual([
      { signature: 'oldest', slot: 4, orderInSlot: 0 },
      { signature: 'mid1', slot: 5, orderInSlot: 0 },
      { signature: 'mid2', slot: 5, orderInSlot: 1 },
      { signature: 'newest', slot: 6, orderInSlot: 0 },
    ]);
  });

  it('gives distinct positions within one slot, so nothing is ambiguous', () => {
    const out = assignOrderInSlot([
      { signature: 'c', slot: 5 },
      { signature: 'b', slot: 5 },
      { signature: 'a', slot: 5 },
    ]);
    expect(out.map((o) => o.orderInSlot)).toEqual([0, 1, 2]);
    expect(planIsUsable(replayPlan({
      window: { entrySlot: 1, exitSlot: 9, listedFromSlot: 1, listedToSlot: 9, truncated: false },
      events: out.map((o) => ({
        signature: o.signature,
        slot: o.slot as number,
        orderInSlot: o.orderInSlot,
        baseVaultDeltaAtoms: -1n,
        quoteVaultDeltaLamports: 1n,
      })),
    }))).toBe(true);
  });
});

/** A provider that serves a fixed listing and a fixed transaction map. */
function fakeRpc(p: {
  pages: { signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[][];
  txs: Record<string, LandedTransaction | null>;
}): { rpc: SolanaRpc; pagesServed: () => number } {
  let served = 0;
  const rpc = {
    async getSignaturesForAddress() {
      const page = p.pages[served] ?? [];
      served += 1;
      return page;
    },
    async getTransactionWithMeta(sig: string) {
      return p.txs[sig] ?? null;
    },
  } as unknown as SolanaRpc;
  return { rpc, pagesServed: () => served };
}

const sig = (signature: string, slot: number, failed: boolean | null = false) => ({
  signature,
  blockTime: 0,
  slot,
  failed,
});

describe('49 — the fetch names its own limits', () => {
  it('stops paging once it reaches back past the entry, and is not truncated', async () => {
    const { rpc, pagesServed } = fakeRpc({
      pages: [[sig('t2', 150), sig('t1', 90)]],
      txs: {
        t2: landed({
          signature: 't2',
          slot: 150,
          preTokenBalances: [bal(0, 100n), bal(1, 50n)],
          postTokenBalances: [bal(0, 90n), bal(1, 60n)],
        }),
      },
    });
    const listing = await fetchInterveningEvents(rpc, {
      baseVault: BASE,
      quoteVault: QUOTE,
      entrySlot: 100,
      exitSlot: 200,
      pageSize: 2,
      maxPages: 5,
    });
    expect(listing.truncated).toBe(false);
    expect(pagesServed()).toBe(1);
    // Only the in-window transaction became an event.
    expect(listing.events.map((e) => e.signature)).toEqual(['t2']);
    expect(listing.listedFromSlot).toBe(90);
    expect(listing.listedToSlot).toBe(150);
  });

  it('marks TRUNCATED when the page budget runs out before the entry', async () => {
    // A bounded fetch that quietly returned a partial list would be a replay
    // with a hole in it, which is worse than no replay at all.
    const { rpc } = fakeRpc({
      pages: [
        [sig('c', 180), sig('b', 170)],
        [sig('b2', 165), sig('a', 160)],
      ],
      txs: {},
    });
    const listing = await fetchInterveningEvents(rpc, {
      baseVault: BASE,
      quoteVault: QUOTE,
      entrySlot: 100,
      exitSlot: 200,
      pageSize: 2,
      maxPages: 2,
    });
    expect(listing.truncated).toBe(true);
    const plan = replayPlan({
      window: {
        entrySlot: 100,
        exitSlot: 200,
        listedFromSlot: listing.listedFromSlot,
        listedToSlot: listing.listedToSlot,
        truncated: listing.truncated,
      },
      events: listing.events,
    });
    expect(planIsUsable(plan)).toBe(false);
  });

  it('excludes failed transactions and COUNTS them', async () => {
    const { rpc } = fakeRpc({
      pages: [[sig('ok', 150), sig('bad', 140, true)]],
      txs: {
        ok: landed({
          signature: 'ok',
          slot: 150,
          preTokenBalances: [bal(0, 100n), bal(1, 50n)],
          postTokenBalances: [bal(0, 90n), bal(1, 60n)],
        }),
      },
    });
    const listing = await fetchInterveningEvents(rpc, {
      baseVault: BASE,
      quoteVault: QUOTE,
      entrySlot: 100,
      exitSlot: 200,
      pageSize: 10,
    });
    expect(listing.failedExcluded).toBe(1);
    expect(listing.events.map((e) => e.signature)).toEqual(['ok']);
  });

  it('turns an UNREADABLE transaction into a refusal, not into silence', async () => {
    // The whole trajectory is refused. A transaction we could not read is a
    // hole, and replaying around it produces a pool at the wrong reserves.
    const { rpc } = fakeRpc({ pages: [[sig('gone', 150)]], txs: { gone: null } });
    const listing = await fetchInterveningEvents(rpc, {
      baseVault: BASE,
      quoteVault: QUOTE,
      entrySlot: 100,
      exitSlot: 200,
      pageSize: 10,
    });
    expect(listing.unreadable).toEqual(['gone']);
    const plan = replayPlan({
      window: {
        entrySlot: 100,
        exitSlot: 200,
        listedFromSlot: listing.listedFromSlot,
        listedToSlot: listing.listedToSlot,
        truncated: listing.truncated,
      },
      events: listing.events,
    });
    expect(plan.refusals.map((r) => r.code)).toContain('EVENT_DELTA_UNOBSERVED');
  });

  it('does not treat an unknown err as a landed trade', async () => {
    // `failed: null` is "the provider did not say". It is kept as a candidate
    // and its deltas decide — never dropped as if we knew it failed.
    const { rpc } = fakeRpc({
      pages: [[sig('maybe', 150, null)]],
      txs: {
        maybe: landed({
          signature: 'maybe',
          slot: 150,
          preTokenBalances: [bal(0, 100n), bal(1, 50n)],
          postTokenBalances: [bal(0, 90n), bal(1, 60n)],
        }),
      },
    });
    const listing = await fetchInterveningEvents(rpc, {
      baseVault: BASE,
      quoteVault: QUOTE,
      entrySlot: 100,
      exitSlot: 200,
      pageSize: 10,
    });
    expect(listing.failedExcluded).toBe(0);
    expect(listing.events).toHaveLength(1);
  });
});
