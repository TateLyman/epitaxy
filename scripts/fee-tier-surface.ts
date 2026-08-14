/**
 * P14 — the fee-tier boundaries the parity matrix never straddled.
 *
 * Offline: it reads the fee config bytes already captured in the round-trip
 * fixture. The point is to say, in numbers, what the size surface's flat
 * 241.5 bps does and does not mean.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { feeTiersOf, flatFeeOf, boundaries, floorRange, tierFor } from '../packages/solana/src/fee-tiers.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

const FIXTURE = 'tests/fixtures/pumpswap-selfimpact.json';
/** What the size surface measured, from artifacts/true-stateful-size-surface.json. */
const MEASURED_DRAG_BPS = 241.5;

const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  mint: string;
  pool: string;
  preBuy: { pubkey: string; owner: string; dataBase64: string }[];
};
const feeAddr = PUMP_AMM_FEE_CONFIG_PDA.toBase58();
const raw = f.preBuy.find((x) => x.pubkey === feeAddr);
if (raw === undefined) {
  console.error(`the fee config (${feeAddr}) is not in the captured fixture`);
  process.exit(1);
}

const sdk = new PumpAmmSdk();
const cfg = sdk.decodeFeeConfig({
  owner: new PublicKey(raw.owner),
  data: Buffer.from(raw.dataBase64, 'base64'),
  lamports: 1,
  executable: false,
  rentEpoch: 0,
});

const tiers = feeTiersOf(cfg);
const flat = flatFeeOf(cfg);
const steps = boundaries(tiers);
const range = floorRange(tiers);

const SOL = 1_000_000_000n;
const summary = {
  provenance: currentProvenance({ strategyVersion: 'delayed-momentum-v0.6.0', schemaVersion: 'schema-v34' }),
  source: `fee config ${feeAddr}, from the bytes captured in ${FIXTURE}`,
  flatFee: flat,
  tiers: tiers.map((t) => ({
    marketCapThresholdLamports: t.marketCapLamportsThreshold.toString(),
    marketCapThresholdSol: Number(t.marketCapLamportsThreshold / SOL),
    ...t.fees,
    roundTripBps: t.roundTripBps,
  })),
  boundaries: steps.map((b) => ({
    marketCapLamports: b.marketCapLamports.toString(),
    marketCapSol: Number(b.marketCapLamports / SOL),
    belowRoundTripBps: b.belowRoundTripBps,
    aboveRoundTripBps: b.aboveRoundTripBps,
    stepBps: b.stepBps,
  })),
  mechanicsFloorRange: range,
  measuredDragBps: MEASURED_DRAG_BPS,
  /**
   * The correction this artifact exists to make.
   *
   * The size surface's drag is flat in SIZE and a step function across TOKENS.
   * Reading 241.5 bps as a constant of the venue would calibrate a mechanics
   * gate on whichever tier the sampled mints happened to occupy.
   */
  reading:
    range === null
      ? 'the fee config carries no tier table'
      : `the round-trip fee ranges from ${range.minBps} to ${range.maxBps} bps across ${tiers.length} tiers ` +
        `(a spread of ${range.spreadBps} bps). The size surface measured ${MEASURED_DRAG_BPS} bps, which is one ` +
        'point in that range and not a constant of the venue.',
  parityGap:
    steps.length === 0
      ? 'no boundary exists to straddle'
      : `${steps.length} boundaries exist and the parity matrix straddled none of them: every sampled mint sat ` +
        'inside a single tier, so the step itself is untested',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/fee-tier-surface.json', JSON.stringify(summary, null, 2));

console.log(`flat fee: lp ${flat.lpFeeBps} + protocol ${flat.protocolFeeBps} + creator ${flat.creatorFeeBps} = ${flat.totalBps} bps\n`);
console.log('tier   marketCap (SOL)      lp  proto  creator   leg   roundTrip');
for (const t of tiers.slice(0, 14)) {
  console.log(
    `      ${String(Number(t.marketCapLamportsThreshold / SOL)).padStart(16)}  ` +
      `${String(t.fees.lpFeeBps).padStart(3)}  ${String(t.fees.protocolFeeBps).padStart(5)}  ` +
      `${String(t.fees.creatorFeeBps).padStart(7)}  ${String(t.fees.totalBps).padStart(4)}  ${String(t.roundTripBps).padStart(9)}`,
  );
}
if (tiers.length > 14) console.log(`      ... ${tiers.length - 14} more tiers`);

console.log(`\nboundaries: ${steps.length}`);
for (const b of steps.slice(0, 5)) {
  console.log(`  at ${Number(b.marketCapLamports / SOL)} SOL market cap: ${b.belowRoundTripBps} -> ${b.aboveRoundTripBps} bps (${b.stepBps})`);
}

console.log(`\n${summary.reading}`);
console.log(summary.parityGap);

// Where the mint in the fixture actually sits, when its cap can be inferred.
const example = tierFor(tiers, 500n * SOL);
if (example !== null) {
  console.log(`\na pool at 500 SOL market cap pays ${example.roundTripBps} bps per round trip`);
}
console.log('\nartifacts/fee-tier-surface.json');
