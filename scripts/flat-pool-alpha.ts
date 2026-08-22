/**
 * IN POOLS THAT GO NOWHERE, DOES ANYONE SYSTEMATICALLY TAKE MONEY OFF OTHER TRADERS?
 *
 * `winner-anatomy.ts` produced one usable finding and one broken column. The broken column was a
 * buy-and-hold benchmark divided by each wallet's own first price — which explodes when that
 * first buy is at a near-zero launch price, giving a nonsense 171,939% median pool move. Ignored
 * here, and the pool universe is restricted to sane price paths instead.
 *
 * The usable finding: among books in pools that moved less than +/-10%, winners took 4,595 SOL
 * against a buy-and-hold benchmark of 190. Money changing hands with no price move cannot be
 * selection, because there was no move to be early to. It is either execution skill or noise.
 *
 * THE DISTINCTION IS PERSISTENCE, AND IT IS THE ONLY THING THAT MATTERS HERE. In any zero-sum
 * redistribution roughly half the participants come out ahead by chance. What separates a skill
 * from a coin flip is whether the SAME wallets do it again on pools they have not touched.
 *
 * SPLIT IS BY POOL, ASSIGNED BY A HASH OF THE POOL ADDRESS. A wallet's alpha on its half-A pools
 * is compared against its alpha on its DISJOINT half-B pools. No pool contributes to both sides,
 * so a wallet cannot score on the same trade twice.
 *
 * WHAT THIS CANNOT SHOW, STATED UP FRONT: even a real, persistent execution edge measured here is
 * an edge OTHER PEOPLE have. It says a mechanism exists on this venue; it says nothing about
 * whether this system could run it, at what latency, or at what size.
 *
 * EXPLORATORY. Decides nothing. Re-preregister before believing it.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1').split(',').filter((s) => s.length > 0);
/** A pool whose price path is sane enough that "flat" means anything. */
const FLAT_BAR = 0.10;

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

/** FNV-1a, so the pool split is deterministic and replays identically. */
function half(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 2;
}

interface Side { pnl: number; pools: number; trades: number }
const A = new Map<string, Side>(); const B = new Map<string, Side>();
const bump = (m: Map<string, Side>, k: string, pnl: number, trades: number): void => {
  const s = m.get(k) ?? { pnl: 0, pools: 0, trades: 0 };
  s.pnl += pnl; s.pools += 1; s.trades += trades; m.set(k, s);
};

