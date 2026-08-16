import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { evaluateReadiness, READINESS_THRESHOLDS } from '../packages/research/src/confirmatory-trajectories.js';

/**
 * P12/F21 — `pnpm readiness`, on the EXACT TRAJECTORY CONTRACT.
 *
 * The command kept reading the old POSITION view: fallback costs, historical
 * shadow structures, and a canary-size gate computed over 519 closed
 * canary-shadow positions. Every one of those numbers is real and none of them
 * is about the thing this directive built. A trajectory is not a position, and
 * a readiness verdict assembled from the wrong table is a verdict about the
 * wrong experiment — which is the same defect class as a proof artifact
 * standing in for a database.
 *
 * The old gate is not deleted. It moved to `pnpm readiness:positions`, because
 * the paper book is still real evidence about the paper book.
 *
 * ## An UNKNOWN is a FAIL
 *
 * Most inputs here are null in a system that has not run long enough, and that
 * is the normal state rather than an error. A gate that treated null as
 * satisfied would report ready fastest when least is known.
 *
 * ## Net PnL is deliberately UNKNOWN
 *
 * `trajectory_policy_outcomes` carries `gross_delta_lamports`: the exit mark
 * minus the entry cash-out. That is a gross figure. It contains no venue fee
 * beyond what the quote already embedded, no unrecoverable rent, no failed
 * attempt, no claim cost and no cashback. Reporting it as net PnL would be the
 * single most flattering substitution available in this repository, so it is
 * reported as `grossOnly` and net stays null until a canonical settlement is
 * written per trajectory.
 */

function provenance(): { commit: string; dirty: boolean } {
  try {
    return {
      commit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      dirty: execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0,
    };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

function main(): void {
  const db = openDb({ path: loadSecrets().databasePath, readonly: true });
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;

  const completed = one("SELECT COUNT(*) c FROM development_trajectories WHERE state = 'SETTLED'");
  const distinctDays = one(
    `SELECT COUNT(DISTINCT date(opened_utc_ms / 1000, 'unixepoch')) c
       FROM development_trajectories WHERE state = 'SETTLED'`,
  );

  /**
   * Only TIMELY paths count toward the sample.
   *
   * A backfilled horizon carries the right label and the wrong instant: the
   * first live window fetched five horizons in one burst, so every exit policy
   * agreed trivially. Counting those as completed trajectories would inflate
   * the sample with observations that cannot distinguish the policies they
   * exist to compare.
   */
  const timely = one(
    `SELECT COUNT(*) c FROM development_trajectories t
      WHERE t.state = 'SETTLED'
        AND NOT EXISTS (SELECT 1 FROM trajectory_marks m
                         WHERE m.trajectory_id = t.trajectory_id AND m.lateness_ms > 60000)`,
  );

  const grossRows = db
    .prepare(
      `SELECT gross_delta_lamports g FROM trajectory_policy_outcomes
        WHERE gross_delta_lamports IS NOT NULL AND exit_policy = 'FIXED_15M_CONTROL'`,
    )
    .all() as { g: string }[];
  let gross = 0n;
  for (const r of grossRows) gross += BigInt(r.g);

  const evaluation = evaluateReadiness({
    // No confirmatory contract has been stamped in the database, so nothing is
    // bound and nothing can hold. Stated, not defaulted to true.
    contractHeld: false,
    completedTrajectories: timely,
    distinctUtcDays: distinctDays,
    // See the header. Gross is not net, and the difference is every cost.
    netPnlLamports: null,
    expectedLogGrowth: null,
    robustLowerBound: null,
    profitFactor: null,
    drawdownBounded: null,
    cvarAcceptable: null,
    catastrophicIncidenceAcceptable: null,
    blockedIncidenceAcceptable: null,
    recentFiftyPositive: null,
    positiveWithoutTopN: {},
    positiveWithoutBestDay: null,
    positiveWithoutBestFiveMintsOrEntities: null,
    positiveUnderDoubleCosts: null,
    positiveUnderLatencyFailureRentCashbackStress: null,
    positiveExactCanarySizeShadow: null,
    replayDivergences: one("SELECT COUNT(*) c FROM replay_runs WHERE divergences > 0"),
    unresolvedReconciliations: 0,
    fingerprintsStable: null,
  });

  db.close();
  const { commit, dirty } = provenance();

  console.log('readiness — the EXACT TRAJECTORY CONTRACT');
  console.log('');
  console.log(`  settled trajectories   ${completed}`);
  console.log(`  TIMELY complete paths  ${timely}  (a backfilled horizon is a label, not an observation)`);
  console.log(`  distinct UTC days      ${distinctDays}`);
  console.log(`  gross delta (control)  ${gross} lamports over ${grossRows.length} outcome(s) — GROSS, not net`);
  console.log('');

  const width = Math.max(...evaluation.gates.map((g) => g.name.length));
  for (const g of evaluation.gates) {
    console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.name.padEnd(width)}  ${g.detail}`);
  }

  console.log('');
  console.log(`VERDICT: ${evaluation.ready ? 'READY' : 'NOT READY'} — ${evaluation.failing.length} blocker(s)`);
  console.log('');
  console.log('Do not weaken a failed gate. A gate that was moved to make a run possible');
  console.log('is not evidence about the strategy, it is evidence about the operator.');
  console.log('');
  console.log('The old POSITION readiness still exists, under its own name:');
  console.log('  pnpm readiness:positions');

  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/readiness.json',
    JSON.stringify(
      {
        artifact: 'readiness',
        directiveSection: 'P12/F21',
        gate: 'EXACT_TRAJECTORY_CONTRACT',
        // The field every downstream reader keys on. Kept identical in name and
        // vocabulary to the position gate it replaces, so a consumer cannot
        // silently read `undefined` and treat it as anything at all.
        verdict: evaluation.ready ? 'READY' : 'NOT_READY',
        generatedUtcMs: Date.now(),
        sourceCommit: commit,
        dirty,
        settledTrajectories: completed,
        timelyCompletePaths: timely,
        distinctUtcDays: distinctDays,
        grossDeltaLamportsControl: gross.toString(),
        grossOutcomeCount: grossRows.length,
        netPnlLamports: null,
        netPnlUnknownBecause:
          'gross_delta_lamports is exit mark minus entry cash-out. It carries no unrecoverable rent, ' +
          'no failed attempt, no claim cost and no cashback. Net requires a canonical settlement per trajectory.',
        thresholds: READINESS_THRESHOLDS,
        ready: evaluation.ready,
        gates: evaluation.gates,
        blockers: evaluation.failing,
        supersedes: 'the position-oriented gate, which now runs as pnpm readiness:positions',
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('wrote artifacts/readiness.json');

  // A non-zero exit so a pipeline cannot treat NOT READY as success.
  if (!evaluation.ready) process.exitCode = 1;
}

main();
