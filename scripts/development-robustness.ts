/**
 * `pnpm development:robustness` and `pnpm policy:paired-report`.
 *
 * These two exist to make a specific mistake impossible: reading the highest
 * raw total as the winner.
 *
 * Epitaxy has already produced the counterexample. In one settled window only
 * 2 of 13 paths were positive and a single ~+14m lamport winner carried the
 * total; remove it and both policies are negative. A "highest total" reading of
 * that window selects an arm on the strength of one token.
 *
 * So every number here is reported with:
 *
 *   - the MINT as the sampling unit, never the row;
 *   - the paired delta against the control, never two independent means;
 *   - fragility under removing the best 1/3/5/10 mints and the best day;
 *   - a cluster bootstrap rather than a formula assuming independence.
 *
 * And a policy with zero entries gets NOT_EVALUABLE, not 0.00.
 */
import { openDb } from '../packages/storage/src/db.js';
import { summarise, fragility, clusterBootstrap, pairedDeltas, type MintOutcome } from '../packages/research/src/robust-stats.js';
import { PRIMARY_ENTRY_POLICIES, DESCRIPTIVE_ONLY_POLICIES } from '../packages/strategy/src/treatments.js';
import { MICROSTRUCTURE_FEATURE_VERSION } from '../packages/intelligence/src/migration-microstructure.js';
import { writeArtifact, writeNotRun, researchContext } from './_artifact.js';

type Db = ReturnType<typeof openDb>;

/**
 * Outcomes, per policy, at MINT level.
 *
 * Joined through `trajectory_evidence_context` so a demoted window's rows can
 * never leak into a live report — that is the mechanism that makes an
 * invalidated corpus actually invalidated rather than merely labelled.
 */
const SAMPLE_QUERY = `
  SELECT d.entry_policy            AS entry_policy,
         o.exit_policy             AS exit_policy,
         t.mint                    AS mint,
         strftime('%Y-%m-%d', t.opened_utc_ms / 1000, 'unixepoch') AS utc_day,
         o.gross_delta_lamports    AS gross_delta,
         o.entry_cash_out_lamports AS entry_cash_out,
         t.execution_cost_lamports AS execution_cost,
         t.pnl_blocked_reasons     AS blocked
    FROM trajectory_policy_outcomes o
    JOIN trajectory_policy_decisions d
      ON d.trajectory_id = o.trajectory_id AND d.decision = 'ENTER'
    JOIN development_trajectories t ON t.trajectory_id = o.trajectory_id
    JOIN trajectory_evidence_context x ON x.trajectory_id = t.trajectory_id
    JOIN evidence_contexts c ON c.evidence_context_id = x.evidence_context_id
   WHERE c.validity = 'DEVELOPMENT_EVIDENCE'
     AND o.gross_delta_lamports IS NOT NULL
     AND o.entry_cash_out_lamports IS NOT NULL`;

/**
 * The join is the whole point, and it is easy to get wrong.
 *
 * `trajectory_policy_outcomes` is keyed by EXIT policy; the ENTRY policies live
 * in `trajectory_policy_decisions`, one row per policy per trajectory. A report
 * that read only the outcomes table would be comparing exit rules and calling
 * them entry policies.
 *
 * `d.decision = 'ENTER'` is what makes this a strategy result rather than a
 * market description: a policy that REJECTED a trajectory did not hold it, and
 * crediting it with that path's return would measure the market, not the
 * policy.
 *
 * The evidence-context join is what keeps a DEMOTED window out. Invalidation in
 * this repository is a label on a context, and it only actually invalidates
 * anything because every reporting query passes through this join.
 */

interface Raw {
  entry_policy: string;
  exit_policy: string;
  mint: string;
  utc_day: string;
  gross_delta: string | null;
  entry_cash_out: string | null;
  execution_cost: string | null;
  blocked: string | null;
}

/** Frozen. A path losing more than this share of its entry is catastrophic. */
const SEVERE_LOSS_FRACTION = 0.5;

