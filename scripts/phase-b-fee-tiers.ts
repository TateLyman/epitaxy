/**
 * `pnpm tier:decode` — the fee schedule, its fingerprint, and whether the
 * stored instruction shape is the current one.
 *
 * §1.1 of the Phase B directive. Three questions, and the third is the one that
 * can invalidate everything downstream:
 *
 *   1. what does the PumpSwap `FeeConfig` actually say, tier by tier;
 *   2. what identifies the schedule that said it, so a republished table is a
 *      REGIME CHANGE and not a silent revision of history;
 *   3. do the stored builds predate the 2026-04-28 program upgrade that appended
 *      a trailing fee-recipient account to every buy and sell?
 *
 * `scripts/fee-tier-surface.ts` already decodes a tier table — out of a test
 * FIXTURE. That is the right source for a document about what the table means
 * and the wrong one for a phase that re-cuts a cost surface along it: a fixture
 * is one capture, and the question here is whether the schedule was the same
 * across all 413 stored snapshots. So this reads the corpus, decodes every
 * stored fee-config account, and hashes each one.
 *
 * Read-only, offline. No network call, nothing signed, nothing funded.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { feeTiersOf, flatFeeOf, boundaries, floorRange, feeConfigHash, tierForPool } from '../packages/solana/src/fee-tiers.js';
import { accountSourceOf, poolFactsFrom, buildBuyFrom, buildSellFrom } from '../packages/solana/src/pumpswap-offline.js';
import { freezeAccountPlan } from '../packages/solana/src/account-plan.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/**
 * The upgrade the directive names. Every stored build is compared against it by
 * DATE as well as by shape, because a shape that merely happens to match is a
 * weaker fact than a build made after the change.
 */
const BREAKING_SHAPE_UPGRADE_UTC_MS = Date.parse('2026-04-28T00:00:00Z');
const SOL = 1_000_000_000n;
const NOTIONAL_LAMPORTS = 20_000_000n;
const SLIPPAGE_PCT = 3;

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
// 1 — DECODE THE SCHEDULE OUT OF EVERY STORED SNAPSHOT
// ---------------------------------------------------------------------------

const snapshots = db
  .prepare(
    `SELECT snapshot_hash AS hash, mint, pool, captured_utc_ms AS captured,
            manifest_blob_sha256 AS manifest, fee_config_hash AS storedFeeConfigHash,
            capability_fingerprint AS capability, sdk_versions AS sdkVersions
       FROM coherent_snapshots ORDER BY captured_utc_ms ASC`,
  )
  .all() as {
  hash: string;
  mint: string;
  pool: string;
  captured: number;
  manifest: string;
  storedFeeConfigHash: string | null;
  capability: string;
  sdkVersions: string;
}[];

const scheduleHashes = new Map<string, { count: number; firstUtcMs: number; lastUtcMs: number }>();
const discriminators = new Map<string, number>();
const storedHashes = new Map<string, number>();
const capabilities = new Map<string, number>();
const sdkVersionSets = new Map<string, number>();
let decoded = 0;
let missingFeeConfig = 0;
let undecodable = 0;
let canonicalTiers: ReturnType<typeof feeTiersOf> | null = null;
let canonicalFlat: ReturnType<typeof flatFeeOf> | null = null;
/** Every pool's own tier, by the SDK's own market-cap rule. */
const poolTiers: {
  mint: string;
  pool: string;
  capturedUtcMs: number;
  marketCapSol: number | null;
  tierIndex: number | null;
  totalFeeBps: number | null;
  refusal: string | null;
}[] = [];

