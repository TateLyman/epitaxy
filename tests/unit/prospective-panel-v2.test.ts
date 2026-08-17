import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  declarePanel,
  admitSample,
  markSample,
  panelStatus,
  dueMarks,
  PanelViolation,
} from '../../packages/storage/src/prospective-repo.js';
import { REJECT_PANEL_V1, withinPanel } from '../../packages/domain/src/reject-panel.js';

/**
 * `reject:panel-v2` — what makes a panel prospective.
 *
 * `reject_tracking` records THAT a token was rejected, not the STATE it was
 * rejected on. A panel scored from state fetched later is a different
 * experiment, and no amount of care at scoring time can repair that.
 *
 * Two properties do the work, and both are enforced by the repository rather
 * than described in a document: the rule is frozen before the sample exists,
 * and an outcome cannot reach a horizon the rule did not declare.
 */

const DECLARED = 1_000_000;
const PANEL = 'TEST_PANEL';
const HORIZONS = [60_000, 900_000];

const freshDb = () => openDb({ path: join(mkdtempSync(join(tmpdir(), 'panel-')), 'x.db'), skipBackup: true });

function withPanel(): ReturnType<typeof freshDb> {
  const db = freshDb();
  declarePanel(db, {
    panelId: PANEL,
    declaredUtcMs: DECLARED,
    horizonsMs: HORIZONS,
    metric: 'EXECUTABLE_QUOTE_LAMPORTS',
    sourceCommit: 'abc',
  });
  return db;
}

const sample = (over: Record<string, unknown> = {}) => ({
  sampleId: 'snap1:mintA',
  panelId: PANEL,
  mint: 'mintA',
  snapshotId: 'snap1',
  rejectedUtcMs: DECLARED + 5_000,
  primaryReason: 'LIQUIDITY_TOO_LOW',
  gateVerdicts: [{ gate: 'liquidity', passed: false }],
  ...over,
});

describe('v2 — the RULE is frozen before the rows', () => {
  it('refuses to redeclare a panel with different horizons', () => {
    // A horizon set changed under the same id is a new experiment wearing an
    // old name, and the corpus would carry both under one label.
    const db = withPanel();
    expect(() =>
      declarePanel(db, {
        panelId: PANEL,
        declaredUtcMs: DECLARED,
        horizonsMs: [60_000],
        metric: 'EXECUTABLE_QUOTE_LAMPORTS',
        sourceCommit: 'abc',
      }),
    ).toThrow(PanelViolation);
    db.close();
  });

  it('refuses to redeclare with a different metric', () => {
    const db = withPanel();
    expect(() =>
      declarePanel(db, {
        panelId: PANEL,
        declaredUtcMs: DECLARED,
        horizonsMs: HORIZONS,
        metric: 'USD_PRICE',
        sourceCommit: 'abc',
      }),
    ).toThrow(PanelViolation);
    db.close();
  });

  it('is idempotent on identical content, so every cycle can declare it', () => {
    const db = withPanel();
    expect(() =>
      declarePanel(db, {
        panelId: PANEL,
        declaredUtcMs: DECLARED,
        horizonsMs: [...HORIZONS].reverse(), // order must not matter
        metric: 'EXECUTABLE_QUOTE_LAMPORTS',
        sourceCommit: 'abc',
      }),
    ).not.toThrow();
    db.close();
  });

  it('REFUSES a row rejected before the rule was frozen', () => {
    // A rule frozen after the row it admits is a rule chosen with the row in
    // view. This is the check that makes "prospective" a property and not a
    // claim.
    const db = withPanel();
    expect(() => admitSample(db, sample({ rejectedUtcMs: DECLARED - 1 }))).toThrow(PanelViolation);
    db.close();
  });

  it('refuses a sample for a panel that was never declared', () => {
    const db = freshDb();
    expect(() => admitSample(db, sample())).toThrow(PanelViolation);
    db.close();
  });
});

