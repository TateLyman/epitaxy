import { describe, it, expect } from 'vitest';
import { summarize, evaluateCheapGates } from '../../packages/intelligence/src/gates.js';
import { opportunityScore } from '../../packages/strategy/src/score.js';
import type { GateResult } from '../../packages/domain/src/types.js';
import { readFileSync } from 'node:fs';
import { AppConfigSchema } from '../../packages/domain/src/config.js';

// The real shipped config, parsed by the real schema. A hand-built one would
// let these pass against thresholds the engine does not actually run.
const paper = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

/**
 * P17 — the score's mathematical defects, fixed without tuning it.
 *
 * The weights are frozen. Nothing here changes what the score rewards; it
 * changes arithmetic that was wrong regardless of what anyone wanted the score
 * to say.
 */

const soft = (gate: string, riskContribution: number): GateResult =>
  ({ gate, passed: true, severity: 'soft_risk', riskContribution, reason: gate, detail: '' }) as GateResult;

describe('P17 — soft risk cannot be diluted by a reassuring feature', () => {
  it('one serious risk keeps its weight when a zero-risk feature is added', () => {
    // THE defect. The aggregation was the mean, so a token with one 0.9 risk
    // scored 0.9; add a gate that reports no risk at all and the same token
    // scored 0.45. The risk halved because we wrote more code.
    const alone = summarize([soft('dangerous', 0.9)]).softRiskScore;
    const withReassurance = summarize([soft('dangerous', 0.9), soft('fine', 0)]).softRiskScore;
    expect(alone).toBeCloseTo(0.9, 6);
    expect(withReassurance).toBeCloseTo(0.9, 6);
    // Under the mean this was 0.45, so this test fails against the old code.
    expect(withReassurance).not.toBeCloseTo(0.45, 2);
  });

  it('adding ten reassuring features changes nothing', () => {
    const gates = [soft('dangerous', 0.9), ...Array.from({ length: 10 }, (_, i) => soft(`fine${i}`, 0))];
    expect(summarize(gates).softRiskScore).toBeCloseTo(0.9, 6);
  });

  it('the worst single risk is a floor nothing can lower', () => {
    const s = summarize([soft('a', 0.7), soft('b', 0.1), soft('c', 0.05)]).softRiskScore;
    expect(s).toBeGreaterThanOrEqual(0.7);
  });

  it('additional real risks increase the total, monotonically and boundedly', () => {
    const one = summarize([soft('a', 0.5)]).softRiskScore;
    const two = summarize([soft('a', 0.5), soft('b', 0.5)]).softRiskScore;
    const three = summarize([soft('a', 0.5), soft('b', 0.5), soft('c', 0.5)]).softRiskScore;
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(three).toBeLessThanOrEqual(1);
  });

  it('never exceeds 1, whatever is thrown at it', () => {
    const s = summarize(Array.from({ length: 50 }, (_, i) => soft(`r${i}`, 0.9))).softRiskScore;
    expect(s).toBeLessThanOrEqual(1);
  });

  it('no soft gates is no risk, not a division by zero', () => {
    expect(summarize([]).softRiskScore).toBe(0);
  });
});

