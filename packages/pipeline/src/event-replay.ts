/**
 * Item 49 / P9 — `FULL_EVENT_REPLAY_TRAJECTORY`.
 *
 * ## What is actually wrong with a later mainnet quote
 *
 * A development entry did not happen on mainnet. The pool it would have moved
 * was never moved, so every later mainnet state is a state in which our entry
 * DOES NOT EXIST. Quoting the exit against that state prices a trajectory that
 * never entered.
 *
 * `BOUNDED_COUNTERFACTUAL_TRAJECTORY` uses the later mainnet state anyway and
 * puts an interval around the error. But the interval is on an approximation,
 * and an approximation's error is only known by comparison with something
 * exact. That exact thing is this module: take the LOCAL post-entry state — the
 * one that contains our buy — and push the intervening mainnet trades through
 * it, in order. The exit is then priced against a pool that contains both our
 * entry and everything that happened after it.
 *
 * ## Why the events are read off the VAULTS, not off the instructions
 *
 * A swap can reach the pool through a router, an aggregator, a CPI from some
 * program that did not exist last week, or a version of the AMM instruction we
 * have never decoded. Enumerating instruction shapes means the replay silently
 * omits whatever shape is new — and an omitted trade is a reserve change that
 * never happened locally, which is the same class of error the replay exists to
 * remove.
 *
 * A pool's two vault token accounts, by contrast, are where the effect lands
 * whatever produced it. So an event here is DEFINED by what it did to the
 * vaults, and its kind is DERIVED from the signs of the two deltas. Anything
 * whose signs do not describe a swap is refused by name rather than skipped.
 *
 * ## Refuse, never skip
 *
 * Every refusal in this file kills the whole replay for that trajectory. That
 * is deliberate. A replay missing one trade is not a slightly worse replay; it
 * is a pool at the wrong reserves for every subsequent event, presented as the
 * exact reference the bounded class is calibrated against. A trajectory with no
 * replay is honest. A replay with a hole in it corrupts the thing it calibrates.
 */

export type PoolEventKind =
  | 'BUY'
  | 'SELL'
  /** Both vaults up. Liquidity arrived; not reproducible as a swap. */
  | 'DEPOSIT'
  /** Both vaults down. Liquidity left; not reproducible as a swap. */
  | 'WITHDRAW'
  /** Neither vault moved. The pool was touched but not traded. */
  | 'NO_POOL_EFFECT'
  /** A delta is missing. Not "zero" — unknown. */
  | 'INDETERMINATE';

export type ReplayRefusal =
  /** A vault delta was not observed, so the event's kind is unknown. */
  | 'EVENT_DELTA_UNOBSERVED'
  /** Liquidity moved. Reproducing it needs a deposit/withdraw the replay cannot build. */
  | 'LIQUIDITY_EVENT_NOT_REPLAYABLE'
  /** Two events share an ordering key, so "in order" has no meaning. */
  | 'EVENT_ORDER_AMBIGUOUS'
  /** The listing does not span entry→exit, so trades are missing by construction. */
  | 'EVENT_LIST_INCOMPLETE'
  /** The provider paginated and the caller did not reach the end. */
  | 'EVENT_LIST_TRUNCATED'
  /** A replayed swap did not commit locally. */
  | 'REPLAY_EVENT_FAILED'
  /** An event's input amount is not positive, so there is no swap to build. */
  | 'EVENT_INPUT_NOT_POSITIVE';

/**
 * One settled mainnet transaction's effect on the pool's two vaults.
 *
 * Deltas are `null` when the provider did not report the balance, which is a
 * fact about the provider and is graded as unknown — never as zero. Zero would
 * classify a trade we failed to observe as a transaction that did not trade.
 */
export interface ObservedPoolEvent {
  readonly signature: string;
  readonly slot: number;
  /**
   * Position within the block, as the provider listed it.
   *
   * Intra-slot order is not recoverable from the slot number, and two trades in
   * one block against one pool compose differently in each order. The provider
   * returns its signature listing in block order; this is that index.
   */
  readonly orderInSlot: number;
  readonly baseVaultDeltaAtoms: bigint | null;
  readonly quoteVaultDeltaLamports: bigint | null;
}