for (const s of snapshots) {
  storedHashes.set(s.storedFeeConfigHash ?? 'null', (storedHashes.get(s.storedFeeConfigHash ?? 'null') ?? 0) + 1);
  capabilities.set(s.capability, (capabilities.get(s.capability) ?? 0) + 1);
  sdkVersionSets.set(s.sdkVersions, (sdkVersionSets.get(s.sdkVersions) ?? 0) + 1);

  let accounts: StoredAccount[];
  try {
    accounts = evidence.get<StoredAccount[]>(s.manifest);
  } catch {
    undecodable += 1;
    continue;
  }
  const raw = accounts.find((a) => a.pubkey === feeAddr);
  if (raw === undefined || raw.dataBase64 === null) {
    missingFeeConfig += 1;
    continue;
  }
  const data = Buffer.from(raw.dataBase64, 'base64');
  discriminators.set(data.subarray(0, 8).toString('hex'), (discriminators.get(data.subarray(0, 8).toString('hex')) ?? 0) + 1);

  let cfg: unknown;
  try {
    cfg = sdk.decodeFeeConfig({
      owner: new PublicKey(raw.owner),
      data,
      lamports: Number(raw.lamports),
      executable: false,
      rentEpoch: 0,
    });
  } catch {
    // F11 — present and undecodable REFUSES. It is not "there is no fee config".
    undecodable += 1;
    continue;
  }
  const tiers = feeTiersOf(cfg);
  const flat = flatFeeOf(cfg);
  const h = feeConfigHash(tiers, flat);
  const seen = scheduleHashes.get(h);
  if (seen === undefined) scheduleHashes.set(h, { count: 1, firstUtcMs: s.captured, lastUtcMs: s.captured });
  else {
    seen.count += 1;
    seen.lastUtcMs = s.captured;
  }
  if (canonicalTiers === null) {
    canonicalTiers = tiers;
    canonicalFlat = flat;
  }
  decoded += 1;

  // And what tier THIS pool was in, by the rule the program uses.
  try {
    const src = accountSourceOf(
      accounts.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: typeof a.lamports === 'string' ? BigInt(a.lamports) : BigInt(Math.trunc(a.lamports)),
      })),
    );
    const facts = poolFactsFrom(src, s.pool);
    // The SDK charges against the EFFECTIVE quote reserve (raw + virtual), and
    // reading it off the raw side alone puts a pool in the wrong tier.
    const selected = tierForPool(tiers, {
      quoteReserveLamports: facts.quoteReserveRaw + facts.virtualQuoteReserves,
      baseReserveAtoms: facts.baseReserve,
      baseMintSupplyAtoms: facts.baseMintSupplyAtoms,
    });
    const idx =
      selected.tier === null
        ? null
        : tiers.findIndex((t) => t.marketCapLamportsThreshold === selected.tier?.marketCapLamportsThreshold);
    poolTiers.push({
      mint: s.mint,
      pool: s.pool,
      capturedUtcMs: s.captured,
      marketCapSol: selected.marketCapLamports === null ? null : Number(selected.marketCapLamports) / 1e9,
      tierIndex: idx === -1 ? null : idx,
      totalFeeBps: selected.tier === null ? null : selected.tier.roundTripBps / 2,
      refusal: selected.refusal,
    });
  } catch (e) {
    poolTiers.push({
      mint: s.mint,
      pool: s.pool,
      capturedUtcMs: s.captured,
      marketCapSol: null,
      tierIndex: null,
      totalFeeBps: null,
      refusal: (e as Error).message.slice(0, 100),
    });
  }
}

// ---------------------------------------------------------------------------
// 2 — THE FINGERPRINT
// ---------------------------------------------------------------------------

const programRows = db
  .prepare(`SELECT program_manifest AS manifest, created_utc_ms AS created FROM snapshot_manifests`)
  .all() as { manifest: string; created: number }[];
const programElfHashes = new Map<string, Map<string, number>>();
for (const r of programRows) {
  let list: { pubkey: string; owner: string; elfHash: string }[];
  try {
    list = JSON.parse(r.manifest) as { pubkey: string; owner: string; elfHash: string }[];
  } catch {
    continue;
  }
  for (const p of list) {
    const byHash = programElfHashes.get(p.pubkey) ?? new Map<string, number>();
    byHash.set(p.elfHash, (byHash.get(p.elfHash) ?? 0) + 1);
    programElfHashes.set(p.pubkey, byHash);
  }
}

