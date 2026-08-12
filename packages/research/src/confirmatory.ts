import { disqualifiesFromConfirmatory, type ExitDiagnostic } from '../../domain/src/exitdiagnostic.js';

/**
 * What may be counted as confirmatory evidence, and how it may be counted.
 *
 * P2a.1 §P8. P2b is a multiple-testing trap wearing a friendly hat: there are
 * thousands of marks, a handful of positions, and every tempting shortcut turns
 * the former into the sample size. This module exists to make the shortcuts
 * fail loudly rather than silently produce a confident number.
 *
 * Four refusals, each of which corresponds to a way the existing corpus could
 * be made to look like evidence:
 *
 *   1 pooling rows from different regimes  (five regimes, one average)
 *   2 resampling at mark level             (2000 marks, 19 positions)
 *   3 counting a row with no build proof   (2255 quotes, 0 buildable)
 *   4 filling at the trigger quote         (free lookahead worth ~1 mark)
 *
 * Nothing here computes a strategy result. It decides what is admissible, which
 * has to be settled before anyone looks at an outcome.
 */

export interface RowProvenance {
  readonly contextHash: string | null;
  readonly dataRegimeId: string | null;
  readonly rawPayloadHash: string | null;
  /** True only when BOTH legs of the trade were shown to be buildable. */
  readonly bothLegsBuildable: boolean | null;
  readonly diagnostic: ExitDiagnostic | null;

  // --- §9.3, the clauses that used to live only in prose -----------------
  /** When the position closed. Compared against the preregistration commit. */
  readonly closedUtcMs: number | null;
  /** Source commit of the run context. `+dirty` fails. */
  readonly sourceCommit: string | null;
  readonly strategyConfigHash: string | null;
  readonly riskPolicyHash: string | null;
  readonly schemaVersion: string | null;
  /** One family across both legs, or the legs describe different trades. */
  readonly entryRouteFamily: string | null;
  readonly exitRouteFamily: string | null;
  /** Both legs must name their observation. */
  readonly entryObservationId: string | null;
  readonly exitObservationId: string | null;
  /** The amount observed must be the amount entered. */
  readonly entryRequestedAmount: bigint | null;
  readonly entryFilledAmount: bigint | null;
  /** Full transaction policy, not only instruction policy. */
  readonly entryTransactionPolicy: string | null;
  readonly exitTransactionPolicy: string | null;
  readonly entrySimulation: string | null;
  readonly exitSimulation: string | null;
  /** Marks observed, and the widest gap between them. */
  readonly markCount: number | null;
  readonly maxMarkGapMs: number | null;
  /** ATA settlement must have been decided, not left unset. */
  readonly ataAccountingVersion: string | null;
  /** A position still holding tokens is not a closed trade. */
  readonly positionState: string | null;
  readonly residualTokenAmount: bigint | null;
}

export type Exclusion =
  | 'NO_CONTEXT'
  | 'NO_RAW_PAYLOAD'
  | 'NOT_BUILD_VALID'
  | 'DISQUALIFYING_DIAGNOSTIC'
  | 'MIXED_REGIME'
  | 'BEFORE_PREREGISTRATION'
  | 'DIRTY_SOURCE'
  | 'MISSING_HASHES'
  | 'MIXED_ROUTE_FAMILY'
  | 'MISSING_OBSERVATION'
  | 'AMOUNT_MISMATCH'
  | 'TRANSACTION_POLICY_NOT_PASSED'
  | 'NOT_SIMULATED'
  | 'INSUFFICIENT_MARKS'
  | 'MARK_GAP_TOO_WIDE'
  | 'ATA_UNSETTLED'
  | 'LIFECYCLE_VIOLATION';

export interface Admissibility {
  readonly admissible: boolean;
  readonly exclusions: readonly Exclusion[];
  readonly detail: string;
}

/**
 * A row that satisfies every clause.
 *
 * Exported for tests and for `scripts/`, so that a check of one clause varies
 * exactly one field. Writing seventeen fields by hand at each call site is how
 * a test ends up asserting the wrong thing about the wrong field.
 *
 * It is NOT a default. `admissible()` takes no partial and applies no fallback:
 * a caller that omits a field gets a compile error rather than a pass.
 */
