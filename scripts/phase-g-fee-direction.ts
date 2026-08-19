/**
 * Phase G §2.1 — decode which side the PumpSwap fee is taken on, from the program.
 *
 * The directive is explicit: "Decode the actual direction from the program rather
 * than assuming it: whether the fee is taken on input or output, and whether it
 * differs between buy and sell, changes the arithmetic and must be read from the
 * instruction, not inferred."
 *
 * HOW THIS READS IT WITHOUT GUESSING. The pinned SDK is the program's own client and
 * its instruction shapes were reproduced against six distinct stored on-chain shapes
 * in Phase B, so it is already validated against the chain. Its quote functions
 * return the full fee decomposition, so the direction can be OBSERVED by quoting
 * real stored pool state and reading which quantity the fees were subtracted from.
 * That is a measurement of the program's arithmetic, not an inference about it.
 *
 * WHAT THE ANSWER IS FOR. Phase F found the reserve roll-forward drifts monotonically
 * with trade count, and diagnosed it as the protocol and creator fees leaving the
 * pool while `dex_solana.trades` records only the trader's amounts. At tier 0 that is
 * 123 of 125 bps per leg — lpFeeBps is 2. Correcting the roll-forward needs to know
 * whether that 123 bps comes off the quote a buyer pays IN, or the quote a seller
 * receives OUT, or both.
 *
 * Usage: pnpm fee:direction
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { accountSourceOf, poolFactsFrom, GLOBAL_CONFIG_ADDR } from '../packages/solana/src/pumpswap-offline.js';
import { feeTiersOf, flatFeeOf, selectFeeTier, poolMarketCapLamports } from '../packages/solana/src/fee-tiers.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

interface StoredAccount {
  pubkey: string;
  owner: string;
  dataBase64: string | null;
  lamports: string | number;
}

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');

const snaps = db
  .prepare(
    `SELECT snapshot_hash AS hash, mint, pool, manifest_blob_sha256 AS manifest, captured_utc_ms AS captured
       FROM coherent_snapshots ORDER BY captured_utc_ms DESC`,
  )
  .all() as { hash: string; mint: string; pool: string; manifest: string; captured: number }[];

const sdk = new PumpAmmSdk();

/**
 * Probe one pool: quote a buy and a sell, and read the decomposition the SDK
 * returns. Every numeric field is printed rather than the ones expected, because a
 * field this build does not know about is exactly where an assumption would hide.
 */
interface Probe {
  readonly pool: string;
  readonly mint: string;
  readonly baseReserve: string;
  readonly quoteReserve: string;
  readonly tierIndex: number | null;
  readonly lpFeeBps: number | null;
  readonly protocolFeeBps: number | null;
  readonly creatorFeeBps: number | null;
  readonly buy: Record<string, string> | null;
  readonly sell: Record<string, string> | null;
  readonly failure: string | null;
}

const flatten = (o: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (o === null || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      out[k] = 'null';
    } else if (typeof v === 'object' && 'toString' in (v as object)) {
      out[k] = String(v);
    } else {
      out[k] = String(v);
    }
  }
  return out;
};

const probes: Probe[] = [];
const QUOTE_IN_LAMPORTS = 1_000_000_000n; // 1 SOL, round, so the fee shows up plainly
const SLIPPAGE = 1;