// ---------------------------------------------------------------------------
// 3 — THE INSTRUCTION SHAPE, STORED VERSUS WHAT THE PINNED SDK BUILDS NOW
// ---------------------------------------------------------------------------

const AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const planRows = db
  .prepare(
    `SELECT p.trajectory_id AS trajectoryId, p.leg AS leg, p.plan_json AS planJson,
            p.fingerprint AS fingerprint, p.recorded_utc_ms AS recorded, t.snapshot_hash AS snapshotHash,
            t.pool AS pool, t.notional_lamports AS notional
       FROM leg_account_plans p
       JOIN development_trajectories t ON t.trajectory_id = p.trajectory_id`,
  )
  .all() as {
  trajectoryId: string;
  leg: string;
  planJson: string;
  fingerprint: string;
  recorded: number;
  snapshotHash: string;
  pool: string;
  notional: string;
}[];

const shapeCounts = new Map<string, number>();
let earliestBuild = Number.POSITIVE_INFINITY;
let latestBuild = 0;
let buildsBeforeUpgrade = 0;
for (const r of planRows) {
  earliestBuild = Math.min(earliestBuild, r.recorded);
  latestBuild = Math.max(latestBuild, r.recorded);
  if (r.recorded < BREAKING_SHAPE_UPGRADE_UTC_MS) buildsBeforeUpgrade += 1;
  let plan: { programId: string; accounts: unknown[] }[];
  try {
    plan = JSON.parse(r.planJson) as { programId: string; accounts: unknown[] }[];
  } catch {
    continue;
  }
  for (const ix of plan) {
    if (ix.programId !== AMM_PROGRAM) continue;
    const key = `${r.leg}:${ix.accounts.length}`;
    shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
  }
}

/** The same leg, rebuilt now, from the same stored state. */
const toRaw = (ix: TransactionInstruction): RawInstruction => ({
  programId: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString('base64'),
});

interface Differential {
  trajectoryId: string;
  leg: string;
  storedAccounts: number;
  rebuiltAccounts: number;
  storedFingerprint: string;
  rebuiltFingerprint: string;
  fingerprintsMatch: boolean;
  shapeMatches: boolean;
  trailingAccountStored: string | null;
  trailingAccountRebuilt: string | null;
  refusal: string | null;
}
const differentials: Differential[] = [];
const taker = secrets.paperTakerPubkey;
let shapesTotal = 0;
let shapesRebuildable = 0;

