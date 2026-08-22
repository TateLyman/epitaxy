/**
 * MT131 — is the copy result a LATENCY problem?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT131 before this file existed, including the
 * prediction (mirror-0 negative) and the note that I hold it with LESS confidence than any other
 * prediction recorded today, because the dimension is genuinely untested.
 *
 * MT129 found a monotone dose-response — −5.63%, −8.85%, −17.05%, −24.74% as K goes 1→5 — and I
 * interpreted K as a proxy for LATENESS. If lateness is the mechanism, the answer is to be less
 * late. And every copy test in this programme (MT101, MT104, MT128, MT129, MT130) used a fixed
 * 2-second lag and never once varied it.
 *
 * THE PRIMARY ARM IS PHYSICALLY IMPOSSIBLE, AND THAT IS THE POINT. `mirror-0` enters at the pool
 * state of the winner's OWN buy and exits at the pool state of their OWN final sell — zero lag,
 * zero slippage, no queue position, paying only our fees on our notional. No real system can act
 * at zero latency, so this is a strict upper bound on what ANY copier could achieve.
 *
 * THE FORK IS FROZEN:
 *   mirror-0 NEGATIVE  => copying is impossible in principle, not in practice. A perfect copier
 *   with a time machine still loses; the winners' PnL comes from something their observable
 *   trades do not contain; no colocation or priority fee recovers it.
 *   mirror-0 POSITIVE  => latency IS the mechanism, and the ladder prices each slot of delay.
 *
 * CONTROL: the same mirror on the BOTTOM 500 wallets. If loser-mirror is also positive at zero
 * lag, the arm is measuring fee and reserve mechanics rather than skill.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;
const NOTIONAL = 20_000_000n;
const V_CANDIDATES = [0n, 17_584_500_000n];
const SET_SIZE = 500;
const MIN_ROUND_TRIPS = 4;
/** Entry delay in SLOTS. 0 is the impossible perfect copy; 5 slots is about the 2s every prior test used. */
const LADDER = [-1, 0, 1, 2, 5, 12, 25];

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const FIT = (arg('fit') ?? '9,8,7,6').split(',').filter((s) => s.length > 0);
const VAL = (arg('val') ?? '4,3,2,1').split(',').filter((s) => s.length > 0);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

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

async function load(w: string): Promise<Map<string, Ev[]>> {
  const byPool = new Map<string, Ev[]>();
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) return byPool;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) { console.log(`  w${w} lacks the base field — rebuild it`); process.exit(2); }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1, b: BigInt(r[6]), q: BigInt(r[7]),
             big: qa > ua ? qa : ua, small: qa > ua ? ua : qa, who: r[13], base: BigInt(r[14]) });
    byPool.set(r[0], a);
  }
  rl.close();
  for (const evs of byPool.values()) evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  return byPool;
}

async function rank(windows: string[]): Promise<{ top: Set<string>; bottom: Set<string>; net: number }> {
  const pnl = new Map<string, { p: number; rt: number }>();
  let net = 0;
  for (const w of windows) {
    const byPool = await load(w);
    for (const [, evs] of byPool) {
      if (evs.length < 30) continue;
      const lots = new Map<string, { base: number; cost: number }[]>();
      for (const e of evs) {
        if (e.base <= 0n) continue;
        const q = lots.get(e.who) ?? [];
        if (e.buy) { q.push({ base: Number(e.base), cost: Number(e.big) / LAMPORTS }); lots.set(e.who, q); continue; }
        let rem = Number(e.base); const per = (Number(e.small) / LAMPORTS) / Number(e.base);
        let got = 0; let closed = 0;
        while (rem > 0 && q.length > 0) {
          const lot = q[0];
          if (lot === undefined) break;
          const take = Math.min(rem, lot.base);
          const cost = lot.cost * (take / lot.base);
          got += per * take - cost; rem -= take; lot.base -= take; lot.cost -= cost;
          if (lot.base <= 0) { q.shift(); closed += 1; }
        }
        lots.set(e.who, q);
        if (got !== 0 && Number.isFinite(got)) {
          const cur = pnl.get(e.who) ?? { p: 0, rt: 0 };
          cur.p += got; cur.rt += Math.max(1, closed); pnl.set(e.who, cur); net += got;
        }
      }
    }
    byPool.clear();
  }
  const elig = [...pnl.entries()].filter(([, v]) => v.rt >= MIN_ROUND_TRIPS).sort((a, b) => b[1].p - a[1].p);
  return { top: new Set(elig.slice(0, SET_SIZE).map(([w]) => w)), bottom: new Set(elig.slice(-SET_SIZE).map(([w]) => w)), net };
}

