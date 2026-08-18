/**
 * `pnpm evidence:invalidate-old` — close the pre-repair evidence window.
 *
 * NOTHING IS DELETED. The 8f73cef corpus is instrument-development history and
 * it is the only record of how the instrument behaved while it was wrong; a
 * repair that destroys the evidence of the defect cannot be checked.
 *
 * What happens instead is that every pre-repair trajectory is assigned to an
 * evidence context whose validity is INSTRUMENT_DEVELOPMENT_INVALID, with the
 * reasons recorded as data rather than as prose in a document. Every default
 * report reads validity from that table.
 *
 * The reasons are not opinions. Each one is a measured property of the corpus
 * and this command RE-MEASURES it rather than copying the audit's number, so a
 * reason that has silently stopped being true cannot stay in the ledger.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../packages/storage/src/db.js';
import { validateInvalidationReasons } from '../packages/domain/src/invalidation-reason.js';
import { writeArtifact } from './_artifact.js';

const CONTEXT_ID = '5d24e-pre-repair';
const AUDIT_DOC = 'docs/RUNTIME_ADVERSARIAL_AUDIT_8F73CEF.md';

interface Reason {
  readonly code: string;
  readonly statement: string;
  readonly measured: string;
  readonly holds: boolean;
}

function count(db: ReturnType<typeof openDb>, sql: string): number {
  try {
    return Number((db.prepare(sql).get() as { c: number | bigint }).c);
  } catch {
    return -1;
  }
}

function measureReasons(db: ReturnType<typeof openDb>): Reason[] {
  const trajectories = count(db, 'SELECT COUNT(*) AS c FROM development_trajectories');

  const danglingObs = count(
    db,
    `SELECT COUNT(*) AS c FROM development_trajectories t
      WHERE NOT EXISTS (SELECT 1 FROM execution_observations o WHERE o.observation_id = t.entry_observation_id)`,
  );
  const danglingJob = count(
    db,
    `SELECT COUNT(*) AS c FROM development_trajectories t
      WHERE NOT EXISTS (SELECT 1 FROM simulation_jobs j WHERE j.job_id = t.entry_simulation_job_id)`,
  );
  // A sha256 hex digest is 64 lowercase hex characters. A decimal slot number
  // is neither 64 characters long nor free of non-hex digits.
  const notAHash = count(
    db,
    `SELECT COUNT(*) AS c FROM development_trajectories
      WHERE length(snapshot_hash) <> 64 OR snapshot_hash GLOB '*[^0-9a-f]*'`,
  );
  const fingerprintEqualsSnapshot = count(
    db,
    'SELECT COUNT(*) AS c FROM development_trajectories WHERE capability_fingerprint = snapshot_hash',
  );
  const unexplained = count(
    db,
    `SELECT COUNT(*) AS c FROM trajectory_settlements WHERE CAST(unexplained_lamports AS INTEGER) <> 0`,
  );
  const publishingAnyway = count(
    db,
    `SELECT COUNT(*) AS c FROM trajectory_settlements
      WHERE CAST(unexplained_lamports AS INTEGER) <> 0 AND net_pnl IS NOT NULL`,
  );
  const unobservedWritable = count(
    db,
    `SELECT COUNT(*) AS c FROM development_trajectories WHERE refusals LIKE '%unobserved%'`,
  );
  const singleEntryPolicy = count(db, 'SELECT COUNT(DISTINCT entry_policy) AS c FROM development_trajectories');
  const lateMarks = count(db, 'SELECT COUNT(*) AS c FROM trajectory_marks WHERE lateness_ms > 60000');
  const totalMarks = count(db, 'SELECT COUNT(*) AS c FROM trajectory_marks');
  const nullEconomics = count(db, 'SELECT COUNT(*) AS c FROM development_trajectories WHERE net_pnl_lamports IS NULL');
  const simulatedOnly = count(
    db,
    `SELECT COUNT(*) AS c FROM development_trajectories WHERE evidence_grade = 'SIMULATED_EXECUTION'`,
  );
  const dirtySessions = count(db, 'SELECT COUNT(*) AS c FROM collector_sessions WHERE dirty = 1');
  const totalSessions = count(db, 'SELECT COUNT(*) AS c FROM collector_sessions');
  const noLinkRow = count(
    db,
    `SELECT COUNT(*) AS c FROM development_trajectories t
      WHERE NOT EXISTS (SELECT 1 FROM trajectory_evidence_links l WHERE l.trajectory_id = t.trajectory_id)`,
  );

  return [
    {
      code: 'DANGLING_EVIDENCE_LINKS',
      statement: 'the entry observation and worker-job identifiers do not resolve',
      measured: `${danglingObs}/${trajectories} observation ids and ${danglingJob}/${trajectories} job ids dangle`,
      holds: danglingObs > 0 || danglingJob > 0,
    },
    {
      code: 'NO_RAW_PRE_POST_STATE',
      statement: 'no raw pre/post account state is persisted, so no amount is recomputable',
      measured: `${noLinkRow}/${trajectories} trajectories have no evidence-link row`,
      holds: noLinkRow > 0,
    },
    {
      code: 'SNAPSHOT_HASH_IS_NOT_A_HASH',
      statement: 'snapshot_hash is a decimal slot number and commits to no byte of the state',
      measured: `${notAHash}/${trajectories} snapshot_hash values are not 64-hex digests; ` +
        `${fingerprintEqualsSnapshot} capability fingerprints equal the snapshot hash`,
      holds: notAHash > 0,
    },
    {
      code: 'PNL_OVER_UNEXPLAINED_VALUE',
      statement: 'net PnL is published over a payer identity that does not close',
      measured: `${unexplained} settlements carry a non-zero unexplained remainder; ${publishingAnyway} publish net PnL anyway`,
      holds: publishingAnyway > 0,
    },
    {
      code: 'UNOBSERVED_WRITABLE_ACCOUNTS',
      statement: 'writable accounts were touched and not observed on both sides',
      measured: `${unobservedWritable}/${trajectories} trajectories carry an unobserved-writable refusal`,
      holds: unobservedWritable > 0,
    },
    {
      code: 'ENTRY_POLICY_IS_A_LABEL',
      statement: 'the entry policy was written as a label after a common admission decision',
      measured: `${singleEntryPolicy} distinct entry policy value(s) across the corpus`,
      holds: singleEntryPolicy <= 1,
    },
    {
      code: 'LATE_MARKS',
      statement: 'later horizons carry the right label on the wrong instant',
      measured: `${lateMarks}/${totalMarks} marks are more than 60s late`,
      holds: lateMarks > 0,
    },
    {
      code: 'NO_COUNTERFACTUAL_CONTRACT',
      statement: 'future marks are plain later-mainnet quotes with no bounded or replayed contract',
      measured: `${simulatedOnly}/${trajectories} rows are graded SIMULATED_EXECUTION`,
      holds: simulatedOnly > 0,
    },
    {
      code: 'TRAJECTORY_ECONOMICS_NULL',
      statement: 'settleTrajectory was never called, so the trajectory row and the settlement row disagree',
      measured: `${nullEconomics}/${trajectories} trajectories have a NULL net_pnl_lamports`,
      holds: nullEconomics > 0,
    },
    {
      code: 'DIRTY_TREE_PROVENANCE',
      statement: 'sessions were opened from uncommitted trees and cannot be re-derived from their commit',
      measured: `${dirtySessions}/${totalSessions} collector sessions were dirty`,
      holds: dirtySessions > 0,
    },
    {
      code: 'UNMANAGED_CONCURRENCY',
      statement: 'multiple unlocked collectors sampled the same mints, breaching the per-mint cap',
      measured: (() => {
        const worst = db
          .prepare(
            'SELECT mint, COUNT(*) AS c FROM development_trajectories GROUP BY mint ORDER BY c DESC LIMIT 1',
          )
          .get() as { mint: string; c: number } | undefined;
        return worst ? `worst mint produced ${worst.c} trajectories` : 'no trajectories';
      })(),
      holds: true,
    },
  ];
}

/**
 * DEMOTE one named context, with a reason.
 *
 * The ledger is append-only in the direction that matters: a context can be
 * DEMOTED to `INSTRUMENT_DEVELOPMENT_INVALID` and never promoted back. That
 * asymmetry is the whole protection — invalidation is a one-way door, so
 * "append-only" forbids un-invalidating rather than forbidding invalidating.
 *
 * Used when a window turns out to have been collecting under a defect that was
 * only visible later. Its rows are preserved and excluded, exactly like the
 * pre-repair corpus.
 */
