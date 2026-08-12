import { describe, expect, it } from 'vitest';
import { decideExit, type ExitInputs } from '../../packages/strategy/src/exits.js';
import type { ExitConfig } from '../../packages/domain/src/config.js';

/**
 * These tests document a defect found by reading the first ten closed paper
 * positions, not by reading the code. Eight of the ten carried exit reason
 * `exit_cost_exploded`, which reads as one failure mode and is two.
 *
 * `apps/engine/src/paper.ts:360` builds the input as
 * `Math.round(Math.abs(sell.priceImpactPct) * 10_000)`. The `Math.abs` is the
 * defect: `priceImpactPct` is signed, and the sign is the only thing that
 * distinguishes "this sale costs more than we allow" from "the pool this
 * position lived in no longer exists".
 *
 * Measured on the live corpus: the four total-loss positions each recorded a
 * final sell-quote impact of about -9,900 to -10,000 bps and returned ~0 SOL,
 * while the four small-loss positions recorded ordinary drift of +519 to +911
 * bps and returned approximately the entry amount. Both populations produced
 * the same exit reason.
 *
 * No production behaviour is changed here. These tests pin what the code does
 * today so that a later fix is a visible, deliberate change to exit semantics
 * rather than a silent one.
 */

const CONFIG: ExitConfig = {
  stopLossBps: 2500,
  trailingStopBps: 3000,
  takeProfitBps: 6000,
  maxHoldMs: 1_800_000,
  minHoldMs: 60_000,
  maxExitImpactBps: 500,
};

const NOW = 1_780_000_000_000;

function inputs(over: Partial<ExitInputs> = {}): ExitInputs {
  return {
    costLamports: 50_000_000n,
    peakValueLamports: 50_000_000n,
    markLamports: 50_000_000n,
    openedUtcMs: NOW - 120_000,
    nowUtcMs: NOW,
    exitRouteExists: true,
    exitPriceImpactBps: 0,
    ...over,
  };
}

describe('exit_cost_exploded conflates cost drift with liquidity collapse', () => {
  it('fires on ordinary cost drift just above the cap', () => {
    const d = decideExit(inputs({ exitPriceImpactBps: 519 }), CONFIG);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('exit_cost_exploded');
  });

  it('fires identically on a total liquidity collapse, once the caller has taken Math.abs', () => {
    // -9914 bps was an observed reading on 5bjC6rcN..., a position that
    // returned 0.0005 SOL against a 0.0521 SOL cost. paper.ts passes
    // Math.abs(...), so the exit rule sees +9914 and calls it a cost problem.
    const collapsed = decideExit(inputs({ exitPriceImpactBps: 9914 }), CONFIG);
    expect(collapsed.exit).toBe(true);
    expect(collapsed.reason).toBe('exit_cost_exploded');

    const drift = decideExit(inputs({ exitPriceImpactBps: 519 }), CONFIG);

    // The defect, stated as an assertion: a 20x difference in severity, and two
    // different underlying events, are indistinguishable in the recorded reason.
    expect(collapsed.reason).toBe(drift.reason);
  });

  it('would not fire on a collapse if the sign were preserved', () => {
    // Without the caller's Math.abs, -9914 is not > 500, so the cost rule is
    // silent and the position would fall through to the stop-loss and trailing
    // rules below. This is why removing the abs is a behaviour change and not a
    // cleanup: it moves four of ten observed exits onto a different rule.
    const d = decideExit(inputs({ exitPriceImpactBps: -9914, markLamports: 50_000_000n }), CONFIG);
    expect(d.reason).not.toBe('exit_cost_exploded');
  });

  it('treats a favourable impact reading as a reason to exit', () => {
    // The same Math.abs means a large *favourable* impact also trips the cost
    // rule. Nothing in the corpus shows this happening yet, so it is recorded
    // as a latent consequence rather than an observed one.
    const d = decideExit(inputs({ exitPriceImpactBps: 900 }), CONFIG);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('exit_cost_exploded');
  });

  it('checks the vanished route before the cost rule and before minimum hold', () => {
    const d = decideExit(
      inputs({ exitRouteExists: false, exitPriceImpactBps: 9999, openedUtcMs: NOW - 1 }),
      CONFIG,
    );
    expect(d.reason).toBe('exit_route_lost');
  });

  it('does not fire below the cap', () => {
    expect(decideExit(inputs({ exitPriceImpactBps: 499 }), CONFIG).reason).not.toBe(
      'exit_cost_exploded',
    );
  });

  it('does not fire at exactly the cap', () => {
    // The cap is a maximum that is still allowed, so 500 must not exit. This is
    // the only case that distinguishes `>` from `>=` at exits.ts:51; without it
    // that mutation passes the whole file.
    expect(decideExit(inputs({ exitPriceImpactBps: 500 }), CONFIG).reason).not.toBe(
      'exit_cost_exploded',
    );
  });
});

/**
 * Confirmed to fail against a deliberately broken implementation, twice.
 *
 * Mutating `>` to `>=` at exits.ts:51 initially passed all six tests — the
 * suite could not detect it, because 499 >= 500 is still false. That gap is why
 * "does not fire at exactly the cap" exists; with it, the mutation fails 1 of 7.
 * Mutating `>` to `<` fails 5 of 7. exits.ts was restored after both runs.
 *
 * Recording this because the first version of this file would have passed
 * against a broken cap and been indistinguishable from one that worked.
 */
