import { describe, it, expect } from 'vitest';
import {
  decideEntry,
  decideExit,
  seededInclusion,
  shouldEliminate,
  checkpointReached,
  CHECKPOINTS,
  type PreEntryFeatures,
  type MarkPoint,
} from '../../packages/strategy/src/treatments.js';

/**
 * P10 / finding F — the tournament was labels, not treatments.
 *
 * Allocating ONE arm label to ONE trajectory measures nothing: each arm sees a
 * different set of tokens, so any difference between arms is confounded with
 * which tokens each arm drew. Evaluating every policy over the SAME trajectory
 * makes the comparison paired and removes that variance entirely.
 */

function features(over: Partial<PreEntryFeatures> = {}): PreEntryFeatures {
  return {
    mint: 'MintAAA',
    hardGatesPass: true,
    independentBuyerPersistence: 0.8,
    nonMayhemNetQuoteInflowLamports: 500_000n,
    effectiveQuoteReserveTrend: 0.1,
    executableExitCapacityTrend: 0.05,
    continuationSlope: 1.2,
    creatorNetSellingLamports: 0n,
    entityConcentration: 0.2,
    mintBehaviourSafe: true,
    mechanicsViable: true,
    correctedQualityScore: 0.7,
    scoreCoverageOk: true,
    ...over,
  };
}

describe('P10 — hard gates bind every policy', () => {
  it('no policy can trade a candidate a hard gate rejected', () => {
    for (const p of ['HARD_GATES_RANDOM', 'CORRECTED_CURRENT_QUALITY_SCORE', 'SURVIVOR_FLOW_CONTINUATION_V1'] as const) {
      const d = decideEntry(p, features({ hardGatesPass: false }), { seed: 's' });
      expect(d.enter).toBe(false);
      expect(d.reason).toMatch(/hard safety gate/);
    }
  });

  it('no policy can trade unviable mechanics', () => {
    for (const p of ['HARD_GATES_RANDOM', 'CORRECTED_CURRENT_QUALITY_SCORE', 'SURVIVOR_FLOW_CONTINUATION_V1'] as const) {
      expect(decideEntry(p, features({ mechanicsViable: false }), { seed: 's' }).enter).toBe(false);
    }
  });
});

describe('P10 — the control arm is reproducible', () => {
  it('is deterministic in seed and mint', () => {
    // Math.random() would make the control unreplayable, which defeats the
    // purpose of having a control.
    const a = seededInclusion('seed-1', 'MintAAA', 0.5);
    const b = seededInclusion('seed-1', 'MintAAA', 0.5);
    expect(a).toBe(b);
  });

  it('a different seed gives a different draw for some mint', () => {
    const mints = Array.from({ length: 40 }, (_, i) => `Mint${i}`);
    const differs = mints.some((m) => seededInclusion('seed-1', m, 0.5) !== seededInclusion('seed-2', m, 0.5));
    expect(differs).toBe(true);
  });

  it('includes roughly the stated rate over many mints', () => {
    const mints = Array.from({ length: 2_000 }, (_, i) => `Mint${i}`);
    const n = mints.filter((m) => seededInclusion('s', m, 0.5)).length;
    expect(n).toBeGreaterThan(850);
    expect(n).toBeLessThan(1_150);
  });

  it('a rate of zero includes nothing and a rate of one includes everything', () => {
    const mints = Array.from({ length: 200 }, (_, i) => `Mint${i}`);
    expect(mints.filter((m) => seededInclusion('s', m, 0)).length).toBe(0);
    expect(mints.filter((m) => seededInclusion('s', m, 1)).length).toBe(200);
  });
});

describe('P10 — an unknown feature is never a pass', () => {
  it('refuses when a survivor feature is unknown, and names it', () => {
    // The repository's standing rule applied to entry policy: absence of a
    // provider field is a fact about the provider, not about the token. A
    // policy that read null as "fine" would enter most often on exactly the
    // tokens nothing is known about.
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', features({ entityConcentration: null }), { seed: 's' });
    expect(d.enter).toBe(false);
    expect(d.unknowns).toContain('entityConcentration');
    expect(d.reason).toMatch(/entityConcentration is unknown/);
  });

  it('refuses an unscored token rather than treating it as average', () => {
    const d = decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', features({ scoreCoverageOk: false }), { seed: 's' });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/not a pass/);
  });

  it('enters when every pre-entry condition holds', () => {
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', features(), { seed: 's' });
    expect(d.enter).toBe(true);
  });

  it('refuses a vertical continuation, which is a launch spike', () => {
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', features({ continuationSlope: 50 }), { seed: 's' });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/vertical/);
  });

  it('refuses a creator who is net selling', () => {
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', features({ creatorNetSellingLamports: 1n }), { seed: 's' });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/net selling/);
  });
});

