/**
 * The remaining P18 status commands, which all answer the same shape of
 * question against different tables:
 *
 *     pnpm flow:status            the targeted stream, right now
 *     pnpm flow:coverage          which bars are COMPLETE / INCOMPLETE / ABSENT
 *     pnpm entry-clock:status     T0 vs T120 sample counts
 *     pnpm size-rule:surface      chosen sizes and what bound them
 *     pnpm fee-strata:status      population sizes per mechanics cell
 *
 * One file, five subcommands, five artifacts — each artifact still owned by
 * exactly one command, which is the Q-1 rule. Five near-identical files would
 * be five places for the same reporting bug to live.
 *
 * Every one of them reports NOT_RUN rather than zeros when its table is empty.
 * A zero-filled status report for a capability that never ran is the specific
 * failure the artifact helper exists to prevent: zeros read as a measurement.
 */
import { openDb } from '../packages/storage/src/db.js';
import { FLOW_BARS } from '../packages/intelligence/src/targeted-flow.js';
import { PRIMARY_ENTRY_CLOCKS } from '../packages/pipeline/src/entry-clocks.js';
import { CANDIDATE_SIZES_LAMPORTS } from '../packages/strategy/src/size-rule.js';
import { MICROSTRUCTURE_FEATURE_VERSION } from '../packages/intelligence/src/migration-microstructure.js';
import { writeArtifact, writeNotRun, researchContext } from './_artifact.js';

type Db = ReturnType<typeof openDb>;

function rows<T>(db: Db, sql: string, ...p: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...(p as never[])) as unknown as T[];
  } catch {
    return [];
  }
}

const FEATURE_VERSIONS = { microstructure: MICROSTRUCTURE_FEATURE_VERSION };

function flowCoverage(db: Db, artifact: boolean): void {
  const q = 'SELECT bar, coverage, COUNT(*) AS n FROM targeted_flow_bars GROUP BY bar, coverage';
  const r = rows<{ bar: string; coverage: string; n: number }>(db, q);
  const events = rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM targeted_flow_events')[0]?.n ?? 0;
  const gaps = rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM targeted_flow_gaps')[0]?.n ?? 0;

  console.log('targeted flow coverage\n');
  console.log(`  flow events stored   ${events}`);
  console.log(`  coverage gaps        ${gaps}`);
  console.log('');

  if (r.length === 0) {
    console.log('  no flow bars exist.');
    console.log('');
    console.log('  NOT_RUN, not "no flow". The targeted subscription requires Enhanced');
    console.log('  WebSockets, or the getSignaturesForAddress fallback at the entry clocks.');
    console.log('  Until one of those runs, every post-migration flow field is null and');
    console.log('  SURVIVOR_FLOW_CONTINUATION_V1 is NOT_EVALUABLE at T120 by construction.');
    if (artifact) {
      console.log(
        `-> ${writeNotRun('flow-coverage.json', 'no targeted_flow_bars rows exist', {
          barsDefined: FLOW_BARS.map((b) => b.bar),
          flowEvents: events,
          gaps,
          context: researchContext(db, q, FEATURE_VERSIONS),
        })}`,
      );
    }
    return;
  }

  for (const spec of FLOW_BARS) {
    const mine = r.filter((x) => x.bar === spec.bar);
    const total = mine.reduce((a, x) => a + x.n, 0);
    const parts = mine.map((x) => `${x.coverage}=${x.n}`).join(' ');
    console.log(`  ${spec.bar.padEnd(12)} ${String(total).padStart(5)}  ${parts}`);
  }
  if (artifact) {
    console.log(
      `\n-> ${writeArtifact('flow-coverage.json', {
        status: 'MEASURED',
        flowEvents: events,
        gaps,
        bars: r,
        context: researchContext(db, q, FEATURE_VERSIONS),
      })}`,
    );
  }
}

