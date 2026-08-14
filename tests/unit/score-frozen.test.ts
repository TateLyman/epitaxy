import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { opportunityScore } from '../../packages/strategy/src/score.js';
import { summarize } from '../../packages/intelligence/src/gates.js';
import type { GateResult } from '../../packages/domain/src/types.js';

/**
 * P20 — the score is FROZEN until effect-valid labels exist.
 *
 * "Do not tune score weights until effect-valid labels exist" is easy to agree
 * with and easy to violate by accident, because tuning a weight looks exactly
 * like fixing a bug from inside the diff. This pins the weights so a change has
 * to be deliberate: the test fails, and whoever is changing it has to decide
 * whether they are fixing arithmetic or fitting the strategy to its history.
 *
 * The distinction the directive draws:
 *
 *   a MATHEMATICAL DEFECT   may be fixed now
 *   a WEIGHT                may not move until there are labels to move it on
 *
 * The four defects it names are fixed and are asserted below. Fixing them
 * changed no weight.
 */

describe('P20 — the weights are frozen', () => {
  const WEIGHTS = { breadth: 0.3, liquidity: 0.2, organic: 0.2, tradability: 0.2, freshness: 0.1 };

  it('are exactly what they were, and sum to one', () => {
    // Read from the source rather than re-declared, so this cannot pass by
    // agreeing with itself.
    const src = readFileSync('packages/strategy/src/score.ts', 'utf8');
    for (const [name, value] of Object.entries(WEIGHTS)) {
      expect(src, `${name} must still be ${value}`).toMatch(new RegExp(`${name}:\\s*${value}`));
    }
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('a fully-observed token scores what the frozen weights say', () => {
    // The arithmetic, executed. If a weight moves, this number moves with it.
    const s = opportunityScore(
      { stats5m: { numNetBuyers: 60, numTraders: 150 }, liquidity: 150_000, organicScore: 80 } as never,
      { roundTripLossBps: 100 } as never,
      0,
      10 * 60_000,
    );
    // Every component at its maximum: breadth 1, liquidity 1, organic 1,
    // tradability 1, freshness 1 -> the weighted sum is 1.
    expect(s.score).toBeCloseTo(1, 3);
  });
});

describe('P20 — the four mathematical defects stay fixed', () => {
  const soft = (gate: string, riskContribution: number): GateResult =>
    ({ gate, passed: true, severity: 'soft_risk', riskContribution, reason: gate, detail: '' }) as GateResult;

  it('1. a missing net-buyer count remains unknown', () => {
    const src = readFileSync('packages/intelligence/src/gates.ts', 'utf8');
    // The substitution that handed the anti-wash gate the one number wash
    // trading inflates.
    expect(src).not.toMatch(/netBuyers === null \? buys5 >=/);
    expect(src).toContain('net_buyers_unavailable');
  });

  it('2. a zero-risk feature cannot dilute existing risk', () => {
    expect(summarize([soft('a', 0.9)]).softRiskScore).toBeCloseTo(0.9, 6);
    expect(summarize([soft('a', 0.9), soft('b', 0)]).softRiskScore).toBeCloseTo(0.9, 6);
  });

  it('3. a missing organic score is not penalised twice', () => {
    const missing = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000 } as never,
      { roundTripLossBps: 200 } as never,
      0,
      5 * 60_000,
    );
    const zero = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 0 } as never,
      { roundTripLossBps: 200 } as never,
      0,
      5 * 60_000,
    );
    /**
     * P18 — absent and a provider zero are the SAME statement, so these are
     * equal. The comment this replaces said "a real zero is scored as a zero",
     * which assumed the provider distinguishes them. It does not: the field is
     * 0 for every token under about an hour old, n=461 with no exceptions, and
     * the organic_score_unavailable gate already prices that absence. Scoring
     * the zero again at full weight charged one gap twice.
     */
    expect(missing.score).toBe(zero.score);
  });

  it('4. unknown never satisfies a hard gate', () => {
    const src = readFileSync('packages/intelligence/src/gates.ts', 'utf8');
    // The gates that read a nullable field require it to be present AND to
    // clear the bar. `!== null &&` is the shape; a bare comparison would let
    // a null through as a passing value.
    for (const field of ['ageMs', 'liq', 'holders']) {
      expect(src, field).toMatch(new RegExp(`${field} !== null &&`));
    }
  });
});

describe('P20 — no model may be promoted without labels', () => {
  it('there are no effect-valid round trips yet, so nothing may be fitted', () => {
    // The directive allows comparing models after at least 100 valid
    // development round trips. This asserts the precondition is still unmet,
    // so a model appearing in the tree before then is a test failure rather
    // than a discovery.
    const artifact = JSON.parse(readFileSync('artifacts/readiness.json', 'utf8')) as {
      validDevelopmentTrades: number;
    };
    expect(artifact.validDevelopmentTrades).toBeLessThan(100);
  });

  it('no LLM sits in the trading loop', () => {
    // Token names and metadata are display-only data. A model that reads them
    // is a model that can be prompted by whoever chose the token's name.
    for (const f of [
      'packages/strategy/src/score.ts',
      'packages/strategy/src/screen.ts',
      'packages/intelligence/src/gates.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/openai|anthropic|completion\(|\bllm\b/i);
    }
  });
});
