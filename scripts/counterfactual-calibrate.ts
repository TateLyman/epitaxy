/**
 * `pnpm counterfactual:calibrate` — is the bounded contract CONSERVATIVE?
 *
 * P8.3. `BOUNDED_COUNTERFACTUAL_V1` is cheap: it carries our entry's local
 * displacement onto the later real reserves and applies a frozen adverse
 * haircut. `RESERVE_DELTA_REPLAY_V1` is exact: it applies every confirmed
 * pool-touching transaction between entry and mark, in order, to the local
 * post-entry state.
 *
 * The bounded contract cannot be promoted above development evidence until it
 * has been shown conservative against replay. The gate is `conservative`, not
 * `withinTolerance`:
 *
 *   - a bound BELOW the replayed value is pessimistic. It costs opportunity and
 *     cannot manufacture edge.
 *   - a bound ABOVE the replayed value is optimistic, and every row carrying it
 *     overstates the exit — the failure mode that turns a losing strategy into
 *     a winning-looking one.
 *
 * With no replay pairs collected, this reports NOT_RUN with the reason. It does
 * not emit zeros: a zero error rate over zero comparisons reads as a calibrated
 * bound, which is the exact substitution this repository forbids.
 */
import { openDb } from '../packages/storage/src/db.js';
import { calibrate, CALIBRATION_TOLERANCE_BPS } from '../packages/pipeline/src/counterfactual.js';
import { writeArtifact, writeNotRun } from './_artifact.js';

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });
  try {
    const pairs = db
      .prepare(
        `SELECT b.trajectory_id, b.offset_ms,
                b.counterfactual_exit_lamports AS bounded,
                r.counterfactual_exit_lamports AS replayed
           FROM counterfactual_marks b
           JOIN counterfactual_marks r
             ON r.trajectory_id = b.trajectory_id AND r.offset_ms = b.offset_ms
            AND r.evidence_class = 'RESERVE_DELTA_REPLAY_V1'
          WHERE b.evidence_class = 'BOUNDED_COUNTERFACTUAL_V1'
            AND b.counterfactual_exit_lamports IS NOT NULL
            AND r.counterfactual_exit_lamports IS NOT NULL`,
      )
      .all() as { trajectory_id: string; offset_ms: number; bounded: string; replayed: string }[];

    const boundedRows = Number(
      (
        db
          .prepare(`SELECT COUNT(*) c FROM counterfactual_marks WHERE evidence_class = 'BOUNDED_COUNTERFACTUAL_V1'`)
          .get() as { c: number }
      ).c,
    );
    const replayRows = Number(
      (
        db
          .prepare(`SELECT COUNT(*) c FROM counterfactual_marks WHERE evidence_class = 'RESERVE_DELTA_REPLAY_V1'`)
          .get() as { c: number }
      ).c,
    );

    console.log('counterfactual calibration — bounded vs reserve-delta replay\n');
    console.log(`  bounded rows  ${boundedRows}`);
    console.log(`  replay rows   ${replayRows}`);
    console.log(`  paired        ${pairs.length}`);

    if (pairs.length === 0) {
      console.log('');
      console.log('NOT RUN. No trajectory carries BOTH a bounded counterfactual and a reserve-delta replay');
      console.log('for the same horizon, so there is nothing to compare.');
      console.log('');
      console.log('Until a calibration subset exists, every BOUNDED_COUNTERFACTUAL_V1 row stays graded');
      console.log('DEVELOPMENT and may not enter a confirmatory result. A grade is not a plan to calibrate later.');
      const p = writeNotRun(
        'counterfactual-calibration.json',
        'no trajectory carries both a bounded counterfactual and a reserve-delta replay for the same horizon',
        { boundedRows, replayRows, pairedRows: 0, toleranceBps: CALIBRATION_TOLERANCE_BPS },
      );
      console.log(`\n-> ${p}`);
      process.exit(1);
    }

    const results = pairs.map((p) => ({
      trajectoryId: p.trajectory_id,
      offsetMs: p.offset_ms,
      ...(() => {
        const c = calibrate(BigInt(p.bounded), BigInt(p.replayed));
        return {
          boundedExitLamports: c.boundedExitLamports.toString(),
          replayExitLamports: c.replayExitLamports.toString(),
          errorLamports: c.errorLamports.toString(),
          errorBps: c.errorBps,
          conservative: c.conservative,
          withinTolerance: c.withinTolerance,
        };
      })(),
    }));

    const nonConservative = results.filter((r) => !r.conservative);
    const outsideTolerance = results.filter((r) => !r.withinTolerance);

    for (const r of results.slice(0, 20)) {
      console.log(
        `  ${r.trajectoryId.slice(0, 12)}  +${r.offsetMs / 60_000}m  bounded ${r.boundedExitLamports}  ` +
          `replay ${r.replayExitLamports}  error ${r.errorBps} bps  ${r.conservative ? 'conservative' : 'OPTIMISTIC'}`,
      );
    }

    console.log('');
    console.log(`  non-conservative  ${nonConservative.length} of ${results.length}`);
    console.log(`  outside tolerance ${outsideTolerance.length} (tolerance ${CALIBRATION_TOLERANCE_BPS} bps)`);

    const ok = nonConservative.length === 0;
    if (!ok) {
      console.log('');
      console.log('THE BOUND IS NOT CONSERVATIVE. Every bounded row is invalidated: a bound above the');
      console.log('replayed value overstates the exit, and a strategy result built on it is not a');
      console.log('conservative approximation, it is a different quantity.');
    }

    const path = writeArtifact('counterfactual-calibration.json', {
      boundedRows,
      replayRows,
      pairedRows: results.length,
      toleranceBps: CALIBRATION_TOLERANCE_BPS,
      results,
      nonConservative: nonConservative.length,
      outsideTolerance: outsideTolerance.length,
      verdict: ok ? 'BOUND_IS_CONSERVATIVE' : 'BOUND_IS_NOT_CONSERVATIVE',
    });
    console.log(`\n-> ${path}`);
    process.exit(ok ? 0 : 1);
  } finally {
    db.close();
  }
}

main();
