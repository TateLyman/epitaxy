/**
 * MT101 — THE FLAGGED-WALLET ENTRY ARM.
 *
 * H1 is the only confirmed, robust, out-of-sample result this programme has
 * produced: wallet performance persists across disjoint windows at +36.74%
 * [+33.57, +40.03] per position on the preregistered cut and +12.67%
 * [+11.38, +14.00] on the robust median cut, monotone across ten deciles over
 * 211,225 wallets and 11.85M holdout positions, positive on 30 of 30 days, and
 * holding at ENTITY level as well as address level.
 *
 * It has never touched the collector. Every trajectory this system has ever
 * opened was selected by token-feature momentum screening — the rule measured
 * at -17.44% mean on 455 own-quote trajectories at 3600s. This module is what
 * it takes to run the confirmed signal as an entry rule instead.
 *
 * ---
 *
 * WHAT THIS FIXES THAT FIVE PHASES COULD NOT
 *
 * Phases C through G measured the copy economics against a Dune reconstruction
 * and every one of them died on censoring: 46% to 97% of positions had no exit
 * price, and the two defensible treatments — drop them, or mark them -100% —
 * disagreed in sign. That is a defect of THAT INSTRUMENT, not of the market.
 * Measured on 362 trajectories over two UTC days, a post-migration PumpSwap
 * pool ends the hour at a median 1.0000 of its entry quote reserve; 0 of 362
 * fall below 0.1x, 2 of 362 below 0.5x, and 0 of 362 suffer a single-step drop
 * above 90%. Pools do not drain inside the hour on this population.
 *
 * So an unpriceable position was one with no TRADE in Dune's tape, not one with
 * no LIQUIDITY. Pricing on our own executable quotes removes the defect
 * structurally rather than modelling around it — there is no censoring
 * treatment to choose, because the AMM quotes whether or not anyone traded.
 *
 * That reserve measurement rests on TWO UTC DAYS, which is two clusters. It is
 * a point estimate and it is the reason this arm exists, not a result this arm
 * may assume.
 *
 * ---
 *
 * WHY K = 1 AND NOT CONFLUENCE
 *
 * H1 confirms skill at the WALLET level. Requiring N distinct flagged wallets
 * in a window is a different and unproven hypothesis, and it is also not
 * reachable on the polling source: sweeping the whole 21,123-wallet top decile
 * at the 8 req/s shared endpoint budget takes 44 minutes. K = 1 tests the thing
 * that is actually confirmed. Confluence gets its own ledger row and its own
 * hold-out, on a streamed source, or not at all.
 *
 * ---
 *
 * THE SOURCE IS NOT THE RULE
 *
 * A polled source and a streamed source differ in detection lag and in how many
 * wallets they can watch. Neither changes what the rule IS, so the rule lives
 * here and the source is an interface. `detectionLagMs` is recorded per event
 * precisely so the two are never pooled without it being visible which is
 * which — and an unmeasured lag is NULL, never zero.
 *
 * Phase C measured the cost of lag directly and it is small: the as-priced
 * return is +23.00% at a 30s lag against +24.45% at 2s. There is no latency
 * race in this signal, which is the measured reason this arm does not need
 * infrastructure the operator has ruled out.
 */

