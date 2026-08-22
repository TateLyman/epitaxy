/**
 * MT153 — where on the FEE axis, if anywhere, does being long for half an hour pay?
 *
 * MT152 established the structural fact that reframes fifteen months of this programme: priced
 * through the real curve, the population's GROSS return is a fair coin — median -10 bps, mean
 * -87 with a 95% day-clustered interval of [-184, +60], 45.2% of round trips positive. Net it is
 * -330. THE ENTIRE LOSS IS THE TOLL. Nothing has been drifting away from us; we have been paying
 * roughly 250 basis points a round trip to play a game with no drift.
 *
 * AND THE TOLL IS NOT ONE NUMBER. PumpSwap's fee is a step function of the coin's SOL-denominated
 * market cap: 1.25% total below 420 SOL — split 0.93 protocol / 0.30 creator / 0.02 LP, which is
 * exactly the LP 2 / protocol 93 / creator 30 split this repository's own copy-fill.ts measured
 * from the program — falling to 0.30% at 98,240 SOL and above. The collector screens
 * minTokenAgeMs 120000 to maxTokenAgeMs 3600000, so every candidate this system has ever
 * considered sits in the most expensive bracket the venue offers. We have been paying 250 bps a
 * round trip where 60 exists, on the same venue, in the same program, through the same code path.
 *
 * THE QUESTION THIS ASKS IS NOT WHETHER THE CHEAP TIER IS CHEAPER. It obviously is. It is whether
 * there is anything there to be cheap ABOUT. A discount on a toll cannot manufacture a move that
 * is not there: if gross expectation is zero at every fee tier, then moving to the 60 bps bracket
 * changes the rate of loss and not its sign, and that has to be said plainly rather than sold as
 * an edge. So gross and net are reported side by side in every cell.
 *
 * OUR OWN IMPACT IS TREATED AS A COST, NOT AS A ROUNDING ERROR. MT152 found gross at 0.005 SOL
 * and gross at 0.020 SOL differ by more than a hundred basis points, which means these pools are
 * thin enough that a four-dollar order moves them. Depth is therefore cut alongside fee.
 *
 * Reads the panel, not the tape. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TAGS = (arg('tags') ?? 'B').split(',').filter((s) => s.length > 0);
const HORIZON = arg('horizon') ?? '1800';
const NOTIONAL = arg('notional') ?? '20000000';
const NONAMM_BPS = 23;

interface P {
  pool: string; creator: string; firstTs: number; trades: number; feeBps: number; v: number;
  ageS: number; buyers: number; buySol: number; netFlowSol: number; buyShare: number;
  depthSol: number; runupBps: number | null;
  alive: Record<string, number>; ret: Record<string, Record<string, number>>;
}

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
function boot(items: { day: number; v: number }[]): [number, number] {
  const byDay = new Map<number, number[]>();
  for (const it of items) { const a = byDay.get(it.day) ?? []; a.push(it.v); byDay.set(it.day, a); }
  const days = [...byDay.values()];
  if (days.length < 2) return [NaN, NaN];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ms: number[] = [];
  for (let r = 0; r < 2000; r += 1) {
    const pick: number[] = [];
    for (let i = 0; i < days.length; i += 1) { const d = days[Math.floor(rnd() * days.length)]; if (d) pick.push(...d); }
    if (pick.length) ms.push(mean(pick));
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * ms.length)] ?? NaN, ms[Math.floor(0.975 * ms.length)] ?? NaN];
}

for (const tag of TAGS) {
  const f = `data/panel/panel-${tag}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing panel-${tag})`); continue; }
  const rows: P[] = [];
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) { if (line.length === 0) continue; try { rows.push(JSON.parse(line) as P); } catch { /* skip */ } }
  rl.close();

  const scored = rows.filter((r) => r.ret[HORIZON]?.[NOTIONAL] !== undefined);
  console.log('');
  console.log('='.repeat(112));
  console.log(`MT153 [panel ${tag}] — ${scored.length.toLocaleString()} pools, horizon ${HORIZON}s, notional ${(Number(NOTIONAL) / 1e9).toFixed(3)} SOL`);

  const net = (r: P): number => r.ret[HORIZON]?.[NOTIONAL] as number;
  /**
   * GROSS is reconstructed first-order as net plus the two legs of the pool's own charge plus the
   * non-AMM drag. It is an approximation and is labelled one; the exact gross was measured directly
   * in MT152 and the two agree to within a few basis points on the pooled population.
   */
  const gross = (r: P): number => net(r) + 2 * r.feeBps + NONAMM_BPS;

  const emit = (label: string, g: P[]): void => {
    if (g.length < 30) { console.log(`  ${label.padEnd(24)} ${String(g.length).padStart(6)}   (under 30 — not read)`); return; }
    const n = g.map(net); const gr = g.map(gross);
    const [lo, hi] = boot(g.map((r) => ({ day: Math.floor(r.firstTs / 86400), v: net(r) })));
    const [glo, ghi] = boot(g.map((r) => ({ day: Math.floor(r.firstTs / 86400), v: gross(r) })));
    console.log(
      `  ${label.padEnd(24)} ${String(g.length).padStart(6)} ` +
      `${mean(gr).toFixed(0).padStart(8)} [${glo.toFixed(0).padStart(6)},${ghi.toFixed(0).padStart(6)}] ` +
      `${mean(n).toFixed(0).padStart(8)} [${lo.toFixed(0).padStart(6)},${hi.toFixed(0).padStart(6)}] ` +
      `${med(n).toFixed(0).padStart(8)} ${(100 * n.filter((x) => x > 0).length / n.length).toFixed(1).padStart(6)}% ` +
      `${med(g.map((r) => r.feeBps)).toFixed(0).padStart(7)} ${med(g.map((r) => r.depthSol)).toFixed(1).padStart(8)} ` +
      `${String(new Set(g.map((r) => Math.floor(r.firstTs / 86400))).size).padStart(5)}`,
    );
  };

  const header = (): void => {
    console.log('');
    console.log('  bucket                        n   GROSS mean  [   95% CI  ]   NET mean  [   95% CI  ]  NET med   %pos  fee/leg   depth  CLUST');
  };

  header();
  console.log('  --- BY THE POOL OWN CHARGED FEE (this is the market-cap tier, read off the tape) ---');
  const feeBuckets: [string, (r: P) => boolean][] = [
    ['<= 40 bps/leg', (r) => r.feeBps <= 40],
    ['40-70', (r) => r.feeBps > 40 && r.feeBps <= 70],
    ['70-105', (r) => r.feeBps > 70 && r.feeBps <= 105],
    ['105-122', (r) => r.feeBps > 105 && r.feeBps <= 122],
    ['> 122 (top bracket)', (r) => r.feeBps > 122],
  ];
  for (const [l, fn] of feeBuckets) emit(l, scored.filter(fn));

  console.log('');
  console.log('  --- BY DEPTH AT ENTRY (our own impact is a cost and these pools are thin) ---');
  const ds = [...scored].sort((a, b) => a.depthSol - b.depthSol);
  const qn = Math.floor(ds.length / 5);
  for (let i = 0; i < 5; i += 1) {
    const g = ds.slice(i * qn, i === 4 ? ds.length : (i + 1) * qn);
    const first = g[0]; const last = g[g.length - 1];
    if (first === undefined || last === undefined) continue;
    emit(`Q${i + 1} ${first.depthSol.toFixed(1)}-${last.depthSol.toFixed(1)} SOL`, g);
  }

  console.log('');
  console.log('  --- THE CHEAP-AND-DEEP CORNER, which is where the tier argument has to land ---');
  emit('fee<=70 AND depth>=top40%', scored.filter((r) => r.feeBps <= 70 && r.depthSol >= (ds[Math.floor(0.6 * ds.length)]?.depthSol ?? Infinity)));
  console.log('  ' + '-'.repeat(108));
  emit('ALL', scored);

  console.log('');
  console.log('  --- THE SAME POPULATION ACROSS HOLD LENGTHS (the fee is paid ONCE per round trip) ---');
  console.log('  horizon        n   GROSS mean       NET mean    NET med    %pos    still trading at horizon');
  for (const H of ['300', '900', '1800', '3600']) {
    const g = rows.filter((r) => r.ret[H]?.[NOTIONAL] !== undefined);
    if (g.length < 30) continue;
    const n = g.map((r) => r.ret[H]?.[NOTIONAL] as number);
    const gr = g.map((r) => (r.ret[H]?.[NOTIONAL] as number) + 2 * r.feeBps + NONAMM_BPS);
    const al = g.filter((r) => r.alive[H] === 1).length;
    console.log(
      `  ${(H + 's').padStart(7)} ${String(g.length).padStart(8)} ${mean(gr).toFixed(0).padStart(12)} ${mean(n).toFixed(0).padStart(14)} ` +
      `${med(n).toFixed(0).padStart(10)} ${(100 * n.filter((x) => x > 0).length / n.length).toFixed(1).padStart(7)}% ${(100 * al / g.length).toFixed(1).padStart(24)}%`,
    );
  }
}

console.log('');
console.log('  A cheaper tier lowers the rate of loss. It only changes the SIGN if gross is positive');
console.log('  there, so the gross column decides this and the net column does not.');
