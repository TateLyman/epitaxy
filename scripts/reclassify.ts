import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';
import { parseImpact } from '../packages/domain/src/impact.js';
import { diagnoseExit, unverifiable } from '../packages/domain/src/exitdiagnostic.js';
import { admissible, ADMISSIBLE_TEMPLATE } from '../packages/research/src/confirmatory.js';

/**
 * P2a.1 §P1.2 — reclassify history from whatever survived.
 *
 * "Reclassify historical records from preserved raw inputs where possible.
 * Unrecoverable rows are UNVERIFIABLE."
 *
 * What survived, and what did not, is the whole story of this script. Rows
 * written before migration 7 have no raw provider payload — the derived number
 * was stored and the bytes were discarded — so a genuine re-derivation is
 * impossible for them. What they DO have is enough stored economics to say what
 * kind of event each one was:
 *
 *   route_available                 -> routeExists
 *   quoted_exit_output_lamports     -> executable sell value
 *   position_entry_cost_lamports    -> all-in cost
 *   raw_price_impact_pct            -> a signed fraction, re-read by the parser
 *   quote_received_utc_ms           -> quote age at decision time
 *
 * Two things are deliberately NOT reconstructed:
 *
 *   routeBuildable stays NULL. No build was ever attempted for these rows, and
 *   a null is the honest answer. It also means no historical row can be
 *   labelled UNBUILDABLE_EXIT, which is correct: we do not know that they were
 *   unbuildable, only that nobody asked.
 *
 *   providerFailed stays false. The old engine skipped the mark entirely on a
 *   provider outage, so a stored mark is by construction not an outage. That is
 *   a fact about the old control flow, and it is why outages are absent from
 *   the historical corpus rather than rare in it.
 *
 * Reclassifying does NOT make a row admissible. Every one of these still fails
 * `admissible()` on NO_RAW_PAYLOAD and NOT_BUILD_VALID, and the summary at the
 * end says so, so that a re-labelled corpus cannot be mistaken for a rescued
 * one.
 *
 * Idempotent: derived from immutable columns, so running it twice writes the
 * same labels.
 */

const APPLY = process.argv.includes('--apply');
const secrets = loadSecrets();
const db = new DatabaseSync(secrets.databasePath, { readOnly: !APPLY });

interface MarkRow {
  mark_id: string;
  route_available: number;
  raw_price_impact_pct: number | null;
  quoted_exit_output_lamports: string | null;
  position_entry_cost_lamports: string;
  observed_utc_ms: number;
  quote_received_utc_ms: number | null;
  diagnostic: string | null;
  raw_payload_hash: string | null;
  context_hash: string | null;
}

const marks = db
  .prepare(
    `SELECT mark_id, route_available, raw_price_impact_pct, quoted_exit_output_lamports,
            position_entry_cost_lamports, observed_utc_ms, quote_received_utc_ms,
            diagnostic, raw_payload_hash, context_hash
     FROM position_marks`,
  )
  .all() as unknown as MarkRow[];

const counts = new Map<string, number>();
const bump = (k: string): void => {
  counts.set(k, (counts.get(k) ?? 0) + 1);
};

const update = db.prepare(
  `UPDATE position_marks
   SET diagnostic = ?, diagnostic_detail = ?, diagnostic_version = ?,
       adverse_impact_bps = COALESCE(adverse_impact_bps, ?),
       favourable_impact_bps = COALESCE(favourable_impact_bps, ?),
       impact_schema_status = COALESCE(impact_schema_status, ?),
       executable_sell_value_lamports = COALESCE(executable_sell_value_lamports, ?),
       all_in_cost_lamports = COALESCE(all_in_cost_lamports, ?),
       executable_value_ratio_bps = COALESCE(executable_value_ratio_bps, ?),
       route_exists = COALESCE(route_exists, ?),
       quote_age_ms = COALESCE(quote_age_ms, ?)
   WHERE mark_id = ?`,
);

let reclassified = 0;
let alreadyLabelled = 0;
let stillInadmissible = 0;

