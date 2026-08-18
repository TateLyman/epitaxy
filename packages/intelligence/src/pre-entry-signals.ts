import type { FlowEvent } from './targeted-flow.js';
import type { MicrostructureFeatures } from './migration-microstructure.js';

/**
 * P5 — the six literal `null`s, replaced by measurements.
 *
 * At the audited head every one of these was the constant `null`:
 *
 *     independentBuyerPersistence, nonMayhemNetQuoteInflowLamports,
 *     effectiveQuoteReserveTrend, executableExitCapacityTrend,
 *     continuationSlope, creatorNetSellingLamports
 *
 * so `SURVIVOR_FLOW_CONTINUATION_V1` refused every candidate for want of inputs
 * and only the random control could enter. Everything in this file exists to
 * make those fields real, and every definition here is FROZEN BEFORE ANY
 * OUTCOME IS LOOKED AT. That ordering is the whole point: a definition chosen
 * after seeing which version correlates with profit is a fitted parameter
 * wearing the costume of a measurement.
 *
 * ---
 *
 * THE TWO CLOCKS SEE DIFFERENT INFORMATION, AND THAT IS THE EXPERIMENT
 *
 * At T0 — the first mechanically valid confirmed post-migration state — there
 * is BY CONSTRUCTION no post-migration flow to measure. Any "persistence"
 * computed there would be persistence across two windows that do not exist. So
 * T0's signals come from the closed pre-migration curve, which is genuinely
 * pre-decision data.
 *
 * At T120 there are two minutes of post-migration flow, so the same fields are
 * computed from what the token did AFTER it migrated.
 *
 * This is not a defect to be smoothed over. It is the exact quantity P6 is
 * testing: whether 120 seconds of observation is worth the optionality it
 * costs. Filling T0 from post-migration data would destroy that comparison by
 * giving T0 information it could not have had.
 */

/** Frozen. Registered in docs/MULTIPLE_TESTING_LEDGER.csv before the window. */
export const PERSISTENCE_WINDOW_MS = 60_000;

/**
 * Frozen. The reference position the exit-capacity trend is measured on.
 *
 * A fraction of the position rather than a fixed SOL amount, so the measure
 * does not silently change meaning when the dynamic size rule (P7) picks a
 * different notional. It answers one question at every checkpoint: "could we
 * still get out of what we hold?"
 */
export const EXIT_CAPACITY_REFERENCE_FRACTION = 1.0;

/**
 * Frozen. Slope above this is a vertical spike, not a continuation.
 *
 * Preregistered and NOT tuned from the current outcome signs — the directive
 * forbids that explicitly, and with 13 settled paths in the last window any
 * such tuning would be fitting noise. It is the value already carried by
 * `SURVIVOR_DEFAULTS.maxContinuationSlope` and is repeated here so the two
 * cannot drift apart silently.
 */
export const CONTINUATION_VERTICAL_CAP = 5;

export interface Checkpoint {
  readonly atUtcMs: number;
  /**
   * PumpSwap's effective quote reserve, by the current convention:
   *
   *     quote vault balance + virtual_quote_reserves
   *
   * Null when either component could not be read. Never the vault alone — that
   * is a different quantity and using it as a substitute would understate the
   * reserve on every pool.
   */
  readonly effectiveQuoteReserveLamports: bigint | null;
  /**
   * The EXACT direct sell proceeds for the reference position at this instant.
   *
   * Better than generic liquidity because it is the number the exit actually
   * gets: it already contains the curve, the fee tier and the impact of our own
   * size. A pool with deep reserves that cannot fill our position is a pool we
   * cannot leave, and only this quantity says so.
   */
  readonly executableExitLamports: bigint | null;
  /** Executable price for the reference unit, for the continuation slope. */
  readonly executablePriceLamports: bigint | null;
}

