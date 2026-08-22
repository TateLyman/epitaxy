/**
 * Can we get there BEFORE the winners, instead of chasing them?
 *
 * Every mechanism this programme has tested is REACTIVE. MT128 followed winners by identity and
 * lost 8.7%. MT129 waited for consensus and got monotonically worse with every extra confirmation.
 * MT130 copied their footprint anonymously and did worse than copying losers. MT131 mirrored a
 * proven winner's entire trade schedule at zero latency and lost 18.2%. MT144 and MT146 then spent
 * the whole latency budget establishing exactly how late "late" is.
 *
 * All of that assumes we move AFTER them. The operator's question is what happens if we move
 * BEFORE — and it dissolves the problem rather than solving it, because arriving first makes the
 * queue position we have been trying to buy irrelevant.
 *
 * WHAT IS OBSERVABLE BEFORE AN INSIDER ARRIVES. Not their intent, which is private. But the pool
 * they are about to arrive at has a history: how old it is, how many distinct buyers it already
 * has, whether flow is net in or out, how concentrated the buying is, how deep it is. If pools
 * that winners subsequently pick look DIFFERENT beforehand from pools they ignore, that difference
 * is observable to us at the same moment, and it is observable with no latency requirement at all.
 *
 * THE TWO QUESTIONS ARE SEPARATE AND BOTH ARE ASKED:
 *   PREDICTION  do pre-arrival features distinguish pools a winner later enters?
 *   PROFIT      does entering at the moment we could observe those features actually pay, net of
 *               the 23 bps MT136 measured live? A feature can predict winner arrival perfectly and
 *               still be worthless if the winners are wrong, or if the move is already spent.
 *
 * EXPLORATORY. Many features, one corpus. Anything interesting must be preregistered and confirmed
 * on held-out windows before it means anything.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
/** MT136, realised on a complete live round trip. */
const COST_BPS = 23;
/** The moment we judge a pool: after this many trades have happened in it. */
const JUDGE_AT_TRADE = Number(process.argv.find((a) => a.startsWith('--judge='))?.slice(8) ?? '25');
/** How long we would hold, in seconds. */
const HORIZON_S = Number(process.argv.find((a) => a.startsWith('--horizon='))?.slice(10) ?? '1800');

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const FIT = (arg('fit') ?? '9,8,7,6').split(',').filter((s) => s.length > 0);
const VAL = (arg('val') ?? '4,3,2,1').split(',').filter((s) => s.length > 0);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

async function load(w: string): Promise<Map<string, Ev[]>> {
  const byPool = new Map<string, Ev[]>();
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) return byPool;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) continue;
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa, who: r[13], base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();
  for (const a of byPool.values()) a.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  return byPool;
}

/** Winner set: top wallets by FIFO realised PnL on the fit windows. The same statistic MT131 used. */
async function winners(windows: string[], topN: number): Promise<Set<string>> {
  const pnl = new Map<string, number>();
  for (const w of windows) {
    const byPool = await load(w);
    for (const [, evs] of byPool) {
      if (evs.length < 30) continue;
      const lots = new Map<string, { base: number; cost: number }[]>();
      for (const e of evs) {
        if (e.base <= 0n) continue;
        const q2 = lots.get(e.who) ?? [];
        if (e.buy) { q2.push({ base: Number(e.base), cost: Number(e.big) / LAMPORTS }); lots.set(e.who, q2); continue; }
        let rem = Number(e.base); const per = (Number(e.small) / LAMPORTS) / Number(e.base); let got = 0;
        while (rem > 0 && q2.length > 0) {
          const lot = q2[0];
          if (lot === undefined) break;
          const take = Math.min(rem, lot.base);
          const cost = lot.cost * (take / lot.base);
          got += per * take - cost; rem -= take; lot.base -= take; lot.cost -= cost;
          if (lot.base <= 0) q2.shift();
        }
        lots.set(e.who, q2);
        if (got !== 0 && Number.isFinite(got)) pnl.set(e.who, (pnl.get(e.who) ?? 0) + got);
      }
    }
    byPool.clear();
  }
  return new Set([...pnl.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([w]) => w));
}

interface Row {
  ageS: number; buyers: number; trades: number; netFlow: number; buyShare: number;
  topBuyerShare: number; depthSol: number; priceChgBps: number; avgBuySol: number;
  winnerCame: boolean; fwdBps: number | null;
}

