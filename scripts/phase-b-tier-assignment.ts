/**
 * `pnpm tier:assign` — the tier × age table that does not currently exist.
 *
 * §1.2 of the Phase B directive. For every stored snapshot: the SOL-denominated
 * market cap, the fee tier that would have applied, and the token's age. Then
 * the joint distribution of tier against age band, and the question the phase
 * turns on — what fraction of mints reach tier 2 or better while still inside
 * the 2m-60m window, and how many of those arrive per day.
 *
 * THE MEASUREMENT PROBLEM, AND HOW IT IS HANDLED
 *
 * The fee tier is selected by the SDK's own market cap:
 *
 *     marketCap = effectiveQuoteReserve × baseMintSupply / baseReserve
 *
 * which needs pool reserves. Reserves exist for 413 stored snapshots over 142
 * pools. The corpus has 837,876 snapshots over 158,085 mints, and for those the
 * only market-cap-shaped quantity is the provider's `mcap`, in USD.
 *
 * So the assignment is made from `mcap / solUsd`, and the two are CROSS-CHECKED
 * against each other on the 413-snapshot overlap where both exist. That check is
 * reported first, because if the provider's market cap and the program's market
 * cap disagree by more than a tier width, every tier in this artifact is a
 * different quantity wearing the tier's name.
 *
 * Read-only, offline. No network call, nothing signed, nothing funded.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { feeTiersOf, flatFeeOf, feeConfigHash, selectFeeTier, poolMarketCapLamports } from '../packages/solana/src/fee-tiers.js';
import { accountSourceOf, poolFactsFrom } from '../packages/solana/src/pumpswap-offline.js';
import { deriveSolUsd, solUsdAt } from '../packages/research/src/sol-usd.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

/** §16 of 4890af0, unchanged, plus the band below the tradable window. */
const AGE_BANDS: readonly { key: string; loMs: number; hiMs: number }[] = [
  { key: '<2m', loMs: 0, hiMs: 2 * 60_000 },
  { key: '2m-60m', loMs: 2 * 60_000, hiMs: 60 * 60_000 },
  { key: '1h-5h', loMs: 3_600_000, hiMs: 5 * 3_600_000 },
  { key: '5h-24h', loMs: 5 * 3_600_000, hiMs: 24 * 3_600_000 },
  { key: '24h-7d', loMs: 24 * 3_600_000, hiMs: 7 * 24 * 3_600_000 },
  { key: '>7d', loMs: 7 * 24 * 3_600_000, hiMs: Number.POSITIVE_INFINITY },
];
/** The row-level schema the directive names, capped so the artifact stays readable. */
const ROW_SAMPLE_TARGET = 2_000;

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');
const sdk = new PumpAmmSdk();
const feeAddr = PUMP_AMM_FEE_CONFIG_PDA.toBase58();

interface StoredAccount {
  pubkey: string;
  owner: string;
  dataBase64: string | null;
  lamports: string | number;
}

// ---------------------------------------------------------------------------
// 1 — THE SCHEDULE, RE-DECODED AND CHECKED AGAINST §1.1's ARTIFACT
// ---------------------------------------------------------------------------

const oneSnapshot = db
  .prepare(
    `SELECT mint, pool, manifest_blob_sha256 AS manifest FROM coherent_snapshots ORDER BY captured_utc_ms DESC LIMIT 1`,
  )
  .get() as { mint: string; pool: string; manifest: string } | undefined;
if (oneSnapshot === undefined) {
  console.error('no coherent snapshot is stored, so no fee config can be decoded');
  process.exit(1);
}
const accountsForSchedule = evidence.get<StoredAccount[]>(oneSnapshot.manifest);
const rawFee = accountsForSchedule.find((a) => a.pubkey === feeAddr);
if (rawFee === undefined || rawFee.dataBase64 === null) {
  console.error(`the fee config ${feeAddr} is not in the stored snapshot`);
  process.exit(1);
}
const cfg = sdk.decodeFeeConfig({
  owner: new PublicKey(rawFee.owner),
  data: Buffer.from(rawFee.dataBase64, 'base64'),
  lamports: Number(rawFee.lamports),
  executable: false,
  rentEpoch: 0,
});
const tiers = feeTiersOf(cfg);
const scheduleHash = feeConfigHash(tiers, flatFeeOf(cfg));

