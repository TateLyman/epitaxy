import { loadSecrets, KILL_PATHS } from '../packages/domain/src/config.js';
import { haltState } from '../packages/domain/src/halt.js';
import { openDb } from '../packages/storage/src/db.js';
import type { Db } from '../packages/storage/src/db.js';

/**
 * Liveness and integrity checks against recorded state.
 *
 * Exits non-zero when something is wrong, so it can gate a deployment step or
 * drive an alert. Every check reports the observation it is based on rather
 * than a bare pass/fail, because "healthy" with no evidence is not a useful
 * claim about a system that spends money.
 */

// `info` exists so that history can be reported without being reported as a
// problem. Without it, the only way to show a past halt was to call it critical,
// which is how four permanent alarms ended up standing beside a healthy engine.
type Severity = 'ok' | 'info' | 'warn' | 'critical';

interface Check {
  readonly name: string;
  readonly severity: Severity;
  readonly detail: string;
}

const SOURCE_STALE_MS = 300_000;
const LOCK_STALE_MS = 30_000;

function all<T>(db: Db, sql: string): T[] {
  return db.prepare(sql).all() as unknown as T[];
}

function one<T>(db: Db, sql: string): T | null {
  return (db.prepare(sql).get() as T | undefined) ?? null;
}

function checkEngine(db: Db): Check[] {
  const locks = all<{ lock_name: string; pid: number; mode: string; heartbeat_utc_ms: number }>(
    db,
    'SELECT lock_name, pid, mode, heartbeat_utc_ms FROM process_locks',
  );
  if (locks.length === 0) {
    return [{ name: 'engine', severity: 'warn', detail: 'no engine holds a lock; nothing is running' }];
  }
  return locks.map((l) => {
    const age = Date.now() - l.heartbeat_utc_ms;
    if (age > LOCK_STALE_MS) {
      return {
        name: `engine.${l.lock_name}`,
        severity: 'warn' as const,
        detail: `lock held by pid ${l.pid} but heartbeat is ${age}ms old; process likely died without releasing (run: pnpm kill)`,
      };
    }
    return { name: `engine.${l.lock_name}`, severity: 'ok' as const, detail: `pid ${l.pid} alive in ${l.mode}, heartbeat ${age}ms ago` };
  });
}

function checkSources(db: Db): Check[] {
  const rows = all<{ source: string; ok: number; error_kind: string | null; utc_ms: number }>(
    db,
    `SELECT source, ok, error_kind, utc_ms FROM source_health
     WHERE utc_ms IN (SELECT MAX(utc_ms) FROM source_health GROUP BY source) ORDER BY source`,
  );
  if (rows.length === 0) {
    return [{ name: 'sources', severity: 'warn', detail: 'no source health recorded yet' }];
  }
  return rows.map((r) => {
    const age = Date.now() - r.utc_ms;
    if (r.ok === 0) {
      return { name: `source.${r.source}`, severity: 'critical' as const, detail: `last call failed: ${r.error_kind ?? 'unknown'}` };
    }
    if (age > SOURCE_STALE_MS) {
      return { name: `source.${r.source}`, severity: 'warn' as const, detail: `last success was ${Math.round(age / 1000)}s ago` };
    }
    return { name: `source.${r.source}`, severity: 'ok' as const, detail: `succeeded ${Math.round(age / 1000)}s ago` };
  });
}

/**
 * A screening pipeline that produces no rows is indistinguishable from one that
 * is silently broken, so an idle pipeline is reported rather than assumed fine.
 */
function checkPipeline(db: Db): Check[] {
  const s = one<{ n: number; last: number | null }>(
    db,
    'SELECT COUNT(*) AS n, MAX(evaluated_utc_ms) AS last FROM screenings',
  );
  if (!s || s.n === 0) {
    return [{ name: 'pipeline', severity: 'warn', detail: 'no screenings recorded' }];
  }
  const age = Date.now() - (s.last ?? 0);
  const sev: Severity = age > SOURCE_STALE_MS ? 'warn' : 'ok';
  return [{ name: 'pipeline', severity: sev, detail: `${s.n} screenings, most recent ${Math.round(age / 1000)}s ago` }];
}

/**
 * Guards the one invariant that would invalidate every performance number in
 * the database: a simulated fill must never be recorded outside a simulated
 * mode, and a real fill must never appear without a signature.
 */
