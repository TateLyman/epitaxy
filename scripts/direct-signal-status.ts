/**
 * P8 — what the direct signal clock actually costs and yields.
 *
 * Measured from the DATABASE, not from the pipeline's counters. The counter
 * called `persisted` counts events handed to the writer, and the writer stores
 * only some of them — so reading it as "rows" would overstate the cost by the
 * entire trade volume, which is the thing the aggregation exists to remove.
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });

const one = <T>(sql: string, ...a: unknown[]): T => db.prepare(sql).get(...(a as never[])) as T;
const all = <T>(sql: string, ...a: unknown[]): T[] => db.prepare(sql).all(...(a as never[])) as T[];

const allHealth = all<Record<string, number>>('SELECT * FROM chain_pipeline_health ORDER BY observed_utc_ms');

/**
 * Only the CURRENT engine run.
 *
 * The counters reset to zero on restart, so a window spanning two runs mixes
 * two different pipelines — and the first measurement did exactly that,
 * counting TRADE rows written before trades were aggregated and reporting a
 * 17x reduction for a change that had not applied to them.
 *
 * The reset is detectable: `received` never decreases within one run.
 */
let runStart = 0;
for (let i = 1; i < allHealth.length; i++) {
  const prev = allHealth[i - 1];
  const cur = allHealth[i];
  if (prev !== undefined && cur !== undefined && (cur.received ?? 0) < (prev.received ?? 0)) runStart = i;
}
const health = allHealth.slice(runStart);
const first = health[0];
const last = health[health.length - 1];
const windowSec =
  first === undefined || last === undefined
    ? 0
    : ((last['observed_utc_ms'] ?? 0) - (first['observed_utc_ms'] ?? 0)) / 1000;

const perSec = (n: number): number => (windowSec <= 0 ? 0 : Number((n / windowSec).toFixed(3)));
const perDay = (n: number): number => Math.round(perSec(n) * 86_400);

const since = first?.['observed_utc_ms'] ?? 0;

// Rows the pipeline actually wrote in the measured window.
const eventRows = one<{ n: number }>('SELECT COUNT(*) n FROM chain_events WHERE received_utc_ms >= ?', since).n;
const barRows = one<{ n: number }>('SELECT COUNT(*) n FROM chain_flow_bars_v2 WHERE bucket_utc_ms >= ?', since).n;
const sampleRows = one<{ n: number }>(
  'SELECT COUNT(*) n FROM chain_unknown_samples WHERE received_utc_ms >= ?',
  since,
).n;
const tradesInBars = one<{ n: number | null }>(
  'SELECT SUM(trades) n FROM chain_flow_bars_v2 WHERE bucket_utc_ms >= ?',
  since,
).n ?? 0;

const byKind = all<{ kind: string; n: number }>(
  'SELECT kind, COUNT(*) n FROM chain_events WHERE received_utc_ms >= ? GROUP BY kind ORDER BY n DESC',
  since,
);

/** The firehose this replaced, for the comparison that matters. */
const firehose = one<{ n: number; a: number; b: number }>(
  'SELECT COUNT(*) n, MIN(received_utc_ms) a, MAX(received_utc_ms) b FROM direct_chain_events',
);
const firehoseSec = firehose.n === 0 ? 0 : (firehose.b - firehose.a) / 1000;

const delta = (k: string): number =>
  last === undefined || first === undefined ? 0 : (last[k] ?? 0) - (first[k] ?? 0);
const received = delta('received');
const parsed = delta('parsed');
const unknown = delta('unknown');
const dropped = delta('dropped');
const bytesIn = delta('bytes_in');

const status = {
  generatedUtcMs: Date.now(),
  sourceCommit: execSync('git rev-parse HEAD').toString().trim(),
  dirty: execSync('git status --porcelain').toString().trim().length > 0,
  strategyVersion: config.strategyVersion,
  schemaVersion: (one<{ v: number }>('SELECT MAX(id) v FROM schema_migrations') ?? { v: 0 }).v,
  windowSeconds: windowSec,

  throughput: {
    receivedPerSecond: perSec(received),
    parsedFraction: parsed + unknown === 0 ? null : Number((parsed / (parsed + unknown)).toFixed(4)),
    droppedInWindow: dropped,
    queueHighWater: last?.['queue_high_water'] ?? 0,
    bytesInPerSecond: perSec(bytesIn),
  },

  /** What it COSTS. Rows, not events. */
  storage: {
    eventRows,
    barRows,
    unknownSampleRows: sampleRows,
    totalRowsPerDay: perDay(eventRows + barRows + sampleRows),
    databaseBytes: statSync(secrets.databasePath).size,
  },

  /** What it YIELDS. */
  yield: {
    byKind,
    tradesAggregatedIntoBars: tradesInBars,
    compressionRatio: barRows === 0 ? null : Number((tradesInBars / barRows).toFixed(1)),
  },

  replacedFirehose: {
    rows: firehose.n,
    windowSeconds: Number(firehoseSec.toFixed(0)),
    rowsPerSecond: firehoseSec === 0 ? 0 : Number((firehose.n / firehoseSec).toFixed(1)),
    projectedRowsPerDay: firehoseSec === 0 ? 0 : Math.round((firehose.n / firehoseSec) * 86_400),
    note:
      'Retained, not deleted. These rows are the evidence of what the firehose did, and ' +
      'the engine no longer writes to that table.',
  },

  /**
   * The stream is TELEMETRY until a production decision reads it. Stated here
   * so no report can imply otherwise.
   */
  feedsProductionDecisions: false,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/direct-signal-status.json', JSON.stringify(status, null, 2));

console.log(`window            ${windowSec.toFixed(0)}s`);
console.log(`received/s        ${status.throughput.receivedPerSecond}`);
console.log(`parsed            ${((status.throughput.parsedFraction ?? 0) * 100).toFixed(1)}%`);
console.log(`dropped           ${dropped}   queue high water ${status.throughput.queueHighWater}`);
console.log(`engine runs seen  ${allHealth.length} health rows, using the last ${health.length}`);
console.log(`rows/day          ${status.storage.totalRowsPerDay.toLocaleString()}`);
console.log(`firehose rows/day ${status.replacedFirehose.projectedRowsPerDay.toLocaleString()}`);
console.log(
  `reduction         ${
    status.storage.totalRowsPerDay === 0
      ? 'n/a'
      : `${Math.round(status.replacedFirehose.projectedRowsPerDay / status.storage.totalRowsPerDay)}x`
  }`,
);
console.log(`compression       ${status.yield.compressionRatio}x trades per bar`);
console.log('artifacts/direct-signal-status.json');
db.close();
