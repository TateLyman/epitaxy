/**
 * MT172 — how long does a curve sit above a level before it graduates?
 *
 * MT171 measured what a curve holder earns by buying at a level and selling after migration, and it
 * replicated on three corpora. It assumes something it never measured: THAT THE BUY GETS FILLED.
 *
 * That assumption is not free, and at the level MT171 liked best it is the whole question. An 80 SOL
 * entry is 94% of the way to a 85 SOL graduation - five SOL of headroom on a curve that is being
 * actively bought. If the median curve crosses 80 and graduates two seconds later, then by the time
 * a quote is fetched, a transaction is built, signed, and landed, the curve is complete, the buy
 * instruction fails against a completed curve, and the fee is spent for nothing. A strategy whose
 * fill probability is low is not a strategy with a lower return; it is a strategy that pays to lose.
 *
 * So this measures the thing the backtest skipped: for every mint that crosses a level, the WALL
 * CLOCK TIME from the first trade at or above that level to graduation, and the share that never
 * graduate at all. Those two numbers together decide whether MT171 is executable and at which level.
 * A level is only usable if its time-to-graduation is comfortably longer than the round trip, and
 * its non-graduation rate is low enough that the failures do not eat the winners.
 *
 * THE TWO FAILURE MODES ARE OPPOSITE AND BOTH MATTER. Enter too low and the curve may never
 * graduate, which MT170 priced. Enter too high and the curve graduates before the buy lands, which
 * nothing has priced. This reports both against the same mints so the tradeoff is visible rather
 * than argued.
 *
 * Reads the bonding-curve tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
/** Offsets into the TradeEvent payload, byte 0 being its discriminator. */
const OFF = { mint: 8, ts: 89, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const GRAD = 84.0;
const INITIAL_VIRTUAL_SOL = 30;
const LEVELS = [60, 70, 75, 80, 82];

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const DIR = 'data/sqd/events-6EF8rrec';

/** Per mint: when it first crossed each level, when it graduated, and how far it ever got. */
type M = { cross: Map<number, number>; grad: number | null; maxR: number };
const mints = new Map<string, M>();

const files = readdirSync(DIR)
  .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
  .map((f) => { const m = /events-(\d+)-(\d+)\.jsonl/.exec(f); return m === null ? null : { f, lo: Number(m[1]), hi: Number(m[2]) }; })
  .filter((x): x is { f: string; lo: number; hi: number } => x !== null)
  .filter((x) => x.hi >= BC_FROM && x.lo <= BC_TO)
  .sort((a, b) => a.lo - b.lo);

console.log(`MT172 — fill window, slots ${BC_FROM.toLocaleString()} to ${BC_TO.toLocaleString()}`);
console.log(`  ${files.length} tape files`);

let events = 0;
let nonSol = 0;
for (const { f } of files) {
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
      const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
      /** Proves the decode and selects SOL-quoted curves; the others are a different product. */
      if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) { nonSol++; continue; }
      events++;

      const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
      let m = mints.get(mint);
      if (m === undefined) { m = { cross: new Map(), grad: null, maxR: 0 }; mints.set(mint, m); }
      if (rSol > m.maxR) m.maxR = rSol;
      for (const L of LEVELS) if (rSol >= L && !m.cross.has(L)) m.cross.set(L, slot);
      if (rSol >= GRAD && m.grad === null) m.grad = slot;
    }
  }
  rl.close();
}

console.log(`  ${events.toLocaleString()} SOL-quoted trade events over ${mints.size.toLocaleString()} mints`);
console.log(`  ${nonSol.toLocaleString()} dropped as non-SOL-quoted`);
console.log('');

const pct = (a: number[], p: number): number => a.length === 0 ? NaN : a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? NaN;

/**
 * THE UNCONDITIONAL WAIT IS THE WRONG QUESTION and reporting it alone would be misleading. A curve
 * that crosses 60 SOL and graduates in the SAME SLOT was never an opportunity: there is no instant
 * at which it is visible sitting in the band, so no strategy could have taken it. Those teleports
 * dominate the median and drag it to zero.
 *
 * The decision we actually face is different, and it is CONDITIONAL ON HAVING SEEN THE CURVE. K slots
 * after it crossed the level, we are looking at a curve that has NOT yet graduated - that is what
 * being observable means. Selecting on it costs nothing and requires no foresight, because surviving
 * K slots is a fact already in evidence at the moment we would act.
 *
 * So this reports, for each level and each reaction delay K: how many curves were still ungraduated
 * K slots after crossing, what share of those eventually graduated, and how much longer they took.
 * That is the population a live watcher actually presents.
 *
 * Curves crossing within EDGE slots of the window end are dropped, because their graduation may fall
 * outside the tape and would be miscounted as a failure to graduate.
 */
const EDGE = 5_000;
const DELAYS = [0, 5, 12, 25, 50];
console.log('  Conditional on still being ungraduated K slots after crossing — the observable population.');
console.log('');
console.log('  level     K    observable   graduate    rate    further wait, slots (x0.4 = s)');
console.log('                                                     p25      p50      p75');
for (const L of LEVELS) {
  for (const K of DELAYS) {
    const obs = [...mints.values()].filter((m) => {
      const c = m.cross.get(L);
      if (c === undefined || c > BC_TO - EDGE) return false;
      return m.grad === null || m.grad > c + K;
    });
    const grads = obs.filter((m) => m.grad !== null);
    const waits = grads.map((m) => (m.grad ?? 0) - (m.cross.get(L) ?? 0) - K).sort((a, b) => a - b);
    const rate = obs.length === 0 ? NaN : (100 * grads.length) / obs.length;
    console.log(
      `  ${String(L).padStart(5)} ${String(K).padStart(5)}   ${String(obs.length).padStart(10)}   ${String(grads.length).padStart(8)}  ${rate.toFixed(1).padStart(5)}%  ` +
      [0.25, 0.5, 0.75].map((q) => { const v = pct(waits, q); return `${v.toFixed(0).padStart(6)} (${(v * 0.4).toFixed(0)}s)`; }).join(' '),
    );
  }
  console.log('');
}
console.log('  K=0 is the unconditional population and includes same-slot teleports that were never');
console.log('  takeable. K>0 is what a live watcher can actually see and act on.');
