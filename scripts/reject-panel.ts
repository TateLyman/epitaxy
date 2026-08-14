/**
 * P20 — the reject panel: what a gate actually removed.
 *
 * `reject-status` counts rejections by reason. That answers "what did we refuse"
 * and cannot answer the only question that decides whether a gate is any good:
 *
 *   which gate prevents catastrophe
 *   which gate removes future winners
 *   which gate merely removes missing data
 *
 * A provider that stopped publishing a field is not a token that stopped being
 * tradeable, and 505,074 rejections for `stale_source` are almost certainly the
 * first thing rather than the second. Counting them as refusals of bad tokens
 * is how a gate gets credit for a provider outage.
 *
 * So a STRATIFIED PROBABILITY SAMPLE is drawn per reason, each row carries the
 * probability it had of being drawn, and each sampled mint is re-examined
 * against the chain and the sequential runtime rather than against the provider
 * that dropped it.
 *
 * The draw is seeded and the seed is recorded, so the panel is reproducible and
 * a later version can be compared against this one. A gate must not be tuned on
 * the panel it is then evaluated on, so the panel version is stamped.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { runSequential, tokenAmountOf } from '../packages/simulator/src/sequential-runtime.js';
import {
  accountSourceOf,
  buildBuyFrom,
  poolAddressesFrom,
  poolFactsFrom,
  canonicalPool,
  swapAccountAddresses,
  associatedTokenAddressOf,
  SWAP_PROGRAM_IDS,
  WSOL_MINT,
} from '../packages/solana/src/pumpswap-offline.js';
import { readMintFacts } from '../packages/intelligence/src/mintfacts-source.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/** Bumped whenever the strata or the classification change. */
const PANEL_VERSION = 'v1';
const SEED = Number(process.env['REJECT_PANEL_SEED'] ?? 20260813);
const PER_STRATUM = Number(process.env['REJECT_PANEL_PER_STRATUM'] ?? 4);
const NOTIONAL = BigInt(process.env['REJECT_PANEL_LAMPORTS'] ?? '20000000');
const WINDOW_MS = Number(process.env['REJECT_PANEL_WINDOW_MS'] ?? 7 * 86_400_000);

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });
if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
  console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
  process.exit(1);
}
const taker: string = secrets.paperTakerPubkey;
const { rpc, host: rpcHost, overridden } = researchRpc(secrets);
console.log(`endpoint ${rpcHost}${overridden ? ' (explicit override)' : ''}`);
void config;

const toRaw = (ix: TransactionInstruction): RawInstruction => ({
  programId: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString('base64'),
});

/** Deterministic PRNG, so the panel is a fixed object rather than a new one each run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

type PanelClass =
  /** The chain would have filled it. The gate removed a tradeable token. */
  | 'EXECUTABLE_VALUE'
  /**
   * No canonical PumpSwap pool. NOT a claim that no venue exists anywhere —
   * a bonding-curve token would land here and a router might still reach it.
   * What it establishes is that the direct family could not have traded it.
   */
  | 'NO_ROUTE_CONFIRMED'
  /** A pool exists and has nothing in it. */
  | 'POOL_DRAIN_CONFIRMED'
  /** The provider stopped publishing. A fact about the provider. */
  | 'PROVIDER_MISSING'
  /** We never had the field the gate wanted. */
  | 'SOURCE_GAP'
  /** A venue exists and the leg cannot be constructed. */
  | 'UNBUILDABLE'
  /** The runtime could not answer. Never counted as either outcome. */
  | 'SIMULATION_UNAVAILABLE'
  | 'UNKNOWN';

interface PanelRow {
  mint: string;
  stratum: string;
  /** The probability this row had of being drawn from its stratum. */
  inclusionProbability: number;
  strataSize: number;
  rejectedUtcMs: number | null;
  classification: PanelClass;
  detail: string | null;
  poolExists: boolean;
  poolBaseReserve: string | null;
  poolQuoteReserve: string | null;
  buyStatus: string | null;
  acquiredAtoms: string | null;
  /** What a real entry would have received, in the runtime, at the panel notional. */
  executableValueLamports: string | null;
  mintFactsOverall: string | null;
  mintFactsReasons: string | null;
}

