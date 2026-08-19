/**
 * P3 — `MIGRATION_MICROSTRUCTURE_V1`.
 *
 * The audited head computed no pre-entry signal at all: six flow fields were
 * literal `null`, so `SURVIVOR_FLOW_CONTINUATION_V1` rejected every candidate
 * for want of inputs and `HARD_GATES_RANDOM` was the only arm that could
 * enter. The tournament was correctly wired and economically empty.
 *
 * This module is the first real information source. It reads the ONE body of
 * evidence about a migrated memecoin that is both cheap and closed:
 *
 *     the bonding-curve history from creation to the migration signature.
 *
 * Closed is the operative word. Once a token migrates, no transaction can be
 * added to its bonding curve, so this history is immutable, fetchable exactly
 * once, cacheable forever, and — most importantly — IMPOSSIBLE to contaminate
 * with the future by accident. A feature computed here cannot drift as the
 * post-migration price moves, which is the failure mode that makes most
 * memecoin features useless.
 *
 * ---
 *
 * WHY THESE FEATURES
 *
 * The choice of families is taken from current published work and the
 * coefficients are deliberately NOT:
 *
 *   - MemeTrans (>40k migrated Solana launches, >200m transactions) finds
 *     on-chain timing, concentration and activity families materially reduce
 *     high-risk-launch losses;
 *   - SolRugDetector finds Solana rug behaviour highly organised, extremely
 *     short-lived, and visible in on-chain state and transaction behaviour;
 *   - Pump.fun graduation work finds structural launch variables beat SOL
 *     locked alone;
 *   - coordinated-wallet research finds persistent cohorts exist but that raw
 *     association with later flow is CONFOUNDED — so a cohort is a risk and
 *     context feature here, never automatically bullish.
 *
 * None of those models is imported. The protocol, the fee schedule, the
 * migration venue and the participant population all changed; a 2024 model
 * declared valid in 2026 is a fabricated result. They chose the FAMILIES. The
 * prospective Epitaxy corpus has to choose the weights, and until it has, the
 * only thing built on top of this is a sparse mechanism-based risk filter.
 *
 * ---
 *
 * UNKNOWN NEVER BECOMES ZERO
 *
 * Every field is `number | null`, and null means "not measured", which is the
 * repository's standing rule about absent provider fields applied to our own
 * measurements. A partially-fetched history that reported `totalBuySol: 0`
 * would be indistinguishable from a token nobody bought, and it would look
 * like the safest launch in the corpus.
 *
 * The incompleteness is always at the OLD end, because the fetch pages
 * BACKWARD from the migration signature. That asymmetry is load-bearing and it
 * is why some features survive an incomplete history and others do not:
 *
 *   - creation-anchored features (time to migration, totals, unique counts)
 *     require COMPLETE coverage and are null otherwise;
 *   - tail-anchored features (the final 30/60/180 seconds) are computable from
 *     an incomplete history, because the tail is the part that is never missing.
 */

import { createHash } from 'node:crypto';

/**
 * v2 — the coverage CLASSIFICATION changed, so the version changed.
 *
 * v1 could report COMPLETE over a history containing no pre-migration trade at
 * all, because it inferred "reached creation" from a short signature page. A
 * closed bonding curve's index can be truncated, so a short page proves only
 * that the INDEX has no more to give. One live mint under v1 was characterised
 * from 296 signatures spanning 25 slots at its own migration, 197 of the newest
 * 200 failed, and every creation-anchored total was written as 0 rather than
 * null.
 *
 * The features are keyed by `(mint, feature_version)` precisely so this does
 * not require deleting anything: the v1 rows remain as the record of what the
 * defective build believed, and no v2 consumer can read them by accident.
 */
export const MICROSTRUCTURE_FEATURE_VERSION = 'migration-microstructure-v2';

export type Coverage = 'COMPLETE' | 'INCOMPLETE';

/**
 * One decoded bonding-curve trade.
 *
 * `eventIndex` is part of the identity because a transaction may carry more
 * than one trade, and collapsing them to one row loses real flow. The pair
 * (signature, eventIndex) is the dedup key everywhere downstream.
 */
