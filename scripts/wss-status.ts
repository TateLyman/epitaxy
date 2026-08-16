import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { wssCoverage, sessionSpans } from '../packages/storage/src/collector-telemetry.js';

/**
 * P11/P12 — `pnpm wss:status`, which reports on the WEBSOCKET.
 *
 * This command used to be an alias for `direct-signal:status`, and then a
 * NOT_IMPLEMENTED stub. An alias is worse than the stub: it answers a question
 * nobody asked in a format that looks like an answer to the one they did, and
 * an operator reading "healthy" from a direct-signal report has learned nothing
 * about whether the socket was connected.
 *
 * It reads the DATABASE, not a live process. A status command that can only
 * report on an in-process watcher reports nothing the moment the process stops,
 * which is exactly when it is asked what happened.
 *
 * What it will not do is invent a per-account gap. A quiet account across slots
 * is a quiet account; recording "no update for 40 slots" per address
 * manufactures a gap for every account that simply did not trade and buries the
 * one real gap — the interval where the SOCKET was down and nothing could have
 * been seen.
 */

function main(): void {
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, readonly: true });

  const coverage = wssCoverage(db);
  const spans = sessionSpans(db);

  const sessions = db
    .prepare(
      `SELECT session_id, started_utc_ms, heartbeat_utc_ms, ended_utc_ms, cycles, endpoint, source_commit, dirty
         FROM collector_sessions ORDER BY started_utc_ms DESC LIMIT 10`,
    )
    .all() as {
    session_id: string;
    started_utc_ms: number;
    heartbeat_utc_ms: number;
    ended_utc_ms: number | null;
    cycles: number;
    endpoint: string;
    source_commit: string;
    dirty: number;
  }[];

  const gaps = db
    .prepare(
      `SELECT session_id, gap_start_utc_ms, gap_end_utc_ms, reason, addresses_resynced, addresses_changed, still_unreadable
         FROM wss_gaps ORDER BY gap_start_utc_ms DESC LIMIT 25`,
    )
    .all() as Record<string, unknown>[];

  const subs = db
    .prepare(
      `SELECT kind, COUNT(*) total,
              SUM(CASE WHEN unsubscribed_utc_ms IS NULL THEN 1 ELSE 0 END) open,
              SUM(events) events
         FROM wss_subscriptions GROUP BY kind ORDER BY kind`,
    )
    .all() as Record<string, unknown>[];

  const urgentLag = db
    .prepare(
      `SELECT consumed_utc_ms - queued_utc_ms ms FROM urgent_marks
        WHERE consumed_utc_ms IS NOT NULL ORDER BY queued_utc_ms DESC LIMIT 500`,
    )
    .all() as { ms: number }[];

  db.close();

  const pct = (xs: readonly number[], p: number): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? null;
  };
  const lags = urgentLag.map((r) => r.ms);

  console.log('wss:status — websocket coverage, from the database');
  console.log('');
  if (coverage.sessions === 0) {
    console.log('NO COLLECTOR SESSIONS RECORDED.');
    console.log('The websocket lanes have never run. This is not "no gaps" — it is no coverage.');
  } else {
    console.log(`collector sessions      : ${spans.sessions} (${spans.diedWithoutClosing} ended without closing)`);
    console.log(`active seconds          : ${spans.activeSeconds.toFixed(0)} of ${spans.wallSeconds.toFixed(0)} wall`);
    console.log('');
    console.log('subscriptions by kind:');
    for (const s of subs) {
      console.log(`  ${String(s['kind']).padEnd(16)} open ${String(s['open']).padStart(4)}  of ${String(s['total']).padStart(4)}  events ${s['events'] ?? 0}`);
    }
    if (subs.length === 0) console.log('  (none)');
    console.log('');
    console.log(`coverage gaps           : ${coverage.gaps} (${coverage.openGaps} still open)`);
    console.log(`addresses that MOVED while blind: ${coverage.addressesChangedWhileBlind}`);
    console.log('');
    console.log(
      `urgent queue            : ${coverage.urgentQueued} queued, ${coverage.urgentConsumed} consumed, ` +
        `${coverage.urgentPending} pending`,
    );
    console.log(`  consumption lag P50 ${pct(lags, 50) ?? 'n/a'} ms  P95 ${pct(lags, 95) ?? 'n/a'} ms`);
    if (coverage.urgentQueued > 0 && coverage.urgentConsumed === 0) {
      // A queue that only fills is theatre. Named, so it cannot read as working.
      console.log('  WARNING: nothing has ever been consumed. The urgent queue is filling and not draining.');
    }
    console.log('');
    console.log('recent sessions:');
    for (const s of sessions.slice(0, 5)) {
      const dur = ((s.ended_utc_ms ?? s.heartbeat_utc_ms) - s.started_utc_ms) / 1000;
      console.log(
        `  ${new Date(s.started_utc_ms).toISOString()}  ${dur.toFixed(0)}s  ${s.cycles} cycles  ` +
          `${s.endpoint}  ${s.source_commit.slice(0, 8)}${s.dirty === 1 ? '-dirty' : ''}` +
          (s.ended_utc_ms === null ? '  DIED OR RUNNING' : ''),
      );
    }
  }

  let commit = 'unknown';
  let dirty = true;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* unknown provenance is reported, never omitted */
  }

  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/wss-status.json',
    JSON.stringify(
      {
        artifact: 'wss-status',
        directiveSection: 'P11',
        generatedUtcMs: Date.now(),
        sourceCommit: commit,
        dirty,
        coverage,
        activeTime: spans,
        subscriptionsByKind: subs,
        gaps,
        urgentConsumptionLagMs: { p50: pct(lags, 50), p95: pct(lags, 95), samples: lags.length },
        sessions,
        notReported:
          'per-account silence. A quiet account across slots is a quiet account; ' +
          'manufacturing a gap per address buries the one real gap, which is the interval the SOCKET was down.',
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('wrote artifacts/wss-status.json');
}

main();
