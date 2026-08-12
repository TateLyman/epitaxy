import { writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { WSOL_MINT } from '../packages/domain/src/types.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import {
  evaluateInstructionPolicy,
  instructionPolicyLimits,
  policyStatusLabel,
} from '../packages/solana/src/instructionpolicy.js';
import { roundTripCostLamports, viableFloorLamports } from '../packages/strategy/src/portfolio.js';
import { formatAmount } from '../packages/domain/src/amounts.js';

/**
 * P2a.1 §P6 — the size surface.
 *
 * "Do not choose virtual NAV merely to make the strategy trade."
 *
 * Paper NAV was raised to ~5.7 SOL so that the sizing function could clear a
 * 0.0286 SOL viability floor, and the first paper entry was 0.0486 SOL. The
 * canary cap is the smaller of 0.02 SOL and 0.10% of NAV. A result proven at
 * 0.05 SOL therefore validates nothing about the size we would actually deploy
 * at, and the direction of the error is the bad one: impact and round-trip cost
 * are worse at small size, not better, so a large-size result flatters a small
 * one.
 *
 * This measures the seven notionals the directive names, at both legs, right
 * now, on a live route:
 *
 *   buy buildability, sell buildability, round-trip route loss, actual feeBps,
 *   impact, ATA/rent burden as a fraction of notional, route survival.
 *
 * What it does NOT produce, and will not fake: expected net return, expected
 * log growth, maximum drawdown, tail loss. Those are properties of a
 * DISTRIBUTION of outcomes, and this system has zero build-valid completed
 * trades. Reporting them from a spot measurement of one token would be exactly
 * the fabrication the project rules forbid. They are emitted as null with the
 * reason attached.
 *
 * Also emitted: the minimum bankroll each notional requires under the FROZEN
 * risk policy, so the temptation to solve an uneconomic small trade by assuming
 * a bigger wallet is visible as a number rather than available as a config edit.
 */

const SIZES_SOL = ['0.005', '0.010', '0.020', '0.030', '0.050', '0.075', '0.100'] as const;
const CANARY_CAP_LAMPORTS = 20_000_000n; // 0.02 SOL, the master canary cap.

const config = loadConfig(modeFromArgv() ?? 'paper');
const secrets = loadSecrets();

if (secrets.paperTakerPubkey === null) {
  console.error('PAPER_TAKER_PUBKEY is unset; buildability cannot be measured at any size.');
  process.exit(1);
}
const taker = secrets.paperTakerPubkey;

const db = new DatabaseSync(secrets.databasePath, { readOnly: true });

/**
 * The subject. Chosen as the most recently quoted mint that had a live route,
 * because a surface measured on a token nobody would have traded says nothing
 * about the sizes we would trade at.
 */
const argMint = process.argv.find((a) => a.startsWith('--mint='))?.slice('--mint='.length);
const picked =
  argMint ??
  (
    db
      .prepare(
        `SELECT mint FROM quotes
         WHERE side = 'sell' AND CAST(out_amount AS INTEGER) > 0
         ORDER BY requested_utc_ms DESC LIMIT 1`,
      )
      .get() as { mint: string } | undefined
  )?.mint;

if (picked === undefined) {
  console.error('no recently quoted mint with a live route; pass --mint=<address>');
  process.exit(1);
}
const MINT = picked;
db.close();

const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });

interface Row {
  sizeSol: string;
  lamports: string;
  buyRouteExists: boolean;
  buyBuildable: boolean | null;
  buyPolicy: string | null;
  buyInstructions: number | null;
  sellRouteExists: boolean;
  sellBuildable: boolean | null;
  sellPolicy: string | null;
  roundTripLossBps: number | null;
  actualFeeBps: number | null;
  buyImpactStatus: string;
  buyAdverseImpactBps: number | null;
  sellAdverseImpactBps: number | null;
  rentBurdenBps: number | null;
  fixedCostBps: number | null;
  aboveViableFloor: boolean;
  withinCanaryCap: boolean;
  minBankrollLamports: string;
  minBankrollSol: string;
  note: string;
}

/**
 * Smallest NAV at which the frozen risk policy would actually size this
 * notional. Derived from the binding cap rather than assumed: sizing is capped
 * by `maxNotionalPctPerPosition` of NAV, so NAV must be at least
 * notional / (pct/100).
 */
function minBankroll(notional: bigint): bigint {
  const pct = config.risk.maxNotionalPctPerPosition;
  if (pct <= 0) return 0n;
  const byNotionalCap = (notional * 10_000n) / BigInt(Math.round(pct * 100));
  // And the reserve floor has to be payable on top of it.
  return byNotionalCap + config.risk.minSolReserveLamports;
}