export interface PreMigrationTrade {
  readonly signature: string;
  readonly eventIndex: number;
  readonly slot: number;
  /** Milliseconds. Null when the provider omitted blockTime. */
  readonly blockTimeMs: number | null;
  readonly side: 'buy' | 'sell';
  /** Lamports of SOL into (buy) or out of (sell) the curve. */
  readonly quoteLamports: bigint;
  /** Token atoms out of (buy) or into (sell) the curve. */
  readonly baseAtoms: bigint;
  /** The fee payer. Null when the transaction could not be attributed. */
  readonly actor: string | null;
  /**
   * A failed transaction moved no value.
   *
   * Kept in the input rather than filtered by the caller so that "we saw it and
   * it failed" and "we never saw it" stay distinguishable — the first is
   * evidence of attempted activity, the second is missing coverage.
   */
  readonly failed: boolean;
  /** Real SOL held by the curve after this trade, when it could be read. */
  readonly curveRealSolAfterLamports: bigint | null;
}

export interface MicrostructureInput {
  readonly mint: string;
  readonly bondingCurve: string;
  /** The launch creator, when the migration event named one. */
  readonly creator: string | null;
  readonly migrationSignature: string;
  readonly migrationSlot: number;
  /** Migration block time in ms, which anchors every "final N seconds" window. */
  readonly migrationBlockTimeMs: number | null;
  readonly trades: readonly PreMigrationTrade[];
  readonly coverage: Coverage;
  /**
   * The economic entity an address belongs to — common funder, bundle, or the
   * creator's own cluster. Null when the address's history is unknown, which is
   * a THIRD state and never merged into "independent".
   */
  readonly entityOf?: (address: string) => string | null;
  /** Protocol-controlled addresses, when known. Never counted as independent. */
  readonly mayhemAddresses?: ReadonlySet<string>;
  /** The reserve the curve had to reach to migrate, for the 25/50/75% clocks. */
  readonly migrationReserveLamports: bigint | null;
}

/**
 * The feature vector. Every field nullable, and the nulls are the honest part.
 */
export interface MicrostructureFeatures {
  // ---- timing / intensity (creation-anchored: COMPLETE only) ----
  readonly creationToMigrationSeconds: number | null;
  readonly tradesToMigration: number | null;
  readonly tradesPerMinute: number | null;
  readonly medianInterTradeSeconds: number | null;
  readonly p10InterTradeSeconds: number | null;
  readonly p90InterTradeSeconds: number | null;
  /** Coefficient of variation of inter-trade time. High means bursty. */
  readonly burstiness: number | null;
  readonly secondsTo25PctReserve: number | null;
  readonly secondsTo50PctReserve: number | null;
  readonly secondsTo75PctReserve: number | null;

  // ---- flow (creation-anchored: COMPLETE only) ----
  readonly totalBuyLamports: string | null;
  readonly totalSellLamports: string | null;
  readonly netInflowLamports: string | null;
  readonly buyCount: number | null;
  readonly sellCount: number | null;
  readonly buySellVolumeRatio: number | null;
  readonly uniqueBuyers: number | null;
  readonly uniqueSellers: number | null;
  readonly repeatBuyerFraction: number | null;
  readonly walletsFullyExitedBeforeMigration: number | null;

  // ---- flow (tail-anchored: survives INCOMPLETE) ----
  readonly newBuyersFinal30s: number | null;
  readonly newBuyersFinal60s: number | null;
  readonly newBuyersFinal180s: number | null;

  // ---- creator ----
  readonly creatorInitialBuyLamports: string | null;
  readonly creatorTotalBuyLamports: string | null;
  readonly creatorTotalSellLamports: string | null;
  readonly creatorNetLamports: string | null;
  readonly creatorSellFinal30sLamports: string | null;
  readonly creatorSellFinal60sLamports: string | null;
  readonly creatorSellFinal180sLamports: string | null;
  readonly creatorNetTokenAtomsAtMigration: string | null;

  // ---- holder / entity structure ----
  readonly uniqueEntitiesFirst10Buyers: number | null;
  readonly uniqueEntitiesFirst20Buyers: number | null;
  readonly largestFirstBuyerEntityShare: number | null;
  readonly commonFunderConcentration: number | null;
  readonly first10BuyerRetentionAtMigration: number | null;
  readonly first20BuyerRetentionAtMigration: number | null;
  readonly unknownHistoryShare: number | null;
  readonly migrationPathEntityDominance: number | null;

