/**
 * MT185 — sell on the CURVE instead of into the pool. The live trade says this is where the money is.
 *
 * The first live position bought at 70.15 SOL and sold into the pool five seconds after migration
 * for a true net of +7.4% gross of transaction fees. Decomposing it exposed something the entire
 * backtest programme had missed: the curve itself moved 70.15 -> 85 SOL of reserves, and since
 * pump.fun prices as vSol squared that is (115/100.15)^2 = +31.9%. WE CAPTURED SEVEN OF THIRTY-TWO
 * POINTS. Twenty-four went to the exit - roughly 1% curve buy fee, 2.3% buy impact, 1.25% pool sell
 * fee read off the fee program's own return value, 2.4% pool sell impact, and about 13% of price
 * movement in the 400 milliseconds between quoting and landing.
 *
 * SO THE MIGRATION WAS NOT A PUMP WE CAPTURED, IT WAS A TOLL WE PAID. Every arm this programme has
 * tested since MT168 has assumed the money is in the pool's opening seconds and has spent its effort
 * trying to reach that seat faster. The live fill says the gain was already in hand BEFORE the pool
 * existed, sitting in the curve, and that carrying the position across the migration boundary is
 * what destroyed it.
 *
 * THIS TESTS THE OBVIOUS CONSEQUENCE: buy at a level and sell on the CURVE at a higher level, never
 * migrating at all. That exit pays one 1% curve fee and its own impact, and nothing else. No pool
 * fee, no pool impact, and crucially no exposure to the price during migration.
 *
 * IT IS NOT FREE AND THE COST IS THE SAME ONE MT170 IDENTIFIED. Selling at 84 requires reaching 84,
 * and a curve entered at 70 does not always get there. MT172 measured 67.5% reaching graduation from
 * level 70 at a five-second reaction delay. Curves that stall are marked where they actually ended
 * up, exactly as MT171 and MT174 do, so the failures are priced rather than dropped - which is the
 * whole reason MT170 concluded that selling AT graduation returns roughly zero unconditionally.
 * The question here is narrower and worth asking anyway: given the same entry and the same failures,
 * does the curve exit beat the pool exit by enough to change the sign?
 *
 * The fixed cost is not a guess. It is the 0.000108513 SOL of transaction fees MEASURED on the live
 * round trip, which at a 0.01 SOL position is 109 bps.
 *
 * Reads the bonding-curve tape only; no pool tape is needed, because nothing here migrates.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, ts: 89, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const INITIAL_VIRTUAL_SOL = 30;
const GRAD = 84.0;
const FEE = 0.01;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const NOTIONAL_SOL = Number(arg('notional') ?? '0.01');
/** Measured live on the first real round trip, not assumed. */
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
/** A curve still ungraduated K slots after crossing is one a watcher could actually have seen. */
const K = Number(arg('k') ?? '12');
const EDGE = Number(arg('edge') ?? '5000');
const ENTRY_LEVELS = [60, 65, 70, 75];
const EXIT_LEVELS = [76, 78, 80, 82, 83.5];
/**
 * A STOP, WHICH THIS PROGRAMME HAS NEVER TESTED ON ANYTHING.
 *
 * Every arm from MT168 to MT185 has held to a target or to a clock and has taken whatever the
 * failures cost. The failures are the entire problem: at entry 70 with an exit at 76, 84% of curves
 * reach the exit, and the mean is still -340 bps, which means the 16% that stall lose on the order
 * of 66% each. No improvement to the winning side can outrun that, and the curve exit only halved
 * the loss because it improved the winners.
 *
 * A stop is uniquely available here in a way it is not on an ordinary illiquid token. A bonding
 * curve is ALWAYS quotable - it is a closed-form function of its own reserves, with no order book to
 * empty and no counterparty to find - so an exit at a chosen level can actually be taken. The
 * question is only whether cutting at a small loss beats riding the stall down.
 */
const STOP_LEVELS = (arg('stops') ?? '0,2,4,6').split(',').map(Number);
/**
 * A TRAILING stop, measured from the highest reserve reached rather than from entry.
 *
 * The second live position went 73.04 -> 76.71 and then faded back through its entry. A fixed stop
 * four SOL below ENTRY does nothing about that: it gives back the whole excursion before it acts.
 * A stop that follows the high locks in part of a move that reverses. Whether that is worth having
 * is not obvious - trailing stops also cut winners early on ordinary noise, and this curve is noisy
 * - so it is measured on both corpora rather than adopted because it sounds prudent.
 */
const TRAIL = Number(arg('trail') ?? '0');
const DIR = 'data/sqd/events-6EF8rrec';