async function measure(sizeSol: string): Promise<Row> {
  const lamports = BigInt(Math.round(Number(sizeSol) * 1e9));
  const viable = viableFloorLamports(config);
  const fixed = roundTripCostLamports(config);

  const buy = await jupiter.tryQuote({
    inputMint: WSOL_MINT,
    outputMint: MINT,
    amount: lamports,
    slippageBps: config.risk.maxSlippageBps,
    priority: 'risk',
  });

  const row: Row = {
    sizeSol,
    lamports: lamports.toString(),
    buyRouteExists: buy.quote !== null && buy.quote.outAmount > 0n,
    buyBuildable: null,
    buyPolicy: null,
    buyInstructions: null,
    sellRouteExists: false,
    sellBuildable: null,
    sellPolicy: null,
    roundTripLossBps: null,
    actualFeeBps: buy.quote?.platformFeeBps ?? null,
    buyImpactStatus: buy.quote?.impact.status ?? 'NO_QUOTE',
    buyAdverseImpactBps: buy.quote?.impact.adverseBps ?? null,
    sellAdverseImpactBps: null,
    rentBurdenBps: Number((config.assumedAtaRentLamports * 10_000n) / lamports),
    fixedCostBps: Number((fixed * 10_000n) / lamports),
    aboveViableFloor: lamports >= viable,
    withinCanaryCap: lamports <= CANARY_CAP_LAMPORTS,
    minBankrollLamports: minBankroll(lamports).toString(),
    minBankrollSol: formatAmount(minBankroll(lamports), 9),
    note: '',
  };

  if (buy.providerFailure !== null) {
    row.note = `provider failure on the buy leg (${buy.providerFailure.kind}); this row measures the provider, not the size`;
    return row;
  }
  if (buy.quote === null || buy.quote.outAmount === 0n) {
    row.note = 'no buy route at this size';
    return row;
  }

  const buyBuild = await jupiter.build({
    inputMint: WSOL_MINT,
    outputMint: MINT,
    amount: lamports,
    taker,
    slippageBps: config.risk.maxSlippageBps,
    priority: 'risk',
  });
  if (buyBuild !== null) {
    row.buyBuildable = buyBuild.buildable;
    row.buyInstructions = buyBuild.instructionCount;
    if (buyBuild.buildable && buyBuild.instructions.length > 0) {
      row.buyPolicy = policyStatusLabel(
        evaluateInstructionPolicy(buyBuild.instructions, instructionPolicyLimits(taker, config.risk.maxPriorityFeeLamports)),
      );
    }
  }

  // The sell leg is measured for exactly what the buy would have produced —
  // not for a round number — because that is the amount we would have to sell.
  const sell = await jupiter.tryQuote({
    inputMint: MINT,
    outputMint: WSOL_MINT,
    amount: buy.quote.outAmount,
    slippageBps: config.risk.maxSlippageBps,
    priority: 'risk',
  });
  row.sellRouteExists = sell.quote !== null && sell.quote.outAmount > 0n;
  row.sellAdverseImpactBps = sell.quote?.impact.adverseBps ?? null;
  if (sell.quote !== null && sell.quote.outAmount > 0n) {
    row.roundTripLossBps = Number(((lamports - sell.quote.outAmount) * 10_000n) / lamports);
    const sellBuild = await jupiter.build({
      inputMint: MINT,
      outputMint: WSOL_MINT,
      amount: buy.quote.outAmount,
      taker,
      slippageBps: config.risk.maxSlippageBps,
      priority: 'risk',
    });
    if (sellBuild !== null) {
      row.sellBuildable = sellBuild.buildable;
      if (sellBuild.buildable && sellBuild.instructions.length > 0) {
        row.sellPolicy = policyStatusLabel(
          evaluateInstructionPolicy(
            sellBuild.instructions,
            instructionPolicyLimits(taker, config.risk.maxPriorityFeeLamports),
          ),
        );
      }
    }
  } else {
    row.note = 'no sell route for the amount the buy would produce — a buy route without a sell route is not a trade';
  }

  return row;
}

const rows: Row[] = [];
for (const s of SIZES_SOL) {
  process.stderr.write(`measuring ${s} SOL...\n`);
  rows.push(await measure(s));
}

const artifact = {
  generatedUtc: new Date().toISOString(),
  mint: MINT,
  taker,
  strategyVersion: config.strategyVersion,
  canaryCapLamports: CANARY_CAP_LAMPORTS.toString(),
  viableFloorLamports: viableFloorLamports(config).toString(),
  sampleSize: 1,
  caveat:
    'ONE token, ONE instant. This is a spot measurement of the cost surface, not a distribution. ' +
    'Expected net return, expected log growth, maximum drawdown and tail loss are NOT reported because ' +
    'no build-valid completed trade exists to estimate them from; reporting them here would be fabrication.',
  notReported: ['expectedNetReturn', 'expectedLogGrowth', 'maximumDrawdown', 'tailLossCvar5'],
  rows,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/size-surface.json', JSON.stringify(artifact, null, 2));

console.log(`\nP6 size surface — ${MINT}\n`);
const h = ['size', 'buyRoute', 'buyBuild', 'sellRoute', 'sellBuild', 'rtLossBps', 'feeBps', 'rentBps', 'fixedBps', 'canary', 'minNAV'];
console.log(h.map((x) => x.padEnd(10)).join(''));
for (const r of rows) {
  console.log(
    [
      r.sizeSol,
      String(r.buyRouteExists),
      String(r.buyBuildable),
      String(r.sellRouteExists),
      String(r.sellBuildable),
      r.roundTripLossBps === null ? '-' : String(r.roundTripLossBps),
      r.actualFeeBps === null ? '-' : String(r.actualFeeBps),
      String(r.rentBurdenBps),
      String(r.fixedCostBps),
      r.withinCanaryCap ? 'yes' : 'NO',
      r.minBankrollSol,
    ]
      .map((x) => String(x).padEnd(10))
      .join(''),
  );
  if (r.note !== '') console.log(`           note: ${r.note}`);
}

console.log(`\nwritten to artifacts/size-surface.json`);
console.log(
  '\nRead the rentBps and fixedBps columns first. They are the non-recoverable overhead as a fraction of\n' +
    'the trade, and they are what makes a small notional uneconomic regardless of how right the thesis is.\n' +
    `The canary cap is ${formatAmount(CANARY_CAP_LAMPORTS, 9)} SOL, so only the rows marked "yes" say anything about canary.`,
);