/** The frozen MT101 parameters. Changing any of these is a new ledger row. */
export const MT101 = {
  ledgerRow: 'MT101',
  selectionArm: 'WALLET_FOLLOW',
  /** Concurrent control arm. Both run on one clock so the market draw is shared. */
  baselineArm: 'MOMENTUM_BASELINE',
  watchlistSize: 128,
  /**
   * AMENDED BY MT102, before any market was read.
   *
   * MT101 froze 60,000 ms. That is incompatible with its own 2.2 req/s share
   * once the decode path is costed: `getSignaturesForAddress` returns a
   * signature, a block time, a slot and an error flag but NOT the program, so
   * establishing that an action was a PumpSwap buy costs one `getTransaction`
   * per new signature. 128 signature calls per 60,000 ms is already 2.133 req/s
   * and leaves four calls of decode headroom a sweep. At 90,000 ms the same 128
   * wallets present 1.422 req/s and leave 70.
   */
  sweepIntervalMs: 90_000,
  /** Of the 8 req/s endpoint-wide total enforced by `endpoint-budget.ts`. */
  maxWatchlistRequestsPerSecond: 2.2,
  lagBudgetMs: 120_000,
  confluenceK: 1,
  minFitPositions: 20,
  cut: 'MEDIAN',
  entryProject: 'pumpswap',
  /**
   * AMENDED BY MT109, before any flagged-arm return was read.
   *
   * MT101 froze 3,600,000 ms on a reason about OUR instrument - where the
   * incumbent baseline sits and the longest offset the collector marks - and no
   * reason at all about the wallets being followed. Measured on 34,547 completed
   * wallet round trips from the tape, the treatment decile holds for a MEDIAN OF
   * 103 SECONDS, with 40.1% out under 60s and 96.4% out inside the hour.
   *
   * Holding an hour was therefore not copying a wallet. It was holding what the
   * wallet had already sold.
   *
   * Hold time is a property of the WALLETS, not of our returns, so this is a
   * population-driven amendment and not an outcome-driven one.
   */
  primaryHorizonMs: 120_000,
  /** Unchanged from the incumbent, so the arms compare to each other and to the stored baseline. */
  notionalLamports: 20_000_000n,
} as const;

/**
 * MT104's frozen parameters. Everything it does not name is inherited from
 * MT101 unchanged — the trigger, the lag budget, the notional, the gates, the
 * exit and the horizon are all identical, so that the only thing separating the
 * two experiments is the SOURCE and the WATCHLIST.
 */
export const MT104 = {
  ledgerRow: 'MT104',
  /** Treatment and control, collected concurrently on one clock. */
  treatmentDecile: 1,
  controlDecile: 10,
  treatmentArm: 'DECILE_1_FOLLOW',
  controlArm: 'DECILE_10_FOLLOW',
  /**
   * `logsSubscribe` on pump_amm, free public endpoint.
   *
   * Measured before it was frozen: 472.5 notifications/second sustained over
   * 599 seconds, clean close, ZERO log truncation, and the trader decoded from
   * the `Program data:` line with no `getTransaction` at all.
   */
  source: 'STREAM',
} as const;

export type FlowSourceKind = 'POLL' | 'STREAM';
export type Commitment = 'processed' | 'confirmed' | 'finalized';
export type Side = 'BUY' | 'SELL';

export interface FlaggedWallet {
  readonly address: string;
  readonly rankPosition: number;
  readonly rankStat: number;
  readonly fitPositions: number;
}

/**
 * One observed action of a watched wallet.
 *
 * `mint`/`side` are null exactly when `decodeRefusal` is set. An event we could
 * not read is a fact about our decoder and is stored as one; it is never a fact
 * about the wallet.
 */
export interface WalletFlowEvent {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly wallet: string;
  readonly mint: string | null;
  readonly side: Side | null;
  readonly quoteLamports: bigint | null;
  readonly programId: string | null;
  readonly slot: number | null;
  /** When the wallet acted. Null when the block time could not be read. */
  readonly blockUtcMs: number | null;
  /** When WE saw it. */
  readonly observedUtcMs: number;
  /**
   * `observedUtcMs - blockUtcMs`, the honest cost of the source.
   *
   * NULL when the block time could not be read. An unmeasured lag is not a zero
   * lag, and a source whose unknown lags were stored as zero would report
   * itself faster than it is by exactly the rows it understands least.
   */
  readonly detectionLagMs: number | null;
  readonly source: FlowSourceKind;
  readonly commitment: Commitment;
  readonly txError: boolean;
  readonly decodeRefusal: string | null;
}

