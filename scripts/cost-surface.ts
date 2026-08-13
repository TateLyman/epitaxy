import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { decodeTransaction, readComputeBudget } from '../packages/solana/src/transaction.js';
import { chargedPriorityFee } from '../packages/solana/src/computebudget.js';
import { quoteLeg, quoteRoundTrip, expectedFailureCost, costBps } from '../packages/domain/src/accounting.js';

/**
 * `pnpm cost:surface` — what a leg actually costs, from real routes.
 *
 * §10. Every number here is derived from the bytes of a route built moments
 * ago, not from a config constant. The point is to replace
 * `assumedPriorityFeeLamports` with a measurement, and to show by how much the
 * assumption was wrong.
 *
 * Read-only. Nothing is signed, nothing is submitted, no wallet is funded.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIZES = [10_000_000n, 20_000_000n, 50_000_000n, 100_000_000n];

const secrets = loadSecrets();
const config = loadConfig('paper');
const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.log('PAPER_TAKER_PUBKEY is unset, so no route can be built.');
  process.exit(2);
}

const jup = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});

interface Row {
  lamports: string;
  instructions: number;
  builtins: number;
  unitPriceMicroLamports: string | null;
  explicitLimit: number | null;
  appliedLimit: number;
  limitSource: string;
  priorityFeeLamports: string;
  signatureFeeLamports: string;
  ataRentLamports: string;
  legCostLamports: string;
  legCostBps: number | null;
  roundTripCostBps: number | null;
  route: string;
}

const rows: Row[] = [];
console.log('building real routes and pricing them from their own bytes\n');

for (const amount of SIZES) {
  const built = await jup.build({ inputMint: SOL, outputMint: USDC, amount, taker });
  if (!built.buildable || built.blockhash === null) {
    console.log(`${amount} lamports: NOT BUILDABLE (${built.failure ?? 'no blockhash'})`);
    continue;
  }
  const tx = decodeTransaction(
    encodeUnsignedTransaction(compileMessage(built.instructions, taker, built.blockhash, built.lookupTables)),
  );
  const cb = readComputeBudget(tx);
  const charged = chargedPriorityFee(tx, cb);

  const signature = 5_000n * BigInt(tx.numRequiredSignatures);
  // The conservative direction: assume the ATA does not exist yet. Paper cannot
  // observe whether it does, and overstating locked capital is the safe error.
  const rent = config.assumedAtaRentLamports;

  const costs = {
    signatureFeeLamports: signature,
    priorityFeeLamports: charged.lamports,
    ataRentLamports: rent,
    broadcasterTipLamports: 0n,
    platformFeeLamports: 0n,
  };
  // No landed failures have ever been observed, because nothing has ever been
  // submitted. That is 'assumed-zero', not 'measured zero'.
  const failure = expectedFailureCost({ landedFailures: 0, total: 0 }, signature + charged.lamports, 'assumed-zero');
  const leg = quoteLeg(costs, failure);
  const rt = quoteRoundTrip({ entry: leg, exit: leg, closesAtaInExitTransaction: true, ataRentRecovered: true });

  rows.push({
    lamports: amount.toString(),
    instructions: tx.instructions.length,
    builtins: charged.limit.builtinCount,
    unitPriceMicroLamports: cb.unitPriceMicroLamports === null ? null : cb.unitPriceMicroLamports.toString(),
    explicitLimit: cb.unitLimit,
    appliedLimit: charged.limit.units,
    limitSource: charged.limit.source,
    priorityFeeLamports: charged.lamports.toString(),
    signatureFeeLamports: signature.toString(),
    ataRentLamports: rent.toString(),
    legCostLamports: leg.totalCostLamports.toString(),
    legCostBps: costBps(leg.totalCostLamports, amount),
    roundTripCostBps: costBps(rt.totalCostLamports, amount),
    route: built.routeLabels.join('+'),
  });

  console.log(
    `${String(Number(amount) / 1e9).padStart(6)} SOL  ix=${tx.instructions.length} builtin=${charged.limit.builtinCount}  ` +
      `price=${cb.unitPriceMicroLamports ?? 'none'}uL  limit=${charged.limit.units} (${charged.limit.source})  ` +
      `priority=${charged.lamports}  leg=${leg.totalCostLamports} (${costBps(leg.totalCostLamports, amount)}bps)  ` +
      `roundTrip=${costBps(rt.totalCostLamports, amount)}bps`,
  );
}

if (rows.length === 0) {
  console.log('\nno routes built, so there is nothing to price');
  process.exit(1);
}

// The comparison that matters.
const assumed = config.assumedPriorityFeeLamports;
const measured = rows.map((r) => BigInt(r.priorityFeeLamports));
const maxMeasured = measured.reduce((a, b) => (b > a ? b : a), 0n);
const minMeasured = measured.reduce((a, b) => (b < a ? b : a), measured[0] ?? 0n);

console.log(`\nassumedPriorityFeeLamports  ${assumed}`);
console.log(`measured across ${rows.length} route(s)   ${minMeasured} .. ${maxMeasured}`);
if (maxMeasured > 0n) {
  console.log(`overstatement               ${(Number(assumed) / Number(maxMeasured)).toFixed(1)}x at the dearest route`);
  const perLeg = costBps(assumed - maxMeasured, 20_000_000n);
  console.log(`phantom cost at 0.02 SOL    ${perLeg} bps per leg, ${perLeg === null ? '?' : perLeg * 2} bps per round trip`);
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/cost-surface.json',
  `${JSON.stringify(
    {
      takenAtUtcMs: Date.now(),
      note: 'priority fee derived from each route’s own bytes; the applied compute limit is the router’s explicit one or the runtime default',
      assumedPriorityFeeLamports: assumed.toString(),
      measuredMinLamports: minMeasured.toString(),
      measuredMaxLamports: maxMeasured.toString(),
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log('\nwrote artifacts/cost-surface.json');
