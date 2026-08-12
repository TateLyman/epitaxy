import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import type { Db } from '../packages/storage/src/db.js';
import { formatAmount } from '../packages/domain/src/amounts.js';

/**
 * A read-only view of what the system has actually done.
 *
 * Opens the database read-only so running it can never disturb a live engine,
 * and reports only recorded facts. Where a number would be a projection rather
 * than an observation, it is labelled as such or omitted.
 */

function ago(ms: number | null): string {
  if (ms === null) return 'never';
  const d = Date.now() - ms;
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

function one<T>(db: Db, sql: string, params: unknown[] = []): T | null {
  return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function all<T>(db: Db, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as unknown as T[];
}

function section(title: string): void {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

function main(): void {
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  section('processes');
  const locks = all<{ lock_name: string; pid: number; mode: string; heartbeat_utc_ms: number }>(
    db,
    'SELECT lock_name, pid, mode, heartbeat_utc_ms FROM process_locks',
  );
  if (locks.length === 0) {
    console.log('  no engine running');
  } else {
    for (const l of locks) {
      const age = Date.now() - l.heartbeat_utc_ms;
      const live = age < 30_000 ? 'LIVE' : 'STALE';
      console.log(`  ${l.lock_name.padEnd(10)} ${live.padEnd(6)} pid=${l.pid} mode=${l.mode} heartbeat ${ago(l.heartbeat_utc_ms)}`);
    }
  }

  section('discovery and screening');
  const c = one<{ candidates: number }>(db, 'SELECT COUNT(*) AS candidates FROM candidates');
  const s = one<{ n: number; eligible: number; first: number | null; last: number | null }>(
    db,
    'SELECT COUNT(*) AS n, COALESCE(SUM(eligible),0) AS eligible, MIN(evaluated_utc_ms) AS first, MAX(evaluated_utc_ms) AS last FROM screenings',
  );
  console.log(`  candidates banked   ${c?.candidates ?? 0}`);
  console.log(`  screenings          ${s?.n ?? 0} (last ${ago(s?.last ?? null)})`);
  console.log(`  eligible            ${s?.eligible ?? 0}`);
  if (s && s.n > 0) {
    const rate = ((s.eligible / s.n) * 100).toFixed(3);
    console.log(`  eligibility rate    ${rate}%`);
  }

  section('screenings by strategy version');
  for (const r of all<{ v: string; n: number; e: number }>(
    db,
    'SELECT strategy_version AS v, COUNT(*) AS n, COALESCE(SUM(eligible),0) AS e FROM screenings GROUP BY 1 ORDER BY 2 DESC',
  )) {
    console.log(`  ${r.v.padEnd(26)} ${String(r.n).padStart(7)} screened  ${String(r.e).padStart(5)} eligible`);
  }

  section('hard veto frequency (all versions)');
  const vetoRows = all<{ hard_vetoes_json: string }>(db, 'SELECT hard_vetoes_json FROM screenings WHERE eligible = 0');
  const tally = new Map<string, number>();
  for (const row of vetoRows) {
    for (const v of JSON.parse(row.hard_vetoes_json) as string[]) tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  const sorted = [...tally].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) console.log('  none recorded');
  for (const [reason, n] of sorted) {
    const pct = ((n / Math.max(vetoRows.length, 1)) * 100).toFixed(1);
    console.log(`  ${reason.padEnd(28)} ${String(n).padStart(7)}  ${pct.padStart(5)}% of rejects`);
  }

  section('positions and fills');
  // These compare against the real PositionState literals. An earlier version
  // compared against 'open', which no position has ever been set to, so every
  // position counted as closed and its realized_lamports — zero while a position
  // is still open — was summed into P&L. It read correctly only while nothing
  // was open.
  const pos = one<{ open: number; closed: number; blocked: number }>(
    db,
    `SELECT SUM(CASE WHEN state IN ('POSITION_OPEN','EXIT_INTENT') THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN state = 'POSITION_CLOSED' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN state = 'EXIT_BLOCKED' THEN 1 ELSE 0 END) AS blocked
     FROM positions`,
  );
  const fills = one<{ n: number; sim: number }>(
    db,
    'SELECT COUNT(*) AS n, COALESCE(SUM(simulated),0) AS sim FROM fills',
  );
  console.log(`  open positions      ${pos?.open ?? 0}`);
  console.log(`  closed positions    ${pos?.closed ?? 0}`);
  // Capital in an exit-blocked position is neither open nor realised: we hold a
  // token we could not sell. Reporting it inside either bucket would hide it.
  if ((pos?.blocked ?? 0) > 0) {
    console.log(`  EXIT-BLOCKED        ${pos?.blocked} — capital stuck, not counted in pnl`);
  }
  // Simulated and real fills are never summed together: a paper fill is an
  // assumption about what would have happened, not a trade that happened.
  console.log(`  fills recorded      ${fills?.n ?? 0} (${fills?.sim ?? 0} simulated, ${(fills?.n ?? 0) - (fills?.sim ?? 0)} on-chain)`);

  const realized = one<{ total: string | null }>(
    db,
    `SELECT CAST(SUM(CAST(realized_lamports AS INTEGER)) AS TEXT) AS total
     FROM positions WHERE state = 'POSITION_CLOSED'`,
  );
  if (realized?.total != null) {
    console.log(`  realized pnl        ${formatAmount(BigInt(realized.total), 9)} SOL`);
  } else {
    console.log('  realized pnl        n/a (no closed positions)');
  }

  section('source health (latest per source)');
  for (const r of all<{ source: string; ok: number; error_kind: string | null; latency_ms: number | null; utc_ms: number }>(
    db,
    `SELECT source, ok, error_kind, latency_ms, utc_ms FROM source_health
     WHERE utc_ms IN (SELECT MAX(utc_ms) FROM source_health GROUP BY source)
     ORDER BY source`,
  )) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    const lat = r.latency_ms === null ? '' : `${r.latency_ms}ms`;
    console.log(`  ${mark} ${r.source.padEnd(32)} ${ago(r.utc_ms).padEnd(10)} ${lat.padEnd(8)} ${r.error_kind ?? ''}`);
  }

  section('recent health events');
  const events = all<{ kind: string; severity: string; detail: string; utc_ms: number }>(
    db,
    'SELECT kind, severity, detail, utc_ms FROM health_events ORDER BY utc_ms DESC LIMIT 10',
  );
  if (events.length === 0) console.log('  none');
  for (const e of events) {
    console.log(`  [${e.severity.toUpperCase()}] ${e.kind} — ${e.detail} (${ago(e.utc_ms)})`);
  }

  console.log('');
}

main();
