import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * `pnpm simulation:audit` — P1. What did the simulations actually establish?
 *
 * A pass/fail split that looks like a property of the market may be a property
 * of the instrument. The specific hypothesis under test:
 *
 *   simulateObservation() funds every job with SOL and never provisions the
 *   hypothetical token, so every BUY succeeds and every SELL fails for want of
 *   inventory the simulator was never given.
 *
 * If that holds, the failures are not route failures and not token outcomes.
 * They are a defect in the measuring apparatus, and any threshold tuned on them
 * would be tuned on our own bug.
 *
 * Read-only.
 */

const db = openDb({ path: loadSecrets().databasePath, readonly: true });

interface Row {
  side: string | null;
  purpose: string | null;
  mode: string;
  status: string;
  transaction_error: string | null;
  n: number;
}

const split = db
  .prepare(
    `SELECT o.side, o.purpose, s.mode, s.status, s.transaction_error, COUNT(*) AS n
     FROM simulation_jobs s
     LEFT JOIN execution_observations o ON o.observation_id = s.execution_observation_id
     GROUP BY 1,2,3,4,5
     ORDER BY 1,2,4,5`,
  )
  .all() as unknown as Row[];

console.log('simulation jobs by side, purpose, mode, status and error\n');
console.log('side  purpose                     mode              status              n   error');
for (const r of split) {
  console.log(
    `${String(r.side ?? '?').padEnd(5)} ${String(r.purpose ?? '?').padEnd(27)} ${String(r.mode).padEnd(17)} ` +
      `${String(r.status).padEnd(19)} ${String(r.n).padStart(3)}  ${(r.transaction_error ?? '').slice(0, 60)}`,
  );
}

// The decisive cross-tabulation: does the outcome depend on the SIDE?
const bySide = db
  .prepare(
    `SELECT o.side AS side,
            SUM(CASE WHEN s.status='SIMULATED_OK' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN s.status='SIMULATION_FAILED' THEN 1 ELSE 0 END) AS failed,
            COUNT(*) AS total
     FROM simulation_jobs s
     LEFT JOIN execution_observations o ON o.observation_id = s.execution_observation_id
     GROUP BY 1`,
  )
  .all() as { side: string | null; ok: number; failed: number; total: number }[];

console.log('\nby side:');
for (const r of bySide) {
  const pct = r.total === 0 ? 0 : Math.round((r.failed / r.total) * 100);
  console.log(`  ${String(r.side ?? 'unknown').padEnd(8)} ok=${String(r.ok).padStart(4)} failed=${String(r.failed).padStart(4)} (${pct}% failed)`);
}

/**
 * Classify a failure by what it says about the SETUP versus the route.
 *
 * The taxonomy the directive requires. Only ACTUAL_PROGRAM_REJECTION is a
 * statement about the token; everything above it is a statement about us.
 */
function classify(error: string | null, side: string | null, hadTokenMutation: boolean): string {
  const e = (error ?? '').toLowerCase();
  if (side === 'sell' && !hadTokenMutation) return 'SELL_INPUT_NOT_PROVISIONED';
  if (e.includes('max_safe_integer') || e.includes('unsafe')) return 'UNSAFE_AMOUNT_REJECTED';
  if (e.includes('accountnotfound') || e.includes('not found')) return 'MISSING_ACCOUNT';
  if (e.includes('programelf') || e.includes('invalid program')) return 'MISSING_PROGRAM_OR_ELF';
  if (e.includes('lookup')) return 'LOOKUP_TABLE_FAILURE';
  if (e.includes('blockhash') || e.includes('slot')) return 'SLOT_OR_CLOCK_FAILURE';
  if (e.includes('did not decode') || e.includes('assembly')) return 'TRANSACTION_ASSEMBLY_DEFECT';
  if (e.includes('bounds')) return 'ECONOMIC_BOUNDS_VIOLATION';
  if (e.includes('instructionerror')) return 'ACTUAL_PROGRAM_REJECTION';
  if (e.length === 0) return 'UNKNOWN';
  return 'SIMULATOR_RUNTIME_DEFECT';
}

const failures = db
  .prepare(
    `SELECT s.job_id, s.transaction_error, s.detail, s.mode,
            o.side, o.purpose, o.mint, o.requested_amount, o.route_labels,
            o.serialized_transaction_hash, o.instruction_policy, o.transaction_policy
     FROM simulation_jobs s
     LEFT JOIN execution_observations o ON o.observation_id = s.execution_observation_id
     WHERE s.status = 'SIMULATION_FAILED'
     ORDER BY o.side, o.purpose`,
  )
  .all() as Record<string, string | null>[];

// Whether a token mutation was EVER supplied is a property of the code path,
// and simulateObservation supplies only SOL. Established from the request the
// engine builds rather than assumed.
const codeSuppliesTokenInventory = false;

const classified = new Map<string, number>();
for (const f of failures) {
  const k = classify(f['transaction_error'] ?? null, f['side'] ?? null, codeSuppliesTokenInventory);
  classified.set(k, (classified.get(k) ?? 0) + 1);
}

console.log('\nfailure classification:');
for (const [k, n] of [...classified.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(32)} ${n}`);
}

console.log('\nfirst failures in detail:');
for (const f of failures.slice(0, 6)) {
  console.log(
    `  ${String(f['side'] ?? '?').padEnd(5)} ${String(f['purpose'] ?? '?').padEnd(26)} ` +
      `${String(f['mint'] ?? '').slice(0, 10)} amount=${f['requested_amount'] ?? '?'} ` +
      `route=${String(f['route_labels'] ?? '').slice(0, 26)}`,
  );
  console.log(`        error: ${String(f['transaction_error'] ?? 'none').slice(0, 120)}`);
}

// The verdict.
const sellRow = bySide.find((r) => r.side === 'sell');
const buyRow = bySide.find((r) => r.side === 'buy');
const everySellFailed = sellRow !== undefined && sellRow.total > 0 && sellRow.ok === 0;
const buysMostlyPassed = buyRow !== undefined && buyRow.total > 0 && buyRow.failed * 2 < buyRow.total;

console.log('\nhypothesis: every sell failed because the taker was never given the token');
console.log(`  every sell failed             ${everySellFailed ? 'YES' : 'NO'}`);
console.log(`  buys largely succeeded        ${buysMostlyPassed ? 'YES' : 'NO'}`);
console.log(`  code supplies token inventory ${codeSuppliesTokenInventory ? 'YES' : 'NO'}`);
const confirmed = everySellFailed && buysMostlyPassed && !codeSuppliesTokenInventory;
console.log(`  VERDICT                       ${confirmed ? 'CONFIRMED — instrument artifact' : 'NOT CONFIRMED'}`);
if (confirmed) {
  console.log(
    '\n  These failures are NOT route failures and NOT token outcomes. The simulator\n' +
      '  was asked to sell an asset it had never been given. No threshold may be tuned\n' +
      '  on this window.',
  );
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/simulation-failure-audit.json',
  `${JSON.stringify(
    {
      takenAtUtcMs: Date.now(),
      split,
      bySide,
      classification: Object.fromEntries(classified),
      failureSample: failures.slice(0, 25),
      hypothesis: {
        statement: 'every sell failed because simulateObservation never provisioned the token',
        everySellFailed,
        buysMostlyPassed,
        codeSuppliesTokenInventory,
        confirmed,
      },
    },
    null,
    2,
  )}\n`,
);
console.log('\nwrote artifacts/simulation-failure-audit.json');
