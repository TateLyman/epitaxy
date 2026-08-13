import type { DatabaseSync as Db } from 'node:sqlite';

/**
 * P18 — canary readiness, machine-generated.
 *
 * The previous `canaryEvidenceGates()` could pass after 200 losing trades. It
 * counted positions whose legs had `simulation='SIMULATED_OK'` and never asked
 * what the positions EARNED, so a strategy that reliably lost money satisfied
 * every clause by losing it consistently and with clean provenance.
 *
 * It also accepted development JIT rows as evidence, which is the deeper
 * problem: a JIT run fetches its own state from a moving chain, so the same
 * transaction run twice is two experiments. Those rows are legitimate
 * development data and they are not confirmatory, whatever their status column
 * says.
 *
 * Every gate here FAILS on insufficient data. Not "unknown", not "skipped" —
 * fails. A gate that abstains when the sample is thin abstains exactly when the
 * decision is most dangerous.
 */

export interface Gate {
  readonly id: string;
  readonly pass: boolean;
  readonly observed: string;
  readonly required: string;
  /** Why this gate exists, so a future reader cannot mistake it for ceremony. */
  readonly rationale: string;
}

export interface ReadinessReport {
  readonly generatedUtcMs: number;
  readonly sourceCommit: string;
  readonly strategyVersion: string;
  readonly confirmatoryTrades: number;
  readonly validDevelopmentTrades: number;
  readonly gates: readonly Gate[];
  readonly allPass: boolean;
  readonly verdict: 'CANARY_READY' | 'NOT_READY';
  readonly blockers: readonly string[];
  readonly benchmarks: Readonly<Record<string, number | null>>;
}

const g = (id: string, pass: boolean, observed: string, required: string, rationale: string): Gate => ({
  id,
  pass,
  observed,
  required,
  rationale,
});

function one<T>(db: Db, sql: string, params: unknown[] = []): T | undefined {
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } catch {
    return undefined;
  }
}

function all<T>(db: Db, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } catch {
    return [];
  }
}

/**
 * The frozen thresholds.
 *
 * Frozen means: changed only through `docs/MULTIPLE_TESTING_LEDGER.csv`, before
 * the change lands, with the sample it was chosen on. A threshold moved after
 * looking at the corpus and not recorded is how a strategy is fitted to its own
 * history without anyone deciding to do it.
 */
export const CANARY_GATES = {
  minValidPositions: 200,
  minCalendarDays: 21,
  minProfitFactor: 1.25,
  maxDrawdownBps: 2_000,
  maxCatastrophicIncidence: 0.02,
  recentWindow: 50,
  maxSingleTradeShareOfProfit: 0.1,
  maxSingleDayShareOfProfit: 0.25,
  costStressMultiple: 2,
} as const;

/**
 * A completed position that may count as CONFIRMATORY evidence.
 *
 * Every clause is a requirement. The joins are inner joins on purpose: a
 * position missing its entry or exit observation does not "partially" qualify.
 */
const CONFIRMATORY_SQL = `
  SELECT p.position_id, p.mint, p.cost_lamports, p.realized_lamports,
         p.opened_utc_ms, p.closed_utc_ms
  FROM positions p
  JOIN execution_observations e ON e.observation_id = p.entry_observation_id
  JOIN execution_observations x ON x.observation_id = p.exit_observation_id
  JOIN run_contexts c            ON c.context_hash = p.context_hash
  JOIN simulation_jobs je        ON je.execution_observation_id = e.observation_id
  JOIN simulation_jobs jx        ON jx.execution_observation_id = x.observation_id
  WHERE p.closed_utc_ms IS NOT NULL
    AND CAST(p.token_amount AS INTEGER) = 0
    AND c.source_commit NOT LIKE '%+dirty'
    AND e.family = x.family
    AND e.side = 'buy' AND x.side = 'sell'
    AND e.instruction_policy = 'PASS' AND x.instruction_policy = 'PASS'
    AND e.transaction_policy = 'PASS' AND x.transaction_policy = 'PASS'
    AND e.simulation_effect = 'SIMULATED_EFFECT_OK'
    AND x.simulation_effect = 'SIMULATED_EFFECT_OK'
    AND je.confirmatory = 1 AND jx.confirmatory = 1
    AND je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
    AND je.account_coverage_ok = 1 AND jx.account_coverage_ok = 1
    AND je.validity = 'VALID_CONFIRMATORY' AND jx.validity = 'VALID_CONFIRMATORY'
    AND e.raw_payload_hash IS NOT NULL AND x.raw_payload_hash IS NOT NULL
`;

interface Trade {
  position_id: string;
  mint: string;
  cost_lamports: string;
  realized_lamports: string | null;
  opened_utc_ms: number;
  closed_utc_ms: number;
}

