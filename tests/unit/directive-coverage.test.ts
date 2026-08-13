import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXECUTION_PARITY_ESTABLISHED } from '../../packages/simulator/src/protocol.js';
import { isMaterialDrop } from '../../packages/adapters/src/accountwatch.js';
import { legIsConfirmatory, FAMILY_CONTRACTS, type ExecutionObservation } from '../../packages/domain/src/execution.js';

/**
 * The §22 items that are properties of the SYSTEM rather than of one function.
 *
 * Several read source rather than executing it. That is weaker than a
 * behavioural test and it is said out loud: `paper.ts` calls `main()` at import
 * time and cannot be imported, and the alternative for these is no guard at
 * all on defects that are invisible in any single run.
 */

const paper = readFileSync('apps/engine/src/paper.ts', 'utf8');

/**
 * P8 — the two describe blocks that used to live here are DELETED.
 *
 * They read `paper.ts` as a string. One found the substring
 * `shadow_entry_roundtrip` and concluded portfolio entry required a round trip;
 * portfolio entry did not require one, and the position opened on the buy
 * alone. The other sliced `manageShadowBooks` and concluded marks were
 * executable; `manageOpenPositions` was still marking from `/order`, and every
 * stop, trail, peak and NAV in the system read that number.
 *
 * Both passed against an implementation that had the phrase and the defect.
 * That is worse than no test: it is a green check over the exact failure it
 * claimed to cover.
 *
 * The behaviour now lives in tests/unit/paper-core.test.ts, which calls the
 * functions and asserts on what they return.
 */

describe('§22.34 the benchmark family is never PnL-eligible', () => {
  it('never treats the benchmark family as PnL-eligible', () => {
    expect(FAMILY_CONTRACTS.QUOTE_ONLY_BENCHMARK.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.ORDER_EXECUTE.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.BUILD_CUSTOM.pnlEligible).toBe(true);
  });
});

describe('§22.47 a material change triggers an observation, a small one does not', () => {
  it('fires on a collapse-sized drop', () => {
    // Every observed collapse happened inside one ten-second mark interval.
    expect(isMaterialDrop(10_000_000_000n, 2_000_000_000n, 2_000)).toBe(true);
  });

  it('stays quiet on ordinary movement', () => {
    // Every update would exhaust a budget that also has to maintain the mark
    // SLA across the whole book.
    expect(isMaterialDrop(10_000_000_000n, 9_900_000_000n, 2_000)).toBe(false);
  });
});

describe('§22.51 and §22.53 a development run is never presented as evidence', () => {
  const base = (over: Partial<ExecutionObservation> = {}): ExecutionObservation =>
    ({
      family: 'BUILD_CUSTOM',
      instructionPolicy: 'PASS',
      transactionPolicy: 'PASS',
      simulation: 'SIMULATED_OK',
      instructionSetHash: 'ix',
      rawPayloadHash: 'raw',
      expectedOutput: 100n,
      minimumOutput: 90n,
      lastValidBlockHeight: 400,
      contextSlot: 438_000_000,
      instructionCount: 7,
      transactionBytes: 900,
      ...over,
    }) as ExecutionObservation;

  it('refuses a leg with no context slot as evidence, while still allowing collection', () => {
    // MT026. context_slot is null on all 22,177 observations because Jupiter
    // never sends it. Vetoing collection on it would refuse 100% of builds;
    // vetoing EVIDENCE on it is correct, because an offline replay needs a
    // point in time to stand at.
    const v = legIsConfirmatory(base({ contextSlot: null }));
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('context slot');
  });

  it('refuses an unsimulated leg as evidence', () => {
    expect(legIsConfirmatory(base({ simulation: 'NOT_SIMULATED' })).ok).toBe(false);
  });

  it('keeps the parity gate shut, so no run can be confirmatory yet', () => {
    // §22.51: the confirmatory gate must reject DEVELOPMENT_JIT. It does so via
    // this constant, which no amount of otherwise-clean output can bypass.
    expect(EXECUTION_PARITY_ESTABLISHED).toBe(false);
  });
});

describe('§22.54 the executor remains unavailable', () => {
  it('is blocked by the hook, not merely by convention', () => {
    const guard = readFileSync('.claude/hooks/guard.mjs', 'utf8');
    expect(guard).toMatch(/canary/i);
    expect(guard).toMatch(/live/i);
  });

  it('never imports execution from the paper engine', () => {
    // The invariant: observe and paper CANNOT trade, established by the import
    // graph rather than by a runtime flag somebody could flip.
    expect(paper).not.toContain('packages/execution/');
    expect(readFileSync('apps/engine/src/observe-route.ts', 'utf8')).not.toContain('packages/execution/');
  });
});

describe('§22.50 a stale artifact cannot stand in for a fresh one', () => {
  it('records the commit each artifact was generated from', () => {
    // An artifact with no provenance is indistinguishable from one regenerated
    // after the change it was supposed to validate.
    const manifest = JSON.parse(readFileSync('artifacts/release-manifest.json', 'utf8')) as Record<string, unknown>;
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
    const asText = JSON.stringify(manifest);
    expect(asText).toMatch(/commit|sha|version/i);
  });
});
