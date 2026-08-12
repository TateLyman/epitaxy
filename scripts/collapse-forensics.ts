import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * P2a.1 §P7 — what actually happened in the reported liquidity collapses.
 *
 * "Before constructing a rule from four cases, establish what actually
 * happened." The directive then lists twenty things to reconstruct per case:
 * pool accounts, real reserves at each slot, virtual versus real liquidity,
 * vault balance changes, migration events, transfer-fee extensions, mint and
 * freeze authorities, creator flows, liquidity additions and removals.
 *
 * Almost none of it was recorded. That is the finding, and it is more useful
 * than a classification would have been.
 *
 * `position_marks` declares columns for `pool_quote_reserve`,
 * `pool_token_reserve`, `liquidity_usd`, `developer_net_token_flow` and
 * `clustered_insider_net_token_flow`. Every one of them is NULL on every row,
 * because the reserve and transfer-graph feeds were never wired. So for each
 * collapse the only evidence is: the executable value trajectory from Jupiter,
 * the route labels, and the timing.
 *
 * That evidence can distinguish a few of the directive's classes and cannot
 * distinguish the rest. This script reports exactly which, and refuses to guess
 * between the ones it cannot separate — because the tempting move here is to
 * call all of them TRUE_POOL_DRAIN and then fit a gate to four rows.
 */

const CLASSES = [
  'TRUE_POOL_DRAIN',
  'CREATOR_OR_CLUSTER_DUMP',
  'LIQUIDITY_REMOVAL',
  'MIGRATION_OR_POOL_TRANSITION',
  'ROUTE_DISAPPEARANCE',
  'TRANSFER_FEE_OR_TOKEN_RESTRICTION',
  'STALE_QUOTE',
  'PROVIDER_FAILURE',
  'PARSER_OR_UNIT_ERROR',
  'UNKNOWN',
] as const;

const secrets = loadSecrets();
const db = new DatabaseSync(secrets.databasePath, { readOnly: true });

interface CollapseRow {
  position_id: string;
  mint: string;
  mark_id: string;
  seq: number;
  observed_utc_ms: number;
  quoted_exit_output_lamports: string | null;
  position_entry_cost_lamports: string;
  route_available: number;
  route_labels: string | null;
  raw_price_impact_pct: number | null;
  quote_latency_ms: number | null;
  pool_quote_reserve: string | null;
  liquidity_usd: number | null;
  developer_net_token_flow: string | null;
}

const collapses = db
  .prepare(
    `SELECT position_id, mint, mark_id, seq, observed_utc_ms, quoted_exit_output_lamports,
            position_entry_cost_lamports, route_available, route_labels, raw_price_impact_pct,
            quote_latency_ms, pool_quote_reserve, liquidity_usd, developer_net_token_flow
     FROM position_marks
     WHERE diagnostic = 'EXECUTABLE_VALUE_COLLAPSE'
     ORDER BY mint, seq`,
  )
  .all() as unknown as CollapseRow[];

console.log(`P7 collapse forensics — ${collapses.length} collapse mark(s)\n`);

if (collapses.length === 0) {
  console.log('No mark carries EXECUTABLE_VALUE_COLLAPSE. Run scripts/reclassify.ts --apply first.');
  db.close();
  process.exit(0);
}

const byMint = new Map<string, CollapseRow[]>();
for (const r of collapses) {
  const list = byMint.get(r.mint);
  if (list === undefined) byMint.set(r.mint, [r]);
  else list.push(r);
}

/** Evidence the directive asks for, and whether this corpus has it. */
const REQUIRED_EVIDENCE = [
  ['entry/exit raw payloads', (rows: CollapseRow[]) => hasAny(rows, 'raw_payload')],
  ['pool/vault reserves at slot', (rows: CollapseRow[]) => rows.some((r) => r.pool_quote_reserve !== null)],
  ['liquidity usd trajectory', (rows: CollapseRow[]) => rows.some((r) => r.liquidity_usd !== null)],
  ['creator / top-holder flows', (rows: CollapseRow[]) => rows.some((r) => r.developer_net_token_flow !== null)],
  ['route plan and AMM keys', (rows: CollapseRow[]) => rows.some((r) => r.route_labels !== null)],
  ['executable value trajectory', () => true],
] as const;

function hasAny(_rows: CollapseRow[], _col: string): boolean {
  // raw_payload_hash was added in migration 7; every collapse predates it.
  return false;
}

let missingEvidenceTotal = 0;