interface C { entry: Map<number, { vSol: number; vTok: number }>; cross: Map<number, number>; exit: Map<number, { vSol: number; vTok: number }>; exitSlot: Map<number, number>; minAfter: Map<number, number>; minSlot: Map<number, number>; maxAfter: Map<number, number>; grad: number | null; maxR: number; lastVSol: number; lastVTok: number }
const curves = new Map<string, C>();

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT185 — curve exit vs pool exit, slots ${BC_FROM.toLocaleString()}-${BC_TO.toLocaleString()}, ${files.length} files`);

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
      /** Proves the decode and selects SOL-quoted curves; the rest are a different instrument. */
      if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) continue;
      if (!(vSol > 0) || !(vTok > 0)) continue;
      trades += 1;
      const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
      let c = curves.get(mint);
      if (c === undefined) { c = { entry: new Map(), cross: new Map(), exit: new Map(), exitSlot: new Map(), minAfter: new Map(), minSlot: new Map(), maxAfter: new Map(), grad: null, maxR: 0, lastVSol: vSol, lastVTok: vTok }; curves.set(mint, c); }
      if (rSol > c.maxR) c.maxR = rSol;
      c.lastVSol = vSol; c.lastVTok = vTok;
      for (const L of ENTRY_LEVELS) if (rSol >= L && !c.entry.has(L)) { c.entry.set(L, { vSol, vTok }); c.cross.set(L, slot); }
      for (const X of EXIT_LEVELS) if (rSol >= X && !c.exit.has(X)) { c.exit.set(X, { vSol, vTok }); c.exitSlot.set(X, slot); }
      /** Lowest reserve seen after entering each level, and when — the stop needs both. */
      for (const L of ENTRY_LEVELS) {
        if (!c.cross.has(L)) continue;
        const prev = c.minAfter.get(L);
        if (prev === undefined || rSol < prev) { c.minAfter.set(L, rSol); c.minSlot.set(L, slot); }
        const hi = c.maxAfter.get(L);
        if (hi === undefined || rSol > hi) c.maxAfter.set(L, rSol);
      }
      if (rSol >= GRAD && c.grad === null) c.grad = slot;
    }
  }
  rl.close();
}
console.log(`  ${curves.size.toLocaleString()} mints, ${trades.toLocaleString()} SOL-quoted trades`);

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL_SOL;

console.log('');
console.log(`  stake ${NOTIONAL_SOL} SOL, 1% curve fee each leg, ${fixedBps.toFixed(0)} bps fixed cost measured live`);
console.log(`  observable only: curve still ungraduated ${K} slots after crossing the entry level`);
console.log('');
console.log('  entry  exit      n   reached   median     mean    %pos   g(f=.05)  best50out');
for (const L of ENTRY_LEVELS) {
  for (const X of EXIT_LEVELS) {
    if (X <= L) continue;
   for (const S of STOP_LEVELS) {
    const outs: number[] = [];
    let reached = 0; let stopped = 0;
    for (const c of curves.values()) {
      const en = c.entry.get(L);
      const xs = c.cross.get(L);
      if (en === undefined || xs === undefined || xs > BC_TO - EDGE) continue;
      /** Same observability filter as MT173/MT174: teleports were never takeable. */
      if (c.grad !== null && c.grad <= xs + K) continue;
      const tok = buyTokens(en.vSol, en.vTok, NOTIONAL_SOL);
      if (!(tok > 0)) continue;
      const ex = c.exit.get(X);
      /**
       * WHICHEVER COMES FIRST. A curve that dips to the stop before reaching the target is cut
       * there; only if it never touched the stop does the target or the final state apply. Taking
       * the target whenever it was eventually reached, regardless of what happened in between,
       * would be a look-ahead of exactly the kind that killed MT171.
       */
      /** Fixed stop is measured from entry; trailing is measured from the peak reserve reached. */
      const peak = c.maxAfter.get(L);
      const stopAt = TRAIL > 0 && peak !== undefined ? peak - TRAIL : (S > 0 ? L - S : null);
      const stoppedFirst = stopAt !== null && c.minAfter.get(L) !== undefined && (c.minAfter.get(L) as number) <= stopAt
        && (ex === undefined || (c.minSlot.get(L) as number) < (c.exitSlot.get(X) as number));
      if (stoppedFirst) {
        stopped += 1;
        const sv = stopAt + INITIAL_VIRTUAL_SOL;
        /** Priced on the curve at the stop level using the conserved product. */
        const kk = c.lastVSol * c.lastVTok;
        outs.push(1e4 * (sellSol(sv, kk / sv, tok) / NOTIONAL_SOL - 1) - fixedBps);
      } else if (ex !== undefined) {
        reached += 1;
        outs.push(1e4 * (sellSol(ex.vSol, ex.vTok, tok) / NOTIONAL_SOL - 1) - fixedBps);
      } else {
        /** Never got there: marked where the curve actually ended, exactly as MT171 and MT174 do. */
        outs.push(1e4 * (sellSol(c.lastVSol, c.lastVTok, tok) / NOTIONAL_SOL - 1) - fixedBps);
      }
    }
    if (outs.length < 40) continue;
    const srt = [...outs].sort((a, b) => b - a);
    const fm = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
    console.log(
      `  ${String(L).padStart(5)} ${String(X).padStart(5)} ${String(outs.length).padStart(7)} ${((100 * reached) / outs.length).toFixed(0).padStart(6)}% ` +
      `${q(outs, 0.5).toFixed(0).padStart(9)} ${mean(outs).toFixed(0).padStart(8)} ${((100 * outs.filter((x) => x > 0).length) / outs.length).toFixed(1).padStart(6)}% ` +
      `${fm(growth(outs, 0.05)).padStart(10)} ${fm(growth(srt.slice(50), 0.05)).padStart(10)}  stop-${S} cut ${((100 * stopped) / outs.length).toFixed(0)}%`,
    );
   }
  }
  console.log('');
}
console.log('  Compare against MT174, which is the same entry taken through migration and sold into');
console.log('  the pool: level 70 at +5s read median +1,746, mean -611, growth -0.0034 on this block.');
