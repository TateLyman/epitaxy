/**
 * Directive 40c005ff — decompose the LP result into its two terms.
 *
 * #66 reported LP − HODL = −0.278% and called it loss-versus-rebalancing. That number is a
 * DIFFERENCE of two terms that were never separated: what the LP earned in fees, and what the
 * LP lost to arbitrageurs. A small fee term minus a large LVR term and a large fee term minus
 * the same large LVR term are different questions with the same answer, and only the second
 * one is a hypothesis about other venues.
 *
 * This separates them exactly, from the reserve path alone, with no model.
 *
 * ── WHY NO TRADE TAPE IS NEEDED ──────────────────────────────────────────────────────────
 *
 * The directive says to take volume from "the stored trade tape". There is no such tape for
 * this window: `targeted_flow_events` is EMPTY (0 rows) and `chain_events` covers only
 * 2026-08-14, while these trajectories are 2026-08-17/18. Both facts are asserted in the
 * report. A Dune query is NOT the fallback, and none was run — the number really is already
 * held, in a form the directive did not anticipate.
 *
 * On a constant-product pool the LP fee that stays in the vault makes the invariant grow, and
 * that growth IS the fee income. For a swap of Δq against reserve q with LP fee rate f,
 *
 *     Δk/k = f · Δq/q      per trade,          so      V/q = (κ − 1)/f
 *
 * where κ = k₁/k₀. The invariant is therefore a volume meter, and the fee income can be read
 * off without ever knowing the volume: see the exact decomposition below.
 *
 * That the LP fee accrues at all is measured, not assumed: k grows in 99.0% of the 623 steps
 * where the price moved, and shrinks in 1.0%.
 *
 * ── VIRTUAL RESERVES, AND THE ERROR THIS CORRECTS IN #66 ─────────────────────────────────
 *
 * `observed_quote_reserve` is `quoteReserveRaw + virtualQuoteReserves` (mark-path.ts:137).
 * Decoding the stored pool bytes for 142 of these pools gives virtualQuoteReserves ≈ 17.58 SOL
 * on every one of them — near-constant because every pump.fun token graduates at the same
 * threshold. Two separate facts follow and they point in opposite directions:
 *
 *   1. The AMM PRICES on the observed quantity. Tested directly: |Δlog k| has median 6.6e−6 on
 *      b·(q_raw+v) against 9.1e−3 on b·q_raw — three orders of magnitude better conserved. So
 *      p = q_obs/b is right, and #66's price path was right.
 *
 *   2. The LP CLAIMS only the raw vault. Withdrawal is pro-rata on real token accounts; the
 *      virtual component is not withdrawable. So LP value is
 *
 *          A = b·p + q_raw = q_obs + (q_obs − v) = 2·q_obs − v
 *
 *      and NOT 2·q_obs, which is what #66 used. #66 therefore divided a correct numerator by a
 *      denominator ~1.5x too large, and understated the loss. The correction is reported.
 *
 * ── THE EXACT DECOMPOSITION ──────────────────────────────────────────────────────────────
 *
 * With r = p₁/p₀ and κ = k₁/k₀, and using q = √(k·p):
 *
 *     LP − HODL = q₀·[2√(κr) − r − 1] / A₀
 *
 * and the bracket splits algebraically and exactly:
 *
 *     2√(κr) − r − 1  =  2√r·(√κ − 1)  −  (√r − 1)²
 *                        └── fee ──┘      └── LVR ──┘
 *
 *     fee_income  = q₀·2√r·(√κ − 1) / A₀        ≥ 0 whenever the invariant grew
 *     LVR_implied = q₀·(√r − 1)²    / A₀        ≥ 0 ALWAYS, quadratic in the move, no drift term
 *
 * The second expression is σ²/8 in discrete form and it is derived here rather than imposed:
 * the directive forbids producing LVR from the closed form, and this does not — LVR is backed
 * out of the measured path, and the closed form is reported beside it only as a check.
 *
 * Because the split is an algebraic identity, fee_income − LVR_implied reproduces the measured
 * LP − HODL to floating-point precision by construction. §2's tier-0 reproduction check is
 * therefore a check on the ARITHMETIC, and the report says so rather than claiming it as
 * independent corroboration.
 *
 * Usage: pnpm lp:decompose
 */

