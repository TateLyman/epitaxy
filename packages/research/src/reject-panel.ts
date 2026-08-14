import { createHash } from 'node:crypto';

/**
 * P15 — a prospective reject panel.
 *
 * The panel this replaces evaluated historical rejections against CURRENT state,
 * which cannot answer the question it was asked. A token rejected a week ago and
 * now worthless looks like a correct rejection whether or not it tripled first;
 * a token rejected and now up 10x looks like a false negative even if it was
 * unsellable throughout. Both readings come from looking at the end of the path
 * instead of the path.
 *
 * So the sample is taken AT REJECTION TIME, at a preregistered probability, and
 * the trajectory is followed forward like any other. Classification happens
 * later, from evidence collected in between.
 */

export type RejectOutcome =
  | 'PROFITABLE_EXECUTABLE'
  | 'UNPROFITABLE_EXECUTABLE'
  | 'CATASTROPHIC'
  | 'BLOCKED_EXIT'
  | 'NO_SUPPORTED_VENUE'
  | 'PROVIDER_GAP'
  | 'APPARATUS_FAILURE'
  | 'UNKNOWN';

/**
 * "No canonical PumpSwap pool" is a statement about OUR supported venues.
 *
 * The old label was "no route", which reads as a fact about the token — that
 * nobody would trade it. Measured on the corpus, ~98% of screened mints have no
 * canonical pool, so under the old label almost the entire reject panel said
 * "the market refused" when it meant "we support one venue".
 */
export const NO_SUPPORTED_DIRECT_PUMPSWAP_VENUE = 'NO_SUPPORTED_VENUE' as const;

export interface RejectSample {
  readonly sampleId: string;
  readonly mint: string;
  readonly rejectedAtUtcMs: number;
  readonly rejectReason: string;
  /** Preregistered. Recorded so the sample can be reweighted honestly. */
  readonly inclusionProbability: number;
  readonly decisionSnapshotId: string;
  readonly coherentSnapshotHash: string | null;
  readonly preEntryFacts: Readonly<Record<string, string | number | boolean | null>>;
  readonly directMechanicsViable: boolean | null;
  readonly providerHealthOk: boolean;
}

/**
 * Deterministic in (seed, mint, rejection time).
 *
 * Reproducible, and — because the rejection timestamp is in the key — a token
 * rejected twice gets two independent draws rather than the same one, so
 * repeated rejections do not systematically appear or vanish together.
 */
export function shouldSampleRejection(seed: string, mint: string, rejectedAtUtcMs: number, probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  const h = createHash('sha256').update(seed).update(':').update(mint).update(':').update(String(rejectedAtUtcMs)).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000 < probability;
}

export interface RejectFollowUp {
  readonly sampleId: string;
  /** The shared later mark stream, same as any tracked trajectory. */
  readonly marks: readonly { atMs: number; executableLamports: bigint | null }[];
  readonly laterFillable: boolean | null;
  readonly fixedHorizonExecutableLamports: bigint | null;
  readonly entryCostLamports: bigint | null;
  readonly apparatusFailed: boolean;
  readonly providerGap: boolean;
  readonly supportedVenueExists: boolean;
  readonly exitBlocked: boolean;
}

/**
 * Classify from what was collected, and refuse to guess.
 *
 * Order matters: apparatus and provider failures are checked FIRST, because a
 * trajectory that failed for our reasons must never be recorded as a market
 * outcome. That substitution is how an instrument's own failure rate becomes
 * evidence about a strategy.
 */
export function classifyRejection(f: RejectFollowUp): { outcome: RejectOutcome; reason: string } {
  if (f.apparatusFailed) {
    return { outcome: 'APPARATUS_FAILURE', reason: 'our instrument failed; this says nothing about the token' };
  }
  if (f.providerGap) {
    return { outcome: 'PROVIDER_GAP', reason: 'a provider did not answer; absence of data is not absence of opportunity' };
  }
  if (!f.supportedVenueExists) {
    return {
      outcome: 'NO_SUPPORTED_VENUE',
      reason: 'no canonical PumpSwap pool: a fact about the venues WE support, not about the token',
    };
  }
  if (f.exitBlocked) {
    return { outcome: 'BLOCKED_EXIT', reason: 'an exit could not be built or verified' };
  }
  if (f.fixedHorizonExecutableLamports === null || f.entryCostLamports === null) {
    return { outcome: 'UNKNOWN', reason: 'the fixed-horizon executable value or the entry cost was never measured' };
  }
  const net = f.fixedHorizonExecutableLamports - f.entryCostLamports;
  if (net > 0n) {
    return { outcome: 'PROFITABLE_EXECUTABLE', reason: `${net} lamports at the frozen horizon` };
  }
  // A total loss is its own class: it is the one that governs risk sizing, and
  // pooling it with ordinary losses hides the tail that matters most.
  if (f.fixedHorizonExecutableLamports * 10n <= f.entryCostLamports) {
    return { outcome: 'CATASTROPHIC', reason: 'the position retained under a tenth of its entry cost' };
  }
  return { outcome: 'UNPROFITABLE_EXECUTABLE', reason: `${net} lamports at the frozen horizon` };
}

export class PanelVersionReused extends Error {
  constructor(version: string) {
    super(
      `refusing to report gate performance on panel version ${version}, which is the version the gate was tuned on. ` +
        'A gate scored on the data that shaped it measures memory, not skill.',
    );
    this.name = 'PanelVersionReused';
  }
}

/** Do not tune a gate on panel version N and report its performance on N. */
export function assertPanelNotReused(tunedOn: string, reportingOn: string): void {
  if (tunedOn === reportingOn) throw new PanelVersionReused(reportingOn);
}

export function tallyOutcomes(
  outcomes: readonly RejectOutcome[],
): Readonly<Record<RejectOutcome, number>> {
  const out: Record<RejectOutcome, number> = {
    PROFITABLE_EXECUTABLE: 0,
    UNPROFITABLE_EXECUTABLE: 0,
    CATASTROPHIC: 0,
    BLOCKED_EXIT: 0,
    NO_SUPPORTED_VENUE: 0,
    PROVIDER_GAP: 0,
    APPARATUS_FAILURE: 0,
    UNKNOWN: 0,
  };
  for (const o of outcomes) out[o] += 1;
  return out;
}

/**
 * The false-negative rate, over the trajectories that could actually answer it.
 *
 * Apparatus failures, provider gaps and unsupported venues are EXCLUDED from
 * the denominator, not counted as correct rejections. They are rows where the
 * question was never asked, and putting them in the denominator makes a gate
 * look better the more often the instrument breaks.
 */
export function falseNegativeRate(
  tally: Readonly<Record<RejectOutcome, number>>,
): { rate: number | null; answerable: number; excluded: number; reason: string } {
  const answerable =
    tally.PROFITABLE_EXECUTABLE + tally.UNPROFITABLE_EXECUTABLE + tally.CATASTROPHIC + tally.BLOCKED_EXIT;
  const excluded = tally.NO_SUPPORTED_VENUE + tally.PROVIDER_GAP + tally.APPARATUS_FAILURE + tally.UNKNOWN;
  if (answerable === 0) {
    return { rate: null, answerable, excluded, reason: 'no sampled rejection produced an answerable outcome' };
  }
  return {
    rate: tally.PROFITABLE_EXECUTABLE / answerable,
    answerable,
    excluded,
    reason: `${tally.PROFITABLE_EXECUTABLE} of ${answerable} answerable; ${excluded} excluded as unanswerable`,
  };
}