export type SignalOutcome =
  | 'FORWARDED'
  | 'REFUSED_STALE'
  | 'REFUSED_NO_POOL'
  | 'REFUSED_DUPLICATE_MINT'
  | 'REFUSED_NOT_BUY'
  | 'REFUSED_WALLET_NOT_FLAGGED'
  | 'REFUSED_TX_FAILED';

export type AgeBasis = 'BLOCK_TIME' | 'OBSERVATION';

export interface SignalDecision {
  readonly outcome: SignalOutcome;
  readonly refusal: string | null;
  readonly mint: string;
  readonly wallet: string;
  readonly walletRank: number;
  readonly kObserved: number;
  readonly signalAgeMs: number;
  readonly ageBasis: AgeBasis;
}

export interface SignalContext {
  readonly watchlist: ReadonlyMap<string, FlaggedWallet>;
  /** Clock at the moment of evaluation. */
  readonly evaluatedUtcMs: number;
  /** Mints this arm has already signalled. One entry per mint, not per event. */
  readonly alreadySignalledMints: ReadonlySet<string>;
  /**
   * Whether a canonical PumpSwap pool exists for the mint.
   *
   * `null` means it could not be established, and that REFUSES. An unread
   * account is not an absent pool, and treating it as one would let a provider
   * outage look like a venue fact.
   */
  readonly poolPresent: boolean | null;
}

/**
 * Detection lag of an event, and which clock it was measured against.
 *
 * The lag budget must be enforced against the wallet's own block time where it
 * is known. Enforcing it against our observation instead measures how promptly
 * we processed what we already had, which is a different quantity and always
 * flatters us. Which clock was used is returned, not assumed.
 */
export function signalAge(
  event: Pick<WalletFlowEvent, 'blockUtcMs' | 'observedUtcMs'>,
  evaluatedUtcMs: number,
): { readonly ageMs: number; readonly basis: AgeBasis } {
  if (event.blockUtcMs !== null) {
    return { ageMs: evaluatedUtcMs - event.blockUtcMs, basis: 'BLOCK_TIME' };
  }
  return { ageMs: evaluatedUtcMs - event.observedUtcMs, basis: 'OBSERVATION' };
}

/**
 * The MT101 trigger, applied to one decoded event.
 *
 * Returns `null` for an event that is not a signal candidate at all — one we
 * could not decode. Those are already stored in `wallet_flow_events` with their
 * refusal, and inventing a signal row for them would double-count a failure of
 * our own decoder as a decision about a market.
 *
 * CHECK ORDER, which is deliberate. Reasons intrinsic to the event come first —
 * a failed transaction and a sell were never signals whatever our latency was,
 * so letting our lag mask them would understate how often the source delivers
 * nothing usable. Reasons about US come next, lag before duplicate before venue
 * support, so that "we were late" is never recorded as "the venue has no pool".
 */
export function evaluateSignal(event: WalletFlowEvent, ctx: SignalContext): SignalDecision | null {
  if (event.decodeRefusal !== null || event.mint === null || event.side === null) return null;

  const flagged = ctx.watchlist.get(event.wallet);
  const { ageMs, basis } = signalAge(event, ctx.evaluatedUtcMs);
  const base = {
    mint: event.mint,
    wallet: event.wallet,
    walletRank: flagged?.rankPosition ?? 0,
    kObserved: MT101.confluenceK,
    signalAgeMs: ageMs,
    ageBasis: basis,
  };

  if (flagged === undefined) {
    return {
      ...base,
      walletRank: 0,
      outcome: 'REFUSED_WALLET_NOT_FLAGGED',
      refusal: `${event.wallet} is not on the frozen ${MT101.ledgerRow} watchlist`,
    };
  }
  if (event.txError) {
    return {
      ...base,
      outcome: 'REFUSED_TX_FAILED',
      refusal: 'a failed transaction is observed activity and zero value, never flow',
    };
  }
  if (event.side !== 'BUY') {
    return { ...base, outcome: 'REFUSED_NOT_BUY', refusal: `side ${event.side} is not an entry` };
  }
  if (ageMs > MT101.lagBudgetMs) {
    return {
      ...base,
      outcome: 'REFUSED_STALE',
      refusal:
        `signal age ${ageMs}ms measured against ${basis} exceeds the frozen ` +
        `${MT101.lagBudgetMs}ms budget; entering late is a different rule`,
    };
  }
  if (ctx.alreadySignalledMints.has(event.mint)) {
    return {
      ...base,
      outcome: 'REFUSED_DUPLICATE_MINT',
      refusal: `${event.mint} already signalled under ${MT101.ledgerRow}; one position per mint`,
    };
  }
  if (ctx.poolPresent !== true) {
    return {
      ...base,
      outcome: 'REFUSED_NO_POOL',
      refusal:
        ctx.poolPresent === null
          ? 'canonical PumpSwap pool could not be established; an unread account is not an absent pool'
          : 'no canonical PumpSwap pool',
    };
  }
  return { ...base, outcome: 'FORWARDED', refusal: null };
}