  // ---- path dynamics (tail-anchored: survive INCOMPLETE) ----
  readonly returnFinal30s: number | null;
  readonly returnFinal60s: number | null;
  readonly returnFinal180s: number | null;
  readonly maxRunUp: number | null;
  readonly maxDrawdown: number | null;
  readonly lateAcceleration: number | null;
  readonly lateSellPressure: number | null;
  readonly reserveSlopeFinal180s: number | null;
  readonly realSolInflowSlopeFinal180s: number | null;
}

export interface MicrostructureResult {
  readonly features: MicrostructureFeatures;
  readonly coverage: Coverage;
  /** Which fields are non-null. Drives `pnpm microstructure:coverage`. */
  readonly knownFields: readonly string[];
  readonly unknownFields: readonly string[];
  /** sha256 over the ordered (signature, eventIndex) list actually used. */
  readonly sourceSignaturesHash: string;
  readonly featuresHash: string;
  /** Trades dropped because they were at or after the migration. */
  readonly droppedPostMigration: number;
  readonly droppedDuplicate: number;
  readonly droppedFailed: number;
}

const MEDIAN = 0.5;

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/**
 * Compute the feature vector.
 *
 * Pure. Every exclusion it performs is counted and returned, because a filter
 * whose rejects are not reported cannot be audited — the same principle the
 * repository already applies to screening.
 */