export const ADMISSIBLE_TEMPLATE: RowProvenance = {
  contextHash: 'ctx',
  dataRegimeId: 'regime',
  rawPayloadHash: 'payload',
  bothLegsBuildable: true,
  diagnostic: 'NONE',
  closedUtcMs: 1,
  sourceCommit: 'abcdef',
  strategyConfigHash: 'cfg',
  riskPolicyHash: 'risk',
  schemaVersion: 'schema-v8',
  entryRouteFamily: 'BUILD_CUSTOM',
  exitRouteFamily: 'BUILD_CUSTOM',
  entryObservationId: 'obs-entry',
  exitObservationId: 'obs-exit',
  entryRequestedAmount: 20_000_000n,
  entryFilledAmount: 20_000_000n,
  entryTransactionPolicy: 'PASS',
  exitTransactionPolicy: 'PASS',
  entrySimulation: 'SIMULATED_OK',
  exitSimulation: 'SIMULATED_OK',
  markCount: 10,
  maxMarkGapMs: 11_000,
  ataAccountingVersion: 'ata-v1',
  positionState: 'POSITION_CLOSED',
  residualTokenAmount: 0n,
};

export interface AdmissibilityWindow {
  /** Nothing before this instant is confirmatory. */
  readonly preregistrationUtcMs: number;
  /** Widest permitted gap between marks. */
  readonly maxMarkGapMs: number;
  readonly minMarks: number;
}

export const DEFAULT_WINDOW: AdmissibilityWindow = {
  preregistrationUtcMs: 0,
  // Three mark intervals at the measured 10.5s cadence. A wider gap means the
  // position went unobserved for long enough that a collapse could have
  // happened entirely inside it — all eight measured collapses did.
  maxMarkGapMs: 32_000,
  minMarks: 2,
};

/**
 * Whether one row may enter a confirmatory result.
 *
 * §9.3 — this is the executable version. Every clause the preregistration
 * asserted in prose is checked here, because a rule that lives only in a
 * document is a rule that gets skipped, and because the previous version
 * checked four of seventeen while the document claimed all of them.
 *
 * Every condition is a REQUIREMENT and every unknown FAILS. `null` means nobody
 * asked, and a row nobody asked about is exactly the row the original corpus
 * was made of.
 */
export function admissible(row: RowProvenance, window: AdmissibilityWindow = DEFAULT_WINDOW): Admissibility {
  const exclusions: Exclusion[] = [];

  if (row.contextHash === null) exclusions.push('NO_CONTEXT');
  if (row.rawPayloadHash === null) exclusions.push('NO_RAW_PAYLOAD');
  if (row.bothLegsBuildable !== true) exclusions.push('NOT_BUILD_VALID');
  if (row.diagnostic !== null && disqualifiesFromConfirmatory(row.diagnostic)) {
    exclusions.push('DISQUALIFYING_DIAGNOSTIC');
  }

  // Timestamp after the preregistration commit.
  if (row.closedUtcMs === null || row.closedUtcMs < window.preregistrationUtcMs) {
    exclusions.push('BEFORE_PREREGISTRATION');
  }

  // A working tree that does not match its commit cannot be replayed, so a row
  // produced from one cannot be reproduced and is not evidence.
  if (row.sourceCommit === null || row.sourceCommit.endsWith('+dirty')) exclusions.push('DIRTY_SOURCE');

  if (row.strategyConfigHash === null || row.riskPolicyHash === null || row.schemaVersion === null) {
    exclusions.push('MISSING_HASHES');
  }

  // One family across both legs. Two families are two different trades.
  if (
    row.entryRouteFamily === null ||
    row.exitRouteFamily === null ||
    row.entryRouteFamily !== row.exitRouteFamily
  ) {
    exclusions.push('MIXED_ROUTE_FAMILY');
  }

  if (row.entryObservationId === null || row.exitObservationId === null) exclusions.push('MISSING_OBSERVATION');

  // The amount observed must be the amount entered — no probe scaling.
  if (
    row.entryRequestedAmount === null ||
    row.entryFilledAmount === null ||
    row.entryRequestedAmount !== row.entryFilledAmount
  ) {
    exclusions.push('AMOUNT_MISMATCH');
  }

  if (row.entryTransactionPolicy !== 'PASS' || row.exitTransactionPolicy !== 'PASS') {
    exclusions.push('TRANSACTION_POLICY_NOT_PASSED');
  }

  if (row.entrySimulation !== 'SIMULATED_OK' || row.exitSimulation !== 'SIMULATED_OK') {
    exclusions.push('NOT_SIMULATED');
  }

  if (row.markCount === null || row.markCount < window.minMarks) exclusions.push('INSUFFICIENT_MARKS');
  if (row.maxMarkGapMs === null || row.maxMarkGapMs > window.maxMarkGapMs) exclusions.push('MARK_GAP_TOO_WIDE');

  if (row.ataAccountingVersion === null) exclusions.push('ATA_UNSETTLED');

  // A position still holding tokens is not a closed trade, whatever its state
  // column says.
  if (row.positionState !== 'POSITION_CLOSED' || (row.residualTokenAmount ?? 0n) > 0n) {
    exclusions.push('LIFECYCLE_VIOLATION');
  }

  return {
    admissible: exclusions.length === 0,
    exclusions,
    detail:
      exclusions.length === 0
        ? 'every admissibility clause satisfied'
        : `excluded: ${exclusions.join(', ')}`,
  };
}

