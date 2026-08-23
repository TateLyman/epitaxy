/**
 * MT169 — the snipers mark the winners. Can we follow them in at position 1, 2 or 3?
 *
 * MT168 closed the slot-0 seat: it medians +23,810 bps where another participant is already in the
 * create slot and MINUS 935 where the seat is free, so the seats worth having are exactly the ones
 * already taken. That looked like a dead end, and the way it was measured hid something.
 *
 * THE QUEUE-POSITION TABLE POOLED BOTH COHORTS. Position 2 came out at +28 bps median across all
 * migrations - but that mixes contested pools, which run, with uncontested ones, which do not. If
 * the presence of a sniper in slot 0 predicts the pump, then position 2 ON A CONTESTED POOL is a
 * different bet from position 2 in general, and it has never been priced.
 *
 * AND THE CONDITION IS OBSERVABLE IN REAL TIME. We cannot know in advance which migration will be
 * contested, but we do not need to: the slot-0 trades are visible the moment they land. A rule that
 * says "if someone bought in the create slot, buy next" needs no forecast at all - only the ability
 * to react within a slot or two, which MT168 showed is NOT the binding constraint, because the
 * graduation pump persists for at least eight slots.
 *
 * THIS IS FOLLOWING, NOT PREDICTING, AND THE PROGRAMME HAS BEEN BURNED BY FOLLOWING BEFORE. MT128
 * followed winners by identity and lost 8.7%. MT129 waited for consensus and got worse with every
 * confirmation. MT131 mirrored a proven winner's entire schedule at zero latency and lost 18.2%.
 * The difference here is that the thing being followed is not a wallet's judgement but a
 * MECHANICAL fact about a specific pool at a specific moment, and MT168 already measured that the
 * fact is worth +23,810 bps to the person who has it.
 *
 * The cut is reported at every position so a decay curve is visible rather than a single cell, and
 * the uncontested arm is carried alongside as the control it is.
 *
 * Read-only on the rebuilt caches. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '').split(',').filter((s) => s.length > 0);
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const FIXED_NONAMM_LAMPORTS = 46_000;
const NONAMM_BPS = 1e4 * FIXED_NONAMM_LAMPORTS / Number(NOTIONAL);
const HOLD_S = Number(arg('hold') ?? '30');
const BARRIER = Number(arg('barrier') ?? '3000');
/** Slots that must pass after our entry before we may sell. */
const EXIT_LAG_SLOTS = Number(arg('exit-lag') ?? '2');
const V_CANDIDATES = [0n, 17_584_500_000n];
const POSITIONS = [1, 2, 3, 4, 6, 8];

const SPLIT_NL = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const born = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(SPLIT_NL)) {
  if (line.length === 0) continue;
  try {
    const r = JSON.parse(line) as { pool: string; createdSlot: number; quoteMint: string };
    if (r.quoteMint !== 'So11111111111111111111111111111111111111112') continue;
    born.set(r.pool, r.createdSlot);
  } catch { /* skip */ }
}

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; qa: bigint; ua: bigint }

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

const cells = new Map<string, { v: number; day: number }[]>();
for (const p of POSITIONS) { cells.set(`C|${p}`, []); cells.set(`U|${p}`, []); }
let pools = 0; let contestedPools = 0; let refused = 0; let quiet = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const byPool = new Map<string, Ev[]>();
  let chunkMin = Infinity; let chunkMax = -Infinity;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, ...unknown[]];
    try { r = JSON.parse(line); } catch { continue; }
    if (r[1] < chunkMin) chunkMin = r[1];
    if (r[1] > chunkMax) chunkMax = r[1];
    if (!born.has(r[0])) continue;
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
             b: BigInt(r[6]), q: BigInt(r[7]), qa: BigInt(r[8]), ua: BigInt(r[9]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [pool, raw] of byPool) {
    const b0 = born.get(pool);
    if (b0 === undefined || b0 < chunkMin || b0 > chunkMax) continue;
    const evs = raw.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const first = evs[0];
    if (first === undefined || first.b <= 0n || first.q <= 0n) continue;
    const fee = feeOf(evs); const v = resolveV(evs);
    if (fee === null || v === null) continue;
    pools += 1;
    /** CONTESTED means somebody traded in the pool's create slot. Observable the moment it happens. */
    const contested = first.slot === b0;
    if (contested) contestedPools += 1;
    const arm = contested ? 'C' : 'U';
    const ladder: PoolFeeLadder = { lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(fee)) };

    for (const pos of POSITIONS) {
      const at = evs[pos];
      if (at === undefined || at.b <= 0n || at.q <= 0n) continue;
      let bf;
      try { bf = priceBuy({ base: at.b, quote: at.q, virtualQuote: v }, NOTIONAL, ladder); } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; continue; }
      const kEntry = Number(at.b) * Number(at.q + v);
      let booked: number | null = null; let last = NaN;
      for (const e of evs) {
        if (e.slot < at.slot + EXIT_LAG_SLOTS || e.b <= 0n || e.q <= 0n) continue;
        if (e.ts > at.ts + HOLD_S) break;
        if (e.b <= bf.baseOut) { refused += 1; continue; }
        /** MT106: liquidity events move reserves for non-trade reasons, so a fall in k is refused. */
        if (!(Number(e.b) * Number(e.q + v) >= kEntry * 0.99)) { refused += 1; continue; }
        try {
          const sf = priceSell({ base: e.b - bf.baseOut, quote: e.q + (bf.reservesAfter.quote - at.q), virtualQuote: v }, bf.baseOut, ladder);
          const bps = 1e4 * Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL) - NONAMM_BPS;
          last = bps;
          if (bps >= BARRIER || bps <= -BARRIER) { booked = bps; break; }
        } catch (e2) { if (!(e2 instanceof FillNotPriceable)) throw e2; }
      }
      /**
       * A POOL THAT GOES QUIET IS NOT A POOL WE ESCAPE. If no trade follows our entry inside the
       * hold, there is no mark - and DROPPING those silently removes exactly the migrations nobody
       * wanted, which is an upward bias of the same family as the venue_pools survivorship filter.
       * We would still be holding the position; with no price movement it is worth what we paid
       * less the round trip, so it is booked at that rather than discarded.
       */
      const flat = -(2 * fee) - NONAMM_BPS;
      const val = booked !== null ? booked : (Number.isFinite(last) ? last : flat);
      if (booked === null && !Number.isFinite(last)) quiet += 1;
      if (Number.isFinite(val)) cells.get(`${arm}|${pos}`)?.push({ v: val, day: Math.floor(at.ts / 86400) });
    }
  }
  byPool.clear();
}

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
void mean;
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const qt = (x: number[], p: number): number => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

