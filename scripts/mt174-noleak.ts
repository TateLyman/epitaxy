/**
 * MT174 — MT171 with the look-ahead removed. This is the measurement that decides the strategy.
 *
 * MT171 reported growth near 0.50 on three corpora at an 80 SOL entry selling five seconds after the
 * pool opens. It is an artifact, and the tell was visible in its own output: the 5s, 15s, 30s and 60s
 * cells returned 0.4945, 0.4950, 0.4961 and 0.4948. Four different sell delays cannot produce the
 * same number unless the code is selecting THE SAME EVENT in all four cases.
 *
 * IT WAS. The sell target was chosen as the first pool event whose timestamp is at least N seconds
 * after the pool's first captured event. The pool tape is not continuous - it is eight disjoint
 * 20,000-slot windows - so when a pool has no captured trade in the seconds after it opens, that
 * rule silently walks forward to the next window. MEASURED ACROSS 11,011 POOLS: only 25.8% of
 * "+5 second" sells land within 25 slots of the pool opening. The median gap is 2,217 slots, about
 * fifteen minutes; p90 is 140,342 slots, about fifteen hours; the largest is 2.3 days. Three quarters
 * of the trades were sold into a pool that had since grown, at a price no one could have taken.
 *
 * That is a look-ahead, and it produced exactly the signature that should have condemned it earlier:
 * a mean of +1,245,709 bps and a single position returning 857,742x on a 0.02 SOL stake, which is
 * $3.4 million from four dollars. The entry side was never the problem - every position priced out at
 * a sane 5e4 tokens against vSol 110. The defect is entirely in the sell.
 *
 * SO THIS BINDS THE SELL IN SLOTS RATHER THAN IN TAPE ORDER. The target must fall inside a real
 * window after the pool opens, and the pool's first captured event must itself be the pool's opening,
 * checked against the createdSlot recorded from its CreatePoolEvent. A position that cannot be closed
 * inside that window is DROPPED rather than sold later, because a sell we could not have made is not
 * a conservative estimate - it is a fabricated one.
 *
 * Both conditioning layers from MT173 are kept: curves that graduate in the slot they cross the entry
 * level were never observable and are excluded.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';
import { priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const BC_DIR = 'data/sqd/events-6EF8rrec';
const CACHE = 'data/trade-cache';
const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, ts: 89, vSol: 97, vTok: 105, rSol: 113 };
const NEED = 129;
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'D0,D1,D2,D3,D4,D5,D6,D7').split(',').filter((s) => s.length > 0);
/**
 * THE BONDING-CURVE FILES MUST BE RESTRICTED TO THIS BLOCK. The archive now holds three corpora,
 * and reading all of it while scoring one block would mix a curve from block C with a pool from
 * block D - a mint could appear to graduate in a period whose pool tape we are not looking at.
 * File names carry their slot range, so the filter is exact rather than approximate.
 */
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const NOTIONAL_SOL = Number(arg('notional') ?? '0.02');
/** Reaction delay in slots. A curve still ungraduated K slots after crossing is one we could have seen. */
const K = Number(arg('k') ?? '12');
/** Curves crossing within EDGE slots of the window end may graduate outside the tape. */
const EDGE = Number(arg('edge') ?? '5000');
/** Slots per second on Solana. A 5-second sell is ~12 slots. */
const SLOTS_PER_S = 2.5;
/** How much later than the intended delay a sell may land and still count. 25 slots is ~10s. */
const SELL_TOL = Number(arg('sell-tol') ?? '25');
/** The pool's first captured event must be its opening, within this many slots of createdSlot. */
const OPEN_TOL = Number(arg('open-tol') ?? '25');
let dropLate = 0; let dropNoOpen = 0;
const FEE = 0.01;
const FIXED_LAMPORTS = 46_000;
const LEVELS = [30, 50, 60, 70, 80];
const GRAD = 84.0;
const V_CANDIDATES = [0n, 17_584_500_000n];
/** Seconds after the pool's first trade at which we attempt to sell. */
const SELL_AFTER_S = [0, 5, 15, 30, 60];

