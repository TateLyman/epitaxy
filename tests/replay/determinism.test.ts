import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import type { Db } from '../../packages/storage/src/db.js';
import { insertSnapshot, insertScreening, insertQuote, newId } from '../../packages/storage/src/repo.js';
import type { ExecutableQuote, RoundTrip } from '../../packages/domain/src/types.js';
import { loadConfig } from '../../packages/domain/src/config.js';
import type { AppConfig } from '../../packages/domain/src/config.js';
import { screenCheap, finalizeScreen } from '../../packages/strategy/src/screen.js';
import type { MintInformation } from '../../packages/adapters/src/jupiter/schemas.js';
import { replayAll, snapshotRows, replayOne, loadQuote, replayable } from '../../packages/research/src/replay.js';
import type { ConcentrationInput } from '../../packages/intelligence/src/gates.js';
import type { SnapshotRow } from '../../packages/research/src/replay.js';

/**
 * Replay determinism.
 *
 * `pnpm replay` run against the live database says "0 divergences", but that
 * sentence only means something if the comparison is capable of reporting a
 * divergence at all. A checker that always passes is indistinguishable from a
 * checker that has never been tested, and this system uses replay as evidence
 * for promotion out of paper — so it is exactly the check that must not be
 * quietly broken.
 *
 * These tests therefore prove BOTH directions: an unaltered snapshot reproduces
 * exactly, and a snapshot whose stored verdict has been tampered with is
 * caught, field by field.
 *
 * The corpus is built by running the real strategy over synthetic tokens and
 * writing the result exactly as the pipeline writes it, so the test exercises
 * the same code path that produced the live rows rather than a hand-made
 * imitation of it.
 */

const dir = mkdtempSync(join(tmpdir(), 'replay-'));
let db: Db;
let config: AppConfig;
let n = 0;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked SQLite file on Windows is not a test failure.
  }
});

beforeEach(() => {
  db = openDb({ path: join(dir, `replay-${n++}.db`) });
  config = loadConfig('observe');
});

const NOW = 1_700_000_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * A token as the provider would describe it. Defaults sit inside every gate so
 * that an individual test can move exactly one field and know that the field it
 * moved is the reason for any change in verdict.
 */
function token(over: Partial<MintInformation> = {}): MintInformation {
  return {
    id: 'So11111111111111111111111111111111111111112',
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 9,
    dev: null,
    launchpad: 'test',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    liquidity: 50_000,
    holderCount: 500,
    organicScore: 60,
    mcap: 400_000,
    fdv: 400_000,
    usdPrice: 0.0004,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
    stats5m: { numBuys: 200, numSells: 60, numTraders: 120 },
    createdAt: new Date(NOW - 30 * 60_000).toISOString(),
    firstPool: null,
    updatedAt: null,
    ...over,
  } as unknown as MintInformation;
}

/** Screens a token and records it exactly as the pipeline does. */
function record(info: MintInformation, takenUtcMs = NOW): string {
  const { gates } = screenCheap(info, config, takenUtcMs, 0);
  const result = finalizeScreen(info, config, takenUtcMs, gates, null, null, null);
  insertSnapshot(db, result.snapshot);
  insertScreening(db, result.outcome);
  return result.snapshot.snapshotId;
}

function rows(): SnapshotRow[] {
  return snapshotRows(db, 100);
}

