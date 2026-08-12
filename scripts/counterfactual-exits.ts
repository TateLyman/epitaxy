import { openDb } from '../packages/storage/src/db.js';
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { decideExit } from '../packages/strategy/src/exits.js';
import { LAMPORTS_PER_SOL } from '../packages/domain/src/types.js';

/**
 * Replay the CORRECTED exit rules over the stored mark series.
 *
 * What this can and cannot show, stated before the numbers rather than after:
 *
 * The mark series for each position ends when the OLD rule closed it. So for
 * any position where the corrected rule would have exited EARLIER, the marks
 * needed to price that exit exist and the comparison is real. For any position
 * where it would have exited LATER — or not at all — the marks simply stop, and
 * the honest answer is "unknown", not "held to the end and got the same price".
 *
 * Reporting the second case as a gain would be fabricating a fill. It is
 * reported as `unknown (ran out of marks)` and excluded from the totals.
 *
 * There is a second, deeper limit. The mark cadence was ~31s, and all four
 * collapses did their damage inside a single interval. This replay therefore
 * cannot distinguish a rule that would have caught a collapse from one that
 * merely fired on the same post-collapse mark the old rule fired on. Where the
 * counterfactual exit lands on the SAME mark index as the real one, the saving
 * is zero by construction and is labelled as such.
 */

interface MarkRow {
  seq: number;
  observed_utc_ms: number;
  out: string | null;
  cost: string;
  route_available: number;
}

function sol(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return (neg ? '-' : '') + (Number(a) / Number(LAMPORTS_PER_SOL)).toFixed(9);
}

function main(): void {
  const config = loadConfig(modeFromArgv());
  const db = openDb({ path: loadSecrets().databasePath, readonly: true });

  const positions = db
    .prepare(
      `SELECT position_id, mint, outcome, trigger_rule, position_entry_cost_lamports AS cost,
              realized_lamports AS realized, opened_utc_ms, marks_observed
       FROM position_exits ORDER BY opened_utc_ms`,
    )
    .all() as {
    position_id: string;
    mint: string;
    outcome: string;
    trigger_rule: string;
    cost: string;
    realized: string;
    opened_utc_ms: number;
    marks_observed: number;
  }[];

  console.log(
    `counterfactual: exits.ts @ ${config.strategyVersion} replayed over stored marks\n` +
      `collapse floor ${config.exits.liquidityCollapseRatioBps}bps, stop ${config.exits.stopLossBps}bps, ` +
      `trail ${config.exits.trailingStopBps}bps, tp ${config.exits.takeProfitBps}bps, ` +
      `minHold ${config.exits.minHoldMs}ms, maxHold ${config.exits.maxHoldMs}ms\n`,
  );

  const head =
    'position  mint      real_outcome             real_net      cf_rule            cf_at   of   cf_net        delta         verdict';
  console.log(head);
  console.log('-'.repeat(head.length));

  let comparable = 0;
  let deltaTotal = 0n;
  let unknown = 0;
  let sameMark = 0;

  for (const p of positions) {
    const marks = db
      .prepare(
        `SELECT seq, observed_utc_ms, quoted_exit_output_lamports AS out,
                position_entry_cost_lamports AS cost, route_available
         FROM position_marks WHERE position_id = ? ORDER BY seq`,
      )
      .all(p.position_id) as unknown as MarkRow[];

    const cost = BigInt(p.cost);
    const realNet = BigInt(p.realized);

    let peak = cost;
    let fired: { seq: number; reason: string; net: bigint } | null = null;

    for (const m of marks) {
      const gross = m.out === null ? null : BigInt(m.out);
      const mark = gross === null ? null : gross - config.assumedPriorityFeeLamports;
      if (mark !== null && mark > peak) peak = mark;

      const d = decideExit(
        {
          costLamports: cost,
          peakValueLamports: peak,
          markLamports: mark,
          openedUtcMs: p.opened_utc_ms,
          nowUtcMs: m.observed_utc_ms,
          exitRouteExists: m.route_available === 1,
        },
        config.exits,
      );
      if (d.exit) {
        fired = { seq: m.seq, reason: d.reason ?? 'unknown', net: (mark ?? 0n) - cost };
        break;
      }
    }

    const last = marks.length - 1;
    let verdict: string;
    let cfNetStr = '';
    let deltaStr = '';
    let atStr = '';

    if (fired === null) {
      // Never triggered inside the observed window. What happened after the
      // real exit is not in the corpus and is not going to be invented.
      verdict = 'unknown (ran out of marks)';
      atStr = `-`;
      unknown++;
    } else {
      atStr = `${fired.seq}`;
      cfNetStr = sol(fired.net);
      const delta = fired.net - realNet;
      deltaStr = sol(delta);
      if (fired.seq >= last) {
        verdict = 'same mark — no saving possible';
        sameMark++;
      } else {
        verdict = `earlier by ${last - fired.seq} mark(s)`;
      }
      comparable++;
      deltaTotal += delta;
    }

    console.log(
      [
        p.position_id.slice(0, 8),
        p.mint.slice(0, 8).padEnd(8),
        p.outcome.padEnd(24),
        sol(realNet).padStart(12),
        (fired?.reason ?? '-').padEnd(18),
        atStr.padStart(5),
        String(last).padStart(4),
        cfNetStr.padStart(12),
        deltaStr.padStart(12),
        verdict,
      ].join('  '),
    );
  }

  console.log(
    `\n${comparable} of ${positions.length} positions priced from stored marks; ` +
      `${unknown} unknown (no mark after the real exit).`,
  );
  console.log(`${sameMark} fired on the SAME mark as the real exit — zero saving by construction.`);
  console.log(`net difference over the priced subset: ${sol(deltaTotal)} SOL`);
  console.log(
    `\nThis is NOT a claim that the corrected rules earn ${sol(deltaTotal)} SOL. It is a\n` +
      `statement about ten positions whose mark series was truncated by the rule\n` +
      `being replaced. Treat it as a sanity check on the change, not as evidence\n` +
      `of edge. Prospective measurement at a 10s cadence (P2) is what can settle it.`,
  );
}

main();