const SPLIT_NL = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const poolOfMint = new Map<string, string>();
const poolCreatedSlot = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(SPLIT_NL)) {
  if (line.length === 0) continue;
  try {
    const r = JSON.parse(line) as { pool: string; baseMint: string; quoteMint: string; createdSlot?: number };
    if (r.quoteMint !== 'So11111111111111111111111111111111111111112') continue;
    poolOfMint.set(r.baseMint, r.pool);
    if (r.createdSlot !== undefined) poolCreatedSlot.set(r.pool, r.createdSlot);
  } catch { /* skip */ }
}
console.log(`  mint -> pool links: ${poolOfMint.size.toLocaleString()}`);

/** Per-mint curve state, kept small: entry snapshot at each level, plus outcome. */
interface Curve { entry: Map<number, { vSol: number; vTok: number }>; cross: Map<number, number>; grad: number | null; maxR: number; lastVSol: number; lastVTok: number }
const curves = new Map<string, Curve>();
let trades = 0; let droppedNoTape = 0;
const bcFiles = readdirSync(BC_DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`  bonding-curve files in range: ${bcFiles.length}`);
for (const f of bcFiles) {
  const rl = createInterface({ input: createReadStream(`${BC_DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
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
      trades += 1;
      const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
      const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
      const vTok = Number(b.readBigUInt64LE(OFF.vTok)) / 1e6;
      const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
      if (!(vSol > 0) || !(vTok > 0)) continue;
      let c = curves.get(mint);
      if (c === undefined) { c = { entry: new Map(), cross: new Map(), grad: null, maxR: 0, lastVSol: vSol, lastVTok: vTok }; curves.set(mint, c); }
      if (rSol > c.maxR) c.maxR = rSol;
      c.lastVSol = vSol; c.lastVTok = vTok;
      for (const L of LEVELS) if (rSol >= L && !c.entry.has(L)) { c.entry.set(L, { vSol, vTok }); c.cross.set(L, slot); }
      if (rSol >= GRAD && c.grad === null) c.grad = slot;
    }
  }
  rl.close();
}
console.log(`  curve: ${curves.size.toLocaleString()} mints, ${trades.toLocaleString()} trades`);

/** Pools we may need to sell into: graduated mints that have a pool. */
const wanted = new Set<string>();
for (const [mint, c] of curves) { if (c.maxR >= GRAD) { const p = poolOfMint.get(mint); if (p !== undefined) wanted.add(p); } }
console.log(`  graduated mints with a known pool: ${wanted.size.toLocaleString()}`);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint }
const poolEvs = new Map<string, Ev[]>();
for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const i = line.indexOf('"', 2); if (i < 0) continue;
    if (!wanted.has(line.slice(2, i))) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    const a = poolEvs.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]) });
    poolEvs.set(r[0], a);
  }
  rl.close();
}
console.log(`  graduated mints total: ${[...curves.values()].filter((c) => c.maxR >= GRAD).length.toLocaleString()}`);
console.log(`  pool tape loaded for ${poolEvs.size.toLocaleString()} pools`);

function feeOf(evs: Ev[]): number | null {
  const s: number[] = [];
  for (const e of evs) {
    if (e.qa <= 0n || e.ua <= 0n) continue;
    const f = e.buy ? 1e4 * Number(e.ua - e.qa) / Number(e.qa) : 1e4 * Number(e.qa - e.ua) / Number(e.qa);
    if (Number.isFinite(f) && f >= 0 && f < 2000) s.push(f);
  }
  if (s.length < 5) return null;
  s.sort((a, b) => a - b); return s[Math.floor(0.5 * (s.length - 1))] ?? null;
}
function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v); const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}
const buyTokens = (vSol: number, vTok: number, sol: number): number => {
  const k = vSol * vTok;
  return vTok - k / (vSol + sol * (1 - FEE));
};
const sellSolCurve = (vSol: number, vTok: number, tok: number): number => {
  const k = vSol * vTok;
  return (vSol - k / (vTok + tok)) * (1 - FEE);
};
const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL_SOL;

console.log('');
console.log(`MT174 — observable curves (K=${K} slots), sell bound to +-${SELL_TOL} slots of the intended delay`);
console.log(`  stake ${NOTIONAL_SOL} SOL, 1% curve fee per leg, pool charge from the tape, fixed ${fixedBps.toFixed(0)} bps`);
console.log('');
console.log('  entry   sell@      n    graduated   median      mean    %pos   g(f=.02)  g(f=.05)');
for (const L of LEVELS) {
  for (const SA of SELL_AFTER_S) {
    const outs: number[] = [];
    let grad = 0;
    for (const [mint, c] of curves) {
      const en = c.entry.get(L);
      if (en === undefined) continue;
      /** THE WHOLE POINT: only curves a watcher could have seen sitting in the band. */
      const xs = c.cross.get(L);
      if (xs === undefined || xs > BC_TO - EDGE) continue;
      if (c.grad !== null && c.grad <= xs + K) continue;
      const tok = buyTokens(en.vSol, en.vTok, NOTIONAL_SOL);
      if (!(tok > 0)) continue;
      if (c.maxR < GRAD) {
        /** Never graduated: marked where the curve actually ended up. */
        const back = sellSolCurve(c.lastVSol, c.lastVTok, tok);
        outs.push(1e4 * (back / NOTIONAL_SOL - 1) - fixedBps);
        continue;
      }
      const pool = poolOfMint.get(mint);
      const evs = pool === undefined ? undefined : poolEvs.get(pool);
      if (evs === undefined || evs.length === 0) { droppedNoTape += 1; continue; }
      evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
      const fee = feeOf(evs); const v = resolveV(evs);
      if (fee === null || v === null) continue;
      const first = evs[0] as Ev;
      /** The first captured event must BE the pool opening, or "N seconds after open" is meaningless. */
      const created = pool === undefined ? undefined : poolCreatedSlot.get(pool);
      if (created === undefined || Math.abs(first.slot - created) > OPEN_TOL) { dropNoOpen += 1; continue; }
      /** Our curve tokens are ordinary SPL tokens; they carry across untouched. */
      const held = BigInt(Math.floor(tok * 1e6));
      /** Bound the sell in SLOTS. Tape order is not time, and treating it as time is the whole defect. */
      const want = first.slot + Math.round(SA * SLOTS_PER_S);
      let target: Ev | null = null;
      for (const e of evs) { if (e.slot >= want && e.b > 0n && e.q > 0n) { target = e; break; } }
      if (target === null) { dropLate += 1; continue; }
      if (target.slot > want + SELL_TOL) { dropLate += 1; continue; }
      if (target.b <= held) continue;
      const ladder: PoolFeeLadder = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(fee)) };
      try {
        const sf = priceSell({ base: target.b, quote: target.q, virtualQuote: v }, held, ladder);
        const back = Number(sf.quoteOut) / 1e9;
        outs.push(1e4 * (back / NOTIONAL_SOL - 1) - fixedBps);
        grad += 1;
      } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
    }
    if (outs.length < 30) continue;
    const srt = [...outs].sort((x, y) => y - x);
    const gd10 = growth(srt.slice(10), 0.05);
    const gd50 = growth(srt.slice(50), 0.05);
    const g2 = growth(outs, 0.02); const g5 = growth(outs, 0.05);
    const fm = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
    console.log(
      `  ${(L + ' SOL').padStart(7)} ${(SA + 's').padStart(6)} ${String(outs.length).padStart(6)} ${String(grad).padStart(12)} ${q(outs, 0.5).toFixed(0).padStart(9)} ${mean(outs).toFixed(0).padStart(9)} ${(100 * outs.filter((x) => x > 0).length / outs.length).toFixed(1).padStart(6)}% ${fm(g2).padStart(10)} ${fm(g5).padStart(9)}  d10 ${fm(gd10)}  d50 ${fm(gd50)}  max ${(srt[0] ?? 0).toFixed(0)}`,
    );
  }
  console.log('');
}
console.log(`  dropped, no pool tape: ${droppedNoTape.toLocaleString()}   pool opening not captured: ${dropNoOpen.toLocaleString()}   no sell inside the window: ${dropLate.toLocaleString()}`);
console.log('  Compare every cell against MT171 on the same block with k=0. The gap between them is the');
console.log('  part of MT171 that was never takeable.');
