/**
 * MT187 — does anything observable AT ENTRY predict whether the curve reaches the target?
 *
 * MT186 settled the exit: sell on the curve at 82 with a stop four SOL below entry, and the result
 * sits at roughly breakeven once the position is large enough that transaction fees stop dominating.
 * Every improvement so far has come from removing a cost. This asks the other question, which no arm
 * in this programme has ever asked: given two curves both sitting at 70 SOL, is there anything
 * visible right then that separates the 33% which go on to reach 82 from the 31% which stop out?
 *
 * IF THE ANSWER IS NO, THE STRATEGY IS FINISHED AT BREAKEVEN and no amount of exit tuning changes
 * that, because the exit is already close to optimal and the entry is a coin flip. If the answer is
 * yes, it is worth more than every exit refinement combined: raising the target-hit rate from 33% to
 * even 40% moves the mean by hundreds of basis points.
 *
 * THE FEATURE TESTED IS VELOCITY, because it is the one thing a live watcher already has for free.
 * The bot sees every trade on the curve, so it knows how many slots the curve took to climb from 60
 * SOL to the entry level. A curve dragged to 70 over an hour by a handful of buyers is a different
 * object from one that got there in twenty seconds on heavy flow, and the question is whether that
 * difference survives into the outcome.
 *
 * EVERYTHING IS MEASURED AT THE MOMENT OF ENTRY AND NOTHING AFTER IT. The velocity uses only slots
 * already elapsed when the position would be opened. That is the discipline MT185 broke by reading a
 * peak from the future, and the correction cost a full rebuild, so it is stated explicitly here: no
 * quantity used to make the decision may be computed from an event after the decision.
 *
 * Outcomes are the same three MT186 produces - target, stop, or drift to the end - simulated forward
 * with the same state machine.
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
const NOTIONAL = Number(arg('notional') ?? '0.05');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
/** The level at which the clock starts, and the level at which we buy. */
const FROM_LEVEL = Number(arg('from-level') ?? '60');
const ENTRY = Number(arg('entry') ?? '70');
const EXIT = Number(arg('exit') ?? '82');
const STOP_BELOW = Number(arg('stop-below') ?? '4');
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;

interface S { fromSlot: number | null; tok: number | null; open: boolean; climbSlots: number | null; out: number | null; how: string; trades: number; tradesAtEntry: number }
const st = new Map<string, S>();

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT187 — is the outcome predictable at entry? ${files.length} files`);

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
      const mint = b.subarray(OFF.mint, OFF.mint + 32).toString('base64');
      let c = st.get(mint);
      if (c === undefined) { c = { fromSlot: null, tok: null, open: false, climbSlots: null, out: null, how: '', trades: 0, tradesAtEntry: 0 }; st.set(mint, c); }
      c.trades += 1;
      if (c.out !== null) continue;

      /** Start the clock the first time the curve is seen at or above the lower level. */
      if (c.fromSlot === null && rSol >= FROM_LEVEL) c.fromSlot = slot;

      if (!c.open && c.tok === null && rSol >= ENTRY) {
        const tok = buyTokens(vSol, vTok, NOTIONAL);
        if (!(tok > 0)) continue;
        /** Velocity uses only slots already elapsed. Nothing after this instant is consulted. */
        c.climbSlots = c.fromSlot === null ? null : slot - c.fromSlot;
        c.tradesAtEntry = c.trades;
        c.tok = tok; c.open = true;
        continue;
      }
      if (!c.open || c.tok === null) continue;
      if (rSol <= ENTRY - STOP_BELOW) { c.out = 1e4 * (sellSol(vSol, vTok, c.tok) / NOTIONAL - 1) - fixedBps; c.how = 'stop'; c.open = false; continue; }
      if (rSol >= EXIT) { c.out = 1e4 * (sellSol(vSol, vTok, c.tok) / NOTIONAL - 1) - fixedBps; c.how = 'target'; c.open = false; continue; }
      c.out = null;
      /** Carry the latest reserves so an unresolved position can be marked at the end. */
      c.fromSlot = c.fromSlot; c.tok = c.tok;
      (c as S & { lv?: number; lt?: number }).lv = vSol;
      (c as S & { lv?: number; lt?: number }).lt = vTok;
    }
  }
  rl.close();
}
for (const c of st.values()) {
  if (!c.open || c.tok === null) continue;
  const e = c as S & { lv?: number; lt?: number };
  if (e.lv === undefined || e.lt === undefined) continue;
  c.out = 1e4 * (sellSol(e.lv, e.lt, c.tok) / NOTIONAL - 1) - fixedBps;
  c.how = 'drift'; c.open = false;
}

const rows = [...st.values()].filter((c) => c.out !== null && c.climbSlots !== null);
console.log(`  ${rows.length.toLocaleString()} positions with a measurable climb from ${FROM_LEVEL} to ${ENTRY} SOL`);
console.log('');

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };

/** Quintiles of climb time, so the buckets are equal-sized rather than arbitrary. */
const sorted = [...rows].sort((a, b) => (a.climbSlots as number) - (b.climbSlots as number));
console.log(`  climb ${FROM_LEVEL}->${ENTRY} SOL, fastest first. Stake ${NOTIONAL} SOL, ${fixedBps.toFixed(0)} bps fixed cost.`);
console.log('');
console.log('  quintile   climb slots        n   target%   stop%   drift%    median     mean   g(f=.05)');
for (let k = 0; k < 5; k += 1) {
  const lo = Math.floor((k * sorted.length) / 5);
  const hi = Math.floor(((k + 1) * sorted.length) / 5);
  const g = sorted.slice(lo, hi);
  if (g.length < 20) continue;
  const o = g.map((c) => c.out as number);
  const lab = `${g[0]?.climbSlots ?? 0}-${g[g.length - 1]?.climbSlots ?? 0}`;
  console.log(
    `  ${String(k + 1).padStart(5)}      ${lab.padEnd(14)} ${String(g.length).padStart(6)} ` +
    `${((100 * g.filter((c) => c.how === 'target').length) / g.length).toFixed(0).padStart(7)}% ` +
    `${((100 * g.filter((c) => c.how === 'stop').length) / g.length).toFixed(0).padStart(6)}% ` +
    `${((100 * g.filter((c) => c.how === 'drift').length) / g.length).toFixed(0).padStart(7)}% ` +
    `${med(o).toFixed(0).padStart(9)} ${mean(o).toFixed(0).padStart(8)} ${growth(o, 0.05).toFixed(4).padStart(10)}`,
  );
}
console.log('');
console.log('  A monotone target% across quintiles is a real signal. A flat one means the entry is a');
console.log('  coin flip and the strategy is finished at breakeven, however the exit is tuned.');