// ---- the strata: one per primary rejection reason ------------------------
const strata = db
  .prepare(
    `SELECT primary_reason AS reason, COUNT(*) AS n
       FROM reject_tracking
      WHERE rejected_utc_ms > ?
      GROUP BY 1 ORDER BY n DESC`,
  )
  .all(Date.now() - WINDOW_MS) as { reason: string; n: number }[];

console.log(`${strata.length} strata, ${PER_STRATUM} draws each, seed ${SEED}\n`);
for (const s of strata) console.log(`  ${s.reason.padEnd(28)} ${s.n}`);
console.log('');

const rand = rng(SEED);
const rows: PanelRow[] = [];

for (const stratum of strata) {
  // Every distinct mint in the stratum, then a uniform draw without
  // replacement. Distinct because one mint rejected two hundred times is one
  // token, and sampling rows would make the panel a study of cycle frequency.
  const pool = db
    .prepare(
      `SELECT mint, MAX(rejected_utc_ms) AS at FROM reject_tracking
        WHERE primary_reason = ? AND rejected_utc_ms > ?
        GROUP BY mint`,
    )
    .all(stratum.reason, Date.now() - WINDOW_MS) as { mint: string; at: number }[];
  if (pool.length === 0) continue;

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = shuffled[i] as { mint: string; at: number };
    const b = shuffled[j] as { mint: string; at: number };
    shuffled[i] = b;
    shuffled[j] = a;
  }
  const take = Math.min(PER_STRATUM, shuffled.length);
  const p = take / shuffled.length;

  for (const cand of shuffled.slice(0, take)) {
    const row: PanelRow = {
      mint: cand.mint,
      stratum: stratum.reason,
      inclusionProbability: p,
      strataSize: shuffled.length,
      rejectedUtcMs: cand.at,
      classification: 'UNKNOWN',
      detail: null,
      poolExists: false,
      poolBaseReserve: null,
      poolQuoteReserve: null,
      buyStatus: null,
      acquiredAtoms: null,
      executableValueLamports: null,
      mintFactsOverall: null,
      mintFactsReasons: null,
    };
    process.stdout.write(`  ${stratum.reason.slice(0, 20).padEnd(20)} ${cand.mint.slice(0, 10)} ... `);

    // The chain's own answer about the mint, whatever the provider said.
    try {
      const f = await readMintFacts(rpc, cand.mint, { nowUtcMs: Date.now() });
      row.mintFactsOverall = f.overall;
      row.mintFactsReasons = f.reasons.join('; ').slice(0, 200) || null;
    } catch {
      /* recorded as null */
    }

    const poolKey = canonicalPool(cand.mint);
    let addrs;
    try {
      const raw = await rpc.getAccountRaw(poolKey);
      addrs = poolAddressesFrom(
        accountSourceOf([{ pubkey: poolKey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
        poolKey,
      );
      row.poolExists = true;
    } catch {
      row.classification = 'NO_ROUTE_CONFIRMED';
      row.detail =
        'no canonical PumpSwap pool; the direct family could not have traded it. A router may still reach it.';
      rows.push(row);
      console.log(row.classification);
      continue;
    }

    const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const wanted = [
      taker,
      takerWsol,
      addrs.poolBaseTokenAccount,
      addrs.poolQuoteTokenAccount,
      ...swapAccountAddresses({ poolKey, baseMint: cand.mint, user: taker, coinCreator: addrs.coinCreator }),
    ];

    let snapshot;
    try {
      snapshot = await captureSnapshot(rpc, [], { extraAccounts: wanted, extraPrograms: [...SWAP_PROGRAM_IDS] });
    } catch (e) {
      row.classification = 'SIMULATION_UNAVAILABLE';
      row.detail = (e as Error).message.slice(0, 140);
      rows.push(row);
      console.log(row.classification);
      continue;
    }

    const src = accountSourceOf(snapshot.accounts);
    let facts;
    try {
      facts = poolFactsFrom(src, poolKey);
    } catch (e) {
      row.classification = 'SIMULATION_UNAVAILABLE';
      row.detail = (e as Error).message.slice(0, 140);
      rows.push(row);
      console.log(row.classification);
      continue;
    }
    row.poolBaseReserve = facts.baseReserve.toString();
    row.poolQuoteReserve = facts.quoteReserveRaw.toString();

    if (facts.baseReserve === 0n || facts.quoteReserveRaw === 0n) {
      row.classification = 'POOL_DRAIN_CONFIRMED';
      row.detail = `base ${facts.baseReserve}, quote ${facts.quoteReserveRaw}`;
      rows.push(row);
      console.log(row.classification);
      continue;
    }

    let bytes: string;
    let buyAccounts: readonly string[];
    try {
      const built = await buildBuyFrom(src, {
        poolKey,
        user: taker,
        quoteLamports: NOTIONAL,
        slippagePct: 3,
      });
      buyAccounts = built.accounts;
      bytes = Buffer.from(
        encodeUnsignedTransaction(
          compileMessage(built.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
        ),
      ).toString('base64');
    } catch (e) {
      row.classification = 'UNBUILDABLE';
      row.detail = (e as Error).message.slice(0, 140);
      rows.push(row);
      console.log(row.classification);
      continue;
    }

    const takerAta = associatedTokenAddressOf(taker, cand.mint, facts.baseTokenProgram);
    const accounts = [
      ...snapshot.accounts.map((a) => (a.pubkey === taker ? { ...a, lamports: 4_000_000_000n } : a)),
      ...(snapshot.accounts.some((a) => a.pubkey === taker)
        ? []
        : [
            {
              pubkey: taker,
              dataBase64: '',
              owner: '11111111111111111111111111111111',
              lamports: 4_000_000_000n,
              executable: false,
              rentEpoch: 0n,
            },
          ]),
    ];

    try {
      const run = runSequential({
        jobId: `panel-${cand.mint.slice(0, 8)}`,
        snapshot: {
          programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
          accounts,
          slot: snapshot.slot,
          unixTimestamp: snapshot.unixTimestamp,
        },
        steps: [
          {
            label: 'buy',
            transactionBase64: bytes,
            observe: [...new Set([...wanted, ...buyAccounts, takerAta])],
          },
        ],
        timeoutMs: 180_000,
      });
      const step = run.steps[0];
      row.buyStatus = step?.status ?? 'MISSING';
      if (step === undefined || step.status !== 'SIMULATED_OK') {
        row.classification = 'UNBUILDABLE';
        row.detail = (step?.transactionError ?? 'no result').slice(0, 140);
      } else {
        const post = step.postAccounts.find((a) => a.pubkey === takerAta);
        const atoms = post === undefined ? null : tokenAmountOf(post);
        row.acquiredAtoms = atoms === null ? null : atoms.toString();
        if (atoms !== null && atoms > 0n) {
          const before = BigInt(step.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
          const after = BigInt(step.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
          row.executableValueLamports = (before - after).toString();
          row.classification = 'EXECUTABLE_VALUE';
        } else {
          row.classification = 'UNBUILDABLE';
          row.detail = 'the buy committed and credited nothing';
        }
      }
    } catch (e) {
      row.classification = 'SIMULATION_UNAVAILABLE';
      row.detail = (e as Error).message.slice(0, 140);
    }

    rows.push(row);
    console.log(`${row.classification} ${row.acquiredAtoms ?? ''}`);
  }
}

/**
 * What each gate actually removed, weighted by inclusion probability.
 *
 * An unweighted count over a stratified sample describes the sample, not the
 * population it was drawn from — and the strata here differ in size by three
 * orders of magnitude.
 */
const byStratum = strata.map((s) => {
  const at = rows.filter((r) => r.stratum === s.reason);
  const weight = (c: PanelClass): number =>
    at.filter((r) => r.classification === c).reduce((t, r) => t + 1 / r.inclusionProbability, 0);
  const total = at.reduce((t, r) => t + 1 / r.inclusionProbability, 0);
  const share = (c: PanelClass): number | null => (total === 0 ? null : weight(c) / total);
  return {
    reason: s.reason,
    populationRejections: s.n,
    sampled: at.length,
    /** The gate removed something the chain would have filled. */
    executableValueShare: share('EXECUTABLE_VALUE'),
    /** The gate removed something with no venue at all. */
    noRouteShare: share('NO_ROUTE_CONFIRMED'),
    poolDrainShare: share('POOL_DRAIN_CONFIRMED'),
    unbuildableShare: share('UNBUILDABLE'),
    simulationUnavailableShare: share('SIMULATION_UNAVAILABLE'),
    /**
     * The reading the directive asks for, stated per gate:
     * a gate whose rejects are overwhelmingly EXECUTABLE_VALUE is removing
     * tradeable tokens; one that is overwhelmingly NO_ROUTE is removing
     * nothing; one that is mostly SIMULATION_UNAVAILABLE has not been measured.
     */
    reading:
      at.length === 0
        ? 'not sampled'
        : (share('EXECUTABLE_VALUE') ?? 0) >= 0.5
          ? 'removes tokens the chain would have filled'
          : (share('NO_ROUTE_CONFIRMED') ?? 0) >= 0.5
            ? 'removes tokens with no canonical PumpSwap pool'
            : (share('SIMULATION_UNAVAILABLE') ?? 0) >= 0.5
              ? 'not measurable with the current apparatus'
              : 'mixed',
  };
});

const summary = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'schema-v31',
    sampleInclusionQuery: `reject_tracking, last ${WINDOW_MS / 86_400_000}d, stratified by primary_reason`,
  }),
  panelVersion: PANEL_VERSION,
  seed: SEED,
  perStratum: PER_STRATUM,
  notionalLamports: NOTIONAL.toString(),
  strata: strata.length,
  sampled: rows.length,
  byClassification: (
    [
      'EXECUTABLE_VALUE',
      'NO_ROUTE_CONFIRMED',
      'POOL_DRAIN_CONFIRMED',
      'PROVIDER_MISSING',
      'SOURCE_GAP',
      'UNBUILDABLE',
      'SIMULATION_UNAVAILABLE',
      'UNKNOWN',
    ] as PanelClass[]
  ).map((c) => ({ classification: c, n: rows.filter((r) => r.classification === c).length })),
  byStratum,
  rows,
  caveat:
    'NO_ROUTE_CONFIRMED here means no CANONICAL PUMPSWAP POOL. It is not a claim that no venue exists: a ' +
    'token still on the bonding curve, or one trading on another AMM, would be classified this way and ' +
    'might well be reachable through a router. What the panel establishes is that the direct family this ' +
    'system is being built around could not have traded it.',
  note:
    'A gate must not be tuned on the panel version it is then evaluated on. panelVersion is stamped so a ' +
    'later evaluation can be checked against the version a change was made on.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/reject-panel.json', JSON.stringify(summary, null, 2));

console.log('\nby classification:');
for (const c of summary.byClassification) if (c.n > 0) console.log(`  ${c.classification.padEnd(24)} ${c.n}`);
console.log('\nby gate:');
for (const g of byStratum) {
  if (g.sampled === 0) continue;
  console.log(`  ${g.reason.padEnd(28)} n=${g.sampled}  ${g.reading}`);
}
console.log('\nartifacts/reject-panel.json');
db.close();
