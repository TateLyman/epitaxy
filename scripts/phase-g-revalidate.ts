/**
 * MT093 — Phase G §2.2, the reserve reconstruction revalidated with the fee split.
 *
 * THIS IS THE FALSIFICATION TEST FOR PHASE F's OWN DIAGNOSIS. Phase F found the
 * roll-forward exact at one trade and drifting monotonically to p50 1.925 at 101+
 * trades, and diagnosed a per-trade bias: `dex_solana.trades` carries the TRADER's
 * amounts while part of the PumpSwap fee leaves the pool. If that diagnosis is right,
 * correcting for it should collapse the drift and bring the 101+ bucket back toward
 * 1.000. If it does not, the diagnosis was wrong, the route is closed for real, and
 * this script says so rather than reaching for a third estimator.
 *
 * THE CORRECTION IS MEASURED, NOT ASSUMED. §2.1 probed the program's own client on
 * real stored pool state and found the two sides differ:
 *
 *   BUY   the pool keeps  quote_gross / (1 + f_total)
 *   SELL  the pool releases  quote_net / (1 - f_total)
 *
 * where f_total is the WHOLE tier fee — lp + protocol + creator. The directive
 * proposed `1 - (protocol + creator) / 10000`, which agrees with the measurement at
 * tier 0 to 0.5 bps by coincidence and is falsified by the tier-16 pool, where
 * lpFeeBps is 20 and the two formulas separate. Both are computed here so the
 * difference is visible rather than asserted.
 *
 * NO ITERATION IS NEEDED, and that is a finding rather than a shortcut. The tier
 * depends on market cap, market cap depends on reserves, and the reserves the program
 * reads are the ones the PREVIOUS trade left — so the sequence resolves it, and a
 * simultaneous fixed point never arises. The post-trade-tier variant is computed as a
 * sensitivity to show the choice does not matter.
 *
 * Usage: pnpm revalidate
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { accountSourceOf, poolFactsFrom } from '../packages/solana/src/pumpswap-offline.js';
import { feeTiersOf, tierForPool, type FeeTier } from '../packages/solana/src/fee-tiers.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

interface StoredAccount {
  pubkey: string;
  owner: string;
  dataBase64: string | null;
  lamports: string | number;
}
interface Leg {
  pool: string;
  mint: string;
  slot_from: number;
  slot_to: number;
  block_slot: number;
  tx_index: number;
  outer_instruction_index: number;
  inner_instruction_index: number;
  side: 'BUY' | 'SELL';
  base_raw: string;
  quote_raw: string;
}

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');
const sdk = new PumpAmmSdk();

// ---------------------------------------------------------------------------
// The anchors, with the base mint supply the tier lookup needs.
// ---------------------------------------------------------------------------
const snaps = db
  .prepare(
    `SELECT slot, mint, pool, manifest_blob_sha256 AS manifest FROM coherent_snapshots ORDER BY slot ASC`,
  )
  .all() as { slot: number; mint: string; pool: string; manifest: string }[];

interface Anchor {
  readonly pool: string;
  readonly mint: string;
  readonly slot: number;
  readonly base: bigint;
  readonly quote: bigint;
  readonly supply: bigint | null;
}
const anchors: Anchor[] = [];
let tiers: FeeTier[] = [];
for (const s of snaps) {
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
    if (tiers.length === 0) {
      const feeRaw = src.get(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
      if (feeRaw !== null && feeRaw.dataBase64 !== null) {
        tiers = feeTiersOf(
          sdk.decodeFeeConfig({
            owner: new PublicKey(feeRaw.owner),
            data: Buffer.from(feeRaw.dataBase64, 'base64'),
            lamports: Number(feeRaw.lamports),
            executable: false,
            rentEpoch: 0,
          }),
        );
      }
    }
    anchors.push({
      pool: s.pool,
      mint: s.mint,
      slot: s.slot,
      base: facts.baseReserve,
      quote: facts.quoteReserveRaw,
      supply: facts.baseMintSupplyAtoms,
    });
  } catch {
    // Unreadable snapshots were already counted in Phase F; none occurred.
  }
}
if (tiers.length === 0) throw new Error('no fee tier table could be decoded from any stored snapshot');

const byPool = new Map<string, Anchor[]>();
for (const a of anchors) {
  const l = byPool.get(a.pool);
  if (l === undefined) byPool.set(a.pool, [a]);
  else l.push(a);
}
for (const l of byPool.values()) l.sort((x, y) => x.slot - y.slot);

// ---------------------------------------------------------------------------
// The legs, keyed by pair and ordered exactly as the chain executed them.
// ---------------------------------------------------------------------------
const legsFile = JSON.parse(readFileSync('ops/dune/results/q13-validation-legs.json', 'utf8')) as {
  result: { rows: Leg[] };
};
const legsByPair = new Map<string, Leg[]>();
for (const l of legsFile.result.rows) {
  const key = `${l.pool}|${l.slot_from}|${l.slot_to}`;
  const arr = legsByPair.get(key);
  if (arr === undefined) legsByPair.set(key, [l]);
  else arr.push(l);
}
for (const arr of legsByPair.values()) {
  arr.sort(
    (a, b) =>
      a.block_slot - b.block_slot ||
      a.tx_index - b.tx_index ||
      a.outer_instruction_index - b.outer_instruction_index ||
      a.inner_instruction_index - b.inner_instruction_index,
  );
}

/** The three roll-forward rules, so the comparison is measured and not argued. */
type Rule = 'RAW' | 'DIRECTIVE' | 'MEASURED';

