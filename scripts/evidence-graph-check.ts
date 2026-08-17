/**
 * `pnpm evidence:graph-check` — does every arrow resolve?
 *
 * The 8f73cef audit's C-1/C-2 measured this by hand and found 5 of 15 links in
 * one trace dangling, and **0 of 292** entry observation ids and worker job ids
 * resolving across the whole corpus. They could not resolve: the namespaces
 * were disjoint by construction.
 *
 * This command asks the question continuously, over the ACTIVE evidence context
 * only. The pre-repair context is `INSTRUMENT_DEVELOPMENT_INVALID` and its rows
 * are not expected to resolve — they are preserved history, and counting them
 * as failures every run would train an operator to ignore the output.
 *
 * `--strict` treats an active context with zero trajectories as a failure,
 * which is what the acceptance gate wants: an empty graph resolves trivially.
 */
import { openDb } from '../packages/storage/src/db.js';
import { writeArtifact } from './_artifact.js';

interface Check {
  readonly name: string;
  readonly statement: string;
  readonly failures: number;
  readonly detail: string;
}

function count(db: ReturnType<typeof openDb>, sql: string, ...params: unknown[]): number {
  try {
    return Number((db.prepare(sql).get(...(params as never[])) as { c: number | bigint }).c);
  } catch (e) {
    void e;
    return -1;
  }
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const ctxArg = process.argv.find((a) => a.startsWith('--context='));
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });

  try {
    const activeContexts = (
      db
        .prepare(`SELECT evidence_context_id FROM evidence_contexts WHERE validity = 'DEVELOPMENT_EVIDENCE'`)
        .all() as { evidence_context_id: string }[]
    ).map((r) => r.evidence_context_id);

    const contexts = ctxArg === undefined ? activeContexts : [ctxArg.slice(10)];
    const placeholders = contexts.map(() => '?').join(',');
    const inActive =
      contexts.length === 0
        ? 'AND 0'
        : `AND EXISTS (SELECT 1 FROM trajectory_evidence_context c
                        WHERE c.trajectory_id = t.trajectory_id AND c.evidence_context_id IN (${placeholders}))`;

    const total = count(
      db,
      `SELECT COUNT(*) AS c FROM development_trajectories t WHERE 1 ${inActive}`,
      ...contexts,
    );

    const checks: Check[] = [
      {
        name: 'LINK_ROW_EXISTS',
        statement: 'every active trajectory carries an evidence-link row',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM development_trajectories t
            WHERE NOT EXISTS (SELECT 1 FROM trajectory_evidence_links l WHERE l.trajectory_id = t.trajectory_id)
              ${inActive}`,
          ...contexts,
        ),
        detail: 'a trajectory with no link row has no checkable evidence graph at all',
      },
      {
        name: 'ENTRY_OBSERVATION_RESOLVES',
        statement: 'entry_observation_id joins execution_observations',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM trajectory_evidence_links l
             JOIN development_trajectories t ON t.trajectory_id = l.trajectory_id
            WHERE NOT EXISTS (SELECT 1 FROM execution_observations o WHERE o.observation_id = l.entry_observation_id)
              ${inActive}`,
          ...contexts,
        ),
        detail: '0 of 292 pre-repair values resolved, and none could: the namespaces were disjoint',
      },
      {
        name: 'ENTRY_STEP_RESOLVES',
        statement: 'entry (job_id, step_index) joins simulation_steps',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM trajectory_evidence_links l
             JOIN development_trajectories t ON t.trajectory_id = l.trajectory_id
            WHERE NOT EXISTS (SELECT 1 FROM simulation_steps s
                               WHERE s.job_id = l.entry_job_id AND s.step_index = l.entry_step_index)
              ${inActive}`,
          ...contexts,
        ),
        detail: 'the worker job that produced the leg must be reachable from the leg',
      },
      {
        name: 'ENTRY_SETTLEMENT_RESOLVES',
        statement: 'entry_settlement_id joins leg_settlements',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM trajectory_evidence_links l
             JOIN development_trajectories t ON t.trajectory_id = l.trajectory_id
            WHERE NOT EXISTS (SELECT 1 FROM leg_settlements s WHERE s.settlement_id = l.entry_settlement_id)
              ${inActive}`,
          ...contexts,
        ),
        detail: '',
      },
      {
        name: 'EXIT_LINKS_COMPLETE_OR_OPEN',
        statement: 'a null exit link occurs only while the trajectory is open',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM trajectory_evidence_links l
             JOIN development_trajectories t ON t.trajectory_id = l.trajectory_id
            WHERE t.state = 'SETTLED' AND l.exit_settlement_id IS NULL ${inActive}`,
          ...contexts,
        ),
        detail: 'a settled trajectory whose exit does not resolve has half an economic identity',
      },
      {
        name: 'SNAPSHOT_HASH_IS_A_HASH',
        statement: 'snapshot_hash is a sha256 digest, not a slot number',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM development_trajectories t
            WHERE (length(t.snapshot_hash) <> 64 OR t.snapshot_hash GLOB '*[^0-9a-f]*') ${inActive}`,
          ...contexts,
        ),
        detail: '292 of 292 pre-repair values were the decimal slot number',
      },
      {
        name: 'FINGERPRINT_DISTINCT_FROM_SNAPSHOT',
        statement: 'capability_fingerprint is not the snapshot hash',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM development_trajectories t
            WHERE t.capability_fingerprint = t.snapshot_hash ${inActive}`,
          ...contexts,
        ),
        detail: 'they answer different questions; 292 of 292 pre-repair rows had them identical',
      },
      {
        name: 'RAW_STATE_PERSISTED',
        statement: 'every linked job carries account manifests',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM trajectory_evidence_links l
             JOIN development_trajectories t ON t.trajectory_id = l.trajectory_id
            WHERE NOT EXISTS (SELECT 1 FROM account_state_manifests m WHERE m.job_id = l.entry_job_id)
              ${inActive}`,
          ...contexts,
        ),
        detail: 'no raw pre/post state means every amount is recorded once and unfalsifiable',
      },
      {
        name: 'NO_UNEXPLAINED_PNL',
        statement: 'no settlement publishes net PnL over a non-zero residue',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM trajectory_settlements s
             JOIN development_trajectories t ON t.trajectory_id = s.trajectory_id
            WHERE CAST(s.unexplained_lamports AS INTEGER) <> 0 AND s.net_pnl IS NOT NULL ${inActive}`,
          ...contexts,
        ),
        detail: '30 of 51 pre-repair rows with a residue published net PnL anyway',
      },
      {
        name: 'TRAJECTORY_ECONOMICS_PRESENT',
        statement: 'settled trajectories carry their economics columns',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM development_trajectories t
            WHERE t.entry_cash_out_lamports IS NULL ${inActive}`,
          ...contexts,
        ),
        detail: '0 of 292 pre-repair rows had any economics at all',
      },
      {
        name: 'ENTRY_POLICIES_DECIDED',
        statement: 'all three entry policies decided on each trajectory',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM development_trajectories t
            WHERE (SELECT COUNT(*) FROM trajectory_policy_decisions d
                    WHERE d.trajectory_id = t.trajectory_id) < 3 ${inActive}`,
          ...contexts,
        ),
        detail: 'the pre-repair corpus carried one entry policy label against three defined',
      },
      {
        name: 'CAP_NOT_BREACHED',
        statement: 'no mint exceeded its reservation cap',
        failures: count(
          db,
          `SELECT COUNT(*) AS c FROM (
             SELECT mint, COUNT(*) n, MAX(max_per_mint) cap
               FROM trajectory_reservations WHERE status = 'OPENED'
              GROUP BY mint HAVING n > cap)`,
        ),
        detail: '15 mints exceeded a hard cap of 3; the worst produced 58',
      },
      {
        name: 'NO_EVIDENCE_CONFLICTS',
        statement: 'no evidence conflict was recorded',
        failures: count(db, 'SELECT COUNT(*) AS c FROM evidence_conflicts'),
        detail: 'a recorded conflict is a second different answer that was refused; it needs resolving',
      },
    ];

    const failing = checks.filter((c) => c.failures !== 0);
    const emptyGraph = total === 0;

    console.log(`active evidence context(s): ${contexts.length === 0 ? '(none)' : contexts.join(', ')}`);
    console.log(`trajectories in scope     : ${total}\n`);
    for (const c of checks) {
      const mark = c.failures === 0 ? 'ok  ' : c.failures < 0 ? '????' : 'FAIL';
      console.log(`  ${mark}  ${c.name.padEnd(34)} ${c.failures === 0 ? '' : `${c.failures} failure(s)`}`);
      if (c.failures !== 0 && c.detail.length > 0) console.log(`        ${c.detail}`);
    }

    const artifact = writeArtifact('evidence-graph-check.json', {
      activeContexts: contexts,
      trajectoriesInScope: total,
      checks,
      failingChecks: failing.map((c) => c.name),
      emptyGraph,
      strict,
      verdict: failing.length === 0 && !(strict && emptyGraph) ? 'RESOLVES' : 'DOES_NOT_RESOLVE',
    });

    console.log(`\nverdict: ${failing.length === 0 && !(strict && emptyGraph) ? 'RESOLVES' : 'DOES NOT RESOLVE'}`);
    if (strict && emptyGraph) {
      console.log('  --strict: an empty graph resolves trivially and is not evidence that it works.');
    }
    console.log(`-> ${artifact}`);
    process.exit(failing.length === 0 && !(strict && emptyGraph) ? 0 : 1);
  } finally {
    db.close();
  }
}

main();
