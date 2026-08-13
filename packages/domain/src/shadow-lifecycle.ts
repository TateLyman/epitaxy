import { EVIDENCE_CLASSES, type EvidenceClass } from './evidence.js';

/**
 * P11 — the shadow exit state machine, and evidence that cannot be rewritten.
 *
 * Two rules do the work here.
 *
 * **A shadow may not close at its trigger observation.** Same reason a
 * portfolio position may not: the observation that says "get out" is not the
 * price you get out at, and treating it as one makes every stop look like it
 * worked.
 *
 * **Evidence is immutable at each event.** A position is promoted by creating a
 * NEW evidence event, never by editing what an old one meant. Otherwise a
 * shadow opened when nothing was effect-verified silently becomes
 * `JIT_EFFECT_VALID` the moment some later run of the same observation passes,
 * and the corpus quietly improves its own past.
 */

export type ShadowState =
  | 'POSITION_OPEN'
  | 'EXIT_TRIGGERED'
  | 'AWAITING_FILL_OBSERVATION'
  | 'EXIT_BLOCKED'
  | 'POSITION_CLOSED';

/** Which transitions exist. Everything absent from here is a defect. */
const ALLOWED: Readonly<Record<ShadowState, readonly ShadowState[]>> = {
  POSITION_OPEN: ['EXIT_TRIGGERED'],
  // A trigger goes to awaiting, never straight to closed. The gap between them
  // is the fill, and a machine that can skip it is a machine that fills at the
  // trigger price.
  EXIT_TRIGGERED: ['AWAITING_FILL_OBSERVATION'],
  AWAITING_FILL_OBSERVATION: ['POSITION_CLOSED', 'EXIT_BLOCKED'],
  // Blocked is not terminal. The tokens are still held and the retries continue.
  EXIT_BLOCKED: ['AWAITING_FILL_OBSERVATION', 'POSITION_CLOSED'],
  POSITION_CLOSED: [],
};

export class IllegalShadowTransition extends Error {
  constructor(from: ShadowState, to: ShadowState, why: string) {
    super(`${from} -> ${to} is not a legal shadow transition: ${why}`);
    this.name = 'IllegalShadowTransition';
  }
}

export function canTransition(from: ShadowState, to: ShadowState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: ShadowState, to: ShadowState): void {
  if (canTransition(from, to)) return;
  const why =
    from === 'EXIT_TRIGGERED' && to === 'POSITION_CLOSED'
      ? 'a shadow may not close at its trigger observation; it must await a later fill'
      : from === 'POSITION_CLOSED'
        ? 'a closed position is terminal'
        : `only ${(ALLOWED[from] ?? []).join(', ') || 'nothing'} is reachable from here`;
  throw new IllegalShadowTransition(from, to, why);
}

/** Whether a state still carries exposure. Blocked does. */
export function holdsExposure(state: ShadowState): boolean {
  return state !== 'POSITION_CLOSED';
}

/**
 * One immutable evidence event.
 *
 * Appended, never edited. The class a position qualifies for is the class of
 * its LATEST event, and its history stays readable.
 */
export interface EvidenceEvent {
  readonly at: number;
  readonly evidenceClass: EvidenceClass;
  readonly reason: string;
}

/**
 * Promote by appending, and refuse to demote silently.
 *
 * A promotion is a new fact: a later run established something the earlier one
 * had not. A DEMOTION is different — it means an earlier claim was wrong, and
 * that is worth refusing here so it has to be done deliberately rather than as
 * a side effect of a re-run.
 */
export function promote(
  history: readonly EvidenceEvent[],
  next: EvidenceEvent,
): readonly EvidenceEvent[] {
  const current = history[history.length - 1];
  if (current === undefined) return [next];
  const from = EVIDENCE_CLASSES.indexOf(current.evidenceClass);
  const to = EVIDENCE_CLASSES.indexOf(next.evidenceClass);
  if (to < from) {
    throw new Error(
      `refusing to silently demote ${current.evidenceClass} to ${next.evidenceClass}: ` +
        'an earlier claim being wrong is a correction, not a promotion, and it must be made deliberately',
    );
  }
  // Re-asserting the same class is a no-op rather than a duplicate row.
  if (to === from) return history;
  return [...history, next];
}

/** The class in force: the latest event's, or structural when there is none. */
export function currentClass(history: readonly EvidenceEvent[]): EvidenceClass {
  return history[history.length - 1]?.evidenceClass ?? 'STRUCTURAL_ONLY';
}

/**
 * P11 — how urgently a shadow needs marking.
 *
 * Peak alone was the old answer and it is the wrong one: a position at its peak
 * is the one LEAST likely to need attention, and one sitting just above its
 * stop is the most. Distance to each boundary is what matters, and time to max
 * hold is a boundary too.
 *
 * Lower is more urgent.
 */
export interface TriggerDistance {
  readonly executableLamports: bigint | null;
  readonly peakLamports: bigint;
  readonly costLamports: bigint;
  readonly stopBps: number;
  readonly trailBps: number;
  readonly takeProfitBps: number;
  readonly ageMs: number;
  readonly maxHoldMs: number;
}

export function nearTrigger(d: TriggerDistance): number {
  // Unpriced is the MOST urgent thing there is: a position nobody can value is
  // one nobody can exit, and it stays that way until somebody looks.
  if (d.executableLamports === null) return 0;

  const bpsTo = (target: bigint): number => {
    if (d.executableLamports === null || d.executableLamports <= 0n) return 0;
    const diff = d.executableLamports - target;
    return Number((diff * 10_000n) / d.executableLamports);
  };

  const stopAt = (d.costLamports * BigInt(10_000 - d.stopBps)) / 10_000n;
  const trailAt = (d.peakLamports * BigInt(10_000 - d.trailBps)) / 10_000n;
  const takeAt = (d.costLamports * BigInt(10_000 + d.takeProfitBps)) / 10_000n;

  const distances = [
    Math.abs(bpsTo(stopAt)),
    Math.abs(bpsTo(trailAt)),
    Math.abs(bpsTo(takeAt)),
    // Time, on the same scale: a position at 90% of its maximum hold is as
    // close to an exit as one 1,000 bps from its stop.
    d.maxHoldMs <= 0 ? 10_000 : Math.max(0, Math.round(((d.maxHoldMs - d.ageMs) / d.maxHoldMs) * 10_000)),
  ];
  return Math.min(...distances);
}

/** Scheduling order. Blocked first, newest last. */
export function schedulePriority(state: ShadowState, distanceBps: number, overdueMs: number): number {
  const tier =
    state === 'EXIT_BLOCKED'
      ? 0
      : state === 'EXIT_TRIGGERED' || state === 'AWAITING_FILL_OBSERVATION'
        ? 1
        : distanceBps < 500
          ? 2
          : 3;
  // Within a tier, the most overdue first. Negated so a larger lag sorts
  // earlier under a plain ascending sort.
  return tier * 1_000_000_000 - overdueMs;
}
