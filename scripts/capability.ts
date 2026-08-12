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

// Wall vs monotonic, from the checkpoints the engine persists. Both clocks are
// stored at every cycle, so this is a measurement rather than an assertion that
// the check exists.
const lastCheck = one<{
  wall_utc_ms: number;
  skew_ms: number | null;
  discontinuity: string | null;
  detail: string | null;
}>(
  'SELECT wall_utc_ms, skew_ms, discontinuity, detail FROM clock_checkpoints ORDER BY wall_utc_ms DESC LIMIT 1',
);
const discontinuities = one<{ n: number }>(
  'SELECT COUNT(*) AS n FROM clock_checkpoints WHERE discontinuity IS NOT NULL',
)!;
add(
  'clock_healthy',
  lastCheck === null ? 'unknown' : discontinuities.n === 0 ? 'yes' : 'no',
  lastCheck === null
    ? 'no clock checkpoint has been written yet; drift is UNMEASURED, which is not the same as absent'
    : `${discontinuities.n} discontinuity(ies) recorded; last skew ${lastCheck.skew_ms === null ? 'n/a' : Math.round(lastCheck.skew_ms) + 'ms'}`,
  lastCheck === null || discontinuities.n > 0,
);

const pendingResync = one<{ detail: string; wall_utc_ms: number }>(
  `SELECT detail, wall_utc_ms FROM clock_checkpoints
   WHERE resync_required = 1 AND resync_done_utc_ms IS NULL ORDER BY wall_utc_ms DESC LIMIT 1`,
);
add(
  'resume_resync_required',
  lastCheck === null ? 'unknown' : pendingResync === null ? 'no' : 'yes',
  lastCheck === null
    ? 'sleep/resume detection has produced no checkpoint yet'
    : pendingResync === null
      ? 'no unresolved clock discontinuity; entries are not gated by one'
      : `UNRESOLVED since ${new Date(pendingResync.wall_utc_ms).toISOString()}: ${pendingResync.detail.slice(0, 70)}`,
  lastCheck === null || pendingResync !== null,
);

// ---- provenance and admissibility ------------------------------------------
// The question P2b actually turns on: how much of this corpus is allowed to be
// evidence? Reported as a count, never as a rate, because a rate hides the
// denominator and the denominator is the point.
const regimes = q<{ data_regime_id: string; n: number }>(
  `SELECT r.data_regime_id, COUNT(*) AS n
   FROM position_marks m JOIN run_contexts r ON r.context_hash = m.context_hash
   GROUP BY 1`,
);
add(
  'single_data_regime',
  regimes.length === 0 ? 'unknown' : regimes.length === 1 ? 'yes' : 'no',
  regimes.length === 0
    ? 'no mark carries a run context yet; every stored mark predates provenance tagging'
    : `${regimes.length} regime(s): ${regimes.map((r) => `${r.data_regime_id} (${r.n})`).join(', ')}`,
  regimes.length !== 1,
);

const markProv = one<{ total: number; tagged: number; withRaw: number }>(
  `SELECT COUNT(*) AS total,
          SUM(CASE WHEN context_hash IS NOT NULL THEN 1 ELSE 0 END) AS tagged,
          SUM(CASE WHEN raw_payload_hash IS NOT NULL THEN 1 ELSE 0 END) AS withRaw
   FROM position_marks`,
)!;
add(
  'marks_with_full_provenance',
  `${markProv.withRaw ?? 0}/${markProv.total}`,
  (markProv.withRaw ?? 0) === 0
    ? 'no mark retains the raw provider payload it was derived from; none can be re-derived if the parser was wrong'
    : `${markProv.tagged ?? 0} tagged with a run context, ${markProv.withRaw} retain their raw payload`,
  (markProv.withRaw ?? 0) === 0,
);

const diag = q<{ diagnostic: string; n: number }>(
  `SELECT COALESCE(diagnostic,'UNCLASSIFIED') AS diagnostic, COUNT(*) AS n
   FROM position_marks GROUP BY 1 ORDER BY n DESC`,
);
const unclassified = diag.find((d) => d.diagnostic === 'UNCLASSIFIED')?.n ?? 0;
add(
  'marks_classified',
  `${markProv.total - unclassified}/${markProv.total}`,
  diag.map((d) => `${d.diagnostic}:${d.n}`).join(' '),
  unclassified > 0,
);

// The number that decides whether P2b may start at all.
const eligible = one<{ n: number }>(
  `SELECT COUNT(*) AS n FROM position_exits e
   WHERE e.context_hash IS NOT NULL
     AND e.diagnostic IS NOT NULL
     AND e.diagnostic NOT IN ('PROVIDER_FAILURE','SCHEMA_OR_PARSER_ERROR','STALE_EXIT_QUOTE','UNVERIFIABLE','UNBUILDABLE_EXIT')
     AND EXISTS (SELECT 1 FROM build_attempts b
                 WHERE b.position_id = e.position_id AND b.side = 'sell' AND b.build_status = 'BUILD_SUCCEEDED')`,
)!;
add(
  'pnl_eligible_trades',
  String(eligible.n),
  eligible.n === 0
    ? 'no closed trade has a build-validated exit leg; 0 trades establish executable PnL'
    : `${eligible.n} closed trade(s) with both legs build-validated`,
  eligible.n === 0,
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