export function classifyPoolEvent(e: ObservedPoolEvent): PoolEventKind {
  const b = e.baseVaultDeltaAtoms;
  const q = e.quoteVaultDeltaLamports;
  if (b === null || q === null) return 'INDETERMINATE';
  if (b === 0n && q === 0n) return 'NO_POOL_EFFECT';
  // Same sign on both sides is liquidity, not a trade. A swap always pays one
  // vault out of the other.
  if (b > 0n && q > 0n) return 'DEPOSIT';
  if (b < 0n && q < 0n) return 'WITHDRAW';
  // One side moved and the other did not. Not a swap, and not a shape we can
  // name — a donation, a fee sweep, or a delta we mis-read.
  if (b === 0n || q === 0n) return 'INDETERMINATE';
  // Quote in, base out: somebody bought the base token.
  return q > 0n ? 'BUY' : 'SELL';
}

/**
 * A single swap to execute locally, with the amount the mainnet trader put IN.
 *
 * The INPUT is replayed, never the output. Mainnet's output came from mainnet's
 * reserves; ours must come from ours, because our entry moved them. Forcing the
 * output would reproduce mainnet's prices and erase the very displacement the
 * replay is measuring.
 */
export interface ReplayStep {
  readonly signature: string;
  readonly slot: number;
  readonly kind: 'BUY' | 'SELL';
  /** Quote lamports in for a BUY; base atoms in for a SELL. Always positive. */
  readonly inputAmount: bigint;
}

export interface ReplayPlan {
  readonly steps: readonly ReplayStep[];
  /** Non-empty means the plan is not usable. Refusals are never partial. */
  readonly refusals: readonly { readonly code: ReplayRefusal; readonly detail: string }[];
  /** Events deliberately carried no step: they did not move the pool. */
  readonly inert: number;
}

/** Chronological, with intra-block order preserved and ties refused. */
export function orderEvents(events: readonly ObservedPoolEvent[]): {
  ordered: readonly ObservedPoolEvent[];
  ambiguous: readonly string[];
} {
  const seen = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const e of events) {
    const key = `${e.slot}:${e.orderInSlot}`;
    const prior = seen.get(key);
    // Two transactions cannot occupy one position in one block. If they claim
    // to, the listing is wrong and "in order" is not something we can honour.
    if (prior !== undefined && prior !== e.signature) ambiguous.push(`${key} claimed by ${prior} and ${e.signature}`);
    else seen.set(key, e.signature);
  }
  const ordered = [...events].sort((a, b) => (a.slot - b.slot) || (a.orderInSlot - b.orderInSlot));
  return { ordered, ambiguous };
}

export interface ReplayWindow {
  /** The slot the local post-entry state corresponds to. */
  readonly entrySlot: number;
  /** The slot the exit is to be priced at. */
  readonly exitSlot: number;
  /**
   * The oldest slot the signature listing reached.
   *
   * If it did not reach back to the entry, trades between the entry and the
   * listing's floor are missing and nothing tells us how many.
   */
  readonly listedFromSlot: number | null;
  readonly listedToSlot: number | null;
  /** The provider had more pages and the caller stopped. */
  readonly truncated: boolean;
}

/**
 * Turn observed events into an ordered list of local swaps, or refuse.
 *
 * Events outside `[entrySlot, exitSlot]` are dropped: the state already
 * contains everything at or before the entry, and anything after the exit is
 * not part of the holding period.
 */