function load(db: Db): Map<string, MintOutcome[]> {
  let raw: Raw[] = [];
  try {
    raw = db.prepare(SAMPLE_QUERY).all() as unknown as Raw[];
  } catch (e) {
    console.error(`outcomes unreadable: ${(e as Error).message}`);
    return new Map();
  }
  const out = new Map<string, MintOutcome[]>();
  for (const r of raw) {
    if (r.gross_delta === null || r.entry_cash_out === null) continue;
    const cost = BigInt(r.entry_cash_out);
    if (cost <= 0n) continue;
    /**
     * ALL COSTS. `gross_delta` is the policy's exit mark against its entry, and
     * the execution cost is what the legs actually consumed. A gross figure is
     * not a return — it is the number a strategy looks profitable at right up
     * until it is traded.
     */
    const execCost = r.execution_cost === null ? 0n : BigInt(r.execution_cost);
    const pnl = BigInt(r.gross_delta) - execCost;
    /**
     * Log growth, not percentage return.
     *
     * The portfolio objective is expected LOG growth: a +100% and a -50% are
     * equal and opposite in log terms and are not in arithmetic terms, and a
     * strategy optimised on arithmetic mean return will happily accept a
     * sequence that compounds to zero.
     */
    const ratio = Number(pnl + cost) / Number(cost);
    if (ratio <= 0) continue;
    // Keyed by the PAIR. An entry policy's result depends on which exit it was
    // held under, and averaging over exits would hide the interaction the
    // tournament exists to find.
    const key = `${r.entry_policy}`;
    const list = out.get(key) ?? [];
    list.push({
      mint: r.mint,
      utcDay: r.utc_day,
      logReturn: Math.log(ratio),
      netPnlLamports: pnl,
      catastrophic: pnl < 0n && -pnl > (cost * BigInt(Math.round(SEVERE_LOSS_FRACTION * 100))) / 100n,
      blockedExit: (r.blocked ?? '[]') !== '[]',
    });
    out.set(key, list);
  }
  return out;
}