export class PoolingRefused extends Error {
  constructor(readonly regimes: readonly string[]) {
    super(
      `refusing to pool ${regimes.length} data regimes into one result: ${regimes.join(' | ')}. ` +
        'These rows were produced by different code, config, risk policy, cadence or buildability regime, ' +
        'and averaging them describes no experiment that was actually run.',
    );
    this.name = 'PoolingRefused';
  }
}

/**
 * Throw unless every row came from the same regime.
 *
 * Deliberately a throw rather than a warning. The reason the original corpus
 * pooled five regimes is that nothing stopped it, and a warning in a report
 * pipeline is a line of output nobody reads.
 */
export function requireSingleRegime(rows: readonly { dataRegimeId: string | null }[]): string {
  const regimes = [...new Set(rows.map((r) => r.dataRegimeId ?? 'UNTAGGED'))].sort();
  if (regimes.length > 1) throw new PoolingRefused(regimes);
  const only = regimes[0] ?? 'EMPTY';
  // §9.3 — a corpus of all-null contexts is not one regime. It is a corpus
  // that cannot say which regime it came from, and calling that "one" is how
  // 603 untagged marks would have passed a uniformity check by having no
  // information at all.
  if (only === 'UNTAGGED' && rows.length > 0) throw new PoolingRefused(['UNTAGGED (no row carries a run context)']);
  return only;
}

export class ResamplingUnitRefused extends Error {
  constructor(unit: string) {
    super(
      `refusing to resample at "${unit}": per-mark observations within one position are not independent trades. ` +
        'A position marked every 10.5 seconds for six minutes produces ~34 highly correlated rows, and treating ' +
        'them as 34 draws understates the standard error by roughly the square root of that. ' +
        'The unit of resampling is position/mint or UTC day.',
    );
    this.name = 'ResamplingUnitRefused';
  }
}

export const VALID_RESAMPLING_UNITS = ['position', 'mint', 'utc_day'] as const;
export type ResamplingUnit = (typeof VALID_RESAMPLING_UNITS)[number];

export function requireBlockUnit(unit: string): ResamplingUnit {
  if ((VALID_RESAMPLING_UNITS as readonly string[]).includes(unit)) return unit as ResamplingUnit;
  throw new ResamplingUnitRefused(unit);
}

export class TriggerQuoteReused extends Error {
  constructor(quoteId: string) {
    super(
      `refusing to fill a counterfactual exit at its own trigger quote (${quoteId}). ` +
        'The quote that caused the decision cannot also be the price received: acting takes time, and ' +
        'filling at the trigger grants a free look at a price that had already moved by the time an order ' +
        'could have reached the chain. Fill at the first LATER build-valid quote.',
    );
    this.name = 'TriggerQuoteReused';
  }
}

export interface CounterfactualMark {
  readonly markId: string;
  readonly quoteId: string | null;
  readonly observedUtcMs: number;
  readonly executableSellValueLamports: bigint | null;
  readonly routeBuildable: boolean | null;
}

export interface CounterfactualFill {
  readonly triggerMarkId: string;
  readonly fillMarkId: string;
  readonly fillUtcMs: number;
  readonly latencyAppliedMs: number;
  readonly proceedsLamports: bigint;
}

