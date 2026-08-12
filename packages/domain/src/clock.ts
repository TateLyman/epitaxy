/**
 * Two clocks, with the jobs kept apart.
 *
 * P2a.1 §P3.1. Everything in this engine was scheduled off `Date.now()`:
 * mark cadence, discovery cadence, timeouts, stale-lock detection, quote
 * latency. Wall time is the wrong clock for all five, and the failure is not
 * theoretical on a workstation that sleeps:
 *
 *  - an NTP correction of -400ms makes the next tick fire 400ms late, or twice;
 *  - a laptop resuming after two hours makes `now - lastTick` two hours, so the
 *    loop fires immediately, then again, then again — a cadence burst against a
 *    0.5 RPS rate limit;
 *  - a stale-lock threshold measured in wall time can be crossed by a clock
 *    change alone, and a second engine then takes a lock the first still holds;
 *  - a quote "latency" spanning a clock correction is not a latency.
 *
 * `process.hrtime.bigint()` is CLOCK_MONOTONIC. It never goes backwards and is
 * unaffected by NTP or by an operator setting the clock. On every platform we
 * run on it also does NOT advance while the machine is suspended, which is what
 * makes the wall-versus-monotonic comparison a sleep detector rather than just
 * a drift detector.
 *
 * Division of labour, enforced by which function you can reach:
 *
 *   monotonicMs()  cadence, timeouts, stale locks, latency
 *   wallUtcMs()    logging, UTC day boundaries, human reports
 *
 * Both are recorded together at every checkpoint so the pair can be compared.
 * A checkpoint that stores only one of them cannot detect anything.
 */

export const CLOCK_VERSION = 'clock-v1';

/**
 * Milliseconds from an arbitrary origin, monotonically non-decreasing.
 *
 * Fractional. Kept as a float rather than a bigint because it is only ever
 * subtracted from another reading of itself — it is a duration, not money.
 */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1_000;
}

/** Wall-clock UTC milliseconds. For humans and for calendar days only. */
export function wallUtcMs(): number {
  return Date.now();
}

export interface ClockReading {
  readonly monotonicMs: number;
  readonly wallUtcMs: number;
}

export function readClock(): ClockReading {
  // Read monotonic first and wall second, so the wall reading is never older
  // than the monotonic one it is compared against.
  return { monotonicMs: monotonicMs(), wallUtcMs: wallUtcMs() };
}

export type Discontinuity =
  /** Wall time ran ahead of monotonic: suspend/resume, or the clock was set forward. */
  | 'WALL_JUMPED_FORWARD'
  /** Wall time ran behind monotonic: the clock was set back, or a large NTP step. */
  | 'WALL_JUMPED_BACKWARD'
  /** Monotonic went backwards. Should be impossible; reported, never ignored. */
  | 'MONOTONIC_REGRESSED';

export interface SkewVerdict {
  readonly discontinuity: Discontinuity | null;
  readonly wallDeltaMs: number;
  readonly monotonicDeltaMs: number;
  /** wallDelta - monotonicDelta. Positive means wall ran ahead. */
  readonly skewMs: number;
  readonly detail: string;
}

/**
 * Default tolerance before a skew is called a discontinuity.
 *
 * Two seconds. Ordinary NTP slewing is measured in milliseconds and scheduling
 * jitter under load in tens of milliseconds, so this is roughly two orders of
 * magnitude above the noise floor while still being far shorter than any
 * suspend a human would perform.
 */
export const DEFAULT_SKEW_THRESHOLD_MS = 2_000;

/**
 * Compare two checkpoints.
 *
 * Pure, so the sleep/resume path is testable without suspending a machine.
 */
export function detectDiscontinuity(
  before: ClockReading,
  after: ClockReading,
  thresholdMs: number = DEFAULT_SKEW_THRESHOLD_MS,
): SkewVerdict {
  const wallDeltaMs = after.wallUtcMs - before.wallUtcMs;
  const monotonicDeltaMs = after.monotonicMs - before.monotonicMs;
  const skewMs = wallDeltaMs - monotonicDeltaMs;

  if (monotonicDeltaMs < 0) {
    return {
      discontinuity: 'MONOTONIC_REGRESSED',
      wallDeltaMs,
      monotonicDeltaMs,
      skewMs,
      detail: `monotonic clock went backwards by ${(-monotonicDeltaMs).toFixed(0)}ms; the platform clock cannot be trusted`,
    };
  }

  if (skewMs > thresholdMs) {
    return {
      discontinuity: 'WALL_JUMPED_FORWARD',
      wallDeltaMs,
      monotonicDeltaMs,
      skewMs,
      detail:
        `wall clock advanced ${wallDeltaMs.toFixed(0)}ms while monotonic advanced ${monotonicDeltaMs.toFixed(0)}ms ` +
        `(skew ${skewMs.toFixed(0)}ms); consistent with suspend/resume or a forward clock step`,
    };
  }

  if (-skewMs > thresholdMs) {
    return {
      discontinuity: 'WALL_JUMPED_BACKWARD',
      wallDeltaMs,
      monotonicDeltaMs,
      skewMs,
      detail:
        `wall clock advanced ${wallDeltaMs.toFixed(0)}ms while monotonic advanced ${monotonicDeltaMs.toFixed(0)}ms ` +
        `(skew ${skewMs.toFixed(0)}ms); the clock was set backwards`,
    };
  }

  return { discontinuity: null, wallDeltaMs, monotonicDeltaMs, skewMs, detail: '' };
}

/**
 * A cadence driven by the monotonic clock.
 *
 * `due(now)` answers whether the interval has elapsed; `fired(now)` records
 * that it did. Two calls rather than one so that a caller which decides NOT to
 * do the work does not accidentally consume the slot.
 *
 * There is deliberately no catch-up: after a long stall the next tick is
 * scheduled from NOW, not from the missed deadline. The alternative — firing
 * once per missed interval — is exactly the burst that a resumed laptop would
 * aim at a 0.5 RPS rate limit.
 */
export class Cadence {
  private last: number | null = null;

  constructor(
    readonly intervalMs: number,
    readonly name: string,
  ) {
    if (!(intervalMs > 0)) throw new Error(`cadence ${name} needs a positive interval, got ${intervalMs}`);
  }

  /** True when the interval has elapsed, and on the very first call. */
  due(nowMonotonicMs: number): boolean {
    return this.last === null || nowMonotonicMs - this.last >= this.intervalMs;
  }

  fired(nowMonotonicMs: number): void {
    this.last = nowMonotonicMs;
  }

  /** Milliseconds until the next firing; 0 when already due. */
  remainingMs(nowMonotonicMs: number): number {
    if (this.last === null) return 0;
    const left = this.intervalMs - (nowMonotonicMs - this.last);
    return left > 0 ? left : 0;
  }

  /**
   * Forget the last firing without firing.
   *
   * Used after a clock discontinuity: the previous reading is from before the
   * gap and its age is meaningless, so it is discarded rather than reasoned
   * with.
   */
  reset(): void {
    this.last = null;
  }
}

/** Midnight UTC of the day containing `utcMs`. Wall time, correctly. */
export function utcDayStart(utcMs: number): number {
  return new Date(utcMs).setUTCHours(0, 0, 0, 0);
}

/** `YYYY-MM-DD` for the UTC day containing `utcMs`. The persisted day key. */
export function utcDateKey(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** Whole UTC days between two instants; 0 when they share a day. */
export function utcDaysBetween(fromUtcMs: number, toUtcMs: number): number {
  return Math.round((utcDayStart(toUtcMs) - utcDayStart(fromUtcMs)) / 86_400_000);
}
