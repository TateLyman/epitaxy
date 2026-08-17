/**
 * `pnpm scheduler:status` — is the mark clock holding its SLA?
 *
 * The 8f73cef audit's B-4 found 697 of 1,448 marks more than 60 seconds late,
 * and S-4 measured the shape: only 57 of 292 one-minute marks landed within 60 s
 * of their horizon. Nothing reported that continuously, so it took an audit to
 * discover a property that degrades silently and invalidates the tournament.
 *
 * This is that report. It reads the SLA verdict stored on each mark rather than
 * recomputing a bound, because the bound is frozen per contract and a report
 * that applies today's bound to yesterday's rows is answering a different
 * question.
 */
import { openDb } from '../packages/storage/src/db.js';
import { slaReport, dueMarks, nextWakeMs, MARK_SLA_MS } from '../packages/pipeline/src/mark-scheduler.js';
import { MARK_OFFSETS_MS } from '../packages/pipeline/src/mark-path.js';
import { writeArtifact } from './_artifact.js';

function main(): void {
  const ctxArg = process.argv.find((a) => a.startsWith('--context='));
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });

  try {
    const activeContexts = (
      db
        .prepare(`SELECT evidence_context_id FROM evidence_contexts WHERE validity = 'DEVELOPMENT_EVIDENCE'`)
        .all() as { evidence_context_id: string }[]
    ).map((r) => r.evidence_context_id);
    const ctx = ctxArg === undefined ? (activeContexts[0] ?? null) : ctxArg.slice(10);

    const now = Date.now();
    const due = dueMarks(db, { nowMs: now, offsets: MARK_OFFSETS_MS, evidenceContextId: ctx });
    const overdue = due.filter((d) => now - d.dueUtcMs > MARK_SLA_MS);
    const wake = nextWakeMs(db, { nowMs: now, offsets: MARK_OFFSETS_MS });

    /**
     * With no ACTIVE context there is no active sample, and that is different
     * from an empty one. `slaReport(db, { evidenceContextId: null })` returns
     * the WHOLE corpus — including the invalidated pre-repair window — so
     * passing null here would report 292 unclassified pre-repair marks as this
     * window's SLA breach. Reporting an invalidated window's failures as the
     * current window's is the same substitution the invalidation ledger exists
     * to prevent.
     */
    const active = ctx === null ? [] : slaReport(db, { evidenceContextId: ctx });
    const corpus = slaReport(db);

    console.log(`active evidence context : ${ctx ?? '(none)'}\n`);

    console.log('ACTIVE CONTEXT — marks by horizon');
    if (active.length === 0) console.log('  (no marks yet)');
    for (const r of active) {
      const pct = r.total === 0 ? 0 : Math.round((r.onTime / r.total) * 100);
      console.log(
        `  ${String(r.offsetMs / 60_000).padStart(3)}m  total ${String(r.total).padStart(5)}  ` +
          `on time ${String(r.onTime).padStart(5)} (${pct}%)  missed ${String(r.missed).padStart(5)}  ` +
          `unclassified ${r.unclassified}`,
      );
    }

    console.log('\nWHOLE CORPUS — including the invalidated pre-repair window');
    for (const r of corpus) {
      const pct = r.total === 0 ? 0 : Math.round((r.onTime / r.total) * 100);
      console.log(
        `  ${String(r.offsetMs / 60_000).padStart(3)}m  total ${String(r.total).padStart(5)}  ` +
          `on time ${String(r.onTime).padStart(5)} (${pct}%)  missed ${String(r.missed).padStart(5)}  ` +
          `unclassified ${r.unclassified}`,
      );
    }

    console.log('');
    console.log(`marks due right now     : ${due.length}`);
    console.log(`already past the SLA    : ${overdue.length}  (SLA ${MARK_SLA_MS} ms)`);
    console.log(`next deadline in        : ${wake} ms`);
    if (overdue.length > 0) {
      console.log('\nDiscovery is DEFERRED while any mark is past its SLA. Opening another trajectory');
      console.log('adds deadlines to a queue that is already missing the ones it has.');
      for (const d of overdue.slice(0, 5)) {
        console.log(
          `  ${d.mint.slice(0, 10)}  +${d.offsetMs / 60_000}m  late by ${Math.round((now - d.dueUtcMs) / 1000)}s  [${d.kind}]`,
        );
      }
    }

    const activeTotal = active.reduce((n, r) => n + r.total, 0);
    const activeMissed = active.reduce((n, r) => n + r.missed + r.unclassified, 0);
    const holding = activeTotal > 0 && activeMissed === 0 && overdue.length === 0;

    const artifact = writeArtifact('scheduler-status.json', {
      activeContext: ctx,
      slaMs: MARK_SLA_MS,
      activeContextByHorizon: active,
      corpusByHorizon: corpus,
      dueNow: due.length,
      overdue: overdue.length,
      nextWakeMs: wake,
      activeTotal,
      activeMissedOrUnclassified: activeMissed,
      verdict: activeTotal === 0 ? 'NO_MARKS_YET' : holding ? 'SLA_HELD' : 'SLA_BREACHED',
    });

    console.log(`\nverdict: ${activeTotal === 0 ? 'NO MARKS YET' : holding ? 'SLA HELD' : 'SLA BREACHED'}`);
    console.log(`-> ${artifact}`);
    process.exit(activeTotal > 0 && !holding ? 1 : 0);
  } finally {
    db.close();
  }
}

main();