describe('replay reproduces stored decisions', () => {
  it('finds no divergence in a corpus it wrote itself', () => {
    for (let i = 0; i < 25; i += 1) {
      // Liquidity is varied across the gate boundary so the corpus contains
      // both verdicts. A corpus of all-rejects would let a replay that always
      // answers "reject" pass.
      record(token({ id: `mint${i}`.padEnd(43, 'x'), liquidity: 1_000 + i * 4_000 }));
    }
    const summary = replayAll(db, config, rows());

    expect(summary.replayed).toBe(25);
    expect(summary.threw).toBe(0);
    expect(summary.divergentSnapshots).toBe(0);
    expect(summary.mismatches).toEqual([]);
  });

  /**
   * Guards the test above rather than the code. A corpus in which every row
   * carries the identical verdict would be satisfied by a replay that always
   * answered the same thing, so the corpus is required to disagree with itself
   * somewhere before "0 divergences" counts as evidence.
   */
  it('produced a corpus that disagrees with itself, so the check had something to distinguish', () => {
    for (let i = 0; i < 25; i += 1) {
      record(token({ id: `mint${i}`.padEnd(43, 'x'), liquidity: 1_000 + i * 4_000 }));
    }
    const vetoSets = new Set(rows().map((r) => r.hard_vetoes_json));
    expect(vetoSets.size).toBeGreaterThan(1);
    expect(new Set(rows().map((r) => r.opportunity_score)).size).toBeGreaterThan(1);
  });

  it('is stable across repetition: replaying twice gives the same answer', () => {
    record(token());
    const a = replayAll(db, config, rows());
    const b = replayAll(db, config, rows());
    expect(a.mismatches).toEqual(b.mismatches);
    expect(a.divergentSnapshots).toBe(b.divergentSnapshots);
  });
});

describe('replay rebuilds quotes from storage', () => {
  /**
   * The reconstruction path most likely to rot. Quote amounts are u64 stored as
   * TEXT because SQLite's INTEGER is signed, and the route path is stored as a
   * '>'-joined string rather than JSON. Both are conversions that a reasonable
   * refactor could break without any type error, and a broken one would change
   * the round-trip cost — the number the entry decision turns on.
   */
  function quote(over: Partial<ExecutableQuote> = {}): ExecutableQuote {
    return {
      quoteId: newId(),
      inputMint: SOL,
      outputMint: MINT,
      inAmount: 50_000_000n,
      // Deliberately past 2^53 so a conversion through a double would round.
      outAmount: 18_446_744_073_709_551_000n,
      otherAmountThreshold: 18_000_000_000_000_000_000n,
      slippageBps: 100,
      platformFeeBps: 0,
      priceImpactPct: 0.4,
      router: 'jupiter',
      routeLabels: ['Raydium', 'Orca'],
      signatureFeeLamports: 5_000n,
      prioritizationFeeLamports: 10_000n,
      rentFeeLamports: 2_039_280n,
      transactionBuildable: true,
      errorCode: null,
      errorMessage: null,
      requestedUtcMs: NOW - 500,
      receivedUtcMs: NOW,
      latencyMs: 500,
      provenance: {
        source: 'test',
        sourceType: 'aggregator',
        receivedMonotonicMs: 0,
        receivedUtcMs: NOW,
        slot: null,
        sourceUtcMs: null,
        schemaVersion: 'test',
        parserVersion: 'test',
        payloadHash: '',
      },
      ...over,
    } as unknown as ExecutableQuote;
  }

  function recordWithRoundTrip(info: MintInformation): void {
    const buy = quote();
    const sell = quote({ inputMint: MINT, outputMint: SOL, inAmount: buy.outAmount, outAmount: 49_700_000n });
    const roundTrip = { buy, sell, roundTripLossBps: 60, exitExists: true } as RoundTrip;

    insertQuote(db, info.id, 'buy', buy);
    insertQuote(db, info.id, 'sell', sell);

    const { gates } = screenCheap(info, config, NOW, 0);
    const result = finalizeScreen(info, config, NOW, gates, roundTrip, null, null);
    insertSnapshot(db, result.snapshot);
    insertScreening(db, result.outcome);
  }

  it('reproduces a decision that depended on a measured round trip', () => {
    recordWithRoundTrip(token({ id: MINT }));
    const summary = replayAll(db, config, rows());
    expect(summary.replayed).toBe(1);
    expect(summary.mismatches).toEqual([]);
  });

  it('carries a u64 quote amount through storage without rounding it', () => {
    recordWithRoundTrip(token({ id: MINT }));
    const buyId = (
      JSON.parse((rows()[0]!).raw_inputs_json) as { buyQuoteId: string | null }
    ).buyQuoteId;
    expect(buyId).not.toBeNull();

    const reloaded = loadQuote(db, buyId);
    expect(reloaded?.outAmount).toBe(18_446_744_073_709_551_000n);
    expect(reloaded?.routeLabels).toEqual(['Raydium', 'Orca']);
  });

  /**
   * A missing quote must change the verdict rather than be silently treated as
   * a free round trip. Deleting the buy quote is what a pruned database looks
   * like, and replay claiming the same answer over absent evidence would be the
   * exact failure this suite exists to rule out.
   */
  it('diverges when the quote a decision rested on is gone', () => {
    recordWithRoundTrip(token({ id: MINT }));
    db.prepare(`DELETE FROM quotes WHERE side = 'buy'`).run();
    const summary = replayAll(db, config, rows());
    expect(summary.divergentSnapshots).toBe(1);
  });
});

