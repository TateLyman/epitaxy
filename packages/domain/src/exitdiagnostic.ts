import { impactIsSchemaError, type ImpactReading } from './impact.js';

/**
 * Why an exit was hard, as distinct from what it cost and from which rule fired.
 *
 * This is the third field in a set that used to be one. The history is worth
 * keeping because it is the same defect three times:
 *
 *   TriggerRule       which rule noticed        packages/strategy/src/exits.ts
 *   ExitOutcome       what happened to the money  packages/domain/src/exitoutcome.ts
 *   ExitDiagnostic    what was WRONG, if anything  here
 *
 * `exit_cost_exploded` was originally all three at once, and so it covered a
 * token that had evaporated, a provider outage, and a position that was up 2%.
 * Any average taken over that label describes nothing.
 *
 * The categories below are MUTUALLY EXCLUSIVE and evaluated in a fixed order.
 * The order is not cosmetic — it is the claim that some facts invalidate the
 * measurement of others:
 *
 *   1 PROVIDER_FAILURE       we did not observe the market at all
 *   2 SCHEMA_OR_PARSER_ERROR we observed it and cannot trust our reading
 *   3 NO_EXIT_ROUTE          no route existed at any price
 *   4 UNBUILDABLE_EXIT       a price existed but no transaction could be built
 *   5 STALE_EXIT_QUOTE       the observation was too old to act on
 *   6 EXECUTABLE_VALUE_COLLAPSE  the position is worth a fraction of its cost
 *   7 ADVERSE_EXIT_IMPACT    impact against us exceeded the frozen cap
 *   8 ROUND_TRIP_COST_EXPANSION  still sellable, but the round trip lost money
 *   -  NONE                  nothing was wrong
 *   -  UNVERIFIABLE          a historical row whose raw inputs did not survive
 *
 * A provider outage above a value collapse is the important one: a 500 from an
 * aggregator and a drained pool produce the same missing number, and the system
 * previously called both a liquidity event. Provider failures are never token
 * facts.
 *
 * This module classifies. It decides nothing. Economic policy is frozen until
 * `docs/P2B_PREREGISTRATION.md` is committed, and choosing an exit rule after
 * seeing which label rescues the existing trades is the exact thing the
 * preregistration exists to prevent.
 */

export const DIAGNOSTIC_VERSION = 'exit-diagnostic-v1';

export const EXIT_DIAGNOSTICS = [
  'PROVIDER_FAILURE',
  'SCHEMA_OR_PARSER_ERROR',
  'NO_EXIT_ROUTE',
  'UNBUILDABLE_EXIT',
  'STALE_EXIT_QUOTE',
  'EXECUTABLE_VALUE_COLLAPSE',
  'ADVERSE_EXIT_IMPACT',
  'ROUND_TRIP_COST_EXPANSION',
  'NONE',
  'UNVERIFIABLE',
] as const;

export type ExitDiagnostic = (typeof EXIT_DIAGNOSTICS)[number];

/**
 * Frozen thresholds.
 *
 * These are DEFINITIONS used for labelling, not tuned parameters, and no entry
 * or exit decision reads them. They do not spend alpha and do not belong in
 * `docs/MULTIPLE_TESTING_LEDGER.csv`. Changing one re-labels history, so each
 * carries its reasoning:
 *
 *  - `collapseRatioBps` 1000 — a tenth of cost is where "how much did we lose"
 *    stops being the question and "is there a market" starts. Matches
 *    `COLLAPSE_RATIO` in exitoutcome.ts deliberately; two collapse definitions
 *    that disagree would be worse than either.
 *  - `adverseImpactBps` 500 — 5% of notional consumed by impact alone.
 *  - `roundTripLossBps` 1000 — a round trip that costs a tenth of the stake.
 *  - `maxQuoteAgeMs` 30000 — beyond half a minute a memecoin quote is a
 *    historical fact rather than a price.
 */
export interface DiagnosticThresholds {
  readonly collapseRatioBps: number;
  readonly adverseImpactBps: number;
  readonly roundTripLossBps: number;
  readonly maxQuoteAgeMs: number;
}

export const DEFAULT_DIAGNOSTIC_THRESHOLDS: DiagnosticThresholds = {
  collapseRatioBps: 1_000,
  adverseImpactBps: 500,
  roundTripLossBps: 1_000,
  maxQuoteAgeMs: 30_000,
};

export interface DiagnosticInputs {
  /** True when the provider itself failed: timeout, 5xx, 429, transport error. */
  readonly providerFailed: boolean;
  /** Null when no quote was obtained at all. */
  readonly impact: ImpactReading | null;
  /** False when the provider answered and reported no route. */
  readonly routeExists: boolean;
  /**
   * Whether a transaction could be CONSTRUCTED for the exit at this size.
   * Null means it was never asked — which is not the same as a failure, and
   * must never be reported as one.
   */
  readonly routeBuildable: boolean | null;
  /** SOL a full-position sell was quoted to return. Null when unquoted. */
  readonly executableSellValueLamports: bigint | null;
  /** All-in lamports the position cost to open. */
  readonly allInCostLamports: bigint;
  /** Age of the exit quote when the decision was taken. Null when unknown. */
  readonly quoteAgeMs: number | null;
  /**
   * Measured loss on a full in-and-out at this instant, in bps. Null when not
   * measured. Distinct from `executableSellValueLamports / allInCostLamports`,
   * which is about THIS position rather than the route as it stands now.
   */
  readonly roundTripLossBps: number | null;
}

export interface DiagnosticVerdict {
  readonly diagnostic: ExitDiagnostic;
  readonly detail: string;
  /** executableSellValue / allInCost in bps. Null when unquoted. */
  readonly executableValueRatioBps: number | null;
  readonly version: string;
}

