import { randomUUID } from 'node:crypto';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { insertPositionMark, insertPositionExit } from '../packages/storage/src/repo.js';
import { classifyExit, ACCOUNTING_VERSION, type TriggerRule } from '../packages/domain/src/exitoutcome.js';
import { formatAmount } from '../packages/domain/src/amounts.js';

/**
 * Reclassify every closed position under migration-5 semantics (P1).
 *
 * The original corpus recorded one `exit_reason` per position and nothing
 * about the path that got there. Everything needed to reconstruct that path is
 * already stored — `quotes` holds every sell quote we took, `fills` holds what
 * we paid and received — so this is a re-derivation from primary records, not
 * an invention. Marks written here carry `backfilled = 1` for exactly that
 * reason: they are as good as the quote log and no better, and no analysis
 * should be able to confuse them with marks taken live.
 *
 * Idempotent. Writes nothing without `--apply`.
 *
 * Two facts that make the reconstruction sound, both verified against the data
 * before this was written:
 *   - A sell quote's `other_amount_threshold` equals the gross proceeds the
 *     engine credited plus the priority fee it charged, so the fill rows and
 *     the quote rows agree and either can be used to recover the other.
 *   - No two positions on the same mint overlap in time, so a sell quote can
 *     be attributed to a position by mint plus time window. This is asserted
 *     rather than assumed; the script refuses to run if it is ever false.
 */

const APPLY = process.argv.includes('--apply');

interface PosRow {
  position_id: string;
  mint: string;
  cost_lamports: string;
  realized_lamports: string;
  opened_utc_ms: number;
  closed_utc_ms: number | null;
  exit_reason: string | null;
  strategy_version: string;
  state: string;
}

interface QuoteRow {
  in_amount: string;
  out_amount: string;
  other_amount_threshold: string;
  price_impact_pct: number | null;
  platform_fee_bps: number | null;
  route_labels: string | null;
  signature_fee_lamports: string | null;
  prioritization_fee_lamports: string | null;
  requested_utc_ms: number;
  received_utc_ms: number;
  latency_ms: number | null;
}

interface FillRow {
  actual_in_amount: string;
  actual_out_amount: string;
  fee_lamports: string;
  priority_fee_lamports: string;
  rent_lamports: string;
  utc_ms: number;
}

/** Old reason strings map onto the trigger-rule vocabulary one-for-one. */
function toTriggerRule(reason: string | null): TriggerRule {
  switch (reason) {
    case 'stop_loss':
    case 'trailing_stop':
    case 'take_profit':
    case 'max_hold':
    case 'exit_route_lost':
    case 'exit_cost_exploded':
      return reason;
    case null:
      return 'unknown';
    default:
      return 'unknown';
  }
}

const SOL = (v: bigint | null): string => (v === null ? '        null' : formatAmount(v, 9).padStart(12));