describe('replay detects a decision that does not match its snapshot', () => {
  /**
   * Each of these corrupts one stored column and asserts that replay names that
   * column. Naming matters: an operator reading "divergent snapshots: 1" needs
   * to know whether the strategy moved or the storage lied.
   */
  it('catches a flipped eligibility verdict', () => {
    record(token());
    db.prepare('UPDATE screenings SET eligible = 1 - eligible').run();
    const summary = replayAll(db, config, rows());
    expect(summary.divergentSnapshots).toBe(1);
    expect(summary.mismatches.map((m) => m.field)).toContain('eligible');
  });

  it('catches an altered opportunity score', () => {
    record(token());
    db.prepare('UPDATE screenings SET opportunity_score = opportunity_score + 0.25').run();
    const summary = replayAll(db, config, rows());
    expect(summary.mismatches.map((m) => m.field)).toContain('opportunityScore');
  });

  it('catches an altered soft risk score', () => {
    record(token());
    db.prepare('UPDATE screenings SET soft_risk_score = soft_risk_score + 0.5').run();
    const summary = replayAll(db, config, rows());
    expect(summary.mismatches.map((m) => m.field)).toContain('softRiskScore');
  });

  it('catches a veto list that gained a reason nobody recorded', () => {
    record(token());
    db.prepare(`UPDATE screenings SET hard_vetoes_json = '["invented_reason"]'`).run();
    const summary = replayAll(db, config, rows());
    expect(summary.mismatches.map((m) => m.field)).toContain('hardVetoes');
  });

  /**
   * Veto order is presentation, not substance. If replay reported this as a
   * divergence, a harmless change to gate evaluation order would read as a
   * determinism failure and the signal would be trained out of the operator.
   */
  it('does not report a divergence when only the veto ORDER differs', () => {
    record(token({ liquidity: 1, holderCount: 0 }));
    const stored = JSON.parse(
      (db.prepare('SELECT hard_vetoes_json AS v FROM screenings').get() as { v: string }).v,
    ) as string[];
    expect(stored.length).toBeGreaterThan(1);

    db.prepare('UPDATE screenings SET hard_vetoes_json = ?').run(JSON.stringify([...stored].reverse()));
    const summary = replayAll(db, config, rows());
    expect(summary.mismatches).toEqual([]);
  });

  it('reports a snapshot it cannot re-decide as a divergence rather than skipping it', () => {
    record(token());
    db.prepare(`UPDATE decision_snapshots SET raw_inputs_json = 'not json'`).run();
    const summary = replayAll(db, config, rows());
    expect(summary.threw).toBe(1);
    expect(summary.divergentSnapshots).toBe(1);
    expect(summary.mismatches[0]?.field).toBe('exception');
  });
});