export interface SignalInput {
  readonly entryClock: 'T0' | 'T120';
  readonly decisionUtcMs: number;
  /** Confirmed, deduped, non-failed post-migration events. Empty at T0. */
  readonly flowEvents: readonly FlowEvent[];
  /** Two pre-entry checkpoints, oldest first. Fewer than two means no trend. */
  readonly checkpoints: readonly Checkpoint[];
  /** The closed pre-migration history's features, when they were computed. */
  readonly microstructure: MicrostructureFeatures | null;
  /**
   * Whether Mayhem/protocol-controlled flow could be ISOLATED for this mint.
   *
   * False does not mean "no Mayhem flow". It means we cannot tell, and the
   * directive is explicit that the answer is then `null` rather than ordinary
   * net flow — an unseparated number is not the quantity the policy asks for.
   */
  readonly mayhemIsolable: boolean;
}

export interface SignalResult {
  readonly independentBuyerPersistence: number | null;
  /** Numerator and denominator persisted, so the ratio can be checked. */
  readonly persistenceNumerator: number | null;
  readonly persistenceDenominator: number | null;
  readonly nonMayhemNetQuoteInflowLamports: bigint | null;
  readonly effectiveQuoteReserveTrend: number | null;
  readonly executableExitCapacityTrend: number | null;
  readonly continuationSlope: number | null;
  readonly creatorNetSellingLamports: bigint | null;
  /** Why each null is null. A null with no reason is indistinguishable from a bug. */
  readonly nullReasons: Readonly<Record<string, string>>;
  /** Which source filled each field: the curve, the flow, or nothing. */
  readonly sources: Readonly<Record<string, 'PRE_MIGRATION_CURVE' | 'POST_MIGRATION_FLOW' | 'CHECKPOINTS' | 'NONE'>>;
}

