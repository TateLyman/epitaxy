import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { KILL_PATHS, loadConfig, loadSecrets } from '../packages/domain/src/config.js';
import { haltState, exitManagementActive } from '../packages/domain/src/halt.js';
import { modeFromArgv } from '../packages/domain/src/config.js';

/**
 * P2a.1 §P9 — alive is not the same as able to trade.
 *
 * The engine reported itself healthy for roughly 16 hours while 145 candidates
 * were eligible and it held no position, because the daily loss halt never
 * rolled over (O037). Every liveness check passed the entire time: the process
 * was up, the sources answered, the pipeline screened. Nothing asked the one
 * question that mattered — *can this thing actually open a trade right now?*
 *
 * These flags are reported independently and never collapsed into a single
 * word. A legitimate daily halt is not an error, but it must never be displayed
 * simply as "healthy".
 */

type Flag = 'yes' | 'no' | 'unknown';

interface Capability {
  readonly name: string;
  readonly value: Flag | string;
  readonly why: string;
  /** True when this state should reach a human, even if it is legitimate. */
  readonly notable: boolean;
}

const LOCK_STALE_MS = 30_000;
const SOURCE_STALE_MS = 300_000;
const MARK_STALE_FACTOR = 2;

const config = loadConfig(modeFromArgv());
const secrets = loadSecrets();
const db = new DatabaseSync(secrets.databasePath, { readOnly: true });
const now = Date.now();

const q = <T>(sql: string, ...a: unknown[]): T[] => db.prepare(sql).all(...(a as never[])) as T[];
const one = <T>(sql: string, ...a: unknown[]): T | null =>
  (db.prepare(sql).get(...(a as never[])) as T | undefined) ?? null;

const out: Capability[] = [];
const add = (name: string, value: Flag | string, why: string, notable = false): void => {
  out.push({ name, value, why, notable });
};

// ---- process ---------------------------------------------------------------
const lock = one<{ pid: number; mode: string; heartbeat_utc_ms: number }>(
  'SELECT pid, mode, heartbeat_utc_ms FROM process_locks WHERE lock_name = ?',
  'engine',
);
const lockAge = lock === null ? null : now - lock.heartbeat_utc_ms;
const alive = lock !== null && lockAge !== null && lockAge < LOCK_STALE_MS;
add(
  'process_alive',
  alive ? 'yes' : 'no',
  lock === null ? 'no engine holds the lock' : `pid ${lock.pid} mode=${lock.mode}, heartbeat ${lockAge}ms ago`,
  !alive,
);

// ---- data sources ----------------------------------------------------------
const sources = q<{ source: string; ok: number; observed_utc_ms: number }>(
  `SELECT source, ok, MAX(utc_ms) AS observed_utc_ms FROM source_health GROUP BY source`,
);
const stale = sources.filter((s) => now - s.observed_utc_ms > SOURCE_STALE_MS);
const failing = sources.filter((s) => s.ok === 0);
add(
  'data_sources_healthy',
  sources.length === 0 ? 'unknown' : stale.length === 0 && failing.length === 0 ? 'yes' : 'no',
  `${sources.length} source(s), ${failing.length} failing, ${stale.length} stale (>${SOURCE_STALE_MS}ms)`,
  stale.length > 0 || failing.length > 0,
);

// ---- discovery and marks ---------------------------------------------------
const lastScreen = one<{ t: number }>('SELECT MAX(evaluated_utc_ms) AS t FROM screenings');
const screenAge = lastScreen?.t == null ? null : now - lastScreen.t;
add(
  'discovery_running',
  screenAge !== null && screenAge < config.discoveryIntervalMs * 3 ? 'yes' : 'no',
  screenAge === null ? 'no screening has ever run' : `last screening ${Math.round(screenAge / 1000)}s ago`,
  screenAge === null || screenAge >= config.discoveryIntervalMs * 3,
);

const open = q<{ position_id: string; mint: string; opened_utc_ms: number }>(
  "SELECT position_id, mint, opened_utc_ms FROM positions WHERE state = 'POSITION_OPEN'",
);
const lastMark = one<{ t: number }>('SELECT MAX(observed_utc_ms) AS t FROM position_marks');
const markAge = lastMark?.t == null ? null : now - lastMark.t;
if (open.length === 0) {
  add('marks_running', 'n/a', 'no open position to mark', false);
} else {
  const fresh = markAge !== null && markAge < config.markIntervalMs * MARK_STALE_FACTOR;
  add(
    'marks_running',
    fresh ? 'yes' : 'no',
    markAge === null ? `${open.length} open position(s) and NO mark has ever been written` : `last mark ${markAge}ms ago, cadence ${config.markIntervalMs}ms`,
    !fresh,
  );
}

// ---- can it trade? ---------------------------------------------------------
const halt = haltState(KILL_PATHS);
let entryAllowed: Flag = 'yes';
let reason = 'no halt engaged';

