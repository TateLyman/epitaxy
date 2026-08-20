/**
 * What capital does this bot actually need, by its OWN arithmetic?
 *
 * Not a guess. `packages/strategy/src/portfolio.ts` already defines the fee-viability
 * floor, and `scripts/doctor.ts` already defines the capital that clears it:
 *
 *     roundTripCost = (signatureFee + priorityFee) * 2 + ataRent * (1 - rentRecovery)
 *     viableFloor   = roundTripCost * 10_000 / maxFeeFractionBps
 *     capital       = viableFloor * 100 / maxNotionalPctPerPosition
 *
 * Note what the floor deliberately does NOT charge: the full ATA rent. Rent comes back
 * when the token account is closed, so on a successful exit it is a lockup and not a cost.
 * It is only lost when the position cannot be sold at all, because an account holding a
 * nonzero balance cannot be closed. Charging it in full overstated the floor by about an
 * order of magnitude and made every valid trade look unviable.
 *
 * This also reports the SECOND binding constraint, which the floor does not model: the
 * venue fee. MT115 established that a cashback pool charges roughly 120 bps gross a round
 * trip and returns the creator leg only if the rebate is claimed, and the cost census put
 * the round trip at p50 60 bps and p95 240. A position must clear THAT too.
 */
import { loadConfig } from '../packages/domain/src/config.js';
import { viableFloorLamports, roundTripCostLamports } from '../packages/strategy/src/portfolio.js';

const SOL = 1e9;
const f = (n: bigint | number): string => (Number(n) / SOL).toFixed(6);

for (const mode of ['canary', 'live'] as const) {
  let config;
  try {
    config = loadConfig(mode);
  } catch (e) {
    console.log(`\n=== ${mode.toUpperCase()} === could not load: ${(e as Error).message}\n`);
    continue;
  }
  const rt = roundTripCostLamports(config);
  const floor = viableFloorLamports(config);
  const pct = config.risk.maxNotionalPctPerPosition;
  const capitalForOne = (Number(floor) * 100) / pct;

  console.log(`\n=== ${mode.toUpperCase()} ===`);
  console.log(`  signature fee / tx      ${f(config.assumedSignatureFeeLamports)} SOL`);
  console.log(`  priority fee / tx       ${f(config.assumedPriorityFeeLamports)} SOL`);
  console.log(`  ATA rent                ${f(config.assumedAtaRentLamports)} SOL  (recovery ${(config.assumedRentRecoveryRate * 100).toFixed(1)}%)`);
  console.log(`  -> non-recoverable round-trip cost ${f(rt)} SOL`);
  console.log(`  max fee fraction        ${config.maxFeeFractionBps} bps of notional`);
  console.log(`  -> VIABILITY FLOOR per position    ${f(floor)} SOL`);
  console.log(`  max notional per position ${pct}% of NAV`);
  console.log(`  -> MINIMUM CAPITAL to open ONE position: ${(capitalForOne / SOL).toFixed(4)} SOL`);
  console.log(`  max simultaneous positions ${config.risk.maxSimultaneousPositions}`);
  console.log(`  -> capital to use every slot:            ${((capitalForOne * config.risk.maxSimultaneousPositions) / SOL).toFixed(4)} SOL`);
  console.log(`  configured maxEntry ${f(config.risk.maxEntryLamports)} SOL   totalCap ${f(config.risk.maxTotalExposureLamports)} SOL`);
  console.log(`  stop loss ${config.exits.stopLossBps} bps   risk budget ${config.risk.riskBudgetPctPerTrade}% per trade`);
}

console.log('\nTHE FLOOR IS NOT THE WHOLE COST. It counts only chain-level fixed costs.');
console.log('The VENUE fee is separate and larger: round trip p50 60 bps, p95 240 bps, and on a');
console.log('cashback pool about 120 bps gross of which the creator leg returns ONLY if claimed.');
console.log('A position must clear both, and no edge this programme has measured exceeds 50 bps.');
