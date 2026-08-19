/**
 * P4 — TARGETED post-migration flow.
 *
 * The previous build subscribed to the Pump and PumpSwap PROGRAMS, received
 * roughly hundreds of messages per second, and exhausted the endpoint's
 * credits producing data about tokens nobody was considering. That subscription
 * is not coming back.
 *
 * What replaces it is candidate-scoped: one subscription whose `accountInclude`
 * is exactly the pools and vaults currently under observation, or — without
 * Enhanced WebSockets — `getSignaturesForAddress(pool)` at the two entry clocks
 * and nowhere else. Either way the rule is the same: we pay for flow on tokens
 * we are actually deciding about.
 *
 * ---
 *
 * THE FOUR RULES THAT MAKE A BAR MEAN SOMETHING
 *
 * 1. DEDUPE BY (signature, eventIndex). A reconnect replays; a subscription
 *    rebuild replays; a fallback poll overlaps the stream. Every one of those
 *    delivers the same swap twice, and a bar that counts it twice reports flow
 *    that never happened. Two swaps in ONE transaction are still two events —
 *    the index is what keeps them apart.
 *
 * 2. A FAILED TRANSACTION IS NOT FLOW. It is observed activity and zero value.
 *    Counting it inflates exactly the moments that matter most, because failed
 *    transactions cluster where liquidity is thinnest.
 *
 * 3. PROCESSED IS TELEMETRY, CONFIRMED IS EVIDENCE. A `processed` notification
 *    can be rolled back. It may drive a latency metric; it may not make a
 *    feature decision-bearing. Reconciliation to `confirmed` can INVALIDATE an
 *    event that was already counted, and that invalidation has to be able to
 *    remove it.
 *
 * 4. A GAP IS PERSISTED, NOT SMOOTHED. Seconds lost to a reconnect are a fact
 *    about the measurement. A bar overlapping a gap is INCOMPLETE and its
 *    numbers are null — never zero, which would read as "nobody traded".
 */

export const FLOW_BARS = [
  { bar: '0-30s', startMs: 0, endMs: 30_000 },
  { bar: '30-60s', startMs: 30_000, endMs: 60_000 },
  { bar: '60-120s', startMs: 60_000, endMs: 120_000 },
  { bar: '120-180s', startMs: 120_000, endMs: 180_000 },
  { bar: '180-300s', startMs: 180_000, endMs: 300_000 },
] as const;

export type FlowBarName = (typeof FLOW_BARS)[number]['bar'];

/**
 * What an address is, economically.
 *
 * UNKNOWN is a first-class value and is never folded into INDEPENDENT. An
 * address whose funding history could not be read is not known to be
 * independent — treating it as such is how a concentration measure reports the
 * most clustered launches as the cleanest.
 */
export type ActorClass = 'CREATOR' | 'ENTITY' | 'MAYHEM' | 'INDEPENDENT' | 'UNKNOWN';

export interface FlowEvent {
  readonly signature: string;
  readonly eventIndex: number;
  readonly mint: string;
  readonly pool: string;
  readonly slot: number;
  readonly blockTimeMs: number | null;
  readonly side: 'buy' | 'sell';
  readonly quoteLamports: bigint;
  readonly baseAtoms: bigint;
  readonly actor: string | null;
  readonly actorClass: ActorClass;
  readonly failed: boolean;
  readonly commitment: 'processed' | 'confirmed';
}

/** A window during which the stream was not delivering. */
export interface FlowGap {
  readonly startedUtcMs: number;
  readonly endedUtcMs: number | null;
  readonly reason: string;
  readonly generation: number;
}

export type BarCoverage = 'COMPLETE' | 'INCOMPLETE' | 'ABSENT';

export interface FlowBar {
  readonly bar: FlowBarName;
  readonly barStartMs: number;
  readonly barEndMs: number;
  readonly uniqueBuyerEntities: number | null;
  readonly uniqueSellerEntities: number | null;
  readonly buyQuoteLamports: bigint | null;
  readonly sellQuoteLamports: bigint | null;
  readonly netQuoteLamports: bigint | null;
  readonly creatorBuyLamports: bigint | null;
  readonly creatorSellLamports: bigint | null;
  readonly mayhemBuyLamports: bigint | null;
  readonly mayhemSellLamports: bigint | null;
  readonly tradeCount: number | null;
  readonly coverage: BarCoverage;
  readonly coverageReason: string | null;
}