let flatPools = 0; let allPools = 0; let netAll = 0; let feeAll = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing w${w})`); continue; }
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) { console.log('  cache lacks the base field — rebuild it'); process.exit(2); }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa, who: r[13], base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, evs] of byPool) {
    if (evs.length < 20) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const first = evs[0]; const last = evs[evs.length - 1];
    if (first === undefined || last === undefined || first.b <= 0n || last.b <= 0n || first.q <= 0n || last.q <= 0n) continue;
    allPools += 1;
    const px0 = Number(first.q) / Number(first.b);
    const px1 = Number(last.q) / Number(last.b);
    if (!Number.isFinite(px0) || !Number.isFinite(px1) || px0 <= 0 || px1 <= 0) continue;
    const move = px1 / px0 - 1;
    if (Math.abs(move) > FLAT_BAR) continue;                 // not a flat pool
    flatPools += 1;

    /**
     * STRICT FIFO ON COMPLETED ROUND TRIPS ONLY.
     *
     * A previous version summed every sell's proceeds and marked leftovers at the closing price.
     * That credited SOL to wallets which walked in ALREADY HOLDING tokens bought before the
     * window opened — pure phantom profit with no offsetting purchase. It reported net trader
     * PnL of +7,466 SOL in pools that by construction create no wealth, and on that broken
     * arithmetic the persistence test returned a Spearman of 0.63 with 100% of wallets positive
     * on the held-out half, which is impossible in a zero-sum game.
     *
     * So: a sell is only counted against base this wallet was actually SEEN to buy in this pool.
     * Unmatched sells (pre-window inventory) are discarded entirely, and open positions at the
     * end are NOT marked. Conservative, and it conserves.
     */
    const lots = new Map<string, { base: number; cost: number }[]>();
    const done = new Map<string, { pnl: number; trades: number }>();
    for (const e of evs) {
      if (e.base <= 0n) continue;
      let d = done.get(e.who);
      if (d === undefined) { d = { pnl: 0, trades: 0 }; done.set(e.who, d); }
      d.trades += 1;
      feeAll += Number(e.big - e.small) / LAMPORTS;
      const q = lots.get(e.who) ?? [];
      if (e.buy) {
        q.push({ base: Number(e.base), cost: Number(e.big) / LAMPORTS });
        lots.set(e.who, q);
      } else {
        let remaining = Number(e.base);
        const proceedsPerBase = (Number(e.small) / LAMPORTS) / Number(e.base);
        while (remaining > 0 && q.length > 0) {
          const lot = q[0];
          if (lot === undefined) break;
          const take = Math.min(remaining, lot.base);
          const costOfTake = lot.cost * (take / lot.base);
          d.pnl += proceedsPerBase * take - costOfTake;
          lot.base -= take; lot.cost -= costOfTake; remaining -= take;
          if (lot.base <= 0) q.shift();
        }
        lots.set(e.who, q);
        // `remaining > 0` here is pre-window inventory. Deliberately dropped, not credited.
      }
    }
    const side = half(pool) === 0 ? A : B;
    for (const [who, d] of done) {
      if (d.trades < 2 || d.pnl === 0) continue;
      if (!Number.isFinite(d.pnl)) continue;
      netAll += d.pnl;
      bump(side, who, d.pnl, d.trades);
    }
  }
  byPool.clear();
  console.log(`  w${w} folded in`);
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const sum = (a: number[]): number => a.filter(Number.isFinite).reduce((x, y) => x + y, 0);
const pctf = (x: number, n: number): string => (n > 0 ? (100 * x / n).toFixed(1) + '%' : 'n/a');

console.log('');
console.log(`pools examined ${allPools.toLocaleString()}   FLAT pools (|move| <= ${(100 * FLAT_BAR).toFixed(0)}%) ${flatPools.toLocaleString()}`);
console.log('');
console.log('IS IT ZERO SUM? net across EVERY book in flat pools, winners and losers together');
console.log(`  net trader PnL   ${netAll.toFixed(1)} SOL`);
console.log(`  fees paid        ${feeAll.toFixed(1)} SOL`);
console.log('  A flat pool creates no wealth, so this must be about minus the fees.');
if (netAll > 0) {
  console.log('');
  console.log('  *** NET IS POSITIVE. Impossible. The accounting is wrong and nothing below');
  console.log('  *** would mean anything, so it is not printed.');
  process.exit(2);
}
console.log('  Net is negative as required, so every SOL a winner takes came out of another trader.');

// ---- persistence: disjoint pool halves ----
const both: { who: string; a: number; b: number; ap: number; bp: number }[] = [];
for (const [who, sa] of A) {
  const sb = B.get(who);
  if (sb === undefined) continue;
  if (sa.pools < 3 || sb.pools < 3) continue;               // needs a few pools each side to mean anything
  both.push({ who, a: sa.pnl, b: sb.pnl, ap: sa.pools, bp: sb.pools });
}
console.log('');
console.log(`WALLETS ACTIVE IN AT LEAST 3 FLAT POOLS ON BOTH DISJOINT HALVES: ${both.length.toLocaleString()}`);
if (both.length < 30) {
  console.log('  TOO FEW TO TEST PERSISTENCE. Reported as an instrument limit, not as a result.');
  process.exit(0);
}

both.sort((x, y) => y.a - x.a);
const q = Math.max(1, Math.floor(both.length / 5));
console.log('');
console.log('DOES HALF-A PERFORMANCE PREDICT HALF-B PERFORMANCE?  (disjoint pools — no shared trade)');
console.log('  quintile by half-A        n     medA        medB      totalB   %B positive');
for (let i = 0; i < 5; i += 1) {
  const g = both.slice(i * q, (i + 1) * q);
  if (g.length === 0) continue;
  console.log(
    `  Q${i + 1}${i === 0 ? ' (best A)' : i === 4 ? ' (worst A)' : '        '} ${String(g.length).padStart(9)}  ` +
    `${med(g.map((x) => x.a)).toFixed(4).padStart(9)}  ${med(g.map((x) => x.b)).toFixed(4).padStart(10)}  ` +
    `${sum(g.map((x) => x.b)).toFixed(1).padStart(10)}  ${pctf(g.filter((x) => x.b > 0).length, g.length).padStart(9)}`,
  );
}

// Spearman rank correlation between the two halves.
const rank = (v: number[]): number[] => {
  const idx = v.map((x, i) => [x, i] as [number, number]).sort((p, r) => p[0] - r[0]);
  const out = new Array<number>(v.length);
  for (let i = 0; i < idx.length; i += 1) { const e = idx[i]; if (e !== undefined) out[e[1]] = i; }
  return out;
};
const ra = rank(both.map((x) => x.a)); const rb = rank(both.map((x) => x.b));
const n = both.length;
const mA = sum(ra) / n; const mB = sum(rb) / n;
let num = 0; let da = 0; let db = 0;
for (let i = 0; i < n; i += 1) {
  const x = (ra[i] ?? 0) - mA; const y = (rb[i] ?? 0) - mB;
  num += x * y; da += x * x; db += y * y;
}
const rho = da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
console.log('');
console.log(`  Spearman rank correlation between disjoint halves: ${rho.toFixed(4)}`);
console.log('  Zero means flat-pool profit is a coin flip and there is no skill to copy.');
console.log('  Clearly positive means the same wallets do it again on pools they had not touched.');
console.log('');
console.log('EXPLORATORY. Decides nothing. Re-preregister before believing it.');