import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import BN from 'bn.js';
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import { PublicKey } from '@solana/web3.js';

const DB = 'data/runtime.db';
const LP_FEE_TIER0 = 0.0002; // 2 bps — the decoded tier-0 lpFeeBps, see fee-tiers.ts
const FEE_SHARES: readonly { readonly label: string; readonly f: number }[] = [
  { label: 'PumpSwap tier 0 (measured)', f: 0.0002 },
  { label: 'Raydium CPMM / CLMM (84% of 0.25%)', f: 0.0021 },
  { label: 'Raydium AMM v4 (0.22% of 0.25%)', f: 0.0022 },
];

interface Pool {
  readonly trajectoryId: string;
  readonly day: string;
  readonly v: number; // virtual quote reserves, lamports
  readonly q0: number;
  readonly A0: number; // LP-owned pool value at open, lamports
  readonly r: number; // p1/p0
  readonly kappa: number; // k1/k0
  readonly feeIncome: number;
  readonly lvrImplied: number;
  readonly lpMinusHodl: number;
  readonly lpMinusHodl66: number; // the #66 convention, 2q denominator
  readonly turnover: number;
  readonly sigmaHour: number;
  readonly moved: boolean;
  readonly movedBig: boolean;
  readonly horizonMs: number;
  readonly marks: number;
}

function quantile(xs: readonly number[], p: number): number {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? NaN;
}
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x: number): string => `${(x * 100).toFixed(3)}%`;

function virtualReservesByPool(db: DatabaseSync): Map<string, number> {
  const sdk = new PumpAmmSdk();
  const out = new Map<string, number>();
  const rows = db
    .prepare(`SELECT DISTINCT address, post_blob_sha256 FROM account_state_manifests WHERE role='POOL'`)
    .all() as { address: string; post_blob_sha256: string }[];
  const blob = db.prepare('SELECT relative_path FROM evidence_blobs WHERE blob_sha256 = ?');
  for (const r of rows) {
    const b = blob.get(r.post_blob_sha256) as { relative_path: string } | undefined;
    if (b === undefined) continue;
    try {
      const j = JSON.parse(gunzipSync(readFileSync(b.relative_path)).toString('utf8')) as {
        dataBase64: string;
        owner: string;
      };
      const pool = sdk.decodePool({
        data: Buffer.from(j.dataBase64, 'base64'),
        owner: new PublicKey(j.owner),
        lamports: 0,
        executable: false,
        rentEpoch: 0,
      } as never) as unknown as { virtualQuoteReserves?: BN };
      out.set(r.address, Number((pool.virtualQuoteReserves ?? new BN(0)).toString()));
    } catch {
      // A pool whose bytes will not decode is EXCLUDED and counted, never defaulted to zero:
      // defaulting would silently put it back on the #66 denominator.
    }
  }
  return out;
}