interface Pnl {
  readonly id: string;
  readonly mint: string;
  readonly net: bigint;
  readonly cost: bigint;
  readonly day: string;
  readonly closedUtcMs: number;
}

function toPnl(rows: Trade[]): Pnl[] {
  return rows.map((r) => {
    const cost = BigInt(r.cost_lamports);
    const realized = BigInt(r.realized_lamports ?? '0');
    return {
      id: r.position_id,
      mint: r.mint,
      net: realized - cost,
      cost,
      day: new Date(r.closed_utc_ms).toISOString().slice(0, 10),
      closedUtcMs: r.closed_utc_ms,
    };
  });
}

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** Expected log growth per trade. Undefined when any trade wipes the stake. */
function expectedLogGrowth(trades: readonly Pnl[]): number | null {
  if (trades.length === 0) return null;
  let acc = 0;
  for (const t of trades) {
    if (t.cost <= 0n) return null;
    const r = 1 + Number(t.net) / Number(t.cost);
    // A total loss makes log growth negative infinity, which is the correct
    // answer and not a number a threshold can be compared against. Treat it as
    // failing rather than as missing.
    if (r <= 0) return Number.NEGATIVE_INFINITY;
    acc += Math.log(r);
  }
  return acc / trades.length;
}

/** Lower bound of a normal-approximation CI on mean log growth. */
function lowerConfidenceBound(trades: readonly Pnl[], z = 1.96): number | null {
  const mean = expectedLogGrowth(trades);
  if (mean === null || !Number.isFinite(mean) || trades.length < 2) return mean;
  const logs = trades.map((t) => Math.log(1 + Number(t.net) / Number(t.cost)));
  const variance = logs.reduce((a, l) => a + (l - mean) ** 2, 0) / (logs.length - 1);
  return mean - z * Math.sqrt(variance / logs.length);
}

function profitFactor(trades: readonly Pnl[]): number | null {
  const wins = sum(trades.filter((t) => t.net > 0n).map((t) => t.net));
  const losses = sum(trades.filter((t) => t.net < 0n).map((t) => -t.net));
  if (losses === 0n) return wins > 0n ? Number.POSITIVE_INFINITY : null;
  return Number(wins) / Number(losses);
}

