/**
 * MT156 — WHERE in a pool's life is the money actually made?
 *
 * Every measurement in this programme judges a pool at its 25TH TRADE. That number came from
 * MT147 and was carried unchanged through MT148, MT149, MT150, MT151, MT152, MT153 and MT154. It
 * has never been justified against the alternative, and published practitioner accounts of this
 * venue say it is far too late:
 *
 *   "Without a bundler, your token creation lands in block N, and in block N+1 multiple sniper
 *    bots have already bought 20-40% of the total supply at the lowest possible price. With a
 *    bundler, your token creation and all your buy transactions land in the exact same block."
 *
 * If that is true, then by trade 25 the extraction is over and this corpus has spent fifteen
 * months carefully measuring the leftovers. It would also explain, in one stroke, results that
 * have each been explained separately: MT131 mirrored a proven winner's entire trade schedule at
 * ZERO latency and still lost 18.2%; MT144 found the reversion gone within one slot; MT147 found
 * we can predict which pools winners enter but that being early to that shortlist loses at the
 * median. All three are what you would see if the winner's edge were not a signal at all, but a
 * POSITION — being inside the first block of a token you control — that no amount of prediction
 * can reach.
 *
 * SO THIS MEASURES REALISED PnL BY ARRIVAL RANK, and it takes no view about who deserves it.
 * Every wallet is placed by WHEN IT FIRST APPEARS in the pool — same slot as the pool's first
 * trade, next slot, and so on out to trade 25 and beyond — and its FIFO realised PnL in that pool
 * is attributed to that bucket.
 *
 * FIFO IS STRICT, AND THE REASON IS A BUG THIS PROGRAMME ALREADY SHIPPED ONCE. Crediting a sell
 * against inventory that was never bought inside the window produced a phantom +7,466 SOL and a
 * Spearman of 0.63 that would have reached the operator as a breakthrough. A sell counts here only
 * against base this wallet was SEEN to buy in this pool; unmatched sells are dropped and open
 * positions are NOT marked. That biases against late arrivals slightly, and it biases against the
 * hypothesis, which is the correct direction for a test the author expects to pass.
 *
 * TWO PASSES, BECAUSE THE CHUNK BOUNDARY WOULD OTHERWISE LIE. The block was pulled as eight
 * parallel chunks. A pool whose life begins in chunk k-1 looks, inside chunk k, like a pool that
 * began at chunk k's first slot — which would put ordinary latecomers in the "first slot" bucket
 * and manufacture exactly the result being tested for. Pass one establishes each pool's true first
 * slot across the whole block; pass two analyses a pool only in the chunk that genuinely contains
 * its birth.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'b0,b1,b2,b3,b4,b5,b6,b7').split(',').filter((s) => s.length > 0);
/**
 * THE EARLIEST CHUNK CANNOT BE ANALYSED, AND LEAVING IT IN WOULD MANUFACTURE THE RESULT.
 * Pass one learns each pool's first slot from the windows it is given. A pool that was ALREADY
 * ALIVE when the block starts therefore looks, inside the earliest chunk, like a pool born at that
 * chunk's first slot — which puts ordinary latecomers straight into the "slot 0" bucket. Pass one
 * still reads every window, so a pool first seen in the earliest chunk is correctly EXCLUDED from
 * the later ones; but the earliest chunk itself is not analysable and is dropped from pass two.
 */
const ANALYZE = new Set((arg('analyze') ?? WINDOWS.join(',')).split(',').filter((s) => s.length > 0));

interface Ev { slot: number; tx: number; addr: string; buy: boolean; big: bigint; small: bigint; who: string; base: bigint }

