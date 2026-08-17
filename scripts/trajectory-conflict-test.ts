/**
 * `pnpm trajectory:conflict-test` — prove the append-only writers are LOUD.
 *
 * The 8f73cef audit's L-1 ran seven ambiguities against the corpus and found
 * FIVE silently discarded:
 *
 *   duplicate trajectory id                      REFUSED LOUDLY
 *   replacement settlement, different economics   SILENTLY DISCARDED
 *   a different exit on the same trajectory       SILENTLY DISCARDED
 *   duplicate mark, different price               SILENTLY DISCARDED
 *   an unrelated job attached to the trajectory   IMPOSSIBLE TO ATTACH OR DETECT
 *   zero-row update                               reported success
 *   multi-row update                              64 rows in one statement
 *
 * "`insertTrajectorySettlement`'s own comment says a second different answer
 * *is refused rather than allowed to overwrite the first*; it is DISCARDED,
 * which is not the same thing, because the caller cannot tell."
 *
 * This command re-runs them. It runs against a TEMPORARY DATABASE, never the
 * corpus: a test that mutates the research corpus to prove the corpus is safe
 * is not a test worth having.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../packages/storage/src/db.js';
import {
  insertTrajectory,
  insertTrajectorySettlement,
  persistTrajectoryEconomics,
} from '../packages/storage/src/trajectory-repo.js';
import { insertMark, insertPolicyOutcome } from '../packages/storage/src/mark-repo.js';
import { writeArtifact } from './_artifact.js';

interface Case {
  readonly name: string;
  readonly expectation: 'THROWS' | 'IDEMPOTENT';
  outcome?: string;
  pass?: boolean;
}

const NOW = 1_700_000_000_000;

function settlement(net: bigint | null): Parameters<typeof insertTrajectorySettlement>[3] {
  return {
    entryCashOutLamports: 20_000_000n,
    exitCashInLamports: net === null ? null : 19_000_000n,
    grossExitCreditLamports: 19_500_000n,
    baseFeesLamports: 10_000n,
    priorityFeesLamports: 0n,
    tipsLamports: 0n,
    transferFeesLamports: 0n,
    failedAttemptFeesLamports: 0n,
    rentCreatedLamports: 0n,
    rentRecoveredLamports: 0n,
    rentStillLockedLamports: 0n,
    cashbackAccruedLamports: 0n,
    cashbackClaimableLamports: 0n,
    cashbackClaimedLamports: 0n,
    cashbackClaimCostLamports: 0n,
    residualTokenAtoms: 0n,
    unexplainedLamports: 0n,
    executionCostLamports: 10_000n,
    netPnlLamports: net,
    pnlBlockedReasons: [],
  };
}

function mark(offsetMs: number, price: bigint) {
  return {
    atMs: NOW + offsetMs,
    offsetMs,
    executableLamports: price,
    exitCapacityLamports: price,
    effectiveQuoteReserveLamports: 100_000_000n,
    refusal: null,
    latenessMs: 0,
  };
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'epitaxy-conflict-'));
  const db = openDb({ path: join(dir, 'conflict.db'), skipBackup: true });
  const cases: Case[] = [
    { name: 'duplicate trajectory id', expectation: 'THROWS' },
    { name: 'replacement settlement with DIFFERENT economics', expectation: 'THROWS' },
    { name: 'the identical settlement twice', expectation: 'IDEMPOTENT' },
    { name: 'a DIFFERENT mark at a recorded offset', expectation: 'THROWS' },
    { name: 'the identical mark twice', expectation: 'IDEMPOTENT' },
    { name: 'a DIFFERENT exit for the same policy', expectation: 'THROWS' },
    { name: 'the identical policy outcome twice', expectation: 'IDEMPOTENT' },
    { name: 'zero-row economics update on a nonexistent trajectory', expectation: 'THROWS' },
  ];

  const run = (c: Case, fn: () => void): void => {
    try {
      fn();
      c.outcome = 'no error';
      c.pass = c.expectation === 'IDEMPOTENT';
    } catch (e) {
      c.outcome = `${(e as Error).name}: ${(e as Error).message.slice(0, 70)}`;
      c.pass = c.expectation === 'THROWS';
    }
  };

  try {
    const base = {
      identity: {
        trajectoryId: 'conflict-1',
        entryObservationId: 'obs-1',
        entrySimulationJobId: 'job-1',
        entrySettlementId: 'set-1',
        venue: 'PUMPSWAP_DIRECT',
        pool: 'Pool1',
        capabilityFingerprint: 'f'.repeat(64),
        snapshotHash: 'a'.repeat(64),
        mint: 'Mint1',
        cohort: 'FIRST_HOUR',
        stratum: 'S',
        migrationAgeMs: null,
        notionalLamports: 20_000_000n,
        entryPolicyInputs: {},
      },
      entryPolicy: 'HARD_GATES_RANDOM',
      exitPolicy: 'FIXED_15M_CONTROL',
      state: 'AWAITING_FILL_OBSERVATION',
      impact: {
        quoteImpactRatio: 0.001,
        baseImpactRatio: 0.001,
        maxImpactRatio: 0.001,
        haircutBps: 25,
        withinSmallImpactBound: true,
        boundUsed: 0.005,
      },
      maxAttainableGrade: 'SIMULATED_EXECUTION',
      refusals: [],
      openedUtcMs: NOW,
    };
    insertTrajectory(db, base as never);

    run(cases[0]!, () => insertTrajectory(db, base as never));

    insertTrajectorySettlement(db, 'conflict-1', 'IMMEDIATE_MECHANICS', settlement(-1_000_000n), [], NOW);
    run(cases[1]!, () =>
      insertTrajectorySettlement(db, 'conflict-1', 'IMMEDIATE_MECHANICS', settlement(-2_000_000n), [], NOW),
    );
    run(cases[2]!, () =>
      insertTrajectorySettlement(db, 'conflict-1', 'IMMEDIATE_MECHANICS', settlement(-1_000_000n), [], NOW),
    );

    insertMark(db, 'conflict-1', mark(1_800_000, 18_678_909n));
    run(cases[3]!, () => insertMark(db, 'conflict-1', mark(1_800_000, 123_456_789n)));
    run(cases[4]!, () => insertMark(db, 'conflict-1', mark(1_800_000, 18_678_909n)));

    const outcome = (exitMark: bigint) => ({
      exitPolicy: 'FIXED_15M_CONTROL' as const,
      triggeredAtMs: NOW + 900_000,
      triggeredOffsetMs: 900_000,
      filledAtMs: NOW + 900_000,
      filledOffsetMs: 900_000,
      reason: 'the frozen 15 minute horizon',
      exitMarkLamports: exitMark,
      grossDeltaLamports: exitMark - 20_000_000n,
    });
    insertPolicyOutcome(db, 'conflict-1', 20_000_000n, outcome(19_000_000n), NOW);
    run(cases[5]!, () => insertPolicyOutcome(db, 'conflict-1', 20_000_000n, outcome(1_000_000n), NOW));
    run(cases[6]!, () => insertPolicyOutcome(db, 'conflict-1', 20_000_000n, outcome(19_000_000n), NOW));

    run(cases[7]!, () => persistTrajectoryEconomics(db, 'does-not-exist', settlement(-1n) as never, NOW));

    console.log('append-only conflict probes\n');
    for (const c of cases) {
      console.log(
        `  ${c.pass === true ? 'PASS' : 'FAIL'}  ${c.name.padEnd(52)} expected ${c.expectation.padEnd(10)} ${c.outcome}`,
      );
    }

    const failures = cases.filter((c) => c.pass !== true).length;
    const conflicts = Number((db.prepare('SELECT COUNT(*) c FROM evidence_conflicts').get() as { c: number }).c);
    console.log(`\nrecorded evidence_conflicts rows: ${conflicts}`);
    console.log(`verdict: ${failures === 0 ? 'ALL AMBIGUITIES ARE LOUD' : `${failures} SILENT`}`);

    const path = writeArtifact('trajectory-conflict-test.json', {
      cases,
      failures,
      recordedConflicts: conflicts,
      verdict: failures === 0 ? 'ALL_LOUD' : 'SOME_SILENT',
      note: 'run against a temporary database; the research corpus is never mutated by this command',
    });
    console.log(`-> ${path}`);
    db.close();
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the temp directory is the OS's problem after this */
    }
  }
}

main();
