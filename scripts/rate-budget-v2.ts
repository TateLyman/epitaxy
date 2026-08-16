import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { sessionSpans, counterTotals, latencySamples } from '../packages/storage/src/collector-telemetry.js';
import {
  buildBottleneckReport,
  infrastructurePurchaseAllowed,
  INFRASTRUCTURE_POLICY,
  type ResourceUse,
} from '../packages/research/src/bottleneck.js';

/**
 * P13/P12 — `pnpm rate:budget-v2`, per ACTIVE SECOND.
 *
 * The report this replaces divided counts by elapsed wall time, downtime
 * included. A process that ran for twenty minutes out of a day reported "48
 * requests/day against a 10,000/day quota" and concluded that quota was not the
 * constraint. That is a statement about the downtime, and it is unsupported in
 * both directions: the system might be nowhere near its limit, or it might be
 * saturating it for the twenty minutes it runs.
 *
 * Active seconds come from `collector_sessions` — the process's own record of
 * when it was up — and overlapping sessions are merged rather than summed, so a
 * duty cycle can never exceed 1.
 *
 * A LABEL IS ONE COMPLETED TRAJECTORY. Not one leg, not one mark. Counting legs
 * inflates throughput by the number of legs per trajectory and makes the sample
 * look larger than the number of independent outcomes in it.
 */

/**
 * Per-active-second limits, from the operator's actual plans.
 *
 * A resource with no stated limit cannot be the binding constraint and is
 * reported unknown rather than fine.
 */
const LIMITS_PER_ACTIVE_SECOND: Record<string, number> = {
  // Jupiter free tier: 1 request per second, shared across endpoints.
  'jupiter_order': 1,
  'jupiter_build': 1,
  // Helius free tier: 10 requests per second.
  'solana_rpc:getAccountInfo': 10,
  'solana_rpc:getMultipleAccounts': 10,
  'solana_rpc:getTransaction': 10,
  'solana_rpc:getSignaturesForAddress': 10,
};