export interface BuildBarsInput {
  readonly mint: string;
  readonly pool: string;
  /** Migration block time. Every bar offset is relative to it. */
  readonly migrationUtcMs: number;
  readonly events: readonly FlowEvent[];
  readonly gaps: readonly FlowGap[];
  /**
   * The instant up to which the stream is known to have been listening. A bar
   * that extends past it has not been observed yet and is ABSENT rather than
   * empty.
   */
  readonly observedUntilUtcMs: number;
  /** Confirmed-only by default. Processed events are telemetry. */
  readonly requireConfirmed?: boolean;
}

export interface BuildBarsResult {
  readonly bars: readonly FlowBar[];
  readonly acceptedEvents: number;
  readonly droppedDuplicate: number;
  readonly droppedFailed: number;
  readonly droppedUnconfirmed: number;
  readonly droppedOutOfWindow: number;
}

export function buildFlowBars(input: BuildBarsInput): BuildBarsResult {
  const requireConfirmed = input.requireConfirmed ?? true;

  const seen = new Set<string>();
  const accepted: FlowEvent[] = [];
  let droppedDuplicate = 0;
  let droppedFailed = 0;
  let droppedUnconfirmed = 0;
  let droppedOutOfWindow = 0;

  for (const e of input.events) {
    if (e.mint !== input.mint || e.pool !== input.pool) {
      // A targeted stream that delivered someone else's transaction is a
      // subscription defect, and silently including it would reintroduce the
      // firehose one address at a time.
      droppedOutOfWindow++;
      continue;
    }
    const key = `${e.signature}:${e.eventIndex}`;
    if (seen.has(key)) {
      droppedDuplicate++;
      continue;
    }
    seen.add(key);

    if (e.failed) {
      droppedFailed++;
      continue;
    }
    if (requireConfirmed && e.commitment !== 'confirmed') {
      droppedUnconfirmed++;
      continue;
    }
    if (e.blockTimeMs === null) {
      droppedOutOfWindow++;
      continue;
    }
    accepted.push(e);
  }

  const bars = FLOW_BARS.map((spec): FlowBar => {
    const startMs = input.migrationUtcMs + spec.startMs;
    const endMs = input.migrationUtcMs + spec.endMs;

    // Not observed yet. ABSENT is not zero flow.
    if (input.observedUntilUtcMs < endMs) {
      return emptyBar(spec.bar, startMs, endMs, 'ABSENT', 'the observation window had not reached this bar');
    }

    // A gap that touches this bar makes it INCOMPLETE. Any overlap at all:
    // three lost seconds inside a thirty-second bar is a tenth of it missing,
    // and there is no way to know what was in them.
    const overlapping = input.gaps.filter((g) => (g.endedUtcMs ?? Number.POSITIVE_INFINITY) > startMs && g.startedUtcMs < endMs);
    if (overlapping.length > 0) {
      return emptyBar(
        spec.bar,
        startMs,
        endMs,
        'INCOMPLETE',
        `${overlapping.length} stream gap(s) overlap this bar: ${overlapping.map((g) => g.reason).join('; ')}`,
      );
    }

    const inBar = accepted.filter((e) => (e.blockTimeMs as number) >= startMs && (e.blockTimeMs as number) < endMs);

    /**
     * Entities, not wallets.
     *
     * Twenty wallets funded by one address is one buyer wearing twenty hats,
     * and counting it as twenty is precisely the measurement error that makes
     * a coordinated launch look like organic demand. An address whose class is
     * UNKNOWN is counted as its own entity — the conservative reading, since
     * assuming it belongs to a known cluster would understate diversity just
     * as badly in the other direction.
     */
    const entityKey = (e: FlowEvent): string =>
      e.actor === null ? `anon:${e.signature}:${e.eventIndex}` : `${e.actorClass}:${e.actor}`;

    const independent = inBar.filter((e) => e.actorClass !== 'MAYHEM' && e.actorClass !== 'CREATOR');
    const buys = inBar.filter((e) => e.side === 'buy');
    const sells = inBar.filter((e) => e.side === 'sell');
    const sum = (xs: readonly FlowEvent[]): bigint => xs.reduce((a, e) => a + e.quoteLamports, 0n);
    const cls = (c: ActorClass, side: 'buy' | 'sell'): bigint =>
      sum(inBar.filter((e) => e.actorClass === c && e.side === side));

    return {
      bar: spec.bar,
      barStartMs: startMs,
      barEndMs: endMs,
      uniqueBuyerEntities: new Set(independent.filter((e) => e.side === 'buy').map(entityKey)).size,
      uniqueSellerEntities: new Set(independent.filter((e) => e.side === 'sell').map(entityKey)).size,
      buyQuoteLamports: sum(buys),
      sellQuoteLamports: sum(sells),
      netQuoteLamports: sum(buys) - sum(sells),
      creatorBuyLamports: cls('CREATOR', 'buy'),
      creatorSellLamports: cls('CREATOR', 'sell'),
      mayhemBuyLamports: cls('MAYHEM', 'buy'),
      mayhemSellLamports: cls('MAYHEM', 'sell'),
      tradeCount: inBar.length,
      coverage: 'COMPLETE',
      coverageReason: null,
    };
  });

  return {
    bars,
    acceptedEvents: accepted.length,
    droppedDuplicate,
    droppedFailed,
    droppedUnconfirmed,
    droppedOutOfWindow,
  };
}

