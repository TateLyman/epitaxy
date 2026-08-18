/**
 * P6 — TWO primary entry clocks, paired within a mint.
 *
 * The collector's only entry was "as soon as the migration is mechanically
 * valid", which buys with essentially no post-migration confirmation. A delayed
 * entry trades optionality for information: 120 seconds later we know whether
 * anyone independent kept buying, whether the creator started selling, and
 * whether the reserve held — at the cost of whatever the price did in the
 * meantime.
 *
 * That is a real economic question and it is worth exactly one extra treatment.
 *
 *     T0     first mechanically valid confirmed post-migration state
 *     T120   120 seconds after migration, if still mechanically viable
 *
 * Not ten delays. A grid over delays would spend the multiple-testing budget on
 * a dimension where the answer is nearly continuous, and with a sample this
 * size the winner of a ten-way search is noise. Two clocks can be paired within
 * a mint, which removes the token-selection variance that dominates everything
 * else at this sample size.
 *
 * 30s/60s/180s/300s are recorded as DESCRIPTIVE snapshots. They are not entry
 * treatments and no inference may be drawn from them without a new
 * preregistration — otherwise they become six delays by the back door.
 */

export const PRIMARY_ENTRY_CLOCKS = ['T0', 'T120'] as const;
export type EntryClock = (typeof PRIMARY_ENTRY_CLOCKS)[number];

export const ENTRY_CLOCK_OFFSET_MS: Readonly<Record<EntryClock, number>> = {
  T0: 0,
  T120: 120_000,
};

/** Descriptive only. Never an entry treatment in this experiment. */
export const DESCRIPTIVE_OFFSETS_MS: readonly number[] = [30_000, 60_000, 180_000, 300_000];

/**
 * Facts that must be RECOMPUTED at each clock, never inherited.
 *
 * A stale migration-time fact substituted at T120 would make the two clocks
 * differ only in their timestamp — the delayed arm would be the immediate arm
 * wearing a later label, and the experiment would measure nothing. Every item
 * here is something that genuinely changes in two minutes.
 */
export const RECOMPUTED_AT_EVERY_CLOCK: readonly string[] = [
  'riskFacts',
  'exactMechanics',
  'feeTier',
  'cashbackState',
  'entityFlow',
  'creatorFlow',
];

export class EntryClockViolation extends Error {}

export interface ClockDecision {
  readonly opportunityId: string;
  readonly mint: string;
  readonly entryClock: EntryClock;
  /** The decision-time snapshot. MUST differ between clocks. */
  readonly snapshotHash: string;
  readonly decisionUtcMs: number;
  readonly migrationUtcMs: number;
  readonly mechanicallyViable: boolean;
  readonly refusal: string | null;
}

/**
 * Refuse a T0/T120 pair that shares a decision-time snapshot.
 *
 * Two clocks reading one snapshot is the single most likely way this
 * experiment silently becomes a no-op: the snapshot is expensive, reusing it is
 * the obvious optimisation, and the resulting rows look completely normal. The
 * check is cheap and it is the difference between a paired treatment and a
 * relabelling.
 */
export function assertDistinctSnapshots(pair: readonly ClockDecision[]): void {
  const byClock = new Map<EntryClock, ClockDecision>();
  for (const d of pair) {
    const prior = byClock.get(d.entryClock);
    if (prior !== undefined) {
      throw new EntryClockViolation(`two decisions for clock ${d.entryClock} on mint ${d.mint}`);
    }
    byClock.set(d.entryClock, d);
  }
  const t0 = byClock.get('T0');
  const t120 = byClock.get('T120');
  if (t0 === undefined || t120 === undefined) return; // an unpaired clock is legal
  if (t0.snapshotHash === t120.snapshotHash) {
    throw new EntryClockViolation(
      `T0 and T120 for mint ${t0.mint} share snapshot ${t0.snapshotHash}: ` +
        'a delayed entry that reuses the immediate entry\'s state is not a delayed entry',
    );
  }
  if (t120.decisionUtcMs <= t0.decisionUtcMs) {
    throw new EntryClockViolation(
      `T120 for mint ${t0.mint} decided at or before T0 (${t120.decisionUtcMs} <= ${t0.decisionUtcMs})`,
    );
  }
}

/**
 * Refuse a decision built from anything observed after it.
 *
 * `observationUtcMs` is when the input was measured; `decisionUtcMs` is when
 * the decision claims to have been made. An input from after the decision is
 * leakage, and at T120 it is a specific and very tempting kind: the 180s
 * descriptive snapshot is already being collected on the same token, it is
 * sitting in the same structure, and using it would improve T120's apparent
 * performance enormously.
 */
export function assertNoFutureInput(
  decisionUtcMs: number,
  inputs: readonly { name: string; observationUtcMs: number }[],
): void {
  const future = inputs.filter((i) => i.observationUtcMs > decisionUtcMs);
  if (future.length > 0) {
    throw new EntryClockViolation(
      `decision at ${decisionUtcMs} used ${future.length} input(s) observed after it: ` +
        future.map((f) => `${f.name}@${f.observationUtcMs}`).join(', '),
    );
  }
}

/**
 * When each clock is due, from the migration instant.
 *
 * A T120 that fires late is still T120 as long as the token is still
 * mechanically viable — the clock names the treatment, and the actual age is
 * recorded separately so an analysis can see how late the arm really ran.
 */
export function clockDueUtcMs(migrationUtcMs: number, clock: EntryClock): number {
  return migrationUtcMs + ENTRY_CLOCK_OFFSET_MS[clock];
}

export function ageSinceMigrationMs(decisionUtcMs: number, migrationUtcMs: number): number {
  return decisionUtcMs - migrationUtcMs;
}
