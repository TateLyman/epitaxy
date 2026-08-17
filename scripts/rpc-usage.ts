/**
 * `pnpm rpc:usage` — ACTIVE-TIME RPC usage, and what it says about buying more.
 *
 * P16. The figure this replaces divided request counts by ELAPSED WALL TIME,
 * downtime included: a process that ran twenty minutes out of a day reported
 * "48 requests/day against a 10,000/day quota" and concluded quota was not the
 * constraint. That describes the downtime, not the load.
 *
 * `collector_sessions` exists so the denominator can be ACTIVE SECONDS. A
 * purchase recommendation derived from anything else is a recommendation about
 * how often the operator remembered to start the collector.
 */
import { openDb } from '../packages/storage/src/db.js';
import { writeArtifact } from './_artifact.js';

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });
  try {
    const rows = db
      .prepare(
        `SELECT session_id, started_utc_ms, heartbeat_utc_ms, ended_utc_ms, source_commit, dirty, cycles
           FROM collector_sessions ORDER BY started_utc_ms DESC LIMIT 50`,
      )
      .all() as {
      session_id: string;
      started_utc_ms: number;
      heartbeat_utc_ms: number;
      ended_utc_ms: number | null;
      source_commit: string;
      dirty: number;
      cycles: number;
    }[];

    // A session that never wrote `ended_utc_ms` was KILLED. Its active time runs
    // to its last heartbeat, not to now: counting to now would credit the
    // collector with hours it spent not existing.
    const activeMs = rows.reduce((n, r) => n + Math.max(0, (r.ended_utc_ms ?? r.heartbeat_utc_ms) - r.started_utc_ms), 0);
    const activeSeconds = Math.round(activeMs / 1000);
    const killed = rows.filter((r) => r.ended_utc_ms === null).length;
    const dirtySessions = rows.filter((r) => r.dirty === 1).length;

    const byKind = db
      .prepare(
        `SELECT kind, COALESCE(detail,'') detail, SUM(count) n, SUM(quota_errors) q
           FROM collector_counters GROUP BY kind, detail ORDER BY n DESC LIMIT 20`,
      )
      .all() as { kind: string; detail: string; n: number; q: number }[];

    const totalCalls = byKind.reduce((n, r) => n + Number(r.n), 0);
    const quotaErrors = byKind.reduce((n, r) => n + Number(r.q ?? 0), 0);
    const perSecond = activeSeconds === 0 ? 0 : totalCalls / activeSeconds;

    const trajectories = Number(
      (db.prepare('SELECT COUNT(*) c FROM development_trajectories').get() as { c: number }).c,
    );
    const perDay = activeSeconds === 0 ? 0 : (trajectories / activeSeconds) * 86_400;

    console.log('RPC usage, over ACTIVE COLLECTOR TIME\n');
    console.log(`  sessions examined      ${rows.length}`);
    console.log(`  active seconds         ${activeSeconds.toLocaleString()}  (${(activeSeconds / 3600).toFixed(1)} h)`);
    console.log(`  sessions never ended   ${killed}   (killed rather than stopped)`);
    console.log(`  sessions from a dirty tree ${dirtySessions}`);
    console.log('');
    for (const r of byKind) {
      console.log(
        `  ${String(r.n).padStart(8)}  ${r.kind}${r.detail === '' ? '' : `/${r.detail}`}` +
          (Number(r.q ?? 0) > 0 ? `   quota errors ${r.q}` : ''),
      );
    }
    console.log('');
    console.log(`  total calls            ${totalCalls.toLocaleString()}`);
    console.log(`  calls per ACTIVE second ${perSecond.toFixed(3)}`);
    console.log(`  quota errors           ${quotaErrors}`);
    console.log(`  trajectories per active day ${perDay.toFixed(1)}`);

    /**
     * P16 — the recommendation, and what would have to be true for it.
     *
     * Deliberately conservative. "No Shreds, dedicated validator, colocation,
     * archival node or Business infrastructure before a positive untouched edge
     * exists" is not advice this command may override, and Jupiter Developer is
     * not recommended until the clean active-time report shows Free's 1 RPS
     * limiting completed trajectories.
     */
    const recommendations: string[] = [];
    if (quotaErrors > 0) {
      recommendations.push(
        `${quotaErrors} quota refusal(s) at ${perSecond.toFixed(2)} calls/active second. If the endpoint is ` +
          'out of credits after the single-writer repair, Helius Developer (~$49/month, 10M credits, ' +
          '50 RPC requests/second per current official terms — use the dashboard price as source of truth) ' +
          'is the smallest purchase that removes it. Do not put the key in logs, chat or Git.',
      );
    } else {
      recommendations.push(
        `no quota refusal in this window at ${perSecond.toFixed(2)} calls/active second. Nothing to buy: ` +
          'a purchase made without a measured binding constraint buys headroom nobody was using.',
      );
    }
    recommendations.push(
      'Jupiter Developer is NOT recommended: direct PumpSwap is the primary lane, and Free’s 1 RPS has not ' +
        'been shown to limit completed trajectories or the later-fill SLA.',
    );
    recommendations.push(
      'No Shreds, dedicated validator, colocation, archival node or Business infrastructure before a positive ' +
        'untouched edge exists.',
    );

    console.log('\nrecommendation');
    for (const r of recommendations) console.log(`  - ${r}`);

    const path = writeArtifact('rpc-usage.json', {
      sessionsExamined: rows.length,
      activeSeconds,
      sessionsNeverEnded: killed,
      sessionsFromDirtyTree: dirtySessions,
      byKind,
      totalCalls,
      callsPerActiveSecond: perSecond,
      quotaErrors,
      trajectories,
      trajectoriesPerActiveDay: perDay,
      recommendations,
    });
    console.log(`\n-> ${path}`);
  } finally {
    db.close();
  }
}

main();