export function replayPlan(p: {
  readonly events: readonly ObservedPoolEvent[];
  readonly window: ReplayWindow;
}): ReplayPlan {
  const refusals: { code: ReplayRefusal; detail: string }[] = [];
  const w = p.window;

  if (w.truncated) {
    refusals.push({ code: 'EVENT_LIST_TRUNCATED', detail: 'the provider had more pages and the caller stopped' });
  }
  // A listing that starts after the entry is missing the trades in between, and
  // the count of what is missing is exactly what we cannot know.
  if (w.listedFromSlot === null || w.listedFromSlot > w.entrySlot) {
    refusals.push({
      code: 'EVENT_LIST_INCOMPLETE',
      detail: `listing reaches back to ${w.listedFromSlot ?? 'nothing'}, entry is at ${w.entrySlot}`,
    });
  }
  /**
   * The FORWARD bound is not a completeness problem, and treating it as one was
   * measured wrong on the first live pool.
   *
   * `getSignaturesForAddress` is queried newest-first with no cursor, so the
   * first page holds the most recent transactions that exist. A newest slot
   * BELOW the exit is therefore the observation that nothing touched the pool
   * in between — a quiet pool, not a gap. Refusing on it rejected a pool whose
   * last trade was 255,341 slots before the entry, which is the one case where
   * the replay is trivially exact: zero events.
   *
   * An EMPTY listing is different. A pool vault was created by a transaction,
   * so a vault with no signatures at all is a provider that answered without
   * answering, and that is refused.
   */
  if (w.listedToSlot === null) {
    refusals.push({
      code: 'EVENT_LIST_INCOMPLETE',
      detail: 'the listing is empty — a pool vault always has at least its own creation',
    });
  }

  const inWindow = p.events.filter((e) => e.slot > w.entrySlot && e.slot <= w.exitSlot);
  const { ordered, ambiguous } = orderEvents(inWindow);
  for (const a of ambiguous) refusals.push({ code: 'EVENT_ORDER_AMBIGUOUS', detail: a });

  const steps: ReplayStep[] = [];
  let inert = 0;
  for (const e of ordered) {
    const kind = classifyPoolEvent(e);
    if (kind === 'NO_POOL_EFFECT') {
      inert += 1;
      continue;
    }
    if (kind === 'INDETERMINATE') {
      refusals.push({ code: 'EVENT_DELTA_UNOBSERVED', detail: `${e.signature} at slot ${e.slot}` });
      continue;
    }
    if (kind === 'DEPOSIT' || kind === 'WITHDRAW') {
      refusals.push({
        code: 'LIQUIDITY_EVENT_NOT_REPLAYABLE',
        detail: `${kind} in ${e.signature} at slot ${e.slot}`,
      });
      continue;
    }
    // The input side, by direction. Non-null here: classify already refused otherwise.
    const input = kind === 'BUY' ? (e.quoteVaultDeltaLamports as bigint) : (e.baseVaultDeltaAtoms as bigint);
    if (input <= 0n) {
      refusals.push({ code: 'EVENT_INPUT_NOT_POSITIVE', detail: `${e.signature} input ${input}` });
      continue;
    }
    steps.push({ signature: e.signature, slot: e.slot, kind, inputAmount: input });
  }

  return { steps, refusals, inert };
}

/**
 * The vault delta the replay measured, so the intervening trades' input is the
 * amount that actually reached the pool.
 *
 * A trader's instruction amount is not the pool's delta: a transfer-fee mint
 * takes its cut in transit, and the router may keep part of the quote. The
 * vault is where the truth is, which is the same reason the events are read
 * from the vaults in the first place.
 */
export function vaultDelta(pre: bigint | null, post: bigint | null): bigint | null {
  if (pre === null || post === null) return null;
  return post - pre;
}

/** Whether a plan may be used. Refusals are all-or-nothing by construction. */
export function planIsUsable(plan: ReplayPlan): boolean {
  return plan.refusals.length === 0;
}

/**
 * The evidence class a trajectory earns from its replay attempt.
 *
 * A failed replay does NOT fall back to the bounded class silently. It falls
 * back with the refusal attached, because "we could not replay this" is the
 * fact that decides whether the bounded number may be believed.
 */
export function replayEvidenceClass(plan: ReplayPlan): {
  readonly klass: 'FULL_EVENT_REPLAY_TRAJECTORY' | 'BOUNDED_COUNTERFACTUAL_TRAJECTORY';
  readonly refusedBecause: readonly ReplayRefusal[];
} {
  if (planIsUsable(plan)) return { klass: 'FULL_EVENT_REPLAY_TRAJECTORY', refusedBecause: [] };
  return {
    klass: 'BOUNDED_COUNTERFACTUAL_TRAJECTORY',
    refusedBecause: [...new Set(plan.refusals.map((r) => r.code))],
  };
}
