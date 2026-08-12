import { describe, it, expect } from 'vitest';
import {
  classifyExit,
  isInfrastructureOutcome,
  isMarketFailureOutcome,
  COLLAPSE_RATIO,
  SEVERE_RATIO,
  type OutcomeInputs,
} from '../../packages/domain/src/exitoutcome.js';

/**
 * These cases are drawn from the real first ten paper positions, not invented.
 * The mints and amounts are the ones in the corpus, so a regression here is a
 * regression against observed history rather than against my imagination.
 */

const COST = 45_527_853n; // cb9b5c75 / HTaEUsni entry cost

function inputs(over: Partial<OutcomeInputs> = {}): OutcomeInputs {
  return {
    quotedExitOutputLamports: COST,
    positionEntryCostLamports: COST,
    routeAvailable: true,
    triggerRule: 'unknown',
    ...over,
  };
}

describe('classifyExit — the four real collapses', () => {
  // Every one of these closed as `exit_cost_exploded` under the old labelling.
  const collapses: [string, bigint, bigint][] = [
    ['5bjC6rcN', 52_139_280n, 267_074n],
    ['3XiaH5DA', 49_320_251n, 13n],
    ['HTaEUsni', 45_527_853n, 8n],
    ['23n8oNsU', 52_233_144n, 491_353n],
  ];

  for (const [mint, cost, out] of collapses) {
    it(`${mint} is a liquidity_collapse, not a cost problem`, () => {
      const v = classifyExit(inputs({
        quotedExitOutputLamports: out,
        positionEntryCostLamports: cost,
        triggerRule: 'exit_cost_exploded',
      }));
      expect(v.outcome).toBe('liquidity_collapse');
      expect(v.exitValueRatio).toBeLessThan(COLLAPSE_RATIO);
      expect(isMarketFailureOutcome(v.outcome)).toBe(true);
      // Crucially NOT infrastructure: the money is really gone, it is not
      // merely unmeasured, and it must count against PnL.
      expect(isInfrastructureOutcome(v.outcome)).toBe(false);
    });
  }
});

describe('classifyExit — the favourable-price ejections', () => {
  it('DE6svnZL closed above cost and must never be a collapse or a loss', () => {
    // Real row: cost 42,939,280, executable out 45,388,189 (ratio 1.057),
    // priceImpactPct +0.0911 which Math.abs turned into "911bps of exit cost".
    const v = classifyExit(inputs({
      quotedExitOutputLamports: 45_388_189n,
      positionEntryCostLamports: 42_939_280n,
      triggerRule: 'exit_cost_exploded',
    }));
    expect(v.outcome).toBe('cost_drift');
    expect(v.exitValueRatio).toBeGreaterThan(1);
    expect(isMarketFailureOutcome(v.outcome)).toBe(false);
  });

  it('a position above cost is never labelled a stop loss', () => {
    const v = classifyExit(inputs({
      quotedExitOutputLamports: COST * 2n,
      triggerRule: 'take_profit',
    }));
    expect(v.outcome).toBe('take_profit');
  });
});

describe('classifyExit — boundaries are inclusive as documented', () => {
  it('exactly the collapse ratio is a collapse', () => {
    const v = classifyExit(inputs({ quotedExitOutputLamports: 10_000_000n, positionEntryCostLamports: 100_000_000n }));
    expect(v.exitValueRatio).toBe(COLLAPSE_RATIO);
    expect(v.outcome).toBe('liquidity_collapse');
  });

  it('one lamport above the collapse ratio is severe degradation instead', () => {
    const v = classifyExit(inputs({ quotedExitOutputLamports: 10_000_001n, positionEntryCostLamports: 100_000_000n }));
    expect(v.outcome).toBe('severe_exit_degradation');
  });

  it('exactly the severe ratio is severe degradation', () => {
    const v = classifyExit(inputs({ quotedExitOutputLamports: 50_000_000n, positionEntryCostLamports: 100_000_000n }));
    expect(v.exitValueRatio).toBe(SEVERE_RATIO);
    expect(v.outcome).toBe('severe_exit_degradation');
  });

  it('one lamport above the severe ratio defers to the trigger rule', () => {
    const v = classifyExit(inputs({
      quotedExitOutputLamports: 50_000_001n,
      positionEntryCostLamports: 100_000_000n,
      triggerRule: 'stop_loss',
    }));
    expect(v.outcome).toBe('ordinary_stop_loss');
  });
});

