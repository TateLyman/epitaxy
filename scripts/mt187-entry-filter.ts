/**
 * MT187 — is anything visible AT ENTRY able to tell a winner from a stop-out?
 *
 * MT186 settled the exit and landed at breakeven: sell on the curve at 82 SOL with a stop four SOL
 * below entry, and once the position is large enough that the flat transaction cost stops dominating,
 * the mean sits a hair either side of zero. Every gain in this programme has come from removing a
 * cost. Nothing has ever come from choosing a better trade.
 *
 * SO THIS ASKS THE ONLY QUESTION LEFT THAT COULD MOVE THE SIGN. Two curves are both sitting at 70 SOL.
 * One goes on to reach 82; the other falls four SOL and stops us out. Is there anything observable at
 * that instant which separates them? If not, the strategy is finished at breakeven no matter how the
 * exit is tuned, because the exit is already near optimal and the entry is a coin flip. If there is,
 * it is worth more than every exit refinement combined - moving the target-hit rate from 33% to 40%
 * is worth hundreds of basis points on the mean.
 *
 * THE FEATURES ARE THE TWO A LIVE BOT ALREADY HAS FOR FREE, since it sees every trade on the curve:
 *
 *   CLIMB TIME, the slots taken to get from 60 SOL to the entry level. A curve dragged to 70 over an
 *   hour by a few buyers is a different object from one that got there in twenty seconds.
 *
 *   FLOW, the number of trades over that same stretch. Climb time and trade count can disagree - a
 *   curve can rise fast on three enormous buys or slowly on four hundred small ones - and which of
 *   those is the better sign is exactly the sort of thing that has to be measured rather than assumed.
 *
 * TWO DISCIPLINES ARE ENFORCED BECAUSE BOTH HAVE ALREADY GONE WRONG HERE ONCE.
 *
 *   NOTHING FROM AFTER THE DECISION. Every feature uses only events already past when the position
 *   would open. MT185 set a trailing stop from the peak a curve would EVENTUALLY reach and produced
 *   a spectacular result that evaporated the moment it was simulated forward.
 *
 *   NO CURVE COUNTS UNLESS WE WATCHED IT CLIMB. If the tape first shows a curve when it is already
 *   above the entry level, its climb time is not zero - it is unknown, and recording it as zero would
 *   populate the fastest bucket with curves we simply arrived late to. Those are dropped, not scored.
 *
 * Reads the bonding-curve tape only. Signs nothing, sends nothing, spends nothing.
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
const WATCH_FROM = Number(arg('watch-from') ?? '60');
const ENTRY = Number(arg('entry') ?? '70');
const EXIT = Number(arg('exit') ?? '82');
const STOP_BELOW = Number(arg('stop-below') ?? '4');
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;
const STOP_AT = ENTRY - STOP_BELOW;

/**
 * `phase` is the whole state machine. A curve is watched from the moment it is first seen at or above
 * the watch level, entered when it crosses the entry level on a LATER event, and resolved exactly once.
 */