describe('v2 — the SAMPLE carries the state, by reference', () => {
  it('stores the snapshot the rejection was made on', () => {
    const db = withPanel();
    admitSample(db, sample());
    const row = db.prepare('SELECT snapshot_id, gate_verdicts FROM prospective_samples').get() as {
      snapshot_id: string;
      gate_verdicts: string;
    };
    expect(row.snapshot_id).toBe('snap1');
    // Every verdict, not only the one that fired first: a filter's cost cannot
    // be attributed when only the winning reason was kept.
    expect(JSON.parse(row.gate_verdicts)).toHaveLength(1);
    db.close();
  });

  it('stores amounts as TEXT, because SQLite INTEGER is 64-bit SIGNED', () => {
    const db = withPanel();
    admitSample(db, sample({ poolReservesLamports: 18_446_744_073_709_551_615n }));
    const row = db.prepare('SELECT pool_reserves_lamports p FROM prospective_samples').get() as { p: string };
    expect(BigInt(row.p)).toBe(18_446_744_073_709_551_615n);
    db.close();
  });

  it('records an unanswered provider as NULL, never as zero', () => {
    const db = withPanel();
    admitSample(db, sample({ poolReservesLamports: null, routeExists: null }));
    const row = db.prepare('SELECT pool_reserves_lamports p, route_exists r FROM prospective_samples').get() as {
      p: string | null;
      r: number | null;
    };
    expect(row.p).toBeNull();
    expect(row.r).toBeNull();
    db.close();
  });

  it('admits the same mint on the same snapshot only once', () => {
    // A screening path that re-examines a mint must not enter it twice, or the
    // panel silently overweights whatever gets re-examined most.
    const db = withPanel();
    expect(admitSample(db, sample())).toBe(true);
    expect(admitSample(db, sample())).toBe(false);
    expect(panelStatus(db, PANEL)?.samples).toBe(1);
    db.close();
  });

  it('admits the same mint again on a NEW snapshot, which is a new decision', () => {
    const db = withPanel();
    admitSample(db, sample());
    admitSample(db, sample({ sampleId: 'snap2:mintA', snapshotId: 'snap2' }));
    expect(panelStatus(db, PANEL)?.samples).toBe(2);
    db.close();
  });

  it('has no outcome column at all', () => {
    // A table where the outcome can be written beside the sample is a table
    // where both can be written in one statement, and the ordering that makes
    // the panel prospective stops being visible.
    const db = withPanel();
    const cols = (db.prepare('PRAGMA table_info(prospective_samples)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('outcome');
    expect(cols).not.toContain('executable_lamports');
    db.close();
  });
});

describe('v2 — an OUTCOME cannot reach an undeclared horizon', () => {
  it('accepts a declared horizon', () => {
    const db = withPanel();
    admitSample(db, sample());
    expect(() =>
      markSample(db, { sampleId: 'snap1:mintA', horizonMs: 60_000, observedUtcMs: DECLARED + 65_000 }),
    ).not.toThrow();
    db.close();
  });

  it('REFUSES an undeclared one', () => {
    // Otherwise a metric can always be read off whichever window turned out
    // well, which is threshold-shopping in a place no ledger covers.
    const db = withPanel();
    admitSample(db, sample());
    expect(() =>
      markSample(db, { sampleId: 'snap1:mintA', horizonMs: 120_000, observedUtcMs: DECLARED + 130_000 }),
    ).toThrow(PanelViolation);
    db.close();
  });

  it('records LATENESS, so a late mark is not silently a timely one', () => {
    const db = withPanel();
    admitSample(db, sample()); // rejected at DECLARED + 5_000
    // 60s horizon is due at DECLARED + 65_000; observed 3s late.
    markSample(db, { sampleId: 'snap1:mintA', horizonMs: 60_000, observedUtcMs: DECLARED + 68_000 });
    const row = db.prepare('SELECT lateness_ms l FROM prospective_sample_marks').get() as { l: number };
    expect(row.l).toBe(3_000);
    db.close();
  });

  it('does not overwrite a mark that was already taken', () => {
    const db = withPanel();
    admitSample(db, sample());
    markSample(db, { sampleId: 'snap1:mintA', horizonMs: 60_000, observedUtcMs: DECLARED + 65_000 });
    markSample(db, { sampleId: 'snap1:mintA', horizonMs: 60_000, observedUtcMs: DECLARED + 999_000 });
    const row = db.prepare('SELECT observed_utc_ms o FROM prospective_sample_marks').get() as { o: number };
    expect(row.o).toBe(DECLARED + 65_000);
    db.close();
  });

  it('refuses a mark for a sample that does not exist', () => {
    const db = withPanel();
    expect(() => markSample(db, { sampleId: 'nope', horizonMs: 60_000, observedUtcMs: 1 })).toThrow(PanelViolation);
    db.close();
  });
});

describe('v2 — what is still owed is a number, not an impression', () => {
  it('counts outstanding as samples × horizons minus marks', () => {
    const db = withPanel();
    admitSample(db, sample());
    admitSample(db, sample({ sampleId: 's2', mint: 'mintB', snapshotId: 'snap2' }));
    markSample(db, { sampleId: 'snap1:mintA', horizonMs: 60_000, observedUtcMs: DECLARED + 65_000 });
    const s = panelStatus(db, PANEL);
    expect(s?.samples).toBe(2);
    expect(s?.marked).toBe(1);
    expect(s?.outstanding).toBe(3);
    db.close();
  });

  it('lists only horizons that have ACTUALLY arrived', () => {
    // A mark taken early is a 15-minute number observed at four minutes,
    // wearing the right label.
    const db = withPanel();
    admitSample(db, sample());
    const early = dueMarks(db, PANEL, DECLARED + 10_000);
    expect(early).toEqual([]);
    const later = dueMarks(db, PANEL, DECLARED + 70_000);
    expect(later.map((d) => d.horizonMs)).toEqual([60_000]);
    db.close();
  });

  it('stops listing a horizon once it is marked', () => {
    const db = withPanel();
    admitSample(db, sample());
    markSample(db, { sampleId: 'snap1:mintA', horizonMs: 60_000, observedUtcMs: DECLARED + 65_000 });
    expect(dueMarks(db, PANEL, DECLARED + 70_000)).toEqual([]);
    db.close();
  });

  it('returns null for a panel nobody declared, rather than an empty status', () => {
    // An empty status would read as "declared, no rows". Null is "no rule".
    const db = freshDb();
    expect(panelStatus(db, 'GHOST')).toBeNull();
    db.close();
  });
});

describe('v2 — the shipped rule', () => {
  it('shares the trajectory mark offsets, so both populations are observed alike', () => {
    // A rejected token and an opened one measured on different schedules is a
    // comparison of two measurement regimes, not of two decisions.
    expect([...REJECT_PANEL_V1.horizonsMs]).toEqual([60_000, 300_000, 900_000, 1_800_000, 3_600_000]);
  });

  it('scores an EXECUTABLE quote, not a USD price', () => {
    // 93% of a previous corpus had no route at all, and a price that cannot be
    // executed cannot answer what a filter cost.
    expect(REJECT_PANEL_V1.metric).toContain('EXECUTABLE');
  });

  it('excludes rejections that predate the frozen rule', () => {
    expect(withinPanel(REJECT_PANEL_V1.declaredUtcMs - 1)).toBe(false);
    expect(withinPanel(REJECT_PANEL_V1.declaredUtcMs)).toBe(true);
  });

  it('freezes the declaration instant as a LITERAL, not at startup', () => {
    // `Date.now()` at startup would make "the rule was frozen before the rows"
    // vacuously true, because the rule would always have just been declared.
    expect(REJECT_PANEL_V1.declaredUtcMs).toBe(Date.UTC(2026, 7, 16, 0, 0, 0));
    expect(REJECT_PANEL_V1.declaredUtcMs).toBeLessThan(Date.now());
  });
});