interface Res { rets: number[]; days: Map<string, number[]>; fired: number; skipped: number }
const mk = (): Res => ({ rets: [], days: new Map(), fired: 0, skipped: 0 });

/** Mirror every winner round trip in the holdout, at each delay on the ladder. */
async function mirror(windows: string[], set: Set<string>): Promise<Map<number, Res>> {
  const out = new Map<number, Res>(LADDER.map((d) => [d, mk()]));
  for (const w of windows) {
    const byPool = await load(w);
    for (const [, evs] of byPool) {
      if (evs.length < 30) continue;
      const v = resolveV(evs);
      if (v === null) continue;

      const ch: number[] = [];
      for (const e of evs) {
        if (e.buy || e.big <= 0n || e.small <= 0n) continue;
        const c = 1e4 * Number(e.big - e.small) / Number(e.big);
        if (Number.isFinite(c) && c > 0 && c < 1000) ch.push(c);
      }
      if (ch.length < 5) continue;
      ch.sort((a, b) => a - b);
      const charged = ch[Math.floor(0.5 * (ch.length - 1))] ?? NaN;
      if (!Number.isFinite(charged)) continue;
      const fees: PoolFeeLadder = {
        lpFeeBasisPoints: 20n, protocolFeeBasisPoints: 5n, coinCreatorFeeBasisPoints: 0n,
        chargedFeeBasisPoints: BigInt(Math.round(charged)),
      };

      // First buy and final sell per member of the set, inside this pool and window.
      const firstBuy = new Map<string, number>();
      const lastSell = new Map<string, number>();
      for (let i = 0; i < evs.length; i += 1) {
        const e = evs[i];
        if (e === undefined || e.base <= 0n || !set.has(e.who)) continue;
        if (e.buy) { if (!firstBuy.has(e.who)) firstBuy.set(e.who, i); }
        else if (firstBuy.has(e.who)) lastSell.set(e.who, i);
      }

      /**
       * MIRROR-FULL, delay -1 in the ladder. The first version of this arm copied only the FIRST
       * buy and the LAST sell, which is not what these wallets do: they make 50-83 trades and
       * SCALE IN on dips, so their average basis is far better than their first fill. Copying one
       * entry at the top of an accumulation and calling it a perfect copy tested a strawman.
       *
       * This replicates their WHOLE schedule proportionally — every buy and every sell they make,
       * in order, scaled so our total deployed equals one notional. Our size is ~1.3% of theirs so
       * our own footprint is negligible, which means this is as close to riding their exact book
       * as arithmetic allows. If THIS is negative, the schedule is not the missing piece either.
       */
      {
        const theirs: Ev[] = [];
        for (const e of evs) if (e.base > 0n && set.has(e.who)) theirs.push(e);
        const byWho = new Map<string, Ev[]>();
        for (const e of theirs) { const a = byWho.get(e.who) ?? []; a.push(e); byWho.set(e.who, a); }
        for (const [, seq] of byWho) {
          let totalBuySol = 0;
          for (const e of seq) if (e.buy) totalBuySol += Number(e.big) / LAMPORTS;
          if (!(totalBuySol > 0)) continue;
          const scale = (Number(NOTIONAL) / LAMPORTS) / totalBuySol;
          let held = 0n; let spent = 0n; let got = 0n; let ok = true;
          for (const e of seq) {
            if (e.b <= 0n || e.q <= 0n) { ok = false; break; }
            if (e.buy) {
              const size = BigInt(Math.floor(Number(e.big) * scale));
              if (size <= 0n) continue;
              try {
                const f = priceBuy({ base: e.b, quote: e.q, virtualQuote: v }, size, fees);
                held += f.baseOut; spent += size;
              } catch { ok = false; break; }
            } else {
              const size = BigInt(Math.floor(Number(e.base) * scale));
              const sell = size > held ? held : size;
              if (sell <= 0n) continue;
              try {
                const f = priceSell({ base: e.b, quote: e.q, virtualQuote: v }, sell, fees);
                held -= sell; got += f.quoteOut;
              } catch { ok = false; break; }
            }
          }
          if (!ok || spent <= 0n) continue;
          // Anything still held is marked at the final observed pool state, exactly as their own
          // FIFO PnL would leave it — unsold inventory is not counted as profit.
          const r = Number(got - spent) / Number(spent);
          if (!Number.isFinite(r)) continue;
          const res = out.get(-1);
          if (res === undefined) continue;
          res.fired += 1; res.rets.push(r);
          const d0 = evs[0];
          if (d0 !== undefined) {
            const day = new Date(d0.ts * 1000).toISOString().slice(0, 10);
            const dd = res.days.get(day) ?? []; dd.push(r); res.days.set(day, dd);
          }
        }
      }

      for (const [who, bi] of firstBuy) {
        const si = lastSell.get(who);
        if (si === undefined || si <= bi) continue;                 // no completed round trip in-window
        const exit = evs[si];
        if (exit === undefined || exit.b <= 0n || exit.q <= 0n) continue;

        for (const d of LADDER) {
          const res = out.get(d);
          if (res === undefined) continue;
          res.fired += 1;
          // Entry at the winner's own fill for d=0; otherwise the first event at least d slots later.
          let ei = bi;
          if (d > 0) {
            const target = (evs[bi]?.slot ?? 0) + d;
            ei = -1;
            for (let j = bi + 1; j < evs.length; j += 1) { const x = evs[j]; if (x !== undefined && x.slot >= target) { ei = j; break; } }
            if (ei < 0 || ei >= si) { res.skipped += 1; continue; }  // delay pushed us past their exit
          }
          const entry = evs[ei];
          if (entry === undefined || entry.b <= 0n || entry.q <= 0n) { res.skipped += 1; continue; }

          let bought;
          try { bought = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees); }
          catch (x) { if (x instanceof FillNotPriceable) { res.skipped += 1; continue; } throw x; }
          const added = bought.reservesAfter.quote - entry.q;
          try {
            const s = priceSell({ base: exit.b - bought.baseOut, quote: exit.q + added, virtualQuote: v }, bought.baseOut, fees);
            const r = Number(s.quoteOut - NOTIONAL) / Number(NOTIONAL);
            if (!Number.isFinite(r)) { res.skipped += 1; continue; }
            res.rets.push(r);
            const day = new Date(entry.ts * 1000).toISOString().slice(0, 10);
            const dd = res.days.get(day) ?? []; dd.push(r); res.days.set(day, dd);
          } catch { res.skipped += 1; }
        }
      }
    }
    byPool.clear();
    console.log(`    mirrored w${w}`);
  }
  return out;
}

