/**
 * MT149 — is a creator's PRIOR LAUNCH COUNT a signal, without needing a track record at all?
 *
 * MT148 tried to score creators on how their earlier tokens performed and could not: only 124
 * creators ever had two scored pools, even after pulling three continuous days. The diagnosis is
 * the interesting part. The outcome filter requires a pool to reach 25 trades, and repeat
 * creators' pools reach it LESS often — 26.9% against 34.2%, median 5 trades against 8. The filter
 * was selecting against exactly the population a track record needs.
 *
 * So drop the track record. The count of PRIOR launches is knowable for every pool the moment it
 * appears, needs no outcome from those earlier tokens, and classifies the whole corpus rather than
 * 124 creators. It is also closer to what the published work describes: serial deployers running
 * dozens of launches a day, rugging within 10 to 30 minutes.
 *
 * NO LOOK-AHEAD. "Prior" means launches whose first observed trade is STRICTLY EARLIER than this
 * pool's first observed trade. Counting a creator's total launches would use tomorrow's
 * information to grade today's pool, which would make a serial rugger identifiable before they
 * had done anything.
 *
 * SURVIVAL IS REPORTED SEPARATELY FROM RETURN, because they are different claims. A pool can die
 * quickly and still have paid anyone who entered early, and a pool can survive while going
 * nowhere.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const CACHE = 'data/trade-cache';
const SYSTEM_ADDRESS = '11111111111111111111111111111111';
const JUDGE_AT_TRADE = 25;
const HORIZON_S = 1800;
const COST_BPS = 23;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'cont0,cont1,cont2,cont3,cont4,cont5').split(',').filter((s) => s.length > 0);
/**
 * BURN-IN. At the very start of any observation block EVERY creator looks like a first-ever
 * launcher, because we simply have not seen them yet. That contaminates the one bucket the whole
 * hypothesis turns on. So the first `--burnin-hours` of the block are used ONLY to accumulate
 * prior counts, and no pool starting inside them is scored. A pool judged after burn-in has had a
 * real chance to reveal its creator's history.
 */
const BURNIN_H = Number(arg('burnin-hours') ?? '0');

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const creatorOf = new Map<string, string>();
for (const r of db.prepare(
  `SELECT pool, coin_creator FROM venue_pools WHERE coin_creator NOT IN ('', ?)`).all(SYSTEM_ADDRESS) as { pool: string; coin_creator: string }[]) {
  creatorOf.set(r.pool, r.coin_creator);
}
db.close();

interface Pool { pool: string; creator: string; firstTs: number; trades: number; ret: number | null }
const pools: Pool[] = [];

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing ${w})`); continue; }
  const byPool = new Map<string, { ts: number; b: bigint; q: bigint }[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    const a = byPool.get(r[0]) ?? [];
    a.push({ ts: r[2], b: BigInt(r[6]), q: BigInt(r[7]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    const creator = creatorOf.get(pool);
    if (creator === undefined) continue;
    const first = evs[0];
    if (first === undefined) continue;
    let ret: number | null = null;
    if (evs.length >= JUDGE_AT_TRADE + 1) {
      const judge = evs[JUDGE_AT_TRADE - 1];
      if (judge !== undefined && judge.b > 0n && judge.q > 0n) {
        const pJ = Number(judge.q) / Number(judge.b);
        if (pJ > 0) {
          for (let i = JUDGE_AT_TRADE; i < evs.length; i += 1) {
            const e = evs[i];
            if (e === undefined || e.b <= 0n || e.ts < judge.ts + HORIZON_S) continue;
            const pe = Number(e.q) / Number(e.b);
            if (pe > 0) ret = 1e4 * (pe / pJ - 1) - COST_BPS;
            break;
          }
        }
      }
    }
    pools.push({ pool, creator, firstTs: first.ts, trades: evs.length, ret });
  }
  byPool.clear();
  console.log(`  ${w} — ${pools.length.toLocaleString()} pools so far`);
}

/**
 * Prior-launch count, using only pools that STARTED EARLIER. Sorting by first trade and counting
 * forward is what keeps this causal: at the moment a pool appears, we know how many times its
 * creator has appeared before and nothing about what they do next.
 */
pools.sort((a, b) => a.firstTs - b.firstTs);
const seen = new Map<string, number>();
const priorOf = new Map<string, number>();
for (const p of pools) {
  priorOf.set(p.pool, seen.get(p.creator) ?? 0);
  seen.set(p.creator, (seen.get(p.creator) ?? 0) + 1);
}
const blockStart = pools.length > 0 ? (pools[0] as Pool).firstTs : 0;
const cutoff = blockStart + BURNIN_H * 3600;
const judged: Pool[] = BURNIN_H > 0 ? pools.filter((p) => p.firstTs >= cutoff) : pools;
if (BURNIN_H > 0) {
  console.log('');
  console.log(`  burn-in: first ${BURNIN_H}h used only to accumulate prior counts`);
  console.log(`  pools before cutoff (not scored): ${(pools.length - judged.length).toLocaleString()}`);
  console.log(`  pools scored: ${judged.length.toLocaleString()}`);
}

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };

console.log('');
console.log(`MT149 — prior launch count as a signal, ${judged.length.toLocaleString()} pools scored (of ${pools.length.toLocaleString()} with a real creator)`);
console.log(`  judged at trade ${JUDGE_AT_TRADE}, held ${HORIZON_S}s, cost ${COST_BPS} bps`);
console.log('');
console.log('  prior launches       pools   reached 25   median trades    n scored    mean bps   median bps');
const buckets: [string, (n: number) => boolean][] = [
  ['0 (first ever)', (n) => n === 0],
  ['1', (n) => n === 1],
  ['2-4', (n) => n >= 2 && n <= 4],
  ['5-9', (n) => n >= 5 && n <= 9],
  ['10+', (n) => n >= 10],
];
for (const [label, f] of buckets) {
  const g = judged.filter((p) => f(priorOf.get(p.pool) ?? 0));
  if (g.length === 0) continue;
  const survived = g.filter((p) => p.trades >= JUDGE_AT_TRADE).length;
  const rets = g.map((p) => p.ret).filter((r): r is number => r !== null);
  console.log(
    `  ${label.padEnd(18)} ${String(g.length).padStart(7)}  ${(100 * survived / g.length).toFixed(1).padStart(9)}%  ${String(med(g.map((p) => p.trades))).padStart(13)}  ${String(rets.length).padStart(9)}  ` +
    `${(rets.length >= 30 ? mean(rets).toFixed(0) : 'n/a').padStart(10)}  ${(rets.length >= 30 ? med(rets).toFixed(0) : 'n/a').padStart(11)}`,
  );
}
console.log('');
console.log('  SURVIVAL and RETURN are different claims and are reported separately. A pool can die');
console.log('  fast and still have paid an early entrant; a pool can survive and go nowhere.');
console.log('  Cells under 30 scored pools are shown as n/a rather than read.');
