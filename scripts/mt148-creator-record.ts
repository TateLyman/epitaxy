/**
 * MT148 — does a creator's track record predict their next token?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT148 before this file existed, including a
 * split prediction: NEGATIVE selection works, POSITIVE selection fails.
 *
 * MT147 pinned the remaining problem exactly. We CAN predict where winners go — the pools they
 * enter are younger, thinner and quieter, and the features separate cleanly. But being early to
 * that shortlist loses at the median, because what makes winners money is WHICH pool runs, and
 * pre-arrival features carry nothing about that. The missing quantity is a discriminator INSIDE
 * the shortlist.
 *
 * Creator identity is the strongest free candidate, and it is causal rather than correlational:
 * the same operator repeating a behaviour, observable before the token trades, needing no latency
 * and no paid feed.
 *
 * TWO THINGS THIS GUARDS AGAINST, both learned before writing it.
 *
 *   THE SYSTEM ADDRESS IS NOT A CREATOR. `11111111111111111111111111111111` carries 4,125 pools
 *   and means no creator was recorded. Treating it as the most prolific launcher on the venue
 *   would put a quarter of the corpus in one bucket and call it a person.
 *
 *   VOLUME IS NOT SKILL. Documented serial deployers launch dozens of tokens a day — one wallet
 *   minted 18,000 at roughly 12 an hour. A quintile split could separate high-volume launchers
 *   from low-volume ones and look like signal. So the identical test runs with creator labels
 *   randomly PERMUTED across pools, and a real effect must beat that shuffle rather than merely
 *   produce a spread.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const CACHE = 'data/trade-cache';
const SYSTEM_ADDRESS = '11111111111111111111111111111111';
/** Carried over from MT147 unchanged. */
const JUDGE_AT_TRADE = 25;
const HORIZON_S = 1800;
/** MT136, realised on a complete live round trip. */
const COST_BPS = 23;
const MIN_FIT_POOLS = 2;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const FIT = (arg('fit') ?? '9,8,7,6').split(',').filter((s) => s.length > 0);
const VAL = (arg('val') ?? '4,3,2,1').split(',').filter((s) => s.length > 0);

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const creatorOf = new Map<string, string>();
for (const r of db.prepare(
  `SELECT pool, coin_creator FROM venue_pools
    WHERE coin_creator IS NOT NULL AND coin_creator != '' AND coin_creator != ?`).all(SYSTEM_ADDRESS) as { pool: string; coin_creator: string }[]) {
  creatorOf.set(r.pool, r.coin_creator);
}
db.close();
console.log(`MT148 — creator track record as a discriminator`);
console.log(`  prediction recorded before running: negative selection works, positive selection fails`);
console.log(`  ${creatorOf.size.toLocaleString()} pools carry a real on-chain creator`);
console.log('');

/** One pool's outcome: the return we would have earned entering at its 25th trade. */
async function outcomes(windows: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
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
      if (evs.length < JUDGE_AT_TRADE + 5) continue;
      const judge = evs[JUDGE_AT_TRADE - 1];
      if (judge === undefined || judge.b <= 0n || judge.q <= 0n) continue;
      const pJ = Number(judge.q) / Number(judge.b);
      if (!(pJ > 0)) continue;
      for (let i = JUDGE_AT_TRADE; i < evs.length; i += 1) {
        const e = evs[i];
        if (e === undefined || e.b <= 0n || e.ts < judge.ts + HORIZON_S) continue;
        const pe = Number(e.q) / Number(e.b);
        if (pe > 0) out.set(pool, 1e4 * (pe / pJ - 1) - COST_BPS);
        break;
      }
    }
    byPool.clear();
    console.log(`    w${w} scored — ${out.size.toLocaleString()} pools with an outcome`);
  }
  return out;
}

console.log('SCORING FIT WINDOWS');
const fitOut = await outcomes(FIT);
console.log('SCORING HOLDOUT WINDOWS');
const valOut = await outcomes(VAL);

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };

