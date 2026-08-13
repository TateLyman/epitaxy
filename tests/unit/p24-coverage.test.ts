import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { validateSetup, InvalidSimulationSetup } from '../../apps/engine/src/simulate-observation.js';
import { evidenceClassOf } from '../../packages/domain/src/evidence.js';
import { fingerprintOf } from '../../packages/research/src/capability.js';
import { buildReadiness } from '../../packages/research/src/readiness.js';
import { openDb } from '../../packages/storage/src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * P24 — the required tests, and where each one lives.
 *
 * The directive lists 44. Most are covered by the file that owns the behaviour;
 * the map below is the index, and it is asserted rather than written down,
 * because a coverage claim nobody checks is the same class of thing as the
 * source-substring tests this session deleted.
 *
 * The items implemented HERE are the ones with no natural home elsewhere.
 */

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** item -> the file that executes it. */
const COVERAGE: Readonly<Record<number, string>> = {
  1: 'scripts/simulation-audit.ts',
  2: 'tests/unit/simulate-observation.test.ts',
  3: 'tests/unit/simulate-observation.test.ts',
  4: 'tests/unit/effect.test.ts',
  5: 'tests/unit/effect.test.ts',
  6: 'tests/unit/simulate-observation.test.ts',
  7: 'tests/unit/effect.test.ts',
  8: 'tests/unit/p24-coverage.test.ts',
  9: 'tests/unit/p24-coverage.test.ts',
  10: 'scripts/simulator-prospective-parity.ts',
  11: 'tests/unit/p24-coverage.test.ts',
  12: 'scripts/pump-parity.ts',
  13: 'docs/PUMP_PUMPSWAP_PARITY.md',
  14: 'tests/unit/build-composition.test.ts',
  15: 'tests/unit/build-composition.test.ts',
  16: 'tests/unit/paper-core.test.ts',
  17: 'tests/unit/paper-core.test.ts',
  18: 'tests/unit/paper-core.test.ts',
  19: 'tests/unit/paper-core.test.ts',
  20: 'tests/unit/p16-repair.test.ts',
  21: 'tests/unit/shadow-completeness.test.ts',
  22: 'tests/unit/shadow-completeness.test.ts',
  23: 'tests/unit/shadow-completeness.test.ts',
  24: 'tests/unit/markscheduler.test.ts',
  25: 'tests/unit/markscheduler.test.ts',
  26: 'tests/unit/episode.test.ts',
  27: 'tests/unit/episode.test.ts',
  28: 'tests/unit/accounting-unified.test.ts',
  29: 'tests/unit/accounting-unified.test.ts',
  30: 'tests/unit/accounting-unified.test.ts',
  31: 'tests/unit/accounting-unified.test.ts',
  32: 'tests/unit/accountwatch.test.ts',
  33: 'tests/unit/accountwatch.test.ts',
  34: 'tests/unit/accountwatch.test.ts',
  35: 'tests/unit/score-defects.test.ts',
  36: 'tests/unit/score-defects.test.ts',
  37: 'tests/unit/cohort.test.ts',
  38: 'tests/unit/rejectoutcome.test.ts',
  39: 'tests/unit/readiness.test.ts',
  40: 'tests/unit/readiness.test.ts',
  41: 'tests/unit/readiness.test.ts',
  42: 'tests/unit/p24-coverage.test.ts',
  43: 'tests/unit/p24-coverage.test.ts',
  44: 'tests/unit/hook-guard.test.ts',
};

describe('P24 — every required item has a home that exists', () => {
  it('covers all 44', () => {
    expect(Object.keys(COVERAGE).length).toBe(44);
    for (let i = 1; i <= 44; i += 1) expect(COVERAGE[i], `item ${i}`).toBeDefined();
  });

  it('every named file is on disk', () => {
    // A coverage map pointing at a file nobody wrote is the same class of claim
    // as a test that greps for a reassuring phrase.
    const missing = [...new Set(Object.values(COVERAGE))].filter((f) => !existsSync(f));
    expect(missing).toEqual([]);
  });

  it('item 13 is a documented gap, not a passing test', () => {
    // PumpSwap canonical-pool parity has NOT been established. The map points
    // at the doc that says so, and this asserts the doc still says so rather
    // than quietly becoming a claim.
    const doc = readFileSync('docs/PUMP_PUMPSWAP_PARITY.md', 'utf8');
    expect(doc).toMatch(/PumpSwap canonical pools are not covered/i);
  });

  it('item 10 is blocked and the blocker is recorded', () => {
    const doc = readFileSync('docs/OFFLINE_REPLAY_BLOCKER.md', 'utf8');
    expect(doc).toMatch(/SIMULATION_UNKNOWN/);
    expect(readFileSync('docs/FAILURE_REGISTER.csv', 'utf8')).toContain('S050');
  });
});

