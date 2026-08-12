import { loadSecrets } from '../packages/domain/src/config.js';
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

type Severity = 'ok' | 'warn' | 'critical';

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

function checkHalts(db: Db): Check[] {
  const rows = all<{ kind: string; detail: string; utc_ms: number }>(
    db,
    `SELECT kind, detail, utc_ms FROM health_events
     WHERE severity = 'critical' AND utc_ms > ${Date.now() - 86_400_000} ORDER BY utc_ms DESC LIMIT 5`,
  );
  if (rows.length === 0) return [{ name: 'halts', severity: 'ok', detail: 'no critical events in the last 24h' }];
  return rows.map((r) => ({
    name: `halt.${r.kind}`,
    severity: 'critical' as const,
    detail: `${r.detail} (${Math.round((Date.now() - r.utc_ms) / 60_000)}m ago)`,
  }));
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

  const mark: Record<Severity, string> = { ok: 'OK  ', warn: 'WARN', critical: 'CRIT' };
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
