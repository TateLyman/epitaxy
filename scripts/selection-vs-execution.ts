/**
 * IS THE WINNERS' MONEY IN POOLS THAT RAN, OR IN POOLS THAT WENT NOWHERE?
 *
 * This is the question that decides whether ANY of the winner research is actionable, and it has
 * to be answered before a single rule is written.
 *
 * `winner-behaviour.ts` measured that the top wallets buy into falling prices while everyone else
 * is selling (preBuy -4.86%, othersBuy -8.76 SOL) and sell into rising prices. That is a
 * liquidity-provision signature. But it is ALSO exactly what an insider accumulating a token they
 * know will run would look like, and the two are indistinguishable from the entry pattern alone.
 *
 * They are NOT indistinguishable from the OUTCOME. So:
 *
 *   IF the money is in pools that ran, the edge is SELECTION — knowing which token goes up. Every
 *   predictive test in this repository is closed, and this would be unreachable.
 *
 *   IF meaningful money is in pools that went NOWHERE, the edge is EXECUTION — being paid to
 *   absorb impatient flow. No forecast required, and it would be the first reachable mechanism
 *   this programme has found.
 *
 * PnL is FIFO-matched per wallet-pool on completed round trips only, so a wallet that walks in
 * holding pre-window inventory cannot be credited with phantom profit. Conservation is a hard gate.
 *
 * THE POOL MOVE IS MEASURED OVER THE WALLET'S OWN HOLDING WINDOW, not the whole window. A pool
 * that fell for an hour and then tripled is not "flat" to someone who held only the last ten
 * minutes, and bucketing on the window-wide move would put them in the wrong bucket.
 *
 * EXPLORATORY. Decides nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const V_CANDIDATES = [0n, 17_584_500_000n];
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1').split(',').filter((s) => s.length > 0);

interface Ev { ts: number; slot: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v); const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

interface Book { pnl: number; trades: number; firstBuyPx: number; lastPx: number; who: string }
const books: Book[] = [];
let netAll = 0; let feeAll = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing w${w})`); continue; }
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) { console.log(`  w${w} lacks the base field — rebuild it`); process.exit(2); }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa, who: r[13], base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [, evs] of byPool) {
    if (evs.length < 30) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;

    const lots = new Map<string, { base: number; cost: number }[]>();
    const st = new Map<string, { pnl: number; trades: number; firstBuyPx: number; lastPx: number }>();
    for (const e of evs) {
      if (e.base <= 0n || e.b <= 0n) continue;
      const p = Number(e.q + v) / Number(e.b);
      if (!Number.isFinite(p) || p <= 0) continue;
      let s = st.get(e.who);
      if (s === undefined) { s = { pnl: 0, trades: 0, firstBuyPx: 0, lastPx: p }; st.set(e.who, s); }
      s.trades += 1; s.lastPx = p;
      feeAll += Number(e.big - e.small) / LAMPORTS;
      const q = lots.get(e.who) ?? [];
      if (e.buy) {
        if (s.firstBuyPx === 0) s.firstBuyPx = p;
        q.push({ base: Number(e.base), cost: Number(e.big) / LAMPORTS });
        lots.set(e.who, q);
      } else {
        let rem = Number(e.base);
        const per = (Number(e.small) / LAMPORTS) / Number(e.base);
        while (rem > 0 && q.length > 0) {
          const lot = q[0];
          if (lot === undefined) break;
          const take = Math.min(rem, lot.base);
          const cost = lot.cost * (take / lot.base);
          s.pnl += per * take - cost; netAll += per * take - cost;
          lot.base -= take; lot.cost -= cost; rem -= take;
          if (lot.base <= 0) q.shift();
        }
        lots.set(e.who, q);
      }
    }
    for (const [who, s] of st) {
      if (s.trades < 4 || s.firstBuyPx <= 0 || s.pnl === 0) continue;
      books.push({ pnl: s.pnl, trades: s.trades, firstBuyPx: s.firstBuyPx, lastPx: s.lastPx, who });
    }
  }
  byPool.clear();
  console.log(`  w${w} folded in — ${books.length.toLocaleString()} books`);
}

const sum = (a: number[]): number => a.filter(Number.isFinite).reduce((x, y) => x + y, 0);
const med = (a: number[]): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const pctf = (x: number, n: number): string => (Math.abs(n) > 0 ? (100 * x / n).toFixed(1) + '%' : 'n/a');

console.log('');
console.log('CONSERVATION CHECK — hard gate');
console.log(`  net realised trader PnL ${netAll.toFixed(1)} SOL   fees ${feeAll.toFixed(1)} SOL`);
if (netAll > 0) { console.log('  *** POSITIVE. Impossible. Nothing printed. ***'); process.exit(2); }
console.log('  Negative as required.');

const withMove = books.map((b) => ({ ...b, move: b.lastPx / b.firstBuyPx - 1 })).filter((b) => Number.isFinite(b.move));
const winners = withMove.filter((b) => b.pnl > 0);
const totalWin = sum(winners.map((b) => b.pnl));

console.log('');
console.log(`books with >=4 trades and a completed round trip: ${withMove.length.toLocaleString()}`);
console.log(`  of which profitable: ${winners.length.toLocaleString()}   total winner PnL ${totalWin.toFixed(1)} SOL`);
console.log('');
console.log('WHERE IS THE WINNERS\' MONEY? bucketed by the pool move over THEIR OWN holding window');
console.log('  bucket                    books      totalPnL   shareOfWinnings    medPnL   medTrades');
const buckets: [string, (m: number) => boolean][] = [
  ['ran hard   >+50%', (m) => m > 0.50],
  ['up        +10..50', (m) => m > 0.10 && m <= 0.50],
  ['FLAT      -10..+10', (m) => m >= -0.10 && m <= 0.10],
  ['down     -50..-10', (m) => m < -0.10 && m >= -0.50],
  ['collapsed  <-50%', (m) => m < -0.50],
];
for (const [label, f] of buckets) {
  const g = winners.filter((b) => f(b.move));
  if (g.length === 0) { console.log(`  ${label.padEnd(20)} ${String(0).padStart(8)}`); continue; }
  const t = sum(g.map((b) => b.pnl));
  console.log(
    `  ${label.padEnd(20)} ${String(g.length).padStart(8)}  ${t.toFixed(1).padStart(12)}  ${pctf(t, totalWin).padStart(15)}  ` +
    `${med(g.map((b) => b.pnl)).toFixed(3).padStart(9)}  ${String(med(g.map((b) => b.trades))).padStart(9)}`,
  );
}
console.log('');
console.log('  If the FLAT row carries a small share, the winners are paid by the MOVE and the edge');
console.log('  is selection. If it carries a large share, they are paid for ABSORBING and the edge');
console.log('  is execution.');

console.log('');
console.log('THE SAME CUT ON THE VERY TOP WALLETS, where the money actually is');
const byWallet = new Map<string, number>();
for (const b of withMove) byWallet.set(b.who, (byWallet.get(b.who) ?? 0) + b.pnl);
const topWallets = new Set([...byWallet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([w]) => w));
const topBooks = withMove.filter((b) => topWallets.has(b.who) && b.pnl > 0);
const topTotal = sum(topBooks.map((b) => b.pnl));
console.log(`  top 100 wallets by total PnL — ${topBooks.length} profitable books, ${topTotal.toFixed(1)} SOL`);
for (const [label, f] of buckets) {
  const g = topBooks.filter((b) => f(b.move));
  if (g.length === 0) continue;
  console.log(`  ${label.padEnd(20)} ${String(g.length).padStart(8)}  ${sum(g.map((b) => b.pnl)).toFixed(1).padStart(12)}  ${pctf(sum(g.map((b) => b.pnl)), topTotal).padStart(15)}`);
}
console.log('');
console.log('EXPLORATORY. Decides nothing.');