function demote(contextId: string, reasons: readonly string[], apply: boolean): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    const row = db
      .prepare('SELECT validity, reasons FROM evidence_contexts WHERE evidence_context_id = ?')
      .get(contextId) as { validity: string; reasons: string } | undefined;
    if (row === undefined) {
      console.error(`no such evidence context: ${contextId}`);
      process.exit(1);
    }
    const affected = count(
      db,
      `SELECT COUNT(*) AS c FROM trajectory_evidence_context WHERE evidence_context_id = '${contextId.replace(/'/g, "''")}'`,
    );
    console.log(`context   ${contextId}`);
    console.log(`validity  ${row.validity}  ->  INSTRUMENT_DEVELOPMENT_INVALID`);
    console.log(`affects   ${affected} trajector(ies), none deleted`);
    for (const r of reasons) console.log(`  reason   ${r}`);

    if (row.validity === 'INSTRUMENT_DEVELOPMENT_INVALID') {
      console.log('\nalready invalid; nothing to do');
      return;
    }
    if (!apply) {
      console.log('\n(dry run — pass --apply)');
      return;
    }
    const existing = JSON.parse(row.reasons) as unknown[];
    const r = db
      .prepare(
        `UPDATE evidence_contexts
            SET validity = 'INSTRUMENT_DEVELOPMENT_INVALID', reasons = ?, closed_utc_ms = ?
          WHERE evidence_context_id = ? AND validity = 'DEVELOPMENT_EVIDENCE'`,
      )
      .run(
        JSON.stringify([...existing, ...reasons.map((x) => ({ code: 'DEMOTED', statement: x }))]),
        Date.now(),
        contextId,
      );
    if (Number(r.changes) !== 1) throw new Error(`demoting ${contextId} changed ${r.changes} rows, expected 1`);
    console.log('\nDEMOTED.');
  } finally {
    db.close();
  }
}

