/**
 * IS THE WINNERS' EDGE SELECTION OR EXECUTION?
 *
 * `who-wins.ts` measured that the top wallets enter ONE pool about four minutes after its first
 * trade, trade it 50-80 times, hold roughly half an hour, and take 250-1250 SOL. Zero of the top
 * ten do same-slot round trips, so this is not MEV.
 *
 * That profile has TWO completely different possible explanations, and they point at opposite
 * conclusions for whether any of it is reachable:
 *
 *   SELECTION. They were early in a pool that went up. Anyone holding from that entry would have
 *   made the same money, and the "83 trades" is decoration. Reaching this requires KNOWING WHICH
 *   POOL WILL RUN — which is prediction, and every predictive test in this repo is closed.
 *
 *   EXECUTION. The pool went roughly nowhere, or went up far less than they made, and the money
 *   came from working the position — buying weakness, selling strength, repeatedly. That is a
 *   skill rather than a forecast, and it would be the first thing this programme has found that
 *   does not require predicting a price.
 *
 * THE DECOMPOSITION SEPARATES THEM EXACTLY. For each wallet-pool, a BUY-AND-HOLD BENCHMARK spends
 * the wallet's own total SOL at the price of its OWN FIRST BUY and holds to the pool's last
 * observed price. Actual minus benchmark is what the trading did. Selection shows up as a huge
 * benchmark; execution shows up as actual exceeding it.
 *
 * BENCHMARK HONESTY. The benchmark is deliberately generous to the SELECTION story: it gets the
 * wallet's exact entry price with no slippage, no fees, and perfect sizing. If execution alpha
 * still shows up against a benchmark rigged that far in selection's favour, it is real.
 *
 * EXPLORATORY. Decides nothing. Re-preregister anything interesting before believing it.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1').split(',').filter((s) => s.length > 0);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

/** One wallet's book in one pool. */
interface Book {
  solOut: number; solIn: number; baseHeld: number;
  firstPx: number; entryTs: number; trades: number;
}

interface Agg {
  actual: number; bench: number; alpha: number;
  poolMove: number; trades: number; pool: string; who: string;
}

const results: Agg[] = [];

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
    if (evs.length < 10) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const first = evs[0]; const last = evs[evs.length - 1];
    if (first === undefined || last === undefined || last.b <= 0n || first.b <= 0n) continue;
    const lastPx = Number(last.q) / Number(last.b);
    if (!Number.isFinite(lastPx) || lastPx <= 0) continue;
    const poolMove = (Number(last.q) / Number(last.b)) / (Number(first.q) / Number(first.b)) - 1;

    const books = new Map<string, Book>();
    for (const e of evs) {
      if (e.base <= 0n || e.b <= 0n || e.q <= 0n) continue;
      const px = Number(e.q) / Number(e.b);
      if (!Number.isFinite(px) || px <= 0) continue;
      let bk = books.get(e.who);
      if (bk === undefined) { bk = { solOut: 0, solIn: 0, baseHeld: 0, firstPx: 0, entryTs: e.ts, trades: 0 }; books.set(e.who, bk); }
      bk.trades += 1;
      if (e.buy) {
        if (bk.firstPx === 0) { bk.firstPx = px; bk.entryTs = e.ts; }
        bk.solOut += Number(e.big) / LAMPORTS;
        bk.baseHeld += Number(e.base);
      } else {
        bk.solIn += Number(e.small) / LAMPORTS;
        bk.baseHeld -= Math.min(Number(e.base), Math.max(0, bk.baseHeld));
      }
    }

    for (const [who, bk] of books) {
      if (bk.solOut <= 0 || bk.firstPx <= 0 || bk.trades < 2) continue;
      const actual = bk.solIn + (bk.baseHeld * lastPx) / LAMPORTS - bk.solOut;
      // Generous to selection: their own entry price, no fees, no slippage, perfect sizing.
      const bench = bk.solOut * (lastPx / bk.firstPx) - bk.solOut;
      if (!Number.isFinite(actual) || !Number.isFinite(bench)) continue;
      results.push({ actual, bench, alpha: actual - bench, poolMove, trades: bk.trades, pool, who });
    }
  }
  byPool.clear();
  console.log(`  w${w} folded in — ${results.length.toLocaleString()} wallet-pool books`);
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const sum = (a: number[]): number => a.filter(Number.isFinite).reduce((x, y) => x + y, 0);
const pct = (x: number, n: number): string => (Math.abs(n) > 0 ? (100 * x / n).toFixed(1) + '%' : 'n/a');

