import type { TrajectorySettlement, CashbackFacts } from '../../domain/src/trajectory-settlement.js';
import { buildTrajectorySettlement, checkIdentities, NO_CASHBACK } from '../../domain/src/trajectory-settlement.js';
import type { MeasuredLegSettlement } from '../../domain/src/settlement.js';
import {
  boundEntryImpact,
  haircutExitValue,
  type EntryImpactBound,
  type EvidenceGrade,
} from '../../domain/src/trajectory-evidence.js';

/**
 * P4 — the canonical trajectory kernel.
 *
 * One production-importable object owns the whole economic lifecycle. The
 * process shell owns startup, wiring, scheduling, health and shutdown, and
 * nothing else. Before this, the lifecycle lived inside `paper.ts` as a sequence
 * of steps that each re-derived what the previous one already knew, which is how
 * one row came to hold two entry costs and how a fill could verify one
 * observation and book another.
 *
 * THE IMMUTABLE ECONOMIC IDENTITY is the point. It is created once, at open, and
 * travels through mark, advance and settle unchanged. No method may substitute a
 * new observation into an existing identity — a different observation is a
 * different economic event and needs a different identity, because that is
 * exactly the substitution that made a fill mean nothing.
 */

export interface TrajectoryIdentity {
  readonly trajectoryId: string;
  readonly entryObservationId: string;
  readonly entrySimulationJobId: string;
  readonly entrySettlementId: string;
  readonly venue: string;
  readonly pool: string;
  readonly capabilityFingerprint: string;
  readonly snapshotHash: string;
  readonly mint: string;
  readonly cohort: string;
  readonly migrationAgeMs: number | null;
  readonly notionalLamports: bigint;
  readonly entryPolicyInputs: Readonly<Record<string, string | number | boolean | null>>;
  /** Which mechanics regime. Never pooled with another. */
  readonly stratum: string;
}

export class IdentitySubstituted extends Error {
  constructor(field: string, was: string, now: string) {
    super(
      `a trajectory's ${field} may not change: it was ${was.slice(0, 16)} and something tried to make it ${now.slice(0, 16)}. ` +
        'A different observation is a different economic event and needs a new identity.',
    );
    this.name = 'IdentitySubstituted';
  }
}

/** Throws rather than returning false: a substituted identity is not recoverable. */
export function assertSameIdentity(a: TrajectoryIdentity, b: TrajectoryIdentity): void {
  if (a.trajectoryId !== b.trajectoryId) throw new IdentitySubstituted('trajectoryId', a.trajectoryId, b.trajectoryId);
  if (a.entryObservationId !== b.entryObservationId) {
    throw new IdentitySubstituted('entryObservationId', a.entryObservationId, b.entryObservationId);
  }
  if (a.entrySimulationJobId !== b.entrySimulationJobId) {
    throw new IdentitySubstituted('entrySimulationJobId', a.entrySimulationJobId, b.entrySimulationJobId);
  }
  if (a.snapshotHash !== b.snapshotHash) throw new IdentitySubstituted('snapshotHash', a.snapshotHash, b.snapshotHash);
  if (a.pool !== b.pool) throw new IdentitySubstituted('pool', a.pool, b.pool);
  if (a.mint !== b.mint) throw new IdentitySubstituted('mint', a.mint, b.mint);
}

export type TrajectoryState =
  | 'OPEN'
  | 'AWAITING_FILL_OBSERVATION'
  | 'EXIT_BLOCKED'
  | 'SETTLED'
  | 'ABANDONED';

export interface TrajectoryMark {
  readonly observationId: string;
  readonly atMs: number;
  readonly executableLamports: bigint;
  /** Where the price came from. A router quote and a pool read are not the same. */
  readonly source: 'DIRECT_POOL' | 'ROUTER';
  readonly routeAvailable: boolean;
  /** Set when the mark could not be priced. Never collapsed to "no route". */
  readonly refusalReason: string | null;
}

