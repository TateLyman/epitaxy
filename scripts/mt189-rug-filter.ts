/**
 * MT189 — does holder concentration at entry predict the catastrophic tail?
 *
 * A live position lost 90% when its curve collapsed from 69.7 SOL to 1.26 inside a SINGLE
 * transaction. No stop can act on that: a two-second poll, a websocket, a colocated node - all of
 * them look after the transaction has landed. Reacting faster is not the answer and never was. The
 * only defence against a one-transaction collapse is not holding the position when it happens.
 *
 * A COLLAPSE THAT LARGE IS ARITHMETIC, NOT SENTIMENT. Taking a curve from 69.7 SOL of reserves down
 * to 1.26 requires selling back most of the tokens the curve ever issued, so one wallet, or a few
 * acting together, must have been holding most of the supply. That position was bought earlier, on
 * the same curve, and every one of those buys is in our tape: the TradeEvent carries the user, the
 * side and the token amount. The holder distribution is therefore RECONSTRUCTABLE at any instant,
 * including the instant we would decide to buy.
 *
 * Published guidance says the same thing from the outside - top-ten concentration above roughly 30%
 * of circulating supply is the strongest single rug indicator, and a deployer plus a few snipers
 * above 35% means the chart belongs to them. That agreement is worth something, but it is not
 * evidence for OUR population: those thresholds are quoted for tokens in general, whereas we only
 * ever touch curves that have already climbed past 45 SOL, which is a small and unusual subset. So
 * the thresholds are measured here rather than adopted.
 *
 * WHAT WOULD MAKE THIS WORTH IMPLEMENTING is not that concentrated curves are riskier on average -
 * that would be unsurprising and could easily be paid for by higher returns. It is specifically
 * whether concentration separates the DISASTERS, the positions that lose more than half, because
 * those are what a mean cannot absorb and what ruins a bankroll running near the Kelly peak.
 *
 * Two passes: the first finds curves that reach the watch level at all, the second reconstructs
 * per-wallet holdings for only those, which keeps the wallet map to a size worth holding in memory.
 *
 * Reads the bonding-curve tape only.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
/** mint(32)@8, solAmount@40, tokenAmount@48, isBuy@56, user(32)@57, ts@89, then reserves. */
const OFF = { mint: 8, tokenAmount: 48, isBuy: 56, user: 57, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const INITIAL_VIRTUAL_SOL = 30;
const FEE = 0.01;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const NOTIONAL = Number(arg('notional') ?? '0.05');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
const ENTRY = Number(arg('entry') ?? '55');
/**
 * TARGET LEVELS, SWEPT TOGETHER.
 *
 * MT188 swept entry against stop and held the target at 82 SOL throughout, a number inherited from
 * MT171 - the falsified result - and never chosen. It is the last untested lever and it trades
 * directly against itself: a nearer target is hit more often for less, a further one more rarely for
 * more. Concentration is measured at ENTRY and does not depend on the exit, so one entry decision can
 * feed a position per target and all of them see identical data in a single pass.
 */
const EXITS = (arg('exits') ?? '70,74,78,82,84').split(',').map(Number);
const STOP_BELOW = Number(arg('stop-below') ?? '8');
const WATCH_BELOW = Number(arg('watch-below') ?? '10');
const MAX_OVERSHOOT = Number(arg('max-overshoot') ?? '4');
/** The concentration band MT189 measured: both tails carry the disasters, the middle does not. */
const CONC_LO = Number(arg('conc-lo') ?? '44');
const CONC_HI = Number(arg('conc-hi') ?? '71');
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT189 — does concentration predict the tail? entry ${ENTRY}, ${files.length} files`);

async function* events(): AsyncGenerator<{ mint: string; user: string; isBuy: boolean; tokens: number; vSol: number; vTok: number; rSol: number }> {
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let blk: { header?: { number?: number }; instructions?: { data: string }[] };
      try { blk = JSON.parse(line) as typeof blk; } catch { continue; }
      const slot = blk.header?.number ?? 0;
      if (slot < BC_FROM || slot > BC_TO) continue;
      for (const i of blk.instructions ?? []) {
        let raw: Buffer;
        try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
        if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
        const b = raw.subarray(8);
        if (b.length < NEED || !b.subarray(0, 8).equals(TRADE_EVENT)) continue;
        const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
        const vTok = Number(b.readBigUInt64LE(OFF.vTok)) / 1e6;
        const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
        if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) continue;
        if (!(vSol > 0) || !(vTok > 0)) continue;
        yield {
          mint: b.subarray(OFF.mint, OFF.mint + 32).toString('base64'),
          user: b.subarray(OFF.user, OFF.user + 32).toString('base64'),
          isBuy: b.readUInt8(OFF.isBuy) === 1,
          tokens: Number(b.readBigUInt64LE(OFF.tokenAmount)) / 1e6,
          vSol, vTok, rSol,
        };
      }
    }
  }
}

// ---- pass 1: which curves ever reach the watch level ----
const reached = new Set<string>();
for await (const e of events()) { if (e.rSol >= ENTRY - WATCH_BELOW) reached.add(e.mint); }
console.log(`  ${reached.size.toLocaleString()} curves reach ${ENTRY - WATCH_BELOW} SOL — holders tracked for these only`);

// ---- pass 2: reconstruct holders, then simulate ----
interface P { hold: Map<string, number>; phase: 0 | 1 | 2 | 3; tok: number; top1: number; top10: number; nHold: number; lastVSol: number; lastVTok: number;
  /** One slot per target level: the realised bps, and whether it is still open. */
  out: number[]; open: boolean[] }
const st = new Map<string, P>();
for await (const e of events()) {
  if (!reached.has(e.mint)) continue;
  let p = st.get(e.mint);
  if (p === undefined) { p = { hold: new Map(), phase: 0, tok: 0, top1: 0, top10: 0, nHold: 0, out: EXITS.map(() => 0), open: EXITS.map(() => false), lastVSol: e.vSol, lastVTok: e.vTok }; st.set(e.mint, p); }
  p.lastVSol = e.vSol; p.lastVTok = e.vTok;
  /** Net position per wallet, updated on every trade, so the distribution is exact at any instant. */
  p.hold.set(e.user, (p.hold.get(e.user) ?? 0) + (e.isBuy ? e.tokens : -e.tokens));

  if (p.phase === 3) continue;
  if (p.phase === 0) {
    if (e.rSol >= ENTRY - WATCH_BELOW && e.rSol < ENTRY) p.phase = 1;
    else if (e.rSol >= ENTRY) p.phase = 3;
    continue;
  }
  if (p.phase === 1) {
    if (e.rSol < ENTRY) continue;
    if (e.rSol > ENTRY + MAX_OVERSHOOT) { p.phase = 3; continue; }
    const tok = buyTokens(e.vSol, e.vTok, NOTIONAL);
    if (!(tok > 0)) { p.phase = 3; continue; }
    /** Concentration measured AT THE INSTANT OF ENTRY, from trades already past. */
    const bal = [...p.hold.values()].filter((v) => v > 0).sort((a, b) => b - a);
    const supply = bal.reduce((a, b) => a + b, 0);
    p.nHold = bal.length;
    p.top1 = supply > 0 ? (100 * (bal[0] ?? 0)) / supply : 0;
    p.top10 = supply > 0 ? (100 * bal.slice(0, 10).reduce((a, b) => a + b, 0)) / supply : 0;
    p.tok = tok; p.phase = 2;
    for (let k = 0; k < EXITS.length; k += 1) p.open[k] = true;
    continue;
  }
  /** Every target slot resolves independently, at the reserves standing when its condition fires. */
  let anyOpen = false;
  for (let k = 0; k < EXITS.length; k += 1) {
    if (!p.open[k]) continue;
    if (e.rSol <= ENTRY - STOP_BELOW) { p.out[k] = 1e4 * (sellSol(e.vSol, e.vTok, p.tok) / NOTIONAL - 1) - fixedBps; p.open[k] = false; continue; }
    if (e.rSol >= (EXITS[k] as number)) { p.out[k] = 1e4 * (sellSol(e.vSol, e.vTok, p.tok) / NOTIONAL - 1) - fixedBps; p.open[k] = false; continue; }
    anyOpen = true;
  }
  if (!anyOpen) p.phase = 3;
}
const rows: P[] = [];
for (const p of st.values()) {
  for (let k = 0; k < EXITS.length; k += 1) {
    if (!p.open[k]) continue;
    p.out[k] = 1e4 * (sellSol(p.lastVSol, p.lastVTok, p.tok) / NOTIONAL - 1) - fixedBps;
    p.open[k] = false;
  }
  if (p.tok > 0) rows.push(p);
}
console.log(`  ${rows.length.toLocaleString()} positions`);
console.log('');

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

const dis = (o: number[]): string => `${((100 * o.filter((x) => x <= -5000).length) / o.length).toFixed(1)}%`;
console.log(`  stake ${NOTIONAL} SOL, entry ${ENTRY}, stop ${ENTRY - STOP_BELOW}, concentration band ${CONC_LO}-${CONC_HI}%`);
console.log('');
console.log('  TARGET SWEEP.  filtered = top-10 concentration inside the band.');
console.log('  target      n    hit%   disasters      mean   g(.05)   g(.10)   g(.20)');
for (let k = 0; k < EXITS.length; k += 1) {
  const x = EXITS[k] as number;
  for (const [lab, set] of [['all     ', rows], ['filtered', rows.filter((p) => p.top10 >= CONC_LO && p.top10 <= CONC_HI)]] as [string, P[]][]) {
    const o = set.map((p) => p.out[k] as number);
    if (o.length < 40) continue;
    /** A hit is any outcome better than flat: the target was reached rather than stopped or drifted. */
    const hit = (100 * o.filter((v) => v > 0).length) / o.length;
    console.log(
      `  ${String(x).padStart(4)} ${lab} ${String(o.length).padStart(5)} ${hit.toFixed(0).padStart(5)}% ` +
      `${dis(o).padStart(9)} ${mean(o).toFixed(0).padStart(9)} ${growth(o, 0.05).toFixed(4).padStart(8)} ${growth(o, 0.10).toFixed(4).padStart(8)} ${growth(o, 0.20).toFixed(4).padStart(8)}`,
    );
  }
  console.log('');
}
/**
 * BAND SWEEP. The 44-71% boundaries came from quintile edges, which is where the data happened to
 * split rather than where the effect actually lives. Re-filtering the same positions costs nothing,
 * and a band that only works at one exact pair of boundaries is a coincidence rather than a filter.
 */
{
  const k = EXITS.indexOf(82);
  if (k >= 0) {
    console.log('  CONCENTRATION BAND SWEEP at target 82. Look for a wide plateau, not a best pair.');
    console.log('    band          n    disasters      mean   g(.05)   g(.20)');
    for (const [lo, hi] of [[0, 100], [30, 80], [35, 75], [40, 75], [44, 71], [45, 65], [50, 70], [50, 80], [55, 75], [60, 85]] as [number, number][]) {
      const set = rows.filter((p) => p.top10 >= lo && p.top10 <= hi);
      const o = set.map((p) => p.out[k] as number);
      if (o.length < 60) { console.log(`    ${String(lo)}-${String(hi)}%`.padEnd(14) + ` n=${o.length} too few`); continue; }
      console.log(
        `    ${(`${String(lo)}-${String(hi)}%`).padEnd(10)} ${String(o.length).padStart(5)} ${dis(o).padStart(10)} ${mean(o).toFixed(0).padStart(9)} ` +
        `${growth(o, 0.05).toFixed(4).padStart(8)} ${growth(o, 0.20).toFixed(4).padStart(8)}`,
      );
    }
    console.log('');
  }
}
console.log('  A nearer target is hit more often for less; a further one more rarely for more.');
console.log('  The question is only which side of that trade the curve actually pays for.');