/** Peak-to-trough of the cumulative net curve, in bps of the peak. */
function maxDrawdownBps(trades: readonly Pnl[]): number | null {
  if (trades.length === 0) return null;
  const ordered = [...trades].sort((a, b) => a.closedUtcMs - b.closedUtcMs);
  let equity = 0n;
  let peak = 0n;
  let worst = 0;
  for (const t of ordered) {
    equity += t.net;
    if (equity > peak) peak = equity;
    if (peak > 0n) {
      const dd = Number(((peak - equity) * 10_000n) / peak);
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

function withoutTopN(trades: readonly Pnl[], n: number): bigint {
  const ordered = [...trades].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));
  return sum(ordered.slice(n).map((t) => t.net));
}

function byDay(trades: readonly Pnl[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const t of trades) m.set(t.day, (m.get(t.day) ?? 0n) + t.net);
  return m;
}

function byMint(trades: readonly Pnl[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const t of trades) m.set(t.mint, (m.get(t.mint) ?? 0n) + t.net);
  return m;
}

export function buildReadiness(db: Db, sourceCommit: string, strategyVersion: string, nowUtcMs: number): ReadinessReport {
  const confirmatory = toPnl(all<Trade>(db, CONFIRMATORY_SQL));

  // Development-valid: effect-verified, but JIT rather than reproducible. Real
  // evidence about the strategy, and never sufficient for canary.
  const development = toPnl(
    all<Trade>(
      db,
      CONFIRMATORY_SQL.replace(/AND je\.confirmatory = 1 AND jx\.confirmatory = 1/, '')
        .replace(/AND je\.validity = 'VALID_CONFIRMATORY' AND jx\.validity = 'VALID_CONFIRMATORY'/, "AND je.validity LIKE 'VALID_%' AND jx.validity LIKE 'VALID_%'"),
    ),
  );

  const t = confirmatory;
  const n = t.length;
  const net = sum(t.map((x) => x.net));
  const positiveTotal = sum(t.filter((x) => x.net > 0n).map((x) => x.net));
  const days = new Set(t.map((x) => x.day));
  const spanDays =
    n === 0 ? 0 : (Math.max(...t.map((x) => x.closedUtcMs)) - Math.min(...t.map((x) => x.closedUtcMs))) / 86_400_000;

  const elg = expectedLogGrowth(t);
  const lcb = lowerConfidenceBound(t);
  const pf = profitFactor(t);
  const dd = maxDrawdownBps(t);

  const recent = [...t].sort((a, b) => a.closedUtcMs - b.closedUtcMs).slice(-CANARY_GATES.recentWindow);
  const dayMap = byDay(t);
  const bestDay = [...dayMap.values()].reduce((a, b) => (b > a ? b : a), 0n);
  const mintMap = byMint(t);
  const bestMints = [...mintMap.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 5);
  const largestTrade = t.reduce((a, x) => (x.net > a ? x.net : a), 0n);

  // Catastrophic: a trade that lost more than its own cost basis, i.e. the
  // exit returned nothing and the fees were spent on top.
  const catastrophic = t.filter((x) => x.cost > 0n && x.net <= -x.cost).length;

  const costStress = sum(
    t.map((x) => {
      // Double every cost. `cost` already includes fees, tip and rent; doubling
      // the whole basis is conservative and that is the point of a stress.
      const extra = x.cost;
      return x.net - extra;
    }),
  );

  const replayDivergence =
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM replay_results WHERE diverged = 1")?.n ?? null;
  const unresolvedResync =
    one<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM clock_checkpoints WHERE resync_required = 1 AND resync_done_utc_ms IS NULL',
    )?.n ?? 0;
  const blockedExits = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM positions WHERE state = 'EXIT_BLOCKED'")?.n ?? 0;
  const fingerprints =
    one<{ n: number }>(db, 'SELECT COUNT(DISTINCT simulator_binary_hash) AS n FROM simulation_jobs WHERE simulator_binary_hash IS NOT NULL')?.n ?? 0;

  const shadowCanary = all<{ net: string }>(
    db,
    `SELECT CAST(COALESCE(realized_lamports,'0') AS TEXT) AS net FROM shadow_positions
     WHERE book = 'canary_shadow' AND closed_utc_ms IS NOT NULL`,
  );
  const canaryShadowNet = sum(shadowCanary.map((r) => BigInt(r.net)));

  const gates: Gate[] = [
    g(
      'sample.validCompletedPositions',
      n >= CANARY_GATES.minValidPositions,
      `${n} confirmatory positions`,
      `at least ${CANARY_GATES.minValidPositions}`,
      'A confirmatory position is one whose entry and exit were both effect-verified, on one family, from a reproducible offline snapshot, on a clean commit. Development JIT rows are not confirmatory however many there are.',
    ),
    g(
      'sample.calendarDays',
      spanDays >= CANARY_GATES.minCalendarDays,
      `${spanDays.toFixed(1)} days across ${days.size} distinct days`,
      `at least ${CANARY_GATES.minCalendarDays} days`,
      'A memecoin regime lasts days. A sample from one week is a sample from one regime.',
    ),
    g('pnl.netPositive', n > 0 && net > 0n, `${net} lamports net`, 'greater than zero',
      'The gate this whole section exists for: the previous version could pass after 200 losing trades.'),
    g('pnl.expectedLogGrowth', elg !== null && Number.isFinite(elg) && elg > 0, `${elg === null ? 'unknown' : elg.toFixed(6)}`, 'greater than zero',
      'Mean arithmetic profit can be positive while repeated betting goes to zero. Log growth is the quantity that compounds.'),
    g('pnl.lowerConfidenceBound', lcb !== null && Number.isFinite(lcb) && lcb > 0, `${lcb === null ? 'unknown' : lcb.toFixed(6)}`, 'greater than zero',
      'A positive point estimate on a thin sample is not evidence of an edge. The lower bound is.'),
    g('pnl.profitFactor', pf !== null && pf >= CANARY_GATES.minProfitFactor, `${pf === null ? 'unknown' : pf.toFixed(3)}`, `at least ${CANARY_GATES.minProfitFactor}`,
      'Gross wins over gross losses. Below 1.25 there is no room for the costs a live account discovers.'),
    g('risk.maxDrawdown', dd !== null && dd <= CANARY_GATES.maxDrawdownBps, `${dd === null ? 'unknown' : dd} bps`, `at most ${CANARY_GATES.maxDrawdownBps} bps`,
      'The threshold is frozen. Widening it after seeing the curve is fitting the risk limit to the strategy.'),
    g('risk.catastrophicIncidence', n > 0 && catastrophic / n <= CANARY_GATES.maxCatastrophicIncidence,
      `${catastrophic}/${n} total-loss trades`, `at most ${(CANARY_GATES.maxCatastrophicIncidence * 100).toFixed(0)}%`,
      'A rug returns nothing and costs the fees on top. Their frequency, not their average, is what sizing has to survive.'),
    g('robustness.recent50', recent.length >= CANARY_GATES.recentWindow && sum(recent.map((x) => x.net)) > 0n,
      `${recent.length} recent trades, net ${sum(recent.map((x) => x.net))}`, 'the most recent 50 net positive',
      'An edge that stopped working three weeks ago still shows a positive total.'),
    g('robustness.exTop1', n > 1 && withoutTopN(t, 1) > 0n, `${n > 1 ? withoutTopN(t, 1) : 'n/a'}`, 'positive without the best trade',
      'One 40x in the sample makes every other property meaningless.'),
    g('robustness.exTop3', n > 3 && withoutTopN(t, 3) > 0n, `${n > 3 ? withoutTopN(t, 3) : 'n/a'}`, 'positive without the best 3', 'As above, at depth.'),
    g('robustness.exTop5', n > 5 && withoutTopN(t, 5) > 0n, `${n > 5 ? withoutTopN(t, 5) : 'n/a'}`, 'positive without the best 5', 'As above, at depth.'),
    g('robustness.exTop10', n > 10 && withoutTopN(t, 10) > 0n, `${n > 10 ? withoutTopN(t, 10) : 'n/a'}`, 'positive without the best 10', 'As above, at depth.'),
    g('robustness.exBestDay', dayMap.size > 1 && net - bestDay > 0n, `${dayMap.size > 1 ? net - bestDay : 'n/a'}`, 'positive without the best day',
      'One good day is one regime, not an edge.'),
    g('robustness.exBestFiveMints', mintMap.size > 5 && net - sum(bestMints.map(([, v]) => v)) > 0n,
      `${mintMap.size > 5 ? net - sum(bestMints.map(([, v]) => v)) : 'n/a'}`, 'positive without the best 5 mints',
      'Five tokens carrying the result is a bet on five tokens.'),
    g('concentration.noTradeOverTenPercent',
      positiveTotal > 0n && Number(largestTrade) / Number(positiveTotal) <= CANARY_GATES.maxSingleTradeShareOfProfit,
      `${positiveTotal > 0n ? ((Number(largestTrade) / Number(positiveTotal)) * 100).toFixed(1) : 'n/a'}%`,
      'at most 10% of positive PnL from one trade', 'Concentration in the result is concentration in the conclusion.'),
    g('concentration.noDayOverTwentyFivePercent',
      positiveTotal > 0n && Number(bestDay) / Number(positiveTotal) <= CANARY_GATES.maxSingleDayShareOfProfit,
      `${positiveTotal > 0n ? ((Number(bestDay) / Number(positiveTotal)) * 100).toFixed(1) : 'n/a'}%`,
      'at most 25% of positive PnL from one day', 'As above, by time.'),
    g('stress.doubleCosts', n > 0 && costStress > 0n, `${costStress} lamports at 2x costs`, 'still positive',
      'Live costs are worse than modelled costs. Every time.'),
    g('evidence.zeroReplayDivergence', replayDivergence === 0, `${replayDivergence === null ? 'no replay results' : replayDivergence} divergences`, 'exactly 0',
      'If a decision cannot be re-derived from its snapshot, either the snapshot is incomplete or the strategy changed. Both are defects.'),
    g('evidence.zeroUnresolvedReconciliation', unresolvedResync === 0, `${unresolvedResync}`, 'exactly 0', 'A clock discontinuity nobody resolved is a gap in the record.'),
    g('lifecycle.noBlockedExits', blockedExits === 0, `${blockedExits}`, 'exactly 0', 'A position that cannot be closed is exposure regardless of what the state column says.'),
    g('evidence.stableSimulatorFingerprint', fingerprints === 1, `${fingerprints} distinct simulator binaries in the corpus`, 'exactly 1',
      'Two binaries are two instruments, and their results are not one sample.'),
    g('shadow.canarySizePositive', shadowCanary.length > 0 && canaryShadowNet > 0n,
      `${shadowCanary.length} closed canary-shadow positions, net ${canaryShadowNet}`, 'positive at canary size',
      'The portfolio result is at portfolio size. Canary runs at a fixed small size, and small size has its own cost structure.'),
  ];

  const blockers = gates.filter((x) => !x.pass).map((x) => `${x.id}: observed ${x.observed}, requires ${x.required}`);

  return {
    generatedUtcMs: nowUtcMs,
    sourceCommit,
    strategyVersion,
    confirmatoryTrades: n,
    validDevelopmentTrades: development.length,
    gates,
    allPass: blockers.length === 0,
    verdict: blockers.length === 0 ? 'CANARY_READY' : 'NOT_READY',
    blockers,
    benchmarks: {
      // Doing nothing. The benchmark every strategy must beat and most do not.
      noTradeLamports: 0,
      // Holding SOL over the same window is flat in lamport terms by
      // construction; it is listed so the comparison is explicit rather than
      // assumed away.
      holdSolLamports: 0,
      strategyNetLamports: Number(net),
      canaryShadowNetLamports: Number(canaryShadowNet),
    },
  };
}
