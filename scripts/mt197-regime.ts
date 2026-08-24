/**
 * MT197 — does the strategy's edge vary enough day to day to be worth predicting, and is it?
 *
 * Three periods measured with the same configuration gave growth at f=0.20 of 0.0273 on block D,
 * 0.0198 on block E and 0.0169 over the eleven-day sample. Averages over multi-day windows hide
 * whatever is happening inside them, and two quite different worlds produce those numbers: an edge
 * that is roughly constant, or an edge that is large on some days and negative on others. Only the
 * second is worth trying to time, and standing down on the bad days would then be worth more than
 * every parameter this programme has swept.
 *
 * SO THE FIRST QUESTION IS DISPERSION, NOT PREDICTION. If daily growth barely moves there is nothing
 * to time and the honest answer is to stop. That has to be settled before any signal is tested,
 * because a signal fitted to a flat series will still look like it works.
 *
 * THE SECOND QUESTION IS WHETHER YESTERDAY KNOWS ANYTHING ABOUT TODAY. Every candidate statistic
 * here is computed from the day BEFORE the day it is asked to predict - graduation rate, launches,
 * trade volume, and the strategy's own realised growth. Using same-day information would be the
 * MT185 error in a new costume: a signal that reads the future is not a signal.
 *
 * A warning that applies to the whole file: with a handful of days, a correlation is easy to find
 * and means almost nothing. The output reports the number of days behind every figure precisely so
 * that a striking correlation over six days can be read as the noise it probably is.
 *
 * Reads the bonding-curve tape only.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, tokenAmount: 48, isBuy: 56, user: 57, solAmount: 40, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const INITIAL_VIRTUAL_SOL = 30;
const FEE = 0.01;
const SLOTS_PER_DAY = 216_000;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const NOTIONAL = Number(arg('notional') ?? '0.05');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
const ENTRY = Number(arg('entry') ?? '55');
const EXIT = Number(arg('exit') ?? '82');
const STOP_BELOW = Number(arg('stop-below') ?? '8');
const WATCH_BELOW = Number(arg('watch-below') ?? '10');
const MAX_OVERSHOOT = Number(arg('max-overshoot') ?? '4');
const CONC_LO = Number(arg('conc-lo') ?? '50');
const CONC_HI = Number(arg('conc-hi') ?? '80');
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;
const STOP_AT = ENTRY - STOP_BELOW;

/** Per-day market statistics, and the outcomes of positions opened that day. */
interface Day { trades: number; volSol: number; mints: Set<string>; reached45: Set<string>; graduated: Set<string>; outs: number[] }
const days = new Map<number, Day>();
const dayOf = (slot: number): number => Math.floor(slot / SLOTS_PER_DAY);
function day(d: number): Day {
  let x = days.get(d);
  if (x === undefined) { x = { trades: 0, volSol: 0, mints: new Set(), reached45: new Set(), graduated: new Set(), outs: [] }; days.set(d, x); }
  return x;
}