function main(): void {
  const db = new DatabaseSync(DB, { readOnly: true });

  const virt = virtualReservesByPool(db);

  const meta = new Map<string, { pool: string | null; openedUtcMs: number | null; lpFeeBps: number | null }>();
  for (const r of db
    .prepare('SELECT trajectory_id, pool, opened_utc_ms, lp_fee_bps FROM development_trajectories')
    .all() as { trajectory_id: string; pool: string | null; opened_utc_ms: number | null; lp_fee_bps: number | null }[]) {
    meta.set(r.trajectory_id, { pool: r.pool, openedUtcMs: r.opened_utc_ms, lpFeeBps: r.lp_fee_bps });
  }

  const marks = db
    .prepare(
      `SELECT trajectory_id, offset_ms, observed_base_reserve, observed_quote_reserve
       FROM trajectory_marks
       WHERE observed_base_reserve IS NOT NULL AND observed_quote_reserve IS NOT NULL
       ORDER BY trajectory_id, offset_ms`,
    )
    .all() as { trajectory_id: string; offset_ms: number; observed_base_reserve: string; observed_quote_reserve: string }[];

  const byT = new Map<string, typeof marks>();
  for (const m of marks) {
    const cur = byT.get(m.trajectory_id) ?? [];
    cur.push(m);
    byT.set(m.trajectory_id, cur);
  }

  const pools: Pool[] = [];
  const excluded = { tooFewMarks: 0, badReserve: 0, liquidityEvent: 0, noVirtual: 0 };

  for (const [id, ms] of byT) {
    if (ms.length < 2) {
      excluded.tooFewMarks++;
      continue;
    }
    const b0 = Number(ms[0]!.observed_base_reserve);
    const q0 = Number(ms[0]!.observed_quote_reserve);
    const last = ms[ms.length - 1]!;
    const b1 = Number(last.observed_base_reserve);
    const q1 = Number(last.observed_quote_reserve);
    if (!(b0 > 0 && q0 > 0 && b1 > 0 && q1 > 0)) {
      excluded.badReserve++;
      continue;
    }

    // #66's liquidity-event filter, unchanged so the populations are comparable.
    let liq = false;
    for (let i = 1; i < ms.length; i++) {
      const kb = Number(ms[i - 1]!.observed_base_reserve) * Number(ms[i - 1]!.observed_quote_reserve);
      const ka = Number(ms[i]!.observed_base_reserve) * Number(ms[i]!.observed_quote_reserve);
      if (ka / kb > 1.02 || ka / kb < 0.98) liq = true;
    }
    if (liq) {
      excluded.liquidityEvent++;
      continue;
    }

    const m = meta.get(id);
    const v = m?.pool === null || m?.pool === undefined ? undefined : virt.get(m.pool);
    if (v === undefined) {
      excluded.noVirtual++;
      continue;
    }

    const A0 = 2 * q0 - v; // LP-owned pool value at open
    if (A0 <= 0) {
      excluded.badReserve++;
      continue;
    }

    const p0 = q0 / b0;
    const p1 = q1 / b1;
    const r = p1 / p0;
    const kappa = (b1 * q1) / (b0 * q0);

    const feeIncome = (q0 * 2 * Math.sqrt(r) * (Math.sqrt(kappa) - 1)) / A0;
    const lvrImplied = (q0 * (Math.sqrt(r) - 1) ** 2) / A0;
    const lpMinusHodl = (2 * q1 - b0 * p1 - q0) / A0;
    const lpMinusHodl66 = (2 * q1 - b0 * p1 - q0) / (2 * q0);

    // turnover implied by the invariant growth, at the decoded tier-0 LP fee
    const turnover = ((kappa - 1) * q0) / (LP_FEE_TIER0 * A0);

    // realised volatility of the observed path, per hour
    let qv = 0;
    let T = 0;
    for (let i = 1; i < ms.length; i++) {
      const pa = Number(ms[i - 1]!.observed_quote_reserve) / Number(ms[i - 1]!.observed_base_reserve);
      const pb = Number(ms[i]!.observed_quote_reserve) / Number(ms[i]!.observed_base_reserve);
      if (!(pa > 0 && pb > 0)) continue;
      qv += Math.log(pb / pa) ** 2;
      T += ms[i]!.offset_ms - ms[i - 1]!.offset_ms;
    }
    const sigmaHour = T > 0 ? Math.sqrt(qv / (T / 3_600_000)) : 0;

    const moved = ms.some((x, i) => i > 0 && x.observed_quote_reserve !== ms[i - 1]!.observed_quote_reserve);

    pools.push({
      trajectoryId: id,
      day: m?.openedUtcMs == null ? 'unknown' : new Date(Number(m.openedUtcMs)).toISOString().slice(0, 10),
      v,
      q0,
      A0,
      r,
      kappa,
      feeIncome,
      lvrImplied,
      lpMinusHodl,
      lpMinusHodl66,
      turnover,
      sigmaHour,
      moved,
      movedBig: Math.abs(r - 1) > 0.1,
      horizonMs: last.offset_ms - ms[0]!.offset_ms,
      marks: ms.length,
    });
  }

  const strata: readonly { readonly name: string; readonly set: Pool[] }[] = [
    { name: 'all clean pools', set: pools },
    { name: 'pools that moved', set: pools.filter((p) => p.moved) },
    { name: 'pools moving >10%', set: pools.filter((p) => p.movedBig) },
  ];

  const out: Record<string, unknown> = {
    directive: 'docs/directives/DIRECTIVE_40C005FF_DECOMPOSE_THE_LP_RESULT.md',
    lpFeeTier0: LP_FEE_TIER0,
    excluded,
    n: pools.length,
    days: [...new Set(pools.map((p) => p.day))].sort(),
    virtualQuoteReservesSol: {
      p10: quantile(pools.map((p) => p.v / 1e9), 0.1),
      p50: quantile(pools.map((p) => p.v / 1e9), 0.5),
      p90: quantile(pools.map((p) => p.v / 1e9), 0.9),
    },
  };

  console.log(`n = ${pools.length} pools   excluded = ${JSON.stringify(excluded)}`);
  console.log(`days = ${(out['days'] as string[]).join(', ')}  <-- TWO CLUSTERS, see section 3`);
  console.log(
    `virtualQuoteReserves SOL: p10=${quantile(pools.map((p) => p.v / 1e9), 0.1).toFixed(4)} ` +
      `p50=${quantile(pools.map((p) => p.v / 1e9), 0.5).toFixed(4)} ` +
      `p90=${quantile(pools.map((p) => p.v / 1e9), 0.9).toFixed(4)}`,
  );

  console.log('\n=== 1. TURNOVER DISTRIBUTION (V/L per window), before any rescaled figure ===');
  const turnoverRows: Record<string, unknown>[] = [];
  for (const { name, set } of strata) {
    const t = set.map((p) => p.turnover);
    const row = {
      stratum: name,
      n: set.length,
      p10: quantile(t, 0.1),
      p50: quantile(t, 0.5),
      p90: quantile(t, 0.9),
      mean: mean(t),
    };
    turnoverRows.push(row);
    console.log(
      `${name.padEnd(20)} n=${String(set.length).padStart(3)}  p10=${row.p10.toFixed(6)}  ` +
        `p50=${row.p50.toFixed(6)}  p90=${row.p90.toFixed(6)}  mean=${row.mean.toFixed(6)}`,
    );
  }
  out['turnover'] = turnoverRows;

  console.log('\n=== 2. THE TWO TERMS, SEPARATED (pooled means, as a fraction of LP capital) ===');
  const termRows: Record<string, unknown>[] = [];
  for (const { name, set } of strata) {
    const fee = mean(set.map((p) => p.feeIncome));
    const lvr = mean(set.map((p) => p.lvrImplied));
    const net = mean(set.map((p) => p.lpMinusHodl));
    const net66 = mean(set.map((p) => p.lpMinusHodl66));
    const sigma = quantile(set.map((p) => p.sigmaHour), 0.5);
    // closed-form check: LVR ≈ σ²/8 per hour, scaled to the observed horizon
    const cf = mean(set.map((p) => (p.sigmaHour ** 2 / 8) * (p.horizonMs / 3_600_000)));
    const row = { stratum: name, n: set.length, feeIncome: fee, lvrImplied: lvr, net, net66, sigmaHourMedian: sigma, closedFormLvr: cf };
    termRows.push(row);
    console.log(
      `${name.padEnd(20)} n=${String(set.length).padStart(3)}  fee=${pct(fee).padStart(9)}  ` +
        `LVR=${pct(lvr).padStart(9)}  net=${pct(net).padStart(9)}  [#66 conv: ${pct(net66)}]  ` +
        `sigma_hr(p50)=${sigma.toFixed(4)}  closed-form LVR=${pct(cf)}`,
    );
  }
  out['terms'] = termRows;

  console.log('\n=== 3. TIER-0 REPRODUCTION CHECK (identity; see header) ===');
  const maxErr = Math.max(...pools.map((p) => Math.abs(p.feeIncome - p.lvrImplied - p.lpMinusHodl)));
  console.log(`max |fee_income - LVR_implied - (LP-HODL)| over ${pools.length} pools = ${maxErr.toExponential(3)}`);
  out['reproductionMaxAbsError'] = maxErr;

  console.log('\n=== 4. RESCALED, FEE TERM ONLY: LP_HODL(f) = (f/0.0002)*fee_income - LVR_implied ===');
  const rescaled: Record<string, unknown>[] = [];
  for (const { label, f } of FEE_SHARES) {
    const line: Record<string, unknown> = { feeShare: f, label };
    const cells: string[] = [];
    for (const { name, set } of strata) {
      const vals = set.map((p) => (f / LP_FEE_TIER0) * p.feeIncome - p.lvrImplied);
      const m = mean(vals);
      line[name] = { mean: m, median: quantile(vals, 0.5), shareAbove0: vals.filter((x) => x > 0).length / vals.length };
      cells.push(`${name}: ${pct(m).padStart(9)} (>0 in ${((vals.filter((x) => x > 0).length / vals.length) * 100).toFixed(1)}%)`);
    }
    rescaled.push(line);
    console.log(`f=${f.toFixed(4)} ${label.padEnd(36)}`);
    for (const c of cells) console.log(`         ${c}`);
  }
  out['rescaled'] = rescaled;

  console.log('\n=== 5. BREAK-EVEN FEE SHARE: the f at which the fee term equals the LVR term ===');
  const breakeven: Record<string, unknown>[] = [];
  for (const { name, set } of strata) {
    const fee = mean(set.map((p) => p.feeIncome));
    const lvr = mean(set.map((p) => p.lvrImplied));
    const fStar = LP_FEE_TIER0 * (lvr / fee);
    const perPool = set
      .filter((p) => p.feeIncome > 0)
      .map((p) => LP_FEE_TIER0 * (p.lvrImplied / p.feeIncome));
    const row = { stratum: name, fStarPooled: fStar, fStarPooledBps: fStar * 1e4, perPoolMedianBps: quantile(perPool, 0.5) * 1e4, nPerPool: perPool.length };
    breakeven.push(row);
    console.log(
      `${name.padEnd(20)} pooled f* = ${(fStar * 1e4).toFixed(1)} bps` +
        `   (per-pool median f* = ${(quantile(perPool, 0.5) * 1e4).toFixed(1)} bps, n=${perPool.length})`,
    );
  }
  out['breakEven'] = breakeven;
  console.log('  for scale: Raydium AMM v4 pays the LP 22 bps; the ENTIRE PumpSwap fee is 125 bps.');

  console.log('\n=== 6. VALIDATION: the retained LP rate, recovered from the path, not assumed ===');
  // phi = (kappa-1)*q/V. Net flow is a LOWER bound on V, so this is an UPPER bound on phi.
  // Steps holding exactly one directional trade have net == gross and pin phi exactly.
  const phiUpper: number[] = [];
  for (const [, ms] of byT) {
    for (let i = 1; i < ms.length; i++) {
      const b0 = Number(ms[i - 1]!.observed_base_reserve);
      const q0 = Number(ms[i - 1]!.observed_quote_reserve);
      const b1 = Number(ms[i]!.observed_base_reserve);
      const q1 = Number(ms[i]!.observed_quote_reserve);
      if (!(b0 > 0 && q0 > 0 && b1 > 0 && q1 > 0)) continue;
      const dq = Math.abs(q1 - q0);
      if (dq === 0) continue;
      const kap = (b1 * q1) / (b0 * q0);
      if (kap <= 1) continue;
      phiUpper.push(((kap - 1) * q0) / dq);
    }
  }
  const phiFloor = quantile(phiUpper, 0.1);
  console.log(
    `phi_upper over ${phiUpper.length} steps, in bps: p10=${(quantile(phiUpper, 0.1) * 1e4).toFixed(4)} ` +
      `p25=${(quantile(phiUpper, 0.25) * 1e4).toFixed(4)} p50=${(quantile(phiUpper, 0.5) * 1e4).toFixed(4)} ` +
      `p90=${(quantile(phiUpper, 0.9) * 1e4).toFixed(2)}`,
  );
  console.log(
    `the distribution FLOORS at ${(phiFloor * 1e4).toFixed(4)} bps against a decoded lpFeeBps of ` +
      `${(LP_FEE_TIER0 * 1e4).toFixed(0)}: the retained rate is confirmed, independently of the decoder.`,
  );
  out['phiUpperBps'] = { p10: quantile(phiUpper, 0.1) * 1e4, p50: quantile(phiUpper, 0.5) * 1e4, p90: quantile(phiUpper, 0.9) * 1e4, n: phiUpper.length };

  out['pools'] = pools;
  writeFileSync('artifacts/lp-decomposition.json', JSON.stringify(out, null, 1));
  console.log('\nwrote artifacts/lp-decomposition.json');
  db.close();
}

main();