type Phase = 'pre' | 'watching' | 'holding' | 'done';
interface C {
  phase: Phase;
  watchSlot: number;
  watchTrades: number;
  trades: number;
  tok: number;
  climb: number;
  flow: number;
  out: number;
  how: 'target' | 'stop' | 'drift';
  lastVSol: number;
  lastVTok: number;
}
const curves = new Map<string, C>();

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT187 — can entry be filtered? ${files.length} tape files`);

let events = 0;
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
      events += 1;

      const mint = b.subarray(OFF.mint, OFF.mint + 32).toString('base64');
      let c = curves.get(mint);
      if (c === undefined) {
        c = { phase: 'pre', watchSlot: 0, watchTrades: 0, trades: 0, tok: 0, climb: 0, flow: 0, out: 0, how: 'drift', lastVSol: vSol, lastVTok: vTok };
        curves.set(mint, c);
      }
      c.trades += 1;
      c.lastVSol = vSol; c.lastVTok = vTok;
      if (c.phase === 'done') continue;

      if (c.phase === 'pre') {
        /** Start watching only BELOW the entry level, so a real climb can be observed. */
        if (rSol >= WATCH_FROM && rSol < ENTRY) {
          c.phase = 'watching'; c.watchSlot = slot; c.watchTrades = c.trades;
        } else if (rSol >= ENTRY) {
          /** Arrived already above entry: climb time is unknown, not zero. Never traded. */
          c.phase = 'done';
        }
        continue;
      }

      if (c.phase === 'watching') {
        if (rSol < WATCH_FROM) continue;
        if (rSol < ENTRY) continue;
        const tok = buyTokens(vSol, vTok, NOTIONAL);
        if (!(tok > 0)) { c.phase = 'done'; continue; }
        c.tok = tok;
        c.climb = slot - c.watchSlot;
        c.flow = c.trades - c.watchTrades;
        c.phase = 'holding';
        continue;
      }

      /** holding: resolve at the reserves standing when the condition fires, never later. */
      if (rSol <= STOP_AT) {
        c.out = 1e4 * (sellSol(vSol, vTok, c.tok) / NOTIONAL - 1) - fixedBps;
        c.how = 'stop'; c.phase = 'done'; continue;
      }
      if (rSol >= EXIT) {
        c.out = 1e4 * (sellSol(vSol, vTok, c.tok) / NOTIONAL - 1) - fixedBps;
        c.how = 'target'; c.phase = 'done'; continue;
      }
    }
  }
  rl.close();
}
/** Positions still open when the tape ends are marked where their curve actually finished. */
const rows: C[] = [];
for (const c of curves.values()) {
  if (c.phase === 'holding') {
    c.out = 1e4 * (sellSol(c.lastVSol, c.lastVTok, c.tok) / NOTIONAL - 1) - fixedBps;
    c.how = 'drift'; c.phase = 'done';
  }
  if (c.tok > 0) rows.push(c);
}
console.log(`  ${events.toLocaleString()} SOL-quoted events, ${curves.size.toLocaleString()} mints`);
console.log(`  ${rows.length.toLocaleString()} positions where the climb ${WATCH_FROM}->${ENTRY} SOL was actually observed`);
console.log('');

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

function band(title: string, key: (c: C) => number, unit: string): void {
  const sorted = [...rows].sort((a, b) => key(a) - key(b));
  console.log(`  ${title}`);
  console.log('  quintile   range           n   target%   stop%   drift%    median     mean   g(f=.05)');
  for (let k = 0; k < 5; k += 1) {
    const g = sorted.slice(Math.floor((k * sorted.length) / 5), Math.floor(((k + 1) * sorted.length) / 5));
    if (g.length < 20) continue;
    const o = g.map((c) => c.out);
    const lab = `${key(g[0] as C)}-${key(g[g.length - 1] as C)}${unit}`;
    console.log(
      `  ${String(k + 1).padStart(5)}      ${lab.padEnd(13)} ${String(g.length).padStart(5)} ` +
      `${((100 * g.filter((c) => c.how === 'target').length) / g.length).toFixed(0).padStart(7)}% ` +
      `${((100 * g.filter((c) => c.how === 'stop').length) / g.length).toFixed(0).padStart(6)}% ` +
      `${((100 * g.filter((c) => c.how === 'drift').length) / g.length).toFixed(0).padStart(7)}% ` +
      `${med(o).toFixed(0).padStart(9)} ${mean(o).toFixed(0).padStart(8)} ${growth(o, 0.05).toFixed(4).padStart(10)}`,
    );
  }
  console.log('');
}

console.log(`  stake ${NOTIONAL} SOL, entry ${ENTRY}, target ${EXIT}, stop ${STOP_AT}, ${fixedBps.toFixed(0)} bps fixed cost`);
console.log('');
band(`CLIMB TIME from ${WATCH_FROM} to ${ENTRY} SOL — fastest first`, (c) => c.climb, ' slots');
band(`FLOW: trades over that same climb — fewest first`, (c) => c.flow, '');
const all = rows.map((c) => c.out);
console.log(`  ALL: n=${rows.length}  target ${((100 * rows.filter((c) => c.how === 'target').length) / rows.length).toFixed(0)}%  median ${med(all).toFixed(0)}  mean ${mean(all).toFixed(0)}  g ${growth(all, 0.05).toFixed(4)}`);
console.log('');
console.log('  A monotone target% down a column is a usable filter. A flat one means the entry carries');
console.log('  no information and the strategy is finished at breakeven however the exit is tuned.');