const wmean = (a: number[], p = 0.10): number => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (s.length < 20) return NaN;
  const k = Math.floor(p * (s.length - 1));
  const lo = s[k] ?? 0; const hi = s[s.length - 1 - k] ?? 0;
  return s.map((x) => (x < lo ? lo : x > hi ? hi : x)).reduce((x, y) => x + y, 0) / s.length;
};
const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

function dayBoot(byDay: Map<string, number[]>, iters = 2000): [number, number] {
  const days = [...byDay.keys()];
  if (days.length < 3) return [NaN, NaN];
  let seed = 20260821;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const draws: number[] = [];
  for (let it = 0; it < iters; it += 1) {
    const pool: number[] = [];
    for (let d = 0; d < days.length; d += 1) {
      const pick = days[Math.floor(rnd() * days.length)];
      if (pick === undefined) continue;
      const rows = byDay.get(pick);
      if (rows !== undefined) pool.push(...rows);
    }
    const s = wmean(pool);
    if (Number.isFinite(s)) draws.push(s);
  }
  if (draws.length < 100) return [NaN, NaN];
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * (draws.length - 1))] ?? NaN, draws[Math.floor(0.975 * (draws.length - 1))] ?? NaN];
}

console.log('MT131 — mirror the winners exactly, then add latency one slot at a time');
console.log('  prediction recorded before running: mirror-0 NEGATIVE (held with low confidence)');
console.log(`  fit ${FIT.join(',')}   holdout ${VAL.join(',')}   cost model UNCLAMPED`);
console.log('');
const { top, bottom, net } = await rank(FIT);
console.log(`  ranking net realised PnL ${net.toFixed(1)} SOL`);
if (net > 0) { console.log('  *** POSITIVE. Impossible. Ranking broken; nothing measured. ***'); process.exit(2); }
console.log(`  winner set ${top.size}   loser set ${bottom.size} (control)`);
console.log('');