/** Sustained request rate a full sweep of `n` wallets presents, in req/s. */
export function watchlistRequestRate(n: number, sweepIntervalMs: number): number {
  if (sweepIntervalMs <= 0) throw new WatchlistBudgetExceeded('sweep interval must be positive');
  return (n * 1000) / sweepIntervalMs;
}

export interface SweepBudget {
  /** Total calls the frozen share permits inside one sweep. */
  readonly maxCallsPerSweep: number;
  /** One `getSignaturesForAddress` per watched wallet. Unavoidable and fixed. */
  readonly signatureCalls: number;
  /**
   * What is left for `getTransaction` decodes.
   *
   * This is the quantity MT101 got wrong and MT102 fixed. It is exposed rather
   * than asserted against a threshold, because the right response to running
   * out mid-sweep is to DEFER the remaining decodes and record the deferral —
   * not to exceed a budget the screening collector shares, and not to drop the
   * events silently, which would make the source's detection rate a function of
   * how busy the watchlist happened to be.
   */
  readonly decodeHeadroom: number;
  readonly signatureRps: number;
}

export function sweepBudget(
  n: number = MT101.watchlistSize,
  sweepIntervalMs: number = MT101.sweepIntervalMs,
  maxRps: number = MT101.maxWatchlistRequestsPerSecond,
): SweepBudget {
  const maxCallsPerSweep = Math.floor((maxRps * sweepIntervalMs) / 1000);
  return {
    maxCallsPerSweep,
    signatureCalls: n,
    decodeHeadroom: maxCallsPerSweep - n,
    signatureRps: watchlistRequestRate(n, sweepIntervalMs),
  };
}

/**
 * Mean and worst-case detection lag a polled sweep imposes, before any network
 * time. A wallet acts uniformly within the interval between two sweeps of it.
 */
export function pollingDetectionLag(sweepIntervalMs: number): {
  readonly meanMs: number;
  readonly worstMs: number;
} {
  return { meanMs: sweepIntervalMs / 2, worstMs: sweepIntervalMs };
}

export class WatchlistBudgetExceeded extends Error {}

/**
 * Refuse a watchlist that would present more than its frozen share of the
 * endpoint budget.
 *
 * This is enforced rather than remembered because the failure is silent and
 * expensive: `endpoint-budget.ts` holds the endpoint-wide total at 8 req/s
 * across all processes, so a watchlist that quietly grows does not get refused
 * by the provider — it starves the screening collector that shares the bucket,
 * and the arm's own admission rate falls for a reason that has nothing to do
 * with the market.
 */
export function assertWatchlistWithinBudget(
  n: number,
  sweepIntervalMs: number = MT101.sweepIntervalMs,
  maxRps: number = MT101.maxWatchlistRequestsPerSecond,
): void {
  const rps = watchlistRequestRate(n, sweepIntervalMs);
  if (rps > maxRps) {
    throw new WatchlistBudgetExceeded(
      `${n} wallets swept every ${sweepIntervalMs}ms presents ${rps.toFixed(2)} req/s against the ` +
        `frozen ${maxRps} req/s share; shrink the watchlist or lengthen the sweep rather than ` +
        `widening the budget the screening collector shares`,
    );
  }
}

