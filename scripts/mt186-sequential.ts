/**
 * MT186 — the same strategy, simulated forward in time, with no knowledge of the future.
 *
 * MT185 grew a trailing-stop arm and it read spectacularly: mean +1,570 bps, growth +0.0078, and a
 * best-fifty-removed of +0.0076 that comfortably survived the concentration test which every prior
 * result in this programme had failed. It is an artifact, and the defect is the one that killed
 * MT171, reproduced by me a few hours after recording that lesson.
 *
 * MT185 SET THE TRAILING STOP AT `maxAfter - TRAIL`, WHERE `maxAfter` IS THE HIGHEST RESERVE THE
 * CURVE EVER REACHED - over the whole tape, including everything after the moment of the decision.
 * A real trailing stop knows only the peak SO FAR. Pricing an exit against a high that has not
 * happened yet does two wrong things at once: it triggers stops that could not have triggered, and
 * it books them at prices that did not exist when the trigger fired.
 *
 * THE FIX IS NOT A BETTER FORMULA, IT IS A DIFFERENT SHAPE OF PROGRAM. Aggregates like "the minimum
 * after entry" and "the maximum after entry" cannot express a path-dependent rule, because the
 * moment a rule depends on ORDER, any summary that discards order will silently substitute hindsight
 * for information. So this walks each curve forward event by event and carries the position as a
 * state machine: enter, update the running peak, check the stop against THAT peak, check the target,
 * exit at the reserves standing at the instant the condition fires. Nothing is consulted that a live
 * bot would not already have seen.
 *
 * It costs nothing in memory - the state per curve is a handful of numbers - and it is the only
 * version whose numbers a live run can be expected to reproduce.
 *
 * Reads the bonding-curve tape only.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const INITIAL_VIRTUAL_SOL = 30;
const FEE = 0.01;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const NOTIONAL = Number(arg('notional') ?? '0.01');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
const ENTRY = Number(arg('entry') ?? '70');
const EXITS = (arg('exits') ?? '76,78,80,82').split(',').map(Number);
/** 0 means a FIXED stop this many SOL below entry; any other value trails that far below the running peak. */
const TRAILS = (arg('trails') ?? '0,2,3,5').split(',').map(Number);
const FIXED_STOP = Number(arg('fixed-stop') ?? '4');
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;

/** One live position per (exit, trail) combination, carried forward as a state machine. */
interface Pos { tok: number; peak: number; open: boolean }
interface Curve { pos: (Pos | null)[]; lastVSol: number; lastVTok: number }
const combos: { x: number; t: number }[] = [];
for (const x of EXITS) for (const t of TRAILS) combos.push({ x, t });
const outs: number[][] = combos.map(() => []);
const cut: number[] = combos.map(() => 0);
const hit: number[] = combos.map(() => 0);

const curves = new Map<string, Curve>();
const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT186 — forward simulation, entry ${ENTRY} SOL, ${files.length} files, ${combos.length} combinations`);

let trades = 0;
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
      trades += 1;
      const mint = b.subarray(OFF.mint, OFF.mint + 32).toString('base64');
      let c = curves.get(mint);
      if (c === undefined) { c = { pos: combos.map(() => null), lastVSol: vSol, lastVTok: vTok }; curves.set(mint, c); }
      c.lastVSol = vSol; c.lastVTok = vTok;

      for (let j = 0; j < combos.length; j += 1) {
        const cb = combos[j] as { x: number; t: number };
        let p = c.pos[j] ?? null;
        /** ENTER on the first event at or above the entry level, at THIS event's reserves. */
        if (p === null) {
          if (rSol < ENTRY) continue;
          const tok = buyTokens(vSol, vTok, NOTIONAL);
          if (!(tok > 0)) continue;
          c.pos[j] = { tok, peak: rSol, open: true };
          continue;
        }
        if (!p.open) continue;
        /** The peak is only ever what has been SEEN. This is the whole correction. */
        if (rSol > p.peak) p.peak = rSol;
        const stopAt = cb.t > 0 ? p.peak - cb.t : ENTRY - FIXED_STOP;
        if (rSol <= stopAt) {
          (outs[j] as number[]).push(1e4 * (sellSol(vSol, vTok, p.tok) / NOTIONAL - 1) - fixedBps);
          cut[j] = (cut[j] ?? 0) + 1; p.open = false; continue;
        }
        if (rSol >= cb.x) {
          (outs[j] as number[]).push(1e4 * (sellSol(vSol, vTok, p.tok) / NOTIONAL - 1) - fixedBps);
          hit[j] = (hit[j] ?? 0) + 1; p.open = false; continue;
        }
      }
    }
  }
  rl.close();
}
/** Anything still open at the end is marked where its curve actually finished. */
for (const c of curves.values()) {
  for (let j = 0; j < combos.length; j += 1) {
    const p = c.pos[j];
    if (p === null || p === undefined || !p.open) continue;
    (outs[j] as number[]).push(1e4 * (sellSol(c.lastVSol, c.lastVTok, p.tok) / NOTIONAL - 1) - fixedBps);
    p.open = false;
  }
}
console.log(`  ${curves.size.toLocaleString()} mints, ${trades.toLocaleString()} SOL-quoted trades`);

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
console.log('');
console.log(`  stake ${NOTIONAL} SOL, 1% curve fee each leg, ${fixedBps.toFixed(0)} bps fixed cost measured live`);
console.log('');
console.log('  exit  stop            n   target%   stopped%   median     mean    %pos   g(f=.05)  best50out');
for (let j = 0; j < combos.length; j += 1) {
  const cb = combos[j] as { x: number; t: number };
  const o = outs[j] as number[];
  if (o.length < 40) continue;
  const srt = [...o].sort((a, b) => b - a);
  const fm = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
  const label = cb.t > 0 ? `trail-${cb.t}` : `fixed-${FIXED_STOP}`;
  console.log(
    `  ${String(cb.x).padStart(4)}  ${label.padEnd(9)} ${String(o.length).padStart(7)} ${((100 * (hit[j] ?? 0)) / o.length).toFixed(0).padStart(7)}% ` +
    `${((100 * (cut[j] ?? 0)) / o.length).toFixed(0).padStart(9)}% ${q(o, 0.5).toFixed(0).padStart(8)} ${mean(o).toFixed(0).padStart(8)} ` +
    `${((100 * o.filter((x) => x > 0).length) / o.length).toFixed(1).padStart(6)}% ${fm(growth(o, 0.05)).padStart(10)} ${fm(growth(srt.slice(50), 0.05)).padStart(10)}`,
  );
}
console.log('');
console.log('  MT185 read trail-2 at mean +1,570 and growth +0.0078. It set the stop from the peak the');
console.log('  curve would EVENTUALLY reach. Anything here that disagrees with it is the correction.');