describe('replay scopes itself to the current strategy version', () => {
  it('skips rows from another version instead of counting them as divergences', () => {
    record(token());
    db.prepare(`UPDATE screenings SET strategy_version = 'some-older-version'`).run();

    const summary = replayAll(db, config, rows());
    expect(summary.examined).toBe(1);
    expect(summary.replayed).toBe(0);
    expect(summary.skippedOtherVersion).toBe(1);
    expect(summary.mismatches).toEqual([]);
  });

  /**
   * The empty case is the dangerous one: zero divergences over zero rows is not
   * evidence of determinism, and the caller must be able to tell the two apart.
   * `replayed` is what makes that possible, which is why the CLI fails when it
   * is zero despite there being no mismatches.
   */
  it('reports zero replayed rather than a vacuous pass', () => {
    record(token());
    db.prepare(`UPDATE screenings SET strategy_version = 'some-older-version'`).run();
    const summary = replayAll(db, config, rows());
    expect(summary.divergentSnapshots).toBe(0);
    expect(summary.replayed).toBe(0);
  });
});

describe('a decision depends only on what the snapshot captured', () => {
  /**
   * Replay reconstructs `createdAt` from the recorded age rather than from a
   * wall clock, so the same snapshot must decide the same way no matter when it
   * is replayed. If this failed, every backtest would be a function of the hour
   * it was run.
   */
  it('gives the same verdict regardless of the time of replay', () => {
    const info = token();
    const takenAt = NOW - 5 * 24 * 3_600_000;
    record(info, takenAt);

    const [row] = rows();
    expect(row).toBeDefined();
    expect(replayOne(db, config, row!)).toEqual([]);
  });

  it('rejects the same token identically at two different absolute times', () => {
    const early = openDb({ path: join(dir, `t-early-${n++}.db`) });
    const late = openDb({ path: join(dir, `t-late-${n++}.db`) });
    const info = token({ liquidity: 1 });

    // The token must be the same AGE at each evaluation, not carry the same
    // absolute birthday: age is an input the gates read, so holding createdAt
    // fixed while moving the clock would be varying two things at once.
    const write = (target: Db, at: number): void => {
      const aged = { ...info, createdAt: new Date(at - 30 * 60_000).toISOString() } as MintInformation;
      const { gates } = screenCheap(aged, config, at, 0);
      const r = finalizeScreen(aged, config, at, gates, null, null, null);
      insertSnapshot(target, r.snapshot);
      insertScreening(target, r.outcome);
    };
    write(early, NOW);
    write(late, NOW + 90 * 24 * 3_600_000);

    const a = snapshotRows(early, 10)[0]!;
    const b = snapshotRows(late, 10)[0]!;
    expect(a.eligible).toBe(b.eligible);
    expect(a.opportunity_score).toBe(b.opportunity_score);
    expect(JSON.parse(a.hard_vetoes_json)).toEqual(JSON.parse(b.hard_vetoes_json));
  });
});