async function scan(windows: string[], winnerSet: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const w of windows) {
    const byPool = await load(w);
    for (const [, evs] of byPool) {
      if (evs.length < JUDGE_AT_TRADE + 10) continue;
      const judge = evs[JUDGE_AT_TRADE - 1];
      const first = evs[0];
      if (judge === undefined || first === undefined || judge.b <= 0n || judge.q <= 0n) continue;

      // ---- features, computed STRICTLY from trades at or before the judging moment ----
      const pre = evs.slice(0, JUDGE_AT_TRADE);
      const buyers = new Set<string>();
      let buySol = 0; let sellSol = 0; let buyCount = 0;
      const perBuyer = new Map<string, number>();
      for (const e of pre) {
        const sol = Number(e.big) / LAMPORTS;
        if (e.buy) { buySol += sol; buyCount += 1; buyers.add(e.who); perBuyer.set(e.who, (perBuyer.get(e.who) ?? 0) + sol); }
        else sellSol += sol;
      }
      if (buySol <= 0) continue;
      let topShare = 0;
      for (const v of perBuyer.values()) if (v / buySol > topShare) topShare = v / buySol;
      const p0 = Number(first.q) / Number(first.b);
      const pJ = Number(judge.q) / Number(judge.b);
      if (!(p0 > 0) || !(pJ > 0)) continue;

      // ---- did a winner arrive AFTER the judging moment? ----
      let winnerCame = false;
      for (let i = JUDGE_AT_TRADE; i < evs.length; i += 1) {
        const e = evs[i];
        if (e !== undefined && e.buy && winnerSet.has(e.who)) { winnerCame = true; break; }
      }

      // ---- what would WE have made entering at the judging moment? ----
      let fwd: number | null = null;
      for (let i = JUDGE_AT_TRADE; i < evs.length; i += 1) {
        const e = evs[i];
        if (e === undefined || e.b <= 0n) continue;
        if (e.ts < judge.ts + HORIZON_S) continue;
        const pe = Number(e.q) / Number(e.b);
        if (pe > 0) fwd = 1e4 * (pe / pJ - 1) - COST_BPS;
        break;
      }

      rows.push({
        ageS: judge.ts - first.ts,
        buyers: buyers.size,
        trades: JUDGE_AT_TRADE,
        netFlow: buySol - sellSol,
        buyShare: buyCount / JUDGE_AT_TRADE,
        topBuyerShare: topShare,
        depthSol: Number(judge.q) / LAMPORTS,
        priceChgBps: 1e4 * (pJ / p0 - 1),
        avgBuySol: buySol / Math.max(1, buyCount),
        winnerCame, fwdBps: fwd,
      });
    }
    byPool.clear();
    console.log(`  w${w} scanned — ${rows.length} pools`);
  }
  return rows;
}

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const med = (x: number[]): number => { const s = [...x].filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };

console.log('PRECURSOR SCAN — can we be there BEFORE the winners, rather than after?');
console.log(`  judging each pool at its ${JUDGE_AT_TRADE}th trade, holding ${HORIZON_S}s, cost ${COST_BPS} bps`);
console.log('');
const wset = await winners(FIT, 500);
console.log(`  winner set: ${wset.size} wallets, ranked on fit windows ${FIT.join(',')}`);
const rows = await scan(VAL, wset);
console.log('');
console.log(`pools judged: ${rows.length.toLocaleString()}`);
const came = rows.filter((r) => r.winnerCame);
console.log(`  a winner later bought: ${came.length.toLocaleString()} (${(100 * came.length / rows.length).toFixed(1)}%)`);
console.log('');

console.log('QUESTION 1 — do pre-arrival features distinguish pools a winner later enters?');
console.log('  feature            winner came    no winner     ratio');
const feats: [string, (r: Row) => number][] = [
  ['age at judge (s)', (r) => r.ageS],
  ['distinct buyers', (r) => r.buyers],
  ['net flow (SOL)', (r) => r.netFlow],
  ['buy share', (r) => r.buyShare],
  ['top buyer share', (r) => r.topBuyerShare],
  ['depth (SOL)', (r) => r.depthSol],
  ['price chg (bps)', (r) => r.priceChgBps],
  ['avg buy (SOL)', (r) => r.avgBuySol],
];
const no = rows.filter((r) => !r.winnerCame);
for (const [name, f] of feats) {
  const a = med(came.map(f)); const b = med(no.map(f));
  const ratio = Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : NaN;
  console.log(`  ${name.padEnd(18)} ${a.toFixed(2).padStart(11)} ${b.toFixed(2).padStart(12)} ${Number.isFinite(ratio) ? ratio.toFixed(2).padStart(9) : '      n/a'}`);
}

console.log('');
console.log('QUESTION 2 — does entering at the judging moment actually PAY?');
const withFwd = rows.filter((r) => r.fwdBps !== null);
const cameF = withFwd.filter((r) => r.winnerCame).map((r) => r.fwdBps as number);
const noF = withFwd.filter((r) => !r.winnerCame).map((r) => r.fwdBps as number);
console.log(`  all pools             n=${String(withFwd.length).padStart(6)}   median ${med(withFwd.map((r) => r.fwdBps as number)).toFixed(0).padStart(7)} bps   mean ${mean(withFwd.map((r) => r.fwdBps as number)).toFixed(0).padStart(8)} bps`);
console.log(`  a winner later came   n=${String(cameF.length).padStart(6)}   median ${med(cameF).toFixed(0).padStart(7)} bps   mean ${mean(cameF).toFixed(0).padStart(8)} bps`);
console.log(`  no winner came        n=${String(noF.length).padStart(6)}   median ${med(noF).toFixed(0).padStart(7)} bps   mean ${mean(noF).toFixed(0).padStart(8)} bps`);
console.log('');
console.log('  Predicting winner arrival is only worth something if arriving first PAYS.');
console.log('  A feature can predict perfectly and still be worthless if the winners are wrong,');
console.log('  or if the move is already spent by the time it is observable.');
console.log('');
console.log('EXPLORATORY. Many features, one corpus. Preregister anything interesting before believing it.');