if (APPLY) db.exec('BEGIN');
try {
  for (const m of marks) {
    if (m.diagnostic !== null) {
      alreadyLabelled += 1;
      bump(m.diagnostic);
      continue;
    }

    const cost = BigInt(m.position_entry_cost_lamports);
    const sellValue = m.quoted_exit_output_lamports === null ? null : BigInt(m.quoted_exit_output_lamports);

    // Nothing economic survived. Say so rather than guessing.
    if (cost <= 0n || (sellValue === null && m.route_available === 1)) {
      const v = unverifiable('stored row carries neither an executable sell value nor a positive entry cost');
      bump(v.diagnostic);
      if (APPLY) update.run(v.diagnostic, v.detail, v.version, null, null, null, null, cost.toString(), null, null, null, m.mark_id);
      reclassified += 1;
      continue;
    }

    // Re-read through the audited parser. The raw STRING is gone, so this is a
    // re-derivation from a stored double, not a true re-parse — recorded as
    // such by leaving `raw_impact_string` NULL.
    const impact = m.raw_price_impact_pct === null ? parseImpact({}) : parseImpact({ priceImpactPct: m.raw_price_impact_pct });

    const verdict = diagnoseExit({
      providerFailed: false,
      impact,
      routeExists: m.route_available === 1,
      routeBuildable: null,
      executableSellValueLamports: sellValue,
      allInCostLamports: cost,
      quoteAgeMs: m.quote_received_utc_ms === null ? null : m.observed_utc_ms - m.quote_received_utc_ms,
      roundTripLossBps: null,
    });

    bump(verdict.diagnostic);
    reclassified += 1;

    if (
      !admissible({
        // Historical rows: every §9.3 clause is unknown, because the mechanisms
        // that would answer them did not exist when the row was written. The
        // template supplies the SHAPE; every field is then overridden with the
        // honest null so nothing is accidentally inherited as a pass.
        ...ADMISSIBLE_TEMPLATE,
        contextHash: m.context_hash,
        dataRegimeId: null,
        rawPayloadHash: m.raw_payload_hash,
        bothLegsBuildable: null,
        diagnostic: verdict.diagnostic,
        closedUtcMs: null,
        sourceCommit: null,
        strategyConfigHash: null,
        riskPolicyHash: null,
        schemaVersion: null,
        entryRouteFamily: null,
        exitRouteFamily: null,
        entryObservationId: null,
        exitObservationId: null,
        entryRequestedAmount: null,
        entryFilledAmount: null,
        entryTransactionPolicy: null,
        exitTransactionPolicy: null,
        entrySimulation: null,
        exitSimulation: null,
        markCount: null,
        maxMarkGapMs: null,
        ataAccountingVersion: null,
        positionState: null,
        residualTokenAmount: null,
      }).admissible
    ) {
      stillInadmissible += 1;
    }

    if (APPLY) {
      update.run(
        verdict.diagnostic,
        verdict.detail,
        verdict.version,
        impact.adverseBps,
        impact.favourableBps,
        impact.status,
        sellValue === null ? null : sellValue.toString(),
        cost.toString(),
        verdict.executableValueRatioBps,
        m.route_available,
        m.quote_received_utc_ms === null ? null : m.observed_utc_ms - m.quote_received_utc_ms,
        m.mark_id,
      );
    }
  }
  if (APPLY) db.exec('COMMIT');
} catch (e) {
  if (APPLY) db.exec('ROLLBACK');
  throw e;
}

console.log(`${APPLY ? 'RECLASSIFIED' : 'DRY RUN'} — ${marks.length} marks\n`);
console.log(`  already labelled : ${alreadyLabelled}`);
console.log(`  reclassified     : ${reclassified}`);
console.log(`  still inadmissible for confirmatory results : ${stillInadmissible}\n`);

const width = Math.max(...[...counts.keys()].map((k) => k.length), 10);
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(width)}  ${v}`);
}

console.log(
  '\nRe-labelling does not rescue a row. Every historical mark still fails admissibility on\n' +
    'NO_RAW_PAYLOAD and NOT_BUILD_VALID, and remains development data.',
);
if (!APPLY) console.log('\nNothing was written. Re-run with --apply.');
db.close();
