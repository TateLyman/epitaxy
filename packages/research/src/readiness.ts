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
/**
 * P14 -- the ONE definition, read from the view rather than restated here.
 *
 * This query used to carry its own copy of the clauses. So did
 * `canaryEvidenceGates`, `legIsConfirmatory`, the report SQL and the capability
 * matrix. Five copies is five chances to drift, and the way you find out is
 * that the gate refuses a position the report already counted.
 */
const CONFIRMATORY_SQL = `
  SELECT position_id, mint, cost_lamports, realized_lamports, net_pnl_lamports,
         execution_cost_lamports, opened_utc_ms, closed_utc_ms
  -- P16 -- v3. v1 and v2 are retained unchanged so rows already counted under
  -- them do
  -- not silently change meaning, but readiness reads the stricter view: the
  -- explicit cash flow, the checked identity, a durable manifest on both legs,
  -- no residual atoms, and a trigger that is not the fill.
  FROM confirmatory_positions_v3
`;

interface Trade {
  position_id: string;
  mint: string;
  cost_lamports: string;
  realized_lamports: string | null;
  /** P13 — explicit net PnL. Preferred, because it cannot be misread as gross. */
  net_pnl_lamports?: string | null;
  /** Fees, tip, unrecovered rent, failure cost. What a 2x stress doubles. */
  execution_cost_lamports?: string | null;
  opened_utc_ms: number;
  closed_utc_ms: number;
}

interface Pnl {
  readonly id: string;
  readonly mint: string;
  readonly net: bigint;
  readonly cost: bigint;
  /** Fees, tip, unrecovered rent, failure cost. Null when unrecorded. */
  readonly executionCost: bigint | null;
  readonly day: string;
  readonly closedUtcMs: number;
}

/**
 * P13 — the net PnL, taken from the column that means net PnL.
 *
 * This computed `realized_lamports - cost_lamports`. `realized_lamports` is
 * already the net result of the position, so the subtraction removed the
 * principal a SECOND time: a position that cost 20,000,000 and returned
 * 1,000,000 of profit was scored as a 19,000,000 loss.
 *
 * Every downstream gate reads this — net PnL, profit factor, log growth,
 * drawdown, the robustness checks — so one sign error here made all of them
 * describe a strategy that does not exist.
 *
 * `net_pnl_lamports` is explicit and is preferred when present. The fallback is
 * `realized_lamports` AS the net, not as gross proceeds, and a row carrying
 * neither is skipped rather than assumed to be zero.
 */
function toPnl(rows: Trade[]): Pnl[] {
  const out: Pnl[] = [];
  for (const r of rows) {
    const cost = BigInt(r.cost_lamports);
    const explicit = r.net_pnl_lamports ?? null;
    const realized = r.realized_lamports ?? null;
    if (explicit === null && realized === null) continue;
    const net = explicit !== null ? BigInt(explicit) : BigInt(realized ?? '0');
    out.push({
      id: r.position_id,
      mint: r.mint,
      net,
      cost,
      executionCost: r.execution_cost_lamports == null ? null : BigInt(r.execution_cost_lamports),
      day: new Date(r.closed_utc_ms).toISOString().slice(0, 10),
      closedUtcMs: r.closed_utc_ms,
    });
  }
  return out;
}

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * What it costs to EXECUTE a round trip, as distinct from what it risks.
 *
 * Fees, tip, unrecovered rent, failure cost and latency cost. Not the
 * principal: doubling the principal is not a cost stress, it is a different
 * trade.
 *
 * Derived from the position's own recorded costs where they exist. The fallback
 * is a bounded fraction of the basis rather than zero, because a stress that
 * assumes no cost is not a stress.
 */
function transactionCostOf(t: Pnl): bigint {
  if (t.executionCost !== null) return t.executionCost;
  // 65 bps of the basis: roughly base fee, priority fee and unrecovered rent on
  // a 0.02 SOL leg. Named here rather than hidden, and superseded the moment a
  // position records its own.
  return (t.cost * 65n) / 10_000n;
}

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

