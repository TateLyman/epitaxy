/**
 * MT188 — sweep entry level against stop distance, forward-simulated, in one pass.
 *
 * Two dimensions have never been swept with a correct simulator. MT185 varied them but decided
 * "did the stop come before the target" from min/max aggregates, which silently substituted
 * hindsight and produced a trailing-stop result that evaporated when MT186 walked the path in order.
 * MT186 and MT187 use a proper state machine but hold entry at 70 SOL and the stop at four SOL below
 * it, because those were inherited from the falsified MT171 rather than chosen.
 *
 * THE STOP IS THE LARGEST UNEXAMINED LEVER IN THE STRATEGY. It ends roughly 55% of all positions, so
 * its distance decides the majority of outcomes, and it trades directly against itself: tighter cuts
 * losses sooner but converts curves that would have recovered into realised losses, while wider
 * gives every curve room to come back at the cost of paying more when it does not. Nothing about
 * where that balance sits is knowable in advance.
 *
 * ENTRY LEVEL MATTERS FOR A DIFFERENT REASON. The target is an ABSOLUTE reserve level, so entering
 * lower buys more of the move - 65 to 82 is worth far more than 75 to 82 - but a curve entered at 65
 * has further to climb and more chances to stall on the way. The two effects pull opposite ways.
 *
 * EVERY COMBINATION IS CARRIED AS ITS OWN STATE MACHINE OVER A SINGLE PASS of the tape, so all cells
 * see identical data and nothing consults an event later than the decision it informs. MT187's
 * requirement is kept: a curve first seen ALREADY above its entry level is dropped rather than
 * traded, because its climb was never observed and unknown climb time behaves like a slow one.
 *
 * A grid this size is a multiple-testing instrument and is treated as one. The point is not to find
 * the best cell - with 25 cells one will look good by chance - but to see whether the surface has
 * SHAPE. A smooth gradient across neighbouring cells is a real effect; a single bright square
 * surrounded by noise is a coincidence, and reading it as anything else is how MT171 happened.
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
const EXIT = Number(arg('exit') ?? '82');
const WATCH_BELOW = Number(arg('watch-below') ?? '10');
const MAX_OVERSHOOT = Number(arg('max-overshoot') ?? '4');
const ENTRIES = (arg('entries') ?? '65,68,70,72,75').split(',').map(Number);
const STOPS = (arg('stops') ?? '2,3,4,6,8').split(',').map(Number);
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;

const cells: { entry: number; stop: number }[] = [];
for (const e of ENTRIES) for (const st of STOPS) cells.push({ entry: e, stop: st });

type Phase = 0 | 1 | 2 | 3; // 0 pre, 1 watching, 2 holding, 3 done
interface Slot { phase: Phase; tok: number }
interface C { s: Slot[]; lastVSol: number; lastVTok: number }
const curves = new Map<string, C>();
const outs: number[][] = cells.map(() => []);
const hits: number[] = cells.map(() => 0);
const cuts: number[] = cells.map(() => 0);

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT188 — entry x stop sweep, exit ${EXIT} SOL, ${cells.length} cells, ${files.length} files`);

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
      let c = curves.get(mint);
      if (c === undefined) { c = { s: cells.map(() => ({ phase: 0 as Phase, tok: 0 })), lastVSol: vSol, lastVTok: vTok }; curves.set(mint, c); }
      c.lastVSol = vSol; c.lastVTok = vTok;

      for (let j = 0; j < cells.length; j += 1) {
        const cell = cells[j] as { entry: number; stop: number };
        const st = c.s[j] as Slot;
        if (st.phase === 3) continue;

        if (st.phase === 0) {
          /** Watch only from below the entry level, so the climb into it is genuinely observed. */
          if (rSol >= cell.entry - WATCH_BELOW && rSol < cell.entry) st.phase = 1;
          else if (rSol >= cell.entry) st.phase = 3;
          continue;
        }
        if (st.phase === 1) {
          if (rSol < cell.entry) continue;
          if (rSol > cell.entry + MAX_OVERSHOOT) { st.phase = 3; continue; }
          const tok = buyTokens(vSol, vTok, NOTIONAL);
          if (!(tok > 0)) { st.phase = 3; continue; }
          st.tok = tok; st.phase = 2;
          continue;
        }
        /** holding: resolved at the reserves standing when the condition fires. */
        if (rSol <= cell.entry - cell.stop) {
          (outs[j] as number[]).push(1e4 * (sellSol(vSol, vTok, st.tok) / NOTIONAL - 1) - fixedBps);
          cuts[j] = (cuts[j] ?? 0) + 1; st.phase = 3; continue;
        }
        if (rSol >= EXIT) {
          (outs[j] as number[]).push(1e4 * (sellSol(vSol, vTok, st.tok) / NOTIONAL - 1) - fixedBps);
          hits[j] = (hits[j] ?? 0) + 1; st.phase = 3; continue;
        }
      }
    }
  }
  rl.close();
}
for (const c of curves.values()) {
  for (let j = 0; j < cells.length; j += 1) {
    const st = c.s[j] as Slot;
    if (st.phase !== 2) continue;
    (outs[j] as number[]).push(1e4 * (sellSol(c.lastVSol, c.lastVTok, st.tok) / NOTIONAL - 1) - fixedBps);
    st.phase = 3;
  }
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
console.log(`  stake ${NOTIONAL} SOL, ${fixedBps.toFixed(0)} bps fixed cost, overshoot cap ${MAX_OVERSHOOT} SOL`);
console.log('');
console.log('  GROWTH g(f=.05).  Rows are entry level, columns are stop distance in SOL.');
console.log(`  ${'entry'.padEnd(7)}${STOPS.map((s) => `stop-${s}`.padStart(10)).join('')}`);
for (const e of ENTRIES) {
  let row = `  ${String(e).padEnd(7)}`;
  for (const s of STOPS) {
    const j = cells.findIndex((c) => c.entry === e && c.stop === s);
    const o = outs[j] as number[];
    row += (o.length < 40 ? 'n/a' : growth(o, 0.05).toFixed(4)).padStart(10);
  }
  console.log(row);
}
console.log('');
console.log('  MEAN bps, same layout.');
console.log(`  ${'entry'.padEnd(7)}${STOPS.map((s) => `stop-${s}`.padStart(10)).join('')}`);
for (const e of ENTRIES) {
  let row = `  ${String(e).padEnd(7)}`;
  for (const s of STOPS) {
    const j = cells.findIndex((c) => c.entry === e && c.stop === s);
    const o = outs[j] as number[];
    row += (o.length < 40 ? 'n/a' : mean(o).toFixed(0)).padStart(10);
  }
  console.log(row);
}
console.log('');
console.log('  n / target% / stopped%, same layout.');
for (const e of ENTRIES) {
  let row = `  ${String(e).padEnd(7)}`;
  for (const s of STOPS) {
    const j = cells.findIndex((c) => c.entry === e && c.stop === s);
    const o = outs[j] as number[];
    row += (o.length < 40 ? 'n/a' : `${o.length}/${((100 * (hits[j] ?? 0)) / o.length).toFixed(0)}/${((100 * (cuts[j] ?? 0)) / o.length).toFixed(0)}`).padStart(14);
  }
  console.log(row);
}
console.log('');
/**
 * THE TAIL, BECAUSE A MEAN HIDES IT AND A LIVE RUN WILL NOT.
 *
 * A live position stopped out at -90% when its curve collapsed from 69.7 SOL to 1.26 SOL inside a
 * single transaction. A stop that polls every two seconds cannot act on that: by the time it looks,
 * the price is already at the floor. The simulation prices every stop at the reserves standing when
 * the condition fires, so those collapses ARE in the numbers above - but they are invisible in a
 * mean, and anyone reading +812 bps without seeing how often a position loses most of its value will
 * size this wrong.
 */
console.log('');
console.log('  LOSS TAIL for the chosen cell — how often a position loses most of itself.');
{
  const j = cells.findIndex((c) => c.entry === (Number(arg('tail-entry') ?? '55')) && c.stop === (Number(arg('tail-stop') ?? '8')));
  const o = (outs[j] ?? []) as number[];
  if (o.length >= 40) {
    const worse = (t: number): string => `${((100 * o.filter((x) => x <= t).length) / o.length).toFixed(1)}%`;
    console.log(`  n=${o.length}   worse than -25%: ${worse(-2500)}   -50%: ${worse(-5000)}   -75%: ${worse(-7500)}   -90%: ${worse(-9000)}`);
    const srt = [...o].sort((a, b) => a - b);
    console.log(`  worst five: ${srt.slice(0, 5).map((x) => (x / 100).toFixed(0) + '%').join(', ')}`);
    console.log(`  best five:  ${srt.slice(-5).map((x) => '+' + (x / 100).toFixed(0) + '%').join(', ')}`);
  }
}
/**
 * GROWTH AT THE FRACTION ACTUALLY BEING BET, WHICH IS THE NUMBER THAT DECIDES SURVIVAL.
 *
 * Every growth figure above is quoted at f=0.05 - betting five percent of the bankroll per position.
 * That convention is fine for comparing cells and useless for deciding whether to trade, because the
 * strategy has a tail where roughly one position in twenty loses most of itself. Kelly growth is
 * brutally sensitive to over-betting against a tail like that: the same edge that compounds at a
 * fifth of the optimal fraction destroys capital at four times it.
 *
 * A 0.05 SOL position against a 0.068 SOL balance is f = 0.74. This prints the whole curve so the
 * gap between the fraction we are quoting and the fraction we are betting cannot be overlooked.
 */
console.log('');
console.log('  GROWTH vs BET FRACTION for the chosen cell — the number that decides survival.');
{
  const j = cells.findIndex((c) => c.entry === (Number(arg('tail-entry') ?? '55')) && c.stop === (Number(arg('tail-stop') ?? '8')));
  const o = (outs[j] ?? []) as number[];
  if (o.length >= 40) {
    for (const f of [0.02, 0.05, 0.10, 0.20, 0.35, 0.50, 0.74, 1.00]) {
      const g = growth(o, f);
      const label = g === -Infinity ? 'RUIN' : g.toFixed(4);
      console.log(`    f=${f.toFixed(2)}  g=${label.padStart(9)}${f === 0.74 ? '   <- 0.05 SOL on a 0.068 balance' : ''}`);
    }
  }
}
console.log('');
console.log('  Look for a SMOOTH GRADIENT, not the best cell. One bright square in noise is a');
console.log('  coincidence; neighbouring cells agreeing is an effect.');