interface S { hold: Map<string, number>; phase: 0 | 1 | 2 | 3; tok: number; openDay: number }
const st = new Map<string, S>();

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT197 — daily dispersion and whether yesterday predicts today. ${files.length} files`);

for (const f of files) {
  const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { header?: { number?: number }; instructions?: { data: string }[] };
    try { blk = JSON.parse(line) as typeof blk; } catch { continue; }
    const slot = blk.header?.number ?? 0;
    if (slot < BC_FROM || slot > BC_TO) continue;
    const d = day(dayOf(slot));
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

      const mint = b.subarray(OFF.mint, OFF.mint + 32).toString('base64');
      d.trades += 1;
      d.volSol += Number(b.readBigUInt64LE(OFF.solAmount)) / 1e9;
      d.mints.add(mint);
      if (rSol >= 45) d.reached45.add(mint);
      if (rSol >= 84) d.graduated.add(mint);

      let p = st.get(mint);
      if (p === undefined) { p = { hold: new Map(), phase: 0, tok: 0, openDay: 0 }; st.set(mint, p); }
      const user = b.subarray(OFF.user, OFF.user + 32).toString('base64');
      const tokens = Number(b.readBigUInt64LE(OFF.tokenAmount)) / 1e6;
      p.hold.set(user, (p.hold.get(user) ?? 0) + (b.readUInt8(OFF.isBuy) === 1 ? tokens : -tokens));
      if (p.phase === 3) continue;

      if (p.phase === 0) {
        if (rSol >= ENTRY - WATCH_BELOW && rSol < ENTRY) p.phase = 1;
        else if (rSol >= ENTRY) p.phase = 3;
        continue;
      }
      if (p.phase === 1) {
        if (rSol < ENTRY) continue;
        if (rSol > ENTRY + MAX_OVERSHOOT) { p.phase = 3; continue; }
        const bal = [...p.hold.values()].filter((v) => v > 0).sort((a, c) => c - a);
        const supply = bal.reduce((a, c) => a + c, 0);
        if (!(supply > 0)) continue;
        const top10 = (100 * bal.slice(0, 10).reduce((a, c) => a + c, 0)) / supply;
        if (top10 < CONC_LO || top10 > CONC_HI) { p.phase = 3; continue; }
        const tok = buyTokens(vSol, vTok, NOTIONAL);
        if (!(tok > 0)) { p.phase = 3; continue; }
        p.tok = tok; p.phase = 2; p.openDay = dayOf(slot);
        continue;
      }
      if (rSol <= STOP_AT || rSol >= EXIT) {
        /** Booked to the day the position OPENED, so a day's number reflects decisions made that day. */
        day(p.openDay).outs.push(1e4 * (sellSol(vSol, vTok, p.tok) / NOTIONAL - 1) - fixedBps);
        p.phase = 3;
      }
    }
  }
  rl.close();
}

const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const rows = [...days.entries()].filter(([, v]) => v.outs.length >= 15).sort((a, b) => a[0] - b[0]);
console.log(`  ${rows.length} days with at least 15 positions`);
console.log('');
console.log('  day      n   gradRate   launches   volSOL   g(.20)');
for (const [d, v] of rows) {
  const gr = v.reached45.size > 0 ? (100 * v.graduated.size) / v.reached45.size : NaN;
  console.log(
    `  ${String(d).padStart(5)} ${String(v.outs.length).padStart(6)} ${gr.toFixed(0).padStart(9)}% ${String(v.mints.size).padStart(10)} ${v.volSol.toFixed(0).padStart(8)} ${growth(v.outs, 0.20).toFixed(4).padStart(8)}`,
  );
}

const g = rows.map(([, v]) => growth(v.outs, 0.20));
console.log('');
if (g.length >= 3) {
  const m = mean(g);
  const sd = Math.sqrt(mean(g.map((x) => (x - m) * (x - m))));
  const srt = [...g].sort((a, b) => a - b);
  console.log(`  DISPERSION: mean ${m.toFixed(4)}, sd ${sd.toFixed(4)}, worst ${srt[0]?.toFixed(4)}, best ${srt[srt.length - 1]?.toFixed(4)}`);
  console.log(`  days negative: ${g.filter((x) => x < 0).length} of ${g.length}`);
  console.log('');
  /**
   * Spearman rank correlation between a statistic on day N and strategy growth on day N+1. Rank
   * rather than linear because the sample is tiny and one outlying day would otherwise set the
   * answer on its own.
   */
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(v.length);
    idx.forEach(([, i], r) => { out[i] = r; });
    return out;
  };
  const spearman = (a: number[], b: number[]): number => {
    const ra = rank(a); const rb = rank(b);
    const ma = mean(ra); const mb = mean(rb);
    let num = 0; let da = 0; let db = 0;
    for (let i = 0; i < ra.length; i += 1) {
      const x = (ra[i] ?? 0) - ma; const y = (rb[i] ?? 0) - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
  };
  const nextG = g.slice(1);
  const feats: [string, number[]][] = [
    ['yesterday graduation rate', rows.slice(0, -1).map(([, v]) => (v.reached45.size > 0 ? v.graduated.size / v.reached45.size : 0))],
    ['yesterday launches', rows.slice(0, -1).map(([, v]) => v.mints.size)],
    ['yesterday volume SOL', rows.slice(0, -1).map(([, v]) => v.volSol)],
    ['yesterday own growth', g.slice(0, -1)],
  ];
  console.log(`  DOES YESTERDAY PREDICT TODAY? Spearman against next-day growth, n=${nextG.length} day pairs`);
  for (const [name, f] of feats) console.log(`    ${name.padEnd(28)} ${spearman(f, nextG).toFixed(3)}`);
  console.log('');
  console.log(`  With ${nextG.length} day pairs a correlation of 0.5 is not significant. Treat anything here as`);
  console.log('  a direction to test on more data, never as a rule to trade.');
}