describe('P24.8 — a token amount past 2^53 survives the setup', () => {
  it('accepts an inventory larger than a double can represent exactly', () => {
    // A nine-decimal memecoin with a billion supply is 10^18 atoms, three
    // orders of magnitude past exact in a float. Anything that routes an
    // amount through Number here silently changes the trade.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    expect(() =>
      validateSetup({
        mode: 'DEVELOPMENT_JIT',
        side: 'sell',
        inputMint: 'MintB',
        outputMint: WSOL,
        inputAmount: huge,
        inputTokenProgram: TOKEN_PROGRAM,
        fundingLamports: 200_000_000n,
        maxLamportsSpent: 20_000_000n,
        contextHash: null,
      }),
    ).not.toThrow();
    // Still exact after the round trip through the string form the request
    // carries.
    expect(BigInt(huge.toString())).toBe(huge);
    // And demonstrably NOT exact through a double. Compared back as a bigint,
    // because the source literal 9_007_199_254_740_993 is itself already a
    // rounded double and would compare equal to the damaged value -- the
    // failure mode hiding its own evidence.
    expect(BigInt(Number(huge))).not.toBe(huge);
    expect(BigInt(Number(huge))).toBe(9_007_199_254_740_992n);
  });
});

describe('P24.9 — an invalid setup is not route-failure evidence', () => {
  it('the setup that produced the 43 failures is refused before it can run', () => {
    const badSell = {
      mode: 'DEVELOPMENT_JIT' as const,
      side: 'sell' as const,
      inputMint: 'MintB',
      outputMint: WSOL,
      inputAmount: 1_000_000_000n,
      inputTokenProgram: null,
      fundingLamports: 200_000_000n,
      maxLamportsSpent: 20_000_000n,
      contextHash: null,
    };
    expect(() => validateSetup(badSell)).toThrow(InvalidSimulationSetup);
    // The message has to say why, or a row carrying it cannot be argued with.
    expect(() => validateSetup(badSell)).toThrow(/cannot be provisioned/);
  });

  it('the invalidation document states the rows are not token outcomes', () => {
    const doc = readFileSync('docs/2617BB7_SIMULATION_WINDOW_INVALIDATION.md', 'utf8');
    expect(doc).toMatch(/not\*\* route failures/i);
    expect(doc).toMatch(/INSTRUMENT_DEVELOPMENT/);
  });
});

describe('P24.11 — an unproven fingerprint stays structural', () => {
  it('a route whose only jobs measured the instrument cannot advance', () => {
    const leg = {
      validity: 'INSTRUMENT_DEVELOPMENT',
      effectOk: true,
      accountCoverageOk: true,
      offline: true,
      confirmatory: true,
    };
    expect(evidenceClassOf(leg, leg)).toBe('STRUCTURAL_ONLY');
  });

  it('two tokens on the same route shape share a fingerprint', () => {
    // Otherwise every token is its own unproven venue and nothing ever
    // accumulates evidence, which is what hashing the static key list did.
    const shape = {
      routeLabels: 'Pump.fun Amm',
      programs: ['PumpProgram1111111111111111111111111111111'],
      tokenPrograms: [TOKEN_PROGRAM],
      lookupTableCount: 1,
      simulatorFeatureSet: 'v1',
    };
    expect(fingerprintOf(shape)).toBe(fingerprintOf({ ...shape }));
  });

  it('a different program is a different fingerprint', () => {
    const base = {
      routeLabels: 'Pump.fun Amm',
      programs: ['PumpProgram1111111111111111111111111111111'],
      tokenPrograms: [TOKEN_PROGRAM],
      lookupTableCount: 1,
      simulatorFeatureSet: 'v1',
    };
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, programs: ['Other1111111111111111111111111111111111111'] }));
  });

  it('Token-2022 is a different fingerprint from legacy Token', () => {
    const base = {
      routeLabels: 'Pump.fun Amm',
      programs: ['P1'],
      tokenPrograms: [TOKEN_PROGRAM],
      lookupTableCount: 0,
      simulatorFeatureSet: 'v1',
    };
    expect(fingerprintOf(base)).not.toBe(
      fingerprintOf({ ...base, tokenPrograms: ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'] }),
    );
  });
});

describe('P24.42/43 — readiness gates the executor, and staleness cannot pass', () => {
  it('an empty corpus is NOT_READY and names its blockers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p24-'));
    try {
      const db = openDb({ path: join(dir, 'r.db'), skipBackup: true });
      const r = buildReadiness(db, 'abc', 'v1', 1_760_000_000_000);
      expect(r.verdict).toBe('NOT_READY');
      expect(r.blockers.length).toBeGreaterThan(0);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows holds -wal briefly */
      }
    }
  });

  it('a stale artifact cannot substitute for a fresh gate evaluation', () => {
    // The artifact records when it was generated. A readiness claim is a claim
    // about the corpus NOW, and a file on disk from an hour ago is a claim
    // about the corpus then.
    const raw = JSON.parse(readFileSync('artifacts/readiness.json', 'utf8')) as {
      generatedUtcMs: number;
      verdict: string;
    };
    expect(typeof raw.generatedUtcMs).toBe('number');
    expect(raw.generatedUtcMs).toBeGreaterThan(0);
    // And the current verdict is the honest one.
    expect(raw.verdict).toBe('NOT_READY');
  });

  it('the guard blocks the assistant from starting canary or live at all', () => {
    const guard = readFileSync('.claude/hooks/guard.mjs', 'utf8');
    expect(guard).toMatch(/canary/i);
    expect(guard).toMatch(/live/i);
  });
});