export function computeMicrostructureFeatures(input: MicrostructureInput): MicrostructureResult {
  /**
   * LEAKAGE GATE — the single most important line in this module.
   *
   * A transaction at or after the migration slot is the FUTURE relative to
   * every decision these features inform. The bonding curve is closed at
   * migration, so such a transaction should not exist; if one arrives it is
   * either a provider returning the pool's history instead of the curve's, or
   * a caller passing the wrong address. Both produce features that predict
   * beautifully and mean nothing.
   *
   * Dropped, counted, and asserted against by the mutation test: appending a
   * post-migration transaction to this input may not move any feature.
   */
  const droppedPostMigrationList = input.trades.filter((t) => t.slot >= input.migrationSlot || t.signature === input.migrationSignature);
  const preMigration = input.trades.filter((t) => t.slot < input.migrationSlot && t.signature !== input.migrationSignature);

  // Dedup by (signature, eventIndex). Two swaps in one transaction stay two;
  // the same swap delivered twice becomes one.
  const seen = new Set<string>();
  const deduped: PreMigrationTrade[] = [];
  let droppedDuplicate = 0;
  for (const t of preMigration) {
    const k = `${t.signature}:${t.eventIndex}`;
    if (seen.has(k)) {
      droppedDuplicate++;
      continue;
    }
    seen.add(k);
    deduped.push(t);
  }

  // A failed transaction is observed activity and zero flow.
  const failed = deduped.filter((t) => t.failed);
  const ok = deduped
    .filter((t) => !t.failed)
    .sort((a, b) => (a.slot === b.slot ? a.eventIndex - b.eventIndex : a.slot - b.slot));

  /**
   * COMPLETE also requires that something was decoded.
   *
   * Checked here as well as in the fetcher, because THIS function's output
   * becomes a policy input and it must not depend on a caller having classified
   * coverage correctly. A vector of zeros over an empty history is
   * indistinguishable from a launch nobody traded, and it reads as the safest
   * token in the corpus.
   */
  const complete = input.coverage === 'COMPLETE' && ok.length > 0;
  const entityOf = input.entityOf ?? ((): string | null => null);
  const mayhem = input.mayhemAddresses ?? new Set<string>();

  const buys = ok.filter((t) => t.side === 'buy');
  const sells = ok.filter((t) => t.side === 'sell');

  const sum = (xs: readonly PreMigrationTrade[]): bigint => xs.reduce((a, t) => a + t.quoteLamports, 0n);
  const totalBuy = sum(buys);
  const totalSell = sum(sells);

  // ---- timing ----
  const times = ok.map((t) => t.blockTimeMs).filter((x): x is number => x !== null);
  const firstMs = times.length > 0 ? Math.min(...times) : null;
  const endMs = input.migrationBlockTimeMs ?? (times.length > 0 ? Math.max(...times) : null);

  const creationToMigrationSeconds =
    complete && firstMs !== null && endMs !== null ? Math.max(0, (endMs - firstMs) / 1000) : null;

  const gaps: number[] = [];
  for (let i = 1; i < ok.length; i++) {
    const a = ok[i - 1]?.blockTimeMs;
    const b = ok[i]?.blockTimeMs;
    if (a !== null && a !== undefined && b !== null && b !== undefined && b >= a) gaps.push((b - a) / 1000);
  }
  const sortedGaps = [...gaps].sort((x, y) => x - y);
  const meanGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const sdGap =
    gaps.length > 1 && meanGap !== null
      ? Math.sqrt(gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / (gaps.length - 1))
      : null;

  /**
   * Time to 25/50/75% of the migration reserve.
   *
   * Uses the curve's measured real SOL after each trade rather than a running
   * sum of buys, because a running sum ignores sells and would report a curve
   * reaching 75% that had in fact round-tripped there twice.
   */
  const reserveClock = (fraction: number): number | null => {
    if (!complete || input.migrationReserveLamports === null || firstMs === null) return null;
    const target = (input.migrationReserveLamports * BigInt(Math.round(fraction * 1000))) / 1000n;
    for (const t of ok) {
      if (t.curveRealSolAfterLamports === null || t.blockTimeMs === null) continue;
      if (t.curveRealSolAfterLamports >= target) return Math.max(0, (t.blockTimeMs - firstMs) / 1000);
    }
    return null;
  };

  // ---- buyers ----
  const buyerFirstSeen = new Map<string, number>();
  const buyerCount = new Map<string, number>();
  for (const t of buys) {
    if (t.actor === null) continue;
    if (!buyerFirstSeen.has(t.actor)) buyerFirstSeen.set(t.actor, t.blockTimeMs ?? 0);
    buyerCount.set(t.actor, (buyerCount.get(t.actor) ?? 0) + 1);
  }
  const uniqueBuyers = complete ? buyerFirstSeen.size : null;
  const uniqueSellers = complete ? new Set(sells.map((t) => t.actor).filter((x): x is string => x !== null)).size : null;
  const repeatBuyerFraction =
    complete && buyerFirstSeen.size > 0
      ? [...buyerCount.values()].filter((c) => c > 1).length / buyerFirstSeen.size
      : null;

  /**
   * New buyers in the final N seconds — tail-anchored, so it survives an
   * incomplete history ONLY when the buyer set it is comparing against is also
   * complete. It is not: "new" means "not seen earlier", and an incomplete
   * history cannot know what was seen earlier.
   *
   * So this is COMPLETE-only, despite being a tail window. The window being at
   * the tail is not sufficient; what matters is whether the feature references
   * the missing part of the history, and this one does.
   */
  const newBuyersInFinal = (seconds: number): number | null => {
    if (!complete || endMs === null) return null;
    const cutoff = endMs - seconds * 1000;
    let n = 0;
    for (const [, first] of buyerFirstSeen) if (first >= cutoff) n++;
    return n;
  };

  // ---- creator ----
  const creator = input.creator;
  const creatorCluster = (addr: string | null): boolean => {
    if (addr === null || creator === null) return false;
    if (addr === creator) return true;
    const a = entityOf(addr);
    const c = entityOf(creator);
    return a !== null && c !== null && a === c;
  };
  const creatorBuys = buys.filter((t) => creatorCluster(t.actor));
  const creatorSells = sells.filter((t) => creatorCluster(t.actor));
  const creatorSellIn = (seconds: number): bigint | null => {
    if (endMs === null) return null;
    const cutoff = endMs - seconds * 1000;
    return creatorSells
      .filter((t) => t.blockTimeMs !== null && t.blockTimeMs >= cutoff)
      .reduce((a, t) => a + t.quoteLamports, 0n);
  };
  const creatorNetTokens = creator === null || !complete
    ? null
    : creatorBuys.reduce((a, t) => a + t.baseAtoms, 0n) - creatorSells.reduce((a, t) => a + t.baseAtoms, 0n);

  // ---- entity structure ----
  const orderedBuyers: string[] = [];
  for (const t of buys) {
    if (t.actor !== null && !orderedBuyers.includes(t.actor)) orderedBuyers.push(t.actor);
  }
  const firstN = (n: number): string[] => orderedBuyers.slice(0, n);

  const entitiesAmong = (addrs: readonly string[]): number | null => {
    if (!complete || addrs.length === 0) return null;
    const ids = new Set<string>();
    for (const a of addrs) ids.add(entityOf(a) ?? `self:${a}`);
    return ids.size;
  };

  /**
   * The largest first-buyer entity's share of early buy volume.
   *
   * A single entity behind most of the first twenty buys is the shape that
   * coordinated-wallet research associates with organised launches. It is
   * recorded as RISK CONTEXT, not as a bearish signal in itself — the same
   * research finds the raw association with later flow confounded.
   */
  const largestFirstBuyerEntityShare = ((): number | null => {
    if (!complete) return null;
    const early = buys.filter((t) => t.actor !== null && firstN(20).includes(t.actor));
    const total = sum(early);
    if (total === 0n) return null;
    const byEntity = new Map<string, bigint>();
    for (const t of early) {
      const id = entityOf(t.actor as string) ?? `self:${t.actor}`;
      byEntity.set(id, (byEntity.get(id) ?? 0n) + t.quoteLamports);
    }
    const max = [...byEntity.values()].reduce((a, b) => (b > a ? b : a), 0n);
    return Number((max * 10_000n) / total) / 10_000;
  })();

  const commonFunderConcentration = ((): number | null => {
    if (!complete || orderedBuyers.length === 0) return null;
    const clustered = orderedBuyers.filter((a) => entityOf(a) !== null).length;
    return clustered / orderedBuyers.length;
  })();

  const unknownHistoryShare = ((): number | null => {
    if (orderedBuyers.length === 0) return null;
    // An address whose history could not be read is UNKNOWN — neither
    // clustered nor independent. Reporting the share of them is what stops a
    // low measured concentration from being read as a low true one.
    const unknown = orderedBuyers.filter((a) => entityOf(a) === null && !mayhem.has(a)).length;
    return unknown / orderedBuyers.length;
  })();

  /** Did the first N buyers still hold at migration? Requires a full history. */
  const retention = (n: number): number | null => {
    if (!complete) return null;
    const early = firstN(n);
    if (early.length === 0) return null;
    let held = 0;
    for (const a of early) {
      const bought = buys.filter((t) => t.actor === a).reduce((x, t) => x + t.baseAtoms, 0n);
      const sold = sells.filter((t) => t.actor === a).reduce((x, t) => x + t.baseAtoms, 0n);
      if (bought > sold) held++;
    }
    return held / early.length;
  };

  const walletsFullyExited = ((): number | null => {
    if (!complete) return null;
    let n = 0;
    for (const a of orderedBuyers) {
      const bought = buys.filter((t) => t.actor === a).reduce((x, t) => x + t.baseAtoms, 0n);
      const sold = sells.filter((t) => t.actor === a).reduce((x, t) => x + t.baseAtoms, 0n);
      if (bought > 0n && sold >= bought) n++;
    }
    return n;
  })();

  const migrationPathEntityDominance = ((): number | null => {
    if (!complete || totalBuy === 0n) return null;
    const byEntity = new Map<string, bigint>();
    for (const t of buys) {
      if (t.actor === null) continue;
      const id = entityOf(t.actor) ?? `self:${t.actor}`;
      byEntity.set(id, (byEntity.get(id) ?? 0n) + t.quoteLamports);
    }
    const max = [...byEntity.values()].reduce((a, b) => (b > a ? b : a), 0n);
    return Number((max * 10_000n) / totalBuy) / 10_000;
  })();

  // ---- path dynamics, from the curve's own reserve ----
  const reservePath = ok
    .filter((t) => t.curveRealSolAfterLamports !== null && t.blockTimeMs !== null)
    .map((t) => ({ ms: t.blockTimeMs as number, sol: t.curveRealSolAfterLamports as bigint }));

  const reserveAt = (ms: number): bigint | null => {
    let best: bigint | null = null;
    for (const p of reservePath) if (p.ms <= ms) best = p.sol;
    return best;
  };

  /**
   * Return over the final N seconds, in reserve terms.
   *
   * Deliberately the curve's REAL SOL rather than a provider USD price: the
   * reserve is what the exit is priced against, and a USD quote from a
   * third party is a different number measured at a different instant.
   */
  const returnFinal = (seconds: number): number | null => {
    if (endMs === null || reservePath.length < 2) return null;
    const start = reserveAt(endMs - seconds * 1000);
    const last = reservePath[reservePath.length - 1]?.sol ?? null;
    if (start === null || last === null || start === 0n) return null;
    return Number(((last - start) * 10_000n) / start) / 10_000;
  };

  const maxRunUp = ((): number | null => {
    if (reservePath.length < 2) return null;
    let trough = reservePath[0]?.sol ?? 0n;
    let best = 0;
    for (const p of reservePath) {
      if (p.sol < trough) trough = p.sol;
      if (trough > 0n) {
        const r = Number(((p.sol - trough) * 10_000n) / trough) / 10_000;
        if (r > best) best = r;
      }
    }
    return best;
  })();

  const maxDrawdown = ((): number | null => {
    if (reservePath.length < 2) return null;
    let peak = reservePath[0]?.sol ?? 0n;
    let worst = 0;
    for (const p of reservePath) {
      if (p.sol > peak) peak = p.sol;
      if (peak > 0n) {
        const r = Number(((p.sol - peak) * 10_000n) / peak) / 10_000;
        if (r < worst) worst = r;
      }
    }
    return worst;
  })();

  /** Final-30s trade rate over final-180s trade rate. >1 means accelerating. */
  const lateAcceleration = ((): number | null => {
    if (endMs === null) return null;
    const n30 = ok.filter((t) => t.blockTimeMs !== null && t.blockTimeMs >= endMs - 30_000).length;
    const n180 = ok.filter((t) => t.blockTimeMs !== null && t.blockTimeMs >= endMs - 180_000).length;
    if (n180 === 0) return null;
    return n30 / 30 / (n180 / 180);
  })();

  const lateSellPressure = ((): number | null => {
    if (endMs === null) return null;
    const cutoff = endMs - 60_000;
    const b = buys.filter((t) => t.blockTimeMs !== null && t.blockTimeMs >= cutoff).reduce((a, t) => a + t.quoteLamports, 0n);
    const s = sells.filter((t) => t.blockTimeMs !== null && t.blockTimeMs >= cutoff).reduce((a, t) => a + t.quoteLamports, 0n);
    if (b + s === 0n) return null;
    return Number((s * 10_000n) / (b + s)) / 10_000;
  })();

  /** Lamports per second over the final 180 seconds. */
  const slopeFinal180 = ((): number | null => {
    if (endMs === null) return null;
    const start = reserveAt(endMs - 180_000);
    const last = reservePath[reservePath.length - 1]?.sol ?? null;
    if (start === null || last === null) return null;
    return Number(last - start) / 180;
  })();

  const inflowSlopeFinal180 = ((): number | null => {
    if (endMs === null) return null;
    const cutoff = endMs - 180_000;
    const net = ok
      .filter((t) => t.blockTimeMs !== null && t.blockTimeMs >= cutoff)
      .reduce((a, t) => a + (t.side === 'buy' ? t.quoteLamports : -t.quoteLamports), 0n);
    return Number(net) / 180;
  })();

  const features: MicrostructureFeatures = {
    creationToMigrationSeconds,
    tradesToMigration: complete ? ok.length : null,
    tradesPerMinute:
      complete && creationToMigrationSeconds !== null && creationToMigrationSeconds > 0
        ? ok.length / (creationToMigrationSeconds / 60)
        : null,
    medianInterTradeSeconds: complete ? quantile(sortedGaps, MEDIAN) : null,
    p10InterTradeSeconds: complete ? quantile(sortedGaps, 0.1) : null,
    p90InterTradeSeconds: complete ? quantile(sortedGaps, 0.9) : null,
    burstiness: complete && meanGap !== null && sdGap !== null && meanGap > 0 ? sdGap / meanGap : null,
    secondsTo25PctReserve: reserveClock(0.25),
    secondsTo50PctReserve: reserveClock(0.5),
    secondsTo75PctReserve: reserveClock(0.75),

    totalBuyLamports: complete ? totalBuy.toString() : null,
    totalSellLamports: complete ? totalSell.toString() : null,
    netInflowLamports: complete ? (totalBuy - totalSell).toString() : null,
    buyCount: complete ? buys.length : null,
    sellCount: complete ? sells.length : null,
    buySellVolumeRatio: complete && totalSell > 0n ? Number((totalBuy * 10_000n) / totalSell) / 10_000 : null,
    uniqueBuyers,
    uniqueSellers,
    repeatBuyerFraction,
    walletsFullyExitedBeforeMigration: walletsFullyExited,

    newBuyersFinal30s: newBuyersInFinal(30),
    newBuyersFinal60s: newBuyersInFinal(60),
    newBuyersFinal180s: newBuyersInFinal(180),

    creatorInitialBuyLamports: creator === null || creatorBuys.length === 0 ? null : (creatorBuys[0]?.quoteLamports ?? 0n).toString(),
    creatorTotalBuyLamports: creator === null || !complete ? null : sum(creatorBuys).toString(),
    creatorTotalSellLamports: creator === null || !complete ? null : sum(creatorSells).toString(),
    creatorNetLamports: creator === null || !complete ? null : (sum(creatorSells) - sum(creatorBuys)).toString(),
    creatorSellFinal30sLamports: creator === null ? null : (creatorSellIn(30)?.toString() ?? null),
    creatorSellFinal60sLamports: creator === null ? null : (creatorSellIn(60)?.toString() ?? null),
    creatorSellFinal180sLamports: creator === null ? null : (creatorSellIn(180)?.toString() ?? null),
    creatorNetTokenAtomsAtMigration: creatorNetTokens === null ? null : creatorNetTokens.toString(),

    uniqueEntitiesFirst10Buyers: entitiesAmong(firstN(10)),
    uniqueEntitiesFirst20Buyers: entitiesAmong(firstN(20)),
    largestFirstBuyerEntityShare,
    commonFunderConcentration,
    first10BuyerRetentionAtMigration: retention(10),
    first20BuyerRetentionAtMigration: retention(20),
    unknownHistoryShare,
    migrationPathEntityDominance,

    returnFinal30s: returnFinal(30),
    returnFinal60s: returnFinal(60),
    returnFinal180s: returnFinal(180),
    maxRunUp,
    maxDrawdown,
    lateAcceleration,
    lateSellPressure,
    reserveSlopeFinal180s: slopeFinal180,
    realSolInflowSlopeFinal180s: inflowSlopeFinal180,
  };

  const known: string[] = [];
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(features)) {
    if (v === null) unknown.push(k);
    else known.push(k);
  }

  /**
   * The source hash commits to the exact evidence used.
   *
   * Built from the DEDUPED, PRE-MIGRATION, non-failed set in canonical order,
   * so two runs that saw the same history agree and a run that silently saw
   * less does not. That is what makes "recompute and diff" a real check rather
   * than a comparison of two summaries.
   */
  const sourceSignaturesHash = createHash('sha256')
    .update(ok.map((t) => `${t.signature}:${t.eventIndex}`).join('\n'))
    .digest('hex');

  const featuresHash = createHash('sha256').update(JSON.stringify(features)).digest('hex');

  return {
    features,
    coverage: input.coverage,
    knownFields: known,
    unknownFields: unknown,
    sourceSignaturesHash,
    featuresHash,
    droppedPostMigration: droppedPostMigrationList.length,
    droppedDuplicate,
    droppedFailed: failed.length,
  };
}

/** Field names, for coverage reporting without instantiating a vector. */
export function microstructureFieldNames(): readonly string[] {
  const empty = computeMicrostructureFeatures({
    mint: '',
    bondingCurve: '',
    creator: null,
    migrationSignature: '',
    migrationSlot: 1,
    migrationBlockTimeMs: null,
    trades: [],
    coverage: 'INCOMPLETE',
    migrationReserveLamports: null,
  });
  return Object.keys(empty.features);
}