export class WatchlistInvalid extends Error {}

/**
 * Build the frozen watchlist, enforcing every MT101 condition at construction.
 *
 * A watchlist assembled from rows that quietly fail the frozen rule is a
 * different experiment wearing the same name, and it would be indistinguishable
 * from the real one at analysis time.
 */
export function freezeWatchlist(
  rows: readonly FlaggedWallet[],
  size: number = MT101.watchlistSize,
): ReadonlyMap<string, FlaggedWallet> {
  if (rows.length !== size) {
    throw new WatchlistInvalid(
      `watchlist has ${rows.length} wallets against the frozen size ${size}; a short list is not the frozen rule`,
    );
  }
  const byAddress = new Map<string, FlaggedWallet>();
  const seenRanks = new Set<number>();
  for (const r of rows) {
    if (r.fitPositions < MT101.minFitPositions) {
      throw new WatchlistInvalid(
        `${r.address} has ${r.fitPositions} fit positions against the frozen minimum ${MT101.minFitPositions}`,
      );
    }
    if (r.rankPosition < 1 || r.rankPosition > size) {
      throw new WatchlistInvalid(`${r.address} has rank ${r.rankPosition} outside 1..${size}`);
    }
    if (seenRanks.has(r.rankPosition)) {
      throw new WatchlistInvalid(`rank ${r.rankPosition} appears twice; the frozen order is not a ranking`);
    }
    if (byAddress.has(r.address)) {
      throw new WatchlistInvalid(`${r.address} appears twice; a wallet counted twice is not one wallet`);
    }
    seenRanks.add(r.rankPosition);
    byAddress.set(r.address, r);
  }
  assertWatchlistWithinBudget(byAddress.size);
  return byAddress;
}

/**
 * A wallet on the MT104 watchlist, carrying the decile it was drawn from.
 *
 * The decile is what makes MT104 a controlled experiment rather than a larger
 * MT101, so it is part of the type rather than a lookup somebody could forget.
 */
export interface DecileFlaggedWallet extends FlaggedWallet {
  readonly fitDecile: number;
  readonly ammEntryShare: number;
  readonly holdoutPositions: number;
}

export interface FrozenDecileWatchlist {
  readonly byAddress: ReadonlyMap<string, DecileFlaggedWallet>;
  readonly counts: ReadonlyMap<number, number>;
}

/**
 * Freeze the MT104 watchlist.
 *
 * Deliberately NOT `freezeWatchlist` with a different size. Three of that
 * function's conditions are properties of the POLLED source and would be
 * meaningless here — the fixed 128, the contiguous rank range, and the sweep
 * budget, which exists because a poll costs one RPC call per wallet per sweep.
 * A stream matches locally and its watchlist is free at any size, so applying a
 * request-rate bound to it would be enforcing a constraint that no longer
 * exists and quietly shrinking the experiment.
 *
 * What IS enforced is everything that is a property of the RULE: the
 * 20-position bar MT073 set, address uniqueness, and — the one that matters
 * most — that BOTH deciles are present and non-empty. A control arm that
 * silently arrived empty would leave a single-arm experiment wearing a
 * controlled experiment's name, and every conclusion drawn from it would be the
 * one MT104 exists to avoid.
 */