export type CounterfactualOutcome =
  | { readonly kind: 'filled'; readonly fill: CounterfactualFill }
  /** Triggered, and no build-valid quote existed afterwards. */
  | { readonly kind: 'exit_blocked'; readonly triggerMarkId: string; readonly reason: string }
  | { readonly kind: 'never_triggered' };

/**
 * Replay one policy over one position's marks.
 *
 * The rules are the directive's §8.3, and each is here because the natural
 * implementation gets it wrong in the flattering direction:
 *
 *  - trigger at the FIRST qualifying mark, not the best one;
 *  - apply measured decision/build/submission latency before filling;
 *  - fill at the first LATER BUILD-VALID quote, never at the trigger quote;
 *  - if no such quote exists, the outcome is EXIT_BLOCKED — not the last price
 *    we happened to see;
 *  - never forward-fill through a missing mark;
 *  - never let a future route rescue an earlier decision.
 *
 * `trigger` is evaluated on marks in order and must be a pure function of the
 * mark and everything before it. It is passed the index so a policy may look
 * backward; it cannot look forward, because it is never given the array.
 */
export function replayPolicy(
  marks: readonly CounterfactualMark[],
  trigger: (mark: CounterfactualMark, index: number) => boolean,
  latencyMs: number,
): CounterfactualOutcome {
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark === undefined || !trigger(mark, i)) continue;

    const earliestFillUtcMs = mark.observedUtcMs + latencyMs;

    for (let j = i + 1; j < marks.length; j++) {
      const candidate = marks[j];
      if (candidate === undefined) continue;
      if (candidate.observedUtcMs < earliestFillUtcMs) continue;
      // The trigger quote is not a fill price, however convenient.
      if (candidate.quoteId !== null && candidate.quoteId === mark.quoteId) {
        throw new TriggerQuoteReused(candidate.quoteId);
      }
      if (candidate.routeBuildable !== true) continue;
      if (candidate.executableSellValueLamports === null) continue;
      return {
        kind: 'filled',
        fill: {
          triggerMarkId: mark.markId,
          fillMarkId: candidate.markId,
          fillUtcMs: candidate.observedUtcMs,
          latencyAppliedMs: latencyMs,
          proceedsLamports: candidate.executableSellValueLamports,
        },
      };
    }

    return {
      kind: 'exit_blocked',
      triggerMarkId: mark.markId,
      reason: `no build-valid executable quote existed at or after ${new Date(earliestFillUtcMs).toISOString()}`,
    };
  }
  return { kind: 'never_triggered' };
}

/**
 * Group rows into resampling blocks.
 *
 * Returns blocks, never individual rows, so a caller cannot accidentally
 * bootstrap the flattened list. The unit is checked first and throws on a
 * mark-level request.
 */
export function blocksFor<T>(
  rows: readonly T[],
  unit: string,
  key: (row: T) => string,
): Map<string, T[]> {
  requireBlockUnit(unit);
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket === undefined) out.set(k, [row]);
    else bucket.push(row);
  }
  return out;
}

/**
 * The minimum sample the preregistration commits to before any policy may be
 * selected. Stated as code so that a report cannot quietly rank on nine trades.
 */
export const MIN_VALID_TRADES_FOR_SELECTION = 50;
export const MIN_DAYS_FOR_DEPLOYMENT_EVIDENCE = 21;
export const MIN_TRADES_FOR_DEPLOYMENT_EVIDENCE = 200;

export function mayRankPolicies(validTrades: number): { allowed: boolean; detail: string } {
  return validTrades >= MIN_VALID_TRADES_FOR_SELECTION
    ? { allowed: true, detail: `${validTrades} valid trades` }
    : {
        allowed: false,
        detail: `${validTrades} valid trades is below the preregistered minimum of ${MIN_VALID_TRADES_FOR_SELECTION}; ranking here selects noise`,
      };
}

export function mayCallDeploymentEvidence(
  validTrades: number,
  days: number,
): { allowed: boolean; detail: string } {
  const ok = validTrades >= MIN_TRADES_FOR_DEPLOYMENT_EVIDENCE && days >= MIN_DAYS_FOR_DEPLOYMENT_EVIDENCE;
  return {
    allowed: ok,
    detail: ok
      ? `${validTrades} trades over ${days} days`
      : `${validTrades}/${MIN_TRADES_FOR_DEPLOYMENT_EVIDENCE} trades and ${days}/${MIN_DAYS_FOR_DEPLOYMENT_EVIDENCE} days`,
  };
}
