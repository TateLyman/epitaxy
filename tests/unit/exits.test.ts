import { describe, expect, it } from 'vitest';
import { decideExit, type ExitInputs } from '../../packages/strategy/src/exits.js';
import type { ExitConfig } from '../../packages/domain/src/config.js';

/**
 * These tests exist because of a defect found by reading the first ten closed
 * paper positions, not by reading the code. Eight of the ten carried exit
 * reason `exit_cost_exploded`, which reads as one failure mode and was two.
 *
 * The old rule fired on `Math.abs(priceImpactPct) * 10_000 > maxExitImpactBps`.
 * Two things were wrong with it and only one of them was the `Math.abs`:
 * Jupiter documents no sign convention for `priceImpactPct` at all (checked
 * 2026-08-12, docs/RESEARCH.md), so no threshold over that field could be
 * given a stable meaning in the first place. Deleting the `abs` would have
 * left a rule whose direction depended on an undocumented vendor choice.
 *
 * The replacement is stated over executable output — the SOL a full-position
 * sell was quoted to return — which needs no convention from anyone.
 *
 * The corpus figures quoted below are real, from the backfill:
 *   3XiaH5DA  0.049320251 SOL cost -> 0.000000013 SOL executable  (ratio 0.0000)
 *   5bjC6rcN  0.052139280 SOL cost -> 0.000481520 SOL executable  (ratio 0.0092)
 *   DE6svnZL  0.042939280 SOL cost -> 0.045388189 SOL executable  (ratio 1.0570)
 * The old rule ejected all three under the same label.
 */

const CONFIG: ExitConfig = {
  stopLossBps: 2500,
  trailingStopBps: 3000,
  takeProfitBps: 6000,
  maxHoldMs: 1_800_000,
  minHoldMs: 60_000,
  liquidityCollapseRatioBps: 1000,
};

const NOW = 1_780_000_000_000;
const COST = 50_000_000n;
/** cost * 1000bps. Exactly on the boundary. */
const AT_FLOOR = 5_000_000n;

function inputs(over: Partial<ExitInputs> = {}): ExitInputs {
  return {
    costLamports: COST,
    peakValueLamports: COST,
    markLamports: COST,
    openedUtcMs: NOW - 120_000,
    nowUtcMs: NOW,
    exitRouteExists: true,
    ...over,
  };
}

describe('liquidity collapse is measured in executable SOL', () => {
  it('fires when the full-position sell quote is at the floor', () => {
    const d = decideExit(inputs({ markLamports: AT_FLOOR }), CONFIG);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('liquidity_collapse');
  });

  it('does NOT fire one lamport above the floor', () => {
    // The only case that distinguishes `<=` from `<`. Without it that mutation
    // passes the whole file, because every real collapse in the corpus is
    // orders of magnitude below the boundary.
    const d = decideExit(inputs({ markLamports: AT_FLOOR + 1n }), CONFIG);
    expect(d.reason).not.toBe('liquidity_collapse');
  });

  it('outranks the stop loss, which would also have fired', () => {
    // At the floor the position is 90% down, so the stop loss is satisfied too.
    // If the ordering were reversed, every collapse in the corpus would be
    // labelled `stop_loss` and the label would record our rule order rather
    // than the market.
    expect(decideExit(inputs({ markLamports: AT_FLOOR }), CONFIG).reason).toBe('liquidity_collapse');
    expect(decideExit(inputs({ markLamports: AT_FLOOR + 1n }), CONFIG).reason).toBe('stop_loss');
  });

  it('bypasses the minimum hold', () => {
    // minHoldMs is a churn guard against noisy marks. An asset worth a tenth of
    // its cost is not noise, and waiting out the guard is how a 0.9% recovery
    // becomes a 0.0% one.
    const d = decideExit(inputs({ markLamports: AT_FLOOR, openedUtcMs: NOW - 1 }), CONFIG);
    expect(d.reason).toBe('liquidity_collapse');
  });

  it('still lets the minimum hold guard ordinary losses', () => {
    // 40% down is past the stop loss, but inside the hold window it waits.
    const d = decideExit(inputs({ markLamports: 30_000_000n, openedUtcMs: NOW - 1 }), CONFIG);
    expect(d.exit).toBe(false);
  });

  it('classifies the observed 3XiaH5DA exit as a collapse', () => {
    const d = decideExit(
      inputs({ costLamports: 49_320_251n, peakValueLamports: 52_871_000n, markLamports: 13n }),
      CONFIG,
    );
    expect(d.reason).toBe('liquidity_collapse');
  });

  it('classifies the observed 5bjC6rcN exit as a collapse', () => {
    const d = decideExit(
      inputs({ costLamports: 52_139_280n, peakValueLamports: 58_135_000n, markLamports: 481_520n }),
      CONFIG,
    );
    expect(d.reason).toBe('liquidity_collapse');
  });

  it('does NOT eject the observed DE6svnZL position, which was up 5.7%', () => {
    // The regression that motivated all of this. The old rule read
    // Math.abs(+0.0911) as 911bps of exit cost and closed a position that was
    // worth more than it cost, twenty-one seconds after opening.
    const d = decideExit(
      inputs({
        costLamports: 42_939_280n,
        peakValueLamports: 45_388_189n,
        markLamports: 45_388_189n,
        openedUtcMs: NOW - 21_000,
      }),
      CONFIG,
    );
    expect(d.exit).toBe(false);
  });

  it('is silent when there is no mark at all', () => {
    expect(decideExit(inputs({ markLamports: null }), CONFIG).exit).toBe(false);
  });

  it('refuses to divide by a non-positive cost', () => {
    // A zero cost would make the floor zero and silently reclassify. The guard
    // means such a position falls through to the ordinary rules instead.
    const d = decideExit(inputs({ costLamports: 0n, markLamports: 0n }), CONFIG);
    expect(d.reason).not.toBe('liquidity_collapse');
  });

  it('checks the vanished route before everything, including minimum hold', () => {
    const d = decideExit(inputs({ exitRouteExists: false, openedUtcMs: NOW - 1 }), CONFIG);
    expect(d.reason).toBe('exit_route_lost');
  });

  it('reports a route loss even when the mark would also be a collapse', () => {
    const d = decideExit(
      inputs({ exitRouteExists: false, markLamports: 0n, openedUtcMs: NOW - 1 }),
      CONFIG,
    );
    expect(d.reason).toBe('exit_route_lost');
  });
});