export interface OpenTrajectoryInput {
  readonly identity: TrajectoryIdentity;
  readonly entry: MeasuredLegSettlement;
  /** Reserves at entry, for the counterfactual impact bound. */
  readonly entryReserves: {
    readonly effectiveQuoteLamports: bigint;
    readonly baseAtoms: bigint;
  };
}

export interface TrajectoryOpenResult {
  readonly identity: TrajectoryIdentity;
  readonly state: TrajectoryState;
  readonly impact: EntryImpactBound;
  /** The best grade this trajectory can ever reach, decided at open. */
  readonly maximumAttainableGrade: EvidenceGrade;
  readonly refusals: readonly string[];
}

export interface ObserveMarkInput {
  readonly identity: TrajectoryIdentity;
  readonly mark: TrajectoryMark;
}

export interface TrajectoryMarkResult {
  readonly accepted: boolean;
  readonly reason: string;
}

export interface AdvanceTrajectoryInput {
  readonly identity: TrajectoryIdentity;
  readonly state: TrajectoryState;
  /** Candidates that are already observed, simulated, effect-verified AND settled. */
  readonly settledCandidates: readonly {
    readonly observationId: string;
    readonly atMs: number;
    readonly settlement: MeasuredLegSettlement;
    readonly executable: boolean;
  }[];
  readonly triggeredAtMs: number;
  readonly minimumFillLatencyMs: number;
}

export interface TrajectoryAdvanceResult {
  readonly state: TrajectoryState;
  /** The observation actually selected. Everything downstream must use THIS. */
  readonly selectedObservationId: string | null;
  readonly exit: MeasuredLegSettlement | null;
  readonly reason: string;
}

export interface SettleTrajectoryInput {
  readonly identity: TrajectoryIdentity;
  readonly entry: MeasuredLegSettlement;
  readonly exit: MeasuredLegSettlement | null;
  readonly impact: EntryImpactBound;
  readonly evidenceGrade: EvidenceGrade;
  readonly cashback?: CashbackFacts;
  readonly failedAttemptFeesLamports?: bigint;
  readonly venueFeeDecompositionKnown?: boolean;
}

export interface SettledTrajectory {
  readonly identity: TrajectoryIdentity;
  readonly settlement: TrajectorySettlement;
  readonly evidenceGrade: EvidenceGrade;
  readonly impact: EntryImpactBound;
  /** The counterfactual exit AFTER the entry-impact haircut, when one applies. */
  readonly haircutExitCashInLamports: bigint | null;
  readonly identityViolations: readonly string[];
}

export interface TrajectoryKernel {
  open(input: OpenTrajectoryInput): TrajectoryOpenResult;
  observeMark(input: ObserveMarkInput): TrajectoryMarkResult;
  advance(input: AdvanceTrajectoryInput): TrajectoryAdvanceResult;
  settle(input: SettleTrajectoryInput): SettledTrajectory;
}

/**
 * The kernel.
 *
 * Deliberately synchronous and stateless-per-call: every input it needs is
 * passed in, so it can be exercised by a test with no database, no network and
 * no clock. The shell does the I/O; the kernel decides the economics.
 */