export function computePreEntrySignals(input: SignalInput): SignalResult {
  const nullReasons: Record<string, string> = {};
  const sources: Record<string, 'PRE_MIGRATION_CURVE' | 'POST_MIGRATION_FLOW' | 'CHECKPOINTS' | 'NONE'> = {};

  /**
   * INDEPENDENT BUYER PERSISTENCE
   *
   *   entities buying in BOTH adjacent windows / entities buying in the earlier
   *
   * Excludes the creator cluster, known protocol-controlled addresses, and
   * unattributed events. The question it asks is whether the SAME independent
   * participants are still buying, which is a different and much harder thing
   * to fake than volume: a wash trader can produce any volume it likes, and
   * producing persistence requires it to keep producing it.
   */
  let persistence: number | null = null;
  let numer: number | null = null;
  let denom: number | null = null;

  if (input.entryClock === 'T120' && input.flowEvents.length > 0) {
    const later = input.decisionUtcMs;
    const mid = later - PERSISTENCE_WINDOW_MS;
    const early = mid - PERSISTENCE_WINDOW_MS;

    const independentBuyersIn = (fromMs: number, toMs: number): Set<string> => {
      const s = new Set<string>();
      for (const e of input.flowEvents) {
        if (e.side !== 'buy' || e.blockTimeMs === null) continue;
        if (e.blockTimeMs < fromMs || e.blockTimeMs >= toMs) continue;
        if (e.actorClass === 'CREATOR' || e.actorClass === 'MAYHEM') continue;
        if (e.actor === null) continue;
        s.add(`${e.actorClass}:${e.actor}`);
      }
      return s;
    };

    const a = independentBuyersIn(early, mid);
    const b = independentBuyersIn(mid, later);
    denom = a.size;
    numer = [...a].filter((x) => b.has(x)).length;
    if (a.size === 0) {
      // Nobody bought in the earlier window. The ratio is undefined, and
      // reporting 0 would say "everyone left" when the truth is "nobody came".
      nullReasons['independentBuyerPersistence'] = 'no independent buyer entity in the earlier window, so the ratio is undefined';
      sources['independentBuyerPersistence'] = 'NONE';
    } else {
      persistence = numer / denom;
      sources['independentBuyerPersistence'] = 'POST_MIGRATION_FLOW';
    }
  } else if (input.microstructure !== null && input.microstructure.repeatBuyerFraction !== null) {
    /**
     * At T0 the closed curve's repeat-buyer fraction is the same construct
     * measured on the only history that exists: buyers who came back.
     *
     * It is NOT the same number and it is labelled with its source so no
     * analysis can pool the two as if they were.
     */
    persistence = input.microstructure.repeatBuyerFraction;
    sources['independentBuyerPersistence'] = 'PRE_MIGRATION_CURVE';
  } else {
    nullReasons['independentBuyerPersistence'] =
      input.entryClock === 'T0'
        ? 'T0 has no post-migration flow and the pre-migration history was not complete enough to supply a repeat-buyer fraction'
        : 'no confirmed post-migration flow events were available';
    sources['independentBuyerPersistence'] = 'NONE';
  }

  /**
   * NON-MAYHEM NET QUOTE INFLOW
   *
   * Independent buy quote minus independent sell quote. When Mayhem flow
   * cannot be isolated the answer is null, NOT ordinary net flow: the policy
   * asked for flow with the protocol's own participation removed, and handing
   * it the unseparated number answers a question nobody asked.
   */
  let netInflow: bigint | null = null;
  if (!input.mayhemIsolable) {
    nullReasons['nonMayhemNetQuoteInflowLamports'] =
      'Mayhem/protocol-controlled flow could not be isolated for this mint, and ordinary net flow is not a substitute';
    sources['nonMayhemNetQuoteInflowLamports'] = 'NONE';
  } else if (input.entryClock === 'T120' && input.flowEvents.length > 0) {
    const cutoff = input.decisionUtcMs - PERSISTENCE_WINDOW_MS;
    let v = 0n;
    for (const e of input.flowEvents) {
      if (e.blockTimeMs === null || e.blockTimeMs < cutoff) continue;
      if (e.actorClass === 'MAYHEM' || e.actorClass === 'CREATOR') continue;
      v += e.side === 'buy' ? e.quoteLamports : -e.quoteLamports;
    }
    netInflow = v;
    sources['nonMayhemNetQuoteInflowLamports'] = 'POST_MIGRATION_FLOW';
  } else if (input.microstructure !== null && input.microstructure.realSolInflowSlopeFinal180s !== null) {
    // The curve's final-180s net inflow, reconstituted as a lamport total.
    netInflow = BigInt(Math.round(input.microstructure.realSolInflowSlopeFinal180s * 180));
    sources['nonMayhemNetQuoteInflowLamports'] = 'PRE_MIGRATION_CURVE';
  } else {
    nullReasons['nonMayhemNetQuoteInflowLamports'] = 'no post-migration flow and no pre-migration inflow slope';
    sources['nonMayhemNetQuoteInflowLamports'] = 'NONE';
  }

  // ---- the checkpoint-derived trends ----
  const cps = [...input.checkpoints].sort((a, b) => a.atUtcMs - b.atUtcMs);
  const first = cps[0] ?? null;
  const last = cps[cps.length - 1] ?? null;
  const haveTwo = cps.length >= 2 && first !== null && last !== null && last.atUtcMs > first.atUtcMs;

  const trend = (
    name: string,
    a: bigint | null | undefined,
    b: bigint | null | undefined,
    missing: string,
  ): number | null => {
    if (!haveTwo) {
      nullReasons[name] = 'fewer than two distinct pre-entry checkpoints, so no trend exists';
      sources[name] = 'NONE';
      return null;
    }
    if (a === null || a === undefined || b === null || b === undefined) {
      nullReasons[name] = missing;
      sources[name] = 'NONE';
      return null;
    }
    if (a === 0n) {
      nullReasons[name] = 'the earlier checkpoint measured zero, so a ratio is undefined';
      sources[name] = 'NONE';
      return null;
    }
    sources[name] = 'CHECKPOINTS';
    // Basis points internally, so a bigint ratio never loses precision to a
    // float before it is compared against a threshold.
    return Number(((b - a) * 10_000n) / a) / 10_000;
  };

  const reserveTrend = trend(
    'effectiveQuoteReserveTrend',
    first?.effectiveQuoteReserveLamports,
    last?.effectiveQuoteReserveLamports,
    'the effective quote reserve (quote vault + virtual_quote_reserves) could not be read at both checkpoints',
  );

  const exitTrend = trend(
    'executableExitCapacityTrend',
    first?.executableExitLamports,
    last?.executableExitLamports,
    'the exact direct sell value for the reference position could not be computed at both checkpoints',
  );

  /**
   * CONTINUATION SLOPE
   *
   * Log executable price, normalised by elapsed seconds. Log because a price
   * path is multiplicative and a linear slope makes the same move look
   * different at different price levels; executable rather than a provider USD
   * price because the provider's number is a different quantity measured at a
   * different instant against a different venue.
   *
   * A slope above the frozen cap is refused as a vertical spike. Buying the top
   * of a launch spike is the single most reliable way to lose on a memecoin,
   * and the cap is preregistered rather than fitted to the current signs.
   */
  let slope: number | null = null;
  if (!haveTwo) {
    nullReasons['continuationSlope'] = 'fewer than two distinct pre-entry checkpoints, so no slope exists';
    sources['continuationSlope'] = 'NONE';
  } else if (
    first?.executablePriceLamports === null ||
    first?.executablePriceLamports === undefined ||
    last?.executablePriceLamports === null ||
    last?.executablePriceLamports === undefined ||
    first.executablePriceLamports <= 0n ||
    last.executablePriceLamports <= 0n
  ) {
    nullReasons['continuationSlope'] = 'an executable price was unavailable or non-positive at a checkpoint';
    sources['continuationSlope'] = 'NONE';
  } else {
    const seconds = (last.atUtcMs - first.atUtcMs) / 1000;
    const logRatio = Math.log(Number(last.executablePriceLamports) / Number(first.executablePriceLamports));
    slope = logRatio / seconds;
    sources['continuationSlope'] = 'CHECKPOINTS';
  }

  /**
   * CREATOR NET SELLING
   *
   * Positive means the creator cluster took money OUT. Decoded from the same
   * attributed flows the bars use, and falling back to the closed curve's
   * creator accounting when there is no post-migration flow yet.
   */
  let creatorNet: bigint | null = null;
  if (input.entryClock === 'T120' && input.flowEvents.length > 0) {
    let v = 0n;
    let saw = false;
    for (const e of input.flowEvents) {
      if (e.actorClass !== 'CREATOR') continue;
      saw = true;
      v += e.side === 'sell' ? e.quoteLamports : -e.quoteLamports;
    }
    if (saw) {
      creatorNet = v;
      sources['creatorNetSellingLamports'] = 'POST_MIGRATION_FLOW';
    }
  }
  if (creatorNet === null) {
    const m = input.microstructure;
    if (m !== null && m.creatorNetLamports !== null) {
      creatorNet = BigInt(m.creatorNetLamports);
      sources['creatorNetSellingLamports'] = 'PRE_MIGRATION_CURVE';
    } else {
      nullReasons['creatorNetSellingLamports'] =
        'the creator was not named by the migration event, or the pre-migration history was incomplete';
      sources['creatorNetSellingLamports'] = 'NONE';
    }
  }

  return {
    independentBuyerPersistence: persistence,
    persistenceNumerator: numer,
    persistenceDenominator: denom,
    nonMayhemNetQuoteInflowLamports: netInflow,
    effectiveQuoteReserveTrend: reserveTrend,
    executableExitCapacityTrend: exitTrend,
    continuationSlope: slope,
    creatorNetSellingLamports: creatorNet,
    nullReasons,
    sources,
  };
}