for (const s of snaps.slice(0, 6)) {
  try {
    const accounts = evidence.get<StoredAccount[]>(s.manifest);
    const src = accountSourceOf(
      accounts.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: BigInt(a.lamports),
      })),
    );
    const facts = poolFactsFrom(src, s.pool);
    const globalRaw = src.get(GLOBAL_CONFIG_ADDR);
    const feeRaw = src.get(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
    const mintRaw = src.get(facts.baseMint);
    if (globalRaw === null || feeRaw === null || mintRaw === null) {
      probes.push({
        pool: s.pool,
        mint: s.mint,
        baseReserve: facts.baseReserve.toString(),
        quoteReserve: facts.quoteReserveRaw.toString(),
        tierIndex: null,
        lpFeeBps: null,
        protocolFeeBps: null,
        creatorFeeBps: null,
        buy: null,
        sell: null,
        failure: 'global config, fee config or base mint absent from the snapshot',
      });
      continue;
    }
    const feeConfig = sdk.decodeFeeConfig({
      owner: new PublicKey(feeRaw.owner),
      data: Buffer.from(feeRaw.dataBase64 as string, 'base64'),
      lamports: Number(feeRaw.lamports),
      executable: false,
      rentEpoch: 0,
    });
    const tiers = feeTiersOf(feeConfig);
    // The supply may be absent from a snapshot, and an unread supply must not
    // silently become zero: without it the tier is unknown, not tier 0.
    const supply = facts.baseMintSupplyAtoms;
    const mcap =
      supply === null || facts.baseReserve === 0n
        ? null
        : poolMarketCapLamports({
            quoteReserveLamports: facts.quoteReserveRaw,
            baseReserveAtoms: facts.baseReserve,
            baseMintSupplyAtoms: supply,
          });
    const tier = mcap === null ? null : selectFeeTier(tiers, mcap);
    const tierIndex =
      tier === null
        ? null
        : tiers.findIndex((t) => t.marketCapLamportsThreshold === tier.marketCapLamportsThreshold);

    // The offline pricers already assemble the SDK's argument objects, so the probe
    // reuses them rather than rebuilding one that could differ.
    const buy = await import('../packages/solana/src/pumpswap-offline.js').then((m) =>
      m.quoteBuyFrom(src, s.pool, QUOTE_IN_LAMPORTS, SLIPPAGE),
    );
    const sell = await import('../packages/solana/src/pumpswap-offline.js').then((m) =>
      m.quoteSellFrom(src, s.pool, buy.baseOutAtoms, SLIPPAGE),
    );

    probes.push({
      pool: s.pool,
      mint: s.mint,
      baseReserve: facts.baseReserve.toString(),
      quoteReserve: facts.quoteReserveRaw.toString(),
      tierIndex,
      lpFeeBps: tier?.fees.lpFeeBps ?? null,
      protocolFeeBps: tier?.fees.protocolFeeBps ?? null,
      creatorFeeBps: tier?.fees.creatorFeeBps ?? null,
      buy: flatten(buy),
      sell: flatten(sell),
      failure: null,
    });
  } catch (err) {
    probes.push({
      pool: s.pool,
      mint: s.mint,
      baseReserve: '0',
      quoteReserve: '0',
      tierIndex: null,
      lpFeeBps: null,
      protocolFeeBps: null,
      creatorFeeBps: null,
      buy: null,
      sell: null,
      failure: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
  }
}

console.log('PHASE G §2.1 — WHICH SIDE THE FEE IS TAKEN ON, READ FROM THE PROGRAM\'S OWN CLIENT\n');
const flat = flatFeeOf(
  (() => {
    const s = snaps[0] as { manifest: string };
    const accounts = evidence.get<StoredAccount[]>(s.manifest);
    const feeRaw = accounts.find((a) => a.pubkey === PUMP_AMM_FEE_CONFIG_PDA.toBase58());
    return sdk.decodeFeeConfig({
      owner: new PublicKey((feeRaw as StoredAccount).owner),
      data: Buffer.from((feeRaw as StoredAccount).dataBase64 as string, 'base64'),
      lamports: Number((feeRaw as StoredAccount).lamports),
      executable: false,
      rentEpoch: 0,
    });
  })(),
);
console.log(`  flat fee (no tier): lp ${flat.lpFeeBps} / protocol ${flat.protocolFeeBps} / creator ${flat.creatorFeeBps} bps\n`);

for (const p of probes) {
  console.log(`  pool ${p.pool.slice(0, 12)}…  tier ${p.tierIndex ?? '?'}  lp/proto/creator ${p.lpFeeBps}/${p.protocolFeeBps}/${p.creatorFeeBps} bps`);
  if (p.failure !== null) {
    console.log(`    FAILED: ${p.failure}`);
    continue;
  }
  console.log(`    reserves base ${p.baseReserve} quote ${p.quoteReserve}`);
  console.log(`    BUY  of ${QUOTE_IN_LAMPORTS} lamports ->`);
  for (const [k, v] of Object.entries(p.buy ?? {})) console.log(`      ${k.padEnd(24)} ${v}`);
  console.log(`    SELL of the base just bought ->`);
  for (const [k, v] of Object.entries(p.sell ?? {})) console.log(`      ${k.padEnd(24)} ${v}`);
  console.log('');
}

/*
   THE MEASUREMENT THE RECONSTRUCTION ACTUALLY NEEDS.

   A roll-forward has to know how much of the TRADER's quote reaches the POOL. The
   constant-product invariant gives that without any assumption about fee plumbing:
   the SDK says how much base leaves on a buy of Q, and the invariant says what quote
   must therefore have entered.

     k          = baseReserve x (quoteReserve + virtualQuote)
     base'      = baseReserve - baseOut
     dQ_pool    = k / base' - (quoteReserve + virtualQuote)
     kept       = dQ_pool / Q_trader

   If the LP portion stays and the protocol and creator portions leave, `kept` should
   equal 1 - (protocolFeeBps + creatorFeeBps) / 10000 — which is the formula the
   directive proposed. This tests it rather than adopting it.
*/
const invariantRead: {
  pool: string;
  tierIndex: number | null;
  lpFeeBps: number | null;
  leavingBps: number | null;
  totalBps: number | null;
  keptMeasured: number | null;
  keptPredicted: number | null;
  keptPredictedGrossedUp: number | null;
  agrees: boolean | null;
  agreesGrossedUp: boolean | null;
  sellReachedTrader: number | null;
  sellPredictedGrossedUp: number | null;
  sellPredictedNetted: number | null;
}[] = [];
for (const p of probes) {
  if (p.buy === null || p.failure !== null) continue;
  const B = BigInt(p.baseReserve);
  const Q = BigInt(p.quoteReserve);
  const baseOut = BigInt(p.buy['baseOutAtoms'] ?? '0');
  const V = BigInt(p.sell?.['virtualQuoteReserves'] ?? '0');
  const leaving = (p.protocolFeeBps ?? 0) + (p.creatorFeeBps ?? 0);
  if (B === 0n || baseOut === 0n || baseOut >= B) {
    invariantRead.push({
      pool: p.pool, tierIndex: p.tierIndex, lpFeeBps: p.lpFeeBps,
      leavingBps: leaving, totalBps: null, keptMeasured: null, keptPredicted: null,
      keptPredictedGrossedUp: null, agrees: null, agreesGrossedUp: null,
      sellReachedTrader: null, sellPredictedGrossedUp: null, sellPredictedNetted: null,
    });
    continue;
  }
  const total = (p.lpFeeBps ?? 0) + leaving;
  const k = B * (Q + V);
  const dQPool = Number(k / (B - baseOut)) - Number(Q + V);
  const kept = dQPool / Number(QUOTE_IN_LAMPORTS);
  const predicted = 1 - leaving / 10_000;
  // The rival reading: the fee is charged ON TOP of the swap amount, so the trader's
  // gross quote is (swap amount) x (1 + total fee) and the pool receives the swap
  // amount alone. These two only separate where lpFeeBps is material, which is why a
  // tier-0 probe alone would not have distinguished them.
  const predictedGrossedUp = 1 / (1 + total / 10_000);
  // And the SELL side, which the directive asks about separately.
  const baseIn = BigInt(p.sell?.['baseAtomsIn'] ?? '0');
  const quoteOut = BigInt(p.sell?.['quoteOutLamports'] ?? '0');
  const dQPoolOut = baseIn === 0n ? null : Number(Q + V) - Number(k / (B + baseIn));
  const reachedTrader = dQPoolOut === null || dQPoolOut <= 0 ? null : Number(quoteOut) / dQPoolOut;
  invariantRead.push({
    pool: p.pool, tierIndex: p.tierIndex, lpFeeBps: p.lpFeeBps,
    leavingBps: leaving, totalBps: total, keptMeasured: kept, keptPredicted: predicted,
    keptPredictedGrossedUp: predictedGrossedUp,
    agrees: Math.abs(kept - predicted) < 0.0005,
    agreesGrossedUp: Math.abs(kept - predictedGrossedUp) < 0.0005,
    sellReachedTrader: reachedTrader,
    sellPredictedGrossedUp: 1 / (1 + total / 10_000),
    sellPredictedNetted: 1 - total / 10_000,
  });
}
console.log('  HOW MUCH OF THE TRADER QUOTE REACHES THE POOL, from the invariant:');
console.log('    BUY side. Two rival formulas, and they only separate where lpFeeBps is material.');
console.log('    pool           tier  lp  total   MEASURED   1-(p+c)   ok    1/(1+total)   ok');
for (const r of invariantRead) {
  const f = (v: number | null): string => (v === null ? '     n/a' : v.toFixed(6));
  console.log(
    `    ${r.pool.slice(0, 12)}…  ${String(r.tierIndex).padStart(4)} ${String(r.lpFeeBps).padStart(3)}` +
      `  ${String(r.totalBps).padStart(5)}   ${f(r.keptMeasured)}   ${f(r.keptPredicted)}  ${r.agrees === null ? 'n/a' : r.agrees ? 'YES' : ' NO'}` +
      `     ${f(r.keptPredictedGrossedUp)}  ${r.agreesGrossedUp === null ? 'n/a' : r.agreesGrossedUp ? 'YES' : ' NO'}`,
  );
}
console.log('');
console.log('    SELL side. What fraction of the quote that LEFT the pool reached the trader.');
console.log('    pool           tier  total   MEASURED   1/(1+total)   1-total');
for (const r of invariantRead) {
  const f = (v: number | null): string => (v === null ? '     n/a' : v.toFixed(6));
  console.log(
    `    ${r.pool.slice(0, 12)}…  ${String(r.tierIndex).padStart(4)}  ${String(r.totalBps).padStart(5)}   ${f(r.sellReachedTrader)}` +
      `   ${f(r.sellPredictedGrossedUp)}      ${f(r.sellPredictedNetted)}`,
  );
}
console.log('');

/*
   THE ROUND-TRIP READ.

   Buying with Q lamports and immediately selling the base received returns Q'
   lamports. With no fee and no impact Q' = Q. The shortfall is fee plus impact, and
   because the pool arithmetic is symmetric the impact halves cancel to second order
   at small size, so Q'/Q - 1 is approximately minus the round-trip fee. Comparing
   that with the tier's own totalBps says whether the fee is charged once per leg on
   the quote — and comparing the pool's implied reserve change with the trader's
   amounts says how much of it LEAVES the pool.
*/
const withBoth = probes.filter((p) => p.buy !== null && p.sell !== null);
console.log('  ROUND TRIP, 1 SOL in and straight back out:');
for (const p of withBoth) {
  const out = BigInt(p.sell?.['quoteOutLamports'] ?? '0');
  const drag = Number(out - QUOTE_IN_LAMPORTS) / Number(QUOTE_IN_LAMPORTS);
  const tierRoundTripBps = (p.lpFeeBps ?? 0) + (p.protocolFeeBps ?? 0) + (p.creatorFeeBps ?? 0);
  console.log(
    `    tier ${String(p.tierIndex).padStart(2)}  out ${out} lamports  drag ${(drag * 100).toFixed(4)}%` +
      `  against a two-leg fee of ${((2 * tierRoundTripBps) / 100).toFixed(2)}%` +
      `  (lp-only would be ${((2 * (p.lpFeeBps ?? 0)) / 100).toFixed(2)}%)`,
  );
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/phase-g-fee-direction.json',
  `${JSON.stringify(
    {
      provenance: currentProvenance({
        strategyVersion: 'delayed-momentum-v0.6.0',
        schemaVersion: 'phase-g-fee-direction-v1',
        sampleInclusionQuery:
          'the six most recent coherent_snapshots, quoted through the pinned SDK buyQuoteInput and ' +
          'sellBaseInput against their own stored global config, fee config, pool and base mint',
      }),
      label: 'DEVELOPMENT_RECONSTRUCTED',
      isEvidence: false,
      directive: 'Phase G §2.1',
      quoteInLamports: QUOTE_IN_LAMPORTS.toString(),
      slippagePct: SLIPPAGE,
      flatFee: flat,
      invariantRead,
      probes,
    },
    null,
    2,
  )}\n`,
);
console.log('\n  artifact           artifacts/phase-g-fee-direction.json');
db.close();