function flowStatus(db: Db): void {
  console.log('targeted flow — live state\n');
  const gaps = rows<{ gap_id: string; reason: string; started_utc_ms: number; ended_utc_ms: number | null }>(
    db,
    'SELECT gap_id, reason, started_utc_ms, ended_utc_ms FROM targeted_flow_gaps ORDER BY started_utc_ms DESC LIMIT 10',
  );
  const open = gaps.filter((g) => g.ended_utc_ms === null);
  console.log(`  open coverage gaps   ${open.length}`);
  for (const g of gaps) {
    console.log(
      `    ${new Date(g.started_utc_ms).toISOString()}  ${g.ended_utc_ms === null ? 'OPEN     ' : `${g.ended_utc_ms - g.started_utc_ms}ms`}  ${g.reason}`,
    );
  }
  if (gaps.length === 0) console.log('    none recorded');
  console.log('');
  flowCoverage(db, false);
}

function entryClockStatus(db: Db): void {
  const q =
    `SELECT entry_clock, mechanically_viable, COUNT(*) AS n, COUNT(DISTINCT mint) AS mints
       FROM entry_opportunities GROUP BY entry_clock, mechanically_viable`;
  const r = rows<{ entry_clock: string; mechanically_viable: number; n: number; mints: number }>(db, q);

  console.log('entry clocks — T0 versus T120, paired within a mint\n');
  if (r.length === 0) {
    console.log('  no entry opportunities recorded.');
    console.log('');
    console.log('  NOT_RUN. The collector opens at T0 today; the T120 arm requires the');
    console.log('  delayed-decision pass, and until both exist for the SAME mint there is no');
    console.log('  paired comparison — only two unpaired samples, which is the confound the');
    console.log('  pairing exists to remove.');
    console.log(
      `-> ${writeNotRun('entry-clock-status.json', 'no entry_opportunities rows exist', {
        clocksDefined: PRIMARY_ENTRY_CLOCKS,
        context: researchContext(db, q, FEATURE_VERSIONS),
      })}`,
    );
    return;
  }

  for (const clock of PRIMARY_ENTRY_CLOCKS) {
    const mine = r.filter((x) => x.entry_clock === clock);
    const total = mine.reduce((a, x) => a + x.n, 0);
    const viable = mine.filter((x) => x.mechanically_viable === 1).reduce((a, x) => a + x.n, 0);
    console.log(`  ${clock.padEnd(6)} ${String(total).padStart(5)} opportunities, ${viable} mechanically viable`);
  }

  const paired = rows<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT mint FROM entry_opportunities GROUP BY mint HAVING COUNT(DISTINCT entry_clock) >= 2)`,
  )[0]?.n ?? 0;
  console.log(`\n  mints with BOTH clocks (the paired sample): ${paired}`);
  console.log(
    `\n-> ${writeArtifact('entry-clock-status.json', {
      status: 'MEASURED',
      byClock: r,
      pairedMints: paired,
      context: researchContext(db, q, FEATURE_VERSIONS),
    })}`,
  );
}

function sizeRuleSurface(db: Db): void {
  const q =
    `SELECT candidate_lamports, admissible, bound_by, chosen, COUNT(*) AS n
       FROM size_rule_evaluations GROUP BY candidate_lamports, admissible, bound_by, chosen`;
  const r = rows<{ candidate_lamports: string; admissible: number; bound_by: string | null; chosen: number; n: number }>(db, q);

  console.log('dynamic size rule — the whole surface, not only the answer\n');
  if (r.length === 0) {
    console.log('  no size evaluations recorded.');
    console.log('');
    console.log('  NOT_RUN. Every trajectory so far was opened at the fixed notional, so the');
    console.log('  refusals attributable to an arbitrary research size cannot be separated');
    console.log('  from refusals attributable to the pool.');
    console.log(
      `-> ${writeNotRun('size-rule-surface.json', 'no size_rule_evaluations rows exist', {
        candidateSizes: CANDIDATE_SIZES_LAMPORTS.map((x) => x.toString()),
        context: researchContext(db, q, FEATURE_VERSIONS),
      })}`,
    );
    return;
  }

  for (const size of CANDIDATE_SIZES_LAMPORTS) {
    const mine = r.filter((x) => x.candidate_lamports === size.toString());
    const total = mine.reduce((a, x) => a + x.n, 0);
    const ok = mine.filter((x) => x.admissible === 1).reduce((a, x) => a + x.n, 0);
    const chosen = mine.filter((x) => x.chosen === 1).reduce((a, x) => a + x.n, 0);
    console.log(`  ${size.toString().padStart(12)} lamports  evaluated ${String(total).padStart(5)}  admissible ${String(ok).padStart(5)}  CHOSEN ${String(chosen).padStart(5)}`);
  }
  console.log('\n  binding conditions on refusal:');
  const binds: Record<string, number> = {};
  for (const x of r) if (x.admissible === 0 && x.bound_by !== null) binds[x.bound_by] = (binds[x.bound_by] ?? 0) + x.n;
  for (const [b, n] of Object.entries(binds).sort((a, b2) => b2[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${b}`);
  console.log(
    `\n-> ${writeArtifact('size-rule-surface.json', {
      status: 'MEASURED',
      evaluations: r,
      bindingConditions: binds,
      context: researchContext(db, q, FEATURE_VERSIONS),
    })}`,
  );
}

