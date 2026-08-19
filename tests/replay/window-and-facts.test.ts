import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../packages/storage/src/db.js';
import { insertSnapshot, insertScreening } from '../../packages/storage/src/repo.js';
import { loadConfig, type AppConfig } from '../../packages/domain/src/config.js';
import { screenCheap, finalizeScreen } from '../../packages/strategy/src/screen.js';
import { cohortOf, isCohort, COHORT_BOUNDS } from '../../packages/domain/src/cohort.js';
import { gateFactsFrom, type DirectMintFacts } from '../../packages/intelligence/src/mintfacts-source.js';
import { replayOne, snapshotRows, loadMintFacts } from '../../packages/research/src/replay.js';
import type { MintInformation } from '../../packages/adapters/src/jupiter/schemas.js';

/**
 * The two decision inputs replay was not reconstructing.
 *
 * `pnpm replay` against the live corpus FAILED, and both causes were in replay
 * rather than in the decisions:
 *
 *   1. it screened every snapshot under the GLOBAL 2m-60m age window, while the
 *      cycle screens under the candidate's COHORT window. Every snapshot older
 *      than an hour replayed with an extra `too_old` veto the stored decision
 *      correctly did not have;
 *   2. it passed `token2022: null`, so `token2022_money_critical` — a 0.6
 *      soft-risk contribution, the largest single term in the table — could not
 *      fire. Six stored decisions carried it and replayed 0.27 lower.
 *
 * `tests/replay/determinism.test.ts` did not catch either, and could not: its
 * corpus is written by calling `screenCheap(info, config, takenUtcMs, sourceAge)`
 * with no cohort bounds and no mint facts — the same four arguments the broken
 * replay used. A corpus built through the defect cannot exhibit the defect.
 *
 * So this file builds the corpus the way the CYCLE builds it, and asserts both
 * directions: the fixed replay reproduces it, and the old replay's inputs would
 * have produced a different verdict. The second half is what makes these tests
 * regression tests rather than a second pass over the same tautology.
 */

const dir = mkdtempSync(join(tmpdir(), 'replay-window-'));
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
  db = openDb({ path: join(dir, `rw-${n++}.db`) });
  config = loadConfig('observe');
});