const SCHEDULE_ARTIFACT = 'artifacts/fee-tier-schedule.json';
let scheduleAgreesWithArtifact: boolean | null = null;
if (existsSync(SCHEDULE_ARTIFACT)) {
  const prior = JSON.parse(readFileSync(SCHEDULE_ARTIFACT, 'utf8')) as {
    scheduleHashes: { hash: string }[];
  };
  scheduleAgreesWithArtifact = prior.scheduleHashes.some((h) => h.hash === scheduleHash);
}

const tierIndexFor = (marketCapLamports: bigint): { index: number; oneWayBps: number } | null => {
  const t = selectFeeTier(tiers, marketCapLamports);
  if (t === null) return null;
  const i = tiers.findIndex((x) => x.marketCapLamportsThreshold === t.marketCapLamportsThreshold);
  return { index: i, oneWayBps: t.roundTripBps / 2 };
};

// ---------------------------------------------------------------------------
// 2 — THE CROSS-CHECK: PROVIDER MARKET CAP AGAINST THE PROGRAM'S
// ---------------------------------------------------------------------------

const solUsd = deriveSolUsd(db);
const nearestSnapshot = db.prepare(
  `SELECT taken_utc_ms AS t, json_extract(features_json, '$.mcap') AS mcap,
          ABS(taken_utc_ms - ?) AS gap
     FROM decision_snapshots
    WHERE mint = ? AND json_extract(features_json, '$.mcap') IS NOT NULL
    ORDER BY gap ASC LIMIT 1`,
);

interface CrossCheck {
  mint: string;
  capturedUtcMs: number;
  programMarketCapSol: number;
  providerMarketCapSol: number;
  ratioProviderOverProgram: number;
  programTierIndex: number | null;
  providerTierIndex: number | null;
  sameTier: boolean;
  gapMs: number;
}
const crossChecks: CrossCheck[] = [];
let crossCheckSkipped = 0;

for (const s of db
  .prepare(
    `SELECT mint, pool, captured_utc_ms AS captured, manifest_blob_sha256 AS manifest FROM coherent_snapshots`,
  )
  .all() as { mint: string; pool: string; captured: number; manifest: string }[]) {
  try {
    const accounts = evidence.get<StoredAccount[]>(s.manifest);
    const src = accountSourceOf(
      accounts.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: typeof a.lamports === 'string' ? BigInt(a.lamports) : BigInt(Math.trunc(a.lamports)),
      })),
    );
    const facts = poolFactsFrom(src, s.pool);
    if (facts.baseMintSupplyAtoms === null) {
      crossCheckSkipped += 1;
      continue;
    }
    const programCap = poolMarketCapLamports({
      quoteReserveLamports: facts.quoteReserveRaw + facts.virtualQuoteReserves,
      baseReserveAtoms: facts.baseReserve,
      baseMintSupplyAtoms: facts.baseMintSupplyAtoms,
    });
    const near = nearestSnapshot.get(s.captured, s.mint) as { t: number; mcap: number; gap: number } | undefined;
    const rate = solUsdAt(solUsd, s.captured);
    if (near === undefined || rate === null || near.gap > 600_000) {
      crossCheckSkipped += 1;
      continue;
    }
    const providerCapSol = near.mcap / rate;
    const programCapSol = Number(programCap) / 1e9;
    const programTier = tierIndexFor(programCap);
    const providerTier = tierIndexFor(BigInt(Math.round(providerCapSol * 1e9)));
    crossChecks.push({
      mint: s.mint,
      capturedUtcMs: s.captured,
      programMarketCapSol: programCapSol,
      providerMarketCapSol: providerCapSol,
      ratioProviderOverProgram: programCapSol === 0 ? Number.POSITIVE_INFINITY : providerCapSol / programCapSol,
      programTierIndex: programTier?.index ?? null,
      providerTierIndex: providerTier?.index ?? null,
      sameTier: (programTier?.index ?? -1) === (providerTier?.index ?? -2),
      gapMs: near.gap,
    });
  } catch {
    crossCheckSkipped += 1;
  }
}

const ratios = crossChecks.map((c) => c.ratioProviderOverProgram).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
const q = (xs: readonly number[], p: number): number | null =>
  xs.length === 0 ? null : (xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))] as number);

// ---------------------------------------------------------------------------
// 3 — ASSIGN A TIER TO EVERY STORED SNAPSHOT
// ---------------------------------------------------------------------------

interface Row {
  mint: string;
  snapshot_ts: number;
  market_cap_sol: number;
  tier_index: number;
  total_fee_bps: number;
  age_seconds: number;
}