function main(): void {
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath });

  const positions = db
    .prepare(`SELECT * FROM positions WHERE closed_utc_ms IS NOT NULL ORDER BY opened_utc_ms`)
    .all() as unknown as PosRow[];

  // Assert the attribution premise instead of trusting it. Two positions on
  // one mint whose windows overlap would make every quote ambiguous, and a
  // silently mis-attributed mark is worse than no mark.
  for (const a of positions) {
    for (const b of positions) {
      if (a.position_id >= b.position_id || a.mint !== b.mint) continue;
      const aEnd = a.closed_utc_ms ?? Infinity;
      const bEnd = b.closed_utc_ms ?? Infinity;
      if (a.opened_utc_ms <= bEnd && b.opened_utc_ms <= aEnd) {
        throw new Error(
          `overlapping positions on ${a.mint}: ${a.position_id} and ${b.position_id}; ` +
            `quote attribution by mint+window is not sound and this backfill must not run`,
        );
      }
    }
  }

  const rows: string[] = [];
  rows.push(
    'position  mint      cost         final_exec   ratio    OLD reason           NEW outcome              marks  path',
  );

  let collapseCount = 0;
  const trajectories: string[] = [];

  for (const p of positions) {
    const cost = BigInt(p.cost_lamports);
    const realized = BigInt(p.realized_lamports);
    const closed = p.closed_utc_ms as number;

    const quotes = db
      .prepare(
        `SELECT * FROM quotes WHERE side='sell' AND mint = ?
           AND requested_utc_ms >= ? AND requested_utc_ms <= ?
         ORDER BY requested_utc_ms`,
      )
      .all(p.mint, p.opened_utc_ms, closed + 5_000) as unknown as QuoteRow[];

    const buyFill = db
      .prepare(`SELECT * FROM fills WHERE mint = ? AND side='buy' AND utc_ms >= ? ORDER BY utc_ms LIMIT 1`)
      .get(p.mint, p.opened_utc_ms - 5_000) as unknown as FillRow | undefined;
    const sellFill = db
      .prepare(`SELECT * FROM fills WHERE mint = ? AND side='sell' AND utc_ms >= ? ORDER BY utc_ms LIMIT 1`)
      .get(p.mint, p.opened_utc_ms) as unknown as FillRow | undefined;

    // Reconstruct the mark series.
    let prevOut: bigint | null = null;
    let seq = 0;
    let finalMarkId: string | null = null;
    const ratios: number[] = [];

    for (const q of quotes) {
      const out = BigInt(q.out_amount);
      const thr = BigInt(q.other_amount_threshold);
      const markId = randomUUID();
      const ratio = Number(out) / Number(cost);
      ratios.push(ratio);
      const changeBps =
        prevOut === null || prevOut === 0n
          ? null
          : Math.round((Number(out - prevOut) / Number(prevOut)) * 10_000);

      if (APPLY) {
        insertPositionMark(db, {
          markId,
          positionId: p.position_id,
          mint: p.mint,
          seq,
          observedUtcMs: q.received_utc_ms,
          rawPriceImpactPct: q.price_impact_pct,
          rawPriceImpactBpsSigned:
            q.price_impact_pct === null ? null : Math.round(q.price_impact_pct * 10_000),
          quotedExitInputTokenAmount: BigInt(q.in_amount),
          quotedExitOutputLamports: out,
          quotedExitThresholdLamports: thr,
          positionEntryCostLamports: cost,
          positionMarkedValueLamports: out,
          exitValueRatio: ratio,
          outputChangeFromPreviousMarkBps: changeBps,
          routeAvailable: out > 0n,
          routeLabels: q.route_labels,
          platformFeeBps: q.platform_fee_bps,
          // Charged in tokens at entry, not recoverable per-mark from the log.
          platformFeeAmount: null,
          transferFeeAmount: null,
          estimatedNetworkFeeLamports:
            q.signature_fee_lamports === null ? null : BigInt(q.signature_fee_lamports),
          estimatedPriorityFeeLamports:
            q.prioritization_fee_lamports === null ? null : BigInt(q.prioritization_fee_lamports),
          // Everything below was never measured in this era. NULL, not zero.
          poolQuoteReserve: null,
          poolTokenReserve: null,
          quoteReserveChangeFromEntryBps: null,
          quoteReserveChangeFromPrevBps: null,
          liquidityUsd: null,
          liquidityChangeFromEntryBps: null,
          developerNetTokenFlow: null,
          clusteredInsiderNetTokenFlow: null,
          quoteRequestedUtcMs: q.requested_utc_ms,
          quoteReceivedUtcMs: q.received_utc_ms,
          quoteLatencyMs: q.latency_ms,
          sourceUtcMs: q.received_utc_ms,
          slot: null,
          source: 'backfill:quotes',
          backfilled: true,
        });
      }
      finalMarkId = markId;
      prevOut = out;
      seq += 1;
    }

    const lastQuote = quotes.length > 0 ? quotes[quotes.length - 1] : undefined;
    const finalExec = lastQuote === undefined ? null : BigInt(lastQuote.out_amount);
    const routeAvailable = finalExec !== null && finalExec > 0n;

    const verdict = classifyExit({
      quotedExitOutputLamports: finalExec,
      positionEntryCostLamports: cost,
      routeAvailable,
      triggerRule: toTriggerRule(p.exit_reason),
    });
    if (verdict.outcome === 'liquidity_collapse') collapseCount += 1;

    // Economic decomposition. gross is what the swap returned before the exit
    // fee; the engine previously wrote gross-minus-fee into the fill's
    // actual_out_amount, which is how a fill came to claim a negative output
    // (O033).
    const exitFees = sellFill === undefined ? null : BigInt(sellFill.priority_fee_lamports);
    const netProceeds = sellFill === undefined ? null : BigInt(sellFill.actual_out_amount);
    const grossProceeds = netProceeds === null || exitFees === null ? null : netProceeds + exitFees;
    const ataRent = buyFill === undefined ? null : BigInt(buyFill.rent_lamports);
    const entryFixed =
      buyFill === undefined ? null : BigInt(buyFill.priority_fee_lamports) + BigInt(buyFill.rent_lamports);
    const entryNotional = buyFill === undefined ? null : BigInt(buyFill.actual_in_amount);

    if (APPLY) {
      insertPositionExit(db, {
        positionId: p.position_id,
        mint: p.mint,
        outcome: verdict.outcome,
        triggerRule: toTriggerRule(p.exit_reason),
        outcomeRationale: verdict.rationale,
        exitValueRatio: verdict.exitValueRatio,
        positionEntryCostLamports: cost,
        quotedExitOutputLamports: finalExec,
        grossProceedsLamports: grossProceeds,
        exitFeesLamports: exitFees,
        netProceedsLamports: netProceeds,
        realizedLamports: realized,
        entryNotionalLamports: entryNotional,
        entryFixedCostsLamports: entryFixed,
        ataRentLamports: ataRent,
        // Never modelled in this era, and NOT the same as "was not refunded".
        ataRentRefunded: null,
        finalMarkId,
        marksObserved: quotes.length,
        openedUtcMs: p.opened_utc_ms,
        closedUtcMs: closed,
        heldMs: closed - p.opened_utc_ms,
        strategyVersion: p.strategy_version,
        accountingVersion: ACCOUNTING_VERSION,
        backfilled: true,
      });
    }

    // Was the collapse gradual or abrupt?
    //
    // Measured as drawdown from the PEAK mark, not from the first. Several of
    // these positions rose before they fell, and dividing by the decline from
    // the first mark produced ratios above 1.0 — a denominator that quietly
    // understates how concentrated the fall was. Peak-to-final is the honest
    // denominator, and the share of it carried by the single worst step is
    // what separates "it drained" from "it went in one block".
    let path = 'n/a';
    if (ratios.length >= 2) {
      let worstStep = 0;
      let worstIdx = -1;
      for (let i = 1; i < ratios.length; i++) {
        const drop = (ratios[i - 1] as number) - (ratios[i] as number);
        if (drop > worstStep) {
          worstStep = drop;
          worstIdx = i;
        }
      }
      const peak = Math.max(...ratios);
      const last = ratios[ratios.length - 1] as number;
      const drawdown = peak - last;
      const share = drawdown <= 0 ? 0 : worstStep / drawdown;
      path =
        drawdown <= 0.01
          ? 'no-decline'
          : share >= 0.8
            ? 'abrupt'
            : share >= 0.4
              ? 'stepwise'
              : 'gradual';
      if (verdict.outcome === 'liquidity_collapse') {
        const healthyMarks = worstIdx; // marks observed before the fatal step
        const tHealthy =
          worstIdx > 0 && quotes[worstIdx - 1] !== undefined
            ? Math.round(((quotes[worstIdx - 1] as QuoteRow).received_utc_ms - p.opened_utc_ms) / 1000)
            : 0;
        // The decisive number: wall-clock between the last healthy observation
        // and the one that showed the collapse. Any exit rule driven by marks
        // can only act inside this window, so it bounds what ANY mark-based
        // strategy could have recovered.
        const gapMs =
          worstIdx > 0 && quotes[worstIdx] !== undefined && quotes[worstIdx - 1] !== undefined
            ? (quotes[worstIdx] as QuoteRow).received_utc_ms -
              (quotes[worstIdx - 1] as QuoteRow).received_utc_ms
            : null;
        trajectories.push(
          `  ${p.position_id.slice(0, 8)} ${p.mint.slice(0, 8)} ${path.padEnd(10)} ` +
            `entry_mark=${(ratios[0] as number).toFixed(3)} peak=${peak.toFixed(3)} final=${last.toFixed(4)} | ` +
            `worst single step ${(worstStep * 100).toFixed(1)}pp = ${(share * 100).toFixed(0)}% of the ` +
            `${(drawdown * 100).toFixed(1)}pp drawdown | healthy for ${healthyMarks}/${ratios.length} marks ` +
            `(${tHealthy}s) | fatal step observed over ${gapMs === null ? 'n/a' : `${(gapMs / 1000).toFixed(1)}s`}`,
        );
      }
    }

    rows.push(
      `${p.position_id.slice(0, 8)}  ${p.mint.slice(0, 8)}  ${SOL(cost)} ${SOL(finalExec)} ` +
        `${(verdict.exitValueRatio ?? NaN).toFixed(4).padStart(8)}  ${(p.exit_reason ?? 'null').padEnd(20)} ` +
        `${verdict.outcome.padEnd(24)} ${String(quotes.length).padStart(5)}  ${path}`,
    );
  }

  console.log(APPLY ? '=== BACKFILL APPLIED ===\n' : '=== DRY RUN (pass --apply to write) ===\n');
  for (const r of rows) console.log(r);
  console.log(`\n${positions.length} closed positions reclassified; ${collapseCount} liquidity collapses.`);
  if (trajectories.length > 0) {
    console.log('\nCollapse trajectories — was it unsalvageable at entry, gradual, or abrupt?');
    for (const t of trajectories) console.log(t);
  }
  db.close();
}

main();