describe('classifyExit — economic reality outranks the rule that noticed', () => {
  it('a collapse found by the stop loss is still a collapse', () => {
    const a = classifyExit(inputs({ quotedExitOutputLamports: 1n, triggerRule: 'stop_loss' }));
    const b = classifyExit(inputs({ quotedExitOutputLamports: 1n, triggerRule: 'exit_cost_exploded' }));
    const c = classifyExit(inputs({ quotedExitOutputLamports: 1n, triggerRule: 'max_hold' }));
    expect([a.outcome, b.outcome, c.outcome]).toEqual([
      'liquidity_collapse',
      'liquidity_collapse',
      'liquidity_collapse',
    ]);
  });

  it('trailing and fixed stops share an outcome but keep distinct trigger rules', () => {
    const fixed = classifyExit(inputs({ quotedExitOutputLamports: (COST * 6n) / 10n, triggerRule: 'stop_loss' }));
    const trail = classifyExit(inputs({ quotedExitOutputLamports: (COST * 6n) / 10n, triggerRule: 'trailing_stop' }));
    expect(fixed.outcome).toBe('ordinary_stop_loss');
    expect(trail.outcome).toBe('ordinary_stop_loss');
    // The rule survives in the rationale, so no information is lost.
    expect(trail.rationale).toContain('trailing_stop');
    expect(fixed.rationale).toContain('stop_loss');
  });
});

describe('classifyExit — unknown stays unknown', () => {
  it('no route is route_unavailable with no ratio at all', () => {
    const v = classifyExit(inputs({ routeAvailable: false, quotedExitOutputLamports: null }));
    expect(v.outcome).toBe('route_unavailable');
    expect(v.exitValueRatio).toBeNull();
    expect(isInfrastructureOutcome(v.outcome)).toBe(true);
  });

  it('a null quote is route_unavailable even if the flag claims a route', () => {
    const v = classifyExit(inputs({ routeAvailable: true, quotedExitOutputLamports: null }));
    expect(v.outcome).toBe('route_unavailable');
  });

  it('zero entry cost is refused rather than producing an infinite ratio', () => {
    const v = classifyExit(inputs({ positionEntryCostLamports: 0n }));
    expect(v.outcome).toBe('unknown');
    expect(v.exitValueRatio).toBeNull();
  });

  it('a contradictory route-lost rule with a live quote is reported, not smoothed', () => {
    const v = classifyExit(inputs({ triggerRule: 'exit_route_lost' }));
    expect(v.outcome).toBe('unknown');
    expect(v.rationale).toContain('contradictory');
  });

  it('execution and reconciliation failures outrank every value-based label', () => {
    // Even with a perfectly healthy quote, an unlanded exit means we do not
    // know what we own.
    const exec = classifyExit(inputs({ executionFailed: true }));
    const recon = classifyExit(inputs({ reconciliationFailed: true }));
    expect(exec.outcome).toBe('execution_failure');
    expect(recon.outcome).toBe('reconciliation_failure');
    expect(exec.exitValueRatio).toBeNull();
    expect(isInfrastructureOutcome(recon.outcome)).toBe(true);
  });

  it('reconciliation failure outranks execution failure', () => {
    const v = classifyExit(inputs({ executionFailed: true, reconciliationFailed: true }));
    expect(v.outcome).toBe('reconciliation_failure');
  });
});

describe('classifyExit — no provider sign convention can change a label', () => {
  it('is a pure function of executable value and rule, with no impact input', () => {
    // The type has no priceImpactPct field at all. This test exists so that
    // re-adding one is a deliberate, visible act rather than a quiet edit.
    const keys = Object.keys(inputs());
    expect(keys).not.toContain('priceImpactPct');
    expect(keys).not.toContain('rawPriceImpactPct');
  });

  it('is deterministic', () => {
    const i = inputs({ quotedExitOutputLamports: 123_456n, triggerRule: 'stop_loss' });
    expect(classifyExit(i)).toEqual(classifyExit(i));
  });
});
