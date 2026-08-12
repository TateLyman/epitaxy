import { loadConfig, loadSecrets } from '../../domain/src/config.js';
import { openDb } from '../../storage/src/db.js';
import type { Db } from '../../storage/src/db.js';
import { formatAmount } from '../../domain/src/amounts.js';
import { viableFloorLamports, roundTripCostLamports } from '../../strategy/src/portfolio.js';

/**
 * The performance report.
 *
 * Rules this file exists to enforce, not merely to follow:
 *  - Simulated and on-chain results are reported in separate sections and are
 *    never added together. A paper fill is an assumption about what would have
 *    happened; a real fill is a thing that happened.
 *  - Every aggregate carries its sample size. A win rate over four trades is a
 *    sentence about four trades, not about a strategy.
 *  - Where a number is unavailable it is printed as unavailable. There is no
 *    branch in this file that substitutes a default for a missing measurement.
 */

function section(title: string): void {
  console.log(`\n${title}\n${'='.repeat(title.length)}`);
}

function one<T>(db: Db, sql: string, params: unknown[] = []): T | null {
  return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function all<T>(db: Db, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as unknown as T[];
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(2)}%`;
}

interface PositionRow {
  mint: string;
  state: string;
  cost_lamports: string;
  realized_lamports: string;
  opened_utc_ms: number;
  closed_utc_ms: number | null;
  exit_reason: string | null;
  simulated: number;
}

/**
 * Wilson score interval. Reported instead of a bare win rate because at these
 * sample sizes the interval is usually wide enough to contain both "profitable"
 * and "ruinous", and a point estimate hides that.
 */
function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

function reportPositions(rows: readonly PositionRow[], label: string): void {
  if (rows.length === 0) {
    console.log(`  no ${label} positions recorded`);
    return;
  }
  const closed = rows.filter((r) => r.closed_utc_ms !== null);
  const open = rows.length - closed.length;
  console.log(`  positions            ${rows.length} (${closed.length} closed, ${open} open)`);

  if (closed.length === 0) {
    console.log('  realized pnl         unavailable (nothing has closed yet)');
    return;
  }

  const pnls = closed.map((r) => BigInt(r.realized_lamports));
  const total = pnls.reduce((a, b) => a + b, 0n);
  const cost = closed.map((r) => BigInt(r.cost_lamports)).reduce((a, b) => a + b, 0n);
  const wins = pnls.filter((p) => p > 0n).length;
  const [lo, hi] = wilson(wins, closed.length);

  console.log(`  realized pnl         ${formatAmount(total, 9)} SOL on ${formatAmount(cost, 9)} SOL deployed`);
  console.log(`  return on cost       ${cost === 0n ? 'n/a' : `${((Number(total) / Number(cost)) * 100).toFixed(2)}%`}`);
  console.log(`  win rate             ${wins}/${closed.length} = ${pct(wins, closed.length)}`);
  console.log(`  95% CI on win rate   ${(lo * 100).toFixed(1)}% .. ${(hi * 100).toFixed(1)}%`);

  const held = closed.map((r) => (r.closed_utc_ms as number) - r.opened_utc_ms).sort((a, b) => a - b);
  const medianHold = held[Math.floor(held.length / 2)] ?? 0;
  console.log(`  median hold          ${Math.round(medianHold / 1000)}s`);

  const byReason = new Map<string, number>();
  for (const r of closed) byReason.set(r.exit_reason ?? 'unknown', (byReason.get(r.exit_reason ?? 'unknown') ?? 0) + 1);
  console.log('  exits by reason:');
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(24)} ${n}`);
  }

  if (closed.length < 30) {
    console.log(
      `\n  NOTE: ${closed.length} closed positions is far too few to estimate an edge.\n` +
        '        Nothing in this section should be treated as evidence that the\n' +
        '        strategy is or is not profitable.',
    );
  }
}