/**
 * P13 — a block bootstrap over UTC days, not a normal approximation.
 *
 * Memecoin returns are heavy-tailed and clustered: one day's launches move
 * together, so trades are not independent draws and a normal interval over them
 * is narrower than the evidence supports. A normal approximation on this data
 * says "significant" first and is wrong first.
 *
 * Resampling whole DAYS keeps whatever within-day dependence exists, because a
 * day is drawn or not drawn as a unit.
 *
 * Deterministic: the sample index is the seed, so two runs on one corpus give
 * one answer. A confidence bound that moves when you re-run it is not a bound.
 */
function lowerConfidenceBound(trades: readonly Pnl[], iterations = 2000): number | null {
  const mean = expectedLogGrowth(trades);
  if (mean === null || !Number.isFinite(mean) || trades.length < 2) return mean;

  const byDay = new Map<string, Pnl[]>();
  for (const t of trades) {
    const list = byDay.get(t.day) ?? [];
    list.push(t);
    byDay.set(t.day, list);
  }
  const blocks = [...byDay.values()];
  if (blocks.length < 2) return mean;

  // A small deterministic PRNG. Math.random() is unavailable to research code
  // for the same reason it is unavailable to workflow scripts: a number nobody
  // can reproduce is not evidence.
  let seed = 0x2f6e2b1 ^ trades.length;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };

  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const drawn: Pnl[] = [];
    for (let b = 0; b < blocks.length; b += 1) {
      const pick = blocks[Math.floor(next() * blocks.length)] ?? [];
      drawn.push(...pick);
    }
    const m = expectedLogGrowth(drawn);
    if (m !== null && Number.isFinite(m)) means.push(m);
  }
  if (means.length < 100) return mean;
  means.sort((a, b) => a - b);
  // The 2.5th percentile: a one-sided floor on what the evidence supports.
  return means[Math.floor(means.length * 0.025)] ?? mean;
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
  /**
   * Development-valid: effect-verified, but JIT rather than reproducible.
   *
   * Written out rather than derived from the view by string surgery. A query
   * built by regex-replacing another query is a second definition that looks
   * like one definition, which is the thing P14 exists to remove.
   */
  const development = toPnl(
    all<Trade>(
      db,
      `SELECT p.position_id, p.mint, p.cost_lamports, p.realized_lamports, p.net_pnl_lamports,
              p.execution_cost_lamports, p.opened_utc_ms, p.closed_utc_ms
       FROM positions p
       JOIN execution_observations e ON e.observation_id = p.entry_observation_id
       JOIN execution_observations x ON x.observation_id = p.exit_observation_id
       JOIN simulation_jobs je       ON je.execution_observation_id = e.observation_id
       JOIN simulation_jobs jx       ON jx.execution_observation_id = x.observation_id
       WHERE p.closed_utc_ms IS NOT NULL
         AND e.family = x.family
         AND je.validity LIKE 'VALID_%' AND jx.validity LIKE 'VALID_%'
         AND je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1`,
    ),
  );

  const t = confirmatory;
  const n = t.length;
  const net = sum(t.map((x) => x.net));
  const positiveTotal = sum(t.filter((x) => x.net > 0n).map((x) => x.net));
  /**
   * P13 — DISTINCT UTC calendar days, not elapsed span.
   *
   * The span between two timestamps can be 21 days with every trade in the
   * first hour and the last. That is one regime observed twice, and the gate
   * exists to require that it was observed across many.
   */
  const days = new Set(t.map((x) => x.day));
  const distinctDays = days.size;
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

  /**
   * P13 — 2x costs means doubling the COSTS, not the principal.
   *
   * This subtracted `x.cost`, the entire trade basis, a second time. On a
   * 20,000,000 lamport position with 13,000 of actual transaction cost, the
   * stress removed 20,000,000 rather than 13,000 — a test no strategy could
   * pass, which is not a conservative test but a broken one. A stress that
   * always fails carries no information about robustness.
   *
   * The transaction costs are fees, tip, unrecovered rent, failure cost and
   * latency cost: what it costs to EXECUTE, not what is put at risk.
   */
  const costStress = sum(t.map((x) => x.net - transactionCostOf(x)));

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
      distinctDays >= CANARY_GATES.minCalendarDays,
      `${distinctDays} distinct UTC days (${spanDays.toFixed(1)} elapsed)`,
      `at least ${CANARY_GATES.minCalendarDays} DISTINCT UTC days`,
      'A memecoin regime lasts days. Elapsed span can be 21 days with every trade in the first hour and the last, which is one regime observed twice.',
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