// ---------------- pass 1: every pool's TRUE first slot across the whole block ----------------
const firstSlot = new Map<string, number>();
for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing ${w})`); continue; }
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const i = line.indexOf('"', 2);
    if (i < 0) continue;
    const pool = line.slice(2, i);
    const rest = line.slice(i + 2);
    const j = rest.indexOf(',');
    const slot = Number(j < 0 ? rest : rest.slice(0, j));
    if (!Number.isFinite(slot)) continue;
    const prev = firstSlot.get(pool);
    if (prev === undefined || slot < prev) firstSlot.set(pool, slot);
  }
  rl.close();
  console.log(`  pass1 ${w} — ${firstSlot.size.toLocaleString()} pools`);
}

// ---------------- pass 2: FIFO realised PnL per wallet, bucketed by arrival ----------------
const BUCKETS: [string, (rank: number, slotOff: number) => boolean][] = [
  ['slot 0 (bundle)', (_r, s) => s === 0],
  ['slot 1', (_r, s) => s === 1],
  ['slot 2-4', (_r, s) => s >= 2 && s <= 4],
  ['slot 5-20', (_r, s) => s >= 5 && s <= 20],
  ['slot 21-200', (_r, s) => s >= 21 && s <= 200],
  ['slot 200+', (_r, s) => s > 200],
];
const RANKS: [string, (r: number) => boolean][] = [
  ['trade 1-3', (r) => r <= 3],
  ['trade 4-10', (r) => r >= 4 && r <= 10],
  ['trade 11-25', (r) => r >= 11 && r <= 25],
  ['trade 26-100', (r) => r >= 26 && r <= 100],
  ['trade 100+', (r) => r > 100],
];

const bySlot = new Map<string, { pnl: number; n: number; win: number; deployed: number }>();
const byRank = new Map<string, { pnl: number; n: number; win: number; deployed: number }>();
for (const [l] of BUCKETS) bySlot.set(l, { pnl: 0, n: 0, win: 0, deployed: 0 });
for (const [l] of RANKS) byRank.set(l, { pnl: 0, n: 0, win: 0, deployed: 0 });

let poolsAnalysed = 0;
let sameSlotMulti = 0;

for (const w of WINDOWS) {
  if (!ANALYZE.has(w)) { console.log(`  pass2 ${w} — SKIPPED (not analysable)`); continue; }
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  let chunkMin = Infinity;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) continue;
    if (r[1] < chunkMin) chunkMin = r[1];
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], tx: r[3], addr: r[4], buy: r[5] === 1,
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa, who: r[13], base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    const born = firstSlot.get(pool);
    if (born === undefined) continue;
    /** Only analyse a pool in the chunk that genuinely contains its birth. */
    if (born < chunkMin) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    poolsAnalysed += 1;
    /** A bundled launch shows up as several DISTINCT wallets buying in the pool's very first slot. */
    const firstSlotWallets = new Set(evs.filter((e) => e.slot === born && e.buy && e.who).map((e) => e.who));
    if (firstSlotWallets.size >= 3) sameSlotMulti += 1;

    /** Arrival: rank among trades, and slot offset from the pool's birth. */
    const arrival = new Map<string, { rank: number; slotOff: number }>();
    for (let i = 0; i < evs.length; i += 1) {
      const e = evs[i];
      if (e === undefined || e.who === '') continue;
      if (!arrival.has(e.who)) arrival.set(e.who, { rank: i + 1, slotOff: e.slot - born });
    }

    /** Strict FIFO realised PnL per wallet, in SOL, plus what each wallet actually put in. */
    const lots = new Map<string, { base: number; cost: number }[]>();
    const pnl = new Map<string, number>();
    const spend = new Map<string, number>();
    for (const e of evs) {
      if (e.base <= 0n || e.who === '') continue;
      const q = lots.get(e.who) ?? [];
      if (e.buy) {
        const cost = Number(e.big) / LAMPORTS;
        q.push({ base: Number(e.base), cost });
        lots.set(e.who, q);
        spend.set(e.who, (spend.get(e.who) ?? 0) + cost);
        continue;
      }
      let rem = Number(e.base);
      const per = (Number(e.small) / LAMPORTS) / Number(e.base);
      let got = 0;
      while (rem > 0 && q.length > 0) {
        const lot = q[0];
        if (lot === undefined) break;
        const take = Math.min(rem, lot.base);
        const c = lot.cost * (take / lot.base);
        got += per * take - c; rem -= take; lot.base -= take; lot.cost -= c;
        if (lot.base <= 0) q.shift();
      }
      lots.set(e.who, q);
      if (got !== 0 && Number.isFinite(got)) pnl.set(e.who, (pnl.get(e.who) ?? 0) + got);
    }

    for (const [who, v] of pnl) {
      const a = arrival.get(who);
      if (a === undefined || !Number.isFinite(v)) continue;
      const dep = spend.get(who) ?? 0;
      for (const [l, fn] of BUCKETS) {
        if (!fn(a.rank, a.slotOff)) continue;
        const c = bySlot.get(l); if (c === undefined) break;
        c.pnl += v; c.n += 1; c.deployed += dep; if (v > 0) c.win += 1; break;
      }
      for (const [l, fn] of RANKS) {
        if (!fn(a.rank)) continue;
        const c = byRank.get(l); if (c === undefined) break;
        c.pnl += v; c.n += 1; c.deployed += dep; if (v > 0) c.win += 1; break;
      }
    }
  }
  byPool.clear();
  console.log(`  pass2 ${w} — ${poolsAnalysed.toLocaleString()} pools analysed`);
}

console.log('');
console.log(`MT156 — realised PnL by ARRIVAL, ${poolsAnalysed.toLocaleString()} pools whose birth is inside the block`);
console.log(`  pools with 3+ DISTINCT wallets buying in the very first slot: ${sameSlotMulti.toLocaleString()} (${(100 * sameSlotMulti / Math.max(1, poolsAnalysed)).toFixed(1)}%)`);
console.log('');
const show = (title: string, m: Map<string, { pnl: number; n: number; win: number; deployed: number }>, order: string[]): void => {
  console.log(title);
  console.log('  bucket             wallets    total PnL SOL    per wallet    % of all gains    win rate    return on deployed');
  const totalGain = [...m.values()].reduce((a, b) => a + Math.max(0, b.pnl), 0);
  for (const l of order) {
    const c = m.get(l);
    if (c === undefined || c.n === 0) continue;
    const roi = c.deployed > 0 ? 1e4 * c.pnl / c.deployed : NaN;
    console.log(
      `  ${l.padEnd(18)} ${c.n.toLocaleString().padStart(7)} ${c.pnl.toFixed(1).padStart(16)} ${(c.pnl / c.n).toFixed(5).padStart(13)} ` +
      `${(totalGain > 0 ? (100 * Math.max(0, c.pnl) / totalGain).toFixed(1) : 'n/a').padStart(17)}% ${(100 * c.win / c.n).toFixed(1).padStart(11)}% ` +
      `${(Number.isFinite(roi) ? roi.toFixed(0) : 'n/a').padStart(19)} bps`,
    );
  }
  console.log('');
};
show('BY SLOT OFFSET FROM THE POOL FIRST TRADE', bySlot, BUCKETS.map(([l]) => l));
show('BY TRADE RANK — trade 25 is where every test in this programme judges', byRank, RANKS.map(([l]) => l));
console.log('  Open positions are NOT marked and unmatched sells are dropped, so a wallet that bought');
console.log('  and never sold contributes ZERO rather than a paper gain. That biases against late');
console.log('  arrivals and therefore AGAINST the hypothesis being tested.');
