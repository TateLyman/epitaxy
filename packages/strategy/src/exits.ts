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

export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'max_hold'
  | 'exit_route_lost'
  | 'exit_cost_exploded';

export interface ExitInputs {
  readonly costLamports: bigint;
  readonly peakValueLamports: bigint;
  /** Proceeds if we sold the whole position right now, net of quoted fees. */
  readonly markLamports: bigint | null;
  readonly openedUtcMs: number;
  readonly nowUtcMs: number;
  readonly exitRouteExists: boolean;
  readonly exitPriceImpactBps: number | null;
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

  if (input.exitPriceImpactBps !== null && input.exitPriceImpactBps > config.maxExitImpactBps) {
    return {
      exit: true,
      reason: 'exit_cost_exploded',
      detail: `exit impact ${input.exitPriceImpactBps}bps > ${config.maxExitImpactBps}bps`,
    };
  }

  if (input.markLamports === null) return NO_EXIT;

  // Minimum hold exists so that a single noisy mark cannot round-trip us
  // straight back out through two sets of fees.
  if (heldMs < config.minHoldMs) return NO_EXIT;

  const down = lossBps(input.costLamports, input.markLamports);
  if (down !== null && down >= config.stopLossBps) {
    return { exit: true, reason: 'stop_loss', detail: `${down.toFixed(0)}bps below cost` };
  }

  if (input.markLamports > input.costLamports) {
    const up = lossBps(input.markLamports, input.costLamports);
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