describe('P10 — exit policies see the same mark stream', () => {
  const marks: MarkPoint[] = [
    { atMs: 0, executableLamports: 20_000_000n, exitCapacityLamports: 50_000_000n, effectiveQuoteReserveLamports: null },
    { atMs: 300_000, executableLamports: 30_000_000n, exitCapacityLamports: 49_000_000n, effectiveQuoteReserveLamports: null },
    { atMs: 900_000, executableLamports: 40_000_000n, exitCapacityLamports: 48_000_000n, effectiveQuoteReserveLamports: null },
  ];

  it('the control leaves at the frozen 15 minute horizon', () => {
    expect(decideExit('FIXED_15M_CONTROL', 0, marks).triggeredAtMs).toBe(900_000);
  });

  it('the challenger leaves when exit CAPACITY collapses, not when price moves', () => {
    // Deliberately not a take-profit grid: memecoin returns are heavy tailed
    // and a small number of winners carry the result, so an arbitrary early
    // take-profit truncates exactly the right tail the strategy needs. Note the
    // price is RISING here and the challenger still leaves.
    const collapsing: MarkPoint[] = [
      { atMs: 0, executableLamports: 20_000_000n, exitCapacityLamports: 50_000_000n, effectiveQuoteReserveLamports: null },
      { atMs: 60_000, executableLamports: 60_000_000n, exitCapacityLamports: 10_000_000n, effectiveQuoteReserveLamports: null },
    ];
    const d = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', 0, collapsing);
    expect(d.triggeredAtMs).toBe(60_000);
    expect(d.reason).toMatch(/liquidity deteriorating rather than the price moving/);
  });

  it('the challenger falls back to the frozen horizon so it cannot win by holding forever', () => {
    const d = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', 0, marks);
    expect(d.triggeredAtMs).toBe(900_000);
    expect(d.reason).toMatch(/fell back to the frozen horizon/);
  });

  it('reports no trigger rather than inventing one when the stream is too short', () => {
    expect(decideExit('FIXED_15M_CONTROL', 0, [marks[0] as MarkPoint]).triggeredAtMs).toBeNull();
  });

  it('ignores unmeasured capacity rather than treating it as a collapse', () => {
    const unmeasured: MarkPoint[] = [
      { atMs: 0, executableLamports: 20_000_000n, exitCapacityLamports: 50_000_000n, effectiveQuoteReserveLamports: null },
      { atMs: 60_000, executableLamports: 20_000_000n, exitCapacityLamports: null, effectiveQuoteReserveLamports: null },
    ];
    expect(decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', 0, unmeasured).triggeredAtMs).toBeNull();
  });
});

describe('P10 — elimination is frozen and paired', () => {
  it('refuses to eliminate before the 50 checkpoint', () => {
    const r = shouldEliminate({ pairedDifferences: Array.from({ length: 30 }, () => -100) });
    expect(r.eliminate).toBe(false);
    expect(r.reason).toMatch(/not permitted before 50/);
  });

  it('eliminates a consistently worse arm at the checkpoint', () => {
    const diffs = Array.from({ length: 60 }, (_, i) => -100 + (i % 5));
    const r = shouldEliminate({ pairedDifferences: diffs });
    expect(r.eliminate).toBe(true);
    expect(r.reason).toMatch(/standard errors/);
  });

  it('does not eliminate a noisy arm whose mean is near zero', () => {
    const diffs = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 500 : -500));
    expect(shouldEliminate({ pairedDifferences: diffs }).eliminate).toBe(false);
  });

  it('treats zero variance as an apparatus fault, not a result', () => {
    const r = shouldEliminate({ pairedDifferences: Array.from({ length: 60 }, () => -100) });
    expect(r.eliminate).toBe(false);
    expect(r.reason).toMatch(/apparatus fault/);
  });

  it('names the checkpoints in order', () => {
    expect(checkpointReached(9)).toBeNull();
    expect(checkpointReached(10)).toBe('APPARATUS_SANITY');
    expect(checkpointReached(25)).toBe('COSTS_AND_FILLABILITY');
    expect(checkpointReached(50)).toBe('EARLY_ELIMINATION');
    expect(checkpointReached(100)).toBe('DEVELOPMENT_SELECTION_PERMITTED');
    expect(CHECKPOINTS.DEVELOPMENT_SELECTION_PERMITTED).toBe(100);
  });
});
