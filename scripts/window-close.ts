/**
 * `pnpm window:close` — CLOSE a window without invalidating it.
 *
 * The repository had exactly one way to end a window: demote it to
 * INSTRUMENT_DEVELOPMENT_INVALID. That is a one-way door and it says the rows
 * are not evidence. It is the right tool for a window that was collecting under
 * a defect, and completely the wrong one for a window that simply ENDED.
 *
 * A superseded window's rows are still evidence. The baseline hard-gates/random
 * sample this phase inherits is the clearest case: 20 settled trajectories, an
 * honest control, and no reason at all to throw them away — they just belong to
 * a window that a newer contract has replaced.
 *
 * So there are two distinct facts and they now have two distinct verbs:
 *
 *     demote   the rows are not evidence          (evidence:invalidate-old)
 *     close    the window ended; the rows stand   (this)
 *
 * Without the second, an operator ending a window has to choose between lying
 * about the corpus and leaving the window open forever. Both have happened.
 *
 * ## Why a window cannot simply be extended
 *
 * A contract is frozen at a commit. Every commit made while a window is open
 * strands that contract: the code that would collect the next row is no longer
 * the code the contract names. So a window whose commit has been passed cannot
 * be continued — it can only be closed and replaced, which is what this does.
 *
 * The reason text goes through the same S091 validator as a demotion, because a
 * closure that says nothing is as unauditable as an invalidation that says
 * nothing.
 */
import { openDb } from '../packages/storage/src/db.js';
import { validateInvalidationReasons } from '../packages/domain/src/invalidation-reason.js';
import { writeArtifact } from './_artifact.js';

export interface ClosurePlan {
  readonly kind: 'CLOSE' | 'REFUSE';
  readonly contextId: string;
  readonly reasons: readonly string[];
  readonly exitCode: number;
  readonly messages: readonly string[];
}

/** Exported and pure, so the refusal is testable as behaviour. */
export function planClosure(argv: readonly string[]): ClosurePlan {
  const contextId = (argv.find((a) => a.startsWith('--context=')) ?? '').slice(10);
  const raw = argv.filter((a) => a.startsWith('--reason=')).map((a) => a.slice(9));

  if (contextId === '') {
    return {
      kind: 'REFUSE',
      contextId,
      reasons: [],
      exitCode: 2,
      messages: ['usage: pnpm window:close -- --context=<id> --reason="<what ended it>" [--apply]'],
    };
  }
  if (raw.length === 0) {
    return { kind: 'REFUSE', contextId, reasons: [], exitCode: 2, messages: ['--context requires at least one --reason='] };
  }
  const v = validateInvalidationReasons(raw);
  if (!v.ok) {
    return {
      kind: 'REFUSE',
      contextId,
      reasons: [],
      exitCode: 2,
      messages: [
        `REFUSED: ${v.refused.length} of ${raw.length} --reason= argument(s) do not explain anything.`,
        ...v.refused.map((r) => `  ${r.refusal.padEnd(10)} ${r.explanation}`),
      ],
    };
  }
  return { kind: 'CLOSE', contextId, reasons: v.accepted, exitCode: 0, messages: [] };
}

function main(): void {
  const plan = planClosure(process.argv);
  if (plan.kind === 'REFUSE') {
    for (const m of plan.messages) console.error(m);
    process.exit(plan.exitCode);
  }
  const apply = process.argv.includes('--apply');
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });
  try {
    const row = db
      .prepare('SELECT validity, reasons, closed_utc_ms FROM evidence_contexts WHERE evidence_context_id = ?')
      .get(plan.contextId) as { validity: string; reasons: string; closed_utc_ms: number | null } | undefined;
    if (row === undefined) {
      console.error(`no such evidence context: ${plan.contextId}`);
      process.exit(1);
    }

    const counts = db
      .prepare(
        `SELECT t.state AS state, COUNT(*) AS n
           FROM development_trajectories t
           JOIN trajectory_evidence_context x ON x.trajectory_id = t.trajectory_id
          WHERE x.evidence_context_id = ?
          GROUP BY t.state`,
      )
      .all(plan.contextId) as unknown as { state: string; n: number }[];

    console.log(`context   ${plan.contextId}`);
    console.log(`validity  ${row.validity}  (UNCHANGED — closing is not invalidating)`);
    console.log(`state     ${row.closed_utc_ms === null ? 'OPEN' : `already closed at ${new Date(row.closed_utc_ms).toISOString()}`}`);
    for (const c of counts) console.log(`  ${String(c.n).padStart(5)}  ${c.state}`);
    for (const r of plan.reasons) console.log(`  reason  ${r}`);

    /**
     * Trajectories still awaiting an observation will never receive one.
     *
     * Stated plainly, because it is the real cost of closing and an operator
     * should see it before agreeing to it. Their remaining horizons are already
     * past — a "+30m" mark taken two hours late carries the right label on the
     * wrong instant, which is the defect the previous phase existed to fix — so
     * the rows are unfinishable rather than merely unfinished.
     */
    const open = counts.filter((c) => c.state !== 'SETTLED').reduce((a, c) => a + c.n, 0);
    if (open > 0) {
      console.log('');
      console.log(`${open} trajector(ies) in this context are not SETTLED and will receive no further marks.`);
      console.log('Their remaining horizons have already passed, so a mark taken now would carry the right');
      console.log('label on the wrong instant. They stay in the corpus, unfinished and visibly so.');
    }

    if (row.closed_utc_ms !== null) {
      console.log('\nalready closed; nothing to do');
      return;
    }
    if (!apply) {
      console.log('\n(dry run — pass --apply)');
      return;
    }

    const existing = JSON.parse(row.reasons) as unknown[];
    const now = Date.now();
    const r = db
      .prepare('UPDATE evidence_contexts SET closed_utc_ms = ?, reasons = ? WHERE evidence_context_id = ? AND closed_utc_ms IS NULL')
      .run(
        now,
        JSON.stringify([...existing, ...plan.reasons.map((x) => ({ code: 'SUPERSEDED', statement: x }))]),
        plan.contextId,
      );
    if (Number(r.changes) !== 1) throw new Error(`closing ${plan.contextId} changed ${r.changes} rows, expected 1`);

    console.log('\nCLOSED. The rows remain evidence; the window is over.');
    console.log(
      `-> ${writeArtifact('window-closure.json', {
        status: 'APPLIED',
        contextId: plan.contextId,
        validity: row.validity,
        validityChanged: false,
        closedUtcMs: now,
        trajectoriesByState: counts,
        unfinishableTrajectories: open,
        reasons: plan.reasons,
      })}`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('window-close')) main();