if (taker !== null) {
  // A handful, not all of them: the question is whether the SHAPE the pinned SDK
  // produces is the shape that is stored, and that is answered by any sample
  // that covers each stored account count.
  //
  // "First row per shape" is not good enough: 4 of the 6 stored shapes had a
  // trajectory whose snapshot hash is not in `coherent_snapshots` as their first
  // row, which silently left those shapes unverified. The row is chosen among
  // those whose snapshot IS stored, so every shape that CAN be rebuilt is.
  const hasSnapshot = db.prepare(`SELECT 1 AS ok FROM coherent_snapshots WHERE snapshot_hash = ?`);
  const wanted = new Map<string, (typeof planRows)[number]>();
  const shapesSeen = new Set<string>();
  for (const r of planRows) {
    let plan: { programId: string; accounts: unknown[] }[];
    try {
      plan = JSON.parse(r.planJson) as { programId: string; accounts: unknown[] }[];
    } catch {
      continue;
    }
    const swap = plan.find((ix) => ix.programId === AMM_PROGRAM);
    if (swap === undefined) continue;
    const key = `${r.leg}:${swap.accounts.length}`;
    shapesSeen.add(key);
    if (wanted.has(key)) continue;
    if ((hasSnapshot.get(r.snapshotHash) as { ok: number } | undefined) === undefined) continue;
    wanted.set(key, r);
  }
  shapesTotal = shapesSeen.size;
  shapesRebuildable = wanted.size;

  for (const [, r] of wanted) {
    const row = db
      .prepare(`SELECT manifest_blob_sha256 AS manifest FROM coherent_snapshots WHERE snapshot_hash = ?`)
      .get(r.snapshotHash) as { manifest: string } | undefined;
    if (row === undefined) continue;
    let plan: { programId: string; accounts: { pubkey: string }[] }[];
    try {
      plan = JSON.parse(r.planJson) as { programId: string; accounts: { pubkey: string }[] }[];
    } catch {
      continue;
    }
    const storedSwap = plan.find((ix) => ix.programId === AMM_PROGRAM);
    if (storedSwap === undefined) continue;

    try {
      const accounts = evidence.get<StoredAccount[]>(row.manifest);
      const src = accountSourceOf(
        accounts.map((a) => ({
          pubkey: a.pubkey,
          owner: a.owner,
          dataBase64: a.dataBase64,
          lamports: typeof a.lamports === 'string' ? BigInt(a.lamports) : BigInt(Math.trunc(a.lamports)),
        })),
      );
      const rebuilt =
        r.leg === 'buy'
          ? (await buildBuyFrom(src, { poolKey: r.pool, user: taker, quoteLamports: NOTIONAL_LAMPORTS, slippagePct: SLIPPAGE_PCT })).instructions
          : (
              await buildSellFrom(src, {
                poolKey: r.pool,
                user: taker,
                baseAtoms: (await buildBuyFrom(src, { poolKey: r.pool, user: taker, quoteLamports: NOTIONAL_LAMPORTS, slippagePct: SLIPPAGE_PCT })).baseOutAtoms,
                slippagePct: SLIPPAGE_PCT,
              })
            ).instructions;
      const rawIxs = rebuilt.map(toRaw);
      const rebuiltSwap = rawIxs.find((ix) => ix.programId === AMM_PROGRAM);
      const frozen = freezeAccountPlan(r.leg, rawIxs);
      differentials.push({
        trajectoryId: r.trajectoryId,
        leg: r.leg,
        storedAccounts: storedSwap.accounts.length,
        rebuiltAccounts: rebuiltSwap?.accounts?.length ?? 0,
        storedFingerprint: r.fingerprint,
        rebuiltFingerprint: frozen.fingerprint,
        fingerprintsMatch: frozen.fingerprint === r.fingerprint,
        shapeMatches: (rebuiltSwap?.accounts?.length ?? -1) === storedSwap.accounts.length,
        trailingAccountStored: storedSwap.accounts[storedSwap.accounts.length - 1]?.pubkey ?? null,
        trailingAccountRebuilt: rebuiltSwap?.accounts?.[rebuiltSwap.accounts.length - 1]?.pubkey ?? null,
        refusal: null,
      });
    } catch (e) {
      differentials.push({
        trajectoryId: r.trajectoryId,
        leg: r.leg,
        storedAccounts: storedSwap.accounts.length,
        rebuiltAccounts: 0,
        storedFingerprint: r.fingerprint,
        rebuiltFingerprint: '',
        fingerprintsMatch: false,
        shapeMatches: false,
        trailingAccountStored: null,
        trailingAccountRebuilt: null,
        refusal: (e as Error).message.slice(0, 140),
      });
    }
  }
}

const shapeVerdict = (() => {
  if (planRows.length === 0) return 'NO_STORED_PLANS';
  if (buildsBeforeUpgrade > 0) return 'STALE_INSTRUCTION_SHAPE';
  const attempted = differentials.filter((d) => d.refusal === null);
  if (attempted.length === 0) return 'SHAPE_NOT_DIFFERENTIALLY_VERIFIED';
  if (!attempted.every((d) => d.shapeMatches)) return 'STALE_INSTRUCTION_SHAPE';
  // Every shape that could be rebuilt matched. Say so, and say how many.
  return attempted.length >= shapesTotal ? 'CURRENT_INSTRUCTION_SHAPE' : 'CURRENT_INSTRUCTION_SHAPE_PARTIALLY_VERIFIED';
})();

