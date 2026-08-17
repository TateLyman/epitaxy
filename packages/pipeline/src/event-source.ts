import type { SolanaRpc, LandedTransaction } from '../../solana/src/rpc.js';
import type { ObservedPoolEvent, ReplayWindow } from './event-replay.js';

/**
 * Item 49 — reading the intervening events off mainnet.
 *
 * The pure ordering and refusal logic is in `event-replay.ts`. This file is the
 * part that talks to a provider, and it is separate for the usual reason: the
 * rules are testable without a network, and what a provider does or does not
 * return is a fact recorded here rather than a silent gap there.
 *
 * ## Why the QUOTE vault is the listing address
 *
 * `getSignaturesForAddress` lists transactions that referenced one account. The
 * quote vault is referenced by every swap in both directions, so a listing
 * against it is a listing of the pool's trades. The base vault would do equally
 * well; using both and merging would double the request count for the same set.
 *
 * ## What we do NOT do
 *
 * We do not decode the swap instruction. A trade can reach the pool through a
 * router, an aggregator, a CPI from a program that did not exist last week, or
 * an AMM instruction version we have never seen. Enumerating shapes means the
 * replay omits whatever shape is new, and an omitted trade is a reserve change
 * that never happened locally. The vault balances are where the effect lands
 * whatever produced it.
 */

/** A listing that names its own limits, so incompleteness is a value, not a silence. */
export interface EventListing {
  readonly events: readonly ObservedPoolEvent[];
  /** The oldest and newest slots the listing actually reached. */
  readonly listedFromSlot: number | null;
  readonly listedToSlot: number | null;
  /** The provider had more and we stopped. The caller must refuse on this. */
  readonly truncated: boolean;
  /** Transactions that referenced the pool but failed. Excluded, and counted. */
  readonly failedExcluded: number;
  /** Signatures we could not read at all. Never treated as "did not trade". */
  readonly unreadable: readonly string[];
}

/**
 * The token amount a vault held before and after, from the chain's own record.
 *
 * `preTokenBalances`/`postTokenBalances` are indexed by account position and
 * omit accounts whose balance did not change. An ABSENT entry on one side with
 * a present entry on the other is a real change from or to zero; absent on both
 * sides is no change. Reading an absent entry as zero in the first case would
 * invert the direction of the trade.
 */
export function vaultAmounts(
  tx: LandedTransaction,
  vault: string,
): { pre: bigint | null; post: bigint | null } {
  const idx = tx.accountKeys.indexOf(vault);
  // The pool was not in this transaction's account list, so it cannot have been
  // traded against — the listing returned something that does not concern us.
  if (idx < 0) return { pre: null, post: null };
  const pre = tx.preTokenBalances.find((b) => b.accountIndex === idx);
  const post = tx.postTokenBalances.find((b) => b.accountIndex === idx);
  if (pre === undefined && post === undefined) {
    // Present in the account list, absent from both balance arrays: the vault
    // was referenced and its balance did not move.
    return { pre: 0n, post: 0n };
  }
  return { pre: pre?.amount ?? 0n, post: post?.amount ?? 0n };
}

/** One landed transaction's effect on the two vaults. */
export function poolEventFrom(
  tx: LandedTransaction,
  p: { baseVault: string; quoteVault: string; orderInSlot: number; slot: number },
): ObservedPoolEvent {
  const b = vaultAmounts(tx, p.baseVault);
  const q = vaultAmounts(tx, p.quoteVault);
  const delta = (x: { pre: bigint | null; post: bigint | null }): bigint | null =>
    x.pre === null || x.post === null ? null : x.post - x.pre;
  return {
    signature: tx.signature,
    // The LISTING's slot, which is the one the ordering was computed from.
    // Taking it from the transaction body instead would let the two disagree
    // and reorder the replay against the sequence we validated.
    slot: p.slot,
    orderInSlot: p.orderInSlot,
    baseVaultDeltaAtoms: delta(b),
    quoteVaultDeltaLamports: delta(q),
  };
}

/**
 * Assign intra-block positions to a CHRONOLOGICALLY ordered signature list.
 *
 * `getSignaturesForAddress` returns newest-first, and within a slot it walks
 * the block's transactions in reverse index order. Reversing the whole listing
 * therefore recovers block order, including within a slot — which is the only
 * intra-block ordering available without fetching whole blocks.
 *
 * This is a property of how the RPC iterates, not a guarantee in the spec. It
 * is isolated in one function, named, so that a provider which violates it
 * breaks here rather than producing a plausible replay in the wrong order.
 */