export function freezeDecileWatchlist(rows: readonly DecileFlaggedWallet[]): FrozenDecileWatchlist {
  if (rows.length === 0) throw new WatchlistInvalid('MT104 watchlist is empty');
  const byAddress = new Map<string, DecileFlaggedWallet>();
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.fitPositions < MT101.minFitPositions) {
      throw new WatchlistInvalid(
        `${r.address} has ${r.fitPositions} fit positions against the frozen minimum ${MT101.minFitPositions}`,
      );
    }
    if (r.fitDecile !== MT104.treatmentDecile && r.fitDecile !== MT104.controlDecile) {
      throw new WatchlistInvalid(
        `${r.address} is in decile ${r.fitDecile}; MT104 froze ${MT104.treatmentDecile} and ${MT104.controlDecile} only`,
      );
    }
    if (byAddress.has(r.address)) {
      throw new WatchlistInvalid(`${r.address} appears twice; a wallet counted twice is not two wallets`);
    }
    byAddress.set(r.address, r);
    counts.set(r.fitDecile, (counts.get(r.fitDecile) ?? 0) + 1);
  }
  for (const d of [MT104.treatmentDecile, MT104.controlDecile]) {
    if ((counts.get(d) ?? 0) === 0) {
      throw new WatchlistInvalid(
        `decile ${d} is empty; MT104 is a CONTROLLED comparison and a missing arm is not a smaller one`,
      );
    }
  }
  return { byAddress, counts };
}

/** Which MT104 arm a wallet belongs to, or null when it is not on the watchlist. */
export function armForDecile(fitDecile: number): string | null {
  if (fitDecile === MT104.treatmentDecile) return MT104.treatmentArm;
  if (fitDecile === MT104.controlDecile) return MT104.controlArm;
  return null;
}

/**
 * MT105 — which signals get opened, when there are far more than capacity.
 *
 * The tape delivers roughly 69,500 flagged decile-1 buys a day per arm. The
 * apparatus can carry a few hundred to a few thousand trajectories a day. So
 * something has to choose, and the choice is part of the strategy whether or not
 * anybody writes it down.
 *
 * It is NOT first-come. Arrival order is latency, latency correlates with wallet
 * behaviour, and "we took whichever landed first" would be an unrecorded rule
 * doing real selection.
 *
 * It is NOT rank-ordered within a decile. That would smuggle a second, untested
 * hypothesis into an experiment whose entire point is the decile CONTRAST.
 *
 * It is a deterministic hash of the signal itself. The same signal is admitted
 * or refused identically on a replay, which is what lets a decision be
 * re-derived from its snapshot — the invariant this repository applies
 * everywhere else and which a call to Math.random would quietly break.
 */
export const MT105 = {
  ledgerRow: 'MT105',
  /** Salt, so the same mint draws differently under a later arm. */
  salt: 'MT105',
  /** What the bridge aims to open per day across both arms. */
  targetOpensPerDay: 1_000,
  precision: 10_000,
} as const;

/** FNV-1a, 32-bit. Chosen because it is short, seedless and reproducible anywhere. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // The 32-bit FNV prime, 16777619, by shift-add so it stays exact in a double.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Is this signal in the sample?
 *
 * Keyed on (mint, wallet) and NOT on the signature, so the same wallet buying
 * the same mint twice draws the same answer. That matters because MT101 already
 * admits one position per mint: keying on the signature would let a refused mint
 * come back on the wallet's next buy and turn "one position per mint" into
 * "however many attempts it took".
 */
export function admitSignal(mint: string, wallet: string, inclusionProbability: number): boolean {
  if (!(inclusionProbability > 0)) return false;
  if (inclusionProbability >= 1) return true;
  const bucket = fnv1a32(`${mint}|${wallet}|${MT105.salt}`) % MT105.precision;
  return bucket < Math.floor(inclusionProbability * MT105.precision);
}

/**
 * The rate that hits the target, given what the tape is actually delivering.
 *
 * Computed from an OBSERVED signal rate rather than assumed, and clamped to 1:
 * if the tape ever delivers fewer signals than the target, the honest response
 * is to take all of them and report the shortfall, never to silently behave as
 * though the target were met.
 */
export function inclusionProbabilityFor(observedSignalsPerDay: number, target = MT105.targetOpensPerDay): number {
  if (observedSignalsPerDay <= 0) return 1;
  return Math.min(1, target / observedSignalsPerDay);
}
