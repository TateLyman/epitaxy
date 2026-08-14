/**
 * Read the measured settlement off live rows and say whether it is PnL-eligible.
 *
 * Not a test double: this reads the production database through the same
 * `measuredSettlementOf` the paper loop calls. If this disagrees with the
 * engine, one of them is deriving the trade a second way, which is the defect
 * the settlement module exists to make impossible.
 */
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { measuredSettlementOf } from '../packages/storage/src/settlement-repo.js';
import { isPnlEligible, acquiredTokens, entryCashOut, immediateRoundTrip } from '../packages/domain/src/settlement.js';

const sinceMs = Number(process.argv[2] ?? Date.now() - 3_600_000);
const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const taker = secrets.paperTakerPubkey;
if (taker === null || taker === undefined) throw new Error('no paper taker pubkey configured');

const rows = db
  .prepare(
    `SELECT s.job_id, s.execution_observation_id o, o.side, o.mint
     FROM simulation_jobs s JOIN execution_observations o ON o.observation_id = s.execution_observation_id
     WHERE s.requested_utc_ms > ? AND s.simulated_effect_ok = 1
     ORDER BY s.requested_utc_ms`,
  )
  .all(sinceMs) as { job_id: string; o: string; side: string; mint: string }[];

console.log(`${rows.length} effect-verified leg(s) since ${new Date(sinceMs).toISOString()}\n`);

const settlements = [];
for (const r of rows) {
  const s = measuredSettlementOf(db, r.o, r.job_id, taker);
  if (s === null) {
    console.log(`${r.side} ${r.mint.slice(0, 10)}: NO SETTLEMENT`);
    continue;
  }
  const e = isPnlEligible(s);
  console.log(`${r.side.padEnd(4)} ${r.mint.slice(0, 10)}  family=${s.family}`);
  console.log(`  complete=${s.complete} effectValid=${s.effectValid} coverage=${s.fullAccountCoverage} pnlEligible=${e.ok}`);
  console.log(`  input  ${s.input.kind} ${s.input.kind === 'native_sol' ? `trade=${s.input.actualTradeDebitLamports} total=${s.input.totalPayerDebitLamports}` : `debit=${s.input.actualDebitAtoms}`}`);
  console.log(`  output ${s.output.kind} ${s.output.kind === 'native_sol' ? `credit=${s.output.actualCreditLamports} min=${s.output.minimumLamports}` : `credit=${s.output.actualCreditAtoms} min=${s.output.minimumAtoms}`}`);
  console.log(`  fees base=${s.costs.baseFeeLamports} prio=${s.costs.priorityFeeLamports} rentCreated=${s.costs.rentCreatedLamports} rentBack=${s.costs.rentRecoveredLamports} unexplained=${s.costs.unexplainedLamports}`);
  if (!e.ok) console.log(`  NOT ELIGIBLE: ${e.reasons.join(' | ')}`);
  if (s.side === 'buy' && s.output.kind === 'token') {
    console.log(`  acquired=${acquiredTokens(s)} vs router floor ${s.output.minimumAtoms} (delta ${acquiredTokens(s) - s.output.minimumAtoms})`);
    console.log(`  cashOut=${entryCashOut(s).cashOut} lockedRent=${entryCashOut(s).lockedRent}`);
  }
  console.log();
  settlements.push(s);
}

const buy = settlements.find((s) => s.side === 'buy');
const sell = settlements.find((s) => s.side === 'sell');
if (buy && sell) {
  const rt = immediateRoundTrip(buy, sell);
  console.log('immediate round trip from two MEASURED settlements:');
  console.log(`  cashOut=${rt.cashOutLamports} cashIn=${rt.cashInLamports} net=${rt.netLamports} complete=${rt.complete}`);
  console.log(`  all-in lossBps=${rt.lossBps}  (counts rent as a cost)`);
  console.log(`  TRADING lossBps=${rt.tradingLossBps}  rent locked=${rt.recoverableRentLamports}  <- what the cap gates on`);
  if (!rt.complete) console.log(`  ${rt.reasons.join(' | ')}`);
}
db.close();