// Rank by ACTUAL profit — the same population who-wins called winners.
const byActual = [...results].sort((a, b) => b.actual - a.actual);

console.log('');
console.log(`wallet-pool books: ${results.length.toLocaleString()}`);
console.log('');
console.log('DECOMPOSING THE WINNERS: was it SELECTION (buy-and-hold from their own entry) or EXECUTION?');
console.log('  cohort         n      totalActual     totalBench      totalAlpha   alphaShare   medPoolMove   medTrades');
const band = (label: string, rs: Agg[]): void => {
  if (rs.length === 0) return;
  const a = sum(rs.map((r) => r.actual)); const b = sum(rs.map((r) => r.bench)); const al = sum(rs.map((r) => r.alpha));
  console.log(
    `  ${label.padEnd(12)} ${String(rs.length).padStart(6)}  ${a.toFixed(1).padStart(13)}  ${b.toFixed(1).padStart(13)}  ${al.toFixed(1).padStart(14)}  ` +
    `${pct(al, a).padStart(10)}  ${(100 * med(rs.map((r) => r.poolMove))).toFixed(1).padStart(11)}%  ${String(med(rs.map((r) => r.trades))).padStart(9)}`,
  );
};
band('top 10', byActual.slice(0, 10));
band('top 100', byActual.slice(0, 100));
band('top 1000', byActual.slice(0, 1000));
band('all winners', byActual.filter((r) => r.actual > 0));
band('all books', byActual);

console.log('');
console.log('  alphaShare = what fraction of the cohort\'s profit is NOT explained by buy-and-hold');
console.log('  from their own first entry. Near 0% means selection: they were early in something');
console.log('  that ran. Large means execution: they made money the pool move does not account for.');

console.log('');
console.log('THE SAME QUESTION ASKED A SECOND WAY — winners in pools that went NOWHERE');
const flat = byActual.filter((r) => Math.abs(r.poolMove) < 0.10);
const flatWin = flat.filter((r) => r.actual > 0);
console.log(`  books in pools that moved less than +/-10%: ${flat.length.toLocaleString()}`);
console.log(`  of those, profitable: ${flatWin.length.toLocaleString()} (${pct(flatWin.length, flat.length)})`);
console.log(`  their total actual profit: ${sum(flatWin.map((r) => r.actual)).toFixed(1)} SOL`);
console.log(`  their total buy-and-hold benchmark: ${sum(flatWin.map((r) => r.bench)).toFixed(1)} SOL`);
console.log('  If real money is made in pools that went nowhere, that money is execution by');
console.log('  definition, because there was no move to be early to.');

console.log('');
console.log('DOES TRADING MORE ACTUALLY HELP? alpha by trade count, all books');
for (const [lo, hi] of [[2, 3], [4, 9], [10, 29], [30, 99], [100, 1e9]] as [number, number][]) {
  const rs = results.filter((r) => r.trades >= lo && r.trades <= hi);
  if (rs.length < 20) continue;
  const label = hi > 1e8 ? `${lo}+` : `${lo}-${hi}`;
  console.log(`  ${label.padEnd(8)} n=${String(rs.length).padStart(7)}  medAlpha ${med(rs.map((r) => r.alpha)).toFixed(4).padStart(10)}  totalAlpha ${sum(rs.map((r) => r.alpha)).toFixed(1).padStart(11)}  %alphaPositive ${pct(rs.filter((r) => r.alpha > 0).length, rs.length)}`);
}
console.log('');
console.log('EXPLORATORY. Decides nothing. Re-preregister anything interesting before believing it.');
