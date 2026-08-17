/**
 * `pnpm cashback:status` — the receivable this system has built up.
 *
 * The 8f73cef audit's I-3, the caveat inside an otherwise clean section:
 *
 *     `claimable` is hardcoded `0n` at open-trajectory.ts:1012 rather than read
 *     from the accumulator account state, so the receivable this system has
 *     built up is INVISIBLE to every surface.
 *
 * 28 settlements carried a non-zero accrual, 0 carried a claim, and the
 * accumulator had gained 10,489,020 lamports that no report could see.
 *
 * Accrued and claimable are NOT cash and do not enter PnL. Measuring them and
 * booking them are different acts, and this command does only the first.
 */
import { openDb } from '../packages/storage/src/db.js';
import { cashbackLegTotals } from '../packages/storage/src/trajectory-repo.js';
import { writeArtifact } from './_artifact.js';

function main(): void {
  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });
  try {
    const legs = cashbackLegTotals(db);
    const one = (sql: string): string => {
      try {
        const r = db.prepare(sql).get() as Record<string, unknown> | undefined;
        return String(Object.values(r ?? {})[0] ?? '0');
      } catch {
        return '0';
      }
    };

    const accrued = one(`SELECT COALESCE(SUM(CAST(cashback_accrued AS INTEGER)),0) v FROM trajectory_settlements`);
    const claimable = one(`SELECT COALESCE(SUM(CAST(cashback_claimable AS INTEGER)),0) v FROM trajectory_settlements`);
    const claimed = one(`SELECT COALESCE(SUM(CAST(cashback_claimed AS INTEGER)),0) v FROM trajectory_settlements`);
    const claimCost = one(`SELECT COALESCE(SUM(CAST(cashback_claim_cost AS INTEGER)),0) v FROM trajectory_settlements`);
    const hardcodedZero = Number(
      one(
        `SELECT COUNT(*) v FROM trajectory_settlements
          WHERE CAST(cashback_accrued AS INTEGER) > 0 AND CAST(cashback_claimable AS INTEGER) = 0`,
      ),
    );

    console.log('cashback — a receivable, measured\n');
    console.log(`  legs recorded            ${legs.legs} (${legs.cashbackCoinLegs} on cashback coins)`);
    console.log(`  buy accrued / sell accrued ${legs.buyAccrued} / ${legs.sellAccrued}`);
    console.log(`  undetermined             ${legs.undetermined}`);
    console.log(`  accumulator gained       ${legs.accumulatorGainLamports} lamports`);
    console.log('');
    console.log(`  accrued  (not cash)      ${accrued}`);
    console.log(`  CLAIMABLE (not cash)     ${claimable}`);
    console.log(`  claimed  (IS cash)       ${claimed}`);
    console.log(`  claim cost (IS a cost)   ${claimCost}`);
    console.log('');
    console.log(`  rows with accrual but ZERO claimable: ${hardcodedZero}`);
    if (hardcodedZero > 0) {
      console.log('  Some of those predate the repair, where `claimable` was the literal 0n.');
      console.log('  A post-repair row with an accrual and no claimable means the accumulator ATA');
      console.log('  was not observed — which is UNKNOWN, and unknown is not zero.');
    }
    console.log('');
    console.log('  Accrued and claimable are receivables. Adding either to realised PnL would book');
    console.log('  revenue for lamports that have not moved.');

    const path = writeArtifact('cashback-status.json', {
      legs,
      accruedLamports: accrued,
      claimableLamports: claimable,
      claimedLamports: claimed,
      claimCostLamports: claimCost,
      settlementsWithAccrualAndZeroClaimable: hardcodedZero,
      note: 'accrued and claimable are NOT cash and do not enter PnL; only claimed does',
    });
    console.log(`\n-> ${path}`);
  } finally {
    db.close();
  }
}

main();
