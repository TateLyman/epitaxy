/**
 * `pnpm reject:prospective-v4` — what the filters refused, and what it cost.
 *
 * A risk filter can look excellent by trading less. Refuse enough candidates
 * and catastrophic incidence falls, the win rate rises, and every summary
 * statistic improves — while the strategy earns less, because memecoin returns
 * are carried by a handful of enormous winners.
 *
 * Epitaxy has the counterexample in its own corpus: one ~+14m lamport path
 * carried a whole positive window. A filter that had refused that single token
 * would have "avoided losses" on twelve others and destroyed the result.
 *
 * So the statistic that decides whether a filter is useful is not its entered
 * PnL. It is the right-tail winner rate among what it REFUSED.
 */
import { openDb } from '../packages/storage/src/db.js';
import { rejectPanelReport, type RejectedCandidate, type EnteredCandidate } from '../packages/research/src/reject-panel-v4.js';
import { ENTRY_POLICIES } from '../packages/strategy/src/treatments.js';
import { MICROSTRUCTURE_FEATURE_VERSION } from '../packages/intelligence/src/migration-microstructure.js';
import { writeArtifact, writeNotRun, researchContext } from './_artifact.js';

const SAMPLE_QUERY = `
  SELECT d.entry_policy AS policy,
         d.decision     AS decision,
         d.reason       AS reason,
         t.mint         AS mint,
         o.gross_delta_lamports    AS gross_delta,
         o.entry_cash_out_lamports AS entry_cash_out,
         t.execution_cost_lamports AS execution_cost,
         COALESCE(t.inclusion_probability, 1.0) AS selection_probability
    FROM trajectory_policy_decisions d
    JOIN development_trajectories t ON t.trajectory_id = d.trajectory_id
    JOIN trajectory_evidence_context x ON x.trajectory_id = t.trajectory_id
    JOIN evidence_contexts c ON c.evidence_context_id = x.evidence_context_id
    LEFT JOIN trajectory_policy_outcomes o
      ON o.trajectory_id = d.trajectory_id AND o.exit_policy = 'FIXED_15M_CONTROL'
   WHERE c.validity = 'DEVELOPMENT_EVIDENCE'`;

interface Raw {
  policy: string;
  decision: string;
  reason: string;
  mint: string;
  gross_delta: string | null;
  entry_cash_out: string | null;
  execution_cost: string | null;
  selection_probability: number;
}

/** Frozen. A path losing more than this share of its entry is catastrophic. */
const SEVERE_LOSS_FRACTION = 0.5;

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    const ctx = researchContext(db, SAMPLE_QUERY.trim(), { microstructure: MICROSTRUCTURE_FEATURE_VERSION });
    let raw: Raw[] = [];
    try {
      raw = db.prepare(SAMPLE_QUERY).all() as unknown as Raw[];
    } catch (e) {
      console.error(`decisions unreadable: ${(e as Error).message}`);
    }

    /**
     * The shared mark path is what makes this possible at all.
     *
     * Every policy is evaluated over the SAME trajectory, so a rejected
     * candidate still has marks — the path exists whether or not a given policy
     * bought it. Without that construction there would be no way to know what a
     * filter refused, which is the state most trading research is permanently
     * in.
     */
    const logReturn = (r: Raw): number | null => {
      if (r.gross_delta === null || r.entry_cash_out === null) return null;
      const cost = BigInt(r.entry_cash_out);
      if (cost <= 0n) return null;
      const pnl = BigInt(r.gross_delta) - (r.execution_cost === null ? 0n : BigInt(r.execution_cost));
      const ratio = Number(pnl + cost) / Number(cost);
      return ratio <= 0 ? null : Math.log(ratio);
    };
    const isCatastrophic = (r: Raw): boolean | null => {
      if (r.gross_delta === null || r.entry_cash_out === null) return null;
      const cost = BigInt(r.entry_cash_out);
      const pnl = BigInt(r.gross_delta) - (r.execution_cost === null ? 0n : BigInt(r.execution_cost));
      return pnl < 0n && -pnl > (cost * BigInt(Math.round(SEVERE_LOSS_FRACTION * 100))) / 100n;
    };

    if (raw.length === 0) {
      console.log('no policy decisions in a live evidence context.');
      console.log('');
      console.log('NOT_RUN. Without decisions there are no rejects, and without rejects there is');
      console.log('no way to tell a filter that selects from a filter that simply trades less.');
      console.log(`-> ${writeNotRun('prospective-reject-v4.json', 'no policy decisions in a live evidence context', { context: ctx })}`);
      return;
    }

    const rejected: RejectedCandidate[] = raw
      .filter((r) => r.decision !== 'ENTER')
      .map((r) => ({
        mint: r.mint,
        policy: r.policy,
        rejectionReason: r.reason,
        selectionProbability: r.selection_probability > 0 ? r.selection_probability : 1,
        logReturn: logReturn(r),
        catastrophic: isCatastrophic(r),
        blockedExit: null,
      }));

    console.log('prospective reject panel v4 — what each filter refused\n');
    const reports = [];
    for (const policy of ENTRY_POLICIES) {
      const entered: EnteredCandidate[] = raw
        .filter((r) => r.policy === policy && r.decision === 'ENTER')
        .map((r) => ({ mint: r.mint, logReturn: logReturn(r) ?? 0, catastrophic: isCatastrophic(r) ?? false }))
        .filter((e) => e.logReturn !== 0);

      const rep = rejectPanelReport(policy, rejected, entered);
      reports.push(rep);
      console.log(`  ${policy}`);
      console.log(`    rejected sampled            ${rep.rejectedSampled}`);
      console.log(`    rejected WITH a mark path   ${rep.rejectedWithMarks}`);
      console.log(`    catastrophic among rejected ${rep.catastrophicRateAmongRejected === null ? 'n/a' : (rep.catastrophicRateAmongRejected * 100).toFixed(1) + '%'}`);
      console.log(`    right-tail among rejected   ${rep.rightTailRateAmongRejected === null ? 'n/a' : (rep.rightTailRateAmongRejected * 100).toFixed(1) + '%'}`);
      console.log(`    right-tail among entered    ${rep.rightTailRateAmongEntered === null ? 'n/a' : (rep.rightTailRateAmongEntered * 100).toFixed(1) + '%'}`);
      console.log(`    tail winners DISCARDED      ${rep.tailWinnersDiscarded}`);
      console.log(`    opportunity cost (mean log) ${rep.opportunityCostMeanLogReturn?.toFixed(5) ?? 'n/a'}`);
      console.log(`    verdict: ${rep.verdict}`);
      console.log('');
    }

    console.log(`-> ${writeArtifact('prospective-reject-v4.json', {
      status: 'MEASURED',
      severeLossFraction: SEVERE_LOSS_FRACTION,
      reports,
      context: ctx,
    })}`);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('reject-prospective-v4')) main();