function checkFillIntegrity(db: Db): Check[] {
  const bad = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM fills WHERE simulated = 0 AND (signature IS NULL OR signature = '')",
  );
  const out: Check[] = [];
  if ((bad?.n ?? 0) > 0) {
    out.push({
      name: 'fills.integrity',
      severity: 'critical',
      detail: `${bad?.n} fill(s) marked on-chain but carry no signature; provenance is unverifiable`,
    });
  } else {
    out.push({ name: 'fills.integrity', severity: 'ok', detail: 'every on-chain fill carries a signature' });
  }

  const mixed = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM positions p
     WHERE EXISTS (SELECT 1 FROM fills f WHERE f.mint = p.mint AND f.simulated != p.simulated)`,
  );
  if ((mixed?.n ?? 0) > 0) {
    out.push({
      name: 'fills.provenance',
      severity: 'critical',
      detail: `${mixed?.n} position(s) mix simulated and real fills; realized pnl would be meaningless`,
    });
  }
  return out;
}

/**
 * Halts, as a CONDITION and separately as HISTORY.
 *
 * This function used to select every critical `health_events` row from the last
 * 24 hours and report each one as a current CRITICAL. So a halt that had been
 * lifted twenty minutes ago, and a kill file that had been deleted twenty hours
 * ago, both went on shouting — four criticals against a healthy engine that was
 * screening normally.
 *
 * That is the P9 failure in its other direction. P9 is usually stated as "alive
 * is not the same as able to trade", and the engine reporting itself healthy
 * through a sixteen-hour outage is the famous half. This is the same conflation
 * running the other way: an EVENT that happened is not a CONDITION that holds,
 * and a check that cannot tell them apart produces alarms nobody can act on. An
 * operator who learns to scroll past four permanent criticals will scroll past
 * the fifth one too.
 *
 * So: the halt file is read from disk, because that is what actually decides
 * whether entries are permitted. Past events are reported as history, at info
 * severity, and never as the current state.
 */
function checkHalts(db: Db): Check[] {
  const out: Check[] = [];

  const halt = haltState(KILL_PATHS);
  out.push(
    halt === null
      ? { name: 'halt.current', severity: 'ok', detail: 'no halt file present; entries are not blocked by one' }
      : {
          name: 'halt.current',
          severity: 'critical',
          detail: `${halt.mode} via ${halt.path}${halt.defaulted ? ' (mode defaulted)' : ''}`,
        },
  );

  // An unresolved clock discontinuity blocks entries just as a halt file does,
  // and is invisible in the halt file. Same question, different mechanism.
  const resync = one<{ detail: string; wall_utc_ms: number }>(
    db,
    `SELECT detail, wall_utc_ms FROM clock_checkpoints
     WHERE resync_required = 1 AND resync_done_utc_ms IS NULL ORDER BY wall_utc_ms DESC LIMIT 1`,
  );
  if (resync !== null) {
    out.push({
      name: 'halt.clock_resync',
      severity: 'critical',
      detail: `unresolved clock discontinuity since ${new Date(resync.wall_utc_ms).toISOString()}: ${resync.detail}`,
    });
  }

  const rows = all<{ kind: string; detail: string; utc_ms: number }>(
    db,
    `SELECT kind, detail, utc_ms FROM health_events
     WHERE severity = 'critical' AND utc_ms > ${Date.now() - 86_400_000} ORDER BY utc_ms DESC LIMIT 5`,
  );
  if (rows.length === 0) {
    out.push({ name: 'halt.history', severity: 'ok', detail: 'no critical event in the last 24h' });
  } else {
    for (const r of rows) {
      out.push({
        name: `halt.history.${r.kind}`,
        severity: 'info',
        detail: `${r.detail} (${Math.round((Date.now() - r.utc_ms) / 60_000)}m ago)`,
      });
    }
  }

  return out;
}

function main(): void {
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  const checks = [
    ...checkEngine(db),
    ...checkSources(db),
    ...checkPipeline(db),
    ...checkFillIntegrity(db),
    ...checkHalts(db),
  ];

  const mark: Record<Severity, string> = { ok: 'OK  ', info: 'note', warn: 'WARN', critical: 'CRIT' };
  for (const c of checks) {
    console.log(`${mark[c.severity]} ${c.name.padEnd(34)} ${c.detail}`);
  }

  const criticals = checks.filter((c) => c.severity === 'critical').length;
  const warnings = checks.filter((c) => c.severity === 'warn').length;
  console.log(`\n${checks.length} checks, ${criticals} critical, ${warnings} warning`);

  if (criticals > 0) process.exitCode = 2;
  else if (warnings > 0) process.exitCode = 1;
}

main();
