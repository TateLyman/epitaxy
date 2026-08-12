// Opens the database, opens a position, writes marks with WAL active, and dies
// without closing anything. Used by tests/integration/recovery.test.ts.
//
// A separate process because that is the only way to produce the thing under
// test: an operating-system kill leaves the write-ahead log un-checkpointed and
// the connection un-finalised, which is what a power loss looks like from
// SQLite's point of view. Calling `process.exit()` in-process would run exit
// handlers and prove nothing.
import { DatabaseSync } from 'node:sqlite';

const [, , dbPath, positionId, mint, markCount] = process.argv;

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.prepare(
  `INSERT INTO positions (position_id,mint,state,token_amount,cost_lamports,realized_lamports,
     opened_utc_ms,closed_utc_ms,strategy_version,simulated,exit_reason,peak_value_lamports)
   VALUES (?,?,'POSITION_OPEN','1000000000','50000000','0',?,NULL,'crash-test',1,NULL,'50000000')`,
).run(positionId, mint, Date.now());

const n = Number(markCount);
for (let seq = 0; seq < n; seq++) {
  db.prepare(
    `INSERT INTO position_marks (mark_id,position_id,mint,seq,observed_utc_ms,
       position_entry_cost_lamports,quoted_exit_output_lamports,route_available,source,backfilled)
     VALUES (?,?,?,?,?,'50000000',?,1,'crash-test',0)`,
  ).run(`${positionId}-${seq}`, positionId, mint, seq, Date.now() + seq, String(49_000_000 + seq));
}

// Prove the rows are visible to this connection before we die, so a failure
// later is a recovery failure and not a write that never happened.
const seen = db.prepare('SELECT COUNT(*) AS n FROM position_marks WHERE position_id = ?').get(positionId);
if (seen.n !== n) {
  console.error(`child wrote ${seen.n} marks, expected ${n}`);
  process.exitCode = 2;
}

process.stdout.write('WROTE\n');
// No db.close(), no checkpoint, no exit handlers.
process.kill(process.pid, 'SIGKILL');