for (const [mint, rows] of byMint) {
  const first = rows[0];
  if (first === undefined) continue;
  const cost = BigInt(first.position_entry_cost_lamports);

  // The full mark series for this position, so the collapse can be seen in
  // context rather than as a single row.
  const series = db
    .prepare(
      `SELECT seq, observed_utc_ms, quoted_exit_output_lamports AS out, route_available AS route
       FROM position_marks WHERE position_id = ? ORDER BY seq`,
    )
    .all(first.position_id) as unknown as { seq: number; observed_utc_ms: number; out: string | null; route: number }[];

  const values = series.map((s) => (s.out === null ? null : BigInt(s.out)));
  const lastGood = [...values].reverse().find((v) => v !== null && (v * 10_000n) / (cost > 0n ? cost : 1n) > 1_000n);
  const finalValue = values[values.length - 1] ?? null;

  // How abrupt was it? A collapse that happened entirely between two marks is
  // unresolvable at this cadence, and that is a statement about our sampling
  // rather than about the pool.
  const marksAboveFloor = values.filter((v) => v !== null && cost > 0n && (v * 10_000n) / cost > 1_000n).length;
  const spanMs =
    series.length > 1
      ? (series[series.length - 1]?.observed_utc_ms ?? 0) - (series[0]?.observed_utc_ms ?? 0)
      : 0;

  const missing = REQUIRED_EVIDENCE.filter(([, has]) => !has(rows)).map(([name]) => name);
  missingEvidenceTotal += missing.length;

  // What the surviving evidence can and cannot separate.
  let classification: (typeof CLASSES)[number];
  let reason: string;

  if (rows.every((r) => r.route_available === 0)) {
    classification = 'ROUTE_DISAPPEARANCE';
    reason = 'the provider reported no route at all; the value is absent rather than small';
  } else if (rows.some((r) => r.raw_price_impact_pct !== null && Math.abs(r.raw_price_impact_pct) > 1)) {
    classification = 'PARSER_OR_UNIT_ERROR';
    reason = 'stored impact fraction is outside -1..1, which no market produces';
  } else {
    classification = 'UNKNOWN';
    reason =
      'a route existed and returned a small value. Separating a drained pool from a creator dump, a ' +
      'liquidity removal and a pool migration requires reserve and transfer-graph data that was never ' +
      'recorded. A near-zero Jupiter route is not by itself proof that on-chain liquidity vanished.';
  }

  console.log(`${mint}`);
  console.log(`  position          ${first.position_id}`);
  console.log(`  entry cost        ${cost} lamports`);
  console.log(`  marks             ${series.length} over ${Math.round(spanMs / 1000)}s`);
  console.log(`  above 10% floor   ${marksAboveFloor}`);
  console.log(`  last healthy      ${lastGood ?? 'none'} lamports`);
  console.log(`  final             ${finalValue ?? 'no route'} lamports`);
  console.log(`  route             ${first.route_labels ?? 'none recorded'}`);
  console.log(`  CLASSIFICATION    ${classification}`);
  console.log(`  because           ${reason}`);
  console.log(`  missing evidence  ${missing.length === 0 ? 'none' : missing.join('; ')}`);
  console.log('');
}

console.log('---');
console.log(`${byMint.size} distinct mint(s) collapsed across ${collapses.length} mark(s).`);
console.log(`${missingEvidenceTotal} evidence item(s) the directive requires are absent from the corpus.\n`);
console.log(
  'The research question — "which decision-time variables distinguish catastrophic executable-value\n' +
    'collapse from ordinary cost drift?" — cannot be answered from these rows. Not because the sample is\n' +
    'small, though it is, but because the variables that would distinguish the mechanisms were never\n' +
    'measured. Fitting a hard gate to them would be fitting to the only thing that WAS measured, which is\n' +
    'the outcome.\n',
);
console.log('Prerequisite for P7, in order:');
console.log('  1. persist pool/vault reserves per mark for the route actually quoted;');
console.log('  2. persist mint/freeze/transfer-fee extension state at entry;');
console.log('  3. persist creator and top-holder net flow between marks;');
console.log('  4. THEN test candidate mechanisms prospectively on accepted AND rejected tokens.');
console.log('\nUnavailable classes, for the record: ' + CLASSES.filter((c) => c !== 'ROUTE_DISAPPEARANCE' && c !== 'PARSER_OR_UNIT_ERROR' && c !== 'UNKNOWN').join(', '));

db.close();