function feeStrataStatus(db: Db): void {
  const q =
    `SELECT fee_tier_stratum, cashback_stratum, mayhem_stratum, token_program_stratum, COUNT(*) AS n
       FROM mechanics_strata GROUP BY 1, 2, 3, 4`;
  const r = rows<{
    fee_tier_stratum: string;
    cashback_stratum: string;
    mayhem_stratum: string;
    token_program_stratum: string;
    n: number;
  }>(db, q);

  console.log('mechanics strata — the cells the fee schedule creates\n');
  if (r.length === 0) {
    console.log('  no strata recorded.');
    console.log('');
    console.log('  NOT_RUN. The ~190 bps vs ~50 bps round-trip difference between the bottom');
    console.log('  cashback tier and the >=420 SOL tier is a MECHANICS HYPOTHESIS from the');
    console.log('  published fee schedule. It is not an Epitaxy result and this command will');
    console.log('  not report it as one until labelled trajectories exist in both cells.');
    console.log(
      `-> ${writeNotRun('fee-strata-status.json', 'no mechanics_strata rows exist', {
        context: researchContext(db, q, FEATURE_VERSIONS),
      })}`,
    );
    return;
  }

  const cells: Record<string, number> = {};
  for (const x of r) {
    const cell = `${x.fee_tier_stratum}/${x.cashback_stratum}`;
    cells[cell] = (cells[cell] ?? 0) + x.n;
    console.log(
      `  ${x.fee_tier_stratum.padEnd(14)} ${x.cashback_stratum.padEnd(18)} ${x.mayhem_stratum.padEnd(14)} ${x.token_program_stratum.padEnd(22)} ${x.n}`,
    );
  }
  console.log('\n  fee/cashback cells:');
  for (const [c, n] of Object.entries(cells).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${c}`);
  console.log(
    `\n-> ${writeArtifact('fee-strata-status.json', {
      status: 'MEASURED',
      strata: r,
      cells,
      context: researchContext(db, q, FEATURE_VERSIONS),
    })}`,
  );
}

function main(): void {
  const cmd = process.argv[2] ?? '';
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    switch (cmd) {
      case 'flow-status':
        flowStatus(db);
        return;
      case 'flow-coverage':
        flowCoverage(db, true);
        return;
      case 'entry-clock-status':
        entryClockStatus(db);
        return;
      case 'size-rule-surface':
        sizeRuleSurface(db);
        return;
      case 'fee-strata-status':
        feeStrataStatus(db);
        return;
      default:
        // An unknown subcommand is REFUSED rather than defaulting to one of
        // them. A status command that silently reports something other than
        // what was asked for is worse than no status command.
        console.error(`unknown subcommand: "${cmd}"`);
        console.error('one of: flow-status flow-coverage entry-clock-status size-rule-surface fee-strata-status');
        process.exit(2);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('profit-discovery-status')) main();