const NOW = 1_700_000_000_000;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function token(over: Partial<MintInformation> = {}): MintInformation {
  return {
    id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 9,
    dev: null,
    launchpad: 'test',
    tokenProgram: LEGACY,
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

const facts = (mint: string, over: Partial<DirectMintFacts> = {}): DirectMintFacts =>
  ({
    mint,
    tokenProgram: TOKEN_2022,
    mintAuthority: 'SAFE',
    freezeAuthority: 'SAFE',
    permanentDelegate: 'SAFE',
    defaultAccountState: 'SAFE',
    transferHook: 'SAFE',
    nonTransferable: 'SAFE',
    pausable: 'SAFE',
    confidential: 'SAFE',
    overall: 'SAFE',
    transferFeeBps: null,
    currentEpochTransferFeeBps: null,
    worstCaseTransferFeeBps: null,
    maximumFeeAtoms: null,
    readUtcMs: NOW,
    extensionTypes: [],
    hasUnknownExtension: false,
    decodeFailure: null,
    reasons: [],
    ...over,
  }) as DirectMintFacts;

/**
 * The production upsert, not a plain INSERT.
 *
 * `direct_mint_facts` is keyed on mint and the cycle re-reads mints, so the real
 * write is ON CONFLICT DO UPDATE. A double that only inserts would pass every
 * test that writes a mint once and throw on the first one that writes it twice —
 * which is exactly the lookahead test below, the one that has to write two
 * different read times for one mint.
 */
function persistFacts(f: DirectMintFacts): void {
  db.prepare(
    `INSERT INTO direct_mint_facts (
       mint, read_utc_ms, token_program, mint_authority, freeze_authority,
       permanent_delegate, default_account_state, transfer_hook, non_transferable,
       pausable, confidential, overall, current_epoch_fee_bps, worst_case_fee_bps,
       maximum_fee_atoms, extension_types, has_unknown_extension, decode_failure,
       reasons, provider_disagreements)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(mint) DO UPDATE SET
       read_utc_ms = excluded.read_utc_ms,
       token_program = excluded.token_program,
       mint_authority = excluded.mint_authority,
       freeze_authority = excluded.freeze_authority,
       permanent_delegate = excluded.permanent_delegate,
       default_account_state = excluded.default_account_state,
       transfer_hook = excluded.transfer_hook,
       non_transferable = excluded.non_transferable,
       pausable = excluded.pausable,
       confidential = excluded.confidential,
       overall = excluded.overall,
       current_epoch_fee_bps = excluded.current_epoch_fee_bps,
       worst_case_fee_bps = excluded.worst_case_fee_bps,
       maximum_fee_atoms = excluded.maximum_fee_atoms,
       extension_types = excluded.extension_types,
       has_unknown_extension = excluded.has_unknown_extension,
       decode_failure = excluded.decode_failure,
       reasons = excluded.reasons`,
  ).run(
    f.mint,
    f.readUtcMs,
    f.tokenProgram,
    f.mintAuthority,
    f.freezeAuthority,
    f.permanentDelegate,
    f.defaultAccountState,
    f.transferHook,
    f.nonTransferable,
    f.pausable,
    f.confidential,
    f.overall,
    f.currentEpochTransferFeeBps,
    f.worstCaseTransferFeeBps,
    f.maximumFeeAtoms === null ? null : f.maximumFeeAtoms.toString(),
    f.extensionTypes.join(','),
    f.hasUnknownExtension ? 1 : 0,
    f.decodeFailure,
    f.reasons.join('; ').slice(0, 400),
  );
}

/**
 * Records a decision the way `runCycle` records one: under the candidate's own
 * cohort window, and with the mint facts it read at the same moment.
 */
function recordAsCycleDoes(info: MintInformation, ageMs: number, f: DirectMintFacts | null): void {
  const takenUtcMs = NOW;
  const withAge = token({ ...info, createdAt: new Date(takenUtcMs - ageMs).toISOString() });
  const cohort = cohortOf(ageMs);
  const bounds = isCohort(cohort) ? COHORT_BOUNDS[cohort] : null;
  const t22 = f === null ? null : gateFactsFrom(f);
  const { gates } = screenCheap(withAge, config, takenUtcMs, 0, null, t22, bounds);
  const result = finalizeScreen(withAge, config, takenUtcMs, gates, null, null, null, 0);
  insertSnapshot(db, result.snapshot);
  insertScreening(db, result.outcome);
  if (f !== null) persistFacts(f);
}

describe('replay reconstructs the cohort age window', () => {
  const AGE_176_MIN = 176 * 60_000;

  it('reproduces a decision taken under the 1h-5h window', () => {
    recordAsCycleDoes(token(), AGE_176_MIN, null);
    const rows = snapshotRows(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_age_ms).toBe(AGE_176_MIN);
    expect(replayOne(db, config, rows[0] as never)).toEqual([]);
  });

  it('and the GLOBAL window would have vetoed the same token too_old', () => {
    // The defect, demonstrated rather than asserted from memory: this is exactly
    // what the four-argument call replay used to make, and it disagrees.
    const withAge = token({ createdAt: new Date(NOW - AGE_176_MIN).toISOString() });
    const globalWindow = screenCheap(withAge, config, NOW, 0);
    const cohortWindow = screenCheap(withAge, config, NOW, 0, null, null, COHORT_BOUNDS.AGE_1H_5H);
    const vetoes = (g: ReturnType<typeof screenCheap>): string[] =>
      g.gates.filter((x) => x.severity === 'hard_veto' && !x.passed).map((x) => x.reason);
    expect(vetoes(globalWindow)).toContain('too_old');
    expect(vetoes(cohortWindow)).not.toContain('too_old');
  });

  it('keeps the global window for an age no cohort claims', () => {
    // 30 seconds old: below every cohort's floor, so the global window is
    // correct — which is what the live path does for an unassigned candidate.
    expect(isCohort(cohortOf(30_000))).toBe(false);
    recordAsCycleDoes(token(), 30_000, null);
    const rows = snapshotRows(db, 10);
    expect(replayOne(db, config, rows[0] as never)).toEqual([]);
  });
});

describe('replay reconstructs the Token-2022 facts', () => {
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const hostile = (): DirectMintFacts =>
    facts(MINT, { permanentDelegate: 'HOSTILE', overall: 'HOSTILE', reasons: ['permanent delegate is live'] });

  it('reproduces a decision that fired token2022_money_critical', () => {
    recordAsCycleDoes(token({ tokenProgram: TOKEN_2022 }), 30 * 60_000, hostile());
    const rows = snapshotRows(db, 10);
    expect(rows).toHaveLength(1);
    // The stored decision really did carry the term; otherwise this test would
    // pass against a replay that ignores the facts entirely.
    const stored = JSON.parse(rows[0]?.gates_json ?? '[]') as { gate: string }[];
    expect(stored.map((g) => g.gate)).toContain('token2022_money_critical');
    expect(replayOne(db, config, rows[0] as never)).toEqual([]);
  });

  it('and passing no facts would have changed the soft risk score', () => {
    const info = token({ tokenProgram: TOKEN_2022 });
    const withFacts = screenCheap(info, config, NOW, 0, null, gateFactsFrom(hostile()), null);
    const without = screenCheap(info, config, NOW, 0, null, null, null);
    const score = (g: ReturnType<typeof screenCheap>): number =>
      finalizeScreen(info, config, NOW, g.gates, null, null, null, 0).outcome.softRiskScore;
    expect(score(withFacts)).toBeGreaterThan(score(without));
  });

  it('refuses facts read AFTER the snapshot, because that is a later fact', () => {
    persistFacts(facts(MINT, { readUtcMs: NOW + 1 }));
    expect(loadMintFacts(db, MINT, NOW)).toBeNull();
    // At or before the snapshot it is the fact the decision saw, and it loads.
    persistFacts(facts(MINT, { readUtcMs: NOW }));
    expect(loadMintFacts(db, MINT, NOW)).not.toBeNull();
  });

  it('round-trips every field the gate reads', () => {
    const f = facts(MINT, {
      transferHook: 'HOSTILE',
      overall: 'HOSTILE',
      currentEpochTransferFeeBps: 250,
      worstCaseTransferFeeBps: 900,
      maximumFeeAtoms: 9_007_199_254_740_993n,
      extensionTypes: [1, 14, 19],
      hasUnknownExtension: true,
      reasons: ['transfer hook is live', 'unknown extension 41'],
    });
    persistFacts(f);
    const back = loadMintFacts(db, MINT, NOW);
    expect(back).not.toBeNull();
    // The gate's own view of the facts is what has to survive the round trip.
    expect(gateFactsFrom(back as DirectMintFacts)).toEqual(gateFactsFrom(f));
    // And the u64 does not go through a float on the way.
    expect((back as DirectMintFacts).maximumFeeAtoms).toBe(9_007_199_254_740_993n);
    expect((back as DirectMintFacts).extensionTypes).toEqual([1, 14, 19]);
  });
});