describe('P17 — an unknown component is unknown, not zero', () => {
  const roundTrip = { roundTripLossBps: 200 } as never;

  it('a token with no provider stats is not scored as a token with no activity', () => {
    // Two opposite facts. One is a gap in our coverage; the other is a
    // statement about the token, and only the second is evidence.
    const noStats = opportunityScore({ stats5m: undefined } as never, roundTrip, 0, 5 * 60_000);
    const zeroStats = opportunityScore(
      { stats5m: { numNetBuyers: 0, numTraders: 0 }, liquidity: 0, organicScore: 0 } as never,
      roundTrip,
      0,
      5 * 60_000,
    );
    expect(noStats.score).not.toBe(zeroStats.score);
    // The unmeasured one is not punished for our coverage gap.
    expect(noStats.score).toBeGreaterThan(zeroStats.score);
  });

  it('reports how much of the score was actually supported', () => {
    const partial = opportunityScore({ stats5m: undefined } as never, roundTrip, 0, 5 * 60_000);
    const full = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 40 } as never,
      roundTrip,
      0,
      5 * 60_000,
    );
    // A score assembled from two of five components is not the same number as
    // one assembled from five, and it must not look like it.
    expect(partial.components['observedWeight']).toBeLessThan(full.components['observedWeight'] ?? 0);
    expect(partial.components['unknownComponents']).toBeGreaterThan(0);
    expect(full.components['unknownComponents']).toBe(0);
  });

  it('a missing organic score is graded once, not twice', () => {
    // It used to be a zero component at full weight AND a 0.25 soft risk. Two
    // penalties for one absence is not caution; it is an error that compounds
    // against exactly the young tokens this strategy trades. The component now
    // drops out and the soft-risk gate is the single place it is priced.
    const missing = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000 } as never,
      roundTrip,
      0,
      5 * 60_000,
    );
    const present = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 0 } as never,
      roundTrip,
      0,
      5 * 60_000,
    );
    expect(missing.score).toBeGreaterThan(present.score);
  });

  it('everything unknown yields zero rather than NaN', () => {
    const s = opportunityScore({ stats5m: undefined } as never, null, 0, null);
    expect(Number.isFinite(s.score)).toBe(true);
  });

  it('soft risk still scales the result', () => {
    const clean = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 40 } as never,
      roundTrip,
      0,
      5 * 60_000,
    );
    const risky = opportunityScore(
      { stats5m: { numNetBuyers: 30, numTraders: 80 }, liquidity: 50_000, organicScore: 40 } as never,
      roundTrip,
      0.5,
      5 * 60_000,
    );
    expect(risky.score).toBeCloseTo(clean.score * 0.5, 3);
  });
});

describe('P17 — the chain overrides the provider', () => {
  const base = {
    info: { mintAuthorityDisabled: false, freezeAuthorityDisabled: false } as never,
    nowUtcMs: 1_760_000_000_000,
    sourceAgeMs: 1_000,
    config: paper.gates,
  };
  const gateNamed = (gates: readonly GateResult[], name: string): GateResult | undefined =>
    gates.find((g) => g.gate === name);

  it('a chain SAFE verdict passes a gate the provider would have failed', () => {
    // The provider says the mint authority is live; the chain says it is
    // disabled. The chain is a byte we read ourselves and it wins -- it is not
    // a vote.
    const gates = evaluateCheapGates({
      ...base,
      chainFacts: { mintAuthority: 'SAFE', freezeAuthority: 'SAFE' } as never,
    });
    const mint = gateNamed(gates, 'mint_authority_disabled');
    expect(mint?.passed).toBe(true);
    expect(mint?.detail).toContain('chain');
  });

  it('a chain HOSTILE verdict fails a gate the provider would have passed', () => {
    // A provider wrong in THIS direction is the dangerous one: it says safe
    // about a mint that can still be inflated.
    const gates = evaluateCheapGates({
      info: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } as never,
      nowUtcMs: base.nowUtcMs,
      sourceAgeMs: base.sourceAgeMs,
      config: base.config,
      chainFacts: { mintAuthority: 'HOSTILE', freezeAuthority: 'SAFE' } as never,
    });
    expect(gateNamed(gates, 'mint_authority_disabled')?.passed).toBe(false);
  });

  it('an unread chain falls back to the provider and says which source it used', () => {
    // Absent is not safe and is not hostile. It is unread, and the detail
    // string names the source so a reader cannot mistake a provider claim for
    // a measurement.
    const gates = evaluateCheapGates({ ...base, chainFacts: null });
    expect(gateNamed(gates, 'mint_authority_disabled')?.detail).toContain('provider');
  });
});
