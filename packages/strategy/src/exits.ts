import type { ExitConfig } from '../../domain/src/config.js';
import { lossBps } from '../../domain/src/amounts.js';

/**
 * Exit rules.
 *
 * Every rule here is a bounded, deterministic function of the position and its
 * current mark. There is no discretion, no averaging down, and no "give it a
 * bit longer": a memecoin position that has stopped working is a position whose
 * exit route is about to get worse, not better.
 */

/**
 * Which rule fired. This answers "why did we act now?" and nothing else.
 *
 * It is deliberately NOT the same vocabulary as `ExitOutcome` in
 * packages/domain/src/exitoutcome.ts, which answers "what happened to the
 * money?". Until 2026-08-12 this system had one field doing both jobs, and the
 * result was that `exit_cost_exploded` covered both a token that had evaporated
 * and a position that was up 2%. The two questions get two types.
 */
export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'max_hold'
  | 'exit_route_lost'
  | 'liquidity_collapse';

export interface ExitInputs {
  readonly costLamports: bigint;
  readonly peakValueLamports: bigint;
  /** Proceeds if we sold the whole position right now, net of quoted fees. */
  readonly markLamports: bigint | null;
  readonly openedUtcMs: number;
  readonly nowUtcMs: number;
  readonly exitRouteExists: boolean;
}

export interface ExitDecision {
  readonly exit: boolean;
  readonly reason: ExitReason | null;
  readonly detail: string;
}

const NO_EXIT: ExitDecision = { exit: false, reason: null, detail: '' };

export function decideExit(input: ExitInputs, config: ExitConfig): ExitDecision {
  const heldMs = input.nowUtcMs - input.openedUtcMs;

  // A vanished exit route is the single most urgent signal in this system: the
  // position is already unsellable and every further minute makes it worse.
  // It is checked before the minimum hold, because a minimum hold is a
  // churn-control device and must never trap us in an unsellable asset.
  if (!input.exitRouteExists) {
    return { exit: true, reason: 'exit_route_lost', detail: 'no sell route at mark time' };
  }

  if (input.markLamports === null) return NO_EXIT;

  // Collapse is measured in executable output, not in a provider's diagnostic
  // field. `markLamports` is the SOL a full-position sell was actually quoted
  // to return, so this comparison needs no sign convention from anyone and
  // cannot invert if a vendor changes one.
  //
  // Checked before `minHoldMs` for the same reason as the route check above:
  // the churn guard exists to stop us round-tripping through fees on noise,
  // and an asset worth a tenth of its cost is not noise.
  if (input.costLamports > 0n) {
    const collapseAt = (input.costLamports * BigInt(config.liquidityCollapseRatioBps)) / 10_000n;
    if (input.markLamports <= collapseAt) {
      const pct = (Number(input.markLamports) / Number(input.costLamports)) * 100;
      return {
        exit: true,
        reason: 'liquidity_collapse',
        detail: `full-position sell quote is ${pct.toFixed(2)}% of cost, at or below the ${config.liquidityCollapseRatioBps / 100}% floor`,
      };
    }
  }

  // Minimum hold exists so that a single noisy mark cannot round-trip us
  // straight back out through two sets of fees.
  if (heldMs < config.minHoldMs) return NO_EXIT;

  const down = lossBps(input.costLamports, input.markLamports);
  if (down !== null && down >= config.stopLossBps) {
    return { exit: true, reason: 'stop_loss', detail: `${down.toFixed(0)}bps below cost` };
  }

  // Gain is measured against COST, so the arguments to `lossBps` are
  // (cost, mark) and not (mark, cost). With them the other way round `up` is
  // positive whenever the position is winning, `-up` is therefore negative,
  // and `-up >= takeProfitBps` is unsatisfiable for every input: take-profit
  // was unreachable code. Zero of the first ten closed positions took profit,
  // which is consistent with a rule that could never fire and is not evidence
  // that none of them qualified.
  if (input.markLamports > input.costLamports) {
    const up = lossBps(input.costLamports, input.markLamports);
    if (up !== null && -up >= config.takeProfitBps) {
      return { exit: true, reason: 'take_profit', detail: `${(-up).toFixed(0)}bps above cost` };
    }
  }

  // Trailing stop measured from the peak MARK, not the peak price, so it
  // accounts for the exit liquidity actually available at the peak.
  if (input.peakValueLamports > input.costLamports) {
    const fromPeak = lossBps(input.peakValueLamports, input.markLamports);
    if (fromPeak !== null && fromPeak >= config.trailingStopBps) {
      return { exit: true, reason: 'trailing_stop', detail: `${fromPeak.toFixed(0)}bps off peak` };
    }
  }

  if (heldMs >= config.maxHoldMs) {
    return { exit: true, reason: 'max_hold', detail: `held ${Math.round(heldMs / 1000)}s` };
  }

  return NO_EXIT;
}