// ---------------------------------------------------------------------------
// 4 — EMIT
// ---------------------------------------------------------------------------

const tiers = canonicalTiers ?? [];
const flat = canonicalFlat ?? { lpFeeBps: 0, protocolFeeBps: 0, creatorFeeBps: 0, totalBps: 0 };
const poolTierCounts = new Map<string, number>();
for (const p of poolTiers) poolTierCounts.set(String(p.tierIndex), (poolTierCounts.get(String(p.tierIndex)) ?? 0) + 1);
const capsSol = poolTiers.map((p) => p.marketCapSol).filter((v): v is number => v !== null).sort((a, b) => a - b);

const artifact = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'phase-b-fee-tiers-v1',
    sampleInclusionQuery:
      'every coherent_snapshots row, its stored fee-config account decoded through the pinned ' +
      '@pump-fun/pump-swap-sdk, plus every snapshot_manifests program manifest and every leg_account_plans row',
  }),
  label: 'DEVELOPMENT_RECONSTRUCTED',
  isEvidence: false,
  directive: 'Phase B §1.1',
  feeConfigAddress: feeAddr,
  snapshotsRead: snapshots.length,
  feeConfigsDecoded: decoded,
  feeConfigMissing: missingFeeConfig,
  feeConfigUndecodable: undecodable,
  /**
   * ONE schedule across the whole corpus, or a regime change inside it.
   *
   * More than one hash here invalidates every downstream surface that pooled
   * across the boundary, which is why it is the first thing reported.
   */
  scheduleHashes: [...scheduleHashes.entries()].map(([hash, v]) => ({ hash, ...v })),
  distinctSchedules: scheduleHashes.size,
  storedFeeConfigHashes: [...storedHashes.entries()].map(([hash, count]) => ({ hash, count })),
  accountDiscriminators: [...discriminators.entries()].map(([hex, count]) => ({ hex, count })),
  flatFee: flat,
  tierCount: tiers.length,
  tiers: tiers.map((t, i) => ({
    tierIndex: i,
    marketCapThresholdLamports: t.marketCapLamportsThreshold.toString(),
    marketCapThresholdSol: Number(t.marketCapLamportsThreshold / SOL),
    ...t.fees,
    oneWayBps: t.roundTripBps / 2,
    roundTripBps: t.roundTripBps,
  })),
  boundaries: boundaries(tiers).map((b) => ({
    marketCapSol: Number(b.marketCapLamports / SOL),
    belowRoundTripBps: b.belowRoundTripBps,
    aboveRoundTripBps: b.aboveRoundTripBps,
    stepBps: b.stepBps,
  })),
  floorRange: floorRange(tiers),
  fingerprint: {
    sdkVersionSets: [...sdkVersionSets.entries()].map(([versions, count]) => ({ versions, count })),
    capabilityFingerprints: [...capabilities.entries()].map(([hash, count]) => ({ hash, count })),
    programElfHashes: [...programElfHashes.entries()].map(([pubkey, byHash]) => ({
      pubkey,
      hashes: [...byHash.entries()].map(([elfHash, count]) => ({ elfHash, count })),
      distinctHashes: byHash.size,
    })),
  },
  poolTierAssignment: {
    poolsClassified: poolTiers.length,
    byTierIndex: [...poolTierCounts.entries()].map(([tierIndex, count]) => ({ tierIndex, count })),
    marketCapSol:
      capsSol.length === 0
        ? null
        : {
            min: capsSol[0],
            p50: capsSol[Math.floor(capsSol.length / 2)],
            max: capsSol[capsSol.length - 1],
          },
    refusals: poolTiers.filter((p) => p.refusal !== null).length,
  },
  instructionShape: {
    upgradeUtcMs: BREAKING_SHAPE_UPGRADE_UTC_MS,
    upgradeUtc: new Date(BREAKING_SHAPE_UPGRADE_UTC_MS).toISOString(),
    storedPlans: planRows.length,
    earliestBuildUtc: Number.isFinite(earliestBuild) ? new Date(earliestBuild).toISOString() : null,
    latestBuildUtc: latestBuild === 0 ? null : new Date(latestBuild).toISOString(),
    buildsBeforeUpgrade,
    swapAccountCounts: [...shapeCounts.entries()].map(([key, count]) => ({ key, count })),
    distinctShapes: shapesTotal,
    shapesDifferentiallyRebuilt: shapesRebuildable,
    differentials,
    verdict: shapeVerdict,
    /**
     * A fingerprint mismatch is NOT a stale shape.
     *
     * The SDK picks a fee recipient out of a list, so two builds of the same leg
     * differ in one account by design. The shape — the account COUNT and the
     * position of every derived account — is what the upgrade changed, and it is
     * what is compared.
     */
    fingerprintMismatchIsExpected: true,
  },
  unmodelledCosts: {
    quoteToLandSlippage: 'UNKNOWN',
    crowding: 'UNKNOWN',
    note: 'neither is measurable from stored state; the floor here excludes both',
  },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/fee-tier-schedule.json', JSON.stringify(artifact, null, 2) + '\n');