function verdict(
  diagnostic: ExitDiagnostic,
  detail: string,
  executableValueRatioBps: number | null,
): DiagnosticVerdict {
  return { diagnostic, detail, executableValueRatioBps, version: DIAGNOSTIC_VERSION };
}

/**
 * Ratio of executable exit value to all-in cost, in basis points.
 *
 * Exported because it is the single number this whole exercise is about, and
 * three call sites deriving it separately is how the first version ended up
 * with two different collapse definitions.
 */
export function executableValueRatioBps(sellValue: bigint | null, cost: bigint): number | null {
  if (sellValue === null || cost <= 0n) return null;
  return Number((sellValue * 10_000n) / cost);
}

/**
 * Classify one exit observation.
 *
 * Total and deterministic. Every branch returns, so a new enum member cannot be
 * added without the compiler pointing at the consumers.
 */
export function diagnoseExit(
  input: DiagnosticInputs,
  thresholds: DiagnosticThresholds = DEFAULT_DIAGNOSTIC_THRESHOLDS,
): DiagnosticVerdict {
  const ratioBps = executableValueRatioBps(input.executableSellValueLamports, input.allInCostLamports);

  // 1. The provider did not answer. Nothing below this line was observed, so
  //    nothing below this line may be asserted about the token.
  if (input.providerFailed) {
    return verdict(
      'PROVIDER_FAILURE',
      'the quote provider failed; no statement about this token is supported by this observation',
      ratioBps,
    );
  }

  // 2. It answered and we cannot trust our reading of the answer. Note that an
  //    ABSENT impact field is NOT an error — a provider omitting a field is a
  //    fact about the provider — so it falls through to the economics below,
  //    where impact simply cannot be asserted.
  if (input.impact !== null && impactIsSchemaError(input.impact)) {
    return verdict('SCHEMA_OR_PARSER_ERROR', `impact field unusable: ${input.impact.detail}`, ratioBps);
  }

  // 3. No route at any price.
  if (!input.routeExists) {
    return verdict('NO_EXIT_ROUTE', 'provider answered and reported no sell route at any size', ratioBps);
  }

  // 4. Priced, but no transaction could be constructed. This is the category
  //    the corpus had no name for while 2255 quotes carried
  //    transaction_buildable = 0 and 38 fills were booked anyway.
  if (input.routeBuildable === false) {
    return verdict('UNBUILDABLE_EXIT', 'route returned a price but no transaction could be built for it', ratioBps);
  }

  // 5. The observation is too old to be a price.
  if (input.quoteAgeMs !== null && input.quoteAgeMs > thresholds.maxQuoteAgeMs) {
    return verdict(
      'STALE_EXIT_QUOTE',
      `exit quote was ${input.quoteAgeMs}ms old, beyond the ${thresholds.maxQuoteAgeMs}ms cap`,
      ratioBps,
    );
  }

  // 6. Economics. Value collapse first, because a position worth 3% of its cost
  //    is not usefully described by whatever its impact number was.
  if (ratioBps !== null && ratioBps <= thresholds.collapseRatioBps) {
    return verdict(
      'EXECUTABLE_VALUE_COLLAPSE',
      `full-position sell quote returns ${(ratioBps / 100).toFixed(2)}% of all-in cost, at or below the ${(
        thresholds.collapseRatioBps / 100
      ).toFixed(2)}% floor`,
      ratioBps,
    );
  }

  // 7. Impact against us. Only assertable when the reading is usable: a null
  //    `adverseBps` means unknown, and unknown never satisfies a cap.
  const adverse = input.impact?.adverseBps ?? null;
  if (adverse !== null && adverse > thresholds.adverseImpactBps) {
    return verdict(
      'ADVERSE_EXIT_IMPACT',
      `adverse impact ${adverse.toFixed(0)}bps exceeds the ${thresholds.adverseImpactBps}bps cap ` +
        `(raw ${input.impact?.sourceField ?? 'unknown'}=${input.impact?.rawString ?? 'null'})`,
      ratioBps,
    );
  }

  // 8. Still sellable, still ordinary impact, but the round trip loses money.
  if (input.roundTripLossBps !== null && input.roundTripLossBps > thresholds.roundTripLossBps) {
    return verdict(
      'ROUND_TRIP_COST_EXPANSION',
      `round-trip loss ${input.roundTripLossBps.toFixed(0)}bps exceeds the ${thresholds.roundTripLossBps}bps cap ` +
        'while an executable sell remains available',
      ratioBps,
    );
  }

  return verdict('NONE', 'exit route present, buildable, fresh, and within every frozen cost cap', ratioBps);
}

/**
 * A row whose raw inputs did not survive cannot be classified.
 *
 * Separate from `diagnoseExit` so that no call site can reach `UNVERIFIABLE` by
 * accident: it is a statement about our records, not about the market, and the
 * only honest way to produce it is to say so explicitly.
 */
export function unverifiable(reason: string): DiagnosticVerdict {
  return verdict('UNVERIFIABLE', `cannot be reclassified: ${reason}`, null);
}

/** True for diagnostics that say something about us rather than the token. */
export function isOurFault(d: ExitDiagnostic): boolean {
  return d === 'PROVIDER_FAILURE' || d === 'SCHEMA_OR_PARSER_ERROR' || d === 'STALE_EXIT_QUOTE';
}

/** True for diagnostics that disqualify a row from confirmatory results. */
export function disqualifiesFromConfirmatory(d: ExitDiagnostic): boolean {
  return isOurFault(d) || d === 'UNVERIFIABLE' || d === 'UNBUILDABLE_EXIT';
}