/**
 * DAY-CLUSTERED BOOTSTRAP ON THE GROWTH RATE ITSELF, not on the mean. Eighteen of eighteen cells
 * coming out positive is suggestive, but every one has a negative median and lives in its right
 * tail — the exact shape MT127-RESULT, MT154 and MT157 were each closed on. A point estimate of a
 * tail-driven quantity is not evidence; an interval is.
 */
function bootG(items: { v: number; day: number }[], f: number): [number, number, number] {
  const byDay = new Map<number, number[]>();
  for (const it of items) { const arr = byDay.get(it.day) ?? []; arr.push(it.v); byDay.set(it.day, arr); }
  const days = [...byDay.values()];
  if (days.length < 2) return [NaN, NaN, days.length];
  let seed = 20260822;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gs: number[] = [];
  for (let r = 0; r < 1000; r += 1) {
    const pick: number[] = [];
    for (let i = 0; i < days.length; i += 1) { const d = days[Math.floor(rnd() * days.length)]; if (d) pick.push(...d); }
    if (pick.length) { const g = growth(pick, f); if (Number.isFinite(g)) gs.push(g); }
  }
  if (gs.length === 0) return [NaN, NaN, days.length];
  gs.sort((x, y) => x - y);
  return [gs[Math.floor(0.025 * gs.length)] ?? NaN, gs[Math.floor(0.975 * gs.length)] ?? NaN, days.length];
}
console.log(`MT169 — following the snipers in. ${pools.toLocaleString()} migrations, ${contestedPools.toLocaleString()} contested (${(100 * contestedPools / Math.max(1, pools)).toFixed(1)}%)`);
console.log(`  stake ${(Number(NOTIONAL) / 1e9).toFixed(4)} SOL, non-AMM ${NONAMM_BPS.toFixed(0)} bps, exit >= ${EXIT_LAG_SLOTS} slots later, barrier +/-${BARRIER}, cap ${HOLD_S}s`);
console.log(`  quiet pools booked flat (no trade inside the hold): 0 placeholder ${refused.toLocaleString()}, quiet pools booked flat: ${quiet.toLocaleString()}`);
console.log('');
console.log('  arm          pos      n     median      p25      p75    %pos  g(f=.05)  [95% day-clustered CI]  cl');
for (const arm of ['C', 'U']) {
  for (const pos of POSITIONS) {
    const rowsC = cells.get(`${arm}|${pos}`) ?? [];
    const a = rowsC.map((z) => z.v);
    if (a.length < 30) continue;
    const label = arm === 'C' ? 'CONTESTED' : 'uncontested';
    const g5 = growth(a, 0.05);
    const ci = bootG(rowsC, 0.05);
    const srt = [...a].sort((x, y) => y - x);
    const g5d10 = growth(srt.slice(10), 0.05);
    const g5d30 = growth(srt.slice(30), 0.05);
    const f = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
    console.log(
      `  ${label.padEnd(12)} ${String(pos).padStart(3)} ${String(a.length).padStart(6)} ${med(a).toFixed(0).padStart(10)} ${qt(a, 0.25).toFixed(0).padStart(8)} ${qt(a, 0.75).toFixed(0).padStart(8)} ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(1).padStart(6)}% ${f(g5).padStart(9)}  [${ci[0].toFixed(4)}, ${ci[1].toFixed(4)}] ${String(ci[2]).padStart(3)}cl  drop10 ${g5d10.toFixed(4)}  drop30 ${g5d30.toFixed(4)}`,
    );
  }
  console.log('');
}
console.log('  The contested arm is a REACTION, not a forecast: the slot-0 trades are visible the moment');
console.log('  they land, and MT168 showed the pump persists at least eight slots. If the contested arm');
console.log('  pays at position 2 or 3, the seat we can actually reach is worth something after all.');
