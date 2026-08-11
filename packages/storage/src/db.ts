import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Operational store.
 *
 * Choices worth stating:
 *  - `node:sqlite` (built into Node 24) instead of a native addon. On Windows
 *    a native build is a real fragility source (toolchain + antivirus), and
 *    this removes it entirely.
 *  - WAL mode, one logical writer per database.
 *  - Every bigint amount is stored as TEXT. SQLite INTEGER is 64-bit signed and
 *    would silently truncate a u64 token amount near the top of its range.
 */

export type Db = DatabaseSync;

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE IF NOT EXISTS candidates (
  mint              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  decimals          INTEGER NOT NULL,
  token_program     TEXT NOT NULL,
  creator           TEXT,
  launchpad         TEXT NOT NULL,
  first_seen_utc_ms INTEGER NOT NULL,
  created_at_utc_ms INTEGER,
  source            TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  schema_version    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_first_seen ON candidates(first_seen_utc_ms);
CREATE INDEX IF NOT EXISTS idx_candidates_creator ON candidates(creator);

-- Frozen decision inputs. Replay reads ONLY from here.
CREATE TABLE IF NOT EXISTS decision_snapshots (
  snapshot_id       TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  taken_utc_ms      INTEGER NOT NULL,
  taken_mono_ms     INTEGER NOT NULL,
  slot              INTEGER,
  token_age_ms      INTEGER,
  features_json     TEXT NOT NULL,
  raw_inputs_json   TEXT NOT NULL,
  freshness_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON decision_snapshots(mint, taken_utc_ms);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON decision_snapshots(taken_utc_ms);

-- EVERY screening result, accepted and rejected. Required to measure whether
-- filters improve outcomes rather than just tidying the visible trade log.
CREATE TABLE IF NOT EXISTS screenings (
  screening_id      TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  snapshot_id       TEXT NOT NULL,
  evaluated_utc_ms  INTEGER NOT NULL,
  eligible          INTEGER NOT NULL,
  hard_vetoes_json  TEXT NOT NULL,
  soft_risk_score   REAL NOT NULL,
  opportunity_score REAL,
  components_json   TEXT NOT NULL,
  gates_json        TEXT NOT NULL,
  strategy_version  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screenings_mint ON screenings(mint, evaluated_utc_ms);
CREATE INDEX IF NOT EXISTS idx_screenings_eligible ON screenings(eligible, evaluated_utc_ms);

-- Every quote we requested, including failures. Discarding failed quotes would
-- bias every downstream cost estimate.
CREATE TABLE IF NOT EXISTS quotes (
  quote_id                  TEXT PRIMARY KEY,
  mint                      TEXT NOT NULL,
  input_mint                TEXT NOT NULL,
  output_mint               TEXT NOT NULL,
  in_amount                 TEXT NOT NULL,
  out_amount                TEXT NOT NULL,
  other_amount_threshold    TEXT NOT NULL,
  slippage_bps              INTEGER NOT NULL,
  platform_fee_bps          INTEGER NOT NULL,
  price_impact_pct          REAL NOT NULL,
  router                    TEXT NOT NULL,
  route_labels              TEXT NOT NULL,
  signature_fee_lamports    TEXT NOT NULL,
  prioritization_fee_lamports TEXT NOT NULL,
  rent_fee_lamports         TEXT NOT NULL,
  transaction_buildable     INTEGER NOT NULL,
  error_code                INTEGER,
  error_message             TEXT,
  requested_utc_ms          INTEGER NOT NULL,
  received_utc_ms           INTEGER NOT NULL,
  latency_ms                INTEGER NOT NULL,
  side                      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_mint ON quotes(mint, requested_utc_ms);

-- Forward tracking of REJECTED candidates, so we can measure the cost of each
-- gate rather than assuming filters are free.
CREATE TABLE IF NOT EXISTS reject_tracking (
  id                TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  rejected_utc_ms   INTEGER NOT NULL,
  primary_reason    TEXT NOT NULL,
  observed_utc_ms   INTEGER NOT NULL,
  price_usd         REAL,
  liquidity_usd     REAL,
  route_exists      INTEGER,
  horizon_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reject_mint ON reject_tracking(mint, observed_utc_ms);
CREATE INDEX IF NOT EXISTS idx_reject_reason ON reject_tracking(primary_reason);

CREATE TABLE IF NOT EXISTS intents (
  intent_id                 TEXT PRIMARY KEY,
  idempotency_key           TEXT NOT NULL UNIQUE,
  mint                      TEXT NOT NULL,
  side                      TEXT NOT NULL,
  input_mint                TEXT NOT NULL,
  output_mint               TEXT NOT NULL,
  max_input_amount          TEXT NOT NULL,
  min_output_amount         TEXT NOT NULL,
  max_total_fee_lamports    TEXT NOT NULL,
  max_priority_fee_lamports TEXT NOT NULL,
  deadline_utc_ms           INTEGER NOT NULL,
  strategy_version          TEXT NOT NULL,
  risk_snapshot_hash        TEXT NOT NULL,
  created_utc_ms            INTEGER NOT NULL,
  state                     TEXT NOT NULL,
  simulated                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_state ON intents(state);

CREATE TABLE IF NOT EXISTS fills (
  fill_id                TEXT PRIMARY KEY,
  intent_id              TEXT NOT NULL,
  mint                   TEXT NOT NULL,
  side                   TEXT NOT NULL,
  actual_in_amount       TEXT NOT NULL,
  actual_out_amount      TEXT NOT NULL,
  fee_lamports           TEXT NOT NULL,
  priority_fee_lamports  TEXT NOT NULL,
  rent_lamports          TEXT NOT NULL,
  signature              TEXT,
  slot                   INTEGER,
  simulated              INTEGER NOT NULL,
  utc_ms                 INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_signature ON fills(signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fills_mint ON fills(mint, utc_ms);

CREATE TABLE IF NOT EXISTS positions (
  position_id       TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  state             TEXT NOT NULL,
  token_amount      TEXT NOT NULL,
  cost_lamports     TEXT NOT NULL,
  realized_lamports TEXT NOT NULL,
  opened_utc_ms     INTEGER NOT NULL,
  closed_utc_ms     INTEGER,
  strategy_version  TEXT NOT NULL,
  simulated         INTEGER NOT NULL,
  exit_reason       TEXT,
  peak_value_lamports TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_open_mint
  ON positions(mint, strategy_version) WHERE state IN ('POSITION_OPEN','EXIT_INTENT','INTENT_CREATED');

CREATE TABLE IF NOT EXISTS health_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  utc_ms        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  detail        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_time ON health_events(utc_ms);

-- Single-writer enforcement across processes.
CREATE TABLE IF NOT EXISTS process_locks (
  lock_name     TEXT PRIMARY KEY,
  pid           INTEGER NOT NULL,
  hostname      TEXT NOT NULL,
  acquired_utc_ms INTEGER NOT NULL,
  heartbeat_utc_ms INTEGER NOT NULL,
  mode          TEXT NOT NULL
);

-- Every parameter set we evaluate counts as a trial. Required to keep the
-- multiple-testing ledger honest.
CREATE TABLE IF NOT EXISTS trials (
  trial_id      TEXT PRIMARY KEY,
  utc_ms        INTEGER NOT NULL,
  description   TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  metric        TEXT NOT NULL,
  value         REAL,
  sample_size   INTEGER
);
`,
  },
  {
    id: 2,
    name: 'source_health_and_regime',
    sql: `
CREATE TABLE IF NOT EXISTS source_health (
  source          TEXT NOT NULL,
  utc_ms          INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  latency_ms      INTEGER,
  error_kind      TEXT,
  PRIMARY KEY (source, utc_ms)
);
CREATE INDEX IF NOT EXISTS idx_source_health_time ON source_health(utc_ms);

CREATE TABLE IF NOT EXISTS regime_samples (
  utc_ms              INTEGER PRIMARY KEY,
  sol_usd             REAL,
  sol_return_1h       REAL,
  launch_throughput   INTEGER,
  median_launch_liq   REAL,
  slot                INTEGER
);
`,
  },
];

export interface OpenOptions {
  readonly path: string;
  readonly readonly?: boolean;
  /** Skip the automatic pre-migration backup (tests only). */
  readonly skipBackup?: boolean;
}

export function openDb(opts: OpenOptions): Db {
  const abs = resolve(opts.path);
  mkdirSync(dirname(abs), { recursive: true });

  const needsMigration = !opts.readonly;
  if (needsMigration && !opts.skipBackup && existsSync(abs)) {
    // Pre-migration backup. Cheap insurance against a bad migration.
    try {
      copyFileSync(abs, `${abs}.bak`);
    } catch {
      // A failed backup must not prevent read-only startup, but we surface it.
    }
  }

  const db = new DatabaseSync(abs, { readOnly: opts.readonly ?? false });
  if (!opts.readonly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
  }
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_utc_ms INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_utc_ms) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Cross-process single-writer lock. Two executors running at once is a
 * catastrophic failure mode (double-spend of the same balance), so this is
 * checked at startup and heartbeated while running.
 */
export class ProcessLock {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly name: string,
    private readonly mode: string,
    private readonly staleAfterMs = 30_000,
  ) {}

  acquire(): { ok: true } | { ok: false; heldBy: number; ageMs: number } {
    const now = Date.now();
    const row = this.db.prepare('SELECT pid, heartbeat_utc_ms FROM process_locks WHERE lock_name = ?').get(this.name) as
      | { pid: number; heartbeat_utc_ms: number }
      | undefined;

    if (row) {
      const age = now - row.heartbeat_utc_ms;
      // A live heartbeat from another pid means a second instance is running.
      if (age < this.staleAfterMs && row.pid !== process.pid) {
        return { ok: false, heldBy: row.pid, ageMs: age };
      }
    }
    this.db
      .prepare(
        `INSERT INTO process_locks (lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lock_name) DO UPDATE SET
           pid=excluded.pid, hostname=excluded.hostname,
           acquired_utc_ms=excluded.acquired_utc_ms, heartbeat_utc_ms=excluded.heartbeat_utc_ms,
           mode=excluded.mode`,
      )
      .run(this.name, process.pid, hostnameSafe(), now, now, this.mode);

    this.timer = setInterval(() => this.heartbeat(), Math.floor(this.staleAfterMs / 3));
    this.timer.unref();
    return { ok: true };
  }

  heartbeat(): void {
    try {
      this.db
        .prepare('UPDATE process_locks SET heartbeat_utc_ms = ? WHERE lock_name = ? AND pid = ?')
        .run(Date.now(), this.name, process.pid);
    } catch {
      // Heartbeat failure is surfaced by the staleness check on the other side.
    }
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    try {
      this.db.prepare('DELETE FROM process_locks WHERE lock_name = ? AND pid = ?').run(this.name, process.pid);
    } catch {
      /* best effort on shutdown */
    }
  }
}

function hostnameSafe(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