const bandOf = (ageMs: number): string =>
  AGE_BANDS.find((b) => ageMs >= b.loMs && ageMs < b.hiMs)?.key ?? 'unbanded';

const jointSnapshots = new Map<string, number>();
const jointMints = new Map<string, Set<string>>();
/** Best tier each mint reached inside each band, so a mint is counted once. */
const bestTierInBand = new Map<string, Map<string, number>>();
const firstDayInBand = new Map<string, Map<string, string>>();
const rowSample: Row[] = [];
let rowsTotal = 0;
let noMcap = 0;
let noRate = 0;
let noTier = 0;

const cursor = db
  .prepare(
    `SELECT mint, taken_utc_ms AS t, token_age_ms AS age,
            json_extract(features_json, '$.mcap') AS mcap
       FROM decision_snapshots
      WHERE token_age_ms IS NOT NULL`,
  )
  .iterate() as Iterable<{ mint: string; t: number; age: number; mcap: number | null }>;

let seen = 0;
for (const r of cursor) {
  seen += 1;
  if (r.mcap === null || !(r.mcap > 0)) {
    noMcap += 1;
    continue;
  }
  const rate = solUsdAt(solUsd, r.t);
  if (rate === null) {
    noRate += 1;
    continue;
  }
  const capSol = r.mcap / rate;
  const tier = tierIndexFor(BigInt(Math.round(capSol * 1e9)));
  if (tier === null) {
    noTier += 1;
    continue;
  }
  rowsTotal += 1;
  const band = bandOf(r.age);
  const key = `${tier.index}|${band}`;
  jointSnapshots.set(key, (jointSnapshots.get(key) ?? 0) + 1);
  const mints = jointMints.get(key) ?? new Set<string>();
  mints.add(r.mint);
  jointMints.set(key, mints);

  const perMint = bestTierInBand.get(band) ?? new Map<string, number>();
  const prev = perMint.get(r.mint);
  if (prev === undefined || tier.index > prev) perMint.set(r.mint, tier.index);
  bestTierInBand.set(band, perMint);

  const days = firstDayInBand.get(band) ?? new Map<string, string>();
  if (!days.has(r.mint)) days.set(r.mint, new Date(r.t).toISOString().slice(0, 10));
  firstDayInBand.set(band, days);

  if (rowSample.length < ROW_SAMPLE_TARGET && rowsTotal % 300 === 1) {
    rowSample.push({
      mint: r.mint,
      snapshot_ts: r.t,
      market_cap_sol: capSol,
      tier_index: tier.index,
      total_fee_bps: tier.oneWayBps,
      age_seconds: Math.round(r.age / 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// 4 — THE QUESTION: WHO REACHES TIER 2+ INSIDE 2m-60m, AND HOW OFTEN
// ---------------------------------------------------------------------------

interface Reach {
  band: string;
  mintsWithAnyTier: number;
  atOrAboveTier: { tierIndex: number; mints: number; fraction: number; perDayMedian: number | null; perDay: Record<string, number> }[];
}
const reaches: Reach[] = [];
for (const band of AGE_BANDS.map((b) => b.key)) {
  const perMint = bestTierInBand.get(band);
  if (perMint === undefined || perMint.size === 0) continue;
  const days = firstDayInBand.get(band) ?? new Map<string, string>();
  const atOrAbove: Reach['atOrAboveTier'] = [];
  for (const t of [0, 1, 2, 3, 4, 5, 6]) {
    const mints = [...perMint.entries()].filter(([, best]) => best >= t);
    const perDay: Record<string, number> = {};
    for (const [mint] of mints) {
      const d = days.get(mint) ?? 'unknown';
      perDay[d] = (perDay[d] ?? 0) + 1;
    }
    const vals = Object.values(perDay).sort((a, b) => a - b);
    atOrAbove.push({
      tierIndex: t,
      mints: mints.length,
      fraction: mints.length / perMint.size,
      perDayMedian: vals.length === 0 ? null : (vals[Math.floor(vals.length / 2)] as number),
      perDay,
    });
  }
  reaches.push({ band, mintsWithAnyTier: perMint.size, atOrAboveTier: atOrAbove });
}

const artifact = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-b-tier-assignment-v1',
    sampleInclusionQuery:
      'every decision_snapshots row with a token age and a provider mcap, market cap converted at the ' +
      'derived hourly SOL/USD and assigned a tier through selectFeeTier',
  }),
  label: 'DEVELOPMENT_RECONSTRUCTED',
  isEvidence: false,
  directive: 'Phase B §1.2',
  scheduleHash,
  scheduleAgreesWithArtifact,
  tierCount: tiers.length,
  tierThresholdsSol: tiers.map((t, i) => ({
    tierIndex: i,
    thresholdSol: Number(t.marketCapLamportsThreshold / 1_000_000_000n),
    oneWayBps: t.roundTripBps / 2,
  })),
  solUsd: {
    pairsTotal: solUsd.pairsTotal,
    buckets: solUsd.buckets.length,
    medianSolUsd: solUsd.medianSolUsd,
    derivation: solUsd.derivation,
  },
  /**
   * The check that has to pass before any tier below means anything.
   *
   * If the provider's market cap and the program's disagree by more than a tier
   * width, the whole assignment is a different quantity wearing the tier's name.
   */
  crossCheck: {
    pools: crossChecks.length,
    skipped: crossCheckSkipped,
    ratioProviderOverProgram: {
      p10: q(ratios, 0.1),
      p50: q(ratios, 0.5),
      p90: q(ratios, 0.9),
      min: ratios[0] ?? null,
      max: ratios[ratios.length - 1] ?? null,
    },
    sameTierFraction: crossChecks.length === 0 ? null : crossChecks.filter((c) => c.sameTier).length / crossChecks.length,
    sample: crossChecks.slice(0, 20),
  },
  snapshotsSeen: seen,
  snapshotsAssigned: rowsTotal,
  snapshotsWithoutMcap: noMcap,
  snapshotsWithoutRate: noRate,
  snapshotsWithoutTier: noTier,
  jointDistribution: [...jointSnapshots.entries()]
    .map(([key, snapshots]) => {
      const [tierIndex, band] = key.split('|');
      return {
        tierIndex: Number(tierIndex),
        ageBand: band as string,
        snapshots,
        distinctMints: jointMints.get(key)?.size ?? 0,
      };
    })
    .sort((a, b) => a.tierIndex - b.tierIndex || a.ageBand.localeCompare(b.ageBand)),
  reach: reaches,
  rowSchema: ['mint', 'snapshot_ts', 'market_cap_sol', 'tier_index', 'total_fee_bps', 'age_seconds'],
  rowsTotal,
  rowsSampled: rowSample.length,
  samplingRule: `every 300th assigned row, capped at ${ROW_SAMPLE_TARGET}; the full assignment is reproducible by re-running this script`,
  rows: rowSample,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/tier-assignment.json', JSON.stringify(artifact, null, 2) + '\n');

console.log(`schedule ${scheduleHash.slice(0, 16)} — agrees with §1.1 artifact: ${scheduleAgreesWithArtifact}`);
console.log(
  `cross-check on ${crossChecks.length} pools (${crossCheckSkipped} skipped): provider/program market cap ratio p10 ${q(ratios, 0.1)?.toFixed(3)} p50 ${q(ratios, 0.5)?.toFixed(3)} p90 ${q(ratios, 0.9)?.toFixed(3)}; same tier on ${((artifact.crossCheck.sameTierFraction ?? 0) * 100).toFixed(1)}%`,
);
console.log(
  `assigned ${rowsTotal} of ${seen} snapshots (${noMcap} no mcap, ${noRate} no SOL/USD, ${noTier} no tier)`,
);
console.log('');
console.log('tier × age, distinct mints (snapshots in brackets)');
const bands = AGE_BANDS.map((b) => b.key);
const header = bands.map((b) => b.padStart(14)).join('');
console.log(`tier${header}`);
for (let t = 0; t < tiers.length; t += 1) {
  const cells = bands.map((b) => {
    const row = artifact.jointDistribution.find((j) => j.tierIndex === t && j.ageBand === b);
    return row === undefined ? '-'.padStart(14) : `${row.distinctMints}(${row.snapshots})`.padStart(14);
  });
  if (cells.every((c) => c.trim() === '-')) continue;
  console.log(`${String(t).padStart(4)}${cells.join('')}`);
}
console.log('');
for (const r of reaches) {
  if (r.band !== '2m-60m' && r.band !== '1h-5h') continue;
  console.log(`${r.band}: ${r.mintsWithAnyTier} mints with a tier`);
  for (const a of r.atOrAboveTier) {
    console.log(
      `  tier >= ${a.tierIndex}: ${String(a.mints).padStart(6)} mints  ${(a.fraction * 100).toFixed(2).padStart(6)}%  median ${String(a.perDayMedian ?? '-').padStart(5)} per day`,
    );
  }
}
console.log('');
console.log('wrote artifacts/tier-assignment.json');