console.log('MIRRORING WINNERS');
const winRes = await mirror(VAL, top);
console.log('MIRRORING LOSERS (control)');
const loseRes = await mirror(VAL, bottom);

console.log('');
console.log('THE LATENCY LADDER — entry delay in SLOTS, exit always at the winner\'s own exit');
console.log('  delay          n   median   WINSOR-10%     95% day-clustered CI      losers(control)');
for (const d of LADDER) {
  const r = winRes.get(d); const l = loseRes.get(d);
  if (r === undefined) continue;
  const [lo, hi] = dayBoot(r.days);
  const label = d === -1 ? 'FULL SCHEDULE' : d === 0 ? '0 first/last' : `${d} slot${d === 1 ? '' : 's'}${d === 5 ? ' ~2s' : d === 12 ? ' ~5s' : d === 25 ? ' ~10s' : ''}`;
  console.log(
    `  ${label.padEnd(13)} ${String(r.rets.length).padStart(6)}  ${F(med(r.rets))}  ${F(wmean(r.rets))}   [${F(lo)}, ${F(hi)}]   ` +
    `${F(wmean(l?.rets ?? []))}${r.rets.length < 100 ? '  UNDERPOWERED' : ''}`,
  );
}

const m0 = winRes.get(-1); const l0 = loseRes.get(-1);
const [lo0] = dayBoot(m0?.days ?? new Map());
console.log('');
console.log('THE FROZEN FORK');
if (m0 !== undefined && Number.isFinite(lo0) && lo0 > 0) {
  console.log('  MIRROR-FULL is POSITIVE on its day-clustered lower bound.');
  console.log(`  loser-mirror control at zero lag: ${F(wmean(l0?.rets ?? []))}%`);
  console.log('  => LATENCY IS THE MECHANISM. Read the ladder for what each slot of delay costs.');
  console.log('  DO NOT REPORT THIS YET: MT131 froze a fee re-probe against the chain first.');
} else {
  console.log('  MIRROR-FULL is NOT positive — and this arm replicates their ENTIRE trade schedule.');
  console.log('  => COPYING IS IMPOSSIBLE IN PRINCIPLE, NOT IN PRACTICE. A perfect copier entering');
  console.log('     at the winner\'s own fill and exiting at the winner\'s own exit, with zero lag');
  console.log('     and zero slippage, still loses. The winners\' PnL comes from something their');
  console.log('     observable trades do not contain. No colocation, priority fee or infrastructure');
  console.log('     recovers it, because the deficit exists at ZERO latency.');
}