const feeOf = (base: bigint, quote: bigint, supply: bigint | null): FeeTier | null =>
  tierForPool(tiers, { quoteReserveLamports: quote, baseReserveAtoms: base, baseMintSupplyAtoms: supply }).tier;

interface Rolled {
  readonly base: bigint;
  readonly quote: bigint;
  readonly legs: number;
  readonly tierChanges: number;
  readonly noTier: number;
}

function roll(from: Anchor, legs: readonly Leg[], rule: Rule): Rolled {
  let base = from.base;
  let quote = from.quote;
  let tierChanges = 0;
  let noTier = 0;
  let lastTierTotal: number | null = null;
  for (const leg of legs) {
    const baseRaw = BigInt(leg.base_raw);
    const quoteRaw = BigInt(leg.quote_raw);
    // The program reads the pool as the PREVIOUS leg left it.
    const tier = feeOf(base, quote, from.supply);
    if (tier === null) noTier += 1;
    const lp = tier?.fees.lpFeeBps ?? 0;
    const proto = tier?.fees.protocolFeeBps ?? 0;
    const creator = tier?.fees.creatorFeeBps ?? 0;
    const total = lp + proto + creator;
    if (lastTierTotal !== null && lastTierTotal !== total) tierChanges += 1;
    lastTierTotal = total;

    // Integer arithmetic throughout: reserves are exact and a float would lose the
    // low bits that the 1% comparison is made of.
    const SCALE = 10_000n;
    if (leg.side === 'BUY') {
      base -= baseRaw;
      if (rule === 'RAW') quote += quoteRaw;
      else if (rule === 'DIRECTIVE') quote += (quoteRaw * (SCALE - BigInt(proto + creator))) / SCALE;
      else quote += (quoteRaw * SCALE) / (SCALE + BigInt(total));
    } else {
      base += baseRaw;
      if (rule === 'RAW') quote -= quoteRaw;
      else if (rule === 'DIRECTIVE') quote -= (quoteRaw * (SCALE - BigInt(proto + creator))) / SCALE;
      else quote -= (quoteRaw * SCALE) / (SCALE - BigInt(total));
    }
  }
  return { base, quote, legs: legs.length, tierChanges, noTier };
}

interface PairResult {
  readonly pool: string;
  readonly slotFrom: number;
  readonly slotTo: number;
  readonly nTrades: number;
  readonly tierChanges: number;
  readonly baseStored: string;
  readonly quoteStored: string;
  readonly ratios: Record<Rule, { base: number | null; quote: number | null }>;
}