describe('the surviving rules are unchanged', () => {
  it('stops out at exactly the configured loss', () => {
    expect(decideExit(inputs({ markLamports: 37_500_000n }), CONFIG).reason).toBe('stop_loss');
  });

  it('does not stop out one lamport short of it', () => {
    expect(decideExit(inputs({ markLamports: 37_500_001n }), CONFIG).exit).toBe(false);
  });

  it('takes profit at exactly the configured gain', () => {
    // 6000bps above a 50,000,000 cost is 80,000,000. Measured against COST, not
    // against the mark: with the arguments the other way round the rule was
    // unsatisfiable for every input, which is why none of the first ten
    // positions took profit. This case and the next pin the direction.
    const d = decideExit(inputs({ markLamports: 80_000_000n, peakValueLamports: 80_000_000n }), CONFIG);
    expect(d.reason).toBe('take_profit');
  });

  it('does not take profit one lamport short of the gain', () => {
    const d = decideExit(inputs({ markLamports: 79_999_999n, peakValueLamports: 79_999_999n }), CONFIG);
    expect(d.exit).toBe(false);
  });

  it('take_profit is reachable at all', () => {
    // The assertion the old suite was missing. A rule that no input can satisfy
    // is indistinguishable from a rule that is correctly never triggered.
    const reached = [...Array(400).keys()].some(
      (i) =>
        decideExit(
          inputs({ markLamports: (COST * BigInt(i + 1)) / 50n, peakValueLamports: COST * 8n }),
          CONFIG,
        ).reason === 'take_profit',
    );
    expect(reached).toBe(true);
  });

  it('trails from the peak mark, not from cost', () => {
    const d = decideExit(inputs({ peakValueLamports: 70_000_000n, markLamports: 48_000_000n }), CONFIG);
    expect(d.reason).toBe('trailing_stop');
  });

  it('does not trail a position that never rose above cost', () => {
    const d = decideExit(inputs({ peakValueLamports: COST, markLamports: 40_000_000n }), CONFIG);
    expect(d.exit).toBe(false);
  });

  it('closes on the maximum hold', () => {
    const d = decideExit(inputs({ openedUtcMs: NOW - 1_800_000 }), CONFIG);
    expect(d.reason).toBe('max_hold');
  });

  it('holds a flat, fresh position', () => {
    expect(decideExit(inputs(), CONFIG).exit).toBe(false);
  });
});

describe('exit_cost_exploded no longer exists', () => {
  it('is not producible by any input', () => {
    // The type no longer admits it; this asserts the runtime agrees, across the
    // full range of marks from zero to four times cost.
    const reasons = new Set<string | null>();
    for (let i = 0; i <= 400; i++) {
      reasons.add(
        decideExit(inputs({ markLamports: (COST * BigInt(i)) / 100n, peakValueLamports: COST * 4n }), CONFIG)
          .reason,
      );
    }
    expect(reasons.has('exit_cost_exploded')).toBe(false);
    expect(reasons.has('liquidity_collapse')).toBe(true);
  });
});
