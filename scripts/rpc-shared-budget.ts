/**
 * `pnpm rpc:shared-budget` — the S079 endpoint budget, as it actually stands.
 *
 * The defect this reports on: `RateLimiter` is per PROCESS and the quota is per
 * ENDPOINT, so screening, trajectory collection and every research script each
 * believed it held the whole allowance. `pnpm rpc:usage` measured the
 * consequence — 48 quota refusals at 1.84 calls per active second, a rate none
 * of them individually exceeded.
 *
 * This command shows the shared buckets. A REFUSED count climbing while the
 * granted count is low is the endpoint binding; a table with no rows at all
 * means no process has leased through the shared path, which is the state the
 * repair exists to end.
 *
 * No URL and no API key appears here or in the table it reads.
 */
import { openDb } from '../packages/storage/src/db.js';
import { SharedEndpointBudget, CONSERVATIVE_LIMITS } from '../packages/adapters/src/endpoint-budget.js';
import { writeArtifact, writeNotRun, researchContext } from './_artifact.js';

const SAMPLE_QUERY = 'SELECT endpoint_key, method_family, tokens, capacity, rate_per_second, granted, refused FROM rpc_endpoint_budget';

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db' });
  try {
    const budget = new SharedEndpointBudget(db as never, CONSERVATIVE_LIMITS);
    let rows: ReturnType<SharedEndpointBudget['snapshot']> = [];
    try {
      rows = budget.snapshot();
    } catch (e) {
      console.error(`rpc_endpoint_budget is unreadable: ${(e as Error).message}`);
    }

    console.log('S079 — the endpoint-wide budget, shared across processes\n');
    console.log('configured limits:');
    console.log(`  endpoint total   ${CONSERVATIVE_LIMITS.totalRatePerSecond}/s  burst ${CONSERVATIVE_LIMITS.totalBurst}`);
    for (const [fam, spec] of Object.entries(CONSERVATIVE_LIMITS.family)) {
      console.log(`  ${fam.padEnd(16)} ${spec.ratePerSecond}/s  burst ${spec.burst}`);
    }
    console.log('');

    if (rows.length === 0) {
      console.log('no lease has been taken through the shared budget yet.');
      console.log('');
      console.log('That is NOT_RUN, and it is the pre-repair state: it means every process is');
      console.log('still spending the endpoint quota through its own local limiter, unaware of');
      console.log('the others. Start a collector built after this repair and rows appear here.');
      const p = writeNotRun('rpc-shared-budget.json', 'no rows in rpc_endpoint_budget: no process has leased through the shared path', {
        limits: CONSERVATIVE_LIMITS,
        context: researchContext(db, SAMPLE_QUERY),
      });
      console.log(`-> ${p}`);
      return;
    }

    let totalGranted = 0;
    let totalRefused = 0;
    console.log('buckets:');
    for (const r of rows) {
      totalGranted += r.granted;
      totalRefused += r.refused;
      console.log(
        `  ${r.endpointKey.padEnd(52)} ${r.methodFamily.padEnd(20)} ` +
          `tokens ${r.tokens.toFixed(2).padStart(8)}/${r.capacity}  granted ${String(r.granted).padStart(7)}  refused ${String(r.refused).padStart(6)}`,
      );
    }
    console.log('');
    console.log(`total granted ${totalGranted}   total refused ${totalRefused}`);
    if (totalRefused > 0) {
      console.log('');
      console.log('The shared budget is BINDING. That is the mechanism working — the refusals');
      console.log('were previously spent as endpoint quota errors instead. If throughput is now');
      console.log('the constraint on valid mints per day, that is the measured case for more');
      console.log('endpoint capacity, and `pnpm rpc:usage` prices it.');
    }

    const p = writeArtifact('rpc-shared-budget.json', {
      status: 'MEASURED',
      limits: CONSERVATIVE_LIMITS,
      buckets: rows,
      totalGranted,
      totalRefused,
      context: researchContext(db, SAMPLE_QUERY),
    });
    console.log(`\n-> ${p}`);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes('rpc-shared-budget')) main();
