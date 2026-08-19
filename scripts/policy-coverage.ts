/**
 * `pnpm policy:coverage` — what each entry policy actually KNEW.
 *
 * The question this answers did not exist before: the corpus recorded ENTER or
 * REJECT and nothing else, so a policy with no inputs and a policy that looked
 * and declined produced identical rows. Read naively, the two challengers had
 * rejected 100% of candidates, which reads as extreme caution and was an
 * instrument reporting zero because it was unplugged.
 *
 * Zero entries is NOT a performance figure and this command refuses to print
 * one. It prints NOT EVALUABLE and the histogram of which fields were missing,
 * which is the fact that tells an operator whether to fix the strategy or fix
 * the apparatus.
 */
import { openDb } from '../packages/storage/src/db.js';
import { MICROSTRUCTURE_FEATURE_VERSION } from '../packages/intelligence/src/migration-microstructure.js';
import { writeArtifact, writeNotRun, researchContext } from './_artifact.js';

interface Row {
  entry_policy: string;
  evaluability: string;
  full_coverage: number;
  unknown_fields: string;
  n: number;
}

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    const contextId = (process.argv.find((a) => a.startsWith('--context=')) ?? '').slice(10) || null;

    const sampleQuery =
      `SELECT entry_policy, evaluability, full_coverage, unknown_fields, COUNT(*) AS n
         FROM policy_field_coverage c
        ${contextId === null ? '' : 'JOIN trajectory_evidence_context x ON x.trajectory_id = c.subject_id AND x.evidence_context_id = ?'}
        GROUP BY entry_policy, evaluability, full_coverage, unknown_fields`;

    let rows: Row[] = [];
    try {
      rows = (contextId === null
        ? db.prepare(sampleQuery).all()
        : db.prepare(sampleQuery).all(contextId)) as unknown as Row[];
    } catch (e) {
      console.error(`policy_field_coverage is unreadable: ${(e as Error).message}`);
    }

    if (rows.length === 0) {
      console.log('no policy coverage rows exist yet.');
      console.log('');
      console.log('This is NOT_RUN, not "every policy has full coverage". The collector writes');
      console.log('these rows as it opens trajectories; an empty table means none have been opened');
      console.log('under a build that records coverage.');
      const p = writeNotRun('policy-coverage.json', 'no policy_field_coverage rows exist', {
        context: researchContext(db, sampleQuery, { microstructure: MICROSTRUCTURE_FEATURE_VERSION }),
      });
      console.log(`-> ${p}`);
      return;
    }

    const byPolicy = new Map<
      string,
      { eligible: number; enter: number; rejected: number; notEvaluable: number; unknown: Record<string, number> }
    >();
    for (const r of rows) {
      const cur = byPolicy.get(r.entry_policy) ?? { eligible: 0, enter: 0, rejected: 0, notEvaluable: 0, unknown: {} };
      cur.eligible += r.n;
      if (r.evaluability === 'ENTER') cur.enter += r.n;
      else if (r.evaluability === 'REJECTED_ON_SIGNAL') cur.rejected += r.n;
      else cur.notEvaluable += r.n;
      for (const f of JSON.parse(r.unknown_fields) as string[]) cur.unknown[f] = (cur.unknown[f] ?? 0) + r.n;
      byPolicy.set(r.entry_policy, cur);
    }

    console.log('policy coverage — what each policy KNEW when it decided\n');
    const summary: Record<string, unknown>[] = [];
    for (const [policy, s] of [...byPolicy.entries()].sort()) {
      const coverage = s.eligible === 0 ? 0 : (s.enter + s.rejected) / s.eligible;
      console.log(`  ${policy}`);
      console.log(`    eligible trajectories  ${s.eligible}`);
      console.log(`    decision coverage      ${(coverage * 100).toFixed(1)}%`);
      console.log(`    ENTER                  ${s.enter}`);
      console.log(`    REJECTED_ON_SIGNAL     ${s.rejected}`);
      console.log(`    NOT_EVALUABLE          ${s.notEvaluable}`);
      if (s.enter === 0) {
        console.log('    performance            NOT QUOTABLE — zero entries is not a return distribution');
      }
      const hist = Object.entries(s.unknown).sort((a, b) => b[1] - a[1]);
      if (hist.length > 0) {
        console.log('    unknown fields:');
        for (const [f, n] of hist.slice(0, 10)) console.log(`      ${String(n).padStart(5)}  ${f}`);
      }
      console.log('');
      summary.push({
        policy,
        eligible: s.eligible,
        decisionCoverage: coverage,
        enter: s.enter,
        rejectedOnSignal: s.rejected,
        notEvaluable: s.notEvaluable,
        performanceQuotable: s.enter > 0,
        unknownFieldHistogram: s.unknown,
      });
    }

    const p = writeArtifact('policy-coverage.json', {
      status: 'MEASURED',
      context: researchContext(db, sampleQuery, { microstructure: MICROSTRUCTURE_FEATURE_VERSION }),
      evidenceContextFilter: contextId,
      policies: summary,
    });
    console.log(`-> ${p}`);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('policy-coverage')) main();