function main(): void {
  const config = loadConfig();
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  console.log(`report — strategy ${config.strategyVersion}, mode ${config.mode}, generated ${new Date().toISOString()}`);

  section('funnel');
  const f = one<{ n: number; e: number; first: number | null; last: number | null }>(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(eligible),0) AS e, MIN(evaluated_utc_ms) AS first, MAX(evaluated_utc_ms) AS last
     FROM screenings WHERE strategy_version = ?`,
    [config.strategyVersion],
  );
  const hours = f?.first && f.last ? (f.last - f.first) / 3_600_000 : 0;
  console.log(`  screenings           ${f?.n ?? 0}`);
  console.log(`  eligible             ${f?.e ?? 0} (${pct(f?.e ?? 0, f?.n ?? 0)})`);
  console.log(`  observation window   ${hours.toFixed(1)}h`);
  console.log(`  eligible per hour    ${hours > 0 ? ((f?.e ?? 0) / hours).toFixed(2) : 'n/a'}`);

  section('binding constraints');
  const vetoRows = all<{ v: string }>(
    db,
    'SELECT hard_vetoes_json AS v FROM screenings WHERE eligible = 0 AND strategy_version = ?',
    [config.strategyVersion],
  );
  const tally = new Map<string, number>();
  let soleTally = new Map<string, number>();
  for (const r of vetoRows) {
    let reasons: string[] = [];
    try {
      reasons = JSON.parse(r.v) as string[];
    } catch {
      continue;
    }
    for (const v of reasons) tally.set(v, (tally.get(v) ?? 0) + 1);
    // A gate that is the ONLY thing standing in the way is the one whose
    // calibration actually changes the funnel. A gate that always co-fires with
    // others can be loosened without admitting a single extra candidate.
    if (reasons.length === 1 && reasons[0] !== undefined) {
      soleTally.set(reasons[0], (soleTally.get(reasons[0]) ?? 0) + 1);
    }
  }
  console.log(`  ${'gate'.padEnd(30)} ${'fired'.padStart(8)} ${'share'.padStart(8)} ${'sole cause'.padStart(11)}`);
  for (const [reason, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${reason.padEnd(30)} ${String(n).padStart(8)} ${pct(n, vetoRows.length).padStart(8)} ${String(soleTally.get(reason) ?? 0).padStart(11)}`,
    );
  }
  if (tally.size === 0) console.log('  none recorded');

  section('simulated results (paper — NOT real money)');
  reportPositions(
    all<PositionRow>(db, 'SELECT * FROM positions WHERE simulated = 1 ORDER BY opened_utc_ms'),
    'simulated',
  );
  console.log('\n  paper fills assume the router\'s worst-case output was achieved and');
  console.log('  charge the modelled fee. They do not model partial fills, failed');
  console.log('  transactions, or the price moving between quote and landing.');

  section('on-chain results (real money)');
  const real = all<PositionRow>(db, 'SELECT * FROM positions WHERE simulated = 0 ORDER BY opened_utc_ms');
  reportPositions(real, 'on-chain');
  const unsigned = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM fills WHERE simulated = 0 AND (signature IS NULL OR signature = '')",
  );
  if ((unsigned?.n ?? 0) > 0) {
    console.log(`  WARNING: ${unsigned?.n} on-chain fill(s) carry no signature and cannot be verified.`);
  }

  section('cost structure');
  console.log(`  round-trip fixed cost ${formatAmount(roundTripCostLamports(config), 9)} SOL (non-recoverable)`);
  console.log(`  viability floor       ${formatAmount(viableFloorLamports(config), 9)} SOL`);
  console.log(`  max entry            ${formatAmount(config.risk.maxEntryLamports, 9)} SOL`);

  section('quote reality');
  const q = one<{ n: number; buildable: number; impact: number | null }>(
    db,
    'SELECT COUNT(*) AS n, COALESCE(SUM(transaction_buildable),0) AS buildable, AVG(price_impact_pct) AS impact FROM quotes',
  );
  console.log(`  quotes requested     ${q?.n ?? 0}`);
  console.log(`  signable returned    ${q?.buildable ?? 0}`);
  if ((q?.n ?? 0) > 0 && (q?.buildable ?? 0) === 0) {
    console.log('    expected: quote-only requests omit `taker`, so no transaction is built.');
    console.log('    This number can never be anything but 0 for a quote and is NOT the');
    console.log('    buildability measurement. See below.');
  }

  // The measurement that actually answers "could this have been traded?".
  // Reporting the quote flag alone said UNVERIFIED forever, because a
  // quote-only request cannot return a transaction by construction — it was
  // measuring the request shape, not the route.
  section('buildability (P2a.1 §P0.2)');
  const b = one<{ n: number; ok: number; failed: number; unver: number }>(
    db,
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN build_status='BUILD_SUCCEEDED' THEN 1 ELSE 0 END),0) AS ok,
            COALESCE(SUM(CASE WHEN build_status='BUILD_FAILED' THEN 1 ELSE 0 END),0) AS failed,
            COALESCE(SUM(CASE WHEN build_status='UNVERIFIABLE' THEN 1 ELSE 0 END),0) AS unver
     FROM build_attempts`,
  );
  console.log(`  build attempts       ${b?.n ?? 0}`);
  if ((b?.n ?? 0) === 0) {
    console.log('    UNMEASURED, which is not the same as failed. No /swap/v2/build call');
    console.log('    has been made against this database yet.');
  } else {
    console.log(`  built                ${b?.ok ?? 0}`);
    console.log(`  refused              ${b?.failed ?? 0}`);
    console.log(`  request failed       ${b?.unver ?? 0}`);
    const legs = one<{ buys: number; sells: number }>(
      db,
      `SELECT COALESCE(SUM(CASE WHEN side='buy'  AND build_status='BUILD_SUCCEEDED' THEN 1 ELSE 0 END),0) AS buys,
              COALESCE(SUM(CASE WHEN side='sell' AND build_status='BUILD_SUCCEEDED' THEN 1 ELSE 0 END),0) AS sells
       FROM build_attempts`,
    );
    console.log(`  by leg               ${legs?.buys ?? 0} buy, ${legs?.sells ?? 0} sell`);
    console.log('    Structural buildability only. NOT a mainnet simulation: the taker holds');
    console.log('    no funds and, for a sell, does not hold the hypothetical tokens.');
  }

  // The number P2b turns on. A trade is only PnL-eligible when BOTH legs built.
  const eligible = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM position_exits e
     WHERE e.context_hash IS NOT NULL
       AND e.diagnostic IS NOT NULL
       AND e.diagnostic NOT IN ('PROVIDER_FAILURE','SCHEMA_OR_PARSER_ERROR','STALE_EXIT_QUOTE','UNVERIFIABLE','UNBUILDABLE_EXIT')
       AND EXISTS (SELECT 1 FROM build_attempts x
                   WHERE x.position_id = e.position_id AND x.side = 'sell' AND x.build_status = 'BUILD_SUCCEEDED')`,
  );
  const closed = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM position_exits');
  console.log(`  PnL-eligible trades  ${eligible?.n ?? 0} of ${closed?.n ?? 0} closed`);
  if ((eligible?.n ?? 0) === 0 && (closed?.n ?? 0) > 0) {
    console.log(`    ${closed?.n ?? 0} historical paper trades establish executable PnL: 0.`);
    console.log('    They are development data. See docs/P2B_PREREGISTRATION.md §8.1.');
  }

  section('diagnostics (P2a.1 §P1.2)');
  const diags = all<{ d: string; n: number }>(
    db,
    "SELECT COALESCE(diagnostic,'UNCLASSIFIED') AS d, COUNT(*) AS n FROM position_marks GROUP BY 1 ORDER BY n DESC",
  );
  if (diags.length === 0) console.log('  no marks recorded');
  for (const d of diags) console.log(`  ${d.d.padEnd(28)} ${d.n}`);

  section('data regimes (P2a.1 §P2.1)');
  const regimes = all<{ id: string; sourceCommit: string; n: number }>(
    db,
    `SELECT r.data_regime_id AS id, r.source_commit AS sourceCommit, COUNT(m.mark_id) AS n
     FROM run_contexts r LEFT JOIN position_marks m ON m.context_hash = r.context_hash
     GROUP BY r.context_hash ORDER BY n DESC`,
  );
  const untagged = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM position_marks WHERE context_hash IS NULL');
  for (const r of regimes) {
    console.log(`  ${r.n.toString().padStart(6)} marks  ${r.id}  @${r.sourceCommit.slice(0, 12)}${r.sourceCommit.endsWith('+dirty') ? ' DIRTY' : ''}`);
  }
  console.log(`  ${(untagged?.n ?? 0).toString().padStart(6)} marks  UNTAGGED (pre-migration-7; permanently development data)`);
  if (regimes.length > 1) {
    console.log('  REFUSING to pool: these rows were produced by different code, config or');
    console.log('  cadence. An average across them describes no experiment that was run.');
  }

  section('multiple testing');
  const trials = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM trials');
  console.log(`  recorded trials      ${trials?.n ?? 0}`);
  console.log('  Every parameter set evaluated against this data is a trial. With enough');
  console.log('  trials some configuration will look profitable by chance alone; the');
  console.log('  ledger exists so that possibility stays visible.');

  console.log('');
}

main();
