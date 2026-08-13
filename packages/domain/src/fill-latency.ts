/**
 * P10 — the trigger observation is never its own fill.
 *
 * A stop that triggers at observation T and fills at T's price is a backtest
 * that reacts instantly and at no cost. Real execution has to notice, build,
 * sign and land, and the price moves during all four. Filling at the trigger
 * price makes every stop look like it worked and makes a collapse look
 * survivable, which is exactly backwards: the faster the price is falling, the
 * larger the gap between the trigger and the fill.
 *
 * So the fill is the FIRST LATER observation that is at least the frozen
 * latency after the trigger, and it must be effect-valid in its own right. If
 * there is no such observation, the position is `EXIT_BLOCKED` — the tokens are
 * still held and the exposure is still ours.
 */

/** Candidate observations, oldest first. */
export interface FillCandidate {
  readonly observationId: string;
  readonly observedUtcMs: number;
  readonly family: string;
  /** Whether this observation's own economic effect verified. */
  readonly effectValid: boolean;
  /** Executable value at this observation. Null when unpriced. */
  readonly executableLamports: bigint | null;
}

export type FillOutcome =
  | { readonly kind: 'filled'; readonly at: FillCandidate; readonly latencyMs: number }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * The frozen reaction-to-landing latency.
 *
 * One number, stated once, changed only through the multiple-testing ledger. A
 * latency that can be tuned after seeing the results is a latency that will be
 * tuned until the results look good.
 *
 * 1,200 ms is deliberately not optimistic: notice on the next mark, build,
 * simulate, sign, submit, land. A figure chosen to flatter the strategy is the
 * one assumption that silently rewrites every exit in the corpus.
 */
export const FROZEN_FILL_LATENCY_MS = 1_200;

/**
 * Which observation an exit triggered at T actually fills against.
 *
 * `candidates` must be the observations for the same position, oldest first.
 * The trigger itself may be among them and is never chosen.
 */
export function resolveFill(
  triggerUtcMs: number,
  triggerFamily: string,
  candidates: readonly FillCandidate[],
  latencyMs: number = FROZEN_FILL_LATENCY_MS,
): FillOutcome {
  const earliest = triggerUtcMs + latencyMs;

  for (const c of candidates) {
    // Strictly later AND past the latency. An observation at exactly the
    // trigger instant is the trigger, whatever its id says.
    if (c.observedUtcMs < earliest) continue;

    // A fill on a different family is a fill in a different market. The entry,
    // the marks and the exit are one family or the round trip is not one trade.
    if (c.family !== triggerFamily) continue;

    // The fill observation must stand on its own. Inheriting the trigger's
    // verdict would mean filling against a price nobody verified.
    if (!c.effectValid) continue;

    // An unpriced observation cannot be a fill. Null is an unknown, and a fill
    // at an unknown price is a number invented at the moment it matters most.
    if (c.executableLamports === null) continue;

    return { kind: 'filled', at: c, latencyMs: c.observedUtcMs - triggerUtcMs };
  }

  const later = candidates.filter((c) => c.observedUtcMs >= earliest);
  if (later.length === 0) {
    return {
      kind: 'blocked',
      reason: `no observation at least ${latencyMs}ms after the trigger; the exit cannot be filled yet`,
    };
  }
  return {
    kind: 'blocked',
    reason:
      `${later.length} later observation(s) exist and none is a valid fill: ` +
      `${later.filter((c) => c.family !== triggerFamily).length} cross-family, ` +
      `${later.filter((c) => !c.effectValid).length} not effect-valid, ` +
      `${later.filter((c) => c.executableLamports === null).length} unpriced`,
  };
}

/**
 * What the look-ahead would have been worth.
 *
 * Reported so the bias has a size rather than a reputation. Positive means
 * filling at the trigger would have flattered the result, which is the
 * direction it almost always runs.
 */
export function lookAheadBiasLamports(
  triggerExecutableLamports: bigint | null,
  fill: FillOutcome,
): bigint | null {
  if (fill.kind !== 'filled') return null;
  if (triggerExecutableLamports === null || fill.at.executableLamports === null) return null;
  return triggerExecutableLamports - fill.at.executableLamports;
}