function emptyBar(
  bar: FlowBarName,
  barStartMs: number,
  barEndMs: number,
  coverage: BarCoverage,
  reason: string,
): FlowBar {
  // Every quantity NULL. This is the whole point of the type being nullable:
  // an unobserved bar and a bar in which nobody traded must not look alike.
  return {
    bar,
    barStartMs,
    barEndMs,
    uniqueBuyerEntities: null,
    uniqueSellerEntities: null,
    buyQuoteLamports: null,
    sellQuoteLamports: null,
    netQuoteLamports: null,
    creatorBuyLamports: null,
    creatorSellLamports: null,
    mayhemBuyLamports: null,
    mayhemSellLamports: null,
    tradeCount: null,
    coverage,
    coverageReason: reason,
  };
}

/**
 * Reconcile a processed event against what confirmation actually said.
 *
 * Returns the events that survive. An event that was delivered at `processed`
 * and does NOT appear in the confirmed set is removed — that is a rollback, and
 * a feature built on it was built on a transaction that did not happen.
 */
export function reconcileToConfirmed(
  processed: readonly FlowEvent[],
  confirmedSignatures: ReadonlySet<string>,
): { kept: readonly FlowEvent[]; invalidated: readonly FlowEvent[] } {
  const kept: FlowEvent[] = [];
  const invalidated: FlowEvent[] = [];
  for (const e of processed) {
    if (e.commitment === 'confirmed' || confirmedSignatures.has(e.signature)) {
      kept.push(e.commitment === 'confirmed' ? e : { ...e, commitment: 'confirmed' });
    } else {
      invalidated.push(e);
    }
  }
  return { kept, invalidated };
}

/**
 * The addresses one targeted subscription should carry.
 *
 * Explicitly EXCLUDES the Pump and PumpSwap program ids. Including a program id
 * is what turned a candidate subscription into the firehose, and it is a single
 * character's difference in a config file, so the exclusion is enforced in code
 * rather than remembered.
 */
export const FORBIDDEN_SUBSCRIPTION_ADDRESSES: readonly string[] = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // pumpswap
];

/** Helius currently accepts up to 50,000 addresses in one `accountInclude`. */
export const MAX_ACCOUNT_INCLUDE = 50_000;

export class ForbiddenSubscriptionAddress extends Error {}

export function buildAccountInclude(
  candidates: readonly { pool: string; baseVault: string | null; quoteVault: string | null }[],
): string[] {
  const out = new Set<string>();
  for (const c of candidates) {
    for (const a of [c.pool, c.baseVault, c.quoteVault]) {
      if (a === null) continue;
      if (FORBIDDEN_SUBSCRIPTION_ADDRESSES.includes(a)) {
        throw new ForbiddenSubscriptionAddress(
          `refusing to subscribe to program ${a}: a program-wide subscription is the firehose that exhausted the endpoint`,
        );
      }
      out.add(a);
    }
  }
  if (out.size > MAX_ACCOUNT_INCLUDE) {
    throw new ForbiddenSubscriptionAddress(
      `${out.size} addresses exceeds the ${MAX_ACCOUNT_INCLUDE} accountInclude bound; drop candidates rather than widening the filter`,
    );
  }
  return [...out];
}
