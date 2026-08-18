/**
 * `pnpm policy:treatments-status` — do the treatments exist?
 *
 * The 8f73cef audit's N-2, and the finding it names is not subtle:
 *
 *     the corpus carries ONE distinct entry policy — HARD_GATES_RANDOM = 292 —
 *     against THREE defined in packages/strategy/src/treatments.ts.
 *     `decideEntry` has ZERO production callers.
 *     trajectory-collect.ts:896 writes the string literal 'HARD_GATES_RANDOM'
 *     on every row, AFTER admitCandidate has already made the decision.
 *
 * That is "labels attached after a common decision". The entry side of the
 * tournament did not exist: the two challengers had a sample of zero, and the
 * label described nothing that happened.
 *
 * This command asks the question that would have caught it: how many DISTINCT
 * decisions, from how many policies, over how many shared trajectories — and do
 * the policies ever DISAGREE? Three policies that always agree are one policy
 * with three names.
 */
import { openDb } from '../packages/storage/src/db.js';
import { ENTRY_POLICIES, EXIT_POLICIES } from '../packages/strategy/src/treatments.js';
import { writeArtifact } from './_artifact.js';

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });

  try {
    const one = (sql: string, ...p: unknown[]): number => {
      try {
        return Number((db.prepare(sql).get(...(p as never[])) as { c: number | bigint } | undefined)?.c ?? 0);
      } catch {
        return 0;
      }
    };

    const trajectories = one('SELECT COUNT(*) c FROM development_trajectories');
    const decisions = one('SELECT COUNT(*) c FROM trajectory_policy_decisions');
    const withAllThree = one(
      `SELECT COUNT(*) c FROM (
         SELECT trajectory_id FROM trajectory_policy_decisions
          GROUP BY trajectory_id HAVING COUNT(DISTINCT entry_policy) >= ?)`,
      ENTRY_POLICIES.length,
    );

    const byPolicy = db
      .prepare(
        `SELECT entry_policy, decision, COUNT(*) n
           FROM trajectory_policy_decisions GROUP BY entry_policy, decision ORDER BY entry_policy, decision`,
      )
      .all() as { entry_policy: string; decision: string; n: number }[];

    /**
     * THE QUESTION THAT MATTERS. Three policies that never disagree on any
     * trajectory are one policy wearing three labels, which is exactly the
     * state the label-writing build was in.
     */
    const disagreements = one(
      `SELECT COUNT(*) c FROM (
         SELECT trajectory_id FROM trajectory_policy_decisions
          GROUP BY trajectory_id HAVING COUNT(DISTINCT decision) > 1)`,
    );

    /**
     * P10.1 — did a RISK FACT change a decision? A fact that never alters an
     * outcome is not wired in. 1,959 of 1,959 pre-repair risk-fact rows were
     * `CONCENTRATION_RAW_ONLY` and `entity_concentration`'s 57 rows were joined
     * to no candidate decision at all.
     */
    const riskChanged = one(
      `SELECT COUNT(*) c FROM trajectory_policy_decisions
        WHERE decision_without_risk_facts IS NOT NULL AND decision_without_risk_facts <> decision`,
    );
    const riskApplied = one(
      `SELECT COUNT(*) c FROM trajectory_policy_decisions WHERE risk_facts_applied <> '[]'`,
    );

    // Exit side. N-3 passed in the audit and must keep passing.
    const outcomesByPolicy = db
      .prepare('SELECT exit_policy, COUNT(*) n FROM trajectory_policy_outcomes GROUP BY exit_policy')
      .all() as { exit_policy: string; n: number }[];
    const pairedPaths = one(
      `SELECT COUNT(*) c FROM (
         SELECT trajectory_id FROM trajectory_policy_outcomes
          GROUP BY trajectory_id HAVING COUNT(DISTINCT exit_policy) >= ?)`,
      EXIT_POLICIES.length,
    );
    const exitDisagreements = one(
      `SELECT COUNT(*) c FROM (
         SELECT trajectory_id FROM trajectory_policy_outcomes
          GROUP BY trajectory_id HAVING COUNT(DISTINCT triggered_offset_ms) > 1)`,
    );
    /** P9.2 — did the challenger ever exit EARLIER than the control? */
    const challengerEarlier = one(
      `SELECT COUNT(*) c FROM trajectory_policy_outcomes a
         JOIN trajectory_policy_outcomes b ON a.trajectory_id = b.trajectory_id
        WHERE a.exit_policy = 'FLOW_LIQUIDITY_DETERIORATION_V1'
          AND b.exit_policy = 'FIXED_15M_CONTROL'
          AND a.triggered_offset_ms IS NOT NULL AND b.triggered_offset_ms IS NOT NULL
          AND a.triggered_offset_ms < b.triggered_offset_ms`,
    );

    console.log('ENTRY POLICIES — decisions, not labels\n');
    console.log(`  defined                        ${ENTRY_POLICIES.length}  (${ENTRY_POLICIES.join(', ')})`);
    console.log(`  trajectories                   ${trajectories}`);
    console.log(`  decision rows                  ${decisions}`);
    console.log(`  trajectories with all ${ENTRY_POLICIES.length} policies  ${withAllThree}`);
    console.log(`  trajectories where they DISAGREE ${disagreements}`);
    console.log('');
    for (const r of byPolicy) {
      console.log(`  ${r.entry_policy.padEnd(34)} ${r.decision.padEnd(7)} ${r.n}`);
    }
    if (byPolicy.length === 0) console.log('  (no decision rows at all)');

    console.log('\nRISK FACTS — did they alter a decision?\n');
    console.log(`  decisions with a risk fact applied  ${riskApplied}`);
    console.log(`  decisions the risk fact CHANGED     ${riskChanged}`);
    if (riskApplied > 0 && riskChanged === 0) {
      console.log('  (applied but never decisive: this is possible, and it is worth watching —');
      console.log('   a fact that never changes an outcome is indistinguishable from one not wired in)');
    }

    console.log('\nEXIT POLICIES — one shared path, two decisions\n');
    for (const r of outcomesByPolicy) console.log(`  ${r.exit_policy.padEnd(34)} ${r.n}`);
    console.log(`  paired paths                        ${pairedPaths}`);
    console.log(`  paths with different trigger offsets ${exitDisagreements}`);
    console.log(`  challenger exited EARLIER            ${challengerEarlier}`);
    if (challengerEarlier === 0 && pairedPaths > 0) {
      console.log('  N-1: no path yet where the challenger exits earlier at a different mark.');
      console.log('  Until one exists, it can only differ by holding LONGER, and with heavy-tailed');
      console.log('  returns that is the half of the hypothesis least worth testing.');
    }

    const wired = decisions > 0 && withAllThree > 0;
    const artifact = writeArtifact('policy-treatment-status.json', {
      entryPoliciesDefined: [...ENTRY_POLICIES],
      trajectories,
      decisionRows: decisions,
      trajectoriesWithAllPolicies: withAllThree,
      trajectoriesWherePoliciesDisagree: disagreements,
      decisionsByPolicy: byPolicy,
      riskFactsApplied: riskApplied,
      riskFactsChangedADecision: riskChanged,
      exitPoliciesDefined: [...EXIT_POLICIES],
      outcomesByPolicy,
      pairedPaths,
      pathsWithDifferentTriggerOffsets: exitDisagreements,
      challengerExitedEarlier: challengerEarlier,
      verdict: wired ? 'TREATMENTS_WIRED' : 'TREATMENTS_ARE_LABELS',
    });

    console.log(`\nverdict: ${wired ? 'TREATMENTS WIRED' : 'TREATMENTS ARE LABELS'}`);
    console.log(`-> ${artifact}`);
    process.exit(wired ? 0 : 1);
  } finally {
    db.close();
  }
}

main();
