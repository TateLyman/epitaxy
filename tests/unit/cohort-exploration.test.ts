import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../packages/storage/src/db.js';
import { maturingByCohort, insertCandidate } from '../../packages/storage/src/repo.js';
import { COHORT_BOUNDS } from '../../packages/domain/src/cohort.js';
import { allocate, EXPLORATION_FRACTION } from '../../packages/strategy/src/exploration.js';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;

function dbWith(ages: readonly { mint: string; ageMs: number }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'coh-'));
  const d = openDb({ path: join(dir, 'x.db') });
  migrate(d);
  // Through the REAL writer. A hand-rolled INSERT drifts from the schema and
  // then fails in a way that looks like a defect in the code under test.
  for (const a of ages) {
    insertCandidate(d, {
      mint: a.mint,
      name: a.mint,
      symbol: a.mint,
      decimals: 6,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      creator: null,
      launchpad: 'unknown',
      firstSeenUtcMs: NOW - a.ageMs,
      createdAtUtcMs: NOW - a.ageMs,
      provenance: {
        source: 'test',
        sourceType: 'model',
        receivedMonotonicMs: 0,
        receivedUtcMs: NOW - a.ageMs,
        slot: null,
        sourceUtcMs: null,
        schemaVersion: 'v1',
        parserVersion: 'v1',
        payloadHash: 'h',
      },
    });
  }
  return { d, dir };
}

describe('P16 — all four cohort queues actually mature', () => {
  it('feeds every band, not only the configured 2m-60m window', () => {
    // THE defect. `maturingMints` took one window from config.gates, so
    // AGE_1H_5H, AGE_5H_24H and AGE_24H_7D were defined, bounded, assigned to
    // rows, and never received a single candidate. Comparing four arms would
    // have compared one populated cohort against three empty ones.
    const { d, dir } = dbWith([
      { mint: 'young', ageMs: 30 * MIN },
      { mint: 'hours', ageMs: 3 * HOUR },
      { mint: 'day', ageMs: 12 * HOUR },
      { mint: 'week', ageMs: 3 * 24 * HOUR },
    ]);
    try {
      const rows = maturingByCohort(d, NOW, COHORT_BOUNDS, 10);
      const byCohort = new Map(rows.map((r) => [r.cohort, r.mint]));
      expect(byCohort.get('AGE_2M_60M')).toBe('young');
      expect(byCohort.get('AGE_1H_5H')).toBe('hours');
      expect(byCohort.get('AGE_5H_24H')).toBe('day');
      expect(byCohort.get('AGE_24H_7D')).toBe('week');
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives each cohort its own quota so the youngest cannot starve the rest', () => {
    // A shared limit ordered by last-screened is consumed by whichever band has
    // the most candidates, which is always the youngest.
    const many = Array.from({ length: 30 }, (_, i) => ({ mint: `y${i}`, ageMs: 30 * MIN }));
    const { d, dir } = dbWith([...many, { mint: 'old', ageMs: 3 * 24 * HOUR }]);
    try {
      const rows = maturingByCohort(d, NOW, COHORT_BOUNDS, 5);
      expect(rows.filter((r) => r.cohort === 'AGE_2M_60M')).toHaveLength(5);
      expect(rows.filter((r) => r.cohort === 'AGE_24H_7D').map((r) => r.mint)).toEqual(['old']);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not put one mint in two cohorts', () => {
    const { d, dir } = dbWith([{ mint: 'edge', ageMs: 60 * MIN }]);
    try {
      const rows = maturingByCohort(d, NOW, COHORT_BOUNDS, 10);
      expect(rows.filter((r) => r.mint === 'edge')).toHaveLength(1);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P17 — a quarter of the budget buys an unbiased slice', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    item: `m${i}`,
    stratum: i % 2 === 0 ? 'AGE_2M_60M' : 'AGE_1H_5H',
    rank: 100 - i,
  }));

  it('spends the frozen fraction on exploration', () => {
    const sel = allocate(candidates, 8, 42);
    expect(sel).toHaveLength(8);
    expect(sel.filter((s) => s.arm === 'explore')).toHaveLength(Math.floor(8 * EXPLORATION_FRACTION));
    expect(EXPLORATION_FRACTION).toBe(0.25);
  });

  it('explores candidates the ranking did NOT take', () => {
    // Otherwise exploration buys the ones it nearly picked anyway, and the
    // corpus still cannot say what the gates refused that would have worked.
    const sel = allocate(candidates, 8, 42);
    const exploited = new Set(sel.filter((s) => s.arm === 'exploit').map((s) => s.item));
    for (const e of sel.filter((s) => s.arm === 'explore')) {
      expect(exploited.has(e.item)).toBe(false);
    }
  });

  it('persists an inclusion probability on every row', () => {
    // A biased sample whose bias is unrecorded is worse than no sample: it
    // cannot be reweighted, and it looks like evidence.
    const sel = allocate(candidates, 8, 42);
    for (const s of sel) {
      expect(s.inclusionProbability).toBeGreaterThan(0);
      expect(s.inclusionProbability).toBeLessThanOrEqual(1);
    }
    expect(sel.filter((s) => s.arm === 'explore').every((s) => s.inclusionProbability < 1)).toBe(true);
  });

  it('stratifies, so exploration is not just the largest stratum', () => {
    const lopsided = [
      ...Array.from({ length: 40 }, (_, i) => ({ item: `big${i}`, stratum: 'AGE_2M_60M', rank: 0 })),
      ...Array.from({ length: 3 }, (_, i) => ({ item: `small${i}`, stratum: 'AGE_24H_7D', rank: 0 })),
    ];
    const sel = allocate(lopsided, 8, 7);
    const explored = sel.filter((s) => s.arm === 'explore');
    expect(new Set(explored.map((s) => s.stratum)).size).toBeGreaterThan(1);
  });

  it('is deterministic, so a cycle can be replayed', () => {
    // Math.random() would make replay divergence mean a coin flip rather than
    // a defect.
    const a = allocate(candidates, 8, 99).map((s) => `${s.arm}:${s.item}`);
    const b = allocate(candidates, 8, 99).map((s) => `${s.arm}:${s.item}`);
    expect(a).toEqual(b);
  });
});