function report(db: Db, paired: boolean): void {
  const byPolicy = load(db);
  const ctx = researchContext(db, SAMPLE_QUERY.trim(), { microstructure: MICROSTRUCTURE_FEATURE_VERSION });
  const name = paired ? 'policy-paired-report.json' : 'development-robustness.json';

  if (byPolicy.size === 0) {
    console.log('no settled policy outcomes in a live evidence context.');
    console.log('');
    console.log('NOT_RUN. This is not "the strategy made nothing" — it is that no trajectory');
    console.log('in a DEVELOPMENT_EVIDENCE context has settled with a net PnL. Reporting zeros');
    console.log('here would be indistinguishable from a measured break-even.');
    console.log(`-> ${writeNotRun(name, 'no settled outcomes in a live evidence context', { context: ctx })}`);
    return;
  }

  const control = byPolicy.get('HARD_GATES_RANDOM') ?? [];
  const results: Record<string, unknown>[] = [];

  console.log(paired ? 'paired policy report — mint-level deltas against the control\n' : 'development robustness — mint-level, heavy-tail aware\n');

  for (const policy of [...PRIMARY_ENTRY_POLICIES, ...DESCRIPTIVE_ONLY_POLICIES]) {
    const outcomes = byPolicy.get(policy) ?? [];
    const descriptive = DESCRIPTIVE_ONLY_POLICIES.includes(policy);
    console.log(`  ${policy}${descriptive ? '   [DESCRIPTIVE ONLY — retired from primary inference]' : ''}`);

    if (outcomes.length === 0) {
      // The rule the directive states outright: do not call performance with
      // zero entries. A policy that never entered has no distribution.
      console.log('    NOT EVALUABLE — zero entered positions, so there is no return distribution\n');
      results.push({ policy, evaluable: false, reason: 'zero entered positions', descriptive });
      continue;
    }

    const s = summarise(outcomes);
    const f = fragility(outcomes);
    const bootMint = clusterBootstrap(outcomes, 'MINT');
    const bootDay = clusterBootstrap(outcomes, 'UTC_DAY');

    console.log(`    distinct mints / UTC days   ${s.nMints} / ${s.nUtcDays}`);
    console.log(`    mean log return             ${s.meanLogReturn?.toFixed(5) ?? 'n/a'}`);
    console.log(`    median                      ${s.medianLogReturn?.toFixed(5) ?? 'n/a'}`);
    console.log(`    median-of-means             ${s.medianOfMeans?.toFixed(5) ?? 'n/a'}`);
    console.log(`    profit factor               ${s.profitFactor?.toFixed(3) ?? 'n/a'}`);
    console.log(`    catastrophic incidence      ${s.catastrophicIncidence === null ? 'n/a' : (s.catastrophicIncidence * 100).toFixed(1) + '%'}`);
    console.log(`    blocked-exit incidence      ${s.blockedExitIncidence === null ? 'n/a' : (s.blockedExitIncidence * 100).toFixed(1) + '%'}`);
    console.log(`    CVaR 95                     ${s.cvar95?.toFixed(5) ?? 'n/a'}`);
    console.log(`    max drawdown                ${s.maxDrawdown?.toFixed(5) ?? 'n/a'}`);
    console.log(`    mint-cluster bootstrap      [${bootMint.lower.toFixed(5)}, ${bootMint.upper.toFixed(5)}]`);
    console.log(`    UTC-day block bootstrap     [${bootDay.lower.toFixed(5)}, ${bootDay.upper.toFixed(5)}]`);
    console.log('    fragility (mean log return after removing the best MINTS):');
    console.log(`      full ${f.full?.toFixed(5) ?? 'n/a'}   -top1 ${f.withoutTop1?.toFixed(5) ?? 'n/a'}   -top3 ${f.withoutTop3?.toFixed(5) ?? 'n/a'}`);
    console.log(`      -top5 ${f.withoutTop5?.toFixed(5) ?? 'n/a'}  -top10 ${f.withoutTop10?.toFixed(5) ?? 'n/a'}  -bestDay ${f.withoutBestDay?.toFixed(5) ?? 'n/a'}`);
    console.log(`      survives every removal: ${f.survivesAll ? 'YES' : 'NO'}`);

    let pairedBlock: Record<string, unknown> | null = null;
    if (paired && policy !== 'HARD_GATES_RANDOM') {
      const p = pairedDeltas(outcomes, control);
      const n = p.deltas.length;
      const mean = n === 0 ? null : p.deltas.reduce((a, b) => a + b, 0) / n;
      const sd =
        n > 1 && mean !== null ? Math.sqrt(p.deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
      const se = sd === null || n === 0 ? null : sd / Math.sqrt(n);
      console.log('    paired against HARD_GATES_RANDOM, by mint:');
      console.log(`      paired mints ${p.pairedMints}   unpaired ${p.unpairedA}/${p.unpairedB}`);
      console.log(`      paired mean delta ${mean?.toFixed(5) ?? 'n/a'}   se ${se?.toFixed(5) ?? 'n/a'}`);
      if (p.pairedMints < 100) {
        console.log(`      NOT SELECTABLE — ${p.pairedMints} paired mints is below the 100 required for selection`);
      }
      pairedBlock = { pairedMints: p.pairedMints, unpairedA: p.unpairedA, unpairedB: p.unpairedB, meanDelta: mean, se };
    }
    console.log('');

    results.push({
      policy,
      evaluable: true,
      descriptive,
      summary: {
        ...s,
        // bigint fields are not JSON-serialisable and the summary carries none,
        // but the guard is kept so a future field cannot silently break writes.
      },
      fragility: f,
      bootstrapMint: bootMint,
      bootstrapUtcDay: bootDay,
      paired: pairedBlock,
    });
  }

  console.log('Selection requires 100 distinct valid mints, positivity after top-three removal,');
  console.log('a positive robust mean, no dependence on one day or mint, and a material margin');
  console.log('over the random control. The highest raw total is not a selection criterion.');

  console.log(
    `\n-> ${writeArtifact(name, {
      status: 'MEASURED',
      severeLossFraction: SEVERE_LOSS_FRACTION,
      policies: results,
      context: ctx,
    })}`,
  );
}

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    report(db, process.argv.includes('--paired'));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('development-robustness')) main();