console.log(`decoded ${decoded} of ${snapshots.length} stored fee configs (${missingFeeConfig} missing, ${undecodable} undecodable)`);
console.log(`distinct schedules: ${scheduleHashes.size}`);
for (const [hash, v] of scheduleHashes) {
  console.log(`  ${hash.slice(0, 16)}  ${v.count} snapshots  ${new Date(v.firstUtcMs).toISOString()} .. ${new Date(v.lastUtcMs).toISOString()}`);
}
console.log(`discriminators: ${[...discriminators.keys()].map((k) => k.slice(0, 16)).join(', ')}`);
console.log('');
console.log('tier  threshold SOL   one-way bps   round-trip bps');
for (const [i, t] of tiers.entries()) {
  console.log(
    `${String(i).padStart(4)}  ${String(Number(t.marketCapLamportsThreshold / SOL)).padStart(13)}   ${String(t.roundTripBps / 2).padStart(11)}   ${String(t.roundTripBps).padStart(14)}`,
  );
}
console.log('');
console.log(`the corpus's own pools: ${poolTiers.length} classified`);
for (const [tierIndex, count] of poolTierCounts) console.log(`  tier ${tierIndex}: ${count}`);
if (capsSol.length > 0) {
  console.log(
    `  market cap SOL  min ${capsSol[0]?.toFixed(2)}  p50 ${capsSol[Math.floor(capsSol.length / 2)]?.toFixed(2)}  max ${capsSol[capsSol.length - 1]?.toFixed(2)}`,
  );
}
console.log('');
console.log(`instruction shape: ${shapeVerdict}`);
console.log(`  stored plans ${planRows.length}, built ${artifact.instructionShape.earliestBuildUtc} .. ${artifact.instructionShape.latestBuildUtc}`);
console.log(`  builds predating the 2026-04-28 upgrade: ${buildsBeforeUpgrade}`);
console.log(`  distinct shapes ${shapesTotal}, differentially rebuilt ${shapesRebuildable}`);
for (const [key, count] of shapeCounts) console.log(`  ${key} accounts: ${count}`);
for (const d of differentials) {
  console.log(
    `  ${d.leg} stored ${d.storedAccounts} vs rebuilt ${d.rebuiltAccounts}  shape ${d.shapeMatches ? 'MATCH' : 'DIFFERS'}  fingerprint ${d.fingerprintsMatch ? 'match' : 'differs (expected)'}${d.refusal === null ? '' : `  REFUSED ${d.refusal}`}`,
  );
}
console.log('');
console.log('wrote artifacts/fee-tier-schedule.json');