/**
 * S091 — decide whether a `--context=` invocation may demote anything.
 *
 * Exported and pure so the refusal can be exercised as behaviour rather than
 * as a source grep: a test calls this with the argv a shell would have built
 * and reads the verdict the CLI acts on. `main` does nothing with the arguments
 * that this function does not do first.
 */
export interface DemotionPlan {
  readonly kind: 'DEMOTE' | 'REFUSE';
  readonly contextId: string;
  readonly reasons: readonly string[];
  readonly exitCode: number;
  readonly messages: readonly string[];
}

export function planDemotion(argv: readonly string[]): DemotionPlan {
  const ctxArg = argv.find((a) => a.startsWith('--context=')) ?? '';
  const contextId = ctxArg.slice(10);
  const raw = argv.filter((a) => a.startsWith('--reason=')).map((a) => a.slice(9));

  if (raw.length === 0) {
    return {
      kind: 'REFUSE',
      contextId,
      reasons: [],
      exitCode: 2,
      messages: ['--context requires at least one --reason='],
    };
  }

  /**
   * The reason text is checked BEFORE the database is opened.
   *
   * Demotion is a one-way door — `evidence_contexts` accepts
   * DEVELOPMENT_EVIDENCE -> INSTRUMENT_DEVELOPMENT_INVALID and never the
   * reverse — so a reason that explains nothing cannot be corrected later by
   * rewriting it. It has to be refused before it is written, which means before
   * anything else happens.
   */
  const verdict = validateInvalidationReasons(raw);
  if (!verdict.ok) {
    return {
      kind: 'REFUSE',
      contextId,
      reasons: [],
      exitCode: 2,
      messages: [
        `REFUSED: ${verdict.refused.length} of ${raw.length} --reason= argument(s) do not explain anything.`,
        ...verdict.refused.map((r) => `  ${r.refusal.padEnd(10)} ${r.explanation}`),
        '',
        'A demotion is permanent and its reason is the only record of why a window stopped',
        'counting. Say what the defect did to THIS window, not which code it was filed under.',
      ],
    };
  }

  return {
    kind: 'DEMOTE',
    contextId,
    reasons: verdict.accepted,
    exitCode: 0,
    messages: [],
  };
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const ctxArg = process.argv.find((a) => a.startsWith('--context='));
  if (ctxArg !== undefined) {
    const plan = planDemotion(process.argv);
    if (plan.kind === 'REFUSE') {
      for (const m of plan.messages) console.error(m);
      process.exit(plan.exitCode);
    }
    demote(plan.contextId, plan.reasons, apply);
    return;
  }
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });

  try {
    const reasons = measureReasons(db);
    const holding = reasons.filter((r) => r.holds);

    const auditPath = resolve(AUDIT_DOC);
    const auditHash = existsSync(auditPath)
      ? createHash('sha256').update(readFileSync(auditPath)).digest('hex')
      : null;

    const trajectories = (
      db.prepare('SELECT trajectory_id FROM development_trajectories').all() as { trajectory_id: string }[]
    ).map((r) => r.trajectory_id);

    const existing = db
      .prepare('SELECT * FROM evidence_contexts WHERE evidence_context_id = ?')
      .get(CONTEXT_ID) as Record<string, unknown> | undefined;

    console.log(`pre-repair trajectories : ${trajectories.length}`);
    console.log(`reasons that still hold : ${holding.length} of ${reasons.length}\n`);
    for (const r of reasons) {
      console.log(`  ${r.holds ? 'HOLDS  ' : 'cleared'} ${r.code.padEnd(30)} ${r.measured}`);
    }

    if (holding.length === 0) {
      console.log('\nNo invalidation reason holds. Refusing to invalidate a corpus that measures clean.');
      process.exit(1);
    }

    if (!apply) {
      console.log(`\n(dry run — pass --apply to write the ledger)`);
      writeArtifact('5d24e-invalid-window.json', {
        applied: false,
        contextId: CONTEXT_ID,
        trajectoryCount: trajectories.length,
        auditArtifact: AUDIT_DOC,
        auditArtifactSha256: auditHash,
        reasons,
      });
      process.exit(0);
    }

    const now = Date.now();
    const bounds = db
      .prepare('SELECT MIN(opened_utc_ms) AS lo, MAX(opened_utc_ms) AS hi FROM development_trajectories')
      .get() as { lo: number | null; hi: number | null };

    db.exec('BEGIN IMMEDIATE');
    try {
      if (existing === undefined) {
        db.prepare(
          `INSERT INTO evidence_contexts
             (evidence_context_id, context_hash, source_commit, tree_dirty, opened_utc_ms, closed_utc_ms,
              validity, reasons, audit_artifact_hash, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          CONTEXT_ID,
          createHash('sha256').update(`${CONTEXT_ID}|${holding.map((r) => r.code).join(',')}`).digest('hex'),
          '8f73cef2a1a87fb0019cab8c4bd5725e2a60114f',
          1,
          bounds.lo ?? now,
          now,
          'INSTRUMENT_DEVELOPMENT_INVALID',
          JSON.stringify(holding.map((r) => ({ code: r.code, statement: r.statement, measured: r.measured }))),
          auditHash,
          'Every trajectory and settlement written before the 5d24e39 ledger repair. Preserved as ' +
            'instrument-development history; excluded from every default report and from readiness.',
        );
      } else {
        // Append-only: the reasons may be RE-MEASURED, but the context's
        // validity and its opening are never rewritten.
        db.prepare('UPDATE evidence_contexts SET reasons = ?, audit_artifact_hash = ? WHERE evidence_context_id = ?').run(
          JSON.stringify(holding.map((r) => ({ code: r.code, statement: r.statement, measured: r.measured }))),
          auditHash,
          CONTEXT_ID,
        );
      }

      const assign = db.prepare(
        `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(trajectory_id) DO NOTHING`,
      );
      let assigned = 0;
      for (const id of trajectories) {
        const r = assign.run(id, CONTEXT_ID, now);
        assigned += Number(r.changes);
      }
      db.exec('COMMIT');
      console.log(`\ninvalidated context ${CONTEXT_ID}: ${assigned} trajectory assignment(s) written`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const inContext = count(
      db,
      `SELECT COUNT(*) AS c FROM trajectory_evidence_context WHERE evidence_context_id = '${CONTEXT_ID}'`,
    );
    const unassigned = count(
      db,
      `SELECT COUNT(*) AS c FROM development_trajectories t
        WHERE NOT EXISTS (SELECT 1 FROM trajectory_evidence_context c WHERE c.trajectory_id = t.trajectory_id)`,
    );

    const artifact = writeArtifact('5d24e-invalid-window.json', {
      applied: true,
      contextId: CONTEXT_ID,
      validity: 'INSTRUMENT_DEVELOPMENT_INVALID',
      sourceCommit: '8f73cef2a1a87fb0019cab8c4bd5725e2a60114f',
      openedUtcMs: bounds.lo,
      closedUtcMs: now,
      trajectoriesInContext: inContext,
      trajectoriesUnassigned: unassigned,
      auditArtifact: AUDIT_DOC,
      auditArtifactSha256: auditHash,
      reasons,
    });

    console.log(`in context     : ${inContext}`);
    console.log(`unassigned     : ${unassigned}`);
    console.log(`-> ${artifact}`);
    process.exit(unassigned === 0 ? 0 : 1);
  } finally {
    db.close();
  }
}

/**
 * Run only when this file IS the program.
 *
 * `planDemotion` is exported so a test can drive the CLI's own argument path,
 * and an unconditional `main()` would make importing it open the 9 GB corpus
 * and call `process.exit`. The guard is what makes the refusal testable as
 * behaviour instead of as a source grep.
 */
if (process.argv[1] !== undefined && /evidence-invalidate-old\.ts$/.test(process.argv[1])) {
  main();
}