describe('concentration is part of the snapshot, not an input replay has to guess', () => {
  /**
   * The gates see an authoritative on-chain holder distribution. Until O042 it
   * was not written to the row, so replay re-decided against null, produced
   * `holder_concentration_unavailable` in place of `holder_concentration`, and
   * reported a different soft-risk mean. 28 live rows diverged this way the
   * moment the v0.3.0 bump let replay run again.
   *
   * These tests are about the ROUND TRIP: what the gates saw must come back.
   */

  /** Records a decision taken WITH a concentration measurement. */
  function recordWithConcentration(c: ConcentrationInput | null, over: Partial<MintInformation> = {}): string {
    const info = token(over);
    const { gates } = screenCheap(info, config, NOW, 0);
    const result = finalizeScreen(info, config, NOW, gates, null, null, c);
    insertSnapshot(db, result.snapshot);
    insertScreening(db, result.outcome);
    return result.snapshot.snapshotId;
  }

  it('reproduces a decision that used a concentration measurement', () => {
    recordWithConcentration({ topWalletPct: 8, topTenWalletPct: 25, programControlledPct: 60 });
    const summary = replayAll(db, config, rows());
    expect(summary.unverifiable).toBe(0);
    expect(summary.replayed).toBe(1);
    expect(summary.mismatches).toEqual([]);
  });

  it('reproduces a concentrated_ownership veto rather than losing it', () => {
    // Above maxTopHolderPct, so the stored decision carries a hard veto that
    // a replay against null could not produce.
    recordWithConcentration({ topWalletPct: 40, topTenWalletPct: 95, programControlledPct: 1 });
    const stored = rows()[0]!;
    expect(JSON.parse(stored.hard_vetoes_json)).toContain('concentrated_ownership');
    expect(replayOne(db, config, stored)).toEqual([]);
  });

  it('distinguishes measured-and-unavailable from never-measured', () => {
    recordWithConcentration(null);
    const stored = rows()[0]!;
    const raw = JSON.parse(stored.raw_inputs_json) as Record<string, unknown>;
    expect('concentration' in raw).toBe(true);
    expect(raw['concentration']).toBeNull();
    expect(replayOne(db, config, stored)).toEqual([]);
  });

  it('does not silently drop a concentration measurement that disagrees', () => {
    // Two decisions differing ONLY in concentration must not replay alike; if
    // they did, the field would be arriving nowhere.
    const low = recordWithConcentration(
      { topWalletPct: 2, topTenWalletPct: 10, programControlledPct: 80 },
      { id: 'mintLow'.padEnd(43, 'x') },
    );
    const high = recordWithConcentration(
      { topWalletPct: 30, topTenWalletPct: 60, programControlledPct: 5 },
      { id: 'mintHigh'.padEnd(43, 'x') },
    );
    const all = rows();
    const a = all.find((r) => r.snapshot_id === low)!;
    const b = all.find((r) => r.snapshot_id === high)!;
    expect(a.soft_risk_score).not.toBe(b.soft_risk_score);
    expect(replayAll(db, config, all).mismatches).toEqual([]);
  });
});

describe('a snapshot missing an input it depended on is unverifiable, not a pass', () => {
  /** Strips the concentration key, reproducing a pre-O042 row. */
  function stripConcentration(row: SnapshotRow): SnapshotRow {
    const raw = JSON.parse(row.raw_inputs_json) as Record<string, unknown>;
    delete raw['concentration'];
    return { ...row, raw_inputs_json: JSON.stringify(raw) };
  }

  function recorded(c: ConcentrationInput | null): SnapshotRow {
    const info = token();
    const { gates } = screenCheap(info, config, NOW, 0);
    const result = finalizeScreen(info, config, NOW, gates, null, null, c);
    insertSnapshot(db, result.snapshot);
    insertScreening(db, result.outcome);
    return rows()[0]!;
  }

  it('counts a stripped row as unverifiable rather than divergent', () => {
    const row = stripConcentration(recorded({ topWalletPct: 8, topTenWalletPct: 25, programControlledPct: 60 }));
    expect(replayable(row)).toBe(false);

    const summary = replayAll(db, config, [row]);
    expect(summary.unverifiable).toBe(1);
    expect(summary.replayed).toBe(0);
    expect(summary.divergentSnapshots).toBe(0);
    // And critically: not counted as a version skip, where it would vanish.
    expect(summary.skippedOtherVersion).toBe(0);
  });

  it('still replays a stripped row whose gates show no measurement was taken', () => {
    // No concentration was ever measured, so nothing is missing and the row is
    // fully reproducible. Excluding it would be the O035 failure: verifying
    // less while reporting success.
    const row = stripConcentration(recorded(null));
    expect(replayable(row)).toBe(true);
    const summary = replayAll(db, config, [row]);
    expect(summary.unverifiable).toBe(0);
    expect(summary.replayed).toBe(1);
    expect(summary.mismatches).toEqual([]);
  });

  it('a row that carries the key is replayable whatever its gates say', () => {
    expect(replayable(recorded({ topWalletPct: 8, topTenWalletPct: 25, programControlledPct: 60 }))).toBe(true);
    expect(replayable(recorded(null))).toBe(true);
  });
});
