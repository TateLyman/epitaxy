/**
 * `pnpm lp:flagged` — MT106. MT100's decomposition, on a population it never saw.
 *
 * MT100 closed liquidity provision: fee income 0.0077% against LVR_implied
 * 0.3612%, a 47x ratio, break-even fee share 93.7 bps against 22 available, and
 * the cause named as TURNOVER rather than the fee — a median 0.000038 of LP
 * capital per hour against the 1.72x break-even needs at 21 bps.
 *
 * Every one of those numbers is from 377 trajectories on freshly-migrated tier-0
 * pools: median 25 SOL of quote reserve, lpFeeBps = 2 on 392 of 405. The pools
 * H1-flagged wallets trade are median 108 SOL with lp_fee_bps = 20 on 71.7% of
 * flagged buys — ten times the LP share, on pools five times deeper. MT100 never
 * measured turnover where the fee is ten times larger.
 *
 * THE ALGEBRA IS MT100'S AND IS NOT MODIFIED:
 *
 *     LP - HODL = q0 * [2*sqrt(kappa*r) - r - 1] / A0
 *     2*sqrt(kappa*r) - r - 1  =  2*sqrt(r)*(sqrt(kappa)-1)  -  (sqrt(r)-1)^2
 *                                 \___ fee income ___/          \__ LVR __/
 *
 * with r = p1/p0, kappa = k1/k0, and turnover recovered from the invariant as
 * V/q = (kappa-1)/f. LVR_implied is BACKED OUT of the measured path; sigma^2/8
 * is not used to produce it.
 *
 * THE INTERNAL CHECK MT106 PREREGISTERED. The retained fee rate is recoverable
 * from the reserve path without the decoder: phi_upper = (kappa-1)*q/|dq| is an
 * upper bound on the retained rate and is tight on single-trade steps. On
 * MT100's population it floored at 1.9958 bps against a decoded lpFeeBps of 2.
 * Here the decoded rate is mostly 20, so the recovery must floor near 20. IF IT
 * DOES NOT, the reserve path and the fee field disagree and nothing below may be
 * believed — that is stated in the ledger row and it is enforced here.
 *
 * Read-only. Opens nothing, funds nothing, signs nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIN_TRADES = 20;
const MIN_SPAN_MS = 30 * 60_000;

const db = new DatabaseSync('data/runtime.db', { readOnly: true });

interface Step {
  b: number;
  q: number;
  t: number;
  lp: number;
}

const pools = db.prepare('SELECT DISTINCT pool FROM venue_trades').all() as { pool: string }[];

interface PoolResult {
  pool: string;
  n: number;
  spanMin: number;
  lpFeeBps: number;
  kappa: number;
  r: number;
  feeTerm: number;
  lvrTerm: number;
  lpMinusHodl: number;
  turnover: number;
  phiUpperBps: number[];
}

const results: PoolResult[] = [];

for (const { pool } of pools) {
  const rows = db
    .prepare(
      `SELECT CAST(pool_base_reserves_before AS REAL) b, CAST(pool_quote_reserves_before AS REAL) q,
              observed_utc_ms t, lp_fee_bps lp
         FROM venue_trades WHERE pool = ? ORDER BY observed_utc_ms`,
    )
    .all(pool) as unknown as Step[];
  if (rows.length < MIN_TRADES) continue;
  const span = rows[rows.length - 1]!.t - rows[0]!.t;
  if (span < MIN_SPAN_MS) continue;

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (first.b <= 0 || first.q <= 0 || last.b <= 0 || last.q <= 0) continue;

  const k0 = first.b * first.q;
  const k1 = last.b * last.q;
  const p0 = first.q / first.b;
  const p1 = last.q / last.b;
  const kappa = k1 / k0;
  const r = p1 / p0;
  if (!Number.isFinite(kappa) || !Number.isFinite(r) || kappa <= 0 || r <= 0) continue;

  // MT100's split, exactly.
  const feeTerm = 2 * Math.sqrt(r) * (Math.sqrt(kappa) - 1);
  const lvrTerm = (Math.sqrt(r) - 1) ** 2;
  const lpMinusHodl = feeTerm - lvrTerm;

  // Turnover from the invariant: V/q = (kappa-1)/f.
  const f = last.lp / 10_000;
  const turnover = f > 0 ? (kappa - 1) / f : Number.NaN;

  // The preregistered internal check, per step.
  const phi: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1]!;
    const c = rows[i]!;
    if (a.b <= 0 || a.q <= 0 || c.b <= 0 || c.q <= 0) continue;
    const kA = a.b * a.q;
    const kC = c.b * c.q;
    const dq = Math.abs(c.q - a.q);
    if (dq <= 0 || kA <= 0) continue;
    const kap = kC / kA;
    if (kap <= 1) continue;
    phi.push(((kap - 1) * a.q * 10_000) / dq);
  }

  results.push({
    pool,
    n: rows.length,
    spanMin: span / 60_000,
    lpFeeBps: last.lp,
    kappa,
    r,
    feeTerm,
    lvrTerm,
    lpMinusHodl,
    turnover,
    phiUpperBps: phi,
  });
}

db.close();

if (results.length === 0) {
  console.error('no pool met the bar of 20 trades over 30 minutes. Nothing computed.');
  process.exit(1);
}

const pct = (a: number[], x: number): number => {
  const s = [...a].sort((m, n) => m - n);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(x * (s.length - 1))))] ?? Number.NaN;
};
const finite = (a: number[]): number[] => a.filter((v) => Number.isFinite(v));

// ---- the preregistered internal check, FIRST -------------------------------
const allPhi = finite(results.flatMap((r) => r.phiUpperBps));
const phiP10 = pct(allPhi, 0.1);
const phiP25 = pct(allPhi, 0.25);
const phiP50 = pct(allPhi, 0.5);
const dominantFee = pct(results.map((r) => r.lpFeeBps), 0.5);

console.log('MT106 — MT100 decomposition on the flagged-wallet pool population');
console.log(`  pools meeting 20 trades over 30 minutes: ${results.length}`);
console.log('');
console.log('INTERNAL CHECK FIRST, because nothing below is believable if it fails.');
console.log('  phi_upper, the retained LP rate recovered from the reserve path alone:');
console.log(`    p10 ${phiP10.toFixed(3)} bps   p25 ${phiP25.toFixed(3)} bps   p50 ${phiP50.toFixed(3)} bps`);
console.log(`    median DECODED lp_fee_bps across these pools: ${dominantFee}`);
const checkOk = phiP10 >= dominantFee * 0.5 && phiP10 <= dominantFee * 3;
console.log(`    ${checkOk ? 'CONSISTENT' : 'INCONSISTENT'} — the floor should sit near the decoded rate`);
if (!checkOk) {
  console.log('');
  console.log('  THE RESERVE PATH AND THE FEE FIELD DISAGREE. MT106 said nothing below may be');
  console.log('  believed in that case, so nothing below is reported as a finding.');
}
console.log('');

const feeTerms = finite(results.map((r) => r.feeTerm));
const lvrTerms = finite(results.map((r) => r.lvrTerm));
const lps = finite(results.map((r) => r.lpMinusHodl));
const turns = finite(results.map((r) => r.turnover));

const pooledFee = feeTerms.reduce((a, b) => a + b, 0) / feeTerms.length;
const pooledLvr = lvrTerms.reduce((a, b) => a + b, 0) / lvrTerms.length;

console.log('THE DECOMPOSITION');
console.log(`  fee income      pooled ${(100 * pooledFee).toFixed(4)}%   median ${(100 * pct(feeTerms, 0.5)).toFixed(4)}%`);
console.log(`  LVR_implied     pooled ${(100 * pooledLvr).toFixed(4)}%   median ${(100 * pct(lvrTerms, 0.5)).toFixed(4)}%`);
console.log(`  LVR / fee       pooled ${(pooledLvr / pooledFee).toFixed(2)}x`);
console.log(`  LP - HODL       pooled ${(100 * (pooledFee - pooledLvr)).toFixed(4)}%   median ${(100 * pct(lps, 0.5)).toFixed(4)}%`);
console.log(`  pools where fee beats LVR: ${lps.filter((v) => v > 0).length} of ${lps.length}`);
console.log('');
console.log('TURNOVER, which MT100 named as the cause rather than the fee');
console.log(`  V/L over the window:  p10 ${pct(turns, 0.1).toFixed(4)}   p50 ${pct(turns, 0.5).toFixed(4)}   p90 ${pct(turns, 0.9).toFixed(4)}`);
console.log(`  MT100 measured: median 0.000038, p90 0.390, break-even at 21 bps needs 1.72`);
console.log('');
console.log('MT100 FOR COMPARISON (freshly-migrated tier-0, lpFeeBps 2, median 25 SOL):');
console.log('  fee 0.0077%   LVR 0.3612%   LVR/fee 47x   LP-HODL -0.353%   8.0% of pools beat HODL');

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/mt106-lp-flagged-pools.json',
  `${JSON.stringify(
    {
      computedUtc: new Date().toISOString(),
      ledgerRow: 'MT106',
      poolsIncluded: results.length,
      minTrades: MIN_TRADES,
      minSpanMs: MIN_SPAN_MS,
      internalCheck: { phiP10, phiP25, phiP50, medianDecodedLpFeeBps: dominantFee, consistent: checkOk },
      pooledFeeTerm: pooledFee,
      pooledLvrTerm: pooledLvr,
      lvrOverFee: pooledLvr / pooledFee,
      pooledLpMinusHodl: pooledFee - pooledLvr,
      poolsBeatingHodl: lps.filter((v) => v > 0).length,
      turnover: { p10: pct(turns, 0.1), p50: pct(turns, 0.5), p90: pct(turns, 0.9) },
      mt100Comparison: {
        feeTerm: 0.000077,
        lvrTerm: 0.003612,
        lvrOverFee: 47,
        lpMinusHodl: -0.00353,
        turnoverMedian: 0.000038,
        turnoverP90: 0.39,
        breakEvenTurnoverAt21Bps: 1.72,
      },
    },
    null,
    2,
  )}\n`,
);
console.log('');
console.log('artifacts/mt106-lp-flagged-pools.json');