export function createTrajectoryKernel(): TrajectoryKernel {
  return {
    open(input) {
      const refusals: string[] = [];
      const acquired =
        input.entry.output.kind === 'token' ? input.entry.output.actualCreditAtoms : 0n;
      const spent =
        input.entry.input.kind === 'native_sol' ? input.entry.input.actualTradeDebitLamports : 0n;

      const impact = boundEntryImpact({
        entryQuoteInLamports: spent,
        effectiveQuoteReserveLamports: input.entryReserves.effectiveQuoteLamports,
        tokensAcquiredAtoms: acquired,
        baseReserveAtoms: input.entryReserves.baseAtoms,
      });

      if (acquired === 0n) refusals.push('the entry acquired no tokens, so there is nothing to exit');
      if (!impact.withinSmallImpactBound) {
        refusals.push(
          `the entry moves the pool by ${(impact.maxImpactRatio * 100).toFixed(3)}%, above the ${(impact.boundUsed * 100).toFixed(3)}% ` +
            'small-impact bound, so a future mainnet state cannot stand in for its counterfactual exit',
        );
      }

      /**
       * The ceiling is decided at OPEN, not at report time.
       *
       * A trajectory whose entry moves the pool too much can never be
       * `BOUNDED_COUNTERFACTUAL` however well it is measured afterwards, because
       * the future state it would be evaluated against never contained the
       * entry. Deciding this later is how a weak trajectory gets counted as a
       * strong one once the number looks good.
       */
      const maximumAttainableGrade: EvidenceGrade = impact.withinSmallImpactBound
        ? 'BOUNDED_COUNTERFACTUAL'
        : 'SIMULATED_EXECUTION';

      return {
        identity: input.identity,
        state: refusals.length > 0 && acquired === 0n ? 'ABANDONED' : 'OPEN',
        impact,
        maximumAttainableGrade,
        refusals,
      };
    },

    observeMark(input) {
      if (!input.mark.routeAvailable || input.mark.refusalReason !== null) {
        return {
          accepted: false,
          reason: input.mark.refusalReason ?? 'the mark carried no route',
        };
      }
      if (input.mark.executableLamports <= 0n) {
        return { accepted: false, reason: 'the mark priced the position at zero, which is not a fill candidate' };
      }
      if (input.mark.observationId === input.identity.entryObservationId) {
        // Marking against the entry's own observation would make the exit and
        // the entry the same economic event.
        return { accepted: false, reason: 'a mark may not reuse the entry observation' };
      }
      return { accepted: true, reason: `marked at ${input.mark.executableLamports} lamports from ${input.mark.source}` };
    },

    /**
     * Select a later fill.
     *
     * The ordering is the whole point, and it is the one the previous build got
     * wrong. A candidate must already be observed, simulated, effect-verified
     * AND settled before it is eligible. Then the FIRST eligible candidate after
     * the latency floor is selected, and the caller books THAT observation.
     *
     * Never: select A, simulate B, book A.
     */
    advance(input) {
      const eligible = input.settledCandidates
        .filter((c) => c.atMs >= input.triggeredAtMs + input.minimumFillLatencyMs)
        .filter((c) => c.executable)
        .sort((a, b) => a.atMs - b.atMs);

      const chosen = eligible[0];
      if (chosen === undefined) {
        const observedButUnusable = input.settledCandidates.length;
        return {
          state: 'AWAITING_FILL_OBSERVATION',
          selectedObservationId: null,
          exit: null,
          reason:
            observedButUnusable === 0
              ? 'no later observation has been settled yet'
              : `${observedButUnusable} later observation(s) exist but none is both executable and past the ${input.minimumFillLatencyMs}ms latency floor`,
        };
      }

      // The selected candidate's OWN settlement, never a neighbour's and never a
      // router quote standing in for one.
      return {
        state: 'SETTLED',
        selectedObservationId: chosen.observationId,
        exit: chosen.settlement,
        reason: `filled on observation ${chosen.observationId.slice(0, 12)} at +${chosen.atMs - input.triggeredAtMs}ms`,
      };
    },

    settle(input) {
      const settlement = buildTrajectorySettlement({
        trajectoryId: input.identity.trajectoryId,
        entry: input.entry,
        exit: input.exit,
        cashback: input.cashback ?? NO_CASHBACK,
        failedAttemptFeesLamports: input.failedAttemptFeesLamports,
        venueFeeDecompositionKnown: input.venueFeeDecompositionKnown,
      });

      // The haircut applies to counterfactual evidence only. A landed fill needs
      // no haircut because the entry's effect is already in the price it got.
      const needsHaircut =
        input.evidenceGrade === 'BOUNDED_COUNTERFACTUAL' && settlement.exitCashInLamports !== null;
      const haircutExitCashInLamports = needsHaircut
        ? haircutExitValue(settlement.exitCashInLamports as bigint, input.impact.haircutBps)
        : null;

      const check = checkIdentities(settlement);

      return {
        identity: input.identity,
        settlement,
        evidenceGrade: input.evidenceGrade,
        impact: input.impact,
        haircutExitCashInLamports,
        identityViolations: check.violations,
      };
    },
  };
}