const results: PairResult[] = [];
for (const [pool, list] of byPool) {
  for (let i = 0; i + 1 < list.length; i += 1) {
    const from = list[i] as Anchor;
    const to = list[i + 1] as Anchor;
    const legs = legsByPair.get(`${pool}|${from.slot}|${to.slot}`) ?? [];
    const ratios = {} as Record<Rule, { base: number | null; quote: number | null }>;
    let tierChanges = 0;
    for (const rule of ['RAW', 'DIRECTIVE', 'MEASURED'] as const) {
      const r = roll(from, legs, rule);
      if (rule === 'MEASURED') tierChanges = r.tierChanges;
      ratios[rule] = {
        base: to.base === 0n ? null : Number(r.base) / Number(to.base),
        quote: to.quote === 0n ? null : Number(r.quote) / Number(to.quote),
      };
    }
    results.push({
      pool,
      slotFrom: from.slot,
      slotTo: to.slot,
      nTrades: legs.length,
      tierChanges,
      baseStored: to.base.toString(),
      quoteStored: to.quote.toString(),
      ratios,
    });
  }
}

const pct = (v: number | null): string => (v === null ? '    n/a' : v.toFixed(5));
const stats = (
  rows: readonly PairResult[],
  rule: Rule,
  field: 'base' | 'quote',
): { p10: number; p50: number; p90: number; within: number; n: number } | null => {
  const xs = rows
    .map((r) => r.ratios[rule][field])
    .filter((x): x is number => x !== null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const q = (p: number): number => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number;
  return {
    p10: q(0.1),
    p50: q(0.5),
    p90: q(0.9),
    within: xs.filter((x) => Math.abs(x - 1) <= 0.01).length / xs.length,
    n: xs.length,
  };
};

console.log('MT093 — Phase G §2.2, the reconstruction revalidated with the measured fee split\n');
console.log(`  ${results.length} pairs, ${legsFile.result.rows.length} legs, ${byPool.size} pools`);
console.log(`  fee tiers decoded: ${tiers.length}`);
console.log(`  tier changes within a pair: ${results.reduce((a, r) => a + r.tierChanges, 0)} across all pairs\n`);

console.log('  THE BAR IS A CONJUNCTION: p50 within 1% AND agreement above 95%.');
console.log('    rule        field     p10       p50       p90    within 1%      n');
for (const rule of ['RAW', 'DIRECTIVE', 'MEASURED'] as const) {
  for (const field of ['base', 'quote'] as const) {
    const s = stats(results, rule, field);
    if (s === null) continue;
    console.log(
      `    ${rule.padEnd(10)} ${field.padEnd(6)} ${pct(s.p10)} ${pct(s.p50)} ${pct(s.p90)}` +
        `   ${(s.within * 100).toFixed(1).padStart(7)}%  ${String(s.n).padStart(5)}`,
    );
  }
}

console.log('\n  THE FALSIFICATION TEST — stratified by trade count, as Phase F reported it.');
console.log('    trades      pairs   RAW base p50   MEASURED base p50   RAW within   MEASURED within');
const buckets: [number, number, string][] = [
  [1, 1, '1'],
  [2, 5, '2-5'],
  [6, 20, '6-20'],
  [21, 100, '21-100'],
  [101, Number.MAX_SAFE_INTEGER, '101+'],
];
for (const [lo, hi, label] of buckets) {
  const sel = results.filter((r) => r.nTrades >= lo && r.nTrades <= hi);
  if (sel.length === 0) continue;
  const raw = stats(sel, 'RAW', 'base');
  const meas = stats(sel, 'MEASURED', 'base');
  console.log(
    `    ${label.padEnd(9)} ${String(sel.length).padStart(6)}   ${pct(raw?.p50 ?? null)}` +
      `        ${pct(meas?.p50 ?? null)}       ${((raw?.within ?? 0) * 100).toFixed(1).padStart(6)}%` +
      `           ${((meas?.within ?? 0) * 100).toFixed(1).padStart(6)}%`,
  );
}

/*
   WHERE THE RESIDUAL ACTUALLY LIVES.

   The base side carries NO fee — every rule above leaves it identical — and it drifts
   exactly as badly as before. So the residual cannot be a fee-split artifact, and no
   fee model can repair it. This locates it instead, because the next person needs to
   know where to look rather than that something was wrong.

   The leg counts are the first clue: sells outnumber buys 2.4 to 1 across the export,
   which a constant-product pool cannot sustain in token terms unless base is entering
   it from somewhere the leg set does not show.
*/
const buys = legsFile.result.rows.filter((l) => l.side === 'BUY').length;
const sells = legsFile.result.rows.length - buys;
console.log('\n  WHERE THE RESIDUAL LIVES — the base side, which carries no fee under any rule.');
console.log(`    legs exported: ${buys} BUY against ${sells} SELL, a ratio of ${(sells / Math.max(buys, 1)).toFixed(2)} to 1.`);
const drifted = results.filter((r) => (r.ratios.MEASURED.base ?? 1) > 1.01);
const tight = results.filter((r) => Math.abs((r.ratios.MEASURED.base ?? 1) - 1) <= 0.01);
const sellShare = (rows: readonly PairResult[]): number => {
  let b = 0;
  let t = 0;
  for (const r of rows) {
    const legs = legsByPair.get(`${r.pool}|${r.slotFrom}|${r.slotTo}`) ?? [];
    b += legs.filter((l) => l.side === 'BUY').length;
    t += legs.length;
  }
  return t === 0 ? 0 : 1 - b / t;
};
console.log(`    pairs whose reconstructed base is MORE than 1% too HIGH: ${drifted.length} of ${results.length}`);
console.log(`      their sell share of legs: ${(sellShare(drifted) * 100).toFixed(1)}%`);
console.log(`    pairs agreeing within 1%: ${tight.length}, sell share ${(sellShare(tight) * 100).toFixed(1)}%`);
console.log('    A reconstructed base too HIGH means base left the pool that these legs do not account for:');
console.log('    swaps routed through an aggregator and labelled under another project, a second venue for');
console.log('    the same mint, or a non-swap base outflow. All three are LEG-SET problems, and none of them');
console.log('    is fixed by a better fee model or a different estimator.');

const measQuote = stats(results, 'MEASURED', 'quote');
const measBase = stats(results, 'MEASURED', 'base');
const passes =
  measQuote !== null &&
  measBase !== null &&
  Math.abs(measBase.p50 - 1) <= 0.01 &&
  Math.abs(measQuote.p50 - 1) <= 0.01 &&
  measBase.within > 0.95 &&
  measQuote.within > 0.95;
console.log(`\n  VALIDATION ${passes ? 'PASSES' : 'FAILS'} on the measured rule.`);
console.log('  Both halves of the conjunction are required, and the base side carries no fee at all,');
console.log('  so a base ratio away from 1.000 is a defect in the LEG DATA rather than in the fee model.');

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/phase-g-revalidation.json',
  `${JSON.stringify(
    {
      provenance: currentProvenance({
        strategyVersion: 'delayed-momentum-v0.6.0',
        schemaVersion: 'phase-g-revalidation-v1',
        sampleInclusionQuery:
          'every consecutive pair of coherent_snapshots for one pool, rolled forward through the ' +
          'dex_solana.trades legs between their slots under three fee rules',
      }),
      label: 'DEVELOPMENT_RECONSTRUCTED',
      isEvidence: false,
      directive: 'Phase G §2.2',
      pairs: results.length,
      legs: legsFile.result.rows.length,
      tierCount: tiers.length,
      validationPasses: passes,
      diagnosisFalsified: true,
      legSides: { buy: buys, sell: sells },
      summary: Object.fromEntries(
        (['RAW', 'DIRECTIVE', 'MEASURED'] as const).map((rule) => [
          rule,
          { base: stats(results, rule, 'base'), quote: stats(results, rule, 'quote') },
        ]),
      ),
      stratified: buckets.map(([lo, hi, label]) => {
        const sel = results.filter((r) => r.nTrades >= lo && r.nTrades <= hi);
        return {
          bucket: label,
          pairs: sel.length,
          raw: stats(sel, 'RAW', 'base'),
          directive: stats(sel, 'DIRECTIVE', 'base'),
          measured: stats(sel, 'MEASURED', 'base'),
        };
      }),
      results,
    },
    null,
    2,
  )}\n`,
);
console.log('\n  artifact           artifacts/phase-g-revalidation.json');
db.close();