export function assignOrderInSlot(
  newestFirst: readonly { signature: string; slot: number | null }[],
): { signature: string; slot: number | null; orderInSlot: number }[] {
  const chronological = [...newestFirst].reverse();
  const seenInSlot = new Map<number, number>();
  return chronological.map((s) => {
    const key = s.slot ?? -1;
    const n = seenInSlot.get(key) ?? 0;
    seenInSlot.set(key, n + 1);
    return { signature: s.signature, slot: s.slot, orderInSlot: n };
  });
}

/**
 * Page back through the pool's trades until the entry slot is reached.
 *
 * `maxPages` bounds the request count. Hitting it sets `truncated`, and the
 * caller refuses — a bounded fetch that quietly returned a partial list would
 * be a replay with a hole in it, which is worse than no replay at all.
 */
export async function fetchInterveningEvents(
  rpc: SolanaRpc,
  p: {
    readonly baseVault: string;
    readonly quoteVault: string;
    readonly entrySlot: number;
    readonly exitSlot: number;
    readonly pageSize?: number;
    readonly maxPages?: number;
  },
): Promise<EventListing> {
  const pageSize = p.pageSize ?? 100;
  const maxPages = p.maxPages ?? 10;

  const listed: { signature: string; slot: number | null; failed: boolean | null }[] = [];
  let before: string | undefined;
  let truncated = true;
  for (let page = 0; page < maxPages; page++) {
    const rows = await rpc.getSignaturesForAddress(p.quoteVault, pageSize, before);
    listed.push(...rows);
    if (rows.length < pageSize) {
      // The provider ran out, so the listing is as complete as the chain is.
      truncated = false;
      break;
    }
    const oldest = rows[rows.length - 1];
    if (oldest === undefined) {
      truncated = false;
      break;
    }
    // Reached back past the entry: everything older is already in the local
    // snapshot, so there is nothing more to fetch.
    if (oldest.slot !== null && oldest.slot <= p.entrySlot) {
      truncated = false;
      break;
    }
    before = oldest.signature;
  }

  // A failed transaction changed no balances, so it is not an event. Counted
  // rather than dropped: "nothing happened" and "we chose not to replay it"
  // are different, and only one of them is safe to be silent about.
  const failedExcluded = listed.filter((s) => s.failed === true).length;
  const candidates = listed.filter((s) => s.failed !== true);

  const positioned = assignOrderInSlot(candidates).filter(
    (s) => s.slot !== null && s.slot > p.entrySlot && s.slot <= p.exitSlot,
  );

  const events: ObservedPoolEvent[] = [];
  const unreadable: string[] = [];
  for (const s of positioned) {
    const slot = s.slot as number; // non-null: the filter above required it
    const tx = await rpc.getTransactionWithMeta(s.signature);
    if (tx === null) {
      // Never "did not trade". A transaction we could not read is a hole, so it
      // enters the list with NULL deltas at its real position — which is what
      // makes `replayPlan` refuse the trajectory instead of replaying around it.
      unreadable.push(s.signature);
      events.push({
        signature: s.signature,
        slot,
        orderInSlot: s.orderInSlot,
        baseVaultDeltaAtoms: null,
        quoteVaultDeltaLamports: null,
      });
      continue;
    }
    events.push(
      poolEventFrom(tx, {
        baseVault: p.baseVault,
        quoteVault: p.quoteVault,
        orderInSlot: s.orderInSlot,
        slot,
      }),
    );
  }

  const slots = listed.map((s) => s.slot).filter((s): s is number => s !== null);
  return {
    events,
    listedFromSlot: slots.length === 0 ? null : Math.min(...slots),
    listedToSlot: slots.length === 0 ? null : Math.max(...slots),
    truncated,
    failedExcluded,
    unreadable,
  };
}

export function windowFrom(listing: EventListing, entrySlot: number, exitSlot: number): ReplayWindow {
  return {
    entrySlot,
    exitSlot,
    listedFromSlot: listing.listedFromSlot,
    listedToSlot: listing.listedToSlot,
    truncated: listing.truncated,
  };
}