function main(): void {
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  const spans = sessionSpans(db);
  const counters = counterTotals(db);

  const one = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...(args as never[])) as { c: number } | undefined)?.c ?? 0;

  /**
   * ONE COMPLETED TRAJECTORY, from the database.
   *
   * `SETTLED` means every horizon existed and both policies were evaluated. A
   * trajectory that opened is not a label; it is an open position in a study.
   */
  const completedTrajectories = one("SELECT COUNT(*) c FROM development_trajectories WHERE state = 'SETTLED'");
  const candidatesConsidered = one('SELECT COUNT(*) c FROM confirmed_migrations');
  const withCanonicalPool = one('SELECT COUNT(*) c FROM confirmed_migrations WHERE canonical_pool IS NOT NULL');
  const withCashback = one('SELECT COUNT(*) c FROM confirmed_migrations WHERE is_cashback_coin = 1');

  const resources: ResourceUse[] = counters.map((c) => ({
    kind: c.kind as ResourceUse['kind'],
    detail: c.detail === '' ? null : c.detail,
    count: c.count,
    errors429: c.errors_429,
    quotaErrors: c.quota_errors,
  }));

  const report = buildBottleneckReport({
    time: { activeSeconds: spans.activeSeconds, wallSeconds: spans.wallSeconds },
    resources,
    throughput: {
      completedTrajectories,
      candidatesConsidered,
      candidatesWithCanonicalPool: withCanonicalPool,
      candidatesWithCashbackPool: withCashback,
      apparatusFailures: one("SELECT COUNT(*) c FROM development_trajectories WHERE refusals LIKE '%RUNTIME_UNAVAILABLE%'"),
      duplicateObservations: 0,
      workerBusySeconds: 0,
    },
    latency: {
      queueLagMs: latencySamples(db, 'migration_notice_lag'),
      markLagMs: latencySamples(db, 'mark_lag'),
      triggerToFillMs: latencySamples(db, 'trigger_to_fill'),
    },
    limitsPerActiveSecond: LIMITS_PER_ACTIVE_SECOND,
  });

  db.close();

  /**
   * The infrastructure recommendation, from the measurement rather than from
   * frustration with throughput.
   *
   * Nothing here buys anything. The policy is encoded precisely so that the
   * decision is not a judgement call made while watching a slow queue.
   */
  const positiveUntouchedEdge = false; // No edge has been measured. Stated, not assumed.
  const jupiterBinding = report.bindingConstraint.startsWith('jupiter');
  const rpcBinding = report.bindingConstraint.startsWith('solana_rpc');
  const recommendations = [
    {
      item: 'jupiter_developer',
      ...infrastructurePurchaseAllowed({
        item: 'jupiter_developer',
        positiveUntouchedEdgeExists: positiveUntouchedEdge,
        bindingConstraintIsThisResource: jupiterBinding,
      }),
      note: INFRASTRUCTURE_POLICY.jupiterDeveloperJustifiedOnlyWhen,
    },
    {
      item: 'helius_developer',
      ...infrastructurePurchaseAllowed({
        item: 'helius_developer',
        positiveUntouchedEdgeExists: positiveUntouchedEdge,
        bindingConstraintIsThisResource: rpcBinding,
      }),
      note: INFRASTRUCTURE_POLICY.heliusDeveloperJustifiedWhen,
    },
    ...INFRASTRUCTURE_POLICY.forbiddenBeforePositiveUntouchedEdge.map((item) => ({
      item,
      ...infrastructurePurchaseAllowed({
        item,
        positiveUntouchedEdgeExists: positiveUntouchedEdge,
        bindingConstraintIsThisResource: false,
      }),
      note: 'forbidden before a positive untouched edge exists',
    })),
  ];

  console.log('rate:budget-v2 — per ACTIVE second, from collector sessions');
  console.log('');
  if (spans.sessions === 0) {
    console.log('NO COLLECTOR SESSIONS RECORDED.');
    console.log('Every rate would divide by zero. Nothing is reported as zero, because nothing was measured.');
  } else {
    console.log(`active seconds     : ${spans.activeSeconds.toFixed(0)}`);
    console.log(`wall seconds       : ${spans.wallSeconds.toFixed(0)}`);
    console.log(
      `duty cycle         : ${report.dutyCycle === null ? 'n/a' : (report.dutyCycle * 100).toFixed(1) + '%'}` +
        `  (${spans.sessions} session(s), ${spans.diedWithoutClosing} ended without closing)`,
    );
    console.log('');
    console.log('per active second:');
    for (const [k, v] of Object.entries(report.perResourcePerActiveSecond).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      const limit = LIMITS_PER_ACTIVE_SECOND[k];
      const util = limit === undefined ? '' : `  ${((v / limit) * 100).toFixed(1)}% of ${limit}/s`;
      console.log(`  ${k.padEnd(34)} ${v.toFixed(4)}/s${util}`);
    }
    console.log('');
    console.log(`completed trajectories : ${completedTrajectories} (a label is ONE trajectory, never one leg)`);
    console.log(
      `per active day         : ${report.validTrajectoriesPerDay === null ? 'n/a' : report.validTrajectoriesPerDay.toFixed(1)}`,
    );
    console.log(`per candidate          : ${report.validTrajectoriesPerCandidate?.toFixed(3) ?? 'n/a'}`);
    console.log('');
    console.log('latency P50/P95 (ms):');
    console.log(`  migration notice lag ${report.queueLagMs.p50 ?? 'n/a'} / ${report.queueLagMs.p95 ?? 'n/a'}`);
    console.log(`  mark lag             ${report.markLagMs.p50 ?? 'n/a'} / ${report.markLagMs.p95 ?? 'n/a'}`);
    console.log(`  trigger to fill      ${report.triggerToFillMs.p50 ?? 'n/a'} / ${report.triggerToFillMs.p95 ?? 'n/a'}`);
    console.log('');
    console.log(`BINDING CONSTRAINT : ${report.bindingConstraint}`);
    for (const n of report.notes) console.log(`  note: ${n}`);
    console.log('');
    console.log('infrastructure:');
    for (const r of recommendations) {
      console.log(`  ${r.allowed ? 'ALLOWED ' : 'REFUSED '} ${r.item.padEnd(28)} ${r.reason}`);
    }
  }

  let commit = 'unknown';
  let dirty = true;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* unknown provenance is reported, never omitted */
  }

  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/rate-budget-v2.json',
    JSON.stringify(
      {
        artifact: 'rate-budget-v2',
        directiveSection: 'P13',
        generatedUtcMs: Date.now(),
        sourceCommit: commit,
        dirty,
        activeTime: spans,
        limitsPerActiveSecond: LIMITS_PER_ACTIVE_SECOND,
        report,
        counters,
        infrastructure: recommendations,
        labelDefinition: 'one COMPLETED trajectory. Never one leg, never one mark.',
        notClaimed: 'this measures throughput and rate. It says nothing about whether the strategy is profitable.',
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('wrote artifacts/rate-budget-v2.json');
}

main();