/** Fit-window record per creator, from pools they launched in the fit period only. */
function records(scores: Map<string, number>): Map<string, { n: number; mean: number }> {
  const by = new Map<string, number[]>();
  for (const [pool, ret] of scores) {
    const c = creatorOf.get(pool);
    if (c === undefined) continue;
    const a = by.get(c) ?? []; a.push(ret); by.set(c, a);
  }
  const out = new Map<string, { n: number; mean: number }>();
  for (const [c, a] of by) if (a.length >= MIN_FIT_POOLS) out.set(c, { n: a.length, mean: mean(a) });
  return out;
}

/** Quintile table. `assign` maps a holdout pool to the creator whose record it is judged by. */
function table(label: string, rec: Map<string, { n: number; mean: number }>, assign: (pool: string) => string | undefined): void {
  const ranked = [...rec.entries()].sort((a, b) => a[1].mean - b[1].mean).map(([c]) => c);
  const qOf = new Map<string, number>();
  const size = Math.max(1, Math.floor(ranked.length / 5));
  for (let i = 0; i < ranked.length; i += 1) qOf.set(ranked[i] as string, Math.min(4, Math.floor(i / size)));

  const buckets: number[][] = [[], [], [], [], []];
  for (const [pool, ret] of valOut) {
    const c = assign(pool);
    if (c === undefined) continue;
    const qi = qOf.get(c);
    if (qi === undefined) continue;
    buckets[qi]?.push(ret);
  }
  console.log('');
  console.log(label);
  console.log('  quintile        n     mean bps    median bps');
  for (let i = 0; i < 5; i += 1) {
    const a = buckets[i] ?? [];
    const tag = i === 0 ? 'Q1 (worst)' : i === 4 ? 'Q5 (best)' : `Q${i + 1}`;
    if (a.length === 0) { console.log(`  ${tag.padEnd(11)} ${String(0).padStart(6)}`); continue; }
    console.log(`  ${tag.padEnd(11)} ${String(a.length).padStart(6)}  ${mean(a).toFixed(1).padStart(11)}  ${med(a).toFixed(1).padStart(12)}${a.length < 50 ? '   UNDERPOWERED' : ''}`);
  }
  const top = buckets[4] ?? []; const bot = buckets[0] ?? [];
  if (top.length >= 50 && bot.length >= 50) {
    console.log(`  Q5 minus Q1: ${(mean(top) - mean(bot)).toFixed(1)} bps`);
  }
}

const rec = records(fitOut);
console.log('');
console.log(`creators with a fit record (>=${MIN_FIT_POOLS} scored pools): ${rec.size.toLocaleString()}`);
table('BY CREATOR TRACK RECORD — the real assignment', rec, (pool) => creatorOf.get(pool));

/**
 * THE SHUFFLE. Creator labels are permuted across holdout pools with a deterministic LCG, so any
 * spread that survives here is coming from how many pools a creator has rather than from who
 * they are. Math.random is banned in this repository's scripts and a seeded draw replays.
 */
let seed = 20260822;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const valPools = [...valOut.keys()];
const realCreators = valPools.map((p) => creatorOf.get(p)).filter((c): c is string => c !== undefined);
for (let i = realCreators.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rnd() * (i + 1));
  const t = realCreators[i] as string; realCreators[i] = realCreators[j] as string; realCreators[j] = t;
}
const shuffled = new Map<string, string>();
let k = 0;
for (const p of valPools) if (creatorOf.has(p)) shuffled.set(p, realCreators[k++] as string);
table('CONTROL — the same test with creator labels SHUFFLED', rec, (pool) => shuffled.get(pool));

console.log('');
console.log('  A real effect must beat the shuffle. If both tables show a spread, the split is');
console.log('  separating prolific launchers from occasional ones, not good creators from bad.');