if (halt !== null) {
  entryAllowed = 'no';
  reason = `halt file ${halt.path} (${halt.mode})`;
} else if (!alive) {
  entryAllowed = 'no';
  reason = 'engine is not running';
} else {
  // The O037 shape: entries refused by a portfolio cap while everything else
  // looks fine. Read from the refusals the engine actually recorded.
  const recent = one<{ detail: string; observed_utc_ms: number }>(
    `SELECT detail, utc_ms AS observed_utc_ms FROM health_events
     WHERE kind IN ('halt_engaged','unbuildable_entry_refused')
     ORDER BY utc_ms DESC LIMIT 1`,
  );
  if (recent !== null && now - recent.observed_utc_ms < 3_600_000) {
    reason = `most recent entry-side event: ${recent.detail.slice(0, 90)}`;
  }
}
add('entry_allowed', entryAllowed, reason, entryAllowed !== 'yes');
add(
  'risk_halt_reason',
  halt === null ? 'none' : halt.mode,
  halt === null ? 'no halt file present' : `${halt.path}${halt.defaulted ? ' (mode defaulted)' : ''}`,
  halt !== null,
);
add(
  'exit_management_active',
  halt === null ? 'yes' : exitManagementActive(halt.mode) ? 'yes' : 'no',
  halt === null ? 'normal operation' : `under ${halt.mode}`,
  halt !== null && !exitManagementActive(halt.mode),
);

// ---- open position reconciliation -----------------------------------------
if (open.length === 0) {
  add('open_position_reconciled', 'n/a', 'flat', false);
} else {
  const withoutMark = open.filter(
    (p) => one<{ n: number }>('SELECT COUNT(*) AS n FROM position_marks WHERE position_id = ?', p.position_id)!.n === 0,
  );
  add(
    'open_position_reconciled',
    withoutMark.length === 0 ? 'yes' : 'no',
    `${open.length} open, ${withoutMark.length} with no mark at all`,
    withoutMark.length > 0,
  );
}

// ---- database and clock ----------------------------------------------------
const integrity = q<{ integrity_check: string }>('PRAGMA integrity_check');
const fk = q<unknown>('PRAGMA foreign_key_check');
const dbOk = integrity[0]?.integrity_check === 'ok' && fk.length === 0;
add('database_healthy', dbOk ? 'yes' : 'no', `integrity=${integrity[0]?.integrity_check}, fk violations=${fk.length}`, !dbOk);

// Wall vs monotonic. Only a within-process comparison is available here, so
// this reports the check exists rather than claiming a verified clock.
add(
  'clock_healthy',
  'unknown',
  'no persisted monotonic/wall pair to compare — P3.1 not implemented; clock drift is UNMEASURED',
  true,
);
add(
  'resume_resync_required',
  'unknown',
  'sleep/resume detection not implemented (P3.1); a resumed process is indistinguishable from a healthy one',
  true,
);

// ---- buildability gate -----------------------------------------------------
const quotes = one<{ n: number; buildable: number }>(
  'SELECT COUNT(*) AS n, COALESCE(SUM(transaction_buildable),0) AS buildable FROM quotes',
)!;
const takerSet = secrets.paperTakerPubkey !== null;
add(
  'buildability_gate_healthy',
  config.requireBuildableFill ? (takerSet ? 'yes' : 'no') : 'no',
  config.requireBuildableFill
    ? takerSet
      ? 'gate on, taker configured'
      : 'gate ON but PAPER_TAKER_PUBKEY unset — the engine cannot start'
    : 'gate OFF — quote-only rows would be booked as fills and are NOT executable evidence',
  !config.requireBuildableFill || !takerSet,
);
// Build attempts, which is the number the readiness gate actually needs.
// `quote_buildable_rate` below stays because it is the historical fact, but a
// quote-only corpus reading 0/N must not be confused with a build gate that is
// failing: they are different measurements and only one of them is about
// whether routes can be traded.
const builds = one<{ n: number; ok: number; failed: number }>(
  `SELECT COUNT(*) AS n,
          COALESCE(SUM(CASE WHEN build_status='BUILD_SUCCEEDED' THEN 1 ELSE 0 END),0) AS ok,
          COALESCE(SUM(CASE WHEN build_status='BUILD_FAILED' THEN 1 ELSE 0 END),0) AS failed
   FROM build_attempts`,
);
add(
  'build_success_rate',
  builds === null || builds.n === 0 ? 'no attempts yet' : `${builds.ok}/${builds.n}`,
  builds === null || builds.n === 0
    ? 'no build has been attempted; buildability is UNMEASURED, not proven'
    : `${((builds.ok / builds.n) * 100).toFixed(1)}% built, ${builds.failed} refused`,
  builds === null || builds.n === 0,
);

add(
  'quote_buildable_rate',
  `${quotes.buildable}/${quotes.n}`,
  quotes.buildable === 0
    ? 'no stored quote has ever carried a transaction; no closed trade establishes executable PnL'
    : `${((quotes.buildable / quotes.n) * 100).toFixed(1)}% of quotes buildable`,
  quotes.buildable === 0,
);

// ---- report ----------------------------------------------------------------
const width = Math.max(...out.map((c) => c.name.length));
console.log(`capability report — mode=${config.mode}  ${new Date(now).toISOString()}\n`);
for (const c of out) {
  const mark = c.notable ? '!' : ' ';
  console.log(`${mark} ${c.name.padEnd(width)}  ${String(c.value).padEnd(20)}  ${c.why}`);
}

const notable = out.filter((c) => c.notable);
console.log(`\n${out.length} capabilities, ${notable.length} needing attention`);

// Deliberately NOT a pass/fail. "healthy" as a single word is the thing that
// hid a 16-hour outage. The exit code says whether the engine can trade, and
// the report above says why.
const canTrade = entryAllowed === 'yes' && alive && dbOk;
console.log(canTrade ? '\nENGINE CAN OPEN A POSITION' : '\nENGINE CANNOT OPEN A POSITION — see flags above');
if (!canTrade) process.exitCode = 1;

if (existsSync('data/KILL')) console.log('note: data/KILL exists');
db.close();
